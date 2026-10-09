import { estadoBancoGasto, etiquetaEstadoBanco } from './estado-banco.util';

describe('estadoBancoGasto (columna Banco, 9-oct-2026)', () => {
  it('conciliado manda sobre el medio (también un efectivo ligado con justificación)', () => {
    expect(estadoBancoGasto({ conciliado: true, medio_pago: 'EFECTIVO' })).toBe(
      'CONCILIADO',
    );
    expect(
      estadoBancoGasto({ conciliado: true, medio_pago: 'TARJETA_CORP' }),
    ).toBe('CONCILIADO');
  });

  it('cargos ligados sin cubrir = parcial (monto_vinculado numeric puede llegar string)', () => {
    expect(
      estadoBancoGasto({
        conciliado: false,
        medio_pago: 'TARJETA_CORP',
        monto_vinculado: '120.5',
      }),
    ).toBe('PARCIAL');
    expect(
      estadoBancoGasto({
        conciliado: false,
        medio_pago: 'EFECTIVO',
        monto_vinculado: 5,
      }),
    ).toBe('PARCIAL');
  });

  it('medio bancario sin cargo = sin conciliar; efectivo/personal/bodega = no aplica', () => {
    for (const medio of ['TARJETA_CORP', 'TRANSFERENCIA', 'PAYWISE']) {
      expect(estadoBancoGasto({ conciliado: false, medio_pago: medio })).toBe(
        'SIN_CONCILIAR',
      );
    }
    for (const medio of [
      'EFECTIVO',
      'PERSONAL_PABLO',
      'PERSONAL_ALE',
      'BODEGA',
      null,
      undefined,
    ]) {
      expect(
        estadoBancoGasto({
          conciliado: false,
          medio_pago: medio,
          monto_vinculado: null,
        }),
      ).toBe('NO_APLICA');
    }
    expect(estadoBancoGasto({ monto_vinculado: '0' })).toBe('NO_APLICA');
  });

  it('etiquetas del Excel (vacío cuando no aplica)', () => {
    expect(etiquetaEstadoBanco('CONCILIADO')).toBe('Conciliado');
    expect(etiquetaEstadoBanco('PARCIAL')).toBe('Parcial');
    expect(etiquetaEstadoBanco('SIN_CONCILIAR')).toBe('Sin conciliar');
    expect(etiquetaEstadoBanco('NO_APLICA')).toBe('');
  });
});
