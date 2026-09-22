/**
 * SEMÁFORO DEL CALENDARIO — PALETA ÚNICA DE 5 COLORES (22-sep-2026).
 *
 * Pedido literal del cliente: «queremos hacer un cambio en el semáforo del
 * calendario, tanto en este calendario del sistema web y la app como en google
 * calendar con la sincronización, para que en los calendarios no se vean
 * tantos colores […] los colores que tiene cada avión configurados los
 * seguiremos respetando principalmente en los reportes del balance individual
 * y general en los excel que se generan, y es que en realidad los colores son
 * para el reporte de excel nada más».
 *
 *   Gris   — Tentativo
 *   Verde  — Confirmado
 *   Amarillo — Permiso o asunto pendiente
 *   Rojo   — Cancelado
 *   Azul   — Descanso 💤
 *
 * Consecuencias que NO hay que olvidar:
 * - **`aeronave.color_calendario` YA NO PINTA NINGÚN CALENDARIO** (ni el
 *   panel, ni la app, ni Google). La columna sigue viva y se sigue editando en
 *   la ficha del avión, pero su ÚNICO consumidor son los Excel de pyservices
 *   (balance por avión y balance general). Por eso `ParamsColorVuelo.colorAvion`
 *   sigue existiendo —los llamadores viejos pueden mandarlo— pero se IGNORA.
 * - Desaparecieron el morado «sin asignar», el rosa del externo, el gris «sin
 *   avión», el turquesa del descanso y el azul cielo del evento: cada uno cayó
 *   en el cubo del semáforo que le toca (ver `colorVueloSistema`).
 * - `google-evento.util` traduce ESTOS 5 hex a 5 colorId DISTINTOS de Google
 *   (antes 18 cosas se repartían 11 colores y había 6 colisiones).
 *
 * Regla que se conserva del 12-sep-2026: NADIE vuelve a escribir un hex de
 * calendario suelto en un servicio. Si el cliente quiere otro color, se cambia
 * ACÁ y el sistema, la app y Google se mueven juntos.
 */

/**
 * Los CINCO colores del semáforo. Es la fuente única: panel y app espejan
 * estos hex EXACTOS en su leyenda (no los recalculan ni los aproximan).
 */
export const SEMAFORO = {
  /** Gris — tentativo: todo estado ANTERIOR a CONFIRMADO. */
  TENTATIVO: '#64748B',
  /** Verde — confirmado: el vuelo (o la cita) está en firme. */
  CONFIRMADO: '#22C55E',
  /** Amarillo — permiso o asunto pendiente (incluye el mantenimiento). */
  PENDIENTE: '#F59E0B',
  /** Rojo — cancelado. */
  CANCELADO: '#EF4444',
  /** Azul — descanso de piloto 💤. */
  DESCANSO: '#3B82F6',
} as const;

// Alias con los nombres que ya usaban los lectores del módulo. Se conservan
// los que SIGUEN teniendo significado en el semáforo; los del esquema viejo
// (SIN_ASIGNAR_COLOR, EXTERNO_COLOR, SIN_AVION_COLOR, EVENTO_COLOR,
// MANTENIMIENTO_*_COLOR) se RETIRARON a propósito: ya no existe esa distinción
// y dejarlos invitaba a volver a pintarla.

/** Gris del tentativo (`SEMAFORO.TENTATIVO`). */
export const TENTATIVO_COLOR: string = SEMAFORO.TENTATIVO;
/** Verde del confirmado (`SEMAFORO.CONFIRMADO`). */
export const CONFIRMADO_COLOR: string = SEMAFORO.CONFIRMADO;
/** Amarillo de «permiso o asunto pendiente» (`SEMAFORO.PENDIENTE`). */
export const PENDIENTE_COLOR: string = SEMAFORO.PENDIENTE;
/**
 * Rojo del cancelado. En el calendario del sistema el cancelado se QUEDA como
 * historial (pedido del cliente, ago 2026); en GOOGLE no: su evento se BORRA.
 */
export const CANCELADO_COLOR: string = SEMAFORO.CANCELADO;
/** Azul del descanso de piloto (un evento por día de descanso). */
export const DESCANSO_COLOR: string = SEMAFORO.DESCANSO;

/**
 * LEYENDA CANÓNICA: los 5 renglones, en este orden y con estos textos. Panel y
 * app la copian tal cual (el panel en `lib/admin/calendario-semaforo.ts`, la
 * app en `calendario_flota_screen.dart`). Vive aquí para que el texto y el hex
 * no puedan separarse.
 */
export const LEYENDA_SEMAFORO: ReadonlyArray<{
  readonly color: string;
  readonly etiqueta: string;
}> = [
  { color: SEMAFORO.TENTATIVO, etiqueta: 'Tentativo' },
  { color: SEMAFORO.CONFIRMADO, etiqueta: 'Confirmado' },
  { color: SEMAFORO.PENDIENTE, etiqueta: 'Permiso o asunto pendiente' },
  { color: SEMAFORO.CANCELADO, etiqueta: 'Cancelado' },
  { color: SEMAFORO.DESCANSO, etiqueta: 'Descanso 💤' },
] as const;

/** Nota al pie de la leyenda (misma redacción en panel y app). */
export const NOTA_COLOR_AVION =
  'El color de cada avión ya no se usa en el calendario: se conserva para los reportes de Excel (balance individual y general).';

/**
 * Estados del vuelo ANTERIORES a CONFIRMADO (enum `public.estado_vuelo`, en su
 * orden real: RESERVA → SOLICITUD → COTIZADO → CONFIRMADO → EN_VUELO →
 * COMPLETADO → CANCELADO). Todos son TENTATIVOS: un espacio apartado o una
 * cotización sin cerrar no es un vuelo firme.
 */
