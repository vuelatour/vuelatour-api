/**
 * Helpers PUROS del espejo sistema → Google Calendar (12-sep-2026).
 *
 * Viven aparte de `calendar-sync.service` a propósito: se prueban sin tocar
 * ni Supabase ni la API de Google (el cliente de Google JAMÁS se llama en
 * pruebas) y los usa también cualquier otro lector que necesite el mismo
 * criterio de color o de nombre corto.
 */

import {
  SEMAFORO,
  colorEventoFlotaSistema,
  colorMantenimientoSistema,
  colorVueloSistema,
  type ParamsColorVuelo,
} from './colores-calendario.util';

/**
 * Paleta OFICIAL de colores de EVENTO de Google Calendar (`colors.event` de
 * la API v3). Son los ÚNICOS 11 valores que Google acepta en
 * `event.colorId`; cualquier otro hex se ignora y el evento sale del color
 * por default del calendario.
 */
export const COLORES_EVENTO_GOOGLE: ReadonlyArray<{
  readonly id: string;
  readonly nombre: string;
  readonly hex: string;
}> = [
  { id: '1', nombre: 'Lavanda', hex: '#7986cb' },
  { id: '2', nombre: 'Salvia', hex: '#33b679' },
  { id: '3', nombre: 'Uva', hex: '#8e24aa' },
  { id: '4', nombre: 'Flamenco', hex: '#e67c73' },
  { id: '5', nombre: 'Banana', hex: '#f6bf26' },
  { id: '6', nombre: 'Mandarina', hex: '#f4511e' },
  { id: '7', nombre: 'Pavo real', hex: '#039be5' },
  { id: '8', nombre: 'Grafito', hex: '#616161' },
  { id: '9', nombre: 'Arándano', hex: '#3f51b5' },
  { id: '10', nombre: 'Albahaca', hex: '#0b8043' },
  { id: '11', nombre: 'Tomate', hex: '#d50000' },
] as const;

/** #RGB o #RRGGBB (con o sin `#`) → [r, g, b] 0..255. null si no es un hex. */
function rgbDe(hex: string): [number, number, number] | null {
  const limpio = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(limpio)) {
    const [r, g, b] = limpio.split('');
    return [
      parseInt(`${r}${r}`, 16),
      parseInt(`${g}${g}`, 16),
      parseInt(`${b}${b}`, 16),
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(limpio)) {
    return [
      parseInt(limpio.slice(0, 2), 16),
      parseInt(limpio.slice(2, 4), 16),
      parseInt(limpio.slice(4, 6), 16),
    ];
  }
  return null;
}

/**
 * Distancia "redmean" (aproximación perceptual estándar, ponderada por el
 * rojo promedio): más fiel que la euclidiana cruda en RGB y determinista.
 * Se compara el cuadrado (no hace falta la raíz para ordenar).
 */
function distancia(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const rMedio = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return (
    (2 + rMedio / 256) * dr * dr +
    4 * dg * dg +
    (2 + (255 - rMedio) / 256) * db * db
  );
}

/**
 * Mapea un hex del sistema al `colorId` de Google MÁS CERCANO (distancia
 * redmean), para que el Google Calendar de la oficina espeje el semáforo del
 * calendario interno.
 *
 * Devuelve `null` cuando no hay color o no es un hex válido: el llamador cae
 * al gris del tentativo — nunca se inventa un color.
 *
 * Desde el 22-sep-2026 los únicos hex que llegan aquí son los del semáforo
 * (`SEMAFORO`: SIETE desde el 28-sep-2026) y, con las excepciones fijas de
 * `colorIdGoogleSemaforo`, caen en colorId DISTINTOS, así que ya NO hay
 * colisiones: antes 18 cosas (6 significados + 8 colores de avión + 4 tipos)
 * se repartían los 11 colores de Google y el color no era un dato confiable.
 */
export function colorIdGoogleDe(
  hexColor: string | null | undefined,
): string | null {
  if (!hexColor) return null;
  const rgb = rgbDe(hexColor);
  if (!rgb) return null;
  let mejorId: string | null = null;
  let mejorD = Number.POSITIVE_INFINITY;
  for (const c of COLORES_EVENTO_GOOGLE) {
    const objetivo = rgbDe(c.hex);
    if (!objetivo) continue;
    const d = distancia(rgb, objetivo);
    // `<` estricto: empate ⇒ gana el primero de la lista (id más bajo),
    // así el mapeo es estable entre versiones.
    if (d < mejorD) {
      mejorD = d;
      mejorId = c.id;
    }
  }
  return mejorId;
}

/**
 * ESPEJO DEL SEMÁFORO (pedido del cliente, 12-sep-2026 «los mismos colores»,
 * reducido a 5 el 22-sep-2026 «que en los calendarios no se vean tantos
 * colores», 6 desde el 24-sep-2026 con el PAGADO y el descanso MORADO, 7 desde
 * el 28-sep-2026 con el SERVICIO café). Cada uno de los SIETE hex del
 * semáforo se traduce a un colorId DISTINTO de Google. Ninguna de estas
 * funciones inventa un color propio: todas salen de un hex de
 * `colores-calendario.util`.
 *
 *   gris #64748B     → 8  Grafito     (tentativo)
 *   amarillo #F59E0B → 5  Banana      (pendiente · permiso, sin asignar, mantenimiento)
 *   verde #22C55E    → 2  Salvia      (confirmado · evento de flota)
 *   azul #3B82F6     → 7  Pavo real   (PAGADO: cobrado completo)
 *   rojo #EF4444     → 11 Tomate      (cancelado — hoy NO viaja: se BORRA) · FIJO
 *   morado #8B5CF6   → 3  Uva         (descanso 💤) · FIJO
 *   café #8B5E3C     → 6  Mandarina   (vuelo de SERVICIO: taller / parada técnica) · FIJO
 *
 * Libres para significados futuros: 1 Lavanda, 4 Flamenco, 9 Arándano y
 * 10 Albahaca.
 *
 * Fallback cuando el hex no se puede leer: el gris del tentativo, nunca un
 * color con significado fuerte.
 */
