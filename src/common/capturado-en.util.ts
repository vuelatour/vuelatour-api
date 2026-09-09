import { BadRequestException } from '@nestjs/common';

/**
 * `gasto.capturado_en` (7-sep-2026): momento REAL en que la persona capturó
 * el gasto, aparte de la fecha del consumo (`fecha_gasto`) y de la llegada
 * al servidor (`created_at`). La app lo manda al guardar — aunque esté sin
 * señal y el outbox lo suba horas después —; el panel, las cargas masivas y
 * los gastos que fabrica el sistema (pistas, bodega) lo dejan = ahora.
 *
 * SOLO auditoría/lectura: no participa en dinero, cortes ni ventanas de
 * edición (esas siguen contando desde `created_at`).
 *
 * FUENTE ÚNICA de la regla: TODO camino que inserte en `gasto` sella la
 * columna con `resolverCapturadoEn` (alta con DTO) o `capturadoAhora()`
 * (inserts directos) — la migración no puso DEFAULT, así que un insert que
 * la omita queda NULL.
 */

/** Tolerancia hacia el futuro: reloj del teléfono un poco adelantado. */
export const CAPTURADO_EN_FUTURO_MAX_MS = 10 * 60_000;
/** Antes de esto no existía el sistema: es un año/reloj absurdo. */
export const CAPTURADO_EN_MIN_MS = Date.parse('2020-01-01T00:00:00Z');

/**
 * ISO 8601 CON zona horaria: `...Z` o `±HH:MM`/`±HHMM`. Un instante "a
 * secas" (2026-09-05T14:32:00) lo interpretaría Postgres en UTC y el gasto
 * quedaría 5 horas corrido en el panel — se rechaza con el formato a la vista.
 */
const ISO_CON_ZONA =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export const CAPTURADO_EN_EJEMPLO = '2026-09-05T14:32:00-05:00';

/**
 * Valor a escribir en `capturado_en` para un ALTA:
 * - sin valor → `ahora` (servidor): panel, cargas masivas, backfills;
 * - con valor → se valida (zona obligatoria, no futuro > 10 min, no antes de
 *   2020) y se normaliza a ISO UTC (es un instante; la zona de captura no se
 *   conserva — el panel y la app lo muestran en hora Cancún).
 * Lanza 400 legible; nunca guarda en silencio un valor raro.
 */
export function resolverCapturadoEn(
  valor: string | null | undefined,
  ahora: Date = new Date(),
): string {
  if (valor == null || valor === '') return ahora.toISOString();
  const texto = String(valor).trim();
  if (!ISO_CON_ZONA.test(texto)) {
    throw new BadRequestException(
      `capturado_en debe ser una fecha y hora ISO 8601 CON zona horaria (ej. ${CAPTURADO_EN_EJEMPLO}); se recibió "${texto}".`,
    );
  }
  const ms = Date.parse(texto);
  if (!Number.isFinite(ms)) {
    throw new BadRequestException(
      `capturado_en no es una fecha válida: "${texto}" (ej. ${CAPTURADO_EN_EJEMPLO}).`,
    );
  }
  if (ms > ahora.getTime() + CAPTURADO_EN_FUTURO_MAX_MS) {
    throw new BadRequestException(
      `capturado_en está en el futuro (${texto}): revisa la hora del dispositivo antes de guardar.`,
    );
  }
  if (ms < CAPTURADO_EN_MIN_MS) {
    throw new BadRequestException(
      `capturado_en (${texto}) es anterior a 2020: revisa la fecha/hora del dispositivo antes de guardar.`,
    );
  }
  return new Date(ms).toISOString();
}

/** Sello "capturado ahora" para los inserts directos en `gasto` (sin DTO). */
export function capturadoAhora(ahora: Date = new Date()): string {
  return ahora.toISOString();
}

// ===== Sello TOLERANTE para reserva/evento (diseño offline v2, 9-sep-2026) =====
//
// A diferencia de `resolverCapturadoEn` (gastos: 400 ante un valor raro), el
// alta de un VUELO/EVENTO desde el outbox de la app NUNCA se rechaza por
// `capturado_en`: es solo auditoría y un 400 mataría para siempre la captura
// (la app volvería a sellar con el mismo reloj en cada reintento). Aquí el
// valor raro se deja constancia y se sigue.

const FMT_SELLO_CANCUN = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Cancun',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "14 sep 09:00" en hora Cancún (día · mes corto · HH:mm). */
export function fechaSelloCancun(d: Date): string {
  const p: Record<string, string> = {};
  for (const parte of FMT_SELLO_CANCUN.formatToParts(d)) {
    p[parte.type] = parte.value;
  }
  const hora = p.hour === '24' ? '00' : p.hour;
  // "sep." (con punto, según motor) → "sep".
  const mes = (p.month ?? '').replace(/\.$/, '');
  return `${p.day} ${mes} ${hora}:${p.minute}`;
}

/** Diferencia mínima para que valga la pena dejar el sello (ruido si no). */
export const SELLO_CAPTURA_MIN_MS = 2 * 60_000;

/**
 * Línea de bitácora para `notas_internas` (reserva) / `notas` (evento):
 * - ausente / vacío → null (nada que anotar);
 * - válido (ISO con zona, no futuro > 10 min, ≥ 2020) y `ahora − valor >
 *   2 min` → `[Capturado en la app el 14 sep 09:00 · recibido el 14 sep 11:32]`;
 *   si la diferencia es menor → null (alta en línea normal: sin ruido);
 * - inválido (sin zona, futuro, año absurdo, basura) →
 *   `[Capturado en la app (hora del teléfono no confiable: <valor>) · recibido el …]`.
 * Nunca lanza. Hora Cancún en ambos lados.
 */
export function selloCapturaApp(
  capturadoEn: string | null | undefined,
  ahora: Date = new Date(),
): string | null {
  if (capturadoEn == null) return null;
  const texto = String(capturadoEn).trim();
  if (texto === '') return null;
  const recibido = fechaSelloCancun(ahora);
  let ms = Number.NaN;
  if (ISO_CON_ZONA.test(texto)) ms = Date.parse(texto);
  const valido =
    Number.isFinite(ms) &&
    ms <= ahora.getTime() + CAPTURADO_EN_FUTURO_MAX_MS &&
    ms >= CAPTURADO_EN_MIN_MS;
  if (!valido) {
    return `[Capturado en la app (hora del teléfono no confiable: ${texto.slice(0, 60)}) · recibido el ${recibido}]`;
  }
  if (ahora.getTime() - ms <= SELLO_CAPTURA_MIN_MS) return null;
  return `[Capturado en la app el ${fechaSelloCancun(new Date(ms))} · recibido el ${recibido}]`;
}

/** Anexa el sello (si hay) al final de unas notas existentes. */
export function anexarSello(
  notas: string | null | undefined,
  sello: string | null,
): string | null {
  const base = (notas ?? '').trim();
  if (!sello) return base || null;
  return base ? `${base}\n${sello}` : sello;
}
