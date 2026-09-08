// Módulos pesados que quotes.service importa solo para inyección (mismo
// patrón que quotes.service.spec.ts): notifications arrastra el gateway y
// `jose`; calendar-sync arrastra googleapis.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { ConflictException } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import {
  MetodoPago,
  TipoTarifa,
  TipoVuelo,
  type CalculateQuoteDto,
} from './dto/calculate-quote.dto';
import type { PreviewQuoteDto } from './dto/preview-quote.dto';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';

/**
 * Rediseño del cotizador (8-sep-2026): vista previa sin persistir (limpia vs
 * sucia), idempotencia de create/revise (client_request_id), candado D3
 * (COTIZACION_COBRADA en cualquier estado salvo CANCELADO), D4 (pdf_fecha
 * en el DTO → replaceEscalas) y D5 (presentación PDF a nivel vuelo sin
 * versión). BD simulada por tabla con bitácora de operaciones: los
 * caminos "sin persistir" se verifican por AUSENCIA de insert/update.
 */

const KODIAK = 'aaaaaaaa-0000-0000-0000-000000000001';
const KEY = '11111111-2222-4333-8444-555555555555';

type Row = Record<string, unknown>;
interface Op {
  tabla: string;
  tipo: 'select' | 'insert' | 'update' | 'delete';
  filtros: Array<[string, string, unknown]>;
  payload?: unknown;
  single: boolean;
}
type Handler = (op: Op) => { data?: unknown; error?: unknown } | undefined;

function supabaseMock(handlers: Record<string, Handler>, log: Op[]) {
  const from = (tabla: string) => {
    const op: Op = { tabla, tipo: 'select', filtros: [], single: false };
    const run = (single: boolean) => {
      op.single = single;
      log.push(op);
      const r = handlers[tabla]?.(op);
      if (r)
        return Promise.resolve({
          data: r.data ?? null,
          error: r.error ?? null,
        });
      // Default: lectura vacía; escritura devuelve lo escrito.
      if (op.tipo === 'select' || op.tipo === 'delete') {
        return Promise.resolve({ data: single ? null : [], error: null });
      }
      return Promise.resolve({
        data: single ? op.payload : [op.payload],
        error: null,
      });
    };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = jest.fn(chain);
    b.insert = jest.fn((p: unknown) => {
      op.tipo = 'insert';
      op.payload = p;
      return b;
    });
    b.update = jest.fn((p: unknown) => {
      op.tipo = 'update';
      op.payload = p;
      return b;
    });
    b.delete = jest.fn(() => {
      op.tipo = 'delete';
      return b;
    });
    for (const f of ['eq', 'is', 'in', 'neq', 'gte', 'lte', 'gt', 'lt']) {
      b[f] = jest.fn((k: string, v: unknown) => {
        op.filtros.push([f, k, v]);
        return b;
      });
    }
    for (const f of ['or', 'order', 'limit', 'range']) b[f] = jest.fn(chain);
    b.maybeSingle = jest.fn(() => run(true));
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      run(false).then(res, rej);
    return b;
  };
  return { service: { from } } as unknown as SupabaseService;
}

const filtro = (op: Op, k: string): unknown =>
  op.filtros.find((f) => f[1] === k)?.[2];

function servicio(
  handlers: Record<string, Handler>,
  log: Op[],
  opts: { aircraftRechaza?: Error } = {},
) {
  const findById = jest.fn().mockImplementation(() =>
    opts.aircraftRechaza
      ? Promise.reject(opts.aircraftRechaza)
      : Promise.resolve({
          id: KODIAK,
          activa: true,
          matricula: 'N621TX',
          modelo: 'Kodiak 100',
          pais_registro: 'US',
          velocidad_crucero_kts: 150,
          tarifa_hora_pub_usd: 1750,
          tarifa_hora_broker_usd: 1650,
        }),
  );
  const aircraft = { findById } as unknown as AircraftService;
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
    anyRequiresPermit: jest.fn().mockResolvedValue(false),
    refreshPermisosDeVuelo: jest.fn().mockResolvedValue(undefined),
  } as unknown as AirportsService;
  const svc = new QuotesService(
    aircraft,
    airports,
    {} as RoutesService,
    supabaseMock(handlers, log),
    {} as CalendarSyncService,
    {} as EmailService,
    {} as NotificationsService,
  );
  return { svc, findById };
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

