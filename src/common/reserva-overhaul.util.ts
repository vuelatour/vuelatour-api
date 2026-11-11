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

// ===================================================================
// TARIFA CON VIGENCIA — «a partir de» (10-nov-2026, API 0.0.135,
// invariante 130)
// ===================================================================
//
// Pedido del cliente (10-nov-2026, con la captura del campo «Reserva
// overhaul USD/hr (por motor)» de la ficha): «que pudiéramos ponerle desde
// cuándo entra en vigor esa reserva de overhaul, porque nomás aparece el
// monto… que dijera ahí "a partir de" y la fecha a partir de cuándo quiere
// que afecte». La tarifa era UNA sola y se aplicaba EN VIVO a todo mes sin
// cierre formal: capturarla (o corregirla) movía septiembre y octubre, que
// ya se habían entregado a los socios sin reserva; la oficina llegó a poner
// 0.01 USD/hr para «apagarla» hacia atrás.
//
// Ahora la tarifa tiene HISTORIAL (`reserva_overhaul_vigencia`): cada fila
// dice desde qué día vale. Las horas de un vuelo generan reserva con la
// tarifa vigente el DÍA DEL VUELO (día Cancún de `fecha_vuelo`, el mismo eje
// con que las horas entran a un periodo); un vuelo anterior a la primera
// vigencia no genera reserva. Cambiar la tarifa «a partir de» una fecha ya
// no toca lo volado antes.

/** Migración que crea `reserva_overhaul_vigencia`. */
export const MIGRACION_RESERVA_VIGENCIA = '20261110000001';
export const TABLA_RESERVA_VIGENCIA = 'reserva_overhaul_vigencia';
export const COLS_RESERVA_VIGENCIA =
  'id, aeronave_id, vigente_desde, usd_hr_por_motor, motores, notas, historial, created_by, created_at, updated_by, updated_at';

/** Fila de `reserva_overhaul_vigencia` (lo que el cálculo necesita). */
export interface ReservaVigenciaRow {
  aeronave_id: string;
  /** `YYYY-MM-DD`: vale para vuelos con fecha (día Cancún) ≥ este día. */
  vigente_desde: string;
  usd_hr_por_motor: string | number | null;
  motores: string | number | null;
}

/**
 * Tarifa de la reserva YA normalizada, venga de la tabla con vigencias o de
 * la legada `reserva_overhaul` (sin la migración: una por avión, «desde
 * siempre»).
 */
export interface TarifaReservaVigente {
  aeronave_id: string;
  /** null = desde siempre (tabla legada, API sin la migración). */
  vigente_desde: string | null;
  /** Σ USD/hr de los motores del avión. */
  usd_por_hora: number;
  motores: number;
}

const numeroFinito = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Filas de `reserva_overhaul_vigencia` ⇒ tarifas (total = por motor × motores). */
export function tarifasDeVigencias(
  rows: ReadonlyArray<ReservaVigenciaRow>,
): TarifaReservaVigente[] {
  return rows.map((r) => {
    const motores = Math.max(1, Math.round(numeroFinito(r.motores)) || 1);
    return {
      aeronave_id: r.aeronave_id,
      vigente_desde: String(r.vigente_desde).slice(0, 10),
      usd_por_hora: round2(numeroFinito(r.usd_hr_por_motor) * motores),
      motores,
    };
  });
}

/**
 * Filas de la tabla LEGADA `reserva_overhaul` (una por motor) ⇒ UNA tarifa
 * por avión «desde siempre»: exactamente la aritmética de
 * `tarifaReservaOverhaul` (Σ de sus filas). Camino del API sin la migración.
 */
export function tarifasDeLegado(
  rows: ReadonlyArray<ReservaOverhaulRow>,
): TarifaReservaVigente[] {
  const ids = [...new Set(rows.map((r) => r.aeronave_id))];
  return ids.map((id) => {
    const t = tarifaReservaOverhaul(rows, id);
    return {
      aeronave_id: id,
      vigente_desde: null,
      usd_por_hora: t.usd_por_hora,
      motores: t.motores,
    };
  });
}

/**
 * La tarifa que vale un DÍA para un avión: la de mayor `vigente_desde` ≤
 * día (`null` = desde siempre, pierde contra cualquier fecha). null = ese
 * día todavía no hay reserva.
 */
