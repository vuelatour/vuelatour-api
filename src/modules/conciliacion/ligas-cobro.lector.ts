/**
 * LECTOR ÚNICO de las ligas banco ↔ cobro (12-oct-2026, API 0.0.71,
 * invariante 56). Hasta el 0.0.70 cada lector consultaba
 * `movimiento_bancario` con `filtroLigaCobros(...)` (el espejo `cobro_id` /
 * `cobro_grupo_id` / `ingreso_id`). Con la puente `movimiento_bancario_cobro`
 * un cobro de un LOTE (abono que paga 2+ cobros) NO está en ningún espejo
 * (`cobro_id` queda NULL con ≥ 2 partes): este lector suma las partes de la
 * puente expandidas como ligas `{id: movimiento_id, cobro_id}`
 * (`ligasDesdePartes`), y así la fuente única `cobro-conciliado.util`
 * (`movimientoDeCobro`, `cobroEstaConciliado`, `conciliacionDeCobro`) las ve
 * sin cambiar una línea.
 *
 * Sin la migración (sonda `cobrosLoteDisponibles`): SOLO el espejo, como el
 * 0.0.70. Las lecturas van en LOTES de ≤ 150 ids (una URL de PostgREST con
 * 200 uuids revienta: 414).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MOV_LIGA_COLS,
  type MovimientoLiga,
} from '../../common/cobro-conciliado.util';
import { cobrosLoteDisponibles } from '../../common/cobros-lote-disponible.util';
import { ligasDesdePartes, unirLigas } from './cobros-lote.util';

/** Tope de ids por consulta `in (...)` (URL de PostgREST). */
export const LOTE_IDS_LIGAS = 150;

export interface EntradaLigasCobros {
  cobroIds?: ReadonlyArray<string>;
  sobreIds?: ReadonlyArray<string>;
  /** Anticipos (`movimiento_bancario.ingreso_id`): solo con la migración de ingresos. */
  anticipoIds?: ReadonlyArray<string>;
  /** Columnas del movimiento (`MOV_LIGA_COLS` o `MOV_LIGA_COLS_CON_INGRESO`). */
  cols?: string;
  /**
   * Fuerza la lectura de la puente (true/false) en vez de sondear; los
   * specs y los callers que ya sondearon lo pasan.
   */
  conPuente?: boolean;
}

function trozos(ids: ReadonlyArray<string> | undefined): string[][] {
  const unicos = [...new Set((ids ?? []).filter(Boolean))];
  const out: string[][] = [];
  for (let i = 0; i < unicos.length; i += LOTE_IDS_LIGAS) {
    out.push(unicos.slice(i, i + LOTE_IDS_LIGAS));
  }
  return out;
}

type Fila = Record<string, unknown>;

async function leer(
  sb: SupabaseClient,
  tabla: string,
  cols: string,
  columna: string,
  ids: ReadonlyArray<string> | undefined,
): Promise<Fila[]> {
  const out: Fila[] = [];
  for (const lote of trozos(ids)) {
    const { data, error } = await sb.from(tabla).select(cols).in(columna, lote);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as unknown as Fila[]));
  }
  return out;
}

/**
 * Ligas de estos cobros / sobres / anticipos: filas de `movimiento_bancario`
 * (espejo) + las partes de la puente expandidas. Cada liga trae al menos
 * `{id, cobro_id, cobro_grupo_id}` (+ `ingreso_id` si `cols` lo pide).
 */
export async function leerLigasDeCobros<
  M extends MovimientoLiga & { ingreso_id?: unknown } = MovimientoLiga,
>(sb: SupabaseClient, e: EntradaLigasCobros): Promise<M[]> {
  const cols = e.cols ?? MOV_LIGA_COLS;
  const [porCobro, porSobre, porAnticipo] = await Promise.all([
    leer(sb, 'movimiento_bancario', cols, 'cobro_id', e.cobroIds),
    leer(sb, 'movimiento_bancario', cols, 'cobro_grupo_id', e.sobreIds),
    leer(sb, 'movimiento_bancario', cols, 'ingreso_id', e.anticipoIds),
  ]);
  const espejo = [...porCobro, ...porSobre, ...porAnticipo] as M[];
  const cobroIds = [...new Set((e.cobroIds ?? []).filter(Boolean))];
  if (cobroIds.length === 0) return unirLigas(espejo);
  const conPuente =
    typeof e.conPuente === 'boolean'
      ? e.conPuente
      : await cobrosLoteDisponibles(sb);
  if (!conPuente) return unirLigas(espejo);
  const partes = await leer(
    sb,
    'movimiento_bancario_cobro',
    `movimiento_id, cobro_id, monto_parte, movimiento:movimiento_bancario!movimiento_id(${cols})`,
    'cobro_id',
    cobroIds,
  );
  const desdePuente = ligasDesdePartes(
    partes.map((p) => ({
      movimiento_id: String(p.movimiento_id),
      cobro_id: String(p.cobro_id),
      monto_parte: Number(p.monto_parte) || 0,
      movimiento: p.movimiento as MovimientoLiga | MovimientoLiga[] | null,
    })),
  ) as M[];
  return unirLigas(espejo, desdePuente);
}

/** Fila de la puente tal como la expone el API (tipos normalizados). */
export interface ParteCobroLeida {
  movimiento_id: string;
  cobro_id: string;
  monto_parte: number;
  created_at: string | null;
  created_by: string | null;
}

/**
 * Partes de la puente de estos movimientos (en lotes; orden por
 * `created_at`, luego `cobro_id`). Quien llama YA sondeó la migración.
 */
export async function partesDeAbonos(
  sb: SupabaseClient,
  movIds: ReadonlyArray<string>,
): Promise<ParteCobroLeida[]> {
  const filas = await leer(
    sb,
    'movimiento_bancario_cobro',
    'movimiento_id, cobro_id, monto_parte, created_at, created_by',
    'movimiento_id',
    movIds,
  );
  return filas
    .map((f) => ({
      movimiento_id: String(f.movimiento_id),
      cobro_id: String(f.cobro_id),
      monto_parte: Number(f.monto_parte) || 0,
      created_at: typeof f.created_at === 'string' ? f.created_at : null,
      created_by: typeof f.created_by === 'string' ? f.created_by : null,
    }))
    .sort((a, b) => {
      const ca = a.created_at ?? '';
      const cb = b.created_at ?? '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.cobro_id < b.cobro_id ? -1 : a.cobro_id > b.cobro_id ? 1 : 0;
    });
}
