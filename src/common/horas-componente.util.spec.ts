import {
  deltaDesdeReferencia,
  horasVivasComponente,
  tiempoPlaneador,
} from './horas-componente.util';

describe('horas-componente.util (aritmética única de horas derivadas)', () => {
  it('con recorte: delta negativo se vuelve 0 (el "hoy" nunca resta vida)', () => {
    expect(deltaDesdeReferencia(100, 151.9, { recortar: true })).toBe(0);
    expect(
      horasVivasComponente(
        { horas_totales: 1200.5, aeronave_horas_ref: 300 },
        250,
        { recortar: true },
      ),
    ).toEqual({ delta: 0, horas: 1200.5 });
  });

  it('sin recorte: reconstruye renglones anteriores a la referencia', () => {
    expect(deltaDesdeReferencia(100, 151.9, { recortar: false })).toBeCloseTo(
      -51.9,
      6,
    );
    expect(
      horasVivasComponente(
        { horas_totales: 1200.5, aeronave_horas_ref: 300 },
        250,
        { recortar: false },
      ),
    ).toEqual({ delta: -50, horas: 1150.5 });
  });

  it('mismo resultado que componenteEstado hacia adelante (ht + hobbs − ref)', () => {
    const r = horasVivasComponente(
      { horas_totales: '1200.5', aeronave_horas_ref: '300' },
      345.2,
      { recortar: true },
    );
    expect(r.delta).toBeCloseTo(45.2, 6);
    expect(r.horas).toBe(1245.7);
  });

  it('sin referencia: delta 0 y horas = horas_totales (null ⇒ 0)', () => {
    expect(
      horasVivasComponente({ horas_totales: 800 }, 5000, { recortar: true }),
    ).toEqual({ delta: 0, horas: 800 });
    expect(
      horasVivasComponente(
        { horas_totales: null, aeronave_horas_ref: null },
        5000,
        { recortar: false },
      ),
    ).toEqual({ delta: 0, horas: 0 });
  });

  it('planeador: base + (taco − ref) con y sin recorte; base 0/ref 0 = taco', () => {
    const pev = { planeador_horas_base: 5226.1, planeador_taco_ref: 151.9 };
    expect(tiempoPlaneador(pev, 345.2, { recortar: true })).toBe(5419.4);
    expect(tiempoPlaneador(pev, 100.0, { recortar: true })).toBe(5226.1);
    expect(tiempoPlaneador(pev, 100.0, { recortar: false })).toBe(5174.2);
    expect(tiempoPlaneador({}, 345.2, { recortar: false })).toBe(345.2);
    expect(
      tiempoPlaneador(
        { planeador_horas_base: null, planeador_taco_ref: null },
        345.2,
        { recortar: true },
      ),
    ).toBe(345.2);
  });
});
