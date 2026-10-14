import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MIGRACION_TUA_INCLUIDA,
  colTuaIncluida,
  tuaIncluidaDisponible,
} from './tua-incluida-disponible.util';

/**
 * Sonda ÚNICA de la migración 20261013000008 (`gasto.tua_incluida`, TUA
 * sistémica, 13-oct-2026). El cliente falso cuenta los sondeos y responde el
 * error que se le pida (uno por sondeo, el último se repite).
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
  message: 'column gasto.tua_incluida does not exist',
};
const NO_EXISTE_CACHE = {
  code: 'PGRST204',
  message:
    "Could not find the 'tua_incluida' column of 'gasto' in the schema cache",
};

describe('tuaIncluidaDisponible', () => {
  afterEach(() => jest.useRealTimers());

  it('sondea gasto.tua_incluida con la migración RENUMERADA (000008, no 000003)', async () => {
    const { cliente, selects } = sb([null]);
    await expect(tuaIncluidaDisponible(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['gasto.tua_incluida']);
    expect(MIGRACION_TUA_INCLUIDA).toBe('20261013000008');
  });

  it('éxito ⇒ true MEMORIZADO (un solo sondeo)', async () => {
    const { cliente, selects } = sb([null]);
    await tuaIncluidaDisponible(cliente);
    await tuaIncluidaDisponible(cliente);
    await tuaIncluidaDisponible(cliente);
    expect(selects).toHaveLength(1);
  });

  it.each([
    ['42703 (select)', NO_EXISTE_SELECT],
    ['PGRST204 (schema cache)', NO_EXISTE_CACHE],
  ])(
    '%s ⇒ false, sin re-sondear antes de 10 min y re-sondeo después',
    async (_n, error) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-13T12:00:00Z'));
      const { cliente, selects } = sb([error, error, null]);
      await expect(tuaIncluidaDisponible(cliente)).resolves.toBe(false);
      jest.setSystemTime(new Date('2026-10-13T12:09:00Z'));
      await expect(tuaIncluidaDisponible(cliente)).resolves.toBe(false);
      expect(selects).toHaveLength(1);
      // Pasados 10 min vuelve a preguntar; al aplicar la migración, se
      // enciende sola (sin redeploy).
      jest.setSystemTime(new Date('2026-10-13T12:10:01Z'));
      await expect(tuaIncluidaDisponible(cliente)).resolves.toBe(false);
      jest.setSystemTime(new Date('2026-10-13T12:20:02Z'));
      await expect(tuaIncluidaDisponible(cliente)).resolves.toBe(true);
      expect(selects).toHaveLength(3);
    },
  );

  it('colTuaIncluida: con la columna `, tua_incluida`; sin ella cadena vacía', () => {
    expect(colTuaIncluida(true)).toBe(', tua_incluida');
    expect(colTuaIncluida(false)).toBe('');
  });
});
