import {
  cobradoAlCorte,
  corteDeDestino,
  decisionDiferir,
  diaCortoDeDia,
  diaContableDeGasto,
  ejeContableDeGasto,
  etiquetaMes,
  leyendaPasaA,
  leyendaPasara,
  leyendaPasaraAlCerrar,
  leyendaVieneDe,
  marcaPasaraAlCerrar,
  mesAnteriorDe,
  mesCalendarioDeRango,
  mesContableDeGasto,
  mesContableDeVuelo,
  mesDePeriodo,
  mesesPermitidosDelVuelo,
  mesSiguienteDe,
  motivoNoCerrable,
  origenDeVuelo,
  papelContableEnPeriodo,
  periodoContableDe,
  periodoContableSiguiente,
  rangoDelMes,
  salidaDeVuelo,
  statusCobroSombra,
  textoMesAnteriorAbierto,
  textoMesCerrado,
  textoMesEnCurso,
  textoMesSiguienteCerrado,
  type DiferimientoVuelo,
} from './mes-contable.util';

/**
 * CIERRE DE MES (16-oct-2026, API 0.0.88, invariante 89): reglas PURAS.
 * Casos REALES de prod (SELECT del 16-oct-2026): los 5 vuelos de
 * septiembre cobrados en octubre (#316, #337, #343, #344, #351) PASAN a
 * octubre con motivo COBRO_POSTERIOR aunque hoy su bandera `cobrado` sea
 * true.
 */

const FIN_SEP = '2026-09-30';
const usd = (monto: number, fecha: string) => ({
  monto,
  moneda: 'USD',
  tc_usd_mxn: null,
  fecha_cobro: fecha,
});
const mxn = (monto: number, tc: number | null, fecha: string) => ({
  monto,
  moneda: 'MXN',
  tc_usd_mxn: tc,
  fecha_cobro: fecha,
});
const completado = (total: number, tc: number | null = null) => ({
  estado: 'COMPLETADO',
  monto_total_usd: total,
  tc_usd_mxn: tc,
  cliente_interno: false,
});

describe('decisionDiferir — los 5 vuelos de septiembre cobrados en octubre (prod)', () => {
  it.each([
    [
      '#316 Mike Nelson (USD 1-oct)',
      2076.4,
      [usd(2076.4, '2026-10-01T17:00:00Z')],
    ],
    [
      '#337 Ambulancia (86,997.99 MXN @17.6425, 2-oct)',
      4931.16,
      [mxn(86997.99, 17.6425, '2026-10-02T17:00:00Z')],
    ],
    ['#343 ACP (USD 6-oct)', 2697, [usd(2697, '2026-10-06T17:00:00Z')]],
    ['#344 Mike Nelson (USD 1-oct)', 4152, [usd(4152, '2026-10-01T17:00:00Z')]],
    [
      '#351 Hernan Garza (41,498.07 MXN @17.71, 14-oct)',
      2343.2,
      [mxn(41498.07, 17.71, '2026-10-14T17:00:00Z')],
    ],
  ])('%s ⇒ COBRO_POSTERIOR, cobrado al corte 0', (_n, total, cobros) => {
    const d = decisionDiferir(completado(total), cobros, FIN_SEP);
    expect(d).not.toBeNull();
    expect(d?.motivo).toBe('COBRO_POSTERIOR');
    expect(d?.cobrado_usd).toBe(0);
    expect(d?.por_cobrar_usd).toBe(total);
    expect(d?.venta_usd).toBe(total);
    expect(Math.abs((d?.cobrado_posterior_usd ?? 0) - total)).toBeLessThan(
      0.02,
    );
  });

  it('dice CUÁNDO se cobró: fecha del último cobro después del corte (día Cancún)', () => {
    const d351 = decisionDiferir(
      completado(2343.2),
      [mxn(41498.07, 17.71, '2026-10-14T17:00:00Z')],
      FIN_SEP,
    );
    expect(d351?.fecha_cobro_posterior).toBe('2026-10-14');
    // Varios cobros después del corte: el más reciente; 1-oct 03:00Z es el
    // 30-sep en Cancún (cuenta al corte, no después). Todo cubierto ⇒
    // COBRO_POSTERIOR; con un faltante ⇒ COBRO_PARCIAL, también con fecha.
    const d = decisionDiferir(
      completado(1000),
      [
        usd(400, '2026-10-01T03:00:00Z'),
        usd(300, '2026-10-02T17:00:00Z'),
        usd(300, '2026-10-06T17:00:00Z'),
      ],
      FIN_SEP,
    );
    expect(d?.motivo).toBe('COBRO_POSTERIOR');
    expect(d?.cobrado_usd).toBe(400);
    expect(d?.fecha_cobro_posterior).toBe('2026-10-06');
    const parcial = decisionDiferir(
      completado(1000),
      [usd(400, '2026-10-01T03:00:00Z'), usd(300, '2026-10-02T17:00:00Z')],
      FIN_SEP,
    );
    expect(parcial?.motivo).toBe('COBRO_PARCIAL');
    expect(parcial?.fecha_cobro_posterior).toBe('2026-10-02');
    const sinNada = decisionDiferir(completado(1000), [], FIN_SEP);
    expect(sinNada?.fecha_cobro_posterior).toBeNull();
  });

  it('la suma de la venta de los 5 = 16,199.76 USD (QA-1)', () => {
    const totales = [2076.4, 4931.16, 2697, 4152, 2343.2];
    expect(Math.round(totales.reduce((a, b) => a + b, 0) * 100) / 100).toBe(
      16199.76,
    );
  });
});

