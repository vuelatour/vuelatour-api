import { TipoMovimientoInventario } from './dto/inventory.dto';

/**
 * FIFO del cardex de inventario — FUENTE ÚNICA (4-sep-2026).
 *
 * Aquí vive TODO el cálculo puro sobre `inventario_movimiento`: orden
 * cronológico, capas FIFO, stock/valorizado, costo FIFO por salida, venta y
 * ganancia en pesos, y los AGREGADOS que consumen la hoja "inventario" del
 * Balance general (`resumenTiendita`), el listado de ítems del panel
 * (ganancia / pérdida por producto), el detalle del producto (bloques
 * COMPRAS / VENTAS / RESUMEN por día) y el cardex formato libro (Excel).
 * Ninguno de ellos recalcula nada: consumen lo que sale de aquí. Sin `this`,
 * sin BD, sin fechas del sistema — `fecha_movimiento` ya es día Cancún
 * (la escribe el API con hoyCancun()).
 *
 * TIENDA VUELATOUR (25-sep-2026): también viven aquí el PRECIO de una salida
 * (`precioVentaDeSalida`: precio capturado → precio del producto → costo FIFO
 * + margen de la tienda), el MONTO del gasto BODEGA (`montoGastoDeSalida`) y
 * la UTILIDAD de una salida en UNA sola moneda (`ventaDeSalida`: pesos si se
 * puede, si no dólares sobre costo en dólares; jamás las dos sumadas).
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

/** Movimiento mínimo necesario para reconstruir el cardex FIFO. */
export type MovForFifo = {
  /** Presente cuando hace falta localizar una capa concreta (updateCostoEntrada). */
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

// cost = costo USD interno (reparto); costMxn = costo en pesos por unidad
// (para VER el valorizado en MXN, la moneda operativa del cliente).
export type FifoLayer = {
  qty: number;
  cost: number;
  costMxn: number;
  /** El costo en pesos es REAL (compra en MXN, o USD con TC) y no el USD copiado. */
  pesosExactos: boolean;
  /** La capa se COMPRÓ en pesos. */
  enMxn: boolean;
};

/** Campos de costo de un movimiento (lo mínimo para expresarlo en pesos). */
export type MovCosto = Pick<
  MovForFifo,
  'costo_unitario_usd' | 'moneda' | 'costo_unitario_mxn' | 'tc_usd_mxn'
>;

/** Campos de VENTA de una salida (lo mínimo para expresarla en pesos). */
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

/**
 * Costo unitario en PESOS de un movimiento — lo que el cliente VE (bodega se
 * maneja en MXN): capturado en MXN → costo_unitario_mxn; en USD con TC →
 * usd × TC; sin TC → el número USD tal cual con `pesosExactos: false` (la
 * captura en USD no exige TC). Ese último caso NO es un monto en pesos: todo
 * lector que SUME pesos debe preguntar `costoSinTc` y exponerlo en vez de
 * mezclar monedas (mismo principio que `cobrosEnUsd`/`sin_tc_*`). FUENTE
 * ÚNICA: la usan las capas FIFO (buildLayers), el Excel del cardex y el
 * detalle del ítem — no duplicar el criterio.
 */
export function costoUnitarioMxnDe(m: MovCosto): {
  mxn: number;
  /** El costo en pesos es REAL (compra en MXN, o USD con TC), no el USD copiado. */
  pesosExactos: boolean;
  /** La capa/movimiento se capturó en pesos. */
  enMxn: boolean;
} {
  const usd = Number(m.costo_unitario_usd);
  const enMxn = m.moneda === 'MXN' && m.costo_unitario_mxn != null;
  const conTc = m.tc_usd_mxn != null && Number(m.tc_usd_mxn) > 0;
  const mxn = enMxn
    ? Number(m.costo_unitario_mxn)
    : conTc
      ? round(usd * Number(m.tc_usd_mxn), 2)
      : usd;
  return { mxn, pesosExactos: enMxn || conTc, enMxn };
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
 * Venta en PESOS y ganancia de una SALIDA — criterio único (cardex formato
 * libro, detalle del ítem, listado y balance): venta MXN va tal cual; venta
 * USD se expresa en pesos con el TC ponderado FIFO de la salida
 * (mov.tc_usd_mxn). Ganancia = venta total MXN − costo FIFO MXN de las capas
 * consumidas. Sin venta (salida cargada a costo) venta y ganancia van null:
 * no hay ganancia que reportar.
 *
 * MONEDAS (4-sep-2026): una venta USD SIN TC no se puede expresar en pesos
 * → venta y ganancia null + `sinTc`; un costo FIFO que consumió capas USD
 * sin TC (`costoSinTc`, lo dice walkCardex) → ganancia null + `sinTc`. Se
 * EXPONE, jamás se suma un USD crudo como si fuera MXN.
 */
export function ventaYGananciaDe(
  mov: MovVenta,
  costoMxnFifo: number | null,
  costoSinTc = false,
): {
  ventaUnitMxn: number | null;
  ventaTotalMxn: number | null;
  gananciaMxn: number | null;
  /** La venta (USD sin TC) o el costo consumido no están en pesos reales. */
  sinTc: boolean;
} {
  const cant = Number(mov.cantidad);
  const venta = mov.venta_unitaria != null ? Number(mov.venta_unitaria) : null;
  if (venta == null || !(venta > 0)) {
    return {
      ventaUnitMxn: null,
      ventaTotalMxn: null,
      gananciaMxn: null,
      sinTc: costoSinTc,
    };
  }
  const tc = Number(mov.tc_usd_mxn);
  if (mov.venta_moneda === 'USD' && !(tc > 0)) {
    return {
      ventaUnitMxn: null,
      ventaTotalMxn: null,
      gananciaMxn: null,
      sinTc: true,
    };
  }
  const unit = mov.venta_moneda === 'USD' ? round(venta * tc, 2) : venta;
  const total = round(unit * cant, 2);
  return {
    ventaUnitMxn: round(unit, 2),
    ventaTotalMxn: total,
    gananciaMxn:
      costoMxnFifo != null && !costoSinTc
        ? round(total - costoMxnFifo, 2)
        : null,
    sinTc: costoSinTc,
  };
}

// ===== Tienda VuelaTour: margen, precio y cargo de la salida (25-sep-2026) =====
//
// Pedido del cliente (25-sep-2026): «de los productos que compramos, el precio
// que le ponemos en el costo se le saca el 25 % el cual va a ser nuestra
// utilidad por producto vendido o cargado a un avión». Decisión tomada: el
// margen es SOBRE EL COSTO FIFO, configurable (`inventario_margen_venta_pct`,
// 25 % por default), y aplica a TODA salida a un avión (también «para toda la
// flota») que no traiga precio explícito. El precio capturado en la salida
// (> 0) y el `precio_venta` del ítem siguen ganando, y el 0 explícito sigue
// siendo «a costo». La utilidad de VuelaTour = venta − costo FIFO.

/** Margen de la tienda por default (% sobre el costo FIFO) — decisión del cliente 25-sep-2026. */
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
 *     MISMA moneda del costo FIFO de la salida: MXN si todas las capas
 *     consumidas son pesos, si no USD — regla de createMovimiento).
 *  4. si no ⇒ A_COSTO (sin venta).
 * Jamás cruza el precio de una fuente con la moneda de otra.
 */
export function precioVentaDeSalida(p: {
  dtoVenta?: number | null;
  dtoMoneda?: 'MXN' | 'USD' | null;
  itemPrecio?: number | string | null;
  itemMoneda?: 'MXN' | 'USD' | null;
  /** Costo unitario de la salida EN monedaSalida (MXN: round4(mxn/cant); USD: round4(usd/cant)). */
  costoUnitario: number;
  monedaSalida: 'MXN' | 'USD';
  margenPct: number;
}): {
  ventaUnitaria: number | null;
  ventaMoneda: 'MXN' | 'USD' | null;
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
 * monto/moneda/TC del cargo al avión (salida individual Y prorrateo de flota;
 * vivía al pie de `inventory.service.ts` hasta el 25-sep-2026 y se movió aquí
 * para que `ventaDeSalida` y la migración de re-precio se atan al MISMO
 * número con un spec).
 *
 * CARGO A PRECIO DE VENTA (decisión del cliente 29-ago-2026): si la salida
 * lleva `venta_unitaria`, el avión paga venta_unitaria × cantidad en
 * `venta_moneda` (el costo FIFO queda SOLO para el inventario: capas,
 * valorizado y cardex no cambian). CRITERIO DE TC de la venta: `tc_gasto`
 * lleva el TC ponderado FIFO de las capas consumidas (mov.tc_usd_mxn) como
 * REFERENCIA — es el TC real de lo que costó la pieza y permite expresar el
 * gasto en la otra moneda para el reparto/balance; si las capas no traían TC,
 * queda null y los lectores aplican su respaldo de siempre (TC del día /
 * `vuelo.tc_usd_mxn`). Sin venta, NADA cambia: costo FIFO exacto como hoy
 * (en MXN cuando todas las capas consumidas se compraron en pesos, si no
 * USD; `tc_gasto` = TC ponderado de las capas). Desde el 25-sep-2026 casi
 * toda salida lleva venta (costo + margen de la tienda).
 */
export function montoGastoDeSalida(mov: Record<string, unknown>): {
  monto: number;
  moneda: 'MXN' | 'USD';
  tcGasto: number | null;
  /** true = el cargo salió del PRECIO DE VENTA (no del costo FIFO). */
  esVenta: boolean;
} {
  const cant = Number(mov.cantidad);
  const tc = Number(mov.tc_usd_mxn);
  const tcGasto = Number.isFinite(tc) && tc > 0 ? tc : null;
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

// ===== Cálculo FIFO =====

/** Orden cronológico estable: fecha_movimiento y, a igualdad, created_at. */
export function sortChrono<T extends MovForFifo>(movs: T[]): T[] {
  return [...movs].sort((a, b) => {
    if (a.fecha_movimiento !== b.fecha_movimiento)
      return a.fecha_movimiento < b.fecha_movimiento ? -1 : 1;
    return a.created_at < b.created_at
      ? -1
      : a.created_at > b.created_at
        ? 1
        : 0;
  });
}

/**
 * Reconstruye las capas FIFO restantes procesando los movimientos en orden.
 * ENTRADA/DEVOLUCION/AJUSTE agregan capa; SALIDA consume de las más antiguas.
 */
export function buildLayers(movs: MovForFifo[]): FifoLayer[] {
  const layers: FifoLayer[] = [];
  for (const m of sortChrono(movs)) {
    const cant = Number(m.cantidad);
    if (m.tipo === SALIDA) {
      let need = cant;
      while (need > EPS && layers.length > 0) {
        const layer = layers[0];
        const take = Math.min(need, layer.qty);
        layer.qty -= take;
        need -= take;
        if (layer.qty <= EPS) layers.shift();
      }
    } else {
      // Costo en pesos de la capa: criterio único (costoUnitarioMxnDe).
      const { mxn, pesosExactos, enMxn } = costoUnitarioMxnDe(m);
      layers.push({
        qty: cant,
        cost: Number(m.costo_unitario_usd),
        costMxn: mxn,
        pesosExactos,
        enMxn,
      });
    }
  }
  return layers;
}

/**
 * Existencia y VALORIZADO de las capas vivas.
 *
 * MONEDAS (22-sep-2026, invariante 8 — «jamás un USD sumado como MXN»):
 * `valor_mxn` suma SOLO las capas con pesos REALES (compra en MXN, o USD con
 * TC) y `valor_usd_sin_tc` las que se compraron en dólares SIN tipo de
 * cambio, en su moneda. Antes `valor_mxn` sumaba las dos y el resultado se
 * rotulaba «MXN»: 67 de las 68 ENTRADAS de producción son USD sin TC (la
 * carga VTF-INV-001 del 29-ago), así que la columna «VALOR A COSTO MXN» del
 * balance —y su total— eran dólares disfrazados de pesos (reporte del
 * cliente: «Aceite 15W-50, 30 piezas, $3,300.00 MXN» cuando eran 3,300 USD).
 * Un ítem MIXTO reparte su valor entre los dos campos; ninguno de los dos se
 * suma con el otro NUNCA.
 *
 * `pesos_exactos` = ninguna capa viva es USD sin TC (mismo criterio de
 * `costoSinTc`/`walkCardex`: un costo de $0 vale 0 en cualquier moneda y no
 * cuenta como «sin TC»), o sea: `valor_mxn` ya es TODO el valorizado.
 *
 * `valor_usd` NO cambió: es el USD interno del reparto sobre TODAS las capas
 * (≠ `valor_usd_sin_tc`, que es solo la parte no expresable en pesos).
 */
export function statsFromLayers(layers: FifoLayer[]): {
  stock: number;
  valor_usd: number;
  costo_fifo_actual: number;
  valor_mxn: number;
  /** Σ qty × costo USD de las capas vivas SIN pesos reales (0 = ninguna). */
  valor_usd_sin_tc: number;
  /** Ninguna capa viva es USD sin TC ⇒ `valor_mxn` es el valorizado COMPLETO. */
  pesos_exactos: boolean;
  costo_fifo_mxn_actual: number;
} {
  const stock = layers.reduce((s, l) => s + l.qty, 0);
  const valor_usd = layers.reduce((s, l) => s + l.qty * l.cost, 0);
  const valor_mxn = layers.reduce(
    (s, l) => (l.pesosExactos ? s + l.qty * l.costMxn : s),
    0,
  );
  // En una capa sin pesos exactos `cost` y `costMxn` son EL MISMO número
  // (costoUnitarioMxnDe copia el USD); se usa `cost`, que es el canónico.
  const valor_usd_sin_tc = layers.reduce(
    (s, l) => (l.pesosExactos ? s : s + l.qty * l.cost),
    0,
  );
  return {
    stock: round(stock),
    valor_usd: round(valor_usd, 2),
    costo_fifo_actual: round(layers[0]?.cost ?? 0, 2),
    valor_mxn: round(valor_mxn, 2),
    valor_usd_sin_tc: round(valor_usd_sin_tc, 2),
    pesos_exactos: !layers.some(
      (l) => !l.pesosExactos && Math.abs(l.qty * l.costMxn) > EPS,
    ),
    costo_fifo_mxn_actual: round(layers[0]?.costMxn ?? 0, 2),
  };
}

export type PasoCardex = {
  stockDespues: number;
  /** SALIDA: costo FIFO en PESOS de las capas consumidas; null si no es
   *  salida o si alguna capa consumida no está en pesos reales (sinTc). */
  costoMxnFifo: number | null;
  /**
   * SALIDA: costo FIFO en USD (la moneda CANÓNICA interna del cardex) de las
   * capas consumidas; null si no es salida. A diferencia de `costoMxnFifo`,
   * SIEMPRE trae número en una salida — también cuando las capas son USD sin
   * TC. Sin él, dos costos distintos (una capa de $46 y una de $9,541, ambas
   * USD sin TC) se ven IGUALES desde los pesos, porque los dos salen `null`;
   * eso dejaba pasar bajas de cardex que sí movían el costo (21-sep-2026).
   */
  costoUsdFifo: number | null;
  /** Un monto ≠ 0 de este paso está en USD SIN tipo de cambio (la capa
   *  propia en ENTRADA/DEVOLUCION/AJUSTE; alguna consumida en SALIDA): no hay
   *  cómo expresarlo en pesos. Se EXPONE, jamás se suma el USD como MXN. */
  sinTc: boolean;
};

/**
 * Recorre el cardex en orden cronológico llevando el STOCK corriente y, por
 * cada SALIDA, el costo FIFO en PESOS de las capas que consumió (mismo
 * criterio de buildLayers/costoUnitarioMxnDe — no inventa otro FIFO, lo
 * reproduce paso a paso para poder reportarlo POR MOVIMIENTO). Lo usan el
 * cardex formato libro, la ganancia por salida del detalle del ítem y los
 * agregados (listado, balance, resumen por día).
 */
export function walkCardex(movs: MovForFifo[]): Map<string, PasoCardex> {
  const out = new Map<string, PasoCardex>();
  const layers: FifoLayer[] = [];
  let stock = 0;
  for (const m of sortChrono(movs)) {
    const cant = Number(m.cantidad);
    if (m.tipo === SALIDA) {
      let need = cant;
      let mxn = 0;
      let usd = 0;
      let sinTc = false;
      while (need > EPS && layers.length > 0) {
        const layer = layers[0];
        const take = Math.min(need, layer.qty);
        mxn += take * layer.costMxn;
        usd += take * layer.cost;
        // Una capa USD sin TC con monto ≠ 0 contaminaría la suma en pesos.
        if (!layer.pesosExactos && Math.abs(take * layer.costMxn) > EPS) {
          sinTc = true;
        }
        layer.qty -= take;
        need -= take;
        if (layer.qty <= EPS) layers.shift();
      }
      stock = round(stock - cant);
      if (m.id)
        out.set(m.id, {
          stockDespues: stock,
          costoMxnFifo: sinTc ? null : round(mxn, 2),
          costoUsdFifo: round(usd, 2),
          sinTc,
        });
    } else {
      const { mxn, pesosExactos, enMxn } = costoUnitarioMxnDe(m);
      layers.push({
        qty: cant,
        cost: Number(m.costo_unitario_usd),
        costMxn: mxn,
        pesosExactos,
        enMxn,
      });
      stock = round(stock + cant);
      if (m.id)
        out.set(m.id, {
          stockDespues: stock,
          costoMxnFifo: null,
          costoUsdFifo: null,
          sinTc: !pesosExactos && Math.abs(mxn) > EPS,
        });
    }
  }
  return out;
}

// ===== Utilidad de UNA salida, en UNA sola moneda (25-sep-2026) =====

/**
 * Venta y utilidad de UNA salida — la pieza con la que el listado, el
 * detalle, el resumen de la tienda y la hoja «inventario» del Balance
 * general suman la utilidad. Una salida cuenta en PESOS o en DÓLARES, NUNCA
 * en las dos (`monedaUtilidad`).
 */
export interface VentaDeSalida {
  /** Llevó precio (> 0): es venta de la tienda. false = a costo. */
  conVenta: boolean;
  ventaMoneda: 'MXN' | 'USD' | null;
  /** Total cobrado al avión en su moneda = round2(cant × venta_unitaria) = monto del gasto BODEGA. */
  ventaTotal: number | null;
  // --- pesos (criterio de siempre: ventaYGananciaDe, SIN cambios) ---
  ventaUnitMxn: number | null;
  ventaTotalMxn: number | null;
  gananciaMxn: number | null;
  /** Costo FIFO en pesos de la salida cuando `gananciaMxn` existe. */
  costoMxn: number | null;
  // --- dólares ---
  ventaTotalUsd: number | null;
  /** Costo FIFO en USD de las capas consumidas (walkCardex.costoUsdFifo). */
  costoUsd: number | null;
  /** round2(ventaTotalUsd − costoUsd). */
  gananciaUsd: number | null;
  /** En qué moneda cuenta ESTA salida para la utilidad (nunca en las dos). */
  monedaUtilidad: 'MXN' | 'USD' | null;
  /** Salida CON venta cuya utilidad no se puede expresar (venta en pesos sobre costo en USD sin T.C.). */
  utilidadIncompleta: boolean;
  /** Igual que siempre (pesos): venta USD sin TC o capas USD sin TC. */
  sinTc: boolean;
}

/**
 * Utilidad de UNA salida. ADITIVA sobre `ventaYGananciaDe` — ninguna salida
 * que hoy da utilidad en pesos cambia:
 *  1. Si la utilidad se puede expresar en PESOS reales (criterio de siempre)
 *     ⇒ cuenta en MXN.
 *  2. Si no, y la venta es en USD y el costo FIFO en USD existe (siempre en
 *     una salida: las capas en pesos ya viven en USD con el T.C. de SU
 *     compra) ⇒ cuenta en USD: venta USD − costo USD, dinero real de las dos
 *     partes, sin tipo de cambio de por medio. Es el caso de la carga
 *     VTF-INV-001 (dólares sin T.C.), que hasta el 25-sep-2026 salía «—».
 *  3. Si no ⇒ sin utilidad; con venta, `utilidadIncompleta` (venta en pesos
 *     sobre capas en dólares sin T.C.: no hay cómo restarlas).
 */
export function ventaDeSalida(
  mov: MovVenta,
  paso: PasoCardex | undefined,
): VentaDeSalida {
  const costoMxnFifo = paso?.costoMxnFifo ?? null;
  const base = ventaYGananciaDe(mov, costoMxnFifo, paso?.sinTc === true);
  const cant = Number(mov.cantidad);
  const unit = mov.venta_unitaria != null ? Number(mov.venta_unitaria) : null;
  const conVenta = unit != null && unit > 0;
  const ventaMoneda: 'MXN' | 'USD' | null = conVenta
    ? mov.venta_moneda === 'USD'
      ? 'USD'
      : 'MXN'
    : null;
  // MISMO redondeo que montoGastoDeSalida: la venta ES el monto del gasto.
  const ventaTotal = conVenta ? round(cant * unit, 2) : null;
  const comun = {
    conVenta,
    ventaMoneda,
    ventaTotal,
    ventaUnitMxn: base.ventaUnitMxn,
    ventaTotalMxn: base.ventaTotalMxn,
    gananciaMxn: base.gananciaMxn,
    sinTc: base.sinTc,
  };
  if (base.gananciaMxn != null) {
    return {
      ...comun,
      costoMxn: costoMxnFifo,
      ventaTotalUsd: null,
      costoUsd: null,
      gananciaUsd: null,
      monedaUtilidad: 'MXN',
      utilidadIncompleta: false,
    };
  }
  const costoUsd = paso?.costoUsdFifo ?? null;
  if (conVenta && ventaMoneda === 'USD' && costoUsd != null) {
    const totalUsd = ventaTotal as number;
    return {
      ...comun,
      costoMxn: null,
      ventaTotalUsd: totalUsd,
      costoUsd,
      gananciaUsd: round(totalUsd - costoUsd, 2),
      monedaUtilidad: 'USD',
      utilidadIncompleta: false,
    };
  }
  return {
    ...comun,
    costoMxn: null,
    ventaTotalUsd: null,
    costoUsd: null,
    gananciaUsd: null,
    monedaUtilidad: null,
    utilidadIncompleta: conVenta,
  };
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
  /** Cantidad y costo (MXN) de las ENTRADAs del periodo: compras reales. Una
   *  DEVOLUCION/AJUSTE regresa stock pero no es compra. null = sin compras. */
  compradas_cant: number | null;
  compradas_costo_mxn: number | null;
  /** Todas las SALIDAs del periodo (con o sin precio). null = sin salidas. */
  salidas_cant: number | null;
  /** Σ venta MXN de las SALIDAs CON precio (lo cargado a los aviones). */
  ventas_mxn: number | null;
  /** Σ costo FIFO MXN de esas mismas salidas (las que llevaron precio). */
  costo_ventas_mxn: number | null;
  /** ventas_mxn − costo_ventas_mxn. null = ninguna salida con precio. */
  utilidad_mxn: number | null;
  /** Σ cantidad de las salidas CON venta del periodo (null = ninguna). */
  ventas_cant: number | null;
  /** Σ venta en DÓLARES de las salidas cuya utilidad cuenta en USD
   *  (`ventaDeSalida.monedaUtilidad === 'USD'`). null = ninguna. Jamás se
   *  suma con `ventas_mxn`. */
  ventas_usd: number | null;
  /** Σ costo FIFO en USD de esas mismas salidas. */
  costo_ventas_usd: number | null;
  /** ventas_usd − costo_ventas_usd (Σ de `gananciaUsd`). */
  utilidad_usd: number | null;
  /** Salidas CON venta cuya utilidad no se puede expresar en ninguna moneda
   *  (venta en pesos sobre capas USD sin T.C.). 0 = ninguna. */
  ventas_sin_utilidad: number;
  /** Matrículas (o 'FLOTA') a las que se aplicó en el periodo, únicas, en
   *  orden de aparición. */
  matriculas: string[];
  /** Alguna ENTRADA del cardex COMPLETO quedó sin costo real ($0): su capa
   *  valoriza en cero y la utilidad de lo que salió de ella está inflada. */
  con_entradas_sin_costo: boolean;
  /** Algún movimiento del cardex COMPLETO no se puede expresar en pesos
   *  (USD sin tipo de cambio): compras, ventas y utilidad afectadas van
   *  null/excluidas en vez de sumar USD como MXN. El VALORIZADO de las capas
   *  vivas se reparte aparte (`statsFromLayers.valor_usd_sin_tc`): esta
   *  bandera mira TODO el cardex (incluidas capas ya consumidas), así que un
   *  ítem puede traerla en true con el valorizado 100 % en pesos. */
  con_movimientos_sin_tc: boolean;
}

/**
 * Agregación de UN ítem — la MISMA que alimenta la hoja "inventario" del
 * Balance general (compras = solo ENTRADA; vendido/utilidad = solo SALIDAs
 * con precio; null cuando no hubo ese tipo de actividad, nunca un 0 falso).
 * El FIFO corre SIEMPRE sobre todo el cardex (una salida de hoy consume
 * capas de meses atrás); `enPeriodo` solo acota qué movimientos SUMAN.
 */
export function agregadosDeItem(
  movs: MovCardex[],
  enPeriodo: FiltroPeriodo = TODO_EL_CARDEX,
): AgregadosItem {
  const walk = walkCardex(movs);
  let compradasCant = 0;
  let compradasCosto = 0;
  let salidasCant = 0;
  let hayCompra = false;
  let haySalida = false;
  let vendido: number | null = null;
  let costoVentas: number | null = null;
  let utilidad: number | null = null;
  // Tienda (25-sep-2026): unidades vendidas y la utilidad en DÓLARES, aparte.
  let ventasCant: number | null = null;
  let vendidoUsd: number | null = null;
  let costoVentasUsd: number | null = null;
  let utilidadUsd: number | null = null;
  let ventasSinUtilidad = 0;
  let sinCosto = false;
  let sinTc = false;
  const matriculas = new Set<string>();
  for (const m of sortChrono(movs)) {
    if (m.tipo === ENTRADA && !(Number(m.costo_unitario_usd) > 0)) {
      sinCosto = true;
    }
    const paso = m.id ? walk.get(m.id) : undefined;
    const costoMxnFifo = paso?.costoMxnFifo ?? null;
    const venta = m.tipo === SALIDA ? ventaDeSalida(m, paso) : null;
    // Banderas sobre el cardex COMPLETO (como con_entradas_sin_costo).
    if (paso?.sinTc || venta?.sinTc) sinTc = true;
    if (!enPeriodo(m)) continue;
    const cant = Number(m.cantidad);
    if (m.tipo === SALIDA && venta) {
      haySalida = true;
      salidasCant = round(salidasCant + cant);
      // Solo salidas CON venta suman a vendido/utilidad (una salida a costo
      // FIFO no es una venta de la tiendita).
      // Una venta que CUENTA en USD va SOLO a vendido_usd: con T.C. en el
      // movimiento pero capas sin T.C. también traería ventaTotalMxn y se
      // pintaba en las dos columnas (vendido MXN sin su costo ni su utilidad).
      if (venta.ventaTotalMxn != null && venta.monedaUtilidad !== 'USD') {
        vendido = round((vendido ?? 0) + venta.ventaTotalMxn, 2);
        if (costoMxnFifo != null && !venta.sinTc) {
          costoVentas = round((costoVentas ?? 0) + costoMxnFifo, 2);
        }
      }
      if (venta.gananciaMxn != null) {
        utilidad = round((utilidad ?? 0) + venta.gananciaMxn, 2);
      }
      if (venta.conVenta) ventasCant = round((ventasCant ?? 0) + cant);
      // Utilidad en DÓLARES: solo las salidas que cuentan en USD (nunca las
      // que ya contaron en pesos).
      if (venta.monedaUtilidad === 'USD') {
        vendidoUsd = round((vendidoUsd ?? 0) + (venta.ventaTotalUsd ?? 0), 2);
        costoVentasUsd = round(
          (costoVentasUsd ?? 0) + (venta.costoUsd ?? 0),
          2,
        );
        utilidadUsd = round((utilidadUsd ?? 0) + (venta.gananciaUsd ?? 0), 2);
      }
      if (venta.utilidadIncompleta) ventasSinUtilidad += 1;
      matriculas.add(
        m.para_flota === true
          ? 'FLOTA'
          : (nombreDeJoin(m.aeronave, 'matricula') ?? '—'),
      );
    } else if (m.tipo === ENTRADA) {
      hayCompra = true;
      compradasCant = round(compradasCant + cant);
      // Una entrada USD sin TC no tiene monto en pesos: se excluye y se avisa
      // (sumar el USD crudo daría un total de compras falso).
      if (!costoSinTc(m)) {
        compradasCosto = round(
          compradasCosto + round(cant * costoUnitarioMxnDe(m).mxn, 2),
          2,
        );
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
    con_movimientos_sin_tc: sinTc,
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
  /** Σ ganancia de las salidas con precio del día (null = no hubo). */
  utilidad_mxn: number | null;
  /** Σ venta en DÓLARES de las salidas del día cuya utilidad cuenta en USD
   *  (null = ese día no hubo venta en USD). Jamás se suma con los pesos. */
  ventas_usd: number | null;
  costo_ventas_usd: number | null;
  utilidad_usd: number | null;
  /** Algún movimiento del día está en USD sin TC (montos afectados en null). */
  sin_tc: boolean;
}

/**
 * Bloque RESUMEN del detalle del producto: una fila POR DÍA con movimiento
 * (orden cronológico), la existencia al cierre de ese día (stock corriente
 * de walkCardex tras el último movimiento del día — el FIFO corre sobre
 * TODO el cardex aunque el periodo acote las filas) y la utilidad del día
 * (Σ ganancia de las salidas con precio; null si ese día no vendió nada).
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
        sin_tc: false,
      };
      dias.push(dia);
    }
    const cant = Number(m.cantidad);
    dia.existencia_cierre = existencia;
    if (paso?.sinTc) dia.sin_tc = true;
    if (m.tipo === SALIDA) {
      dia.salidas_cant = round(dia.salidas_cant + cant);
      const costoMxnFifo = paso?.costoMxnFifo ?? null;
      const venta = ventaDeSalida(m, paso);
      if (venta.sinTc) dia.sin_tc = true;
      if (venta.monedaUtilidad === 'USD') {
        dia.ventas_usd = round(
          (dia.ventas_usd ?? 0) + (venta.ventaTotalUsd ?? 0),
          2,
        );
        dia.costo_ventas_usd = round(
          (dia.costo_ventas_usd ?? 0) + (venta.costoUsd ?? 0),
          2,
        );
        dia.utilidad_usd = round(
          (dia.utilidad_usd ?? 0) + (venta.gananciaUsd ?? 0),
          2,
        );
      }
      // Misma regla que agregadosDeItem: lo que cuenta en USD no va a pesos.
      if (venta.ventaTotalMxn != null && venta.monedaUtilidad !== 'USD') {
        dia.ventas_mxn = round((dia.ventas_mxn ?? 0) + venta.ventaTotalMxn, 2);
        if (costoMxnFifo != null && !venta.sinTc) {
          dia.costo_ventas_mxn = round(
            (dia.costo_ventas_mxn ?? 0) + costoMxnFifo,
            2,
          );
        }
      }
      if (venta.gananciaMxn != null) {
        dia.utilidad_mxn = round(
          (dia.utilidad_mxn ?? 0) + venta.gananciaMxn,
          2,
        );
      }
    } else {
      dia.entradas_cant = round(dia.entradas_cant + cant);
    }
  }
  return dias;
}

// ===== Bloques COMPRAS / VENTAS (cardex formato libro) =====

export interface BloqueCompra {
  movimiento_id: string | null;
  fecha: string;
  tipo: 'ENTRADA' | 'DEVOLUCION' | 'AJUSTE';
  cantidad: number;
  /** Costo unitario en PESOS (criterio único costoUnitarioMxnDe); null si la
   *  captura fue USD sin TC (`sin_tc`): no hay monto en pesos que pintar. */
  precio_unitario_mxn: number | null;
  total_mxn: number | null;
  moneda_captura: 'MXN' | 'USD';
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
}

export interface BloqueVenta {
  movimiento_id: string | null;
  fecha: string;
  cantidad: number;
  /** Precio al que se vendió; en una salida A COSTO, el costo FIFO unitario. */
  precio_unitario_mxn: number | null;
  total_mxn: number | null;
  venta_moneda: 'MXN' | 'USD' | null;
  venta_unitaria_capturada: number | null;
  /** true = salida SIN precio: el avión pagó el costo FIFO (ganancia 0, como el libro). */
  a_costo: boolean;
  /** Venta USD sin TC o capas consumidas USD sin TC: los montos en pesos
   *  afectados van null (nunca se pinta un USD como MXN). */
  sin_tc: boolean;
  /** Costo FIFO MXN de las capas consumidas (null si `sin_tc`). */
  costo_fifo_mxn: number | null;
  ganancia_mxn: number | null;
  /** Total cobrado al avión EN `venta_moneda` (= monto del gasto BODEGA);
   *  null en una salida a costo. */
  venta_total: number | null;
  /** Costo FIFO en USD de las capas consumidas (siempre en una salida). */
  costo_fifo_usd: number | null;
  /** Utilidad en dólares cuando la salida cuenta en USD (`moneda_utilidad`). */
  ganancia_usd: number | null;
  /** En qué moneda cuenta la utilidad de ESTA salida (null = sin utilidad). */
  moneda_utilidad: 'MXN' | 'USD' | null;
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
}

export interface TotalesBloques {
  compras_cant: number | null;
  compras_mxn: number | null;
  ventas_cant: number | null;
  /** Σ de las salidas CON precio (mismo número que el listado y el balance). */
  ventas_mxn: number | null;
  /** Σ (a costo FIFO) de las salidas SIN precio — informativo. */
  ventas_a_costo_mxn: number | null;
  costo_ventas_mxn: number | null;
  utilidad_mxn: number | null;
  /** Utilidad en DÓLARES (agregadosDeItem): aparte, jamás sumada a pesos. */
  ventas_usd: number | null;
  costo_ventas_usd: number | null;
  utilidad_usd: number | null;
  ventas_sin_utilidad: number;
  con_entradas_sin_costo: boolean;
  /** Algún movimiento del cardex está en USD sin TC (filas con `sin_tc`). */
  con_movimientos_sin_tc: boolean;
}

export interface BloquesCardex {
  compras: BloqueCompra[];
  ventas: BloqueVenta[];
  totales: TotalesBloques;
}

/**
 * Bloques ENTRADAS (compras) | SALIDAS (ventas) del cardex de UN ítem —
 * réplica del cuaderno del cliente. Los consume el Excel formato libro y el
 * detalle del producto en el panel: MISMA salida, dos presentaciones.
 * Montos en PESOS; salida SIN precio de venta = el avión pagó el costo FIFO,
 * así que el libro la registra "vendida al costo" (ganancia 0). Los totales
 * salen de agregadosDeItem (el mismo número del listado y del balance).
 */
export function bloquesCardexDe(
  itemNombre: string,
  movs: MovCardex[],
  enPeriodo: FiltroPeriodo = TODO_EL_CARDEX,
): BloquesCardex {
  const walk = walkCardex(movs);
  const compras: BloqueCompra[] = [];
  const ventas: BloqueVenta[] = [];
  let ventasACosto: number | null = null;
  for (const m of sortChrono(movs)) {
    if (!enPeriodo(m)) continue;
    const paso = m.id ? walk.get(m.id) : undefined;
    const cant = Number(m.cantidad);
    const referencia =
      typeof m.referencia === 'string' && m.referencia ? m.referencia : null;
    const ref = referencia ? ` · ref ${referencia}` : '';
    if (m.tipo === SALIDA) {
      const costoMxnFifo = paso?.costoMxnFifo ?? null;
      const venta = ventaDeSalida(m, paso);
      // A costo = la salida NO llevó precio (no "no se pudo expresar en
      // pesos": una venta USD sin TC sigue siendo una venta, con sin_tc).
      const aCosto = !venta.conVenta;
      const unit =
        venta.ventaUnitMxn ??
        (aCosto && costoMxnFifo != null && cant > 0
          ? round(costoMxnFifo / cant, 2)
          : null);
      const total = venta.ventaTotalMxn ?? (aCosto ? costoMxnFifo : null);
      const ganancia =
        venta.gananciaMxn ?? (aCosto && total != null ? 0 : null);
      const paraFlota = m.para_flota === true;
      const matricula = nombreDeJoin(m.aeronave, 'matricula');
      if (aCosto && total != null) {
        ventasACosto = round((ventasACosto ?? 0) + total, 2);
      }
      ventas.push({
        movimiento_id: m.id ?? null,
        fecha: String(m.fecha_movimiento ?? ''),
        cantidad: cant,
        precio_unitario_mxn: unit,
        total_mxn: total,
        venta_moneda: aCosto ? null : m.venta_moneda === 'USD' ? 'USD' : 'MXN',
        venta_unitaria_capturada: aCosto ? null : Number(m.venta_unitaria),
        a_costo: aCosto,
        sin_tc: venta.sinTc,
        costo_fifo_mxn: costoMxnFifo,
        ganancia_mxn: ganancia,
        venta_total: venta.ventaTotal,
        costo_fifo_usd: paso?.costoUsdFifo ?? null,
        ganancia_usd: venta.gananciaUsd,
        moneda_utilidad: venta.monedaUtilidad,
        utilidad_incompleta: venta.utilidadIncompleta,
        vendido_a: paraFlota ? 'FLOTA' : (matricula ?? '—'),
        aeronave_id: m.aeronave_id ?? null,
        para_flota: paraFlota,
        referencia,
        descripcion: `${itemNombre}${aCosto ? ' · a costo FIFO' : ''}${venta.sinTc ? ' · sin TC' : ''}${ref}`,
        remanente: paso?.stockDespues ?? 0,
      });
    } else {
      // ENTRADA en su lugar natural; DEVOLUCION/AJUSTE también SUMAN stock
      // (así los procesa buildLayers) y van de este lado con su nota.
      const { mxn } = costoUnitarioMxnDe(m);
      // USD sin TC: no hay pesos que pintar (null + sin_tc), jamás el USD
      // disfrazado de MXN.
      const sinTc = costoSinTc(m);
      const unit = sinTc ? null : round(mxn, 2);
      const total = sinTc ? null : round(mxn * cant, 2);
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
      const enMxn = m.moneda === 'MXN' && m.costo_unitario_mxn != null;
      const tc = Number(m.tc_usd_mxn);
      compras.push({
        movimiento_id: m.id ?? null,
        fecha: String(m.fecha_movimiento ?? ''),
        tipo,
        cantidad: cant,
        precio_unitario_mxn: unit,
        total_mxn: total,
        moneda_captura: enMxn ? 'MXN' : 'USD',
        costo_unitario_capturado: Number(
          enMxn ? m.costo_unitario_mxn : m.costo_unitario_usd,
        ),
        tc_usd_mxn: Number.isFinite(tc) && tc > 0 ? tc : null,
        sin_costo: tipo === 'ENTRADA' && !(Number(m.costo_unitario_usd) > 0),
        sin_tc: sinTc,
        proveedor_nombre: proveedor,
        aeronave_matricula: matricula,
        referencia,
        descripcion: `${pref}${itemNombre}${origen ? ` · ${origen}` : ''}${sinTc ? ' · sin TC' : ''}${ref}`,
        stock_despues: paso?.stockDespues ?? 0,
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
      ventas_a_costo_mxn: ventasACosto,
      costo_ventas_mxn: a.costo_ventas_mxn,
      utilidad_mxn: a.utilidad_mxn,
      ventas_usd: a.ventas_usd,
      costo_ventas_usd: a.costo_ventas_usd,
      utilidad_usd: a.utilidad_usd,
      ventas_sin_utilidad: a.ventas_sin_utilidad,
      con_entradas_sin_costo: a.con_entradas_sin_costo,
      con_movimientos_sin_tc: a.con_movimientos_sin_tc,
    },
  };
}
