import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConciliacionService } from './conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import { toleranciaLote } from './conciliacion-parcial.util';

/**
 * 1 ABONO ↔ N COBROS (12-oct-2026, API 0.0.71, invariante 56). Caso del
 * cliente: «hicieron un pago para el vuelo 379 y 380». Se congela:
 * - `linkCobro` con `cobro_ids` (2+) escribe la PUENTE por la RPC: partes =
 *   NETO de cada cobro, espejo `cobro_id` NULL, `cobros_n` = N, conciliado,
 *   y la respuesta lleva `cobros_estado[]` con el vuelo de cada parte;
 * - los 409 ANTES de escribir (ABONO_NO_CUADRA, LOTE_MONEDA_DISTINTA,
 *   COBRO_YA_CONCILIADO —también dentro del lote de OTRO abono—,
 *   COBRO_DE_GRUPO) y el 409 MOVIMIENTO_CON_LOTE de un `cobro_id` suelto
 *   sobre un lote;
 * - desvincular ({} ) un lote: RPC H + el camino de siempre ⇒ pendiente;
 * - los LECTORES ven un cobro de un lote como conciliado (candidatos,
 *   «cobros sin banco», lista con `cobros[]`);
 * - y SIN la migración: UN cobro por el camino directo de siempre y 2+ ⇒
 *   503 CONCILIACION_COBROS_NO_DISPONIBLE, sin nombrar la puente.
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const CTA = 'cta-mxn';
const USER = 'user-1';

const txt = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : v == null
        ? ''
        : JSON.stringify(v);

const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = txt(a);
  const sb = txt(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

/** Columnas que NO existen sin sus migraciones (42703 al nombrarlas). */
const COLUMNAS_AUSENTES = [
  'ingreso_id',
  'ingreso_anticipo_id',
  'gastos_n',
  'reverso_de_id',
  'orden_archivo',
  'folio_releido_at',
];

/**
 * Mini-PostgREST en memoria con embeds `vuelo` (+ `cliente`) y
 * `movimiento:movimiento_bancario!movimiento_id`, y la RPC de la puente de
 * cobros emulada (misma regla que la BD). `sinMigracion` = no existe
 * `cobros_n` ni la puente.
 */
