/**
 * PAGOS DE UTILIDADES A SOCIOS (1-oct-2026, API 0.0.49, migración
 * `20261001000001`) — FUENTE ÚNICA PURA (con spec).
 *
 * Pedido del cliente (captura de /admin/profit-sharing): «cada socio debe
 * recibir los pagos de lo que generó el avión en el mes, por ejemplo
 * septiembre que acaba de cerrar […] un apartado donde siga algo como:
 * Mauricio Roque, %, Monto de utilidad, estatus de si ya se pagó o aún no,
 * con cuánto se le pagó, cuándo y quién se lo entregó, para llevar una
 * relación de esos pagos y no se nos escape ninguno».
 *
 * Reglas (todas aquí; el servicio solo hace I/O):
 *  - La UTILIDAD del socio NO se guarda: sale de `ProfitSharingService.compute`
 *    del MES (`reparto[].monto_usd`, residuo mayor en centavos). Aquí solo se
 *    LEE; jamás un segundo cálculo del reparto.
 *  - Lo PAGADO = Σ `monto_usd` de los pagos VIVOS (`deleted_at is null`) de
 *    ese avión, socio y mes. USD = monto; MXN = round(monto / T.C., 2).
 *  - Estado por (avión, socio): utilidad ≤ 0 ⇒ SIN_UTILIDAD; pagado ≥
 *    utilidad − $1.00 ⇒ PAGADO (tolerancia de los cobros); pagado > 0 ⇒
 *    PARCIAL; si no, PENDIENTE. Aritmética en CENTAVOS.
 *  - Un pago por MES CALENDARIO: `mesDePeriodo` solo reconoce un rango que
 *    va del día 1 al último día del mismo mes.
 */
import { Rol } from '../../common/types/auth.types';
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import { redondearA } from '../../common/redondeo.util';
import { normalizarTc } from '../../common/tc.util';

// ===================================================================
// Constantes
// ===================================================================

/** Migración que crea `reparto_pago` y el bucket de comprobantes. */
export const MIGRACION_REPARTO_PAGO = '20261001000001';

/** Tabla de la relación de pagos. */
export const TABLA_REPARTO_PAGO = 'reparto_pago';

/** Bucket PRIVADO de los comprobantes (lista blanca de `storage/firmar`). */
export const BUCKET_REPARTO_COMPROBANTES = 'reparto-comprobantes';

/** Tolerancia de redondeo, la MISMA de los cobros (`refreshCobradoFlag`). */
export const TOLERANCIA_PAGO_SOCIO_USD = 1;
const TOLERANCIA_CENTAVOS = TOLERANCIA_PAGO_SOCIO_USD * 100;

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

export const ESTADOS_PAGO_SOCIO = [
  'PENDIENTE',
  'PARCIAL',
  'PAGADO',
  'SIN_UTILIDAD',
] as const;
export type EstadoPagoSocio = (typeof ESTADOS_PAGO_SOCIO)[number];

export const ETIQUETAS_ESTADO_PAGO_SOCIO: Readonly<
  Record<EstadoPagoSocio, string>
> = {
  PENDIENTE: 'Pendiente',
  PARCIAL: 'Pago parcial',
  PAGADO: 'Pagado',
  SIN_UTILIDAD: 'Sin utilidad',
};

/** Estados que todavía piden un pago (pre-cierre y conteo). */
export function estadoPidePago(e: EstadoPagoSocio): boolean {
  return e === 'PENDIENTE' || e === 'PARCIAL';
}

/** Largos de texto (= CHECK de la tabla). */
export const REFERENCIA_PAGO_MAX = 120;
export const RECIBIDO_POR_MAX = 120;
export const FACTURA_FOLIO_PAGO_MAX = 60;
export const NOTAS_PAGO_MAX = 500;
export const MOTIVO_BAJA_PAGO_MIN = 5;
export const MOTIVO_BAJA_PAGO_MAX = 300;
/** Tope de un pago (cabe holgado en numeric(12,2)). */
export const MONTO_PAGO_MAX = 99_999_999.99;

/**
 * Banda PLAUSIBLE del T.C. de un pago en pesos (MXN por USD): la MISMA del
 * costo del operador externo (`COSTO_EXTERNO_TC_MIN/MAX`) y de la
 * conciliación USD↔MXN — el spec congela la paridad. Fuera de ella es casi
 * seguro un dedazo (1.8 por 18 multiplica por 10 los dólares que cubre el
 * pago; 180 los divide y el renglón queda PARCIAL en silencio) y, en los
 * extremos, desbordaría `numeric(12,6)` / `numeric(12,2)` ⇒ 500 (revisión
 * adversaria 1-oct-2026). 400 `TC_FUERA_DE_RANGO`.
 */
export const TC_PAGO_SOCIO_MIN = 15;
export const TC_PAGO_SOCIO_MAX = 25;

/** `YYYY-MM` con mes 01–12. */
export const MES_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
/** `YYYY-MM-DD` (la validez del día la revisa `esFechaDia`). */
export const FECHA_DIA_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Quién LEE la relación de pagos (SOCIO: solo sus renglones). */
export const ROLES_PAGOS_SOCIOS_LECTURA: readonly Rol[] = [
  Rol.ADMIN,
  Rol.ANALISTA,
  Rol.FACTURACION,
  Rol.SOCIO,
];

/** Quién REGISTRA, corrige y da de baja pagos. */
export const ROLES_PAGOS_SOCIOS_ESCRITURA: readonly Rol[] = [
  Rol.ADMIN,
  Rol.FACTURACION,
];

