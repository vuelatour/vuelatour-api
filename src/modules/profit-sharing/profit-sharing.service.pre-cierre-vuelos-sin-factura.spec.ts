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
  CLAVE_PRECIERRE_VUELOS_SIN_FACTURA,
  DETALLE_PRECIERRE_VUELOS_SIN_FACTURA,
  DETALLE_PRECIERRE_VUELOS_SIN_FACTURA_FALLIDA,
  TITULO_PRECIERRE_VUELOS_SIN_FACTURA,
} from './vuelos-sin-factura.util';

/**
 * PRE-CIERRE · VUELOS COBRADOS EN CUENTAS QUE EXIGEN FACTURA SIN FACTURA
 * REGISTRADA (13-oct-2026, invariante 60).
 *
 * Un cobro que entra a HSBC Dólares / HSBC Pesos / Scotiabank Dólares /
 * Scotiabank Pesos (o por transferencia / link HSBC / cheque sin cuenta
 * capturada) exige factura del servicio. Este renglón lista los vuelos del
 * periodo (cualquier estado: también cancelados con cargo retenido y
 * pendientes con anticipo) que la exigen y no tienen factura registrada.
 * Aviso NO bloqueante; la solicitud viva solo informa; lectura caída ⇒
 * `lectura_fallida`.
 *
 * Fake: BD EN MEMORIA que aplica los filtros de PostgREST que usa el
 * pre-cierre (eq/neq/in/is/not/gte/lte, order, range, limit) y entrega como
 * mucho max-rows = 1000 filas por respuesta, como el PostgREST real.
 */
type Fila = Record<string, unknown>;
type Op = [string, unknown[]];

interface Llamada {
  tabla: string;
  ops: Op[];
}

const MAX_ROWS = 1000;
const ISO = /^\d{4}-\d{2}-\d{2}T/;

/** Valor de una columna; `a.b` entra al embed (objeto o arreglo). */
function valor(fila: Fila, col: string): unknown {
  let acc: unknown = fila;
  for (const k of col.split('.')) {
    if (Array.isArray(acc)) acc = acc[0] as unknown;
    if (acc == null || typeof acc !== 'object') return undefined;
    acc = (acc as Fila)[k];
  }
  return acc;
}

