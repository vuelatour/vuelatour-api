import {
  METODOS_COBRO_ABONO_AUTO,
  METODOS_COBRO_ABONO_MANUAL,
  METODOS_COBRO_PASARELA,
  METODO_COBRO_LABELS,
  etiquetaMetodoCobro,
} from './metodo-cobro.util';

/**
 * TABLA CANÓNICA de métodos de cobro (22-sep-2026). El panel
 * (`lib/admin/metodos-pago.ts`) y la app Flutter COPIAN esta tabla; su test
 * de paridad compara contra estos pares exactos. Si aquí cambia una
 * etiqueta y allá no, el recibo/PDF y la pantalla dirían cosas distintas
 * del MISMO cobro.
 */
const TABLA: Array<[string, string]> = [
  ['HSBC_LINK', 'Link de pago (HSBC)'],
  ['PAYWISE', 'Link de pago (Paywise)'],
  ['TRANSFERENCIA', 'Transferencia'],
  ['EFECTIVO', 'Efectivo'],
  ['CHEQUE', 'Cheque'],
  ['BILLPOCKET', 'BillPocket'],
  ['DOLARES', 'Dólares directo'],
  ['OTRO', 'Otro'],
];

describe('METODO_COBRO_LABELS (fuente única de las etiquetas)', () => {
  it.each(TABLA)('%s ⇒ «%s»', (codigo, etiqueta) => {
    expect(METODO_COBRO_LABELS[codigo]).toBe(etiqueta);
    expect(etiquetaMetodoCobro(codigo)).toBe(etiqueta);
  });

  it('no sobra ni falta ningún método (el enum de la BD no cambió)', () => {
    expect(Object.keys(METODO_COBRO_LABELS).sort()).toEqual(
      TABLA.map(([c]) => c).sort(),
    );
  });

  it('los dos «link de pago» dicen quién cobra (pedido del cliente)', () => {
    expect(METODO_COBRO_LABELS.HSBC_LINK).toContain('Link de pago');
    expect(METODO_COBRO_LABELS.PAYWISE).toContain('Link de pago');
    expect(METODO_COBRO_LABELS.HSBC_LINK).not.toBe(METODO_COBRO_LABELS.PAYWISE);
  });

  it('sin método ⇒ «—»; código desconocido ⇒ tal cual (nunca se pierde)', () => {
    expect(etiquetaMetodoCobro(null)).toBe('—');
    expect(etiquetaMetodoCobro(undefined)).toBe('—');
    expect(etiquetaMetodoCobro('')).toBe('—');
    expect(etiquetaMetodoCobro('INVENTADO')).toBe('INVENTADO');
  });

  it('LOS CONJUNTOS NO CAMBIARON: solo se renombraron las etiquetas', () => {
    expect([...METODOS_COBRO_ABONO_AUTO]).toEqual([
      'TRANSFERENCIA',
      'HSBC_LINK',
      'CHEQUE',
      'PAYWISE',
    ]);
    expect([...METODOS_COBRO_ABONO_MANUAL]).toEqual([
      'TRANSFERENCIA',
      'HSBC_LINK',
      'CHEQUE',
      'PAYWISE',
      'BILLPOCKET',
    ]);
    expect([...METODOS_COBRO_PASARELA]).toEqual(['PAYWISE']);
  });
});
