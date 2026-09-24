import {
  avisoTotalDistintoVuelo,
  buscarYaRegistrada,
  calcularAlertas,
  claveCompacta,
  cobroResumenDe,
  compararFacturas,
  enLotes,
  faltanDatosFiscales,
  filtrarFacturas,
  folioNumDe,
  huecosPorSerie,
  interpretarBusquedaVuelo,
  listaFolios,
  mensajeFacturaExistente,
  mismaEmisora,
  normalizarNombreEmpresa,
  patronIlikeSeguro,
  serieEfectiva,
  totalesPorMoneda,
  verificarEmisor,
  type FacturaFiltrable,
} from './facturas-emitidas.util';

/**
 * FACTURAS EMITIDAS (24-sep-2026) — reglas puras del registro: número único
 * (emisora + serie + folio), orden por número, alertas, huecos de
 * numeración, emisor de VuelaTour y avisos. El 409 y el banner «ya
 * registrada» usan la MISMA función.
 */

describe('folioNumDe (espejo de la columna generada folio_num)', () => {
  it("'A-00123' ⇒ 123; 'Z' ⇒ null; dígitos sueltos se juntan", () => {
    expect(folioNumDe('A-00123')).toBe(123);
    expect(folioNumDe('Z')).toBeNull();
    expect(folioNumDe('')).toBeNull();
    expect(folioNumDe('26062737')).toBe(26062737);
    expect(folioNumDe('A1-B2')).toBe(12);
  });
});

describe('claveCompacta (número de factura comparable)', () => {
  it('«A»+«00123» = «A-123» sin serie = «a 123» = «A / 123»', () => {
    const k = claveCompacta('A', '00123');
    expect(k).toBe('A123');
    expect(claveCompacta(null, 'A-123')).toBe(k);
    expect(claveCompacta(null, 'a 123')).toBe(k);
    expect(claveCompacta('A', '/ 123')).toBe(k);
    expect(claveCompacta('a', '0123')).toBe(k);
  });
  it('otra serie u otro número NO chocan', () => {
    expect(claveCompacta('B', '123')).not.toBe(claveCompacta('A', '123'));
    expect(claveCompacta('A', '1230')).not.toBe(claveCompacta('A', '123'));
  });
  it('conserva la Ñ y quita acentos', () => {
    expect(claveCompacta('Ñ', '5')).toBe('Ñ5');
    expect(claveCompacta('É', '5')).toBe('E5');
  });
  it('el cero solo no desaparece', () => {
    expect(claveCompacta(null, '0')).toBe('0');
    expect(claveCompacta(null, '000')).toBe('0');
  });
});

describe('mismaEmisora (numeración por razón social)', () => {
  it('NULL es comodín', () => {
    expect(mismaEmisora(null, 'e1')).toBe(true);
    expect(mismaEmisora('e1', null)).toBe(true);
    expect(mismaEmisora(null, null)).toBe(true);
  });
  it('dos emisoras distintas NO chocan; la misma sí', () => {
    expect(mismaEmisora('e1', 'e2')).toBe(false);
    expect(mismaEmisora('e1', 'e1')).toBe(true);
  });
});

describe('serieEfectiva', () => {
  it('serie capturada en mayúsculas; si no, prefijo de letras del folio', () => {
    expect(serieEfectiva('a', '123')).toBe('A');
    expect(serieEfectiva(null, 'A-123')).toBe('A');
    expect(serieEfectiva('', 'AAI 26062737')).toBe('AAI');
    expect(serieEfectiva(null, '123')).toBeNull();
    expect(serieEfectiva(null, 'A-12-3')).toBeNull();
  });
});

