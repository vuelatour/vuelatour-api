/**
 * SONDA ÚNICA de la migración `20261012000001_movimiento_bancario_orden_archivo`
 * (12-oct-2026, invariante 55): `movimiento_bancario.orden_archivo` = la
 * posición de cada línea dentro del estado de cuenta que se importó, para
 * que el reporte Excel de conciliación salga EN EL MISMO ORDEN que el
 * archivo del banco (pedido del cliente: «cuando se exporta el estado de
 * cuenta me lo acomoda diferente al estado de cuenta que subimos»).
 *
 * Patrón `columnaOpcional` (re-sondeo ≤ 10 min, se enciende sola al
 * aplicarla, sin redeploy). REGLA DURA: todo select/insert que nombre
 * `orden_archivo` va detrás de `await ordenArchivoDisponible(sb)`. Sin la
 * migración: la importación no escribe la columna y el reporte ordena por
 * fecha como hasta hoy.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

export const MIGRACION_ORDEN_ARCHIVO = '20261012000001';

export function ordenArchivoDisponible(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'movimiento_bancario', 'orden_archivo', {
    mensajeAusente:
      `Columna movimiento_bancario.orden_archivo no existe todavía: el reporte ` +
      `de conciliación se ordena por fecha hasta aplicar la migración ` +
      `${MIGRACION_ORDEN_ARCHIVO}`,
  }).disponible();
}
