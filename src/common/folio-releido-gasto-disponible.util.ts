/**
 * SONDA ÚNICA de la migración `20261006000001_gasto_folio_releido.sql`
 * (6-oct-2026, API 0.0.58): columna `gasto.folio_releido_at` (cuándo el cron
 * `gastos-releer-folio` volvió a leer con la IA el comprobante de un gasto
 * sin folio; null = pendiente). Patrón `columnaOpcional`: re-sondeo ≤ 10 min,
 * se enciende sola al aplicarla, sin redeploy; el «sí» se memoriza PARA
 * SIEMPRE (si se ejecuta el ROLLBACK de la migración hay que reiniciar el
 * API o el cron fallaría por la columna en cada corrida, sin más daño).
 *
 * REGLA DURA: todo select/update que nombre la columna va detrás de
 * `await folioReleidoGastoDisponible(sb)`. Sin la migración el cron no hace
 * nada (ni lee fotos ni gasta créditos de IA).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea `gasto.folio_releido_at`. */
export const MIGRACION_FOLIO_RELEIDO_GASTO = '20261006000001';

/** ¿Ya existe `gasto.folio_releido_at`? (memorizado; re-sondeo ≤ 10 min). */
export function folioReleidoGastoDisponible(
  sb: SupabaseClient,
): Promise<boolean> {
  return columnaOpcional(sb, 'gasto', 'folio_releido_at', {
    mensajeAusente:
      `Columna gasto.folio_releido_at no existe todavía: la relectura con ` +
      `IA del folio de los comprobantes (cron gastos-releer-folio) queda ` +
      `apagada hasta aplicar la migración ${MIGRACION_FOLIO_RELEIDO_GASTO}`,
  }).disponible();
}