describe('compararFacturas (orden por número)', () => {
  const f = (
    serie: string | null,
    folio: string,
    extra: { created_at?: string; fecha_emision?: string } = {},
  ) => ({
    serie,
    folio,
    folio_num: folioNumDe(folio),
    created_at: extra.created_at ?? '2026-09-01T00:00:00Z',
    fecha_emision: extra.fecha_emision ?? '2026-09-01',
  });
  const filas = [
    f('A', '100'),
    f('A', '9'),
    f(null, 'A-120'),
    f('B', '1'),
    f('A', 'SN'),
  ];
  const etiquetas = (xs: typeof filas) =>
    xs.map((x) => `${x.serie ?? ''}|${x.folio}`);

  it('folio_desc (default): serie ASC → número DESC (nulls al final)', () => {
    expect(etiquetas([...filas].sort(compararFacturas()))).toEqual([
      '|A-120',
      'A|100',
      'A|9',
      'A|SN',
      'B|1',
    ]);
  });
  it('folio_asc: número ASC (nulls al final)', () => {
    expect(etiquetas([...filas].sort(compararFacturas('folio_asc')))).toEqual([
      'A|9',
      'A|100',
      '|A-120',
      'A|SN',
      'B|1',
    ]);
  });
  it('fecha_desc: fecha de emisión DESC y luego folio_desc', () => {
    const xs = [
      f('A', '1', { fecha_emision: '2026-09-01' }),
      f('A', '2', { fecha_emision: '2026-09-02' }),
      f('A', '3', { fecha_emision: '2026-09-01' }),
    ];
    expect(etiquetas(xs.sort(compararFacturas('fecha_desc')))).toEqual([
      'A|2',
      'A|3',
      'A|1',
    ]);
  });
});

describe('calcularAlertas', () => {
  const fac = (
    id: string,
    extra: Partial<{
      estatus: string;
      pdf_path: string | null;
      es_parcial: boolean;
    }> = {},
  ) => ({
    id,
    estatus: extra.estatus ?? 'VIGENTE',
    pdf_path:
      extra.pdf_path === undefined ? `emitidas/${id}/x.pdf` : extra.pdf_path,
    es_parcial: extra.es_parcial ?? false,
  });
  const liga = (
    factura_id: string,
    vuelo_id: string,
    estado = 'CONFIRMADO',
  ) => ({
    factura_id,
    vuelo_id,
    vuelo: { estado },
  });

  it('DUPLICADO_VUELO con 2 vigentes y al menos una NO parcial', () => {
    const r = calcularAlertas(
      [fac('f1'), fac('f2', { es_parcial: true })],
      [liga('f1', 'v1'), liga('f2', 'v1')],
    );
    expect(r.porFactura.get('f1')).toEqual(['DUPLICADO_VUELO']);
    expect(r.porFactura.get('f2')).toEqual(['DUPLICADO_VUELO']);
    expect(r.vuelosDuplicados.size).toBe(1);
  });

  it('anticipo + finiquito (las dos parciales) NO alerta', () => {
    const r = calcularAlertas(
      [fac('f1', { es_parcial: true }), fac('f2', { es_parcial: true })],
      [liga('f1', 'v1'), liga('f2', 'v1')],
    );
    expect(r.porFactura.get('f1')).toEqual([]);
    expect(r.vuelosDuplicados.size).toBe(0);
  });

  it('una CANCELADA no cuenta ni lleva alertas', () => {
    const r = calcularAlertas(
      [fac('f1'), fac('f2', { estatus: 'CANCELADA', pdf_path: null })],
      [liga('f1', 'v1'), liga('f2', 'v1')],
    );
    expect(r.porFactura.get('f1')).toEqual([]);
    expect(r.porFactura.get('f2')).toEqual([]);
  });

  it('SIN_PDF, SIN_VUELO y VUELO_CANCELADO', () => {
    const r = calcularAlertas(
      [fac('f1', { pdf_path: null }), fac('f2'), fac('f3')],
      [liga('f1', 'v1'), liga('f3', 'v9', 'CANCELADO')],
    );
    expect(r.porFactura.get('f1')).toEqual(['SIN_PDF']);
    expect(r.porFactura.get('f2')).toEqual(['SIN_VUELO']);
    expect(r.porFactura.get('f3')).toEqual(['VUELO_CANCELADO']);
  });

  it('ligas de facturas que no están en la lista (borradas) se ignoran', () => {
    const r = calcularAlertas(
      [fac('f1')],
      [liga('f1', 'v1'), liga('fx', 'v1')],
    );
    expect(r.porFactura.get('f1')).toEqual([]);
  });
});

