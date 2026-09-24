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

// ================= Tramo de una REPOSICIÓN (24-sep-2026) =================
//
// Pedido del cliente: «en el apartado de caja chica, quiero ver si se puede
// al momento de reembolsar la caja de cada uno, me puede arrojar un Excel
// descargable con la información de lo que estoy reembolsando».
//
// Lo que una reposición REPONE = las entradas del libro entre la reposición
// ANTERIOR (exclusiva) y ésta (exclusiva), en el MISMO orden del historial
// (`historialConSaldo` → `compararEntradasCaja`: un gasto fechado el mismo
// día que la reposición va ANTES y entra en ella — la misma regla del
// candado `GASTO_EN_REPOSICION`). Los saldos NO se recalculan: se leen de
// las cifras que el historial ya trae por fila. Aquí solo se RE-SUMAN las
// filas que se listan (columna del Excel), nunca un saldo paralelo.

export interface EntradaTramoLike extends EntradaHistorialCaja {
  id: string;
  tipo: string;
}

export interface TramoReposicion<T extends EntradaTramoLike> {
  /** La reposición (null = lo PENDIENTE hoy, antes de registrarla). */
  reposicion: EntradaConSaldo<T> | null;
  /** Reposición anterior (null = es la primera del fondo). */
  anterior: EntradaConSaldo<T> | null;
  /** Entradas del periodo (gastos + otros movimientos), orden del libro. */
  entradas: EntradaConSaldo<T>[];
  /** Solo los gastos en efectivo del periodo. */
  gastos: EntradaConSaldo<T>[];
  /** Reintegros / ajustes (movimientos de caja que NO son reposición). */
  otros: EntradaConSaldo<T>[];
  /** Σ de los gastos del periodo (POSITIVO). */
  total_gastos: number;
  /** Σ con signo de los otros movimientos (reintegro −, ajuste ±). */
  total_otros: number;
  /** Saldo del libro al abrir el periodo (tras la reposición anterior). */
  saldo_inicio: number;
  /** Por reponer al abrir el periodo. */
  por_reponer_inicio: number;
  /** Saldo del libro justo ANTES de la reposición (o HOY si es pendiente). */
  saldo_antes: number;
  /** Por reponer justo ANTES de la reposición (o HOY si es pendiente). */
  por_reponer_antes: number;
  /** Saldo tras la reposición (null en pendiente). */
  saldo_despues: number | null;
  /** Por reponer tras la reposición (null en pendiente). */
  por_reponer_despues: number | null;
  /** Monto de la reposición (null en pendiente). */
  monto_repuesto: number | null;
  /**
   * Repuesto − por reponer antes: > 0 se repuso DE MÁS; < 0 quedó
   * PENDIENTE; 0 cuadra. null en pendiente.
   */
  diferencia: number | null;
  /** Fechas (YYYY-MM-DD) del primer y último GASTO del periodo. */
  periodo_desde: string | null;
  periodo_hasta: string | null;
}

/**
 * Tramo que cubre una reposición — o, con `reposicionId = null`, lo que
 * está PENDIENTE hoy (desde la última reposición hasta el final del libro:
 * lo que se va a reponer). `historial` es la salida de `historialConSaldo`
 * (ASC). `null` si el id no es una REPOSICIÓN del libro.
 */
export function tramoDeReposicion<T extends EntradaTramoLike>(
  historial: EntradaConSaldo<T>[],
  reposicionId: string | null,
): TramoReposicion<T> | null {
  const esReposicion = (e: EntradaConSaldo<T>) =>
    e.origen === 'caja' && e.tipo === TIPO_REPOSICION;
  let idx = historial.length;
  if (reposicionId !== null) {
    idx = historial.findIndex((e) => esReposicion(e) && e.id === reposicionId);
    if (idx < 0) return null;
  }
  let previo = -1;
  for (let i = idx - 1; i >= 0; i--) {
    if (esReposicion(historial[i])) {
      previo = i;
      break;
    }
  }
  const entradas = historial.slice(previo + 1, idx);
  const gastos = entradas.filter((e) => e.origen === 'gasto');
  const otros = entradas.filter((e) => e.origen === 'caja');
  const anterior = previo >= 0 ? historial[previo] : null;
  const ultimaAntes = idx > 0 ? historial[idx - 1] : null;
  const reposicion = reposicionId !== null ? historial[idx] : null;
  const porReponerAntes = ultimaAntes?.por_reponer ?? 0;
  const montoRepuesto = reposicion ? round2(reposicion.monto) : null;
  return {
    reposicion,
    anterior,
    entradas,
    gastos,
    otros,
    total_gastos: round2(gastos.reduce((s, e) => s - e.monto, 0)),
    total_otros: round2(otros.reduce((s, e) => s + e.monto, 0)),
    saldo_inicio: anterior?.saldo ?? 0,
    por_reponer_inicio: anterior?.por_reponer ?? 0,
    saldo_antes: ultimaAntes?.saldo ?? 0,
    por_reponer_antes: porReponerAntes,
    saldo_despues: reposicion ? reposicion.saldo : null,
    por_reponer_despues: reposicion ? reposicion.por_reponer : null,
    monto_repuesto: montoRepuesto,
    diferencia:
      montoRepuesto !== null ? round2(montoRepuesto - porReponerAntes) : null,
    periodo_desde: gastos[0]?.fecha ?? null,
    periodo_hasta: gastos[gastos.length - 1]?.fecha ?? null,
  };
}
