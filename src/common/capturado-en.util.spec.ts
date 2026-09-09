import { BadRequestException } from '@nestjs/common';
import {
  CAPTURADO_EN_FUTURO_MAX_MS,
  anexarSello,
  capturadoAhora,
  resolverCapturadoEn,
  selloCapturaApp,
} from './capturado-en.util';

/**
 * `gasto.capturado_en` (7-sep-2026): la app manda el momento real de
 * captura; todo lo demás cae a "ahora". Solo auditoría, pero un valor raro
 * (sin zona, futuro, año absurdo) se rechaza con 400 en vez de guardarse.
 */
describe('resolverCapturadoEn', () => {
  const AHORA = new Date('2026-09-05T20:00:00Z'); // 15:00 Cancún

  it('sin valor → ahora del servidor (panel, masivo, backfill)', () => {
    expect(resolverCapturadoEn(undefined, AHORA)).toBe(AHORA.toISOString());
    expect(resolverCapturadoEn(null, AHORA)).toBe(AHORA.toISOString());
    expect(resolverCapturadoEn('', AHORA)).toBe(AHORA.toISOString());
  });

  it('acepta ISO con offset y lo normaliza a UTC (mismo instante)', () => {
    // 14:32 Cancún = 19:32 UTC
    expect(resolverCapturadoEn('2026-09-05T14:32:00-05:00', AHORA)).toBe(
      '2026-09-05T19:32:00.000Z',
    );
    expect(resolverCapturadoEn('2026-09-05T19:32:00.123Z', AHORA)).toBe(
      '2026-09-05T19:32:00.123Z',
    );
    // Offset sin dos puntos (algunos formateadores) también vale.
    expect(resolverCapturadoEn('2026-09-05T14:32:00-0500', AHORA)).toBe(
      '2026-09-05T19:32:00.000Z',
    );
  });

  it('acepta el pasado lejano razonable (captura sin señal subida días después)', () => {
    expect(resolverCapturadoEn('2026-08-30T08:10:00-05:00', AHORA)).toBe(
      '2026-08-30T13:10:00.000Z',
    );
  });

  it('tolera hasta 10 min a futuro (reloj adelantado), no más', () => {
    const limite = new Date(AHORA.getTime() + CAPTURADO_EN_FUTURO_MAX_MS);
    expect(resolverCapturadoEn(limite.toISOString(), AHORA)).toBe(
      limite.toISOString(),
    );
    const pasado = new Date(limite.getTime() + 1000).toISOString();
    expect(() => resolverCapturadoEn(pasado, AHORA)).toThrow(
      BadRequestException,
    );
    expect(() => resolverCapturadoEn(pasado, AHORA)).toThrow(/futuro/);
  });

  it('rechaza un instante SIN zona horaria (se guardaría corrido 5 h)', () => {
    expect(() => resolverCapturadoEn('2026-09-05T14:32:00', AHORA)).toThrow(
      /zona horaria/,
    );
    // Una fecha de pared tampoco es un instante.
    expect(() => resolverCapturadoEn('2026-09-05', AHORA)).toThrow(
      /zona horaria/,
    );
  });

  it('rechaza valores absurdos (antes de 2020) y basura', () => {
    expect(() =>
      resolverCapturadoEn('2019-12-31T18:59:59-05:00', AHORA),
    ).toThrow(/anterior a 2020/);
    expect(() => resolverCapturadoEn('1970-01-01T00:00:00Z', AHORA)).toThrow(
      /anterior a 2020/,
    );
    expect(() => resolverCapturadoEn('ayer a las 3', AHORA)).toThrow(
      BadRequestException,
    );
    // Forma ISO pero fecha inexistente: Date.parse la rechaza → 400.
    expect(() => resolverCapturadoEn('2026-13-45T14:32:00Z', AHORA)).toThrow(
      BadRequestException,
    );
  });
});

describe('capturadoAhora', () => {
  it('sello ISO del instante dado', () => {
    const t = new Date('2026-09-07T12:00:00Z');
    expect(capturadoAhora(t)).toBe('2026-09-07T12:00:00.000Z');
  });
});

/**
 * Sello TOLERANTE de reserva/evento (alta sin internet, 9-sep-2026): nunca
 * lanza; el valor raro se anota como "no confiable" y el alta sigue.
 */
describe('selloCapturaApp', () => {
  // 11:32 Cancún del 14-sep-2026.
  const AHORA = new Date('2026-09-14T16:32:00Z');

  it('ausente / vacío → null (nada que anotar)', () => {
    expect(selloCapturaApp(undefined, AHORA)).toBeNull();
    expect(selloCapturaApp(null, AHORA)).toBeNull();
    expect(selloCapturaApp('   ', AHORA)).toBeNull();
  });

  it('válido y más de 2 min antes → "[Capturado en la app el … · recibido el …]" en hora Cancún', () => {
    expect(selloCapturaApp('2026-09-14T09:00:00-05:00', AHORA)).toBe(
      '[Capturado en la app el 14 sep 09:00 · recibido el 14 sep 11:32]',
    );
    // Instante en Z: 14:00Z = 09:00 Cancún.
    expect(selloCapturaApp('2026-09-14T14:00:00Z', AHORA)).toBe(
      '[Capturado en la app el 14 sep 09:00 · recibido el 14 sep 11:32]',
    );
  });

  it('válido pero reciente (≤ 2 min): alta en línea normal → null', () => {
    expect(selloCapturaApp('2026-09-14T16:31:00Z', AHORA)).toBeNull();
    expect(selloCapturaApp(AHORA.toISOString(), AHORA)).toBeNull();
  });

  it('futuro (> 10 min): reloj del teléfono no confiable, NO rechaza', () => {
    expect(selloCapturaApp('2026-09-14T17:00:00Z', AHORA)).toBe(
      '[Capturado en la app (hora del teléfono no confiable: 2026-09-14T17:00:00Z) · recibido el 14 sep 11:32]',
    );
  });

  it('inválido (sin zona, basura, antes de 2020): no confiable, NO rechaza', () => {
    expect(selloCapturaApp('2026-09-14T09:00:00', AHORA)).toMatch(
      /^\[Capturado en la app \(hora del teléfono no confiable: 2026-09-14T09:00:00\) · recibido el 14 sep 11:32\]$/,
    );
    expect(selloCapturaApp('ayer', AHORA)).toMatch(/no confiable: ayer\)/);
    expect(selloCapturaApp('2001-01-01T00:00:00Z', AHORA)).toMatch(
      /no confiable/,
    );
    expect(() => selloCapturaApp('x'.repeat(500), AHORA)).not.toThrow();
  });
});

describe('anexarSello', () => {
  it('anexa en una línea nueva; sin sello devuelve las notas (o null)', () => {
    expect(anexarSello('Notas', '[sello]')).toBe('Notas\n[sello]');
    expect(anexarSello(undefined, '[sello]')).toBe('[sello]');
    expect(anexarSello('Notas', null)).toBe('Notas');
    expect(anexarSello('', null)).toBeNull();
  });
});
