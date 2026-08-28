import {
  calcularCompra,
  parsearCantidadConcepto,
  RE_CONCEPTO_CARGO,
  rolPorTexto,
} from './compras.calculo';

// Caso real del cliente (28-ago-2026): Aircraft Spruce en USD con Shipping
// impreso en la factura + factura de UPS en pesos (impuestos aduanales,
// honorarios, manejo, IVA) a TC 17.2244.
const COMPRA = {
  moneda: 'USD' as const,
  tc_usd_mxn: 17.2244,
  cargos_factura: [{ concepto: 'Shipping', monto: 100.8 }],
  estado: 'ABIERTA' as const,
};
// 3 × 120.00 + 2 × 85.55 + 1 × 91.00 = 622.10
const LINEAS = [
  { id: 'a', cantidad: 3, costo_unitario: 120 },
  { id: 'b', cantidad: 2, costo_unitario: 85.55 },
  { id: 'c', cantidad: 1, costo_unitario: 91 },
];
const PAGOS = [
  { monto: 722.9, moneda: 'USD', tc_gasto: null, compra_rol: 'MERCANCIA' },
  { monto: 4525.83, moneda: 'MXN', tc_gasto: null, compra_rol: 'IMPUESTOS' },
];

const sumaFinal = (
  lineas: Array<{ cantidad: number; costo_unitario_final: number }>,
) => lineas.reduce((s, l) => s + l.cantidad * l.costo_unitario_final, 0);

describe('calcularCompra — caso Aircraft Spruce + UPS', () => {
  const { lineas, resumen } = calcularCompra(COMPRA, LINEAS, PAGOS);

  it('suma mercancía, cargos de factura y cargos de pagos convertidos', () => {
    expect(resumen.total_mercancia).toBe(622.1);
    expect(resumen.cargos_factura).toBe(100.8);
    // 4,525.83 MXN / 17.2244 = 262.76 USD
    expect(resumen.cargos_pagos).toBeCloseTo(262.76, 2);
    expect(resumen.total).toBeCloseTo(985.66, 2);
    expect(resumen.factor).toBeCloseTo(985.66 / 622.1, 4);
    expect(resumen.moneda).toBe('USD');
    expect(resumen.total_usd).toBeCloseTo(985.66, 2);
    expect(resumen.total_mxn).toBeCloseTo(985.66 * 17.2244, 1);
  });

  it('prorratea por valor y el residuo de centavos cae en la última línea', () => {
    expect(lineas[0].costo_unitario_final).toBeCloseTo(120 * resumen.factor, 3);
    expect(lineas[1].costo_unitario_final).toBeCloseTo(
      85.55 * resumen.factor,
      3,
    );
    // Σ cantidad × final == total (±0.01) — invariante del inventario.
    expect(Math.abs(sumaFinal(lineas) - resumen.total)).toBeLessThanOrEqual(
      0.01,
    );
    expect(lineas[0].total_linea_final).toBeCloseTo(
      3 * lineas[0].costo_unitario_final,
      2,
    );
  });

  it('expresa el costo final en ambas monedas con el TC de la compra', () => {
    expect(lineas[0].costo_unitario_final_usd).toBe(
      lineas[0].costo_unitario_final,
    );
    expect(lineas[0].costo_unitario_final_mxn).toBeCloseTo(
      lineas[0].costo_unitario_final * 17.2244,
      3,
    );
  });

  it('no avisa cuando la factura de mercancía cuadra (622.10 + 100.80 = 722.90)', () => {
    expect(resumen.avisos).toEqual([]);
    expect(resumen.cargos_sin_tc).toEqual([]);
  });
});

