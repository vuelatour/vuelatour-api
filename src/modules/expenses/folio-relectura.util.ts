/**
 * RELECTURA CON IA DEL FOLIO DE LOS COMPROBANTES (6-oct-2026, API 0.0.58,
 * invariante 46 del CLAUDE.md). PURO: sin Nest ni Supabase.
 *
 * Pedido del cliente: el número de factura en «Notas» del Excel de
 * conciliación sale solo si el gasto tiene folio (invariante 44). En prod
 * (6-oct) 477 gastos con foto no tenían NINGÚN folio; la IA ya había leído
 * casi todas esas fotos pero devolvió el folio vacío (facturas de ASUR de
 * principios de septiembre, antes de afinar el prompt). El cron
 * `gastos-releer-folio` (`folio-relectura.service.ts`) las vuelve a leer y
 * aquí vive lo que decide con cada lectura:
 *   - qué gastos entran y en qué orden (`loteRelectura`,
 *     `corteCapturadosHasta`, `ordenarCandidatos`);
 *   - qué se hizo con la lectura (`evaluarLecturaFolio`,
 *     `clasificarMotivoLectura`);
 *   - qué se escribe (`lecturaConFolio`, `lineaFolioDuplicado`,
 *     `notasConLinea`, `fotosAdicionalesDe`).
 * El folio que se guarda lo decide `folio-ticket.util#folioTicketDeLectura`
 * (la MISMA regla que la captura).
 */
import { folioTicketDeLectura } from './folio-ticket.util';

/** Gastos que relee cada corrida (cada 5 min) sin configuración. */
export const FOLIOS_RELEER_LOTE_DEFAULT = 15;
/** Tope del lote (una lectura con Opus tarda 20–40 s). */
export const FOLIOS_RELEER_LOTE_MAX = 50;
/** `fecha_gasto` mínima sin configuración (lo que concilia la oficina). */
export const FOLIOS_RELEER_DESDE_DEFAULT = '2026-09-01';
/**
 * Último día (Cancún, inclusive) de CAPTURA que entra sin configuración.
 * Lo capturado después se leyó con el prompt afinado del 2-oct-2026 y es
 * lo que piloto y oficina siguen editando: no se relee.
 */
export const FOLIOS_RELEER_CAPTURADOS_HASTA_DEFAULT = '2026-10-05';
/** Categoría del consumo de IA (`ia_uso.categoria`). */
export const CATEGORIA_IA_RELEER_FOLIO = 'RELEER_FOLIO';
/** Gastos con fallo transitorio que se recuerdan (al final de la cola). */
export const POSTERGADOS_MAX = 50;

/** Lote saneado: entero 1–50; cualquier otra cosa ⇒ el default. */
export function loteRelectura(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 1) return FOLIOS_RELEER_LOTE_DEFAULT;
  return Math.min(Math.floor(n), FOLIOS_RELEER_LOTE_MAX);
}

/**
 * Corte EXCLUSIVO de `created_at` para «capturados hasta `dia`» (pared
 * Cancún, invariante 4): el inicio del día SIGUIENTE a las 00:00 −05:00.
 * `2026-10-05` ⇒ `2026-10-06T00:00:00-05:00` (se filtra con `lt`).
 */
export function corteCapturadosHasta(dia: string): string {
  const t = new Date(`${dia}T00:00:00Z`).getTime() + 24 * 3600 * 1000;
  return `${new Date(t).toISOString().slice(0, 10)}T00:00:00-05:00`;
}

/**
 * Orden de la corrida: los candidatos tal como salen de la consulta
 * (`fecha_gasto` desc) y AL FINAL los postergados (fallo transitorio en
 * una corrida anterior), del más viejo al más reciente; se toman `lote`.
 * Así dos fotos que siempre tumban la lectura no encabezan la cola para
 * siempre (con dos fallos seguidos la corrida se corta y el lote sale
 * siempre en el mismo orden). Nunca se excluye a nadie: un postergado se
 * relee cuando ya no hay otros por delante.
 */
