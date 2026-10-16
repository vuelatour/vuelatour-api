import {
  CLAVE_PRECIERRE_TUA_PAGADA_SIN_COBRAR,
  DETALLE_PRECIERRE_TUA_PAGADA_SIN_COBRAR,
  DETALLE_PRECIERRE_TUA_PAGADA_SIN_COBRAR_FALLIDA,
  TITULO_PRECIERRE_TUA_PAGADA_SIN_COBRAR,
  candidatosPrecierreInversos,
  extrasPactados,
  tuaPagadaPorVuelo,
  vuelosConTuaPagadaSinCobrar,
  type VueloInversoRow,
} from './tua-pagada-sin-cobrar.util';

/**
 * PRE-CIERRE «Vuelos con TUA pagada por Operación sin TUA cobrada al
 * cliente» (15-oct-2026, PEDIDO 4). Universo COMPARTIDO de los renglones
 * inversos y TUA pagada por la fuente única `trasladosPagadosDeGasto`, con
 * las filas REALES de prod (SELECT por MCP del 15-oct-2026).
 */
function vuelo(extra: Partial<VueloInversoRow> = {}): VueloInversoRow {
  return {
    id: 'v-70',
    folio: 70,
    fecha_vuelo: '2026-07-23T15:00:00+00:00',
    aeronave_id: 'av-vgv',
    es_externo: false,
    cliente_id: 'cli-1',
    pase_abordar: false,
    monto_total_usd: 1795,
    calculo_snapshot: {
      desglose: [{ clave: 'TIEMPO_VUELO', monto_usd: 1795 }],
      extras: [],
    },
    extras: [],
    ...extra,
  };
}

const SIN_INTERNOS = new Set<string>();

describe('candidatosPrecierreInversos (universo común)', () => {
  it('propio, cliente no interno y total > 0 ⇒ entra, con TUA cobrada 0 y sus extras', () => {
    expect(candidatosPrecierreInversos([vuelo()], SIN_INTERNOS)).toEqual([
      {
        id: 'v-70',
        folio: 70,
        fecha_vuelo: '2026-07-23T15:00:00+00:00',
        aeronave_id: 'av-vgv',
        pase_abordar: false,
        tua_cobrada_usd: 0,
        extras: [],
      },
    ]);
  });

  it('externo, cliente interno, total 0 y sin id ⇒ fuera', () => {
    expect(
      candidatosPrecierreInversos(
        [
          vuelo({ es_externo: true }),
          vuelo({ id: 'v-350', cliente_id: 'cli-interno' }),
          vuelo({ id: 'v-134', monto_total_usd: 0, calculo_snapshot: null }),
          vuelo({ id: undefined }),
        ],
        new Set(['cli-interno']),
      ),
    ).toEqual([]);
  });

  it('sin cliente y sin aeronave ⇒ entra (matrícula null después)', () => {
    const [c] = candidatosPrecierreInversos(
      [vuelo({ cliente_id: null, aeronave_id: null })],
      SIN_INTERNOS,
    );
    expect(c.aeronave_id).toBeNull();
  });

  it('TUA cobrada por la partición única: #11 (115.06) y #351 (100)', () => {
    const r = candidatosPrecierreInversos(
      [
        vuelo({
          id: 'v-11',
          folio: 11,
          monto_total_usd: 1000,
          calculo_snapshot: {
            desglose: [
              { clave: 'TIEMPO_VUELO', monto_usd: 884.94 },
              { clave: 'TUAS', monto_usd: 115.06 },
            ],
          },
        }),
        vuelo({
          id: 'v-351',
          folio: 351,
          monto_total_usd: 1100,
          calculo_snapshot: {
            desglose: [
              { clave: 'TIEMPO_VUELO', monto_usd: 1000 },
              { clave: 'TUAS', monto_usd: 100 },
            ],
          },
        }),
      ],
      SIN_INTERNOS,
    );
    expect(r.map((c) => c.tua_cobrada_usd)).toEqual([115.06, 100]);
  });

  it('pase_abordar solo con true estricto', () => {
    const r = candidatosPrecierreInversos(
      [
        vuelo({ id: 'a', pase_abordar: true }),
        vuelo({ id: 'b', pase_abordar: 'true' }),
      ],
      SIN_INTERNOS,
    );
    expect(r.map((c) => c.pase_abordar)).toEqual([true, false]);
  });
});

