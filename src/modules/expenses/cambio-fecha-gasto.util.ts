/**
 * FECHA DEL PAGO DESDE CONCILIACIÓN (14-oct-2026, API 0.0.76, invariante 74,
 * SIN migración). Pedido de la oficina en «Vincular gasto» de
 * /admin/conciliacion: corregir la fecha del gasto «solo para ajustar bien».
 * Decisión del 13-oct-2026: la fecha del gasto es la FECHA DEL PAGO (la del
 * cargo del banco). Ruta `PATCH /v1/expenses/:id/fecha`
 * (`ExpensesService.cambiarFechaGasto`).
 *
 * PURO (sin BD ni Nest): aquí viven la DECISIÓN y los TEXTOS. El servicio
 * solo lee el gasto (`GASTO_CAMBIO_FECHA_COLS`), sus repartos y las
 * matrículas, y escribe por `update(…, { autoCruce: false })` con CAS sobre
 * el `updated_at` leído: JAMÁS dispara el auto-cruce (liga la persona con
 * «Vincular»).
 *
 * Candados, en este orden (`decidirCambioFechaGasto`): medio bancario (409)
 * → YA CONCILIADO (409: su fecha es la del cargo con el que ya está ligado;
 * revisión del 14-oct-2026) → misma fecha (200 sin escribir) →
 * `fecha_anterior` ≠ la vigente (409) → mes del vuelo = ESPEJO EXACTO de
 * `fechasFuera` del balance (409) → confirmación (409
 * FECHA_GASTO_CONFIRMAR) cuando la fecha mueve un libro de mes o cambia el
 * T.C. con que un libro convierte el gasto en un mes que ya terminó (el
 * reparto, o el bloque VUELATOUR del Balance general para las sueltas de
 * «otros movimientos») → aplicar.
 *
 * Los TEXTOS de la confirmación son ESPEJO de los libros, no reglas nuevas:
 * el balance por `ubicacionBalanceDeGasto` (invariante 72) y las filas
 * sueltas de «otros movimientos» (`buildOtrosMovimientos`), el reparto por
 * los conjuntos de `profit-sharing/grupos-reparto.util` (los del ternario de
 * `computeAvion`) y el Libro Dinero por sus dos lecturas por `fecha_gasto`
 * (`dinero-report.service`). Si un libro cambia, solo puede desfasarse un
 * TEXTO (nunca un número): la ALARMA DE PARIDAD del spec lee esos servicios
 * como texto.
 */
import {
  CATEGORIAS_GASTO_EMPRESA,
  CATEGORIAS_GASTO_FUERA_DEL_AVION,
  categoriaEsPagoVendedor,
} from '../../common/categoria-gasto.util';
import { mesContableDeVuelo } from '../../common/fecha-contable.util';
import { mesesPermitidosDelVuelo } from '../../common/mes-contable.util';

export { mesesPermitidosDelVuelo };
import {
  diaCancun,
  diasEntreDiasCancun,
  moverDiasHoraParedCancun,
} from '../../common/fecha-cancun.util';
import {
  avionDeGastoEmbebido,
  esVueloExternoSinAvion,
  vueloEmbebido,
} from '../../common/hojas-balance.util';
import {
  ubicacionBalanceDeGasto,
  type GastoParaUbicacion,
  type RepartoDeGasto,
} from '../../common/ubicacion-balance-gasto.util';
import { CATEGORIAS_REPARTIBLES } from '../../common/gasto-reparto.util';
import { esPagoAfac } from '../../common/afac-real.util';
import {
  esMedioBancario,
  MEDIO_BODEGA,
} from '../conciliacion/gastos-candidatos.util';
import {
  esFechaDia,
  etiquetaMes,
  etiquetaMesCorta,
} from '../profit-sharing/reparto-pago.util';
import {
  COMBUSTIBLE,
  DIRECTO,
  FIJO,
  INDIRECTO,
  PERMISO,
  TUAS_CAT,
} from '../profit-sharing/grupos-reparto.util';

/**
 * Días hacia atrás que acepta la ruta: la MISMA banda de oficina de
 * `ExpensesService.update()` (`assertFechaRazonable`: más de 365 días atrás
 * ⇒ 400), con el mismo borde exacto (365 pasa, 366 no) y la misma cuenta de
 * días (mediodía UTC). Hacia adelante la ruta es MÁS estricta: nunca después
 * de hoy en Cancún (la oficina en el PATCH general acepta hasta +30).
 */
export const CAMBIO_FECHA_DIAS_ATRAS_MAX = 365;

/**
 * `code` de cada rechazo. Prefijo FECHA_GASTO_ a propósito:
 * FECHA_PAGO_INVALIDA y FECHA_PAGO_FUTURA ya existen para las entregas a
 * socios (`reparto-pago.util`).
 */
