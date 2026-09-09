import {
  filtrarPosiblesDuplicados,
  resumirDuplicado,
  textoPosibleDuplicado,
  type ReservaCandidata,
  type VueloDuplicadoRow,
} from './posible-duplicado.util';

/**
 * Detector de posible duplicado (alta sin internet, 9-sep-2026): filtro
 * PURO sobre vuelos del mismo cliente en la misma ventana de días Cancún.
 * Regla: vivo, sin grupo, y (misma aeronave O mismo origen→destino del
 * tramo 1). Los falsos positivos conocidos de VuelaTour quedan fuera.
 */
const AVION_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const AVION_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

function vuelo(extra: Partial<VueloDuplicadoRow>): VueloDuplicadoRow {
  return {
    id: 'v-1',
    folio: 118,
    estado: 'RESERVA',
    aeronave_id: AVION_A,
    // 09:00 Cancún del lunes 14-sep-2026.
    fecha_vuelo: '2026-09-14T14:00:00+00:00',
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    grupo_id: null,
    escalas: [
      {
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'HOL',
        aeronave_id: null,
        cancelada_at: null,
      },
      {
        orden: 2,
        origen_iata: 'HOL',
        destino_iata: 'CUN',
        aeronave_id: null,
        cancelada_at: null,
      },
    ],
    aeronave: { matricula: 'XA-VGV' },
    piloto: { nombre: 'Juan' },
    grupo: null,
    ...extra,
  };
}

const NUEVA: ReservaCandidata = {
  aeronave_id: AVION_A,
  origen_iata: 'CUN',
  destino_iata: 'HOL',
};

describe('filtrarPosiblesDuplicados', () => {
  it('mismo avión (aunque la ruta cambie) → posible duplicado', () => {
    const r = filtrarPosiblesDuplicados(
      [vuelo({ origen_iata: 'CUN', destino_iata: 'CZM', escalas: [] })],
      NUEVA,
    );
    expect(r.map((v) => v.id)).toEqual(['v-1']);
  });

  it('misma ruta del tramo 1 con OTRO avión → posible duplicado', () => {
    const r = filtrarPosiblesDuplicados([vuelo({ aeronave_id: AVION_B })], {
      ...NUEVA,
      aeronave_id: AVION_A,
    });
    expect(r).toHaveLength(1);
  });

  it('la ruta se compara sin importar mayúsculas', () => {
    const r = filtrarPosiblesDuplicados([vuelo({ aeronave_id: AVION_B })], {
      aeronave_id: null,
      origen_iata: 'cun',
      destino_iata: 'hol',
    });
    expect(r).toHaveLength(1);
  });

  it('otro avión Y otra ruta → NO es duplicado (mismo cliente, mismo día)', () => {
    const r = filtrarPosiblesDuplicados(
      [
        vuelo({
          aeronave_id: AVION_B,
          escalas: [
            {
              orden: 1,
              origen_iata: 'CUN',
              destino_iata: 'CZM',
              aeronave_id: null,
              cancelada_at: null,
            },
          ],
        }),
      ],
      NUEVA,
    );
    expect(r).toEqual([]);
  });

  it('el tramo 1 EFECTIVO salta los tramos cancelados', () => {
    // Tramo 1 cancelado (CUN→CZM); el vivo es HOL→CUN: no coincide con la
    // nueva CUN→HOL, y el avión es otro → fuera.
    const r = filtrarPosiblesDuplicados(
      [
        vuelo({
          aeronave_id: AVION_B,
          escalas: [
            {
              orden: 1,
              origen_iata: 'CUN',
              destino_iata: 'HOL',
              aeronave_id: null,
              cancelada_at: '2026-09-10T00:00:00Z',
            },
            {
              orden: 2,
              origen_iata: 'HOL',
              destino_iata: 'CUN',
              aeronave_id: null,
              cancelada_at: null,
            },
          ],
        }),
      ],
      NUEVA,
    );
    expect(r).toEqual([]);
  });

  it('el avión del tramo 1 se resuelve CON herencia y también explícito', () => {
    // Vuelo con avión B a nivel vuelo pero el tramo 1 vuela en A.
    const r = filtrarPosiblesDuplicados(
      [
        vuelo({
          aeronave_id: AVION_B,
          origen_iata: 'CUN',
          destino_iata: 'CZM',
          escalas: [
            {
              orden: 1,
              origen_iata: 'CUN',
              destino_iata: 'CZM',
              aeronave_id: AVION_A,
              cancelada_at: null,
            },
          ],
        }),
      ],
      NUEVA,
    );
    expect(r).toHaveLength(1);
  });

  describe('falsos positivos excluidos a propósito', () => {
    it('vuelo CANCELADO', () => {
      expect(
        filtrarPosiblesDuplicados([vuelo({ estado: 'CANCELADO' })], NUEVA),
      ).toEqual([]);
    });

    it('hijo de GRUPO multi-avión (grupo_id)', () => {
      expect(
        filtrarPosiblesDuplicados([vuelo({ grupo_id: 'g-1' })], NUEVA),
      ).toEqual([]);
    });

    it('cliente INTERNO (vuelos de la empresa, varios por día)', () => {
      expect(
        filtrarPosiblesDuplicados([vuelo({})], {
          ...NUEVA,
          cliente_es_interno: true,
        }),
      ).toEqual([]);
    });

    it('cliente BROKER (revende varios vuelos el mismo día)', () => {
      expect(
        filtrarPosiblesDuplicados([vuelo({})], {
          ...NUEVA,
          cliente_es_broker: true,
        }),
      ).toEqual([]);
    });
  });

  it('sin avión en la nueva: solo la ruta decide', () => {
    const r = filtrarPosiblesDuplicados(
      [
        vuelo({}),
        vuelo({
          id: 'v-2',
          origen_iata: 'CUN',
          destino_iata: 'CZM',
          escalas: [],
        }),
      ],
      { aeronave_id: null, origen_iata: 'CUN', destino_iata: 'HOL' },
    );
    expect(r.map((v) => v.id)).toEqual(['v-1']);
  });
});

