import { cobrosEnUsd, retieneCobros } from './cobros-usd.util';

/**
 * `retieneCobros` (13-oct-2026, invariante 61): ¿el reparto lee este
 * CANCELADO? FUENTE ÚNICA del salto del cancelado sin cobros en el reparto,
 * del universo de la «Comisión del vendedor (avión)» y de la nota del Libro
 * Dinero.
 */
describe('retieneCobros', () => {
  it('USD positivo ⇒ true', () => {
    expect(
      retieneCobros(cobrosEnUsd([{ monto: 500, moneda: 'USD' }], null)),
    ).toBe(true);
  });

  it('MXN sin T.C. (ni del cobro ni de respaldo) ⇒ true (sin_tc_mxn)', () => {
    const c = cobrosEnUsd([{ monto: 8500, moneda: 'MXN' }], null);
    expect(c.total_usd).toBe(0);
    expect(c.sin_tc_mxn).toBe(8500);
    expect(retieneCobros(c)).toBe(true);
  });

  it('MXN con T.C. de respaldo ⇒ true por el total USD', () => {
    expect(
      retieneCobros(cobrosEnUsd([{ monto: 1700, moneda: 'MXN' }], 17)),
    ).toBe(true);
  });

  it('reembolso neto 0 ⇒ false (el cliente recuperó todo)', () => {
    expect(
      retieneCobros(
        cobrosEnUsd(
          [
            { monto: 500, moneda: 'USD' },
            { monto: -500, moneda: 'USD' },
          ],
          null,
        ),
      ),
    ).toBe(false);
  });

  it('vacío ⇒ false', () => {
    expect(retieneCobros(cobrosEnUsd([], 17))).toBe(false);
    expect(
      retieneCobros({ total_usd: 0, sin_tc_count: 0, sin_tc_mxn: 0 }),
    ).toBe(false);
  });
});
