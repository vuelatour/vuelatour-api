import { idsOmitidoPor } from '../../common/taco-omitido.util';
import {
  MAX_TRAMOS_EN_REVISION,
  pilotosDeTacosEnRevision,
  resumenTacosEnRevision,
  type EscalaEnRevisionRow,
  type PreCierreTacoTramo,
  type PreCierreVueloRef,
} from './tacos-revision.util';

/**
 * PRE-CIERRE → «Tacómetros omitidos (sin lectura, con motivo)» (15-oct-2026,
 * invariante 79). Renglón INFORMATIVO (no bloquea), inmediatamente después de
 * `tacos_en_revision`: un tramo con tacómetro omitido aporta 0 h al cierre y
 * se DICE aquí con quién lo omitió, cuándo y por qué — nunca como pendiente.
 *
 * Espejo de `tacos-revision.util` (reutiliza `PreCierreVueloRef`,
 * `MAX_TRAMOS_EN_REVISION` y `pilotosDeTacosEnRevision`). Helpers PUROS: la
 * consulta vive en `profit-sharing.service`; aquí solo se arma la respuesta.
 */

/** Fila de `escala` omitida con su vuelo embebido, tal como la lee el pre-cierre. */
export interface EscalaOmitidaRow extends EscalaEnRevisionRow {
  taco_omitido_at?: unknown;
  taco_omitido_por?: unknown;
  taco_omitido_motivo?: unknown;
}

/** Una línea por TRAMO omitido: la del renglón amarillo + quién y cuándo. */
export type PreCierreTacoTramoOmitido = PreCierreTacoTramo & {
  omitido_por_nombre: string | null;
  omitido_at: string | null;
};

/** El motivo se recorta como `motivoCorto` (180 con «…»). */
const MAX_MOTIVO = 180;

const texto = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
};

/** Motivo de la omisión recortado a 180 caracteres (misma regla que `motivoCorto`). */
export function motivoOmisionCorto(motivo: unknown): string | null {
  const t = texto(motivo)?.replace(/\s+/g, ' ') ?? null;
  if (!t) return null;
  return t.length > MAX_MOTIVO ? `${t.slice(0, MAX_MOTIVO - 1).trimEnd()}…` : t;
}

/**
 * Ids de usuario a resolver en UNA llamada a `fetchNombres`: piloto del tramo
 * (con herencia del vuelo) y quien omitió.
 */
export function usuariosDeTacosOmitidos(
  rows: readonly EscalaOmitidaRow[],
): string[] {
  return [
    ...new Set([...pilotosDeTacosEnRevision(rows), ...idsOmitidoPor(rows)]),
  ];
}

/**
 * Arma `vuelos` (deduplicado, folio asc) y `tramos` (folio y orden, tope
 * `MAX_TRAMOS_EN_REVISION`) del renglón `tacometros_omitidos`. `motivo` =
 * `taco_omitido_motivo` recortado; `omitido_por_nombre` = nombre resuelto o
 * `null` (jamás inventado).
 */
export function resumenTacosOmitidos(
  rows: readonly EscalaOmitidaRow[],
  nombres: ReadonlyMap<string, string> = new Map(),
): { vuelos: PreCierreVueloRef[]; tramos: PreCierreTacoTramoOmitido[] } {
  // Chips: los MISMOS que arma el renglón amarillo (dedupe, folio asc).
  const { vuelos } = resumenTacosEnRevision(rows, nombres);
  const tramos = rows.map((r): PreCierreTacoTramoOmitido => {
    const v = r.vuelo ?? null;
    const pilotoId = texto(r.piloto_id) ?? texto(v?.piloto_id);
    const porId = texto(r.taco_omitido_por);
    return {
      vuelo_id: texto(r.vuelo_id) ?? texto(v?.id) ?? '',
      folio: Number(v?.folio ?? 0) || 0,
      orden: Number(r.orden ?? 0) || 0,
      origen_iata: texto(r.origen_iata),
      destino_iata: texto(r.destino_iata),
      fecha_salida_plan: texto(r.fecha_salida_plan),
      // El motivo del renglón es el de la OMISIÓN (no `revision_motivo`).
      motivo: motivoOmisionCorto(r.taco_omitido_motivo),
      piloto_nombre: pilotoId ? (nombres.get(pilotoId) ?? null) : null,
      // Mismo `escala_id` que `tacos_en_revision` (invariante 81): el tramo
      // exacto, null si la fila no trae id (jamás se inventa).
      escala_id: texto(r.id),
      omitido_por_nombre: porId ? (nombres.get(porId) ?? null) : null,
      omitido_at: texto(r.taco_omitido_at),
    };
  });
  tramos.sort((a, b) => a.folio - b.folio || a.orden - b.orden);
  return { vuelos, tramos: tramos.slice(0, MAX_TRAMOS_EN_REVISION) };
}

/**
 * Texto del renglón cuando la lectura de los omitidos FALLÓ (`lectura_fallida`,
 * `count: 0`): nunca «Ningún tramo…», que sería afirmar algo no verificado.
 */
export const DETALLE_TACOS_OMITIDOS_FALLIDA =
  'No se pudo leer qué tramos tienen el tacómetro omitido.';

/**
 * Texto del renglón (singular/plural como `detalleTacosEnRevision`): dice
 * cuántos tramos y en cuántos vuelos, y que aportan 0 h.
 */
export function detalleTacosOmitidos(
  totalTramos: number,
  totalVuelos: number,
): string {
  if (totalTramos === 0)
    return 'Ningún tramo con tacómetro omitido en el periodo.';
  const t = `${totalTramos} ${totalTramos === 1 ? 'tramo' : 'tramos'}`;
  const v = `${totalVuelos} ${totalVuelos === 1 ? 'vuelo' : 'vuelos'}`;
  return `${t} con tacómetro omitido en ${v}: aportan 0 h al cierre. Revisa que el motivo sea válido; si al final hay lectura, captúrala y la omisión se retira sola.`;
}
