import {
  CLAVE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR,
  DETALLE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR,
  DETALLE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR_FALLIDA,
  TITULO_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR,
  vuelosConTransportePagadoSinCotizar,
} from './transporte-pagado-sin-cotizar.util';
import type { VueloCandidatoInverso } from './tua-pagada-sin-cobrar.util';

/**
 * PRE-CIERRE «Vuelos con transporte pagado sin transporte cotizado»
 * (15-oct-2026, PEDIDO 4). Universo = `candidatosPrecierreInversos` (aquí
 * ya armado); la señal de texto vive en `common/transporte-pasajeros.util`.
 */
function cand(
  id: string,
  folio: number,
  extra: Partial<VueloCandidatoInverso> = {},
): VueloCandidatoInverso {
  return {
    id,
    folio,
    fecha_vuelo: '2026-08-20T15:00:00+00:00',
    aeronave_id: 'av-pev',
    pase_abordar: false,
    tua_cobrada_usd: 0,
    extras: [],
    ...extra,
  };
}

/** 66d575d8 (#190): «Transporte Chetumal a Carl's Jr», $400 MXN (real). */
const T190 = {
  id: '66d575d8-0000-0000-0000-000000000000',
  vuelo_id: 'v-190',
  categoria: 'TAXI',
  monto: '400.00',
  moneda: 'MXN',
  lugar: null,
  notas:
    "Costa Maya Transportes Turísticos S.A. · Transporte Chetumal a Carl's Jr\n\n[IA al sincronizar]",
  valor_ia_extraido: { proveedor: 'COSTA MAYA TRANSPORTES TURISTICOS S.A.' },
};

const matriculas = new Map([['av-pev', 'XB-PEV']]);

