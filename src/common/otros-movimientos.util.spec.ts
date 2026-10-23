import {
  CLAVE_SUELTA_OTROS_MOVIMIENTOS,
  SUFIJO_DINERO_OTROS_MOVIMIENTOS,
  conceptoOtroMovimiento,
  esOtroMovimiento,
  ordenarOtrosMovimientos,
} from './otros-movimientos.util';

/**
 * «OTROS MOVIMIENTOS (VUELATOUR)» como gasto (23-oct-2026, API 0.0.106,
 * invariante 107): la gramática ÚNICA del concepto que comparten el Balance
 * general («otros movimientos») y el Libro Dinero.
 */
describe('otros-movimientos.util — concepto de la línea de egreso', () => {
  it('la primera línea de las notas es el concepto; proveedor, efectivo y «USD sin TC» como sufijos', () => {
    expect(
      conceptoOtroMovimiento({
        notas: 'Viáticos de pernocta pagados al piloto\nsegunda línea',
        proveedor: { nombre: 'Hotel Xcaret' },
        medio_pago: 'EFECTIVO_EMPRESA',
      }),
    ).toBe(
      'Viáticos de pernocta pagados al piloto · Hotel Xcaret (efectivo de la empresa)',
    );
    expect(
      conceptoOtroMovimiento(
        {
          notas: '  Propina handling  ',
          proveedor: [{ nombre: 'Menzies' }],
          medio_pago: 'EFECTIVO',
        },
        { sinTc: true },
      ),
    ).toBe('Propina handling · Menzies (efectivo) (USD sin TC)');
  });

  it('sin notas ⇒ la etiqueta de la categoría; sin proveedor ⇒ el lugar; sin nada más, solo el título', () => {
    expect(conceptoOtroMovimiento({})).toBe('Otros movimientos (VuelaTour)');
    expect(
      conceptoOtroMovimiento({
        notas: null,
        lugar: 'CUN',
        medio_pago: 'TRANSFERENCIA',
      }),
    ).toBe('Otros movimientos (VuelaTour) · CUN');
    expect(
      conceptoOtroMovimiento({
        notas: 'Extra pagado a tercero',
        proveedor: { nombre: '  ' },
        lugar: '',
      }),
    ).toBe('Extra pagado a tercero');
  });

  it('salta las líneas de aviso «⚠» y corta en el bloque «Desglose:» de la IA (va al final de las notas); tolera filas crudas (campos de cualquier tipo)', () => {
    expect(
      conceptoOtroMovimiento({
        notas:
          '\n⚠ medio capturado efectivo, el ticket dice tarjeta — revisar\nPernocta piloto\n\nDesglose:\nTUA 500\nOperación 300',
      }),
    ).toBe('Pernocta piloto');
    // Sin texto de la oficina antes del desglose ⇒ la etiqueta (jamás un
    // renglón del desglose como concepto).
    expect(
      conceptoOtroMovimiento({
        notas: '⚠ aviso\nDesglose:\nTUA 500\nPernocta piloto',
      }),
    ).toBe('Otros movimientos (VuelaTour)');
    expect(
      conceptoOtroMovimiento({
        notas: 'Desglose:\nTUA 500',
        proveedor: 42,
        lugar: 7,
        medio_pago: null,
      }),
    ).toBe('Otros movimientos (VuelaTour)');
  });

  it('esOtroMovimiento: igualdad exacta; constantes de la suelta y del Dinero', () => {
    expect(esOtroMovimiento({ categoria: 'OTROS_MOVIMIENTOS' })).toBe(true);
    for (const categoria of [
      'OTRO',
      'otros_movimientos',
      'TUAS',
      null,
      undefined,
      3,
    ]) {
      expect(esOtroMovimiento({ categoria })).toBe(false);
    }
    expect(CLAVE_SUELTA_OTROS_MOVIMIENTOS).toBe('otros movimientos sin vuelo');
    expect(SUFIJO_DINERO_OTROS_MOVIMIENTOS).toBe(
      '(egreso VuelaTour — no resta: Otros movimientos)',
    );
  });

  it('ordenarOtrosMovimientos: por fecha y después por id, sin mutar la entrada; valores raros al principio', () => {
    const entrada = [
      { id: 'b', fecha_gasto: '2026-09-12' },
      { id: 'a', fecha_gasto: '2026-09-12' },
      { id: 'c', fecha_gasto: '2026-09-11' },
      { id: 'd', fecha_gasto: null },
      { id: 7, fecha_gasto: '2026-09-11' },
    ];
    const copia = [...entrada];
    expect(ordenarOtrosMovimientos(entrada).map((g) => g.id)).toEqual([
      'd',
      7,
      'c',
      'a',
      'b',
    ]);
    expect(entrada).toEqual(copia);
  });
});
