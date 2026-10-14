/**
 * PostgREST FALSO para los specs del concepto del SPEI y del cruce USD
 * (13-oct-2026, lote 2, API 0.0.75). Fuera del build (`*spec.ts`) y de jest
 * (no termina en `.spec.ts`): patrón `*.fixture-spec.ts` del repo.
 *
 * A diferencia de los fakes de otros specs, ESTE respeta lo que el código
 * nuevo necesita probar:
 * - `range(d, h)` y el tope de filas por respuesta (max-rows = 1000 de
 *   PostgREST, que corta SIN avisar): la lectura paginada se prueba de
 *   verdad;
 * - `order(col)` en el orden en que se encadena;
 * - el CAS por `eq` en un `update` (solo cambia la fila si el filtro aún
 *   empata) y `update(...).select()` devuelve las filas tocadas;
 * - columnas AUSENTES (sondas y selects que las nombran ⇒ 42703);
 * - `ilike` con comodines, `or(...)` con `ilike` / `eq` / `in.(…)`;
 * - embeds simples: cuenta, proveedor, vuelo, factura recibida y gasto;
 * - un registro de CADA operación (tabla, tipo, filtros, cuerpo) y de las
 *   subidas a Storage, para afirmar «no escribe nada».
 * Las RPC de la puente cargo ↔ gastos se emulan con
 * `conciliacion-partes.fixture-spec`.
 */
import type { SupabaseService } from '../supabase/supabase.service';
import {
  rpcPartes,
  type Row,
  type Tablas,
} from './conciliacion-partes.fixture-spec';

export type { Row, Tablas };

export interface ErrorFake {
  message: string;
  code?: string;
}

export interface OperacionFake {
  tabla: string;
  op: 'select' | 'insert' | 'update' | 'upsert';
  sel: string;
  cuerpo?: Row | Row[];
  filtros: Array<[string, string, unknown]>;
  rango: [number, number] | null;
  orden: Array<[string, boolean]>;
  limite: number | null;
}

export interface OpcionesFake {
  /** tabla → columnas que NO existen (la sonda y cualquier select que las nombre ⇒ 42703). */
  ausentes?: Record<string, string[]>;
  /** `tabla:op` ⇒ error forzado. */
  fallos?: Record<string, ErrorFake>;
  /** Antes de ejecutar CADA operación: puede mutar `db` o devolver un error. */
  antes?: (op: OperacionFake, db: Tablas) => ErrorFake | void;
  /** Filas por respuesta (max-rows de PostgREST). */
  maxRows?: number;
}

const num = (v: unknown) => Number(v);

/** Texto de una celda para comparar (sin «[object Object]»). */
function txt(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return v == null ? '' : JSON.stringify(v);
}

function nombra(sel: string, col: string): boolean {
  return new RegExp(`(^|[\\s,(:])${col}([\\s,)]|$)`).test(sel);
}

