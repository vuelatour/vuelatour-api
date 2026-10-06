/**
 * Serie/folio de las FACTURAS RECIBIDAS (5-oct-2026, API 0.0.57, invariante
 * 44 del CLAUDE.md). PURO: sin Nest ni Supabase.
 *
 * El parser de pyservices (`parse_cfdi`) devuelve desde el 5-oct `serie` y
 * `folio` (atributos `Serie`/`Folio` del `cfdi:Comprobante`, recortados,
 * vacío ⇒ null). Aquí vive lo que el API decide con eso:
 *   - qué se guarda al registrar una factura (`camposSerieFolioInsert`);
 *   - qué hace el cron de relectura con cada XML ya guardado
 *     (`clasificarFalloRelectura`, `cortarRelecturaPorPyservices`,
 *     `notasConFolioNoLegible`).
 * Cómo se ROTULA el número («A-0411», respaldo al UUID) NO vive aquí: es de
 * `common/folio-comprobante.util` (fuente única).
 */

/** Facturas que relee el cron por corrida (las 59 de prod caben en 2). */
export const RELECTURA_FOLIO_LOTE = 50;

/**
 * Fallos TRANSITORIOS de pyservices SEGUIDOS que cortan la corrida
 * (revisión 5-oct-2026). Con UNO solo el cron sigue con la siguiente
 * factura: un XML concreto que tumba a pyservices (5xx, timeout) no debe
 * bloquear la cola para siempre (el lote se toma siempre en el mismo orden
 * y esa fila, sin sellar, encabezaría todas las corridas). Con DOS seguidos
 * pyservices está caído o desactualizado: todas fallarían igual.
 */
export const RELECTURA_FOLIO_FALLOS_SEGUIDOS = 2;

/** ¿Cortar la corrida tras `fallosSeguidos` fallos transitorios seguidos? */
export function cortarRelecturaPorPyservices(fallosSeguidos: number): boolean {
  return fallosSeguidos >= RELECTURA_FOLIO_FALLOS_SEGUIDOS;
}

/** Nota que deja el cron cuando el XML guardado no se pudo leer. */
export const NOTA_FOLIO_NO_LEGIBLE = 'Folio no legible del XML';

export interface SerieFolioCfdi {
  serie: string | null;
  folio: string | null;
  /**
   * `true` = el parser YA sabe leer serie/folio (pyservices del 5-oct o
   * posterior: las llaves vienen en la respuesta, aunque sea en null).
   * `false` = pyservices VIEJO (sin las llaves): no se puede afirmar que el
   * CFDI no las tenga, así que la fila NO se sella y el cron la relee.
   */
  leido: boolean;
}

function texto(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Serie/folio de la respuesta del parser, normalizados. */
export function serieFolioDelCfdi(
  p: Record<string, unknown> | null | undefined,
): SerieFolioCfdi {
  if (!p || typeof p !== 'object') {
    return { serie: null, folio: null, leido: false };
  }
  return {
    serie: texto(p.serie),
    folio: texto(p.folio),
    leido: 'folio' in p || 'serie' in p,
  };
}

/**
 * Campos ADITIVOS del INSERT de una factura recibida con XML:
 * - sin la migración 20261005000002 ⇒ `{}` (el insert es el del 0.0.56);
 * - con ella ⇒ `serie`, `folio` y `folio_releido_at = ahora` (ya se leyó del
 *   XML: el cron no la vuelve a leer). Con un pyservices VIEJO
 *   (`leido = false`) `folio_releido_at` queda null para que el cron la
 *   relea cuando pyservices se actualice.
 */
export function camposSerieFolioInsert(
  p: Record<string, unknown> | null | undefined,
  conColumna: boolean,
  ahoraIso: string,
): Record<string, unknown> {
  if (!conColumna || !p) return {};
  const sf = serieFolioDelCfdi(p);
  return {
    serie: sf.serie,
    folio: sf.folio,
    folio_releido_at: sf.leido ? ahoraIso : null,
  };
}

/**
 * Qué hacer cuando la relectura de UN XML falla:
 * - `ILEGIBLE`: el XML no se puede leer y reintentar no lo arreglará
 *   (pyservices respondió 400/422 con `detail` de TEXTO = CFDI roto, base64
 *   inválido o con DTD/ENTITY; o el archivo ya no existe en Storage) ⇒ se
 *   SELLA `folio_releido_at` y se anota «Folio no legible del XML».
 * - `TRANSITORIO`: pyservices caído, sin configurar, lento, 5xx/401/404, un
 *   422 de VALIDACIÓN de FastAPI (`detail` es una LISTA: el body no cumple
 *   el schema, p. ej. un pyservices que cambió `ParseRecibidaRequest`; sellar
 *   dejaría las 59 recibidas sin folio para siempre con XML sanos) o Storage
 *   con un error de red ⇒ NO se sella: el siguiente tick reintenta.
 */
export type FalloRelectura = 'ILEGIBLE' | 'TRANSITORIO';

export function clasificarFalloRelectura(err: unknown): FalloRelectura {
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  // `PyservicesService.postForJson`: «pyservices respondio 422: <body>». El
  // 422 PROPIO de `/facturacion/parse-recibida` trae `{"detail":"<texto>"}`;
  // el de validación de FastAPI, `{"detail":[{…}]}` (revisión 5-oct-2026).
  if (/pyservices respondi[oó] (400|422):\s*\{\s*"detail"\s*:\s*"/i.test(msg)) {
    return 'ILEGIBLE';
  }
  // `downloadB64`: «No se pudo leer facturas/…: Object not found».
  if (/object not found|not_found/i.test(msg)) return 'ILEGIBLE';
  return 'TRANSITORIO';
}

/**
 * `notas` con la leyenda de folio no legible al FINAL (una línea nueva),
 * sin duplicarla si ya estaba.
 */
export function notasConFolioNoLegible(
  notas: string | null | undefined,
): string {
  const previas = typeof notas === 'string' ? notas.trimEnd() : '';
  if (previas.includes(NOTA_FOLIO_NO_LEGIBLE)) return previas;
  return previas
    ? `${previas}\n${NOTA_FOLIO_NO_LEGIBLE}`
    : NOTA_FOLIO_NO_LEGIBLE;
}
