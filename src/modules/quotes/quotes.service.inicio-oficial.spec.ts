// INICIO OFICIAL (16-oct-2026, invariante 86): lista de cotizaciones y
// flechas (`aplicarFiltrosLista`, fuente única).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { QuotesService } from './quotes.service';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { FlightsService } from '../flights/flights.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { ListQuotesQuery } from './dto/list-quotes.query';
import {
  cfgInicio,
  supabaseGrabador,
  type Responder,
} from '../../common/inicio-oficial.fixture-spec';

function armar(inicio: string | null, responder?: Responder) {
  const g = supabaseGrabador(responder);
  const svc = new QuotesService(
    {} as AircraftService,
    {} as AirportsService,
    {} as RoutesService,
    g.supabase,
    {} as CalendarSyncService,
    {} as EmailService,
    {} as NotificationsService,
    {} as FlightsService,
    undefined,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, ...g };
}

const q = (over: Partial<ListQuotesQuery> = {}): ListQuotesQuery => ({
  limit: 50,
  offset: 0,
  ...over,
});

describe('QuotesService — inicio oficial', () => {
  it('sin rango: la cotización SIN fecha se queda (or is.null / gte corte)', async () => {
    const { svc, de, lleva } = armar('2026-09-01');
    await svc.list(q());
    expect(
      lleva(
        de('vuelo')[0],
        'or',
        'fecha_vuelo.is.null,fecha_vuelo.gte.2026-09-01T00:00:00-05:00',
      ),
    ).toBe(true);
  });

  it('con desde anterior: sube al inicio (día Cancún)', async () => {
    const { svc, de, lleva } = armar('2026-09-01');
    await svc.list(q({ desde: '2026-08-15', hasta: '2026-09-30' }));
    const v = de('vuelo')[0];
    expect(lleva(v, 'gte', 'fecha_vuelo', '2026-09-01T00:00:00-05:00')).toBe(
      true,
    );
    expect(v.ops.some((o) => o.m === 'or')).toBe(false);
  });

  it('con desde ≥ inicio: intacto', async () => {
    const { svc, de, lleva } = armar('2026-09-01');
    await svc.list(q({ desde: '2026-09-10' }));
    expect(
      lleva(de('vuelo')[0], 'gte', 'fecha_vuelo', '2026-09-10T00:00:00-05:00'),
    ).toBe(true);
  });

  it('inicio null: ni or ni gte (como 0.0.83)', async () => {
    const { svc, de } = armar(null);
    await svc.list(q());
    const ops = de('vuelo')[0].ops.map((o) => o.m);
    expect(ops).not.toContain('or');
    expect(ops).not.toContain('gte');
  });

  it('flechas (vecinos): las 4 consultas llevan el mismo piso', async () => {
    const { svc, de, lleva } = armar('2026-09-01', (tabla, ops) =>
      tabla === 'vuelo' && ops.some((o) => o.m === 'maybeSingle')
        ? {
            data: { id: 'v1', folio: 10, fecha_vuelo: '2026-09-20T15:00:00Z' },
            error: null,
          }
        : undefined,
    );
    await svc.vecinos('v1', {});
    const vecinos = de('vuelo').slice(1);
    expect(vecinos).toHaveLength(4);
    for (const c of vecinos) {
      expect(
        lleva(
          c,
          'or',
          'fecha_vuelo.is.null,fecha_vuelo.gte.2026-09-01T00:00:00-05:00',
        ),
      ).toBe(true);
    }
  });
});
