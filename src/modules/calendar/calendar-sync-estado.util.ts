/**
 * ESTADO PERSISTIDO + CANDADO EN BD del espejo sistema → Google Calendar
 * (D12, 12-sep-2026).
 *
 * Dos piezas que necesita la «red de seguridad» para que el espejo NUNCA
 * falle y para que el panel pueda demostrarlo:
 *
 * 1. **RESUMEN PERSISTIDO** (`calendar_sync_estado`, clave → jsonb): hasta hoy
 *    `ultimo_reconcile_at` / `ultimo_resync_at` / `ultimo_resumen` /
 *    `ultimo_drenado_at` / `pausada_hasta` vivían SOLO en memoria del proceso,
 *    así que un redeploy de Railway (o el reinicio del contenedor) los dejaba
 *    en `null` y `GET /v1/calendar/sync-estado` respondía «nunca corrió»
 *    aunque el reconcile hubiera corrido esa madrugada. Ahora se guardan en la
 *    BD y la memoria queda como CACHÉ (se rehidrata al arrancar).
 *    `configuracion_sistema` NO servía: está modelada como
 *    `clave/activa/descripcion` (banderas booleanas), sin columna de valor
 *    JSON — por eso la tabla nueva.
 *
 * 2. **CANDADO MULTI-RÉPLICA** (`calendar_sync_lock` / `calendar_sync_unlock`):
 *    el reconcile nocturno y el drenado escriben DIRECTO a Google. Las
 *    banderas `barriendo` / `drenando` del servicio son de MEMORIA: excluyen
 *    dos pasadas del MISMO proceso, no dos réplicas. Railway corre **1
 *    réplica hoy**, así que esto es preventivo: el día que se escale a 2, dos
 *    reconciles simultáneos podrían hacer `events.insert` del mismo evento y
 *    dejar un DUPLICADO fantasma (id que no vive en ninguna fila).
 *
 * TOLERANCIA A LA MIGRACIÓN NO APLICADA (mismo patrón que
 * `ColaSondaCalendar` / `ColumnaOpcional` / `TriggerUpdatedAt`): mientras
 * `20260912000002` no esté aplicada, la sonda dice `false`, no se consulta
 * ninguna tabla nueva y todo se comporta EXACTAMENTE como hoy (estado solo en
 * memoria, exclusión solo por banderas). Aplicar la migración lo enciende en
 * ≤ 10 min sin redeploy.
 */
import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { esFuncionInexistente } from '../../common/updated-at-trigger.util';

/** Migración que crea la tabla de estado, el candado y la sonda. */
export const MIGRACION_CALENDAR_SYNC_ESTADO = '20260912000002';

/** Sonda: tabla de estado + candado + sus dos funciones. */
export const RPC_CALENDAR_SYNC_ESTADO_ACTIVA = 'calendar_sync_estado_activa';

/** Tabla clave → jsonb del estado visible de la sync. */
export const TABLA_CALENDAR_SYNC_ESTADO = 'calendar_sync_estado';

/** Funciones del candado (arrendamiento con vencimiento). */
export const RPC_CALENDAR_SYNC_LOCK = 'calendar_sync_lock';
export const RPC_CALENDAR_SYNC_UNLOCK = 'calendar_sync_unlock';

/** Fila con lo que sobrevive a un redeploy del barrido (cron + resync). */
export const CLAVE_ESTADO_SYNC = 'sync';

/** Fila con lo que sobrevive a un redeploy del worker de la cola. */
export const CLAVE_ESTADO_WORKER = 'worker';

/** Ventana mínima entre sondeos cuando la migración NO está. */
export const ESTADO_SONDA_REINTENTO_MS = 10 * 60_000;

/**
 * Claves del candado (enteros: `pg_try_advisory_xact_lock` los toma como
 * `bigint`). Fijas y documentadas: dos claves distintas = el barrido y el
 * drenado no se estorban entre sí (la exclusión barrido↔worker sigue siendo
 * la de memoria, que es intra-proceso y no cuesta una consulta).
 */