/** Columnas de la fila (TODA la fila: el panel la recibe tal cual). */
export const COLS_REPARTO_PAGO =
  'id, aeronave_id, socio_id, periodo, monto, moneda, tc_usd_mxn, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, referencia, entregado_por, recibido_por, factura_folio, comprobante_path, notas, client_request_id, created_by, created_at, updated_at, deleted_at, deleted_by, motivo_baja';

/** Pre-cierre: clave, título y tope de la lista. */
export const CLAVE_PRECIERRE_PAGOS_SOCIOS = 'pagos_socios_pendientes';
export const TITULO_PRECIERRE_PAGOS_SOCIOS =
  'Socios con utilidad del mes sin pagar o con pago parcial';
export const PRECIERRE_PAGOS_SOCIOS_MAX = 50;

/**
 * Pre-cierre: pagos POR ENCIMA de la utilidad (revisión adversaria
 * 1-oct-2026). Item APARTE —y no solo un conteo dentro del de pendientes—
 * porque el panel oculta todo item con `count` 0: un sobrepago con todos
 * los socios pagados se habría escapado del cierre.
 */
export const CLAVE_PRECIERRE_SOBREPAGOS_SOCIOS = 'pagos_socios_sobrepagados';
export const TITULO_PRECIERRE_SOBREPAGOS_SOCIOS =
  'Pagos a socios por encima de la utilidad del mes';

// ===================================================================
// Textos (es-MX) — el panel copia los que pinta
// ===================================================================

/** Línea tenue del panel cuando el periodo no es un mes completo. */
export const TEXTO_SOLO_MES_COMPLETO =
  'Los pagos a socios se registran por mes completo: elige un mes en el selector.';

export const MENSAJE_PAGOS_NO_DISPONIBLE =
  'El registro de pagos a socios todavía no está habilitado en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.';

export const MENSAJE_PAGO_NO_EXISTE =
  'Ese pago no existe o ya se eliminó. Recarga la página.';

export const MENSAJE_SOCIO_NO_ES_DE_LA_AERONAVE =
  'Ese socio no está en el reparto de ese avión para el mes elegido: revisa los socios del avión y sus fechas de vigencia.';

export const MENSAJE_ENTREGADO_POR_INVALIDO =
  'Quien entregó el pago debe ser un usuario activo del sistema.';

export const MENSAJE_PAGO_SIN_CAMBIOS =
  'No mandaste ningún cambio para el pago.';

export const MENSAJE_PAGO_CAMBIO_CONCURRENTE =
  'Otra persona cambió este pago en este momento. Recarga la página y vuelve a intentarlo.';

export const MENSAJE_COMPROBANTE_PAGO_CAMBIO =
  'Alguien más cambió el comprobante de este pago; recarga la página.';

export const MENSAJE_MES_INVALIDO =
  'El mes debe tener el formato AAAA-MM (por ejemplo 2026-09).';

export const MENSAJE_MOTIVO_BAJA_PAGO = `Escribe por qué se elimina el pago (entre ${MOTIVO_BAJA_PAGO_MIN} y ${MOTIVO_BAJA_PAGO_MAX} caracteres).`;

export const MENSAJE_CLIENT_REQUEST_ID_EN_USO_PAGO =
  'La llave client_request_id de este pago ya se usó en otro pago (o en uno que se eliminó); vuelve a abrir el diálogo para registrar el pago.';

/** Aviso del renglón de un socio que YA no está en el reparto del mes. */
export const AVISO_SOCIO_NO_VIGENTE =
  'Este socio ya no está en el reparto de este avión para el mes, pero tiene pagos registrados: revisa que el pago se haya capturado en el avión correcto.';

/**
 * `motivo_baja` del alta que PERDIÓ una carrera contra otra alta del mismo
 * renglón (las dos pasaron el candado del exceso a la vez y juntas rebasan
 * la utilidad). El API la da de baja, libera su llave y responde 409
 * `PAGO_EXCEDE_UTILIDAD` para que el operador confirme (≤ 300).
 */
export const MOTIVO_BAJA_CARRERA_ALTA =
  'Baja automática: otro pago del mismo socio, avión y mes se registró al mismo tiempo y juntos rebasan la utilidad. Se le pidió al operador confirmar el pago de más.';

/** Pre-cierre sin la migración / con la lectura caída. */
export const DETALLE_PRECIERRE_PAGOS_NO_DISPONIBLE =
  'El registro de pagos a socios todavía no está habilitado en la base de datos: los pagos del mes no se pueden revisar aquí.';
export const DETALLE_PRECIERRE_PAGOS_LECTURA_FALLIDA =
  'No se pudieron leer los pagos a socios del mes: revísalos en Reparto de utilidades → «Pagos a socios».';

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

/** «2026-09» ⇒ «septiembre 2026» (el mes tal cual si no es válido). */
export function etiquetaMes(mes: string): string {
  if (!esMes(mes)) return mes;
  const [a, m] = mes.split('-');
  return `${MESES[Number(m) - 1]} ${a}`;
}

const usd = (n: number) => fmtDineroTexto(n, 'USD');

/** 409 `PAGO_EXCEDE_UTILIDAD`: se confirma y se reintenta con `aceptar_exceso`. */
export function mensajeExcedeUtilidad(d: {
  utilidad_usd: number;
  pagado_usd: number;
  monto_usd: number;
  exceso_usd: number;
}): string {
  return `Con este pago el socio recibiría ${usd(d.pagado_usd + d.monto_usd)} de una utilidad del mes de ${usd(d.utilidad_usd)}: ${usd(d.exceso_usd)} de más. ¿Registrar de todas formas?`;
}

