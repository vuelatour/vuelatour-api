// Módulos pesados que quotes.service importa solo para inyección: se
// sustituyen por clases vacías — notifications arrastra el gateway y `jose`
// (ESM puro, jest no lo transforma); calendar-sync arrastra googleapis.
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

/**
 * Motor v1.3 con extras `cantidad × unitario` / `por_persona` / origen GRUPO
 * (4-sep-2026, base de la cotización de grupo). Aeronave y TUAS se simulan;
 * no hay BD (sin cliente_id el motor no la toca). Caso real del diseño:
 * Kodiak N621TX, CUN→CZA→CUN 90 nm por sentido, 9 pax, PÚBLICO $1,750/hr,
 * TRANSFERENCIA (IVA 16 %), CUN exenta para N, CZA $18/pax, tour 9 × $85.
 */
const KODIAK = 'aaaaaaaa-0000-0000-0000-000000000001';
const GRUPO_EXTRA = '22222222-0000-0000-0000-000000000002';

function servicio(): QuotesService {
  const aircraft = {
    findById: jest.fn().mockResolvedValue({
      id: KODIAK,
      activa: true,
      matricula: 'N621TX',
      modelo: 'Kodiak 100',
      pais_registro: 'US',
      velocidad_crucero_kts: 150,
      tarifa_hora_pub_usd: 1750,
      tarifa_hora_broker_usd: 1650,
    }),
  } as unknown as AircraftService;
  const airports = {
    computeTuasUsdPax: jest
      .fn()
      .mockImplementation((iata: string) =>
        Promise.resolve(
          iata === 'CZA'
            ? { aplica: true, usd_pax: 18, razon: 'TUAS aplica' }
            : { aplica: false, usd_pax: 0, razon: 'Matricula N exenta' },
        ),
      ),
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
  );
}

function dtoBase(extra: Partial<CalculateQuoteDto> = {}): CalculateQuoteDto {
  return {
    aeronave_id: KODIAK,
    tipo: TipoVuelo.MULTIESCALA,
    escalas: [
      { origen_iata: 'CUN', destino_iata: 'CZA', millas_nauticas: 90 },
      { origen_iata: 'CZA', destino_iata: 'CUN', millas_nauticas: 90 },
    ],
    tipo_tarifa: TipoTarifa.PUBLICO,
    pasajeros: 9,
    metodo_pago: MetodoPago.TRANSFERENCIA,
    ...extra,
  };
}

const sumaDesglose = (
  r: Awaited<ReturnType<QuotesService['calculate']>>,
): number =>
  Math.round(r.desglose.reduce((acc, d) => acc + d.monto_usd, 0) * 100) / 100;

