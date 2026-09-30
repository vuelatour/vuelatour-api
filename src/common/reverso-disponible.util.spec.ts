import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MIGRACION_REVERSOS,
  errorReversosNoDisponibles,
  reversosDisponibles,
} from './reverso-disponible.util';

/**
 * Sonda ÚNICA de la migración 20260930000001 (cargo devuelto ↔ devolución):
 * una columna basta porque la migración es atómica.
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

describe('reversosDisponibles', () => {
  it('sondea movimiento_bancario.reverso_de_id', async () => {
    const { cliente, selects } = sb(null);
    await expect(reversosDisponibles(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['movimiento_bancario.reverso_de_id']);
  });

  it('42703 ⇒ false (memorizado: no vuelve a sondear enseguida)', async () => {
    const { cliente, selects } = sb({ code: '42703', message: 'no existe' });
    await expect(reversosDisponibles(cliente)).resolves.toBe(false);
    await expect(reversosDisponibles(cliente)).resolves.toBe(false);
    expect(selects).toHaveLength(1);
  });

  it('503 estructurado con el texto del contrato', () => {
    const e = errorReversosNoDisponibles();
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toEqual({
      message:
        'El emparejado de cargos devueltos todavía no está habilitado en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.',
      error: 'REVERSOS_NO_DISPONIBLE',
      details: { migracion: MIGRACION_REVERSOS },
    });
    expect(MIGRACION_REVERSOS).toBe('20260930000001');
  });
});