/** null ⇒ comparación con NULL (SQL: nunca pasa el filtro). */
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
  fallar?: (tabla: string, ops: Op[]) => boolean,
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
      if (fallar?.(tabla, ll.ops)) {
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
          for (const [, [col, opts]] of ordenes) {
            const c = comparar(
              valor(a, col as string),
              valor(b, col as string),
            );
            if (c) {
              return (opts as { ascending?: boolean } | undefined)
                ?.ascending === false
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

const PERIODO = { desde: '2026-09-01', hasta: '2026-09-30' };

interface Respuesta {
  listo: boolean;
  items: Fila[];
}

function itemDe(r: Respuesta) {
  return r.items.find((i) => i.clave === CLAVE_PRECIERRE_VUELOS_SIN_FACTURA)!;
}

const AERONAVES: Fila[] = [
  { id: 'av-vgv', matricula: 'XA-VGV' },
  { id: 'av-42r', matricula: 'N4142R' },
];
const CLIENTES: Fila[] = [{ id: 'cli-acp', nombre: 'ACP', es_interno: false }];

/** Vuelo PROPIO completado de septiembre (sobrescribible). */
function vuelo(id: string, folio: number, extra: Fila = {}): Fila {
  return {
    id,
    folio,
    estado: 'COMPLETADO',
    fecha_vuelo: '2026-09-15T15:00:00+00:00',
    aeronave_id: 'av-vgv',
    es_externo: false,
    cliente_id: 'cli-acp',
    monto_total_usd: 1000,
    tc_usd_mxn: 18,
    facturado: false,
    factura_estatus: 'SIN_FACTURA',
    factura_folio: null,
    factura_solicitada_at: null,
    ...extra,
  };
}

function cobro(id: string, vueloId: string, extra: Fila = {}): Fila {
  return {
    id,
    vuelo_id: vueloId,
    monto: 1000,
    moneda: 'USD',
    tc_usd_mxn: null,
    fecha_cobro: '2026-09-16T16:00:00+00:00',
    comision_banco_monto: null,
    comision_banco_pct: null,
    metodo_cobro: 'EFECTIVO',
    cuenta_destino: null,
    ...extra,
  };
}

/** Septiembre con un caso de cada regla. */
function septiembre(): Record<string, Fila[]> {
  return {
    aeronave: AERONAVES,
    cliente: CLIENTES,
    vuelo: [
      // COMPLETADO cobrado por TRANSFERENCIA sin cuenta ⇒ listado.
      vuelo('v401', 401, { fecha_vuelo: '2026-09-10T15:00:00+00:00' }),
      // CONFIRMADO con anticipo en HSBC Dólares ⇒ listado.
      vuelo('v402', 402, {
        estado: 'CONFIRMADO',
        fecha_vuelo: '2026-09-12T15:00:00+00:00',
        aeronave_id: 'av-42r',
      }),
      // CANCELADO con cargo por transferencia retenido ⇒ listado (el dinero
      // retenido en HSBC también se factura).
      vuelo('v403', 403, {
        estado: 'CANCELADO',
        fecha_vuelo: '2026-09-14T15:00:00+00:00',
      }),
      // Externo sin avión, cobrado en Scotiabank Pesos ⇒ listado con
      // matrícula null.
      vuelo('v404', 404, {
        es_externo: true,
        aeronave_id: null,
        fecha_vuelo: '2026-09-18T15:00:00+00:00',
      }),
      // Cobrado en HSBC con factura emitida VIGENTE ⇒ NO.
      vuelo('v405', 405, { fecha_vuelo: '2026-09-20T15:00:00+00:00' }),
      // Solo BillPocket + efectivo ⇒ NO.
      vuelo('v406', 406, { fecha_vuelo: '2026-09-21T15:00:00+00:00' }),
      // Fuera del periodo (octubre) con HSBC ⇒ NO.
      vuelo('v407', 407, { fecha_vuelo: '2026-10-02T15:00:00+00:00' }),
      // Con solicitud VIVA y cobro HSBC ⇒ listado, `solicitada: true`.
      vuelo('v408', 408, {
        fecha_vuelo: '2026-09-25T15:00:00+00:00',
        factura_solicitada_at: '2026-09-26T10:00:00+00:00',
      }),
      // Sin cobros ⇒ NO.
      vuelo('v409', 409, { fecha_vuelo: '2026-09-27T15:00:00+00:00' }),
      // Dos cobros que exigen en cuentas distintas ⇒ `cuentas` con las dos.
      vuelo('v410', 410, { fecha_vuelo: '2026-09-27T15:00:00+00:00' }),
      // ORDEN: folio menor con fecha posterior ⇒ va por fecha.
      vuelo('v300', 300, { fecha_vuelo: '2026-09-29T15:00:00+00:00' }),
    ],
    cobro_vuelo: [
      cobro('c401', 'v401', { metodo_cobro: 'TRANSFERENCIA' }),
      cobro('c402', 'v402', {
        monto: 400,
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'HSBC Dólares',
      }),
      cobro('c403', 'v403', {
        monto: 250,
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'HSBC Pesos',
        moneda: 'MXN',
        tc_usd_mxn: 18,
      }),
      cobro('c404', 'v404', {
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'Scotiabank Pesos',
        moneda: 'MXN',
        tc_usd_mxn: 18,
      }),
      cobro('c405', 'v405', {
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'HSBC Pesos',
        moneda: 'MXN',
        tc_usd_mxn: 18,
      }),
      cobro('c406a', 'v406', { metodo_cobro: 'BILLPOCKET', monto: 600 }),
      cobro('c406b', 'v406', { metodo_cobro: 'EFECTIVO', monto: 400 }),
      cobro('c407', 'v407', {
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'HSBC Pesos',
      }),
      cobro('c408', 'v408', {
        metodo_cobro: 'HSBC_LINK',
        cuenta_destino: 'HSBC Pesos',
      }),
      cobro('c410a', 'v410', {
        monto: 500,
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'Scotiabank Dólares',
      }),
      cobro('c410b', 'v410', { monto: 500, metodo_cobro: 'CHEQUE' }),
      cobro('c300', 'v300', { metodo_cobro: 'TRANSFERENCIA' }),
    ],
    factura: [],
    factura_emitida_vuelo: [
      {
        vuelo_id: 'v405',
        factura: {
          serie: 'A',
          folio: '0424',
          folio_num: 424,
          estatus: 'VIGENTE',
          deleted_at: null,
        },
      },
    ],
  };
}

describe('ProfitSharingService.preCierre — vuelos cobrados en cuentas que exigen factura sin factura registrada', () => {
  it('lista los que exigen factura y no la tienen (cualquier estado) y NO bloquea el cierre', async () => {
    const { svc } = armar(septiembre());
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const item = itemDe(r);

    expect(item).toMatchObject({
      titulo: TITULO_PRECIERRE_VUELOS_SIN_FACTURA,
      detalle: DETALLE_PRECIERRE_VUELOS_SIN_FACTURA,
      count: 7,
      lectura_fallida: false,
    });
    expect(TITULO_PRECIERRE_VUELOS_SIN_FACTURA).toBe(
      'Vuelos cobrados en cuentas que exigen factura sin factura registrada',
    );
    // Por fecha_vuelo (el #300 va al final aunque su folio sea menor).
    expect(item.vuelos).toEqual([
      {
        id: 'v401',
        folio: 401,
        fecha_vuelo: '2026-09-10T15:00:00+00:00',
        matricula: 'XA-VGV',
        solicitada: false,
        cuentas: ['Transferencia sin cuenta destino'],
      },
      {
        id: 'v402',
        folio: 402,
        fecha_vuelo: '2026-09-12T15:00:00+00:00',
        matricula: 'N4142R',
        solicitada: false,
        cuentas: ['HSBC Dólares'],
      },
      {
        id: 'v403',
        folio: 403,
        fecha_vuelo: '2026-09-14T15:00:00+00:00',
        matricula: 'XA-VGV',
        solicitada: false,
        cuentas: ['HSBC Pesos'],
      },
      {
        id: 'v404',
        folio: 404,
        fecha_vuelo: '2026-09-18T15:00:00+00:00',
        matricula: null,
        solicitada: false,
        cuentas: ['Scotiabank Pesos'],
      },
      {
        id: 'v408',
        folio: 408,
        fecha_vuelo: '2026-09-25T15:00:00+00:00',
        matricula: 'XA-VGV',
        solicitada: true,
        cuentas: ['HSBC Pesos'],
      },
      {
        id: 'v410',
        folio: 410,
        fecha_vuelo: '2026-09-27T15:00:00+00:00',
        matricula: 'XA-VGV',
        solicitada: false,
        cuentas: ['Scotiabank Dólares', 'Cheque sin cuenta destino'],
      },
      {
        id: 'v300',
        folio: 300,
        fecha_vuelo: '2026-09-29T15:00:00+00:00',
        matricula: 'XA-VGV',
        solicitada: false,
        cuentas: ['Transferencia sin cuenta destino'],
      },
    ]);
    expect(item).not.toHaveProperty('informativo');

    // Justo después de externos_sin_honorario (el panel los pinta en ese orden).
    const claves = r.items.map((i) => i.clave);
    expect(claves.indexOf(CLAVE_PRECIERRE_VUELOS_SIN_FACTURA)).toBe(
      claves.indexOf('externos_sin_honorario') + 1,
    );
  });

  it('NO está en `bloqueantes`: con pendientes de factura y sin otro pendiente, `listo` sigue en true', async () => {
    const { svc } = armar({
      aeronave: AERONAVES,
      cliente: CLIENTES,
      vuelo: [vuelo('a', 1, { cobrado: true })],
      cobro_vuelo: [
        cobro('c', 'a', {
          metodo_cobro: 'TRANSFERENCIA',
          cuenta_destino: 'HSBC Pesos',
        }),
      ],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(itemDe(r).count).toBe(1);
    expect(r.listo).toBe(true);
  });

  it('cada regla por separado', async () => {
    const casos: Array<[string, Fila[], Fila[], Fila[] | undefined, number[]]> =
      [
        [
          'completado por transferencia sin cuenta',
          [vuelo('a', 1)],
          [cobro('c', 'a', { metodo_cobro: 'TRANSFERENCIA' })],
          undefined,
          [1],
        ],
        [
          'cobro en HSBC con emitida VIGENTE',
          [vuelo('a', 1)],
          [cobro('c', 'a', { cuenta_destino: 'HSBC Pesos' })],
          [
            {
              vuelo_id: 'a',
              factura: {
                serie: 'A',
                folio: '1',
                folio_num: 1,
                estatus: 'VIGENTE',
                deleted_at: null,
              },
            },
          ],
          [],
        ],
        [
          'cobro en HSBC con estatus manual FACTURADO',
          [vuelo('a', 1, { factura_estatus: 'FACTURADO' })],
          [cobro('c', 'a', { cuenta_destino: 'HSBC Pesos' })],
          undefined,
          [],
        ],
        [
          'solo BillPocket y efectivo',
          [vuelo('a', 1)],
          [
            cobro('c1', 'a', { metodo_cobro: 'BILLPOCKET' }),
            cobro('c2', 'a', { metodo_cobro: 'EFECTIVO' }),
          ],
          undefined,
          [],
        ],
        [
          'Paywise',
          [vuelo('a', 1)],
          [
            cobro('c', 'a', {
              metodo_cobro: 'PAYWISE',
              cuenta_destino: 'Paywise',
            }),
          ],
          undefined,
          [],
        ],
        [
          'solo un reembolso en HSBC',
          [vuelo('a', 1)],
          [cobro('c', 'a', { monto: -100, cuenta_destino: 'HSBC Pesos' })],
          undefined,
          [],
        ],
        [
          'solicitud viva sola (cobros que no exigen) NO lo mete',
          [vuelo('a', 1, { factura_solicitada_at: '2026-09-20T10:00:00Z' })],
          [cobro('c', 'a', { metodo_cobro: 'BILLPOCKET' })],
          undefined,
          [],
        ],
        [
          'fuera del periodo',
          [vuelo('a', 1, { fecha_vuelo: '2026-10-05T15:00:00+00:00' })],
          [cobro('c', 'a', { cuenta_destino: 'HSBC Pesos' })],
          undefined,
          [],
        ],
        [
          '30-sep 22:00 Cancún (01-oct UTC) ⇒ dentro del periodo',
          [vuelo('a', 1, { fecha_vuelo: '2026-10-01T03:00:00+00:00' })],
          [cobro('c', 'a', { cuenta_destino: 'HSBC Pesos' })],
          undefined,
          [1],
        ],
      ];
    for (const [nombre, vuelos, cobros, emitidas, folios] of casos) {
      const { svc } = armar({
        aeronave: AERONAVES,
        cliente: CLIENTES,
        vuelo: vuelos,
        cobro_vuelo: cobros,
        factura: [],
        factura_emitida_vuelo: emitidas ?? [],
      });
      const item = itemDe(await svc.preCierre(PERIODO));
      expect([nombre, (item.vuelos as Fila[]).map((v) => v.folio)]).toEqual([
        nombre,
        folios,
      ]);
      expect([nombre, item.count]).toEqual([nombre, folios.length]);
    }
  });

  it('ANTI-CAP: con más de 1 000 cobros en un lote de 200 vuelos ninguno se pierde (páginas)', async () => {
    // 200 vuelos con 5 cobros en efectivo cada uno (1 000 filas) y el último
    // además con UN cobro en HSBC cuyo id ordena DESPUÉS de todos: sin
    // paginar, PostgREST entregaría las 1 000 primeras filas y ese vuelo
    // saldría «no lleva factura» en falso.
    const vuelos: Fila[] = [];
    const cobros: Fila[] = [];
    for (let i = 0; i < 200; i += 1) {
      const id = `v${String(i).padStart(4, '0')}`;
      vuelos.push(vuelo(id, 1000 + i));
      for (let k = 0; k < 5; k += 1) {
        cobros.push(cobro(`c${id}-${k}`, id, { monto: 200 }));
      }
    }
    cobros.push(
      cobro('z-hsbc', 'v0199', {
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'HSBC Pesos',
      }),
    );
    const { svc, llamadas } = armar({
      aeronave: AERONAVES,
      cliente: CLIENTES,
      vuelo: vuelos,
      cobro_vuelo: cobros,
    });
    const item = itemDe(await svc.preCierre(PERIODO));
    expect(item).toMatchObject({ count: 1, lectura_fallida: false });
    expect((item.vuelos as Fila[]).map((v) => v.folio)).toEqual([1199]);

    const paginadas = llamadas.filter(
      (l) => l.tabla === 'cobro_vuelo' && l.ops.some((o) => o[0] === 'range'),
    );
    expect(
      paginadas.map((l) => l.ops.find((o) => o[0] === 'range')?.[1]),
    ).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    // Orden TOTAL por id: las páginas no se traslapan.
    for (const l of paginadas) {
      expect(l.ops).toContainEqual(['order', ['id', { ascending: true }]]);
    }
  });

  it('lectura fallida de los cobros ⇒ count 0 MARCADO con lectura_fallida, sin tumbar el pre-cierre', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { svc } = armar(
        septiembre(),
        (tabla, ops) =>
          tabla === 'cobro_vuelo' && ops.some((o) => o[0] === 'range'),
      );
      const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('vuelos cobrados sin factura'),
      );
      const item = itemDe(r);
      expect(item).toEqual(
        expect.objectContaining({
          count: 0,
          vuelos: [],
          lectura_fallida: true,
          detalle: DETALLE_PRECIERRE_VUELOS_SIN_FACTURA_FALLIDA,
        }),
      );
      // El resto del checklist sigue ahí.
      expect(r.items.some((i) => i.clave === 'pistas_sin_gasto')).toBe(true);
      expect(r.items.some((i) => i.clave === 'externos_sin_honorario')).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
