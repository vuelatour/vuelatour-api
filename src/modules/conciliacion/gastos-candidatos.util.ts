/**
 * `GET /v1/conciliacion/movimientos/:id/gastos-candidatos` (2-oct-2026, API
 * 0.0.52): los gastos que podrían pagar UN cargo (uno o varios, «lote»).
 * Caso real: 29 «Pago VIP SAESA» casi iguales y la lista precargada del
 * panel (200 gastos) dejaba fuera el del 14-sep. Aquí vive, PURO y con
 * spec, cómo se interpreta la búsqueda y en qué orden se ofrecen.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { difDias } from './paywise-cruce.util';
import { TOLERANCIA_CONCILIACION } from './conciliacion-parcial.util';
import {
  TC_IMPLICITO_MAX,
  TC_IMPLICITO_MIN,
  type NivelTcCruce,
} from './auto-cruce.util';

/**
 * Solo estos medios de pago tocan el banco y pueden cruzarse con un CARGO del
 * estado de cuenta (PAYWISE entró el 2-sep-2026: sus cargos también aparecen
 * en el estado de cuenta; DOMICILIADO —«Pago domiciliado»— el 13-oct-2026,
 * invariante 64: cargo automático a la cuenta, también sale en el estado de
 * cuenta y se concilia como una transferencia). EFECTIVO sale de caja chica
 * (del cajón), BODEGA es un cargo contable de inventario y los PERSONAL_*
 * llegan al banco después como reintegro, no como el gasto original.
 * Cruzarlos generaba matches falsos.
 *
 * ORDEN: los valores nuevos van AL FINAL — el panel
 * (`conciliacion-no-bancario.test.ts`) lee ESTE arreglo por regex y lo
 * compara con su espejo `MEDIOS_BANCARIOS_CONCILIACION` con `toEqual`.
 * Espejos en el API que lo LEEN de aquí: `estado-banco.util` (columna
 * «Banco»), `expenses.service` (auto-cruce best-effort y aditivos de
 * `list()`) y el pre-cierre del reparto (`gastos_bancarios_sin_conciliar`).
 *
 * FUENTE ÚNICA del universo de candidatos de conciliación (auto-cruce,
 * «Vincular gasto», gastos sin banco, IA) y de la clasificación de los
 * EXCLUIDOS (`candidatos-excluidos.util`, 6-oct-2026): si la lista cambia,
 * el motivo «efectivo u otro medio» cambia con ella. Hasta el 0.0.62 vivía
 * en `conciliacion.service.ts`.
 */
export const MEDIOS_BANCARIOS: readonly string[] = [
  'TARJETA_CORP',
  'TRANSFERENCIA',
  'PAYWISE',
  'DOMICILIADO',
];

/**
 * Salida de inventario (cargo contable del cardex): JAMÁS toca el banco y
 * no se liga a un cargo ni con justificación (409 `GASTO_BODEGA`).
 */
export const MEDIO_BODEGA = 'BODEGA';

/** ¿El medio toca el banco? Sin medio ⇒ NO (`gasto.medio_pago` es NOT NULL). */
export function esMedioBancario(medio: string | null | undefined): boolean {
  return MEDIOS_BANCARIOS.includes(medio ?? '');
}

/**
 * GASTO NO BANCARIO CON JUSTIFICACIÓN (6-oct-2026, API 0.0.63): ¿entra al
 * universo de «Vincular gasto» con `incluir_no_bancarios`? Todo medio NO
 * bancario (EFECTIVO, PERSONAL_*) MENOS BODEGA; sin medio, no. Solo en la
 * moneda de la cuenta: jamás como cruzado (USD contra pesos), porque la BD le
 * derivaría `tc_gasto` de un cargo que no lo pagó.
 */
export function esMedioNoBancarioVinculable(
  medio: string | null | undefined,
): boolean {
  return !!medio && !esMedioBancario(medio) && medio !== MEDIO_BODEGA;
}

/**
 * Los medios de un vínculo (PATCH movimientos/:id), PURO:
 * - `bodega`: TODOS los BODEGA del cuerpo (siempre 409, ligados o no);
 * - `noBancariosNuevos`: los no bancarios que ENTRAN con esta liga (los que
 *   ya pagaba este cargo no piden la razón otra vez: la re-liga idéntica
 *   sigue siendo un no-op). Un gasto sin medio cuenta como no bancario: si
 *   una lectura no lo trajo, se pide la razón (jamás se liga a ciegas).
 */
export function clasificarMediosVinculo<
  T extends { id: string; medio_pago: string | null },
