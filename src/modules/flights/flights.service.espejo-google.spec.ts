// Mismos stubs que flights.service.ola-b.spec.ts: notifications arrastra el
// gateway y `jose` (ESM), calendar-sync googleapis, vision el SDK de IA y
// pilots calendar/users (push, firebase).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pilots/pilots.service', () => ({ PilotsService: class {} }));

import { Logger } from '@nestjs/common';
import { FlightsService } from './flights.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';

/**
 * ESPEJO A GOOGLE CALENDAR desde `flights` — huecos H3 y H5 de la auditoría
 * del 12-sep-2026, corregidos en la revisión adversaria del mismo día.
 *
 * H3 `updateEscala`: el espejo solo se disparaba al cambiar la RUTA o la
 * FECHA, pero `buildLegEvent` pinta también `orden`, `pasajeros` y `es_ferry`
 * («T2 Ferry · N4142R · CUN-PTU · Luis · 3 pax»). Es el PATCH que usa el
 * editor único de la app (manda TODO el DTO explícito, también desde su
 * outbox al reconectar), así que editar los pasajeros dejaba el evento de
 * Google mintiendo hasta la reconciliación de la madrugada.
 *
 * H5 + huérfano `deleteEscala`: el evento del tramo se borraba NUNCA (tras el
 * `.delete()` ya no hay `google_calendar_id` que leer) y `syncFlight` corría
 * ANTES de `refreshPermisosDeVuelo` (el cambio de permiso no se espejaba).
 *
 * Estas pruebas valen con o sin la cola de la migración 20260912000002: son
 * el cinturón para el periodo en que la cola no esté aplicada.
 */
type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };
type Resultado = {
  data?: unknown;
  error?: { code?: string; message: string } | null;
};

const METODOS = [
  'select',
  'eq',
  'neq',
  'in',
  'is',
  'not',
  'or',
  'gte',
  'lte',
  'gt',
  'lt',
  'order',
  'limit',
  'range',
  'insert',
  'update',
  'delete',
];

function fakeSupabase(
  resolver: (tabla: string, ops: Op[], lista: boolean) => Resultado,
) {
  const llamadas: { tabla: string; ops: Op[] }[] = [];
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      llamadas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => {
        const r = resolver(tabla, ops, lista);
        return {
          data: r.data === undefined ? (lista ? [] : null) : r.data,
          error: r.error ?? null,
          count: null,
        };
      };
      for (const m of METODOS) {
        q[m] = (...args: unknown[]) => {
          ops.push({ m, args });
          return q;
        };
      }
      q.maybeSingle = () => Promise.resolve(resolve(false));
      q.single = () => Promise.resolve(resolve(false));
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(true)).then(res, rej);
      return q;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, llamadas };
}

const selectDe = (ops: Op[]): string => {
  const sel = ops.find((o) => o.m === 'select')?.args[0];
  return typeof sel === 'string' ? sel : '';
};
const tiene = (ops: Op[], m: string): boolean => ops.some((o) => o.m === m);

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const E1 = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const USER = 'aaaaaaaa-0000-4000-8000-0000000000u1';

/** Tramo previo (lo que `updateEscala`/`deleteEscala` leen antes de escribir). */
const TRAMO_PREV: Row = {
  id: E1,
  vuelo_id: V1,
  orden: 2,
  origen_iata: 'CUN',
  destino_iata: 'PTU',
  fecha_salida_plan: '2026-10-01T15:00:00.000Z',
  pasajeros: 3,
  es_ferry: false,
  taco_salida: null,
  taco_llegada: null,
  google_calendar_id: 'ev-tramo-2',
  piloto_id: null,
  updated_at: '2026-09-10T12:00:00.000Z',
  vuelo: { estado: 'CONFIRMADO' },
};

