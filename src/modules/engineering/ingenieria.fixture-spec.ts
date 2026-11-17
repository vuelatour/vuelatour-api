/**
 * PostgREST y Storage FALSOS para los specs de ingeniería (invariante 135).
 * El PostgREST falso FILTRA de verdad (`eq`, `neq`, `in`, `is`, `not … is
 * null`, `or`, `order`, `limit`, `range`) y ESCRIBE (`insert`, `update`,
 * `delete`): así las pruebas dicen qué quedó guardado y quién ve qué, no solo
 * qué llamadas se hicieron. No es un spec (jest no lo corre): es el arnés.
 */
import type { SupabaseService } from '../supabase/supabase.service';

export type Fila = Record<string, unknown>;
export type Op = { m: string; args: unknown[] };
export interface Consulta {
  tabla: string;
  ops: Op[];
}
export interface ErrorFalso {
  code?: string;
  message: string;
}

/** uuid determinista: `uuid(7)` → `00000000-0000-4000-8000-000000000007`. */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export interface OpcionesFalso {
  /** Filas iniciales por tabla (se copian). */
  tablas?: Record<string, Fila[]>;
  /** Tablas que «no existen» (migración sin aplicar) ⇒ 42P01. */
  ausentes?: string[];
  /** Llaves que SÍ existen en el bucket. */
  objetos?: string[];
}

/** Valores por omisión de las tablas nuevas (los `default` de la migración). */
const DEFAULTS: Record<string, () => Fila> = {
  componente_aeronave: () => ({
    categoria: null,
    posicion: null,
    numero_parte: null,
    numero_serie: null,
    fabricante: null,
    fecha_instalacion: null,
    horas_aeronave_instalacion: null,
    horas_previas: 0,
    limite_horas: null,
    limite_meses: null,
    fecha_vencimiento: null,
    aviso_horas: 10,
    aviso_dias: 30,
    notas: null,
    estado: 'INSTALADO',
    fecha_retiro: null,
    horas_aeronave_retiro: null,
    motivo_retiro: null,
    reemplaza_a_id: null,
    created_by: null,
    updated_by: null,
    eliminado_at: null,
    eliminado_por: null,
  }),
  adjunto_ingenieria: () => ({
    aeronave_id: null,
    mantenimiento_id: null,
    componente_id: null,
    motor_id: null,
    helice_id: null,
    etiqueta: null,
    nota: null,
    subido_por: null,
    eliminado_at: null,
    eliminado_por: null,
  }),
};

/** Divide por comas de nivel superior (fuera de paréntesis). */
function partes(expr: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of expr) {
    if (ch === '(') nivel++;
    if (ch === ')') nivel--;
    if (ch === ',' && nivel === 0) {
      out.push(actual);
      actual = '';
    } else {
      actual += ch;
    }
  }
  if (actual) out.push(actual);
  return out;
}

/** `col.eq.v` | `col.in.(a,b)` | `col.is.null` | `col.not.is.null`. */
function cumple(fila: Fila, expr: string): boolean {
  const i = expr.indexOf('.');
  const col = expr.slice(0, i);
  const resto = expr.slice(i + 1);
  const v = fila[col];
  if (resto === 'is.null') return v == null;
  if (resto === 'not.is.null') return v != null;
  if (resto.startsWith('eq.')) return v === resto.slice(3);
  if (resto.startsWith('in.(') && resto.endsWith(')')) {
    return resto.slice(4, -1).split(',').includes(String(v));
  }
  throw new Error(`filtro no soportado en la prueba: ${expr}`);
}