function fakeSupabase(db: Tablas, opts: { sinMigracion?: boolean } = {}) {
  const log: Array<{ tabla: string; sel: string }> = [];
  const ausentes = opts.sinMigracion
    ? [...COLUMNAS_AUSENTES, 'cobros_n']
    : COLUMNAS_AUSENTES;
  const embeber = (tabla: string, sel: string, r: Row): Row => {
    const out: Row = { ...r };
    if (/\bvuelo:vuelo!vuelo_id\(/.test(sel)) {
      const v = (db.vuelo ?? []).find((x) => x.id === r.vuelo_id) ?? null;
      out.vuelo = v
        ? {
            ...v,
            cliente:
              (db.cliente ?? []).find((c) => c.id === v.cliente_id) ?? null,
          }
        : null;
    }
    if (/\bmovimiento:movimiento_bancario!movimiento_id\(/.test(sel)) {
      out.movimiento =
        (db.movimiento_bancario ?? []).find((x) => x.id === r.movimiento_id) ??
        null;
    }
    if (
      tabla === 'movimiento_bancario' &&
      /\bcobro:cobro_vuelo!cobro_id\(/.test(sel)
    ) {
      out.cobro =
        (db.cobro_vuelo ?? []).find((c) => c.id === r.cobro_id) ?? null;
    }
    return out;
  };
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let patch: Row = {};
      let sel = '';
      let rango: [number, number] | null = null;
      let limite: number | null = null;
      const orden: Array<[string, boolean]> = [];
      let prohibido =
        opts.sinMigracion && tabla === 'movimiento_bancario_cobro';
      const entrada = { tabla, sel: '' };
      log.push(entrada);
      const marcar = (texto: string) => {
        for (const c of ausentes) {
          if (new RegExp(`\\b${c}\\b`).test(texto)) prohibido = true;
        }
      };
      const ejecutar = (unico: boolean) => {
        if (prohibido) {
          return {
            data: null,
            error: {
              code: '42703',
              message: `column ${tabla}.x does not exist`,
            },
            count: null,
          };
        }
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        if (op === 'update') filas.forEach((r) => Object.assign(r, patch));
        let out = filas.map((r) => embeber(tabla, sel, r));
        for (const [col, asc] of [...orden].reverse()) {
          out.sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
        }
        const total = out.length;
        if (rango) out = out.slice(rango[0], rango[1] + 1);
        if (limite != null) out = out.slice(0, limite);
        return {
          data: unico ? (out[0] ?? null) : out,
          error: null,
          count: total,
        };
      };
      const api: Record<string, unknown> = {
        select(s?: string) {
          sel = s ?? '';
          entrada.sel = sel;
          marcar(sel);
          return api;
        },
        update(p: Row) {
          op = 'update';
          patch = p;
          marcar(Object.keys(p).join(','));
          return api;
        },
        eq(col: string, val: unknown) {
          marcar(col);
          filtros.push((r) => r[col] === val);
          return api;
        },
        neq(col: string, val: unknown) {
          filtros.push((r) => r[col] !== val);
          return api;
        },
        is(col: string, val: unknown) {
          marcar(col);
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        not(col: string, o: string, val: unknown) {
          marcar(col);
          if (o === 'is' && val === null)
            filtros.push((r) => (r[col] ?? null) !== null);
          return api;
        },
        in(col: string, vals: unknown[]) {
          marcar(col);
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        or(cond: string) {
          marcar(cond);
          filtros.push((r) =>
            cond.split(',').some((c) => {
              const m = /^([^.]+)\.(\w+)\.(.*)$/.exec(c);
              if (!m) return false;
              const [, col, o, raw] = m;
              if (o === 'not') return (r[col] ?? null) !== null;
              if (o === 'eq') return String(r[col]) === raw;
              return false;
            }),
          );
          return api;
        },
        gte(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) >= 0);
          return api;
        },
        lte(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) <= 0);
          return api;
        },
        gt(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) > 0);
          return api;
        },
        order(col: string, o?: { ascending?: boolean }) {
          orden.push([col, o?.ascending !== false]);
          return api;
        },
        range(a: number, b: number) {
          rango = [a, b];
          return api;
        },
        limit(n: number) {
          limite = n;
          return api;
        },
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        single: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
    rpc(nombre: string, args: Row) {
      log.push({ tabla: `rpc:${nombre}`, sel: JSON.stringify(args) });
      if (opts.sinMigracion) {
        return Promise.resolve({
          data: null,
          error: {
            code: 'PGRST202',
            message: `Could not find the function public.${nombre}`,
          },
        });
      }
      return Promise.resolve(rpcCobros(db, nombre, args));
    },
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

const fallo = (hint: string, message: string, detail: Row) => ({
  data: null,
  error: {
    code: '23514',
    hint,
    message: `${hint}: ${message}`,
    details: JSON.stringify(detail),
  },
});

/** Espejos del abono (trigger B) tras tocar la puente. */
function sincronizar(db: Tablas, movId: string) {
  const partes = (db.movimiento_bancario_cobro ?? []).filter(
    (p) => p.movimiento_id === movId,
  );
  const m = db.movimiento_bancario.find((x) => x.id === movId);
  if (!m) return;
  m.cobros_n = partes.length;
  m.cobro_id = partes.length === 1 ? partes[0].cobro_id : null;
  m.conciliado = partes.length > 0 || !!m.gasto_id || !!m.cobro_grupo_id;
  if (partes.length > 0) m.clasificacion_id = null;
}

/** RPC G/H de 20261012000002 emuladas con la MISMA regla. */
function rpcCobros(db: Tablas, nombre: string, args: Row) {
  const movId = args.p_movimiento_id as string;
  const m = db.movimiento_bancario.find((x) => x.id === movId);
  if (!m)
    return fallo('LOTE_INVALIDO', `el movimiento ${movId} no existe`, {
      movimiento_id: movId,
    });
  if (nombre === 'conciliacion_desligar_abono_cobros') {
    db.movimiento_bancario_cobro = (db.movimiento_bancario_cobro ?? []).filter(
      (p) => p.movimiento_id !== movId,
    );
    sincronizar(db, movId);
    return { data: { movimiento_id: movId, salientes: [] }, error: null };
  }
  const ids = args.p_cobro_ids as string[];
  if (m.tipo !== 'ABONO')
    return fallo('SOLO_ABONOS', 'solo un ABONO', { tipo: m.tipo });
  const cuenta = db.cuenta_bancaria.find((c) => c.id === m.cuenta_bancaria_id);
  const moneda = cuenta?.moneda as string;
  let suma = 0;
  const nuevas: Row[] = [];
  for (const id of ids) {
    const c = db.cobro_vuelo.find((x) => x.id === id);
    if (!c) return fallo('COBRO_NO_EXISTE', 'no existe', { cobro_id: id });
    const ocupado = (db.movimiento_bancario_cobro ?? []).find(
      (p) => p.cobro_id === id && p.movimiento_id !== movId,
    );
    if (ocupado)
      return fallo('COBRO_YA_CONCILIADO', 'ocupado', {
        cobro_id: id,
        movimiento_id: ocupado.movimiento_id,
      });
    if (ids.length >= 2 && c.moneda !== moneda)
      return fallo('LOTE_MONEDA_DISTINTA', 'moneda', {
        cobro_id: id,
        moneda_cobro: c.moneda,
        moneda_cuenta: moneda,
      });
    const neto =
      Math.round(
        ((c.monto as number) - ((c.comision_banco_monto as number) || 0)) * 100,
      ) / 100;
    suma += neto;
    nuevas.push({
      movimiento_id: movId,
      cobro_id: id,
      monto_parte: ids.length === 1 ? Math.abs(m.monto as number) : neto,
      created_at: `2026-10-12T10:00:0${nuevas.length}Z`,
      created_by: args.p_actor,
    });
  }
  if (ids.length >= 2) {
    const dif = Math.round((Math.abs(m.monto as number) - suma) * 100) / 100;
    if (Math.abs(dif) > toleranciaLote(ids.length) + 0.000001) {
      return fallo('ABONO_NO_CUADRA', 'no cuadra', {
        monto_abono: m.monto,
        suma_cobros: suma,
        diferencia: dif,
        tolerancia: toleranciaLote(ids.length),
        moneda,
        cobros: [],
      });
    }
  }
  db.movimiento_bancario_cobro = [
    ...(db.movimiento_bancario_cobro ?? []).filter(
      (p) => p.movimiento_id !== movId,
    ),
    ...nuevas,
  ];
  sincronizar(db, movId);
  return { data: { movimiento_id: movId, partes: nuevas }, error: null };
}

const abono = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-10-06',
  tipo: 'ABONO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion: 'SPEI MAQAR',
  referencia: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  origen: 'IMPORTADO',
  notas: null,
  created_at: '2026-10-06T12:00:00Z',
  cobros_n: 0,
  ...extra,
});