export function tarifaReservaEnDia(
  tarifas: ReadonlyArray<TarifaReservaVigente>,
  aeronaveId: string,
  dia: string,
): TarifaReservaVigente | null {
  let mejor: TarifaReservaVigente | null = null;
  for (const t of tarifas) {
    if (t.aeronave_id !== aeronaveId) continue;
    if (t.vigente_desde != null && t.vigente_desde > dia) continue;
    if (
      mejor == null ||
      (mejor.vigente_desde ?? '') < (t.vigente_desde ?? '')
    ) {
      mejor = t;
    }
  }
  return mejor;
}

/** La parte del periodo que se voló con UNA tarifa. */
export interface TramoReservaOverhaul {
  /** Desde cuándo vale esta tarifa (null = desde siempre, tabla legada). */
  vigente_desde: string | null;
  /** Σ USD/hr de los motores. */
  usd_por_hora: number;
  motores: number;
  /** Horas voladas con esta tarifa (2 decimales). */
  horas_hr: number;
  /** `round2(horas_hr × usd_por_hora)`. */
  usd: number;
}

export interface ReservaOverhaulPeriodo {
  /** Reserva del periodo en USD = Σ de los tramos. */
  usd: number;
  /** Horas voladas del periodo (todas, con o sin tarifa; 2 decimales). */
  horas_hr: number;
  /** Un tramo por tarifa con horas, en orden de vigencia. */
  tramos: TramoReservaOverhaul[];
  /** Horas voladas en días SIN tarifa vigente (antes de la primera). */
  horas_sin_tarifa_hr: number;
  /**
   * Con horas sin tarifa: el día en que EMPIEZA la primera tarifa del avión
   * (null si el avión no tiene ninguna).
   */
  primera_vigencia: string | null;
  /**
   * La tarifa «del periodo» para los textos de UN renglón: la del último
   * tramo con horas; sin horas con tarifa, la vigente en `hasta` (0 si no
   * hay).
   */
  usd_por_hora: number;
  motores: number;
  /** Voló y el avión no tiene NINGUNA tarifa configurada. */
  incompleta: boolean;
  /**
   * El avión tiene tarifas CON FECHA («a partir de», tabla nueva): solo
   * entonces viajan los aditivos de la vigencia (tramos, horas sin tarifa);
   * con la legada el contrato es el de siempre.
   */
  con_vigencia: boolean;
}

/**
 * RESERVA DE OVERHAUL DEL PERIODO CON VIGENCIAS (invariante 130). Las horas
 * de cada día se multiplican por la tarifa vigente ESE día.
 *
 * Con UNA sola tarifa para todas las horas es, byte a byte, la cuenta de
 * siempre (`reservaOverhaulPeriodoUsd(horasTotal, tarifa)`): por eso recibe
 * `horasTotal` (el acumulado que ya sumaban el reparto y el balance) y lo
 * usa tal cual cuando no hay nada que partir — así un cambio en el orden de
 * la suma de flotantes no puede mover un centavo de lo ya publicado.
 */
export function reservaOverhaulDelPeriodo(e: {
  tarifas: ReadonlyArray<TarifaReservaVigente>;
  aeronaveId: string;
  /** Día Cancún del vuelo ⇒ horas voladas ese día por el avión. */
  horasPorDia: Iterable<readonly [string, number]>;
  /** Σ horas del periodo, como la suman el reparto y el balance. */
  horasTotal: number;
  /** Último día del periodo: la tarifa «vigente» que se informa sin horas. */
  hasta: string;
}): ReservaOverhaulPeriodo {
  const delAvion = e.tarifas.filter((t) => t.aeronave_id === e.aeronaveId);
  const horasTotal = round2(Number.isFinite(e.horasTotal) ? e.horasTotal : 0);
  // Horas por tarifa (clave = su `vigente_desde`; '' = desde siempre).
  const porTarifa = new Map<
    string,
    { tarifa: TarifaReservaVigente; horas: number }
  >();
  let sinTarifa = 0;
  for (const [dia, horas] of e.horasPorDia) {
    if (!Number.isFinite(horas) || horas <= 0) continue;
    const t = tarifaReservaEnDia(delAvion, e.aeronaveId, dia);
    if (!t) {
      sinTarifa += horas;
      continue;
    }
    const clave = t.vigente_desde ?? '';
    const acc = porTarifa.get(clave) ?? { tarifa: t, horas: 0 };
    acc.horas += horas;
    porTarifa.set(clave, acc);
  }
  const grupos = [...porTarifa.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => g);
  const sinTarifaR = round2(sinTarifa);
  // Nada que partir: TODAS las horas con una sola tarifa ⇒ la cuenta de
  // siempre sobre el acumulado de siempre.
  const unaSola = grupos.length === 1 && sinTarifaR === 0;
  const tramos: TramoReservaOverhaul[] = grupos.map((g) => {
    const horas = unaSola ? horasTotal : round2(g.horas);
    return {
      vigente_desde: g.tarifa.vigente_desde,
      usd_por_hora: g.tarifa.usd_por_hora,
      motores: g.tarifa.motores,
      horas_hr: horas,
      usd: reservaOverhaulPeriodoUsd(horas, g.tarifa.usd_por_hora),
    };
  });
  const usd = round2(tramos.reduce((acc, t) => acc + t.usd, 0));
  const ultimo = tramos.length ? tramos[tramos.length - 1] : null;
  const alCierre = tarifaReservaEnDia(delAvion, e.aeronaveId, e.hasta);
  const primera = delAvion
    .map((t) => t.vigente_desde)
    .filter((d): d is string => d != null)
    .sort()[0];
  return {
    usd,
    horas_hr: horasTotal,
    tramos,
    horas_sin_tarifa_hr: sinTarifaR,
    primera_vigencia: sinTarifaR > 0 ? (primera ?? null) : null,
    usd_por_hora: ultimo?.usd_por_hora ?? alCierre?.usd_por_hora ?? 0,
    motores: ultimo?.motores ?? alCierre?.motores ?? 0,
    // «Incompleta» = voló y el avión no tiene tarifa NINGUNA (ni antes ni
    // después): hay que capturarla. Volar antes del «a partir de» es
    // deliberado y NO es un pendiente.
    incompleta: horasTotal > 0 && delAvion.length === 0,
    con_vigencia: delAvion.some((t) => t.vigente_desde != null),
  };
}

