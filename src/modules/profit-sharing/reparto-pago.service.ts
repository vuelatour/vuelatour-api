import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { esColumnaInexistente } from '../../common/columna-opcional.util';
import { Rol } from '../../common/types/auth.types';
import {
  LIMITE_COMPROBANTE_BYTES,
  validarComprobanteCobro,
} from '../flights/comprobante-cobro.util';
import { esTablaInexistente } from '../inventory/eliminar-movimiento.util';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  ActualizarPagoSocioDto,
  CrearPagoSocioDto,
  PagosQuery,
} from './dto/reparto-pago.dto';
import { SIN_MIGRACION } from './reparto-cuenta.lector';
import {
  RepartoCuentaService,
  errorCuentaNoDisponible,
  type ActorCuenta,
  type ContextoSocio,
} from './reparto-cuenta.service';
import {
  MENSAJE_RANGO_FECHAS_INVALIDO,
  MENSAJE_SOCIO_SOLO_SU_CUENTA,
  excedeSaldo,
  excedeSaldoEnOrdenDeCaptura,
  mensajeExcedeSaldo,
  type FilaCuentaSocio,
  type UtilidadMesSocios,
} from './reparto-cuenta.util';
import {
  BUCKET_REPARTO_COMPROBANTES,
  COLS_REPARTO_PAGO,
  MENSAJE_CLIENT_REQUEST_ID_EN_USO_PAGO,
  MENSAJE_COMPROBANTE_PAGO_CAMBIO,
  MENSAJE_ENTREGADO_POR_INVALIDO,
  MENSAJE_MES_FUTURO,
  MENSAJE_MES_INVALIDO,
  MENSAJE_MOTIVO_BAJA_PAGO,
  MENSAJE_PAGO_CAMBIO_CONCURRENTE,
  MENSAJE_PAGO_NO_EXISTE,
  MENSAJE_PAGO_SIN_CAMBIOS,
  MENSAJE_PAGOS_POR_MES_RETIRADO,
  MENSAJE_SOCIO_INVALIDO,
  MENSAJE_SOCIO_NO_ES_DE_LA_AERONAVE,
  MOTIVO_BAJA_CARRERA_ALTA,
  MOTIVO_BAJA_PAGO_MAX,
  MOTIVO_BAJA_PAGO_MIN,
  TABLA_REPARTO_PAGO,
  compararCaptura,
  esFechaDia,
  esMes,
  pathComprobantePago,
  periodoDeMes,
  textoOpcional,
  validarDineroPago,
  validarFechaPago,
  type PagoSocio,
  type RepartoPagoRow,
} from './reparto-pago.util';

/** Quién pide (de `@CurrentUser`). */
export type ActorPagos = ActorCuenta;

/** Respuesta de `GET /v1/profit-sharing/pagos`. */
export interface ListaPagos {
  disponible: boolean;
  /** Más reciente primero (fecha_pago, luego captura). */
  pagos: PagoSocio[];
}

/** Respuesta de alta / edición: la entrega + el renglón del socio ya recalculado. */
export interface RespuestaPago {
  pago: PagoSocio;
  cuenta: FilaCuentaSocio;
  idempotente?: true;
}

/** Archivo multipart ya leído por el controller. */
export interface ArchivoComprobantePago {
  buffer: Buffer;
  nombre: string | null;
  mime: string | null;
}

/**
 * Detalles del 409 `PAGO_EXCEDE_SALDO`. `por_entregar_usd` = lo por
 * entregar de MESES CERRADOS (sin el mes en curso: contra eso se decide el
 * adelanto); `mes_en_curso_usd` (ADITIVO) = lo que lleva el mes abierto, que
 * NO cuenta. `exceso_usd`/`saldo_despues_usd` se miden contra lo cerrado.
 */
interface DetalleExceso {
  por_entregar_usd: number;
  mes_en_curso_usd: number;
  monto_usd: number;
  exceso_usd: number;
  saldo_despues_usd: number;
}

function pagoNoExiste(id: string): NotFoundException {
  return new NotFoundException({
    message: MENSAJE_PAGO_NO_EXISTE,
    error: 'PAGO_NO_EXISTE',
    details: { pago_id: id },
  });
}

function bad(code: string, message: string, details?: unknown) {
  return new BadRequestException({ message, error: code, details });
}

const sinMigracion = (e: { code?: string | null; message?: string | null }) =>
  esColumnaInexistente(e) || esTablaInexistente(e);

