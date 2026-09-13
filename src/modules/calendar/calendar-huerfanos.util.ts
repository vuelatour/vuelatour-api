/**
 * PASO INVERSO del espejo sistema → Google Calendar (D12, 12-sep-2026):
 * piezas PURAS para decidir qué evento de Google es un HUÉRFANO y hay que
 * borrar.
 *
 * POR QUÉ EXISTE: hasta hoy el reconcile nocturno solo mira FILAS VIVAS de la
 * BD y les re-publica su evento. Un evento que quedó en Google SIN fila que lo
 * apunte es INVISIBLE para él y se queda ahí para siempre, ensuciando el
 * calendario de la oficina («vuelos fantasma»). Pasa cuando Google estaba
 * caído al borrar/cancelar, cuando un `insert` se duplicó por una carrera, o
 * con cualquier borrado hecho por SQL antes de que existieran los triggers de
 * la cola.
 *
 * REGLAS SAGRADAS (pedido del cliente C7: los eventos que la oficina captura
 * A MANO en ese calendario NO se tocan):
 * 1. Sin `extendedProperties.private.vuelatour_*` ⇒ **JAMÁS se toca**. Es de
 *    la oficina.
 * 2. Con ancla y con la fila viva que apunta a ESE id ⇒ se conserva.
 * 3. Con ancla y sin fila (borrada) ⇒ se borra.
 * 4. Con ancla, fila viva, pero la fila apunta a OTRO id ⇒ DUPLICADO fantasma
 *    ⇒ se borra (nadie lo iba a actualizar nunca más).
 * 5. Si NO se pudo verificar contra la BD (consulta con error, lectura que
 *    pudo venir truncada, id que no es un UUID) ⇒ **no se borra nada**. Ante
 *    la duda, el evento se queda: un evento de más es ruido; un evento
 *    borrado por error es información perdida del calendario del cliente.
 * 6. Un evento CREADO hace menos de `HUERFANOS_EDAD_MINIMA_MS` tampoco se
 *    borra: puede ser un evento legítimo cuyo id todavía no alcanzó a
 *    guardarse en su fila (ver `esRecienCreado`).
 */

/** Ancla del vuelo (la llevan los eventos de ida/regreso y los de tramo). */
export const ANCLA_VUELO = 'vuelatour_vuelo_id';
/** Ancla del descanso de piloto (se empezó a escribir el 12-sep-2026, D12). */
export const ANCLA_DESCANSO = 'vuelatour_descanso_id';
/** Ancla del evento NO-vuelo de la flota. */
export const ANCLA_EVENTO = 'vuelatour_evento_id';
/** Ancla del mantenimiento. */
export const ANCLA_MANTENIMIENTO = 'vuelatour_mantenimiento_id';

export type TipoAnclaCalendar =
  | 'vuelo'
  | 'descanso'
  | 'evento'
  | 'mantenimiento';

/** Ancla ⇄ tipo de entidad. El orden es el de búsqueda (irrelevante hoy: */
/** ningún evento nuestro lleva dos anclas). */
export const ANCLAS_CALENDAR: ReadonlyArray<{
  readonly tipo: TipoAnclaCalendar;
  readonly propiedad: string;
}> = [
  { tipo: 'vuelo', propiedad: ANCLA_VUELO },
  { tipo: 'descanso', propiedad: ANCLA_DESCANSO },
  { tipo: 'evento', propiedad: ANCLA_EVENTO },
  { tipo: 'mantenimiento', propiedad: ANCLA_MANTENIMIENTO },
] as const;

/** Lo mínimo que se le pide a `events.list` para clasificar un evento. */
export interface EventoGoogleMinimo {
  id?: string | null;
  summary?: string | null;
  /**
   * `created` de Google (RFC3339). Se pide para NO borrar un evento recién
   * nacido: ver `esRecienCreado`. Ausente (Google no lo devolvió) = se trata
   * como viejo, que es el comportamiento de siempre.
   */
  created?: string | null;
  extendedProperties?: {
    private?: { [clave: string]: string } | null;
  } | null;
}

