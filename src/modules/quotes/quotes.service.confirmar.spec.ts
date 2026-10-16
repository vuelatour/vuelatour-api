// Módulos pesados que quotes.service importa solo para inyección (mismos
// stubs que quotes.service.spec.ts).
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
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { FlightsService } from '../flights/flights.service';

/**
 * `QuotesService.confirm` con CAS por estado (revisión 16-oct-2026): desde
 * que la app también confirma un COTIZADO (`POST /flights/:id/confirmar`
 * → token CONFIRMADOR_COTIZACION), dos confirmaciones casi a la vez no
 * deben duplicar tramos del REDONDO, correo ni avisos. Supabase se simula
 * con un builder encadenable: se prueba el CONTRATO, no la BD.
 */
type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };

const METODOS = [
  'select',
  'eq',
  'neq',
  'in',
  'is',
  'order',
  'limit',
  'insert',
  'update',
];

function fakeSupabase(
  resolver: (tabla: string, ops: Op[]) => { data?: unknown; count?: number },
) {
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
          error: null,
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

const eqDe = (ops: Op[], col: string): unknown =>
  ops.find((o) => o.m === 'eq' && o.args[0] === col)?.args[1];

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const USER = 'aaaaaaaa-0000-4000-8000-0000000000f1';

function vueloRow(extra: Row = {}): Row {
  return {
    id: V1,
    folio: 241,
    // Sin cliente: el correo de confirmación (best-effort) no se intenta.
    cliente_id: null,
    aeronave_id: null,
    piloto_id: null,
    copiloto_id: null,
    apoyo_id: null,
    tipo: 'SENCILLO',
    estado: 'COTIZADO',
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    fecha_vuelo: '2026-10-20T14:00:00+00:00',
    fecha_confirmacion: null,
    grupo_id: null,
    ...extra,
  };
}

function armar(m: { vuelo?: Row; casPierde?: Row }) {
  const updates: Row[] = [];
  let lecturas = 0;
  const { supabase, llamadas } = fakeSupabase((tabla, ops) => {
    const upd = ops.find((o) => o.m === 'update');
    if (tabla !== 'vuelo') return {};
    if (upd) {
      updates.push(upd.args[0] as Row);
      if (m.casPierde) return { data: null };
      return { data: { ...(m.vuelo ?? vueloRow()), ...(upd.args[0] as Row) } };
    }
    lecturas += 1;
    if (lecturas > 1 && m.casPierde) return { data: m.casPierde };
    return { data: m.vuelo ?? vueloRow() };
  });
  const syncFlight = jest.fn().mockResolvedValue(undefined);
  const notifyUser = jest.fn().mockResolvedValue(true);
  const service = new QuotesService(
    {} as AircraftService,
    {} as AirportsService,
    {} as RoutesService,
    supabase,
    { syncFlight } as unknown as CalendarSyncService,
    {} as EmailService,
    { notifyUser } as unknown as NotificationsService,
    {} as FlightsService,
  );
  return { service, llamadas, updates, syncFlight, notifyUser };
}

const esperarAvisos = () => new Promise((r) => setImmediate(r));

describe('QuotesService.confirm — CAS por estado (revisión 16-oct-2026)', () => {
  it('COTIZADO ⇒ UPDATE acotado por id Y estado=COTIZADO; CONFIRMADO + fecha_confirmacion; calendario', async () => {
    const w = armar({});
    const out = await w.service.confirm(V1, USER);
    expect(w.updates).toHaveLength(1);
    expect(w.updates[0].estado).toBe('CONFIRMADO');
    expect(typeof w.updates[0].fecha_confirmacion).toBe('string');
    const escritura = w.llamadas.find((l) =>
      l.ops.some((o) => o.m === 'update'),
    );
    expect(eqDe(escritura!.ops, 'id')).toBe(V1);
    expect(eqDe(escritura!.ops, 'estado')).toBe('COTIZADO');
    expect(out.estado).toBe('CONFIRMADO');
    expect(out).not.toHaveProperty('idempotente');
    expect(w.syncFlight).toHaveBeenCalledWith(V1);
    await esperarAvisos();
  });

  it('no COTIZADO ⇒ 409 de siempre sin escribir', async () => {
    const w = armar({ vuelo: vueloRow({ estado: 'RESERVA' }) });
    await expect(w.service.confirm(V1, USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(w.updates).toHaveLength(0);
  });

  it('CAS pierde y la relectura ya está CONFIRMADO ⇒ la fila con idempotente: true, SIN calendario ni avisos', async () => {
    const w = armar({
      casPierde: vueloRow({
        estado: 'CONFIRMADO',
        fecha_confirmacion: '2026-10-16T15:00:00+00:00',
      }),
    });
    const out = await w.service.confirm(V1, USER);
    expect(out).toMatchObject({
      id: V1,
      estado: 'CONFIRMADO',
      idempotente: true,
    });
    expect(w.updates).toHaveLength(1);
    expect(w.syncFlight).not.toHaveBeenCalled();
    await esperarAvisos();
    expect(w.notifyUser).not.toHaveBeenCalled();
    // Ni tramos: la tabla `escala` no se toca.
    expect(w.llamadas.some((l) => l.tabla === 'escala')).toBe(false);
  });

  it('CAS pierde y la relectura está CANCELADO ⇒ 409 con el estado vivo', async () => {
    const w = armar({ casPierde: vueloRow({ estado: 'CANCELADO' }) });
    await expect(w.service.confirm(V1, USER)).rejects.toThrow(
      /Estado actual: CANCELADO/,
    );
    expect(w.syncFlight).not.toHaveBeenCalled();
  });
});
