/**
 * COLA PERSISTENTE del espejo sistema → Google Calendar (12-sep-2026).
 *
 * Pedido del cliente: «el calendario debe sincronizarse de forma AUTOMÁTICA
 * cada que se realizan cambios, sin sincronización manual […] analiza a
 * profundidad para que NUNCA falle; contempla los ajustes que se hacen
 * offline en la app y suben al reconectar».
 *
 * Piezas PURAS y la SONDA de la migración `20260912000002_calendar_sync_cola`
 * (tabla `calendar_sync_cola` + triggers). Todo lo que habla con Google vive
 * en `calendar-sync.service.ts`; acá solo hay decisiones sin efectos
 * secundarios (y por eso se prueban solas).
 *
 * TOLERANCIA A LA MIGRACIÓN NO APLICADA (mismo patrón que
 * `ColumnaOpcional`/`TriggerUpdatedAt`): mientras la cola no exista, el API se
 * comporta EXACTAMENTE como hoy (hooks directos a Google, best-effort) y no
 * consulta la tabla; al aplicar la migración se enciende solo en ≤ 10 min,
 * sin redeploy.
 */
import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { estadoHttpGoogle } from './google-evento.util';

/** Migración que crea la cola, los triggers y la sonda. */
export const MIGRACION_CALENDAR_SYNC_COLA = '20260912000002';

/** Función SQL (rpc) que responde si la cola + sus triggers están puestos. */
export const RPC_CALENDAR_SYNC_COLA_ACTIVA = 'calendar_sync_cola_activa';

/** Tabla de la cola. */
export const TABLA_CALENDAR_SYNC_COLA = 'calendar_sync_cola';

/** Ventana mínima entre sondeos cuando la cola NO está. */
export const COLA_SONDA_REINTENTO_MS = 10 * 60_000;

/** Items que toma el worker en cada pasada (secuencial). */
export const COLA_TOMA_MAX = 50;

/** Un reclamo (`tomado_at`) más viejo que esto = el proceso murió. */
export const COLA_TOMADO_VENCE_MS = 5 * 60_000;

/** Pausa del drenado completo cuando Google responde cuota/429. */
export const COLA_PAUSA_CUOTA_MS = 5 * 60_000;

/** Base y techo del backoff exponencial. */
export const COLA_BACKOFF_BASE_MS = 30_000;
export const COLA_BACKOFF_TOPE_MS = 60 * 60_000;

/** «Drenar pronto» tras un hook: debounce (une la ráfaga de un guardado). */
export const COLA_DEBOUNCE_MS = 2_000;

/** Intentos a partir de los cuales el item se considera ATORADO. */
export const COLA_ALERTA_INTENTOS = 12;

/** Antigüedad (sin lograr subir) a partir de la cual se avisa a ADMIN. */
export const COLA_ALERTA_ANTIGUEDAD_MS = 30 * 60_000;

/** Clave de dedupe en `alerta_emitida` (varchar(40)). */
export const COLA_ALERTA_CLAVE = 'calendar_sync_cola';

/** Tipos de trabajo de la cola (espejo del CHECK de la tabla). */
export type EntidadCola =
  | 'vuelo'
  | 'descanso'
  | 'evento'
  | 'mantenimiento'
  | 'borrar_evento';

/** Fila de `calendar_sync_cola` tal como la lee el worker. */
export interface ItemCola {
  id: number;
  entidad: EntidadCola;
  entidad_id: string | null;
  google_event_id: string | null;
  intentos: number;
  creado_at: string;
  /** Sello del reclamo: el borrado/reprogramado del item lo exige igual. */
  tomado_at: string | null;
}

/**
 * Estado de la cola que viaja en `GET /v1/calendar/sync-estado` (D5) para el
 * chip del panel. `null` (en `EstadoSyncCalendar.cola`) = la migración no
 * está aplicada: el API sigue con los hooks directos de siempre.
 */
