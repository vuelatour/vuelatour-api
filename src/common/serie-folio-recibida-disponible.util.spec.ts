import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MIGRACION_SERIE_FOLIO_RECIBIDA,
  serieFolioRecibidaDisponible,
} from './serie-folio-recibida-disponible.util';

/** Sonda ÚNICA de la migración 20261005000002 (`factura_recibida.serie`). */
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

describe('serieFolioRecibidaDisponible', () => {
  it('sondea factura_recibida.serie', async () => {
    const { cliente, selects } = sb(null);
    await expect(serieFolioRecibidaDisponible(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['factura_recibida.serie']);
    expect(MIGRACION_SERIE_FOLIO_RECIBIDA).toBe('20261005000002');
  });

  it('42703 ⇒ false (memorizado: no vuelve a sondear enseguida)', async () => {
    const { cliente, selects } = sb({
      code: '42703',
      message: 'column factura_recibida.serie does not exist',
    });
    await expect(serieFolioRecibidaDisponible(cliente)).resolves.toBe(false);
    await expect(serieFolioRecibidaDisponible(cliente)).resolves.toBe(false);
    expect(selects).toHaveLength(1);
  });
});