export const CANDADO_BARRIDO = 912_001;
export const CANDADO_DRENADO = 912_002;

/**
 * Vencimiento del arrendamiento (TTL). Si el proceso muere a mitad del
 * barrido, el candado se cura solo al pasar este tiempo — nunca deja la red
 * de seguridad muerta «para siempre».
 *
 * El barrido nocturno recorre [hoy−30d, hoy+365d] SECUENCIAL: con ~12 000
 * eventos a ~150 ms puede tardar media hora larga, así que 2 h de holgura.
 */
export const CANDADO_BARRIDO_TTL_SEG = 2 * 60 * 60;
/** Una pasada del worker son ≤ 50 items: 5 min bastan de sobra. */
export const CANDADO_DRENADO_TTL_SEG = 5 * 60;

/**
 * `concedido` = corre y al terminar SUELTA; `ocupado` = otra réplica lo está
 * haciendo, esta pasada se salta; `sin_candado` = la migración no está (o la
 * BD no contestó) ⇒ **se corre igual**, como hoy, con las banderas de memoria
 * como única exclusión. Nunca se cancela la red de seguridad por no poder
 * tomar un candado: eso sería peor que el riesgo que evita.
 */
export type ResultadoCandado = 'concedido' | 'ocupado' | 'sin_candado';

/** Resumen de una pasada tal como se persiste (y se relee al arrancar). */
export interface ResumenPersistidoCalendar {
  origen: 'resync' | 'reconcile';
  vuelos: number;
  descansos: number;
  eventos: number;
  mantenimientos: number;
  errores: number;
  huerfanos_borrados: number;
  desde: string;
  hasta: string;
  at: string;
}

/** Fila `sync`: los «últimos» del barrido. */
export interface EstadoSyncPersistido {
  ultimo_reconcile_at: string | null;
  ultimo_resync_at: string | null;
  ultimo_resumen: ResumenPersistidoCalendar | null;
}

/** Fila `worker`: los «últimos» del drenado de la cola. */
export interface EstadoWorkerPersistido {
  ultimo_drenado_at: string | null;
  pausada_hasta: string | null;
}

const texto = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

const entero = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
};

/**
 * Valida lo leído de la BD (PURO). Un JSON viejo o a medias NO debe reventar
 * `GET /calendar/sync-estado`: lo que no cuadra se descarta y el campo queda
 * en `null` como antes de este lote.
 */
export function parseResumenPersistido(
  valor: unknown,
): ResumenPersistidoCalendar | null {
  if (valor == null || typeof valor !== 'object') return null;
  const v = valor as Record<string, unknown>;
  const origen =
    v.origen === 'resync' || v.origen === 'reconcile' ? v.origen : null;
  const at = texto(v.at);
  const desde = texto(v.desde);
  const hasta = texto(v.hasta);
  if (!origen || !at || !desde || !hasta) return null;
  return {
    origen,
    vuelos: entero(v.vuelos),
    descansos: entero(v.descansos),
    eventos: entero(v.eventos),
    mantenimientos: entero(v.mantenimientos),
    errores: entero(v.errores),
    huerfanos_borrados: entero(v.huerfanos_borrados),
    desde,
    hasta,
    at,
  };
}

/** Fila `sync` validada (PURO). */
export function parseEstadoSync(valor: unknown): EstadoSyncPersistido {
  const v = (valor ?? {}) as Record<string, unknown>;
  return {
    ultimo_reconcile_at: texto(v.ultimo_reconcile_at),
    ultimo_resync_at: texto(v.ultimo_resync_at),
    ultimo_resumen: parseResumenPersistido(v.ultimo_resumen),
  };
}

