import {
  coincideFacturaConGasto,
  estadoLigados,
  facturaConceptoParaRespuesta,
  facturaDeConcepto,
  foliosDeGastoCrudo,
  mismoNumero,
  numeroDeFolio,
  numerosDeGasto,
  pistasCompatibles,
  repeticionesDeFactura,
  tokensConcepto,
  type FacturaConcepto,
  type FilaUniversoFactura,
} from './factura-concepto.util';

/**
 * CONCEPTO DEL SPEI (13-oct-2026, API 0.0.75, invariante 69). Los 44 casos
 * del prototipo (12 reales de prod): el parser prefiere PRECISIÓN a
 * cobertura — un número dudoso corta sin número.
 */
const lectura = (t: string | null) => {
  const r = facturaDeConcepto(t);
  return r ? `${r.texto}|${r.pista}` : null;
};

describe('facturaDeConcepto — los 44 casos del prototipo', () => {
  const casos: Array<[string | null, string | null]> = [
    // Reales (SAESA, HSBC, Corner).
    [
      'SEL TRANSF. INTERBANCARIA SPEI BANORTE fact vip 7360',
      'Factura 7360|VIP',
    ],
    ['SEL TRANSF. INTERBANCARIA SPEI HSBC fact palma 73', 'Factura 73|PALMA'],
    [
      'SEL TRANSF. INTERBANCARIA SPEI BANORTE pre factura corner 4409',
      'Prefactura 4409|CORNER',
    ],
    [
      'SEL TRANSF. INTERBANCARIA SPEI BANORTE prefactura corner 4481',
      'Prefactura 4481|CORNER',
    ],
    [
      'SEL TRANSF. INTERBANCARIA SPEI BANORTE pre fact corner 4480',
      'Prefactura 4480|CORNER',
    ],
    ['CGO SPEI FACT CODECSA, SPEI', null],
    ['TRANSF INTERBANCARIA SPEI Folio 383 /JP MORGAN', null],
    ['TRANSF INTERBANCARIA SPEI COT 337 AMB AER /SANTANDER', null],
    ['SEL PAGO DE SERVICIOS Pago REFERENCIADO IMSS', null],
    ['Depositos SBC Camara Presentada No.6790751', null],
    ['04266QGJ580051065430', null],
    [
      'SEL TRANSF. INTERBANCARIA SPEI BBVA MEXICO transfers jun jul ago 2026',
      null,
    ],
    // Sintéticos.
    ['factura 1234', 'Factura 1234|null'],
    ['fac A-123', 'Factura A-123|null'],
    ['FACT 7359 Y 7360', 'Facturas 7359 · 7360|null'],
    ['FACT 7359/7360', 'Facturas 7359 · 7360|null'],
    ['FACT 7359, 7360', 'Facturas 7359 · 7360|null'],
    ['facts 7360, 7361 y 7362', 'Facturas 7360 · 7361 · 7362|null'],
    ['FACT. NO. 7360', 'Factura 7360|null'],
    ['FACT#7360', 'Factura 7360|null'],
    ['fact #7360', 'Factura 7360|null'],
    ['FACT7360', 'Factura 7360|null'],
    ['fact vip 7360 2231.38', 'Factura 7360|VIP'],
    ['fact vip 7360-7361', 'Facturas 7360 · 7361|VIP'],
    ['FACTURA FEACZM-72128', 'Factura FEACZM-72128|null'],
    ['FACTURA No. 0456', 'Factura 0456|null'],
    ['fact vip saesa sa de cv 7360', 'Factura 7360|VIP SAESA SA CV'],
    ['Pago VIP SAESA fact 7352', 'Factura 7352|null'],
    [
      'pre factura corner 4409 · Proveedor: TECHNO CABS',
      'Prefactura 4409|CORNER',
    ],
    ['factura septiembre 2026', null],
    ['FACTURA 000000000000000123', null],
    ['FACT 0000', null],
    ['FACT 2231.38', null],
    ['FACTURACION ENERO', null],
    ['5144 AEROCHARTER F A0422 0300926, SPID', null],
    ['fact sept 2026', null],
    ['pago fact', null],
    ['fact 5', null],
    ['FACT 12/09/2026', null],
    ['fact 012180001234567890', null],
    ['fact 7360 7360', 'Factura 7360|null'],
    ['fac A5', 'Factura A5|null'],
    ['', null],
    [null, null],
  ];

  it('son 44 casos y todos leen lo esperado', () => {
    expect(casos).toHaveLength(44);
    const fallas = casos
      .map(([t, esperado]) => ({ t, esperado, obtenido: lectura(t) }))
      .filter((c) => c.obtenido !== c.esperado);
    expect(fallas).toEqual([]);
  });

  it('los 5 SPEI de SAESA del 12-oct traen su factura con pista VIP', () => {
    for (const n of ['7349', '7352', '7357', '7359', '7360']) {
      const r = facturaDeConcepto(
        `SEL TRANSF. INTERBANCARIA SPEI BANORTE fact vip ${n}`,
      );
      expect(r).toEqual({
        tipo: 'FACTURA',
        numeros: [{ serie: null, digitos: n, texto: n }],
        texto: `Factura ${n}`,
        pista: 'VIP',
      });
    }
  });

  it('la serie y los ceros a la izquierda: se imprime como vino, se compara sin ceros', () => {
    expect(facturaDeConcepto('FACTURA No. 0456')?.numeros).toEqual([
      { serie: null, digitos: '456', texto: '0456' },
    ]);
    expect(facturaDeConcepto('fac A-123')?.numeros).toEqual([
      { serie: 'A', digitos: '123', texto: 'A-123' },
    ]);
  });

  it('PREFACTURA solo si TODAS las claves con número eran «pre»', () => {
    expect(facturaDeConcepto('pre fact 4480 y fact 7360')?.tipo).toBe(
      'FACTURA',
    );
    expect(facturaDeConcepto('prefactura 4480 prefactura 4481')).toMatchObject({
      tipo: 'PREFACTURA',
      texto: 'Prefacturas 4480 · 4481',
    });
  });

  it('no más de 5 números aunque el texto traiga más', () => {
    const r = facturaDeConcepto('facts 11 12 13 14 15 16');
    // «11» sale de la clave; los demás no se encadenan sin separador.
    expect(r?.numeros.map((n) => n.texto)).toEqual(['11']);
    const r2 = facturaDeConcepto('facts 11, 12, 13, 14, 15, 16, 17');
    expect(r2?.numeros.map((n) => n.texto)).toEqual([
      '11',
      '12',
      '13',
      '14',
      '15',
    ]);
  });
});

