// RED DE SEGURIDAD del espejo sistema → Google Calendar (D12, 12-sep-2026).
//
// Google y Supabase están MOCKEADOS: este spec no toca la red ni la BD.
// Lo que se congela acá:
//   * la VENTANA del reconcile nocturno = [hoy−30d, hoy+365d] (la del resync);
//   * el PASO INVERSO (Google → BD): borra el huérfano de fila inexistente y
//     el DUPLICADO con id distinto, NO borra el que coincide con la fila, NO
//     TOCA JAMÁS un evento manual de la oficina (sin ancla `vuelatour_*`),
//     pagina con `pageToken`, lee la BD por lotes y cuenta
//     `huerfanos_borrados`;
//   * el descanso lleva `vuelatour_descanso_id`;
//   * el resumen se PERSISTE y se relee al arrancar (sobrevive un redeploy);
//   * el CANDADO en BD: ausente ⇒ todo se comporta como hoy; ocupado ⇒ el
//     reconcile se salta y `POST /resync` responde 409.
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

import { ConflictException, Logger } from '@nestjs/common';
import { CalendarSyncService } from './calendar-sync.service';
import {
  ANCLA_DESCANSO,
  ANCLA_EVENTO,
  ANCLA_MANTENIMIENTO,
  ANCLA_VUELO,
  clasificarEventoSistema,
  decidirHuerfano,
  esUuidCalendar,
  lotesDe,
  LOTE_IDS_BD,
} from './calendar-huerfanos.util';
import {
  CANDADO_BARRIDO,
  CANDADO_DRENADO,
  CLAVE_ESTADO_SYNC,
  CLAVE_ESTADO_WORKER,
  parseEstadoSync,
  parseEstadoWorker,
  parseResumenPersistido,
} from './calendar-sync-estado.util';
import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import type { SupabaseService } from '../supabase/supabase.service';

const eventosGoogle = {
  insert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  list: jest.fn(),
};
function calendarioFake() {
  return { events: eventosGoogle };
}

const CALENDARIO = 'aerochartercancunflightplanner@gmail.com';

// UUIDs de prueba (el paso inverso solo verifica ids que son UUID).
const V1 = '11111111-1111-4111-8111-111111111111';
const V_BORRADO = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333333';
const D_BORRADO = '44444444-4444-4444-8444-444444444444';
const E_BORRADO = '55555555-5555-4555-8555-555555555555';
const M1 = '66666666-6666-4666-8666-666666666666';

type Res = {
  data?: unknown;
  error?: null | { code?: string; message: string };
  count?: number | null;
};

interface Consulta {
  tabla: string;
  metodo: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  cols?: string;
  opciones?: { count?: string; head?: boolean };
  payload?: Record<string, unknown>;
  filtros: Array<{ op: string; args: unknown[] }>;
}

const tiene = (q: Consulta, op: string, arg0?: unknown): boolean =>
  q.filtros.some(
    (f) => f.op === op && (arg0 === undefined || f.args[0] === arg0),
  );

interface LlamadaRpc {
  nombre: string;
  params?: Record<string, unknown>;
}

/** Doble de Supabase dirigido por RUTAS (una función por tabla). */
function armarSupabase(
  rutas: Record<string, (q: Consulta) => Res>,
  rpc: (nombre: string, params?: Record<string, unknown>) => Res = () => ({
    data: null,
    error: { code: '42883', message: 'function does not exist' },
  }),
) {
  const llamadas: Consulta[] = [];
  const rpcs: LlamadaRpc[] = [];
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
      // El barrido lee PAGINADO (max-rows 1000 de PostgREST).
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
    for (const m of ['insert', 'update', 'upsert'] as const) {
      api[m] = (payload: Record<string, unknown>) => {
        q.metodo = m;
        q.payload = payload;
        return api;
      };
    }
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
      rpc: (nombre: string, params?: Record<string, unknown>) => {
        rpcs.push({ nombre, params });
        return Promise.resolve(rpc(nombre, params));
      },
    },
  };
}

