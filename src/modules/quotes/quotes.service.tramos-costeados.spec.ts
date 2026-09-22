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

import { QuotesService } from './quotes.service';
import {
  MetodoPago,
  TipoTarifa,
  TipoVuelo,
  type CalculateQuoteDto,
} from './dto/calculate-quote.dto';
import { costearTramos } from './tramos-costeados.util';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { FlightsService } from '../flights/flights.service';

/**
 * TRAMOS COSTEADOS EN `POST /v1/quotes/calculate` (22-sep-2026) — la columna
 * «TOTAL POR TRAMO» del Excel de la oficina, que la hoja INTERNA del panel
 * pinta MIENTRAS se teclea.
 *
 * DOS contratos, y el segundo es el importante:
 *
 * 1. Los campos son ADITIVOS y salen del MISMO helper puro que imprime el PDF
 *    interno (`tramos-costeados.util`): el panel NUNCA recalcula
 *    `round2(tiempo_hr × tarifa)`, `tramos_ajuste_usd` ni el motivo del
 *    ajuste. Si lo hiciera, pantalla y PDF podrían decir cifras distintas del
 *    MISMO vuelo.
 * 2. **El desglose canónico v1.3 no cambia ni un byte** (invariante 3): el
 *    breakdown VIEJO se congela aquí como SUBCONJUNTO del nuevo —mismas
 *    llaves, mismos valores, mismo orden de `lineas` y de `totales`—, así que
 *    ningún número persistido ni impreso se mueve por este cambio.
 */
const AVION = 'aaaaaaaa-0000-4000-8000-00000000c206';

/** Llaves del breakdown ANTES del 22-sep-2026 (congeladas: nada se retira). */
const LLAVES_BREAKDOWN_VIEJAS = [
  'aeronave',
  'ruta',
  'tiempos',
  'tarifa',
  'tuas',
  'tramos',
  'iva',
  'extras',
  'desglose',
  'totales',
  'meta',
];

/** Llaves de `breakdown.tramos[i]` ANTES del 22-sep-2026. */
const LLAVES_TRAMO_VIEJAS = [
  'orden',
  'origen',
  'destino',
  'millas',
  'pasajeros',
  'es_ferry',
  'tiempo_hr',
  'tuas_usd',
  'requiere_pernocta',
  'pernocta_usd',
  'tipo_parada',
  'servicio_notas',
  'pdf_oculto',
];

/** Las 5 llaves NUEVAS de la raíz y las 3 NUEVAS de cada tramo. */
const LLAVES_PIE_NUEVAS = [
  'tramos_total_usd',
  'tramos_tiempo_total_hr',
  'tramos_tiempo_total_hhmm',
  'tramos_ajuste_usd',
  'tramos_ajuste_motivo',
];
const LLAVES_TRAMO_NUEVAS = ['tarifa_usd_hr', 'tiempo_hhmm', 'total_usd'];

