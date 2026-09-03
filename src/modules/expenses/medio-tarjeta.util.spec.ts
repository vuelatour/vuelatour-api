import {
  acoplarTarjetaEnUpdate,
  cruzarMedioConIa,
  esTerminacionValida,
  etiquetaMedioPago,
  mensajeCheckGasto,
  terminacionIa,
  terminacionPrevia,
} from './medio-tarjeta.util';

describe('esTerminacionValida / terminacionIa', () => {
  it('solo acepta exactamente 4 dígitos', () => {
    expect(esTerminacionValida('1234')).toBe(true);
    expect(esTerminacionValida('123')).toBe(false);
    expect(esTerminacionValida('12345')).toBe(false);
    expect(esTerminacionValida('12a4')).toBe(false);
    expect(esTerminacionValida(1234)).toBe(false);
    expect(esTerminacionValida(null)).toBe(false);
    expect(esTerminacionValida(undefined)).toBe(false);
  });

  it('terminacionIa lee valor_ia_extraido y tolera basura', () => {
    expect(terminacionIa({ tarjeta_terminacion: '4321' })).toBe('4321');
    expect(terminacionIa({ tarjeta_terminacion: '43' })).toBeNull();
    expect(terminacionIa({ tarjeta_terminacion: null })).toBeNull();
    expect(terminacionIa({})).toBeNull();
    expect(terminacionIa(null)).toBeNull();
    expect(terminacionIa(undefined)).toBeNull();
    expect(terminacionIa('4321')).toBeNull();
  });
});

describe('terminacionPrevia (sello al capturar)', () => {
  it('fuera de TARJETA_CORP SIEMPRE es null, aunque llegue una terminación', () => {
    for (const medio of [
      'EFECTIVO',
      'TRANSFERENCIA',
      'PAYWISE',
      'PERSONAL_PABLO',
      'PERSONAL_ALE',
      'BODEGA',
      null,
      undefined,
    ]) {
      expect(
        terminacionPrevia(medio, '1234', { tarjeta_terminacion: '5678' }),
      ).toEqual({ terminacion: null, buscarAsignada: false });
    }
  });

  it('TARJETA_CORP: (1) explícita gana sobre la IA', () => {
    expect(
      terminacionPrevia('TARJETA_CORP', ' 1234 ', {
        tarjeta_terminacion: '5678',
      }),
    ).toEqual({ terminacion: '1234', buscarAsignada: false });
  });

  it('TARJETA_CORP: (2) sin explícita toma la del voucher (IA)', () => {
    expect(
      terminacionPrevia('TARJETA_CORP', undefined, {
        tarjeta_terminacion: '5678',
      }),
    ).toEqual({ terminacion: '5678', buscarAsignada: false });
    expect(
      terminacionPrevia('TARJETA_CORP', '', { tarjeta_terminacion: '5678' }),
    ).toEqual({ terminacion: '5678', buscarAsignada: false });
  });

  it('TARJETA_CORP: (3) sin nada pide la tarjeta asignada al capturador', () => {
    expect(terminacionPrevia('TARJETA_CORP', null, undefined)).toEqual({
      terminacion: null,
      buscarAsignada: true,
    });
    // Una lectura IA inválida (no son 4 dígitos) no cuenta.
    expect(
      terminacionPrevia('TARJETA_CORP', null, { tarjeta_terminacion: '56' }),
    ).toEqual({ terminacion: null, buscarAsignada: true });
  });
});

