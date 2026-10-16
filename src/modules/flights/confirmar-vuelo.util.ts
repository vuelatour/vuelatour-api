import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

/**
 * CONFIRMAR UN VUELO desde el detalle (app y panel, 16-oct-2026, invariante
 * 84): `POST /v1/flights/:id/confirmar` acepta RESERVA, SOLICITUD y
 * COTIZADO. El COTIZADO sigue siendo la transición de `QuotesService.confirm`
 * (tramos del REDONDO, correo al cliente, calendario y aviso a la
 * tripulación): `FlightsService` NO la replica, la recibe inyectada por este
 * token. Token + interfaz (no la clase) para que `flights.service` siga sin
 * importar `quotes.service` en runtime (el ciclo flights ↔ quotes se evitó a
 * propósito con `import type`; ver la ficha mínima de avión).
 */
export const CONFIRMADOR_COTIZACION = Symbol('CONFIRMADOR_COTIZACION');

export interface ConfirmadorCotizacion {
  /** COTIZADO → CONFIRMADO con TODOS sus efectos; devuelve la fila del vuelo. */
  confirm(vueloId: string, userId: string): Promise<Record<string, unknown>>;
}

export type Faltante = 'aeronave' | 'piloto';

/**
 * Qué falta asignar para confirmar un vuelo PROPIO (orden fijo: aeronave,
 * piloto). Un vuelo EXTERNO (operador de fuera) no lleva avión ni piloto
 * propios — misma regla que `start`.
 */
export function faltaAsignacion(vuelo: {
  es_externo?: unknown;
  aeronave_id?: unknown;
  piloto_id?: unknown;
}): Faltante[] {
  if (vuelo.es_externo === true) return [];
  const falta: Faltante[] = [];
  if (!vuelo.aeronave_id) falta.push('aeronave');
  if (!vuelo.piloto_id) falta.push('piloto');
  return falta;
}

const NOMBRE_FALTANTE: Record<Faltante, string> = {
  aeronave: 'el avión',
  piloto: 'el piloto',
};

/** Folio/estado para el `message` (jamás «[object Object]»). */
const texto = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '?';

/** 409 VUELO_SIN_ASIGNAR: el panel/app ofrecen «Asignar» antes de confirmar. */
export function errorVueloSinAsignar(
  vuelo: { estado?: unknown; folio?: unknown },
  falta: Faltante[],
): ConflictException {
  const lista = falta.map((f) => NOMBRE_FALTANTE[f]).join(' y ');
  return new ConflictException({
    message: `No se puede confirmar el vuelo #${texto(vuelo.folio)}: falta asignar ${lista}.`,
    error: 'VUELO_SIN_ASIGNAR',
    details: {
      falta,
      estado: vuelo.estado ?? null,
      folio: vuelo.folio ?? null,
    },
  });
}

/** 409 VUELO_NO_CONFIRMABLE: EN_VUELO, COMPLETADO o CANCELADO. */
export function errorVueloNoConfirmable(vuelo: {
  estado?: unknown;
  folio?: unknown;
}): ConflictException {
  return new ConflictException({
    message: `No se puede confirmar un vuelo en estado ${texto(vuelo.estado)}.`,
    error: 'VUELO_NO_CONFIRMABLE',
    details: { estado: vuelo.estado ?? null, folio: vuelo.folio ?? null },
  });
}

/**
 * 503: el confirmador de cotizaciones no está inyectado (arranque parcial,
 * specs). En la app siempre está; jamás se confirma un COTIZADO a medias.
 */
export function errorConfirmacionNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message:
      'La confirmación de cotizaciones no está disponible en este momento. Intenta de nuevo en unos minutos.',
    error: 'CONFIRMACION_NO_DISPONIBLE',
  });
}
