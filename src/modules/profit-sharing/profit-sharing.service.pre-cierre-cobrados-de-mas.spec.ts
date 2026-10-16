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
import {
  CLAVE_PRECIERRE_COBRADOS_DE_MAS,
  DETALLE_PRECIERRE_COBRADOS_DE_MAS,
  detalleExplicadosCobradosDeMas,
  renglonVuelosCobradosDeMas,
} from './vuelos-cobrados-de-mas.util';
import {
  CLIENTES_REALES,
  COBROS_REALES,
  VUELOS_REALES,
} from '../../common/cobrado-de-mas.fixture-spec';

// CIERRE DE MES (16-oct-2026, invariante 89): este spec congela la conducta
// SIN la migración 20261016000004 (0.0.87 byte a byte); la conducta con la
// migración vive en los specs `*.cierre-mes.spec.ts`.
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

/**
 * PRE-CIERRE · «VUELOS COBRADOS DE MÁS» (14-oct-2026, API 0.0.78,
 * invariante 77, D14) con los vuelos REALES de prod (15-oct-2026):
 * - agosto 2026 ⇒ #193 y #217 (IVA que la cotización no lleva) CUENTAN
 *   (count 2, $547.99) y #111 (redondeo del T.C.) va en `explicados`;
 * - julio ⇒ count 0 con #81 y #84 (comisión del link pagada por el
 *   cliente) explicados; septiembre ⇒ count 0 con #259 y #285;
 * - el renglón va JUSTO DESPUÉS de `cobros_pendientes`, NO bloquea (`listo`
 *   no cambia), usa el MISMO universo (sin clientes internos) y no lee los
 *   cobros de otros vuelos del cliente (esa causa es solo del snapshot).
 * El conteo de los parciales de `cobros_bancarios_sin_conciliar` vive en
 * `profit-sharing.service.pre-cierre-cobros-parciales.spec`.
 *
 * Fake: BD EN MEMORIA que aplica los filtros de PostgREST del pre-cierre
 * (eq/neq/in/is/not/gte/lte, order, range, limit).
 */
type Fila = Record<string, unknown>;
type Op = [string, unknown[]];

interface Llamada {
  tabla: string;
  ops: Op[];
}

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
    const resolver = () => {
      let filas = (tablas[tabla] ?? []).filter((f) =>
        ll.ops.every((o) => aplica(f, o)),
      );
      const rango = ll.ops.find((o) => o[0] === 'range')?.[1] as
        | [number, number]
        | undefined;
      if (rango) filas = filas.slice(rango[0], rango[1] + 1);
      filas = filas.slice(0, 1000);
      return { data: filas, error: null, count: filas.length };
    };
    q.maybeSingle = () => {
      const r = resolver();
      return Promise.resolve({ data: r.data[0] ?? null, error: null });
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
    ligasUsdTcFueraDeLugar: jest
      .fn()
      .mockResolvedValue({ ligas: [], sin_verificar: 0 }),
  } as unknown as ConciliacionService;
  const nada = {} as never;
  return {
    svc: new ProfitSharingService(supabase, nada, nada, conciliacion),
    llamadas,
  };
}

/** La BD con los 10 vuelos reales y sus cobros (copias: cada prueba la puede editar). */
function prod(): Record<string, Fila[]> {
  return {
    vuelo: Object.values(VUELOS_REALES).map((v) => ({ ...v })),
    cobro_vuelo: COBROS_REALES.map((c) => ({ ...c })),
    cliente: CLIENTES_REALES.map((c) => ({ ...c })),
  };
}

const JULIO = { desde: '2026-07-01', hasta: '2026-07-31' };
const AGOSTO = { desde: '2026-08-01', hasta: '2026-08-31' };
const SEPTIEMBRE = { desde: '2026-09-01', hasta: '2026-09-30' };

interface Respuesta {
  listo: boolean;
  items: Fila[];
}

const renglon = (r: Respuesta) =>
  r.items.find((i) => i.clave === CLAVE_PRECIERRE_COBRADOS_DE_MAS)!;

const id = (folio: number) => VUELOS_REALES[folio].id as string;

const DETALLE_PLURAL =
  'Lo cobrado rebasa el total del vuelo por más de $1.00 USD y la diferencia no se explica sola: IVA que la cotización no lleva, un cobro capturado dos veces o un depósito de otro vuelo. Revisa la card de cobros de cada vuelo. No bloquea el cierre, pero el excedente se reparte como ingreso de VuelaTour. Además hay 2 vuelos con la diferencia explicada (comisión del link pagada por el cliente o redondeo del tipo de cambio) que no requieren acción.';

