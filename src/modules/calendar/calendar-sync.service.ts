import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { calendar_v3, google } from 'googleapis';
import { JWT } from 'google-auth-library';
import type { EnvVars } from '../../config/env.schema';
import { SupabaseService } from '../supabase/supabase.service';
import {
  colorIdGoogleDescanso,
  colorIdGoogleDeVuelo,
  colorIdGoogleEvento,
  colorIdGoogleMantenimiento,
  eventoAusenteEnGoogle,
  nombreCortoPiloto,
  parsearServiceAccountJson,
} from './google-evento.util';

// NINGÚN colorId suelto vive acá (12-sep-2026): todo color sale de la paleta
// del sistema (`colores-calendario.util`) traducida al más cercano de Google
// por `google-evento.util`. Si el cliente cambia un color, se cambia allá y el
// panel, la app y Google se mueven JUNTOS.

const VUELO_SELECT =
  'id, folio, estado, es_externo, operador_externo, origen_iata, destino_iata, pasajeros, monto_total_usd, fecha_vuelo, fecha_traslado_final, tipo, notas, estado_permiso, aeronave_id, piloto_id, google_calendar_id, google_calendar_regreso_id, ' +
  'aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre), cliente:cliente_id(nombre), ' +
  'escalas:escala(id, orden, origen_iata, destino_iata, fecha_salida_plan, es_ferry, pasajeros, google_calendar_id, aeronave_id, piloto_id, estado_permiso, cancelada_at, aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre))';

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
  piloto: { nombre: string } | { nombre: string }[] | null;
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
    piloto: { nombre: string } | { nombre: string }[] | null;
  }> | null;
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

