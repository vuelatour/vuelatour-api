/**
 * MINI-POSTGREST EN MEMORIA para los specs del CIERRE DE MES (16-oct-2026,
 * API 0.0.88, invariante 89). Lee Y ESCRIBE (insert / update con filtros y
 * `.select()` de lo escrito), simula la columna GENERADA
 * `vuelo.fecha_contable = coalesce(periodo_contable, fecha_vuelo)` y, con
 * `sinMigracion`, responde 42703 a todo select que nombre
 * `periodo_contable` / `fecha_contable` y 42P01 a las tablas del cierre (la
 * sonda `cierreMesDisponible` ⇒ false).
 *
 * `*-spec.ts` (sin punto) ⇒ fuera del build y fuera de jest.
 */
export type Fila = Record<string, unknown>;

function valorEn(f: Fila, col: string): unknown {
  return col.split('.').reduce<unknown>((acc, k) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    const v = (acc as Record<string, unknown>)[k];
    return Array.isArray(v) ? (v[0] as unknown) : v;
  }, f);
}

function cmp(a: unknown, b: unknown): number {
  const iso = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
  if (iso(a) || iso(b)) {
    const na = Date.parse(String(a));
    const nb = Date.parse(String(b));
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const txt = (v: unknown) =>
    v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  const sa = txt(a);
  const sb = txt(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function partirOr(cond: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of cond) {
    if (ch === '(') nivel += 1;
    if (ch === ')') nivel -= 1;
    if (ch === ',' && nivel === 0) {
      out.push(actual);
      actual = '';
      continue;
    }
    actual += ch;
  }
  if (actual) out.push(actual);
  return out;
}

const igual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const iso = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
  if (iso(a) && iso(b)) {
    return Date.parse(a as string) === Date.parse(b as string);
  }
  const txt = (v: unknown) =>
    typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
  return txt(a) === txt(b);
};

export interface Escritura {
  tabla: string;
  op: 'insert' | 'update';
  valores: Fila;
}

export interface FakeOpts {
  sinMigracion?: boolean;
  /** Error a devolver en una escritura (o null). */
  fallarEscritura?: (e: Escritura) => { code?: string; message: string } | null;
}

const TABLAS_CIERRE = new Set(['cierre_mes', 'cierre_mes_vuelo']);

let secuencia = 0;

export function fakeCierre(
  tablas: Record<string, Fila[]>,
  opts: FakeOpts = {},
) {
  const escrituras: Escritura[] = [];
  const consultas: Array<{ tabla: string; select: string | null }> = [];

  const recalcular = (tabla: string, f: Fila) => {
    if (tabla === 'vuelo' && !opts.sinMigracion) {
      f.fecha_contable = f.periodo_contable ?? f.fecha_vuelo ?? null;
    }
  };
  for (const f of tablas.vuelo ?? []) recalcular('vuelo', f);

  const from = (tabla: string) => {
    let filas = [...(tablas[tabla] ?? [])];
    let error: { code: string; message: string } | null = null;
    let modo: 'select' | 'insert' | 'update' = 'select';
    let patch: Fila | null = null;
    const insertadas: Fila[] = [];
    const filtros: Array<(f: Fila) => boolean> = [];
    const cumple = (f: Fila, cond: string): boolean => {
      const m = /^([^.]+(?:\.[^.]+)?)\.([a-z]+)\.(.*)$/.exec(cond);
      if (!m) return false;
      const [, col, op, raw] = m;
      const v = valorEn(f, col);
      if (op === 'is') return (v ?? null) === (raw === 'null' ? null : raw);
      if (op === 'eq') return String(v) === raw;
      if (op === 'neq') return String(v) !== raw;
      if (op === 'gte') return cmp(v, raw) >= 0;
      if (op === 'in')
        return raw
          .replace(/^\(|\)$/g, '')
          .split(',')
          .includes(String(v));
      return false;
    };
    const filtrar = (fn: (f: Fila) => boolean) => {
      filtros.push(fn);
      filas = filas.filter(fn);
      return q;
    };
    const ejecutar = (): { data: unknown; error: unknown } => {
      if (error) return { data: null, error };
      if (modo === 'insert') return { data: insertadas, error: null };
      if (modo === 'update') {
        const base = tablas[tabla] ?? [];
        const tocadas = base.filter((f) => filtros.every((fn) => fn(f)));
        for (const f of tocadas) {
          const e: Escritura = {
            tabla,
            op: 'update',
            valores: { ...patch, id: f.id },
          };
          const fallo = opts.fallarEscritura?.(e) ?? null;
          if (fallo) return { data: null, error: fallo };
          escrituras.push(e);
          Object.assign(f, patch);
          recalcular(tabla, f);
        }
        return { data: tocadas.map((f) => ({ ...f })), error: null };
      }
      // Copias (como PostgREST): una escritura posterior no muta lo leído.
      return { data: filas.map((f) => ({ ...f })), error: null };
    };
    const q: Record<string, unknown> = {
      select: (cols?: string) => {
        if (modo === 'select') consultas.push({ tabla, select: cols ?? null });
        if (opts.sinMigracion) {
          if (TABLAS_CIERRE.has(tabla)) {
            error = {
              code: '42P01',
              message: `relation ${tabla} does not exist`,
            };
          } else if (
            typeof cols === 'string' &&
            /\b(periodo_contable|fecha_contable)\b/.test(cols)
          ) {
            error = {
              code: '42703',
              message: 'column vuelo.periodo_contable does not exist',
            };
          }
        }
        return q;
      },
      insert: (v: Fila | Fila[]) => {
        modo = 'insert';
        const lista = Array.isArray(v) ? v : [v];
        if (opts.sinMigracion && TABLAS_CIERRE.has(tabla)) {
          error = {
            code: '42P01',
            message: `relation ${tabla} does not exist`,
          };
          return q;
        }
        for (const raw of lista) {
          const fila: Fila = {
            id: raw.id ?? `${tabla}-${++secuencia}`,
            ...raw,
          };
          const e: Escritura = { tabla, op: 'insert', valores: fila };
          const fallo = opts.fallarEscritura?.(e) ?? null;
          if (fallo) {
            error = { code: fallo.code ?? 'XX000', message: fallo.message };
            return q;
          }
          // UNIQUE de las tablas del cierre.
          if (tabla === 'cierre_mes') {
            if (
              (tablas.cierre_mes ?? []).some((x) => x.periodo === fila.periodo)
            ) {
              error = {
                code: '23505',
                message: 'duplicate key cierre_mes_pkey',
              };
              return q;
            }
          }
          if (tabla === 'cierre_mes_vuelo') {
            const dup = (tablas.cierre_mes_vuelo ?? []).some(
              (x) =>
                x.periodo === fila.periodo &&
                x.cierre_version === fila.cierre_version &&
                x.vuelo_id === fila.vuelo_id,
            );
            if (dup) {
              error = {
                code: '23505',
                message: 'duplicate key cierre_mes_vuelo_unico',
              };
              return q;
            }
            fila.revertido_at = fila.revertido_at ?? null;
          }
          escrituras.push(e);
          (tablas[tabla] ??= []).push(fila);
          recalcular(tabla, fila);
          insertadas.push({ ...fila });
        }
        return q;
      },
      update: (v: Fila) => {
        modo = 'update';
        patch = v;
        filas = [...(tablas[tabla] ?? [])];
        return q;
      },
      eq: (c: string, v: unknown) => filtrar((f) => igual(valorEn(f, c), v)),
      neq: (c: string, v: unknown) => filtrar((f) => !igual(valorEn(f, c), v)),
      is: (c: string, v: unknown) =>
        filtrar((f) => (valorEn(f, c) ?? null) === v),
      in: (c: string, arr: unknown[]) =>
        filtrar((f) => arr.some((a) => igual(valorEn(f, c), a))),
      or: (cond: string) =>
        filtrar((f) => partirOr(cond).some((c) => cumple(f, c))),
      ilike: (c: string, patron: string) => {
        const re = new RegExp(
          `^${patron
            .split('%')
            .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*')}$`,
          'i',
        );
        return filtrar((f) => {
          const v = valorEn(f, c);
          return typeof v === 'string' && re.test(v);
        });
      },
      gte: (c: string, v: unknown) =>
        filtrar((f) => cmp(valorEn(f, c), v) >= 0),
      lte: (c: string, v: unknown) =>
        filtrar((f) => cmp(valorEn(f, c), v) <= 0),
      gt: (c: string, v: unknown) => filtrar((f) => cmp(valorEn(f, c), v) > 0),
      lt: (c: string, v: unknown) => filtrar((f) => cmp(valorEn(f, c), v) < 0),
      not: (c: string, op: string, v: unknown) =>
        op === 'is' && v === null
          ? filtrar((f) => (valorEn(f, c) ?? null) !== null)
          : q,
      order: (c: string, o?: { ascending?: boolean }) => {
        const dir = o?.ascending === false ? -1 : 1;
        filas.sort((a, b) => dir * cmp(valorEn(a, c), valorEn(b, c)));
        return q;
      },
      limit: (n: number) => {
        filas = filas.slice(0, n);
        return q;
      },
      range: (a: number, b: number) => {
        filas = filas.slice(a, b + 1);
        return q;
      },
      maybeSingle: () => {
        const r = ejecutar();
        if (r.error) return Promise.resolve(r);
        const data = r.data as Fila[];
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      single: () => {
        const r = ejecutar();
        if (r.error) return Promise.resolve(r);
        const data = r.data as Fila[];
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(ejecutar()).then(res, rej),
    };
    return q;
  };
  const service = { from };
  return { supabase: { service }, service, tablas, escrituras, consultas };
}
