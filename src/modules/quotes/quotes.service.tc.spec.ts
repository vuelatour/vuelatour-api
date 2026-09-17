// Módulos pesados que quotes.service importa solo para inyección (mismo
// patrón que quotes.service.spec.ts).
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
import {
  MetodoPago,
  TipoTarifa,
  TipoVuelo,
  type CalculateQuoteDto,
} from './dto/calculate-quote.dto';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { FlightsService } from '../flights/flights.service';

/**
 * TC DE 6 DECIMALES EN EL MOTOR (17-sep-2026, caso real del vuelo #314).
 *
 * El operador teclea el T.C. con los decimales que hacen cuadrar el total en
 * pesos; el motor compone `total_mxn` con ESE número y `camposDesdeBreakdown`
 * persiste EXACTAMENTE el mismo (antes la columna era numeric(10,4) y la BD
 * lo recortaba: la hoja decía $100,000.00 y el diálogo de cobro $99,999.81).
 */
const AVION = 'aaaaaaaa-0000-0000-0000-000000000001';

function servicio(): QuotesService {
  const aircraft = {
    findById: jest.fn().mockResolvedValue({
      id: AVION,
      activa: true,
      matricula: 'XA-TST',
      modelo: 'Saab 340',
      pais_registro: 'MX',
      velocidad_crucero_kts: 150,
      tarifa_hora_pub_usd: 1750,
      tarifa_hora_broker_usd: 1650,
    }),
  } as unknown as AircraftService;
  const airports = {
    // Sin TUAS: aquí se mide SOLO la conversión a pesos.
    computeTuasUsdPax: jest
      .fn()
      .mockResolvedValue({ aplica: false, usd_pax: 0, razon: 'exenta' }),
  } as unknown as AirportsService;
  const supabase = {
    service: {
      from: () => {
        throw new Error('calculate() no debe tocar la BD en este spec');
      },
    },
  } as unknown as SupabaseService;
  return new QuotesService(
    aircraft,
    airports,
    {} as RoutesService,
    supabase,
    {} as CalendarSyncService,
    {} as EmailService,
    {} as NotificationsService,
    {} as FlightsService,
  );
}

function dtoBase(extra: Partial<CalculateQuoteDto> = {}): CalculateQuoteDto {
  return {
    aeronave_id: AVION,
    tipo: TipoVuelo.MULTIESCALA,
    escalas: [
      { origen_iata: 'CUN', destino_iata: 'MID', millas_nauticas: 90 },
      { origen_iata: 'MID', destino_iata: 'CUN', millas_nauticas: 90 },
    ],
    tipo_tarifa: TipoTarifa.PUBLICO,
    pasajeros: 4,
    // EFECTIVO: sin IVA, para que el total USD sea el precio tecleado.
    metodo_pago: MetodoPago.EFECTIVO,
    ...extra,
  };
}

/** Cotización de precio cerrado: 1 hr cobrable a la tarifa dada. */
function dtoPrecio(
  totalUsd: number,
  tc: number,
  extra: Partial<CalculateQuoteDto> = {},
): CalculateQuoteDto {
  return dtoBase({
    tarifa_hora_override_usd: totalUsd,
    tiempo_cobrable_override_hr: 1,
    tc_usd_mxn: tc,
    ...extra,
  });
}

describe('QuotesService.calculate — total MXN con el TC de 6 decimales', () => {
  it('vuelo #314: 5,885.25 USD @ 16.9916317491 ⇒ $100,000.00 MXN exactos', async () => {
    const r = await servicio().calculate(dtoPrecio(5885.25, 100000 / 5885.25));
    expect(r.totales.total_usd).toBe(5885.25);
    expect(r.totales.total_mxn).toBe(100000);
  });

  it('vuelo #314 con el TC ya recortado a 4 decimales daba 99,999.81 (el bug)', async () => {
    const r = await servicio().calculate(dtoPrecio(5885.25, 16.9916));
    expect(r.totales.total_mxn).toBe(99999.81);
  });

  it('vuelo #140: 2,314 USD @ 17.2860847017 ⇒ $40,000.00 MXN exactos', async () => {
    const r = await servicio().calculate(dtoPrecio(2314, 40000 / 2314));
    expect(r.totales.total_usd).toBe(2314);
    expect(r.totales.total_mxn).toBe(40000);
  });

  it('vuelo #179: 3,596 USD @ 16.9499443826 ⇒ $60,952.00 MXN exactos', async () => {
    const r = await servicio().calculate(dtoPrecio(3596, 60952 / 3596));
    expect(r.totales.total_mxn).toBe(60952);
  });

  it('lo que se PERSISTE es exactamente el TC que compuso los pesos', async () => {
    const svc = servicio();
    const dto = dtoPrecio(5885.25, 100000 / 5885.25);
    const breakdown = await svc.calculate(dto);
    // `camposDesdeBreakdown` es la FUENTE ÚNICA fila←breakdown (create,
    // revise y la vista previa pasan por ella).
    const campos = (
      svc as unknown as {
        camposDesdeBreakdown: (
          d: CalculateQuoteDto,
          b: typeof breakdown,
          pax: number,
        ) => { tc_usd_mxn: number | null; monto_total_mxn: number | null };
      }
    ).camposDesdeBreakdown(dto, breakdown, 4);
    expect(campos.tc_usd_mxn).toBe(16.991632);
    expect(campos.monto_total_mxn).toBe(100000);
    // Y el TC persistido reproduce el total persistido al centavo.
    expect(
      Math.round(
        Number(breakdown.totales.total_usd) * campos.tc_usd_mxn! * 100,
      ) / 100,
    ).toBe(campos.monto_total_mxn);
  });

  it('sin TC no hay total en pesos (nunca 0 en falso)', async () => {
    const r = await servicio().calculate(
      dtoBase({
        tarifa_hora_override_usd: 1000,
        tiempo_cobrable_override_hr: 1,
      }),
    );
    expect(r.totales.total_mxn).toBeNull();
  });
});
