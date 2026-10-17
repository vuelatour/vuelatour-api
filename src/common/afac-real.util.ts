/**
 * AFAC POR VUELO — RESERVADO vs COSTO REAL (16-oct-2026, API 0.0.89,
 * invariante 90, migración `20261016000005`). PURO, con spec.
 *
 * Pedido del cliente: «lo del AFAC … debe aparecer en balance general en la
 * hoja de Otros movimientos para poder confirmar el monto … 2 columnas
 * juntas, una que sea lo reservado de afac o cotizado y otra de lo que
 * realmente costó y que en esa celda poder poner el monto y se registre sin
 * tenerte que ir a otro lado» y, después, «la columna nueva que te pedí
 * mejor que sea en la columna de egreso». Decisiones del 16-oct-2026:
 *  1. filas UNA POR VUELO;
 *  2. el costo real es EGRESO DE VUELATOUR (el avión sigue pagando lo
 *     RESERVADO = su columna PERMISO AFAC (PROVISIÓN));
 *  3. se escribe SOLO el monto del vuelo (no crea gasto);
 *  4. los gastos que son PAGO DE AFAC se MARCAN (`gasto.es_pago_afac`) y
 *     DEJAN DE RESTARLE AL AVIÓN (son el comprobante bancario de los costos
 *     reales): SUPERSEDE, solo para los marcados, la decisión del 14-oct
 *     («el AFAC lo cargan al Avión», invariante 62).
 *
 * FUENTE ÚNICA de «¿este gasto es un pago AFAC que paga VuelaTour?»:
 * `esPagoAfac`. Cada lector de dinero del avión (hoja «permisos», reparto
 * grupo PERMISO, Libro Dinero por avión, tablero de gastos por avión, ficha
 * del avión, ubicación del gasto, pre-cierre) la usa; en las CONSULTAS el
 * equivalente es `.eq('es_pago_afac', false)` — válido porque el trigger
 * `trg_gasto_pago_afac_solo_permiso` impide la marca fuera de PERMISO.
 */
import { Rol } from './types/auth.types';

/** La ÚNICA categoría que puede llevar la marca (trigger de la BD). */
export const CATEGORIA_PAGO_AFAC = 'PERMISO';

/** Lo mínimo de un gasto para decidir la marca. */
export interface GastoConMarcaAfac {
  categoria?: string | null;
  es_pago_afac?: boolean | null;
}

/**
 * Fuente ÚNICA (invariante 90). La BD garantiza marca ⇒ PERMISO (trigger);
 * el chequeo de categoría es defensa (fixtures, filas viejas en memoria).
 * Sin la migración la columna no se lee ⇒ `undefined` ⇒ false.
 */
export function esPagoAfac(g: GastoConMarcaAfac | null | undefined): boolean {
  return (
    g != null && g.es_pago_afac === true && g.categoria === CATEGORIA_PAGO_AFAC
  );
}

/**
 * Quién captura el costo real y marca un pago de AFAC (oficina). El panel
 * los copia para decidir si la celda es editable; el API los vuelve a
 * validar en cada escritura.
 */
export const ROLES_AFAC_REAL: readonly Rol[] = [
  Rol.ADMIN,
  Rol.FACTURACION,
  Rol.COORDINADOR,
];

/** ¿El rol puede capturar el costo real / marcar un pago de AFAC? */
export function rolCapturaAfac(rol: Rol | null | undefined): boolean {
  return rol != null && ROLES_AFAC_REAL.includes(rol);
}

/**
 * Clave del detalle del reparto para los PERMISO marcados (grupo EXCLUIDO:
 * no suman al avión). Empieza por la categoría ⇒ etiqueta «Permiso (pago
 * AFAC · VuelaTour)».
 */
export const PAGO_AFAC_CLAVE_DETALLE = 'PERMISO (pago AFAC · VuelaTour)';

