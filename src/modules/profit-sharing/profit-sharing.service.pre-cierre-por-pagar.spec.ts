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
import {
  CLAVES_BLOQUEANTES_PRECIERRE,
  ProfitSharingService,
} from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';
import type { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import { cfgInicio } from '../../common/inicio-oficial.fixture-spec';

/**
 * PRE-CIERRE · `gastos_por_pagar` (19-oct-2026, API 0.0.95, invariante 93):
 * renglón BLOQUEANTE con los gastos del periodo cuyo estado ≠ PAGADO
 * (`por_pagar` y sin conciliar), justo después de `nomina_sin_repartir`
 * (count, monto por moneda, ids como últimas llaves). Lectura caída ⇒ count
 * 0 + `lectura_fallida`; sin la migración ⇒ count 0 sin `lectura_fallida`.
 *
 * Fake: BD EN MEMORIA (el intérprete del spec de la nómina, con max-rows
 * 1000). `sinPorPagar` = la columna no existe (42703 a todo select que la
 * nombre); `fallarPorPagar` hace fallar SOLO la lectura del renglón.
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

function armar(
  tablas: Record<string, Fila[]>,
  opts: {
    sinPorPagar?: boolean;
    fallarPorPagar?: boolean;
    inicio?: string | null;
  } = {},
) {
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
    const resolver = (): { data: Fila[] | null; error: unknown } => {
      const sel = ops.find((o) => o[0] === 'select')?.[1][0];
      const nombra = typeof sel === 'string' && /\bpor_pagar\b/.test(sel);
      if (tabla === 'gasto' && nombra && opts.sinPorPagar) {
        return {
          data: null,
          error: {
            code: '42703',
            message: 'column gasto.por_pagar does not exist',
          },
        };
      }
      if (
        opts.fallarPorPagar &&
        tabla === 'gasto' &&
        nombra &&
        sel !== 'por_pagar'
      ) {
        return { data: null, error: { message: 'fetch failed' } };
      }
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
      Promise.resolve({ data: resolver().data?.[0] ?? null, error: null });
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
  const tipoCambio = {
    oficialDetallePara: jest.fn().mockResolvedValue(null),
  } as unknown as TipoCambioService;
  const nada = {} as never;
  const svc = new ProfitSharingService(
    supabase,
    nada,
    tipoCambio,
    conciliacion,
    opts.inicio !== undefined
      ? (cfgInicio(opts.inicio) as unknown as ConfiguracionService)
      : undefined,
  );
  // Lunes 19-oct-2026 10:00 Cancún.
  svc.ahora = () => new Date('2026-10-19T15:00:00Z');
  return svc;
}

const PERIODO = { desde: '2026-10-01', hasta: '2026-10-31' };
const A1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const AERONAVES: Fila[] = [{ id: A1, matricula: 'XA-AAA' }];

/** Gasto «limpio» (MXN con T.C., facturado, con avión): no ensucia nada. */
const gasto = (id: string, extra: Fila = {}): Fila => ({
  id,
  vuelo_id: null,
  aeronave_id: A1,
  escala_id: null,
  categoria: 'INDIRECTO',
  monto: '1000.00',
  moneda: 'MXN',
  tc_gasto: 17,
  fecha_gasto: '2026-10-15',
  estatus_facturacion: 'FACTURADA',
  medio_pago: 'EFECTIVO',
  conciliado: false,
  duplicado_sospechado: false,
  matricula_ia: null,
  por_pagar: false,
  ...extra,
});

interface Respuesta {
  listo: boolean;
  bloqueantes?: string[];
  items: Fila[];
}
const item = (r: Respuesta, clave: string): Fila => {
  const i = r.items.find((x) => x.clave === clave);
  if (!i) throw new Error(`falta el renglón ${clave}`);
  return i;
};

describe('ProfitSharingService.preCierre — `gastos_por_pagar` (invariante 93)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('es BLOQUEANTE, justo después de `nomina_sin_repartir`', () => {
    expect(CLAVES_BLOQUEANTES_PRECIERRE).toContain('gastos_por_pagar');
    expect(CLAVES_BLOQUEANTES_PRECIERRE.indexOf('gastos_por_pagar')).toBe(
      CLAVES_BLOQUEANTES_PRECIERRE.indexOf('nomina_sin_repartir') + 1,
    );
  });

  it('por pagar y vencidos del periodo: count, monto por moneda, ids ÚLTIMOS; bloquea `listo`', async () => {
    const svc = armar({
      aeronave: AERONAVES,
      gasto: [
        gasto('g-pagado'),
        // Por pagar (fecha futura del mes).
        gasto('g-futuro', { por_pagar: true, fecha_gasto: '2026-10-25' }),
        // Vencido (fecha pasada, sigue por pagar).
        gasto('g-vencido', {
          por_pagar: true,
          fecha_gasto: '2026-10-10',
          monto: '250.50',
        }),
        // En dólares: su monto va aparte.
        gasto('g-usd', {
          por_pagar: true,
          fecha_gasto: '2026-10-20',
          moneda: 'USD',
          monto: '40.00',
        }),
        // Conciliado ⇒ PAGADO aunque la columna diga true.
        gasto('g-conc', { por_pagar: true, conciliado: true }),
        // De OTRO mes: no es de este periodo.
        gasto('g-sep', { por_pagar: true, fecha_gasto: '2026-09-30' }),
      ],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const i = item(r, 'gastos_por_pagar');
    // El orden de los ids es el de la lectura (el panel no depende de él).
    expect({ ...i, ids: [...(i.ids as string[])].sort() }).toEqual({
      clave: 'gastos_por_pagar',
      titulo: 'Gastos por pagar sin confirmar',
      detalle:
        '3 gastos siguen «por pagar» (1 vencido): márcalos pagados con la fecha real del pago, o elimínalos si no se pagaron.',
      count: 3,
      monto_mxn: 1250.5,
      monto_usd: 40,
      ids: ['g-futuro', 'g-usd', 'g-vencido'],
    });
    expect(Object.keys(i).at(-1)).toBe('ids');
    expect(r.listo).toBe(false);
    const claves = r.items.map((x) => x.clave);
    expect(claves.indexOf('gastos_por_pagar')).toBe(
      claves.indexOf('nomina_sin_repartir') + 1,
    );
  });

  it('nada por pagar ⇒ count 0, «Ningún gasto…», sin `monto_usd`, ids [] y no bloquea', async () => {
    const svc = armar({
      aeronave: AERONAVES,
      gasto: [
        gasto('g-1'),
        gasto('g-conc', { por_pagar: true, conciliado: true }),
      ],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(item(r, 'gastos_por_pagar')).toEqual({
      clave: 'gastos_por_pagar',
      titulo: 'Gastos por pagar sin confirmar',
      detalle: 'Ningún gasto del periodo quedó por pagar.',
      count: 0,
      monto_mxn: 0,
      ids: [],
    });
    expect(r.listo).toBe(true);
  });

  it('uno solo y vencido ⇒ singular', async () => {
    const svc = armar({
      aeronave: AERONAVES,
      gasto: [gasto('g-v', { por_pagar: true, fecha_gasto: '2026-10-18' })],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(item(r, 'gastos_por_pagar').detalle).toBe(
      '1 gasto sigue «por pagar» (1 vencido): márcalo pagado con la fecha real del pago, o elimínalo si no se pagó.',
    );
  });

  it('lectura caída ⇒ count 0 + `lectura_fallida` + «No se pudieron verificar…» (el pre-cierre no se cae)', async () => {
    const svc = armar(
      {
        aeronave: AERONAVES,
        gasto: [gasto('g-f', { por_pagar: true, fecha_gasto: '2026-10-25' })],
      },
      { fallarPorPagar: true },
    );
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(item(r, 'gastos_por_pagar')).toEqual({
      clave: 'gastos_por_pagar',
      titulo: 'Gastos por pagar sin confirmar',
      detalle: 'No se pudieron verificar los gastos por pagar del periodo.',
      count: 0,
      monto_mxn: 0,
      lectura_fallida: true,
      ids: [],
    });
  });

  it('SIN la migración ⇒ count 0 sin `lectura_fallida` (no bloquea)', async () => {
    const svc = armar(
      {
        aeronave: AERONAVES,
        gasto: [gasto('g-f', { por_pagar: true, fecha_gasto: '2026-10-25' })],
      },
      { sinPorPagar: true },
    );
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const i = item(r, 'gastos_por_pagar');
    expect(i).toEqual({
      clave: 'gastos_por_pagar',
      titulo: 'Gastos por pagar sin confirmar',
      detalle: 'Ningún gasto del periodo quedó por pagar.',
      count: 0,
      monto_mxn: 0,
      ids: [],
    });
    expect(r.listo).toBe(true);
  });

  it('PAGINADA: 1,050 por pagar (max-rows 1000) ⇒ cuenta los 1,050 (ids topados a 500)', async () => {
    const muchos = Array.from({ length: 1050 }, (_, k) =>
      gasto(`g-${String(k).padStart(4, '0')}`, {
        por_pagar: true,
        fecha_gasto: '2026-10-25',
        monto: '1.00',
      }),
    );
    const svc = armar({ aeronave: AERONAVES, gasto: muchos });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const i = item(r, 'gastos_por_pagar');
    expect(i.count).toBe(1050);
    expect(i.monto_mxn).toBe(1050);
    expect((i.ids as string[]).length).toBe(500);
    expect(i.ids_truncado).toBe(true);
  });
});
