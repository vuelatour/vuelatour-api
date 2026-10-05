/**
 * SONDA ÚNICA de la migración `20261005000002_factura_recibida_serie_folio.sql`
 * (5-oct-2026, API 0.0.57): columnas `factura_recibida.serie`, `.folio` y
 * `.folio_releido_at`. Las tres entran en UN solo `ALTER TABLE` (atómico):
 * basta sondear `serie`. Patrón `columnaOpcional`: re-sondeo ≤ 10 min, se
 * enciende sola al aplicarla, sin redeploy; el «sí» se memoriza PARA SIEMPRE
 * (si se ejecuta el ROLLBACK de la migración hay que reiniciar el API o el
 * buzón de recibidas y la conciliación responden 500 por la columna).
 *
 * REGLA DURA: todo select/insert/update que nombre esas columnas va detrás
 * de `await serieFolioRecibidaDisponible(sb)`. Sin la migración: el buzón
 * de recibidas responde como el 0.0.56 (sin serie/folio), el cron de
 * relectura no hace nada y el número de factura de conciliación sale de
 * `folio_ticket` / la IA / el UUID (`common/folio-comprobante.util`).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea `factura_recibida.serie/folio/folio_releido_at`. */
export const MIGRACION_SERIE_FOLIO_RECIBIDA = '20261005000002';

/** ¿Ya existe `factura_recibida.serie`? (memorizado; re-sondeo ≤ 10 min). */
export function serieFolioRecibidaDisponible(
  sb: SupabaseClient,
): Promise<boolean> {
  return columnaOpcional(sb, 'factura_recibida', 'serie', {
    mensajeAusente:
      `Columna factura_recibida.serie no existe todavía: las facturas ` +
      `recibidas van sin serie/folio y la conciliación toma el número de ` +
      `factura del ticket, la IA o el UUID hasta aplicar la migración ` +
      `${MIGRACION_SERIE_FOLIO_RECIBIDA}`,
  }).disponible();
}