describe('vuelosConTransportePagadoSinCotizar', () => {
  it('sin extras y gasto de transporte ⇒ dentro con gastos[] (texto ≤ 60, monto, moneda)', () => {
    expect(
      vuelosConTransportePagadoSinCotizar({
        candidatos: [cand('v-190', 190)],
        gastos: [T190],
        matriculas,
      }),
    ).toEqual([
      {
        id: 'v-190',
        folio: 190,
        fecha_vuelo: '2026-08-20T15:00:00+00:00',
        matricula: 'XB-PEV',
        monto_mxn: 400,
        monto_usd: 0,
        gastos: [
          {
            id: '66d575d8-0000-0000-0000-000000000000',
            texto: "Transporte Chetumal a Carl's Jr",
            monto: 400,
            moneda: 'MXN',
          },
        ],
      },
    ]);
  });

  it('extra «Camionetas» (#154) ⇒ fuera aunque haya gasto de transporte', () => {
    expect(
      vuelosConTransportePagadoSinCotizar({
        candidatos: [
          cand('v-190', 190, { extras: [{ concepto: 'Camionetas' }] }),
        ],
        gastos: [T190],
        matriculas,
      }),
    ).toEqual([]);
  });

  it('un extra «Tour» NO cuenta como transporte cotizado', () => {
    expect(
      vuelosConTransportePagadoSinCotizar({
        candidatos: [cand('v-190', 190, { extras: [{ concepto: 'TOUR x2' }] })],
        gastos: [T190],
        matriculas,
      }),
    ).toHaveLength(1);
  });

  it('solo gastos que NO parecen transporte (Uber de la tripulación) ⇒ fuera', () => {
    expect(
      vuelosConTransportePagadoSinCotizar({
        candidatos: [cand('v-126', 126)],
        gastos: [
          {
            id: 'g1',
            vuelo_id: 'v-126',
            categoria: 'TAXI',
            monto: 150,
            moneda: 'MXN',
            notas: 'Uber a apto',
          },
        ],
        matriculas,
      }),
    ).toEqual([]);
  });

  it('gasto con monto ≤ 0 ⇒ no cuenta como pagado', () => {
    expect(
      vuelosConTransportePagadoSinCotizar({
        candidatos: [cand('v-190', 190)],
        gastos: [
          { ...T190, monto: '0' },
          { ...T190, id: 'g-neg', monto: '-400' },
        ],
        matriculas,
      }),
    ).toEqual([]);
  });

  it('varios gastos: por id asc; montos por moneda (MXN y USD separados, nunca sumados)', () => {
    const [v] = vuelosConTransportePagadoSinCotizar({
      candidatos: [cand('v-404', 404, { aeronave_id: null })],
      gastos: [
        {
          id: 'g-b',
          vuelo_id: 'v-404',
          categoria: 'TAXI',
          monto: '300',
          moneda: 'MXN',
          notas: 'Traslado privado al hotel del cliente',
        },
        {
          id: 'g-c',
          vuelo_id: 'v-404',
          categoria: 'TAXI',
          monto: '400',
          moneda: 'MXN',
          notas:
            'CITY TAXI, SAFE & FAST S.A. DE C.V. · Servicio de taxi privado, origen Aeropuerto Internacional de Chetumal, 1 pax',
        },
        {
          id: 'g-a',
          vuelo_id: 'v-404',
          categoria: 'OPERACIONES',
          monto: 50.5,
          moneda: 'USD',
          notas: 'Shuttle terminal 2',
        },
        {
          id: 'g-0',
          vuelo_id: 'v-404',
          categoria: 'TAXI',
          monto: '300',
          moneda: 'MXN',
          notas: 'Camioneta pasajeros',
        },
      ],
      matriculas,
    });
    // «Traslado … hotel» se veta (falso negativo aceptado).
    expect(v.gastos.map((g) => g.id)).toEqual(['g-0', 'g-a', 'g-c']);
    expect(v.monto_mxn).toBe(700);
    expect(v.monto_usd).toBe(50.5);
    expect(v.matricula).toBeNull();
    expect(v.gastos[2].texto).toBe(
      'Servicio de taxi privado, origen Aeropuerto Internacional d…',
    );
  });

  it('gastos de vuelos fuera del universo no se listan; orden fecha/folio/sin fecha al final', () => {
    const g = (id: string, vueloId: string) => ({
      ...T190,
      id,
      vuelo_id: vueloId,
    });
    const r = vuelosConTransportePagadoSinCotizar({
      candidatos: [
        cand('v-9', 9, { fecha_vuelo: null }),
        cand('v-5', 5, { fecha_vuelo: '2026-09-28T15:00:00Z' }),
        cand('v-4', 4, { fecha_vuelo: '2026-09-28T15:00:00Z' }),
        cand('v-1', 1, { fecha_vuelo: '2026-07-01T15:00:00Z' }),
      ],
      gastos: [
        g('a', 'v-9'),
        g('b', 'v-5'),
        g('c', 'v-4'),
        g('d', 'v-1'),
        g('e', 'v-fuera'),
      ],
      matriculas,
    });
    expect(r.map((v) => v.folio)).toEqual([1, 4, 5, 9]);
  });

  it('textos exactos', () => {
    expect(CLAVE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR).toBe(
      'transporte_pagado_sin_cotizar',
    );
    expect(TITULO_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR).toBe(
      'Vuelos con transporte pagado sin transporte cotizado',
    );
    expect(DETALLE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR).toBe(
      'Es una SEÑAL, no una certeza: vuelos completados del periodo con un gasto que parece transporte de PASAJEROS (traslado, transfer, camioneta, taxi privado…) y una cotización sin ningún extra de transporte. Revisa si se cobró: si no, agrégalo como extra en la cotización o anótalo en el detalle del vuelo → «Seguimiento de la cotización» para cobrarlo después. Los traslados de la tripulación (Uber, ADO, estacionamiento, ferry, tren) no cuentan. Montos: lo pagado, en la moneda del gasto. No bloquea el cierre.',
    );
    expect(DETALLE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR_FALLIDA).toBe(
      'No se pudo verificar los transportes pagados de los vuelos del periodo: revisa los gastos «Taxi / estacionamiento» de cada vuelo contra su cotización antes de cerrar.',
    );
  });
});
