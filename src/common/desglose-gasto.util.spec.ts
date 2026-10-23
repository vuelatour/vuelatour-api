import {
  CATEGORIAS_TUA_INCLUIDA,
  CATS_EXTENSION_POR_NOTAS,
  CATS_SIN_TUA_EMBEBIDO,
  CONCEPTO_EXTENSION_PAGADA,
  NOTA_TUA_CERO_OFICINA,
  SUFIJO_TUA_FIJADA_OFICINA,
  categoriaAdmiteTuaIncluida,
  desgloseGastoLineas,
  desgloseGastoPartes,
  esExtension,
  extensionPorNotas,
  partesDeGasto,
  trasladosEmbebidosDeGasto,
  trasladosPagadosDeGasto,
  tuaAnuladaPorOficina,
  tuaDetectadaIa,
  tuaEmbebidoDeGasto,
  tuaIncluidaDe,
  tuaMontoDeIa,
  tuaPagadaDeGasto,
  type OpcionesDesglose,
} from './desglose-gasto.util';
import { categoriaEsDeEmpresa } from './categoria-gasto.util';

/**
 * EXTENSIÓN Y/O ANTELACIÓN DE HORARIO = TRASLADO AL CLIENTE (1-oct-2026).
 * Pedido de Ale con la captura del balance XA-VGV/N4142R, vuelo #192
 * (Srta. Mariana, CUN-CTM-CUN): «en este vuelo me se está poniendo la
 * extensión de servicios como Operación y no va en ese apartado». La
 * cotización cobra el EXTRA «Extensión de servicios» ($1,200 USD, ingreso de
 * VuelaTour) y lo pagado al aeropuerto se separa como el TUA: no es costo de
 * operar el avión. Los conceptos de abajo son los REALES de prod (SELECT del
 * 1-oct-2026).
 */

/** #192 · gasto 8ab208c4 · OPERACIONES $4,549.06 MXN (GAFSACOMM, Chetumal). */
const CONCEPTOS_192 = [
  { concepto: 'AE-Extension y/o antelacion de horario', monto: 3921.6 },
  { concepto: 'IVA 16%', monto: 627.46 },
];
/** #190 · gasto ccf37888 · OPERACIONES $4,549.04 MXN (Aeropuerto de Chetumal). */
const CONCEPTOS_190 = [
  { concepto: 'Extensión y/o antelación de horario', monto: 3921.59 },
  { concepto: 'IVA 16%', monto: 627.45 },
];
const VUELO = 'v-192';

describe('esExtension — los textos reales', () => {
  it.each([
    'AE-Extension y/o antelacion de horario',
    'Extensión y/o antelación de horario',
    'extensión de servicio inspector Baraona $500 efectivo',
    '2 horas extension servicio PEV 25 agosto · Proveedor: Roman Zuñiga',
    'Extensión de servicios',
    'extensión de servicios',
    'EXTENSIÓN DE HORARIO',
    'Antelación de horario',
    'Extension de horario nocturno',
    'AE Extension',
  ])('«%s» es extensión', (c) => {
    expect(esExtension(c)).toBe(true);
  });

  it.each([
    // Una palabra suelta NO basta (folio 11, ASUR: «Extensión» sin más).
    'Extensión',
    '3 horas ext servicios ctm N4142R',
    'TUA',
    'Operaciones',
    'Aterrizaje',
    'Servicio de plataforma',
    'Pernocta',
    'Estacionamiento Prolongado',
    '',
    null,
    undefined,
  ])('«%s» NO es extensión', (c) => {
    expect(esExtension(c)).toBe(false);
  });

  it('el concepto del egreso es uno solo para los dos libros', () => {
    expect(CONCEPTO_EXTENSION_PAGADA).toBe('extensión de horario pagada');
  });
});

