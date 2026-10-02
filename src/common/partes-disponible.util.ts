/**
 * SONDA ÚNICA de la migración `20261002000002_conciliacion_partes.sql`
 * (2-oct-2026): 1 cargo del banco ↔ N gastos («lote»). Crea la tabla puente
 * `movimiento_bancario_gasto` (FUENTE ÚNICA de la liga cargo ↔ gasto), la
 * columna `movimiento_bancario.gastos_n`, la vista `v_gasto_conciliacion` y
 * las RPC `conciliacion_ligar_cargo_gastos` / `conciliacion_desligar_cargo_gastos`.
 * La migración es atómica: basta sondear la columna (patrón
 * `columnaOpcional`: re-sondeo ≤ 10 min, se enciende sola al aplicarla, sin
 * redeploy).
 *
 * REGLA DURA: todo select/update/filtro que nombre `gastos_n`, la puente o la
 * vista va detrás de `await partesDisponibles(sb)`. Sin la migración: los
 * lectores vuelven al espejo `gasto_id` / |monto| (comportamiento 0.0.51),
 * `link()` con UN gasto usa el camino directo de siempre, y el lote (N ≥ 2)
 * y `GET …/gastos-candidatos` responden 503
 * `CONCILIACION_PARTES_NO_DISPONIBLE`.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';
import { esFuncionInexistente } from './updated-at-trigger.util';
import { esTablaInexistente } from '../modules/inventory/eliminar-movimiento.util';

/** Migración que crea la puente cargo ↔ gastos. */
export const MIGRACION_PARTES = '20261002000002';

/** Texto del 503 (es-MX, para el operador). */
export const MENSAJE_PARTES_NO_DISPONIBLE =
  'La conciliación de un cargo con varios gastos todavía no está habilitada en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.';

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function partesDisponibles(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'movimiento_bancario', 'gastos_n', {
    mensajeAusente:
      `Columna movimiento_bancario.gastos_n no existe todavía: la conciliación ` +
      `de un cargo con varios gastos responde 503 hasta aplicar la migración ` +
      `${MIGRACION_PARTES} (la liga de UN gasto sigue como hoy)`,
  }).disponible();
}

/** 503 estructurado `CONCILIACION_PARTES_NO_DISPONIBLE`. */
export function errorPartesNoDisponibles(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_PARTES_NO_DISPONIBLE,
    error: 'CONCILIACION_PARTES_NO_DISPONIBLE',
    details: { migracion: MIGRACION_PARTES },
  });
}

/**
 * ¿El error de la RPC/tabla dice que la migración NO está (todavía) en el
 * schema cache? Función inexistente (PGRST202 / 42883) o tabla/vista
 * ausente (PGRST205 / 42P01). Ese caso se responde 503, nunca 500.
 */
export function esPartesAusentes(
  err: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  return esFuncionInexistente(err) || esTablaInexistente(err);
}
