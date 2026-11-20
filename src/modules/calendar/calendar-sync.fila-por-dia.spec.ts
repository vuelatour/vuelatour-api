// UNA FILA POR DÍA en los vuelos de varios días (17-nov-2026, vuelo #478).
//
// Reporte de la oficina: «En el calendario [de Google], por ser un vuelo de
// dos días no sé por qué lo manda a la barrita de arriba […] estaría bien que
// se mostrara normal». Google sube a la franja de «todo el día» cualquier
// evento de 24 h o más, y la fila única del #478 iba del 18-nov 10:00 al
// 19-nov 13:00.
//
// Google y Supabase están MOCKEADOS **CON ESTADO**: este spec no toca la red
// ni la BD. El Google falso guarda «lo que hay en el calendario» (inserta con
// id nuevo, responde 404 al actualizar o borrar lo que no existe) y la base
// falsa aplica cada UPDATE a sus filas. Así cada caso se juzga por el
// RESULTADO —qué filas ve el mecánico y qué id guarda cada columna— y no solo
// por cuántas llamadas hubo. La regla que este módulo no puede romper se
// revisa al final de CADA pasada (`espejoSano`):
//   * ningún evento vivo en Google sin una columna que lo apunte (fantasma);
//   * ninguna columna apuntando a un evento que ya no existe;
//   * nunca dos filas del mismo vuelo el mismo día;
//   * toda fila de un vuelo de varios días dura menos de 24 h.
jest.mock('googleapis', () => ({
  google: { calendar: () => calendarioFake() },
}));
jest.mock('google-auth-library', () => ({
  JWT: class {
    constructor(public readonly opts: unknown) {}
  },
}));
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import { Logger } from '@nestjs/common';
import { CalendarSyncService } from './calendar-sync.service';
import { diaCancunDe } from './google-evento.util';
import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import type { SupabaseService } from '../supabase/supabase.service';

/** Forma (parcial) del evento que se le manda a Google. */
type CuerpoEvento = {
  summary?: string;
  description?: string;
  colorId?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
};

const gaxios = (status: number, msg: string) =>
  Object.assign(new Error(msg), { code: status, response: { status } });

// ===== GOOGLE FALSO, CON ESTADO =====

const google = {
  /** Lo que HAY en el calendario: id → cuerpo del evento. */
  eventos: new Map<string, CuerpoEvento>(),
  consecutivo: 0,
  /** Escrituras a Google en orden: «insert ev-2», «update ev-1», «delete ev-2». */
  bitacora: [] as string[],
  /** Devuelven un error para que ESA llamada falle (y no cambie nada). */
  fallaInsert: null as null | ((cuerpo: CuerpoEvento) => Error | null),
  fallaUpdate: null as null | ((id: string) => Error | null),
  fallaDelete: null as null | ((id: string) => Error | null),
};

const eventosGoogle = {
  insert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};
function calendarioFake() {
  return { events: eventosGoogle };
}

function prenderGoogle(): void {
  google.eventos.clear();
  google.consecutivo = 0;
  google.bitacora = [];
  google.fallaInsert = null;
  google.fallaUpdate = null;
  google.fallaDelete = null;
  eventosGoogle.insert.mockImplementation(
    ({ requestBody }: { requestBody: CuerpoEvento }) => {
      const err = google.fallaInsert?.(requestBody) ?? null;
      if (err) return Promise.reject(err);
      const id = `ev-${++google.consecutivo}`;
      google.eventos.set(id, requestBody);
      google.bitacora.push(`insert ${id}`);
      return Promise.resolve({ data: { id } });
    },
  );
  eventosGoogle.update.mockImplementation(
    ({
      eventId,
      requestBody,
    }: {
      eventId: string;
      requestBody: CuerpoEvento;
    }) => {
      const err = google.fallaUpdate?.(eventId) ?? null;
      if (err) return Promise.reject(err);
      // Lo borraron a mano en Google: 404, como la API real.
      if (!google.eventos.has(eventId))
        return Promise.reject(gaxios(404, 'Not Found'));
      google.eventos.set(eventId, requestBody);
      google.bitacora.push(`update ${eventId}`);
      return Promise.resolve({ data: { id: eventId } });
    },
  );
  eventosGoogle.delete.mockImplementation(
    ({ eventId }: { eventId: string }) => {
      const err = google.fallaDelete?.(eventId) ?? null;
      if (err) return Promise.reject(err);
      if (!google.eventos.has(eventId))
        return Promise.reject(gaxios(404, 'Not Found'));
      google.eventos.delete(eventId);
      google.bitacora.push(`delete ${eventId}`);
      return Promise.resolve({});
    },
  );
}

// ===== BASE FALSA, CON ESTADO =====

type Fila = Record<string, unknown>;

interface Bd {
  vuelo: Fila;
  escalas: Fila[];
  /** UPDATEs aplicados, en orden. */
  escrituras: Array<{ tabla: string; id: string; payload: Fila }>;
  /** Devuelve un mensaje para que ESA escritura falle (y no se aplique). */
  fallaEscritura:
    | null
    | ((tabla: string, id: string, payload: Fila) => string | null);
}

function armarSupabase(bd: Bd) {
  const from = (tabla: string) => {
    let payload: Fila | null = null;
    const eq: Record<string, unknown> = {};
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.not = () => api;
    api.update = (p: Fila) => {
      payload = p;
      return api;
    };
    api.eq = (col: string, valor: unknown) => {
      eq[col] = valor;
      return api;
    };
    const resolver = (): {
      data: unknown;
      error: null | { message: string };
    } => {
      if (payload) {
        const id = String(eq.id);
        const motivo = bd.fallaEscritura?.(tabla, id, payload) ?? null;
        if (motivo) return { data: null, error: { message: motivo } };
        bd.escrituras.push({ tabla, id, payload });
        const fila =
          tabla === 'vuelo'
            ? bd.vuelo.id === id
              ? bd.vuelo
              : null
            : (bd.escalas.find((e) => e.id === id) ?? null);
        if (fila) Object.assign(fila, payload);
        // `returning id`: las filas que el UPDATE de verdad tocó (ninguna si
        // la fila ya no existe — y eso NO es un error para la base).
        return { data: fila ? [{ id }] : [], error: null };
      }
      if (tabla === 'vuelo') {
        if (bd.vuelo.id !== eq.id) return { data: null, error: null };
        // COPIA: lo que el servicio le cambie a la fila en memoria no es un
        // UPDATE. La base solo cambia con un UPDATE de verdad.
        return {
          data: structuredClone({ ...bd.vuelo, escalas: bd.escalas }),
          error: null,
        };
      }
      if (tabla === 'escala') {
        // `removeFlight`: tramos del vuelo con un id de Google guardado.
        return {
          data: structuredClone(
            bd.escalas.filter(
              (e) => e.vuelo_id === eq.vuelo_id && e.google_calendar_id != null,
            ),
          ),
          error: null,
        };
      }
      return { data: null, error: null };
    };
    api.maybeSingle = () => Promise.resolve(resolver());
    api.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(resolver()).then(resolve, reject);
    return api;
  };
  return { from };
}

