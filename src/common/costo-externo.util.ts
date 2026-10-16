import { BadRequestException } from '@nestjs/common';
import {
  categoriaFueraDelAvion,
  etiquetaCategoriaGasto,
} from './categoria-gasto.util';

/**
 * FUENTE ÚNICA del costo del operador externo CON MONEDA (29-ago-2026).
 *
 * Lo capturable es {monto, moneda} (+ TC cuando la moneda es MXN);
 * `vuelo.costo_externo_usd` queda DERIVADO aquí y sigue siendo la única
 * columna que leen los lectores (reporte por vuelo, reparto de utilidades,
 * balance por avión) — ellos NO se tocan. TODO escritor (cotizar, revisar,
 * cubrir-externo, alta de vuelo externo, revertir a propio) pasa por aquí y
 * escribe las 4 columnas JUNTAS: costo_externo_monto / costo_externo_moneda /
 * costo_externo_tc / costo_externo_usd (nunca a medias).
 *
 * Criterio del TC (invariante 2 del repo: un monto MXN JAMÁS se suma crudo
 * como USD ni desaparece en silencio):
 * - USD ⇒ usd = monto; tc = null.
 * - MXN ⇒ TC efectivo = `tc` del DTO ?? `tcVuelo` (el tc_usd_mxn de la
 *   cotización, de respaldo). Sin ninguno se RECHAZA con 400 en la captura
 *   (el mismo diálogo tiene el campo de TC) — no se persiste a medias.
 * - Banda de plausibilidad 15–25 MXN/USD (la misma de la conciliación
 *   USD↔MXN): fuera de ella es casi seguro un error de captura.
 * - monto vacío/0 ⇒ TODO null ("aún sin pactar": un 0 fingía utilidad
 *   completa; el null lo delata el reparto en sin_costo_count).
 */
export interface CostoExternoResuelto {
  /** Monto capturado en SU moneda (2 decimales), o null = sin costo. */
  monto: number | null;
  moneda: 'USD' | 'MXN' | null;
  /** TC MXN/USD usado para derivar (solo moneda MXN). */
  tc: number | null;
  /** DERIVADO: lo que leen todos los lectores (costo_externo_usd). */
  usd: number | null;
}

/** Banda plausible del TC (espejo de la conciliación USD↔MXN). */
export const COSTO_EXTERNO_TC_MIN = 15;
export const COSTO_EXTERNO_TC_MAX = 25;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function resolverCostoExterno(input: {
  monto?: number | string | null;
  moneda?: string | null;
  tc?: number | string | null;
  /** TC de la cotización (vuelo.tc_usd_mxn), respaldo para moneda MXN. */
  tcVuelo?: number | string | null;
}): CostoExternoResuelto {
  const monto = Number(input.monto);
  if (!Number.isFinite(monto) || monto <= 0) {
    // Limpiar/sin costo: las 4 columnas quedan null.
    return { monto: null, moneda: null, tc: null, usd: null };
  }
  const montoR = round2(monto);
  const moneda: 'USD' | 'MXN' = input.moneda === 'MXN' ? 'MXN' : 'USD';
  if (moneda === 'USD') {
    return { monto: montoR, moneda, tc: null, usd: montoR };
  }
  const tc = [input.tc, input.tcVuelo]
    .map((v) => Number(v))
    .find((v) => Number.isFinite(v) && v > 0);
  if (!tc) {
    throw new BadRequestException(
      'El costo del operador externo está en MXN: captura el tipo de cambio (MXN por USD) para convertirlo.',
    );
  }
  if (tc < COSTO_EXTERNO_TC_MIN || tc > COSTO_EXTERNO_TC_MAX) {
    throw new BadRequestException(
      `Tipo de cambio ${tc} fuera del rango razonable (${COSTO_EXTERNO_TC_MIN}–${COSTO_EXTERNO_TC_MAX} MXN por USD): revisa la captura.`,
    );
  }
  return { monto: montoR, moneda, tc, usd: round2(montoR / tc) };
}

