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
 * sin migración). Antes de la vigencia NADA cambia: `aplica: false` y todo
 * en 0 (los libros de esos vuelos salen byte-idénticos).
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
 *  - VENDEDOR = SOLO EL GASTO REAL (13-oct-2026, API 0.0.74, invariante 61;
 *    decisión 3 del lote del cliente: «comisión del vendedor SOLO como gasto
 *    real en todos lados»). Lo que resta es Σ de los gastos
 *    `COMISION_VENDEDOR` LIGADOS AL VUELO (`gastos` de la entrada: TODOS los
 *    gastos del vuelo, sin filtrar por avión sellado —el avión del gasto es
 *    solo referencia, invariante 31—; la categoría se filtra aquí con
 *    `pagosVendedorDeVuelo`, en JS, nunca en el query). La PROVISIÓN
 *    (`pagoVendedorUsd`: comisión cotizada + IVA) YA NO resta en ningún
 *    libro: sin gasto capturado el avión no resta nada (COMISIONES = solo su
 *    parte de la comisión bancaria, que es REAL).
 *    QUIÉN LA CARGA (nunca dos veces) — universo EXACTO de la invariante 50
 *    más n ≥ 1: el avión absorbe el pago real cuando el vuelo está en la
 *    vigencia ∧ `estado === 'COMPLETADO'` ∧ partición consistente ∧
 *    `pagoVendedorUsd(p) > 0` ∧ la fila es de un AVIÓN con parte de la
 *    venta (el lector no llama al util para EXTERNOS) ∧ hay gastos. Esa
 *    puerta es `vendedor_absorbe` (independiente de los gastos: con ella y
 *    n = 0 el balance grita el pendiente de captura). Fuera de ella (antes
 *    de la vigencia, CONFIRMADO/COTIZADO/RESERVA/EN_VUELO, CANCELADO,
 *    partición inconsistente, sin comisión cotizada, EXTERNOS) el avión
 *    manda 0 y VuelaTour paga el gasto real en «otros movimientos» con sus
 *    ramas de siempre. En los vuelos que el avión absorbe, «otros
 *    movimientos» conserva el INGRESO cobrado (una vez) y muestra el pago
 *    con egreso $0.00 «· a cargo del avión …»
 *    (`conceptoPagoVendedorACargoDelAvion`, abajo).
 *    MES EN QUE CUENTA = el del VUELO (`fecha_vuelo`, día Cancún), nunca
 *    `fecha_gasto`: los tres libros leen los gastos del vuelo por `vuelo_id`
 *    sin filtro de fecha; el pago es una partida del vuelo (se aparea con su
 *    ingreso y con la venta de ese avión en esa fila); un gasto tiene UN
 *    `vuelo_id` y un vuelo UNA `fecha_vuelo` ⇒ cae en UN mes y UN libro por
 *    construcción; el reparto arma sus vuelos por `fecha_vuelo` y así
 *    `balance.comisiones_usd == ingresos.comisiones_venta_usd` fila por fila.
 *
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
 *    = algún pago USD no llegó a pesos —pendiente del balance; el reparto sí
 *    lo resta en USD—; `vendedor_usd_sin_tc_n` / `vendedor_usd_sin_tc_mxn`
 *    = pagos MXN que no llegaron a dólares y su parte del avión en MXN, que
 *    el reparto manda a `gastos_sin_tc_mxn`): jamás un 0 falso.
 *
 * PURO (sin Nest, sin consultas). `detalle` = la nota de la celda COMISIONES:
 * una línea por concepto y, con más de uno, el encabezado «N conceptos».
 */