const COLOR_ID_RESPALDO: string = colorIdGoogleDe(SEMAFORO.TENTATIVO) ?? '8';

/**
 * EXCEPCIONES al "más cercano". Son TRES, y las tres por la MISMA razón: el
 * color de Google más cercano por redmean se LEE como otro significado.
 *
 * 1) ROJO (cancelado). El rojo del sistema (#EF4444) por distancia redmean cae
 *    en 6 Mandarina (d≈3 714) antes que en 4 Flamenco (≈17 375) y que en 11
 *    Tomate (≈30 217), y Mandarina es un NARANJA: «cancelado» tiene que leerse
 *    ROJO. Google llama Tomate (11) a su rojo de verdad. En la práctica este
 *    mapeo no viaja: el único rojo del semáforo es el CANCELADO y su evento se
 *    BORRA de Google. Se deja fijo para que la tabla sea completa y para que
 *    cualquier rojo futuro (p. ej. un evento de flota cancelado) salga rojo sin
 *    que nadie tenga que acordarse.
 *
 * 2) MORADO (descanso, 24-sep-2026). El morado del sistema (#8B5CF6) por
 *    redmean cae en 1 Lavanda (d≈12 469) antes que en 9 Arándano (≈25 306) y
 *    que en 3 Uva (≈26 702). Lavanda es un azul-lila pálido que, en el
 *    calendario del mecánico, junto al 7 Pavo real del PAGADO se lee «otro
 *    azul»; y Arándano es un índigo, tampoco morado. «Descanso» tiene que
 *    leerse MORADO: Uva (3) es el único morado de verdad de Google. Este SÍ
 *    viaja: cada descanso de piloto es un evento.
 *
 * 3) CAFÉ (vuelo de SERVICIO, 28-sep-2026). Google NO tiene café entre sus 11
 *    colores de evento. Por redmean #8B5E3C cae en 8 Grafito (d≈7 848), que
 *    es el gris del TENTATIVO: un vuelo al taller se leería «reserva sin
 *    confirmar». El siguiente es 6 Mandarina (≈32 996, un naranja terroso),
 *    empatado casi con 4 Flamenco (≈33 013, un rosa salmón). Se fija
 *    **Mandarina**: es el tono cálido más cercano al café y NINGÚN otro
 *    estado lo usa (el rojo del cancelado va FIJO en 11, justo para no caer
 *    en Mandarina). Luis, el mecánico, lee además «Vuelo de SERVICIO …» en
 *    la descripción del evento, que es el dato confiable.
 */
const COLOR_ID_FIJO: Readonly<Record<string, string>> = {
  [SEMAFORO.CANCELADO]: '11',
  [SEMAFORO.DESCANSO]: '3',
  [SEMAFORO.SERVICIO]: '6',
};

/**
 * Hex del semáforo → colorId de Google. Es el ÚNICO punto por el que pasan
 * los colores que se suben: primero las excepciones fijas, luego el más
 * cercano por redmean, y de último el respaldo.
 */
export function colorIdGoogleSemaforo(hex: string | null | undefined): string {
  if (hex != null && COLOR_ID_FIJO[hex] != null) return COLOR_ID_FIJO[hex];
  return colorIdGoogleDe(hex) ?? COLOR_ID_RESPALDO;
}

/**
 * colorId de Google de UN evento de vuelo (vuelo completo o tramo): el hex que
 * el sistema pintaría, traducido. Mismos parámetros que `colorVueloSistema`
 * — el cancelado no llega aquí (en Google su evento se BORRA).
 *
 * Con el semáforo de hoy: SERVICIO → 6 Mandarina (28-sep-2026, fijo: Google
 * no tiene café), tentativo → 8 Grafito, pendiente → 5 Banana, PAGADO → 7
 * Pavo real (24-sep-2026: `cobrado` del vuelo) y confirmado → 2 Salvia. El
 * avión ya no interviene (`colorAvion` se ignora).
 */
export function colorIdGoogleDeVuelo(p: ParamsColorVuelo): string {
  return colorIdGoogleSemaforo(colorVueloSistema(p));
}

/**
 * colorId del DESCANSO de piloto: MORADO #8B5CF6 → 3 Uva (fijo, ver
 * `COLOR_ID_FIJO`). Hasta el 24-sep-2026 era el azul #3B82F6 → 7 Pavo real,
 * que hoy es del PAGADO.
 */
export function colorIdGoogleDescanso(): string {
  return colorIdGoogleSemaforo(SEMAFORO.DESCANSO);
}

/**
 * colorId de un evento NO-vuelo de la flota: VERDE (2 Salvia) — es una cita
 * agendada. El color del AVIÓN ya no interviene (el parámetro se conserva
 * para no romper llamadores y se ignora, igual que en
 * `colorEventoFlotaSistema`).
 */
export function colorIdGoogleEvento(colorAvion?: string | null): string {
  return colorIdGoogleSemaforo(colorEventoFlotaSistema(colorAvion));
}

