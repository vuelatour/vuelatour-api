// Mismos stubs que expenses.service.spec.ts: notifications arrastra el
// gateway y `jose` (ESM puro), vision el SDK de IA y pyservices el cliente.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { ExpensesService } from './expenses.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  TablaHojaPayload,
  TablaXlsxPayload,
} from '../pyservices/pyservices.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';
import type { ListGastosQuery } from './dto/expenses.dto';
import {
  aCargoDeGasto,
  type CargosDeGastoLeidos,
} from '../conciliacion/cargos-de-gasto.util';
import {
  NOTA_DETALLE_BANCO_NO_DISPONIBLE,
  NOTA_FOLIOS_NO_DISPONIBLES,
  TEXTO_DETALLE_BANCO_NO_DISPONIBLE,
} from './gastos-xlsx.util';
import { FILAS_REALES } from './gasto-avion.fixture-spec';

/**
 * EXCEL DE GASTOS (13-oct-2026, invariante 71): paginado (prod tiene 1,112
 * gastos y el libro salía cortado en 1,000), desempate por id y, para
 * ADMIN / FACTURACION, el detalle del banco al final + la pestaña «Cargos
 * del banco». COORDINADOR / ANALISTA: el libro de siempre.
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const txt = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = txt(a);
  const sb = txt(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

interface OpcionesFake {
  maxFilas?: number;
  sinSerieFolio?: boolean;
  fallaFolios?: boolean;
}

type Llamada = { tabla: string; metodo: string; args: unknown[] };

function fake(db: Tablas, opts: OpcionesFake = {}) {
  const log: Llamada[] = [];
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      const orden: Array<[string, boolean]> = [];
      let rango: [number, number] | null = null;
      let limite: number | null = null;
      let sel = '';
      let conCount = false;
      const q: Record<string, unknown> = {};
      const reg = (metodo: string, args: unknown[]) =>
        log.push({ tabla, metodo, args });
      q.select = (s?: string, o?: { count?: string }) => {
        reg('select', [s, o]);
        sel = s ?? '';
        conCount = o?.count === 'exact';
        return q;
      };
      q.order = (col: string, o?: { ascending?: boolean }) => {
        reg('order', [col, o]);
        orden.push([col, o?.ascending !== false]);
        return q;
      };
      q.range = (a: number, b: number) => {
        reg('range', [a, b]);
        rango = [a, b];
        return q;
      };
      q.limit = (n: number) => {
        reg('limit', [n]);
        limite = n;
        return q;
      };
      q.eq = (col: string, v: unknown) => {
        reg('eq', [col, v]);
        filtros.push((r) => r[col] === v);
        return q;
      };
      q.in = (col: string, vals: unknown[]) => {
        reg('in', [col, vals]);
        filtros.push((r) => vals.includes(r[col]));
        return q;
      };
      for (const m of ['is', 'not', 'gte', 'lte', 'neq', 'or']) {
        q[m] = (...args: unknown[]) => {
          reg(m, args);
          return q;
        };
      }
      const ejecutar = () => {
        if (
          opts.sinSerieFolio &&
          tabla === 'factura_recibida' &&
          /\bserie\b/.test(sel)
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
        if (
          opts.fallaFolios &&
          tabla === 'gasto' &&
          sel.startsWith('id, folio_ticket')
        ) {
          return { data: null, error: { message: 'caída' }, count: null };
        }
        let filas = (db[tabla] ?? [])
          .filter((r) => filtros.every((f) => f(r)))
          .map((r) => ({ ...r }));
        for (const [col, asc] of [...orden].reverse()) {
          filas.sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
        }
        const total = filas.length;
        if (rango) filas = filas.slice(rango[0], rango[1] + 1);
        if (limite != null) filas = filas.slice(0, limite);
        if (opts.maxFilas != null) filas = filas.slice(0, opts.maxFilas);
        return { data: filas, error: null, count: conCount ? total : null };
      };
      q.maybeSingle = () => {
        const r = ejecutar();
        return Promise.resolve({ ...r, data: r.data?.[0] ?? null });
      };
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(ejecutar()).then(res, rej);
      return q;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

const gastoFila = (i: number, extra: Row = {}): Row => ({
  id: `g-${String(i).padStart(4, '0')}`,
  fecha_gasto: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
  // Mismo alta en grupos de 3: el desempate por id decide.
  created_at: `2026-09-30T1${i % 10}:00:00Z`,
  capturado_en: null,
  categoria: 'OPERACIONES',
  monto: 100 + i,
  moneda: 'MXN',
  medio_pago: 'EFECTIVO',
  conciliado: false,
  notas: `Gasto ${i}\nsegunda línea`,
  lugar: null,
  estatus_comprobante: 'FACTURA',
  estatus_facturacion: 'PENDIENTE',
  tc_gasto: null,
  folio_ticket: null,
  vuelo_id: null,
  ...extra,
});

/** g-0000 CONCILIADO (lote), g-0001 PARCIAL, g-0002 SIN_CONCILIAR. */
function mundo(n = 6): Tablas {
  const gasto: Row[] = [];
  for (let i = 0; i < n; i += 1) gasto.push(gastoFila(i));
  Object.assign(gasto[0], {
    medio_pago: 'TRANSFERENCIA',
    conciliado: true,
    monto: 2801.4,
    folio_ticket: 'A-0411',
    vuelo: { folio: 345 },
  });
  Object.assign(gasto[1], {
    medio_pago: 'TRANSFERENCIA',
    monto: 1800,
    folio_ticket: 'FEACZM 72128',
  });
  Object.assign(gasto[2], { medio_pago: 'TARJETA_CORP' });
  return {
    gasto,
    v_gasto_conciliacion: [
      { gasto_id: 'g-0000', monto_vinculado: 2801.4 },
      { gasto_id: 'g-0001', monto_vinculado: 1200 },
    ],
  };
}

