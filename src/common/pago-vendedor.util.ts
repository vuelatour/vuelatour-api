/**
 * PAGO REAL AL VENDEDOR ↔ COMISIÓN COBRADA — fuente única del apareo
 * (pedido del cliente, 28-sep-2026; invariante 31 del CLAUDE.md del API).
 *
 * «¿Cómo registro el pago de la comisión a Saab para que aparezca en otros
 * movimientos? Si lo capturo como "Otros gastos VuelaTour" me lo manda a la
 * hoja de otros gastos y queda duplicado.» Hasta el 0.0.38 el pago al
 * vendedor solo existía como PROVISIÓN calculada (mismo monto que la línea
 * de comisión cobrada). Desde el 0.0.39 existe la categoría de gasto
 * `COMISION_VENDEDOR` («Comisión del vendedor»), siempre ligada a un vuelo, y
 * sus gastos REEMPLAZAN a la provisión de ese vuelo — espejo de las TUAS
 * pagadas, que ya se apareaban con las TUAS cobradas.
 *
 * PURO (sin Nest): lo usan el Balance general («otros movimientos») y el
 * Libro Dinero («Otros ingresos»). Prohibido reimplementarlo en un lector:
 * si los dos libros no dicen lo mismo del mismo vuelo, el cierre no cuadra.
 *
 * Reglas:
 *  - La PROVISIÓN existe SOLO cuando el vuelo no tiene ningún gasto de la
 *    categoría (n = 0). Con n ≥ 1 el egreso es Σ de lo pagado de verdad
 *    (parcial, exacto o mayor): la diferencia con lo cobrado se VE en el
 *    concepto («faltan $…» / «excede $…»), jamás se provisiona el faltante.
 *  - Sin cadena de T.C. propia (CLAUDE.md: no crear cálculos paralelos): cada
 *    libro inyecta SU conversor (`aMxn`), el mismo con el que convierte sus
 *    TUAS pagadas.
 *  - Dinero siempre con 2 decimales es-MX y con moneda.
 */
import { categoriaEsPagoVendedor } from './categoria-gasto.util';

/** Lo mínimo que el apareo necesita de un gasto. */
export interface GastoPagoVendedorRow {
  categoria?: string | null;
  monto: number | string | null;
  moneda: string | null;
  tc_gasto: number | string | null;
  /** YYYY-MM-DD (DATE: día de pared). */
  fecha_gasto: string | null;
}

/** Lo pagado al vendedor en UN vuelo. */
export interface PagosVendedorDeVuelo {
  /** Gastos COMISION_VENDEDOR del vuelo (conviertan o no). */
  n: number;
  /** round2(Σ de los que convierten); null si ninguno convierte (o n = 0). */
  pagadoMxn: number | null;
  /** Los que el conversor del libro no pudo convertir (no suman). */
  sinTc: number;
  /** fecha_gasto MÁS RECIENTE de los gastos de la categoría. */
  fecha: string | null;
}

