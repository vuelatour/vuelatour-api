import {
  NOTA_PAGO_VENDEDOR_REAL,
  NOTA_PAGO_VENDEDOR_SIN_LINEA,
  NOTA_PROVISION_PAGO_VENDEDOR,
  TOLERANCIA_PAGO_VENDEDOR_MXN,
  conceptoPagoVendedorReal,
  motivoSinLineaComision,
  pagosVendedorDeVuelo,
  type GastoPagoVendedorRow,
  type PagosVendedorDeVuelo,
} from './pago-vendedor.util';

/**
 * PAGO REAL AL VENDEDOR ↔ COMISIÓN COBRADA (28-sep-2026, invariante 31):
 * fuente única del apareo que usan el Balance general («otros movimientos»)
 * y el Libro Dinero («Otros ingresos»).
 */

const g = (
  monto: number,
  extra: Partial<GastoPagoVendedorRow> = {},
): GastoPagoVendedorRow => ({
  categoria: 'COMISION_VENDEDOR',
  monto,
  moneda: 'MXN',
  tc_gasto: null,
  fecha_gasto: '2026-09-28',
  ...extra,
});

/** Conversor de prueba: MXN directo; USD × tc_gasto o 17.5; `sinTc` ⇒ null. */
const conversor =
  (opts: { tcRespaldo?: number | null } = {}) =>
  (x: GastoPagoVendedorRow): number | null => {
    const m = Number(x.monto);
    if (x.moneda === 'MXN') return m;
    const tc =
      Number(x.tc_gasto) > 0
        ? Number(x.tc_gasto)
        : opts.tcRespaldo === undefined
          ? 17.5
          : opts.tcRespaldo;
    return tc != null ? m * tc : null;
  };

const pagos = (p: Partial<PagosVendedorDeVuelo>): PagosVendedorDeVuelo => ({
  n: 1,
  pagadoMxn: 2030,
  sinTc: 0,
  fecha: '2026-09-28',
  ...p,
});

const SAAB = 'comisión vendedor (Alex Saab)';

describe('pagosVendedorDeVuelo', () => {
  it('sin gastos de la categoría ⇒ n 0, pagado null, sin fecha', () => {
    expect(pagosVendedorDeVuelo([], conversor())).toEqual({
      n: 0,
      pagadoMxn: null,
      sinTc: 0,
      fecha: null,
    });
  });

  it('filtra por categoría: TUAS/OTRO/HOTEL del mismo vuelo NO cuentan', () => {
    const r = pagosVendedorDeVuelo(
      [
        g(2030),
        g(1500, { categoria: 'TUAS' }),
        g(250000, { categoria: 'OTRO' }),
        g(800, { categoria: 'HOTEL' }),
        g(10, { categoria: null }),
      ],
      conversor(),
    );
    expect(r).toEqual({
      n: 1,
      pagadoMxn: 2030,
      sinTc: 0,
      fecha: '2026-09-28',
    });
  });

  it('MXN + USD convertido con el conversor INYECTADO (sin cadena de TC propia)', () => {
    const r = pagosVendedorDeVuelo(
      [g(1000), g(58, { moneda: 'USD', tc_gasto: 17.5 })],
      conversor(),
    );
    expect(r.pagadoMxn).toBe(2015);
    expect(r.n).toBe(2);
    // USD sin tc_gasto ⇒ el respaldo lo decide el LIBRO que llama.
    const r2 = pagosVendedorDeVuelo(
      [g(116, { moneda: 'USD', tc_gasto: null })],
      conversor({ tcRespaldo: 19 }),
    );
    expect(r2.pagadoMxn).toBe(2204);
  });

  it('conversor que no puede convertir ⇒ sinTc (no suma en falso)', () => {
    const r = pagosVendedorDeVuelo(
      [g(1000), g(50, { moneda: 'USD', tc_gasto: null })],
      conversor({ tcRespaldo: null }),
    );
    expect(r).toEqual({
      n: 2,
      pagadoMxn: 1000,
      sinTc: 1,
      fecha: '2026-09-28',
    });
    const todos = pagosVendedorDeVuelo(
      [g(50, { moneda: 'USD', tc_gasto: null })],
      conversor({ tcRespaldo: null }),
    );
    expect(todos.pagadoMxn).toBeNull();
    expect(todos.sinTc).toBe(1);
  });

  it('suma CRUDA y round2 al FINAL (no por gasto)', () => {
    // 3 × 0.004 = 0.012 ⇒ round2 al final = 0.01 (por gasto daría 0.00).
    const r = pagosVendedorDeVuelo([g(0.004), g(0.004), g(0.004)], conversor());
    expect(r.pagadoMxn).toBe(0.01);
  });

  it('fecha = la MÁS RECIENTE de los gastos de la categoría (monto string también)', () => {
    const r = pagosVendedorDeVuelo(
      [
        g(1000, { fecha_gasto: '2026-09-12' }),
        g('600' as unknown as number, { fecha_gasto: '2026-09-15' }),
        g(1, { fecha_gasto: '2026-09-30', categoria: 'OTRO' }),
        g(5, { fecha_gasto: null }),
      ],
      conversor(),
    );
    expect(r.fecha).toBe('2026-09-15');
    expect(r.pagadoMxn).toBe(1605);
    expect(r.n).toBe(3);
  });
});