function armar(bd: Bd) {
  const valores: Record<string, unknown> = {
    GOOGLE_CALENDAR_SYNC_ENABLED: true,
    GOOGLE_CALENDAR_ID: 'aerochartercancunflightplanner@gmail.com',
    GOOGLE_SERVICE_ACCOUNT_JSON:
      '{"client_email":"sa@vuelatour.iam.gserviceaccount.com","private_key":"k"}',
  };
  const config = {
    get: (k: string) => valores[k],
  } as unknown as ConfigService<EnvVars, true>;
  const service = new CalendarSyncService(config, {
    service: armarSupabase(bd),
  } as unknown as SupabaseService);
  service.onModuleInit();
  return service;
}

// ===== EL VUELO #478 (datos reales del reporte) =====

const V = '47800000-0000-4000-8000-000000000478';
const N621TX = { matricula: 'N621TX', color_calendario: '#3B82F6' };
const ALEJANDRO = { nombre: 'Alejandro Canales', apodo: null };

// Horas de Cancún (UTC−5): 10:00 = 15:00Z, 12:00 = 17:00Z.
const D18_1000 = '2026-11-18T15:00:00.000Z';
const D18_1200 = '2026-11-18T17:00:00.000Z';
const D19_1000 = '2026-11-19T15:00:00.000Z';
const D19_1200 = '2026-11-19T17:00:00.000Z';

const tramo = (
  orden: number,
  origen: string,
  destino: string,
  salida: string | null,
  pasajeros: number,
  extra: Fila = {},
): Fila => ({
  id: `e-${orden}`,
  vuelo_id: V,
  orden,
  origen_iata: origen,
  destino_iata: destino,
  fecha_salida_plan: salida,
  es_ferry: false,
  pasajeros,
  tipo_parada: 'NORMAL',
  google_calendar_id: null,
  aeronave_id: 'a-621',
  piloto_id: 'p-ale',
  estado_permiso: null,
  cancelada_at: null,
  aeronave: N621TX,
  piloto: ALEJANDRO,
  ...extra,
});

/** El #478 tal como está en prod: 4 tramos, dos el 18-nov y dos el 19-nov. */
const bd478 = (cambiosVuelo: Fila = {}): Bd => ({
  vuelo: {
    id: V,
    folio: 478,
    estado: 'CONFIRMADO',
    es_externo: false,
    operador_externo: null,
    avion_externo_matricula: null,
    origen_iata: 'CUN',
    destino_iata: 'MHL',
    pasajeros: 5,
    monto_total_usd: '5800',
    cobrado: false,
    fecha_vuelo: D18_1000,
    fecha_traslado_final: null,
    tipo: 'MULTIESCALA',
    notas: null,
    estado_permiso: null,
    aeronave_id: 'a-621',
    piloto_id: 'p-ale',
    google_calendar_id: null,
    google_calendar_regreso_id: null,
    aeronave: N621TX,
    piloto: ALEJANDRO,
    cliente: { nombre: 'Hernan Garza' },
    ...cambiosVuelo,
  },
  escalas: [
    tramo(1, 'CUN', 'CTM', D18_1000, 3),
    tramo(2, 'CTM', 'MHL', D18_1200, 5),
    tramo(3, 'MHL', 'CTM', D19_1000, 3),
    tramo(4, 'CTM', 'CUN', D19_1200, 1),
  ],
  escrituras: [],
  fallaEscritura: null,
});

const escala = (bd: Bd, id: string): Fila => {
  const e = bd.escalas.find((x) => x.id === id);
  if (!e) throw new Error(`el caso no tiene el tramo ${id}`);
  return e;
};

const sincronizar = (service: CalendarSyncService): Promise<boolean> =>
  service.syncFlight(V, { directo: true });

/** Las filas que ve el mecánico, en orden: título, ventana y etiqueta. */
const filasEnGoogle = () =>
  [...google.eventos.entries()]
    .map(([id, e]) => ({
      id,
      titulo: e.summary,
      inicio: e.start?.dateTime,
      fin: e.end?.dateTime,
      etiqueta: e.extendedProperties?.private?.vuelatour_tramo,
    }))
    .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));

const titulos = (): Array<string | undefined> =>
  filasEnGoogle().map((f) => f.titulo);

/** Lo mismo SIN el id de Google (para comparar dos calendarios). */
const filasSinId = () =>
  filasEnGoogle().map((f) => ({
    titulo: f.titulo,
    inicio: f.inicio,
    fin: f.fin,
    etiqueta: f.etiqueta,
  }));

/** Los ids de Google que la base tiene guardados, columna por columna. */
const idsGuardados = (bd: Bd) => {
  const tramos: Record<string, unknown> = {};
  for (const e of bd.escalas) {
    if (e.google_calendar_id != null)
      tramos[String(e.id)] = e.google_calendar_id;
  }
  return {
    vuelo: bd.vuelo.google_calendar_id,
    regreso: bd.vuelo.google_calendar_regreso_id,
    tramos,
  };
};

/**
 * LA REGLA DEL MÓDULO. `variosDias: false` solo afloja el tope de 24 h (la
 * fila única de un vuelo de un día conserva su ventana de siempre).
 */
