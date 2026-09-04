import { resolverComisionBancaria } from './comision-bancaria.util';

describe('resolverComisionBancaria (regla única bruto/neto)', () => {
  it('sin comisión → nulls y no excede', () => {
    expect(resolverComisionBancaria(1000)).toEqual({
      pct: null,
      monto: null,
      excede: false,
    });
    expect(resolverComisionBancaria(1000, 0, 0)).toEqual({
      pct: null,
      monto: null,
      excede: false,
    });
  });

  it('por %: calcula el monto a 2 decimales', () => {
    expect(resolverComisionBancaria(1000, 3.5)).toEqual({
      pct: 3.5,
      monto: 35,
      excede: false,
    });
    expect(resolverComisionBancaria(333.33, 1.5).monto).toBe(5);
  });

  it('monto directo manda sobre el % y deriva el % a 4 decimales', () => {
    const r = resolverComisionBancaria(1000, 3.5, 12.345);
    expect(r.monto).toBe(12.35);
    expect(r.pct).toBe(1.235);
    expect(r.excede).toBe(false);
  });

  it('excede cuando la comisión iguala o supera el monto', () => {
    expect(resolverComisionBancaria(100, undefined, 100).excede).toBe(true);
    expect(resolverComisionBancaria(100, undefined, 150).excede).toBe(true);
    expect(resolverComisionBancaria(100, 99.99).excede).toBe(false);
  });
});