>(
  gastos: readonly T[],
  yaLigados: ReadonlySet<string>,
): { bodega: T[]; noBancariosNuevos: T[] } {
  const bodega = gastos.filter((g) => g.medio_pago === MEDIO_BODEGA);
  const noBancariosNuevos = gastos.filter(
    (g) =>
      g.medio_pago !== MEDIO_BODEGA &&
      !esMedioBancario(g.medio_pago) &&
      !yaLigados.has(g.id),
  );
  return { bodega, noBancariosNuevos };
}

/** Búsqueda ya interpretada. */
export type BusquedaGasto =
  | { tipo: 'vacia' }
  /** Monto: `[min, max]` o, con `maxExclusivo`, `[min, max)`. */
  | { tipo: 'monto'; min: number; max: number; maxExclusivo: boolean }
  | { tipo: 'texto'; texto: string };

const c2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Interpreta `q`:
 * - vacía ⇒ `vacia`;
 * - número ENTERO sin decimales («2801») ⇒ monto ∈ [2801, 2802);
 * - con decimales («2801.40», «2801.4») ⇒ ±0.01;
 * - lo demás ⇒ texto (proveedor, nota, lugar, folio del ticket).
 * El panel ya la manda normalizada; por si acaso se toleran «$», espacios
 * y comas de miles («$ 2,801.40»).
 */
export function interpretarBusquedaGasto(
  q: string | null | undefined,
): BusquedaGasto {
  const t = String(q ?? '').trim();
  if (!t) return { tipo: 'vacia' };
  const sinSigno = t.replace(/^\$\s*/, '');
  const numero = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(sinSigno)
    ? sinSigno.replace(/,/g, '')
    : sinSigno;
  if (/^\d+$/.test(numero)) {
    const n = Number(numero);
    return { tipo: 'monto', min: n, max: n + 1, maxExclusivo: true };
  }
  if (/^\d+\.\d{1,2}$/.test(numero)) {
    const n = Number(numero);
    return {
      tipo: 'monto',
      min: c2(n - 0.01),
      max: c2(n + 0.01),
      maxExclusivo: false,
    };
  }
  return { tipo: 'texto', texto: t };
}

/** Candidato tal como lo ordena el endpoint (lo mínimo que mira el orden). */
export interface CandidatoOrdenable {
  id: string;
  monto: number;
  faltante?: number | null;
  fecha?: string | null;
  cruzado?: boolean;
  /**
   * ADITIVO (0.0.75, invariante 69): el folio del gasto coincide con la
   * factura que cita el concepto del banco. Solo ordena DENTRO de su nivel
   * de monto (después de `cruzado` y `cuadra`): jamás brinca sobre un
   * candidato que cuadra, jamás liga ni preselecciona.
   */
  coincide_factura?: boolean;
  /**
   * ADITIVO (0.0.75, invariante 70): SOLO en los cruzados (USD contra cuenta
   * MXN), su T.C. implícito contra el oficial del día del cargo. Decide el
   * nivel del cruzado en `ordenarCandidatosPorNiveles`.
   */
  tc_cruce?: { nivel: NivelTcCruce; desvio_pct: number | null } | null;
}

/**
 * ¿El gasto, por sí solo, cuadra con el cargo? (`|monto o faltante −
 * |cargo|| ≤ 1.00`, la tolerancia de siempre por gasto). Los cruzados (USD
 * contra cuenta MXN) no se comparan: sus montos son de otra moneda.
 */
export function cuadraConCargo(
  c: CandidatoOrdenable,
  montoCargo: number,
): boolean {
  if (c.cruzado === true) return false;
  return distanciaMonto(c, montoCargo) <= TOLERANCIA_CONCILIACION + 1e-9;
}

function distanciaMonto(c: CandidatoOrdenable, montoCargo: number): number {
  const cargo = Math.abs(c2(montoCargo));
  const porMonto = Math.abs(c2(Math.abs(Number(c.monto) || 0) - cargo));
  const porFaltante =
    c.faltante != null && Number.isFinite(Number(c.faltante))
      ? Math.abs(c2(Math.abs(Number(c.faltante)) - cargo))
      : Number.POSITIVE_INFINITY;
  return Math.min(porMonto, porFaltante);
}

/**
 * Orden por defecto del contrato: (1) los que CUADRAN con el cargo, (2) los
 * cuyo folio COINCIDE con la factura del concepto del banco (0.0.75; sin el
 * campo no cuenta), (3) cercanía de monto (contra el monto o el faltante),
 * (4) cercanía de fecha, (5) fecha más reciente primero; los cruzados (USD
 * con TC implícito) al final. Estable y determinista (último desempate: id).
 */
