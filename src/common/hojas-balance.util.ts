/**
 * CONJUNTOS Y LECTORES COMPARTIDOS DE LOS BALANCES (13-oct-2026, API 0.0.75,
 * invariante 72). PURO (sin Nest ni BD).
 *
 * Los usan `aircraft/aircraft-balance.service.ts` (los libros) y su ESPEJO
 * `common/ubicacion-balance-gasto.util.ts` («¿en qué libro y en qué mes
 * vive este gasto?», enlaces de Conciliación). Viven aquí para que no haya
 * dos copias que diverjan: mover una categoría de hoja o de eje se hace UNA
 * vez y la alarma de paridad del spec del espejo lo vigila.
 */
import { CATEGORIAS_GASTO_EMPRESA } from './categoria-gasto.util';
import { avionDelGasto } from './participacion-aeronave.util';

/** Fila embebida (objeto o [objeto]) de PostgREST → objeto o null. */
export function embebido<T extends object>(
  raw: T | T[] | null | undefined,
): T | null {
  const v: unknown = Array.isArray(raw) ? raw[0] : raw;
  return v && typeof v === 'object' ? (v as T) : null;
}

/** Fila embebida `vuelo:vuelo_id(…)` de un gasto (PostgREST: objeto o [objeto]). */
export function vueloEmbebido(
  g: Record<string, unknown>,
): Record<string, unknown> | null {
  const raw: unknown = g.vuelo;
  const v: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/**
 * Vuelo EXTERNO sin avión de referencia: su dinero (gastos, GAS sin avión
 * sellado, costo del operador) vive en el libro EXTERNOS del mes del vuelo —
 * NO es "sin avión" para los avisos de flota ni para el pre-cierre.
 */
export function esVueloExternoSinAvion(
  v: Record<string, unknown> | null,
): boolean {
  return v != null && v.es_externo === true && v.aeronave_id == null;
}

/**
 * Avión de un gasto leído con `escala:escala_id(aeronave_id)` y
 * `vuelo:vuelo_id(aeronave_id)` embebidos — la MISMA fuente única
 * `avionDelGasto` (escala → gasto → vuelo, con herencia) sin necesitar el
 * mapa de escalas del libro. Para avisos, filas sueltas y el espejo.
 */
export function avionDeGastoEmbebido(
  g: Record<string, unknown>,
): string | null {
  const esc = embebido(
    g.escala as { aeronave_id?: string | null } | null | undefined,
  );
  const mapa = new Map<string, { aeronave_id?: string | null }>();
  if (typeof g.escala_id === 'string' && esc) mapa.set(g.escala_id, esc);
  const vuelo = vueloEmbebido(g);
  return avionDelGasto(
    {
      escala_id: (g.escala_id as string | null) ?? null,
      aeronave_id: (g.aeronave_id as string | null) ?? null,
    },
    mapa,
    (vuelo?.aeronave_id as string | null) ?? null,
  );
}

/**
 * Categorías con destino PROPIO en el libro del avión (o sin destino):
 * GAS → hoja «combustible» (consulta mensual aparte), PERMISO → hoja
 * «permisos» (con o sin vuelo) y TUAS → ninguna (regla 7, 28-ago-2026: el
 * TUA es solo nota; vive en «otros movimientos» del general). Ninguna entra
 * a «Gastos Indirectos» ni a los parciales de «repartidos a aviones».
 */
export const HOJAS_APARTE_BALANCE: ReadonlySet<string> = new Set([
  'GAS',
  'PERMISO',
  'TUAS',
]);

/**
 * Parciales del REPARTO MANUAL que se buscan por su categoría (excepción
 * 29-ago-2026): van a la lista `gastos_indirectos` (no a `otros_gastos`,
 * que el general pinta como «repartidos a aviones").
 */
export const PARCIAL_A_INDIRECTOS: ReadonlySet<string> = new Set([
  'INDIRECTO',
  'NOMINA',
]);

/**
 * ¿Los parciales del reparto manual de este gasto entran a los libros de
 * sus aviones? (11-sep-2026) Un gasto SIN vuelo, siempre; CON vuelo, solo
 * las categorías de EMPRESA — las demás ya restan en la fila del vuelo o en
 * las hojas de su avión (contarlas también por el reparto sería doble).
 */
export function parcialEntraAlAvion(padre: {
  vuelo_id?: string | null;
  categoria?: string | null;
}): boolean {
  return (
    padre.vuelo_id == null ||
    CATEGORIAS_GASTO_EMPRESA.has(padre.categoria ?? '')
  );
}
