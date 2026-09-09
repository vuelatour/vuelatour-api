import {
  diaCancun,
  fechaHoraCancun,
  hoyCancun,
  restarMeses,
  fechaCortaCancun,
} from './fecha-cancun.util';

describe('restarMeses', () => {
  it('resta meses calendario a una fecha de pared', () => {
    expect(restarMeses('2026-09-05', 6)).toBe('2026-03-05');
    expect(restarMeses('2026-03-05', 6)).toBe('2025-09-05');
    expect(restarMeses('2026-09-05', 0)).toBe('2026-09-05');
  });

  it('día inexistente en el mes destino: desborda al siguiente (nunca falla)', () => {
    expect(restarMeses('2026-03-31', 1)).toBe('2026-03-03');
  });

  it('fecha inválida → error legible', () => {
    expect(() => restarMeses('2026-9-5', 6)).toThrow(/Fecha inválida/);
  });
});

describe('hoyCancun', () => {
  afterEach(() => jest.useRealTimers());

  it('a las 00:30 UTC todavía es el día anterior en Cancún (19:30)', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-29T00:30:00Z'));
    expect(hoyCancun()).toBe('2026-08-28');
  });

  it('a las 05:00 UTC ya es el mismo día en Cancún (00:00)', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-29T05:00:00Z'));
    expect(hoyCancun()).toBe('2026-08-29');
  });

  it('acepta un instante explícito', () => {
    expect(hoyCancun(new Date('2026-01-01T03:00:00Z'))).toBe('2025-12-31');
  });
});

describe('diaCancun', () => {
  it('una fecha de pared YYYY-MM-DD se respeta tal cual', () => {
    expect(diaCancun('2026-08-28')).toBe('2026-08-28');
  });

  it('un timestamp se convierte al día Cancún', () => {
    expect(diaCancun('2026-08-29T02:00:00Z')).toBe('2026-08-28');
    expect(diaCancun('2026-08-28T10:00:00-05:00')).toBe('2026-08-28');
  });

  it('fecha inválida → error legible', () => {
    expect(() => diaCancun('no-es-fecha')).toThrow(/Fecha inválida/);
  });
});

describe('fechaHoraCancun', () => {
  it('instante UTC → "YYYY-MM-DD HH:mm" en hora Cancún (UTC−5)', () => {
    expect(fechaHoraCancun('2026-09-05T19:32:00.000Z')).toBe(
      '2026-09-05 14:32',
    );
    // Cruce de día: 03:15 UTC del 6 es 22:15 del 5 en Cancún.
    expect(fechaHoraCancun('2026-09-06T03:15:00Z')).toBe('2026-09-05 22:15');
    // Medianoche Cancún nunca sale como "24:00".
    expect(fechaHoraCancun('2026-09-06T05:00:00Z')).toBe('2026-09-06 00:00');
  });

  it('acepta offset explícito y Date', () => {
    expect(fechaHoraCancun('2026-09-05T14:32:00-05:00')).toBe(
      '2026-09-05 14:32',
    );
    expect(fechaHoraCancun(new Date('2026-09-05T19:32:00Z'))).toBe(
      '2026-09-05 14:32',
    );
  });

  it('nulo o inválido → cadena vacía (el Excel no se cae por una fila rara)', () => {
    expect(fechaHoraCancun(null)).toBe('');
    expect(fechaHoraCancun(undefined)).toBe('');
    expect(fechaHoraCancun('')).toBe('');
    expect(fechaHoraCancun('no-es-fecha')).toBe('');
  });
});

describe('fechaCortaCancun', () => {
  it('"lun 14 sep" y "lun 14 sep 09:00" en hora Cancún, sin "de" ni puntos', () => {
    // 14:00Z = 09:00 Cancún del lunes 14-sep-2026.
    expect(fechaCortaCancun('2026-09-14T14:00:00Z')).toBe('lun 14 sep');
    expect(fechaCortaCancun('2026-09-14T14:00:00Z', { hora: true })).toBe(
      'lun 14 sep 09:00',
    );
  });

  it('valor nulo o inválido → cadena vacía (nunca lanza)', () => {
    expect(fechaCortaCancun(null)).toBe('');
    expect(fechaCortaCancun('ayer', { hora: true })).toBe('');
  });
});
