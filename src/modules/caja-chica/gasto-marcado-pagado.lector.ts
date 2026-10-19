/**
 * ¿CUÁNDO SE MARCÓ PAGADO cada gasto? (gastos «por pagar», 19-oct-2026,
 * invariante 93; revisión adversaria del lote, P7).
 *
 * Un EFECTIVO por pagar vigente está FUERA del libro de caja chica y entra
 * al marcarse pagado con la fecha REAL del pago. La oficina no tiene candado
 * de reposición: si lo marca pagado con una fecha que la última reposición
 * ya cubrió, el gasto cae en el tramo de esa reposición y su Excel lo listaba
 * sin el resalte naranja (el resalte miraba solo `created_at`), con una
 * «Diferencia» que cambiaba sin explicación. Este lector le da al Excel el
 * instante de la ÚLTIMA vez que el gasto pasó de `por_pagar` true a false
 * (fila UPDATE de `gasto_bitacora` con `diff.por_pagar.despues = false`, que
 * escribe el trigger `tg_gasto_bitacora` desde la migración 20261019000001).
 *
 * BEST-EFFORT: jamás lanza; cualquier lectura caída ⇒ mapa VACÍO (el Excel
 * sale sin ese resalte, nunca a medias) y un warn. Detrás de la sonda ÚNICA
 * `porPagarDisponible`: sin la migración no hay consulta. Lotes de
 * `LOTE_BITACORA_PAGADOS` ids por `in` (índice `idx_gasto_bitacora_gasto`).
 */
import type { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { porPagarDisponible } from '../../common/por-pagar-disponible.util';

/** Ids por consulta (`in` de PostgREST en la URL). */
export const LOTE_BITACORA_PAGADOS = 150;

/** Warn cuando la lectura cae (el Excel sale sin el resalte). */
export const AVISO_SIN_MARCADOS_PAGADOS =
  'Excel de la reposición sin el resalte de los gastos marcados pagados después';

/**
 * `gasto_id` ⇒ ISO del instante (el `created_at` de la fila de bitácora) de
 * la ÚLTIMA vez que se marcó pagado. Gastos sin esa fila no aparecen.
 */
export async function marcadosPagadosEnBitacora(
  sb: SupabaseClient,
  ids: readonly string[],
  logger?: Pick<Logger, 'warn'>,
): Promise<Map<string, string>> {
  const unicos = [...new Set(ids.filter((id) => typeof id === 'string'))];
  if (unicos.length === 0) return new Map();
  try {
    if (!(await porPagarDisponible(sb))) return new Map();
    const out = new Map<string, string>();
    for (let i = 0; i < unicos.length; i += LOTE_BITACORA_PAGADOS) {
      const { data, error } = await sb
        .from('gasto_bitacora')
        .select('gasto_id, created_at')
        .eq('accion', 'UPDATE')
        .eq('diff->por_pagar->>despues', 'false')
        .in('gasto_id', unicos.slice(i, i + LOTE_BITACORA_PAGADOS));
      if (error) throw new Error(error.message);
      for (const fila of (data ?? []) as Array<Record<string, unknown>>) {
        const id = fila.gasto_id;
        const cuando = fila.created_at;
        if (typeof id !== 'string' || typeof cuando !== 'string') continue;
        const ms = Date.parse(cuando);
        if (!Number.isFinite(ms)) continue;
        const previo = out.get(id);
        if (previo === undefined || ms > Date.parse(previo)) {
          out.set(id, cuando);
        }
      }
    }
    return out;
  } catch (e) {
    logger?.warn(
      `${AVISO_SIN_MARCADOS_PAGADOS}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return new Map();
  }
}
