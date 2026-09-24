import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from '../../common/columna-opcional.util';
import { facturaEmitidaDisponible } from '../../common/factura-emitida-disponible.util';
import {
  etiquetaCfdiVivo,
  etiquetaEmitidasVigentes,
  etiquetaFacturaVuelo,
  type FacturaEmitidaEtiquetaRow,
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
 * Cascada (pura, en `etiquetaFacturaVuelo`): CFDI vivo → facturas EMITIDAS
 * a mano VIGENTES del registro («A-123, A-130») → `vuelo.factura_folio`
 * (legado) → etiqueta del estatus («Facturado» / «Factura elaborada y
 * enviada») → nada. EN LOTE: dos consultas por cada 200 vuelos (`factura` +
 * columnas de `vuelo`) y una tercera al puente `factura_emitida_vuelo` SOLO
 * con la migración 20260924000003 aplicada — nunca N+1.
 *
 * Tolerante a las migraciones pendientes (`columnaOpcional`, re-sondeo ≤ 10
 * min): sin `20260923000001` se lee solo `facturado`; sin `20260924000001`
 * no se pide `factura_folio`; sin `20260924000003` no se consulta el
 * registro de emitidas — el Excel sale igual que antes, jamás un 500.
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
  const conEmitidas = await facturaEmitidaDisponible(sb);
  const colsVuelo = [
    'id',
    'facturado',
    ...(conEstatus ? ['factura_estatus'] : []),
    ...(conFolio ? ['factura_folio'] : []),
  ].join(', ');

  const cfdiPorVuelo = new Map<string, Array<Record<string, unknown>>>();
  const vueloPorId = new Map<string, VueloFacturaRow>();
  const emitidasPorVuelo = new Map<string, FacturaEmitidaEtiquetaRow[]>();
  for (let i = 0; i < ids.length; i += LOTE_IDS) {
    const lote = ids.slice(i, i + LOTE_IDS);
    const [facturasRes, vuelosRes, emitidasRes] = await Promise.all([
      sb
        .from('factura')
        .select('vuelo_id, serie, folio, estado')
        .in('vuelo_id', lote)
        .neq('estado', 'CANCELADA'),
      sb.from('vuelo').select(colsVuelo).in('id', lote),
      conEmitidas
        ? sb
            .from('factura_emitida_vuelo')
            .select(
              'vuelo_id, factura:factura_emitida!inner(serie, folio, folio_num, estatus, deleted_at)',
            )
            .in('vuelo_id', lote)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (facturasRes.error) throw new Error(facturasRes.error.message);
    if (vuelosRes.error) throw new Error(vuelosRes.error.message);
    if (emitidasRes.error) throw new Error(emitidasRes.error.message);
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
    // El filtro VIGENTE / no borrada lo aplica la cascada pura
    // (`etiquetaEmitidasVigentes`): una sola regla para todos los lectores.
    for (const l of (emitidasRes.data ?? []) as Array<{
      vuelo_id?: string;
      factura?: FacturaEmitidaEtiquetaRow | FacturaEmitidaEtiquetaRow[] | null;
    }>) {
      const vid = l.vuelo_id;
      const f = Array.isArray(l.factura) ? l.factura[0] : l.factura;
      if (!vid || !f) continue;
      (
        emitidasPorVuelo.get(vid) ?? emitidasPorVuelo.set(vid, []).get(vid)!
      ).push(f);
    }
  }

  for (const id of ids) {
    const etiqueta = etiquetaFacturaVuelo({
      cfdi: etiquetaCfdiVivo(cfdiPorVuelo.get(id) ?? []),
      emitidas: etiquetaEmitidasVigentes(emitidasPorVuelo.get(id) ?? []),
      vuelo: vueloPorId.get(id) ?? null,
    });
    if (etiqueta) out.set(id, etiqueta);
  }
  return out;
}