const EJE = {
  id: 'cta-eje',
  alias: 'EJE SCOTIA',
  banco: 'Scotiabank',
  moneda: 'MXN',
  tipo: 'BANCO',
};

function leidosMundo(): Map<string, CargosDeGastoLeidos> {
  const lote = aCargoDeGasto({
    parte: {
      movimiento_id: 'm-saesa',
      monto_parte: 2801.4,
      moneda: 'MXN',
      created_at: '2026-10-13T21:43:29Z',
      ligada_por: 'Diego Ramírez',
    },
    mov: {
      id: 'm-saesa',
      fecha: '2026-09-30',
      tipo: 'CARGO',
      monto: -11205.6,
      cuenta: EJE,
      estado_cuenta_id: 'ec-1',
      estado_cuenta: {
        id: 'ec-1',
        filename: 'scotia eje sep.pdf',
        created_at: '2026-10-06T15:22:46Z',
      },
      gastos_n: 4,
      gastos: [],
      gastos_suma: 11205.62,
      gastos_diferencia: -0.02,
    },
    gasto: { id: 'g-0000', moneda: 'MXN' },
  });
  const parcial = aCargoDeGasto({
    parte: {
      movimiento_id: 'm-1200',
      monto_parte: 1200,
      moneda: 'MXN',
      created_at: '2026-09-01T00:00:00Z',
    },
    mov: {
      id: 'm-1200',
      fecha: '2026-09-25',
      tipo: 'CARGO',
      monto: -1200,
      cuenta: EJE,
      estado_cuenta_id: 'ec-1',
      estado_cuenta: {
        id: 'ec-1',
        filename: 'scotia eje sep.pdf',
        created_at: '2026-10-06T15:22:46Z',
      },
      gastos_n: 1,
    },
    gasto: { id: 'g-0001', moneda: 'MXN' },
  });
  return new Map<string, CargosDeGastoLeidos>([
    ['g-0000', { fuente: 'PUENTE', vista: null, cargos: [lote] }],
    ['g-0001', { fuente: 'PUENTE', vista: null, cargos: [parcial] }],
  ]);
}

function armar(
  db: Tablas,
  opts: OpcionesFake & {
    conciliacion?: Partial<ConciliacionService> | null;
  } = {},
) {
  const f = fake(db, opts);
  const generateTablaXlsx = jest.fn().mockResolvedValue(Buffer.from('xlsx'));
  const leerCargosDeGastos = jest.fn().mockResolvedValue(leidosMundo());
  const conciliacion =
    opts.conciliacion === null
      ? undefined
      : ((opts.conciliacion ?? {
          leerCargosDeGastos,
        }) as unknown as ConciliacionService);
  const nada = {} as never;
  const service = new ExpensesService(
    f.supabase,
    nada,
    { generateTablaXlsx } as never,
    nada,
    { numero: jest.fn().mockResolvedValue(1) } as never,
    nada,
    nada,
    conciliacion,
  );
  return { service, log: f.log, generateTablaXlsx, leerCargosDeGastos };
}

