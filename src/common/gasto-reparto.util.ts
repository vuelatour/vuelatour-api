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
// NOMINA (29-ago): nómina/sueldos — mismo tratamiento que INDIRECTO
// (trigger BD ya la acepta). SERVICIOS NO va aquí: es gasto DIRECTO del
// avión (como REFACCION), no se reparte.
export const CATEGORIAS_REPARTIBLES = new Set([
  'OTRO',
  'FIJO',
  'INDIRECTO',
  'NOMINA',
  'GASOLINA',
  'VISITA',
]);

/**
 * Reparte un monto (en CENTAVOS enteros) según porcentajes (hasta 2
 * decimales) — disciplina de centavos del reparto masivo. Los porcentajes se
 * trabajan como CENTÉSIMAS DE PUNTO enteras (25.13 % → 2513): toda la
 * aritmética queda en enteros y no arrastra floats. Base por línea =
 * floor(montoCents × centésimas / 10000); el residuo contra el objetivo
 * (round del total asignado) se reparte de a centavo por MAYOR RESTO
 * (empate: orden de las líneas). Con Σ = 100.00 % el resultado suma
 * exactamente montoCents; con menos, suma round(montoCents × Σ%/100).
 */
export function repartirPorcentajeCents(
  montoCents: number,
  porcentajes: number[],
): number[] {
  const centesimas = porcentajes.map((p) => Math.round(p * 100));
  const partes = centesimas.map((c, idx) => {
    const exacto = montoCents * c; // entero exacto, en diezmilésimas de centavo
    const base = Math.floor(exacto / 10000);
    return { idx, cents: base, resto: exacto % 10000 };
  });
  // Objetivo = round(montoCents × Σcentésimas / 10000), en enteros puros.
  const prod = montoCents * centesimas.reduce((a, c) => a + c, 0);
  const restoProd = prod % 10000;
  const objetivo = (prod - restoProd) / 10000 + (restoProd >= 5000 ? 1 : 0);
  let faltan = objetivo - partes.reduce((a, x) => a + x.cents, 0);
  const orden = [...partes].sort((a, b) =>
    b.resto !== a.resto ? b.resto - a.resto : a.idx - b.idx,
  );
  for (const x of orden) {
    if (faltan <= 0) break;
    x.cents += 1;
    faltan -= 1;
  }
  return partes.map((x) => x.cents);
}

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
