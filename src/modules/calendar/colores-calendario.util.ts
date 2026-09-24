/**
 * SEMÁFORO DEL CALENDARIO — PALETA ÚNICA DE 6 COLORES (24-sep-2026; era de 5
 * desde el 22-sep-2026).
 *
 * Pedido literal del cliente (22-sep-2026): «queremos hacer un cambio en el
 * semáforo del calendario, tanto en este calendario del sistema web y la app
 * como en google calendar con la sincronización, para que en los calendarios
 * no se vean tantos colores […] los colores que tiene cada avión configurados
 * los seguiremos respetando principalmente en los reportes del balance
 * individual y general en los excel que se generan, y es que en realidad los
 * colores son para el reporte de excel nada más».
 *
 * Ajuste del 24-sep-2026: «Ale quiere cambiar el color del descanso y agregar
 * el de cobrado (este me imagino se cambiaría en automático cuando ya esté
 * cobrado). Para que no haya confusiones pongo la listita»:
 *
 *   Gris     — Tentativo
 *   Amarillo — Pendiente (permiso)
 *   Verde    — Confirmado
 *   Azul     — Pagado          (NUEVO: el azul que antes era del descanso)
 *   Rojo     — Cancelado
 *   Morado   — Descanso 💤     (antes azul)
 *
 * «Pagado» = el vuelo quedó COBRADO COMPLETO: `vuelo.cobrado`, la bandera que
 * mantiene `FlightsService.refreshCobradoFlag` con `cobrosEnUsd`
 * (`monto_total > 0 && cobrado ≥ total − 1`). Nadie lo marca a mano: se pinta
 * solo al registrar el cobro que liquida el vuelo y vuelve a verde si ese
 * cobro se borra o se reembolsa (ver `vueloPagado`).
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
 * - `google-evento.util` traduce ESTOS 6 hex a 6 colorId DISTINTOS de Google
 *   (antes 18 cosas se repartían 11 colores y había 6 colisiones).
 * - El azul #3B82F6 CAMBIÓ DE DUEÑO el 24-sep-2026: era del descanso y ahora
 *   es del PAGADO. Cualquier lector que todavía diga «azul = descanso» está
 *   mal: el descanso es MORADO #8B5CF6.
 *
 * Regla que se conserva del 12-sep-2026: NADIE vuelve a escribir un hex de
 * calendario suelto en un servicio. Si el cliente quiere otro color, se cambia
 * ACÁ y el sistema, la app y Google se mueven juntos.
 */

/**
 * Los SEIS colores del semáforo. Es la fuente única: panel y app espejan
 * estos hex EXACTOS en su leyenda (no los recalculan ni los aproximan).
 */
