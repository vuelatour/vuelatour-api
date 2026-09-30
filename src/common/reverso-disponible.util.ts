/**
 * SONDA ÚNICA de la migración `20260930000001_movimiento_bancario_reverso.sql`
 * (30-sep-2026): columna `movimiento_bancario.reverso_de_id` (el ABONO que
 * devuelve un CARGO), su índice único y el trigger
 * `tg_mov_bancario_reverso`. La migración es atómica: basta sondear la
 * columna (patrón `columnaOpcional`: re-sondeo ≤ 10 min, se enciende sola al
 * aplicarla, sin redeploy).
 *
 * REGLA DURA: todo select/update/filtro que nombre `reverso_de_id` va detrás
 * de `await reversosDisponibles(sb)`. Sin la migración: la conciliación, el
 * re-cruce, la importación, la lista y el reporte responden EXACTAMENTE como
 * hoy, y las rutas nuevas (`…/reverso-candidatos`, `…/reverso`,
 * `reversos/auto`) responden 503 `REVERSOS_NO_DISPONIBLE`.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from './columna-opcional.util';

/** Migración que crea el emparejado cargo ↔ devolución. */
export const MIGRACION_REVERSOS = '20260930000001';

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function reversosDisponibles(sb: SupabaseClient): Promise<boolean> {
  return columnaOpcional(sb, 'movimiento_bancario', 'reverso_de_id', {
    mensajeAusente:
      `Columna movimiento_bancario.reverso_de_id no existe todavía: el ` +
      `emparejado de cargos devueltos responde 503 hasta aplicar la ` +
      `migración ${MIGRACION_REVERSOS} (la conciliación sigue como hoy)`,
  }).disponible();
}

/** 503 estructurado (texto exacto del contrato). */
export function errorReversosNoDisponibles(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message:
      'El emparejado de cargos devueltos todavía no está habilitado en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.',
    error: 'REVERSOS_NO_DISPONIBLE',
    details: { migracion: MIGRACION_REVERSOS },
  });
}
