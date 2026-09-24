import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from '../../common/columna-opcional.util';
import {
  etiquetaCfdiVivo,
  etiquetaFacturaVuelo,
  type VueloFacturaRow,
} from './factura-cliente.util';

/** Ids por consulta `.in(...)`: la URL de PostgREST no crece sin tope. */
const LOTE_IDS = 200;

/**
 * Etiqueta de la factura de cada vuelo para los EXCEL — FUENTE ÚNICA
 * (24-sep-2026). La usan la columna «FACTURA VUELATOUR» del Libro Dinero
 * (hoja 1 y «otros ingresos») y «factura vuelatour» de «otros movimientos»
 * del Balance. Antes cada servicio armaba su propio `facturaPorVuelo` SOLO
 * con la tabla `factura` (CFDI timbrado por el PAC — 0 filas en prod) y la
 * factura que la oficina sube a mano no aparecía nunca.
 *
 * Cascada (pura, en `etiquetaFacturaVuelo`): CFDI vivo → `vuelo.factura_folio`
 * → etiqueta del estatus («Facturado» / «Factura elaborada y enviada») →
 * nada. EN LOTE: dos consultas por cada 200 vuelos (`factura` + columnas de
 * `vuelo`), nunca N+1.
 *
 * Tolerante a las migraciones pendientes (`columnaOpcional`, re-sondeo ≤ 10
 * min): sin `20260923000001` se lee solo `facturado`; sin `20260924000001`
 * no se pide `factura_folio` — el Excel sale igual que antes, jamás un 500.
 * Cualquier OTRO error de lectura se lanza (misma regla que el resto del
 * libro: nunca un reporte armado con datos parciales en silencio).
 */
export async function etiquetasFacturaDeVuelos(
  sb: SupabaseClient,
  vueloIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(vueloIds.filter(Boolean))];
  if (ids.length === 0) return out;

  const conEstatus = await columnaOpcional(sb, 'vuelo', 'factura_estatus', {
    mensajeAusente:
      'Columnas vuelo.factura_* no existen todavía: la factura del servicio se deriva de vuelo.facturado hasta aplicar la migración 20260923000001',
  }).disponible();
  const conFolio =
    conEstatus &&
    (await columnaOpcional(sb, 'vuelo', 'factura_folio', {
      mensajeAusente:
        'Columnas vuelo.factura_folio/factura_uuid no existen todavía: el folio de la factura del servicio no se guarda hasta aplicar la migración 20260924000001',
    }).disponible());
  const colsVuelo = [
    'id',
    'facturado',
    ...(conEstatus ? ['factura_estatus'] : []),
    ...(conFolio ? ['factura_folio'] : []),
  ].join(', ');

  const cfdiPorVuelo = new Map<string, Array<Record<string, unknown>>>();
  const vueloPorId = new Map<string, VueloFacturaRow>();
  for (let i = 0; i < ids.length; i += LOTE_IDS) {
    const lote = ids.slice(i, i + LOTE_IDS);
    const [facturasRes, vuelosRes] = await Promise.all([
      sb
        .from('factura')
        .select('vuelo_id, serie, folio, estado')
        .in('vuelo_id', lote)
        .neq('estado', 'CANCELADA'),
      sb.from('vuelo').select(colsVuelo).in('id', lote),
    ]);
    if (facturasRes.error) throw new Error(facturasRes.error.message);
    if (vuelosRes.error) throw new Error(vuelosRes.error.message);
    for (const f of (facturasRes.data ?? []) as Array<
      Record<string, unknown>
    >) {
      const vid = f.vuelo_id as string;
      if (!vid) continue;
      (cfdiPorVuelo.get(vid) ?? cfdiPorVuelo.set(vid, []).get(vid)!).push(f);
    }
    for (const v of (vuelosRes.data ?? []) as unknown as Array<
      VueloFacturaRow & { id: string }
    >) {
      vueloPorId.set(v.id, v);
    }
  }

  for (const id of ids) {
    const etiqueta = etiquetaFacturaVuelo({
      cfdi: etiquetaCfdiVivo(cfdiPorVuelo.get(id) ?? []),
      vuelo: vueloPorId.get(id) ?? null,
    });
    if (etiqueta) out.set(id, etiqueta);
  }
  return out;
}