/**
 * colorId de un mantenimiento: AMARILLO (5 Banana) siempre, PROGRAMADO y
 * EN_TALLER por igual.
 *
 * Ya NO hay excepción «EN_TALLER = 11 Tomate» (12-sep → 22-sep-2026): en el
 * semáforo nuevo el rojo significa CANCELADO y un avión en taller es un
 * asunto PENDIENTE. Lo que distingue al taller es el título («🔧 En taller ·
 * …»), no el color.
 */
export function colorIdGoogleMantenimiento(enTaller?: boolean): string {
  return colorIdGoogleSemaforo(colorMantenimientoSistema(enTaller));
}

/**
 * Nombre CORTO del piloto para el título del evento: la oficina identifica
 * el vuelo por el piloto (pedido del cliente, 12-sep-2026), y en el título
 * de Google solo cabe una palabra.
 *
 * - vuelo externo ⇒ `'externo'` (la tripulación es del operador, no nuestra);
 * - con `apodo` (`usuario.apodo`, 17-sep-2026) ⇒ el apodo, que GANA sobre el
 *   nombre: la oficina le dice «Saab» a «Alexander E. Saab», «Zamora» a
 *   «Abraham Zamora» y «Pab» a «Pablo Canales» — el PRIMER NOMBRE no es como
 *   lo conocen, y el calendario lo lee el mecánico, no el sistema;
 * - sin apodo ⇒ su PRIMER nombre tal cual está capturado (acentos incluidos);
 * - sin piloto asignado ⇒ `'sin piloto'` (acción pendiente, visible).
 */
export function nombreCortoPiloto(
  nombre: string | null | undefined,
  esExterno = false,
  apodo?: string | null,
): string {
  if (esExterno) return 'externo';
  const corto = (apodo ?? '').trim().replace(/\s+/g, ' ');
  if (corto.length > 0) return corto;
  const limpio = (nombre ?? '').trim().replace(/\s+/g, ' ');
  if (limpio.length === 0) return 'sin piloto';
  return limpio.split(' ')[0];
}

/* ===================================================================== *
 * FORMATO DE LA OFICINA (pedido del cliente, 15-sep-2026)
 *
 * El Google Calendar lo sigue usando UNA sola persona: Luis, el mecánico
 * (los demás viven en la app). Pedido literal: «que no se divida en tramos,
 * mejor que esté todo en UNA SOLA FILA» y «le quitamos lo de T1 y la
 * cantidad de pasajeros, para nada más dejar piloto, avión, ruta y hora».
 *
 * Es EXACTAMENTE el formato que la oficina capturaba a mano antes de que
 * existiera el espejo — muestra real del 15-sep-2026:
 *   `Saab N621TX cun-pce-ctm-pce-cun 6:50`
 *   `Luis XB-PEV cun-ctm-cun 7:00`
 *   `Zamora XA-VGV cet-czm-cet 16:00`
 * Estos helpers son PUROS a propósito: el título que ve el mecánico se
 * congela en `google-evento.util.spec.ts` con esas muestras.
 * ===================================================================== */

/**
 * RUTA de la fila: los códigos IATA en MINÚSCULAS de los tramos ACTIVOS, en
 * orden — origen del primero y destino de cada uno (`cun-mid-cun`).
 *
 * - Códigos repetidos consecutivos se colapsan (el destino de un tramo es el
 *   origen del siguiente: no se escribe dos veces).
 * - Si un tramo NO empieza donde terminó el anterior (dato roto o traslado
 *   no capturado), su origen SÍ se escribe: la ruta nunca miente por callar.
 * - Un código vacío se omite; sin tramos útiles devuelve `''`.
 */
export function rutaMinusculas(
  tramos: ReadonlyArray<{
    origen?: string | null;
    destino?: string | null;
  }>,
): string {
  const codigos: string[] = [];
  const limpio = (crudo: string | null | undefined): string =>
    (crudo ?? '').trim().toLowerCase();
  for (const t of tramos ?? []) {
    const origen = limpio(t?.origen);
    const destino = limpio(t?.destino);
    // Solo se COLAPSA la unión entre tramos (el origen repite el destino
    // anterior: cun-mid + mid-cun ⇒ cun-mid-cun). Dentro de un tramo NO:
    // un vuelo local o de prueba (mid → mid) se escribe «mid-mid», como lo
    // anotaba la oficina («msss-msss Vuelo de prueba»), nunca «mid».
    if (origen !== '' && codigos[codigos.length - 1] !== origen) {
      codigos.push(origen);
    }
    if (destino !== '') codigos.push(destino);
  }
  return codigos.join('-');
}

const FORMATO_HORA_CANCUN = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Cancun',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Hora de PARED en Cancún (UTC−5) como la escribe la oficina: `H:MM` SIN
 * cero a la izquierda (`6:50`, `7:00`, `10:00`, `16:00`).
 *
 * Cadena vacía si el valor viene nulo o no es un instante válido — nunca
 * lanza: un evento del calendario no se cae por una fecha rara (sale sin
 * hora y el resto del título se lee igual).
 */
export function horaCortaCancun(iso: string | Date | null | undefined): string {
  if (iso == null || iso === '') return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p: Record<string, string> = {};
  for (const parte of FORMATO_HORA_CANCUN.formatToParts(d)) {
    p[parte.type] = parte.value;
  }
  // Intl puede devolver "24" para medianoche según el motor: normalizar.
  const hora = p.hour === '24' ? 0 : Number(p.hour);
  if (!Number.isFinite(hora) || p.minute == null) return '';
  return `${hora}:${p.minute}`;
}

