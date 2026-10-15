/**
 * «COBRADO DE MÁS» CON CAUSA (14-oct-2026, API 0.0.78, invariante 77, D13 y
 * D14). Pedido del cliente: «…y la de «cobrado de más» en la card». Helpers
 * PUROS (sin I/O): el lector best-effort de los cobros de OTROS vuelos del
 * cliente vive en `flights.service` y el renglón del pre-cierre en
 * `profit-sharing/vuelos-cobrados-de-mas.util`.
 *
 * El MONTO no se calcula aquí: sale de las fuentes únicas.
 * - Lo cobrado = `cobrosEnUsd` (invariante 2) con la MISMA cadena de T.C. del
 *   lector que llama (snapshot: el T.C. del vuelo; pre-cierre: cotización ??
 *   oficial del día) — `entradaCobradoDeMas` la aplica.
 * - El total y el IVA = `particionIngresoVuelo` (invariante 10).
 * - El excedente = `sobrecobroUsd` (la MISMA cifra que el balance manda a
 *   «otros movimientos» de VuelaTour) y solo hay aviso cuando
 *   `pendienteCobro(cobrado, total)` > 0 (los argumentos AL REVÉS a
 *   propósito: es «lo que sobra» con la MISMA tolerancia de la bandera
 *   `cobrado`, `TOLERANCIA_COBRO_USD` = $1.00).
 * null en un vuelo CANCELADO, con cotización abierta o con total ≤ 0
 * (cliente interno / sin precio).
 *
 * La CAUSA es una heurística ordenada (el texto dice «Posible causa», nunca
 * afirma):
 * (1) SOBRE_DE_GRUPO: todos los cobros son partes de un sobre;
 * (2) COMISION_PAGADA_POR_CLIENTE: Σ comisiones bancarias en USD > 0 y
 *     |excedente − Σ| ≤ $1.00 (va ANTES que el IVA: #84 cuadra con las dos y
 *     es comisión);
 * (3) IVA_NO_COTIZADO: la partición no lleva IVA y |excedente − 16 % del
 *     total| ≤ max($1.00, 0.5 % del total);
 * (4) COBRO_DUPLICADO: dos cobros positivos con el mismo monto, moneda y
 *     método a ≤ 3 días (Cancún) y |excedente − USD de uno| ≤ $1.00;
 * (5) REDONDEO_TC: algún cobro en pesos (que sí convirtió) y excedente ≤
 *     min($10, max($1, 1 % del total));
 * (6) OTRO_VUELO_DEL_CLIENTE (solo el snapshot, con la lectura best-effort):
 *     EXACTAMENTE UN cobro sin banco de otro vuelo vivo del mismo cliente, a
 *     ±30 días de los cobros de este vuelo, que equivale al excedente ±$1.00
 *     en su moneda;
 * (7) SIN_CAUSA_CLARA.
 * Solo COMISION_PAGADA_POR_CLIENTE y REDONDEO_TC quedan «explicados»
 * (`requiere_revision` false, tono INFO): el pre-cierre los deja fuera del
 * conteo. Las comparaciones van en CENTAVOS (enteros): un 1.00 exacto jamás
 * se pierde por el punto flotante.
 */
import { cobroEnUsd, cobrosEnUsd, type CobroLike } from './cobros-usd.util';
import { fmtDineroTexto } from './dinero-texto.util';
import { diaCancun, diasEntreDiasCancun } from './fecha-cancun.util';
import {
  particionIngresoVuelo,
  sobrecobroUsd,
  type VueloIngresoInput,
} from './ingreso-vuelo.util';
import {
  etiquetaMetodoCobro,
  METODOS_COBRO_ABONO_AUTO,
} from './metodo-cobro.util';
import { pendienteCobro, TOLERANCIA_COBRO_USD } from './semaforo-cobro.util';
import { normalizarTc } from './tc.util';

export type CausaCobradoDeMas =
  | 'SOBRE_DE_GRUPO'
  | 'COMISION_PAGADA_POR_CLIENTE'
  | 'IVA_NO_COTIZADO'
  | 'COBRO_DUPLICADO'
  | 'REDONDEO_TC'
  | 'OTRO_VUELO_DEL_CLIENTE'
  | 'SIN_CAUSA_CLARA';

