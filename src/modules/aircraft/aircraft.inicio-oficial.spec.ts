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
