/**
 * LECTOR ÚNICO DE LA TARIFA DE LA RESERVA DE OVERHAUL (10-nov-2026, API
 * 0.0.135, invariante 130).
 *
 * Con la migración `20261110000001` la tarifa vive en
 * `reserva_overhaul_vigencia` (historial con «a partir de»); sin ella, en la
 * tabla legada `reserva_overhaul` (una fila por motor, «desde siempre»). El
 * reparto, el balance por avión y el general leen SIEMPRE por aquí: jamás
 * una de las dos tablas a mano.
 *
 * Sonda con el patrón `columnaOpcional` (re-sondeo ≤ 10 min: se enciende
 * sola al aplicar la migración, sin redeploy). Con la tabla nueva presente
 * Y CON FILAS, ella es la única fuente: un avión sin vigencias no tiene
 * reserva (aunque conserve filas en la legada). Tabla ausente **o vacía**
 * (migración sin su backfill) ⇒ la legada, como siempre. Que la tabla no
 * pueda quedar vacía «a mano» lo garantiza el API: la ÚNICA tarifa de un
 * avión no se elimina (para dejarlo sin reserva se captura en $0).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional, esTablaInexistente } from './columna-opcional.util';
import {
  MIGRACION_RESERVA_VIGENCIA,
  TABLA_RESERVA_VIGENCIA,
  tarifasDeLegado,
  tarifasDeVigencias,
  type ReservaVigenciaRow,
  type TarifaReservaVigente,
} from './reserva-overhaul.util';

/** ¿Ya está aplicada la migración de las vigencias? */
export function reservaVigenciaDisponible(
  sb: SupabaseClient,
): Promise<boolean> {
  return columnaOpcional(sb, TABLA_RESERVA_VIGENCIA, 'vigente_desde', {
    tambienTabla: true,
    mensajeAusente:
      `Tabla ${TABLA_RESERVA_VIGENCIA} no existe todavía: la reserva de ` +
      `overhaul sigue con UNA tarifa por avión («desde siempre», tabla ` +
      `reserva_overhaul) hasta aplicar la migración ${MIGRACION_RESERVA_VIGENCIA}`,
  }).disponible();
}

export interface TarifasReservaLeidas {
  tarifas: TarifaReservaVigente[];
  /** true = salieron de `reserva_overhaul_vigencia` (con «a partir de»). */
  con_vigencias: boolean;
}

async function leerLegado(
  sb: SupabaseClient,
  aeronaveId?: string,
): Promise<TarifaReservaVigente[]> {
  let q = sb.from('reserva_overhaul').select('aeronave_id, monto_por_hora_usd');
  if (aeronaveId) q = q.eq('aeronave_id', aeronaveId);
  const { data, error } = await q;
  if (error) {
    throw new Error(`Fallo al leer la reserva de overhaul: ${error.message}`);
  }
  return tarifasDeLegado(data ?? []);
}

/**
 * Tarifas de la reserva de toda la flota (o de UN avión), ya normalizadas.
 * Un fallo de lectura SUBE (nunca una reserva en $0 inventada).
 */
export async function leerTarifasReserva(
  sb: SupabaseClient,
  aeronaveId?: string,
): Promise<TarifasReservaLeidas> {
  if (!(await reservaVigenciaDisponible(sb))) {
    return { tarifas: await leerLegado(sb, aeronaveId), con_vigencias: false };
  }
  // Toda la flota SIEMPRE (son pocas filas): «vacía» se decide sobre la
  // tabla completa, no sobre el avión que se pide.
  // Solo las VIVAS: una tarifa eliminada conserva su fila (soft delete).
  const { data, error } = await sb
    .from(TABLA_RESERVA_VIGENCIA)
    .select('aeronave_id, vigente_desde, usd_hr_por_motor, motores')
    .is('deleted_at', null);
  if (error) {
    // La sonda dijo «sí» y la tabla ya no está (rollback de la migración):
    // se vuelve al camino legado en vez de tumbar el balance.
    if (esTablaInexistente(error)) {
      return {
        tarifas: await leerLegado(sb, aeronaveId),
        con_vigencias: false,
      };
    }
    throw new Error(
      `Fallo al leer las tarifas de la reserva de overhaul: ${error.message}`,
    );
  }
  const filas = (data ?? []) as ReservaVigenciaRow[];
  if (filas.length === 0) {
    return { tarifas: await leerLegado(sb, aeronaveId), con_vigencias: false };
  }
  return {
    tarifas: tarifasDeVigencias(
      aeronaveId ? filas.filter((f) => f.aeronave_id === aeronaveId) : filas,
    ),
    con_vigencias: true,
  };
}
