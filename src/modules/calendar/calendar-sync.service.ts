import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { calendar_v3, google } from 'googleapis';
import { JWT } from 'google-auth-library';
import type { EnvVars } from '../../config/env.schema';
import { Rol } from '../../common/types/auth.types';
import { NotificationsService } from '../realtime/notifications.service';
import { SupabaseService } from '../supabase/supabase.service';
import { esColumnaInexistente } from '../../common/columna-opcional.util';
import {
  colorIdGoogleDescanso,
  colorIdGoogleDeVuelo,
  colorIdGoogleEvento,
  colorIdGoogleMantenimiento,
  descripcionEventoVuelo,
  eventoAusenteEnGoogle,
  horaCortaCancun,
  nombreCortoPiloto,
  parsearServiceAccountJson,
  rutaMinusculas,
  tituloEventoVuelo,
  ventanaEventoVuelo,
  type TramoEventoVuelo,
} from './google-evento.util';
import {
  ANCLA_DESCANSO,
  ANCLA_EVENTO,
  ANCLA_MANTENIMIENTO,
  ANCLA_VUELO,
  clasificarEventoSistema,
  decidirHuerfano,
  esRecienCreado,
  esUuidCalendar,
  HUERFANOS_BORRADO_TOPE,
  HUERFANOS_PAGINA_MAX,
  HUERFANOS_PAGINAS_TOPE,
  lotesDe,
  type EventoSistemaGoogle,
  type TipoAnclaCalendar,
} from './calendar-huerfanos.util';
import {
  CANDADO_BARRIDO,
  CANDADO_BARRIDO_TTL_SEG,
  CANDADO_DRENADO,
  CANDADO_DRENADO_TTL_SEG,
  CLAVE_ESTADO_SYNC,
  CLAVE_ESTADO_WORKER,
  EstadoCalendarBd,
  parseEstadoSync,
  parseEstadoWorker,
  type ResultadoCandado,
} from './calendar-sync-estado.util';
import {
  COLA_ALERTA_CLAVE,
  COLA_DEBOUNCE_MS,
  COLA_PAUSA_CUOTA_MS,
  COLA_TOMADO_VENCE_MS,
  COLA_TOMA_MAX,
  ColaSondaCalendar,
  colaAtorada,
  esLimiteGoogle,
  sanitizarError,
  siguienteIntentoMs,
  TABLA_CALENDAR_SYNC_COLA,
  textoAvisoCola,
  type EstadoColaCalendar,
  type ItemCola,
} from './calendar-sync-cola.util';

/**
 * Cómo se pide un espejo (12-sep-2026, cola automática):
 * - sin opciones = viene de un HOOK de negocio. Con la cola activa el trigger
 *   YA encoló el cambio, así que el hook solo pide «drenar pronto» y NO habla
 *   con Google (una sola ruta de escritura, cero doble escritura);
 * - `{ directo: true }` = lo pide el WORKER de la cola o el barrido
 *   (`sincronizarVentana`, red de seguridad): escribe a Google ahora mismo.
 */
export interface OpcionesEspejo {
  directo?: boolean;
}

// NINGÚN colorId suelto vive acá (12-sep-2026): todo color sale de la paleta
// del sistema (`colores-calendario.util`) traducida al más cercano de Google
// por `google-evento.util`. Si el cliente cambia un color, se cambia allá y el
// panel, la app y Google se mueven JUNTOS.

const VUELO_SELECT_BASE =
  'id, folio, estado, es_externo, operador_externo, avion_externo_matricula, origen_iata, destino_iata, pasajeros, monto_total_usd, fecha_vuelo, fecha_traslado_final, tipo, notas, estado_permiso, aeronave_id, piloto_id, google_calendar_id, google_calendar_regreso_id, ' +
  'aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre@APODO@), cliente:cliente_id(nombre), ' +
  'escalas:escala(id, orden, origen_iata, destino_iata, fecha_salida_plan, es_ferry, pasajeros, google_calendar_id, aeronave_id, piloto_id, estado_permiso, cancelada_at, aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre@APODO@))';

/**
 * Con `usuario.apodo` (migración `20260917000001`): el TÍTULO de la fila del
 * mecánico usa el apodo de la oficina («Saab», «Zamora», «Pab») antes que el
 * primer nombre.
 */
const VUELO_SELECT = VUELO_SELECT_BASE.replace(/@APODO@/g, ', apodo');

/**
 * El MISMO select SIN `apodo`, para el hueco entre desplegar el API y aplicar
 * la migración: PostgREST responde 42703 y CUALQUIER sincronización del
 * calendario moriría. Ver `loadVuelo` (se degrada una sola vez y avisa).
 */
const VUELO_SELECT_SIN_APODO = VUELO_SELECT_BASE.replace(/@APODO@/g, '');

/** Migración que crea `usuario.apodo` (nombre corto del piloto, 17-sep-2026). */
const MIGRACION_APODO = '20260917000001';

const MANT_SELECT =
  'id, estado, descripcion, fecha_programada, horas_programadas, etapa_intervalo_hr, google_calendar_id, aeronave:aeronave_id(matricula, color_calendario)';

/**
 * Los eventos que la oficina captura A MANO en ese Google Calendar NO se
 * tocan (decisión del cliente pendiente, C7 del 12-sep-2026): esta sync solo
 * crea/actualiza/borra los eventos que nacieron en VuelaTour (los que llevan
 * su id en `extendedProperties.private`). Viaja en la respuesta del resync
 * para que el panel lo diga en pantalla.
 */
const NOTA_MANUALES =
  'Los eventos capturados a mano en Google Calendar NO se tocan ni se deduplican: esta sincronización solo crea, actualiza o borra los eventos creados por VuelaTour.';

function unwrap<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return value;
}

interface VueloRow {
  id: string;
  folio: number;
  estado: string;
  es_externo: boolean;
  operador_externo: string | null;
  /**
   * Matrícula del avión AJENO capturada a mano (`avion_externo_manual`). Es
   * lo que va en la casilla «avión» del título cuando el vuelo es externo:
   * `operador_externo` a veces trae el nombre de la persona («Carlos
   * Muciño») y el mecánico necesita la MATRÍCULA. Cuando no hay, se cae al
   * operador (que en la mayoría de los vuelos externos de hoy ES la
   * matrícula: «XA-TYV»).
   */
  avion_externo_matricula: string | null;
  origen_iata: string;
  destino_iata: string;
  pasajeros: number;
  monto_total_usd: string | number;
  fecha_vuelo: string | null;
  fecha_traslado_final: string | null;
  tipo: string | null;
  notas: string | null;
  estado_permiso: string | null;
  /** Asignación a NIVEL VUELO: el tramo la hereda si no tiene propia. */
  aeronave_id: string | null;
  piloto_id: string | null;
  google_calendar_id: string | null;
  google_calendar_regreso_id: string | null;
  aeronave: AeronaveRef | AeronaveRef[] | null;
  piloto: PilotoRef | PilotoRef[] | null;
  cliente: { nombre: string } | { nombre: string }[] | null;
  escalas: Array<{
    id: string;
    orden: number;
    origen_iata: string;
    destino_iata: string;
    fecha_salida_plan: string | null;
    es_ferry: boolean;
    pasajeros: number | null;
    google_calendar_id: string | null;
    aeronave_id: string | null;
    piloto_id: string | null;
    estado_permiso: string | null;
    cancelada_at: string | null;
    aeronave: AeronaveRef | AeronaveRef[] | null;
    piloto: PilotoRef | PilotoRef[] | null;
  }> | null;
}

/**
 * Piloto tal como lo lee el título del evento. `apodo` es OPCIONAL en el tipo
 * a propósito: mientras la migración `20260917000001` no esté aplicada el
 * select lo omite y la fila llega sin la propiedad.
 */
interface PilotoRef {
  nombre: string;
  /** Nombre corto de la oficina («Saab», «Zamora», «Pab»). */
  apodo?: string | null;
}

interface AeronaveRef {
  matricula: string;
  /**
   * Hex del calendario interno (`colores-calendario.util`); el colorId de
   * Google sale de `colorIdGoogleDeVuelo`/`colorIdGoogleEvento`.
   */
  color_calendario?: string | null;
}

type EscalaRow = NonNullable<VueloRow['escalas']>[number];

/** Fila de `mantenimiento` que alimenta su evento de Google (C1). */
interface MantenimientoRow {
  id: string;
  estado: string | null;
  descripcion: string | null;
  /** DATE (día Cancún). Sin fecha ⇒ no hay evento. */
  fecha_programada: string | null;
  horas_programadas: string | number | null;
  etapa_intervalo_hr: string | number | null;
  google_calendar_id: string | null;
  aeronave: AeronaveRef | AeronaveRef[] | null;
}

/** Mensaje ÚNICO del 409 de `POST /resync` cuando ya hay un barrido corriendo. */
const MSG_BARRIDO_EN_CURSO =
  'Ya hay una sincronización con Google Calendar en curso (el respaldo nocturno u otro resync). Espera a que termine e inténtalo de nuevo.';

/**
 * Google contestó cuota/429 a media pasada del barrido: se ABANDONA la pasada
 * (revisión adversaria 12-sep-2026). Seguir sería dispararle miles de llamadas
 * condenadas a fallar al mismo calendario que acaba de decir «basta» —
 * castigando la cuota del día y, peor, dejando el PASO INVERSO trabajando con
 * una vista incompleta de Google. La red de seguridad vuelve a correr esa
 * noche; la cola (cuando está activa) sigue reintentando con su backoff.
 */
class PausaCuotaBarrido extends Error {
  constructor(public readonly etapa: string) {
    super(`Google Calendar pausado por cuota durante ${etapa}`);
    this.name = 'PausaCuotaBarrido';
  }
}

/**
 * Filas por página en las lecturas del barrido. Es el `max-rows` de PostgREST
 * en Supabase: una respuesta con exactamente este tamaño puede estar TRUNCADA,
 * así que se pide la siguiente página (ver `leerPaginado`).
 */
const PAGINA_BD = 1000;

/** Conteos de una pasada de sincronización (resync o reconciliación). */
export interface ResumenSyncCalendar {
  vuelos: number;
  descansos: number;
  eventos: number;
  mantenimientos: number;
  /** Fallos OBSERVABLES (consulta o evento): nunca lanzan, solo se cuentan. */
  errores: number;
  /**
   * Eventos de Google BORRADOS por el paso inverso (D12): nacieron en
   * VuelaTour (llevan `extendedProperties.private.vuelatour_*`) y su fila ya
   * no existe, o la fila apunta a otro evento (duplicado fantasma). Solo el
   * reconcile nocturno hace ese paso: en `POST /resync` siempre es 0.
   */
  huerfanos_borrados: number;
}

/** Respuesta de `POST /v1/calendar/resync` (backfill completo, C2). */
export interface ResultadoResyncCalendar extends ResumenSyncCalendar {
  enabled: boolean;
  calendar_id: string;
  /** Ventana efectiva en días Cancún (YYYY-MM-DD). */
  desde: string;
  hasta: string;
  nota: string;
}

/** Respuesta de `GET /v1/calendar/sync-estado` (C5). */
export interface EstadoSyncCalendar {
  enabled: boolean;
  calendar_id: string;
  ultimo_reconcile_at: string | null;
  ultimo_resync_at: string | null;
  ultimo_resumen:
    | (ResumenSyncCalendar & {
        origen: 'resync' | 'reconcile';
        desde: string;
        hasta: string;
        at: string;
      })
    | null;
  nota: string;
  /**
   * Por qué NO está activa (null cuando `enabled`): texto sin secretos para el
   * chip del panel («la variable de encendido no es "true"», «falta …»,
   * «el JSON no se pudo leer: …»). Ahorra entrar a los logs de Railway.
   */
  motivo: string | null;
}

/**
 * `GET /v1/calendar/sync-estado` con el estado de la COLA (D5, 12-sep-2026).
 * Campos ADITIVOS: un panel viejo ignora `cola`/`automatica` y sigue
 * pintando el chip de siempre.
 */
export interface EstadoSyncCalendarCompleto extends EstadoSyncCalendar {
  /**
   * `true` = el espejo es AUTOMÁTICO de punta a punta (sync prendida + cola
   * con triggers): ningún cambio depende de que un hook alcance a Google.
   * `false` con `enabled:true` y `cola:null` = falta aplicar la migración
   * `20260912000002` (el espejo sigue siendo best-effort, como antes).
   */
  automatica: boolean;
  /** null = la cola no está disponible (migración pendiente). */
  cola: EstadoColaCalendar | null;
}

/**
 * One-way sync: VuelaTour flights -> Google Calendar.
 *
 * Best-effort by design: every public method swallows its own errors and logs
 * them, so a Calendar outage never blocks a flight mutation. Bidirectional
 * sync (Calendar -> app) is a later phase.
 */
@Injectable()
export class CalendarSyncService implements OnModuleInit {
  private readonly logger = new Logger(CalendarSyncService.name);
  private calendar: calendar_v3.Calendar | null = null;
  private calendarId = '';
  private enabled = false;
  /** Diagnóstico de arranque (ver `EstadoSyncCalendar.motivo`). */
  private motivoInactivo: string | null = null;
  // Estado VISIBLE de la sync (C5, 12-sep-2026). Es diagnóstico para el panel
  // ("¿corrió?"), no un dato de negocio — pero desde D12 SÍ se persiste en
  // `calendar_sync_estado`: un redeploy lo dejaba en null y el panel decía
  // "nunca corrió" aunque el reconcile hubiera corrido de madrugada.
  // Desde el 12-sep-2026 (D12) estos tres ADEMÁS se PERSISTEN en
  // `calendar_sync_estado` y se rehidratan al arrancar: un redeploy de Railway
  // ya no hace que el panel diga «nunca corrió». La memoria es la CACHÉ.
  private ultimoReconcileAt: string | null = null;
  private ultimoResyncAt: string | null = null;
  private ultimoResumen: EstadoSyncCalendar['ultimo_resumen'] = null;

