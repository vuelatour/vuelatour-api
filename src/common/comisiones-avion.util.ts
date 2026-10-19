/**
 * COMISIONES A CARGO DEL AVIÓN (6-oct-2026, API 0.0.65, sin migración) —
 * FUENTE ÚNICA del balance por avión (columna COMISIONES, la ganancia y su
 * cascada) y del reparto a socios (`compute()`, utilidades por mes y cuenta
 * corriente). Prohibido reimplementarla en un lector: si el balance y el
 * reparto no descuentan lo mismo del mismo vuelo, el cierre no cuadra.
 *
 * Pedido del cliente: «En el balance, cuando hay una comisión de un banco,
 * en la parte de total cobrado no refleja el monto real que entró a la
 * cuenta… La comisión del banco y vendedor se puede ir a la columna de
 * (comisiones del vendedor) pero cambiar el nombre a "comisiones"… para que
 * el monto real total cobrado ya sea después de cualquier comisión. Por si no
 * le estaríamos poniendo dinero al socio.» Respuestas (6-oct-2026): la
 * comisión del vendedor la ABSORBE el avión; lo que se le cobra al cliente
 * por ese concepto se queda como ingreso de VuelaTour; vigencia desde
 * septiembre de 2026 («es el cierre que estamos haciendo»).
 *
 * VIGENCIA por `fecha_vuelo` (día Cancún) ≥ la clave de configuración
 * `comisiones_al_avion_desde` (default `COMISIONES_AL_AVION_DESDE_DEFAULT`,
 * sin migración). Desde el 13-oct-2026 (invariante 61) la vigencia gobierna
 * SOLO la parte BANCARIA: antes de ella, `aplica: false` y, si el vuelo no
 * absorbe un pago «Comisión del vendedor (avión)», todo en 0 (`lleva_
 * comisiones: false`: los libros de esos vuelos salen byte-idénticos).
 *
 * Por vuelo y por AVIÓN (lo que esa matrícula absorbe):
 *  - BANCO: por cada cobro con comisión, comisión × el MISMO factor que
 *    prorratea el cobro al avión (`factor_avion` de la partición; 1 en un
 *    CANCELADO —lo retenido es 100 % del avión— o en un vuelo sin precio) y
 *    después la parte de ESTE avión con la MISMA función que reparte la venta
 *    y el cobro (`parteAvion`: `repartirUsd` en multi-avión, el monto tal
 *    cual con un solo avión). Es el primer término de `parteFilaDeCobro`:
 *    por cobro, Σ de los aviones == round2(comisión × factor) al centavo y lo
 *    que resta (comisión − partes de los aviones) es de VuelaTour.
 *    SOBRECOBRO (revisión 6-oct-2026): lo cobrado al avión se TOPA en su
 *    venta (`cobradoParteAvion`) y el excedente es de VuelaTour («otros
 *    movimientos»); con él, el factor también se topa — cobrado al avión ÷
 *    cobrado del vuelo (`cobrosEnUsd`) — para que el avión no pague la
 *    comisión del dinero que no le toca. Sin sobrecobro, `factor_avion`.
 *    La comisión bancaria aplica en CUALQUIER estado: sigue al cobro, que el
 *    balance cuenta (un anticipo de un CONFIRMADO ya entró a la cuenta).
 *  - VENDEDOR = SOLO EL GASTO REAL «Comisión del vendedor (avión)»
 *    (13-oct-2026, API 0.0.74, invariante 61; decisión 3 del lote del
 *    cliente —«comisión del vendedor SOLO como gasto real en todos lados»—
 *    ajustada el mismo día: «necesitamos una opcion que sea Comision del
 *    vendedor pero que esa opcion si se cargue al balance del avión, y
 *    dejamos el otro que se va a balance de vuelatour»). Solo se absorben los
 *    gastos `COMISION_VENDEDOR_AVION` LIGADOS AL VUELO (`gastos` de la
 *    entrada: TODOS los gastos del vuelo, sin filtrar por avión sellado —el
 *    avión del gasto es solo referencia, invariante 31—; el lado se filtra
 *    aquí con `pagosVendedorDeVuelo(…, 'AVION')`, en JS, nunca en el query).
 *    La «Comisión del vendedor (VuelaTour)» (`COMISION_VENDEDOR`) NUNCA: la
 *    paga VuelaTour en «otros movimientos», también dentro de la vigencia.
 *    La PROVISIÓN (`pagoVendedorUsd`: comisión cotizada + IVA) YA NO resta
 *    en ningún libro: sin pago capturado el avión no resta nada del vendedor.
 *    UNIVERSO (quién la carga, nunca dos veces): vuelo COMPLETADO, o
 *    CANCELADO con cobros retenidos (`retieneCobros`: el MISMO criterio con
 *    que el reparto salta al cancelado sin cobros), y fila de un AVIÓN con
 *    parte de la venta (el lector no llama al util para EXTERNOS ni para un
 *    avión sin participación). NO exige comisión cotizada ni partición
 *    consistente ni la vigencia: la elección explícita de la categoría manda
 *    (`pagoVendedorAvionEnUniverso`). Con universo y ≥ 1 pago «(avión)» el
 *    avión lo absorbe (`vendedor_absorbido`: la SEÑAL entre libros); fuera
 *    del universo (CONFIRMADO/COTIZADO/RESERVA/SOLICITUD/EN_VUELO,
 *    CANCELADO sin cobros, vuelo sin avión de la flota) nadie lo absorbe y
 *    VuelaTour lo egresa en «otros movimientos» con el motivo en el
 *    concepto, más un pendiente en el libro que reporta.
 *    MULTI-AVIÓN: se reparte por participación (`parteAvion`/`repartirUsd`,
 *    como la venta y la bancaria) — excepción documentada a la invariante 10
 *    (es costo de la VENTA, no de un tramo): Σ de los aviones == el pago al
 *    centavo.
 *    MES EN QUE CUENTA = el del VUELO (`fecha_vuelo`, día Cancún), nunca
 *    `fecha_gasto`: los tres libros leen los gastos del vuelo por `vuelo_id`
 *    sin filtro de fecha; el pago es una partida del vuelo (se aparea con su
 *    ingreso y con la venta de ese avión en esa fila); un gasto tiene UN
 *    `vuelo_id` y un vuelo UNA `fecha_vuelo` ⇒ cae en UN mes y UN libro por
 *    construcción; el reparto arma sus vuelos por `fecha_vuelo` y así
 *    `balance.comisiones_usd == ingresos.comisiones_venta_usd` fila por fila.
 *    En los vuelos que el avión absorbe, «otros movimientos» conserva el
 *    INGRESO cobrado (una vez) y muestra el pago con egreso $0.00 «· a cargo
 *    del avión …» (gramática única `egresoPagoVendedorDeVuelo`, abajo).
 * MXN (balance) y USD (reparto) salen del MISMO recorrido:
 *  - cobro MXN: comisión MXN tal cual; USD = comisión ÷ (T.C. del cobro ?? K)
 *    — la cadena de `cobrosEnUsd`.
 *  - cobro USD: comisión USD tal cual; MXN = comisión × (T.C. del cobro ?? K)
 *    — la cadena del balance.
 *  - gasto MXN: MXN tal cual; USD = monto ÷ (tc_gasto > 0 ?? K).
 *  - gasto USD: USD tal cual; MXN = monto × (tc_gasto > 0 ?? K).
 *  - suma CRUDA y `round2` UNA vez por moneda (`pagosVendedorDeVuelo` con
 *    dos conversores inyectados), después `parteAvion`.
 *  - sin ningún T.C. ese lado no se convierte ni se suma (`banco_sin_tc`
 *    cuenta las comisiones bancarias que no llegan a MXN; `vendedor_sin_tc`
 *    = algún pago «(avión)» USD no llegó a pesos —pendiente del balance; el
 *    reparto sí lo resta en USD—; `vendedor_usd_sin_tc_n` /
 *    `vendedor_usd_sin_tc_mxn` = pagos «(avión)» MXN que no llegaron a
 *    dólares y su parte del avión en MXN, que el reparto manda a
 *    `gastos_sin_tc_mxn`; una «(VuelaTour)» NUNCA entra aquí): jamás un 0
 *    falso.
 *
 * PURO (sin Nest, sin consultas). `detalle` = la nota de la celda COMISIONES:
 * una línea por concepto y, con más de uno, el encabezado «N conceptos».
 */