/** Evento de Google que NACIÓ en VuelaTour (tiene ancla). */
export interface EventoSistemaGoogle {
  eventId: string;
  tipo: TipoAnclaCalendar;
  entidadId: string;
  summary: string | null;
  /** `created` de Google en ms (null = Google no lo devolvió). */
  creadoMs: number | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ¿Es un UUID? Un id que no lo es NO se puede consultar en la BD. */
export function esUuidCalendar(valor: string): boolean {
  return UUID_RE.test(valor.trim());
}

/**
 * ¿Este evento de Google es nuestro? `null` = NO (evento manual de la
 * oficina, o sin id) ⇒ el paso inverso ni lo mira.
 */
export function clasificarEventoSistema(
  ev: EventoGoogleMinimo | null | undefined,
): EventoSistemaGoogle | null {
  const eventId = typeof ev?.id === 'string' ? ev.id.trim() : '';
  if (!eventId) return null;
  const props = ev?.extendedProperties?.private;
  if (!props || typeof props !== 'object') return null;
  for (const { tipo, propiedad } of ANCLAS_CALENDAR) {
    const crudo = props[propiedad];
    const entidadId = typeof crudo === 'string' ? crudo.trim() : '';
    if (entidadId !== '') {
      const creado =
        typeof ev?.created === 'string' ? Date.parse(ev.created) : NaN;
      return {
        eventId,
        tipo,
        entidadId,
        summary: typeof ev?.summary === 'string' ? ev.summary : null,
        creadoMs: Number.isFinite(creado) ? creado : null,
      };
    }
  }
  return null;
}

/**
 * Qué hacer con un evento del sistema:
 * - `conservar`: la fila viva apunta a este evento;
 * - `borrar_fila_inexistente`: la entidad ya no existe en la BD;
 * - `borrar_duplicado`: la entidad existe pero apunta a OTRO evento;
 * - `no_verificable`: no se pudo comprobar (id no-UUID o consulta con error)
 *   ⇒ NO se toca.
 */
export type DecisionHuerfano =
  | 'conservar'
  | 'borrar_fila_inexistente'
  | 'borrar_duplicado'
  | 'no_verificable';

/**
 * Decide con lo leído de la BD (PURO).
 *
 * @param verificados ids de entidad cuya consulta a la BD SÍ respondió. Un id
 *   fuera de este conjunto = no se pudo verificar.
 * @param vivos entidadId → ids de eventos de Google que sus filas apuntan
 *   (vuelo: el de la ida, el del regreso y el de cada tramo). Sin entrada =
 *   la fila NO existe.
 */
export function decidirHuerfano(
  ev: EventoSistemaGoogle,
  verificados: ReadonlySet<string>,
  vivos: ReadonlyMap<string, ReadonlySet<string>>,
): DecisionHuerfano {
  if (!esUuidCalendar(ev.entidadId)) return 'no_verificable';
  if (!verificados.has(ev.entidadId)) return 'no_verificable';
  const apuntados = vivos.get(ev.entidadId);
  if (!apuntados) return 'borrar_fila_inexistente';
  return apuntados.has(ev.eventId) ? 'conservar' : 'borrar_duplicado';
}

/**
 * Ids por lote para los `in (...)` de la BD (nunca N+1, nunca un IN gigante).
 *
 * 150, no 200 (revisión adversaria 12-sep-2026): un uuid pesa ~37 bytes en la
 * URL de PostgREST y por encima de ~150 la petición revienta (mismo tope que
 * `DELTA_MAX_IDS_TRAMO` en `flights.service`). Con 200 el lote respondía 414 y
 * el paso inverso se quedaba SIN verificar ese lote — sin borrar nada (la
 * regla «ante la duda no se borra» aguantaba), pero la red de seguridad no
 * servía para nada en un calendario con volumen.
 */
export const LOTE_IDS_BD = 150;

/** `maxResults` de `events.list` (el máximo que acepta Google es 2500). */
export const HUERFANOS_PAGINA_MAX = 2500;

/** Tope de páginas por pasada: 40 × 2500 = 100 000 eventos. Cinturón. */
export const HUERFANOS_PAGINAS_TOPE = 40;

/**
 * Tope de BORRADOS por pasada. Cinturón de seguridad del calendario del
 * cliente: si una pasada quisiera borrar más de esto, algo está mal en
 * nuestras premisas (no en Google) — se para, se avisa y se revisa a mano.
 * Un reconcile normal borra 0.
 */
export const HUERFANOS_BORRADO_TOPE = 500;

/**
 * Margen de gracia por EDAD del evento en Google (revisión adversaria
 * 12-sep-2026). Un evento que Google creó hace segundos puede ser un evento
 * LEGÍTIMO cuyo id todavía no alcanzó a guardarse en su fila: el hook que lo
 * insertó escribe `google_calendar_id` un instante después (y cuando la cola
 * no está activa, los ~30 hooks escriben DIRECTO a Google en cualquier
 * momento, también durante la media hora que dura el reconcile). Si el paso
 * inverso lo lee en ese hueco, la fila apunta a `null` ⇒ lo tomaría por
 * duplicado fantasma y BORRARÍA un evento vivo.
 *
 * Un huérfano de verdad nunca es nuevo: esperar a la noche siguiente no cuesta
 * nada. 15 min cubren de sobra el hueco insert→update.
 */
export const HUERFANOS_EDAD_MINIMA_MS = 15 * 60_000;

/**
 * ¿El evento es tan nuevo que todavía podría estar guardándose su id? (PURO)
 * Sin `created` (Google no lo mandó) la respuesta es `false`: el
 * comportamiento de siempre.
 */
export function esRecienCreado(
  creadoMs: number | null,
  ahoraMs: number,
  margenMs = HUERFANOS_EDAD_MINIMA_MS,
): boolean {
  if (creadoMs == null) return false;
  return ahoraMs - creadoMs < margenMs;
}

/** Parte una lista en lotes de `tamano` (PURO). */
export function lotesDe<T>(lista: readonly T[], tamano = LOTE_IDS_BD): T[][] {
  const n = Math.max(1, Math.trunc(tamano));
  const salida: T[][] = [];
  for (let i = 0; i < lista.length; i += n) {
    salida.push(lista.slice(i, i + n));
  }
  return salida;
}