const Q = { limit: 50, offset: 0 } as ListGastosQuery;
/** Fila de la pestaña por su «Concepto» («Gasto i»): el orden es fecha desc. */
const fila = (h: { filas: Array<Array<string | number | null>> }, i: number) =>
  h.filas.find((f) => f[2] === `Gasto ${i}`)!;
const payloadDe = (fn: jest.Mock): TablaXlsxPayload =>
  (fn.mock.calls[0] as [TablaXlsxPayload])[0];

const COLUMNAS_DE_HOY = [
  'Fecha',
  'Categoría',
  'Concepto',
  'Avión',
  'Proveedor',
  'Capturó',
  'Medio pago',
  'Banco',
  'Comprobante',
  'Facturación',
  'Moneda',
  'Monto',
  'TUA incluida',
  'Origen TUA',
  'Capturado',
];

describe('Excel de gastos — paginado y desempate (13-oct-2026)', () => {
  it('(i) ANTI-TOPE: 1,112 gastos con max-rows 1000 ⇒ las 1,112 filas en 2 páginas', async () => {
    const { service, log, generateTablaXlsx } = armar(mundo(1112), {
      maxFilas: 1000,
    });
    await service.listXlsx(Q);
    expect(payloadDe(generateTablaXlsx).filas).toHaveLength(1112);
    const rangos = log
      .filter((l) => l.tabla === 'gasto' && l.metodo === 'range')
      .map((l) => l.args);
    expect(rangos).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  }, 30_000);

  it('(ii) list() termina en .order(id)', async () => {
    const { service, log } = armar(mundo());
    await service.list(Q);
    const ordenes = log
      .filter((l) => l.tabla === 'gasto' && l.metodo === 'order')
      .map((l) => l.args[0]);
    expect(ordenes[ordenes.length - 1]).toBe('id');
  });

  it('(x) con el tope alcanzado, el subtítulo lo AVISA', async () => {
    const w = armar(mundo(1112), { maxFilas: 1000 });
    const priv = w.service as unknown as {
      listParaXlsx: (
        f: ListGastosQuery,
        tope?: number,
      ) => Promise<{ data: Row[]; count: number; truncado: boolean }>;
    };
    const r = await priv.listParaXlsx(Q, 1000);
    expect(r).toMatchObject({ count: 1112, truncado: true });
    expect(r.data).toHaveLength(1000);
    const original = priv.listParaXlsx.bind(w.service);
    jest
      .spyOn(priv, 'listParaXlsx')
      .mockImplementation((f: ListGastosQuery) => original(f, 1000));
    await w.service.listXlsx(Q);
    expect(payloadDe(w.generateTablaXlsx).subtitulo).toContain(
      ' · OJO: se exportaron 1,000 de 1,112 gastos (tope del Excel); acota los filtros',
    );
    // Sin corte (tope de siempre), sin nota.
    const sin = await original(Q);
    expect(sin).toMatchObject({ count: 1112, truncado: false });
    expect(sin.data).toHaveLength(1112);
  }, 30_000);
});

