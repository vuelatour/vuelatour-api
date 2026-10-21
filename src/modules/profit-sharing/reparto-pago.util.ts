/**
 * ENTREGAS DE UTILIDADES A SOCIOS — nivel ENTREGA (v2, 2-oct-2026, API
 * 0.0.50, migraciones `20261001000001` + `20261002000001`) — FUENTE ÚNICA
 * PURA (con spec).
 *
 * Desde la v2 una fila de `reparto_pago` es una ENTREGA a la cuenta
 * corriente del socio (transferencia, efectivo, cheque u otro): el saldo
 * del socio (lo POR ENTREGAR) lo arma `reparto-cuenta.util.ts`. Aquí vive
 * solo lo de UNA entrega: dinero (USD/MXN con T.C. de 6 decimales), fecha,
 * forma de la fila, nombres, orden de captura y path del comprobante.
 *
 * Reglas:
 *  - **LA CUENTA ES EN PESOS (20-oct-2026, invariante 99)**: `monto_mxn` =
 *    lo que la entrega descuenta del saldo: MXN = monto; USD = round(monto ×
 *    T.C., 2). TODA entrega lleva T.C. (6 decimales, invariante 20, banda
 *    15–25): en USD para saber sus pesos; en MXN para su dólar informativo.
 *    El T.C. de una entrega en USD NO se persiste en `tc_usd_mxn` (el CHECK
 *    de la tabla lo reserva a MXN): queda implícito en `monto_mxn ÷ monto`.
 *  - `monto_usd` (informativo, la columna de siempre): USD = monto; MXN =
 *    round(monto / T.C., 2).
 *  - `mes` / `aeronave` = «corresponde a» INFORMATIVO (opcional): `mes` null
 *    = ADELANTO A CUENTA.
 *  - Fecha de la entrega: día real y nunca futura (día Cancún).
 */
import { Rol } from '../../common/types/auth.types';
import { redondearA } from '../../common/redondeo.util';
import { normalizarTc } from '../../common/tc.util';

// ===================================================================
// Constantes
// ===================================================================

/** Tabla de las entregas. */
export const TABLA_REPARTO_PAGO = 'reparto_pago';

/** Bucket PRIVADO de los comprobantes (lista blanca de `storage/firmar`). */
export const BUCKET_REPARTO_COMPROBANTES = 'reparto-comprobantes';

export const MONEDAS_PAGO_SOCIO = ['USD', 'MXN'] as const;
export type MonedaPagoSocio = (typeof MONEDAS_PAGO_SOCIO)[number];

export const METODOS_PAGO_SOCIO = [
  'EFECTIVO',
  'TRANSFERENCIA',
  'CHEQUE',
  'OTRO',
] as const;
export type MetodoPagoSocio = (typeof METODOS_PAGO_SOCIO)[number];

export const ETIQUETAS_METODO_PAGO_SOCIO: Readonly<
  Record<MetodoPagoSocio, string>
> = {
  EFECTIVO: 'Efectivo',
  TRANSFERENCIA: 'Transferencia',
  CHEQUE: 'Cheque',
  OTRO: 'Otro',
};

/** Largos de texto (= CHECK de la tabla). */
export const REFERENCIA_PAGO_MAX = 120;
export const RECIBIDO_POR_MAX = 120;
export const FACTURA_FOLIO_PAGO_MAX = 60;
export const NOTAS_PAGO_MAX = 500;
export const MOTIVO_BAJA_PAGO_MIN = 5;
export const MOTIVO_BAJA_PAGO_MAX = 300;
/** Tope de una entrega (cabe holgado en numeric(12,2)). */
export const MONTO_PAGO_MAX = 99_999_999.99;

/**
 * Banda PLAUSIBLE del T.C. de una entrega en pesos (MXN por USD): la MISMA
 * del costo del operador externo (`COSTO_EXTERNO_TC_MIN/MAX`) y de la
 * conciliación USD↔MXN — el spec congela la paridad. Fuera de ella es casi
 * seguro un dedazo (1.8 por 18 multiplica por 10 los dólares que descuenta)
 * y, en los extremos, desbordaría `numeric(12,6)` / `numeric(12,2)` ⇒ 500.
 * 400 `TC_FUERA_DE_RANGO`.
 */
