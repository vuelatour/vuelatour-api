/**
 * TRAMOS COSTEADOS — fuente ÚNICA del costo por tramo (22-sep-2026).
 *
 * POR QUÉ EXISTE (pedido del cliente: la pantalla de la cotización pasa a
 * verse como la hoja INTERNA, con la tabla del Excel de la oficina
 * `RUTA · FECHA · DISTANCIA MILLAS · TIEMPO VUELO · COSTO POR HORA VUELO ·
 * TOTAL POR TRAMO`): la columna TOTAL POR TRAMO **no existe en ningún lado**
 * del dinero persistido — el `calculo_snapshot` guarda `tiempo_hr` por tramo
 * pero no su importe, y hasta hoy el único que lo calculaba era el armador
 * del PDF interno (`round2(tiempo_hr × tarifa)`, inline). Si el panel lo
 * replicara para pintar la tabla mientras se teclea, habría DOS fuentes del
 * mismo número y la pantalla podría decir una cifra y el PDF otra del MISMO
 * vuelo (riesgo 10 del diseño: cálculo paralelo). Por eso el costeo vive
 * AQUÍ, PURO, y lo comparten el PDF interno (`quotes-pdf-interno.util`) y
 * `POST /v1/quotes/calculate` (campos ADITIVOS del `breakdown`).
 *
 * DISCIPLINA DE NÚMEROS (regla del workspace: fuentes únicas, nada de
 * cálculos paralelos; invariante 3 del repo):
 *  - El ÚNICO número nuevo es `total_usd = round2(tiempo_hr × tarifa)` por
 *    tramo — y ni siquiera eso si el snapshot ya trae `total_usd`/`costo_usd`
 *    (entonces se LEE tal cual).
 *  - `tiempo_hr` YA incluye el calzo de 0.15 h del tramo: se usa como viene.
 *  - La columna TIEMPO se PINTA en horas decimales (`tiempo_horas`,
 *    `tramos_tiempo_total_horas`, API 0.0.33) con la suma cuadrada de
 *    `repartirHorasDecimales`: es texto de presentación, no multiplica nada.
 *  - La diferencia contra la línea canónica TIEMPO_VUELO del desglose NO se
 *    esconde ni se reparte entre tramos: viaja explícita como
 *    `tramos_ajuste_usd` con su motivo (horas pactadas / sobrevuelo / hora
 *    mínima / redondeo), de modo que `Σ tramos + ajuste == servicio aéreo` y
 *    el desglose canónico v1.3 queda intacto.
 *  - El desglose canónico NO se toca: este helper no crea, ni reordena, ni
 *    reetiqueta una sola línea de `lineas[]`.
 *
 * TARIFA POR TRAMO: el motor v1.3 cotiza con UNA tarifa por vuelo (la tarifa
 * por tramo sigue siendo un pendiente conocido). `tarifa_usd_hr` por tramo se
 * LEE si algún día el snapshot la trae; mientras tanto es la del vuelo.
 *
 * Puro: sin BD, sin Nest, sin fechas del sistema. La presentación que
 * necesita catálogos (nombre de ciudad del aeropuerto) y BD (día de la
 * escala) entra INYECTADA por el llamador.
 */

/**
 * Horas decimales → "hh:mm" (1.3 → "01:18", 0.4 → "00:24"); nunca negativo.
 *
 * LEGADO desde el 24-sep-2026 (API 0.0.33): `tiempo_hhmm` y
 * `tramos_tiempo_total_hhmm` se siguen mandando por compatibilidad, pero la
 * hoja interna y el PDF interno ya pintan `tiempo_horas` /
 * `tramos_tiempo_total_horas` (ver `repartirHorasDecimales`).
 */