/** Conteos de una pasada de sincronización (resync o reconciliación). */
export interface ResumenSyncCalendar {
  vuelos: number;
  descansos: number;
  eventos: number;
  mantenimientos: number;
  /** Fallos OBSERVABLES (consulta o evento): nunca lanzan, solo se cuentan. */
  errores: number;
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
  // Estado VISIBLE de la sync (C5, 12-sep-2026): en MEMORIA del proceso a
  // propósito — es diagnóstico para el panel ("¿corrió?"), no un dato de
  // negocio; un redeploy lo reinicia en null y no pasa nada.
  private ultimoReconcileAt: string | null = null;
  private ultimoResyncAt: string | null = null;
  private ultimoResumen: EstadoSyncCalendar['ultimo_resumen'] = null;

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
  ) {}

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
  async syncFlight(vueloId: string): Promise<boolean> {
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

      // Itinerario personalizado (MULTIESCALA con escalas): un evento por tramo,
      // guardado en escala.google_calendar_id. El 1er tramo hereda fecha_vuelo y
      // el último fecha_traslado_final si no tienen fecha propia.
      const escalas = [...(vuelo.escalas ?? [])].sort(
        (a, b) => a.orden - b.orden,
      );
      // Un tramo CANCELADO no se agenda: su evento se elimina y no se re-crea.
      for (const c of escalas) {
        if (c.cancelada_at != null && c.google_calendar_id) {
          if (await this.deleteEvent(c.google_calendar_id))
            await this.saveLegEventId(c.id, null);
          else ok = false;
        }
      }
      const activas = escalas.filter((e) => e.cancelada_at == null);
      if (vuelo.tipo === 'MULTIESCALA' && activas.length > 0) {
        return (await this.syncLegs(vuelo, activas)) && ok;
      }

      // Without a date there is nothing meaningful to place on a calendar.
      if (!vuelo.fecha_vuelo) return ok;

      // La IDA (tramo orden 1) CANCELADA no se agenda: MISMO criterio que el
      // regreso y que los tramos del itinerario — un cancelado no vive en
      // Google, aunque el calendario del sistema lo conserve en rojo. Cubre
      // dos casos que antes publicaban un evento a nivel VUELO como si fuera
      // a volar (con el color del avión, no el rojo del sistema): la ida
      // cancelada de un REDONDO y el itinerario con TODOS sus tramos
      // cancelados (ahí `activas` queda vacío y la rama de tramos no corre).
      const idaCancelada = escalas.some(
        (e) => e.orden === 1 && e.cancelada_at != null,
      );
      if (idaCancelada) {
        if (vuelo.google_calendar_id) {
          if (await this.deleteEvent(vuelo.google_calendar_id))
            await this.saveEventId(vueloId, 'google_calendar_id', null);
          else ok = false;
        }
      } else {
        // IDA (en fecha_vuelo).
        const idaId = await this.upsertRaw(
          this.buildEvent(vuelo, 'ida'),
          vuelo.google_calendar_id,
          'ida',
        );
        await this.saveEventId(vueloId, 'google_calendar_id', idaId);
      }

      // REGRESO de redondo (en fecha_traslado_final): segundo evento. Si el
      // tramo de regreso (orden 2) está cancelado, su evento sobra.
      const regresoCancelado = escalas.some(
        (e) => e.orden === 2 && e.cancelada_at != null,
      );
      const esRedondo =
        vuelo.tipo === 'REDONDO' &&
        !!vuelo.fecha_traslado_final &&
        !regresoCancelado;
      if (esRedondo) {
        const regId = await this.upsertRaw(
          this.buildEvent(vuelo, 'regreso'),
          vuelo.google_calendar_regreso_id,
          'regreso',
        );
        await this.saveEventId(vueloId, 'google_calendar_regreso_id', regId);
      } else if (vuelo.google_calendar_regreso_id) {
        // Dejó de ser redondo (o se quitó el regreso): borra el evento de regreso.
        if (await this.deleteEvent(vuelo.google_calendar_regreso_id))
          await this.saveEventId(vueloId, 'google_calendar_regreso_id', null);
        else ok = false;
      }
      return ok;
    } catch (err) {
      this.logger.error(
        `syncFlight(${vueloId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Estado VISIBLE de la sincronización (C5, 12-sep-2026) para el panel: si
   * está prendida, a qué calendario apunta y cuándo corrió por última vez el
   * cron o el backfill. Todo en MEMORIA del proceso (null si aún no corre en
   * esta instancia): es diagnóstico, no un dato de negocio.
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
        desde,
        hasta,
        nota: NOTA_MANUALES,
      };
    }
    const resumen = await this.sincronizarVentana(desdeIso, hastaIso, 'resync');
    return {
      enabled: true,
      calendar_id: this.calendarId,
      ...resumen,
      desde,
      hasta,
      nota: NOTA_MANUALES,
    };
  }

  /**
   * Reconciliación nocturna (05:15 UTC ≈ 00:15 Cancún) de la VENTANA
   * operativa [hoy−7d, hoy+60d] contra Google: recoge mutaciones que no pasan
   * por un hook directo (p. ej. `refreshPermisosDeVuelo` cambia
   * `estado_permiso` sin re-sync) y repara eventos borrados a mano en
   * Calendar. Reusa la idempotencia de syncFlight/upsertRaw y va SECUENCIAL a
   * propósito para no saturar la API. Best-effort: nunca lanza.
   */
  @Cron('15 5 * * *', { name: 'calendar-reconcile-ventana' })
  async reconcileVentana(): Promise<void> {
    if (!this.enabled || !this.calendar) return;
    const ahora = Date.now();
    await this.sincronizarVentana(
      new Date(ahora - 7 * 86_400_000).toISOString(),
      new Date(ahora + 60 * 86_400_000).toISOString(),
      'reconcile',
    );
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
  ): Promise<ResumenSyncCalendar> {
    const desdeDia = this.diaCancun(desdeIso);
    const hastaDia = this.diaCancun(hastaIso);
    const r: ResumenSyncCalendar = {
      vuelos: 0,
      descansos: 0,
      eventos: 0,
      mantenimientos: 0,
      errores: 0,
    };
    try {
      // 1) Vuelos cuyo rango [fecha_vuelo, coalesce(fecha_fin, fecha_vuelo)]
      //    SOLAPA la ventana (viajes multi-día incluidos). SIN filtro de
      //    estado (12-sep-2026): los CANCELADOS también entran para que
      //    `syncFlight` BORRE sus eventos (C6) — si Google estaba caído
      //    cuando se canceló, su evento seguía vivo en el calendario de la
      //    oficina y nadie lo volvía a mirar. No se cuentan en `vuelos`
      //    (ahí solo va lo PUBLICADO); un borrado que falla sí cuenta error.
      const { data: vuelos, error: vErr } = await this.supabase.service
        .from('vuelo')
        .select('id, estado')
        .not('fecha_vuelo', 'is', null)
        .lte('fecha_vuelo', hastaIso)
        .or(
          `fecha_fin.gte.${desdeIso},and(fecha_fin.is.null,fecha_vuelo.gte.${desdeIso})`,
        );
      if (vErr) {
        r.errores++;
        this.logger.warn(`${origen}: vuelos no consultados (${vErr.message})`);
      }
      for (const v of (vuelos ?? []) as { id: string; estado?: string }[]) {
        if (!(await this.syncFlight(v.id))) r.errores++;
        else if (v.estado !== 'CANCELADO') r.vuelos++;
      }

      // 2) Descansos de piloto que tocan la ventana (columnas DATE en Cancún).
      const { data: descansos, error: dErr } = await this.supabase.service
        .from('piloto_descanso')
        .select(
          'id, fecha_inicio, fecha_fin, motivo, google_calendar_id, piloto:usuario!piloto_id(nombre)',
        )
        .lte('fecha_inicio', hastaDia)
        .gte('fecha_fin', desdeDia);
      if (dErr) {
        r.errores++;
        this.logger.warn(
          `${origen}: descansos no consultados (${dErr.message})`,
        );
      }
      for (const d of (descansos ?? []) as unknown as Array<{
        id: string;
        fecha_inicio: string;
        fecha_fin: string;
        motivo: string | null;
        google_calendar_id: string | null;
        piloto: { nombre: string } | { nombre: string }[] | null;
      }>) {
        const eventId = await this.upsertDescansoEvent({
          piloto_nombre: unwrap(d.piloto)?.nombre ?? 'Piloto',
          fecha_inicio: d.fecha_inicio,
          fecha_fin: d.fecha_fin,
          motivo: d.motivo,
          google_calendar_id: d.google_calendar_id,
        });
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
      const { data: eventos, error: eErr } = await this.supabase.service
        .from('evento_flota')
        .select(
          'id, titulo, fecha, fecha_fin, notas, google_calendar_id, aeronave:aeronave_id(matricula, color_calendario), responsable:usuario!responsable_id(nombre)',
        )
        .lte('fecha', hastaIso)
        .or(
          `fecha_fin.gte.${desdeIso},and(fecha_fin.is.null,fecha.gte.${desdeIso})`,
        );
      if (eErr) {
        r.errores++;
        this.logger.warn(
          `${origen}: eventos de flota no consultados (${eErr.message})`,
        );
      }
      for (const ev of (eventos ?? []) as unknown as Array<{
        id: string;
        titulo: string | null;
        fecha: string;
        fecha_fin: string | null;
        notas: string | null;
        google_calendar_id: string | null;
        aeronave: AeronaveRef | AeronaveRef[] | null;
        responsable: { nombre: string } | { nombre: string }[] | null;
      }>) {
        const eventId = await this.upsertEventoFlotaEvent({
          id: ev.id,
          titulo: ev.titulo ?? 'Evento',
          fecha: ev.fecha,
          fecha_fin: ev.fecha_fin,
          aeronave_matricula: unwrap(ev.aeronave)?.matricula ?? null,
          aeronave_color: unwrap(ev.aeronave)?.color_calendario ?? null,
          responsable_nombre: unwrap(ev.responsable)?.nombre ?? null,
          notas: ev.notas,
          google_calendar_id: ev.google_calendar_id,
        });
        if (eventId) r.eventos++;
        else r.errores++;
      }

      // 4) MANTENIMIENTOS con fecha en la ventana (12-sep-2026). Sin filtro de
      //    estado a propósito: `syncMantenimiento` BORRA el evento de lo que
      //    ya se completó (el calendario del sistema tampoco lo pinta).
      const { data: mants, error: mErr } = await this.supabase.service
        .from('mantenimiento')
        .select('id')
        .not('fecha_programada', 'is', null)
        .gte('fecha_programada', desdeDia)
        .lte('fecha_programada', hastaDia);
      if (mErr) {
        r.errores++;
        this.logger.warn(
          `${origen}: mantenimientos no consultados (${mErr.message})`,
        );
      }
      for (const m of (mants ?? []) as { id: string }[]) {
        if (await this.syncMantenimiento(m.id)) r.mantenimientos++;
        else r.errores++;
      }

      this.logger.log(
        `${origen} [${desdeDia} → ${hastaDia}]: ${r.vuelos} vuelos, ${r.descansos} descansos, ${r.eventos} eventos, ${r.mantenimientos} mantenimientos, ${r.errores} con error.`,
      );
    } catch (err) {
      r.errores++;
      this.logger.error(
        `${origen} falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const at = new Date().toISOString();
    this.ultimoResumen = { ...r, origen, desde: desdeDia, hasta: hastaDia, at };
    if (origen === 'resync') this.ultimoResyncAt = at;
    else this.ultimoReconcileAt = at;
    return r;
  }

  /**
   * Sincroniza un itinerario por tramos: un evento de Google por escala con
   * fecha. Limpia los eventos legacy a nivel de vuelo (ida/regreso) para no
   * duplicar el primer tramo. Devuelve `false` si algún borrado falló (el id
   * se conserva para reintentar).
   */
  private async syncLegs(
    vuelo: VueloRow,
    escalas: EscalaRow[],
  ): Promise<boolean> {
    let ok = true;
    // Limpia eventos legacy del modelo ida/regreso si existieran.
    if (vuelo.google_calendar_id) {
      if (await this.deleteEvent(vuelo.google_calendar_id))
        await this.saveEventId(vuelo.id, 'google_calendar_id', null);
      else ok = false;
    }
    if (vuelo.google_calendar_regreso_id) {
      if (await this.deleteEvent(vuelo.google_calendar_regreso_id))
        await this.saveEventId(vuelo.id, 'google_calendar_regreso_id', null);
      else ok = false;
    }

    for (let i = 0; i < escalas.length; i++) {
      const e = escalas[i];
      const fecha =
        e.fecha_salida_plan ??
        (i === 0
          ? vuelo.fecha_vuelo
          : i === escalas.length - 1
            ? vuelo.fecha_traslado_final
            : null);
      if (fecha) {
        // Un tramo que falla NO cancela los siguientes (Google puede fallar en
        // el 3.º de 5): se cuenta y el resto del itinerario sí se publica.
        try {
          const eventId = await this.upsertRaw(
            this.buildLegEvent(vuelo, e, fecha),
            e.google_calendar_id,
            `tramo ${e.orden}`,
          );
          if (eventId !== e.google_calendar_id)
            await this.saveLegEventId(e.id, eventId);
        } catch (err) {
          ok = false;
          this.logger.error(
            `Tramo ${e.orden} del vuelo ${vuelo.id} no se sincronizó: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } else if (e.google_calendar_id) {
        // El tramo perdió su fecha: quita su evento.
        if (await this.deleteEvent(e.google_calendar_id))
          await this.saveLegEventId(e.id, null);
        else ok = false;
      }
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
  async upsertDescansoEvent(d: {
    piloto_nombre: string;
    fecha_inicio: string; // YYYY-MM-DD
    fecha_fin: string; // YYYY-MM-DD (inclusivo)
    motivo?: string | null;
    google_calendar_id?: string | null;
  }): Promise<string | null> {
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
      this.logger.warn(
        `No se pudo sincronizar el descanso a Google Calendar: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Borra el evento de un descanso del calendario compartido. Best-effort. */
  async removeDescansoEvent(eventId: string | null | undefined): Promise<void> {
    if (eventId) await this.deleteEvent(eventId);
  }

  /**
   * Evento de día completo en el calendario compartido para un evento NO-vuelo
   * de la flota (lavado, trámite, visita…). Mismo patrón que los descansos,
   * con una diferencia: el id de Google lo persiste ESTE servicio en
   * `evento_flota.google_calendar_id` (contrato de la migración 20260829:
   * esa columna solo la escribe calendar-sync). Best-effort.
   */
  async upsertEventoFlotaEvent(ev: {
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
  }): Promise<string | null> {
    if (!this.enabled || !this.calendar) return ev.google_calendar_id ?? null;
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
        extendedProperties: { private: { vuelatour_evento_id: ev.id } },
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
  async syncMantenimiento(mantenimientoId: string): Promise<boolean> {
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
      extendedProperties: { private: { vuelatour_mantenimiento_id: m.id } },
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
      this.logger.error(
        `removeFlight(${vueloId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return ok;
  }

  private async loadVuelo(vueloId: string): Promise<VueloRow | null> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(VUELO_SELECT)
      .eq('id', vueloId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as unknown as VueloRow) ?? null;
  }

  private buildEvent(
    v: VueloRow,
    tramo: 'ida' | 'regreso',
  ): calendar_v3.Schema$Event {
    const esRegreso = tramo === 'regreso';
    // Asignación POR TRAMO: ida = escala orden 1, regreso = escala orden 2. Si el
    // tramo aún no tiene escala (vuelo viejo/externo), cae a la asignación del vuelo.
    const escala = (v.escalas ?? []).find(
      (e) => e.orden === (esRegreso ? 2 : 1),
    );
    const aeronave = unwrap(escala?.aeronave ?? v.aeronave);
    const piloto = unwrap(escala?.piloto ?? v.piloto);
    const cliente = unwrap(v.cliente);

    const aeronaveStr = v.es_externo
      ? (v.operador_externo ?? 'Externo')
      : (aeronave?.matricula ?? 'sin avión');

    const permisoPendiente = escala
      ? escala.estado_permiso === 'pendiente'
      : v.estado_permiso === 'pendiente';
    // En el regreso se invierte la ruta y se usa la fecha de traslado final.
    const origen = esRegreso ? v.destino_iata : v.origen_iata;
    const destino = esRegreso ? v.origen_iata : v.destino_iata;
    const prefijo = esRegreso ? '↩ Regreso · ' : '';

    // C3 (12-sep-2026): la oficina identifica el vuelo por el PILOTO, así que
    // su nombre corto va en el TÍTULO del evento, no solo en la descripción.
    const pilotoCorto = nombreCortoPiloto(piloto?.nombre, v.es_externo);
    const summary = `${prefijo}${aeronaveStr} · ${origen}-${destino} · ${pilotoCorto} · ${v.pasajeros} pax${permisoPendiente ? ' ⚠ permiso pendiente' : ''}`;

    const start = new Date(
      esRegreso ? v.fecha_traslado_final! : v.fecha_vuelo!,
    );
    // Bloque de 2 h por tramo (la ida ya no abarca hasta el regreso).
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const descriptionLines = [
      `Folio: #${v.folio}`,
      `Tramo: ${esRegreso ? 'Regreso' : 'Ida'}`,
      `Estado: ${v.estado}`,
      permisoPendiente ? 'Permiso de pista: PENDIENTE' : null,
      `Cliente: ${cliente?.nombre ?? '—'}`,
      `Ruta: ${origen} → ${destino}`,
      `Pasajeros: ${v.pasajeros}`,
      v.es_externo
        ? `Operador externo: ${v.operador_externo ?? '—'}`
        : `Aeronave: ${aeronave?.matricula ?? '—'}`,
      `Piloto: ${v.es_externo ? '(externo)' : (piloto?.nombre ?? 'sin asignar')}`,
      `Monto: $${Number(v.monto_total_usd)} USD`,
      v.notas ? `Notas: ${v.notas}` : null,
      '',
      `VuelaTour · vuelo ${v.id}`,
    ].filter(Boolean);

    // MISMO color que el calendario del sistema, traducido al más cercano de
    // Google (12-sep-2026): tentativo > sin asignar > permiso pendiente >
    // externo > color del avión. La precedencia no se repite aquí.
    const colorId = colorIdGoogleDeVuelo({
      estado: v.estado,
      esExterno: v.es_externo,
      aeronaveId: escala?.aeronave_id ?? v.aeronave_id,
      pilotoId: escala?.piloto_id ?? v.piloto_id,
      permisoPendiente,
      colorAvion: aeronave?.color_calendario,
    });

    return {
      summary,
      description: descriptionLines.join('\n'),
      colorId,
      start: { dateTime: start.toISOString(), timeZone: 'America/Cancun' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Cancun' },
      // Idempotency anchor — lets us recognize our own events.
      extendedProperties: {
        private: { vuelatour_vuelo_id: v.id, vuelatour_tramo: tramo },
      },
    };
  }

  /** Evento de Google para UN tramo de un itinerario personalizado. */
  private buildLegEvent(
    v: VueloRow,
    e: EscalaRow,
    fechaIso: string,
  ): calendar_v3.Schema$Event {
    const aeronave = unwrap(e.aeronave ?? v.aeronave);
    const piloto = unwrap(e.piloto ?? v.piloto);
    const cliente = unwrap(v.cliente);

    const aeronaveStr = v.es_externo
      ? (v.operador_externo ?? 'Externo')
      : (aeronave?.matricula ?? 'sin avión');
    const permisoPendiente = e.estado_permiso === 'pendiente';
    const pax = e.es_ferry ? 0 : (e.pasajeros ?? v.pasajeros);
    const prefijo = e.es_ferry ? `T${e.orden} Ferry · ` : `T${e.orden} · `;

    // C3: nombre corto del piloto DEL TRAMO en el título
    // («T1 · N4142R · CUN-PTU · Luis · 3 pax»).
    const pilotoCorto = nombreCortoPiloto(piloto?.nombre, v.es_externo);
    const summary = `${prefijo}${aeronaveStr} · ${e.origen_iata}-${e.destino_iata} · ${pilotoCorto} · ${pax} pax${permisoPendiente ? ' ⚠ permiso pendiente' : ''}`;

    const start = new Date(fechaIso);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const descriptionLines = [
      `Folio: #${v.folio}`,
      `Tramo: ${e.orden} de ${(v.escalas ?? []).length}${e.es_ferry ? ' (ferry, vacío)' : ''}`,
      `Estado: ${v.estado}`,
      permisoPendiente ? 'Permiso de pista: PENDIENTE' : null,
      `Cliente: ${cliente?.nombre ?? '—'}`,
      `Ruta: ${e.origen_iata} → ${e.destino_iata}`,
      `Pasajeros: ${pax}`,
      v.es_externo
        ? `Operador externo: ${v.operador_externo ?? '—'}`
        : `Aeronave: ${aeronave?.matricula ?? '—'}`,
      `Piloto: ${v.es_externo ? '(externo)' : (piloto?.nombre ?? 'sin asignar')}`,
      v.notas ? `Notas: ${v.notas}` : null,
      '',
      `VuelaTour · vuelo ${v.id}`,
    ].filter(Boolean);

    // Mismo criterio que `buildEvent`: el color del SISTEMA para este tramo
    // (con la asignación del tramo y su herencia del vuelo) → Google.
    const colorId = colorIdGoogleDeVuelo({
      estado: v.estado,
      esExterno: v.es_externo,
      aeronaveId: e.aeronave_id ?? v.aeronave_id,
      pilotoId: e.piloto_id ?? v.piloto_id,
      permisoPendiente,
      colorAvion: aeronave?.color_calendario,
    });

    return {
      summary,
      description: descriptionLines.join('\n'),
      colorId,
      start: { dateTime: start.toISOString(), timeZone: 'America/Cancun' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Cancun' },
      extendedProperties: {
        private: {
          vuelatour_vuelo_id: v.id,
          vuelatour_tramo: `leg-${e.orden}`,
        },
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