describe('desgloseGastoPartes — extensión de horario con su IVA', () => {
  it('#192: 3921.60 × 1.16 = 4549.056 → 4549.06, Operación $0 (todo traslado)', () => {
    expect(desgloseGastoPartes(CONCEPTOS_192, 4549.06)).toEqual({
      operacion: 0,
      tua: 0,
      fbo: 0,
      extension: 4549.06,
    });
  });

  it('#190: 3921.59 × 1.16 = 4549.0444 → 4549.04, Operación $0', () => {
    expect(desgloseGastoPartes(CONCEPTOS_190, 4549.04)).toEqual({
      operacion: 0,
      tua: 0,
      fbo: 0,
      extension: 4549.04,
    });
  });

  it('factura MIXTA (aterrizaje + extensión + IVA): a Operación va SOLO el aterrizaje', () => {
    // 500 + 1000 netos; IVA 240; total 1,740.
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Aterrizaje', monto: 500 },
          { concepto: 'Extensión de horario', monto: 1000 },
          { concepto: 'IVA 16%', monto: 240 },
        ],
        1740,
      ),
    ).toEqual({ operacion: 580, tua: 0, fbo: 0, extension: 1160 });
  });

  it('tabla resumen (montos con IVA, sin renglón IVA): tal cual', () => {
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Operaciones', monto: 554.41 },
          { concepto: 'Extensión y/o antelación de horario', monto: 1119.26 },
        ],
        1673.67,
      ),
    ).toEqual({ operacion: 554.41, tua: 0, fbo: 0, extension: 1119.26 });
  });

  it('TUA + FBO + extensión + operación en la MISMA factura: cada uno a su lugar', () => {
    // Netos 100 + 200 + 300 + 400 = 1,000; IVA 160; total 1,160.
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Aterrizaje', monto: 100 },
          { concepto: 'TUA', monto: 200 },
          { concepto: 'Servicio FBO', monto: 300 },
          { concepto: 'Extensión de horario', monto: 400 },
          { concepto: 'IVA 16%', monto: 160 },
        ],
        1160,
      ),
    ).toEqual({ operacion: 116, tua: 232, fbo: 348, extension: 464 });
  });

  it('un renglón que es TUA Y extensión a la vez cuenta como TUA (gana el TUA)', () => {
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'TUA extensión de horario', monto: 1000 },
          { concepto: 'IVA 16%', monto: 160 },
        ],
        1160,
      ),
    ).toEqual({ operacion: 0, tua: 1160, fbo: 0, extension: 0 });
  });

  it('un renglón que es FBO Y extensión a la vez cuenta como FBO (gana el FBO)', () => {
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'FBO extensión de servicios', monto: 1000 },
          { concepto: 'IVA 16%', monto: 160 },
        ],
        1160,
      ),
    ).toEqual({ operacion: 0, tua: 0, fbo: 1160, extension: 0 });
  });

  it('la IA leyó mal (no cuadra ±$1): null — mejor no separar', () => {
    // 4,000 × 1.16 = 4,640 contra un total de 4,549.06.
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Extensión de horario', monto: 4000 },
          { concepto: 'IVA 16%', monto: 640 },
        ],
        4549.06,
      ),
    ).toBeNull();
    // Monto del gasto editado a la baja tras la captura IA (folio 11 real:
    // la factura de $1,673.67 se capturó como $554.41): no cuadra ⇒ null.
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Aterrizaje', monto: 43.26 },
          { concepto: 'Plataforma de embarque y desembarque', monto: 59.68 },
          { concepto: 'Estacionamiento Prolongado', monto: 10.08 },
          { concepto: 'Pernocta', monto: 964.88 },
          { concepto: 'TUA', monto: 14.92 },
          { concepto: 'Extensión', monto: 350 },
          { concepto: 'IVA 16%', monto: 230.85 },
        ],
        554.41,
      ),
    ).toBeNull();
  });

  it('centavos del redondeo por parte: los absorbe la extensión (y solo ella)', () => {
    // Tabla resumen que suma 1,500.04 contra 1,500.00 (±0.05): sin
    // operación, las partes quedarían 4 ¢ arriba del total.
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Tarifa TUA', monto: 500.02 },
          { concepto: 'Extensión de horario', monto: 1000.02 },
        ],
        1500,
      ),
    ).toEqual({ operacion: 0, tua: 500.02, fbo: 0, extension: 999.98 });
    // Control: SIN extensión la regla es la de siempre (null).
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Tarifa TUA', monto: 500.02 },
          { concepto: 'Servicio FBO', monto: 1000.02 },
        ],
        1500,
      ),
    ).toBeNull();
  });

  it('sin extensión: el desglose de TUA/FBO NO cambia (extension 0)', () => {
    // FEDCUN de la cabecera: neto 785.59 + IVA ⇒ $911.28; TUA 600 ⇒ $696.
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Aterrizaje', monto: 185.59 },
          { concepto: 'TUA', monto: 600 },
          { concepto: 'IVA 16%', monto: 125.69 },
        ],
        911.28,
      ),
    ).toEqual({ operacion: 215.28, tua: 696, fbo: 0, extension: 0 });
    // CZA/ASUR de la cabecera (tabla resumen).
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Operaciones', monto: 554.41 },
          { concepto: 'Tarifa TUA', monto: 1119.26 },
        ],
        1673.67,
      ),
    ).toEqual({ operacion: 554.41, tua: 1119.26, fbo: 0, extension: 0 });
    // Factura sin nada que separar.
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Aterrizaje', monto: 100 },
          { concepto: 'IVA 16%', monto: 16 },
        ],
        116,
      ),
    ).toBeNull();
  });
});

describe('desgloseGastoLineas — notas del gasto', () => {
  it('#192 imprime la extensión con su IVA', () => {
    expect(desgloseGastoLineas(CONCEPTOS_192, 4549.06, 'MXN')).toEqual([
      'Operación - $0.00 MXN',
      'Extensión de horario (IVA incluido) - $4549.06 MXN',
    ]);
  });

  it('factura mixta: Operación, TUA, FBO y extensión en ese orden', () => {
    expect(
      desgloseGastoLineas(
        [
          { concepto: 'Aterrizaje', monto: 100 },
          { concepto: 'TUA', monto: 200 },
          { concepto: 'Servicio FBO', monto: 300 },
          { concepto: 'Extensión de horario', monto: 400 },
          { concepto: 'IVA 16%', monto: 160 },
        ],
        1160,
        'MXN',
      ),
    ).toEqual([
      'Operación - $116.00 MXN',
      'TUA (IVA incluido) - $232.00 MXN',
      'FBO (IVA incluido) - $348.00 MXN',
      'Extensión de horario (IVA incluido) - $464.00 MXN',
    ]);
  });
});

