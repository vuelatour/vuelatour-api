import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MENSAJE_PARTES_NO_DISPONIBLE,
  MIGRACION_PARTES,
  OBJETOS_PARTES,
  errorPartesNoDisponibles,
  esPartesAusentes,
  partesDisponibles,
} from './partes-disponible.util';

/**
 * Sonda ÚNICA de la migración 20261002000002 (1 cargo ↔ N gastos): una
 * columna basta porque la migración es atómica.
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

describe('partesDisponibles', () => {
  it('sondea movimiento_bancario.gastos_n', async () => {
    const { cliente, selects } = sb(null);
    await expect(partesDisponibles(cliente)).resolves.toBe(true);
    expect(selects).toEqual(['movimiento_bancario.gastos_n']);
  });

  it('con la columna presente memoriza el sí (no vuelve a sondear)', async () => {
    const { cliente, selects } = sb(null);
    await partesDisponibles(cliente);
    await partesDisponibles(cliente);
    expect(selects).toHaveLength(1);
  });

  it('42703 ⇒ false (memorizado: no vuelve a sondear enseguida)', async () => {
    const { cliente, selects } = sb({ code: '42703', message: 'no existe' });
    await expect(partesDisponibles(cliente)).resolves.toBe(false);
    await expect(partesDisponibles(cliente)).resolves.toBe(false);
    expect(selects).toHaveLength(1);
  });

  it('otro error (red, permisos) ⇒ true sin memorizar: no oculta el problema', async () => {
    const { cliente, selects } = sb({ code: '57014', message: 'timeout' });
    await expect(partesDisponibles(cliente)).resolves.toBe(true);
    await expect(partesDisponibles(cliente)).resolves.toBe(true);
    expect(selects).toHaveLength(2);
  });
});

describe('errorPartesNoDisponibles', () => {
  it('503 estructurado con el código y la migración', () => {
    const e = errorPartesNoDisponibles();
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toEqual({
      message: MENSAJE_PARTES_NO_DISPONIBLE,
      error: 'CONCILIACION_PARTES_NO_DISPONIBLE',
      details: { migracion: MIGRACION_PARTES },
    });
    expect(MIGRACION_PARTES).toBe('20261002000002');
    expect(MENSAJE_PARTES_NO_DISPONIBLE).toContain('varios gastos');
  });
});

describe('esPartesAusentes — la RPC, la puente o la vista no están', () => {
  it.each([
    // Fuera del schema cache: la llamada ni llegó a Postgres.
    [{ code: 'PGRST202', message: 'Could not find the function' }, true],
    [{ code: 'PGRST205', message: 'Could not find the table' }, true],
    // «No existe» que NOMBRA un objeto de la migración.
    [
      {
        code: '42883',
        message:
          'function public.conciliacion_ligar_cargo_gastos(uuid, uuid[], uuid) does not exist',
      },
      true,
    ],
    [
      {
        code: '42P01',
        message: 'relation "public.movimiento_bancario_gasto" does not exist',
      },
      true,
    ],
    [
      {
        code: '42P01',
        message: 'relation "public.v_gasto_conciliacion" does not exist',
      },
      true,
    ],
    // El incidente del 15-sep-2026: 42883 TAMBIÉN es «operator does not
    // exist» dentro de un trigger. Es un BUG, no una migración ausente.
    [
      {
        code: '42883',
        message: 'operator does not exist: public.moneda = text',
      },
      false,
    ],
    // «No existe» de OTRO objeto (cuerpo plpgsql roto): 500, no 503.
    [{ code: '42883', message: 'function does not exist' }, false],
    [
      {
        code: '42883',
        message: 'function public.tolerancia_lote(integer) does not exist',
      },
      false,
    ],
    [
      { code: '42P01', message: 'relation "public.otra" does not exist' },
      false,
    ],
    [{ code: '23514', message: 'CARGO_NO_CUADRA: …' }, false],
    [null, false],
  ])('%j ⇒ %s', (err, esperado) => {
    expect(esPartesAusentes(err)).toBe(esperado);
  });

  it('OBJETOS_PARTES nombra la RPC de ligar y desligar, la puente y la vista', () => {
    expect([...OBJETOS_PARTES]).toEqual([
      'conciliacion_ligar_cargo_gastos',
      'conciliacion_desligar_cargo_gastos',
      'movimiento_bancario_gasto',
      'v_gasto_conciliacion',
    ]);
  });
});