export const TC_PAGO_SOCIO_MIN = 15;
export const TC_PAGO_SOCIO_MAX = 25;

/** `YYYY-MM` con mes 01–12. */
export const MES_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
/** `YYYY-MM-DD` (la validez del día la revisa `esFechaDia`). */
export const FECHA_DIA_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Quién LEE las cuentas y las entregas (SOCIO: solo la suya). La matriz de
 * `storage/firmar` copia esta lista para `reparto-comprobantes`.
 */
export const ROLES_PAGOS_SOCIOS_LECTURA: readonly Rol[] = [
  Rol.ADMIN,
  Rol.ANALISTA,
  Rol.FACTURACION,
  Rol.SOCIO,
];

/** Quién REGISTRA, corrige y da de baja entregas y configura cuentas. */
export const ROLES_PAGOS_SOCIOS_ESCRITURA: readonly Rol[] = [
  Rol.ADMIN,
  Rol.FACTURACION,
];

/** Columnas de la fila (TODA la fila: el panel la recibe tal cual). */
export const COLS_REPARTO_PAGO =
  'id, aeronave_id, socio_id, periodo, monto, moneda, tc_usd_mxn, monto_usd, monto_mxn, utilidad_snapshot_usd, saldo_snapshot_usd, saldo_snapshot_mxn, fecha_pago, metodo, referencia, entregado_por, recibido_por, factura_folio, comprobante_path, notas, client_request_id, created_by, created_at, updated_by, updated_at, deleted_at, deleted_by, motivo_baja';

// ===================================================================
// Textos (es-MX) — el panel copia los que pinta
// ===================================================================

export const MENSAJE_PAGO_NO_EXISTE =
  'Esa entrega no existe o ya se eliminó. Recarga la página.';

export const MENSAJE_SOCIO_INVALIDO =
  'Esa persona no es socio de ningún avión: revisa los socios en la ficha de cada avión.';

export const MENSAJE_SOCIO_NO_ES_DE_LA_AERONAVE =
  'Ese socio no es socio de ese avión: elige uno de sus aviones o deja el avión vacío.';

export const MENSAJE_ENTREGADO_POR_INVALIDO =
  'Quien entregó el dinero debe ser un usuario activo del sistema.';

export const MENSAJE_PAGO_SIN_CAMBIOS =
  'No mandaste ningún cambio para la entrega.';

export const MENSAJE_PAGO_CAMBIO_CONCURRENTE =
  'Otra persona cambió esta entrega en este momento. Recarga la página y vuelve a intentarlo.';

export const MENSAJE_COMPROBANTE_PAGO_CAMBIO =
  'Alguien más cambió el comprobante de esta entrega; recarga la página.';

export const MENSAJE_MES_INVALIDO =
  'El mes debe tener el formato AAAA-MM (por ejemplo 2026-09).';

export const MENSAJE_MES_FUTURO =
  'El mes al que corresponde la entrega no puede ser posterior al mes en curso.';

export const MENSAJE_MOTIVO_BAJA_PAGO = `Escribe por qué se elimina la entrega (entre ${MOTIVO_BAJA_PAGO_MIN} y ${MOTIVO_BAJA_PAGO_MAX} caracteres).`;

export const MENSAJE_CLIENT_REQUEST_ID_EN_USO_PAGO =
  'La llave client_request_id de esta entrega ya se usó en otra entrega (o en una que se eliminó); vuelve a abrir el diálogo para registrarla.';

/** 410: el listado por mes de la v1 se retiró. */
export const MENSAJE_PAGOS_POR_MES_RETIRADO =
  'El listado de pagos por mes se retiró: ahora cada socio tiene su cuenta corriente. Usa ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD o el estado de cuenta del socio (actualiza la página).';

/**
 * `motivo_baja` de la entrega que PERDIÓ una carrera contra otra entrega
 * del mismo socio (las dos pasaron el candado del saldo a la vez y juntas
 * lo rebasan). El API la da de baja, libera su llave y responde 409
 * `PAGO_EXCEDE_SALDO` para que el operador confirme el ADELANTO (≤ 300).
 */
