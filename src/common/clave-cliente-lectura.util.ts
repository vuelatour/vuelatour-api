/**
 * LECTOR ÚNICO del ID de vuelo por cliente (13-oct-2026, API 0.0.75,
 * invariante 68): es el ÚNICO lugar que lee `vuelo.consecutivo_cliente` y
 * `cliente.alias` para ARMAR (`clavesClienteDeVuelos`) o BUSCAR
 * (`vueloIdsPorClaveCliente`) IDs. El texto lo arma la fuente pura
 * `clave-cliente.util.ts`.
 *
 * Best-effort y NUNCA lanza: una etiqueta jamás tumba una lista, un detalle
 * ni un cierre. Todo va detrás de la sonda `idClienteDisponible` (sin la
 * migración no se lee nada) y dentro de try/catch: un error de PostgREST o
 * una excepción ⇒ `warn` y el resultado vacío. Es TODO O NADA por llamada:
 * una hoja nunca mezcla la CLAVE con ID y la de siempre.
 */
import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { unwrapRel } from './busqueda-vuelo.util';
import { claveCliente } from './clave-cliente.util';
import { idClienteDisponible } from './id-cliente-disponible.util';

/**
 * Ids por consulta `.in()` (mismo tope de URL que `LOTE_IDS_BD` de calendar;
 * `common/` no importa de `modules/`).
 */
export const LOTE_IDS_CLAVE = 150;

/** Máximo de clientes / vuelos que resuelve una búsqueda por ID. */
const LIMITE_BUSQUEDA = 50;

const logger = new Logger('ClaveCliente');

/**
 * Columnas de la lectura de claves. String plano a propósito: el parser
 * tipado de supabase-js no digiere el embed en un genérico (TS2589).
 */
const COLS_CLAVE: string =
  'id, fecha_vuelo, consecutivo_cliente, cliente:cliente_id(alias)';

interface FilaClave {
  id?: unknown;
  fecha_vuelo?: unknown;
  consecutivo_cliente?: unknown;
  cliente?: { alias?: unknown } | Array<{ alias?: unknown }> | null;
}

const mensajeDe = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * `vuelo_id → ID del cliente` («beh05-011026») de los vuelos dados. Solo
 * entran los vuelos con ID armable (alias válido y número ≥ 1). Sin ids ⇒
 * Map vacío SIN sondear; sin la migración ⇒ Map vacío sin más lecturas; si
 * no, lotes de 150 EN PARALELO. Cualquier fallo ⇒ `warn` y Map VACÍO (nunca
 * parcial).
 */
export async function clavesClienteDeVuelos(
  sb: SupabaseClient,
  vueloIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      vueloIds.filter(
        (id): id is string => typeof id === 'string' && id !== '',
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  try {
    if (!(await idClienteDisponible(sb))) return new Map();
    const lotes: string[][] = [];
    for (let i = 0; i < ids.length; i += LOTE_IDS_CLAVE) {
      lotes.push(ids.slice(i, i + LOTE_IDS_CLAVE));
    }
    const resultados = await Promise.all(
      lotes.map((lote) => sb.from('vuelo').select(COLS_CLAVE).in('id', lote)),
    );
    const out = new Map<string, string>();
    for (const r of resultados) {
      if (r.error) throw new Error(r.error.message);
      for (const f of (r.data ?? []) as unknown as FilaClave[]) {
        if (typeof f.id !== 'string') continue;
        const clave = claveCliente({
          alias: unwrapRel(f.cliente)?.alias,
          consecutivo: f.consecutivo_cliente,
          fecha_vuelo: f.fecha_vuelo,
        });
        if (clave) out.set(f.id, clave);
      }
    }
    return out;
  } catch (e) {
    logger.warn(
      `ID de vuelo por cliente: no se pudo leer (${mensajeDe(e)}); se omite`,
    );
    return new Map();
  }
}

/**
 * Ids de los vuelos cuyo ID es «alias + número» (la fecha escrita ya se
 * ignoró en `parseBusquedaClave`): clientes con ese alias (≤ 50) ⇒ sus
 * vuelos con ese número (≤ 50). Sin la migración ⇒ [] sin consultar.
 * Cualquier fallo ⇒ `warn` y [] (la búsqueda sigue sin él). Nunca lanza.
 */
export async function vueloIdsPorClaveCliente(
  sb: SupabaseClient,
  c: { alias: string; consecutivo: number },
): Promise<string[]> {
  try {
    if (!(await idClienteDisponible(sb))) return [];
    const { data: clientes, error: cliErr } = await sb
      .from('cliente')
      .select('id')
      .eq('alias', c.alias)
      .limit(LIMITE_BUSQUEDA);
    if (cliErr) throw new Error(cliErr.message);
    const clienteIds = ((clientes ?? []) as Array<{ id?: unknown }>)
      .map((x) => x.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
    if (clienteIds.length === 0) return [];
    const { data: vuelos, error: vErr } = await sb
      .from('vuelo')
      .select('id')
      .in('cliente_id', clienteIds)
      .eq('consecutivo_cliente', c.consecutivo)
      .limit(LIMITE_BUSQUEDA);
    if (vErr) throw new Error(vErr.message);
    return ((vuelos ?? []) as Array<{ id?: unknown }>)
      .map((x) => x.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
  } catch (e) {
    logger.warn(
      `ID de vuelo por cliente: no se pudo buscar «${c.alias}${c.consecutivo}» (${mensajeDe(e)}); la búsqueda sigue sin él`,
    );
    return [];
  }
}
