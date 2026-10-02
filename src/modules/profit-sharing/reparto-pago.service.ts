import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hoyCancun } from '../../common/fecha-cancun.util';
import { fetchNombresUsuarios } from '../../common/registrado-por.util';
import { Rol } from '../../common/types/auth.types';
import { SEGUNDOS_URL_MINIATURA } from '../../common/url-firmada.util';
import {
  LIMITE_COMPROBANTE_BYTES,
  validarComprobanteCobro,
} from '../flights/comprobante-cobro.util';
import { esTablaInexistente } from '../inventory/eliminar-movimiento.util';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  ActualizarPagoSocioDto,
  CrearPagoSocioDto,
} from './dto/reparto-pago.dto';
import { ProfitSharingService } from './profit-sharing.service';
import { lectorPagosSocios } from './reparto-pago.lector';
import {
  BUCKET_REPARTO_COMPROBANTES,
  COLS_REPARTO_PAGO,
  MENSAJE_CLIENT_REQUEST_ID_EN_USO_PAGO,
  MENSAJE_COMPROBANTE_PAGO_CAMBIO,
  MENSAJE_ENTREGADO_POR_INVALIDO,
  MENSAJE_MES_INVALIDO,
  MENSAJE_MOTIVO_BAJA_PAGO,
  MENSAJE_PAGO_CAMBIO_CONCURRENTE,
  MENSAJE_PAGO_NO_EXISTE,
  MENSAJE_PAGO_SIN_CAMBIOS,
  MENSAJE_PAGOS_NO_DISPONIBLE,
  MENSAJE_SOCIO_NO_ES_DE_LA_AERONAVE,
  MIGRACION_REPARTO_PAGO,
  MOTIVO_BAJA_CARRERA_ALTA,
  MOTIVO_BAJA_PAGO_MAX,
  MOTIVO_BAJA_PAGO_MIN,
  TABLA_REPARTO_PAGO,
  aPagoSocio,
  armarFilasPagos,
  esMes,
  excedeEnOrdenDeCaptura,
  excedeUtilidad,
  mensajeExcedeUtilidad,
  mensajeSinUtilidad,
  mesDeFechaPeriodo,
  pathComprobantePago,
  periodoDeMes,
  rangoDeMes,
  resumenPorSocio,
  sumaMontoUsd,
  textoOpcional,
  totalesPagos,
  utilidadDeSocioEnAvion,
  validarDineroPago,
  validarFechaPago,
  type AeronaveRef,
  type FilaPagoSocio,
  type PagoSocio,
  type RepartoAvionInput,
  type RepartoPagoRow,
  type ResumenSocioPagos,
  type TotalesPagos,
} from './reparto-pago.util';

/** Quién pide (de `@CurrentUser`). */
export interface ActorPagos {
  userId: string;
  rol: Rol;
}

/** Respuesta de `GET /v1/profit-sharing/pagos`. */
export interface PagosDelMes {
  disponible: boolean;
  mes: string;
  desde: string;
  hasta: string;
  filas: FilaPagoSocio[];
  por_socio: ResumenSocioPagos[];
  totales: TotalesPagos;
}

/** Archivo multipart ya leído por el controller. */
export interface ArchivoComprobantePago {
  buffer: Buffer;
  nombre: string | null;
  mime: string | null;
}

/** 503 estructurado: la migración 20261001000001 aún no está aplicada. */
export function errorPagosNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_PAGOS_NO_DISPONIBLE,
    error: 'PAGOS_SOCIOS_NO_DISPONIBLE',
    details: { migracion: MIGRACION_REPARTO_PAGO },
  });
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

const TOTALES_EN_CERO: Readonly<TotalesPagos> = Object.freeze({
  utilidad_usd: 0,
  pagado_usd: 0,
  pendiente_usd: 0,
  socios_pendientes: 0,
});

/**
 * PAGOS DE UTILIDADES A SOCIOS (1-oct-2026, API 0.0.49). Reglas puras en
 * `reparto-pago.util.ts`; la utilidad SIEMPRE sale de
 * `ProfitSharingService.compute` del mes (fuente única del reparto). Sonda
 * de la tabla en `reparto-pago.lector.ts` (compartida con el pre-cierre):
 * sin la migración, las LECTURAS responden `disponible:false` con listas
 * vacías y las ESCRITURAS 503 `PAGOS_SOCIOS_NO_DISPONIBLE`.
 */