/** Fila `worker` validada (PURO). */
export function parseEstadoWorker(valor: unknown): EstadoWorkerPersistido {
  const v = (valor ?? {}) as Record<string, unknown>;
  return {
    ultimo_drenado_at: texto(v.ultimo_drenado_at),
    pausada_hasta: texto(v.pausada_hasta),
  };
}

export interface EstadoCalendarBdOpciones {
  reintentoMs?: number;
  /** Reloj inyectable (specs). */
  ahora?: () => number;
}

/**
 * Acceso a la parte NUEVA de la migración (estado persistido + candado), con
 * la sonda tolerante adentro. Un solo objeto para que el servicio no tenga
 * que saber si la migración está aplicada: si no lo está, `leer` devuelve
 * `null`, `guardar` no escribe y `tomarCandado` responde `sin_candado`.
 *
 * Reglas de memoria de la sonda (idénticas a `ColaSondaCalendar`):
 * - `true` → memorizado para siempre;
 * - `false` (función ausente) → memorizado ≤ 10 min y se re-sondea: aplicar la
 *   migración lo enciende sin reiniciar el API. Un solo `warn`;
 * - error raro / excepción → `false` con la misma ventana: el modo SEGURO es
 *   el de hoy (estado en memoria, sin candado).
 */
export class EstadoCalendarBd {
  private readonly logger = new Logger(EstadoCalendarBd.name);
  /**
   * Quién soy, para la columna `dueno` del candado (revisión adversaria
   * 12-sep-2026). Dos usos: (a) `calendar_sync_candado` deja de ser una fila
   * anónima —en la BD se ve QUÉ proceso tiene tomado el barrido, que es lo
   * primero que se pregunta cuando `POST /resync` responde 409—; y (b) el
   * `unlock` se acota al dueño, así que una réplica que termina TARDÍSIMO no
   * borra el arrendamiento que otra acaba de tomar (con el TTL vencido, esa
   * otra sí lo tomó legítimamente).
   */
  private readonly dueno = `api:${process.pid}:${Date.now().toString(36)}`;
  private readonly reintentoMs: number;
  private readonly ahora: () => number;
  private estado: boolean | null = null;
  private ultimoSondeoMs = 0;
  private sondeoEnCurso: Promise<boolean> | null = null;
  private avisado = false;

  constructor(
    private readonly supabase: SupabaseClient,
    opts: EstadoCalendarBdOpciones = {},
  ) {
    this.reintentoMs = opts.reintentoMs ?? ESTADO_SONDA_REINTENTO_MS;
    this.ahora = opts.ahora ?? (() => Date.now());
  }

  /** ¿Están la tabla de estado y el candado? Nunca lanza. */
  async disponible(): Promise<boolean> {
    if (this.estado === true) return true;
    if (
      this.estado === false &&
      this.ahora() - this.ultimoSondeoMs < this.reintentoMs
    ) {
      return false;
    }
    if (!this.sondeoEnCurso) {
      this.sondeoEnCurso = this.sondear().finally(() => {
        this.sondeoEnCurso = null;
      });
    }
    return this.sondeoEnCurso;
  }

  /** Olvida lo memorizado (specs). */
  reset(): void {
    this.estado = null;
    this.ultimoSondeoMs = 0;
    this.sondeoEnCurso = null;
    this.avisado = false;
  }

  private noDisponible(motivo: string): boolean {
    this.estado = false;
    if (!this.avisado) {
      this.avisado = true;
      this.logger.warn(
        `Estado persistido y candado de la sincronización a Google Calendar no disponibles (${motivo}): los «últimos» siguen SOLO en memoria y la exclusión sigue siendo por banderas, hasta aplicar la migración ${MIGRACION_CALENDAR_SYNC_ESTADO}`,
      );
    }
    return false;
  }

