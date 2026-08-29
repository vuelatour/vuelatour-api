import {
  apoyosEfectivosDeTramo,
  apoyosNivelVuelo,
  copilotoEfectivo,
  miTripulacion,
  pilotoEfectivo,
  type VueloApoyoRow,
} from './tripulacion.util';

const PIL = 'pil00000-0000-0000-0000-000000000001';
const COP = 'cop00000-0000-0000-0000-000000000002';
const APO = 'apo00000-0000-0000-0000-000000000003';
const APO2 = 'apo00000-0000-0000-0000-000000000004';
const ROT = 'rot00000-0000-0000-0000-000000000005';
const E1 = 'esc00000-0000-0000-0000-000000000011';
const E2 = 'esc00000-0000-0000-0000-000000000012';
const E3 = 'esc00000-0000-0000-0000-000000000013';

const vuelo = { piloto_id: PIL, copiloto_id: COP, apoyo_id: APO };
const escalas = [
  { id: E1, piloto_id: null, copiloto_id: null, cancelada_at: null },
  // Rotación: en el regreso vuela ROT y el copiloto cambia a PIL.
  { id: E2, piloto_id: ROT, copiloto_id: PIL, cancelada_at: null },
  { id: E3, piloto_id: null, copiloto_id: null, cancelada_at: '2026-08-01' },
];
const apoyos: VueloApoyoRow[] = [
  { escala_id: null, usuario_id: APO, created_at: '2026-08-01T00:00:00Z' },
  { escala_id: E2, usuario_id: APO2, created_at: '2026-08-02T00:00:00Z' },
];

describe('herencia piloto/copiloto', () => {
  it('el tramo sin copiloto propio hereda el del vuelo', () => {
    expect(copilotoEfectivo(escalas[0], vuelo)).toBe(COP);
    expect(copilotoEfectivo(escalas[1], vuelo)).toBe(PIL);
    expect(pilotoEfectivo(escalas[1], vuelo)).toBe(ROT);
    expect(copilotoEfectivo({ copiloto_id: null }, null)).toBeNull();
  });
});

describe('apoyos', () => {
  it('nivel vuelo en orden de alta y efectivos por tramo (vuelo ∪ tramo)', () => {
    expect(apoyosNivelVuelo(apoyos)).toEqual([APO]);
    expect(apoyosEfectivosDeTramo(E1, apoyos)).toEqual([
      { usuario_id: APO, origen: 'vuelo' },
    ]);
    expect(apoyosEfectivosDeTramo(E2, apoyos)).toEqual([
      { usuario_id: APO, origen: 'vuelo' },
      { usuario_id: APO2, origen: 'tramo' },
    ]);
  });

  it('quien está en el vuelo y en el tramo sale una vez con origen vuelo', () => {
    const dup: VueloApoyoRow[] = [
      { escala_id: E1, usuario_id: APO, created_at: '2026-08-01T00:00:00Z' },
      { escala_id: null, usuario_id: APO, created_at: '2026-08-02T00:00:00Z' },
    ];
    expect(apoyosEfectivosDeTramo(E1, dup)).toEqual([
      { usuario_id: APO, origen: 'vuelo' },
    ]);
  });
});

describe('miTripulacion', () => {
  it('piloto del vuelo: piloto efectivo de los tramos vivos que heredan, copiloto en el tramo de rotación', () => {
    const mt = miTripulacion(PIL, vuelo, escalas, apoyos);
    expect(mt.piloto).toBe(true);
    expect(mt.copiloto).toBe(false);
    expect(mt.apoyo).toBe(false);
    expect(mt.tramos_piloto).toEqual([E1]);
    expect(mt.tramos_copiloto).toEqual([E2]);
    expect(mt.puede_capturar_tacos).toBe(true);
    expect(mt.es_tripulante).toBe(true);
  });

  it('piloto de rotación (solo el regreso)', () => {
    const mt = miTripulacion(ROT, vuelo, escalas, apoyos);
    expect(mt.piloto).toBe(false);
    expect(mt.tramos_piloto).toEqual([E2]);
    expect(mt.puede_capturar_tacos).toBe(true);
  });

  it('apoyo del vuelo: ve todo, va en todos los tramos vivos y NO captura tacos', () => {
    const mt = miTripulacion(APO, vuelo, escalas, apoyos);
    expect(mt.apoyo).toBe(true);
    expect(mt.tramos_apoyo).toEqual([E1, E2]);
    expect(mt.puede_capturar_tacos).toBe(false);
    expect(mt.es_tripulante).toBe(true);
  });

  it('apoyo de UN tramo: solo ese tramo, sin tacos', () => {
    const mt = miTripulacion(APO2, vuelo, escalas, apoyos);
    expect(mt.apoyo).toBe(true);
    expect(mt.tramos_apoyo).toEqual([E2]);
    expect(mt.tramos_piloto).toEqual([]);
    expect(mt.puede_capturar_tacos).toBe(false);
  });

  it('copiloto del vuelo hereda en los tramos sin copiloto propio', () => {
    const mt = miTripulacion(COP, vuelo, escalas, apoyos);
    expect(mt.copiloto).toBe(true);
    expect(mt.tramos_copiloto).toEqual([E1]);
    expect(mt.puede_capturar_tacos).toBe(true);
  });

  it('ajeno al vuelo: nada', () => {
    const mt = miTripulacion('otro', vuelo, escalas, apoyos);
    expect(mt.es_tripulante).toBe(false);
    expect(mt.puede_capturar_tacos).toBe(false);
    expect(mt.tramos_apoyo).toEqual([]);
  });

  it('espejo legado: sin filas en vuelo_apoyo, vuelo.apoyo_id sigue valiendo', () => {
    const mt = miTripulacion(APO, vuelo, escalas, []);
    expect(mt.apoyo).toBe(true);
    expect(mt.tramos_apoyo).toEqual([E1, E2]);
    expect(mt.puede_capturar_tacos).toBe(false);
  });

  it('con filas en vuelo_apoyo el espejo viejo ya no manda', () => {
    const mt = miTripulacion(APO, { ...vuelo, apoyo_id: APO }, escalas, [
      { escala_id: null, usuario_id: APO2, created_at: '2026-08-01' },
    ]);
    expect(mt.apoyo).toBe(false);
    expect(mt.es_tripulante).toBe(false);
  });

  it('piloto/copiloto que ADEMÁS va de apoyo conserva los tacos', () => {
    const mt = miTripulacion(PIL, vuelo, escalas, [
      { escala_id: null, usuario_id: PIL, created_at: '2026-08-01' },
    ]);
    expect(mt.apoyo).toBe(true);
    expect(mt.puede_capturar_tacos).toBe(true);
  });
});
