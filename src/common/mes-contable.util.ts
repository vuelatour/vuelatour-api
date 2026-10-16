/**
 * MES CONTABLE — reglas PURAS del CIERRE DE MES (16-oct-2026, API 0.0.88,
 * invariante 89, migración `20261016000004_cierre_mes.sql`).
 *
 * Pedido del cliente: «cerrar el mes que no es el corriente (el anterior) y
 * que los vuelos que aún no se cobren se marquen en el balance y se muevan al
 * siguiente mes hasta que se cobren y completen». Decisiones del 16-oct-2026:
 * se mueve el VUELO COMPLETO (venta, gastos de eje vuelo y comisiones); las
 * HORAS se quedan en su fecha real; cobro PARCIAL ⇒ pasa completo; los 5 de
 * septiembre cobrados en octubre PASAN a octubre; mes cerrado = bloqueado.
 *
 * FUENTES ÚNICAS que viven aquí (ningún lector repite la prueba):
 *  - `cobradoAlCorte`: Σ cobros (`cobrosEnUsd`, invariante 2) con
 *    `fecha_cobro` (día Cancún) ≤ último día del mes — LA prueba de «cobrado
 *    al cierre». NO es la bandera `vuelo.cobrado` (esa es el candado de
 *    revisión de cotización; los 5 de septiembre la tienen en true y aun así
 *    pasan a octubre porque se pagaron el 1, 2, 6 y 14 de octubre).
 *  - `decisionDiferir`: la regla de «se queda» / «pasa a M+1» con su motivo.
 *  - `mesContableDeGasto`: el mes de un GASTO = eje de
 *    `ubicacionBalanceDeGasto` (invariante 72): eje VUELO ⇒ mes contable del
 *    vuelo; eje GASTO ⇒ `fecha_gasto`.
 *  - Etiquetas y textos es-MX (leyendas de «Pasa a» / «Viene de» y el 409
 *    `MES_CERRADO`): el panel y pyservices COPIAN, nunca rearman.
 */
import { cobrosEnUsd, type CobroLike, type CobrosUsd } from './cobros-usd.util';
import {
  CATEGORIAS_GASTO_EMPRESA,
  categoriaEsPagoVendedor,
} from './categoria-gasto.util';
import { diaCancun } from './fecha-cancun.util';
import {
  diaContableDeVuelo,
  mesContableDeVuelo,
  mesRealDeVuelo,
  vueloDiferido,
  type VueloFechaContable,
} from './fecha-contable.util';
import { CATEGORIAS_REPARTIBLES } from './gasto-reparto.util';
import {
  esVueloExternoSinAvion,
  parcialEntraAlAvion,
  vueloEmbebido,
} from './hojas-balance.util';
import {
  ubicacionBalanceDeGasto,
  type GastoParaUbicacion,
  type RepartoDeGasto,
} from './ubicacion-balance-gasto.util';

export {
  diaContableDeVuelo,
  mesContableDeVuelo,
  mesRealDeVuelo,
  vueloDiferido,
  type VueloFechaContable,
};

/** Tolerancia de «cobrado por completo» (la de `refreshCobradoFlag`). */
export const TOLERANCIA_COBRADO_USD = 1;

const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

/** ¿'YYYY-MM' válido? */
export function esMesContable(mes: unknown): mes is string {
  return typeof mes === 'string' && RE_MES.test(mes);
}

function exigirMes(mes: string): { y: number; m: number } {
  if (!esMesContable(mes)) throw new Error(`Mes inválido: ${String(mes)}`);
  return { y: Number(mes.slice(0, 4)), m: Number(mes.slice(5, 7)) };
}

/** 'YYYY-MM' + 1 mes. */
export function mesSiguienteDe(mes: string): string {
  const { y, m } = exigirMes(mes);
  const d = new Date(Date.UTC(y, m, 1, 12));
  return d.toISOString().slice(0, 7);
}

/** 'YYYY-MM' − 1 mes. */
export function mesAnteriorDe(mes: string): string {
  const { y, m } = exigirMes(mes);
  const d = new Date(Date.UTC(y, m - 2, 1, 12));
  return d.toISOString().slice(0, 7);
}

/** Primer y último día (YYYY-MM-DD) del mes. */
export function rangoDelMes(mes: string): { desde: string; hasta: string } {
  const { y, m } = exigirMes(mes);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    desde: `${mes}-01`,
    hasta: `${mes}-${String(ultimo).padStart(2, '0')}`,
  };
}