/** 409 `SIN_UTILIDAD_QUE_PAGAR` (no se confirma: no se paga lo que no hay). */
export function mensajeSinUtilidad(mes: string, avionActivo: boolean): string {
  return avionActivo
    ? `Este socio no tiene utilidad que pagar en ${etiquetaMes(mes)}: la utilidad del avión en el mes es $0 o negativa (solo se reparte lo cobrado).`
    : `El avión está dado de baja: el reparto no calcula su utilidad de ${etiquetaMes(mes)}, así que no hay nada que pagar desde aquí.`;
}

/**
 * Aviso del renglón con pagos de un avión que el reparto ya NO calcula
 * (dado de baja). No es un error de captura: el socio puede seguir vigente
 * en `aeronave_socio` (revisión adversaria 1-oct-2026; antes decía «revisa
 * que el pago se haya capturado en el avión correcto»).
 */
export function avisoAvionDadoDeBaja(mes: string): string {
  return `${mensajeSinUtilidad(mes, false)} Los pagos que ya se registraron se conservan en esta relación.`;
}

/** Aviso de la fila cuando la utilidad cambió desde el último pago. */
export function avisoUtilidadCambio(
  antesUsd: number,
  ahoraUsd: number,
): string {
  return `La utilidad del mes cambió desde el último pago: era ${usd(antesUsd)} y hoy es ${usd(ahoraUsd)}. Revisa si hay que ajustar el pago.`;
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
 * meses o fechas inválidas).
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

/** `2026-09-01` ⇒ `2026-09`. */
export function mesDeFechaPeriodo(periodo: string): string {
  return String(periodo).slice(0, 7);
}

// ===================================================================
// Dinero
// ===================================================================

function round2(n: number): number {
  return redondearA(n, 2);
}

function centavos(n: number): number {
  return Math.round(round2(n) * 100);
}