/**
 * TÍTULO de la fila única del vuelo: `{piloto} {AVIÓN} {ruta} {hora}`
 * (`Saab N621TX cun-pce-ctm-pce-cun 6:50`).
 *
 * SIN `T1`, SIN pasajeros y SIN `⚠ permiso pendiente` (15-sep-2026): el
 * color del evento ya dice el pendiente y la descripción lo conserva con
 * todas sus letras. Las partes vacías se omiten (nunca dobles espacios).
 */
export function tituloEventoVuelo(p: {
  pilotoCorto: string;
  aeronave: string;
  ruta: string;
  hora: string;
}): string {
  return [p.pilotoCorto, p.aeronave, p.ruta, p.hora]
    .map((x) => (x ?? '').trim())
    .filter((x) => x !== '')
    .join(' ');
}

/** Un tramo ACTIVO tal como lo lee la descripción del evento único. */
export interface TramoEventoVuelo {
  orden: number;
  origen?: string | null;
  destino?: string | null;
  /** Instante de salida (ISO) o null si el tramo todavía no tiene hora. */
  salida?: string | null;
  ferry?: boolean;
  /** Pasajeros YA resueltos por el llamador (ferry ⇒ irrelevante). */
  pasajeros?: number | null;
  /**
   * Matrícula del tramo SOLO cuando difiere de la del encabezado (vuelo
   * MULTI-AVIÓN, invariante 10). El título trae un solo avión —el del primer
   * tramo activo—, así que sin esto el mecánico no sabría qué avión vuela
   * cada tramo: información que el formato viejo sí daba (un evento por
   * tramo con su matrícula). Vacío/null ⇒ la línea sale igual que siempre.
   */
  aeronave?: string | null;
  /**
   * Nombre CORTO del piloto del tramo, SOLO cuando difiere del encabezado
   * (rotación de piloto a media jornada, caso #129). Mismo criterio.
   */
  piloto?: string | null;
  /**
   * Nota de la oficina para ESTE tramo (`escala.notas`: «QUITAR DOS ASIENTOS»,
   * «Tienen pases»). 20-nov-2026: sale en el bloque NOTAS de la descripción.
   */
  nota?: string | null;
  /**
   * Nota de la parada de SERVICIO de este tramo (`escala.servicio_notas`:
   * «Limpieza de bujías en taller»). El llamador la manda SOLO cuando el
   * tramo es parada de servicio.
   */
  notaServicio?: string | null;
}

/** Todo lo que la descripción del evento único necesita del vuelo. */
export interface DatosEventoVuelo {
  id: string;
  folio: number | string;
  estado: string;
  cliente?: string | null;
  pasajeros: number;
  esExterno: boolean;
  operadorExterno?: string | null;
  matricula?: string | null;
  pilotoNombre?: string | null;
  permisoPendiente?: boolean;
  /**
   * Vuelo de SERVICIO (28-sep-2026, `esVueloDeServicio`): la descripción lo
   * dice con todas sus letras porque en Google el café no existe y el
   * evento sale Mandarina (ver `COLOR_ID_FIJO`).
   */
  servicio?: boolean;
  montoUsd?: number | string | null;
  /** Notas del vuelo (`vuelo.notas`). */
  notas?: string | null;
  /**
   * Notas internas del vuelo (`vuelo.notas_internas`): lo que la oficina
   * escribe en «Notas internas» al dar de alta la operación («Quitar 3
   * asientos») y que la app enseña como «Indicaciones del equipo».
   */
  notasInternas?: string | null;
  tramos: readonly TramoEventoVuelo[];
  /**
   * SOLO en vuelos de VARIOS DÍAS (17-nov-2026, `lineaDiaEventoVuelo`): la
   * primera línea de la descripción dice qué día del vuelo es ESTA fila
   * («Día 1 de 2 · miércoles 18/11/2026 · tramos T1 y T2»). Ausente o vacía ⇒
   * la descripción es byte a byte la del vuelo de un día.
   */
  lineaDia?: string | null;
}

/** Renglón de la descripción de un vuelo de SERVICIO (28-sep-2026). */
export const LINEA_DESCRIPCION_SERVICIO =
  'Vuelo de SERVICIO (taller / parada técnica, sin pasajeros)';

/* ===================================================================== *
 * NOTAS DEL VUELO EN EL EVENTO (20-nov-2026)
 *
 * Pedido de la oficina: «las notas que sí salgan en el Google Calendar por
 * favor porque ese es el que ve nuestro mecánico». El evento solo llevaba
 * `vuelo.notas`, y la oficina escribe sus indicaciones en TRES lugares más:
 * la nota de cada tramo (`escala.notas`: «QUITAR DOS ASIENTOS! SUPER
 * IMPORTANTE», 33 de los 169 vuelos de los últimos 45 días), las notas
 * internas de la operación (`vuelo.notas_internas`: «Dejar solo asiento del
 * capi y copi») y la nota de la parada de servicio (`escala.servicio_notas`:
 * «Limpieza de bujías en taller»). Nada de eso llegaba a Google.
 *
 * Van en UN bloque AL PRINCIPIO de la descripción (es lo que el mecánico no
 * puede pasar por alto) y cada nota de tramo dice de cuál tramo es, con la
 * misma etiqueta de su línea (`T1 cun-czm`).
 * ===================================================================== */

/** Encabezado del bloque de notas de la descripción. */
export const TITULO_NOTAS_EVENTO = 'NOTAS:';

/** Tope de caracteres de UN renglón de nota (lo que pase se corta con «…»). */
export const NOTA_EVENTO_MAX_CARACTERES = 300;

/**
 * Tope de renglones del bloque: la descripción de un evento de Google admite
 * 8,192 caracteres y debajo van el folio, los tramos y el ancla.
 */
