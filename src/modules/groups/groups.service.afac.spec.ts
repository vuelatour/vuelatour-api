// AFAC POR VUELO (16-oct-2026, invariante 90; revisión adversaria): los
// gastos por hijo del grupo (`gastosPorHijo`, que deben coincidir con el
// reporte por vuelo) sacan al PERMISO marcado «Pago de AFAC».
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
jest.mock('../../common/afac-real-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/afac-real-disponible.util',
  ),
  afacRealDisponible: jest.fn(() => Promise.resolve(true)),
}));

import { GroupsService } from './groups.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { FlightsService } from '../flights/flights.service';
import type { QuotesService } from '../quotes/quotes.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';

type Fila = Record<string, unknown>;

function armar(gastos: Fila[]) {
  const selects: unknown[] = [];
  const from = () => {
    const q: Record<string, unknown> = {};
    q.select = (cols: unknown) => {
      selects.push(cols);
      return q;
    };
    for (const m of ['in', 'limit', 'eq']) q[m] = () => q;
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: gastos, error: null }).then(res);
    return q;
  };
  const svc = new GroupsService(
    { service: { from } } as unknown as SupabaseService,
    {} as QuotesService,
    {} as FlightsService,
    {} as CalendarSyncService,
  );
  return {
    selects,
    gastosPorHijo: (ids: string[]) =>
      (
        svc as unknown as {
          gastosPorHijo: (
            ids: string[],
          ) => Promise<Map<string, { usd: number; n: number; sin_tc: number }>>;
        }
      ).gastosPorHijo(ids),
  };
}

const H = 'hijo-1';
const g = (categoria: string, monto: number, extra: Fila = {}): Fila => ({
  vuelo_id: H,
  categoria,
  monto,
  moneda: 'MXN',
  tc_gasto: 20,
  ...extra,
});

describe('GroupsService.gastosPorHijo — pago de AFAC marcado (invariante 90)', () => {
  it('con la migración lee `es_pago_afac`; el PERMISO marcado ni se cuenta ni se suma; sin marca, sí', async () => {
    const a = armar([
      g('OPERACIONES', 400),
      g('PERMISO', 1000, { es_pago_afac: true }),
    ]);
    const r = (await a.gastosPorHijo([H])).get(H);
    expect(String(a.selects[0])).toContain('es_pago_afac');
    expect(r).toEqual({ usd: 20, n: 1, sin_tc: 0 });
    const b = armar([
      g('OPERACIONES', 400),
      g('PERMISO', 1000, { es_pago_afac: false }),
    ]);
    expect((await b.gastosPorHijo([H])).get(H)).toEqual({
      usd: 70,
      n: 2,
      sin_tc: 0,
    });
  });
});
