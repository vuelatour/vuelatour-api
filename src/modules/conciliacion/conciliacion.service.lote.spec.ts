import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  type Logger,
} from '@nestjs/common';
import { ConciliacionService } from './conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import {
  errorBd,
  rpcPartes,
  sembrarPartes,
  TABLA_PARTES,
  VISTA_CONCILIACION,
  type OpcionesRpc,
  ErrorBd,
} from './conciliacion-partes.fixture-spec';
import {
  MENSAJE_CARGO_CAMBIO,
  mensajeErrorPartes,
  mensajeLoteInvalido,
  mensajeMovimientoConGastos,
} from './conciliacion-parcial.util';
import { MENSAJE_SIN_MONEDA_CUENTA } from './gastos-candidatos.util';

/**
 * 1 CARGO DEL BANCO ↔ N GASTOS («lote», 2-oct-2026, API 0.0.52, migración
 * 20261002000002). Caso REAL de prod: 29 «Pago VIP SAESA» capturados por
 * Jimmy Chi el 30-sep y los SPEI del 24-sep de GASTOS GNRAL — 8,404.20 =
 * 3 × 2,801.40 (#315, #319, #326), 4,462.75 = 2,231.37 + 2,231.38 (o 2 ×
 * 2,231.37 + 0.01: SAESA factura 2,231.375) y 2,236.25 = 2 × 1,118.12 +
 * 0.01. Se congela:
 * - la liga del lote por la RPC (puente, espejo `gasto_id` null,
 *   `gastos_n`, gastos cubiertos que escribe la BD) y la respuesta
 *   `gastos_estado`;
 * - los 409 con su texto y `details` (CARGO_NO_CUADRA, LOTE_MONEDA_DISTINTA,
 *   GASTO_YA_CUBIERTO con `gasto_id`, MOVIMIENTO_CON_LOTE) ANTES de escribir
 *   y la traducción del error de la BD (hint + detail JSON) y del 503;
 * - desligar el lote; el reemplazo [A] → [A, B]; la re-liga idéntica;
 * - lectores: lista (`gastos[]`, `gastos_suma`, `gastos_diferencia`),
 *   resumen (`diferencia_lotes`), Excel («Conciliado con» y «Matrícula»),
 *   gastos sin banco con la PARTE (no el |monto| del SPEI);
 * - `GET …/gastos-candidatos` (búsqueda, orden, truncado, 400/404/503);
 * - SIN la migración: 503 en lo nuevo y NINGUNA consulta nombra `gastos_n`,
 *   la puente ni la vista (salvo la sonda).
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const CTA = 'cta-gastos';
const CTA_USD = 'cta-usd';
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
  if (typeof b === 'number') return Number(a) - b;
  const sa = txt(a);
  const sb = txt(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

/** Parte una lista PostgREST por comas de nivel 0. */
function partirNivel0(s: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of s) {
    if (ch === '(') nivel += 1;
    if (ch === ')') nivel -= 1;
    if (ch === ',' && nivel === 0) {
      out.push(actual.trim());
      actual = '';
      continue;
    }
    actual += ch;
  }
  if (actual.trim()) out.push(actual.trim());
  return out;
}

/** Comodín `*x*` / `%x%` de ilike ⇒ «contiene» (sin distinguir mayúsculas). */
const contiene = (valor: unknown, patron: string) => {
  const p = patron.replace(/^[*%]|[*%]$/g, '').toLowerCase();
  return txt(valor).toLowerCase().includes(p);
};

interface OpcionesFake {
  /** Migración 20261002000002 SIN aplicar. */
  sinPartes?: boolean;
  rpc?: OpcionesRpc;
  /** Tablas cuya lectura falla (lectura best-effort de la lista). */
  fallaLectura?: string[];
  /** Tope de filas por respuesta, como `max-rows` de PostgREST (sin aviso). */
  maxFilas?: number;
  /** UPDATE que la BD rechaza (trigger / constraint diferido). */
  falloUpdate?: { tabla: string; error: Row | ErrorBd };
  /** Migración 20261005000002 SIN aplicar (`factura_recibida.serie`). */
  sinSerieFolio?: boolean;
}