function espejoSano(bd: Bd, opts: { variosDias?: boolean } = {}): void {
  const guardados = [
    bd.vuelo.google_calendar_id,
    bd.vuelo.google_calendar_regreso_id,
    ...bd.escalas.map((e) => e.google_calendar_id),
  ]
    .filter((id): id is string => typeof id === 'string')
    .sort();
  // Ni fantasmas (evento sin columna) ni columnas apuntando a nada.
  expect([...google.eventos.keys()].sort()).toEqual(guardados);
  // Un id no vive en dos columnas.
  expect(new Set(guardados).size).toBe(guardados.length);
  // Nunca dos filas el mismo día.
  const dias = [...google.eventos.values()].map((e) =>
    diaCancunDe(e.start?.dateTime),
  );
  expect(new Set(dias).size).toBe(dias.length);
  for (const e of google.eventos.values()) {
    // Todas llevan el ancla del vuelo (el paso inverso las reconoce).
    expect(e.extendedProperties?.private?.vuelatour_vuelo_id).toBe(V);
    if (opts.variosDias === false) continue;
    const dura =
      Date.parse(String(e.end?.dateTime)) -
      Date.parse(String(e.start?.dateTime));
    expect(dura).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(dura).toBeLessThan(24 * 60 * 60 * 1000);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  prenderGoogle();
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ===== EL CASO DEL REPORTE =====

describe('vuelo de varios días — el #478 real', () => {
  it('dos filas, cada una en su hora: 18-nov y 19-nov de 10:00 a 13:00', async () => {
    const bd = bd478();
    const service = armar(bd);

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(filasEnGoogle()).toEqual([
      {
        id: 'ev-1',
        titulo: 'Alejandro N621TX cun-ctm-mhl 10:00',
        inicio: '2026-11-18T15:00:00.000Z', // 18-nov 10:00 Cancún
        fin: '2026-11-18T18:00:00.000Z', // 18-nov 13:00 Cancún
        etiqueta: 'vuelo',
      },
      {
        id: 'ev-2',
        titulo: 'Alejandro N621TX mhl-ctm-cun 10:00',
        inicio: '2026-11-19T15:00:00.000Z', // 19-nov 10:00 Cancún
        fin: '2026-11-19T18:00:00.000Z', // 19-nov 13:00 Cancún
        etiqueta: 'dia-2',
      },
    ]);
    // Día 1 ⇒ la columna del vuelo; día 2 ⇒ su PRIMER tramo activo (T3).
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: { 'e-3': 'ev-2' },
    });
    espejoSano(bd);
  });

  it('la descripción lleva el vuelo COMPLETO y, primero, qué día es la fila', async () => {
    const bd = bd478();
    await sincronizar(armar(bd));

    const vueloCompleto = [
      'Folio: #478',
      'Estado: CONFIRMADO',
      'Cliente: Hernan Garza',
      'Aeronave: N621TX',
      'Piloto: Alejandro Canales',
      'T1 cun-ctm 10:00 · 3 pax',
      'T2 ctm-mhl 12:00 · 5 pax',
      'T3 mhl-ctm 10:00 · 3 pax',
      'T4 ctm-cun 12:00 · 1 pax',
      'Monto: $5800 USD',
      '',
      `VuelaTour · vuelo ${V}`,
    ];
    expect(String(google.eventos.get('ev-1')?.description).split('\n')).toEqual(
      ['Día 1 de 2 · miércoles 18/11/2026 · tramos T1 y T2', ...vueloCompleto],
    );
    expect(String(google.eventos.get('ev-2')?.description).split('\n')).toEqual(
      ['Día 2 de 2 · jueves 19/11/2026 · tramos T3 y T4', ...vueloCompleto],
    );
  });

  it('cada fila es un evento con hora (no de día completo), en hora de Cancún y con el color del vuelo', async () => {
    const bd = bd478();
    await sincronizar(armar(bd));

    for (const e of google.eventos.values()) {
      expect(e.start).toEqual({
        dateTime: expect.any(String) as string,
        timeZone: 'America/Cancun',
      });
      expect(e.end).toEqual({
        dateTime: expect.any(String) as string,
        timeZone: 'America/Cancun',
      });
      // CONFIRMADO, con avión y piloto, sin permiso pendiente ⇒ verde (2).
      expect(e.colorId).toBe('2');
    }
  });

  it('guarda SOLO la columna del id (sin eso, el trigger de updated_at y el de la cola se dispararían)', async () => {
    const bd = bd478();
    await sincronizar(armar(bd));

    expect(bd.escrituras).toEqual([
      { tabla: 'vuelo', id: V, payload: { google_calendar_id: 'ev-1' } },
      { tabla: 'escala', id: 'e-3', payload: { google_calendar_id: 'ev-2' } },
    ]);
  });

  it('YA publicado como barra de 27 h (antes del deploy): el evento del día 1 se ACTUALIZA —se acorta y se retitula—, no se borra para volver a crearlo', async () => {
    const bd = bd478({ google_calendar_id: 'ev-de-siempre' });
    google.eventos.set('ev-de-siempre', {
      summary: 'Alejandro N621TX cun-ctm-mhl-ctm-cun 10:00',
      start: { dateTime: D18_1000 },
      end: { dateTime: '2026-11-19T18:00:00.000Z' },
    });

    await expect(sincronizar(armar(bd))).resolves.toBe(true);

    expect(google.bitacora).toEqual(['update ev-de-siempre', 'insert ev-1']);
    expect(eventosGoogle.delete).not.toHaveBeenCalled();
    expect(filasEnGoogle().map((f) => [f.id, f.titulo, f.fin])).toEqual([
      [
        'ev-de-siempre',
        'Alejandro N621TX cun-ctm-mhl 10:00',
        '2026-11-18T18:00:00.000Z',
      ],
      [
        'ev-1',
        'Alejandro N621TX mhl-ctm-cun 10:00',
        '2026-11-19T18:00:00.000Z',
      ],
    ]);
    // El id del vuelo no cambió ⇒ esa columna NO se reescribe.
    expect(bd.escrituras).toEqual([
      { tabla: 'escala', id: 'e-3', payload: { google_calendar_id: 'ev-1' } },
    ]);
    espejoSano(bd);
  });

  it('dos pasadas seguidas: la segunda no crea, no borra y no escribe NADA en la base', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    const antes = structuredClone(filasEnGoogle());
    bd.escrituras = [];
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    // Solo re-publica cada fila sobre SU evento.
    expect(google.bitacora).toEqual(['update ev-1', 'update ev-2']);
    expect(bd.escrituras).toEqual([]);
    expect(filasEnGoogle()).toEqual(antes);
    espejoSano(bd);
  });
});

// ===== EL VUELO DE UN DÍA NO CAMBIA =====

describe('vuelo de UN día — exactamente como siempre (15-sep-2026)', () => {
  /** El mismo vuelo con sus cuatro tramos el 18-nov (10:00, 12:00, 15:00, 17:00). */
  const bdUnDia = (cambiosVuelo: Fila = {}): Bd => {
    const bd = bd478(cambiosVuelo);
    escala(bd, 'e-3').fecha_salida_plan = '2026-11-18T20:00:00.000Z';
    escala(bd, 'e-4').fecha_salida_plan = '2026-11-18T22:00:00.000Z';
    return bd;
  };

  it('UNA fila con el cuerpo de siempre, en la columna de siempre y sin una escritura de más', async () => {
    const bd = bdUnDia();

    await expect(sincronizar(armar(bd))).resolves.toBe(true);

    expect(google.bitacora).toEqual(['insert ev-1']);
    // El cuerpo COMPLETO que hoy sale para este vuelo, campo por campo.
    expect(google.eventos.get('ev-1')).toEqual({
      summary: 'Alejandro N621TX cun-ctm-mhl-ctm-cun 10:00',
      description: [
        'Folio: #478',
        'Estado: CONFIRMADO',
        'Cliente: Hernan Garza',
        'Aeronave: N621TX',
        'Piloto: Alejandro Canales',
        'T1 cun-ctm 10:00 · 3 pax',
        'T2 ctm-mhl 12:00 · 5 pax',
        'T3 mhl-ctm 15:00 · 3 pax',
        'T4 ctm-cun 17:00 · 1 pax',
        'Monto: $5800 USD',
        '',
        `VuelaTour · vuelo ${V}`,
      ].join('\n'),
      colorId: '2',
      start: { dateTime: D18_1000, timeZone: 'America/Cancun' },
      // Última salida (17:00) + 1 h = 18:00 Cancún.
      end: { dateTime: '2026-11-18T23:00:00.000Z', timeZone: 'America/Cancun' },
      extendedProperties: {
        private: { vuelatour_vuelo_id: V, vuelatour_tramo: 'vuelo' },
      },
    });
    expect(bd.escrituras).toEqual([
      { tabla: 'vuelo', id: V, payload: { google_calendar_id: 'ev-1' } },
    ]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: {},
    });
    espejoSano(bd, { variosDias: false });
  });

  it('tramos de UN día con `fecha_traslado_final` en otro: sigue siendo la fila única de siempre (la regla mira las SALIDAS)', async () => {
    const bd = bdUnDia({ fecha_traslado_final: '2026-11-19T20:00:00.000Z' });

    await sincronizar(armar(bd));

    expect(filasEnGoogle()).toEqual([
      {
        id: 'ev-1',
        titulo: 'Alejandro N621TX cun-ctm-mhl-ctm-cun 10:00',
        inicio: D18_1000,
        fin: '2026-11-19T21:00:00.000Z',
        etiqueta: 'vuelo',
      },
    ]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: {},
    });
  });
});

// ===== CUÁNTOS DÍAS =====