export const NOTAS_EVENTO_MAX_RENGLONES = 20;

/**
 * Los renglones de UNA nota: uno por línea capturada, sin espacios de sobra,
 * sin líneas vacías y con el tope de caracteres. Nunca lanza.
 */
function renglonesDeNota(texto: string | null | undefined): string[] {
  if (typeof texto !== 'string') return [];
  return texto
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .map((l) =>
      l.length > NOTA_EVENTO_MAX_CARACTERES
        ? `${l.slice(0, NOTA_EVENTO_MAX_CARACTERES - 1).trimEnd()}…`
        : l,
    );
}

/**
 * Los renglones del bloque NOTAS (sin el encabezado), en este orden: notas
 * del vuelo, notas internas y, por tramo, su nota y la de su parada de
 * servicio. `[]` cuando el vuelo no tiene ninguna.
 *
 * - Cada renglón empieza con «• »; los de tramo dicen cuál (`T1 cun-czm:`) y
 *   los de servicio lo marcan (`T2 czm-mid · servicio:`).
 * - Un renglón REPETIDO (la misma indicación en «Notas» y en «Notas
 *   internas») sale una sola vez.
 * - Con más de `NOTAS_EVENTO_MAX_RENGLONES` se corta y se DICE cuántos
 *   faltan: nunca se esconde una nota en silencio.
 */
export function notasEventoVuelo(
  v: Pick<DatosEventoVuelo, 'notas' | 'notasInternas' | 'tramos'>,
): string[] {
  const renglones: string[] = [];
  const vistos = new Set<string>();
  const agregar = (prefijo: string, texto: string | null | undefined) => {
    for (const r of renglonesDeNota(texto)) {
      const renglon = `• ${prefijo}${r}`;
      const clave = renglon.toLowerCase();
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      renglones.push(renglon);
    }
  };
  agregar('', v.notas);
  agregar('', v.notasInternas);
  for (const t of v.tramos ?? []) {
    const etiqueta = [`T${t.orden}`, rutaMinusculas([t])]
      .filter((x) => x !== '')
      .join(' ');
    agregar(`${etiqueta}: `, t.nota);
    agregar(`${etiqueta} · servicio: `, t.notaServicio);
  }
  if (renglones.length <= NOTAS_EVENTO_MAX_RENGLONES) return renglones;
  const faltan = renglones.length - NOTAS_EVENTO_MAX_RENGLONES;
  return [
    ...renglones.slice(0, NOTAS_EVENTO_MAX_RENGLONES),
    `• … y ${faltan} nota${faltan === 1 ? '' : 's'} más: ver el vuelo en VuelaTour`,
  ];
}

/**
 * DESCRIPCIÓN del evento único, con el desglose por tramo que el título ya
 * no lleva (formato de la oficina: una línea por tramo, como los
 * `cun-ctm | paxs | ctm-cun (15:00)` que escribían a mano).
 *
 * 20-nov-2026: (1) las NOTAS —del vuelo, internas, de cada tramo y de la
 * parada de servicio— van en un bloque al principio (`notasEventoVuelo`); la
 * línea suelta `Notas: …` del final ya no existe. (2) La línea `Pasajeros: N`
 * del vuelo ya NO sale cuando hay líneas de tramo: cada tramo dice los suyos
 * («· 2 pax» / «· ferry») y el número del vuelo podía decir otra cosa (pedido
 * de la oficina sobre la app: «este dice una cosa y los detalles dice otra»).
 *
 * La última línea es el ANCLA legible `VuelaTour · vuelo <id>`: el ancla de
 * verdad vive en `extendedProperties.private`, pero esta se ve desde la app
 * de Google y ayuda a la oficina a saber que el evento es del sistema.
 */
export function descripcionEventoVuelo(v: DatosEventoVuelo): string {
  const lineaDia = (v.lineaDia ?? '').trim();
  const notas = notasEventoVuelo(v);
  const lineas: Array<string | null> = [
    // Vuelo de varios días: lo PRIMERO que se lee es qué día es esta fila.
    lineaDia !== '' ? lineaDia : null,
    // Las indicaciones de la oficina, antes que los datos del vuelo.
    ...(notas.length > 0 ? [TITULO_NOTAS_EVENTO, ...notas, ''] : []),
    `Folio: #${v.folio}`,
    `Estado: ${v.estado}`,
    v.servicio ? LINEA_DESCRIPCION_SERVICIO : null,
    `Cliente: ${v.cliente ?? '—'}`,
    // Solo sin líneas de tramo (no debería pasar: el espejo siempre arma al
    // menos una); con ellas, los pasajeros se leen en cada tramo.
    v.tramos.length === 0 ? `Pasajeros: ${v.pasajeros}` : null,
    v.esExterno
      ? `Operador externo: ${v.operadorExterno ?? '—'}`
      : `Aeronave: ${v.matricula ?? '—'}`,
    `Piloto: ${v.esExterno ? '(externo)' : (v.pilotoNombre ?? 'sin asignar')}`,
    v.permisoPendiente ? 'Permiso de pista: PENDIENTE' : null,
    ...v.tramos.map((t) => {
      const ruta = rutaMinusculas([t]);
      const hora = horaCortaCancun(t.salida);
      const detalle = t.ferry ? 'ferry' : `${t.pasajeros ?? v.pasajeros} pax`;
      // Avión y piloto del tramo SOLO si difieren del encabezado: en el 99 %
      // de los vuelos no aparecen (línea idéntica a la de siempre) y en un
      // multi-avión o una rotación dicen lo que el título ya no puede decir.
      const extras = [t.aeronave, t.piloto]
        .map((x) => (x ?? '').trim())
        .filter((x) => x !== '');
      return [
        `T${t.orden} ${[ruta, hora].filter((x) => x !== '').join(' ')} · ${detalle}`,
        ...extras,
      ].join(' · ');
    }),
    v.montoUsd == null || v.montoUsd === ''
      ? null
      : `Monto: $${Number(v.montoUsd)} USD`,
    '',
    `VuelaTour · vuelo ${v.id}`,
  ];
  return lineas.filter((l) => l != null).join('\n');
}

