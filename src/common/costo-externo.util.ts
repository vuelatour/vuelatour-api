import { BadRequestException } from '@nestjs/common';

/**
 * FUENTE ÚNICA del costo del operador externo CON MONEDA (29-ago-2026).
 *
 * Lo capturable es {monto, moneda} (+ TC cuando la moneda es MXN);
 * `vuelo.costo_externo_usd` queda DERIVADO aquí y sigue siendo la única
 * columna que leen los lectores (reporte por vuelo, reparto de utilidades,
 * balance por avión) — ellos NO se tocan. TODO escritor (cotizar, revisar,
 * cubrir-externo, alta de vuelo externo, revertir a propio) pasa por aquí y
 * escribe las 4 columnas JUNTAS: costo_externo_monto / costo_externo_moneda /
 * costo_externo_tc / costo_externo_usd (nunca a medias).
 *
 * Criterio del TC (invariante 2 del repo: un monto MXN JAMÁS se suma crudo
 * como USD ni desaparece en silencio):
 * - USD ⇒ usd = monto; tc = null.
 * - MXN ⇒ TC efectivo = `tc` del DTO ?? `tcVuelo` (el tc_usd_mxn de la
 *   cotización, de respaldo). Sin ninguno se RECHAZA con 400 en la captura
 *   (el mismo diálogo tiene el campo de TC) — no se persiste a medias.
 * - Banda de plausibilidad 15–25 MXN/USD (la misma de la conciliación
 *   USD↔MXN): fuera de ella es casi seguro un error de captura.
 * - monto vacío/0 ⇒ TODO null ("aún sin pactar": un 0 fingía utilidad
 *   completa; el null lo delata el reparto en sin_costo_count).
 */
export interface CostoExternoResuelto {
  /** Monto capturado en SU moneda (2 decimales), o null = sin costo. */
  monto: number | null;
  moneda: 'USD' | 'MXN' | null;
  /** TC MXN/USD usado para derivar (solo moneda MXN). */
  tc: number | null;
  /** DERIVADO: lo que leen todos los lectores (costo_externo_usd). */
  usd: number | null;
}

/** Banda plausible del TC (espejo de la conciliación USD↔MXN). */
export const COSTO_EXTERNO_TC_MIN = 15;
export const COSTO_EXTERNO_TC_MAX = 25;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function resolverCostoExterno(input: {
  monto?: number | string | null;
  moneda?: string | null;
  tc?: number | string | null;
  /** TC de la cotización (vuelo.tc_usd_mxn), respaldo para moneda MXN. */
  tcVuelo?: number | string | null;
}): CostoExternoResuelto {
  const monto = Number(input.monto);
  if (!Number.isFinite(monto) || monto <= 0) {
    // Limpiar/sin costo: las 4 columnas quedan null.
    return { monto: null, moneda: null, tc: null, usd: null };
  }
  const montoR = round2(monto);
  const moneda: 'USD' | 'MXN' = input.moneda === 'MXN' ? 'MXN' : 'USD';
  if (moneda === 'USD') {
    return { monto: montoR, moneda, tc: null, usd: montoR };
  }
  const tc = [input.tc, input.tcVuelo]
    .map((v) => Number(v))
    .find((v) => Number.isFinite(v) && v > 0);
  if (!tc) {
    throw new BadRequestException(
      'El costo del operador externo está en MXN: captura el tipo de cambio (MXN por USD) para convertirlo.',
    );
  }
  if (tc < COSTO_EXTERNO_TC_MIN || tc > COSTO_EXTERNO_TC_MAX) {
    throw new BadRequestException(
      `Tipo de cambio ${tc} fuera del rango razonable (${COSTO_EXTERNO_TC_MIN}–${COSTO_EXTERNO_TC_MAX} MXN por USD): revisa la captura.`,
    );
  }
  return { monto: montoR, moneda, tc, usd: round2(montoR / tc) };
}
