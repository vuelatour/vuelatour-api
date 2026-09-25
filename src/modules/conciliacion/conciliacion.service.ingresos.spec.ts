import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConciliacionService } from './conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';

/**
 * CONCILIACIÓN DE INGRESOS (24-sep-2026, contrato §6 y §12.7). Se congela:
 * - `linkIngreso` (abono ↔ ingreso 1 ↔ 1) y cada uno de sus 409;
 * - que `link`/`linkCobro`/`clasificar` no toquen un abono ligado a un
 *   ingreso, y que `linkCobro` rechace un cobro nacido de un anticipo;
 * - la decisión ÚNICA del auto-cruce de abonos (cobros, sobres e ingresos) y
 *   la exclusión de los cobros de anticipo en auto-cruce, candidatos y
 *   Paywise;
 * - «cobros sin banco» honesto con los anticipos (regla 1.3);
 * - «Por conciliar» (caso real #235) y «Sugerir con IA» (la IA propone,
 *   jamás liga);
 * - y que SIN la migración todo responda como hoy (ninguna consulta nombra
 *   las columnas nuevas; las rutas nuevas 503).
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const CTA = 'cta-mxn';
const CTA_OTRA = 'cta-mxn-2';
const CTA_USD = 'cta-usd';
const CTA_PW = 'cta-paywise';
const USER = 'user-1';

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
  const iso = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
  if (iso(a) && iso(b)) return Date.parse(String(a)) - Date.parse(String(b));
  if (iso(a) || iso(b)) {
    // Un DATE contra un instante: compara el día.
    return String(a).slice(0, 10) < String(b).slice(0, 10)
      ? -1
      : String(a).slice(0, 10) > String(b).slice(0, 10)
        ? 1
        : 0;
  }
  const sa = txt(a);
  const sb = txt(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

/**
 * Mini-PostgREST en memoria con escrituras. `sinMigracion` = no existen
 * `movimiento_bancario.ingreso_id`, `cobro_vuelo.ingreso_anticipo_id` ni la
 * tabla `ingreso`: cualquier consulta que los nombre falla con 42703.
 */
function fakeSupabase(db: Tablas, opts: { sinMigracion?: boolean } = {}) {
  const log: Array<{ tabla: string; sel: string; ops: string[] }> = [];
  let seq = 0;
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      const ops: string[] = [];
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let patch: Row = {};
      let aInsertar: Row[] = [];
      let sel = '';
      let rango: [number, number] | null = null;
      let limite: number | null = null;
      const orden: Array<[string, boolean]> = [];
      let prohibido = opts.sinMigracion && tabla === 'ingreso';
      const entrada = { tabla, sel: '', ops };
      log.push(entrada);
      const marcar = (texto: string) => {
        if (opts.sinMigracion && /\bingreso_(anticipo_)?id\b/.test(texto)) {
          prohibido = true;
        }
      };
      const ejecutar = (unico: boolean) => {
        if (prohibido) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column ingreso_id does not exist',
            },
            count: null,
          };
        }
        if (op === 'insert') {
          const creados = aInsertar.map((r) => ({
            id: `${tabla}-${++seq}`,
            ...r,
          }));
          db[tabla] = [...(db[tabla] ?? []), ...creados];
          return {
            data: unico ? (creados[0] ?? null) : creados,
            error: null,
            count: creados.length,
          };
        }
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        if (op === 'update') filas.forEach((r) => Object.assign(r, patch));
        if (op === 'delete') {
          db[tabla] = (db[tabla] ?? []).filter((r) => !filas.includes(r));
        }
        let out = filas.map((r) => ({ ...r }));
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
      const cumple = (r: Row, cond: string): boolean => {
        const m = /^([^.]+)\.([a-z]+)\.(.*)$/.exec(cond);
        if (!m) return false;
        const [, col, o, raw] = m;
        const v = r[col];
        if (o === 'is') return (v ?? null) === null && raw === 'null';
        if (o === 'not') return raw === 'is.null' ? (v ?? null) !== null : true;
        if (o === 'eq') return String(v) === raw;
        if (o === 'in') {
          return raw
            .replace(/^\(|\)$/g, '')
            .split(',')
            .includes(String(v));
        }
        return false;
      };
      const api: Record<string, unknown> = {
        select(s?: string) {
          sel = s ?? '';
          entrada.sel = sel;
          marcar(sel);
          return api;
        },
        insert(r: Row | Row[]) {
          op = 'insert';
          aInsertar = Array.isArray(r) ? r : [r];
          marcar(JSON.stringify(Object.keys(aInsertar[0] ?? {})));
          return api;
        },
        update(p: Row) {
          op = 'update';
          patch = p;
          marcar(JSON.stringify(Object.keys(p)));
          return api;
        },
        delete() {
          op = 'delete';
          return api;
        },
        eq(col: string, val: unknown) {
          ops.push(`eq:${col}`);
          marcar(col);
          filtros.push((r) => r[col] === val);
          return api;
        },
        neq(col: string, val: unknown) {
          filtros.push((r) => r[col] !== val);
          return api;
        },
        is(col: string, val: unknown) {
          ops.push(`is:${col}`);
          marcar(col);
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        not(col: string, o: string, val: unknown) {
          marcar(col);
          if (o === 'is' && val === null) {
            filtros.push((r) => (r[col] ?? null) !== null);
          }
          return api;
        },
        ilike(col: string, val: string) {
          filtros.push((r) => txt(r[col]).toLowerCase() === val.toLowerCase());
          return api;
        },
        in(col: string, vals: unknown[]) {
          ops.push(`in:${col}`);
          marcar(col);
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        or(cond: string) {
          marcar(cond);
          filtros.push((r) => partirOr(cond).some((c) => cumple(r, c)));
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
        lt(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) < 0);
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
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

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
      {
        id: CTA_OTRA,
        alias: 'HSBC MXN',
        banco: 'HSBC',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
      {
        id: CTA_USD,
        alias: 'Scotia USD',
        banco: 'Scotiabank',
        moneda: 'USD',
        tipo: 'BANCO',
      },
      {
        id: CTA_PW,
        alias: 'Paywise',
        banco: 'Paywise',
        moneda: 'MXN',
        tipo: 'PASARELA',
      },
    ],
    tarjeta_corporativa: [],
    conciliacion_clasificacion: [
      { id: 'cl-traspaso', nombre: 'Traspaso entre cuentas', activo: true },
      { id: 'cl-reverso', nombre: 'Reverso de un cargo', activo: true },
    ],
    cliente: [
      { id: 'k-cristy', nombre: 'Cristy Chavez', activo: true },
      { id: 'k-leticia', nombre: 'Leticia León Alvarado', activo: true },
    ],
    movimiento_bancario: [],
    cobro_vuelo: [],
    cobro_grupo: [],
    ingreso: [],
    ingreso_bitacora: [],
    gasto: [],
    ...extra,
  };
}

const abono = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-08',
  tipo: 'ABONO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion: null,
  referencia: null,
  notas: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  ingreso_id: null,
  origen: 'IMPORTADO',
  created_at: '2026-09-09T00:00:00Z',
  ...extra,
});