/** Duración MÍNIMA del evento único: 1 h (un vuelo nunca es un punto). */
export const EVENTO_VUELO_MIN_MS = 60 * 60 * 1000;

/** Colchón que se le suma al último instante conocido del vuelo. */
export const EVENTO_VUELO_COLCHON_MS = 60 * 60 * 1000;

/**
 * Tope de duración del evento único. Una `fecha_traslado_final` capturada con
 * el año equivocado (pasa) pintaría en el calendario del mecánico una barra
 * de meses encima de TODO lo demás. Un viaje real con pernoctas no pasa de
 * unos días; 30 es holgado y visible.
 */
export const EVENTO_VUELO_TOPE_DIAS = 30;

/**
 * VENTANA del evento único (UNA SOLA FILA, 15-sep-2026): empieza en la salida
 * del primer tramo activo y termina en el instante conocido MÁS TARDÍO del
 * vuelo + 1 h, nunca menos de 1 h. Así un redondo es una fila 10:00–19:00 y
 * un viaje con pernocta abarca sus días, en vez de dos bloques sueltos de 2 h.
 *
 * `null` si el inicio no es un instante válido (no hay dónde poner la fila).
 * Instantes ANTERIORES al inicio o más allá del tope se ignoran (dato roto).
 */
export function ventanaEventoVuelo(
  inicioIso: string | Date | null | undefined,
  finesPosibles: ReadonlyArray<string | Date | null | undefined> = [],
): { inicio: Date; fin: Date } | null {
  if (inicioIso == null || inicioIso === '') return null;
  const inicio = inicioIso instanceof Date ? inicioIso : new Date(inicioIso);
  if (Number.isNaN(inicio.getTime())) return null;
  const tope = inicio.getTime() + EVENTO_VUELO_TOPE_DIAS * 24 * 60 * 60 * 1000;
  let ultimo = inicio.getTime();
  for (const candidato of finesPosibles) {
    if (candidato == null || candidato === '') continue;
    const d = candidato instanceof Date ? candidato : new Date(candidato);
    const ms = d.getTime();
    if (Number.isNaN(ms) || ms <= ultimo || ms > tope) continue;
    ultimo = ms;
  }
  const fin = Math.max(
    ultimo + EVENTO_VUELO_COLCHON_MS,
    inicio.getTime() + EVENTO_VUELO_MIN_MS,
  );
  return { inicio, fin: new Date(fin) };
}

/* ===================================================================== *
 * UNA FILA POR DÍA EN LOS VUELOS DE VARIOS DÍAS (17-nov-2026, vuelo #478)
 *
 * Reporte de la oficina: «por ser un vuelo de dos días no sé por qué lo
 * manda a la barrita de arriba […] estaría bien que se mostrara normal».
 * Google pinta en la franja de «todo el día» cualquier evento de 24 h o más,
 * y la fila única del #478 iba del 18-nov 10:00 al 19-nov 13:00.
 *
 * La decisión del cliente del 15-sep («una sola fila por vuelo») NO cambia
 * para el vuelo de UN día: sale exactamente igual. Un vuelo cuyos tramos
 * ACTIVOS salen en DOS O MÁS días de Cancún se publica como UNA FILA POR DÍA
 * CON SALIDAS, cada una en su hora y de menos de 24 h, con el mismo formato
 * de título pero con la ruta y la hora DE ESE DÍA. Los días intermedios sin
 * salidas no llevan fila.
 * ===================================================================== */

const FORMATO_DIA_CANCUN = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Cancun',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Día de calendario en Cancún (UTC−5) de un instante, como `YYYY-MM-DD`.
 * `null` si el valor viene nulo o no es un instante válido — nunca lanza.
 */
export function diaCancunDe(
  iso: string | Date | null | undefined,
): string | null {
  if (iso == null || iso === '') return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p: Record<string, string> = {};
  for (const parte of FORMATO_DIA_CANCUN.formatToParts(d)) {
    p[parte.type] = parte.value;
  }
  if (!p.year || !p.month || !p.day) return null;
  return `${p.year}-${p.month}-${p.day}`;
}

/** Los tramos que SALEN un mismo día de Cancún. */
export interface DiaEventoVuelo<T> {
  /** Día de Cancún `YYYY-MM-DD`. */
  dia: string;
  /** Tramos de ese día, en el orden en que llegaron (el de `orden`). */
  tramos: T[];
}

/**
 * Parte los tramos de un vuelo por DÍA DE CANCÚN de su `salida` (PURA).
 *
 * - Devuelve un grupo por día CON salidas, en orden cronológico, y dentro de
 *   cada grupo los tramos en el orden en que llegaron. Los días sin salidas
 *   no existen: de un viaje 18 → 20 salen dos grupos, no tres.
 * - Un tramo SIN `salida` (o con una fecha ilegible) va con el día del tramo
 *   ANTERIOR que sí la tiene; si no hay anterior —es de los primeros—, con el
 *   día del primer tramo con fecha. Nunca abre un día por sí solo.
 * - Los tramos del MISMO día quedan en UN solo grupo aunque no vengan
 *   seguidos (dato roto): jamás dos grupos —dos filas en Google— del mismo
 *   día.
 * - Sin NINGÚN tramo con fecha no hay días: `[]`. En cualquier otro caso cada
 *   tramo de entrada aparece en exactamente un grupo.
 *
 * Un vuelo es «de varios días» cuando esto devuelve DOS o más grupos.
 */
