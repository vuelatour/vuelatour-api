import {
  diaCancun,
  diasEntreDiasCancun,
  fechaHoraCancun,
  hoyCancun,
  moverDiasHoraParedCancun,
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

describe('diasEntreDiasCancun', () => {
  it('días calendario entre dos fechas de pared (con signo)', () => {
    expect(diasEntreDiasCancun('2026-10-10', '2026-10-13')).toBe(3);
    expect(diasEntreDiasCancun('2026-10-13', '2026-10-10')).toBe(-3);
    expect(diasEntreDiasCancun('2026-10-10', '2026-10-10')).toBe(0);
  });

  it('cruza meses, años y bisiestos', () => {
    expect(diasEntreDiasCancun('2026-09-30', '2026-10-01')).toBe(1);
    expect(diasEntreDiasCancun('2026-12-31', '2027-01-01')).toBe(1);
    expect(diasEntreDiasCancun('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('fecha inválida → error legible', () => {
    expect(() => diasEntreDiasCancun('2026-10-1', '2026-10-10')).toThrow(
      /Fecha inválida/,
    );
  });
});

describe('moverDiasHoraParedCancun', () => {
  it('conserva la hora de pared Cancún al sumar días', () => {
    // 09:00 Cancún del 10-oct ⇒ 09:00 del 13-oct.
    expect(moverDiasHoraParedCancun('2026-10-10T14:00:00.000Z', 3)).toBe(
      '2026-10-13T14:00:00.000Z',
    );
    expect(
      fechaHoraCancun(moverDiasHoraParedCancun('2026-10-10T14:00:00Z', 3)),
    ).toBe('2026-10-13 09:00');
  });

  it('días negativos y cruce de mes', () => {
    expect(moverDiasHoraParedCancun('2026-11-02T01:30:00.000Z', -3)).toBe(
      '2026-10-30T01:30:00.000Z',
    );
    // 20:30 del 1-nov en Cancún ⇒ 20:30 del 29-oct.
    expect(
      fechaHoraCancun(moverDiasHoraParedCancun('2026-11-02T01:30:00Z', -3)),
    ).toBe('2026-10-29 20:30');
  });

  it('respeta segundos y milisegundos; 0 días devuelve el mismo instante', () => {
    expect(moverDiasHoraParedCancun('2026-10-10T14:05:07.123Z', 1)).toBe(
      '2026-10-11T14:05:07.123Z',
    );
    expect(moverDiasHoraParedCancun('2026-10-10T09:00:00-05:00', 0)).toBe(
      '2026-10-10T14:00:00.000Z',
    );
  });

  it('NUNCA suma 86 400 s a ciegas: con cambio de horario (Cancún 2014, UTC−6 → UTC−5) conserva la hora de pared', () => {
    // 1-mar-2014 09:00 Cancún (UTC−6) + 60 días = 30-abr-2014 09:00 (ya UTC−5).
    const movido = moverDiasHoraParedCancun('2014-03-01T15:00:00.000Z', 60);
    expect(fechaHoraCancun(movido)).toBe('2014-04-30 09:00');
    expect(movido).toBe('2014-04-30T14:00:00.000Z');
    // Sumar 60 × 86 400 s a ciegas habría dado las 10:00.
    expect(
      fechaHoraCancun(
        new Date(Date.parse('2014-03-01T15:00:00Z') + 60 * 86_400_000),
      ),
    ).toBe('2014-04-30 10:00');
  });

  it('fecha inválida o días no enteros → error', () => {
    expect(() => moverDiasHoraParedCancun('no-es-fecha', 1)).toThrow(
      /Fecha inválida/,
    );
    expect(() => moverDiasHoraParedCancun('2026-10-10T14:00:00Z', 1.5)).toThrow(
      /Días inválidos/,
    );
  });
});
