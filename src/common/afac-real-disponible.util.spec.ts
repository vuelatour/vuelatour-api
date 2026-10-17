import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MENSAJE_AFAC_REAL_NO_DISPONIBLE,
  MIGRACION_AFAC_REAL,
  afacRealDisponible,
  colPagoAfac,
  errorAfacRealNoDisponible,
} from './afac-real-disponible.util';

/** Supabase mínimo: el sondeo es `from(t).select(c).limit(1)`. */
function sb(error: { code: string; message: string } | null) {
  const llamadas: string[] = [];
  const cliente = {
    from: (t: string) => ({
      select: (c: string) => ({
        limit: () => {
          llamadas.push(`${t}.${c}`);
          return Promise.resolve({ data: error ? null : [], error });
        },
      }),
    }),
  };
  return { cliente: cliente as unknown as SupabaseClient, llamadas };
}

describe('afac-real-disponible.util (invariante 90)', () => {
  it('sondea gasto.es_pago_afac: existe ⇒ true (memorizado)', async () => {
    const { cliente, llamadas } = sb(null);
    expect(await afacRealDisponible(cliente)).toBe(true);
    expect(await afacRealDisponible(cliente)).toBe(true);
    expect(llamadas).toEqual(['gasto.es_pago_afac']);
  });

  it('sin la columna (42703) ⇒ false: conducta 0.0.88', async () => {
    const { cliente } = sb({
      code: '42703',
      message: 'column gasto.es_pago_afac does not exist',
    });
    expect(await afacRealDisponible(cliente)).toBe(false);
  });

  it('colPagoAfac y el 503 estructurado', () => {
    expect(colPagoAfac(true)).toBe(', es_pago_afac');
    expect(colPagoAfac(false)).toBe('');
    const e = errorAfacRealNoDisponible();
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect(e.getResponse()).toEqual({
      message: MENSAJE_AFAC_REAL_NO_DISPONIBLE,
      error: 'AFAC_REAL_NO_DISPONIBLE',
      details: { migracion: MIGRACION_AFAC_REAL },
    });
    expect(MIGRACION_AFAC_REAL).toBe('20261016000005');
  });
});