/** Mini-PostgREST en memoria: filtros, `or`, embeds, orden, RPC y bitácora. */
function fakeSupabase(db: Tablas, opts: OpcionesFake = {}) {
  const log: Array<{ tabla: string; texto: string }> = [];
  const embeber = (fila: Row, sel: string): Row => {
    const out: Row = { ...fila };
    for (const campo of partirNivel0(sel)) {
      // Ruta JSON `alias:columna->>llave` (5-oct-2026: `ia_folio`).
      const j = /^(\w+):(\w+)->>(\w+)$/.exec(campo);
      if (j) {
        const [, alias, col, llave] = j;
        const doc = fila[col] as Row | null | undefined;
        const v = doc && typeof doc === 'object' ? doc[llave] : null;
        out[alias] = v == null ? null : txt(v);
        continue;
      }
      const m = /^(\w+):([\w]+)(?:!(\w+))?\((.*)\)$/s.exec(campo);
      if (!m) continue;
      const [, alias, origen, fk, interior] = m;
      let tabla = origen;
      let col = fk ?? `${origen}_id`;
      if (origen.endsWith('_id') && !fk) {
        tabla = origen.slice(0, -3);
        col = origen;
      }
      const id = fila[col];
      const rel = (db[tabla] ?? []).find((r) => r.id === id) ?? null;
      out[alias] = rel ? embeber(rel, interior) : null;
    }
    return out;
  };
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let patch: Row = {};
      let sel = '';
      let head = false;
      let limite: number | null = null;
      let rango: [number, number] | null = null;
      const orden: Array<[string, boolean]> = [];
      const entrada = { tabla, texto: '' };
      log.push(entrada);
      const marcar = (t: string) => {
        entrada.texto += ` ${t}`;
      };
      const ejecutar = (unico: boolean) => {
        if (opts.fallaLectura?.includes(tabla)) {
          return { data: null, error: { message: 'caída' }, count: null };
        }
        if (
          opts.sinPartes &&
          (tabla === TABLA_PARTES || tabla === VISTA_CONCILIACION)
        ) {
          return {
            data: null,
            error: {
              code: '42P01',
              message: `relation ${tabla} does not exist`,
            },
            count: null,
          };
        }
        if (
          opts.sinSerieFolio &&
          ((tabla === 'factura_recibida' && /\bserie\b/.test(entrada.texto)) ||
            /factura_recibida_id\([^)]*\bserie\b/.test(entrada.texto))
        ) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column factura_recibida.serie does not exist',
            },
            count: null,
          };
        }
        if (opts.sinPartes && /gastos_n/.test(entrada.texto)) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column movimiento_bancario.gastos_n does not exist',
            },
            count: null,
          };
        }
        if (op === 'update' && opts.falloUpdate?.tabla === tabla) {
          return { data: null, error: opts.falloUpdate.error, count: null };
        }
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        if (op === 'update') filas.forEach((r) => Object.assign(r, patch));
        let out = filas.map((r) => embeber(r, sel));
        for (const [col, asc] of [...orden].reverse()) {
          out.sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
        }
        const total = out.length;
        if (rango) out = out.slice(rango[0], rango[1] + 1);
        if (limite != null) out = out.slice(0, limite);
        if (opts.maxFilas != null) out = out.slice(0, opts.maxFilas);
        if (head) return { data: null, error: null, count: total };
        return {
          data: unico ? (out[0] ?? null) : out,
          error: null,
          count: total,
        };
      };
      const cumple = (r: Row, cond: string): boolean => {
        const m = /^([^.]+)\.([a-z]+)\.(.*)$/s.exec(cond);
        if (!m) return false;
        const [, col, o, raw] = m;
        if (o === 'ilike') return contiene(r[col], raw);
        if (o === 'eq') return txt(r[col]) === raw;
        if (o === 'in') {
          return raw
            .replace(/^\(|\)$/g, '')
            .split(',')
            .includes(txt(r[col]));
        }
        return false;
      };
      const api: Record<string, unknown> = {
        select(s?: string, o?: { count?: string; head?: boolean }) {
          sel = s ?? '';
          head = o?.head === true;
          marcar(`select(${sel})`);
          return api;
        },
        update(p: Row) {
          op = 'update';
          patch = p;
          marcar(`update(${Object.keys(p).join(',')})`);
          return api;
        },
        eq(col: string, val: unknown) {
          marcar(`eq:${col}`);
          filtros.push((r) => r[col] === val);
          return api;
        },
        neq(col: string, val: unknown) {
          marcar(`neq:${col}`);
          filtros.push((r) => r[col] !== val);
          return api;
        },
        is(col: string, val: unknown) {
          marcar(`is:${col}`);
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          marcar(`in:${col}`);
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        ilike(col: string, val: string) {
          marcar(`ilike:${col}`);
          filtros.push((r) => contiene(r[col], val));
          return api;
        },
        or(cond: string) {
          marcar(`or:${cond}`);
          const partes = partirNivel0(cond);
          filtros.push((r) => partes.some((c) => cumple(r, c)));
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
        not: () => api,
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
        abortSignal: () => api,
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        single: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
    rpc(nombre: string, args: Row) {
      log.push({ tabla: `rpc:${nombre}`, texto: JSON.stringify(args) });
      if (opts.sinPartes) {
        return Promise.resolve({
          data: null,
          error: {
            code: 'PGRST202',
            message: `Could not find the function public.${nombre}`,
          },
        });
      }
      return Promise.resolve(rpcPartes(db, nombre, args, opts.rpc));
    },
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

// ------------------------------- mundo --------------------------------

const cargo = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-24',
  tipo: 'CARGO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion: 'SPEI ENVIADO SAESA',
  referencia: null,
  notas: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  ingreso_id: null,
  reverso_de_id: null,
  origen: 'IMPORTADO',
  created_at: '2026-09-30T18:00:00Z',
  ...extra,
});

const saesa = (
  id: string,
  monto: number,
  folio: number,
  extra: Row = {},
): Row => ({
  id,
  monto,
  moneda: 'MXN',
  fecha_gasto: '2026-09-20',
  medio_pago: 'TRANSFERENCIA',
  categoria: 'OPERACIONES',
  conciliado: false,
  tc_gasto: null,
  tarjeta_terminacion: null,
  lugar: null,
  notas: `Pago VIP SAESA\nvuelo #${folio}`,
  folio_ticket: null,
  vuelo_id: `v-${folio}`,
  escala_id: null,
  aeronave_id: folio === 319 ? 'av-vgv' : 'av-n41',
  proveedor_id: null,
  usuario_captura_id: 'u-jimmy',
  ...extra,
});

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'GASTOS GNRAL',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
      {
        id: CTA_USD,
        alias: 'USD',
        banco: 'Scotiabank',
        moneda: 'USD',
        tipo: 'BANCO',
      },
    ],
    aeronave: [
      { id: 'av-n41', matricula: 'N4142R' },
      { id: 'av-vgv', matricula: 'XA-VGV' },
    ],
    vuelo: [315, 318, 319, 321, 322, 326, 236].map((f) => ({
      id: `v-${f}`,
      folio: f,
      aeronave_id: f === 319 ? 'av-vgv' : 'av-n41',
    })),
    usuario: [{ id: 'u-jimmy', nombre: 'Jimmy Chi' }],
    proveedor: [{ id: 'p-asur', nombre: 'ASUR Cancún' }],
    escala: [],
    gasto_reparto: [],
    tarjeta_corporativa: [],
    conciliacion_clasificacion: [
      { id: 'cl-comision', nombre: 'Comisión del banco', activo: true },
    ],
    gasto: [
      saesa('g315', 2801.4, 315),
      saesa('g319', 2801.4, 319),
      saesa('g326', 2801.4, 326),
      saesa('g236', 2801.4, 236, { fecha_gasto: '2026-09-14' }),
      saesa('g318', 2231.37, 318),
      saesa('g321', 2231.38, 321),
      saesa('g322', 2231.37, 322),
    ],
    movimiento_bancario: [
      cargo('m8404', 8404.2),
      cargo('m4462', 4462.75),
      cargo('m4462b', 4462.75),
      cargo('m2231', 2231.38),
    ],
    ...extra,
  };
}

function armar(db: Tablas, opts: OpcionesFake = {}) {
  if (!opts.sinPartes) sembrarPartes(db);
  const f = fakeSupabase(db, opts);
  const generateTablaXlsx = jest.fn().mockResolvedValue(Buffer.from('xlsx'));
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    f.supabase,
    { generateTablaXlsx } as unknown as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, db, log: f.log, generateTablaXlsx };
}

const mov = (db: Tablas, id: string) =>
  db.movimiento_bancario.find((m) => m.id === id)!;
const gasto = (db: Tablas, id: string) => db.gasto.find((g) => g.id === id)!;
const partesDe = (db: Tablas, movId: string) =>
  (db[TABLA_PARTES] ?? []).filter((p) => p.movimiento_id === movId);

const error = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!e) throw new Error('se esperaba un error');
  const r = (e as { getResponse?: () => unknown }).getResponse?.() as
    | { error?: string; message?: string; details?: Row }
    | undefined;
  return { e, code: r?.error, message: r?.message, details: r?.details };
};

