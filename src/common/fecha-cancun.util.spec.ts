import { diaCancun, hoyCancun } from './fecha-cancun.util';

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
