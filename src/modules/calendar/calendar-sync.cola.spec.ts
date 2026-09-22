// COLA AUTOMÁTICA del espejo sistema → Google Calendar (12-sep-2026).
//
// Supabase y Google están MOCKEADOS: este spec no toca la red ni la BD.
// Lo que se congela acá es el contrato del worker: toma / procesa / borra,
// backoff, pausa por cuota, «no existe ⇒ hecho», sync apagada que NO quema
// intentos, aviso a ADMIN una vez al día, y la tolerancia a que la migración
// `20260912000002` todavía no esté aplicada (hooks directos, como antes).
jest.mock('googleapis', () => ({
  google: { calendar: () => calendarioFake() },
}));
jest.mock('google-auth-library', () => ({
  JWT: class {
    constructor(public readonly opts: unknown) {}
  },
}));
// `notifications` arrastra el gateway y `jose` (ESM puro): mismo patrón que
// expenses.service.spec.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import { Logger } from '@nestjs/common';
import { CalendarSyncService } from './calendar-sync.service';
import {
  colaAtorada,
  esLimiteGoogle,
  sanitizarError,
  siguienteIntentoMs,
  textoAvisoCola,
} from './calendar-sync-cola.util';
import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import type { NotificationsService } from '../realtime/notifications.service';
import type { SupabaseService } from '../supabase/supabase.service';

const eventosGoogle = {
  insert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};
function calendarioFake() {
  return { events: eventosGoogle };
}

const CALENDARIO = 'aerochartercancunflightplanner@gmail.com';

type Res = {
  data?: unknown;
  error?: null | { code?: string; message: string };
  count?: number | null;
};

interface Consulta {
  tabla: string;
  metodo: 'select' | 'insert' | 'update' | 'delete';
  cols?: string;
  opciones?: { count?: string; head?: boolean };
  payload?: Record<string, unknown>;
  filtros: Array<{ op: string; args: unknown[] }>;
}

const tiene = (q: Consulta, op: string, arg0?: unknown): boolean =>
  q.filtros.some(
    (f) => f.op === op && (arg0 === undefined || f.args[0] === arg0),
  );

/**
 * Doble de Supabase dirigido por RUTAS: una función por tabla que decide la
 * respuesta mirando la consulta completa (método + filtros), no un FIFO
 * ciego — el worker consulta la misma tabla 4 o 5 veces por pasada.
 */
function armarSupabase(
  rutas: Record<string, (q: Consulta) => Res>,
  rpc: (nombre: string) => Res = () => ({
    data: null,
    error: { code: '42883', message: 'function does not exist' },
  }),
) {
  const llamadas: Consulta[] = [];
  const rpcs: string[] = [];
  const from = (tabla: string) => {
    const q: Consulta = { tabla, metodo: 'select', filtros: [] };
    llamadas.push(q);
    const api: Record<string, unknown> = {};
    const registrar =
      (op: string) =>
      (...args: unknown[]) => {
        q.filtros.push({ op, args });
        return api;
      };
    for (const op of [
      'eq',
      'neq',
      'in',
      'is',
      'not',
      'or',
      'gt',
      'gte',
      'lt',
      'lte',
      'order',
      'limit',
      'range',
    ]) {
      api[op] = registrar(op);
    }
    api.select = (cols?: string, opciones?: Consulta['opciones']) => {
      q.cols = cols;
      if (opciones) q.opciones = opciones;
      q.filtros.push({ op: 'select', args: [cols] });
      return api;
    };
    api.insert = (payload: Record<string, unknown>) => {
      q.metodo = 'insert';
      q.payload = payload;
      return api;
    };
    api.update = (payload: Record<string, unknown>) => {
      q.metodo = 'update';
      q.payload = payload;
      return api;
    };
    api.delete = () => {
      q.metodo = 'delete';
      return api;
    };
    const resolver = () => {
      const h = rutas[tabla] ?? (() => ({ data: null, error: null }));
      const r = h(q);
      return {
        data: r.data ?? null,
        error: r.error ?? null,
        count: r.count ?? null,
      };
    };
    api.maybeSingle = () => Promise.resolve(resolver());
    api.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(resolver()).then(resolve, reject);
    return api;
  };
  return {
    llamadas,
    rpcs,
    service: {
      from,
      rpc: (nombre: string) => {
        rpcs.push(nombre);
        return Promise.resolve(rpc(nombre));
      },
    },
  };
}

