/**
 * SONDA ÚNICA de la migración `20260924000003_factura_emitida.sql`
 * (24-sep-2026): registro de FACTURAS EMITIDAS a mano + SOLICITUD de factura
 * por vuelo («Necesito factura») + responsables de facturación.
 *
 * La migración es ATÓMICA: la columna `vuelo.factura_solicitada_at` existe
 * ⇔ existen `factura_emitida`, `factura_emitida_vuelo` y
 * `configuracion_sistema.valor_json`. Por eso basta sondear UNA columna
 * (patrón `columnaOpcional`: re-sondeo ≤ 10 min, se enciende sola al
 * aplicarla, sin redeploy).
 *
 * Sin la migración: las rutas `/v1/facturas-emitidas/*`, la solicitud y los
 * responsables responden 503 `FACTURAS_EMITIDAS_NO_DISPONIBLE`; el snapshot y
 * las listas mandan `factura_servicio: null` / `factura_servicio_resumen:
 * null`; el Excel, las etiquetas y los vuelos siguen EXACTAMENTE como hoy.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea el registro de facturas emitidas y la solicitud. */
export const MIGRACION_FACTURA_EMITIDA = '20260924000003';

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function facturaEmitidaDisponible(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'vuelo', 'factura_solicitada_at', {
    mensajeAusente:
      `Columna vuelo.factura_solicitada_at no existe todavía: el registro de ` +
      `facturas emitidas y «Necesito factura» responden 503 hasta aplicar la ` +
      `migración ${MIGRACION_FACTURA_EMITIDA}`,
  }).disponible();
}

/** 503 estructurado (texto exacto del contrato). */
export function errorFacturasNoDisponibles(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message:
      'Las facturas emitidas todavía no están habilitadas en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.',
    error: 'FACTURAS_EMITIDAS_NO_DISPONIBLE',
    details: { migracion: MIGRACION_FACTURA_EMITIDA },
  });
}