describe('vuelo de varios días — qué días llevan fila', () => {
  it('tres días con salidas: tres filas, y los días 2 y 3 anclados en su primer tramo', async () => {
    const bd = bd478();
    bd.escalas.push(
      tramo(5, 'CUN', 'CZM', '2026-11-20T14:00:00.000Z', 2),
      tramo(6, 'CZM', 'CUN', '2026-11-20T21:30:00.000Z', 2),
    );

    await expect(sincronizar(armar(bd))).resolves.toBe(true);

    expect(
      filasEnGoogle().map((f) => [f.titulo, f.inicio, f.fin, f.etiqueta]),
    ).toEqual([
      [
        'Alejandro N621TX cun-ctm-mhl 10:00',
        '2026-11-18T15:00:00.000Z',
        '2026-11-18T18:00:00.000Z',
        'vuelo',
      ],
      [
        'Alejandro N621TX mhl-ctm-cun 10:00',
        '2026-11-19T15:00:00.000Z',
        '2026-11-19T18:00:00.000Z',
        'dia-2',
      ],
      [
        'Alejandro N621TX cun-czm-cun 9:00',
        '2026-11-20T14:00:00.000Z',
        '2026-11-20T22:30:00.000Z',
        'dia-3',
      ],
    ]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: { 'e-3': 'ev-2', 'e-5': 'ev-3' },
    });
    expect(String(google.eventos.get('ev-3')?.description).split('\n')[0]).toBe(
      'Día 3 de 3 · viernes 20/11/2026 · tramos T5 y T6',
    );
    espejoSano(bd);
  });

  it('un día INTERMEDIO sin salidas no lleva fila: 18 y 20 ⇒ dos filas y nada el 19', async () => {
    const bd = bd478();
    escala(bd, 'e-3').fecha_salida_plan = '2026-11-20T15:00:00.000Z';
    escala(bd, 'e-4').fecha_salida_plan = '2026-11-20T17:00:00.000Z';

    await sincronizar(armar(bd));

    expect(filasEnGoogle().map((f) => [f.titulo, f.inicio])).toEqual([
      ['Alejandro N621TX cun-ctm-mhl 10:00', '2026-11-18T15:00:00.000Z'],
      ['Alejandro N621TX mhl-ctm-cun 10:00', '2026-11-20T15:00:00.000Z'],
    ]);
    // «Día 2 de 2» cuenta los días CON salidas; la fecha va completa.
    expect(String(google.eventos.get('ev-2')?.description).split('\n')[0]).toBe(
      'Día 2 de 2 · viernes 20/11/2026 · tramos T3 y T4',
    );
    espejoSano(bd);
  });

  it('tramo SIN fecha: va con el día del tramo anterior (en la ruta y en la línea del día) y nunca abre una fila', async () => {
    const bd = bd478();
    // T2 sin fecha (intermedio) y T4 sin fecha (último, sin traslado final).
    escala(bd, 'e-2').fecha_salida_plan = null;
    escala(bd, 'e-4').fecha_salida_plan = null;

    await sincronizar(armar(bd));

    expect(filasEnGoogle().map((f) => [f.titulo, f.inicio, f.fin])).toEqual([
      [
        'Alejandro N621TX cun-ctm-mhl 10:00',
        '2026-11-18T15:00:00.000Z',
        '2026-11-18T16:00:00.000Z',
      ],
      [
        'Alejandro N621TX mhl-ctm-cun 10:00',
        '2026-11-19T15:00:00.000Z',
        '2026-11-19T16:00:00.000Z',
      ],
    ]);
    const lineas = String(google.eventos.get('ev-2')?.description).split('\n');
    expect(lineas[0]).toBe('Día 2 de 2 · jueves 19/11/2026 · tramos T3 y T4');
    // La línea del tramo sin hora sale como siempre: sin hora.
    expect(lineas).toContain('T4 ctm-cun · 1 pax');
    espejoSano(bd);
  });

  it('el ÚLTIMO tramo sin fecha hereda `fecha_traslado_final` (como siempre) y por eso abre SU día', async () => {
    const bd = bd478({ fecha_traslado_final: '2026-11-20T16:00:00.000Z' });
    escala(bd, 'e-4').fecha_salida_plan = null;

    await sincronizar(armar(bd));

    expect(filasEnGoogle().map((f) => [f.titulo, f.inicio, f.fin])).toEqual([
      [
        'Alejandro N621TX cun-ctm-mhl 10:00',
        '2026-11-18T15:00:00.000Z',
        '2026-11-18T18:00:00.000Z',
      ],
      [
        'Alejandro N621TX mhl-ctm 10:00',
        '2026-11-19T15:00:00.000Z',
        '2026-11-19T16:00:00.000Z',
      ],
      [
        'Alejandro N621TX ctm-cun 11:00',
        '2026-11-20T16:00:00.000Z',
        '2026-11-20T17:00:00.000Z',
      ],
    ]);
    expect(idsGuardados(bd).tramos).toEqual({ 'e-3': 'ev-2', 'e-4': 'ev-3' });
    espejoSano(bd);
  });

  it('`fecha_traslado_final` solo estira la fila del día en que cae', async () => {
    // 19-nov 16:00 Cancún: es del día 2, no del día 1.
    const bd = bd478({ fecha_traslado_final: '2026-11-19T21:00:00.000Z' });

    await sincronizar(armar(bd));

    expect(filasEnGoogle().map((f) => [f.inicio, f.fin])).toEqual([
      ['2026-11-18T15:00:00.000Z', '2026-11-18T18:00:00.000Z'],
      ['2026-11-19T15:00:00.000Z', '2026-11-19T22:00:00.000Z'],
    ]);
    espejoSano(bd);
  });
});

// ===== CAMBIOS DEL VUELO =====

