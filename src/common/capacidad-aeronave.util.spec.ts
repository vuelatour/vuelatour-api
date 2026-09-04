import {
  avisosCapacidad,
  conflictoCapacidad,
  excesoDeCapacidad,
} from './capacidad-aeronave.util';

const KODIAK = 'aaaaaaaa-0000-0000-0000-000000000001'; // 9 asientos
const C182 = 'bbbbbbbb-0000-0000-0000-000000000002'; // 5 asientos
const SIN_DATO = 'cccccccc-0000-0000-0000-000000000003'; // asientos null

const flota = new Map([
  [KODIAK, { matricula: 'N621TX', asientos: 9 }],
  [C182, { matricula: 'XB-ANU', asientos: 5 }],
  [SIN_DATO, { matricula: 'XB-IJP', asientos: null }],
]);

describe('excesoDeCapacidad', () => {
  it('todo cabe: lista vacía (pax == asientos también cabe)', () => {
    const r = excesoDeCapacidad(
      [
        { orden: 1, origen_iata: 'CUN', destino_iata: 'CZA', pasajeros: 9 },
        { orden: 2, origen_iata: 'CZA', destino_iata: 'CUN', pasajeros: 9 },
      ],
      flota,
      { aeronaveVueloId: KODIAK },
    );
    expect(r).toEqual([]);
  });

  it('44 pax en un Cessna de 5: exceso con herencia del avión del vuelo', () => {
    const r = excesoDeCapacidad(
      [
        { orden: 1, origen_iata: 'CUN', destino_iata: 'CZA', pasajeros: 44 },
        { orden: 2, origen_iata: 'CZA', destino_iata: 'CUN', pasajeros: 44 },
      ],
      flota,
      { aeronaveVueloId: C182 },
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      orden: 1,
      aeronave_id: C182,
      matricula: 'XB-ANU',
      pax: 44,
      asientos: 5,
    });
  });

  it('el avión del TRAMO manda sobre el del vuelo (rotación por tramo)', () => {
    const r = excesoDeCapacidad(
      [
        { orden: 1, pasajeros: 7, aeronave_id: null },
        { orden: 2, pasajeros: 7, aeronave_id: C182 },
      ],
      flota,
      { aeronaveVueloId: KODIAK },
    );
    // Tramo 1 hereda el Kodiak (cabe); tramo 2 va en el C182 (no cabe).
    expect(r.map((x) => x.orden)).toEqual([2]);
  });

  it('ferry, cancelados, sin avión, sin pax y avión sin asientos en catálogo NUNCA bloquean', () => {
    const r = excesoDeCapacidad(
      [
        { orden: 1, pasajeros: 0, es_ferry: true, aeronave_id: C182 },
        {
          orden: 2,
          pasajeros: 44,
          aeronave_id: C182,
          cancelada_at: '2026-09-01T00:00:00Z',
        },
        { orden: 3, pasajeros: 44, aeronave_id: null },
        { orden: 4, pasajeros: 44, aeronave_id: SIN_DATO },
        { orden: 5, pasajeros: null, aeronave_id: C182 },
      ],
      flota,
      { aeronaveVueloId: null },
    );
    expect(r).toEqual([]);
  });

  it('pax null usa el global del vuelo (paxDefault)', () => {
    const r = excesoDeCapacidad(
      [{ orden: 1, pasajeros: null, aeronave_id: C182 }],
      flota,
      { paxDefault: 6 },
    );
    expect(r).toHaveLength(1);
    expect(r[0].pax).toBe(6);
  });

  it('acepta un Record además de Map', () => {
    const r = excesoDeCapacidad(
      [{ orden: 1, pasajeros: 10, aeronave_id: KODIAK }],
      { [KODIAK]: { matricula: 'N621TX', asientos: '9' } },
    );
    expect(r).toHaveLength(1);
    expect(r[0].asientos).toBe(9);
  });
});

describe('conflictoCapacidad / avisosCapacidad', () => {
  it('sin excesos: null y sin avisos', () => {
    expect(conflictoCapacidad([])).toBeNull();
    expect(avisosCapacidad([])).toEqual([]);
  });

  it('409 estructurado con el PEOR exceso en la cabecera y todos en tramos', () => {
    const excesos = excesoDeCapacidad(
      [
        {
          orden: 1,
          origen_iata: 'CUN',
          destino_iata: 'CZA',
          pasajeros: 10,
          aeronave_id: KODIAK,
        },
        {
          orden: 2,
          origen_iata: 'CZA',
          destino_iata: 'CUN',
          pasajeros: 44,
          aeronave_id: C182,
        },
      ],
      flota,
    );
    const c = conflictoCapacidad(excesos)!;
    expect(c.error).toBe('CAPACIDAD_EXCEDIDA');
    expect(c.details).toMatchObject({
      aeronave_id: C182,
      matricula: 'XB-ANU',
      asientos: 5,
      pax: 44,
    });
    expect(c.details.tramos).toHaveLength(2);
    expect(c.message).toContain('CZA → CUN: 44 pax en XB-ANU (5 asientos)');
    const avisos = avisosCapacidad(excesos);
    expect(avisos).toHaveLength(2);
    expect(avisos[0]).toContain('CUN → CZA lleva 10 pax y N621TX tiene 9');
  });
});
