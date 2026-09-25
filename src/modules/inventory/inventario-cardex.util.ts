import { TipoMovimientoInventario } from './dto/inventory.dto';

/**
 * CARDEX DE INVENTARIO — FUENTE ÚNICA (4-sep-2026; regla de costo del
 * 25-sep-2026, API 0.0.36).
 *
 * Aquí vive TODO el cálculo puro sobre `inventario_movimiento`: orden
 * cronológico, existencia, COSTO VIGENTE (último precio de compra), costo de
 * una salida, conversión a pesos con el T.C. de cada movimiento, venta y
 * utilidad, y los AGREGADOS que consumen la hoja "inventario" del Balance
 * general (`resumenTiendita`), el listado de ítems del panel, la ficha del
 * producto (bloques COMPRAS / VENTAS / RESUMEN por día) y el cardex formato
 * libro (Excel). Ninguno de ellos recalcula nada: consumen lo que sale de
 * aquí. Sin `this`, sin BD, sin fechas del sistema — `fecha_movimiento` ya es
 * día Cancún (la escribe el API con hoyCancun()) y «hoy» llega como argumento.
 *
 * REGLA DE COSTO (pedido del cliente 25-sep-2026: «que los precios se ajusten
 * en automático al último registrado … el remanente que teníamos de agosto
 * ahora igual su costo de 30 DLS»). Sustituye al FIFO en TODO el inventario:
 *  - El COSTO VIGENTE de un producto a una fecha es el precio unitario (con
 *    su moneda) de la ENTRADA con costo > 0 más reciente con fecha ≤ esa
 *    fecha (`costoVigenteEn`). DEVOLUCION, AJUSTE y entradas a $0 no lo
 *    cambian.
 *  - Una SALIDA toma el costo vigente de SU fecha y lo GUARDA en su fila al
 *    registrarse (`costo_unitario_usd` / `moneda` / `costo_unitario_mxn`).
 *    Todo lector lee ese costo de la fila (`costoDeSalida`): NINGUNA edición
 *    posterior de una entrada (Editar costo, recosteo de compra, compra con
 *    fecha atrasada, baja) mueve el costo de una salida ya cobrada.
 *  - El VALORIZADO = existencia × costo vigente de HOY (el remanente viejo se
 *    revalúa al precio nuevo) al T.C. oficial de hoy (`statsDe`).
 *
 * REGLA DE T.C. (mismo pedido: «que sea los mismos que usan en las
 * cotizaciones — tipo de cambio del día de la venta»): cada movimiento lleva
 * en `tc_usd_mxn` el T.C. oficial de SU día (lo sella el API al escribir con
 * `TipoCambioService.oficialDetallePara`, la misma función del cotizador).
 * Compras se convierten con el de la compra; la venta Y el costo de una
 * salida con el de la VENTA (el de la fila de la salida). Siempre se
 * convierte el TOTAL nativo redondeado: `total_mxn = round2(total × tc)`.
 * Un movimiento en dólares SIN T.C. (legado ≤ 0.0.35 mientras no se aplique
 * la migración de datos) conserva el respaldo de 0.0.35: su utilidad cuenta
 * en DÓLARES, aparte; jamás se suma un USD como MXN (invariante 8).
 *
 * TIENDA VUELATOUR (25-sep-2026): también viven aquí el PRECIO de una salida
 * (`precioVentaDeSalida`: precio capturado → precio del producto → último
 * precio + margen de la tienda), el MONTO del gasto BODEGA
 * (`montoGastoDeSalida`) y la UTILIDAD de una salida (`ventaDeSalida`).
 */

const SALIDA = TipoMovimientoInventario.SALIDA as string;
const ENTRADA = TipoMovimientoInventario.ENTRADA as string;
const DEVOLUCION = TipoMovimientoInventario.DEVOLUCION as string;
const AJUSTE = TipoMovimientoInventario.AJUSTE as string;

export const EPS = 1e-9;

export function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Regla de costo que anuncian TODAS las respuestas de inventario desde el API
 * 0.0.36 (`regla_costo`). Ausente = API previo (FIFO): el panel conserva sus
 * textos viejos.
 */
export const REGLA_COSTO = 'ULTIMO_PRECIO' as const;
export type ReglaCosto = typeof REGLA_COSTO;

export type Moneda = 'MXN' | 'USD';

/**
 * Movimiento mínimo del cardex (existencia, costo vigente, costo de una
 * salida). El nombre se conserva por compatibilidad con los imports.
 */
export type MovForFifo = {
  /** Presente cuando hace falta localizar un movimiento concreto. */
  id?: string;
  tipo: string;
  cantidad: number | string;
  costo_unitario_usd: number | string;
  moneda?: string | null;
  costo_unitario_mxn?: number | string | null;
  tc_usd_mxn?: number | string | null;
  fecha_movimiento: string;
  created_at: string;
};

/** Campos de costo de un movimiento (lo mínimo para expresarlo en pesos). */
export type MovCosto = Pick<
  MovForFifo,
  'costo_unitario_usd' | 'moneda' | 'costo_unitario_mxn' | 'tc_usd_mxn'
>;

/** Campos de VENTA de una salida. */
export type MovVenta = {
  cantidad: number | string;
  venta_unitaria?: number | string | null;
  venta_moneda?: string | null;
  tc_usd_mxn?: number | string | null;
};

/**
 * Movimiento del cardex con lo que necesitan los bloques y agregados. Los
 * joins (`aeronave`, `proveedor`) y `para_flota` son opcionales: sin ellos
 * las matrículas salen como '—' pero los NÚMEROS no cambian.
 */
export type MovCardex = MovForFifo & {
  item_id?: string;
  venta_unitaria?: number | string | null;
  venta_moneda?: string | null;
  para_flota?: boolean | null;
  aeronave_id?: string | null;
  proveedor_id?: string | null;
  referencia?: string | null;
  aeronave?: unknown;
  proveedor?: unknown;
};

/** T.C. positivo o null (un T.C. ausente, 0 o basura NO es un T.C.). */
function tcPositivo(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/** El movimiento se capturó en PESOS (criterio de siempre). */
function capturadoEnPesos(m: MovCosto): boolean {
  return m.moneda === 'MXN' && m.costo_unitario_mxn != null;
}

// ===== Textos es-MX del API (fuente única; el panel tiene los suyos) =====

const MESES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/**
 * 'YYYY-MM-DD' → '29 ago 2026'. Corta el string (jamás `new Date`: eso
 * restaría un día en Cancún). Un formato inesperado vuelve tal cual.
 */
export function fechaCardexEsMx(fecha: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha ?? '');
  if (!m) return fecha ?? '';
  const mes = MESES[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])} ${mes} ${m[1]}`;
}

/** 6633.32 → «$6,633.32». Determinista (sin `toLocaleString`, que depende del ICU). */
export function montoTxt(n: number): string {
  const s = Math.abs(n).toFixed(2);
  const [ent, dec] = s.split('.');
  const miles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '−' : ''}$${miles}.${dec}`;
}

/**
 * Precio unitario con su moneda: mínimo 2 decimales, máximo 4
 * («$26.5625 USD», «$21.25 USD», «$1,658.33 MXN»). Jamás 1 decimal.
 */
