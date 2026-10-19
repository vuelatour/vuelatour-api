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
 * nombre); `fallarPorPagar` hace fallar SOLO la lectura del renglón. Las
 * filas de `gasto` salen PROYECTADAS como en PostgREST (`proyectar`).
 */
type Fila = Record<string, unknown>;
type Op = [string, unknown[]];

const MAX_ROWS = 1000;
const ISO = /^\d{4}-\d{2}-\d{2}T/;

/** Ítems de primer nivel de un select (las comas de un embed no parten). */
function itemsDeSelect(sel: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of sel) {
    if (ch === '(') nivel += 1;
    else if (ch === ')') nivel -= 1;
    if (ch === ',' && nivel === 0) {
      out.push(actual.trim());
      actual = '';
    } else {
      actual += ch;
    }
  }
  if (actual.trim()) out.push(actual.trim());
  return out;
}

/**
 * PROYECCIÓN como PostgREST (segunda pasada de la revisión, 19-oct-2026): la
 * fila trae SOLO lo que el select nombra. `alias:expr` toma `alias`; un embed
 * `alias:fk(cols)` llega proyectado a SUS columnas (null si la fila no lo
 * trae); sin el embed en el select, la fila NO trae `alias`. Antes el fake
 * devolvía la fila completa con su `vuelo` y ninguna prueba fijaba la
 * LECTURA del renglón: un select sin el embed (el del 0.0.95), o sin
 * `periodo_contable, fecha_contable` con la sonda del cierre encendida,
 * pasaba todas las pruebas de P1.
 */
function proyectar(sel: string, fila: Fila): Fila {
  const out: Fila = {};
  for (const item of itemsDeSelect(sel)) {
    if (item === '*') {
      Object.assign(out, fila);
      continue;
    }
    const embed = /^(\w+)(?::[\w!]+)?\((.*)\)$/s.exec(item);
    if (embed) {
      const [, alias, cols] = embed;
      const raw = fila[alias];
      const obj: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
      out[alias] =
        obj != null && typeof obj === 'object'
          ? proyectar(cols, obj as Fila)
          : null;
      continue;
    }
    const conAlias = /^(\w+):/.exec(item);
    const llave = conAlias ? conAlias[1] : item;
    out[llave] = fila[llave] ?? null;
  }
  return out;
}

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
    /** Sin la migración del cierre (20261016000004): 42703 / 42P01. */
    sinCierre?: boolean;
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
      if (opts.sinCierre) {
        if (tabla === 'cierre_mes' || tabla === 'cierre_mes_vuelo') {
          return {
            data: null,
            error: {
              code: '42P01',
              message: `relation ${tabla} does not exist`,
            },
          };
        }
        if (
          typeof sel === 'string' &&
          /\b(periodo_contable|fecha_contable)\b/.test(sel)
        ) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column vuelo.periodo_contable does not exist',
            },
          };
        }
      }
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
      // Los filtros ya corrieron sobre la fila completa (como la BD); lo que
      // VUELVE es solo lo que el select nombra.
      if (tabla === 'gasto' && typeof sel === 'string') {
        filas = filas.map((f) => proyectar(sel, f));
      }
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
      // ADITIVO (revisión P2, 19-oct-2026): sin nómina, `[]`.
      ids_nomina: [],
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
      ids_nomina: [],
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
      ids_nomina: [],
      ids: [],
    });
    // Revisión P3 (19-oct-2026): un bloqueante sin verificar NO deja cerrar
    // (antes `listo` quedaba en true con este mundo limpio).
    expect(r.listo).toBe(false);
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
      ids_nomina: [],
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

/**
 * Revisión del 19-oct-2026.
 *  - P1: el renglón cuenta por MES CONTABLE, la MISMA regla del candado de
 *    mes cerrado (eje vuelo ⇒ el mes contable del vuelo; eje gasto ⇒
 *    `fecha_gasto`). Antes filtraba por `fecha_gasto`: un por pagar de un
 *    vuelo de septiembre fechado en octubre no frenaba el cierre de
 *    septiembre y, cerrado éste, quedaba atrapado (409 MES_CERRADO).
 *  - P2: `ids_nomina` (subconjunto de `ids`) justo antes de `ids`.
 *  - P4: un gasto MXN sin T.C. con fecha FUTURA (por pagar) no cuenta en
 *    `gastos_sin_tc` ni se busca su oficial (con la migración).
 */