export function partirTramosPorDia<T extends { salida?: string | Date | null }>(
  tramos: readonly T[],
): Array<DiaEventoVuelo<T>> {
  const porDia = new Map<string, T[]>();
  // Tramos sin fecha que van ANTES del primero que sí la tiene.
  const sinFechaAlInicio: T[] = [];
  let diaVigente: string | null = null;
  for (const t of tramos ?? []) {
    const dia: string | null = diaCancunDe(t?.salida) ?? diaVigente;
    if (dia == null) {
      sinFechaAlInicio.push(t);
      continue;
    }
    diaVigente = dia;
    const grupo = porDia.get(dia);
    if (grupo) grupo.push(t);
    else if (porDia.size === 0) porDia.set(dia, [...sinFechaAlInicio, t]);
    else porDia.set(dia, [t]);
  }
  return [...porDia.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dia, delDia]) => ({ dia, tramos: delDia }));
}

/**
 * Tope de la fila de UN día: 23 h 59 min. Con 24 h o más Google la sube a la
 * franja de «todo el día», que es justo lo que la fila por día viene a
 * evitar. Solo se alcanza con una primera salida de madrugada y una última
 * casi a medianoche del mismo día.
 */
export const EVENTO_DIA_TOPE_MS = 24 * 60 * 60 * 1000 - 60 * 1000;

/**
 * VENTANA de la fila de UN día de un vuelo de varios días (PURA): de la
 * PRIMERA salida de ese día a su último instante conocido + 1 h — la misma
 * regla de `ventanaEventoVuelo` (1 h mínima), acotada a ese día y a menos de
 * 24 h.
 *
 * `fecha_traslado_final` solo cuenta en el día en que cae: si es de otro día
 * (o de uno sin salidas) no estira esta fila. Un tramo sin fecha que heredó
 * el día no aporta instante. `null` si el grupo no trae ninguna salida de
 * ese día (no hay dónde poner la fila).
 */
export function ventanaDiaEventoVuelo(
  grupo: DiaEventoVuelo<{ salida?: string | Date | null }>,
  fechaTrasladoFinal?: string | Date | null,
): { inicio: Date; fin: Date } | null {
  const salidas: number[] = [];
  for (const t of grupo?.tramos ?? []) {
    if (diaCancunDe(t?.salida) !== grupo.dia) continue;
    salidas.push(new Date(t.salida as string | Date).getTime());
  }
  if (salidas.length === 0) return null;
  const inicio = new Date(Math.min(...salidas));
  const ventana = ventanaEventoVuelo(inicio, [
    ...salidas.map((ms) => new Date(ms)),
    diaCancunDe(fechaTrasladoFinal) === grupo.dia ? fechaTrasladoFinal : null,
  ]);
  if (!ventana) return null;
  const tope = inicio.getTime() + EVENTO_DIA_TOPE_MS;
  return {
    inicio: ventana.inicio,
    fin: new Date(Math.min(ventana.fin.getTime(), tope)),
  };
}

const DIAS_SEMANA = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

/**
 * `miércoles 18/11/2026`: día de la semana + fecha DD/MM/AAAA de un día
 * `YYYY-MM-DD`. Sin `Intl` a propósito: el nombre del día no depende de los
 * datos de idioma con que venga compilado Node. Cadena vacía si no es un día
 * válido (nunca lanza).
 */
export function fechaLargaDia(dia: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dia ?? '').trim());
  if (!m) return '';
  const [, anio, mes, diaMes] = m;
  const d = new Date(Date.UTC(Number(anio), Number(mes) - 1, Number(diaMes)));
  // `Date.UTC` acepta «2026-02-31» y lo corre a marzo: eso no es un día.
  if (
    d.getUTCFullYear() !== Number(anio) ||
    d.getUTCMonth() !== Number(mes) - 1 ||
    d.getUTCDate() !== Number(diaMes)
  ) {
    return '';
  }
  return `${DIAS_SEMANA[d.getUTCDay()]} ${diaMes}/${mes}/${anio}`;
}

/**
 * PRIMERA LÍNEA de la descripción en un vuelo de varios días: qué día del
 * vuelo es ESTA fila y qué tramos de la lista de abajo salen ese día (las
 * líneas de los tramos traen la hora, no la fecha):
 * `Día 1 de 2 · miércoles 18/11/2026 · tramos T1 y T2`.
 *
 * «Día N de M» cuenta los días CON salidas (los intermedios sin salidas no
 * llevan fila); la fecha va completa para que no haya duda.
 */
export function lineaDiaEventoVuelo(p: {
  numero: number;
  total: number;
  dia: string;
  ordenes?: readonly number[];
}): string {
  const etiquetas = (p.ordenes ?? []).map((o) => `T${o}`);
  const lista =
    etiquetas.length <= 1
      ? etiquetas.join('')
      : `${etiquetas.slice(0, -1).join(', ')} y ${etiquetas[etiquetas.length - 1]}`;
  return [
    `Día ${p.numero} de ${p.total}`,
    fechaLargaDia(p.dia),
    lista === ''
      ? ''
      : `${etiquetas.length === 1 ? 'tramo' : 'tramos'} ${lista}`,
  ]
    .filter((x) => x !== '')
    .join(' · ');
}

