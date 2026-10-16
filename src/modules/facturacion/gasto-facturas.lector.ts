/**
 * LECTOR de «qué facturas amparan este gasto» (16-oct-2026, API 0.0.87,
 * invariante 87). Fuente ÚNICA para la fila de Gastos (`facturas_n`), el
 * detalle `GET /v1/expenses/:id` (`facturas`, `facturas_avisos`) y las
 * respuestas de `POST /invoices/recibidas/de-gasto` y de quitar una liga.
 *
 * - Con la migración `20261016000003` (sonda `gastoFacturasDisponible`): la
 *   tabla puente `gasto_factura_recibida` es la verdad; la principal
 *   (`gasto.factura_recibida_id`) se marca `principal: true` y va primero. Si
 *   por lo que fuera la principal no estuviera en la puente (la BD lo impide
 *   con un trigger), se agrega igual: nunca desaparece una factura.
 * - Sin la migración: la única factura es la principal (conducta 0.0.85).
 *
 * Es CLASIFICACIÓN, no dinero: nada de aquí entra a conciliación, balance,
 * reparto ni pre-cierre.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from '../../common/columna-opcional.util';
import { gastoFacturasDisponible } from '../../common/gasto-facturas-disponible.util';
import { serieFolioRecibidaDisponible } from '../../common/serie-folio-recibida-disponible.util';
import {
  aFacturaDeGasto,
  avisoSumaFacturas,
  ordenarFacturasDeGasto,
  type FacturaDeGasto,
} from './gasto-facturas.util';

/** Tope de ids por `.in()` (URL de PostgREST). */
const LOTE_IN = 200;

/** Liga de la puente. */
export interface LigaGastoFactura {
  gasto_id: string;
  factura_recibida_id: string;
  created_at: string | null;
}

/** Lo mínimo del gasto que necesita el lector. */
export interface GastoParaFacturas {
  id: string;
  factura_recibida_id?: string | null;
}

function lotes<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += LOTE_IN)
    out.push(xs.slice(i, i + LOTE_IN));
  return out;
}

/** Columnas de `factura_recibida` para `FacturaDeGasto`, según la BD. */
export async function colsFacturaDeGasto(sb: SupabaseClient): Promise<string> {
  const [conPdf, conSerie] = await Promise.all([
    columnaOpcional(sb, 'factura_recibida', 'pdf_url').disponible(),
    serieFolioRecibidaDisponible(sb),
  ]);
  return `id, uuid_fiscal, emisor_nombre, total, moneda, fecha_emision, xml_url, notas${conPdf ? ', pdf_url' : ''}${conSerie ? ', serie, folio' : ''}`;
}

/** Ligas de la puente de esos gastos (SOLO con la migración). */
export async function ligasDeGastos(
  sb: SupabaseClient,
  gastoIds: string[],
): Promise<LigaGastoFactura[]> {
  const ids = [...new Set(gastoIds.filter(Boolean))];
  const out: LigaGastoFactura[] = [];
  for (const lote of lotes(ids)) {
    const { data, error } = await sb
      .from('gasto_factura_recibida')
      .select('gasto_id, factura_recibida_id, created_at')
      .in('gasto_id', lote);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      out.push({
        gasto_id: String(r.gasto_id),
        factura_recibida_id: String(r.factura_recibida_id),
        created_at: (r.created_at as string | null) ?? null,
      });
    }
  }
  return out;
}

/** Ligas de la puente de esas FACTURAS (SOLO con la migración). */
export async function ligasDeFacturas(
  sb: SupabaseClient,
  facturaIds: string[],
): Promise<LigaGastoFactura[]> {
  const ids = [...new Set(facturaIds.filter(Boolean))];
  const out: LigaGastoFactura[] = [];
  for (const lote of lotes(ids)) {
    const { data, error } = await sb
      .from('gasto_factura_recibida')
      .select('gasto_id, factura_recibida_id, created_at')
      .in('factura_recibida_id', lote);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      out.push({
        gasto_id: String(r.gasto_id),
        factura_recibida_id: String(r.factura_recibida_id),
        created_at: (r.created_at as string | null) ?? null,
      });
    }
  }
  return out;
}

/**
 * Facturas de cada gasto (principal primero; luego por antigüedad de la
 * liga). Gastos sin ninguna ⇒ arreglo vacío.
 */