describe('vuelo de varios días — el vuelo cambia', () => {
  it('pasa de 2 días a 1: se BORRA la fila del día 2 y su id, y la del día 1 vuelve a ser la fila única', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    // La oficina mueve el regreso al mismo 18-nov (15:00 y 17:00).
    escala(bd, 'e-3').fecha_salida_plan = '2026-11-18T20:00:00.000Z';
    escala(bd, 'e-4').fecha_salida_plan = '2026-11-18T22:00:00.000Z';
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    // Primero sale lo que sobra; después se actualiza la fila del vuelo.
    expect(google.bitacora).toEqual(['delete ev-2', 'update ev-1']);
    expect(filasEnGoogle()).toEqual([
      {
        id: 'ev-1',
        titulo: 'Alejandro N621TX cun-ctm-mhl-ctm-cun 10:00',
        inicio: D18_1000,
        fin: '2026-11-18T23:00:00.000Z',
        etiqueta: 'vuelo',
      },
    ]);
    // Sin la línea «Día N de M»: es otra vez la descripción de siempre.
    expect(String(google.eventos.get('ev-1')?.description).split('\n')[0]).toBe(
      'Folio: #478',
    );
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: {},
    });
    espejoSano(bd, { variosDias: false });
  });

  it('pasa de 1 día a 2: la fila única se acorta (mismo evento) y nace la del día 2', async () => {
    const bd = bd478();
    escala(bd, 'e-3').fecha_salida_plan = '2026-11-18T20:00:00.000Z';
    escala(bd, 'e-4').fecha_salida_plan = '2026-11-18T22:00:00.000Z';
    const service = armar(bd);
    await sincronizar(service);
    expect(titulos()).toEqual(['Alejandro N621TX cun-ctm-mhl-ctm-cun 10:00']);
    // El regreso se va al 19-nov.
    escala(bd, 'e-3').fecha_salida_plan = D19_1000;
    escala(bd, 'e-4').fecha_salida_plan = D19_1200;
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.bitacora).toEqual(['update ev-1', 'insert ev-2']);
    expect(filasEnGoogle().map((f) => [f.id, f.titulo, f.fin])).toEqual([
      [
        'ev-1',
        'Alejandro N621TX cun-ctm-mhl 10:00',
        '2026-11-18T18:00:00.000Z',
      ],
      [
        'ev-2',
        'Alejandro N621TX mhl-ctm-cun 10:00',
        '2026-11-19T18:00:00.000Z',
      ],
    ]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: { 'e-3': 'ev-2' },
    });
    espejoSano(bd);
  });

  it('el día 2 cambia de fecha con la MISMA ancla: su evento se mueve (update), no se duplica', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    escala(bd, 'e-3').fecha_salida_plan = '2026-11-21T15:00:00.000Z';
    escala(bd, 'e-4').fecha_salida_plan = '2026-11-21T17:00:00.000Z';
    google.bitacora = [];

    await sincronizar(service);

    expect(google.bitacora).toEqual(['update ev-1', 'update ev-2']);
    expect(filasEnGoogle().map((f) => [f.id, f.inicio])).toEqual([
      ['ev-1', '2026-11-18T15:00:00.000Z'],
      ['ev-2', '2026-11-21T15:00:00.000Z'],
    ]);
    expect(bd.escrituras).toHaveLength(2); // las de la primera pasada
    espejoSano(bd);
  });

  it('MOVER EL ANCLA — el primer tramo del día 2 se CANCELA y otro abre ese día: sale la fila vieja y nace la nueva, nunca dos del día 2', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    escala(bd, 'e-3').cancelada_at = '2026-11-17T20:00:00.000Z';
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    // El borrado va ANTES del alta: en ningún momento hay dos filas del 19.
    expect(google.bitacora).toEqual([
      'delete ev-2',
      'update ev-1',
      'insert ev-3',
    ]);
    expect(filasEnGoogle().map((f) => [f.id, f.titulo, f.inicio])).toEqual([
      [
        'ev-1',
        'Alejandro N621TX cun-ctm-mhl 10:00',
        '2026-11-18T15:00:00.000Z',
      ],
      ['ev-3', 'Alejandro N621TX ctm-cun 12:00', '2026-11-19T17:00:00.000Z'],
    ]);
    // El id pasa del tramo cancelado (T3) al nuevo primero del día (T4).
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: { 'e-4': 'ev-3' },
    });
    espejoSano(bd);
  });

  it('MOVER EL ANCLA — entra un tramo ANTES del primero del día 2: la fila se ancla en el nuevo primero', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    // Un posicionamiento a las 8:00 del 19, antes de T3 (orden 2.5 → 3).
    escala(bd, 'e-3').orden = 4;
    escala(bd, 'e-4').orden = 5;
    bd.escalas.push(
      tramo(3, 'MHL', 'MHL', '2026-11-19T13:00:00.000Z', 0, { id: 'e-nuevo' }),
    );
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.bitacora).toEqual([
      'delete ev-2',
      'update ev-1',
      'insert ev-3',
    ]);
    expect(filasEnGoogle().map((f) => [f.id, f.titulo])).toEqual([
      ['ev-1', 'Alejandro N621TX cun-ctm-mhl 10:00'],
      ['ev-3', 'Alejandro N621TX mhl-mhl-ctm-cun 8:00'],
    ]);
    expect(idsGuardados(bd).tramos).toEqual({ 'e-nuevo': 'ev-3' });
    espejoSano(bd);
  });

  it('MOVER EL ANCLA — el tramo ancla se ELIMINA de la base (su fila ya salió de Google al borrarlo): nace la del nuevo primero y no queda nada colgando', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    // `flights.deleteEscala` / `quotes.replaceEscalas`: borran el evento del
    // tramo (`removeEscalaEvent`) ANTES del DELETE de la fila.
    await service.removeEscalaEvent(
      String(escala(bd, 'e-3').google_calendar_id),
    );
    bd.escalas = bd.escalas.filter((e) => e.id !== 'e-3');
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.bitacora).toEqual(['update ev-1', 'insert ev-3']);
    expect(filasEnGoogle().map((f) => [f.id, f.titulo])).toEqual([
      ['ev-1', 'Alejandro N621TX cun-ctm-mhl 10:00'],
      ['ev-3', 'Alejandro N621TX ctm-cun 12:00'],
    ]);
    expect(idsGuardados(bd).tramos).toEqual({ 'e-4': 'ev-3' });
    espejoSano(bd);
  });

  it('se cancela un tramo que NO es ancla: las filas se actualizan en su sitio, sin altas ni bajas', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    escala(bd, 'e-4').cancelada_at = '2026-11-17T20:00:00.000Z';
    google.bitacora = [];

    await sincronizar(service);

    expect(google.bitacora).toEqual(['update ev-1', 'update ev-2']);
    expect(titulos()).toEqual([
      'Alejandro N621TX cun-ctm-mhl 10:00',
      'Alejandro N621TX mhl-ctm 10:00',
    ]);
    espejoSano(bd);
  });

  it('CANCELAR EL VUELO: se borran TODAS sus filas y sus ids', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    bd.vuelo.estado = 'CANCELADO';

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.eventos.size).toBe(0);
    expect(idsGuardados(bd)).toEqual({
      vuelo: null,
      regreso: null,
      tramos: {},
    });
  });

  it('TODOS los tramos cancelados: no queda nada publicado ni guardado', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    for (const e of bd.escalas) e.cancelada_at = '2026-11-17T20:00:00.000Z';

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.eventos.size).toBe(0);
    expect(idsGuardados(bd)).toEqual({
      vuelo: null,
      regreso: null,
      tramos: {},
    });
  });

  it('se cancela TODO el día 1: el día 2 pasa a ser la fila única del vuelo, en el evento del vuelo', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    escala(bd, 'e-1').cancelada_at = '2026-11-17T20:00:00.000Z';
    escala(bd, 'e-2').cancelada_at = '2026-11-17T20:00:00.000Z';
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.bitacora).toEqual(['delete ev-2', 'update ev-1']);
    expect(filasEnGoogle()).toEqual([
      {
        id: 'ev-1',
        titulo: 'Alejandro N621TX mhl-ctm-cun 10:00',
        inicio: '2026-11-19T15:00:00.000Z',
        fin: '2026-11-19T18:00:00.000Z',
        etiqueta: 'vuelo',
      },
    ]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: {},
    });
    espejoSano(bd);
  });

  it('borraron A MANO en Google la fila del día 2 (404): se vuelve a crear y su ancla guarda el id nuevo', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    google.eventos.delete('ev-2');
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.bitacora).toEqual(['update ev-1', 'insert ev-3']);
    expect(idsGuardados(bd).tramos).toEqual({ 'e-3': 'ev-3' });
    espejoSano(bd);
  });
});

// ===== QUIÉN VUELA CADA DÍA =====

