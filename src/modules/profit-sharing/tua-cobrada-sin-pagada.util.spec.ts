import {
  CLAVE_PRECIERRE_TUA_COBRADA_SIN_PAGADA,
  DETALLE_PRECIERRE_TUA_COBRADA_SIN_PAGADA,
  DETALLE_PRECIERRE_TUA_COBRADA_SIN_PAGADA_FALLIDA,
  TITULO_PRECIERRE_TUA_COBRADA_SIN_PAGADA,
  candidatosTuaCobrada,
  vuelosConTuaCobradaSinPagada,
  vuelosConTuaPagada,
  type VueloTuaCobradaRow,
} from './tua-cobrada-sin-pagada.util';

/**
 * PRE-CIERRE «Vuelos con TUA cobrada al cliente sin TUA pagada»
 * (13-oct-2026, TUA sistémica, invariante 66): universo por la partición
 * ÚNICA del ingreso y TUA pagada por la fuente única `tuaPagadaDeGasto`.
 */
function vuelo(extra: Partial<VueloTuaCobradaRow> = {}): VueloTuaCobradaRow {
  return {
    id: 'v-1',
    folio: 383,
    fecha_vuelo: '2026-10-06T15:00:00+00:00',
    aeronave_id: 'av-1',
    es_externo: false,
    monto_total_usd: 1000,
    calculo_snapshot: {
      desglose: [
        { clave: 'TIEMPO_VUELO', monto_usd: 900 },
        { clave: 'TUAS', monto_usd: 25 },
        { clave: 'TUAS', monto_usd: 75 },
      ],
    },
    ...extra,
  };
}

describe('candidatosTuaCobrada (partición única del ingreso)', () => {
  it('snapshot con dos líneas TUAS (25 + 75) ⇒ 100 USD', () => {
    expect(candidatosTuaCobrada([vuelo()])).toEqual([
      {
        id: 'v-1',
        folio: 383,
        fecha_vuelo: '2026-10-06T15:00:00+00:00',
        aeronave_id: 'av-1',
        tua_cobrada_usd: 100,
      },
    ]);
  });

  it('sin snapshot: la columna tuas_usd (50) cuando las columnas cuadran', () => {
    const v = vuelo({
      calculo_snapshot: null,
      subtotal_vuelo_usd: 950,
      tuas_usd: 50,
    });
    expect(candidatosTuaCobrada([v])[0].tua_cobrada_usd).toBe(50);
  });

  it('externo, sin TUAS y sin id ⇒ fuera', () => {
    expect(
      candidatosTuaCobrada([
        vuelo({ es_externo: true }),
        vuelo({
          id: 'v-2',
          calculo_snapshot: {
            desglose: [{ clave: 'TIEMPO_VUELO', monto_usd: 1000 }],
          },
        }),
        vuelo({ id: undefined }),
      ]),
    ).toEqual([]);
  });

  it('partición INCONSISTENTE con líneas TUAS ⇒ DENTRO (otros movimientos también las lista)', () => {
    const v = vuelo({ monto_total_usd: 1100 });
    expect(candidatosTuaCobrada([v]).map((c) => c.tua_cobrada_usd)).toEqual([
      100,
    ]);
  });
});

