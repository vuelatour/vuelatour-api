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
 * PRE-CIERRE · VUELOS COMPLETADOS SIN GASTO DE OPERACIONES (5-oct-2026).
 *
 * La conciliación prueba que cada movimiento del BANCO tiene su gasto, pero
 * no puede ver un gasto que nunca se capturó ni pasó por la tarjeta: #295
 * (ACP, 12-sep, XA-VGV, CUN→PPS→CUN, cobrado y con 0 gastos) y #268 (7-sep,
 * N4142R, CUN→CUN). Este renglón los lista desde el lado del VUELO: propios,
 * COMPLETADOS, sin ningún gasto OPERACIONES/ATERRIZAJE ligado (de cualquier
 * fecha). Cliente interno y vuelos de servicio ENTRAN (revisión 5-oct-2026:
 * su pista también resta en el balance; #136 de agosto era interno y le
 * faltaba). Aviso NO bloqueante; lectura caída ⇒ `lectura_fallida`.
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
const CLAVE = 'vuelos_sin_gasto_operaciones';

interface Respuesta {
  listo: boolean;
  items: Fila[];
}

function itemDe(r: Respuesta) {
  return r.items.find((i) => i.clave === CLAVE)!;
}

const AERONAVES: Fila[] = [
  { id: 'av-vgv', matricula: 'XA-VGV' },
  { id: 'av-42r', matricula: 'N4142R' },
  { id: 'av-gg', matricula: 'N990GG' },
];
const CLIENTES: Fila[] = [
  { id: 'cli-acp', nombre: 'ACP', es_interno: false },
  { id: 'cli-int', nombre: 'VuelaTour', es_interno: true },
];

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
    monto_total_usd: 0,
    ...extra,
  };
}

function tramo(id: string, vueloId: string, extra: Fila = {}): Fila {
  return {
    id,
    vuelo_id: vueloId,
    orden: 1,
    origen_iata: 'CUN',
    destino_iata: 'CUN',
    tipo_parada: 'NORMAL',
    pasajeros: 2,
    cancelada_at: null,
    ...extra,
  };
}

function gasto(id: string, vueloId: string, categoria: string, fecha: string) {
  return {
    id,
    vuelo_id: vueloId,
    aeronave_id: 'av-vgv',
    categoria,
    monto: 500,
    moneda: 'USD',
    fecha_gasto: fecha,
    estatus_facturacion: 'FACTURADA',
    conciliado: true,
  };
}