export const SEMAFORO = {
  /** Gris — tentativo: todo estado ANTERIOR a CONFIRMADO. */
  TENTATIVO: '#64748B',
  /**
   * Amarillo — pendiente: permiso de pista pendiente o vuelo sin avión/piloto
   * asignado (incluye el mantenimiento).
   */
  PENDIENTE: '#F59E0B',
  /** Verde — confirmado: el vuelo (o la cita) está en firme. */
  CONFIRMADO: '#22C55E',
  /**
   * Azul — pagado (24-sep-2026): vuelo en firme y COBRADO COMPLETO
   * (`vuelo.cobrado`). Es el azul que hasta el 24-sep era del descanso.
   */
  PAGADO: '#3B82F6',
  /** Rojo — cancelado. */
  CANCELADO: '#EF4444',
  /** Morado — descanso de piloto 💤 (24-sep-2026; antes azul). */
  DESCANSO: '#8B5CF6',
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
/** Azul del PAGADO: vuelo cobrado completo (`vuelo.cobrado`, 24-sep-2026). */
export const PAGADO_COLOR: string = SEMAFORO.PAGADO;
/**
 * Rojo del cancelado. En el calendario del sistema el cancelado se QUEDA como
 * historial (pedido del cliente, ago 2026); en GOOGLE no: su evento se BORRA.
 */
export const CANCELADO_COLOR: string = SEMAFORO.CANCELADO;
/** Morado del descanso de piloto (un evento por día de descanso). */
export const DESCANSO_COLOR: string = SEMAFORO.DESCANSO;

/**
 * Tooltip del renglón «Pendiente (permiso)» (misma redacción en panel y app).
 * El amarillo NO es solo el permiso: `vueloPendiente` también lo prende cuando
 * a un vuelo CONFIRMADO le falta avión o piloto.
 */
export const AYUDA_PENDIENTE =
  'Permiso de pista pendiente. También se pinta así el vuelo confirmado que todavía no tiene avión o piloto asignado.';

/**
 * LEYENDA CANÓNICA: los 6 renglones, en el ORDEN EXACTO de la lista del
 * cliente (24-sep-2026) y con estos textos. Panel y app la copian tal cual
 * (el panel en `lib/admin/calendario-semaforo.ts`, la app en
 * `core/theme/semaforo_calendario.dart`). Vive aquí para que el texto y el
 * hex no puedan separarse.
 *
 * `ayuda` es el tooltip / `title` del renglón: hoy solo lo lleva «Pendiente
 * (permiso)», porque el amarillo también cubre al vuelo CONFIRMADO al que le
 * falta avión o piloto, y la etiqueta del cliente solo dice «permiso».
 */
export const LEYENDA_SEMAFORO: ReadonlyArray<{
  readonly color: string;
  readonly etiqueta: string;
  readonly ayuda?: string;
}> = [
  { color: SEMAFORO.TENTATIVO, etiqueta: 'Tentativo' },
  {
    color: SEMAFORO.PENDIENTE,
    etiqueta: 'Pendiente (permiso)',
    ayuda: AYUDA_PENDIENTE,
  },
  { color: SEMAFORO.CONFIRMADO, etiqueta: 'Confirmado' },
  { color: SEMAFORO.PAGADO, etiqueta: 'Pagado' },
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
   * `vuelo.cobrado` (24-sep-2026): el vuelo está COBRADO COMPLETO. Es la
   * bandera que mantiene `FlightsService.refreshCobradoFlag` con
   * `cobrosEnUsd`; aquí NO se recalcula (fuente única). Es a nivel VUELO: todos
   * sus tramos la comparten. Ausente = no pagado.
   */
  cobrado?: boolean | null;
  /**
   * `vuelo.monto_total_usd`: CINTURÓN del «$0 nunca es pagado». La bandera ya
   * lo garantiza (`monto_total > 0 && …`), pero si algún día una fila vieja
   * trae `cobrado = true` con total $0 (cliente interno, vuelo sin cotizar) el
   * semáforo no la pinta de azul. Ausente = se confía en `cobrado`.
   */
  montoTotalUsd?: number | string | null;
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
 * ¿El vuelo está PAGADO (azul, 24-sep-2026)? = `vuelo.cobrado === true` y,
 * si el llamador manda el total, que ese total sea > 0 (un vuelo en $0 o de
 * cliente interno NUNCA es pagado: no hay nada que cobrar).
 *
 * Solo dice «está cobrado completo»; si el azul GANA o no lo decide la
 * precedencia de `colorVueloSistema` (un cancelado, un tentativo o un
 * pendiente se ven con SU color aunque estén pagados).
 */
export function vueloPagado(p: ParamsColorVuelo): boolean {
  if (p.cobrado !== true) return false;
  if (p.montoTotalUsd == null || p.montoTotalUsd === '') return true;
  const total = Number(p.montoTotalUsd);
  return Number.isFinite(total) && total > 0;
}

/**
 * Color del semáforo para UN evento de vuelo (vuelo completo o tramo, propio o
 * EXTERNO — el externo ya no tiene color propio: se pinta por su estado como
 * cualquier otro). Precedencia ÚNICA, de arriba hacia abajo (24-sep-2026):
 *
 *   cancelado (rojo) > tentativo (gris) > pendiente (amarillo)
 *     > PAGADO (azul) > confirmado (verde)
 *
 * El cancelado domina (es historial) y el tentativo va antes que los
 * pendientes porque un espacio apartado no es un vuelo firme: sus pendientes
 * no se anuncian todavía. El PAGADO va DESPUÉS del pendiente a propósito: un
 * vuelo cobrado con el permiso de pista sin resolver se ve AMARILLO hasta que
 * alguien lo resuelva — el pendiente operativo nunca se esconde detrás del
 * dinero. Y una RESERVA pagada por adelantado sigue gris (no está en firme).
 * Lo que no cae en ningún cubo anterior está EN FIRME (verde).
 */
export function colorVueloSistema(p: ParamsColorVuelo): string {
  const cancelado = p.cancelado ?? p.estado === 'CANCELADO';
  if (cancelado) return SEMAFORO.CANCELADO;
  if (esEstadoTentativo(p.estado)) return SEMAFORO.TENTATIVO;
  if (vueloPendiente(p)) return SEMAFORO.PENDIENTE;
  if (vueloPagado(p)) return SEMAFORO.PAGADO;
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