import { cobrosEnUsd } from './cobros-usd.util';
import { categoriaEsPagoVendedor } from './categoria-gasto.util';
import {
  cobradoParteAvion,
  pagoVendedorUsd,
  sobrecobroUsd,
  type ParticionIngreso,
} from './ingreso-vuelo.util';
import { etiquetaMetodoCobro } from './metodo-cobro.util';
import {
  TOLERANCIA_PAGO_VENDEDOR_MXN,
  cuerpoGastoRealPagoVendedor,
  pagosVendedorDeVuelo,
  type GastoPagoVendedorRow,
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
   * util filtra la categoría `COMISION_VENDEDOR` en JS
   * (`pagosVendedorDeVuelo`); los demás gastos no cuentan. OBLIGATORIO: un
   * caller que lo olvide dejaría la parte del vendedor en 0 en silencio
   * (tsc lo delata; los specs sin gastos pasan `[]`).
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
   * `vuelo.estado`. CANCELADO ⇒ lo retenido es 100 % del avión (factor 1)
   * y el avión no absorbe el pago al vendedor; el pago REAL del vendedor
   * solo lo absorbe en COMPLETADO (ver la cabecera). Un solo dato para las
   * dos reglas: los lectores no pueden mandarlas contradictorias.
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
  /** ¿El vuelo cae en la vigencia de la regla? */
  aplica: boolean;
  /** Parte del avión de la comisión bancaria (MXN, Σ por cobro). */
  banco_mxn: number;
  /** La misma parte en USD (reparto a socios). */
  banco_usd: number;
  /**
   * Pago REAL al vendedor (gastos `COMISION_VENDEDOR` del vuelo) × la parte
   * del avión, en MXN. > 0 SOLO con `vendedor_absorbe` y gastos capturados.
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
   * Algún pago real (USD sin tc_gasto y sin K) no llegó a pesos: no entra a
   * COMISIONES en MXN (pendiente del balance); el reparto sí lo resta en USD.
   */
  vendedor_sin_tc: boolean;
  /**
   * ¿ESTE avión es quien carga el pago real del vendedor de este vuelo?
   * (vigencia ∧ COMPLETADO ∧ partición consistente ∧ comisión cotizada > 0).
   * Independiente de los gastos: con ella y `vendedor_pagos_n = 0` el balance
   * avisa que falta capturar el gasto.
   */
  vendedor_absorbe: boolean;
  /** Gastos `COMISION_VENDEDOR` del vuelo (absorba o no el avión). */
  vendedor_pagos_n: number;
  /** Pagos MXN que no llegaron a dólares (sin tc_gasto ni K). */
  vendedor_usd_sin_tc_n: number;
  /** Su parte del avión en MXN (va a `gastos_sin_tc_mxn` del reparto). */
  vendedor_usd_sin_tc_mxn: number;
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
 * Lo que UN avión cargó del pago real al vendedor de UN vuelo: el
 * `comision_vendedor_real_mxn` de la fila del vuelo en el libro de ese avión
 * TAL CUAL (nadie lo recalcula en «otros movimientos») y si lo absorbió
 * (`comision_vendedor_real_pagos > 0`; la señal es esa, NO `vendedor_mxn >
 * 0`: un avión sin pesos —gasto USD sin tc_gasto y vuelo sin K— lo absorbe
 * en USD en su reparto y aquí trae 0).
 */
export interface ComisionVendedorDeAvion {
  matricula: string;
  vendedor_mxn: number;
  absorbido: boolean;
}

/**
 * Sufijo del egreso del vendedor en «otros movimientos» cuando el pago real
 * ya lo cargan los aviones en su columna COMISIONES (13-oct-2026, API
 * 0.0.74, invariante 61). Lista = los aviones `absorbido`; vacía ⇒ ''.
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
 * Concepto del egreso del vendedor en «otros movimientos» cuando el avión
 * ya carga el pago real (egreso $0.00 VERDADERO en la pestaña): `pago
 * <etiqueta> · gasto real[ (N pagos)][ · parcial: faltan $X MXN | · excede
 * $X MXN]` (`cuerpoGastoRealPagoVendedor`: faltan/excede vs lo COBRADO con
 * la cadena de la pestaña, tolerancia 1.00) + el sufijo de arriba. SIN los
 * sufijos « (USD sin TC)» / « (parcial: USD sin TC)»: el egreso es 0 de
 * verdad y la marca «sin TC» anularía el lado en el bloque VUELATOUR
 * (`ladoEnUsd`). Todos empiezan con `pago comisión vendedor`
 * (`colapsarFilasDeVuelo` los clasifica sin cambio).
 */
export function conceptoPagoVendedorACargoDelAvion(a: {
  /** 'comisión vendedor (Pablo Canales)' | 'comisión vendedor'. */
  etiquetaComision: string;
  /** Lo pagado de verdad al vendedor (`pagosVendedorDeVuelo` de la pestaña). */
  pagos: PagosVendedorDeVuelo;
  /** Σ ingreso MXN de las líneas de comisión; null = sin T.C. de venta. */
  lineaMxn: number | null;
  /** Las partes de los aviones (los no absorbidos no aparecen). */
  aviones: ReadonlyArray<ComisionVendedorDeAvion>;
}): string {
  return `pago ${a.etiquetaComision} · ${cuerpoGastoRealPagoVendedor(
    a.pagos,
    a.lineaMxn,
  )}${sufijoPagoVendedorACargoDelAvion(a.aviones, a.pagos.pagadoMxn)}`;
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
  banco_mxn: 0,
  banco_usd: 0,
  vendedor_mxn: 0,
  vendedor_usd: 0,
  total_mxn: 0,
  total_usd: 0,
  banco_sin_tc: 0,
  vendedor_sin_tc: false,
  vendedor_absorbe: false,
  vendedor_pagos_n: 0,
  vendedor_usd_sin_tc_n: 0,
  vendedor_usd_sin_tc_mxn: 0,
};

/**
 * Comisiones que ESTE avión absorbe de UN vuelo. Ver la cabecera del
 * archivo para la regla completa.
 */
export function comisionesDelVuelo(
  i: ComisionesDelVueloInput,
): ComisionesDelVuelo {
  if (!aplicaComisionesAlAvion(i.diaVuelo, i.vigenteDesde)) {
    return { aplica: false, ...VACIO, detalle: [] };
  }
  const p = i.particion;
  const cancelado = i.estado === 'CANCELADO';
  const completado = i.estado === 'COMPLETADO';
  const k = pos(i.tcVenta);
  const factorCobro = factorCobroAvion(i.cobros, k, p, cancelado);
  const participacion = i.participacion > 0 ? i.participacion : 0;
  const lineas: string[] = [];

  // ----- Comisión BANCARIA de cada cobro -----
  let bancoMxn = 0;
  let bancoUsd = 0;
  let bancoSinTc = 0;
  for (const c of i.cobros) {
    const com = pos(c.comision_banco_monto);
    if (com == null) continue;
    const tc = pos(c.tc_usd_mxn) ?? k;
    const esMxn = c.moneda === 'MXN';
    const comMxn = esMxn ? round2(com) : tc != null ? round2(com * tc) : null;
    const comUsd = esMxn ? (tc != null ? round2(com / tc) : null) : round2(com);
    const parteMxn =
      comMxn != null ? i.parteAvion(round2(comMxn * factorCobro)) : null;
    const parteUsd =
      comUsd != null ? i.parteAvion(round2(comUsd * factorCobro)) : null;
    if (parteMxn != null) bancoMxn += parteMxn;
    else bancoSinTc += 1;
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

  // ----- PAGO REAL al vendedor (gastos COMISION_VENDEDOR del vuelo) -----
  // Universo del avión = invariante 50 + n ≥ 1 (ver la cabecera): fuera de
  // él el avión manda 0 aunque haya gastos (VuelaTour los paga en «otros
  // movimientos»). Sin gasto capturado NADA resta: la provisión murió.
  const absorbe =
    completado && p != null && !p.inconsistente && pagoVendedorUsd(p) > 0;
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
  const pagosMxn = pagosVendedorDeVuelo(i.gastos, aMxn);
  // OJO: `pagadoMxn` de ESTA llamada son DÓLARES — es «la suma convertida por
  // el conversor inyectado» (`sinTc` = pagos MXN que no llegaron a USD).
  const pagosUsd = pagosVendedorDeVuelo(i.gastos, aUsd);
  let vendedorMxn = 0;
  let vendedorUsd = 0;
  let vendedorSinTc = false;
  let vendedorUsdSinTcN = 0;
  let vendedorUsdSinTcMxn = 0;
  if (absorbe && pagosMxn.n > 0) {
    vendedorMxn = i.parteAvion(pagosMxn.pagadoMxn ?? 0);
    vendedorUsd = i.parteAvion(pagosUsd.pagadoMxn ?? 0);
    vendedorSinTc = pagosMxn.sinTc > 0;
    vendedorUsdSinTcN = pagosUsd.sinTc;
    if (pagosUsd.sinTc > 0) {
      // Pagos MXN sin tc_gasto ni K: no llegan a USD — su parte del avión va
      // a `gastos_sin_tc_mxn` del reparto (integridad de siempre).
      const mxnSinUsd = i.gastos
        .filter(
          (g) =>
            categoriaEsPagoVendedor(g.categoria ?? null) &&
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
        `Comisión vendedor${nombre} · ${fmtMxnNota(totalMxn)} · gasto real${nPagos}${parte}${sinTc}`,
      );
    } else {
      // Ningún pago llegó a pesos (todos USD sin tc_gasto y vuelo sin K): el
      // reparto sí lo resta en USD; en el balance lo grita el pendiente.
      // (`pagosUsd.pagadoMxn` son DÓLARES: la suma del conversor a USD.)
      lineas.push(
        `Comisión vendedor${nombre} · ${fmtMxnNota(pagosUsd.pagadoMxn ?? 0)} USD sin T.C. — no suma en pesos`,
      );
    }
  }

  const banco_mxn = round2(bancoMxn);
  const banco_usd = round2(bancoUsd);
  const vendedor_mxn = round2(vendedorMxn);
  const vendedor_usd = round2(vendedorUsd);
  if (lineas.length > 1) lineas.unshift(`${lineas.length} conceptos`);
  return {
    aplica: true,
    banco_mxn,
    banco_usd,
    vendedor_mxn,
    vendedor_usd,
    total_mxn: round2(banco_mxn + vendedor_mxn),
    total_usd: round2(banco_usd + vendedor_usd),
    detalle: lineas,
    banco_sin_tc: bancoSinTc,
    vendedor_sin_tc: vendedorSinTc,
    vendedor_absorbe: absorbe,
    vendedor_pagos_n: pagosMxn.n,
    vendedor_usd_sin_tc_n: vendedorUsdSinTcN,
    vendedor_usd_sin_tc_mxn: round2(vendedorUsdSinTcMxn),
  };
}
