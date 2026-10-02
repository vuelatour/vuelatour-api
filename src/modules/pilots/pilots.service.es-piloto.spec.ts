// Mismos mocks de módulos pesados que los specs de flights (jose es ESM).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../calendar/calendar.service', () => ({
  CalendarService: class {},
}));

import { Logger } from '@nestjs/common';
import { PilotsService } from './pilots.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { CalendarService } from '../calendar/calendar.service';
import type { UsersService } from '../users/users.service';
import type { NotificationsService } from '../realtime/notifications.service';

/**
 * Lista de pilotos (2-oct-2026, «Pilotos: editar datos»): la fila trae
 * `es_piloto` (el panel pinta el switch «También es piloto» del diálogo
 * «Editar datos»; sin el campo lo deshabilita) y `apodo` con la MISMA
 * degradación que `users.service` (42703 ⇒ se apaga UNA vez y se sigue sin
 * la columna).
 */

type Res = {
  data: unknown;
  error: null | { code?: string; message: string };
  count?: number;
};
type Llamada = { tabla: string; metodo: string; args: unknown[] };

/** Doble de Supabase: cada consulta a una tabla consume el siguiente Res. */
function armarSupabase(tablas: Record<string, Res[]>) {
  const llamadas: Llamada[] = [];
  const cursor: Record<string, number> = {};
  const siguiente = (tabla: string): Res => {
    const lista = tablas[tabla] ?? [{ data: null, error: null }];
    const i = cursor[tabla] ?? 0;
    cursor[tabla] = i + 1;
    return lista[Math.min(i, lista.length - 1)];
  };
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    const registra =
      (metodo: string) =>
      (...args: unknown[]) => {
        llamadas.push({ tabla, metodo, args });
        return q;
      };
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'not',
      'or',
      'gte',
      'lte',
      'ilike',
      'order',
      'limit',
      'range',
      'insert',
      'update',
    ]) {
      q[m] = registra(m);
    }
    q.maybeSingle = () => Promise.resolve(siguiente(tabla));
    q.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(siguiente(tabla)).then(resolve, reject);
    return q;
  };
  return { llamadas, service: { from } };
}

/** Pablo Canales: ADMIN que también vuela (doble rol). */
const PABLO = {
  id: 'e5aa04a8-0000-4000-8000-000000000001',
  supabase_auth_id: 'auth-pablo',
  nombre: 'Pablo Canales',
  email: 'pablo@vuelatour.com',
  rol: 'ADMIN',
  estado: 'ACTIVO',
  tiene_fondo_caja: false,
  tarjeta_terminacion: '',
  es_piloto: true,
  es_piloto_externo: false,
  telefono: '',
  avatar_url: '',
  apodo: 'Pab',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
};

const ERROR_42703 = {
  code: '42703',
  message: 'column usuario.apodo does not exist',
};

function armar(usuario: Res[]) {
  const sb = armarSupabase({ usuario });
  const service = new PilotsService(
    { service: sb.service } as unknown as SupabaseService,
    {} as CalendarSyncService,
    {} as CalendarService,
    {} as UsersService,
    {} as NotificationsService,
  );
  return { service, llamadas: sb.llamadas };
}

const selectsDeUsuario = (llamadas: Llamada[]) =>
  llamadas
    .filter((l) => l.tabla === 'usuario' && l.metodo === 'select')
    .map((l) => String(l.args[0]));

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('PilotsService.list — es_piloto y apodo', () => {
  it('devuelve es_piloto: true para un ADMIN que vuela (Pablo Canales)', async () => {
    const { service, llamadas } = armar([
      { data: [PABLO], error: null, count: 1 },
    ]);

    const r = await service.list({ limit: 100, offset: 0 });

    expect(r.count).toBe(1);
    expect(r.data[0]).toMatchObject({
      id: PABLO.id,
      rol: 'ADMIN',
      es_piloto: true,
      apodo: 'Pab',
    });
    const cols = selectsDeUsuario(llamadas)[0]
      .split(',')
      .map((c) => c.trim());
    expect(cols).toEqual(
      expect.arrayContaining(['es_piloto', 'es_piloto_externo', 'apodo']),
    );
    // Sigue filtrando a quien VUELA (rol PILOTO o doble rol).
    expect(
      llamadas.some(
        (l) =>
          l.tabla === 'usuario' &&
          l.metodo === 'or' &&
          l.args[0] === 'rol.eq.PILOTO,es_piloto.eq.true',
      ),
    ).toBe(true);
  });

  it('MIGRACIÓN del apodo pendiente (42703): se degrada UNA vez y no tumba la lista', async () => {
    const { service, llamadas } = armar([
      { data: null, error: ERROR_42703 },
      { data: [{ ...PABLO, apodo: undefined }], error: null, count: 1 },
    ]);

    const r = await service.list({ limit: 100, offset: 0 });
    expect(r.data[0]).toMatchObject({ id: PABLO.id, es_piloto: true });

    await service.list({ limit: 100, offset: 0 });
    const selects = selectsDeUsuario(llamadas);
    // 1.ª lista: sondeo con apodo + reintento sin él; 2.ª: directo sin él.
    expect(selects).toHaveLength(3);
    expect(selects[0]).toContain('apodo');
    expect(selects[1]).not.toContain('apodo');
    expect(selects[1]).toContain('es_piloto,');
    expect(selects[2]).not.toContain('apodo');
  });

  it('un error que NO es «columna inexistente» se propaga tal cual', async () => {
    const { service, llamadas } = armar([
      { data: null, error: { code: '57014', message: 'timeout' } },
    ]);
    await expect(service.list({ limit: 100, offset: 0 })).rejects.toThrow(
      /timeout/,
    );
    expect(selectsDeUsuario(llamadas)).toHaveLength(1);
  });
});