describe('calcularCompra — avisos', () => {
  it('avisa si la factura de mercancía no cuadra con las líneas (±1 %)', () => {
    const { resumen } = calcularCompra(COMPRA, LINEAS, [
      { monto: 800, moneda: 'USD', tc_gasto: null, compra_rol: 'MERCANCIA' },
    ]);
    expect(resumen.avisos).toEqual([
      'la factura de mercancía ($800.00) no cuadra con las líneas ($722.90)',
    ]);
  });

  it('un cargo en otra moneda SIN TC no se prorratea y se avisa', () => {
    const { resumen, lineas } = calcularCompra(
      { ...COMPRA, tc_usd_mxn: null },
      LINEAS,
      PAGOS,
    );
    expect(resumen.cargos_pagos).toBe(0);
    expect(resumen.total).toBeCloseTo(722.9, 2);
    expect(resumen.avisos).toContain(
      'cargo $4,525.83 MXN sin TC (no prorrateado)',
    );
    // Estructurado para que `recibir` se niegue (salvo forzar).
    expect(resumen.cargos_sin_tc).toEqual([{ monto: 4525.83, moneda: 'MXN' }]);
    expect(resumen.total_mxn).toBeNull();
    expect(lineas[0].costo_unitario_final_mxn).toBeNull();
  });

  it('el TC del gasto manda sobre el de la compra', () => {
    const { resumen } = calcularCompra(COMPRA, LINEAS, [
      { monto: 4525.83, moneda: 'MXN', tc_gasto: 18, compra_rol: 'ENVIO' },
    ]);
    expect(resumen.cargos_pagos).toBeCloseTo(4525.83 / 18, 2);
  });

  it('compra RECIBIDA con cargos nuevos → pide recalcular', () => {
    const recibidas = LINEAS.map((l) => ({
      ...l,
      // Entró con el costo de factura + solo el shipping (antes del pago UPS).
      costo_unitario_recibido: l.costo_unitario * (722.9 / 622.1),
    }));
    const { resumen } = calcularCompra(
      { ...COMPRA, estado: 'RECIBIDA' },
      recibidas,
      PAGOS,
    );
    expect(resumen.avisos).toContain(
      'recalcular: hay cargos nuevos desde la recepción',
    );

    const alDia = LINEAS.map((l, i) => ({
      ...l,
      costo_unitario_recibido: calcularCompra(COMPRA, LINEAS, PAGOS).lineas[i]
        .costo_unitario_final,
    }));
    expect(
      calcularCompra({ ...COMPRA, estado: 'RECIBIDA' }, alDia, PAGOS).resumen
        .avisos,
    ).toEqual([]);
  });

  it('a 4 decimales: un final x.xx50 recibido tal cual NO pide recalcular', () => {
    // 100 × 0.10 = 10.00 + 0.50 de shipping → factor 1.05 → final 0.1050.
    // La columna del cardex guarda 4 decimales: lo que entró (0.105) es
    // exactamente el final; antes el aviso se quedaba pegado por redondeo.
    const compra = {
      moneda: 'USD' as const,
      tc_usd_mxn: null,
      cargos_factura: [{ concepto: 'Shipping', monto: 0.5 }],
      estado: 'RECIBIDA' as const,
    };
    const { lineas, resumen } = calcularCompra(
      compra,
      [{ cantidad: 100, costo_unitario: 0.1, costo_unitario_recibido: 0.105 }],
      [],
    );
    expect(resumen.factor).toBe(1.05);
    expect(lineas[0].costo_unitario_final).toBe(0.105);
    expect(resumen.avisos).toEqual([]);

    // Un diezmilésimo de diferencia SÍ es un cargo nuevo (ya no se esconde
    // bajo la tolerancia de centavos).
    const { resumen: desfasado } = calcularCompra(
      compra,
      [{ cantidad: 100, costo_unitario: 0.1, costo_unitario_recibido: 0.1049 }],
      [],
    );
    expect(desfasado.avisos).toContain(
      'recalcular: hay cargos nuevos desde la recepción',
    );
    // La BD devuelve numeric como texto: misma conclusión.
    const { resumen: texto } = calcularCompra(
      compra,
      [
        {
          cantidad: 100,
          costo_unitario: '0.1000',
          costo_unitario_recibido: '0.1050',
        },
      ],
      [],
    );
    expect(texto.avisos).toEqual([]);
  });

  it('Σ round(cantidad × final, 2) == total (500 × 0.05 + 1 × 100 + cargos 58.32)', () => {
    // Muchas unidades baratas + una cara: el residuo del prorrateo a 4
    // decimales cae en la última línea y los totales por línea (a centavos)
    // deben sumar EXACTO el total de la compra — es lo que entra al cardex.
    const { lineas, resumen } = calcularCompra(
      {
        moneda: 'USD',
        tc_usd_mxn: null,
        cargos_factura: [{ concepto: 'Shipping', monto: 58.32 }],
        estado: 'ABIERTA',
      },
      [
        { cantidad: 500, costo_unitario: 0.05 },
        { cantidad: 1, costo_unitario: 100 },
      ],
      [],
    );
    expect(resumen.total_mercancia).toBe(125);
    expect(resumen.total).toBe(183.32);
    const sumaCentavos = lineas.reduce(
      (s, l) => s + Math.round(l.cantidad * l.costo_unitario_final * 100) / 100,
      0,
    );
    expect(Math.round(sumaCentavos * 100) / 100).toBe(resumen.total);
    expect(
      Math.round(lineas.reduce((s, l) => s + l.total_linea_final, 0) * 100) /
        100,
    ).toBe(resumen.total);
  });

  it('mercancía en $0: factor 1 y los cargos se reparten por unidad', () => {
    const { lineas, resumen } = calcularCompra(
      { moneda: 'MXN', tc_usd_mxn: 17, cargos_factura: [], estado: 'ABIERTA' },
      [
        { cantidad: 3, costo_unitario: 0 },
        { cantidad: 1, costo_unitario: 0 },
      ],
      [{ monto: 400, moneda: 'MXN', tc_gasto: null, compra_rol: 'ENVIO' }],
    );
    expect(resumen.factor).toBe(1);
    expect(resumen.total).toBe(400);
    expect(lineas[0].costo_unitario_final).toBe(100);
    expect(Math.abs(sumaFinal(lineas) - 400)).toBeLessThanOrEqual(0.01);
  });

  it('sin líneas ni pagos: todo en cero, sin avisos', () => {
    const { resumen } = calcularCompra(COMPRA, [], []);
    expect(resumen.total_mercancia).toBe(0);
    expect(resumen.total).toBe(100.8);
    expect(resumen.factor).toBe(1);
    expect(resumen.avisos).toEqual([]);
  });

  it('compra en MXN con pago en USD: convierte con el TC (× tc)', () => {
    const { resumen } = calcularCompra(
      {
        moneda: 'MXN',
        tc_usd_mxn: 17.5,
        cargos_factura: [],
        estado: 'ABIERTA',
      },
      [{ cantidad: 1, costo_unitario: 1000 }],
      [{ monto: 10, moneda: 'USD', tc_gasto: null, compra_rol: 'ENVIO' }],
    );
    expect(resumen.cargos_pagos).toBe(175);
    expect(resumen.total).toBe(1175);
    expect(resumen.total_usd).toBeCloseTo(1175 / 17.5, 2);
  });
});