function armar(
  rutas: Record<string, (q: Consulta) => Res>,
  opts: {
    env?: Record<string, unknown>;
    rpc?: (nombre: string) => Res;
  } = {},
) {
  const sb = armarSupabase(rutas, opts.rpc);
  const valores: Record<string, unknown> = {
    GOOGLE_CALENDAR_SYNC_ENABLED: true,
    GOOGLE_CALENDAR_ID: CALENDARIO,
    GOOGLE_SERVICE_ACCOUNT_JSON:
      '{"client_email":"sa@vuelatour.iam.gserviceaccount.com","private_key":"k"}',
    ...(opts.env ?? {}),
  };
  const config = {
    get: (k: string) => valores[k],
  } as unknown as ConfigService<EnvVars, true>;
  const notifyRole = jest.fn().mockResolvedValue(1);
  const service = new CalendarSyncService(
    config,
    { service: sb.service } as unknown as SupabaseService,
    { notifyRole } as unknown as NotificationsService,
  );
  service.onModuleInit();
  return { service, llamadas: sb.llamadas, rpcs: sb.rpcs, notifyRole };
}

/** Sonda con la migración APLICADA. */
const colaActiva = () => ({ data: true, error: null });

/** Item de la cola tal como lo devuelve el reclamo. */
const item = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  entidad: 'vuelo',
  entidad_id: 'v-1',
  google_event_id: null,
  intentos: 0,
  creado_at: new Date().toISOString(),
  tomado_at: null,
  ...over,
});

/**
 * Ruta de la tabla `calendar_sync_cola` con la mecánica real del worker:
 * select de listos → update de reclamo (devuelve los items) → delete/update
 * por item → conteos del aviso.
 */
function rutaCola(cfg: {
  items: Array<Record<string, unknown>>;
  pendientes?: number;
  masViejo?: { creado_at: string; ultimo_error: string | null } | null;
  maxIntentos?: number;
  registro: Consulta[];
}) {
  return (q: Consulta): Res => {
    cfg.registro.push(q);
    if (q.metodo === 'update' && tiene(q, 'in')) {
      return { data: cfg.items, error: null };
    }
    if (q.metodo === 'update' || q.metodo === 'delete') {
      return { data: null, error: null };
    }
    // Conteos (head: true).
    if (q.opciones?.head) {
      return { count: cfg.pendientes ?? cfg.items.length, error: null };
    }
    if (tiene(q, 'order', 'creado_at')) {
      return { data: cfg.masViejo ?? null, error: null };
    }
    if (tiene(q, 'order', 'intentos')) {
      return { data: { intentos: cfg.maxIntentos ?? 0 }, error: null };
    }
    // Select de items LISTOS (filtra por siguiente_intento_at).
    if (tiene(q, 'lte')) {
      return { data: cfg.items.map((i) => ({ id: i.id })), error: null };
    }
    return { data: null, error: null };
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  eventosGoogle.insert.mockResolvedValue({ data: { id: 'ev-nuevo' } });
  eventosGoogle.update.mockResolvedValue({ data: { id: 'ev-existente' } });
  eventosGoogle.delete.mockResolvedValue({});
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllTimers();
});

const gaxios = (status: number, msg: string) =>
  Object.assign(new Error(msg), { code: status, response: { status } });

const VUELO = {
  id: 'v-1',
  folio: 101,
  estado: 'CONFIRMADO',
  es_externo: false,
  operador_externo: null,
  origen_iata: 'CUN',
  destino_iata: 'PTU',
  pasajeros: 3,
  monto_total_usd: '1000',
  fecha_vuelo: '2026-09-20T15:00:00.000Z',
  fecha_traslado_final: null,
  tipo: 'SENCILLO',
  notas: null,
  estado_permiso: 'no_aplica',
  aeronave_id: 'a-1',
  piloto_id: 'p-1',
  google_calendar_id: null,
  google_calendar_regreso_id: null,
  aeronave: { matricula: 'N4142R', color_calendario: '#F97316' },
  piloto: { nombre: 'Luis Pérez' },
  cliente: { nombre: 'ACME' },
  escalas: [],
};