function comparar(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export function armarFalso(opciones: OpcionesFalso = {}) {
  const tablas: Record<string, Fila[]> = {};
  for (const [t, filas] of Object.entries(opciones.tablas ?? {})) {
    tablas[t] = filas.map((f) => ({ ...f }));
  }
  const ausentes = new Set(opciones.ausentes ?? []);
  const objetos = new Set(opciones.objetos ?? []);
  const consultas: Consulta[] = [];
  let serie = 9000;
  /** Reloj de las altas: cada fila nueva queda un segundo después. */
  let reloj = Date.parse('2026-11-17T18:00:00.000Z');

  /** Fallas inyectadas: la primera que coincida se consume. */
  const fallas: Array<{
    tabla: string;
    cuando: (ops: Op[]) => boolean;
    error: ErrorFalso;
    veces: number;
  }> = [];
  /** Se llama ANTES de resolver cada consulta (para simular carreras). */
  let antes: ((c: Consulta) => void) | null = null;

  const de = (tabla: string): Fila[] => {
    if (!tablas[tabla]) tablas[tabla] = [];
    return tablas[tabla];
  };

  const filtradas = (tabla: string, ops: Op[]): Fila[] => {
    let r = de(tabla).slice();
    for (const o of ops) {
      const [a, b, c] = o.args as [string, unknown, unknown];
      if (o.m === 'eq') r = r.filter((f) => f[a] === b);
      if (o.m === 'neq') r = r.filter((f) => f[a] !== b);
      if (o.m === 'in') {
        r = r.filter((f) => (b as unknown[]).includes(f[a]));
      }
      if (o.m === 'is') {
        if (b !== null) throw new Error('is solo con null en la prueba');
        r = r.filter((f) => f[a] == null);
      }
      if (o.m === 'not') {
        if (b !== 'is' || c !== null) throw new Error('not no soportado');
        r = r.filter((f) => f[a] != null);
      }
      if (o.m === 'or') {
        r = r.filter((f) => partes(a).some((p) => cumple(f, p)));
      }
    }
    const ordenes = ops.filter((o) => o.m === 'order');
    if (ordenes.length > 0) {
      r.sort((x, y) => {
        for (const o of ordenes) {
          const col = o.args[0] as string;
          const opt = (o.args[1] ?? {}) as {
            ascending?: boolean;
            nullsFirst?: boolean;
          };
          const asc = opt.ascending !== false;
          const vx = x[col];
          const vy = y[col];
          if (vx == null && vy == null) continue;
          // Postgres: los null van al final en ASC y al principio en DESC,
          // salvo que `nullsFirst` diga otra cosa.
          const nullsFirst = opt.nullsFirst ?? !asc;
          if (vx == null) return nullsFirst ? -1 : 1;
          if (vy == null) return nullsFirst ? 1 : -1;
          const cmp = comparar(vx, vy);
          if (cmp !== 0) return asc ? cmp : -cmp;
        }
        return 0;
      });
    }
    const rango = ops.find((o) => o.m === 'range');
    if (rango) {
      r = r.slice(rango.args[0] as number, (rango.args[1] as number) + 1);
    }
    const lim = ops.find((o) => o.m === 'limit');
    return lim ? r.slice(0, lim.args[0] as number) : r;
  };

  const resolver = (
    tabla: string,
    ops: Op[],
    unica: boolean,
  ): { data: unknown; error: ErrorFalso | null } => {
    if (antes) antes({ tabla, ops });
    if (ausentes.has(tabla)) {
      return {
        data: null,
        error: {
          code: '42P01',
          message: `relation "public.${tabla}" does not exist`,
        },
      };
    }
    const falla = fallas.find(
      (f) => f.tabla === tabla && f.veces > 0 && f.cuando(ops),
    );
    if (falla) {
      falla.veces -= 1;
      return { data: null, error: falla.error };
    }
    const ins = ops.find((o) => o.m === 'insert');
    if (ins) {
      const entrada = ins.args[0] as Fila | Fila[];
      const nuevas: Fila[] = (Array.isArray(entrada) ? entrada : [entrada]).map(
        (f): Fila => {
          reloj += 1000;
          const sello = new Date(reloj).toISOString();
          return {
            id: uuid(++serie),
            created_at: sello,
            updated_at: sello,
            ...(DEFAULTS[tabla]?.() ?? {}),
            ...f,
          };
        },
      );
      // Índice único de la llave del archivo.
      if (tabla === 'adjunto_ingenieria') {
        const repetida = nuevas.find((n) =>
          de(tabla).some((f) => f.storage_path === n.storage_path),
        );
        if (repetida) {
          return {
            data: null,
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "uq_adjunto_ingenieria_path"',
            },
          };
        }
      }
      de(tabla).push(...nuevas);
      return { data: unica ? nuevas[0] : nuevas, error: null };
    }
    const upd = ops.find((o) => o.m === 'update');
    if (upd) {
      const tocadas = filtradas(tabla, ops);
      for (const f of tocadas) Object.assign(f, upd.args[0] as Fila);
      return { data: unica ? (tocadas[0] ?? null) : tocadas, error: null };
    }
    if (ops.some((o) => o.m === 'delete')) {
      const fuera = filtradas(tabla, ops);
      for (const f of fuera) de(tabla).splice(de(tabla).indexOf(f), 1);
      return { data: unica ? null : fuera, error: null };
    }
    const r = filtradas(tabla, ops).map((f) => ({ ...f }));
    return { data: unica ? (r[0] ?? null) : r, error: null };
  };

  const from = (tabla: string) => {
    const ops: Op[] = [];
    consultas.push({ tabla, ops });
    const q: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'not',
      'or',
      'order',
      'range',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = (...args: unknown[]) => {
        ops.push({ m, args });
        return q;
      };
    }
    q.maybeSingle = () => Promise.resolve(resolver(tabla, ops, true));
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolver(tabla, ops, false)).then(res, rej);
    return q;
  };

  // ───────────── Storage falso ─────────────
  const firmas: Array<{
    bucket: string;
    path: string;
    segundos: number;
    opciones: unknown;
  }> = [];
  const borrados: Array<{ bucket: string; paths: string[] }> = [];
  let fallaFirma: { message: string; status?: number } | null = null;
  let fallaBorrado: { message: string } | null = null;
  const storage = {
    from: (bucket: string) => ({
      createSignedUrl: (
        path: string,
        segundos: number,
        opciones?: { download?: string },
      ) => {
        firmas.push({ bucket, path, segundos, opciones });
        if (fallaFirma) {
          return Promise.resolve({ data: null, error: fallaFirma });
        }
        if (!objetos.has(path)) {
          return Promise.resolve({
            data: null,
            error: { message: 'Object not found', status: 400 },
          });
        }
        const descarga = opciones?.download
          ? `&download=${opciones.download}`
          : '';
        return Promise.resolve({
          data: {
            signedUrl: `https://storage.test/${bucket}/${path}?token=t&exp=${segundos}${descarga}`,
          },
          error: null,
        });
      },
      remove: (paths: string[]) => {
        borrados.push({ bucket, paths });
        if (fallaBorrado) {
          return Promise.resolve({ data: null, error: fallaBorrado });
        }
        for (const p of paths) objetos.delete(p);
        return Promise.resolve({ data: paths, error: null });
      },
    }),
  };

  const supabase = { service: { from, storage } } as unknown as SupabaseService;

  return {
    supabase,
    tablas,
    de,
    consultas,
    objetos,
    firmas,
    borrados,
    /** La próxima consulta a `tabla` que cumpla `cuando` responde `error`. */
    fallar(
      tabla: string,
      cuando: (ops: Op[]) => boolean,
      error: ErrorFalso,
      veces = 1,
    ) {
      fallas.push({ tabla, cuando, error, veces });
    },
    /** Gancho previo a cada consulta (simular que otro escribió en medio). */
    antesDeCadaConsulta(fn: ((c: Consulta) => void) | null) {
      antes = fn;
    },
    fallarFirma(error: { message: string; status?: number } | null) {
      fallaFirma = error;
    },
    fallarBorradoDeArchivos(error: { message: string } | null) {
      fallaBorrado = error;
    },
    /** Consultas a una tabla que incluyen la operación `m`. */
    conOp(tabla: string, m: string): Consulta[] {
      return consultas.filter(
        (c) => c.tabla === tabla && c.ops.some((o) => o.m === m),
      );
    },
    /** Cuerpo de la n-ésima escritura `m` sobre `tabla`. */
    cuerpo(tabla: string, m: 'insert' | 'update', n = 0): Fila {
      const c = consultas.filter(
        (x) => x.tabla === tabla && x.ops.some((o) => o.m === m),
      )[n];
      if (!c) throw new Error(`no hubo ${m} #${n} en ${tabla}`);
      return c.ops.find((o) => o.m === m)!.args[0] as Fila;
    },
  };
}

export type Falso = ReturnType<typeof armarFalso>;

/** ¿La consulta lleva la operación `m`? */
export const tieneOp = (ops: Op[], m: string): boolean =>
  ops.some((o) => o.m === m);