/**
 * EL PAGO AL OPERADOR EXTERNO ES EL GASTO REAL (16-oct-2026, invariante 88
 * del CLAUDE.md del API; misma filosofía que la invariante 73 del pago al
 * vendedor). Caso #308 (CarlosMuciño, 10-sep-2026): `costo_externo_*`
 * capturado ($25,334.40 MXN) Y un gasto OPERACIONES de $25,334.40 (NUCLEUM,
 * conciliado con el banco y FACTURADO) que ES el pago de ese mismo costo. La
 * oficina NECESITA el gasto (conciliación y factura), así que «el pago al
 * operador no va como gasto» no se cumple en la práctica: el Balance general
 * lo restaba DOS veces en OPERACIONES y solo lo avisaba.
 *
 * Regla: en un vuelo EXTERNO no cancelado con costo del operador capturado,
 * los gastos que restan en las columnas del vuelo (no TUAS/GAS/PERMISO/
 * INDIRECTO ni las categorías fuera del avión —empresa y pago al vendedor—)
 * que COINCIDEN con el costo (±1 % en MXN: el gasto en pesos, o el USD × su
 * `tc_gasto` ?? K, contra costo USD × K; o ±1 % en USD nativo si el gasto no
 * es MXN) son el pago al operador. UNO solo cubre el costo —el más cercano;
 * empate ⇒ el más antiguo (`fecha_gasto`, luego `created_at`, luego el orden
 * de llegada)—: el costo se cuenta UNA vez con el GASTO REAL (lo pagado) y el
 * capturado queda como nota. Los demás que coinciden se avisan como posible
 * duplicado. Sin coincidencia ⇒ la conducta de siempre (suma el costo y
 * avisa si hay gastos). NO toca el gasto (sigue en su lista, conciliado y
 * facturado).
 *
 * PURA y ÚNICA: el balance por avión/general, el reporte por vuelo y el
 * reparto (bloque `externos`) deciden con ella; ningún lector repite la
 * prueba. Cada lector, además, solo deja que el gasto cubra si ÉL lo cuenta
 * (un gasto que su cadena de T.C. no pudo convertir no está sumado: ahí el
 * costo capturado sigue contando, una vez).
 */
export interface GastoCandidatoPagoOperador {
  id?: string | null;
  categoria: string | null | undefined;
  moneda: string | null | undefined;
  monto: number | string | null | undefined;
  tc_gasto?: number | string | null;
  fecha_gasto?: string | null;
  created_at?: string | null;
}

export interface PagoOperadorExternoDecision<G> {
  /** Gastos que restan en las columnas del vuelo (pueden ser el pago). */
  candidatos: G[];
  /** Los que coinciden con el costo, el más cercano primero. */
  coinciden: G[];
  /** El gasto que ES el pago al operador (cubre el costo), o null. */
  cubre: G | null;
  /** Coinciden pero NO cubren: posible duplicado del pago. */
  duplicados: G[];
  /** Costo del operador en MXN (costo USD × K, 2 decimales) o null. */
  costoMxn: number | null;
}

/** Categorías del vuelo que NUNCA restan en sus columnas (ver arriba). */
const CATEGORIAS_FUERA_DE_COLUMNAS: ReadonlySet<string> = new Set([
  'TUAS',
  'GAS',
  'PERMISO',
  'INDIRECTO',
]);

/** Tolerancia de la coincidencia (la del aviso de siempre: ±1 %). */
export const PAGO_OPERADOR_TOLERANCIA = 0.01;

const numPos = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

/** ¿El gasto resta en las columnas del vuelo? (`gastosColumna` del balance) */
export function gastoRestaEnColumnasDelVuelo(
  categoria: string | null | undefined,
): boolean {
  return (
    !!categoria &&
    !CATEGORIAS_FUERA_DE_COLUMNAS.has(categoria) &&
    !categoriaFueraDelAvion(categoria)
  );
}

export function pagoOperadorExternoEnGastos<
  G extends GastoCandidatoPagoOperador,