  // ===== COLA AUTOMÁTICA (12-sep-2026) =====
  /** Sonda de la migración `20260912000002` (lazy: Supabase aún no está). */
  private colaSonda: ColaSondaCalendar | null = null;
  /** Single-flight del worker: dos pasadas a la vez duplicarían trabajo. */
  private drenando = false;
  /** Debounce de «drenar pronto» tras un hook. */
  private drenarProntoTimer: ReturnType<typeof setTimeout> | null = null;
  /** Google contestó cuota/429: no drenar hasta este instante (ms). */
  private pausadaHastaMs = 0;
  private ultimoDrenadoAt: string | null = null;
  /** Último error de Google observado (sin secretos), para `ultimo_error`. */
  private ultimoDetalleError: string | null = null;
  /** Para loguear UNA vez que la cola volvió a cero. */
  private colaTeniaPendientes = false;
  /**
   * El BARRIDO (`sincronizarVentana`: reconcile nocturno y `POST /resync`)
   * está publicando. El worker NO drena mientras eso pase.
   *
   * Por qué (revisión adversaria 12-sep-2026): los dos escriben los MISMOS
   * eventos y los dos escriben DIRECTO a Google. Si coinciden en un vuelo que
   * todavía NO tiene `google_calendar_id`, los dos leen la fila con el id en
   * null y los dos hacen `events.insert`: Google se queda con un evento
   * DUPLICADO y el id perdedor no se guarda en ninguna fila ⇒ un FANTASMA que
   * ya nadie puede actualizar ni borrar (el barrido solo mira filas vivas).
   * Un `patch` simultáneo sería inocuo; un `insert` simultáneo, no.
   */
  private barriendo = false;
  /**
   * CLAIM SÍNCRONO del barrido dentro de ESTE proceso (revisión adversaria
   * 12-sep-2026). `barriendo` excluye al WORKER, pero no excluía a otro
   * BARRIDO: dos `POST /resync` a la vez —o un resync encima del reconcile
   * nocturno— publicaban los dos DIRECTO a Google y, en un vuelo todavía sin
   * `google_calendar_id`, los dos hacían `events.insert` ⇒ evento DUPLICADO
   * cuyo id no vive en ninguna fila (el fantasma que el candado de BD evita
   * entre réplicas). El candado no cubría este caso HOY: sin la migración
   * aplicada responde `sin_candado` y los dos seguían. Se toma y se suelta
   * SIN `await` en medio, que es lo que lo hace hermético en Node.
   */
  private barridoEnCurso = false;

  // ===== ESTADO PERSISTIDO + CANDADO EN BD (D12, 12-sep-2026) =====
  /** Sonda de la parte nueva de la migración (lazy, como la de la cola). */
  private estadoSonda: EstadoCalendarBd | null = null;
  /** El estado guardado ya se releyó (una vez por proceso). */
  private hidratado = false;
  private hidratacionEnCurso: Promise<void> | null = null;

  /**
   * `usuario.apodo` (migración `20260917000001`) existe. Arranca en `true` y
   * solo se apaga si Postgres responde 42703 — así el API se puede desplegar
   * ANTES de aplicar la migración sin tumbar el espejo del calendario. No se
   * vuelve a prender hasta el siguiente arranque: aplicar la migración pide
   * un resync de todas formas (el formato del título cambia).
   */
  private apodoDisponible = true;

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
    /**
     * Aviso a ADMIN cuando la cola se atora (D4). OPCIONAL a propósito: la
     * sync nunca depende de él (y los specs construyen el servicio sin él).
     */
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** Sonda de la cola (perezosa: en el constructor Supabase aún no existe). */
  private cola(): ColaSondaCalendar {
    if (!this.colaSonda) {
      this.colaSonda = new ColaSondaCalendar(this.supabase.service);
    }
    return this.colaSonda;
  }

  /**
   * Estado persistido + candado (perezoso, igual que la sonda de la cola: en
   * el constructor Supabase todavía no existe).
   */
  private estadoBd(): EstadoCalendarBd {
    if (!this.estadoSonda) {
      this.estadoSonda = new EstadoCalendarBd(this.supabase.service);
    }
    return this.estadoSonda;
  }

  /**
   * Relee de la BD los «últimos» que el panel muestra (D12). Se llama al
   * primer `GET /calendar/sync-estado` y a la primera pasada del worker de
   * cada proceso: así un redeploy de Railway NO borra la evidencia de que el
   * reconcile corrió, y una pausa por cuota de Google sobrevive al reinicio
   * (si no, el proceso nuevo volvería a golpear a Google de inmediato).
   *
   * NUNCA pisa un valor más fresco de esta instancia: solo rellena lo que
   * está en `null` (si el reconcile ya corrió acá, manda lo de acá). Sin la
   * migración aplicada no consulta nada y todo queda como hoy.
   */
  private async hidratarEstado(): Promise<void> {
    if (this.hidratado) return;
    if (!this.hidratacionEnCurso) {
      this.hidratacionEnCurso = this.hidratarAhora().finally(() => {
        this.hidratacionEnCurso = null;
      });
    }
    return this.hidratacionEnCurso;
  }