describe('Excel de gastos — detalle del banco por rol', () => {
  it('(iii) sin detalleBanco: el libro de siempre, sin hojas ni lecturas del banco', async () => {
    const { service, generateTablaXlsx, leerCargosDeGastos, log } =
      armar(mundo());
    await service.listXlsx(Q);
    const p = payloadDe(generateTablaXlsx);
    expect(p).not.toHaveProperty('hojas');
    expect(p.titulo).toBe('Gastos por avión / categoría');
    expect(p.resumen_titulo).toBe('Total del periodo por categoría');
    expect(p.columnas.map((c) => c.label)).toEqual(COLUMNAS_DE_HOY);
    // «Concepto» = la primera línea de las notas (fecha desc: 5 … 0).
    expect(p.filas.map((f) => f[2])).toEqual([
      'Gasto 5',
      'Gasto 4',
      'Gasto 3',
      'Gasto 2',
      'Gasto 1',
      'Gasto 0',
    ]);
    expect(leerCargosDeGastos).not.toHaveBeenCalled();
    expect(
      log.some(
        (l) =>
          l.tabla === 'gasto' &&
          l.metodo === 'select' &&
          String(l.args[0]).startsWith('id, folio_ticket'),
      ),
    ).toBe(false);
  });

  it('(iv)(v) con detalleBanco: la pestaña de siempre + 3 columnas al final y «Cargos del banco»', async () => {
    const base = armar(mundo());
    await base.service.listXlsx(Q);
    const hoy = payloadDe(base.generateTablaXlsx);

    const w = armar(mundo());
    await w.service.listXlsx(Q, { detalleBanco: true });
    const p = payloadDe(w.generateTablaXlsx);
    const [h0, h1] = p.hojas as TablaHojaPayload[];
    expect(p.hojas).toHaveLength(2);
    expect(h0.titulo).toBe(hoy.titulo);
    expect(h0.subtitulo).toBe(hoy.subtitulo);
    expect(h0.resumen_titulo).toBe(hoy.resumen_titulo);
    expect(h0.resumen).toEqual(hoy.resumen);
    expect(h0.columnas).toEqual([
      ...hoy.columnas,
      { label: 'Factura' },
      { label: 'Cargo del banco' },
      { label: 'Estado de cuenta' },
    ]);
    expect(h0.filas).toHaveLength(hoy.filas.length);
    h0.filas.forEach((f, i) => {
      expect(f.slice(0, hoy.filas[i].length)).toEqual(hoy.filas[i]);
      expect(f).toHaveLength(hoy.filas[i].length + 3);
    });
    const n = hoy.filas[0].length;
    // g-0000 (lote): factura, cargo y estado de cuenta.
    expect(fila(h0, 0).slice(n)).toEqual([
      'A-0411',
      '30-sep-2026 · EJE SCOTIA · $11,205.60 (paga 4 gastos; a este $2,801.40)',
      'scotia eje sep.pdf (importado 06-oct-2026)',
    ]);
    // g-0001 (PARCIAL): « · faltan $600.00 de $1,800.00».
    expect(fila(h0, 1)[n + 1]).toBe(
      '25-sep-2026 · EJE SCOTIA · $1,200.00 · faltan $600.00 de $1,800.00',
    );
    // g-0002 (sin conciliar): vacías.
    expect(fila(h0, 2).slice(n + 1)).toEqual(['', '']);
    // UNA lectura, solo conciliados o con algo vinculado, sin la vista.
    expect(w.leerCargosDeGastos).toHaveBeenCalledTimes(1);
    const [ids, o] = w.leerCargosDeGastos.mock.calls[0] as [
      Array<{ id: string }>,
      unknown,
    ];
    expect(ids.map((x) => x.id).sort()).toEqual(['g-0000', 'g-0001']);
    expect(o).toEqual({ vista: false });
    // Pestaña 2: una fila por par, en el orden de la lista (fecha desc).
    expect(h1.titulo).toBe('Cargos del banco');
    expect(h1.columnas).toHaveLength(22);
    expect(h1.filas.map((f) => f[3])).toEqual(['Gasto 1', 'Gasto 0']);
    const lote = h1.filas[1];
    expect(lote[12]).toBe(11205.6);
    expect(lote[14]).toBe(2801.4);
    expect(lote[16]).toBe(-0.02);
    expect(lote[20]).toBe('Diego Ramírez · 13-oct-2026');
    // El resalte con el desfase de la fila del lote (la 2.ª).
    expect(h1.resaltes).toEqual([{ fila: 1, col: 16 }]);
    expect(h1.filas[0][20]).toBe('(anterior al 02-oct-2026)');
    // La raíz solo nombra el libro.
    expect(p.filas).toEqual([]);
  });

  it('(vi)(viii) si la lectura del banco falla (o no hay módulo): UNA hoja, aviso en CONCILIADO/PARCIAL y la nota; «Factura» sigue', async () => {
    for (const conciliacion of [
      {
        leerCargosDeGastos: jest.fn().mockRejectedValue(new Error('caída')),
      },
      null,
    ]) {
      const w = armar(mundo(), { conciliacion });
      await w.service.listXlsx(Q, { detalleBanco: true });
      const p = payloadDe(w.generateTablaXlsx);
      expect(p.hojas).toHaveLength(1);
      const h0 = (p.hojas as TablaHojaPayload[])[0];
      expect(h0.subtitulo).toContain(NOTA_DETALLE_BANCO_NO_DISPONIBLE);
      const n = h0.columnas.length - 3;
      expect(fila(h0, 0).slice(n)).toEqual([
        'A-0411',
        TEXTO_DETALLE_BANCO_NO_DISPONIBLE,
        TEXTO_DETALLE_BANCO_NO_DISPONIBLE,
      ]);
      expect(fila(h0, 1).slice(n)).toEqual([
        'FEACZM 72128',
        TEXTO_DETALLE_BANCO_NO_DISPONIBLE,
        TEXTO_DETALLE_BANCO_NO_DISPONIBLE,
      ]);
      expect(fila(h0, 2).slice(n)).toEqual(['', '', '']);
    }
  });

  it('(vii) si fallan los folios: «Factura» vacía con su nota; la pestaña 2 sale igual', async () => {
    const w = armar(mundo(), { fallaFolios: true });
    await w.service.listXlsx(Q, { detalleBanco: true });
    const p = payloadDe(w.generateTablaXlsx);
    const [h0, h1] = p.hojas as TablaHojaPayload[];
    expect(h0.subtitulo).toContain(NOTA_FOLIOS_NO_DISPONIBLES);
    expect(h0.subtitulo).not.toContain(NOTA_DETALLE_BANCO_NO_DISPONIBLE);
    const n = h0.columnas.length - 3;
    expect(fila(h0, 0)[n]).toBe('');
    expect(fila(h0, 0)[n + 1]).toContain('EJE SCOTIA');
    expect(h1.filas).toHaveLength(2);
    expect(h1.filas.map((f) => f[4])).toEqual(['', '']);
  });

  it('(ix) sin la sonda de serie/folio la consulta de folios no nombra «serie»', async () => {
    const w = armar(mundo(), { sinSerieFolio: true });
    await w.service.listXlsx(Q, { detalleBanco: true });
    const folios = w.log.filter(
      (l) =>
        l.tabla === 'gasto' &&
        l.metodo === 'select' &&
        String(l.args[0]).startsWith('id, folio_ticket'),
    );
    expect(folios.length).toBeGreaterThan(0);
    for (const l of folios) expect(String(l.args[0])).not.toMatch(/\bserie\b/);
    const h0 = (payloadDe(w.generateTablaXlsx).hojas as TablaHojaPayload[])[0];
    expect(fila(h0, 0)[h0.columnas.length - 3]).toBe('A-0411');
  });
});

