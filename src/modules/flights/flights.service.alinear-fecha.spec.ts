// Mismos stubs que el resto de los specs de flights: notifications arrastra
// el gateway y `jose` (ESM), calendar-sync googleapis, vision el SDK de IA y
// pilots el stack de push.
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

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FlightsService } from './flights.service';
import { fechaHoraCancun } from '../../common/fecha-cancun.util';
import {
  CODE_OPERACION_CAMBIO,
  CODE_SIN_FECHA,
  CODE_TRAMOS_NO_MOVIDOS,
  CODE_VUELO_CANCELADO,
  CODE_VUELO_YA_VOLO,
  MENSAJE_OPERACION_CAMBIO,
  MENSAJE_VUELO_YA_VOLO,
} from './alinear-fecha.util';
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
 * ALINEAR LA FECHA DE LOS TRAMOS CON LA COTIZACIÓN (5-oct-2026, API 0.0.55,
 * invariante 42). BD EN MEMORIA que INTERPRETA los filtros
 * (`eq/is/gte/lte/order/limit`) y aplica los UPDATE: los CAS del servicio se
 * prueban de verdad, no por la forma de la consulta.
 */
type Row = Record<string, unknown>;
type Filtro = (r: Row) => boolean;

const V = 'aaaaaaaa-0000-4000-8000-000000000338';
const USER = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const PILOTO = 'aaaaaaaa-0000-4000-8000-0000000000bb';
const COPILOTO = 'aaaaaaaa-0000-4000-8000-0000000000cc';

const comoInstante = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const comparar = (a: unknown, b: unknown): number => {
  const ta = comoInstante(a);
  const tb = comoInstante(b);
  if (ta != null && tb != null) return ta - tb;
  return String(a).localeCompare(String(b));
};

interface Opciones {
  /** Error de BD en el (o los) n-ésimo UPDATE de `escala` (1 = el primero). */
  errorEnUpdateEscala?: number | number[];
  /** Corre ANTES de cada UPDATE (simula a otra persona escribiendo). */
  antesDeUpdate?: (tabla: string, n: number) => void;
}