const cobro = (
  id: string,
  vueloId: string,
  monto: number,
  extra: Row = {},
): Row => ({
  id,
  vuelo_id: vueloId,
  monto,
  moneda: 'MXN',
  metodo_cobro: 'TRANSFERENCIA',
  fecha_cobro: '2026-10-06T15:00:00Z',
  referencia: null,
  comision_banco_monto: null,
  cobro_grupo_id: null,
  ...extra,
});

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'Scotia MXN',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
    ],
    cliente: [{ id: 'k-maqar', nombre: 'Maqar', activo: true }],
    vuelo: [
      {
        id: 'v379',
        folio: 379,
        fecha_vuelo: '2026-10-04T14:00:00Z',
        cliente_id: 'k-maqar',
        aeronave_id: 'a1',
      },
      {
        id: 'v380',
        folio: 380,
        fecha_vuelo: '2026-10-05T14:00:00Z',
        cliente_id: 'k-maqar',
        aeronave_id: 'a1',
      },
      {
        id: 'v381',
        folio: 381,
        fecha_vuelo: '2026-10-05T18:00:00Z',
        cliente_id: 'k-maqar',
        aeronave_id: 'a1',
      },
    ],
    movimiento_bancario: [abono('m1', 3500)],
    cobro_vuelo: [
      cobro('c379', 'v379', 1000),
      cobro('c380', 'v380', 2600, { comision_banco_monto: 100 }),
      cobro('c381', 'v381', 500),
    ],
    cobro_grupo: [],
    tarjeta_corporativa: [],
    conciliacion_clasificacion: [],
    movimiento_bancario_cobro: [],
    ...extra,
  };
}

