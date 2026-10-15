import { HttpStatus, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  cobrosParcialesDisponibles,
  errorCobrosParcialesNoDisponibles,
  esCobrosParcialesAusente,
  MENSAJE_COBROS_PARCIALES_NO_DISPONIBLE,
  MIGRACION_COBROS_PARCIALES,
  reiniciarSondaCobrosParciales,
  RPC_SONDA_COBROS_PARCIALES,
  SondaCobrosParciales,
  sondaCobrosParciales,
} from './cobros-parciales-disponible.util';
import { TRIGGER_UPDATED_AT_REINTENTO_MS } from './updated-at-trigger.util';

/**
 * SONDA de la migración 20261014000003 (14-oct-2026, API 0.0.78, invariante
 * 77): `regla_cobro_cubierto(1, 1, false, 1)` responde `true` con la
 * migración; sin ella PostgREST responde PGRST202 (la forma REAL de abajo).
 */
type Respuesta = { data?: unknown; error?: unknown } | Error;

function cliente(respuestas: Respuesta[]) {
  const rpc = jest.fn((nombre: string, args: unknown) => {
    void nombre;
    void args;
    const r = respuestas.length > 1 ? respuestas.shift()! : respuestas[0];
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  });
  return { sb: { rpc } as unknown as SupabaseClient, rpc };
}

const SI = { data: true };
/** El error REAL de PostgREST sin la migración (14-oct-2026). */
const PGRST202_REAL = {
  error: {
    code: 'PGRST202',
    message:
      'Could not find the function public.regla_cobro_cubierto(p_cruzado, p_n_partes, p_neto, p_suma) in the schema cache',
    details:
      'Searched for the function public.regla_cobro_cubierto with parameters p_cruzado, p_n_partes, p_neto, p_suma or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.',
    hint: 'Perhaps you meant to call the function public.regla_gasto_cubierto',
  },
};

beforeEach(() => {
  // El «ya está aplicada» es un `log` informativo: no ensucia la salida.
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
  reiniciarSondaCobrosParciales();
});

describe('SondaCobrosParciales', () => {
  it('data true ⇒ «sí» memorizado para siempre (llama con (1, 1, false, 1))', async () => {
    const { sb, rpc } = cliente([SI]);
    const s = new SondaCobrosParciales(sb);
    expect(await s.disponible()).toBe(true);
    expect(await s.disponible()).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(RPC_SONDA_COBROS_PARCIALES, {
      p_neto: 1,
      p_n_partes: 1,
      p_cruzado: false,
      p_suma: 1,
    });
  });

  it('el PGRST202 REAL ⇒ «no»; a los 9 min sigue «no» sin llamar; a los 10 min re-sondea y se enciende sola', async () => {
    let ahora = 1_000;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { sb, rpc } = cliente([PGRST202_REAL, SI]);
    const s = new SondaCobrosParciales(sb, { ahora: () => ahora });
    expect(await s.disponible()).toBe(false);
    ahora += 9 * 60_000;
    expect(await s.disponible()).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    ahora += 60_000;
    expect(TRIGGER_UPDATED_AT_REINTENTO_MS).toBe(10 * 60_000);
    expect(await s.disponible()).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(await s.disponible()).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    // Un solo warn (con la migración en el texto).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(MIGRACION_COBROS_PARCIALES);
  });

  it('42883 «function public.regla_cobro_cubierto(…) does not exist» ⇒ «no»', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { sb } = cliente([
      {
        error: {
          code: '42883',
          message:
            'function public.regla_cobro_cubierto(numeric, integer, boolean, numeric) does not exist',
        },
      },
    ]);
    expect(await new SondaCobrosParciales(sb).disponible()).toBe(false);
  });

  it('42883 «operator does not exist: public.moneda = text» ⇒ «sí» SIN memorizar (jamás «falta la migración»)', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { sb, rpc } = cliente([
      {
        error: {
          code: '42883',
          message: 'operator does not exist: public.moneda = text',
        },
      },
    ]);
    const s = new SondaCobrosParciales(sb);
    expect(await s.disponible()).toBe(true);
    expect(await s.disponible()).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('red / 500 / data false ⇒ «sí» SIN memorizar, con UN solo warn aunque se sondee varias veces', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { sb, rpc } = cliente([
      new Error('fetch failed'),
      { error: { code: '500', message: 'Internal Server Error' } },
      { data: false },
      SI,
    ]);
    const s = new SondaCobrosParciales(sb);
    expect(await s.disponible()).toBe(true);
    expect(await s.disponible()).toBe(true);
    expect(await s.disponible()).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    // Ya con la migración: memorizado.
    expect(await s.disponible()).toBe(true);
    expect(await s.disponible()).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(4);
  });

  it('dos llamadas simultáneas ⇒ UNA sola rpc', async () => {
    const { sb, rpc } = cliente([SI]);
    const s = new SondaCobrosParciales(sb);
    expect(await Promise.all([s.disponible(), s.disponible()])).toEqual([
      true,
      true,
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('un cliente sin `rpc` (fake de otro spec) ⇒ «sí» sin tronar', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const sb = {} as unknown as SupabaseClient;
    expect(await new SondaCobrosParciales(sb).disponible()).toBe(true);
  });
});

describe('registro, 503 y detección del «no está»', () => {
  it('una instancia por cliente; reiniciarSondaCobrosParciales() olvida todo', async () => {
    const { sb, rpc } = cliente([SI]);
    expect(sondaCobrosParciales(sb)).toBe(sondaCobrosParciales(sb));
    expect(await cobrosParcialesDisponibles(sb)).toBe(true);
    expect(await cobrosParcialesDisponibles(sb)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    const antes = sondaCobrosParciales(sb);
    reiniciarSondaCobrosParciales();
    expect(sondaCobrosParciales(sb)).not.toBe(antes);
  });

  it('el 503 estructurado CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE', () => {
    const e = errorCobrosParcialesNoDisponibles();
    expect(e.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(e.getResponse()).toEqual({
      message: MENSAJE_COBROS_PARCIALES_NO_DISPONIBLE,
      error: 'CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE',
      details: { migracion: '20261014000003' },
    });
    expect(MENSAJE_COBROS_PARCIALES_NO_DISPONIBLE).toContain(
      '«Conciliado parcial»',
    );
  });

  it('esCobrosParcialesAusente: PGRST202 sí; 42883 solo si nombra la función; «operator does not exist» nunca', () => {
    expect(esCobrosParcialesAusente(PGRST202_REAL.error)).toBe(true);
    expect(
      esCobrosParcialesAusente({
        code: '42883',
        message: 'function public.regla_gasto_cubierto(numeric) does not exist',
      }),
    ).toBe(false);
    expect(
      esCobrosParcialesAusente({
        code: '42883',
        message:
          'function public.regla_cobro_cubierto(numeric, integer, boolean, numeric) does not exist',
      }),
    ).toBe(true);
    expect(
      esCobrosParcialesAusente({
        code: '42883',
        message: 'operator does not exist: public.moneda = text',
      }),
    ).toBe(false);
    expect(esCobrosParcialesAusente(null)).toBe(false);
    expect(
      esCobrosParcialesAusente({ code: '57014', message: 'timeout' }),
    ).toBe(false);
  });
});