export const MOTIVO_BAJA_CARRERA_ALTA =
  'Baja automática: otra entrega al mismo socio se registró al mismo tiempo y juntas rebasan lo que había por entregar. Se le pidió al operador confirmar el adelanto.';

const MESES = [
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
] as const;

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

/** «2026-09» ⇒ «septiembre 2026» (el mes tal cual si no es válido). */
export function etiquetaMes(mes: string): string {
  if (!esMes(mes)) return mes;
  const [a, m] = mes.split('-');
  return `${MESES[Number(m) - 1]} ${a}`;
}

/** «2026-09» ⇒ «sep 2026» (conceptos del estado de cuenta). */
export function etiquetaMesCorta(mes: string): string {
  if (!esMes(mes)) return mes;
  const [a, m] = mes.split('-');
  return `${MESES_CORTOS[Number(m) - 1]} ${a}`;
}

// ===================================================================
// Meses y fechas
// ===================================================================

/** ¿`YYYY-MM` válido? */
export function esMes(mes: unknown): mes is string {
  return typeof mes === 'string' && MES_REGEX.test(mes);
}

/** ¿`YYYY-MM-DD` que existe en el calendario? */
export function esFechaDia(s: unknown): s is string {
  if (typeof s !== 'string' || !FECHA_DIA_REGEX.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  return (
    f.getUTCFullYear() === a &&
    f.getUTCMonth() === m - 1 &&
    f.getUTCDate() === d
  );
}

/** Días del mes (`m` 1–12). */
function diasDelMes(a: number, m: number): number {
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

/**
 * `{desde, hasta}` del mes calendario (`2026-09` ⇒ 2026-09-01 / 2026-09-30).
 * Lanza con un mes inválido (el DTO ya lo filtró: aquí es un error de
 * programación, no del operador).
 */
export function rangoDeMes(mes: string): { desde: string; hasta: string } {
  if (!esMes(mes)) throw new Error(`Mes inválido: ${String(mes)}`);
  const [a, m] = mes.split('-').map(Number);
  const dd = String(diasDelMes(a, m)).padStart(2, '0');
  return { desde: `${mes}-01`, hasta: `${mes}-${dd}` };
}

/**
 * `YYYY-MM` si el periodo es EXACTAMENTE un mes calendario (desde = día 1,
 * hasta = último día del MISMO mes); si no, `null` (rango parcial, varios
 * meses o fechas inválidas). Lo usa el pre-cierre.
 */
export function mesDePeriodo(desde: string, hasta: string): string | null {
  if (!esFechaDia(desde) || !esFechaDia(hasta)) return null;
  if (!desde.endsWith('-01')) return null;
  const mes = desde.slice(0, 7);
  if (!esMes(mes)) return null;
  return rangoDeMes(mes).hasta === hasta ? mes : null;
}

/** `2026-09` ⇒ `2026-09-01` (la columna `periodo`). */
export function periodoDeMes(mes: string): string {
  return rangoDeMes(mes).desde;
}

/** `2026-09-01` ⇒ `2026-09`; null ⇒ null. */
export function mesDeFechaPeriodo(
  periodo: string | null | undefined,
): string | null {
  if (periodo == null || periodo === '') return null;
  const mes = String(periodo).slice(0, 7);
  return esMes(mes) ? mes : null;
}

/**
 * Mes (`YYYY-MM`) al que se ACREDITA una entrega: su «corresponde a»
 * (`periodo`) o, sin él, el mes de su `fecha_pago`. Regla ÚNICA de la
 * pantalla por avión del reparto (`ProfitSharingService.mesDeEntrega`) y del
 * balance por avión / general (21-oct-2026, invariante 100).
 */
export function mesAcreditadoDeEntrega(
  r: Pick<RepartoPagoRow, 'periodo' | 'fecha_pago'>,
): string {
  return mesDeFechaPeriodo(r.periodo) ?? String(r.fecha_pago).slice(0, 7);
}

// ===================================================================
// Dinero
// ===================================================================

function round2(n: number): number {
  return redondearA(n, 2);
}

/** Decimales escritos de un número (para el tope de 2 en el monto). */
function decimalesDe(n: number): number {
  const s = String(n);
  if (s.includes('e') || s.includes('E')) return 99;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Lo que una entrega descuenta del saldo, en USD: USD = monto; MXN =
 * round(monto / T.C., 2) con el T.C. normalizado a 6 decimales (invariante
 * 20). `null` si el monto no es positivo o un MXN no trae T.C. válido.
 */
export function montoUsdDePago(
  monto: unknown,
  moneda: unknown,
  tc: unknown,
): number | null {
  const m = Number(monto);
  if (monto == null || monto === '' || !Number.isFinite(m) || m <= 0) {
    return null;
  }
  if (moneda === 'USD') return round2(m);
  if (moneda !== 'MXN') return null;
  const t = normalizarTc(tc);
  if (t == null) return null;
  return round2(m / t);
}

/**
 * Lo que una entrega descuenta del saldo EN PESOS (20-oct-2026, invariante
 * 99): MXN = monto; USD = round(monto × T.C., 2) con el T.C. normalizado a
 * 6 decimales. `null` si el monto no es positivo o un USD no trae T.C.
 */
export function montoMxnDePago(
  monto: unknown,
  moneda: unknown,
  tc: unknown,
): number | null {
  const m = Number(monto);
  if (monto == null || monto === '' || !Number.isFinite(m) || m <= 0) {
    return null;
  }
  if (moneda === 'MXN') return round2(m);
  if (moneda !== 'USD') return null;
  const t = normalizarTc(tc);
  if (t == null) return null;
  return round2(m * t);
}

export type CodigoErrorPago =
  | 'MONTO_INVALIDO'
  | 'MONEDA_INVALIDA'
  | 'TC_REQUERIDO'
  | 'TC_FUERA_DE_RANGO'
  | 'FECHA_PAGO_INVALIDA'
  | 'FECHA_PAGO_FUTURA';

/**
 * T.C. de una entrega TAL CUAL se registró (invariante 99): en MXN la
 * columna; en USD el CHECK `reparto_pago_tc_moneda_chk` la deja null y el
 * T.C. queda IMPLÍCITO en los pesos que descuenta: `monto_mxn ÷ monto`.
 * Sin pesos (fila anterior a la migración 20261020000006) ⇒ null.
 */
export function tcDePago(
  r: Pick<RepartoPagoRow, 'monto' | 'moneda' | 'tc_usd_mxn' | 'monto_mxn'>,
): number | null {
  const propio = normalizarTc(r.tc_usd_mxn);
  if (propio != null) return propio;
  if (r.moneda !== 'USD') return null;
  const monto = num(r.monto);
  const mxn =
    r.monto_mxn == null || r.monto_mxn === '' ? null : num(r.monto_mxn);
  if (mxn == null || !(monto > 0) || !(mxn > 0)) return null;
  return normalizarTc(mxn / monto);
}

/**
 * El dinero de una fila SIN re-validarlo: para una corrección que no toca
 * monto / moneda / T.C. (notas, «corresponde a», comprobante…). Re-validar
 * una entrega en USD rebotaba con TC_REQUERIDO (su T.C. no se persiste).
 */
export function dineroDePago(
  r: RepartoPagoRow,
): Extract<ResultadoDineroPago, { ok: true }> {
  const p = aPagoSocio(r);
  return {
    ok: true,
    monto: p.monto,
    moneda: p.moneda,
    tc_usd_mxn: p.tc_usd_mxn,
    tc_aplicado: tcDePago(r) ?? 0,
    monto_usd: p.monto_usd,
    monto_mxn: p.monto_mxn,
  };
}

export type ResultadoDineroPago =
  | {
      ok: true;
      monto: number;
      moneda: MonedaPagoSocio;
      /** Lo que se PERSISTE en `tc_usd_mxn`: solo en MXN (CHECK de la tabla). */
      tc_usd_mxn: number | null;
      /** El T.C. con que se convirtió (las dos monedas). */
      tc_aplicado: number;
      monto_usd: number;
      /** Lo que descuenta del saldo EN PESOS (invariante 99). */
      monto_mxn: number;
    }
  | { ok: false; codigo: CodigoErrorPago; mensaje: string };

/**
 * Valida y normaliza el DINERO de una entrega (alta, o el estado FUSIONADO
 * de un PATCH): monto > 0 con ≤ 2 decimales; moneda USD/MXN; LAS DOS
 * monedas exigen T.C. (6 decimales, banda 15–25) — en USD para saber los
 * pesos que descuenta (la cuenta es en pesos, invariante 99); en MXN para su
 * dólar informativo —; ni los pesos ni los dólares pueden salir en $0.
 */
export function validarDineroPago(d: {
  monto: unknown;
  moneda: unknown;
  tc_usd_mxn?: unknown;
}): ResultadoDineroPago {
  const monto = Number(d.monto);
  if (
    d.monto == null ||
    d.monto === '' ||
    !Number.isFinite(monto) ||
    monto <= 0 ||
    monto > MONTO_PAGO_MAX ||
    decimalesDe(monto) > 2
  ) {
    return {
      ok: false,
      codigo: 'MONTO_INVALIDO',
      mensaje:
        'El monto de la entrega debe ser mayor a $0 y con máximo 2 decimales.',
    };
  }
  if (d.moneda !== 'USD' && d.moneda !== 'MXN') {
    return {
      ok: false,
      codigo: 'MONEDA_INVALIDA',
      mensaje: 'La moneda de la entrega debe ser USD o MXN.',
    };
  }
  const tc = normalizarTc(d.tc_usd_mxn);
  if (tc == null) {
    return {
      ok: false,
      codigo: 'TC_REQUERIDO',
      mensaje:
        d.moneda === 'USD'
          ? 'Una entrega en dólares necesita el tipo de cambio para saber cuántos pesos descuenta de la cuenta del socio.'
          : 'Una entrega en pesos necesita el tipo de cambio del día (para su equivalente informativo en dólares).',
    };
  }
  if (tc < TC_PAGO_SOCIO_MIN || tc > TC_PAGO_SOCIO_MAX) {
    return {
      ok: false,
      codigo: 'TC_FUERA_DE_RANGO',
      mensaje: `El tipo de cambio ${tc} está fuera del rango razonable (${TC_PAGO_SOCIO_MIN} a ${TC_PAGO_SOCIO_MAX} pesos por dólar): revisa la captura.`,
    };
  }
  const montoUsd = montoUsdDePago(monto, d.moneda, tc);
  const montoMxn = montoMxnDePago(monto, d.moneda, tc);
  if (
    montoUsd == null ||
    montoUsd < 0.01 ||
    montoMxn == null ||
    montoMxn < 0.01
  ) {
    return {
      ok: false,
      codigo: 'MONTO_INVALIDO',
      mensaje:
        'Con ese tipo de cambio la entrega sale en $0: revisa el monto y el tipo de cambio.',
    };
  }
  return {
    ok: true,
    monto: round2(monto),
    moneda: d.moneda,
    // El CHECK `reparto_pago_tc_moneda_chk` reserva la columna a MXN: el
    // T.C. de una entrega en USD queda implícito en monto_mxn ÷ monto.
    tc_usd_mxn: d.moneda === 'MXN' ? tc : null,
    tc_aplicado: tc,
    monto_usd: montoUsd,
    monto_mxn: montoMxn,
  };
}

/** Fecha de la entrega: día real y nunca después de hoy (día Cancún). */
export function validarFechaPago(
  fecha: unknown,
  hoy: string,
):
  | { ok: true; fecha: string }
  | { ok: false; codigo: CodigoErrorPago; mensaje: string } {
  if (!esFechaDia(fecha)) {
    return {
      ok: false,
      codigo: 'FECHA_PAGO_INVALIDA',
      mensaje: 'La fecha de la entrega debe ser un día válido (AAAA-MM-DD).',
    };
  }
  if (fecha > hoy) {
    return {
      ok: false,
      codigo: 'FECHA_PAGO_FUTURA',
      mensaje:
        'La fecha de la entrega no puede ser posterior a hoy: regístrala cuando se entregue.',
    };
  }
  return { ok: true, fecha };
}

/** Texto opcional recortado: '' ⇒ null. */
export function textoOpcional(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

// ===================================================================
// Fila y entrega
// ===================================================================

/** Fila cruda de `reparto_pago` (numeric puede llegar como texto). */
export interface RepartoPagoRow {
  id: string;
  aeronave_id: string | null;
  socio_id: string;
  periodo: string | null;
  monto: number | string;
  moneda: string;
  tc_usd_mxn: number | string | null;
  monto_usd: number | string;
  /**
   * EN PESOS (20-oct-2026, invariante 99, migración `20261020000006`): lo
   * que descuenta del saldo. Opcional solo para los specs con filas viejas
   * (sin ella, un MXN toma `monto`).
   */
  monto_mxn?: number | string | null;
  utilidad_snapshot_usd: number | string | null;
  saldo_snapshot_usd: number | string | null;
  saldo_snapshot_mxn?: number | string | null;
  fecha_pago: string;
  metodo: string;
  referencia: string | null;
  entregado_por: string;
  recibido_por: string | null;
  factura_folio: string | null;
  comprobante_path: string | null;
  notas: string | null;
  client_request_id: string | null;
  created_by: string | null;
  created_at: string;
  /** Quién la corrigió por última vez (migración 20261002000001). */
  updated_by?: string | null;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  motivo_baja: string | null;
}

/** Avión de referencia («corresponde a»). */
export interface AeronaveCorta {
  id: string;
  matricula: string;
}

/** Entrega como la ve el panel: la fila + nombres + avión + URL firmada (8 h). */
export interface PagoSocio {
  id: string;
  socio_id: string;
  aeronave_id: string | null;
  /** «Corresponde a» este avión (null = de toda su cuenta). */
  aeronave: AeronaveCorta | null;
  periodo: string | null;
  /** «Corresponde a» este mes (null = ADELANTO A CUENTA). */
  mes: string | null;
  monto: number;
  moneda: MonedaPagoSocio;
  tc_usd_mxn: number | null;
  /** Dólares informativos (USD = monto; MXN = monto ÷ T.C.). */
  monto_usd: number;
  /**
   * LO QUE DESCUENTA DEL SALDO, EN PESOS (20-oct-2026, invariante 99): MXN
   * = monto; USD = monto × T.C. de la entrega.
   */
  monto_mxn: number;
  /** Legado de la v1 (null en las entregas de la v2). */
  utilidad_snapshot_usd: number | null;
  /**
   * Lo por entregar de MESES CERRADOS (sin el mes en curso) ANTES de esta
   * entrega, al registrarla o al corregir su dinero: el número contra el
   * que se decidió si era adelanto. Desde el 0.0.101 en pesos
   * (`saldo_snapshot_mxn`); el `_usd` es el de las entregas previas.
   */
  saldo_snapshot_usd: number | null;
  saldo_snapshot_mxn: number | null;
  fecha_pago: string;
  metodo: MetodoPagoSocio;
  referencia: string | null;
  entregado_por: string;
  recibido_por: string | null;
  factura_folio: string | null;
  comprobante_path: string | null;
  notas: string | null;
  client_request_id: string | null;
  created_by: string | null;
  created_at: string;
  /** ADITIVO: quién la corrigió por última vez (null = nadie). */
  updated_by: string | null;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  motivo_baja: string | null;
  entregado_por_nombre: string | null;
  created_by_nombre: string | null;
  /** ADITIVO: nombre de quien la corrigió por última vez. */
  updated_by_nombre: string | null;
  comprobante_url: string | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const numONull = (v: unknown): number | null =>
  v == null || v === '' ? null : num(v);

/**
 * Fila ⇒ `PagoSocio` (nombres, matrícula y URL resueltos aparte; nunca un
 * uuid como nombre). Matrícula desconocida ⇒ '' (el avión existe: FK).
 */
export function aPagoSocio(
  r: RepartoPagoRow,
  nombres: ReadonlyMap<string, string> = new Map(),
  urls: ReadonlyMap<string, string> = new Map(),
  matriculas: ReadonlyMap<string, string> = new Map(),
): PagoSocio {
  const tc = r.tc_usd_mxn == null ? null : num(r.tc_usd_mxn);
  return {
    id: r.id,
    socio_id: r.socio_id,
    aeronave_id: r.aeronave_id ?? null,
    aeronave: r.aeronave_id
      ? { id: r.aeronave_id, matricula: matriculas.get(r.aeronave_id) ?? '' }
      : null,
    periodo: r.periodo ?? null,
    mes: mesDeFechaPeriodo(r.periodo),
    monto: num(r.monto),
    moneda: r.moneda === 'MXN' ? 'MXN' : 'USD',
    tc_usd_mxn: tc,
    monto_usd: num(r.monto_usd),
    // EN PESOS (invariante 99): la columna; sin ella (fila vieja de un
    // spec) un MXN es su monto y un USD × su T.C. si lo trae.
    monto_mxn:
      r.monto_mxn != null && r.monto_mxn !== ''
        ? num(r.monto_mxn)
        : r.moneda === 'MXN'
          ? num(r.monto)
          : tc != null
            ? round2(num(r.monto) * tc)
            : 0,
    utilidad_snapshot_usd: numONull(r.utilidad_snapshot_usd),
    saldo_snapshot_usd: numONull(r.saldo_snapshot_usd),
    saldo_snapshot_mxn: numONull(r.saldo_snapshot_mxn),
    fecha_pago: r.fecha_pago,
    metodo: (METODOS_PAGO_SOCIO as readonly string[]).includes(r.metodo)
      ? (r.metodo as MetodoPagoSocio)
      : 'OTRO',
    referencia: r.referencia ?? null,
    entregado_por: r.entregado_por,
    recibido_por: r.recibido_por ?? null,
    factura_folio: r.factura_folio ?? null,
    comprobante_path: r.comprobante_path ?? null,
    notas: r.notas ?? null,
    client_request_id: r.client_request_id ?? null,
    created_by: r.created_by ?? null,
    created_at: r.created_at,
    updated_by: r.updated_by ?? null,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at ?? null,
    deleted_by: r.deleted_by ?? null,
    motivo_baja: r.motivo_baja ?? null,
    entregado_por_nombre: nombres.get(r.entregado_por) ?? null,
    created_by_nombre: r.created_by
      ? (nombres.get(r.created_by) ?? null)
      : null,
    updated_by_nombre: r.updated_by
      ? (nombres.get(r.updated_by) ?? null)
      : null,
    comprobante_url: r.comprobante_path
      ? (urls.get(r.comprobante_path) ?? null)
      : null,
  };
}

/**
 * Instante de un `timestamptz` en MICROsegundos (Postgres guarda µs y
 * `Date.parse` trunca a ms: dos altas en el mismo milisegundo se verían
 * empatadas). NaN si no se puede leer.
 */
export function microsDeInstante(ts: string): number {
  const s = typeof ts === 'string' ? ts : '';
  const frac = /^[^.]*T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(s);
  const base = Date.parse(frac ? s.replace(`.${frac[1]}`, '') : s);
  if (!Number.isFinite(base)) return Number.NaN;
  const micros = frac ? Number(`${frac[1]}000000`.slice(0, 6)) : 0;
  return base * 1000 + micros;
}

/**
 * Orden de CAPTURA (cuándo se registró la entrega: `created_at`, luego id).
 * Decide, de forma determinista para las dos peticiones, cuál de dos altas
 * simultáneas es la que sobra; también desempata entregas del mismo día.
 */
export function compararCaptura(
  a: Pick<PagoSocio, 'created_at' | 'id'>,
  b: Pick<PagoSocio, 'created_at' | 'id'>,
): number {
  const ta = microsDeInstante(a.created_at);
  const tb = microsDeInstante(b.created_at);
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    if (ta !== tb) return ta < tb ? -1 : 1;
  } else {
    const s = String(a.created_at).localeCompare(String(b.created_at));
    if (s !== 0) return s;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ===================================================================
// Comprobante
// ===================================================================

/**
 * Llave del comprobante dentro de `reparto-comprobantes`:
 * `<socio>/<entrega>/<uuid>.<ext>` (v2: la entrega ya no siempre tiene
 * avión ni mes). Un uuid por subida: reemplazar NO pisa el archivo anterior
 * (se conserva en el bucket, como las facturas emitidas).
 */
export function pathComprobantePago(
  socioId: string,
  pagoId: string,
  id: string,
  extension: string,
): string {
  return `${socioId}/${pagoId}/${id}.${extension}`;
}
