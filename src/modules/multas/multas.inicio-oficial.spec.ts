// INICIO OFICIAL (auditoría 16-oct-2026, API 0.0.85, invariante 86): la
// lista de multas no muestra las anteriores al inicio (latente: hoy 0).
import { MultasService } from './multas.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const armar = (inicio: string | null) => {
  const g = supabaseGrabador();
  const svc = new MultasService(
    g.supabase,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, ...g };
};

describe('MultasService.list — inicio oficial', () => {
  it('fecha ≥ inicio; null ⇒ sin piso', async () => {
    const a = armar('2026-09-01');
    await a.svc.list({ limit: 50, offset: 0 });
    expect(a.lleva(a.de('multa')[0], 'gte', 'fecha', '2026-09-01')).toBe(true);
    const b = armar(null);
    await b.svc.list({ limit: 50, offset: 0 });
    expect(b.de('multa')[0].ops.some((o) => o.m === 'gte')).toBe(false);
  });
});