function armar(db: Tablas, opts: { sinMigracion?: boolean } = {}) {
  const f = fakeSupabase(db, opts);
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    f.supabase,
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, db, log: f.log };
}

const code = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  const r = (e as { getResponse?: () => unknown } | null)?.getResponse?.();
  return {
    e,
    code: (r as { error?: string } | undefined)?.error ?? null,
    details: (r as { details?: unknown } | undefined)?.details ?? null,
    message: (r as { message?: string } | undefined)?.message ?? null,
  };
};

describe('1 abono ↔ N cobros — linkCobro con cobro_ids (con la migración)', () => {
  it('dos cobros que cuadran: partes = neto, espejo NULL, cobros_n 2, conciliado; respuesta con cobros_estado', async () => {
    const { svc, db } = armar(mundo());
    const r = (await svc.linkCobro(
      'm1',
      { cobro_ids: ['c379', 'c380'] },
      USER,
    )) as Record<string, unknown>;
    const m = db.movimiento_bancario[0];
    expect(m.cobros_n).toBe(2);
    expect(m.cobro_id).toBeNull();
    expect(m.conciliado).toBe(true);
    expect(
      db.movimiento_bancario_cobro.map((p) => [p.cobro_id, p.monto_parte]),
    ).toEqual([
      ['c379', 1000],
      ['c380', 2500],
    ]);
    expect(r.cobros_n).toBe(2);
    expect(r.cobros_estado).toEqual([
      expect.objectContaining({
        cobro_id: 'c379',
        monto_parte: 1000,
        folio: 379,
        cliente: 'Maqar',
        neto: 1000,
      }),
      expect.objectContaining({
        cobro_id: 'c380',
        monto_parte: 2500,
        folio: 380,
        monto: 2600,
        comision_banco_monto: 100,
        neto: 2500,
      }),
    ]);
  });

  it('no cuadra ⇒ 409 ABONO_NO_CUADRA con el detalle, sin escribir nada', async () => {
    const { svc, db, log } = armar(mundo());
    const antes = log.length;
    const r = await code(
      svc.linkCobro('m1', { cobro_ids: ['c379', 'c381'] }, USER),
    );
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('ABONO_NO_CUADRA');
    expect(r.details).toMatchObject({
      monto_abono: 3500,
      suma_cobros: 1500,
      diferencia: 2000,
      tolerancia: 0.02,
    });
    expect(r.message).toContain('faltan $2,000.00 MXN');
    expect(db.movimiento_bancario_cobro).toEqual([]);
    expect(db.movimiento_bancario[0].conciliado).toBe(false);
    expect(log.slice(antes).some((l) => l.tabla.startsWith('rpc:'))).toBe(
      false,
    );
  });

  it('otra moneda en el lote ⇒ 409 LOTE_MONEDA_DISTINTA nombrando el vuelo', async () => {
    const { svc } = armar(
      mundo({
        cobro_vuelo: [
          cobro('c379', 'v379', 1000),
          cobro('c380', 'v380', 2500, { moneda: 'USD' }),
        ],
      }),
    );
    const r = await code(
      svc.linkCobro('m1', { cobro_ids: ['c379', 'c380'] }, USER),
    );
    expect(r.code).toBe('LOTE_MONEDA_DISTINTA');
    expect(r.message).toContain('#380');
  });

  it('un cobro dentro del lote de OTRO abono ⇒ 409 COBRO_YA_CONCILIADO (su espejo cobro_id es NULL)', async () => {
    const db = mundo({
      movimiento_bancario: [abono('m1', 3500), abono('m2', 1500)],
    });
    const { svc } = armar(db);
    await svc.linkCobro('m1', { cobro_ids: ['c379', 'c380'] }, USER);
    const r = await code(
      svc.linkCobro('m2', { cobro_ids: ['c379', 'c381'] }, USER),
    );
    expect(r.code).toBe('COBRO_YA_CONCILIADO');
    expect(r.message).toContain('#379');
    expect(r.details).toMatchObject({ cobro_id: 'c379', movimiento_id: 'm1' });
    expect(db.movimiento_bancario[1].cobros_n).toBe(0);
  });

  it('parte de sobre o reembolso dentro del lote ⇒ su código', async () => {
    const { svc } = armar(
      mundo({
        cobro_vuelo: [
          cobro('c379', 'v379', 1000, { cobro_grupo_id: 's1' }),
          cobro('c380', 'v380', 2500),
        ],
      }),
    );
    expect(
      (await code(svc.linkCobro('m1', { cobro_ids: ['c379', 'c380'] }, USER)))
        .code,
    ).toBe('COBRO_DE_GRUPO');
    const { svc: svc2 } = armar(
      mundo({
        cobro_vuelo: [
          cobro('c379', 'v379', -1000),
          cobro('c380', 'v380', 4500),
        ],
      }),
    );
    expect(
      (await code(svc2.linkCobro('m1', { cobro_ids: ['c379', 'c380'] }, USER)))
        .code,
    ).toBe('COBRO_INVALIDO');
  });

  it('cobro_ids con UN cobro va por la RPC: parte = |abono| y espejo = el cobro', async () => {
    const { svc, db } = armar(mundo());
    await svc.linkCobro('m1', { cobro_ids: ['c379'] }, USER);
    const m = db.movimiento_bancario[0];
    expect(m.cobros_n).toBe(1);
    expect(m.cobro_id).toBe('c379');
    expect(db.movimiento_bancario_cobro).toEqual([
      expect.objectContaining({ cobro_id: 'c379', monto_parte: 3500 }),
    ]);
  });

  it('cobro_ids junto a cobro_id ⇒ 400 LOTE_INVALIDO; lista vacía ⇒ 400', async () => {
    const { svc } = armar(mundo());
    const r = await code(
      svc.linkCobro('m1', { cobro_id: 'c379', cobro_ids: ['c380'] }, USER),
    );
    expect(r.e).toBeInstanceOf(BadRequestException);
    expect(r.code).toBe('LOTE_INVALIDO');
    expect(
      (await code(svc.linkCobro('m1', { cobro_ids: [] }, USER))).code,
    ).toBe('LOTE_INVALIDO');
  });

  it('un cobro_id suelto sobre un lote ⇒ 409 MOVIMIENTO_CON_LOTE; desvincular ({}) suelta el lote', async () => {
    const { svc, db } = armar(mundo());
    await svc.linkCobro('m1', { cobro_ids: ['c379', 'c380'] }, USER);
    const r = await code(svc.linkCobro('m1', { cobro_id: 'c381' }, USER));
    expect(r.code).toBe('MOVIMIENTO_CON_LOTE');
    expect(db.movimiento_bancario[0].cobros_n).toBe(2);
    await svc.linkCobro('m1', {}, USER);
    const m = db.movimiento_bancario[0];
    expect(m.cobros_n).toBe(0);
    expect(m.cobro_id).toBeNull();
    expect(m.conciliado).toBe(false);
    expect(db.movimiento_bancario_cobro).toEqual([]);
  });

  it('reemplazar el lote por otro (DIFF) deja solo las partes nuevas', async () => {
    const { svc, db } = armar(
      mundo({
        cobro_vuelo: [
          cobro('c379', 'v379', 1000),
          cobro('c380', 'v380', 2500),
          cobro('c381', 'v381', 2500),
        ],
      }),
    );
    await svc.linkCobro('m1', { cobro_ids: ['c379', 'c380'] }, USER);
    await svc.linkCobro('m1', { cobro_ids: ['c379', 'c381'] }, USER);
    expect(db.movimiento_bancario_cobro.map((p) => p.cobro_id).sort()).toEqual([
      'c379',
      'c381',
    ]);
    expect(db.movimiento_bancario[0].cobros_n).toBe(2);
  });
});