/** Tope del «redondeo del tipo de cambio» (USD). */
export const TOPE_REDONDEO_TC_USD = 10;
/** IVA que el cliente pudo pagar de más (16 %). */
export const IVA_COBRADO = 0.16;
/** Días (Cancún) entre dos cobros iguales para sospechar un duplicado. */
export const DIAS_COBRO_DUPLICADO = 3;
/** Ventana (días Cancún) de los cobros de OTRO vuelo del cliente. */
export const DIAS_OTRO_VUELO_CLIENTE = 30;
/** Tolerancia del IVA: 0.5 % del total (o $1.00 si es mayor). */
export const IVA_TOLERANCIA_FRACCION_TOTAL = 0.005;
/** Tope del redondeo: 1 % del total (entre $1.00 y `TOPE_REDONDEO_TC_USD`). */
export const REDONDEO_FRACCION_TOTAL = 0.01;

export const ETIQUETA_CAUSA_COBRADO_DE_MAS: Record<CausaCobradoDeMas, string> =
  {
    SOBRE_DE_GRUPO: 'sobre del grupo',
    COMISION_PAGADA_POR_CLIENTE: 'comisión del link pagada por el cliente',
    IVA_NO_COTIZADO: 'IVA que la cotización no lleva',
    COBRO_DUPLICADO: 'cobro capturado dos veces',
    REDONDEO_TC: 'redondeo del tipo de cambio',
    OTRO_VUELO_DEL_CLIENTE: 'pago de otro vuelo del cliente',
    SIN_CAUSA_CLARA: 'sin causa clara',
  };

/** Causas que NO requieren revisión (el pre-cierre las cuenta aparte). */
export const CAUSAS_COBRADO_DE_MAS_EXPLICADAS: ReadonlySet<CausaCobradoDeMas> =
  new Set<CausaCobradoDeMas>(['COMISION_PAGADA_POR_CLIENTE', 'REDONDEO_TC']);

/** Un cobro del vuelo como lo lee «Cobrado de más». */
export interface CobroParaCobradoDeMas {
  id: string;
  /** En SU moneda (negativo = reembolso). */
  monto: number;
  moneda: string;
  /** Su USD con la MISMA cadena de T.C. del lector (`cobroEnUsd`); null = MXN sin T.C. */
  usd: number | null;
  metodo: string | null;
  fecha_cobro: string | null;
  parte_de_sobre: boolean;
  tc_usd_mxn: number | null;
}

/** Un cobro SIN BANCO de OTRO vuelo vivo del mismo cliente (lectura best-effort). */
export interface OtroCobroDelCliente {
  vuelo_id: string;
  folio: number | null;
  cobro_id: string;
  monto: number;
  moneda: string;
  fecha_cobro: string | null;
}

export interface EntradaCobradoDeMas {
  total_usd: number;
  cobrado_usd: number;
  sin_tc_count: number;
  sin_tc_mxn: number;
  estado_vuelo: string | null;
  cotizacion_abierta: boolean;
  iva_total_usd: number;
  /** Σ comisiones bancarias de los cobros en USD (`comisionesCobrosUsd`). */
  comisiones_usd: number;
  cobros: ReadonlyArray<CobroParaCobradoDeMas>;
  tc_vuelo: number | null;
  /** ADITIVO: folio del grupo del vuelo («G-12» en el texto del sobre). */
  grupo_folio?: number | null;
  /** Solo el snapshot (best-effort); null/ausente = no se leyó o falló. */
  otros_cobros_cliente?: ReadonlyArray<OtroCobroDelCliente> | null;
}

export interface ReferenciaCobradoDeMas {
  vuelo_id?: string;
  folio?: number | null;
  cobro_id?: string;
  cobro_ids?: string[];
  monto?: number;
  moneda?: string;
}

export interface CobradoDeMas {
  excedente_usd: number;
  cobrado_usd: number;
  total_usd: number;
  causa: CausaCobradoDeMas;
  causa_etiqueta: string;
  requiere_revision: boolean;
  tono: 'AVISO' | 'INFO';
  titulo: string;
  explicacion: string;
  que_hacer: string;
  referencia: ReferenciaCobradoDeMas | null;
  /** Cobros en pesos que no entraron a la cuenta (sin T.C.). */
  sin_tc: { n: number; mxn: number } | null;
}

