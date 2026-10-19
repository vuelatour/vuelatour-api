/**
 * SONDA ÚNICA de la migración `20261019000001_gasto_por_pagar.sql`
 * (19-oct-2026, gastos «por pagar» con fecha a futuro, invariante 93):
 * columna `gasto.por_pagar` (boolean NOT NULL DEFAULT false). Patrón
 * `columnaOpcional`: re-sondeo ≤ 10 min, se enciende sola al aplicarla, sin
 * redeploy.
 *
 * REGLA DURA: todo select / insert / update / filtro que nombre
 * `gasto.por_pagar` va detrás de `await porPagarDisponible(sb)` (Gastos
 * `cols()`/`listCols()`, el filtro `?por_pagar`, alta y PATCH, caja chica,
 * `/me/capturas`, gastos del vuelo, pre-cierre y el recordatorio). Sin la
 * migración: todo como el 0.0.94 (límites de fecha de siempre, ninguna
 * llave nueva salvo `config.gastos_por_pagar: false`) y `por_pagar: true`
 * en un alta o PATCH ⇒ 503 `POR_PAGAR_NO_DISPONIBLE`.
 *
 * El «sí» se memoriza PARA SIEMPRE: tras el ROLLBACK de la migración hay que
 * reiniciar o redesplegar el API (si no, Gastos, caja chica y el pre-cierre
 * nombran una columna inexistente ⇒ 500).
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea `gasto.por_pagar`. */
export const MIGRACION_POR_PAGAR = '20261019000001';

/** Código del 503 cuando llega `por_pagar: true` sin la migración. */
export const CODIGO_POR_PAGAR_NO_DISPONIBLE = 'POR_PAGAR_NO_DISPONIBLE';

/** Texto del 503 (el panel y la app lo enseñan tal cual). */
export const MENSAJE_POR_PAGAR_NO_DISPONIBLE =
  'Los gastos por pagar todavía no están activos: avisa a sistemas.';

/** ¿Ya existe `gasto.por_pagar`? (memorizado; re-sondeo ≤ 10 min). */
export function porPagarDisponible(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'gasto', 'por_pagar', {
    mensajeAusente:
      `Columna gasto.por_pagar no existe todavía: los gastos con fecha a ` +
      `futuro siguen con los límites de siempre hasta aplicar la migración ` +
      `${MIGRACION_POR_PAGAR}`,
  }).disponible();
}

/**
 * Sufijo de columnas de un select de `gasto` según la sonda:
 * `', por_pagar, conciliado'` con la migración (el estado de pago necesita
 * las dos), `''` sin ella.
 */
export function colsPorPagar(disponible: boolean): string {
  return disponible ? ', por_pagar, conciliado' : '';
}

/** 503 `POR_PAGAR_NO_DISPONIBLE` con `details.migracion`. */
export function errorPorPagarNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_POR_PAGAR_NO_DISPONIBLE,
    error: CODIGO_POR_PAGAR_NO_DISPONIBLE,
    details: { migracion: MIGRACION_POR_PAGAR },
  });
}
