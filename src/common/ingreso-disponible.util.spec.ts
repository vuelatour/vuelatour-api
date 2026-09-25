import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MIGRACION_INGRESOS,
  errorIngresosNoDisponibles,
  ingresosDisponibles,
} from './ingreso-disponible.util';

/**
 * Sonda ÚNICA de la migración 20260924000004 (ingresos): una columna basta
 * porque la migración es atómica.
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

describe('ingresosDisponibles', () => {
  it('sondea movimiento_bancario.ingreso_id', async () => {
    const { cliente, selects } = sb(null);
    await expect(ingresosDisponibles(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['movimiento_bancario.ingreso_id']);
  });

  it('42703 ⇒ false (memorizado: no vuelve a sondear enseguida)', async () => {
    const { cliente, selects } = sb({ code: '42703', message: 'no existe' });
    await expect(ingresosDisponibles(cliente)).resolves.toBe(false);
    await expect(ingresosDisponibles(cliente)).resolves.toBe(false);
    expect(selects).toHaveLength(1);
  });

  it('503 estructurado con el texto del contrato', () => {
    const e = errorIngresosNoDisponibles();
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toEqual({
      message:
        'Los ingresos todavía no están habilitados en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.',
      error: 'INGRESOS_NO_DISPONIBLE',
      details: { migracion: MIGRACION_INGRESOS },
    });
    expect(MIGRACION_INGRESOS).toBe('20260924000004');
  });
});
