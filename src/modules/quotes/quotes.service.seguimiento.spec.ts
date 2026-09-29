// Módulos pesados que quotes.service importa solo para inyección (mismo
// patrón que los demás specs del cotizador).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { NotFoundException } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { FlightsService } from '../flights/flights.service';
import type { VueloSeguimientoService } from '../flights/vuelo-seguimiento.service';

/**
 * `GET /v1/quotes/:id` = `findById` + bloque ADITIVO del SEGUIMIENTO DE LA
 * COTIZACIÓN (29-sep-2026): contadores + `seguimiento_pendientes_detalle`
 * para el banner ámbar del cotizador. Los caminos internos siguen con
 * `findById` (sin la lectura extra).
 */
const V358 = 'aaaaaaaa-0000-4000-8000-000000000358';
const FILA = { id: V358, folio: 358, monto_total_usd: 1790.4 };

function armar(seguimiento?: Partial<VueloSeguimientoService>) {
  const svc = new QuotesService(
    {} as AircraftService,
    {} as AirportsService,
    {} as RoutesService,
    { service: {} } as unknown as SupabaseService,
    {} as CalendarSyncService,
    {} as EmailService,
    {} as NotificationsService,
    {} as FlightsService,
    undefined,
    undefined,
    seguimiento as VueloSeguimientoService | undefined,
  );
  const findById = jest.spyOn(svc, 'findById').mockResolvedValue(FILA as never);
  return { svc, findById };
}

describe('QuotesService.detalle — seguimiento de la cotización (ADITIVO)', () => {
  const bloque = {
    seguimiento_pendientes: 2,
    seguimiento_cotizacion_pendientes: 1,
    seguimiento_pendientes_detalle: [
      {
        id: 'n1',
        texto: 'Los pax pidieron transporte terrestre',
        created_at: '2026-09-29T20:00:00+00:00',
        creado_por_nombre: 'Itzi',
      },
    ],
  };

  it('agrega los contadores y el detalle a la fila de siempre (prefijo intacto)', async () => {
    const deCotizacion = jest.fn().mockResolvedValue(bloque);
    const { svc } = armar({ deCotizacion });
    await expect(svc.detalle(V358)).resolves.toEqual({ ...FILA, ...bloque });
    expect(deCotizacion).toHaveBeenCalledWith(V358);
  });

  it('sin pendientes: el banner no tiene nada que pintar', async () => {
    const vacio = {
      seguimiento_pendientes: 0,
      seguimiento_cotizacion_pendientes: 0,
      seguimiento_pendientes_detalle: [],
    };
    const { svc } = armar({ deCotizacion: jest.fn().mockResolvedValue(vacio) });
    await expect(svc.detalle(V358)).resolves.toEqual({ ...FILA, ...vacio });
  });

  it('sin el service (specs / arranque parcial): exactamente findById', async () => {
    const { svc } = armar(undefined);
    await expect(svc.detalle(V358)).resolves.toEqual(FILA);
  });

  it('404 de la cotización se propaga (no se inventa una respuesta)', async () => {
    const { svc, findById } = armar({
      deCotizacion: jest.fn().mockResolvedValue(bloque),
    });
    findById.mockRejectedValue(new NotFoundException('Vuelo x not found'));
    await expect(svc.detalle(V358)).rejects.toBeInstanceOf(NotFoundException);
  });
});