  private async hidratarAhora(): Promise<void> {
    try {
      const bd = this.estadoBd();
      if (!(await bd.disponible())) return;
      const leidoSync = await bd.leer(CLAVE_ESTADO_SYNC);
      const leidoWorker = await bd.leer(CLAVE_ESTADO_WORKER);
      const sync = parseEstadoSync(leidoSync.valor);
      const worker = parseEstadoWorker(leidoWorker.valor);
      this.ultimoReconcileAt ??= sync.ultimo_reconcile_at;
      this.ultimoResyncAt ??= sync.ultimo_resync_at;
      this.ultimoResumen ??= sync.ultimo_resumen;
      this.ultimoDrenadoAt ??= worker.ultimo_drenado_at;
      if (this.pausadaHastaMs === 0 && worker.pausada_hasta) {
        const t = Date.parse(worker.pausada_hasta);
        if (Number.isFinite(t) && t > Date.now()) this.pausadaHastaMs = t;
      }
      // Solo se considera hidratado cuando la BD RESPONDIÓ las dos filas: si la
      // migración aún no está —o hubo un error de lectura— se vuelve a
      // intentar (la sonda limita el costo a 1 sondeo cada 10 min). Antes
      // bastaba con que la sonda dijera «sí» y un blip de red al arrancar
      // dejaba el panel en «nunca corrió» hasta la madrugada siguiente.
      if (leidoSync.ok && leidoWorker.ok) this.hidratado = true;
    } catch (err) {
      this.logger.warn(
        `No se pudo releer el estado de la sincronización a Google Calendar: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Persiste los «últimos» del barrido (best-effort, nunca lanza). */
  private async guardarEstadoSync(): Promise<void> {
    await this.estadoBd().guardar(CLAVE_ESTADO_SYNC, {
      ultimo_reconcile_at: this.ultimoReconcileAt,
      ultimo_resync_at: this.ultimoResyncAt,
      ultimo_resumen: this.ultimoResumen,
    });
  }

  /**
   * Persiste los «últimos» del worker. Solo cuando hubo trabajo o pausa: la
   * cola se drena cada 20 s y escribir una fila en cada pasada vacía sería
   * ruido puro en la BD.
   */
  private async guardarEstadoWorker(): Promise<void> {
    await this.estadoBd().guardar(CLAVE_ESTADO_WORKER, {
      ultimo_drenado_at: this.ultimoDrenadoAt,
      pausada_hasta:
        this.pausadaHastaMs > Date.now()
          ? new Date(this.pausadaHastaMs).toISOString()
          : null,
    });
  }

  /**
   * ¿Hay que ENCOLAR en vez de escribir directo? `true` solo cuando la sync
   * está prendida, la cola está operativa y quien llama es un HOOK (no el
   * worker ni el barrido). Nunca lanza: ante la duda, `false` = el
   * comportamiento de siempre (escribir directo).
   */
  private async delegarEnCola(opts?: OpcionesEspejo): Promise<boolean> {
    if (opts?.directo) return false;
    if (!this.enabled || !this.calendar) return false;
    try {
      return await this.cola().activa();
    } catch {
      return false;
    }
  }

  /**
   * «Drenar pronto»: el trigger ya encoló el cambio y el hook solo pide que el
   * worker corra YA (debounce de 2 s para que un guardado con 5 pasos drene
   * una sola vez). Nunca bloquea al llamador ni deja el proceso vivo.
   */
  private drenarPronto(): void {
    if (this.drenarProntoTimer) return;
    const t = setTimeout(() => {
      this.drenarProntoTimer = null;
      void this.drenarCola();
    }, COLA_DEBOUNCE_MS);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
    this.drenarProntoTimer = t;
  }

  /**
   * Espera a que termine el drenado que estuviera en curso (máx. ~15 s). Se
   * llama con `barriendo` YA en true, así que ningún drenado nuevo arranca: lo
   * único que puede haber es una pasada a medias de hasta 50 items. Si se
   * agota la espera se sigue igual (el barrido nocturno no puede quedarse
   * colgado): el riesgo vuelve a ser el de antes de este lote, no peor.
   */
  private async esperarDrenado(): Promise<void> {
    for (let i = 0; i < 60 && this.drenando; i++) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 250);
        if (typeof (t as { unref?: () => void }).unref === 'function') {
          (t as { unref: () => void }).unref();
        }
      });
    }
  }

  onModuleInit() {
    this.enabled = this.config.get('GOOGLE_CALENDAR_SYNC_ENABLED', {
      infer: true,
    });
    this.calendarId = this.config.get('GOOGLE_CALENDAR_ID', { infer: true });
    const rawJson = this.config.get('GOOGLE_SERVICE_ACCOUNT_JSON', {
      infer: true,
    });

    if (!this.enabled) {
      this.motivoInactivo =
        'GOOGLE_CALENDAR_SYNC_ENABLED no es "true" (en minúsculas, sin comillas).';
      this.logger.log(
        'Google Calendar sync disabled (GOOGLE_CALENDAR_SYNC_ENABLED=false)',
      );
      return;
    }
    if (!rawJson || !this.calendarId) {
      this.motivoInactivo = !rawJson
        ? 'Falta GOOGLE_SERVICE_ACCOUNT_JSON.'
        : 'Falta GOOGLE_CALENDAR_ID.';
      this.logger.warn(
        'Calendar sync enabled but GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CALENDAR_ID missing — sync inactive',
      );
      this.enabled = false;
      return;
    }

    try {
      // Tolerante a comillas envolventes / base64 / `\\n` escapados (12-sep-2026).
      const creds = parsearServiceAccountJson(rawJson);
      const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/calendar.events'],
      });
      this.calendar = google.calendar({ version: 'v3', auth });
      this.logger.log(
        `Google Calendar sync active (calendar: ${this.calendarId})`,
      );
    } catch (err) {
      this.enabled = false;
      const detalle = err instanceof Error ? err.message : String(err);
      this.motivoInactivo = `No se pudo leer la credencial: ${detalle}`;
      this.logger.error(`Failed to init Google Calendar client: ${detalle}`);
    }
  }

  /**
   * Create or update the Calendar event for a flight. Stores the event id back
   * on vuelo.google_calendar_id. No-op when sync is disabled.
   *
   * Devuelve `true` si el vuelo quedó sincronizado (o no había nada que hacer)
   * y `false` si falló — SOLO informativo para el resumen del cron de
   * reconciliación: los errores se tragan y loguean aquí como siempre y los
   * ~30 hooks `void this.calendar.syncFlight(...)` lo ignoran sin cambios.
   */
  async syncFlight(vueloId: string, opts?: OpcionesEspejo): Promise<boolean> {
    if (!this.enabled || !this.calendar) return true;
    // MODO AUTOMÁTICO: el trigger de la BD ya encoló este vuelo antes de que
    // el hook llegara hasta acá (venga del panel, de la app online, de su
    // outbox al reconectar o de un cron). El worker es el ÚNICO que habla con
    // Google: una sola ruta, con reintentos y sin doble escritura.
    if (await this.delegarEnCola(opts)) {
      this.drenarPronto();
      return true;
    }
    return this.syncFlightAhora(vueloId);
  }

  /**
   * Escritura DIRECTA a Google de un vuelo (worker de la cola y barrido).
   *
   * UNA SOLA FILA POR VUELO (pedido del cliente, 15-sep-2026). El calendario
   * de Google lo sigue leyendo UNA persona —Luis, el mecánico— y el espejo lo
   * partía en un evento por tramo (`T1 · … · 2 pax`, `↩ Regreso · …`), que no
   * se parece a lo que la oficina capturaba a mano. Ahora el vuelo entero es
   * UN evento (`vuelo.google_calendar_id`), para TODOS los tipos
   * (SENCILLO/REDONDO/MULTIESCALA, propios y externos):
   * `Saab N621TX cun-pce-ctm-pce-cun 6:50`.
   *
   * `vuelo.google_calendar_regreso_id` y `escala.google_calendar_id` quedan
   * en LEGADO: cada pasada los borra de Google y los pone en null ANTES del
   * upsert, para que el mecánico nunca vea dos filas del mismo vuelo.
   */
  private async syncFlightAhora(vueloId: string): Promise<boolean> {
    if (!this.enabled || !this.calendar) return true;
    try {
      const vuelo = await this.loadVuelo(vueloId);
      if (!vuelo) return true;

      // Cancelled flights are removed from the calendar instead of upserted.
      if (vuelo.estado === 'CANCELADO') {
        return await this.removeFlight(vueloId);
      }
      // Un borrado que falló deja el id guardado: se reintenta y se cuenta.
      let ok = true;

      // LEGADO fuera ANTES de publicar (espejo exacto de lo que hacía
      // `syncLegs` con los ids a nivel vuelo): un borrado fallido CONSERVA el
      // id —para reintentarlo— y baja el resultado a false.
      if (!(await this.limpiarEventosLegado(vuelo))) ok = false;

      const escalas = [...(vuelo.escalas ?? [])].sort(
        (a, b) => a.orden - b.orden,
      );
      // Un tramo CANCELADO no viaja a Google: ni en la ruta del título ni en
      // la descripción (el calendario del sistema sí lo conserva en rojo).
      const activas = escalas.filter((e) => e.cancelada_at == null);
      // Itinerario con TODOS sus tramos cancelados (o la ida cancelada de un
      // redondo sin más tramos vivos): el vuelo NO vive en Google.
      const todoCancelado = escalas.length > 0 && activas.length === 0;

      const evento = todoCancelado
        ? null
        : this.buildEventoVuelo(vuelo, escalas, activas);

      if (!evento) {
        // Sin fecha no hay dónde ponerlo (y si ya había fila, sobra).
        if (vuelo.google_calendar_id) {
          if (await this.deleteEvent(vuelo.google_calendar_id))
            await this.saveEventId(vueloId, 'google_calendar_id', null);
          else ok = false;
        }
        return ok;
      }

      const eventId = await this.upsertRaw(
        evento,
        vuelo.google_calendar_id,
        'vuelo',
      );
      // SOLO si el id CAMBIÓ (revisión adversaria 12-sep-2026, mismo
      // criterio que el mantenimiento / evento de flota). Antes se escribía
      // en CADA sincronización con el MISMO valor: un UPDATE sin cambio de
      // negocio que `tg_set_updated_at` sellaba igual ⇒ deltas falsos en
      // `?updated_since` y 409 CONFLICTO_VERSION espurios contra el
      // `if_updated_at` de la app offline (invariante 13) cada vez que el
      // worker tocaba el vuelo. Y es una escritura menos por pasada.
      if (eventId !== vuelo.google_calendar_id) {
        await this.saveEventId(vueloId, 'google_calendar_id', eventId);
      }
      return ok;
    } catch (err) {
      this.notarFalloGoogle(err, `vuelo ${vueloId}`);
      this.logger.error(
        `syncFlight(${vueloId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Estado VISIBLE de la sincronización (C5, 12-sep-2026) para el panel: si
   * está prendida, a qué calendario apunta y cuándo corrió por última vez el
   * cron o el backfill. Lee la CACHÉ en memoria; quien la rellena es
   * `hidratarEstado` (desde `calendar_sync_estado`) o la pasada que acabó de
   * correr. Sin la migración `20260912000002` vuelve a ser solo memoria
   * (null tras cada redeploy), como antes de D12.
   */
  estadoSync(): EstadoSyncCalendar {
    return {
      enabled: this.enabled && this.calendar != null,
      calendar_id: this.calendarId,
      ultimo_reconcile_at: this.ultimoReconcileAt,
      ultimo_resync_at: this.ultimoResyncAt,
      ultimo_resumen: this.ultimoResumen,
      nota: NOTA_MANUALES,
      motivo:
        this.enabled && this.calendar != null ? null : this.motivoInactivo,
    };
  }

  /**
   * `GET /v1/calendar/sync-estado` completo (D5): el estado de siempre + la
   * COLA. `automatica: true` = ningún cambio depende de que un hook alcance a
   * Google. `cola: null` con `enabled: true` = falta aplicar la migración
   * `20260912000002` (el panel lo pinta en ÁMBAR: «activo · sin cola»).
   */
  async estadoSyncCompleto(): Promise<EstadoSyncCalendarCompleto> {
    // D12: los «últimos» viven en la BD desde el 12-sep-2026, así que un
    // redeploy ya no los borra. La memoria es la caché; esta es la relectura.
    await this.hidratarEstado();
    const base = this.estadoSync();
    let activa = false;
    try {
      activa = await this.cola().activa();
    } catch {
      activa = false;
    }
    const cola = activa ? await this.leerEstadoCola() : null;
    // `automatica` es el flag AUTORITATIVO (sync prendida + cola con
    // triggers). `cola` puede venir null también si los conteos no se
    // pudieron leer en ese instante: el panel decide «sin cola (migración
    // pendiente)» por `automatica === false`, no por `cola === null`.
    return { ...base, automatica: base.enabled && activa, cola };
  }

  /** Conteos de la cola para el chip del panel. Nunca lanza. */
  private async leerEstadoCola(): Promise<EstadoColaCalendar | null> {
    try {
      const sb = this.supabase.service;
      const { count: pendientes, error: e1 } = await sb
        .from(TABLA_CALENDAR_SYNC_COLA)
        .select('id', { count: 'exact', head: true });
      if (e1) throw new Error(e1.message);
      const { count: conError, error: e2 } = await sb
        .from(TABLA_CALENDAR_SYNC_COLA)
        .select('id', { count: 'exact', head: true })
        .gt('intentos', 0);
      if (e2) throw new Error(e2.message);
      // El más viejo manda: es el que dice «desde cuándo» en el aviso.
      const { data: viejo, error: e3 } = (await sb
        .from(TABLA_CALENDAR_SYNC_COLA)
        .select('creado_at, ultimo_error, intentos')
        .order('creado_at', { ascending: true })
        .limit(1)
        .maybeSingle()) as {
        data: {
          creado_at: string;
          ultimo_error: string | null;
          intentos: number;
        } | null;
        error: { message: string } | null;
      };
      if (e3) throw new Error(e3.message);
      return {
        activa: true,
        pendientes: pendientes ?? 0,
        con_error: conError ?? 0,
        mas_antiguo_at: viejo?.creado_at ?? null,
        ultimo_error: viejo?.ultimo_error ?? this.ultimoDetalleError,
        ultimo_drenado_at: this.ultimoDrenadoAt,
        pausada_hasta:
          this.pausadaHastaMs > Date.now()
            ? new Date(this.pausadaHastaMs).toISOString()
            : null,
      };
    } catch (err) {
      this.logger.warn(
        `No se pudo leer el estado de la cola de Google Calendar: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * BACKFILL COMPLETO (C2, 12-sep-2026): sube a Google TODO lo que el
   * calendario del sistema muestra — vuelos no cancelados con fecha,
   * descansos de piloto, eventos NO-vuelo de la flota y mantenimientos con
   * fecha — en la ventana [hoy−30d, hoy+365d] por default (`desde`/`hasta`
   * ISO la mueven). SECUENCIAL a propósito para no saturar la API de Google
   * y best-effort: un evento que falla se loguea y se cuenta en `errores`,
   * jamás tumba el resto del backfill.
   *
   * Antes esta ruta era `resyncRedondos` y SOLO recorría vuelos: los
   * descansos, los eventos de flota y (ahora) los mantenimientos nunca se
   * subían de golpe.
   */
  async resyncTodo(opts?: {
    desde?: string;
    hasta?: string;
  }): Promise<ResultadoResyncCalendar> {
    const ahora = Date.now();
    // NORMALIZACIÓN (12-sep-2026): `@IsISO8601()` deja pasar cadenas que
    // `new Date` NO entiende (`2026-W01-1`, `…T00:00:00,000Z` con coma
    // decimal) — con ellas `diaCancun` lanzaba RangeError y la ruta respondía
    // 500 en vez de un 400 claro; y una coma dentro de un filtro `.or()` de
    // PostgREST lo parte en dos condiciones. Se normaliza a ISO real.
    const desdeIso = this.instanteValido(
      opts?.desde,
      'desde',
      ahora - 30 * 86_400_000,
    );
    const hastaIso = this.instanteValido(
      opts?.hasta,
      'hasta',
      ahora + 365 * 86_400_000,
    );
    const desde = this.diaCancun(desdeIso);
    const hasta = this.diaCancun(hastaIso);
    if (!this.enabled || !this.calendar) {
      // Apagada (faltan las 3 variables en Railway): NO es un error, es un
      // estado — el panel lo pinta como "Google: apagado".
      return {
        enabled: false,
        calendar_id: this.calendarId,
        vuelos: 0,
        descansos: 0,
        eventos: 0,
        mantenimientos: 0,
        errores: 0,
        huerfanos_borrados: 0,
        desde,
        hasta,
        nota: NOTA_MANUALES,
      };
    }
    // CANDADO (D12): el barrido escribe DIRECTO a Google. Si el reconcile
    // nocturno (o el resync de otro admin, o de otra réplica) ya está
    // publicando, dos `events.insert` del mismo evento dejarían un duplicado
    // fantasma. Se prefiere un 409 claro a un calendario sucio.
    // Exclusión DENTRO del proceso (síncrona, sin await en medio): vale aunque
    // la migración del candado no esté aplicada, que es el estado de hoy.
    if (this.barridoEnCurso) throw new ConflictException(MSG_BARRIDO_EN_CURSO);
    this.barridoEnCurso = true;
    let candado: ResultadoCandado = 'sin_candado';
    try {
      candado = await this.estadoBd().tomarCandado(
        CANDADO_BARRIDO,
        CANDADO_BARRIDO_TTL_SEG,
      );
      if (candado === 'ocupado') {
        throw new ConflictException(MSG_BARRIDO_EN_CURSO);
      }
      const resumen = await this.sincronizarVentana(
        desdeIso,
        hastaIso,
        'resync',
      );
      return {
        enabled: true,
        calendar_id: this.calendarId,
        ...resumen,
        desde,
        hasta,
        nota: NOTA_MANUALES,
      };
    } finally {
      if (candado === 'concedido')
        await this.estadoBd().soltarCandado(CANDADO_BARRIDO);
      this.barridoEnCurso = false;
    }
  }

  /**
   * RED DE SEGURIDAD nocturna (05:15 UTC ≈ 00:15 Cancún). Dos pasadas sobre la
   * MISMA ventana **[hoy−30d, hoy+365d]** (la del resync desde D12,
   * 12-sep-2026: antes era [hoy−7d, hoy+60d] y un vuelo agendado para el año
   * que viene podía quedar mal DÍAS sin que nadie lo notara):
   *
   * 1. **DIRECTA** (`sincronizarVentana`): republica a Google todo lo que el
   *    calendario del sistema muestra en la ventana. Recoge mutaciones que no
   *    pasan por un hook (p. ej. `refreshPermisosDeVuelo` mueve
   *    `estado_permiso` sin re-sync) y repara lo que alguien borró a mano en
   *    Calendar. Reusa la idempotencia de `syncFlight`/`upsertRaw`.
   * 2. **INVERSA** (`limpiarHuerfanos`, D12): lista en Google los eventos de
   *    la ventana y BORRA los que nacieron en VuelaTour
   *    (`extendedProperties.private.vuelatour_*`) y ya no tienen fila que los
   *    apunte — o cuya fila apunta a OTRO evento (duplicado fantasma). Sin
   *    esto el reconcile solo mira FILAS VIVAS y un evento huérfano se queda
   *    para siempre en el calendario de la oficina. Los eventos capturados A
   *    MANO (sin ancla `vuelatour_*`) NO se tocan JAMÁS.
   *
   * Va SECUENCIAL a propósito para no saturar la API de Google y es
   * best-effort: nunca lanza. Sigue escribiendo DIRECTO (`{ directo: true }`),
   * sin pasar por la cola: la cola es el remedio normal, esto es la red.
   *
   * CANDADO (D12): antes de correr toma `calendar_sync_lock(912001)` en la BD.
   * Railway corre **1 réplica hoy**, así que es preventivo: con 2 réplicas,
   * dos reconciles simultáneos podrían insertar el MISMO evento dos veces. Sin
   * la migración aplicada el candado no existe y se corre igual, como hoy.
   */
  @Cron('15 5 * * *', { name: 'calendar-reconcile-ventana' })
  async reconcileVentana(): Promise<void> {
    if (!this.enabled || !this.calendar) return;
    const ahora = Date.now();
    // Un `POST /resync` (o el reconcile de ayer que no terminó) ya está
    // publicando en ESTE proceso: dos barridos a la vez pueden duplicar un
    // evento. La bandera es síncrona, así que vale sin la migración aplicada.
    if (this.barridoEnCurso) {
      this.logger.log(
        'reconcile de Google Calendar omitido: ya hay un barrido en curso en este proceso (resync manual).',
      );
      return;
    }
    this.barridoEnCurso = true;
    let candado: ResultadoCandado = 'sin_candado';
    try {
      candado = await this.estadoBd().tomarCandado(
        CANDADO_BARRIDO,
        CANDADO_BARRIDO_TTL_SEG,
      );
      if (candado === 'ocupado') {
        this.logger.log(
          'reconcile de Google Calendar omitido: otra réplica del API lo está haciendo (candado en BD).',
        );
        return;
      }
      await this.sincronizarVentana(
        new Date(ahora - 30 * 86_400_000).toISOString(),
        new Date(ahora + 365 * 86_400_000).toISOString(),
        'reconcile',
        { pasoInverso: true },
      );
    } finally {
      if (candado === 'concedido')
        await this.estadoBd().soltarCandado(CANDADO_BARRIDO);
      this.barridoEnCurso = false;
    }
  }

  // ===== WORKER DE LA COLA (D2, 12-sep-2026) =====

  /**
   * DRENADO AUTOMÁTICO de `calendar_sync_cola` cada 20 s: el único camino que
   * habla con Google en modo automático. Tolerante de punta a punta:
   *
   * - sin migración aplicada (`calendar_sync_cola_activa()` en false) NO hace
   *   nada y los hooks siguen escribiendo directo, como hasta hoy;
   * - con la sync APAGADA no drena NI quema intentos: la cola espera (prender
   *   las 3 variables de Railway sube todo lo acumulado);
   * - single-flight: dos pasadas nunca corren a la vez;
   * - toma hasta 50 items listos, los reclama con `tomado_at` y los procesa
   *   SECUENCIAL (no saturar la API de Google);
   * - éxito ⇒ el item se BORRA; fallo ⇒ `intentos+1`, backoff
   *   `min(30 s · 2^intentos, 1 h)` y `ultimo_error` sin secretos: un cambio
   *   NUNCA se pierde, se reintenta para siempre;
   * - 403 de cuota / 429 ⇒ PAUSA el drenado 5 min sin quemar intentos de los
   *   demás (seguir sería regalarle errores a Google) — y la pausa se PERSISTE
   *   (D12), así que un redeploy en medio no la cancela;
   * - CANDADO en BD (`calendar_sync_lock(912002)`, D12): con más de una réplica
   *   solo una drena por vez. Railway corre 1 réplica hoy; sin la migración
   *   aplicada el candado no existe y todo sigue como antes.
   */
  @Cron('*/20 * * * * *', { name: 'calendar-sync-cola' })
  async drenarCola(): Promise<void> {
    if (this.drenando) return;
    // El barrido (reconcile/resync) ya está publicando DIRECTO a Google: dos
    // escritores del mismo evento pueden duplicarlo (ver `barriendo`). La cola
    // no se pierde nada: los items siguen ahí y se drenan al terminar.
    if (this.barriendo) return;
    // Sync apagada: la cola ESPERA (no se drena ni se castiga a nadie).
    if (!this.enabled || !this.calendar) return;
    // El candado se toma ANTES del primer `await` (la sonda): si no, dos
    // pasadas del cron pasarían juntas por la sonda y duplicarían trabajo.
    this.drenando = true;
    let candado: ResultadoCandado = 'sin_candado';
    try {
      let activa = false;
      try {
        activa = await this.cola().activa();
      } catch {
        activa = false;
      }
      if (!activa) return;
      // Estado guardado (D12): tras un redeploy, recupera `ultimo_drenado_at`
      // y —lo importante— una PAUSA POR CUOTA vigente; si no, el proceso nuevo
      // volvería a golpear a Google de inmediato y a quemar la cuota.
      await this.hidratarEstado();
      if (this.pausadaHastaMs > Date.now()) return;
      // CANDADO en BD (D12): con 2 réplicas, dos workers drenando a la vez
      // duplican trabajo contra Google (el `tomado_at` protege item por item,
      // pero no evita la doble pasada). Railway corre 1 réplica hoy; sin la
      // migración aplicada esto responde `sin_candado` y se drena igual.
      candado = await this.estadoBd().tomarCandado(
        CANDADO_DRENADO,
        CANDADO_DRENADO_TTL_SEG,
      );
      if (candado === 'ocupado') return;

      const items = await this.tomarItems();
      this.ultimoDrenadoAt = new Date().toISOString();

      const sinProcesar: number[] = [];
      let hechos = 0;
      let fallidos = 0;
      for (const item of items) {
        if (this.pausadaHastaMs > Date.now()) {
          // Pausa por cuota: el resto conserva su turno INTACTO.
          sinProcesar.push(item.id);
          continue;
        }
        const pausaAntes = this.pausadaHastaMs;
        this.ultimoDetalleError = null;
        let ok = false;
        try {
          ok = await this.procesarItem(item);
        } catch (err) {
          this.notarFalloGoogle(err, this.etiquetaItem(item));
          ok = false;
        }
        if (ok) {
          hechos++;
          await this.borrarItem(item);
          continue;
        }
        if (this.pausadaHastaMs > pausaAntes) {
          // El fallo FUE la cuota: no se le cobra el intento a este item.
          sinProcesar.push(item.id);
          continue;
        }
        fallidos++;
        await this.reprogramarItem(item);
      }
      if (sinProcesar.length > 0) await this.liberarItems(sinProcesar);
      if (items.length > 0) {
        this.logger.log(
          `cola Google Calendar: ${hechos} sincronizados, ${fallidos} con error, ${sinProcesar.length} en espera por pausa.`,
        );
      }
      // Solo cuando hubo trabajo o pausa: el worker corre cada 20 s y escribir
      // una fila en cada pasada vacía sería ruido puro en la BD.
      if (items.length > 0 || this.pausadaHastaMs > Date.now()) {
        await this.guardarEstadoWorker();
      }
      // SIEMPRE (aunque no hubiera items listos): un item atorado en backoff
      // de 1 h no aparece en `tomarItems` y su alerta no puede esperar esa
      // hora. Cuesta una consulta de conteo por pasada.
      await this.vigilarCola();
    } catch (err) {
      this.logger.error(
        `drenarCola falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (candado === 'concedido')
        await this.estadoBd().soltarCandado(CANDADO_DRENADO);
      this.drenando = false;
    }
  }

  /** Etiqueta legible de un item (logs y `ultimo_error`). */
  private etiquetaItem(item: ItemCola): string {
    return item.entidad === 'borrar_evento'
      ? `borrar evento ${item.google_event_id ?? '?'}`
      : `${item.entidad} ${item.entidad_id ?? '?'}`;
  }

  /**
   * Toma hasta 50 items LISTOS y los RECLAMA (`tomado_at` = sello propio).
   * El reclamo es la llave de concurrencia: el borrado y el reprograma exigen
   * ese mismo sello, así que si un trigger re-encoló la fila mientras el
   * worker la procesaba (un cambio nuevo), el item NO se borra y se vuelve a
   * procesar — un cambio jamás se pierde por una carrera.
   */
  private async tomarItems(): Promise<ItemCola[]> {
    const ahora = Date.now();
    const nowIso = new Date(ahora).toISOString();
    const vencidoIso = new Date(ahora - COLA_TOMADO_VENCE_MS).toISOString();
    const libre = `tomado_at.is.null,tomado_at.lt.${vencidoIso}`;
    const COLS =
      'id, entidad, entidad_id, google_event_id, intentos, creado_at, tomado_at';

    const { data: listos, error } = (await this.supabase.service
      .from(TABLA_CALENDAR_SYNC_COLA)
      .select('id')
      .lte('siguiente_intento_at', nowIso)
      .or(libre)
      .order('siguiente_intento_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(COLA_TOMA_MAX)) as {
      data: { id: number }[] | null;
      error: { message: string } | null;
    };
    if (error) throw new Error(error.message);
    const ids = (listos ?? []).map((r) => r.id);
    if (ids.length === 0) return [];

    // El sello del reclamo se genera acá (no `now()` de Postgres) para poder
    // compararlo exacto al borrar/reprogramar.
    const sello = new Date().toISOString();
    const { data: tomados, error: errTomar } = (await this.supabase.service
      .from(TABLA_CALENDAR_SYNC_COLA)
      .update({ tomado_at: sello })
      .in('id', ids)
      .or(libre)
      .select(COLS)) as {
      data: ItemCola[] | null;
      error: { message: string } | null;
    };
    if (errTomar) throw new Error(errTomar.message);
    return (tomados ?? []).map((t) => ({ ...t, tomado_at: sello }));
  }

  /**
   * Ejecuta UN item. `true` = quedó hecho (o ya no había nada que hacer: la
   * fila se borró) ⇒ el item se elimina de la cola.
   */
  private async procesarItem(item: ItemCola): Promise<boolean> {
    switch (item.entidad) {
      case 'vuelo':
        return item.entidad_id
          ? await this.syncFlightAhora(item.entidad_id)
          : true;
      case 'descanso':
        return item.entidad_id
          ? await this.syncDescanso(item.entidad_id, { directo: true })
          : true;
      case 'evento':
        return item.entidad_id
          ? await this.syncEvento(item.entidad_id, { directo: true })
          : true;
      case 'mantenimiento':
        return item.entidad_id
          ? await this.syncMantenimientoAhora(item.entidad_id)
          : true;
      case 'borrar_evento':
        // `deleteEvent` ya devuelve true con 404/410 (el objetivo —que el
        // evento no exista— se cumple igual).
        return item.google_event_id
          ? await this.deleteEvent(item.google_event_id)
          : true;
      default:
        // Entidad desconocida (API viejo contra una cola nueva): no se puede
        // procesar, pero tampoco se borra a ciegas.
        this.logger.warn(
          `cola Google Calendar: entidad desconocida «${String(item.entidad)}» (item ${item.id})`,
        );
        return false;
    }
  }

  /** Item resuelto: sale de la cola (solo si nadie lo re-encoló en medio). */
  private async borrarItem(item: ItemCola): Promise<void> {
    const { error } = await this.supabase.service
      .from(TABLA_CALENDAR_SYNC_COLA)
      .delete()
      .eq('id', item.id)
      .eq('tomado_at', item.tomado_at);
    if (error) {
      this.logger.warn(
        `No se pudo cerrar el item ${item.id} de la cola: ${error.message}`,
      );
    }
  }

  /** Item fallido: backoff exponencial + rastro del error (sin secretos). */
  private async reprogramarItem(item: ItemCola): Promise<void> {
    const intentos = (item.intentos ?? 0) + 1;
    const cuando = new Date(Date.now() + siguienteIntentoMs(intentos));
    const { error } = await this.supabase.service
      .from(TABLA_CALENDAR_SYNC_COLA)
      .update({
        intentos,
        siguiente_intento_at: cuando.toISOString(),
        ultimo_error: this.ultimoDetalleError ?? 'no se pudo sincronizar',
        tomado_at: null,
      })
      .eq('id', item.id)
      .eq('tomado_at', item.tomado_at);
    if (error) {
      this.logger.warn(
        `No se pudo reprogramar el item ${item.id} de la cola: ${error.message}`,
      );
    }
  }

  /**
   * Devuelve items reclamados SIN castigo (pausa por cuota): se les mueve el
   * turno al final de la pausa para no repetir el 403 en 20 s.
   */
  private async liberarItems(ids: number[]): Promise<void> {
    const cuando = new Date(
      Math.max(this.pausadaHastaMs, Date.now()),
    ).toISOString();
    const { error } = await this.supabase.service
      .from(TABLA_CALENDAR_SYNC_COLA)
      .update({ tomado_at: null, siguiente_intento_at: cuando })
      .in('id', ids);
    if (error) {
      this.logger.warn(
        `No se pudieron liberar items de la cola: ${error.message}`,
      );
    }
  }

  /**
   * Registra un fallo de Google: guarda el texto (sin secretos) para
   * `ultimo_error` y, si Google está rechazando por CUOTA (403) o exceso de
   * peticiones (429), PAUSA el drenado 5 min — insistir solo quemaría el
   * turno de todos los demás cambios.
   */
  private notarFalloGoogle(err: unknown, contexto: string): void {
    const detalle = err instanceof Error ? err.message : String(err);
    this.ultimoDetalleError = sanitizarError(`${contexto}: ${detalle}`);
    if (esLimiteGoogle(err)) {
      this.pausadaHastaMs = Date.now() + COLA_PAUSA_CUOTA_MS;
      this.logger.warn(
        `Google Calendar respondió cuota/límite (${contexto}): el drenado se pausa 5 min y ningún cambio pierde su turno.`,
      );
    }
  }

  /**
   * AVISO A ADMIN (D4) cuando la cola se atora: algún item con ≥ 12 intentos
   * (≈ 1 h de backoff) o el más viejo esperando > 30 min. UNA VEZ AL DÍA
   * (dedupe en `alerta_emitida`, mismo patrón que las demás alertas) y con
   * texto claro: qué pasa, desde cuándo y con qué error.
   */
  private async vigilarCola(): Promise<void> {
    try {
      const sb = this.supabase.service;
      const { count, error } = await sb
        .from(TABLA_CALENDAR_SYNC_COLA)
        .select('id', { count: 'exact', head: true });
      if (error) throw new Error(error.message);
      const pendientes = count ?? 0;
      if (pendientes === 0) {
        if (this.colaTeniaPendientes) {
          this.colaTeniaPendientes = false;
          this.logger.log(
            'Cola de Google Calendar en cero: el calendario quedó al día.',
          );
        }
        return;
      }
      this.colaTeniaPendientes = true;

      const { data: viejo } = (await sb
        .from(TABLA_CALENDAR_SYNC_COLA)
        .select('creado_at, ultimo_error')
        .order('creado_at', { ascending: true })
        .limit(1)
        .maybeSingle()) as {
        data: { creado_at: string; ultimo_error: string | null } | null;
      };
      const { data: peor } = (await sb
        .from(TABLA_CALENDAR_SYNC_COLA)
        .select('intentos')
        .order('intentos', { ascending: false })
        .limit(1)
        .maybeSingle()) as { data: { intentos: number } | null };

      const estado = {
        pendientes,
        mas_antiguo_at: viejo?.creado_at ?? null,
        max_intentos: peor?.intentos ?? 0,
      };
      if (!colaAtorada(estado, Date.now())) return;

      const dia = this.diaCancun(new Date().toISOString());
      if (!(await this.marcarAvisoDelDia(`calendar_sync_cola:${dia}`))) return;

      const cuerpo = textoAvisoCola({
        pendientes,
        mas_antiguo_at: estado.mas_antiguo_at,
        ultimo_error: viejo?.ultimo_error ?? this.ultimoDetalleError,
      });
      this.logger.error(`ALERTA · ${cuerpo}`);
      await this.notifications?.notifyRole(Rol.ADMIN, {
        tipo: 'alerta_sistema',
        titulo: 'Google Calendar sin sincronizar',
        cuerpo,
        data: { pendientes, mas_antiguo_at: estado.mas_antiguo_at },
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo evaluar el aviso de la cola: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Dedupe del aviso en `alerta_emitida` (23505 = ya se avisó hoy). */
  private async marcarAvisoDelDia(dedupeKey: string): Promise<boolean> {
    const { error } = await this.supabase.service
      .from('alerta_emitida')
      .insert({ dedupe_key: dedupeKey, clave: COLA_ALERTA_CLAVE });
    if (error) {
      if (error.code === '23505') return false;
      this.logger.warn(
        `No se pudo marcar el aviso de la cola: ${error.message}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Corta el barrido si Google acaba de responder cuota/429 (revisión
   * adversaria 12-sep-2026). El worker de la cola ya respetaba
   * `pausadaHastaMs`; el barrido no lo miraba, así que una pasada de ~395 días
   * seguía disparando miles de llamadas condenadas a fallar (y con la vista de
   * Google incompleta el paso inverso NO debe decidir borrados).
   */
  private abortarSiCuota(etapa: string, r: ResumenSyncCalendar): void {
    if (this.pausadaHastaMs <= Date.now()) return;
    r.errores++;
    throw new PausaCuotaBarrido(etapa);
  }

  /**
   * LECTURA PAGINADA de PostgREST (revisión adversaria 12-sep-2026).
   *
   * Supabase corta toda respuesta en `max-rows` (1000) **sin avisar**: no hay
   * error, solo faltan filas. Con la ventana de D12 (~395 días) el barrido
   * pasó a leer miles de vuelos y de descansos, así que una lectura sin
   * paginar dejaba SILENCIOSAMENTE de publicar todo lo que cayera después de
   * la fila 1000 — exactamente el «falla y nadie se entera» que la red de
   * seguridad existe para evitar. Mismo patrón que `aircraft-balance` y
   * `flights.service`: `order` estable + `range`, hasta que una página venga
   * incompleta.
   *
   * Un error a media paginación devuelve lo leído hasta ahí MÁS el error: el
   * caller lo cuenta y sigue con lo que tiene (igual que antes de este lote,
   * cuando una consulta con error se procesaba como lista vacía).
   */
  private async leerPaginado<T>(
    consulta: (
      desde: number,
      hasta: number,
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  ): Promise<{ filas: T[]; error: string | null }> {
    const filas: T[] = [];
    for (let desde = 0; ; desde += PAGINA_BD) {
      const { data, error } = await consulta(desde, desde + PAGINA_BD - 1);
      if (error) return { filas, error: error.message };
      const pagina = data ?? [];
      filas.push(...pagina);
      if (pagina.length < PAGINA_BD) break;
    }
    return { filas, error: null };
  }

  /**
   * NÚCLEO compartido por el backfill (`resyncTodo`) y la reconciliación
   * nocturna (`reconcileVentana`): sincroniza a Google todo lo que el
   * calendario del sistema muestra y cuya fecha toca [desdeIso, hastaIso] —
   * vuelos, descansos, eventos de flota y mantenimientos, en ese orden y
   * SECUENCIAL. Una sola implementación: si el backfill y el cron divergen,
   * el calendario de la oficina queda distinto según quién corrió último.
   * Nunca lanza: devuelve los conteos y deja `errores` a la vista.
   */
  private async sincronizarVentana(
    desdeIso: string,
    hastaIso: string,
    origen: 'resync' | 'reconcile',
    opts?: { pasoInverso?: boolean },
  ): Promise<ResumenSyncCalendar> {
    const desdeDia = this.diaCancun(desdeIso);
    const hastaDia = this.diaCancun(hastaIso);
    const r: ResumenSyncCalendar = {
      vuelos: 0,
      descansos: 0,
      eventos: 0,
      mantenimientos: 0,
      errores: 0,
      huerfanos_borrados: 0,
    };
    // EXCLUSIÓN MUTUA con el worker de la cola (revisión adversaria
    // 12-sep-2026): el barrido escribe DIRECTO y el worker también. Si los dos
    // tocan un vuelo SIN `google_calendar_id` a la vez, los dos hacen
    // `events.insert` y queda un evento DUPLICADO cuyo id no vive en ninguna
    // fila (fantasma imborrable). Con `barriendo` en true no arranca ningún
    // drenado nuevo; solo hay que dejar terminar el que estuviera en curso.
    this.barriendo = true;
    try {
      await this.esperarDrenado();
      // 1) Vuelos cuyo rango [fecha_vuelo, coalesce(fecha_fin, fecha_vuelo)]
      //    SOLAPA la ventana (viajes multi-día incluidos). SIN filtro de
      //    estado (12-sep-2026): los CANCELADOS también entran para que
      //    `syncFlight` BORRE sus eventos (C6) — si Google estaba caído
      //    cuando se canceló, su evento seguía vivo en el calendario de la
      //    oficina y nadie lo volvía a mirar. No se cuentan en `vuelos`
      //    (ahí solo va lo PUBLICADO); un borrado que falla sí cuenta error.
      const { filas: vuelos, error: vErr } = await this.leerPaginado<{
        id: string;
        estado?: string;
      }>((d, h) =>
        this.supabase.service
          .from('vuelo')
          .select('id, estado')
          .not('fecha_vuelo', 'is', null)
          .lte('fecha_vuelo', hastaIso)
          .or(
            `fecha_fin.gte.${desdeIso},and(fecha_fin.is.null,fecha_vuelo.gte.${desdeIso})`,
          )
          .order('id', { ascending: true })
          .range(d, h),
      );
      if (vErr) {
        r.errores++;
        this.logger.warn(`${origen}: vuelos no consultados (${vErr})`);
      }
      for (const v of vuelos) {
        this.abortarSiCuota('vuelos', r);
        if (!(await this.syncFlight(v.id, { directo: true }))) r.errores++;
        else if (v.estado !== 'CANCELADO') r.vuelos++;
      }

      // 2) Descansos de piloto que tocan la ventana (columnas DATE en Cancún).
      const { filas: descansos, error: dErr } = await this.leerPaginado<{
        id: string;
        fecha_inicio: string;
        fecha_fin: string;
        motivo: string | null;
        google_calendar_id: string | null;
        piloto: { nombre: string } | { nombre: string }[] | null;
      }>((desde, hasta) =>
        this.supabase.service
          .from('piloto_descanso')
          .select(
            'id, fecha_inicio, fecha_fin, motivo, google_calendar_id, piloto:usuario!piloto_id(nombre)',
          )
          .lte('fecha_inicio', hastaDia)
          .gte('fecha_fin', desdeDia)
          .order('id', { ascending: true })
          .range(desde, hasta),
      );
      if (dErr) {
        r.errores++;
        this.logger.warn(`${origen}: descansos no consultados (${dErr})`);
      }
      for (const d of descansos) {
        this.abortarSiCuota('descansos', r);
        const eventId = await this.upsertDescansoEvent(
          {
            id: d.id,
            piloto_nombre: unwrap(d.piloto)?.nombre ?? 'Piloto',
            fecha_inicio: d.fecha_inicio,
            fecha_fin: d.fecha_fin,
            motivo: d.motivo,
            google_calendar_id: d.google_calendar_id,
          },
          { directo: true },
        );
        // Evento recreado (lo borraron del lado de Calendar): persistir el id
        // nuevo o cada noche nacería otro duplicado.
        if (eventId && eventId !== d.google_calendar_id) {
          const { error } = await this.supabase.service
            .from('piloto_descanso')
            .update({ google_calendar_id: eventId })
            .eq('id', d.id);
          if (error) {
            r.errores++;
            this.logger.error(
              `Failed to persist descanso google_calendar_id for ${d.id}: ${error.message}`,
            );
          }
        }
        // Sin id (ni existente ni creado) = el upsert falló y ya se logueó.
        if (eventId) r.descansos++;
        else r.errores++;
      }

      // 3) Eventos NO-vuelo de la flota en la ventana.
      type EventoFlotaBarrido = {
        id: string;
        titulo: string | null;
        fecha: string;
        fecha_fin: string | null;
        notas: string | null;
        google_calendar_id: string | null;
        aeronave: AeronaveRef | AeronaveRef[] | null;
        responsable: { nombre: string } | { nombre: string }[] | null;
      };
      const { filas: eventos, error: eErr } =
        await this.leerPaginado<EventoFlotaBarrido>((desde, hasta) =>
          this.supabase.service
            .from('evento_flota')
            .select(
              'id, titulo, fecha, fecha_fin, notas, google_calendar_id, aeronave:aeronave_id(matricula, color_calendario), responsable:usuario!responsable_id(nombre)',
            )
            .lte('fecha', hastaIso)
            .or(
              `fecha_fin.gte.${desdeIso},and(fecha_fin.is.null,fecha.gte.${desdeIso})`,
            )
            .order('id', { ascending: true })
            .range(desde, hasta),
        );
      if (eErr) {
        r.errores++;
        this.logger.warn(
          `${origen}: eventos de flota no consultados (${eErr})`,
        );
      }
      for (const ev of eventos) {
        this.abortarSiCuota('eventos de flota', r);
        const eventId = await this.upsertEventoFlotaEvent(
          {
            id: ev.id,
            titulo: ev.titulo ?? 'Evento',
            fecha: ev.fecha,
            fecha_fin: ev.fecha_fin,
            aeronave_matricula: unwrap(ev.aeronave)?.matricula ?? null,
            aeronave_color: unwrap(ev.aeronave)?.color_calendario ?? null,
            responsable_nombre: unwrap(ev.responsable)?.nombre ?? null,
            notas: ev.notas,
            google_calendar_id: ev.google_calendar_id,
          },
          { directo: true },
        );
        if (eventId) r.eventos++;
        else r.errores++;
      }

      // 4) MANTENIMIENTOS con fecha en la ventana (12-sep-2026). Sin filtro de
      //    estado a propósito: `syncMantenimiento` BORRA el evento de lo que
      //    ya se completó (el calendario del sistema tampoco lo pinta).
      const { filas: mants, error: mErr } = await this.leerPaginado<{
        id: string;
      }>((desde, hasta) =>
        this.supabase.service
          .from('mantenimiento')
          .select('id')
          .not('fecha_programada', 'is', null)
          .gte('fecha_programada', desdeDia)
          .lte('fecha_programada', hastaDia)
          .order('id', { ascending: true })
          .range(desde, hasta),
      );
      if (mErr) {
        r.errores++;
        this.logger.warn(`${origen}: mantenimientos no consultados (${mErr})`);
      }
      for (const m of mants) {
        this.abortarSiCuota('mantenimientos', r);
        if (await this.syncMantenimiento(m.id, { directo: true }))
          r.mantenimientos++;
        else r.errores++;
      }

      // 5) PASO INVERSO (D12): Google → BD. Corre DESPUÉS de publicar (los
      //    pasos 1-4 ya crearon y persistieron los ids de las filas vivas, así
      //    que lo que quede sin fila es huérfano de verdad) y con `barriendo`
      //    todavía en true (el worker no puede insertar en medio).
      if (opts?.pasoInverso) {
        const inverso = await this.limpiarHuerfanos(desdeIso, hastaIso);
        r.huerfanos_borrados = inverso.borrados;
        r.errores += inverso.errores;
      }

      this.logger.log(
        `${origen} [${desdeDia} → ${hastaDia}]: ${r.vuelos} vuelos, ${r.descansos} descansos, ${r.eventos} eventos, ${r.mantenimientos} mantenimientos, ${r.huerfanos_borrados} huérfanos borrados, ${r.errores} con error.`,
      );
    } catch (err) {
      if (err instanceof PausaCuotaBarrido) {
        // El error ya se contó en `abortarSiCuota`: acá solo se deja constancia
        // de que la pasada quedó a medias A PROPÓSITO.
        this.logger.error(
          `ALERTA · ${origen} ABANDONADO en ${err.etapa}: Google Calendar respondió cuota/límite. Lo que faltó se publica en la próxima pasada (y la cola sigue reintentando). El paso inverso NO corrió: con una vista incompleta de Google no se borra nada.`,
        );
      } else {
        r.errores++;
        this.logger.error(
          `${origen} falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      // SIEMPRE se libera: si el barrido reventara con `barriendo` en true, la
      // cola no volvería a drenar nunca y el modo automático quedaría muerto.
      this.barriendo = false;
    }
    const at = new Date().toISOString();
    this.ultimoResumen = { ...r, origen, desde: desdeDia, hasta: hastaDia, at };
    if (origen === 'resync') this.ultimoResyncAt = at;
    else this.ultimoReconcileAt = at;
    // PERSISTIDO (D12): sin esto, un redeploy de Railway dejaba `sync-estado`
    // en null y el panel decía «nunca corrió» aunque hubiera corrido de
    // madrugada. La memoria (arriba) sigue siendo la caché de lectura; una
    // hidratación posterior solo rellena lo que siga en null, así que jamás
    // pisa el resumen de esta pasada.
    await this.guardarEstadoSync();
    return r;
  }

  // ===== PASO INVERSO: GOOGLE → BD (D12, 12-sep-2026) =====

  /**
   * Borra de Google los eventos que NACIERON en VuelaTour y ya no tienen fila
   * viva que los apunte. Es la mitad que faltaba de la red de seguridad: el
   * barrido directo solo mira FILAS VIVAS, así que un evento huérfano (Google
   * caído al cancelar, un `insert` duplicado por una carrera, un DELETE por
   * SQL de antes de los triggers) se quedaba PARA SIEMPRE en el calendario de
   * la oficina.
   *
   * CÓMO SE RECONOCE LO NUESTRO: por `extendedProperties.private.vuelatour_*`
   * (`vuelatour_vuelo_id`, `vuelatour_descanso_id`, `vuelatour_evento_id`,
   * `vuelatour_mantenimiento_id`). **Un evento SIN ninguna de esas anclas NO
   * se toca jamás**: es de la oficina (pedido del cliente C7).
   *
   * POR QUÉ UN SOLO LISTADO DE LA VENTANA Y NO CUATRO CON
   * `privateExtendedProperty` (desviación deliberada del plan D12): ese
   * parámetro de la API de Google exige `propertyName=value` — un valor
   * CONCRETO. No existe forma de pedir «los eventos que TENGAN la propiedad
   * `vuelatour_vuelo_id`, con cualquier valor»: `vuelatour_vuelo_id=*` se toma
   * literal y no empata con nada, así que el paso inverso no borraría NUNCA
   * nada (una red de seguridad falsa, peor que ninguna). Y los valores
   * concretos que sí conocemos son los de las filas VIVAS, justo los que NO
   * hay que borrar. Por eso se lista la ventana una vez (`timeMin`/`timeMax`,
   * `singleEvents: true`, `showDeleted: false`, paginado con `pageToken`) y se
   * clasifica del lado del API: una sola consulta paginada en vez de cuatro, y
   * `fields` recorta la respuesta a id + summary + created +
   * extendedProperties.
   *
   * VOLUMEN: lecturas de BD por LOTES (`in (...)` de ≤ `LOTE_IDS_BD` = 150
   * ids), nunca N+1 — 1 consulta por cada 150 entidades (2 en el caso del
   * vuelo: la fila y sus tramos, y la de tramos PAGINADA porque es la única
   * que devuelve varias filas por entidad).
   *
   * ANTE LA DUDA NO SE BORRA: si una consulta a la BD falla, o el id del ancla
   * no es un UUID, ese evento se CONSERVA y se cuenta un error. Y hay un tope
   * de `HUERFANOS_BORRADO_TOPE` borrados por pasada: si una noche quisiera
   * borrar más que eso, la premisa está mal (no el calendario) — se para y se
   * avisa en el log.
   */
  private async limpiarHuerfanos(
    desdeIso: string,
    hastaIso: string,
  ): Promise<{ borrados: number; errores: number }> {
    const res = { borrados: 0, errores: 0 };
    if (!this.calendar) return res;

    // 1) LISTAR la ventana en Google (paginado).
    const nuestros: EventoSistemaGoogle[] = [];
    let manuales = 0;
    let pageToken: string | undefined;
    let paginas = 0;
    try {
      do {
        const { data } = await this.calendar.events.list({
          calendarId: this.calendarId,
          timeMin: desdeIso,
          timeMax: hastaIso,
          singleEvents: true,
          showDeleted: false,
          maxResults: HUERFANOS_PAGINA_MAX,
          pageToken,
          // `created` (revisión adversaria 12-sep-2026): un evento recién
          // nacido puede ser legítimo con el id todavía sin guardar en su
          // fila — ver `esRecienCreado`.
          fields: 'nextPageToken,items(id,summary,created,extendedProperties)',
        });
        for (const ev of data?.items ?? []) {
          const nuestro = clasificarEventoSistema(ev);
          if (nuestro) nuestros.push(nuestro);
          else manuales++;
        }
        pageToken = data?.nextPageToken ?? undefined;
        paginas++;
      } while (pageToken && paginas < HUERFANOS_PAGINAS_TOPE);
      if (pageToken) {
        res.errores++;
        this.logger.warn(
          `paso inverso: la ventana tiene más de ${HUERFANOS_PAGINAS_TOPE * HUERFANOS_PAGINA_MAX} eventos; se revisó solo lo leído.`,
        );
      }
    } catch (err) {
      // Sin el listado no hay nada que decidir: se cuenta el error y NO se
      // borra nada (el reconcile de mañana lo reintenta).
      res.errores++;
      this.notarFalloGoogle(err, 'listar eventos de Google (paso inverso)');
      this.logger.error(
        `paso inverso: no se pudo listar el calendario: ${err instanceof Error ? err.message : String(err)}`,
      );
      return res;
    }

    if (nuestros.length === 0) {
      this.logger.log(
        `paso inverso: ${manuales} eventos de la oficina (intactos), ninguno del sistema en la ventana.`,
      );
      return res;
    }

    // 2) VERIFICAR contra la BD, por tipo y por lotes.
    const porTipo = new Map<TipoAnclaCalendar, Set<string>>();
    for (const ev of nuestros) {
      const ya = porTipo.get(ev.tipo);
      if (ya) ya.add(ev.entidadId);
      else porTipo.set(ev.tipo, new Set([ev.entidadId]));
    }
    const mapas = new Map<
      TipoAnclaCalendar,
      { verificados: Set<string>; vivos: Map<string, Set<string>> }
    >();
    for (const [tipo, ids] of porTipo) {
      const v = await this.verificarVivos(tipo, [...ids]);
      res.errores += v.errores;
      mapas.set(tipo, { verificados: v.verificados, vivos: v.vivos });
    }

    // 3) BORRAR lo huérfano (y solo eso).
    let noVerificables = 0;
    let recientes = 0;
    let tope = false;
    const ahoraMs = Date.now();
    for (const ev of nuestros) {
      const m = mapas.get(ev.tipo);
      const decision = m
        ? decidirHuerfano(ev, m.verificados, m.vivos)
        : 'no_verificable';
      if (decision === 'conservar') continue;
      if (decision === 'no_verificable') {
        noVerificables++;
        continue;
      }
      // RECIÉN CREADO (revisión adversaria 12-sep-2026): sin la cola activa
      // los hooks escriben DIRECTO a Google en cualquier momento, también
      // durante la media hora que dura el reconcile, y guardan el
      // `google_calendar_id` un instante DESPUÉS del `insert`. Si el paso
      // inverso lo listó en ese hueco, la fila apunta a null y lo tomaría por
      // duplicado fantasma: sería BORRAR UN EVENTO VIVO. Un huérfano de verdad
      // nunca es nuevo; esperar a la noche siguiente no cuesta nada.
      if (esRecienCreado(ev.creadoMs, ahoraMs)) {
        recientes++;
        continue;
      }
      if (res.borrados >= HUERFANOS_BORRADO_TOPE) {
        tope = true;
        break;
      }
      // Google acaba de decir cuota/429: los demás borrados van a fallar
      // igual y el reconcile de mañana los vuelve a ver.
      if (this.pausadaHastaMs > ahoraMs) {
        res.errores++;
        this.logger.warn(
          'paso inverso: Google respondió cuota/límite; el resto de los huérfanos se revisa en la próxima pasada.',
        );
        break;
      }
      if (await this.deleteEvent(ev.eventId)) {
        res.borrados++;
        this.logger.log(
          `paso inverso: borrado ${ev.tipo} ${ev.entidadId} («${ev.summary ?? ''}») — ${
            decision === 'borrar_duplicado'
              ? 'duplicado: la fila apunta a otro evento'
              : 'la fila ya no existe'
          }.`,
        );
      } else {
        res.errores++;
      }
    }
    if (tope) {
      res.errores++;
      this.logger.error(
        `ALERTA · paso inverso: se alcanzó el tope de ${HUERFANOS_BORRADO_TOPE} eventos borrados en una pasada y se detuvo. Revisar a mano antes de la próxima noche.`,
      );
    }
    this.logger.log(
      `paso inverso [${this.diaCancun(desdeIso)} → ${this.diaCancun(hastaIso)}]: ${nuestros.length} eventos del sistema, ${res.borrados} huérfanos borrados, ${noVerificables} sin verificar (intactos), ${recientes} recién creados (intactos), ${manuales} de la oficina (intactos).`,
    );
    return res;
  }

  /**
   * Qué eventos de Google apunta HOY la BD para estas entidades. Devuelve:
   * - `verificados`: ids cuya consulta SÍ respondió (lo que no está acá no se
   *   borra: no saber ≠ no existir);
   * - `vivos`: id de entidad → ids de evento que sus filas apuntan;
   * - `errores`: lotes que no se pudieron leer.
   *
   * EL VUELO SIGUE LEYENDO LAS COLUMNAS LEGADO (`google_calendar_regreso_id`
   * y `escala.google_calendar_id`) aunque desde el 15-sep-2026 solo publique
   * UNA fila: mientras un borrado legado falle, su id se conserva y ese
   * evento debe CONSERVARSE (lo reintenta `limpiarEventosLegado`). En cuanto
   * la columna queda en null, el evento viejo (`vuelatour_tramo` = 'ida' /
   * 'regreso' / 'leg-N') ya no está en `vivos` y este paso lo borra como
   * duplicado fantasma — que es justo lo que hay que hacer con él.
   */
  private async verificarVivos(
    tipo: TipoAnclaCalendar,
    ids: string[],
  ): Promise<{
    verificados: Set<string>;
    vivos: Map<string, Set<string>>;
    errores: number;
  }> {
    const verificados = new Set<string>();
    const vivos = new Map<string, Set<string>>();
    let errores = 0;
    // Un ancla que no es UUID no se puede consultar (y `in (...)` con basura
    // reventaría el lote entero): queda fuera y `decidirHuerfano` la marca
    // «no verificable» ⇒ el evento se conserva.
    const utiles = ids.filter((id) => esUuidCalendar(id));
    const TABLA: Record<Exclude<TipoAnclaCalendar, 'vuelo'>, string> = {
      descanso: 'piloto_descanso',
      evento: 'evento_flota',
      mantenimiento: 'mantenimiento',
    };
    for (const lote of lotesDe(utiles)) {
      try {
        if (tipo === 'vuelo') {
          const { data, error } = (await this.supabase.service
            .from('vuelo')
            .select('id, google_calendar_id, google_calendar_regreso_id')
            .in('id', lote)) as {
            data: Array<{
              id: string;
              google_calendar_id: string | null;
              google_calendar_regreso_id: string | null;
            }> | null;
            error: { message: string } | null;
          };
          if (error) throw new Error(error.message);
          for (const v of data ?? []) {
            const set = new Set<string>();
            if (v.google_calendar_id) set.add(v.google_calendar_id);
            if (v.google_calendar_regreso_id)
              set.add(v.google_calendar_regreso_id);
            vivos.set(v.id, set);
          }
          // Los eventos POR TRAMO llevan el ancla del VUELO: sus ids viven en
          // `escala.google_calendar_id` y son igual de legítimos.
          //
          // PAGINADO (revisión adversaria 12-sep-2026): esta es la única
          // lectura del paso inverso que puede devolver MÁS de una fila por
          // entidad (un lote de vuelos × sus tramos). PostgREST corta en
          // `max-rows` = 1000 SIN avisar, y una fila que falta acá no es un
          // hueco inocente: el evento de ese tramo dejaría de estar en
          // `vivos` y se borraría como «duplicado fantasma» — BORRAR UN
          // EVENTO VIVO, justo lo que este paso no puede hacer nunca.
          const legs = await this.leerPaginado<{
            vuelo_id: string;
            google_calendar_id: string | null;
          }>((desde, hasta) =>
            this.supabase.service
              .from('escala')
              .select('vuelo_id, google_calendar_id')
              .in('vuelo_id', lote)
              .not('google_calendar_id', 'is', null)
              .order('id', { ascending: true })
              .range(desde, hasta),
          );
          if (legs.error) throw new Error(legs.error);
          for (const l of legs.filas) {
            if (!l.google_calendar_id) continue;
            const set = vivos.get(l.vuelo_id);
            // Sin fila de vuelo no hay a quién sumarle el tramo (no debería
            // pasar: `escala.vuelo_id` es FK con CASCADE).
            if (set) set.add(l.google_calendar_id);
          }
        } else {
          const tabla = TABLA[tipo];
          const { data, error } = (await this.supabase.service
            .from(tabla)
            .select('id, google_calendar_id')
            .in('id', lote)) as {
            data: Array<{
              id: string;
              google_calendar_id: string | null;
            }> | null;
            error: { message: string } | null;
          };
          if (error) throw new Error(error.message);
          for (const f of data ?? []) {
            vivos.set(
              f.id,
              new Set(f.google_calendar_id ? [f.google_calendar_id] : []),
            );
          }
        }
        for (const id of lote) verificados.add(id);
      } catch (err) {
        errores++;
        this.logger.warn(
          `paso inverso: no se pudo verificar un lote de ${tipo} (${err instanceof Error ? err.message : String(err)}): esos eventos NO se tocan.`,
        );
      }
    }
    return { verificados, vivos, errores };
  }

  /**
   * Borra de Google los eventos LEGADO de este vuelo —el de REGRESO
   * (`vuelo.google_calendar_regreso_id`) y el de cada TRAMO
   * (`escala.google_calendar_id`)— y limpia sus columnas. Desde el
   * 15-sep-2026 el vuelo entero es UNA SOLA FILA: estos ids solo pueden venir
   * de una sincronización anterior, y dejarlos vivos le pondría al mecánico
   * dos (o cinco) filas del mismo vuelo.
   *
   * Un borrado que FALLA conserva su id —la próxima pasada lo reintenta— y
   * devuelve `false`; nunca se limpia una columna cuyo evento sigue en
   * Google (sería un fantasma imborrable). La fila en memoria se actualiza
   * para que el resto de la pasada vea el estado real.
   */
  private async limpiarEventosLegado(vuelo: VueloRow): Promise<boolean> {
    let ok = true;
    if (vuelo.google_calendar_regreso_id) {
      if (await this.deleteEvent(vuelo.google_calendar_regreso_id)) {
        await this.saveEventId(vuelo.id, 'google_calendar_regreso_id', null);
        vuelo.google_calendar_regreso_id = null;
      } else ok = false;
    }
    for (const e of vuelo.escalas ?? []) {
      if (!e.google_calendar_id) continue;
      if (await this.deleteEvent(e.google_calendar_id)) {
        await this.saveLegEventId(e.id, null);
        e.google_calendar_id = null;
      } else ok = false;
    }
    return ok;
  }

  /**
   * Crea o actualiza un evento ya construido y devuelve su id.
   *
   * IDEMPOTENCIA (12-sep-2026): con un id guardado SOLO se re-crea el evento
   * cuando Google dice que ya no existe (404/410 — lo borraron a mano en
   * Calendar). Ante cualquier OTRO fallo (403 de cuota, 429, 5xx, red) el
   * error se propaga: re-crear ahí duplicaría el evento en el calendario de
   * la oficina y dejaría huérfano al anterior (el id nuevo pisaba al viejo y
   * el viejo ya nunca se actualizaba ni se borraba). El llamador lo cuenta en
   * `errores`, conserva el id y el siguiente reconcile/hook lo reintenta.
   */
  private async upsertRaw(
    event: calendar_v3.Schema$Event,
    currentEventId: string | null,
    label: string,
  ): Promise<string | null> {
    if (!this.calendar) return currentEventId;
    if (currentEventId) {
      try {
        await this.calendar.events.update({
          calendarId: this.calendarId,
          eventId: currentEventId,
          requestBody: event,
        });
        return currentEventId;
      } catch (err) {
        if (!eventoAusenteEnGoogle(err)) throw err;
        // El evento fue borrado del lado de Calendar — se recrea.
        this.logger.warn(
          `Update failed for ${label} event ${currentEventId}, recreating: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const created = await this.calendar.events.insert({
      calendarId: this.calendarId,
      requestBody: event,
    });
    return created.data.id ?? null;
  }

  /**
   * Evento de día completo en el calendario compartido para un descanso de
   * piloto. Devuelve el eventId (para guardarlo en piloto_descanso). Best-effort.
   */
  async upsertDescansoEvent(
    d: {
      /**
       * `piloto_descanso.id`. Sin él el evento sale SIN el ancla
       * `vuelatour_descanso_id` y el paso inverso no puede reconocerlo como
       * nuestro (lo trataría como un evento manual de la oficina y lo dejaría
       * vivo para siempre). Opcional solo por compatibilidad: TODO llamador
       * nuevo lo manda.
       */
      id?: string | null;
      piloto_nombre: string;
      fecha_inicio: string; // YYYY-MM-DD
      fecha_fin: string; // YYYY-MM-DD (inclusivo)
      motivo?: string | null;
      google_calendar_id?: string | null;
    },
    opts?: OpcionesEspejo,
  ): Promise<string | null> {
    // Modo automático: el trigger de `piloto_descanso` ya encoló el descanso;
    // el hook solo pide drenar. Se devuelve el id ACTUAL (ningún llamador
    // escribe null encima, y así no se pierde el que ya estaba guardado).
    if (await this.delegarEnCola(opts)) {
      this.drenarPronto();
      return d.google_calendar_id ?? null;
    }
    if (!this.calendar) return d.google_calendar_id ?? null;
    // Google usa fin EXCLUSIVO en eventos de día completo: fin + 1 día.
    const fin = new Date(`${d.fecha_fin}T12:00:00Z`);
    fin.setUTCDate(fin.getUTCDate() + 1);
    const event = {
      summary: `😴 Descansa · ${d.piloto_nombre}`,
      description: d.motivo ?? undefined,
      // El turquesa del sistema traducido (12-sep-2026): antes el descanso
      // salía SIN color y Google lo pintaba del default del calendario.
      colorId: colorIdGoogleDescanso(),
      start: { date: d.fecha_inicio },
      end: { date: fin.toISOString().slice(0, 10) },
      transparency: 'transparent',
      // Ancla de idempotencia (12-sep-2026, D12): antes el descanso era el
      // ÚNICO evento nuestro sin ancla, así que el paso inverso no podía
      // distinguir uno huérfano de un evento manual de la oficina.
      ...(d.id
        ? { extendedProperties: { private: { [ANCLA_DESCANSO]: d.id } } }
        : {}),
    };
    try {
      return await this.upsertRaw(
        event,
        d.google_calendar_id ?? null,
        'descanso',
      );
    } catch (err) {
      // `null` = FALLÓ (12-sep-2026): antes devolvía el id guardado y el
      // barrido lo contaba como éxito. Ningún llamador escribe null encima
      // (pilots.service y el barrido solo persisten con id truthy).
      this.notarFalloGoogle(err, 'descanso');
      this.logger.warn(
        `No se pudo sincronizar el descanso a Google Calendar: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Espejo de UN descanso POR ID (worker de la cola, D2): carga la fila, la
   * sube y persiste el id si Google devolvió otro. Una fila borrada ⇒ `true`
   * (no hay nada que hacer; su evento lo mata el item `borrar_evento` que el
   * trigger encoló con el id de OLD).
   */
  async syncDescanso(
    descansoId: string,
    opts?: OpcionesEspejo,
  ): Promise<boolean> {
    if (!this.enabled || !this.calendar) return true;
    if (await this.delegarEnCola(opts)) {
      this.drenarPronto();
      return true;
    }
    try {
      const { data, error } = (await this.supabase.service
        .from('piloto_descanso')
        .select(
          'id, fecha_inicio, fecha_fin, motivo, google_calendar_id, piloto:usuario!piloto_id(nombre)',
        )
        .eq('id', descansoId)
        .maybeSingle()) as {
        data: {
          id: string;
          fecha_inicio: string;
          fecha_fin: string;
          motivo: string | null;
          google_calendar_id: string | null;
          piloto: { nombre: string } | { nombre: string }[] | null;
        } | null;
        error: { message: string } | null;
      };
      if (error) throw new Error(error.message);
      if (!data) return true;

      const eventId = await this.upsertDescansoEvent(
        {
          id: data.id,
          piloto_nombre: unwrap(data.piloto)?.nombre ?? 'Piloto',
          fecha_inicio: data.fecha_inicio,
          fecha_fin: data.fecha_fin,
          motivo: data.motivo,
          google_calendar_id: data.google_calendar_id,
        },
        { directo: true },
      );
      if (!eventId) return false;
      if (eventId !== data.google_calendar_id) {
        const { error: errId } = await this.supabase.service
          .from('piloto_descanso')
          .update({ google_calendar_id: eventId })
          .eq('id', data.id);
        if (errId) throw new Error(errId.message);
      }
      return true;
    } catch (err) {
      this.notarFalloGoogle(err, `descanso ${descansoId}`);
      this.logger.error(
        `syncDescanso(${descansoId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Espejo de UN evento de flota POR ID (worker de la cola, D2). Fila
   * borrada ⇒ `true` (su evento lo mata el item `borrar_evento`).
   */
  async syncEvento(eventoId: string, opts?: OpcionesEspejo): Promise<boolean> {
    if (!this.enabled || !this.calendar) return true;
    if (await this.delegarEnCola(opts)) {
      this.drenarPronto();
      return true;
    }
    try {
      const { data, error } = (await this.supabase.service
        .from('evento_flota')
        .select(
          'id, titulo, fecha, fecha_fin, notas, google_calendar_id, aeronave:aeronave_id(matricula, color_calendario), responsable:usuario!responsable_id(nombre)',
        )
        .eq('id', eventoId)
        .maybeSingle()) as {
        data: {
          id: string;
          titulo: string | null;
          fecha: string;
          fecha_fin: string | null;
          notas: string | null;
          google_calendar_id: string | null;
          aeronave: AeronaveRef | AeronaveRef[] | null;
          responsable: { nombre: string } | { nombre: string }[] | null;
        } | null;
        error: { message: string } | null;
      };
      if (error) throw new Error(error.message);
      if (!data) return true;

      // `upsertEventoFlotaEvent` persiste el id por su cuenta (contrato de la
      // migración 20260829: esa columna solo la escribe calendar-sync).
      const eventId = await this.upsertEventoFlotaEvent(
        {
          id: data.id,
          titulo: data.titulo ?? 'Evento',
          fecha: data.fecha,
          fecha_fin: data.fecha_fin,
          aeronave_matricula: unwrap(data.aeronave)?.matricula ?? null,
          aeronave_color: unwrap(data.aeronave)?.color_calendario ?? null,
          responsable_nombre: unwrap(data.responsable)?.nombre ?? null,
          notas: data.notas,
          google_calendar_id: data.google_calendar_id,
        },
        { directo: true },
      );
      return eventId != null;
    } catch (err) {
      this.notarFalloGoogle(err, `evento ${eventoId}`);
      this.logger.error(
        `syncEvento(${eventoId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** Borra el evento de un descanso del calendario compartido. Best-effort. */
  async removeDescansoEvent(eventId: string | null | undefined): Promise<void> {
    if (eventId) await this.deleteEvent(eventId);
  }

  /**
   * Borra el evento de Google de UN TRAMO que está por desaparecer de la BD
   * (revisión adversaria 12-sep-2026, huérfanos §4 de la auditoría).
   *
   * Se llama ANTES del `.delete()` de la escala: después, `syncFlight` ya no
   * ve ese tramo ni su `google_calendar_id` y el evento se queda VIVO en el
   * calendario de la oficina sin fila que lo apunte — un fantasma que nadie
   * puede borrar. Lo usan `flights.deleteEscala` y
   * `quotes.replaceEscalas` (tramos sobrantes al re-cotizar, el huérfano más
   * frecuente en operación normal).
   *
   * Con la COLA activa esto es un cinturón: el trigger del DELETE encola
   * `borrar_evento` con el id de OLD y el worker lo reintenta si aquí falla.
   * Sin cola es la ÚNICA limpieza posible, y por eso no espera a la
   * migración. Best-effort: nunca lanza.
   */
  async removeEscalaEvent(eventId: string | null | undefined): Promise<void> {
    if (eventId) await this.deleteEvent(eventId);
  }

  /**
   * Evento de día completo en el calendario compartido para un evento NO-vuelo
   * de la flota (lavado, trámite, visita…). Mismo patrón que los descansos,
   * con una diferencia: el id de Google lo persiste ESTE servicio en
   * `evento_flota.google_calendar_id` (contrato de la migración 20260829:
   * esa columna solo la escribe calendar-sync). Best-effort.
   */
  async upsertEventoFlotaEvent(
    ev: {
      id: string;
      titulo: string;
      fecha: string; // ISO timestamptz (inicio)
      fecha_fin?: string | null; // ISO timestamptz (fin INCLUSIVO); null = un día
      aeronave_matricula?: string | null;
      /** `aeronave.color_calendario` del avión del evento (si tiene). */
      aeronave_color?: string | null;
      responsable_nombre?: string | null;
      notas?: string | null;
      google_calendar_id?: string | null;
    },
    opts?: OpcionesEspejo,
  ): Promise<string | null> {
    if (!this.enabled || !this.calendar) return ev.google_calendar_id ?? null;
    // Modo automático: el trigger de `evento_flota` ya encoló el evento.
    if (await this.delegarEnCola(opts)) {
      this.drenarPronto();
      return ev.google_calendar_id ?? null;
    }
    try {
      // Día operativo en Cancún (mismo criterio que el calendario interno).
      const iniDia = this.diaCancun(ev.fecha);
      const finDia = ev.fecha_fin ? this.diaCancun(ev.fecha_fin) : iniDia;
      // Google usa fin EXCLUSIVO en eventos de día completo: fin + 1 día.
      const fin = new Date(`${finDia}T12:00:00Z`);
      fin.setUTCDate(fin.getUTCDate() + 1);
      const extras = [ev.aeronave_matricula, ev.responsable_nombre].filter(
        (s): s is string => !!s,
      );
      const event: calendar_v3.Schema$Event = {
        summary: `📌 ${ev.titulo}${extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}`,
        description: [
          ev.aeronave_matricula ? `Aeronave: ${ev.aeronave_matricula}` : null,
          ev.responsable_nombre
            ? `Responsable: ${ev.responsable_nombre}`
            : null,
          ev.notas ? `Notas: ${ev.notas}` : null,
          `VuelaTour · evento ${ev.id}`,
        ]
          .filter(Boolean)
          .join('\n'),
        // Con avión, el COLOR DEL AVIÓN (igual que el calendario del
        // sistema); sin avión, el azul cielo propio de los eventos.
        colorId: colorIdGoogleEvento(ev.aeronave_color),
        start: { date: iniDia },
        end: { date: fin.toISOString().slice(0, 10) },
        transparency: 'transparent',
        // Ancla de idempotencia — reconoce nuestros propios eventos.
        extendedProperties: { private: { [ANCLA_EVENTO]: ev.id } },
      };
      const eventId = await this.upsertRaw(
        event,
        ev.google_calendar_id ?? null,
        'evento flota',
      );
      if (eventId !== (ev.google_calendar_id ?? null)) {
        await this.saveEventoFlotaEventId(ev.id, eventId);
      }
      return eventId;
    } catch (err) {
      // `null` = FALLÓ (mismo criterio que el descanso): el barrido lo cuenta
      // en `errores` y el id guardado se conserva (aquí no se escribe).
      this.notarFalloGoogle(err, `evento de flota ${ev.id}`);
      this.logger.warn(
        `No se pudo sincronizar el evento de flota ${ev.id} a Google Calendar: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Borra el evento de flota del calendario compartido. Best-effort. */
  async removeEventoFlotaEvent(
    ev: { google_calendar_id?: string | null } | null | undefined,
  ): Promise<void> {
    if (ev?.google_calendar_id) await this.deleteEvent(ev.google_calendar_id);
  }

  // ===== MANTENIMIENTOS (C1, 12-sep-2026) =====

  /**
   * Espejo de UN mantenimiento en el Google Calendar de la oficina: evento de
   * DÍA COMPLETO en `fecha_programada` (DATE = día Cancún), ámbar si está
   * PROGRAMADO y rojo si está EN_TALLER, con el id guardado en
   * `mantenimiento.google_calendar_id`.
   *
   * COMPLETADO o sin fecha ⇒ se BORRA el evento (el calendario del sistema
   * tampoco los pinta: `calendar.service` filtra `neq COMPLETADO` y exige
   * `fecha_programada`). Idempotente: reusa el id guardado y solo re-crea si
   * el evento fue borrado del lado de Google.
   *
   * Devuelve `true` si quedó sincronizado (o no había nada que hacer) y
   * `false` si falló — SOLO informativo para los conteos del resync/cron: los
   * hooks `void this.calendarSync.syncMantenimiento(id)` lo ignoran y jamás
   * ven un error (best-effort, nunca bloquea al mecánico ni a la oficina).
   */
  async syncMantenimiento(
    mantenimientoId: string,
    opts?: OpcionesEspejo,
  ): Promise<boolean> {
    if (!this.enabled || !this.calendar) return true;
    // Modo automático: el trigger de `mantenimiento` ya encoló el cambio.
    if (await this.delegarEnCola(opts)) {
      this.drenarPronto();
      return true;
    }
    return this.syncMantenimientoAhora(mantenimientoId);
  }

  /** Escritura DIRECTA a Google de un mantenimiento (worker y barrido). */
  private async syncMantenimientoAhora(
    mantenimientoId: string,
  ): Promise<boolean> {
    if (!this.enabled || !this.calendar) return true;
    try {
      const { data, error } = await this.supabase.service
        .from('mantenimiento')
        .select(MANT_SELECT)
        .eq('id', mantenimientoId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const m = (data as unknown as MantenimientoRow) ?? null;
      // Borrado de la BD: su evento se limpia con removeMantenimientoEvent
      // desde el camino de la baja (aquí ya no hay fila que leer).
      if (!m) return true;

      const dia = m.fecha_programada
        ? String(m.fecha_programada).slice(0, 10)
        : null;
      if (m.estado === 'COMPLETADO' || !dia) {
        if (m.google_calendar_id) {
          // El id solo se limpia si el evento QUEDÓ fuera de Google; si no,
          // se conserva y el siguiente hook/reconcile reintenta el borrado.
          if (!(await this.deleteEvent(m.google_calendar_id))) return false;
          await this.saveMantenimientoEventId(m.id, null);
        }
        return true;
      }

      const eventId = await this.upsertRaw(
        this.buildMantenimientoEvent(m, dia),
        m.google_calendar_id,
        `mantenimiento ${m.id}`,
      );
      if (eventId !== m.google_calendar_id) {
        await this.saveMantenimientoEventId(m.id, eventId);
      }
      return true;
    } catch (err) {
      this.notarFalloGoogle(err, `mantenimiento ${mantenimientoId}`);
      this.logger.error(
        `syncMantenimiento(${mantenimientoId}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * Borra el evento de un mantenimiento (baja/borrado de la fila, donde ya no
   * se puede releer el id). Best-effort, espejo de `removeDescansoEvent`.
   */
  async removeMantenimientoEvent(
    eventId: string | null | undefined,
  ): Promise<void> {
    if (eventId) await this.deleteEvent(eventId);
  }

  /** Evento de Google (día completo) de un mantenimiento con fecha. */
  private buildMantenimientoEvent(
    m: MantenimientoRow,
    dia: string,
  ): calendar_v3.Schema$Event {
    const enTaller = m.estado === 'EN_TALLER';
    const matricula = unwrap(m.aeronave)?.matricula ?? 'avión';
    const desc = (m.descripcion ?? '').trim() || 'Servicio';
    // Google usa fin EXCLUSIVO en eventos de día completo: fin + 1 día.
    const fin = new Date(`${dia}T12:00:00Z`);
    fin.setUTCDate(fin.getUTCDate() + 1);
    const horas =
      m.horas_programadas == null ? null : Number(m.horas_programadas);
    const intervalo =
      m.etapa_intervalo_hr == null ? null : Number(m.etapa_intervalo_hr);
    return {
      summary: `🔧 ${enTaller ? 'En taller' : 'Servicio'} · ${matricula} · ${desc}`,
      description: [
        `Estado: ${m.estado ?? 'PROGRAMADO'}`,
        horas != null && Number.isFinite(horas)
          ? `Horas programadas: ${horas} hr`
          : null,
        intervalo != null && Number.isFinite(intervalo)
          ? `Intervalo de servicio: ${intervalo} hr`
          : null,
        '',
        `VuelaTour · mantenimiento ${m.id}`,
      ]
        .filter((l) => l != null)
        .join('\n'),
      colorId: colorIdGoogleMantenimiento(enTaller),
      start: { date: dia },
      end: { date: fin.toISOString().slice(0, 10) },
      transparency: 'transparent',
      // Ancla de idempotencia — reconoce nuestros propios eventos.
      extendedProperties: { private: { [ANCLA_MANTENIMIENTO]: m.id } },
    };
  }

  private async saveMantenimientoEventId(
    mantenimientoId: string,
    eventId: string | null,
  ): Promise<void> {
    const { error } = await this.supabase.service
      .from('mantenimiento')
      .update({ google_calendar_id: eventId })
      .eq('id', mantenimientoId);
    if (error) {
      this.logger.error(
        `Failed to persist mantenimiento google_calendar_id for ${mantenimientoId}: ${error.message}`,
      );
    }
  }

  /**
   * Borra un evento. Devuelve `true` cuando el evento QUEDÓ FUERA de Google
   * (se borró ahora, o ya no estaba: 404/410) y `false` si el borrado falló
   * de verdad (cuota, red, 5xx).
   *
   * Quien guarda el id SOLO debe limpiarlo con `true` (12-sep-2026): antes se
   * limpiaba siempre y un fallo de Google dejaba el evento vivo en el
   * calendario de la oficina SIN id en la BD — un fantasma que ya nadie podía
   * borrar (el caso típico: cancelar un vuelo con Google caído).
   */
  private async deleteEvent(eventId: string): Promise<boolean> {
    if (!this.calendar) return false;
    try {
      await this.calendar.events.delete({
        calendarId: this.calendarId,
        eventId,
      });
      return true;
    } catch (err) {
      // Ya no existía: el objetivo (que no esté) se cumple igual.
      if (eventoAusenteEnGoogle(err)) return true;
      this.notarFalloGoogle(err, `borrar evento ${eventId}`);
      this.logger.warn(
        `Delete failed for event ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Delete both Calendar events (ida + regreso) for a flight and clear their
   * ids — más los de cada tramo. Devuelve `true` si TODO quedó fuera de
   * Google. Un id solo se limpia cuando su borrado funcionó: si Google falla
   * al cancelar un vuelo, el id se conserva y el barrido de la ventana (que
   * SÍ incluye cancelados) lo reintenta en vez de dejar un evento fantasma.
   * Los ~4 llamadores externos ignoran el boolean (siguen siendo `void`).
   */
  async removeFlight(vueloId: string): Promise<boolean> {
    if (!this.enabled || !this.calendar) return true;
    let ok = true;
    try {
      const { data: row } = (await this.supabase.service
        .from('vuelo')
        .select('google_calendar_id, google_calendar_regreso_id')
        .eq('id', vueloId)
        .maybeSingle()) as {
        data: {
          google_calendar_id: string | null;
          google_calendar_regreso_id: string | null;
        } | null;
      };
      if (row?.google_calendar_id) {
        if (await this.deleteEvent(row.google_calendar_id))
          await this.saveEventId(vueloId, 'google_calendar_id', null);
        else ok = false;
      }
      if (row?.google_calendar_regreso_id) {
        if (await this.deleteEvent(row.google_calendar_regreso_id))
          await this.saveEventId(vueloId, 'google_calendar_regreso_id', null);
        else ok = false;
      }
      // Eventos por tramo (itinerarios personalizados).
      const { data: legs } = await this.supabase.service
        .from('escala')
        .select('id, google_calendar_id')
        .eq('vuelo_id', vueloId)
        .not('google_calendar_id', 'is', null);
      for (const leg of (legs ?? []) as {
        id: string;
        google_calendar_id: string;
      }[]) {
        if (await this.deleteEvent(leg.google_calendar_id))
          await this.saveLegEventId(leg.id, null);
        else ok = false;
      }
    } catch (err) {
      ok = false;
      this.notarFalloGoogle(err, `borrar eventos del vuelo ${vueloId}`);
      this.logger.error(
        `removeFlight(${vueloId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return ok;
  }

  /**
   * Lee el vuelo con todo lo que pinta su fila de Google.
   *
   * TOLERA que la migración `20260917000001` (`usuario.apodo`) no esté
   * aplicada: PostgREST responde 42703 y, sin este degradado, TODA la
   * sincronización del calendario moriría entre el deploy del API y la
   * migración. Se degrada UNA vez (avisa una vez) y sigue con el primer
   * nombre del piloto hasta el siguiente reinicio.
   */
  private async loadVuelo(vueloId: string): Promise<VueloRow | null> {
    const leer = async (
      select: string,
    ): Promise<{
      data: unknown;
      error: { code?: string | null; message: string } | null;
    }> => {
      const res = await this.supabase.service
        .from('vuelo')
        .select(select)
        .eq('id', vueloId)
        .maybeSingle();
      return { data: res.data as unknown, error: res.error ?? null };
    };

    let { data, error } = await leer(
      this.apodoDisponible ? VUELO_SELECT : VUELO_SELECT_SIN_APODO,
    );
    if (error && this.apodoDisponible && esColumnaInexistente(error)) {
      this.apodoDisponible = false;
      this.logger.warn(
        `Columna usuario.apodo no existe todavía (migración ${MIGRACION_APODO} pendiente): el título de Google Calendar usa el PRIMER NOMBRE del piloto hasta aplicarla.`,
      );
      ({ data, error } = await leer(VUELO_SELECT_SIN_APODO));
    }
    if (error) throw new Error(error.message);
    return (data as VueloRow | null) ?? null;
  }

  /**
   * EL evento del vuelo: UNA SOLA FILA con `{piloto} {AVIÓN} {ruta} {hora}`
   * (pedido del cliente, 15-sep-2026 — formato de los eventos que la oficina
   * capturaba a mano). `null` = no hay dónde ponerlo (sin fecha de salida).
   *
   * @param escalas TODOS los tramos (cancelados incluidos), ordenados por
   *   `orden`: son los que definen quién es el PRIMERO y el ÚLTIMO del
   *   itinerario para heredar `fecha_vuelo` / `fecha_traslado_final`.
   * @param activas los NO cancelados, en el mismo orden.
   */
  private buildEventoVuelo(
    v: VueloRow,
    escalas: EscalaRow[],
    activas: EscalaRow[],
  ): calendar_v3.Schema$Event | null {
    // TRAMOS de la fila. Sin escalas capturadas (vuelo viejo, externo o
    // recién creado) se arma el itinerario mínimo desde el vuelo: la ida y,
    // si es REDONDO, el regreso — así la ruta sale `cun-mid-cun` como la
    // escribía la oficina, no `cun-mid`.
    // Herencia de siempre para el tramo sin fecha propia: el PRIMERO del
    // itinerario toma `fecha_vuelo` y el ÚLTIMO `fecha_traslado_final`. Se
    // mide contra TODOS los tramos, no contra los activos: si se canceló la
    // ida de un redondo, el regreso sigue siendo el ÚLTIMO y hereda la fecha
    // de traslado final — no la de salida del vuelo, que ya no vuela nadie.
    const ordenPrimero = escalas[0]?.orden;
    const ordenUltimo = escalas[escalas.length - 1]?.orden;
    const tramos: TramoEventoVuelo[] =
      activas.length > 0
        ? activas.map((e) => ({
            orden: e.orden,
            origen: e.origen_iata,
            destino: e.destino_iata,
            salida:
              e.fecha_salida_plan ??
              (e.orden === ordenPrimero
                ? v.fecha_vuelo
                : e.orden === ordenUltimo
                  ? v.fecha_traslado_final
                  : null),
            ferry: e.es_ferry,
            pasajeros: e.es_ferry ? 0 : (e.pasajeros ?? v.pasajeros),
          }))
        : [
            {
              orden: 1,
              origen: v.origen_iata,
              destino: v.destino_iata,
              salida: v.fecha_vuelo,
              ferry: false,
              pasajeros: v.pasajeros,
            },
            ...(v.tipo === 'REDONDO'
              ? [
                  {
                    orden: 2,
                    origen: v.destino_iata,
                    destino: v.origen_iata,
                    salida: v.fecha_traslado_final,
                    ferry: false,
                    pasajeros: v.pasajeros,
                  },
                ]
              : []),
          ];

    // La fila EMPIEZA en la salida del primer tramo activo y TERMINA en el
    // instante conocido más tardío del vuelo + 1 h (nunca menos de 1 h): un
    // redondo es una fila 10:00–19:00 y un viaje con pernocta abarca sus
    // días. `escala` no tiene `fecha_llegada_plan` (verificado 17-sep-2026):
    // la llegada real todavía no se planea, solo se captura con los tacos.
    const inicio = tramos[0]?.salida ?? v.fecha_vuelo;
    const ventana = ventanaEventoVuelo(inicio, [
      ...tramos.map((t) => t.salida),
      v.fecha_traslado_final,
    ]);
    if (!ventana) return null;

    // ASIGNACIÓN del PRIMER tramo activo (con su herencia del vuelo), igual
    // que antes: es la que manda en el color de la fila.
    //
    // `unwrap` POR SEPARADO (revisión adversaria 17-sep-2026): con
    // `unwrap(primero?.aeronave ?? v.aeronave)` un embed vacío del tramo
    // (`[]` en vez de `null`, que PostgREST devuelve según la versión) gana
    // el `??` y el vuelo se publicaba como «sin avión»/«sin piloto» aunque
    // el tramo HEREDE la asignación del vuelo.
    const primero = activas[0] ?? null;
    const aeronave = unwrap(primero?.aeronave) ?? unwrap(v.aeronave);
    const piloto = unwrap(primero?.piloto) ?? unwrap(v.piloto);
    const cliente = unwrap(v.cliente);

    // EXTERNO: la casilla «avión» del título lleva la MATRÍCULA ajena cuando
    // la oficina la capturó; si no, el operador (que en la mayoría de los
    // vuelos externos de hoy ES la matrícula: «XA-TYV»). El nombre de una
    // persona en la casilla del avión no le sirve al mecánico.
    const aeronaveStr = v.es_externo
      ? v.avion_externo_matricula?.trim() ||
        v.operador_externo?.trim() ||
        'Externo'
      : (aeronave?.matricula ?? 'sin avión');

    // MULTI-AVIÓN y ROTACIÓN DE PILOTO: el título solo puede decir UN avión y
    // UN piloto (los del primer tramo activo). Lo que difiera se dice en la
    // línea de su tramo, que es donde el formato viejo lo tenía (un evento
    // por tramo con su matrícula). Sin esto, un vuelo con tramos en dos
    // aviones se leía como si todo lo volara el primero.
    if (activas.length > 0 && !v.es_externo) {
      activas.forEach((e, i) => {
        const avTramo = unwrap(e.aeronave) ?? unwrap(v.aeronave);
        const pilTramo = unwrap(e.piloto) ?? unwrap(v.piloto);
        if (avTramo?.matricula && avTramo.matricula !== aeronave?.matricula) {
          tramos[i].aeronave = avTramo.matricula;
        }
        if (pilTramo?.nombre && pilTramo.nombre !== piloto?.nombre) {
          tramos[i].piloto = nombreCortoPiloto(
            pilTramo.nombre,
            false,
            pilTramo.apodo,
          );
        }
      });
    }

    // COLOR: criterio de siempre, con los datos del primer tramo activo.
    const permisoPendientePrimero = primero
      ? primero.estado_permiso === 'pendiente'
      : v.estado_permiso === 'pendiente';
    // DESCRIPCIÓN: basta con que CUALQUIER tramo activo tenga el permiso
    // pendiente — ahora que el vuelo es una sola fila, callar el pendiente de
    // un tramo intermedio sería esconderlo. (El color sigue el del primero:
    // puede haber fila de color normal con «Permiso de pista: PENDIENTE» en
    // la descripción; el texto manda, el color solo ayuda.)
    const permisoPendiente =
      activas.length > 0
        ? activas.some((e) => e.estado_permiso === 'pendiente')
        : v.estado_permiso === 'pendiente';

    const summary = tituloEventoVuelo({
      pilotoCorto: nombreCortoPiloto(
        piloto?.nombre,
        v.es_externo,
        piloto?.apodo,
      ),
      aeronave: aeronaveStr,
      ruta: rutaMinusculas(tramos),
      hora: horaCortaCancun(ventana.inicio),
    });

    const description = descripcionEventoVuelo({
      id: v.id,
      folio: v.folio,
      estado: v.estado,
      cliente: cliente?.nombre ?? null,
      pasajeros: v.pasajeros,
      esExterno: v.es_externo,
      operadorExterno: v.operador_externo,
      matricula: aeronave?.matricula ?? null,
      pilotoNombre: piloto?.nombre ?? null,
      permisoPendiente,
      montoUsd: v.monto_total_usd,
      notas: v.notas,
      tramos,
    });

    // MISMO color que el calendario del sistema, traducido al más cercano de
    // Google (12-sep-2026): tentativo > sin asignar > permiso pendiente >
    // externo > color del avión. La precedencia no se repite aquí.
    const colorId = colorIdGoogleDeVuelo({
      estado: v.estado,
      esExterno: v.es_externo,
      aeronaveId: primero?.aeronave_id ?? v.aeronave_id,
      pilotoId: primero?.piloto_id ?? v.piloto_id,
      permisoPendiente: permisoPendientePrimero,
      colorAvion: aeronave?.color_calendario,
    });

    return {
      summary,
      description,
      colorId,
      start: {
        dateTime: ventana.inicio.toISOString(),
        timeZone: 'America/Cancun',
      },
      end: {
        dateTime: ventana.fin.toISOString(),
        timeZone: 'America/Cancun',
      },
      // Ancla de idempotencia — así reconocemos nuestros propios eventos.
      // `vuelatour_tramo: 'vuelo'` es el valor ÚNICO desde el 15-sep-2026;
      // 'ida' / 'regreso' / 'leg-N' son del formato viejo y el paso inverso
      // los borra en cuanto dejan de estar guardados en alguna columna.
      extendedProperties: {
        private: { [ANCLA_VUELO]: v.id, vuelatour_tramo: 'vuelo' },
      },
    };
  }

  private async saveEventId(
    vueloId: string,
    column: 'google_calendar_id' | 'google_calendar_regreso_id',
    eventId: string | null,
  ): Promise<void> {
    const { error } = await this.supabase.service
      .from('vuelo')
      .update({ [column]: eventId })
      .eq('id', vueloId);
    if (error) {
      this.logger.error(
        `Failed to persist ${column} for ${vueloId}: ${error.message}`,
      );
    }
  }

  private async saveLegEventId(
    escalaId: string,
    eventId: string | null,
  ): Promise<void> {
    const { error } = await this.supabase.service
      .from('escala')
      .update({ google_calendar_id: eventId })
      .eq('id', escalaId);
    if (error) {
      this.logger.error(
        `Failed to persist escala google_calendar_id for ${escalaId}: ${error.message}`,
      );
    }
  }

  private async saveEventoFlotaEventId(
    eventoId: string,
    eventId: string | null,
  ): Promise<void> {
    const { error } = await this.supabase.service
      .from('evento_flota')
      .update({ google_calendar_id: eventId })
      .eq('id', eventoId);
    if (error) {
      this.logger.error(
        `Failed to persist evento_flota google_calendar_id for ${eventoId}: ${error.message}`,
      );
    }
  }

  /**
   * Instante ISO NORMALIZADO de un parámetro opcional del resync (o el
   * default). 400 con mensaje en es-MX si la cadena no es una fecha real:
   * `@IsISO8601()` no lo garantiza y un `Invalid Date` reventaba la ruta.
   */
  private instanteValido(
    valor: string | undefined,
    campo: 'desde' | 'hasta',
    porDefecto: number,
  ): string {
    if (valor == null || valor.trim() === '')
      return new Date(porDefecto).toISOString();
    const d = new Date(valor);
    if (Number.isNaN(d.getTime()))
      throw new BadRequestException(
        `«${campo}» no es una fecha válida: usa un ISO como 2026-09-12 o 2026-09-12T00:00:00-05:00.`,
      );
    return d.toISOString();
  }

  /** Día calendario en Cancún (YYYY-MM-DD) de un instante ISO. */
  private diaCancun(iso: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Cancun',
    }).format(new Date(iso));
  }
}