/** Septiembre con un caso de cada regla. */
function septiembre(): Record<string, Fila[]> {
  return {
    aeronave: AERONAVES,
    cliente: CLIENTES,
    vuelo: [
      // #295 real: CUN→PPS→CUN, cobrado, CERO gastos ⇒ listado.
      vuelo('v295', 295, { fecha_vuelo: '2026-09-12T15:00:00+00:00' }),
      // #268 real: CUN→CUN en N4142R, sin escalas leídas ⇒ listado.
      vuelo('v268', 268, {
        fecha_vuelo: '2026-09-07T16:00:00+00:00',
        aeronave_id: 'av-42r',
      }),
      // Solo COMIDA: no es gasto de pista ⇒ listado.
      vuelo('v301', 301, { fecha_vuelo: '2026-09-15T15:00:00+00:00' }),
      // OPERACIONES con fecha de OCTUBRE (se pagó después) ⇒ NO.
      vuelo('v310', 310),
      // ATERRIZAJE (legado) también cubre ⇒ NO.
      vuelo('v311', 311),
      // Externo (aunque traiga avión de referencia) ⇒ NO.
      vuelo('v320', 320, { es_externo: true, aeronave_id: 'av-gg' }),
      // Sin avión ⇒ NO.
      vuelo('v321', 321, { aeronave_id: null }),
      // Cliente interno: su pista también resta en el balance ⇒ listado
      // (caso real #136 de agosto, CET→CUN de reposicionamiento).
      vuelo('v330', 330, { cliente_id: 'cli-int' }),
      // Vuelo de SERVICIO (parada SERVICIO, cero pax): también paga pista ⇒
      // listado.
      vuelo('v340', 340),
      // Parada SERVICIO CON pasajeros ⇒ listado.
      vuelo('v341', 341, { fecha_vuelo: '2026-09-20T15:00:00+00:00' }),
      // ORDEN: folio MENOR con fecha POSTERIOR ⇒ va por fecha, no por folio.
      vuelo('v200', 200, { fecha_vuelo: '2026-09-25T15:00:00+00:00' }),
      // ORDEN: misma fecha, folios INVERTIDOS en la lectura ⇒ desempate por
      // folio (350 antes que 351).
      vuelo('v351', 351, { fecha_vuelo: '2026-09-27T15:00:00+00:00' }),
      vuelo('v350', 350, { fecha_vuelo: '2026-09-27T15:00:00+00:00' }),
      // Cancelado ⇒ NO (no voló: lo cubre gastos_en_cancelados).
      vuelo('v348', 348, { estado: 'CANCELADO' }),
      // 31-ago 23:30 en Cancún (01-sep UTC) ⇒ fuera del periodo ⇒ NO.
      vuelo('v206', 206, { fecha_vuelo: '2026-09-01T04:30:00+00:00' }),
      // 30-sep 22:00 en Cancún (01-oct UTC) ⇒ DENTRO del periodo ⇒ listado.
      vuelo('v360', 360, { fecha_vuelo: '2026-10-01T03:00:00+00:00' }),
    ],
    escala: [
      tramo('e295a', 'v295', { destino_iata: 'PPS' }),
      tramo('e295b', 'v295', { orden: 2, origen_iata: 'PPS' }),
      tramo('e301', 'v301'),
      tramo('e340a', 'v340', { tipo_parada: 'SERVICIO', pasajeros: 0 }),
      tramo('e340b', 'v340', { orden: 2, pasajeros: null }),
      tramo('e341a', 'v341', { tipo_parada: 'SERVICIO', pasajeros: 0 }),
      tramo('e341b', 'v341', { orden: 2, pasajeros: 3 }),
    ],
    gasto: [
      gasto('g301', 'v301', 'COMIDA', '2026-09-15'),
      gasto('g310', 'v310', 'OPERACIONES', '2026-10-03'),
      gasto('g311', 'v311', 'ATERRIZAJE', '2026-09-15'),
    ],
  };
}