describe('decisionDiferir — reglas', () => {
  it('cobrado completo al corte ⇒ se queda (null)', () => {
    expect(
      decisionDiferir(
        completado(2000),
        [usd(2000, '2026-09-20T17:00:00Z')],
        FIN_SEP,
      ),
    ).toBeNull();
  });

  it('tolerancia de 1 USD (la de refreshCobradoFlag): 1,999.01 de 2,000 se queda; 1,998.99 pasa', () => {
    expect(
      decisionDiferir(
        completado(2000),
        [usd(1999.01, '2026-09-20T17:00:00Z')],
        FIN_SEP,
      ),
    ).toBeNull();
    const d = decisionDiferir(
      completado(2000),
      [usd(1998.99, '2026-09-20T17:00:00Z')],
      FIN_SEP,
    );
    expect(d?.motivo).toBe('COBRO_PARCIAL');
  });

  it('cobro PARCIAL al corte ⇒ pasa COMPLETO (decisión 2 del cliente)', () => {
    const d = decisionDiferir(
      completado(2000),
      [usd(500, '2026-09-20T17:00:00Z')],
      FIN_SEP,
    );
    expect(d).toEqual({
      motivo: 'COBRO_PARCIAL',
      venta_usd: 2000,
      cobrado_usd: 500,
      por_cobrar_usd: 1500,
      cobrado_posterior_usd: 0,
      fecha_cobro_posterior: null,
      sin_tc_count: 0,
    });
  });

  it('sin cobros ⇒ SIN_COBRO', () => {
    expect(decisionDiferir(completado(2000), [], FIN_SEP)?.motivo).toBe(
      'SIN_COBRO',
    );
  });

  it('precio $0 / cliente interno / CANCELADO ⇒ se quedan', () => {
    expect(decisionDiferir(completado(0), [], FIN_SEP)).toBeNull();
    expect(
      decisionDiferir(
        { ...completado(1500), cliente_interno: true },
        [],
        FIN_SEP,
      ),
    ).toBeNull();
    expect(
      decisionDiferir(
        { estado: 'CANCELADO', monto_total_usd: 4360, tc_usd_mxn: null },
        [],
        FIN_SEP,
      ),
    ).toBeNull();
  });

  it('SOBRECOBRO ⇒ se queda (está cobrado)', () => {
    expect(
      decisionDiferir(
        completado(2000),
        [usd(2100, '2026-09-20T17:00:00Z')],
        FIN_SEP,
      ),
    ).toBeNull();
  });

  it('MXN sin T.C. propio usa el T.C. del vuelo (35,000 @ 17.5 = 2,000.00) ⇒ se queda', () => {
    expect(
      decisionDiferir(
        completado(2000, 17.5),
        [mxn(35000, null, '2026-09-15T17:00:00Z')],
        FIN_SEP,
      ),
    ).toBeNull();
  });

  it('MXN sin ningún T.C. NO se suma crudo: cuenta como no convertido', () => {
    const d = decisionDiferir(
      completado(2000),
      [mxn(35000, null, '2026-09-15T17:00:00Z')],
      FIN_SEP,
    );
    expect(d?.sin_tc_count).toBe(1);
    expect(d?.cobrado_usd).toBe(0);
  });

  it('corte por DÍA CANCÚN: 30-sep 23:30 Cancún cuenta en septiembre; 1-oct 00:30 Cancún, no', () => {
    expect(
      decisionDiferir(
        completado(2000),
        [usd(2000, '2026-10-01T04:30:00Z')],
        FIN_SEP,
      ),
    ).toBeNull();
    expect(
      decisionDiferir(
        completado(2000),
        [usd(2000, '2026-10-01T05:30:00Z')],
        FIN_SEP,
      )?.motivo,
    ).toBe('COBRO_POSTERIOR');
    expect(
      cobradoAlCorte([usd(10, '2026-10-01T04:59:59Z')], null, FIN_SEP)
        .total_usd,
    ).toBe(10);
  });
});