describe('extrasPactados', () => {
  it('el arreglo del snapshot gana', () => {
    expect(
      extrasPactados({
        calculo_snapshot: { extras: [{ concepto: 'Camionetas' }] },
        extras: [{ concepto: 'Otro' }],
      }),
    ).toEqual([{ concepto: 'Camionetas' }]);
  });
  it('sin snapshot (o sin arreglo) ⇒ vuelo.extras', () => {
    expect(
      extrasPactados({ calculo_snapshot: null, extras: [{ concepto: 'X' }] }),
    ).toEqual([{ concepto: 'X' }]);
    expect(
      extrasPactados({
        calculo_snapshot: { extras: 'no' },
        extras: [{ concepto: 'X' }],
      }),
    ).toEqual([{ concepto: 'X' }]);
  });
  it('nada ⇒ []', () => {
    expect(extrasPactados({})).toEqual([]);
    expect(extrasPactados({ calculo_snapshot: {}, extras: null })).toEqual([]);
  });
});

// ── Filas REALES de prod ───────────────────────────────────────────────────
/** #70 a6c189a6 (Mérida, ASUR) — forma a: «T.U.A. Nacional» neto + IVA 16 %. */
const G70A = {
  id: 'a6c189a6-8343-4c67-81d7-168aa6b8a12d',
  vuelo_id: 'v-70',
  categoria: 'OPERACIONES',
  monto: '1653.71',
  propina: '0.00',
  moneda: 'MXN',
  tua_incluida: null,
  valor_ia_extraido: {
    monto: 1653.71,
    conceptos: [
      { monto: 28.26, concepto: 'Aterrizaje/servicio (clave 210100)' },
      { monto: 1220.51, concepto: 'T.U.A. Nacional (clave 230700)' },
      {
        monto: 24.39,
        concepto: 'Plataforma de Embarque y Desembarque (clave 210200)',
      },
      { monto: 152.46, concepto: 'Servicio DELI (clave 231913)' },
      { monto: 228.09, concepto: 'IVA 16%' },
    ],
  },
};
/** #70 80e94f4e (Campeche, Banjercito) — forma b: «TUA Nacional Campeche» con IVA. */
const G70B = {
  id: '80e94f4e-c2c6-4838-9d31-0b6119a215ef',
  vuelo_id: 'v-70',
  categoria: 'OPERACIONES',
  monto: '1357.33',
  propina: '0.00',
  moneda: 'MXN',
  tua_incluida: null,
  valor_ia_extraido: {
    monto: 1357.33,
    conceptos: [
      { monto: 417.73, concepto: 'Serv Aerop Campeche' },
      { monto: 939.6, concepto: 'TUA Nacional Campeche' },
    ],
  },
};
/** #125 f0eb8b15 (Cozumel). */
const G125 = {
  id: 'f0eb8b15-442a-45ee-8bbd-1de430b04286',
  vuelo_id: 'v-125',
  categoria: 'OPERACIONES',
  monto: '556.31',
  propina: '0.00',
  moneda: 'MXN',
  tua_incluida: null,
  valor_ia_extraido: {
    monto: 556.31,
    conceptos: [
      { monto: 64.22, concepto: 'Aterrizaje (clave 210100)' },
      { monto: 371.11, concepto: 'T.U.A. Nacional (clave 230700)' },
      {
        monto: 44.24,
        concepto: 'Plataforma de Embarque y Desembarque (clave 210200)',
      },
      { monto: 76.74, concepto: 'IVA 16%' },
    ],
  },
};
/** #154 b3053271 (Cancún): la factura ENTERA es TUA. */
const G154 = {
  id: 'b3053271-d0a5-4a12-89b4-28e65fe1b3c8',
  vuelo_id: 'v-154',
  categoria: 'OPERACIONES',
  monto: '756.48',
  propina: '0.00',
  moneda: 'MXN',
  tua_incluida: null,
  valor_ia_extraido: {
    monto: 756.48,
    conceptos: [
      { monto: 652.14, concepto: 'T.U.A. Nacional (clave 230700)' },
      { monto: 104.34, concepto: 'IVA 16%' },
    ],
  },
};
/** #45 514a4b31: `monto` 345.19 (SIN la TUA) vs conceptos 1,858.14 ⇒ no cuadra. */
const G45A = {
  id: '514a4b31-7d50-4d3f-acf4-2c4ca6895e71',
  vuelo_id: 'v-45',
  categoria: 'OPERACIONES',
  monto: '345.19',
  propina: '0.00',
  moneda: 'MXN',
  tua_incluida: null,
  valor_ia_extraido: {
    monto: 1858.14,
    conceptos: [
      { monto: 51.23, concepto: 'Aterrizaje (clave 210100)' },
      { monto: 187.11, concepto: 'Plataforma de Pernocta (clave 210300)' },
      { monto: 1304.27, concepto: 'T.U.A. Nacional (clave 230700)' },
      {
        monto: 59.23,
        concepto: 'Plataforma de Embarque y Desembarque (clave 210200)',
      },
      { monto: 256.3, concepto: 'IVA 16%' },
    ],
  },
};
/** #45 df7e8afe: `monto` 528.48 vs conceptos 1,647.74 ⇒ no cuadra. */
const G45B = {
  id: 'df7e8afe-9c0f-48d0-9aeb-dbe39896377d',
  vuelo_id: 'v-45',
  categoria: 'OPERACIONES',
  monto: '528.48',
  propina: '0.00',
  moneda: 'MXN',
  tua_incluida: null,
  valor_ia_extraido: {
    monto: 1647.74,
    conceptos: [
      { monto: 528.48, concepto: 'Operaciones' },
      { monto: 1119.26, concepto: 'Tarifa TUA' },
    ],
  },
};
/** #13 72333d67: conceptos 752.51 vs monto 522.27 ⇒ no cuadra. */
const G13 = {
  id: '72333d67-b3ae-4dbb-972b-8628b18628d6',
  vuelo_id: 'v-13',
  categoria: 'OPERACIONES',
  monto: '522.27',
  propina: '0.00',
  moneda: 'MXN',
  tua_incluida: null,
  valor_ia_extraido: {
    monto: 1081.9,
    conceptos: [
      { monto: 20.6, concepto: 'Aterrizaje' },
      { monto: 33.52, concepto: 'Plataforma de embarque y desembarque' },
      { monto: 46.24, concepto: 'Estacionamiento Prolongado' },
      { monto: 13.02, concepto: 'Pernocta' },
      { monto: 482.44, concepto: 'TUA' },
      { monto: 7.46, concepto: 'E.R.P.E' },
      { monto: 149.23, concepto: 'IVA 16%' },
    ],
  },
};