describe('respaldo por TEXTO (sin conceptos IA)', () => {
  it('solo OPERACIONES y ATERRIZAJE', () => {
    expect([...CATS_EXTENSION_POR_NOTAS].sort()).toEqual([
      'ATERRIZAJE',
      'OPERACIONES',
    ]);
  });

  it('#314 (0d2c6f0c): OPERACIONES $500 «extensión de servicio inspector Baraona», conceptos null', () => {
    const g = {
      categoria: 'OPERACIONES',
      monto: '500.00',
      propina: '0.00',
      valor_ia_extraido: { conceptos: null },
      notas: 'extensión de servicio inspector Baraona $500 efectivo',
    };
    expect(extensionPorNotas(g)).toBe(true);
    expect(partesDeGasto(g)).toEqual({
      operacion: 0,
      tua: 0,
      fbo: 0,
      extension: 500,
    });
  });

  it('conceptos [] cuenta como «sin IA» (#190, b15080c3, Roman Zúñiga como OPERACIONES)', () => {
    const g = {
      categoria: 'OPERACIONES',
      monto: '3648.00',
      propina: '0.00',
      valor_ia_extraido: { conceptos: [] },
      notas:
        '2 horas extension servicio PEV 25 agosto · Proveedor: Roman Zuñiga',
    };
    expect(partesDeGasto(g)?.extension).toBe(3648);
  });

  it('solo la PRIMERA línea de las notas decide (lo anexado después no cuenta)', () => {
    expect(
      extensionPorNotas({
        categoria: 'OPERACIONES',
        notas:
          'Aterrizaje CUN\n\n[Corrección capturada en la app] la extensión de horario se pagó aparte',
      }),
    ).toBe(false);
  });

  it.each([
    // Negaciones: la nota DICE que no hubo extensión.
    'Aterrizaje CTM, sin extensión de horario',
    'no hubo extensión de servicio',
    'No se cobró extensión de horario',
    // Mezclas con otros servicios del aeródromo: sin factura no hay partes.
    'Aterrizaje y extensión de horario CTM',
    'Plataforma + extensión de servicio Chetumal',
    'Pernocta y antelación de horario',
    'TUA + extensión de horario',
    'Servicio FBO y extensión de servicio',
    'Combustible avgas con extensión de horario',
    // Textos ajenos (no son extensión de aeródromo).
    'extensión de garantía motor',
    'pago con antelación al vuelo',
    'Extensión',
  ])(
    'respaldo CONSERVADOR: «%s» NO se toma como extensión completa',
    (notas) => {
      const g = { categoria: 'OPERACIONES', monto: 1500, notas };
      expect(extensionPorNotas(g)).toBe(false);
      expect(partesDeGasto(g)).toBeNull();
      expect(trasladosEmbebidosDeGasto({ ...g, vuelo_id: VUELO })).toEqual({
        tua: 0,
        extension: 0,
      });
    },
  );

  it.each([
    'extensión de servicio inspector Baraona $500 efectivo',
    '2 horas extension servicio PEV 25 agosto · Proveedor: Roman Zuñiga',
    'Extension de horario nocturno Chetumal',
    'Antelación de horario · Proveedor: Aeropuerto de Chetumal',
  ])('respaldo vigente: «%s» sí es extensión completa', (notas) => {
    expect(extensionPorNotas({ categoria: 'OPERACIONES', notas })).toBe(true);
  });

  it('otra categoría (FBO, COMIDA, OTRO…) no usa el respaldo por texto', () => {
    for (const categoria of ['FBO', 'COMIDA', 'OTRO', 'TUAS', 'REFACCION']) {
      expect(
        extensionPorNotas({ categoria, notas: 'extensión de horario CTM' }),
      ).toBe(false);
    }
  });

  it('con conceptos IA manda la factura: si no cuadra NO hay respaldo por texto', () => {
    const g = {
      categoria: 'OPERACIONES',
      monto: 4549.06,
      valor_ia_extraido: {
        conceptos: [
          { concepto: 'Extensión de horario', monto: 4000 },
          { concepto: 'IVA 16%', monto: 640 },
        ],
      },
      notas: 'Extensión de horario CTM',
    };
    expect(extensionPorNotas(g)).toBe(false);
    expect(partesDeGasto(g)).toBeNull();
  });

  it('la propina queda fuera de la extensión (sigue siendo costo del avión)', () => {
    expect(
      partesDeGasto({
        categoria: 'ATERRIZAJE',
        monto: 600,
        propina: 100,
        notas: 'Antelación de horario Chetumal',
      })?.extension,
    ).toBe(500);
  });
});