// =====================================================================
describe('linkGastos — un SPEI paga VARIOS gastos (caso SAESA)', () => {
  it('8,404.20 = 3 × 2,801.40: 3 partes, espejo null, gastos_n 3 y los 3 gastos cubiertos', async () => {
    const { svc, db } = armar(mundo());
    const r = (await svc.linkGastos(
      'm8404',
      ['g315', 'g319', 'g326'],
      USER,
    )) as Row;

    expect(mov(db, 'm8404')).toMatchObject({
      gasto_id: null,
      gastos_n: 3,
      conciliado: true,
      updated_by: USER,
    });
    expect(
      partesDe(db, 'm8404').map((p) => [p.gasto_id, p.monto_parte, p.moneda]),
    ).toEqual([
      ['g315', 2801.4, 'MXN'],
      ['g319', 2801.4, 'MXN'],
      ['g326', 2801.4, 'MXN'],
    ]);
    for (const id of ['g315', 'g319', 'g326']) {
      expect(gasto(db, id)).toMatchObject({
        conciliado: true,
        updated_by: USER,
      });
    }
    // El TS NO escribió `conciliado` ni `tc_gasto` (lo hizo la «BD»): un
    // gasto fuera del lote ni se tocó.
    expect(gasto(db, 'g236')).not.toHaveProperty('updated_by');
    // Respuesta: la fila + gastos_estado; con varias partes, planos null.
    expect(r).toMatchObject({
      id: 'm8404',
      gastos_n: 3,
      gasto_conciliado: null,
      monto_vinculado: null,
      faltante: null,
    });
    expect(r.gastos_estado).toEqual([
      expect.objectContaining({
        gasto_id: 'g315',
        monto_parte: 2801.4,
        moneda: 'MXN',
        gasto_conciliado: true,
        monto_vinculado: 2801.4,
        faltante: 0,
      }),
      expect.objectContaining({ gasto_id: 'g319', gasto_conciliado: true }),
      expect.objectContaining({ gasto_id: 'g326', gasto_conciliado: true }),
    ]);
  });

  it('4,462.75 = 2 × 2,231.37 (factura 2,231.375): cuadra con diferencia 0.01 ≤ 0.02', async () => {
    const { svc, db } = armar(mundo());
    await svc.linkGastos('m4462', ['g318', 'g322'], USER);
    expect(partesDe(db, 'm4462').map((p) => p.monto_parte)).toEqual([
      2231.37, 2231.37,
    ]);
    // El centavo NO se le carga a ningún gasto: vive en gastos_diferencia.
    expect(gasto(db, 'g318').monto).toBe(2231.37);
    const lista = await svc.list({ limit: 100, offset: 0 });
    const fila = lista.data.find((m) => m.id === 'm4462')!;
    expect(fila).toMatchObject({
      gastos_n: 2,
      gastos_suma: 4462.74,
      gastos_diferencia: 0.01,
    });
  });

  it('CARGO_NO_CUADRA: 2 × 2,801.40 contra 8,404.20 ⇒ 409 con los números y NADA escrito', async () => {
    const { svc, db, log } = armar(mundo());
    const r = await error(svc.linkGastos('m8404', ['g315', 'g319'], USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('CARGO_NO_CUADRA');
    expect(r.message).toBe(
      'Los 2 gastos suman $5,602.80 y el cargo es de $8,404.20: faltan $2,801.40 (se acepta hasta $0.02 de diferencia). Revisa qué gastos paga este cargo.',
    );
    expect(r.details).toEqual({
      monto_cargo: 8404.2,
      suma_gastos: 5602.8,
      diferencia: 2801.4,
      tolerancia: 0.02,
      moneda: 'MXN',
      gastos: [
        { id: 'g315', monto: 2801.4, faltante: 2801.4 },
        { id: 'g319', monto: 2801.4, faltante: 2801.4 },
      ],
    });
    expect(partesDe(db, 'm8404')).toEqual([]);
    expect(log.some((q) => q.tabla.startsWith('rpc:'))).toBe(false);
  });

  it('LOTE_MONEDA_DISTINTA: un gasto en USD en un cargo MXN', async () => {
    const db = mundo();
    db.gasto.push(saesa('g-usd', 150, 315, { moneda: 'USD' }));
    const { svc } = armar(db);
    const r = await error(svc.linkGastos('m8404', ['g315', 'g-usd'], USER));
    expect(r.code).toBe('LOTE_MONEDA_DISTINTA');
    expect(r.details).toEqual({
      gasto_id: 'g-usd',
      moneda_gasto: 'USD',
      moneda_cuenta: 'MXN',
    });
    expect(r.message).toContain('está en USD');
  });

  it('GASTO_YA_CUBIERTO en un lote: forma de siempre + details.gasto_id', async () => {
    const { svc } = armar(mundo());
    await svc.link('m2231', 'g321', USER);
    const r = await error(svc.linkGastos('m4462', ['g318', 'g321'], USER));
    expect(r.code).toBe('GASTO_YA_CUBIERTO');
    expect(r.details).toMatchObject({
      motivo: 'GASTO_YA_CUBIERTO',
      gasto_id: 'g321',
      monto_gasto: 2231.38,
      suma_ligada: 2231.38,
      movimientos: [
        expect.objectContaining({
          id: 'm2231',
          monto: 2231.38,
          monto_parte: 2231.38,
        }),
      ],
    });
    expect(r.message).toContain('Ese gasto ya está cubierto');
  });

  it('gasto inexistente o repetido ⇒ 400 LOTE_INVALIDO; un ABONO ⇒ 400 SOLO_CARGOS', async () => {
    const db = mundo();
    db.movimiento_bancario.push(cargo('abono', 5602.8, { tipo: 'ABONO' }));
    const { svc } = armar(db);
    const a = await error(svc.linkGastos('m8404', ['g315', 'no-existe'], USER));
    expect(a.e).toBeInstanceOf(BadRequestException);
    expect(a.code).toBe('LOTE_INVALIDO');
    expect(a.details).toEqual({ faltan: ['no-existe'] });
    const b = await error(svc.linkGastos('m8404', ['g315', 'g315'], USER));
    expect(b.code).toBe('LOTE_INVALIDO');
    const c = await error(svc.linkGastos('abono', ['g315', 'g319'], USER));
    expect(c.code).toBe('SOLO_CARGOS');
    const d = await error(svc.linkGastos('no-mov', ['g315', 'g319'], USER));
    expect(d.e).toBeInstanceOf(NotFoundException);
  });

  it('gasto_ids de UN elemento = la liga de siempre (planos con el estado)', async () => {
    const { svc, db } = armar(mundo());
    const r = (await svc.linkGastos('m2231', ['g321'], USER)) as Row;
    expect(mov(db, 'm2231')).toMatchObject({ gasto_id: 'g321', gastos_n: 1 });
    expect(r).toMatchObject({
      gasto_conciliado: true,
      monto_vinculado: 2231.38,
      faltante: 0,
    });
    expect(r.gastos_estado).toHaveLength(1);
  });
});

describe('cambiar o quitar un lote', () => {
  it('panel VIEJO: «Vincular gasto» (un gasto_id) sobre un lote ⇒ 409 MOVIMIENTO_CON_LOTE sin tocar nada', async () => {
    const { svc, db } = armar(mundo());
    await svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER);
    const r = await error(svc.link('m8404', 'g236', USER));
    expect(r.code).toBe('MOVIMIENTO_CON_LOTE');
    expect(r.message).toBe(
      'Este cargo ya paga 3 gastos: desvincúlalos primero desde Conciliación (recarga la página) y vuelve a vincularlo.',
    );
    expect(r.details).toMatchObject({ movimiento_id: 'm8404', gastos_n: 3 });
    expect(partesDe(db, 'm8404')).toHaveLength(3);
    // Aunque el id sea uno de los suyos: cambiar 3 por 1 no se hace por aquí.
    expect((await error(svc.link('m8404', 'g315', USER))).code).toBe(
      'MOVIMIENTO_CON_LOTE',
    );
  });

  it('desligar TODO (gasto_id null): 0 partes, los 3 gastos vuelven a pendientes', async () => {
    const { svc, db } = armar(mundo());
    await svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER);
    const r = (await svc.link('m8404', null, USER)) as Row;
    expect(partesDe(db, 'm8404')).toEqual([]);
    expect(mov(db, 'm8404')).toMatchObject({
      gasto_id: null,
      gastos_n: 0,
      conciliado: false,
    });
    for (const id of ['g315', 'g319', 'g326']) {
      expect(gasto(db, id).conciliado).toBe(false);
    }
    expect(r).toMatchObject({
      gastos_estado: [],
      gasto_conciliado: null,
      monto_vinculado: null,
      faltante: null,
    });
  });

  it('desligar un movimiento SIN partes no le quita su clasificación', async () => {
    const db = mundo();
    db.movimiento_bancario.push(
      cargo('m-com', 7, { conciliado: true, clasificacion_id: 'cl-comision' }),
    );
    const { svc } = armar(db);
    await svc.link('m-com', null, USER);
    expect(mov(db, 'm-com')).toMatchObject({
      conciliado: true,
      clasificacion_id: 'cl-comision',
    });
  });

  it('reemplazo [A] → [A, B]: las partes de ESTE cargo no cuentan (no rebota)', async () => {
    const db = mundo({
      movimiento_bancario: [cargo('mx', 1000.5)],
      gasto: [saesa('gA', 1000, 315), saesa('gB', 0.5, 319)],
    });
    const { svc } = armar(db);
    await svc.link('mx', 'gA', USER);
    expect(gasto(db, 'gA').conciliado).toBe(true);
    await svc.linkGastos('mx', ['gA', 'gB'], USER);
    expect(partesDe(db, 'mx').map((p) => [p.gasto_id, p.monto_parte])).toEqual([
      ['gA', 1000],
      ['gB', 0.5],
    ]);
    expect(mov(db, 'mx')).toMatchObject({ gastos_n: 2, gasto_id: null });
  });

  it('re-ligar EXACTAMENTE el mismo lote es un no-op (ni bitácora del gasto)', async () => {
    const { svc, db } = armar(mundo());
    await svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER);
    gasto(db, 'g315').updated_by = 'otro';
    await svc.linkGastos('m8404', ['g315', 'g319', 'g326'], 'user-2');
    expect(gasto(db, 'g315').updated_by).toBe('otro');
    expect(partesDe(db, 'm8404')).toHaveLength(3);
  });

  it('clasificar un lote ⇒ 409; «Quitar clasificación» lo deja conciliado', async () => {
    const { svc, db } = armar(mundo());
    await svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER);
    await expect(
      svc.clasificarMovimiento('m8404', 'cl-comision', undefined, USER),
    ).rejects.toBeInstanceOf(ConflictException);
    await svc.clasificarMovimiento('m8404', null, 'nota', USER);
    expect(mov(db, 'm8404')).toMatchObject({ conciliado: true, gastos_n: 3 });
  });
});