describe('acoplarTarjetaEnUpdate (PATCH medio↔tarjeta)', () => {
  it('sin medio en el PATCH no toca la tarjeta', () => {
    expect(acoplarTarjetaEnUpdate({}, { tarjeta_terminacion: '1234' })).toBe(
      'nada',
    );
    expect(acoplarTarjetaEnUpdate({ tarjeta_terminacion: '1234' }, null)).toBe(
      'nada',
    );
  });

  it('cambiar a un medio ≠ TARJETA_CORP LIMPIA la tarjeta (CHECK gasto_check)', () => {
    for (const medio of [
      'EFECTIVO',
      'TRANSFERENCIA',
      'PAYWISE',
      'PERSONAL_PABLO',
      'PERSONAL_ALE',
    ]) {
      expect(
        acoplarTarjetaEnUpdate(
          { medio_pago: medio, tarjeta_terminacion: '1234' },
          { tarjeta_terminacion: '1234' },
        ),
      ).toBe('limpiar');
      expect(acoplarTarjetaEnUpdate({ medio_pago: medio }, null)).toBe(
        'limpiar',
      );
    }
  });

  it('TARJETA_CORP con terminación explícita: nada (ya viaja en el PATCH)', () => {
    expect(
      acoplarTarjetaEnUpdate(
        { medio_pago: 'TARJETA_CORP', tarjeta_terminacion: '9999' },
        { tarjeta_terminacion: '1234' },
      ),
    ).toBe('nada');
  });

  it('TARJETA_CORP sin terminación conserva la que ya tenía el gasto', () => {
    expect(
      acoplarTarjetaEnUpdate(
        { medio_pago: 'TARJETA_CORP' },
        { tarjeta_terminacion: '1234' },
      ),
    ).toBe('nada');
  });

  it('TARJETA_CORP sin terminación en ningún lado → sellar', () => {
    expect(acoplarTarjetaEnUpdate({ medio_pago: 'TARJETA_CORP' }, null)).toBe(
      'sellar',
    );
    expect(
      acoplarTarjetaEnUpdate(
        { medio_pago: 'TARJETA_CORP' },
        { tarjeta_terminacion: null },
      ),
    ).toBe('sellar');
    // null explícito con TARJETA_CORP = "resuélvela tú" (IA → catálogo).
    expect(
      acoplarTarjetaEnUpdate(
        { medio_pago: 'TARJETA_CORP', tarjeta_terminacion: null },
        { tarjeta_terminacion: '1234' },
      ),
    ).toBe('sellar');
  });
});

describe('cruzarMedioConIa (la IA JAMÁS reescribe el medio)', () => {
  const nada = { sellarTerminacion: null, discrepancia: null };

  it('sin lectura IA no hay nada que cruzar', () => {
    expect(
      cruzarMedioConIa(
        { medio_pago: 'EFECTIVO', tarjeta_terminacion: null },
        null,
      ),
    ).toEqual(nada);
    expect(
      cruzarMedioConIa(
        { medio_pago: 'EFECTIVO', tarjeta_terminacion: null },
        undefined,
      ),
    ).toEqual(nada);
    expect(
      cruzarMedioConIa(
        { medio_pago: 'EFECTIVO', tarjeta_terminacion: null },
        {
          medio_pago: null,
          tarjeta_terminacion: null,
        },
      ),
    ).toEqual(nada);
  });

  it('EFECTIVO capturado + voucher de tarjeta •1234 → discrepancia, NUNCA sella la tarjeta', () => {
    const r = cruzarMedioConIa(
      { medio_pago: 'EFECTIVO', tarjeta_terminacion: null },
      { medio_pago: 'TARJETA_CORP', tarjeta_terminacion: '1234' },
    );
    expect(r.sellarTerminacion).toBeNull();
    expect(r.discrepancia).toBe(
      'medio capturado Efectivo, el voucher parece pago con tarjeta •1234',
    );
  });

  it('EFECTIVO capturado + solo terminación leída (sin medio IA) también avisa', () => {
    const r = cruzarMedioConIa(
      { medio_pago: 'EFECTIVO', tarjeta_terminacion: null },
      { tarjeta_terminacion: '1234' },
    );
    expect(r.sellarTerminacion).toBeNull();
    expect(r.discrepancia).toBe(
      'medio capturado Efectivo, el voucher parece pago con tarjeta •1234',
    );
  });

  it('PERSONAL_* capturado + IA transferencia → "parece pago con transferencia"', () => {
    const r = cruzarMedioConIa(
      { medio_pago: 'PERSONAL_PABLO', tarjeta_terminacion: null },
      { medio_pago: 'TRANSFERENCIA', tarjeta_terminacion: null },
    );
    expect(r.discrepancia).toBe(
      'medio capturado Personal Pablo, el voucher parece pago con transferencia',
    );
    expect(r.sellarTerminacion).toBeNull();
  });

  it('EFECTIVO capturado + IA efectivo → nada', () => {
    expect(
      cruzarMedioConIa(
        { medio_pago: 'EFECTIVO', tarjeta_terminacion: null },
        {
          medio_pago: 'EFECTIVO',
          tarjeta_terminacion: null,
        },
      ),
    ).toEqual(nada);
  });

  it('TRANSFERENCIA / PAYWISE / BODEGA capturados: no se cruzan (lo decide el banco)', () => {
    for (const medio of ['TRANSFERENCIA', 'PAYWISE', 'BODEGA']) {
      expect(
        cruzarMedioConIa(
          { medio_pago: medio, tarjeta_terminacion: null },
          {
            medio_pago: 'TARJETA_CORP',
            tarjeta_terminacion: '1234',
          },
        ),
      ).toEqual(nada);
    }
  });

  it('TARJETA_CORP sin terminación → sella la del voucher', () => {
    expect(
      cruzarMedioConIa(
        { medio_pago: 'TARJETA_CORP', tarjeta_terminacion: null },
        { medio_pago: 'TARJETA_CORP', tarjeta_terminacion: '1234' },
      ),
    ).toEqual({ sellarTerminacion: '1234', discrepancia: null });
    expect(
      cruzarMedioConIa(
        { medio_pago: 'TARJETA_CORP', tarjeta_terminacion: '' },
        { tarjeta_terminacion: '1234' },
      ),
    ).toEqual({ sellarTerminacion: '1234', discrepancia: null });
  });

  it('TARJETA_CORP con terminación distinta al voucher → discrepancia, no pisa', () => {
    expect(
      cruzarMedioConIa(
        { medio_pago: 'TARJETA_CORP', tarjeta_terminacion: '1111' },
        { tarjeta_terminacion: '2222' },
      ),
    ).toEqual({
      sellarTerminacion: null,
      discrepancia: 'tarjeta capturada •1111, el voucher dice •2222',
    });
  });

  it('TARJETA_CORP igual al voucher, o voucher sin terminación → nada', () => {
    expect(
      cruzarMedioConIa(
        { medio_pago: 'TARJETA_CORP', tarjeta_terminacion: '1111' },
        { tarjeta_terminacion: '1111' },
      ),
    ).toEqual(nada);
    expect(
      cruzarMedioConIa(
        { medio_pago: 'TARJETA_CORP', tarjeta_terminacion: null },
        { medio_pago: 'EFECTIVO', tarjeta_terminacion: null },
      ),
    ).toEqual(nada);
  });

  it('una terminación IA inválida no sella ni acusa', () => {
    expect(
      cruzarMedioConIa(
        { medio_pago: 'TARJETA_CORP', tarjeta_terminacion: null },
        { tarjeta_terminacion: '12' },
      ),
    ).toEqual(nada);
    expect(
      cruzarMedioConIa(
        { medio_pago: 'EFECTIVO', tarjeta_terminacion: null },
        { tarjeta_terminacion: 'abcd' },
      ),
    ).toEqual(nada);
  });
});

