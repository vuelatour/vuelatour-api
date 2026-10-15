import { HttpStatus } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  errorCargosAGastoNoDisponible,
  errorOmitirNoDisponible,
  esOmisionCargosAusente,
  MENSAJE_OPCION_NO_ACTIVA,
  MIGRACION_OMISION_CARGOS,
  omisionCargosDisponible,
  OMISION_CARGOS_REINTENTO_MS,
  RPC_SONDA_OMISION_CARGOS,
  SondaOmisionCargos,
  sondaOmisionCargos,
} from './omision-cargos-disponible.util';

/**
 * SONDA de la migración 20261014000002 (14-oct-2026, API 0.0.77,
 * invariantes 75 y 76): la RPC con la lista VACÍA responde 23514
 * LOTE_INVALIDO sin tocar nada.
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

const LOTE = {
  error: {
    code: '23514',
    hint: 'LOTE_INVALIDO',
    message:
      'LOTE_INVALIDO: manda de 1 a 200 movimientos sin vacíos (llegaron 0)',
  },
};
const AUSENTE = {
  error: {
    code: 'PGRST202',
    message:
      'Could not find the function public.conciliacion_omitir_movimientos(p_actor, p_linea, p_movimiento_ids) in the schema cache',
  },
};

describe('SondaOmisionCargos', () => {
  it('llama la RPC con la lista VACÍA y memoriza el «sí» para siempre', async () => {
    const { sb, rpc } = cliente([LOTE]);
    const s = new SondaOmisionCargos(sb);
    expect(await s.disponible()).toBe(true);
    expect(await s.disponible()).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(RPC_SONDA_OMISION_CARGOS, {
      p_movimiento_ids: [],
      p_linea: '',
      p_actor: null,
    });
  });

  it('el hint o el prefijo LOTE_INVALIDO también prueban que está; sin error, también', async () => {
    for (const r of [
      { error: { code: 'P0001', hint: 'LOTE_INVALIDO', message: 'x' } },
      { error: { code: 'P0001', message: 'LOTE_INVALIDO: x' } },
      { data: { omitidos: 0 } },
    ]) {
      const { sb } = cliente([r]);
      expect(await new SondaOmisionCargos(sb).disponible()).toBe(true);
    }
  });

  it('función ausente ⇒ «no» memorizado ≤ 10 min; re-sondea y se enciende sola', async () => {
    let ahora = 1_000;
    const { sb, rpc } = cliente([AUSENTE, AUSENTE, LOTE]);
    const s = new SondaOmisionCargos(sb, { ahora: () => ahora });
    expect(await s.disponible()).toBe(false);
    ahora += OMISION_CARGOS_REINTENTO_MS - 1;
    expect(await s.disponible()).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    ahora += 1;
    expect(await s.disponible()).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(2);
    ahora += OMISION_CARGOS_REINTENTO_MS;
    expect(await s.disponible()).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(await s.disponible()).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('42883 que NOMBRA la RPC ⇒ ausente; «operator does not exist» NO', async () => {
    const { sb } = cliente([
      {
        error: {
          code: '42883',
          message:
            'function public.conciliacion_omitir_movimientos(uuid[], text, uuid) does not exist',
        },
      },
    ]);
    expect(await new SondaOmisionCargos(sb).disponible()).toBe(false);
    const { sb: sb2, rpc: rpc2 } = cliente([
      {
        error: {
          code: '42883',
          message: 'operator does not exist: public.moneda = text',
        },
      },
    ]);
    const s2 = new SondaOmisionCargos(sb2);
    expect(await s2.disponible()).toBe(true);
    // Sin memorizar: el siguiente llamado vuelve a sondear.
    await s2.disponible();
    expect(rpc2).toHaveBeenCalledTimes(2);
  });

  it('otro error o una excepción ⇒ «sí» SIN memorizar', async () => {
    const { sb, rpc } = cliente([
      {
        error: {
          code: '57014',
          message: 'canceling statement due to statement timeout',
        },
      },
      new Error('fetch failed'),
      LOTE,
    ]);
    const s = new SondaOmisionCargos(sb);
    expect(await s.disponible()).toBe(true);
    expect(await s.disponible()).toBe(true);
    expect(await s.disponible()).toBe(true);
    expect(await s.disponible()).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('llamadas concurrentes comparten UN sondeo', async () => {
    const { sb, rpc } = cliente([LOTE]);
    const s = new SondaOmisionCargos(sb);
    const r = await Promise.all([
      s.disponible(),
      s.disponible(),
      s.disponible(),
    ]);
    expect(r).toEqual([true, true, true]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('el registro da UNA instancia por cliente; reset() olvida', async () => {
    const { sb, rpc } = cliente([AUSENTE]);
    expect(sondaOmisionCargos(sb)).toBe(sondaOmisionCargos(sb));
    expect(await omisionCargosDisponible(sb)).toBe(false);
    expect(await omisionCargosDisponible(sb)).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    sondaOmisionCargos(sb).reset();
    await omisionCargosDisponible(sb);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe('503 con código estable y detección de la migración ausente', () => {
  it('los dos 503', () => {
    for (const [e, codigo] of [
      [errorOmitirNoDisponible(), 'CONCILIACION_OMITIR_NO_DISPONIBLE'],
      [
        errorCargosAGastoNoDisponible(),
        'CONCILIACION_CARGOS_A_GASTO_NO_DISPONIBLE',
      ],
    ] as const) {
      expect(e.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(e.getResponse()).toEqual({
        message: MENSAJE_OPCION_NO_ACTIVA,
        error: codigo,
        details: { migracion: MIGRACION_OMISION_CARGOS },
      });
    }
    expect(MIGRACION_OMISION_CARGOS).toBe('20261014000002');
  });

  it('esOmisionCargosAusente', () => {
    expect(esOmisionCargosAusente(AUSENTE.error)).toBe(true);
    expect(
      esOmisionCargosAusente({
        code: '42883',
        message:
          'function public.conciliacion_ligar_cargos_a_gasto(uuid, uuid[], uuid) does not exist',
      }),
    ).toBe(true);
    expect(
      esOmisionCargosAusente({
        code: '42883',
        message: 'operator does not exist: public.moneda = text',
      }),
    ).toBe(false);
    expect(
      esOmisionCargosAusente({
        code: '42883',
        message: 'function public.otra_cosa(uuid) does not exist',
      }),
    ).toBe(false);
    expect(
      esOmisionCargosAusente({ code: '23514', message: 'LOTE_INVALIDO: x' }),
    ).toBe(false);
    expect(esOmisionCargosAusente(null)).toBe(false);
  });
});
