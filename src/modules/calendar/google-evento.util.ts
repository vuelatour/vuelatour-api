/**
 * Helpers PUROS del espejo sistema → Google Calendar (12-sep-2026).
 *
 * Viven aparte de `calendar-sync.service` a propósito: se prueban sin tocar
 * ni Supabase ni la API de Google (el cliente de Google JAMÁS se llama en
 * pruebas) y los usa también cualquier otro lector que necesite el mismo
 * criterio de color o de nombre corto.
 */

import {
  DESCANSO_COLOR,
  EVENTO_COLOR,
  SIN_AVION_COLOR,
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
 * Mapea un color del sistema (`aeronave.color_calendario`, hex #RRGGBB) al
 * `colorId` de Google MÁS CERCANO, para que el Google Calendar de la oficina
 * espeje los colores por avión del calendario interno.
 *
 * Devuelve `null` cuando no hay color o no es un hex válido: el llamador cae
 * al gris "sin avión" del sistema — nunca se inventa un color.
 *
 * LIMITACIÓN CONOCIDA (documentada, no es un bug): Google solo tiene 11
 * colores de evento, así que dos cosas del sistema con hex parecidos caen en
 * el MISMO colorId (hoy: XA-VGV cian, N990GG azul y el evento de flota →
 * Pavo real; N58BT lima, XB-ANU amarillo, el permiso pendiente y el
 * mantenimiento PROGRAMADO → Banana). La tabla completa de colisiones está
 * congelada en `google-evento.util.spec.ts`. Si el cliente quiere colores
 * únicos, se separan los `color_calendario` del sistema; aquí no se reparten
 * colores "libres" porque eso dejaría de ser puro (dependería de la flota).
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
 * ESPEJO DE COLOR (pedido del cliente, 12-sep-2026): «los mismos colores que
 * usamos para cada cosa». Google solo acepta 11 colores de evento, así que
 * «el mismo color» = el colorId MÁS CERCANO al hex que el calendario del
 * sistema usa para esa cosa, con LA MISMA PRECEDENCIA
 * (`colores-calendario.util`). Ninguna de estas funciones inventa un color
 * propio: todas salen de un hex del sistema.
 *
 * Fallback cuando el hex del sistema no se puede leer (un
 * `color_calendario` con basura en la BD): el gris "sin avión" del sistema,
 * nunca un color con significado.
 */
const COLOR_ID_SIN_AVION: string = colorIdGoogleDe(SIN_AVION_COLOR) ?? '1';

/**
 * colorId de Google de UN evento de vuelo (vuelo completo o tramo): el hex que
 * el sistema pintaría, traducido. Mismos parámetros que `colorVueloSistema`
 * — el cancelado no llega aquí (en Google su evento se BORRA).
 *
 * Con los hex de hoy: tentativo → 8 Grafito, sin asignar → 1 Lavanda,
 * permiso pendiente → 5 Banana, externo → 4 Flamenco, sin avión → 1 Lavanda.
 */
export function colorIdGoogleDeVuelo(p: ParamsColorVuelo): string {
  return colorIdGoogleDe(colorVueloSistema(p)) ?? COLOR_ID_SIN_AVION;
}

/** colorId del DESCANSO de piloto: #14B8A6 (turquesa) → 2 Salvia. */
export function colorIdGoogleDescanso(): string {
  return colorIdGoogleDe(DESCANSO_COLOR) ?? COLOR_ID_SIN_AVION;
}

/**
 * colorId de un evento NO-vuelo de la flota: con avión, el COLOR DEL AVIÓN
 * (igual que el calendario del sistema, que antes Google ignoraba); sin
 * avión, el azul cielo propio #0EA5E9 → 7 Pavo real.
 */
export function colorIdGoogleEvento(colorAvion?: string | null): string {
  return (
    colorIdGoogleDe(colorEventoFlotaSistema(colorAvion)) ??
    colorIdGoogleDe(EVENTO_COLOR) ??
    COLOR_ID_SIN_AVION
  );
}

/**
 * Tomate: el rojo REAL de Google. Ver el cálculo en
 * `colorIdGoogleMantenimiento` (el nearest de #EF4444 sería Mandarina).
 */
const COLOR_ID_TALLER_FIJO = '11';

/**
 * colorId de un mantenimiento: PROGRAMADO = ámbar del sistema (#F59E0B) →
 * 5 Banana.
 *
 * EN_TALLER se FIJA en 11 Tomate a propósito: el rojo del sistema (#EF4444)
 * por distancia redmean cae en 6 Mandarina (d=3,714) antes que en 4 Flamenco
 * (17,375) y que en 11 Tomate (30,217) — Mandarina es el naranja de N4142R y
 * el taller debe leerse como ROJO. Es la ÚNICA excepción al "más cercano",
 * y es visible: `MANTENIMIENTO_TALLER_COLOR` sigue siendo el hex del sistema.
 */
export function colorIdGoogleMantenimiento(enTaller: boolean): string {
  if (enTaller) return COLOR_ID_TALLER_FIJO;
  return (
    colorIdGoogleDe(colorMantenimientoSistema(false)) ?? COLOR_ID_SIN_AVION
  );
}

/**
 * Nombre CORTO del piloto para el título del evento: la oficina identifica
 * el vuelo por el piloto (pedido del cliente, 12-sep-2026), y en el título
 * de Google solo cabe el primer nombre.
 *
 * - vuelo externo ⇒ `'externo'` (la tripulación es del operador, no nuestra);
 * - sin piloto asignado ⇒ `'sin piloto'` (acción pendiente, visible);
 * - con piloto ⇒ su PRIMER nombre tal cual está capturado (acentos incluidos).
 */
export function nombreCortoPiloto(
  nombre: string | null | undefined,
  esExterno = false,
): string {
  if (esExterno) return 'externo';
  const limpio = (nombre ?? '').trim().replace(/\s+/g, ' ');
  if (limpio.length === 0) return 'sin piloto';
  return limpio.split(' ')[0];
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