export interface EstadoColaCalendar {
  /** Siempre `true` cuando el objeto existe (la cola respondió). */
  activa: boolean;
  /** Cambios esperando turno (incluye los que están en backoff). */
  pendientes: number;
  /** De esos, cuántos ya fallaron al menos una vez. */
  con_error: number;
  /** `creado_at` del más viejo sin subir (ISO) o null si la cola está vacía. */
  mas_antiguo_at: string | null;
  /** Último error textual de la cola, sin secretos (para el chip ámbar). */
  ultimo_error: string | null;
  /** Última vez que el worker drenó (ISO); null si no ha corrido. */
  ultimo_drenado_at: string | null;
  /** Si Google contestó cuota/429: hasta cuándo está pausado el drenado. */
  pausada_hasta: string | null;
}

/**
 * Espera antes del PRÓXIMO intento: `min(30 s * 2^intentos, 1 h)` con
 * `intentos` = los fallos YA acumulados INCLUYENDO el de ahora (1 ⇒ 1 min,
 * 2 ⇒ 2 min … 7+ ⇒ 1 h). Con eso, 12 intentos ≈ 1 h de reintentos antes de
 * molestar a nadie, y a partir de ahí uno por hora para siempre: un item
 * JAMÁS se descarta.
 */
export function siguienteIntentoMs(intentos: number): number {
  const n = Number.isFinite(intentos) ? Math.max(0, Math.trunc(intentos)) : 0;
  // 2^n crece rápido: se acota antes de multiplicar para no desbordar.
  const factor = n >= 12 ? 4096 : 2 ** n;
  return Math.min(COLA_BACKOFF_BASE_MS * factor, COLA_BACKOFF_TOPE_MS);
}

/**
 * ¿Google está rechazando por CUOTA o exceso de peticiones (403 / 429)? En
 * ese caso seguir drenando solo quema intentos de todos los items: el worker
 * pausa el drenado completo 5 min y nadie pierde su turno.
 */
export function esLimiteGoogle(err: unknown): boolean {
  const s = estadoHttpGoogle(err);
  if (s === 429) return true;
  if (s !== 403) return false;
  // 403 también aparece por permisos (la service account dejó de ser OWNER):
  // pausar igual es lo correcto — nada va a subir en los próximos minutos.
  return true;
}

/**
 * Texto de error para `ultimo_error` (y para el aviso a ADMIN): recortado y
 * SIN secretos — la URL de Google lleva `key=`/`access_token=` en algunos
 * errores y esta columna la lee el panel.
 */