/**
 * ¿El rango [desde, hasta] es EXACTAMENTE un mes calendario? Devuelve el mes
 * o null. Los cierres son por mes completo; el reparto/balance de un rango
 * parcial no lleva estado de cierre.
 */
export function mesCalendarioDeRango(
  desde: string,
  hasta: string,
): string | null {
  const mes = desde.slice(0, 7);
  if (!esMesContable(mes)) return null;
  const r = rangoDelMes(mes);
  return r.desde === desde.slice(0, 10) && r.hasta === hasta.slice(0, 10)
    ? mes
    : null;
}

/** Primer día del mes M+1 como timestamptz Cancún: '2026-10-01T00:00:00-05:00'. */
export function periodoContableSiguiente(mes: string): string {
  return periodoContableDe(mesSiguienteDe(mes));
}

/** Medianoche Cancún del día 1 del mes (lo que se guarda en `periodo_contable`). */
export function periodoContableDe(mes: string): string {
  exigirMes(mes);
  return `${mes}-01T00:00:00-05:00`;
}

/** Mes 'YYYY-MM' de un `periodo` (date 'YYYY-MM-01' o timestamptz del día 1). */
export function mesDePeriodo(
  periodo: string | null | undefined,
): string | null {
  if (typeof periodo !== 'string' || !periodo) return null;
  // 'YYYY-MM' tal cual: `new Date('2026-09')` es el 1-sep 00:00 UTC = el
  // 31-ago en Cancún (¡otro mes!).
  if (RE_MES.test(periodo)) return periodo;
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodo)) return periodo.slice(0, 7);
  try {
    return diaCancun(periodo).slice(0, 7);
  } catch {
    return null;
  }
}

const MESES_LARGOS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
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
 * 'Septiembre 2026' (o 'sep-2026' con `corta`). Primera letra mayúscula para
 * los títulos; `etiquetaMesMinuscula` para dentro de una frase.
 */
export function etiquetaMes(mes: string, corta = false): string {
  const { y, m } = exigirMes(mes);
  if (corta) return `${MESES_CORTOS[m - 1]}-${y}`;
  const nombre = MESES_LARGOS[m - 1];
  return `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} ${y}`;
}

/** 'septiembre 2026' (dentro de una frase). */
export function etiquetaMesMinuscula(mes: string): string {
  const { y, m } = exigirMes(mes);
  return `${MESES_LARGOS[m - 1]} ${y}`;
}

/** '16-oct' de un instante (día Cancún). */
export function diaCortoCancun(iso: string | null | undefined): string {
  if (!iso) return '';
  let dia: string;
  try {
    dia = diaCancun(iso);
  } catch {
    return '';
  }
  return `${Number(dia.slice(8, 10))}-${MESES_CORTOS[Number(dia.slice(5, 7)) - 1]}`;
}

/** '$2,076.40 USD' / '$36,632.89 MXN'. */
export function dineroTexto(
  monto: number,
  moneda: 'USD' | 'MXN' = 'USD',
): string {
  const n = Number.isFinite(monto) ? monto : 0;
  const signo = n < 0 ? '-' : '';
  return `${signo}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${moneda}`;
}

// ===== Cobrado al corte y decisión de diferir =====

/** Cobro con su fecha (lo que leen todos los libros por `vuelo_id`). */
export interface CobroParaCorte extends CobroLike {
  fecha_cobro?: string | null;
}

/**
 * Σ cobros con `fecha_cobro` (día Cancún) ≤ `ultimoDia` (YYYY-MM-DD), con
 * la MISMA conversión de `cobrosEnUsd` (invariante 2; MXN sin T.C. ⇒
 * `sin_tc_count`, jamás sumado crudo). Un cobro SIN fecha legible cuenta
 * (está registrado y no se puede probar que sea posterior).
 */
export function cobradoAlCorte(
  cobros: ReadonlyArray<CobroParaCorte>,
  tcVuelo: number | string | null | undefined,
  ultimoDia: string,
): CobrosUsd {
  const hastaCorte = cobros.filter((c) => {
    const f = c.fecha_cobro;
    if (typeof f !== 'string' || !f) return true;
    try {
      return diaCancun(f) <= ultimoDia;
    } catch {
      return true;
    }
  });
  const tc = tcVuelo != null && Number(tcVuelo) > 0 ? Number(tcVuelo) : null;
  return cobrosEnUsd(hastaCorte, tc);
}

export type MotivoDiferir = 'SIN_COBRO' | 'COBRO_PARCIAL' | 'COBRO_POSTERIOR';

