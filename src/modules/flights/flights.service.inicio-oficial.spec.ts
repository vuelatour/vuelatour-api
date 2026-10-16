// INICIO OFICIAL (16-oct-2026, invariante 86): piso del listado de vuelos
// (panel, Mis vuelos, EN_VUELO, mecánico, deltas) y de taco-live; el detalle
// por id no lo consulta.
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

import { FlightsService } from './flights.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';
import type { ListFlightsQuery } from './dto/flights.dto';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const PISO = 'fecha_vuelo.is.null,fecha_fin.gte.2026-09-01T00:00:00-05:00';

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const cfg = cfgInicio(inicio);
  const svc = new FlightsService(
    g.supabase,
    {} as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {} as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    cfg as unknown as ConfiguracionService,
    {} as PilotsService,
  );
  return { svc, cfg, ...g };
}

const q = (over: Partial<ListFlightsQuery> = {}): ListFlightsQuery => ({
  limit: 50,
  offset: 0,
  ...over,
});

describe('FlightsService — inicio oficial', () => {
  it('lista con inicio: agrega el or (fecha nula o fecha_fin ≥ corte), sin reescribir desde', async () => {
    const { svc, de, lleva } = armar('2026-09-01');
    await svc.list(q({ desde: '2026-08-01T10:00:00Z' }));
    const v = de('vuelo')[0];
    expect(lleva(v, 'or', PISO)).toBe(true);
    expect(lleva(v, 'gte', 'fecha_fin', '2026-08-01T10:00:00Z')).toBe(true);
  });

  it('lista con inicio null: NO agrega el or (como 0.0.83)', async () => {
    const { svc, de } = armar(null);
    await svc.list(q());
    expect(de('vuelo')[0].ops.some((o) => o.m === 'or')).toBe(false);
  });

  it('delta updated_since: conserva el or del delta y el del piso (AND)', async () => {
    const g = supabaseGrabador((tabla) =>
      tabla === 'escala'
        ? { data: [{ vuelo_id: 'v1' }], error: null }
        : undefined,
    );
    const svc = new FlightsService(
      g.supabase,
      {} as CalendarSyncService,
      {} as EmailService,
      {} as VisionService,
      {} as NotificationsService,
      {} as ExpirationsService,
      {} as AirportsService,
      cfgInicio('2026-09-01') as unknown as ConfiguracionService,
      {} as PilotsService,
    );
    await svc.list(q({ updated_since: '2026-10-15T00:00:00Z' }));
    const ors = g
      .de('vuelo')[0]
      .ops.filter((o) => o.m === 'or')
      .map((o) => o.args[0]);
    expect(ors).toEqual([
      'updated_at.gte.2026-10-15T00:00:00.000Z,id.in.(v1)',
      PISO,
    ]);
  });

  it('taco-live con un día anterior ⇒ vacío sin consultar', async () => {
    const { svc, consultas } = armar('2026-09-01');
    await expect(svc.tacoLive('2026-08-31')).resolves.toEqual({
      fecha: '2026-08-31',
      vuelos: [],
    });
    expect(consultas).toHaveLength(0);
  });

  it('taco-live sin fecha (hoy) o con un día ≥ inicio ⇒ consulta como siempre', async () => {
    const { svc, de, cfg } = armar('2026-09-01');
    await svc.tacoLive('2026-09-01');
    expect(de('vuelo')).toHaveLength(1);
    await svc.tacoLive();
    expect(de('vuelo')).toHaveLength(2);
    // Sin fecha ni siquiera pregunta por el inicio.
    expect(cfg.inicioOficial).toHaveBeenCalledTimes(1);
  });

  it('vueloAnterior / ultimoTacoDeVuelo (horas) no consultan el inicio', async () => {
    const { svc, cfg } = armar('2026-09-01');
    await svc.vueloAnterior('v1').catch(() => undefined);
    await svc.ultimoTacoDeVuelo('v1').catch(() => undefined);
    expect(cfg.inicioOficial).not.toHaveBeenCalled();
  });
});
