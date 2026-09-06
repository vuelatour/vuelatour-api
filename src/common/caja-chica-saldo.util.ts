/**
 * Saldo de caja chica — FUENTE ÚNICA (5-sep-2026).
 *
 * Todo lector del dinero de un fondo de caja chica (detalle del panel,
 * lista de fondos, `/caja-chica/me` de la app, el historial del piloto en
 * `/me/caja-chica/movimientos` y la alerta de caja en negativo) pasa por
 * estas funciones puras. Antes la fórmula vivía repetida en el servicio y en
 * `alerts.service` — un cambio en una y no en la otra daba saldos distintos
 * para el mismo fondo.
 *
 * Modelo: el fondo NO tiene columna de saldo. Se deriva de
 *   Σ efecto(movimiento de caja) − Σ gasto en EFECTIVO del dueño (misma moneda)
 * donde REPOSICION y AJUSTE conservan su signo y REINTEGRO resta.
 *  · Caja clásica: ese número es lo DISPONIBLE (negativo = sobregiro).
 *  · Caja ACUMULADA (`es_acumulada`, pedido 6-ago-2026): el mismo número con
 *    el signo invertido es lo POR REPONER — sube con cada gasto y la
 *    reposición lo regresa a cero.
 */

export type MovimientoCajaLike = { tipo: string; monto: number | string };
export type GastoCajaLike = { monto: number | string };

export const TIPO_REPOSICION = 'REPOSICION';
export const TIPO_REINTEGRO = 'REINTEGRO';
export const TIPO_AJUSTE = 'AJUSTE';
/** Tipo sintético de un gasto en efectivo dentro del historial unificado. */
export const TIPO_GASTO_CAJA = 'GASTO';

/** Etiqueta es-MX de cada tipo del historial (misma tabla que el panel). */
export const CONCEPTO_CAJA: Record<string, string> = {
  [TIPO_REPOSICION]: 'Reposición',
  [TIPO_REINTEGRO]: 'Reintegro a dirección',
  [TIPO_AJUSTE]: 'Ajuste',
  [TIPO_GASTO_CAJA]: 'Gasto en efectivo',
};

