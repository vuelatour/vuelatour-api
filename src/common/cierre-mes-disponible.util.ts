/**
 * SONDA ÚNICA de la migración `20261016000004_cierre_mes.sql` (16-oct-2026,
 * API 0.0.88, invariante 89): CIERRE DE MES formal + vuelos pendientes de
 * cobro que pasan al mes siguiente.
 *
 * La migración es ATÓMICA: `vuelo.periodo_contable` existe ⇔ existen
 * `vuelo.fecha_contable` (generada), `cierre_mes` y `cierre_mes_vuelo`. Basta
 * sondear UNA columna (patrón `columnaOpcional`: re-sondeo ≤ 10 min, se
 * enciende sola al aplicarla, sin redeploy). El «sí» se memoriza PARA
 * SIEMPRE: tras un ROLLBACK de la migración hay que reiniciar el API.
 *
 * REGLA DURA: todo select/insert/update que nombre `periodo_contable`,
 * `fecha_contable`, `cierre_mes` o `cierre_mes_vuelo` va detrás de
 * `await cierreMesDisponible(sb)`. Sin la migración el API es el 0.0.87
 * byte a byte: lectores por `fecha_vuelo`, `GET /v1/cierres` ⇒
 * `{disponible:false, meses:[]}`, escrituras ⇒ 503 `CIERRE_NO_DISPONIBLE` y
 * ningún candado `MES_CERRADO` (nada puede estar cerrado).
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración del cierre de mes. */
export const MIGRACION_CIERRE_MES = '20261016000004';

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function cierreMesDisponible(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'vuelo', 'periodo_contable', {
    mensajeAusente:
      `Columna vuelo.periodo_contable no existe todavía: sin cierre de mes ` +
      `(lectores por fecha_vuelo, como 0.0.87) hasta aplicar la migración ` +
      `${MIGRACION_CIERRE_MES}`,
  }).disponible();
}

/** Migración del CIERRE POR AVIÓN (23-oct-2026, API 0.0.104, invariante 105). */
export const MIGRACION_CIERRE_MES_AVION = '20261023000001';

/**
 * SEGUNDA SONDA (23-oct-2026, invariante 105): ¿existe `cierre_mes_avion`?
 * (columna `periodo`; la migración crea la tabla entera, así que un «la
 * tabla no existe» también cuenta como «todavía no»). Sin ella el API
 * responde como el 0.0.103 (cierre GLOBAL de toda la flota) para que el
 * deploy del API antes de la migración no reviente nada: `GET /v1/cierres`
 * ⇒ `por_avion: false`, candado solo por la fila global, libros sin
 * `cierre_avion`. Requiere la primera sonda (sin `cierre_mes` no hay nada).
 * REGLA DURA: todo select/insert/update que nombre `cierre_mes_avion` o
 * `cierre_mes_avion_vuelo` va detrás de `await cierrePorAvionDisponible(sb)`.
 */
export async function cierrePorAvionDisponible(
  sb: SupabaseClient,
): Promise<boolean> {
  if (!(await cierreMesDisponible(sb))) return false;
  return columnaOpcional(sb, 'cierre_mes_avion', 'periodo', {
    tambienTabla: true,
    mensajeAusente:
      `Tabla cierre_mes_avion no existe todavía: el cierre de mes sigue siendo ` +
      `de toda la flota (como 0.0.103) hasta aplicar la migración ` +
      `${MIGRACION_CIERRE_MES_AVION}`,
  }).disponible();
}

/** Texto del 503 (es-MX, para el operador). */
export const MENSAJE_CIERRE_NO_DISPONIBLE =
  'El cierre de mes todavía no está habilitado en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.';

/** 503 estructurado `CIERRE_NO_DISPONIBLE`. */
export function errorCierreNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_CIERRE_NO_DISPONIBLE,
    error: 'CIERRE_NO_DISPONIBLE',
    details: { migracion: MIGRACION_CIERRE_MES },
  });
}

/** Texto del 503 del cierre POR AVIÓN (es-MX, para el operador). */
export const MENSAJE_CIERRE_POR_AVION_NO_DISPONIBLE =
  'El cierre de mes por avión todavía no está habilitado en la base de datos (falta aplicar una actualización). Por ahora el mes se cierra completo; si sigue igual, avisa a soporte.';

/**
 * 503 estructurado `CIERRE_POR_AVION_NO_DISPONIBLE` (invariante 105): se
 * pidió `aeronave_id` y la migración por avión no está. Nunca se cierra
 * «toda la flota» por un clic que pidió UN avión.
 */
export function errorCierrePorAvionNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_CIERRE_POR_AVION_NO_DISPONIBLE,
    error: 'CIERRE_POR_AVION_NO_DISPONIBLE',
    details: { migracion: MIGRACION_CIERRE_MES_AVION },
  });
}