export function sanitizarError(texto: string, max = 400): string {
  const limpio = (texto ?? '')
    .replace(
      /(key|access_token|token|refresh_token|private_key)=([^&\s"']+)/gi,
      '$1=***',
    )
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '***')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length > max ? `${limpio.slice(0, max - 1)}…` : limpio;
}

/**
 * ¿Hay que avisar a ADMIN? (D4) Sí cuando algún item ya lleva ≥ 12 intentos
 * (≈ 1 h de backoff) o cuando el más viejo de la cola nació hace más de
 * 30 min y sigue ahí. Puro para poder congelarlo en pruebas.
 */
export function colaAtorada(
  estado: {
    pendientes: number;
    mas_antiguo_at: string | null;
    max_intentos: number;
  },
  ahoraMs: number,
): boolean {
  if (estado.pendientes <= 0) return false;
  if (estado.max_intentos >= COLA_ALERTA_INTENTOS) return true;
  if (!estado.mas_antiguo_at) return false;
  const t = new Date(estado.mas_antiguo_at).getTime();
  if (!Number.isFinite(t)) return false;
  return ahoraMs - t > COLA_ALERTA_ANTIGUEDAD_MS;
}

/** Hora de pared en Cancún (HH:MM) de un instante ISO. */
export function horaCancun(iso: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Cancun',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * Texto del aviso a ADMIN, en el idioma del cliente y sin jerga: dice qué
 * pasa, desde cuándo y con qué error, para que alguien pueda actuar.
 */
export function textoAvisoCola(estado: {
  pendientes: number;
  mas_antiguo_at: string | null;
  ultimo_error: string | null;
}): string {
  const desde = estado.mas_antiguo_at
    ? ` desde las ${horaCancun(estado.mas_antiguo_at)}`
    : '';
  const cambios =
    estado.pendientes === 1 ? '1 cambio' : `${estado.pendientes} cambios`;
  const error = estado.ultimo_error
    ? `; último error: ${estado.ultimo_error}`
    : '';
  return `La sincronización con Google Calendar lleva ${cambios} sin poder subir${desde}${error}.`;
}

// ===== SONDA DE LA MIGRACIÓN =====

export interface ColaSondaOpciones {
  reintentoMs?: number;
  /** Reloj inyectable (specs). */
  ahora?: () => number;
}

/**
 * ¿Está la cola operativa? (tabla + los 5 triggers). Reglas de memoria:
 * - `true` → memorizado para siempre (una migración no se des-aplica sola;
 *   si alguien tira los triggers, el rollback documentado es un redeploy);
 * - `false` (función ausente / triggers incompletos) → memorizado ≤ 10 min y
 *   se re-sondea: aplicar la migración ENCIENDE el modo automático sin
 *   reiniciar el API. Un solo `warn`;
 * - error raro o excepción (red, permisos) → `false` SIN memorizar: el modo
 *   SEGURO es el de hoy (hooks directos), porque asumir una cola que no
 *   existe dejaría los cambios sin subir a Google.
 */
export class ColaSondaCalendar {
  private readonly logger = new Logger(ColaSondaCalendar.name);
  private readonly reintentoMs: number;
  private readonly ahora: () => number;
  /** null = sin sondear; true = activa (definitivo); false = no activa. */
  private estado: boolean | null = null;
  private ultimoSondeoMs = 0;
  private sondeoEnCurso: Promise<boolean> | null = null;
  private avisado = false;

  constructor(
    private readonly supabase: SupabaseClient,
    opts: ColaSondaOpciones = {},
  ) {
    this.reintentoMs = opts.reintentoMs ?? COLA_SONDA_REINTENTO_MS;
    this.ahora = opts.ahora ?? (() => Date.now());
  }

  /** Último valor conocido SIN sondear (para lecturas síncronas). */
  get ultimoConocido(): boolean {
    return this.estado === true;
  }

  async activa(): Promise<boolean> {
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

  private noActiva(motivo: string): boolean {
    this.estado = false;
    if (!this.avisado) {
      this.avisado = true;
      this.logger.warn(
        `Cola de sincronización a Google Calendar no disponible (${motivo}): el espejo sigue siendo best-effort por hooks hasta aplicar la migración ${MIGRACION_CALENDAR_SYNC_COLA}`,
      );
    }
    return false;
  }

  private async sondear(): Promise<boolean> {
    this.ultimoSondeoMs = this.ahora();
    try {
      const res = await this.supabase.rpc(RPC_CALENDAR_SYNC_COLA_ACTIVA);
      const error = res?.error ?? null;
      if (error) return this.noActiva(error.message ?? 'rpc con error');
      if (res?.data === true) {
        if (this.estado === false) {
          this.logger.log(
            'Cola de sincronización a Google Calendar ACTIVA: el espejo pasa a modo automático (worker cada 20 s)',
          );
        }
        this.estado = true;
        return true;
      }
      return this.noActiva('la sonda respondió false');
    } catch (e) {
      // Excepción (red, cliente sin `rpc`): modo SEGURO = el de hoy, y se
      // re-sondea en ≤ 10 min (no se memoriza «para siempre» como el true).
      return this.noActiva(
        `la sonda no respondió: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
