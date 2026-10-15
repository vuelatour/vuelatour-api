import { cobroEnUsd, cobrosEnUsd, retieneCobros } from './cobros-usd.util';

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

/**
 * `cobroEnUsd` (14-oct-2026, API 0.0.78, invariante 77): el USD de UN cobro
 * con la MISMA regla y respaldo que `cobrosEnUsd` (`cobros[i].monto_usd` del
 * snapshot y el `usd` de «Cobrado de más»). null = MXN que no convierte.
 */
describe('cobroEnUsd', () => {
  it('USD tal cual; MXN con su T.C.; MXN sin T.C. propio con el respaldo', () => {
    expect(cobroEnUsd({ monto: 1000, moneda: 'USD' }, 17)).toBe(1000);
    expect(
      cobroEnUsd({ monto: 60988, moneda: 'MXN', tc_usd_mxn: 16.96 }, null),
    ).toBe(3595.99);
    expect(cobroEnUsd({ monto: 1700, moneda: 'MXN' }, 17.15)).toBe(99.13);
  });

  it('MXN sin T.C. ni respaldo ⇒ null (jamás 0 en falso ni el monto crudo)', () => {
    expect(cobroEnUsd({ monto: 8500, moneda: 'MXN' }, null)).toBeNull();
    expect(
      cobroEnUsd({ monto: 8500, moneda: 'MXN', tc_usd_mxn: 0 }),
    ).toBeNull();
  });

  it('reembolso ⇒ su USD negativo; monto 0 ⇒ 0', () => {
    expect(cobroEnUsd({ monto: -500, moneda: 'USD' }, null)).toBe(-500);
    expect(cobroEnUsd({ monto: 0, moneda: 'MXN' }, null)).toBe(0);
  });

  it('la suma de los cobros de un vuelo cuadra con cobrosEnUsd (#285, real)', () => {
    const cobros = [
      { monto: 15050, moneda: 'MXN', tc_usd_mxn: 17.5 },
      { monto: 11750, moneda: 'MXN', tc_usd_mxn: 17.5 },
    ];
    const suma = cobros.reduce((a, c) => a + (cobroEnUsd(c, 17.5) ?? 0), 0);
    expect(Math.round(suma * 100) / 100).toBe(
      cobrosEnUsd(cobros, 17.5).total_usd,
    );
  });
});
