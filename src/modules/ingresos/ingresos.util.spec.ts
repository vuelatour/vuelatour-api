import {
  TOLERANCIA_INGRESO,
  coincideBusqueda,
  comisionDeAplicacion,
  estadoConciliacionCobro,
  estadoConciliacionIngreso,
  montoCuadraIngreso,
  netoIngreso,
  saldoAnticipo,
  textoCampoBitacora,
  vueloPorVolar,
} from './ingresos.util';

describe('ingresos.util — dinero del ingreso', () => {
  it('neto = bruto − comisión; sin comisión = bruto', () => {
    expect(netoIngreso(20400, 1020)).toBe(19380);
    expect(netoIngreso(500, null)).toBe(500);
    expect(netoIngreso(500, 0)).toBe(500);
  });

  it('saldo del anticipo nunca negativo', () => {
    expect(saldoAnticipo(1000, 600)).toBe(400);
    expect(saldoAnticipo(1000, 1000)).toBe(0);
    expect(saldoAnticipo(1000, 1000.004)).toBe(0);
    expect(saldoAnticipo(0.3, 0.1)).toBe(0.2);
  });
});

describe('comisionDeAplicacion — proporcional con el RESIDUO en la última', () => {
  it('caso real: PAYWISE 10,000.00 con 885.70 en tres partes ⇒ Σ = 885.70', () => {
    const anticipo = { comision_anticipo: 885.7, monto_anticipo: 10000 };
    const a1 = comisionDeAplicacion({
      ...anticipo,
      aplicado_previo: 0,
      comision_previa: 0,
      monto: 3333.33,
    });
    const a2 = comisionDeAplicacion({
      ...anticipo,
      aplicado_previo: 3333.33,
      comision_previa: a1,
      monto: 3333.33,
    });
    const a3 = comisionDeAplicacion({
      ...anticipo,
      aplicado_previo: 6666.66,
      comision_previa: a1 + a2,
      monto: 3333.34,
    });
    expect([a1, a2, a3]).toEqual([295.23, 295.23, 295.24]);
    expect(Math.round((a1 + a2 + a3) * 100) / 100).toBe(885.7);
  });

  it('sin comisión en el anticipo ⇒ 0 EXPLÍCITO (nunca provisiona Paywise)', () => {
    expect(
      comisionDeAplicacion({
        comision_anticipo: null,
        monto_anticipo: 10000,
        aplicado_previo: 0,
        comision_previa: 0,
        monto: 5000,
      }),
    ).toBe(0);
    expect(
      comisionDeAplicacion({
        comision_anticipo: 0,
        monto_anticipo: 10000,
        aplicado_previo: 0,
        comision_previa: 0,
        monto: 10000,
      }),
    ).toBe(0);
  });

  it('una sola aplicación que agota lleva la comisión completa', () => {
    expect(
      comisionDeAplicacion({
        comision_anticipo: 50,
        monto_anticipo: 1000,
        aplicado_previo: 0,
        comision_previa: 0,
        monto: 1000,
      }),
    ).toBe(50);
  });
});

describe('montoCuadraIngreso — regla 6.3 (±1.00)', () => {
  it('por NETO con comisión', () => {
    expect(
      montoCuadraIngreso(
        { monto: 19380, monto_bruto: null },
        { monto: 20400, comision_monto: 1020 },
      ),
    ).toEqual({ cuadra: true, diferencia: 0, por: 'NETO' });
  });

  it('tolerancia de 1.00 (y no más)', () => {
    expect(TOLERANCIA_INGRESO).toBe(1);
    expect(
      montoCuadraIngreso(
        { monto: 100, monto_bruto: null },
        { monto: 101, comision_monto: null },
      ).cuadra,
    ).toBe(true);
    const fuera = montoCuadraIngreso(
      { monto: 100, monto_bruto: null },
      { monto: 101.01, comision_monto: null },
    );
    expect(fuera).toEqual({ cuadra: false, diferencia: 1.01, por: null });
  });

  it('pasarela: bruto del ingreso contra el monto_bruto del abono', () => {
    expect(
      montoCuadraIngreso(
        { monto: 900, monto_bruto: 1000 },
        { monto: 1000, comision_monto: 80 },
      ),
    ).toEqual({ cuadra: true, diferencia: 0, por: 'BRUTO' });
  });

  it('bruto contra lo depositado cuando el banco no descontó la comisión', () => {
    expect(
      montoCuadraIngreso(
        { monto: 1000, monto_bruto: null },
        { monto: 1000, comision_monto: 30 },
      ).por,
    ).toBe('BRUTO');
  });
});

