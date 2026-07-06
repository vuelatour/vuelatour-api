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
    if (!Number.isFinite(monto) || monto <= 0) continue;
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