export interface VueloParaDiferir {
  estado: string | null | undefined;
  monto_total_usd: number | string | null | undefined;
  tc_usd_mxn?: number | string | null | undefined;
  /** Cliente interno / de servicio: nada que cobrar. */
  cliente_interno?: boolean | null;
}

export interface DecisionDiferir {
  motivo: MotivoDiferir;
  venta_usd: number;
  /** Cobrado con fecha ≤ último día del mes que se cierra. */
  cobrado_usd: number;
  por_cobrar_usd: number;
  /** Cobrado con fecha POSTERIOR al mes (ya está pagado hoy). */
  cobrado_posterior_usd: number;
  /** Cobros MXN que no convirtieron (el pre-cierre los bloquea antes). */
  sin_tc_count: number;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * ¿Este vuelo SE QUEDA en el mes M que se cierra (null) o PASA a M+1?
 *  - CANCELADO ⇒ se queda (sus cobros retenidos y gastos son dinero real
 *    de M, regla del 28-ago-2026).
 *  - COMPLETADO sin precio (≤ 0) o de cliente interno ⇒ se queda (nada que
 *    cobrar; espejo de `cobros_pendientes`, que salta `clientesInternos`).
 *  - COMPLETADO con precio: cobrado al corte ≥ total − 1 USD ⇒ se queda
 *    (sobrecobro incluido); si no ⇒ PASA con motivo `SIN_COBRO` (0 al corte
 *    y nada después), `COBRO_PARCIAL` (algo al corte, no cubre) o
 *    `COBRO_POSTERIOR` (al corte no cubre, pero con TODOS los cobros sí: los
 *    5 de septiembre pagados en octubre).
 *  - Cualquier otro estado ⇒ PASA (`SIN_COBRO`): nunca llega aquí porque
 *    `vuelos_sin_completar` bloquea el cierre; se decide igual por si acaso.
 * `ultimoDia` = último día de M (YYYY-MM-DD).
 */
export function decisionDiferir(
  v: VueloParaDiferir,
  cobros: ReadonlyArray<CobroParaCorte>,
  ultimoDia: string,
): DecisionDiferir | null {
  const estado = v.estado ?? '';
  if (estado === 'CANCELADO') return null;
  const total = Number(v.monto_total_usd);
  const venta = Number.isFinite(total) && total > 0 ? round2(total) : 0;
  const tc = v.tc_usd_mxn ?? null;
  const alCorte = cobradoAlCorte(cobros, tc, ultimoDia);
  const todos = cobradoAlCorte(cobros, tc, '9999-12-31');
  if (estado === 'COMPLETADO') {
    if (venta <= 0 || v.cliente_interno === true) return null;
    if (alCorte.total_usd >= venta - TOLERANCIA_COBRADO_USD) return null;
  }
  const cobradoTodos = todos.total_usd;
  const posterior = round2(Math.max(0, cobradoTodos - alCorte.total_usd));
  const motivo: MotivoDiferir =
    estado === 'COMPLETADO' && cobradoTodos >= venta - TOLERANCIA_COBRADO_USD
      ? 'COBRO_POSTERIOR'
      : alCorte.total_usd > 0
        ? 'COBRO_PARCIAL'
        : 'SIN_COBRO';
  return {
    motivo,
    venta_usd: venta,
    cobrado_usd: round2(alCorte.total_usd),
    por_cobrar_usd: round2(Math.max(0, venta - alCorte.total_usd)),
    cobrado_posterior_usd: posterior,
    sin_tc_count: alCorte.sin_tc_count,
  };
}

// ===== Mes contable de un GASTO =====

/** El gasto con su vuelo embebido (`fecha_contable` cuando la sonda lo trae). */
export type GastoParaMesContable = GastoParaUbicacion;

/**
 * EJE en el que CUENTA un gasto: el de `ubicacionBalanceDeGasto` (invariante
 * 72) cuando el gasto vive en algún libro; si no vive en ninguno (pago al
 * vendedor —eje vuelo, invariantes 50/61—, PERSONAL_DUENO, TUAS sueltos, gas
 * sin avión, el hueco #255) se resuelve con las MISMAS reglas de eje: sin
 * vuelo, GAS (no externo), categoría de EMPRESA o reparto manual que entra al
 * avión ⇒ `gasto`; con vuelo ⇒ `vuelo`.
 */
export function ejeContableDeGasto(
  g: GastoParaMesContable,
  repartos: ReadonlyArray<RepartoDeGasto> = [],
): 'vuelo' | 'gasto' {
  const u = ubicacionBalanceDeGasto(g, repartos);
  if (u) return u.eje;
  const cat = g.categoria ?? '';
  if (!g.vuelo_id) return 'gasto';
  if (cat === 'GAS') {
    const vuelo = vueloEmbebido(g as unknown as Record<string, unknown>);
    return vuelo && esVueloExternoSinAvion(vuelo) ? 'vuelo' : 'gasto';
  }
  if (CATEGORIAS_GASTO_EMPRESA.has(cat)) return 'gasto';
  if (
    repartos.length > 0 &&
    CATEGORIAS_REPARTIBLES.has(cat) &&
    parcialEntraAlAvion(g) &&
    !categoriaEsPagoVendedor(cat)
  ) {
    return 'gasto';
  }
  return 'vuelo';
}

/**
 * Día (YYYY-MM-DD) en el que CUENTA un gasto: eje VUELO ⇒ día contable del
 * vuelo embebido (`fecha_contable` ⇒ un vuelo diferido arrastra sus gastos
 * al mes destino); eje GASTO ⇒ `fecha_gasto`. Si el eje es vuelo pero el
 * embed no trae fecha, `fecha_gasto` (jamás se inventa). `null` sin ninguna
 * fecha legible.
 */
export function diaContableDeGasto(
  g: GastoParaMesContable,
  repartos: ReadonlyArray<RepartoDeGasto> = [],
): string | null {
  const diaGasto =
    typeof g.fecha_gasto === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(g.fecha_gasto)
      ? g.fecha_gasto.slice(0, 10)
      : null;
  if (ejeContableDeGasto(g, repartos) === 'gasto') return diaGasto;
  const vuelo = vueloEmbebido(g as unknown as Record<string, unknown>);
  return diaContableDeVuelo(vuelo) ?? diaGasto;
}

/** Mes 'YYYY-MM' en el que CUENTA un gasto (ver `diaContableDeGasto`). */
export function mesContableDeGasto(
  g: GastoParaMesContable,
  repartos: ReadonlyArray<RepartoDeGasto> = [],
): string | null {
  const dia = diaContableDeGasto(g, repartos);
  return dia ? dia.slice(0, 7) : null;
}

// ===== Textos es-MX (fuente única; el panel y pyservices copian) =====

/** Lo mínimo de un cierre para los textos. */
export interface CierreParaTexto {
  periodo: string;
  cerrado_at?: string | null;
  cerrado_por_nombre?: string | null;
}

/** 'Ale' de 'Alejandra Pérez' (primer nombre); vacío ⇒ 'la oficina'. */
export function nombreCorto(nombre: string | null | undefined): string {
  const n = (nombre ?? '').trim();
  if (!n) return 'la oficina';
  return n.split(/\s+/)[0];
}

/** «Septiembre 2026 ya está cerrado (Ale, 16-oct). Reábrelo en Reportes para corregir.» */
export function textoMesCerrado(c: CierreParaTexto): string {
  const mes = mesDePeriodo(c.periodo) ?? c.periodo;
  const etiqueta = esMesContable(mes) ? etiquetaMes(mes) : mes;
  const quien = nombreCorto(c.cerrado_por_nombre);
  const cuando = diaCortoCancun(c.cerrado_at);
  const paren = cuando ? `${quien}, ${cuando}` : quien;
  return `${etiqueta} ya está cerrado (${paren}). Reábrelo en Reportes para corregir.`;
}

/** Leyenda del mes de ORIGEN: «Pasa a octubre 2026 · pendiente de cobro: cobrado $0.00 de $2,076.40 USD». */
export function leyendaPasaA(
  destino: string,
  d: Pick<DecisionDiferir, 'cobrado_usd' | 'venta_usd'>,
): string {
  return `Pasa a ${etiquetaMesMinuscula(destino)} · pendiente de cobro: cobrado ${dineroTexto(
    d.cobrado_usd,
  )} de ${dineroTexto(d.venta_usd)}`;
}

/** Leyenda en un mes ABIERTO: «Pendiente de cobro: pasará a octubre 2026 al cerrar (cobrado $0.00 de $2,076.40 USD)». */
export function leyendaPasara(
  destino: string,
  d: Pick<DecisionDiferir, 'cobrado_usd' | 'venta_usd'>,
): string {
  return `Pendiente de cobro: pasará a ${etiquetaMesMinuscula(destino)} al cerrar (cobrado ${dineroTexto(
    d.cobrado_usd,
  )} de ${dineroTexto(d.venta_usd)})`;
}

/** Leyenda del mes DESTINO: «Viene de septiembre 2026». */
export function leyendaVieneDe(origen: string): string {
  return `Viene de ${etiquetaMesMinuscula(origen)}`;
}

/** Status de cobro corto de la fila sombra del balance: 'Pasa a oct-2026'. */
export function statusCobroSombra(destino: string): string {
  return `Pasa a ${etiquetaMes(destino, true)}`;
}

/** Texto del 409 `MES_EN_CURSO`: «Octubre 2026 todavía está en curso: se cierra a partir del 1 de noviembre.». */
export function textoMesEnCurso(mes: string): string {
  const sig = mesSiguienteDe(mes);
  const nombre = MESES_LARGOS[Number(sig.slice(5, 7)) - 1];
  const anio =
    sig.slice(0, 4) === mes.slice(0, 4) ? '' : ` de ${sig.slice(0, 4)}`;
  return `${etiquetaMes(mes)} todavía está en curso: se cierra a partir del 1 de ${nombre}${anio}.`;
}

/** Texto del 409 `MES_ANTERIOR_ABIERTO`. */
export function textoMesAnteriorAbierto(mes: string, anterior: string): string {
  return `Para cerrar ${etiquetaMesMinuscula(mes)} primero cierra ${etiquetaMesMinuscula(anterior)}.`;
}

/** Texto del 409 `MES_SIGUIENTE_CERRADO`. */
export function textoMesSiguienteCerrado(siguiente: string): string {
  return `${etiquetaMes(siguiente)} ya está cerrado: reábrelo primero.`;
}

// ===== Clasificación de un vuelo en un periodo (fila normal / viene / sombra) =====

/** Cómo aparece un vuelo en un libro de [desde, hasta] (días Cancún). */
export type PapelContable = 'normal' | 'viene' | 'sombra' | 'fuera';

/**
 * - `normal`: su día real y su día contable caen en el periodo (todo lo de
 *   hoy; sin migración, siempre).
 * - `viene`: DIFERIDO a este periodo por un cierre (su día contable cae, su
 *   día real no): suma TODO su dinero aquí, sin horas.
 * - `sombra`: voló en este periodo pero se DIFIRIÓ fuera: sus horas se
 *   quedan aquí, su dinero NO.
 * - `fuera`: ninguno de los dos.
 */
export function papelContableEnPeriodo(
  v: VueloFechaContable,
  desde: string,
  hasta: string,
): PapelContable {
  const real = (() => {
    const iso = v.fecha_vuelo ?? null;
    if (typeof iso !== 'string' || !iso) return null;
    try {
      return diaCancun(iso);
    } catch {
      return null;
    }
  })();
  const contable = diaContableDeVuelo(v);
  const d = desde.slice(0, 10);
  const h = hasta.slice(0, 10);
  const dentro = (x: string | null) => x != null && x >= d && x <= h;
  const realDentro = dentro(real);
  const contableDentro = dentro(contable);
  if (contableDentro && (realDentro || !vueloDiferido(v))) return 'normal';
  if (contableDentro) return 'viene';
  if (realDentro) return 'sombra';
  return 'fuera';
}

/** Un diferimiento VIGENTE de la bitácora `cierre_mes_vuelo`. */
export interface DiferimientoVuelo {
  vuelo_id: string;
  /** 'YYYY-MM'. */
  origen: string;
  /** 'YYYY-MM'. */
  destino: string;
  folio: number | null;
  cliente: string | null;
  aeronave_id: string | null;
  matricula: string | null;
  venta_usd: number;
  cobrado_usd: number;
  por_cobrar_usd: number;
  motivo: MotivoDiferir;
}

/**
 * Mes del que VIENE un vuelo diferido al mes `mes`: el `origen` del
 * diferimiento cuyo destino es `mes`; sin bitácora, su mes real.
 */
export function origenDeVuelo(
  v: VueloFechaContable & { id: string },
  mes: string,
  bitacora: ReadonlyArray<DiferimientoVuelo>,
): string | null {
  const fila = bitacora.find((b) => b.vuelo_id === v.id && b.destino === mes);
  return fila?.origen ?? mesRealDeVuelo(v);
}

/**
 * Diferimiento con el que un vuelo SALIÓ del mes `mes` (su origen = `mes`);
 * null si no hay (el llamador decide con la regla).
 */
export function salidaDeVuelo(
  vueloId: string,
  mes: string,
  bitacora: ReadonlyArray<DiferimientoVuelo>,
): DiferimientoVuelo | null {
  return (
    bitacora.find((b) => b.vuelo_id === vueloId && b.origen === mes) ?? null
  );
}

/** Pre-cierre: «Pasará a octubre 2026 al cerrar (cobrado $0.00 de $2,076.40 USD)». */
export function leyendaPasaraAlCerrar(
  destino: string,
  d: Pick<DecisionDiferir, 'cobrado_usd' | 'venta_usd'>,
): string {
  return `Pasará a ${etiquetaMesMinuscula(destino)} al cerrar (cobrado ${dineroTexto(
    d.cobrado_usd,
  )} de ${dineroTexto(d.venta_usd)})`;
}

// ===== ¿Se puede cerrar este mes? (orden y estado; sin el pre-cierre) =====

/**
 * Primer mes cerrable cuando no hay inicio oficial configurado (invariante
 * 86): el sistema arrancó oficialmente en septiembre de 2026.
 */
export const MES_PRIMER_CIERRE = '2026-09';

export type MotivoNoCerrable =
  | 'PERIODO_ANTES_DEL_INICIO'
  | 'MES_EN_CURSO'
  | 'YA_CERRADO'
  | 'MES_ANTERIOR_ABIERTO'
  | 'PRECIERRE_NO_LISTO';

/**
 * Por qué NO se puede cerrar `mes` (null = se puede), en el orden de las
 * precondiciones de `POST /v1/cierres/:periodo`: antes del inicio oficial,
 * mes en curso o futuro, ya cerrado, mes anterior abierto (salvo el primer
 * mes desde el inicio) y, si se conoce, pre-cierre no listo. PURA.
 */
export function motivoNoCerrable(e: {
  mes: string;
  mesEnCurso: string;
  /** 'YYYY-MM' del inicio oficial (null ⇒ `MES_PRIMER_CIERRE`). */
  mesInicio: string | null;
  cerrados: ReadonlySet<string>;
  /** `listo` del pre-cierre; undefined/null = no se evaluó. */
  listo?: boolean | null;
}): MotivoNoCerrable | null {
  const inicio = e.mesInicio ?? MES_PRIMER_CIERRE;
  if (e.mes < inicio) return 'PERIODO_ANTES_DEL_INICIO';
  if (e.mes >= e.mesEnCurso) return 'MES_EN_CURSO';
  if (e.cerrados.has(e.mes)) return 'YA_CERRADO';
  const anterior = mesAnteriorDe(e.mes);
  if (anterior >= inicio && !e.cerrados.has(anterior)) {
    return 'MES_ANTERIOR_ABIERTO';
  }
  if (e.listo === false) return 'PRECIERRE_NO_LISTO';
  return null;
}

/** Texto es-MX del motivo (el panel lo copia en el tooltip). */
export function textoMotivoNoCerrable(
  motivo: MotivoNoCerrable,
  mes: string,
  inicio: string | null = null,
): string {
  switch (motivo) {
    case 'PERIODO_ANTES_DEL_INICIO':
      return `${etiquetaMes(mes)} es anterior al inicio oficial del sistema${inicio ? ` (${inicio})` : ''}: no se cierra aquí.`;
    case 'MES_EN_CURSO':
      return textoMesEnCurso(mes);
    case 'YA_CERRADO':
      return `${etiquetaMes(mes)} ya está cerrado.`;
    case 'MES_ANTERIOR_ABIERTO':
      return textoMesAnteriorAbierto(mes, mesAnteriorDe(mes));
    case 'PRECIERRE_NO_LISTO':
      return `Antes de cerrar ${etiquetaMesMinuscula(mes)} resuelve los pendientes que bloquean el pre-cierre.`;
  }
}

/**
 * Meses válidos para la fecha de un gasto de un vuelo: del mes REAL al mes
 * CONTABLE inclusive (iguales salvo en un vuelo diferido al cerrar un mes,
 * invariante 89). Un contable anterior al real (no existe) ⇒ solo el real.
 */
export function mesesPermitidosDelVuelo(
  mesReal: string,
  mesContable: string | null,
): string[] {
  const fin = mesContable && mesContable > mesReal ? mesContable : mesReal;
  const out: string[] = [];
  let m = mesReal;
  for (let i = 0; i < 24 && m <= fin; i += 1) {
    out.push(m);
    const [y, mm] = m.split('-').map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
  }
  return out;
}
