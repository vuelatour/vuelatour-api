import {
  cobroEnUsd,
  cobrosEnMxn,
  cobrosEnUsd,
  retieneCobros,
} from './cobros-usd.util';

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

/**
 * PESOS PRIMERO (20-oct-2026, invariante 99): con el T.C. CAPTURADO en la
 * cotización (K) el precio en pesos es la verdad y TODO cobro MXN se cuenta
 * con K, no con el T.C. de referencia que la oficina tecleó en cada cobro.
 * Sin K rige la regla de siempre (T.C. del cobro ?? respaldo).
 */
describe('cobrosEnUsd · pesos primero (K de la cotización)', () => {
  // Vuelo #332 (N621TX, Beh Kay, 24-sep-2026) tal cual está en prod: cotizado
  // $4,172.44 USD = $72,585.38 MXN (K 17.396374, derivado del total en
  // pesos); pagado $72,585.45 MXN en cuatro cobros a 17.15 y 17.40.
  const K332 = 17.396374;
  const cobros332 = [
    { monto: 977.45, moneda: 'MXN', tc_usd_mxn: 17.15 },
    { monto: 1700, moneda: 'MXN', tc_usd_mxn: 17.4 },
    { monto: 1700, moneda: 'MXN', tc_usd_mxn: 17.4 },
    { monto: 68208, moneda: 'MXN', tc_usd_mxn: 17.4 },
  ];

  it('#332: con el T.C. de cada cobro «faltaban» 0.04 USD (= 0.70 MXN); con K el vuelo está pagado', () => {
    // Regla de siempre (sin K): 4,172.40 < 4,172.44 ⇒ pendiente fantasma.
    expect(cobrosEnUsd(cobros332, K332).total_usd).toBe(4172.4);
    // Pesos primero: 72,585.45 / 17.396374 = 4,172.447 ⇒ 4,172.45 ≥ total:
    // pagado (los 7 centavos de más en pesos son un centavo de dólar; el K de
    // 6 decimales no reproduce el total en pesos al centavo: 4,172.44 × K =
    // 72,585.33, no 72,585.38 — por eso el precio en pesos se LEE).
    const conv = cobrosEnUsd(cobros332, K332, K332);
    expect(conv.total_usd).toBe(4172.45);
    expect(conv.total_usd).toBeGreaterThanOrEqual(4172.44);
    expect(conv.sin_tc_count).toBe(0);
    expect(conv.sin_tc_mxn).toBe(0);
  });

  it('K manda sobre el T.C. del cobro y sobre el respaldo; USD sigue tal cual', () => {
    const cobros = [
      { monto: 1750, moneda: 'MXN', tc_usd_mxn: 18 },
      { monto: 1750, moneda: 'MXN' },
      { monto: 100, moneda: 'USD', tc_usd_mxn: 19 },
    ];
    // 1750/17.5 + 1750/17.5 + 100 = 300
    expect(cobrosEnUsd(cobros, 16, 17.5).total_usd).toBe(300);
    // Sin K: 1750/18 + 1750/16 + 100 = 97.22 + 109.38 + 100
    expect(cobrosEnUsd(cobros, 16).total_usd).toBe(306.6);
  });

  it('K inválido (0, negativo, texto, null) ⇒ regla de siempre', () => {
    const cobros = [{ monto: 1750, moneda: 'MXN', tc_usd_mxn: 17.5 }];
    for (const k of [0, -1, 'x', null, undefined, NaN]) {
      expect(cobrosEnUsd(cobros, 20, k as number).total_usd).toBe(100);
    }
    // K como texto numérico (columna numeric de Postgres) sí cuenta.
    expect(cobrosEnUsd(cobros, 20, '17.5').total_usd).toBe(100);
    expect(cobrosEnUsd(cobros, 20, '20').total_usd).toBe(87.5);
  });

  it('reembolsos MXN restan con K; un MXN sin K ni T.C. sigue en sin_tc', () => {
    expect(
      cobrosEnUsd(
        [
          { monto: 3500, moneda: 'MXN', tc_usd_mxn: 18 },
          { monto: -1750, moneda: 'MXN', tc_usd_mxn: 16 },
        ],
        null,
        17.5,
      ).total_usd,
    ).toBe(100);
    const sin = cobrosEnUsd([{ monto: 500, moneda: 'MXN' }], null, null);
    expect(sin.total_usd).toBe(0);
    expect(sin.sin_tc_count).toBe(1);
  });

  it('cobroEnUsd hereda K (el `monto_usd` del snapshot y «Cobrado de más»)', () => {
    expect(
      cobroEnUsd({ monto: 68208, moneda: 'MXN', tc_usd_mxn: 17.4 }, K332, K332),
    ).toBe(3920.82);
    expect(
      cobroEnUsd({ monto: 68208, moneda: 'MXN', tc_usd_mxn: 17.4 }, K332),
    ).toBe(3920);
  });
});

/** `cobrosEnMxn`: el espejo en pesos (20-oct-2026). */
describe('cobrosEnMxn', () => {
  it('MXN tal cual; USD × K; reembolsos restan (#332 ⇒ 72,585.45)', () => {
    const r = cobrosEnMxn(
      [
        { monto: 977.45, moneda: 'MXN', tc_usd_mxn: 17.15 },
        { monto: 1700, moneda: 'MXN', tc_usd_mxn: 17.4 },
        { monto: 1700, moneda: 'MXN', tc_usd_mxn: 17.4 },
        { monto: 68208, moneda: 'MXN', tc_usd_mxn: 17.4 },
      ],
      17.396374,
    );
    expect(r).toEqual({ total_mxn: 72585.45, sin_tc_count: 0, sin_tc_usd: 0 });
    expect(
      cobrosEnMxn(
        [
          { monto: 4152, moneda: 'USD' },
          { monto: -100, moneda: 'USD' },
        ],
        17.6425,
      ).total_mxn,
    ).toBe(71487.41);
  });

  it('USD sin K toma el T.C. del cobro; sin ninguno queda en sin_tc_usd', () => {
    expect(
      cobrosEnMxn([{ monto: 100, moneda: 'USD', tc_usd_mxn: 18 }], null)
        .total_mxn,
    ).toBe(1800);
    const sin = cobrosEnMxn([{ monto: 100, moneda: 'USD' }], null);
    expect(sin.total_mxn).toBe(0);
    expect(sin.sin_tc_count).toBe(1);
    expect(sin.sin_tc_usd).toBe(100);
  });
});
