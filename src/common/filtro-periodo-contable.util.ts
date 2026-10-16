/**
 * FILTRO DEL PERIODO CONTABLE de los lectores de DINERO (16-oct-2026, API
 * 0.0.88, invariante 89). PURO.
 *
 * Con la migración `20261016000004` los vuelos se filtran por
 * `vuelo.fecha_contable` (= `coalesce(periodo_contable, fecha_vuelo)`,
 * columna GENERADA): un vuelo diferido a octubre al cerrar septiembre cae en
 * octubre. Sin la migración (sonda `cierreMesDisponible` en false) la columna
 * es `fecha_vuelo`, byte a byte lo del 0.0.87. Las HORAS (escalas,
 * tacómetros, reserva de overhaul, horas de piloto) NO usan esto: siguen por
 * `fecha_vuelo` real.
 *
 * Cortes SIEMPRE en hora Cancún (invariante 4).
 */

/** Columna del vuelo que decide el periodo de un lector de dinero. */
export type ColPeriodoContable = 'fecha_contable' | 'fecha_vuelo';

/**
 * `fecha_contable` con la migración; `fecha_vuelo` sin ella. Con `embed`
 * devuelve la ruta embebida de PostgREST (`vuelo.fecha_contable`).
 */
export function colPeriodoContable(disponible: boolean): ColPeriodoContable;
export function colPeriodoContable(
  disponible: boolean,
  embed: string,
): `${string}.${ColPeriodoContable}`;
export function colPeriodoContable(
  disponible: boolean,
  embed?: string,
): string {
  const col: ColPeriodoContable = disponible ? 'fecha_contable' : 'fecha_vuelo';
  return embed ? `${embed}.${col}` : col;
}

/** Columnas EXTRA del select de `vuelo` (con coma inicial) o '' sin la migración. */
export function colsVueloContable(disponible: boolean): string {
  return disponible ? ', periodo_contable, fecha_contable' : '';
}

/** `{desdeTs, hastaTs}` del periodo en hora Cancún (invariante 4). */
export function rangoPeriodoTs(
  desde: string,
  hasta: string,
): { desdeTs: string; hastaTs: string } {
  return {
    desdeTs: `${desde.slice(0, 10)}T00:00:00-05:00`,
    hastaTs: `${hasta.slice(0, 10)}T23:59:59-05:00`,
  };
}
