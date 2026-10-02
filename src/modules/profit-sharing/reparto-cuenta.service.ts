import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { hoyCancun } from '../../common/fecha-cancun.util';
import { Rol } from '../../common/types/auth.types';
import { SupabaseService } from '../supabase/supabase.service';
import type { ConfigurarCuentaSocioDto } from './dto/reparto-cuenta.dto';
import { ProfitSharingService } from './profit-sharing.service';
import {
  SIN_MIGRACION,
  lectorCuentaSocios,
  type UniversoCuentas,
} from './reparto-cuenta.lector';
import {
  COLS_REPARTO_CUENTA,
  MENSAJE_CUENTA_SOCIO_NO_DISPONIBLE,
  MENSAJE_RANGO_MESES_INVALIDO,
  MENSAJE_SALDO_INICIAL_INVALIDO,
  MENSAJE_SOCIO_NO_EXISTE,
  MENSAJE_SOCIO_SOLO_SU_CUENTA,
  MESES_ESTADO_CUENTA_MAX,
  MIGRACION_REPARTO_CUENTA,
  NOTAS_CUENTA_MAX,
  TABLA_REPARTO_CUENTA_SOCIO,
  armarEstadoCuenta,
  armarSociosBase,
  filaCuentaSocio,
  mesActualCancun,
  mesesEntre,
  saldoInicialValido,
  totalesCuentas,
  validarCuentaDesde,
  type EstadoCuentaSocioDatos,
  type FilaCuentaSocio,
  type SocioBase,
  type TotalesCuentas,
  type UtilidadMesSocios,
} from './reparto-cuenta.util';
import {
  MENSAJE_SOCIO_INVALIDO,
  aPagoSocio,
  esMes,
  textoOpcional,
  type PagoSocio,
  type RepartoPagoRow,
} from './reparto-pago.util';

/** Quién pide (de `@CurrentUser`). */
export interface ActorCuenta {
  userId: string;
  rol: Rol;
}

/** `GET /v1/profit-sharing/socios`. */
export interface ResumenSocios {
  disponible: boolean;
  /** Mes en curso (Cancún): las utilidades llegan hasta aquí. */
  hasta_mes: string;
  socios: FilaCuentaSocio[];
  /** null para SOCIO (solo ve lo suyo) y sin la migración. */
  totales: TotalesCuentas | null;
}

/** `GET /v1/profit-sharing/socios/:id/estado-cuenta`. */
export type EstadoCuentaRespuesta =
  | ({ disponible: true } & EstadoCuentaSocioDatos)
  | { disponible: false };

/**
 * Lo que una escritura necesita del socio: su base (cuenta, aviones), las
 * utilidades ya calculadas (para no repetir el compute del mes en curso al
 * responder), sus entregas vivas y su renglón del resumen.
 */
export interface ContextoSocio {
  base: SocioBase;
  utilidades: UtilidadMesSocios[];
  /** Aviones de `aeronave_socio` del socio (cualquier vigencia). */
  aeronaves_ids: ReadonlySet<string>;
  pagos: PagoSocio[];
  fila: FilaCuentaSocio;
}

/** 503 estructurado: la migración 20261002000001 aún no está aplicada. */
export function errorCuentaNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_CUENTA_SOCIO_NO_DISPONIBLE,
    error: 'CUENTA_SOCIO_NO_DISPONIBLE',
    details: { migracion: MIGRACION_REPARTO_CUENTA },
  });
}

function bad(code: string, message: string, details?: unknown) {
  return new BadRequestException({ message, error: code, details });
}

/**
 * CUENTA CORRIENTE DEL SOCIO (v2, 2-oct-2026, invariante 38). Reglas puras
 * en `reparto-cuenta.util.ts`; las utilidades por mes SIEMPRE salen de
 * `ProfitSharingService.utilidadesSociosPorMes` (compute mes a mes, memo).
 * Sonda en `reparto-cuenta.lector.ts` (compartida con el pre-cierre): sin la
 * migración, las LECTURAS responden `disponible:false` y las ESCRITURAS 503
 * `CUENTA_SOCIO_NO_DISPONIBLE`.
 */
@Injectable()
export class RepartoCuentaService {
  private readonly logger = new Logger(RepartoCuentaService.name);

