// Módulos pesados que quotes.service importa solo para inyección (mismo
// patrón que quotes.service.horas.spec.ts).
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
import { tarifaPersistida } from '../../common/tarifa.util';
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
 * TARIFA POR HORA DE 6 DECIMALES EN EL MOTOR (22-sep-2026, cotización #105).
 *
 * La oficina cerró un vuelo de 2.4 hr en $2,375.00 exactos tecleando la
 * tarifa personalizada 989.583333 (= 2,375 ÷ 2.4): el motor multiplicaba con
 * esa precisión (⇒ $2,375.00) pero persistía `round2` (989.58). Al reabrir, el
 * panel y `quickAdjust` rehidrataban ESE número y el total caía a $2,374.99
 * sin que nadie tocara nada. Aquí se congela la regla —la misma del T.C. y de
 * las horas pactadas—: lo que se persiste es EXACTAMENTE lo que se usó para
 * multiplicar, y re-editar no mueve un centavo.
 */
const AVION = 'aaaaaaaa-0000-0000-0000-000000000001';

/** La tarifa que tecleó la oficina en #105 para cerrar 2.4 hr en $2,375.00. */
const TARIFA_105 = 989.583333;

function servicio(): QuotesService {
  const aircraft = {
    findById: jest.fn().mockResolvedValue({
      id: AVION,
      activa: true,
      matricula: 'N990GG',
      modelo: 'Piper Navajo',
      pais_registro: 'US',
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

/**
 * Cotización #105: 2.4 hr cobrables pactadas a mano, tarifa personalizada.
 * Método EFECTIVO para que el total sea el subtotal pelón (sin IVA) y el
 * centavo del defecto se vea sin ruido.
 */
function dto105(
  tarifa: number | null,
  cobrable: number | null = 2.4,
  extra: Partial<CalculateQuoteDto> = {},
): CalculateQuoteDto {
  return {
    aeronave_id: AVION,
    tipo: TipoVuelo.MULTIESCALA,
    escalas: [
      { origen_iata: 'CUN', destino_iata: 'MID', millas_nauticas: 157.5 },
      { origen_iata: 'MID', destino_iata: 'CUN', millas_nauticas: 157.5 },
    ],
    tipo_tarifa: TipoTarifa.PUBLICO,
    pasajeros: 4,
    metodo_pago: MetodoPago.EFECTIVO,
    ...(tarifa != null ? { tarifa_hora_override_usd: tarifa } : {}),
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
        tarifa_hora_usd: number;
        tiempo_cobrable_hr: number;
        subtotal_vuelo_usd: number;
        monto_total_usd: number;
        // El snapshot ES el breakdown (`calculo_snapshot: breakdown`): lo
        // necesita el ciclo de rehidratación, que lee la tarifa de los DOS
        // caminos persistidos igual que `tarifaPersistida` en producción.
        calculo_snapshot: Breakdown;
      };
    }
  ).camposDesdeBreakdown(dto, b, 4);
}

describe('QuotesService.calculate — tarifa con 6 decimales', () => {
  it('#105: 2.4 hr × $989.583333/hr ⇒ subtotal y total $2,375.00', async () => {
    const r = await servicio().calculate(dto105(TARIFA_105));
    expect(r.totales.subtotal_vuelo_usd).toBe(2375);
    expect(r.totales.total_usd).toBe(2375);
  });

  it('persiste EXACTAMENTE la tarifa con la que multiplicó (989.583333)', async () => {
    const svc = servicio();
    const dto = dto105(TARIFA_105);
    const b = await svc.calculate(dto);
    expect(b.tarifa.usd_por_hora).toBe(989.583333);
    expect(b.tarifa.proviene_de_override).toBe(true);
    const campos = persistido(svc, dto, b);
    expect(campos.tarifa_hora_usd).toBe(989.583333);
    // Y lo persistido reproduce el subtotal persistido AL CENTAVO.
    expect(
      Math.round(campos.tiempo_cobrable_hr * campos.tarifa_hora_usd * 100) /
        100,
    ).toBe(campos.subtotal_vuelo_usd);
  });

  it('RE-EDICIÓN: rehidratar lo persistido y recalcular NO mueve el total (el bug de #105)', async () => {
    const svc = servicio();
    const primera = await svc.calculate(dto105(TARIFA_105));
    // Exactamente lo que hace el panel al reabrir: la tarifa sale de lo
    // guardado.
    const segunda = await svc.calculate(dto105(primera.tarifa.usd_por_hora));
    expect(segunda.totales.subtotal_vuelo_usd).toBe(2375);
    expect(segunda.totales.total_usd).toBe(2375);
    expect(segunda.tarifa.usd_por_hora).toBe(primera.tarifa.usd_por_hora);
    // Una tercera vuelta tampoco: el número es un PUNTO FIJO.
    const tercera = await svc.calculate(dto105(segunda.tarifa.usd_por_hora));
    expect(tercera.totales.total_usd).toBe(2375);
  });

  it('con la precisión VIEJA (989.58) el total caía a $2,374.99 — la prueba del defecto', async () => {
    const r = await servicio().calculate(dto105(989.58));
    expect(r.totales.subtotal_vuelo_usd).toBe(2374.99);
    expect(r.totales.total_usd).toBe(2374.99);
  });

  it('una tarifa de CATÁLOGO se persiste igual que siempre (sin decimales de más)', async () => {
    const svc = servicio();
    const dto = dto105(null);
    const b = await svc.calculate(dto);
    expect(b.tarifa.usd_por_hora).toBe(1750);
    expect(b.tarifa.proviene_de_override).toBe(false);
    expect(persistido(svc, dto, b).tarifa_hora_usd).toBe(1750);
  });

  it('el desglose sigue imprimiendo la tarifa a 2 decimales (presentación)', async () => {
    const r = await servicio().calculate(dto105(TARIFA_105));
    const tiempo = r.desglose.find((d) => d.clave === 'TIEMPO_VUELO')!;
    expect(tiempo.concepto).toContain('$989.58/hr');
    expect(tiempo.concepto).not.toContain('989.583333');
    expect(tiempo.monto_usd).toBe(2375);
  });

  it('los DOS factores a la vez: horas de 8 y tarifa de 6 cierran al centavo', async () => {
    const svc = servicio();
    // 2 h 20 min pactadas a una tarifa con decimales.
    const b = await svc.calculate(dto105(857.142857, 2.333333333));
    expect(b.tiempos.cobrable_hr).toBe(2.33333333);
    expect(b.tarifa.usd_por_hora).toBe(857.142857);
    const reeditado = await svc.calculate(
      dto105(b.tarifa.usd_por_hora, b.tiempos.cobrable_hr),
    );
    expect(reeditado.totales.total_usd).toBe(b.totales.total_usd);
    expect(reeditado.totales.subtotal_vuelo_usd).toBe(
      b.totales.subtotal_vuelo_usd,
    );
  });

  it('una tarifa en 0 sin cliente interno SIGUE rebotando 400 (no cambió)', async () => {
    // La tarifa efectiva pasa por `round6` y NO por `normalizarTarifa`
    // precisamente para no confundir «0» con «sin dato»: el 0 llega intacto
    // al candado de siempre. (En un cliente INTERNO ese mismo 0 es legítimo y
    // el motor lo deja pasar; esa rama lee la BD y se cubre en
    // quotes.service.spec.)
    await expect(servicio().calculate(dto105(0))).rejects.toThrow(
      /no tiene tarifa PUBLICO configurada/,
    );
  });

  it('la COMISIÓN del vendedor POR_HORA no tiene este defecto (se congela)', async () => {
    // El motor redondea la tarifa de la comisión a 2 decimales ANTES de
    // multiplicar, así que lo que persiste ES lo que multiplicó: por eso los
    // 6 vuelos con comisión POR_HORA de producción cuadran todos. Si alguien
    // mueve ese orden (multiplicar con la precisión completa y guardar
    // `round2`), reaparece el bug de #105 en la comisión y esta prueba cae.
    const r = await servicio().calculate(
      dto105(TARIFA_105, 2.4, {
        comision_vendedor_modo: 'POR_HORA',
        comision_vendedor_tarifa_hr: 100.987654,
      } as Partial<CalculateQuoteDto>),
    );
    const tarifaComision = r.meta.comision_vendedor_tarifa_hr!;
    expect(tarifaComision).toBe(100.99);
    expect(r.meta.comision_vendedor_usd).toBe(
      Math.round(2.4 * tarifaComision * 100) / 100,
    );
  });
});

describe('anclarRevisionAlPersistido — el ECO TRUNCADO de la tarifa no baja el total', () => {
  type Anclar = (
    dto: CalculateQuoteDto,
    current: Record<string, unknown>,
    opts: { desdeGrupo?: boolean },
  ) => void;

  const anclar = (svc: QuotesService): Anclar =>
    (
      svc as unknown as { anclarRevisionAlPersistido: Anclar }
    ).anclarRevisionAlPersistido.bind(svc);

  /** Fila persistida de #105 ya con los 6 decimales (tras el backfill). */
  function fila105(extra: Record<string, unknown> = {}) {
    return {
      cliente_id: null,
      es_externo: false,
      extras: [],
      tarifa_hora_usd: 989.583333,
      tiempo_cobrable_hr: 2.4,
      calculo_snapshot: {
        tarifa: { usd_por_hora: 989.583333, proviene_de_override: true },
        tiempos: { cobrable_hr: 2.4 },
        meta: {},
      },
      ...extra,
    };
  }

  it('un panel VIEJO que devuelve 989.58 se ancla a 989.583333', () => {
    const svc = servicio();
    const dto = dto105(989.58);
    anclar(svc)(dto, fila105(), {});
    expect(dto.tarifa_hora_override_usd).toBe(989.583333);
  });

  it('una EDICIÓN real de la tarifa se respeta ($990/hr)', () => {
    const svc = servicio();
    const dto = dto105(990);
    anclar(svc)(dto, fila105(), {});
    expect(dto.tarifa_hora_override_usd).toBe(990);
  });

  it('una edición de 1 centavo/hr también se respeta (989.59)', () => {
    const svc = servicio();
    const dto = dto105(989.59);
    anclar(svc)(dto, fila105(), {});
    expect(dto.tarifa_hora_override_usd).toBe(989.59);
  });

  it('AÑADIR precisión sobre una tarifa redonda se respeta (989.58 → 989.5834)', () => {
    const svc = servicio();
    const dto = dto105(989.5834);
    anclar(svc)(
      dto,
      fila105({
        tarifa_hora_usd: 989.58,
        calculo_snapshot: {
          tarifa: { usd_por_hora: 989.58, proviene_de_override: true },
          tiempos: { cobrable_hr: 2.4 },
          meta: {},
        },
      }),
      {},
    );
    expect(dto.tarifa_hora_override_usd).toBe(989.5834);
  });

  it('LA BANDA DEL ECO: 989.5834 sobre 989.583333 SÍ se ancla (6.7e-5 USD/hr)', () => {
    // Documentado a propósito (ver `esEcoDeTarifa`): la regla es «difieren por
    // menos de media unidad del 2.º decimal Y el entrante trae MENOS
    // decimales». 989.5834 cumple las dos, así que se trata como eco. No hay
    // riesgo de dinero: 6.7e-5 USD/hr sobre el tope del DTO (48 hr) son
    // 0.0032 USD — jamás mueve un centavo. Lo mismo vale para cualquier
    // «edición» dentro de medio centavo por hora: ahí no hay intención humana
    // posible y se prefiere que reabrir y guardar no mueva el total.
    const svc = servicio();
    const dto = dto105(989.5834);
    anclar(svc)(dto, fila105(), {});
    expect(dto.tarifa_hora_override_usd).toBe(989.583333);
  });

  it('con el snapshot truncado pero la columna completa, gana la columna', () => {
    const svc = servicio();
    const dto = dto105(989.58);
    anclar(svc)(
      dto,
      fila105({
        calculo_snapshot: {
          tarifa: { usd_por_hora: 989.58, proviene_de_override: true },
          tiempos: { cobrable_hr: 2.4 },
          meta: {},
        },
      }),
      {},
    );
    expect(dto.tarifa_hora_override_usd).toBe(989.583333);
  });

  it('una tarifa de CATÁLOGO persistida no ancla nada (#26, $555.00)', () => {
    const svc = servicio();
    const dto = dto105(555);
    anclar(svc)(
      dto,
      fila105({
        tarifa_hora_usd: 555,
        calculo_snapshot: {
          // `proviene_de_override` viaja en true hasta con tarifas redondas:
          // por eso el anclaje NO se apoya en esa bandera.
          tarifa: { usd_por_hora: 555, proviene_de_override: true },
          tiempos: { cobrable_hr: 3.4273 },
          meta: {},
        },
      }),
      {},
    );
    expect(dto.tarifa_hora_override_usd).toBe(555);
  });

  it('sin tarifa en el DTO no se ancla nada (manda el catálogo)', () => {
    const svc = servicio();
    const dto = dto105(null);
    anclar(svc)(dto, fila105(), {});
    expect(dto.tarifa_hora_override_usd).toBeUndefined();
  });

  it('el eco anclado produce de nuevo $2,375.00', async () => {
    const svc = servicio();
    const dto = dto105(989.58);
    anclar(svc)(dto, fila105(), {});
    const r = await svc.calculate(dto);
    expect(r.totales.subtotal_vuelo_usd).toBe(2375);
    expect(r.totales.total_usd).toBe(2375);
  });

  // ---------------------------------------------------------------------
  // LOS DOS FACTORES A LA VEZ (revisión adversaria 22-sep-2026)
  // ---------------------------------------------------------------------
  // `anclarRevisionAlPersistido` tiene DOS anclas —horas pactadas
  // (invariante 22) y tarifa (23)— y hasta aquí cada una se probaba SOLA:
  // todas las filas de arriba traen `tiempos` SIN
  // `cobrable_proviene_de_override`, así que el ancla de las horas nunca
  // llegaba a dispararse. Un panel viejo devuelve los DOS factores
  // truncados en el MISMO guardado, que es el caso real: hay que ver que no
  // se pisen y que cada una siga respetando la edición del otro campo.
  //
  // Y una nota que vale para quien venga: NO existe un ancla de T.C. Ese
  // factor se resolvió por otro camino (columna `numeric(12,6)` desde el
  // 17-sep + `normalizarTc` en todo escritor), así que `dto.tc_usd_mxn`
  // atraviesa esta función INTACTO. Si algún día hace falta anclarlo, es una
  // pieza NUEVA — no está escondida aquí.
  describe('horas y tarifa truncadas en el MISMO guardado', () => {
    /** Fila persistida con los dos factores completos y los dos pactados. */
    const filaDobles = () =>
      fila105({
        tiempo_cobrable_hr: 2.33333333,
        calculo_snapshot: {
          tarifa: { usd_por_hora: 989.583333, proviene_de_override: true },
          tiempos: {
            cobrable_hr: 2.33333333,
            cobrable_proviene_de_override: true,
          },
          meta: {},
        },
      });

    it('los DOS ecos se anclan y ninguno pisa al otro', () => {
      const svc = servicio();
      const dto = dto105(989.58, 2.3333);
      dto.tc_usd_mxn = 16.9916;
      anclar(svc)(dto, filaDobles(), {});
      expect(dto.tarifa_hora_override_usd).toBe(989.583333);
      expect(dto.tiempo_cobrable_override_hr).toBe(2.33333333);
      // El T.C. NO se ancla: viaja tal cual lo mandó el cliente.
      expect(dto.tc_usd_mxn).toBe(16.9916);
    });

    it('editar la TARIFA de verdad (→990) no arrastra las horas', () => {
      const svc = servicio();
      const dto = dto105(990, 2.3333);
      anclar(svc)(dto, filaDobles(), {});
      expect(dto.tarifa_hora_override_usd).toBe(990);
      expect(dto.tiempo_cobrable_override_hr).toBe(2.33333333);
    });

    it('editar las HORAS de verdad (→3) no arrastra la tarifa', () => {
      const svc = servicio();
      const dto = dto105(989.58, 3);
      anclar(svc)(dto, filaDobles(), {});
      expect(dto.tarifa_hora_override_usd).toBe(989.583333);
      expect(dto.tiempo_cobrable_override_hr).toBe(3);
    });

    it('lo persistido puede llegar como CADENA (numeric de PostgREST)', () => {
      const svc = servicio();
      const dto = dto105(989.58, 2.3333);
      anclar(
        svc,
      )(
        dto,
        fila105({
          tarifa_hora_usd: '989.583333',
          tiempo_cobrable_hr: '2.33333333',
          calculo_snapshot: {
            tarifa: { usd_por_hora: '989.583333', proviene_de_override: true },
            tiempos: {
              cobrable_hr: '2.33333333',
              cobrable_proviene_de_override: true,
            },
            meta: {},
          },
        }),
        {},
      );
      expect(dto.tarifa_hora_override_usd).toBe(989.583333);
      expect(dto.tiempo_cobrable_override_hr).toBe(2.33333333);
    });
  });
});

/**
 * CICLO COMPLETO de #105 contra el motor REAL, con la forma en la que la BD
 * devuelve los números (revisión adversaria 22-sep-2026).
 *
 * Los specs de arriba prueban una vuelta; aquí se prueba que la cotización
 * sea un PUNTO FIJO: persistir en `numeric(14,6)`, leerla como la CADENA con
 * ceros de cola que entrega PostgREST, rehidratar con `tarifaPersistida`,
 * recalcular y volver a persistir, tres veces. Si alguna pieza de la cadena
 * recorta, el subtotal se cae del centavo en la primera vuelta.
 */
describe('#105 · reabrir y guardar N veces no mueve el subtotal', () => {
  /** numeric(14,6) tal como lo devuelve PostgREST: cadena con ceros. */
  const num146 = (v: unknown) => Number(v).toFixed(6);
  /** numeric(10,2): lo que hay HOY, sin la migración 20260922000002. */
  const num102 = (v: unknown) => Number(v).toFixed(2);

  it('con la migración aplicada: 3 vueltas y sigue en $2,375.00 / 989.583333', async () => {
    const svc = servicio();
    const b0 = await svc.calculate(dto105(TARIFA_105));
    expect(b0.totales.subtotal_vuelo_usd).toBe(2375);
    let f = persistido(svc, dto105(TARIFA_105), b0);
    for (let i = 0; i < 3; i++) {
      const rehidratada = tarifaPersistida(
        f.calculo_snapshot.tarifa.usd_por_hora,
        num146(f.tarifa_hora_usd),
      );
      expect(rehidratada).toBe(TARIFA_105);
      const b = await svc.calculate(dto105(rehidratada!));
      expect(b.totales.subtotal_vuelo_usd).toBe(2375);
      f = persistido(svc, dto105(rehidratada!), b);
    }
    expect(num146(f.tarifa_hora_usd)).toBe('989.583333');
  });

  it('SIN la migración (columna en numeric(10,2)) el SNAPSHOT salva el total', async () => {
    const svc = servicio();
    const b0 = await svc.calculate(dto105(TARIFA_105));
    const f = persistido(svc, dto105(TARIFA_105), b0);
    const rehidratada = tarifaPersistida(
      f.calculo_snapshot.tarifa.usd_por_hora,
      num102(f.tarifa_hora_usd), // "989.58"
    );
    expect(rehidratada).toBe(TARIFA_105);
    const b = await svc.calculate(dto105(rehidratada!));
    expect(b.totales.subtotal_vuelo_usd).toBe(2375);
  });

  it('la tarifa de CATÁLOGO rehidrata igual con sus ceros de cola', async () => {
    const svc = servicio();
    const b = await svc.calculate(dto105(null));
    expect(b.tarifa.proviene_de_override).toBe(false);
    const f = persistido(svc, dto105(null), b);
    expect(num146(f.tarifa_hora_usd)).toBe(
      `${Number(f.tarifa_hora_usd).toFixed(6)}`,
    );
    expect(
      tarifaPersistida(
        f.calculo_snapshot.tarifa.usd_por_hora,
        num146(f.tarifa_hora_usd),
      ),
    ).toBe(Number(f.tarifa_hora_usd));
  });
});