describe('tokensConcepto', () => {
  it('separa la clave pegada, el #, las comas y las diagonales (no las fechas)', () => {
    expect(tokensConcepto('FACT#7360')).toEqual(['FACT', '7360']);
    expect(tokensConcepto('fact #7360')).toEqual(['FACT', '#', '7360']);
    expect(tokensConcepto('FACT 7359/7360')).toEqual([
      'FACT',
      '7359',
      '/',
      '7360',
    ]);
    expect(tokensConcepto('FACT 12/09/2026')).toEqual(['FACT', '12/09/2026']);
    expect(tokensConcepto('FACT. NO. 7360')).toEqual(['FACT', 'NO', '7360']);
    expect(tokensConcepto('facts 7360, 7361')).toEqual([
      'FACTS',
      '7360',
      ',',
      '7361',
    ]);
    expect(tokensConcepto(null)).toEqual([]);
  });
});

describe('numeroDeFolio — folios del gasto', () => {
  it('serie, ceros y sufijos', () => {
    expect(numeroDeFolio('A-0411')).toEqual({
      serie: 'A',
      digitos: '411',
      texto: 'A-0411',
    });
    expect(numeroDeFolio('A 9850')).toMatchObject({
      serie: 'A',
      digitos: '9850',
    });
    expect(numeroDeFolio('FEACZM-72128')).toMatchObject({
      serie: 'FEACZM',
      digitos: '72128',
    });
    expect(numeroDeFolio('7352-A')).toMatchObject({
      serie: null,
      digitos: '7352',
    });
    expect(numeroDeFolio(' 4409 ')).toMatchObject({ digitos: '4409' });
  });

  it('A-0411 y A-411 son el mismo número', () => {
    const a = numeroDeFolio('A-0411')!;
    const b = numeroDeFolio('A-411')!;
    expect(mismoNumero(a, b)).toBe(true);
  });

  it('null: recibos SPEI, alfanuméricos largos, rangos raros y CFDI', () => {
    expect(numeroDeFolio('55276014805')).toBeNull();
    expect(numeroDeFolio('2026091540044B36K0000077869083')).toBeNull();
    expect(numeroDeFolio('1-094-4368')).toBeNull();
    expect(
      numeroDeFolio('CFDI 3f2b1c0e-1111-2222-3333-444455556666'),
    ).toBeNull();
    expect(numeroDeFolio('CFDI 123')).toBeNull();
    expect(numeroDeFolio('5')).toBeNull();
    expect(numeroDeFolio('0000')).toBeNull();
    expect(numeroDeFolio('')).toBeNull();
    expect(numeroDeFolio(null)).toBeNull();
  });
});

