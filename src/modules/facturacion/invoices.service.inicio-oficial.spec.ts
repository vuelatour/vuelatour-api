// INICIO OFICIAL (16-oct-2026, invariante 86): pendientes de factura,
// recibidas (conservan las sin fecha) y el zip de cierre (forma R).
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../profit-sharing/profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));
jest.mock('./facturacion.client', () => ({ FacturacionClient: class {} }));
jest.mock('../flights/factura-cliente.service', () => ({
  FacturaClienteService: class {},
}));

import { HttpException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const repartoXlsx = jest.fn().mockResolvedValue({ buffer: Buffer.from('x') });
  const svc = new InvoicesService(
    g.supabase,
    {} as never,
    { generateZip: jest.fn() } as never,
    { repartoXlsx } as never,
    undefined,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, repartoXlsx, ...g };
}

describe('InvoicesService — inicio oficial', () => {
  it('pendientes: sin desde ⇒ gte corte; desde anterior sube; null ⇒ sin gte', async () => {
    const a = armar(INICIO);
    await a.svc.listPendientes({ limit: 50, offset: 0 });
    expect(
      a.lleva(
        a.de('vuelo')[0],
        'gte',
        'fecha_vuelo',
        '2026-09-01T00:00:00-05:00',
      ),
    ).toBe(true);
    const b = armar(INICIO);
    await b.svc.listPendientes({ desde: '2026-08-01', limit: 50, offset: 0 });
    expect(
      b.lleva(
        b.de('vuelo')[0],
        'gte',
        'fecha_vuelo',
        '2026-09-01T00:00:00-05:00',
      ),
    ).toBe(true);
    const c = armar(null);
    await c.svc.listPendientes({ limit: 50, offset: 0 });
    expect(c.de('vuelo')[0].ops.some((o) => o.m === 'gte')).toBe(false);
  });

  it('recibidas: conserva las de fecha_emision null', async () => {
    const { svc, de, lleva } = armar(INICIO);
    await svc.listRecibidas({ limit: 50, offset: 0 });
    expect(
      lleva(
        de('factura_recibida').find((c) => c.ops.some((o) => o.m === 'range'))!,
        'or',
        'fecha_emision.is.null,fecha_emision.gte.2026-09-01T00:00:00-05:00',
      ),
    ).toBe(true);
  });

  it('cierre de agosto ⇒ 400; que cruza ⇒ periodo subido al reparto', async () => {
    const a = armar(INICIO);
    try {
      await a.svc.cierreZip('2026-08-01', '2026-08-31');
      throw new Error('no lanzó');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect(
        ((e as HttpException).getResponse() as { error: string }).error,
      ).toBe('PERIODO_ANTES_DEL_INICIO');
    }
    await a.svc.cierreZip('2026-08-20', '2026-09-30').catch(() => undefined);
    expect(a.repartoXlsx).toHaveBeenCalledWith({
      desde: INICIO,
      hasta: '2026-09-30',
    });
  });
});