describe('trasladosEmbebidosDeGasto / tuaEmbebidoDeGasto', () => {
  const base = {
    vuelo_id: VUELO,
    categoria: 'OPERACIONES',
    propina: '0.00',
  };

  it('#192 y #190: toda la factura es extensión; el TUA embebido sigue en 0', () => {
    const g192 = {
      ...base,
      monto: '4549.06',
      valor_ia_extraido: { conceptos: CONCEPTOS_192 },
    };
    const g190 = {
      ...base,
      monto: '4549.04',
      valor_ia_extraido: { conceptos: CONCEPTOS_190 },
    };
    expect(trasladosEmbebidosDeGasto(g192)).toEqual({
      tua: 0,
      extension: 4549.06,
    });
    expect(trasladosEmbebidosDeGasto(g190)).toEqual({
      tua: 0,
      extension: 4549.04,
    });
    // Firma vieja intacta: el TUA de esas facturas es 0.
    expect(tuaEmbebidoDeGasto(g192)).toBe(0);
  });

  it('#314 por notas (sin IA)', () => {
    expect(
      trasladosEmbebidosDeGasto({
        ...base,
        monto: '500.00',
        valor_ia_extraido: null,
        notas: 'extensión de servicio inspector Baraona $500 efectivo',
      }),
    ).toEqual({ tua: 0, extension: 500 });
  });

  it('TUA y extensión en la misma factura: cada uno con su IVA', () => {
    const g = {
      ...base,
      monto: 1160,
      valor_ia_extraido: {
        conceptos: [
          { concepto: 'Aterrizaje', monto: 100 },
          { concepto: 'TUA', monto: 200 },
          { concepto: 'Servicio FBO', monto: 300 },
          { concepto: 'Extensión de horario', monto: 400 },
          { concepto: 'IVA 16%', monto: 160 },
        ],
      },
    };
    expect(trasladosEmbebidosDeGasto(g)).toEqual({ tua: 232, extension: 464 });
    expect(tuaEmbebidoDeGasto(g)).toBe(232);
  });

  it('categoría de EMPRESA (OTRO/FIJO) e INDIRECTO no entran: viajan enteras a «otros gastos»', () => {
    // 6e21976a real: OTRO «3 horas ext servicios ctm N4142R» (Roman Zúñiga).
    for (const categoria of ['OTRO', 'FIJO', 'INDIRECTO', 'NOMINA']) {
      expect(
        trasladosEmbebidosDeGasto({
          ...base,
          categoria,
          monto: '4549.06',
          valor_ia_extraido: { conceptos: CONCEPTOS_192 },
          notas: 'Extensión de horario CTM',
        }),
      ).toEqual({ tua: 0, extension: 0 });
    }
    expect(CATS_SIN_TUA_EMBEBIDO.has('INDIRECTO')).toBe(true);
    // 23-oct-2026 (invariante 107): el egreso de «otros movimientos» entra
    // ENTERO; jamás se le separa una TUA (se egresaría dos veces).
    expect(CATS_SIN_TUA_EMBEBIDO.has('OTROS_MOVIMIENTOS')).toBe(true);
  });

  it('COMISARIATO (13-oct-2026): nada se separa aunque los renglones IA «parezcan» de aeródromo', () => {
    // Ticket de súper/OXXO de los pasajeros: jamás factura con TUA/FBO
    // embebidos — la fila del balance lo lleva ENTERO a la columna OTROS.
    expect(CATS_SIN_TUA_EMBEBIDO.has('COMISARIATO')).toBe(true);
    expect(
      trasladosEmbebidosDeGasto({
        ...base,
        categoria: 'COMISARIATO',
        monto: '80',
        valor_ia_extraido: {
          conceptos: [
            { concepto: 'Servicio FBO', monto: 50 },
            { concepto: 'TUA', monto: 30 },
          ],
        },
      }),
    ).toEqual({ tua: 0, extension: 0 });
    // Control: la MISMA lectura como OPERACIONES sí separa el TUA.
    expect(
      trasladosEmbebidosDeGasto({
        ...base,
        monto: '80',
        valor_ia_extraido: {
          conceptos: [
            { concepto: 'Servicio FBO', monto: 50 },
            { concepto: 'TUA', monto: 30 },
          ],
        },
      }).tua,
    ).toBe(30);
  });

  it('parcial del reparto manual o gasto SIN vuelo: nada', () => {
    const g = {
      ...base,
      monto: '4549.06',
      valor_ia_extraido: { conceptos: CONCEPTOS_192 },
    };
    expect(
      trasladosEmbebidosDeGasto({ ...g, es_reparto_parcial: true }),
    ).toEqual({ tua: 0, extension: 0 });
    expect(trasladosEmbebidosDeGasto({ ...g, vuelo_id: null })).toEqual({
      tua: 0,
      extension: 0,
    });
  });

  it('sin notas ni IA: nada (comportamiento de siempre)', () => {
    expect(
      trasladosEmbebidosDeGasto({
        ...base,
        monto: 500,
        valor_ia_extraido: null,
      }),
    ).toEqual({ tua: 0, extension: 0 });
  });
});

describe('claves ASUR sin nombre de concepto («Servicio (clave NNNNNN)»)', () => {
  /** #305 · gasto cf30b0c6 · OPERACIONES $923.88 MXN · Aeropuerto de Cozumel,
   *  factura FEACZM 72139 (21-sep-2026). La oficina: «ese es el TUA, no forma
   *  parte de la operación» (2 × $374.31 − descuento $6.40 = neto $742.22).
   *  Conceptos REALES de prod (SELECT del 6-oct-2026). */
  const CONCEPTOS_305 = [
    { concepto: 'Servicio (clave 210200)', monto: 22.12 },
    { concepto: 'Servicio (clave 210100)', monto: 32.11 },
    { concepto: 'Servicio (clave 130700) neto con descuento', monto: 742.22 },
    { concepto: 'IVA 16%', monto: 127.43 },
  ];

  it('130700 (TUA nacional Cozumel): TUA $860.98 con IVA, Operación $62.90', () => {
    expect(desgloseGastoPartes(CONCEPTOS_305, 923.88)).toEqual({
      operacion: 62.9,
      tua: 860.98,
      fbo: 0,
      extension: 0,
    });
    expect(
      trasladosEmbebidosDeGasto({
        vuelo_id: VUELO,
        categoria: 'OPERACIONES',
        propina: '0.00',
        monto: '923.88',
        valor_ia_extraido: { conceptos: CONCEPTOS_305 },
      }),
    ).toEqual({ tua: 860.98, extension: 0 });
  });

  it('230700 (TUA Cozumel, ticket jul-2026) sigue siendo TUA', () => {
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Servicio (clave 230700)', monto: 1484.44 },
          { concepto: 'IVA 16%', monto: 237.51 },
        ],
        1721.95,
      ),
    ).toEqual({ operacion: 0, tua: 1721.95, fbo: 0, extension: 0 });
  });

  it('210100/210200/210300 (aterrizaje, plataformas) NO son TUA: nada que separar', () => {
    // #324 · $825.13: solo plataforma de pernocta + IVA.
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Plataforma de Pernocta (clave 210300)', monto: 711.32 },
          { concepto: 'IVA 16%', monto: 113.81 },
        ],
        825.13,
      ),
    ).toBeNull();
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Servicio (clave 210100)', monto: 34.27 },
          { concepto: 'Servicio (clave 210300)', monto: 186.37 },
          { concepto: 'Servicio (clave 210200)', monto: 47.22 },
          { concepto: 'IVA 16%', monto: 42.86 },
        ],
        310.72,
      ),
    ).toBeNull();
  });

  it('la clave se compara completa (1307001 o 2130700 no son TUA)', () => {
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Servicio (clave 1307001)', monto: 100 },
          { concepto: 'IVA 16%', monto: 16 },
        ],
        116,
      ),
    ).toBeNull();
  });
});