const ingreso = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  folio: 12,
  categoria: 'OTRO_INGRESO',
  fecha: '2026-09-08',
  descripcion: 'Renta de hangar',
  monto,
  comision_monto: null,
  moneda: 'MXN',
  cuenta_bancaria_id: CTA,
  pagador: null,
  referencia: null,
  deleted_at: null,
  cliente: null,
  ...extra,
});

const cobro = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  vuelo_id: 'v-235',
  monto,
  moneda: 'MXN',
  metodo_cobro: 'TRANSFERENCIA',
  fecha_cobro: '2026-09-08T17:00:00Z',
  referencia: null,
  comision_banco_monto: null,
  cobro_grupo_id: null,
  ingreso_anticipo_id: null,
  vuelo: { folio: 235, cliente: { nombre: 'Cristy Chavez' } },
  ...extra,
});

function armar(
  db: Tablas,
  opts: { sinMigracion?: boolean; config?: Record<string, string> } = {},
) {
  const f = fakeSupabase(db, opts);
  const registrar = jest.fn();
  const config = opts.config ?? {};
  const svc = new ConciliacionService(
    {
      get: (k: string) => config[k] ?? '',
    } as unknown as ConstructorParameters<typeof ConciliacionService>[0],
    f.supabase,
    {} as PyservicesService,
    { registrar } as unknown as IaUsoService,
  );
  return { svc, db, log: f.log, registrar };
}

const code = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!e) throw new Error('se esperaba un error');
  const r = (e as { getResponse?: () => unknown }).getResponse?.();
  return {
    e,
    code: (r as { error?: string } | undefined)?.error,
    details: (r as { details?: Row } | undefined)?.details,
  };
};