describe('huecosPorSerie (numeración)', () => {
  const fila = (
    serie: string | null,
    folio: string,
    emisora_id: string | null = null,
  ) => ({ serie, folio, folio_num: folioNumDe(folio), emisora_id });

  it('faltantes entre menor y mayor; las canceladas ocupan su número', () => {
    const h = huecosPorSerie([
      fila('A', '101'),
      fila('A', '103'),
      fila('A', '106'),
      fila('B', '1'),
    ]);
    expect(h).toEqual([
      {
        emisora: null,
        serie: 'A',
        etiqueta_serie: 'A',
        desde: 101,
        hasta: 106,
        total_faltantes: 3,
        faltantes: ['A-102', 'A-104', 'A-105'],
        truncado: false,
      },
    ]);
  });

  it('«A-123» sin serie cae en la numeración de la serie A', () => {
    const h = huecosPorSerie([fila('A', '1'), fila(null, 'A-4')]);
    expect(h[0].faltantes).toEqual(['A-2', 'A-3']);
  });

  it('rango ENORME: conteo aritmético, solo 20 etiquetas y truncado', () => {
    const inicio = Date.now();
    const h = huecosPorSerie([fila('A', '130'), fila('A', '1300000000')]);
    expect(Date.now() - inicio).toBeLessThan(500);
    expect(h[0].total_faltantes).toBe(1300000000 - 130 - 1);
    expect(h[0].faltantes).toHaveLength(20);
    expect(h[0].faltantes[0]).toBe('A-131');
    expect(h[0].truncado).toBe(true);
  });

  it('por (emisora, serie): dos razones sociales NO se mezclan', () => {
    const nombres: Record<string, string> = {
      e1: 'Aero Charter Cancun',
      e2: 'Aerodinamica de Monterrey',
    };
    const h = huecosPorSerie(
      [
        fila('A', '1', 'e1'),
        fila('A', '3', 'e1'),
        fila('A', '2', 'e2'),
        fila('A', '5', 'e2'),
      ],
      (id) => nombres[id] ?? null,
    );
    expect(h.map((x) => [x.etiqueta_serie, x.faltantes])).toEqual([
      ['A · Aero Charter Cancun', ['A-2']],
      ['A · Aerodinamica de Monterrey', ['A-3', 'A-4']],
    ]);
  });

  it('sin huecos o folio sin número ⇒ nada', () => {
    expect(
      huecosPorSerie([fila('A', '1'), fila('A', '2'), fila('A', 'SN')]),
    ).toEqual([]);
  });
});

describe('verificarEmisor', () => {
  const emisoras = [
    {
      id: 'e1',
      razon_social: 'Aero Charter Cancun S.A. de C.V.',
      rfc: null,
      activa: true,
    },
    {
      id: 'e2',
      razon_social: 'Aerodinamica de Monterrey',
      rfc: null,
      activa: true,
    },
  ];

  it('por nombre normalizado (sin forma societaria) aunque no haya RFC', () => {
    const r = verificarEmisor(
      'ACC150101AB1',
      'AERO CHARTER CANCÚN, S.A. DE C.V.',
      emisoras,
    );
    expect(r.emisora).toEqual({
      id: 'e1',
      razon_social: 'Aero Charter Cancun S.A. de C.V.',
    });
    expect(r.avisos).toEqual([]);
  });

  it('por RFC cuando la emisora lo tiene (también una INACTIVA)', () => {
    const r = verificarEmisor('ADM010101AA1', 'Otro nombre', [
      ...emisoras,
      { id: 'e3', razon_social: 'Vieja', rfc: 'ADM010101AA1', activa: false },
    ]);
    expect(r.emisora?.id).toBe('e3');
  });

  it('emisor ajeno ⇒ EMISOR_NO_VUELATOUR + EMISOR_SIN_VERIFICAR (sin RFCs)', () => {
    const r = verificarEmisor(
      'SIN9408027L7',
      'SEGUROS INBURSA, S.A., GRUPO FINANCIERO INBURSA',
      emisoras,
    );
    expect(r.emisora).toBeNull();
    expect(r.avisos.map((a) => a.code)).toEqual([
      'EMISOR_NO_VUELATOUR',
      'EMISOR_SIN_VERIFICAR',
    ]);
    expect(r.avisos[0].mensaje).toContain('(SIN9408027L7)');
    expect(r.avisos[0].mensaje).toContain('no una razón social de VuelaTour');
  });

  it('con RFCs capturados solo avisa EMISOR_NO_VUELATOUR', () => {
    const r = verificarEmisor('SIN9408027L7', null, [
      { ...emisoras[0], rfc: 'ACC150101AB1' },
    ]);
    expect(r.avisos.map((a) => a.code)).toEqual(['EMISOR_NO_VUELATOUR']);
  });

  it('sin datos de emisor ⇒ nada', () => {
    expect(verificarEmisor(null, null, emisoras)).toEqual({
      emisora: null,
      avisos: [],
    });
  });

  it('normalizarNombreEmpresa quita la forma societaria', () => {
    expect(normalizarNombreEmpresa('Aero Charter Cancún, S.A. de C.V.')).toBe(
      'AERO CHARTER CANCUN',
    );
    expect(normalizarNombreEmpresa('MAQAR MACHINERY SAPI DE CV')).toBe(
      'MAQAR MACHINERY',
    );
    expect(normalizarNombreEmpresa('Grupo X S. de R.L. de C.V.')).toBe(
      'GRUPO X',
    );
  });
});

