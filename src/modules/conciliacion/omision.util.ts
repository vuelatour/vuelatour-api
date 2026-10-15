/**
 * «OMITIR LA CONCILIACIÓN» (14-oct-2026, API 0.0.77, invariante 75).
 * Pedido del usuario con la captura de /admin/conciliacion: «Necesitamos una
 * opción de pendientes de conciliar venga una opción de Omitir la
 * conciliación.»
 *
 * Fuente única PURA (con spec) de la regla y de TODOS los textos: un
 * movimiento omitido lleva la clasificación canónica «Omitido de la
 * conciliación» (por NOMBRE, la crea la RPC en la primera omisión) y, al
 * inicio de sus notas, la línea firmada
 * «Omitido de la conciliación: <motivo> — <usuario>, dd-mmm-aaaa».
 *
 * ESPEJOS de la migración `20261014000002` (los congela
 * `omision-cargos.paridad.spec.ts`, que lee el archivo SQL): el nombre
 * canónico, el prefijo, los topes y las 7 columnas del trigger. El estado
 * de un movimiento que ya no está pendiente (`estadoMovimientoParaOmitir`)
 * es el espejo del CASE de la RPC, y `quitarLineaOmision` el del UPDATE que
 * deshace la omisión (byte a byte).
 */
import {
  fechaMensaje,
  fechaNota,
  limpiarJustificacion,
  montoNota,
} from '../../common/vinculo-no-bancario.util';
import { MENSAJE_OPCION_NO_ACTIVA } from '../../common/omision-cargos-disponible.util';

export { MENSAJE_OPCION_NO_ACTIVA };

/** Nombre de la clasificación canónica (espejo de la migración). */
export const CLASIFICACION_OMITIDO = 'Omitido de la conciliación';

/** Inicio de la línea firmada en las notas (espejo de la migración). */
export const PREFIJO_LINEA_OMISION = 'Omitido de la conciliación: ';

/** Tope de movimientos por lote (omitir y deshacer; espejo de la RPC). */
export const OMITIR_MAX = 200;

/** Motivo: 10..300 caracteres (recortado). */
export const MOTIVO_OMISION_MIN = 10;
export const MOTIVO_OMISION_MAX = 300;

/** Firmante en UNA línea, ≤ 80. */
export const FIRMANTE_MAX = 80;

/** Tope de la línea completa (espejo del CHECK de la RPC). */
export const LINEA_OMISION_MAX = 500;

/** Columnas del trigger `trg_mov_bancario_omitido_sin_ligas` (espejo). */
export const COLUMNAS_TRIGGER_OMITIDO = [
  'gasto_id',
  'gastos_n',
  'cobro_id',
  'cobros_n',
  'cobro_grupo_id',
  'ingreso_id',
  'reverso_de_id',
] as const;

/** Estatus de la fila omitida en el Excel de conciliación. */
export const ESTATUS_OMITIDO = 'Omitido';

/** Separador entre el motivo y la firma de la línea. */
const SEPARADOR_FIRMA = ' — ';