describe('etiquetaMedioPago / mensajeCheckGasto', () => {
  it('etiquetas legibles y fallback al código', () => {
    expect(etiquetaMedioPago('TARJETA_CORP')).toBe('Tarjeta corporativa');
    expect(etiquetaMedioPago('PAYWISE')).toBe('PayWise');
    expect(etiquetaMedioPago('RARO')).toBe('RARO');
    expect(etiquetaMedioPago(null)).toBe('—');
  });

  it('23514 de medio↔tarjeta se explica en español', () => {
    expect(
      mensajeCheckGasto({
        message:
          'new row for relation "gasto" violates check constraint "gasto_check"',
      }),
    ).toMatch(/Tarjeta corporativa/);
    expect(
      mensajeCheckGasto({
        message:
          'new row for relation "gasto" violates check constraint "gasto_tarjeta_terminacion_check"',
      }),
    ).toMatch(/4 dígitos/);
  });

  it('otros CHECK de gasto: propina, monto, tc y genérico', () => {
    expect(
      mensajeCheckGasto({
        message: 'violates check constraint "gasto_propina_check"',
      }),
    ).toMatch(/propina/i);
    expect(
      mensajeCheckGasto({
        message: 'violates check constraint "gasto_monto_check"',
      }),
    ).toMatch(/monto/i);
    expect(
      mensajeCheckGasto({
        message: 'violates check constraint "gasto_tc_gasto_check"',
      }),
    ).toMatch(/tipo de cambio/i);
    expect(
      mensajeCheckGasto({
        message: 'violates check constraint "gasto_origen_check"',
      }),
    ).toBe(
      'El gasto no cumple una regla de la base de datos (gasto_origen_check): revisa los datos capturados.',
    );
    expect(mensajeCheckGasto({})).toMatch(/regla de la base de datos/);
  });
});
