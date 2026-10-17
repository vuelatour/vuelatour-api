import type { SupabaseClient } from '@supabase/supabase-js';
import {
  gastosConReparto,
  repartirPorcentajeCents,
} from './gasto-reparto.util';

describe('repartirPorcentajeCents', () => {
  it('Σ = 100% suma exactamente el monto (tercios clásicos)', () => {
    // $100.00 entre 33.33 / 33.33 / 33.34
    const partes = repartirPorcentajeCents(10000, [33.33, 33.33, 33.34]);
    expect(partes.reduce((a, c) => a + c, 0)).toBe(10000);
    expect(partes).toEqual([3333, 3333, 3334]);
  });

  it('residuo por mayor resto: el centavo extra va a la línea con más resto', () => {
    // $0.10 al 33.33/33.33/33.34: bases 3/3/3 y el objetivo es 10 → el
    // centavo del residuo cae en la TERCERA (resto 3340 > 3330).
    const partes = repartirPorcentajeCents(10, [33.33, 33.33, 33.34]);
    expect(partes).toEqual([3, 3, 4]);
    expect(partes.reduce((a, c) => a + c, 0)).toBe(10);
  });

  it('empate de restos: gana el orden de las líneas', () => {
    // $0.03 entre 50/50: exactos 1.5 y 1.5, objetivo 3 → [2, 1].
    expect(repartirPorcentajeCents(3, [50, 50])).toEqual([2, 1]);
  });

  it('Σ < 100% suma el round del total asignado (el resto es empresa)', () => {
    // $200.00 al 25% + 10.55% = 35.55% → 7110 centavos exactos.
    const partes = repartirPorcentajeCents(20000, [25, 10.55]);
    expect(partes).toEqual([5000, 2110]);
  });

  it('sin floats: 0.01% de montos chicos trunca a 0 centavos', () => {
    // El caller debe rechazar líneas en 0 (CHECK monto>0 de gasto_reparto).
    expect(repartirPorcentajeCents(99, [0.01])).toEqual([0]);
    expect(repartirPorcentajeCents(5000, [0.01])).toEqual([1]);
  });

  it('porcentajes con decimales sucios de float no desvían centavos', () => {
    // 29.03 × 100 = 2902.9999… en float: Math.round lo ancla a 2903.
    const partes = repartirPorcentajeCents(123456, [29.03, 70.97]);
    expect(partes.reduce((a, c) => a + c, 0)).toBe(123456);
    expect(partes).toEqual([35839, 87617]);
  });

  it('monto 0 reparte puros ceros', () => {
    expect(repartirPorcentajeCents(0, [50, 50])).toEqual([0, 0]);
  });
});

/**
 * `gastosConReparto` (16-oct-2026, API 0.0.90, invariante 91): solo la
 * existencia, en lotes de ≤ 200 ids y PAGINADA (PostgREST corta en 1000).
 */
describe('gastosConReparto', () => {
  type Llamada = { ids: string[]; rango: [number, number] };
  function fake(
    filas: Array<{ gasto_id: string; aeronave_id: string }>,
    opts: { maxRows?: number; error?: string } = {},
  ) {
    const llamadas: Llamada[] = [];
    const from = (tabla: string) => {
      expect(tabla).toBe('gasto_reparto');
      let ids: string[] = [];
      let rango: [number, number] = [0, Number.MAX_SAFE_INTEGER];
      const q: Record<string, unknown> = {
        select: (cols: string) => {
          expect(cols).toBe('gasto_id');
          return q;
        },
        in: (_c: string, v: string[]) => {
          ids = v;
          return q;
        },
        order: () => q,
        range: (a: number, b: number) => {
          rango = [a, b];
          return q;
        },
        then: (res: (v: unknown) => unknown) => {
          llamadas.push({ ids, rango });
          if (opts.error) {
            return Promise.resolve({
              data: null,
              error: { message: opts.error },
            }).then(res);
          }
          const todas = filas
            .filter((f) => ids.includes(f.gasto_id))
            .sort((x, y) =>
              (x.gasto_id + x.aeronave_id).localeCompare(
                y.gasto_id + y.aeronave_id,
              ),
            );
          const max = opts.maxRows ?? 1000;
          const pag = todas.slice(
            rango[0],
            Math.min(rango[1] + 1, rango[0] + max),
          );
          return Promise.resolve({ data: pag, error: null }).then(res);
        },
      };
      return q;
    };
    return { sb: { from } as unknown as SupabaseClient, llamadas };
  }

  it('lotes de 200 ids y PAGINA hasta que una página trae < 1000 (200 gastos × 7 aviones = 1,400 filas)', async () => {
    const ids = Array.from(
      { length: 250 },
      (_, i) => `g-${String(i).padStart(3, '0')}`,
    );
    const filas = ids.slice(0, 200).flatMap((g) =>
      Array.from({ length: 7 }, (_, k) => ({
        gasto_id: g,
        aeronave_id: `a-${k}`,
      })),
    );
    filas.push({ gasto_id: 'g-249', aeronave_id: 'a-0' });
    const { sb, llamadas } = fake(filas);
    const con = await gastosConReparto(sb, [...ids, ids[0], '']);
    expect(con.size).toBe(201);
    expect(con.has('g-199')).toBe(true);
    expect(con.has('g-200')).toBe(false);
    expect(con.has('g-249')).toBe(true);
    expect(llamadas.map((l) => [l.ids.length, l.rango])).toEqual([
      [200, [0, 999]],
      [200, [1000, 1999]],
      [50, [0, 999]],
    ]);
  });

  it('sin ids no consulta; un error de lectura LANZA', async () => {
    const vacio = fake([]);
    expect((await gastosConReparto(vacio.sb, [])).size).toBe(0);
    expect(vacio.llamadas).toHaveLength(0);
    await expect(
      gastosConReparto(fake([], { error: 'caída' }).sb, ['g-1']),
    ).rejects.toThrow('caída');
  });
});
