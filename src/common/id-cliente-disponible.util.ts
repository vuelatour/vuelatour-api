/**
 * SONDA ÚNICA de la migración `20261013000006_vuelo_id_cliente.sql`
 * (13-oct-2026, API 0.0.75, invariante 68): ID de vuelo por cliente junto al
 * folio — `cliente.alias`, `vuelo.consecutivo_cliente`, el contador
 * `cliente_consecutivo_vuelo` y sus dos triggers.
 *
 * La migración es ATÓMICA: si existe `vuelo.consecutivo_cliente`, también
 * existen `cliente.alias`, el contador y los triggers. Basta sondear UNA
 * columna (patrón `columnaOpcional`: re-sondeo ≤ 10 min, se enciende sola al
 * aplicarla, sin redeploy).
 *
 * REGLA DURA: todo select, insert, update, filtro o embed que nombre
 * `consecutivo_cliente`, `cliente.alias` o `cliente_consecutivo_vuelo` va
 * detrás de `await idClienteDisponible(sb)`. Sin la migración: `clave_cliente`
 * sale null, `/v1/clients` responde como el 0.0.74 (más `alias_disponible:
 * false`) y un `alias` en el body ⇒ 503 `ID_CLIENTE_NO_DISPONIBLE`.
 *
 * El «sí» se memoriza PARA SIEMPRE: después de la reversa de la migración
 * hay que REINICIAR el API (si no, `/v1/clients` y las listas responden
 * 42703). `columnaOpcional` devuelve true, SIN memorizar, ante errores que no
 * son 42703/PGRST204: por eso la búsqueda nunca nombra la columna en el
 * `.or()` y el lector de claves nunca lanza.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea el ID de vuelo por cliente. */
export const MIGRACION_ID_CLIENTE = '20261013000006';

/** Texto del 503 (es-MX, para el operador). */
export const MENSAJE_ID_CLIENTE_NO_DISPONIBLE =
  'El alias del cliente todavía no está habilitado en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.';

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function idClienteDisponible(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'vuelo', 'consecutivo_cliente', {
    mensajeAusente:
      `Columna vuelo.consecutivo_cliente no existe todavía: el ID de vuelo ` +
      `por cliente (alias + número) se omite hasta aplicar la migración ` +
      `${MIGRACION_ID_CLIENTE}`,
  }).disponible();
}

/** 503 estructurado `ID_CLIENTE_NO_DISPONIBLE` (texto exacto del contrato). */
export function errorIdClienteNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_ID_CLIENTE_NO_DISPONIBLE,
    error: 'ID_CLIENTE_NO_DISPONIBLE',
    details: { migracion: MIGRACION_ID_CLIENTE },
  });
}
