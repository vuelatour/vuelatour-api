/**
 * AVIÓN QUE QUEDA EN `vuelo.aeronave_id` AL REVISAR UNA COTIZACIÓN — fuente
 * única compartida por `quotes.revise()`, `quickAdjust()` y el quote-like de
 * la vista previa (si divergen, la hoja muestra un avión y se guarda otro).
 *
 * HISTORIA (bug cotización #254, 11-sep-2026): la regla anterior era
 * «el avión del primer tramo ACTIVO manda SIEMPRE sobre el del cotizador».
 * Nació del caso #80 (cotizado en XA-VGV, volado en N990GG: registrar un
 * cobro —que pasa por `quickAdjust` → `revise`— regresaba el vuelo al avión
 * de la cotización). Pero como el cotizador del panel rehidrata su default
 * desde `vuelo.aeronave_id`, esa regla también se tragaba el cambio
 * DELIBERADO del operador: se guardaba la versión nueva con el avión nuevo
 * en el snapshot/historial, `vuelo.aeronave_id` seguía en el avión viejo, el
 * formulario volvía a abrir con el viejo y CADA versión repetía el mismo
 * diff «Avión PIPER SENECA V→…» mientras la hoja seguía diciendo
 * «Aeronave cotizada: PIPER SENECA V».
 *
 * LA COTIZACIÓN ES INDEPENDIENTE DE LA OPERACIÓN (cliente, 12-sep-2026,
 * cotización #298): «se cotiza con un avión y se vuela con otro por distintos
 * motivos, pero la cotización no debe verse afectada por cambios en el vuelo
 * operativo». El avión COTIZADO es el del SNAPSHOT vigente
 * (`calculo_snapshot.aeronave.id`); el OPERATIVO es `vuelo.aeronave_id` /
 * los tramos. Por eso el cotizador del panel rehidrata su selector desde el
 * COTIZADO y esta regla compara contra el COTIZADO, no contra el operativo:
 * antes, con el vuelo reasignado a otro avión, guardar una versión SIN tocar
 * el selector se leía como «cambio deliberado» y REASIGNABA el vuelo al avión
 * de la cotización (regresión del caso #80).
 *
 * REGLA (12-sep-2026):
 * - `cambio_deliberado` = el DTO trae un avión DISTINTO del COTIZADO (o del
 *   operativo si aún no hay snapshot) ⇒ el operador eligió OTRO avión en el
 *   cotizador: manda y se persiste (el vuelo y sus tramos vivos se mueven con
 *   el blanket SELECTIVO de siempre, previo pre-check de `assign`).
 * - Sin cambio deliberado ⇒ `vuelo.aeronave_id` conserva el OPERATIVO
 *   (`tramo ?? vuelo ?? dto`) y el PRECIO se calcula con el avión del DTO
 *   (= el cotizado) — caso #80 y caso #298 a la vez.
 * - GUARDA: un DTO que re-envía el avión que YA opera el vuelo no es una
 *   asignación nueva (no hay nada que asignar, el vuelo ya está en él): no
 *   cuenta como cambio deliberado, así que no dispara pre-check de squawk ni
 *   blanket a tramos. Sin ella, un panel viejo —que rehidrataba desde
 *   `vuelo.aeronave_id`— empezaría a rebotar 409 por un squawk ALTA del avión
 *   que el vuelo ya está volando.
 * - `conservarOperativo` (quickAdjust y toda revisión que NO nace del
 *   cotizador): el operativo manda SIEMPRE, aunque el DTO traiga otro avión
 *   (quickAdjust re-envía a propósito el avión del SNAPSHOT para no mover el
 *   precio; eso jamás debe reasignar el vuelo).
 * - `yaVolo` (24-sep-2026, cotización #338): el vuelo YA VOLÓ (EN_VUELO,
 *   COMPLETADO o algún tramo vivo con tacómetro — `estadoVueloVolado`) ⇒ un
 *   avión distinto en el cotizador es SOLO COMERCIAL: el PRECIO y el
 *   snapshot siguen al avión del DTO («se cobra como Cessna»), pero el vuelo
 *   conserva el avión con el que VOLÓ (primer tramo vivo; respaldo la
 *   cabecera — JAMÁS el del DTO), no hay cambio deliberado (ni pre-check de
 *   squawk/taller, ni blanket a tramos, ni push de «cambio de avión») y
 *   `cambio_solo_comercial` avisa a la oficina. Antes, #338 (cotizado y
 *   volado en N4142R, COMPLETADO) se recotizó «como Cessna» y la revisión lo
 *   leyó como asignación: la cabecera pasó a XA-VGV con los tramos (tacos,
 *   horas, gastos) en N4142R —la lista, la app y la «aeronave utilizada»
 *   decían XA-VGV— y el piloto y el copiloto recibieron «Ahora vuela en
 *   XA-VGV» de un vuelo que ya había aterrizado.
 *
 * Puro: no toca BD ni muta nada.
 */

