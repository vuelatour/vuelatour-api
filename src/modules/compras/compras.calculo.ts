/**
 * Cálculo de una COMPRA de refacciones — FUENTE ÚNICA del costo "puesto en
 * bodega" (28-ago-2026).
 *
 * La mercancía se factura aparte de sus cargos (envío, aduana, honorarios…):
 * el costo real de cada refacción = costo de factura + su parte de los cargos,
 * prorrateada POR VALOR (factor = (mercancía + cargos) / mercancía). Los
 * cargos vienen de dos lados: renglones de la propia factura de mercancía
 * (`cargos_factura`: Shipping, Tax…) y PAGOS ligados con rol ≠ MERCANCIA
 * (gastos con `compra_id`), convertidos a la moneda de la compra.
 *
 * Módulo PURO (sin Nest ni BD) para que el mismo número salga en el detalle,
 * en el listado, al recibir (ENTRADAS del cardex) y al importar desde PDF —
 * y para probarlo con jest sin levantar nada.
 */

export type MonedaCompra = 'USD' | 'MXN';
export type RolPagoCompra = 'MERCANCIA' | 'ENVIO' | 'IMPUESTOS' | 'OTRO';
export type EstadoCompra = 'ABIERTA' | 'RECIBIDA';

/**
 * ¿La compra ya tiene su GASTO? (21-oct-2026, invariante 101). Derivado de
 * los pagos ligados, nunca una columna:
 *  - `SIN_GASTO`: ningún pago ligado (la factura todavía no se registró en
 *    Gastos ni se vinculó);
 *  - `PARCIAL`: hay pagos pero falta la factura de mercancía (solo envío /
 *    impuestos), o la de mercancía no cubre `total_factura` (tolerancia 1 %);
 *  - `REGISTRADO`: la factura de mercancía está ligada y cubre lo que dicen
 *    las líneas + los cargos impresos en ella (o no se puede verificar por
 *    falta de T.C.: el aviso de siempre lo dice).
 */
export type GastoEstadoCompra = 'SIN_GASTO' | 'PARCIAL' | 'REGISTRADO';

export interface CargoFactura {
  concepto: string;
  /** En la moneda de la compra. */
  monto: number;
}

export interface CompraCalcInput {
  moneda: MonedaCompra;
  tc_usd_mxn: number | string | null;
  cargos_factura: CargoFactura[] | null;
  estado: EstadoCompra;
}

export interface LineaCalcInput {
  cantidad: number | string;
  /** Costo unitario de FACTURA en la moneda de la compra. */
  costo_unitario: number | string;
  /**
   * Costo unitario con el que se registró la ENTRADA del cardex (moneda de
   * la compra); null/undefined si aún no se recibe. Sirve para detectar
   * cargos ligados DESPUÉS de la recepción (aviso "recalcular").
   */
  costo_unitario_recibido?: number | string | null;
}

export interface PagoCalcInput {
  monto: number | string;
  moneda: string | null;
  tc_gasto: number | string | null;
  /** RolPagoCompra (string por venir crudo de la BD). */
  compra_rol: string | null;
}

export type LineaCalculada<L extends LineaCalcInput> = L & {
  /** Costo unitario final (factura + cargos prorrateados), moneda de la compra. */
  costo_unitario_final: number;
  costo_unitario_final_usd: number | null;
  costo_unitario_final_mxn: number | null;
  /** cantidad × costo_unitario_final, a centavos. */
  total_linea_final: number;
};

/** Pago-cargo que NO se pudo convertir a la moneda de la compra (sin TC). */
export interface CargoSinTc {
  monto: number;
  moneda: string;
}

