import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Tripulación EFECTIVA de un vuelo (auditoría de notificaciones, 21-ago-2026):
 * piloto, copiloto y apoyo del vuelo + pilotos explícitos de los tramos
 * vivos. FUENTE ÚNICA para "¿a quién le avisamos?" — la usan flights.service
 * y quotes.service (evita dependencia circular entre módulos). Los pilotos
 * externos los filtra notifications.notifyUser (sin acceso al sistema).
 */
export async function tripulacionDeVuelo(
  sb: SupabaseClient,
  vueloId: string,
  vuelo?: Record<string, unknown> | null,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let v = vuelo ?? null;
  if (!v) {
    const { data } = await sb
      .from('vuelo')
      .select('piloto_id, copiloto_id, apoyo_id')
      .eq('id', vueloId)
      .maybeSingle();
    v = data ?? null;
  }
  for (const k of ['piloto_id', 'copiloto_id', 'apoyo_id']) {
    const id = (v?.[k] as string | null | undefined) ?? null;
    if (id) ids.add(id);
  }
  const { data: escalas } = await sb
    .from('escala')
    .select('piloto_id')
    .eq('vuelo_id', vueloId)
    .is('cancelada_at', null)
    .not('piloto_id', 'is', null);
  for (const e of escalas ?? []) {
    if (e.piloto_id) ids.add(e.piloto_id as string);
  }
  return ids;
}