export function precioTxt(n: number, moneda: Moneda): string {
  const v = round(Number(n), 4);
  const cuatro = Math.abs(v).toFixed(4);
  const recortado = cuatro.replace(/0{1,2}$/, '');
  const [ent, dec] = recortado.split('.');
  const miles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '−' : ''}$${miles}.${dec} ${moneda}`;
}

export const TEXTOS_INVENTARIO = {
  /** 400 de «Editar costo» sobre algo que no es una ENTRADA. */
  soloEntrada:
    'Solo se corrige el costo de una ENTRADA: el de una salida es el que se cobró al avión, y las devoluciones/ajustes se corrigen con un movimiento nuevo.',
  /**
   * Aviso de una salida A COSTO registrada sin ninguna compra con costo. El
   * costo de la salida queda CONGELADO en su fila: completar después el
   * costo de la compra NO la cobra (revisión adversaria 25-sep-2026: el texto
   * anterior sugería que sí).
   */
  sinCostoVigente:
    'Este producto no tiene ninguna compra con costo: la salida se registró a costo $0 (sin cargo al avión). Captura el costo de la compra con «Editar costo»: aplica a las siguientes salidas; esta se queda sin cargo (para cobrarla, elimínala y vuelve a capturarla).',
  /**
   * Mismo caso, pero la salida SÍ llevó precio (capturado o del producto): el
   * avión pagó su precio de venta y, con costo $0, toda la venta cuenta como
   * utilidad. Decir «sin cargo al avión» ahí era falso.
   */
  sinCostoVigenteConVenta:
    'Este producto no tiene ninguna compra con costo: la salida se registró con costo $0 y al avión se le cobró su precio de venta, así que toda la venta cuenta como utilidad. Captura el costo de la compra con «Editar costo»: aplica a las siguientes salidas (esta conserva su costo $0).',
  /** Nota del cardex formato libro (Excel). */
  notaLibro:
    'Compras al T.C. oficial del día de la compra; ventas al del día de la venta. Costo = último precio de compra vigente ese día.',
  /** Descripción de una salida a costo en el libro. */
  aCostoLibro: ' · a costo (último precio)',
} as const;

/** 400 SALIDA_ANTES_DE_LA_COMPRA (§10). */
export function textoSalidaAntesDeLaCompra(
  fechaSalida: string,
  fechaPrimeraCompra: string,
): string {
  return `La salida es del ${fechaCardexEsMx(fechaSalida)} y la primera compra con costo de este producto es del ${fechaCardexEsMx(fechaPrimeraCompra)}: corrige la fecha de la salida o captura antes la compra.`;
}

/** 409 ENTRADA_CON_SALIDAS (§10): `n` salidas usaron el precio, `m` sin cargo. */
export function textoEntradaConSalidas(n: number, m: number): string {
  return `Este precio ya se usó en ${n} salida(s) (conservan su costo; ${m} sin cargo). Confirma para guardar el precio nuevo: aplica a la existencia y a las siguientes salidas.`;
}

/**
 * Etiqueta del gasto BODEGA según de dónde salió el precio («Salida de
 * bodega: 12 × Aceite… (último precio + 25 %)»).
 */
export function etiquetaCargoDeSalida(
  origen: OrigenVenta | null,
  margenPct: number | null,
): string {
  if (origen === 'MARGEN') return `último precio + ${margenPct ?? 0} %`;
  if (origen === 'PRECIO_CAPTURADO' || origen === 'PRECIO_PRODUCTO') {
    return 'precio de venta';
  }
  return 'a costo';
}

// ===== Pesos de un movimiento (criterio de captura) =====

/**
 * Costo unitario en PESOS de un movimiento — lo que el cliente VE:
 * capturado en MXN → costo_unitario_mxn; en USD con TC → usd × TC; sin TC →
 * el número USD tal cual con `pesosExactos: false`. Ese último caso NO es un
 * monto en pesos: todo lector que SUME pesos debe preguntar `costoSinTc`.
 * Lo usan el Excel del cardex y el detalle del ítem (dato por fila); los
 * TOTALES en pesos salen de `montosDeCompra` / `costoDeSalida` (convierten el
 * total nativo, no el unitario).
 */
export function costoUnitarioMxnDe(m: MovCosto): {
  mxn: number;
  /** El costo en pesos es REAL (compra en MXN, o USD con TC), no el USD copiado. */
  pesosExactos: boolean;
  /** El movimiento se capturó en pesos. */
  enMxn: boolean;
} {
  const usd = Number(m.costo_unitario_usd);
  const enMxn = capturadoEnPesos(m);
  const tc = tcPositivo(m.tc_usd_mxn);
  const mxn = enMxn
    ? Number(m.costo_unitario_mxn)
    : tc != null
      ? round(usd * tc, 2)
      : usd;
  return { mxn, pesosExactos: enMxn || tc != null, enMxn };
}

/**
 * El costo de este movimiento NO se puede expresar en pesos: se capturó en
 * USD sin tipo de cambio y es distinto de 0 (un $0 vale 0 en cualquier
 * moneda — las entradas "sin costo" de la carga masiva no son un caso de TC).
 */
export function costoSinTc(m: MovCosto): boolean {
  const c = costoUnitarioMxnDe(m);
  return !c.pesosExactos && Math.abs(c.mxn) > EPS;
}

/**
 * Total NATIVO → pesos. MXN: tal cual. USD: round2(total × tc). Sin T.C.:
 * null — salvo un total de $0, que vale 0 en cualquier moneda (mismo
 * criterio de `costoSinTc`).
 */
export function aMxn(
  total: number,
  moneda: Moneda,
  tc: number | string | null | undefined,
): number | null {
  if (moneda === 'MXN') return round(total, 2);
  const t = tcPositivo(tc);
  if (t == null) return Math.abs(total) <= EPS ? 0 : null;
  return round(total * t, 2);
}

/** Total NATIVO → dólares. USD: tal cual. MXN: round2(total / tc); sin T.C. ⇒ null (salvo $0). */
export function aUsd(
  total: number,
  moneda: Moneda,
  tc: number | string | null | undefined,
): number | null {
  if (moneda === 'USD') return round(total, 2);
  const t = tcPositivo(tc);
  if (t == null) return Math.abs(total) <= EPS ? 0 : null;
  return round(total / t, 2);
}

/** Montos de una ENTRADA/DEVOLUCION/AJUSTE (una compra, o algo que regresa). */
export interface MontosCompra {
  moneda: Moneda;
  /** Unitario tal cual se capturó (en `moneda`). */
  unitario: number;
  /** round2(cantidad × unitario), en `moneda`. */
  total: number;
  /** round2(cantidad × costo_unitario_usd): el USD interno. */
  total_usd: number;
  /** T.C. de la fila (capturado u oficial de su día); null = sin T.C. */
  tc: number | null;
  /** aMxn(total, moneda, tc): pesos del día de la compra; null = USD sin T.C. */
  total_mxn: number | null;
  /** round2(total_mxn / cantidad) — informativo; lo canónico es el TOTAL. */
  precio_unitario_mxn: number | null;
  /** Monto ≠ 0 sin pesos que pintar (USD sin T.C.). */
  sin_tc: boolean;
}

export function montosDeCompra(
  m: MovCosto & { cantidad: number | string },
): MontosCompra {
  const cant = Number(m.cantidad);
  const enMxn = capturadoEnPesos(m);
  const moneda: Moneda = enMxn ? 'MXN' : 'USD';
  const unitario =
    Number(enMxn ? m.costo_unitario_mxn : m.costo_unitario_usd) || 0;
  const total = round(cant * unitario, 2);
  const total_usd = round(cant * (Number(m.costo_unitario_usd) || 0), 2);
  const tc = tcPositivo(m.tc_usd_mxn);
  const total_mxn = aMxn(total, moneda, tc);
  return {
    moneda,
    unitario,
    total,
    total_usd,
    tc,
    total_mxn,
    precio_unitario_mxn:
      total_mxn != null && cant > 0 ? round(total_mxn / cant, 2) : null,
    sin_tc: total_mxn == null,
  };
}

// ===== Tienda VuelaTour: margen, precio y cargo de la salida (25-sep-2026) =====
//
// Pedido del cliente (25-sep-2026): «de los productos que compramos, el precio
// que le ponemos en el costo se le saca el 25 % el cual va a ser nuestra
// utilidad por producto vendido o cargado a un avión». El margen es SOBRE EL
// COSTO de la salida (desde el API 0.0.36, el ÚLTIMO PRECIO DE COMPRA vigente
// el día de la salida), configurable (`inventario_margen_venta_pct`, 25 %
// por default), y aplica a TODA salida a un avión (también «para toda la
// flota») que no traiga precio explícito. El precio capturado en la salida
// (> 0) y el `precio_venta` del ítem siguen ganando, y el 0 explícito sigue
// siendo «a costo». La utilidad de VuelaTour = venta − costo.

/** Margen de la tienda por default (% sobre el costo) — decisión del cliente 25-sep-2026. */
export const MARGEN_VENTA_PCT_DEFAULT = 25;

/**
 * Valor de la configuración → margen válido: número finito 0 ≤ x ≤ 100.
 * Cualquier otra cosa (null, NaN, texto, negativo, > 100) ⇒ el default 25:
 * una fila rota en la BD jamás deja al avión pagando un precio absurdo.
 */
export function margenVentaValido(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
    return MARGEN_VENTA_PCT_DEFAULT;
  }
  return v;
}

/**
 * Precio unitario con margen: round(costoUnitario × (1 + pct/100), 4). Con
 * costo ≤ 0 (entrada sin costo real) o margen ≤ 0 no hay venta: 0.
 */
export function ventaUnitariaConMargen(
  costoUnitario: number,
  margenPct: number,
): number {
  const costo = Number(costoUnitario);
  const pct = Number(margenPct);
  if (!(costo > 0) || !(pct > 0)) return 0;
  return round(costo * (1 + pct / 100), 4);
}

/** De dónde salió el precio que paga el avión en una SALIDA. */
export type OrigenVenta =
  | 'PRECIO_CAPTURADO'
  | 'PRECIO_PRODUCTO'
  | 'MARGEN'
  | 'A_COSTO';

/**
 * Precio que paga el avión por UNA unidad de la salida. Precedencia (la de
 * siempre + el margen al final):
 *  1. dtoVenta != null: > 0 ⇒ PRECIO_CAPTURADO (moneda: dtoMoneda, si no la
 *     del ítem); == 0 ⇒ A_COSTO («0 explícito = a costo»).
 *  2. itemPrecio > 0 ⇒ PRECIO_PRODUCTO (moneda del ítem).
 *  3. margenPct > 0 y costoUnitario > 0 ⇒ MARGEN, en `monedaSalida` (la
 *     MISMA moneda del costo de la salida: la de la compra vigente).
 *  4. si no ⇒ A_COSTO (sin venta).
 * Jamás cruza el precio de una fuente con la moneda de otra.
 */
export function precioVentaDeSalida(p: {
  dtoVenta?: number | null;
  dtoMoneda?: Moneda | null;
  itemPrecio?: number | string | null;
  itemMoneda?: Moneda | null;
  /** Costo unitario de la salida EN monedaSalida (el último precio de compra). */
  costoUnitario: number;
  monedaSalida: Moneda;
  margenPct: number;
}): {
  ventaUnitaria: number | null;
  ventaMoneda: Moneda | null;
  origen: OrigenVenta;
} {
  const aCosto = {
    ventaUnitaria: null,
    ventaMoneda: null,
    origen: 'A_COSTO' as const,
  };
  if (p.dtoVenta != null) {
    const v = Number(p.dtoVenta);
    if (!(v > 0)) return aCosto;
    return {
      ventaUnitaria: round(v, 4),
      ventaMoneda: p.dtoMoneda ?? (p.itemMoneda === 'USD' ? 'USD' : 'MXN'),
      origen: 'PRECIO_CAPTURADO',
    };
  }
  const precioItem = p.itemPrecio != null ? Number(p.itemPrecio) : NaN;
  if (precioItem > 0) {
    return {
      ventaUnitaria: round(precioItem, 4),
      ventaMoneda: p.itemMoneda === 'USD' ? 'USD' : 'MXN',
      origen: 'PRECIO_PRODUCTO',
    };
  }
  const conMargen = ventaUnitariaConMargen(p.costoUnitario, p.margenPct);
  if (conMargen > 0) {
    return {
      ventaUnitaria: conMargen,
      ventaMoneda: p.monedaSalida,
      origen: 'MARGEN',
    };
  }
  return aCosto;
}

/**
 * Monto/moneda del gasto de bodega que nace de una SALIDA — FUENTE ÚNICA del
 * monto/moneda/TC del cargo al avión (salida individual Y prorrateo de flota).
 *
 * CARGO A PRECIO DE VENTA (decisión del cliente 29-ago-2026): si la salida
 * lleva `venta_unitaria`, el avión paga venta_unitaria × cantidad en
 * `venta_moneda`. Sin venta: el COSTO guardado en la fila (en MXN cuando la
 * compra vigente fue en pesos, si no USD). `tc_gasto` = `mov.tc_usd_mxn`:
 * desde el API 0.0.36 el T.C. oficial del día de la VENTA (el mismo con que
 * la ficha convierte venta y costo); en las salidas ≤ 0.0.35, el TC
 * ponderado de las capas FIFO (o null si no traían).
 */
export function montoGastoDeSalida(mov: Record<string, unknown>): {
  monto: number;
  moneda: Moneda;
  tcGasto: number | null;
  /** true = el cargo salió del PRECIO DE VENTA (no del costo). */
  esVenta: boolean;
} {
  const cant = Number(mov.cantidad);
  const tcGasto = tcPositivo(mov.tc_usd_mxn);
  const venta = mov.venta_unitaria != null ? Number(mov.venta_unitaria) : null;
  if (venta != null && venta > 0) {
    return {
      monto: round(cant * venta, 2),
      moneda: mov.venta_moneda === 'USD' ? 'USD' : 'MXN',
      tcGasto,
      esVenta: true,
    };
  }
  const enMxn = mov.moneda === 'MXN' && mov.costo_unitario_mxn != null;
  const monto = round(
    cant * Number(enMxn ? mov.costo_unitario_mxn : mov.costo_unitario_usd),
    2,
  );
  return { monto, moneda: enMxn ? 'MXN' : 'USD', tcGasto, esVenta: false };
}

/** Campo de un join embebido de supabase (objeto o arreglo), o null. */
export function nombreDeJoin(raw: unknown, campo: string): string | null {
  const o = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  if (!o || typeof o !== 'object') return null;
  const v = (o as Record<string, unknown>)[campo];
  return typeof v === 'string' && v ? v : null;
}

/** Matrícula de la salida, 'FLOTA' (prorrateo) o '—'. */
function vendidoA(m: MovCardex): string {
  return m.para_flota === true
    ? 'FLOTA'
    : (nombreDeJoin(m.aeronave, 'matricula') ?? '—');
}

// ===== Orden y existencia =====

/**
 * Orden cronológico TOTAL: `fecha_movimiento` (día Cancún), luego
 * `created_at`, luego `id` (las consultas ya ordenan así).
 */
export function compararChrono(a: MovForFifo, b: MovForFifo): number {
  if (a.fecha_movimiento !== b.fecha_movimiento) {
    return a.fecha_movimiento < b.fecha_movimiento ? -1 : 1;
  }
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  const ia = a.id ?? '';
  const ib = b.id ?? '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Orden cronológico estable (copia; no muta la entrada). */
export function sortChrono<T extends MovForFifo>(movs: T[]): T[] {
  return [...movs].sort(compararChrono);
}

/**
 * Existencia = Σ ENTRADA/DEVOLUCION/AJUSTE − Σ SALIDA sobre TODO el cardex
 * (round 3 paso a paso, misma aritmética que `walkCardex`: un negativo se VE,
 * no se esconde en 0).
 */
export function existenciaDe(movs: MovForFifo[]): number {
  let stock = 0;
  for (const m of movs) {
    const cant = Number(m.cantidad);
    stock = round(m.tipo === SALIDA ? stock - cant : stock + cant);
  }
  return stock;
}

// ===== Costo vigente: ÚLTIMO PRECIO DE COMPRA =====

/** Último precio de compra (fila ENTRADA con costo > 0). */
export interface CostoVigente {
  movimiento_id: string | null;
  /** fecha_movimiento de la compra. */
  fecha: string;
  /** Moneda de la compra. */
  moneda: Moneda;
  /** En `moneda` (costo_unitario_mxn | costo_unitario_usd), tal cual (4 dec). */
  unitario: number;
  /** costo_unitario_usd (canónico interno). */
  unitario_usd: number;
  /** Pesos nativos si la compra fue en MXN; null si fue USD. */
  unitario_mxn: number | null;
  /** tc_usd_mxn de la compra (capturado u oficial). */
  tc_compra: number | null;
}

/** ¿Esta fila FIJA el precio? Solo una ENTRADA con costo > 0. */
export function fijaPrecio(m: MovForFifo): boolean {
  return m.tipo === ENTRADA && Number(m.costo_unitario_usd) > 0;
}

/** Costo vigente que fija una fila (se asume `fijaPrecio(m)`). */
export function costoVigenteDe(m: MovForFifo): CostoVigente {
  const enMxn = capturadoEnPesos(m);
  const usd = Number(m.costo_unitario_usd) || 0;
  const mxn = enMxn ? Number(m.costo_unitario_mxn) : null;
  return {
    movimiento_id: m.id ?? null,
    fecha: m.fecha_movimiento,
    moneda: enMxn ? 'MXN' : 'USD',
    unitario: enMxn ? (mxn as number) : usd,
    unitario_usd: usd,
    unitario_mxn: mxn,
    tc_compra: tcPositivo(m.tc_usd_mxn),
  };
}

/** La última fila (orden cronológico) que cumple `cuenta` y no pasa de `fecha`. */
function ultimaHasta(
  movs: MovForFifo[],
  fecha: string,
  cuenta: (m: MovForFifo) => boolean,
): MovForFifo | null {
  let mejor: MovForFifo | null = null;
  for (const m of movs) {
    if (!cuenta(m) || m.fecha_movimiento > fecha) continue;
    if (!mejor || compararChrono(m, mejor) > 0) mejor = m;
  }
  return mejor;
}

/**
 * Costo vigente al corte:
 *  - `{ fecha }`: la última fila que fija precio con `fecha_movimiento ≤
 *    fecha` (todas las del mismo día, sin importar la hora). Es el corte de
 *    una SALIDA NUEVA y el del valorizado (`fecha` = hoy Cancún).
 *  - `{ alRegistrar: S }`: lo que vio el API al escribir la salida S — solo
 *    las compras que YA existían (`created_at < S.created_at`), cortadas por
 *    la fecha de S. Es el corte para auditar una salida guardada (una compra
 *    capturada DESPUÉS con fecha atrasada no la afecta).
 *  - sin ninguna ⇒ null.
 */
export function costoVigenteEn(
  movs: MovForFifo[],
  corte: { fecha: string } | { alRegistrar: MovForFifo },
): CostoVigente | null {
  if ('alRegistrar' in corte) {
    const s = corte.alRegistrar;
    return costoVigenteEn(
      movs.filter((m) => m.created_at < s.created_at),
      { fecha: s.fecha_movimiento },
    );
  }
  const u = ultimaHasta(movs, corte.fecha, fijaPrecio);
  return u ? costoVigenteDe(u) : null;
}

/** Salida cuyo costo salió (o habría salido) de una ENTRADA. */
export interface SalidaDependiente {
  id: string;
  fecha: string;
  cantidad: number;
  /** El costo GUARDADO en la fila (lo que se cobró), en `moneda`. */
  costo_unitario: number;
  moneda: Moneda;
  /** La salida NO generó cargo al avión (monto 0: salió a $0 sin precio). */
  sin_cargo: boolean;
  /** Matrícula | 'FLOTA' | '—'. */
  vendido_a: string;
}

/**
 * SALIDAS cuyo costo salió (o habría salido) de la ENTRADA `entradaId`: S tal
 * que, TRATANDO a esa entrada como si fijara precio (aunque hoy esté a $0),
 * el corte «al registrar» de S la elige. Así también aparecen las salidas que
 * salieron a $0 SIN cargo porque la compra estaba sin costo (`sin_cargo`):
 * completar el costo de la compra NO las cobra.
 */
export function salidasQueDependenDe(
  movs: MovCardex[],
  entradaId: string,
): SalidaDependiente[] {
  const entrada = movs.find((m) => m.id === entradaId);
  if (!entrada || entrada.tipo !== ENTRADA) return [];
  const cuenta = (m: MovForFifo) => m.id === entradaId || fijaPrecio(m);
  const out: SalidaDependiente[] = [];
  for (const s of sortChrono(movs)) {
    if (s.tipo !== SALIDA || !s.id) continue;
    const previas = movs.filter((m) => m.created_at < s.created_at);
    const u = ultimaHasta(previas, s.fecha_movimiento, cuenta);
    if (u?.id !== entradaId) continue;
    const c = costoDeSalida(s);
    out.push({
      id: s.id,
      fecha: s.fecha_movimiento,
      cantidad: round(Number(s.cantidad)),
      costo_unitario: c.unitario,
      moneda: c.moneda,
      sin_cargo: montoGastoDeSalida(s).monto <= 0,
      vendido_a: vendidoA(s),
    });
  }
  return out;
}

// ===== Costo de UNA salida: el de SU FILA =====

export interface CostoSalida {
  /** MXN ⇔ moneda='MXN' y costo_unitario_mxn != null (la compra vigente fue en pesos). */
  moneda: Moneda;
  /** En `moneda`. */
  unitario: number;
  /** round2(cantidad × unitario) (= monto del gasto de una salida A COSTO). */
  total: number;
  /** round2(cantidad × costo_unitario_usd). */
  total_usd: number;
  /** tc_usd_mxn de la SALIDA: T.C. oficial del día de la venta (≤ 0.0.35: el ponderado de capas). */
  tc: number | null;
  /** MXN: total · USD: round2(total × tc) · USD sin T.C.: null (salvo $0). */
  total_mxn: number | null;
}

/**
 * Costo de una SALIDA = el GUARDADO en su fila al registrarla (D1-bis). No se
 * recalcula contra el cardex: lo que se cobró al avión no se mueve.
 */
export function costoDeSalida(
  m: MovCosto & { cantidad: number | string },
): CostoSalida {
  const cant = Number(m.cantidad);
  const enMxn = capturadoEnPesos(m);
  const moneda: Moneda = enMxn ? 'MXN' : 'USD';
  const unitario =
    Number(enMxn ? m.costo_unitario_mxn : m.costo_unitario_usd) || 0;
  const total = round(cant * unitario, 2);
  const tc = tcPositivo(m.tc_usd_mxn);
  return {
    moneda,
    unitario,
    total,
    total_usd: round(cant * (Number(m.costo_unitario_usd) || 0), 2),
    tc,
    total_mxn: aMxn(total, moneda, tc),
  };
}

// ===== Valorizado =====

export interface StatsInventario {
  /** existenciaDe(movs). */
  stock: number;
  /** costoVigenteEn(movs, { fecha: hoy }). */
  costo_vigente: CostoVigente | null;
  /** Unitario en pesos HOY: MXN nativo | round2(unitario_usd × tcHoy) | null sin tcHoy. */
  costo_vigente_mxn: number | null;
  tc_hoy: number | null;
  /** round2(max(0,stock) × unitario_usd) — USD interno (compat). */
  valor_usd: number;
  /** MXN: round2(max(0,stock) × unitario_mxn) · USD: round2(valor_usd × tcHoy) · USD sin tcHoy: 0. */
  valor_mxn: number;
  /** Solo si el vigente es USD y no hay tcHoy: valor_usd; si no 0 (compat, invariante 8). */
  valor_usd_sin_tc: number;
  /** valor_usd_sin_tc === 0 ⇒ `valor_mxn` es TODO el valorizado. */
  pesos_exactos: boolean;
  /** DEPRECADO (compat; nadie lo pinta): round2(unitario_usd) | 0. */
  costo_fifo_actual: number;
  /** DEPRECADO: costo_vigente_mxn ?? 0 — JAMÁS el USD en un campo «mxn». */
  costo_fifo_mxn_actual: number;
}

/**
 * Existencia y VALORIZADO a hoy: existencia × último precio de compra, al
 * T.C. oficial de HOY (el remanente viejo se revalúa al precio nuevo). Sin
 * costo vigente ⇒ valor 0; existencia ≤ 0 ⇒ valor 0. Los dos campos de
 * valor (`valor_mxn` pesos, `valor_usd_sin_tc` dólares) no se suman NUNCA.
 */
export function statsDe(
  movs: MovForFifo[],
  opts: { hoy: string; tcHoy: number | null },
): StatsInventario {
  const stock = existenciaDe(movs);
  const vig = costoVigenteEn(movs, { fecha: opts.hoy });
  const tcHoy = tcPositivo(opts.tcHoy);
  if (!vig) {
    return {
      stock,
      costo_vigente: null,
      costo_vigente_mxn: null,
      tc_hoy: tcHoy,
      valor_usd: 0,
      valor_mxn: 0,
      valor_usd_sin_tc: 0,
      pesos_exactos: true,
      costo_fifo_actual: 0,
      costo_fifo_mxn_actual: 0,
    };
  }
  const q = Math.max(0, stock);
  const valorUsd = round(q * vig.unitario_usd, 2);
  const enMxn = vig.moneda === 'MXN' && vig.unitario_mxn != null;
  const costoVigenteMxn = enMxn
    ? round(vig.unitario_mxn as number, 2)
    : tcHoy != null
      ? round(vig.unitario_usd * tcHoy, 2)
      : null;
  const valorMxn = enMxn
    ? round(q * (vig.unitario_mxn as number), 2)
    : tcHoy != null
      ? round(valorUsd * tcHoy, 2)
      : 0;
  const valorUsdSinTc = !enMxn && tcHoy == null ? valorUsd : 0;
  return {
    stock,
    costo_vigente: vig,
    costo_vigente_mxn: costoVigenteMxn,
    tc_hoy: tcHoy,
    valor_usd: valorUsd,
    valor_mxn: valorMxn,
    valor_usd_sin_tc: valorUsdSinTc,
    pesos_exactos: valorUsdSinTc === 0,
    costo_fifo_actual: round(vig.unitario_usd, 2),
    costo_fifo_mxn_actual: costoVigenteMxn ?? 0,
  };
}

// ===== Recorrido del cardex =====

export type PasoCardex = {
  stockDespues: number;
  /** SALIDA: costo en PESOS de la salida (`costoDeSalida.total_mxn`); null si no es salida o USD sin T.C. */
  costoMxn: number | null;
  /** SALIDA: costo en USD interno (`costoDeSalida.total_usd`); null si no es salida. */
  costoUsd: number | null;
  /** Un monto ≠ 0 del movimiento está en USD SIN tipo de cambio. */
  sinTc: boolean;
};

/**
 * Recorre el cardex en orden cronológico llevando el STOCK corriente y, por
 * cada SALIDA, su costo (el de la fila). Lo usan el resumen por día, los
 * bloques del libro y la ficha.
 */
export function walkCardex(movs: MovForFifo[]): Map<string, PasoCardex> {
  const out = new Map<string, PasoCardex>();
  let stock = 0;
  for (const m of sortChrono(movs)) {
    const cant = Number(m.cantidad);
    if (m.tipo === SALIDA) {
      stock = round(stock - cant);
      const c = costoDeSalida(m);
      if (m.id)
        out.set(m.id, {
          stockDespues: stock,
          costoMxn: c.total_mxn,
          costoUsd: c.total_usd,
          sinTc: c.total_mxn == null,
        });
    } else {
      stock = round(stock + cant);
      if (m.id)
        out.set(m.id, {
          stockDespues: stock,
          costoMxn: null,
          costoUsd: null,
          sinTc: montosDeCompra(m).sin_tc,
        });
    }
  }
  return out;
}

// ===== Venta y utilidad de UNA salida =====

/**
 * Venta y utilidad de UNA salida — la pieza con la que el listado, la ficha,
 * el resumen de la tienda y la hoja «inventario» del Balance general suman.
 * Una salida cuenta en PESOS (lo normal: venta y costo al T.C. del día de la
 * venta) o, en el RESPALDO de filas sin T.C., en DÓLARES — NUNCA en las dos.
 */
export interface VentaDeSalida {
  /** Llevó precio (> 0): es venta de la tienda. false = a costo. */
  conVenta: boolean;
  ventaMoneda: Moneda | null;
  ventaUnitaria: number | null;
  /** Nativo = round2(cant × venta_unitaria) = monto del gasto BODEGA. */
  ventaTotal: number | null;
  /** = costo.tc (T.C. del día de la venta). */
  tcVenta: number | null;
  costo: CostoSalida;
  /** aMxn(ventaTotal, ventaMoneda, tcVenta). */
  ventaTotalMxn: number | null;
  /** costo.total_mxn. */
  costoMxn: number | null;
  /** conVenta y ambos en pesos ⇒ round2(ventaTotalMxn − costoMxn). */
  gananciaMxn: number | null;
  /**
   * USD ORIGINAL (dato secundario de una utilidad que YA cuenta en pesos):
   * solo cuando venta Y costo son dólares nativos. No se mezcla el T.C. de la
   * compra con el de la venta.
   */
  ventaTotalUsdOriginal: number | null;
  costoUsdOriginal: number | null;
  gananciaUsdOriginal: number | null;
  /** 'MXN' si gananciaMxn != null; 'USD' en el respaldo sin T.C.; null otro. */
  monedaUtilidad: Moneda | null;
  /** SOLO respaldo sin T.C. (compat 0.0.35): venta USD − costo USD interno. */
  ventaTotalUsd: number | null;
  costoUsd: number | null;
  gananciaUsd: number | null;
  /** Con venta pero sin utilidad expresable (pesos sobre dólares sin T.C.). */
  utilidadIncompleta: boolean;
  /** Algún monto ≠ 0 de la salida no se puede expresar en pesos. */
  sinTc: boolean;
}

export function ventaDeSalida(mov: MovCosto & MovVenta): VentaDeSalida {
  const costo = costoDeSalida(mov);
  const cant = Number(mov.cantidad);
  const unit = mov.venta_unitaria != null ? Number(mov.venta_unitaria) : null;
  const conVenta = unit != null && unit > 0;
  const ventaMoneda: Moneda | null = conVenta
    ? mov.venta_moneda === 'USD'
      ? 'USD'
      : 'MXN'
    : null;
  // MISMO redondeo que montoGastoDeSalida: la venta ES el monto del gasto.
  const ventaTotal = conVenta ? round(cant * unit, 2) : null;
  const ventaTotalMxn =
    conVenta && ventaMoneda
      ? aMxn(ventaTotal as number, ventaMoneda, costo.tc)
      : null;
  const costoMxn = costo.total_mxn;
  const gananciaMxn =
    conVenta && ventaTotalMxn != null && costoMxn != null
      ? round(ventaTotalMxn - costoMxn, 2)
      : null;
  const ambosUsd = conVenta && ventaMoneda === 'USD' && costo.moneda === 'USD';
  const original = gananciaMxn != null && ambosUsd;
  // Respaldo 0.0.35 (filas sin T.C.): venta USD contra el costo USD interno.
  const respaldo = gananciaMxn == null && conVenta && ventaMoneda === 'USD';
  const sinTc = costoMxn == null || (conVenta && ventaTotalMxn == null);
  const monedaUtilidad: Moneda | null =
    gananciaMxn != null ? 'MXN' : respaldo ? 'USD' : null;
  return {
    conVenta,
    ventaMoneda,
    ventaUnitaria: conVenta ? round(unit, 4) : null,
    ventaTotal,
    tcVenta: costo.tc,
    costo,
    ventaTotalMxn,
    costoMxn,
    gananciaMxn,
    ventaTotalUsdOriginal: original ? ventaTotal : null,
    costoUsdOriginal: original ? costo.total : null,
    gananciaUsdOriginal: original
      ? round((ventaTotal as number) - costo.total, 2)
      : null,
    monedaUtilidad,
    ventaTotalUsd: respaldo ? ventaTotal : null,
    costoUsd: respaldo ? costo.total_usd : null,
    gananciaUsd: respaldo
      ? round((ventaTotal as number) - costo.total_usd, 2)
      : null,
    utilidadIncompleta: conVenta && monedaUtilidad == null,
    sinTc,
  };
}

/** Σ con null = «no hubo»: el primer número convierte el null en 0. */
function sumar(a: number | null, b: number | null | undefined): number | null {
  if (b == null) return a;
  return round((a ?? 0) + b, 2);
}

/** ¿Algún monto de este movimiento no se puede expresar en pesos? */
function movimientoSinTc(m: MovCardex): boolean {
  return m.tipo === SALIDA ? ventaDeSalida(m).sinTc : montosDeCompra(m).sin_tc;
}

// ===== Periodo =====

/** Predicado de corte sobre `fecha_movimiento` (YYYY-MM-DD, día Cancún). */
export type FiltroPeriodo = (m: MovForFifo) => boolean;

export const TODO_EL_CARDEX: FiltroPeriodo = () => true;

/**
 * Corte inclusivo desde/hasta sobre `fecha_movimiento` (string YYYY-MM-DD:
 * la comparación lexicográfica es la cronológica; jamás `new Date()`). Sin
 * ninguno de los dos → todo el cardex.
 */
export function filtroPeriodo(
  desde?: string | null,
  hasta?: string | null,
): FiltroPeriodo {
  if (!desde && !hasta) return TODO_EL_CARDEX;
  return (m) =>
    (!desde || m.fecha_movimiento >= desde) &&
    (!hasta || m.fecha_movimiento <= hasta);
}

// ===== Agregados por ítem =====

export interface AgregadosItem {
  /** Cantidad y costo (MXN, T.C. del día de la compra) de las ENTRADAs del
   *  periodo: compras reales. Una DEVOLUCION/AJUSTE regresa stock pero no es
   *  compra. null = sin compras. */
  compradas_cant: number | null;
  compradas_costo_mxn: number | null;
  /** Todas las SALIDAs del periodo (con o sin precio). null = sin salidas. */
  salidas_cant: number | null;
  /** Σ venta MXN de las SALIDAs CON precio (al T.C. del día de la venta). */
  ventas_mxn: number | null;
  /** Σ costo MXN de las salidas cuya utilidad cuenta en pesos. */
  costo_ventas_mxn: number | null;
  /** Σ utilidad MXN. null = ninguna salida con utilidad en pesos. */
  utilidad_mxn: number | null;
  /** Σ cantidad de las salidas CON venta del periodo (null = ninguna). */
  ventas_cant: number | null;
  /** RESPALDO sin T.C. (compat 0.0.35): Σ venta USD de las salidas cuya
   *  utilidad cuenta en dólares. null = ninguna (lo normal con T.C.). */
  ventas_usd: number | null;
  costo_ventas_usd: number | null;
  utilidad_usd: number | null;
  /** Salidas CON venta cuya utilidad no se puede expresar. 0 = ninguna. */
  ventas_sin_utilidad: number;
  /** Matrículas (o 'FLOTA') a las que se aplicó en el periodo, únicas. */
  matriculas: string[];
  /** Alguna ENTRADA del cardex COMPLETO quedó sin costo real ($0). */
  con_entradas_sin_costo: boolean;
  /** `movimientos_sin_tc > 0`. */
  con_movimientos_sin_tc: boolean;
  // --- ADITIVOS (API 0.0.36) ---
  /** Σ de las ventas USD-sobre-USD que YA cuentan en pesos (dato secundario). */
  ventas_usd_original: number | null;
  costo_ventas_usd_original: number | null;
  utilidad_usd_original: number | null;
  /** Σ costo MXN de las salidas SIN precio (lo cargado a costo). */
  ventas_a_costo_mxn: number | null;
  salidas_a_costo_cant: number | null;
  /** Filas del cardex COMPLETO con monto ≠ 0 no expresable en pesos. */
  movimientos_sin_tc: number;
}

/**
 * Agregación de UN ítem — la MISMA que alimenta la hoja "inventario" del
 * Balance general, la lista, la ficha y el resumen de la tienda (compras =
 * solo ENTRADA; vendido/utilidad = solo SALIDAs con precio; null cuando no
 * hubo ese tipo de actividad, nunca un 0 falso). `enPeriodo` solo acota qué
 * movimientos SUMAN; las banderas miran TODO el cardex.
 */
export function agregadosDeItem(
  movs: MovCardex[],
  enPeriodo: FiltroPeriodo = TODO_EL_CARDEX,
): AgregadosItem {
  let compradasCant = 0;
  let compradasCosto = 0;
  let salidasCant = 0;
  let hayCompra = false;
  let haySalida = false;
  let vendido: number | null = null;
  let costoVentas: number | null = null;
  let utilidad: number | null = null;
  let ventasCant: number | null = null;
  let vendidoUsd: number | null = null;
  let costoVentasUsd: number | null = null;
  let utilidadUsd: number | null = null;
  let vendidoUsdOrig: number | null = null;
  let costoUsdOrig: number | null = null;
  let utilidadUsdOrig: number | null = null;
  let aCostoMxn: number | null = null;
  let aCostoCant: number | null = null;
  let ventasSinUtilidad = 0;
  let sinCosto = false;
  let sinTc = 0;
  const matriculas = new Set<string>();
  for (const m of sortChrono(movs)) {
    if (m.tipo === ENTRADA && !(Number(m.costo_unitario_usd) > 0)) {
      sinCosto = true;
    }
    // Banderas sobre el cardex COMPLETO (como con_entradas_sin_costo).
    if (movimientoSinTc(m)) sinTc += 1;
    if (!enPeriodo(m)) continue;
    const cant = Number(m.cantidad);
    if (m.tipo === SALIDA) {
      const venta = ventaDeSalida(m);
      haySalida = true;
      salidasCant = round(salidasCant + cant);
      if (venta.conVenta) {
        ventasCant = round((ventasCant ?? 0) + cant);
        // Lo que cuenta en USD (respaldo) no va a pesos: una venta USD sin
        // T.C. no se expresa, y una venta en pesos sobre costo USD sin T.C.
        // SÍ suma a lo vendido (el dinero cobrado es real) sin costo ni
        // utilidad (incompleta).
        if (venta.monedaUtilidad !== 'USD') {
          vendido = sumar(vendido, venta.ventaTotalMxn);
        }
        if (venta.gananciaMxn != null) {
          costoVentas = sumar(costoVentas, venta.costoMxn);
          utilidad = sumar(utilidad, venta.gananciaMxn);
          vendidoUsdOrig = sumar(vendidoUsdOrig, venta.ventaTotalUsdOriginal);
          costoUsdOrig = sumar(costoUsdOrig, venta.costoUsdOriginal);
          utilidadUsdOrig = sumar(utilidadUsdOrig, venta.gananciaUsdOriginal);
        }
        if (venta.monedaUtilidad === 'USD') {
          vendidoUsd = sumar(vendidoUsd, venta.ventaTotalUsd);
          costoVentasUsd = sumar(costoVentasUsd, venta.costoUsd);
          utilidadUsd = sumar(utilidadUsd, venta.gananciaUsd);
        }
        if (venta.utilidadIncompleta) ventasSinUtilidad += 1;
      } else {
        aCostoCant = round((aCostoCant ?? 0) + cant);
        aCostoMxn = sumar(aCostoMxn, venta.costoMxn);
      }
      matriculas.add(vendidoA(m));
    } else if (m.tipo === ENTRADA) {
      hayCompra = true;
      compradasCant = round(compradasCant + cant);
      // Una entrada USD sin TC no tiene monto en pesos: se excluye y se avisa
      // (sumar el USD crudo daría un total de compras falso).
      const c = montosDeCompra(m);
      if (c.total_mxn != null) {
        compradasCosto = round(compradasCosto + c.total_mxn, 2);
      }
    }
  }
  return {
    compradas_cant: hayCompra ? compradasCant : null,
    compradas_costo_mxn: hayCompra ? compradasCosto : null,
    salidas_cant: haySalida ? salidasCant : null,
    ventas_mxn: vendido,
    costo_ventas_mxn: costoVentas,
    utilidad_mxn: utilidad,
    ventas_cant: ventasCant,
    ventas_usd: vendidoUsd,
    costo_ventas_usd: costoVentasUsd,
    utilidad_usd: utilidadUsd,
    ventas_sin_utilidad: ventasSinUtilidad,
    matriculas: [...matriculas],
    con_entradas_sin_costo: sinCosto,
    con_movimientos_sin_tc: sinTc > 0,
    ventas_usd_original: vendidoUsdOrig,
    costo_ventas_usd_original: costoUsdOrig,
    utilidad_usd_original: utilidadUsdOrig,
    ventas_a_costo_mxn: aCostoMxn,
    salidas_a_costo_cant: aCostoCant,
    movimientos_sin_tc: sinTc,
  };
}

// ===== Resumen por día =====

export interface ResumenDia {
  /** YYYY-MM-DD (día Cancún, tal cual `fecha_movimiento`). */
  fecha: string;
  /** Unidades que ENTRARON ese día (ENTRADA + DEVOLUCION + AJUSTE). */
  entradas_cant: number;
  /** Unidades que SALIERON ese día (todas las SALIDAs). */
  salidas_cant: number;
  /** Stock al CIERRE del día (después del último movimiento del día). */
  existencia_cierre: number;
  /** Σ venta MXN de las salidas con precio del día (null = no hubo). */
  ventas_mxn: number | null;
  costo_ventas_mxn: number | null;
  /** Σ utilidad MXN de las salidas con precio del día (null = no hubo). */
  utilidad_mxn: number | null;
  /** RESPALDO sin T.C.: Σ venta/costo/utilidad en DÓLARES del día. */
  ventas_usd: number | null;
  costo_ventas_usd: number | null;
  utilidad_usd: number | null;
  /** ADITIVO (0.0.36): utilidad USD-sobre-USD del día que ya cuenta en pesos. */
  utilidad_usd_original: number | null;
  /** Algún movimiento del día está en USD sin TC (montos afectados en null). */
  sin_tc: boolean;
}

/**
 * Bloque RESUMEN de la ficha del producto: una fila POR DÍA con movimiento
 * (orden cronológico), la existencia al cierre de ese día (stock corriente
 * de TODO el cardex aunque el periodo acote las filas) y la utilidad del día.
 */
export function resumenDiarioDe(
  movs: MovCardex[],
  enPeriodo: FiltroPeriodo = TODO_EL_CARDEX,
): ResumenDia[] {
  const walk = walkCardex(movs);
  const dias: ResumenDia[] = [];
  let dia: ResumenDia | null = null;
  // Stock corriente (walkCardex) — se arrastra a la fila del día siguiente.
  let existencia = 0;
  for (const m of sortChrono(movs)) {
    if (!enPeriodo(m)) continue;
    const fecha = String(m.fecha_movimiento);
    const paso = m.id ? walk.get(m.id) : undefined;
    if (paso) existencia = paso.stockDespues;
    if (dia == null || dia.fecha !== fecha) {
      dia = {
        fecha,
        entradas_cant: 0,
        salidas_cant: 0,
        existencia_cierre: existencia,
        ventas_mxn: null,
        costo_ventas_mxn: null,
        utilidad_mxn: null,
        ventas_usd: null,
        costo_ventas_usd: null,
        utilidad_usd: null,
        utilidad_usd_original: null,
        sin_tc: false,
      };
      dias.push(dia);
    }
    const cant = Number(m.cantidad);
    dia.existencia_cierre = existencia;
    if (m.tipo === SALIDA) {
      dia.salidas_cant = round(dia.salidas_cant + cant);
      const venta = ventaDeSalida(m);
      if (venta.sinTc) dia.sin_tc = true;
      if (!venta.conVenta) continue;
      // Misma regla que agregadosDeItem: lo que cuenta en USD no va a pesos.
      if (venta.monedaUtilidad !== 'USD') {
        dia.ventas_mxn = sumar(dia.ventas_mxn, venta.ventaTotalMxn);
      }
      if (venta.gananciaMxn != null) {
        dia.costo_ventas_mxn = sumar(dia.costo_ventas_mxn, venta.costoMxn);
        dia.utilidad_mxn = sumar(dia.utilidad_mxn, venta.gananciaMxn);
        dia.utilidad_usd_original = sumar(
          dia.utilidad_usd_original,
          venta.gananciaUsdOriginal,
        );
      }
      if (venta.monedaUtilidad === 'USD') {
        dia.ventas_usd = sumar(dia.ventas_usd, venta.ventaTotalUsd);
        dia.costo_ventas_usd = sumar(dia.costo_ventas_usd, venta.costoUsd);
        dia.utilidad_usd = sumar(dia.utilidad_usd, venta.gananciaUsd);
      }
    } else {
      dia.entradas_cant = round(dia.entradas_cant + cant);
      if (paso?.sinTc) dia.sin_tc = true;
    }
  }
  return dias;
}

// ===== Bloques COMPRAS / VENTAS (ficha del producto y cardex formato libro) =====

export interface BloqueCompra {
  movimiento_id: string | null;
  fecha: string;
  tipo: 'ENTRADA' | 'DEVOLUCION' | 'AJUSTE';
  cantidad: number;
  /** round2(total_mxn / cantidad); null si la captura fue USD sin TC. */
  precio_unitario_mxn: number | null;
  /** Total en pesos al T.C. del día de la compra; null = USD sin T.C. */
  total_mxn: number | null;
  moneda_captura: Moneda;
  /** El número tal cual se capturó (en `moneda_captura`). */
  costo_unitario_capturado: number;
  tc_usd_mxn: number | null;
  /** ENTRADA a $0 (carga masiva sin precio real). */
  sin_costo: boolean;
  /** Capturada en USD sin tipo de cambio: montos en pesos en null. */
  sin_tc: boolean;
  proveedor_nombre: string | null;
  /** DEVOLUCION/AJUSTE que regresa de un avión. */
  aeronave_matricula: string | null;
  referencia: string | null;
  /** Texto del libro: "[DEVOLUCIÓN — ]ítem · origen · ref …". */
  descripcion: string;
  stock_despues: number;
  // --- ADITIVOS (API 0.0.36) ---
  /** Unitario nativo (= costo_unitario_capturado). */
  precio_unitario: number;
  moneda: Moneda;
  /** round2(cantidad × precio_unitario), nativo. */
  total: number;
  total_usd: number;
  /** ENTRADA con costo > 0: fija el último precio de compra. */
  fija_precio: boolean;
  /** Esta fila ES el precio vigente hoy. */
  es_precio_vigente: boolean;
}

export interface BloqueVenta {
  movimiento_id: string | null;
  fecha: string;
  cantidad: number;
  /** round2(total_mxn / cantidad): precio de venta (o costo, si a costo) en pesos. */
  precio_unitario_mxn: number | null;
  /** Venta total en pesos (a costo: el costo en pesos). */
  total_mxn: number | null;
  venta_moneda: Moneda | null;
  venta_unitaria_capturada: number | null;
  /** true = salida SIN precio: el avión pagó el costo (ganancia 0, como el libro). */
  a_costo: boolean;
  /** Algún monto ≠ 0 de la salida no se puede expresar en pesos. */
  sin_tc: boolean;
  /** ALIAS de `costo_mxn` (se conserva un release; antes «costo FIFO»). */
  costo_fifo_mxn: number | null;
  ganancia_mxn: number | null;
  /** Total cobrado al avión EN `venta_moneda` (= monto del gasto BODEGA);
   *  null en una salida a costo. */
  venta_total: number | null;
  /** ALIAS del costo en USD interno (`costo.total_usd`). */
  costo_fifo_usd: number | null;
  /** Utilidad en dólares SOLO en el respaldo sin T.C. */
  ganancia_usd: number | null;
  /** En qué moneda cuenta la utilidad de ESTA salida (null = sin utilidad). */
  moneda_utilidad: Moneda | null;
  /** Con venta pero sin utilidad expresable (pesos sobre dólares sin T.C.). */
  utilidad_incompleta: boolean;
  /** Matrícula, 'FLOTA' (prorrateo a toda la flota) o '—'. */
  vendido_a: string;
  aeronave_id: string | null;
  para_flota: boolean;
  referencia: string | null;
  descripcion: string;
  /** Stock corriente DESPUÉS de la salida. */
  remanente: number;
  // --- ADITIVOS (API 0.0.36) ---
  /** Venta unitaria nativa; a costo: costo unitario nativo. */
  precio_unitario: number;
  /** Moneda de `precio_unitario` / `total`. */
  moneda: Moneda;
  /** Nativo: venta total, o el costo total si a costo. */
  total: number;
  /** T.C. oficial del día de la venta (el de la fila). */
  tc_venta: number | null;
  costo_unitario: number;
  costo_moneda: Moneda;
  costo_total: number;
  costo_mxn: number | null;
  venta_total_usd_original: number | null;
  costo_usd_original: number | null;
  ganancia_usd_original: number | null;
}

export interface TotalesBloques {
  compras_cant: number | null;
  compras_mxn: number | null;
  /** OJO: Σ de TODAS las salidas (con y sin precio), como el libro. */
  ventas_cant: number | null;
  /** Σ de las salidas CON precio (mismo número que el listado y el balance). */
  ventas_mxn: number | null;
  /** Σ (a costo) de las salidas SIN precio — informativo. */
  ventas_a_costo_mxn: number | null;
  costo_ventas_mxn: number | null;
  utilidad_mxn: number | null;
  /** RESPALDO sin T.C. (agregadosDeItem): aparte, jamás sumado a pesos. */
  ventas_usd: number | null;
  costo_ventas_usd: number | null;
  utilidad_usd: number | null;
  ventas_sin_utilidad: number;
  con_entradas_sin_costo: boolean;
  /** Algún movimiento del cardex está en USD sin TC. */
  con_movimientos_sin_tc: boolean;
  // --- ADITIVOS (API 0.0.36) ---
  ventas_usd_original: number | null;
  costo_ventas_usd_original: number | null;
  utilidad_usd_original: number | null;
  salidas_a_costo_cant: number | null;
  /** Unidades de las salidas CON precio (agregadosDeItem.ventas_cant). */
  unidades_vendidas: number | null;
  movimientos_sin_tc: number;
}

export interface BloquesCardex {
  compras: BloqueCompra[];
  ventas: BloqueVenta[];
  totales: TotalesBloques;
}

/**
 * Bloques COMPRAS | VENTAS del cardex de UN ítem — réplica del cuaderno del
 * cliente. Los consumen la ficha del producto en el panel y el Excel formato
 * libro: MISMA salida, dos presentaciones. Montos en PESOS (compras al T.C.
 * de su día, ventas al del día de la venta); salida SIN precio de venta = el
 * avión pagó el costo, así que el libro la registra "vendida al costo"
 * (ganancia 0). Los totales salen de agregadosDeItem (el mismo número del
 * listado y del balance). `hoy` marca el precio vigente (sin `hoy`: el último
 * de todos).
 */
export function bloquesCardexDe(
  itemNombre: string,
  movs: MovCardex[],
  enPeriodo: FiltroPeriodo = TODO_EL_CARDEX,
  opts: { hoy?: string } = {},
): BloquesCardex {
  const walk = walkCardex(movs);
  const vigente = costoVigenteEn(movs, { fecha: opts.hoy ?? '9999-12-31' });
  const compras: BloqueCompra[] = [];
  const ventas: BloqueVenta[] = [];
  for (const m of sortChrono(movs)) {
    if (!enPeriodo(m)) continue;
    const paso = m.id ? walk.get(m.id) : undefined;
    const cant = Number(m.cantidad);
    const referencia =
      typeof m.referencia === 'string' && m.referencia ? m.referencia : null;
    const ref = referencia ? ` · ref ${referencia}` : '';
    if (m.tipo === SALIDA) {
      const venta = ventaDeSalida(m);
      const c = venta.costo;
      // A costo = la salida NO llevó precio (no "no se pudo expresar en
      // pesos": una venta USD sin TC sigue siendo una venta, con sin_tc).
      const aCosto = !venta.conVenta;
      const total = aCosto ? c.total_mxn : venta.ventaTotalMxn;
      const unit = total != null && cant > 0 ? round(total / cant, 2) : null;
      const ganancia =
        venta.gananciaMxn ?? (aCosto && total != null ? 0 : null);
      const paraFlota = m.para_flota === true;
      const matricula = nombreDeJoin(m.aeronave, 'matricula');
      ventas.push({
        movimiento_id: m.id ?? null,
        fecha: String(m.fecha_movimiento ?? ''),
        cantidad: cant,
        precio_unitario_mxn: unit,
        total_mxn: total,
        venta_moneda: venta.ventaMoneda,
        venta_unitaria_capturada: aCosto ? null : Number(m.venta_unitaria),
        a_costo: aCosto,
        sin_tc: venta.sinTc,
        costo_fifo_mxn: c.total_mxn,
        ganancia_mxn: ganancia,
        venta_total: venta.ventaTotal,
        costo_fifo_usd: c.total_usd,
        ganancia_usd: venta.gananciaUsd,
        moneda_utilidad: venta.monedaUtilidad,
        utilidad_incompleta: venta.utilidadIncompleta,
        vendido_a: paraFlota ? 'FLOTA' : (matricula ?? '—'),
        aeronave_id: m.aeronave_id ?? null,
        para_flota: paraFlota,
        referencia,
        descripcion: `${itemNombre}${aCosto ? TEXTOS_INVENTARIO.aCostoLibro : ''}${venta.sinTc ? ' · sin TC' : ''}${ref}`,
        remanente: paso?.stockDespues ?? 0,
        precio_unitario: aCosto ? c.unitario : (venta.ventaUnitaria as number),
        moneda: aCosto ? c.moneda : (venta.ventaMoneda as Moneda),
        total: aCosto ? c.total : (venta.ventaTotal as number),
        tc_venta: venta.tcVenta,
        costo_unitario: c.unitario,
        costo_moneda: c.moneda,
        costo_total: c.total,
        costo_mxn: c.total_mxn,
        venta_total_usd_original: venta.ventaTotalUsdOriginal,
        costo_usd_original: venta.costoUsdOriginal,
        ganancia_usd_original: venta.gananciaUsdOriginal,
      });
    } else {
      // ENTRADA en su lugar natural; DEVOLUCION/AJUSTE también SUMAN stock
      // y van de este lado con su nota. USD sin TC: no hay pesos que pintar
      // (null + sin_tc), jamás el USD disfrazado de MXN.
      const c = montosDeCompra(m);
      const tipo: BloqueCompra['tipo'] =
        m.tipo === DEVOLUCION
          ? 'DEVOLUCION'
          : m.tipo === AJUSTE
            ? 'AJUSTE'
            : 'ENTRADA';
      const pref =
        tipo === 'DEVOLUCION'
          ? 'DEVOLUCIÓN — '
          : tipo === 'AJUSTE'
            ? 'AJUSTE — '
            : '';
      const proveedor = nombreDeJoin(m.proveedor, 'nombre');
      const matricula = nombreDeJoin(m.aeronave, 'matricula');
      const origen = proveedor ?? matricula;
      const fija = fijaPrecio(m);
      compras.push({
        movimiento_id: m.id ?? null,
        fecha: String(m.fecha_movimiento ?? ''),
        tipo,
        cantidad: cant,
        precio_unitario_mxn: c.precio_unitario_mxn,
        total_mxn: c.total_mxn,
        moneda_captura: c.moneda,
        costo_unitario_capturado: c.unitario,
        tc_usd_mxn: c.tc,
        sin_costo: tipo === 'ENTRADA' && !(Number(m.costo_unitario_usd) > 0),
        sin_tc: c.sin_tc,
        proveedor_nombre: proveedor,
        aeronave_matricula: matricula,
        referencia,
        descripcion: `${pref}${itemNombre}${origen ? ` · ${origen}` : ''}${c.sin_tc ? ' · sin TC' : ''}${ref}`,
        stock_despues: paso?.stockDespues ?? 0,
        precio_unitario: c.unitario,
        moneda: c.moneda,
        total: c.total,
        total_usd: c.total_usd,
        fija_precio: fija,
        es_precio_vigente:
          fija && m.id != null && vigente?.movimiento_id === m.id,
      });
    }
  }
  const a = agregadosDeItem(movs, enPeriodo);
  return {
    compras,
    ventas,
    totales: {
      compras_cant: a.compradas_cant,
      compras_mxn: a.compradas_costo_mxn,
      ventas_cant: a.salidas_cant,
      ventas_mxn: a.ventas_mxn,
      ventas_a_costo_mxn: a.ventas_a_costo_mxn,
      costo_ventas_mxn: a.costo_ventas_mxn,
      utilidad_mxn: a.utilidad_mxn,
      ventas_usd: a.ventas_usd,
      costo_ventas_usd: a.costo_ventas_usd,
      utilidad_usd: a.utilidad_usd,
      ventas_sin_utilidad: a.ventas_sin_utilidad,
      con_entradas_sin_costo: a.con_entradas_sin_costo,
      con_movimientos_sin_tc: a.con_movimientos_sin_tc,
      ventas_usd_original: a.ventas_usd_original,
      costo_ventas_usd_original: a.costo_ventas_usd_original,
      utilidad_usd_original: a.utilidad_usd_original,
      salidas_a_costo_cant: a.salidas_a_costo_cant,
      unidades_vendidas: a.ventas_cant,
      movimientos_sin_tc: a.movimientos_sin_tc,
    },
  };
}