describe('ProfitSharingService.preCierre — `gastos_por_pagar` por MES CONTABLE (P1), `ids_nomina` (P2) y sin T.C. futuro (P4)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  const SEP = { desde: '2026-09-01', hasta: '2026-09-30' };
  const V400 = 'v4000000-0000-4000-8000-000000000400';
  /** El vuelo embebido como lo trae PostgREST (con la migración del cierre). */
  const vuelo = (fechaVuelo: string, extra: Fila = {}): Fila => ({
    fecha_vuelo: fechaVuelo,
    periodo_contable: null,
    fecha_contable: fechaVuelo,
    aeronave_id: A1,
    es_externo: false,
    ...extra,
  });
  const porPagarDeVuelo = (id: string, extra: Fila): Fila =>
    gasto(id, {
      por_pagar: true,
      vuelo_id: V400,
      categoria: 'TAXI',
      medio_pago: 'EFECTIVO',
      ...extra,
    });
  const enPeriodo = async (
    tablas: Record<string, Fila[]>,
    periodo: { desde: string; hasta: string },
    opts: Parameters<typeof armar>[1] = {},
  ) => {
    const r = (await armar(tablas, opts).preCierre(
      periodo,
    )) as unknown as Respuesta;
    return { r, i: item(r, 'gastos_por_pagar') };
  };

  it('caso 30-sep/01-oct: TAXI por pagar del vuelo #400 (30-sep) fechado el 1-oct ⇒ cuenta en SEPTIEMBRE (bloquea) y NO en octubre', async () => {
    const tablas = {
      aeronave: AERONAVES,
      gasto: [
        porPagarDeVuelo('g-taxi', {
          fecha_gasto: '2026-10-01',
          monto: '500.00',
          vuelo: vuelo('2026-09-30T20:00:00Z'),
        }),
      ],
    };
    const sep = await enPeriodo(tablas, SEP);
    expect(sep.i).toMatchObject({ count: 1, monto_mxn: 500, ids: ['g-taxi'] });
    expect(sep.r.listo).toBe(false);
    const oct = await enPeriodo(tablas, PERIODO);
    expect(oct.i).toMatchObject({ count: 0, ids: [] });
  });

  it('oficina a +11 días: OPERACIONES de un vuelo del 25-sep con fecha de pago 09-oct ⇒ septiembre, no octubre', async () => {
    const tablas = {
      aeronave: AERONAVES,
      gasto: [
        porPagarDeVuelo('g-asur', {
          categoria: 'OPERACIONES',
          medio_pago: 'TRANSFERENCIA',
          fecha_gasto: '2026-10-09',
          monto: '4500.00',
          vuelo: vuelo('2026-09-25T18:00:00Z'),
        }),
      ],
    };
    expect((await enPeriodo(tablas, SEP)).i).toMatchObject({
      count: 1,
      ids: ['g-asur'],
    });
    expect((await enPeriodo(tablas, PERIODO)).i).toMatchObject({ count: 0 });
  });

  it('al revés: HOTEL por pagar fechado el 28-sep de un vuelo del 2-oct ⇒ octubre (el mes de sus libros), no septiembre', async () => {
    const tablas = {
      aeronave: AERONAVES,
      gasto: [
        porPagarDeVuelo('g-hotel', {
          categoria: 'HOTEL',
          fecha_gasto: '2026-09-28',
          vuelo: vuelo('2026-10-02T15:00:00Z'),
        }),
      ],
    };
    expect((await enPeriodo(tablas, SEP)).i).toMatchObject({ count: 0 });
    expect((await enPeriodo(tablas, PERIODO)).i).toMatchObject({
      count: 1,
      ids: ['g-hotel'],
    });
  });

  it('vuelo DIFERIDO a octubre al cerrar septiembre (`fecha_contable` 1-oct): su por pagar cuenta en OCTUBRE', async () => {
    const tablas = {
      aeronave: AERONAVES,
      gasto: [
        porPagarDeVuelo('g-dif', {
          fecha_gasto: '2026-09-30',
          vuelo: vuelo('2026-09-30T20:00:00Z', {
            periodo_contable: '2026-10-01T05:00:00Z',
            fecha_contable: '2026-10-01T05:00:00Z',
          }),
        }),
      ],
    };
    expect((await enPeriodo(tablas, SEP)).i).toMatchObject({ count: 0 });
    expect((await enPeriodo(tablas, PERIODO)).i).toMatchObject({
      count: 1,
      ids: ['g-dif'],
    });
  });

  it('eje GASTO (categoría de EMPRESA aunque traiga vuelo): por su `fecha_gasto`', async () => {
    const tablas = {
      aeronave: AERONAVES,
      gasto: [
        porPagarDeVuelo('g-otro', {
          categoria: 'OTRO',
          fecha_gasto: '2026-10-01',
          vuelo: vuelo('2026-09-30T20:00:00Z'),
        }),
      ],
    };
    expect((await enPeriodo(tablas, SEP)).i).toMatchObject({ count: 0 });
    expect((await enPeriodo(tablas, PERIODO)).i).toMatchObject({
      count: 1,
      ids: ['g-otro'],
    });
  });

  it('SIN la migración del cierre: el eje vuelo usa `fecha_vuelo` (y la lectura no nombra `fecha_contable`)', async () => {
    const tablas = {
      aeronave: AERONAVES,
      gasto: [
        porPagarDeVuelo('g-taxi', {
          fecha_gasto: '2026-10-01',
          vuelo: {
            fecha_vuelo: '2026-09-30T20:00:00Z',
            aeronave_id: A1,
            es_externo: false,
          },
        }),
      ],
    };
    const sep = await enPeriodo(tablas, SEP, { sinCierre: true });
    expect(sep.i).toMatchObject({ count: 1, ids: ['g-taxi'] });
    expect(sep.i).not.toHaveProperty('lectura_fallida');
    expect(
      (await enPeriodo(tablas, PERIODO, { sinCierre: true })).i,
    ).toMatchObject({ count: 0 });
  });

  it('`ids_nomina`: los ids de NÓMINA por pagar (subconjunto de `ids`), justo ANTES de `ids`', async () => {
    const { i } = await enPeriodo(
      {
        aeronave: AERONAVES,
        gasto: [
          gasto('g-taxi', { por_pagar: true, fecha_gasto: '2026-10-25' }),
          gasto('g-nomina', {
            por_pagar: true,
            categoria: 'NOMINA',
            aeronave_id: null,
            medio_pago: 'TRANSFERENCIA',
            fecha_gasto: '2026-10-30',
            monto: '45000.00',
          }),
        ],
      },
      PERIODO,
    );
    expect(i.count).toBe(2);
    expect([...(i.ids as string[])].sort()).toEqual(['g-nomina', 'g-taxi']);
    expect(i.ids_nomina).toEqual(['g-nomina']);
    expect(Object.keys(i).slice(-2)).toEqual(['ids_nomina', 'ids']);
  });

  it('P4: un MXN sin T.C. por pagar con fecha FUTURA no cuenta «sin T.C.» ni se busca su oficial; sin la migración, como el 0.0.94', async () => {
    const tablas = (): Record<string, Fila[]> => ({
      aeronave: AERONAVES,
      gasto: [
        gasto('g-futuro', {
          por_pagar: true,
          tc_gasto: null,
          fecha_gasto: '2026-10-28',
        }),
      ],
    });
    const svc = armar(tablas());
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(item(r, 'gastos_sin_tc')).toMatchObject({ count: 0, ids: [] });
    expect(item(r, 'gastos_por_pagar')).toMatchObject({
      count: 1,
      ids: ['g-futuro'],
    });
    const tc = (
      svc as unknown as {
        tipoCambio: { oficialDetallePara: jest.Mock };
      }
    ).tipoCambio.oficialDetallePara;
    expect(
      (tc.mock.calls as unknown[][]).some((c) =>
        String(c[0]).startsWith('2026-10-28'),
      ),
    ).toBe(false);

    // Sin la migración: el gasto (que nadie marcó por pagar) sigue «sin T.C.».
    const viejo = (await armar(tablas(), { sinPorPagar: true }).preCierre(
      PERIODO,
    )) as unknown as Respuesta;
    expect(item(viejo, 'gastos_sin_tc')).toMatchObject({
      count: 1,
      ids: ['g-futuro'],
    });
  });
});