export function ordenarCandidatosGasto<T extends CandidatoOrdenable>(
  candidatos: readonly T[],
  ref: { montoCargo: number; fecha: string },
): T[] {
  const clave = (c: T) => {
    const cruzado = c.cruzado === true ? 1 : 0;
    const cuadra = cuadraConCargo(c, ref.montoCargo) ? 0 : 1;
    const factura = c.coincide_factura === true ? 0 : 1;
    const dMonto = cruzado ? 0 : distanciaMonto(c, ref.montoCargo);
    const dFecha = c.fecha ? difDias(ref.fecha, c.fecha) : Infinity;
    return { cruzado, cuadra, factura, dMonto, dFecha };
  };
  return [...candidatos]
    .map((c) => ({ c, k: clave(c) }))
    .sort((a, b) => {
      if (a.k.cruzado !== b.k.cruzado) return a.k.cruzado - b.k.cruzado;
      if (a.k.cuadra !== b.k.cuadra) return a.k.cuadra - b.k.cuadra;
      if (a.k.factura !== b.k.factura) return a.k.factura - b.k.factura;
      if (a.k.dMonto !== b.k.dMonto) return a.k.dMonto - b.k.dMonto;
      if (a.k.dFecha !== b.k.dFecha) return a.k.dFecha - b.k.dFecha;
      const fa = a.c.fecha ?? '';
      const fb = b.c.fecha ?? '';
      if (fa !== fb) return fa < fb ? 1 : -1;
      return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
    })
    .map((x) => x.c);
}

/** Candidato con la marca del medio (`no_bancario`, API 0.0.63). */
export interface CandidatoOrdenableConMedio extends CandidatoOrdenable {
  no_bancario?: boolean;
}

/**
 * Orden de los CRUZADOS (USD contra cuenta MXN) dentro de su nivel
 * (0.0.75, invariante 70): el folio que coincide con la factura del concepto
 * primero (invariante 69, como en `ordenarCandidatosGasto`), luego
 * |desvío| contra el oficial ascendente (null al final), |días al cargo|
 * ascendente, fecha descendente e id. Sin `tc_cruce` ni factura es el orden
 * de siempre de los cruzados (cercanía de fecha, fecha desc, id).
 */
export function ordenarCruzadosPorTc<T extends CandidatoOrdenable>(
  candidatos: readonly T[],
  ref: { fecha: string },
): T[] {
  const clave = (c: T) => {
    const d = c.tc_cruce?.desvio_pct;
    return {
      factura: c.coincide_factura === true ? 0 : 1,
      desvio:
        d != null && Number.isFinite(d)
          ? Math.abs(d)
          : Number.POSITIVE_INFINITY,
      dFecha: c.fecha ? difDias(ref.fecha, c.fecha) : Infinity,
    };
  };
  return [...candidatos]
    .map((c) => ({ c, k: clave(c) }))
    .sort((a, b) => {
      if (a.k.factura !== b.k.factura) return a.k.factura - b.k.factura;
      if (a.k.desvio !== b.k.desvio) return a.k.desvio - b.k.desvio;
      if (a.k.dFecha !== b.k.dFecha) return a.k.dFecha - b.k.dFecha;
      const fa = a.c.fecha ?? '';
      const fb = b.c.fecha ?? '';
      if (fa !== fb) return fa < fb ? 1 : -1;
      return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
    })
    .map((x) => x.c);
}

/** Candidato con la marca del medio (`no_bancario`, API 0.0.63). */
export interface CandidatoOrdenableConMedio extends CandidatoOrdenable {
  no_bancario?: boolean;
}

/**
 * Orden de «Vincular gasto» por NIVELES (revisión 6-oct-2026; 7 niveles
 * desde el 0.0.75, invariante 70):
 *   1. bancarios de la moneda de la cuenta que CUADRAN con el cargo;
 *   2. cruzados (USD) CERCA del T.C. oficial del día del cargo;
 *   3. no bancarios que CUADRAN;
 *   4. el resto de los bancarios de la moneda de la cuenta;
 *   5. cruzados SIN T.C. oficial;
 *   6. cruzados LEJOS del oficial o sin `tc_cruce` (= la posición de
 *      siempre de los cruzados: al final de los bancarios);
 *   7. el resto de los no bancarios.
 * Los niveles 1/3/4/7 con `ordenarCandidatosGasto`; los 2/5/6 con
 * `ordenarCruzadosPorTc`. Caso real del 6-oct (prod): el cargo de $212.00
 * del 07-sep tenía 254 bancarios sin conciliar en ±30 días y 223 no
 * bancarios: con «todos los bancarios y DESPUÉS los no bancarios» el corte a
 * `limite` (100) dejaba fuera los tres estacionamientos en EFECTIVO. Caso
 * real del 13-oct: con 220 bancarios MXN que no cuadran, el tubo de 422.86
 * USD (CERCA) queda en la posición 0, antes del corte. Sin cruzados ni no
 * bancarios el resultado es EXACTAMENTE `ordenarCandidatosGasto`.
 */