describe('1 abono ↔ N cobros — los lectores ven el lote', () => {
  it('candidatos-cobro: un cobro del lote de OTRO abono no es candidato; los de ESTE siguen y viajan en cobro_ids', async () => {
    const db = mundo({
      movimiento_bancario: [abono('m1', 3500), abono('m2', 500)],
    });
    const { svc } = armar(db);
    await svc.linkCobro('m1', { cobro_ids: ['c379', 'c380'] }, USER);
    const otro = await svc.candidatosCobro('m2', 30);
    expect(otro.candidatos.map((c) => c.id)).toEqual(['c381']);
    const mismo = await svc.candidatosCobro('m1', 30);
    expect(mismo.candidatos.map((c) => c.id).sort()).toEqual([
      'c379',
      'c380',
      'c381',
    ]);
    expect(mismo.movimiento).toMatchObject({
      cobros_n: 2,
      cobro_ids: ['c379', 'c380'],
    });
  });

  it('cobros-sin-banco: los cobros pagados dentro de un lote ya no salen', async () => {
    const { svc } = armar(mundo());
    await svc.linkCobro('m1', { cobro_ids: ['c379', 'c380'] }, USER);
    const r = await svc.cobrosSinBanco('2026-10-01', '2026-10-31');
    expect(r.data.map((c) => c.id)).toEqual(['c381']);
  });

  it('la lista pega cobros[] (con vuelo, folio y neto), cobros_suma y cobros_diferencia al abono con lote', async () => {
    const { svc } = armar(mundo());
    await svc.linkCobro('m1', { cobro_ids: ['c379', 'c380'] }, USER);
    const r = await svc.list({ limit: 50, offset: 0 });
    const m = r.data.find((x) => x.id === 'm1') as Record<string, unknown>;
    expect(m.cobros_n).toBe(2);
    expect(m.cobros).toEqual([
      expect.objectContaining({
        cobro_id: 'c379',
        folio: 379,
        cliente: 'Maqar',
        monto_parte: 1000,
      }),
      expect.objectContaining({
        cobro_id: 'c380',
        folio: 380,
        monto_parte: 2500,
        neto: 2500,
      }),
    ]);
    expect(m.cobros_suma).toBe(3500);
    expect(m.cobros_diferencia).toBe(0);
  });
});

