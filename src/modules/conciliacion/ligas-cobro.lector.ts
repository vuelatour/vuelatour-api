/**
 * LECTOR ÚNICO de las ligas banco ↔ cobro (12-oct-2026, API 0.0.71,
 * invariante 56; M:N desde el 14-oct-2026, API 0.0.78, invariante 77). Hasta
 * el 0.0.70 cada lector consultaba `movimiento_bancario` con
 * `filtroLigaCobros(...)` (el espejo `cobro_id` / `cobro_grupo_id` /
 * `ingreso_id`). Con la puente `movimiento_bancario_cobro` un cobro de un
 * LOTE (abono que paga 2+ cobros) NO está en ningún espejo (`cobro_id`
 * queda NULL con ≥ 2 partes): este lector suma las partes de la puente
 * expandidas como ligas `{id: movimiento_id, cobro_id, monto_parte}`
 * (`ligasDesdePartes`), y así la fuente única `cobro-conciliado.util`
 * (`movimientoDeCobro`, `cobroEstaConciliado`, `conciliacionDeCobro`) las ve
 * sin cambiar una línea.
 *
 * M:N (invariante 77): un cobro puede tener VARIOS abonos. La puente es la
 * FUENTE: se lee PAGINADA por (cobro_id, movimiento_id) —con varios abonos
 * por cobro, ordenar solo por cobro_id salta o repite filas entre páginas y
 * PostgREST corta en 1,000 SIN avisar— con el abono embebido (fecha, monto,
 * cobros_n, cuenta y su `created_at`) y va PRIMERO en `unirLigas`, así la
 * liga que sobrevive a la deduplicación es la que trae `monto_parte`.
 * `partesDeLigas` convierte lo YA leído en las partes de cada cobro (sin otra
 * consulta) para `common/cobro-banco.util#coberturaCobro`.
 *
 * Sin la migración 20261012000002 (sonda `cobrosLoteDisponibles`): SOLO el
 * espejo, como el 0.0.70, y cada liga directa es una parte del |abono|
 * completo (como el backfill de 0.0.71). Las lecturas van en LOTES de ≤ 150
 * ids (una URL de PostgREST con 200 uuids revienta: 414).
 *
 * REGLA (invariante 77): nadie lee `movimiento_bancario_cobro` ni
 * `v_cobro_conciliacion` por su cuenta (salvo `contextoAbonos`, que lee el
 * UNIVERSO de la puente paginado por la misma llave).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ordenarPartesPorAntiguedad,
  type ParteCobroBanco,
} from '../../common/cobro-banco.util';
import {
  MOV_LIGA_COLS,
  type MovimientoLiga,
} from '../../common/cobro-conciliado.util';
import { cobrosLoteDisponibles } from '../../common/cobros-lote-disponible.util';
import { ligasDesdePartes, unirLigas } from './cobros-lote.util';

/** Tope de ids por consulta `in (...)` (URL de PostgREST). */
export const LOTE_IDS_LIGAS = 150;

/** Filas por página (max-rows de PostgREST: corta en 1,000 sin avisar). */
export const PAGINA_LIGAS = 1000;

/**
 * Columnas del ABONO que la cobertura y su detalle necesitan, además de las
 * de la liga (`MOV_LIGA_COLS`): van en el espejo y en el abono embebido de
 * la puente. JAMÁS `numero_cuenta`, `clabe` ni `storage_path`.
 */
export const MOV_COLS_PARTE_COBRO: readonly string[] = [
  'fecha',
  'monto',
  'cuenta_bancaria_id',
  'created_at',
  'cuenta:cuenta_bancaria!cuenta_bancaria_id(alias, moneda, tipo)',
];

/** `cols` + `extra` sin repetir columnas (las de la liga van primero). */
function columnas(cols: string, extra: ReadonlyArray<string>): string {
  const lista = cols
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  for (const c of extra) if (!lista.includes(c)) lista.push(c);
  return lista.join(', ');
}

/** Select del espejo (`movimiento_bancario` por cobro_id / cobro_grupo_id / ingreso_id). */
export function colsEspejoLigas(cols: string = MOV_LIGA_COLS): string {
  return columnas(cols, MOV_COLS_PARTE_COBRO);
}

/**
 * Select de la puente con su abono embebido (SOLO con la sonda de
 * 20261012000002: nombra la puente y `cobros_n`).
 */
export function colsPuenteLigas(cols: string = MOV_LIGA_COLS): string {
  const abono = columnas(cols, [
    'fecha',
    'monto',
    'cobros_n',
    'cuenta_bancaria_id',
    'created_at',
    'cuenta:cuenta_bancaria!cuenta_bancaria_id(alias, moneda, tipo)',
  ]);
  return `movimiento_id, cobro_id, monto_parte, movimiento:movimiento_bancario!movimiento_id(${abono})`;
}

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

