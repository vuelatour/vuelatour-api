// INICIO OFICIAL (16-oct-2026, invariante 86, forma R): reparto, sus
// PDF/Excel, el libro Dinero y el pre-cierre.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { HttpException } from '@nestjs/common';
import { ProfitSharingService } from './profit-sharing.service';
import { DineroReportService } from './dinero-report.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import { Rol } from '../../common/types/auth.types';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const cobrosSinBanco = jest
    .fn()
    .mockResolvedValue({ data: [], total: 0, por_moneda: [] });
  const svc = new ProfitSharingService(
    g.supabase,
    {} as never,
    {} as never,
    { cobrosSinBanco } as unknown as ConciliacionService,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  svc.ahora = () => new Date('2026-10-16T17:00:00Z');
  return { svc, cobrosSinBanco, ...g };
}

const errorDe = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return (e as HttpException).getResponse() as {
      error: string;
      details?: unknown;
    };
  }
  throw new Error('no lanzó');
};

/** Firma de TODAS las consultas (tabla + ops) para comparar byte a byte. */
const firma = (g: ReturnType<typeof armar>) =>
  JSON.stringify(g.consultas.map((c) => [c.tabla, c.ops]));

describe('ProfitSharingService — inicio oficial', () => {
  it('reparto: desde 2026-08-15 sube a 2026-09-01', async () => {
    const g = armar(INICIO);
    const r = await g.svc.compute({ desde: '2026-08-15', hasta: '2026-09-30' });
    expect(r.periodo).toEqual({ desde: INICIO, hasta: '2026-09-30' });
  });

  it('reparto de agosto ⇒ 400 PERIODO_ANTES_DEL_INICIO con details.inicio', async () => {
    const g = armar(INICIO);
    const r = await errorDe(
      g.svc.compute({ desde: '2026-08-01', hasta: '2026-08-31' }),
    );
    expect(r.error).toBe('PERIODO_ANTES_DEL_INICIO');
    expect(r.details).toEqual({ inicio: INICIO });
  });

  it('reparto de septiembre ⇒ las MISMAS consultas que con inicio null', async () => {
    const a = armar(INICIO);
    const b = armar(null);
    await a.svc.compute({ desde: '2026-09-01', hasta: '2026-09-30' });
    await b.svc.compute({ desde: '2026-09-01', hasta: '2026-09-30' });
    expect(firma(a)).toBe(firma(b));
  });

  it('utilidades por mes de los socios (cuenta corriente): SIN piso', async () => {
    const g = armar(INICIO);
    const priv = g.svc as unknown as {
      utilidadMesSocios(mes: string, enCurso: boolean): Promise<unknown>;
    };
    await expect(
      priv.utilidadMesSocios('2026-08', false),
    ).resolves.toBeDefined();
  });

  it('pre-cierre: agosto ⇒ 400; que cruza ⇒ desde subido (cobros-sin-banco incluido)', async () => {
    const g = armar(INICIO);
    const r = await errorDe(
      g.svc.preCierre({ desde: '2026-08-01', hasta: '2026-08-31' }, Rol.ADMIN),
    );
    expect(r.error).toBe('PERIODO_ANTES_DEL_INICIO');
    await g.svc
      .preCierre({ desde: '2026-08-15', hasta: '2026-09-30' }, Rol.ADMIN)
      .catch(() => undefined);
    const vuelos = g
      .de('vuelo')
      .filter((c) =>
        c.ops.some((o) => o.m === 'gte' && o.args[0] === 'fecha_vuelo'),
      );
    expect(vuelos.length).toBeGreaterThan(0);
    for (const c of vuelos) {
      expect(
        g.lleva(c, 'gte', 'fecha_vuelo', '2026-09-01T00:00:00-05:00'),
      ).toBe(true);
    }
  });

  it('pre-cierre de septiembre ⇒ las MISMAS consultas que con inicio null', async () => {
    const a = armar(INICIO);
    const b = armar(null);
    await a.svc
      .preCierre({ desde: '2026-09-01', hasta: '2026-09-30' }, Rol.ADMIN)
      .catch(() => undefined);
    await b.svc
      .preCierre({ desde: '2026-09-01', hasta: '2026-09-30' }, Rol.ADMIN)
      .catch(() => undefined);
    expect(firma(a)).toBe(firma(b));
    expect(a.cobrosSinBanco.mock.calls).toEqual(b.cobrosSinBanco.mock.calls);
  });

  it('libro Dinero: agosto ⇒ 400; que cruza ⇒ periodo subido en el archivo', async () => {
    const g = supabaseGrabador();
    const generateDineroXlsx = jest.fn().mockResolvedValue(Buffer.from('x'));
    const dinero = new DineroReportService(
      g.supabase,
      { generateDineroXlsx } as unknown as PyservicesService,
      cfgInicio(INICIO) as unknown as ConfiguracionService,
    );
    const r = await errorDe(dinero.xlsx('2026-08-01', '2026-08-31'));
    expect(r.error).toBe('PERIODO_ANTES_DEL_INICIO');
    const ok = await dinero.xlsx('2026-08-20', '2026-09-30');
    expect(ok.desde).toBe(INICIO);
  });
});
