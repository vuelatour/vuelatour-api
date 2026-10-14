import {
  NOTA_PAGO_VENDEDOR_REAL,
  NOTA_PAGO_VENDEDOR_SIN_LINEA,
  TOLERANCIA_PAGO_VENDEDOR_MXN,
  conceptoPagoVendedorReal,
  contarPagosVendedor,
  cuerpoGastoRealPagoVendedor,
  motivoSinLineaComision,
  pagosVendedorDeVuelo,
  sufijoUsdSinTc,
  type GastoPagoVendedorRow,
  type PagosVendedorDeVuelo,
} from './pago-vendedor.util';

/**
 * PAGO REAL AL VENDEDOR ↔ COMISIÓN COBRADA (28-sep-2026, invariante 31):
 * fuente única del apareo que usan el Balance general («otros movimientos»)
 * y el Libro Dinero («Otros ingresos»). Desde el 13-oct-2026 (invariante 61)
 * también la columna COMISIONES del avión (`comisiones-avion.util`), con el
 * MISMO `pagosVendedorDeVuelo` y dos conversores; `conceptoPagoVendedorReal`
 * se compone de `cuerpoGastoRealPagoVendedor` + `sufijoUsdSinTc` (su salida
 * sigue byte a byte). Desde el ajuste del 13-oct-2026 (dos categorías) cada
 * llamada DECIDE su lado: 'VUELATOUR' («Comisión del vendedor (VuelaTour)»),
 * 'AVION' («Comisión del vendedor (avión)») o 'AMBOS'.
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
    expect(pagosVendedorDeVuelo([], conversor(), 'AMBOS')).toEqual({
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
      'VUELATOUR',
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
      'VUELATOUR',
    );
    expect(r.pagadoMxn).toBe(2015);
    expect(r.n).toBe(2);
    // USD sin tc_gasto ⇒ el respaldo lo decide el LIBRO que llama.
    const r2 = pagosVendedorDeVuelo(
      [g(116, { moneda: 'USD', tc_gasto: null })],
      conversor({ tcRespaldo: 19 }),
      'VUELATOUR',
    );
    expect(r2.pagadoMxn).toBe(2204);
  });

  it('conversor que no puede convertir ⇒ sinTc (no suma en falso)', () => {
    const r = pagosVendedorDeVuelo(
      [g(1000), g(50, { moneda: 'USD', tc_gasto: null })],
      conversor({ tcRespaldo: null }),
      'VUELATOUR',
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
      'VUELATOUR',
    );
    expect(todos.pagadoMxn).toBeNull();
    expect(todos.sinTc).toBe(1);
  });

  it('suma CRUDA y round2 al FINAL (no por gasto)', () => {
    // 3 × 0.004 = 0.012 ⇒ round2 al final = 0.01 (por gasto daría 0.00).
    const r = pagosVendedorDeVuelo(
      [g(0.004), g(0.004), g(0.004)],
      conversor(),
      'VUELATOUR',
    );
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
      'VUELATOUR',
    );
    expect(r.fecha).toBe('2026-09-15');
    expect(r.pagadoMxn).toBe(1605);
    expect(r.n).toBe(3);
  });
});

/**
 * DOS CATEGORÍAS (13-oct-2026, invariante 61): un vuelo con «(VuelaTour)»
 * 2,000, «(avión)» 1,000 y OPERACIONES 500. Cada lado cuenta lo suyo y
 * 'AMBOS' es la suma: ningún pago se cuenta dos veces.
 */