export interface ResumenCompra {
  total_mercancia: number;
  cargos_factura: number;
  cargos_pagos: number;
  total: number;
  factor: number;
  moneda: MonedaCompra;
  tc_usd_mxn: number | null;
  total_usd: number | null;
  total_mxn: number | null;
  avisos: string[];
  /**
   * Cargos excluidos del prorrateo por falta de TC (estructurado, además del
   * aviso de texto): `recibir` se niega si hay alguno salvo que se fuerce —
   * un costo incompleto en bodega jamás debe entrar en silencio.
   */
  cargos_sin_tc: CargoSinTc[];
  /**
   * Lo que vale la FACTURA de mercancía = líneas + cargos impresos en ella
   * (`cargos_factura`), en la moneda de la compra. Es el monto del gasto que
   * la paga («Registrar gasto», invariante 101); NO incluye los pagos-cargo
   * (envío/impuestos), que ya son sus propios gastos.
   */
  total_factura: number;
  /** ¿La compra ya tiene su gasto de mercancía? (ver `GastoEstadoCompra`). */
  gasto_estado: GastoEstadoCompra;
  /**
   * Lo ligado con rol MERCANCIA en la moneda de la compra (0 sin pago de
   * mercancía; null cuando hay uno en otra moneda sin TC: no se sabe).
   */
  gasto_mercancia: number | null;
  /** Lo que falta de la factura de mercancía cuando el gasto es PARCIAL; null si no. */
  gasto_faltante: number | null;
}

/**
 * Estado del gasto de una compra (PURO, fuente única de la lista, el detalle
 * y «Registrar gasto»). Misma tolerancia del cuadre de la factura (1 %,
 * mínimo un centavo).
 */
export function estadoGastoCompra(p: {
  total_factura: number;
  hayPagos: boolean;
  hayPagoMercancia: boolean;
  mercanciaSinTc: boolean;
  pagadoMercancia: number;
}): {
  gasto_estado: GastoEstadoCompra;
  gasto_mercancia: number | null;
  gasto_faltante: number | null;
} {
  const esperado = round(p.total_factura, 2);
  if (!p.hayPagos) {
    return {
      gasto_estado: 'SIN_GASTO',
      gasto_mercancia: 0,
      gasto_faltante: null,
    };
  }
  if (!p.hayPagoMercancia) {
    // Solo cargos (envío, impuestos…): la factura de mercancía falta entera.
    return {
      gasto_estado: 'PARCIAL',
      gasto_mercancia: 0,
      gasto_faltante: esperado > 0 ? esperado : null,
    };
  }
  if (p.mercanciaSinTc) {
    return {
      gasto_estado: 'REGISTRADO',
      gasto_mercancia: null,
      gasto_faltante: null,
    };
  }
  const pagado = round(p.pagadoMercancia, 2);
  const tolerancia = Math.max(0.01, esperado * 0.01);
  if (esperado > 0 && pagado < esperado - tolerancia) {
    return {
      gasto_estado: 'PARCIAL',
      gasto_mercancia: pagado,
      gasto_faltante: round(esperado - pagado, 2),
    };
  }
  return {
    gasto_estado: 'REGISTRADO',
    gasto_mercancia: pagado,
    gasto_faltante: null,
  };
}

