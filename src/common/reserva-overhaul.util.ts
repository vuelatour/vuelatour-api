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
 * Quién la usa, con ESTA misma aritmética (LA RESERVA RESTA EN LA CASCADA,
 * ANTES DEL TOTAL, 9-nov-2026, API 0.0.129, invariante 125; pedido del
 * cliente: «que quede antes del total», como en su Excel manual y en el
 * Diseño Funcional §4.8):
 * - El reparto a socios: una resta más de la cascada (después de los fijos
 *   prorrateados, antes de otros ingresos): `saldo_disponible_*` ya la
 *   descontó; a cada socio se le retiene su parte (`reparto[].reserva_*`, a
 *   todos desde el 6-nov-2026, invariante 121).
 * - El Balance por avión y cada bloque del general: fila «(−) RESERVA DE
 *   OVERHAUL» después de «(−) PERMISOS»; UTILIDAD DESPUÉS DE GASTOS y
 *   UTILIDAD COBRADA ya la descuentan y los socios reciben su % de la
 *   cobrada.
 * - El tablero (Estadísticas) la cuenta en «Gastos»; su saldo es el del
 *   reparto.
 * El DISCRIMINADOR del contrato (panel y pyservices) es
 * `reserva_overhaul_en_cascada: true`.
 * Historia: antes del 0.0.98 el reparto la multiplicaba inline y el balance
 * no la conocía; del 19-oct al 6-nov-2026 fue «informativa» en el balance y
 * por socio opcional en el reparto (invariantes 96 y 99); del 7 al 9-nov
 * restó DESPUÉS de la utilidad cobrada / del saldo (`utilidad_a_repartir_*`,
 * `saldo_a_repartir_*`, invariante 124, retirada).
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

/**
 * RESERVA PARA TODOS LOS SOCIOS (6-nov-2026, API 0.0.125, invariante 121).
 * Decisión del cliente: «lo de overhaul ya se les va a apartar en las
 * utilidades a los socios, a TODOS los socios; antes estaba para poder
 * elegir si se les reservaba de las utilidades o solo se les informaba, pero
 * ya decidieron que a todos se les va a reservar». La bandera por socio
 * `aeronave_socio.descontar_reserva_overhaul` (invariante 99) deja de
 * decidir: el reparto, el balance por avión y la cuenta de cada socio le
 * DESCUENTAN su parte de la reserva a TODOS. La columna se conserva (la
 * migración 20261106000001 la deja en true y con default true) por si el
 * cliente vuelve a querer la opción: entonces basta poner esto en false.
 */
export const DESCONTAR_RESERVA_A_TODOS = true as boolean;

/** ¿Se le descuenta la reserva a este socio? (a todos desde el 6-nov-2026). */
export function descuentaReservaSocio(s: {
  descontar_reserva_overhaul?: boolean | null;
}): boolean {
  return DESCONTAR_RESERVA_A_TODOS || s.descontar_reserva_overhaul === true;
}