  private async sondear(): Promise<boolean> {
    this.ultimoSondeoMs = this.ahora();
    try {
      const res = await this.supabase.rpc(RPC_CALENDAR_SYNC_ESTADO_ACTIVA);
      const error = res?.error ?? null;
      if (error) {
        return this.noDisponible(
          esFuncionInexistente(error)
            ? 'la función no existe'
            : (error.message ?? 'rpc con error'),
        );
      }
      if (res?.data === true) {
        if (this.estado === false) {
          this.logger.log(
            'Estado persistido de la sincronización a Google Calendar ACTIVO: los «últimos» y el candado multi-réplica ya sobreviven a un redeploy',
          );
        }
        this.estado = true;
        return true;
      }
      return this.noDisponible('la sonda respondió false');
    } catch (e) {
      return this.noDisponible(
        `la sonda no respondió: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Lee una fila de estado.
   *
   * `ok: false` = no se pudo LEER (migración pendiente, o la BD contestó con
   * error). Es distinto de `ok: true, valor: null` (la fila todavía no
   * existe): con el primero el servicio debe VOLVER A INTENTAR la
   * hidratación, o un blip de red al arrancar dejaría el panel diciendo
   * «nunca corrió» hasta la madrugada siguiente.
   */
  async leer(clave: string): Promise<{ ok: boolean; valor: unknown }> {
    if (!(await this.disponible())) return { ok: false, valor: null };
    try {
      const { data, error } = (await this.supabase
        .from(TABLA_CALENDAR_SYNC_ESTADO)
        .select('valor')
        .eq('clave', clave)
        .maybeSingle()) as {
        data: { valor: unknown } | null;
        error: { message: string } | null;
      };
      if (error) throw new Error(error.message);
      return { ok: true, valor: data?.valor ?? null };
    } catch (e) {
      this.logger.warn(
        `No se pudo leer el estado «${clave}» de la sincronización a Google Calendar: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ok: false, valor: null };
    }
  }

  /** Guarda (upsert) una fila de estado. Best-effort: nunca lanza. */
  async guardar(clave: string, valor: Record<string, unknown>): Promise<void> {
    if (!(await this.disponible())) return;
    try {
      const { error } = await this.supabase
        .from(TABLA_CALENDAR_SYNC_ESTADO)
        .upsert(
          { clave, valor, actualizado_at: new Date().toISOString() },
          { onConflict: 'clave' },
        );
      if (error) throw new Error(error.message);
    } catch (e) {
      this.logger.warn(
        `No se pudo guardar el estado «${clave}» de la sincronización a Google Calendar: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Toma el candado de la BD. `sin_candado` (migración pendiente o BD que no
   * contesta) = se corre igual, como hoy.
   */
  async tomarCandado(clave: number, ttlSeg: number): Promise<ResultadoCandado> {
    if (!(await this.disponible())) return 'sin_candado';
    try {
      const { data, error } = (await this.supabase.rpc(RPC_CALENDAR_SYNC_LOCK, {
        p_clave: clave,
        p_ttl_seg: ttlSeg,
        p_dueno: this.dueno,
      })) as { data: unknown; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data === true ? 'concedido' : 'ocupado';
    } catch (e) {
      this.logger.warn(
        `No se pudo tomar el candado ${clave} de la sincronización a Google Calendar: ${e instanceof Error ? e.message : String(e)} — se continúa con la exclusión en memoria`,
      );
      return 'sin_candado';
    }
  }

  /** Suelta el candado. Best-effort: el TTL lo libera igual si esto falla. */
  async soltarCandado(clave: number): Promise<void> {
    if (!(await this.disponible())) return;
    try {
      const { error } = (await this.supabase.rpc(RPC_CALENDAR_SYNC_UNLOCK, {
        p_clave: clave,
        p_dueno: this.dueno,
      })) as { error: { message: string } | null };
      if (error) throw new Error(error.message);
    } catch (e) {
      this.logger.warn(
        `No se pudo soltar el candado ${clave} de la sincronización a Google Calendar (vence solo): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