// =====================================================================
describe('linkIngreso — abono ↔ ingreso (regla 6.3)', () => {
  it('liga, marca conciliado, limpia la clasificación y deja CONCILIAR en la bitácora', async () => {
    const { svc, db } = armar(
      mundo({
        movimiento_bancario: [abono('m1', 5000)],
        ingreso: [ingreso('i1', 5000)],
      }),
    );
    const r = await svc.linkIngreso('m1', 'i1', USER);
    expect(db.movimiento_bancario[0]).toMatchObject({
      ingreso_id: 'i1',
      conciliado: true,
      clasificacion_id: null,
    });
    expect(r.ingreso).toMatchObject({ id: 'i1', folio: 12 });
    expect(db.ingreso_bitacora).toEqual([
      expect.objectContaining({ ingreso_id: 'i1', accion: 'CONCILIAR' }),
    ]);
  });

  it('tolerancia ±1.00 y comisión: el abono es el NETO del ingreso', async () => {
    const { svc, db } = armar(
      mundo({
        movimiento_bancario: [abono('m1', 19380.5)],
        ingreso: [ingreso('i1', 20400, { comision_monto: 1020 })],
      }),
    );
    await svc.linkIngreso('m1', 'i1', USER);
    expect(db.movimiento_bancario[0].ingreso_id).toBe('i1');
  });

  it('re-ligar el MISMO ingreso es idempotente', async () => {
    const { svc, db } = armar(
      mundo({
        movimiento_bancario: [
          abono('m1', 5000, { ingreso_id: 'i1', conciliado: true }),
        ],
        ingreso: [ingreso('i1', 5000)],
      }),
    );
    await svc.linkIngreso('m1', 'i1', USER);
    expect(db.ingreso_bitacora).toHaveLength(0);
  });

  it.each<[string, Partial<Row>, Partial<Row>, string, Row?]>([
    ['un CARGO', { tipo: 'CARGO' }, {}, 'SOLO_ABONOS', undefined],
    [
      'abono con gasto',
      { gasto_id: 'g1', conciliado: true },
      {},
      'MOVIMIENTO_YA_LIGADO',
      { liga: 'GASTO' },
    ],
    [
      'abono clasificado',
      { clasificacion_id: 'cl-traspaso', conciliado: true },
      {},
      'MOVIMIENTO_YA_LIGADO',
      { liga: 'CLASIFICACION' },
    ],
    [
      'abono ligado a OTRO ingreso',
      { ingreso_id: 'i-otro', conciliado: true },
      {},
      'MOVIMIENTO_YA_LIGADO',
      { liga: 'INGRESO' },
    ],
    [
      'ingreso dado de baja',
      {},
      { deleted_at: '2026-09-10T00:00:00Z' },
      'INGRESO_DADO_DE_BAJA',
      undefined,
    ],
    [
      'ingreso en efectivo',
      {},
      { cuenta_bancaria_id: null },
      'INGRESO_SIN_CUENTA',
      undefined,
    ],
    [
      'ingreso de otra cuenta',
      {},
      { cuenta_bancaria_id: CTA_OTRA },
      'INGRESO_OTRA_CUENTA',
      { cuenta_ingreso: CTA_OTRA, cuenta_movimiento: CTA },
    ],
    [
      'ingreso en otra moneda',
      {},
      { moneda: 'USD' },
      'INGRESO_MONEDA_DISTINTA',
      undefined,
    ],
    [
      'monto que no cuadra',
      {},
      { monto: 5001.5 },
      'INGRESO_MONTO_DISTINTO',
      { monto_abono: 5000, neto_ingreso: 5001.5, diferencia: 1.5 },
    ],
  ])('%s', async (_c, mov, ing, esperado, details) => {
    const { svc, db } = armar(
      mundo({
        movimiento_bancario: [abono('m1', 5000, mov)],
        ingreso: [ingreso('i1', 5000, ing)],
      }),
    );
    const r = await code(svc.linkIngreso('m1', 'i1', USER));
    expect(r.code).toBe(esperado);
    if (details) expect(r.details).toMatchObject(details);
    expect(db.ingreso_bitacora).toHaveLength(0);
  });

  it('ingreso YA conciliado con otro abono ⇒ 409 INGRESO_YA_CONCILIADO', async () => {
    const { svc } = armar(
      mundo({
        movimiento_bancario: [
          abono('m1', 5000),
          abono('m2', 5000, {
            ingreso_id: 'i1',
            conciliado: true,
            fecha: '2026-09-07',
          }),
        ],
        ingreso: [ingreso('i1', 5000)],
      }),
    );
    const r = await code(svc.linkIngreso('m1', 'i1', USER));
    expect(r.code).toBe('INGRESO_YA_CONCILIADO');
    expect(r.details).toEqual({ movimiento_id: 'm2', fecha: '2026-09-07' });
  });

  it('ingreso inexistente ⇒ 404 INGRESO_NO_EXISTE', async () => {
    const { svc } = armar(mundo({ movimiento_bancario: [abono('m1', 5000)] }));
    const r = await code(svc.linkIngreso('m1', 'i-x', USER));
    expect(r.e).toBeInstanceOf(NotFoundException);
    expect(r.code).toBe('INGRESO_NO_EXISTE');
  });

  it('desvincular: ingreso_id null, conciliado false y DESCONCILIAR', async () => {
    const { svc, db } = armar(
      mundo({
        movimiento_bancario: [
          abono('m1', 5000, { ingreso_id: 'i1', conciliado: true }),
        ],
        ingreso: [ingreso('i1', 5000)],
      }),
    );
    await svc.linkIngreso('m1', null, USER);
    expect(db.movimiento_bancario[0]).toMatchObject({
      ingreso_id: null,
      conciliado: false,
    });
    expect(db.ingreso_bitacora[0]).toMatchObject({
      ingreso_id: 'i1',
      accion: 'DESCONCILIAR',
    });
  });

  it('CARRERA: otro ingreso tomó el abono entre la lectura y el UPDATE ⇒ 409, sin pisar la liga ajena', async () => {
    // Revisión adversaria 24-sep-2026: sin el CAS `ingreso_id is null`, dos
    // ligas simultáneas del mismo abono (auto-cruce inverso + alta manual)
    // dejaban solo la SEGUNDA y el primer ingreso desconciliado en silencio.
    const { svc, db } = armar(
      mundo({
        movimiento_bancario: [abono('m1', 5000)],
        ingreso: [ingreso('i1', 5000), ingreso('i-otro', 5000, { folio: 13 })],
      }),
    );
    const real = (
      svc as unknown as { infoCuenta: (id: string) => Promise<unknown> }
    ).infoCuenta.bind(svc);
    jest
      .spyOn(
        svc as unknown as { infoCuenta: (id: string) => Promise<unknown> },
        'infoCuenta',
      )
      .mockImplementation(async (id: string) => {
        // La OTRA petición gana justo antes de nuestro UPDATE.
        Object.assign(db.movimiento_bancario[0], {
          ingreso_id: 'i-otro',
          conciliado: true,
        });
        return real(id);
      });
    const r = await code(svc.linkIngreso('m1', 'i1', USER));
    expect(r.code).toBe('MOVIMIENTO_YA_LIGADO');
    expect(db.movimiento_bancario[0].ingreso_id).toBe('i-otro');
    expect(db.ingreso_bitacora).toHaveLength(0);
  });
});

// =====================================================================
describe('los caminos de siempre NO tocan un abono ligado a un ingreso', () => {
  const conIngreso = () =>
    mundo({
      movimiento_bancario: [
        abono('m1', 5000, { ingreso_id: 'i1', conciliado: true }),
      ],
      ingreso: [ingreso('i1', 5000)],
      cobro_vuelo: [cobro('c1', 5000)],
      gasto: [
        {
          id: 'g1',
          monto: 5000,
          moneda: 'MXN',
          conciliado: false,
          tc_gasto: null,
        },
      ],
    });

  it.each<[string, (s: ConciliacionService) => Promise<unknown>]>([
    ['link (ligar gasto)', (s) => s.link('m1', 'g1', USER)],
    ['link (desvincular)', (s) => s.link('m1', null, USER)],
    ['linkCobro (ligar)', (s) => s.linkCobro('m1', { cobro_id: 'c1' }, USER)],
    ['linkCobro (desvincular)', (s) => s.linkCobro('m1', {}, USER)],
    [
      'clasificar',
      (s) => s.clasificarMovimiento('m1', 'cl-traspaso', undefined, USER),
    ],
    [
      'des-clasificar',
      (s) => s.clasificarMovimiento('m1', null, undefined, USER),
    ],
  ])('%s ⇒ 409 MOVIMIENTO_YA_LIGADO (liga INGRESO)', async (_c, fn) => {
    const { svc, db } = armar(conIngreso());
    const r = await code(fn(svc));
    expect(r.code).toBe('MOVIMIENTO_YA_LIGADO');
    expect(r.details).toMatchObject({ liga: 'INGRESO' });
    expect(db.movimiento_bancario[0]).toMatchObject({
      ingreso_id: 'i1',
      conciliado: true,
    });
  });

  it('linkCobro con un cobro nacido de un ANTICIPO ⇒ 409 COBRO_DE_ANTICIPO', async () => {
    const { svc, db } = armar(
      mundo({
        movimiento_bancario: [abono('m1', 600)],
        ingreso: [
          ingreso('ant', 1000, { folio: 7, categoria: 'ANTICIPO_CLIENTE' }),
        ],
        cobro_vuelo: [cobro('c-ant', 600, { ingreso_anticipo_id: 'ant' })],
      }),
    );
    const r = await code(svc.linkCobro('m1', { cobro_id: 'c-ant' }, USER));
    expect(r.code).toBe('COBRO_DE_ANTICIPO');
    expect(r.details).toEqual({ ingreso_id: 'ant', etiqueta: 'ING-7' });
    expect(db.movimiento_bancario[0].cobro_id).toBeNull();
  });
});

