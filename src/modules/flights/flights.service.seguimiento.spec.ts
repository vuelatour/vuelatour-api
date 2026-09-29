// Mismos mocks de módulos pesados que el resto de los specs de flights.
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
import type { VueloSeguimientoService } from './vuelo-seguimiento.service';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';

/**
 * SEGUIMIENTO DE LA COTIZACIÓN (29-sep-2026): contadores ADITIVOS
 * `seguimiento_pendientes` / `seguimiento_cotizacion_pendientes` en
 * `GET /v1/flights/:id` (detalle) y en el snapshot. Solo para los roles que
 * leen la lista; la tripulación no los recibe (llaves omitidas) y sin el
 * service (specs viejos) la respuesta es la de siempre.
 */

const V358 = 'aaaaaaaa-0000-4000-8000-000000000358';

/** Supabase que responde vacío a todo (el detalle no depende de filas). */
function supabaseVacio(): SupabaseService {
  const q: Record<string, unknown> = {};
  for (const m of [
    'select',
    'eq',
    'neq',
    'in',
    'is',
    'not',
    'or',
    'gte',
    'lte',
    'order',
    'limit',
  ]) {
    q[m] = () => q;
  }
  q.maybeSingle = () => Promise.resolve({ data: null, error: null });
  q.single = () => Promise.resolve({ data: null, error: null });
  q.then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null, count: 0 }).then(res);
  return {
    service: { from: () => q, storage: { from: () => ({}) } },
  } as unknown as SupabaseService;
}

function servicio(seguimiento?: Partial<VueloSeguimientoService>) {
  const svc = new FlightsService(
    supabaseVacio(),
    {} as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {} as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
    undefined,
    undefined,
    undefined,
    seguimiento as VueloSeguimientoService | undefined,
  );
  jest.spyOn(svc, 'findById').mockResolvedValue({
    id: V358,
    folio: 358,
    estado: 'COMPLETADO',
    aeronave_id: null,
    piloto_id: null,
    copiloto_id: null,
    apoyo_id: null,
    cliente_id: null,
    grupo_id: null,
    tc_usd_mxn: null,
  } as never);
  return svc;
}

const usuario = (rol: Rol): AuthenticatedUser =>
  ({ userId: 'u-1', rol, nombre: 'X' }) as AuthenticatedUser;

describe('FlightsService — contadores del seguimiento (ADITIVOS)', () => {
  const contadoresDeVuelo = jest.fn();

  beforeEach(() => {
    contadoresDeVuelo.mockReset().mockResolvedValue({
      seguimiento_pendientes: 2,
      seguimiento_cotizacion_pendientes: 1,
    });
  });

  it.each([
    Rol.ADMIN,
    Rol.COORDINADOR,
    Rol.FACTURACION,
    Rol.SOCIO,
    Rol.ANALISTA,
  ])('detalle y snapshot los traen para %s', async (rol) => {
    const svc = servicio({ contadoresDeVuelo });
    const det = (await svc.detalle(V358, usuario(rol))) as Record<
      string,
      unknown
    >;
    expect(det).toMatchObject({
      seguimiento_pendientes: 2,
      seguimiento_cotizacion_pendientes: 1,
    });
    const snap = (await svc.snapshot(V358, usuario(rol))) as Record<
      string,
      unknown
    >;
    expect(snap).toMatchObject({
      seguimiento_pendientes: 2,
      seguimiento_cotizacion_pendientes: 1,
    });
    expect(contadoresDeVuelo).toHaveBeenCalledWith(V358);
  });

  it.each([Rol.PILOTO, Rol.MECANICO])(
    '%s NO los recibe (llaves omitidas, ni se leen)',
    async (rol) => {
      const svc = servicio({ contadoresDeVuelo });
      const det = (await svc.detalle(V358, usuario(rol))) as Record<
        string,
        unknown
      >;
      const snap = (await svc.snapshot(V358, usuario(rol))) as Record<
        string,
        unknown
      >;
      for (const r of [det, snap]) {
        expect(r).not.toHaveProperty('seguimiento_pendientes');
        expect(r).not.toHaveProperty('seguimiento_cotizacion_pendientes');
      }
      expect(contadoresDeVuelo).not.toHaveBeenCalled();
    },
  );

  it('lectura fallida ⇒ null (el detalle NO se cae)', async () => {
    contadoresDeVuelo.mockResolvedValue({
      seguimiento_pendientes: null,
      seguimiento_cotizacion_pendientes: null,
    });
    const snap = (await servicio({ contadoresDeVuelo }).snapshot(
      V358,
      usuario(Rol.ADMIN),
    )) as Record<string, unknown>;
    expect(snap.seguimiento_pendientes).toBeNull();
    expect(snap.seguimiento_cotizacion_pendientes).toBeNull();
    expect(snap.folio).toBe(358);
  });

  it('sin el service inyectado: la respuesta de siempre (sin las llaves)', async () => {
    const svc = servicio(undefined);
    const det = (await svc.detalle(V358, usuario(Rol.ADMIN))) as Record<
      string,
      unknown
    >;
    expect(det).not.toHaveProperty('seguimiento_pendientes');
    expect(det.folio).toBe(358);
  });
});