describe('buscarYaRegistrada (una sola regla para 409 y «ya registrada»)', () => {
  const c = (
    id: string,
    serie: string | null,
    folio: string,
    uuid: string | null = null,
    emisora_id: string | null = null,
  ) => ({ id, serie, folio, uuid, emisora_id });

  it('UUID primero (sin importar mayúsculas)', () => {
    const r = buscarYaRegistrada(
      [c('x', 'Z', '9', 'D08B6837-A3B5-45AF-96E1-36F07FBA8FAF')],
      { uuid: 'd08b6837-a3b5-45af-96e1-36f07fba8faf', serie: 'A', folio: '1' },
    );
    expect(r?.tipo).toBe('UUID');
  });

  it('«A-123» sin serie contra «A» + «00123» ⇒ FOLIO', () => {
    const r = buscarYaRegistrada([c('x', 'A', '00123')], {
      serie: null,
      folio: 'A-123',
    });
    expect(r).toMatchObject({ tipo: 'FOLIO', fila: { id: 'x' } });
  });

  it('emisora NULL es comodín; dos emisoras distintas no chocan', () => {
    expect(
      buscarYaRegistrada([c('x', 'A', '1', null, 'e1')], {
        serie: 'A',
        folio: '1',
        emisora_id: null,
      }),
    ).not.toBeNull();
    expect(
      buscarYaRegistrada([c('x', 'A', '1', null, 'e1')], {
        serie: 'A',
        folio: '1',
        emisora_id: 'e2',
      }),
    ).toBeNull();
  });

  it('excluye la propia factura en una edición', () => {
    expect(
      buscarYaRegistrada([c('x', 'A', '1')], {
        serie: 'A',
        folio: '1',
        excluirId: 'x',
      }),
    ).toBeNull();
  });
});

describe('textos', () => {
  it('mensajeFacturaExistente (§6)', () => {
    expect(mensajeFacturaExistente('A-123', [297], 'VIGENTE')).toBe(
      'Ya está registrada: A-123 del vuelo #297.',
    );
    expect(mensajeFacturaExistente('A-123', [298, 297], 'VIGENTE')).toBe(
      'Ya está registrada: A-123 de los vuelos #297 y #298.',
    );
    expect(mensajeFacturaExistente('A-123', [], 'VIGENTE')).toBe(
      'Ya está registrada: A-123 (sin vuelo ligado).',
    );
    expect(mensajeFacturaExistente('A-123', [297], 'CANCELADA')).toBe(
      'Ya está registrada: A-123 del vuelo #297. Está CANCELADA; si la vuelves a emitir, usa otro folio.',
    );
  });
  it('listaFolios', () => {
    expect(listaFolios([341, 342, 343])).toBe('#341, #342 y #343');
  });
  it('patronIlikeSeguro no deja pasar separadores de PostgREST', () => {
    expect(patronIlikeSeguro('A,1(2)%_*')).toBe('A_1_2____');
  });
});

describe('faltanDatosFiscales', () => {
  it('etiquetas en orden; blancos cuentan como faltantes', () => {
    expect(
      faltanDatosFiscales({
        rfc: 'MMA150622P83',
        razon_social_default: ' ',
        regimen_fiscal_receptor: null,
        uso_cfdi: 'G03',
        codigo_postal: '',
      }),
    ).toEqual(['Razón social', 'Régimen fiscal', 'Código postal']);
    expect(faltanDatosFiscales(null)).toHaveLength(5);
  });
});

