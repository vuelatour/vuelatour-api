import {
  avionDeGastoEmbebido,
  embebido,
  esVueloExternoSinAvion,
  HOJAS_APARTE_BALANCE,
  PARCIAL_A_INDIRECTOS,
  parcialEntraAlAvion,
  vueloEmbebido,
} from './hojas-balance.util';

/**
 * Conjuntos y lectores COMPARTIDOS por los balances y su espejo de
 * Conciliación (13-oct-2026, invariante 72). Cambiar una membresía mueve
 * dinero de hoja: falla aquí, no en el cierre.
 */
describe('hojas-balance.util — membresías congeladas', () => {
  it('HOJAS_APARTE_BALANCE = GAS, PERMISO, TUAS', () => {
    expect([...HOJAS_APARTE_BALANCE].sort()).toEqual([
      'GAS',
      'PERMISO',
      'TUAS',
    ]);
  });

  it('PARCIAL_A_INDIRECTOS = INDIRECTO, NOMINA', () => {
    expect([...PARCIAL_A_INDIRECTOS].sort()).toEqual(['INDIRECTO', 'NOMINA']);
  });
});

describe('parcialEntraAlAvion', () => {
  it('sin vuelo ⇒ siempre; con vuelo ⇒ solo categorías de EMPRESA', () => {
    expect(
      parcialEntraAlAvion({ vuelo_id: null, categoria: 'INDIRECTO' }),
    ).toBe(true);
    expect(parcialEntraAlAvion({ categoria: 'INDIRECTO' })).toBe(true);
    expect(parcialEntraAlAvion({ vuelo_id: 'v-1', categoria: 'OTRO' })).toBe(
      true,
    );
    expect(parcialEntraAlAvion({ vuelo_id: 'v-1', categoria: 'NOMINA' })).toBe(
      true,
    );
    expect(
      parcialEntraAlAvion({ vuelo_id: 'v-1', categoria: 'INDIRECTO' }),
    ).toBe(false);
    expect(parcialEntraAlAvion({ vuelo_id: 'v-1', categoria: null })).toBe(
      false,
    );
  });
});

describe('esVueloExternoSinAvion', () => {
  it('externo sin avión ⇒ true; con avión ⇒ false; null ⇒ false', () => {
    expect(
      esVueloExternoSinAvion({ es_externo: true, aeronave_id: null }),
    ).toBe(true);
    expect(esVueloExternoSinAvion({ es_externo: true })).toBe(true);
    expect(
      esVueloExternoSinAvion({ es_externo: true, aeronave_id: 'av-1' }),
    ).toBe(false);
    expect(
      esVueloExternoSinAvion({ es_externo: false, aeronave_id: null }),
    ).toBe(false);
    expect(esVueloExternoSinAvion(null)).toBe(false);
  });
});

describe('avionDeGastoEmbebido (escala → gasto → vuelo, con herencia)', () => {
  it('la escala con avión gana sobre el gasto sellado', () => {
    expect(
      avionDeGastoEmbebido({
        escala_id: 'e-1',
        aeronave_id: 'av-sellado',
        escala: { aeronave_id: 'av-tramo' },
        vuelo: { aeronave_id: 'av-vuelo' },
      }),
    ).toBe('av-tramo');
  });

  it('una escala SIN avión hereda el del vuelo (antes que el sellado)', () => {
    expect(
      avionDeGastoEmbebido({
        escala_id: 'e-1',
        aeronave_id: 'av-sellado',
        escala: { aeronave_id: null },
        vuelo: { aeronave_id: 'av-vuelo' },
      }),
    ).toBe('av-vuelo');
  });

  it('sellado sin escala ⇒ el sellado; nada ⇒ el del vuelo', () => {
    expect(
      avionDeGastoEmbebido({
        escala_id: null,
        aeronave_id: 'av-sellado',
        vuelo: { aeronave_id: 'av-vuelo' },
      }),
    ).toBe('av-sellado');
    expect(
      avionDeGastoEmbebido({
        escala_id: null,
        aeronave_id: null,
        vuelo: { aeronave_id: 'av-vuelo' },
      }),
    ).toBe('av-vuelo');
    expect(avionDeGastoEmbebido({})).toBeNull();
  });

  it('los embeds como objeto o como [objeto] valen igual', () => {
    const base = { escala_id: 'e-1', aeronave_id: null };
    expect(
      avionDeGastoEmbebido({
        ...base,
        escala: [{ aeronave_id: 'av-tramo' }],
        vuelo: [{ aeronave_id: 'av-vuelo' }],
      }),
    ).toBe('av-tramo');
    expect(
      avionDeGastoEmbebido({
        escala_id: null,
        aeronave_id: null,
        vuelo: [{ aeronave_id: 'av-vuelo' }],
      }),
    ).toBe('av-vuelo');
  });
});

describe('embebido / vueloEmbebido', () => {
  it('[] ⇒ null; objeto o [objeto] ⇒ el objeto', () => {
    expect(embebido([])).toBeNull();
    expect(embebido(null)).toBeNull();
    expect(embebido({ a: 1 })).toEqual({ a: 1 });
    expect(embebido([{ a: 1 }])).toEqual({ a: 1 });
    expect(vueloEmbebido({ vuelo: [] })).toBeNull();
    expect(vueloEmbebido({ vuelo: [{ folio: 1 }] })).toEqual({ folio: 1 });
  });
});
