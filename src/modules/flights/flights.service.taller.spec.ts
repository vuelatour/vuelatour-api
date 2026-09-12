// Mismos mocks de módulos pesados que el resto de los specs de flights:
// notifications arrastra el gateway y `jose` (ESM puro), calendar-sync
// arrastra googleapis, vision el SDK de IA y pilots el stack de push.
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

import { ConflictException } from '@nestjs/common';
import { FlightsService } from './flights.service';
import { avisoAeronaveEnTaller } from '../../common/aviso-taller.util';
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
 * TALLER = AVISO, NUNCA CANDADO (cliente, 11-sep-2026). Aquí se congela el
 * contrato del pre-check compartido por assign, assign por tramo, reserva,
 * reassign-aircraft, combinar, el cotizador y el grupo:
 *  - un avión EN TALLER ya NO lanza 409 `AERONAVE_EN_TALLER`: devuelve el
 *    texto único en `avisos`;
 *  - el squawk de severidad ALTA NO cambió (409 estructurado sin
 *    `aceptarDiscrepanciaAlta`, lista aceptada con ella);
 *  - taller + squawk aceptado conviven: aviso Y squawks aceptados.
 */

type Op = { m: string; args: unknown[] };
type Row = Record<string, unknown>;

const METODOS = [
  'select',
  'eq',
  'neq',
  'in',
  'is',
  'not',
  'or',
  'ilike',
  'gte',
  'lte',
  'order',
  'limit',
  'range',
  'insert',
  'update',
  'delete',
];

const AVION = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PILOTO = 'aaaaaaaa-0000-4000-8000-00000000000b';

interface Mundo {
  /** Hay un mantenimiento EN_TALLER para el avión. */
  enTaller?: boolean;
  /** La lectura de `mantenimiento` FALLA (caída/timeout de Supabase). */
  errorMantenimiento?: boolean;
  /** Discrepancias ALTA abiertas. */
  squawks?: Row[];
  /** Matrícula que devuelve la ficha (null = sin matrícula capturada). */
  matricula?: string | null;
}

function armar(m: Mundo = {}) {
  const llamadas: { tabla: string; ops: Op[] }[] = [];
  const resolver = (tabla: string): { data?: unknown; error?: unknown } => {
    switch (tabla) {
      case 'mantenimiento':
        if (m.errorMantenimiento) {
          return { data: null, error: { message: 'timeout de lectura' } };
        }
        return { data: m.enTaller ? { id: 'mant-1' } : null };
      case 'aeronave':
        return {
          data: {
            matricula: m.matricula === undefined ? 'XA-VGV' : m.matricula,
          },
        };
      case 'aeronave_discrepancia':
        return { data: m.squawks ?? [] };
      default:
        return {};
    }
  };
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      llamadas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => {
        const r = resolver(tabla);
        return {
          data: r.data === undefined ? (lista ? [] : null) : r.data,
          error: r.error ?? null,
        };
      };
      for (const met of METODOS) {
        q[met] = (...args: unknown[]) => {
          ops.push({ m: met, args });
          return q;
        };
      }
      q.maybeSingle = () => Promise.resolve(resolve(false));
      q.single = () => Promise.resolve(resolve(false));
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(resolve(true)).then(res);
      return q;
    },
  };
  const notifications = {
    notifyUser: jest.fn().mockResolvedValue(true),
    notifyRole: jest.fn().mockResolvedValue(true),
  } as unknown as NotificationsService;
  const expirations = {
    findBlockingExpirations: jest.fn().mockResolvedValue([]),
  } as unknown as ExpirationsService;
  const flights = new FlightsService(
    { service } as unknown as SupabaseService,
    { syncFlight: jest.fn() } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    notifications,
    expirations,
    {} as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
  return { flights, llamadas };
}