export function ordenarCandidatosPorNiveles<
  T extends CandidatoOrdenableConMedio,
>(candidatos: readonly T[], ref: { montoCargo: number; fecha: string }): T[] {
  const niveles: T[][] = [[], [], [], [], [], [], []];
  for (const c of candidatos) {
    if (c.cruzado === true) {
      const nivel = c.tc_cruce?.nivel;
      niveles[nivel === 'CERCA' ? 1 : nivel === 'SIN_OFICIAL' ? 4 : 5].push(c);
      continue;
    }
    const cuadra = cuadraConCargo(c, ref.montoCargo);
    if (c.no_bancario === true) niveles[cuadra ? 2 : 6].push(c);
    else niveles[cuadra ? 0 : 3].push(c);
  }
  return niveles.flatMap((nivel, i) =>
    i === 1 || i === 4 || i === 5
      ? ordenarCruzadosPorTc(nivel, ref)
      : ordenarCandidatosGasto(nivel, ref),
  );
}

const floor2 = (x: number) => Math.floor(Math.round(x * 1e6) / 1e4) / 100;
const ceil2 = (x: number) => Math.ceil(Math.round(x * 1e6) / 1e4) / 100;

/**
 * Banda de dólares de un cargo en pesos (0.0.75): los gastos USD cuyo
 * cociente |cargo| ÷ usd puede caer en [15, 25] ⇒ [floor2(|c|/25),
 * ceil2(|c|/15)]. 7,214.14 ⇒ [288.56, 480.95]. Filtro de LECTURA: la
 * decisión exacta la toma `evaluarTcCruce`.
 */
export function rangoBandaUsd(montoCargo: number): {
  min: number;
  max: number;
} {
  const c = Math.abs(Number(montoCargo) || 0);
  return {
    min: floor2(c / TC_IMPLICITO_MAX),
    max: ceil2(c / TC_IMPLICITO_MIN),
  };
}

/**
 * Banda de PESOS de un gasto en dólares (el RECÍPROCO del cruce USD,
 * 0.0.75): [floor2(usd × 15), ceil2(usd × 25)].
 */
export function rangoBandaMxnDeUsd(usd: number): { min: number; max: number } {
  const u = Math.abs(Number(usd) || 0);
  return {
    min: floor2(u * TC_IMPLICITO_MIN),
    max: ceil2(u * TC_IMPLICITO_MAX),
  };
}

/**
 * Tolerancia de la búsqueda por EQUIVALENTE en pesos (±%): más ancha que la
 * de la decisión (±2 %) porque es un filtro humano y nunca liga.
 */
export const TOLERANCIA_BUSQUEDA_EQUIVALENTE_PCT = 3;

/**
 * Rangos de MONTO en dólares de una búsqueda en «Vincular gasto» de una
 * cuenta en pesos (0.0.75): un monto se busca tal cual (son dólares) y, con
 * el T.C. oficial del día del cargo, también como PESOS ÷ oficial ±3 %
 * («7214.14» ⇒ [7214.13, 7214.15] + [411.81, 437.29] con 17.0077). Sin
 * búsqueda o con texto ⇒ [] (se lee la banda del cargo).
 */
export function rangosUsdDeBusqueda(
  busqueda: BusquedaGasto,
  tcOficial: number | null | undefined,
): Array<{ min: number; max: number; maxExclusivo: boolean }> {
  if (busqueda.tipo !== 'monto') return [];
  const rangos = [
    {
      min: busqueda.min,
      max: busqueda.max,
      maxExclusivo: busqueda.maxExclusivo,
    },
  ];
  const of = Number(tcOficial);
  if (Number.isFinite(of) && of > 0) {
    const tol = TOLERANCIA_BUSQUEDA_EQUIVALENTE_PCT / 100;
    rangos.push({
      min: floor2(busqueda.min / (of * (1 + tol))),
      max: ceil2(busqueda.max / (of * (1 - tol))),
      maxExclusivo: false,
    });
  }
  return rangos;
}

/** Sin la moneda de la cuenta no se filtra divisa ni se liga un lote (jamás se adivina). */
export const MENSAJE_SIN_MONEDA_CUENTA =
  'No se pudo leer la moneda de la cuenta bancaria del cargo: vuelve a intentarlo en unos minutos.';

/**
 * 503 `CUENTA_SIN_MONEDA` (transitorio: `cuenta_bancaria.moneda` es NOT
 * NULL, un null es una lectura caída). Lo usan los candidatos y la liga de
 * un lote (revisión 2-oct-2026): con un `Error` suelto el filtro global
 * respondía «Ocurrió un error inesperado» y el texto legible se perdía.
 */
export function errorSinMonedaCuenta(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_SIN_MONEDA_CUENTA,
    error: 'CUENTA_SIN_MONEDA',
  });
}