/**
 * Lectura del ESPEJO (`movimiento_bancario` por `cobro_id` / `cobro_grupo_id`
 * / `ingreso_id`) en lotes de ≤ 150 ids, cada lote PAGINADO por la PK
 * (`id`): con varios abonos por cobro (invariante 77) el espejo `cobro_id`
 * de 150 cobros ya no está acotado a 150 filas. Un error se LANZA.
 */
async function leerEspejo(
  sb: SupabaseClient,
  cols: string,
  columna: 'cobro_id' | 'cobro_grupo_id' | 'ingreso_id',
  ids: ReadonlyArray<string> | undefined,
): Promise<Fila[]> {
  const out: Fila[] = [];
  for (const lote of trozos(ids)) {
    for (let desde = 0; ; desde += PAGINA_LIGAS) {
      const { data, error } = await sb
        .from('movimiento_bancario')
        .select(cols)
        .in(columna, lote)
        .order('id', { ascending: true })
        .range(desde, desde + PAGINA_LIGAS - 1);
      if (error) throw new Error(error.message);
      const pagina = (data ?? []) as unknown as Fila[];
      out.push(...pagina);
      if (pagina.length < PAGINA_LIGAS) break;
    }
  }
  return out;
}

/**
 * Lectura de la PUENTE en lotes de ≤ 150 ids, cada lote PAGINADO por la PK
 * (`columna`, luego la otra llave): páginas de 1,000 hasta recibir una
 * incompleta. Un error se LANZA (jamás «sin ligas» por una lectura caída).
 */
async function leerPuentePaginada(
  sb: SupabaseClient,
  cols: string,
  columna: 'cobro_id' | 'movimiento_id',
  ids: ReadonlyArray<string> | undefined,
): Promise<Fila[]> {
  const otra = columna === 'cobro_id' ? 'movimiento_id' : 'cobro_id';
  const out: Fila[] = [];
  for (const lote of trozos(ids)) {
    for (let desde = 0; ; desde += PAGINA_LIGAS) {
      const { data, error } = await sb
        .from('movimiento_bancario_cobro')
        .select(cols)
        .in(columna, lote)
        .order(columna, { ascending: true })
        .order(otra, { ascending: true })
        .range(desde, desde + PAGINA_LIGAS - 1);
      if (error) throw new Error(error.message);
      const pagina = (data ?? []) as unknown as Fila[];
      out.push(...pagina);
      if (pagina.length < PAGINA_LIGAS) break;
    }
  }
  return out;
}

/** Filas de la puente (con el abono embebido) ⇒ ligas directas. */
function ligasDePuente<M extends MovimientoLiga>(partes: Fila[]): M[] {
  return ligasDesdePartes(
    partes.map((p) => ({
      movimiento_id: String(p.movimiento_id),
      cobro_id: String(p.cobro_id),
      monto_parte: Number(p.monto_parte) || 0,
      movimiento: p.movimiento as MovimientoLiga | MovimientoLiga[] | null,
    })),
  ) as M[];
}

/**
 * Ligas de estos cobros / sobres / anticipos: las partes de la PUENTE
 * expandidas (primero: traen `monto_parte`) + las filas de
 * `movimiento_bancario` del espejo. Cada liga trae al menos `{id, cobro_id,
 * cobro_grupo_id}` (+ `ingreso_id` si `cols` lo pide) y las columnas del
 * abono de `MOV_COLS_PARTE_COBRO` (+ `cobros_n` en las de la puente).
 */
export async function leerLigasDeCobros<
  M extends MovimientoLiga & { ingreso_id?: unknown } = MovimientoLiga,
>(sb: SupabaseClient, e: EntradaLigasCobros): Promise<M[]> {
  const cols = e.cols ?? MOV_LIGA_COLS;
  const colsEspejo = colsEspejoLigas(cols);
  const [porCobro, porSobre, porAnticipo] = await Promise.all([
    leerEspejo(sb, colsEspejo, 'cobro_id', e.cobroIds),
    leerEspejo(sb, colsEspejo, 'cobro_grupo_id', e.sobreIds),
    leerEspejo(sb, colsEspejo, 'ingreso_id', e.anticipoIds),
  ]);
  const espejo = [...porCobro, ...porSobre, ...porAnticipo] as M[];
  const cobroIds = [...new Set((e.cobroIds ?? []).filter(Boolean))];
  if (cobroIds.length === 0) return unirLigas(espejo);
  const conPuente =
    typeof e.conPuente === 'boolean'
      ? e.conPuente
      : await cobrosLoteDisponibles(sb);
  if (!conPuente) return unirLigas(espejo);
  const partes = await leerPuentePaginada(
    sb,
    colsPuenteLigas(cols),
    'cobro_id',
    cobroIds,
  );
  // La PUENTE primero: la deduplicación conserva la liga con `monto_parte`.
  return unirLigas(ligasDePuente<M>(partes), espejo);
}