/**
 * ENTREGAS A LA CUENTA CORRIENTE DEL SOCIO (v2, 2-oct-2026, invariante 38).
 * El saldo del socio (lo por entregar) lo arma `RepartoCuentaService` con
 * la fuente única `reparto-cuenta.util`; aquí solo se registran, corrigen y
 * dan de baja entregas y su comprobante. Una entrega que rebasa lo por
 * entregar de MESES CERRADOS (`por_entregar_cerrado_usd`: el mes en curso
 * no cuenta) es un ADELANTO legítimo: se CONFIRMA (409 `PAGO_EXCEDE_SALDO` ⇒
 * `aceptar_exceso` con la MISMA llave), no se prohíbe. Toda escritura sella
 * `updated_by` (la bitácora `reparto_bitacora` lo toma como actor). Sin la migración
 * 20261002000001: lecturas `disponible:false`, escrituras 503
 * `CUENTA_SOCIO_NO_DISPONIBLE`.
 */
@Injectable()
export class RepartoPagoService {
  private readonly logger = new Logger(RepartoPagoService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly cuentas: RepartoCuentaService,
  ) {}

  private get sb() {
    return this.supabase.service;
  }

  private get lector() {
    return this.cuentas.lector;
  }

  // =================================================================
  // Lectura
  // =================================================================

  /**
   * `GET /v1/profit-sharing/pagos?desde&hasta&socio_id` (fechas de
   * entrega). SOCIO: solo las suyas (403 si pide otro socio). `?mes=` o
   * `?aeronave_id=` (el listado por mes/avión de la v1) ⇒ 410
   * `PAGOS_POR_MES_RETIRADO`.
   */
  async listar(q: PagosQuery, actor: ActorPagos): Promise<ListaPagos> {
    if (q.mes !== undefined || q.aeronave_id !== undefined) {
      throw new GoneException({
        message: MENSAJE_PAGOS_POR_MES_RETIRADO,
        error: 'PAGOS_POR_MES_RETIRADO',
      });
    }
    for (const f of [q.desde, q.hasta]) {
      if (f !== undefined && !esFechaDia(f)) {
        throw bad('RANGO_INVALIDO', MENSAJE_RANGO_FECHAS_INVALIDO);
      }
    }
    if (q.desde && q.hasta && q.desde > q.hasta) {
      throw bad('RANGO_INVALIDO', MENSAJE_RANGO_FECHAS_INVALIDO);
    }
    let socioId = q.socio_id;
    if (actor.rol === Rol.SOCIO) {
      if (socioId && socioId !== actor.userId) {
        throw new ForbiddenException({
          message: MENSAJE_SOCIO_SOLO_SU_CUENTA,
          error: 'SOCIO_SOLO_SU_CUENTA',
        });
      }
      socioId = actor.userId;
    }
    if (!(await this.lector.disponible())) {
      return { disponible: false, pagos: [] };
    }
    const rows = await this.lector.entregasVivas({
      socio_id: socioId,
      desde: q.desde,
      hasta: q.hasta,
    });
    if (rows === SIN_MIGRACION) return { disponible: false, pagos: [] };
    const pagos = await this.enriquecer(rows);
    pagos.sort(
      (a, b) =>
        b.fecha_pago.localeCompare(a.fecha_pago) || compararCaptura(b, a),
    );
    return { disponible: true, pagos };
  }

  /** Nombres, matrícula y URL firmada (8 h), en lote. */
  private async enriquecer(
    rows: ReadonlyArray<RepartoPagoRow>,
  ): Promise<PagoSocio[]> {
    if (rows.length === 0) return [];
    const [usuarios, aeronaves] = await Promise.all([
      this.lector.usuarios(
        rows.flatMap((r) => [r.entregado_por, r.created_by, r.updated_by]),
      ),
      this.lector.aeronaves(),
    ]);
    return this.cuentas.entregasDe(rows, { usuarios, aeronaves }, true);
  }

  // =================================================================
  // Helpers de escritura
  // =================================================================