// =====================================================================
describe('auto-cruce de abonos — UN universo (cobros, sobres, ingresos)', () => {
  const cruzar = async (db: Tablas) => {
    const w = armar(db);
    const r = await w.svc.autoMatchPendientes({ movimiento_ids: ['m1'] }, USER);
    return { r, db: w.db };
  };

  it('un solo INGRESO de la cuenta cuadra ⇒ lo liga', async () => {
    const { r, db } = await cruzar(
      mundo({
        movimiento_bancario: [abono('m1', 5000)],
        ingreso: [ingreso('i1', 5000)],
      }),
    );
    expect(r.detalle[0]).toMatchObject({
      resultado: 'CONCILIADO',
      criterio: 'MONTO_EXACTO',
      ingreso_id: 'i1',
    });
    expect(db.movimiento_bancario[0]).toMatchObject({
      ingreso_id: 'i1',
      conciliado: true,
    });
  });

  it('un ingreso de OTRA cuenta no entra al auto', async () => {
    const { r } = await cruzar(
      mundo({
        movimiento_bancario: [abono('m1', 5000)],
        ingreso: [ingreso('i1', 5000, { cuenta_bancaria_id: CTA_OTRA })],
      }),
    );
    expect(r.detalle[0].resultado).toBe('SIN_CANDIDATO');
  });

  it('cobro + ingreso del mismo monto ⇒ AMBIGUO (no liga)', async () => {
    const { r, db } = await cruzar(
      mundo({
        movimiento_bancario: [abono('m1', 5000)],
        ingreso: [ingreso('i1', 5000)],
        cobro_vuelo: [cobro('c1', 5000)],
      }),
    );
    expect(r.detalle[0]).toMatchObject({
      resultado: 'AMBIGUO',
      candidatos_n: 2,
    });
    expect(db.movimiento_bancario[0].conciliado).toBe(false);
  });

  it('2 cobros iguales: el NOMBRE del ordenante desempata (DESCRIPCION)', async () => {
    const { r, db } = await cruzar(
      mundo({
        movimiento_bancario: [
          abono('m1', 95000, { descripcion: 'LETICIA LEON ALVARADO : PAGO' }),
        ],
        cobro_vuelo: [
          cobro('c-leticia', 95000, {
            vuelo: { folio: 301, cliente: { nombre: 'Leticia León Alvarado' } },
          }),
          cobro('c-otro', 95000, {
            vuelo: { folio: 302, cliente: { nombre: 'Leticia Pérez' } },
          }),
        ],
      }),
    );
    expect(r.detalle[0]).toMatchObject({
      resultado: 'CONCILIADO',
      criterio: 'DESCRIPCION',
      cobro_id: 'c-leticia',
    });
    expect(db.movimiento_bancario[0].cobro_id).toBe('c-leticia');
  });

  it('un cobro nacido de un ANTICIPO nunca es candidato', async () => {
    const { r, db } = await cruzar(
      mundo({
        movimiento_bancario: [abono('m1', 600)],
        cobro_vuelo: [cobro('c-ant', 600, { ingreso_anticipo_id: 'ant' })],
      }),
    );
    expect(r.detalle[0].resultado).toBe('SIN_CANDIDATO');
    expect(db.movimiento_bancario[0].cobro_id).toBeNull();
  });

  it('pasarela SIN cobro Paywise: prueba los ingresos de ESA cuenta (neto o bruto)', async () => {
    const { r, db } = await cruzar(
      mundo({
        movimiento_bancario: [
          abono('m1', 911.43, {
            cuenta_bancaria_id: CTA_PW,
            monto_bruto: 1000,
            comision_monto: 88.57,
          }),
        ],
        ingreso: [
          ingreso('i-pw', 1000, {
            cuenta_bancaria_id: CTA_PW,
            comision_monto: 88.57,
            categoria: 'ANTICIPO_CLIENTE',
          }),
        ],
      }),
    );
    expect(r.detalle[0]).toMatchObject({
      resultado: 'CONCILIADO',
      ingreso_id: 'i-pw',
    });
    expect(db.movimiento_bancario[0].ingreso_id).toBe('i-pw');
  });

  // Revisión adversaria 24-sep-2026 — ANTI DOBLE CONTEO del auto-cruce: el
  // auto jamás liga un abono a un INGRESO si un cobro de vuelo LIBRE
  // (métodos manuales, ±30 días) cuadra EXACTO (espejo automático de
  // ABONO_TIENE_COBRO_CANDIDATO).
  it('#235 en la cuenta PASARELA: «otro ingreso» de 19,380 + cobro TRANSFERENCIA 20,400 − 1,020 ⇒ AMBIGUO (no liga el ingreso)', async () => {
    const { r, db } = await cruzar(
      mundo({
        movimiento_bancario: [
          abono('m1', 19380, {
            cuenta_bancaria_id: CTA_PW,
            descripcion: 'MARIA CRISTINA CHAVEZ BADIOLA : vuelo cristy badiola',
          }),
        ],
        ingreso: [ingreso('i1', 19380, { cuenta_bancaria_id: CTA_PW })],
        cobro_vuelo: [cobro('c-235', 20400, { comision_banco_monto: 1020 })],
      }),
    );
    expect(r.detalle[0]).toMatchObject({
      resultado: 'AMBIGUO',
      candidatos_n: 2,
    });
    expect(db.movimiento_bancario[0]).toMatchObject({
      ingreso_id: null,
      cobro_id: null,
      conciliado: false,
    });
  });

  it('cuenta BANCO: un cobro TRANSFERENCIA exacto FUERA de la ventana del auto (10 días antes) también detiene la liga al ingreso', async () => {
    const { r, db } = await cruzar(
      mundo({
        movimiento_bancario: [abono('m1', 5000)],
        ingreso: [ingreso('i1', 5000)],
        cobro_vuelo: [
          cobro('c-antes', 5000, { fecha_cobro: '2026-08-29T17:00:00Z' }),
        ],
      }),
    );
    expect(r.detalle[0].resultado).toBe('AMBIGUO');
    expect(db.movimiento_bancario[0].ingreso_id).toBeNull();
  });

  it('un cobro exacto YA ligado a otro abono no detiene la liga al ingreso', async () => {
    const { r, db } = await cruzar(
      mundo({
        movimiento_bancario: [
          abono('m1', 5000),
          abono('m-otro', 5000, {
            cobro_id: 'c-antes',
            conciliado: true,
            fecha: '2026-08-29',
          }),
        ],
        ingreso: [ingreso('i1', 5000)],
        cobro_vuelo: [
          cobro('c-antes', 5000, { fecha_cobro: '2026-08-29T17:00:00Z' }),
        ],
      }),
    );
    expect(r.detalle[0]).toMatchObject({
      resultado: 'CONCILIADO',
      ingreso_id: 'i1',
    });
    expect(db.movimiento_bancario[0].ingreso_id).toBe('i1');
  });

  it('intentarCruzarIngreso: el ingreso capturado DESPUÉS liga su abono pendiente', async () => {
    const { svc, db } = armar(
      mundo({
        movimiento_bancario: [abono('m1', 5000)],
        ingreso: [ingreso('i1', 5000)],
      }),
    );
    const r = await svc.intentarCruzarIngreso('i1', USER);
    expect(r).toMatchObject({ ligado: true, movimiento_id: 'm1' });
    expect(db.movimiento_bancario[0].ingreso_id).toBe('i1');
  });

  it('intentarCruzarIngreso NUNCA lanza (sin migración ⇒ motivo)', async () => {
    const { svc } = armar(mundo(), { sinMigracion: true });
    await expect(svc.intentarCruzarIngreso('i1', USER)).resolves.toMatchObject({
      ligado: false,
    });
  });
});