/** Redondeo a centavos (con EPSILON, como `round2` de la partición). */
function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function centavos(n: number): number {
  return Math.round(n * 100);
}

/** |a − b| ≤ tol, en centavos enteros. */
function dentroDe(a: number, b: number, tolUsd: number): boolean {
  return Math.abs(centavos(a) - centavos(b)) <= centavos(tolUsd);
}

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Día Cancún (YYYY-MM-DD) de un instante o de un día de pared; null si no se lee. */
function diaDe(v: unknown): string | null {
  const s = texto(v);
  if (!s) return null;
  try {
    return diaCancun(s);
  } catch {
    return null;
  }
}

/** Mueve un día de pared YYYY-MM-DD (aritmética a mediodía UTC, sin zona). */
function moverDia(dia: string, dias: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  if (!m) return dia;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dias, 12),
  )
    .toISOString()
    .slice(0, 10);
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
] as const;

/** «15 sep» de un día YYYY-MM-DD (sin cero a la izquierda, como `fechaCortaCancun`). */
function diaCorto(dia: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  if (!m) return dia;
  return `${Number(m[3])} ${MESES_CORTOS[Number(m[2]) - 1] ?? m[2]}`;
}

/** Orden estable de los cobros: fecha (sin fecha al final) y luego id. */
function porFechaYId(
  a: Pick<CobroParaCobradoDeMas, 'fecha_cobro' | 'id'>,
  b: Pick<CobroParaCobradoDeMas, 'fecha_cobro' | 'id'>,
): number {
  const fa = a.fecha_cobro ?? '';
  const fb = b.fecha_cobro ?? '';
  if (fa !== fb) {
    if (!fa) return 1;
    if (!fb) return -1;
    return fa < fb ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Cobros que cuentan (monto finito ≠ 0: `cobrosEnUsd` descarta el 0). */
function cobrosQueCuentan(
  cobros: ReadonlyArray<CobroParaCobradoDeMas>,
): CobroParaCobradoDeMas[] {
  return cobros.filter((c) => Number.isFinite(c.monto) && c.monto !== 0);
}

// ===================================================================
// Entrada desde las fuentes únicas (snapshot y pre-cierre la comparten)
// ===================================================================

/** Lo mínimo de una fila de `cobro_vuelo` para «Cobrado de más». */
export interface CobroCrudoCobradoDeMas extends CobroLike {
  id?: unknown;
  metodo_cobro?: unknown;
  fecha_cobro?: unknown;
  cobro_grupo_id?: unknown;
  comision_banco_monto?: unknown;
}

/**
 * Σ de las comisiones bancarias CAPTURADAS de los cobros, en USD, con la
 * MISMA regla y el MISMO respaldo de T.C. que lo cobrado (`cobrosEnUsd` de
 * pseudo-cobros {monto: comisión, moneda, tc}). Una comisión ≤ 0 no cuenta.
 */
export function comisionesCobrosUsd(
  cobros: ReadonlyArray<CobroCrudoCobradoDeMas>,
  tcFallback?: number | null,
): number {
  return cobrosEnUsd(
    cobros.map((c) => ({
      monto: num(c.comision_banco_monto) > 0 ? c.comision_banco_monto : 0,
      moneda: c.moneda,
      tc_usd_mxn: c.tc_usd_mxn,
    })),
    tcFallback,
  ).total_usd;
}

/** Filas de `cobro_vuelo` ⇒ los cobros de «Cobrado de más» (su USD con `cobroEnUsd`). */
export function cobrosParaCobradoDeMas(
  cobros: ReadonlyArray<CobroCrudoCobradoDeMas>,
  tcFallback?: number | null,
): CobroParaCobradoDeMas[] {
  return cobros.map((c) => ({
    id: texto(c.id) ?? '',
    monto: r2(num(c.monto)),
    moneda: texto(c.moneda) ?? '',
    usd: cobroEnUsd(c, tcFallback),
    metodo: texto(c.metodo_cobro),
    fecha_cobro: texto(c.fecha_cobro),
    parte_de_sobre: texto(c.cobro_grupo_id) !== null,
    tc_usd_mxn: normalizarTc(c.tc_usd_mxn),
  }));
}

/**
 * La entrada de `cobradoDeMas` armada SOLO con las fuentes únicas: lo
 * cobrado con `cobrosEnUsd(cobros, tcFallback)` —quien llama pasa los MISMOS
 * cobros y el MISMO respaldo con que calcula su `total_cobrado` /
 * `cobrado_usd`—, total e IVA con `particionIngresoVuelo(vuelo)`, comisiones
 * con `comisionesCobrosUsd`.
 */
export function entradaCobradoDeMas(p: {
  vuelo: VueloIngresoInput & {
    estado?: unknown;
    cotizacion_abierta?: unknown;
  };
  cobros: ReadonlyArray<CobroCrudoCobradoDeMas>;
  tcFallback: number | null;
  grupoFolio?: number | null;
  otrosCobrosCliente?: ReadonlyArray<OtroCobroDelCliente> | null;
}): EntradaCobradoDeMas {
  const particion = particionIngresoVuelo(p.vuelo);
  const conv = cobrosEnUsd([...p.cobros], p.tcFallback);
  return {
    total_usd: particion.total_usd,
    cobrado_usd: conv.total_usd,
    sin_tc_count: conv.sin_tc_count,
    sin_tc_mxn: conv.sin_tc_mxn,
    estado_vuelo: texto(p.vuelo.estado),
    cotizacion_abierta: p.vuelo.cotizacion_abierta === true,
    iva_total_usd: particion.iva_total_usd,
    comisiones_usd: comisionesCobrosUsd(p.cobros, p.tcFallback),
    cobros: cobrosParaCobradoDeMas(p.cobros, p.tcFallback),
    tc_vuelo: normalizarTc(p.tcFallback),
    grupo_folio: p.grupoFolio ?? null,
    otros_cobros_cliente: p.otrosCobrosCliente ?? null,
  };
}

// ===================================================================
// Otro vuelo del cliente
// ===================================================================

/**
 * T.C. con que se compara un cobro en PESOS de otro vuelo: el del cobro MXN
 * de MAYOR monto de este vuelo con T.C. > 0; si ninguno lo trae, el del
 * vuelo; si tampoco, null.
 */
export function tcPrincipalDeCobros(
  cobros: ReadonlyArray<
    Pick<CobroParaCobradoDeMas, 'monto' | 'moneda' | 'tc_usd_mxn'>
  >,
  tcVuelo: number | null | undefined,
): number | null {
  let mejor: { monto: number; tc: number } | null = null;
  for (const c of cobros) {
    const tc = normalizarTc(c.tc_usd_mxn);
    if (c.moneda !== 'MXN' || tc === null || !(c.monto > 0)) continue;
    if (!mejor || c.monto > mejor.monto) mejor = { monto: c.monto, tc };
  }
  return mejor ? mejor.tc : normalizarTc(tcVuelo);
}

/**
 * EXACTAMENTE UN cobro de otro vuelo cuyo monto en su moneda equivale al
 * excedente ±$1.00 (USD: el excedente; MXN: r2(excedente × T.C. principal)).
 * Cero o dos o más ⇒ null (dos iguales no dicen cuál es).
 */
export function candidatoOtroVueloDelCliente(
  excedenteUsd: number,
  tcPrincipal: number | null,
  otros: ReadonlyArray<OtroCobroDelCliente>,
): Omit<OtroCobroDelCliente, 'fecha_cobro'> | null {
  const vistos = new Set<string>();
  const coinciden: OtroCobroDelCliente[] = [];
  for (const o of otros) {
    if (vistos.has(o.cobro_id)) continue;
    vistos.add(o.cobro_id);
    if (!(num(o.monto) > 0)) continue;
    let equivalente: number | null = null;
    if (o.moneda === 'USD') equivalente = r2(excedenteUsd);
    else if (o.moneda === 'MXN' && tcPrincipal != null && tcPrincipal > 0) {
      equivalente = r2(excedenteUsd * tcPrincipal);
    }
    if (equivalente === null) continue;
    if (dentroDe(num(o.monto), equivalente, TOLERANCIA_COBRO_USD)) {
      coinciden.push(o);
    }
  }
  if (coinciden.length !== 1) return null;
  const o = coinciden[0];
  return {
    vuelo_id: o.vuelo_id,
    folio: o.folio,
    cobro_id: o.cobro_id,
    monto: r2(num(o.monto)),
    moneda: o.moneda,
  };
}

/**
 * Ventana (días Cancún YYYY-MM-DD) de los cobros de OTROS vuelos del
 * cliente: del primer cobro positivo de este vuelo − 30 días al último + 30.
 * null sin cobros positivos con fecha (no se busca nada).
 */
export function ventanaOtrosCobrosCliente(
  cobros: ReadonlyArray<{ monto?: unknown; fecha_cobro?: unknown }>,
): { desde: string; hasta: string } | null {
  const dias = cobros
    .filter((c) => num(c.monto) > 0)
    .map((c) => diaDe(c.fecha_cobro))
    .filter((d): d is string => d !== null)
    .sort();
  if (dias.length === 0) return null;
  return {
    desde: moverDia(dias[0], -DIAS_OTRO_VUELO_CLIENTE),
    hasta: moverDia(dias[dias.length - 1], DIAS_OTRO_VUELO_CLIENTE),
  };
}

const METODOS_SIN_BANCO: ReadonlySet<string> = new Set(
  METODOS_COBRO_ABONO_AUTO,
);

/**
 * ¿Este cobro de OTRO vuelo cuenta como «pago sin banco» que pudo venir
 * dentro de un cobro de este vuelo? Positivo, de un método que llega al
 * banco (`METODOS_COBRO_ABONO_AUTO`), sin abonos (`ligado` = el lector único
 * le encontró liga), no parte de un sobre ni salido de un anticipo.
 */
export function esCobroSinBancoDeOtroVuelo(c: {
  monto?: unknown;
  metodo_cobro?: unknown;
  cobro_grupo_id?: unknown;
  ingreso_anticipo_id?: unknown;
  ligado: boolean;
}): boolean {
  if (!(num(c.monto) > 0)) return false;
  const metodo = texto(c.metodo_cobro);
  if (!metodo || !METODOS_SIN_BANCO.has(metodo)) return false;
  if (texto(c.cobro_grupo_id) !== null) return false;
  if (texto(c.ingreso_anticipo_id) !== null) return false;
  return c.ligado !== true;
}

/**
 * ¿Hace falta leer los cobros de OTROS vuelos del cliente? Solo cuando hay
 * excedente y ninguna de las causas 1–5 lo explicó (la lectura es
 * best-effort y solo del snapshot).
 */
export function necesitaOtrosCobrosCliente(
  r: CobradoDeMas | null | undefined,
): boolean {
  return r?.causa === 'SIN_CAUSA_CLARA';
}

// ===================================================================
// La regla
// ===================================================================

interface ParDuplicado {
  a: CobroParaCobradoDeMas;
  b: CobroParaCobradoDeMas;
  diaA: string;
  diaB: string;
}

/** El primer par de cobros iguales a ≤ 3 días cuyo USD equivale al excedente. */
function cobroDuplicado(
  cobros: ReadonlyArray<CobroParaCobradoDeMas>,
  excedente: number,
): ParDuplicado | null {
  const positivos = cobros.filter((c) => c.monto > 0).sort(porFechaYId);
  for (let i = 0; i < positivos.length; i += 1) {
    const a = positivos[i];
    const diaA = diaDe(a.fecha_cobro);
    if (!diaA) continue;
    for (let j = i + 1; j < positivos.length; j += 1) {
      const b = positivos[j];
      const diaB = diaDe(b.fecha_cobro);
      if (!diaB) continue;
      if (centavos(a.monto) !== centavos(b.monto)) continue;
      if (a.moneda !== b.moneda) continue;
      if ((a.metodo ?? null) !== (b.metodo ?? null)) continue;
      if (Math.abs(diasEntreDiasCancun(diaA, diaB)) > DIAS_COBRO_DUPLICADO) {
        continue;
      }
      const equivale = [a, b].some(
        (c) =>
          c.usd !== null && dentroDe(excedente, c.usd, TOLERANCIA_COBRO_USD),
      );
      if (equivale) return { a, b, diaA, diaB };
    }
  }
  return null;
}

function lineaRebasa(cobrado: number, total: number): string {
  return `Lo cobrado (${fmtDineroTexto(cobrado, 'USD')}) rebasa el monto total (${fmtDineroTexto(total, 'USD')})`;
}

export const QUE_HACER_COBRADO_DE_MAS: Record<CausaCobradoDeMas, string> = {
  SOBRE_DE_GRUPO:
    'Revisa la partición del sobre en «Cobros del grupo»: lo de más pertenece a otro avión del grupo.',
  COMISION_PAGADA_POR_CLIENTE: 'No hay nada que corregir.',
  IVA_NO_COTIZADO:
    'Si se le facturó con IVA, corrige la cotización para que lleve IVA (así el IVA no cuenta como venta). Si no se le facturó, el cliente tiene un saldo a favor: regístralo como reembolso o aplícalo a su siguiente vuelo.',
  COBRO_DUPLICADO:
    'Si es el mismo pago capturado dos veces, elimina uno (si está conciliado, desvincúlalo primero en Conciliación). Si de verdad fueron dos pagos, el cliente tiene un saldo a favor.',
  REDONDEO_TC: 'No hay nada que corregir.',
  OTRO_VUELO_DEL_CLIENTE:
    'En Conciliación desvincula el depósito, corrige el cobro de este vuelo para que solo lleve lo suyo y vuelve a vincular el depósito marcando los cobros de los dos vuelos.',
  SIN_CAUSA_CLARA:
    'Revisa: ¿algún cobro incluye dinero de OTRO vuelo? (un depósito que pagó dos vuelos se registra como un cobro en cada vuelo y en Conciliación se vincula a los dos); ¿un cobro quedó capturado dos veces?; ¿el monto o el T.C. de un cobro está mal? Corrígelo con «Editar» (si está conciliado, desvincúlalo primero en Conciliación).',
};

/** «Cobrado de más: $495.99 USD». */
export function tituloCobradoDeMas(excedenteUsd: number): string {
  return `Cobrado de más: ${fmtDineroTexto(excedenteUsd, 'USD')}`;
}

/**
 * «COBRADO DE MÁS» de un vuelo con su causa probable (ver la cabecera del
 * archivo). null = no hay aviso (sin excedente que rebase la tolerancia,
 * CANCELADO, cotización abierta o total ≤ 0).
 */
export function cobradoDeMas(e: EntradaCobradoDeMas): CobradoDeMas | null {
  if (e.estado_vuelo === 'CANCELADO' || e.cotizacion_abierta === true) {
    return null;
  }
  const total = r2(num(e.total_usd));
  if (!(total > 0)) return null;
  const cobrado = r2(num(e.cobrado_usd));
  // Argumentos AL REVÉS a propósito: lo que SOBRA, con la tolerancia de la
  // bandera `cobrado` ($1.00 es redondeo, no aviso).
  if (pendienteCobro(cobrado, total) <= 0) return null;
  const excedente = sobrecobroUsd(cobrado, { total_usd: total });
  const cobros = cobrosQueCuentan(e.cobros);
  const linea = lineaRebasa(cobrado, total);
  const sinTc =
    num(e.sin_tc_count) > 0
      ? { n: num(e.sin_tc_count), mxn: r2(num(e.sin_tc_mxn)) }
      : null;
  const armar = (
    causa: CausaCobradoDeMas,
    explicacion: string,
    referencia: ReferenciaCobradoDeMas | null = null,
  ): CobradoDeMas => {
    const requiereRevision = !CAUSAS_COBRADO_DE_MAS_EXPLICADAS.has(causa);
    return {
      excedente_usd: excedente,
      cobrado_usd: cobrado,
      total_usd: total,
      causa,
      causa_etiqueta: ETIQUETA_CAUSA_COBRADO_DE_MAS[causa],
      requiere_revision: requiereRevision,
      tono: requiereRevision ? 'AVISO' : 'INFO',
      titulo: tituloCobradoDeMas(excedente),
      explicacion,
      que_hacer: QUE_HACER_COBRADO_DE_MAS[causa],
      referencia,
      sin_tc: sinTc,
    };
  };

  // (1) Sobre del grupo: TODOS los cobros son partes de un sobre.
  if (cobros.length > 0 && cobros.every((c) => c.parte_de_sobre)) {
    const g = e.grupo_folio;
    return armar(
      'SOBRE_DE_GRUPO',
      `${linea}. Posible causa: el sobre del grupo${g != null ? ` G-${g}` : ''} se repartió con más de lo que vale este vuelo.`,
    );
  }

  // (2) Comisión del link pagada por el cliente (antes que el IVA).
  const comisiones = r2(num(e.comisiones_usd));
  if (comisiones > 0 && dentroDe(excedente, comisiones, TOLERANCIA_COBRO_USD)) {
    return armar(
      'COMISION_PAGADA_POR_CLIENTE',
      'Es la comisión del link de pago, que pagó el cliente: sin la comisión, lo cobrado cuadra con el total.',
    );
  }

  // (3) IVA que la cotización no lleva.
  if (r2(num(e.iva_total_usd)) === 0) {
    const iva = r2(total * IVA_COBRADO);
    const tolerancia = Math.max(
      TOLERANCIA_COBRO_USD,
      total * IVA_TOLERANCIA_FRACCION_TOTAL,
    );
    if (dentroDe(excedente, iva, tolerancia)) {
      const pct = Math.round(IVA_COBRADO * 100);
      return armar(
        'IVA_NO_COTIZADO',
        `${linea}. Posible causa: el cliente pagó el total más ${pct} % de IVA (${fmtDineroTexto(total)} × ${1 + IVA_COBRADO} = ${fmtDineroTexto(r2(total * (1 + IVA_COBRADO)), 'USD')}) y esta cotización no lleva IVA.`,
      );
    }
  }

  // (4) Un cobro capturado dos veces.
  const par = cobroDuplicado(cobros, excedente);
  if (par) {
    const fechas =
      par.diaA === par.diaB
        ? diaCorto(par.diaA)
        : `${diaCorto(par.diaA)} y ${diaCorto(par.diaB)}`;
    return armar(
      'COBRO_DUPLICADO',
      `${linea}. Posible causa: hay dos cobros iguales (${fmtDineroTexto(par.a.monto, par.a.moneda)} · ${etiquetaMetodoCobro(par.a.metodo)} · ${fechas}).`,
      { cobro_ids: [par.a.id, par.b.id] },
    );
  }

  // (5) Redondeo del T.C. de un pago en pesos (que sí convirtió).
  const topeRedondeo = Math.min(
    TOPE_REDONDEO_TC_USD,
    Math.max(TOLERANCIA_COBRO_USD, total * REDONDEO_FRACCION_TOTAL),
  );
  if (
    cobros.some((c) => c.moneda === 'MXN' && c.usd !== null) &&
    centavos(excedente) <= centavos(topeRedondeo)
  ) {
    return armar(
      'REDONDEO_TC',
      `Diferencia por tipo de cambio o redondeo del pago en pesos (menos de ${fmtDineroTexto(TOPE_REDONDEO_TC_USD, 'USD')}).`,
    );
  }

  // (6) El pago de otro vuelo del cliente (solo con la lectura del snapshot).
  if (e.otros_cobros_cliente && e.otros_cobros_cliente.length > 0) {
    const ventana = ventanaOtrosCobrosCliente(cobros);
    const enVentana = ventana
      ? e.otros_cobros_cliente.filter((o) => {
          const dia = diaDe(o.fecha_cobro);
          return dia !== null && dia >= ventana.desde && dia <= ventana.hasta;
        })
      : [];
    const otro = candidatoOtroVueloDelCliente(
      excedente,
      tcPrincipalDeCobros(cobros, e.tc_vuelo),
      enVentana,
    );
    if (otro) {
      const deVuelo =
        otro.folio != null ? `del vuelo #${otro.folio}` : 'de otro vuelo';
      return armar(
        'OTRO_VUELO_DEL_CLIENTE',
        `${linea}. Posible causa: el cobro de ${fmtDineroTexto(otro.monto, otro.moneda)} ${deVuelo} del mismo cliente sigue sin banco y equivale a lo cobrado de más: puede que un cobro de este vuelo incluya el pago de ese vuelo.`,
        {
          vuelo_id: otro.vuelo_id,
          folio: otro.folio,
          cobro_id: otro.cobro_id,
          monto: otro.monto,
          moneda: otro.moneda,
        },
      );
    }
  }

  // (7) Sin causa clara.
  return armar('SIN_CAUSA_CLARA', `${linea} y no se ve una causa clara.`);
}
