// Mismos stubs que flights.service.metodo-cobro.spec.ts: notifications
// arrastra el gateway y `jose` (ESM), calendar-sync googleapis, vision el SDK
// de IA y pilots calendar/users (push, firebase).
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
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';

/**
 * AVIÓN UTILIZADO en el snapshot del vuelo (24-sep-2026, cotización #338).
 * El avión que VOLÓ es el de los TRAMOS (de ahí cuelgan tacos, horas de
 * motor y gastos), no la cabecera a secas: #338 quedó con la cabecera en
 * XA-VGV (una revisión de la cotización la movió) y sus dos tramos volados
 * en N4142R, y «aeronave utilizada» decía XA-VGV. Espejo del helper de
 * quotes.service (detalle de la cotización).
 */
type Row = Record<string, unknown>;

const N4142R = 'aaaaaaaa-0000-4000-8000-0000000n4142';
const XAVGV = 'aaaaaaaa-0000-4000-8000-000000000vgv';
const FICHAS: Row[] = [
  { id: N4142R, matricula: 'N4142R', modelo: 'PIPER SENECA V' },
  { id: XAVGV, matricula: 'XA-VGV', modelo: 'Cessna 206' },
];

function servicio(): FlightsService {
  const service = {
    from(tabla: string) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) {
        q[m] = () => q;
      }
      const data = tabla === 'aeronave' ? FICHAS : [];
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(res);
      q.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return q;
    },
  };
  return new FlightsService(
    { service } as unknown as SupabaseService,
    {} as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {} as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
}

type Participacion = {
  aeronave_cotizada: { id: string } | null;
  aeronave_utilizada: { id: string; matricula: string | null } | null;
  aeronave_cotizada_vs_utilizada_difiere: boolean;
};

const participacion = (vuelo: Row, escalas: Row[]): Promise<Participacion> =>
  (
    servicio() as unknown as {
      participacionAvionesDe: (v: Row, e: Row[]) => Promise<Participacion>;
    }
  ).participacionAvionesDe(vuelo, escalas);

const tramo = (orden: number, aeronave: string | null, extra: Row = {}) => ({
  id: `e-${orden}`,
  orden,
  aeronave_id: aeronave,
  es_ferry: orden === 1,
  solo_operativa: false,
  cancelada_at: null,
  ...extra,
});

describe('FlightsService.snapshot — aeronave_utilizada sale de los TRAMOS (#338)', () => {
  it('#338 antes de la corrección: cabecera XA-VGV, tramos volados en N4142R ⇒ utilizada N4142R', async () => {
    const p = await participacion(
      {
        aeronave_id: XAVGV,
        es_externo: false,
        monto_total_usd: 0,
        calculo_snapshot: {
          aeronave: { id: XAVGV, matricula: 'XA-VGV', modelo: 'Cessna 206' },
        },
      },
      [tramo(1, N4142R), tramo(2, N4142R)],
    );
    expect(p.aeronave_utilizada).toMatchObject({
      id: N4142R,
      matricula: 'N4142R',
    });
    expect(p.aeronave_cotizada).toMatchObject({ id: XAVGV });
    expect(p.aeronave_cotizada_vs_utilizada_difiere).toBe(true);
  });

  it('tramos que heredan (null) ⇒ la cabecera; mismo avión cotizado ⇒ no difiere', async () => {
    const p = await participacion(
      {
        aeronave_id: N4142R,
        es_externo: false,
        monto_total_usd: 0,
        calculo_snapshot: {
          aeronave: {
            id: N4142R,
            matricula: 'N4142R',
            modelo: 'PIPER SENECA V',
          },
        },
      },
      [tramo(1, null), tramo(2, null)],
    );
    expect(p.aeronave_utilizada).toMatchObject({ id: N4142R });
    expect(p.aeronave_cotizada_vs_utilizada_difiere).toBe(false);
  });

  it('el primer tramo CANCELADO no cuenta: manda el primer tramo VIVO', async () => {
    const p = await participacion(
      { aeronave_id: XAVGV, es_externo: false, monto_total_usd: 0 },
      [
        tramo(1, XAVGV, { cancelada_at: '2026-09-20T00:00:00Z' }),
        tramo(2, N4142R),
      ],
    );
    expect(p.aeronave_utilizada).toMatchObject({ id: N4142R });
    // Sin snapshot (reserva sin cotizar) no hay con qué comparar.
    expect(p.aeronave_cotizada_vs_utilizada_difiere).toBe(false);
  });

  it('externo: sin avión utilizado propio y nunca «difiere»', async () => {
    const p = await participacion(
      {
        aeronave_id: null,
        es_externo: true,
        monto_total_usd: 0,
        calculo_snapshot: { aeronave: { id: XAVGV } },
      },
      [tramo(1, null)],
    );
    expect(p.aeronave_utilizada).toBeNull();
    expect(p.aeronave_cotizada_vs_utilizada_difiere).toBe(false);
  });
});
