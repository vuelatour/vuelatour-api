// INICIO OFICIAL (16-oct-2026, invariante 86): piso de `GET /grupos` sobre
// `vuelo_grupo.fecha_vuelo`.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pilots/pilots.service', () => ({ PilotsService: class {} }));
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));
jest.mock('../quotes/quotes.service', () => ({ QuotesService: class {} }));

import { GroupsService } from './groups.service';
import type { FlightsService } from '../flights/flights.service';
import type { QuotesService } from '../quotes/quotes.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

function armar(inicio: string | null | undefined) {
  const g = supabaseGrabador();
  const svc = new GroupsService(
    g.supabase,
    {} as QuotesService,
    {} as FlightsService,
    {} as CalendarSyncService,
    inicio === undefined
      ? undefined
      : (cfgInicio(inicio) as unknown as ConfiguracionService),
  );
  return { svc, ...g };
}

describe('GroupsService.list — inicio oficial', () => {
  it('sin rango: or (fecha nula o ≥ corte)', async () => {
    const { svc, de, lleva } = armar('2026-09-01');
    await svc.list({ limit: 50, offset: 0 });
    expect(
      lleva(
        de('vuelo_grupo')[0],
        'or',
        'fecha_vuelo.is.null,fecha_vuelo.gte.2026-09-01T00:00:00-05:00',
      ),
    ).toBe(true);
  });

  it('desde anterior ⇒ sube al inicio', async () => {
    const { svc, de, lleva } = armar('2026-09-01');
    await svc.list({
      desde: '2026-08-01',
      hasta: '2026-09-30',
      limit: 50,
      offset: 0,
    });
    expect(
      lleva(
        de('vuelo_grupo')[0],
        'gte',
        'fecha_vuelo',
        '2026-09-01T00:00:00-05:00',
      ),
    ).toBe(true);
  });

  it('sin ConfiguracionService (specs viejos) o inicio null ⇒ como 0.0.83', async () => {
    for (const inicio of [undefined, null]) {
      const { svc, de } = armar(inicio);
      await svc.list({ limit: 50, offset: 0 });
      const ops = de('vuelo_grupo')[0].ops.map((o) => o.m);
      expect(ops).not.toContain('or');
      expect(ops).not.toContain('gte');
    }
  });
});