export function ordenarCandidatos<T extends { id: string }>(
  filas: readonly T[],
  postergados: readonly string[],
  lote: number,
): T[] {
  const orden = new Map(postergados.map((id, i) => [id, i]));
  const libres = filas.filter((f) => !orden.has(f.id));
  const atras = filas
    .filter((f) => orden.has(f.id))
    .sort((a, b) => orden.get(a.id)! - orden.get(b.id)!);
  return [...libres, ...atras].slice(0, Math.max(0, lote));
}

/** Hojas 2..N de una factura multi-hoja (`valor_ia_extraido.fotos_adicionales`). */
export function fotosAdicionalesDe(valorIa: unknown): string[] {
  if (!valorIa || typeof valorIa !== 'object' || Array.isArray(valorIa)) {
    return [];
  }
  const f = (valorIa as { fotos_adicionales?: unknown }).fotos_adicionales;
  return Array.isArray(f)
    ? f.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
}

/** ¿El comprobante se manda como DOCUMENTO (bytes) y no como URL de imagen? */
export function tipoDocumento(path: string): 'PDF' | 'EXCEL' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.pdf')) return 'PDF';
  if (/\.(xlsx|xls|csv)$/.test(lower)) return 'EXCEL';
  return null;
}

/**
 * Qué significa una lectura FALLIDA (`motivo` de `VisionService`, que
 * reenvía el texto de `pyservices/app/services/ia_errores.py`):
 * - `IA_NO_DISPONIBLE`: ninguna lectura funcionará (sin saldo, límite de
 *   gasto, llave inválida, modelo inexistente, pyservices sin token) ⇒ no
 *   se sella y la corrida se CORTA ya.
 * - `COMPROBANTE`: ESTE archivo no se puede leer (pesa demasiado, formato no
 *   soportado, foto ilegible, documento largo…) y reintentar no lo arregla
 *   ⇒ se sella como ilegible.
 * - `TRANSITORIO`: todo lo demás (pyservices caído, timeout, IA saturada,
 *   «Claude no disponible (…)» genérico) ⇒ no se sella; dos seguidos cortan
 *   la corrida. Un texto que no se reconoce cae AQUÍ (lado seguro: jamás
 *   sella por un error que no entiende).
 */
export type FalloLecturaFolio =
  | 'IA_NO_DISPONIBLE'
  | 'COMPROBANTE'
  | 'TRANSITORIO';

const MOTIVOS_IA_NO_DISPONIBLE = [
  'sin saldo de créditos',
  'credit balance',
  'límite de gasto de ia',
  'usage limit',
  'llave de la ia no es válida',
  'modelo de ia configurado no existe',
  'internal_shared_token',
  'token interno inválido',
  'pyservices 401',
  'pyservices 403',
  'visión ia deshabilitada',
];

const MOTIVOS_COMPROBANTE = [
  'pesa demasiado',
  'demasiado grande en pixeles',
  'formato de archivo no soportado',
  'no pudo leer la foto',
  'demasiado largo para la ia',
  'demasiadas fotos',
];

export function clasificarMotivoLectura(
  motivo: string | null | undefined,
): FalloLecturaFolio {
  const m = (motivo ?? '').toLowerCase();
  if (MOTIVOS_IA_NO_DISPONIBLE.some((x) => m.includes(x))) {
    return 'IA_NO_DISPONIBLE';
  }
  if (MOTIVOS_COMPROBANTE.some((x) => m.includes(x))) return 'COMPROBANTE';
  return 'TRANSITORIO';
}

/** Lectura tal como la devuelve `VisionService.readGastoTicket`. */
export type LecturaVision =
  | {
      legible?: unknown;
      folio?: unknown;
      monto?: unknown;
      motivo?: unknown;
    }
  | null
  | undefined;