export function round2(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Efecto con signo de un movimiento de caja. AJUSTE conserva su signo. */
export function efectoMovimientoCaja(m: MovimientoCajaLike): number {
  const monto = Number(m.monto);
  return m.tipo === TIPO_REINTEGRO ? -monto : monto;
}

/**
 * Saldo del fondo. Clásico: lo entregado menos lo gastado. ACUMULADO: el
 * mismo cálculo con el signo invertido (= lo POR REPONER). Una sola fórmula
 * para que jamás diverjan.
 */
export function saldoCaja(
  movs: MovimientoCajaLike[],
  efectivo: GastoCajaLike[],
  esAcumulada = false,
): number {
  const movTotal = movs.reduce((s, m) => s + efectoMovimientoCaja(m), 0);
  const efectivoTotal = efectivo.reduce((s, g) => s + Number(g.monto), 0);
  const saldo = round2(movTotal - efectivoTotal);
  return esAcumulada ? round2(-saldo) : saldo;
}

export interface OpcionesFondoCaja {
  esAcumulada: boolean;
  /** Monto nominal del fondo (null/0 = sin nominal). */
  montoFondo: number | string | null | undefined;
}

/**
 * Lo POR REPONER (siempre ≥ 0) dado el saldo CRUDO del libro (Σ movimientos
 * con signo − Σ gastos, mismo signo que el historial del panel) y lo
 * entregado acumulado hasta ese punto:
 *  · Caja ACUMULADA: el libro va en negativo con cada gasto y la reposición
 *    lo regresa a 0 → por reponer = −saldo (0 si la reposición sobró).
 *  · Caja clásica CON monto nominal y con entregas ya registradas: fondo
 *    nominal − saldo (la card "Por reponer" del panel: a cuánto hay que
 *    volver a llenar el fondo).
 *  · Caja clásica sin nominal, o antes de la primera entrega (fondo nominal
 *    que la oficina nunca capturó como reposición — caso VISITANTE): solo lo
 *    que está en sobregiro (−saldo), que es lo que la persona puso de su
 *    bolsa. Sin esta regla, un gasto de $500 antes de la primera entrega
 *    de un fondo de $6,000 diría "por reponer $6,500".
 */
export function porReponerCaja(
  saldoCrudo: number,
  entregado: number,
  opts: OpcionesFondoCaja,
): number {
  const sobregiro = Math.max(0, round2(-saldoCrudo));
  if (opts.esAcumulada) return sobregiro;
  const nominal = Number(opts.montoFondo ?? 0);
  if (Number.isFinite(nominal) && nominal > 0 && entregado > 0) {
    return Math.max(0, round2(nominal - saldoCrudo));
  }
  return sobregiro;
}

export interface EntradaHistorialCaja {
  /** Fecha de pared YYYY-MM-DD (columnas `date`: día Cancún). */
  fecha: string;
  /** 'caja' = fila de caja_chica_movimiento; 'gasto' = gasto en EFECTIVO. */
  origen: 'caja' | 'gasto';
  /** Con signo: gasto negativo; reposición positiva; reintegro negativo. */
  monto: number;
  /** Desempate dentro del mismo día (ISO). */
  created_at: string;
}

export type EntradaConSaldo<T extends EntradaHistorialCaja> = T & {
  /** Saldo crudo del libro tras esta entrada (mismo signo que el panel). */
  saldo: number;
  /** Lo POR REPONER tras esta entrada (≥ 0; 0 tras una reposición completa). */
  por_reponer: number;
};

/**
 * Orden cronológico del libro: fecha asc; en el MISMO día los gastos van
 * ANTES que los movimientos de caja (una reposición fechada el día D salda
 * los gastos de ese día — es la misma regla del candado
 * `expenses.assertOwnEnVentana`: gasto con fecha ≤ última reposición ya
 * quedó repuesto); al final `created_at` asc.
 */
export function compararEntradasCaja(
  a: EntradaHistorialCaja,
  b: EntradaHistorialCaja,
): number {
  if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
  const ra = a.origen === 'gasto' ? 0 : 1;
  const rb = b.origen === 'gasto' ? 0 : 1;
  if (ra !== rb) return ra - rb;
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? -1 : 1;
}

/**
 * Historial con saldo corrido (ASCENDENTE): ordena el libro y calcula, tras
 * cada entrada, el saldo crudo (`saldo`, mismo signo que el panel) y lo por
 * reponer (`por_reponer`, positivo — la app lo pinta como el acumulado que
 * regresa a $0 en la reposición). El saldo SIEMPRE se calcula sobre el libro
 * completo: quien quiera una ventana de fechas recorta DESPUÉS.
 */
export function historialConSaldo<T extends EntradaHistorialCaja>(
  entries: T[],
  opts: OpcionesFondoCaja,
): EntradaConSaldo<T>[] {
  const orden = [...entries].sort(compararEntradasCaja);
  let corrido = 0;
  let entregado = 0;
  return orden.map((e) => {
    corrido = round2(corrido + e.monto);
    if (e.origen === 'caja') entregado = round2(entregado + e.monto);
    return {
      ...e,
      saldo: corrido,
      por_reponer: porReponerCaja(corrido, entregado, opts),
    };
  });
}

export interface LecturaFondoInput {
  /** Saldo según `saldoCaja` (ya invertido si la caja es acumulada). */
  saldo: number;
  /** Monto nominal del fondo (0 = sin nominal). */
  asignado: number;
  /** Σ efecto de los movimientos de caja. */
  entregadoTotal: number;
  /** Σ gastos en EFECTIVO (misma moneda). */
  gastadoTotal: number;
  esAcumulada: boolean;
}

/**
 * Lectura amable del fondo para la persona (pedido 29-ago: "que diga lo
 * usado, lo disponible y el total asignado", no un saldo en negativo).
 * Cálculo ADITIVO sobre el mismo saldo:
 *  · Con entregas registradas: disponible = saldo (entregado − gastado) y
 *    usado = asignado − saldo (= lo por reponer).
 *  · Fondo nominal sin entregas registradas (caso típico del VISITANTE: la
 *    oficina asignó $5,000 pero no capturó la entrega): el saldo sale en
 *    negativo (−gastado); para la persona el fondo SÍ existe → usado =
 *    gastado y disponible = asignado − gastado.
 *  · Caja ACUMULADA: usado = lo por reponer (= saldo) y disponible =
 *    asignado − usado.
 */
export function lecturaFondo(p: LecturaFondoInput): {
  usado: number;
  disponible: number;
} {
  if (p.esAcumulada) {
    const usado = Math.max(0, p.saldo);
    return {
      usado,
      disponible: p.asignado > 0 ? round2(p.asignado - usado) : 0,
    };
  }
  if (p.entregadoTotal > 0) {
    return {
      disponible: p.saldo,
      usado:
        p.asignado > 0
          ? Math.max(0, round2(p.asignado - p.saldo))
          : p.gastadoTotal,
    };
  }
  return {
    usado: p.gastadoTotal,
    disponible: p.asignado > 0 ? round2(p.asignado - p.gastadoTotal) : p.saldo,
  };
}
