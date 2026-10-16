/**
 * SONDA ÚNICA de la migración `20261016000001_cobro_factura_emitida.sql`
 * (16-oct-2026, API 0.0.82, invariante 84): FACTURAS POR COBRO. Un vuelo
 * puede llevar VARIAS facturas emitidas y cada cobro dice cuál lo ampara
 * (`cobro_vuelo.factura_emitida_id`, FK a `factura_emitida` ON DELETE SET
 * NULL). Es CLASIFICACIÓN, no dinero: no entra a `cobrosEnUsd`, al reparto,
 * al balance ni al candado de conciliación.
 *
 * Patrón `columnaOpcional` (re-sondeo ≤ 10 min, se enciende sola al aplicar
 * la migración, sin redeploy). REGLA DURA: todo select/insert/update que
 * nombre `cobro_vuelo.factura_emitida_id` va detrás de esta sonda:
 * - sin ella, LIGAR (POST/PATCH del cobro con `factura_emitida_id`,
 *   `cobro_ids` no vacío al registrar/editar una factura) responde 503
 *   `COBRO_FACTURA_NO_DISPONIBLE` ANTES de escribir nada;
 * - las lecturas salen sin la llave (`factura_emitida` ausente en el cobro,
 *   `cobros` ausente en el candidato, `asignacion_disponible: false` en el
 *   bloque, `cobros_n: 0`, `cobros_sin_factura: 0`).
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea `cobro_vuelo.factura_emitida_id` y sus triggers. */
export const MIGRACION_COBRO_FACTURA = '20261016000001';

/** Texto del 503 (es-MX, para el operador). */
export const MENSAJE_COBRO_FACTURA_NO_DISPONIBLE = `Todavía no se puede asignar factura a un cobro: falta aplicar la migración ${MIGRACION_COBRO_FACTURA}.`;

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function cobroFacturaDisponible(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'cobro_vuelo', 'factura_emitida_id', {
    mensajeAusente:
      `Columna cobro_vuelo.factura_emitida_id no existe todavía: asignar ` +
      `factura a un cobro responde 503 COBRO_FACTURA_NO_DISPONIBLE y las ` +
      `lecturas salen sin la liga hasta aplicar la migración ${MIGRACION_COBRO_FACTURA}`,
  }).disponible();
}

/**
 * Sufijo de columnas para un select de `cobro_vuelo`: `', factura_emitida_id'`
 * con la migración, `''` sin ella (la columna NUNCA se nombra sin la sonda).
 * El select resultante ya no es un literal: el parser de tipos de
 * supabase-js no lo entiende y cada lector castea la fila (`as unknown as`),
 * como ya hace `facturasDeVuelos` con sus columnas dinámicas.
 */
export function colCobroFactura(disponible: boolean): string {
  return disponible ? ', factura_emitida_id' : '';
}

/** 503 estructurado `COBRO_FACTURA_NO_DISPONIBLE` (texto exacto del contrato). */
export function errorCobroFacturaNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_COBRO_FACTURA_NO_DISPONIBLE,
    error: 'COBRO_FACTURA_NO_DISPONIBLE',
    details: { migracion: MIGRACION_COBRO_FACTURA },
  });
}
