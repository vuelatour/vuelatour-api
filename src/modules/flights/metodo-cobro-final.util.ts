/**
 * MÉTODO DE COBRO: PREVISTO vs REAL (11-sep-2026).
 *
 * - `vuelo.metodo_cobro` = lo PREVISTO al cotizar. Define el IVA del
 *   desglose canónico v1.3 y el candado de rol del piloto. NUNCA es la
 *   fuente de "cómo pagó el cliente".
 * - `cobro_vuelo.metodo_cobro` = lo que REALMENTE se recibió, cobro por
 *   cobro. Es la ÚNICA fuente para el recibo de pago, la conciliación y
 *   cualquier lectura de "con qué se pagó".
 *
 * «CÓMO SE COBRÓ AL FINAL» (pedido del cliente) se DERIVA de los cobros y
 * viaja como dato de solo lectura (`metodo_cobro_final` del snapshot):
 * **jamás se copia a `vuelo.metodo_cobro`** (revisión adversaria del
 * 11-sep-2026). Esa columna es un INSUMO DEL PRECIO: el cotizador rehidrata
 * su selector desde ella y `calculate()` deriva de ahí el IVA por default
 * (0 % en EFECTIVO/DOLARES/BILLPOCKET/PAYWISE/OTRO, 16 % en los bancarios
 * facturables) y la comisión BillPocket. Sellarla con el método REAL movía
 * el precio de la siguiente revisión — alcanzable en dos caminos vivos: una
 * cotización CANCELADA (revise sí las acepta) y un vuelo con todos sus
 * cobros reembolsados (neto 0). Además endurecía el candado del PILOTO
 * (invariante 9, que valida `vuelo.metodo_cobro`) y dejaba mintiendo a la
 * etiqueta «Previsto en la cotización» del panel.
 *
 * Puro: decide, no escribe.
 */

/**
 * Tolerancia de redondeo multi-moneda para dar un vuelo por LIQUIDADO —
 * misma regla que `refreshCobradoFlag`, el recibo de pago y el panel
 * (caso #131): hasta 1 USD de saldo es redondeo, no deuda.
 */
export const TOLERANCIA_LIQUIDACION_USD = 1;

export interface MetodoCobroFinalInput {
  /** Método del cobro que se acaba de registrar (`cobro_vuelo.metodo_cobro`). */
  metodoDelCobro?: string | null;
  /**
   * `vuelo.metodo_cobro` vigente (lo previsto al cotizar). Solo sirve para
   * responder "¿el final DIFIERE del previsto?"; nunca para escribirlo.
   */
  metodoVigente?: string | null;
  /** Cobrado NETO en USD tras este cobro (fuente única `cobrosEnUsd`). */
  cobradoUsd: number;
  /** Total cotizado del vuelo en USD (`vuelo.monto_total_usd`). */
  montoTotalUsd: number;
}

/** ¿El cobrado NETO cubre el total cotizado (con tolerancia)? */
export function vueloLiquidado(
  cobradoUsd: number,
  montoTotalUsd: number,
): boolean {
  if (!Number.isFinite(cobradoUsd) || !Number.isFinite(montoTotalUsd)) {
    return false;
  }
  // Vuelo sin precio ($0, interno, aún sin cotizar): jamás "liquidado"
  // (misma trampa del $0 que vigila refreshCobradoFlag).
  if (!(montoTotalUsd > 0)) return false;
  return cobradoUsd >= montoTotalUsd - TOLERANCIA_LIQUIDACION_USD;
}

/**
 * Método con el que se terminó de pagar, cuando DIFIERE del previsto: `null`
 * si el vuelo no liquida, no tiene precio, el cobro no trae método o es el
 * MISMO que el previsto (no hay nada que contar). Solo LECTURA — el
 * resultado nunca se escribe en `vuelo.metodo_cobro` (ver cabecera).
 */
export function metodoCobroFinal(input: MetodoCobroFinalInput): string | null {
  const metodo =
    typeof input.metodoDelCobro === 'string' && input.metodoDelCobro.trim()
      ? input.metodoDelCobro
      : null;
  if (!metodo) return null;
  if (!vueloLiquidado(input.cobradoUsd, input.montoTotalUsd)) return null;
  const vigente =
    typeof input.metodoVigente === 'string' && input.metodoVigente.trim()
      ? input.metodoVigente
      : null;
  return metodo === vigente ? null : metodo;
}

/** Cobro (`cobro_vuelo`) visto por este helper: monto, método y fecha. */
export interface CobroParaMetodoFinal {
  monto?: string | number | null;
  metodo_cobro?: string | null;
  fecha_cobro?: string | null;
  created_at?: string | null;
}

/**
 * MÉTODO CON EL QUE SE TERMINÓ DE PAGAR (derivado, solo lectura): el método
 * del ÚLTIMO abono POSITIVO por fecha cuando el vuelo quedó liquidado
 * (`cobradoUsd` por la fuente única `cobrosEnUsd` ≥ total − 1 USD). Los
 * reembolsos (monto < 0) no liquidan nada y quedan fuera; un vuelo en $0
 * nunca liquida. `null` = todavía no hay "final" que contar.
 *
 * Empates de fecha: gana el PRIMERO de la lista recibida (`listCobros` viene
 * en orden descendente, así que es el más reciente).
 */
export function metodoCobroQueLiquido(
  cobros: readonly CobroParaMetodoFinal[] | null | undefined,
  cobradoUsd: number,
  montoTotalUsd: number,
): string | null {
  if (!vueloLiquidado(cobradoUsd, montoTotalUsd)) return null;
  const positivos = (cobros ?? []).filter((c) => Number(c.monto) > 0);
  if (positivos.length === 0) return null;
  const ts = (c: CobroParaMetodoFinal) =>
    Date.parse(String(c.fecha_cobro ?? c.created_at ?? '')) || 0;
  let ultimo = positivos[0];
  for (const c of positivos) if (ts(c) > ts(ultimo)) ultimo = c;
  const metodo = ultimo.metodo_cobro;
  return typeof metodo === 'string' && metodo.trim() ? metodo : null;
}
