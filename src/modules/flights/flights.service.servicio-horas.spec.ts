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
jest.mock('../alerts/alerts.service', () => ({ AlertsService: class {} }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { FlightsService } from './flights.service';
import type { AlertsService } from '../alerts/alerts.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * HOOK del programa de servicio por horas (20-sep-2026, caso XA-VGV).
 *
 * Cada escritura de tacómetro que puede SUBIR el Hobbs avisa a `alerts` para
 * que la orden nazca al cruzar el umbral de 10 h y no 24 h después. Aquí se
 * congelan las dos cosas que se pueden romper sin que nadie se entere:
 *  1) el avión que se avisa (herencia del avión del vuelo cuando el tramo no
 *     trae `aeronave_id`: comparar el id crudo apaga el aviso en silencio), y
 *  2) que los caminos de escritura SIGAN llamando al hook.
 */

const VUELO = 'vvvvvvvv-0000-4000-8000-000000000295';
const AVION_VUELO = 'aaaaaaaa-0000-4000-8000-0000000vuelo';
const AVION_TRAMO = 'aaaaaaaa-0000-4000-8000-0000000tramo';

function armar() {
  const revisarServicioDeAvion = jest.fn().mockResolvedValue(undefined);
  const from = () => {
    const q: Record<string, unknown> = {};
    const reg = () => () => q;
    for (const m of ['select', 'eq', 'order', 'limit']) q[m] = reg();
    q.maybeSingle = () =>
      Promise.resolve({ data: { aeronave_id: AVION_VUELO }, error: null });
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const nada = {} as never;
  const flights = new FlightsService(
    supabase,
    nada,
    nada,
    nada,
    nada,
    nada,
    nada,
    nada,
    nada,
    { revisarServicioDeAvion } as unknown as AlertsService,
  );
  const avisar = (escala: string | null) =>
    (
      flights as unknown as {
        avisarProgramaDeServicio: (e: string | null, v: string) => void;
      }
    ).avisarProgramaDeServicio(escala, VUELO);
  return { flights, avisar, revisarServicioDeAvion };
}

/** El hook es fire-and-forget: hay que dejar correr los microtasks. */
const vaciarCola = () => new Promise((r) => setImmediate(r));

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('avisarProgramaDeServicio — a qué avión se avisa', () => {
  it('tramo CON avión propio: se avisa a ese avión', async () => {
    const { avisar, revisarServicioDeAvion } = armar();
    avisar(AVION_TRAMO);
    await vaciarCola();
    expect(revisarServicioDeAvion).toHaveBeenCalledWith(AVION_TRAMO);
  });

  it('tramo SIN avión propio: hereda el del vuelo (nunca se queda mudo)', async () => {
    const { avisar, revisarServicioDeAvion } = armar();
    avisar(null);
    await vaciarCola();
    expect(revisarServicioDeAvion).toHaveBeenCalledWith(AVION_VUELO);
  });

  it('no espera al programa de servicio (la captura del piloto no paga latencia)', () => {
    const { avisar, revisarServicioDeAvion } = armar();
    let resuelto = false;
    revisarServicioDeAvion.mockImplementation(
      () => new Promise(() => undefined),
    );
    avisar(AVION_TRAMO);
    resuelto = true;
    expect(resuelto).toBe(true);
  });

  it('sin AlertsService inyectado (specs / arranque parcial) no truena', async () => {
    const flights = new FlightsService(
      { service: { from: () => ({}) } } as unknown as SupabaseService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(() =>
      (
        flights as unknown as {
          avisarProgramaDeServicio: (e: string | null, v: string) => void;
        }
      ).avisarProgramaDeServicio(AVION_TRAMO, VUELO),
    ).not.toThrow();
    await vaciarCola();
  });
});

describe('caminos de escritura que DEBEN avisar', () => {
  const fuente = readFileSync(join(__dirname, 'flights.service.ts'), 'utf8');

  /** Cuerpo aproximado de un método (hasta el siguiente miembro de la clase). */
  const cuerpoDe = (firma: string): string => {
    const i = fuente.indexOf(firma);
    expect(i).toBeGreaterThan(-1);
    const resto = fuente.slice(i + firma.length);
    const fin = resto.search(/\n {2}(?:async |private |\/\*\*)/);
    return fin === -1 ? resto : resto.slice(0, fin);
  };

  it.each([
    ['async captureTaco(', 'piloto, oficina y outbox de la app'],
    ['async confirmTaco(', 'confirmación/ajuste de oficina'],
    ['async restoreEscala(', 'tramo restaurado con sus lecturas'],
  ])('%s llama al hook (%s)', (firma) => {
    expect(cuerpoDe(firma)).toContain('this.avisarProgramaDeServicio(');
  });

  it('el hook vive en UN solo lugar (no se siembran llamadas sueltas a alerts)', () => {
    const directas = fuente.match(/this\.alerts!?\.revisarServicioDeAvion\(/g);
    expect(directas ?? []).toHaveLength(1);
  });
});
