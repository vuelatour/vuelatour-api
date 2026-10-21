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
 * PRE-CIERRE · RENGLONES INVERSOS (15-oct-2026, PEDIDO 4):
 * `tua_pagada_sin_cobrar` («Vuelos con TUA pagada por Operación sin TUA
 * cobrada al cliente») y `transporte_pagado_sin_cotizar` («Vuelos con
 * transporte pagado sin transporte cotizado»). Sustituyen a
 * `tua_cobrada_sin_pagada` (y se retira `pistas_sin_gasto`). Avisos NO
 * bloqueantes, justo después de `vuelos_sin_gasto_operaciones`; UNA
 * lectura de gastos; lectura caída ⇒ los DOS con `lectura_fallida`.
 *
 * Fake (mudado del spec retirado `pre-cierre-tua-cobrada`): BD EN MEMORIA
 * (mismo intérprete que el spec de
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
    // Pre-cierre de ligas USD por T.C. (invariante 70): sin ligas.
    ligasUsdTcFueraDeLugar: jest
      .fn()
      .mockResolvedValue({ ligas: [], sin_verificar: 0 }),
  } as unknown as ConciliacionService;
  const nada = {} as never;
  const svc = new ProfitSharingService(supabase, nada, nada, conciliacion);
  return { svc, llamadas };
}

const PERIODO = { desde: '2026-10-01', hasta: '2026-10-31' };
const CLAVE_TUA = 'tua_pagada_sin_cobrar';
const CLAVE_TRANSPORTE = 'transporte_pagado_sin_cotizar';

interface Respuesta {
  listo: boolean;
  items: Fila[];
}

const itemDe = (r: Respuesta, clave: string) =>
  r.items.find((i) => i.clave === clave)!;

const AERONAVES: Fila[] = [
  { id: 'av-vgv', matricula: 'XA-VGV' },
  { id: 'av-990', matricula: 'N990GG' },
];

const CLIENTES: Fila[] = [
  { id: 'cli-1', es_interno: false },
  { id: 'cli-int', es_interno: true },
];

/** Vuelo PROPIO completado de octubre, cotizado SIN TUAS ni extras ($1,000). */
function vuelo(id: string, folio: number, extra: Fila = {}): Fila {
  return {
    id,
    folio,
    estado: 'COMPLETADO',
    fecha_vuelo: '2026-10-08T15:00:00+00:00',
    aeronave_id: 'av-vgv',
    es_externo: false,
    cliente_id: 'cli-1',
    pase_abordar: false,
    monto_total_usd: 1000,
    tc_usd_mxn: 18,
    calculo_snapshot: {
      desglose: [{ clave: 'TIEMPO_VUELO', monto_usd: 1000 }],
      extras: [],
    },
    extras: [],
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
    // Con T.C. propio: un gasto sin T.C. es otro bloqueante (gastos_sin_tc).
    tc_gasto: 18,
    fecha_gasto: '2026-10-08',
    lugar: null,
    notas: 'ASUR CUN',
    valor_ia_extraido: null,
    estatus_facturacion: 'FACTURADA',
    conciliado: true,
    ...extra,
  };
}

/**
 * Transporte REAL de prod (66d575d8, #190). En prod era TAXI; desde el
 * 21-oct-2026 TAXI es de la tripulación y no dispara el renglón, así que el
 * mundo lo captura como OPERACIONES (la regla nueva).
 */
const TAXI_190: Fila = {
  categoria: 'OPERACIONES',
  monto: 400,
  notas:
    "Costa Maya Transportes Turísticos S.A. · Transporte Chetumal a Carl's Jr",
  valor_ia_extraido: { proveedor: 'COSTA MAYA TRANSPORTES TURISTICOS S.A.' },
};

const SELECT_INVERSOS =
  'id, vuelo_id, categoria, monto, moneda, propina, lugar, notas, valor_ia_extraido';