export function horasAHhmm(h: number): string {
  const m = Math.max(0, Math.round(h * 60));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ===== TIEMPO DE VUELO EN HORAS DECIMALES (24-sep-2026, API 0.0.33) =====
//
// Pedido del cliente con la captura de la hoja interna de una CUN→PTU→CUN:
// «la parte de tiempo de vuelo, lo podemos manejar solo en decimales por
// favor? Porque parece ser que el sistema tiene un poco de problema al momento
// de convertirlo y luego como que se nos hacen raros los tiempos». Cada tramo
// valía 1.19166… h (125 nm / 120 kt + 0.15 de calzo) = 71.5 min ⇒ «01:12»; el
// total 2.38333 h = 143 min ⇒ «02:23»; y 01:12 + 01:12 ≠ 02:23. La columna
// TIEMPO VUELO pasa a horas decimales con 2 decimales FIJOS («1.19», «2.38»,
// «1.20») y, además, los tramos que se ven SIEMPRE suman el total que se ve.
//
// Es SOLO presentación: `tiempo_hr` (4 dec.) sigue siendo el número con el
// que se multiplica y ningún importe cambia.

/** Unidades enteras por hora con las que se redondea (micro-horas). */
const MICRO_POR_HORA = 1_000_000;
/** Micro-horas por centésima de hora. */
const MICRO_POR_CENTESIMA = MICRO_POR_HORA / 100;

/** Horas → micro-horas enteras (nunca negativo; sin flotantes al redondear). */
function microHoras(h: number): number {
  return Math.max(0, Math.round(h * MICRO_POR_HORA));
}

/** Centésimas de hora → «1.19» (2 decimales FIJOS). */
function centesimasATexto(c: number): string {
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

/**
 * Horas decimales → texto con 2 decimales FIJOS, redondeo MEDIO HACIA ARRIBA
 * en aritmética ENTERA (1.19166 → «1.19», 1.2 → «1.20», 1.005 → «1.01», que
 * con `toFixed` daría «1.00» por el binario del flotante). Nunca negativo.
 */
export function horasADecimal(h: number): string {
  return centesimasATexto(
    Math.floor((microHoras(h) + MICRO_POR_CENTESIMA / 2) / MICRO_POR_CENTESIMA),
  );
}

/** Columna TIEMPO de la tabla ya en texto decimal, cuadrada. */
export interface HorasDecimalesCuadradas {
  /** Una celda por tramo, en el MISMO orden; `null` = el tramo no trae tiempo («—»). */
  tramos: (string | null)[];
  /** `horasADecimal(Σ tiempos)`: la fila TOTAL. */
  total: string;
}

/**
 * La columna TIEMPO de la tabla de tramos en horas decimales (2 decimales
 * fijos) con la SUMA CUADRADA: los tramos mostrados suman EXACTAMENTE el
 * total mostrado.
 *
 *  - Total mostrado = `horasADecimal(Σ tiempos)` (Σ exacto, redondeado UNA vez).
 *  - Cada tramo se redondea con el método del RESIDUO MAYOR (largest
 *    remainder): todos bajan a su centésima de piso y las centésimas que
 *    faltan para llegar al total se reparten, de una en una, a los tramos con
 *    el residuo más grande — empates por ORDEN del tramo (determinista). Cada
 *    tramo queda en su piso o en su techo, así que difiere de su propio
 *    redondeo en ≤ 0.01.
 *  - Un tiempo `null`/no finito es un tramo SIN tiempo: su celda es `null`
 *    («—») y no aporta a la suma (igual que hoy, donde cuenta como 0).
 *
 * Ej.: 1.19166 + 1.19166 ⇒ «1.19» + «1.19» = «2.38» (antes «01:12» + «01:12»
 * ≠ «02:23»); tres tramos de 0.335 ⇒ total «1.01» y tramos «0.34», «0.34»,
 * «0.33» (redondeados cada uno por su lado sumarían 1.02).
 *
 * FUENTE ÚNICA: la usan `costearTramos` / `consolidarTramosCosteados` (el
 * breakdown de `/quotes/calculate` y el PDF interno). El panel tiene un
 * ESPEJO EXACTO (`lib/admin/quote-sheet-interna.ts`) SOLO para snapshots
 * anteriores al 0.0.33, con test de paridad de los mismos casos; pyservices,
 * un respaldo igual para un payload sin estos campos.
 */
export function repartirHorasDecimales(
  tiempos: readonly (number | null | undefined)[],
): HorasDecimalesCuadradas {
  const micros = tiempos.map((h) =>
    h == null || !Number.isFinite(h) ? null : microHoras(h),
  );
  const suma = micros.reduce<number>((acc, m) => acc + (m ?? 0), 0);
  const totalCentesimas = Math.floor(
    (suma + MICRO_POR_CENTESIMA / 2) / MICRO_POR_CENTESIMA,
  );
  const pisos = micros.map((m) =>
    m == null ? null : Math.floor(m / MICRO_POR_CENTESIMA),
  );
  let faltan =
    totalCentesimas - pisos.reduce<number>((acc, p) => acc + (p ?? 0), 0);
  // Residuo de mayor a menor; empate ⇒ el tramo de menor ORDEN primero. Con
  // residuo 0 un tramo nunca sube: `faltan` ≤ nº de residuos positivos.
  const candidatos = micros
    .map((m, i) => ({ i, residuo: m == null ? -1 : m % MICRO_POR_CENTESIMA }))
    .filter((c) => c.residuo > 0)
    .sort((a, b) => b.residuo - a.residuo || a.i - b.i);
  const centesimas = [...pisos];
  for (const c of candidatos) {
    if (faltan <= 0) break;
    centesimas[c.i] = (centesimas[c.i] ?? 0) + 1;
    faltan -= 1;
  }
  return {
    tramos: centesimas.map((c) => (c == null ? null : centesimasATexto(c))),
    total: centesimasATexto(totalCentesimas),
  };
}

/** Horas para texto: hasta 2 decimales sin ceros de relleno ("0.5", "2", "1.25"). */
export function horasTexto(h: number): string {
  return String(Number(h.toFixed(2)));
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** Tramo tal como vive en `calculo_snapshot.tramos[]` (forma tolerante). */
export interface TramoSnapshotLike {
  orden?: unknown;
  origen?: unknown;
  destino?: unknown;
  millas?: unknown;
  tiempo_hr?: unknown;
  /** Si algún día el motor cotiza tarifa POR TRAMO. */
  tarifa_usd_hr?: unknown;
  /** Importe ya congelado por el motor (gana sobre el producto). */
  total_usd?: unknown;
  /** Alias legado de `total_usd`. */
  costo_usd?: unknown;
  pasajeros?: unknown;
  es_ferry?: unknown;
  requiere_pernocta?: unknown;
  pernocta_usd?: unknown;
  tuas_usd?: unknown;
  [k: string]: unknown;
}

/** Fila de la tabla «TRAMOS COTIZADOS» (Excel de la oficina). */
export interface TramoCosteado {
  /** Numeración 1..N de la tabla. */
  orden: number;
  /** "Cancun-Merida" (nombres resueltos por el llamador; IATA por default). */
  ruta: string;
  origen_iata: string;
  destino_iata: string;
  origen_nombre: string;
  destino_nombre: string;
  /** Día del tramo YYYY-MM-DD (pared Cancún) o null si el llamador no fecha. */
  fecha: string | null;
  millas: number | null;
  /** Horas del tramo CON calzos (4 dec.). */
  tiempo_hr: number;
  /** LEGADO (compatibilidad): «01:12». Ya no se pinta desde el API 0.0.33. */
  tiempo_hhmm: string;
  /**
   * Lo que PINTA la columna TIEMPO VUELO (HRS) desde el 0.0.33: «1.19», 2
   * decimales fijos y repartido con `repartirHorasDecimales` para que Σ
   * tramos mostrados == `tramos_tiempo_total_horas`. `null` = el snapshot no
   * trae tiempo para este tramo (la celda dice «—»).
   */
  tiempo_horas: string | null;
  /** Tarifa USD/hr aplicada: la del tramo si el snapshot la trae, si no la del vuelo. */
  tarifa_hora_usd: number | null;
  /** `snapshot.total_usd` si existe; si no `round2(tiempo_hr × tarifa)`. */
  total_usd: number;
  pax: number | null;
  es_ferry: boolean;
  pernocta: boolean;
  pernocta_usd: number;
  tuas_usd: number;
  /** true = fila ÚNICA de respaldo (cotización sin tramos en el snapshot). */
  consolidado: boolean;
}

/**
 * Horas del snapshot que EXPLICAN el ajuste. No lo calculan: solo le ponen
 * nombre para que la oficina vea por qué `Σ tramos ≠ servicio aéreo`.
 */
export interface HorasDelAjuste {
  /** `snapshot.tiempos.cobrable_hr` (las que se multiplicaron). */
  tiempo_cobrable_hr: number | null;
  sobrevuelo_hr: number | null;
  /** `tiempos.minimo_hora_aplicado`. */
  hora_minima_aplicada: boolean;
  /** `tiempos.cobrable_proviene_de_override` (horas PACTADAS a mano). */
  cobrable_override: boolean;
}

/** Fila mínima para consolidar (lo que la tabla ya calculó). */
export interface FilaConsolidable {
  tiempo_hr: number;
  total_usd: number;
}

/** Pie de la tabla + el ajuste explícito contra el desglose canónico. */
export interface ConsolidadoTramosCosteados {
  /** Σ `tiempo_hr` (4 dec.). */
  tramos_tiempo_total_hr: number;
  /** LEGADO (compatibilidad): «02:23». Ya no se pinta desde el API 0.0.33. */
  tramos_tiempo_total_hhmm: string;
  /** Fila TOTAL de la columna TIEMPO VUELO (HRS): «2.38» (= Σ `tiempo_horas`). */
  tramos_tiempo_total_horas: string;
  /** Σ `total_usd` (fila TOTAL de la tabla). */
  tramos_total_usd: number;
  /** Línea TIEMPO_VUELO canónica − Σ tramos (0 si cuadra). */
  tramos_ajuste_usd: number;
  /** "Horas pactadas 1.75 h" · "Sobrevuelo 0.5 h" · "Hora mínima 1.0 h" · "Redondeo" · null. */
  tramos_ajuste_motivo: string | null;
}

export interface EntradaTramosCosteados {
  /** `calculo_snapshot.tramos[]` (o `breakdown.tramos`). */
  tramos: readonly unknown[];
  /** Tarifa ÚNICA del vuelo (USD/hr); respaldo del tramo sin tarifa propia. */
  tarifaHora: number | null;
  /** Servicio aéreo CANÓNICO: la línea TIEMPO_VUELO del desglose. */
  servicioAereoUsd: number;
  horas: HorasDelAjuste;
  /**
   * Día de PARED del tramo tal como lo conoce el llamador (escala viva:
   * `fecha_salida_plan` → `pdf_fecha`). `null`/ausente ⇒ cae al día del tramo
   * anterior y, en última instancia, a `fechaVuelo`.
   */
  fechaBaseDeTramo?: (
    orden: number,
    origenIata: string,
    destinoIata: string,
  ) => string | null;
  /** Día del vuelo (último respaldo de la cascada de fechas). */
  fechaVuelo?: string | null;
  /** IATA → nombre corto de ciudad. Por default, el propio IATA. */
  nombreDeIata?: (iata: string) => string;
}

export type ResultadoTramosCosteados = ConsolidadoTramosCosteados & {
  tramos: TramoCosteado[];
};

/**
 * Costo de UN tramo. `totalSnapshot` (lo que el motor ya congeló) GANA sobre
 * el producto; sin tarifa ni total, 0 — jamás se inventa un importe.
 */
export function costoDeTramo(
  tiempoHr: number,
  tarifaHora: number | null,
  totalSnapshot?: number | null,
): number {
  if (totalSnapshot != null) return round2(totalSnapshot);
  return tarifaHora != null ? round2(tiempoHr * tarifaHora) : 0;
}

/**
 * Motivo del ajuste `servicio aéreo − Σ tramos`. Null cuando el ajuste es
 * despreciable (< medio centavo): ahí la tabla cuadra sola.
 */
export function motivoAjusteTramos(
  ajusteUsd: number,
  horas: HorasDelAjuste,
  tarifaHora: number | null,
): string | null {
  if (Math.abs(ajusteUsd) < 0.005) return null;
  const partes: string[] = [];
  if (horas.cobrable_override && horas.tiempo_cobrable_hr != null) {
    partes.push(`Horas pactadas ${horasTexto(horas.tiempo_cobrable_hr)} h`);
  } else {
    if (horas.sobrevuelo_hr != null && horas.sobrevuelo_hr > 0) {
      partes.push(`Sobrevuelo ${horasTexto(horas.sobrevuelo_hr)} h`);
    }
    if (horas.hora_minima_aplicada) partes.push('Hora mínima 1.0 h');
  }
  if (partes.length > 0) return partes.join(' · ');
  return tarifaHora == null ? 'Tarifa no disponible' : 'Redondeo';
}

/**
 * Pie de la tabla: Σ tiempo, Σ importe y el ajuste EXPLÍCITO contra el
 * servicio aéreo canónico. Lo usan las dos ramas del PDF interno (tabla por
 * tramo y fila consolidada de respaldo) y `/quotes/calculate`.
 */
export function consolidarTramosCosteados(
  filas: readonly FilaConsolidable[],
  servicioAereoUsd: number,
  tarifaHora: number | null,
  horas: HorasDelAjuste,
): ConsolidadoTramosCosteados {
  const tiempoTotal = round4(filas.reduce((acc, t) => acc + t.tiempo_hr, 0));
  const total = round2(filas.reduce((acc, t) => acc + t.total_usd, 0));
  // Ajuste = servicio aéreo canónico − Σ tramos. Se EXPONE con su motivo,
  // nunca se reparte entre tramos ni se toca el desglose.
  const ajuste = round2(servicioAereoUsd - total);
  return {
    tramos_tiempo_total_hr: tiempoTotal,
    tramos_tiempo_total_hhmm: horasAHhmm(tiempoTotal),
    tramos_total_usd: total,
    tramos_ajuste_usd: ajuste,
    tramos_ajuste_motivo: motivoAjusteTramos(ajuste, horas, tarifaHora),
    // El MISMO total que reparte `costearTramos` entre las filas (un tramo
    // sin tiempo llega aquí con 0 y no aporta, igual que un `null` allá).
    tramos_tiempo_total_horas: repartirHorasDecimales(
      filas.map((t) => t.tiempo_hr),
    ).total,
  };
}

/**
 * Tabla COMPLETA de tramos costeados + su pie. Es la fuente ÚNICA que
 * comparten el PDF interno y `POST /quotes/calculate`: si estos números
 * cambian, cambian en los dos a la vez.
 */
export function costearTramos(
  entrada: EntradaTramosCosteados,
): ResultadoTramosCosteados {
  const {
    tarifaHora,
    servicioAereoUsd,
    horas,
    fechaVuelo = null,
    fechaBaseDeTramo,
    nombreDeIata,
  } = entrada;
  const nombre = nombreDeIata ?? ((iata: string) => iata);
  const crudos = entrada.tramos.filter(
    (t): t is TramoSnapshotLike => !!t && typeof t === 'object',
  );
  let ultimaFecha: string | null = null;
  // Columna TIEMPO VUELO (HRS): se reparte sobre TODAS las filas de la tabla
  // a la vez (residuo mayor), así Σ `tiempo_horas` == el total del pie. Un
  // tramo sin `tiempo_hr` en el snapshot va `null` («—»).
  const horasDecimales = repartirHorasDecimales(
    crudos.map((t) => {
      const h = num(t.tiempo_hr);
      return h == null ? null : round4(h);
    }),
  );
  const tramos: TramoCosteado[] = crudos.map((t, idx) => {
    const orden = num(t.orden) ?? idx + 1;
    const o = (str(t.origen) ?? '').toUpperCase();
    const d = (str(t.destino) ?? '').toUpperCase();
    // Día del tramo: el que resuelva el llamador (plan de la escala → fecha
    // de pared del PDF) → el día del tramo anterior (intermedios del mismo
    // día) → día del vuelo.
    const fecha = fechaBaseDeTramo?.(orden, o, d) ?? ultimaFecha ?? fechaVuelo;
    ultimaFecha = fecha;
    const tiempoHr = round4(num(t.tiempo_hr) ?? 0);
    // Tarifa por tramo solo si el snapshot algún día la trae (multi-avión en
    // el precio sigue pendiente): hoy es la ÚNICA del vuelo.
    const tarifaTramo = num(t.tarifa_usd_hr) ?? tarifaHora;
    const totalSnap = num(t.total_usd) ?? num(t.costo_usd);
    const esFerry = t.es_ferry === true;
    const origenNombre = nombre(o);
    const destinoNombre = nombre(d);
    return {
      orden: idx + 1,
      ruta: `${origenNombre}-${destinoNombre}`,
      origen_iata: o,
      destino_iata: d,
      origen_nombre: origenNombre,
      destino_nombre: destinoNombre,
      fecha,
      millas: num(t.millas),
      tiempo_hr: tiempoHr,
      tiempo_hhmm: horasAHhmm(tiempoHr),
      tiempo_horas: horasDecimales.tramos[idx] ?? null,
      tarifa_hora_usd: tarifaTramo,
      total_usd: costoDeTramo(tiempoHr, tarifaTramo, totalSnap),
      pax: esFerry ? 0 : num(t.pasajeros),
      es_ferry: esFerry,
      pernocta: t.requiere_pernocta === true,
      pernocta_usd: num(t.pernocta_usd) ?? 0,
      tuas_usd: num(t.tuas_usd) ?? 0,
      consolidado: false,
    };
  });
  return {
    tramos,
    ...consolidarTramosCosteados(tramos, servicioAereoUsd, tarifaHora, horas),
  };
}