export type ResultadoLecturaFolio =
  | { tipo: 'FOLIO'; folio: string }
  | { tipo: 'SIN_FOLIO' }
  | { tipo: 'ILEGIBLE'; motivo: string | null }
  | {
      tipo: 'FALLO';
      fallo: Exclude<FalloLecturaFolio, 'COMPROBANTE'>;
      motivo: string;
    };

/**
 * Qué se sacó de UNA lectura:
 * - `null` (visión deshabilitada) ⇒ FALLO `IA_NO_DISPONIBLE`.
 * - `motivo` sin `monto` (la forma de error de `readGastoTicket`, la misma
 *   que usa `reanalizarConIA`) ⇒ según `clasificarMotivoLectura`.
 * - `legible !== true` ⇒ ILEGIBLE (un folio de una lectura ilegible NO se
 *   guarda, como en `enriquecerGastoConIA`).
 * - Legible ⇒ FOLIO si `folioTicketDeLectura` da algo; si no, SIN_FOLIO.
 */
export function evaluarLecturaFolio(
  lectura: LecturaVision,
): ResultadoLecturaFolio {
  if (!lectura) {
    return {
      tipo: 'FALLO',
      fallo: 'IA_NO_DISPONIBLE',
      motivo:
        'Visión IA deshabilitada (PYSERVICES_BASE_URL/INTERNAL_SHARED_TOKEN)',
    };
  }
  if (lectura.motivo && lectura.monto === undefined) {
    const motivo =
      typeof lectura.motivo === 'string'
        ? lectura.motivo
        : JSON.stringify(lectura.motivo);
    const fallo = clasificarMotivoLectura(motivo);
    if (fallo === 'COMPROBANTE') return { tipo: 'ILEGIBLE', motivo };
    return { tipo: 'FALLO', fallo, motivo };
  }
  if (lectura.legible !== true) return { tipo: 'ILEGIBLE', motivo: null };
  const folio = folioTicketDeLectura(lectura.folio);
  return folio ? { tipo: 'FOLIO', folio } : { tipo: 'SIN_FOLIO' };
}

/**
 * `valor_ia_extraido` con el folio: la lectura PREVIA con su llave `folio`
 * rellenada (la IA solo llena vacíos: desglose, proveedor, matrícula y
 * `fotos_adicionales` de la lectura que la oficina ya revisó NO se tocan).
 * Sin lectura previa (o no es un objeto) se guarda la lectura NUEVA
 * completa (sin `motivo`), con el folio tal como se guardó en
 * `folio_ticket`.
 */
export function lecturaConFolio(
  previa: unknown,
  lectura: Record<string, unknown>,
  folio: string,
): Record<string, unknown> {
  if (previa && typeof previa === 'object' && !Array.isArray(previa)) {
    return { ...(previa as Record<string, unknown>), folio };
  }
  const limpia: Record<string, unknown> = { ...lectura };
  delete limpia.motivo;
  return { ...limpia, folio };
}

/** Línea de `notas` cuando el folio leído ya es de OTRO gasto (⚠ = el
 *  diálogo «Verificar» del panel pinta el aviso ámbar). */
export function lineaFolioDuplicado(folio: string): string {
  return `⚠ IA: folio ${folio} ya existe en otro gasto — revisar`;
}

/** `notas` con `linea` al FINAL (línea nueva), sin repetirla. */
export function notasConLinea(
  notas: string | null | undefined,
  linea: string,
): string {
  const previas = typeof notas === 'string' ? notas.trimEnd() : '';
  if (previas.split('\n').some((l) => l.trim() === linea)) return previas;
  return previas ? `${previas}\n${linea}` : linea;
}

/**
 * ¿El error de Storage dice que el archivo NO EXISTE? (nada que leer ⇒ se
 * sella como ilegible). Cualquier otro error es de red/servicio y se
 * reintenta. Textos reales: `download` ⇒ «Object not found»;
 * `createSignedUrls` por archivo ⇒ «Either the object does not exist or you
 * do not have access to it».
 */
export function esArchivoAusente(mensaje: string | null | undefined): boolean {
  return /object not found|not_found|does not exist/i.test(mensaje ?? '');
}