/** Texto en UNA línea (espacios y saltos colapsados). */
function unaLinea(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * ¿Es la clasificación canónica? Recortado, espacios colapsados y en
 * minúsculas es-MX (los acentos se conservan, como `lower()` de la BD).
 */
export function esClasificacionOmitida(
  nombre: string | null | undefined,
): boolean {
  if (typeof nombre !== 'string') return false;
  return (
    unaLinea(nombre).toLocaleLowerCase('es-MX') ===
    CLASIFICACION_OMITIDO.toLocaleLowerCase('es-MX')
  );
}

/** Omisión leída de la línea firmada (null en lo que no se pudo leer). */
export interface Omision {
  motivo: string | null;
  por: string | null;
  /** dd-mmm-aaaa (la fecha Cancún de la omisión, como se escribió). */
  fecha: string | null;
}

/** Omisión sin datos legibles (línea dañada o ausente). */
export const OMISION_SIN_DATOS: Omision = Object.freeze({
  motivo: null,
  por: null,
  fecha: null,
});

/**
 * La línea firmada: «Omitido de la conciliación: Comisión o IVA del banco —
 * Alejandro Canales, 14-oct-2026». Motivo en UNA línea y ≤ 300; firmante
 * en una línea ≤ 80 (vacío ⇒ «Oficina»); fecha `fechaNota(hoy)` (hoy =
 * día Cancún). Nunca > 500 ni con saltos.
 */
export function lineaOmision(args: {
  motivo: string;
  usuario?: string | null;
  hoy: string;
}): string {
  const motivo = limpiarJustificacion(args.motivo)
    .slice(0, MOTIVO_OMISION_MAX)
    .trim();
  const firmante =
    unaLinea(args.usuario).slice(0, FIRMANTE_MAX).trim() || 'Oficina';
  const linea = `${PREFIJO_LINEA_OMISION}${motivo}${SEPARADOR_FIRMA}${firmante}, ${fechaNota(args.hoy)}`;
  return linea.length > LINEA_OMISION_MAX
    ? linea.slice(0, LINEA_OMISION_MAX)
    : linea;
}

const RE_FECHA_NOTA = /^\d{2}-[a-zñ]{3}-\d{4}$/;

/**
 * Lee la omisión de las notas: SOLO si la PRIMERA línea trae el prefijo.
 * Motivo = lo anterior a la ÚLTIMA « — »; quién y fecha = lo posterior
 * («Alejandro Canales, 14-oct-2026»). Sin el prefijo ⇒ null; con el
 * prefijo pero dañada ⇒ `OMISION_SIN_DATOS`.
 */
export function leerOmision(notas: string | null | undefined): Omision | null {
  if (typeof notas !== 'string' || !notas.startsWith(PREFIJO_LINEA_OMISION)) {
    return null;
  }
  const fin = notas.indexOf('\n');
  const primera = (fin < 0 ? notas : notas.slice(0, fin)).replace(/\r$/, '');
  const resto = primera.slice(PREFIJO_LINEA_OMISION.length);
  const corte = resto.lastIndexOf(SEPARADOR_FIRMA);
  if (corte < 0) return { ...OMISION_SIN_DATOS };
  const motivo = resto.slice(0, corte).trim();
  const firma = resto.slice(corte + SEPARADOR_FIRMA.length);
  const coma = firma.lastIndexOf(', ');
  if (coma < 0) return { ...OMISION_SIN_DATOS };
  const por = firma.slice(0, coma).trim();
  const fecha = firma.slice(coma + 2).trim();
  if (!motivo || !por || !RE_FECHA_NOTA.test(fecha)) {
    return { ...OMISION_SIN_DATOS };
  }
  return { motivo, por, fecha };
}

/**
 * Omisión de una fila de `movimiento_bancario` con el embed
 * `clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)`
 * (objeto o arreglo) y `notas`. Exige la clasificación CANÓNICA; con ella
 * y sin línea legible ⇒ `OMISION_SIN_DATOS` (sigue siendo un omitido).
 */
export function omisionDeFila(fila: {
  clasificacion?: unknown;
  notas?: unknown;
}): Omision | null {
  const c = Array.isArray(fila.clasificacion)
    ? (fila.clasificacion[0] as unknown)
    : fila.clasificacion;
  const nombre =
    c && typeof c === 'object' ? (c as { nombre?: unknown }).nombre : undefined;
  if (!esClasificacionOmitida(typeof nombre === 'string' ? nombre : null)) {
    return null;
  }
  return (
    leerOmision(typeof fila.notas === 'string' ? fila.notas : null) ?? {
      ...OMISION_SIN_DATOS,
    }
  );
}

/**
 * Espejo EXACTO del UPDATE de `conciliacion_quitar_omision`: sin el prefijo
 * ⇒ igual; sin salto ⇒ null; si no ⇒ lo que sigue al PRIMER `\n` (vacío ⇒
 * null). Ida y vuelta byte a byte (incluye `\r\n` y espacios finales).
 */
export function quitarLineaOmision(
  notas: string | null | undefined,
): string | null {
  if (notas === null || notas === undefined) return null;
  if (!notas.startsWith(PREFIJO_LINEA_OMISION)) return notas;
  const fin = notas.indexOf('\n');
  if (fin < 0) return null;
  const resto = notas.slice(fin + 1);
  return resto === '' ? null : resto;
}

/** Estado de un movimiento que ya NO está pendiente (espejo del CASE de la RPC). */
export type EstadoNoPendiente =
  | 'CON_GASTO'
  | 'CON_COBRO'
  | 'CON_SOBRE'
  | 'CON_INGRESO'
  | 'REVERSO'
  | 'OMITIDO'
  | 'CLASIFICADO'
  | 'CONCILIADO';

export type EstadoParaOmitir = 'PENDIENTE' | EstadoNoPendiente;

export interface MovimientoParaEstado {
  conciliado?: unknown;
  gasto_id?: unknown;
  gastos_n?: unknown;
  cobro_id?: unknown;
  cobros_n?: unknown;
  cobro_grupo_id?: unknown;
  ingreso_id?: unknown;
  clasificacion_id?: unknown;
  reverso_de_id?: unknown;
}

function lleno(v: unknown): boolean {
  return typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined;
}

/**
 * PENDIENTE y LIBRE (sin gasto, cobro, sobre, ingreso, clasificación ni par
 * de devolución) o el estado que lo ocupa, con la MISMA precedencia que la
 * RPC: gasto > cobro > sobre > ingreso > reverso > omitido > clasificado >
 * conciliado. `tieneDevolucion` = algún abono apunta a ESTE cargo
 * (`reverso_de_id`).
 */
export function estadoMovimientoParaOmitir(
  m: MovimientoParaEstado,
  ctx: { idOmitido: string | null; tieneDevolucion: boolean },
): EstadoParaOmitir {
  const gastosN = Number(m.gastos_n) || 0;
  const cobrosN = Number(m.cobros_n) || 0;
  const ocupado =
    m.conciliado === true ||
    gastosN > 0 ||
    cobrosN > 0 ||
    lleno(m.gasto_id) ||
    lleno(m.cobro_id) ||
    lleno(m.cobro_grupo_id) ||
    lleno(m.ingreso_id) ||
    lleno(m.clasificacion_id) ||
    lleno(m.reverso_de_id) ||
    ctx.tieneDevolucion;
  if (!ocupado) return 'PENDIENTE';
  if (gastosN > 0 || lleno(m.gasto_id)) return 'CON_GASTO';
  if (cobrosN > 0 || lleno(m.cobro_id)) return 'CON_COBRO';
  if (lleno(m.cobro_grupo_id)) return 'CON_SOBRE';
  if (lleno(m.ingreso_id)) return 'CON_INGRESO';
  if (lleno(m.reverso_de_id) || ctx.tieneDevolucion) return 'REVERSO';
  if (
    ctx.idOmitido &&
    typeof m.clasificacion_id === 'string' &&
    m.clasificacion_id === ctx.idOmitido
  ) {
    return 'OMITIDO';
  }
  if (lleno(m.clasificacion_id)) return 'CLASIFICADO';
  return 'CONCILIADO';
}

const TEXTO_ESTADO: Record<EstadoNoPendiente | 'PENDIENTE', string> = {
  CON_GASTO: 'ya está vinculado a un gasto',
  CON_COBRO: 'ya está vinculado a un cobro',
  CON_SOBRE: 'ya está vinculado al cobro de un grupo',
  CON_INGRESO: 'ya está vinculado a un ingreso',
  REVERSO: 'está emparejado con su devolución',
  OMITIDO: 'ya está omitido',
  CLASIFICADO: 'ya está clasificado',
  CONCILIADO: 'ya está conciliado',
  PENDIENTE: 'está pendiente',
};

/** «ya está vinculado a un gasto» · … (texto del estado, para los 409). */
export function textoEstadoNoPendiente(
  estado: string | null | undefined,
): string {
  return (
    TEXTO_ESTADO[(estado ?? '') as keyof typeof TEXTO_ESTADO] ??
    'ya no está pendiente'
  );
}

/** Aviso antes de omitir: el movimiento podría conciliarse de verdad. */
export type RiesgoOmision =
  | 'GASTO_QUE_CUADRA'
  | 'GASTOS_AMBIGUOS'
  | 'COBRO_QUE_CUADRA'
  | 'TRASPASO'
  | 'DEVOLUCION'
  | 'SIN_VERIFICAR';

/** Prioridad (el primero que aplica). */
export const PRIORIDAD_RIESGO_OMISION: readonly RiesgoOmision[] = [
  'GASTO_QUE_CUADRA',
  'GASTOS_AMBIGUOS',
  'COBRO_QUE_CUADRA',
  'TRASPASO',
  'DEVOLUCION',
  'SIN_VERIFICAR',
];

export interface EntradaRiesgoOmision {
  tipo: string | null | undefined;
  /**
   * CARGO: `motivo_pendiente` que anotó `anotarMotivoPendiente`
   * (SE_PUEDE_CRUZAR | AMBIGUO | SIN_CANDIDATOS). Ausente/null = no se
   * pudo anotar (lectura caída o truncada, cuenta sin moneda) ⇒ SIN_VERIFICAR.
   */
  motivoCargo?: string | null;
  /**
   * ABONO: cobros/sobres LIBRES que cuadran exacto (`cobrosExactosLibresDeAbono`).
   * null/ausente = no se pudo verificar ⇒ SIN_VERIFICAR.
   */
  cobrosExactos?: number | null;
  /** `patronTraspaso(descripcion)` (cargo o abono). */
  traspaso: boolean;
  /** `esDevolucionDeCargo(descripcion)` (solo cuenta en un ABONO). */
  devolucion: boolean;
}

/**
 * Riesgo de omitir un PENDIENTE (el primero por prioridad) o null. Falla
 * CERRADO: lo que no se pudo revisar es SIN_VERIFICAR (hay que aceptarlo).
 */
export function riesgoDeOmision(e: EntradaRiesgoOmision): RiesgoOmision | null {
  const presentes = new Set<RiesgoOmision>();
  if (e.tipo === 'CARGO') {
    if (e.motivoCargo === 'SE_PUEDE_CRUZAR') presentes.add('GASTO_QUE_CUADRA');
    else if (e.motivoCargo === 'AMBIGUO') presentes.add('GASTOS_AMBIGUOS');
    else if (e.motivoCargo !== 'SIN_CANDIDATOS') presentes.add('SIN_VERIFICAR');
  } else if (e.tipo === 'ABONO') {
    if (e.cobrosExactos == null) presentes.add('SIN_VERIFICAR');
    else if (e.cobrosExactos > 0) presentes.add('COBRO_QUE_CUADRA');
    if (e.devolucion) presentes.add('DEVOLUCION');
  } else {
    presentes.add('SIN_VERIFICAR');
  }
  if (e.traspaso) presentes.add('TRASPASO');
  return PRIORIDAD_RIESGO_OMISION.find((r) => presentes.has(r)) ?? null;
}

/** Texto del riesgo (para el 409 y la revisión). */
export function textoRiesgoOmision(
  r: RiesgoOmision,
  candidatosN?: number | null,
): string {
  switch (r) {
    case 'GASTO_QUE_CUADRA':
      return 'hay un gasto que cuadra: «Cruzar pendientes» o «Vincular gasto» lo resuelven';
    case 'GASTOS_AMBIGUOS': {
      const n =
        candidatosN != null && Number.isFinite(candidatosN) && candidatosN >= 2
          ? Math.trunc(candidatosN)
          : null;
      return n
        ? `hay ${n} gastos que cuadran: vincúlalo a mano`
        : 'hay varios gastos que cuadran: vincúlalo a mano';
    }
    case 'COBRO_QUE_CUADRA':
      return 'hay un cobro de vuelo que cuadra: vincúlalo a ese cobro';
    case 'TRASPASO':
      return 'es un traspaso entre cuentas: «Cruzar pendientes» lo clasifica solo';
    case 'DEVOLUCION':
      return 'parece la devolución de un cargo: usa «Emparejar devoluciones»';
    case 'SIN_VERIFICAR':
    default:
      return 'no se pudo revisar si tiene un gasto o un cobro que cuadre';
  }
}

/** Descripción del banco en los mensajes (≤ 40). */
const DESCRIPCION_MENSAJE_MAX = 40;

/** «12 oct · ASA CANCUN $8,468.91» (« USD» fuera de pesos; descripción ≤ 40). */
export function lineaMovimientoMensaje(m: {
  fecha?: string | null;
  descripcion?: string | null;
  monto?: number | string | null;
  moneda?: string | null;
}): string {
  const d = unaLinea(m.descripcion);
  const desc =
    d.length > DESCRIPCION_MENSAJE_MAX
      ? `${d.slice(0, DESCRIPCION_MENSAJE_MAX - 1).trimEnd()}…`
      : d;
  return [
    fechaMensaje(m.fecha ?? null),
    '·',
    ...(desc ? [desc] : []),
    montoNota(Number(m.monto) || 0, m.moneda ?? null),
  ].join(' ');
}

/** Fila nombrada en un 409 (movimiento + estado o riesgo). */
export interface FilaMensajeOmision {
  fecha?: string | null;
  descripcion?: string | null;
  monto?: number | string | null;
  moneda?: string | null;
  estado?: string | null;
}

/** Hasta 5 nombrados y «y N más». */
const NOMBRADOS_MAX = 5;

function listaNombrada<T>(filas: readonly T[], item: (f: T) => string): string {
  const vis = filas.slice(0, NOMBRADOS_MAX).map(item).join(' · ');
  const resto = filas.length - NOMBRADOS_MAX;
  return resto > 0 ? `${vis} y ${resto} más` : vis;
}

/**
 * 409 MOVIMIENTO_NO_PENDIENTE (omitir / vincular / crear por la suma): qué
 * movimientos ya no están pendientes y por qué.
 */
export function mensajeNoPendientes(
  filas: readonly FilaMensajeOmision[],
  total: number,
  accion: 'omitir' | 'vincular' | 'crear',
): string {
  const n = filas.length;
  const lista = listaNombrada(
    filas,
    (f) => `${lineaMovimientoMensaje(f)} (${textoEstadoNoPendiente(f.estado)})`,
  );
  const verbo = n === 1 ? 'ya no está pendiente' : 'ya no están pendientes';
  if (accion === 'omitir') {
    if (total <= 1) {
      return `No se omitió: el movimiento ${verbo} — ${lista}. Recarga la lista y vuelve a seleccionar.`;
    }
    return `No se omitió ninguno: ${n} de los ${total} movimientos ${verbo} — ${lista}. Recarga la lista y vuelve a seleccionar.`;
  }
  if (accion === 'vincular') {
    return `No se vinculó ningún cargo: ${n} de los ${total} ${verbo} — ${lista}. ${n === 1 ? 'Quítalo' : 'Quítalos'} de la selección y vuelve a intentarlo.`;
  }
  return `No se registró el gasto: ${n} de los ${total} cargos ${verbo} — ${lista}. Cancela, quita esos cargos de la selección y vuelve a intentarlo.`;
}

/** Fila con riesgo nombrada en el 409 OMITIR_CON_RIESGO. */
export interface FilaRiesgoMensaje extends FilaMensajeOmision {
  riesgo: RiesgoOmision;
  candidatos_n?: number | null;
}

/** 409 OMITIR_CON_RIESGO: cuáles podrían conciliarse de verdad. */
export function mensajeOmitirConRiesgo(
  filas: readonly FilaRiesgoMensaje[],
  total: number,
): string {
  const n = filas.length;
  const lista = listaNombrada(
    filas,
    (f) =>
      `${lineaMovimientoMensaje(f)} (${textoRiesgoOmision(f.riesgo, f.candidatos_n)})`,
  );
  if (total <= 1) {
    return `El movimiento podría conciliarse de verdad: ${lista}. Quítalo de la selección o confirma que también se omite.`;
  }
  return n === 1
    ? `1 de los ${total} movimientos podría conciliarse de verdad: ${lista}. Quítalo de la selección o confirma que también se omite.`
    : `${n} de los ${total} movimientos podrían conciliarse de verdad: ${lista}. Quítalos de la selección o confirma que también se omiten.`;
}

/** 409 MOVIMIENTO_NO_OMITIDO (deshacer): cuáles ya no están omitidos. */
export function mensajeNoOmitidos(
  filas: readonly FilaMensajeOmision[],
  total: number,
): string {
  const n = filas.length;
  const lista = listaNombrada(filas, (f) => lineaMovimientoMensaje(f));
  if (total <= 1) {
    return `No se restauró: el movimiento ya no está omitido (${lista}). Recarga la lista.`;
  }
  return n === 1
    ? `No se restauró ninguno: 1 de los ${total} ya no está omitido (${lista}). Recarga la lista.`
    : `No se restauró ninguno: ${n} de los ${total} ya no están omitidos (${lista}). Recarga la lista.`;
}

/** 404 MOVIMIENTO_NO_EXISTE. */
export function mensajeMovimientosNoExisten(n: number): string {
  return n === 1
    ? 'Uno de los movimientos ya no existe: recarga la página.'
    : `${n} de los movimientos ya no existen: recarga la página.`;
}

/** 400 USA_OMITIR (clasificar con la canónica o crearla a mano). */
export const MENSAJE_USA_OMITIR =
  'Para omitir un movimiento usa «Omitir la conciliación»: pide el motivo y se deshace en la pestaña «Omitidos».';

/** 409 MOVIMIENTO_OMITIDO (con el motivo si se puede leer). */
export function mensajeMovimientoOmitido(
  omision: Omision | null | undefined,
): string {
  const motivo = omision?.motivo?.trim();
  return motivo
    ? `Este movimiento se omitió de la conciliación (motivo: ${motivo}): deshaz la omisión antes de vincularlo o clasificarlo.`
    : 'Este movimiento se omitió de la conciliación: deshaz la omisión antes de vincularlo o clasificarlo.';
}

/** 409 MOVIMIENTO_CAMBIO (clasificar con `esperado` o CAS en 0 filas). */
export const MENSAJE_MOVIMIENTO_CAMBIO =
  'Este movimiento cambió mientras tanto (alguien lo vinculó, lo clasificó o lo omitió): recarga la lista y vuelve a intentarlo.';

/** 400 ACEPTAR_RIESGO_INVALIDO. */
export const MENSAJE_ACEPTAR_RIESGO_INVALIDO =
  'Los movimientos con aviso que confirmas deben estar en la selección.';

/** 409 CONFLICTO_CONCURRENTE (40P01: Postgres resolvió un interbloqueo). */
export const MENSAJE_CONFLICTO_CONCURRENTE =
  'Otra operación tocó estos movimientos al mismo tiempo: vuelve a intentarlo.';

/**
 * «Conciliado con» del Excel: «Omitido: Comisión o IVA del banco (Alejandro
 * Canales, 14-oct-2026)»; sin datos legibles, «Omitido de la conciliación».
 */
export function etiquetaOmisionReporte(o: Omision | null | undefined): string {
  const motivo = o?.motivo?.trim();
  if (!motivo) return CLASIFICACION_OMITIDO;
  const firma = [o?.por?.trim(), o?.fecha?.trim()].filter(Boolean).join(', ');
  return firma ? `Omitido: ${motivo} (${firma})` : `Omitido: ${motivo}`;
}

/** Subtítulo del Excel: «386 conciliados (14 omitidos)» solo con omitidos. */
export function textoConciliadosReporte(
  conciliados: number,
  omitidos: number,
): string {
  return omitidos > 0
    ? `${conciliados} conciliados (${omitidos} omitido${omitidos === 1 ? '' : 's'})`
    : `${conciliados} conciliados`;
}

/** Montos del renglón del pre-cierre. */
export interface OmitidosPeriodo {
  count: number;
  monto_mxn: number;
  monto_usd: number;
}

/** Detalle del renglón informativo `movimientos_omitidos` del pre-cierre. */
export function textoOmitidosPreCierre(r: OmitidosPeriodo | null): string {
  if (!r) return 'No se pudo leer cuántos movimientos se omitieron.';
  const montos = [
    r.monto_mxn > 0 ? montoNota(r.monto_mxn, 'MXN') + ' MXN' : null,
    r.monto_usd > 0 ? montoNota(r.monto_usd, 'USD') : null,
  ].filter(Boolean);
  const entre = montos.length > 0 ? ` (${montos.join(' + ')})` : '';
  return r.count === 1
    ? `1 movimiento del banco se marcó como «no se concilia» con un motivo${entre}: revisa en Conciliación → Omitidos que no sea un gasto sin capturar.`
    : `${r.count} movimientos del banco se marcaron como «no se concilian» con un motivo${entre}: revisa en Conciliación → Omitidos que ninguno sea un gasto sin capturar.`;
}

/** Códigos 23514 que lanzan las RPC de omitir / deshacer (hint). */
export const CODIGOS_ERROR_OMISION = [
  'LOTE_INVALIDO',
  'OMISION_INVALIDA',
  'MOVIMIENTO_NO_EXISTE',
  'MOVIMIENTO_NO_PENDIENTE',
  'MOVIMIENTO_NO_OMITIDO',
  'MOVIMIENTO_OMITIDO',
] as const;
export type CodigoErrorOmision = (typeof CODIGOS_ERROR_OMISION)[number];

export interface ErrorRpcLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
  details?: string | null;
}

