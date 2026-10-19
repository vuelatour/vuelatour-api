// La sonda de AFAC y la de cierre de mes no son de este spec: se fijan en
// «sin migración» (la ubicación del gasto en el balance no cambia con ellas).
jest.mock('../../common/afac-real-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/afac-real-disponible.util',
  ),
  afacRealDisponible: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

import { CajaChicaService } from './caja-chica.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * CAJA CHICA y gastos «por pagar» (19-oct-2026, API 0.0.95, invariante 93).
 * Un EFECTIVO por pagar vigente (estado ≠ PAGADO) todavía no sale de la
 * caja: queda FUERA del libro (saldo, por reponer, reposición) y viaja en la
 * lista ADITIVA `por_pagar`. Al marcarse pagado entra con su fecha real. Sin
 * por pagar —o sin la migración— el libro es byte a byte el de siempre.
 *
 * Reloj: lunes 19-oct-2026 10:00 Cancún.
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const USER = 'u-pablo';
const FONDO = 'f-pablo';

interface Consulta {
  tabla: string;
  sel: string;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Supabase falso por tabla (eq/in/is/gte/lte/order/limit) + la sonda. */
function fakeSupabase(db: Tablas, opts: { sinPorPagar?: boolean } = {}) {
  const log: Consulta[] = [];
  const service = {
    from(tabla: string) {
      const q: Consulta = { tabla, sel: '' };
      log.push(q);
      const filtros: Array<(r: Row) => boolean> = [];
      let tope: number | null = null;
      const sinColumna = () =>
        opts.sinPorPagar && tabla === 'gasto' && /\bpor_pagar\b/.test(q.sel);
      const ejecutar = (unico: boolean) => {
        if (sinColumna())
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column gasto.por_pagar does not exist',
            },
          };
        let filas = (db[tabla] ?? []).filter((r) => filtros.every((f) => f(r)));
        if (tope != null) filas = filas.slice(0, tope);
        return { data: unico ? (filas[0] ?? null) : filas, error: null };
      };
      const api: Record<string, unknown> = {
        select(s: string) {
          q.sel = s;
          return api;
        },
        eq(col: string, val: unknown) {
          filtros.push((r) => r[col] === val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        is(col: string, val: unknown) {
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        gte(col: string, val: string) {
          filtros.push((r) => texto(r[col]) >= val);
          return api;
        },
        lte(col: string, val: string) {
          filtros.push((r) => texto(r[col]) <= val);
          return api;
        },
        order: () => api,
        limit(n: number) {
          tope = n;
          return api;
        },
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

const gasto = (id: string, extra: Row = {}): Row => ({
  id,
  monto: 500,
  moneda: 'MXN',
  fecha_gasto: '2026-10-14',
  categoria: 'TAXI',
  lugar: 'CUN',
  notas: null,
  vuelo_id: null,
  escala_id: null,
  aeronave_id: null,
  inventario_movimiento_id: null,
  medio_pago: 'EFECTIVO',
  usuario_captura_id: USER,
  created_at: '2026-10-14T18:00:00+00:00',
  vuelo: null,
  escala: null,
  por_pagar: false,
  conciliado: false,
  ...extra,
});

function mundo(conPorPagar = true): Tablas {
  const gastos: Row[] = [
    gasto('g-taxi'),
    gasto('g-gasolina', {
      categoria: 'GASOLINA',
      monto: 300,
      fecha_gasto: '2026-10-13',
      created_at: '2026-10-13T18:00:00+00:00',
    }),
    // Otra moneda: no es del libro MXN.
    gasto('g-usd', { moneda: 'USD', monto: 40 }),
  ];
  if (conPorPagar) {
    gastos.push(
      // Por pagar (fecha futura): todavía no sale de la caja.
      gasto('g-hotel', {
        categoria: 'HOTEL',
        monto: 1200,
        fecha_gasto: '2026-10-25',
        notas: 'Hotel Chetumal\nreserva 123',
        por_pagar: true,
        created_at: '2026-10-19T14:00:00+00:00',
      }),
      // Vencido (fecha pasada, sigue por pagar).
      gasto('g-comida', {
        categoria: 'COMIDA',
        monto: 250.5,
        fecha_gasto: '2026-10-16',
        lugar: 'Mercado 28',
        por_pagar: true,
        created_at: '2026-10-15T14:00:00+00:00',
      }),
      // Por pagar en USD: ni en el libro ni en la lista MXN.
      gasto('g-usd-pp', {
        moneda: 'USD',
        monto: 30,
        fecha_gasto: '2026-10-22',
        por_pagar: true,
      }),
      // Conciliado con el banco ⇒ PAGADO aunque la columna diga true.
      gasto('g-conc', {
        monto: 80,
        fecha_gasto: '2026-10-12',
        por_pagar: true,
        conciliado: true,
        created_at: '2026-10-12T18:00:00+00:00',
      }),
    );
  }
  return {
    caja_chica_fondo: [
      {
        id: FONDO,
        usuario_id: USER,
        moneda: 'MXN',
        activo: true,
        es_acumulada: false,
        monto_fondo: 5000,
        usuario: { nombre: 'Pablo Canales', email: 'p@x.mx', rol: 'PILOTO' },
      },
    ],
    caja_chica_movimiento: [
      {
        id: 'm-repo',
        fondo_id: FONDO,
        tipo: 'REPOSICION',
        monto: '5000.00',
        moneda: 'MXN',
        fecha: '2026-10-01',
        autorizado_por: 'u-ale',
        referencia: null,
        notas: 'Fondo octubre',
        registrado_por: 'u-mari',
        espejo_de_id: null,
        created_at: '2026-10-01T15:00:00+00:00',
        autorizado: { nombre: 'Ale' },
        registrado: { nombre: 'Mari' },
      },
    ],
    aeronave: [],
    escala: [],
    gasto_reparto: [],
    gasto: gastos,
  };
}

type Entrada = Record<string, unknown>;
type Detalle = Record<string, unknown> & { historial: Entrada[] };
const detalle = async (db: Tablas, opts: { sinPorPagar?: boolean } = {}) => {
  const f = fakeSupabase(db, opts);
  const svc = new CajaChicaService(f.supabase);
  const d = (await svc.getFondoDetail(FONDO)) as unknown as Detalle;
  return { d, log: f.log };
};
const miFondo = async (db: Tablas, opts: { sinPorPagar?: boolean } = {}) => {
  const f = fakeSupabase(db, opts);
  const svc = new CajaChicaService(f.supabase);
  return (await svc.getMyFondo(USER)) as unknown as Record<string, unknown>;
};
/** Quita las llaves ADITIVAS de por pagar (para comparar contra 0.0.94). */
const sinLlavesPorPagar = (d: Record<string, unknown>) => {
  const { por_pagar: _a, por_pagar_total: _b, ...resto } = d;
  void _a;
  void _b;
  const quitar = (e: Entrada) => {
    const { por_pagar: _c, estado_pago: _d, ...r } = e;
    void _c;
    void _d;
    return r;
  };
  if (Array.isArray(resto.historial))
    resto.historial = (resto.historial as Entrada[]).map(quitar);
  if (Array.isArray(resto.gastos))
    resto.gastos = (resto.gastos as Entrada[]).map(quitar);
  return resto;
};

beforeEach(() =>
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate'],
    now: new Date('2026-10-19T15:00:00Z'),
  }),
);
afterEach(() => jest.useRealTimers());

describe('CajaChicaService.getFondoDetail — gastos por pagar fuera del libro', () => {
  it('el libro (saldo, por reponer, filas) = el mismo mundo SIN los por pagar vigentes', async () => {
    const con = await detalle(mundo(true));
    const sin = await detalle({
      ...mundo(true),
      gasto: mundo(true).gasto.filter(
        (g) => !['g-hotel', 'g-comida', 'g-usd-pp'].includes(String(g.id)),
      ),
    });
    const ids = con.d.historial.map((e) => e.id);
    expect(ids).not.toContain('g-hotel');
    expect(ids).not.toContain('g-comida');
    // El conciliado es PAGADO: sí es del libro.
    expect(ids).toContain('g-conc');
    expect(sinLlavesPorPagar(con.d)).toEqual(
      sinLlavesPorPagar({ ...sin.d, por_pagar: [], por_pagar_total: 0 }),
    );
    expect(con.d.saldo).toBe(5000 - 500 - 300 - 80);
  });

  it('lista ADITIVA `por_pagar` (vencido primero) y su total; USD fuera', async () => {
    const { d } = await detalle(mundo(true));
    expect(d.por_pagar).toEqual([
      {
        id: 'g-comida',
        fecha_gasto: '2026-10-16',
        monto: 250.5,
        moneda: 'MXN',
        categoria: 'COMIDA',
        concepto: 'Mercado 28',
        estado_pago: 'VENCIDO',
      },
      {
        id: 'g-hotel',
        fecha_gasto: '2026-10-25',
        monto: 1200,
        moneda: 'MXN',
        categoria: 'HOTEL',
        concepto: 'Hotel Chetumal',
        estado_pago: 'POR_PAGAR',
      },
    ]);
    expect(d.por_pagar_total).toBe(1450.5);
  });

  it('orden de llaves: `por_pagar` y su total antes de `cajas_fondeadas` (última); en cada gasto, antes de `balance`', async () => {
    const { d } = await detalle(mundo(true));
    const llaves = Object.keys(d);
    expect(llaves.slice(-3)).toEqual([
      'por_pagar',
      'por_pagar_total',
      'cajas_fondeadas',
    ]);
    for (const e of d.historial) {
      const k = Object.keys(e);
      if (e.origen === 'gasto') {
        expect(k.slice(-3)).toEqual(['por_pagar', 'estado_pago', 'balance']);
        expect(e.estado_pago).toBe('PAGADO');
      } else {
        expect(k).not.toContain('estado_pago');
      }
    }
    const conc = d.historial.find((e) => e.id === 'g-conc')!;
    expect(conc).toMatchObject({ por_pagar: true, estado_pago: 'PAGADO' });
  });

  it('MARCAR PAGADO: el gasto entra al libro con su fecha real', async () => {
    const m = mundo(true);
    const hotel = m.gasto.find((g) => g.id === 'g-hotel')!;
    hotel.por_pagar = false;
    hotel.fecha_gasto = '2026-10-19';
    const { d } = await detalle(m);
    const fila = d.historial.find((e) => e.id === 'g-hotel')!;
    expect(fila).toMatchObject({ fecha: '2026-10-19', estado_pago: 'PAGADO' });
    expect((d.por_pagar as Entrada[]).map((g) => g.id)).toEqual(['g-comida']);
    expect(d.saldo).toBe(5000 - 500 - 300 - 80 - 1200);
  });

  it('SIN la migración: byte a byte el de siempre (sin llaves; ninguna consulta nombra la columna salvo la sonda)', async () => {
    const sinMig = await detalle(mundo(false), { sinPorPagar: true });
    expect(sinMig.d).not.toHaveProperty('por_pagar');
    expect(sinMig.d).not.toHaveProperty('por_pagar_total');
    for (const e of sinMig.d.historial) {
      expect(e).not.toHaveProperty('estado_pago');
      expect(e).not.toHaveProperty('por_pagar');
    }
    const nombran = sinMig.log.filter(
      (q) => q.tabla === 'gasto' && /\bpor_pagar\b/.test(q.sel),
    );
    expect(nombran.map((q) => q.sel)).toEqual(['por_pagar']);
    // Mismos saldos y filas que con la migración y SIN por pagar.
    const conMig = await detalle(mundo(false));
    expect(sinLlavesPorPagar(conMig.d)).toEqual(
      sinLlavesPorPagar({ ...sinMig.d }),
    );
  });
});

describe('CajaChicaService.getMyFondo — «Mi caja» de la app', () => {
  it('saldo, lectura y `gastos` sin los por pagar vigentes; lista `por_pagar` al final', async () => {
    const r = await miFondo(mundo(true));
    expect(r.saldo).toBe(5000 - 500 - 300 - 80);
    expect(r.gastado_total).toBe(880);
    const ids = (r.gastos as Entrada[]).map((g) => g.id);
    expect(ids).not.toContain('g-hotel');
    expect(ids).not.toContain('g-comida');
    expect(ids).not.toContain('g-usd-pp');
    for (const g of r.gastos as Entrada[]) {
      expect(g).not.toHaveProperty('conciliado');
      expect(g.estado_pago).toBe('PAGADO');
    }
    expect(r.efectivo_otras_monedas).toEqual([{ moneda: 'USD', total: 40 }]);
    expect(Object.keys(r).slice(-2)).toEqual(['por_pagar', 'por_pagar_total']);
    expect((r.por_pagar as Entrada[]).map((g) => g.id)).toEqual([
      'g-comida',
      'g-hotel',
    ]);
    expect(r.por_pagar_total).toBe(1450.5);
  });

  it('SIN la migración: la respuesta de siempre (sin las llaves)', async () => {
    const r = await miFondo(mundo(false), { sinPorPagar: true });
    expect(r).not.toHaveProperty('por_pagar');
    for (const g of r.gastos as Entrada[])
      expect(g).not.toHaveProperty('estado_pago');
    const conMig = await miFondo(mundo(false));
    expect(sinLlavesPorPagar(conMig)).toEqual(sinLlavesPorPagar(r));
  });
});