describe('ProfitSharingService.preCierre — vuelos completados sin gasto de operaciones', () => {
  it('lista los propios COMPLETADOS sin pista ligada y NO bloquea el cierre', async () => {
    const { svc, llamadas } = armar(septiembre());
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const item = itemDe(r);

    expect(item).toMatchObject({
      titulo: 'Vuelos completados sin gasto de operaciones',
      detalle:
        'Vuelos propios COMPLETADOS del periodo (también los de cliente interno y los de servicio) sin ningún gasto de OPERACIONES/ATERRIZAJE (pista, plataforma, aterrizaje). La conciliación no puede verlos: el piloto no capturó el gasto o se pagó fuera de la tarjeta. Captura el gasto en el vuelo: el aviso no bloquea el cierre, pero el vuelo sigue en esta lista mientras no tenga uno.',
      count: 10,
      lectura_fallida: false,
    });
    // Por fecha_vuelo (no por folio: #200 va después de #341) y, con la
    // misma fecha, por folio (#301 · #330 · #340 y #350 · #351); matrícula
    // aditiva del avión del vuelo.
    expect((item.vuelos as Fila[]).map((v) => v.folio)).toEqual([
      268, 295, 301, 330, 340, 341, 200, 350, 351, 360,
    ]);
    // Forma completa del chip (matrícula del avión del vuelo).
    const chip = (folio: number, fecha: string, matricula = 'XA-VGV') => ({
      id: `v${folio}`,
      folio,
      fecha_vuelo: fecha,
      matricula,
    });
    expect(item.vuelos).toEqual([
      chip(268, '2026-09-07T16:00:00+00:00', 'N4142R'),
      chip(295, '2026-09-12T15:00:00+00:00'),
      chip(301, '2026-09-15T15:00:00+00:00'),
      chip(330, '2026-09-15T15:00:00+00:00'),
      chip(340, '2026-09-15T15:00:00+00:00'),
      chip(341, '2026-09-20T15:00:00+00:00'),
      chip(200, '2026-09-25T15:00:00+00:00'),
      chip(350, '2026-09-27T15:00:00+00:00'),
      chip(351, '2026-09-27T15:00:00+00:00'),
      chip(360, '2026-10-01T03:00:00+00:00'),
    ]);
    // Aviso, no candado: sin bloqueantes el periodo sigue «listo».
    expect(r.listo).toBe(true);
    expect(item).not.toHaveProperty('informativo');

    // Junto a pistas_sin_gasto (el panel los pinta en ese orden).
    const claves = r.items.map((i) => i.clave);
    expect(claves.indexOf(CLAVE)).toBe(claves.indexOf('pistas_sin_gasto') + 1);

    // La consulta de gastos: por vuelo_id y SOLO pista/aterrizaje, SIN
    // filtro de fecha (la cuota se paga días después, a veces en otro mes).
    const qGasto = llamadas.find(
      (l) =>
        l.tabla === 'gasto' &&
        l.ops.some((o) => o[0] === 'in' && o[1][0] === 'categoria'),
    )!;
    expect(qGasto.ops).toContainEqual([
      'in',
      ['categoria', ['OPERACIONES', 'ATERRIZAJE']],
    ]);
    expect(qGasto.ops.some((o) => o[1][0] === 'fecha_gasto')).toBe(false);
  });

  it('cada regla por separado: COMIDA, cliente interno y servicio SÍ listan; pista de otra fecha, externo, sin avión y cancelado NO', async () => {
    const casos: Array<[string, Record<string, Fila[]>, number[]]> = [
      [
        'sin ningún gasto',
        { aeronave: AERONAVES, cliente: CLIENTES, vuelo: [vuelo('a', 1)] },
        [1],
      ],
      [
        'solo COMIDA',
        {
          aeronave: AERONAVES,
          cliente: CLIENTES,
          vuelo: [vuelo('a', 1)],
          gasto: [gasto('g', 'a', 'COMIDA', '2026-09-15')],
        },
        [1],
      ],
      [
        'OPERACIONES de otra fecha',
        {
          aeronave: AERONAVES,
          cliente: CLIENTES,
          vuelo: [vuelo('a', 1)],
          gasto: [gasto('g', 'a', 'OPERACIONES', '2026-11-20')],
        },
        [],
      ],
      [
        'externo',
        {
          aeronave: AERONAVES,
          cliente: CLIENTES,
          vuelo: [vuelo('a', 1, { es_externo: true })],
        },
        [],
      ],
      [
        'cliente interno',
        {
          aeronave: AERONAVES,
          cliente: CLIENTES,
          vuelo: [vuelo('a', 1, { cliente_id: 'cli-int' })],
        },
        [1],
      ],
      [
        'cliente interno CON pista',
        {
          aeronave: AERONAVES,
          cliente: CLIENTES,
          vuelo: [vuelo('a', 1, { cliente_id: 'cli-int' })],
          gasto: [gasto('g', 'a', 'OPERACIONES', '2026-09-15')],
        },
        [],
      ],
      [
        'servicio',
        {
          aeronave: AERONAVES,
          cliente: CLIENTES,
          vuelo: [vuelo('a', 1)],
          escala: [tramo('e', 'a', { tipo_parada: 'SERVICIO', pasajeros: 0 })],
        },
        [1],
      ],
      [
        'sin avión',
        {
          aeronave: AERONAVES,
          cliente: CLIENTES,
          vuelo: [vuelo('a', 1, { aeronave_id: null })],
        },
        [],
      ],
      [
        'cancelado',
        {
          aeronave: AERONAVES,
          cliente: CLIENTES,
          vuelo: [vuelo('a', 1, { estado: 'CANCELADO' })],
        },
        [],
      ],
    ];
    for (const [nombre, tablas, folios] of casos) {
      const { svc } = armar(tablas);
      const item = itemDe(await svc.preCierre(PERIODO));
      expect([nombre, (item.vuelos as Fila[]).map((v) => v.folio)]).toEqual([
        nombre,
        folios,
      ]);
      expect([nombre, item.count]).toEqual([nombre, folios.length]);
    }
  });

  it('ANTI-CAP: lotes de ≤ 200 vuelos y cada lote PAGINADO — ningún vuelo sale «sin gasto» en falso', async () => {
    // 300 vuelos con 6 cuotas de pista cada uno (las pagadas en octubre) y
    // UNO sin nada. El primer lote (200 vuelos) trae 1,200 gastos: sin
    // paginar, PostgREST entregaría solo 1,000 y los vuelos 167-199
    // saldrían «sin gasto» sin serlo.
    const vuelos: Fila[] = [];
    const gastos: Fila[] = [];
    for (let i = 0; i < 300; i += 1) {
      const id = `v${String(i).padStart(4, '0')}`;
      vuelos.push(vuelo(id, 1000 + i));
      if (i === 250) continue;
      for (let k = 0; k < 6; k += 1) {
        gastos.push(gasto(`g${id}-${k}`, id, 'OPERACIONES', '2026-10-05'));
      }
    }
    const { svc, llamadas } = armar({
      aeronave: AERONAVES,
      cliente: CLIENTES,
      vuelo: vuelos,
      gasto: gastos,
    });
    const item = itemDe(await svc.preCierre(PERIODO));
    expect(item).toMatchObject({ count: 1, lectura_fallida: false });
    expect((item.vuelos as Fila[]).map((v) => v.folio)).toEqual([1250]);

    const qGastos = llamadas.filter(
      (l) =>
        l.tabla === 'gasto' &&
        l.ops.some((o) => o[0] === 'in' && o[1][0] === 'categoria'),
    );
    const lote = (l: Llamada) =>
      (l.ops.find((o) => o[0] === 'in' && o[1][0] === 'vuelo_id')?.[1][1] ??
        []) as string[];
    expect(qGastos.map((l) => lote(l).length)).toEqual([200, 200, 100]);
    expect(
      qGastos.map((l) => l.ops.find((o) => o[0] === 'range')?.[1]),
    ).toEqual([
      [0, 999],
      [1000, 1999],
      [0, 999],
    ]);
    // Orden TOTAL por id: las páginas no se traslapan.
    for (const l of qGastos) {
      expect(l.ops).toContainEqual(['order', ['id', { ascending: true }]]);
    }
  });

  it('lectura fallida de los gastos ⇒ count 0 MARCADO con lectura_fallida, sin tumbar el pre-cierre', async () => {
    const fallas: Array<[string, (tabla: string, ops: Op[]) => boolean]> = [
      [
        'gastos de pista',
        (tabla, ops) =>
          tabla === 'gasto' &&
          ops.some((o) => o[0] === 'in' && o[1][0] === 'categoria'),
      ],
    ];
    for (const [nombre, fallar] of fallas) {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const { svc } = armar(septiembre(), fallar);
      const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
      // El fallo se registra (jamás un 0 silencioso).
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('vuelos sin gasto de operaciones'),
      );
      warn.mockRestore();
      const item = itemDe(r);
      expect([nombre, item]).toEqual([
        nombre,
        expect.objectContaining({
          count: 0,
          vuelos: [],
          lectura_fallida: true,
        }),
      ]);
      expect(String(item.detalle)).toContain('No se pudo verificar');
      // El resto del checklist sigue ahí y el aviso no bloquea.
      expect(r.items.some((i) => i.clave === 'pistas_sin_gasto')).toBe(true);
      expect(r.listo).toBe(true);
    }
  });
});