describe('mes contable del vuelo y del gasto', () => {
  const diferido = {
    fecha_vuelo: '2026-09-25T15:00:00Z',
    periodo_contable: '2026-10-01T05:00:00+00:00',
    fecha_contable: '2026-10-01T05:00:00+00:00',
  };
  it('vuelo diferido ⇒ octubre; sin migración (sin columnas) ⇒ su fecha real', () => {
    expect(mesContableDeVuelo(diferido)).toBe('2026-10');
    expect(mesContableDeVuelo({ fecha_vuelo: '2026-09-25T15:00:00Z' })).toBe(
      '2026-09',
    );
    expect(mesContableDeVuelo({ fecha_vuelo: '2026-10-01T04:00:00Z' })).toBe(
      '2026-09',
    );
  });

  const gasto = (cat: string, extra: Record<string, unknown> = {}) => ({
    id: 'g',
    categoria: cat,
    fecha_gasto: '2026-09-28',
    monto: 100,
    vuelo_id: 'v',
    aeronave_id: 'av',
    escala_id: null,
    vuelo: { ...diferido, aeronave_id: 'av', es_externo: false },
    ...extra,
  });

  it('OPERACIONES de un vuelo diferido (eje vuelo) ⇒ octubre aunque su fecha sea 28-sep', () => {
    expect(ejeContableDeGasto(gasto('OPERACIONES'))).toBe('vuelo');
    expect(mesContableDeGasto(gasto('OPERACIONES'))).toBe('2026-10');
    expect(diaContableDeGasto(gasto('OPERACIONES'))).toBe('2026-10-01');
  });

  it('GAS con avión y categorías de EMPRESA (eje gasto) ⇒ su fecha_gasto', () => {
    expect(mesContableDeGasto(gasto('GAS'))).toBe('2026-09');
    expect(mesContableDeGasto(gasto('OTRO'))).toBe('2026-09');
  });

  it('pago al vendedor (sin libro: eje vuelo, invariantes 50/61) ⇒ el mes del vuelo', () => {
    expect(mesContableDeGasto(gasto('COMISION_VENDEDOR_AVION'))).toBe(
      '2026-10',
    );
  });

  it('«Otros movimientos (VuelaTour)» (invariante 107): con vuelo cuenta en el mes contable del VUELO (su línea vive en el bloque del vuelo); sin vuelo, su fecha_gasto', () => {
    expect(ejeContableDeGasto(gasto('OTROS_MOVIMIENTOS'))).toBe('vuelo');
    expect(mesContableDeGasto(gasto('OTROS_MOVIMIENTOS'))).toBe('2026-10');
    const suelto = gasto('OTROS_MOVIMIENTOS', { vuelo_id: null, vuelo: null });
    expect(ejeContableDeGasto(suelto)).toBe('gasto');
    expect(mesContableDeGasto(suelto)).toBe('2026-09');
  });

  it('sin vuelo ⇒ fecha_gasto; sin embed del vuelo ⇒ fecha_gasto (jamás se inventa)', () => {
    expect(
      mesContableDeGasto(gasto('INDIRECTO', { vuelo_id: null, vuelo: null })),
    ).toBe('2026-09');
    expect(mesContableDeGasto(gasto('OPERACIONES', { vuelo: null }))).toBe(
      '2026-09',
    );
  });

  it('meses permitidos de la fecha de un gasto: del real al contable', () => {
    expect(mesesPermitidosDelVuelo('2026-09', '2026-10')).toEqual([
      '2026-09',
      '2026-10',
    ]);
    expect(mesesPermitidosDelVuelo('2026-09', '2026-11')).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(mesesPermitidosDelVuelo('2026-09', null)).toEqual(['2026-09']);
    expect(mesesPermitidosDelVuelo('2026-12', '2027-01')).toEqual([
      '2026-12',
      '2027-01',
    ]);
  });
});

