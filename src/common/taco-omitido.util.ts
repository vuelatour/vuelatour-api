/**
 * TACÓMETRO OMITIDO POR TRAMO — FUENTE ÚNICA PURA (15-oct-2026, invariante
 * 79, migración `20261015000001_escala_taco_omitido.sql`).
 *
 * Pedido del cliente con la captura del vuelo #300: «necesito una opción para
 * omitir la captura del tacómetro porque falló el tacómetro y no había forma
 * de registrarlo … Debe tener el porqué se omitió el tacómetro y saber quién
 * lo registró así».
 *
 * Un tramo omitido (`escala.taco_omitido_at != null`, con motivo y autor):
 * - NO exige lectura de llegada para completar el vuelo (`faltanLlegadas`).
 * - Aporta **0 h**: el sistema NO inventa ninguna lectura (invariantes 1 y 5).
 * - Se DICE en reporte, balance y pre-cierre (`textoTacoOmitido`), nunca
 *   como «pendiente».
 * - Una llegada REAL posterior lo retira en el MISMO update (CHECK
 *   `escala_taco_omitido_chk`).
 *
 * Sin Supabase ni Nest: lo importan flights, alerts, profit-sharing,
 * flight-report y aircraft-balance. Nadie redacta estos textos por su cuenta.
 */
import { fechaHoraCancun } from './fecha-cancun.util';

/** Largo mínimo del motivo (tras recortar y colapsar espacios). */
export const TACO_OMITIDO_MOTIVO_MIN = 10;
/** Largo máximo del motivo (CHECK de la BD: 10–500 tras btrim). */
export const TACO_OMITIDO_MOTIVO_MAX = 500;
/** Largo del motivo dentro de la bitácora (revision_motivo tope 1800, bitácora 1200). */
export const TACO_OMITIDO_MOTIVO_EN_BITACORA = 160;

/** Lo mínimo de una fila de `escala` para decidir sobre la omisión. */
export interface EscalaOmitibleLike {
  taco_omitido_at?: unknown;
  taco_omitido_por?: unknown;
  taco_omitido_motivo?: unknown;
  taco_llegada?: unknown;
  cancelada_at?: unknown;
}

const presente = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== '';

/** ¿Tramo con tacómetro omitido? (solo la fecha manda; el CHECK garantiza el motivo) */
export function esTramoOmitido(e: EscalaOmitibleLike): boolean {
  return presente(e.taco_omitido_at);
}

/** ¿Este tramo todavía exige lectura de llegada para completar? Vivo, sin llegada y no omitido. */
export function tramoExigeLlegada(e: EscalaOmitibleLike): boolean {
  return (
    !presente(e.cancelada_at) && e.taco_llegada == null && !esTramoOmitido(e)
  );
}

/**
 * Motivo normalizado: recorta, colapsa espacios (incluidos saltos de línea)
 * a uno solo y recorta a `TACO_OMITIDO_MOTIVO_MAX`. `null` si no es texto o
 * queda por debajo de `TACO_OMITIDO_MOTIVO_MIN` (los espacios no cuentan).
 */
export function normalizarMotivoOmision(motivo: unknown): string | null {
  if (typeof motivo !== 'string') return null;
  const limpio = motivo.replace(/\s+/g, ' ').trim();
  if (limpio.length < TACO_OMITIDO_MOTIVO_MIN) return null;
  return limpio.length > TACO_OMITIDO_MOTIVO_MAX
    ? limpio.slice(0, TACO_OMITIDO_MOTIVO_MAX).trimEnd()
    : limpio;
}

/**
 * Motivo para la bitácora: ≤ 160 caracteres con «…». El «;» se cambia por
 * «,»: `revision_motivo` separa sus chunks con «; » (`taco-motivo.util`), y
 * un motivo con «; » partiría el bloque «Registro:» y convertiría su resto en
 * un PENDIENTE falso (amarillo, push al piloto).
 */
export function motivoParaBitacora(motivo: string): string {
  const seguro = motivo.replace(/;/g, ',').replace(/\s+/g, ' ').trim();
  if (seguro.length <= TACO_OMITIDO_MOTIVO_EN_BITACORA) return seguro;
  return `${seguro.slice(0, TACO_OMITIDO_MOTIVO_EN_BITACORA - 1).trimEnd()}…`;
}