function patronIlike(p: string): RegExp {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc.replace(/[%*]/g, '.*').replace(/_/g, '.')}$`, 'i');
}

/** Parte `a,b.in.(x,y),c` por las comas que NO están entre paréntesis. */
function partirOr(expr: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of expr) {
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

function predicadoOr(expr: string): (r: Row) => boolean {
  const conds = partirOr(expr).map((c) => {
    const m = /^([a-z_]+)\.(ilike|eq|in)\.(.*)$/.exec(c.trim());
    if (!m) return () => false;
    const [, col, op, val] = m;
    if (op === 'ilike') {
      const re = patronIlike(val);
      return (r: Row) => re.test(txt(r[col]));
    }
    if (op === 'in') {
      const vals = val.replace(/^\(|\)$/g, '').split(',');
      return (r: Row) => vals.includes(txt(r[col]));
    }
    return (r: Row) => txt(r[col]) === val;
  });
  return (r) => conds.some((f) => f(r));
}

const unico = <T>(lista: T[] | undefined, pred: (x: T) => boolean) =>
  (lista ?? []).find(pred) ?? null;

/** Embeds que usa conciliación (forma objeto, como PostgREST con FK única). */
function embeber(db: Tablas, sel: string, r: Row): Row {
  const out: Row = { ...r };
  if (sel.includes('cuenta:cuenta_bancaria')) {
    out.cuenta = unico(
      db.cuenta_bancaria,
      (c) => c.id === r.cuenta_bancaria_id,
    );
  }
  if (sel.includes('proveedor:proveedor')) {
    out.proveedor = unico(db.proveedor, (p) => p.id === r.proveedor_id);
  }
  if (sel.includes('vuelo:vuelo!vuelo_id')) {
    out.vuelo = unico(db.vuelo, (v) => v.id === r.vuelo_id);
  }
  if (sel.includes('factura:factura_recibida')) {
    out.factura = unico(
      db.factura_recibida,
      (f) => f.id === r.factura_recibida_id,
    );
  }
  if (sel.includes('ia_folio:valor_ia_extraido')) {
    const ia = r.valor_ia_extraido as { folio?: unknown } | null | undefined;
    out.ia_folio = ia?.folio ?? r.ia_folio ?? null;
  }
  if (sel.includes('gasto:gasto!gasto_id')) {
    const g = unico(db.gasto, (x) => x.id === r.gasto_id);
    out.gasto = g
      ? {
          ...embeber(
            db,
            'proveedor:proveedor vuelo:vuelo!vuelo_id factura:factura_recibida ia_folio:valor_ia_extraido',
            g,
          ),
          ...(sel.includes('notas_fc:notas')
            ? { notas_fc: g.notas ?? null }
            : {}),
        }
      : null;
  }
  return out;
}

export function fakePostgrest(db: Tablas, opts: OpcionesFake = {}) {
  const log: OperacionFake[] = [];
  const storage: Array<{ bucket: string; path: string }> = [];
  const maxRows = opts.maxRows ?? 1000;
  let seq = 0;
  const service = {
    from(tabla: string) {
      const op: OperacionFake = {
        tabla,
        op: 'select',
        sel: '',
        filtros: [],
        rango: null,
        orden: [],
        limite: null,
      };
      const preds: Array<(r: Row) => boolean> = [];
      let devolverFilas = false;
      let contar = false;
      const filtro = (
        nombre: string,
        col: string,
        val: unknown,
        f: (r: Row) => boolean,
      ) => {
        op.filtros.push([nombre, col, val]);
        preds.push(f);
        return api;
      };
      const ejecutar = (uno: boolean) => {
        log.push(op);
        const forzado =
          opts.fallos?.[`${tabla}:${op.op}`] ?? opts.antes?.(op, db) ?? null;
        if (forzado) return { data: null, error: forzado, count: null };
        const ausentes = opts.ausentes?.[tabla] ?? [];
        const sinColumna = ausentes.find((c) => nombra(op.sel, c));
        if (sinColumna && (op.op === 'select' || devolverFilas)) {
          return {
            data: null,
            error: {
              code: '42703',
              message: `column ${tabla}.${sinColumna} does not exist`,
            },
            count: null,
          };
        }
        const cuerpos = op.cuerpo
          ? Array.isArray(op.cuerpo)
            ? op.cuerpo
            : [op.cuerpo]
          : [];
        const enCuerpo = ausentes.find((c) => cuerpos.some((r) => c in r));
        if (enCuerpo) {
          return {
            data: null,
            error: {
              code: 'PGRST204',
              message: `Could not find the '${enCuerpo}' column of '${tabla}' in the schema cache`,
            },
            count: null,
          };
        }
        if (op.op === 'insert' || op.op === 'upsert') {
          const filas = (
            Array.isArray(op.cuerpo) ? op.cuerpo : [op.cuerpo ?? {}]
          ).map((r) => ({ id: r.id ?? `${tabla}-${++seq}`, ...r }));
          db[tabla] = [...(db[tabla] ?? []), ...filas];
          const copia = filas.map((r) => ({ ...r }));
          return {
            data: devolverFilas ? (uno ? (copia[0] ?? null) : copia) : null,
            error: null,
            count: copia.length,
          };
        }
        const filas = (db[tabla] ?? []).filter((r) => preds.every((f) => f(r)));
        if (op.op === 'update') {
          for (const r of filas) Object.assign(r, op.cuerpo);
          const copia = filas.map((r) => ({ ...r }));
          return {
            data: devolverFilas ? (uno ? (copia[0] ?? null) : copia) : null,
            error: null,
            count: copia.length,
          };
        }
        let out = filas.map((r) => embeber(db, op.sel, r));
        for (const [col, asc] of [...op.orden].reverse()) {
          out = [...out].sort((a, b) => {
            const x = a[col] as string | number | null | undefined;
            const y = b[col] as string | number | null | undefined;
            if (x === y) return 0;
            if (x == null) return 1;
            if (y == null) return -1;
            const c =
              typeof x === 'number' && typeof y === 'number'
                ? x - y
                : String(x) < String(y)
                  ? -1
                  : 1;
            return asc ? c : -c;
          });
        }
        const total = out.length;
        if (op.rango) out = out.slice(op.rango[0], op.rango[1] + 1);
        if (op.limite != null) out = out.slice(0, op.limite);
        out = out.slice(0, maxRows);
        return {
          data: uno ? (out[0] ?? null) : out,
          error: null,
          count: contar ? total : null,
        };
      };
      const api: Record<string, unknown> = {
        select(s?: string, o?: { count?: string }) {
          if (op.op === 'select') op.sel = s ?? '*';
          else devolverFilas = true;
          if (o?.count) contar = true;
          return api;
        },
        insert(r: Row | Row[]) {
          op.op = 'insert';
          op.cuerpo = r;
          return api;
        },
        upsert(r: Row | Row[]) {
          op.op = 'upsert';
          op.cuerpo = r;
          return api;
        },
        update(p: Row) {
          op.op = 'update';
          op.cuerpo = p;
          return api;
        },
        eq: (col: string, val: unknown) =>
          filtro('eq', col, val, (r) => r[col] === val),
        neq: (col: string, val: unknown) =>
          filtro('neq', col, val, (r) => r[col] !== val),
        is: (col: string, val: unknown) =>
          filtro('is', col, val, (r) => (r[col] ?? null) === val),
        in: (col: string, vals: unknown[]) =>
          filtro('in', col, vals, (r) => vals.includes(r[col])),
        gte: (col: string, val: unknown) =>
          filtro('gte', col, val, (r) =>
            typeof val === 'number'
              ? num(r[col]) >= val
              : r[col] != null && txt(r[col]) >= String(val),
          ),
        lte: (col: string, val: unknown) =>
          filtro('lte', col, val, (r) =>
            typeof val === 'number'
              ? num(r[col]) <= val
              : r[col] != null && txt(r[col]) <= String(val),
          ),
        gt: (col: string, val: unknown) =>
          filtro('gt', col, val, (r) =>
            typeof val === 'number'
              ? num(r[col]) > val
              : r[col] != null && txt(r[col]) > String(val),
          ),
        lt: (col: string, val: unknown) =>
          filtro('lt', col, val, (r) =>
            typeof val === 'number'
              ? num(r[col]) < val
              : r[col] != null && txt(r[col]) < String(val),
          ),
        ilike: (col: string, val: string) => {
          const re = patronIlike(val);
          return filtro('ilike', col, val, (r) => re.test(txt(r[col])));
        },
        or: (expr: string) => filtro('or', '', expr, predicadoOr(expr)),
        order(col: string, o?: { ascending?: boolean }) {
          op.orden.push([col, o?.ascending !== false]);
          return api;
        },
        range(d: number, h: number) {
          op.rango = [d, h];
          return api;
        },
        limit(n: number) {
          op.limite = n;
          return api;
        },
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        single: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
    rpc: (nombre: string, args: Row) =>
      Promise.resolve(rpcPartes(db, nombre, args)),
    storage: {
      from(bucket: string) {
        return {
          upload: (path: string) => {
            storage.push({ bucket, path });
            return Promise.resolve({ data: { path }, error: null });
          },
          createSignedUrl: (path: string) =>
            Promise.resolve({
              data: { signedUrl: `https://firmada/${path}` },
              error: null,
            }),
        };
      },
    },
  };
  return {
    supabase: { service } as unknown as SupabaseService,
    log,
    storage,
  };
}

/** Operaciones de ESCRITURA registradas (insert/update/upsert). */
export function escrituras(log: readonly OperacionFake[]): OperacionFake[] {
  return log.filter((o) => o.op !== 'select');
}
