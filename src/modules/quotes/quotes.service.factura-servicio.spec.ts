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
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { FlightsService } from '../flights/flights.service';
import type { FacturaSolicitudService } from '../flights/factura-solicitud.service';

/**
 * Chip «Por facturar» en la LISTA de cotizaciones (24-sep-2026): campo
 * ADITIVO `factura_servicio_resumen` por fila, en UN lote por página; `null`
 * cuando no hay dato (sin migración); ausente si el servicio no se inyectó.
 */
const V1 = 'vvvvvvvv-0000-4000-8000-000000000001';
const V2 = 'vvvvvvvv-0000-4000-8000-000000000002';

function armar(facturaSolicitud?: Partial<FacturaSolicitudService>) {
  const filas = [
    { id: V1, folio: 341, origen_iata: 'CUN', destino_iata: 'MID' },
    { id: V2, folio: 342, origen_iata: 'CUN', destino_iata: 'HOL' },
  ];
  const supabase = {
    service: {
      from: (tabla: string) => {
        const q: Record<string, unknown> = {};
        for (const m of [
          'select',
          'eq',
          'in',
          'order',
          'range',
          'or',
          'ilike',
          'limit',
        ]) {
          q[m] = () => q;
        }
        q.then = (res: (v: unknown) => unknown) =>
          Promise.resolve(
            tabla === 'vuelo'
              ? { data: filas, error: null, count: 2 }
              : { data: [], error: null },
          ).then(res);
        return q;
      },
    },
  } as unknown as SupabaseService;
  return new QuotesService(
    {} as AircraftService,
    {} as AirportsService,
    {} as RoutesService,
    supabase,
    {} as CalendarSyncService,
    {} as EmailService,
    {} as NotificationsService,
    {} as FlightsService,
    facturaSolicitud as FacturaSolicitudService | undefined,
  );
}

describe('QuotesService.list — factura_servicio_resumen', () => {
  it('un solo lote por página; fila sin dato ⇒ null', async () => {
    const resumenesDeVuelos = jest.fn().mockResolvedValue(
      new Map([
        [
          V1,
          {
            solicitada: true,
            por_facturar: true,
            paga_contra_factura: true,
            facturas: 0,
          },
        ],
      ]),
    );
    const svc = armar({ resumenesDeVuelos });
    const r = await svc.list({ limit: 50, offset: 0 });
    expect(resumenesDeVuelos).toHaveBeenCalledTimes(1);
    expect(resumenesDeVuelos).toHaveBeenCalledWith([V1, V2]);
    const [a, b] = r.data as Array<Record<string, unknown>>;
    expect(a.factura_servicio_resumen).toEqual({
      solicitada: true,
      por_facturar: true,
      paga_contra_factura: true,
      facturas: 0,
    });
    expect(b.factura_servicio_resumen).toBeNull();
  });

  it('sin el servicio (specs viejos) la llave no aparece', async () => {
    const r = await armar().list({ limit: 50, offset: 0 });
    expect(r.data[0]).not.toHaveProperty('factura_servicio_resumen');
  });
});