export interface AeronaveRevisionInput {
  /** Avión que manda el DTO de revisión (referencia de tarifa del motor). */
  aeronaveDto?: string | null;
  /** `vuelo.aeronave_id` persistido = el avión OPERATIVO de hoy. */
  aeronaveVuelo?: string | null;
  /**
   * Avión COTIZADO = `calculo_snapshot.aeronave.id` del snapshot VIGENTE (lo
   * que el cotizador del panel muestra en su selector). Sin snapshot (reserva
   * recién creada) se compara contra el operativo, como antes.
   */
  aeronaveCotizada?: string | null;
  /** Avión del primer tramo VIVO (asignación por tramo); null = hereda. */
  aeronavePrimerTramoActivo?: string | null;
  /** true = revisión que NO nace del cotizador (quickAdjust): no reasigna. */
  conservarOperativo?: boolean;
  /**
   * true = el vuelo YA VOLÓ (`estadoVueloVolado(...).ya_volo`): el avión del
   * DTO solo cambia con qué se COBRA; la operación no se toca.
   */
  yaVolo?: boolean;
}

export interface AeronaveRevisionResultado {
  /** Avión que se escribe en `vuelo.aeronave_id` (null = sin avión). */
  aeronave_id: string | null;
  /** true = el operador cambió el avión desde el cotizador. */
  cambio_deliberado: boolean;
  /**
   * Avión anterior del vuelo cuando hubo cambio deliberado (el blanket
   * selectivo solo pisa tramos heredados —null— o de ESTE avión). null si no
   * hay cambio o el vuelo no tenía avión.
   */
  aeronave_anterior: string | null;
  /**
   * true = el vuelo YA VOLÓ y el cotizador eligió un avión distinto del
   * COTIZADO: el cambio queda SOLO en el precio/snapshot (se cobra con él) y
   * la revisión lo avisa (`avisoAvionSoloComercial`). Nunca con
   * `conservarOperativo` (esas revisiones no nacen del selector).
   */
  cambio_solo_comercial: boolean;
}

const limpio = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v : null;

/**
 * Avión COTIZADO de un vuelo persistido: el id del avión del SNAPSHOT
 * vigente. A diferencia de `modeloCotizadoDe` (presentación al cliente, que
 * oculta la referencia de tarifa de un externo), aquí el externo SÍ devuelve
 * su referencia: es con la que se pactó el precio y con la que el cotizador
 * rehidrata su selector.
 */
export function idAeronaveCotizada(calculoSnapshot: unknown): string | null {
  const snap = calculoSnapshot as { aeronave?: { id?: unknown } | null } | null;
  return limpio(snap?.aeronave?.id);
}