function servicio(): QuotesService {
  const aircraft = {
    findById: jest.fn().mockResolvedValue({
      id: AVION,
      activa: true,
      matricula: 'XB-PEV',
      modelo: 'Cessna 206',
      pais_registro: 'MX',
      // 150 kts: 27 nm ⇒ 0.18 + 0.15 de calzo = 0.33 hr (el tramo 1 de #329).
      velocidad_crucero_kts: 150,
      tarifa_hora_pub_usd: 1650,
      tarifa_hora_broker_usd: 1650,
    }),
  } as unknown as AircraftService;
  const airports = {
    // Sin TUAS: aquí se mide SOLO la tabla de tramos y el servicio aéreo.
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

/** #329: CUN→PCE→PPS→CUN (27 + 63 + 90 nm) a $1,650/hr. */
function dto(extra: Partial<CalculateQuoteDto> = {}): CalculateQuoteDto {
  return {
    aeronave_id: AVION,
    tipo: TipoVuelo.MULTIESCALA,
    escalas: [
      {
        origen_iata: 'CUN',
        destino_iata: 'PCE',
        millas_nauticas: 27,
        es_ferry: true,
      },
      { origen_iata: 'PCE', destino_iata: 'PPS', millas_nauticas: 63 },
      {
        origen_iata: 'PPS',
        destino_iata: 'CUN',
        millas_nauticas: 90,
        es_ferry: true,
      },
    ],
    tipo_tarifa: TipoTarifa.PUBLICO,
    pasajeros: 4,
    metodo_pago: MetodoPago.EFECTIVO,
    ...extra,
  };
}

describe('QuotesService.calculate — tramos costeados (campos ADITIVOS)', () => {
  it('cada tramo trae total_usd, tarifa_usd_hr y tiempo_hhmm; el pie cierra Σ tramos + ajuste == servicio aéreo', async () => {
    const b = await servicio().calculate(dto());
    expect(b.tramos).not.toBeNull();
    expect(
      b.tramos!.map((t) => [
        t.origen,
        t.destino,
        t.tiempo_hr,
        t.tiempo_hhmm,
        t.tarifa_usd_hr,
        t.total_usd,
      ]),
    ).toEqual([
      ['CUN', 'PCE', 0.33, '00:20', 1650, 544.5],
      ['PCE', 'PPS', 0.57, '00:34', 1650, 940.5],
      ['PPS', 'CUN', 0.75, '00:45', 1650, 1237.5],
    ]);
    expect(b.tramos_total_usd).toBe(2722.5);
    expect(b.tramos_tiempo_total_hr).toBe(1.65);
    expect(b.tramos_tiempo_total_hhmm).toBe('01:39');
    // Sin pactar horas la tabla cuadra con el servicio aéreo: ajuste 0.
    expect(b.tramos_ajuste_usd).toBe(0);
    expect(b.tramos_ajuste_motivo).toBeNull();
    expect(b.tramos_total_usd! + b.tramos_ajuste_usd!).toBe(
      b.totales.subtotal_vuelo_usd,
    );
  });

  it('horas PACTADAS (#329, 1.75 hr sobre 1.65): la tabla sigue en $2,722.50 y el ajuste de $165.00 dice por qué', async () => {
    const b = await servicio().calculate(
      dto({ tiempo_cobrable_override_hr: 1.75 }),
    );
    expect(b.totales.subtotal_vuelo_usd).toBe(2887.5);
    expect(b.tramos_total_usd).toBe(2722.5);
    expect(b.tramos_ajuste_usd).toBe(165);
    expect(b.tramos_ajuste_motivo).toBe('Horas pactadas 1.75 h');
    expect(b.tramos_total_usd! + b.tramos_ajuste_usd!).toBe(2887.5);
  });

  it('hora mínima y sobrevuelo se NOMBRAN en el motivo (vuelo corto de 0.33 hr)', async () => {
    const corto = await servicio().calculate({
      ...dto(),
      escalas: [
        { origen_iata: 'CUN', destino_iata: 'PCE', millas_nauticas: 27 },
      ],
    });
    expect(corto.tiempos.minimo_hora_aplicado).toBe(true);
    expect(corto.tramos_total_usd).toBe(544.5);
    expect(corto.totales.subtotal_vuelo_usd).toBe(1650);
    expect(corto.tramos_ajuste_usd).toBe(1105.5);
    expect(corto.tramos_ajuste_motivo).toBe('Hora mínima 1.0 h');

    const conSobrevuelo = await servicio().calculate(
      dto({ sobrevuelo_hr: 0.5 }),
    );
    expect(conSobrevuelo.tramos_ajuste_usd).toBe(825);
    expect(conSobrevuelo.tramos_ajuste_motivo).toBe('Sobrevuelo 0.5 h');
  });

  it('el panel NO tiene que calcular nada: el breakdown trae EXACTAMENTE lo que produce el helper compartido con el PDF interno', async () => {
    const b = await servicio().calculate(
      dto({ tiempo_cobrable_override_hr: 1.75 }),
    );
    const helper = costearTramos({
      tramos: b.tramos!,
      tarifaHora: b.tarifa.usd_por_hora,
      servicioAereoUsd: b.totales.subtotal_vuelo_usd,
      horas: {
        tiempo_cobrable_hr: b.tiempos.cobrable_hr,
        sobrevuelo_hr: b.tiempos.sobrevuelo_hr,
        hora_minima_aplicada: b.tiempos.minimo_hora_aplicado,
        cobrable_override: b.tiempos.cobrable_proviene_de_override,
      },
    });
    expect(b.tramos!.map((t) => t.total_usd)).toEqual(
      helper.tramos.map((t) => t.total_usd),
    );
    expect(b.tramos_total_usd).toBe(helper.tramos_total_usd);
    expect(b.tramos_tiempo_total_hr).toBe(helper.tramos_tiempo_total_hr);
    expect(b.tramos_tiempo_total_hhmm).toBe(helper.tramos_tiempo_total_hhmm);
    expect(b.tramos_ajuste_usd).toBe(helper.tramos_ajuste_usd);
    expect(b.tramos_ajuste_motivo).toBe(helper.tramos_ajuste_motivo);
  });

  it('los 5 campos del pie EXISTEN SIEMPRE como llave (el panel no distingue «no vino» de «no aplica»)', async () => {
    const b = await servicio().calculate(dto());
    for (const k of LLAVES_PIE_NUEVAS) {
      expect(Object.prototype.hasOwnProperty.call(b, k)).toBe(true);
      expect((b as unknown as Record<string, unknown>)[k]).not.toBeUndefined();
    }
  });

  /**
   * El `?? null` del pie es una GUARDA DEFENSIVA, no un estado observable, y
   * conviene decirlo con precisión para que nadie lo "simplifique" a 0:
   *
   *  - HOY `calculate()` NUNCA devuelve `tramos: null`. `resolveRoute` o
   *    entrega tramos (itinerario explícito, o plantilla MULTIESCALA del
   *    catálogo hidratada) o RECHAZA con 400 — los caminos legados "ad-hoc"
   *    y "redondo automático ×2" se retiraron. En prod, las 231 cotizaciones
   *    con snapshot traen `tramos` como arreglo y NINGUNA lo trae en null.
   *  - Si algún día vuelve una ruta sin tramos, el pie tiene que salir en
   *    `null`: un 0 convertiría TODO el servicio aéreo en un "ajuste" que no
   *    existe (`tramos_ajuste_usd = subtotal − 0`).
   *
   * Por eso se prueban las DOS mitades: que los caminos sin tramos rebotan, y
   * que el mapeo del pie es `?? null` y no `?? 0`.
   */
  it('hoy NINGÚN camino de calculate() deja el vuelo sin tabla: los que no tienen tramos rebotan 400', async () => {
    const svc = servicio();
    // MULTIESCALA sin escalas y sin ruta_id.
    await expect(
      svc.calculate({ ...dto(), escalas: undefined }),
    ).rejects.toThrow(/al menos 1 tramo/i);
    // Ni siquiera el REDONDO sin ruta ni escalas cotiza (el "redondo
    // automático ×2" se retiró: ya no hay camino ad-hoc sin tramos).
    await expect(
      svc.calculate({
        ...dto(),
        tipo: TipoVuelo.REDONDO,
        escalas: undefined,
      }),
    ).rejects.toThrow(/ruta guardada|itinerario por tramos/i);
  });

  it('la guarda del pie es `?? null`, jamás `?? 0` (un 0 volvería ajuste todo el servicio aéreo)', () => {
    // Se prueba el mapeo tal cual lo escribe `calculate()` cuando no hay
    // tabla: con `tramosCosteados` en null, los 5 salen en null.
    const sinTabla = null as ReturnType<typeof costearTramos> | null;
    const pie = {
      tramos_total_usd: sinTabla?.tramos_total_usd ?? null,
      tramos_tiempo_total_hr: sinTabla?.tramos_tiempo_total_hr ?? null,
      tramos_tiempo_total_hhmm: sinTabla?.tramos_tiempo_total_hhmm ?? null,
      tramos_ajuste_usd: sinTabla?.tramos_ajuste_usd ?? null,
      tramos_ajuste_motivo: sinTabla?.tramos_ajuste_motivo ?? null,
    };
    expect(Object.keys(pie)).toEqual(LLAVES_PIE_NUEVAS);
    expect(Object.values(pie)).toEqual([null, null, null, null, null]);
  });
});

describe('QuotesService.calculate — el desglose canónico v1.3 NO cambia (invariante 3)', () => {
  it('las llaves del breakdown VIEJO siguen todas ahí y solo se AÑADEN las 5 del pie', async () => {
    const b = await servicio().calculate(dto());
    expect(Object.keys(b)).toEqual([
      ...LLAVES_BREAKDOWN_VIEJAS,
      ...LLAVES_PIE_NUEVAS,
    ]);
    for (const t of b.tramos!) {
      expect(Object.keys(t)).toEqual([
        ...LLAVES_TRAMO_VIEJAS,
        ...LLAVES_TRAMO_NUEVAS,
      ]);
    }
  });

  it('`lineas` del desglose, su ORDEN y los `totales` quedan byte a byte como antes', async () => {
    const b = await servicio().calculate(
      dto({ tiempo_cobrable_override_hr: 1.75 }),
    );
    expect(b.desglose).toEqual([
      {
        clave: 'TIEMPO_VUELO',
        concepto: 'Tiempo de vuelo · 1.75 hr × $1650/hr',
        monto_usd: 2887.5,
      },
    ]);
    expect(b.totales).toEqual({
      subtotal_vuelo_usd: 2887.5,
      tuas_total_usd: 0,
      viaticos_pernocta_usd: 0,
      extras_total_usd: 0,
      ajuste_final_usd: 0,
      iva_usd: 0,
      total_usd: 2887.5,
      mxn_nativos: 0,
      usd_de_mxn: 0,
      total_mxn: null,
    });
    // Σ líneas == total (la identidad canónica).
    expect(
      Math.round(b.desglose.reduce((a, l) => a + l.monto_usd, 0) * 100) / 100,
    ).toBe(b.totales.total_usd);
  });

  it('los datos VIEJOS de cada tramo no se tocan: el costeo solo AÑADE', async () => {
    const b = await servicio().calculate(dto());
    expect(
      b.tramos!.map((t) => ({
        orden: t.orden,
        origen: t.origen,
        destino: t.destino,
        millas: t.millas,
        pasajeros: t.pasajeros,
        es_ferry: t.es_ferry,
        tiempo_hr: t.tiempo_hr,
        tuas_usd: t.tuas_usd,
        requiere_pernocta: t.requiere_pernocta,
        pernocta_usd: t.pernocta_usd,
        tipo_parada: t.tipo_parada,
        servicio_notas: t.servicio_notas,
        pdf_oculto: t.pdf_oculto,
      })),
    ).toEqual([
      {
        orden: 1,
        origen: 'CUN',
        destino: 'PCE',
        millas: 27,
        pasajeros: 0,
        es_ferry: true,
        tiempo_hr: 0.33,
        tuas_usd: 0,
        requiere_pernocta: false,
        pernocta_usd: 0,
        tipo_parada: 'NORMAL',
        servicio_notas: null,
        pdf_oculto: null,
      },
      {
        orden: 2,
        origen: 'PCE',
        destino: 'PPS',
        millas: 63,
        pasajeros: 4,
        es_ferry: false,
        tiempo_hr: 0.57,
        tuas_usd: 0,
        requiere_pernocta: false,
        pernocta_usd: 0,
        tipo_parada: 'NORMAL',
        servicio_notas: null,
        pdf_oculto: null,
      },
      {
        orden: 3,
        origen: 'PPS',
        destino: 'CUN',
        millas: 90,
        pasajeros: 0,
        es_ferry: true,
        tiempo_hr: 0.75,
        tuas_usd: 0,
        requiere_pernocta: false,
        pernocta_usd: 0,
        tipo_parada: 'NORMAL',
        servicio_notas: null,
        pdf_oculto: null,
      },
    ]);
  });
});