import { cobrosEnUsd, retieneCobros } from './cobros-usd.util';
import {
  CATEGORIA_PAGO_VENDEDOR,
  CATEGORIA_PAGO_VENDEDOR_AVION,
  etiquetaCategoriaGasto,
  ladoPagoVendedor,
} from './categoria-gasto.util';
import {
  cobradoParteAvion,
  pagoVendedorUsd,
  sobrecobroUsd,
  type ParticionIngreso,
} from './ingreso-vuelo.util';
import { etiquetaMetodoCobro } from './metodo-cobro.util';
import {
  TEXTO_SIN_LINEA_COMISION,
  TOLERANCIA_PAGO_VENDEDOR_MXN,
  conceptoPagoVendedorReal,
  contarPagosVendedor,
  cuerpoGastoRealPagoVendedor,
  motivoSinLineaComision,
  pagosVendedorDeVuelo,
  sufijoUsdSinTc,
  type GastoPagoVendedorRow,
  type MotivoSinLineaComision,
  type PagosVendedorDeVuelo,
} from './pago-vendedor.util';

/**
 * Primer día (Cancún) de la regla cuando la configuración
 * `comisiones_al_avion_desde` no existe o no es una fecha válida.
 */
export const COMISIONES_AL_AVION_DESDE_DEFAULT = '2026-09-01';

/** Lo que el cálculo necesita de un cobro (forma de `cobro_vuelo`). */
export interface CobroComisionAvionInput {
  /**
   * Monto BRUTO del cobro en su moneda (negativo = reembolso): con
   * `cobrosEnUsd` da lo cobrado del vuelo, que detecta el SOBRECOBRO.
   */
  monto?: unknown;
  moneda?: unknown;
  tc_usd_mxn?: unknown;
  /** Comisión bancaria en la MONEDA del cobro. */
  comision_banco_monto?: unknown;
  /** % capturado (en puntos: 5 = 5 %); solo para la nota. */
  comision_banco_pct?: unknown;
  /** Código del método (`metodo_cobro`); solo para la nota. */
  metodo_cobro?: unknown;
}

export interface ComisionesDelVueloInput {
  /** Día Cancún del vuelo (YYYY-MM-DD) — eje de la vigencia. */
  diaVuelo: string | null | undefined;
  /** Primer día de la regla (`comisiones_al_avion_desde`). */
  vigenteDesde: string;
  /** Cobros del VUELO (todos; los que no traen comisión no cuentan). */
  cobros: ReadonlyArray<CobroComisionAvionInput>;
  /**
   * TODOS los gastos del VUELO (sin filtrar por avión sellado: una comisión
   * sellada a otro avión sigue siendo de este vuelo, invariante 31). El
   * util elige el lado en JS (`pagosVendedorDeVuelo(…, 'AVION')`: solo la
   * «Comisión del vendedor (avión)» se absorbe; la «(VuelaTour)» solo se
   * cuenta); los demás gastos no cuentan. OBLIGATORIO: un caller que lo
   * olvide dejaría la parte del vendedor en 0 en silencio (tsc lo delata;
   * los specs sin gastos pasan `[]`).
   */
  gastos: ReadonlyArray<GastoPagoVendedorRow>;
  /**
   * T.C. de venta del vuelo (K: el de la cotización o el oficial de su día):
   * respaldo de los cobros y de los gastos sin T.C. propio.
   */
  tcVenta: number | null | undefined;
  /** Partición del ingreso (`particionIngresoVuelo`) del vuelo. */
  particion: ParticionIngreso | null;
  /**
   * `vuelo.estado`. CANCELADO ⇒ lo retenido es 100 % del avión (factor 1);
   * el pago «(avión)» lo absorbe en COMPLETADO o en CANCELADO con cobros
   * retenidos (`pagoVendedorAvionEnUniverso`, ver la cabecera). Un solo
   * dato para las dos reglas: los lectores no pueden mandarlas
   * contradictorias.
   */
  estado: string | null | undefined;
  /**
   * Parte de ESTE avión de un monto del VUELO: la MISMA función con la que
   * el lector reparte la venta y el cobro (`repartirUsd` en multi-avión, el
   * monto tal cual con un solo avión).
   */
  parteAvion: (montoVuelo: number) => number;
  /** Fracción de este avión en la venta del vuelo (1 con un solo avión). */
  participacion: number;
  /** Quién cobra la comisión del vendedor (solo para la nota). */
  vendedorNombre?: string | null;
}

