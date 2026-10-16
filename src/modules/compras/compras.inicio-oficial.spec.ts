// INICIO OFICIAL (auditoría 16-oct-2026, API 0.0.85, invariante 86): la
// LISTA de compras arranca en el inicio (prod: folios 1, 3 y 4 ABIERTAS de
// agosto salen); el detalle por id no lleva piso.
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));

import { ComprasService } from './compras.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const svc = new ComprasService(
    g.supabase,
    {} as never,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, ...g };
}

describe('ComprasService.list — inicio oficial', () => {
  it('con inicio ⇒ fecha ≥ inicio', async () => {
    const a = armar('2026-09-01');
    await a.svc.list({ limit: 50, offset: 0 });
    expect(a.lleva(a.de('compra')[0], 'gte', 'fecha', '2026-09-01')).toBe(true);
  });

  it('inicio null ⇒ sin piso (como 0.0.84)', async () => {
    const a = armar(null);
    await a.svc.list({ limit: 50, offset: 0 });
    expect(a.de('compra')[0].ops.some((o) => o.m === 'gte')).toBe(false);
  });

  it('el detalle por id no consulta el inicio', async () => {
    const cfg = cfgInicio('2026-09-01');
    const g = supabaseGrabador();
    const svc = new ComprasService(
      g.supabase,
      {} as never,
      cfg as unknown as ConfiguracionService,
    );
    await svc.getDetail('c1').catch(() => undefined);
    expect(cfg.inicioOficial).not.toHaveBeenCalled();
  });
});