>(input: {
  esExterno: boolean;
  cancelado: boolean;
  /** `vuelo.costo_externo_usd` (null/0 = sin costo capturado). */
  costoUsd: number | string | null | undefined;
  /** K de la venta: T.C. capturado ?? oficial del día de la cotización. */
  tcVenta: number | string | null | undefined;
  gastos: readonly G[];
}): PagoOperadorExternoDecision<G> {
  const candidatos = input.gastos.filter((g) =>
    gastoRestaEnColumnasDelVuelo(g.categoria),
  );
  const costoUsd = numPos(input.costoUsd);
  const K = numPos(input.tcVenta);
  const costoMxn = costoUsd != null && K != null ? round2(costoUsd * K) : null;
  const vacio: PagoOperadorExternoDecision<G> = {
    candidatos,
    coinciden: [],
    cubre: null,
    duplicados: [],
    costoMxn,
  };
  if (!input.esExterno || input.cancelado || costoUsd == null) return vacio;

  const distancia = (g: G): number => {
    const monto = Number(g.monto);
    if (!Number.isFinite(monto) || monto <= 0) return Infinity;
    const esMxn = g.moneda === 'MXN';
    let d = Infinity;
    if (costoMxn != null) {
      const tc = numPos(g.tc_gasto) ?? K;
      const mxn = esMxn ? monto : tc != null ? monto * tc : null;
      if (mxn != null) d = Math.abs(mxn - costoMxn) / costoMxn;
    }
    if (!esMxn) d = Math.min(d, Math.abs(monto - costoUsd) / costoUsd);
    return d;
  };
  const conDistancia = candidatos
    .map((g, i) => ({ g, i, d: distancia(g) }))
    // 1e-9: el borde exacto del ±1 % no se pierde por la coma flotante.
    .filter((x) => x.d <= PAGO_OPERADOR_TOLERANCIA + 1e-9);
  const clave = (v: string | null | undefined): string => v ?? '\uffff';
  conDistancia.sort(
    (a, b) =>
      a.d - b.d ||
      clave(a.g.fecha_gasto).localeCompare(clave(b.g.fecha_gasto)) ||
      clave(a.g.created_at).localeCompare(clave(b.g.created_at)) ||
      a.i - b.i,
  );
  const coinciden = conDistancia.map((x) => x.g);
  if (coinciden.length === 0) return vacio;
  return {
    candidatos,
    coinciden,
    cubre: coinciden[0],
    duplicados: coinciden.slice(1),
    costoMxn,
  };
}

/**
 * Monto en USD con el que el gasto que CUBRE el costo del operador entra a
 * un lector que no cuenta los gastos del externo (el bloque `externos` del
 * reparto): USD tal cual; MXN ÷ `tc_gasto` ?? K (la cadena del reporte por
 * vuelo). Sin T.C. ⇒ null (el lector sigue con el costo capturado).
 */
export function usdDelPagoOperador(
  g: GastoCandidatoPagoOperador,
  tcVenta: number | string | null | undefined,
): number | null {
  const monto = Number(g.monto);
  if (!Number.isFinite(monto)) return null;
  if (g.moneda !== 'MXN') return monto;
  const tc = numPos(g.tc_gasto) ?? numPos(tcVenta);
  return tc != null ? monto / tc : null;
}

/**
 * Etiqueta corta del gasto que cubre el costo, para la nota «cubierto por el
 * gasto «…»»: categoría · proveedor · primera línea de la nota (≤60).
 */
export function etiquetaGastoPagoOperador(g: {
  categoria: string | null | undefined;
  notas?: string | null;
  proveedor?: { nombre?: string } | { nombre?: string }[] | null;
}): string {
  const prov = Array.isArray(g.proveedor)
    ? g.proveedor[0]?.nombre
    : g.proveedor?.nombre;
  const nota = (g.notas ?? '').split('\n')[0].trim().slice(0, 60);
  return [etiquetaCategoriaGasto(g.categoria), prov || null, nota || null]
    .filter(Boolean)
    .join(' · ');
}
