/**
 * SONDA ÚNICA de la migración `20260924000004_ingresos.sql` (24-sep-2026):
 * tabla `ingreso` + `ingreso_bitacora`, `cobro_vuelo.ingreso_anticipo_id`,
 * `movimiento_bancario.ingreso_id`, triggers y bucket `ingresos`.
 *
 * La migración es ATÓMICA: la columna `movimiento_bancario.ingreso_id`
 * existe ⇔ existen la tabla `ingreso` y `cobro_vuelo.ingreso_anticipo_id`.
 * Por eso basta sondear UNA columna (patrón `columnaOpcional`: re-sondeo
 * ≤ 10 min, se enciende sola al aplicarla, sin redeploy).
 *
 * REGLA DURA: todo select/insert/update/`.is()`/embed que nombre
 * `ingreso_id`, `ingreso_anticipo_id` o la tabla `ingreso` FUERA del módulo
 * `ingresos` va detrás de `await ingresosDisponibles(sb)`. Sin la
 * migración: conciliación, cobros, pre-cierre y reportes responden
 * EXACTAMENTE como hoy; `/v1/ingresos/*` y las rutas nuevas de conciliación
 * responden 503 `INGRESOS_NO_DISPONIBLE`.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea los ingresos y la conciliación de ingresos. */
export const MIGRACION_INGRESOS = '20260924000004';

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function ingresosDisponibles(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'movimiento_bancario', 'ingreso_id', {
    mensajeAusente:
      `Columna movimiento_bancario.ingreso_id no existe todavía: los ingresos ` +
      `y la conciliación de ingresos responden 503 hasta aplicar la ` +
      `migración ${MIGRACION_INGRESOS} (conciliación y cobros siguen como hoy)`,
  }).disponible();
}

/** 503 estructurado (texto exacto del contrato). */
export function errorIngresosNoDisponibles(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message:
      'Los ingresos todavía no están habilitados en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.',
    error: 'INGRESOS_NO_DISPONIBLE',
    details: { migracion: MIGRACION_INGRESOS },
  });
}
