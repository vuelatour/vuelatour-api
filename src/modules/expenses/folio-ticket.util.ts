/**
 * FOLIO/REMISIÓN DEL COMPROBANTE DE UN GASTO (`gasto.folio_ticket`). PURO:
 * sin Nest ni Supabase.
 *
 * Extraído de `expenses.service.ts` el 6-oct-2026 (API 0.0.58) para que la
 * captura (`enriquecerGastoConIA`, `assertFolioTicketLibre`) y el cron
 * `gastos-releer-folio` (`folio-relectura.service.ts`) decidan EXACTAMENTE
 * igual qué folio leído por la IA se guarda. Nadie más arma el folio de un
 * gasto a partir de una lectura.
 *
 * El candado DURO anti-duplicados vive en la BD: índice único
 * `uq_gasto_folio_ticket_norm` sobre la columna generada `folio_ticket_norm`
 * (`NULLIF(upper(regexp_replace(folio_ticket, '[^A-Za-z0-9]', '', 'g')), '')`)
 * con `length >= 4`. `normalizarFolio` es su espejo exacto.
 */

/** Largo de `gasto.folio_ticket` (varchar(60)). */
export const FOLIO_TICKET_MAX = 60;

/** Largo mínimo del folio normalizado para el candado duro (los cortos son
 *  demasiado genéricos para rechazar; solo llevan el flag blando). Espejo
 *  del `length(folio_ticket_norm) >= 4` del índice único. */
export const FOLIO_CANDADO_MIN = 4;

/** Normalización del folio del ticket: la MISMA regla que la columna
 *  generada `folio_ticket_norm` de la BD (solo alfanumérico, mayúsculas). */
export function normalizarFolio(
  folio: string | null | undefined,
): string | null {
  const norm = (folio ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return norm.length > 0 ? norm : null;
}

/**
 * Lo que la IA a veces escribe cuando el comprobante NO trae folio
 * (normalizado). pyservices pide `null` en ese caso, pero un «S/N» guardado
 * como folio saldría como «Factura S/N» en el Excel de conciliación y
 * chocaría con el índice único entre comprobantes sin relación.
 */
const FOLIOS_VACIOS = new Set([
  'SN',
  'NA',
  'ND',
  'SF',
  'SINFOLIO',
  'NOAPLICA',
  'NULL',
  'NONE',
  'NINGUNO',
]);

/**
 * Folio que se GUARDA en `gasto.folio_ticket` a partir de la lectura de la
 * IA (`valor_ia_extraido.folio` / respuesta de `/vision/gasto`): recortado,
 * a lo más 60 caracteres y `null` si no queda nada alfanumérico o es un
 * marcador de «sin folio» (S/N, N/A…). Número ⇒ su texto.
 */
export function folioTicketDeLectura(raw: unknown): string | null {
  let texto: string;
  if (typeof raw === 'number' && Number.isFinite(raw)) texto = String(raw);
  else if (typeof raw === 'string') texto = raw;
  else return null;
  const folio = texto.trim().slice(0, FOLIO_TICKET_MAX).trim();
  const norm = normalizarFolio(folio);
  if (!norm || FOLIOS_VACIOS.has(norm)) return null;
  return folio;
}

/** ¿El folio choca con el índice único (≥ 4 alfanuméricos)? */
export function folioConCandado(folio: string | null | undefined): boolean {
  const norm = normalizarFolio(folio);
  return norm != null && norm.length >= FOLIO_CANDADO_MIN;
}