describe('vuelosConTuaPagada (tuaPagadaDeGasto, existencia)', () => {
  const op = (extra: Record<string, unknown>) => ({
    vuelo_id: 'v-1',
    categoria: 'OPERACIONES',
    monto: '1925.27',
    propina: '0.00',
    ...extra,
  });
  const ASUR = {
    conceptos: [
      { concepto: 'Operaciones', monto: 1365.64 },
      { concepto: 'Tarifa TUA', monto: 559.63 },
    ],
  };
  const C383 = {
    conceptos: [
      { concepto: 'Operaciones', monto: 1365.64 },
      { concepto: 'Autobuses', monto: 559.63 },
    ],
  };

  it.each([
    ['gasto TUAS 80', { categoria: 'TUAS', monto: '80' }, true],
    [
      'OPERACIONES con «Tarifa TUA» que cuadra',
      { valor_ia_extraido: ASUR },
      true,
    ],
    [
      'la misma con TUA de oficina 0',
      { valor_ia_extraido: ASUR, tua_incluida: '0' },
      false,
    ],
    ['sin conceptos + oficina 300', { tua_incluida: '300' }, true],
    ['#383 «Autobuses» sin señal', { valor_ia_extraido: C383 }, false],
    [
      '#383 con tua_monto',
      { valor_ia_extraido: { ...C383, tua_monto: 559.63 } },
      true,
    ],
    [
      'OTRO con TUA (es de la empresa)',
      { categoria: 'OTRO', valor_ia_extraido: ASUR },
      false,
    ],
  ])('%s ⇒ %p', (_n, extra, esperado) => {
    expect(vuelosConTuaPagada([op(extra)]).has('v-1')).toBe(esperado);
  });

  it('sin vuelo_id no cuenta', () => {
    expect(
      vuelosConTuaPagada([{ categoria: 'TUAS', monto: 80, vuelo_id: null }])
        .size,
    ).toBe(0);
  });
});

describe('vuelosConTuaCobradaSinPagada', () => {
  it('quita los pagados, resuelve la matrícula y ordena por fecha (folio de desempate, sin fecha al final)', () => {
    const candidatos = candidatosTuaCobrada([
      vuelo({ id: 'v-417', folio: 417, fecha_vuelo: '2026-10-20T15:00:00Z' }),
      vuelo({ id: 'v-384', folio: 384, fecha_vuelo: '2026-10-08T15:00:00Z' }),
      vuelo({
        id: 'v-386',
        folio: 386,
        fecha_vuelo: '2026-10-08T15:00:00Z',
        aeronave_id: 'av-x',
      }),
      vuelo({ id: 'v-385', folio: 385, fecha_vuelo: '2026-10-08T15:00:00Z' }),
      vuelo({ id: 'v-sin', folio: 300, fecha_vuelo: null }),
      vuelo({
        id: 'v-pagado',
        folio: 390,
        fecha_vuelo: '2026-10-01T15:00:00Z',
      }),
    ]);
    const r = vuelosConTuaCobradaSinPagada({
      candidatos,
      vuelosConTuaPagada: new Set(['v-pagado']),
      matriculas: new Map([['av-1', 'XA-VGV']]),
    });
    expect(r.map((v) => v.folio)).toEqual([384, 385, 386, 417, 300]);
    expect(r[0]).toEqual({
      id: 'v-384',
      folio: 384,
      fecha_vuelo: '2026-10-08T15:00:00Z',
      matricula: 'XA-VGV',
      tua_cobrada_usd: 100,
    });
    expect(r.find((v) => v.folio === 386)?.matricula).toBeNull();
  });

  it('textos exactos', () => {
    expect(CLAVE_PRECIERRE_TUA_COBRADA_SIN_PAGADA).toBe(
      'tua_cobrada_sin_pagada',
    );
    expect(TITULO_PRECIERRE_TUA_COBRADA_SIN_PAGADA).toBe(
      'Vuelos con TUA cobrada al cliente sin TUA pagada',
    );
    expect(DETALLE_PRECIERRE_TUA_COBRADA_SIN_PAGADA).toBe(
      'Vuelos completados del periodo cuya cotización cobró TUA (tarifa de uso de aeropuerto) y que no tienen ningún gasto que la pague: ni un gasto «TUAS» ni una factura de aeropuerto con la TUA separada (leída por la IA o capturada en «TUA incluida en este gasto»). Si la TUA venía dentro de la factura del aeropuerto, hoy se está cargando al avión como operación: ábrela en Gastos → «Verificar / editar» y captura la TUA incluida; si se pagó aparte, captura el gasto TUAS en el vuelo. Montos: TUA cobrada sin IVA, en USD. No bloquea el cierre.',
    );
    expect(DETALLE_PRECIERRE_TUA_COBRADA_SIN_PAGADA_FALLIDA).toBe(
      'No se pudo verificar la TUA pagada de los vuelos del periodo: revisa los gastos de aeropuerto y «Otros movimientos» del Balance general antes de cerrar.',
    );
  });
});
