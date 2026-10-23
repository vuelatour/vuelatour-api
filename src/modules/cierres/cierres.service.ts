/**
 * CIERRE DE MES FORMAL (16-oct-2026, API 0.0.88, invariante 89, migración
 * `20261016000004_cierre_mes.sql`) — POR AVIÓN desde el 23-oct-2026 (API
 * 0.0.104, invariante 105, migración `20261023000001_cierre_mes_avion.sql`).
 *
 * Pedido del cliente (16-oct): «una opción para cerrar el mes que no es el
 * corriente (el anterior) y que los vuelos que aún no se cobren se marquen
 * en el balance y se muevan al siguiente mes hasta que se cobren y
 * completen». Pedido del 23-oct (capturas de /admin/reportes): «eliminar la
 * burbuja independiente de cierre de mes, y poner un botón de cierre de mes
 * individual en cada avión».
 *
 *  - `estado()`   GET  /v1/cierres                — estado de cada mes (y de
 *                                                    cada avión, `aviones[]`).
 *  - `previa()`   GET  /v1/cierres/:periodo/previa — qué pasaría al cerrar
 *                                                    (`?aeronave_id` = un avión).
 *  - `cerrar()`   POST /v1/cierres/:periodo       — cierra un avión
 *                                                    (`aeronave_id`) o toda la
 *                                                    flota abierta, y difiere.
 *  - `reabrir()`  POST /v1/cierres/:periodo/reabrir — revierte (solo ADMIN).
 *
 * MODELO POR AVIÓN (invariante 105): el cierre es una fila de
 * `cierre_mes_avion (periodo, aeronave_id)`. Cerrar un avión = congelar SU
 * reparto (snapshot), diferir SUS vuelos no cobrados al corte (solo los que
 * tocan a ese avión; `decisionDiferir` sigue siendo por VUELO entero) y
 * activar el candado 409 MES_CERRADO para las capturas que lo tocan. La fila
 * global `cierre_mes` es DERIVADA: se escribe CERRADO cuando el ÚLTIMO avión
 * ACTIVO del mes queda cerrado (CAS como siempre; snapshots = agregado de
 * las filas por avión) y pasa a REABIERTO cuando cualquier avión se reabre
 * con la flota cerrada. Así los lectores globales conservan «mes cerrado =
 * toda la flota activa cerrada». Multi-avión: el PRIMER avión que cierra
 * DECIDE por el vuelo (lo difiere entero, o lo deja «se queda» y los demás
 * lo ven en `vuelos_incluidos` con `decidido_por`). Reabrir A rebota
 * (OTRO_AVION_CERRADO) si un vuelo que A difirió lo comparte con otro avión
 * cerrado. Sin la migración por avión TODO responde como el 0.0.103 (cierre
 * global de toda la flota): esos caminos se conservan tal cual
 * (`cerrarFlotaLegado`, `reabrirLegado`).
 *
 * La DECISIÓN de qué vuelo pasa al mes siguiente NO vive aquí: es
 * `decisionDiferir` (common/mes-contable.util), evaluada por `compute(M)`
 * con su MISMA cadena de T.C. (`cierre.pendientes_que_pasarian`). Este
 * servicio solo ordena las precondiciones, escribe y avisa. El reparto que
 * se congela es `compute(M, { excluirVuelos })` — el mismo que da
 * `compute(M)` en vivo una vez escritos los diferimientos.
 *
 * Escritura «transaccional a mano» (PostgREST no tiene transacciones):
 * (1) fila del cierre con CAS (dos cierres a la vez no se pisan); (2) por
 * vuelo, `periodo_contable` con CAS + bitácora; si algo falla a la mitad,
 * se revierte lo hecho y la fila queda REABIERTO con el motivo «cierre
 * incompleto: …» (jamás un DELETE en caliente) ⇒ 500 CIERRE_INCOMPLETO,
 * reintentable. En el cierre de toda la flota (secuencial, por matrícula)
 * los aviones ya cerrados se QUEDAN cerrados y el error trae
 * `details.cerrados`.
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  CLAVES_BLOQUEANTES_PRECIERRE,
  ProfitSharingService,
} from '../profit-sharing/profit-sharing.service';
import { NotificationsService } from '../realtime/notifications.service';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import {
  cierreMesDisponible,
  cierrePorAvionDisponible,
  errorCierreNoDisponible,
  errorCierrePorAvionNoDisponible,
} from '../../common/cierre-mes-disponible.util';
import {
  CIERRE_MES_COLS,
  leerCierresMes,
  leerCierresMesAvion,
  olvidarCierres,
  participantesDeVuelos,
  type CierreAvionLeido,
  type CierreMesLeido,
  type UsuarioCierre,
} from '../../common/cierre-mes.lector';
import {
  estadoMesDerivado,
  etiquetaMes,
  etiquetaMesMinuscula,
  leyendaPasaA,
  leyendaSeQueda,
  leyendaSeQuedaDecidido,
  MES_PRIMER_CIERRE,
  mesAnteriorDe,
  mesSiguienteDe,
  motivoNoCerrable,
  periodoContableDe,
  rangoDelMes,
  textoMesAnteriorAbierto,
  textoMesEnCurso,
  textoMesSiguienteCerrado,
  textoOtroAvionCerrado,
  type EstadoMesFlota,
  type MotivoDiferir,
  type MotivoNoCerrable,
} from '../../common/mes-contable.util';
import { avionDelGasto } from '../../common/participacion-aeronave.util';
import { hoyCancun } from '../../common/fecha-cancun.util';
import { inicioOficialDe } from '../../common/inicio-oficial.util';
import { mensajePeriodoAntesDelInicio } from '../../common/inicio-oficial.util';
import { consecutivosClienteDeVuelos } from '../../common/clave-cliente-lectura.util';
import { utilidadMesDesdeAviones } from '../profit-sharing/reparto-cuenta.util';
import type {
  CierreRepartoBloque,
  CierreRepartoVuelo,
} from '../profit-sharing/profit-sharing.service';
import {
  validarPeriodoCierre,
  type CerrarMesDto,
  type ReabrirMesDto,
} from './dto/cierres.dto';

/** Roles que CIERRAN un mes. */
export const ROLES_CIERRAN_MES = [Rol.ADMIN, Rol.FACTURACION] as const;
/** Roles que REABREN un mes. */
export const ROLES_REABREN_MES = [Rol.ADMIN] as const;

/** Los 6 renglones del pre-cierre que bloquean (`listo`). */
export { CLAVES_BLOQUEANTES_PRECIERRE };

/**
 * Bloqueantes del pre-cierre SIN avión (invariante 105, regla 3): bloquean a
 * TODOS los aviones. Los demás de `CLAVES_BLOQUEANTES_PRECIERRE`
 * (`vuelos_sin_completar`, `tacos_en_revision`, `cobros_sin_tc`,
 * `gastos_sin_tc`) son ATRIBUIBLES: bloquean solo al avión al que pertenecen.
 */
export const CLAVES_BLOQUEANTES_SIN_AVION = [
  'combustible_sin_avion',
  'permisos_sin_avion',
  'nomina_sin_repartir',
  'gastos_por_pagar',
] as const;

/** Tope de meses que lista `GET /v1/cierres` (desde el inicio oficial). */
const MAX_MESES_LISTA = 36;

/** Estado persistido de un mes (fila global) o de un avión. */
export type EstadoMes = 'ABIERTO' | 'CERRADO' | 'REABIERTO';

/** Un avión en `GET /v1/cierres` / respuestas de cerrar y reabrir (invariante 105). */
export interface CierreAvionSalida {
  aeronave_id: string;
  matricula: string;
  modelo: string | null;
  activa: boolean;
  estado: EstadoMes;
  cerrado_at: string | null;
  cerrado_por: UsuarioCierre | null;
  reabierto_at: string | null;
  reabierto_por: UsuarioCierre | null;
  reabierto_motivo: string | null;
  version: number;
  puede_cerrar: boolean;
  motivo_no_cerrable: MotivoNoCerrable | null;
  totales: Record<string, unknown> | null;
}

export interface MesCierreSalida {
  periodo: string;
  /** Flota: ABIERTO | PARCIAL | CERRADO | REABIERTO (PARCIAL solo por avión). */
  estado: EstadoMesFlota;
  cerrado_at: string | null;
  cerrado_por: UsuarioCierre | null;
  reabierto_at: string | null;
  reabierto_por: UsuarioCierre | null;
  reabierto_motivo: string | null;
  version: number;
  puede_cerrar: boolean;
  motivo_no_cerrable: MotivoNoCerrable | null;
  totales: Record<string, unknown> | null;
  /** CIERRE POR AVIÓN (invariante 105): solo con la migración por avión. */
  aviones_activos?: number;
  aviones_cerrados?: number;
  aviones?: CierreAvionSalida[];
}

/** Otro avión participante de un vuelo multi-avión en la previa. */
export interface OtroAvionPrevia {
  aeronave_id: string;
  matricula: string | null;
  estado: EstadoMes;
}

export interface VueloDiferidoSalida {
  id: string;
  folio: number | null;
  /**
   * CLAVES SIN APODO (23-oct-2026, API 0.0.105, invariante 106): ya no viaja
   * `clave_cliente` (el panel pinta folio + cliente); en su lugar el
   * CONSECUTIVO del vuelo dentro de su cliente (null sin la migración) y la
   * RUTA («CUN-HOL-CUN», la de las listas del reparto).
   */
  consecutivo_cliente: number | null;
  cliente: string | null;
  ruta: string | null;
  aeronave: { id: string; matricula: string | null } | null;
  fecha_vuelo: string | null;
  venta_usd: number;
  cobrado_usd: number;
  por_cobrar_usd: number;
  cobrado_posterior_usd: number;
  /** Día Cancún del último cobro después del corte (ADITIVO 16-oct-2026). */
  fecha_cobro_posterior: string | null;
  motivo: MotivoDiferir | null;
  destino?: string;
  origen?: string;
  leyenda: string;
  /** CIERRE POR AVIÓN (invariante 105): solo con la migración por avión. */
  multi_avion?: boolean;
  otros_aviones?: OtroAvionPrevia[];
  /** «Se queda» decidido al cerrar OTRO avión (no modificable desde este). */
  decidido_por?: { aeronave_id: string; matricula: string | null };
}

export interface BloqueantePrevia {
  clave: string;
  titulo: string;
  count: number;
  /**
   * ADITIVO (revisión P3, 19-oct-2026): el renglón NO se pudo leer. Es
   * bloqueante aunque `count` sea 0 (no se verificó).
   */
  lectura_fallida?: true;
  /** ADITIVO (revisión P2): los `ids` de NÓMINA de `gastos_por_pagar`. */
  ids_nomina?: string[];
  ids?: string[];
}

/** Lo que dice el 409 de un bloqueante que no se pudo leer. */
export const TEXTO_BLOQUEANTE_SIN_VERIFICAR = 'no se pudo verificar';

/** «Título: 3» o «Título: no se pudo verificar» (409 PRECIERRE_NO_LISTO). */
export function textoBloqueantePrevia(b: BloqueantePrevia): string {
  return `${b.titulo}: ${b.lectura_fallida ? TEXTO_BLOQUEANTE_SIN_VERIFICAR : b.count}`;
}

export interface RepartoAvionPrevia {
  aeronave_id: string;
  matricula: string;
  saldo_usd: number;
  cobrado_usd: number;
  gastos_usd: number;
}

export interface TotalesPrevia {
  vuelos: number;
  completados: number;
  cancelados: number;
  pasan: number;
  pasan_venta_usd: number;
  pasan_cobrado_al_corte_usd: number;
  pasan_por_cobrar_usd: number;
  pasan_cobrado_posterior_usd: number;
  pasan_mxn: number;
  pasan_usd_nativo: number;
  se_quedan_en_cero: number;
  /** INCLUIR EN EL MES (21-oct-2026): cuántos de «pasan» se quedan por decisión de la oficina. */
  incluidos: number;
}