describe('ProfitSharingService.preCierre — «Vuelos cobrados de más» con los vuelos reales', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('agosto 2026: #193 y #217 cuentan (2 · $547.99, IVA no cotizado) y #111 va en explicados; no bloquea', async () => {
    const { svc } = armar(prod());
    const r = (await svc.preCierre(AGOSTO)) as unknown as Respuesta;
    expect(renglon(r)).toEqual({
      clave: 'vuelos_cobrados_de_mas',
      titulo: 'Vuelos cobrados de más',
      detalle:
        'Lo cobrado rebasa el total del vuelo por más de $1.00 USD y la diferencia no se explica sola: IVA que la cotización no lleva, un cobro capturado dos veces o un depósito de otro vuelo. Revisa la card de cobros de cada vuelo. No bloquea el cierre, pero el excedente se reparte como ingreso de VuelaTour. Además hay 1 vuelo con la diferencia explicada (comisión del link pagada por el cliente o redondeo del tipo de cambio) que no requiere acción.',
      count: 2,
      monto_usd: 547.99,
      vuelos: [
        {
          id: id(193),
          folio: 193,
          saldo_usd: 52,
          excedente_usd: 52,
          causa: 'IVA_NO_COTIZADO',
          causa_etiqueta: 'IVA que la cotización no lleva',
          grupo_folio: null,
        },
        {
          id: id(217),
          folio: 217,
          saldo_usd: 495.99,
          excedente_usd: 495.99,
          causa: 'IVA_NO_COTIZADO',
          causa_etiqueta: 'IVA que la cotización no lleva',
          grupo_folio: null,
        },
      ],
      explicados: [
        {
          id: id(111),
          folio: 111,
          saldo_usd: 1.71,
          excedente_usd: 1.71,
          causa: 'REDONDEO_TC',
          causa_etiqueta: 'redondeo del tipo de cambio',
          grupo_folio: null,
        },
      ],
      explicados_n: 1,
    });
    // NO bloquea: con 2 vuelos por revisar el periodo sigue «listo».
    expect(r.listo).toBe(true);
  });

  it('julio: count 0 con #81 y #84 (comisión del link pagada por el cliente) explicados; #92 (de menos) va en cobros_pendientes', async () => {
    const { svc } = armar(prod());
    const r = (await svc.preCierre(JULIO)) as unknown as Respuesta;
    const item = renglon(r);
    expect(item).toMatchObject({
      count: 0,
      monto_usd: 0,
      vuelos: [],
      explicados_n: 2,
      detalle: DETALLE_PLURAL,
    });
    expect(
      (item.explicados as Fila[]).map((v) => [
        v.folio,
        v.excedente_usd,
        v.causa,
      ]),
    ).toEqual([
      [81, 214.26, 'COMISION_PAGADA_POR_CLIENTE'],
      [84, 202.72, 'COMISION_PAGADA_POR_CLIENTE'],
    ]);
    const pendientes = r.items.find((i) => i.clave === 'cobros_pendientes')!;
    expect(
      (pendientes.vuelos as Fila[]).map((v) => [v.folio, v.saldo_usd]),
    ).toEqual([[92, 15.25]]);
  });

  it('septiembre: count 0 con #259 y #285 (redondeo del T.C.); #315 y #332 de hoy no cobran de más', async () => {
    const { svc } = armar(prod());
    const r = (await svc.preCierre(SEPTIEMBRE)) as unknown as Respuesta;
    const item = renglon(r);
    expect(item).toMatchObject({ count: 0, vuelos: [], explicados_n: 2 });
    expect(
      (item.explicados as Fila[]).map((v) => [
        v.folio,
        v.excedente_usd,
        v.causa,
      ]),
    ).toEqual([
      [259, 8.47, 'REDONDEO_TC'],
      [285, 1.43, 'REDONDEO_TC'],
    ]);
  });

  it('el tope ABSOLUTO de $10 del redondeo (revisión del 15-oct-2026): #259 con $20 de más —el 1 % de su total serían $26— CUENTA como SIN_CAUSA_CLARA', async () => {
    const db = prod();
    const c259 = db.cobro_vuelo.find(
      (c) => c.id === 'b13a2664-1937-40f6-b215-28a970d20069',
    )!;
    // 24,540.01 + 20,000 = 44,540.01 MXN a 17.00 = $2,620.00 sobre $2,600.
    c259.monto = '24540.01';
    const { svc } = armar(db);
    const r = (await svc.preCierre(SEPTIEMBRE)) as unknown as Respuesta;
    const item = renglon(r);
    expect(item).toMatchObject({ count: 1, monto_usd: 20, explicados_n: 1 });
    expect(
      (item.vuelos as Fila[]).map((v) => [v.folio, v.excedente_usd, v.causa]),
    ).toEqual([[259, 20, 'SIN_CAUSA_CLARA']]);
    expect((item.explicados as Fila[]).map((v) => v.folio)).toEqual([285]);
  });

  it('el renglón va JUSTO DESPUÉS de cobros_pendientes y NO entra a los bloqueantes', async () => {
    const { svc } = armar(prod());
    const r = (await svc.preCierre(AGOSTO)) as unknown as Respuesta;
    const claves = r.items.map((i) => i.clave);
    expect(claves.indexOf('vuelos_cobrados_de_mas')).toBe(
      claves.indexOf('cobros_pendientes') + 1,
    );
    expect(claves.filter((c) => c === 'vuelos_cobrados_de_mas')).toHaveLength(
      1,
    );
  });

  it('MISMO universo que cobros_pendientes: cliente interno y cotización abierta fuera', async () => {
    const db = prod();
    const v217 = db.vuelo.find((v) => v.folio === 217)!;
    v217.cotizacion_abierta = true;
    const cliente193 = db.cliente.find(
      (c) => c.id === VUELOS_REALES[193].cliente_id,
    )!;
    cliente193.es_interno = true;
    const { svc } = armar(db);
    const r = (await svc.preCierre(AGOSTO)) as unknown as Respuesta;
    expect(renglon(r)).toMatchObject({
      count: 0,
      vuelos: [],
      explicados_n: 1,
    });
  });

  it('la cadena de T.C. del pre-cierre: un cobro en pesos sin T.C. propio usa el de la cotización (#217 con el cobro sin T.C. ⇒ 60988 / 16.959955)', async () => {
    const db = prod();
    const c217 = db.cobro_vuelo.find((c) => c.vuelo_id === id(217))!;
    c217.tc_usd_mxn = null;
    const { svc } = armar(db);
    const r = (await svc.preCierre(AGOSTO)) as unknown as Respuesta;
    const v = (renglon(r).vuelos as Fila[]).find((x) => x.folio === 217)!;
    // 60988 / 16.959955 = 3596.00 ⇒ excedente 496.00 (sigue siendo IVA).
    expect(v).toMatchObject({ excedente_usd: 496, causa: 'IVA_NO_COTIZADO' });
  });

  it('sin lecturas nuevas: el pre-cierre NUNCA busca cobros de otros vuelos del cliente', async () => {
    const { svc, llamadas } = armar(prod());
    await svc.preCierre(SEPTIEMBRE);
    const porCliente = llamadas.filter(
      (l) =>
        l.tabla === 'vuelo' &&
        l.ops.some(([op, args]) => op === 'eq' && args[0] === 'cliente_id'),
    );
    expect(porCliente).toHaveLength(0);
    const cobros = llamadas.filter((l) => l.tabla === 'cobro_vuelo');
    // Ninguna lectura de cobros «sin banco» por método (la del snapshot).
    expect(
      cobros.some((l) =>
        l.ops.some(([op, args]) => op === 'in' && args[0] === 'metodo_cobro'),
      ),
    ).toBe(false);
    // `fetchCobros` sigue siendo UNA lectura para cancelados + completados:
    // solo gana columnas (id, fecha_cobro, cobro_grupo_id). Se identifica
    // por `comision_banco_monto`: desde el 16-oct-2026 (invariante 84) la
    // lectura de `facturasDeVuelos` también pide `cobro_grupo_id`.
    const deFetchCobros = cobros.filter((l) =>
      String(l.ops.find((o) => o[0] === 'select')?.[1][0]).includes(
        'comision_banco_monto',
      ),
    );
    expect(deFetchCobros).toHaveLength(1);
    expect(deFetchCobros[0].ops[0][1][0]).toBe(
      'id, vuelo_id, monto, moneda, tc_usd_mxn, comision_banco_monto, comision_banco_pct, metodo_cobro, fecha_cobro, cobro_grupo_id',
    );
  });
});

describe('renglonVuelosCobradosDeMas (puro)', () => {
  it('sin vuelos: count 0, el detalle de siempre y sin explicados', () => {
    expect(renglonVuelosCobradosDeMas([])).toEqual({
      clave: 'vuelos_cobrados_de_mas',
      titulo: 'Vuelos cobrados de más',
      detalle: DETALLE_PRECIERRE_COBRADOS_DE_MAS,
      count: 0,
      monto_usd: 0,
      vuelos: [],
      explicados: [],
      explicados_n: 0,
    });
  });

  it('la frase de los explicados en singular y plural', () => {
    expect(detalleExplicadosCobradosDeMas(1)).toBe(
      ' Además hay 1 vuelo con la diferencia explicada (comisión del link pagada por el cliente o redondeo del tipo de cambio) que no requiere acción.',
    );
    expect(detalleExplicadosCobradosDeMas(3)).toContain(
      'Además hay 3 vuelos con la diferencia explicada',
    );
  });
});
