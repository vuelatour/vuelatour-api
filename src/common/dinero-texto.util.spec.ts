import { fmtDineroTexto, fmtNumeroDinero } from './dinero-texto.util';

/**
 * Regla de dinero en textos (24-sep-2026, captura de Itzi: «$8,050.4»):
 * nunca 1 decimal — entero sin decimales, con centavos exactamente 2.
 */
describe('fmtDineroTexto / fmtNumeroDinero', () => {
  it('con centavos ⇒ exactamente 2 decimales', () => {
    expect(fmtDineroTexto(8050.4, 'USD')).toBe('$8,050.40 USD');
    expect(fmtDineroTexto(136856.8, 'MXN')).toBe('$136,856.80 MXN');
    expect(fmtDineroTexto(7350.69, 'USD')).toBe('$7,350.69 USD');
  });

  it('entero ⇒ sin decimales', () => {
    expect(fmtDineroTexto(1200, 'MXN')).toBe('$1,200 MXN');
    expect(fmtDineroTexto(1000)).toBe('$1,000');
    // 1199.999 redondea a centavos ⇒ 1200.00 ⇒ entero.
    expect(fmtDineroTexto(1199.999)).toBe('$1,200');
  });

  it('redondeo a centavos sin errores de punto flotante', () => {
    expect(fmtDineroTexto(0.1 + 0.2)).toBe('$0.30');
    expect(fmtDineroTexto(1.005)).toBe('$1.01');
  });

  it('-0 y restos de redondeo ⇒ $0; negativos con el signo antes del $', () => {
    expect(fmtDineroTexto(-0.001)).toBe('$0');
    expect(fmtDineroTexto(-0)).toBe('$0');
    expect(fmtDineroTexto(-250, 'USD')).toBe('-$250 USD');
    expect(fmtNumeroDinero(-12.5)).toBe('-12.50');
  });

  it('valor no finito ⇒ 0 (un texto nunca dice NaN)', () => {
    expect(fmtNumeroDinero(Number.NaN)).toBe('0');
    expect(fmtDineroTexto(Number.POSITIVE_INFINITY, 'USD')).toBe('$0 USD');
  });
});
