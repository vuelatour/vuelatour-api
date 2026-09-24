import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MIGRACION_FACTURA_EMITIDA,
  errorFacturasNoDisponibles,
  facturaEmitidaDisponible,
} from './factura-emitida-disponible.util';

/**
 * Sonda ÚNICA de la migración 20260924000003 (facturas emitidas +
 * solicitud): una columna basta porque la migración es atómica.
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

describe('facturaEmitidaDisponible', () => {
  it('sondea vuelo.factura_solicitada_at', async () => {
    const { cliente, selects } = sb(null);
    await expect(facturaEmitidaDisponible(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['vuelo.factura_solicitada_at']);
  });

  it('42703 ⇒ false (memorizado: no vuelve a sondear enseguida)', async () => {
    const { cliente, selects } = sb({ code: '42703', message: 'no existe' });
    await expect(facturaEmitidaDisponible(cliente)).resolves.toBe(false);
    await expect(facturaEmitidaDisponible(cliente)).resolves.toBe(false);
    expect(selects).toHaveLength(1);
  });

  it('503 estructurado con el texto del contrato', () => {
    const e = errorFacturasNoDisponibles();
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toEqual({
      message:
        'Las facturas emitidas todavía no están habilitadas en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.',
      error: 'FACTURAS_EMITIDAS_NO_DISPONIBLE',
      details: { migracion: MIGRACION_FACTURA_EMITIDA },
    });
    expect(MIGRACION_FACTURA_EMITIDA).toBe('20260924000003');
  });
});