describe('vuelo de varios días — avión, piloto y color de CADA día', () => {
  const N990GG = { matricula: 'N990GG', color_calendario: '#10B981' };
  const ZAMORA = { nombre: 'Abraham Zamora', apodo: 'Zamora' };

  it('multi-avión y rotación de piloto: el título de cada día usa el avión y el piloto del PRIMER tramo de ESE día; lo que difiere va en la línea del tramo', async () => {
    const bd = bd478();
    for (const id of ['e-3', 'e-4']) {
      Object.assign(escala(bd, id), {
        aeronave_id: 'a-990',
        piloto_id: 'p-zam',
        aeronave: N990GG,
        piloto: ZAMORA,
      });
    }

    await sincronizar(armar(bd));

    expect(titulos()).toEqual([
      'Alejandro N621TX cun-ctm-mhl 10:00',
      'Zamora N990GG mhl-ctm-cun 10:00',
    ]);
    // La descripción es la del vuelo completo en las DOS filas: encabezado
    // con el avión y el piloto del primer tramo del vuelo, y en cada línea lo
    // que difiera (como siempre).
    for (const id of ['ev-1', 'ev-2']) {
      const lineas = String(google.eventos.get(id)?.description).split('\n');
      expect(lineas).toContain('Aeronave: N621TX');
      expect(lineas).toContain('Piloto: Alejandro Canales');
      expect(lineas).toContain('T1 cun-ctm 10:00 · 3 pax');
      expect(lineas).toContain('T3 mhl-ctm 10:00 · 3 pax · N990GG · Zamora');
      expect(lineas).toContain('T4 ctm-cun 12:00 · 1 pax · N990GG · Zamora');
    }
  });

  it('el color es el de siempre, con el primer tramo de CADA día: permiso pendiente o sin piloto ese día ⇒ esa fila en amarillo', async () => {
    const bd = bd478();
    escala(bd, 'e-3').estado_permiso = 'pendiente';

    await sincronizar(armar(bd));

    expect(google.eventos.get('ev-1')?.colorId).toBe('2'); // verde
    expect(google.eventos.get('ev-2')?.colorId).toBe('5'); // amarillo
    // El texto lo dice en las dos (basta un tramo pendiente en el vuelo).
    expect(String(google.eventos.get('ev-1')?.description)).toContain(
      'Permiso de pista: PENDIENTE',
    );

    // Y un día sin piloto: «sin piloto» en SU título y amarillo.
    prenderGoogle();
    const sinPiloto = bd478({ piloto_id: null, piloto: null });
    for (const id of ['e-1', 'e-2']) {
      Object.assign(escala(sinPiloto, id), {
        piloto_id: 'p-ale',
        piloto: ALEJANDRO,
      });
    }
    for (const id of ['e-3', 'e-4']) {
      Object.assign(escala(sinPiloto, id), { piloto_id: null, piloto: null });
    }
    await sincronizar(armar(sinPiloto));
    expect(filasEnGoogle().map((f) => f.titulo)).toEqual([
      'Alejandro N621TX cun-ctm-mhl 10:00',
      'sin piloto N621TX mhl-ctm-cun 10:00',
    ]);
    expect(google.eventos.get('ev-1')?.colorId).toBe('2');
    expect(google.eventos.get('ev-2')?.colorId).toBe('5');
  });

  it('EXTERNO de varios días: «externo» y la matrícula ajena en las dos filas', async () => {
    const bd = bd478({
      es_externo: true,
      operador_externo: 'Carlos Muciño',
      avion_externo_matricula: 'XB-ORN',
      aeronave_id: null,
      aeronave: null,
      piloto_id: null,
      piloto: null,
    });
    for (const e of bd.escalas) {
      Object.assign(e, {
        aeronave_id: null,
        aeronave: null,
        piloto_id: null,
        piloto: null,
      });
    }

    await sincronizar(armar(bd));

    expect(titulos()).toEqual([
      'externo XB-ORN cun-ctm-mhl 10:00',
      'externo XB-ORN mhl-ctm-cun 10:00',
    ]);
    const lineas = String(google.eventos.get('ev-2')?.description).split('\n');
    expect(lineas[0]).toBe('Día 2 de 2 · jueves 19/11/2026 · tramos T3 y T4');
    expect(lineas).toContain('Operador externo: Carlos Muciño');
    expect(lineas).toContain('Piloto: (externo)');
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: { 'e-3': 'ev-2' },
    });
    espejoSano(bd);
  });
});

// ===== REDONDO SIN ESCALAS =====

describe('REDONDO sin escalas capturadas, con el regreso otro día', () => {
  const bdRedondo = (): Bd => ({
    ...bd478({
      tipo: 'REDONDO',
      origen_iata: 'CUN',
      destino_iata: 'PTU',
      fecha_vuelo: D18_1000,
      fecha_traslado_final: '2026-11-19T22:00:00.000Z', // 19-nov 17:00
    }),
    escalas: [],
  });

  it('dos filas: la ida en la columna del vuelo y el regreso en `google_calendar_regreso_id`', async () => {
    const bd = bdRedondo();

    await expect(sincronizar(armar(bd))).resolves.toBe(true);

    expect(filasEnGoogle()).toEqual([
      {
        id: 'ev-1',
        titulo: 'Alejandro N621TX cun-ptu 10:00',
        inicio: '2026-11-18T15:00:00.000Z',
        fin: '2026-11-18T16:00:00.000Z',
        etiqueta: 'vuelo',
      },
      {
        id: 'ev-2',
        titulo: 'Alejandro N621TX ptu-cun 17:00',
        inicio: '2026-11-19T22:00:00.000Z',
        fin: '2026-11-19T23:00:00.000Z',
        etiqueta: 'dia-2',
      },
    ]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: 'ev-2',
      tramos: {},
    });
    espejoSano(bd);
  });

  it('dos pasadas seguidas: la fila del regreso se actualiza EN SU SITIO (su columna ya no es «legado» que se borra en cada pasada)', async () => {
    const bd = bdRedondo();
    const service = armar(bd);
    await sincronizar(service);
    bd.escrituras = [];
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.bitacora).toEqual(['update ev-1', 'update ev-2']);
    expect(bd.escrituras).toEqual([]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: 'ev-2',
      tramos: {},
    });
    espejoSano(bd);
  });

  it('el regreso vuelve al mismo día: se borra su fila, se limpia la columna y queda la fila única', async () => {
    const bd = bdRedondo();
    const service = armar(bd);
    await sincronizar(service);
    bd.vuelo.fecha_traslado_final = '2026-11-18T22:00:00.000Z';
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.bitacora).toEqual(['delete ev-2', 'update ev-1']);
    expect(filasEnGoogle().map((f) => [f.titulo, f.inicio, f.fin])).toEqual([
      [
        'Alejandro N621TX cun-ptu-cun 10:00',
        '2026-11-18T15:00:00.000Z',
        '2026-11-18T23:00:00.000Z',
      ],
    ]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: {},
    });
    espejoSano(bd, { variosDias: false });
  });

  it('se capturan las escalas: el día 2 se muda de la columna del regreso a su tramo ancla (sale una, nace otra)', async () => {
    const bd = bdRedondo();
    const service = armar(bd);
    await sincronizar(service);
    bd.escalas = [
      tramo(1, 'CUN', 'PTU', D18_1000, 5),
      tramo(2, 'PTU', 'CUN', '2026-11-19T22:00:00.000Z', 5),
    ];
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.bitacora).toEqual([
      'delete ev-2',
      'update ev-1',
      'insert ev-3',
    ]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: { 'e-2': 'ev-3' },
    });
    espejoSano(bd);
  });
});

// ===== FALLOS: NI DUPLICADOS NI FANTASMAS =====