describe('1 abono ↔ N cobros — SIN la migración', () => {
  it('2+ cobros ⇒ 503 CONCILIACION_COBROS_NO_DISPONIBLE sin tocar nada', async () => {
    const { svc, db, log } = armar(mundo(), { sinMigracion: true });
    const r = await code(
      svc.linkCobro('m1', { cobro_ids: ['c379', 'c380'] }, USER),
    );
    expect(r.e).toBeInstanceOf(ServiceUnavailableException);
    expect(r.code).toBe('CONCILIACION_COBROS_NO_DISPONIBLE');
    expect(db.movimiento_bancario[0].conciliado).toBe(false);
    expect(log.some((l) => l.tabla.startsWith('rpc:'))).toBe(false);
  });

  it('UN cobro (cobro_ids o cobro_id) va por el camino directo de siempre', async () => {
    const { svc, db, log } = armar(mundo(), { sinMigracion: true });
    await svc.linkCobro('m1', { cobro_ids: ['c379'] }, USER);
    expect(db.movimiento_bancario[0]).toMatchObject({
      cobro_id: 'c379',
      conciliado: true,
    });
    expect(
      log.some(
        (l) => l.tabla === 'movimiento_bancario_cobro' && !l.sel.includes('x'),
      ),
    ).toBe(false);
    await svc.linkCobro('m1', {}, USER);
    expect(db.movimiento_bancario[0]).toMatchObject({
      cobro_id: null,
      conciliado: false,
    });
  });
});