describe('resumirDuplicado / textoPosibleDuplicado', () => {
  it('arma «Posible duplicado: #118 · lun 14 sep 09:00 · CUN → HOL → CUN · XA-VGV» en hora Cancún', () => {
    const r = resumirDuplicado(vuelo({}));
    expect(r).toEqual({
      id: 'v-1',
      folio: 118,
      fecha_vuelo: '2026-09-14T14:00:00+00:00',
      hora: '09:00',
      ruta: 'CUN → HOL → CUN',
      aeronave_matricula: 'XA-VGV',
      piloto_nombre: 'Juan',
      grupo_folio: null,
    });
    expect(textoPosibleDuplicado(r)).toBe(
      'Posible duplicado: #118 · lun 14 sep 09:00 · CUN → HOL → CUN · XA-VGV',
    );
  });

  it('sin escalas usa origen/destino del vuelo; embeds en arreglo se desenvuelven', () => {
    const r = resumirDuplicado(
      vuelo({
        escalas: [],
        aeronave: [{ matricula: 'N990GG' }],
        piloto: [{ nombre: 'Luis' }],
        grupo: [{ folio: 12 }],
      }),
    );
    expect(r.ruta).toBe('CUN → HOL');
    expect(r.aeronave_matricula).toBe('N990GG');
    expect(r.piloto_nombre).toBe('Luis');
    expect(r.grupo_folio).toBe(12);
  });

  it('sin fecha ni matrícula no deja huecos en el texto', () => {
    const r = resumirDuplicado(
      vuelo({ fecha_vuelo: null, aeronave: null, escalas: [] }),
    );
    expect(textoPosibleDuplicado(r)).toBe(
      'Posible duplicado: #118 · CUN → HOL',
    );
  });
});
