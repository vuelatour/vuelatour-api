// INICIO OFICIAL (16-oct-2026, invariante 86): balances (forma R) sin tocar
// la siembra de tacómetros; en la ficha del avión SOLO `finanzas` y la
// gráfica de combustible llevan piso (horas intactas).
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import { HttpException } from '@nestjs/common';
import { AircraftBalanceService } from './aircraft-balance.service';
import { AircraftService } from './aircraft.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

// CIERRE DE MES (16-oct-2026, invariante 89): este spec congela la conducta
// SIN la migración 20261016000004 (0.0.87 byte a byte); la conducta con la
// migración vive en los specs `*.cierre-mes.spec.ts`.
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

const INICIO = '2026-09-01';
const AV = 'a0000000-0000-4000-8000-000000000001';

function balance(inicio: string | null) {
  const g = supabaseGrabador();
  const cfg = cfgInicio(inicio);
  const svc = new AircraftBalanceService(
    g.supabase,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    cfg as unknown as ConfiguracionService,
  );
  const buildPayload = jest
    .fn()
    .mockResolvedValue({ pendientes: [], matricula: 'N4142R' });
  Object.assign(svc as unknown as Record<string, unknown>, {
    buildPayload,
    pendienteGasSinAvion: jest.fn().mockResolvedValue([]),
  });
  return { svc, cfg, buildPayload, ...g };
}

const errorDe = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return ((e as HttpException).getResponse() as { error: string }).error;
  }
  throw new Error('no lanzó');
};

describe('Balance por avión / general — inicio oficial', () => {
  it('libro de agosto ⇒ 400 PERIODO_ANTES_DEL_INICIO (avión y general)', async () => {
    const b = balance(INICIO);
    expect(await errorDe(b.svc.libro(AV, '2026-08-01', '2026-08-31'))).toBe(
      'PERIODO_ANTES_DEL_INICIO',
    );
    expect(await errorDe(b.svc.libroGeneral('2026-08-01', '2026-08-31'))).toBe(
      'PERIODO_ANTES_DEL_INICIO',
    );
  });

  it('el libro sube el periodo (consultas y nombre)', async () => {
    const b = balance(INICIO);
    const r = await b.svc
      .xlsx(AV, '2026-08-15', '2026-09-30')
      .catch(() => null);
    expect(b.buildPayload).toHaveBeenCalledWith(AV, INICIO, '2026-09-30');
    if (r) expect(r.desde).toBe(INICIO);
  });

  it('inicio null ⇒ el periodo pedido', async () => {
    const b = balance(null);
    await b.svc.xlsx(AV, '2026-08-15', '2026-09-30').catch(() => null);
    expect(b.buildPayload).toHaveBeenCalledWith(AV, '2026-08-15', '2026-09-30');
  });

  it('ultimaLlegadaAntesDe (siembra de tacómetros) lee ANTES del desde, SIN piso', async () => {
    const b = balance(INICIO);
    const priv = b.svc as unknown as {
      ultimaLlegadaAntesDe(a: string, d: string): Promise<number | null>;
    };
    await priv.ultimaLlegadaAntesDe(AV, INICIO);
    const esc = b.de('escala');
    expect(esc).toHaveLength(2);
    for (const c of esc) {
      expect(
        b.lleva(c, 'lt', 'vuelo.fecha_vuelo', '2026-09-01T00:00:00-05:00'),
      ).toBe(true);
      expect(c.ops.some((o) => o.m === 'gte')).toBe(false);
    }
    expect(b.cfg.inicioOficial).not.toHaveBeenCalled();
  });
});