export interface ComisionesDelVuelo {
  /**
   * ¿El vuelo cae en la vigencia de la regla? Desde el 13-oct-2026 gobierna
   * SOLO la parte BANCARIA (la «(avión)» se absorbe en cualquier fecha).
   */
  aplica: boolean;
  /**
   * ¿La fila lleva la columna COMISIONES y sus llaves? `aplica` ∨
   * `vendedor_absorbido`: antes de la vigencia y sin pago «(avión)»
   * absorbido, false y la fila sale byte a byte.
   */
  lleva_comisiones: boolean;
  /** Parte del avión de la comisión bancaria (MXN, Σ por cobro). */
  banco_mxn: number;
  /** La misma parte en USD (reparto a socios). */
  banco_usd: number;
  /**
   * Pago al vendedor «Comisión del vendedor (avión)» (gastos
   * `COMISION_VENDEDOR_AVION` del vuelo) × la parte del avión, en MXN. > 0
   * SOLO con `vendedor_absorbido`.
   */
  vendedor_mxn: number;
  /** El mismo pago real × parte del avión en USD (reparto a socios). */
  vendedor_usd: number;
  total_mxn: number;
  total_usd: number;
  /** Nota de la celda COMISIONES (una línea por concepto). */
  detalle: string[];
  /** Comisiones bancarias que no llegaron a MXN (cobro USD sin T.C. ni K). */
  banco_sin_tc: number;
  /**
   * Algún pago «(avión)» absorbido (USD sin tc_gasto y sin K) no llegó a
   * pesos: no entra a COMISIONES en MXN (pendiente del balance); el reparto
   * sí lo resta en USD.
   */
  vendedor_sin_tc: boolean;
  /**
   * ¿El vuelo está en el universo de la «(avión)»? (COMPLETADO, o CANCELADO
   * con cobros retenidos: `pagoVendedorAvionEnUniverso`). Independiente de
   * los gastos y de la vigencia.
   */
  vendedor_avion_universo: boolean;
  /** Gastos «Comisión del vendedor (avión)» del vuelo (se absorban o no). */
  vendedor_avion_pagos_n: number;
  /** Gastos «Comisión del vendedor (VuelaTour)» del vuelo (solo se cuentan). */
  vendedor_vuelatour_pagos_n: number;
  /**
   * ¿ESTE avión absorbió el pago «(avión)»? `vendedor_avion_universo` ∧
   * `vendedor_avion_pagos_n` ≥ 1. Es LA SEÑAL entre libros (viaja como
   * `comision_vendedor_real_pagos > 0`), nunca `vendedor_mxn > 0`: un avión
   * sin pesos lo absorbe en USD.
   */
  vendedor_absorbido: boolean;
  /**
   * Pendiente de captura del balance: vigencia ∧ COMPLETADO ∧ partición
   * consistente ∧ comisión cotizada > 0 ∧ CERO pagos de las DOS categorías
   * (un pago de cualquiera lo apaga). No es dinero.
   */
  vendedor_pendiente_captura: boolean;
  /** Pagos «(avión)» MXN que no llegaron a dólares (sin tc_gasto ni K). */
  vendedor_usd_sin_tc_n: number;
  /** Su parte del avión en MXN (va a `gastos_sin_tc_mxn` del reparto). */
  vendedor_usd_sin_tc_mxn: number;
  /**
   * REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92), ADITIVOS y
   * SOLO cuando son > 0 (sin ellos, el objeto de siempre byte a byte): los
   * DÓLARES de la parte del avión que restaron en `total_usd` pero NO
   * llegaron a pesos — comisión bancaria de un cobro USD sin T.C. propio ni
   * K (`banco_sin_tc`) y pagos «(avión)» en USD sin `tc_gasto` ni K
   * (`vendedor_sin_tc`). El reparto los suma a `pesos_sin_tc_usd` (el saldo
   * en pesos queda incompleto y se avisa). El balance no los usa.
   */
  banco_sin_pesos_usd?: number;
  vendedor_sin_pesos_usd?: number;
}

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/** Número positivo o null (montos, T.C. y %; numeric de PostgREST = string). */
const pos = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
};

/** «$20,400.00» (2 decimales es-MX, como las notas del libro); «-$5.00». */
export function fmtMxnNota(n: number): string {
  const r = round2(n);
  const cuerpo = Math.abs(r).toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return r < 0 ? `-$${cuerpo}` : `$${cuerpo}`;
}

/** 5 → «5», 3.828 → «3.83», 5.0001 → «5» (hasta 2 decimales). */
export function fmtPctNota(puntos: number): string {
  return (Math.round(puntos * 100) / 100).toLocaleString('es-MX', {
    maximumFractionDigits: 2,
  });
}

/** ¿El vuelo de ese día (Cancún) cae en la vigencia? Sin día ⇒ no. */
export function aplicaComisionesAlAvion(
  diaVuelo: string | null | undefined,
  vigenteDesde: string,
): boolean {
  if (typeof diaVuelo !== 'string') return false;
  const dia = diaVuelo.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dia) && dia >= vigenteDesde;
}