export function resolverAeronaveDeRevision(
  input: AeronaveRevisionInput,
): AeronaveRevisionResultado {
  const dto = limpio(input.aeronaveDto);
  const vuelo = limpio(input.aeronaveVuelo);
  const cotizada = limpio(input.aeronaveCotizada);
  const tramo = limpio(input.aeronavePrimerTramoActivo);
  // Contra qué se compara el selector del cotizador: el COTIZADO manda; sin
  // snapshot (reserva sin cotizar) queda el operativo, como antes.
  const referencia = cotizada ?? vuelo;
  const conservar = input.conservarOperativo === true;
  // YA VOLÓ (#338): el avión del DTO es SOLO la referencia de cobro. El vuelo
  // conserva el avión con el que voló — el del primer tramo vivo (la
  // cabecera espeja la ida), respaldo la cabecera — y NUNCA cae al del DTO:
  // eso sería asignar un avión a un vuelo que ya aterrizó.
  if (input.yaVolo === true) {
    return {
      aeronave_id: tramo ?? vuelo,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: !conservar && dto != null && dto !== referencia,
    };
  }
  const cambioDeliberado =
    !conservar && dto != null && dto !== referencia && dto !== vuelo;
  if (cambioDeliberado) {
    return {
      aeronave_id: dto,
      cambio_deliberado: true,
      aeronave_anterior: vuelo,
      cambio_solo_comercial: false,
    };
  }
  return {
    aeronave_id: tramo ?? vuelo ?? dto,
    cambio_deliberado: false,
    aeronave_anterior: null,
    cambio_solo_comercial: false,
  };
}

// ---------------------------------------------------------------------------
// VUELO QUE YA VOLÓ (24-sep-2026, cotización #338)
// ---------------------------------------------------------------------------

/** Tramo mínimo para decidir si el vuelo ya voló (lectura de `escala`). */
export interface TramoVoladoInput {
  orden?: unknown;
  taco_salida?: unknown;
  taco_llegada?: unknown;
  cancelada_at?: unknown;
}

export interface EstadoVueloVolado {
  /**
   * El viaje YA ARRANCÓ: estado EN_VUELO o COMPLETADO, o algún tramo VIVO
   * con tacómetro capturado. Con esto el avión del cotizador es solo
   * comercial y la fecha de SALIDA ya no se mueve desde la cotización.
   */
  ya_volo: boolean;
  /**
   * El viaje YA TERMINÓ: COMPLETADO, o el ÚLTIMO tramo vivo ya tiene
   * tacómetro. Con esto tampoco se mueve la fecha de REGRESO ni se avisa a
   * la tripulación (reagenda, pernocta, itinerario) — un viaje de varios días
   * a medio camino (EN_VUELO, regreso pendiente) sí sigue avisando del
   * regreso, que todavía no vuela.
   */
  termino: boolean;
}

const conTaco = (t: TramoVoladoInput): boolean =>
  t.taco_salida != null || t.taco_llegada != null;

/**
 * Fuente única de «¿este vuelo ya voló?» para la revisión de la cotización
 * (revise y la vista previa). Solo cuentan los tramos VIVOS (un tramo
 * cancelado con evidencia no hace volado al vuelo). Puro.
 */
export function estadoVueloVolado(
  estado: unknown,
  tramos: TramoVoladoInput[] | null | undefined,
): EstadoVueloVolado {
  const e = typeof estado === 'string' ? estado.toUpperCase() : '';
  const completado = e === 'COMPLETADO';
  const vivos = (tramos ?? [])
    .filter((t) => t.cancelada_at == null)
    .map((t, i) => ({ t, i }))
    .sort(
      (a, b) =>
        (Number.isFinite(Number(a.t.orden)) ? Number(a.t.orden) : a.i) -
        (Number.isFinite(Number(b.t.orden)) ? Number(b.t.orden) : b.i),
    )
    .map((x) => x.t);
  const ultimo = vivos.length > 0 ? vivos[vivos.length - 1] : null;
  return {
    ya_volo: completado || e === 'EN_VUELO' || vivos.some(conTaco),
    termino: completado || (ultimo != null && conTaco(ultimo)),
  };
}