function ficha(inicio: string | null) {
  const g = supabaseGrabador();
  const svc = new AircraftService(
    g.supabase,
    { findBlockingExpirations: jest.fn().mockResolvedValue([]) } as never,
    {} as never,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  Object.assign(svc as unknown as Record<string, unknown>, {
    findById: jest.fn().mockResolvedValue({ id: AV, matricula: 'N4142R' }),
    escalasDelAvion: jest.fn().mockResolvedValue([]),
  });
  return { svc, ...g };
}

describe('Ficha del avión — inicio oficial', () => {
  it('metrics.finanzas con piso y finanzas_desde; utilizacion idéntica', async () => {
    const a = ficha(INICIO);
    const r = (await a.svc.aircraftMetrics(AV)) as Record<string, unknown>;
    expect(
      a.lleva(
        a.de('cobro_vuelo')[0],
        'gte',
        'vuelo.fecha_vuelo',
        '2026-09-01T00:00:00-05:00',
      ),
    ).toBe(true);
    expect(a.lleva(a.de('gasto')[0], 'gte', 'fecha_gasto', INICIO)).toBe(true);
    expect(r.finanzas_desde).toBe(INICIO);

    const b = ficha(null);
    const r0 = (await b.svc.aircraftMetrics(AV)) as Record<string, unknown>;
    expect(r0.finanzas_desde).toBeNull();
    expect(b.de('gasto')[0].ops.some((o) => o.m === 'gte')).toBe(false);
    expect(r.utilizacion).toEqual(r0.utilizacion);
  });

  it('combustible mensual: sin meses anteriores al inicio', async () => {
    const a = ficha(INICIO);
    const r = await a.svc.combustibleMensual(AV, 12);
    expect(r.desde).toBe(INICIO);
    expect(a.lleva(a.de('gasto')[0], 'gte', 'fecha_gasto', INICIO)).toBe(true);
  });
});

// ===== Auditoría 16-oct-2026 (API 0.0.85) =====

/** Escala con tacos y su vuelo (shape de `escalasDelAvion`). */
const esc = (
  id: string,
  fecha: string,
  s: number,
  l: number | null,
  folio = 1,
) => ({
  id,
  origen_iata: 'CUN',
  destino_iata: 'CZM',
  taco_salida: s,
  taco_llegada: l,
  fecha_salida_plan: fecha,
  vuelo: { id: `v-${id}`, folio, fecha_vuelo: fecha, aeronave_id: AV },
});

function fichaCon(inicio: string | null, escalas: unknown[]) {
  const a = ficha(inicio);
  Object.assign(a.svc as unknown as Record<string, unknown>, {
    escalasDelAvion: jest.fn().mockResolvedValue(escalas),
    hoyCancun: () => '2026-10-16',
    etapasDeServicio: jest.fn().mockResolvedValue([]),
    avisoAutomaticoServicio: jest.fn().mockResolvedValue(null),
  });
  return a;
}

const ESCALAS = [
  esc('e-ago', '2026-08-20T15:00:00Z', 100, 102),
  esc('e-sep', '2026-09-10T15:00:00Z', 103, 105),
];

describe('Ficha del avión — horas del AÑO desde el inicio (0.0.85)', () => {
  it('horas_anio/vuelos_anio desde el inicio con anio_desde; horas_total intacto', async () => {
    const r = (await fichaCon(INICIO, ESCALAS).svc.aircraftMetrics(AV)) as {
      utilizacion: Record<string, number>;
      anio_desde: string | null;
    };
    expect(r.anio_desde).toBe(INICIO);
    expect(r.utilizacion.horas_anio).toBe(2);
    expect(r.utilizacion.vuelos_anio).toBe(1);
    expect(r.utilizacion.horas_total).toBe(4);
    expect(r.utilizacion.vuelos_total).toBe(2);

    const r0 = (await fichaCon(null, ESCALAS).svc.aircraftMetrics(AV)) as {
      utilizacion: Record<string, number>;
      anio_desde: string | null;
    };
    expect(r0.anio_desde).toBeNull();
    expect(r0.utilizacion.horas_anio).toBe(4);
    expect(r0.utilizacion.horas_total).toBe(4);
  });
});

describe('Tacómetros del avión — saldo inicial (0.0.85)', () => {
  it('oculta filas anteriores, horas_actuales del arreglo completo y saldo_inicial', async () => {
    const r = (await fichaCon(INICIO, ESCALAS).svc.tacometroHistorial(AV)) as {
      historial: Array<{ escala_id: string }>;
      horas_actuales: number;
      saldo_inicial: { fecha: string; taco: number | null } | null;
    };
    expect(r.historial.map((h) => h.escala_id)).toEqual(['e-sep']);
    expect(r.horas_actuales).toBe(105);
    expect(r.saldo_inicial).toEqual({ fecha: INICIO, taco: 102 });
  });

  it('borde Cancún: 1-sep 04:59Z es 31-ago (fuera); inicio null ⇒ todo y null', async () => {
    const borde = [esc('e-borde', '2026-09-01T04:59:00Z', 102, 103)];
    const r = (await fichaCon(INICIO, borde).svc.tacometroHistorial(AV)) as {
      historial: unknown[];
      saldo_inicial: unknown;
    };
    expect(r.historial).toHaveLength(0);
    expect(r.saldo_inicial).toEqual({ fecha: INICIO, taco: 103 });
    const r0 = (await fichaCon(null, ESCALAS).svc.tacometroHistorial(AV)) as {
      historial: unknown[];
      saldo_inicial: unknown;
    };
    expect(r0.historial).toHaveLength(2);
    expect(r0.saldo_inicial).toBeNull();
  });
});

describe('Bitácora PDF — desde con piso (0.0.85)', () => {
  function bit(inicio: string | null) {
    const g = supabaseGrabador();
    const generateBitacoraTacoPdf = jest
      .fn()
      .mockResolvedValue(Buffer.from('pdf'));
    const svc = new AircraftService(
      g.supabase,
      {} as never,
      { generateBitacoraTacoPdf } as never,
      cfgInicio(inicio) as unknown as ConfiguracionService,
    );
    Object.assign(svc as unknown as Record<string, unknown>, {
      findById: jest.fn().mockResolvedValue({ id: AV, matricula: 'N4142R' }),
      escalasDelAvion: jest.fn().mockResolvedValue([
        { ...esc('e-ago', '2026-08-20T15:00:00Z', 100, 102), orden: 1 },
        { ...esc('e-sep', '2026-09-10T15:00:00Z', 103, 105), orden: 1 },
      ]),
    });
    return { svc, generateBitacoraTacoPdf };
  }

  it('sin desde ⇒ el inicio; filas solo desde el inicio; devuelve el desde efectivo', async () => {
    const b = bit(INICIO);
    const r = await b.svc.bitacoraTacoPdf(AV);
    expect(r.desde).toBe(INICIO);
    const payload = (
      b.generateBitacoraTacoPdf.mock.calls as unknown[][]
    )[0][0] as {
      desde: string;
      tiras: Array<{ filas: Array<{ taco_inicial: number }> }>;
    };
    expect(payload.desde).toBe(INICIO);
    for (const t of payload.tiras) {
      expect(t.filas.map((f) => f.taco_inicial)).toEqual([103]);
    }
  });

  it('inicio null ⇒ todo el histórico (desde null)', async () => {
    const b = bit(null);
    const r = await b.svc.bitacoraTacoPdf(AV);
    expect(r.desde).toBeNull();
    const payload = (
      b.generateBitacoraTacoPdf.mock.calls as unknown[][]
    )[0][0] as {
      tiras: Array<{ filas: unknown[] }>;
    };
    expect(payload.tiras[0].filas).toHaveLength(2);
  });
});
