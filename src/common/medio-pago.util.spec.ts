import { MEDIO_PAGO_LABEL, etiquetaMedioPago } from './medio-pago.util';

/**
 * Columna PAGO de la hoja "combustible" del balance (11-sep-2026): la
 * etiqueta que lee quien concilia contra el banco.
 */
describe('etiquetaMedioPago', () => {
  it('replica las etiquetas del panel (MEDIO_PAGO_LABELS)', () => {
    expect(etiquetaMedioPago('EFECTIVO')).toBe('Efectivo');
    expect(etiquetaMedioPago('TRANSFERENCIA')).toBe('Transferencia');
    expect(etiquetaMedioPago('PAYWISE')).toBe('Paywise');
    expect(etiquetaMedioPago('PERSONAL_PABLO')).toBe('Personal Pablo');
    expect(etiquetaMedioPago('PERSONAL_ALE')).toBe('Personal Ale');
    expect(etiquetaMedioPago('BODEGA')).toBe('Bodega (inventario)');
    // El catálogo completo del panel, sin sobras ni faltantes.
    expect(Object.keys(MEDIO_PAGO_LABEL).sort()).toEqual(
      [
        'BODEGA',
        'EFECTIVO',
        'PAYWISE',
        'PERSONAL_ALE',
        'PERSONAL_PABLO',
        'TARJETA_CORP',
        'TRANSFERENCIA',
      ].sort(),
    );
  });

  it('TARJETA_CORP añade la terminación con formato ****1234', () => {
    expect(etiquetaMedioPago('TARJETA_CORP', '1234')).toBe(
      'Tarjeta corporativa ****1234',
    );
  });

  it('TARJETA_CORP sin terminación queda con la etiqueta a secas', () => {
    expect(etiquetaMedioPago('TARJETA_CORP')).toBe('Tarjeta corporativa');
    expect(etiquetaMedioPago('TARJETA_CORP', null)).toBe('Tarjeta corporativa');
    expect(etiquetaMedioPago('TARJETA_CORP', '  ')).toBe('Tarjeta corporativa');
  });

  it('la terminación se IGNORA en otros medios (solo vive con TARJETA_CORP)', () => {
    expect(etiquetaMedioPago('EFECTIVO', '1234')).toBe('Efectivo');
    expect(etiquetaMedioPago('TRANSFERENCIA', '9999')).toBe('Transferencia');
  });

  it('código desconocido → capitalizado (dato viejo o valor libre)', () => {
    expect(etiquetaMedioPago('FOO_BAR')).toBe('Foo bar');
    expect(etiquetaMedioPago('CHEQUE')).toBe('Cheque');
  });

  it('sin medio → null (celda VACÍA, nunca un default falso)', () => {
    expect(etiquetaMedioPago(null)).toBeNull();
    expect(etiquetaMedioPago(undefined)).toBeNull();
    expect(etiquetaMedioPago('')).toBeNull();
    expect(etiquetaMedioPago('   ')).toBeNull();
    expect(etiquetaMedioPago(null, '1234')).toBeNull();
  });
});
