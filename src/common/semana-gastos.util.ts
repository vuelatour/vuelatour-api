/**
 * Semana de gastos de los roles de CAMPO (regla del equipo, 1-sep-2026):
 * los gastos viven en bloques lunes→domingo en pared Cancún, con unos días
 * de gracia tras el domingo (`configuracion_sistema.dias_gracia_gastos_semana`,
 * default 1 = hasta el lunes) para capturar/corregir lo de la semana pasada.
 *
 * Helpers PUROS sobre fechas de pared `YYYY-MM-DD` (el llamador resuelve el
 * día Cancún con `hoyCancun`/`diaCancun`). Aritmética con el patrón
 * `T12:00:00Z` + milisegundos: a mediodía UTC un ±1 día jamás cruza de fecha,
 * así que sumar/restar días es exacto sin pelearse con zonas horarias.
 */

const DIA_MS = 86_400_000;

/** Mediodía UTC del día de pared (ancla segura para sumar/restar días). */
function mediodia(fecha: string): number {
  const t = Date.parse(`${fecha.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`Fecha inválida: ${fecha}`);
  return t;
}

/** YYYY-MM-DD del instante (anclado a mediodía UTC, el día no se mueve). */
function aFecha(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Días de gracia saneados: entero ≥ 0 (la config podría traer basura). */
export function graciaSaneada(dias: number): number {
  return Number.isFinite(dias) ? Math.max(0, Math.trunc(dias)) : 0;
}

/** Lunes (YYYY-MM-DD) de la semana a la que pertenece la fecha dada. */
export function lunesDe(fecha: string): string {
  const t = mediodia(fecha);
  // getUTCDay sobre el mediodía UTC: 0=domingo…6=sábado → 0=lunes…6=domingo.
  const desdeLunes = (new Date(t).getUTCDay() + 6) % 7;
  return aFecha(t - desdeLunes * DIA_MS);
}

/** Domingo (YYYY-MM-DD) que cierra la semana de la fecha dada. */
export function domingoDe(fecha: string): string {
  return aFecha(mediodia(lunesDe(fecha)) + 6 * DIA_MS);
}

/**
 * EDICIÓN/BORRADO: último día (inclusive) en que el capturista aún puede
 * corregir un gasto = domingo de la semana de CAPTURA + días de gracia.
 * Lo capturado en lunes de gracia pertenece a la semana NUEVA, así que es
 * editable hasta SU lunes siguiente — sale solo de esta fórmula.
 */
export function limiteEdicion(fechaCaptura: string, diasGracia: number): string {
  return aFecha(
    mediodia(domingoDe(fechaCaptura)) + graciaSaneada(diasGracia) * DIA_MS,
  );
}

/**
 * CAPTURA: fecha de gasto MÍNIMA (inclusive) que un rol de campo puede
 * registrar hoy. Normalmente el lunes de la semana en curso; en los primeros
 * `diasGracia` días de la semana (con 1 = el lunes) todavía se acepta la
 * semana pasada completa, así que el mínimo baja a su lunes.
 */
export function limiteCapturaMin(hoy: string, diasGracia: number): string {
  const lunes = lunesDe(hoy);
  const indiceEnSemana = Math.round((mediodia(hoy) - mediodia(lunes)) / DIA_MS);
  return indiceEnSemana < graciaSaneada(diasGracia)
    ? aFecha(mediodia(lunes) - 7 * DIA_MS)
    : lunes;
}