export const ESTADOS_TENTATIVOS: readonly string[] = [
  'RESERVA',
  'SOLICITUD',
  'COTIZADO',
];

/**
 * Estados EN FIRME (verde). Se listan para documentar la frontera; el color
 * NO se decide por pertenencia a esta lista sino por descarte, para que un
 * estado nuevo del enum nunca se quede sin color.
 */
export const ESTADOS_CONFIRMADOS: readonly string[] = [
  'CONFIRMADO',
  'EN_VUELO',
  'COMPLETADO',
];

/** ¿El estado es TENTATIVO (gris)? */
export function esEstadoTentativo(estado?: string | null): boolean {
  return estado != null && ESTADOS_TENTATIVOS.includes(estado);
}

/** Entradas de `colorVueloSistema` (todas opcionales: lo ausente es "no"). */
export interface ParamsColorVuelo {
  /** Estado del VUELO (`RESERVA`, `CONFIRMADO`, `CANCELADO`…). */
  estado?: string | null;
  /**
   * Cancelado EFECTIVO: el vuelo está CANCELADO **o** el tramo que se pinta
   * tiene `cancelada_at`. Sin pasarlo se deriva de `estado`.
   */
  cancelado?: boolean | null;
  esExterno?: boolean | null;
  /** Avión del TRAMO con herencia del vuelo (null = falta asignar). */
  aeronaveId?: string | null;
  /** Piloto del TRAMO con herencia del vuelo (null = falta asignar). */
  pilotoId?: string | null;
  /** `estado_permiso === 'pendiente'` del tramo (o del vuelo si no hay tramo). */
  permisoPendiente?: boolean | null;
  /**
   * @deprecated Desde el 22-sep-2026 el color del avión NO entra a ningún
   * calendario: `aeronave.color_calendario` quedó SOLO para los reportes de
   * Excel. El campo se conserva para no romper llamadores, pero se IGNORA.
   */
  colorAvion?: string | null;
}

/**
 * ¿Vuelo propio CONFIRMADO al que le falta avión o piloto? Semántica INTACTA
 * (la respuesta de `GET /calendar` la sigue exponiendo como `sin_asignar` y la
 * app la usa para su etiqueta «⚠ sin asignar»); lo que cambió es el color con
 * el que se pinta: ya no es un morado propio, es el AMARILLO de «asunto
 * pendiente», junto con el permiso de pista.
 */
export function vueloSinAsignar(p: ParamsColorVuelo): boolean {
  return (
    p.estado === 'CONFIRMADO' && !p.esExterno && (!p.aeronaveId || !p.pilotoId)
  );
}

/**
 * ¿El vuelo tiene un ASUNTO PENDIENTE (amarillo)? Hoy son dos y los dos
 * viajaban ya en la respuesta del calendario:
 *  - permiso de pista PENDIENTE (`estado_permiso`), y
 *  - falta avión o piloto (`vueloSinAsignar`).
 * Cualquier bandera nueva de «pendiente» se suma AQUÍ, no en el color.
 */
export function vueloPendiente(p: ParamsColorVuelo): boolean {
  return p.permisoPendiente === true || vueloSinAsignar(p);
}

/**
 * Color del semáforo para UN evento de vuelo (vuelo completo o tramo, propio o
 * EXTERNO — el externo ya no tiene color propio: se pinta por su estado como
 * cualquier otro). Precedencia ÚNICA, de arriba hacia abajo:
 *
 *   cancelado (rojo) > tentativo (gris) > pendiente (amarillo) > confirmado (verde)
 *
 * El cancelado domina (es historial) y el tentativo va antes que los
 * pendientes porque un espacio apartado no es un vuelo firme: sus pendientes
 * no se anuncian todavía. Lo que no cae en ningún cubo anterior está EN FIRME.
 */
export function colorVueloSistema(p: ParamsColorVuelo): string {
  const cancelado = p.cancelado ?? p.estado === 'CANCELADO';
  if (cancelado) return SEMAFORO.CANCELADO;
  if (esEstadoTentativo(p.estado)) return SEMAFORO.TENTATIVO;
  if (vueloPendiente(p)) return SEMAFORO.PENDIENTE;
  return SEMAFORO.CONFIRMADO;
}

/**
 * Color de un mantenimiento con fecha: SIEMPRE amarillo, tanto PROGRAMADO
 * como EN_TALLER — un servicio es un «asunto pendiente» hasta que se
 * completa (y el COMPLETADO ni siquiera se pinta: el calendario lo omite y en
 * Google su evento se borra). El parámetro se conserva para no romper
 * llamadores y porque el ESTADO sigue decidiendo el título («🔧 Servicio» vs
 * «🔧 En taller»); el color ya no depende de él.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- se conserva a propósito: ver el comentario de arriba.
export function colorMantenimientoSistema(_enTaller?: boolean): string {
  return SEMAFORO.PENDIENTE;
}

/**
 * Color de un evento NO-vuelo de la flota (lavado, trámite, visita): VERDE.
 * Es una cita agendada, o sea algo EN FIRME; lo que lo distingue de un vuelo
 * es el ícono 📌 y el título, no el color. `evento_flota` no tiene estado
 * CANCELADO (se borra), así que nunca hay un evento rojo: si algún día se
 * agrega esa columna, el rojo se decide aquí.
 *
 * El color del avión se IGNORA (antes mandaba): `aeronave.color_calendario`
 * salió de los calendarios el 22-sep-2026.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- se conserva a propósito: ver el comentario de arriba.
export function colorEventoFlotaSistema(_colorAvion?: string | null): string {
  return SEMAFORO.CONFIRMADO;
}
