import {
  avisoAvionOcupado,
  rangoDiasCancun,
  vuelosQueOcupanAvion,
} from './avion-ocupado.util';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('vuelosQueOcupanAvion', () => {
  const rows = [
    // Avión A a nivel vuelo, tramos heredan → ocupa A.
    {
      id: 'v1',
      folio: 101,
      estado: 'CONFIRMADO',
      aeronave_id: A,
      fecha_vuelo: '2026-09-10T13:00:00Z',
      escalas: [
        { aeronave_id: null, cancelada_at: null },
        { aeronave_id: null, cancelada_at: null },
      ],
    },
    // Avión B a nivel vuelo, pero un tramo vivo va en A → ocupa A.
    {
      id: 'v2',
      folio: 102,
      estado: 'COTIZADO',
      aeronave_id: B,
      fecha_vuelo: '2026-09-10T15:00:00Z',
      escalas: [
        { aeronave_id: null, cancelada_at: null },
        { aeronave_id: A, cancelada_at: null },
      ],
    },
    // Avión A a nivel vuelo, pero TODOS los tramos vivos van en B → NO ocupa A.
    {
      id: 'v3',
      folio: 103,
      estado: 'CONFIRMADO',
      aeronave_id: A,
      fecha_vuelo: '2026-09-10T16:00:00Z',
      escalas: [
        { aeronave_id: B, cancelada_at: null },
        { aeronave_id: A, cancelada_at: '2026-09-01T00:00:00Z' },
      ],
    },
    // Cancelado: fuera.
    {
      id: 'v4',
      folio: 104,
      estado: 'CANCELADO',
      aeronave_id: A,
      fecha_vuelo: '2026-09-10T17:00:00Z',
      escalas: [],
    },
    // Sin tramos: decide el avión del vuelo.
    {
      id: 'v5',
      folio: 105,
      estado: 'RESERVA',
      aeronave_id: A,
      fecha_vuelo: '2026-09-10T18:00:00Z',
      escalas: null,
    },
  ];

  it('resuelve el avión por tramo con herencia y excluye cancelados', () => {
    const r = vuelosQueOcupanAvion(rows, A);
    expect(r.map((v) => v.id)).toEqual(['v1', 'v2', 'v5']);
  });

  it('excluye el vuelo que se está editando', () => {
    const r = vuelosQueOcupanAvion(rows, A, 'v1');
    expect(r.map((v) => v.id)).toEqual(['v2', 'v5']);
  });

  it('otro avión: el que lo hereda en un tramo vivo (v2) y el que lo lleva explícito (v3)', () => {
    expect(vuelosQueOcupanAvion(rows, B).map((v) => v.id)).toEqual([
      'v2',
      'v3',
    ]);
  });
});

describe('rangoDiasCancun', () => {
  it('corta en día CANCÚN (22:30 Cancún del 10 = 03:30Z del 11)', () => {
    const r = rangoDiasCancun('2026-09-11T03:30:00Z');
    expect(r).toEqual({ desde: '2026-09-10', hasta: '2026-09-10' });
  });

  it('multi-día: hasta = fecha_fin; nunca antes de desde', () => {
    expect(
      rangoDiasCancun('2026-09-10T13:00:00Z', '2026-09-12T20:00:00Z'),
    ).toEqual({ desde: '2026-09-10', hasta: '2026-09-12' });
    expect(
      rangoDiasCancun('2026-09-10T13:00:00Z', '2026-09-09T20:00:00Z'),
    ).toEqual({ desde: '2026-09-10', hasta: '2026-09-10' });
  });
});

describe('avisoAvionOcupado', () => {
  it('null sin ocupados; texto con folios y día Cancún', () => {
    expect(avisoAvionOcupado('XB-ANU', [])).toBeNull();
    const t = avisoAvionOcupado('XB-ANU', [
      {
        id: 'v1',
        folio: 101,
        aeronave_id: A,
        fecha_vuelo: '2026-09-11T03:30:00Z',
      },
    ]);
    expect(t).toContain('XB-ANU');
    expect(t).toContain('#101');
    // 03:30Z del 11 es todavía el 10 en Cancún.
    expect(t).toMatch(/10 sept?/);
  });
});
