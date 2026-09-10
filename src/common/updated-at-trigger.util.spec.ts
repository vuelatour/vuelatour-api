import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  TRIGGER_UPDATED_AT_REINTENTO_MS,
  TriggerUpdatedAt,
  esFuncionInexistente,
  resetTriggersUpdatedAt,
  triggerUpdatedAt,
} from './updated-at-trigger.util';

/**
 * Sonda de trigger updated_at (10-sep-2026): mientras la migración
 * 20260910000001 no esté aplicada (función ausente o trigger ausente) el CAS
 * se salta; se memoriza ≤ 10 min y se activa solo; otros errores → true sin
 * memorizar.
 */
type Respuesta =
  | { data: unknown; error: { code?: string; message: string } | null }
  | Error;

function clienteFalso(respuestas: Respuesta[]) {
  let i = 0;
  const rpc = jest.fn(() => {
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const SIN_FUNCION = {
  data: null,
  error: {
    code: 'PGRST202',
    message:
      'Could not find the function public.updated_at_trigger_activo(p_tabla) in the schema cache',
  },
};
const ACTIVO = { data: true, error: null };
const SIN_TRIGGER = { data: false, error: null };

describe('esFuncionInexistente', () => {
  it('PGRST202 / 42883 / mensajes de función ausente', () => {
    expect(esFuncionInexistente({ code: 'PGRST202', message: 'x' })).toBe(true);
    expect(esFuncionInexistente({ code: '42883', message: 'x' })).toBe(true);
    expect(
      esFuncionInexistente({
        code: null,
        message:
          'function public.updated_at_trigger_activo(text) does not exist',
      }),
    ).toBe(true);
    expect(esFuncionInexistente({ code: '42501', message: 'denied' })).toBe(
      false,
    );
    expect(esFuncionInexistente(null)).toBe(false);
  });
});

describe('TriggerUpdatedAt', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  it('sondea con rpc(updated_at_trigger_activo, {p_tabla}) y memoriza true para siempre', async () => {
    const f = clienteFalso([ACTIVO]);
    const t = new TriggerUpdatedAt(f.client, 'mantenimiento');
    expect(await t.disponible()).toBe(true);
    expect(await t.disponible()).toBe(true);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledWith('updated_at_trigger_activo', {
      p_tabla: 'mantenimiento',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('función ausente (migración sin aplicar) → false, un solo warn, y no re-sondea dentro de la ventana', async () => {
    let reloj = 1_000;
    const f = clienteFalso([SIN_FUNCION]);
    const t = new TriggerUpdatedAt(f.client, 'evento_flota', {
      ahora: () => reloj,
    });
    expect(await t.disponible()).toBe(false);
    reloj += TRIGGER_UPDATED_AT_REINTENTO_MS - 1;
    expect(await t.disponible()).toBe(false);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const aviso = String((warn.mock.calls as unknown[][])[0][0]);
    expect(aviso).toMatch(/evento_flota/);
    expect(aviso).toMatch(/20260910000001/);
  });

  it('trigger ausente con la función presente → false (misma memoria)', async () => {
    const f = clienteFalso([SIN_TRIGGER]);
    const t = new TriggerUpdatedAt(f.client, 'piloto_descanso');
    expect(await t.disponible()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('pasada la ventana re-sondea y se activa solo (log, sin reiniciar)', async () => {
    let reloj = 0;
    const f = clienteFalso([SIN_FUNCION, ACTIVO]);
    const t = new TriggerUpdatedAt(f.client, 'mantenimiento', {
      ahora: () => reloj,
    });
    expect(await t.disponible()).toBe(false);
    reloj += TRIGGER_UPDATED_AT_REINTENTO_MS;
    expect(await t.disponible()).toBe(true);
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    // Memorizado: ya no vuelve a sondear.
    expect(await t.disponible()).toBe(true);
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });

  it('otro error o excepción → true SIN memorizar (vuelve a sondear)', async () => {
    const f = clienteFalso([
      { data: null, error: { code: '42501', message: 'permission denied' } },
      new Error('fetch failed'),
      ACTIVO,
    ]);
    const t = new TriggerUpdatedAt(f.client, 'mantenimiento');
    expect(await t.disponible()).toBe(true);
    expect(await t.disponible()).toBe(true);
    expect(await t.disponible()).toBe(true);
    expect(f.rpc).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('llamadas concurrentes comparten un solo sondeo', async () => {
    const f = clienteFalso([ACTIVO]);
    const t = new TriggerUpdatedAt(f.client, 'mantenimiento');
    const [a, b, c] = await Promise.all([
      t.disponible(),
      t.disponible(),
      t.disponible(),
    ]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });

  it('registro: una instancia por tabla y cliente; reset la olvida', async () => {
    const f = clienteFalso([ACTIVO]);
    const a = triggerUpdatedAt(f.client, 'mantenimiento');
    const b = triggerUpdatedAt(f.client, 'mantenimiento');
    const c = triggerUpdatedAt(f.client, 'evento_flota');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    await a.disponible();
    await b.disponible();
    expect(f.rpc).toHaveBeenCalledTimes(1);
    resetTriggersUpdatedAt(f.client);
    expect(triggerUpdatedAt(f.client, 'mantenimiento')).not.toBe(a);
  });
});
