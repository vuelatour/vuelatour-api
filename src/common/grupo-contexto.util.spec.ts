import {
  contextoGrupoDeVuelo,
  textoContextoGrupo,
} from './grupo-contexto.util';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('textoContextoGrupo', () => {
  it('"Grupo G-12 · avión 3 de 7 · 44 pax"', () => {
    expect(
      textoContextoGrupo({
        folio: 12,
        posicion: 3,
        total_aviones: 7,
        pasajeros_total: 44,
      }),
    ).toBe('Grupo G-12 · avión 3 de 7 · 44 pax');
  });

  it('degrada sin total ni pax', () => {
    expect(
      textoContextoGrupo({
        folio: 12,
        posicion: 3,
        total_aviones: null,
        pasajeros_total: null,
      }),
    ).toBe('Grupo G-12 · avión 3');
    expect(
      textoContextoGrupo({
        folio: null,
        posicion: null,
        total_aviones: null,
        pasajeros_total: null,
      }),
    ).toBe('Grupo G-?');
  });
});

describe('contextoGrupoDeVuelo', () => {
  it('null si el vuelo no es de grupo (sin consultas)', async () => {
    const from = jest.fn();
    const sb = { from } as unknown as SupabaseClient;
    expect(await contextoGrupoDeVuelo(sb, { id: 'v1', grupo_id: null })).toBe(
      null,
    );
    expect(from).not.toHaveBeenCalled();
  });

  it('usa el embed de VUELO_COLS y cuenta aviones vivos', async () => {
    const from = jest.fn().mockImplementation(() => {
      const q: Record<string, unknown> = {};
      const self = () => q;
      Object.assign(q, {
        select: self,
        eq: self,
        neq: () => Promise.resolve({ count: 7, error: null }),
      });
      return q;
    });
    const sb = { from } as unknown as SupabaseClient;
    const r = await contextoGrupoDeVuelo(sb, {
      id: 'v1',
      grupo_id: 'g-1',
      grupo_posicion: 3,
      grupo: { folio: 12, pasajeros_total: 44 },
    });
    expect(r).toEqual({
      id: 'g-1',
      folio: 12,
      posicion: 3,
      total_aviones: 7,
      pasajeros_total: 44,
      texto: 'Grupo G-12 · avión 3 de 7 · 44 pax',
    });
    // Solo el conteo (el folio vino en el embed).
    expect(from).toHaveBeenCalledTimes(1);
  });
});