/** Diferencia (MXN) a partir de la cual el concepto dice «faltan»/«excede». */
export const TOLERANCIA_PAGO_VENDEDOR_MXN = 1.0;

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function numero(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/**
 * Filtra los gastos del vuelo por categoría (`categoriaEsPagoVendedor`) y los
 * suma con el CONVERSOR DEL LIBRO que lo llama («gastoMxn, TC como el
 * resto»):
 *  - Balance general: su `gastoMxn` de «otros movimientos» (MXN directo; USD
 *    × (tc_gasto > 0 ?? T.C. promedio del periodo)) — la MISMA regla del
 *    workbook que usan las TUAS pagadas de esa pestaña.
 *  - Libro Dinero: la regla de su TUA pagado (MXN directo; USD × (tc_gasto >
 *    0 ?? T.C. de venta del vuelo)).
 * Consecuencia aceptada: una comisión USD SIN `tc_gasto` puede diferir entre
 * libros (igual que hoy las TUAS). `aMxn(g)` devuelve MXN o null (sin T.C.
 * ⇒ `sinTc++`, no suma). Suma CRUDA y `round2` al final (mismo patrón que
 * `tuaPagadoMxn`).
 */
export function pagosVendedorDeVuelo<T extends GastoPagoVendedorRow>(
  gastos: readonly T[],
  aMxn: (g: T) => number | null,
): PagosVendedorDeVuelo {
  let n = 0;
  let sinTc = 0;
  let suma = 0;
  let convirtio = false;
  let fecha: string | null = null;
  for (const g of gastos) {
    if (!categoriaEsPagoVendedor(g.categoria ?? null)) continue;
    n += 1;
    const f = typeof g.fecha_gasto === 'string' ? g.fecha_gasto : null;
    if (f && (fecha == null || f > fecha)) fecha = f;
    const mxn = numero(aMxn(g));
    if (mxn == null) {
      sinTc += 1;
      continue;
    }
    suma += mxn;
    convirtio = true;
  }
  return {
    n,
    pagadoMxn: convirtio ? round2(suma) : null,
    sinTc,
    fecha,
  };
}

/** Por qué un pago real no se aparea con ninguna línea de comisión. */
export type MotivoSinLineaComision =
  | 'SIN_LINEA'
  | 'CANCELADO'
  | 'INCONSISTENTE';

/**
 * Motivo de la fila de SOLO-egreso — MISMA regla en los dos libros (el Libro
 * Dinero no ve líneas cuando la partición es inconsistente y el Balance sí:
 * decidirlo por las líneas haría que el mismo vuelo dijera cosas distintas).
 *  - CANCELADO gana (un cancelado no tiene ingreso de VuelaTour).
 *  - Partición inconsistente CON comisión cotizada ⇒ INCONSISTENTE.
 *  - Lo demás ⇒ SIN_LINEA (la cotización no cobró comisión).
 */
export function motivoSinLineaComision(a: {
  cancelado: boolean;
  inconsistente: boolean;
  /** `particionIngresoVuelo(...).comision_vendedor_usd`. */
  comisionVendedorUsd: number;
}): MotivoSinLineaComision {
  if (a.cancelado) return 'CANCELADO';
  if (a.inconsistente && a.comisionVendedorUsd > 0) return 'INCONSISTENTE';
  return 'SIN_LINEA';
}

/** Texto de cada motivo de solo-egreso. */
export const TEXTO_SIN_LINEA_COMISION: Readonly<
  Record<MotivoSinLineaComision, string>
> = {
  SIN_LINEA: 'sin comisión cobrada en la cotización',
  CANCELADO: 'vuelo cancelado: sin comisión cobrada',
  INCONSISTENTE: 'desglose de la cotización inconsistente: sin apareo',
};

/** Dinero es-MX con 2 decimales FIJOS (nunca 1 decimal). */
function fmtMxn(x: number): string {
  return x.toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Concepto del egreso cuando HAY gasto real (n ≥ 1). Todos empiezan con
 * `pago comisión vendedor` ⇒ `colapsarFilasDeVuelo` del Balance los
 * clasifica como «pago comisión vendedor» sin cambio.
 *
 * Gramática EXACTA:
 *  - `pagos` = ` (N pagos)` con N ≥ 2.
 *  - `usd` = ` (parcial: USD sin TC)` si alguno no convirtió y otros sí;
 *    ` (USD sin TC)` si ninguno convirtió.
 *  - Con línea: `pago <etiqueta> · gasto real<pagos><cmp><usd>`; `cmp` solo
 *    con `lineaMxn` y `pagadoMxn` conocidos y `sinTc = 0`:
 *    d = round2(línea − pagado) ≥ 1.00 ⇒ ` · parcial: faltan $X MXN`;
 *    d ≤ −1.00 ⇒ ` · excede $X MXN`.
 *  - Sin línea: `pago <etiqueta> · <motivo><pagos><usd>`.
 */
export function conceptoPagoVendedorReal(a: {
  /** 'comisión vendedor (Alex Saab)' | 'comisión vendedor'. */
  etiquetaComision: string;
  pagos: PagosVendedorDeVuelo;
  /** Σ ingreso MXN de las líneas de comisión; null = sin T.C. de venta. */
  lineaMxn: number | null;
  /** Presente ⇒ fila de solo-egreso. */
  sinLinea?: MotivoSinLineaComision;
}): string {
  const { etiquetaComision, pagos, lineaMxn, sinLinea } = a;
  const nPagos = pagos.n >= 2 ? ` (${pagos.n} pagos)` : '';
  const usd =
    pagos.sinTc > 0
      ? pagos.pagadoMxn != null
        ? ' (parcial: USD sin TC)'
        : ' (USD sin TC)'
      : '';
  if (sinLinea) {
    return `pago ${etiquetaComision} · ${TEXTO_SIN_LINEA_COMISION[sinLinea]}${nPagos}${usd}`;
  }
  let cmp = '';
  if (lineaMxn != null && pagos.pagadoMxn != null && pagos.sinTc === 0) {
    const d = round2(lineaMxn - pagos.pagadoMxn);
    if (d >= TOLERANCIA_PAGO_VENDEDOR_MXN) {
      cmp = ` · parcial: faltan $${fmtMxn(d)} MXN`;
    } else if (d <= -TOLERANCIA_PAGO_VENDEDOR_MXN) {
      cmp = ` · excede $${fmtMxn(-d)} MXN`;
    }
  }
  return `pago ${etiquetaComision} · gasto real${nPagos}${cmp}${usd}`;
}

// ===== Notas de celda del Libro Dinero (hoja «Otros ingresos») =====

/**
 * Nota de la PROVISIÓN (vuelo sin gasto real). Reemplaza al texto del 0.0.38,
 * que afirmaba «hoy no existe categoría de gasto de comisión de venta» —
 * falso desde el 0.0.39. Es la ÚNICA cadena de todos los reportes que cambia
 * sin gastos nuevos (excepción sancionada: el texto viejo sería falso).
 */
export const NOTA_PROVISION_PAGO_VENDEDOR =
  'PROVISIÓN: pago al vendedor por el mismo monto de la comisión cobrada (comisión + IVA = pagoVendedorUsd; neto de VuelaTour = precio base). Aún no hay gasto real: captúralo en Gastos con la categoría «Comisión del vendedor» ligado a este vuelo y reemplaza esta provisión (no lo captures como «Otros gastos VuelaTour»: quedaría duplicado). En la hoja utilidades ya está descontado de "otros ingresos".';

/** Nota del egreso cuando el pago REAL se aparea con la comisión cobrada. */
export const NOTA_PAGO_VENDEDOR_REAL =
  'GASTO REAL: pago al vendedor capturado como «Comisión del vendedor» ligado a este vuelo; reemplaza la provisión. En la hoja utilidades ya está descontado de "otros ingresos".';

/** Nota de la fila de solo-egreso (pago real sin línea de comisión). */
export const NOTA_PAGO_VENDEDOR_SIN_LINEA =
  'GASTO REAL: pago al vendedor capturado como «Comisión del vendedor» en un vuelo sin comisión cobrada en la cotización (revisa la cotización o el vuelo del gasto). En la hoja utilidades ya está descontado de "otros ingresos".';