describe('conceptoPagoVendedorReal (gramática EXACTA)', () => {
  it('exacto (#317: línea 2,030.00, pago 2,030.00)', () => {
    expect(
      conceptoPagoVendedorReal({
        etiquetaComision: SAAB,
        pagos: pagos({}),
        lineaMxn: 2030,
      }),
    ).toBe('pago comisión vendedor (Alex Saab) · gasto real');
  });

  it('parcial: pagar la comisión SIN su IVA (1,750.00 de 2,030.00)', () => {
    expect(
      conceptoPagoVendedorReal({
        etiquetaComision: SAAB,
        pagos: pagos({ pagadoMxn: 1750 }),
        lineaMxn: 2030,
      }),
    ).toBe(
      'pago comisión vendedor (Alex Saab) · gasto real · parcial: faltan $280.00 MXN',
    );
  });

  it('excedido (2,500.00 de 2,030.00)', () => {
    expect(
      conceptoPagoVendedorReal({
        etiquetaComision: SAAB,
        pagos: pagos({ pagadoMxn: 2500 }),
        lineaMxn: 2030,
      }),
    ).toBe(
      'pago comisión vendedor (Alex Saab) · gasto real · excede $470.00 MXN',
    );
  });

  it('miles con separador es-MX y SIEMPRE 2 decimales', () => {
    expect(
      conceptoPagoVendedorReal({
        etiquetaComision: SAAB,
        pagos: pagos({ pagadoMxn: 30 }),
        lineaMxn: 12030.5,
      }),
    ).toBe(
      'pago comisión vendedor (Alex Saab) · gasto real · parcial: faltan $12,000.50 MXN',
    );
  });

  it('tolerancia: 0.99 ⇒ sin marca; 1.00 ⇒ marca (en los dos sentidos)', () => {
    expect(TOLERANCIA_PAGO_VENDEDOR_MXN).toBe(1);
    const c = (pagado: number) =>
      conceptoPagoVendedorReal({
        etiquetaComision: SAAB,
        pagos: pagos({ pagadoMxn: pagado }),
        lineaMxn: 2030,
      });
    expect(c(2029.01)).toBe('pago comisión vendedor (Alex Saab) · gasto real');
    expect(c(2030.99)).toBe('pago comisión vendedor (Alex Saab) · gasto real');
    expect(c(2029)).toBe(
      'pago comisión vendedor (Alex Saab) · gasto real · parcial: faltan $1.00 MXN',
    );
    expect(c(2031)).toBe(
      'pago comisión vendedor (Alex Saab) · gasto real · excede $1.00 MXN',
    );
  });

  it('2 pagos (1,000 + 1,030) ⇒ «(2 pagos)» y sin marca', () => {
    expect(
      conceptoPagoVendedorReal({
        etiquetaComision: SAAB,
        pagos: pagos({ n: 2, pagadoMxn: 2030 }),
        lineaMxn: 2030,
      }),
    ).toBe('pago comisión vendedor (Alex Saab) · gasto real (2 pagos)');
  });

  it('USD con tc_gasto ≠ K de venta: la diferencia cambiaria real se ve (116 USD × 18.20 = 2,111.20)', () => {
    expect(
      conceptoPagoVendedorReal({
        etiquetaComision: SAAB,
        pagos: pagos({ pagadoMxn: 2111.2 }),
        lineaMxn: 2030,
      }),
    ).toBe(
      'pago comisión vendedor (Alex Saab) · gasto real · excede $81.20 MXN',
    );
  });

  it('sinTc parcial ⇒ «(parcial: USD sin TC)» y SIN comparación', () => {
    expect(
      conceptoPagoVendedorReal({
        etiquetaComision: SAAB,
        pagos: pagos({ n: 2, pagadoMxn: 1000, sinTc: 1 }),
        lineaMxn: 2030,
      }),
    ).toBe(
      'pago comisión vendedor (Alex Saab) · gasto real (2 pagos) (parcial: USD sin TC)',
    );
  });

  it('sinTc total ⇒ «(USD sin TC)»', () => {
    expect(
      conceptoPagoVendedorReal({
        etiquetaComision: SAAB,
        pagos: pagos({ pagadoMxn: null, sinTc: 1 }),
        lineaMxn: 2030,
      }),
    ).toBe('pago comisión vendedor (Alex Saab) · gasto real (USD sin TC)');
  });

  it('línea sin T.C. de venta (lineaMxn null) ⇒ sin comparación', () => {
    expect(
      conceptoPagoVendedorReal({
        etiquetaComision: SAAB,
        pagos: pagos({ pagadoMxn: 500 }),
        lineaMxn: null,
      }),
    ).toBe('pago comisión vendedor (Alex Saab) · gasto real');
  });

  it('los 3 motivos de solo-egreso (con y sin nombre de vendedor)', () => {
    const c = (
      sinLinea: 'SIN_LINEA' | 'CANCELADO' | 'INCONSISTENTE',
      etiqueta = 'comisión vendedor',
      p: Partial<PagosVendedorDeVuelo> = {},
    ) =>
      conceptoPagoVendedorReal({
        etiquetaComision: etiqueta,
        pagos: pagos(p),
        lineaMxn: 2030, // se ignora sin línea
        sinLinea,
      });
    expect(c('SIN_LINEA')).toBe(
      'pago comisión vendedor · sin comisión cobrada en la cotización',
    );
    expect(c('CANCELADO', SAAB)).toBe(
      'pago comisión vendedor (Alex Saab) · vuelo cancelado: sin comisión cobrada',
    );
    expect(c('INCONSISTENTE', SAAB)).toBe(
      'pago comisión vendedor (Alex Saab) · desglose de la cotización inconsistente: sin apareo',
    );
    expect(c('SIN_LINEA', undefined, { n: 3, pagadoMxn: 10, sinTc: 1 })).toBe(
      'pago comisión vendedor · sin comisión cobrada en la cotización (3 pagos) (parcial: USD sin TC)',
    );
  });

  it('TODOS los conceptos empiezan con «pago comisión vendedor» (el colapsado del Balance los clasifica solo)', () => {
    for (const sinLinea of [
      undefined,
      'SIN_LINEA',
      'CANCELADO',
      'INCONSISTENTE',
    ] as const) {
      expect(
        conceptoPagoVendedorReal({
          etiquetaComision: SAAB,
          pagos: pagos({}),
          lineaMxn: 1,
          sinLinea,
        }),
      ).toMatch(/^pago comisión vendedor/);
    }
  });
});