describe('mismoNumero', () => {
  const n = (serie: string | null, digitos: string) => ({
    serie,
    digitos,
    texto: digitos,
  });
  it('73 ≠ 1073; A-123 ≠ B-123; A-123 = 123; un dígito nunca', () => {
    expect(mismoNumero(n(null, '73'), n(null, '1073'))).toBe(false);
    expect(mismoNumero(n('A', '123'), n('B', '123'))).toBe(false);
    expect(mismoNumero(n('A', '123'), n(null, '123'))).toBe(true);
    expect(mismoNumero(n('A', '5'), n('A', '5'))).toBe(false);
  });
});

describe('coincideFacturaConGasto — cada fuente del folio', () => {
  const fc = facturaDeConcepto(
    'SEL TRANSF. INTERBANCARIA SPEI BANORTE fact vip 7352',
  )!;
  it('factura recibida (serie-folio)', () => {
    expect(
      coincideFacturaConGasto(fc, { factura: { serie: null, folio: '7352' } }),
    ).toBe(true);
    expect(
      coincideFacturaConGasto(fc, { factura: { serie: 'A', folio: '07352' } }),
    ).toBe(true);
  });
  it('folio del ticket y folio de la IA', () => {
    expect(coincideFacturaConGasto(fc, { folio_ticket: '7352' })).toBe(true);
    expect(coincideFacturaConGasto(fc, { ia_folio: '7352-A' })).toBe(true);
  });
  it('«fact NNNN» en la PRIMERA línea de las notas (una factura, varios gastos)', () => {
    expect(
      coincideFacturaConGasto(fc, { notas: 'Pago VIP SAESA fact 7352' }),
    ).toBe(true);
    // En la segunda línea no cuenta.
    expect(
      coincideFacturaConGasto(fc, { notas: 'Pago VIP SAESA\nfact 7352' }),
    ).toBe(false);
  });
  it('otro número o un recibo SPEI no coinciden', () => {
    expect(coincideFacturaConGasto(fc, { folio_ticket: '7353' })).toBe(false);
    expect(coincideFacturaConGasto(fc, { folio_ticket: '55276014805' })).toBe(
      false,
    );
    expect(coincideFacturaConGasto(fc, {})).toBe(false);
  });
  it('fila cruda de PostgREST: embed como arreglo y nota como notas_fc', () => {
    const f = foliosDeGastoCrudo({
      folio_ticket: null,
      ia_folio: null,
      factura: [{ serie: 'A', folio: '0411', uuid_fiscal: 'x' }],
      notas_fc: 'pre factura corner 4409',
    });
    expect(f.factura).toEqual({ serie: 'A', folio: '0411' });
    expect(numerosDeGasto(f).map((x) => x.texto)).toEqual(['A-0411', '4409']);
  });
});

describe('estadoLigados — coherencia con los gastos ligados', () => {
  const fc = (t: string) => facturaDeConcepto(t)!;
  it('sin gastos ⇒ null; ningún folio ⇒ SIN_FOLIO', () => {
    expect(estadoLigados(fc('fact vip 7360'), [])).toBeNull();
    expect(
      estadoLigados(fc('fact vip 7360'), [{ notas: 'Pago VIP SAESA' }]),
    ).toEqual({ estado: 'SIN_FOLIO', folios: [], faltan: ['7360'] });
  });
  it('COINCIDE, NO_COINCIDE y PARCIAL', () => {
    expect(
      estadoLigados(fc('fact vip 7360'), [{ folio_ticket: '7360' }]),
    ).toEqual({ estado: 'COINCIDE', folios: ['7360'], faltan: [] });
    expect(
      estadoLigados(fc('fact vip 7360'), [{ folio_ticket: '7361' }]),
    ).toEqual({ estado: 'NO_COINCIDE', folios: ['7361'], faltan: ['7360'] });
    // Lote: un gasto con la factura y otro con OTRA ⇒ PARCIAL.
    expect(
      estadoLigados(fc('fact vip 7360'), [
        { folio_ticket: '7360' },
        { folio_ticket: '7361' },
      ]),
    ).toEqual({ estado: 'PARCIAL', folios: ['7360', '7361'], faltan: [] });
    // Dos facturas en el concepto y solo una en los gastos ⇒ PARCIAL.
    expect(
      estadoLigados(fc('FACT 7359 Y 7360'), [{ folio_ticket: '7360' }]),
    ).toEqual({ estado: 'PARCIAL', folios: ['7360'], faltan: ['7359'] });
  });
  it('Corner: factura recibida 4409 + nota «pre factura corner 4409» ⇒ COINCIDE (la prefactura cuenta)', () => {
    expect(
      estadoLigados(fc('pre factura corner 4409'), [
        {
          factura: { serie: null, folio: '4409' },
          notas: 'pre factura corner 4409 · Proveedor: TECHNO CABS',
        },
      ]),
    ).toEqual({ estado: 'COINCIDE', folios: ['4409'], faltan: [] });
  });
});

