/**
 * SONDA ÚNICA de la migración `20261012000002_conciliacion_abono_cobros.sql`
 * (12-oct-2026, API 0.0.71): 1 abono del banco ↔ N cobros de vuelo («un
 * pago para varios vuelos», caso #379 + #380). Crea la tabla puente
 * `movimiento_bancario_cobro` (FUENTE ÚNICA de la liga abono ↔ cobro), la
 * columna `movimiento_bancario.cobros_n` y las RPC
 * `conciliacion_ligar_abono_cobros` / `conciliacion_desligar_abono_cobros`.
 * La migración es atómica: basta sondear la columna (patrón
 * `columnaOpcional`: re-sondeo ≤ 10 min, se enciende sola al aplicarla, sin
 * redeploy). El «sí» se memoriza PARA SIEMPRE: tras el ROLLBACK hay que
 * reiniciar (o redesplegar) el API.
 *
 * REGLA DURA: todo select/update/filtro que nombre `cobros_n`, la puente o
 * las RPC va detrás de `await cobrosLoteDisponibles(sb)`. Sin la migración:
 * la liga de UN cobro sigue por el camino directo de siempre (`cobro_id`), un
 * lote (N ≥ 2) responde 503 `CONCILIACION_COBROS_NO_DISPONIBLE` y los
 * lectores miran SOLO el espejo `cobro_id`.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional, esTablaInexistente } from './columna-opcional.util';
import { esFuncionInexistente } from './updated-at-trigger.util';

/** Migración que crea la puente abono ↔ cobros. */
export const MIGRACION_COBROS_LOTE = '20261012000002';

/** Texto del 503 (es-MX, para el operador). */
export const MENSAJE_COBROS_LOTE_NO_DISPONIBLE =
  'La conciliación de un abono con varios cobros todavía no está habilitada en la base de datos (falta aplicar una actualización). Mientras, vincula el abono a un solo cobro; si sigue igual en unos minutos, avisa a soporte.';

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function cobrosLoteDisponibles(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'movimiento_bancario', 'cobros_n', {
    mensajeAusente:
      `Columna movimiento_bancario.cobros_n no existe todavía: la conciliación ` +
      `de un abono con varios cobros responde 503 hasta aplicar la migración ` +
      `${MIGRACION_COBROS_LOTE} (la liga de UN cobro sigue como hoy)`,
  }).disponible();
}

/** 503 estructurado `CONCILIACION_COBROS_NO_DISPONIBLE`. */
export function errorCobrosLoteNoDisponibles(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_COBROS_LOTE_NO_DISPONIBLE,
    error: 'CONCILIACION_COBROS_NO_DISPONIBLE',
    details: { migracion: MIGRACION_COBROS_LOTE },
  });
}

/** Objetos de la migración que el API nombra DIRECTAMENTE. */
export const OBJETOS_COBROS_LOTE = [
  'conciliacion_ligar_abono_cobros',
  'conciliacion_desligar_abono_cobros',
  'movimiento_bancario_cobro',
] as const;

/**
 * ¿El error de la RPC/tabla dice que la migración NO está (todavía)? Misma
 * regla que `esPartesAusentes`: `PGRST202`/`PGRST205` (fuera del schema
 * cache), o `42883`/`42P01` SOLO si el mensaje nombra uno de
 * `OBJETOS_COBROS_LOTE`. Un «operator does not exist» (42883 de un cuerpo
 * plpgsql con un ENUM comparado sin `::text`) NUNCA es «falta la migración».
 */
export function esCobrosLoteAusente(
  err: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!err) return false;
  if (err.code === 'PGRST202' || err.code === 'PGRST205') return true;
  const msg = (err.message ?? '').toLowerCase();
  if (msg.includes('operator does not exist')) return false;
  if (!(esFuncionInexistente(err) || esTablaInexistente(err))) return false;
  return OBJETOS_COBROS_LOTE.some((o) => msg.includes(o));
}
