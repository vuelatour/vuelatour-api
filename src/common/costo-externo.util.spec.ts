import { BadRequestException } from '@nestjs/common';
import { resolverCostoExterno } from './costo-externo.util';

describe('resolverCostoExterno (fuente única del costo del externo)', () => {
  it('USD: usd = monto tal cual, sin TC', () => {
    expect(
      resolverCostoExterno({ monto: 4500, moneda: 'USD', tcVuelo: 18 }),
    ).toEqual({ monto: 4500, moneda: 'USD', tc: null, usd: 4500 });
  });

  it('moneda omitida = USD (compat con payloads legados)', () => {
    expect(resolverCostoExterno({ monto: '1200.505' })).toEqual({
      monto: 1200.51,
      moneda: 'USD',
      tc: null,
      usd: 1200.51,
    });
  });

  it('MXN con TC del DTO: usd derivado = monto / tc (2 decimales)', () => {
    expect(
      resolverCostoExterno({ monto: 90000, moneda: 'MXN', tc: 18 }),
    ).toEqual({ monto: 90000, moneda: 'MXN', tc: 18, usd: 5000 });
  });

  it('MXN sin TC propio usa el de la cotización (respaldo)', () => {
    expect(
      resolverCostoExterno({ monto: 35000, moneda: 'MXN', tcVuelo: '17.5' }),
    ).toEqual({ monto: 35000, moneda: 'MXN', tc: 17.5, usd: 2000 });
  });

  it('MXN sin ningún TC: rechaza con 400 (jamás sumar crudo como USD)', () => {
    expect(() => resolverCostoExterno({ monto: 35000, moneda: 'MXN' })).toThrow(
      BadRequestException,
    );
  });

  it('TC fuera de la banda 15–25: rechaza con 400 (error de captura)', () => {
    expect(() =>
      resolverCostoExterno({ monto: 100, moneda: 'MXN', tc: 5 }),
    ).toThrow(BadRequestException);
    expect(() =>
      resolverCostoExterno({ monto: 100, moneda: 'MXN', tcVuelo: 30 }),
    ).toThrow(BadRequestException);
  });

  it('monto vacío/0/negativo = limpiar: las 4 columnas null', () => {
    const nulo = { monto: null, moneda: null, tc: null, usd: null };
    expect(resolverCostoExterno({ monto: null, moneda: 'MXN' })).toEqual(nulo);
    expect(resolverCostoExterno({ monto: 0, moneda: 'USD' })).toEqual(nulo);
    expect(resolverCostoExterno({ monto: undefined })).toEqual(nulo);
    expect(resolverCostoExterno({ monto: -10 })).toEqual(nulo);
  });
});
