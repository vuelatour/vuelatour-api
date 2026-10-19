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
 * PRE-CIERRE · `nomina_sin_repartir` (16-oct-2026, API 0.0.90, invariante
 * 91): renglón BLOQUEANTE con los pagos de NÓMINA del periodo SIN ninguna
 * fila en `gasto_reparto` (count, monto por moneda, ids como últimas
 * llaves), justo después de `gastos_sin_avion`. Lectura caída ⇒ count 0 +
 * `lectura_fallida`.
 *
 * Fake: BD EN MEMORIA (mismo intérprete que el spec de los `ids`, con
 * max-rows 1000); `fallarRepartoExistencia` hace fallar SOLO la lectura de
 * existencia (`select('gasto_id')`) del renglón.
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
  opts: { fallarRepartoExistencia?: boolean; inicio?: string | null } = {},
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
      if (
        opts.fallarRepartoExistencia &&
        tabla === 'gasto_reparto' &&
        ops.some((o) => o[0] === 'select' && o[1][0] === 'gasto_id')
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
  return new ProfitSharingService(
    supabase,
    nada,
    tipoCambio,
    conciliacion,
    opts.inicio !== undefined
      ? (cfgInicio(opts.inicio) as unknown as ConfiguracionService)
      : undefined,
  );
}

const PERIODO = { desde: '2026-09-01', hasta: '2026-09-30' };
const A1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const A2 = 'a2a2a2a2-0000-4000-8000-000000000002';
const AERONAVES: Fila[] = [
  { id: A1, matricula: 'XA-AAA' },
  { id: A2, matricula: 'XA-BBB' },
];

/** Pago de nómina «limpio» (MXN con T.C., facturado, en efectivo). */
const nomina = (id: string, extra: Fila = {}): Fila => ({
  id,
  vuelo_id: null,
  aeronave_id: null,
  escala_id: null,
  categoria: 'NOMINA',
  monto: '1000.00',
  moneda: 'MXN',
  tc_gasto: 17,
  fecha_gasto: '2026-09-30',
  estatus_facturacion: 'FACTURADA',
  medio_pago: 'EFECTIVO',
  conciliado: false,
  duplicado_sospechado: false,
  matricula_ia: null,
  ...extra,
});

/** Septiembre REAL (7 pagos, $25,757.80 MXN) + casos de control. */
const SEPTIEMBRE = [1500, 4725.6, 3566, 6830, 4725.6, 1910.6, 2500].map(
  (monto, i) =>
    nomina(`g-sep-${i}`, {
      monto: monto.toFixed(2),
      fecha_gasto: i === 0 ? '2026-09-11' : '2026-09-30',
    }),
);

interface Respuesta {
  listo: boolean;
  items: Fila[];
}
const item = (r: Respuesta, clave: string): Fila => {
  const i = r.items.find((x) => x.clave === clave);
  if (!i) throw new Error(`falta el renglón ${clave}`);
  return i;
};