/**
 * Texto ÚNICO del aviso de `revise.avisos[]` cuando el cotizador cambia el
 * avión de un vuelo que ya voló (el panel tiene su propia copia de la nota
 * en `avion-cotizado.ts`). `matriculas` = los aviones con los que voló
 * (tramos vivos con herencia); `modeloCobro` = el modelo con el que ahora se
 * cobra (snapshot nuevo).
 */
export function avisoAvionSoloComercial(
  matriculas: string[],
  modeloCobro: string | null | undefined,
): string {
  const lista = matriculas.filter((m) => !!m && m.trim());
  const voloEn =
    lista.length === 0
      ? ''
      : lista.length === 1
        ? ` en ${lista[0]}`
        : ` en ${lista.slice(0, -1).join(', ')} y ${lista[lista.length - 1]}`;
  const modelo = modeloCobro?.trim() ? ` (${modeloCobro.trim()})` : '';
  return `El vuelo ya voló${voloEn}: el cambio de avión solo cambia con qué se cobra${modelo}; la operación no se modifica.`;
}

// ---------------------------------------------------------------------------
// FECHAS DEL VUELO AL REVISAR (24-sep-2026, cotización #338)
// ---------------------------------------------------------------------------

/**
 * ¿Cambia la fecha? Compara por INSTANTE (el string crudo de PostgREST nunca
 * es igual al ISO del DTO). `nueva` undefined = no viajó en el DTO.
 */
export function fechaCambia(nueva: Date | undefined, actual: unknown): boolean {
  if (nueva === undefined) return false;
  if (!actual) return true;
  const t = new Date(actual as string).getTime();
  return Number.isNaN(t) || nueva.getTime() !== t;
}

export interface FechasRevisionInput {
  /** `dto.fecha_vuelo` (salida). */
  salidaDto?: Date;
  /** `dto.fecha_traslado_final` (regreso). */
  regresoDto?: Date;
  /** `vuelo.fecha_vuelo` persistido. */
  salidaActual?: unknown;
  /** `vuelo.fecha_traslado_final` persistido. */
  regresoActual?: unknown;
  volado: EstadoVueloVolado;
}

export interface FechasRevision {
  /** Fecha de salida a ESCRIBIR en `vuelo.fecha_vuelo` (undefined = no se toca). */
  salida?: Date;
  /** Fecha de regreso a ESCRIBIR en `vuelo.fecha_traslado_final`. */
  regreso?: Date;
  /** La salida se escribe Y cambia ⇒ reagenda (aviso a tripulación). */
  salida_cambio: boolean;
  /** El regreso se escribe Y cambia ⇒ reagenda del REGRESO. */
  regreso_cambio: boolean;
  /** El DTO traía otra salida pero el vuelo ya voló: se conserva (aviso). */
  salida_conservada: boolean;
  /** El DTO traía otro regreso pero el viaje ya terminó: se conserva. */
  regreso_conservada: boolean;
}

/**
 * QUÉ FECHAS DEL VUELO ESCRIBE UNA REVISIÓN — fuente única de `revise` y de
 * la vista previa.
 *
 * `vuelo.fecha_vuelo` y `vuelo.fecha_traslado_final` NO son datos solo de la
 * cotización: `fecha_vuelo` ancla el dinero al periodo (cortes Cancún) y el
 * calendario; las dos alimentan `vuelo.fecha_fin` (trigger GREATEST: eje del
 * calendario de varios días), la cola de Google Calendar (trigger sobre esas
 * columnas), el día del regreso en el balance por avión y —vía
 * `replaceEscalas`— la `fecha_salida_plan` de los tramos extremos. Y
 * `flights.update` ya no deja editar un COMPLETADO. Por eso, con el vuelo
 * VOLADO, la revisión NO las escribe (la cotización era una puerta trasera
 * para mover de mes/calendario un vuelo cerrado) y lo AVISA:
 * - salida: no se escribe si `ya_volo` (el viaje ya arrancó);
 * - regreso: no se escribe si `termino` (un viaje de varios días a medio
 *   camino sí puede reagendar su regreso, que aún no vuela).
 * Sin vuelo volado, el comportamiento es el de siempre (se escribe lo que
 * viaja en el DTO).
 */
