// INICIO OFICIAL (16-oct-2026, invariante 86): los 5 tableros (forma R) y
// el KPI «abiertos».
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../profit-sharing/profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));

import { HttpException } from '@nestjs/common';
import { DashboardsService } from './dashboards.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const svc = new DashboardsService(
    g.supabase,
    {
      compute: jest.fn().mockResolvedValue({ aviones: [] }),
    } as never,
    {} as never,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, ...g };
}

const AGOSTO = { desde: '2026-08-01', hasta: '2026-08-31' };

describe('DashboardsService — inicio oficial', () => {
  it.each(['overview', 'operativo', 'gastos', 'tarjetas', 'horasPiloto'])(
    '%s de agosto ⇒ 400 PERIODO_ANTES_DEL_INICIO',
    async (tablero) => {
      const { svc } = armar(INICIO);
      const fn = (
        svc as unknown as Record<string, (q: object) => Promise<unknown>>
      )[tablero].bind(svc);
      try {
        await fn(AGOSTO);
        throw new Error('no lanzó');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect(
          ((e as HttpException).getResponse() as { error: string }).error,
        ).toBe('PERIODO_ANTES_DEL_INICIO');
      }
    },
  );

  it('tarjetas que cruza el inicio ⇒ periodo subido en consultas y respuesta', async () => {
    const { svc, de, lleva } = armar(INICIO);
    const r = (await svc.tarjetas({
      desde: '2026-08-20',
      hasta: '2026-09-30',
    })) as { periodo: { desde: string } };
    expect(r.periodo.desde).toBe(INICIO);
    expect(lleva(de('gasto')[0], 'gte', 'fecha_gasto', INICIO)).toBe(true);
  });

  it('KPI «abiertos»: or (fecha nula o ≥ corte); null ⇒ sin or', async () => {
    const a = armar(INICIO);
    const priv = (s: DashboardsService) =>
      s as unknown as { fetchEstadosAbiertos(): Promise<string[]> };
    await priv(a.svc).fetchEstadosAbiertos();
    expect(
      a.lleva(
        a.de('vuelo')[0],
        'or',
        'fecha_vuelo.is.null,fecha_vuelo.gte.2026-09-01T00:00:00-05:00',
      ),
    ).toBe(true);
    const b = armar(null);
    await priv(b.svc).fetchEstadosAbiertos();
    expect(b.de('vuelo')[0].ops.some((o) => o.m === 'or')).toBe(false);
  });
});
