/**
 * LECTOR del costo real AFAC por vuelo (16-oct-2026, API 0.0.89, invariante
 * 90). Todo detrás de la sonda `afacRealDisponible`: sin la migración
 * `20261016000005` devuelve mapas vacíos SIN consultar (conducta 0.0.88).
 *
 * Un fallo de lectura LANZA (es dinero del libro: el general no se pinta con
 * un egreso de VuelaTour omitido en silencio). Los NOMBRES de quien capturó
 * son cortesía: `fetchNombresUsuarios` jamás lanza.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { afacRealDisponible } from './afac-real-disponible.util';
import { mesContableDeVuelo } from './fecha-contable.util';
import { fetchNombresUsuarios } from './registrado-por.util';
import {
  colPeriodoContable,
  colsVueloContable,
  rangoPeriodoTs,
} from './filtro-periodo-contable.util';

/** Tamaño de lote de las lecturas `in (…)`. */
export const LOTE_AFAC_REAL = 200;

/** Columnas de `afac_vuelo` que lee el libro. */
export const AFAC_VUELO_COLS =
  'vuelo_id, costo_real_mxn, notas, capturado_por, capturado_at, updated_at, updated_by';

/** Un costo real capturado (solo filas con `costo_real_mxn` no null). */
export interface AfacRealLeido {
  vuelo_id: string;
  costo_real_mxn: number;
  notas: string | null;
  capturado_por: string | null;
  capturado_por_nombre: string | null;
  capturado_at: string | null;
  updated_at: string | null;
}

/** Real de la red de seguridad: con el folio del vuelo para el aviso. */
export interface AfacRealDelPeriodo extends AfacRealLeido {
  folio: number | null;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

function numero(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** `in (…)` en lotes de ≤ 200 ids sin repetidos; un error LANZA. */
async function porLotes(
  ids: ReadonlyArray<string>,
  consulta: (lote: string[]) => PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>,
  etiqueta: string,
): Promise<Array<Record<string, unknown>>> {
  const unicos = [
    ...new Set(ids.filter((x) => typeof x === 'string' && x !== '')),
  ];
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < unicos.length; i += LOTE_AFAC_REAL) {
    const { data, error } = await consulta(unicos.slice(i, i + LOTE_AFAC_REAL));
    if (error) throw new Error(`${etiqueta}: ${error.message}`);
    out.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  return out;
}

/** Filas crudas ⇒ reales (solo con costo) con el nombre de quien capturó. */
async function aReales(
  sb: SupabaseClient,
  filas: ReadonlyArray<Record<string, unknown>>,
): Promise<AfacRealLeido[]> {
  const conCosto = filas.filter(
    (f) => str(f.vuelo_id) && numero(f.costo_real_mxn) != null,
  );
  const nombres = await fetchNombresUsuarios(
    sb,
    conCosto.map((f) => str(f.capturado_por)),
  );
  return conCosto.map((f) => {
    const por = str(f.capturado_por);
    return {
      vuelo_id: f.vuelo_id as string,
      costo_real_mxn: numero(f.costo_real_mxn) as number,
      notas: str(f.notas),
      capturado_por: por,
      capturado_por_nombre: por ? (nombres.get(por) ?? null) : null,
      capturado_at: str(f.capturado_at),
      updated_at: str(f.updated_at),
    };
  });
}

/**
 * Costos reales CAPTURADOS de esos vuelos (`vuelo_id ⇒ real`). Sin la
 * migración o sin ids ⇒ mapa vacío sin consultar.
 */
export async function leerAfacDeVuelos(
  sb: SupabaseClient,
  vueloIds: ReadonlyArray<string>,
): Promise<Map<string, AfacRealLeido>> {
  const out = new Map<string, AfacRealLeido>();
  if (vueloIds.length === 0) return out;
  if (!(await afacRealDisponible(sb))) return out;
  const filas = await porLotes(
    vueloIds,
    (lote) =>
      sb
        .from('afac_vuelo')
        .select(AFAC_VUELO_COLS)
        .in('vuelo_id', lote)
        .not('costo_real_mxn', 'is', null),
    'Costo real AFAC de los vuelos',
  );
  for (const r of await aReales(sb, filas)) out.set(r.vuelo_id, r);
  return out;
}

/**
 * Mes CONTABLE ('YYYY-MM') de esos vuelos (fuente única
 * `mesContableDeVuelo`, invariante 89). Solo se llama cuando hay meses
 * cerrados (decide si la celda es editable). `contable` = sonda del cierre.
 */
export async function leerMesContableDeVuelos(
  sb: SupabaseClient,
  vueloIds: ReadonlyArray<string>,
  contable: boolean,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (vueloIds.length === 0) return out;
  const filas = await porLotes(
    vueloIds,
    (lote) =>
      sb
        .from('vuelo')
        .select(`id, fecha_vuelo${colsVueloContable(contable)}`)
        .in('id', lote),
    'Mes contable de los vuelos con AFAC',
  );
  for (const v of filas) {
    const id = str(v.id);
    if (id) out.set(id, mesContableDeVuelo(v));
  }
  return out;
}

/**
 * RED DE SEGURIDAD: TODOS los costos reales capturados de vuelos cuyo eje
 * contable (`fecha_contable`; sin la migración del cierre, `fecha_vuelo`)
 * cae en el periodo, con su folio. El general compara contra las filas que
 * sí pintó: lo que sobre es un real que ningún libro muestra (aviso 4).
 * Sin la migración ⇒ [] sin consultar.
 */
export async function leerAfacRealesDelPeriodo(
  sb: SupabaseClient,
  desde: string,
  hasta: string,
  contable: boolean,
): Promise<AfacRealDelPeriodo[]> {
  if (!(await afacRealDisponible(sb))) return [];
  const { desdeTs, hastaTs } = rangoPeriodoTs(desde, hasta);
  const colVuelo = colPeriodoContable(contable);
  const { data, error } = await sb
    .from('afac_vuelo')
    .select(
      `${AFAC_VUELO_COLS}, vuelo:vuelo_id!inner(folio, fecha_vuelo${
        contable ? ', fecha_contable' : ''
      })`,
    )
    .not('costo_real_mxn', 'is', null)
    .gte(`vuelo.${colVuelo}`, desdeTs)
    .lte(`vuelo.${colVuelo}`, hastaTs);
  if (error) {
    throw new Error(`Costos reales AFAC del periodo: ${error.message}`);
  }
  const filas = (data ?? []) as Array<Record<string, unknown>>;
  const folioDe = new Map<string, number | null>();
  for (const f of filas) {
    const raw: unknown = f.vuelo;
    const v = (Array.isArray(raw) ? (raw as unknown[])[0] : raw) as {
      folio?: unknown;
    } | null;
    if (typeof f.vuelo_id === 'string') {
      folioDe.set(f.vuelo_id, numero(v?.folio));
    }
  }
  return (await aReales(sb, filas)).map((r) => ({
    ...r,
    folio: folioDe.get(r.vuelo_id) ?? null,
  }));
}
