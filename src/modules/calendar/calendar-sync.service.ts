import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { calendar_v3, google } from 'googleapis';
import { JWT } from 'google-auth-library';
import type { EnvVars } from '../../config/env.schema';
import { SupabaseService } from '../supabase/supabase.service';

const EXTERNAL_COLOR_ID = '4'; // Flamingo (pinkish) — externos
const DEFAULT_COLOR_ID = '9'; // Blueberry — vuelos propios
const PERMISO_PENDIENTE_COLOR_ID = '6'; // Tangerine — permiso de pista pendiente

const VUELO_SELECT =
  'id, folio, estado, es_externo, operador_externo, origen_iata, destino_iata, pasajeros, monto_total_usd, fecha_vuelo, fecha_traslado_final, tipo, notas, estado_permiso, google_calendar_id, google_calendar_regreso_id, ' +
  'aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre), cliente:cliente_id(nombre), ' +
  'escalas:escala(id, orden, origen_iata, destino_iata, fecha_salida_plan, es_ferry, pasajeros, google_calendar_id, aeronave_id, piloto_id, estado_permiso, aeronave:aeronave_id(matricula), piloto:piloto_id(nombre))';

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
  google_calendar_id: string | null;
  google_calendar_regreso_id: string | null;
  aeronave: { matricula: string } | { matricula: string }[] | null;
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
    aeronave: { matricula: string } | { matricula: string }[] | null;
    piloto: { nombre: string } | { nombre: string }[] | null;
  }> | null;
}