describe('errores de la BD (carrera) y la migración a medias', () => {
  it('CARGO_NO_CUADRA de la RPC (hint + detail JSON) ⇒ 409 con los details de la BD', async () => {
    const { svc } = armar(mundo(), {
      rpc: {
        fallo: () =>
          errorBd(
            'CARGO_NO_CUADRA',
            'los 3 gastos suman 8404.17 y el cargo es de 8404.20 (diferencia 0.03, tolerancia 0.03)',
            {
              monto_cargo: 8404.2,
              suma_gastos: 8404.1,
              diferencia: 0.1,
              tolerancia: 0.03,
              moneda: 'MXN',
            },
          ),
      },
    });
    const r = await error(
      svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER),
    );
    expect(r.code).toBe('CARGO_NO_CUADRA');
    expect(r.details).toMatchObject({ suma_gastos: 8404.1, diferencia: 0.1 });
    expect(r.message).toContain('$8,404.10');
  });

  it.each([
    ['MOVIMIENTO_YA_LIGADO'],
    ['REVERSO_INVALIDO'],
    ['CARGO_EXCEDIDO'],
    ['LOTE_SOLO_API_NUEVO'],
    // Antes caían a un 500 técnico (revisión 2-oct-2026).
    ['PARTES_INCOHERENTES'],
    ['CARGO_LIGADO'],
  ] as const)(
    '%s de la BD ⇒ 409 con el texto del helper (nunca el de la BD con uuid crudos)',
    async (codigo) => {
      const crudo =
        'texto de la base con el cargo 9a1b2c3d-1111-4222-8333-444455556666';
      const { svc } = armar(mundo(), {
        rpc: { fallo: () => errorBd(codigo, crudo, { x: 1 }) },
      });
      const r = await error(
        svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER),
      );
      expect(r.e).toBeInstanceOf(ConflictException);
      expect(r.code).toBe(codigo);
      expect(r.message).toBe(mensajeErrorPartes(codigo, { x: 1 }));
      expect(r.message).not.toContain('9a1b2c3d');
      expect(r.details).toMatchObject({ movimiento_id: 'm8404', x: 1 });
    },
  );

  it('PARTES_INCOHERENTES del camino directo (ventana de la sonda) ⇒ 409 «el cargo cambió», no un 500', async () => {
    const { svc } = armar(mundo(), {
      sinPartes: true,
      falloUpdate: {
        tabla: 'movimiento_bancario',
        error: errorBd(
          'PARTES_INCOHERENTES',
          'el cargo m8404 quedó con sus gastos a medias (conciliado)',
          { movimiento_id: 'm8404', motivo: 'conciliado' },
        ),
      },
    });
    const r = await error(svc.link('m8404', null, USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('PARTES_INCOHERENTES');
    expect(r.message).toBe(MENSAJE_CARGO_CAMBIO);
  });

  it('LOTE_INVALIDO de la BD ⇒ 400 con el texto de siempre (sin el uuid del gasto)', async () => {
    const { svc } = armar(mundo(), {
      rpc: {
        fallo: () =>
          errorBd(
            'LOTE_INVALIDO',
            'el gasto 9a1b2c3d-1111-4222-8333-444455556666 no existe',
            { gasto_id: '9a1b2c3d-1111-4222-8333-444455556666' },
          ),
      },
    });
    const r = await error(
      svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER),
    );
    expect(r.e).toBeInstanceOf(BadRequestException);
    expect(r.code).toBe('LOTE_INVALIDO');
    expect(r.message).toBe(mensajeLoteInvalido('NO_EXISTE'));
  });

  it('GASTO_YA_CUBIERTO de la BD: details.motivo MONEDA_DISTINTA gana aunque el texto no diga MONEDA', async () => {
    const { svc } = armar(mundo(), {
      rpc: {
        fallo: () =>
          errorBd('GASTO_YA_CUBIERTO', 'el gasto g315 ya está cubierto', {
            motivo: 'MONEDA_DISTINTA',
            gasto_id: 'g315',
          }),
      },
    });
    const r = await error(
      svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER),
    );
    expect(r.code).toBe('GASTO_YA_CUBIERTO');
    expect(r.details).toMatchObject({
      motivo: 'MONEDA_DISTINTA',
      gasto_id: 'g315',
    });
  });

  it('GASTO_YA_CUBIERTO de G con el gasto ya cubierto 1 ↔ 1 en otra moneda (carrera) ⇒ motivo MONEDA_DISTINTA', async () => {
    const db = mundo();
    const { svc } = armar(db, {
      rpc: {
        // Mientras se pre-validaba, otro cargo (cuenta USD) tomó g315 1 ↔ 1.
        fallo: () => {
          db[TABLA_PARTES].push({
            movimiento_id: 'm-usd',
            gasto_id: 'g315',
            monto_parte: 150,
            moneda: 'USD',
            created_at: '2026-10-02T00:00:00Z',
          });
          return errorBd(
            'GASTO_YA_CUBIERTO',
            'el gasto g315 ya está cubierto por otros cargos (0.00 de 2801.40)',
            { motivo: 'GASTO_YA_CUBIERTO', gasto_id: 'g315' },
          );
        },
      },
    });
    const r = await error(
      svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER),
    );
    expect(r.code).toBe('GASTO_YA_CUBIERTO');
    expect(r.details).toMatchObject({
      motivo: 'MONEDA_DISTINTA',
      gasto_id: 'g315',
    });
  });

  it('RPC fuera del schema cache (PGRST202) ⇒ 503 CONCILIACION_PARTES_NO_DISPONIBLE', async () => {
    const { svc } = armar(mundo(), {
      rpc: {
        fallo: () => ({
          code: 'PGRST202',
          message:
            'Could not find the function public.conciliacion_ligar_cargo_gastos',
        }),
      },
    });
    const r = await error(
      svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER),
    );
    expect(r.e).toBeInstanceOf(ServiceUnavailableException);
    expect(r.code).toBe('CONCILIACION_PARTES_NO_DISPONIBLE');
  });

  it('42883 «operator does not exist» (incidente 15-sep) ⇒ 500 con su texto real y en el log, NO 503', async () => {
    const { svc } = armar(mundo(), {
      rpc: {
        fallo: () => ({
          code: '42883',
          message: 'operator does not exist: public.moneda = text',
        }),
      },
    });
    const logError = jest
      .spyOn((svc as unknown as { logger: Logger }).logger, 'error')
      .mockImplementation(() => undefined);
    const r = await error(
      svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER),
    );
    expect(r.e).not.toBeInstanceOf(HttpException);
    expect((r.e as Error).message).toBe(
      'operator does not exist: public.moneda = text',
    );
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0][0])).toContain('42883');
    expect(String(logError.mock.calls[0][0])).toContain(
      'operator does not exist: public.moneda = text',
    );
  });

  it('42883 que NOMBRA la RPC ⇒ 503 (y el error real queda en el log)', async () => {
    const { svc } = armar(mundo(), {
      rpc: {
        fallo: () => ({
          code: '42883',
          message:
            'function public.conciliacion_ligar_cargo_gastos(uuid, uuid[], uuid) does not exist',
        }),
      },
    });
    const logError = jest
      .spyOn((svc as unknown as { logger: Logger }).logger, 'error')
      .mockImplementation(() => undefined);
    const r = await error(
      svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER),
    );
    expect(r.e).toBeInstanceOf(ServiceUnavailableException);
    expect(r.code).toBe('CONCILIACION_PARTES_NO_DISPONIBLE');
    expect(String(logError.mock.calls[0][0])).toContain(
      'conciliacion_ligar_cargo_gastos',
    );
  });

  it('un error ajeno de la RPC sube tal cual (500)', async () => {
    const { svc } = armar(mundo(), {
      rpc: { fallo: () => ({ code: '57014', message: 'canceling statement' }) },
    });
    const r = await error(svc.link('m2231', 'g321', USER));
    expect(r.e).not.toBeInstanceOf(ConflictException);
    expect((r.e as Error).message).toBe('canceling statement');
  });
});