export function resolverFechasDeRevision(
  input: FechasRevisionInput,
): FechasRevision {
  const salidaDifiere = fechaCambia(input.salidaDto, input.salidaActual);
  const regresoDifiere = fechaCambia(input.regresoDto, input.regresoActual);
  const salidaBloqueada = input.volado.ya_volo;
  const regresoBloqueado = input.volado.termino;
  return {
    salida: salidaBloqueada ? undefined : input.salidaDto,
    regreso: regresoBloqueado ? undefined : input.regresoDto,
    salida_cambio: !salidaBloqueada && salidaDifiere,
    regreso_cambio: !regresoBloqueado && regresoDifiere,
    salida_conservada: salidaBloqueada && salidaDifiere,
    regreso_conservada: regresoBloqueado && regresoDifiere,
  };
}

const fechaCancunTxt = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('es-MX', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Cancun',
  });
};

/**
 * Aviso de `revise.avisos[]` cuando el DTO traía otra fecha de un vuelo que
 * ya voló y se CONSERVÓ la del vuelo. `actual` = la fecha persistida.
 */
export function avisoFechaConservada(
  cual: 'salida' | 'regreso',
  actual: unknown,
): string {
  const txt = fechaCancunTxt(actual);
  const conserva = txt
    ? `se conserva la del vuelo: ${txt} (hora Cancún)`
    : 'el vuelo se queda sin fecha de regreso';
  return cual === 'salida'
    ? `El vuelo ya voló: la fecha de salida no se cambia desde la cotización (movería el calendario y el mes del dinero); ${conserva}.`
    : `El viaje ya terminó: la fecha de regreso no se cambia desde la cotización (movería el calendario); ${conserva}.`;
}

/**
 * ¿La revisión puede escribir `fecha_salida_plan` en este TRAMO? (revisión
 * adversaria 24-sep-2026, #338). Un tramo con tacómetro YA VOLÓ: su fecha
 * planeada es historia operativa (evento de Google, día del tramo en la app
 * y en el calendario, `fecha_fin`) y la cotización no la mueve — mismo
 * criterio que `resolverFechasDeRevision` para las fechas del VUELO, que
 * dejaba abierta esta puerta: una fecha EXPLÍCITA por tramo en el cotizador
 * (`escalas[i].fecha_salida_plan`) seguía reescribiendo el tramo volado de un
 * vuelo con `itinerario_operativo = false`. Un tramo volado SIN fecha (legado)
 * sí se completa, como siempre. El cambio se conserva solo en el snapshot.
 * Puro.
 */
export function tramoConservaFechaPlan(actual: {
  taco_salida?: unknown;
  taco_llegada?: unknown;
  fecha_salida_plan?: unknown;
}): boolean {
  return (
    (actual.taco_salida != null || actual.taco_llegada != null) &&
    actual.fecha_salida_plan != null &&
    actual.fecha_salida_plan !== ''
  );
}

/** Aviso de `revise.avisos[]` cuando la oficina movió la fecha de un tramo que ya voló. */
export function avisoFechaTramoVoladoConservada(
  orden: number,
  ruta: string,
  actual: unknown,
): string {
  const txt = fechaCancunTxt(actual);
  return `El tramo ${orden} (${ruta}) ya voló: su fecha de salida no se cambia desde la cotización (movería el calendario)${txt ? `; se conserva la del vuelo: ${txt} (hora Cancún)` : ''}.`;
}