describe('ProfitSharingService.preCierre — `nomina_sin_repartir` (invariante 91)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('es BLOQUEANTE (fuente única de `listo` y de la previa del cierre)', () => {
    expect(CLAVES_BLOQUEANTES_PRECIERRE).toContain('nomina_sin_repartir');
    // 8 desde el 0.0.95 (invariante 93): `gastos_por_pagar` justo después.
    expect(CLAVES_BLOQUEANTES_PRECIERRE).toHaveLength(8);
    expect(CLAVES_BLOQUEANTES_PRECIERRE.indexOf('gastos_por_pagar')).toBe(
      CLAVES_BLOQUEANTES_PRECIERRE.indexOf('nomina_sin_repartir') + 1,
    );
  });

  it('septiembre REAL sin repartir: 7 pagos, $25,757.80 MXN, sus ids como ÚLTIMA llave; bloquea `listo`', async () => {
    const svc = armar({ aeronave: AERONAVES, gasto: SEPTIEMBRE });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const i = item(r, 'nomina_sin_repartir');
    expect(i).toEqual({
      clave: 'nomina_sin_repartir',
      titulo: 'Nómina sin repartir entre aviones',
      detalle:
        '7 pagos de nómina por $25,757.80 MXN no se han repartido entre aviones: no entran a ningún balance ni al reparto. Repártelos en Nómina.',
      count: 7,
      monto_mxn: 25757.8,
      ids: SEPTIEMBRE.map((g) => g.id),
    });
    expect(Object.keys(i).at(-1)).toBe('ids');
    expect(r.listo).toBe(false);
    // Posición: justo después de la bandeja `gastos_sin_avion`.
    const claves = r.items.map((x) => x.clave);
    expect(claves.indexOf('nomina_sin_repartir')).toBe(
      claves.indexOf('gastos_sin_avion') + 1,
    );
    // La nómina NO es «sin avión» (no cambia la bandeja).
    expect(item(r, 'gastos_sin_avion').count).toBe(0);
  });

  it('la REPARTIDA no cuenta; la de OTRO mes tampoco; los dólares van aparte (`monto_usd` solo si hay)', async () => {
    const svc = armar({
      aeronave: AERONAVES,
      gasto: [
        nomina('g-sin'),
        nomina('g-rep'),
        nomina('g-usd', { monto: '100.00', moneda: 'USD', tc_gasto: null }),
        nomina('g-oct', { fecha_gasto: '2026-10-15' }),
        nomina('g-ago', { fecha_gasto: '2026-08-31' }),
        // Otra categoría de empresa sin reparto: no es nómina.
        nomina('g-otro', { categoria: 'OTRO' }),
      ],
      gasto_reparto: [
        { gasto_id: 'g-rep', aeronave_id: A1, monto: 500 },
        { gasto_id: 'g-rep', aeronave_id: A2, monto: 500 },
      ],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const i = item(r, 'nomina_sin_repartir');
    expect(i.count).toBe(2);
    expect(i.ids).toEqual(['g-sin', 'g-usd']);
    expect(i.monto_mxn).toBe(1000);
    expect(i.monto_usd).toBe(100);
    expect(i.detalle).toBe(
      '2 pagos de nómina por $1,000 MXN y $100 USD no se han repartido entre aviones: no entran a ningún balance ni al reparto. Repártelos en Nómina.',
    );
    expect(Object.keys(i).at(-1)).toBe('ids');
  });

  it('toda repartida (o sin nómina) ⇒ count 0, «Toda la nómina del periodo está repartida.», ids [] y no bloquea', async () => {
    const svc = armar({
      aeronave: AERONAVES,
      gasto: [nomina('g-rep')],
      gasto_reparto: [{ gasto_id: 'g-rep', aeronave_id: A1, monto: 1000 }],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(item(r, 'nomina_sin_repartir')).toEqual({
      clave: 'nomina_sin_repartir',
      titulo: 'Nómina sin repartir entre aviones',
      detalle: 'Toda la nómina del periodo está repartida.',
      count: 0,
      monto_mxn: 0,
      ids: [],
    });
    expect(r.listo).toBe(true);
    const vacio = (await armar({ aeronave: AERONAVES }).preCierre(
      PERIODO,
    )) as unknown as Respuesta;
    expect(item(vacio, 'nomina_sin_repartir').count).toBe(0);
    expect(vacio.listo).toBe(true);
  });

  it('lectura de los repartos caída ⇒ count 0 + `lectura_fallida` + «No se pudo verificar…» (el pre-cierre no se cae)', async () => {
    const svc = armar(
      { aeronave: AERONAVES, gasto: [nomina('g-sin')] },
      { fallarRepartoExistencia: true },
    );
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(item(r, 'nomina_sin_repartir')).toEqual({
      clave: 'nomina_sin_repartir',
      titulo: 'Nómina sin repartir entre aviones',
      detalle: 'No se pudo verificar la nómina del periodo.',
      count: 0,
      monto_mxn: 0,
      lectura_fallida: true,
      ids: [],
    });
  });

  it('revisión P3 (19-oct-2026): la nómina sin verificar deja `listo: false` (no se cierra un «0» que nadie leyó)', async () => {
    const r = (await armar(
      { aeronave: AERONAVES, gasto: [nomina('g-sin')] },
      { fallarRepartoExistencia: true },
    ).preCierre(PERIODO)) as unknown as Respuesta;
    expect(item(r, 'nomina_sin_repartir')).toMatchObject({
      count: 0,
      lectura_fallida: true,
    });
    expect(r.listo).toBe(false);
  });

  it('INICIO OFICIAL (invariante 86): un periodo que cruza el 1-sep solo cuenta la nómina desde el inicio', async () => {
    const svc = armar(
      {
        aeronave: AERONAVES,
        gasto: [
          nomina('g-ago', { fecha_gasto: '2026-08-25' }),
          nomina('g-sep', { fecha_gasto: '2026-09-02' }),
        ],
      },
      { inicio: '2026-09-01' },
    );
    const r = (await svc.preCierre({
      desde: '2026-08-15',
      hasta: '2026-09-30',
    })) as unknown as Respuesta;
    expect(item(r, 'nomina_sin_repartir').ids).toEqual(['g-sep']);
  });
});
