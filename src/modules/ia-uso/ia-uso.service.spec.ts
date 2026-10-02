import {
  FACTOR_LECTURA_CACHE,
  TARIFAS,
  costoIaUsd,
  tarifaIa,
} from './ia-uso.service';

/**
 * Tarifas de IA (2-oct-2026): `TARIFAS` se EXPORTA para el catálogo de
 * «Modelo de IA» y `tarifaIa` es la regla ÚNICA de prefijo que comparten
 * `costoIaUsd` y `ia-modelo.util#tarifaDe`. El costo de una llamada NO cambia
 * (salvo Opus 5.5, que ahora se cobra con su tarifa real: 4/20 y caché 0.05x).
 */
describe('ia-uso.service — tarifas', () => {
  it('TARIFAS congeladas (USD por millón de tokens)', () => {
    expect(TARIFAS).toEqual([
      { prefijo: 'claude-opus-4-8', inUsdPorMillon: 5, outUsdPorMillon: 25 },
      { prefijo: 'claude-opus-4-7', inUsdPorMillon: 5, outUsdPorMillon: 25 },
      { prefijo: 'claude-opus-4-6', inUsdPorMillon: 5, outUsdPorMillon: 25 },
      { prefijo: 'claude-opus-5-5', inUsdPorMillon: 4, outUsdPorMillon: 20 },
      { prefijo: 'claude-opus-5', inUsdPorMillon: 5, outUsdPorMillon: 25 },
      { prefijo: 'claude-sonnet-4-6', inUsdPorMillon: 3, outUsdPorMillon: 15 },
      { prefijo: 'claude-sonnet-5', inUsdPorMillon: 2, outUsdPorMillon: 10 },
      { prefijo: 'claude-haiku-4-5', inUsdPorMillon: 1, outUsdPorMillon: 5 },
    ]);
  });

  it('tarifaIa por prefijo, sin distinguir mayúsculas ni espacios; null sin tarifa', () => {
    expect(tarifaIa('claude-opus-4-8')?.prefijo).toBe('claude-opus-4-8');
    // Opus 5.5 tiene renglón propio ANTES de `claude-opus-5` (primera
    // coincidencia por prefijo): antes caía en la tarifa de Opus 5.
    expect(tarifaIa(' CLAUDE-OPUS-5-5 ')?.prefijo).toBe('claude-opus-5-5');
    expect(tarifaIa('claude-opus-5')?.prefijo).toBe('claude-opus-5');
    expect(tarifaIa('claude-opus-5-20260601')?.prefijo).toBe('claude-opus-5');
    expect(tarifaIa('claude-haiku-4-5-20251001')?.prefijo).toBe(
      'claude-haiku-4-5',
    );
    for (const v of ['claude-nuevo-9', '', '   ', null, undefined]) {
      expect(tarifaIa(v)).toBeNull();
    }
  });

  it('costoIaUsd idéntico al de antes (entrada, salida y caché ×1.25 / ×0.10)', () => {
    // Opus 4.8: 10,000 in + 2,000 out + 50,000 creación + 100,000 lectura.
    // (10,000×5 + 50,000×5×1.25 + 100,000×5×0.1 + 2,000×25) / 1e6
    expect(costoIaUsd('claude-opus-4-8', 10_000, 2_000, 50_000, 100_000)).toBe(
      0.4625,
    );
    expect(costoIaUsd('claude-sonnet-5', 1_000_000, 0, 0, 0)).toBe(2);
    expect(costoIaUsd('claude-haiku-4-5-20251001', 0, 1_000_000, 0, 0)).toBe(5);
    expect(costoIaUsd('claude-nuevo-9', 1_000_000, 1_000_000, 0, 0)).toBe(0);
    expect(costoIaUsd('', 1_000_000, 1_000_000, 0, 0)).toBe(0);
  });

  it('Opus 5.5 cuesta 4/20 y su lectura de caché 0.05x (no 5/25 ni 0.10x)', () => {
    expect(FACTOR_LECTURA_CACHE).toEqual({ 'claude-opus-5-5': 0.05 });
    expect(costoIaUsd('claude-opus-5-5', 1_000_000, 1_000_000, 0, 0)).toBe(24);
    // Creación ×1.25 ($5/M) y lectura ×0.05 ($0.20/M).
    expect(costoIaUsd('claude-opus-5-5', 0, 0, 1_000_000, 0)).toBe(5);
    expect(costoIaUsd('claude-opus-5-5', 0, 0, 0, 1_000_000)).toBe(0.2);
    // Opus 5 sigue en 5/25 con lectura ×0.10.
    expect(costoIaUsd('claude-opus-5', 1_000_000, 1_000_000, 0, 0)).toBe(30);
    expect(costoIaUsd('claude-opus-5', 0, 0, 0, 1_000_000)).toBe(0.5);
  });
});
