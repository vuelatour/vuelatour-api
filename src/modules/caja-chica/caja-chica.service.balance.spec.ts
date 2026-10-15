import { Logger } from '@nestjs/common';
import { CajaChicaService } from './caja-chica.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { GASTO_UBICACION_COLS } from '../../common/ubicacion-balance-lector';

/**
 * CAJA CHICA: UBICACIÓN EN EL BALANCE DE CADA GASTO DEL FONDO (15-oct-2026,
 * invariante 82). Pedido del cliente con la captura del fondo de Pablo
 * Canales («Gasto en efectivo #436 · Taxi / estacionamiento · −$500.00»):
 * «estaria genial que se mande a la celda en los balances». El detalle
 * (`getFondoDetail`) pone en cada entrada de GASTO el ADITIVO `balance`
 * (lector COMPARTIDO con Conciliación, UNA llamada en lote) como ÚLTIMA
 * llave; las entradas de CAJA no cambian; si la lectura cae, sin la llave y
 * sin lanzar.
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const USER = 'u-pablo';
const FONDO = 'f-pablo';
const N41 = 'av-n41';

interface Consulta {
  tabla: string;
  sel: string;
  ins: Array<{ col: string; vals: unknown[] }>;
}

/**
 * Supabase falso por tabla con filtros `eq`/`in`/`is`. Las filas de `gasto`
 * traen YA los embeds que piden las dos lecturas (`vuelo` con folio y los
 * datos de la regla; `escala`), así sirven al libro y al lector.
 */