/** Fila persistida mínima (VUELO_COLS) con snapshot del Kodiak. */
function filaVuelo(extra: Row = {}): Row {
  return {
    id: 'v1',
    folio: 148,
    cliente_id: 'c1',
    aeronave_id: KODIAK,
    estado: 'COTIZADO',
    es_externo: false,
    cotizacion_version: 2,
    cobrado: false,
    facturado: false,
    fecha_vuelo: null,
    fecha_traslado_final: null,
    fecha_solicitud: '2026-09-01T15:00:00.000Z',
    fecha_confirmacion: null,
    notas: 'Notas persistidas',
    pdf_mostrar_tarifa: false,
    pdf_mostrar_itinerario: true,
    itinerario_operativo: false,
    extras: [],
    tc_usd_mxn: null,
    monto_total_usd: 3232.92,
    subtotal_vuelo_usd: 2625,
    tuas_usd: 162,
    iva_usd: 445.92,
    ajuste_final_usd: 0,
    viaticos_pernocta_usd: 0,
    extras_total_usd: 0,
    comision_vendedor_usd: 0,
    calculo_snapshot: {
      aeronave: { id: KODIAK, matricula: 'N621TX', modelo: 'Kodiak 100' },
      tramos: [
        {
          orden: 1,
          origen: 'CUN',
          destino: 'CZA',
          millas: 90,
          tiempo_hr: 0.75,
        },
        {
          orden: 2,
          origen: 'CZA',
          destino: 'CUN',
          millas: 90,
          tiempo_hr: 0.75,
        },
      ],
      desglose: [],
      totales: { total_usd: 3232.92 },
      meta: {},
    },
    ...extra,
  };
}

function escalaViva(orden: number, extra: Row = {}): Row {
  return {
    id: `e${orden}`,
    vuelo_id: 'v1',
    orden,
    origen_iata: orden === 1 ? 'CUN' : 'CZA',
    destino_iata: orden === 1 ? 'CZA' : 'CUN',
    aeronave_id: null,
    millas_nauticas: 90,
    pasajeros: 9,
    es_ferry: false,
    solo_operativa: false,
    pdf_oculto: false,
    pdf_fecha: null,
    requiere_pernocta: false,
    fecha_salida_plan: null,
    taco_salida: null,
    taco_llegada: null,
    cancelada_at: null,
    ...extra,
  };
}

const escrituras = (log: Op[]) =>
  log.filter((o) => o.tipo !== 'select').map((o) => `${o.tipo}:${o.tabla}`);

