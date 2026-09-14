import {
  CON_COMPROBANTE,
  etiquetaComprobante,
  hayComprobante,
} from './comprobante.util';

describe('comprobante.util (dos opciones, 14-sep-2026)', () => {
  it('hayComprobante: todo lo que no es SIN_COMPROBANTE cuenta como papel', () => {
    expect(hayComprobante('FACTURA')).toBe(true);
    // VALE es LEGADO pero SÍ es comprobante: se lee, no se reescribe.
    expect(hayComprobante('VALE')).toBe(true);
    expect(hayComprobante('SIN_COMPROBANTE')).toBe(false);
  });

  it('hayComprobante: sin dato NO afirma comprobante', () => {
    expect(hayComprobante(null)).toBe(false);
    expect(hayComprobante(undefined)).toBe(false);
    expect(hayComprobante('   ')).toBe(false);
  });

  it('etiquetaComprobante: dos salidas, la palabra "Factura" ya no aparece', () => {
    expect(etiquetaComprobante('FACTURA')).toBe('Con comprobante');
    expect(etiquetaComprobante('VALE')).toBe('Con comprobante');
    expect(etiquetaComprobante('SIN_COMPROBANTE')).toBe('Sin comprobante');
    expect(etiquetaComprobante(null)).toBe('Sin comprobante');
    expect(etiquetaComprobante('FACTURA')).not.toMatch(/Factura/);
  });

  it('el valor que se GUARDA para "con comprobante" es el que ya manda la app', () => {
    expect(CON_COMPROBANTE).toBe('FACTURA');
    expect(hayComprobante(CON_COMPROBANTE)).toBe(true);
  });
});
