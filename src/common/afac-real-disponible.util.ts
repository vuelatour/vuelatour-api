/**
 * SONDA ÚNICA de la migración `20261016000005_afac_real.sql` (16-oct-2026,
 * API 0.0.89, invariante 90): AFAC POR VUELO — RESERVADO vs COSTO REAL.
 *
 * La migración es ATÓMICA: `gasto.es_pago_afac` existe ⇔ existen
 * `afac_vuelo` y `afac_vuelo_bitacora`. Basta sondear UNA columna (patrón
 * `columnaOpcional`: re-sondeo ≤ 10 min, se enciende sola al aplicarla, sin
 * redeploy). El «sí» se memoriza PARA SIEMPRE: tras la REVERSA hay que
 * reiniciar el API.
 *
 * REGLA DURA: todo select/insert/update que nombre `es_pago_afac`,
 * `afac_vuelo` o `afac_vuelo_bitacora` va detrás de
 * `await afacRealDisponible(sb)`. Sin la migración el API se comporta como
 * el 0.0.88 en todo lo que toca la marca y el costo real: ningún gasto está
 * marcado (nadie lo lee), las filas AFAC por vuelo del Balance general salen
 * SIN costo real y NO editables, y las escrituras responden 503
 * `AFAC_REAL_NO_DISPONIBLE`.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración del costo real AFAC por vuelo. */
export const MIGRACION_AFAC_REAL = '20261016000005';

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function afacRealDisponible(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'gasto', 'es_pago_afac', {
    mensajeAusente:
      `Columna gasto.es_pago_afac no existe todavía: sin costo real AFAC ` +
      `ni marca «Pago de AFAC» (conducta 0.0.88) hasta aplicar la migración ` +
      `${MIGRACION_AFAC_REAL}`,
  }).disponible();
}

/**
 * `, es_pago_afac` (con coma inicial) para anexar a un select de `gasto`, o
 * '' sin la migración (patrón `colTuaIncluida`).
 */
export function colPagoAfac(disponible: boolean): string {
  return disponible ? ', es_pago_afac' : '';
}

/** Texto del 503 (es-MX, para el operador). */
export const MENSAJE_AFAC_REAL_NO_DISPONIBLE =
  'El costo real AFAC todavía no está habilitado en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.';

/** 503 estructurado `AFAC_REAL_NO_DISPONIBLE`. */
export function errorAfacRealNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_AFAC_REAL_NO_DISPONIBLE,
    error: 'AFAC_REAL_NO_DISPONIBLE',
    details: { migracion: MIGRACION_AFAC_REAL },
  });
}