describe('repeticionesDeFactura — «también en otro pago»', () => {
  const fila = (
    id: string,
    fecha: string,
    descripcion: string,
    extra: Partial<FilaUniversoFactura> = {},
  ): FilaUniversoFactura => ({
    id,
    fecha,
    tipo: 'CARGO',
    monto: 1118.12,
    descripcion,
    conciliado: false,
    cuenta: 'GASTOS GNRAL',
    ...extra,
  });
  const base = {
    id: 'm-eje',
    fecha: '2026-09-07',
    tipo: 'CARGO',
    fc: facturaDeConcepto(
      'SEL TRANSF. INTERBANCARIA SPEI BANORTE fact vip 7350',
    )!,
  };

  it('el mismo número en OTRA cuenta a ≤ 120 días ⇒ sí; a 121 ⇒ no', () => {
    const r = repeticionesDeFactura(base, [
      fila('m-1', '2027-01-05', 'SPEI BANORTE fact vip 7350'), // 120 días
      fila('m-2', '2027-01-06', 'SPEI BANORTE fact vip 7350'), // 121 días
    ]);
    expect(r.map((x) => x.movimiento_id)).toEqual(['m-1']);
    expect(r[0]).toEqual({
      movimiento_id: 'm-1',
      fecha: '2027-01-05',
      monto: 1118.12,
      cuenta: 'GASTOS GNRAL',
      descripcion: 'SPEI BANORTE fact vip 7350',
      conciliado: false,
    });
  });

  it('VIP contra PALMA no; «73» sin pista no; ABONO contra CARGO no; la misma fila no', () => {
    expect(
      repeticionesDeFactura(base, [
        fila('m-1', '2026-09-08', 'SPEI HSBC fact palma 7350'),
        fila('m-2', '2026-09-08', 'fact vip 7350', { tipo: 'ABONO' }),
        fila('m-eje', '2026-09-07', 'fact vip 7350'),
      ]),
    ).toEqual([]);
    const corto = {
      ...base,
      fc: facturaDeConcepto('SPEI HSBC fact palma 73')!,
    };
    expect(
      repeticionesDeFactura(corto, [fila('m-1', '2026-09-08', 'factura 73')]),
    ).toEqual([]);
    // Con pista en los dos lados, «73» sí se compara.
    expect(
      repeticionesDeFactura(corto, [
        fila('m-1', '2026-09-08', 'SPEI HSBC fact palma 73'),
      ]).map((x) => x.movimiento_id),
    ).toEqual(['m-1']);
  });

  it('máximo 5, ordenadas por fecha e id', () => {
    const universo = [
      fila('m-f', '2026-09-20', 'fact vip 7350'),
      fila('m-b', '2026-09-10', 'fact vip 7350'),
      fila('m-a', '2026-09-10', 'fact vip 7350'),
      fila('m-c', '2026-09-11', 'fact vip 7350'),
      fila('m-d', '2026-09-12', 'fact vip 7350'),
      fila('m-e', '2026-09-13', 'fact vip 7350'),
    ];
    expect(
      repeticionesDeFactura(base, universo).map((x) => x.movimiento_id),
    ).toEqual(['m-a', 'm-b', 'm-c', 'm-d', 'm-e']);
  });

  it('pistasCompatibles: comparten palabra o, sin pista, ≥ 4 dígitos', () => {
    const a = facturaDeConcepto('fact vip saesa 7350') as FacturaConcepto;
    const b = facturaDeConcepto('fact saesa 7350') as FacturaConcepto;
    const c = facturaDeConcepto('factura 7350') as FacturaConcepto;
    expect(pistasCompatibles(a, b, a.numeros[0])).toBe(true);
    expect(pistasCompatibles(a, c, a.numeros[0])).toBe(true);
    const corto = facturaDeConcepto('fact palma 73') as FacturaConcepto;
    expect(
      pistasCompatibles(corto, facturaDeConcepto('fact 73')!, corto.numeros[0]),
    ).toBe(false);
  });
});

describe('facturaConceptoParaRespuesta — forma del contrato', () => {
  it('los números viajan como texto', () => {
    const fc = facturaDeConcepto('FACT 7359/7360')!;
    expect(facturaConceptoParaRespuesta(fc, null, [])).toEqual({
      tipo: 'FACTURA',
      numeros: ['7359', '7360'],
      texto: 'Facturas 7359 · 7360',
      pista: null,
      ligados: null,
      repetida_en: [],
    });
  });
});
