/**
 * SONDA ÚNICA de la migración `20261013000008_gasto_tua_incluida.sql`
 * (13-oct-2026, TUA sistémica, invariante 66): columna `gasto.tua_incluida`
 * (numeric(14,2) NULL; la TUA con IVA que fija la OFICINA). Patrón
 * `columnaOpcional`: re-sondeo ≤ 10 min, se enciende sola al aplicarla, sin
 * redeploy.
 *
 * REGLA DURA: todo select/insert/update que nombre `gasto.tua_incluida` va
 * detrás de `await tuaIncluidaDisponible(sb)` (Gastos `cols()`/`listCols()`,
 * gastos de vuelos del balance, «Otros movimientos», Libro Dinero, reparto y
 * pre-cierre). Sin la migración: todo como el 0.0.74 (la TUA se separa solo
 * con la lectura de la IA) y un NÚMERO en `tua_incluida` ⇒ 409
 * `TUA_INCLUIDA_NO_DISPONIBLE`.
 *
 * El «sí» se memoriza PARA SIEMPRE: tras el ROLLBACK de la migración hay que
 * reiniciar o redesplegar el API (si no, Gastos, balance, Libro Dinero,
 * reparto y pre-cierre nombran una columna inexistente ⇒ 500).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea `gasto.tua_incluida`. */
export const MIGRACION_TUA_INCLUIDA = '20261013000008';

/** ¿Ya existe `gasto.tua_incluida`? (memorizado; re-sondeo ≤ 10 min). */
export function tuaIncluidaDisponible(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'gasto', 'tua_incluida', {
    mensajeAusente:
      `Columna gasto.tua_incluida no existe todavía: la TUA se separa solo ` +
      `con la lectura de la IA hasta aplicar la migración ` +
      `${MIGRACION_TUA_INCLUIDA}`,
  }).disponible();
}

/**
 * Sufijo de columnas de un select de `gasto` según la sonda: `', tua_incluida'`
 * con la migración, `''` sin ella.
 */
export function colTuaIncluida(disponible: boolean): string {
  return disponible ? ', tua_incluida' : '';
}
