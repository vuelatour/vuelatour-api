/**
 * `GET /v1/conciliacion/movimientos/:id/gastos-candidatos` (2-oct-2026, API
 * 0.0.52): los gastos que podrían pagar UN cargo (uno o varios, «lote»).
 * Caso real: 29 «Pago VIP SAESA» casi iguales y la lista precargada del
 * panel (200 gastos) dejaba fuera el del 14-sep. Aquí vive, PURO y con
 * spec, cómo se interpreta la búsqueda y en qué orden se ofrecen.
 */
import { difDias } from './paywise-cruce.util';
import { TOLERANCIA_CONCILIACION } from './conciliacion-parcial.util';

/** Búsqueda ya interpretada. */
export type BusquedaGasto =
  | { tipo: 'vacia' }
  /** Monto: `[min, max]` o, con `maxExclusivo`, `[min, max)`. */
  | { tipo: 'monto'; min: number; max: number; maxExclusivo: boolean }
  | { tipo: 'texto'; texto: string };

const c2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Interpreta `q`:
 * - vacía ⇒ `vacia`;
 * - número ENTERO sin decimales («2801») ⇒ monto ∈ [2801, 2802);
 * - con decimales («2801.40», «2801.4») ⇒ ±0.01;
 * - lo demás ⇒ texto (proveedor, nota, lugar, folio del ticket).
 * El panel ya la manda normalizada; por si acaso se toleran «$», espacios
 * y comas de miles («$ 2,801.40»).
 */
export function interpretarBusquedaGasto(
  q: string | null | undefined,
): BusquedaGasto {
  const t = String(q ?? '').trim();
  if (!t) return { tipo: 'vacia' };
  const sinSigno = t.replace(/^\$\s*/, '');
  const numero = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(sinSigno)
    ? sinSigno.replace(/,/g, '')
    : sinSigno;
  if (/^\d+$/.test(numero)) {
    const n = Number(numero);
    return { tipo: 'monto', min: n, max: n + 1, maxExclusivo: true };
  }
  if (/^\d+\.\d{1,2}$/.test(numero)) {
    const n = Number(numero);
    return {
      tipo: 'monto',
      min: c2(n - 0.01),
      max: c2(n + 0.01),
      maxExclusivo: false,
    };
  }
  return { tipo: 'texto', texto: t };
}

/** Candidato tal como lo ordena el endpoint (lo mínimo que mira el orden). */
export interface CandidatoOrdenable {
  id: string;
  monto: number;
  faltante?: number | null;
  fecha?: string | null;
  cruzado?: boolean;
}

/**
 * ¿El gasto, por sí solo, cuadra con el cargo? (`|monto o faltante −
 * |cargo|| ≤ 1.00`, la tolerancia de siempre por gasto). Los cruzados (USD
 * contra cuenta MXN) no se comparan: sus montos son de otra moneda.
 */
export function cuadraConCargo(
  c: CandidatoOrdenable,
  montoCargo: number,
): boolean {
  if (c.cruzado === true) return false;
  return distanciaMonto(c, montoCargo) <= TOLERANCIA_CONCILIACION + 1e-9;
}

function distanciaMonto(c: CandidatoOrdenable, montoCargo: number): number {
  const cargo = Math.abs(c2(montoCargo));
  const porMonto = Math.abs(c2(Math.abs(Number(c.monto) || 0) - cargo));
  const porFaltante =
    c.faltante != null && Number.isFinite(Number(c.faltante))
      ? Math.abs(c2(Math.abs(Number(c.faltante)) - cargo))
      : Number.POSITIVE_INFINITY;
  return Math.min(porMonto, porFaltante);
}

/**
 * Orden por defecto del contrato: (1) los que CUADRAN con el cargo, (2)
 * cercanía de monto (contra el monto o el faltante), (3) cercanía de fecha,
 * (4) fecha más reciente primero; los cruzados (USD con TC implícito) al
 * final. Estable y determinista (último desempate: id).
 */
export function ordenarCandidatosGasto<T extends CandidatoOrdenable>(
  candidatos: readonly T[],
  ref: { montoCargo: number; fecha: string },
): T[] {
  const clave = (c: T) => {
    const cruzado = c.cruzado === true ? 1 : 0;
    const cuadra = cuadraConCargo(c, ref.montoCargo) ? 0 : 1;
    const dMonto = cruzado ? 0 : distanciaMonto(c, ref.montoCargo);
    const dFecha = c.fecha ? difDias(ref.fecha, c.fecha) : Infinity;
    return { cruzado, cuadra, dMonto, dFecha };
  };
  return [...candidatos]
    .map((c) => ({ c, k: clave(c) }))
    .sort((a, b) => {
      if (a.k.cruzado !== b.k.cruzado) return a.k.cruzado - b.k.cruzado;
      if (a.k.cuadra !== b.k.cuadra) return a.k.cuadra - b.k.cuadra;
      if (a.k.dMonto !== b.k.dMonto) return a.k.dMonto - b.k.dMonto;
      if (a.k.dFecha !== b.k.dFecha) return a.k.dFecha - b.k.dFecha;
      const fa = a.c.fecha ?? '';
      const fb = b.c.fecha ?? '';
      if (fa !== fb) return fa < fb ? 1 : -1;
      return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
    })
    .map((x) => x.c);
}

/** 500 legible: sin la moneda de la cuenta no se filtra divisa (jamás se adivina). */
export const MENSAJE_SIN_MONEDA_CUENTA =
  'No se pudo leer la moneda de la cuenta bancaria del cargo: vuelve a intentarlo en unos minutos.';
