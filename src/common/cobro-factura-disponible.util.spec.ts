import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MIGRACION_COBRO_FACTURA,
  cobroFacturaDisponible,
  colCobroFactura,
  errorCobroFacturaNoDisponible,
} from './cobro-factura-disponible.util';

/**
 * Sonda ÚNICA de la migración 20261016000001 (facturas por cobro,
 * invariante 84): una columna basta y nadie la nombra sin ella.
 */
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

describe('cobroFacturaDisponible', () => {
  it('sondea cobro_vuelo.factura_emitida_id', async () => {
    const { cliente, selects } = sb(null);
    await expect(cobroFacturaDisponible(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['cobro_vuelo.factura_emitida_id']);
  });

  it('42703 ⇒ false (memorizado: no vuelve a sondear enseguida)', async () => {
    const { cliente, selects } = sb({
      code: '42703',
      message: 'column cobro_vuelo.factura_emitida_id does not exist',
    });
    await expect(cobroFacturaDisponible(cliente)).resolves.toBe(false);
    await expect(cobroFacturaDisponible(cliente)).resolves.toBe(false);
    expect(selects).toHaveLength(1);
  });

  it('colCobroFactura: la columna SOLO se nombra con la sonda', () => {
    expect(colCobroFactura(true)).toBe(', factura_emitida_id');
    expect(colCobroFactura(false)).toBe('');
  });

  it('503 estructurado con el texto del contrato', () => {
    const e = errorCobroFacturaNoDisponible();
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toEqual({
      message:
        'Todavía no se puede asignar factura a un cobro: falta aplicar la migración 20261016000001.',
      error: 'COBRO_FACTURA_NO_DISPONIBLE',
      details: { migracion: MIGRACION_COBRO_FACTURA },
    });
    expect(MIGRACION_COBRO_FACTURA).toBe('20261016000001');
  });
});
