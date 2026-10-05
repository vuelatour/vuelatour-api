import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MIGRACION_COMBUSTIBLE_AERONAVE,
  combustibleAeronaveDisponible,
} from './combustible-disponible.util';

/** Sonda ÚNICA de la migración 20261005000001 (`aeronave.combustible`). */
function sb(error: { code: string; message: string } | null) {
  const selects: string[] = [];
  const cliente = {
    from: (tabla: string) => ({
      select: (col: string) => {
        selects.push(`${tabla}.${col}`);
        return {
          limit: () => Promise.resolve({ data: [], error }),
        };
      },
    }),
  } as unknown as SupabaseClient;
  return { cliente, selects };
}

describe('combustibleAeronaveDisponible', () => {
  it('sondea aeronave.combustible', async () => {
    const { cliente, selects } = sb(null);
    await expect(combustibleAeronaveDisponible(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['aeronave.combustible']);
    expect(MIGRACION_COMBUSTIBLE_AERONAVE).toBe('20261005000001');
  });

  it('42703 ⇒ false (memorizado: no vuelve a sondear enseguida)', async () => {
    const { cliente, selects } = sb({
      code: '42703',
      message: 'column aeronave.combustible does not exist',
    });
    await expect(combustibleAeronaveDisponible(cliente)).resolves.toBe(false);
    await expect(combustibleAeronaveDisponible(cliente)).resolves.toBe(false);
    expect(selects).toHaveLength(1);
  });
});