// ===== PIEZAS PURAS =====

describe('calendar-sync-cola.util (puro)', () => {
  it('backoff: 30 s · 2^intentos con techo de 1 h (nunca descarta el item)', () => {
    expect(siguienteIntentoMs(0)).toBe(30_000);
    expect(siguienteIntentoMs(1)).toBe(60_000);
    expect(siguienteIntentoMs(2)).toBe(120_000);
    expect(siguienteIntentoMs(6)).toBe(1_920_000);
    expect(siguienteIntentoMs(7)).toBe(3_600_000);
    expect(siguienteIntentoMs(99)).toBe(3_600_000);
  });

  it('403 de cuota y 429 pausan; 404/500 no', () => {
    expect(esLimiteGoogle(gaxios(403, 'Rate Limit Exceeded'))).toBe(true);
    expect(esLimiteGoogle(gaxios(429, 'Too Many Requests'))).toBe(true);
    expect(esLimiteGoogle(gaxios(404, 'Not Found'))).toBe(false);
    expect(esLimiteGoogle(gaxios(500, 'Backend Error'))).toBe(false);
    expect(esLimiteGoogle(new Error('socket hang up'))).toBe(false);
  });

  it('el error guardado NO lleva secretos (el panel lo muestra)', () => {
    const texto = sanitizarError(
      'GET https://www.googleapis.com/calendar/v3?key=AIzaSecretoLargo failed',
    );
    expect(texto).toContain('failed');
    expect(texto).not.toContain('AIzaSecretoLargo');
    expect(texto).toContain('key=***');
    expect(
      sanitizarError('-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----'),
    ).toBe('***');
  });

  it('atorada: ≥ 12 intentos o el más viejo con más de 30 min', () => {
    const ahora = Date.parse('2026-09-12T18:00:00.000Z');
    expect(
      colaAtorada(
        { pendientes: 0, mas_antiguo_at: null, max_intentos: 99 },
        ahora,
      ),
    ).toBe(false);
    expect(
      colaAtorada(
        { pendientes: 1, mas_antiguo_at: null, max_intentos: 12 },
        ahora,
      ),
    ).toBe(true);
    expect(
      colaAtorada(
        {
          pendientes: 3,
          mas_antiguo_at: '2026-09-12T17:00:00.000Z',
          max_intentos: 1,
        },
        ahora,
      ),
    ).toBe(true);
    // Recién encolado y con un solo fallo: NO se molesta a nadie.
    expect(
      colaAtorada(
        {
          pendientes: 3,
          mas_antiguo_at: '2026-09-12T17:50:00.000Z',
          max_intentos: 1,
        },
        ahora,
      ),
    ).toBe(false);
  });

  it('el aviso a ADMIN dice cuántos, desde cuándo (hora Cancún) y el error', () => {
    const texto = textoAvisoCola({
      pendientes: 4,
      mas_antiguo_at: '2026-09-12T18:05:00.000Z', // 13:05 en Cancún (UTC−5)
      ultimo_error: 'vuelo v-1: Rate Limit Exceeded',
    });
    expect(texto).toContain('4 cambios');
    expect(texto).toContain('13:05');
    expect(texto).toContain('Rate Limit Exceeded');
  });
});

// ===== SONDA: SIN MIGRACIÓN, TODO SIGUE COMO ANTES =====

describe('CalendarSyncService — sin la migración aplicada', () => {
  it('el hook escribe DIRECTO a Google (comportamiento de siempre)', async () => {
    const { service, rpcs } = armar({
      vuelo: () => ({ data: VUELO, error: null }),
    });

    await expect(service.syncFlight('v-1')).resolves.toBe(true);

    expect(rpcs).toEqual(['calendar_sync_cola_activa']);
    expect(eventosGoogle.insert).toHaveBeenCalledTimes(1);
  });

  it('el worker no consulta la cola ni una vez', async () => {
    const registro: Consulta[] = [];
    const { service } = armar({
      calendar_sync_cola: rutaCola({ items: [], registro }),
    });

    await service.drenarCola();

    expect(registro).toHaveLength(0);
  });

  it('sync-estado: cola null y automatica false (migración pendiente)', async () => {
    const { service } = armar({});

    const estado = await service.estadoSyncCompleto();

    expect(estado.enabled).toBe(true);
    expect(estado.automatica).toBe(false);
    expect(estado.cola).toBeNull();
  });
});