/** Renglón del bloque «Registro:» al OMITIR (fecha en hora Cancún). */
export function lineaRegistroOmision(p: {
  quien: string;
  cuando: string | Date;
  motivo: string;
}): string {
  return `tacómetro omitido por ${p.quien} (oficina) el ${fechaHoraCancun(p.cuando)}: ${motivoParaBitacora(p.motivo)}`;
}

/** Renglón del bloque «Registro:» al DESHACER la omisión. */
export function lineaRegistroDeshacerOmision(p: {
  quien: string;
  cuando: string | Date;
}): string {
  return `omisión del tacómetro deshecha por ${p.quien} (oficina) el ${fechaHoraCancun(p.cuando)}: vuelve a pedir la llegada`;
}

/** Renglón del bloque «Registro:» cuando una llegada REAL retira la omisión. */
export function lineaRegistroOmisionRetirada(p: {
  cuando: string | Date;
  como: 'capturada' | 'ajustada' | 'leída con IA';
  quien: string;
}): string {
  return `omisión del tacómetro retirada el ${fechaHoraCancun(p.cuando)}: llegada ${p.como} por ${p.quien}`;
}

/** Texto humano único («nunca pendiente») para reporte, balance, pre-cierre y respuestas. */
export function textoTacoOmitido(p: {
  nombre: string | null;
  at: string | null;
  motivo: string | null;
}): string {
  return `tacómetro omitido por ${p.nombre ?? 'oficina'} (${fechaHoraCancun(p.at) || 'fecha desconocida'}): ${p.motivo ?? 'sin motivo'}`;
}

const idStr = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/**
 * ADITIVO en lote (regla de `registrado-por.util`): pega
 * `taco_omitido_por_nombre` a cada fila con un mapa YA resuelto. `null` si
 * el id no resuelve (usuario borrado, lectura caída): jamás un nombre
 * inventado ni un uuid.
 */
export function conNombreOmitidoPor<T extends { taco_omitido_por?: unknown }>(
  filas: readonly T[],
  nombres: ReadonlyMap<string, string>,
): Array<T & { taco_omitido_por_nombre: string | null }> {
  return filas.map((f) => {
    const id = idStr(f.taco_omitido_por);
    return { ...f, taco_omitido_por_nombre: (id && nombres.get(id)) || null };
  });
}

/** Ids distintos de `taco_omitido_por` (para `fetchNombresUsuarios`). */
export function idsOmitidoPor(
  filas: ReadonlyArray<{ taco_omitido_por?: unknown }>,
): string[] {
  const ids = new Set<string>();
  for (const f of filas) {
    const id = idStr(f.taco_omitido_por);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Lo mínimo de un tramo VIVO para los predicados de completitud. */
export interface EscalaTacoLike {
  orden?: unknown;
  taco_salida?: unknown;
  taco_llegada?: unknown;
  taco_omitido_at?: unknown;
}

/**
 * Falta alguna llegada EXIGIBLE: sin escalas, o un tramo sin llegada y no
 * omitido. La usan `complete`, `syncEstadoDesdeTacos`, `clearTaco`,
 * `cancelEscala`/`restoreEscala` y la respuesta de omitir (tramos VIVOS).
 */
export function faltanLlegadas(escalas: readonly EscalaTacoLike[]): boolean {
  if (escalas.length === 0) return true;
  return escalas.some((e) => e.taco_llegada == null && !esTramoOmitido(e));
}

/**
 * Falta alguna llegada REAL: sin escalas, o un tramo sin llegada (el omitido
 * CUENTA como faltante). SOLO el cron zombi: «el vuelo NO se completa solo».
 */
export function faltanLlegadasReales(
  escalas: readonly EscalaTacoLike[],
): boolean {
  if (escalas.length === 0) return true;
  return escalas.some((e) => e.taco_llegada == null);
}

/**
 * Badge «Tacómetro incompleto» del listado: falta salida o llegada en algún
 * tramo NO omitido; sin tramos vivos ⇒ `falta: true`. `omitido` = algún
 * tramo con tacómetro omitido.
 */
export function faltaTacoParaBadge(escalas: readonly EscalaTacoLike[]): {
  falta: boolean;
  omitido: boolean;
} {
  const omitido = escalas.some(esTramoOmitido);
  if (escalas.length === 0) return { falta: true, omitido };
  const falta = escalas.some(
    (e) =>
      !esTramoOmitido(e) && (e.taco_salida == null || e.taco_llegada == null),
  );
  return { falta, omitido };
}
