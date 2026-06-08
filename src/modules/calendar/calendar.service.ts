import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { CalendarRangeQuery } from './dto/calendar.dto';

const EXTERNAL_COLOR = '#FFB6C1';
// Color de alerta para vuelos con permiso de pista pendiente. Configurable.
const PERMISO_PENDIENTE_COLOR = '#F59E0B';
// Vuelo propio confirmado pero todavía SIN avión asignado (acción pendiente).
const SIN_ASIGNAR_COLOR = '#8B5CF6';

function unwrap<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return value;
}

@Injectable()
export class CalendarService {
  constructor(private readonly supabase: SupabaseService) {}

  async listEvents(q: CalendarRangeQuery) {
    const now = new Date();
    const from = q.from ?? now;
    const to =
      q.to ??
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 30,
        23,
        59,
        59,
      );

    let query = this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, fecha_vuelo, fecha_traslado_final, tipo, estado, es_externo, origen_iata, destino_iata, pasajeros, monto_total_usd, aeronave_id, piloto_id, cliente_id, operador_externo, estado_permiso, google_calendar_id, aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre), cliente:cliente_id(nombre)',
      )
      // Trae vuelos cuya IDA o cuyo REGRESO caiga en el rango (los redondos
      // pintan dos eventos: salida en fecha_vuelo y regreso en fecha_traslado_final).
      .or(
        `and(fecha_vuelo.gte.${from.toISOString()},fecha_vuelo.lte.${to.toISOString()}),` +
          `and(fecha_traslado_final.gte.${from.toISOString()},fecha_traslado_final.lte.${to.toISOString()})`,
      )
      .order('fecha_vuelo', { ascending: true });

    if (!q.incluir_cancelados) {
      query = query.neq('estado', 'CANCELADO');
    }
    if (q.aeronave_id) query = query.eq('aeronave_id', q.aeronave_id);
    if (q.piloto_id) query = query.eq('piloto_id', q.piloto_id);
    if (q.solo_externos) query = query.eq('es_externo', true);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const inRange = (iso: string | null): boolean => {
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return !Number.isNaN(t) && t >= fromMs && t <= toMs;
    };
    const horaOf = (iso: string | null): string | null =>
      iso
        ? new Date(iso).toLocaleTimeString('es-MX', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Cancun',
          })
        : null;

    const events = (data ?? []).flatMap((row) => {
      const v = row as unknown as {
        id: string;
        folio: number;
        fecha_vuelo: string | null;
        fecha_traslado_final: string | null;
        tipo: string | null;
        estado: string;
        es_externo: boolean;
        origen_iata: string;
        destino_iata: string;
        pasajeros: number;
        monto_total_usd: string;
        aeronave_id: string | null;
        piloto_id: string | null;
        cliente_id: string;
        operador_externo: string | null;
        estado_permiso: string | null;
        google_calendar_id: string | null;
        aeronave:
          | { matricula: string; color_calendario: string | null }
          | { matricula: string; color_calendario: string | null }[]
          | null;
        piloto: { nombre: string } | { nombre: string }[] | null;
        cliente: { nombre: string } | { nombre: string }[] | null;
      };
      const aeronave = unwrap(v.aeronave);
      const piloto = unwrap(v.piloto);
      const cliente = unwrap(v.cliente);

      const aeronaveStr = v.es_externo
        ? (v.operador_externo ?? 'Externo')
        : (aeronave?.matricula ?? 'sin avión');
      const permisoPendiente = v.estado_permiso === 'pendiente';
      // Vuelo propio confirmado pero aún no asignado del todo (le falta avión o piloto).
      const sinAsignar =
        v.estado === 'CONFIRMADO' &&
        !v.es_externo &&
        (!v.aeronave_id || !v.piloto_id);
      // Prioridad de color: sin asignar (acción) > permiso pendiente (alerta) >
      // externo > color de la aeronave.
      const color = sinAsignar
        ? SIN_ASIGNAR_COLOR
        : permisoPendiente
          ? PERMISO_PENDIENTE_COLOR
          : v.es_externo
            ? EXTERNAL_COLOR
            : (aeronave?.color_calendario ?? '#9CA3AF');

      const base = {
        folio: v.folio,
        estado: v.estado,
        estado_permiso: v.estado_permiso,
        es_externo: v.es_externo,
        sin_asignar: sinAsignar,
        color,
        cliente_id: v.cliente_id,
        cliente_nombre: cliente?.nombre ?? null,
        aeronave_id: v.aeronave_id,
        aeronave_matricula: aeronave?.matricula ?? null,
        operador_externo: v.operador_externo,
        piloto_id: v.piloto_id,
        piloto_nombre: piloto?.nombre ?? null,
        pasajeros: v.pasajeros,
        monto_total_usd: Number(v.monto_total_usd),
        google_calendar_id: v.google_calendar_id,
      };

      const out: Array<Record<string, unknown>> = [];

      // IDA (en fecha_vuelo).
      if (inRange(v.fecha_vuelo)) {
        const hora = horaOf(v.fecha_vuelo);
        out.push({
          id: v.id,
          ...base,
          fecha_vuelo: v.fecha_vuelo,
          hora,
          tramo: 'ida',
          origen_iata: v.origen_iata,
          destino_iata: v.destino_iata,
          title: `${hora ? `${hora} · ` : ''}${aeronaveStr} ${v.origen_iata}-${v.destino_iata} (${v.pasajeros} pax)${sinAsignar ? ' ⚠ sin asignar' : permisoPendiente ? ' ⚠ permiso' : ''}`,
        });
      }

      // REGRESO de vuelo redondo (en fecha_traslado_final, origen/destino invertidos).
      if (v.tipo === 'REDONDO' && inRange(v.fecha_traslado_final)) {
        const hora = horaOf(v.fecha_traslado_final);
        out.push({
          id: `${v.id}:regreso`,
          ...base,
          fecha_vuelo: v.fecha_traslado_final,
          hora,
          tramo: 'regreso',
          origen_iata: v.destino_iata,
          destino_iata: v.origen_iata,
          title: `↩ Regreso · ${hora ? `${hora} · ` : ''}${aeronaveStr} ${v.destino_iata}-${v.origen_iata} (${v.pasajeros} pax)`,
        });
      }

      return out;
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      count: events.length,
      events,
    };
  }
}