function armar(opts: { tramoNuevo?: Row } = {}) {
  const orden: string[] = [];
  const { supabase, llamadas } = fakeSupabase((tabla, ops, lista) => {
    const esUpdate = tiene(ops, 'update');
    const esDelete = tiene(ops, 'delete');
    if (tabla === 'escala') {
      if (esDelete) {
        orden.push('escala.delete');
        return { data: null };
      }
      if (esUpdate) {
        orden.push('escala.update');
        return { data: { ...TRAMO_PREV, ...(opts.tramoNuevo ?? {}) } };
      }
      return lista ? { data: [] } : { data: TRAMO_PREV };
    }
    if (tabla === 'vuelo') {
      return lista
        ? { data: [] }
        : { data: { id: V1, folio: 250, estado: 'CONFIRMADO' } };
    }
    return lista ? { data: [] } : { data: null };
  });

  const syncFlight = jest.fn().mockImplementation(() => {
    orden.push('syncFlight');
    return Promise.resolve(true);
  });
  const removeEscalaEvent = jest.fn().mockImplementation(() => {
    orden.push('removeEscalaEvent');
    return Promise.resolve(undefined);
  });
  const refreshPermisosDeVuelo = jest.fn().mockImplementation(() => {
    orden.push('refreshPermisos');
    return Promise.resolve(true);
  });

  const service = new FlightsService(
    supabase,
    {
      syncFlight,
      removeFlight: jest.fn(),
      removeEscalaEvent,
    } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {
      notifyUser: jest.fn().mockResolvedValue(true),
      notifyRole: jest.fn().mockResolvedValue(true),
      notifyUserDetallado: jest.fn().mockResolvedValue({ notificado: true }),
    } as unknown as NotificationsService,
    {
      findBlockingExpirations: jest.fn().mockResolvedValue([]),
    } as unknown as ExpirationsService,
    { refreshPermisosDeVuelo } as unknown as AirportsService,
    {
      numero: jest.fn().mockResolvedValue(8.857),
    } as unknown as ConfiguracionService,
    {} as PilotsService,
  );
  // La notificación a la tripulación lee el vuelo completo: se calla.
  jest
    .spyOn(
      service as unknown as { findById: (id: string) => Promise<Row> },
      'findById',
    )
    .mockResolvedValue({ id: V1, folio: 250 });
  jest
    .spyOn(
      service as unknown as {
        notificarTripulacion: (...a: unknown[]) => Promise<void>;
      },
      'notificarTripulacion',
    )
    .mockResolvedValue(undefined);
  jest
    .spyOn(
      service as unknown as {
        notifyTramoCancelado: (...a: unknown[]) => Promise<void>;
      },
      'notifyTramoCancelado',
    )
    .mockResolvedValue(undefined);
  return {
    service,
    llamadas,
    orden,
    syncFlight,
    removeEscalaEvent,
    refreshPermisosDeVuelo,
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe('deleteEscala: el evento del tramo no queda huérfano (H5 + §4)', () => {
  it('borra el evento de Google ANTES del .delete() y con el id de la fila viva', async () => {
    const w = armar();
    await w.service.deleteEscala(E1);
    expect(w.removeEscalaEvent).toHaveBeenCalledWith('ev-tramo-2');
    expect(w.orden.indexOf('removeEscalaEvent')).toBeLessThan(
      w.orden.indexOf('escala.delete'),
    );
  });

  it('lee google_calendar_id en el select previo (sin él no hay nada que borrar)', async () => {
    const w = armar();
    await w.service.deleteEscala(E1);
    const lectura = w.llamadas.find(
      (l) => l.tabla === 'escala' && !tiene(l.ops, 'delete'),
    )!;
    expect(selectDe(lectura.ops)).toContain('google_calendar_id');
  });

  it('re-deriva el permiso ANTES de espejar (el ⚠ del título llega a Google)', async () => {
    const w = armar();
    await w.service.deleteEscala(E1);
    expect(w.refreshPermisosDeVuelo).toHaveBeenCalledWith(V1);
    expect(w.syncFlight).toHaveBeenCalledWith(V1);
    expect(w.orden.indexOf('refreshPermisos')).toBeLessThan(
      w.orden.indexOf('syncFlight'),
    );
  });
});

describe('updateEscala: espeja TODO lo que Google pinta del tramo (H3)', () => {
  it('cambiar PASAJEROS (sin tocar ruta ni fecha) sincroniza el calendario', async () => {
    const w = armar({ tramoNuevo: { pasajeros: 5 } });
    await w.service.updateEscala(E1, { pasajeros: 5 }, USER);
    expect(w.syncFlight).toHaveBeenCalledWith(V1);
  });

  it('marcar FERRY sincroniza (el título lleva el prefijo «Ferry» y 0 pax)', async () => {
    const w = armar({ tramoNuevo: { es_ferry: true, pasajeros: 0 } });
    await w.service.updateEscala(E1, { es_ferry: true }, USER);
    expect(w.syncFlight).toHaveBeenCalledWith(V1);
  });

  it('cambiar el ORDEN sincroniza (el título empieza por «T{orden}»)', async () => {
    const w = armar({ tramoNuevo: { orden: 3 } });
    await w.service.updateEscala(E1, { orden: 3 }, USER);
    expect(w.syncFlight).toHaveBeenCalledWith(V1);
  });

  it('reenviar los MISMOS valores (la app manda el DTO completo) NO espeja', async () => {
    const w = armar();
    await w.service.updateEscala(
      E1,
      { pasajeros: 3, es_ferry: false, orden: 2 },
      USER,
    );
    expect(w.syncFlight).not.toHaveBeenCalled();
  });

  it('un campo NO pintado (notas del tramo) no dispara espejo', async () => {
    const w = armar({ tramoNuevo: { notas: 'ver FBO' } });
    await w.service.updateEscala(E1, { notas: 'ver FBO' }, USER);
    expect(w.syncFlight).not.toHaveBeenCalled();
  });

  it('cambio de RUTA sigue espejando UNA sola vez (no se duplica con el nuevo camino)', async () => {
    const w = armar({ tramoNuevo: { destino_iata: 'HOL', pasajeros: 5 } });
    await w.service.updateEscala(
      E1,
      { destino_iata: 'HOL', pasajeros: 5 },
      USER,
    );
    expect(w.syncFlight).toHaveBeenCalledTimes(1);
  });
});