/** Decimales escritos de un número (para el tope de 2 en el monto). */
function decimalesDe(n: number): number {
  const s = String(n);
  if (s.includes('e') || s.includes('E')) return 99;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Lo que un pago descuenta de la utilidad, en USD: USD = monto; MXN =
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

export type CodigoErrorPago =
  | 'MONTO_INVALIDO'
  | 'MONEDA_INVALIDA'
  | 'TC_REQUERIDO'
  | 'TC_NO_APLICA'
  | 'TC_FUERA_DE_RANGO'
  | 'FECHA_PAGO_INVALIDA'
  | 'FECHA_PAGO_FUTURA'
  | 'METODO_INVALIDO';

export type ResultadoDineroPago =
  | {
      ok: true;
      monto: number;
      moneda: MonedaPagoSocio;
      tc_usd_mxn: number | null;
      monto_usd: number;
    }
  | { ok: false; codigo: CodigoErrorPago; mensaje: string };

/**
 * Valida y normaliza el DINERO de un pago (alta, o el estado FUSIONADO de un
 * PATCH): monto > 0 con ≤ 2 decimales; moneda USD/MXN; MXN exige T.C. (6
 * decimales) y USD no lo lleva; el monto en dólares no puede salir en $0.
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
        'El monto del pago debe ser mayor a $0 y con máximo 2 decimales.',
    };
  }
  if (d.moneda !== 'USD' && d.moneda !== 'MXN') {
    return {
      ok: false,
      codigo: 'MONEDA_INVALIDA',
      mensaje: 'La moneda del pago debe ser USD o MXN.',
    };
  }
  const tc = normalizarTc(d.tc_usd_mxn);
  if (d.moneda === 'USD' && tc != null) {
    return {
      ok: false,
      codigo: 'TC_NO_APLICA',
      mensaje:
        'Un pago en dólares no lleva tipo de cambio: quítalo o cambia la moneda a pesos.',
    };
  }
  if (d.moneda === 'MXN' && tc == null) {
    return {
      ok: false,
      codigo: 'TC_REQUERIDO',
      mensaje:
        'Un pago en pesos necesita el tipo de cambio para saber cuántos dólares de la utilidad cubre.',
    };
  }
  if (
    d.moneda === 'MXN' &&
    tc != null &&
    (tc < TC_PAGO_SOCIO_MIN || tc > TC_PAGO_SOCIO_MAX)
  ) {
    return {
      ok: false,
      codigo: 'TC_FUERA_DE_RANGO',
      mensaje: `El tipo de cambio ${tc} está fuera del rango razonable (${TC_PAGO_SOCIO_MIN} a ${TC_PAGO_SOCIO_MAX} pesos por dólar): revisa la captura.`,
    };
  }
  const montoUsd = montoUsdDePago(monto, d.moneda, tc);
  if (montoUsd == null || montoUsd < 0.01) {
    return {
      ok: false,
      codigo: 'MONTO_INVALIDO',
      mensaje:
        'Con ese tipo de cambio el pago sale en $0 dólares: revisa el monto y el tipo de cambio.',
    };
  }
  return {
    ok: true,
    monto: round2(monto),
    moneda: d.moneda,
    tc_usd_mxn: d.moneda === 'MXN' ? tc : null,
    monto_usd: montoUsd,
  };
}

/** Fecha del pago: día real y nunca después de hoy (día Cancún). */
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
      mensaje: 'La fecha del pago debe ser un día válido (AAAA-MM-DD).',
    };
  }
  if (fecha > hoy) {
    return {
      ok: false,
      codigo: 'FECHA_PAGO_FUTURA',
      mensaje:
        'La fecha del pago no puede ser posterior a hoy: registra el pago cuando se entregue.',
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
// Estado del pago de un socio
// ===================================================================

export interface EstadoPago {
  estado: EstadoPagoSocio;
  /** Lo que falta por pagar (0 en PAGADO y SIN_UTILIDAD). */
  pendiente_usd: number;
  /** Lo pagado de más sobre la utilidad (> $1.00; si no, 0). */
  exceso_usd: number;
}

/**
 * Estado de UN (avión, socio, mes): utilidad ≤ 0 ⇒ SIN_UTILIDAD; pagado ≥
 * utilidad − $1.00 ⇒ PAGADO (la tolerancia absorbe el residuo: pendiente 0);
 * pagado > 0 ⇒ PARCIAL; si no, PENDIENTE. `exceso_usd` = pagado −
 * max(utilidad, 0) cuando pasa de $1.00. DESVIACIÓN CONSCIENTE del contrato
 * («pagado − utilidad»): con utilidad NEGATIVA, todo lo pagado es de más,
 * pero no más que lo pagado (utilidad −500 y pagado 100 ⇒ exceso 100, no
 * 600: la pérdida del avión no es dinero que el socio haya recibido). La
 * copia del panel (`lib/admin/reparto-pagos.ts#estadoPagoSocio`) debe usar
 * el MISMO `max(u, 0)` (invariante 38).
 */
export function estadoPagoSocio(
  utilidadUsd: number,
  pagadoUsd: number,
): EstadoPago {
  const u = centavos(Number(utilidadUsd) || 0);
  const p = centavos(Number(pagadoUsd) || 0);
  const excesoC = p - Math.max(u, 0);
  const exceso_usd = excesoC > TOLERANCIA_CENTAVOS ? excesoC / 100 : 0;
  if (u <= 0) return { estado: 'SIN_UTILIDAD', pendiente_usd: 0, exceso_usd };
  if (p >= u - TOLERANCIA_CENTAVOS) {
    return { estado: 'PAGADO', pendiente_usd: 0, exceso_usd };
  }
  if (p > 0) {
    return { estado: 'PARCIAL', pendiente_usd: (u - p) / 100, exceso_usd: 0 };
  }
  return { estado: 'PENDIENTE', pendiente_usd: u / 100, exceso_usd: 0 };
}

/** ¿La utilidad de hoy difiere de la foto del último pago (> $1.00)? */
export function utilidadDifiere(
  snapshotUsd: number | null | undefined,
  actualUsd: number,
): boolean {
  if (snapshotUsd == null || !Number.isFinite(Number(snapshotUsd))) {
    return false;
  }
  return (
    Math.abs(centavos(Number(snapshotUsd)) - centavos(actualUsd)) >
    TOLERANCIA_CENTAVOS
  );
}

/**
 * ¿Registrar `montoUsd` sobre lo ya pagado rebasa la utilidad (+ $1.00)?
 * `exceso_usd` = pagado + monto − utilidad (positivo cuando excede).
 */
export function excedeUtilidad(d: {
  utilidad_usd: number;
  pagado_usd: number;
  monto_usd: number;
}): { excede: boolean; exceso_usd: number } {
  const total = centavos(d.pagado_usd) + centavos(d.monto_usd);
  const u = centavos(d.utilidad_usd);
  return {
    excede: total > u + TOLERANCIA_CENTAVOS,
    exceso_usd: (total - u) / 100,
  };
}

// ===================================================================
// Filas y pagos
// ===================================================================

/** Fila cruda de `reparto_pago` (numeric puede llegar como texto). */
export interface RepartoPagoRow {
  id: string;
  aeronave_id: string;
  socio_id: string;
  periodo: string;
  monto: number | string;
  moneda: string;
  tc_usd_mxn: number | string | null;
  monto_usd: number | string;
  utilidad_snapshot_usd: number | string;
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
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  motivo_baja: string | null;
}

/** Pago como lo ve el panel: la fila + nombres + URL firmada (8 h). */
export interface PagoSocio {
  id: string;
  aeronave_id: string;
  socio_id: string;
  periodo: string;
  mes: string;
  monto: number;
  moneda: MonedaPagoSocio;
  tc_usd_mxn: number | null;
  monto_usd: number;
  utilidad_snapshot_usd: number;
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
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  motivo_baja: string | null;
  entregado_por_nombre: string | null;
  created_by_nombre: string | null;
  comprobante_url: string | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Fila ⇒ `PagoSocio` (nombres y URL resueltos aparte, nunca un uuid). */
export function aPagoSocio(
  r: RepartoPagoRow,
  nombres: ReadonlyMap<string, string> = new Map(),
  urls: ReadonlyMap<string, string> = new Map(),
): PagoSocio {
  const tc = r.tc_usd_mxn == null ? null : num(r.tc_usd_mxn);
  return {
    id: r.id,
    aeronave_id: r.aeronave_id,
    socio_id: r.socio_id,
    periodo: r.periodo,
    mes: mesDeFechaPeriodo(r.periodo),
    monto: num(r.monto),
    moneda: r.moneda === 'MXN' ? 'MXN' : 'USD',
    tc_usd_mxn: tc,
    monto_usd: num(r.monto_usd),
    utilidad_snapshot_usd: num(r.utilidad_snapshot_usd),
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
    updated_at: r.updated_at,
    deleted_at: r.deleted_at ?? null,
    deleted_by: r.deleted_by ?? null,
    motivo_baja: r.motivo_baja ?? null,
    entregado_por_nombre: nombres.get(r.entregado_por) ?? null,
    created_by_nombre: r.created_by
      ? (nombres.get(r.created_by) ?? null)
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
 * Orden de CAPTURA (cuándo se registró el pago: `created_at`, luego id).
 * Es el orden en que se tomaron las fotos de la utilidad y el que decide,
 * de forma determinista para las dos peticiones, cuál de dos altas
 * simultáneas es la que sobra.
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

/** Orden cronológico de los pagos (fecha, captura, id). */
export function ordenarPagos<
  T extends Pick<PagoSocio, 'fecha_pago' | 'created_at' | 'id'>,
>(pagos: ReadonlyArray<T>): T[] {
  return [...pagos].sort(
    (a, b) =>
      a.fecha_pago.localeCompare(b.fecha_pago) ||
      String(a.created_at).localeCompare(String(b.created_at)) ||
      a.id.localeCompare(b.id),
  );
}

export interface AeronaveRef {
  id: string;
  matricula: string;
  modelo: string;
}

export interface SocioRef {
  id: string;
  nombre: string;
}

/** Lo que se LEE de `compute()`: el avión y su reparto. */
export interface RepartoAvionInput {
  aeronave: AeronaveRef;
  reparto: ReadonlyArray<{
    socio_id: string;
    socio_nombre: string;
    porcentaje: number;
    monto_usd: number;
  }>;
}

export interface FilaPagoSocio {
  aeronave: AeronaveRef;
  socio: SocioRef;
  /** Σ % del socio en el avión (0 si ya no es socio en el mes). */
  porcentaje: number;
  /** Utilidad del mes calculada HOY (`compute`). */
  utilidad_usd: number;
  pagado_usd: number;
  pendiente_usd: number;
  exceso_usd: number;
  estado: EstadoPagoSocio;
  /** Foto de la utilidad al registrar el ÚLTIMO pago (null sin pagos). */
  utilidad_al_pagar_usd: number | null;
  utilidad_difiere: boolean;
  /** ADITIVO: false = el socio ya no está en el reparto del mes (tiene pagos). */
  vigente: boolean;
  /** ADITIVO: texto del aviso del renglón (no vigente) o null. */
  aviso: string | null;
  pagos: PagoSocio[];
}

/** Lo que el reparto del mes le toca a un socio en un avión. */
export interface PartesDeSocio {
  nombre: string;
  /** Σ % (3 decimales). */
  porcentaje: number;
  /** Σ `monto_usd` en centavos ⇒ USD. */
  utilidad_usd: number;
}

/**
 * FUENTE ÚNICA de «utilidad y % de cada socio en un avión» (la leen el 409
 * del alta, la foto y los renglones: jamás dos agregaciones del mismo
 * número). Un socio con dos vigencias que tocan el mes aparece dos veces en
 * el reparto: se SUMA (el % total ≠ 100 ya lo delata el badge del reparto).
 * Orden de inserción = el del reparto.
 */
export function partesDeSociosEnAvion(
  avion: RepartoAvionInput,
): Map<string, PartesDeSocio> {
  const acc = new Map<string, { nombre: string; pct: number; c: number }>();
  for (const r of avion.reparto) {
    const s = acc.get(r.socio_id) ?? { nombre: r.socio_nombre, pct: 0, c: 0 };
    s.pct += num(r.porcentaje);
    s.c += Math.round(num(r.monto_usd) * 100);
    acc.set(r.socio_id, s);
  }
  const out = new Map<string, PartesDeSocio>();
  for (const [id, s] of acc) {
    out.set(id, {
      nombre: s.nombre,
      porcentaje: redondearA(s.pct, 3),
      utilidad_usd: s.c / 100,
    });
  }
  return out;
}

/**
 * Utilidad del socio en el avión según el reparto del mes (vía
 * `partesDeSociosEnAvion`). `avion_activo` = el avión vino en el cálculo
 * (`compute` trae TODOS los aviones activos, y solo esos).
 */
export function utilidadDeSocioEnAvion(
  aviones: ReadonlyArray<RepartoAvionInput>,
  aeronaveId: string,
  socioId: string,
): {
  avion_activo: boolean;
  utilidad_usd: number;
  porcentaje: number;
  vigente: boolean;
} {
  const avion = aviones.find((a) => a.aeronave.id === aeronaveId);
  if (!avion) {
    return {
      avion_activo: false,
      utilidad_usd: 0,
      porcentaje: 0,
      vigente: false,
    };
  }
  const s = partesDeSociosEnAvion(avion).get(socioId);
  return {
    avion_activo: true,
    utilidad_usd: s?.utilidad_usd ?? 0,
    porcentaje: s?.porcentaje ?? 0,
    vigente: s != null,
  };
}

/**
 * FUENTE ÚNICA de «lo pagado»: Σ `monto_usd` en centavos ⇒ USD (numeric
 * puede llegar como texto). La usan el renglón, el 409 del exceso y la
 * revisión de la carrera de altas.
 */
export function sumaMontoUsd(
  pagos: ReadonlyArray<{ monto_usd: number | string }>,
): number {
  return (
    pagos.reduce((acc, p) => acc + Math.round(num(p.monto_usd) * 100), 0) / 100
  );
}

/**
 * CARRERA DE ALTAS (revisión adversaria 1-oct-2026): dos altas del mismo
 * renglón pueden pasar a la vez el candado del exceso (leer y luego
 * insertar). Ya insertado `nuevo`, ¿rebasa la utilidad contando SOLO los
 * pagos vivos capturados ANTES que él? Las dos peticiones llegan a la misma
 * conclusión (orden de captura determinista): la que quedó después es la
 * que sobra; la primera se queda.
 */
export function excedeEnOrdenDeCaptura(d: {
  utilidad_usd: number;
  vivos: ReadonlyArray<{
    id: string;
    created_at: string;
    monto_usd: number | string;
  }>;
  nuevo: { id: string; created_at: string; monto_usd: number | string };
}): { excede: boolean; pagado_antes_usd: number; exceso_usd: number } {
  const antes = d.vivos.filter(
    (p) => p.id !== d.nuevo.id && compararCaptura(p, d.nuevo) < 0,
  );
  const pagadoAntes = sumaMontoUsd(antes);
  const ex = excedeUtilidad({
    utilidad_usd: d.utilidad_usd,
    pagado_usd: pagadoAntes,
    monto_usd: num(d.nuevo.monto_usd),
  });
  return {
    excede: ex.excede,
    pagado_antes_usd: pagadoAntes,
    exceso_usd: ex.exceso_usd,
  };
}

/**
 * La foto de la utilidad más RECIENTE = la del último pago CAPTURADO
 * (`created_at`), no la del último por `fecha_pago`: un efectivo entregado
 * antes pero capturado después ya trae la utilidad nueva (revisión
 * adversaria 1-oct-2026). Límite conocido: corregir el DINERO de un pago
 * viejo renueva SU foto, pero la referencia sigue siendo el último
 * capturado.
 */
export function fotoMasReciente(
  pagos: ReadonlyArray<
    Pick<PagoSocio, 'created_at' | 'id' | 'utilidad_snapshot_usd'>
  >,
): number | null {
  let ultimo: (typeof pagos)[number] | null = null;
  for (const p of pagos) {
    if (!ultimo || compararCaptura(p, ultimo) > 0) ultimo = p;
  }
  return ultimo ? ultimo.utilidad_snapshot_usd : null;
}

function filaDesde(
  aeronave: AeronaveRef,
  socio: SocioRef,
  porcentaje: number,
  utilidadUsd: number,
  pagosFila: PagoSocio[],
  aviso: string | null,
): FilaPagoSocio {
  const pagos = ordenarPagos(pagosFila);
  const pagado = sumaMontoUsd(pagos);
  const e = estadoPagoSocio(utilidadUsd, pagado);
  const alPagar = fotoMasReciente(pagos);
  return {
    aeronave,
    socio,
    porcentaje,
    utilidad_usd: utilidadUsd,
    pagado_usd: pagado,
    pendiente_usd: e.pendiente_usd,
    exceso_usd: e.exceso_usd,
    estado: e.estado,
    utilidad_al_pagar_usd: alPagar,
    utilidad_difiere: utilidadDifiere(alPagar, utilidadUsd),
    vigente: aviso == null,
    aviso,
    pagos,
  };
}

/**
 * Renglones (avión × socio) del mes: cada socio VIGENTE del reparto de cada
 * avión del cálculo, MÁS cualquier (avión, socio) con pagos del mes aunque ya
 * no esté en el reparto (utilidad 0 y aviso: `avisoAvionDadoDeBaja` si el
 * avión no vino en el cálculo — `compute` trae todos los activos —, si no
 * `AVISO_SOCIO_NO_VIGENTE`). Orden: matrícula, vigentes primero, % mayor,
 * nombre.
 */
export function armarFilasPagos(e: {
  aviones: ReadonlyArray<RepartoAvionInput>;
  pagos: ReadonlyArray<PagoSocio>;
  /** Aviones de pagos que el cálculo no trajo (dados de baja). */
  aeronavesExtra?: ReadonlyMap<string, AeronaveRef>;
  /** Nombres de socios con pagos que ya no están en el reparto. */
  nombresSocios?: ReadonlyMap<string, string>;
}): FilaPagoSocio[] {
  const llave = (a: string, s: string) => `${a}|${s}`;
  const porLlave = new Map<string, PagoSocio[]>();
  for (const p of e.pagos) {
    const k = llave(p.aeronave_id, p.socio_id);
    const l = porLlave.get(k) ?? [];
    l.push(p);
    porLlave.set(k, l);
  }
  const filas: FilaPagoSocio[] = [];
  const usadas = new Set<string>();
  const aeronaves = new Map<string, AeronaveRef>();
  for (const avion of e.aviones) {
    aeronaves.set(avion.aeronave.id, avion.aeronave);
    for (const [socioId, s] of partesDeSociosEnAvion(avion)) {
      const k = llave(avion.aeronave.id, socioId);
      usadas.add(k);
      filas.push(
        filaDesde(
          avion.aeronave,
          { id: socioId, nombre: s.nombre },
          s.porcentaje,
          s.utilidad_usd,
          porLlave.get(k) ?? [],
          null,
        ),
      );
    }
  }
  for (const [k, pagos] of porLlave) {
    if (usadas.has(k)) continue;
    const { aeronave_id, socio_id } = pagos[0];
    const enCalculo = aeronaves.get(aeronave_id);
    const aeronave = enCalculo ??
      e.aeronavesExtra?.get(aeronave_id) ?? {
        id: aeronave_id,
        matricula: '(avión sin matrícula)',
        modelo: '',
      };
    const mes = pagos[0].mes || mesDeFechaPeriodo(pagos[0].periodo);
    filas.push(
      filaDesde(
        aeronave,
        { id: socio_id, nombre: e.nombresSocios?.get(socio_id) ?? 'Socio' },
        0,
        0,
        pagos,
        enCalculo ? AVISO_SOCIO_NO_VIGENTE : avisoAvionDadoDeBaja(mes),
      ),
    );
  }
  return filas.sort(
    (a, b) =>
      a.aeronave.matricula.localeCompare(b.aeronave.matricula, 'es') ||
      Number(b.vigente) - Number(a.vigente) ||
      b.porcentaje - a.porcentaje ||
      a.socio.nombre.localeCompare(b.socio.nombre, 'es') ||
      a.socio.id.localeCompare(b.socio.id),
  );
}

export interface ResumenSocioPagos {
  socio: SocioRef;
  /** Σ utilidad POSITIVA de sus aviones (cada avión se liquida aparte). */
  utilidad_usd: number;
  pagado_usd: number;
  pendiente_usd: number;
  estado: EstadoPagoSocio;
  aviones: number;
}

/**
 * Consolidado por socio. La pérdida de un avión NO se compensa con la
 * utilidad de otro (cada avión tiene sus socios y se paga aparte): la
 * utilidad del consolidado suma solo las positivas. Estado: sin utilidad en
 * ningún avión ⇒ SIN_UTILIDAD; todo lo que tiene utilidad PAGADO ⇒ PAGADO;
 * algo pagado en un avión con utilidad ⇒ PARCIAL; si no, PENDIENTE.
 */
export function resumenPorSocio(
  filas: ReadonlyArray<FilaPagoSocio>,
): ResumenSocioPagos[] {
  const grupos = new Map<string, FilaPagoSocio[]>();
  for (const f of filas) {
    const l = grupos.get(f.socio.id) ?? [];
    l.push(f);
    grupos.set(f.socio.id, l);
  }
  const out: ResumenSocioPagos[] = [];
  for (const [, fs] of grupos) {
    const conUtilidad = fs.filter((f) => f.estado !== 'SIN_UTILIDAD');
    const c = (sel: (f: FilaPagoSocio) => number, de = fs) =>
      de.reduce((acc, f) => acc + Math.round(sel(f) * 100), 0) / 100;
    let estado: EstadoPagoSocio;
    if (conUtilidad.length === 0) estado = 'SIN_UTILIDAD';
    else if (conUtilidad.every((f) => f.estado === 'PAGADO')) estado = 'PAGADO';
    else if (conUtilidad.some((f) => f.pagado_usd > 0)) estado = 'PARCIAL';
    else estado = 'PENDIENTE';
    out.push({
      socio: fs[0].socio,
      utilidad_usd: c((f) => Math.max(f.utilidad_usd, 0)),
      pagado_usd: c((f) => f.pagado_usd),
      pendiente_usd: c((f) => f.pendiente_usd),
      estado,
      aviones: fs.length,
    });
  }
  return out.sort(
    (a, b) =>
      a.socio.nombre.localeCompare(b.socio.nombre, 'es') ||
      a.socio.id.localeCompare(b.socio.id),
  );
}

export interface TotalesPagos {
  utilidad_usd: number;
  pagado_usd: number;
  pendiente_usd: number;
  socios_pendientes: number;
}

/** Totales de la sección (sobre el consolidado por socio). */
export function totalesPagos(
  porSocio: ReadonlyArray<ResumenSocioPagos>,
): TotalesPagos {
  const c = (sel: (s: ResumenSocioPagos) => number) =>
    porSocio.reduce((acc, s) => acc + Math.round(sel(s) * 100), 0) / 100;
  return {
    utilidad_usd: c((s) => s.utilidad_usd),
    pagado_usd: c((s) => s.pagado_usd),
    pendiente_usd: c((s) => s.pendiente_usd),
    socios_pendientes: porSocio.filter((s) => estadoPidePago(s.estado)).length,
  };
}

// ===================================================================
// Pre-cierre
// ===================================================================

export interface PagoPendientePrecierre {
  socio: SocioRef;
  aeronave: AeronaveRef;
  pendiente_usd: number;
  estado: EstadoPagoSocio;
}

export interface SobrepagoPrecierre {
  socio: SocioRef;
  aeronave: AeronaveRef;
  /** Lo pagado de más sobre la utilidad de HOY (> $1.00). */
  exceso_usd: number;
  estado: EstadoPagoSocio;
}

export interface ResumenPrecierrePagos {
  /** Renglones (avión × socio) con pago PENDIENTE o PARCIAL. */
  count: number;
  /** Σ pendiente de esos renglones. */
  monto_usd: number;
  /** Máx `PRECIERRE_PAGOS_SOCIOS_MAX`, el pendiente mayor primero. */
  socios: PagoPendientePrecierre[];
  detalle: string;
  /**
   * ADITIVO (revisión adversaria 1-oct-2026): renglones con `exceso_usd > 0`
   * — la utilidad bajó después de pagar (cobro reembolsado, gasto tardío),
   * una carrera de altas o pagos en un avión/socio fuera del reparto. Antes
   * el pre-cierre decía «todos tienen su pago registrado» y el sobrepago se
   * escapaba del cierre.
   */
  sobrepagos: number;
  /** Σ exceso de esos renglones. */
  sobrepagos_usd: number;
  /** Máx `PRECIERRE_PAGOS_SOCIOS_MAX`, el exceso mayor primero. */
  sobrepagados: SobrepagoPrecierre[];
  /** Texto del item `pagos_socios_sobrepagados`. */
  detalle_sobrepagos: string;
}

/**
 * Aviso NO bloqueante del pre-cierre: renglones del mes con utilidad sin
 * pagar o con pago parcial («N pago(s) a socios pendientes de septiembre
 * 2026 por $X USD: Mauricio Roque (N4142R) $1,395.94 USD, …») y, aparte,
 * los pagados POR ENCIMA de la utilidad.
 */
export function resumenPrecierrePagos(
  filas: ReadonlyArray<FilaPagoSocio>,
  mes: string,
): ResumenPrecierrePagos {
  const sobrepagados = filas
    .filter((f) => f.exceso_usd > 0)
    .map((f) => ({
      socio: f.socio,
      aeronave: f.aeronave,
      exceso_usd: f.exceso_usd,
      estado: f.estado,
    }))
    .sort(
      (a, b) =>
        b.exceso_usd - a.exceso_usd ||
        a.socio.nombre.localeCompare(b.socio.nombre, 'es') ||
        a.aeronave.matricula.localeCompare(b.aeronave.matricula, 'es'),
    );
  const totalExceso =
    sobrepagados.reduce((acc, p) => acc + Math.round(p.exceso_usd * 100), 0) /
    100;
  const pendientes = filas
    .filter((f) => estadoPidePago(f.estado))
    .map((f) => ({
      socio: f.socio,
      aeronave: f.aeronave,
      pendiente_usd: f.pendiente_usd,
      estado: f.estado,
    }))
    .sort(
      (a, b) =>
        b.pendiente_usd - a.pendiente_usd ||
        a.socio.nombre.localeCompare(b.socio.nombre, 'es') ||
        a.aeronave.matricula.localeCompare(b.aeronave.matricula, 'es'),
    );
  const total =
    pendientes.reduce((acc, p) => acc + Math.round(p.pendiente_usd * 100), 0) /
    100;
  const et = etiquetaMes(mes);
  const nSobre = sobrepagados.length;
  let detalle: string;
  if (pendientes.length === 0) {
    detalle =
      nSobre === 0
        ? `Todos los socios con utilidad de ${et} tienen su pago registrado.`
        : `Todos los socios con utilidad de ${et} tienen su pago registrado, pero ${nSobre} pago(s) quedaron por encima de la utilidad: revisa «${TITULO_PRECIERRE_SOBREPAGOS_SOCIOS}».`;
  } else {
    const primeros = pendientes
      .slice(0, 5)
      .map(
        (p) =>
          `${p.socio.nombre} (${p.aeronave.matricula}) ${usd(p.pendiente_usd)}`,
      )
      .join(', ');
    const resto =
      pendientes.length > 5 ? ` y ${pendientes.length - 5} más` : '';
    const ademas =
      nSobre > 0
        ? ` Además, ${nSobre} pago(s) quedaron por encima de la utilidad.`
        : '';
    detalle = `${pendientes.length} pago(s) a socios pendientes de ${et} por ${usd(total)}: ${primeros}${resto}. Regístralos en Reparto de utilidades → «Pagos a socios».${ademas}`;
  }
  let detalleSobrepagos: string;
  if (nSobre === 0) {
    detalleSobrepagos = `Ningún pago a socios de ${et} quedó por encima de la utilidad.`;
  } else {
    const primeros = sobrepagados
      .slice(0, 5)
      .map(
        (p) =>
          `${p.socio.nombre} (${p.aeronave.matricula}) ${usd(p.exceso_usd)} de más`,
      )
      .join(', ');
    const resto = nSobre > 5 ? ` y ${nSobre - 5} más` : '';
    detalleSobrepagos = `${nSobre} pago(s) a socios de ${et} quedaron por encima de la utilidad por ${usd(totalExceso)}: ${primeros}${resto}. La utilidad bajó después de pagar (cobro reembolsado, gasto tardío), se registraron dos pagos a la vez o el socio/avión ya no está en el reparto: revisa el renglón en Reparto de utilidades → «Pagos a socios» y corrige o elimina el pago de más.`;
  }
  return {
    count: pendientes.length,
    monto_usd: total,
    socios: pendientes.slice(0, PRECIERRE_PAGOS_SOCIOS_MAX),
    detalle,
    sobrepagos: nSobre,
    sobrepagos_usd: totalExceso,
    sobrepagados: sobrepagados.slice(0, PRECIERRE_PAGOS_SOCIOS_MAX),
    detalle_sobrepagos: detalleSobrepagos,
  };
}

// ===================================================================
// Comprobante
// ===================================================================

/**
 * Llave del comprobante dentro de `reparto-comprobantes`:
 * `<aeronave>/<YYYY-MM>/<pago>/<uuid>.<ext>`. Un uuid por subida: reemplazar
 * NO pisa el archivo anterior (se conserva en el bucket, como las facturas
 * emitidas y los comprobantes de cobro).
 */
export function pathComprobantePago(
  aeronaveId: string,
  mes: string,
  pagoId: string,
  id: string,
  extension: string,
): string {
  return `${aeronaveId}/${mes}/${pagoId}/${id}.${extension}`;
}