/** Celda «Avión» de Gastos (Excel y tabla del panel): paridad API↔panel. */
export const ETIQUETA_AVION_PAGO_AFAC = 'VuelaTour · pago de AFAC';

/** Sufijo de la fila del Libro Dinero («otros gastos») de un marcado. */
export const SUFIJO_DINERO_PAGO_AFAC =
  'pago de AFAC (lo paga VuelaTour; no se acredita al avión)';

// ===== Escrituras: validación y textos (es-MX) =====

/** Máximo aceptado (numeric(14,2)). */
export const COSTO_REAL_AFAC_MAX = 999_999_999_999.99;

export const MENSAJE_COSTO_REAL_AFAC_INVALIDO =
  'El costo real debe ser un monto en pesos, cero o mayor, con hasta 2 decimales.';

/**
 * Valida el costo real (también lo hace el DTO; aquí es la defensa del
 * servicio). Devuelve el número normalizado a 2 decimales o null si es
 * inválido.
 */
export function validarCostoRealAfac(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0 || v > COSTO_REAL_AFAC_MAX) return null;
  const centavos = Math.round(v * 100);
  if (Math.abs(centavos - v * 100) > 1e-6) return null;
  return centavos / 100;
}

export const MENSAJE_AFAC_VUELO_SIN_AVION =
  'Este vuelo no tiene avión de la flota: asígnale avión antes de capturar su costo real AFAC.';
export const MENSAJE_AFAC_VUELO_SIN_FECHA =
  'Este vuelo no tiene fecha: captúrala antes de su costo real AFAC.';
export const MENSAJE_PAGO_AFAC_SOLO_OFICINA =
  'Solo administración, facturación o coordinación marca un pago de AFAC.';
export const MENSAJE_PAGO_AFAC_SOLO_PERMISO =
  'Solo un gasto de categoría Permiso puede marcarse como pago de AFAC. Cámbialo a Permiso y márcalo.';

/** Detalle NUEVO del bloqueante `permisos_sin_avion` del pre-cierre. */
export const DETALLE_PERMISOS_SIN_AVION_AFAC =
  'Un permiso sin avión no resta en ningún balance ni en el reparto. Asígnale el avión o el vuelo en Gastos; si es un pago a AFAC que paga VuelaTour, márcalo «Pago de AFAC».';

// ===== Celda editable del Balance general: motivos =====

export const MOTIVO_AFAC_NO_HABILITADO =
  'El costo real AFAC todavía no está habilitado.';

/** Fila de un vuelo multi-avión que NO es la dueña del costo real. */
export function motivoFilaNoDuena(matriculaDuena: string): string {
  return `El costo real de este vuelo va en su fila de ${matriculaDuena}.`;
}

// ===== Fragmentos de la fila «AFAC por vuelo» (otros movimientos) =====
// PROHIBIDO en cualquier texto de la fila: «sin TC» (palabra completa: vacía
// un lado del bloque VUELATOUR, `balance-empresa.util#MARCA_SIN_TC`) y
// «· PROVISIÓN (» (marca del amarillo de pyservices). Spec que barre.

/** Mismo redondeo que el resto del balance. */
export function r2(x: number): number {
  const v = Math.round(x * 100) / 100;
  return Object.is(v, -0) ? 0 : v;
}