describe('lectores', () => {
  const conLotes = async () => {
    const w = armar(mundo());
    await w.svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER);
    await w.svc.linkGastos('m4462', ['g318', 'g322'], USER);
    await w.svc.link('m2231', 'g321', USER);
    return w;
  };

  it('GET movimientos: gastos[] con la parte, nota y vuelo; suma y diferencia', async () => {
    const { svc } = await conLotes();
    const lista = await svc.list({ limit: 100, offset: 0 });
    const lote = lista.data.find((m) => m.id === 'm8404')!;
    expect(lote).toMatchObject({
      gasto_id: null,
      gasto: null,
      gastos_n: 3,
      gastos_suma: 8404.2,
      gastos_diferencia: 0,
    });
    const gastos = lote.gastos as Row[];
    expect(gastos.map((g) => g.id)).toEqual(['g315', 'g319', 'g326']);
    expect(gastos[0]).toMatchObject({
      monto: 2801.4,
      moneda: 'MXN',
      categoria: 'OPERACIONES',
      lugar: null,
      notas_primera_linea: 'Pago VIP SAESA',
      monto_parte: 2801.4,
      moneda_parte: 'MXN',
      monto_vinculado: 2801.4,
      faltante: 0,
      vuelo: { folio: 315 },
    });
    expect(gastos[0]).not.toHaveProperty('notas');
    // UNA parte: el espejo de siempre y gastos[] con ella.
    const uno = lista.data.find((m) => m.id === 'm2231')!;
    expect(uno).toMatchObject({
      gasto_id: 'g321',
      gastos_n: 1,
      gastos_diferencia: 0,
    });
    expect((uno.gastos as Row[]).map((g) => g.id)).toEqual(['g321']);
    // Sin partes: lista vacía, sin suma ni diferencia.
    const libre = lista.data.find((m) => m.id === 'm4462b')!;
    expect(libre).toMatchObject({
      gastos: [],
      gastos_suma: null,
      gastos_diferencia: null,
    });
  });

  it('si la lectura de partes falla, la lista sale SIN gastos[] (nunca a medias)', async () => {
    const w = await conLotes();
    const { svc } = armar(w.db, { fallaLectura: [TABLA_PARTES] });
    const lista = await svc.list({ limit: 100, offset: 0 });
    const lote = lista.data.find((m) => m.id === 'm8404')!;
    expect(lote.gastos_n).toBe(3);
    expect(lote).not.toHaveProperty('gastos');
    expect(lote).not.toHaveProperty('gastos_diferencia');
  });

  it('resumen: diferencia_lotes = Σ de los lotes de la cuenta (el centavo de SAESA)', async () => {
    const { svc } = await conLotes();
    const r = await svc.resumen();
    const gnral = r.find((c) => c.cuenta_bancaria_id === CTA)!;
    expect(gnral).toMatchObject({ diferencia_lotes: 0.01, conciliados: 3 });
  });

  it('Excel: «Conciliado con» nombra los 3 gastos y «Matrícula» une las del lote', async () => {
    const { svc, generateTablaXlsx } = await conLotes();
    await svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    const llamada = generateTablaXlsx.mock.calls[0] as unknown[];
    const { filas } = llamada[0] as {
      filas: unknown[][];
    };
    const de = (monto: number) => filas.filter((f) => f[4] === monto);
    const lote = de(8404.2)[0];
    expect(lote[3]).toBe('N4142R + XA-VGV');
    expect(lote[7]).toBe(
      '3 gastos: Operaciones · vuelo #315 ($2,801.40) · Operaciones · vuelo #319 ($2,801.40) · Operaciones · vuelo #326 ($2,801.40)',
    );
    const conCentavo = de(4462.75).find((f) => f[6] === 'Conciliado')!;
    expect(conCentavo[7]).toBe(
      '2 gastos: Operaciones · vuelo #318 ($2,231.37) · Operaciones · vuelo #322 ($2,231.37) · diferencia $0.01',
    );
    // UNA parte: el texto de siempre.
    expect(de(2231.38)[0][7]).toBe('Gasto Operaciones · vuelo #321');
  });

  it('gastos sin banco / candidatos: lo vinculado es la PARTE, no el |monto| del SPEI', async () => {
    const db = mundo({
      movimiento_bancario: [cargo('m-parcial', 1000)],
      gasto: [saesa('g-grande', 2801.4, 315)],
    });
    const { svc } = armar(db);
    await svc.link('m-parcial', 'g-grande', USER);
    const r = await svc.gastosSinBanco('2026-09-01', '2026-09-30');
    expect(r.data.find((g) => g.id === 'g-grande')).toMatchObject({
      monto_vinculado: 1000,
      faltante: 1801.4,
      parcial: true,
    });
  });
});

