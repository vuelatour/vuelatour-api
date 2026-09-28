/**
 * ¿ES UN VUELO DE SERVICIO? — FUENTE ÚNICA de la regla en el API
 * (28-sep-2026).
 *
 * Vuelo de SERVICIO = itinerario con al menos un tramo ACTIVO (no cancelado)
 * de parada `SERVICIO` y CERO pasajeros en TODOS los tramos activos: el avión
 * va al taller o a una parada técnica, no lleva a nadie y no es del cliente.
 *
 * La regla ya vivía COPIADA en dos lados del API —el candado de cotización
 * (`QuotesService.assertNoEsVueloDeServicio`: «no se cotiza») y la clave
 * `vtservicio` del Libro Dinero (`DineroReportService`)— y el 28-sep-2026 el
 * cliente pidió pintar esos vuelos de CAFÉ en los tres calendarios (panel, app
 * y Google): un tercer lector. Para que los tres no puedan divergir, la regla
 * vive AQUÍ y todos la llaman. Espejo exacto de `esVueloDeServicio` del panel
 * (`vuelatour-next/src/lib/admin/quote-revision.ts`).
 *
 * Detalles que NO se deben «arreglar»:
 * - Los pasajeros se leen POR TRAMO con null = 0 a propósito:
 *   `vuelo.pasajeros` tiene piso artificial de 1 en las reservas y la
 *   convención «null hereda el global» es de TUAS, no evidencia de que viaje
 *   alguien.
 * - Los tramos cancelados no cuentan (ni para la parada ni para los pax): un
 *   vuelo con todo cancelado NO es de servicio (es un cancelado).
 * - `tipo_parada` es un ENUM en BD (`public.tipo_parada`): PostgREST lo manda
 *   como texto, así que aquí se compara contra la cadena `'SERVICIO'`.
 *
 * PURO (sin BD): se prueba en `vuelo-servicio.util.spec.ts`.
 */

/**
 * Lo mínimo de un tramo (`escala`) que necesita la regla. Los campos son
 * `unknown` a propósito: los lectores traen filas tipadas de PostgREST,
 * `Record<string, unknown>` (Libro Dinero) o embeds; ninguno necesita un cast
 * para preguntar. Un campo AUSENTE se lee como «no»: sin `cancelada_at` el
 * tramo está activo (p. ej. la consulta ya filtró los cancelados).
 */
export interface TramoServicio {
  tipo_parada?: unknown;
  pasajeros?: unknown;
  cancelada_at?: unknown;
}

/** Valor de `escala.tipo_parada` que marca una parada de servicio. */
export const TIPO_PARADA_SERVICIO = 'SERVICIO';

/**
 * ¿El vuelo es de SERVICIO? = tramos activos, alguno con parada
 * `SERVICIO` y ninguno con pasajeros (> 0). Sin tramos activos ⇒ false.
 */
export function esVueloDeServicio(
  escalas: ReadonlyArray<TramoServicio | null | undefined> | null | undefined,
): boolean {
  const activas = (escalas ?? []).filter(
    (e): e is TramoServicio => e != null && !e.cancelada_at,
  );
  return (
    activas.length > 0 &&
    activas.some((e) => e.tipo_parada === TIPO_PARADA_SERVICIO) &&
    activas.every((e) => !(Number(e.pasajeros) > 0))
  );
}