describe('avisoTotalDistintoVuelo (typo de monto)', () => {
  const base = {
    estatus: 'VIGENTE',
    es_parcial: false,
    moneda: 'USD',
    total: 7350.69,
    etiqueta: 'A-123',
    vuelos: [{ folio: 341, monto_total_usd: '8050.40', grupo_id: null }],
  };
  it('avisa con 1 vuelo, no parcial, misma moneda, diferencia > 1', () => {
    const a = avisoTotalDistintoVuelo(base);
    expect(a?.code).toBe('TOTAL_DISTINTO_VUELO');
    expect(a?.mensaje).toBe(
      'La factura A-123 suma $7,350.69 USD y el vuelo #341 cotizó $8,050.40 USD. Revisa el total (si es un anticipo, márcala como parcial).',
    );
  });
  it('no avisa: parcial, 2 vuelos, grupo, diferencia ≤ 1 o cancelada', () => {
    expect(avisoTotalDistintoVuelo({ ...base, es_parcial: true })).toBeNull();
    expect(
      avisoTotalDistintoVuelo({
        ...base,
        vuelos: [
          ...base.vuelos,
          { folio: 342, monto_total_usd: 1, grupo_id: null },
        ],
      }),
    ).toBeNull();
    expect(
      avisoTotalDistintoVuelo({
        ...base,
        vuelos: [{ ...base.vuelos[0], grupo_id: 'g1' }],
      }),
    ).toBeNull();
    expect(avisoTotalDistintoVuelo({ ...base, total: 8051.2 })).toBeNull();
    expect(
      avisoTotalDistintoVuelo({ ...base, estatus: 'CANCELADA' }),
    ).toBeNull();
  });
  it('MXN compara contra totalMxnDeVuelo (fuente única); null ⇒ no compara', () => {
    expect(
      avisoTotalDistintoVuelo({
        ...base,
        moneda: 'MXN',
        total: 136856.8,
        vuelos: [{ folio: 341, monto_total_mxn: '136856.80', grupo_id: null }],
      }),
    ).toBeNull();
    expect(
      avisoTotalDistintoVuelo({
        ...base,
        moneda: 'MXN',
        total: 100000,
        vuelos: [{ folio: 341, monto_total_mxn: '136856.80', grupo_id: null }],
      })?.mensaje,
    ).toContain('cotizó $136,856.80 MXN');
    expect(
      avisoTotalDistintoVuelo({
        ...base,
        moneda: 'MXN',
        vuelos: [{ folio: 341, monto_total_usd: 10, grupo_id: null }],
      }),
    ).toBeNull();
  });
});

describe('filtrarFacturas', () => {
  const fila = (
    p: Partial<FacturaFiltrable> & { id: string },
  ): FacturaFiltrable => ({
    serie: 'A',
    folio: '1',
    uuid: null,
    estatus: 'VIGENTE',
    fecha_emision: '2026-09-10',
    receptor_nombre: null,
    receptor_rfc: null,
    cliente_id: null,
    cliente_nombre: null,
    emisora_id: null,
    vuelo_ids: [],
    vuelo_folios: [],
    alertas: [],
    ...p,
  });
  const filas = [
    fila({
      id: '1',
      folio: '123',
      cliente_nombre: 'Maqar Machinery',
      vuelo_folios: [341],
    }),
    fila({
      id: '2',
      serie: null,
      folio: '55',
      estatus: 'CANCELADA',
      fecha_emision: '2026-08-01',
    }),
    fila({
      id: '3',
      folio: '7',
      emisora_id: 'e1',
      alertas: ['SIN_PDF'],
      receptor_nombre: 'Pájaro Azul',
    }),
  ];
  const ids = (xs: FacturaFiltrable[]) => xs.map((x) => x.id);

  it('q: etiqueta, número compacto, cliente, folio de vuelo, sin acentos', () => {
    expect(ids(filtrarFacturas(filas, { q: 'A-123' }))).toEqual(['1']);
    expect(ids(filtrarFacturas(filas, { q: 'a123' }))).toEqual(['1']);
    expect(ids(filtrarFacturas(filas, { q: 'maqar' }))).toEqual(['1']);
    expect(ids(filtrarFacturas(filas, { q: '#341' }))).toEqual(['1']);
    expect(ids(filtrarFacturas(filas, { q: 'pajaro' }))).toEqual(['3']);
  });
  it('fechas, estatus, serie especial, emisora especial y alerta', () => {
    expect(ids(filtrarFacturas(filas, { desde: '2026-09-01' }))).toEqual([
      '1',
      '3',
    ]);
    expect(ids(filtrarFacturas(filas, { estatus: 'CANCELADA' }))).toEqual([
      '2',
    ]);
    expect(ids(filtrarFacturas(filas, { serie: 'SIN_SERIE' }))).toEqual(['2']);
    expect(ids(filtrarFacturas(filas, { serie: 'a' }))).toEqual(['1', '3']);
    expect(ids(filtrarFacturas(filas, { emisora_id: 'SIN_EMISORA' }))).toEqual([
      '1',
      '2',
    ]);
    expect(ids(filtrarFacturas(filas, { alerta: 'sin_pdf' }))).toEqual(['3']);
  });
});