// ===================================================================
// Las vigencias como las EDITA la oficina (ficha del avión)
// ===================================================================

/**
 * «Desde siempre»: la fecha de las tarifas que ya existían cuando se crearon
 * las vigencias (backfill de la migración) y de una tarifa guardada SIN «a
 * partir de» (panel anterior, alta de un avión). Anterior a cualquier vuelo
 * del sistema.
 */
export const RESERVA_DESDE_SIEMPRE = '2026-01-01';

/** Tope sensato de la tarifa por motor (el Kodiak lleva 400 USD/hr). */
export const RESERVA_TARIFA_MAX_USD_HR = 100_000;
export const RESERVA_MOTORES_MAX = 8;
export const RESERVA_NOTAS_MAX = 300;

export const MENSAJE_RESERVA_VIGENCIA_NO_DISPONIBLE =
  'La fecha «a partir de» de la reserva de overhaul todavía no está habilitada en la base de datos (falta aplicar una actualización). Mientras tanto la tarifa se guarda como siempre; vuelve a intentarlo en unos minutos o avisa a soporte.';
export const MENSAJE_RESERVA_FECHA_INVALIDA =
  'La fecha «a partir de» de la reserva de overhaul no es válida: captura un día real (DD/MM/AAAA).';
export const MENSAJE_RESERVA_TARIFA_INVALIDA =
  'La tarifa de la reserva de overhaul debe ser un número en dólares por hora (por motor), de 0 en adelante y con máximo 2 decimales.';
export const MENSAJE_RESERVA_MOTORES_INVALIDOS = `Los motores de la reserva de overhaul deben ser un número entero de 1 a ${RESERVA_MOTORES_MAX}.`;
export const MENSAJE_RESERVA_NOTAS_INVALIDAS = `Las notas de la tarifa son de máximo ${RESERVA_NOTAS_MAX} caracteres.`;
export const MENSAJE_RESERVA_VIGENCIA_NO_EXISTE =
  'Esa tarifa de la reserva de overhaul ya no existe (alguien la eliminó). Recarga la ficha del avión.';
export const MENSAJE_RESERVA_UNICA_TARIFA =
  'Es la única tarifa de reserva de overhaul de este avión: no se puede eliminar. Para dejarlo sin reserva captura la tarifa en 0, o cambia su fecha «a partir de».';

/** ¿`YYYY-MM-DD` de un día que existe? */
export function esDiaReal(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [a, m, d] = v.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  return (
    f.getUTCFullYear() === a &&
    f.getUTCMonth() === m - 1 &&
    f.getUTCDate() === d
  );
}

export type ErrorVigenciaReserva =
  | 'RESERVA_FECHA_INVALIDA'
  | 'RESERVA_TARIFA_INVALIDA'
  | 'RESERVA_MOTORES_INVALIDOS'
  | 'RESERVA_NOTAS_INVALIDAS';