export async function facturasDeGastos(
  sb: SupabaseClient,
  gastos: GastoParaFacturas[],
): Promise<Map<string, FacturaDeGasto[]>> {
  const res = new Map<string, FacturaDeGasto[]>();
  for (const g of gastos) res.set(g.id, []);
  if (gastos.length === 0) return res;

  const principalDe = new Map<string, string | null>(
    gastos.map((g) => [g.id, g.factura_recibida_id ?? null]),
  );
  const ligas: LigaGastoFactura[] = (await gastoFacturasDisponible(sb))
    ? await ligasDeGastos(
        sb,
        gastos.map((g) => g.id),
      )
    : [];
  // La principal siempre cuenta (aunque faltara en la puente).
  for (const g of gastos) {
    const p = g.factura_recibida_id;
    if (
      p &&
      !ligas.some((l) => l.gasto_id === g.id && l.factura_recibida_id === p)
    ) {
      ligas.push({ gasto_id: g.id, factura_recibida_id: p, created_at: null });
    }
  }
  if (ligas.length === 0) return res;

  const facturaIds = [...new Set(ligas.map((l) => l.factura_recibida_id))];
  const cols = await colsFacturaDeGasto(sb);
  const filas = new Map<string, Record<string, unknown>>();
  for (const lote of lotes(facturaIds)) {
    const { data, error } = await sb
      .from('factura_recibida')
      .select(cols)
      .in('id', lote);
    if (error) throw new Error(error.message);
    for (const f of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      filas.set(String(f.id), f);
    }
  }

  const porGasto = new Map<
    string,
    Array<{ factura: FacturaDeGasto; ligada_at: string | null }>
  >();
  for (const l of ligas) {
    const fila = filas.get(l.factura_recibida_id);
    if (!fila) continue; // factura recién quitada (carrera): no se inventa
    const lista = porGasto.get(l.gasto_id) ?? [];
    if (lista.some((x) => x.factura.id === l.factura_recibida_id)) continue;
    lista.push({
      factura: aFacturaDeGasto(fila, principalDe.get(l.gasto_id)),
      ligada_at: l.created_at,
    });
    porGasto.set(l.gasto_id, lista);
  }
  for (const [gid, lista] of porGasto) {
    res.set(
      gid,
      ordenarFacturasDeGasto(lista).map((x) => x.factura),
    );
  }
  return res;
}

/**
 * Cuántas facturas tiene cada gasto (fila de la lista: `facturas_n`). Sin la
 * migración: 1 si tiene principal, 0 si no (sin consulta).
 */
export async function conteoFacturasDeGastos(
  sb: SupabaseClient,
  gastos: GastoParaFacturas[],
): Promise<Map<string, number>> {
  const res = new Map<string, number>();
  for (const g of gastos) res.set(g.id, g.factura_recibida_id ? 1 : 0);
  if (gastos.length === 0 || !(await gastoFacturasDisponible(sb))) return res;
  const ligas = await ligasDeGastos(
    sb,
    gastos.map((g) => g.id),
  );
  const porGasto = new Map<string, Set<string>>();
  for (const l of ligas) {
    const s = porGasto.get(l.gasto_id) ?? new Set<string>();
    s.add(l.factura_recibida_id);
    porGasto.set(l.gasto_id, s);
  }
  for (const g of gastos) {
    const s = new Set(porGasto.get(g.id) ?? []);
    if (g.factura_recibida_id) s.add(g.factura_recibida_id);
    res.set(g.id, s.size);
  }
  return res;
}

/**
 * ¿Alguna de esas facturas ampara además OTRO gasto? (VIP SAESA: entonces
 * el aviso de la suma no aplica.)
 */
export async function algunaFacturaCompartida(
  sb: SupabaseClient,
  gastoId: string,
  facturaIds: string[],
): Promise<boolean> {
  const ids = [...new Set(facturaIds.filter(Boolean))];
  if (ids.length === 0) return false;
  if (await gastoFacturasDisponible(sb)) {
    const ligas = await ligasDeFacturas(sb, ids);
    if (ligas.some((l) => l.gasto_id !== gastoId)) return true;
  }
  // Principal de otro gasto (sin la puente, o como red por si faltara).
  for (const lote of lotes(ids)) {
    const { data, error } = await sb
      .from('gasto')
      .select('id')
      .in('factura_recibida_id', lote)
      .neq('id', gastoId)
      .limit(1);
    if (error) throw new Error(error.message);
    if ((data ?? []).length > 0) return true;
  }
  return false;
}

/** Detalle de UN gasto: sus facturas + los avisos no bloqueantes. */
export async function detalleFacturasDeGasto(
  sb: SupabaseClient,
  gasto: GastoParaFacturas & { monto?: unknown; moneda?: unknown },
): Promise<{
  facturas: FacturaDeGasto[];
  avisos: string[];
  multiples: boolean;
}> {
  const multiples = await gastoFacturasDisponible(sb);
  const facturas = (await facturasDeGastos(sb, [gasto])).get(gasto.id) ?? [];
  const avisos: string[] = [];
  if (facturas.some((f) => f.total != null)) {
    const compartida = await algunaFacturaCompartida(
      sb,
      gasto.id,
      facturas.map((f) => f.id),
    );
    const aviso = avisoSumaFacturas(
      { monto: gasto.monto, moneda: gasto.moneda },
      facturas,
      compartida,
    );
    if (aviso) avisos.push(aviso);
  }
  return { facturas, avisos, multiples };
}