describe('motivoSinLineaComision (misma regla en los dos libros)', () => {
  it('CANCELADO gana', () => {
    expect(
      motivoSinLineaComision({
        cancelado: true,
        inconsistente: true,
        comisionVendedorUsd: 80,
      }),
    ).toBe('CANCELADO');
  });

  it('inconsistente CON comisión cotizada ⇒ INCONSISTENTE', () => {
    expect(
      motivoSinLineaComision({
        cancelado: false,
        inconsistente: true,
        comisionVendedorUsd: 80,
      }),
    ).toBe('INCONSISTENTE');
  });

  it('inconsistente SIN comisión ⇒ SIN_LINEA; consistente sin línea ⇒ SIN_LINEA', () => {
    expect(
      motivoSinLineaComision({
        cancelado: false,
        inconsistente: true,
        comisionVendedorUsd: 0,
      }),
    ).toBe('SIN_LINEA');
    expect(
      motivoSinLineaComision({
        cancelado: false,
        inconsistente: false,
        comisionVendedorUsd: 0,
      }),
    ).toBe('SIN_LINEA');
  });
});

describe('notas de celda del Libro Dinero', () => {
  it('textos EXACTOS', () => {
    expect(NOTA_PROVISION_PAGO_VENDEDOR).toBe(
      'PROVISIÓN: pago al vendedor por el mismo monto de la comisión cobrada (comisión + IVA = pagoVendedorUsd; neto de VuelaTour = precio base). Aún no hay gasto real: captúralo en Gastos con la categoría «Comisión del vendedor» ligado a este vuelo y reemplaza esta provisión (no lo captures como «Otros gastos VuelaTour»: quedaría duplicado). En la hoja utilidades ya está descontado de "otros ingresos".',
    );
    expect(NOTA_PAGO_VENDEDOR_REAL).toBe(
      'GASTO REAL: pago al vendedor capturado como «Comisión del vendedor» ligado a este vuelo; reemplaza la provisión. En la hoja utilidades ya está descontado de "otros ingresos".',
    );
    expect(NOTA_PAGO_VENDEDOR_SIN_LINEA).toBe(
      'GASTO REAL: pago al vendedor capturado como «Comisión del vendedor» en un vuelo sin comisión cobrada en la cotización (revisa la cotización o el vuelo del gasto). En la hoja utilidades ya está descontado de "otros ingresos".',
    );
  });
});