// ===== MODO AUTOMÁTICO: EL HOOK YA NO HABLA CON GOOGLE =====

describe('CalendarSyncService — con la cola activa, el hook solo drena', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('syncFlight NO escribe a Google ni lee el vuelo (el trigger ya encoló)', async () => {
    const registro: Consulta[] = [];
    const { service, llamadas } = armar(
      {
        vuelo: () => ({ data: VUELO, error: null }),
        calendar_sync_cola: rutaCola({ items: [], registro }),
      },
      { rpc: colaActiva },
    );

    await expect(service.syncFlight('v-1')).resolves.toBe(true);

    expect(eventosGoogle.insert).not.toHaveBeenCalled();
    expect(eventosGoogle.update).not.toHaveBeenCalled();
    expect(llamadas.filter((l) => l.tabla === 'vuelo')).toHaveLength(0);
  });

  it('el upsert de descanso conserva el id guardado y no toca Google', async () => {
    const { service } = armar({}, { rpc: colaActiva });

    await expect(
      service.upsertDescansoEvent({
        piloto_nombre: 'Luis',
        fecha_inicio: '2026-09-01',
        fecha_fin: '2026-09-03',
        google_calendar_id: 'ev-viejo',
      }),
    ).resolves.toBe('ev-viejo');

    expect(eventosGoogle.insert).not.toHaveBeenCalled();
    expect(eventosGoogle.update).not.toHaveBeenCalled();
  });

  it('el barrido (red de seguridad) SÍ escribe directo aunque la cola esté activa', async () => {
    const { service } = armar(
      { vuelo: () => ({ data: VUELO, error: null }) },
      { rpc: colaActiva },
    );

    await service.syncFlight('v-1', { directo: true });

    expect(eventosGoogle.insert).toHaveBeenCalledTimes(1);
  });
});

// ===== WORKER: TOMA / PROCESA / BORRA =====

