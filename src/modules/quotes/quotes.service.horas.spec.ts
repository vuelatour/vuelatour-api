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
 * HORAS PACTADAS DE 8 DECIMALES EN EL MOTOR (22-sep-2026, cotizaciones #322 y
 * #302 del cliente).
 *
 * La oficina pacta «2 h 20 min» tecleando 2.333333333 hr a $600/hr: el motor
 * multiplicaba con esa precisión (⇒ $1,400.00) pero persistía `round4`
 * (2.3333). Al reabrir, el panel rehidrataba ESE número y el total caía a
 * $1,399.98 sin que nadie tocara nada. Aquí se congela la regla: lo que se
 * persiste es EXACTAMENTE lo que se usó para multiplicar, y re-editar no
 * mueve un centavo.
 */
const AVION = 'aaaaaaaa-0000-0000-0000-000000000001';

/** 2 h 20 min como las teclea la oficina en el campo del pactado. */
const PACTADO_2H20 = 2.333333333;

function servicio(): QuotesService {
  const aircraft = {
    findById: jest.fn().mockResolvedValue({
      id: AVION,
      activa: true,
      matricula: 'XB-PEV',
      modelo: 'Cessna 206',
      pais_registro: 'MX',
      velocidad_crucero_kts: 150,
      tarifa_hora_pub_usd: 1750,
      tarifa_hora_broker_usd: 1650,
    }),
  } as unknown as AircraftService;
  const airports = {
    // Sin TUAS: aquí se mide SOLO el servicio aéreo (horas × tarifa).
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

/** Cotización #322/#302: CUN→PTU→CUN, tarifa personalizada, IVA 16%. */
function dtoPactado(
  tarifa: number,
  cobrable: number | null,
  extra: Partial<CalculateQuoteDto> = {},
): CalculateQuoteDto {
  return {
    aeronave_id: AVION,
    tipo: TipoVuelo.MULTIESCALA,
    escalas: [
      { origen_iata: 'CUN', destino_iata: 'PTU', millas_nauticas: 120 },
      { origen_iata: 'PTU', destino_iata: 'CUN', millas_nauticas: 120 },
    ],
    tipo_tarifa: TipoTarifa.PUBLICO,
    pasajeros: 4,
    metodo_pago: MetodoPago.TRANSFERENCIA,
    tarifa_hora_override_usd: tarifa,
    ...(cobrable != null ? { tiempo_cobrable_override_hr: cobrable } : {}),
    ...extra,
  };
}

type Breakdown = Awaited<ReturnType<QuotesService['calculate']>>;

/** `camposDesdeBreakdown` es la FUENTE ÚNICA fila←breakdown (create, revise y
 *  la vista previa pasan por ella). */
function persistido(svc: QuotesService, dto: CalculateQuoteDto, b: Breakdown) {
  return (
    svc as unknown as {
      camposDesdeBreakdown: (
        d: CalculateQuoteDto,
        b: Breakdown,
        pax: number,
      ) => {
        tiempo_cobrable_hr: number;
        subtotal_vuelo_usd: number;
        monto_total_usd: number;
      };
    }
  ).camposDesdeBreakdown(dto, b, 4);
}

describe('QuotesService.calculate — horas pactadas con 8 decimales', () => {
  it('#322: 2.333333333 hr × $600/hr ⇒ subtotal $1,400.00 y total $1,624.00', async () => {
    const r = await servicio().calculate(dtoPactado(600, PACTADO_2H20));
    expect(r.totales.subtotal_vuelo_usd).toBe(1400);
    expect(r.iva.monto_usd).toBe(224);
    expect(r.totales.total_usd).toBe(1624);
  });

  it('persiste EXACTAMENTE las horas con las que multiplicó (2.33333333)', async () => {
    const svc = servicio();
    const dto = dtoPactado(600, PACTADO_2H20);
    const b = await svc.calculate(dto);
    expect(b.tiempos.cobrable_hr).toBe(2.33333333);
    expect(b.tiempos.cobrable_proviene_de_override).toBe(true);
    const campos = persistido(svc, dto, b);
    expect(campos.tiempo_cobrable_hr).toBe(2.33333333);
    // Y lo persistido reproduce el subtotal persistido AL CENTAVO.
    expect(Math.round(campos.tiempo_cobrable_hr * 600 * 100) / 100).toBe(
      campos.subtotal_vuelo_usd,
    );
  });

  it('RE-EDICIÓN: rehidratar lo persistido y recalcular NO mueve el total (el bug de #322)', async () => {
    const svc = servicio();
    const primera = await svc.calculate(dtoPactado(600, PACTADO_2H20));
    // Exactamente lo que hace el panel al reabrir: el pactado sale del
    // snapshot guardado.
    const segunda = await svc.calculate(
      dtoPactado(600, primera.tiempos.cobrable_hr),
    );
    expect(segunda.totales.subtotal_vuelo_usd).toBe(1400);
    expect(segunda.totales.total_usd).toBe(1624);
    expect(segunda.tiempos.cobrable_hr).toBe(primera.tiempos.cobrable_hr);
    // Una tercera vuelta tampoco: el número es un PUNTO FIJO.
    const tercera = await svc.calculate(
      dtoPactado(600, segunda.tiempos.cobrable_hr),
    );
    expect(tercera.totales.total_usd).toBe(1624);
  });

  it('con la precisión VIEJA (2.3333) el total caía a $1,623.98 — la prueba del defecto', async () => {
    const r = await servicio().calculate(dtoPactado(600, 2.3333));
    expect(r.totales.subtotal_vuelo_usd).toBe(1399.98);
    expect(r.totales.total_usd).toBe(1623.98);
  });

  it('tarifas altas: 2:20 no pierde el centavo a $3,500 ni a $9,750/hr', async () => {
    const svc = servicio();
    const a = await svc.calculate(dtoPactado(3500, PACTADO_2H20));
    expect(a.totales.subtotal_vuelo_usd).toBe(8166.67);
    const b = await svc.calculate(dtoPactado(9750, PACTADO_2H20));
    expect(b.totales.subtotal_vuelo_usd).toBe(22750);
    // Con 4 decimales se perdían 32 centavos en el vuelo de $22,750.
    const viejo = await svc.calculate(dtoPactado(9750, 2.3333));
    expect(viejo.totales.subtotal_vuelo_usd).toBe(22749.68);
    // Re-editar tampoco mueve nada a esas tarifas.
    const reeditado = await svc.calculate(
      dtoPactado(9750, b.tiempos.cobrable_hr),
    );
    expect(reeditado.totales.subtotal_vuelo_usd).toBe(22750);
  });

  it('horas de la REGLA: lo persistido también es lo que se multiplicó', async () => {
    const svc = servicio();
    // 260 nm ÷ 150 kts = 1.73333… hr + 2 calzos (0.30) = 2.03333… hr.
    const dto = dtoPactado(575, null, {
      escalas: [
        { origen_iata: 'CUN', destino_iata: 'MID', millas_nauticas: 130 },
        { origen_iata: 'MID', destino_iata: 'CUN', millas_nauticas: 130 },
      ],
    });
    const b = await svc.calculate(dto);
    expect(b.tiempos.cobrable_proviene_de_override).toBe(false);
    expect(b.tiempos.cobrable_hr).toBe(2.03333333);
    expect(Math.round(b.tiempos.cobrable_hr * 575 * 100) / 100).toBe(
      b.totales.subtotal_vuelo_usd,
    );
    const campos = persistido(svc, dto, b);
    expect(campos.tiempo_cobrable_hr).toBe(2.03333333);
  });

  it('el sobrevuelo pactado también se guarda con 8 decimales (se rehidrata)', async () => {
    const svc = servicio();
    const dto = dtoPactado(600, null, { sobrevuelo_hr: 1 / 3 });
    const b = await svc.calculate(dto);
    expect(b.tiempos.sobrevuelo_hr).toBe(0.33333333);
    // Rehidratarlo (panel / ajuste rápido) reproduce el mismo total.
    const b2 = await svc.calculate(
      dtoPactado(600, null, { sobrevuelo_hr: b.tiempos.sobrevuelo_hr }),
    );
    expect(b2.totales.total_usd).toBe(b.totales.total_usd);
    expect(b2.tiempos.cobrable_hr).toBe(b.tiempos.cobrable_hr);
  });

  it('el desglose sigue imprimiendo las horas a 4 decimales (presentación)', async () => {
    const r = await servicio().calculate(dtoPactado(600, PACTADO_2H20));
    const tiempo = r.desglose.find((d) => d.clave === 'TIEMPO_VUELO')!;
    expect(tiempo.concepto).toContain('2.3333 hr');
    expect(tiempo.monto_usd).toBe(1400);
  });

  it('sin pactado a mano la bandera queda en false y manda la regla', async () => {
    const r = await servicio().calculate(dtoPactado(600, null));
    expect(r.tiempos.cobrable_proviene_de_override).toBe(false);
    expect(r.tiempos.cobrable_hr).toBe(r.tiempos.cobrable_hr_regla);
  });
});

describe('anclarRevisionAlPersistido — el ECO TRUNCADO no baja el total', () => {
  type Anclar = (
    dto: CalculateQuoteDto,
    current: Record<string, unknown>,
    opts: { desdeGrupo?: boolean },
  ) => void;

  const anclar = (svc: QuotesService): Anclar =>
    (
      svc as unknown as { anclarRevisionAlPersistido: Anclar }
    ).anclarRevisionAlPersistido.bind(svc);

  /** Fila persistida de #302 ya con los 8 decimales (tras el backfill). */
  function filaPactada(extra: Record<string, unknown> = {}) {
    return {
      cliente_id: 'c1',
      es_externo: false,
      extras: [],
      tiempo_cobrable_hr: 2.33333333,
      calculo_snapshot: {
        tiempos: {
          cobrable_hr: 2.33333333,
          cobrable_proviene_de_override: true,
        },
        meta: {},
      },
      ...extra,
    };
  }

  it('un panel VIEJO que devuelve 2.3333 se ancla a 2.33333333', () => {
    const svc = servicio();
    const dto = dtoPactado(600, 2.3333);
    anclar(svc)(dto, filaPactada(), {});
    expect(dto.tiempo_cobrable_override_hr).toBe(2.33333333);
  });

  it('una EDICIÓN real del pactado se respeta (2.5 hr)', () => {
    const svc = servicio();
    const dto = dtoPactado(600, 2.5);
    anclar(svc)(dto, filaPactada(), {});
    expect(dto.tiempo_cobrable_override_hr).toBe(2.5);
  });

  it('más precisión tecleada a mano se respeta (2.3334 = 6 centavos)', () => {
    const svc = servicio();
    const dto = dtoPactado(600, 2.3334);
    anclar(svc)(dto, filaPactada(), {});
    expect(dto.tiempo_cobrable_override_hr).toBe(2.3334);
  });

  it('con el snapshot truncado pero la columna completa, gana la columna', () => {
    const svc = servicio();
    const dto = dtoPactado(600, 2.3333);
    anclar(svc)(
      dto,
      filaPactada({
        calculo_snapshot: {
          tiempos: {
            cobrable_hr: 2.3333,
            cobrable_proviene_de_override: true,
          },
          meta: {},
        },
      }),
      {},
    );
    expect(dto.tiempo_cobrable_override_hr).toBe(2.33333333);
  });

  it('sin pactado vigente no se ancla nada (manda la regla)', () => {
    const svc = servicio();
    const dto = dtoPactado(600, 2.3333);
    anclar(svc)(
      dto,
      filaPactada({
        calculo_snapshot: {
          tiempos: {
            cobrable_hr: 2.33333333,
            cobrable_proviene_de_override: false,
          },
          meta: {},
        },
      }),
      {},
    );
    expect(dto.tiempo_cobrable_override_hr).toBe(2.3333);
  });

  it('soltar el pactado (sin override en el DTO) sigue funcionando', () => {
    const svc = servicio();
    const dto = dtoPactado(600, null);
    anclar(svc)(dto, filaPactada(), {});
    expect(dto.tiempo_cobrable_override_hr).toBeUndefined();
  });

  it('el eco anclado produce de nuevo $1,400.00 / $1,624.00', async () => {
    const svc = servicio();
    const dto = dtoPactado(600, 2.3333);
    // Sin cliente en la fila: el anclaje copia `cliente_id` al DTO y con uno
    // real el motor leería la tarifa preferencial (aquí la BD está vetada).
    anclar(svc)(dto, filaPactada({ cliente_id: null }), {});
    const r = await svc.calculate(dto);
    expect(r.totales.subtotal_vuelo_usd).toBe(1400);
    expect(r.totales.total_usd).toBe(1624);
  });
});
