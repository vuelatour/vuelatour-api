/**
 * SONDA ÚNICA de la migración `20261005000001_aeronave_combustible.sql`
 * (5-oct-2026, API 0.0.56): columna `aeronave.combustible` ('AVGAS' |
 * 'TURBOSINA', NOT NULL default 'AVGAS'). Patrón `columnaOpcional`:
 * re-sondeo ≤ 10 min, se enciende sola al aplicarla, sin redeploy; el «sí»
 * se memoriza PARA SIEMPRE (si se ejecuta el ROLLBACK de la migración hay
 * que reiniciar el API o la flota responde 500 por la columna).
 *
 * REGLA DURA: todo select/insert/update que nombre `aeronave.combustible` va
 * detrás de `await combustibleAeronaveDisponible(sb)`. Sin la migración:
 * la flota (`GET /v1/aircraft`, detalle, alta, edición) responde como el
 * 0.0.55 —sin el campo— y las cargas GAS se guardan TAL CUAL (no se
 * corrigen: no hay contra qué).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea `aeronave.combustible`. */
export const MIGRACION_COMBUSTIBLE_AERONAVE = '20261005000001';

/** ¿Ya existe `aeronave.combustible`? (memorizado; re-sondeo ≤ 10 min). */
export function combustibleAeronaveDisponible(
  sb: SupabaseClient,
): Promise<boolean> {
  return columnaOpcional(sb, 'aeronave', 'combustible', {
    mensajeAusente:
      `Columna aeronave.combustible no existe todavía: la flota se lee sin ` +
      `el campo y las cargas GAS se guardan sin ajustar al combustible del ` +
      `avión hasta aplicar la migración ${MIGRACION_COMBUSTIBLE_AERONAVE}`,
  }).disponible();
}
