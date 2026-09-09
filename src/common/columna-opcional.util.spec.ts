import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ColumnaOpcional,
  COLUMNA_OPCIONAL_REINTENTO_MS,
  clientRequestIdDescanso,
  clientRequestIdEvento,
  columnaOpcional,
  esColumnaInexistente,
  resetColumnasOpcionales,
} from './columna-opcional.util';

/**
 * Columna opcional (9-sep-2026): `client_request_id` de piloto_descanso y
 * evento_flota puede no existir en prod hasta aplicar la migración
 * 20260909000003. El helper sondea una vez, memoriza, y re-sondea cada 10
 * min mientras falte; cualquier otro error NO se oculta (→ true).
 */
type Respuesta =
  | { data: unknown; error: { code?: string; message: string } | null }
  | Error;

function clienteFalso(respuestas: Respuesta[]) {
  let i = 0;
  const limit = jest.fn(() => {
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  });
  const select = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ select }));
  return {
    client: { from } as unknown as SupabaseClient,
    from,
    select,
    limit,
  };
}

const NO_EXISTE = {
  data: null,
  error: {
    code: '42703',
    message: 'column piloto_descanso.client_request_id does not exist',
  },
};
const OK = { data: [], error: null };

describe('esColumnaInexistente', () => {
  it('42703 o mensaje «column … does not exist»', () => {
    expect(esColumnaInexistente({ code: '42703', message: 'x' })).toBe(true);
    expect(
      esColumnaInexistente({
        code: 'PGRST204',
        message: "Column 'client_request_id' does not exist",
      }),
    ).toBe(true);
    expect(esColumnaInexistente({ code: '42501', message: 'denied' })).toBe(
      false,
    );
    expect(esColumnaInexistente(null)).toBe(false);
  });
});