describe('pagosVendedorDeVuelo por LADO (dos categorías)', () => {
  const vuelo = [
    g(2000, { fecha_gasto: '2026-10-02' }),
    g(1000, {
      categoria: 'COMISION_VENDEDOR_AVION',
      fecha_gasto: '2026-10-05',
    }),
    g(500, { categoria: 'OPERACIONES', fecha_gasto: '2026-10-09' }),
  ];

  it('VUELATOUR / AVION / AMBOS: n, pagado, sinTc y fecha', () => {
    expect(pagosVendedorDeVuelo(vuelo, conversor(), 'VUELATOUR')).toEqual({
      n: 1,
      pagadoMxn: 2000,
      sinTc: 0,
      fecha: '2026-10-02',
    });
    expect(pagosVendedorDeVuelo(vuelo, conversor(), 'AVION')).toEqual({
      n: 1,
      pagadoMxn: 1000,
      sinTc: 0,
      fecha: '2026-10-05',
    });
    expect(pagosVendedorDeVuelo(vuelo, conversor(), 'AMBOS')).toEqual({
      n: 2,
      pagadoMxn: 3000,
      sinTc: 0,
      fecha: '2026-10-05',
    });
  });

  it('AMBOS = suma de los dos lados (también con un USD sin T.C.)', () => {
    const conUsd = [
      ...vuelo,
      g(50, {
        categoria: 'COMISION_VENDEDOR_AVION',
        moneda: 'USD',
        tc_gasto: null,
      }),
    ];
    const conv = conversor({ tcRespaldo: null });
    const vt = pagosVendedorDeVuelo(conUsd, conv, 'VUELATOUR');
    const av = pagosVendedorDeVuelo(conUsd, conv, 'AVION');
    const am = pagosVendedorDeVuelo(conUsd, conv, 'AMBOS');
    expect(am.n).toBe(vt.n + av.n);
    expect(am.sinTc).toBe(vt.sinTc + av.sinTc);
    expect(am.pagadoMxn).toBe((vt.pagadoMxn ?? 0) + (av.pagadoMxn ?? 0));
    expect(av).toEqual({
      n: 2,
      pagadoMxn: 1000,
      sinTc: 1,
      fecha: '2026-10-05',
    });
  });

  it('lado EXACTO: un código con prefijo o en minúsculas no cuenta en ningún lado', () => {
    const raros = [
      g(1, { categoria: 'COMISION_VENDEDOR_AVIONX' }),
      g(2, { categoria: 'comision_vendedor' }),
      g(3, { categoria: 'COMISION_VENDEDOR_' }),
    ];
    for (const lado of ['VUELATOUR', 'AVION', 'AMBOS'] as const) {
      expect(pagosVendedorDeVuelo(raros, conversor(), lado).n).toBe(0);
    }
  });

  it('contarPagosVendedor: misma regla de lado, sin convertir', () => {
    expect(contarPagosVendedor(vuelo, 'VUELATOUR')).toBe(1);
    expect(contarPagosVendedor(vuelo, 'AVION')).toBe(1);
    expect(contarPagosVendedor(vuelo, 'AMBOS')).toBe(2);
    expect(contarPagosVendedor([], 'AMBOS')).toBe(0);
    expect(
      contarPagosVendedor(
        [{ categoria: 'COMISION_VENDEDOR_AVIONX' }, { categoria: null }, {}],
        'AMBOS',
      ),
    ).toBe(0);
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

describe('cuerpoGastoRealPagoVendedor + sufijoUsdSinTc (el refactor del 13-oct-2026 no mueve un byte)', () => {
  it('cuerpo = «gasto real[ (N pagos)][ · parcial: faltan | · excede]», SIN sufijo de T.C.', () => {
    expect(cuerpoGastoRealPagoVendedor(pagos({}), 2030)).toBe('gasto real');
    expect(cuerpoGastoRealPagoVendedor(pagos({ n: 2 }), 2030)).toBe(
      'gasto real (2 pagos)',
    );
    expect(cuerpoGastoRealPagoVendedor(pagos({ pagadoMxn: 1750 }), 2030)).toBe(
      'gasto real · parcial: faltan $280.00 MXN',
    );
    expect(cuerpoGastoRealPagoVendedor(pagos({ pagadoMxn: 2500 }), 2030)).toBe(
      'gasto real · excede $470.00 MXN',
    );
    expect(cuerpoGastoRealPagoVendedor(pagos({ pagadoMxn: 500 }), null)).toBe(
      'gasto real',
    );
    // Con pagos sin T.C. no se compara, y el sufijo no vive aquí.
    expect(
      cuerpoGastoRealPagoVendedor(
        pagos({ n: 2, pagadoMxn: 1000, sinTc: 1 }),
        2030,
      ),
    ).toBe('gasto real (2 pagos)');
  });

  it('sufijo: «(parcial: USD sin TC)» | «(USD sin TC)» | vacío', () => {
    expect(sufijoUsdSinTc(pagos({}))).toBe('');
    expect(sufijoUsdSinTc(pagos({ n: 2, pagadoMxn: 1000, sinTc: 1 }))).toBe(
      ' (parcial: USD sin TC)',
    );
    expect(sufijoUsdSinTc(pagos({ pagadoMxn: null, sinTc: 1 }))).toBe(
      ' (USD sin TC)',
    );
  });

  it('conceptoPagoVendedorReal == «pago <etiqueta> · » + cuerpo + sufijo', () => {
    for (const p of [
      pagos({}),
      pagos({ n: 2, pagadoMxn: 2500 }),
      pagos({ pagadoMxn: 1750 }),
      pagos({ n: 2, pagadoMxn: 1000, sinTc: 1 }),
      pagos({ pagadoMxn: null, sinTc: 1 }),
    ]) {
      expect(
        conceptoPagoVendedorReal({
          etiquetaComision: SAAB,
          pagos: p,
          lineaMxn: 2030,
        }),
      ).toBe(
        `pago ${SAAB} · ${cuerpoGastoRealPagoVendedor(p, 2030)}${sufijoUsdSinTc(p)}`,
      );
    }
  });
});

describe('notas de celda del Libro Dinero', () => {
  it('textos EXACTOS (sin «provisión»; las dos categorías desde el 13-oct-2026, invariante 61)', () => {
    expect(NOTA_PAGO_VENDEDOR_REAL).toBe(
      'GASTO REAL: pago al vendedor capturado en Gastos y ligado a este vuelo («Comisión del vendedor (VuelaTour)» o «Comisión del vendedor (avión)»). En la hoja utilidades ya está descontado de "otros ingresos".',
    );
    for (const t of [NOTA_PAGO_VENDEDOR_REAL, NOTA_PAGO_VENDEDOR_SIN_LINEA]) {
      expect(t.toLowerCase()).not.toContain('provisi');
    }
    expect(NOTA_PAGO_VENDEDOR_SIN_LINEA).toBe(
      'GASTO REAL: pago al vendedor capturado en Gastos y ligado a este vuelo («Comisión del vendedor (VuelaTour)» o «Comisión del vendedor (avión)») en un vuelo sin comisión cobrada en la cotización (revisa la cotización o el vuelo del gasto). En la hoja utilidades ya está descontado de "otros ingresos".',
    );
  });
});
