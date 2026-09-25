import {
  costoDeSalida,
  type MovCosto,
} from '../inventory/inventario-cardex.util';

/**
 * HOJA «refacciones» DEL BALANCE GENERAL — costo de cada salida de bodega
 * frente a su venta al avión (25-sep-2026, API 0.0.36). Cálculo PURO (con
 * spec), usado por `AircraftBalanceService#hojaRefacciones` y
 * `#llenarCostoVentaRefacciones`.
 *
 * Regla: el COSTO de la salida es el GUARDADO en su fila
 * (`costoDeSalida`, fuente única del inventario: último precio de compra
 * vigente el día de la salida). En pesos: MXN nativo tal cual; USD ⇒
 * round2(total_usd × tcFila), donde **tcFila = el MISMO T.C. con que la fila
 * convirtió la VENTA** (el `tc_gasto` de SU gasto, o el T.C. promedio del
 * libro si el gasto no lo trae). Así venta y costo de una fila usan un solo
 * T.C. y la GANANCIA de la hoja no depende de la migración de T.C. del
 * inventario (`20260925000003`, que solo toca `inventario_movimiento`):
 * antes el costo usaba `mov.tc_usd_mxn`, y ponerle el T.C. oficial a las 10
 * salidas del 01-sep (con sus gastos todavía en `tc_gasto` null ⇒ venta al
 * T.C. promedio) habría movido ≈ $250 MXN la ganancia de septiembre.
 */

/** Número positivo o null. */
function pos(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/** Mismo redondeo que el resto del balance (sin EPSILON: byte a byte el de siempre). */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Gasto de la hoja con lo que hace falta ligar a su fila. */
export interface GastoRefaccionLigable {
  fecha_gasto: string | null;
  inventario_movimiento_id?: string | null;
  tc_gasto: string | number | null;
}

/**
 * Adjunta a cada fila de la hoja (ya ordenada por `buildHoja`) el movimiento
 * de cardex y el `tc_gasto` de SU gasto. Mismo truco por índice que ya se
 * usaba para `inventario_movimiento_id`: `buildHoja` ordena con el MISMO
 * sort estable por `fecha_gasto`, así que el i-ésimo gasto ordenado es el de
 * la i-ésima fila (sin consulta nueva).
 */
export function adjuntarLigasRefacciones<F extends object>(
  filas: F[],
  gastos: GastoRefaccionLigable[],
): Array<
  F & { inventario_movimiento_id: string | null; tc_gasto: number | null }
> {
  const ordenados = [...gastos].sort((a, b) =>
    (a.fecha_gasto ?? '').localeCompare(b.fecha_gasto ?? ''),
  );
  return filas.map((f, i) => ({
    ...f,
    inventario_movimiento_id: ordenados[i]?.inventario_movimiento_id ?? null,
    tc_gasto: pos(ordenados[i]?.tc_gasto),
  }));
}

/**
 * Costo TOTAL en pesos de la salida (el de su fila). `tcFila` = el T.C. con
 * que la fila convirtió la venta. null = salida en USD sin ningún T.C. (la
 * celda queda vacía: jamás un número falso).
 */
export function costoTotalMxnDeSalida(
  mov: MovCosto & { cantidad: number | string },
  tcFila: number | null,
): number | null {
  const c = costoDeSalida(mov);
  if (c.moneda === 'MXN') return c.total;
  const tc = pos(tcFila);
  return tc != null ? round2(c.total_usd * tc) : null;
}

/**
 * Costo en pesos que le toca a UNA fila de la hoja:
 *  - salida a un avión: el costo total de la salida;
 *  - salida para TODA LA FLOTA (`para_flota`): el costo sigue la MISMA
 *    proporción del monto NATIVO de su gasto sobre la Σ de los gastos
 *    hermanos (Σ partes == costo de la salida); sin base ⇒ null.
 * `undefined` = no se puede expresar (sin T.C.): la fila no se toca.
 */
export function costoMxnDeFilaRefaccion(p: {
  mov: MovCosto & { cantidad: number | string; para_flota?: unknown };
  fila: {
    tc_gasto?: number | null;
    monto_original: number | null;
    monto_mxn: number | null;
  };
  tcPromedio: number | null;
  /** Σ monto NATIVO de todos los gastos ligados al movimiento (solo flota). */
  sumaMontoFlota?: number;
}): number | null | undefined {
  const tcFila = pos(p.fila.tc_gasto) ?? pos(p.tcPromedio);
  const total = costoTotalMxnDeSalida(p.mov, tcFila);
  if (total == null) return undefined;
  if (p.mov.para_flota === true) {
    const suma = p.sumaMontoFlota ?? 0;
    const nativo = p.fila.monto_original ?? p.fila.monto_mxn;
    return suma > 0 && nativo != null ? round2((total * nativo) / suma) : null;
  }
  return total;
}
