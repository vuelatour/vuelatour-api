/**
 * PostgREST FALSO para los specs del tacómetro omitido (15-oct-2026,
 * invariante 79). Emula lo que importa de la BD real:
 * - SIN la migración, cualquier select/update que NOMBRE `taco_omitido_*`
 *   responde 42703/PGRST204 (así se prueba la REGLA DURA de la sonda);
 * - CON ella, el CHECK `escala_taco_omitido_chk` (23514 si un update deja
 *   llegada + omisión, o at ⇎ motivo).
 * Embebe `vuelo` en las lecturas de `escala` (`vuelo:vuelo_id(…)` o
 * `vuelo!inner(…)`, para filtros como `vuelo.estado`) y `escalas` en las de
 * `vuelo` (`escalas:escala(…)`). Registra cada operación en `ops`.
 */
import type { SupabaseService } from '../supabase/supabase.service';

export type Row = Record<string, unknown>;
export type Tablas = Record<string, Row[]>;
export type Filtro = [string, string, unknown];
export interface Op {
  tabla: string;
  tipo: 'select' | 'update' | 'insert' | 'upsert';
  cols: string;
  patch?: Row;
  filtros: Filtro[];
}

const valor = (r: Row, col: string): unknown =>
  col
    .split('.')
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Row)[k]), r);

/** Texto comparable de un escalar (fechas ISO, números). */
const texto = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? String(v)
    : '';

export function violaCheck(r: Row): boolean {
  const at = r.taco_omitido_at ?? null;
  const motivo = r.taco_omitido_motivo ?? null;
  if (at == null && motivo == null) return false;
  if (at == null || motivo == null) return true;
  const n = typeof motivo === 'string' ? motivo.trim().length : 0;
  return n < 10 || n > 500 || r.taco_llegada != null;
}

export function fakeSupabase(
  db: Tablas,
  opts: { migracion: boolean; antes?: (op: Op) => void },
) {
  const ops: Op[] = [];
  const embed = (tabla: string, r: Row, cols: string): Row => {
    const out = { ...r };
    if (tabla === 'escala' && /vuelo(:vuelo_id)?(!inner)?\(/.test(cols)) {
      out.vuelo = (db.vuelo ?? []).find((v) => v.id === r.vuelo_id) ?? null;
    }
    if (tabla === 'vuelo' && cols.includes('escalas:escala(')) {
      out.escalas = (db.escala ?? [])
        .filter((e) => e.vuelo_id === r.id)
        .map((e) => ({ ...e }));
    }
    return out;
  };
  const service = {
    storage: {
      from: () => ({
        createSignedUrl: () =>
          Promise.resolve({ data: { signedUrl: 'https://firmada/foto' } }),
        createSignedUrls: () => Promise.resolve({ data: [] }),
      }),
    },
    from(tabla: string) {
      const op: Op = { tabla, tipo: 'select', cols: '', filtros: [] };
      let orden: { col: string; asc: boolean } | null = null;
      let conteo = false;
      const pasa = (r: Row) =>
        op.filtros.every(([t, col, v]) => {
          const x = valor(r, col);
          switch (t) {
            case 'eq':
              return x === v;
            case 'neq':
              return x !== v;
            case 'is':
              return x == null;
            case 'not':
              return x != null;
            case 'in':
              return (v as unknown[]).includes(x);
            case 'lt':
              return x != null && texto(x) < texto(v);
            case 'gt':
              return x != null && Number(x) > Number(v);
            case 'lte':
              return x != null && texto(x) <= texto(v);
            case 'gte':
              return x != null && texto(x) >= texto(v);
            default:
              return true;
          }
        });
      const correr = (unico: boolean) => {
        ops.push(op);
        opts.antes?.(op);
        const nombra =
          op.cols.includes('taco_omitido') ||
          Object.keys(op.patch ?? {}).some((k) => k.startsWith('taco_omitido'));
        if (!opts.migracion && nombra) {
          return {
            data: null,
            error:
              op.tipo === 'select'
                ? {
                    code: '42703',
                    message: 'column escala.taco_omitido_at does not exist',
                  }
                : {
                    code: 'PGRST204',
                    message:
                      "Could not find the 'taco_omitido_at' column of 'escala' in the schema cache",
                  },
          };
        }
        const filas = (db[tabla] ??= []);
        if (op.tipo === 'insert' || op.tipo === 'upsert') {
          filas.push({ ...(op.patch ?? {}) });
          return { data: null, error: null };
        }
        const match = filas.filter((r) => pasa(embed(tabla, r, op.cols)));
        if (op.tipo === 'update') {
          if (tabla === 'escala' && opts.migracion) {
            for (const r of match) {
              if (violaCheck({ ...r, ...op.patch })) {
                return {
                  data: null,
                  error: {
                    code: '23514',
                    message:
                      'new row for relation "escala" violates check constraint "escala_taco_omitido_chk"',
                  },
                };
              }
            }
          }
          for (const r of match) Object.assign(r, op.patch);
        }
        let out = match.map((r) => embed(tabla, r, op.cols));
        if (orden) {
          const { col, asc } = orden;
          out = [...out].sort(
            (a, b) =>
              (Number(a[col]) - Number(b[col]) ||
                String(a[col]).localeCompare(String(b[col]))) * (asc ? 1 : -1),
          );
        }
        if (conteo) return { data: null, count: out.length, error: null };
        return { data: unico ? (out[0] ?? null) : out, error: null };
      };
      const api: Record<string, unknown> = {
        select(cols?: string, o?: { count?: string; head?: boolean }) {
          op.cols = `${op.cols} ${cols ?? '*'}`;
          if (o?.count) conteo = true;
          return api;
        },
        update(patch: Row) {
          op.tipo = 'update';
          op.patch = patch;
          return api;
        },
        insert(patch: Row) {
          op.tipo = 'insert';
          op.patch = patch;
          return api;
        },
        upsert(patch: Row) {
          op.tipo = 'upsert';
          op.patch = patch;
          return api;
        },
        order(col: string, o?: { ascending?: boolean }) {
          orden = { col, asc: o?.ascending !== false };
          return api;
        },
        limit: () => api,
        range: () => api,
        or: () => api,
        maybeSingle: () => Promise.resolve(correr(true)),
        single: () => Promise.resolve(correr(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(correr(false)).then(res, rej),
      };
      for (const t of ['eq', 'neq', 'is', 'in', 'lt', 'gt', 'lte', 'gte']) {
        api[t] = (col: string, v: unknown) => {
          op.filtros.push([t, col, v]);
          return api;
        };
      }
      api.not = (col: string) => {
        op.filtros.push(['not', col, null]);
        return api;
      };
      return api;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, ops };
}
