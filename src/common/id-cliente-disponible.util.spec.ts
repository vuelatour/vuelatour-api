import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MENSAJE_ID_CLIENTE_NO_DISPONIBLE,
  MIGRACION_ID_CLIENTE,
  errorIdClienteNoDisponible,
  idClienteDisponible,
} from './id-cliente-disponible.util';

/**
 * Sonda ÚNICA de la migración 20261013000006 (ID de vuelo por cliente,
 * 13-oct-2026, invariante 68). El cliente falso cuenta los sondeos y
 * responde el error que se le pida (uno por sondeo, el último se repite).
 */
function sb(errores: Array<{ code: string; message: string } | null>) {
  const selects: string[] = [];
  let i = 0;
  const cliente = {
    from: (tabla: string) => ({
      select: (col: string) => {
        selects.push(`${tabla}.${col}`);
        const error = errores[Math.min(i, errores.length - 1)];
        i += 1;
        return {
          limit: () => Promise.resolve({ data: [], error }),
        };
      },
    }),
  } as unknown as SupabaseClient;
  return { cliente, selects };
}

const NO_EXISTE_SELECT = {
  code: '42703',
  message: 'column vuelo.consecutivo_cliente does not exist',
};
const NO_EXISTE_CACHE = {
  code: 'PGRST204',
  message:
    "Could not find the 'consecutivo_cliente' column of 'vuelo' in the schema cache",
};

describe('idClienteDisponible', () => {
  afterEach(() => jest.useRealTimers());

  it('sondea vuelo.consecutivo_cliente con la migración 20261013000006', async () => {
    const { cliente, selects } = sb([null]);
    await expect(idClienteDisponible(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['vuelo.consecutivo_cliente']);
    expect(MIGRACION_ID_CLIENTE).toBe('20261013000006');
  });

  it('éxito ⇒ true MEMORIZADO (un solo sondeo)', async () => {
    const { cliente, selects } = sb([null]);
    await idClienteDisponible(cliente);
    await idClienteDisponible(cliente);
    await idClienteDisponible(cliente);
    expect(selects).toHaveLength(1);
  });

  it.each([
    ['42703 (select)', NO_EXISTE_SELECT],
    ['PGRST204 (schema cache)', NO_EXISTE_CACHE],
  ])(
    '%s ⇒ false, sin re-sondear antes de 10 min y se enciende sola después',
    async (_n, error) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-13T12:00:00Z'));
      const { cliente, selects } = sb([error, null]);
      await expect(idClienteDisponible(cliente)).resolves.toBe(false);
      jest.setSystemTime(new Date('2026-10-13T12:09:00Z'));
      await expect(idClienteDisponible(cliente)).resolves.toBe(false);
      expect(selects).toHaveLength(1);
      jest.setSystemTime(new Date('2026-10-13T12:10:01Z'));
      await expect(idClienteDisponible(cliente)).resolves.toBe(true);
      expect(selects).toHaveLength(2);
    },
  );
});

describe('errorIdClienteNoDisponible', () => {
  it('503 con el code estable, el texto es-MX exacto y la migración', () => {
    const e = errorIdClienteNoDisponible();
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toEqual({
      message: MENSAJE_ID_CLIENTE_NO_DISPONIBLE,
      error: 'ID_CLIENTE_NO_DISPONIBLE',
      details: { migracion: MIGRACION_ID_CLIENTE },
    });
    expect(MENSAJE_ID_CLIENTE_NO_DISPONIBLE).toBe(
      'El alias del cliente todavía no está habilitado en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.',
    );
  });
});