describe('papel del vuelo en un periodo (fila normal / viene / sombra)', () => {
  const diferido = {
    id: 'v2',
    fecha_vuelo: '2026-09-25T15:00:00Z',
    periodo_contable: '2026-10-01T05:00:00+00:00',
    fecha_contable: '2026-10-01T05:00:00+00:00',
  };
  it('septiembre ⇒ sombra; octubre ⇒ viene; septiembre–octubre ⇒ normal; noviembre ⇒ fuera', () => {
    expect(papelContableEnPeriodo(diferido, '2026-09-01', '2026-09-30')).toBe(
      'sombra',
    );
    expect(papelContableEnPeriodo(diferido, '2026-10-01', '2026-10-31')).toBe(
      'viene',
    );
    expect(papelContableEnPeriodo(diferido, '2026-09-01', '2026-10-31')).toBe(
      'normal',
    );
    expect(papelContableEnPeriodo(diferido, '2026-11-01', '2026-11-30')).toBe(
      'fuera',
    );
    expect(
      papelContableEnPeriodo(
        { fecha_vuelo: '2026-09-10T15:00:00Z' },
        '2026-09-01',
        '2026-09-30',
      ),
    ).toBe('normal');
  });

  it('origen / salida desde la bitácora (y sin bitácora, su mes real)', () => {
    const b: DiferimientoVuelo[] = [
      {
        vuelo_id: 'v2',
        origen: '2026-09',
        destino: '2026-10',
        folio: 2,
        cliente: null,
        aeronave_id: null,
        matricula: null,
        venta_usd: 2000,
        cobrado_usd: 0,
        por_cobrar_usd: 2000,
        motivo: 'COBRO_POSTERIOR',
      },
    ];
    expect(origenDeVuelo(diferido, '2026-10', b)).toBe('2026-09');
    expect(origenDeVuelo(diferido, '2026-10', [])).toBe('2026-09');
    expect(salidaDeVuelo('v2', '2026-09', b)?.destino).toBe('2026-10');
    expect(salidaDeVuelo('v2', '2026-10', b)).toBeNull();
  });
});