function bdEnMemoria(tablas: Record<string, Row[]>, opts: Opciones = {}) {
  const updates: { tabla: string; patch: Row; filas: number }[] = [];
  const conteo: Record<string, number> = {};
  const service = {
    from(tabla: string) {
      const filtros: Filtro[] = [];
      let patch: Row | null = null;
      let orden: { col: string; asc: boolean } | null = null;
      let limite: number | null = null;
      const ejecutar = (): { data: Row[]; error: unknown } => {
        const filas = tablas[tabla] ?? [];
        if (patch) {
          conteo[tabla] = (conteo[tabla] ?? 0) + 1;
          const n = conteo[tabla];
          opts.antesDeUpdate?.(tabla, n);
          const fallas = ([] as number[]).concat(
            opts.errorEnUpdateEscala ?? [],
          );
          if (tabla === 'escala' && fallas.includes(n)) {
            return { data: [], error: { message: 'timeout de escritura' } };
          }
          const tocadas = filas.filter((r) => filtros.every((f) => f(r)));
          for (const r of tocadas) Object.assign(r, patch);
          updates.push({ tabla, patch, filas: tocadas.length });
          return { data: tocadas.map((r) => ({ ...r })), error: null };
        }
        let res = filas.filter((r) => filtros.every((f) => f(r)));
        if (orden) {
          const { col, asc } = orden;
          res = [...res].sort(
            (a, b) => (asc ? 1 : -1) * comparar(a[col], b[col]),
          );
        }
        if (limite != null) res = res.slice(0, limite);
        return { data: res.map((r) => ({ ...r })), error: null };
      };
      const q: Record<string, unknown> = {
        select: () => q,
        update: (p: Row) => {
          patch = p;
          return q;
        },
        eq: (col: string, v: unknown) => {
          filtros.push((r) => r[col] === v);
          return q;
        },
        is: (col: string, v: unknown) => {
          filtros.push((r) => (v === null ? r[col] == null : r[col] === v));
          return q;
        },
        gte: (col: string, v: unknown) => {
          filtros.push((r) => r[col] != null && comparar(r[col], v) >= 0);
          return q;
        },
        lte: (col: string, v: unknown) => {
          filtros.push((r) => r[col] != null && comparar(r[col], v) <= 0);
          return q;
        },
        in: (col: string, vs: unknown[]) => {
          filtros.push((r) => vs.includes(r[col]));
          return q;
        },
        order: (col: string, o?: { ascending?: boolean }) => {
          orden = { col, asc: o?.ascending !== false };
          return q;
        },
        limit: (n: number) => {
          limite = n;
          return q;
        },
        maybeSingle: () => {
          const r = ejecutar();
          return Promise.resolve({ data: r.data[0] ?? null, error: r.error });
        },
        single: () => {
          const r = ejecutar();
          return Promise.resolve({ data: r.data[0] ?? null, error: r.error });
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar()).then(res, rej),
      };
      return q;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, updates };
}

/** Vuelo #338 CUN → CZM: la cotización ya dice el 13-oct (revise). */
function vuelo(extra: Row = {}): Row {
  return {
    id: V,
    folio: 338,
    estado: 'CONFIRMADO',
    origen_iata: 'CUN',
    destino_iata: 'CZM',
    piloto_id: PILOTO,
    copiloto_id: null,
    apoyo_id: null,
    grupo_id: null,
    fecha_vuelo: '2026-10-13T14:00:00+00:00',
    fecha_traslado_final: null,
    ...extra,
  };
}

function escala(
  id: string,
  orden: number,
  fecha: string | null,
  extra: Row = {},
): Row {
  return {
    id,
    vuelo_id: V,
    orden,
    origen_iata: orden === 1 ? 'CUN' : 'CZM',
    destino_iata: orden === 1 ? 'CZM' : 'CUN',
    fecha_salida_plan: fecha,
    taco_salida: null,
    taco_llegada: null,
    cancelada_at: null,
    piloto_id: null,
    copiloto_id: null,
    updated_by: null,
    ...extra,
  };
}

function armar(v: Row | null, escalas: Row[], opts: Opciones = {}) {
  const tablas: Record<string, Row[]> = {
    vuelo: v ? [v] : [],
    escala: escalas,
    vuelo_apoyo: [],
  };
  const { supabase, updates } = bdEnMemoria(tablas, opts);
  const notifyUser = jest
    .fn<Promise<boolean>, [string, Record<string, unknown>]>()
    .mockResolvedValue(true);
  const syncFlight = jest.fn().mockResolvedValue(true);
  const refreshPermisosDeVuelo = jest.fn().mockResolvedValue(false);
  const flights = new FlightsService(
    supabase,
    { syncFlight } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {
      notifyUser,
      notifyRole: jest.fn().mockResolvedValue(true),
    } as unknown as NotificationsService,
    {
      findBlockingExpirations: jest.fn().mockResolvedValue([]),
    } as unknown as ExpirationsService,
    { refreshPermisosDeVuelo } as unknown as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
  const notificar = jest.spyOn(
    flights as unknown as {
      notificarTripulacion: (...a: unknown[]) => Promise<void>;
    },
    'notificarTripulacion',
  );
  return {
    flights,
    tablas,
    updates,
    notifyUser,
    syncFlight,
    refreshPermisosDeVuelo,
    notificar,
  };
}

/** Los avisos salen con `void`: dejar que terminen. */
const vaciarPromesas = async () => {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
};

async function errorDe(p: Promise<unknown>): Promise<{
  e: unknown;
  cuerpo: { message?: string; error?: string; details?: Row };
}> {
  try {
    await p;
  } catch (e) {
    const cuerpo =
      e && typeof (e as { getResponse?: unknown }).getResponse === 'function'
        ? ((e as { getResponse: () => unknown }).getResponse() as {
            message?: string;
            error?: string;
            details?: Row;
          })
        : {};
    return { e, cuerpo };
  }
  throw new Error('se esperaba un error');
}

const horaPared = (t: Row) => fechaHoraCancun(t.fecha_salida_plan as string);

describe('FlightsService.alinearFechaTramos', () => {
  it('delta POSITIVO: mueve los tramos al día de la cotización conservando la hora de pared', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-10T22:30:00+00:00');
    const m = armar(vuelo(), [t1, t2]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);

    expect(r.delta_dias).toBe(3);
    expect(r.tramos_movidos).toBe(2);
    expect(r.fecha_objetivo).toBe('2026-10-13T14:00:00.000Z');
    expect(r.folio).toBe(338);
    expect([horaPared(t1), horaPared(t2)]).toEqual([
      '2026-10-13 09:00',
      '2026-10-13 17:30',
    ]);
    expect(t1.updated_by).toBe(USER);
    expect(t2.updated_by).toBe(USER);
    expect(r.tramos).toEqual([
      expect.objectContaining({
        id: 'e1',
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'CZM',
        fecha_salida_plan_antes: '2026-10-10T14:00:00+00:00',
        fecha_salida_plan: '2026-10-13T14:00:00.000Z',
        movido: true,
      }),
      expect.objectContaining({
        id: 'e2',
        fecha_salida_plan: '2026-10-13T22:30:00.000Z',
        movido: true,
      }),
    ]);
    // La fecha del VUELO no se toca (la escribió la cotización).
    expect(m.tablas.vuelo[0].fecha_vuelo).toBe('2026-10-13T14:00:00+00:00');
    expect(m.updates.filter((u) => u.tabla === 'vuelo')).toHaveLength(0);
    expect(m.refreshPermisosDeVuelo).toHaveBeenCalledWith(V);
    expect(m.syncFlight).toHaveBeenCalledWith(V);
  });

  it('delta NEGATIVO', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const m = armar(vuelo({ fecha_vuelo: '2026-10-08T14:00:00+00:00' }), [t1]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    expect(r.delta_dias).toBe(-2);
    expect(horaPared(t1)).toBe('2026-10-08 09:00');
  });

  it('el DÍA es el de Cancún: un tramo de las 22:00 no se corre un día', async () => {
    // 10-oct 22:00 y 23:30 Cancún (ya 11-oct en UTC). Cotización: 13-oct.
    const t1 = escala('e1', 1, '2026-10-11T03:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-11T04:30:00+00:00');
    const m = armar(vuelo(), [t1, t2]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    expect(r.delta_dias).toBe(3);
    expect([horaPared(t1), horaPared(t2)]).toEqual([
      '2026-10-13 22:00',
      '2026-10-13 23:30',
    ]);
  });

  it('MULTI-DÍA con regreso alineado: tramos y regreso se mueven los mismos días', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-10T18:00:00+00:00');
    const t3 = escala('e3', 3, '2026-10-12T21:00:00+00:00');
    const v = vuelo({
      fecha_vuelo: '2026-10-15T14:00:00+00:00',
      fecha_traslado_final: '2026-10-12T21:00:00+00:00',
    });
    const m = armar(v, [t1, t2, t3]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    expect(r.delta_dias).toBe(5);
    expect([horaPared(t1), horaPared(t2), horaPared(t3)]).toEqual([
      '2026-10-15 09:00',
      '2026-10-15 13:00',
      '2026-10-17 16:00',
    ]);
    expect(v.fecha_traslado_final).toBe('2026-10-17T21:00:00.000Z');
    expect(v.updated_by).toBe(USER);
    expect(r.fecha_traslado_final).toBe('2026-10-17T21:00:00.000Z');
    expect(r.fecha_traslado_final_antes).toBe('2026-10-12T21:00:00+00:00');
    expect(r.fecha_traslado_final_movida).toBe(true);
    expect(r.tramos_movidos).toBe(3);
  });

  it('MULTI-DÍA cuando la cotización YA movió el regreso: no lo mueve dos veces', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t3 = escala('e3', 2, '2026-10-12T21:00:00+00:00');
    const v = vuelo({
      fecha_vuelo: '2026-10-15T14:00:00+00:00',
      fecha_traslado_final: '2026-10-17T21:00:00+00:00',
    });
    const m = armar(v, [t1, t3]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    expect(horaPared(t3)).toBe('2026-10-17 16:00');
    expect(v.fecha_traslado_final).toBe('2026-10-17T21:00:00+00:00');
    expect(r.fecha_traslado_final_movida).toBe(false);
    expect(m.updates.filter((u) => u.tabla === 'vuelo')).toHaveLength(0);
  });

  it('tramo SIN fecha se queda sin fecha y no cuenta', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, null);
    const m = armar(vuelo(), [t1, t2]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    expect(r.tramos_movidos).toBe(1);
    expect(t2.fecha_salida_plan).toBeNull();
    expect(r.tramos[1]).toEqual(
      expect.objectContaining({
        id: 'e2',
        fecha_salida_plan_antes: null,
        fecha_salida_plan: null,
        movido: false,
      }),
    );
  });

  it('ningún tramo con fecha: el tramo 1 recibe la fecha del vuelo tal cual (delta null)', async () => {
    const t1 = escala('e1', 1, null);
    const t2 = escala('e2', 2, null);
    const m = armar(vuelo(), [t1, t2]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    expect(r.delta_dias).toBeNull();
    expect(t1.fecha_salida_plan).toBe('2026-10-13T14:00:00.000Z');
    expect(t2.fecha_salida_plan).toBeNull();
    expect(r.tramos_movidos).toBe(1);
  });

  it('los tramos CANCELADOS no se tocan ni son referencia', async () => {
    const cancelado = escala('e0', 1, '2026-10-01T14:00:00+00:00', {
      cancelada_at: '2026-10-02T00:00:00+00:00',
    });
    const t2 = escala('e2', 2, '2026-10-10T14:00:00+00:00');
    const m = armar(vuelo(), [cancelado, t2]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    expect(r.delta_dias).toBe(3);
    expect(cancelado.fecha_salida_plan).toBe('2026-10-01T14:00:00+00:00');
    expect(r.tramos.map((t) => t.id)).toEqual(['e2']);
  });

  it('delta 0 NO ESCRIBE nada (idempotente) ni avisa', async () => {
    // Mismo día Cancún que el tramo 1, otra hora.
    const t1 = escala('e1', 1, '2026-10-13T16:00:00+00:00');
    const m = armar(vuelo(), [t1]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    await vaciarPromesas();
    expect(r.delta_dias).toBe(0);
    expect(r.tramos_movidos).toBe(0);
    expect(m.updates).toHaveLength(0);
    expect(t1.fecha_salida_plan).toBe('2026-10-13T16:00:00+00:00');
    expect(m.refreshPermisosDeVuelo).not.toHaveBeenCalled();
    expect(m.syncFlight).not.toHaveBeenCalled();
    expect(m.notificar).not.toHaveBeenCalled();
  });

  it('un segundo «Sí» (reintento) ya no suma días', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const m = armar(vuelo(), [t1]);
    await m.flights.alinearFechaTramos(V, {}, USER);
    const escriturasPrimera = m.updates.length;
    const r2 = await m.flights.alinearFechaTramos(V, {}, USER);
    expect(r2.delta_dias).toBe(0);
    expect(m.updates).toHaveLength(escriturasPrimera);
    expect(horaPared(t1)).toBe('2026-10-13 09:00');
  });

  it.each([
    ['EN_VUELO', {}],
    ['COMPLETADO', {}],
    ['CONFIRMADO', { taco_llegada: 1520.4 }],
    ['CONFIRMADO', { taco_salida: 0 }],
  ])(
    'YA VOLÓ (estado %s, tramo %j) ⇒ 409 VUELO_YA_VOLO sin escribir nada',
    async (estado, tacos) => {
      const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00', tacos);
      const t2 = escala('e2', 2, '2026-10-10T18:00:00+00:00');
      const m = armar(vuelo({ estado }), [t1, t2]);
      const { e, cuerpo } = await errorDe(
        m.flights.alinearFechaTramos(V, {}, USER),
      );
      await vaciarPromesas();
      expect(e).toBeInstanceOf(ConflictException);
      expect(cuerpo.error).toBe(CODE_VUELO_YA_VOLO);
      expect(cuerpo.message).toBe(MENSAJE_VUELO_YA_VOLO);
      expect(m.updates).toHaveLength(0);
      expect(t1.fecha_salida_plan).toBe('2026-10-10T14:00:00+00:00');
      expect(m.notificar).not.toHaveBeenCalled();
      expect(m.syncFlight).not.toHaveBeenCalled();
    },
  );

  it('un tramo CANCELADO con tacómetro no hace volado al vuelo', async () => {
    const cancelado = escala('e0', 1, '2026-10-10T12:00:00+00:00', {
      cancelada_at: '2026-10-02T00:00:00+00:00',
      taco_llegada: 1500,
    });
    const t2 = escala('e2', 2, '2026-10-10T14:00:00+00:00');
    const m = armar(vuelo(), [cancelado, t2]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    expect(r.tramos_movidos).toBe(1);
  });

  it('CANCELADO ⇒ 409 VUELO_CANCELADO sin escribir', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const m = armar(vuelo({ estado: 'CANCELADO' }), [t1]);
    const { e, cuerpo } = await errorDe(
      m.flights.alinearFechaTramos(V, {}, USER),
    );
    expect(e).toBeInstanceOf(ConflictException);
    expect(cuerpo.error).toBe(CODE_VUELO_CANCELADO);
    expect(m.updates).toHaveLength(0);
  });

  it('vuelo inexistente ⇒ 404 VUELO_NO_EXISTE', async () => {
    const m = armar(null, []);
    const { e, cuerpo } = await errorDe(
      m.flights.alinearFechaTramos(V, {}, USER),
    );
    expect(e).toBeInstanceOf(NotFoundException);
    expect(cuerpo.error).toBe('VUELO_NO_EXISTE');
  });

  it('sin fecha del vuelo ni en el cuerpo ⇒ 400 SIN_FECHA', async () => {
    const m = armar(vuelo({ fecha_vuelo: null }), [
      escala('e1', 1, '2026-10-10T14:00:00+00:00'),
    ]);
    const { e, cuerpo } = await errorDe(
      m.flights.alinearFechaTramos(V, {}, USER),
    );
    expect(e).toBeInstanceOf(BadRequestException);
    expect(cuerpo.error).toBe(CODE_SIN_FECHA);
    expect(m.updates).toHaveLength(0);
  });

  it('`fecha_vuelo` del cuerpo manda sobre la persistida (solo su día)', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const m = armar(vuelo(), [t1]);
    const r = await m.flights.alinearFechaTramos(
      V,
      { fecha_vuelo: '2026-10-20T23:00:00.000Z' },
      USER,
    );
    expect(r.delta_dias).toBe(10);
    expect(horaPared(t1)).toBe('2026-10-20 09:00');
  });

  it('CAS: un tramo que otra persona movió entre la lectura y la escritura NO se pisa', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-10T18:00:00+00:00');
    const m = armar(vuelo(), [t1, t2], {
      antesDeUpdate: (tabla, n) => {
        // Justo antes de escribir el tramo 2, la oficina lo reagenda.
        if (tabla === 'escala' && n === 2) {
          t2.fecha_salida_plan = '2026-10-11T19:00:00+00:00';
        }
      },
    });
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    expect(t2.fecha_salida_plan).toBe('2026-10-11T19:00:00+00:00');
    expect(r.tramos_movidos).toBe(1);
    expect(r.tramos[1]).toEqual(
      expect.objectContaining({ id: 'e2', movido: false }),
    );
    expect(horaPared(t1)).toBe('2026-10-13 09:00');
  });

  it('CAS: un tramo que capturó tacómetro mientras tanto NO se mueve (si es el ancla ⇒ 409 sin mover nada)', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const m = armar(vuelo(), [t1], {
      antesDeUpdate: (tabla) => {
        if (tabla === 'escala') t1.taco_salida = 1500.2;
      },
    });
    const { e, cuerpo } = await errorDe(
      m.flights.alinearFechaTramos(V, {}, USER),
    );
    await vaciarPromesas();
    expect(e).toBeInstanceOf(ConflictException);
    expect(cuerpo.error).toBe(CODE_OPERACION_CAMBIO);
    expect(t1.fecha_salida_plan).toBe('2026-10-10T14:00:00+00:00');
    expect(m.notificar).not.toHaveBeenCalled();
  });

  it('CAS del ANCLA: alguien movió el tramo de referencia ⇒ 409 OPERACION_CAMBIO y los demás NO se mueven', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-10T18:00:00+00:00');
    const m = armar(vuelo(), [t1, t2], {
      antesDeUpdate: (tabla, n) => {
        // Justo antes de escribir el ancla, la oficina la reagenda.
        if (tabla === 'escala' && n === 1) {
          t1.fecha_salida_plan = '2026-10-12T15:00:00+00:00';
        }
      },
    });
    const { e, cuerpo } = await errorDe(
      m.flights.alinearFechaTramos(V, {}, USER),
    );
    await vaciarPromesas();
    expect(e).toBeInstanceOf(ConflictException);
    expect(cuerpo.error).toBe(CODE_OPERACION_CAMBIO);
    expect(cuerpo.message).toBe(MENSAJE_OPERACION_CAMBIO);
    // Antes del arreglo t2 se movía +3 con un delta calculado sobre una
    // referencia que ya no existía.
    expect(t2.fecha_salida_plan).toBe('2026-10-10T18:00:00+00:00');
    expect(m.updates.filter((u) => u.filas > 0)).toHaveLength(0);
    expect(m.notificar).not.toHaveBeenCalled();
    expect(m.syncFlight).not.toHaveBeenCalled();
    expect(m.refreshPermisosDeVuelo).not.toHaveBeenCalled();
  });

  it('la BD falla a medio camino ⇒ 503 TRAMOS_NO_MOVIDOS y lo ya movido se REGRESA', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-10T18:00:00+00:00');
    const m = armar(vuelo(), [t1, t2], { errorEnUpdateEscala: 2 });
    const { e, cuerpo } = await errorDe(
      m.flights.alinearFechaTramos(V, {}, USER),
    );
    await vaciarPromesas();
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect(cuerpo.error).toBe(CODE_TRAMOS_NO_MOVIDOS);
    expect(cuerpo.details).toEqual(
      expect.objectContaining({
        revertido: true,
        tecnico: 'timeout de escritura',
      }),
    );
    // El tramo 1 volvió a su instante original.
    expect(Date.parse(t1.fecha_salida_plan as string)).toBe(
      Date.parse('2026-10-10T14:00:00+00:00'),
    );
    expect(t2.fecha_salida_plan).toBe('2026-10-10T18:00:00+00:00');
    expect(m.notificar).not.toHaveBeenCalled();
    expect(m.syncFlight).not.toHaveBeenCalled();
  });

  it('la BD falla y la REVERSA también ⇒ 503 a medias, pero permisos y Google se refrescan', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-10T18:00:00+00:00');
    // 1 = t1 (ok), 2 = t2 (falla), 3 = reversa de t1 (falla).
    const m = armar(vuelo(), [t1, t2], { errorEnUpdateEscala: [2, 3] });
    const { e, cuerpo } = await errorDe(
      m.flights.alinearFechaTramos(V, {}, USER),
    );
    await vaciarPromesas();
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect(cuerpo.error).toBe(CODE_TRAMOS_NO_MOVIDOS);
    expect(cuerpo.details).toEqual(
      expect.objectContaining({ revertido: false }),
    );
    expect(horaPared(t1)).toBe('2026-10-13 09:00');
    expect(m.refreshPermisosDeVuelo).toHaveBeenCalledWith(V);
    expect(m.syncFlight).toHaveBeenCalledWith(V);
    expect(m.notificar).not.toHaveBeenCalled();
  });

  it('REPRO de la revisión: tramo final llenado por revise con el regreso nuevo ⇒ no se mueve ni se reescribe el regreso', async () => {
    // Antes del guardado: tramo 1 el 10-oct 09:00, tramo 2 sin fecha, sin
    // regreso. La oficina guardó salida 15-oct 09:00 y regreso 17-oct 16:00:
    // revise dejó fecha_vuelo=15, fecha_traslado_final=17 21:00Z y el tramo
    // 2 en 17 21:00Z. Antes del arreglo: t2 y regreso al 22.
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-17T21:00:00+00:00');
    const v = vuelo({
      fecha_vuelo: '2026-10-15T14:00:00+00:00',
      fecha_traslado_final: '2026-10-17T21:00:00+00:00',
    });
    const m = armar(v, [t1, t2]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    await vaciarPromesas();
    expect(r.delta_dias).toBe(5);
    expect([horaPared(t1), horaPared(t2)]).toEqual([
      '2026-10-15 09:00',
      '2026-10-17 16:00',
    ]);
    expect(t2.fecha_salida_plan).toBe('2026-10-17T21:00:00+00:00');
    expect(v.fecha_traslado_final).toBe('2026-10-17T21:00:00+00:00');
    expect(m.updates.filter((u) => u.tabla === 'vuelo')).toHaveLength(0);
    expect(r.tramos_movidos).toBe(1);
    expect(r.fecha_traslado_final_movida).toBe(false);
    expect(r.tramos[1]).toEqual(
      expect.objectContaining({
        id: 'e2',
        movido: false,
        se_conserva: 'dia_del_regreso',
      }),
    );
  });

  it('viaje de UN día movido hacia atrás: tramos y regreso se mueven juntos', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-10T21:00:00+00:00');
    const v = vuelo({
      fecha_vuelo: '2026-10-09T14:00:00+00:00',
      fecha_traslado_final: '2026-10-10T21:00:00+00:00',
    });
    const m = armar(v, [t1, t2]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    expect([horaPared(t1), horaPared(t2)]).toEqual([
      '2026-10-09 09:00',
      '2026-10-09 16:00',
    ]);
    expect(v.fecha_traslado_final).toBe('2026-10-09T21:00:00.000Z');
    expect(r.fecha_traslado_final_movida).toBe(true);
  });

  it('aviso PROPIO a la tripulación, UNA vez, con cada tramo movido y su hora (no repite el «reagendado» de revise)', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00', {
      copiloto_id: COPILOTO,
    });
    const m = armar(vuelo(), [t1]);
    await m.flights.alinearFechaTramos(V, {}, USER);
    await vaciarPromesas();
    expect(m.notificar).toHaveBeenCalledTimes(1);
    const destinatarios = m.notifyUser.mock.calls.map((c) => c[0]);
    expect(destinatarios.sort()).toEqual([PILOTO, COPILOTO].sort());
    const aviso = m.notifyUser.mock.calls[0][1] as {
      tipo: string;
      titulo: string;
      cuerpo: string;
      data: Row;
      link: string;
    };
    // Mismo `tipo` de siempre: la app lo pinta con su ícono y el tap abre
    // el vuelo (`data.vuelo_id`); lo distinto es el texto.
    expect(aviso.tipo).toBe('vuelo_asignado');
    expect(aviso.titulo).toBe('Vuelo #338: la operación cambió de día');
    expect(aviso.cuerpo).toBe(
      'Tramos movidos (hora Cancún): CUN → CZM mar 13 oct 09:00.',
    );
    expect(aviso.data).toEqual(expect.objectContaining({ vuelo_id: V }));
    expect(aviso.link).toBe(`/flights/${V}`);
  });

  it('multi-día: el aviso nombra cada tramo con SU hora (y solo los que se movieron)', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-12T21:00:00+00:00');
    const m = armar(
      vuelo({
        fecha_vuelo: '2026-10-15T14:00:00+00:00',
        fecha_traslado_final: '2026-10-12T21:00:00+00:00',
      }),
      [t1, t2],
    );
    await m.flights.alinearFechaTramos(V, {}, USER);
    await vaciarPromesas();
    const aviso = m.notifyUser.mock.calls[0][1] as { cuerpo: string };
    expect(aviso.cuerpo).toBe(
      'Tramos movidos (hora Cancún): CUN → CZM jue 15 oct 09:00 · CZM → CUN sáb 17 oct 16:00.',
    );
  });

  it('el aviso no anuncia un tramo que NO se movió (CAS de un tramo no-ancla)', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const t2 = escala('e2', 2, '2026-10-10T18:00:00+00:00');
    const m = armar(vuelo(), [t1, t2], {
      antesDeUpdate: (tabla, n) => {
        if (tabla === 'escala' && n === 2) {
          t2.fecha_salida_plan = '2026-10-11T19:00:00+00:00';
        }
      },
    });
    await m.flights.alinearFechaTramos(V, {}, USER);
    await vaciarPromesas();
    const aviso = m.notifyUser.mock.calls[0][1] as { cuerpo: string };
    expect(aviso.cuerpo).toBe(
      'Tramos movidos (hora Cancún): CUN → CZM mar 13 oct 09:00.',
    );
  });

  it('sin tripulación asignada: se mueve pero no sale ningún aviso', async () => {
    const t1 = escala('e1', 1, '2026-10-10T14:00:00+00:00');
    const m = armar(vuelo({ piloto_id: null }), [t1]);
    const r = await m.flights.alinearFechaTramos(V, {}, USER);
    await vaciarPromesas();
    expect(r.tramos_movidos).toBe(1);
    expect(m.notifyUser).not.toHaveBeenCalled();
  });
});
