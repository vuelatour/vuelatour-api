/**
 * SONDA ÚNICA de la migración `20261016000003_gasto_factura_recibida.sql`
 * (16-oct-2026, API 0.0.87, invariante 87): VARIAS facturas recibidas por
 * gasto (ASA entrega 5 CFDI por carga de combustible).
 *
 * La migración es ATÓMICA: la columna `factura_recibida.pdf_sha256` existe ⇔
 * existen la tabla puente `gasto_factura_recibida` y el trigger
 * `trg_gasto_factura_principal_en_puente`. Por eso basta sondear UNA columna
 * (patrón `columnaOpcional`: re-sondeo ≤ 10 min, se enciende sola al
 * aplicarla, sin redeploy). El «sí» se memoriza PARA SIEMPRE: tras un
 * ROLLBACK de la migración hay que reiniciar el API.
 *
 * REGLA DURA: todo select/insert/update que nombre `pdf_sha256` o la tabla
 * `gasto_factura_recibida` va detrás de `await gastoFacturasDisponible(sb)`.
 * Sin la migración el API se comporta como 0.0.85: UNA factura por gasto
 * (`gasto.factura_recibida_id`), subir otra la REEMPLAZA (shape viejo), y
 * subir VARIAS en una llamada responde 503 `FACTURAS_GASTO_NO_DISPONIBLE`
 * ANTES de escribir nada.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea la puente gasto ⟷ factura recibida. */
export const MIGRACION_GASTO_FACTURAS = '20261016000003';

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function gastoFacturasDisponible(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'factura_recibida', 'pdf_sha256', {
    mensajeAusente:
      `Columna factura_recibida.pdf_sha256 no existe todavía: una factura ` +
      `por gasto (como 0.0.85) hasta aplicar la migración ` +
      `${MIGRACION_GASTO_FACTURAS}`,
  }).disponible();
}

/** Texto del 503 (es-MX, para el operador). */
export const MENSAJE_FACTURAS_GASTO_NO_DISPONIBLE =
  'Subir varias facturas a un mismo gasto todavía no está habilitado en la base de datos (falta aplicar una actualización). Sube una factura por ahora, o vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.';

/** 503 estructurado `FACTURAS_GASTO_NO_DISPONIBLE`. */
export function errorFacturasGastoNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_FACTURAS_GASTO_NO_DISPONIBLE,
    error: 'FACTURAS_GASTO_NO_DISPONIBLE',
    details: { migracion: MIGRACION_GASTO_FACTURAS },
  });
}