describe('GET movimientos/:id/gastos-candidatos', () => {
  it('sin búsqueda: ±30 días, los que cuadran primero, luego monto y fecha', async () => {
    const db = mundo();
    db.gasto.push(
      saesa('g-viejo', 2231.38, 315, { fecha_gasto: '2026-08-01' }),
    );
    const { svc } = armar(db);
    const r = await svc.gastosCandidatosDeMovimiento('m2231', {});
    expect(r.movimiento).toEqual({
      id: 'm2231',
      fecha: '2026-09-24',
      monto: 2231.38,
      moneda: 'MXN',
    });
    expect(r.ventana).toEqual({ desde: '2026-08-25', hasta: '2026-10-24' });
    const ids = r.candidatos.map((c) => c.id);
    expect(ids).not.toContain('g-viejo');
    // Cuadran (|monto − cargo| ≤ 1.00): el exacto, luego los de un centavo.
    expect(ids.slice(0, 3)).toEqual(['g321', 'g318', 'g322']);
    expect(r.candidatos[0]).toMatchObject({
      nota: 'Pago VIP SAESA',
      vuelo_folio: 321,
      capturado_por: 'Jimmy Chi',
      matricula: 'N4142R',
      monto_vinculado: 0,
      faltante: 2231.38,
    });
    expect(r.truncado).toBe(false);
  });

  it('q con decimales ⇒ ±0.01; q entero ⇒ [q, q+1)', async () => {
    const { svc } = armar(mundo());
    const a = await svc.gastosCandidatosDeMovimiento('m8404', { q: '2801.40' });
    expect(a.candidatos.map((c) => c.id).sort()).toEqual([
      'g236',
      'g315',
      'g319',
      'g326',
    ]);
    const b = await svc.gastosCandidatosDeMovimiento('m8404', { q: '2231' });
    expect(b.candidatos.map((c) => c.id).sort()).toEqual([
      'g318',
      'g321',
      'g322',
    ]);
  });

  it('q texto: nota, lugar, folio del ticket o PROVEEDOR (consulta aparte)', async () => {
    const db = mundo();
    db.gasto.push(
      saesa('g-asur', 500, 315, { notas: 'TUA', proveedor_id: 'p-asur' }),
      saesa('g-ticket', 600, 315, { notas: null, folio_ticket: 'SAE-77' }),
    );
    const { svc, log } = armar(db);
    const r = await svc.gastosCandidatosDeMovimiento('m8404', { q: 'saesa' });
    expect(r.candidatos.map((c) => c.id)).toContain('g315');
    expect(r.candidatos.map((c) => c.id)).not.toContain('g-asur');
    const t = await svc.gastosCandidatosDeMovimiento('m8404', { q: 'SAE-77' });
    expect(t.candidatos.map((c) => c.id)).toEqual(['g-ticket']);
    const p = await svc.gastosCandidatosDeMovimiento('m8404', { q: 'asur' });
    expect(p.candidatos.map((c) => c.id)).toEqual(['g-asur']);
    expect(
      log.some(
        (q) =>
          q.tabla === 'gasto' && q.texto.includes('proveedor_id.in.(p-asur)'),
      ),
    ).toBe(true);
  });

  it('un patrón con comas/paréntesis no rompe el `or` (patronIlikeSeguro)', async () => {
    const { svc, log } = armar(mundo());
    await svc.gastosCandidatosDeMovimiento('m8404', { q: 'a,b(c)' });
    const or = log.find((q) => q.tabla === 'gasto' && q.texto.includes('or:'));
    expect(or?.texto).toContain('notas.ilike.*a_b_c_*');
  });

  it('cuenta MXN sin búsqueda: también los USD con T.C. implícito 15–25 (cruzado, al final)', async () => {
    const db = mundo();
    db.gasto.push(
      saesa('g-usd', 120, 315, { moneda: 'USD' }),
      saesa('g-usd-lejos', 10, 315, { moneda: 'USD' }),
    );
    const { svc } = armar(db);
    const r = await svc.gastosCandidatosDeMovimiento('m2231', {});
    const ultimo = r.candidatos[r.candidatos.length - 1];
    expect(ultimo).toMatchObject({
      id: 'g-usd',
      cruzado: true,
      tc_implicito: 18.594833,
    });
    expect(r.candidatos.map((c) => c.id)).not.toContain('g-usd-lejos');
    const conQ = await svc.gastosCandidatosDeMovimiento('m2231', { q: '120' });
    expect(conQ.candidatos.map((c) => c.id)).not.toContain('g-usd');
  });

  it('limite ⇒ truncado; el pago parcial entra con su faltante', async () => {
    const db = mundo({
      movimiento_bancario: [cargo('m-parcial', 1000), cargo('m-x', 1801.4)],
      gasto: [saesa('g-grande', 2801.4, 315), saesa('g-otro', 50, 319)],
    });
    const { svc } = armar(db);
    await svc.link('m-parcial', 'g-grande', USER);
    const r = await svc.gastosCandidatosDeMovimiento('m-x', { limite: 1 });
    expect(r.truncado).toBe(true);
    expect(r.candidatos).toEqual([
      expect.objectContaining({
        id: 'g-grande',
        monto_vinculado: 1000,
        faltante: 1801.4,
      }),
    ]);
  });

  it('ABONO ⇒ 400 SOLO_CARGOS; inexistente ⇒ 404', async () => {
    const db = mundo();
    db.movimiento_bancario.push(cargo('abono', 10, { tipo: 'ABONO' }));
    const { svc } = armar(db);
    expect(
      (await error(svc.gastosCandidatosDeMovimiento('abono', {}))).code,
    ).toBe('SOLO_CARGOS');
    expect(
      (await error(svc.gastosCandidatosDeMovimiento('nada', {}))).e,
    ).toBeInstanceOf(NotFoundException);
  });
});

describe('SIN la migración 20261002000002 — todo como el 0.0.51', () => {
  const nuevo = (log: Array<{ tabla: string; texto: string }>) =>
    log.filter(
      (q) =>
        q.tabla === TABLA_PARTES ||
        q.tabla === VISTA_CONCILIACION ||
        q.tabla.startsWith('rpc:') ||
        (/gastos_n/.test(q.texto) && q.texto.trim() !== 'select(gastos_n)'),
    );

  it('lote y candidatos ⇒ 503; UN gasto, lista, resumen, reporte y gastos sin banco como hoy', async () => {
    const { svc, db, log } = armar(mundo(), { sinPartes: true });
    for (const p of [
      svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER),
      svc.gastosCandidatosDeMovimiento('m8404', {}),
    ]) {
      const r = await error(p);
      expect(r.e).toBeInstanceOf(ServiceUnavailableException);
      expect(r.code).toBe('CONCILIACION_PARTES_NO_DISPONIBLE');
    }
    const r = (await svc.link('m2231', 'g321', USER)) as Row;
    expect(mov(db, 'm2231')).toMatchObject({
      gasto_id: 'g321',
      conciliado: true,
    });
    expect(gasto(db, 'g321').conciliado).toBe(true);
    expect(r).not.toHaveProperty('gastos_estado');
    expect(r).toMatchObject({ gasto_conciliado: true, faltante: 0 });

    const lista = await svc.list({ limit: 100, offset: 0 });
    expect(lista.data[0]).not.toHaveProperty('gastos');
    const resumen = await svc.resumen();
    expect(resumen[0]).not.toHaveProperty('diferencia_lotes');
    await svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    await svc.gastosSinBanco('2026-09-01', '2026-09-30');
    await svc.link('m2231', null, USER);
    expect(nuevo(log)).toEqual([]);
  });

  it('gasto_ids de UN elemento sigue funcionando por el camino directo', async () => {
    const { svc, db } = armar(mundo(), { sinPartes: true });
    await svc.linkGastos('m2231', ['g321'], USER);
    expect(mov(db, 'm2231').gasto_id).toBe('g321');
  });
});

