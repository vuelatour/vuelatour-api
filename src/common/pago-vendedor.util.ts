/**
 * PAGO REAL AL VENDEDOR ↔ COMISIÓN COBRADA — fuente única del apareo
 * (pedido del cliente, 28-sep-2026; invariante 31 del CLAUDE.md del API).
 *
 * «¿Cómo registro el pago de la comisión a Saab para que aparezca en otros
 * movimientos? Si lo capturo como "Otros gastos VuelaTour" me lo manda a la
 * hoja de otros gastos y queda duplicado.» Hasta el 0.0.38 el pago al
 * vendedor solo existía como PROVISIÓN calculada (mismo monto que la línea
 * de comisión cobrada). Desde el 0.0.39 existe la categoría de gasto
 * `COMISION_VENDEDOR` («Comisión del vendedor»), siempre ligada a un vuelo —
 * espejo de las TUAS pagadas, que ya se apareaban con las TUAS cobradas.
 *
 * PURO (sin Nest): lo usan el Balance general («otros movimientos»), el
 * Libro Dinero («Otros ingresos») y, desde el 13-oct-2026, la fuente única
 * de las COMISIONES del avión (`comisiones-avion.util.ts`). Prohibido
 * reimplementarlo en un lector: si los libros no dicen lo mismo del mismo
 * vuelo, el cierre no cuadra.
 *
 * Reglas:
 *  - NO EXISTE PROVISIÓN EN NINGÚN LIBRO (13-oct-2026, API 0.0.74,
 *    invariante 61; decisión 3 del lote del cliente): sin gasto real
 *    ningún libro resta nada. Con n ≥ 1 el egreso es Σ de lo pagado de
 *    verdad (parcial, exacto o mayor): la diferencia con lo cobrado se VE en
 *    el concepto («faltan $…» / «excede $…»), jamás se provisiona el
 *    faltante. En los vuelos COMPLETADOS de la regla de comisiones el gasto
 *    lo carga el AVIÓN en su columna COMISIONES (`comisiones-avion.util`) y
 *    «otros movimientos» lo muestra con egreso $0.00 «a cargo del avión».
 *  - Sin cadena de T.C. propia (CLAUDE.md: no crear cálculos paralelos): cada
 *    libro inyecta SU conversor, el mismo con el que convierte sus TUAS
 *    pagadas. `pagosVendedorDeVuelo` se reutiliza con DOS conversores en
 *    `comisiones-avion.util` (uno a MXN y otro a USD): `pagadoMxn` significa
 *    «la suma convertida por el conversor inyectado» — en la llamada USD
 *    son dólares.
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
 * Sufijo de los pagos que el conversor del libro NO pudo convertir:
 * ` (parcial: USD sin TC)` si alguno no convirtió y otros sí; ` (USD sin
 * TC)` si ninguno convirtió; '' si todos convirtieron. Comparte la marca
 * «sin TC» (palabra completa) con que el bloque VUELATOUR (`ladoEnUsd`)
 * reconoce un lado incompleto.
 */
export function sufijoUsdSinTc(pagos: PagosVendedorDeVuelo): string {
  return pagos.sinTc > 0
    ? pagos.pagadoMxn != null
      ? ' (parcial: USD sin TC)'
      : ' (USD sin TC)'
    : '';
}

/**
 * Cuerpo del concepto con gasto real, SIN prefijo ni sufijo de T.C.:
 * `gasto real<pagos><cmp>` — `pagos` = ` (N pagos)` con N ≥ 2; `cmp` solo
 * con `lineaMxn` y `pagadoMxn` conocidos y `sinTc = 0`: d = round2(línea −
 * pagado) ≥ 1.00 ⇒ ` · parcial: faltan $X MXN`; d ≤ −1.00 ⇒ ` · excede $X
 * MXN`. Lo comparten `conceptoPagoVendedorReal` (egreso de VuelaTour) y
 * `conceptoPagoVendedorACargoDelAvion` (egreso $0.00: el avión ya lo
 * cargó, `comisiones-avion.util`).
 */
export function cuerpoGastoRealPagoVendedor(
  pagos: PagosVendedorDeVuelo,
  lineaMxn: number | null,
): string {
  const nPagos = pagos.n >= 2 ? ` (${pagos.n} pagos)` : '';
  let cmp = '';
  if (lineaMxn != null && pagos.pagadoMxn != null && pagos.sinTc === 0) {
    const d = round2(lineaMxn - pagos.pagadoMxn);
    if (d >= TOLERANCIA_PAGO_VENDEDOR_MXN) {
      cmp = ` · parcial: faltan $${fmtMxn(d)} MXN`;
    } else if (d <= -TOLERANCIA_PAGO_VENDEDOR_MXN) {
      cmp = ` · excede $${fmtMxn(-d)} MXN`;
    }
  }
  return `gasto real${nPagos}${cmp}`;
}

/**
 * Concepto del egreso cuando HAY gasto real (n ≥ 1). Todos empiezan con
 * `pago comisión vendedor` ⇒ `colapsarFilasDeVuelo` del Balance los
 * clasifica como «pago comisión vendedor» sin cambio.
 *
 * Gramática EXACTA:
 *  - `pagos` = ` (N pagos)` con N ≥ 2.
 *  - `usd` = ` (parcial: USD sin TC)` si alguno no convirtió y otros sí;
 *    ` (USD sin TC)` si ninguno convirtió (`sufijoUsdSinTc`).
 *  - Con línea: `pago <etiqueta> · gasto real<pagos><cmp><usd>`
 *    (`cuerpoGastoRealPagoVendedor`); `cmp` solo con `lineaMxn` y
 *    `pagadoMxn` conocidos y `sinTc = 0`: d = round2(línea − pagado) ≥ 1.00
 *    ⇒ ` · parcial: faltan $X MXN`; d ≤ −1.00 ⇒ ` · excede $X MXN`.
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
  const usd = sufijoUsdSinTc(pagos);
  if (sinLinea) {
    const nPagos = pagos.n >= 2 ? ` (${pagos.n} pagos)` : '';
    return `pago ${etiquetaComision} · ${TEXTO_SIN_LINEA_COMISION[sinLinea]}${nPagos}${usd}`;
  }
  return `pago ${etiquetaComision} · ${cuerpoGastoRealPagoVendedor(pagos, lineaMxn)}${usd}`;
}

// ===== Notas de celda del Libro Dinero (hoja «Otros ingresos») =====
// (La nota de la PROVISIÓN, `NOTA_PROVISION_PAGO_VENDEDOR`, se ELIMINÓ el
// 13-oct-2026 —invariante 61—: ya no existe provisión en ningún libro.)

/** Nota del egreso cuando el pago REAL se aparea con la comisión cobrada. */
export const NOTA_PAGO_VENDEDOR_REAL =
  'GASTO REAL: pago al vendedor capturado como «Comisión del vendedor» ligado a este vuelo. En la hoja utilidades ya está descontado de "otros ingresos".';

/** Nota de la fila de solo-egreso (pago real sin línea de comisión). */
export const NOTA_PAGO_VENDEDOR_SIN_LINEA =
  'GASTO REAL: pago al vendedor capturado como «Comisión del vendedor» en un vuelo sin comisión cobrada en la cotización (revisa la cotización o el vuelo del gasto). En la hoja utilidades ya está descontado de "otros ingresos".';
