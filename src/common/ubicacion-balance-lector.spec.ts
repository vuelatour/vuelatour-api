// AFAC POR VUELO (16-oct-2026, invariante 90): este spec congela la conducta
// SIN la migración 20261016000005 (0.0.88); la conducta con ella vive en los
// specs `*.afac*.spec.ts` (o en los casos que la encienden abajo).
jest.mock('./afac-real-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>('./afac-real-disponible.util'),
  afacRealDisponible: jest.fn(() => Promise.resolve(false)),
}));
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  GASTO_UBICACION_COLS,
  gastoUbicacionCols,
  LOTE_UBICACION_BALANCE,
  leerUbicacionBalance,
} from './ubicacion-balance-lector';
import {
  ubicacionBalanceDeGasto,
  type GastoParaUbicacion,
} from './ubicacion-balance-gasto.util';

// CIERRE DE MES (16-oct-2026, invariante 89): este spec congela la conducta
// SIN la migración 20261016000004 (0.0.87 byte a byte); la conducta con la
// migración vive en los specs `*.cierre-mes.spec.ts`.
jest.mock('./cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    './cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

/**
 * LECTOR COMPARTIDO de la ubicación en el balance (invariantes 72 y 82,
 * 15-oct-2026): la lectura en lote que antes vivía en
 * `ConciliacionService.anotarUbicacionBalance`, ahora también de Caja chica.
 * PARIDAD: el mismo mundo que `conciliacion.service.ubicacion-balance.spec`
 * (OPERACIONES #430, «gestoria cramex sep» 50/50, hueco #255) da EXACTAMENTE
 * los mismos `balance`; lectura principal caída ⇒ null; lotes de ≤ 200.
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

/** Parte una lista PostgREST por comas de nivel 0. */
function partirNivel0(s: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of s) {
    if (ch === '(') nivel += 1;
    if (ch === ')') nivel -= 1;
    if (ch === ',' && nivel === 0) {
      out.push(actual.trim());
      actual = '';
      continue;
    }
    actual += ch;
  }
  if (actual.trim()) out.push(actual.trim());
  return out;
}

interface Consulta {
  tabla: string;
  sel: string;
  ins: Array<{ col: string; vals: unknown[] }>;
  is: string[];
}