export interface PreviaCierre {
  periodo: string;
  /** Del avión (`?aeronave_id`) o de la flota. */
  estado: EstadoMesFlota;
  listo: boolean;
  motivo_no_cerrable: MotivoNoCerrable | null;
  texto_no_cerrable: string | null;
  bloqueantes: BloqueantePrevia[];
  vuelos_que_pasan: VueloDiferidoSalida[];
  vuelos_que_vienen: VueloDiferidoSalida[];
  /**
   * INCLUIR EN EL MES (21-oct-2026): los de «pasan» que la oficina marcó
   * (`?incluir=` / `incluir_vuelos`) y se QUEDAN en el mes; ya no están en
   * `vuelos_que_pasan`. Leyenda «Se queda en …». Sin marcados: []. Por avión
   * (invariante 105) también los decididos al cerrar OTRO avión
   * (`decidido_por`).
   */
  vuelos_incluidos: VueloDiferidoSalida[];
  totales: TotalesPrevia;
  reparto: {
    antes: RepartoAvionPrevia[];
    despues: RepartoAvionPrevia[];
  } | null;
  /** CIERRE POR AVIÓN (invariante 105): solo con la migración por avión. */
  aeronave?: { id: string; matricula: string; modelo: string | null } | null;
  aviones_alcance?: Array<{ aeronave_id: string; matricula: string }>;
  /** Informativo: bloqueantes que frenan a OTROS aviones, no a este alcance. */
  bloqueantes_otros_aviones?: BloqueantePrevia[];
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

type ResultadoCompute = Awaited<ReturnType<ProfitSharingService['compute']>>;
type AvionCompute = ResultadoCompute['aviones'][number];

/** Fila de `aeronave` que el cierre por avión necesita. */
interface AeronaveFila {
  id: string;
  matricula: string;
  modelo: string | null;
  activa: boolean;
}

/** Flota + filas por avión (solo con la migración por avión). */
interface ContextoFlota {
  aeronaves: AeronaveFila[];
  filasAvion: CierreAvionLeido[];
}

/** Qué aviones cierra una previa / un POST. */
interface AlcanceCierre {
  /** El avión pedido (null = toda la flota abierta). */
  aeronave: AeronaveFila | null;
  /** Orden de matrícula. */
  aviones: AeronaveFila[];
}

/** Un vuelo «se queda» decidido al cerrar OTRO avión (regla 2). */
interface VueloForzado {
  vuelo: CierreRepartoVuelo;
  decidido_por: { aeronave_id: string; matricula: string | null };
}

interface ConteosVuelos {
  vuelos: number;
  completados: number;
  cancelados: number;
  en_cero: number;
}

interface VueloMesRow {
  id: string;
  estado: string;
  monto_total_usd: unknown;
  aeronave_id: string | null;
  es_externo: boolean | null;
}

/** Item crudo del pre-cierre (lo que `preCierre().items` trae). */
interface ItemPrecierreCrudo {
  clave: string;
  titulo?: string;
  count?: unknown;
  lectura_fallida?: unknown;
  ids?: unknown;
  ids_nomina?: unknown;
  vuelos?: unknown;
  tramos?: unknown;
}

/** Cuerpo de un 409/400 estructurado del cierre. */
function conflicto(
  error: string,
  message: string,
  details?: Record<string, unknown>,
): ConflictException {
  return new ConflictException({
    message,
    error,
    ...(details ? { details } : {}),
  });
}

const porMatricula = (a: AeronaveFila, b: AeronaveFila): number =>
  a.matricula.localeCompare(b.matricula, 'es') || a.id.localeCompare(b.id);

const usd = (n: number): string =>
  `US$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

@Injectable()
export class CierresService {
  private readonly logger = new Logger(CierresService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly profitSharing: ProfitSharingService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly configuracion?: ConfiguracionService,
  ) {}

  /** Reloj inyectable (specs): decide el mes EN CURSO (hora Cancún). */
  ahora: () => Date = () => new Date();

  private get sb() {
    return this.supabase.service;
  }

  private mesEnCurso(): string {
    return hoyCancun(this.ahora()).slice(0, 7);
  }

  private async mesInicio(): Promise<{ mes: string; inicio: string | null }> {
    const inicio = await inicioOficialDe(this.configuracion);
    return { mes: inicio ? inicio.slice(0, 7) : MES_PRIMER_CIERRE, inicio };
  }

  /** 400 PERIODO_INVALIDO si no es 'YYYY-MM' (fuente: el DTO). */
  static validarPeriodo(periodo: string): string {
    return validarPeriodoCierre(periodo);
  }

  private async assertDisponible(): Promise<void> {
    if (!(await cierreMesDisponible(this.sb))) throw errorCierreNoDisponible();
  }

  private assertDesdeInicio(
    periodo: string,
    inicio: string | null,
    mesIni: string,
  ) {
    if (periodo < mesIni) {
      throw new BadRequestException({
        message: inicio
          ? mensajePeriodoAntesDelInicio(inicio)
          : `${etiquetaMes(periodo)} es anterior al primer mes que se cierra en el sistema (${etiquetaMes(mesIni)}).`,
        error: 'PERIODO_ANTES_DEL_INICIO',
        details: { inicio: inicio ?? `${mesIni}-01` },
      });
    }
  }

  // ===================================================================
  // Flota y filas por avión (invariante 105)
  // ===================================================================

  /** Toda la flota (activa o no), orden de matrícula. */
  private async leerAeronaves(): Promise<AeronaveFila[]> {
    const { data, error } = await this.sb
      .from('aeronave')
      .select('id, matricula, modelo, activa')
      .order('matricula', { ascending: true });
    if (error) throw new Error(`Aeronaves: ${error.message}`);
    return ((data ?? []) as Array<Record<string, unknown>>)
      .map((a) => ({
        id: String(a.id),
        matricula: typeof a.matricula === 'string' ? a.matricula : '',
        modelo: typeof a.modelo === 'string' ? a.modelo : null,
        activa: a.activa !== false,
      }))
      .sort(porMatricula);
  }

  /** null = sin la migración por avión (todo como el 0.0.103). */
  private async contextoFlota(): Promise<ContextoFlota | null> {
    if (!(await cierrePorAvionDisponible(this.sb))) return null;
    const [aeronaves, filasAvion] = await Promise.all([
      this.leerAeronaves(),
      leerCierresMesAvion(this.sb),
    ]);
    return { aeronaves, filasAvion };
  }

  private filaAvion(
    ctx: ContextoFlota,
    mes: string,
    aeronaveId: string,
  ): CierreAvionLeido | null {
    return (
      ctx.filasAvion.find(
        (f) => f.periodo === mes && f.aeronave_id === aeronaveId,
      ) ?? null
    );
  }

  /**
   * Estado de un avión en un mes: su fila; sin fila, el de la fila global
   * (CERRADO = toda la flota cerrada; un avión sin fila en un mes cerrado
   * está cerrado por el candado global).
   */
  private estadoAvion(
    fa: CierreAvionLeido | null,
    global: CierreMesLeido | null,
  ): EstadoMes {
    if (fa) return fa.estado;
    return global?.estado === 'CERRADO' ? 'CERRADO' : 'ABIERTO';
  }

  /** Meses en los que ESE avión está cerrado (su fila o la global). */
  private mesesCerradosDelAvion(
    ctx: ContextoFlota,
    filas: CierreMesLeido[],
    aeronaveId: string,
  ): Set<string> {
    const out = new Set<string>(
      filas.filter((f) => f.estado === 'CERRADO').map((f) => f.periodo),
    );
    for (const f of ctx.filasAvion) {
      if (f.aeronave_id === aeronaveId && f.estado === 'CERRADO') {
        out.add(f.periodo);
      }
    }
    return out;
  }

  /** `aviones[]` de un mes y su resumen (invariante 105). */
  private avionesDelMes(
    mes: string,
    global: CierreMesLeido | null,
    filas: CierreMesLeido[],
    ctx: ContextoFlota,
    mesIni: string,
    enCurso: string,
  ): {
    aviones: CierreAvionSalida[];
    estado: EstadoMesFlota;
    aviones_activos: number;
    aviones_cerrados: number;
    puede_cerrar: boolean;
    motivo_no_cerrable: MotivoNoCerrable | null;
  } {
    const filasMes = ctx.filasAvion.filter((f) => f.periodo === mes);
    const aviones: CierreAvionSalida[] = ctx.aeronaves
      .filter((a) => a.activa || filasMes.some((f) => f.aeronave_id === a.id))
      .map((a) => {
        const fa = filasMes.find((f) => f.aeronave_id === a.id) ?? null;
        const estado = this.estadoAvion(fa, global);
        const sellos = fa ?? (estado === 'CERRADO' ? global : null);
        const motivo = motivoNoCerrable({
          mes,
          mesEnCurso: enCurso,
          mesInicio: mesIni,
          cerrados: this.mesesCerradosDelAvion(ctx, filas, a.id),
        });
        return {
          aeronave_id: a.id,
          matricula: a.matricula,
          modelo: a.modelo,
          activa: a.activa,
          estado,
          cerrado_at: sellos?.cerrado_at ?? null,
          cerrado_por: sellos?.cerrado_por ?? null,
          reabierto_at: fa?.reabierto_at ?? null,
          reabierto_por: fa?.reabierto_por ?? null,
          reabierto_motivo: fa?.reabierto_motivo ?? null,
          version: fa?.version ?? 0,
          puede_cerrar: motivo == null,
          motivo_no_cerrable: motivo,
          totales: fa?.totales ?? null,
        };
      });
    const activos = aviones.filter((a) => a.activa);
    const puede = activos.some((a) => a.puede_cerrar);
    let motivo: MotivoNoCerrable | null = null;
    if (!puede) {
      motivo = motivoNoCerrable({
        mes,
        mesEnCurso: enCurso,
        mesInicio: mesIni,
        cerrados: new Set(
          filas.filter((f) => f.estado === 'CERRADO').map((f) => f.periodo),
        ),
      });
      if (motivo == null || motivo === 'MES_ANTERIOR_ABIERTO') {
        const abierto = activos.find((a) => a.estado !== 'CERRADO');
        motivo = abierto
          ? (abierto.motivo_no_cerrable ?? 'MES_ANTERIOR_ABIERTO')
          : 'YA_CERRADO';
      }
    }
    return {
      aviones,
      estado: estadoMesDerivado({ global, aviones: filasMes }),
      aviones_activos: activos.length,
      aviones_cerrados: activos.filter((a) => a.estado === 'CERRADO').length,
      puede_cerrar: puede,
      motivo_no_cerrable: motivo,
    };
  }

  // ===================================================================
  // GET /v1/cierres
  // ===================================================================

  async estado(): Promise<{
    disponible: boolean;
    por_avion: boolean;
    inicio_oficial: string | null;
    mes_en_curso: string;
    meses: MesCierreSalida[];
    siguiente_a_cerrar: string | null;
  }> {
    const { mes: mesIni, inicio } = await this.mesInicio();
    const enCurso = this.mesEnCurso();
    if (!(await cierreMesDisponible(this.sb))) {
      return {
        disponible: false,
        por_avion: false,
        inicio_oficial: inicio,
        mes_en_curso: enCurso,
        meses: [],
        siguiente_a_cerrar: null,
      };
    }
    const [filas, ctx] = await Promise.all([
      leerCierresMes(this.sb),
      this.contextoFlota(),
    ]);
    const porMes = new Map(filas.map((f) => [f.periodo, f]));
    const cerrados = new Set(
      filas.filter((f) => f.estado === 'CERRADO').map((f) => f.periodo),
    );
    const meses: MesCierreSalida[] = [];
    for (
      let m = mesIni;
      m <= enCurso && meses.length < MAX_MESES_LISTA;
      m = mesSiguienteDe(m)
    ) {
      const f = porMes.get(m) ?? null;
      if (!ctx) {
        const motivo = motivoNoCerrable({
          mes: m,
          mesEnCurso: enCurso,
          mesInicio: mesIni,
          cerrados,
        });
        meses.push(this.salidaMes(m, f, motivo));
        continue;
      }
      meses.push(this.salidaMesPorAvion(m, f, filas, ctx, mesIni, enCurso));
    }
    return {
      disponible: true,
      por_avion: ctx != null,
      inicio_oficial: inicio,
      mes_en_curso: enCurso,
      meses,
      siguiente_a_cerrar: meses.find((x) => x.puede_cerrar)?.periodo ?? null,
    };
  }

  private salidaMes(
    mes: string,
    f: CierreMesLeido | null,
    motivo: MotivoNoCerrable | null,
  ): MesCierreSalida {
    return {
      periodo: mes,
      estado: f?.estado ?? 'ABIERTO',
      cerrado_at: f?.cerrado_at ?? null,
      cerrado_por: f?.cerrado_por ?? null,
      reabierto_at: f?.reabierto_at ?? null,
      reabierto_por: f?.reabierto_por ?? null,
      reabierto_motivo: f?.reabierto_motivo ?? null,
      version: f?.version ?? 0,
      puede_cerrar: motivo == null,
      motivo_no_cerrable: motivo,
      totales: f?.totales ?? null,
    };
  }

  private salidaMesPorAvion(
    mes: string,
    f: CierreMesLeido | null,
    filas: CierreMesLeido[],
    ctx: ContextoFlota,
    mesIni: string,
    enCurso: string,
  ): MesCierreSalida {
    const r = this.avionesDelMes(mes, f, filas, ctx, mesIni, enCurso);
    return {
      periodo: mes,
      estado: r.estado,
      cerrado_at: f?.cerrado_at ?? null,
      cerrado_por: f?.cerrado_por ?? null,
      reabierto_at: f?.reabierto_at ?? null,
      reabierto_por: f?.reabierto_por ?? null,
      reabierto_motivo: f?.reabierto_motivo ?? null,
      version: f?.version ?? 0,
      puede_cerrar: r.puede_cerrar,
      motivo_no_cerrable: r.motivo_no_cerrable,
      totales: f?.totales ?? null,
      aviones_activos: r.aviones_activos,
      aviones_cerrados: r.aviones_cerrados,
      aviones: r.aviones,
    };
  }

  /** El mes (flota, por avión) tal como lo reporta `GET /v1/cierres`, releído. */
  private async mesReleido(periodo: string): Promise<MesCierreSalida> {
    const { mes: mesIni } = await this.mesInicio();
    const [filas, ctx] = await Promise.all([
      leerCierresMes(this.sb),
      this.contextoFlota(),
    ]);
    const f = filas.find((x) => x.periodo === periodo) ?? null;
    if (!ctx) {
      return this.salidaMes(
        periodo,
        f,
        motivoNoCerrable({
          mes: periodo,
          mesEnCurso: this.mesEnCurso(),
          mesInicio: mesIni,
          cerrados: new Set(
            filas.filter((x) => x.estado === 'CERRADO').map((x) => x.periodo),
          ),
        }),
      );
    }
    return this.salidaMesPorAvion(
      periodo,
      f,
      filas,
      ctx,
      mesIni,
      this.mesEnCurso(),
    );
  }

  /** El alcance de una previa / un cierre (invariante 105). */
  private alcanceDe(
    ctx: ContextoFlota,
    filas: CierreMesLeido[],
    periodo: string,
    aeronaveId: string | undefined,
  ): AlcanceCierre {
    if (aeronaveId) {
      const a = ctx.aeronaves.find((x) => x.id === aeronaveId);
      if (!a) {
        throw new NotFoundException({
          message: 'Ese avión no existe.',
          error: 'AERONAVE_NO_EXISTE',
          details: { aeronave_id: aeronaveId },
        });
      }
      return { aeronave: a, aviones: [a] };
    }
    const global = filas.find((f) => f.periodo === periodo) ?? null;
    const abiertos = ctx.aeronaves
      .filter(
        (a) =>
          a.activa &&
          this.estadoAvion(this.filaAvion(ctx, periodo, a.id), global) !==
            'CERRADO',
      )
      .sort(porMatricula);
    return { aeronave: null, aviones: abiertos };
  }

  // ===================================================================
  // GET /v1/cierres/:periodo/previa
  // ===================================================================

  async previa(
    periodo: string,
    opts: { incluir?: string[]; aeronaveId?: string } = {},
  ): Promise<PreviaCierre> {
    CierresService.validarPeriodo(periodo);
    await this.assertDisponible();
    const { mes: mesIni, inicio } = await this.mesInicio();
    this.assertDesdeInicio(periodo, inicio, mesIni);
    const [filas, ctx] = await Promise.all([
      leerCierresMes(this.sb),
      this.contextoFlota(),
    ]);
    if (!ctx && opts.aeronaveId) throw errorCierrePorAvionNoDisponible();
    const alcance = ctx
      ? this.alcanceDe(ctx, filas, periodo, opts.aeronaveId)
      : null;
    const p = await this.prepararCierre(
      periodo,
      filas,
      mesIni,
      new Set(opts.incluir ?? []),
      ctx,
      alcance,
    );
    return p.previa;
  }

  /**
   * Arma la previa (y lo que el cierre escribe): pre-cierre, compute vivo
   * (la decisión), compute simulado sin los diferidos y los totales. Con
   * `ctx`/`alcance` (invariante 105) todo se limita a los vuelos que TOCAN
   * el alcance (participación por avión) y los bloqueantes se atribuyen.
   */
  private async prepararCierre(
    periodo: string,
    filas: CierreMesLeido[],
    mesIni: string,
    incluir: ReadonlySet<string> = new Set(),
    ctx: ContextoFlota | null = null,
    alcance: AlcanceCierre | null = null,
  ): Promise<{
    previa: PreviaCierre;
    /** Los que PASAN (candidatos − incluidos − forzados). */
    diferidos: CierreRepartoVuelo[];
    /** INCLUIR EN EL MES (21-oct-2026): los candidatos que se quedan por la oficina. */
    incluidos: CierreRepartoVuelo[];
    /** Los que se quedan porque OTRO avión ya lo decidió (regla 2). */
    forzados: VueloForzado[];
    /** Ids de `incluir` que ya no están entre los candidatos (lista rancia). */
    desconocidos: string[];
    despues: ResultadoCompute | null;
    precierre: { listo: boolean; items: BloqueantePrevia[] };
    /** vuelo ⇒ aviones participantes (vacío sin la migración por avión). */
    participantes: Map<string, string[]>;
    /** Conteos de los vuelos del mes por avión del alcance. */
    conteosAvion: Map<string, ConteosVuelos>;
    /** Motivo por avión del alcance (null = puede cerrar). */
    motivosAvion: Map<string, MotivoNoCerrable | null>;
    /** Bloqueantes que tocan a cada avión del alcance. */
    bloqueantesAvion: Map<string, BloqueantePrevia[]>;
  }> {
    const { desde, hasta } = rangoDelMes(periodo);
    const fila = filas.find((f) => f.periodo === periodo) ?? null;
    const cerrados = new Set(
      filas.filter((f) => f.estado === 'CERRADO').map((f) => f.periodo),
    );
    const pre = await this.profitSharing.preCierre({ desde, hasta });
    const itemsCrudos = pre.items as unknown as ItemPrecierreCrudo[];
    const items = itemsCrudos.map(
      (i): BloqueantePrevia => ({
        clave: String(i.clave),
        titulo: String(i.titulo ?? i.clave),
        count: Number(i.count) || 0,
        // Revisión P3 (19-oct-2026): un renglón que no se pudo leer viaja
        // marcado (el pre-cierre ya lo cuenta en `listo: false`).
        ...(i.lectura_fallida === true
          ? { lectura_fallida: true as const }
          : {}),
        ...(Array.isArray(i.ids_nomina)
          ? { ids_nomina: i.ids_nomina as string[] }
          : {}),
        ...(Array.isArray(i.ids) ? { ids: i.ids as string[] } : {}),
      }),
    );
    // Bloquea con count > 0 o sin verificar (`lectura_fallida`, P3).
    const bloqueantesTodos = items.filter(
      (i) =>
        (CLAVES_BLOQUEANTES_PRECIERRE as readonly string[]).includes(i.clave) &&
        (i.count > 0 || i.lectura_fallida === true),
    );
    const vivo = await this.profitSharing.compute({ desde, hasta });
    const bloque: CierreRepartoBloque | null =
      'cierre' in vivo && vivo.cierre ? vivo.cierre : null;
    const destinoMes = mesSiguienteDe(periodo);
    const conteos = await this.conteosDelMes(desde, hasta);
    const vienenTodos = bloque?.diferidos_entran ?? [];

    // ===== CIERRE POR AVIÓN (invariante 105): participación y alcance =====
    const alcanceIds = new Set((alcance?.aviones ?? []).map((a) => a.id));
    const candidatosTodos =
      fila?.estado === 'CERRADO' ? [] : (bloque?.pendientes_que_pasarian ?? []);
    let participantes = new Map<string, string[]>();
    let bloqueantes = bloqueantesTodos;
    let bloqueantesOtros: BloqueantePrevia[] = [];
    const bloqueantesAvion = new Map<string, BloqueantePrevia[]>();
    const conteosAvion = new Map<string, ConteosVuelos>();
    const motivosAvion = new Map<string, MotivoNoCerrable | null>();
    let candidatos = candidatosTodos;
    let vienen = vienenTodos;
    const forzados: VueloForzado[] = [];
    const toca = (vueloId: string, principal: string | null): boolean => {
      const p = participantes.get(vueloId) ?? (principal ? [principal] : []);
      return p.some((id) => alcanceIds.has(id));
    };
    if (ctx && alcance) {
      // Participación de TODOS los vuelos del mes (+ los que nombran los
      // bloqueantes atribuibles): una lectura de escalas.
      const idsBloqueantes = this.vuelosDeItems(
        itemsCrudos.filter((i) =>
          bloqueantesTodos.some((b) => b.clave === i.clave),
        ),
      );
      const conocidos = new Map(conteos.filas.map((v) => [v.id, v]));
      const extra = idsBloqueantes.filter((id) => !conocidos.has(id));
      const extraRows = extra.length > 0 ? await this.vuelosBasicos(extra) : [];
      participantes = await participantesDeVuelos(this.sb, [
        ...conteos.filas,
        ...extraRows,
      ]);
      // Bloqueantes: sin avión ⇒ a todos; atribuibles ⇒ a sus aviones.
      const atrib = await this.atribuirBloqueantes(
        itemsCrudos,
        bloqueantesTodos,
        participantes,
      );
      for (const a of alcance.aviones) {
        bloqueantesAvion.set(a.id, atrib.paraAviones(new Set([a.id])).propios);
      }
      const paraAlcance = atrib.paraAviones(alcanceIds);
      bloqueantes = paraAlcance.propios;
      bloqueantesOtros = paraAlcance.otros;
      // Vuelos del alcance.
      candidatos = candidatosTodos.filter((d) => toca(d.id, d.aeronave_id));
      vienen = vienenTodos.filter((d) => toca(d.id, d.aeronave_id));
      // «Se queda» decidido al cerrar OTRO avión (regla 2): el reparto los
      // trae aparte (`decididos_se_quedan`); los que tocan el alcance quedan
      // FORZADOS (no se difieren ni se des-incluyen desde aquí).
      for (const d of fila?.estado === 'CERRADO'
        ? []
        : (bloque?.decididos_se_quedan ?? [])) {
        if (!toca(d.id, d.aeronave_id) || !d.decidido_por) continue;
        if (alcanceIds.has(d.decidido_por.aeronave_id)) continue;
        forzados.push({ vuelo: d, decidido_por: d.decidido_por });
      }
      // Conteos y motivo por avión del alcance.
      for (const a of alcance.aviones) {
        const mios = conteos.filas.filter((v) =>
          (participantes.get(v.id) ?? []).includes(a.id),
        );
        conteosAvion.set(a.id, this.conteosDe(mios));
        motivosAvion.set(
          a.id,
          motivoNoCerrable({
            mes: periodo,
            mesEnCurso: this.mesEnCurso(),
            mesInicio: mesIni,
            cerrados: this.mesesCerradosDelAvion(ctx, filas, a.id),
            listo: (bloqueantesAvion.get(a.id) ?? []).length === 0,
          }),
        );
      }
    }
    const listo = ctx && alcance ? bloqueantes.length === 0 : pre.listo;
    let motivo: MotivoNoCerrable | null;
    if (ctx && alcance) {
      if (alcance.aviones.length === 0) {
        motivo = 'YA_CERRADO';
      } else {
        motivo =
          alcance.aviones
            .map((a) => motivosAvion.get(a.id) ?? null)
            .find((m) => m != null) ?? null;
      }
    } else {
      motivo = motivoNoCerrable({
        mes: periodo,
        mesEnCurso: this.mesEnCurso(),
        mesInicio: mesIni,
        cerrados,
        listo: pre.listo,
      });
    }

    // INCLUIR EN EL MES (21-oct-2026): de los que pasarían (`candidatos`, la
    // lista completa que vio el diálogo), los marcados por la oficina se
    // QUEDAN. Solo COBRO_POSTERIOR (ya cobrados después del corte): un vuelo
    // sin cobrar no se puede quedar (400); un id que ya no es candidato se
    // reporta (`desconocidos`) y `cerrar` lo trata como lista rancia.
    const forzadosIds = new Set(forzados.map((f) => f.vuelo.id));
    const incluidos = candidatos.filter(
      (d) => incluir.has(d.id) && !forzadosIds.has(d.id),
    );
    for (const d of incluidos) {
      if (d.motivo !== 'COBRO_POSTERIOR') {
        throw new BadRequestException({
          message: `El vuelo #${d.folio ?? '?'} no se puede quedar en ${etiquetaMesMinuscula(periodo)}: no está cobrado al cierre (${leyendaPasaA(destinoMes, d)}). Solo se quedan los cobrados después del corte.`,
          error: 'INCLUIR_VUELO_NO_COBRADO',
          details: { vuelo_id: d.id, folio: d.folio, motivo: d.motivo },
        });
      }
    }
    const desconocidos = [...incluir].filter(
      (id) =>
        !candidatos.some((d) => d.id === id) &&
        !forzados.some((f) => f.vuelo.id === id),
    );
    const diferidos = candidatos.filter(
      (d) => !incluir.has(d.id) && !forzadosIds.has(d.id),
    );
    const despues =
      diferidos.length > 0
        ? await this.profitSharing
            .compute(
              { desde, hasta },
              { excluirVuelos: diferidos.map((d) => d.id) },
            )
            .catch((e: unknown) => {
              this.logger.warn(
                `previa ${periodo}: reparto simulado falló: ${e instanceof Error ? e.message : String(e)}`,
              );
              return null;
            })
        : vivo;
    // CONSECUTIVO del vuelo por cliente (invariante 106): best-effort, todo
    // o nada (sin la migración, null en cada vuelo de la previa).
    const [consecutivos, nativos] = await Promise.all([
      consecutivosClienteDeVuelos(this.sb, [
        ...diferidos.map((d) => d.id),
        ...vienen.map((d) => d.id),
      ]),
      this.cobrosNativos(diferidos.map((d) => d.id)),
    ]);
    const matriculaDe = (id: string): string | null =>
      ctx?.aeronaves.find((a) => a.id === id)?.matricula ?? null;
    const otrosAvionesDe = (d: CierreRepartoVuelo): OtroAvionPrevia[] => {
      const p = participantes.get(d.id) ?? [];
      const excluir = alcance?.aeronave ? alcance.aeronave.id : d.aeronave_id;
      return p
        .filter((id) => id !== excluir)
        .map((id) => ({
          aeronave_id: id,
          matricula: matriculaDe(id),
          estado: this.estadoAvion(
            ctx ? this.filaAvion(ctx, periodo, id) : null,
            fila,
          ),
        }));
    };
    const salida = (d: CierreRepartoVuelo): VueloDiferidoSalida => ({
      id: d.id,
      folio: d.folio,
      consecutivo_cliente: consecutivos.get(d.id) ?? null,
      cliente: d.cliente,
      ruta: d.ruta ?? null,
      aeronave: d.aeronave_id
        ? { id: d.aeronave_id, matricula: d.matricula }
        : null,
      fecha_vuelo: d.fecha_vuelo,
      venta_usd: d.venta_usd,
      cobrado_usd: d.cobrado_usd,
      por_cobrar_usd: d.por_cobrar_usd,
      cobrado_posterior_usd: d.cobrado_posterior_usd ?? 0,
      fecha_cobro_posterior: d.fecha_cobro_posterior ?? null,
      motivo: d.motivo ?? null,
      ...(d.destino ? { destino: d.destino } : {}),
      ...(d.origen ? { origen: d.origen } : {}),
      leyenda: d.destino ? leyendaPasaA(d.destino, d) : d.leyenda,
      ...(ctx && alcance
        ? {
            multi_avion: (participantes.get(d.id) ?? []).length > 1,
            otros_aviones: otrosAvionesDe(d),
          }
        : {}),
    });
    const pasan = diferidos.map(salida);
    const seQueda = (d: CierreRepartoVuelo): VueloDiferidoSalida => {
      // `destino` se descarta a propósito (la leyenda «se queda» no lo lleva).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { destino: _destino, ...sin } = salida(d);
      return { ...sin, leyenda: leyendaSeQueda(periodo, destinoMes, d) };
    };
    const seQuedaForzado = (f: VueloForzado): VueloDiferidoSalida => {
      const base = seQueda(f.vuelo);
      return {
        ...base,
        leyenda: leyendaSeQuedaDecidido(
          periodo,
          destinoMes,
          f.vuelo,
          f.decidido_por.matricula,
        ),
        decidido_por: f.decidido_por,
      };
    };
    const sum = (f: (d: CierreRepartoVuelo) => number) =>
      r2(diferidos.reduce((a, d) => a + f(d), 0));
    const conteosAlcance: ConteosVuelos =
      ctx && alcance
        ? this.conteosDe(conteos.filas.filter((v) => toca(v.id, v.aeronave_id)))
        : conteos;
    const totales: TotalesPrevia = {
      vuelos: conteosAlcance.vuelos,
      completados: conteosAlcance.completados,
      cancelados: conteosAlcance.cancelados,
      pasan: pasan.length,
      pasan_venta_usd: sum((d) => d.venta_usd),
      pasan_cobrado_al_corte_usd: sum((d) => d.cobrado_usd),
      pasan_por_cobrar_usd: sum((d) => d.por_cobrar_usd),
      pasan_cobrado_posterior_usd: sum((d) => d.cobrado_posterior_usd ?? 0),
      pasan_mxn: nativos.mxn,
      pasan_usd_nativo: nativos.usd,
      se_quedan_en_cero: conteosAlcance.en_cero,
      incluidos: incluidos.length + forzados.length,
    };
    const resumenAviones = (r: ResultadoCompute | null): RepartoAvionPrevia[] =>
      (r?.aviones ?? [])
        .filter((a) => !(ctx && alcance) || alcanceIds.has(a.aeronave.id))
        .map((a) => ({
          aeronave_id: a.aeronave.id,
          matricula: a.aeronave.matricula,
          saldo_usd: r2(a.saldo_disponible_usd),
          cobrado_usd: r2(a.ingresos.cobrado_usd),
          gastos_usd: r2(
            a.gastos.directos_usd +
              // COMBUSTIBLE (23-oct-2026, invariante 104): línea propia.
              a.gastos.combustible_usd +
              a.gastos.indirectos_usd +
              a.gastos.permisos_usd +
              a.gastos.otros_prorrateados_usd,
          ),
        }));
    const estadoPrevia: EstadoMesFlota =
      ctx && alcance
        ? alcance.aeronave
          ? this.estadoAvion(
              this.filaAvion(ctx, periodo, alcance.aeronave.id),
              fila,
            )
          : estadoMesDerivado({
              global: fila,
              aviones: ctx.filasAvion.filter((f) => f.periodo === periodo),
            })
        : (fila?.estado ?? 'ABIERTO');
    const previa: PreviaCierre = {
      periodo,
      estado: estadoPrevia,
      listo,
      motivo_no_cerrable: motivo,
      texto_no_cerrable: motivo ? this.textoMotivo(motivo, periodo) : null,
      bloqueantes,
      vuelos_que_pasan: pasan,
      vuelos_que_vienen: vienen.map(salida),
      vuelos_incluidos: [
        ...incluidos.map(seQueda),
        ...forzados.map(seQuedaForzado),
      ],
      totales,
      reparto: despues
        ? { antes: resumenAviones(vivo), despues: resumenAviones(despues) }
        : null,
      ...(ctx && alcance
        ? {
            aeronave: alcance.aeronave
              ? {
                  id: alcance.aeronave.id,
                  matricula: alcance.aeronave.matricula,
                  modelo: alcance.aeronave.modelo,
                }
              : null,
            aviones_alcance: alcance.aviones.map((a) => ({
              aeronave_id: a.id,
              matricula: a.matricula,
            })),
            bloqueantes_otros_aviones: bloqueantesOtros,
          }
        : {}),
    };
    return {
      previa,
      diferidos,
      incluidos,
      forzados,
      desconocidos,
      despues,
      precierre: { listo: pre.listo, items },
      participantes,
      conteosAvion,
      motivosAvion,
      bloqueantesAvion,
    };
  }

  private textoMotivo(motivo: MotivoNoCerrable, periodo: string): string {
    switch (motivo) {
      case 'MES_EN_CURSO':
        return textoMesEnCurso(periodo);
      case 'MES_ANTERIOR_ABIERTO':
        return textoMesAnteriorAbierto(periodo, mesAnteriorDe(periodo));
      case 'YA_CERRADO':
        return `${etiquetaMes(periodo)} ya está cerrado.`;
      case 'PRECIERRE_NO_LISTO':
        return `Antes de cerrar ${etiquetaMesMinuscula(periodo)} resuelve los pendientes que bloquean el pre-cierre.`;
      case 'PERIODO_ANTES_DEL_INICIO':
        return `${etiquetaMes(periodo)} es anterior al inicio oficial del sistema.`;
    }
  }

  // ===== Bloqueantes atribuibles por avión (regla 3) =====

  /** Ids de vuelos que nombran esos items (`vuelos[].id`, `tramos[].vuelo_id`). */
  private vuelosDeItems(items: ReadonlyArray<ItemPrecierreCrudo>): string[] {
    const out = new Set<string>();
    for (const i of items) {
      for (const v of Array.isArray(i.vuelos) ? i.vuelos : []) {
        const id = (v as { id?: unknown })?.id;
        if (typeof id === 'string' && id) out.add(id);
      }
      for (const t of Array.isArray(i.tramos) ? i.tramos : []) {
        const id = (t as { vuelo_id?: unknown })?.vuelo_id;
        if (typeof id === 'string' && id) out.add(id);
      }
    }
    return [...out];
  }

  private async vuelosBasicos(ids: string[]): Promise<VueloMesRow[]> {
    const out: VueloMesRow[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await this.sb
        .from('vuelo')
        .select('id, estado, monto_total_usd, aeronave_id, es_externo')
        .in('id', ids.slice(i, i + 200));
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as unknown as VueloMesRow[]));
    }
    return out;
  }

  /**
   * Aviones de cada GASTO (regla 5 / regla 3): `avionDelGasto` (escala con
   * herencia ⇒ sellado ⇒ avión del vuelo) + sus partes de reparto manual.
   */
  private async avionesDeGastos(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return out;
    const gastos: Array<Record<string, unknown>> = [];
    for (let i = 0; i < unicos.length; i += 200) {
      const { data, error } = await this.sb
        .from('gasto')
        .select('id, aeronave_id, escala_id, vuelo_id')
        .in('id', unicos.slice(i, i + 200));
      if (error) throw new Error(error.message);
      gastos.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v ? v : null;
    const escalaIds = [
      ...new Set(gastos.map((g) => str(g.escala_id)).filter(Boolean)),
    ] as string[];
    const vueloIds = [
      ...new Set(gastos.map((g) => str(g.vuelo_id)).filter(Boolean)),
    ] as string[];
    const escalaPorId = new Map<string, { aeronave_id: string | null }>();
    if (escalaIds.length > 0) {
      const { data, error } = await this.sb
        .from('escala')
        .select('id, aeronave_id')
        .in('id', escalaIds);
      if (error) throw new Error(error.message);
      for (const e of (data ?? []) as Array<Record<string, unknown>>) {
        escalaPorId.set(String(e.id), { aeronave_id: str(e.aeronave_id) });
      }
    }
    const vueloAvion = new Map<string, string | null>();
    if (vueloIds.length > 0) {
      for (const v of await this.vuelosBasicos(vueloIds)) {
        vueloAvion.set(v.id, v.aeronave_id ?? null);
      }
    }
    const partes = new Map<string, string[]>();
    {
      const { data, error } = await this.sb
        .from('gasto_reparto')
        .select('gasto_id, aeronave_id')
        .in('gasto_id', unicos);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const g = str(r.gasto_id);
        const a = str(r.aeronave_id);
        if (!g || !a) continue;
        partes.set(g, [...(partes.get(g) ?? []), a]);
      }
    }
    for (const g of gastos) {
      const id = String(g.id);
      const aviones = new Set<string>();
      const vueloId = str(g.vuelo_id);
      const propio = avionDelGasto(
        { escala_id: str(g.escala_id), aeronave_id: str(g.aeronave_id) },
        escalaPorId,
        vueloId ? (vueloAvion.get(vueloId) ?? null) : null,
      );
      if (propio) aviones.add(propio);
      for (const a of partes.get(id) ?? []) aviones.add(a);
      out.set(id, [...aviones]);
    }
    return out;
  }

  /**
   * Atribución de los bloqueantes (regla 3 de la invariante 105): devuelve
   * una función que, para un conjunto de aviones, separa los renglones que
   * los BLOQUEAN (`propios`, con `count`/`ids` filtrados a sus elementos)
   * de los que solo frenan a otros aviones (`otros`). Un renglón sin avión,
   * con `lectura_fallida` o con algún elemento que no se pudo atribuir
   * bloquea a TODOS.
   */
  private async atribuirBloqueantes(
    itemsCrudos: ReadonlyArray<ItemPrecierreCrudo>,
    bloqueantes: ReadonlyArray<BloqueantePrevia>,
    participantes: ReadonlyMap<string, string[]>,
  ): Promise<{
    paraAviones: (aviones: ReadonlySet<string>) => {
      propios: BloqueantePrevia[];
      otros: BloqueantePrevia[];
    };
  }> {
    type Elemento = { id: string; aviones: string[] | null };
    type Atribuido = {
      item: BloqueantePrevia;
      todos: boolean;
      /** Elementos contados (vuelos, tramos o gastos) con sus aviones. */
      elementos: Elemento[];
      /** Cómo rearmar el renglón con un subconjunto de elementos. */
      rearmar: (sub: Elemento[]) => BloqueantePrevia;
    };
    const gastosIds = bloqueantes
      .filter((b) => b.clave === 'gastos_sin_tc')
      .flatMap((b) => b.ids ?? []);
    const avionesGasto = await this.avionesDeGastos(gastosIds);
    const atribuidos: Atribuido[] = bloqueantes.map((b) => {
      const crudo = itemsCrudos.find((i) => i.clave === b.clave);
      const sinAvion = (
        CLAVES_BLOQUEANTES_SIN_AVION as readonly string[]
      ).includes(b.clave);
      if (sinAvion || b.lectura_fallida || !crudo) {
        return {
          item: b,
          todos: true,
          elementos: [],
          rearmar: () => b,
        };
      }
      const avionesVuelo = (id: string): string[] | null => {
        const p = participantes.get(id);
        return p && p.length > 0 ? p : null;
      };
      if (b.clave === 'gastos_sin_tc') {
        const elementos: Elemento[] = (b.ids ?? []).map((id) => {
          const a = avionesGasto.get(id);
          return { id, aviones: a && a.length > 0 ? a : null };
        });
        return {
          item: b,
          // ids truncados: no se puede atribuir completo ⇒ a todos.
          todos:
            elementos.length === 0 ||
            (crudo as { ids_truncado?: unknown }).ids_truncado === true,
          elementos,
          rearmar: (sub) => ({
            ...b,
            count: sub.length,
            ids: sub.map((e) => e.id),
          }),
        };
      }
      if (b.clave === 'tacos_en_revision') {
        const tramos = Array.isArray(crudo.tramos)
          ? (crudo.tramos as Array<{ vuelo_id?: unknown; escala_id?: unknown }>)
          : [];
        const elementos: Elemento[] = tramos.map((t, idx) => {
          const vueloId = typeof t.vuelo_id === 'string' ? t.vuelo_id : '';
          return {
            id: typeof t.escala_id === 'string' ? t.escala_id : `tramo-${idx}`,
            aviones: vueloId ? avionesVuelo(vueloId) : null,
          };
        });
        return {
          item: b,
          todos: elementos.length === 0,
          elementos,
          rearmar: (sub) => ({ ...b, count: sub.length }),
        };
      }
      // vuelos_sin_completar / cobros_sin_tc: un elemento por vuelo.
      const vuelos = Array.isArray(crudo.vuelos)
        ? (crudo.vuelos as Array<{ id?: unknown }>)
        : [];
      const elementos: Elemento[] = vuelos
        .map((v) => (typeof v.id === 'string' ? v.id : ''))
        .filter(Boolean)
        .map((id) => ({ id, aviones: avionesVuelo(id) }));
      return {
        item: b,
        todos: elementos.length === 0,
        elementos,
        rearmar: (sub) => ({ ...b, count: sub.length }),
      };
    });
    return {
      paraAviones: (aviones) => {
        const propios: BloqueantePrevia[] = [];
        const otros: BloqueantePrevia[] = [];
        for (const a of atribuidos) {
          if (a.todos) {
            propios.push(a.item);
            continue;
          }
          const mios = a.elementos.filter(
            (e) => e.aviones == null || e.aviones.some((id) => aviones.has(id)),
          );
          const ajenos = a.elementos.filter((e) => !mios.includes(e));
          if (mios.length > 0) propios.push(a.rearmar(mios));
          if (ajenos.length > 0) otros.push(a.rearmar(ajenos));
        }
        return { propios, otros };
      },
    };
  }

  /** Σ de los cobros REALES de esos vuelos por moneda nativa (`moneda::text`). */
  private async cobrosNativos(
    vueloIds: string[],
  ): Promise<{ mxn: number; usd: number }> {
    if (vueloIds.length === 0) return { mxn: 0, usd: 0 };
    let mxn = 0;
    let usd = 0;
    for (let i = 0; i < vueloIds.length; i += 200) {
      const { data, error } = await this.sb
        .from('cobro_vuelo')
        .select('monto, moneda')
        .in('vuelo_id', vueloIds.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const c of (data ?? []) as Array<{
        monto: unknown;
        moneda: unknown;
      }>) {
        const m = Number(c.monto) || 0;
        if (String(c.moneda) === 'MXN') mxn += m;
        else if (String(c.moneda) === 'USD') usd += m;
      }
    }
    return { mxn: r2(mxn), usd: r2(usd) };
  }

  private conteosDe(filas: ReadonlyArray<VueloMesRow>): ConteosVuelos {
    const completados = filas.filter((v) => v.estado === 'COMPLETADO').length;
    const cancelados = filas.filter((v) => v.estado === 'CANCELADO').length;
    return {
      vuelos: completados + cancelados,
      completados,
      cancelados,
      en_cero: filas.filter(
        (v) => v.estado === 'COMPLETADO' && !(Number(v.monto_total_usd) > 0),
      ).length,
    };
  }

  /** Conteo de los vuelos del DINERO del mes (por `fecha_contable`). */
  private async conteosDelMes(
    desde: string,
    hasta: string,
  ): Promise<ConteosVuelos & { filas: VueloMesRow[] }> {
    const { data, error } = await this.sb
      .from('vuelo')
      .select('id, estado, monto_total_usd, aeronave_id, es_externo')
      .in('estado', ['COMPLETADO', 'CANCELADO'])
      .gte('fecha_contable', `${desde}T00:00:00-05:00`)
      .lte('fecha_contable', `${hasta}T23:59:59-05:00`);
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as unknown as VueloMesRow[];
    return { ...this.conteosDe(filas), filas };
  }

  // ===================================================================
  // POST /v1/cierres/:periodo
  // ===================================================================

  async cerrar(periodo: string, dto: CerrarMesDto, actor: AuthenticatedUser) {
    CierresService.validarPeriodo(periodo);
    // 1) Sonda.
    await this.assertDisponible();
    // 2) Inicio oficial.
    const { mes: mesIni, inicio } = await this.mesInicio();
    this.assertDesdeInicio(periodo, inicio, mesIni);
    // 3) Mes en curso o futuro.
    if (periodo >= this.mesEnCurso()) {
      throw conflicto('MES_EN_CURSO', textoMesEnCurso(periodo), { periodo });
    }
    const ctx = await this.contextoFlota();
    if (!ctx) {
      if (dto.aeronave_id) throw errorCierrePorAvionNoDisponible();
      return this.cerrarFlotaLegado(periodo, dto, actor, mesIni);
    }
    return this.cerrarPorAvion(periodo, dto, actor, mesIni, ctx);
  }

  /**
   * CIERRE POR AVIÓN (invariante 105): un avión (`aeronave_id`) o, sin él,
   * todos los activos abiertos del mes en orden de matrícula con UNA previa
   * (`vuelos_esperados` = la unión). Secuencial: si uno falla, los ya
   * cerrados se quedan cerrados y el error trae `details.cerrados`.
   */
  private async cerrarPorAvion(
    periodo: string,
    dto: CerrarMesDto,
    actor: AuthenticatedUser,
    mesIni: string,
    ctx: ContextoFlota,
  ) {
    const filas = await leerCierresMes(this.sb);
    const fila = filas.find((f) => f.periodo === periodo) ?? null;
    // 4) Ya cerrado (toda la flota).
    if (fila?.estado === 'CERRADO') throw this.errorYaCerrado(fila);
    const alcance = this.alcanceDe(ctx, filas, periodo, dto.aeronave_id);
    const anterior = mesAnteriorDe(periodo);
    if (alcance.aeronave) {
      const fa = this.filaAvion(ctx, periodo, alcance.aeronave.id);
      if (fa?.estado === 'CERRADO') throw this.errorYaCerradoAvion(fa);
      // 5) Mes anterior abierto PARA ESE AVIÓN.
      this.assertAnteriorCerradoAvion(
        ctx,
        filas,
        anterior,
        mesIni,
        alcance.aeronave,
      );
    } else if (alcance.aviones.length === 0) {
      throw conflicto(
        'YA_CERRADO',
        `${etiquetaMes(periodo)} ya está cerrado: todos los aviones activos están cerrados.`,
        { periodo },
      );
    }
    // 6) Pre-cierre listo (del alcance); 7) la lista que vio el diálogo.
    const incluir = new Set(dto.incluir_vuelos ?? []);
    const prep = await this.prepararCierre(
      periodo,
      filas,
      mesIni,
      incluir,
      ctx,
      alcance,
    );
    if (!prep.previa.listo) {
      throw conflicto(
        'PRECIERRE_NO_LISTO',
        `Antes de cerrar ${etiquetaMesMinuscula(periodo)}${alcance.aeronave ? ` (${alcance.aeronave.matricula})` : ''} resuelve los pendientes que bloquean el pre-cierre (${prep.previa.bloqueantes
          .map(textoBloqueantePrevia)
          .join('; ')}).`,
        {
          bloqueantes: prep.previa.bloqueantes,
          ...(alcance.aeronave
            ? { aeronave: this.aeronaveCorta(alcance.aeronave) }
            : {}),
        },
      );
    }
    this.assertPreviaIgual(dto, prep);
    if (!prep.despues) {
      throw new InternalServerErrorException({
        message:
          'No se pudo calcular el reparto del mes sin los vuelos que pasan: vuelve a intentarlo en unos minutos.',
        error: 'CIERRE_REPARTO_FALLIDO',
      });
    }
    const despues = prep.despues;
    const destino = mesSiguienteDe(periodo);
    const cerrados: string[] = [];
    const yaDiferidos = new Set<string>();
    const diferidosEscritos: CierreRepartoVuelo[] = [];
    const porAvionSalida: Array<{
      aeronave: AeronaveFila;
      version: number;
      diferidos: CierreRepartoVuelo[];
      incluidos: number;
      saldo_usd: number;
    }> = [];
    // El error del avión que falló lleva SIEMPRE `details.cerrados` (las
    // matrículas que sí quedaron cerradas en esta llamada), `details.aeronave`
    // (el que falló) y un `message` legible «MATRÍCULA: …». Un fallo que no
    // es HTTP (lectura/escritura) sale como 500 CIERRE_FALLIDO con lo mismo.
    const conDetalle = (e: unknown, a: AeronaveFila): never => {
      const prefijo = `${a.matricula}: `;
      const legible = (m: unknown): string => {
        const txt = typeof m === 'string' ? m : String(m);
        return txt.startsWith(a.matricula) ? txt : `${prefijo}${txt}`;
      };
      if (e instanceof HttpException) {
        const cuerpo = e.getResponse();
        const base =
          cuerpo && typeof cuerpo === 'object'
            ? (cuerpo as Record<string, unknown>)
            : { message: String(cuerpo) };
        const details =
          base.details && typeof base.details === 'object'
            ? (base.details as Record<string, unknown>)
            : {};
        throw new HttpException(
          {
            ...base,
            message: legible(base.message),
            details: {
              ...details,
              aeronave: details.aeronave ?? this.aeronaveCorta(a),
              cerrados: [...cerrados],
            },
          },
          e.getStatus(),
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Cierre de ${periodo} (${a.matricula}) falló: ${msg}`);
      throw new InternalServerErrorException({
        message: `${prefijo}no se pudo cerrar ${etiquetaMesMinuscula(periodo)}: ${msg}. Vuelve a intentarlo.`,
        error: 'CIERRE_FALLIDO',
        details: {
          periodo,
          aeronave: this.aeronaveCorta(a),
          cerrados: [...cerrados],
        },
      });
    };
    for (const a of alcance.aviones) {
      try {
        // Precondiciones por avión en el cierre de toda la flota.
        if (!alcance.aeronave) {
          const fa = this.filaAvion(ctx, periodo, a.id);
          if (fa?.estado === 'CERRADO') continue;
          this.assertAnteriorCerradoAvion(ctx, filas, anterior, mesIni, a);
          const motivo = prep.motivosAvion.get(a.id) ?? null;
          if (motivo === 'PRECIERRE_NO_LISTO') {
            throw conflicto(
              'PRECIERRE_NO_LISTO',
              `Antes de cerrar ${etiquetaMesMinuscula(periodo)} (${a.matricula}) resuelve los pendientes que bloquean el pre-cierre (${(
                prep.bloqueantesAvion.get(a.id) ?? []
              )
                .map(textoBloqueantePrevia)
                .join('; ')}).`,
              {
                bloqueantes: prep.bloqueantesAvion.get(a.id) ?? [],
                aeronave: this.aeronaveCorta(a),
              },
            );
          }
        }
        const participa = (id: string, principal: string | null): boolean =>
          (
            prep.participantes.get(id) ?? (principal ? [principal] : [])
          ).includes(a.id);
        const misDiferidos = prep.diferidos.filter(
          (d) => participa(d.id, d.aeronave_id) && !yaDiferidos.has(d.id),
        );
        const misIncluidos = prep.incluidos.filter((d) =>
          participa(d.id, d.aeronave_id),
        );
        const misForzados = prep.forzados.filter((f) =>
          participa(f.vuelo.id, f.vuelo.aeronave_id),
        );
        const avion =
          despues.aviones.find((x) => x.aeronave.id === a.id) ?? null;
        const conteos = prep.conteosAvion.get(a.id) ?? this.conteosDe([]);
        const snapshots = this.snapshotsDeAvion(
          periodo,
          a,
          avion,
          conteos,
          misDiferidos,
          // Los que SÍ pasan por este cierre (a este avión le tocan todos
          // los suyos, aunque la bitácora de un compartido la lleve el
          // primero que cerró).
          prep.diferidos.filter((d) => participa(d.id, d.aeronave_id)),
          misIncluidos,
          misForzados,
          prep.precierre,
          prep.bloqueantesAvion.get(a.id) ?? [],
        );
        const version = await this.escribirFilaCierreAvion(
          periodo,
          a,
          this.filaAvion(ctx, periodo, a.id),
          snapshots,
          actor,
        );
        try {
          await this.diferirVuelos(
            periodo,
            destino,
            version,
            misDiferidos,
            actor,
            a.id,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.error(
            `Cierre de ${periodo} (${a.matricula}) incompleto: ${msg}`,
          );
          await this.marcarIncompletoAvion(periodo, a.id, version, msg);
          throw new InternalServerErrorException({
            message: `No se pudo terminar el cierre de ${etiquetaMesMinuscula(periodo)} de ${a.matricula}: ${msg}. No se movió ningún vuelo de ese avión y quedó abierto; vuelve a intentarlo.`,
            error: 'CIERRE_INCOMPLETO',
            details: { periodo, aeronave: this.aeronaveCorta(a) },
          });
        }
        for (const d of misDiferidos) yaDiferidos.add(d.id);
        diferidosEscritos.push(...misDiferidos);
        cerrados.push(a.matricula);
        porAvionSalida.push({
          aeronave: a,
          version,
          diferidos: misDiferidos,
          incluidos: misIncluidos.length + misForzados.length,
          saldo_usd: r2(avion?.saldo_disponible_usd ?? 0),
        });
      } catch (e) {
        olvidarCierres(this.sb);
        this.profitSharing.olvidarUtilidadesSocios();
        conDetalle(e, a);
      }
    }

    // Fila global DERIVADA: cuando el último avión activo queda cerrado.
    olvidarCierres(this.sb);
    this.profitSharing.olvidarUtilidadesSocios();
    await this.derivarFilaGlobal(periodo, actor);
    olvidarCierres(this.sb);

    // Memorias, respuesta y avisos.
    const mes = await this.mesReleido(periodo);
    const cierres = (mes.aviones ?? []).filter((x) =>
      porAvionSalida.some((p) => p.aeronave.id === x.aeronave_id),
    );
    const quien = actor.nombre ?? 'la oficina';
    const totalDiferidos = diferidosEscritos.length;
    const porCobrar = r2(
      diferidosEscritos.reduce((s, d) => s + d.por_cobrar_usd, 0),
    );
    const totalIncluidos = porAvionSalida.reduce((s, p) => s + p.incluidos, 0);
    const saldoTotal = r2(porAvionSalida.reduce((s, p) => s + p.saldo_usd, 0));
    const cuerpoAviso =
      (totalDiferidos > 0
        ? `${totalDiferidos} vuelo(s) pasan a ${etiquetaMesMinuscula(destino)} (por cobrar al cierre: ${usd(porCobrar)}). `
        : 'Ningún vuelo pasa al mes siguiente. ') +
      (totalIncluidos > 0
        ? `${totalIncluidos} vuelo(s) cobrados después del corte se quedan en ${etiquetaMesMinuscula(periodo)}. `
        : '') +
      `Saldo del reparto: ${usd(saldoTotal)}.`;
    const titulo = alcance.aeronave
      ? `${alcance.aeronave.matricula} · ${etiquetaMes(periodo)} cerrado`
      : `${etiquetaMes(periodo)} cerrado (${cerrados.length} avión(es))`;
    const notificados = await this.notifications
      .notifyRole(
        Rol.ADMIN,
        {
          tipo: 'alerta_sistema',
          titulo,
          cuerpo:
            `${alcance.aeronave ? `${alcance.aeronave.matricula} · ${etiquetaMesMinuscula(periodo)} cerrado por ${quien}` : `${etiquetaMes(periodo)} cerrado por ${quien} (${cerrados.join(', ') || 'ningún avión'})`}. ` +
            cuerpoAviso +
            (mes.estado === 'CERRADO'
              ? ' Con esto toda la flota activa queda cerrada.'
              : ''),
          data: {
            periodo,
            aeronave_id: alcance.aeronave?.id ?? null,
            aviones: cerrados,
            estado_mes: mes.estado,
            vuelos_diferidos: totalDiferidos,
            vuelos_incluidos: totalIncluidos,
          },
          link: `/admin/reportes?desde=${rangoDelMes(periodo).desde}&hasta=${rangoDelMes(periodo).hasta}`,
        },
        actor.userId,
      )
      .catch(() => 0);

    const releidaGlobal = (await leerCierresMes(this.sb)).find(
      (f) => f.periodo === periodo,
    );
    const idsEscritos = new Set(diferidosEscritos.map((d) => d.id));
    return {
      aeronave: alcance.aeronave ? this.aeronaveCorta(alcance.aeronave) : null,
      cierres,
      mes,
      diferidos: prep.previa.vuelos_que_pasan.filter((v) =>
        idsEscritos.has(v.id),
      ),
      // INCLUIR EN EL MES (21-oct-2026).
      incluidos: prep.previa.vuelos_incluidos,
      totales: prep.previa.totales,
      reparto: {
        aviones: porAvionSalida.map((p) => ({
          matricula: p.aeronave.matricula,
          saldo_usd: p.saldo_usd,
        })),
        total_usd: saldoTotal,
      },
      notificados,
      // Compatibilidad con el contrato del 0.0.88 (`cierre`): el mes (flota).
      cierre: {
        periodo,
        estado: mes.estado,
        version: releidaGlobal?.version ?? mes.version,
        cerrado_at:
          releidaGlobal?.cerrado_at ??
          cierres[0]?.cerrado_at ??
          new Date().toISOString(),
        cerrado_por: releidaGlobal?.cerrado_por ??
          cierres[0]?.cerrado_por ?? {
            id: actor.userId,
            nombre: actor.nombre,
          },
      },
    };
  }

  private aeronaveCorta(a: AeronaveFila): { id: string; matricula: string } {
    return { id: a.id, matricula: a.matricula };
  }

  private assertAnteriorCerradoAvion(
    ctx: ContextoFlota,
    filas: CierreMesLeido[],
    anterior: string,
    mesIni: string,
    a: AeronaveFila,
  ): void {
    if (anterior < mesIni) return;
    if (this.mesesCerradosDelAvion(ctx, filas, a.id).has(anterior)) return;
    throw conflicto(
      'MES_ANTERIOR_ABIERTO',
      `${a.matricula}: ${textoMesAnteriorAbierto(mesSiguienteDe(anterior), anterior)}`,
      { periodo_anterior: anterior, aeronave: this.aeronaveCorta(a) },
    );
  }

  /** La lista que vio el diálogo = pasan + se quedan (+ decididos por otro avión). */
  private assertPreviaIgual(
    dto: CerrarMesDto,
    prep: {
      diferidos: CierreRepartoVuelo[];
      incluidos: CierreRepartoVuelo[];
      forzados: VueloForzado[];
      desconocidos: string[];
      previa: PreviaCierre;
    },
  ): void {
    if (!dto.vuelos_esperados && prep.desconocidos.length === 0) return;
    const esperados = new Set(dto.vuelos_esperados ?? []);
    const reales = new Set([
      ...prep.diferidos.map((d) => d.id),
      ...prep.incluidos.map((d) => d.id),
      ...prep.forzados.map((f) => f.vuelo.id),
    ]);
    const igual =
      prep.desconocidos.length === 0 &&
      (!dto.vuelos_esperados ||
        (esperados.size === reales.size &&
          [...reales].every((id) => esperados.has(id))));
    if (!igual) {
      throw conflicto(
        'PREVIA_CAMBIO',
        'La lista de vuelos que pasan al mes siguiente cambió desde que abriste el diálogo: revísala y vuelve a confirmar.',
        { previa: prep.previa },
      );
    }
  }

  /** Snapshots y totales de UN avión (lo que guarda `cierre_mes_avion`). */
  private snapshotsDeAvion(
    periodo: string,
    a: AeronaveFila,
    avion: AvionCompute | null,
    conteos: ConteosVuelos,
    diferidosPropios: CierreRepartoVuelo[],
    diferidosQueTocan: CierreRepartoVuelo[],
    incluidos: CierreRepartoVuelo[],
    forzados: VueloForzado[],
    precierre: { listo: boolean; items: BloqueantePrevia[] },
    bloqueantesAvion: BloqueantePrevia[],
  ): Record<string, unknown> {
    const socios = avion
      ? (utilidadMesDesdeAviones(periodo, [avion], false).aviones[0] ?? {})
      : {};
    const sum = (f: (d: CierreRepartoVuelo) => number) =>
      r2(diferidosQueTocan.reduce((s, d) => s + f(d), 0));
    const totales = {
      vuelos: conteos.vuelos,
      completados: conteos.completados,
      cancelados: conteos.cancelados,
      vuelos_diferidos: diferidosQueTocan.length,
      // Los que ESTE cierre movió (la bitácora propia); el resto los movió
      // un avión que cerró antes (vuelo compartido).
      vuelos_diferidos_propios: diferidosPropios.length,
      diferidos_venta_usd: sum((d) => d.venta_usd),
      diferidos_cobrado_usd: sum((d) => d.cobrado_usd),
      diferidos_por_cobrar_usd: sum((d) => d.por_cobrar_usd),
      saldo_usd: r2(avion?.saldo_disponible_usd ?? 0),
      saldo_mxn: r2(avion?.saldo_disponible_mxn ?? 0),
      // INCLUIR EN EL MES (21-oct-2026): los cobrados después del corte que
      // la oficina dejó en el mes (su `periodo_contable` no se toca) + los
      // decididos por otro avión (regla 2, con `decidido_por`).
      vuelos_incluidos: incluidos.length + forzados.length,
      incluidos: [
        ...incluidos.map((d) => ({
          id: d.id,
          folio: d.folio,
          cobrado_posterior_usd: d.cobrado_posterior_usd ?? 0,
          fecha_cobro_posterior: d.fecha_cobro_posterior ?? null,
        })),
        ...forzados.map((f) => ({
          id: f.vuelo.id,
          folio: f.vuelo.folio,
          cobrado_posterior_usd: f.vuelo.cobrado_posterior_usd ?? 0,
          fecha_cobro_posterior: f.vuelo.fecha_cobro_posterior ?? null,
          decidido_por: f.decidido_por,
        })),
      ],
    };
    return {
      precierre_snapshot: {
        listo: precierre.listo,
        items: precierre.items,
        bloqueantes_avion: bloqueantesAvion,
      },
      reparto_snapshot: avion ?? {},
      socios_snapshot: socios,
      totales,
    };
  }

  private errorYaCerrado(fila: CierreMesLeido): ConflictException {
    return conflicto(
      'YA_CERRADO',
      `${etiquetaMes(fila.periodo)} ya está cerrado.`,
      { cerrado_at: fila.cerrado_at, cerrado_por: fila.cerrado_por },
    );
  }

  private errorYaCerradoAvion(fa: CierreAvionLeido): ConflictException {
    return conflicto(
      'YA_CERRADO',
      `${fa.matricula ?? 'Ese avión'} · ${etiquetaMes(fa.periodo)} ya está cerrado.`,
      {
        cerrado_at: fa.cerrado_at,
        cerrado_por: fa.cerrado_por,
        aeronave: { id: fa.aeronave_id, matricula: fa.matricula },
      },
    );
  }

  /**
   * Inserta la fila (primer cierre) o la reabre a CERRADO (CAS estado =
   * REABIERTO y la misma `version` leída). 0 filas ⇒ alguien cerró a la vez
   * ⇒ 409 YA_CERRADO. Devuelve la `version` del cierre.
   */
  private async escribirFilaCierre(
    periodo: string,
    fila: CierreMesLeido | null,
    snapshots: Record<string, unknown>,
    actor: AuthenticatedUser,
  ): Promise<number> {
    const ahora = new Date().toISOString();
    if (!fila) {
      const { error } = await this.sb.from('cierre_mes').insert({
        periodo: `${periodo}-01`,
        estado: 'CERRADO',
        cerrado_at: ahora,
        cerrado_por: actor.userId,
        version: 1,
        ...snapshots,
      });
      if (error) {
        if (error.code === '23505')
          throw await this.yaCerradoTrasCarrera(periodo);
        throw new Error(error.message);
      }
      return 1;
    }
    const version = fila.version + 1;
    const { data, error } = await this.sb
      .from('cierre_mes')
      .update({
        estado: 'CERRADO',
        cerrado_at: ahora,
        cerrado_por: actor.userId,
        version,
        ...snapshots,
      })
      .eq('periodo', `${periodo}-01`)
      .eq('estado', 'REABIERTO')
      .eq('version', fila.version)
      .select('periodo');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw await this.yaCerradoTrasCarrera(periodo);
    }
    return version;
  }

  /** Igual que `escribirFilaCierre`, para la fila de UN avión (PK periodo + avión). */
  private async escribirFilaCierreAvion(
    periodo: string,
    a: AeronaveFila,
    fila: CierreAvionLeido | null,
    snapshots: Record<string, unknown>,
    actor: AuthenticatedUser,
  ): Promise<number> {
    const ahora = new Date().toISOString();
    if (!fila) {
      const { error } = await this.sb.from('cierre_mes_avion').insert({
        periodo: `${periodo}-01`,
        aeronave_id: a.id,
        estado: 'CERRADO',
        cerrado_at: ahora,
        cerrado_por: actor.userId,
        version: 1,
        ...snapshots,
      });
      if (error) {
        if (error.code === '23505')
          throw await this.yaCerradoAvionTrasCarrera(periodo, a);
        throw new Error(error.message);
      }
      return 1;
    }
    const version = fila.version + 1;
    const { data, error } = await this.sb
      .from('cierre_mes_avion')
      .update({
        estado: 'CERRADO',
        cerrado_at: ahora,
        cerrado_por: actor.userId,
        version,
        ...snapshots,
      })
      .eq('periodo', `${periodo}-01`)
      .eq('aeronave_id', a.id)
      .eq('estado', 'REABIERTO')
      .eq('version', fila.version)
      .select('periodo');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw await this.yaCerradoAvionTrasCarrera(periodo, a);
    }
    return version;
  }

  private async yaCerradoTrasCarrera(
    periodo: string,
  ): Promise<ConflictException> {
    olvidarCierres(this.sb);
    const f = (await leerCierresMes(this.sb)).find(
      (x) => x.periodo === periodo,
    );
    if (f?.estado === 'CERRADO') return this.errorYaCerrado(f);
    return conflicto(
      'CIERRE_CONCURRENTE',
      `Alguien más está cerrando o reabriendo ${etiquetaMesMinuscula(periodo)} en este momento: recarga y vuelve a intentarlo.`,
      { periodo },
    );
  }

  private async yaCerradoAvionTrasCarrera(
    periodo: string,
    a: AeronaveFila,
  ): Promise<ConflictException> {
    olvidarCierres(this.sb);
    const f = (await leerCierresMesAvion(this.sb)).find(
      (x) => x.periodo === periodo && x.aeronave_id === a.id,
    );
    if (f?.estado === 'CERRADO') return this.errorYaCerradoAvion(f);
    return conflicto(
      'CIERRE_CONCURRENTE',
      `Alguien más está cerrando o reabriendo ${a.matricula} en ${etiquetaMesMinuscula(periodo)} en este momento: recarga y vuelve a intentarlo.`,
      { periodo, aeronave: this.aeronaveCorta(a) },
    );
  }

  /**
   * Por cada vuelo de D: `periodo_contable = M+1` con CAS (su mes contable
   * SIGUE siendo M: `periodo_contable` igual al leído) + fila de bitácora
   * (`cierre_mes_vuelo` en el cierre global; `cierre_mes_avion_vuelo` con
   * `aeronaveId`, el avión que cierra). Un fallo revierte lo ya escrito y
   * LANZA.
   */
  private async diferirVuelos(
    periodo: string,
    destino: string,
    version: number,
    diferidos: CierreRepartoVuelo[],
    actor: AuthenticatedUser,
    aeronaveId?: string,
  ): Promise<void> {
    if (diferidos.length === 0) return;
    const ids = diferidos.map((d) => d.id);
    const { data, error } = await this.sb
      .from('vuelo')
      .select('id, folio, periodo_contable, fecha_contable')
      .in('id', ids);
    if (error) throw new Error(error.message);
    const leidos = new Map(
      (
        (data ?? []) as Array<{
          id: string;
          folio: number | null;
          periodo_contable: string | null;
          fecha_contable: string | null;
        }>
      ).map((v) => [v.id, v]),
    );
    const hechos: Array<{ id: string; anterior: string | null }> = [];
    const nuevo = periodoContableDe(destino);
    const tablaBitacora = aeronaveId
      ? 'cierre_mes_avion_vuelo'
      : 'cierre_mes_vuelo';
    try {
      for (const d of diferidos) {
        const v = leidos.get(d.id);
        if (!v) throw new Error(`el vuelo #${d.folio ?? '?'} ya no existe`);
        const anterior = v.periodo_contable;
        let q = this.sb
          .from('vuelo')
          .update({ periodo_contable: nuevo, updated_by: actor.userId })
          .eq('id', d.id);
        q =
          anterior == null
            ? q.is('periodo_contable', null)
            : q.eq('periodo_contable', anterior);
        const { data: upd, error: uErr } = await q.select('id');
        if (uErr) throw new Error(uErr.message);
        if (!upd || upd.length === 0) {
          throw new Error(
            `el vuelo #${d.folio ?? '?'} cambió de mes mientras se cerraba`,
          );
        }
        hechos.push({ id: d.id, anterior });
        const comunes = {
          periodo: `${periodo}-01`,
          cierre_version: version,
          vuelo_id: d.id,
          periodo_origen: `${periodo}-01`,
          periodo_destino: `${destino}-01`,
          periodo_contable_anterior: anterior,
          folio: d.folio ?? v.folio ?? 0,
          cliente: d.cliente,
          matricula: d.matricula,
          venta_usd: d.venta_usd,
          cobrado_usd: d.cobrado_usd,
          por_cobrar_usd: d.por_cobrar_usd,
          motivo: d.motivo ?? 'SIN_COBRO',
          created_by: actor.userId,
        };
        const { error: bErr } = await this.sb.from(tablaBitacora).insert(
          aeronaveId
            ? {
                ...comunes,
                aeronave_id: aeronaveId,
                vuelo_aeronave_id: d.aeronave_id,
              }
            : { ...comunes, aeronave_id: d.aeronave_id },
        );
        if (bErr) throw new Error(bErr.message);
      }
    } catch (e) {
      // Compensación: cada vuelo movido regresa a su valor anterior (CAS por
      // el valor que escribimos) y su bitácora queda revertida.
      for (const h of hechos.reverse()) {
        try {
          await this.sb
            .from('vuelo')
            .update({ periodo_contable: h.anterior, updated_by: actor.userId })
            .eq('id', h.id)
            .eq('periodo_contable', nuevo);
          let qb = this.sb
            .from(tablaBitacora)
            .update({
              revertido_at: new Date().toISOString(),
              revertido_por: actor.userId,
            })
            .eq('periodo', `${periodo}-01`)
            .eq('cierre_version', version)
            .eq('vuelo_id', h.id);
          if (aeronaveId) qb = qb.eq('aeronave_id', aeronaveId);
          await qb;
        } catch (e2) {
          this.logger.error(
            `Compensación del cierre de ${periodo}: el vuelo ${h.id} no regresó: ${e2 instanceof Error ? e2.message : String(e2)}`,
          );
        }
      }
      throw e;
    }
  }

  /** Cierre a medias ⇒ el mes queda REABIERTO con el motivo (sin borrar). */
  private async marcarIncompleto(
    periodo: string,
    version: number,
    msg: string,
  ): Promise<void> {
    const motivo = `cierre incompleto: ${msg}`.slice(0, 300);
    const { error } = await this.sb
      .from('cierre_mes')
      .update({
        estado: 'REABIERTO',
        reabierto_at: new Date().toISOString(),
        reabierto_motivo: motivo.length >= 5 ? motivo : 'cierre incompleto',
      })
      .eq('periodo', `${periodo}-01`)
      .eq('version', version);
    olvidarCierres(this.sb);
    if (error) {
      this.logger.error(
        `Cierre de ${periodo}: no se pudo marcar como incompleto: ${error.message}`,
      );
    }
  }

  /** Cierre de UN avión a medias ⇒ su fila queda REABIERTO con el motivo. */
  private async marcarIncompletoAvion(
    periodo: string,
    aeronaveId: string,
    version: number,
    msg: string,
  ): Promise<void> {
    const motivo = `cierre incompleto: ${msg}`.slice(0, 300);
    const { error } = await this.sb
      .from('cierre_mes_avion')
      .update({
        estado: 'REABIERTO',
        reabierto_at: new Date().toISOString(),
        reabierto_motivo: motivo.length >= 5 ? motivo : 'cierre incompleto',
      })
      .eq('periodo', `${periodo}-01`)
      .eq('aeronave_id', aeronaveId)
      .eq('version', version);
    olvidarCierres(this.sb);
    if (error) {
      this.logger.error(
        `Cierre de ${periodo} (${aeronaveId}): no se pudo marcar como incompleto: ${error.message}`,
      );
    }
  }

  /**
   * FILA GLOBAL DERIVADA (invariante 105): si TODOS los aviones activos
   * tienen fila CERRADO en el mes, la fila `cierre_mes` se escribe CERRADO
   * (insert o REABIERTO⇒CERRADO con version + 1) con los snapshots
   * AGREGADOS de las filas por avión. Una carrera (dos cierres que ven «todo
   * cerrado» a la vez) no es error: si al releer la global ya está CERRADO,
   * listo. NUNCA se escribe en un cierre parcial.
   */
  private async derivarFilaGlobal(
    periodo: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const [aeronaves, filasAvion, filas] = await Promise.all([
      this.leerAeronaves(),
      leerCierresMesAvion(this.sb),
      leerCierresMes(this.sb),
    ]);
    const activos = aeronaves.filter((a) => a.activa);
    const cerradasMes = filasAvion.filter(
      (f) => f.periodo === periodo && f.estado === 'CERRADO',
    );
    if (activos.length === 0) return;
    if (!activos.every((a) => cerradasMes.some((f) => f.aeronave_id === a.id)))
      return;
    const global = filas.find((f) => f.periodo === periodo) ?? null;
    if (global?.estado === 'CERRADO') return;
    const { data, error } = await this.sb
      .from('cierre_mes_avion')
      .select('aeronave_id, reparto_snapshot, socios_snapshot, totales')
      .eq('periodo', `${periodo}-01`)
      .eq('estado', 'CERRADO');
    if (error)
      throw new Error(`Cierre derivado de ${periodo}: ${error.message}`);
    const porId = new Map(
      ((data ?? []) as Array<Record<string, unknown>>).map((r) => [
        String(r.aeronave_id),
        r,
      ]),
    );
    const orden = [...cerradasMes].sort(
      (a, b) =>
        (a.matricula ?? '').localeCompare(b.matricula ?? '', 'es') ||
        a.aeronave_id.localeCompare(b.aeronave_id),
    );
    const sumTot = (k: string): number =>
      r2(
        orden.reduce((s, f) => {
          const t = porId.get(f.aeronave_id)?.totales as
            | Record<string, unknown>
            | undefined;
          return s + (Number(t?.[k]) || 0);
        }, 0),
      );
    const incluidosVistos = new Set<string>();
    const incluidos: unknown[] = [];
    const diferidosIds = new Set<string>();
    for (const f of orden) {
      const t = porId.get(f.aeronave_id)?.totales as
        | Record<string, unknown>
        | undefined;
      for (const i of Array.isArray(t?.incluidos)
        ? (t.incluidos as unknown[])
        : []) {
        const id = (i as { id?: unknown })?.id;
        if (typeof id !== 'string' || incluidosVistos.has(id)) continue;
        incluidosVistos.add(id);
        incluidos.push(i);
      }
    }
    // Vuelos diferidos del mes (bitácora viva, sin repetir compartidos).
    {
      const { data: bit, error: bErr } = await this.sb
        .from('cierre_mes_avion_vuelo')
        .select('vuelo_id, venta_usd, cobrado_usd, por_cobrar_usd')
        .eq('periodo', `${periodo}-01`)
        .is('revertido_at', null);
      if (bErr) throw new Error(bErr.message);
      for (const b of (bit ?? []) as Array<Record<string, unknown>>) {
        diferidosIds.add(String(b.vuelo_id));
      }
    }
    const { desde, hasta } = rangoDelMes(periodo);
    const conteos = await this.conteosDelMes(desde, hasta);
    const porAvion = orden.map((f) => ({
      aeronave_id: f.aeronave_id,
      matricula: f.matricula,
      saldo_usd: r2(
        Number(
          (porId.get(f.aeronave_id)?.totales as Record<string, unknown>)
            ?.saldo_usd,
        ) || 0,
      ),
    }));
    const totales = {
      // Los vuelos del mes AL CERRAR: los que siguen aquí + los que pasaron.
      vuelos: conteos.vuelos + diferidosIds.size,
      vuelos_diferidos: diferidosIds.size,
      diferidos_venta_usd: sumTot('diferidos_venta_usd'),
      diferidos_cobrado_usd: sumTot('diferidos_cobrado_usd'),
      diferidos_por_cobrar_usd: sumTot('diferidos_por_cobrar_usd'),
      saldo_total_usd: r2(porAvion.reduce((s, a) => s + a.saldo_usd, 0)),
      por_avion: porAvion,
      vuelos_incluidos: incluidos.length,
      incluidos,
      derivado_de: 'cierre_mes_avion',
      aviones: orden.map((f) => ({
        aeronave_id: f.aeronave_id,
        matricula: f.matricula,
        version: f.version,
        cerrado_at: f.cerrado_at,
      })),
    };
    const snapshots = {
      precierre_snapshot: { listo: true, derivado_de: 'cierre_mes_avion' },
      reparto_snapshot: {
        periodo: { desde, hasta },
        derivado_de: 'cierre_mes_avion',
        aviones: orden.map(
          (f) => porId.get(f.aeronave_id)?.reparto_snapshot ?? {},
        ),
      },
      socios_snapshot: {
        mes: periodo,
        en_curso: false,
        derivado_de: 'cierre_mes_avion',
        aviones: orden
          .map((f) => porId.get(f.aeronave_id)?.socios_snapshot)
          .filter(
            (s): s is Record<string, unknown> =>
              !!s && typeof s === 'object' && 'aeronave' in s,
          ),
      },
      totales,
    };
    try {
      await this.escribirFilaCierre(periodo, global, snapshots, actor);
    } catch (e) {
      // Carrera: otro cierre derivó la global primero ⇒ ya está CERRADO.
      olvidarCierres(this.sb);
      const ahora = (await leerCierresMes(this.sb)).find(
        (f) => f.periodo === periodo,
      );
      if (ahora?.estado === 'CERRADO') return;
      throw e;
    }
  }

  /**
   * CIERRE GLOBAL DE TODA LA FLOTA, tal como el 0.0.103 (sin la migración por
   * avión): fila `cierre_mes` + bitácora `cierre_mes_vuelo`. Byte a byte.
   */
  private async cerrarFlotaLegado(
    periodo: string,
    dto: CerrarMesDto,
    actor: AuthenticatedUser,
    mesIni: string,
  ) {
    const filas = await leerCierresMes(this.sb);
    const fila = filas.find((f) => f.periodo === periodo) ?? null;
    // 4) Ya cerrado.
    if (fila?.estado === 'CERRADO') {
      throw this.errorYaCerrado(fila);
    }
    // 5) Mes anterior abierto (el primero desde el inicio no tiene).
    const anterior = mesAnteriorDe(periodo);
    if (
      anterior >= mesIni &&
      !filas.some((f) => f.periodo === anterior && f.estado === 'CERRADO')
    ) {
      throw conflicto(
        'MES_ANTERIOR_ABIERTO',
        textoMesAnteriorAbierto(periodo, anterior),
        { periodo_anterior: anterior },
      );
    }
    // 6) Pre-cierre listo; 7) la lista que vio el diálogo.
    const incluir = new Set(dto.incluir_vuelos ?? []);
    const prep = await this.prepararCierre(periodo, filas, mesIni, incluir);
    if (!prep.precierre.listo) {
      throw conflicto(
        'PRECIERRE_NO_LISTO',
        `Antes de cerrar ${etiquetaMesMinuscula(periodo)} resuelve los pendientes que bloquean el pre-cierre (${prep.previa.bloqueantes
          .map(textoBloqueantePrevia)
          .join('; ')}).`,
        { bloqueantes: prep.previa.bloqueantes },
      );
    }
    this.assertPreviaIgual(dto, prep);
    if (!prep.despues) {
      throw new InternalServerErrorException({
        message:
          'No se pudo calcular el reparto del mes sin los vuelos que pasan: vuelve a intentarlo en unos minutos.',
        error: 'CIERRE_REPARTO_FALLIDO',
      });
    }

    // Snapshots.
    const despues = prep.despues;
    const sociosSnapshot = utilidadMesDesdeAviones(
      periodo,
      despues.aviones,
      false,
    );
    const porAvion = despues.aviones.map((a) => ({
      aeronave_id: a.aeronave.id,
      matricula: a.aeronave.matricula,
      saldo_usd: r2(a.saldo_disponible_usd),
    }));
    const totales = {
      vuelos: prep.previa.totales.vuelos,
      vuelos_diferidos: prep.diferidos.length,
      diferidos_venta_usd: prep.previa.totales.pasan_venta_usd,
      diferidos_cobrado_usd: prep.previa.totales.pasan_cobrado_al_corte_usd,
      diferidos_por_cobrar_usd: prep.previa.totales.pasan_por_cobrar_usd,
      saldo_total_usd: r2(porAvion.reduce((s, a) => s + a.saldo_usd, 0)),
      por_avion: porAvion,
      // INCLUIR EN EL MES (21-oct-2026): los cobrados después del corte que
      // la oficina dejó en el mes (su `periodo_contable` no se toca).
      vuelos_incluidos: prep.incluidos.length,
      incluidos: prep.incluidos.map((d) => ({
        id: d.id,
        folio: d.folio,
        cobrado_posterior_usd: d.cobrado_posterior_usd ?? 0,
        fecha_cobro_posterior: d.fecha_cobro_posterior ?? null,
      })),
    };
    const snapshots = {
      precierre_snapshot: prep.precierre,
      reparto_snapshot: despues,
      socios_snapshot: sociosSnapshot,
      totales,
    };

    // (c) Fila del cierre con CAS.
    const version = await this.escribirFilaCierre(
      periodo,
      fila,
      snapshots,
      actor,
    );

    // (d) Diferimientos (CAS por mes contable) + bitácora; con compensación.
    const destino = mesSiguienteDe(periodo);
    try {
      await this.diferirVuelos(
        periodo,
        destino,
        version,
        prep.diferidos,
        actor,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Cierre de ${periodo} incompleto: ${msg}`);
      await this.marcarIncompleto(periodo, version, msg);
      throw new InternalServerErrorException({
        message: `No se pudo terminar el cierre de ${etiquetaMesMinuscula(periodo)}: ${msg}. No se movió ningún vuelo y el mes quedó abierto; vuelve a intentarlo.`,
        error: 'CIERRE_INCOMPLETO',
        details: { periodo },
      });
    }

    // (e) Memorias y aviso.
    olvidarCierres(this.sb);
    this.profitSharing.olvidarUtilidadesSocios();
    const releida = (await leerCierresMes(this.sb)).find(
      (f) => f.periodo === periodo,
    );
    const quien = releida?.cerrado_por?.nombre ?? actor.nombre ?? 'la oficina';
    const notificados = await this.notifications
      .notifyRole(
        Rol.ADMIN,
        {
          tipo: 'alerta_sistema',
          titulo: `${etiquetaMes(periodo)} cerrado`,
          cuerpo:
            `Cerró ${quien}. ` +
            (prep.diferidos.length > 0
              ? `${prep.diferidos.length} vuelo(s) pasan a ${etiquetaMesMinuscula(destino)} (por cobrar al cierre: US$${totales.diferidos_por_cobrar_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}). `
              : 'Ningún vuelo pasa al mes siguiente. ') +
            (prep.incluidos.length > 0
              ? `${prep.incluidos.length} vuelo(s) cobrados después del corte se quedan en ${etiquetaMesMinuscula(periodo)}. `
              : '') +
            `Saldo del reparto: US$${totales.saldo_total_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
          data: {
            periodo,
            version,
            vuelos_diferidos: prep.diferidos.length,
            vuelos_incluidos: prep.incluidos.length,
          },
          link: `/admin/reportes?desde=${rangoDelMes(periodo).desde}&hasta=${rangoDelMes(periodo).hasta}`,
        },
        actor.userId,
      )
      .catch(() => 0);

    return {
      cierre: {
        periodo,
        estado: 'CERRADO' as const,
        version,
        cerrado_at: releida?.cerrado_at ?? new Date().toISOString(),
        cerrado_por: releida?.cerrado_por ?? {
          id: actor.userId,
          nombre: actor.nombre,
        },
      },
      diferidos: prep.previa.vuelos_que_pasan,
      // INCLUIR EN EL MES (21-oct-2026).
      incluidos: prep.previa.vuelos_incluidos,
      totales: prep.previa.totales,
      reparto: {
        aviones: porAvion.map((a) => ({
          matricula: a.matricula,
          saldo_usd: a.saldo_usd,
        })),
        total_usd: totales.saldo_total_usd,
      },
      notificados,
    };
  }

  // ===================================================================
  // POST /v1/cierres/:periodo/reabrir
  // ===================================================================

  async reabrir(periodo: string, dto: ReabrirMesDto, actor: AuthenticatedUser) {
    CierresService.validarPeriodo(periodo);
    await this.assertDisponible();
    const ctx = await this.contextoFlota();
    if (!ctx) {
      if (dto.aeronave_id) throw errorCierrePorAvionNoDisponible();
      return this.reabrirLegado(periodo, dto, actor);
    }
    const filas = await leerCierresMes(this.sb);
    const global = filas.find((f) => f.periodo === periodo) ?? null;
    const cerradasMes = ctx.filasAvion.filter(
      (f) => f.periodo === periodo && f.estado === 'CERRADO',
    );
    // Cierre GLOBAL anterior a la migración por avión (sin filas por avión):
    // se reabre por el camino de siempre.
    if (!dto.aeronave_id && cerradasMes.length === 0) {
      if (global?.estado === 'CERRADO') {
        return this.reabrirLegado(periodo, dto, actor);
      }
      throw conflicto(
        'NO_ESTA_CERRADO',
        `${etiquetaMes(periodo)} no está cerrado: no hay nada que reabrir.`,
        { periodo },
      );
    }
    let objetivo: AeronaveFila[];
    if (dto.aeronave_id) {
      const a = ctx.aeronaves.find((x) => x.id === dto.aeronave_id);
      if (!a) {
        throw new NotFoundException({
          message: 'Ese avión no existe.',
          error: 'AERONAVE_NO_EXISTE',
          details: { aeronave_id: dto.aeronave_id },
        });
      }
      const fa = this.filaAvion(ctx, periodo, a.id);
      if (fa?.estado !== 'CERRADO') {
        // Sin fila propia pero con la flota cerrada por un cierre global
        // legado: ese avión solo se reabre reabriendo el mes completo.
        throw conflicto(
          'NO_ESTA_CERRADO',
          `${a.matricula} · ${etiquetaMes(periodo)} no está cerrado: no hay nada que reabrir.`,
          { periodo, aeronave: this.aeronaveCorta(a) },
        );
      }
      objetivo = [a];
    } else {
      objetivo = ctx.aeronaves
        .filter((a) => cerradasMes.some((f) => f.aeronave_id === a.id))
        .sort(porMatricula);
    }
    const objetivoIds = new Set(objetivo.map((a) => a.id));
    const siguiente = mesSiguienteDe(periodo);
    // Precondiciones de TODOS antes de escribir nada.
    const bitacoras = new Map<string, Array<Record<string, unknown>>>();
    for (const a of objetivo) {
      const fa = this.filaAvion(ctx, periodo, a.id) as CierreAvionLeido;
      if (this.mesesCerradosDelAvion(ctx, filas, a.id).has(siguiente)) {
        throw conflicto(
          'MES_SIGUIENTE_CERRADO',
          `${a.matricula}: ${textoMesSiguienteCerrado(siguiente)}`,
          { periodo_siguiente: siguiente, aeronave: this.aeronaveCorta(a) },
        );
      }
      const { data: bit, error: bErr } = await this.sb
        .from('cierre_mes_avion_vuelo')
        .select(
          'id, vuelo_id, folio, periodo_destino, periodo_contable_anterior, vuelo_aeronave_id',
        )
        .eq('periodo', `${periodo}-01`)
        .eq('aeronave_id', a.id)
        .eq('cierre_version', fa.version)
        .is('revertido_at', null);
      if (bErr) throw new Error(bErr.message);
      const lista = (bit ?? []) as Array<Record<string, unknown>>;
      bitacoras.set(a.id, lista);
      // OTRO_AVION_CERRADO (regla 2): un vuelo diferido por este cierre con
      // otro participante CERRADO en el mes (y que no se reabre junto).
      if (lista.length > 0) {
        const vuelos = await this.vuelosBasicos(
          lista.map((b) => String(b.vuelo_id)),
        );
        const participantes = await participantesDeVuelos(this.sb, vuelos);
        const otros = new Set<string>();
        for (const v of vuelos) {
          for (const p of participantes.get(v.id) ?? []) {
            if (p === a.id || objetivoIds.has(p)) continue;
            if (this.filaAvion(ctx, periodo, p)?.estado === 'CERRADO') {
              otros.add(p);
            }
          }
        }
        if (otros.size > 0) {
          const aviones = [...otros]
            .map((id) => ({
              aeronave_id: id,
              matricula:
                ctx.aeronaves.find((x) => x.id === id)?.matricula ?? id,
            }))
            .sort((x, y) => x.matricula.localeCompare(y.matricula, 'es'));
          const matriculas = aviones.map((x) => x.matricula);
          // El panel lee `details.matriculas` (y `aviones` con sus ids).
          throw conflicto(
            'OTRO_AVION_CERRADO',
            textoOtroAvionCerrado(periodo, a.matricula, matriculas),
            {
              periodo,
              aeronave: this.aeronaveCorta(a),
              matriculas,
              aviones,
            },
          );
        }
      }
    }
    const motivo = dto.motivo.trim();
    const ahora = new Date().toISOString();
    let revertidos = 0;
    const noRevertidos: Array<{
      vuelo_id: string;
      folio: number | null;
      motivo: string;
      aeronave_id?: string;
    }> = [];
    const reabiertos: AeronaveFila[] = [];
    for (const a of objetivo) {
      const fa = this.filaAvion(ctx, periodo, a.id) as CierreAvionLeido;
      const { data: upd, error: uErr } = await this.sb
        .from('cierre_mes_avion')
        .update({
          estado: 'REABIERTO',
          reabierto_at: ahora,
          reabierto_por: actor.userId,
          reabierto_motivo: motivo,
        })
        .eq('periodo', `${periodo}-01`)
        .eq('aeronave_id', a.id)
        .eq('estado', 'CERRADO')
        .eq('version', fa.version)
        .select('periodo');
      if (uErr) throw new Error(uErr.message);
      if (!upd || upd.length === 0) {
        olvidarCierres(this.sb);
        throw conflicto(
          'CIERRE_CONCURRENTE',
          `Alguien más cambió el cierre de ${a.matricula} en ${etiquetaMesMinuscula(periodo)} en este momento: recarga y vuelve a intentarlo.`,
          {
            periodo,
            aeronave: this.aeronaveCorta(a),
            reabiertos: reabiertos.map((x) => x.matricula),
          },
        );
      }
      reabiertos.push(a);
      // Revertir los diferimientos de ESTE cierre (versión vigente).
      for (const b of bitacoras.get(a.id) ?? []) {
        const destino = String(b.periodo_destino).slice(0, 7);
        const { data: v, error: vErr } = await this.sb
          .from('vuelo')
          .update({
            periodo_contable:
              (b.periodo_contable_anterior as string | null) ?? null,
            updated_by: actor.userId,
          })
          .eq('id', String(b.vuelo_id))
          .eq('periodo_contable', periodoContableDe(destino))
          .select('id');
        if (vErr || !v || v.length === 0) {
          noRevertidos.push({
            vuelo_id: String(b.vuelo_id),
            folio: b.folio == null ? null : Number(b.folio),
            motivo: vErr
              ? vErr.message
              : 'el vuelo ya no está en el mes al que pasó (otro cierre lo movió)',
            aeronave_id: a.id,
          });
          continue;
        }
        const { error: rErr } = await this.sb
          .from('cierre_mes_avion_vuelo')
          .update({ revertido_at: ahora, revertido_por: actor.userId })
          .eq('id', String(b.id));
        if (rErr) {
          this.logger.warn(
            `Reabrir ${periodo} (${a.matricula}): el vuelo ${String(b.vuelo_id)} regresó pero su bitácora no se marcó: ${rErr.message}`,
          );
        }
        revertidos += 1;
      }
    }
    // Fila global: la flota ya no está cerrada ⇒ REABIERTO (CAS).
    if (global?.estado === 'CERRADO') {
      const { error: gErr } = await this.sb
        .from('cierre_mes')
        .update({
          estado: 'REABIERTO',
          reabierto_at: ahora,
          reabierto_por: actor.userId,
          reabierto_motivo: motivo,
        })
        .eq('periodo', `${periodo}-01`)
        .eq('estado', 'CERRADO')
        .eq('version', global.version);
      if (gErr) throw new Error(gErr.message);
    }
    olvidarCierres(this.sb);
    this.profitSharing.olvidarUtilidadesSocios();
    const mes = await this.mesReleido(periodo);
    const cierres = (mes.aviones ?? []).filter((x) =>
      reabiertos.some((a) => a.id === x.aeronave_id),
    );
    const quien = actor.nombre ?? 'la oficina';
    const titulo = dto.aeronave_id
      ? `${objetivo[0].matricula} · ${etiquetaMes(periodo)} REABIERTO`
      : `${etiquetaMes(periodo)} REABIERTO (${reabiertos.length} avión(es))`;
    await this.notifications
      .notifyRole(
        Rol.ADMIN,
        {
          tipo: 'alerta_sistema',
          titulo,
          cuerpo: `${dto.aeronave_id ? `${objetivo[0].matricula} · ${etiquetaMesMinuscula(periodo)}` : `${etiquetaMes(periodo)} (${reabiertos.map((a) => a.matricula).join(', ')})`} REABIERTO por ${quien}: ${motivo}.${revertidos > 0 ? ` ${revertidos} vuelo(s) regresan a ${etiquetaMesMinuscula(periodo)}.` : ''}`,
          data: {
            periodo,
            aeronave_id: dto.aeronave_id ?? null,
            aviones: reabiertos.map((a) => a.matricula),
            revertidos,
            estado_mes: mes.estado,
          },
          link: `/admin/reportes?desde=${rangoDelMes(periodo).desde}&hasta=${rangoDelMes(periodo).hasta}`,
        },
        actor.userId,
      )
      .catch(() => 0);
    const primera = cierres[0] ?? null;
    return {
      aeronave: dto.aeronave_id ? this.aeronaveCorta(objetivo[0]) : null,
      cierres,
      mes,
      revertidos,
      no_revertidos: noRevertidos,
      // Compatibilidad con el contrato del 0.0.88 (`cierre`): el mes (flota).
      cierre: {
        periodo,
        estado: mes.estado,
        version: mes.version,
        reabierto_at: primera?.reabierto_at ?? ahora,
        reabierto_por: primera?.reabierto_por ?? {
          id: actor.userId,
          nombre: actor.nombre,
        },
        reabierto_motivo: motivo,
      },
    };
  }

  /** REABRIR el cierre global de toda la flota, tal como el 0.0.103. Byte a byte. */
  private async reabrirLegado(
    periodo: string,
    dto: ReabrirMesDto,
    actor: AuthenticatedUser,
  ) {
    const filas = await leerCierresMes(this.sb);
    const fila = filas.find((f) => f.periodo === periodo) ?? null;
    if (fila?.estado !== 'CERRADO') {
      throw conflicto(
        'NO_ESTA_CERRADO',
        `${etiquetaMes(periodo)} no está cerrado: no hay nada que reabrir.`,
        { periodo },
      );
    }
    const siguiente = mesSiguienteDe(periodo);
    if (filas.some((f) => f.periodo === siguiente && f.estado === 'CERRADO')) {
      throw conflicto(
        'MES_SIGUIENTE_CERRADO',
        textoMesSiguienteCerrado(siguiente),
        { periodo_siguiente: siguiente },
      );
    }
    const motivo = dto.motivo.trim();
    const ahora = new Date().toISOString();
    const { data: upd, error: uErr } = await this.sb
      .from('cierre_mes')
      .update({
        estado: 'REABIERTO',
        reabierto_at: ahora,
        reabierto_por: actor.userId,
        reabierto_motivo: motivo,
      })
      .eq('periodo', `${periodo}-01`)
      .eq('estado', 'CERRADO')
      .eq('version', fila.version)
      .select('periodo');
    if (uErr) throw new Error(uErr.message);
    if (!upd || upd.length === 0) {
      olvidarCierres(this.sb);
      throw conflicto(
        'CIERRE_CONCURRENTE',
        `Alguien más cambió el cierre de ${etiquetaMesMinuscula(periodo)} en este momento: recarga y vuelve a intentarlo.`,
        { periodo },
      );
    }
    // Revertir los diferimientos de ESTE cierre (versión vigente).
    const { data: bit, error: bErr } = await this.sb
      .from('cierre_mes_vuelo')
      .select('id, vuelo_id, folio, periodo_destino, periodo_contable_anterior')
      .eq('periodo', `${periodo}-01`)
      .eq('cierre_version', fila.version)
      .is('revertido_at', null);
    if (bErr) throw new Error(bErr.message);
    let revertidos = 0;
    const noRevertidos: Array<{
      vuelo_id: string;
      folio: number | null;
      motivo: string;
    }> = [];
    for (const b of (bit ?? []) as Array<{
      id: string;
      vuelo_id: string;
      folio: number | null;
      periodo_destino: string;
      periodo_contable_anterior: string | null;
    }>) {
      const destino = String(b.periodo_destino).slice(0, 7);
      const { data: v, error: vErr } = await this.sb
        .from('vuelo')
        .update({
          periodo_contable: b.periodo_contable_anterior,
          updated_by: actor.userId,
        })
        .eq('id', b.vuelo_id)
        .eq('periodo_contable', periodoContableDe(destino))
        .select('id');
      if (vErr || !v || v.length === 0) {
        noRevertidos.push({
          vuelo_id: b.vuelo_id,
          folio: b.folio,
          motivo: vErr
            ? vErr.message
            : 'el vuelo ya no está en el mes al que pasó (otro cierre lo movió)',
        });
        continue;
      }
      const { error: rErr } = await this.sb
        .from('cierre_mes_vuelo')
        .update({ revertido_at: ahora, revertido_por: actor.userId })
        .eq('id', b.id);
      if (rErr) {
        this.logger.warn(
          `Reabrir ${periodo}: el vuelo ${b.vuelo_id} regresó pero su bitácora no se marcó: ${rErr.message}`,
        );
      }
      revertidos += 1;
    }
    olvidarCierres(this.sb);
    this.profitSharing.olvidarUtilidadesSocios();
    const releida = (await leerCierresMes(this.sb)).find(
      (f) => f.periodo === periodo,
    );
    const quien =
      releida?.reabierto_por?.nombre ?? actor.nombre ?? 'la oficina';
    await this.notifications
      .notifyRole(
        Rol.ADMIN,
        {
          tipo: 'alerta_sistema',
          titulo: `${etiquetaMes(periodo)} REABIERTO`,
          cuerpo: `${etiquetaMes(periodo)} REABIERTO por ${quien}: ${motivo}.${revertidos > 0 ? ` ${revertidos} vuelo(s) regresan a ${etiquetaMesMinuscula(periodo)}.` : ''}`,
          data: { periodo, revertidos },
          link: `/admin/reportes?desde=${rangoDelMes(periodo).desde}&hasta=${rangoDelMes(periodo).hasta}`,
        },
        actor.userId,
      )
      .catch(() => 0);
    return {
      cierre: {
        periodo,
        estado: 'REABIERTO' as const,
        version: fila.version,
        reabierto_at: releida?.reabierto_at ?? ahora,
        reabierto_por: releida?.reabierto_por ?? {
          id: actor.userId,
          nombre: actor.nombre,
        },
        reabierto_motivo: motivo,
      },
      revertidos,
      no_revertidos: noRevertidos,
    };
  }
}

/** Columnas de `cierre_mes` que el servicio lee (re-export para specs). */
export { CIERRE_MES_COLS };
