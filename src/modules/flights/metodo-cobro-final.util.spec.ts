import {
  metodoCobroFinal,
  vueloLiquidado,
  TOLERANCIA_LIQUIDACION_USD,
} from './metodo-cobro-final.util';

/**
 * "Cómo se cobró AL FINAL" (11-sep-2026): el método del cobro que LIQUIDA
 * el vuelo se copia a `vuelo.metodo_cobro` como dato informativo. El
 * snapshot/IVA/desglose NO se tocan (eso lo vigila el spec del service).
 */
describe('vueloLiquidado', () => {
  it('cubre el total con la tolerancia de 1 USD', () => {
    expect(TOLERANCIA_LIQUIDACION_USD).toBe(1);
    expect(vueloLiquidado(1000, 1000)).toBe(true);
    expect(vueloLiquidado(999, 1000)).toBe(true);
    expect(vueloLiquidado(998.99, 1000)).toBe(false);
    expect(vueloLiquidado(1200, 1000)).toBe(true);
  });

  it('vuelo SIN precio ($0 / interno / aún sin cotizar) nunca liquida', () => {
    expect(vueloLiquidado(0, 0)).toBe(false);
    expect(vueloLiquidado(500, 0)).toBe(false);
  });

  it('valores no numéricos no liquidan (nunca "se cobró" por un NaN)', () => {
    expect(vueloLiquidado(Number.NaN, 1000)).toBe(false);
    expect(vueloLiquidado(1000, Number.NaN)).toBe(false);
  });
});

describe('metodoCobroFinal', () => {
  it('el cobro que liquida con OTRO método → ese método', () => {
    expect(
      metodoCobroFinal({
        metodoDelCobro: 'EFECTIVO',
        metodoVigente: 'TRANSFERENCIA',
        cobradoUsd: 1000,
        montoTotalUsd: 1000,
      }),
    ).toBe('EFECTIVO');
  });

  it('anticipo que NO liquida → null (no se toca el previsto)', () => {
    expect(
      metodoCobroFinal({
        metodoDelCobro: 'EFECTIVO',
        metodoVigente: 'TRANSFERENCIA',
        cobradoUsd: 400,
        montoTotalUsd: 1000,
      }),
    ).toBeNull();
  });

  it('liquida con el MISMO método previsto → null (nada que escribir)', () => {
    expect(
      metodoCobroFinal({
        metodoDelCobro: 'TRANSFERENCIA',
        metodoVigente: 'TRANSFERENCIA',
        cobradoUsd: 1000,
        montoTotalUsd: 1000,
      }),
    ).toBeNull();
  });

  it('vuelo sin método previsto: el que liquida lo sella', () => {
    expect(
      metodoCobroFinal({
        metodoDelCobro: 'BILLPOCKET',
        metodoVigente: null,
        cobradoUsd: 1000,
        montoTotalUsd: 1000,
      }),
    ).toBe('BILLPOCKET');
  });

  it('vuelo sin precio o cobro sin método → null', () => {
    expect(
      metodoCobroFinal({
        metodoDelCobro: 'EFECTIVO',
        metodoVigente: null,
        cobradoUsd: 500,
        montoTotalUsd: 0,
      }),
    ).toBeNull();
    expect(
      metodoCobroFinal({
        metodoDelCobro: '   ',
        metodoVigente: 'TRANSFERENCIA',
        cobradoUsd: 1000,
        montoTotalUsd: 1000,
      }),
    ).toBeNull();
  });
});