const MESES_CORTOS = [
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
 * «regla sep-2026» (vigencia el día 1) o «regla desde 15-oct-2026»: el
 * nombre de la regla en los textos sale de la vigencia CONFIGURADA, nunca
 * fijo.
 */
export function etiquetaReglaComisiones(vigenteDesde: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(vigenteDesde);
  if (!m) return `regla desde ${vigenteDesde}`;
  const mes = MESES_CORTOS[Number(m[2]) - 1] ?? m[2];
  return m[3] === '01'
    ? `regla ${mes}-${m[1]}`
    : `regla desde ${m[3]}-${mes}-${m[1]}`;
}

/**
 * Lo que UN avión cargó del pago «Comisión del vendedor (avión)» de UN
 * vuelo: el `comision_vendedor_real_mxn` de la fila del vuelo en el libro de
 * ese avión TAL CUAL (nadie lo recalcula en «otros movimientos») y si lo
 * absorbió (`comision_vendedor_real_pagos > 0`; la señal es esa, NO
 * `vendedor_mxn > 0`: un avión sin pesos —gasto USD sin tc_gasto y vuelo
 * sin K— lo absorbe en USD en su reparto y aquí trae 0).
 */
export interface ComisionVendedorDeAvion {
  matricula: string;
  vendedor_mxn: number;
  absorbido: boolean;
}

/**
 * Sufijo del egreso del vendedor en «otros movimientos» cuando el pago
 * «Comisión del vendedor (avión)» ya lo cargan los aviones en su columna
 * COMISIONES (13-oct-2026, API 0.0.74, invariante 61). Lista = los aviones
 * `absorbido`; vacía ⇒ ''. `pagadoMxn` = lo pagado como «(avión)» con la
 * cadena de la pestaña (no el total del vuelo).
 *  - Un avión: ` · a cargo del avión XB-PEV ($3,000.00 en su columna
 *    COMISIONES)`; varios: ` · a cargo de los aviones XB-TST ($900.00 en su
 *    columna COMISIONES) y XB-DOS ($900.00 en su columna COMISIONES)`.
 *  - La cifra del avión se imprime SOLO si todos los aviones tienen pesos y
 *    |Σ partes − `pagadoMxn` de la pestaña| < `TOLERANCIA_PAGO_VENDEDOR_MXN`
 *    (las cadenas de T.C. de los libros pueden diferir con un pago USD sin
 *    tc_gasto: un solo monto por fila, nunca dos que no cuadran); si no,
 *    `XB-PEV (resta en su columna COMISIONES)`.
 *  - Avión sin pesos: `XB-PEV (sin T.C. no entra en pesos a su columna
 *    COMISIONES; resta en USD en su reparto)`.
 */
export function sufijoPagoVendedorACargoDelAvion(
  aviones: ReadonlyArray<ComisionVendedorDeAvion>,
  pagadoMxn: number | null,
): string {
  const lista = aviones.filter((x) => x.absorbido);
  if (lista.length === 0) return '';
  const sumaPartes = round2(lista.reduce((s, x) => s + x.vendedor_mxn, 0));
  const conMonto =
    pagadoMxn != null &&
    lista.every((x) => x.vendedor_mxn > 0) &&
    Math.abs(sumaPartes - pagadoMxn) < TOLERANCIA_PAGO_VENDEDOR_MXN;
  const parte = (x: ComisionVendedorDeAvion): string =>
    conMonto
      ? `${x.matricula} (${fmtMxnNota(x.vendedor_mxn)} en su columna COMISIONES)`
      : x.vendedor_mxn > 0
        ? `${x.matricula} (resta en su columna COMISIONES)`
        : `${x.matricula} (sin T.C. no entra en pesos a su columna COMISIONES; resta en USD en su reparto)`;
  const partes = lista.map(parte);
  return partes.length === 1
    ? ` · a cargo del avión ${partes[0]}`
    : ` · a cargo de los aviones ${partes.slice(0, -1).join(', ')} y ${
        partes[partes.length - 1]
      }`;
}

/**
 * Concepto del egreso del vendedor en «otros movimientos» cuando ALGÚN avión
 * carga el pago «Comisión del vendedor (avión)» del vuelo:
 * `pago <etiqueta> · <cuerpo><tramo VuelaTour><sufijo de los aviones>`.
 *  - `pagos` = TODOS los pagos del vuelo (las dos categorías): de ahí salen
 *    « (N pagos)» y «faltan/excede» (vs lo COBRADO con la cadena de la
 *    pestaña, tolerancia 1.00 — `cuerpoGastoRealPagoVendedor`). Sin línea que
 *    aparear (`sinLinea`): el texto del motivo + « (N pagos)».
 *  - Tramo VuelaTour (solo con pagos «(VuelaTour)»): « · VuelaTour $X» y SU
 *    marca « (USD sin TC)» / « (parcial: USD sin TC)» — es el único egreso
 *    real de la fila; la marca anula el lado en el bloque VUELATOUR
 *    (`ladoEnUsd`) solo cuando ese egreso de verdad está incompleto.
 *  - `pagosAvion` (OBLIGATORIO) da la cifra del sufijo
 *    (`sufijoPagoVendedorACargoDelAvion`).
 * Con `pagos` = `pagosAvion`, sin VuelaTour ni `sinLinea`, sale byte a byte
 * la de la D3. Todos empiezan con `pago comisión vendedor`
 * (`colapsarFilasDeVuelo` los clasifica sin cambio).
 */
export function conceptoPagoVendedorACargoDelAvion(a: {
  /** 'comisión vendedor (Pablo Canales)' | 'comisión vendedor'. */
  etiquetaComision: string;
  /** TODOS los pagos al vendedor del vuelo (`pagosVendedorDeVuelo(…, 'AMBOS')`). */
  pagos: PagosVendedorDeVuelo;
  /** Los pagos «(avión)» (`pagosVendedorDeVuelo(…, 'AVION')`). */
  pagosAvion: PagosVendedorDeVuelo;
  /** Los pagos «(VuelaTour)», si los hay (`…, 'VUELATOUR'`). */
  pagosVuelatour?: PagosVendedorDeVuelo;
  /** Σ ingreso MXN de las líneas de comisión; null = sin T.C. de venta. */
  lineaMxn: number | null;
  /** Presente ⇒ el vuelo no trae línea de comisión que aparear. */
  sinLinea?: MotivoSinLineaComision;
  /** Las partes de los aviones (los no absorbidos no aparecen). */
  aviones: ReadonlyArray<ComisionVendedorDeAvion>;
}): string {
  const cuerpo = a.sinLinea
    ? `${TEXTO_SIN_LINEA_COMISION[a.sinLinea]}${
        a.pagos.n >= 2 ? ` (${a.pagos.n} pagos)` : ''
      }`
    : cuerpoGastoRealPagoVendedor(a.pagos, a.lineaMxn);
  const vt = a.pagosVuelatour;
  const tramoVt =
    vt != null && vt.n > 0
      ? ` · VuelaTour${
          vt.pagadoMxn != null ? ` ${fmtMxnNota(vt.pagadoMxn)}` : ''
        }${sufijoUsdSinTc(vt)}`
      : '';
  return `pago ${a.etiquetaComision} · ${cuerpo}${tramoVt}${sufijoPagoVendedorACargoDelAvion(
    a.aviones,
    a.pagosAvion.pagadoMxn,
  )}`;
}

// ===== «Comisión del vendedor (avión)» que NINGÚN avión carga =====
// (13-oct-2026, invariante 61). Fuera del universo (o sin fila de avión) la
// paga VuelaTour en «otros movimientos» y el concepto dice por qué; el libro
// que reporta el vuelo lo lista en pendientes.

/** Etiquetas canónicas de las dos categorías (tabla de categoria-gasto). */
const ETIQUETA_PAGO_AVION = etiquetaCategoriaGasto(
  CATEGORIA_PAGO_VENDEDOR_AVION,
);
const ETIQUETA_PAGO_VUELATOUR = etiquetaCategoriaGasto(CATEGORIA_PAGO_VENDEDOR);

/**
 * ¿El vuelo está en el universo de la «Comisión del vendedor (avión)»?
 * COMPLETADO ⇒ sí; CANCELADO ⇒ solo si retuvo cobros (`retieneCobros` sobre
 * `cobrosEnUsd` con el T.C. de venta de respaldo: el MISMO criterio con que
 * el reparto lee al cancelado); cualquier otro estado ⇒ no. No mira la
 * vigencia, la comisión cotizada ni la partición. Puro.
 */
export function pagoVendedorAvionEnUniverso(a: {
  estado: string | null | undefined;
  cobros: ReadonlyArray<CobroComisionAvionInput>;
  tcVenta: number | null | undefined;
}): boolean {
  if (a.estado === 'COMPLETADO') return true;
  if (a.estado === 'CANCELADO') {
    return retieneCobros(cobrosEnUsd([...a.cobros], pos(a.tcVenta)));
  }
  return false;
}

/** Por qué un pago «(avión)» no lo carga ningún avión. */
export type MotivoPagoVendedorAvionSinCargo =
  | 'SIN_AVION'
  | 'CANCELADO'
  | 'NO_COMPLETADO'
  | 'SIN_FILA';

/**
 * Motivo, en ESTE orden: sin avión de la flota (gana: un externo sin avión
 * cancelado dice «sin avión») ⇒ CANCELADO (sin cobros retenidos: con ellos
 * estaría en el universo) ⇒ no COMPLETADO ⇒ SIN_FILA (defensivo: en el
 * universo y con avión, pero ningún libro de avión lo cargó).
 */
export function motivoPagoVendedorAvionSinCargo(a: {
  estado: string | null | undefined;
  tieneAvion: boolean;
}): MotivoPagoVendedorAvionSinCargo {
  if (!a.tieneAvion) return 'SIN_AVION';
  if (a.estado === 'CANCELADO') return 'CANCELADO';
  if (a.estado !== 'COMPLETADO') return 'NO_COMPLETADO';
  return 'SIN_FILA';
}

/** Texto de cada motivo (concepto de la pestaña y pendiente del balance). */
export const TEXTO_PAGO_VENDEDOR_AVION_SIN_CARGO: Readonly<
  Record<MotivoPagoVendedorAvionSinCargo, string>
> = {
  SIN_AVION: 'vuelo sin avión de la flota',
  CANCELADO: 'vuelo cancelado sin cobros retenidos',
  NO_COMPLETADO:
    'el vuelo aún no se completa: al completarse lo cargará el avión',
  SIN_FILA: 'ningún libro de avión la cargó',
};

/**
 * Sufijo del concepto cuando la «(avión)» la paga VuelaTour (nadie la
 * carga): ` · incluye «Comisión del vendedor (avión)» que ningún avión carga
 * (<motivo>): la paga VuelaTour`. Nunca lleva «sin TC» (esa marca la pone,
 * si toca, el cuerpo de `conceptoPagoVendedorReal`).
 */
export function sufijoPagoVendedorAvionSinCargo(
  m: MotivoPagoVendedorAvionSinCargo,
): string {
  return ` · incluye «${ETIQUETA_PAGO_AVION}» que ningún avión carga (${TEXTO_PAGO_VENDEDOR_AVION_SIN_CARGO[m]}): la paga VuelaTour`;
}

// ===== Pendientes del balance (una vez por vuelo, en el avión que reporta) =====

/**
 * Vigencia ∧ COMPLETADO ∧ partición consistente ∧ comisión cotizada ∧ CERO
 * pagos de las dos categorías: el checklist que reemplazó al amarillo de la
 * provisión. `usd` = comisión + IVA cotizados (`pagoVendedorUsd`).
 */
export function textoPendienteCapturaVendedor(
  etiqueta: string,
  usd: number,
): string {
  return `${etiqueta}: comisión del vendedor cotizada (${fmtMxnNota(usd)} USD) sin pago capturado — captúralo en Gastos ligado a este vuelo como «${ETIQUETA_PAGO_AVION}» si lo carga el avión (resta en su columna COMISIONES) o como «${ETIQUETA_PAGO_VUELATOUR}» si lo paga VuelaTour ('otros movimientos' del Balance general)`;
}

/** Pago «(avión)» absorbido en USD sin ningún T.C.: no llega a pesos. */
export function textoPendienteVendedorSinTc(etiqueta: string): string {
  return `${etiqueta}: pago al vendedor «${ETIQUETA_PAGO_AVION}» en USD sin T.C. (ni tc_gasto ni T.C. de venta) — no entra a COMISIONES en pesos; en el reparto sí resta en USD (captura el T.C. del gasto o el de la cotización)`;
}

/** N gastos «(avión)» del vuelo que ningún avión carga (y por qué). */
export function textoPendientePagoVendedorAvionSinCargo(
  etiqueta: string,
  n: number,
  m: MotivoPagoVendedorAvionSinCargo,
): string {
  const plural = n >= 2;
  return `${etiqueta}: ${plural ? `${n} gastos` : 'gasto'} «${ETIQUETA_PAGO_AVION}» que ningún avión carga (${TEXTO_PAGO_VENDEDOR_AVION_SIN_CARGO[m]}) — ${
    plural ? 'los paga' : 'lo paga'
  } VuelaTour en 'otros movimientos' del Balance general; si el pago es de VuelaTour, ${
    plural ? 'reclasifícalos' : 'reclasifícalo'
  } a «${ETIQUETA_PAGO_VUELATOUR}»`;
}

// ===== «Otros movimientos»: GRAMÁTICA ÚNICA del egreso del vendedor =====

/**
 * Egreso del vendedor de UN vuelo en «otros movimientos» (13-oct-2026,
 * invariante 61): la ÚNICA gramática (8 casos del contrato §D).
 *  - Sin pagos (de ninguna de las dos) ⇒ null: la fila no lleva egreso.
 *  - Algún avión CARGA la «(avión)» (`pagosAvion.n > 0` y alguna parte
 *    `absorbido`, de las FILAS de los libros: aquí NUNCA se recalcula el
 *    universo) ⇒ egreso = SOLO lo de VuelaTour (0 si no hay «(VuelaTour)»;
 *    null si ninguna «(VuelaTour)» convierte) y el concepto «… · a cargo del
 *    avión …» (`conceptoPagoVendedorACargoDelAvion`, con el tramo
 *    «· VuelaTour $X» en el mixto). Fecha: la del pago más reciente de
 *    VuelaTour o, sin él, de la «(avión)»; sin fecha, la del vuelo.
 *  - Nadie la carga ⇒ VuelaTour egresa TODO (las dos categorías) con las
 *    ramas de siempre (`conceptoPagoVendedorReal`, byte a byte sin «(avión)»)
 *    y, si hay «(avión)», el sufijo con el motivo.
 */
export function egresoPagoVendedorDeVuelo(a: {
  etiquetaComision: string;
  pagosVuelatour: PagosVendedorDeVuelo;
  pagosAvion: PagosVendedorDeVuelo;
  pagosTodos: PagosVendedorDeVuelo;
  /** Σ ingreso MXN de la línea de comisión; null = sin línea / sin T.C. */
  lineaMxn: number | null;
  /** Presente ⇒ fila de solo-egreso (sin línea que aparear). */
  sinLinea?: MotivoSinLineaComision;
  aviones: ReadonlyArray<ComisionVendedorDeAvion>;
  motivoSinCargo: MotivoPagoVendedorAvionSinCargo;
  fechaVuelo: string | null;
}): {
  egresoMxn: number | null;
  concepto: string;
  fecha: string | null;
} | null {
  if (a.pagosTodos.n === 0) return null;
  const avionCargo = a.pagosAvion.n > 0 && a.aviones.some((x) => x.absorbido);
  if (avionCargo) {
    const conVuelatour = a.pagosVuelatour.n > 0;
    return {
      egresoMxn: conVuelatour
        ? a.pagosVuelatour.pagadoMxn != null
          ? round2(a.pagosVuelatour.pagadoMxn)
          : null
        : 0,
      concepto: conceptoPagoVendedorACargoDelAvion({
        etiquetaComision: a.etiquetaComision,
        pagos: a.pagosTodos,
        pagosAvion: a.pagosAvion,
        pagosVuelatour: a.pagosVuelatour,
        lineaMxn: a.lineaMxn,
        sinLinea: a.sinLinea,
        aviones: a.aviones,
      }),
      fecha:
        (conVuelatour ? a.pagosVuelatour.fecha : a.pagosAvion.fecha) ??
        a.fechaVuelo,
    };
  }
  return {
    egresoMxn:
      a.pagosTodos.pagadoMxn != null ? round2(a.pagosTodos.pagadoMxn) : null,
    concepto:
      conceptoPagoVendedorReal({
        etiquetaComision: a.etiquetaComision,
        pagos: a.pagosTodos,
        lineaMxn: a.lineaMxn,
        sinLinea: a.sinLinea,
      }) +
      (a.pagosAvion.n > 0
        ? sufijoPagoVendedorAvionSinCargo(a.motivoSinCargo)
        : ''),
    fecha: a.pagosTodos.fecha,
  };
}

// ===== Libro Dinero (caja de VuelaTour): qué parte es «(avión)» =====
// Este libro resta UNA vez los pagos de las DOS categorías (el dinero salió
// de VuelaTour); estos textos solo dicen qué parte es «(avión)» y si la
// carga un avión en el Balance general. '' sin pagos «(avión)»; jamás «sin
// TC».

/** Sufijo del concepto del egreso del vendedor en «Otros ingresos». */
export function sufijoParteAvionDinero(
  pagosAvion: PagosVendedorDeVuelo,
  avionLaCarga: boolean,
): string {
  if (pagosAvion.n === 0) return '';
  if (!avionLaCarga) {
    return ` · incluye «${ETIQUETA_PAGO_AVION}» que ningún avión carga`;
  }
  const monto =
    pagosAvion.pagadoMxn != null
      ? ` por ${fmtMxnNota(pagosAvion.pagadoMxn)}`
      : '';
  return ` · incluye «${ETIQUETA_PAGO_AVION}»${monto}: la resta el avión en el Balance general`;
}

/** Nota de la celda del egreso del vendedor en «Otros ingresos». */
export function notaParteAvionDinero(
  pagosAvion: PagosVendedorDeVuelo,
  avionLaCarga: boolean,
): string {
  if (pagosAvion.n === 0) return '';
  if (!avionLaCarga) {
    return ` Incluye pagos «${ETIQUETA_PAGO_AVION}» de un vuelo que ningún avión carga: también en el Balance general los paga VuelaTour.`;
  }
  const cuanto =
    pagosAvion.pagadoMxn != null
      ? `${fmtMxnNota(pagosAvion.pagadoMxn)} MXN`
      : 'una parte';
  return ` De ese pago, ${cuanto} se capturó como «${ETIQUETA_PAGO_AVION}»: en el Balance general y en el reparto lo resta el avión (columna COMISIONES); este libro registra la salida de dinero de VuelaTour.`;
}

/**
 * Sufijo del egreso «comisión bancaria» de VuelaTour cuando los aviones ya
 * absorbieron su parte (la pestaña queda SOLO con la parte de VuelaTour).
 */
export const SUFIJO_COMISION_BANCO_PARTE_VUELATOUR =
  ' (parte VuelaTour: la del avión va en su columna COMISIONES)';

/** «(parte del avión 89.69 %: $313.90)» o «(parte del avión 100 %)». */
function textoParte(
  fraccion: number,
  totalMxn: number,
  parteMxn: number,
): string {
  const pct = fmtPctNota(fraccion * 100);
  return round2(parteMxn) === round2(totalMxn)
    ? ` (parte del avión ${pct} %)`
    : ` (parte del avión ${pct} %: ${fmtMxnNota(parteMxn)})`;
}

/**
 * El MISMO factor con que el cobro se prorratea al avión
 * (`cobradoParteAvion`): venta del avión ÷ total del cliente; con SOBRECOBRO
 * (lo cobrado del vuelo, `cobrosEnUsd` con K de respaldo, supera el total)
 * se topa como allá — cobrado al avión ÷ cobrado del vuelo —: el excedente y
 * su comisión son de VuelaTour. CANCELADO o sin precio ⇒ 1 (lo retenido es
 * 100 % del avión).
 */
function factorCobroAvion(
  cobros: ReadonlyArray<CobroComisionAvionInput>,
  k: number | null,
  p: ParticionIngreso | null,
  cancelado: boolean,
): number {
  if (cancelado || p == null || !(p.total_usd > 0)) return 1;
  const cobradoUsd = cobrosEnUsd([...cobros], k).total_usd;
  if (cobradoUsd > 0 && sobrecobroUsd(cobradoUsd, p) > 0) {
    return Math.min(
      p.factor_avion,
      cobradoParteAvion(cobradoUsd, p) / cobradoUsd,
    );
  }
  return p.factor_avion;
}

const VACIO: Omit<ComisionesDelVuelo, 'aplica' | 'detalle'> = {
  lleva_comisiones: false,
  banco_mxn: 0,
  banco_usd: 0,
  vendedor_mxn: 0,
  vendedor_usd: 0,
  total_mxn: 0,
  total_usd: 0,
  banco_sin_tc: 0,
  vendedor_sin_tc: false,
  vendedor_avion_universo: false,
  vendedor_avion_pagos_n: 0,
  vendedor_vuelatour_pagos_n: 0,
  vendedor_absorbido: false,
  vendedor_pendiente_captura: false,
  vendedor_usd_sin_tc_n: 0,
  vendedor_usd_sin_tc_mxn: 0,
};

/**
 * Comisiones que ESTE avión absorbe de UN vuelo. Ver la cabecera del
 * archivo para la regla completa: la parte BANCARIA solo en la vigencia
 * (`aplica`); la «Comisión del vendedor (avión)» con el universo
 * (`vendedor_absorbido`, en cualquier fecha). Sin ninguna de las dos
 * (`lleva_comisiones: false`) todo en 0 y la fila sale byte a byte.
 */
export function comisionesDelVuelo(
  i: ComisionesDelVueloInput,
): ComisionesDelVuelo {
  const aplica = aplicaComisionesAlAvion(i.diaVuelo, i.vigenteDesde);
  const p = i.particion;
  const cancelado = i.estado === 'CANCELADO';
  const completado = i.estado === 'COMPLETADO';
  const k = pos(i.tcVenta);
  // ----- Universo y contadores del pago al vendedor (dos categorías) -----
  const universo = pagoVendedorAvionEnUniverso({
    estado: i.estado,
    cobros: i.cobros,
    tcVenta: i.tcVenta,
  });
  const nAvion = contarPagosVendedor(i.gastos, 'AVION');
  const nVuelatour = contarPagosVendedor(i.gastos, 'VUELATOUR');
  const absorbido = universo && nAvion > 0;
  // Checklist de captura (no es dinero): solo en la vigencia, con comisión
  // cotizada y partición consistente, y SIN pago de ninguna de las dos.
  const pendienteCaptura =
    aplica &&
    completado &&
    p != null &&
    !p.inconsistente &&
    pagoVendedorUsd(p) > 0 &&
    nAvion + nVuelatour === 0;
  const contadores = {
    vendedor_avion_universo: universo,
    vendedor_avion_pagos_n: nAvion,
    vendedor_vuelatour_pagos_n: nVuelatour,
    vendedor_absorbido: absorbido,
    vendedor_pendiente_captura: pendienteCaptura,
  };
  if (!aplica && !absorbido) {
    return {
      aplica: false,
      ...VACIO,
      ...contadores,
      lleva_comisiones: false,
      detalle: [],
    };
  }
  const participacion = i.participacion > 0 ? i.participacion : 0;
  const lineas: string[] = [];

  // ----- Comisión BANCARIA de cada cobro (SOLO en la vigencia) -----
  let bancoMxn = 0;
  let bancoUsd = 0;
  let bancoSinTc = 0;
  // Dólares de la parte del avión sin pesos (reparto en pesos, 0.0.94).
  let bancoSinPesosUsd = 0;
  if (aplica) {
    const factorCobro = factorCobroAvion(i.cobros, k, p, cancelado);
    for (const c of i.cobros) {
      const com = pos(c.comision_banco_monto);
      if (com == null) continue;
      const tc = pos(c.tc_usd_mxn) ?? k;
      const esMxn = c.moneda === 'MXN';
      const comMxn = esMxn ? round2(com) : tc != null ? round2(com * tc) : null;
      const comUsd = esMxn
        ? tc != null
          ? round2(com / tc)
          : null
        : round2(com);
      const parteMxn =
        comMxn != null ? i.parteAvion(round2(comMxn * factorCobro)) : null;
      const parteUsd =
        comUsd != null ? i.parteAvion(round2(comUsd * factorCobro)) : null;
      if (parteMxn != null) bancoMxn += parteMxn;
      else {
        bancoSinTc += 1;
        if (parteUsd != null) bancoSinPesosUsd += parteUsd;
      }
      if (parteUsd != null) bancoUsd += parteUsd;

      const metodo =
        typeof c.metodo_cobro === 'string' && c.metodo_cobro.trim()
          ? etiquetaMetodoCobro(c.metodo_cobro.trim())
          : null;
      const pct = pos(c.comision_banco_pct);
      const como = [metodo, pct != null ? `${fmtPctNota(pct)} %` : null]
        .filter(Boolean)
        .join(' ');
      const monto =
        comMxn == null
          ? `${fmtMxnNota(com)} USD sin T.C. — no suma`
          : esMxn
            ? fmtMxnNota(comMxn)
            : `${fmtMxnNota(com)} USD = ${fmtMxnNota(comMxn)}`;
      const parte =
        comMxn != null && parteMxn != null
          ? textoParte(factorCobro * participacion, comMxn, parteMxn)
          : '';
      lineas.push(
        ['Comisión bancaria', como || null, `${monto}${parte}`]
          .filter(Boolean)
          .join(' · '),
      );
    }
  }

  // ----- Pago «Comisión del vendedor (avión)» (SOLO con `absorbido`) -----
  // Universo (ver la cabecera) ∧ ≥ 1 pago «(avión)»: fuera de él el avión
  // manda 0 aunque haya gastos (VuelaTour los paga en «otros movimientos»).
  // La «(VuelaTour)» NUNCA entra aquí. Sin pago capturado NADA resta.
  const montoDe = (g: GastoPagoVendedorRow): number | null => {
    const m = Number(g.monto);
    return Number.isFinite(m) ? m : null;
  };
  // T.C. del gasto: su `tc_gasto` (> 0) o, sin él, el K del vuelo.
  const tcDe = (g: GastoPagoVendedorRow): number | null => pos(g.tc_gasto) ?? k;
  const aMxn = (g: GastoPagoVendedorRow): number | null => {
    const m = montoDe(g);
    if (m == null) return null;
    if (g.moneda === 'MXN') return m;
    const tc = tcDe(g);
    return tc != null ? m * tc : null;
  };
  const aUsd = (g: GastoPagoVendedorRow): number | null => {
    const m = montoDe(g);
    if (m == null) return null;
    if (g.moneda !== 'MXN') return m;
    const tc = tcDe(g);
    return tc != null ? m / tc : null;
  };
  let vendedorMxn = 0;
  let vendedorUsd = 0;
  let vendedorSinTc = false;
  let vendedorUsdSinTcN = 0;
  let vendedorUsdSinTcMxn = 0;
  let vendedorSinPesosUsd = 0;
  if (absorbido) {
    const pagosMxn = pagosVendedorDeVuelo(i.gastos, aMxn, 'AVION');
    // OJO: `pagadoMxn` de ESTA llamada son DÓLARES — es «la suma convertida
    // por el conversor inyectado» (`sinTc` = pagos MXN que no llegaron a USD).
    const pagosUsd = pagosVendedorDeVuelo(i.gastos, aUsd, 'AVION');
    vendedorMxn = i.parteAvion(pagosMxn.pagadoMxn ?? 0);
    vendedorUsd = i.parteAvion(pagosUsd.pagadoMxn ?? 0);
    vendedorSinTc = pagosMxn.sinTc > 0;
    if (vendedorSinTc) {
      // REPARTO EN PESOS (0.0.94): los dólares (parte del avión) de los pagos
      // «(avión)» que restaron en USD y no llegaron a pesos.
      const sinPesos = pagosVendedorDeVuelo(
        i.gastos.filter((g) => aMxn(g) == null),
        aUsd,
        'AVION',
      );
      vendedorSinPesosUsd = i.parteAvion(sinPesos.pagadoMxn ?? 0);
    }
    vendedorUsdSinTcN = pagosUsd.sinTc;
    if (pagosUsd.sinTc > 0) {
      // Pagos «(avión)» MXN sin tc_gasto ni K: no llegan a USD — su parte del
      // avión va a `gastos_sin_tc_mxn` del reparto (integridad de siempre).
      // Filtro EXACTO por lado: una «(VuelaTour)» MXN sin K jamás cae aquí.
      const mxnSinUsd = i.gastos
        .filter(
          (g) =>
            ladoPagoVendedor(g.categoria ?? null) === 'AVION' &&
            g.moneda === 'MXN' &&
            tcDe(g) == null,
        )
        .reduce((s, g) => s + (montoDe(g) ?? 0), 0);
      vendedorUsdSinTcMxn = i.parteAvion(round2(mxnSinUsd));
    }
    const nombre =
      typeof i.vendedorNombre === 'string' && i.vendedorNombre.trim()
        ? ` (${i.vendedorNombre.trim()})`
        : '';
    const nPagos = pagosMxn.n >= 2 ? ` (${pagosMxn.n} pagos)` : '';
    // Sin línea de comisión que aparear (CANCELADO, partición inconsistente
    // o sin comisión cotizada): la nota lo dice con el MISMO motivo que la
    // fila de solo-egreso de «otros movimientos» y del Libro Dinero.
    const sinLinea =
      cancelado || p == null || p.inconsistente || pagoVendedorUsd(p) <= 0
        ? ` · ${
            TEXTO_SIN_LINEA_COMISION[
              motivoSinLineaComision({
                cancelado,
                inconsistente: p?.inconsistente ?? false,
                comisionVendedorUsd: p?.comision_vendedor_usd ?? 0,
              })
            ]
          }`
        : '';
    if (pagosMxn.pagadoMxn != null) {
      const totalMxn = pagosMxn.pagadoMxn;
      const parte =
        round2(vendedorMxn) === round2(totalMxn)
          ? ''
          : textoParte(participacion, totalMxn, vendedorMxn);
      const sinTc =
        pagosMxn.sinTc === 0
          ? ''
          : pagosMxn.sinTc === 1
            ? ' · 1 pago USD sin T.C. — no suma en pesos'
            : ` · ${pagosMxn.sinTc} pagos USD sin T.C. — no suman en pesos`;
      lineas.push(
        `Comisión vendedor${nombre} · ${fmtMxnNota(totalMxn)} · gasto real${nPagos}${parte}${sinTc}${sinLinea}`,
      );
    } else {
      // Ningún pago llegó a pesos (todos USD sin tc_gasto y vuelo sin K): el
      // reparto sí lo resta en USD; en el balance lo grita el pendiente.
      // (`pagosUsd.pagadoMxn` son DÓLARES: la suma del conversor a USD.)
      lineas.push(
        `Comisión vendedor${nombre} · ${fmtMxnNota(pagosUsd.pagadoMxn ?? 0)} USD sin T.C. — no suma en pesos${sinLinea}`,
      );
    }
  }

  const banco_mxn = round2(bancoMxn);
  const banco_usd = round2(bancoUsd);
  const vendedor_mxn = round2(vendedorMxn);
  const vendedor_usd = round2(vendedorUsd);
  if (lineas.length > 1) lineas.unshift(`${lineas.length} conceptos`);
  return {
    aplica,
    lleva_comisiones: true,
    banco_mxn,
    banco_usd,
    vendedor_mxn,
    vendedor_usd,
    total_mxn: round2(banco_mxn + vendedor_mxn),
    total_usd: round2(banco_usd + vendedor_usd),
    detalle: lineas,
    banco_sin_tc: bancoSinTc,
    vendedor_sin_tc: vendedorSinTc,
    ...contadores,
    vendedor_usd_sin_tc_n: vendedorUsdSinTcN,
    vendedor_usd_sin_tc_mxn: round2(vendedorUsdSinTcMxn),
    // ADITIVOS (0.0.94, invariante 92): SOLO cuando son > 0.
    ...(bancoSinPesosUsd > 0
      ? { banco_sin_pesos_usd: round2(bancoSinPesosUsd) }
      : {}),
    ...(vendedorSinPesosUsd > 0
      ? { vendedor_sin_pesos_usd: round2(vendedorSinPesosUsd) }
      : {}),
  };
}
