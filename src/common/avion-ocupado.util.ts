import type { SupabaseClient } from '@supabase/supabase-js';
import { diaCancun } from './fecha-cancun.util';

/**
 * Doble reserva del AVIÓN (4-sep-2026, base de la cotización de grupo):
 * "¿este avión ya tiene otro vuelo vivo que solape estas fechas?". Hasta hoy
 * solo se vigilaba al PILOTO (`pilotosDisponibilidad`); el mismo avión
 * podía venderse dos veces a la misma hora sin aviso.
 *
 * Es un AVISO, nunca un candado: la doble rotación de un grupo es UN solo
 * vuelo (hijo con 6 tramos), y la oficina puede encadenar vuelos cortos del
 * mismo avión el mismo día a propósito. Eje de solapamiento: días CANCÚN
 * de [fecha_vuelo, fecha_fin] (mismo eje que el calendario y que
 * `pilotosDisponibilidad`). El avión de cada tramo se resuelve CON HERENCIA
 * (`escala.aeronave_id ?? vuelo.aeronave_id`).
 */

export interface VueloOcupacionRow {
  id: string;
  folio: number | null;
  estado?: string | null;
  aeronave_id: string | null;
  fecha_vuelo: string | null;
  escalas?: Array<{
    aeronave_id: string | null;
    cancelada_at: string | null;
  }> | null;
}

/**
 * Filtro PURO: vuelos (ya leídos en la ventana) donde el avión vuela de
 * verdad — a nivel vuelo con al menos un tramo vivo que lo herede (o sin
 * tramos), o explícito en un tramo vivo. Excluye cancelados y `excluir`.
 */
export function vuelosQueOcupanAvion<T extends VueloOcupacionRow>(
  rows: T[],
  aeronaveId: string,
  excluirVueloId?: string | null,
): T[] {
  return rows.filter((v) => {
    if (excluirVueloId && v.id === excluirVueloId) return false;
    if (v.estado === 'CANCELADO') return false;
    const vivas = (v.escalas ?? []).filter((e) => e.cancelada_at == null);
    if (vivas.length === 0) return v.aeronave_id === aeronaveId;
    return vivas.some(
      (e) => (e.aeronave_id ?? v.aeronave_id ?? null) === aeronaveId,
    );
  });
}

/** Rango de días Cancún [desde, hasta] (hasta ≥ desde). */
export function rangoDiasCancun(
  fechaVuelo: string | Date,
  fechaFin?: string | Date | null,
): { desde: string; hasta: string } {
  const iso = (d: string | Date) => (d instanceof Date ? d.toISOString() : d);
  const desde = diaCancun(iso(fechaVuelo));
  const finDia = fechaFin ? diaCancun(iso(fechaFin)) : desde;
  return { desde, hasta: finDia > desde ? finDia : desde };
}

/**
 * Vuelos vivos que ya ocupan el avión en la ventana (días Cancún). Ordenados
 * por fecha. Best-effort: un error de lectura devuelve [] (jamás tumba la
 * asignación que lo consulta).
 */
export async function avionOcupadoEnFecha(
  sb: SupabaseClient,
  p: {
    aeronaveId: string;
    fechaVuelo: string | Date | null | undefined;
    fechaFin?: string | Date | null;
    excluirVueloId?: string | null;
  },
): Promise<VueloOcupacionRow[]> {
  if (!p.aeronaveId || !p.fechaVuelo) return [];
  try {
    const { desde, hasta } = rangoDiasCancun(p.fechaVuelo, p.fechaFin);
    const { data, error } = await sb
      .from('vuelo')
      .select(
        'id, folio, estado, aeronave_id, fecha_vuelo, escalas:escala(aeronave_id, cancelada_at)',
      )
      .neq('estado', 'CANCELADO')
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`)
      .gte('fecha_fin', `${desde}T00:00:00-05:00`)
      .order('fecha_vuelo', { ascending: true });
    if (error) return [];
    return vuelosQueOcupanAvion(
      (data ?? []) as unknown as VueloOcupacionRow[],
      p.aeronaveId,
      p.excluirVueloId,
    );
  } catch {
    return [];
  }
}

/** Texto del aviso ("El avión XB-ANU ya tiene otro vuelo: #123 (4 sep)"). */
export function avisoAvionOcupado(
  matricula: string | null | undefined,
  ocupados: VueloOcupacionRow[],
): string | null {
  if (ocupados.length === 0) return null;
  const folios = ocupados
    .map((v) => {
      const dia = v.fecha_vuelo
        ? new Date(v.fecha_vuelo).toLocaleDateString('es-MX', {
            day: 'numeric',
            month: 'short',
            timeZone: 'America/Cancun',
          })
        : null;
      return `#${v.folio ?? '?'}${dia ? ` (${dia})` : ''}`;
    })
    .join(', ');
  return `Doble reserva: ${matricula ?? 'el avión'} ya tiene otro vuelo vivo en esas fechas: ${folios}. Verifica que no se traslapen.`;
}
