/**
 * TRAMOS COTIZADOS vs TRAMOS DE LA OPERACIÓN — helpers PUROS (fuente única,
 * 22-sep-2026, cotización #326).
 *
 * HISTORIA (pedido del cliente, capturas de la hoja de la #326): «antes de
 * poner el tipo de cambio está en 3596 y después de ponerlo, se cambia en
 * automático no se por que». La #326 se cotizó con `T1 CUN→PTU FERRY` +
 * `T2 PTU→CUN 2 pax` (TUAS $0 ⇒ $3,596.00); al día siguiente el PILOTO editó
 * los dos tramos desde la app (4 pax, sin ferry — cambio OPERATIVO legítimo).
 * El cotizador rehidrataba los tramos de la ESCALA VIVA, así que al teclear
 * el T.C. el motor repreciaba con 4 pax saliendo de CUN ⇒ TUA CUN $25 × 4 +
 * IVA ⇒ $3,712.00. Nadie tocó el precio y el precio se movió.
 *
 * REGLA RECTORA (cliente, 12-sep-2026, invariante 14 — ya aplicada al AVIÓN):
 * «se cotiza con un avión y se vuela con otro por distintos motivos, pero la
 * cotización no debe verse afectada por cambios en el vuelo operativo». Aquí
 * se extiende a los TRAMOS, en los DOS sentidos:
 *
 * 1. LECTURA: lo que PRECIA (origen, destino, millas, pasajeros, ferry,
 *    pernocta, tipo de parada) sale de lo COTIZADO (`calculo_snapshot`)
 *    siempre que exista snapshot. Un cambio del piloto ya no mueve el total.
 * 2. ESCRITURA: guardar la cotización NO pisa lo que capturó el piloto. En el
 *    UPDATE de `replaceEscalas` las columnas que la OPERACIÓN también puede
 *    tocar (`pasajeros`, `pasajeros_nombres`, `es_ferry`, pernocta, notas,
 *    tipo de parada) se OMITEN cuando lo que llega es IDÉNTICO a lo cotizado
 *    antes: si la oficina no lo cambió, la escala viva conserva lo suyo.
 *    Mismo patrón que `pdf_oculto`/`pdf_fecha` y `es_sobrevuelo`.
 *
 * DEFENSA CONTRA UN PANEL VIEJO (pestaña abierta, borrador en caché): el
 * panel nuevo manda `tramos_base` en `/revise`; sin ese campo, un tramo
 * entrante que es un ECO de la escala VIVA (misma ruta, mismas millas, mismos
 * pax/ferry que la operación y distintos de lo cotizado) se ANCLA a lo
 * cotizado — mismo espíritu que `esEcoDeTarifa` / `esEcoDeHorasPactadas` de
 * `anclarRevisionAlPersistido`. Una edición REAL de la oficina (un valor que
 * no coincide con la operación) jamás se ancla.
 *
 * Todo aquí es PURO: no toca BD, no muta lo que recibe (el ancla devuelve una
 * copia) y no conoce Nest.
 */

/** De dónde salieron los tramos del DTO (campo ADITIVO de `/revise`). */
export type TramosBase = 'COTIZADO' | 'OPERACION';

/**
 * Valores aceptados en el DTO. `EDITADO` es ALIAS de `COTIZADO` (el diseño lo
 * ofrecía): la decisión de escritura es POR TRAMO y por comparación contra el
 * snapshot, así que una edición manual ya queda cubierta por `COTIZADO`.
 */
export const TRAMOS_BASE_ACEPTADOS = [
  'COTIZADO',
  'OPERACION',
  'EDITADO',
] as const;

export function normalizarTramosBase(valor: unknown): TramosBase | undefined {
  if (valor === 'OPERACION') return 'OPERACION';
  if (valor === 'COTIZADO' || valor === 'EDITADO') return 'COTIZADO';
  return undefined;
}

/** Tramo COTIZADO tal como vive en el snapshot vigente. */
export interface TramoCotizado {
  orden: number;
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number;
  /** Ferry ⇒ 0 (el motor ya lo resuelve así). */
  pasajeros: number;
  pasajeros_nombres: string[];
  es_ferry: boolean;
  requiere_pernocta: boolean;
  /** 0 cuando no hay pernocta. */
  pernocta_costo_usd: number;
  tipo_parada: 'NORMAL' | 'SERVICIO';
  servicio_notas: string | null;
  notas: string | null;
}

