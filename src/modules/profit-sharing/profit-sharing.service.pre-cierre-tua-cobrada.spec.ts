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

/**
 * PRE-CIERRE · VUELOS CON TUA COBRADA AL CLIENTE SIN TUA PAGADA
 * (13-oct-2026, TUA sistémica, invariante 66). Casos #383 (la IA llamó
 * «Autobuses» a la TUA de ASUR y nada se separó) y #118 (renglones que no
 * cuadran). Aviso NO bloqueante, justo después de
 * `vuelos_sin_gasto_operaciones`; lectura caída ⇒ `lectura_fallida`.
 *
 * Fake: BD EN MEMORIA (mismo intérprete que el spec de
 * `vuelos_sin_gasto_operaciones`) que entrega como mucho max-rows = 1000
 * filas por respuesta, como el PostgREST real; la sonda de
 * `gasto.tua_incluida` responde 42703 con `sinMigracion`.
 */
type Fila = Record<string, unknown>;
type Op = [string, unknown[]];

interface Llamada {
  tabla: string;
  ops: Op[];
}

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

const esSondaTua = (ops: Op[]) =>
  ops.some((o) => o[0] === 'select' && o[1][0] === 'tua_incluida');

function armar(
  tablas: Record<string, Fila[]>,
  opts: {
    fallar?: (tabla: string, ops: Op[]) => boolean;
    sinMigracion?: boolean;
  } = {},
) {
  const llamadas: Llamada[] = [];
  const from = (tabla: string) => {
    const ll: Llamada = { tabla, ops: [] };
    llamadas.push(ll);
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
        ll.ops.push([m, args]);
        return q;
      };
    }
    const resolver = (): { data: Fila[] | null; error: unknown } => {
      if (tabla === 'gasto' && esSondaTua(ll.ops) && opts.sinMigracion) {
        return {
          data: null,
          error: {
            code: '42703',
            message: 'column gasto.tua_incluida does not exist',
          },
        };
      }
      if (opts.fallar?.(tabla, ll.ops)) {
        return {
          data: null,
          error: { code: '57014', message: 'canceling statement' },
        };
      }
      let filas = (tablas[tabla] ?? []).filter((f) =>
        ll.ops.every((o) => aplica(f, o)),
      );
      const ordenes = ll.ops.filter((o) => o[0] === 'order');
      if (ordenes.length > 0) {
        filas = [...filas].sort((a, b) => {
          for (const [, [col, o]] of ordenes) {
            const c = comparar(
              valor(a, col as string),
              valor(b, col as string),
            );
            if (c) {
              return (o as { ascending?: boolean } | undefined)?.ascending ===
                false
                ? -c
                : c;
            }
          }
          return 0;
        });
      }
      const rango = ll.ops.find((o) => o[0] === 'range')?.[1] as
        | [number, number]
        | undefined;
      const [a, b] = rango ?? [0, Number.MAX_SAFE_INTEGER];
      filas = filas.slice(a, Math.min(b + 1, a + MAX_ROWS));
      const limite = ll.ops.find((o) => o[0] === 'limit')?.[1][0];
      if (typeof limite === 'number') filas = filas.slice(0, limite);
      return { data: filas, error: null };
    };
    q.maybeSingle = () => {
      const r = resolver();
      return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error });
    };
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(res, rej);
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const conciliacion = {
    cobrosSinBanco: jest
      .fn()
      .mockResolvedValue({ data: [], total: 0, por_moneda: [] }),
  } as unknown as ConciliacionService;
  const nada = {} as never;
  const svc = new ProfitSharingService(supabase, nada, nada, conciliacion);
  return { svc, llamadas };
}

const PERIODO = { desde: '2026-10-01', hasta: '2026-10-31' };
const CLAVE = 'tua_cobrada_sin_pagada';

interface Respuesta {
  listo: boolean;
  items: Fila[];
}

const itemDe = (r: Respuesta) => r.items.find((i) => i.clave === CLAVE)!;

const AERONAVES: Fila[] = [
  { id: 'av-vgv', matricula: 'XA-VGV' },
  { id: 'av-990', matricula: 'N990GG' },
];

/** Vuelo PROPIO completado de octubre con TUAS cobrada (25 + 75 = 100 USD). */
function vuelo(id: string, folio: number, extra: Fila = {}): Fila {
  return {
    id,
    folio,
    estado: 'COMPLETADO',
    fecha_vuelo: '2026-10-08T15:00:00+00:00',
    aeronave_id: 'av-vgv',
    es_externo: false,
    cliente_id: null,
    monto_total_usd: 1000,
    tc_usd_mxn: 18,
    calculo_snapshot: {
      desglose: [
        { clave: 'TIEMPO_VUELO', monto_usd: 900 },
        { clave: 'TUAS', monto_usd: 25 },
        { clave: 'TUAS', monto_usd: 75 },
      ],
    },
    ...extra,
  };
}