describe('quoteLikeParaPreview — vista previa sin persistir', () => {
  it('LIMPIA (quote_id + sucio=false): devuelve la fila de findById TAL CUAL, sin motor y sin escribir', async () => {
    const log: Op[] = [];
    const fila = filaVuelo();
    const { svc, findById } = servicio(
      {
        vuelo: () => ({ data: fila }),
        escala: () => ({ data: [escalaViva(1), escalaViva(2)] }),
        aeronave: () => ({
          data: [{ id: KODIAK, matricula: 'N621TX', modelo: 'Kodiak 100' }],
        }),
      },
      log,
    );
    const calc = jest.spyOn(svc, 'calculate');
    const q = await svc.quoteLikeParaPreview({
      quote_id: 'v1',
      sucio: false,
    } as PreviewQuoteDto);
    expect(q.id).toBe('v1');
    expect(q.calculo_snapshot).toBe(fila.calculo_snapshot);
    expect((q.escalas as Row[]).map((e) => e.orden)).toEqual([1, 2]);
    expect(q.modelos_cotizados).toEqual(['Kodiak 100']);
    expect(calc).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
    expect(escrituras(log)).toEqual([]);
  });

  it('sucio=false sin quote_id → 400', async () => {
    const { svc } = servicio({}, []);
    await expect(
      svc.quoteLikeParaPreview({ sucio: false } as PreviewQuoteDto),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('SUCIA de un alta (sin quote_id): corre el motor, arma la fila con el mismo mapeo de create() y las escalas con ojito/fecha de escalas_pdf; nada se escribe', async () => {
    const log: Op[] = [];
    const { svc } = servicio({}, log);
    const inicio = new Date('2026-09-12T13:00:00.000Z');
    const q = await svc.quoteLikeParaPreview({
      ...dtoBase(),
      notas: 'Sujeto a slot',
      fecha_traslado_inicial: inicio,
      pdf_mostrar_tarifa: true,
      escalas_pdf: [{ orden: 2, pdf_oculto: true, pdf_fecha: '2026-09-06' }],
    });
    const snap = q.calculo_snapshot as { totales: { total_usd: number } };
    // Mapeo fila←breakdown (fuente única camposDesdeBreakdown).
    expect(q.monto_total_usd).toBe(3232.92);
    expect(snap.totales.total_usd).toBe(3232.92);
    expect(q.subtotal_vuelo_usd).toBe(2625);
    expect(q.tuas_usd).toBe(162);
    expect(q.tarifa_tipo).toBe('PUBLICO');
    expect(q.metodo_cobro).toBe('TRANSFERENCIA');
    expect(q.pasajeros).toBe(9);
    // Cabecera de un borrador: sin folio, versión 1, fecha de hoy.
    expect(q.id).toBeNull();
    expect(q.folio).toBeNull();
    expect(q.estado).toBe('COTIZADO');
    expect(q.cotizacion_version).toBe(1);
    expect(typeof q.fecha_solicitud).toBe('string');
    expect(q.notas).toBe('Sujeto a slot');
    expect(q.pdf_mostrar_tarifa).toBe(true);
    expect(q.pdf_mostrar_itinerario).toBe(true);
    expect(q.fecha_vuelo).toBe('2026-09-12T13:00:00.000Z');
    expect(q.modelos_cotizados).toEqual(['Kodiak 100']);
    // Escalas en memoria: ojito/fecha explícitos por orden; el resto default.
    const escalas = q.escalas as Row[];
    expect(escalas.map((e) => [e.orden, e.pdf_oculto, e.pdf_fecha])).toEqual([
      [1, false, null],
      [2, true, '2026-09-06'],
    ]);
    // 1er tramo hereda el traslado inicial (regla de replaceEscalas).
    expect(escalas[0].fecha_salida_plan).toBe('2026-09-12T13:00:00.000Z');
    expect(escalas[0].solo_operativa).toBe(false);
    expect(escalas[0].cancelada_at).toBeNull();
    expect(escrituras(log)).toEqual([]);
  });

  it('SUCIA sobre una guardada: ancla el cliente al persistido, conserva la fecha viva no enviada, escalas_pdf manda sobre la viva, avión operativo del tramo 1; nada se escribe', async () => {
    const log: Op[] = [];
    const { svc } = servicio(
      {
        vuelo: () => ({ data: filaVuelo() }),
        escala: () => ({
          data: [
            escalaViva(1, {
              pdf_oculto: true,
              pdf_fecha: '2026-09-05',
              aeronave_id: 'a-operativo',
            }),
            escalaViva(2),
          ],
        }),
        aeronave: () => ({
          data: [{ id: KODIAK, matricula: 'N621TX', modelo: 'Kodiak 100' }],
        }),
        cliente: () => ({ data: { es_interno: false, tarifas: [] } }),
      },
      log,
    );
    const q = await svc.quoteLikeParaPreview({
      ...dtoBase({ cliente_id: 'c-otro' }),
      quote_id: 'v1',
      sucio: true,
      escalas_pdf: [{ orden: 1, pdf_oculto: false }],
    });
    // Cliente anclado (tarifa preferencial con el cliente REAL del vuelo).
    expect(q.cliente_id).toBe('c1');
    const consultaCliente = log.find(
      (o) => o.tabla === 'cliente' && o.tipo === 'select',
    );
    expect(filtro(consultaCliente!, 'id')).toBe('c1');
    expect(q.cotizacion_version).toBe(3);
    expect(q.folio).toBe(148);
    // Notas persistidas cuando el body no las manda.
    expect(q.notas).toBe('Notas persistidas');
    // El avión que quedaría en vuelo.aeronave_id es el OPERATIVO del tramo 1.
    expect(q.aeronave_id).toBe('a-operativo');
    const escalas = q.escalas as Row[];
    expect(escalas.map((e) => [e.orden, e.pdf_oculto, e.pdf_fecha])).toEqual([
      [1, false, '2026-09-05'],
      [2, false, null],
    ]);
    expect(escalas[0].id).toBe('e1');
    expect(escrituras(log)).toEqual([]);
  });
});

describe('client_request_id — idempotencia de create/revise', () => {
  it('create: la misma llave devuelve la cotización YA creada (idempotente:true) sin correr el motor ni insertar', async () => {
    const log: Op[] = [];
    const { svc, findById } = servicio(
      {
        vuelo: (op) =>
          filtro(op, 'client_request_id') === KEY
            ? { data: { id: 'v-existente' } }
            : { data: filaVuelo({ id: 'v-existente' }) },
        escala: () => ({ data: [escalaViva(1), escalaViva(2)] }),
        aeronave: () => ({
          data: [{ id: KODIAK, matricula: 'N621TX', modelo: 'Kodiak 100' }],
        }),
      },
      log,
    );
    const r = await svc.create(
      {
        ...dtoBase({ cliente_id: 'c1' }),
        client_request_id: KEY,
      },
      'u1',
    );
    expect(r.id).toBe('v-existente');
    expect((r as { idempotente?: boolean }).idempotente).toBe(true);
    expect(findById).not.toHaveBeenCalled();
    expect(escrituras(log)).toEqual([]);
  });

  it('revise: la misma llave (versión ya creada) devuelve la cotización vigente sin candados, motor ni versión nueva', async () => {
    const log: Op[] = [];
    const { svc, findById } = servicio(
      {
        vuelo: () => ({ data: filaVuelo({ cobrado: true }) }),
        escala: () => ({ data: [escalaViva(1), escalaViva(2)] }),
        aeronave: () => ({
          data: [{ id: KODIAK, matricula: 'N621TX', modelo: 'Kodiak 100' }],
        }),
        cotizacion_version_history: (op) =>
          filtro(op, 'client_request_id') === KEY
            ? { data: { vuelo_id: 'v1', version: 3 } }
            : undefined,
      },
      log,
    );
    const r = await svc.revise(
      'v1',
      {
        ...dtoBase(),
        motivo: 'reintento',
        client_request_id: KEY,
      },
      'u1',
    );
    expect((r as { idempotente?: boolean }).idempotente).toBe(true);
    expect(r.cotizacion_version).toBe(2);
    expect(findById).not.toHaveBeenCalled();
    expect(escrituras(log)).toEqual([]);
  });

  it('revise: la llave pertenece a OTRA cotización → 409', async () => {
    const { svc } = servicio(
      {
        vuelo: () => ({ data: filaVuelo() }),
        escala: () => ({ data: [] }),
        aeronave: () => ({ data: [] }),
        cotizacion_version_history: () => ({
          data: { vuelo_id: 'v-otro', version: 1 },
        }),
      },
      [],
    );
    await expect(
      svc.revise(
        'v1',
        { ...dtoBase(), motivo: 'x', client_request_id: KEY },
        'u1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('D3 — candado COTIZACION_COBRADA', () => {
  const conCobro: Handler = () => ({
    data: [{ id: 'cob1', monto: 1000, moneda: 'USD', tc_usd_mxn: null }],
  });

  it('COTIZADO con un anticipo (cobrado=false) → 409 estructurado con link a cobros; no corre el motor', async () => {
    const log: Op[] = [];
    const { svc, findById } = servicio(
      {
        vuelo: () => ({ data: filaVuelo({ estado: 'COTIZADO' }) }),
        escala: () => ({ data: [] }),
        aeronave: () => ({ data: [] }),
        cobro_vuelo: conCobro,
      },
      log,
    );
    let err: unknown;
    try {
      await svc.revise('v1', { ...dtoBase(), motivo: 'sube pax' }, 'u1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as Row;
    expect(body.error).toBe('COTIZACION_COBRADA');
    expect(body.details).toMatchObject({
      vuelo_id: 'v1',
      folio: 148,
      estado: 'COTIZADO',
      cobros: 1,
      cobrado_usd: 1000,
      link: '/admin/quotes/v1#cobros-vuelo',
    });
    expect(String(body.message)).toContain('#148');
    expect(findById).not.toHaveBeenCalled();
    expect(escrituras(log)).toEqual([]);
  });

  it('cobro + reembolso que lo anula (neto 0 por cobrosEnUsd): NO bloquea — sigue hasta el motor', async () => {
    const sentinel = new Error('SENTINEL_MOTOR');
    const log: Op[] = [];
    const { svc } = servicio(
      {
        vuelo: () => ({ data: filaVuelo({ estado: 'CONFIRMADO' }) }),
        escala: () => ({ data: [] }),
        aeronave: () => ({ data: [] }),
        cobro_vuelo: () => ({
          data: [
            { id: 'cob1', monto: 1000, moneda: 'USD', tc_usd_mxn: null },
            { id: 'cob2', monto: -1000, moneda: 'USD', tc_usd_mxn: null },
          ],
        }),
      },
      log,
      { aircraftRechaza: sentinel },
    );
    await expect(
      svc.revise('v1', { ...dtoBase(), motivo: 'tras reembolso' }, 'u1'),
    ).rejects.toBe(sentinel);
    expect(log.some((o) => o.tabla === 'cobro_vuelo')).toBe(true);
    expect(escrituras(log)).toEqual([]);
  });

  it('cobro MXN sin TC (no convertible) bloquea aunque el neto USD sea 0: se expone en sin_tc_*', async () => {
    const { svc } = servicio(
      {
        vuelo: () => ({ data: filaVuelo({ tc_usd_mxn: null }) }),
        escala: () => ({ data: [] }),
        aeronave: () => ({ data: [] }),
        cobro_vuelo: () => ({
          data: [{ id: 'cob1', monto: 18000, moneda: 'MXN', tc_usd_mxn: null }],
        }),
      },
      [],
    );
    let err: unknown;
    try {
      await svc.revise('v1', { ...dtoBase(), motivo: 'x' }, 'u1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as Row;
    expect(body.error).toBe('COTIZACION_COBRADA');
    expect(body.details).toMatchObject({
      cobros: 1,
      cobrado_usd: 0,
      sin_tc_count: 1,
      sin_tc_mxn: 18000,
    });
  });

  it('CANCELADO con cobros: el dinero NO bloquea (decisión 1-sep) — sigue hasta el motor', async () => {
    const sentinel = new Error('SENTINEL_MOTOR');
    const log: Op[] = [];
    const { svc } = servicio(
      {
        vuelo: () => ({ data: filaVuelo({ estado: 'CANCELADO' }) }),
        escala: () => ({ data: [] }),
        aeronave: () => ({ data: [] }),
        cobro_vuelo: conCobro,
      },
      log,
      { aircraftRechaza: sentinel },
    );
    await expect(
      svc.revise('v1', { ...dtoBase(), motivo: 'doc' }, 'u1'),
    ).rejects.toBe(sentinel);
    // Ni siquiera consulta los cobros en un cancelado.
    expect(log.some((o) => o.tabla === 'cobro_vuelo')).toBe(false);
  });

  it('CFDI emitida bloquea en cualquier estado (COTIZADO facturado)', async () => {
    const { svc } = servicio(
      {
        vuelo: () => ({ data: filaVuelo({ facturado: true }) }),
        escala: () => ({ data: [] }),
        aeronave: () => ({ data: [] }),
      },
      [],
    );
    await expect(
      svc.revise('v1', { ...dtoBase(), motivo: 'x' }, 'u1'),
    ).rejects.toThrow(/CFDI/);
  });
});

describe('D4 — pdf_fecha por tramo al crear/revisar', () => {
  it('calculate(): la fecha viaja al tramo resuelto solo cuando se manda (undefined = no viajó)', async () => {
    const { svc } = servicio({}, []);
    const r = await svc.calculate(
      dtoBase({
        escalas: [
          {
            origen_iata: 'CUN',
            destino_iata: 'CZA',
            millas_nauticas: 90,
            pdf_fecha: '2026-09-05',
          },
          { origen_iata: 'CZA', destino_iata: 'CUN', millas_nauticas: 90 },
        ],
      }),
    );
    const legs = r.ruta.escalas!;
    expect(legs[0].pdf_fecha).toBe('2026-09-05');
    expect('pdf_fecha' in legs[1]).toBe(false);
    // El precio no cambia por una fecha de presentación.
    expect(r.totales.total_usd).toBe(3232.92);
  });

  it('replaceEscalas: escribe pdf_fecha solo cuando viaja (string o null); ausente conserva la viva', async () => {
    const log: Op[] = [];
    const { svc } = servicio(
      {
        vuelo: () => ({
          data: { itinerario_operativo: false, estado: 'COTIZADO' },
        }),
        escala: (op) =>
          op.tipo === 'select'
            ? {
                data: [1, 2, 3].map((o) => ({
                  id: `e${o}`,
                  orden: o,
                  taco_salida: null,
                  taco_llegada: null,
                  fecha_salida_plan: null,
                  piloto_id: null,
                  cancelada_at: null,
                  origen_iata: 'CUN',
                  destino_iata: 'CZA',
                })),
              }
            : undefined,
      },
      log,
    );
    const leg = (extra: Row) => ({
      origen_iata: 'CUN',
      destino_iata: 'CZA',
      millas_nauticas: 90,
      pasajeros: 9,
      pasajeros_nombres: [],
      es_ferry: false,
      requiere_pernocta: false,
      pernocta_costo_usd: 0,
      tipo_parada: 'NORMAL',
      servicio_notas: null,
      notas: null,
      fecha_salida_plan: null,
      pdf_oculto: null,
      ...extra,
    });
    await (
      svc as unknown as {
        replaceEscalas: (
          v: string,
          legs: unknown[],
          u: string,
          f?: unknown,
        ) => Promise<void>;
      }
    ).replaceEscalas(
      'v1',
      [leg({ pdf_fecha: '2026-09-05' }), leg({}), leg({ pdf_fecha: null })],
      'u1',
    );
    const updates = log.filter(
      (o) => o.tabla === 'escala' && o.tipo === 'update',
    );
    expect(updates).toHaveLength(3);
    const patch = (i: number) => updates[i].payload as Row;
    expect(patch(0).pdf_fecha).toBe('2026-09-05');
    expect('pdf_fecha' in patch(1)).toBe(false);
    expect('pdf_fecha' in patch(2)).toBe(true);
    expect(patch(2).pdf_fecha).toBeNull();
    // pdf_oculto null tampoco viaja (regla 1-sep intacta).
    expect('pdf_oculto' in patch(0)).toBe(false);
  });
});

describe('D5 — presentación PDF a nivel vuelo sin versión', () => {
  it('PATCH por escala con notas + toggle: toca solo vuelo (no la escala), sin historial; devuelve el bloque vuelo', async () => {
    const log: Op[] = [];
    const { svc } = servicio(
      {
        escala: () => ({
          data: {
            id: 'e1',
            orden: 1,
            vuelo_id: 'v1',
            pdf_oculto: true,
            pdf_fecha: '2026-09-05',
          },
        }),
        vuelo: (op) =>
          op.tipo === 'select'
            ? {
                data: {
                  id: 'v1',
                  notas: null,
                  pdf_mostrar_tarifa: false,
                  pdf_mostrar_itinerario: true,
                },
              }
            : undefined,
      },
      log,
    );
    const r = await svc.setPdfVisibilidad(
      'v1',
      'e1',
      { notas: 'Incluye handler', pdf_mostrar_tarifa: true },
      'u1',
    );
    expect(r).toEqual({
      id: 'e1',
      orden: 1,
      pdf_oculto: true,
      pdf_fecha: '2026-09-05',
      vuelo: {
        id: 'v1',
        notas: 'Incluye handler',
        pdf_mostrar_tarifa: true,
        pdf_mostrar_itinerario: true,
      },
    });
    expect(escrituras(log)).toEqual(['update:vuelo']);
    const patch = log.find((o) => o.tipo === 'update')!.payload as Row;
    expect(patch).toEqual({
      updated_by: 'u1',
      notas: 'Incluye handler',
      pdf_mostrar_tarifa: true,
    });
    expect(patch).not.toHaveProperty('cotizacion_version');
    expect(patch).not.toHaveProperty('calculo_snapshot');
  });

  it('PATCH nivel vuelo: notas vacías = null; body vacío = 400', async () => {
    const log: Op[] = [];
    const { svc } = servicio(
      {
        vuelo: (op) =>
          op.tipo === 'select'
            ? {
                data: {
                  id: 'v1',
                  notas: 'vieja',
                  pdf_mostrar_tarifa: true,
                  pdf_mostrar_itinerario: false,
                },
              }
            : undefined,
      },
      log,
    );
    const r = await svc.setPdfPresentacionVuelo('v1', { notas: '   ' }, 'u1');
    expect(r).toEqual({
      id: 'v1',
      notas: null,
      pdf_mostrar_tarifa: true,
      pdf_mostrar_itinerario: false,
    });
    expect(
      (log.find((o) => o.tipo === 'update')!.payload as Row).notas,
    ).toBeNull();
    await expect(
      svc.setPdfPresentacionVuelo('v1', {}, 'u1'),
    ).rejects.toMatchObject({ status: 400 });
  });
});
