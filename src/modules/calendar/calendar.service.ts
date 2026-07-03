import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { CalendarRangeQuery } from './dto/calendar.dto';

const EXTERNAL_COLOR = '#FFB6C1';
// Color de alerta para vuelos con permiso de pista pendiente. Configurable.
const PERMISO_PENDIENTE_COLOR = '#F59E0B';
// Vuelo propio confirmado pero todavía SIN avión asignado (acción pendiente).
const SIN_ASIGNAR_COLOR = '#8B5CF6';
// Reserva tentativa: espacio apartado sin cotización ("espérame y te confirmo").
const TENTATIVO_COLOR = '#64748B';

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
        'id, folio, fecha_vuelo, fecha_traslado_final, tipo, estado, es_externo, origen_iata, destino_iata, pasajeros, monto_total_usd, aeronave_id, piloto_id, cliente_id, operador_externo, estado_permiso, google_calendar_id, aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre), cliente:cliente_id(nombre), escalas:escala(id, orden, origen_iata, destino_iata, fecha_salida_plan, es_ferry, pasajeros, aeronave_id, piloto_id, estado_permiso, aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre))',
      )
      // Trae vuelos cuya salida o regreso caiga en el rango, o que lo abarquen
      // completo (los tramos intermedios de un multiescala viven entre ambas fechas).
      .or(
        `and(fecha_vuelo.gte.${from.toISOString()},fecha_vuelo.lte.${to.toISOString()}),` +
          `and(fecha_traslado_final.gte.${from.toISOString()},fecha_traslado_final.lte.${to.toISOString()}),` +
          `and(fecha_vuelo.lte.${from.toISOString()},fecha_traslado_final.gte.${to.toISOString()})`,
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
          origen_iata: string;
          destino_iata: string;
          fecha_salida_plan: string | null;
          es_ferry: boolean;
          pasajeros: number | null;
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
        tramo?: 'ida' | 'regreso';
        origen: string;
        destino: string;
        prefijo?: string;
        pasajeros?: number;
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
        const esTentativo = v.estado === 'RESERVA';
        // El tentativo domina el color: es un espacio apartado, no un vuelo firme.
        const color = esTentativo
          ? TENTATIVO_COLOR
          : sinAsignar
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
          pasajeros: params.pasajeros ?? v.pasajeros,
          monto_total_usd: Number(v.monto_total_usd),
          google_calendar_id: v.google_calendar_id,
          fecha_vuelo: params.fecha,
          hora,
          tramo: params.tramo,
          origen_iata: params.origen,
          destino_iata: params.destino,
          title: `${esTentativo ? 'Tentativo · ' : ''}${params.prefijo ?? ''}${hora ? `${hora} · ` : ''}${aeronaveStr} ${params.origen}-${params.destino} (${params.pasajeros ?? v.pasajeros} pax)${sinAsignar ? ' ⚠ sin asignar' : permisoPendiente ? ' ⚠ permiso' : ''}`,
        };
      };

      const out: Array<Record<string, unknown>> = [];
      const escalasOrdenadas = [...(v.escalas ?? [])].sort(
        (a, b) => a.orden - b.orden,
      );

      if (v.tipo === 'MULTIESCALA' && escalasOrdenadas.length > 0) {
        // Itinerario personalizado: un evento por tramo con fecha. El 1er tramo
        // hereda fecha_vuelo y el último fecha_traslado_final si no tienen fecha
        // propia (compat con escalas creadas antes de fecha_salida_plan).
        escalasOrdenadas.forEach((e, i) => {
          const fecha =
            e.fecha_salida_plan ??
            (i === 0
              ? v.fecha_vuelo
              : i === escalasOrdenadas.length - 1
                ? v.fecha_traslado_final
                : null);
          const ev = buildEvent({
            idSuffix: i === 0 ? '' : `:leg:${e.orden}`,
            escalaOrden: e.orden,
            fecha,
            origen: e.origen_iata,
            destino: e.destino_iata,
            prefijo: e.es_ferry ? `T${e.orden} Ferry · ` : `T${e.orden} · `,
            pasajeros: e.es_ferry ? 0 : (e.pasajeros ?? undefined),
          });
          if (ev) out.push(ev);
        });
        return out;
      }

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

    // Descansos de pilotos en el rango: un evento por día de descanso, para
    // que se pinten en el calendario junto a los vuelos (pedido del cliente).
    const DESCANSO_COLOR = '#14B8A6';
    const fromDay = from.toISOString().slice(0, 10);
    const toDay = to.toISOString().slice(0, 10);
    let dq = this.supabase.service
      .from('piloto_descanso')
      .select('id, piloto_id, fecha_inicio, fecha_fin, motivo, piloto:usuario!piloto_id(nombre)')
      .lte('fecha_inicio', toDay)
      .gte('fecha_fin', fromDay);
    if (q.piloto_id) dq = dq.eq('piloto_id', q.piloto_id);
    const { data: descansos } = q.solo_externos ? { data: [] } : await dq;
    for (const d of descansos ?? []) {
      const piloto = Array.isArray(d.piloto) ? d.piloto[0] : d.piloto;
      const nombre = (piloto as { nombre?: string } | null)?.nombre ?? 'Piloto';
      const ini = new Date(`${d.fecha_inicio as string}T12:00:00Z`);
      const fin = new Date(`${d.fecha_fin as string}T12:00:00Z`);
      for (let t = ini.getTime(); t <= fin.getTime(); t += 86_400_000) {
        const day = new Date(t).toISOString().slice(0, 10);
        if (day < fromDay || day > toDay) continue;
        events.push({
          id: `descanso:${d.id as string}:${day}`,
          tipo_evento: 'descanso',
          descanso_id: d.id,
          vuelo_id: null,
          escala_id: null,
          folio: null,
          fecha_vuelo: `${day}T12:00:00Z`,
          hora: null,
          estado: 'DESCANSO',
          estado_permiso: null,
          es_externo: false,
          title: `Descansa · ${nombre}${d.motivo ? ` (${d.motivo as string})` : ''}`,
          color: DESCANSO_COLOR,
          piloto_id: d.piloto_id,
          piloto_nombre: nombre,
        } as unknown as (typeof events)[number]);
      }
    }
    events.sort((a, b) =>
      String((a as { fecha_vuelo?: string }).fecha_vuelo ?? '').localeCompare(
        String((b as { fecha_vuelo?: string }).fecha_vuelo ?? ''),
      ),
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      count: events.length,
      events,
    };
  }
}