  /** Entrega VIVA o 404; migración ausente ⇒ 503. */
  private async pagoVivo(id: string): Promise<RepartoPagoRow> {
    const { data, error } = await this.sb
      .from(TABLA_REPARTO_PAGO)
      .select(COLS_REPARTO_PAGO)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) {
      if (sinMigracion(error)) {
        this.lector.marcarAusente();
        throw errorCuentaNoDisponible();
      }
      throw new Error(error.message);
    }
    if (!data) throw pagoNoExiste(id);
    return data;
  }

  /** Entrega (viva o borrada) con esa llave de idempotencia, o null. */
  private async pagoPorLlave(key: string): Promise<RepartoPagoRow | null> {
    const { data, error } = await this.sb
      .from(TABLA_REPARTO_PAGO)
      .select(COLS_REPARTO_PAGO)
      .eq('client_request_id', key)
      .maybeSingle();
    if (error) {
      if (sinMigracion(error)) {
        this.lector.marcarAusente();
        throw errorCuentaNoDisponible();
      }
      throw new Error(error.message);
    }
    return data ?? null;
  }

  /** `entregado_por_id` debe ser un usuario ACTIVO (400 si no). */
  private async assertUsuarioActivo(id: string): Promise<void> {
    const u = (await this.lector.usuarios([id])).get(id);
    if (!u || String(u.estado) !== 'ACTIVO') {
      throw bad('ENTREGADO_POR_INVALIDO', MENSAJE_ENTREGADO_POR_INVALIDO, {
        entregado_por_id: id,
      });
    }
  }

  /** «Corresponde a» mes: AAAA-MM y no posterior al mes en curso. */
  private assertMes(mes: string): void {
    if (!esMes(mes)) throw bad('MES_INVALIDO', MENSAJE_MES_INVALIDO);
    if (mes > this.cuentas.mesActual()) {
      throw bad('MES_FUTURO', MENSAJE_MES_FUTURO, { mes });
    }
  }

  /**
   * Contexto del socio para escribir. En el ALTA (`exigirSocio`) debe estar
   * en `aeronave_socio` (400 `SOCIO_INVALIDO`); en la corrección no (la
   * entrega ya existe aunque el socio haya salido del avión). Si se pide un
   * avión («corresponde a»), debe serlo de ESE avión (400
   * `SOCIO_NO_ES_DE_LA_AERONAVE`). Las validaciones van ANTES de calcular
   * las utilidades (el universo se lee primero).
   */
  private async contexto(
    socioId: string,
    v: { exigirSocio: boolean; aeronaveId?: string | null },
  ): Promise<ContextoSocio> {
    const ctx = await this.cuentas.contextoSocio(socioId, {
      // El candado del adelanto decide con utilidades al día (sin la memoria
      // de 10 min de las lecturas).
      fresco: true,
      validar: (base, aeronaves) => {
        if (v.exigirSocio && !base.en_aeronave_socio) {
          throw bad('SOCIO_INVALIDO', MENSAJE_SOCIO_INVALIDO, {
            socio_id: socioId,
          });
        }
        if (v.aeronaveId && !aeronaves.has(v.aeronaveId)) {
          throw bad(
            'SOCIO_NO_ES_DE_LA_AERONAVE',
            MENSAJE_SOCIO_NO_ES_DE_LA_AERONAVE,
            { socio_id: socioId, aeronave_id: v.aeronaveId },
          );
        }
      },
    });
    if (!ctx) {
      throw bad('SOCIO_INVALIDO', MENSAJE_SOCIO_INVALIDO, {
        socio_id: socioId,
      });
    }
    return ctx;
  }

  /**
   * La cuenta YA recalculada tras escribir (relee entregas; reutiliza las
   * utilidades de la misma petición: el mes en curso no se recalcula).
   */
  private async despues(
    socioId: string,
    utilidades: ReadonlyArray<UtilidadMesSocios>,
  ): Promise<ContextoSocio> {
    const ctx = await this.cuentas.contextoSocio(socioId, {
      utilidadesPrevias: utilidades,
    });
    if (!ctx) {
      throw bad('SOCIO_INVALIDO', MENSAJE_SOCIO_INVALIDO, {
        socio_id: socioId,
      });
    }
    return ctx;
  }

  private excede(d: DetalleExceso): ConflictException {
    return new ConflictException({
      message: mensajeExcedeSaldo(d),
      error: 'PAGO_EXCEDE_SALDO',
      details: d,
    });
  }

  /** Error de BD de un insert/update ⇒ excepción legible (nunca 500 por dato). */
  private errorDeEscritura(error: {
    code?: string | null;
    message?: string | null;
  }): Error {
    if (sinMigracion(error)) {
      this.lector.marcarAusente();
      return errorCuentaNoDisponible();
    }
    if (error.code === '23514') {
      return bad(
        'PAGO_INVALIDO',
        'Algún dato de la entrega no es válido (monto, moneda, T.C., método, mes o largo de un texto).',
        { tecnico: error.message },
      );
    }
    if (error.code === '22003') {
      // numeric fuera de rango: el DTO y la banda del T.C. ya lo atajan;
      // esto es el cinturón.
      return bad(
        'PAGO_INVALIDO',
        'Algún número de la entrega es demasiado grande para guardarse (monto o tipo de cambio): revisa la captura.',
        { tecnico: error.message },
      );
    }
    if (error.code === '23503') {
      return bad(
        'PAGO_REFERENCIA_INVALIDA',
        'El socio, el avión o quien entregó ya no existe.',
        { tecnico: error.message },
      );
    }
    return new Error(error.message ?? 'Error al guardar la entrega');
  }

  /** La entrega recién escrita, desde el contexto ya releído (con URL). */
  private async pagoDe(ctx: ContextoSocio, id: string): Promise<PagoSocio> {
    const p = ctx.pagos.find((x) => x.id === id);
    if (!p) throw pagoNoExiste(id);
    if (!p.comprobante_path) return p;
    const urls = await this.lector.firmarComprobantes([p.comprobante_path]);
    return { ...p, comprobante_url: urls.get(p.comprobante_path) ?? null };
  }

  // =================================================================
  // Escritura
  // =================================================================

  /**
   * `POST /v1/profit-sharing/pagos`. Idempotencia PRIMERO (el reintento de
   * un alta que sí quedó no debe rebotar en ningún candado); luego forma,
   * quién entregó, socio (y avión), saldo y adelanto.
   */
  async crear(
    dto: CrearPagoSocioDto,
    actor: ActorPagos,
  ): Promise<RespuestaPago> {
    await this.cuentas.assertDisponible();
    if (dto.client_request_id) {
      const ya = await this.pagoPorLlave(dto.client_request_id);
      if (ya) return this.respuestaIdempotente(ya, dto);
    }
    const dinero = validarDineroPago(dto);
    if (!dinero.ok) throw bad(dinero.codigo, dinero.mensaje);
    const fecha = validarFechaPago(dto.fecha_pago, this.cuentas.hoy());
    if (!fecha.ok) throw bad(fecha.codigo, fecha.mensaje);
    const mes = dto.mes ?? null;
    if (mes != null) this.assertMes(mes);
    const entregadoPor = dto.entregado_por_id ?? actor.userId;
    if (dto.entregado_por_id) {
      await this.assertUsuarioActivo(dto.entregado_por_id);
    }

    const ctx = await this.contexto(dto.socio_id, {
      exigirSocio: true,
      aeronaveId: dto.aeronave_id,
    });
    // Meses CERRADOS: el mes en curso todavía se mueve (ver invariante 38).
    const porEntregar = ctx.fila.por_entregar_cerrado_usd;
    const enCurso = ctx.fila.mes_en_curso_usd;
    const ex = excedeSaldo({
      por_entregar_usd: porEntregar,
      monto_usd: dinero.monto_usd,
    });
    if (ex.excede && dto.aceptar_exceso !== true) {
      // Doble envío con la MISMA llave: la 1.ª pudo insertar entre la
      // búsqueda de la llave (arriba) y la lectura del saldo, que ya la
      // cuenta como entregada. Es un replay, no un adelanto.
      const replay = await this.replaySiYaQuedo(dto);
      if (replay) return replay;
      throw this.excede({
        por_entregar_usd: porEntregar,
        mes_en_curso_usd: enCurso,
        monto_usd: dinero.monto_usd,
        exceso_usd: ex.exceso_usd,
        saldo_despues_usd: ex.saldo_despues_usd,
      });
    }

    const { data, error } = await this.sb
      .from(TABLA_REPARTO_PAGO)
      .insert({
        socio_id: dto.socio_id,
        aeronave_id: dto.aeronave_id ?? null,
        periodo: mes ? periodoDeMes(mes) : null,
        monto: dinero.monto,
        moneda: dinero.moneda,
        tc_usd_mxn: dinero.tc_usd_mxn,
        monto_usd: dinero.monto_usd,
        utilidad_snapshot_usd: null,
        saldo_snapshot_usd: porEntregar,
        fecha_pago: fecha.fecha,
        metodo: dto.metodo,
        referencia: textoOpcional(dto.referencia),
        entregado_por: entregadoPor,
        recibido_por: textoOpcional(dto.recibido_por),
        factura_folio: textoOpcional(dto.factura_folio),
        notas: textoOpcional(dto.notas),
        client_request_id: dto.client_request_id ?? null,
        created_by: actor.userId,
      })
      .select(COLS_REPARTO_PAGO)
      .single();
    if (error) {
      // Carrera de la MISMA llave (doble clic / reintento): replay.
      if (error.code === '23505' && dto.client_request_id) {
        const ya = await this.pagoPorLlave(dto.client_request_id);
        if (ya) return this.respuestaIdempotente(ya, dto);
      }
      throw this.errorDeEscritura(error);
    }
    const row: RepartoPagoRow = data;
    if (dto.aceptar_exceso !== true) {
      // Saldo inicial + generado en meses cerrados (todo menos entregas).
      const disponible =
        Math.round((porEntregar + ctx.fila.entregado_usd) * 100) / 100;
      const perdio = await this.perdioCarreraDeAlta(
        row,
        disponible,
        enCurso,
        actor,
      );
      if (perdio) throw this.excede(perdio);
    }
    this.logger.log(
      `Entrega a socio ${row.id}: socio ${row.socio_id}, ${row.monto} ${row.moneda} (${row.monto_usd} USD), por entregar antes ${porEntregar} USD (meses cerrados; mes en curso ${enCurso} USD), por ${actor.userId}${ex.excede ? ' — ADELANTO (aceptado)' : ''}`,
    );
    const despues = await this.despues(dto.socio_id, ctx.utilidades);
    return { pago: await this.pagoDe(despues, row.id), cuenta: despues.fila };
  }

  /**
   * Antes de responder el 409 del saldo: si la llave del alta YA existe, la
   * primera petición ganó la carrera ⇒ replay (200 idempotente).
   */
  private async replaySiYaQuedo(
    dto: CrearPagoSocioDto,
  ): Promise<RespuestaPago | null> {
    if (!dto.client_request_id) return null;
    const ya = await this.pagoPorLlave(dto.client_request_id);
    return ya ? this.respuestaIdempotente(ya, dto) : null;
  }

  /**
   * CARRERA DE ALTAS: el candado del saldo es «leer y luego insertar»; dos
   * entregas al mismo socio pueden pasarlo a la vez y juntas rebasar lo por
   * entregar sin que nadie confirmara el adelanto. Ya insertada ESTA fila,
   * se releen las entregas vivas del socio y se decide con el orden de
   * CAPTURA (determinista para las dos peticiones): si ESTA es la que sobra,
   * se da de baja (`MOTIVO_BAJA_CARRERA_ALTA`) y se LIBERA su llave para que
   * el operador confirme el adelanto con la MISMA llave + `aceptar_exceso`.
   * Best-effort: si la relectura o la baja fallan, la fila SE QUEDA (201) y
   * el pre-cierre la avisa como adelanto (`socios_adelantados`).
   */
  private async perdioCarreraDeAlta(
    row: RepartoPagoRow,
    disponibleUsd: number,
    mesEnCursoUsd: number,
    actor: ActorPagos,
  ): Promise<DetalleExceso | null> {
    let r: ReturnType<typeof excedeSaldoEnOrdenDeCaptura>;
    try {
      const vivos = await this.lector.entregasVivas({ socio_id: row.socio_id });
      if (vivos === SIN_MIGRACION) return null;
      r = excedeSaldoEnOrdenDeCaptura({
        disponible_usd: disponibleUsd,
        vivos,
        nuevo: row,
      });
    } catch (e) {
      this.logger.warn(
        `Entrega a socio ${row.id}: no se pudo revisar la carrera de altas (se conserva): ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
    if (!r.excede) return null;
    const { data, error } = await this.sb
      .from(TABLA_REPARTO_PAGO)
      .update({
        deleted_at: this.cuentas.ahora().toISOString(),
        deleted_by: actor.userId,
        motivo_baja: MOTIVO_BAJA_CARRERA_ALTA,
        client_request_id: null,
        updated_by: actor.userId,
      })
      .eq('id', row.id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (error || !data) {
      this.logger.error(
        `Entrega a socio ${row.id}: perdió la carrera de altas (rebasa lo por entregar por ${r.exceso_usd} USD) y NO se pudo dar de baja: ${error?.message ?? 'la fila ya no estaba viva'}. Queda registrada; el pre-cierre la avisa como adelanto.`,
      );
      return null;
    }
    this.logger.warn(
      `Entrega a socio ${row.id} dada de baja por carrera de altas: ${row.monto_usd} USD sobre ${r.por_entregar_antes_usd} USD por entregar (socio ${row.socio_id}).`,
    );
    const monto = Number(row.monto_usd);
    return {
      por_entregar_usd: r.por_entregar_antes_usd,
      mes_en_curso_usd: mesEnCursoUsd,
      monto_usd: monto,
      exceso_usd: r.exceso_usd,
      saldo_despues_usd:
        Math.round((r.por_entregar_antes_usd - monto) * 100) / 100,
    };
  }

  /** Replay de la llave: solo si es LA MISMA entrega (mismo socio y viva). */
  private async respuestaIdempotente(
    ya: RepartoPagoRow,
    dto: CrearPagoSocioDto,
  ): Promise<RespuestaPago> {
    if (ya.socio_id !== dto.socio_id || ya.deleted_at != null) {
      throw new ConflictException({
        message: MENSAJE_CLIENT_REQUEST_ID_EN_USO_PAGO,
        error: 'CLIENT_REQUEST_ID_EN_USO',
        details: { client_request_id: dto.client_request_id },
      });
    }
    const ctx = await this.cuentas.contextoSocio(ya.socio_id);
    if (!ctx) throw pagoNoExiste(ya.id);
    return {
      pago: await this.pagoDe(ctx, ya.id),
      cuenta: ctx.fila,
      idempotente: true,
    };
  }

  /**
   * `PATCH /v1/profit-sharing/pagos/:id`. Re-valida el DINERO sobre el
   * estado FUSIONADO; si el monto en dólares SUBE se vuelve a revisar el
   * saldo de MESES CERRADOS (sin contar ESTA entrega) ⇒ 409
   * `PAGO_EXCEDE_SALDO` salvo `aceptar_exceso` (bajar nunca empeora nada).
   * Corregir el dinero renueva `saldo_snapshot_usd`. «Corresponde a»
   * (avión/mes) se puede corregir. CAS por `updated_at`; sella `updated_by`
   * (el valor anterior queda en `reparto_bitacora`, por trigger).
   */
  async actualizar(
    id: string,
    dto: ActualizarPagoSocioDto,
    actor: ActorPagos,
  ): Promise<RespuestaPago> {
    await this.cuentas.assertDisponible();
    const campos = (
      [
        'monto',
        'moneda',
        'tc_usd_mxn',
        'fecha_pago',
        'metodo',
        'referencia',
        'entregado_por_id',
        'recibido_por',
        'factura_folio',
        'notas',
        'aeronave_id',
        'mes',
      ] as const
    ).filter((k) => dto[k] !== undefined);
    if (campos.length === 0) {
      throw bad('PAGO_SIN_CAMBIOS', MENSAJE_PAGO_SIN_CAMBIOS);
    }
    const actual = await this.pagoVivo(id);

    const moneda = dto.moneda ?? actual.moneda;
    let tc: unknown;
    if (dto.tc_usd_mxn !== undefined) tc = dto.tc_usd_mxn;
    else if (dto.moneda !== undefined && dto.moneda !== actual.moneda) {
      // Pasar a USD limpia el T.C.; pasar a MXN lo exige (TC_REQUERIDO).
      tc = null;
    } else tc = actual.tc_usd_mxn;
    const dinero = validarDineroPago({
      monto: dto.monto ?? actual.monto,
      moneda,
      tc_usd_mxn: tc,
    });
    if (!dinero.ok) throw bad(dinero.codigo, dinero.mensaje);
    if (dto.fecha_pago !== undefined) {
      const f = validarFechaPago(dto.fecha_pago, this.cuentas.hoy());
      if (!f.ok) throw bad(f.codigo, f.mensaje);
    }
    if (dto.mes != null) this.assertMes(dto.mes);
    if (dto.entregado_por_id !== undefined) {
      await this.assertUsuarioActivo(dto.entregado_por_id);
    }

    const tcActual =
      actual.tc_usd_mxn == null ? null : Number(actual.tc_usd_mxn);
    const montoUsdActual = Number(actual.monto_usd);
    const cambiaDinero =
      dinero.monto !== Number(actual.monto) ||
      dinero.moneda !== actual.moneda ||
      dinero.tc_usd_mxn !== tcActual ||
      Math.round(dinero.monto_usd * 100) !== Math.round(montoUsdActual * 100);
    const sube =
      Math.round(dinero.monto_usd * 100) > Math.round(montoUsdActual * 100);

    const ctx = await this.contexto(actual.socio_id, {
      exigirSocio: false,
      aeronaveId: dto.aeronave_id,
    });
    // Lo por entregar de meses cerrados SIN esta entrega (la cuenta ya la
    // descontó).
    const sinEsta =
      Math.round((ctx.fila.por_entregar_cerrado_usd + montoUsdActual) * 100) /
      100;
    if (sube && dto.aceptar_exceso !== true) {
      const ex = excedeSaldo({
        por_entregar_usd: sinEsta,
        monto_usd: dinero.monto_usd,
      });
      if (ex.excede) {
        throw this.excede({
          por_entregar_usd: sinEsta,
          mes_en_curso_usd: ctx.fila.mes_en_curso_usd,
          monto_usd: dinero.monto_usd,
          exceso_usd: ex.exceso_usd,
          saldo_despues_usd: ex.saldo_despues_usd,
        });
      }
    }

    const patch: Record<string, unknown> = {};
    if (cambiaDinero) {
      patch.monto = dinero.monto;
      patch.moneda = dinero.moneda;
      patch.tc_usd_mxn = dinero.tc_usd_mxn;
      patch.monto_usd = dinero.monto_usd;
      patch.saldo_snapshot_usd = sinEsta;
    }
    const comparar = (col: keyof RepartoPagoRow, nuevo: unknown) => {
      if (nuevo !== (actual[col] ?? null)) patch[col] = nuevo;
    };
    if (dto.fecha_pago !== undefined) comparar('fecha_pago', dto.fecha_pago);
    if (dto.metodo !== undefined) comparar('metodo', dto.metodo);
    if (dto.entregado_por_id !== undefined) {
      comparar('entregado_por', dto.entregado_por_id);
    }
    if (dto.referencia !== undefined) {
      comparar('referencia', textoOpcional(dto.referencia));
    }
    if (dto.recibido_por !== undefined) {
      comparar('recibido_por', textoOpcional(dto.recibido_por));
    }
    if (dto.factura_folio !== undefined) {
      comparar('factura_folio', textoOpcional(dto.factura_folio));
    }
    if (dto.notas !== undefined) comparar('notas', textoOpcional(dto.notas));
    if (dto.aeronave_id !== undefined) {
      comparar('aeronave_id', dto.aeronave_id ?? null);
    }
    if (dto.mes !== undefined) {
      comparar('periodo', dto.mes ? periodoDeMes(dto.mes) : null);
    }

    if (Object.keys(patch).length > 0) {
      const { data, error } = await this.sb
        .from(TABLA_REPARTO_PAGO)
        // Quién corrigió (actor de la bitácora; el antes/después lo guarda
        // el trigger `trg_reparto_pago_bitacora`).
        .update({ ...patch, updated_by: actor.userId })
        .eq('id', id)
        .is('deleted_at', null)
        // CAS: el parche se calculó sobre ESTA versión.
        .eq('updated_at', actual.updated_at)
        .select(COLS_REPARTO_PAGO)
        .maybeSingle();
      if (error) throw this.errorDeEscritura(error);
      if (!data) {
        await this.pagoVivo(id); // 404 si la borraron
        throw new ConflictException({
          message: MENSAJE_PAGO_CAMBIO_CONCURRENTE,
          error: 'PAGO_CAMBIO_CONCURRENTE',
          details: { pago_id: id },
        });
      }
      this.logger.log(
        `Entrega a socio ${id} corregida por ${actor.userId}: ${Object.keys(patch).join(', ')}`,
      );
    }
    const despues = await this.despues(actual.socio_id, ctx.utilidades);
    return { pago: await this.pagoDe(despues, id), cuenta: despues.fila };
  }

  /**
   * `DELETE /v1/profit-sharing/pagos/:id` — SOFT delete con motivo (5–300).
   * El panel CONFIRMA antes (regla del cliente). Borrada ⇒ 404.
   */
  async eliminar(
    id: string,
    motivo: string,
    actor: ActorPagos,
  ): Promise<{ deleted: true; cuenta: FilaCuentaSocio }> {
    await this.cuentas.assertDisponible();
    const m = String(motivo ?? '').trim();
    if (m.length < MOTIVO_BAJA_PAGO_MIN || m.length > MOTIVO_BAJA_PAGO_MAX) {
      throw bad('MOTIVO_INVALIDO', MENSAJE_MOTIVO_BAJA_PAGO);
    }
    const actual = await this.pagoVivo(id);
    const { data, error } = await this.sb
      .from(TABLA_REPARTO_PAGO)
      .update({
        deleted_at: this.cuentas.ahora().toISOString(),
        deleted_by: actor.userId,
        motivo_baja: m,
        updated_by: actor.userId,
      })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw this.errorDeEscritura(error);
    if (!data) throw pagoNoExiste(id);
    this.logger.log(
      `Entrega a socio ${id} (${actual.monto} ${actual.moneda}) eliminada por ${actor.userId}: ${m}`,
    );
    const ctx = await this.cuentas.contextoSocio(actual.socio_id);
    if (!ctx) throw pagoNoExiste(id);
    return { deleted: true, cuenta: ctx.fila };
  }

  /**
   * `POST /v1/profit-sharing/pagos/:id/comprobante`: foto o PDF ≤ 10 MB.
   * Sube a `reparto-comprobantes/<socio>/<entrega>/<uuid>.<ext>` y guarda el
   * path con CAS sobre el anterior; el ANTERIOR se conserva en el bucket.
   * Si guardar falla, el archivo recién subido se retira.
   */
  async subirComprobante(
    id: string,
    archivo: ArchivoComprobantePago,
    actor: ActorPagos,
  ): Promise<{ pago: PagoSocio }> {
    await this.cuentas.assertDisponible();
    const v = validarComprobanteCobro({
      nombre: archivo.nombre,
      mime: archivo.mime,
      bytes: archivo.buffer.length,
    });
    if (!v.ok) {
      const cuerpo = { message: v.mensaje, error: v.codigo };
      if (v.codigo === 'ARCHIVO_MUY_GRANDE') {
        throw new PayloadTooLargeException({
          ...cuerpo,
          details: {
            bytes: archivo.buffer.length,
            limite_bytes: LIMITE_COMPROBANTE_BYTES,
          },
        });
      }
      throw new BadRequestException(cuerpo);
    }
    const actual = await this.pagoVivo(id);
    const anterior = actual.comprobante_path ?? null;
    const path = pathComprobantePago(
      actual.socio_id,
      id,
      randomUUID(),
      v.extension,
    );
    const bucket = this.sb.storage.from(BUCKET_REPARTO_COMPROBANTES);
    const { error: upErr } = await bucket.upload(path, archivo.buffer, {
      contentType: v.contentType,
      upsert: false,
    });
    if (upErr) {
      throw new Error(`No se pudo guardar el comprobante: ${upErr.message}`);
    }
    const retirarNuevo = async () => {
      const { error } = await this.sb.storage
        .from(BUCKET_REPARTO_COMPROBANTES)
        .remove([path]);
      if (error) {
        this.logger.warn(
          `Comprobante huérfano ${path} (no se pudo retirar): ${error.message}`,
        );
      }
    };
    let upd = this.sb
      .from(TABLA_REPARTO_PAGO)
      .update({ comprobante_path: path, updated_by: actor.userId })
      .eq('id', id)
      .is('deleted_at', null);
    upd = anterior
      ? upd.eq('comprobante_path', anterior)
      : upd.is('comprobante_path', null);
    const { data, error } = await upd.select(COLS_REPARTO_PAGO).maybeSingle();
    if (error) {
      await retirarNuevo();
      throw this.errorDeEscritura(error);
    }
    if (!data) {
      await retirarNuevo();
      await this.pagoVivo(id); // 404 si la borraron
      throw new ConflictException({
        message: MENSAJE_COMPROBANTE_PAGO_CAMBIO,
        error: 'COMPROBANTE_CAMBIO',
        details: { pago_id: id },
      });
    }
    this.logger.log(
      `Comprobante de la entrega a socio ${id} por ${actor.userId}: ${anterior ?? '(sin comprobante)'} → ${path}${anterior ? ' — el anterior se CONSERVA en el bucket' : ''}`,
    );
    const [pago] = await this.enriquecer([data]);
    return { pago };
  }
}
