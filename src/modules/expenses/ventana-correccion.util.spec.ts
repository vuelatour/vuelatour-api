import { BadRequestException } from '@nestjs/common';
import {
  diaReferenciaVentana,
  lineaSelloCorreccion,
  resolverSelloCorreccion,
} from './ventana-correccion.util';

/**
 * Ventana semanal justa (B3): el sello de la corrección manda sobre "hoy",
 * nunca a futuro; la línea de bitácora solo cuando la corrección llegó tarde.
 */
describe('resolverSelloCorreccion', () => {
  // Martes 15-sep-2026 16:00 Cancún = 21:00Z.
  const ahora = new Date('2026-09-15T21:00:00Z');

  it('sin sello → null (se evalúa contra hoy)', () => {
    expect(resolverSelloCorreccion(undefined, ahora)).toBeNull();
    expect(resolverSelloCorreccion('', ahora)).toBeNull();
    expect(diaReferenciaVentana(null, ahora)).toBe('2026-09-15');
  });

  it('sello del domingo sin señal → día Cancún del domingo', () => {
    const s = resolverSelloCorreccion('2026-09-13T22:30:00-05:00', ahora);
    expect(s).not.toBeNull();
    expect(s?.dia).toBe('2026-09-13');
    expect(diaReferenciaVentana(s, ahora)).toBe('2026-09-13');
  });

  it('ISO sin zona → 400 (misma regla estricta que el alta)', () => {
    expect(() => resolverSelloCorreccion('2026-09-13T22:30:00', ahora)).toThrow(
      BadRequestException,
    );
  });

  it('a futuro > 10 min → 400; ≤ 10 min → se acota a ahora', () => {
    expect(() =>
      resolverSelloCorreccion('2026-09-15T21:20:00Z', ahora),
    ).toThrow(BadRequestException);
    const s = resolverSelloCorreccion('2026-09-15T21:05:00Z', ahora);
    expect(s?.iso).toBe(ahora.toISOString());
    expect(s?.dia).toBe('2026-09-15');
  });
});

describe('lineaSelloCorreccion', () => {
  const ahora = new Date('2026-09-15T21:00:00Z');

  it('corrección en línea (≤ 2 min) → sin línea', () => {
    const s = resolverSelloCorreccion('2026-09-15T20:59:00Z', ahora);
    expect(lineaSelloCorreccion('Corrección', s, ahora)).toBeNull();
    expect(lineaSelloCorreccion('Baja', null, ahora)).toBeNull();
  });

  it('corrección tardía → «[Corrección capturada en la app el … · recibida el …]» en hora Cancún', () => {
    const s = resolverSelloCorreccion('2026-09-13T22:30:00-05:00', ahora);
    expect(lineaSelloCorreccion('Corrección', s, ahora)).toBe(
      '[Corrección capturada en la app el 13 sep 22:30 · recibida el 15 sep 16:00]',
    );
    expect(lineaSelloCorreccion('Baja', s, ahora)).toMatch(
      /^\[Baja capturada en la app el 13 sep 22:30 · recibida el 15 sep 16:00\]$/,
    );
  });
});
