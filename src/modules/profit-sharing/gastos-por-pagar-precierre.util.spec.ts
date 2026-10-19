import type { SupabaseClient } from '@supabase/supabase-js';
import {
  mesCandadoDeGasto,
  type VueloMesContable,
} from '../../common/cierre-mes.lector';
import {
  diaContablePorPagar,
  idsNominaDe,
  porPagarEnPeriodoContable,
  selectPorPagarPrecierre,
} from './gastos-por-pagar-precierre.util';

/**
 * PRE-CIERRE `gastos_por_pagar` — revisión del 19-oct-2026 (P1/P2). El mes
 * de un gasto por pagar es su MES CONTABLE con la MISMA regla del candado de
 * mes cerrado (`mesCandadoDeGasto`): la paridad se prueba contra el candado.
 */
const A1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const V = 'v0000000-0000-4000-8000-000000000400';

const vuelo = (
  fecha: string,
  extra: Partial<VueloMesContable> = {},
): VueloMesContable => ({
  id: V,
  folio: 400,
  fecha_vuelo: fecha,
  periodo_contable: null,
  fecha_contable: fecha,
  aeronave_id: A1,
  es_externo: false,
  ...extra,
});

type Caso = [string, Record<string, unknown>, VueloMesContable | null, string];
const CASOS: Caso[] = [
  [
    'TAXI de un vuelo del 30-sep fechado el 1-oct ⇒ septiembre (eje vuelo)',
    { categoria: 'TAXI', fecha_gasto: '2026-10-01', vuelo_id: V },
    vuelo('2026-09-30T20:00:00Z'),
    '2026-09',
  ],
  [
    'vuelo diferido a octubre ⇒ octubre',
    { categoria: 'HOTEL', fecha_gasto: '2026-09-30', vuelo_id: V },
    vuelo('2026-09-30T20:00:00Z', {
      periodo_contable: '2026-10-01T05:00:00Z',
      fecha_contable: '2026-10-01T05:00:00Z',
    }),
    '2026-10',
  ],
  [
    'OTRO (empresa) con vuelo ⇒ su fecha_gasto (eje gasto)',
    { categoria: 'OTRO', fecha_gasto: '2026-10-01', vuelo_id: V },
    vuelo('2026-09-30T20:00:00Z'),
    '2026-10',
  ],
  [
    'GAS con avión ⇒ su fecha_gasto',
    {
      categoria: 'GAS',
      fecha_gasto: '2026-10-01',
      vuelo_id: V,
      aeronave_id: A1,
    },
    vuelo('2026-09-30T20:00:00Z'),
    '2026-10',
  ],
  [
    'NÓMINA sin vuelo ⇒ su fecha_gasto',
    { categoria: 'NOMINA', fecha_gasto: '2026-10-30', vuelo_id: null },
    null,
    '2026-10',
  ],
  [
    'vuelo que ya no existe (embed null) ⇒ su fecha_gasto',
    { categoria: 'TAXI', fecha_gasto: '2026-10-02', vuelo_id: V },
    null,
    '2026-10',
  ],
];

/** Supabase mínimo: la sonda del cierre responde «la columna existe». */
const sbConCierre = {
  from: () => ({
    select: () => ({
      limit: () => Promise.resolve({ data: [], error: null }),
    }),
  }),
} as unknown as SupabaseClient;

describe('gastos-por-pagar-precierre.util', () => {
  it.each(CASOS)('%s', (_n, g, v, mes) => {
    const fila = { id: 'g-1', monto: '100.00', ...g, vuelo: v };
    expect(diaContablePorPagar(fila)?.slice(0, 7)).toBe(mes);
  });

  it.each(CASOS)(
    'PARIDAD con el candado de mes cerrado (`mesCandadoDeGasto`): %s',
    async (_n, g, v) => {
      const fila = { id: 'g-1', monto: '100.00', ...g, vuelo: v };
      const candado = await mesCandadoDeGasto(
        sbConCierre,
        { id: 'g-1', monto: '100.00', ...g },
        v,
      );
      expect(diaContablePorPagar(fila)?.slice(0, 7)).toBe(candado);
    },
  );

  it('el embed como ARREGLO (PostgREST) también se lee', () => {
    expect(
      diaContablePorPagar({
        id: 'g-1',
        categoria: 'TAXI',
        fecha_gasto: '2026-10-01',
        vuelo_id: V,
        vuelo: [vuelo('2026-09-30T20:00:00Z')],
      }),
    ).toBe('2026-09-30');
  });

  it('sin `fecha_contable` (sin la migración del cierre) ⇒ `fecha_vuelo` en día Cancún', () => {
    expect(
      diaContablePorPagar({
        categoria: 'TAXI',
        fecha_gasto: '2026-10-01',
        vuelo_id: V,
        // 04:30Z del 1-oct = 23:30 del 30-sep en Cancún.
        vuelo: { fecha_vuelo: '2026-10-01T04:30:00Z', aeronave_id: A1 },
      }),
    ).toBe('2026-09-30');
  });

  it('`porPagarEnPeriodoContable`: bordes del periodo inclusive', () => {
    const g = {
      categoria: 'TAXI',
      fecha_gasto: '2026-10-01',
      vuelo_id: V,
      vuelo: vuelo('2026-09-30T20:00:00Z'),
    };
    expect(porPagarEnPeriodoContable(g, '2026-09-01', '2026-09-30')).toBe(true);
    expect(porPagarEnPeriodoContable(g, '2026-09-30', '2026-09-30')).toBe(true);
    expect(porPagarEnPeriodoContable(g, '2026-10-01', '2026-10-31')).toBe(
      false,
    );
    // Sin ninguna fecha legible: no pertenece a ningún periodo.
    expect(
      porPagarEnPeriodoContable(
        { categoria: 'OTRO', fecha_gasto: null },
        '2026-09-01',
        '2026-09-30',
      ),
    ).toBe(false);
  });

  it('`idsNominaDe`: el subconjunto de `ids` de NÓMINA, en el orden de `ids`', () => {
    const lista = [
      { id: 'g-1', categoria: 'TAXI' },
      { id: 'g-2', categoria: 'NOMINA' },
      { id: 'g-3', categoria: 'NOMINA' },
    ];
    expect(idsNominaDe(lista, ['g-3', 'g-1', 'g-2'])).toEqual(['g-3', 'g-2']);
    // Un id recortado por el tope (no está en `ids`) no aparece.
    expect(idsNominaDe(lista, ['g-1', 'g-2'])).toEqual(['g-2']);
    expect(idsNominaDe([], [])).toEqual([]);
  });

  it('el select nombra las columnas del candado y el embed del vuelo (con o sin las del cierre)', () => {
    expect(selectPorPagarPrecierre('')).toBe(
      'id, monto, moneda, fecha_gasto, por_pagar, conciliado, categoria, vuelo_id, aeronave_id, escala_id, vuelo:vuelo_id(fecha_vuelo, aeronave_id, es_externo)',
    );
    expect(
      selectPorPagarPrecierre(', periodo_contable, fecha_contable'),
    ).toContain('es_externo, periodo_contable, fecha_contable)');
  });
});
