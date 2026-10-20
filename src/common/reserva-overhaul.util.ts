/**
 * RESERVA DE OVERHAUL DEL PERIODO — FUENTE ÚNICA (19-oct-2026, API 0.0.98,
 * invariante 96).
 *
 * La aportación del periodo para el overhaul de los motores del avión =
 * horas VOLADAS del periodo (tacómetro: llegada − salida de los tramos vivos
 * de los vuelos que volaron en el periodo) × Σ
 * `reserva_overhaul.monto_por_hora_usd` de sus motores (bimotor = 2 filas).
 * No es dinero retenido en ninguna cuenta ni un acumulado.
 *
 * Quién la usa, con ESTA misma aritmética:
 * - El reparto a socios (pantalla, PDF y Excel del reparto, tablero) la RESTA
 *   del saldo antes de repartir.
 * - El Balance por avión y el Balance general (desde el 0.0.98) solo la
 *   MUESTRAN como bloque informativo «lo que debe aportar el avión»: NO la
 *   restan de ninguna utilidad (decisión del cliente del 19-oct-2026).
 * Antes del 0.0.98 el reparto la multiplicaba inline y el balance no la
 * conocía.
 */

export interface ReservaOverhaulRow {
  aeronave_id: string;
  monto_por_hora_usd: string | number | null;
}

export interface TarifaReservaOverhaul {
  /** Σ USD/hr de los motores del avión (0 sin reserva configurada). */
  usd_por_hora: number;
  /** Cuántas filas (motores) componen la tarifa. */
  motores: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Tarifa por hora del avión: suma de sus motores (0 sin configuración). */
export function tarifaReservaOverhaul(
  reservas: ReadonlyArray<ReservaOverhaulRow>,
  aeronaveId: string,
): TarifaReservaOverhaul {
  const propias = reservas.filter((r) => r.aeronave_id === aeronaveId);
  const usdPorHora = propias.reduce((acc, r) => {
    const n = Number(r.monto_por_hora_usd);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
  return { usd_por_hora: usdPorHora, motores: propias.length };
}

/**
 * Reserva del periodo en USD: `round2(horas)` × tarifa, redondeada a
 * centavos — la MISMA cuenta del reparto de siempre (`horasPeriodo =
 * round2(Σ horas)`; `reservaR = round2(horasPeriodo × tarifa)`).
 */
export function reservaOverhaulPeriodoUsd(
  horasVoladas: number,
  usdPorHora: number,
): number {
  const horas = round2(Number.isFinite(horasVoladas) ? horasVoladas : 0);
  const tarifa = Number.isFinite(usdPorHora) ? usdPorHora : 0;
  return round2(horas * tarifa);
}

/**
 * Voló horas pero el avión no tiene tarifa de reserva configurada: la
 * aportación queda en $0.00 y las pantallas lo avisan (ficha del avión →
 * reserva de overhaul).
 */
export function reservaOverhaulIncompleta(
  horasVoladas: number,
  usdPorHora: number,
): boolean {
  return horasVoladas > 0 && !(usdPorHora > 0);
}
