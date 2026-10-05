/**
 * Día operativo en hora Cancún (UTC−5, sin horario de verano). FUENTE ÚNICA
 * para "¿qué día es hoy?" al escribir columnas `date` (cardex de inventario,
 * cortes) desde el API: el servidor y el `current_date` de Postgres viven en
 * UTC, así que de las 19:00 a las 23:59 de Cancún ya es "mañana" para ellos
 * — una SALIDA capturada a esa hora quedaba fechada ANTES que la ENTRADA del
 * mismo día en el cardex (stock fantasma y doble cargo FIFO).
 */

const FORMATO_DIA_CANCUN = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Cancun',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Fecha YYYY-MM-DD del instante dado (default ahora) en hora Cancún. */
export function hoyCancun(d: Date = new Date()): string {
  return FORMATO_DIA_CANCUN.format(d);
}

/**
 * Día Cancún (YYYY-MM-DD) de un ISO/timestamp; una fecha ya en formato
 * YYYY-MM-DD se respeta tal cual (es una fecha de pared, no un instante).
 */
export function diaCancun(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: ${iso}`);
  return hoyCancun(d);
}

/**
 * Resta meses calendario a una fecha de pared YYYY-MM-DD (sin zona: mediodía
 * UTC). Si el día no existe en el mes destino, JS lo desborda al siguiente
 * (31-mar − 1 mes → 3-mar): aceptable para ventanas "últimos N meses".
 */
export function restarMeses(dia: string, meses: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  if (!m) throw new Error(`Fecha inválida: ${dia}`);
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1 - meses, Number(m[3]), 12),
  );
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: ${dia}`);
  return d.toISOString().slice(0, 10);
}

const FORMATO_FECHA_HORA_CANCUN = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Cancun',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Fecha y hora "YYYY-MM-DD HH:mm" de un instante en hora Cancún (para
 * celdas de texto en Excel y textos de auditoría). Cadena vacía si el valor
 * viene nulo o no es un instante válido — nunca lanza (un reporte no se cae
 * por una fila rara).
 */
export function fechaHoraCancun(iso: string | Date | null | undefined): string {
  if (iso == null || iso === '') return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p: Record<string, string> = {};
  for (const parte of FORMATO_FECHA_HORA_CANCUN.formatToParts(d)) {
    p[parte.type] = parte.value;
  }
  // Intl puede devolver "24" para medianoche según el motor: normalizar.
  const hora = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hora}:${p.minute}`;
}

const FORMATO_CORTO_CANCUN = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Cancun',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * "lun 14 sep" o, con `hora`, "lun 14 sep 09:00" en hora Cancún (textos de
 * avisos y títulos de la app, 9-sep-2026). Se arma por partes: el formato
 * es-MX de Intl mete "14 de sep," y puntos según el motor. Cadena vacía si
 * el valor no es un instante válido — nunca lanza.
 */
export function fechaCortaCancun(
  iso: string | Date | null | undefined,
  opts: { hora?: boolean } = {},
): string {
  if (iso == null || iso === '') return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p: Record<string, string> = {};
  for (const parte of FORMATO_CORTO_CANCUN.formatToParts(d)) {
    p[parte.type] = parte.value;
  }
  const limpiar = (v: string | undefined) => (v ?? '').replace(/[.,]/g, '');
  const dia =
    `${limpiar(p.weekday)} ${limpiar(p.day)} ${limpiar(p.month)}`.trim();
  if (!opts.hora) return dia;
  const hora = p.hour === '24' ? '00' : p.hour;
  return `${dia} ${hora}:${p.minute}`;
}

/**
 * Días calendario de `desde` a `hasta` (ambas YYYY-MM-DD, días de pared
 * Cancún): positivo si `hasta` es posterior. Aritmética de fechas sin zona
 * (mediodía UTC), así que no le afecta ningún cambio de horario.
 */
export function diasEntreDiasCancun(desde: string, hasta: string): number {
  const ms = (dia: string): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
    if (!m) throw new Error(`Fecha inválida: ${dia}`);
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  };
  return Math.round((ms(hasta) - ms(desde)) / 86_400_000);
}

const FORMATO_PARED_CANCUN = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Cancun',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Desfase de Cancún (hora de pared − UTC, en ms) en el instante dado. */
function desfaseCancunMs(ms: number): number {
  const p: Record<string, string> = {};
  for (const parte of FORMATO_PARED_CANCUN.formatToParts(new Date(ms))) {
    p[parte.type] = parte.value;
  }
  const pared = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    p.hour === '24' ? 0 : Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return pared - Math.floor(ms / 1000) * 1000;
}

/**
 * Mueve un instante `dias` días calendario CONSERVANDO SU HORA DE PARED en
 * Cancún (09:00 del 10-oct + 3 ⇒ 09:00 del 13-oct), segundos y milisegundos
 * incluidos. Nunca suma 86 400 s a ciegas: si el desfase de Cancún cambió
 * entre ambos días (horario de verano, vigente hasta 2015) se compensa. ISO
 * UTC de salida; lanza con una fecha inválida o días no enteros.
 */
export function moverDiasHoraParedCancun(
  iso: string | Date,
  dias: number,
): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Fecha inválida: ${String(iso)}`);
  }
  if (!Number.isInteger(dias)) throw new Error(`Días inválidos: ${dias}`);
  const t0 = d.getTime();
  const base = t0 + dias * 86_400_000;
  const desfase0 = desfaseCancunMs(t0);
  let t = base;
  // Dos vueltas bastan: la segunda solo confirma el desfase del destino.
  for (let i = 0; i < 2; i += 1) {
    const siguiente = base + desfase0 - desfaseCancunMs(t);
    if (siguiente === t) break;
    t = siguiente;
  }
  return new Date(t).toISOString();
}