describe('tuaPagadaPorVuelo (fuente única trasladosPagadosDeGasto)', () => {
  it('#70: forma a (1415.79) + forma b (939.60) ⇒ 2355.39 MXN en 2 gastos', () => {
    expect(tuaPagadaPorVuelo([G70A, G70B]).get('v-70')).toEqual({
      mxn: 2355.39,
      usd: 0,
      n: 2,
    });
  });

  it('#125 ⇒ 430.49; #154 ⇒ 756.48 (la factura entera)', () => {
    const m = tuaPagadaPorVuelo([G125, G154]);
    expect(m.get('v-125')).toEqual({ mxn: 430.49, usd: 0, n: 1 });
    expect(m.get('v-154')).toEqual({ mxn: 756.48, usd: 0, n: 1 });
  });

  it('#45 y #13: la tabla de la IA NO cuadra con el monto ⇒ Operación no pagó TUA', () => {
    const m = tuaPagadaPorVuelo([G45A, G45B, G13]);
    expect(m.has('v-45')).toBe(false);
    expect(m.has('v-13')).toBe(false);
  });

  it('gasto TUAS ⇒ el monto ENTERO', () => {
    expect(
      tuaPagadaPorVuelo([
        { vuelo_id: 'v-1', categoria: 'TUAS', monto: '1800', moneda: 'MXN' },
      ]).get('v-1'),
    ).toEqual({ mxn: 1800, usd: 0, n: 1 });
  });

  it('oficina: tua_incluida 0 anula la lectura; 300 sin conceptos ⇒ 300', () => {
    const op = {
      vuelo_id: 'v-1',
      categoria: 'OPERACIONES',
      monto: '1925.27',
      propina: '0.00',
      moneda: 'MXN',
    };
    const ASUR = {
      conceptos: [
        { concepto: 'Operaciones', monto: 1365.64 },
        { concepto: 'Tarifa TUA', monto: 559.63 },
      ],
    };
    expect(
      tuaPagadaPorVuelo([{ ...op, valor_ia_extraido: ASUR }]).get('v-1'),
    ).toEqual({ mxn: 559.63, usd: 0, n: 1 });
    expect(
      tuaPagadaPorVuelo([
        { ...op, valor_ia_extraido: ASUR, tua_incluida: '0' },
      ]).has('v-1'),
    ).toBe(false);
    expect(
      tuaPagadaPorVuelo([{ ...op, tua_incluida: '300' }]).get('v-1'),
    ).toEqual({ mxn: 300, usd: 0, n: 1 });
  });

  it('OTRO con conceptos TUA ⇒ 0 (es de la empresa)', () => {
    expect(
      tuaPagadaPorVuelo([{ ...G154, categoria: 'OTRO' }]).has('v-154'),
    ).toBe(false);
  });

  it('gasto en USD ⇒ cuenta en usd, nunca se suma con MXN', () => {
    expect(
      tuaPagadaPorVuelo([
        { vuelo_id: 'v-1', categoria: 'TUAS', monto: 50, moneda: 'USD' },
        { vuelo_id: 'v-1', categoria: 'TUAS', monto: 1000, moneda: 'MXN' },
      ]).get('v-1'),
    ).toEqual({ mxn: 1000, usd: 50, n: 2 });
  });

  it('sin vuelo_id ⇒ nada', () => {
    expect(
      tuaPagadaPorVuelo([{ vuelo_id: null, categoria: 'TUAS', monto: 80 }])
        .size,
    ).toBe(0);
  });
});