export const CODIGO_CAMBIO_FECHA = {
  INVALIDA: 'FECHA_GASTO_INVALIDA',
  FUTURA: 'FECHA_GASTO_FUTURA',
  MUY_ANTIGUA: 'FECHA_GASTO_MUY_ANTIGUA',
  SOLO_BANCARIOS: 'FECHA_GASTO_SOLO_BANCARIOS',
  CAMBIO: 'FECHA_GASTO_CAMBIO',
  FUERA_DEL_MES_DEL_VUELO: 'FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO',
  CONFIRMAR: 'FECHA_GASTO_CONFIRMAR',
  /**
   * Revisión del 14-oct-2026: el gasto ya quedó CUBIERTO por un cargo del
   * banco (`gasto.conciliado`, lo escribe la BD al ligar). Su fecha es la de
   * ese pago; el panel nunca ofrece conciliados, así que solo atrapa la
   * carrera de quien lo ligó mientras «Vincular gasto» seguía abierto.
   */
  YA_CONCILIADO: 'FECHA_GASTO_YA_CONCILIADO',
} as const;

/**
 * Lo que la ruta lee del gasto: la forma de embeds de `GASTO_UBICACION_COLS`
 * (Conciliación, invariante 72) + el folio del vuelo, el medio, la moneda,
 * el T.C., la hora de la carga, `conciliado` (candado del 14-oct-2026) y el
 * `updated_at` del CAS.
 */
export const GASTO_CAMBIO_FECHA_COLS =
  'id, categoria, medio_pago, moneda, tc_gasto, monto, fecha_gasto, fecha_hora_carga, conciliado, updated_at, vuelo_id, aeronave_id, escala_id, inventario_movimiento_id, escala:escala_id(aeronave_id), vuelo:vuelo_id(folio, fecha_vuelo, aeronave_id, es_externo)';

/**
 * CIERRE DE MES (16-oct-2026, invariante 89): con la migración
 * `20261016000004` el embed del vuelo trae además su mes contable
 * (`periodo_contable`, `fecha_contable`). Sin ella, la de siempre.
 */
export function gastoCambioFechaCols(
  cierreDisponible: boolean,
  afacDisponible = false,
): string {
  const base = cierreDisponible
    ? GASTO_CAMBIO_FECHA_COLS.replace(
        'vuelo:vuelo_id(folio, fecha_vuelo, aeronave_id, es_externo)',
        'vuelo:vuelo_id(folio, fecha_vuelo, aeronave_id, es_externo, periodo_contable, fecha_contable)',
      )
    : GASTO_CAMBIO_FECHA_COLS;
  // AFAC POR VUELO (16-oct-2026, invariante 90): con la migración
  // 20261016000005 la lectura trae la marca «Pago de AFAC» (no mueve reparto).
  return afacDisponible
    ? base.replace(
        'inventario_movimiento_id,',
        'inventario_movimiento_id, es_pago_afac,',
      )
    : base;
}

/** Vuelo embebido (`vuelo:vuelo_id(…)`), con el folio para los textos. */
export interface VueloCambioFecha {
  folio?: number | null;
  fecha_vuelo?: string | null;
  /** Cierre de mes (invariante 89), solo con la migración. */
  periodo_contable?: string | null;
  fecha_contable?: string | null;
  aeronave_id?: string | null;
  es_externo?: boolean | null;
}

/** El gasto leído con `GASTO_CAMBIO_FECHA_COLS`. */
export interface GastoCambioFecha extends GastoParaUbicacion {
  fecha_gasto: string;
  medio_pago: string | null;
  moneda: string | null;
  tc_gasto: number | string | null;
  fecha_hora_carga: string | null;
  /** true = CUBIERTO por cargos del banco (lo escribe la BD al ligar). */
  conciliado?: boolean | null;
  updated_at: string;
  vuelo?: VueloCambioFecha | VueloCambioFecha[] | null;
}

