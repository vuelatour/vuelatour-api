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
        'id, folio, fecha_vuelo, fecha_traslado_final, tipo, estado, es_externo, origen_iata, destino_iata, pasajeros, monto_total_usd, aeronave_id, piloto_id, cliente_id, operador_externo, estado_permiso, google_calendar_id, aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre), cliente:cliente_id(nombre), escalas:escala(orden, aeronave_id, piloto_id, estado_permiso, aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre))',
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
        escalas: Array<{
          id: string;
          orden: number;
          aeronave_id: string | null;
          piloto_id: string | null;
          estado_permiso: string | null;
          aeronave:
            | { matricula: string; color_calendario: string | null }
            | { matricula: string; color_calendario: string | null }[]
            | null;
          piloto: { nombre: string } | { nombre: string }[] | null;
        }> | null;
      };
      const cliente = unwrap(v.cliente);
      const escalaPorOrden = new Map((v.escalas ?? []).map((e) => [e.orden, e]));

      // Construye un evento usando la asignación del TRAMO (escala), con respaldo
      // en la asignación a nivel de vuelo cuando el tramo no exista todavía.
      const buildEvent = (params: {
        idSuffix: string;
        escalaOrden: number;
        fecha: string | null;
        tramo: 'ida' | 'regreso';
        origen: string;
        destino: string;
        prefijo?: string;
      }): Record<string, unknown> | null => {
        if (!inRange(params.fecha)) return null;
        const escala = escalaPorOrden.get(params.escalaOrden);
        const aeronaveId = escala?.aeronave_id ?? (escala ? null : v.aeronave_id);
        const pilotoId = escala?.piloto_id ?? (escala ? null : v.piloto_id);
        const aeronave = unwrap(escala?.aeronave ?? v.aeronave);
        const piloto = unwrap(escala?.piloto ?? v.piloto);
        const estadoPermiso = escala
          ? (escala.estado_permiso ?? null)
          : v.estado_permiso;

        const aeronaveStr = v.es_externo
          ? (v.operador_externo ?? 'Externo')
          : (aeronave?.matricula ?? 'sin avión');
        const permisoPendiente = estadoPermiso === 'pendiente';
        const sinAsignar =
          v.estado === 'CONFIRMADO' && !v.es_externo && (!aeronaveId || !pilotoId);
        const color = sinAsignar
          ? SIN_ASIGNAR_COLOR
          : permisoPendiente
            ? PERMISO_PENDIENTE_COLOR
            : v.es_externo
              ? EXTERNAL_COLOR
              : (aeronave?.color_calendario ?? '#9CA3AF');
        const hora = horaOf(params.fecha);
        return {
          id: `${v.id}${params.idSuffix}`,
          vuelo_id: v.id,
          escala_id: escala?.id ?? null,
          folio: v.folio,
          estado: v.estado,
          estado_permiso: estadoPermiso,
          es_externo: v.es_externo,
          sin_asignar: sinAsignar,
          color,
          cliente_id: v.cliente_id,
          cliente_nombre: cliente?.nombre ?? null,
          aeronave_id: aeronaveId,
          aeronave_matricula: aeronave?.matricula ?? null,
          operador_externo: v.operador_externo,
          piloto_id: pilotoId,
          piloto_nombre: piloto?.nombre ?? null,
          pasajeros: v.pasajeros,
          monto_total_usd: Number(v.monto_total_usd),
          google_calendar_id: v.google_calendar_id,
          fecha_vuelo: params.fecha,
          hora,
          tramo: params.tramo,
          origen_iata: params.origen,
          destino_iata: params.destino,
          title: `${params.prefijo ?? ''}${hora ? `${hora} · ` : ''}${aeronaveStr} ${params.origen}-${params.destino} (${v.pasajeros} pax)${sinAsignar ? ' ⚠ sin asignar' : permisoPendiente ? ' ⚠ permiso' : ''}`,
        };
      };

      const out: Array<Record<string, unknown>> = [];
      // IDA (orden 1, en fecha_vuelo).
      const ida = buildEvent({
        idSuffix: '',
        escalaOrden: 1,
        fecha: v.fecha_vuelo,
        tramo: 'ida',
        origen: v.origen_iata,
        destino: v.destino_iata,
      });
      if (ida) out.push(ida);
      // REGRESO de vuelo redondo (orden 2, en fecha_traslado_final, IATAs invertidos).
      if (v.tipo === 'REDONDO') {
        const regreso = buildEvent({
          idSuffix: ':regreso',
          escalaOrden: 2,
          fecha: v.fecha_traslado_final,
          tramo: 'regreso',
          origen: v.destino_iata,
          destino: v.origen_iata,
          prefijo: '↩ Regreso · ',
        });
        if (regreso) out.push(regreso);
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