describe('vuelo de varios días — fallos a media pasada', () => {
  it('Google falla en la SEGUNDA fila: la primera ya quedó con su id y el reintento NO la duplica', async () => {
    const bd = bd478();
    const service = armar(bd);
    google.fallaInsert = (cuerpo) =>
      cuerpo.extendedProperties?.private?.vuelatour_tramo === 'dia-2'
        ? gaxios(500, 'Backend Error')
        : null;

    await expect(sincronizar(service)).resolves.toBe(false);

    // A medias, pero SANO: una fila en Google y su id guardado.
    expect(titulos()).toEqual(['Alejandro N621TX cun-ctm-mhl 10:00']);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: {},
    });
    espejoSano(bd);

    // Google vuelve: el reintento actualiza la primera y crea la segunda.
    google.fallaInsert = null;
    google.bitacora = [];
    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.bitacora).toEqual(['update ev-1', 'insert ev-2']);
    expect(titulos()).toEqual([
      'Alejandro N621TX cun-ctm-mhl 10:00',
      'Alejandro N621TX mhl-ctm-cun 10:00',
    ]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: { 'e-3': 'ev-2' },
    });
    espejoSano(bd);
  });

  it('Google falla al ACTUALIZAR la fila del día 2 (500): no se re-crea, su id se conserva y se reintenta', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    google.fallaUpdate = (id) =>
      id === 'ev-2' ? gaxios(500, 'Backend Error') : null;
    google.bitacora = [];
    bd.escrituras = [];

    await expect(sincronizar(service)).resolves.toBe(false);

    expect(google.bitacora).toEqual(['update ev-1']);
    expect(eventosGoogle.insert).toHaveBeenCalledTimes(2); // los de la 1.ª pasada
    expect(bd.escrituras).toEqual([]);
    expect(idsGuardados(bd).tramos).toEqual({ 'e-3': 'ev-2' });
    espejoSano(bd);
  });

  it('MOVER EL ANCLA con el borrado de la fila vieja FALLANDO: no nace la nueva (nunca dos filas del día 2), el id viejo se conserva y el reintento lo arregla', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    escala(bd, 'e-3').cancelada_at = '2026-11-17T20:00:00.000Z';
    google.fallaDelete = () => gaxios(500, 'Backend Error');
    google.bitacora = [];

    await expect(sincronizar(service)).resolves.toBe(false);

    // El día 1 sí se actualiza; del día 2 sigue la fila vieja y SOLO esa.
    expect(google.bitacora).toEqual(['update ev-1']);
    expect(filasEnGoogle().map((f) => [f.id, f.inicio])).toEqual([
      ['ev-1', '2026-11-18T15:00:00.000Z'],
      ['ev-2', '2026-11-19T15:00:00.000Z'],
    ]);
    // Su id NO se limpió (limpiarlo la dejaría de fantasma).
    expect(idsGuardados(bd).tramos).toEqual({ 'e-3': 'ev-2' });
    espejoSano(bd);

    // Reintento con Google de vuelta: sale la vieja y nace la nueva.
    google.fallaDelete = null;
    google.bitacora = [];
    await expect(sincronizar(service)).resolves.toBe(true);

    expect(google.bitacora).toEqual([
      'delete ev-2',
      'update ev-1',
      'insert ev-3',
    ]);
    expect(filasEnGoogle().map((f) => [f.id, f.titulo])).toEqual([
      ['ev-1', 'Alejandro N621TX cun-ctm-mhl 10:00'],
      ['ev-3', 'Alejandro N621TX ctm-cun 12:00'],
    ]);
    expect(idsGuardados(bd).tramos).toEqual({ 'e-4': 'ev-3' });
    espejoSano(bd);
  });

  it('pasa de 2 días a 1 con el borrado del día 2 FALLANDO: su id se conserva, el resultado es false y el reintento lo borra', async () => {
    const bd = bd478();
    const service = armar(bd);
    await sincronizar(service);
    escala(bd, 'e-3').fecha_salida_plan = '2026-11-18T20:00:00.000Z';
    escala(bd, 'e-4').fecha_salida_plan = '2026-11-18T22:00:00.000Z';
    google.fallaDelete = () => gaxios(503, 'Service Unavailable');

    await expect(sincronizar(service)).resolves.toBe(false);

    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: { 'e-3': 'ev-2' },
    });
    expect(google.eventos.has('ev-2')).toBe(true);

    google.fallaDelete = null;
    await expect(sincronizar(service)).resolves.toBe(true);

    expect(titulos()).toEqual(['Alejandro N621TX cun-ctm-mhl-ctm-cun 10:00']);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: {},
    });
    espejoSano(bd, { variosDias: false });
  });

  it('la base NO guarda el id de la fila nueva del día 2: esa fila se retira de Google (si no, la siguiente pasada crearía otra del mismo día)', async () => {
    const bd = bd478();
    const service = armar(bd);
    bd.fallaEscritura = (tabla) => (tabla === 'escala' ? 'timeout' : null);

    await expect(sincronizar(service)).resolves.toBe(false);

    expect(google.bitacora).toEqual([
      'insert ev-1',
      'insert ev-2',
      'delete ev-2',
    ]);
    expect(titulos()).toEqual(['Alejandro N621TX cun-ctm-mhl 10:00']);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-1',
      regreso: null,
      tramos: {},
    });
    espejoSano(bd);

    // La base vuelve: una sola fila del día 2, con su id guardado.
    bd.fallaEscritura = null;
    await expect(sincronizar(service)).resolves.toBe(true);

    expect(titulos()).toEqual([
      'Alejandro N621TX cun-ctm-mhl 10:00',
      'Alejandro N621TX mhl-ctm-cun 10:00',
    ]);
    expect(idsGuardados(bd).tramos).toEqual({ 'e-3': 'ev-3' });
    espejoSano(bd);
  });

  it('el tramo ancla se BORRA de la base a media pasada (el UPDATE del id no toca ninguna fila): la fila recién creada se retira de Google, no queda de fantasma', async () => {
    const bd = bd478();
    const service = armar(bd);
    // Entre que el worker leyó el vuelo y guarda el id del día 2, la oficina
    // borra T3. Para la base no es un error: simplemente no hay fila.
    bd.fallaEscritura = (tabla, id) => {
      if (tabla === 'escala')
        bd.escalas = bd.escalas.filter((e) => e.id !== id);
      return null;
    };

    await expect(sincronizar(service)).resolves.toBe(false);

    expect(google.bitacora).toEqual([
      'insert ev-1',
      'insert ev-2',
      'delete ev-2',
    ]);
    expect(titulos()).toEqual(['Alejandro N621TX cun-ctm-mhl 10:00']);
    espejoSano(bd);

    // El reintento ya ve el vuelo sin T3: el día 2 se ancla en T4.
    bd.fallaEscritura = null;
    await expect(sincronizar(service)).resolves.toBe(true);

    expect(titulos()).toEqual([
      'Alejandro N621TX cun-ctm-mhl 10:00',
      'Alejandro N621TX ctm-cun 12:00',
    ]);
    expect(idsGuardados(bd).tramos).toEqual({ 'e-4': 'ev-3' });
    espejoSano(bd);
  });

  it('formato viejo (un evento por tramo) en un vuelo de varios días: sobra todo menos lo que hoy es ancla, que se reutiliza', async () => {
    const bd = bd478({
      google_calendar_id: 'ev-ida',
      google_calendar_regreso_id: 'ev-regreso',
    });
    for (const e of bd.escalas) e.google_calendar_id = `ev-t${String(e.orden)}`;
    for (const id of [
      'ev-ida',
      'ev-regreso',
      'ev-t1',
      'ev-t2',
      'ev-t3',
      'ev-t4',
    ]) {
      google.eventos.set(id, {
        summary: 'formato viejo',
        start: {
          dateTime: `2026-11-1${id === 'ev-ida' ? 8 : 9}T15:00:00.000Z`,
        },
        extendedProperties: { private: { vuelatour_vuelo_id: V } },
      });
    }

    await expect(sincronizar(armar(bd))).resolves.toBe(true);

    // Sobran el regreso y los tramos 1, 2 y 4; el del vuelo y el de T3 (ancla
    // del día 2) se ACTUALIZAN.
    expect(google.bitacora).toEqual([
      'delete ev-regreso',
      'delete ev-t1',
      'delete ev-t2',
      'delete ev-t4',
      'update ev-ida',
      'update ev-t3',
    ]);
    expect(titulos()).toEqual([
      'Alejandro N621TX cun-ctm-mhl 10:00',
      'Alejandro N621TX mhl-ctm-cun 10:00',
    ]);
    expect(idsGuardados(bd)).toEqual({
      vuelo: 'ev-ida',
      regreso: null,
      tramos: { 'e-3': 'ev-t3' },
    });
    espejoSano(bd);
  });
});