describe('ColumnaOpcional', () => {
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

  it('sondea con select(columna).limit(1) sobre la tabla', async () => {
    const f = clienteFalso([OK]);
    const col = new ColumnaOpcional(
      f.client,
      'piloto_descanso',
      'client_request_id',
    );
    await expect(col.disponible()).resolves.toBe(true);
    expect(f.from).toHaveBeenCalledWith('piloto_descanso');
    expect(f.select).toHaveBeenCalledWith('client_request_id');
    expect(f.limit).toHaveBeenCalledWith(1);
  });

  it('éxito → true memorizado (un solo sondeo)', async () => {
    const f = clienteFalso([OK]);
    const col = new ColumnaOpcional(f.client, 't', 'c');
    expect(await col.disponible()).toBe(true);
    expect(await col.disponible()).toBe(true);
    expect(await col.disponible()).toBe(true);
    expect(f.limit).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('42703 → false, warn UNA vez, y re-sondea solo tras 10 min', async () => {
    let ahora = 1_000_000;
    const f = clienteFalso([NO_EXISTE, NO_EXISTE, OK]);
    const col = new ColumnaOpcional(
      f.client,
      'piloto_descanso',
      'client_request_id',
      {
        ahora: () => ahora,
        mensajeAusente: 'falta la columna',
      },
    );

    expect(await col.disponible()).toBe(false);
    expect(f.limit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('falta la columna');

    // Dentro de la ventana: memorizado, sin tocar la BD.
    ahora += COLUMNA_OPCIONAL_REINTENTO_MS - 1;
    expect(await col.disponible()).toBe(false);
    expect(f.limit).toHaveBeenCalledTimes(1);

    // Pasados 10 min: re-sondea; sigue sin existir → false, sin repetir warn.
    ahora += 1;
    expect(await col.disponible()).toBe(false);
    expect(f.limit).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);

    // Otros 10 min: la migración ya entró → true y memorizado.
    ahora += COLUMNA_OPCIONAL_REINTENTO_MS;
    expect(await col.disponible()).toBe(true);
    expect(f.limit).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(1);
    expect(await col.disponible()).toBe(true);
    expect(f.limit).toHaveBeenCalledTimes(3);
  });

  it('mensaje «column … does not exist» sin code también cuenta como ausente', async () => {
    const f = clienteFalso([
      {
        data: null,
        error: { message: 'column "client_request_id" does not exist' },
      },
    ]);
    const col = new ColumnaOpcional(f.client, 't', 'c');
    expect(await col.disponible()).toBe(false);
  });

  it('otro error → true SIN memorizar (no oculta problemas reales)', async () => {
    const f = clienteFalso([
      { data: null, error: { code: '42501', message: 'permission denied' } },
      OK,
    ]);
    const col = new ColumnaOpcional(f.client, 't', 'c');
    expect(await col.disponible()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    // Siguiente llamada vuelve a sondear (ahora éxito → memorizado).
    expect(await col.disponible()).toBe(true);
    expect(f.limit).toHaveBeenCalledTimes(2);
    expect(await col.disponible()).toBe(true);
    expect(f.limit).toHaveBeenCalledTimes(2);
  });

  it('excepción del cliente (red) → true sin memorizar', async () => {
    const f = clienteFalso([new Error('fetch failed'), NO_EXISTE]);
    const col = new ColumnaOpcional(f.client, 't', 'c', { ahora: () => 0 });
    expect(await col.disponible()).toBe(true);
    expect(await col.disponible()).toBe(false);
    expect(f.limit).toHaveBeenCalledTimes(2);
  });

  it('llamadas concurrentes comparten un solo sondeo', async () => {
    const f = clienteFalso([NO_EXISTE]);
    const col = new ColumnaOpcional(f.client, 't', 'c', { ahora: () => 0 });
    const r = await Promise.all([
      col.disponible(),
      col.disponible(),
      col.disponible(),
    ]);
    expect(r).toEqual([false, false, false]);
    expect(f.limit).toHaveBeenCalledTimes(1);
  });

  it('reset() olvida lo memorizado y vuelve a avisar', async () => {
    const f = clienteFalso([NO_EXISTE]);
    const col = new ColumnaOpcional(f.client, 't', 'c', { ahora: () => 0 });
    expect(await col.disponible()).toBe(false);
    col.reset();
    expect(await col.disponible()).toBe(false);
    expect(f.limit).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('fake timers: con Date.now real también re-sondea tras 10 min', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-09T12:00:00Z') });
    try {
      const f = clienteFalso([NO_EXISTE, OK]);
      const col = new ColumnaOpcional(f.client, 't', 'c');
      expect(await col.disponible()).toBe(false);
      jest.advanceTimersByTime(COLUMNA_OPCIONAL_REINTENTO_MS - 1);
      expect(await col.disponible()).toBe(false);
      expect(f.limit).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(await col.disponible()).toBe(true);
      expect(f.limit).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('registro columnaOpcional', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('misma instancia por cliente + tabla.columna; distinta por cliente', () => {
    const a = clienteFalso([OK]).client;
    const b = clienteFalso([OK]).client;
    expect(columnaOpcional(a, 't', 'c')).toBe(columnaOpcional(a, 't', 'c'));
    expect(columnaOpcional(a, 't', 'c')).not.toBe(columnaOpcional(a, 't', 'd'));
    expect(columnaOpcional(a, 't', 'c')).not.toBe(columnaOpcional(b, 't', 'c'));
    resetColumnasOpcionales(a);
  });

  it('resetColumnasOpcionales crea instancias nuevas', () => {
    const a = clienteFalso([OK]).client;
    const antes = columnaOpcional(a, 't', 'c');
    resetColumnasOpcionales(a);
    expect(columnaOpcional(a, 't', 'c')).not.toBe(antes);
  });

  it('instancias conocidas: descanso y evento comparten sondeo por servicio', async () => {
    const f = clienteFalso([NO_EXISTE]);
    const d1 = clientRequestIdDescanso(f.client);
    const d2 = clientRequestIdDescanso(f.client);
    expect(d1).toBe(d2);
    expect(d1.tabla).toBe('piloto_descanso');
    expect(d1.columna).toBe('client_request_id');
    const e = clientRequestIdEvento(f.client);
    expect(e).not.toBe(d1);
    expect(e.tabla).toBe('evento_flota');
    expect(await d1.disponible()).toBe(false);
    expect(await d2.disponible()).toBe(false);
    expect(f.from).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Columna piloto_descanso.client_request_id no existe todavía: descansos sin idempotencia hasta aplicar la migración 20260909000003',
    );
    resetColumnasOpcionales(f.client);
  });
});
