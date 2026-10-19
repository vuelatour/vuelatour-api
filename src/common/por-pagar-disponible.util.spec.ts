import type { SupabaseClient } from '@supabase/supabase-js';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  CODIGO_POR_PAGAR_NO_DISPONIBLE,
  MENSAJE_POR_PAGAR_NO_DISPONIBLE,
  MIGRACION_POR_PAGAR,
  colsPorPagar,
  errorPorPagarNoDisponible,
  porPagarDisponible,
} from './por-pagar-disponible.util';

/**
 * Sonda ÚNICA de la migración 20261019000001 (`gasto.por_pagar`, gastos «por
 * pagar», 19-oct-2026, invariante 93). El cliente falso cuenta los sondeos y
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
  message: 'column gasto.por_pagar does not exist',
};
const NO_EXISTE_CACHE = {
  code: 'PGRST204',
  message:
    "Could not find the 'por_pagar' column of 'gasto' in the schema cache",
};

describe('porPagarDisponible', () => {
  afterEach(() => jest.useRealTimers());

  it('sondea gasto.por_pagar con la migración 20261019000001', async () => {
    const { cliente, selects } = sb([null]);
    await expect(porPagarDisponible(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['gasto.por_pagar']);
    expect(MIGRACION_POR_PAGAR).toBe('20261019000001');
  });

  it('éxito ⇒ true MEMORIZADO (un solo sondeo)', async () => {
    const { cliente, selects } = sb([null]);
    await porPagarDisponible(cliente);
    await porPagarDisponible(cliente);
    await porPagarDisponible(cliente);
    expect(selects).toHaveLength(1);
  });

  it.each([
    ['42703 (select)', NO_EXISTE_SELECT],
    ['PGRST204 (schema cache)', NO_EXISTE_CACHE],
  ])(
    '%s ⇒ false, sin re-sondear antes de 10 min y re-sondeo después',
    async (_n, error) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-19T12:00:00Z'));
      const { cliente, selects } = sb([error, error, null]);
      await expect(porPagarDisponible(cliente)).resolves.toBe(false);
      jest.setSystemTime(new Date('2026-10-19T12:09:00Z'));
      await expect(porPagarDisponible(cliente)).resolves.toBe(false);
      expect(selects).toHaveLength(1);
      // Pasados 10 min vuelve a preguntar; al aplicar la migración se
      // enciende sola (sin redeploy).
      jest.setSystemTime(new Date('2026-10-19T12:10:01Z'));
      await expect(porPagarDisponible(cliente)).resolves.toBe(false);
      jest.setSystemTime(new Date('2026-10-19T12:20:02Z'));
      await expect(porPagarDisponible(cliente)).resolves.toBe(true);
      expect(selects).toHaveLength(3);
    },
  );

  it('otro error (red, permisos) ⇒ true SIN memorizar (no se oculta un problema real)', async () => {
    const { cliente, selects } = sb([
      { code: '57014', message: 'canceling statement due to timeout' },
      null,
    ]);
    await expect(porPagarDisponible(cliente)).resolves.toBe(true);
    await expect(porPagarDisponible(cliente)).resolves.toBe(true);
    expect(selects).toHaveLength(2);
  });

  it('colsPorPagar: con la columna `, por_pagar, conciliado`; sin ella cadena vacía', () => {
    expect(colsPorPagar(true)).toBe(', por_pagar, conciliado');
    expect(colsPorPagar(false)).toBe('');
  });

  it('503 POR_PAGAR_NO_DISPONIBLE con su texto y la migración', () => {
    const e = errorPorPagarNoDisponible();
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toEqual({
      message:
        'Los gastos por pagar todavía no están activos: avisa a sistemas.',
      error: 'POR_PAGAR_NO_DISPONIBLE',
      details: { migracion: '20261019000001' },
    });
    expect(CODIGO_POR_PAGAR_NO_DISPONIBLE).toBe('POR_PAGAR_NO_DISPONIBLE');
    expect(MENSAJE_POR_PAGAR_NO_DISPONIBLE).toContain('avisa a sistemas');
  });
});