// ===== MIL VUELTAS =====

describe('vuelo de varios días — secuencias al azar', () => {
  it('tras cualquier secuencia de cambios y de fallos de Google, el espejo queda sano y dice lo mismo que una publicación desde cero', async () => {
    // Generador determinista: la prueba es reproducible.
    let semilla = 20261117;
    const azar = (n: number): number => {
      // mulberry32: determinista y bien repartido.
      semilla = (semilla + 0x6d2b79f5) | 0;
      let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const medianoche18 = Date.parse('2026-11-18T05:00:00.000Z');
    const fechaAlAzar = (): string | null =>
      azar(8) === 0
        ? null
        : new Date(
            medianoche18 + azar(3) * 86_400_000 + (6 + azar(14)) * 3_600_000,
          ).toISOString();

    // Que la prueba de verdad pase por lo que dice probar.
    const visto = {
      variosDias: 0,
      unDia: 0,
      pasadasFallidas: 0,
      altas: 0,
      bajas: 0,
    };

    for (let caso = 0; caso < 60; caso++) {
      prenderGoogle();
      const bd = bd478();
      const service = armar(bd);
      let nuevos = 0;

      for (let paso = 0; paso < 12; paso++) {
        // 1) Un cambio de la oficina (con Google sano: la baja de un tramo
        //    borra su evento antes que la fila; si eso fallara, lo reintenta
        //    el `borrar_evento` de la cola, que este doble no simula).
        google.fallaInsert = null;
        google.fallaDelete = null;
        google.fallaUpdate = null;
        const e = bd.escalas[azar(bd.escalas.length)];
        switch (azar(6)) {
          case 0:
            e.fecha_salida_plan = fechaAlAzar();
            break;
          case 1:
            e.cancelada_at = e.cancelada_at ? null : '2026-11-17T20:00:00.000Z';
            break;
          case 2:
            if (bd.escalas.length > 1) {
              // Baja del tramo: su evento sale ANTES que la fila.
              await service.removeEscalaEvent(
                e.google_calendar_id as string | null,
              );
              bd.escalas = bd.escalas.filter((x) => x !== e);
            }
            break;
          case 3:
            if (bd.escalas.length < 7) {
              nuevos++;
              bd.escalas.push(
                tramo(10 + nuevos, 'CUN', 'CZM', fechaAlAzar(), 2, {
                  id: `e-n${String(nuevos)}`,
                  orden: 1 + azar(8),
                }),
              );
            }
            break;
          case 4:
            bd.vuelo.fecha_traslado_final = fechaAlAzar();
            break;
          default:
            break;
        }
        // 2) Una pasada, a veces con Google fallando a la mitad.
        const fallo = azar(4);
        google.fallaInsert =
          fallo === 1 ? () => gaxios(500, 'Backend Error') : null;
        google.fallaDelete =
          fallo === 2 ? () => gaxios(503, 'Service Unavailable') : null;
        google.fallaUpdate =
          fallo === 3 && azar(2) === 0
            ? () => gaxios(500, 'Backend Error')
            : null;
        if (!(await sincronizar(service))) visto.pasadasFallidas++;
        visto.altas += google.bitacora.filter((l) =>
          l.startsWith('insert '),
        ).length;
        visto.bajas += google.bitacora.filter((l) =>
          l.startsWith('delete '),
        ).length;
        google.bitacora = [];
        // Sin fantasmas ni columnas colgando EN NINGÚN momento, falle o no.
        const guardados = [
          bd.vuelo.google_calendar_id,
          bd.vuelo.google_calendar_regreso_id,
          ...bd.escalas.map((x) => x.google_calendar_id),
        ]
          .filter((id): id is string => typeof id === 'string')
          .sort();
        expect([...google.eventos.keys()].sort()).toEqual(guardados);
      }

      // 3) Google sano: una pasada deja TODO en su sitio…
      google.fallaInsert = null;
      google.fallaDelete = null;
      google.fallaUpdate = null;
      await expect(sincronizar(service)).resolves.toBe(true);
      const quedo = filasSinId();
      if (quedo.length > 1) visto.variosDias++;
      else visto.unDia++;

      // …y es exactamente lo que saldría publicando el mismo vuelo de cero.
      const limpia: Bd = structuredClone({
        ...bd,
        fallaEscritura: null,
        escrituras: [],
      });
      limpia.vuelo.google_calendar_id = null;
      limpia.vuelo.google_calendar_regreso_id = null;
      for (const x of limpia.escalas) x.google_calendar_id = null;
      const enVivo = new Map(google.eventos);
      const consecutivo = google.consecutivo;
      google.eventos.clear();
      await sincronizar(armar(limpia));
      const deCero = filasSinId();
      expect(quedo).toEqual(deCero);

      // Nunca dos filas el mismo día, y una pasada más no escribe nada.
      google.eventos.clear();
      for (const [id, cuerpo] of enVivo) google.eventos.set(id, cuerpo);
      google.consecutivo = consecutivo;
      const dias = quedo.map((f) => diaCancunDe(f.inicio));
      if (quedo.length > 1) expect(new Set(dias).size).toBe(dias.length);
      bd.escrituras = [];
      google.bitacora = [];
      await expect(sincronizar(service)).resolves.toBe(true);
      expect(bd.escrituras).toEqual([]);
      expect(google.bitacora.every((l) => l.startsWith('update '))).toBe(true);
    }

    // Con esta semilla: 44 vuelos terminan de varios días y 16
    // de uno, 165 pasadas fallidas, 217 altas y 99 bajas en Google. Los pisos
    // son holgados: solo avisan si un cambio deja la prueba sin dientes.
    expect(visto.variosDias).toBeGreaterThanOrEqual(20);
    expect(visto.unDia).toBeGreaterThanOrEqual(5);
    expect(visto.pasadasFallidas).toBeGreaterThanOrEqual(50);
    expect(visto.altas).toBeGreaterThanOrEqual(100);
    expect(visto.bajas).toBeGreaterThanOrEqual(40);
  });
});