  /** Reloj inyectable (specs): mes en curso y «hoy» Cancún. Lo comparte `RepartoPagoService`. */
  ahora: () => Date = () => new Date();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly profitSharing: ProfitSharingService,
  ) {}

  private get sb() {
    return this.supabase.service;
  }

  get lector() {
    return lectorCuentaSocios(this.sb);
  }

  /** Mes en curso (YYYY-MM, Cancún). */
  mesActual(): string {
    return mesActualCancun(this.ahora());
  }

  /** Hoy (YYYY-MM-DD, Cancún). */
  hoy(): string {
    return hoyCancun(this.ahora());
  }

  async disponible(): Promise<boolean> {
    return this.lector.disponible();
  }

  async assertDisponible(): Promise<void> {
    if (!(await this.lector.disponible())) throw errorCuentaNoDisponible();
  }

  // =================================================================
  // Armado (I/O ⇒ util)
  // =================================================================

  private sociosBase(u: UniversoCuentas): SocioBase[] {
    return armarSociosBase({
      sociosAeronave: u.sociosAeronave,
      cuentas: u.cuentas,
      sociosConEntregas: u.entregas.map((p) => p.socio_id),
      usuarios: u.usuarios,
      aeronaves: u.aeronaves,
      hoy: this.hoy(),
    });
  }

  /** Filas ⇒ `PagoSocio` con nombres y matrícula (y URL si se pide). */
  async entregasDe(
    rows: ReadonlyArray<RepartoPagoRow>,
    u: Pick<UniversoCuentas, 'usuarios' | 'aeronaves'>,
    firmar: boolean,
  ): Promise<PagoSocio[]> {
    const nombres = new Map<string, string>();
    for (const [id, x] of u.usuarios) {
      const n = x.nombre?.trim();
      if (n) nombres.set(id, n);
    }
    const matriculas = new Map<string, string>();
    for (const [id, a] of u.aeronaves) {
      if (a.matricula) matriculas.set(id, a.matricula);
    }
    const urls = firmar
      ? await this.lector.firmarComprobantes(
          rows.map((r) => r.comprobante_path),
        )
      : new Map<string, string>();
    return rows.map((r) => aPagoSocio(r, nombres, urls, matriculas));
  }

  /**
   * Utilidades de los meses que abarca(n) la(s) cuenta(s), hasta el mes en
   * curso. `fresco`: sin la memoria de 10 min (escrituras).
   */
  private async utilidadesDesde(
    desde: string,
    mesActual: string,
    fresco = false,
  ): Promise<UtilidadMesSocios[]> {
    return this.profitSharing.utilidadesSociosPorMes(
      mesesEntre(desde < mesActual ? desde : mesActual, mesActual),
      mesActual,
      { fresco },
    );
  }

  // =================================================================
  // Lectura
  // =================================================================

  /**
   * `GET /v1/profit-sharing/socios`: un renglón por socio (todos los de
   * `aeronave_socio` de cualquier vigencia ∪ los que tienen cuenta o
   * entregas) con generado, en curso, entregado, por entregar y estado.
   * SOCIO: solo el suyo y sin totales.
   */
  async resumen(actor: ActorCuenta): Promise<ResumenSocios> {
    const mesActual = this.mesActual();
    const vacio: ResumenSocios = {
      disponible: false,
      hasta_mes: mesActual,
      socios: [],
      totales: null,
    };
    if (!(await this.lector.disponible())) return vacio;
    const esSocio = actor.rol === Rol.SOCIO;
    const u = await this.lector.universo(esSocio ? actor.userId : undefined);
    if (u === SIN_MIGRACION) return vacio;
    const bases = this.sociosBase(u).filter(
      (b) => !esSocio || b.socio.id === actor.userId,
    );
    if (bases.length === 0) {
      // Nadie que mostrar (p. ej. un usuario SOCIO sin avión): ni un compute.
      return {
        disponible: true,
        hasta_mes: mesActual,
        socios: [],
        totales: esSocio ? null : totalesCuentas([]),
      };
    }
    const desdeMin = bases.reduce(
      (min, b) => (b.cuenta.cuenta_desde < min ? b.cuenta.cuenta_desde : min),
      mesActual,
    );
    const [utilidades, pagos] = await Promise.all([
      this.utilidadesDesde(desdeMin, mesActual),
      this.entregasDe(u.entregas, u, false),
    ]);
    const socios = bases.map((base) =>
      filaCuentaSocio({ base, utilidades, pagos }),
    );
    return {
      disponible: true,
      hasta_mes: mesActual,
      socios,
      totales: esSocio ? null : totalesCuentas(socios),
    };
  }

  /**
   * `GET /v1/profit-sharing/socios/:socioId/estado-cuenta?desde&hasta`
   * (meses). Default: desde = arranque de la cuenta, hasta = mes en curso
   * (un `hasta` futuro se recorta al mes en curso). SOCIO: solo el suyo
   * (403). Socio desconocido ⇒ 404.
   */
  async estadoDeCuenta(
    socioId: string,
    q: { desde?: string; hasta?: string },
    actor: ActorCuenta,
  ): Promise<EstadoCuentaRespuesta> {
    if (actor.rol === Rol.SOCIO && socioId !== actor.userId) {
      throw new ForbiddenException({
        message: MENSAJE_SOCIO_SOLO_SU_CUENTA,
        error: 'SOCIO_SOLO_SU_CUENTA',
      });
    }
    for (const m of [q.desde, q.hasta]) {
      if (m !== undefined && !esMes(m)) {
        throw bad('RANGO_INVALIDO', MENSAJE_RANGO_MESES_INVALIDO);
      }
    }
    if (!(await this.lector.disponible())) return { disponible: false };
    const u = await this.lector.universo(socioId);
    if (u === SIN_MIGRACION) return { disponible: false };
    const base = this.sociosBase(u).find((b) => b.socio.id === socioId);
    if (!base) {
      throw new NotFoundException({
        message: MENSAJE_SOCIO_NO_EXISTE,
        error: 'SOCIO_NO_EXISTE',
        details: { socio_id: socioId },
      });
    }
    const mesActual = this.mesActual();
    const desde = q.desde ?? base.cuenta.cuenta_desde;
    let hasta = q.hasta ?? mesActual;
    if (hasta > mesActual) hasta = mesActual;
    const meses = mesesEntre(desde, hasta);
    if (meses.length === 0 || meses.length > MESES_ESTADO_CUENTA_MAX) {
      throw bad('RANGO_INVALIDO', MENSAJE_RANGO_MESES_INVALIDO, {
        desde,
        hasta,
      });
    }
    const [utilidades, pagos] = await Promise.all([
      this.utilidadesDesde(base.cuenta.cuenta_desde, mesActual),
      this.entregasDe(u.entregas, u, true),
    ]);
    return {
      disponible: true,
      ...armarEstadoCuenta({ base, utilidades, pagos, desde, hasta }),
    };
  }

  /**
   * Contexto de UN socio para las escrituras (alta/edición/baja de
   * entregas) y sus respuestas: base, utilidades (reutilizables dentro de
   * la MISMA petición: el mes en curso no se vuelve a calcular), entregas
   * vivas y su renglón. `validar` corre ANTES de calcular las utilidades
   * (lanza para rechazar). `fresco` (alta y corrección de entregas: el
   * candado del adelanto) recalcula los meses cerrados sin la memoria de
   * 10 min — un cobro o gasto tardío de un mes cerrado llega al candado y a
   * `saldo_snapshot_usd`. `null` si el socio no es de ningún avión ni tiene
   * cuenta ni entregas. Sin la migración ⇒ 503.
   */
  async contextoSocio(
    socioId: string,
    opts: {
      utilidadesPrevias?: ReadonlyArray<UtilidadMesSocios>;
      validar?: (base: SocioBase, aeronavesIds: ReadonlySet<string>) => void;
      fresco?: boolean;
    } = {},
  ): Promise<ContextoSocio | null> {
    const u = await this.lector.universo(socioId);
    if (u === SIN_MIGRACION) throw errorCuentaNoDisponible();
    const base = this.sociosBase(u).find((b) => b.socio.id === socioId);
    if (!base) return null;
    const aeronavesIds = new Set(
      u.sociosAeronave
        .filter((r) => r.socio_id === socioId)
        .map((r) => r.aeronave_id),
    );
    opts.validar?.(base, aeronavesIds);
    const mesActual = this.mesActual();
    const meses = mesesEntre(
      base.cuenta.cuenta_desde < mesActual
        ? base.cuenta.cuenta_desde
        : mesActual,
      mesActual,
    );
    const previas = new Map(
      (opts.utilidadesPrevias ?? []).map((x) => [x.mes, x]),
    );
    const utilidades = meses.every((m) => previas.has(m))
      ? meses
          .map((m) => previas.get(m))
          .filter((x): x is UtilidadMesSocios => x != null)
      : await this.utilidadesDesde(
          base.cuenta.cuenta_desde,
          mesActual,
          opts.fresco === true,
        );
    const pagos = await this.entregasDe(u.entregas, u, false);
    return {
      base,
      utilidades,
      aeronaves_ids: aeronavesIds,
      pagos,
      fila: filaCuentaSocio({ base, utilidades, pagos }),
    };
  }

  // =================================================================
  // Escritura
  // =================================================================

  /**
   * `PUT /v1/profit-sharing/socios/:socioId/cuenta`: arranque de la cuenta
   * (mes, no futuro, ≤ 36 meses atrás) + saldo inicial (USD, 2 decimales,
   * puede ser negativo) + notas. Sin fila ⇒ INSERT (created_by); con fila
   * ⇒ UPDATE (created_by se conserva). El socio debe estar en
   * `aeronave_socio` (400 `SOCIO_INVALIDO`). Responde su renglón del resumen.
   */
  async configurarCuenta(
    socioId: string,
    dto: ConfigurarCuentaSocioDto,
    actor: ActorCuenta,
  ): Promise<FilaCuentaSocio> {
    await this.assertDisponible();
    const v = validarCuentaDesde(dto.cuenta_desde, this.mesActual());
    if (!v.ok) throw bad(v.codigo, v.mensaje);
    if (!saldoInicialValido(dto.saldo_inicial_usd)) {
      throw bad('SALDO_INICIAL_INVALIDO', MENSAJE_SALDO_INICIAL_INVALIDO);
    }
    const notas = textoOpcional(dto.notas ?? null);
    if (notas != null && notas.length > NOTAS_CUENTA_MAX) {
      throw bad(
        'NOTAS_INVALIDAS',
        `Las notas de la cuenta son de máximo ${NOTAS_CUENTA_MAX} caracteres.`,
      );
    }
    const socioRows = await this.lector.sociosAeronave(socioId);
    if (socioRows.length === 0) {
      throw bad('SOCIO_INVALIDO', MENSAJE_SOCIO_INVALIDO, {
        socio_id: socioId,
      });
    }
    const valores = {
      cuenta_desde: `${v.mes}-01`,
      saldo_inicial_usd: Math.round(dto.saldo_inicial_usd * 100) / 100,
      notas,
      updated_by: actor.userId,
    };
    const actualizar = () =>
      this.sb
        .from(TABLA_REPARTO_CUENTA_SOCIO)
        .update(valores)
        .eq('socio_id', socioId)
        .select(COLS_REPARTO_CUENTA)
        .maybeSingle();
    let { data, error } = await actualizar();
    if (!error && !data) {
      const ins = await this.sb
        .from(TABLA_REPARTO_CUENTA_SOCIO)
        .insert({ socio_id: socioId, ...valores, created_by: actor.userId })
        .select(COLS_REPARTO_CUENTA)
        .single();
      data = ins.data;
      error = ins.error;
      // Carrera: otra persona la creó entre el UPDATE y el INSERT.
      if (error?.code === '23505') ({ data, error } = await actualizar());
    }
    if (error) {
      if (error.code === '23514' || error.code === '22003') {
        throw bad(
          'CUENTA_INVALIDA',
          'Algún dato de la cuenta no es válido (mes de arranque, saldo inicial o notas).',
          { tecnico: error.message },
        );
      }
      if (error.code === '23503') {
        throw bad('SOCIO_INVALIDO', MENSAJE_SOCIO_INVALIDO, {
          socio_id: socioId,
        });
      }
      throw new Error(error.message);
    }
    this.logger.log(
      `Cuenta del socio ${socioId} configurada por ${actor.userId}: desde ${v.mes}, saldo inicial ${valores.saldo_inicial_usd} USD`,
    );
    const ctx = await this.contextoSocio(socioId);
    if (!ctx) {
      throw bad('SOCIO_INVALIDO', MENSAJE_SOCIO_INVALIDO, {
        socio_id: socioId,
      });
    }
    return ctx.fila;
  }
}