/**
 * Lee el error de una RPC (23514): `codigo = hint ?? prefijo «CODIGO:»`
 * (solo los de la lista dada), `details` = el JSON del `detail` (null si no
 * es un objeto). `codigo` null = no es de esta regla.
 */
export function leerErrorRpc<C extends string>(
  err: ErrorRpcLike | null | undefined,
  codigos: readonly C[],
): {
  codigo: C | null;
  texto: string;
  details: Record<string, unknown> | null;
} {
  const msg = String(err?.message ?? '');
  const esCodigo = (c: unknown): c is C =>
    typeof c === 'string' && (codigos as readonly string[]).includes(c);
  const hint = typeof err?.hint === 'string' ? err.hint.trim() : '';
  const prefijo = /^\s*([A-Z][A-Z_]+)\s*:/.exec(msg)?.[1];
  const codigo = esCodigo(hint) ? hint : esCodigo(prefijo) ? prefijo : null;
  let details: Record<string, unknown> | null = null;
  if (typeof err?.details === 'string' && err.details.trim().startsWith('{')) {
    try {
      const v: unknown = JSON.parse(err.details);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        details = v as Record<string, unknown>;
      }
    } catch {
      details = null;
    }
  }
  return {
    codigo,
    texto: msg.replace(/^\s*[A-Z][A-Z_]+\s*:\s*/, '').trim(),
    details,
  };
}

/** Error de las RPC de omitir / deshacer. */
export function leerErrorOmision(err: ErrorRpcLike | null | undefined) {
  return leerErrorRpc(err, CODIGOS_ERROR_OMISION);
}
