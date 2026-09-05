import {
  apoyosTramoConNombre,
  nombresUnicos,
  resumirEscalasPorVuelo,
  textosDeJson,
  tripulacionNombres,
  unwrapRel,
  type InfoUsuarios,
} from './busqueda-vuelo.util';

const V1 = 'vuelo-1';
const V2 = 'vuelo-2';
const PIL_A = 'usr-a';
const PIL_B = 'usr-b';
const COP_C = 'usr-c';
const APO_D = 'usr-d';

const info: InfoUsuarios = new Map([
  [PIL_A, { id: PIL_A, nombre: 'Andrés Boas', rol: 'PILOTO' }],
  [PIL_B, { id: PIL_B, nombre: 'Bruno López', rol: 'PILOTO' }],
  [COP_C, { id: COP_C, nombre: 'Carla Ruiz', rol: 'PILOTO' }],
  [APO_D, { id: APO_D, nombre: 'Diego Mena', rol: 'MECANICO' }],
]);

describe('nombresUnicos / textosDeJson', () => {
  it('recorta, descarta vacíos y no-strings y deduplica sin mayúsculas', () => {
    expect(
      nombresUnicos(
        ['  Juan  Pérez ', 'juan pérez', '', null, 7, 'Ana'],
        ['ANA', 'Luis'],
      ),
    ).toEqual(['Juan Pérez', 'Ana', 'Luis']);
  });

  it('tolera listas nulas y jsonb mal formado', () => {
    expect(nombresUnicos(null, undefined)).toEqual([]);
    expect(textosDeJson('Juan')).toEqual([]);
    expect(textosDeJson({ a: 1 })).toEqual([]);
    expect(textosDeJson(['Boas', 'boas ', 2])).toEqual(['Boas']);
  });
});

describe('unwrapRel', () => {
  it('objeto, arreglo de uno, arreglo vacío y null', () => {
    expect(unwrapRel({ nombre: 'x' })).toEqual({ nombre: 'x' });
    expect(unwrapRel([{ nombre: 'y' }])).toEqual({ nombre: 'y' });
    expect(unwrapRel([])).toBeNull();
    expect(unwrapRel(null)).toBeNull();
    expect(unwrapRel(undefined)).toBeNull();
  });
});

describe('resumirEscalasPorVuelo', () => {
  it('ruta completa (ferry y cancelados incluidos), manifiesto y notas por tramo, ids explícitos', () => {
    const r = resumirEscalasPorVuelo([
      // Desordenadas a propósito: el orden de tramo manda.
      {
        vuelo_id: V1,
        orden: 2,
        origen_iata: 'HOL',
        destino_iata: 'CUN',
        piloto_id: null,
        copiloto_id: COP_C,
        pasajeros_nombres: ['Familia Boas', 'ana'],
        notas: '  Regreso con equipaje extra ',
        cancelada_at: '2026-09-01T00:00:00Z',
      },
      {
        vuelo_id: V1,
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'HOL',
        piloto_id: PIL_B,
        copiloto_id: null,
        pasajeros_nombres: ['Ana', 'Pedro'],
        notas: null,
        cancelada_at: null,
      },
      {
        vuelo_id: V1,
        orden: 3,
        origen_iata: 'CUN',
        destino_iata: 'CZM',
        piloto_id: PIL_B,
        copiloto_id: COP_C,
        pasajeros_nombres: 'mal formado',
        notas: '',
      },
      {
        vuelo_id: V2,
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'MID',
      },
    ]);
    expect(r.get(V1)).toEqual({
      ruta_iatas: ['CUN', 'HOL', 'CUN', 'CZM'],
      pasajeros_nombres_tramos: ['Ana', 'Pedro', 'Familia Boas'],
      notas_tramos: ['Regreso con equipaje extra'],
      piloto_ids: [PIL_B],
      copiloto_ids: [COP_C],
    });
    expect(r.get(V2)).toEqual({
      ruta_iatas: ['CUN', 'MID'],
      pasajeros_nombres_tramos: [],
      notas_tramos: [],
      piloto_ids: [],
      copiloto_ids: [],
    });
  });

  it('sin escalas → mapa vacío; filas sin vuelo_id se ignoran', () => {
    expect(resumirEscalasPorVuelo([]).size).toBe(0);
    expect(
      resumirEscalasPorVuelo([
        { vuelo_id: '', orden: 1, origen_iata: 'CUN', destino_iata: 'HOL' },
      ]).size,
    ).toBe(0);
  });
});

describe('apoyosTramoConNombre', () => {
  it('solo filas con escala_id, en orden de alta, sin repetir y con respaldo', () => {
    const r = apoyosTramoConNombre(
      [
        { escala_id: null, usuario_id: APO_D, created_at: '2026-09-01' },
        { escala_id: 'esc-2', usuario_id: APO_D, created_at: '2026-09-03' },
        { escala_id: 'esc-1', usuario_id: 'usr-x', created_at: '2026-09-02' },
        { escala_id: 'esc-2', usuario_id: APO_D, created_at: '2026-09-04' },
      ],
      info,
    );
    expect(r).toEqual([
      { id: 'usr-x', nombre: 'Usuario', rol: null, escala_id: 'esc-1' },
      { id: APO_D, nombre: 'Diego Mena', rol: 'MECANICO', escala_id: 'esc-2' },
    ]);
  });
});

describe('tripulacionNombres', () => {
  it('une piloto, copiloto, apoyos y tramos sin duplicar; omite ids sin usuario', () => {
    expect(
      tripulacionNombres({
        piloto_nombre: 'Andrés Boas',
        copiloto_nombre: null,
        apoyoIds: [APO_D, 'usr-desconocido'],
        tramoIds: [PIL_A, PIL_B, COP_C],
        info,
      }),
    ).toEqual(['Andrés Boas', 'Diego Mena', 'Bruno López', 'Carla Ruiz']);
  });

  it('sin nada → []', () => {
    expect(tripulacionNombres({ info: new Map() })).toEqual([]);
  });
});