@Injectable()
export class RepartoPagoService {
  private readonly logger = new Logger(RepartoPagoService.name);

  /** Reloj inyectable (specs): «hoy» Cancún para la fecha del pago. */
  ahora: () => Date = () => new Date();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly profitSharing: ProfitSharingService,
  ) {}

  private get sb() {
    return this.supabase.service;
  }

  private get lector() {
    return lectorPagosSocios(this.sb);
  }

  private async assertDisponible(): Promise<void> {
    if (!(await this.lector.disponible())) throw errorPagosNoDisponible();
  }

  // =================================================================
  // Lectura
  // =================================================================

  /**
   * `GET /v1/profit-sharing/pagos?mes&aeronave_id`: renglones (avión ×
   * socio) del mes con la utilidad calculada HOY, lo pagado y el estado;
   * consolidado por socio y totales. SOCIO: solo sus renglones.
   */
  async listar(
    mes: string,
    aeronaveId: string | undefined,
    actor: ActorPagos,
  ): Promise<PagosDelMes> {
    if (!esMes(mes)) throw bad('MES_INVALIDO', MENSAJE_MES_INVALIDO);
    const { desde, hasta } = rangoDeMes(mes);
    const vacio: PagosDelMes = {
      disponible: false,
      mes,
      desde,
      hasta,
      filas: [],
      por_socio: [],
      totales: { ...TOTALES_EN_CERO },
    };
    if (!(await this.lector.disponible())) return vacio;
    const esSocio = actor.rol === Rol.SOCIO;
    const [calculo, rows] = await Promise.all([
      this.profitSharing.compute({ desde, hasta, aeronave_id: aeronaveId }),
      this.lector.pagosDelMes(periodoDeMes(mes), {
        aeronave_id: aeronaveId,
        socio_id: esSocio ? actor.userId : undefined,
      }),
    ]);
    if (rows === 'sin_tabla') return vacio;
    const todas = await this.armarFilas(calculo.aviones, rows);
    const filas = esSocio
      ? todas.filter((f) => f.socio.id === actor.userId)
      : todas;
    const por_socio = resumenPorSocio(filas);
    return {
      disponible: true,
      mes,
      desde,
      hasta,
      filas,
      por_socio,
      totales: totalesPagos(por_socio),
    };
  }

  /** Filas del util con nombres, firmas y aviones dados de baja resueltos. */
  private async armarFilas(
    aviones: ReadonlyArray<RepartoAvionInput>,
    rows: ReadonlyArray<RepartoPagoRow>,
  ): Promise<FilaPagoSocio[]> {
    const enCalculo = new Set(aviones.map((a) => a.aeronave.id));
    const sociosCalculo = new Set(
      aviones.flatMap((a) =>
        a.reparto.map((r) => `${a.aeronave.id}|${r.socio_id}`),
      ),
    );
    // Socios con pagos que ya no están en el reparto: su nombre viaja en la
    // MISMA lectura de usuarios que «entregó»/«registró» (una consulta).
    const sociosExtra = rows
      .filter((r) => !sociosCalculo.has(`${r.aeronave_id}|${r.socio_id}`))
      .map((r) => r.socio_id);
    const [{ pagos, nombres }, aeronavesExtra] = await Promise.all([
      this.enriquecerConNombres(rows, sociosExtra),
      this.aeronavesDe(
        rows.map((r) => r.aeronave_id).filter((id) => !enCalculo.has(id)),
      ),
    ]);
    return armarFilasPagos({
      aviones,
      pagos,
      aeronavesExtra,
      nombresSocios: nombres,
    });
  }

  /** Nombres (entregó / registró) y URL firmada de 8 h, en lote. */
  private async enriquecer(
    rows: ReadonlyArray<RepartoPagoRow>,
  ): Promise<PagoSocio[]> {
    return (await this.enriquecerConNombres(rows, [])).pagos;
  }

  private async enriquecerConNombres(
    rows: ReadonlyArray<RepartoPagoRow>,
    idsExtra: ReadonlyArray<string>,
  ): Promise<{ pagos: PagoSocio[]; nombres: Map<string, string> }> {
    if (rows.length === 0) return { pagos: [], nombres: new Map() };
    const [nombres, urls] = await Promise.all([
      // Nunca lanza: usuario borrado o lectura fallida ⇒ nombre null.
      fetchNombresUsuarios(this.sb, [
        ...rows.flatMap((r) => [r.entregado_por, r.created_by]),
        ...idsExtra,
      ]),
      this.firmarComprobantes(
        rows.map((r) => r.comprobante_path).filter((p): p is string => !!p),
      ),
    ]);
    return { pagos: rows.map((r) => aPagoSocio(r, nombres, urls)), nombres };
  }

  /** Firma por lote (8 h). Nunca lanza: sin URL el panel pinta su aviso. */
  private async firmarComprobantes(
    paths: ReadonlyArray<string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unicos = [...new Set(paths)];
    if (unicos.length === 0) return out;
    try {
      const { data, error } = await this.sb.storage
        .from(BUCKET_REPARTO_COMPROBANTES)
        .createSignedUrls(unicos, SEGUNDOS_URL_MINIATURA);
      if (error) {
        this.logger.warn(
          `No se pudieron firmar ${unicos.length} comprobante(s) de pagos a socios: ${error.message}`,
        );
        return out;
      }
      for (const it of data ?? []) {
        if (it.path && it.signedUrl) out.set(it.path, it.signedUrl);
      }
    } catch (e) {
      this.logger.warn(
        `Falló la firma de comprobantes de pagos a socios: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return out;
  }

  /** Aviones que el cálculo no trae (dados de baja). Best-effort. */
  private async aeronavesDe(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, AeronaveRef>> {
    const out = new Map<string, AeronaveRef>();
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return out;
    try {
      const { data, error } = await this.sb
        .from('aeronave')
        .select('id, matricula, modelo')
        .in('id', unicos);
      if (error) {
        this.logger.warn(
          `No se pudieron leer aviones de pagos: ${error.message}`,
        );
        return out;
      }
      const filas = (data ?? []) as Array<{
        id: string;
        matricula: string | null;
        modelo: string | null;
      }>;
      for (const a of filas) {
        out.set(a.id, {
          id: a.id,
          matricula: a.matricula ?? '',
          modelo: a.modelo ?? '',
        });
      }
    } catch (e) {
      this.logger.warn(
        `Falló la lectura de aviones de pagos: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return out;
  }

  /**
   * El renglón (avión, socio, mes) ya recalculado tras una escritura.
   * `null` cuando ya no hay renglón (socio fuera del reparto y sin pagos
   * vivos).
   */
  private async filaDe(
    aeronaveId: string,
    socioId: string,
    periodo: string,
    aviones?: ReadonlyArray<RepartoAvionInput>,
  ): Promise<FilaPagoSocio | null> {
    let avionesMes = aviones;
    if (!avionesMes) {
      const { desde, hasta } = rangoDeMes(mesDeFechaPeriodo(periodo));
      const calc = await this.profitSharing.compute({
        desde,
        hasta,
        aeronave_id: aeronaveId,
      });
      avionesMes = calc.aviones;
    }
    const rows = await this.lector.pagosDelMes(periodo, {
      aeronave_id: aeronaveId,
      socio_id: socioId,
    });
    if (rows === 'sin_tabla') throw errorPagosNoDisponible();
    const delAvion = avionesMes
      .filter((a) => a.aeronave.id === aeronaveId)
      .map((a) => ({
        aeronave: a.aeronave,
        reparto: a.reparto.filter((r) => r.socio_id === socioId),
      }));
    const filas = await this.armarFilas(delAvion, rows);
    return (
      filas.find(
        (f) => f.aeronave.id === aeronaveId && f.socio.id === socioId,
      ) ?? null
    );
  }

  // =================================================================
  // Helpers de escritura
  // =================================================================

  private hoy(): string {
    return hoyCancun(this.ahora());
  }

  /** Pago VIVO o 404; tabla ausente ⇒ 503. */
  private async pagoVivo(id: string): Promise<RepartoPagoRow> {
    const { data, error } = await this.sb
      .from(TABLA_REPARTO_PAGO)
      .select(COLS_REPARTO_PAGO)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) {
      if (esTablaInexistente(error)) {
        this.lector.marcarAusente();
        throw errorPagosNoDisponible();
      }
      throw new Error(error.message);
    }
    if (!data) throw pagoNoExiste(id);
    return data;
  }

  /** Pago (vivo o borrado) con esa llave de idempotencia, o null. */
  private async pagoPorLlave(key: string): Promise<RepartoPagoRow | null> {
    const { data, error } = await this.sb
      .from(TABLA_REPARTO_PAGO)
      .select(COLS_REPARTO_PAGO)
      .eq('client_request_id', key)
      .maybeSingle();
    if (error) {
      if (esTablaInexistente(error)) {
        this.lector.marcarAusente();
        throw errorPagosNoDisponible();
      }
      throw new Error(error.message);
    }
    return data ?? null;
  }

  /** `entregado_por_id` debe ser un usuario ACTIVO (400 si no). */
  private async assertUsuarioActivo(id: string): Promise<void> {
    const { data, error } = await this.sb
      .from('usuario')
      .select('id, estado')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const estado = (data as { estado?: unknown } | null)?.estado;
    if (!data || String(estado) !== 'ACTIVO') {
      throw bad('ENTREGADO_POR_INVALIDO', MENSAJE_ENTREGADO_POR_INVALIDO, {
        entregado_por_id: id,
      });
    }
  }

  /** El socio está en `aeronave_socio` del avión con vigencia que toca el mes. */
  private async assertSocioDeAeronave(
    aeronaveId: string,
    socioId: string,
    mes: string,
  ): Promise<void> {
    const { desde, hasta } = rangoDeMes(mes);
    const { data, error } = await this.sb
      .from('aeronave_socio')
      .select('aeronave_id, socio_id, vigente_desde, vigente_hasta')
      .eq('aeronave_id', aeronaveId)
      .eq('socio_id', socioId);
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as Array<{
      vigente_desde: string;
      vigente_hasta: string | null;
    }>;
    // Misma regla de vigencia que `compute` (traslape con el mes).
    const vigente = filas.some(
      (s) =>
        s.vigente_desde <= hasta &&
        (s.vigente_hasta == null || s.vigente_hasta >= desde),
    );
    if (!vigente) {
      throw bad(
        'SOCIO_NO_ES_DE_LA_AERONAVE',
        MENSAJE_SOCIO_NO_ES_DE_LA_AERONAVE,
        { aeronave_id: aeronaveId, socio_id: socioId, mes },
      );
    }
  }

  /** Utilidad del socio en el mes (compute) + 409 si no hay qué pagar. */
  private async utilidadDelMes(
    aeronaveId: string,
    socioId: string,
    mes: string,
  ): Promise<{ utilidad: number; aviones: RepartoAvionInput[] }> {
    const { desde, hasta } = rangoDeMes(mes);
    const calc = await this.profitSharing.compute({
      desde,
      hasta,
      aeronave_id: aeronaveId,
    });
    const u = utilidadDeSocioEnAvion(calc.aviones, aeronaveId, socioId);
    return {
      utilidad: u.avion_activo ? u.utilidad_usd : 0,
      aviones: calc.aviones,
    };
  }

  private sinUtilidad(
    mes: string,
    aviones: ReadonlyArray<RepartoAvionInput>,
    aeronaveId: string,
    utilidad: number,
  ): ConflictException {
    const activo = aviones.some((a) => a.aeronave.id === aeronaveId);
    return new ConflictException({
      message: mensajeSinUtilidad(mes, activo),
      error: 'SIN_UTILIDAD_QUE_PAGAR',
      details: { utilidad_usd: utilidad, avion_activo: activo, mes },
    });
  }

  private excede(d: {
    utilidad_usd: number;
    pagado_usd: number;
    monto_usd: number;
    exceso_usd: number;
  }): ConflictException {
    return new ConflictException({
      message: mensajeExcedeUtilidad(d),
      error: 'PAGO_EXCEDE_UTILIDAD',
      details: d,
    });
  }

  /** Σ monto_usd de los pagos VIVOS del renglón, sin `excluirId`. */
  private async pagadoDe(
    aeronaveId: string,
    socioId: string,
    periodo: string,
    excluirId?: string,
  ): Promise<number> {
    const rows = await this.lector.pagosDelMes(periodo, {
      aeronave_id: aeronaveId,
      socio_id: socioId,
    });
    if (rows === 'sin_tabla') throw errorPagosNoDisponible();
    // MISMA suma que el renglón (fuente única): el 409 y la fila no pueden
    // decir números distintos.
    return sumaMontoUsd(rows.filter((r) => r.id !== excluirId));
  }

  /** Error de BD de un insert/update ⇒ excepción legible (nunca 500 por dato). */
  private errorDeEscritura(error: {
    code?: string | null;
    message?: string | null;
  }): Error {
    if (esTablaInexistente(error)) {
      this.lector.marcarAusente();
      return errorPagosNoDisponible();
    }
    if (error.code === '23514') {
      return bad(
        'PAGO_INVALIDO',
        'Algún dato del pago no es válido (monto, moneda, T.C., método o largo de un texto).',
        { tecnico: error.message },
      );
    }
    if (error.code === '22003') {
      // numeric fuera de rango (monto o T.C. que no caben en la columna):
      // el DTO y la banda del T.C. ya lo atajan; esto es el cinturón.
      return bad(
        'PAGO_INVALIDO',
        'Algún número del pago es demasiado grande para guardarse (monto o tipo de cambio): revisa la captura.',
        { tecnico: error.message },
      );
    }
    if (error.code === '23503') {
      return bad(
        'PAGO_REFERENCIA_INVALIDA',
        'El avión, el socio o quien entregó el pago ya no existe.',
        { tecnico: error.message },
      );
    }
    return new Error(error.message ?? 'Error al guardar el pago');
  }

  // =================================================================
  // Escritura
  // =================================================================

  /**
   * `POST /v1/profit-sharing/pagos`. Idempotencia PRIMERO (el reintento de
   * un alta que sí quedó no debe rebotar en ningún candado); luego forma,
   * quién entregó, socio del avión, utilidad del mes (compute) y exceso.
   */
  async crear(
    dto: CrearPagoSocioDto,
    actor: ActorPagos,
  ): Promise<{
    pago: PagoSocio;
    fila: FilaPagoSocio | null;
    idempotente?: true;
  }> {
    await this.assertDisponible();
    if (dto.client_request_id) {
      const ya = await this.pagoPorLlave(dto.client_request_id);
      if (ya) return this.respuestaIdempotente(ya, dto);
    }
    if (!esMes(dto.mes)) throw bad('MES_INVALIDO', MENSAJE_MES_INVALIDO);
    const dinero = validarDineroPago(dto);
    if (!dinero.ok) throw bad(dinero.codigo, dinero.mensaje);
    const fecha = validarFechaPago(dto.fecha_pago, this.hoy());
    if (!fecha.ok) throw bad(fecha.codigo, fecha.mensaje);
    const entregadoPor = dto.entregado_por_id ?? actor.userId;
    if (dto.entregado_por_id)
      await this.assertUsuarioActivo(dto.entregado_por_id);
    await this.assertSocioDeAeronave(dto.aeronave_id, dto.socio_id, dto.mes);

    const periodo = periodoDeMes(dto.mes);
    const { utilidad, aviones } = await this.utilidadDelMes(
      dto.aeronave_id,
      dto.socio_id,
      dto.mes,
    );
    // No se paga lo que no hay — ni con `aceptar_exceso`.
    if (utilidad <= 0) {
      const replay = await this.replaySiYaQuedo(dto);
      if (replay) return replay;
      throw this.sinUtilidad(dto.mes, aviones, dto.aeronave_id, utilidad);
    }
    const pagado = await this.pagadoDe(dto.aeronave_id, dto.socio_id, periodo);
    const ex = excedeUtilidad({
      utilidad_usd: utilidad,
      pagado_usd: pagado,
      monto_usd: dinero.monto_usd,
    });
    if (ex.excede && dto.aceptar_exceso !== true) {
      // Doble envío con la MISMA llave: la 1.ª pudo insertar entre la
      // búsqueda de la llave (arriba) y `pagadoDe`, que ya la cuenta como
      // «pagado». Es un replay, no un exceso (revisión adversaria 1-oct-2026).
      const replay = await this.replaySiYaQuedo(dto);
      if (replay) return replay;
      throw this.excede({
        utilidad_usd: utilidad,
        pagado_usd: pagado,
        monto_usd: dinero.monto_usd,
        exceso_usd: ex.exceso_usd,
      });
    }

    const { data, error } = await this.sb
      .from(TABLA_REPARTO_PAGO)
      .insert({
        aeronave_id: dto.aeronave_id,
        socio_id: dto.socio_id,
        periodo,
        monto: dinero.monto,
        moneda: dinero.moneda,
        tc_usd_mxn: dinero.tc_usd_mxn,
        monto_usd: dinero.monto_usd,
        utilidad_snapshot_usd: utilidad,
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
    const row = data;
    if (dto.aceptar_exceso !== true) {
      const perdio = await this.perdioCarreraDeAlta(row, utilidad, actor);
      if (perdio) throw this.excede(perdio);
    }
    this.logger.log(
      `Pago a socio ${row.id}: avión ${row.aeronave_id}, socio ${row.socio_id}, ${dto.mes}, ${row.monto} ${row.moneda} (${row.monto_usd} USD) por ${actor.userId}${ex.excede ? ' — EXCEDE la utilidad (aceptado)' : ''}`,
    );
    const [pago] = await this.enriquecer([row]);
    const fila = await this.filaDe(
      dto.aeronave_id,
      dto.socio_id,
      periodo,
      aviones,
    );
    return { pago, fila };
  }

  /**
   * Antes de responder un 409 de dinero: si la llave del alta YA existe, la
   * primera petición ganó la carrera ⇒ replay (200 idempotente). Sin llave,
   * `null`.
   */
  private async replaySiYaQuedo(dto: CrearPagoSocioDto): Promise<{
    pago: PagoSocio;
    fila: FilaPagoSocio | null;
    idempotente: true;
  } | null> {
    if (!dto.client_request_id) return null;
    const ya = await this.pagoPorLlave(dto.client_request_id);
    return ya ? this.respuestaIdempotente(ya, dto) : null;
  }

  /**
   * CARRERA DE ALTAS (revisión adversaria 1-oct-2026): el candado del exceso
   * es «leer y luego insertar», así que dos altas del mismo renglón pueden
   * pasarlo a la vez y juntas rebasar la utilidad sin que nadie mandara
   * `aceptar_exceso`. Ya insertada ESTA fila, se relee el renglón y se
   * decide con el orden de CAPTURA (`excedeEnOrdenDeCaptura`, determinista
   * para las dos peticiones): si ESTA es la que sobra, se da de baja (soft
   * delete con `MOTIVO_BAJA_CARRERA_ALTA`) y se LIBERA su llave para que el
   * operador confirme con la MISMA llave + `aceptar_exceso` (sin liberarla
   * el reintento chocaría con `CLIENT_REQUEST_ID_EN_USO`). Devuelve los
   * `details` del 409, o `null` si la fila se queda.
   * Best-effort: si la relectura o la baja fallan, la fila SE QUEDA (201) y
   * el sobrepago lo avisa el pre-cierre (`pagos_socios_sobrepagados`).
   * Ventana residual: si la otra alta confirma DESPUÉS de esta relectura,
   * las dos se quedan (milisegundos; también lo avisa el pre-cierre).
   */
  private async perdioCarreraDeAlta(
    row: RepartoPagoRow,
    utilidad: number,
    actor: ActorPagos,
  ): Promise<{
    utilidad_usd: number;
    pagado_usd: number;
    monto_usd: number;
    exceso_usd: number;
  } | null> {
    let r: ReturnType<typeof excedeEnOrdenDeCaptura>;
    try {
      const vivos = await this.lector.pagosDelMes(row.periodo, {
        aeronave_id: row.aeronave_id,
        socio_id: row.socio_id,
      });
      if (vivos === 'sin_tabla') return null;
      r = excedeEnOrdenDeCaptura({ utilidad_usd: utilidad, vivos, nuevo: row });
    } catch (e) {
      this.logger.warn(
        `Pago a socio ${row.id}: no se pudo revisar la carrera de altas (se conserva): ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
    if (!r.excede) return null;
    const { data, error } = await this.sb
      .from(TABLA_REPARTO_PAGO)
      .update({
        deleted_at: this.ahora().toISOString(),
        deleted_by: actor.userId,
        motivo_baja: MOTIVO_BAJA_CARRERA_ALTA,
        client_request_id: null,
      })
      .eq('id', row.id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (error || !data) {
      this.logger.error(
        `Pago a socio ${row.id}: perdió la carrera de altas (rebasa la utilidad por ${r.exceso_usd} USD) y NO se pudo dar de baja: ${error?.message ?? 'la fila ya no estaba viva'}. Queda registrado; el pre-cierre lo avisa como sobrepago.`,
      );
      return null;
    }
    this.logger.warn(
      `Pago a socio ${row.id} dado de baja por carrera de altas: ${row.monto_usd} USD sobre ${r.pagado_antes_usd} ya pagados rebasan la utilidad de ${utilidad} USD (avión ${row.aeronave_id}, socio ${row.socio_id}, ${row.periodo}).`,
    );
    return {
      utilidad_usd: utilidad,
      pagado_usd: r.pagado_antes_usd,
      monto_usd: Number(row.monto_usd),
      exceso_usd: r.exceso_usd,
    };
  }

  /** Replay de la llave: solo si es EL MISMO pago (mismo renglón y vivo). */
  private async respuestaIdempotente(
    ya: RepartoPagoRow,
    dto: CrearPagoSocioDto,
  ): Promise<{
    pago: PagoSocio;
    fila: FilaPagoSocio | null;
    idempotente: true;
  }> {
    const mismo =
      ya.aeronave_id === dto.aeronave_id &&
      ya.socio_id === dto.socio_id &&
      esMes(dto.mes) &&
      ya.periodo === periodoDeMes(dto.mes) &&
      ya.deleted_at == null;
    if (!mismo) {
      throw new ConflictException({
        message: MENSAJE_CLIENT_REQUEST_ID_EN_USO_PAGO,
        error: 'CLIENT_REQUEST_ID_EN_USO',
        details: { client_request_id: dto.client_request_id },
      });
    }
    const [pago] = await this.enriquecer([ya]);
    const fila = await this.filaDe(ya.aeronave_id, ya.socio_id, ya.periodo);
    return { pago, fila, idempotente: true };
  }

  /**
   * `PATCH /v1/profit-sharing/pagos/:id`. Re-valida el DINERO sobre el
   * estado FUSIONADO; si el monto en dólares SUBE se vuelven a correr
   * SIN_UTILIDAD y el exceso (bajar nunca empeora nada). Corregir el dinero
   * renueva la foto de la utilidad. CAS por `updated_at`.
   */
  async actualizar(
    id: string,
    dto: ActualizarPagoSocioDto,
    actor: ActorPagos,
  ): Promise<{ pago: PagoSocio; fila: FilaPagoSocio | null }> {
    await this.assertDisponible();
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
      ] as const
    ).filter((k) => dto[k] !== undefined);
    if (campos.length === 0) {
      throw bad('PAGO_SIN_CAMBIOS', MENSAJE_PAGO_SIN_CAMBIOS);
    }
    const actual = await this.pagoVivo(id);
    const mes = mesDeFechaPeriodo(actual.periodo);

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
      const f = validarFechaPago(dto.fecha_pago, this.hoy());
      if (!f.ok) throw bad(f.codigo, f.mensaje);
    }
    if (dto.entregado_por_id !== undefined) {
      await this.assertUsuarioActivo(dto.entregado_por_id);
    }

    const tcActual =
      actual.tc_usd_mxn == null ? null : Number(actual.tc_usd_mxn);
    const cambiaDinero =
      dinero.monto !== Number(actual.monto) ||
      dinero.moneda !== actual.moneda ||
      dinero.tc_usd_mxn !== tcActual ||
      Math.round(dinero.monto_usd * 100) !==
        Math.round(Number(actual.monto_usd) * 100);
    const sube =
      Math.round(dinero.monto_usd * 100) >
      Math.round(Number(actual.monto_usd) * 100);

    const { utilidad, aviones } = await this.utilidadDelMes(
      actual.aeronave_id,
      actual.socio_id,
      mes,
    );
    if (sube) {
      if (utilidad <= 0) {
        throw this.sinUtilidad(mes, aviones, actual.aeronave_id, utilidad);
      }
      const otros = await this.pagadoDe(
        actual.aeronave_id,
        actual.socio_id,
        actual.periodo,
        actual.id,
      );
      const ex = excedeUtilidad({
        utilidad_usd: utilidad,
        pagado_usd: otros,
        monto_usd: dinero.monto_usd,
      });
      if (ex.excede && dto.aceptar_exceso !== true) {
        throw this.excede({
          utilidad_usd: utilidad,
          pagado_usd: otros,
          monto_usd: dinero.monto_usd,
          exceso_usd: ex.exceso_usd,
        });
      }
    }

    const patch: Record<string, unknown> = {};
    if (cambiaDinero) {
      patch.monto = dinero.monto;
      patch.moneda = dinero.moneda;
      patch.tc_usd_mxn = dinero.tc_usd_mxn;
      patch.monto_usd = dinero.monto_usd;
      patch.utilidad_snapshot_usd = utilidad;
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

    let row = actual;
    if (Object.keys(patch).length > 0) {
      const { data, error } = await this.sb
        .from(TABLA_REPARTO_PAGO)
        .update(patch)
        .eq('id', id)
        .is('deleted_at', null)
        // CAS: el parche se calculó sobre ESTA versión.
        .eq('updated_at', actual.updated_at)
        .select(COLS_REPARTO_PAGO)
        .maybeSingle();
      if (error) throw this.errorDeEscritura(error);
      if (!data) {
        await this.pagoVivo(id); // 404 si lo borraron
        throw new ConflictException({
          message: MENSAJE_PAGO_CAMBIO_CONCURRENTE,
          error: 'PAGO_CAMBIO_CONCURRENTE',
          details: { pago_id: id },
        });
      }
      row = data;
      this.logger.log(
        `Pago a socio ${id} corregido por ${actor.userId}: ${Object.keys(patch).join(', ')}`,
      );
    }
    const [pago] = await this.enriquecer([row]);
    const fila = await this.filaDe(
      row.aeronave_id,
      row.socio_id,
      row.periodo,
      aviones,
    );
    return { pago, fila };
  }

  /**
   * `DELETE /v1/profit-sharing/pagos/:id` — SOFT delete con motivo (5–300).
   * El panel CONFIRMA antes (regla del cliente). Borrado ⇒ 404.
   */
  async eliminar(
    id: string,
    motivo: string,
    actor: ActorPagos,
  ): Promise<{ deleted: true; fila: FilaPagoSocio | null }> {
    await this.assertDisponible();
    const m = String(motivo ?? '').trim();
    if (m.length < MOTIVO_BAJA_PAGO_MIN || m.length > MOTIVO_BAJA_PAGO_MAX) {
      throw bad('MOTIVO_INVALIDO', MENSAJE_MOTIVO_BAJA_PAGO);
    }
    const actual = await this.pagoVivo(id);
    const { data, error } = await this.sb
      .from(TABLA_REPARTO_PAGO)
      .update({
        deleted_at: this.ahora().toISOString(),
        deleted_by: actor.userId,
        motivo_baja: m,
      })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw this.errorDeEscritura(error);
    if (!data) throw pagoNoExiste(id);
    this.logger.log(
      `Pago a socio ${id} (${actual.monto} ${actual.moneda}) eliminado por ${actor.userId}: ${m}`,
    );
    const fila = await this.filaDe(
      actual.aeronave_id,
      actual.socio_id,
      actual.periodo,
    );
    return { deleted: true, fila };
  }

  /**
   * `POST /v1/profit-sharing/pagos/:id/comprobante`: foto o PDF ≤ 10 MB.
   * Sube a `reparto-comprobantes/<avión>/<YYYY-MM>/<pago>/<uuid>.<ext>` y
   * guarda el path con CAS sobre el anterior; el ANTERIOR se conserva en el
   * bucket (patrón de facturas emitidas). Si guardar falla, el archivo
   * recién subido se retira.
   */
  async subirComprobante(
    id: string,
    archivo: ArchivoComprobantePago,
    actor: ActorPagos,
  ): Promise<{ pago: PagoSocio }> {
    await this.assertDisponible();
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
      actual.aeronave_id,
      mesDeFechaPeriodo(actual.periodo),
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
      .update({ comprobante_path: path })
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
      await this.pagoVivo(id); // 404 si lo borraron
      throw new ConflictException({
        message: MENSAJE_COMPROBANTE_PAGO_CAMBIO,
        error: 'COMPROBANTE_CAMBIO',
        details: { pago_id: id },
      });
    }
    this.logger.log(
      `Comprobante del pago a socio ${id} por ${actor.userId}: ${anterior ?? '(sin comprobante)'} → ${path}${anterior ? ' — el anterior se CONSERVA en el bucket' : ''}`,
    );
    const [pago] = await this.enriquecer([data]);
    return { pago };
  }
}
