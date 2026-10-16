import type { SupabaseClient } from '@supabase/supabase-js';
import {
  errorFacturasGastoNoDisponible,
  gastoFacturasDisponible,
  MIGRACION_GASTO_FACTURAS,
} from './gasto-facturas-disponible.util';

/** Sonda ÚNICA de la migración 20261016000003 (`factura_recibida.pdf_sha256`). */
function sb(error: { code: string; message: string } | null) {
  const selects: string[] = [];
  const cliente = {
    from: (tabla: string) => ({
      select: (col: string) => {
        selects.push(`${tabla}.${col}`);
        return { limit: () => Promise.resolve({ data: [], error }) };
      },
    }),
  } as unknown as SupabaseClient;
  return { cliente, selects };
}

describe('gastoFacturasDisponible', () => {
  it('sondea factura_recibida.pdf_sha256', async () => {
    const { cliente, selects } = sb(null);
    await expect(gastoFacturasDisponible(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['factura_recibida.pdf_sha256']);
    expect(MIGRACION_GASTO_FACTURAS).toBe('20261016000003');
  });

  it('42703 ⇒ false (memorizado: no vuelve a sondear enseguida)', async () => {
    const { cliente, selects } = sb({
      code: '42703',
      message: 'column factura_recibida.pdf_sha256 does not exist',
    });
    await expect(gastoFacturasDisponible(cliente)).resolves.toBe(false);
    await expect(gastoFacturasDisponible(cliente)).resolves.toBe(false);
    expect(selects).toHaveLength(1);
  });

  it('503 FACTURAS_GASTO_NO_DISPONIBLE con la migración en details', () => {
    const e = errorFacturasGastoNoDisponible();
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toMatchObject({
      error: 'FACTURAS_GASTO_NO_DISPONIBLE',
      details: { migracion: '20261016000003' },
    });
  });
});
