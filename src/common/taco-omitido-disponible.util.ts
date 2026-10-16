/**
 * SONDA ÚNICA de la migración `20261015000001_escala_taco_omitido.sql`
 * (15-oct-2026, tacómetro omitido por tramo, invariante 79): columnas
 * `escala.taco_omitido_at / _por / _motivo`. Patrón `columnaOpcional`:
 * re-sondeo ≤ 10 min, se enciende sola al aplicarla, sin redeploy.
 *
 * REGLA DURA: todo select/update que NOMBRE una columna `taco_omitido_*` va
 * detrás de `await tacoOmitidoDisponible(sb)` (un update que la nombre sin la
 * columna responde PGRST204 ⇒ 500). `ESCALA_COLS` NO cambia: cada lector hace
 * `${ESCALA_COLS}${colsTacoOmitido(ok)}`. Sin la migración: lecturas como el
 * API 0.0.80 con las llaves `taco_omitido_*` en `null` y las escrituras
 * nuevas (`POST`/`DELETE …/taco/omitir`) ⇒ 503 `MIGRACION_PENDIENTE`.
 *
 * El «sí» se memoriza PARA SIEMPRE: tras el ROLLBACK de la migración hay que
 * reiniciar o redesplegar el API.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea `escala.taco_omitido_*`. */
export const MIGRACION_TACO_OMITIDO = '20261015000001';

/** ¿Ya existe `escala.taco_omitido_at`? (memorizado; re-sondeo ≤ 10 min). */
export function tacoOmitidoDisponible(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'escala', 'taco_omitido_at', {
    mensajeAusente:
      `Columna escala.taco_omitido_at no existe todavía: los tramos no se pueden ` +
      `omitir y las lecturas salen sin omisión hasta aplicar la migración ${MIGRACION_TACO_OMITIDO}`,
  }).disponible();
}

/** Las tres columnas de la omisión (para sumar a un select de `escala`). */
export const COLS_TACO_OMITIDO =
  'taco_omitido_at, taco_omitido_por, taco_omitido_motivo';

/**
 * Sufijo de columnas de un select de `escala` según la sonda:
 * `', taco_omitido_at, taco_omitido_por, taco_omitido_motivo'` con la
 * migración, `''` sin ella.
 */
export function colsTacoOmitido(disponible: boolean): string {
  return disponible ? `, ${COLS_TACO_OMITIDO}` : '';
}
