import {
  domingoDe,
  graciaSaneada,
  limiteCapturaMin,
  limiteEdicion,
  lunesDe,
} from './semana-gastos.util';

// Semana de referencia (pared Cancún): lunes 2026-08-24 → domingo 2026-08-30.

describe('lunesDe / domingoDe', () => {
  it('cualquier día de la semana apunta a su lunes', () => {
    expect(lunesDe('2026-08-24')).toBe('2026-08-24'); // lunes
    expect(lunesDe('2026-08-26')).toBe('2026-08-24'); // miércoles
    expect(lunesDe('2026-08-29')).toBe('2026-08-24'); // sábado
    expect(lunesDe('2026-08-30')).toBe('2026-08-24'); // domingo
    expect(lunesDe('2026-08-31')).toBe('2026-08-31'); // lunes siguiente
  });

  it('domingoDe cierra la misma semana', () => {
    expect(domingoDe('2026-08-24')).toBe('2026-08-30');
    expect(domingoDe('2026-08-30')).toBe('2026-08-30');
    expect(domingoDe('2026-08-31')).toBe('2026-09-06');
  });

  it('cruza fin de mes y fin de año sin moverse de día', () => {
    expect(lunesDe('2026-09-01')).toBe('2026-08-31');
    expect(lunesDe('2027-01-01')).toBe('2026-12-28');
    expect(domingoDe('2026-12-31')).toBe('2027-01-03');
  });

  it('fecha inválida → error legible', () => {
    expect(() => lunesDe('no-es-fecha')).toThrow(/Fecha inválida/);
  });
});

describe('limiteEdicion (gracia 1, la regla del equipo)', () => {
  it('capturado miércoles → editable hasta el lunes siguiente', () => {
    expect(limiteEdicion('2026-08-26', 1)).toBe('2026-08-31');
  });

  it('capturado en lunes de gracia → pertenece a la semana NUEVA: editable hasta SU lunes siguiente', () => {
    // El lunes 31-ago es día de gracia de la semana del 24; lo capturado ese
    // día es de la semana del 31 → límite = lunes 7-sep.
    expect(limiteEdicion('2026-08-31', 1)).toBe('2026-09-07');
  });

  it('el martes ya no se puede corregir lo de la semana pasada', () => {
    const limite = limiteEdicion('2026-08-26', 1); // capturado miércoles
    expect('2026-08-31' <= limite).toBe(true); // lunes: todavía
    expect('2026-09-01' <= limite).toBe(false); // martes: ya no
  });

  it('capturado domingo → también hasta el lunes siguiente (misma semana)', () => {
    expect(limiteEdicion('2026-08-30', 1)).toBe('2026-08-31');
  });
});

describe('limiteEdicion (gracia 0 y 2)', () => {
  it('gracia 0: editable solo hasta el domingo de su semana', () => {
    expect(limiteEdicion('2026-08-26', 0)).toBe('2026-08-30');
  });

  it('gracia 2: editable hasta el martes siguiente', () => {
    expect(limiteEdicion('2026-08-26', 2)).toBe('2026-09-01');
  });

  it('gracia basura (negativa/NaN) se sanea a 0', () => {
    expect(limiteEdicion('2026-08-26', -3)).toBe('2026-08-30');
    expect(limiteEdicion('2026-08-26', Number.NaN)).toBe('2026-08-30');
    expect(graciaSaneada(1.9)).toBe(1);
  });
});

describe('limiteCapturaMin (gracia 1)', () => {
  it('el lunes aún acepta la semana pasada completa', () => {
    expect(limiteCapturaMin('2026-08-31', 1)).toBe('2026-08-24');
  });

  it('del martes en adelante, solo la semana en curso', () => {
    expect(limiteCapturaMin('2026-09-01', 1)).toBe('2026-08-31');
    expect(limiteCapturaMin('2026-09-06', 1)).toBe('2026-08-31'); // domingo
  });
});

describe('limiteCapturaMin (gracia 0 y 2)', () => {
  it('gracia 0: ni el lunes se acepta la semana pasada', () => {
    expect(limiteCapturaMin('2026-08-31', 0)).toBe('2026-08-31');
  });

  it('gracia 2: lunes y martes aceptan la semana pasada; el miércoles ya no', () => {
    expect(limiteCapturaMin('2026-08-31', 2)).toBe('2026-08-24');
    expect(limiteCapturaMin('2026-09-01', 2)).toBe('2026-08-24');
    expect(limiteCapturaMin('2026-09-02', 2)).toBe('2026-08-31');
  });
});