describe('Excel de gastos — columna «Avión» = la tabla del panel (15-oct-2026)', () => {
  it('cada gasto REAL dice lo que dice la tabla, con y sin el detalle del banco', async () => {
    const db: Tablas = {
      gasto: FILAS_REALES.map((c, i) =>
        gastoFila(i, { ...c.fila, notas: `Gasto ${i}` }),
      ),
    };
    const simple = armar(db);
    await simple.service.listXlsx(Q);
    const p = payloadDe(simple.generateTablaXlsx);
    expect(p.columnas.map((c) => c.label)).toEqual(COLUMNAS_DE_HOY);
    expect(p.columnas[3]).toEqual({ label: 'Avión' });
    FILAS_REALES.forEach((c, i) => {
      expect([c.nombre, fila(p, i)[3]]).toEqual([c.nombre, c.celda]);
    });

    const banco = armar(db);
    await banco.service.listXlsx(Q, { detalleBanco: true });
    const [h0] = payloadDe(banco.generateTablaXlsx).hojas as TablaHojaPayload[];
    expect(h0.columnas[3]).toEqual({ label: 'Avión' });
    FILAS_REALES.forEach((c, i) => {
      expect([c.nombre, fila(h0, i)[3]]).toEqual([c.nombre, c.celda]);
      // La pestaña con el banco repite la de siempre: misma fila, mismas celdas.
      expect(fila(h0, i).slice(0, p.columnas.length)).toEqual(fila(p, i));
    });
  });
});
