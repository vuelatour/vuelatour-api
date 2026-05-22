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
  'id, folio, estado, es_externo, operador_externo, origen_iata, destino_iata, pasajeros, monto_total_usd, fecha_vuelo, fecha_traslado_final, notas, estado_permiso, google_calendar_id, ' +
  'aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre), cliente:cliente_id(nombre)';

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
  notas: string | null;
  estado_permiso: string | null;
  google_calendar_id: string | null;
  aeronave: { matricula: string } | { matricula: string }[] | null;
  piloto: { nombre: string } | { nombre: string }[] | null;
  cliente: { nombre: string } | { nombre: string }[] | null;
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
      // Without a date there is nothing meaningful to place on a calendar.
      if (!vuelo.fecha_vuelo) return;

      const event = this.buildEvent(vuelo);

      if (vuelo.google_calendar_id) {
        try {
          await this.calendar.events.update({
            calendarId: this.calendarId,
            eventId: vuelo.google_calendar_id,
            requestBody: event,
          });
          return;
        } catch (err) {
          // Event was deleted on the calendar side — fall through to recreate.
          this.logger.warn(
            `Update failed for event ${vuelo.google_calendar_id}, recreating: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      const created = await this.calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: event,
      });
      const eventId = created.data.id;
      if (eventId) await this.saveEventId(vueloId, eventId);
    } catch (err) {
      this.logger.error(
        `syncFlight(${vueloId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Delete the Calendar event for a flight and clear google_calendar_id. */
  async removeFlight(vueloId: string): Promise<void> {
    if (!this.enabled || !this.calendar) return;
    try {
      const { data } = await this.supabase.service
        .from('vuelo')
        .select('google_calendar_id')
        .eq('id', vueloId)
        .maybeSingle();
      const eventId = (data as { google_calendar_id: string | null } | null)?.google_calendar_id;
      if (!eventId) return;

      try {
        await this.calendar.events.delete({
          calendarId: this.calendarId,
          eventId,
        });
      } catch (err) {
        this.logger.warn(
          `Delete failed for event ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await this.saveEventId(vueloId, null);
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

  private buildEvent(v: VueloRow): calendar_v3.Schema$Event {
    const aeronave = unwrap(v.aeronave);
    const piloto = unwrap(v.piloto);
    const cliente = unwrap(v.cliente);

    const aeronaveStr = v.es_externo
      ? (v.operador_externo ?? 'Externo')
      : (aeronave?.matricula ?? 'sin avión');

    const permisoPendiente = v.estado_permiso === 'pendiente';

    const summary = `${aeronaveStr} · ${v.origen_iata}-${v.destino_iata} (${v.pasajeros} pax)${permisoPendiente ? ' ⚠ permiso pendiente' : ''}`;

    const start = new Date(v.fecha_vuelo!);
    // Si hay fecha de traslado final usamos esa como fin; si no, bloque de 2h.
    const end = v.fecha_traslado_final
      ? new Date(v.fecha_traslado_final)
      : new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const descriptionLines = [
      `Folio: #${v.folio}`,
      `Estado: ${v.estado}`,
      permisoPendiente ? 'Permiso de pista: PENDIENTE' : null,
      `Cliente: ${cliente?.nombre ?? '—'}`,
      `Ruta: ${v.origen_iata} → ${v.destino_iata}`,
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
        private: { vuelatour_vuelo_id: v.id },
      },
    };
  }

  private async saveEventId(vueloId: string, eventId: string | null): Promise<void> {
    const { error } = await this.supabase.service
      .from('vuelo')
      .update({ google_calendar_id: eventId })
      .eq('id', vueloId);
    if (error) {
      this.logger.error(`Failed to persist google_calendar_id for ${vueloId}: ${error.message}`);
    }
  }
}
