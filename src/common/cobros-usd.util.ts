/**
 * FUENTE ÚNICA de "cuánto se ha cobrado (en USD)" de un vuelo.
 *
 * Antes existían tres cálculos incompatibles (bandera `cobrado`, reporte por
 * vuelo y reparto de utilidades) y ninguno era fiable con multi-moneda: un
 * cobro en MXN sin TC se descartaba (vuelo pagado que nunca se marcaba
 * cobrado) o se sumaba crudo como si fuera USD (saldos absurdos). Todo el
 * sistema debe pasar por aquí.
 *
 * Reglas:
 * - USD → se suma tal cual.
 * - MXN → monto / tc (tc del cobro; si falta, `tcFallback` — normalmente el
 *   tc_cotizacion del vuelo).
 * - MXN sin ningún TC → NO se suma, pero se reporta en `sin_tc_mxn` para que
 *   el supervisor lo vea (nunca desaparece en silencio).
 * - Monto NEGATIVO = REEMBOLSO (29-ago-2026): RESTA con las mismas reglas de
 *   conversión (todos los lectores — bandera cobrado, reporte por vuelo,
 *   reparto, pre-cierre, balance — heredan la resta de aquí). Solo se
 *   descarta el 0 / no numérico.
 */

export interface CobroLike {
  monto?: unknown;
  moneda?: unknown;
  tc_usd_mxn?: unknown;
}

export interface CobrosUsd {
  /** Suma convertida a USD de todos los cobros convertibles. */
  total_usd: number;
  /** Número de cobros MXN que no se pudieron convertir (sin TC). */
  sin_tc_count: number;
  /** Monto MXN acumulado de esos cobros no convertibles. */
  sin_tc_mxn: number;
}

export function cobrosEnUsd(
  cobros: CobroLike[],
  tcFallback?: number | null,
): CobrosUsd {
  let total = 0;
  let sinTcCount = 0;
  let sinTcMxn = 0;
  const fallback =
    tcFallback != null && Number(tcFallback) > 0 ? Number(tcFallback) : null;
  for (const c of cobros) {
    const monto = Number(c.monto);
    // negativo = reembolso, RESTA (29-ago); solo se descarta 0 / no finito.
    if (!Number.isFinite(monto) || monto === 0) continue;
    if (c.moneda === 'USD') {
      total += monto;
      continue;
    }
    if (c.moneda === 'MXN') {
      const tc =
        c.tc_usd_mxn != null && Number(c.tc_usd_mxn) > 0
          ? Number(c.tc_usd_mxn)
          : fallback;
      if (tc) {
        total += monto / tc;
      } else {
        sinTcCount += 1;
        sinTcMxn += monto;
      }
    }
  }
  return {
    total_usd: Math.round(total * 100) / 100,
    sin_tc_count: sinTcCount,
    sin_tc_mxn: Math.round(sinTcMxn * 100) / 100,
  };
}

/**
 * USD de UN cobro con la MISMA regla y el MISMO respaldo de T.C. que
 * `cobrosEnUsd` (14-oct-2026, API 0.0.78, invariante 77): el
 * `cobros[i].monto_usd` del snapshot del vuelo y el `usd` de cada cobro de
 * «Cobrado de más». `null` = MXN que no convierte (sin T.C. propio ni de
 * respaldo): jamás 0 en falso ni el monto crudo como USD. Un reembolso
 * (negativo) da su USD negativo; un monto 0 / no numérico, 0.
 */
export function cobroEnUsd(
  c: CobroLike,
  tcFallback?: number | null,
): number | null {
  const conv = cobrosEnUsd([c], tcFallback);
  return conv.sin_tc_count > 0 ? null : conv.total_usd;
}

/**
 * ¿El reparto lee este CANCELADO? Lo cobrado y no reembolsado es venta del
 * avión (invariante 2): un cancelado RETIENE cobros si lo convertido a USD
 * es positivo o si quedan cobros MXN sin T.C. (positivos). Puro.
 *
 * FUENTE ÚNICA (13-oct-2026, invariante 61) que comparten: el salto del
 * cancelado sin cobros en el reparto a socios (`profit-sharing`), el
 * universo de la «Comisión del vendedor (avión)» (`comisiones-avion.util`,
 * `pagoVendedorAvionEnUniverso`) y la nota del Libro Dinero. Si dijeran
 * cosas distintas, el balance restaría un pago que el reparto no lee.
 */
export function retieneCobros(c: CobrosUsd): boolean {
  return c.total_usd > 0 || c.sin_tc_mxn > 0;
}