/** Rechazo con su status HTTP, `code` estable y `details` opcionales. */
export interface ErrorCambioFecha {
  status: 400 | 409;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type DecisionCambioFecha =
  | { tipo: 'ERROR'; error: ErrorCambioFecha }
  | { tipo: 'SIN_CAMBIO' }
  | { tipo: 'CONFIRMAR'; error: ErrorCambioFecha }
  | {
      tipo: 'APLICAR';
      fecha_hora_carga: string | null;
      cambia_de_mes: boolean;
      aviso: string | null;
    };

/** Respuesta 200 de `PATCH /v1/expenses/:id/fecha`. */
export interface CambioFechaGastoRespuesta {
  id: string;
  /** La que quedó (YYYY-MM-DD). */
  fecha_gasto: string;
  /** La que tenía antes de ESTA llamada (= fecha_gasto si cambio = false). */
  fecha_anterior: string;
  /** false = ya tenía esa fecha: no escribió ni movió `updated_at`. */
  cambio: boolean;
  cambia_de_mes: boolean;
  /** La hora de la carga que QUEDÓ en la fila (movida o no). */
  fecha_hora_carga: string | null;
  /**
   * ADITIVO (revisión del 14-oct-2026): true SOLO si ESTA llamada movió la
   * hora de la carga al día nuevo. `fecha_hora_carga` es la de la fila y no
   * basta: una carga que ya caía en el día nuevo no se toca.
   */
  fecha_hora_carga_movida: boolean;
  updated_at: string;
  /** La línea de «mes terminado» cuando hubo confirmación; si no, null. */
  aviso: string | null;
}

/** Qué reparto a socios mueve la fecha (SOLO decide textos, nunca números). */
export type AlcanceRepartoPorFecha =
  | { tipo: 'AVION'; avion: string }
  | { tipo: 'PARTES'; aviones: string[] }
  | { tipo: 'FLOTA' };

/** Entrada de `decidirCambioFechaGasto`. */
export interface EntradaCambioFecha {
  gasto: GastoCambioFecha;
  /** La fecha nueva (YYYY-MM-DD, ya validada con `errorDeFechasCambio`). */
  nueva: string;
  /** La que el operador VIO en pantalla (candado de campo). */
  anterior: string;
  /** Hoy en Cancún (YYYY-MM-DD). */
  hoy: string;
  /** true = el operador confirmó el texto del 409 FECHA_GASTO_CONFIRMAR. */
  confirmar: boolean;
  repartos: ReadonlyArray<RepartoDeGasto>;
  /** Matrícula de un avión (null si no se pudo leer: textos «del avión»). */
  matricula: (aeronaveId: string) => string | null;
}

const MEDIO_EFECTIVO = 'EFECTIVO';

const TEXTO_SOLO_BANCARIOS_EFECTIVO =
  'Este gasto se pagó en efectivo: su fecha decide qué reposición de caja chica lo cubre y no se cambia desde Conciliación. Si está mal, corrígela en Gastos → Verificar / editar.';
const TEXTO_SOLO_BANCARIOS_BODEGA =
  'Es una salida de inventario (bodega): su fecha es la del movimiento de la bodega y no se cambia desde Conciliación.';
const TEXTO_SOLO_BANCARIOS_OTRO =
  'Este gasto no se pagó por el banco: desde Conciliación solo se corrige la fecha de los pagos con tarjeta, transferencia, PayWise o pago domiciliado. Si está mal, corrígela en Gastos → Verificar / editar.';

const LINEA_TC_REPARTO =
  'El reparto convierte este gasto en pesos con el tipo de cambio oficial del día del gasto: con la fecha nueva cambia lo que vale en dólares.';

/**
 * Las filas SUELTAS de «otros movimientos» en pesos (TUAS sin vuelo, gas sin
 * avión): el bloque VUELATOUR del Balance general las regresa a dólares con
 * el T.C. oficial de SU día (`tcDeGastoSuelto`). Revisión del 14-oct-2026:
 * antes, moverlas dentro de un mes TERMINADO se guardaba sin confirmar aunque
 * al regenerar ese mes su bloque VUELATOUR cambiara (ej.: $5,000 del 7 al 30
 * de septiembre ⇒ 296.04 → 277.40 USD).
 */
const LINEA_TC_BALANCE_GENERAL =
  'El balance general convierte este gasto a dólares con el tipo de cambio oficial del día del gasto: con la fecha nueva cambia lo que vale en dólares.';

/** 409 FECHA_GASTO_YA_CONCILIADO (revisión del 14-oct-2026). */
export const TEXTO_YA_CONCILIADO =
  'Este gasto ya quedó conciliado con un cargo del banco: su fecha es la de ese pago y ya no se cambia desde Conciliación. Si ese cargo no es su pago, desvincúlalo primero.';

const LINEA_REPARTO_FLOTA =
  'Es un gasto fijo: el reparto a socios lo prorratea entre toda la flota, así que cambia la utilidad de todos los aviones en los dos meses.';

/** '2026-09-07' ⇒ '07 sep 2026' (el formato de `fmtDateOnly` del panel). */
export function diaTexto(dia: string): string {
  return `${dia.slice(8, 10)} ${etiquetaMesCorta(dia.slice(0, 7))}`;
}

/** [] ⇒ ''; ['A'] ⇒ 'A'; ['A','B'] ⇒ 'A y B'; ['A','B','C'] ⇒ 'A, B y C'. */
function listaY(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}

/** Primera letra en mayúscula. */
function mayus(s: string): string {
  return s ? `${s[0].toUpperCase()}${s.slice(1)}` : s;
}

/**
 * Las dos fechas ANTES de tocar la BD: día real (las dos), nunca después de
 * hoy en Cancún y nunca de hace más de `CAMBIO_FECHA_DIAS_ATRAS_MAX` días
 * (365 pasa; 366 no). Aquí no existe «permitir fecha antigua»: una fecha
 * tan vieja se corrige en Gastos → Verificar / editar.
 */
export function errorDeFechasCambio(
  nueva: string,
  anterior: string,
  hoy: string,
): ErrorCambioFecha | null {
  // `: boolean` explícito: sin él, el type guard de `esFechaDia` (o el
  // predicado que TS infiere) dejaría el valor como `never` en el texto.
  const invalida = [nueva, anterior].find((f): boolean => !esFechaDia(f));
  if (invalida !== undefined) {
    return {
      status: 400,
      code: CODIGO_CAMBIO_FECHA.INVALIDA,
      message: `La fecha «${invalida}» no existe en el calendario: elígela con el calendario.`,
    };
  }
  if (nueva > hoy) {
    return {
      status: 400,
      code: CODIGO_CAMBIO_FECHA.FUTURA,
      message: `La fecha del pago (${diaTexto(nueva)}) es posterior a hoy (${diaTexto(hoy)}): el banco no cobra en días que no han pasado.`,
    };
  }
  if (diasEntreDiasCancun(nueva, hoy) > CAMBIO_FECHA_DIAS_ATRAS_MAX) {
    return {
      status: 400,
      code: CODIGO_CAMBIO_FECHA.MUY_ANTIGUA,
      message: `La fecha del pago (${diaTexto(nueva)}) es de hace más de un año: revisa el año. Una fecha tan antigua se corrige en Gastos → Verificar / editar.`,
    };
  }
  return null;
}

/**
 * Solo los medios que tocan el banco (`MEDIOS_BANCARIOS`, fuente única de
 * Conciliación). EFECTIVO: su fecha decide qué reposición de caja chica lo
 * cubre; BODEGA: es la fecha del movimiento de inventario; PERSONAL_* o un
 * medio desconocido: no los pagó el banco.
 */
export function errorMedioNoBancario(
  medio: string | null | undefined,
): ErrorCambioFecha | null {
  if (esMedioBancario(medio)) return null;
  return {
    status: 409,
    code: CODIGO_CAMBIO_FECHA.SOLO_BANCARIOS,
    message:
      medio === MEDIO_EFECTIVO
        ? TEXTO_SOLO_BANCARIOS_EFECTIVO
        : medio === MEDIO_BODEGA
          ? TEXTO_SOLO_BANCARIOS_BODEGA
          : TEXTO_SOLO_BANCARIOS_OTRO,
    details: { medio_pago: medio ?? null },
  };
}

/**
 * ¿Qué reparto a socios mueve la fecha? ESPEJO del ternario de
 * `computeAvion` (`profit-sharing.service.ts`) y del pool de FIJO, con los
 * MISMOS conjuntos (`grupos-reparto.util`). SOLO decide TEXTOS:
 *  - TUAS y las DOS del pago al vendedor ⇒ null (EXCLUIDAS por fecha);
 *  - con partes de reparto manual y categoría repartible ⇒ sus aviones;
 *  - FIJO sin reparto ⇒ toda la flota (pool prorrateado);
 *  - otra categoría de EMPRESA sin reparto ⇒ null (EXCLUIDA);
 *  - COMBUSTIBLE (GAS: su propia línea desde el 23-oct-2026, invariante
 *    104), DIRECTO, INDIRECTO (REFACCION, SERVICIOS y, desde el 20-oct-2026
 *    —invariante 99—, la categoría INDIRECTO) y PERMISO ⇒ su avión
 *    (`avionDeGastoEmbebido`, la regla de `avionDelGasto`) o null sin avión;
 *  - el resto (NOMINA sin reparto, PERSONAL_DUENO, categorías futuras) ⇒
 *    null.
 */
export function alcanceRepartoPorFecha(
  g: GastoCambioFecha,
  repartos: ReadonlyArray<RepartoDeGasto>,
): AlcanceRepartoPorFecha | null {
  const cat = g.categoria ?? '';
  if (cat === TUAS_CAT || categoriaEsPagoVendedor(cat)) return null;
  // Pago de AFAC marcado (invariante 90): grupo EXCLUIDO del reparto.
  if (esPagoAfac(g)) return null;
  if (repartos.length > 0 && CATEGORIAS_REPARTIBLES.has(cat)) {
    return {
      tipo: 'PARTES',
      aviones: [
        ...new Set(repartos.map((r) => r.aeronave_id).filter((a) => !!a)),
      ],
    };
  }
  if (cat === FIJO) return { tipo: 'FLOTA' };
  if (CATEGORIAS_GASTO_EMPRESA.has(cat)) return null;
  if (
    COMBUSTIBLE.has(cat) ||
    DIRECTO.has(cat) ||
    INDIRECTO.has(cat) ||
    PERMISO.has(cat)
  ) {
    const avion = avionDeGastoEmbebido(g as unknown as Record<string, unknown>);
    return avion ? { tipo: 'AVION', avion } : null;
  }
  return null;
}

/**
 * ¿El Libro Dinero lo lee por `fecha_gasto`? ESPEJO de sus dos lecturas
 * por fecha (`dinero-report.service`): «otros gastos» = sin vuelo o de
 * EMPRESA, salvo PERSONAL_DUENO; «combustible» = todo GAS.
 */
export function libroDineroPorFecha(
  g: Pick<GastoCambioFecha, 'categoria' | 'vuelo_id'>,
): boolean {
  const cat = g.categoria ?? '';
  if (cat === 'PERSONAL_DUENO') return false;
  return !g.vuelo_id || CATEGORIAS_GASTO_EMPRESA.has(cat) || cat === 'GAS';
}

/**
 * La hora de la carga de combustible al día nuevo, CONSERVANDO su hora de
 * pared en Cancún (regla de «Verificar / editar» y de la carga masiva: el
 * día Cancún de `fecha_hora_carga` = `fecha_gasto`). null = no se toca: sin
 * hora, ya cae en el día nuevo o no se pudo leer.
 */
export function fechaHoraCargaAlDia(
  fhc: string | null | undefined,
  nueva: string,
): string | null {
  if (!fhc) return null;
  try {
    const dias = diasEntreDiasCancun(diaCancun(fhc), nueva);
    if (dias === 0) return null;
    return moverDiasHoraParedCancun(fhc, dias);
  } catch {
    return null;
  }
}

/**
 * Aviones cuyas matrículas pueden salir en los textos (solo se leen si
 * cambia el mes): los del balance con la fecha nueva, el del gasto y los de
 * su reparto. Únicos y sin nulos.
 */
export function avionesParaTextos(
  g: GastoCambioFecha,
  nueva: string,
  repartos: ReadonlyArray<RepartoDeGasto>,
): string[] {
  const lista: Array<string | null | undefined> = [
    ...(ubicacionBalanceDeGasto({ ...g, fecha_gasto: nueva }, repartos)
      ?.aviones ?? []),
    avionDeGastoEmbebido(g as unknown as Record<string, unknown>),
    ...repartos.map((r) => r.aeronave_id),
  ];
  return [
    ...new Set(lista.filter((a): a is string => typeof a === 'string' && !!a)),
  ];
}

/** Día Cancún de un instante; null si no se puede leer (nunca lanza). */
function diaCancunSeguro(iso: string): string | null {
  try {
    const dia = diaCancun(iso);
    return esFechaDia(dia) ? dia : null;
  } catch {
    return null;
  }
}

/** El vuelo de un gasto con fecha legible: su día y mes Cancún y su folio. */
export interface VueloDeGastoFecha {
  /** Día Cancún de `fecha_vuelo` (YYYY-MM-DD). */
  dia: string;
  /** YYYY-MM (mes REAL del vuelo). */
  mes: string;
  folio: number | null;
  /**
   * CIERRE DE MES (16-oct-2026, invariante 89): mes CONTABLE del vuelo
   * (`fecha_contable`): = `mes` salvo en un vuelo DIFERIDO al cerrar un mes.
   */
  mes_contable: string;
  /**
   * Meses en los que un gasto del vuelo puede quedar sin «FUERA del
   * periodo»: del mes real al contable (un diferido acepta los dos). Fuente
   * única `mesesPermitidosDelVuelo`.
   */
  meses: string[];
}

/** El vuelo del gasto (`vuelo_id` + embed con `fecha_vuelo` legible) o null. */
function vueloDeGasto(g: {
  vuelo_id?: string | null;
  vuelo?: unknown;
}): VueloDeGastoFecha | null {
  if (!g.vuelo_id) return null;
  const v = vueloEmbebido(g);
  const dia =
    typeof v?.fecha_vuelo === 'string' ? diaCancunSeguro(v.fecha_vuelo) : null;
  if (!dia) return null;
  const mes = dia.slice(0, 7);
  const contable = mesContableDeVuelo(v) ?? mes;
  return {
    dia,
    mes,
    folio: typeof v?.folio === 'number' ? v.folio : null,
    mes_contable: contable,
    meses: mesesPermitidosDelVuelo(mes, contable),
  };
}

/**
 * El CANDADO DEL MES DEL VUELO (ESPEJO EXACTO de `fechasFuera` del balance):
 * un gasto con vuelo de fecha legible y categoría FUERA de
 * `CATEGORIAS_GASTO_FUERA_DEL_AVION` solo mueve su fecha dentro del mes que
 * ya tiene o al mes de su vuelo (día Cancún). null = no aplica. FUENTE
 * ÚNICA: la usan `decidirCambioFechaGasto` (409
 * FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO) y la ficha del candidato de
 * «Vincular gasto» (`candado_mes_vuelo`, revisión del 14-oct-2026: el panel
 * ya no invita a una fecha que aquí se rechaza; caso vivo: el TAXI del vuelo
 * #109 del 31-jul contra el cargo del Tren Maya del 10-ago).
 */
export function candadoMesDelVuelo(g: {
  categoria?: string | null;
  vuelo_id?: string | null;
  vuelo?: unknown;
}): VueloDeGastoFecha | null {
  if (CATEGORIAS_GASTO_FUERA_DEL_AVION.has(g.categoria ?? '')) return null;
  return vueloDeGasto(g);
}

/**
 * ¿El gasto es una fila SUELTA de «otros movimientos» del Balance general?
 * ESPEJO de `buildOtrosMovimientos` (`aircraft-balance.service.ts`): TUAS
 * sin vuelo, con o sin avión (`tuasSueltos` y `tuasSinVueloRes`), y GAS sin
 * avión sellado que ningún tramo ni vuelo resuelve y que no es de un vuelo
 * EXTERNO sin avión (`gasRes`). Se leen por `fecha_gasto` y, en pesos, el
 * bloque VUELATOUR las convierte con el T.C. oficial de SU día.
 */
export function esSueltaOtrosMovimientos(g: GastoCambioFecha): boolean {
  const cat = g.categoria ?? '';
  if (cat === TUAS_CAT) return !g.vuelo_id;
  if (cat !== 'GAS' || g.aeronave_id) return false;
  const crudo = g as unknown as Record<string, unknown>;
  return (
    !esVueloExternoSinAvion(vueloEmbebido(crudo)) &&
    avionDeGastoEmbebido(crudo) == null
  );
}

/**
 * La decisión completa, en el orden de los candados (ver la cabecera). El
 * mes del vuelo es el ESPEJO EXACTO del predicado `fechasFuera` del balance
 * (`aircraft-balance.service.ts`, fuente única `candadoMesDelVuelo`): gasto
 * con vuelo de fecha legible, su categoría fuera de
 * `CATEGORIAS_GASTO_FUERA_DEL_AVION`, y el mes nuevo distinto del mes del
 * vuelo (día Cancún) Y del mes que ya tenía — Conciliación jamás CREA ese
 * pendiente (sí deja moverse dentro de un mes y REGRESAR al mes del vuelo).
 * Responde así aunque llegue confirmar.
 */
export function decidirCambioFechaGasto(
  e: EntradaCambioFecha,
): DecisionCambioFecha {
  const g = e.gasto;
  const noBancario = errorMedioNoBancario(g.medio_pago);
  if (noBancario) return { tipo: 'ERROR', error: noBancario };
  // Revisión del 14-oct-2026: un gasto ya CUBIERTO por un cargo del banco
  // tiene la fecha de ese pago. La lista de «Vincular gasto» no los ofrece;
  // esto atrapa a quien lo ligó (con «Vincular», «Cruzar pendientes» o el
  // PATCH de «Verificar / editar») mientras el diálogo seguía abierto —
  // antes la fecha se movía a la de OTRO cargo y sacaba el gasto de su mes.
  if (g.conciliado === true) {
    return {
      tipo: 'ERROR',
      error: {
        status: 409,
        code: CODIGO_CAMBIO_FECHA.YA_CONCILIADO,
        message: TEXTO_YA_CONCILIADO,
      },
    };
  }
  const actual = String(g.fecha_gasto).slice(0, 10);
  if (actual === e.nueva) return { tipo: 'SIN_CAMBIO' };
  if (actual !== e.anterior) {
    return {
      tipo: 'ERROR',
      error: {
        status: 409,
        code: CODIGO_CAMBIO_FECHA.CAMBIO,
        message: `La fecha de este gasto cambió mientras tanto (ahora dice ${diaTexto(actual)}): revisa y vuelve a intentarlo.`,
        details: { fecha_actual: actual },
      },
    };
  }
  const mesActual = actual.slice(0, 7);
  const mesNuevo = e.nueva.slice(0, 7);
  // El vuelo (para los textos) y su candado (solo si la categoría lo tiene).
  const vuelo = vueloDeGasto(g);
  const mesVuelo = vuelo?.mes ?? null;
  const folio = vuelo?.folio ?? null;
  const candado = candadoMesDelVuelo(g);
  if (candado && !candado.meses.includes(mesNuevo) && mesNuevo !== mesActual) {
    return {
      tipo: 'ERROR',
      error: {
        status: 409,
        code: CODIGO_CAMBIO_FECHA.FUERA_DEL_MES_DEL_VUELO,
        message: textoFueraDelMesDelVuelo(
          candado.folio,
          candado.dia,
          mesNuevo,
          candado.mes,
          candado.mes_contable,
        ),
        details: {
          vuelo_folio: candado.folio,
          vuelo_dia: candado.dia,
          mes_vuelo: candado.mes,
          mes_nuevo: mesNuevo,
          // ADITIVO (invariante 89): solo cuando el vuelo fue DIFERIDO.
          ...(candado.mes_contable !== candado.mes
            ? { mes_contable: candado.mes_contable, meses: candado.meses }
            : {}),
        },
      },
    };
  }
  const fhc = fechaHoraCargaAlDia(g.fecha_hora_carga, e.nueva);
  const cambiaDeMes = mesNuevo !== mesActual;
  const mesHoy = e.hoy.slice(0, 7);
  const terminados = [...new Set([mesActual, mesNuevo])]
    .filter((m) => m < mesHoy)
    .sort();
  const alcance = alcanceRepartoPorFecha(g, e.repartos);
  const lineas: string[] = [];
  if (cambiaDeMes) {
    for (const l of [
      lineaBalance(
        g,
        actual,
        e.nueva,
        e.repartos,
        folio,
        mesVuelo,
        e.matricula,
      ),
      lineaReparto(alcance, mesNuevo, e.matricula),
      libroDineroPorFecha(g)
        ? `En el Libro Dinero pasa a ${etiquetaMes(mesNuevo)}.`
        : null,
    ]) {
      if (l) lineas.push(l);
    }
  }
  // El reparto convierte los pesos SIN tc_gasto con el T.C. oficial del DÍA
  // de fecha_gasto: dentro de un mes TERMINADO también cambia su valor.
  const tcCambia =
    g.moneda === 'MXN' && !(Number(g.tc_gasto) > 0) && alcance !== null;
  if (tcCambia && (cambiaDeMes || terminados.length > 0)) {
    lineas.push(LINEA_TC_REPARTO);
  }
  // Las sueltas de «otros movimientos» en pesos: el bloque VUELATOUR las
  // convierte con el oficial de SU día AUNQUE traigan tc_gasto
  // (`tcDeGastoSuelto`). Nunca coincide con la del reparto (TUAS y el gas
  // sin avión no tienen alcance).
  if (
    g.moneda === 'MXN' &&
    esSueltaOtrosMovimientos(g) &&
    (cambiaDeMes || terminados.length > 0)
  ) {
    lineas.push(LINEA_TC_BALANCE_GENERAL);
  }
  if (lineas.length === 0) {
    return {
      tipo: 'APLICAR',
      fecha_hora_carga: fhc,
      cambia_de_mes: cambiaDeMes,
      aviso: null,
    };
  }
  const aviso = terminados.length > 0 ? lineaMesesTerminados(terminados) : null;
  if (!e.confirmar) {
    const cabeza = cambiaDeMes
      ? `Pasa de ${etiquetaMes(mesActual)} a ${etiquetaMes(mesNuevo)}.`
      : `La fecha cambia dentro de ${etiquetaMes(mesActual)}.`;
    return {
      tipo: 'CONFIRMAR',
      error: {
        status: 409,
        code: CODIGO_CAMBIO_FECHA.CONFIRMAR,
        message: [cabeza, ...lineas, aviso].filter(Boolean).join(' '),
        details: {
          cambia_de_mes: cambiaDeMes,
          mes_antes: mesActual,
          mes_despues: mesNuevo,
          etiqueta_mes_despues: etiquetaMes(mesNuevo),
          meses_terminados: terminados,
        },
      },
    };
  }
  return {
    tipo: 'APLICAR',
    fecha_hora_carga: fhc,
    cambia_de_mes: cambiaDeMes,
    aviso,
  };
}

/**
 * Línea del BALANCE (solo cuando cambia el mes), espejo de
 * `ubicacionBalanceDeGasto`: las sueltas de «otros movimientos» (TUAS sin
 * vuelo y gas sin avión, `esSueltaOtrosMovimientos`) viven en el general por
 * fecha; eje VUELO ⇒ el libro no se mueve (solo regresar al mes del vuelo le
 * quita su pendiente); eje GASTO ⇒ el libro pasa al mes nuevo.
 */
function lineaBalance(
  g: GastoCambioFecha,
  actual: string,
  nueva: string,
  repartos: ReadonlyArray<RepartoDeGasto>,
  folio: number | null,
  mesVuelo: string | null,
  matricula: (aeronaveId: string) => string | null,
): string | null {
  const M = etiquetaMes(nueva.slice(0, 7));
  if (esSueltaOtrosMovimientos(g)) {
    return `En el balance general pasa a ${M}.`;
  }
  const u1 = ubicacionBalanceDeGasto({ ...g, fecha_gasto: nueva }, repartos);
  if (!u1) return null;
  if (u1.eje === 'vuelo') {
    return mesVuelo && nueva.slice(0, 7) === mesVuelo
      ? `Regresa al mes de su vuelo ${folio != null ? `#${folio} ` : ''}(${etiquetaMes(mesVuelo)}): se quita su pendiente «fecha FUERA del periodo del libro».`
      : null;
  }
  const u0 = ubicacionBalanceDeGasto({ ...g, fecha_gasto: actual }, repartos);
  if (u0 && u0.periodo.desde === u1.periodo.desde) return null;
  const lista = listaY(
    u1.aviones.map(matricula).filter((m): m is string => !!m),
  );
  if (u1.aviones.length > 0 && u1.general) {
    return lista
      ? `En el balance general y en el de ${lista} pasa a ${M}.`
      : `En el balance general y en el del avión pasa a ${M}.`;
  }
  if (u1.aviones.length > 0) {
    return lista
      ? `En el balance de ${lista} pasa a ${M}.`
      : `En el balance del avión pasa a ${M}.`;
  }
  return u1.general ? `En el balance general pasa a ${M}.` : null;
}

/** Línea del REPARTO A SOCIOS (solo cuando cambia el mes). */
function lineaReparto(
  alcance: AlcanceRepartoPorFecha | null,
  mesNuevo: string,
  matricula: (aeronaveId: string) => string | null,
): string | null {
  if (!alcance) return null;
  const M = etiquetaMes(mesNuevo);
  if (alcance.tipo === 'FLOTA') return LINEA_REPARTO_FLOTA;
  if (alcance.tipo === 'AVION') {
    const m = matricula(alcance.avion);
    return m
      ? `En el reparto a socios de ${m} pasa a ${M}.`
      : `En el reparto a socios del avión pasa a ${M}.`;
  }
  const lista = listaY(
    alcance.aviones.map(matricula).filter((m): m is string => !!m),
  );
  return lista
    ? `En el reparto a socios pasan a ${M} sus partes (${lista}).`
    : `En el reparto a socios pasan a ${M} sus partes.`;
}

/** «Septiembre 2026 ya terminó: …» / «Agosto 2026 y septiembre 2026 ya terminaron: …». */
function lineaMesesTerminados(terminados: readonly string[]): string {
  const et = terminados.map(etiquetaMes);
  const sujeto =
    et.length === 1
      ? `${mayus(et[0])} ya terminó`
      : `${mayus(et[0])} y ${et[1]} ya terminaron`;
  return `${sujeto}: si ya se entregaron sus libros o su reparto, hay que regenerarlos después de este cambio.`;
}

function textoFueraDelMesDelVuelo(
  folio: number | null,
  diaVuelo: string,
  mesNuevo: string,
  mesVuelo: string,
  mesContable: string = mesVuelo,
): string {
  if (mesContable !== mesVuelo) {
    // Vuelo DIFERIDO al cerrar un mes (invariante 89): cuenta en su mes
    // contable; una fecha de su mes real también se acepta.
    return `No se puede: este gasto es del vuelo ${folio != null ? `#${folio} ` : ''}(${diaTexto(diaVuelo)}), que pasó a ${etiquetaMes(mesContable)} al cerrar ${etiquetaMes(mesVuelo)} (el mes contable del vuelo es ${etiquetaMes(mesContable)}). Con fecha de ${etiquetaMes(mesNuevo)} quedaría fuera de los meses de su vuelo. Déjale una fecha entre ${etiquetaMes(mesVuelo)} y ${etiquetaMes(mesContable)}.`;
  }
  return `No se puede: este gasto es del vuelo ${folio != null ? `#${folio} ` : ''}(${diaTexto(diaVuelo)}). Con fecha de ${etiquetaMes(mesNuevo)} quedaría en otro mes que su vuelo y el balance de ${etiquetaMes(mesVuelo)} lo marcaría como pendiente («fecha FUERA del periodo del libro»). Déjale una fecha de ${etiquetaMes(mesVuelo)}; para vincularlo no hace falta cambiarla.`;
}
