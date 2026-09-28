// Mismos mocks de módulos pesados que el resto de los specs de flights.
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
import { Rol } from '../../common/types/auth.types';

/**
 * `GET /v1/flights/:id/gastos-resumen` + COMISIÓN DEL VENDEDOR (28-sep-2026,
 * invariante 31): la lista existe para que la TRIPULACIÓN no duplique
 * capturas; lo que se le paga al vendedor no es suyo ⇒ PILOTO y MECÁNICO no
 * ven los gastos `COMISION_VENDEDOR`; la oficina sí.
 *
 * El filtro va en JS, NUNCA en el query: un literal que el enum de la BD no
 * conoce revienta la LECTURA (22P02) — el falso de abajo truena si llega un
 * `.neq/.not/.in` sobre `categoria`.
 */
const VUELO = 'v-317';

function armar() {
  const consultas: Array<{ metodo: string; args: unknown[] }> = [];
  const filas = [
    {
      id: 'g-comida',
      categoria: 'COMIDA',
      monto: '250',
      moneda: 'MXN',
      medio_pago: 'EFECTIVO',
      fecha_gasto: '2026-09-25',
      notas: 'Comida tripulación',
      created_at: '2026-09-25T20:00:00Z',
      capturado_en: null,
      origen: 'PILOTO',
      usuario_captura_id: 'u-piloto',
      usuario: { nombre: 'Saab' },
    },
    {
      id: 'g-cv',
      categoria: 'COMISION_VENDEDOR',
      monto: '2030',
      moneda: 'MXN',
      medio_pago: 'TRANSFERENCIA',
      fecha_gasto: '2026-09-28',
      notas: 'Pago comisión Saab',
      created_at: '2026-09-28T18:00:00Z',
      capturado_en: null,
      origen: 'OFICINA',
      usuario_captura_id: 'u-admin',
      usuario: { nombre: 'Mary Cruz' },
    },
  ];
  const service = {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'neq', 'not', 'in']) {
        q[m] = (...args: unknown[]) => {
          consultas.push({ metodo: m, args });
          if (
            (m === 'neq' || m === 'not' || m === 'in') &&
            args[0] === 'categoria'
          ) {
            throw new Error(
              `22P02: filtro por categoría en PostgREST (${m}) — debe ir en JS`,
            );
          }
          return q;
        };
      }
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: filas, error: null }).then(res);
      return q;
    },
  };
  const svc = new FlightsService(
    { service } as unknown as SupabaseService,
    {} as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {} as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
  return { svc, consultas };
}

describe('FlightsService.gastosResumen — COMISION_VENDEDOR (28-sep-2026)', () => {
  it('PILOTO y MECÁNICO NO ven el pago al vendedor', async () => {
    for (const rol of [Rol.PILOTO, Rol.MECANICO]) {
      const { svc } = armar();
      const r = await svc.gastosResumen(VUELO, rol);
      expect(r.map((g) => g.id)).toEqual(['g-comida']);
    }
  });

  it('la OFICINA (y la llamada sin rol) lo sigue viendo', async () => {
    for (const rol of [Rol.ADMIN, Rol.COORDINADOR, undefined]) {
      const { svc } = armar();
      const r = await svc.gastosResumen(VUELO, rol);
      expect(r.map((g) => g.id)).toEqual(['g-comida', 'g-cv']);
      expect(r.find((g) => g.id === 'g-cv')!.categoria).toBe(
        'COMISION_VENDEDOR',
      );
    }
  });

  it('el query NO lleva filtro de categoría (el literal nuevo reventaría la lectura sin la migración)', async () => {
    const { svc, consultas } = armar();
    await svc.gastosResumen(VUELO, Rol.PILOTO);
    expect(
      consultas.filter(
        (c) =>
          ['neq', 'not', 'in', 'eq'].includes(c.metodo) &&
          c.args[0] === 'categoria',
      ),
    ).toEqual([]);
    expect(consultas).toContainEqual({
      metodo: 'eq',
      args: ['vuelo_id', VUELO],
    });
  });
});