/**
 * TUA SISTÉMICA (13-oct-2026, invariante 66; caso #383, gasto 8c60e428: la
 * IA leyó corrida la tabla resumen de ASUR y llamó «Autobuses» a la Tarifa
 * TUA de $559.63 — nada se separó). Prioridad única de la TUA:
 * `tua_incluida` (oficina) > renglón reconocido > `tua_monto` SOLO con
 * tabla que cuadra.
 */
/** #383 tal como lo leyó la IA (suma 1,925.27 = total: forma b). */
const CONCEPTOS_383 = [
  { concepto: 'Operaciones', monto: 1365.64 },
  { concepto: 'Autobuses', monto: 559.63 },
];
/** CZA/ASUR con el renglón TUA nombrado (cabecera del util). */
const CONCEPTOS_ASUR_TUA = [
  { concepto: 'Operaciones', monto: 554.41 },
  { concepto: 'Tarifa TUA', monto: 1119.26 },
];
/** #118 · 45007a9c (26-ago): los renglones NO cuadran por $29.71. */
const CONCEPTOS_118 = [
  { concepto: 'Servicio (clave 210100)', monto: 96.33 },
  { concepto: 'Servicio (clave 230700)', monto: 2994.48 },
  { concepto: 'Servicio (clave 210200)', monto: 66.36 },
  { concepto: 'IVA 16%', monto: 501.05 },
];

describe('señal tua_monto (13-oct-2026)', () => {
  it('#383 tal como se leyó: sin señal ⇒ null; con tua_monto 559.63 ⇒ Operación 1,365.64 + TUA 559.63', () => {
    expect(desgloseGastoPartes(CONCEPTOS_383, 1925.27)).toBeNull();
    expect(
      desgloseGastoPartes(CONCEPTOS_383, 1925.27, { tuaMonto: 559.63 }),
    ).toEqual({ operacion: 1365.64, tua: 559.63, fbo: 0, extension: 0 });
    expect(
      desgloseGastoLineas(CONCEPTOS_383, 1925.27, 'MXN', {
        tuaMonto: 559.63,
      }),
    ).toEqual(['Operación - $1365.64 MXN', 'TUA (IVA incluido) - $559.63 MXN']);
  });

  it('un renglón TUA nombrado MANDA sobre la señal (tua 1,119.26 aunque tua_monto diga 999)', () => {
    expect(
      desgloseGastoPartes(CONCEPTOS_ASUR_TUA, 1673.67, { tuaMonto: 999 }),
    ).toEqual(desgloseGastoPartes(CONCEPTOS_ASUR_TUA, 1673.67));
    expect(
      desgloseGastoPartes(CONCEPTOS_ASUR_TUA, 1673.67, { tuaMonto: 999 })?.tua,
    ).toBe(1119.26);
  });

  it('forma a (netos + IVA): la señal YA trae IVA — jamás × 1.16', () => {
    const conceptos = [
      { concepto: 'Aterrizaje', monto: 500 },
      { concepto: 'Servicio', monto: 482.44 },
      { concepto: 'IVA 16%', monto: 157.19 },
    ];
    expect(desgloseGastoPartes(conceptos, 1139.63)).toBeNull();
    expect(
      desgloseGastoPartes(conceptos, 1139.63, { tuaMonto: 559.63 }),
    ).toEqual({ operacion: 580, tua: 559.63, fbo: 0, extension: 0 });
  });

  it('#118: la tabla NO cuadra ⇒ null aunque venga la señal (la señal no repara una lectura rota)', () => {
    expect(
      desgloseGastoPartes(CONCEPTOS_118, 3632.61, { tuaMonto: 3473.6 }),
    ).toBeNull();
  });

  it('señal MAYOR que el total ⇒ se ignora (null)', () => {
    expect(
      desgloseGastoPartes(CONCEPTOS_383, 1925.27, { tuaMonto: 3000 }),
    ).toBeNull();
  });

  it.each([0, -1, Number.NaN, 'abc' as unknown as number, null, undefined])(
    'tua_monto %p ⇒ idéntico a sin opciones',
    (tuaMonto) => {
      expect(desgloseGastoPartes(CONCEPTOS_383, 1925.27, { tuaMonto })).toEqual(
        desgloseGastoPartes(CONCEPTOS_383, 1925.27),
      );
      expect(
        desgloseGastoPartes(CONCEPTOS_ASUR_TUA, 1673.67, { tuaMonto }),
      ).toEqual(desgloseGastoPartes(CONCEPTOS_ASUR_TUA, 1673.67));
    },
  );

  it('un solo renglón que cuadra + señal ⇒ Operación y TUA (2 líneas)', () => {
    const uno = [{ concepto: 'Operaciones', monto: 1925.27 }];
    expect(desgloseGastoPartes(uno, 1925.27, { tuaMonto: 559.63 })).toEqual({
      operacion: 1365.64,
      tua: 559.63,
      fbo: 0,
      extension: 0,
    });
    expect(
      desgloseGastoLineas(uno, 1925.27, 'MXN', { tuaMonto: 559.63 }),
    ).toHaveLength(2);
  });

  it('FBO + señal: cada parte a su lugar', () => {
    expect(
      desgloseGastoPartes(
        [
          { concepto: 'Operaciones', monto: 1000 },
          { concepto: 'FOB', monto: 365.64 },
          { concepto: 'Autobuses', monto: 559.63 },
        ],
        1925.27,
        { tuaMonto: 559.63 },
      ),
    ).toEqual({ operacion: 1000, tua: 559.63, fbo: 365.64, extension: 0 });
  });

  it('señal = total con un renglón genérico ⇒ toda la factura es TUA', () => {
    expect(
      desgloseGastoPartes(
        [{ concepto: 'Servicio (clave 999999)', monto: 939.6 }],
        939.6,
        { tuaMonto: 939.6 },
      ),
    ).toEqual({ operacion: 0, tua: 939.6, fbo: 0, extension: 0 });
  });

  it('DELIBERADO: partesDeGasto con conceptos [] y tua_monto ⇒ null (pyservices vacía la tabla que no suma)', () => {
    expect(
      partesDeGasto({
        categoria: 'OPERACIONES',
        monto: 1925.27,
        valor_ia_extraido: { conceptos: [], tua_monto: 559.63 },
      }),
    ).toBeNull();
  });

  it('partesDeGasto lee la señal de valor_ia_extraido.tua_monto', () => {
    expect(
      partesDeGasto({
        categoria: 'OPERACIONES',
        monto: '1925.27',
        propina: '0.00',
        valor_ia_extraido: { conceptos: CONCEPTOS_383, tua_monto: 559.63 },
      }),
    ).toEqual({ operacion: 1365.64, tua: 559.63, fbo: 0, extension: 0 });
  });
});

