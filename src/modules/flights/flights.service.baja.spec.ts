// Mismos stubs que flights.service.reserva.spec.ts: notifications arrastra el
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

import { HttpException } from '@nestjs/common';
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
 * Baja de vuelos desde la app sin internet (10-sep-2026): `deleteFlight`
 * con motivo y `cancel` con 409 ESTRUCTURADOS. Supabase se simula con un
 * builder encadenable; aquí se prueba el CONTRATO (codes, message intacto,
 * motivo en vuelo_eliminado, nada se borra cuando rebota), no la BD.
 */
type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };
type Resultado = {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number | null;
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
  'order',
  'limit',
  'insert',
  'update',
  'delete',
];

function fakeSupabase(resolver: (tabla: string, ops: Op[]) => Resultado) {
  const llamadas: { tabla: string; ops: Op[] }[] = [];
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      llamadas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => {
        const r = resolver(tabla, ops);
        return {
          data: r.data === undefined ? (lista ? [] : null) : r.data,
          error: r.error ?? null,
          count: r.count ?? null,
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

const tiene = (ops: Op[], m: string): boolean => ops.some((o) => o.m === m);
const esHead = (ops: Op[]): boolean =>
  ops.some(
    (o) =>
      o.m === 'select' && (o.args[1] as { head?: boolean } | undefined)?.head,
  );
const selectDe = (ops: Op[]): string => {
  const sel = ops.find((o) => o.m === 'select')?.args[0];
  return typeof sel === 'string' ? sel : '';
};

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const LLAVE = 'aaaaaaaa-0000-4000-8000-00000000cccc';
const PILOTO = 'aaaaaaaa-0000-4000-8000-00000000000b';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';

function vueloRow(extra: Row = {}): Row {
  return {
    id: V1,
    folio: 118,
    cliente_id: 'aaaaaaaa-0000-4000-8000-00000000000d',
    aeronave_id: 'aaaaaaaa-0000-4000-8000-00000000000a',
    piloto_id: PILOTO,
    copiloto_id: null,
    apoyo_id: null,
    estado: 'RESERVA',
    cobrado: false,
    facturado: false,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    fecha_vuelo: '2026-09-14T14:00:00+00:00',
    grupo_id: null,
    combinado_con_id: null,
    notas_internas: null,
    ...extra,
  };
}

interface Mundo {
  /** Fila del vuelo (null = no existe). */
  vuelo?: Row | null;
  nCobros?: number;
  nGastos?: number;
  nTacos?: number;
  /** El DELETE de vuelo falla (revierte la bitácora). */
  deleteError?: boolean;
}

function armar(m: Mundo) {
  const inserts: Record<string, unknown[]> = {};
  const updates: Record<string, unknown[]> = {};
  const deletes: string[] = [];
  const { supabase, llamadas } = fakeSupabase((tabla, ops) => {
    const ins = ops.find((o) => o.m === 'insert');
    const upd = ops.find((o) => o.m === 'update');
    if (ins) (inserts[tabla] ??= []).push(ins.args[0]);
    if (upd) (updates[tabla] ??= []).push(upd.args[0]);
    if (tiene(ops, 'delete')) deletes.push(tabla);
    switch (tabla) {
      case 'vuelo':
        if (tiene(ops, 'delete'))
          return m.deleteError ? { error: { message: 'FK RESTRICT' } } : {};
        if (upd)
          return {
            data: { ...(m.vuelo ?? vueloRow()), ...(upd.args[0] as Row) },
          };
        return { data: m.vuelo === undefined ? vueloRow() : m.vuelo };
      case 'cobro_vuelo':
        return esHead(ops) ? { count: m.nCobros ?? 0 } : { data: [] };
      case 'gasto':
        return esHead(ops) ? { count: m.nGastos ?? 0 } : { data: [] };
      case 'escala':
        if (tiene(ops, 'delete')) return {};
        if (esHead(ops)) return { count: m.nTacos ?? 0 };
        if (selectDe(ops) === '*')
          return { data: [{ id: 'e-1', vuelo_id: V1, orden: 1 }] };
        return {
          data: [{ id: 'e-1', piloto_id: PILOTO, copiloto_id: null }],
        };
      case 'vuelo_apoyo':
        return { data: [] };
      case 'cliente':
        return { data: { nombre: 'Juan Pérez' } };
      case 'aeronave':
        return { data: { matricula: 'XA-VGV' } };
      case 'vuelo_eliminado':
        if (ins) return { data: { id: 'be-1' } };
        if (tiene(ops, 'delete')) return {};
        return {};
      default:
        return {};
    }
  });
  // Los jest.fn se conservan aparte para afirmar sobre ellos sin desatar
  // el método del objeto tipado (regla unbound-method).
  const notifyUser = jest.fn().mockResolvedValue(true);
  const syncFlight = jest.fn().mockResolvedValue(undefined);
  const removeFlight = jest.fn().mockResolvedValue(undefined);
  const notifications = {
    notifyUser,
    notifyUserDetallado: jest.fn().mockResolvedValue({ notificado: true }),
    notifyRole: jest.fn().mockResolvedValue(true),
  } as unknown as NotificationsService;
  const calendar = {
    syncFlight,
    removeFlight,
  } as unknown as CalendarSyncService;
  const service = new FlightsService(
    supabase,
    calendar,
    {} as EmailService,
    {} as VisionService,
    notifications,
    {
      findBlockingExpirations: jest.fn().mockResolvedValue([]),
    } as unknown as ExpirationsService,
    { refreshPermisosDeVuelo: jest.fn() } as unknown as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
  return {
    service,
    llamadas,
    inserts,
    updates,
    deletes,
    notifyUser,
    syncFlight,
    removeFlight,
  };
}

/** status + code + message de una HttpException estructurada. */
async function rebote(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    const r = err.getResponse() as Record<string, unknown>;
    return {
      status: err.getStatus(),
      code: r.error as string,
      message: err.message,
      details: r.details as Record<string, unknown> | undefined,
    };
  }
  throw new Error('no rebotó');
}

describe('deleteFlight — motivo desde la app', () => {
  it('con motivo + client_request_id: bitácora "eliminado desde la app: …", traza en el snapshot, borra y responde folio', async () => {
    const w = armar({});
    const out = await w.service.deleteFlight(V1, USER, {
      motivo: '  El cliente nunca confirmó  ',
      clientRequestId: LLAVE,
    });
    expect(out).toEqual({ deleted: true, id: V1, folio: 118 });
    const bit = w.inserts.vuelo_eliminado[0] as Row;
    expect(bit.motivo).toBe(
      'eliminado desde la app: El cliente nunca confirmó',
    );
    expect(bit.eliminado_por).toBe(USER);
    expect((bit.snapshot as Row).app).toEqual({ client_request_id: LLAVE });
    expect(w.deletes).toEqual([
      'cotizacion_version_history',
      'escala',
      'vuelo',
    ]);
    expect(w.removeFlight).toHaveBeenCalledWith(V1);
    expect(w.notifyUser).toHaveBeenCalledWith(
      PILOTO,
      expect.objectContaining({ titulo: 'Vuelo #118 eliminado' }),
    );
  });

  it('sin body (panel viejo): conserva "eliminado desde panel" y el snapshot no lleva traza', async () => {
    const w = armar({});
    const out = await w.service.deleteFlight(V1, USER);
    expect(out.deleted).toBe(true);
    const bit = w.inserts.vuelo_eliminado[0] as Row;
    expect(bit.motivo).toBe('eliminado desde panel');
    expect((bit.snapshot as Row).app).toBeUndefined();
  });

  it('motivo vacío/espacios sin llave se trata como sin motivo (panel)', async () => {
    const w = armar({});
    await w.service.deleteFlight(V1, USER, { motivo: '   ' });
    expect((w.inserts.vuelo_eliminado[0] as Row).motivo).toBe(
      'eliminado desde panel',
    );
  });

  it('motivo vacío PERO con client_request_id: la bitácora dice "desde la app" (nunca "panel")', async () => {
    const w = armar({});
    await w.service.deleteFlight(V1, USER, {
      motivo: '   ',
      clientRequestId: LLAVE,
    });
    const bit = w.inserts.vuelo_eliminado[0] as Row;
    expect(bit.motivo).toBe('eliminado desde la app');
    expect((bit.snapshot as Row).app).toEqual({ client_request_id: LLAVE });
  });

  it('cobrado → 409 VUELO_COBRADO_O_FACTURADO con el message de siempre y SIN tocar nada', async () => {
    const w = armar({ vuelo: vueloRow({ cobrado: true }) });
    const r = await rebote(
      w.service.deleteFlight(V1, USER, { motivo: 'Motivo válido' }),
    );
    expect(r.status).toBe(409);
    expect(r.code).toBe('VUELO_COBRADO_O_FACTURADO');
    expect(r.message).toBe(
      'El vuelo ya fue cobrado/facturado; cancélalo en lugar de borrarlo.',
    );
    expect(w.inserts.vuelo_eliminado).toBeUndefined();
    expect(w.deletes).toEqual([]);
  });

  it('con gastos → 409 VUELO_CON_ACTIVIDAD + details {cobros, gastos, tacos} numéricos, sin borrar', async () => {
    const w = armar({ nGastos: 2, nTacos: 1 });
    const r = await rebote(w.service.deleteFlight(V1, USER));
    expect(r.status).toBe(409);
    expect(r.code).toBe('VUELO_CON_ACTIVIDAD');
    expect(r.message).toBe(
      'El vuelo tiene actividad registrada (cobros, gastos o tacómetros); cancélalo en lugar de borrarlo para no perder el rastro.',
    );
    expect(r.details).toEqual({ cobros: 0, gastos: 2, tacos: 1 });
    expect(w.inserts.vuelo_eliminado).toBeUndefined();
    expect(w.deletes).toEqual([]);
  });

  it('el vuelo ya no existe → 404 VUELO_NO_EXISTE (la app lo toma como éxito idempotente)', async () => {
    const w = armar({ vuelo: null });
    const r = await rebote(
      w.service.deleteFlight(V1, USER, { motivo: 'x'.repeat(5) }),
    );
    expect(r.status).toBe(404);
    expect(r.code).toBe('VUELO_NO_EXISTE');
    expect(r.message).toBe(`Vuelo ${V1} not found`);
    expect(r.details).toEqual({ vuelo_id: V1 });
    expect(w.deletes).toEqual([]);
  });

  it('si el DELETE del vuelo falla se revierte la bitácora (fila be-1) y el error sube', async () => {
    const w = armar({ deleteError: true });
    await expect(w.service.deleteFlight(V1, USER)).rejects.toThrow(
      'FK RESTRICT',
    );
    const rev = w.llamadas.find(
      (l) => l.tabla === 'vuelo_eliminado' && tiene(l.ops, 'delete'),
    );
    expect(rev).toBeDefined();
  });
});

describe('cancel — 409 estructurados', () => {
  it('ya CANCELADO → 409 VUELO_YA_CANCELADO con el message de siempre y sin update', async () => {
    const w = armar({ vuelo: vueloRow({ estado: 'CANCELADO' }) });
    const r = await rebote(w.service.cancel(V1, 'Cliente canceló', USER));
    expect(r.status).toBe(409);
    expect(r.code).toBe('VUELO_YA_CANCELADO');
    expect(r.message).toBe('No se puede cancelar un vuelo en estado CANCELADO');
    expect(r.details).toEqual({ estado: 'CANCELADO', folio: 118 });
    expect(w.updates.vuelo).toBeUndefined();
  });

  it('COMPLETADO → 409 VUELO_COMPLETADO (fallo visible) sin update', async () => {
    const w = armar({ vuelo: vueloRow({ estado: 'COMPLETADO' }) });
    const r = await rebote(w.service.cancel(V1, 'Cliente canceló', USER));
    expect(r.status).toBe(409);
    expect(r.code).toBe('VUELO_COMPLETADO');
    expect(r.message).toBe(
      'No se puede cancelar un vuelo en estado COMPLETADO',
    );
    expect(w.updates.vuelo).toBeUndefined();
  });

  it('inexistente → 404 VUELO_NO_EXISTE', async () => {
    const w = armar({ vuelo: null });
    const r = await rebote(w.service.cancel(V1, 'Cliente canceló', USER));
    expect(r.status).toBe(404);
    expect(r.code).toBe('VUELO_NO_EXISTE');
  });

  it('CONFIRMADO → CANCELADO con sello del motivo en notas_internas (contrato intacto)', async () => {
    const w = armar({ vuelo: vueloRow({ estado: 'CONFIRMADO' }) });
    const out = await w.service.cancel(V1, 'Cliente canceló', USER);
    const upd = w.updates.vuelo[0] as Row;
    expect(upd.estado).toBe('CANCELADO');
    expect(upd.updated_by).toBe(USER);
    expect(String(upd.notas_internas)).toMatch(
      /^\[Cancelado .*\] Cliente canceló$/,
    );
    expect(out.estado).toBe('CANCELADO');
    expect(w.syncFlight).toHaveBeenCalledWith(V1);
    // Avisos best-effort en segundo plano: dejar que terminen.
    await new Promise((r) => setImmediate(r));
  });
});