/** Mini-PostgREST: select con embeds `alias:col_id(…)`, `in`, `is`. */
function fakeSb(db: Tablas, falla: string[] = []) {
  const log: Consulta[] = [];
  const embeber = (fila: Row, sel: string): Row => {
    const out: Row = {};
    for (const campo of partirNivel0(sel)) {
      const m = /^(\w+):(\w+)_id\((.*)\)$/s.exec(campo);
      if (!m) {
        out[campo] = fila[campo];
        continue;
      }
      const [, alias, tabla, interior] = m;
      const rel = (db[tabla] ?? []).find((r) => r.id === fila[`${tabla}_id`]);
      out[alias] = rel ? embeber(rel, interior) : null;
    }
    return out;
  };
  const sb = {
    from(tabla: string) {
      const q: Consulta = { tabla, sel: '', ins: [], is: [] };
      log.push(q);
      const filtros: Array<(r: Row) => boolean> = [];
      const ejecutar = () => {
        if (falla.includes(tabla)) {
          return { data: null, error: { message: `caída ${tabla}` } };
        }
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        return { data: filas.map((r) => embeber(r, q.sel)), error: null };
      };
      const api: Record<string, unknown> = {
        select(s: string) {
          q.sel = s;
          return api;
        },
        in(col: string, vals: unknown[]) {
          q.ins.push({ col, vals });
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        is(col: string, val: unknown) {
          q.is.push(col);
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar()).then(res, rej),
      };
      return api;
    },
  };
  return { sb: sb as unknown as SupabaseClient, log };
}

const N41 = 'av-n41';
const VGV = 'av-vgv';
const PEV = 'av-pev';

const gastoFila = (id: string, extra: Row = {}): Row => ({
  id,
  monto: 100,
  fecha_gasto: '2026-09-30',
  categoria: 'OPERACIONES',
  vuelo_id: 'v-430',
  escala_id: null,
  aeronave_id: N41,
  inventario_movimiento_id: null,
  ...extra,
});

function mundo(): Tablas {
  return {
    aeronave: [
      { id: VGV, matricula: 'XA-VGV' },
      { id: N41, matricula: 'N4142R' },
      { id: PEV, matricula: 'XB-PEV' },
    ],
    vuelo: [
      {
        id: 'v-430',
        aeronave_id: N41,
        fecha_vuelo: '2026-10-10T21:30:00+00:00',
        es_externo: false,
      },
      {
        id: 'v-255',
        aeronave_id: VGV,
        fecha_vuelo: '2026-09-12T15:00:00+00:00',
        es_externo: false,
      },
    ],
    escala: [
      { id: 'e-255', vuelo_id: 'v-255', aeronave_id: VGV, cancelada_at: null },
      {
        id: 'e-255b',
        vuelo_id: 'v-255',
        aeronave_id: N41,
        cancelada_at: '2026-09-11T10:00:00Z',
      },
    ],
    gasto_reparto: [
      { gasto_id: 'g-cramex', aeronave_id: PEV, monto: 8120 },
      { gasto_id: 'g-cramex', aeronave_id: VGV, monto: 8120 },
    ],
    gasto: [
      gastoFila('g-430', { monto: 1899.09 }),
      gastoFila('g-otro', { categoria: 'OTRO' }),
      gastoFila('g-cramex', {
        monto: 16240,
        categoria: 'INDIRECTO',
        vuelo_id: null,
        aeronave_id: null,
        fecha_gasto: '2026-10-07',
      }),
      gastoFila('g-255', {
        monto: 283.15,
        vuelo_id: 'v-255',
        fecha_gasto: '2026-09-12',
      }),
      gastoFila('g-dueno', { categoria: 'PERSONAL_DUENO' }),
    ],
  };
}

const IDS = ['g-430', 'g-otro', 'g-cramex', 'g-255', 'g-dueno'];

function logger() {
  return { warn: jest.fn<void, [string]>() };
}

describe('gastoUbicacionCols — sondas (invariantes 89 y 90)', () => {
  it('sin migraciones ⇒ GASTO_UBICACION_COLS; con la del AFAC la lectura trae `es_pago_afac` (regla R2b), con o sin la del cierre', () => {
    expect(gastoUbicacionCols(false)).toBe(GASTO_UBICACION_COLS);
    expect(gastoUbicacionCols(false, false)).toBe(GASTO_UBICACION_COLS);
    for (const cierre of [false, true]) {
      const cols = gastoUbicacionCols(cierre, true);
      expect(cols).toContain('inventario_movimiento_id, es_pago_afac,');
      expect(cols.replace(' es_pago_afac,', '')).toBe(
        gastoUbicacionCols(cierre),
      );
    }
  });
});

describe('leerUbicacionBalance — lector compartido (invariantes 72 y 82)', () => {
  it('PARIDAD con Conciliación: los mismos `balance` del spec de la bandeja', async () => {
    const { sb } = fakeSb(mundo());
    const log = logger();
    const r = await leerUbicacionBalance(sb, IDS, log);
    expect(r).not.toBeNull();
    expect(r!.get('g-430')).toEqual({
      periodo: { desde: '2026-10-01', hasta: '2026-10-31' },
      eje: 'vuelo',
      aviones: [{ id: N41, matricula: 'N4142R' }],
      general: true,
      hoja_avion: 'reporte_horas',
      hoja_general: 'reporte_horas',
    });
    expect(r!.get('g-otro')).toEqual({
      periodo: { desde: '2026-09-01', hasta: '2026-09-30' },
      eje: 'gasto',
      aviones: [],
      general: true,
      hoja_avion: null,
      hoja_general: 'otros_gastos',
    });
    // Aviones ordenados por matrícula: XA-VGV antes que XB-PEV.
    expect(r!.get('g-cramex')).toEqual({
      periodo: { desde: '2026-10-01', hasta: '2026-10-31' },
      eje: 'gasto',
      aviones: [
        { id: VGV, matricula: 'XA-VGV' },
        { id: PEV, matricula: 'XB-PEV' },
      ],
      general: false,
      hoja_avion: 'gastos_indirectos',
      hoja_general: null,
    });
    // #255 (sin tramo VIVO de N4142R) y el gasto personal: null, con llave.
    expect(r!.has('g-255')).toBe(true);
    expect(r!.get('g-255')).toBeNull();
    expect(r!.get('g-dueno')).toBeNull();
    // Llaves en el orden del contrato (`balance` del panel).
    expect(Object.keys(r!.get('g-430')!)).toEqual([
      'periodo',
      'eje',
      'aviones',
      'general',
      'hoja_avion',
      'hoja_general',
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('INICIO OFICIAL (invariante 86): libro de un mes que termina antes del inicio ⇒ null; el resto igual', async () => {
    const sinPiso = await leerUbicacionBalance(
      fakeSb(mundo()).sb,
      IDS,
      logger(),
    );
    const conPiso = await leerUbicacionBalance(
      fakeSb(mundo()).sb,
      IDS,
      logger(),
      'Conciliación',
      '2026-10-01',
    );
    // g-otro vive en septiembre (termina el 30-sep < 1-oct): sin enlace.
    expect(sinPiso!.get('g-otro')).not.toBeNull();
    expect(conPiso!.has('g-otro')).toBe(true);
    expect(conPiso!.get('g-otro')).toBeNull();
    // Octubre no cambia.
    expect(conPiso!.get('g-430')).toEqual(sinPiso!.get('g-430'));
    expect(conPiso!.get('g-cramex')).toEqual(sinPiso!.get('g-cramex'));
    // Inicio = primer día del mes del libro ⇒ el libro sí se abre.
    const mismoMes = await leerUbicacionBalance(
      fakeSb(mundo()).sb,
      IDS,
      logger(),
      'Conciliación',
      '2026-09-01',
    );
    expect(mismoMes!.get('g-otro')).toEqual(sinPiso!.get('g-otro'));
  });

  it('cada ubicación sale de la REGLA pura (`ubicacionBalanceDeGasto`), sin reglas propias', async () => {
    const db = mundo();
    const { sb } = fakeSb(db);
    const r = await leerUbicacionBalance(sb, ['g-430', 'g-otro'], logger());
    for (const id of ['g-430', 'g-otro']) {
      const g = db.gasto.find((x) => x.id === id)!;
      const vuelo = db.vuelo.find((v) => v.id === g.vuelo_id) ?? null;
      const pura = ubicacionBalanceDeGasto({
        ...(g as unknown as GastoParaUbicacion),
        escala: null,
        vuelo,
      });
      expect(r!.get(id)).toMatchObject({
        periodo: pura!.periodo,
        eje: pura!.eje,
        general: pura!.general,
        hoja_avion: pura!.hoja_avion,
        hoja_general: pura!.hoja_general,
      });
      expect(r!.get(id)!.aviones.map((a) => a.id)).toEqual(pura!.aviones);
    }
  });

  it('lecturas: gasto con GASTO_UBICACION_COLS, escalas VIVAS solo del vuelo que lo necesita y UNA de aeronaves', async () => {
    const { sb, log } = fakeSb(mundo());
    await leerUbicacionBalance(sb, IDS, logger());
    const gasto = log.filter((q) => q.tabla === 'gasto');
    expect(gasto).toHaveLength(1);
    expect(gasto[0].sel).toBe(GASTO_UBICACION_COLS);
    expect(log.filter((q) => q.tabla === 'gasto_reparto')).toHaveLength(1);
    const esc = log.filter((q) => q.tabla === 'escala');
    expect(esc).toHaveLength(1);
    expect(esc[0].ins).toEqual([{ col: 'vuelo_id', vals: ['v-255'] }]);
    expect(esc[0].is).toEqual(['cancelada_at']);
    expect(log.filter((q) => q.tabla === 'aeronave')).toHaveLength(1);
  });

  it('#255 con un tramo VIVO de N4142R ⇒ vuelve a tener enlace', async () => {
    const db = mundo();
    db.escala.push({
      id: 'e-255c',
      vuelo_id: 'v-255',
      aeronave_id: N41,
      cancelada_at: null,
    });
    const r = await leerUbicacionBalance(fakeSb(db).sb, ['g-255'], logger());
    expect(r!.get('g-255')).toMatchObject({
      aviones: [{ id: N41, matricula: 'N4142R' }],
    });
  });

  it.each(['gasto', 'gasto_reparto'])(
    'falla la lectura PRINCIPAL de %s ⇒ null y un warn con la etiqueta (nunca lanza)',
    async (tabla) => {
      const log = logger();
      const r = await leerUbicacionBalance(
        fakeSb(mundo(), [tabla]).sb,
        IDS,
        log,
        'Caja chica',
      );
      expect(r).toBeNull();
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0][0]).toBe(
        `Caja chica sin enlaces al balance (lectura de gastos o repartos): caída ${tabla}`,
      );
    },
  );

  it('la etiqueta por omisión es la de Conciliación (mismo warn de siempre)', async () => {
    const log = logger();
    await leerUbicacionBalance(fakeSb(mundo(), ['gasto']).sb, IDS, log);
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^Conciliación sin enlaces al balance \(lectura de gastos o repartos\): /,
    );
  });

  it('falla escala ⇒ no se verifica el tramo (#255 conserva su avión) y warn', async () => {
    const log = logger();
    const r = await leerUbicacionBalance(
      fakeSb(mundo(), ['escala']).sb,
      IDS,
      log,
    );
    expect(r!.get('g-255')).toMatchObject({
      aviones: [{ id: N41, matricula: 'N4142R' }],
    });
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^Enlaces al balance sin verificar tramos vivos: /,
    );
  });

  it('falla aeronave ⇒ matrícula null (cosmética) y el balance sigue', async () => {
    const log = logger();
    const r = await leerUbicacionBalance(
      fakeSb(mundo(), ['aeronave']).sb,
      ['g-430'],
      log,
    );
    expect(r!.get('g-430')).toMatchObject({
      aviones: [{ id: N41, matricula: null }],
      hoja_avion: 'reporte_horas',
    });
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^Enlaces al balance sin matrículas: /,
    );
  });

  it('gasto que no volvió en la lectura ⇒ fuera del mapa (el llamador no pone la llave)', async () => {
    const r = await leerUbicacionBalance(
      fakeSb(mundo()).sb,
      ['g-430', 'g-borrado'],
      logger(),
    );
    expect([...r!.keys()]).toEqual(['g-430']);
  });

  it('sin ids ⇒ mapa vacío y CERO consultas', async () => {
    const { sb, log } = fakeSb(mundo());
    const r = await leerUbicacionBalance(sb, [], logger());
    expect(r).toEqual(new Map());
    expect(log).toHaveLength(0);
  });

  it(`lotes de ≤ ${LOTE_UBICACION_BALANCE} ids SIN repetidos (gasto y repartos)`, async () => {
    const db = mundo();
    const muchos = Array.from({ length: 450 }, (_, i) => `g-n${i}`);
    for (const id of muchos)
      db.gasto.push(gastoFila(id, { categoria: 'OTRO' }));
    const { sb, log } = fakeSb(db);
    const r = await leerUbicacionBalance(
      sb,
      [...muchos, ...muchos, ''],
      logger(),
    );
    expect(r!.size).toBe(450);
    for (const tabla of ['gasto', 'gasto_reparto']) {
      const tamanos = log
        .filter((q) => q.tabla === tabla)
        .map((q) => q.ins[0].vals.length);
      expect(tamanos).toEqual([200, 200, 50]);
    }
  });
});