describe('CalendarSyncService.drenarCola', () => {
  it('reclama el item, lo sincroniza y lo BORRA de la cola', async () => {
    const registro: Consulta[] = [];
    const { service } = armar(
      {
        vuelo: () => ({ data: VUELO, error: null }),
        calendar_sync_cola: rutaCola({ items: [item()], registro }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.drenarCola();

    // 1) reclamo con sello propio…
    const reclamo = registro.find(
      (q) => q.metodo === 'update' && tiene(q, 'in'),
    );
    expect(typeof reclamo?.payload?.tomado_at).toBe('string');
    // 2) …evento publicado…
    expect(eventosGoogle.insert).toHaveBeenCalledTimes(1);
    // 3) …y el item se cierra exigiendo el MISMO sello (anti-carrera: si un
    //    trigger lo re-encoló, el borrado no aplica y se vuelve a procesar).
    const borrado = registro.find((q) => q.metodo === 'delete');
    expect(borrado).toBeDefined();
    expect(tiene(borrado as Consulta, 'eq', 'tomado_at')).toBe(true);
  });

  it('un vuelo que ya no existe = HECHO (el item se borra, no se reintenta)', async () => {
    const registro: Consulta[] = [];
    const { service } = armar(
      {
        vuelo: () => ({ data: null, error: null }),
        calendar_sync_cola: rutaCola({
          items: [item({ id: 7, entidad_id: 'v-borrado' })],
          registro,
        }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.drenarCola();

    expect(registro.some((q) => q.metodo === 'delete')).toBe(true);
    expect(
      registro.some(
        (q) => q.metodo === 'update' && q.payload?.intentos !== undefined,
      ),
    ).toBe(false);
  });

  it('borrar_evento con 404 de Google = HECHO (el objetivo se cumple igual)', async () => {
    eventosGoogle.delete.mockRejectedValue(gaxios(404, 'Not Found'));
    const registro: Consulta[] = [];
    const { service } = armar(
      {
        calendar_sync_cola: rutaCola({
          items: [
            item({
              id: 9,
              entidad: 'borrar_evento',
              entidad_id: null,
              google_event_id: 'ev-huerfano',
            }),
          ],
          registro,
        }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.drenarCola();

    expect(eventosGoogle.delete).toHaveBeenCalledWith({
      calendarId: CALENDARIO,
      eventId: 'ev-huerfano',
    });
    expect(registro.some((q) => q.metodo === 'delete')).toBe(true);
  });

  it('un fallo NO pierde el cambio: intentos+1, backoff y ultimo_error', async () => {
    const registro: Consulta[] = [];
    const { service } = armar(
      {
        // La lectura del vuelo falla (Supabase caído a media pasada).
        vuelo: () => ({ data: null, error: { message: 'timeout' } }),
        calendar_sync_cola: rutaCola({
          items: [item({ id: 3, intentos: 0 })],
          registro,
        }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.drenarCola();

    const repro = registro.find(
      (q) => q.metodo === 'update' && q.payload?.intentos !== undefined,
    );
    expect(repro?.payload?.intentos).toBe(1);
    expect(repro?.payload?.tomado_at).toBeNull();
    expect(String(repro?.payload?.ultimo_error)).toContain('timeout');
    const espera =
      new Date(String(repro?.payload?.siguiente_intento_at)).getTime() -
      Date.now();
    // 30 s · 2^1 = 1 min (con holgura por el tiempo del propio test).
    expect(espera).toBeGreaterThan(50_000);
    expect(espera).toBeLessThanOrEqual(60_000);
    // El item NO se borra: el cambio sigue esperando su turno.
    expect(registro.some((q) => q.metodo === 'delete')).toBe(false);
  });

  it('403 de cuota: PAUSA el drenado y NO quema intentos de nadie', async () => {
    eventosGoogle.delete.mockRejectedValue(gaxios(403, 'Rate Limit Exceeded'));
    const registro: Consulta[] = [];
    const { service } = armar(
      {
        calendar_sync_cola: rutaCola({
          items: [
            item({
              id: 1,
              entidad: 'borrar_evento',
              entidad_id: null,
              google_event_id: 'ev-1',
            }),
            item({
              id: 2,
              entidad: 'borrar_evento',
              entidad_id: null,
              google_event_id: 'ev-2',
            }),
          ],
          registro,
        }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.drenarCola();

    // Solo se intentó UNO: al segundo ya no se le regalan errores a Google.
    expect(eventosGoogle.delete).toHaveBeenCalledTimes(1);
    // Nadie perdió intentos…
    expect(
      registro.some(
        (q) => q.metodo === 'update' && q.payload?.intentos !== undefined,
      ),
    ).toBe(false);
    // …y los dos se liberaron con el turno movido al fin de la pausa.
    const liberados = registro.find(
      (q) =>
        q.metodo === 'update' &&
        q.payload?.tomado_at === null &&
        q.payload?.siguiente_intento_at !== undefined &&
        tiene(q, 'in'),
    );
    expect(liberados).toBeDefined();
    expect(
      new Date(String(liberados?.payload?.siguiente_intento_at)).getTime(),
    ).toBeGreaterThan(Date.now() + 4 * 60_000);

    // La pausa se ve en el estado (el panel la pinta).
    const estado = await service.estadoSyncCompleto();
    expect(estado.cola?.pausada_hasta).not.toBeNull();

    // Y la siguiente pasada no vuelve a intentar hasta que pase la pausa.
    const antes = eventosGoogle.delete.mock.calls.length;
    await service.drenarCola();
    expect(eventosGoogle.delete.mock.calls.length).toBe(antes);
  });

  it('sync APAGADA: la cola espera (no drena, no quema intentos, no consulta)', async () => {
    const registro: Consulta[] = [];
    const { service, rpcs } = armar(
      {
        calendar_sync_cola: rutaCola({ items: [item()], registro }),
      },
      { rpc: colaActiva, env: { GOOGLE_CALENDAR_SYNC_ENABLED: false } },
    );

    await service.drenarCola();

    expect(registro).toHaveLength(0);
    expect(rpcs).toHaveLength(0);
    expect(eventosGoogle.insert).not.toHaveBeenCalled();
  });

  it('no corre dos pasadas a la vez (single-flight)', async () => {
    const registro: Consulta[] = [];
    const { service } = armar(
      {
        vuelo: () => ({ data: VUELO, error: null }),
        calendar_sync_cola: rutaCola({ items: [item()], registro }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await Promise.all([service.drenarCola(), service.drenarCola()]);

    expect(eventosGoogle.insert).toHaveBeenCalledTimes(1);
  });
});

// ===== DESCANSO Y EVENTO POR ID (los que el worker necesita) =====

describe('CalendarSyncService — el id de Google no se reescribe por gusto', () => {
  // Revisión adversaria 12-sep-2026: `saveEventId` se llamaba en CADA
  // sincronización del vuelo, con el MISMO valor. Ese UPDATE sin cambio de
  // negocio movía `updated_at` ⇒ deltas falsos en `?updated_since` y 409
  // CONFLICTO_VERSION espurios contra el `if_updated_at` de la app offline
  // (invariante 13) cada vez que el worker tocaba el vuelo. Con el id ya
  // guardado no debe haber NINGÚN update de `vuelo`.
  it('con el id ya guardado, sincronizar el vuelo NO escribe la fila', async () => {
    const registro: Consulta[] = [];
    const { service, llamadas } = armar(
      {
        vuelo: () => ({
          data: { ...VUELO, google_calendar_id: 'ev-existente' },
          error: null,
        }),
        calendar_sync_cola: rutaCola({ items: [item()], registro }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.drenarCola();

    expect(eventosGoogle.update).toHaveBeenCalledTimes(1);
    expect(
      llamadas.filter((l) => l.tabla === 'vuelo' && l.metodo === 'update'),
    ).toHaveLength(0);
  });

  it('cuando Google devuelve un id NUEVO (evento borrado allá) SÍ se persiste', async () => {
    const registro: Consulta[] = [];
    eventosGoogle.update.mockRejectedValueOnce(gaxios(404, 'Not Found'));
    eventosGoogle.insert.mockResolvedValueOnce({ data: { id: 'ev-recreado' } });
    const { service, llamadas } = armar(
      {
        vuelo: () => ({
          data: { ...VUELO, google_calendar_id: 'ev-borrado-en-google' },
          error: null,
        }),
        calendar_sync_cola: rutaCola({ items: [item()], registro }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.drenarCola();

    const ups = llamadas.filter(
      (l) => l.tabla === 'vuelo' && l.metodo === 'update',
    );
    expect(ups).toHaveLength(1);
    expect(ups[0].payload).toEqual({ google_calendar_id: 'ev-recreado' });
  });
});

describe('CalendarSyncService — barrido y worker NO escriben a la vez', () => {
  // Revisión adversaria 12-sep-2026: el barrido (reconcile nocturno / resync)
  // escribe DIRECTO igual que el worker. Si los dos tocaran un vuelo SIN
  // `google_calendar_id`, los dos harían `events.insert` y Google se quedaría
  // con un evento DUPLICADO cuyo id no vive en ninguna fila (fantasma
  // imborrable). El barrido toma la exclusión y el worker se abstiene.
  it('mientras el barrido publica, drenarCola NO consulta la cola', async () => {
    const registro: Consulta[] = [];
    const drenados: Promise<void>[] = [];
    const { service, rpcs } = armar(
      {
        // La primera lectura de `vuelo` del barrido dispara un drenado
        // concurrente: tiene que salirse sin tocar la cola.
        vuelo: (q) => {
          if (q.cols === 'id, estado' && drenados.length === 0) {
            drenados.push(service.drenarCola());
          }
          return q.cols === 'id, estado'
            ? { data: [{ id: 'v-1', estado: 'CONFIRMADO' }], error: null }
            : { data: VUELO, error: null };
        },
        piloto_descanso: () => ({ data: [], error: null }),
        evento_flota: () => ({ data: [], error: null }),
        mantenimiento: () => ({ data: [], error: null }),
        calendar_sync_cola: rutaCola({ items: [item()], registro }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.resyncTodo();
    expect(drenados).toHaveLength(1);
    await Promise.all(drenados);

    // El drenado concurrente no leyó la cola ni sondeó SU migración. Los rpc
    // que sí se ven son del candado en BD que toma el barrido (D12).
    expect(registro).toHaveLength(0);
    expect(rpcs).not.toContain('calendar_sync_cola_activa');
    expect(rpcs).toEqual([
      'calendar_sync_estado_activa',
      'calendar_sync_lock',
      'calendar_sync_unlock',
    ]);
    // Y el barrido sí publicó el vuelo (una sola vez: sin duplicado).
    expect(eventosGoogle.insert).toHaveBeenCalledTimes(1);
  });

  it('al terminar el barrido la cola vuelve a drenar (la exclusión se libera)', async () => {
    const registro: Consulta[] = [];
    const { service } = armar(
      {
        vuelo: (q) =>
          q.cols === 'id, estado'
            ? { data: [], error: null }
            : { data: VUELO, error: null },
        piloto_descanso: () => ({ data: [], error: null }),
        evento_flota: () => ({ data: [], error: null }),
        mantenimiento: () => ({ data: [], error: null }),
        calendar_sync_cola: rutaCola({ items: [item()], registro }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.resyncTodo();
    registro.length = 0;
    await service.drenarCola();

    expect(registro.length).toBeGreaterThan(0);
  });
});

describe('CalendarSyncService.syncDescanso / syncEvento', () => {
  it('syncDescanso publica el descanso y guarda el id nuevo', async () => {
    const llamadasDescanso: Consulta[] = [];
    const { service } = armar(
      {
        piloto_descanso: (q) => {
          llamadasDescanso.push(q);
          if (q.metodo === 'update') return { data: null, error: null };
          return {
            data: {
              id: 'd-1',
              fecha_inicio: '2026-09-01',
              fecha_fin: '2026-09-03',
              motivo: 'vacaciones',
              google_calendar_id: null,
              piloto: { nombre: 'Luis Pérez' },
            },
            error: null,
          };
        },
      },
      { rpc: colaActiva },
    );

    await expect(service.syncDescanso('d-1', { directo: true })).resolves.toBe(
      true,
    );

    expect(eventosGoogle.insert).toHaveBeenCalledTimes(1);
    const guardado = llamadasDescanso.find((q) => q.metodo === 'update');
    expect(guardado?.payload).toEqual({ google_calendar_id: 'ev-nuevo' });
  });

  it('un descanso borrado = HECHO (su evento lo mata el item borrar_evento)', async () => {
    const { service } = armar(
      { piloto_descanso: () => ({ data: null, error: null }) },
      { rpc: colaActiva },
    );

    await expect(
      service.syncDescanso('d-borrado', { directo: true }),
    ).resolves.toBe(true);
    expect(eventosGoogle.insert).not.toHaveBeenCalled();
  });

  it('syncEvento publica el evento de flota en VERDE (el avión ya no da color)', async () => {
    const { service } = armar(
      {
        evento_flota: (q) =>
          q.metodo === 'update'
            ? { data: null, error: null }
            : {
                data: {
                  id: 'ef-1',
                  titulo: 'Lavado',
                  fecha: '2026-09-05T15:00:00.000Z',
                  fecha_fin: null,
                  notas: null,
                  google_calendar_id: null,
                  aeronave: {
                    matricula: 'N4142R',
                    color_calendario: '#F97316',
                  },
                  responsable: { nombre: 'Ana' },
                },
                error: null,
              },
      },
      { rpc: colaActiva },
    );

    await expect(service.syncEvento('ef-1', { directo: true })).resolves.toBe(
      true,
    );

    const llamadas = eventosGoogle.insert.mock.calls as unknown as Array<
      [{ requestBody: { summary: string; colorId: string } }]
    >;
    expect(llamadas[0][0].requestBody.summary).toBe('📌 Lavado · N4142R · Ana');
    // 22-sep-2026: verde del semáforo → Salvia (2), no el Mandarina del avión.
    expect(llamadas[0][0].requestBody.colorId).toBe('2');
  });

  it('un evento borrado = HECHO', async () => {
    const { service } = armar(
      { evento_flota: () => ({ data: null, error: null }) },
      { rpc: colaActiva },
    );

    await expect(
      service.syncEvento('ef-borrado', { directo: true }),
    ).resolves.toBe(true);
    expect(eventosGoogle.insert).not.toHaveBeenCalled();
  });
});

// ===== AVISO A ADMIN (D4) =====

describe('CalendarSyncService — aviso de cola atorada', () => {
  const entorno = (marcado: Array<Res>) => {
    const registro: Consulta[] = [];
    let i = 0;
    return armar(
      {
        vuelo: () => ({ data: null, error: { message: 'Google caído' } }),
        calendar_sync_cola: rutaCola({
          items: [item({ id: 5, intentos: 12 })],
          pendientes: 3,
          masViejo: {
            creado_at: new Date(Date.now() - 90 * 60_000).toISOString(),
            ultimo_error: 'vuelo v-1: Backend Error',
          },
          maxIntentos: 12,
          registro,
        }),
        alerta_emitida: () => marcado[Math.min(i++, marcado.length - 1)],
      },
      { rpc: colaActiva },
    );
  };

  it('avisa a ADMIN con texto claro y SOLO UNA VEZ AL DÍA', async () => {
    const { service, notifyRole } = entorno([
      { data: null, error: null }, // primer día: el dedupe entra
      { data: null, error: { code: '23505', message: 'duplicate key' } },
    ]);

    await service.drenarCola();
    await service.drenarCola();

    expect(notifyRole).toHaveBeenCalledTimes(1);
    const [rol, notif] = notifyRole.mock.calls[0] as [
      string,
      { tipo: string; titulo: string; cuerpo: string },
    ];
    expect(rol).toBe('ADMIN');
    expect(notif.tipo).toBe('alerta_sistema');
    expect(notif.cuerpo).toContain('3 cambios');
    expect(notif.cuerpo).toContain('Backend Error');
  });

  it('avisa aunque NO haya items listos (un atorado en backoff de 1 h)', async () => {
    const registro: Consulta[] = [];
    const { service, notifyRole } = armar(
      {
        calendar_sync_cola: rutaCola({
          // Nada listo: todos esperando su turno en backoff.
          items: [],
          pendientes: 2,
          masViejo: {
            creado_at: new Date(Date.now() - 120 * 60_000).toISOString(),
            ultimo_error: 'vuelo v-1: Backend Error',
          },
          maxIntentos: 13,
          registro,
        }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.drenarCola();

    expect(notifyRole).toHaveBeenCalledTimes(1);
  });

  it('la cola sana no molesta a nadie', async () => {
    const registro: Consulta[] = [];
    const { service, notifyRole } = armar(
      {
        vuelo: () => ({ data: VUELO, error: null }),
        calendar_sync_cola: rutaCola({
          items: [item()],
          pendientes: 0,
          registro,
        }),
        alerta_emitida: () => ({ data: null, error: null }),
      },
      { rpc: colaActiva },
    );

    await service.drenarCola();

    expect(notifyRole).not.toHaveBeenCalled();
  });
});

// ===== SYNC-ESTADO CON COLA (contrato del panel) =====

describe('CalendarSyncService.estadoSyncCompleto', () => {
  it('expone activa, pendientes, con_error, el más viejo y su error', async () => {
    const viejo = new Date(Date.now() - 20 * 60_000).toISOString();
    const { service } = armar(
      {
        calendar_sync_cola: (q) => {
          if (q.opciones?.head) {
            return { count: tiene(q, 'gt', 'intentos') ? 1 : 4, error: null };
          }
          return {
            data: {
              creado_at: viejo,
              ultimo_error: 'vuelo v-9: 503',
              intentos: 2,
            },
            error: null,
          };
        },
      },
      { rpc: colaActiva },
    );

    const estado = await service.estadoSyncCompleto();

    expect(estado.automatica).toBe(true);
    expect(estado.cola).toMatchObject({
      activa: true,
      pendientes: 4,
      con_error: 1,
      mas_antiguo_at: viejo,
      ultimo_error: 'vuelo v-9: 503',
      pausada_hasta: null,
    });
    // Los campos de siempre siguen ahí (contrato aditivo).
    expect(estado.calendar_id).toBe(CALENDARIO);
    expect(estado.nota).toContain('capturados a mano');
  });

  it('sync apagada: automatica false aunque la cola exista', async () => {
    const { service } = armar(
      {},
      { rpc: colaActiva, env: { GOOGLE_CALENDAR_SYNC_ENABLED: false } },
    );

    const estado = await service.estadoSyncCompleto();

    expect(estado.enabled).toBe(false);
    expect(estado.automatica).toBe(false);
  });
});
