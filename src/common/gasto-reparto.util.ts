import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Reparto MANUAL de gastos generales entre aviones (26-ago-2026).
 *
 * REGLA ÚNICA para TODOS los lectores de dinero (reparto a socios, balance
 * por avión, libro Dinero, dashboards, pre-cierre): si un gasto tiene filas
 * en `gasto_reparto`, el reparto GANA sobre `gasto.aeronave_id` — el gasto
 * base se EXCLUYE de la atribución cruda y en su lugar cuentan los
 * PARCIALES (uno por avión, en la MONEDA del gasto, heredando su tc_gasto).
 * El REMANENTE (monto − Σ parciales) no se carga a ningún avión: es gasto
 * de la EMPRESA VuelaTour, y se DERIVA — jamás se persiste.
 *
 * Este util es la fuente única de esa expansión: no copiar la regla en cada
 * lector (divergirían reparto vs balance vs libro — mentira numérica).
 */
export interface GastoRepartoFila {
  gasto_id: string;
  aeronave_id: string;
  monto: number;
}

/** Categorías de gasto que aceptan reparto manual (generales, sin vuelo). */
// GASOLINA (27-ago): gasolina de vehículos — gasto de la empresa,
// repartible a mano igual que OTRO/FIJO/INDIRECTO (trigger BD en sync).
export const CATEGORIAS_REPARTIBLES = new Set([
  'OTRO',
  'FIJO',
  'INDIRECTO',
  'GASOLINA',
]);

/**
 * Filas de gasto_reparto para un conjunto de gastos, en chunks (PostgREST
 * limita el .in()). Devuelve Map<gasto_id, filas[]>.
 */
export async function fetchRepartos(
  sb: SupabaseClient,
  gastoIds: string[],
): Promise<Map<string, GastoRepartoFila[]>> {
  const out = new Map<string, GastoRepartoFila[]>();
  const unicos = [...new Set(gastoIds.filter((x) => !!x))];
  const CHUNK = 200;
  for (let i = 0; i < unicos.length; i += CHUNK) {
    const { data, error } = await sb
      .from('gasto_reparto')
      .select('gasto_id, aeronave_id, monto')
      .in('gasto_id', unicos.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const fila: GastoRepartoFila = {
        gasto_id: r.gasto_id as string,
        aeronave_id: r.aeronave_id as string,
        monto: Number(r.monto),
      };
      const lista = out.get(fila.gasto_id) ?? [];
      lista.push(fila);
      out.set(fila.gasto_id, lista);
    }
  }
  return out;
}

/**
 * Expande una lista de gastos aplicando el reparto: los gastos SIN reparto
 * pasan tal cual; los que SÍ tienen se sustituyen por clones parciales
 * (mismo shape del lector: spread del padre) con `aeronave_id` y `monto`
 * efectivos. El remanente de cada gasto repartido se reporta aparte
 * (empresa). `monto` del padre puede venir string (numeric de PostgREST).
 */
export function expandirConReparto<
  T extends { id?: string | null; aeronave_id?: string | null; monto: unknown },
>(
  gastos: T[],
  repartos: Map<string, GastoRepartoFila[]>,
): {
  atribuciones: Array<T & { es_reparto_parcial?: boolean }>;
  /** Remanentes de empresa: gasto padre + monto no asignado (misma moneda). */
  empresa: Array<{ gasto: T; remanente: number }>;
} {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const atribuciones: Array<T & { es_reparto_parcial?: boolean }> = [];
  const empresa: Array<{ gasto: T; remanente: number }> = [];
  for (const g of gastos) {
    const filas = g.id ? repartos.get(g.id) : undefined;
    if (!filas || filas.length === 0) {
      atribuciones.push(g);
      continue;
    }
    let suma = 0;
    for (const f of filas) {
      suma += f.monto;
      atribuciones.push({
        ...g,
        aeronave_id: f.aeronave_id,
        monto: f.monto,
        es_reparto_parcial: true,
      });
    }
    const remanente = r2(Number(g.monto) - suma);
    if (remanente > 0) empresa.push({ gasto: g, remanente });
  }
  return { atribuciones, empresa };
}
