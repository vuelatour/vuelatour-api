// INICIO OFICIAL (auditoría 16-oct-2026, API 0.0.85, invariante 86): la
// campana y su contador no muestran avisos anteriores al inicio (prod: 3,909
// no leídas de antes de septiembre).
jest.mock('./realtime.gateway', () => ({ RealtimeGateway: class {} }));
jest.mock('./push.service', () => ({ PushService: class {} }));

import { NotificationsService } from './notifications.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const CORTE = '2026-09-01T00:00:00-05:00';

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const svc = new NotificationsService(
    g.supabase,
    {} as never,
    {} as never,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, ...g };
}

describe('NotificationsService — inicio oficial', () => {
  it('list y unreadCount llevan created_at ≥ corte Cancún', async () => {
    const a = armar('2026-09-01');
    await a.svc.list('u1', { limit: 20, offset: 0, unreadOnly: true });
    await a.svc.unreadCount('u1');
    const [lista, conteo] = a.de('notificacion');
    expect(a.lleva(lista, 'gte', 'created_at', CORTE)).toBe(true);
    expect(a.lleva(conteo, 'gte', 'created_at', CORTE)).toBe(true);
    expect(a.lleva(conteo, 'eq', 'leida', false)).toBe(true);
  });

  it('inicio null ⇒ sin gte (como 0.0.84)', async () => {
    const a = armar(null);
    await a.svc.list('u1', { limit: 20, offset: 0, unreadOnly: false });
    await a.svc.unreadCount('u1');
    for (const c of a.de('notificacion')) {
      expect(c.ops.some((o) => o.m === 'gte')).toBe(false);
    }
  });

  it('sin ConfiguracionService (@Optional) ⇒ sin piso', async () => {
    const g = supabaseGrabador();
    const svc = new NotificationsService(g.supabase, {} as never, {} as never);
    await svc.unreadCount('u1');
    expect(g.de('notificacion')[0].ops.some((o) => o.m === 'gte')).toBe(false);
  });
});
