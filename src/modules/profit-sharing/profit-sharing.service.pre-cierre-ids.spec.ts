// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { Logger } from '@nestjs/common';
import { ProfitSharingService } from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';
import type { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';

/**
 * PRE-CIERRE · `ids` POR RENGLÓN (15-oct-2026, API 0.0.81, PEDIDO 2,
 * invariante 81): «Resolver →» marca en ámbar lo que hay que resolver. Los 11
 * renglones que cuentan GASTOS o MOVIMIENTOS bancarios ganan `ids` (los MISMOS
 * registros que suman en `count`, en su orden) y, si se cortó en 500,
 * `ids_truncado: true`; las dos llaves van al FINAL del objeto. Los renglones
 * con `vuelos[]`/`cobros[]`/`grupos[]`… y los informativos NO llevan `ids`.
 *
 * Fake: BD EN MEMORIA (mismo intérprete que el spec de los inversos, con
 * max-rows 1000 como el PostgREST real); el T.C. oficial no tiene dato (un
 * gasto MXN sin T.C. cae en `gastos_sin_tc`).
 */
type Fila = Record<string, unknown>;
type Op = [string, unknown[]];

const MAX_ROWS = 1000;
const ISO = /^\d{4}-\d{2}-\d{2}T/;

function valor(fila: Fila, col: string): unknown {
  let acc: unknown = fila;
  for (const k of col.split('.')) {
    if (Array.isArray(acc)) acc = acc[0] as unknown;
    if (acc == null || typeof acc !== 'object') return undefined;
    acc = (acc as Fila)[k];
  }
  return acc;
}

function comparar(a: unknown, b: unknown): number | null {
  if (a == null || b == null) return null;
  const texto = (v: unknown) =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  const sa = texto(a);
  const sb = texto(b);
  if (ISO.test(sa) && ISO.test(sb)) return Date.parse(sa) - Date.parse(sb);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function aplica(fila: Fila, [op, args]: Op): boolean {
  const [col, v, v2] = args;
  if (typeof col !== 'string') return true;
  const x = valor(fila, col);
  switch (op) {
    case 'eq':
      return x === v;
    case 'neq':
      return x != null && x !== v;
    case 'in':
      return (v as unknown[]).includes(x);
    case 'is':
      return v === null ? x == null : x === v;
    case 'not':
      return v === 'is' && v2 === null ? x != null : true;
    case 'gte': {
      const c = comparar(x, v);
      return c != null && c >= 0;
    }
    case 'lte': {
      const c = comparar(x, v);
      return c != null && c <= 0;
    }
    default:
      return true;
  }
}

function armar(tablas: Record<string, Fila[]>) {
  const from = (tabla: string) => {
    const ops: Op[] = [];
    const q: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'not',
      'or',
      'gte',
      'lte',
      'order',
      'limit',
      'range',
    ]) {
      q[m] = (...args: unknown[]) => {
        ops.push([m, args]);
        return q;
      };
    }
    const resolver = (): { data: Fila[]; error: null } => {
      let filas = (tablas[tabla] ?? []).filter((f) =>
        ops.every((o) => aplica(f, o)),
      );
      const rango = ops.find((o) => o[0] === 'range')?.[1] as
        | [number, number]
        | undefined;
      const [a, b] = rango ?? [0, Number.MAX_SAFE_INTEGER];
      filas = filas.slice(a, Math.min(b + 1, a + MAX_ROWS));
      const limite = ops.find((o) => o[0] === 'limit')?.[1][0];
      if (typeof limite === 'number') filas = filas.slice(0, limite);
      return { data: filas, error: null };
    };
    q.maybeSingle = () =>
      Promise.resolve({ data: resolver().data[0] ?? null, error: null });
    q.single = q.maybeSingle;
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(res, rej);
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const conciliacion = {
    cobrosSinBanco: jest
      .fn()
      .mockResolvedValue({ data: [], total: 0, por_moneda: [] }),
    ligasUsdTcFueraDeLugar: jest
      .fn()
      .mockResolvedValue({ ligas: [], sin_verificar: 0 }),
    omitidosDelPeriodo: jest
      .fn()
      .mockResolvedValue({ count: 0, monto_mxn: 0, monto_usd: 0 }),
  } as unknown as ConciliacionService;
  // Sin T.C. oficial: los gastos MXN sin T.C. no convierten (gastos_sin_tc).
  const tipoCambio = {
    oficialDetallePara: jest.fn().mockResolvedValue(null),
  } as unknown as TipoCambioService;
  const nada = {} as never;
  return new ProfitSharingService(supabase, nada, tipoCambio, conciliacion);
}

const PERIODO = { desde: '2026-09-01', hasta: '2026-09-30' };
const A1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const A2 = 'a2a2a2a2-0000-4000-8000-000000000002';

/** Gasto «limpio» del periodo: con avión, USD, facturado, en efectivo. */
const gasto = (id: string, extra: Fila = {}): Fila => ({
  id,
  vuelo_id: null,
  aeronave_id: A1,
  escala_id: null,
  categoria: 'REFACCION',
  monto: 100,
  moneda: 'USD',
  tc_gasto: null,
  fecha_gasto: '2026-09-10',
  estatus_facturacion: 'FACTURADA',
  medio_pago: 'EFECTIVO',
  conciliado: false,
  duplicado_sospechado: false,
  matricula_ia: null,
  ...extra,
});

const AERONAVES: Fila[] = [
  { id: A1, matricula: 'XA-AAA' },
  { id: A2, matricula: 'XA-BBB' },
];

/**
 * Las 11 claves con `ids` (contrato del resolver §2.2) + `nomina_sin_repartir`
 * (16-oct-2026, API 0.0.90, invariante 91) + `gastos_por_pagar` (19-oct-2026,
 * API 0.0.95, invariante 93).
 */
const CLAVES_CON_IDS = [
  'combustible_sin_avion',
  'permisos_sin_avion',
  'repartos_incoherentes',
  'gastos_sin_avion',
  'nomina_sin_repartir',
  'gastos_por_pagar',
  'fijos_con_avion',
  'matricula_recibo_distinta',
  'duplicados_sin_resolver',
  'gastos_bancarios_sin_conciliar',
  'gastos_sin_tc',
  'gastos_sin_comprobante',
  'sin_conciliar',
];

interface Respuesta {
  listo: boolean;
  items: Fila[];
}

const item = (r: Respuesta, clave: string): Fila => {
  const i = r.items.find((x) => x.clave === clave);
  if (!i) throw new Error(`falta el renglón ${clave}`);
  return i;
};

describe('ProfitSharingService.preCierre — `ids` por renglón (PEDIDO 2)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('los 11 renglones llevan `ids` = los registros contados, en su orden, como última llave', async () => {
    const svc = armar({
      aeronave: AERONAVES,
      gasto: [
        gasto('g-sin-avion', { aeronave_id: null }),
        gasto('g-gas', { aeronave_id: null, categoria: 'GAS' }),
        gasto('g-permiso', { aeronave_id: null, categoria: 'PERMISO' }),
        gasto('g-reparto', { monto: 100 }),
        gasto('g-fijo', { categoria: 'FIJO' }),
        gasto('g-matricula', { matricula_ia: 'XA-BBB' }),
        gasto('g-duplicado', { duplicado_sospechado: true }),
        gasto('g-banco', { medio_pago: 'TARJETA_CORP' }),
        gasto('g-sin-tc', { moneda: 'MXN', tc_gasto: null }),
        gasto('g-sin-factura', { estatus_facturacion: 'PENDIENTE' }),
        // NÓMINA sin reparto (invariante 91) y una repartida (no cuenta).
        gasto('g-nomina', {
          aeronave_id: null,
          categoria: 'NOMINA',
          moneda: 'MXN',
          tc_gasto: 17,
        }),
        gasto('g-nomina-ok', {
          aeronave_id: null,
          categoria: 'NOMINA',
          moneda: 'MXN',
          tc_gasto: 17,
        }),
        // Gasto «por pagar» (invariante 93; la BD en memoria contesta la
        // sonda ⇒ con la migración) y uno por pagar YA conciliado (PAGADO).
        gasto('g-por-pagar', { por_pagar: true }),
        gasto('g-por-pagar-banco', { por_pagar: true, conciliado: true }),
        // Un banco ya conciliado y un gasto FUERA del periodo: no cuentan.
        gasto('g-banco-ok', { medio_pago: 'TRANSFERENCIA', conciliado: true }),
        gasto('g-otro-mes', {
          aeronave_id: null,
          fecha_gasto: '2026-10-02',
        }),
      ],
      // Σ parciales 150 > monto 100 ⇒ reparto incoherente.
      gasto_reparto: [
        { gasto_id: 'g-reparto', aeronave_id: A1, monto: 90 },
        { gasto_id: 'g-reparto', aeronave_id: A2, monto: 60 },
        { gasto_id: 'g-nomina-ok', aeronave_id: A1, monto: 50 },
        { gasto_id: 'g-nomina-ok', aeronave_id: A2, monto: 50 },
      ],
      movimiento_bancario: [
        {
          id: 'm-1',
          tipo: 'CARGO',
          monto: 10,
          conciliado: false,
          fecha: '2026-09-03',
        },
        {
          id: 'm-2',
          tipo: 'ABONO',
          monto: 20,
          conciliado: false,
          fecha: '2026-09-04',
        },
        {
          id: 'm-ok',
          tipo: 'CARGO',
          monto: 30,
          conciliado: true,
          fecha: '2026-09-05',
        },
        {
          id: 'm-fuera',
          tipo: 'CARGO',
          monto: 40,
          conciliado: false,
          fecha: '2026-10-01',
        },
      ],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;

    const esperados: Record<string, string[]> = {
      combustible_sin_avion: ['g-gas'],
      permisos_sin_avion: ['g-permiso'],
      repartos_incoherentes: ['g-reparto'],
      gastos_sin_avion: ['g-sin-avion', 'g-gas', 'g-permiso'],
      nomina_sin_repartir: ['g-nomina'],
      gastos_por_pagar: ['g-por-pagar'],
      fijos_con_avion: ['g-fijo'],
      matricula_recibo_distinta: ['g-matricula'],
      duplicados_sin_resolver: ['g-duplicado'],
      gastos_bancarios_sin_conciliar: ['g-banco'],
      gastos_sin_tc: ['g-sin-tc'],
      gastos_sin_comprobante: ['g-sin-factura'],
      sin_conciliar: ['m-1', 'm-2'],
    };
    expect(Object.keys(esperados).sort()).toEqual([...CLAVES_CON_IDS].sort());
    for (const clave of CLAVES_CON_IDS) {
      const i = item(r, clave);
      expect({ clave, ids: i.ids }).toEqual({ clave, ids: esperados[clave] });
      expect({ clave, count: i.count }).toEqual({
        clave,
        count: esperados[clave].length,
      });
      expect(i).not.toHaveProperty('ids_truncado');
      // `ids` es la ÚLTIMA llave (convención de aditivos).
      expect({ clave, ultima: Object.keys(i).at(-1) }).toEqual({
        clave,
        ultima: 'ids',
      });
    }
    // `listo` no cambia por los `ids`: hay bloqueantes con count > 0.
    expect(r.listo).toBe(false);
  });

  it('BD vacía ⇒ `ids: []` con `count: 0` en los 11 (la llave viaja siempre)', async () => {
    const svc = armar({ aeronave: AERONAVES });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    for (const clave of CLAVES_CON_IDS) {
      const i = item(r, clave);
      expect({ clave, count: i.count, ids: i.ids }).toEqual({
        clave,
        count: 0,
        ids: [],
      });
      expect(i).not.toHaveProperty('ids_truncado');
    }
    expect(r.listo).toBe(true);
  });

  it('501 gastos sin avión ⇒ 500 ids + `ids_truncado: true` y `count` 501 (las dos llaves al final)', async () => {
    const gastos = Array.from({ length: 501 }, (_, n) =>
      gasto(`g-${String(n).padStart(3, '0')}`, { aeronave_id: null }),
    );
    const svc = armar({ aeronave: AERONAVES, gasto: gastos });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const i = item(r, 'gastos_sin_avion');
    expect(i.count).toBe(501);
    expect(i.ids).toHaveLength(500);
    expect((i.ids as string[])[0]).toBe('g-000');
    expect((i.ids as string[])[499]).toBe('g-499');
    expect(i.ids_truncado).toBe(true);
    expect(Object.keys(i).slice(-2)).toEqual(['ids', 'ids_truncado']);
  });

  it('«Otros movimientos (VuelaTour)» sin avión (23-oct-2026, invariante 107) NO es pendiente: fuera de `gastos_sin_avion` (no bloquea el cierre)', async () => {
    const svc = armar({
      aeronave: AERONAVES,
      gasto: [
        gasto('g-om', { aeronave_id: null, categoria: 'OTROS_MOVIMIENTOS' }),
        gasto('g-sin-avion', { aeronave_id: null }),
      ],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const i = item(r, 'gastos_sin_avion');
    expect(i.count).toBe(1);
    expect(i.ids).toEqual(['g-sin-avion']);
  });

  it('los renglones con `vuelos[]`/`cobros[]`/`grupos[]`… y los informativos NO llevan `ids`', async () => {
    const svc = armar({ aeronave: AERONAVES });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const sinIds = r.items.filter(
      (i) => !CLAVES_CON_IDS.includes(i.clave as string),
    );
    // Sanidad: el arreglo trae más renglones que los 11.
    expect(sinIds.length).toBeGreaterThan(10);
    for (const i of sinIds) {
      expect({ clave: i.clave, tiene: 'ids' in i }).toEqual({
        clave: i.clave,
        tiene: false,
      });
      expect('ids_truncado' in i).toBe(false);
    }
    // Los dos inversos del PEDIDO 4 resaltan por `vuelos[].id`.
    for (const clave of [
      'tua_pagada_sin_cobrar',
      'transporte_pagado_sin_cotizar',
    ]) {
      expect(Array.isArray(item(r, clave).vuelos)).toBe(true);
    }
    // Los retirados por el PEDIDO 3/4 no vuelven.
    const claves = r.items.map((i) => i.clave);
    expect(claves).not.toContain('pistas_sin_gasto');
    expect(claves).not.toContain('tua_cobrada_sin_pagada');
  });
});