// =====================================================================
describe('candidatos, Paywise y «cobros sin banco» con anticipos', () => {
  it('candidatosCobro: excluye cobros de anticipo y ofrece los ingresos (otra_cuenta marcada)', async () => {
    const { svc } = armar(
      mundo({
        movimiento_bancario: [abono('m1', 5000)],
        cobro_vuelo: [
          cobro('c-normal', 5000),
          cobro('c-ant', 5000, { ingreso_anticipo_id: 'ant' }),
        ],
        ingreso: [
          ingreso('i1', 5000),
          ingreso('i2', 5000, { folio: 13, cuenta_bancaria_id: CTA_OTRA }),
          ingreso('i3', 5000, {
            folio: 14,
            moneda: 'USD',
            cuenta_bancaria_id: CTA_USD,
          }),
        ],
      }),
    );
    const r = await svc.candidatosCobro('m1', 30);
    expect(r.candidatos.map((c) => c.id)).toEqual(['c-normal']);
    expect(r.ingresos?.map((i) => [i.id, i.otra_cuenta, i.dif_monto])).toEqual([
      ['i1', false, 0],
      ['i2', true, 0],
    ]);
  });

  it('cobrosSinBanco INCLUYE el cobro de un anticipo SIN conciliar (marcado) y lo EXCLUYE al conciliarse el anticipo', async () => {
    const base = () =>
      mundo({
        ingreso: [
          ingreso('ant', 1000, {
            folio: 7,
            categoria: 'ANTICIPO_CLIENTE',
            cliente: { nombre: 'Cristy Chavez' },
          }),
        ],
        cobro_vuelo: [
          cobro('c-ant', 600, {
            ingreso_anticipo_id: 'ant',
            fecha_cobro: '2026-09-08T17:00:00Z',
          }),
          cobro('c-normal', 400, { fecha_cobro: '2026-09-08T17:00:00Z' }),
        ],
      });
    const sin = armar(base());
    const r1 = await sin.svc.cobrosSinBanco('2026-09-01', '2026-09-30');
    expect(r1.data.map((c) => [c.id, (c as Row).anticipo])).toEqual([
      ['c-ant', { ingreso_id: 'ant', etiqueta: 'ING-7' }],
      ['c-normal', null],
    ]);
    const db = base();
    db.movimiento_bancario = [
      abono('m-ant', 1000, { ingreso_id: 'ant', conciliado: true }),
    ];
    const r2 = await armar(db).svc.cobrosSinBanco('2026-09-01', '2026-09-30');
    expect(r2.data.map((c) => c.id)).toEqual(['c-normal']);
  });

  it('Paywise: excluye cobros de anticipo y abonos ligados a un ingreso (contados aparte)', async () => {
    const { svc } = armar(
      mundo({
        movimiento_bancario: [
          abono('pw-1', 911.43, {
            cuenta_bancaria_id: CTA_PW,
            monto_bruto: 1000,
            comision_monto: 88.57,
          }),
          abono('pw-2', 19380, {
            cuenta_bancaria_id: CTA_PW,
            ingreso_id: 'i-spei',
            conciliado: true,
          }),
        ],
        cobro_vuelo: [
          cobro('c-pw-ant', 1000, {
            metodo_cobro: 'PAYWISE',
            comision_banco_monto: 88.57,
            ingreso_anticipo_id: 'ant',
          }),
        ],
      }),
    );
    const a = await svc.auditoriaPaywise({
      desde: '2026-09-01',
      hasta: '2026-09-30',
      dias: 5,
    });
    expect(a.resumen.movimientos_paywise).toBe(1);
    expect(a.resumen.cobros_sistema).toBe(0);
    expect((a.resumen as Row).movimientos_con_ingreso).toBe(1);
  });
});