/**
 * `extendedProperties.private.vuelatour_tramo` de la fila del vuelo.
 * `'vuelo'` = la fila del vuelo de un día y la del DÍA 1 de uno de varios
 * (id en `vuelo.google_calendar_id`).
 */
export const ETIQUETA_FILA_VUELO = 'vuelo';

/**
 * Etiqueta de la fila del día N (1 = primero): `'vuelo'` para el día 1 y
 * `'dia-N'` para los siguientes (`'dia-2'`, `'dia-3'`…).
 *
 * Es INFORMATIVA (sirve para leer un evento desde la API de Google): ningún
 * paso de limpieza decide por ella. Lo que hace legítima a una fila es que su
 * id esté guardado en la base (`vuelo.google_calendar_id`,
 * `vuelo.google_calendar_regreso_id` o `escala.google_calendar_id`); los
 * valores `'ida'` / `'regreso'` / `'leg-N'` son del formato anterior al
 * 15-sep-2026.
 */
export function etiquetaFilaVuelo(numeroDia: number): string {
  return Number.isInteger(numeroDia) && numeroDia >= 2
    ? `dia-${numeroDia}`
    : ETIQUETA_FILA_VUELO;
}

/**
 * Código HTTP que trae un error de la API de Google (`GaxiosError`), mirando
 * los tres lugares donde googleapis lo deja según la versión: `status`,
 * `code` (número o string de 3 dígitos) y `response.status`.
 * `null` si es un error de red o cualquier otra cosa sin código HTTP.
 */
export function estadoHttpGoogle(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null;
  const e = err as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown } | null;
  };
  for (const v of [e.status, e.code, e.response?.status]) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599)
      return v;
    if (typeof v === 'string' && /^[1-5]\d{2}$/.test(v)) return Number(v);
  }
  return null;
}

/**
 * ¿El error dice que el evento YA NO EXISTE en Google (404 Not Found / 410
 * Gone)? Es la ÚNICA condición que autoriza a re-crear un evento que ya
 * tenía id guardado: ante cualquier otro fallo (403 de cuota, 429, 5xx, red)
 * re-crear duplicaría el evento en el calendario de la oficina y dejaría al
 * anterior huérfano — el id viejo se conserva y se reintenta después.
 */
export function eventoAusenteEnGoogle(err: unknown): boolean {
  const s = estadoHttpGoogle(err);
  return s === 404 || s === 410;
}

/** Credenciales mínimas de la service account que necesita `google-auth-library`. */
export interface CredencialesServiceAccount {
  client_email: string;
  private_key: string;
}

/**
 * Motivo de un `JSON.parse` fallido SIN eco del valor (revisión adversaria
 * 12-sep-2026). V8 cita un trozo de la ENTRADA en algunos mensajes
 * (`Unexpected token 'x', "x{\"priva"... is not valid JSON`) y esa entrada es
 * el JSON de la service account —con su llave PRIVADA—. Este mensaje termina
 * en `motivoInactivo` y viaja en `GET /v1/calendar/sync-estado`, que leen
 * ADMIN/COORDINADOR/ANALISTA/FACTURACION/SOCIO y que el panel pinta VERBATIM
 * en su chip. Se conserva la POSICIÓN del error (es lo útil para arreglarlo y
 * no es secreta) y se borra cualquier fragmento entrecomillado.
 */
function motivoJsonSinValor(err: unknown): string {
  const bruto = err instanceof Error ? err.message : String(err);
  return bruto
    .replace(/"(?:[^"\\]|\\.)*"/g, '«…»')
    .replace(/'(?:[^'\\]|\\.)*'/g, '«…»')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * Lee `GOOGLE_SERVICE_ACCOUNT_JSON` con tolerancia a cómo suele quedar pegada
 * en un panel de variables (incidente Railway 12-sep-2026: el valor quedó
 * entre comillas dobles y `JSON.parse` falló con «Unexpected non-whitespace
 * character after JSON at position 3»):
 * - recorta espacios y UN par de comillas envolventes (`"{…}"` o `'{…}'`);
 * - si no empieza con `{`, prueba a decodificarla como base64;
 * - normaliza `\\n` literales dentro de `private_key` (algunos paneles
 *   escapan los saltos de línea de la llave PEM).
 * Lanza un Error con un mensaje SIN secretos (jamás incluye el valor).
 */
export function parsearServiceAccountJson(
  raw: string,
): CredencialesServiceAccount {
  let texto = (raw ?? '').trim();
  if (
    texto.length >= 2 &&
    ((texto.startsWith('"') && texto.endsWith('"')) ||
      (texto.startsWith("'") && texto.endsWith("'")))
  ) {
    texto = texto.slice(1, -1).trim();
  }
  if (!texto.startsWith('{')) {
    try {
      const decodificado = Buffer.from(texto, 'base64').toString('utf8').trim();
      if (decodificado.startsWith('{')) texto = decodificado;
    } catch {
      /* no era base64: sigue con el texto tal cual */
    }
  }
  let obj: unknown;
  try {
    obj = JSON.parse(texto);
  } catch (err) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON no es un JSON válido (${motivoJsonSinValor(err)}). Debe ser el contenido del archivo de la service account en UNA línea, sin comillas alrededor.`,
    );
  }
  const o = (obj ?? {}) as Record<string, unknown>;
  const email = typeof o.client_email === 'string' ? o.client_email.trim() : '';
  const key =
    typeof o.private_key === 'string'
      ? o.private_key.replace(/\\n/g, '\n')
      : '';
  if (!email || !key) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON no trae client_email/private_key: pega el JSON completo de la service account.',
    );
  }
  return { client_email: email, private_key: key };
}