function gasto(id: string, vueloId: string, extra: Fila = {}): Fila {
  return {
    id,
    vuelo_id: vueloId,
    aeronave_id: 'av-vgv',
    categoria: 'OPERACIONES',
    monto: 1925.27,
    propina: 0,
    moneda: 'MXN',
    // Con T.C. propio: un MXN sin T.C. es otro bloqueante (gastos_sin_tc).
    tc_gasto: 18,
    fecha_gasto: '2026-10-08',
    notas: 'ASUR CUN',
    valor_ia_extraido: null,
    estatus_facturacion: 'FACTURADA',
    conciliado: true,
    ...extra,
  };
}

/** La consulta de gastos de ESTE renglón (sin filtro de categoría). */
const consultasTua = (llamadas: Llamada[]) =>
  llamadas.filter(
    (l) =>
      l.tabla === 'gasto' &&
      l.ops.some(
        (o) =>
          o[0] === 'select' &&
          String(o[1][0]).startsWith('id, vuelo_id, categoria, monto, propina'),
      ),
  );

describe('ProfitSharingService.preCierre — TUA cobrada sin TUA pagada (13-oct-2026)', () => {
  it('lista los propios con TUA cobrada sin gasto que la pague, con monto_usd, y NO bloquea', async () => {
    const { svc } = armar({
      aeronave: AERONAVES,
      vuelo: [
        // #384: ASUR con la TUA metida en «Autobuses» (sin señal) ⇒ listado.
        vuelo('v384', 384, { fecha_vuelo: '2026-10-08T15:00:00+00:00' }),
        // #417: sin ningún gasto ⇒ listado.
        vuelo('v417', 417, {
          fecha_vuelo: '2026-10-20T15:00:00+00:00',
          aeronave_id: 'av-990',
          calculo_snapshot: {
            desglose: [
              { clave: 'TIEMPO_VUELO', monto_usd: 950 },
              { clave: 'TUAS', monto_usd: 50 },
            ],
          },
        }),
        // #390: gasto TUAS ⇒ pagada ⇒ NO.
        vuelo('v390', 390),
        // #391: la oficina fijó la TUA incluida ⇒ pagada ⇒ NO.
        vuelo('v391', 391),
        // #392: renglón «Tarifa TUA» que cuadra ⇒ pagada ⇒ NO.
        vuelo('v392', 392),
      ],
      gasto: [
        gasto('g384', 'v384', {
          valor_ia_extraido: {
            conceptos: [
              { concepto: 'Operaciones', monto: 1365.64 },
              { concepto: 'Autobuses', monto: 559.63 },
            ],
          },
        }),
        gasto('g390', 'v390', { categoria: 'TUAS', monto: 1800 }),
        gasto('g391', 'v391', { tua_incluida: '559.63' }),
        gasto('g392', 'v392', {
          valor_ia_extraido: {
            conceptos: [
              { concepto: 'Operaciones', monto: 1365.64 },
              { concepto: 'Tarifa TUA', monto: 559.63 },
            ],
          },
        }),
      ],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const item = itemDe(r);
    expect(item).toMatchObject({
      titulo: 'Vuelos con TUA cobrada al cliente sin TUA pagada',
      count: 2,
      monto_usd: 150,
      lectura_fallida: false,
    });
    expect(item.vuelos).toEqual([
      {
        id: 'v384',
        folio: 384,
        fecha_vuelo: '2026-10-08T15:00:00+00:00',
        matricula: 'XA-VGV',
        tua_cobrada_usd: 100,
      },
      {
        id: 'v417',
        folio: 417,
        fecha_vuelo: '2026-10-20T15:00:00+00:00',
        matricula: 'N990GG',
        tua_cobrada_usd: 50,
      },
    ]);
    expect(String(item.detalle)).toMatch(/^Vuelos completados del periodo/);
    // Justo después de vuelos_sin_gasto_operaciones (y antes de externos).
    const claves = r.items.map((i) => i.clave);
    expect(claves.indexOf(CLAVE)).toBe(
      claves.indexOf('vuelos_sin_gasto_operaciones') + 1,
    );
    expect(claves.indexOf('externos_sin_honorario')).toBe(
      claves.indexOf(CLAVE) + 1,
    );
    // Aviso, no candado: el periodo sigue «listo» y no es informativo.
    expect(r.listo).toBe(true);
    expect(item).not.toHaveProperty('informativo');
  });

  it('un gasto TUAS de OTRO mes SÍ cuenta; la consulta va por vuelo_id, sin fecha ni categoría', async () => {
    const { svc, llamadas } = armar({
      aeronave: AERONAVES,
      vuelo: [vuelo('v1', 1)],
      gasto: [
        gasto('g1', 'v1', {
          categoria: 'TUAS',
          monto: 1800,
          fecha_gasto: '2026-11-03',
        }),
      ],
    });
    const item = itemDe(await svc.preCierre(PERIODO));
    expect(item).toMatchObject({ count: 0, lectura_fallida: false });
    const q = consultasTua(llamadas);
    expect(q).toHaveLength(1);
    expect(q[0].ops).toContainEqual(['in', ['vuelo_id', ['v1']]]);
    expect(
      q[0].ops.some(
        (o) => o[1][0] === 'fecha_gasto' || o[1][0] === 'categoria',
      ),
    ).toBe(false);
    expect(String(q[0].ops.find((o) => o[0] === 'select')?.[1][0])).toBe(
      'id, vuelo_id, categoria, monto, propina, notas, valor_ia_extraido, tua_incluida',
    );
  });

  it('ANTI-CAP: 1 vuelo con 1,001 gastos y la TUA en el último ⇒ NO se lista (páginas [0,999] y [1000,1999])', async () => {
    const gastos: Fila[] = [];
    for (let i = 0; i < 1000; i += 1) {
      gastos.push(gasto(`g${String(i).padStart(4, '0')}`, 'v1'));
    }
    gastos.push(gasto('g9999', 'v1', { categoria: 'TUAS', monto: 100 }));
    const { svc, llamadas } = armar({
      aeronave: AERONAVES,
      vuelo: [vuelo('v1', 1)],
      gasto: gastos,
    });
    const item = itemDe(await svc.preCierre(PERIODO));
    expect(item).toMatchObject({ count: 0, lectura_fallida: false });
    const q = consultasTua(llamadas);
    expect(q.map((l) => l.ops.find((o) => o[0] === 'range')?.[1])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    for (const l of q) {
      expect(l.ops).toContainEqual(['order', ['id', { ascending: true }]]);
    }
  });

  it('externo y cancelado ⇒ fuera (y sin vuelos candidatos no hay consulta)', async () => {
    const { svc, llamadas } = armar({
      aeronave: AERONAVES,
      vuelo: [
        vuelo('vx', 10, { es_externo: true }),
        vuelo('vc', 11, { estado: 'CANCELADO' }),
      ],
    });
    const item = itemDe(await svc.preCierre(PERIODO));
    expect(item).toMatchObject({ count: 0, monto_usd: 0, vuelos: [] });
    expect(consultasTua(llamadas)).toHaveLength(0);
  });

  it('lectura que falla ⇒ count 0, monto_usd 0, lectura_fallida y detalle FALLIDA, sin tumbar el pre-cierre', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { svc } = armar(
      { aeronave: AERONAVES, vuelo: [vuelo('v1', 1)] },
      {
        fallar: (tabla, ops) =>
          tabla === 'gasto' &&
          ops.some(
            (o) =>
              o[0] === 'select' &&
              String(o[1][0]).startsWith('id, vuelo_id, categoria, monto'),
          ),
      },
    );
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('TUA cobrada sin pagada no disponible'),
    );
    warn.mockRestore();
    expect(itemDe(r)).toMatchObject({
      count: 0,
      monto_usd: 0,
      vuelos: [],
      lectura_fallida: true,
      detalle:
        'No se pudo verificar la TUA pagada de los vuelos del periodo: revisa los gastos de aeropuerto y «Otros movimientos» del Balance general antes de cerrar.',
    });
    expect(r.listo).toBe(true);
  });

  it('sin la migración (sonda en false) ⇒ el select NO nombra tua_incluida', async () => {
    const { svc, llamadas } = armar(
      { aeronave: AERONAVES, vuelo: [vuelo('v1', 1)] },
      { sinMigracion: true },
    );
    const item = itemDe(await svc.preCierre(PERIODO));
    expect(item).toMatchObject({ count: 1, lectura_fallida: false });
    const q = consultasTua(llamadas);
    expect(q).toHaveLength(1);
    expect(String(q[0].ops.find((o) => o[0] === 'select')?.[1][0])).toBe(
      'id, vuelo_id, categoria, monto, propina, notas, valor_ia_extraido',
    );
  });
});