describe('tua_incluida (oficina) manda (13-oct-2026)', () => {
  const op = {
    vuelo_id: VUELO,
    categoria: 'OPERACIONES',
    propina: '0.00',
  };

  it('#383 sin señal + «559.63» (string de PostgREST) ⇒ Operación 1,365.64 + TUA 559.63', () => {
    const g = {
      ...op,
      monto: '1925.27',
      valor_ia_extraido: { conceptos: CONCEPTOS_383 },
      tua_incluida: '559.63',
    };
    expect(partesDeGasto(g)).toEqual({
      operacion: 1365.64,
      tua: 559.63,
      fbo: 0,
      extension: 0,
    });
    expect(trasladosEmbebidosDeGasto(g)).toEqual({ tua: 559.63, extension: 0 });
  });

  it('tabla 1,673.67 con renglón TUA: 0 ⇒ sin TUA; 300 ⇒ 300; 5,000 ⇒ topada a la base', () => {
    const g = {
      ...op,
      monto: '1673.67',
      valor_ia_extraido: { conceptos: CONCEPTOS_ASUR_TUA },
    };
    expect(partesDeGasto({ ...g, tua_incluida: 0 })).toEqual({
      operacion: 1673.67,
      tua: 0,
      fbo: 0,
      extension: 0,
    });
    expect(trasladosEmbebidosDeGasto({ ...g, tua_incluida: 0 })).toEqual({
      tua: 0,
      extension: 0,
    });
    expect(partesDeGasto({ ...g, tua_incluida: 300 })).toEqual({
      operacion: 1373.67,
      tua: 300,
      fbo: 0,
      extension: 0,
    });
    expect(partesDeGasto({ ...g, tua_incluida: 5000 })).toEqual({
      operacion: 0,
      tua: 1673.67,
      fbo: 0,
      extension: 0,
    });
  });

  it('#118: la cifra de la oficina manda aunque los renglones no cuadren', () => {
    const g = {
      ...op,
      monto: '3632.61',
      valor_ia_extraido: { conceptos: CONCEPTOS_118 },
      tua_incluida: '3443.89',
    };
    expect(partesDeGasto(g)).toEqual({
      operacion: 188.72,
      tua: 3443.89,
      fbo: 0,
      extension: 0,
    });
    expect(trasladosEmbebidosDeGasto(g)).toEqual({
      tua: 3443.89,
      extension: 0,
    });
  });

  it('sin lectura IA: > 0 separa; 0 ⇒ null (nada que separar)', () => {
    expect(
      partesDeGasto({ ...op, monto: 1925.27, tua_incluida: 559.63 }),
    ).toEqual({ operacion: 1365.64, tua: 559.63, fbo: 0, extension: 0 });
    expect(
      partesDeGasto({ ...op, monto: 1925.27, tua_incluida: 0 }),
    ).toBeNull();
  });

  it('la propina queda fuera de la base (monto 2,000 propina 74.73)', () => {
    expect(
      partesDeGasto({
        ...op,
        monto: 2000,
        propina: 74.73,
        tua_incluida: 559.63,
      }),
    ).toEqual({ operacion: 1365.64, tua: 559.63, fbo: 0, extension: 0 });
  });

  it('factura MIXTA (Operaciones 1,025 + Tarifa TUA 600 + FOB 300): la TUA manda y recorta el FBO al resto', () => {
    const g = {
      ...op,
      monto: 1925,
      valor_ia_extraido: {
        conceptos: [
          { concepto: 'Operaciones', monto: 1025 },
          { concepto: 'Tarifa TUA', monto: 600 },
          { concepto: 'FOB', monto: 300 },
        ],
      },
    };
    expect(partesDeGasto(g)).toEqual({
      operacion: 1025,
      tua: 600,
      fbo: 300,
      extension: 0,
    });
    expect(partesDeGasto({ ...g, tua_incluida: 700 })).toEqual({
      operacion: 925,
      tua: 700,
      fbo: 300,
      extension: 0,
    });
    expect(partesDeGasto({ ...g, tua_incluida: 1800 })).toEqual({
      operacion: 0,
      tua: 1800,
      fbo: 125,
      extension: 0,
    });
    expect(partesDeGasto({ ...g, tua_incluida: 0 })).toEqual({
      operacion: 1625,
      tua: 0,
      fbo: 300,
      extension: 0,
    });
  });

  it('#314 por notas (extensión completa) + TUA 100 ⇒ la extensión se recorta al resto', () => {
    const g = {
      ...op,
      monto: '500.00',
      valor_ia_extraido: null,
      notas: 'extensión de servicio inspector Baraona $500 efectivo',
      tua_incluida: 100,
    };
    expect(partesDeGasto(g)).toEqual({
      operacion: 0,
      tua: 100,
      fbo: 0,
      extension: 400,
    });
    expect(trasladosEmbebidosDeGasto(g)).toEqual({ tua: 100, extension: 400 });
  });

  it('USD: la cifra va en la moneda del gasto (monto 100 + 10 ⇒ 90 / 10)', () => {
    expect(partesDeGasto({ ...op, monto: 100, tua_incluida: 10 })).toEqual({
      operacion: 90,
      tua: 10,
      fbo: 0,
      extension: 0,
    });
  });

  it('las exclusiones de trasladosEmbebidosDeGasto GANAN aunque haya override', () => {
    const g = { ...op, monto: 1925.27, tua_incluida: 500 };
    for (const categoria of ['COMIDA', 'OTRO', 'TUAS']) {
      expect(trasladosEmbebidosDeGasto({ ...g, categoria })).toEqual({
        tua: 0,
        extension: 0,
      });
    }
    expect(trasladosEmbebidosDeGasto({ ...g, vuelo_id: null })).toEqual({
      tua: 0,
      extension: 0,
    });
    expect(
      trasladosEmbebidosDeGasto({ ...g, es_reparto_parcial: true }),
    ).toEqual({ tua: 0, extension: 0 });
  });
});

