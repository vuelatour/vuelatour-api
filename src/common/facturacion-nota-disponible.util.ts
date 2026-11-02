/**
 * SONDA ÚNICA de la migración `20261102000001_estatus_facturacion_no_obtenida.sql`
 * (2-nov-2026, invariante 115): columna `gasto.facturacion_nota` (text,
 * motivo de «No obtenida») + el quinto valor `NO_OBTENIDA` del CHECK de
 * `estatus_facturacion`. Patrón `columnaOpcional`: re-sondeo ≤ 10 min, se
 * enciende sola al aplicarla, sin redeploy.
 *
 * REGLA DURA: todo select / insert / update que nombre `facturacion_nota`
 * va detrás de `await facturacionNotaDisponible(sb)` (Gastos `cols()`/
 * `listCols()`, alta y PATCH). Sin la migración: `NO_OBTENIDA` o una nota
 * en un alta/PATCH ⇒ 400 legible (`MENSAJE_NO_OBTENIDA_SIN_MIGRACION`, en
 * `facturacion-gasto.util`); una nota ausente no se nombra. El «sí» se
 * memoriza: tras un ROLLBACK de la migración hay que reiniciar el API.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea `gasto.facturacion_nota` y admite `NO_OBTENIDA`. */
export const MIGRACION_NO_OBTENIDA = '20261102000001';

/** ¿Ya existe `gasto.facturacion_nota`? (memorizado; re-sondeo ≤ 10 min). */
export function facturacionNotaDisponible(
  sb: SupabaseClient,
): Promise<boolean> {
  return columnaOpcional(sb, 'gasto', 'facturacion_nota', {
    mensajeAusente:
      `Columna gasto.facturacion_nota no existe todavía: «No obtenida» con ` +
      `motivo sigue apagada hasta aplicar la migración ${MIGRACION_NO_OBTENIDA}`,
  }).disponible();
}

/** Sufijo de columnas de un select de `gasto` según la sonda. */
export function colsFacturacionNota(disponible: boolean): string {
  return disponible ? ', facturacion_nota' : '';
}