describe('vuelosConTuaPagadaSinCobrar', () => {
  const matriculas = new Map([
    ['av-vgv', 'XA-VGV'],
    ['av-58', 'N58BT'],
  ]);

  it('estreno de prod: #70 (2 facturas), #125 y #154 (pase de abordar); #45 fuera', () => {
    const candidatos = candidatosPrecierreInversos(
      [
        vuelo(),
        vuelo({
          id: 'v-125',
          folio: 125,
          fecha_vuelo: '2026-08-07T15:00:00+00:00',
          aeronave_id: 'av-58',
        }),
        vuelo({
          id: 'v-154',
          folio: 154,
          fecha_vuelo: '2026-08-15T15:00:00+00:00',
          pase_abordar: true,
        }),
        vuelo({ id: 'v-45', folio: 45, fecha_vuelo: '2026-07-14T15:00:00Z' }),
      ],
      SIN_INTERNOS,
    );
    const r = vuelosConTuaPagadaSinCobrar({
      candidatos,
      gastos: [G70A, G70B, G125, G154, G45A, G45B],
      matriculas,
    });
    expect(r).toEqual([
      {
        id: 'v-70',
        folio: 70,
        fecha_vuelo: '2026-07-23T15:00:00+00:00',
        matricula: 'XA-VGV',
        tua_pagada_mxn: 2355.39,
        tua_pagada_usd: 0,
        pase_abordar: false,
        gastos_n: 2,
      },
      {
        id: 'v-125',
        folio: 125,
        fecha_vuelo: '2026-08-07T15:00:00+00:00',
        matricula: 'N58BT',
        tua_pagada_mxn: 430.49,
        tua_pagada_usd: 0,
        pase_abordar: false,
        gastos_n: 1,
      },
      {
        id: 'v-154',
        folio: 154,
        fecha_vuelo: '2026-08-15T15:00:00+00:00',
        matricula: 'XA-VGV',
        tua_pagada_mxn: 756.48,
        tua_pagada_usd: 0,
        pase_abordar: true,
        gastos_n: 1,
      },
    ]);
  });

  it('con TUA cobrada (#11) ⇒ fuera aunque haya TUA pagada', () => {
    const candidatos = candidatosPrecierreInversos(
      [
        vuelo({
          id: 'v-11',
          folio: 11,
          monto_total_usd: 1000,
          calculo_snapshot: {
            desglose: [
              { clave: 'TIEMPO_VUELO', monto_usd: 884.94 },
              { clave: 'TUAS', monto_usd: 115.06 },
            ],
          },
        }),
      ],
      SIN_INTERNOS,
    );
    expect(
      vuelosConTuaPagadaSinCobrar({
        candidatos,
        gastos: [{ ...G154, vuelo_id: 'v-11' }],
        matriculas,
      }),
    ).toEqual([]);
  });

  it('matrícula null si no resuelve; orden por fecha, folio y sin fecha al final', () => {
    const tuas = (id: string) => ({
      vuelo_id: id,
      categoria: 'TUAS',
      monto: 100,
      moneda: 'MXN',
    });
    const candidatos = candidatosPrecierreInversos(
      [
        vuelo({ id: 'v-9', folio: 9, fecha_vuelo: null }),
        vuelo({ id: 'v-3', folio: 3, fecha_vuelo: '2026-07-10T15:00:00Z' }),
        vuelo({
          id: 'v-2',
          folio: 2,
          fecha_vuelo: '2026-07-10T15:00:00Z',
          aeronave_id: 'av-x',
        }),
        vuelo({ id: 'v-1', folio: 1, fecha_vuelo: '2026-07-20T15:00:00Z' }),
      ],
      SIN_INTERNOS,
    );
    const r = vuelosConTuaPagadaSinCobrar({
      candidatos,
      gastos: ['v-9', 'v-3', 'v-2', 'v-1'].map(tuas),
      matriculas,
    });
    expect(r.map((v) => v.folio)).toEqual([2, 3, 1, 9]);
    expect(r[0].matricula).toBeNull();
  });

  it('textos exactos', () => {
    expect(CLAVE_PRECIERRE_TUA_PAGADA_SIN_COBRAR).toBe('tua_pagada_sin_cobrar');
    expect(TITULO_PRECIERRE_TUA_PAGADA_SIN_COBRAR).toBe(
      'Vuelos con TUA pagada por Operación sin TUA cobrada al cliente',
    );
    expect(DETALLE_PRECIERRE_TUA_PAGADA_SIN_COBRAR).toBe(
      'Vuelos completados del periodo cuya cotización NO cobra TUA (tarifa de uso de aeropuerto) y que sí tienen un gasto que la paga: un gasto «TUAS» o una factura de aeropuerto con la TUA separada (leída por la IA o capturada en «TUA incluida en este gasto»). Operación pagó una TUA que no se le cobró al cliente: abre la cotización y enciende «Se cobran TUAS» (o agrégala como extra). Si el pasajero compró su pase de abordar y pagó su propia TUA, revisa la factura en Gastos → «Verificar / editar» (una TUA ahí sería cobro doble o una lectura mal etiquetada). Montos: TUA pagada con IVA, en la moneda del gasto. No bloquea el cierre.',
    );
    expect(DETALLE_PRECIERRE_TUA_PAGADA_SIN_COBRAR_FALLIDA).toBe(
      'No se pudo verificar la TUA pagada de los vuelos del periodo: revisa las facturas de aeropuerto en Gastos y las cotizaciones sin TUAS antes de cerrar.',
    );
  });
});