describe('heurísticas de texto', () => {
  it('parsea "(xN)" y "(Nx)" al final del concepto', () => {
    expect(parsearCantidadConcepto('Bolt AN3-4A (x3)')).toEqual({
      nombre: 'Bolt AN3-4A',
      cantidad: 3,
    });
    expect(parsearCantidadConcepto('Filtro CH48110 (2 x)')).toEqual({
      nombre: 'Filtro CH48110',
      cantidad: 2,
    });
    expect(parsearCantidadConcepto('Shipping')).toEqual({
      nombre: 'Shipping',
      cantidad: 1,
    });
  });

  it('distingue cargos de refacciones (tax con borde de palabra)', () => {
    expect(RE_CONCEPTO_CARGO.test('Shipping')).toBe(true);
    expect(RE_CONCEPTO_CARGO.test('Sales Tax')).toBe(true);
    expect(RE_CONCEPTO_CARGO.test('Honorarios agente aduanal')).toBe(true);
    expect(RE_CONCEPTO_CARGO.test('Taxi light bulb')).toBe(false);
    expect(RE_CONCEPTO_CARGO.test('Rivet MS20470AD4')).toBe(false);
  });

  it('rol por texto: IMPUESTOS gana a ENVIO; sin señal → OTRO', () => {
    expect(
      rolPorTexto('UPS · impuestos aduanales, honorarios, manejo, IVA'),
    ).toBe('IMPUESTOS');
    expect(rolPorTexto('DHL Express envío')).toBe('ENVIO');
    expect(rolPorTexto('Seguro de la pieza')).toBe('OTRO');
  });
});