export function round(n: number, decimales: number): number {
  const f = Math.pow(10, decimales);
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Tolerancia al comparar el costo con el que ENTRÓ la línea al cardex contra
 * el costo final recalculado. La columna guarda 4 decimales
 * (`numeric(14,4)`, migración 20260828000010): medio diezmilésimo + un
 * epsilon de flotante. Con 0.005 (centavos) un cargo chico pasaba
 * desapercibido; con 0 a secas un final x.xx50 se quedaba "pegado" en
 * "recalcular" por el redondeo del propio número.
 */
export const TOL_RECIBIDO = 0.00005 + 1e-9;

function num(v: number | string | null | undefined): number {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** $1,234.56 para los avisos que lee el operador. */
export function fmtMonto(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Convierte un monto entre USD y MXN con un TC (MXN por USD). Misma moneda →
 * tal cual. Sin TC y monedas distintas → null (el caller decide qué avisar;
 * NUNCA se suma crudo como si fuera la otra moneda).
 */
export function convertirMoneda(
  monto: number,
  de: string,
  a: MonedaCompra,
  tc: number | null,
): number | null {
  const origen = (de || a).toUpperCase();
  if (origen === a) return monto;
  if (tc == null || !(tc > 0)) return null;
  if (origen === 'MXN' && a === 'USD') return monto / tc;
  if (origen === 'USD' && a === 'MXN') return monto * tc;
  return null;
}

/**
 * Prorrateo por valor con residuo de centavos en la ÚLTIMA línea para que
 * Σ cantidad × costo_unitario_final == total_mercancia + cargos (±0.01).
 */
export function calcularCompra<L extends LineaCalcInput>(
  compra: CompraCalcInput,
  lineas: L[],
  pagos: PagoCalcInput[],
): { lineas: LineaCalculada<L>[]; resumen: ResumenCompra } {
  const moneda: MonedaCompra = compra.moneda === 'MXN' ? 'MXN' : 'USD';
  const tcRaw = num(compra.tc_usd_mxn);
  const tc: number | null = tcRaw > 0 ? tcRaw : null;
  const avisos: string[] = [];
  const cargosSinTc: CargoSinTc[] = [];

  const totalMercancia = round(
    lineas.reduce((s, l) => s + num(l.cantidad) * num(l.costo_unitario), 0),
    2,
  );

  const cargosFactura = round(
    (compra.cargos_factura ?? []).reduce((s, c) => s + num(c.monto), 0),
    2,
  );

  // Pagos-cargo (rol ≠ MERCANCIA) en la moneda de la compra. TC del gasto
  // primero (lo que realmente cobró el banco), si no el de la compra.
  let cargosPagos = 0;
  let pagadoMercancia = 0;
  let hayPagoMercancia = false;
  let mercanciaSinTc = false;
  let hayPagos = false;
  for (const p of pagos) {
    const monto = num(p.monto);
    if (monto === 0) continue;
    hayPagos = true;
    const tcPago = num(p.tc_gasto) > 0 ? num(p.tc_gasto) : tc;
    const monedaPago = (p.moneda ?? moneda).toUpperCase();
    const enMoneda = convertirMoneda(monto, monedaPago, moneda, tcPago);
    if (p.compra_rol === 'MERCANCIA') {
      hayPagoMercancia = true;
      if (enMoneda == null) mercanciaSinTc = true;
      else pagadoMercancia += enMoneda;
      continue;
    }
    if (enMoneda == null) {
      avisos.push(
        `cargo $${fmtMonto(monto)} ${monedaPago} sin TC (no prorrateado)`,
      );
      cargosSinTc.push({ monto, moneda: monedaPago });
      continue;
    }
    cargosPagos += enMoneda;
  }
  cargosPagos = round(cargosPagos, 2);

  const cargos = round(cargosFactura + cargosPagos, 2);
  const total = round(totalMercancia + cargos, 2);
  const factor =
    totalMercancia > 0 ? (totalMercancia + cargos) / totalMercancia : 1;

  // Costo final por línea: round4(costo × factor); el residuo de centavos
  // cae en la última línea. Si la mercancía vale $0 (muestras, garantía) y
  // aun así hay cargos, el prorrateo por valor no existe: se reparte POR
  // UNIDAD para que el costo no se pierda ni caiga todo en una línea.
  const sinValor = totalMercancia <= 0 && cargos !== 0 && lineas.length > 0;
  const totalUnidades = lineas.reduce((s, l) => s + num(l.cantidad), 0);
  if (sinValor) {
    avisos.push(
      'mercancía en $0: los cargos se repartieron por unidad (no por valor)',
    );
  }
  const finales = lineas.map((l) => {
    const costo = num(l.costo_unitario);
    if (sinValor) {
      return round(totalUnidades > 0 ? cargos / totalUnidades : 0, 4);
    }
    return round(costo * factor, 4);
  });
  if (lineas.length > 0) {
    const ultima = lineas.length - 1;
    const cantUltima = num(lineas[ultima].cantidad);
    if (cantUltima > 0) {
      const sumaOtras = finales
        .slice(0, ultima)
        .reduce((s, f, i) => s + f * num(lineas[i].cantidad), 0);
      finales[ultima] = round((total - sumaOtras) / cantUltima, 4);
    }
  }

  const aUsd = (v: number): number | null =>
    moneda === 'USD' ? v : tc ? round(v / tc, 4) : null;
  const aMxn = (v: number): number | null =>
    moneda === 'MXN' ? v : tc ? round(v * tc, 4) : null;

  let cargosNuevos = false;
  const lineasCalc = lineas.map((l, i) => {
    const final = finales[i];
    const recibido = l.costo_unitario_recibido;
    if (
      compra.estado === 'RECIBIDA' &&
      recibido != null &&
      recibido !== '' &&
      Math.abs(num(recibido) - final) > TOL_RECIBIDO
    ) {
      cargosNuevos = true;
    }
    return {
      ...l,
      costo_unitario_final: final,
      costo_unitario_final_usd: aUsd(final),
      costo_unitario_final_mxn: aMxn(final),
      total_linea_final: round(num(l.cantidad) * final, 2),
    };
  });

  // La factura de mercancía debe cuadrar con lo que dicen las líneas más los
  // cargos que traía impresos (Shipping, Tax…). Tolerancia 1 %.
  if (hayPagoMercancia && !mercanciaSinTc) {
    const esperado = round(totalMercancia + cargosFactura, 2);
    const pagado = round(pagadoMercancia, 2);
    const tolerancia = Math.max(0.01, esperado * 0.01);
    if (Math.abs(pagado - esperado) > tolerancia) {
      avisos.push(
        `la factura de mercancía ($${fmtMonto(pagado)}) no cuadra con las líneas ($${fmtMonto(esperado)})`,
      );
    }
  } else if (hayPagoMercancia && mercanciaSinTc) {
    avisos.push(
      'pago de mercancía en otra moneda sin TC: no se pudo verificar contra las líneas',
    );
  }
  if (cargosNuevos) {
    avisos.push('recalcular: hay cargos nuevos desde la recepción');
  }

  const totalUsd = moneda === 'USD' ? total : tc ? round(total / tc, 2) : null;
  const totalMxn = moneda === 'MXN' ? total : tc ? round(total * tc, 2) : null;

  // El gasto de la compra (invariante 101): lo que vale la factura de
  // mercancía y si ya está ligada.
  const totalFactura = round(totalMercancia + cargosFactura, 2);
  const gasto = estadoGastoCompra({
    total_factura: totalFactura,
    hayPagos,
    hayPagoMercancia,
    mercanciaSinTc,
    pagadoMercancia,
  });

  return {
    lineas: lineasCalc,
    resumen: {
      total_mercancia: totalMercancia,
      cargos_factura: cargosFactura,
      cargos_pagos: cargosPagos,
      total,
      factor: round(factor, 6),
      moneda,
      tc_usd_mxn: tc,
      total_usd: totalUsd,
      total_mxn: totalMxn,
      avisos,
      cargos_sin_tc: cargosSinTc,
      total_factura: totalFactura,
      ...gasto,
    },
  };
}

// ===== Heurísticas de texto (compartidas por create/unir) =====

/**
 * Renglones de la factura de mercancía que NO son refacciones sino cargos
 * (van a `cargos_factura`). Palabras cortas con borde (`tax`, `iva`, `fee`)
 * para no confundir "Taxi light" o "Rivet" con un cargo.
 */
export const RE_CONCEPTO_CARGO =
  /shipping|env[ií]o|freight|handling|manejo|\btax(?:es)?\b|impuesto|\biva\b|\bfees?\b|cuota|honorario/i;

/** Rol de un pago ligado por `unir`, a partir de notas/conceptos/proveedor. */
export function rolPorTexto(texto: string): RolPagoCompra {
  if (/impuesto|aduana|customs|duty|arancel/i.test(texto)) return 'IMPUESTOS';
  if (
    /env[ií]o|shipping|dhl|ups|fedex|estafeta|paqueter|freight|mensajer/i.test(
      texto,
    )
  )
    return 'ENVIO';
  return 'OTRO';
}

/**
 * "Bolt AN3-4A (x3)" → { nombre: "Bolt AN3-4A", cantidad: 3 }. También
 * acepta "(3x)". Sin sufijo → cantidad 1.
 */
export function parsearCantidadConcepto(concepto: string): {
  nombre: string;
  cantidad: number;
} {
  const m = concepto.match(
    /\s*\(\s*(?:x\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*x)\s*\)\s*$/i,
  );
  if (!m) return { nombre: concepto.trim(), cantidad: 1 };
  const raw = (m[1] ?? m[2] ?? '1').replace(',', '.');
  const cantidad = Number(raw);
  return {
    nombre: concepto.slice(0, m.index).trim() || concepto.trim(),
    cantidad: Number.isFinite(cantidad) && cantidad > 0 ? cantidad : 1,
  };
}