describe('totales, cobro y utilidades', () => {
  it('totalesPorMoneda: solo VIGENTES, jamás mezcla monedas', () => {
    expect(
      totalesPorMoneda([
        { estatus: 'VIGENTE', moneda: 'USD', total: '100.10' },
        { estatus: 'VIGENTE', moneda: 'USD', total: 0.2 },
        { estatus: 'CANCELADA', moneda: 'USD', total: 999 },
        { estatus: 'VIGENTE', moneda: 'MXN', total: 50 },
      ]),
    ).toEqual([
      { moneda: 'MXN', total: 50 },
      { moneda: 'USD', total: 100.3 },
    ]);
  });

  it('cobroResumenDe: insumos + semáforo server; lote caído ⇒ «Por cobrar»', () => {
    const v = {
      monto_total_usd: '8050.40',
      cobrado: false,
      cotizacion_abierta: false,
      estado: 'CONFIRMADO',
    };
    expect(
      cobroResumenDe(v, { total_cobrado: 8050.4, sin_tc_count: 0 }, false)
        .semaforo.key,
    ).toBe('COBRADO');
    const caido = cobroResumenDe(v, null, false);
    expect(caido.total_cobrado_usd).toBeNull();
    expect(caido.semaforo.label).toBe('Por cobrar');
  });

  it('interpretarBusquedaVuelo', () => {
    expect(interpretarBusquedaVuelo('#341', '2026-09-24')).toEqual({
      tipo: 'folio',
      folio: 341,
    });
    expect(interpretarBusquedaVuelo('27/09', '2026-09-24')).toEqual({
      tipo: 'dia',
      dia: '2026-09-27',
    });
    expect(interpretarBusquedaVuelo('2026-09-27', '2026-09-24')).toEqual({
      tipo: 'dia',
      dia: '2026-09-27',
    });
    expect(interpretarBusquedaVuelo('Maqar', '2026-09-24')).toEqual({
      tipo: 'texto',
      texto: 'Maqar',
    });
    expect(interpretarBusquedaVuelo('  ', '2026-09-24')).toEqual({
      tipo: 'vacia',
    });
  });

  it('interpretarBusquedaVuelo: fechas inexistentes y folios absurdos NO llegan a la BD (eran un 500)', () => {
    // «31/02» o «2026-13-45» ⇒ texto (la BD respondía «date/time field value
    // out of range»); un folio con más dígitos que un bigint ⇒ texto.
    expect(interpretarBusquedaVuelo('31/02', '2026-09-24')).toEqual({
      tipo: 'texto',
      texto: '31/02',
    });
    expect(interpretarBusquedaVuelo('2026-13-45', '2026-09-24')).toEqual({
      tipo: 'texto',
      texto: '2026-13-45',
    });
    expect(interpretarBusquedaVuelo('29/02/2028', '2026-09-24')).toEqual({
      tipo: 'dia',
      dia: '2028-02-29',
    });
    expect(
      interpretarBusquedaVuelo('#99999999999999999999', '2026-09-24'),
    ).toEqual({ tipo: 'texto', texto: '#99999999999999999999' });
  });

  it('enLotes parte en 200', () => {
    expect(
      enLotes(Array.from({ length: 450 }, (_, i) => i)).map((l) => l.length),
    ).toEqual([200, 200, 50]);
  });
});