describe('QuotesService.calculate — extras cantidad × unitario', () => {
  it('Kodiak del ejemplo del diseño: tour 9 × $85 = 765 derivado, concepto pintado y Σ desglose == total (4,120.32)', async () => {
    const r = await servicio().calculate(
      dtoBase({
        extras: [
          {
            concepto: 'Tour Chichén Itzá',
            cantidad: 9,
            unitario: 85,
            aplica_iva: true,
            por_persona: true,
            origen: 'GRUPO',
            grupo_extra_id: GRUPO_EXTRA,
            // monto_usd manipulado: el motor lo IGNORA y deriva.
            monto_usd: 1,
          },
        ],
      }),
    );
    expect(r.totales.subtotal_vuelo_usd).toBe(2625);
    expect(r.totales.tuas_total_usd).toBe(162);
    expect(r.totales.extras_total_usd).toBe(765);
    expect(r.iva.monto_usd).toBe(568.32);
    expect(r.totales.total_usd).toBe(4120.32);
    expect(sumaDesglose(r)).toBe(4120.32);
    const extra = r.desglose.find((d) => d.clave === 'EXTRA')!;
    expect(extra.concepto).toBe('Tour Chichén Itzá · 9 × $85.00');
    expect(extra.monto_usd).toBe(765);
    // Los campos viajan al snapshot (y de ahí a vuelo.extras).
    expect(r.extras![0]).toEqual({
      concepto: 'Tour Chichén Itzá',
      monto_usd: 765,
      moneda: 'USD',
      monto_nativo: 765,
      tc_aplicado: null,
      aplica_iva: true,
      cantidad: 9,
      unitario: 85,
      por_persona: true,
      origen: 'GRUPO',
      grupo_extra_id: GRUPO_EXTRA,
    });
    // Snapshot de una cotización normal: meta.grupo ausente (undefined).
    expect(r.meta.grupo).toBeUndefined();
  });

  it('por_persona en cotización de UN avión: la cantidad sigue a los pasajeros en cada recálculo', async () => {
    const svc = servicio();
    const tour = {
      concepto: 'Tour',
      unitario: 85,
      por_persona: true,
      cantidad: 3, // se ignora: manda el pax del vuelo
    };
    const con9 = await svc.calculate(
      dtoBase({ pasajeros: 9, extras: [tour] as never }),
    );
    expect(con9.extras![0].cantidad).toBe(9);
    expect(con9.extras![0].monto_usd).toBe(765);
    const con5 = await svc.calculate(
      dtoBase({ pasajeros: 5, extras: [tour] as never }),
    );
    expect(con5.extras![0].cantidad).toBe(5);
    expect(con5.extras![0].monto_usd).toBe(425);
    expect(sumaDesglose(con5)).toBe(con5.totales.total_usd);
  });

  it('línea de GRUPO por_persona conserva su cantidad (doble rotación: grupo_pax 10, vuelo.pasajeros 5)', async () => {
    const r = await servicio().calculate(
      dtoBase({
        pasajeros: 5,
        extras: [
          {
            concepto: 'Tour',
            cantidad: 10,
            unitario: 85,
            por_persona: true,
            origen: 'GRUPO',
            grupo_extra_id: GRUPO_EXTRA,
          } as never,
        ],
      }),
    );
    expect(r.extras![0].cantidad).toBe(10);
    expect(r.extras![0].monto_usd).toBe(850);
    expect(sumaDesglose(r)).toBe(r.totales.total_usd);
  });

  it('extra "de monto" legado: forma byte-idéntica (sin claves nuevas) y sin etiqueta n × $u', async () => {
    const r = await servicio().calculate(
      dtoBase({
        extras: [{ concepto: 'Handler', monto_usd: 150, aplica_iva: false }],
      }),
    );
    expect(r.extras![0]).toEqual({
      concepto: 'Handler',
      monto_usd: 150,
      moneda: 'USD',
      monto_nativo: 150,
      tc_aplicado: null,
      aplica_iva: false,
    });
    expect(r.desglose.find((d) => d.clave === 'EXTRA')!.concepto).toBe(
      'Handler (sin IVA)',
    );
    expect(sumaDesglose(r)).toBe(r.totales.total_usd);
  });

  it('cantidad × unitario en MXN: nativo en pesos, canon con el TC y total MXN por composición', async () => {
    const r = await servicio().calculate(
      dtoBase({
        tc_usd_mxn: 18.5,
        extras: [
          {
            concepto: 'Camionetas',
            cantidad: 2,
            unitario: 1500,
            moneda: 'MXN',
            aplica_iva: true,
          } as never,
        ],
      }),
    );
    const e = r.extras![0];
    expect(e.monto_nativo).toBe(3000);
    expect(e.monto_usd).toBe(162.16);
    expect(e.tc_aplicado).toBe(18.5);
    expect(r.desglose.find((d) => d.clave === 'EXTRA')!.concepto).toBe(
      'Camionetas · 2 × $1,500.00 MXN = $3,000.00 MXN',
    );
    expect(sumaDesglose(r)).toBe(r.totales.total_usd);
    // MXN nativo entra en pesos tal cual; el resto × TC (un solo redondeo).
    expect(r.totales.mxn_nativos).toBe(3000);
    expect(r.totales.total_mxn).toBe(
      Math.round((r.totales.total_usd - 162.16) * 18.5 * 100) / 100 + 3000,
    );
  });

  it('Σ desglose exacta con mezcla de extras nuevos con y sin IVA (redondeo por componente)', async () => {
    const r = await servicio().calculate(
      dtoBase({
        extras: [
          { concepto: 'Snacks', cantidad: 3, unitario: 33.34 } as never,
          {
            concepto: 'Propina',
            cantidad: 7,
            unitario: 12.35,
            aplica_iva: false,
          } as never,
          { concepto: 'Handler', monto_usd: 99.99 },
        ],
      }),
    );
    const extras = r.desglose.filter((d) => d.clave === 'EXTRA');
    expect(extras.map((d) => d.monto_usd)).toEqual([100.02, 86.45, 99.99]);
    expect(extras[0].concepto).toBe('Snacks · 3 × $33.34');
    expect(extras[1].concepto).toBe('Propina · 7 × $12.35 (sin IVA)');
    expect(sumaDesglose(r)).toBe(r.totales.total_usd);
    expect(r.totales.extras_total_usd).toBe(286.46);
    // Con IVA: 2625 + 162 + 100.02 + 99.99 = 2987.01 × 0.16 = 477.92
    expect(r.iva.monto_usd).toBe(477.92);
    expect(r.totales.total_usd).toBe(3551.38);
  });

  it('cantidad 0 deja el extra fuera (como un monto 0)', async () => {
    const r = await servicio().calculate(
      dtoBase({
        extras: [{ concepto: 'Tour', cantidad: 0, unitario: 85 } as never],
      }),
    );
    expect(r.extras).toBeNull();
    expect(r.desglose.some((d) => d.clave === 'EXTRA')).toBe(false);
  });
});
