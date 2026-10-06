import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MIGRACION_FOLIO_RELEIDO_GASTO,
  folioReleidoGastoDisponible,
} from './folio-releido-gasto-disponible.util';

/** Sonda ÚNICA de la migración 20261006000001 (`gasto.folio_releido_at`). */
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

describe('folioReleidoGastoDisponible', () => {
  it('sondea gasto.folio_releido_at', async () => {
    const { cliente, selects } = sb(null);
    await expect(folioReleidoGastoDisponible(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['gasto.folio_releido_at']);
    expect(MIGRACION_FOLIO_RELEIDO_GASTO).toBe('20261006000001');
  });

  it('42703 ⇒ false (memorizado: no vuelve a sondear enseguida)', async () => {
    const { cliente, selects } = sb({
      code: '42703',
      message: 'column gasto.folio_releido_at does not exist',
    });
    await expect(folioReleidoGastoDisponible(cliente)).resolves.toBe(false);
    await expect(folioReleidoGastoDisponible(cliente)).resolves.toBe(false);
    expect(selects).toHaveLength(1);
  });
});