describe('meses, periodos y ¿se puede cerrar?', () => {
  it('aritmética de meses y periodos Cancún', () => {
    expect(mesSiguienteDe('2026-12')).toBe('2027-01');
    expect(mesAnteriorDe('2027-01')).toBe('2026-12');
    expect(rangoDelMes('2026-09')).toEqual({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    expect(periodoContableDe('2026-10')).toBe('2026-10-01T00:00:00-05:00');
    expect(periodoContableSiguiente('2026-09')).toBe(
      '2026-10-01T00:00:00-05:00',
    );
    expect(mesDePeriodo('2026-09-01')).toBe('2026-09');
    // 'YYYY-MM' tal cual (new Date('2026-09') sería el 31-ago en Cancún).
    expect(mesDePeriodo('2026-09')).toBe('2026-09');
    expect(mesDePeriodo('2026-10-01T05:00:00+00:00')).toBe('2026-10');
    expect(mesCalendarioDeRango('2026-09-01', '2026-09-30')).toBe('2026-09');
    expect(mesCalendarioDeRango('2026-10-01', '2026-10-16')).toBeNull();
  });

  const base = {
    mesEnCurso: '2026-10',
    mesInicio: '2026-09',
    cerrados: new Set<string>(),
  };
  it('septiembre (primer mes) se puede; octubre en curso no; agosto antes del inicio', () => {
    expect(motivoNoCerrable({ ...base, mes: '2026-09' })).toBeNull();
    expect(motivoNoCerrable({ ...base, mes: '2026-10' })).toBe('MES_EN_CURSO');
    expect(motivoNoCerrable({ ...base, mes: '2026-08' })).toBe(
      'PERIODO_ANTES_DEL_INICIO',
    );
    expect(
      motivoNoCerrable({
        ...base,
        mes: '2026-09',
        cerrados: new Set(['2026-09']),
      }),
    ).toBe('YA_CERRADO');
    expect(motivoNoCerrable({ ...base, mes: '2026-09', listo: false })).toBe(
      'PRECIERRE_NO_LISTO',
    );
  });

  it('el 1-nov con septiembre abierto, octubre no se puede (MES_ANTERIOR_ABIERTO)', () => {
    expect(
      motivoNoCerrable({ ...base, mesEnCurso: '2026-11', mes: '2026-10' }),
    ).toBe('MES_ANTERIOR_ABIERTO');
    expect(
      motivoNoCerrable({
        ...base,
        mesEnCurso: '2026-11',
        mes: '2026-10',
        cerrados: new Set(['2026-09']),
      }),
    ).toBeNull();
  });
});

describe('textos es-MX (fuente única; el panel y pyservices copian)', () => {
  it('409 MES_CERRADO', () => {
    expect(
      textoMesCerrado({
        periodo: '2026-09',
        cerrado_at: '2026-10-16T19:02:00Z',
        cerrado_por_nombre: 'Alejandra Pérez',
      }),
    ).toBe(
      'Septiembre 2026 ya está cerrado (Alejandra, 16-oct). Reábrelo en Reportes para corregir.',
    );
    expect(textoMesCerrado({ periodo: '2026-09-01' })).toBe(
      'Septiembre 2026 ya está cerrado (la oficina). Reábrelo en Reportes para corregir.',
    );
  });

  it('precondiciones', () => {
    expect(textoMesEnCurso('2026-10')).toBe(
      'Octubre 2026 todavía está en curso: se cierra a partir del 1 de noviembre.',
    );
    expect(textoMesEnCurso('2026-12')).toBe(
      'Diciembre 2026 todavía está en curso: se cierra a partir del 1 de enero de 2027.',
    );
    expect(textoMesAnteriorAbierto('2026-10', '2026-09')).toBe(
      'Para cerrar octubre 2026 primero cierra septiembre 2026.',
    );
    expect(textoMesSiguienteCerrado('2026-10')).toBe(
      'Octubre 2026 ya está cerrado: reábrelo primero.',
    );
  });

  it('leyendas de los libros', () => {
    const d = { cobrado_usd: 0, venta_usd: 2076.4 };
    expect(leyendaPasaA('2026-10', d)).toBe(
      'Pasa a octubre 2026 · pendiente de cobro: cobrado $0.00 USD de $2,076.40 USD',
    );
    expect(leyendaPasara('2026-10', d)).toBe(
      'Pendiente de cobro: pasará a octubre 2026 al cerrar (cobrado $0.00 USD de $2,076.40 USD)',
    );
    expect(leyendaPasaraAlCerrar('2026-11', d)).toBe(
      'Pasará a noviembre 2026 al cerrar (cobrado $0.00 USD de $2,076.40 USD)',
    );
    expect(leyendaVieneDe('2026-09')).toBe('Viene de septiembre 2026');
    expect(statusCobroSombra('2026-10')).toBe('Pasa a oct-2026');
    expect(marcaPasaraAlCerrar('2026-10')).toBe(
      'Pendiente de cobro: pasará a octubre 2026 al cerrar',
    );
  });

  it('COBRO_POSTERIOR (caso #351, «aparece que aún no se cobran pero sí están cobrados»): las leyendas dicen cuándo se cobró, nunca «pendiente de cobro»', () => {
    const d = {
      motivo: 'COBRO_POSTERIOR' as const,
      cobrado_usd: 0,
      venta_usd: 2343.2,
      cobrado_posterior_usd: 2343.2,
      fecha_cobro_posterior: '2026-10-14',
    };
    expect(leyendaPasara('2026-10', d)).toBe(
      'Pasará a octubre 2026 al cerrar · cobrado el 14-oct, después del 30-sep (al 30-sep: $0.00 USD de $2,343.20 USD)',
    );
    expect(leyendaPasaA('2026-10', d)).toBe(
      'Pasa a octubre 2026 · cobrado el 14-oct, después del 30-sep (al 30-sep: $0.00 USD de $2,343.20 USD)',
    );
    expect(leyendaPasaraAlCerrar('2026-10', d)).toBe(
      leyendaPasara('2026-10', d),
    );
    expect(marcaPasaraAlCerrar('2026-10', d)).toBe(
      'Pasará a octubre 2026 al cerrar · cobrado el 14-oct, después del 30-sep',
    );
    // Desde la bitácora (mes ya cerrado) no se sabe la fecha:
    expect(
      leyendaPasaA('2026-10', {
        motivo: 'COBRO_POSTERIOR',
        cobrado_usd: 0,
        venta_usd: 2343.2,
      }),
    ).toBe(
      'Pasa a octubre 2026 · cobrado después del 30-sep (al 30-sep: $0.00 USD de $2,343.20 USD)',
    );
    // Corte de febrero y de diciembre ⇒ enero.
    expect(corteDeDestino('2027-03')).toBe('2027-02-28');
    expect(corteDeDestino('2027-01')).toBe('2026-12-31');
    expect(diaCortoDeDia('2026-12-31')).toBe('31-dic');
    expect(diaCortoDeDia('nada')).toBe('');
    for (const t of [
      leyendaPasara('2026-10', d),
      leyendaPasaA('2026-10', d),
      marcaPasaraAlCerrar('2026-10', d),
    ]) {
      expect(t).not.toMatch(/pendiente de cobro/i);
      expect(t).toMatch(/^(Pasa a|Pasará a) /);
    }
  });

  it('pendiente con algo cobrado después del corte: lo dice sin cambiar el prefijo', () => {
    expect(
      leyendaPasara('2026-10', {
        motivo: 'COBRO_PARCIAL',
        cobrado_usd: 400,
        venta_usd: 1000,
        cobrado_posterior_usd: 300,
        fecha_cobro_posterior: '2026-10-06',
      }),
    ).toBe(
      'Pendiente de cobro: pasará a octubre 2026 al cerrar (al 30-sep: cobrado $400.00 USD de $1,000.00 USD; después: $300.00 USD)',
    );
    // Sin nada después: byte a byte la de siempre.
    expect(
      leyendaPasara('2026-10', {
        motivo: 'SIN_COBRO',
        cobrado_usd: 0,
        venta_usd: 1000,
        cobrado_posterior_usd: 0,
        fecha_cobro_posterior: null,
      }),
    ).toBe(
      'Pendiente de cobro: pasará a octubre 2026 al cerrar (cobrado $0.00 USD de $1,000.00 USD)',
    );
    expect(etiquetaMes('2026-09', true)).toBe('sep-2026');
  });
});