// =====================================================================
describe('abonosPendientes — «Por conciliar»', () => {
  /** Caso REAL #235: SPEI directo a la CLABE de la cuenta Paywise. */
  const caso235 = () =>
    mundo({
      movimiento_bancario: [
        abono('m-cristy', 19380, {
          cuenta_bancaria_id: CTA_PW,
          descripcion: 'MARIA CRISTINA CHAVEZ BADIOLA : vuelo cristy badiola',
        }),
      ],
      cobro_vuelo: [cobro('c-235', 20400, { comision_banco_monto: 1020 })],
    });

  it('#235: el auto no lo ve (SIN_CANDIDATOS) pero hay 1 cobro con el monto exacto y el cliente sugerido', async () => {
    const { svc } = armar(caso235());
    const r = await svc.abonosPendientes({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    expect(r.motivos_calculados).toBe(true);
    expect(r.data[0]).toMatchObject({
      id: 'm-cristy',
      cuenta_tipo: 'PASARELA',
      motivo_pendiente: 'SIN_CANDIDATOS',
      exactos_manual: 1,
      cliente_sugerido: { id: 'k-cristy', nombre: 'Cristy Chavez' },
      categoria_sugerida: null,
      posible_duplicado_de: null,
      patron: null,
    });
    expect(r.por_moneda).toEqual([{ moneda: 'MXN', n: 1, monto: 19380 }]);
  });

  it('#235 con un «otro ingreso» de 19,380 en la cuenta: el motivo dice AMBIGUO (el auto NO lo liga), nunca SE_PUEDE_CRUZAR', async () => {
    const db = caso235();
    db.ingreso = [ingreso('i-19380', 19380, { cuenta_bancaria_id: CTA_PW })];
    const { svc } = armar(db);
    const r = await svc.abonosPendientes({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    expect(r.data[0]).toMatchObject({
      id: 'm-cristy',
      motivo_pendiente: 'AMBIGUO',
      candidatos_n: 2,
      exactos_manual: 2,
    });
  });

  it('patrones, duplicados y SE_PUEDE_CRUZAR', async () => {
    const { svc } = armar(
      mundo({
        movimiento_bancario: [
          abono('m-trasp', 1000, { descripcion: 'SEL TRASPASO ENTRE CUENTAS' }),
          abono('m-rev', 250, { descripcion: 'Rev ASUR Merida' }),
          abono('m-dup', 36456.58, {
            fecha: '2026-09-03',
            referencia: '00000000006247178602',
          }),
          abono('m-dup-ok', 36456.58, {
            fecha: '2026-09-03',
            referencia: '000125473315',
            conciliado: true,
            clasificacion_id: 'cl-traspaso',
          }),
          abono('m-cruza', 777, {}),
          abono('m-reemb', 21223.1, {
            descripcion: 'Rembolso Gastos Medicos Dani',
          }),
        ],
        cobro_vuelo: [cobro('c-777', 777)],
      }),
    );
    const r = await svc.abonosPendientes({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    const por = new Map(r.data.map((a) => [a.id, a]));
    expect(por.get('m-trasp')).toMatchObject({ patron: 'TRASPASO' });
    expect(por.get('m-rev')).toMatchObject({ patron: 'REVERSO' });
    expect(por.get('m-dup')?.posible_duplicado_de).toMatchObject({
      id: 'm-dup-ok',
      conciliado: true,
    });
    expect(por.get('m-cruza')).toMatchObject({
      motivo_pendiente: 'SE_PUEDE_CRUZAR',
      candidatos_n: 1,
    });
    expect(por.get('m-reemb')?.categoria_sugerida).toBe('REEMBOLSO_DEVOLUCION');
    expect(r.data).toHaveLength(5); // la conciliada no es pendiente
  });

  it('una lectura de candidatos que llega al TOPE (páginas de 1000) ⇒ motivos_calculados=false y motivos null', async () => {
    const muchos = Array.from({ length: 3000 }, (_, i) =>
      cobro(`c-${i}`, 100 + i, { vuelo: { folio: i, cliente: null } }),
    );
    const { svc } = armar(
      mundo({
        movimiento_bancario: [abono('m1', 5000)],
        cobro_vuelo: muchos,
      }),
    );
    const r = await svc.abonosPendientes({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    expect(r.motivos_calculados).toBe(false);
    expect(r.data[0]).toMatchObject({
      motivo_pendiente: null,
      candidatos_n: null,
      exactos_manual: null,
    });
  });
});

// =====================================================================
describe('sugerirAbonos — la IA PROPONE y jamás liga', () => {
  const CONFIG = {
    PYSERVICES_BASE_URL: 'http://py.test',
    INTERNAL_SHARED_TOKEN: 'tok',
  };
  let fetchMock: jest.SpyInstance;
  afterEach(() => fetchMock?.mockRestore());

  const respuesta = (cuerpo: unknown, status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(cuerpo),
    }) as unknown as Response;

  it('traspasos, reversos, duplicados y lo que el auto cruza salen por REGLA (sin llamar a la IA)', async () => {
    fetchMock = jest.spyOn(global, 'fetch');
    const { svc, db } = armar(
      mundo({
        movimiento_bancario: [
          abono('m-trasp', 1000, { descripcion: 'SEL TRASPASO ENTRE CUENTAS' }),
          abono('m-rev', 250, { descripcion: 'REV.ASUR MERIDA' }),
          abono('m-dup', 500, { fecha: '2026-09-03' }),
          abono('m-dup-ok', 500, {
            fecha: '2026-09-03',
            conciliado: true,
            clasificacion_id: 'cl-traspaso',
          }),
          abono('m-cruza', 777),
        ],
        cobro_vuelo: [cobro('c-777', 777)],
      }),
      { config: CONFIG },
    );
    const r = await svc.sugerirAbonos(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const por = new Map(r.propuestas.map((p) => [p.movimiento_id, p]));
    expect(por.get('m-trasp')).toMatchObject({
      origen: 'REGLA',
      accion: 'CLASIFICAR_TRASPASO',
      confianza: 0.95,
    });
    expect(por.get('m-rev')).toMatchObject({
      origen: 'REGLA',
      accion: 'CLASIFICAR_REVERSO',
    });
    expect(por.get('m-dup')).toMatchObject({
      origen: 'REGLA',
      accion: 'REVISAR',
      posible_duplicado: true,
    });
    expect(por.get('m-cruza')).toMatchObject({
      origen: 'REGLA',
      accion: 'REVISAR',
    });
    expect(por.get('m-cruza')?.razon).toMatch(/Cruzar pendientes/);
    // Nada se ligó.
    expect(db.movimiento_bancario.filter((m) => m.conciliado)).toHaveLength(1);
  });

  it('valida lo que dice la IA: ids ajenos, duplicados entre abonos, REGISTRAR_INGRESO con cobro exacto ⇒ LIGAR', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((_u, init) => {
      const body = JSON.parse(String(init?.body as string)) as {
        abonos: Array<{ id: string; candidato_ids: string[] }>;
      };
      const ids = new Map(body.abonos.map((a) => [a.id, a.candidato_ids]));
      return Promise.resolve(
        respuesta({
          modelo: 'claude',
          uso_ia: { input_tokens: 100, output_tokens: 50, modelo: 'claude' },
          sugerencias: [
            // Inventa un id ⇒ se descarta.
            {
              movimiento_id: 'm-a',
              candidato_id: 'COBRO_VUELO:inventado',
              accion: 'LIGAR',
              confianza: 0.9,
            },
            // Dos abonos proponen el MISMO cobro: gana el de más confianza.
            {
              movimiento_id: 'm-b',
              candidato_id: ids.get('m-b')?.find((x) => x.includes('c-dup')),
              accion: 'LIGAR',
              confianza: 0.95,
              razon: 'monto y nombre',
            },
            {
              movimiento_id: 'm-c',
              candidato_id: ids.get('m-c')?.find((x) => x.includes('c-dup')),
              accion: 'LIGAR',
              confianza: 0.6,
            },
            // Quiere registrar como otro ingreso dinero que YA tiene un cobro exacto.
            {
              movimiento_id: 'm-d',
              candidato_id: null,
              accion: 'REGISTRAR_INGRESO',
              confianza: 0.9,
              categoria_sugerida: 'OTRO_INGRESO',
            },
            {
              movimiento_id: 'm-e',
              candidato_id: null,
              accion: 'REGISTRAR_INGRESO',
              confianza: 0.8,
              categoria_sugerida: 'NO_EXISTE',
            },
          ],
        }),
      );
    });
    const { svc, registrar } = armar(
      mundo({
        movimiento_bancario: [
          abono('m-a', 111.11),
          abono('m-b', 1200, { descripcion: 'LETICIA LEON ALVARADO : PAGO' }),
          abono('m-c', 1199.5),
          abono('m-d', 3333),
          abono('m-e', 21223.1, {
            descripcion: 'Rembolso Gastos Medicos Dani',
          }),
        ],
        cobro_vuelo: [
          cobro('c-dup', 1200, {
            metodo_cobro: 'BILLPOCKET',
            vuelo: { folio: 400, cliente: { nombre: 'Leticia León Alvarado' } },
          }),
          cobro('c-d', 3333, {
            metodo_cobro: 'BILLPOCKET',
            vuelo: { folio: 401, cliente: null },
          }),
        ],
      }),
      { config: CONFIG },
    );
    const r = await svc.sugerirAbonos(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    const por = new Map(r.propuestas.map((p) => [p.movimiento_id, p]));
    expect(por.get('m-a')).toMatchObject({
      accion: 'REVISAR',
      candidato: null,
    });
    expect(por.get('m-b')).toMatchObject({
      accion: 'LIGAR',
      monto_exacto: true,
      confianza: 0.95,
      candidato: expect.objectContaining({
        id: 'c-dup',
        etiqueta: 'Cobro · vuelo #400',
      }) as unknown,
    });
    expect(por.get('m-c')).toMatchObject({
      accion: 'REVISAR',
      candidato: null,
      motivo_sin_match:
        'Ese candidato se propuso para otro abono con más confianza',
    });
    expect(por.get('m-d')).toMatchObject({
      accion: 'LIGAR',
      candidato: expect.objectContaining({ id: 'c-d' }) as unknown,
      razon: 'Hay un cobro de vuelo con el monto exacto',
      monto_exacto: true,
    });
    expect(por.get('m-d')!.confianza).toBeLessThanOrEqual(0.7);
    expect(por.get('m-e')).toMatchObject({
      accion: 'REGISTRAR_INGRESO',
      categoria_sugerida: 'REEMBOLSO_DEVOLUCION',
    });
    expect(r).toMatchObject({
      revisados: 5,
      con_propuesta: 2,
      disponible: true,
      nota: null,
    });
    expect(registrar).toHaveBeenCalledWith(
      'CONCILIACION_ABONOS_SUGERIR',
      expect.objectContaining({ input_tokens: 100 }),
      expect.objectContaining({ usuarioId: USER }),
    );
  });

  it('LIGAR a un INGRESO habiendo un cobro de vuelo EXACTO ⇒ REVISAR sin candidato (y el abono sí va a la IA: el auto ya no lo cruza)', async () => {
    // Revisión adversaria 24-sep-2026: ingreso de 4,000 y cobro BILLPOCKET de
    // 4,000 libres. Antes el auto lo daba por «Se puede cruzar» (no iba a la
    // IA) y una LIGAR al ingreso con 0.95 salía PRESELECCIONADA.
    let enviados: string[] = [];
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((_u, init) => {
      const body = JSON.parse(String(init?.body as string)) as {
        abonos: Array<{ id: string; candidato_ids: string[] }>;
      };
      enviados = body.abonos.map((a) => a.id);
      const ing = body.abonos[0]?.candidato_ids.find((x) =>
        x.startsWith('INGRESO:'),
      );
      return Promise.resolve(
        respuesta({
          modelo: 'claude',
          sugerencias: [
            {
              movimiento_id: 'm-f',
              candidato_id: ing,
              accion: 'LIGAR',
              confianza: 0.95,
              razon: 'monto exacto',
            },
          ],
        }),
      );
    });
    const { svc } = armar(
      mundo({
        movimiento_bancario: [abono('m-f', 4000)],
        ingreso: [ingreso('i-f', 4000)],
        cobro_vuelo: [cobro('c-f', 4000, { metodo_cobro: 'BILLPOCKET' })],
      }),
      { config: CONFIG },
    );
    const r = await svc.sugerirAbonos(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(enviados).toEqual(['m-f']);
    expect(r.propuestas[0]).toMatchObject({
      movimiento_id: 'm-f',
      origen: 'IA',
      accion: 'REVISAR',
      candidato: null,
      monto_exacto: false,
      confianza: 0,
    });
    expect(r.propuestas[0].motivo_sin_match).toMatch(/cobro de vuelo/);
  });

  it('≤ 3 llamadas EN PARALELO de ≤ 10 abonos; un lote caído no apaga los otros', async () => {
    let enVuelo = 0;
    let maxEnVuelo = 0;
    const tamanos: number[] = [];
    let llamada = 0;
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (_u, init) => {
        const body = JSON.parse(String(init?.body as string)) as {
          abonos: unknown[];
        };
        tamanos.push(body.abonos.length);
        llamada += 1;
        const yo = llamada;
        enVuelo += 1;
        maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
        await new Promise((r) => setTimeout(r, 5));
        enVuelo -= 1;
        if (yo === 2) {
          return respuesta(
            {
              detail: {
                code: 'IA_RESPUESTA_TRUNCADA',
                uso_ia: { input_tokens: 9 },
              },
            },
            502,
          );
        }
        return respuesta({ modelo: 'claude', uso_ia: null, sugerencias: [] });
      });
    const movs = Array.from({ length: 30 }, (_, i) =>
      abono(`m-${String(i).padStart(2, '0')}`, 1000 + i, {
        fecha: '2026-09-08',
      }),
    );
    const { svc, registrar } = armar(mundo({ movimiento_bancario: movs }), {
      config: CONFIG,
    });
    const r = await svc.sugerirAbonos(
      { desde: '2026-09-01', hasta: '2026-09-30', limite: 30 },
      USER,
    );
    expect(tamanos.sort((a, b) => a - b)).toEqual([10, 10, 10]);
    expect(maxEnVuelo).toBe(3);
    expect(r.disponible).toBe(true);
    const caidos = r.propuestas.filter(
      (p) => p.motivo_sin_match === 'El asistente no respondió para este abono',
    );
    expect(caidos.length).toBeGreaterThanOrEqual(10);
    // El 502 truncado TAMBIÉN registra consumo (los créditos se gastaron).
    expect(registrar).toHaveBeenCalledWith(
      'CONCILIACION_ABONOS_SUGERIR',
      expect.objectContaining({ input_tokens: 9 }),
      expect.anything(),
    );
  });

  it('se preguntó y NADIE contestó ⇒ disponible=false con nota (nunca «no encontró nada»)', async () => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const { svc } = armar(mundo({ movimiento_bancario: [abono('m1', 1234)] }), {
      config: CONFIG,
    });
    const r = await svc.sugerirAbonos(
      { desde: '2026-09-01', hasta: '2026-09-30' },
      USER,
    );
    expect(r.disponible).toBe(false);
    expect(r.nota).toMatch(/ECONNREFUSED/);
    expect(r.propuestas[0]).toMatchObject({ accion: 'REVISAR' });
  });
});

// =====================================================================
describe('SIN la migración (sonda false): todo como hoy', () => {
  const sinMig = () =>
    armar(
      mundo({
        movimiento_bancario: [
          abono('m1', 5000),
          abono('m2', 400, { tipo: 'CARGO' }),
        ],
        cobro_vuelo: [cobro('c1', 5000)],
        gasto: [
          {
            id: 'g1',
            monto: 400,
            moneda: 'MXN',
            conciliado: false,
            tc_gasto: null,
          },
        ],
      }),
      { sinMigracion: true },
    );
  /** Ninguna consulta nombra lo nuevo (salvo la sonda, que es la que falla). */
  const limpio = (log: Array<{ tabla: string; sel: string; ops: string[] }>) =>
    log.filter(
      (q) =>
        q.tabla === 'ingreso' ||
        q.tabla === 'ingreso_bitacora' ||
        q.ops.some((o) => /ingreso/.test(o)) ||
        (/ingreso/.test(q.sel) && q.sel !== 'ingreso_id'),
    );

  it('list, link, linkCobro, candidatosCobro, cobrosSinBanco, auto-cruce y Paywise responden sin tocar lo nuevo', async () => {
    const w = sinMig();
    const lista = await w.svc.list({ limit: 100, offset: 0 });
    expect(lista.data).toHaveLength(2);
    expect(lista.data[0]).not.toHaveProperty('ingreso');
    const cands = await w.svc.candidatosCobro('m1', 30);
    expect(cands.candidatos.map((c) => c.id)).toEqual(['c1']);
    expect(cands).not.toHaveProperty('ingresos');
    const csb = await w.svc.cobrosSinBanco('2026-09-01', '2026-09-30');
    expect(csb.data.map((c) => c.id)).toEqual(['c1']);
    expect(csb.data[0]).not.toHaveProperty('anticipo');
    const auto = await w.svc.autoMatchPendientes(
      { movimiento_ids: ['m1'] },
      USER,
    );
    expect(auto.detalle[0]).toMatchObject({
      resultado: 'CONCILIADO',
      cobro_id: 'c1',
    });
    await w.svc.linkCobro('m1', {}, USER);
    await w.svc.link('m2', 'g1', USER);
    const pw = await w.svc
      .auditoriaPaywise({ desde: '2026-09-01', hasta: '2026-09-30', dias: 5 })
      .catch((e: unknown) => e);
    // Sin cuenta PASARELA con abonos en este mundo: la auditoría responde igual que hoy.
    expect(pw).not.toBeInstanceOf(ServiceUnavailableException);
    expect(limpio(w.log)).toEqual([]);
  });

  it('las rutas nuevas responden 503 INGRESOS_NO_DISPONIBLE', async () => {
    const w = sinMig();
    for (const p of [
      w.svc.linkIngreso('m1', 'i1', USER),
      w.svc.abonosPendientes({}),
      w.svc.sugerirAbonos({}, USER),
    ]) {
      const r = await code(p);
      expect(r.e).toBeInstanceOf(ServiceUnavailableException);
      expect(r.code).toBe('INGRESOS_NO_DISPONIBLE');
    }
  });
});

// Evita el aviso de import sin usar si algún día se reordenan los casos.
void BadRequestException;
void ConflictException;