/** Valida lo que se captura de UNA tarifa (regla pura; el service hace I/O). */
export function validarVigenciaReserva(v: {
  vigente_desde: unknown;
  usd_hr_por_motor: unknown;
  motores?: unknown;
  notas?: unknown;
}):
  | {
      ok: true;
      vigente_desde: string;
      usd_hr_por_motor: number;
      motores: number | null;
      notas: string | null;
    }
  | { ok: false; codigo: ErrorVigenciaReserva; mensaje: string } {
  if (!esDiaReal(v.vigente_desde)) {
    return {
      ok: false,
      codigo: 'RESERVA_FECHA_INVALIDA',
      mensaje: MENSAJE_RESERVA_FECHA_INVALIDA,
    };
  }
  const tarifa = v.usd_hr_por_motor;
  if (
    typeof tarifa !== 'number' ||
    !Number.isFinite(tarifa) ||
    tarifa < 0 ||
    tarifa > RESERVA_TARIFA_MAX_USD_HR ||
    Math.abs(Math.round(tarifa * 100) - tarifa * 100) > 1e-6
  ) {
    return {
      ok: false,
      codigo: 'RESERVA_TARIFA_INVALIDA',
      mensaje: MENSAJE_RESERVA_TARIFA_INVALIDA,
    };
  }
  let motores: number | null = null;
  if (v.motores != null) {
    if (
      typeof v.motores !== 'number' ||
      !Number.isInteger(v.motores) ||
      v.motores < 1 ||
      v.motores > RESERVA_MOTORES_MAX
    ) {
      return {
        ok: false,
        codigo: 'RESERVA_MOTORES_INVALIDOS',
        mensaje: MENSAJE_RESERVA_MOTORES_INVALIDOS,
      };
    }
    motores = v.motores;
  }
  const notas =
    typeof v.notas === 'string' && v.notas.trim() ? v.notas.trim() : null;
  if (notas != null && notas.length > RESERVA_NOTAS_MAX) {
    return {
      ok: false,
      codigo: 'RESERVA_NOTAS_INVALIDAS',
      mensaje: MENSAJE_RESERVA_NOTAS_INVALIDAS,
    };
  }
  return {
    ok: true,
    vigente_desde: v.vigente_desde,
    usd_hr_por_motor: round2(tarifa),
    motores,
    notas,
  };
}

/** Fila completa de `reserva_overhaul_vigencia`. */
export interface ReservaVigenciaFila extends ReservaVigenciaRow {
  id: string;
  notas: string | null;
  /**
   * Tarifas ANTERIORES de esta misma fecha (cada corrección agrega una):
   * `{usd_hr_por_motor, motores, notas, hasta, cambio_por}`. Solo auditoría.
   */
  historial?: unknown;
  created_by?: string | null;
  created_at?: string | null;
  updated_by?: string | null;
  updated_at?: string | null;
}

/** Una tarifa como la ve la ficha del avión. */
export interface VigenciaReserva {
  id: string;
  /** `YYYY-MM-DD`: vale para vuelos desde este día. */
  vigente_desde: string;
  usd_hr_por_motor: number;
  motores: number;
  /** Σ de los motores (lo que multiplican el balance y el reparto). */
  usd_por_hora: number;
  notas: string | null;
  updated_at: string | null;
  /** Es la que vale HOY (día Cancún). */
  vigente_hoy: boolean;
  /** Todavía no empieza (su «a partir de» es posterior a hoy). */
  futura: boolean;
}

/**
 * Las tarifas de UN avión para la ficha: la más reciente primero, con la que
 * vale hoy marcada.
 */
export function vigenciasParaFicha(
  filas: ReadonlyArray<ReservaVigenciaFila>,
  hoy: string,
): VigenciaReserva[] {
  const orden = [...filas].sort((a, b) =>
    String(b.vigente_desde).localeCompare(String(a.vigente_desde)),
  );
  const vigenteHoy = orden.find(
    (f) => String(f.vigente_desde).slice(0, 10) <= hoy,
  );
  return orden.map((f) => {
    const desde = String(f.vigente_desde).slice(0, 10);
    const motores = Math.max(1, Math.round(numeroFinito(f.motores)) || 1);
    const porMotor = round2(numeroFinito(f.usd_hr_por_motor));
    return {
      id: f.id,
      vigente_desde: desde,
      usd_hr_por_motor: porMotor,
      motores,
      usd_por_hora: round2(porMotor * motores),
      notas: f.notas ?? null,
      updated_at: f.updated_at ?? null,
      vigente_hoy: vigenteHoy != null && f.id === vigenteHoy.id,
      futura: desde > hoy,
    };
  });
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
