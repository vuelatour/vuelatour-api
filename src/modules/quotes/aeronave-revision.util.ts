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
 * LA COTIZACIÓN ES INDEPENDIENTE DE LA OPERACIÓN (cliente, 12-sep-2026,
 * cotización #298): «se cotiza con un avión y se vuela con otro por distintos
 * motivos, pero la cotización no debe verse afectada por cambios en el vuelo
 * operativo». El avión COTIZADO es el del SNAPSHOT vigente
 * (`calculo_snapshot.aeronave.id`); el OPERATIVO es `vuelo.aeronave_id` /
 * los tramos. Por eso el cotizador del panel rehidrata su selector desde el
 * COTIZADO y esta regla compara contra el COTIZADO, no contra el operativo:
 * antes, con el vuelo reasignado a otro avión, guardar una versión SIN tocar
 * el selector se leía como «cambio deliberado» y REASIGNABA el vuelo al avión
 * de la cotización (regresión del caso #80).
 *
 * REGLA (12-sep-2026):
 * - `cambio_deliberado` = el DTO trae un avión DISTINTO del COTIZADO (o del
 *   operativo si aún no hay snapshot) ⇒ el operador eligió OTRO avión en el
 *   cotizador: manda y se persiste (el vuelo y sus tramos vivos se mueven con
 *   el blanket SELECTIVO de siempre, previo pre-check de `assign`).
 * - Sin cambio deliberado ⇒ `vuelo.aeronave_id` conserva el OPERATIVO
 *   (`tramo ?? vuelo ?? dto`) y el PRECIO se calcula con el avión del DTO
 *   (= el cotizado) — caso #80 y caso #298 a la vez.
 * - GUARDA: un DTO que re-envía el avión que YA opera el vuelo no es una
 *   asignación nueva (no hay nada que asignar, el vuelo ya está en él): no
 *   cuenta como cambio deliberado, así que no dispara pre-check de squawk ni
 *   blanket a tramos. Sin ella, un panel viejo —que rehidrataba desde
 *   `vuelo.aeronave_id`— empezaría a rebotar 409 por un squawk ALTA del avión
 *   que el vuelo ya está volando.
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
  /** `vuelo.aeronave_id` persistido = el avión OPERATIVO de hoy. */
  aeronaveVuelo?: string | null;
  /**
   * Avión COTIZADO = `calculo_snapshot.aeronave.id` del snapshot VIGENTE (lo
   * que el cotizador del panel muestra en su selector). Sin snapshot (reserva
   * recién creada) se compara contra el operativo, como antes.
   */
  aeronaveCotizada?: string | null;
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

/**
 * Avión COTIZADO de un vuelo persistido: el id del avión del SNAPSHOT
 * vigente. A diferencia de `modeloCotizadoDe` (presentación al cliente, que
 * oculta la referencia de tarifa de un externo), aquí el externo SÍ devuelve
 * su referencia: es con la que se pactó el precio y con la que el cotizador
 * rehidrata su selector.
 */
export function idAeronaveCotizada(calculoSnapshot: unknown): string | null {
  const snap = calculoSnapshot as { aeronave?: { id?: unknown } | null } | null;
  return limpio(snap?.aeronave?.id);
}

export function resolverAeronaveDeRevision(
  input: AeronaveRevisionInput,
): AeronaveRevisionResultado {
  const dto = limpio(input.aeronaveDto);
  const vuelo = limpio(input.aeronaveVuelo);
  const cotizada = limpio(input.aeronaveCotizada);
  const tramo = limpio(input.aeronavePrimerTramoActivo);
  // Contra qué se compara el selector del cotizador: el COTIZADO manda; sin
  // snapshot (reserva sin cotizar) queda el operativo, como antes.
  const referencia = cotizada ?? vuelo;
  const cambioDeliberado =
    input.conservarOperativo !== true &&
    dto != null &&
    dto !== referencia &&
    dto !== vuelo;
  if (cambioDeliberado) {
    return {
      aeronave_id: dto,
      cambio_deliberado: true,
      aeronave_anterior: vuelo,
    };
  }
  return {
    aeronave_id: tramo ?? vuelo ?? dto,
    cambio_deliberado: false,
    aeronave_anterior: null,
  };
}