/** La consulta ÚNICA de gastos de los renglones inversos. */
const consultasInversos = (llamadas: Llamada[]) =>
  llamadas.filter(
    (l) =>
      l.tabla === 'gasto' &&
      l.ops.some(
        (o) => o[0] === 'select' && String(o[1][0]).startsWith(SELECT_INVERSOS),
      ),
  );

describe('ProfitSharingService.preCierre — renglones inversos (15-oct-2026)', () => {
  it('lista los dos renglones con sus montos por moneda, en su posición, y NO bloquea', async () => {
    const { svc } = armar({
      aeronave: AERONAVES,
      cliente: CLIENTES,
      vuelo: [
        // #70: dos facturas que pagan TUA (TUAS entero + forma b) ⇒ listado.
        vuelo('v70', 70, { fecha_vuelo: '2026-10-05T15:00:00+00:00' }),
        // #154: pase de abordar + TUAS en USD ⇒ listado y marcado.
        vuelo('v154', 154, {
          fecha_vuelo: '2026-10-15T15:00:00+00:00',
          aeronave_id: 'av-990',
          pase_abordar: true,
        }),
        // #383: SÍ cobra TUA ⇒ fuera del renglón TUA.
        vuelo('v383', 383, {
          calculo_snapshot: {
            desglose: [
              { clave: 'TIEMPO_VUELO', monto_usd: 900 },
              { clave: 'TUAS', monto_usd: 100 },
            ],
          },
        }),
        // #190: taxi de pasajeros sin extra ⇒ renglón transporte.
        vuelo('v190', 190, { fecha_vuelo: '2026-10-20T15:00:00+00:00' }),
        // #200: taxi con extra «Transfer» pactado ⇒ fuera.
        vuelo('v200', 200, {
          calculo_snapshot: {
            desglose: [{ clave: 'TIEMPO_VUELO', monto_usd: 1000 }],
            extras: [{ concepto: 'Transfer' }],
          },
        }),
        // #201: sin snapshot ⇒ respaldo vuelo.extras («Camionetas») ⇒ fuera.
        vuelo('v201', 201, {
          calculo_snapshot: null,
          subtotal_vuelo_usd: 1000,
          extras: [{ concepto: 'Camionetas' }],
        }),
      ],
      gasto: [
        gasto('g70a', 'v70', { categoria: 'TUAS', monto: 1415.79 }),
        gasto('g70b', 'v70', {
          monto: 1357.33,
          valor_ia_extraido: {
            conceptos: [
              { monto: 417.73, concepto: 'Serv Aerop Campeche' },
              { monto: 939.6, concepto: 'TUA Nacional Campeche' },
            ],
          },
        }),
        gasto('g154', 'v154', { categoria: 'TUAS', monto: 40, moneda: 'USD' }),
        gasto('g383', 'v383', { categoria: 'TUAS', monto: 1800 }),
        gasto('g190', 'v190', TAXI_190),
        gasto('g200', 'v200', TAXI_190),
        gasto('g201', 'v201', TAXI_190),
      ],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;

    const tua = itemDe(r, CLAVE_TUA);
    expect(tua).toMatchObject({
      titulo: 'Vuelos con TUA pagada por Operación sin TUA cobrada al cliente',
      count: 2,
      monto_mxn: 2355.39,
      monto_usd: 40,
      lectura_fallida: false,
    });
    expect(String(tua.detalle)).toMatch(/^Vuelos completados del periodo/);
    expect(tua.vuelos).toEqual([
      {
        id: 'v70',
        folio: 70,
        fecha_vuelo: '2026-10-05T15:00:00+00:00',
        matricula: 'XA-VGV',
        tua_pagada_mxn: 2355.39,
        tua_pagada_usd: 0,
        pase_abordar: false,
        gastos_n: 2,
      },
      {
        id: 'v154',
        folio: 154,
        fecha_vuelo: '2026-10-15T15:00:00+00:00',
        matricula: 'N990GG',
        tua_pagada_mxn: 0,
        tua_pagada_usd: 40,
        pase_abordar: true,
        gastos_n: 1,
      },
    ]);

    const transporte = itemDe(r, CLAVE_TRANSPORTE);
    expect(transporte).toMatchObject({
      titulo: 'Vuelos con transporte pagado sin transporte cotizado',
      count: 1,
      monto_mxn: 400,
      monto_usd: 0,
      lectura_fallida: false,
    });
    expect(String(transporte.detalle)).toMatch(/^Es una SEÑAL/);
    expect(transporte.vuelos).toEqual([
      {
        id: 'v190',
        folio: 190,
        fecha_vuelo: '2026-10-20T15:00:00+00:00',
        matricula: 'XA-VGV',
        monto_mxn: 400,
        monto_usd: 0,
        gastos: [
          {
            id: 'g190',
            texto: "Transporte Chetumal a Carl's Jr",
            monto: 400,
            moneda: 'MXN',
          },
        ],
      },
    ]);

    // Posición: … cobros_bancarios_sin_conciliar → vuelos_sin_gasto_operaciones
    // → tua_pagada_sin_cobrar → transporte_pagado_sin_cotizar →
    // externos_sin_honorario …
    const claves = r.items.map((i) => i.clave);
    const base = claves.indexOf('vuelos_sin_gasto_operaciones');
    expect(base).toBe(claves.indexOf('cobros_bancarios_sin_conciliar') + 1);
    expect(claves.indexOf(CLAVE_TUA)).toBe(base + 1);
    expect(claves.indexOf(CLAVE_TRANSPORTE)).toBe(base + 2);
    expect(claves.indexOf('externos_sin_honorario')).toBe(base + 3);
    // Las claves RETIRADAS no existen más.
    expect(claves).not.toContain('pistas_sin_gasto');
    expect(claves).not.toContain('tua_cobrada_sin_pagada');
    // Avisos, no candados: el periodo sigue «listo» y no son informativos.
    expect(r.listo).toBe(true);
    expect(tua).not.toHaveProperty('informativo');
    expect(transporte).not.toHaveProperty('informativo');
  });

  it('cliente interno, total 0, externo y cancelado ⇒ fuera (y sin candidatos NO hay consulta)', async () => {
    const { svc, llamadas } = armar({
      aeronave: AERONAVES,
      cliente: CLIENTES,
      vuelo: [
        vuelo('vi', 350, { cliente_id: 'cli-int' }),
        vuelo('v0', 134, { monto_total_usd: 0, calculo_snapshot: null }),
        vuelo('vx', 10, { es_externo: true }),
        vuelo('vc', 11, { estado: 'CANCELADO' }),
      ],
      gasto: ['vi', 'v0', 'vx', 'vc'].flatMap((v) => [
        gasto(`t-${v}`, v, { categoria: 'TUAS', monto: 500 }),
        gasto(`x-${v}`, v, TAXI_190),
      ]),
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    for (const clave of [CLAVE_TUA, CLAVE_TRANSPORTE]) {
      expect(itemDe(r, clave)).toMatchObject({
        count: 0,
        monto_mxn: 0,
        monto_usd: 0,
        vuelos: [],
        lectura_fallida: false,
      });
    }
    expect(consultasInversos(llamadas)).toHaveLength(0);
  });

  it('un gasto TUAS de OTRO mes SÍ cuenta; UNA consulta por vuelo_id, sin fecha ni categoría, con el select exacto', async () => {
    const { svc, llamadas } = armar({
      aeronave: AERONAVES,
      cliente: CLIENTES,
      vuelo: [vuelo('v1', 1)],
      gasto: [
        gasto('g1', 'v1', {
          categoria: 'TUAS',
          monto: 1800,
          fecha_gasto: '2026-11-03',
        }),
      ],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(itemDe(r, CLAVE_TUA)).toMatchObject({
      count: 1,
      monto_mxn: 1800,
      lectura_fallida: false,
    });
    const q = consultasInversos(llamadas);
    expect(q).toHaveLength(1);
    expect(q[0].ops).toContainEqual(['in', ['vuelo_id', ['v1']]]);
    expect(
      q[0].ops.some(
        (o) => o[1][0] === 'fecha_gasto' || o[1][0] === 'categoria',
      ),
    ).toBe(false);
    expect(String(q[0].ops.find((o) => o[0] === 'select')?.[1][0])).toBe(
      `${SELECT_INVERSOS}, tua_incluida`,
    );
  });

  it('sin la migración (sonda 42703) ⇒ el select NO nombra tua_incluida y el renglón sigue', async () => {
    const { svc, llamadas } = armar(
      {
        aeronave: AERONAVES,
        cliente: CLIENTES,
        vuelo: [vuelo('v1', 1)],
        gasto: [gasto('g1', 'v1', { categoria: 'TUAS', monto: 100 })],
      },
      { sinMigracion: true },
    );
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(itemDe(r, CLAVE_TUA)).toMatchObject({
      count: 1,
      lectura_fallida: false,
    });
    const q = consultasInversos(llamadas);
    expect(q).toHaveLength(1);
    expect(String(q[0].ops.find((o) => o[0] === 'select')?.[1][0])).toBe(
      SELECT_INVERSOS,
    );
  });

  it('ANTI-CAP: 1 vuelo con 1,001 gastos y el TUAS en el último ⇒ SÍ se lista (páginas [0,999] y [1000,1999])', async () => {
    const gastos: Fila[] = [];
    for (let i = 0; i < 1000; i += 1) {
      gastos.push(gasto(`g${String(i).padStart(4, '0')}`, 'v1'));
    }
    gastos.push(gasto('g9999', 'v1', { categoria: 'TUAS', monto: 100 }));
    const { svc, llamadas } = armar({
      aeronave: AERONAVES,
      cliente: CLIENTES,
      vuelo: [vuelo('v1', 1)],
      gasto: gastos,
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(itemDe(r, CLAVE_TUA)).toMatchObject({
      count: 1,
      monto_mxn: 100,
      lectura_fallida: false,
    });
    const q = consultasInversos(llamadas);
    expect(q.map((l) => l.ops.find((o) => o[0] === 'range')?.[1])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    for (const l of q) {
      expect(l.ops).toContainEqual(['order', ['id', { ascending: true }]]);
    }
  });

  it('GRUPO: la camioneta cotizada con reparto ANCLA (cabecera) cubre el gasto ligado a OTRO hijo; sin grupos NO se lee vuelo_grupo', async () => {
    // Revisión 0.0.81: el extra ANCLA solo se materializa en el hijo ancla
    // (vA); el gasto de la camioneta se ligó al hijo vB.
    const camionetas = [{ concepto: 'Camionetas', unitario: 150 }];
    const { svc, llamadas } = armar({
      aeronave: AERONAVES,
      cliente: CLIENTES,
      vuelo_grupo: [
        {
          id: 'g-1',
          extras_grupo: [{ ...camionetas[0], reparto: 'ANCLA', moneda: 'USD' }],
        },
      ],
      vuelo: [
        vuelo('vA', 501, {
          grupo_id: 'g-1',
          calculo_snapshot: {
            desglose: [{ clave: 'TIEMPO_VUELO', monto_usd: 1000 }],
            extras: [{ concepto: 'Camionetas', monto_usd: 150 }],
          },
        }),
        vuelo('vB', 502, { grupo_id: 'g-1', aeronave_id: 'av-990' }),
        vuelo('vS', 503),
      ],
      gasto: [gasto('x-vB', 'vB', TAXI_190), gasto('x-vS', 'vS', TAXI_190)],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(itemDe(r, CLAVE_TRANSPORTE)).toMatchObject({
      count: 1,
      lectura_fallida: false,
    });
    expect(
      (itemDe(r, CLAVE_TRANSPORTE).vuelos as Fila[]).map((v) => v.folio),
    ).toEqual([503]);
    const qGrupo = llamadas.filter(
      (l) =>
        l.tabla === 'vuelo_grupo' &&
        l.ops.some((o) => o[0] === 'select' && o[1][0] === 'id, extras_grupo'),
    );
    expect(qGrupo).toHaveLength(1);
    expect(qGrupo[0].ops).toContainEqual(['in', ['id', ['g-1']]]);

    // Sin hijos de grupo entre los candidatos ⇒ ni una consulta de más.
    const sinGrupo = armar({
      aeronave: AERONAVES,
      cliente: CLIENTES,
      vuelo: [vuelo('vS', 503)],
      gasto: [gasto('x-vS', 'vS', TAXI_190)],
    });
    await sinGrupo.svc.preCierre(PERIODO);
    expect(
      sinGrupo.llamadas.some(
        (l) =>
          l.tabla === 'vuelo_grupo' &&
          l.ops.some(
            (o) => o[0] === 'select' && o[1][0] === 'id, extras_grupo',
          ),
      ),
    ).toBe(false);
  });

  it('GRUPO: la lectura de vuelo_grupo caída ⇒ los DOS con lectura_fallida (jamás «sin cotizar» a ciegas)', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { svc } = armar(
      {
        aeronave: AERONAVES,
        cliente: CLIENTES,
        vuelo_grupo: [{ id: 'g-1', extras_grupo: [] }],
        vuelo: [vuelo('vB', 502, { grupo_id: 'g-1' })],
        gasto: [gasto('x-vB', 'vB', TAXI_190)],
      },
      {
        fallar: (tabla, ops) =>
          tabla === 'vuelo_grupo' &&
          ops.some((o) => o[0] === 'select' && o[1][0] === 'id, extras_grupo'),
      },
    );
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    warn.mockRestore();
    for (const clave of [CLAVE_TUA, CLAVE_TRANSPORTE]) {
      expect(itemDe(r, clave)).toMatchObject({
        count: 0,
        vuelos: [],
        lectura_fallida: true,
      });
    }
  });

  it('lectura caída ⇒ los DOS con count 0, montos 0, vuelos [], lectura_fallida y su detalle FALLIDA; pre-cierre vivo', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { svc } = armar(
      {
        aeronave: AERONAVES,
        cliente: CLIENTES,
        vuelo: [vuelo('v1', 1)],
        gasto: [gasto('g1', 'v1', { categoria: 'TUAS', monto: 100 })],
      },
      {
        fallar: (tabla, ops) =>
          tabla === 'gasto' &&
          ops.some(
            (o) =>
              o[0] === 'select' && String(o[1][0]).startsWith(SELECT_INVERSOS),
          ),
      },
    );
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'renglones inversos (TUA pagada / transporte) no disponibles',
      ),
    );
    warn.mockRestore();
    expect(itemDe(r, CLAVE_TUA)).toMatchObject({
      count: 0,
      monto_mxn: 0,
      monto_usd: 0,
      vuelos: [],
      lectura_fallida: true,
      detalle:
        'No se pudo verificar la TUA pagada de los vuelos del periodo: revisa las facturas de aeropuerto en Gastos y las cotizaciones sin TUAS antes de cerrar.',
    });
    expect(itemDe(r, CLAVE_TRANSPORTE)).toMatchObject({
      count: 0,
      monto_mxn: 0,
      monto_usd: 0,
      vuelos: [],
      lectura_fallida: true,
      detalle:
        'No se pudo verificar los transportes pagados de los vuelos del periodo: revisa los gastos de Operaciones con traslados de pasajeros de cada vuelo contra su cotización antes de cerrar.',
    });
    expect(r.listo).toBe(true);
  });
});