function armar(
  rutas: Record<string, (q: Consulta) => Res>,
  opts: {
    env?: Record<string, unknown>;
    rpc?: (nombre: string, params?: Record<string, unknown>) => Res;
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
  const service = new CalendarSyncService(config, {
    service: sb.service,
  } as unknown as SupabaseService);
  service.onModuleInit();
  return { service, llamadas: sb.llamadas, rpcs: sb.rpcs };
}

/** La migración de D12 aplicada y el candado CONCEDIDO. */
const estadoActivo = (nombre: string): Res =>
  nombre === 'calendar_sync_estado_activa' ||
  nombre === 'calendar_sync_lock' ||
  nombre === 'calendar_sync_unlock'
    ? { data: true, error: null }
    : {
        data: null,
        error: { code: '42883', message: 'function does not exist' },
      };

/** Ventana del barrido: las 4 consultas de filas vivas devuelven vacío. */
const ventanaVacia = (q: Consulta): Res =>
  tiene(q, 'in') ? { data: [], error: null } : { data: [], error: null };

/** Día Cancún (mismo criterio que el servicio) para armar expectativas. */
const diaCancun = (ms: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cancun' }).format(
    new Date(ms),
  );

const evGoogle = (
  id: string,
  privadas?: Record<string, string>,
  summary = 'algo',
) => ({
  id,
  summary,
  ...(privadas ? { extendedProperties: { private: privadas } } : {}),
});

/** Primer argumento de la i-ésima llamada a un mock de Google (tipado). */
const argsGoogle = (fn: jest.Mock, i = 0): Record<string, unknown> =>
  (fn.mock.calls as unknown as Record<string, unknown>[][])[i][0];

const idsBorrados = (): string[] =>
  (eventosGoogle.delete.mock.calls as unknown as { eventId: string }[][]).map(
    (c) => c[0].eventId,
  );

beforeEach(() => {
  jest.clearAllMocks();
  eventosGoogle.insert.mockResolvedValue({ data: { id: 'ev-nuevo' } });
  eventosGoogle.update.mockResolvedValue({ data: { id: 'ev-existente' } });
  eventosGoogle.delete.mockResolvedValue({});
  eventosGoogle.list.mockResolvedValue({ data: { items: [] } });
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ===== PIEZAS PURAS =====

describe('calendar-huerfanos.util (puro)', () => {
  it('un evento SIN ancla vuelatour_* NO es del sistema (es de la oficina)', () => {
    expect(clasificarEventoSistema(evGoogle('ev-1'))).toBeNull();
    expect(
      clasificarEventoSistema(evGoogle('ev-1', { otra_cosa: 'x' })),
    ).toBeNull();
    // Sin id no se puede borrar nada.
    expect(
      clasificarEventoSistema({
        extendedProperties: { private: { [ANCLA_VUELO]: V1 } },
      }),
    ).toBeNull();
    // Ancla vacía = no es ancla.
    expect(
      clasificarEventoSistema(evGoogle('ev-1', { [ANCLA_VUELO]: '  ' })),
    ).toBeNull();
  });

  it('reconoce las 4 anclas (vuelo, descanso, evento, mantenimiento)', () => {
    expect(
      clasificarEventoSistema(evGoogle('a', { [ANCLA_VUELO]: V1 })),
    ).toMatchObject({ tipo: 'vuelo', entidadId: V1, eventId: 'a' });
    expect(
      clasificarEventoSistema(evGoogle('b', { [ANCLA_DESCANSO]: D1 })),
    ).toMatchObject({ tipo: 'descanso', entidadId: D1 });
    expect(
      clasificarEventoSistema(evGoogle('c', { [ANCLA_EVENTO]: E_BORRADO })),
    ).toMatchObject({ tipo: 'evento', entidadId: E_BORRADO });
    expect(
      clasificarEventoSistema(evGoogle('d', { [ANCLA_MANTENIMIENTO]: M1 })),
    ).toMatchObject({ tipo: 'mantenimiento', entidadId: M1 });
  });

  it('decide: conservar / fila inexistente / duplicado / no verificable', () => {
    const ev = (eventId: string, entidadId = V1) => ({
      eventId,
      entidadId,
      tipo: 'vuelo' as const,
      summary: null,
      creadoMs: null,
    });
    const verificados = new Set([V1]);
    const vivos = new Map([[V1, new Set(['ev-vivo', 'ev-tramo'])]]);

    expect(decidirHuerfano(ev('ev-vivo'), verificados, vivos)).toBe(
      'conservar',
    );
    expect(decidirHuerfano(ev('ev-tramo'), verificados, vivos)).toBe(
      'conservar',
    );
    expect(decidirHuerfano(ev('ev-dup'), verificados, vivos)).toBe(
      'borrar_duplicado',
    );
    // La fila se verificó y NO existe.
    expect(
      decidirHuerfano(ev('ev-x', V_BORRADO), new Set([V_BORRADO]), vivos),
    ).toBe('borrar_fila_inexistente');
    // No se pudo verificar (consulta con error) ⇒ NO se toca.
    expect(decidirHuerfano(ev('ev-x', V_BORRADO), verificados, vivos)).toBe(
      'no_verificable',
    );
    // Id que no es UUID ⇒ NO se toca.
    expect(
      decidirHuerfano(ev('ev-x', 'no-uuid'), new Set(['no-uuid']), vivos),
    ).toBe('no_verificable');
  });

  it('esUuidCalendar y lotesDe (≤ 150 ids por consulta, nunca N+1)', () => {
    expect(esUuidCalendar(V1)).toBe(true);
    expect(esUuidCalendar('42')).toBe(false);
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const lotes = lotesDe(ids);
    // 150 y no 200 (revisión adversaria): un uuid pesa ~37 bytes en la URL de
    // PostgREST y con 200 el `in.(…)` la revienta (mismo tope que
    // DELTA_MAX_IDS_TRAMO en flights.service). El lote entero respondía 414 ⇒
    // «no verificable» ⇒ el paso inverso no borraba NADA en un calendario con
    // volumen.
    expect(LOTE_IDS_BD).toBe(150);
    expect(LOTE_IDS_BD).toBeLessThanOrEqual(200);
    expect(lotes.map((l) => l.length)).toEqual([150, 150, 150]);
    expect(lotesDe([], 10)).toEqual([]);
  });
});

describe('calendar-sync-estado.util (puro)', () => {
  it('el resumen guardado se valida al releerlo (un JSON a medias = null)', () => {
    const bueno = {
      origen: 'reconcile',
      vuelos: 3,
      descansos: 1,
      eventos: 0,
      mantenimientos: 2,
      errores: 0,
      huerfanos_borrados: 4,
      desde: '2026-08-13',
      hasta: '2027-09-12',
      at: '2026-09-13T05:15:00.000Z',
    };
    expect(parseResumenPersistido(bueno)).toEqual(bueno);
    expect(parseResumenPersistido({ ...bueno, origen: 'otro' })).toBeNull();
    expect(parseResumenPersistido({ ...bueno, at: '' })).toBeNull();
    expect(parseResumenPersistido(null)).toBeNull();
    // Conteos basura no revientan el panel: cuentan como 0.
    expect(parseResumenPersistido({ ...bueno, vuelos: 'x' })?.vuelos).toBe(0);
  });

  it('las filas «sync» y «worker» toleran valores faltantes', () => {
    expect(parseEstadoSync(null)).toEqual({
      ultimo_reconcile_at: null,
      ultimo_resync_at: null,
      ultimo_resumen: null,
    });
    expect(
      parseEstadoWorker({ ultimo_drenado_at: '2026-09-12T10:00:00.000Z' }),
    ).toEqual({
      ultimo_drenado_at: '2026-09-12T10:00:00.000Z',
      pausada_hasta: null,
    });
  });
});

// ===== VENTANA DEL CRON =====

describe('CalendarSyncService.reconcileVentana — ventana [hoy−30d, hoy+365d]', () => {
  it('usa la ventana del resync (antes era [−7d, +60d])', async () => {
    const vistas: Consulta[] = [];
    const { service } = armar({
      vuelo: (q) => {
        vistas.push(q);
        return { data: [], error: null };
      },
      piloto_descanso: ventanaVacia,
      evento_flota: ventanaVacia,
      mantenimiento: ventanaVacia,
    });

    const antes = Date.now();
    await service.reconcileVentana();
    const despues = Date.now();

    const estado = await service.estadoSyncCompleto();
    expect(estado.ultimo_resumen?.origen).toBe('reconcile');
    // Los días Cancún del resumen son los de [−30d, +365d].
    expect([
      diaCancun(antes - 30 * 86_400_000),
      diaCancun(despues - 30 * 86_400_000),
    ]).toContain(estado.ultimo_resumen?.desde);
    expect([
      diaCancun(antes + 365 * 86_400_000),
      diaCancun(despues + 365 * 86_400_000),
    ]).toContain(estado.ultimo_resumen?.hasta);
    // Y el listado de Google (paso inverso) pide la MISMA ventana.
    const args = argsGoogle(eventosGoogle.list) as unknown as {
      timeMin: string;
      timeMax: string;
      singleEvents: boolean;
      showDeleted: boolean;
    };
    expect(diaCancun(Date.parse(args.timeMin))).toBe(
      estado.ultimo_resumen?.desde,
    );
    expect(diaCancun(Date.parse(args.timeMax))).toBe(
      estado.ultimo_resumen?.hasta,
    );
    expect(args.singleEvents).toBe(true);
    expect(args.showDeleted).toBe(false);
  });
});

// ===== PASO INVERSO: GOOGLE → BD =====

describe('CalendarSyncService — paso inverso (huérfanos y duplicados)', () => {
  /** Rutas de verificación: V1, D1 y M1 vivos; los «_BORRADO» no existen. */
  const rutasVerificacion = (
    extra: Partial<Record<string, (q: Consulta) => Res>> = {},
  ): Record<string, (q: Consulta) => Res> => ({
    vuelo: (q) => {
      if (!tiene(q, 'in')) return { data: [], error: null }; // ventana
      return {
        data: [
          {
            id: V1,
            google_calendar_id: 'ev-vivo',
            google_calendar_regreso_id: null,
          },
        ],
        error: null,
      };
    },
    escala: () => ({
      data: [{ vuelo_id: V1, google_calendar_id: 'ev-tramo' }],
      error: null,
    }),
    piloto_descanso: (q) =>
      tiene(q, 'in')
        ? { data: [{ id: D1, google_calendar_id: 'ev-descanso' }], error: null }
        : { data: [], error: null },
    evento_flota: () => ({ data: [], error: null }),
    mantenimiento: (q) =>
      tiene(q, 'in')
        ? { data: [{ id: M1, google_calendar_id: 'ev-mant' }], error: null }
        : { data: [], error: null },
    ...extra,
  });

  const PAGINA_1 = [
    evGoogle('ev-vivo', { [ANCLA_VUELO]: V1 }, 'T1 · N4142R · CUN-PTU'),
    evGoogle('ev-tramo', { [ANCLA_VUELO]: V1 }, 'T2 · N4142R · PTU-CUN'),
    evGoogle('ev-dup', { [ANCLA_VUELO]: V1 }, 'T1 · N4142R · CUN-PTU (dup)'),
    evGoogle('ev-huerfano', { [ANCLA_VUELO]: V_BORRADO }, 'vuelo borrado'),
    evGoogle('ev-manual', undefined, 'Junta con el contador'),
    evGoogle('ev-descanso', { [ANCLA_DESCANSO]: D1 }, '😴 Descansa · Luis'),
    evGoogle('ev-mant', { [ANCLA_MANTENIMIENTO]: M1 }, '🔧 Servicio'),
  ];
  const PAGINA_2 = [
    evGoogle(
      'ev-descanso-viejo',
      { [ANCLA_DESCANSO]: D_BORRADO },
      '😴 Descansa',
    ),
    evGoogle('ev-evento-viejo', { [ANCLA_EVENTO]: E_BORRADO }, '📌 Lavado'),
    // Ancla con un id que no es UUID: no se puede verificar ⇒ se conserva.
    evGoogle('ev-raro', { [ANCLA_VUELO]: 'no-es-uuid' }, '¿?'),
  ];

  beforeEach(() => {
    eventosGoogle.list
      .mockResolvedValueOnce({
        data: { items: PAGINA_1, nextPageToken: 'p2' },
      })
      .mockResolvedValueOnce({ data: { items: PAGINA_2 } });
  });

  it('borra el huérfano y el duplicado; NO toca lo vivo ni lo manual; pagina', async () => {
    const { service } = armar(rutasVerificacion());

    await service.reconcileVentana();

    const borrados = idsBorrados();
    // Huérfanos de fila inexistente + el duplicado con id distinto.
    expect(borrados.sort()).toEqual(
      ['ev-descanso-viejo', 'ev-dup', 'ev-evento-viejo', 'ev-huerfano'].sort(),
    );
    // Lo que la fila SÍ apunta (incluido el evento por TRAMO) se conserva.
    expect(borrados).not.toContain('ev-vivo');
    expect(borrados).not.toContain('ev-tramo');
    expect(borrados).not.toContain('ev-descanso');
    expect(borrados).not.toContain('ev-mant');
    // El evento capturado A MANO por la oficina NO se toca JAMÁS.
    expect(borrados).not.toContain('ev-manual');
    // Ni el que no se pudo verificar (ancla que no es UUID).
    expect(borrados).not.toContain('ev-raro');
    // Paginó: 2 llamadas y la 2.ª con el pageToken de la 1.ª.
    expect(eventosGoogle.list).toHaveBeenCalledTimes(2);
    expect(
      (argsGoogle(eventosGoogle.list, 1) as { pageToken?: string }).pageToken,
    ).toBe('p2');

    const estado = await service.estadoSyncCompleto();
    expect(estado.ultimo_resumen?.huerfanos_borrados).toBe(4);
    expect(estado.ultimo_resumen?.errores).toBe(0);
  });

  it('lee la BD por LOTES (una consulta por tipo), nunca un id a la vez', async () => {
    const { service, llamadas } = armar(rutasVerificacion());

    await service.reconcileVentana();

    const porLote = llamadas.filter((l) => tiene(l, 'in'));
    // vuelo + escala + descanso + evento + mantenimiento = 5 consultas para
    // los 9 eventos del sistema de las dos páginas.
    expect(porLote).toHaveLength(5);
    const ids = porLote
      .find((l) => l.tabla === 'vuelo')
      ?.filtros.find((f) => f.op === 'in')?.args[1] as string[];
    expect(ids).toEqual(expect.arrayContaining([V1, V_BORRADO]));
  });

  it('si la BD no responde, NO borra nada de ese tipo (ante la duda, se queda)', async () => {
    const { service } = armar(
      rutasVerificacion({
        vuelo: (q) =>
          tiene(q, 'in')
            ? { data: null, error: { message: 'timeout' } }
            : { data: [], error: null },
      }),
    );

    await service.reconcileVentana();

    const borrados = idsBorrados();
    expect(borrados).not.toContain('ev-huerfano');
    expect(borrados).not.toContain('ev-dup');
    // Los otros tipos sí se limpian (el fallo no contamina al resto).
    expect(borrados.sort()).toEqual(
      ['ev-descanso-viejo', 'ev-evento-viejo'].sort(),
    );
    const estado = await service.estadoSyncCompleto();
    expect(estado.ultimo_resumen?.huerfanos_borrados).toBe(2);
    expect(estado.ultimo_resumen?.errores).toBeGreaterThan(0);
  });

  it('si Google no deja listar, no borra nada y lo cuenta como error', async () => {
    eventosGoogle.list.mockReset();
    eventosGoogle.list.mockRejectedValue(new Error('Backend Error'));
    const { service } = armar(rutasVerificacion());

    await service.reconcileVentana();

    expect(eventosGoogle.delete).not.toHaveBeenCalled();
    const estado = await service.estadoSyncCompleto();
    expect(estado.ultimo_resumen?.huerfanos_borrados).toBe(0);
    expect(estado.ultimo_resumen?.errores).toBe(1);
  });

  it('el backfill manual (POST /resync) NO hace el paso inverso', async () => {
    const { service } = armar(rutasVerificacion());

    const r = await service.resyncTodo();

    expect(eventosGoogle.list).not.toHaveBeenCalled();
    expect(eventosGoogle.delete).not.toHaveBeenCalled();
    expect(r.huerfanos_borrados).toBe(0);
  });
});

// ===== ANCLA DEL DESCANSO =====

describe('CalendarSyncService — el descanso lleva vuelatour_descanso_id', () => {
  it('el evento del descanso se puede reconocer como NUESTRO', async () => {
    const { service } = armar({});

    await service.upsertDescansoEvent({
      id: D1,
      piloto_nombre: 'Luis',
      fecha_inicio: '2026-09-01',
      fecha_fin: '2026-09-03',
    });

    const body = (
      argsGoogle(eventosGoogle.insert) as unknown as {
        requestBody: {
          summary: string;
          extendedProperties?: { private?: Record<string, string> };
        };
      }
    ).requestBody;
    expect(body.summary).toBe('😴 Descansa · Luis');
    expect(body.extendedProperties?.private?.[ANCLA_DESCANSO]).toBe(D1);
    // Y el paso inverso lo clasifica como descanso.
    expect(
      clasificarEventoSistema({
        id: 'ev-d',
        extendedProperties: body.extendedProperties,
      }),
    ).toMatchObject({ tipo: 'descanso', entidadId: D1 });
  });

  it('el barrido manda el id del descanso que acaba de leer', async () => {
    const { service } = armar({
      vuelo: () => ({ data: [], error: null }),
      piloto_descanso: (q) =>
        tiene(q, 'in') || q.metodo === 'update'
          ? { data: [], error: null }
          : {
              data: [
                {
                  id: D1,
                  fecha_inicio: '2026-09-01',
                  fecha_fin: '2026-09-02',
                  motivo: null,
                  google_calendar_id: null,
                  piloto: { nombre: 'Luis' },
                },
              ],
              error: null,
            },
      evento_flota: () => ({ data: [], error: null }),
      mantenimiento: () => ({ data: [], error: null }),
    });

    await service.resyncTodo();

    const body = (
      argsGoogle(eventosGoogle.insert) as unknown as {
        requestBody: {
          extendedProperties?: { private?: Record<string, string> };
        };
      }
    ).requestBody;
    expect(body.extendedProperties?.private?.[ANCLA_DESCANSO]).toBe(D1);
  });
});

// ===== RESUMEN PERSISTIDO =====

describe('CalendarSyncService — el resumen sobrevive un redeploy', () => {
  it('el reconcile GUARDA su resumen en calendar_sync_estado', async () => {
    const guardados: Consulta[] = [];
    const { service } = armar(
      {
        vuelo: () => ({ data: [], error: null }),
        piloto_descanso: () => ({ data: [], error: null }),
        evento_flota: () => ({ data: [], error: null }),
        mantenimiento: () => ({ data: [], error: null }),
        calendar_sync_estado: (q) => {
          if (q.metodo === 'upsert') guardados.push(q);
          return { data: null, error: null };
        },
      },
      { rpc: estadoActivo },
    );

    await service.reconcileVentana();

    expect(guardados).toHaveLength(1);
    const payload = guardados[0].payload as {
      clave: string;
      valor: {
        ultimo_reconcile_at: string;
        ultimo_resumen: { origen: string };
      };
    };
    expect(payload.clave).toBe(CLAVE_ESTADO_SYNC);
    expect(payload.valor.ultimo_reconcile_at).toEqual(expect.any(String));
    expect(payload.valor.ultimo_resumen.origen).toBe('reconcile');
  });

  it('un proceso NUEVO relee el resumen guardado (antes: null tras el deploy)', async () => {
    const RESUMEN = {
      origen: 'reconcile',
      vuelos: 7,
      descansos: 2,
      eventos: 1,
      mantenimientos: 3,
      errores: 0,
      huerfanos_borrados: 5,
      desde: '2026-08-13',
      hasta: '2027-09-12',
      at: '2026-09-13T05:20:00.000Z',
    };
    const { service } = armar(
      {
        calendar_sync_estado: (q) => {
          const clave = q.filtros.find((f) => f.op === 'eq')?.args[1];
          if (clave === CLAVE_ESTADO_SYNC) {
            return {
              data: {
                valor: {
                  ultimo_reconcile_at: RESUMEN.at,
                  ultimo_resync_at: null,
                  ultimo_resumen: RESUMEN,
                },
              },
              error: null,
            };
          }
          if (clave === CLAVE_ESTADO_WORKER) {
            return {
              data: {
                valor: { ultimo_drenado_at: '2026-09-13T05:00:00.000Z' },
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      },
      { rpc: estadoActivo },
    );

    const estado = await service.estadoSyncCompleto();

    expect(estado.ultimo_reconcile_at).toBe(RESUMEN.at);
    expect(estado.ultimo_resumen).toEqual(RESUMEN);
  });

  it('sin la migración aplicada NO consulta la tabla nueva (todo como hoy)', async () => {
    const { service, llamadas } = armar({});

    const estado = await service.estadoSyncCompleto();

    expect(estado.ultimo_resumen).toBeNull();
    expect(llamadas.filter((l) => l.tabla === 'calendar_sync_estado')).toEqual(
      [],
    );
  });
});

// ===== CANDADO MULTI-RÉPLICA =====

describe('CalendarSyncService — candado en BD (Railway: 1 réplica hoy)', () => {
  const rutasVacias = {
    vuelo: () => ({ data: [], error: null }),
    piloto_descanso: () => ({ data: [], error: null }),
    evento_flota: () => ({ data: [], error: null }),
    mantenimiento: () => ({ data: [], error: null }),
    calendar_sync_estado: () => ({ data: null, error: null }),
  };

  it('candado AUSENTE (migración pendiente): corre igual, como hoy', async () => {
    const { service, rpcs } = armar(rutasVacias);

    await service.reconcileVentana();

    // Sondeó una vez, no encontró la función y siguió adelante.
    expect(rpcs.map((r) => r.nombre)).toEqual(['calendar_sync_estado_activa']);
    expect(eventosGoogle.list).toHaveBeenCalledTimes(1);
    const estado = await service.estadoSyncCompleto();
    expect(estado.ultimo_reconcile_at).toEqual(expect.any(String));
  });

  it('concedido: toma 912001, corre y lo SUELTA', async () => {
    const { service, rpcs } = armar(rutasVacias, { rpc: estadoActivo });

    await service.reconcileVentana();

    expect(rpcs.map((r) => r.nombre)).toEqual([
      'calendar_sync_estado_activa',
      'calendar_sync_lock',
      'calendar_sync_unlock',
    ]);
    expect(rpcs[1].params?.p_clave).toBe(CANDADO_BARRIDO);
    expect(rpcs[2].params?.p_clave).toBe(CANDADO_BARRIDO);
    expect(eventosGoogle.list).toHaveBeenCalledTimes(1);
  });

  it('OCUPADO por otra réplica: el reconcile se salta (no escribe a Google)', async () => {
    const { service, rpcs } = armar(rutasVacias, {
      rpc: (nombre) =>
        nombre === 'calendar_sync_lock'
          ? { data: false, error: null }
          : estadoActivo(nombre),
    });

    await service.reconcileVentana();

    expect(eventosGoogle.list).not.toHaveBeenCalled();
    expect(eventosGoogle.insert).not.toHaveBeenCalled();
    // No suelta un candado que no tomó.
    expect(rpcs.map((r) => r.nombre)).not.toContain('calendar_sync_unlock');
  });

  it('OCUPADO: POST /resync responde 409 (no un calendario a medias)', async () => {
    const { service } = armar(rutasVacias, {
      rpc: (nombre) =>
        nombre === 'calendar_sync_lock'
          ? { data: false, error: null }
          : estadoActivo(nombre),
    });

    await expect(service.resyncTodo()).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(eventosGoogle.insert).not.toHaveBeenCalled();
  });

  it('el worker toma su propio candado (912002) antes de drenar', async () => {
    const { service, rpcs } = armar(
      {
        calendar_sync_cola: (q) => {
          if (q.opciones?.head) return { count: 0, error: null };
          return { data: [], error: null };
        },
        calendar_sync_estado: () => ({ data: null, error: null }),
      },
      {
        rpc: (nombre) =>
          nombre === 'calendar_sync_cola_activa'
            ? { data: true, error: null }
            : estadoActivo(nombre),
      },
    );

    await service.drenarCola();

    const claves = rpcs
      .filter((r) => r.nombre === 'calendar_sync_lock')
      .map((r) => r.params?.p_clave);
    expect(claves).toEqual([CANDADO_DRENADO]);
    expect(rpcs.map((r) => r.nombre)).toContain('calendar_sync_unlock');
  });

  it('worker OCUPADO: no toma items de la cola', async () => {
    const consultas: Consulta[] = [];
    const { service } = armar(
      {
        calendar_sync_cola: (q) => {
          consultas.push(q);
          return { data: [], error: null };
        },
        calendar_sync_estado: () => ({ data: null, error: null }),
      },
      {
        rpc: (nombre) => {
          if (nombre === 'calendar_sync_cola_activa')
            return { data: true, error: null };
          if (nombre === 'calendar_sync_lock')
            return { data: false, error: null };
          return estadoActivo(nombre);
        },
      },
    );

    await service.drenarCola();

    expect(consultas).toHaveLength(0);
  });
});

// ===== REVISIÓN ADVERSARIA (12-sep-2026): lo que NO puede pasar nunca =====
//
// Tres agujeros encontrados leyendo el paso inverso como atacante, más los dos
// de volumen que abrió la ventana de 395 días. Todos acaban en lo mismo: un
// evento VIVO borrado, o un cambio que se dejó de publicar sin que nadie se
// entere.

const gaxios = (status: number, msg: string) =>
  Object.assign(new Error(msg), { code: status, response: { status } });

/** Página pedida en la n-ésima lectura (arg 0 de `range`). */
const rangoDe = (q: Consulta): number =>
  (q.filtros.find((f) => f.op === 'range')?.args[0] as number) ?? 0;

describe('paso inverso — lecturas de BD PAGINADAS (max-rows 1000)', () => {
  it('un tramo en la fila 1001 NO se borra: la lectura de escalas pagina', async () => {
    // 1000 tramos de relleno en la 1.ª página + el tramo de verdad en la 2.ª.
    // Sin paginar, `ev-tramo` no aparecía en `vivos` y el paso inverso lo
    // borraba como «duplicado fantasma»: un evento VIVO menos en el
    // calendario de la oficina, sin error, sin log y sin forma de notarlo.
    const relleno = Array.from({ length: 1000 }, (_, i) => ({
      vuelo_id: V1,
      google_calendar_id: `relleno-${i}`,
    }));
    const paginas: number[] = [];
    const { service } = armar({
      vuelo: (q) =>
        tiene(q, 'in')
          ? {
              data: [
                {
                  id: V1,
                  google_calendar_id: 'ev-vivo',
                  google_calendar_regreso_id: null,
                },
              ],
              error: null,
            }
          : { data: [], error: null },
      escala: (q) => {
        const desde = rangoDe(q);
        paginas.push(desde);
        return {
          data:
            desde === 0
              ? relleno
              : [{ vuelo_id: V1, google_calendar_id: 'ev-tramo' }],
          error: null,
        };
      },
      piloto_descanso: ventanaVacia,
      evento_flota: ventanaVacia,
      mantenimiento: ventanaVacia,
    });
    eventosGoogle.list.mockReset();
    eventosGoogle.list.mockResolvedValue({
      data: {
        items: [
          evGoogle('ev-vivo', { [ANCLA_VUELO]: V1 }),
          evGoogle('ev-tramo', { [ANCLA_VUELO]: V1 }),
        ],
      },
    });

    await service.reconcileVentana();

    expect(paginas).toEqual([0, 1000]);
    expect(idsBorrados()).toEqual([]);
  });

  it('el barrido pagina los VUELOS de la ventana (395 días > 1000 filas)', async () => {
    const pagina1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `v-${i}`,
      estado: 'CONFIRMADO',
    }));
    const paginas: number[] = [];
    const { service } = armar({
      vuelo: (q) => {
        const desde = rangoDe(q);
        paginas.push(desde);
        return {
          data: desde === 0 ? pagina1 : [{ id: 'v-1000', estado: 'RESERVA' }],
          error: null,
        };
      },
      piloto_descanso: ventanaVacia,
      evento_flota: ventanaVacia,
      mantenimiento: ventanaVacia,
    });
    const sync = jest.spyOn(service, 'syncFlight').mockResolvedValue(true);

    await service.reconcileVentana();

    // Sin paginar, el vuelo 1001 (y todos los siguientes) no se publicaban
    // NUNCA y el resumen decía «0 errores».
    expect(paginas).toEqual([0, 1000]);
    expect(sync).toHaveBeenCalledTimes(1001);
    const estado = await service.estadoSyncCompleto();
    expect(estado.ultimo_resumen?.vuelos).toBe(1001);
  });

  it('los descansos de la ventana también paginan', async () => {
    const fila = (i: number) => ({
      id: `d-${i}`,
      fecha_inicio: '2026-09-01',
      fecha_fin: '2026-09-02',
      motivo: null,
      google_calendar_id: 'ev-d',
      piloto: { nombre: 'Luis' },
    });
    const paginas: number[] = [];
    const { service } = armar({
      vuelo: ventanaVacia,
      piloto_descanso: (q) => {
        if (q.metodo === 'update' || tiene(q, 'in'))
          return { data: [], error: null };
        const desde = rangoDe(q);
        paginas.push(desde);
        return {
          data:
            desde === 0
              ? Array.from({ length: 1000 }, (_, i) => fila(i))
              : [fila(1000)],
          error: null,
        };
      },
      evento_flota: ventanaVacia,
      mantenimiento: ventanaVacia,
    });

    await service.resyncTodo();

    expect(paginas).toEqual([0, 1000]);
  });
});

describe('paso inverso — un evento RECIÉN creado no se borra', () => {
  it('el hueco insert→guardar id no cuesta un evento vivo', async () => {
    // Sin la cola activa los ~30 hooks escriben DIRECTO a Google a cualquier
    // hora (también durante la media hora del reconcile) y guardan el
    // `google_calendar_id` un instante DESPUÉS del insert. Si el paso inverso
    // lo lista en ese hueco, la fila apunta a null ⇒ «duplicado fantasma».
    const { service } = armar({
      vuelo: (q) =>
        tiene(q, 'in')
          ? {
              data: [
                {
                  id: V1,
                  google_calendar_id: null,
                  google_calendar_regreso_id: null,
                },
              ],
              error: null,
            }
          : { data: [], error: null },
      escala: () => ({ data: [], error: null }),
      piloto_descanso: ventanaVacia,
      evento_flota: ventanaVacia,
      mantenimiento: ventanaVacia,
    });
    eventosGoogle.list.mockReset();
    eventosGoogle.list.mockResolvedValue({
      data: {
        items: [
          // Nacido hace 5 s: puede ser el de un hook que todavía no guardó.
          {
            ...evGoogle('ev-nuevo', { [ANCLA_VUELO]: V1 }),
            created: new Date(Date.now() - 5_000).toISOString(),
          },
          // Nacido hace una hora: ese sí es un fantasma.
          {
            ...evGoogle('ev-viejo', { [ANCLA_VUELO]: V1 }),
            created: new Date(Date.now() - 3_600_000).toISOString(),
          },
          // Sin `created` (Google no lo mandó): se decide como siempre.
          evGoogle('ev-sin-created', { [ANCLA_VUELO]: V1 }),
        ],
      },
    });

    await service.reconcileVentana();

    expect(idsBorrados().sort()).toEqual(['ev-sin-created', 'ev-viejo']);
    const estado = await service.estadoSyncCompleto();
    expect(estado.ultimo_resumen?.huerfanos_borrados).toBe(2);
  });
});

describe('barrido vs barrido — ni dos resync, ni resync + reconcile', () => {
  const rutasVacias = {
    vuelo: ventanaVacia,
    piloto_descanso: ventanaVacia,
    evento_flota: ventanaVacia,
    mantenimiento: ventanaVacia,
  };

  it('SIN la migración (hoy) el 2.º resync responde 409, no duplica eventos', async () => {
    // El candado de BD no existe todavía: la exclusión tiene que ser de
    // memoria o los dos barridos hacen `events.insert` del mismo evento.
    const { service } = armar(rutasVacias);

    const primero = service.resyncTodo();
    await expect(service.resyncTodo()).rejects.toBeInstanceOf(
      ConflictException,
    );
    await primero;
  });

  it('el reconcile nocturno se salta si hay un resync corriendo', async () => {
    const { service } = armar(rutasVacias);

    const resync = service.resyncTodo();
    await service.reconcileVentana();
    await resync;

    // El reconcile no llegó a listar: su paso inverso no corrió.
    expect(eventosGoogle.list).not.toHaveBeenCalled();
    const estado = await service.estadoSyncCompleto();
    expect(estado.ultimo_reconcile_at).toBeNull();
    expect(estado.ultimo_resync_at).toEqual(expect.any(String));
  });
});

describe('barrido — cuota de Google a media pasada', () => {
  it('ABANDONA la pasada y NO decide borrados con media foto de Google', async () => {
    const { service } = armar({
      vuelo: (q) =>
        tiene(q, 'in')
          ? { data: [], error: null }
          : {
              data: [
                { id: 'v-1', estado: 'CONFIRMADO' },
                { id: 'v-2', estado: 'CONFIRMADO' },
                { id: 'v-3', estado: 'CONFIRMADO' },
              ],
              error: null,
            },
      piloto_descanso: ventanaVacia,
      evento_flota: ventanaVacia,
      mantenimiento: ventanaVacia,
    });
    const sync = jest
      .spyOn(service, 'syncFlight')
      .mockImplementationOnce(() => {
        // Lo que hace `notarFalloGoogle` con un 403/429 de Google.
        (
          service as unknown as {
            notarFalloGoogle: (e: unknown, c: string) => void;
          }
        ).notarFalloGoogle(gaxios(403, 'Rate Limit Exceeded'), 'vuelo v-1');
        return Promise.resolve(true);
      })
      .mockResolvedValue(true);

    await service.reconcileVentana();

    // Se publicó el primero y se cortó: seguir era regalarle miles de
    // llamadas condenadas al mismo calendario que dijo «basta».
    expect(sync).toHaveBeenCalledTimes(1);
    // Y el paso inverso NO corrió: con la vista de Google incompleta no se
    // borra nada.
    expect(eventosGoogle.list).not.toHaveBeenCalled();
    expect(eventosGoogle.delete).not.toHaveBeenCalled();
    const estado = await service.estadoSyncCompleto();
    expect(estado.ultimo_resumen?.errores).toBeGreaterThan(0);
    expect(estado.ultimo_resumen?.huerfanos_borrados).toBe(0);
  });
});

describe('candado — identidad del dueño y unlock acotado', () => {
  it('lock y unlock viajan con p_dueno (y es el MISMO en los dos)', async () => {
    const { service, rpcs } = armar(
      {
        vuelo: ventanaVacia,
        piloto_descanso: ventanaVacia,
        evento_flota: ventanaVacia,
        mantenimiento: ventanaVacia,
        calendar_sync_estado: () => ({ data: null, error: null }),
      },
      { rpc: estadoActivo },
    );

    await service.reconcileVentana();

    const lock = rpcs.find((r) => r.nombre === 'calendar_sync_lock');
    const unlock = rpcs.find((r) => r.nombre === 'calendar_sync_unlock');
    expect(lock?.params?.p_dueno).toEqual(expect.stringContaining('api:'));
    // Acotar el unlock al dueño evita que una réplica atrasada borre el
    // arrendamiento que otra acaba de tomar legítimamente.
    expect(unlock?.params?.p_dueno).toBe(lock?.params?.p_dueno);
  });
});

describe('estado persistido — una lectura fallida se REINTENTA', () => {
  it('un blip de red al arrancar no deja el panel en «nunca corrió»', async () => {
    let falla = true;
    const { service } = armar(
      {
        calendar_sync_estado: (q) => {
          if (falla) return { data: null, error: { message: 'timeout' } };
          const clave = q.filtros.find((f) => f.op === 'eq')?.args[1];
          return clave === CLAVE_ESTADO_SYNC
            ? {
                data: {
                  valor: {
                    ultimo_reconcile_at: '2026-09-12T05:20:00.000Z',
                    ultimo_resync_at: null,
                    ultimo_resumen: null,
                  },
                },
                error: null,
              }
            : { data: null, error: null };
        },
      },
      { rpc: estadoActivo },
    );

    // 1.ª lectura: la BD no contesta ⇒ no se marca hidratado.
    expect((await service.estadoSyncCompleto()).ultimo_reconcile_at).toBeNull();
    falla = false;
    // 2.ª: se vuelve a intentar y aparece lo que corrió de madrugada.
    expect((await service.estadoSyncCompleto()).ultimo_reconcile_at).toBe(
      '2026-09-12T05:20:00.000Z',
    );
  });
});
