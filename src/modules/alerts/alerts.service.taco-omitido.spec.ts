// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { AlertsService, type AlertConfig } from './alerts.service';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { NotificationsService } from '../realtime/notifications.service';
import {
  fakeSupabase,
  type Tablas,
} from '../flights/taco-omitido.fixture-spec';

/**
 * Tacómetro omitido (15-oct-2026, invariante 79) en las alertas:
 * - el aviso de tramos 2+ («al aterrizar captura la llegada») SALTA el
 *   tramo con tacómetro omitido (no hay nada que capturar);
 * - «Vuelo #N sigue EN VUELO» dice que lo que falta está OMITIDO y que lo
 *   complete la oficina, en vez de «faltan lecturas de llegada».
 */

/** 16:00 UTC = 11:00 Cancún. */
const AHORA = new Date('2026-10-15T16:00:00Z');
const EN_10_MIN = new Date(AHORA.getTime() + 9.5 * 60_000).toISOString();

function armar(db: Tablas, migracion = true) {
  const { supabase, ops } = fakeSupabase(db, { migracion });
  const notifications = {
    notifyUser: jest.fn().mockResolvedValue(true),
    notifyRole: jest.fn().mockResolvedValue(1),
  };
  const svc = new AlertsService(
    supabase,
    {} as AircraftService,
    {} as AirportsService,
    notifications as unknown as NotificationsService,
    {} as EmailService,
    {} as ExpirationsService,
    {} as CalendarSyncService,
  );
  const priv = svc as unknown as {
    checkTacoReminders: () => Promise<void>;
    checkVuelosEstancados: (c: AlertConfig) => Promise<void>;
  };
  return { svc: priv, notifications, ops };
}

const tramo2 = (over: Record<string, unknown> = {}) => ({
  id: 'e2',
  vuelo_id: 'v1',
  orden: 2,
  origen_iata: 'CZM',
  destino_iata: 'CUN',
  fecha_salida_plan: EN_10_MIN,
  piloto_id: 'p1',
  taco_llegada: null,
  cancelada_at: null,
  taco_omitido_at: null,
  taco_omitido_por: null,
  taco_omitido_motivo: null,
  ...over,
});

const vuelo = (over: Record<string, unknown> = {}) => ({
  id: 'v1',
  folio: 450,
  piloto_id: 'p1',
  estado: 'EN_VUELO',
  es_externo: false,
  origen_iata: 'CUN',
  destino_iata: 'CZM',
  fecha_vuelo: '2026-10-15T14:00:00Z',
  fecha_fin: '2026-10-15T18:00:00Z',
  ...over,
});

beforeEach(() => {
  jest.useFakeTimers({
    now: AHORA,
    doNotFake: [
      'nextTick',
      'setImmediate',
      'setTimeout',
      'setInterval',
      'queueMicrotask',
    ],
  });
});
afterEach(() => jest.useRealTimers());

describe('checkTacoReminders · tramos 2+', () => {
  // OJO (código de hoy): el bloque de tramos 2+ solo corre si hay ALGÚN
  // vuelo saliendo en la ventana; aquí otro vuelo (v2) con su salida ya
  // capturada la abre sin generar aviso propio.
  const otro = {
    vuelo: vuelo({ id: 'v2', folio: 451, fecha_vuelo: EN_10_MIN }),
    escala: tramo2({
      id: 'e21',
      vuelo_id: 'v2',
      orden: 1,
      taco_salida: 4000.1,
      fecha_salida_plan: EN_10_MIN,
    }),
  };
  it('tramo normal sin llegada ⇒ avisa al piloto', async () => {
    const { svc, notifications } = armar({
      vuelo: [vuelo(), otro.vuelo],
      escala: [tramo2(), otro.escala],
    });
    await svc.checkTacoReminders();
    expect(notifications.notifyUser).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ titulo: 'Tu tramo sale en 10 min' }),
    );
  });

  it('tramo con tacómetro OMITIDO ⇒ no hay aviso', async () => {
    const { svc, notifications } = armar({
      vuelo: [vuelo(), otro.vuelo],
      escala: [
        otro.escala,
        tramo2({
          taco_omitido_at: '2026-10-15T15:40:00Z',
          taco_omitido_por: 'u-itzi',
          taco_omitido_motivo: 'Falló el tacómetro',
        }),
      ],
    });
    await svc.checkTacoReminders();
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  it('sin la migración la consulta NO nombra la columna y el aviso sale como siempre', async () => {
    const { svc, notifications } = armar(
      { vuelo: [vuelo(), otro.vuelo], escala: [tramo2(), otro.escala] },
      false,
    );
    await svc.checkTacoReminders();
    expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
  });
});

describe('checkVuelosEstancados · «sigue EN VUELO»', () => {
  const config: AlertConfig = {
    clave: 'vuelo_estancado',
    descripcion: '',
    activa: true,
    canal: 'socket',
    roles: ['ADMIN'],
    dias_anticipacion: [],
    horas_anticipacion: null,
  };
  const zombi = () =>
    vuelo({
      id: 'v300',
      folio: 300,
      origen_iata: 'CET',
      destino_iata: 'CUN',
      fecha_vuelo: '2026-09-12T20:00:00Z',
      fecha_fin: '2026-09-12T23:00:00Z',
    });
  const tramo = (over: Record<string, unknown>) =>
    tramo2({ id: 'e300', vuelo_id: 'v300', orden: 1, ...over });

  it('lo que falta está OMITIDO ⇒ texto de «complétalo desde el detalle»', async () => {
    const { svc, notifications } = armar({
      vuelo: [zombi()],
      escala: [
        tramo({
          taco_omitido_at: '2026-10-15T15:40:00Z',
          taco_omitido_motivo: 'Falló el tacómetro',
        }),
      ],
    });
    await svc.checkVuelosEstancados(config);
    expect(notifications.notifyRole).toHaveBeenCalledWith(
      'ADMIN',
      expect.objectContaining({
        titulo: 'Vuelo #300 sigue EN VUELO (fecha pasada)',
        cuerpo:
          'CET → CUN: sus lecturas faltantes están OMITIDAS por la oficina (tacómetro omitido). Complétalo desde el detalle del vuelo para que entre al cierre.',
      }),
    );
  });

  it('falta una llegada NO omitida ⇒ el texto de siempre', async () => {
    const { svc, notifications } = armar({
      vuelo: [zombi()],
      escala: [tramo({})],
    });
    await svc.checkVuelosEstancados(config);
    expect(notifications.notifyRole).toHaveBeenCalledWith(
      'ADMIN',
      expect.objectContaining({
        cuerpo:
          'CET → CUN: faltan lecturas de llegada; complétalo o ajusta en Tacómetros en vivo. Sus horas no entran al cierre hasta completarse.',
      }),
    );
  });

  it('sin la migración ⇒ el texto de siempre y ninguna columna nombrada', async () => {
    const { svc, notifications } = armar(
      { vuelo: [zombi()], escala: [tramo({})] },
      false,
    );
    await svc.checkVuelosEstancados(config);
    expect(notifications.notifyRole).toHaveBeenCalledWith(
      'ADMIN',
      expect.objectContaining({
        cuerpo: expect.stringContaining('faltan lecturas de llegada'),
      }),
    );
  });
});
