/**
 * CONTEXTO DEL CLIENTE PARA EL PRECIO — lector ÚNICO (27-nov-2026).
 *
 * Lo que el motor del cotizador necesita saber de un cliente frente a UN
 * avión, resuelto en UNA sola lectura (embed cliente → tarifa_cliente_aeronave
 * filtrado por la aeronave):
 *  - `esInterno`: pseudo-cliente de operación PROPIA (reposicionamiento,
 *    demostración, servicio) — sin hora mínima, tarifa default 0 y total $0
 *    válido; sus vuelos cuentan como COSTO del avión, no como venta.
 *  - `tarifaPreferencial`: tarifa por hora pactada con el cliente para esa
 *    aeronave (USD/hr), o null si no tiene (se administra en su perfil).
 *
 * Vivía como método privado de `QuotesService` (`contextoCliente`). Se movió
 * aquí, con la MISMA consulta, para que «cambiar el cliente de un vuelo»
 * (`FlightsService.cambiarCliente`) AVISE con la misma regla con la que el
 * motor cotiza, sin que flights dependa de quotes (ciclo) y sin una segunda
 * copia de la regla. `QuotesService.contextoCliente` delega aquí.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ContextoCliente {
  esInterno: boolean;
  tarifaPreferencial: number | null;
}

/** Columnas de la lectura (string plano: el parser tipado no digiere el embed filtrado). */
const COLS_CONTEXTO_CLIENTE: string =
  'es_interno, tarifas:tarifa_cliente_aeronave(tarifa_hora_usd)';

export async function leerContextoCliente(
  sb: SupabaseClient,
  clienteId: string,
  aeronaveId: string,
): Promise<ContextoCliente> {
  const { data, error } = await sb
    .from('cliente')
    .select(COLS_CONTEXTO_CLIENTE)
    .eq('id', clienteId)
    .eq('tarifas.aeronave_id', aeronaveId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const fila = data as unknown as {
    es_interno?: unknown;
    tarifas?: Array<{ tarifa_hora_usd: number | string }> | null;
  } | null;
  const filas = fila?.tarifas ?? [];
  const tarifa = filas.length > 0 ? Number(filas[0].tarifa_hora_usd) : 0;
  return {
    esInterno: fila?.es_interno === true,
    tarifaPreferencial: tarifa > 0 ? tarifa : null,
  };
}