/** Forma mínima de una escala VIVA (fila de `escala`). */
export interface TramoVivo {
  orden?: unknown;
  origen_iata?: unknown;
  destino_iata?: unknown;
  pasajeros?: unknown;
  es_ferry?: unknown;
  requiere_pernocta?: unknown;
  solo_operativa?: unknown;
  cancelada_at?: unknown;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const bool = (v: unknown): boolean => v === true;

const iata = (v: unknown): string =>
  typeof v === 'string' ? v.trim().toUpperCase() : '';

const texto = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

const parada = (v: unknown): 'NORMAL' | 'SERVICIO' =>
  v === 'SERVICIO' ? 'SERVICIO' : 'NORMAL';

const nombres = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((n) => (typeof n === 'string' ? n.trim() : ''))
        .filter((n) => n.length > 0)
    : [];

/** `calculo_snapshot.ruta.escalas[i]` (ResolvedLeg) → TramoCotizado. */
function desdeEscalaDelSnapshot(
  e: Record<string, unknown>,
  i: number,
): TramoCotizado | null {
  const origen = iata(e.origen_iata);
  const destino = iata(e.destino_iata);
  if (!origen || !destino) return null;
  const esFerry = bool(e.es_ferry);
  const pernocta = bool(e.requiere_pernocta);
  return {
    orden: i + 1,
    origen_iata: origen,
    destino_iata: destino,
    millas_nauticas: num(e.millas_nauticas),
    pasajeros: esFerry ? 0 : num(e.pasajeros),
    pasajeros_nombres: esFerry ? [] : nombres(e.pasajeros_nombres),
    es_ferry: esFerry,
    requiere_pernocta: pernocta,
    pernocta_costo_usd: pernocta ? num(e.pernocta_costo_usd) : 0,
    tipo_parada: parada(e.tipo_parada),
    servicio_notas: texto(e.servicio_notas),
    notas: texto(e.notas),
  };
}

/**
 * `calculo_snapshot.tramos[i]` → TramoCotizado (RESPALDO). Nombres de campo
 * distintos (`origen`/`destino`/`millas`/`pernocta_usd`) y SIN manifiesto:
 * el desglose por tramo nunca guardó `pasajeros_nombres` ni `notas`.
 */
function desdeTramoDelSnapshot(
  t: Record<string, unknown>,
  i: number,
): TramoCotizado | null {
  const origen = iata(t.origen ?? t.origen_iata);
  const destino = iata(t.destino ?? t.destino_iata);
  if (!origen || !destino) return null;
  const esFerry = bool(t.es_ferry);
  const pernocta = bool(t.requiere_pernocta);
  return {
    orden: numOrNull(t.orden) ?? i + 1,
    origen_iata: origen,
    destino_iata: destino,
    millas_nauticas: num(t.millas ?? t.millas_nauticas),
    pasajeros: esFerry ? 0 : num(t.pasajeros),
    pasajeros_nombres: [],
    es_ferry: esFerry,
    requiere_pernocta: pernocta,
    pernocta_costo_usd: pernocta
      ? num(t.pernocta_usd ?? t.pernocta_costo_usd)
      : 0,
    tipo_parada: parada(t.tipo_parada),
    servicio_notas: texto(t.servicio_notas),
    notas: null,
  };
}

/**
 * Cascada ÚNICA de «qué se cotizó»: `calculo_snapshot.ruta.escalas` (el
 * camino normal, trae TODO) → `calculo_snapshot.tramos` (respaldo) → null.
 * Las 227 cotizaciones de producción traen las dos, así que el `null` solo
 * protege contra una fila corrupta o una cotización sin snapshot (reserva sin
 * cotizar): ahí NO hay nada pactado todavía y manda la operación, como antes.
 */
export function tramosCotizados(snapshot: unknown): TramoCotizado[] | null {
  const snap = snapshot as {
    ruta?: { escalas?: unknown } | null;
    tramos?: unknown;
  } | null;
  const deRuta = Array.isArray(snap?.ruta?.escalas)
    ? (snap.ruta.escalas as unknown[])
    : null;
  if (deRuta && deRuta.length > 0) {
    const filas = deRuta.map((e, i) =>
      desdeEscalaDelSnapshot((e ?? {}) as Record<string, unknown>, i),
    );
    if (filas.every((f) => f != null)) return filas;
  }
  const deTramos = Array.isArray(snap?.tramos)
    ? (snap.tramos as unknown[])
    : null;
  if (deTramos && deTramos.length > 0) {
    const filas = deTramos.map((t, i) =>
      desdeTramoDelSnapshot((t ?? {}) as Record<string, unknown>, i),
    );
    if (filas.every((f) => f != null)) return filas;
  }
  return null;
}

/** Misma cascada, indexada por `orden` (1..N) — el eje del UPSERT. */
export function tramosCotizadosPorOrden(
  snapshot: unknown,
): Map<number, TramoCotizado> {
  const filas = tramosCotizados(snapshot) ?? [];
  const out = new Map<number, TramoCotizado>();
  for (const f of filas) if (!out.has(f.orden)) out.set(f.orden, f);
  return out;
}

/** Igualdad de RUTA: lo que identifica al tramo entre las dos listas. */
export function mismaRuta(
  a: { origen_iata?: unknown; destino_iata?: unknown } | null | undefined,
  b: { origen_iata?: unknown; destino_iata?: unknown } | null | undefined,
): boolean {
  if (!a || !b) return false;
  const oa = iata(a.origen_iata);
  const da = iata(a.destino_iata);
  const ob = iata(b.origen_iata);
  const db = iata(b.destino_iata);
  if (!oa || !da || !ob || !db) return false;
  return oa === ob && da === db;
}

/** Tramo ya RESUELTO por el motor (`ResolvedLeg`), tal como llega al UPDATE. */
export interface TramoResuelto {
  origen_iata?: unknown;
  destino_iata?: unknown;
  pasajeros?: unknown;
  pasajeros_nombres?: unknown;
  es_ferry?: unknown;
  requiere_pernocta?: unknown;
  pernocta_costo_usd?: unknown;
  tipo_parada?: unknown;
  servicio_notas?: unknown;
  notas?: unknown;
}

/**
 * Columnas que `replaceEscalas` debe OMITIR del UPDATE porque lo que llega es
 * IDÉNTICO a lo COTIZADO antes: la oficina no las cambió, así que la escala
 * VIVA conserva lo que capturó el piloto.
 *
 * Se ESCRIBEN (no aparecen aquí) cuando el valor entrante DIFIERE del
 * cotizado: eso es una edición deliberada de la oficina y sí manda sobre la
 * operación. `pernocta_costo_usd` viaja PEGADO a `requiere_pernocta` (si no,
 * se escribiría `null` sobre una pernocta que la operación acaba de marcar).
 * `pasajeros_nombres` se decide APARTE (el manifiesto sí se edita solo desde
 * el cotizador: si la oficina lo cambió, se escribe aunque el pax siga igual;
 * si es el mismo del snapshot, la escala viva conserva el del piloto).
 */
export function columnasQueConservaLaOperacion(
  entrante: TramoResuelto,
  cotizado: TramoCotizado,
): string[] {
  const omitir: string[] = [];
  const ferryEntrante = bool(entrante.es_ferry);
  const ferryIgual = ferryEntrante === cotizado.es_ferry;
  const paxEntrante = ferryEntrante ? 0 : num(entrante.pasajeros);
  const paxCotizado = cotizado.es_ferry ? 0 : cotizado.pasajeros;
  if (ferryIgual) omitir.push('es_ferry');
  if (ferryIgual && paxEntrante === paxCotizado) omitir.push('pasajeros');
  const nombresEntrante = ferryEntrante
    ? []
    : nombres(entrante.pasajeros_nombres);
  if (
    nombresEntrante.length === cotizado.pasajeros_nombres.length &&
    nombresEntrante.every((n, i) => n === cotizado.pasajeros_nombres[i])
  ) {
    omitir.push('pasajeros_nombres');
  }
  const pernoctaEntrante = bool(entrante.requiere_pernocta);
  const costoEntrante = pernoctaEntrante ? num(entrante.pernocta_costo_usd) : 0;
  if (
    pernoctaEntrante === cotizado.requiere_pernocta &&
    costoEntrante === cotizado.pernocta_costo_usd
  ) {
    omitir.push('requiere_pernocta', 'pernocta_costo_usd');
  }
  if (parada(entrante.tipo_parada) === cotizado.tipo_parada) {
    omitir.push('tipo_parada');
  }
  if (texto(entrante.servicio_notas) === cotizado.servicio_notas) {
    omitir.push('servicio_notas');
  }
  if (texto(entrante.notas) === cotizado.notas) omitir.push('notas');
  return omitir;
}

/** Tramo tal como viaja en el DTO (pax puede faltar = hereda el global). */
export interface TramoEntranteDto {
  origen_iata?: unknown;
  destino_iata?: unknown;
  millas_nauticas?: unknown;
  pasajeros?: number | null;
  pasajeros_nombres?: string[] | null;
  es_ferry?: boolean | null;
  requiere_pernocta?: boolean | null;
  pernocta_costo_usd?: number | null;
}

export interface AnclaTramoResultado<T> {
  /** El tramo entrante, ANCLADO a lo cotizado si hacía falta (copia). */
  leg: T;
  /** Campos anclados (vacío = no se tocó nada). */
  anclado: Array<'pasajeros' | 'es_ferry' | 'pernocta'>;
}

/**
 * ANCLA para un panel VIEJO (sin `tramos_base`): devuelve el tramo entrante
 * anclado a lo COTIZADO cuando es un ECO de la escala VIVA — misma ruta,
 * mismas millas, y pax/ferry/pernocta que coinciden con la OPERACIÓN y
 * difieren de lo cotizado. Si el valor entrante no coincide con la operación,
 * es una edición REAL de la oficina y se respeta tal cual.
 *
 * Compromiso conocido (mismo que `esEcoDeTarifa`): si la oficina teclea a
 * mano EXACTAMENTE el mismo pax que ya tiene la escala viva desde una pestaña
 * vieja, el ancla lo tomará por eco. Por eso el API lo DICE en `avisos[]` —
 * nunca es silencioso — y desaparece en cuanto el panel manda `tramos_base`.
 */
export function anclarTramoAlCotizado<T extends TramoEntranteDto>(
  entrante: T,
  cotizado: TramoCotizado | undefined,
  viva: TramoVivo | undefined,
  opts: { paxGlobal?: number | null } = {},
): AnclaTramoResultado<T> {
  const anclado: AnclaTramoResultado<T>['anclado'] = [];
  if (!cotizado || !viva) return { leg: entrante, anclado };
  // La RUTA identifica al tramo: si cambió, el tramo se redefinió y no hay
  // nada que anclar. Las MILLAS son del cotizador (la operación nunca las
  // escribe): distintas = alguien editó la ruta a mano.
  if (!mismaRuta(entrante, cotizado) || !mismaRuta(viva, cotizado)) {
    return { leg: entrante, anclado };
  }
  if (
    Math.abs(num(entrante.millas_nauticas) - cotizado.millas_nauticas) > 0.011
  ) {
    return { leg: entrante, anclado };
  }
  const leg = { ...entrante };
  // Escritura a través de la forma base: `leg` es genérico (T) y TS no deja
  // asignar sobre una propiedad de un genérico sin este puente.
  const w = leg as TramoEntranteDto;
  const ferryEntrante = entrante.es_ferry === true;
  const ferryViva = bool(viva.es_ferry);
  if (ferryEntrante === ferryViva && ferryEntrante !== cotizado.es_ferry) {
    w.es_ferry = cotizado.es_ferry;
    anclado.push('es_ferry');
  }
  const paxGlobal = numOrNull(opts.paxGlobal);
  const paxEntrante = ferryEntrante
    ? 0
    : (numOrNull(entrante.pasajeros) ?? paxGlobal);
  const paxViva = ferryViva ? 0 : numOrNull(viva.pasajeros);
  const paxCotizado = cotizado.es_ferry ? 0 : cotizado.pasajeros;
  if (
    paxEntrante != null &&
    paxViva != null &&
    paxEntrante === paxViva &&
    paxEntrante !== paxCotizado
  ) {
    w.pasajeros = cotizado.pasajeros;
    w.pasajeros_nombres = cotizado.pasajeros_nombres;
    anclado.push('pasajeros');
  }
  const pernoctaEntrante = entrante.requiere_pernocta === true;
  const pernoctaViva = bool(viva.requiere_pernocta);
  if (
    pernoctaEntrante === pernoctaViva &&
    pernoctaEntrante !== cotizado.requiere_pernocta
  ) {
    w.requiere_pernocta = cotizado.requiere_pernocta;
    w.pernocta_costo_usd = cotizado.requiere_pernocta
      ? cotizado.pernocta_costo_usd
      : null;
    anclado.push('pernocta');
  }
  return { leg, anclado };
}

/** Ruta legible de un tramo, para los avisos ámbar. */
export function rutaTxt(t: {
  origen_iata?: unknown;
  destino_iata?: unknown;
}): string {
  const o = iata(t.origen_iata) || '?';
  const d = iata(t.destino_iata) || '?';
  return `${o} → ${d}`;
}

/**
 * Aviso (ÁMBAR, no bloquea) cuando el ancla del panel viejo actuó: el total
 * guardado es el PACTADO, no el que el operador vio en pantalla. Nunca en
 * silencio.
 */
export function avisoAnclaDeTramos(
  anclados: Array<{ orden: number; campos: string[] }>,
): string | null {
  if (anclados.length === 0) return null;
  const etiqueta: Record<string, string> = {
    pasajeros: 'los pasajeros',
    es_ferry: 'la marca de ferry',
    pernocta: 'la pernocta',
  };
  const partes = anclados.map(
    (a) =>
      `tramo ${a.orden} (${a.campos.map((c) => etiqueta[c] ?? c).join(' y ')})`,
  );
  return `Se conservó lo PACTADO en ${partes.join(', ')}: lo que llegó era lo que capturó la operación, no una edición de la cotización. Actualiza el panel para ver el aviso de divergencia y decidir con el botón "Actualizar la cotización con la operación".`;
}

/**
 * Aviso: la RUTA del tramo la movió la OPERACIÓN y la oficina no la tocó en
 * la cotización, así que el UPDATE NO la pisa (22-sep-2026, casos #322 y
 * #297: el tramo 1 salió de CET y no de CUN, con tacómetro ya capturado —
 * reescribirlo falsificaría la bitácora, el calendario y los permisos).
 * La cotización sigue preciando con lo PACTADO; los dos datos conviven.
 */
export function avisoRutaDeLaOperacion(
  orden: number,
  rutaCotizada: string,
  rutaViva: string,
  yaVolo: boolean,
): string {
  return `El tramo ${orden} vuela ${rutaViva} en la operación y se cotizó ${rutaCotizada}${yaVolo ? ' (ya tiene tacómetro capturado)' : ''}: la cotización conserva lo PACTADO y el vuelo conserva su ruta real. Si el cliente debe pagar la ruta que se voló, usa "Actualizar la cotización con la operación"; si la ruta del vuelo está mal, corrígela desde el vuelo.`;
}

/** Aviso: el tramo sigue CANCELADO en la operación y la cotización lo cobra. */
export function avisoTramoCancelado(orden: number, ruta: string): string {
  return `El tramo ${orden} ${ruta} está CANCELADO en la operación y la cotización lo sigue cobrando. Si ya no va, quítalo de la cotización; si sí va, reactívalo desde el vuelo.`;
}

/** Aviso: sobra un tramo con tacómetro y NO se borró (invariante 1). */
export function avisoTramoConTacoConservado(
  orden: number,
  ruta: string,
): string {
  return `El tramo ${orden} ${ruta} ya no está en la cotización pero tiene tacómetro capturado: se CONSERVÓ en la operación (sus horas de motor y gastos cuelgan de esa matrícula). Revisa si debe cobrarse.`;
}