/** Monto es-MX con 2 decimales («4,427.80»). */
export function fmtMxn(n: number): string {
  return r2(n).toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Día Cancún dd/mm/aaaa de un instante ISO (null si no se lee). */
export function fechaCortaCancun(
  iso: string | null | undefined,
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const partes = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Cancun',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? '';
  return `${p('day')}/${p('month')}/${p('year')}`;
}

/** 'Ale' de 'Alejandra Pérez'; vacío ⇒ 'la oficina'. */
function primerNombre(nombre: string | null | undefined): string {
  const n = (nombre ?? '').trim();
  return n ? n.split(/\s+/)[0] : 'la oficina';
}

/** Concepto del EGRESO sin costo real capturado (D vacía). */
export const CONCEPTO_AFAC_REAL_POR_CAPTURAR = 'AFAC costo real · por capturar';

/** «AFAC costo real · capturó Ale el 16/10/2026». */
export function conceptoAfacReal(
  capturadoPor: string | null | undefined,
  capturadoAt: string | null | undefined,
): string {
  const fecha = fechaCortaCancun(capturadoAt);
  return `AFAC costo real · capturó ${primerNombre(capturadoPor)}${
    fecha ? ` el ${fecha}` : ''
  }`;
}

/** Horas con 2 decimales en los TEXTOS (el valor viaja exacto). */
function horasTxt(h: number): string {
  return h.toFixed(2);
}

/**
 * «AFAC reservado · N621TX · 2.60 h × 100.00 USD/hr × T.C. 17.030000». Sin
 * alguno de los factores (no debería pasar con reservado ≠ 0) ⇒ solo la
 * matrícula.
 */
export function conceptoAfacReservado(e: {
  matricula: string;
  horas: number | null;
  tarifa: number | null;
  tc: number | null;
}): string {
  if (e.horas == null || e.tarifa == null || e.tc == null) {
    return `AFAC reservado · ${e.matricula}`;
  }
  return `AFAC reservado · ${e.matricula} · ${horasTxt(e.horas)} h × ${fmtMxn(
    e.tarifa,
  )} USD/hr × T.C. ${e.tc.toFixed(6)}`;
}

/**
 * Nota (comentario) de la celda del RESERVADO: de dónde sale y la cuenta
 * con los números TAL CUAL del libro (+ «Viene de septiembre 2026»).
 */
export function notaAfacReservado(e: {
  reservado: number;
  horas: number | null;
  tarifa: number | null;
  tc: number | null;
  cierreMarca?: string | null;
}): string {
  const base =
    'Reservado = tarifa AFAC del avión × T.C. de costos del vuelo × horas cobradas (columna PERMISO AFAC de la hoja de vuelos)';
  const cuenta =
    e.horas != null && e.tarifa != null && e.tc != null
      ? `: ${fmtMxn(e.tarifa)} × ${e.tc.toFixed(6)} × ${horasTxt(e.horas)} = $${fmtMxn(e.reservado)}`
      : `: $${fmtMxn(e.reservado)}`;
  return `${base}${cuenta}` + (e.cierreMarca ? `\n${e.cierreMarca}` : '');
}

// ===== Avisos del general (`consolidado.pendientes`, no bloquean) =====

export function avisoVuelosSinReal(n: number, reservadoMxn: number): string {
  return `AFAC: ${n} vuelo(s) con AFAC reservado ($${fmtMxn(reservadoMxn)}) sin costo real capturado — captúralo en 'otros movimientos' del Balance general en pantalla (columna EGRESO de cada fila AFAC).`;
}

export function avisoDiferenciaPagado(e: {
  pagadoMxn: number;
  pagos: number;
  realMxn: number;
  diferenciaMxn: number;
}): string {
  return `AFAC: pagado a AFAC en el periodo $${fmtMxn(e.pagadoMxn)} (${e.pagos} gasto(s) marcado(s) «Pago de AFAC») vs costos reales capturados $${fmtMxn(e.realMxn)}: diferencia $${fmtMxn(e.diferenciaMxn)}. Revisa que cada pago al gestor esté marcado y que cada vuelo tenga su costo real.`;
}

export function avisoPagosSinTc(k: number): string {
  return `AFAC: ${k} pago(s) de AFAC en USD sin T.C.: no suman en la comparación.`;
}

export function avisoRealesFueraDeLibro(
  mxn: number,
  folios: ReadonlyArray<number | null>,
): string {
  const lista = folios.map((f) => (f != null ? `#${f}` : '#?')).join(', ');
  return `AFAC: $${fmtMxn(mxn)} de costo real capturado en ${folios.length} vuelo(s) que no aparecen en ningún libro del periodo (${lista}): revisa su avión y su fecha.`;
}