describe('helpers de la TUA sistémica y regresión byte a byte (13-oct-2026)', () => {
  it('tuaIncluidaDe: null/vacío/texto/negativo ⇒ null; «0» ⇒ 0; a centavos', () => {
    expect(tuaIncluidaDe({ tua_incluida: null })).toBeNull();
    expect(tuaIncluidaDe({})).toBeNull();
    expect(tuaIncluidaDe({ tua_incluida: '' })).toBeNull();
    expect(tuaIncluidaDe({ tua_incluida: '  ' })).toBeNull();
    expect(tuaIncluidaDe({ tua_incluida: 'abc' })).toBeNull();
    expect(tuaIncluidaDe({ tua_incluida: -1 })).toBeNull();
    expect(tuaIncluidaDe({ tua_incluida: '0' })).toBe(0);
    expect(tuaIncluidaDe({ tua_incluida: '559.63' })).toBe(559.63);
    expect(tuaIncluidaDe({ tua_incluida: 12.345 })).toBe(12.35);
  });

  it('tuaMontoDeIa: número o texto finito > 0 ⇒ a centavos; lo demás ⇒ null', () => {
    expect(tuaMontoDeIa({ tua_monto: 559.63 })).toBe(559.63);
    expect(tuaMontoDeIa({ tua_monto: '559.634' })).toBe(559.63);
    for (const v of [0, -5, null, undefined, 'abc', '', true, {}]) {
      expect(tuaMontoDeIa({ tua_monto: v })).toBeNull();
    }
    expect(tuaMontoDeIa(null)).toBeNull();
    expect(tuaMontoDeIa('559.63')).toBeNull();
    expect(tuaMontoDeIa({ conceptos: [] })).toBeNull();
  });

  it('tuaDetectadaIa ignora el override; tuaAnuladaPorOficina solo con 0 y una TUA que la IA sí separaba', () => {
    const g383 = {
      categoria: 'OPERACIONES',
      monto: 1925.27,
      valor_ia_extraido: { conceptos: CONCEPTOS_383, tua_monto: 559.63 },
    };
    expect(tuaDetectadaIa({ ...g383, tua_incluida: 0 })).toBe(559.63);
    expect(tuaAnuladaPorOficina({ ...g383, tua_incluida: 0 })).toBe(true);
    expect(tuaAnuladaPorOficina({ ...g383, tua_incluida: 100 })).toBe(false);
    expect(tuaAnuladaPorOficina({ ...g383, tua_incluida: null })).toBe(false);
    const sinSenal = {
      ...g383,
      valor_ia_extraido: { conceptos: CONCEPTOS_383 },
    };
    expect(tuaDetectadaIa(sinSenal)).toBeNull();
    expect(tuaAnuladaPorOficina({ ...sinSenal, tua_incluida: 0 })).toBe(false);
  });

  it('trasladosPagadosDeGasto: TUAS entero, EMPRESA nada, el resto = la embebida', () => {
    expect(
      trasladosPagadosDeGasto({
        vuelo_id: VUELO,
        categoria: 'TUAS',
        monto: '80',
      }),
    ).toEqual({ tua: 80, extension: 0 });
    expect(
      tuaPagadaDeGasto({ vuelo_id: VUELO, categoria: 'TUAS', monto: 80 }),
    ).toBe(80);
    const conTua = {
      vuelo_id: VUELO,
      monto: '1673.67',
      valor_ia_extraido: { conceptos: CONCEPTOS_ASUR_TUA },
    };
    expect(trasladosPagadosDeGasto({ ...conTua, categoria: 'OTRO' })).toEqual({
      tua: 0,
      extension: 0,
    });
    const opG = { ...conTua, categoria: 'OPERACIONES' };
    expect(trasladosPagadosDeGasto(opG)).toEqual(
      trasladosEmbebidosDeGasto(opG),
    );
    expect(tuaPagadaDeGasto(opG)).toBe(1119.26);
    expect(tuaPagadaDeGasto({ ...opG, tua_incluida: 0 })).toBe(0);
  });

  it('CATEGORIAS_TUA_INCLUIDA = OPERACIONES, ATERRIZAJE, FBO (congelada; ninguna sin TUA embebido ni de empresa)', () => {
    expect([...CATEGORIAS_TUA_INCLUIDA]).toEqual([
      'OPERACIONES',
      'ATERRIZAJE',
      'FBO',
    ]);
    expect(Object.isFrozen(CATEGORIAS_TUA_INCLUIDA)).toBe(true);
    for (const c of CATEGORIAS_TUA_INCLUIDA) {
      expect(CATS_SIN_TUA_EMBEBIDO.has(c)).toBe(false);
      expect(categoriaEsDeEmpresa(c)).toBe(false);
      expect(categoriaAdmiteTuaIncluida(c)).toBe(true);
    }
    for (const c of ['COMIDA', 'COMISARIATO', 'TUAS', 'REFACCION', null]) {
      expect(categoriaAdmiteTuaIncluida(c)).toBe(false);
    }
    expect(SUFIJO_TUA_FIJADA_OFICINA).toBe(' (fijada por oficina)');
    expect(NOTA_TUA_CERO_OFICINA).toBe('TUA: 0 (fijada por oficina)');
  });

  /** Las fixtures de siempre: sin señal ni override el resultado NO cambia. */
  const FIXTURES: Array<
    [string, Array<{ concepto: string; monto: number }>, number]
  > = [
    ['#192', CONCEPTOS_192, 4549.06],
    ['#190', CONCEPTOS_190, 4549.04],
    [
      'mixta',
      [
        { concepto: 'Aterrizaje', monto: 100 },
        { concepto: 'TUA', monto: 200 },
        { concepto: 'Servicio FBO', monto: 300 },
        { concepto: 'Extensión de horario', monto: 400 },
        { concepto: 'IVA 16%', monto: 160 },
      ],
      1160,
    ],
    ['tabla resumen', CONCEPTOS_ASUR_TUA, 1673.67],
    [
      'FEDCUN',
      [
        { concepto: 'Aterrizaje', monto: 185.59 },
        { concepto: 'TUA', monto: 600 },
        { concepto: 'IVA 16%', monto: 125.69 },
      ],
      911.28,
    ],
    [
      'clave 130700',
      [
        { concepto: 'Servicio (clave 210200)', monto: 22.12 },
        { concepto: 'Servicio (clave 210100)', monto: 32.11 },
        {
          concepto: 'Servicio (clave 130700) neto con descuento',
          monto: 742.22,
        },
        { concepto: 'IVA 16%', monto: 127.43 },
      ],
      923.88,
    ],
    [
      'clave 230700',
      [
        { concepto: 'Servicio (clave 230700)', monto: 1484.44 },
        { concepto: 'IVA 16%', monto: 237.51 },
      ],
      1721.95,
    ],
    [
      'claves 2101xx (sin TUA)',
      [
        { concepto: 'Servicio (clave 210100)', monto: 34.27 },
        { concepto: 'Servicio (clave 210300)', monto: 186.37 },
        { concepto: 'Servicio (clave 210200)', monto: 47.22 },
        { concepto: 'IVA 16%', monto: 42.86 },
      ],
      310.72,
    ],
    ['#118 (no cuadra)', CONCEPTOS_118, 3632.61],
    ['#383 (Autobuses)', CONCEPTOS_383, 1925.27],
  ];
  const OPCIONES_NEUTRAS: Array<OpcionesDesglose | undefined> = [
    undefined,
    {},
    { tuaMonto: null },
  ];

  it.each(FIXTURES)(
    '%s: opciones undefined / {} / {tuaMonto: null} y tua_incluida undefined / null ⇒ idéntico',
    (_n, conceptos, total) => {
      const sin = desgloseGastoPartes(conceptos, total);
      const lineasSin = desgloseGastoLineas(conceptos, total, 'MXN');
      for (const op of OPCIONES_NEUTRAS) {
        expect(desgloseGastoPartes(conceptos, total, op)).toEqual(sin);
        expect(desgloseGastoLineas(conceptos, total, 'MXN', op)).toEqual(
          lineasSin,
        );
      }
      const g = {
        vuelo_id: VUELO,
        categoria: 'OPERACIONES',
        monto: total,
        valor_ia_extraido: { conceptos },
      };
      const partesSin = partesDeGasto(g);
      const trasladosSin = trasladosEmbebidosDeGasto(g);
      for (const tua_incluida of [undefined, null]) {
        expect(partesDeGasto({ ...g, tua_incluida })).toEqual(partesSin);
        expect(trasladosEmbebidosDeGasto({ ...g, tua_incluida })).toEqual(
          trasladosSin,
        );
      }
    },
  );
});