describe('revisión 2-oct-2026: moneda de la cuenta, uuid, cobros y anti-tope', () => {
  it('lote con la moneda de la cuenta ilegible ⇒ 503 CUENTA_SIN_MONEDA (no un LOTE_MONEDA_DISTINTA que culpa al operador)', async () => {
    const db = mundo();
    db.movimiento_bancario.push(
      cargo('m-sin-cuenta', 5602.8, { cuenta_bancaria_id: 'cta-borrada' }),
    );
    const { svc, log } = armar(db);
    const r = await error(
      svc.linkGastos('m-sin-cuenta', ['g315', 'g319'], USER),
    );
    expect(r.e).toBeInstanceOf(ServiceUnavailableException);
    expect(r.code).toBe('CUENTA_SIN_MONEDA');
    expect(r.message).toBe(MENSAJE_SIN_MONEDA_CUENTA);
    expect(log.some((q) => q.tabla.startsWith('rpc:'))).toBe(false);
    // El endpoint de candidatos responde lo MISMO.
    const c = await error(svc.gastosCandidatosDeMovimiento('m-sin-cuenta', {}));
    expect(c.code).toBe('CUENTA_SIN_MONEDA');
  });

  it('uuid en MAYÚSCULAS en gasto_ids / gasto_id: se encuentra el gasto (antes «ya no existe»)', async () => {
    const U = (n: number) => `aaaaaaaa-0000-4000-8000-000000000${n}`;
    const db = mundo({
      gasto: [
        saesa(U(315), 2801.4, 315),
        saesa(U(319), 2801.4, 319),
        saesa(U(326), 2801.4, 326),
        saesa(U(321), 2231.38, 321),
      ],
    });
    const { svc } = armar(db);
    await svc.linkGastos(
      'm8404',
      [U(315), U(319), U(326)].map((x) => x.toUpperCase()),
      USER,
    );
    expect(partesDe(db, 'm8404').map((p) => p.gasto_id)).toEqual([
      U(315),
      U(319),
      U(326),
    ]);
    await svc.link('m2231', U(321).toUpperCase(), USER);
    expect(mov(db, 'm2231').gasto_id).toBe(U(321));
    // Repetidos que solo difieren en mayúsculas: LOTE_INVALIDO.
    const r = await error(
      svc.linkGastos('m4462', [U(315), U(315).toUpperCase()], USER),
    );
    expect(r.code).toBe('LOTE_INVALIDO');
  });

  it('linkCobro sobre un cargo que ya paga gastos ⇒ 409 MOVIMIENTO_YA_LIGADO (su dinero no se cuenta dos veces)', async () => {
    const { svc, db } = armar(mundo());
    await svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER);
    const r = await error(svc.linkCobro('m8404', { cobro_id: 'c-1' }, USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('MOVIMIENTO_YA_LIGADO');
    expect(r.message).toBe(mensajeMovimientoConGastos(3));
    expect(r.details).toMatchObject({ liga: 'GASTO', gastos_n: 3 });
    expect(mov(db, 'm8404').cobro_id).toBeNull();
    // Con UNA parte (espejo gasto_id) también.
    await svc.link('m2231', 'g321', USER);
    const uno = await error(
      svc.linkCobro('m2231', { cobro_grupo_id: 'sobre-1' }, USER),
    );
    expect(uno.code).toBe('MOVIMIENTO_YA_LIGADO');
    expect(uno.message).toBe(mensajeMovimientoConGastos(1));
    // Desvincular el cobro (ambos null) sigue pasando y no le quita los gastos.
    await svc.linkCobro('m8404', {}, USER);
    expect(mov(db, 'm8404')).toMatchObject({ conciliado: true, gastos_n: 3 });
  });

  it('la lista lee TODAS las partes aunque pasen de 1000 (PostgREST corta en max-rows sin avisar)', async () => {
    const cargos: Row[] = [];
    const gastos: Row[] = [];
    const partes: Row[] = [];
    for (let i = 0; i < 30; i += 1) {
      cargos.push(cargo(`mc${i}`, 400, { conciliado: true }));
      for (let j = 0; j < 40; j += 1) {
        const gid = `gc${i}-${j}`;
        gastos.push(saesa(gid, 10, 315, { conciliado: true }));
        partes.push({
          movimiento_id: `mc${i}`,
          gasto_id: gid,
          monto_parte: 10,
          moneda: 'MXN',
          created_at: '2026-10-02T00:00:00Z',
          created_by: USER,
        });
      }
    }
    const db = mundo({ movimiento_bancario: cargos, gasto: gastos });
    db[TABLA_PARTES] = partes;
    const { svc } = armar(db, { maxFilas: 1000 });
    const lista = await svc.list({ limit: 100, offset: 0 });
    expect(lista.data).toHaveLength(30);
    for (const fila of lista.data) {
      expect(fila.gastos_n).toBe(40);
      expect(fila.gastos as Row[]).toHaveLength(40);
      expect(fila).toMatchObject({ gastos_suma: 400, gastos_diferencia: 0 });
    }
  });
});

// =====================================================================
describe('NÚMERO DE FACTURA del gasto en conciliación (5-oct-2026, API 0.0.57)', () => {
  /**
   * Pedido del cliente: «al momento de la conciliación me apoyan a poner el
   * número de la factura con la que se enlaza el movimiento. Aquí en notas
   * estaría perfecto». Mundo SAESA + las tres fuentes del folio: factura
   * recibida con Serie/Folio, `folio_ticket` (ASUR «FEACZM 72128») y la
   * lectura IA (`valor_ia_extraido.folio`).
   */
  const conFolios = (opts: OpcionesFake = {}) => {
    const db = mundo({
      factura_recibida: [
        { id: 'fr-a', serie: 'A', folio: '0411', uuid_fiscal: 'uuid-a' },
        { id: 'fr-solo-uuid', serie: null, folio: null, uuid_fiscal: 'uuid-z' },
      ],
    });
    Object.assign(gasto(db, 'g315'), { factura_recibida_id: 'fr-a' });
    Object.assign(gasto(db, 'g326'), { factura_recibida_id: 'fr-a' });
    Object.assign(gasto(db, 'g319'), {
      valor_ia_extraido: { folio: 'AB1144717', total: 2801.4 },
    });
    // ±3 días del cargo (24-sep): candidato de «Sugerir».
    Object.assign(gasto(db, 'g321'), {
      folio_ticket: 'FEACZM 72128',
      fecha_gasto: '2026-09-23',
    });
    Object.assign(gasto(db, 'g322'), { factura_recibida_id: 'fr-solo-uuid' });
    Object.assign(mov(db, 'm2231'), { notas: 'pago SAESA' });
    Object.assign(mov(db, 'm4462'), { notas: 'nota del banco' });
    Object.assign(mov(db, 'm4462b'), { notas: 'nota del banco' });
    return armar(db, opts);
  };
  const ligar = async (w: ReturnType<typeof armar>) => {
    await w.svc.linkGastos('m8404', ['g315', 'g319', 'g326'], USER);
    await w.svc.link('m2231', 'g321', USER);
    return w;
  };
  const filasExcel = (gen: jest.Mock) =>
    ((gen.mock.calls[0] as unknown[])[0] as { filas: unknown[][] }).filas;

  it('Excel «Notas»: 1 ↔ 1 con folio_ticket + nota del banco; lote con factura e IA sin duplicar', async () => {
    const w = await ligar(conFolios());
    await w.svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    const filas = filasExcel(w.generateTablaXlsx);
    const de = (id: string) =>
      filas.find(
        (f) =>
          f[4] === Number(mov(w.db, id).monto) &&
          (id === 'm4462b' ? f[6] === 'PENDIENTE' : f[6] === 'Conciliado'),
      )!;
    // 1 ↔ 1: «Factura <folio_ticket> · <nota del banco>».
    expect(de('m2231')[8]).toBe('Factura FEACZM 72128 · pago SAESA');
    // Lote: g315 y g326 con la MISMA factura A-0411, g319 con la IA.
    expect(de('m8404')[8]).toBe('Facturas A-0411 · AB1144717');
    // Sin gasto: la nota del banco tal cual (como el 0.0.56).
    expect(de('m4462b')[8]).toBe('nota del banco');
    // «Conciliado con» no cambia.
    expect(de('m2231')[7]).toBe('Gasto Operaciones · vuelo #321');
  });

  it('Excel «Notas»: cobros, ingresos, clasificaciones y reversos llevan SOLO la nota del banco (como el 0.0.56)', async () => {
    // Revisión 5-oct-2026: ninguna línea SIN gasto puede ganar una
    // «Factura …» (ni siquiera con un gasto con folio en el mismo reporte).
    const w = await ligar(conFolios());
    const conciliado = (id: string, extra: Row): Row => ({
      ...cargo(id, 0),
      conciliado: true,
      ...extra,
    });
    w.db.cobro_vuelo = [
      { id: 'cv-1', metodo_cobro: 'TRANSFERENCIA', vuelo_id: 'v-315' },
      { id: 'cv-2', metodo_cobro: 'EFECTIVO', vuelo_id: 'v-318' },
    ];
    w.db.ingreso = [
      {
        id: 'ing-1',
        folio: 12,
        categoria: 'OTROS',
        descripcion: 'Reembolso aseguradora',
      },
    ];
    w.db.conciliacion_clasificacion.push({
      id: 'cl-reverso',
      nombre: 'Cargo devuelto',
      activo: true,
    });
    w.db.movimiento_bancario.push(
      conciliado('m-cobro', {
        tipo: 'ABONO',
        monto: 15000,
        descripcion: 'SPEI RECIBIDO CLIENTE',
        cobro_id: 'cv-1',
        notas: 'depósito de Juan',
      }),
      conciliado('m-cobro-sin', {
        tipo: 'ABONO',
        monto: 900,
        descripcion: 'DEPOSITO SIN NOTA',
        cobro_id: 'cv-2',
        notas: null,
      }),
      conciliado('m-ingreso', {
        tipo: 'ABONO',
        monto: 500,
        descripcion: 'SPEI RECIBIDO ASEGURADORA',
        ingreso_id: 'ing-1',
        notas: 'reembolso del seguro',
      }),
      conciliado('m-clasif', {
        monto: 35.5,
        descripcion: 'COMISION SPEI',
        clasificacion_id: 'cl-comision',
        notas: 'comisión del mes',
      }),
      conciliado('m-rev-c', {
        monto: 1200,
        fecha: '2026-09-21',
        descripcion: 'ASUR CANCUN',
        clasificacion_id: 'cl-reverso',
        notas: 'cargo indebido',
      }),
      conciliado('m-rev-a', {
        tipo: 'ABONO',
        monto: 1200,
        fecha: '2026-09-23',
        descripcion: 'DEVOLUCION ASUR',
        clasificacion_id: 'cl-reverso',
        reverso_de_id: 'm-rev-c',
        notas: null,
      }),
    );
    await w.svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    const filas = filasExcel(w.generateTablaXlsx);
    const de = (descripcion: string) => {
      const f = filas.find((x) => x[1] === descripcion);
      if (!f) throw new Error(`sin fila ${descripcion}`);
      return f;
    };
    // Cada línea se reconoce como lo que es («Conciliado con»)…
    expect(de('SPEI RECIBIDO CLIENTE')[7]).toMatch(/^Cobro · vuelo #315/);
    expect(de('DEPOSITO SIN NOTA')[7]).toMatch(/^Cobro · vuelo #318/);
    expect(de('SPEI RECIBIDO ASEGURADORA')[7]).toMatch(/^Ingreso /);
    expect(de('COMISION SPEI')[7]).toBe('Clasificación: Comisión del banco');
    expect(de('ASUR CANCUN')[7]).toMatch(/^Cargo devuelto · devuelto el /);
    expect(de('DEVOLUCION ASUR')[7]).toMatch(
      /^Cargo devuelto · devuelve el cargo del /,
    );
    // …y su «Notas» es la nota del banco BYTE A BYTE ('' sin nota).
    expect(de('SPEI RECIBIDO CLIENTE')[8]).toBe('depósito de Juan');
    expect(de('DEPOSITO SIN NOTA')[8]).toBe('');
    expect(de('SPEI RECIBIDO ASEGURADORA')[8]).toBe('reembolso del seguro');
    expect(de('COMISION SPEI')[8]).toBe('comisión del mes');
    expect(de('ASUR CANCUN')[8]).toBe('cargo indebido');
    expect(de('DEVOLUCION ASUR')[8]).toBe('');
    // En el MISMO reporte las líneas con gasto sí llevan su factura.
    expect(
      filas.some((f) => f[8] === 'Factura FEACZM 72128 · pago SAESA'),
    ).toBe(true);
  });

  it('Excel: la factura SIN Serie/Folio sale como «CFDI <uuid>»', async () => {
    const w = conFolios();
    await w.svc.link('m2231', 'g322', USER);
    await w.svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'conciliados');
    const filas = filasExcel(w.generateTablaXlsx);
    expect(filas.find((f) => f[4] === 2231.38)![8]).toBe(
      'Factura CFDI uuid-z · pago SAESA',
    );
  });

  it('gastos sin banco: columna «Factura» al FINAL (después de «Parcial»)', async () => {
    const w = conFolios();
    await w.svc.reporteXlsx(undefined, '2026-09-01', '2026-09-30', 'sin_banco');
    const arg = (w.generateTablaXlsx.mock.calls[0] as unknown[])[0] as {
      columnas: Array<{ label: string }>;
      filas: unknown[][];
      resaltes: Array<{ col: number }>;
    };
    expect(arg.columnas.map((c) => c.label).slice(-2)).toEqual([
      'Parcial',
      'Factura',
    ]);
    // El resalte naranja sigue en Monto (col 7).
    expect(arg.resaltes.every((r) => r.col === 7)).toBe(true);
    const ultima = (folio: number) =>
      arg.filas.find((f) => f[5] === `#${folio}`)!.at(-1);
    expect(ultima(315)).toBe('A-0411');
    expect(ultima(319)).toBe('AB1144717');
    expect(ultima(321)).toBe('FEACZM 72128');
    expect(ultima(322)).toBe('CFDI uuid-z');
    expect(ultima(318)).toBe('');
  });

  it('lista de movimientos: gasto.folio_comprobante y gastos[].folio_comprobante, sin campos crudos', async () => {
    const w = await ligar(conFolios());
    const lista = await w.svc.list({ limit: 100, offset: 0 });
    const uno = lista.data.find((m) => m.id === 'm2231')!;
    const g = uno.gasto as Row;
    expect(g).toMatchObject({ id: 'g321', folio_comprobante: 'FEACZM 72128' });
    for (const k of ['folio_ticket', 'ia_folio', 'factura']) {
      expect(g).not.toHaveProperty(k);
    }
    expect((uno.gastos as Row[])[0].folio_comprobante).toBe('FEACZM 72128');
    const lote = lista.data.find((m) => m.id === 'm8404')!;
    const gastos = lote.gastos as Row[];
    expect(gastos.map((x) => [x.id, x.folio_comprobante])).toEqual([
      ['g315', 'A-0411'],
      ['g319', 'AB1144717'],
      ['g326', 'A-0411'],
    ]);
    for (const k of ['folio_ticket', 'ia_folio', 'factura']) {
      expect(gastos[0]).not.toHaveProperty(k);
    }
  });

  it('candidatos de «Vincular gasto» y de «Sugerir» traen folio_comprobante', async () => {
    const w = conFolios();
    const r = await w.svc.gastosCandidatosDeMovimiento('m8404', {
      q: '2801.40',
    });
    const porId = new Map(r.candidatos.map((c) => [c.id, c.folio_comprobante]));
    expect(porId.get('g315')).toBe('A-0411');
    expect(porId.get('g319')).toBe('AB1144717');
    // Sin ningún número: null (el campo siempre viaja).
    expect(porId.has('g236')).toBe(true);
    expect(porId.get('g236')).toBeNull();
    // «Sugerir» (±3 días y ±5 % del cargo de 2,231.38 del 24-sep): un
    // candidato con la factura ligada y otro solo con la lectura IA. El
    // folio de los dos sale del EMBED de `gastoRicoCols()` (no de una
    // columna plana): si el select regresara a `GASTO_RICO_COLS` a secas,
    // los dos saldrían null.
    Object.assign(gasto(w.db, 'g318'), {
      fecha_gasto: '2026-09-25',
      factura_recibida_id: 'fr-a',
    });
    Object.assign(gasto(w.db, 'g322'), {
      fecha_gasto: '2026-09-22',
      factura_recibida_id: null,
      valor_ia_extraido: { folio: 'IA-0077', total: 2231.37 },
    });
    const s = await w.svc.sugerir('m2231');
    const folioDe = (id: string) => {
      const c = s.candidatos.find((x) => x.id === id);
      if (!c) throw new Error(`sin candidato ${id}`);
      return c.folio_comprobante;
    };
    expect(folioDe('g321')).toBe('FEACZM 72128');
    expect(folioDe('g318')).toBe('A-0411');
    expect(folioDe('g322')).toBe('IA-0077');
    // Sin los campos crudos del cálculo.
    for (const k of ['ia_folio', 'factura']) {
      expect(s.candidatos[0]).not.toHaveProperty(k);
    }
  });

  it('SIN la migración 20261005000002: ninguna consulta nombra serie (salvo la sonda) y el folio sale de ticket/IA/UUID', async () => {
    const w = await ligar(conFolios({ sinSerieFolio: true }));
    await w.svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    const lista = await w.svc.list({ limit: 100, offset: 0 });
    await w.svc.gastosCandidatosDeMovimiento('m8404', {});
    await w.svc.reporteXlsx(undefined, '2026-09-01', '2026-09-30', 'sin_banco');
    const conSerie = w.log.filter(
      (q) =>
        /\bserie\b/.test(q.texto) &&
        !(q.tabla === 'factura_recibida' && q.texto.trim() === 'select(serie)'),
    );
    expect(conSerie).toEqual([]);
    const filas = filasExcel(w.generateTablaXlsx);
    expect(
      filas.find((f) => f[4] === 2231.38 && f[6] === 'Conciliado')![8],
    ).toBe('Factura FEACZM 72128 · pago SAESA');
    expect(
      (lista.data.find((m) => m.id === 'm2231')!.gasto as Row)
        .folio_comprobante,
    ).toBe('FEACZM 72128');
  });
});