function fakeSupabase(db: Tablas, falla?: (q: Consulta) => boolean) {
  const log: Consulta[] = [];
  const service = {
    from(tabla: string) {
      const q: Consulta = { tabla, sel: '', ins: [] };
      log.push(q);
      const filtros: Array<(r: Row) => boolean> = [];
      const ejecutar = (unico: boolean) => {
        if (falla?.(q)) return { data: null, error: { message: 'caída' } };
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
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
          q.ins.push({ col, vals });
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        is(col: string, val: unknown) {
          filtros.push((r) => (r[col] ?? null) === val);
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

const gastoFila = (id: string, extra: Row = {}): Row => ({
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
  ...extra,
});

function mundo(): Tablas {
  return {
    caja_chica_fondo: [
      {
        id: FONDO,
        usuario_id: USER,
        moneda: 'MXN',
        activo: true,
        es_acumulada: true,
        monto_fondo: null,
        usuario: { nombre: 'Pablo Canales', email: 'p@x.mx', rol: 'PILOTO' },
      },
    ],
    caja_chica_movimiento: [
      {
        id: 'm-repo',
        fondo_id: FONDO,
        tipo: 'REPOSICION',
        monto: '2000.00',
        moneda: 'MXN',
        fecha: '2026-10-01',
        autorizado_por: 'u-ale',
        referencia: null,
        notas: 'Reposición octubre',
        registrado_por: 'u-mari',
        espejo_de_id: null,
        created_at: '2026-10-01T15:00:00+00:00',
        autorizado: { nombre: 'Ale' },
        registrado: { nombre: 'Mari' },
      },
    ],
    aeronave: [{ id: N41, matricula: 'N4142R' }],
    escala: [],
    gasto_reparto: [],
    gasto: [
      // #436 · Taxi / estacionamiento del vuelo de N4142R.
      gastoFila('g-436', {
        vuelo_id: 'v-436',
        vuelo: {
          folio: 436,
          fecha_vuelo: '2026-10-14T20:00:00+00:00',
          aeronave_id: N41,
          es_externo: false,
        },
      }),
      // Gasolina de la camioneta: de EMPRESA ⇒ «otros gastos» del general.
      gastoFila('g-gasolina', {
        categoria: 'GASOLINA',
        monto: 300,
        fecha_gasto: '2026-10-13',
        created_at: '2026-10-13T18:00:00+00:00',
      }),
      // Personal del dueño: no vive en ningún libro ⇒ balance null.
      gastoFila('g-dueno', {
        categoria: 'PERSONAL_DUENO',
        monto: 100,
        fecha_gasto: '2026-10-12',
        created_at: '2026-10-12T18:00:00+00:00',
      }),
      // Otra moneda: no entra al libro del fondo MXN (ni se pregunta).
      gastoFila('g-usd', { moneda: 'USD', monto: 40 }),
    ],
  };
}

const esLecturaDeUbicacion = (q: Consulta) =>
  q.tabla === 'gasto' && q.sel === GASTO_UBICACION_COLS;

type Entrada = Record<string, unknown>;
const detalle = async (db: Tablas, falla?: (q: Consulta) => boolean) => {
  const f = fakeSupabase(db, falla);
  const svc = new CajaChicaService(f.supabase);
  const d = await svc.getFondoDetail(FONDO);
  return { d, historial: d.historial as Entrada[], log: f.log };
};
const porId = (h: Entrada[], id: string) => h.find((e) => e.id === id)!;

const LLAVES_BASE = [
  'id',
  'fecha',
  'origen',
  'tipo',
  'monto',
  'descripcion',
  'created_at',
  'vuelo_id',
  'vuelo_folio',
  'saldo',
  'por_reponer',
];

describe('CajaChicaService.getFondoDetail — `balance` de cada gasto (invariante 82)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('#436 Taxi del vuelo de N4142R ⇒ libro del avión y general de OCTUBRE, en la celda del vuelo', async () => {
    const { historial } = await detalle(mundo());
    expect(porId(historial, 'g-436').balance).toEqual({
      periodo: { desde: '2026-10-01', hasta: '2026-10-31' },
      eje: 'vuelo',
      aviones: [{ id: N41, matricula: 'N4142R' }],
      general: true,
      hoja_avion: 'reporte_horas',
      hoja_general: 'reporte_horas',
    });
    expect(porId(historial, 'g-gasolina').balance).toEqual({
      periodo: { desde: '2026-10-01', hasta: '2026-10-31' },
      eje: 'gasto',
      aviones: [],
      general: true,
      hoja_avion: null,
      hoja_general: 'otros_gastos',
    });
    // PERSONAL_DUENO: la llave existe y vale null (sin enlace).
    expect(porId(historial, 'g-dueno')).toHaveProperty('balance', null);
    expect(warn).not.toHaveBeenCalled();
  });

  it('`balance` es la ÚLTIMA llave de cada gasto; las entradas de caja quedan IGUAL (sin la llave)', async () => {
    const { historial } = await detalle(mundo());
    for (const e of historial) {
      if (e.origen === 'gasto') {
        expect(Object.keys(e)).toEqual([...LLAVES_BASE, 'balance']);
      } else {
        expect(Object.keys(e)).toEqual(LLAVES_BASE);
      }
    }
    expect(porId(historial, 'm-repo')).toEqual({
      id: 'm-repo',
      fecha: '2026-10-01',
      origen: 'caja',
      tipo: 'REPOSICION',
      monto: 2000,
      descripcion: 'Reposición octubre',
      created_at: '2026-10-01T15:00:00+00:00',
      vuelo_id: null,
      vuelo_folio: null,
      saldo: 2000,
      por_reponer: 0,
    });
  });

  it('UNA sola lectura en lote, solo con los gastos del libro (sin el de otra moneda)', async () => {
    const { log } = await detalle(mundo());
    const ub = log.filter(esLecturaDeUbicacion);
    expect(ub).toHaveLength(1);
    expect(ub[0].ins).toEqual([
      {
        col: 'id',
        vals: expect.arrayContaining([
          'g-436',
          'g-gasolina',
          'g-dueno',
        ]) as unknown,
      },
    ]);
    expect(ub[0].ins[0].vals).toHaveLength(3);
    expect(log.filter((q) => q.tabla === 'gasto_reparto')).toHaveLength(1);
  });

  it.each([
    ['la lectura de gastos del lector', esLecturaDeUbicacion],
    ['la de repartos', (q: Consulta) => q.tabla === 'gasto_reparto'],
  ])(
    'falla %s ⇒ NINGUNA entrada trae `balance`, no lanza, warn, y lo demás es idéntico',
    async (_n, falla) => {
      const bien = await detalle(mundo());
      const mal = await detalle(mundo(), falla);
      expect(JSON.stringify(mal.d)).not.toContain('"balance"');
      const sinBalance = JSON.parse(
        JSON.stringify(bien.d, (k, v: unknown) =>
          k === 'balance' ? undefined : v,
        ),
      ) as unknown;
      expect(JSON.parse(JSON.stringify(mal.d))).toEqual(sinBalance);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Caja chica sin enlaces al balance \(lectura de gastos o repartos\): caída$/,
        ),
      );
    },
  );

  it('ningún número cambia: saldos, por reponer y orden son los mismos con y sin la lectura', async () => {
    const bien = await detalle(mundo());
    const mal = await detalle(mundo(), esLecturaDeUbicacion);
    expect(bien.d.saldo).toBe(mal.d.saldo);
    expect(bien.d.saldo_libro).toBe(mal.d.saldo_libro);
    expect(
      bien.historial.map((e) => [e.id, e.monto, e.saldo, e.por_reponer]),
    ).toEqual(
      mal.historial.map((e) => [e.id, e.monto, e.saldo, e.por_reponer]),
    );
    expect(bien.historial.map((e) => e.id)).toEqual([
      'g-436',
      'g-gasolina',
      'g-dueno',
      'm-repo',
    ]);
  });

  it('fondo sin gastos ⇒ cero lecturas del lector', async () => {
    const db = mundo();
    db.gasto = [];
    const { historial, log } = await detalle(db);
    expect(historial.map((e) => e.id)).toEqual(['m-repo']);
    expect(log.filter(esLecturaDeUbicacion)).toHaveLength(0);
    expect(log.filter((q) => q.tabla === 'gasto_reparto')).toHaveLength(0);
  });

  it('un gasto que no volvió en la lectura del lector queda sin la llave (los demás sí la llevan)', async () => {
    const db = mundo();
    const f = fakeSupabase(db);
    const svc = new CajaChicaService(f.supabase);
    // Simula el borrado entre el libro y la lectura del lector.
    const original = f.supabase.service.from.bind(f.supabase.service);
    (f.supabase.service as unknown as { from: unknown }).from = (
      tabla: string,
    ) => {
      const api = original(tabla) as unknown as Record<string, unknown>;
      if (tabla !== 'gasto') return api;
      const select = api.select as (s: string) => unknown;
      api.select = (s: string) => {
        if (s === GASTO_UBICACION_COLS) {
          db.gasto = db.gasto.filter((g) => g.id !== 'g-dueno');
        }
        return select(s);
      };
      return api;
    };
    const d = await svc.getFondoDetail(FONDO);
    const h = d.historial as Entrada[];
    expect(porId(h, 'g-dueno')).not.toHaveProperty('balance');
    expect(porId(h, 'g-436')).toHaveProperty('balance');
  });
});