describe('estados de conciliación', () => {
  it('ingreso: conciliado / sin conciliar / no bancario', () => {
    expect(estadoConciliacionIngreso({ cuenta_bancaria_id: 'c' }, 'm')).toBe(
      'CONCILIADO',
    );
    expect(estadoConciliacionIngreso({ cuenta_bancaria_id: 'c' }, null)).toBe(
      'SIN_CONCILIAR',
    );
    expect(estadoConciliacionIngreso({ cuenta_bancaria_id: null }, null)).toBe(
      'NO_BANCARIO',
    );
  });

  it('cobro: la regla de «cobros sin banco»', () => {
    expect(
      estadoConciliacionCobro({ monto: 1, metodo: 'EFECTIVO', via: 'DIRECTO' }),
    ).toBe('CONCILIADO');
    expect(
      estadoConciliacionCobro({ monto: 1, metodo: 'PAYWISE', via: 'SOBRE' }),
    ).toBe('CONCILIADO');
    expect(
      estadoConciliacionCobro({
        monto: 1,
        metodo: 'TRANSFERENCIA',
        via: 'ANTICIPO',
      }),
    ).toBe('VIA_ANTICIPO');
    expect(
      estadoConciliacionCobro({ monto: 1, metodo: 'TRANSFERENCIA', via: null }),
    ).toBe('SIN_CONCILIAR');
    // BillPocket sin liga: depósito agrupado, no se concilia uno a uno.
    expect(
      estadoConciliacionCobro({ monto: 1, metodo: 'BILLPOCKET', via: null }),
    ).toBe('NO_BANCARIO');
    expect(
      estadoConciliacionCobro({ monto: 1, metodo: 'EFECTIVO', via: null }),
    ).toBe('NO_BANCARIO');
    // Reembolso (negativo) sin liga: nunca «sin conciliar».
    expect(
      estadoConciliacionCobro({
        monto: -100,
        metodo: 'TRANSFERENCIA',
        via: null,
      }),
    ).toBe('NO_BANCARIO');
  });
});

describe('vueloPorVolar', () => {
  it('estados tentativos/confirmado con fecha ≥ hoy o sin fecha', () => {
    expect(vueloPorVolar('RESERVA', '2026-10-01', '2026-09-24')).toBe(true);
    expect(vueloPorVolar('CONFIRMADO', '2026-09-24', '2026-09-24')).toBe(true);
    expect(vueloPorVolar('COTIZADO', null, '2026-09-24')).toBe(true);
    expect(vueloPorVolar('CONFIRMADO', '2026-09-20', '2026-09-24')).toBe(false);
    expect(vueloPorVolar('COMPLETADO', '2026-10-01', '2026-09-24')).toBe(false);
    expect(vueloPorVolar(null, null, '2026-09-24')).toBe(false);
  });
});

describe('textos', () => {
  it('campos de la bitácora', () => {
    expect(textoCampoBitacora('monto')).toBe('Monto');
    expect(textoCampoBitacora('cuenta_bancaria_id')).toBe('Cuenta');
    expect(textoCampoBitacora('algo_nuevo_id')).toBe('Algo nuevo');
  });

  it('búsqueda sin acentos', () => {
    expect(coincideBusqueda('león', ['Leticia Leon Alvarado'])).toBe(true);
    expect(coincideBusqueda('ING-12', ['ING-12'])).toBe(true);
    expect(coincideBusqueda('xyz', ['abc', null, 312])).toBe(false);
    expect(coincideBusqueda('', ['abc'])).toBe(true);
  });
});