function unwrapUno<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Número finito o null (jamás 0 en falso). */
function numero(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Las ligas DIRECTAS ya leídas (puente o espejo) ⇒ las partes de cada cobro
 * para `coberturaCobro`, por antigüedad, sin otra consulta. Una liga de la
 * puente trae su `monto_parte`; una del espejo (sin 20261012000002) vale el
 * |abono| completo (como el backfill de 0.0.71) y `cobros_n` 1. Las ligas
 * de un sobre o de un anticipo no son partes. Sin repetir (abono, cobro).
 */
export function partesDeLigas(
  ligas: ReadonlyArray<
    MovimientoLiga & {
      fecha?: unknown;
      monto?: unknown;
      cobros_n?: unknown;
      cuenta_bancaria_id?: unknown;
      created_at?: unknown;
      cuenta?: unknown;
    }
  >,
): Map<string, ParteCobroBanco[]> {
  const out = new Map<string, ParteCobroBanco[]>();
  const vistas = new Set<string>();
  for (const l of ligas) {
    const cobroId = texto(l.cobro_id);
    const movId = texto(l.id);
    if (!cobroId || !movId) continue;
    const k = `${movId}|${cobroId}`;
    if (vistas.has(k)) continue;
    vistas.add(k);
    const cuenta = unwrapUno(
      l.cuenta as
        | { alias?: unknown; moneda?: unknown; tipo?: unknown }
        | Array<{ alias?: unknown; moneda?: unknown; tipo?: unknown }>
        | null
        | undefined,
    );
    const montoAbono = numero(l.monto);
    const absAbono =
      montoAbono == null ? null : Math.round(Math.abs(montoAbono) * 100) / 100;
    const deLaPuente = typeof l.monto_parte === 'number';
    const parte: ParteCobroBanco = {
      movimiento_id: movId,
      cobro_id: cobroId,
      monto_parte: deLaPuente ? (l.monto_parte as number) : (absAbono ?? 0),
      moneda_cuenta: texto(cuenta?.moneda),
      pasarela: cuenta?.tipo === 'PASARELA',
      fecha: texto(l.fecha),
      created_at: texto(l.created_at),
      monto_abono: absAbono,
      cobros_n: deLaPuente ? numero(l.cobros_n) : (numero(l.cobros_n) ?? 1),
      cuenta_bancaria_id: texto(l.cuenta_bancaria_id),
      cuenta_alias: texto(cuenta?.alias),
    };
    const lista = out.get(cobroId) ?? [];
    lista.push(parte);
    out.set(cobroId, lista);
  }
  for (const [cobroId, lista] of out) {
    out.set(cobroId, ordenarPartesPorAntiguedad(lista));
  }
  return out;
}

/**
 * Filas CRUDAS de la puente leídas con `colsPuenteLigas(...)` ⇒ las partes de
 * cada cobro (la MISMA conversión que `leerPartesDeCobros`). Para quien lee
 * el UNIVERSO de la puente paginado por su cuenta (`contextoAbonos`, la
 * única excepción de la regla del lector).
 */
export function partesDeFilasPuente(
  filas: ReadonlyArray<Record<string, unknown>>,
): Map<string, ParteCobroBanco[]> {
  return partesDeLigas(ligasDePuente([...filas]));
}

/**
 * Partes de la PUENTE de estos cobros (TODAS sus ligas, de cualquier abono),
 * con el mismo select y la misma paginación que `leerLigasDeCobros`. Quien
 * llama YA sondeó `cobrosLoteDisponibles` (nombra la puente). Cobros sin
 * partes no aparecen en el mapa.
 */
export async function leerPartesDeCobros(
  sb: SupabaseClient,
  cobroIds: ReadonlyArray<string>,
): Promise<Map<string, ParteCobroBanco[]>> {
  const filas = await leerPuentePaginada(
    sb,
    colsPuenteLigas(MOV_LIGA_COLS),
    'cobro_id',
    cobroIds,
  );
  return partesDeLigas(ligasDePuente(filas));
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
 * Partes de la puente de estos movimientos (en lotes PAGINADOS por la PK;
 * orden de salida por `created_at`, luego `cobro_id`). Quien llama YA
 * sondeó la migración.
 */
export async function partesDeAbonos(
  sb: SupabaseClient,
  movIds: ReadonlyArray<string>,
): Promise<ParteCobroLeida[]> {
  const filas = await leerPuentePaginada(
    sb,
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
