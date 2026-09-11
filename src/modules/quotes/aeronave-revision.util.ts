/**
 * AVIÓN QUE QUEDA EN `vuelo.aeronave_id` AL REVISAR UNA COTIZACIÓN — fuente
 * única compartida por `quotes.revise()`, `quickAdjust()` y el quote-like de
 * la vista previa (si divergen, la hoja muestra un avión y se guarda otro).
 *
 * HISTORIA (bug cotización #254, 11-sep-2026): la regla anterior era
 * «el avión del primer tramo ACTIVO manda SIEMPRE sobre el del cotizador».
 * Nació del caso #80 (cotizado en XA-VGV, volado en N990GG: registrar un
 * cobro —que pasa por `quickAdjust` → `revise`— regresaba el vuelo al avión
 * de la cotización). Pero como el cotizador del panel rehidrata su default
 * desde `vuelo.aeronave_id`, esa regla también se tragaba el cambio
 * DELIBERADO del operador: se guardaba la versión nueva con el avión nuevo
 * en el snapshot/historial, `vuelo.aeronave_id` seguía en el avión viejo, el
 * formulario volvía a abrir con el viejo y CADA versión repetía el mismo
 * diff «Avión PIPER SENECA V→…» mientras la hoja seguía diciendo
 * «Aeronave cotizada: PIPER SENECA V».
 *
 * REGLA (11-sep-2026):
 * - El cotizador CAMBIÓ el avión (`aeronaveDto` ≠ `aeronaveVuelo`) ⇒ es un
 *   cambio deliberado del operador y MANDA (el vuelo y sus tramos vivos se
 *   mueven con el blanket SELECTIVO de siempre).
 * - No lo cambió ⇒ el OPERATIVO manda: el avión del primer tramo activo
 *   (asignación por tramo del piloto) se conserva — caso #80 intacto.
 * - `conservarOperativo` (quickAdjust y toda revisión que NO nace del
 *   cotizador): el operativo manda SIEMPRE, aunque el DTO traiga otro avión
 *   (quickAdjust re-envía a propósito el avión del SNAPSHOT para no mover el
 *   precio; eso jamás debe reasignar el vuelo).
 *
 * Puro: no toca BD ni muta nada.
 */

export interface AeronaveRevisionInput {
  /** Avión que manda el DTO de revisión (referencia de tarifa del motor). */
  aeronaveDto?: string | null;
  /** `vuelo.aeronave_id` persistido (lo que el cotizador mostró de default). */
  aeronaveVuelo?: string | null;
  /** Avión del primer tramo VIVO (asignación por tramo); null = hereda. */
  aeronavePrimerTramoActivo?: string | null;
  /** true = revisión que NO nace del cotizador (quickAdjust): no reasigna. */
  conservarOperativo?: boolean;
}

export interface AeronaveRevisionResultado {
  /** Avión que se escribe en `vuelo.aeronave_id` (null = sin avión). */
  aeronave_id: string | null;
  /** true = el operador cambió el avión desde el cotizador. */
  cambio_deliberado: boolean;
  /**
   * Avión anterior del vuelo cuando hubo cambio deliberado (el blanket
   * selectivo solo pisa tramos heredados —null— o de ESTE avión). null si no
   * hay cambio o el vuelo no tenía avión.
   */
  aeronave_anterior: string | null;
}

const limpio = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v : null;

export function resolverAeronaveDeRevision(
  input: AeronaveRevisionInput,
): AeronaveRevisionResultado {
  const dto = limpio(input.aeronaveDto);
  const vuelo = limpio(input.aeronaveVuelo);
  const tramo = limpio(input.aeronavePrimerTramoActivo);
  const cambioDeliberado =
    input.conservarOperativo !== true && dto != null && dto !== vuelo;
  if (cambioDeliberado) {
    return {
      aeronave_id: dto,
      cambio_deliberado: true,
      aeronave_anterior: vuelo,
    };
  }
  return {
    aeronave_id: tramo ?? dto ?? vuelo,
    cambio_deliberado: false,
    aeronave_anterior: null,
  };
}