describe('avisoTallerDe (fuente única del aviso de taller en el API)', () => {
  it('avión en taller → un solo aviso con la matrícula', async () => {
    const { flights } = armar({ enTaller: true });
    await expect(flights.avisoTallerDe(AVION)).resolves.toEqual([
      avisoAeronaveEnTaller('XA-VGV'),
    ]);
  });

  it('avión fuera de taller → [] (nada que avisar) y sin leer la ficha', async () => {
    const { flights, llamadas } = armar({ enTaller: false });
    await expect(flights.avisoTallerDe(AVION)).resolves.toEqual([]);
    expect(llamadas.some((l) => l.tabla === 'aeronave')).toBe(false);
  });

  it('sin avión (externo, o assign solo de piloto) → [] sin consultar mantenimiento', async () => {
    const { flights, llamadas } = armar({ enTaller: true });
    await expect(flights.avisoTallerDe(null)).resolves.toEqual([]);
    await expect(flights.avisoTallerDe(undefined)).resolves.toEqual([]);
    expect(llamadas).toHaveLength(0);
  });

  it('si la lectura de mantenimiento FALLA no lanza: devuelve [] (un aviso jamás tumba la operación)', async () => {
    // Regla del cliente: el taller «no debe limitarte». Un error de lectura
    // tampoco puede convertirse en candado — y en `quotes.create` /
    // `revertirExterno` el aviso se calcula DESPUÉS del write: lanzar ahí
    // dejaría el dato guardado y un 500 en la pantalla.
    const { flights } = armar({ enTaller: true, errorMantenimiento: true });
    await expect(flights.avisoTallerDe(AVION)).resolves.toEqual([]);
  });

  it('sin matrícula capturada el aviso SIGUE saliendo (nunca se pierde por un dato de presentación)', async () => {
    const { flights } = armar({ enTaller: true, matricula: null });
    await expect(flights.avisoTallerDe(AVION)).resolves.toEqual([
      avisoAeronaveEnTaller(null),
    ]);
  });
});

describe('validateAssignTargets — taller avisa, squawk ALTA sigue bloqueando', () => {
  it('avión EN TALLER: NO lanza; devuelve el aviso y ningún squawk aceptado', async () => {
    const { flights } = armar({ enTaller: true });
    const r = await flights.validateAssignTargets({
      aeronaveId: AVION,
      pilotoId: PILOTO,
    });
    expect(r.avisos).toEqual([avisoAeronaveEnTaller('XA-VGV')]);
    expect(r.squawksAceptados).toEqual([]);
  });

  it('avión sano: avisos vacío (campo siempre presente, nunca undefined)', async () => {
    const { flights } = armar();
    const r = await flights.validateAssignTargets({ aeronaveId: AVION });
    expect(r.avisos).toEqual([]);
    expect(r.squawksAceptados).toEqual([]);
  });

  it('squawk ALTA sin confirmar sigue rechazando 409 estructurado AUNQUE el avión esté en taller (ese candado no cambió)', async () => {
    const { flights } = armar({
      enTaller: true,
      squawks: [{ id: 'sq-1', descripcion: 'Fuga de aceite motor 1' }],
    });
    let err: unknown;
    try {
      await flights.validateAssignTargets({ aeronaveId: AVION });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect(
      (err as ConflictException).getResponse() as { error: string },
    ).toMatchObject({ error: 'SQUAWK_ALTA_SIN_RESOLVER' });
  });

  it('taller + squawk ACEPTADO: procede con el aviso del taller Y la lista para avisar al mecánico', async () => {
    const squawks = [{ id: 'sq-1', descripcion: 'Fuga de aceite motor 1' }];
    const { flights } = armar({ enTaller: true, squawks });
    const r = await flights.validateAssignTargets(
      { aeronaveId: AVION },
      { aceptarDiscrepanciaAlta: true },
    );
    expect(r.avisos).toEqual([avisoAeronaveEnTaller('XA-VGV')]);
    expect(r.squawksAceptados).toEqual(squawks);
  });

  it('lectura de mantenimiento caída: la asignación PROCEDE sin aviso (el taller nunca limita, ni siquiera roto)', async () => {
    const { flights } = armar({ enTaller: true, errorMantenimiento: true });
    const r = await flights.validateAssignTargets({ aeronaveId: AVION });
    expect(r.avisos).toEqual([]);
    expect(r.squawksAceptados).toEqual([]);
  });

  it('solo piloto (copiloto, apoyo del grupo): ni consulta mantenimiento ni avisa', async () => {
    const { flights, llamadas } = armar({ enTaller: true });
    const r = await flights.validateAssignTargets({ pilotoId: PILOTO });
    expect(r.avisos).toEqual([]);
    expect(llamadas.some((l) => l.tabla === 'mantenimiento')).toBe(false);
  });
});
