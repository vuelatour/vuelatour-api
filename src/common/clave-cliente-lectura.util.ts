/**
 * LECTOR ÚNICO del ID de vuelo por cliente (13-oct-2026, API 0.0.75,
 * invariante 68): es el ÚNICO lugar que lee `vuelo.consecutivo_cliente` y
 * `cliente.alias` para ARMAR (`clavesClienteDeVuelos`, panel) o BUSCAR
 * (`vueloIdsPorClaveCliente`) IDs, y —desde el 23-oct-2026 (API 0.0.105,
 * invariante 106)— para dar el CONSECUTIVO del vuelo del cliente a los
 * documentos (`consecutivosClienteDeVuelos`: balances, Libro Dinero, libro
 * AFAC, reparto y listas del cierre, que ya no imprimen el ID). El texto del
 * ID lo arma la fuente pura `clave-cliente.util.ts`.
 *
 * Best-effort y NUNCA lanza: una etiqueta jamás tumba una lista, un detalle
 * ni un cierre. Todo va detrás de la sonda `idClienteDisponible` (sin la
 * migración no se lee nada) y dentro de try/catch: un error de PostgREST o
 * una excepción ⇒ `warn` y el resultado vacío. Es TODO O NADA por llamada:
 * una hoja nunca mezcla filas con consecutivo y sin él.
 */
import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { unwrapRel } from './busqueda-vuelo.util';
import { claveCliente, consecutivoClienteValido } from './clave-cliente.util';
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
 * Las filas (`id, fecha_vuelo, consecutivo_cliente, cliente.alias`) de los
 * vuelos dados: sin ids ⇒ [] SIN sondear; sin la migración ⇒ [] sin más
 * lecturas; si no, lotes de 150 EN PARALELO. Un error de PostgREST LANZA
 * (el llamador decide el `warn` y devuelve vacío: todo o nada).
 */
async function filasClaveDeVuelos(
  sb: SupabaseClient,
  vueloIds: ReadonlyArray<string | null | undefined>,
): Promise<FilaClave[]> {
  const ids = [
    ...new Set(
      vueloIds.filter(
        (id): id is string => typeof id === 'string' && id !== '',
      ),
    ),
  ];
  if (ids.length === 0) return [];
  if (!(await idClienteDisponible(sb))) return [];
  const lotes: string[][] = [];
  for (let i = 0; i < ids.length; i += LOTE_IDS_CLAVE) {
    lotes.push(ids.slice(i, i + LOTE_IDS_CLAVE));
  }
  const resultados = await Promise.all(
    lotes.map((lote) => sb.from('vuelo').select(COLS_CLAVE).in('id', lote)),
  );
  const filas: FilaClave[] = [];
  for (const r of resultados) {
    if (r.error) throw new Error(r.error.message);
    filas.push(...((r.data ?? []) as unknown as FilaClave[]));
  }
  return filas;
}

/**
 * `vuelo_id → ID del cliente` («beh05-011026») de los vuelos dados (PANEL:
 * listas de vuelos/cotizaciones y detalle; los documentos ya no lo usan,
 * invariante 106). Solo entran los vuelos con ID armable (alias válido y
 * número ≥ 1). Sin ids ⇒ Map vacío SIN sondear; sin la migración ⇒ Map
 * vacío sin más lecturas; si no, lotes de 150 EN PARALELO. Cualquier fallo
 * ⇒ `warn` y Map VACÍO (nunca parcial).
 */
export async function clavesClienteDeVuelos(
  sb: SupabaseClient,
  vueloIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  try {
    const out = new Map<string, string>();
    for (const f of await filasClaveDeVuelos(sb, vueloIds)) {
      if (typeof f.id !== 'string') continue;
      const clave = claveCliente({
        alias: unwrapRel(f.cliente)?.alias,
        consecutivo: f.consecutivo_cliente,
        fecha_vuelo: f.fecha_vuelo,
      });
      if (clave) out.set(f.id, clave);
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
 * `vuelo_id → consecutivo del vuelo dentro de su cliente` (el «02» de
 * «ana02»; `vuelo.consecutivo_cliente`) de los vuelos dados — la columna
 * CONSECUTIVO de los DOCUMENTOS (23-oct-2026, API 0.0.105, invariante 106).
 * Solo entran los vuelos con número entero ≥ 1 (no exige alias: el
 * consecutivo existe aunque el alias no sea válido). Sin ids ⇒ Map vacío
 * SIN sondear; sin la migración ⇒ Map vacío (los documentos mandan
 * `consecutivo_cliente: null`); lotes de 150 EN PARALELO. Cualquier fallo ⇒
 * `warn` y Map VACÍO (nunca parcial): una hoja nunca mezcla filas con
 * número y sin él.
 */
export async function consecutivosClienteDeVuelos(
  sb: SupabaseClient,
  vueloIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, number>> {
  try {
    const out = new Map<string, number>();
    for (const f of await filasClaveDeVuelos(sb, vueloIds)) {
      if (typeof f.id !== 'string') continue;
      const n = consecutivoClienteValido(f.consecutivo_cliente);
      if (n != null) out.set(f.id, n);
    }
    return out;
  } catch (e) {
    logger.warn(
      `Consecutivo de vuelo por cliente: no se pudo leer (${mensajeDe(e)}); se omite`,
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
