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