type EscalaRow = NonNullable<VueloRow['escalas']>[number];

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

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
  ) {}

  onModuleInit() {
    this.enabled = this.config.get('GOOGLE_CALENDAR_SYNC_ENABLED', { infer: true });
    this.calendarId = this.config.get('GOOGLE_CALENDAR_ID', { infer: true });
    const rawJson = this.config.get('GOOGLE_SERVICE_ACCOUNT_JSON', { infer: true });

    if (!this.enabled) {
      this.logger.log('Google Calendar sync disabled (GOOGLE_CALENDAR_SYNC_ENABLED=false)');
      return;
    }
    if (!rawJson || !this.calendarId) {
      this.logger.warn(
        'Calendar sync enabled but GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CALENDAR_ID missing — sync inactive',
      );
      this.enabled = false;
      return;
    }

    try {
      const creds = JSON.parse(rawJson) as { client_email: string; private_key: string };
      const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/calendar.events'],
      });
      this.calendar = google.calendar({ version: 'v3', auth });
      this.logger.log(`Google Calendar sync active (calendar: ${this.calendarId})`);
    } catch (err) {
      this.enabled = false;
      this.logger.error(
        `Failed to init Google Calendar client: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Create or update the Calendar event for a flight. Stores the event id back
   * on vuelo.google_calendar_id. No-op when sync is disabled.
   */
  async syncFlight(vueloId: string): Promise<void> {
    if (!this.enabled || !this.calendar) return;
    try {
      const vuelo = await this.loadVuelo(vueloId);
      if (!vuelo) return;

      // Cancelled flights are removed from the calendar instead of upserted.
      if (vuelo.estado === 'CANCELADO') {
        await this.removeFlight(vueloId);
        return;
      }

      // Itinerario personalizado (MULTIESCALA con escalas): un evento por tramo,
      // guardado en escala.google_calendar_id. El 1er tramo hereda fecha_vuelo y
      // el último fecha_traslado_final si no tienen fecha propia.
      const escalas = [...(vuelo.escalas ?? [])].sort((a, b) => a.orden - b.orden);
      if (vuelo.tipo === 'MULTIESCALA' && escalas.length > 0) {
        await this.syncLegs(vuelo, escalas);
        return;
      }

      // Without a date there is nothing meaningful to place on a calendar.
      if (!vuelo.fecha_vuelo) return;

      // IDA (en fecha_vuelo).
      const idaId = await this.upsertRaw(
        this.buildEvent(vuelo, 'ida'),
        vuelo.google_calendar_id,
        'ida',
      );
      await this.saveEventId(vueloId, 'google_calendar_id', idaId);

      // REGRESO de redondo (en fecha_traslado_final): segundo evento.
      const esRedondo = vuelo.tipo === 'REDONDO' && !!vuelo.fecha_traslado_final;
      if (esRedondo) {
        const regId = await this.upsertRaw(
          this.buildEvent(vuelo, 'regreso'),
          vuelo.google_calendar_regreso_id,
          'regreso',
        );
        await this.saveEventId(vueloId, 'google_calendar_regreso_id', regId);
      } else if (vuelo.google_calendar_regreso_id) {
        // Dejó de ser redondo (o se quitó el regreso): borra el evento de regreso.
        await this.deleteEvent(vuelo.google_calendar_regreso_id);
        await this.saveEventId(vueloId, 'google_calendar_regreso_id', null);
      }
    } catch (err) {
      this.logger.error(
        `syncFlight(${vueloId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Re-sincroniza todos los vuelos no cancelados con fecha (redondos legacy y
   * multiescala por tramos). Secuencial para no saturar la API de Calendar.
   * Devuelve cuántos se procesaron.
   */
  async resyncRedondos(): Promise<{ enabled: boolean; total: number }> {
    if (!this.enabled || !this.calendar) return { enabled: false, total: 0 };
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('id')
      .neq('estado', 'CANCELADO')
      .not('fecha_vuelo', 'is', null);
    if (error) throw new Error(error.message);
    const ids = (data ?? []).map((r) => (r as { id: string }).id);
    for (const id of ids) {
      await this.syncFlight(id);
    }
    this.logger.log(`resync: ${ids.length} vuelos re-sincronizados con Google.`);
    return { enabled: true, total: ids.length };
  }

  /**
   * Sincroniza un itinerario por tramos: un evento de Google por escala con
   * fecha. Limpia los eventos legacy a nivel de vuelo (ida/regreso) para no
   * duplicar el primer tramo.
   */
  private async syncLegs(vuelo: VueloRow, escalas: EscalaRow[]): Promise<void> {
    // Limpia eventos legacy del modelo ida/regreso si existieran.
    if (vuelo.google_calendar_id) {
      await this.deleteEvent(vuelo.google_calendar_id);
      await this.saveEventId(vuelo.id, 'google_calendar_id', null);
    }
    if (vuelo.google_calendar_regreso_id) {
      await this.deleteEvent(vuelo.google_calendar_regreso_id);
      await this.saveEventId(vuelo.id, 'google_calendar_regreso_id', null);
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
        const eventId = await this.upsertRaw(
          this.buildLegEvent(vuelo, e, fecha),
          e.google_calendar_id,
          `tramo ${e.orden}`,
        );
        await this.saveLegEventId(e.id, eventId);
      } else if (e.google_calendar_id) {
        // El tramo perdió su fecha: quita su evento.
        await this.deleteEvent(e.google_calendar_id);
        await this.saveLegEventId(e.id, null);
      }
    }
  }

  /** Crea o actualiza un evento ya construido y devuelve su id. */
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

  private async deleteEvent(eventId: string): Promise<void> {
    if (!this.calendar) return;
    try {
      await this.calendar.events.delete({ calendarId: this.calendarId, eventId });
    } catch (err) {
      this.logger.warn(
        `Delete failed for event ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Delete both Calendar events (ida + regreso) for a flight and clear their ids. */
  async removeFlight(vueloId: string): Promise<void> {
    if (!this.enabled || !this.calendar) return;
    try {
      const { data } = await this.supabase.service
        .from('vuelo')
        .select('google_calendar_id, google_calendar_regreso_id')
        .eq('id', vueloId)
        .maybeSingle();
      const row = data as {
        google_calendar_id: string | null;
        google_calendar_regreso_id: string | null;
      } | null;
      if (row?.google_calendar_id) {
        await this.deleteEvent(row.google_calendar_id);
        await this.saveEventId(vueloId, 'google_calendar_id', null);
      }
      if (row?.google_calendar_regreso_id) {
        await this.deleteEvent(row.google_calendar_regreso_id);
        await this.saveEventId(vueloId, 'google_calendar_regreso_id', null);
      }
      // Eventos por tramo (itinerarios personalizados).
      const { data: legs } = await this.supabase.service
        .from('escala')
        .select('id, google_calendar_id')
        .eq('vuelo_id', vueloId)
        .not('google_calendar_id', 'is', null);
      for (const leg of (legs ?? []) as { id: string; google_calendar_id: string }[]) {
        await this.deleteEvent(leg.google_calendar_id);
        await this.saveLegEventId(leg.id, null);
      }
    } catch (err) {
      this.logger.error(
        `removeFlight(${vueloId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

  private buildEvent(v: VueloRow, tramo: 'ida' | 'regreso'): calendar_v3.Schema$Event {
    const esRegreso = tramo === 'regreso';
    // Asignación POR TRAMO: ida = escala orden 1, regreso = escala orden 2. Si el
    // tramo aún no tiene escala (vuelo viejo/externo), cae a la asignación del vuelo.
    const escala = (v.escalas ?? []).find((e) => e.orden === (esRegreso ? 2 : 1));
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

    const summary = `${prefijo}${aeronaveStr} · ${origen}-${destino} (${v.pasajeros} pax)${permisoPendiente ? ' ⚠ permiso pendiente' : ''}`;

    const start = new Date(esRegreso ? v.fecha_traslado_final! : v.fecha_vuelo!);
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

    // Permiso pendiente domina el color (alerta) hasta que se emita.
    const colorId = permisoPendiente
      ? PERMISO_PENDIENTE_COLOR_ID
      : v.es_externo
        ? EXTERNAL_COLOR_ID
        : DEFAULT_COLOR_ID;

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

    const summary = `${prefijo}${aeronaveStr} · ${e.origen_iata}-${e.destino_iata} (${pax} pax)${permisoPendiente ? ' ⚠ permiso pendiente' : ''}`;

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

    const colorId = permisoPendiente
      ? PERMISO_PENDIENTE_COLOR_ID
      : v.es_externo
        ? EXTERNAL_COLOR_ID
        : DEFAULT_COLOR_ID;

    return {
      summary,
      description: descriptionLines.join('\n'),
      colorId,
      start: { dateTime: start.toISOString(), timeZone: 'America/Cancun' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Cancun' },
      extendedProperties: {
        private: { vuelatour_vuelo_id: v.id, vuelatour_tramo: `leg-${e.orden}` },
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
      this.logger.error(`Failed to persist ${column} for ${vueloId}: ${error.message}`);
    }
  }

  private async saveLegEventId(escalaId: string, eventId: string | null): Promise<void> {
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
}
