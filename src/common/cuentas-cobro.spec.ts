import {
  CUENTAS_COBRO,
  CUENTAS_COBRO_EXIGEN_FACTURA,
  METODOS_COBRO_EXIGEN_FACTURA_SIN_CUENTA,
  cobroExigeFactura,
  cuentaDeCobroTexto,
  cuentaExigeFactura,
  cuentasQueExigenFactura,
  origenCobroTexto,
  vueloExigeFactura,
} from './cuentas-cobro';

/**
 * FACTURA OBLIGATORIA POR CUENTA DE COBRO (13-oct-2026, invariante 60):
 * tabla de verdad de la regla pura. La cuenta MANDA (las cuatro de banco
 * exigen; Paywise no); sin cuenta o con una fuera del catálogo decide el
 * método (link HSBC / transferencia / cheque exigen); los reembolsos nunca.
 */
describe('cobroExigeFactura — tabla de verdad', () => {
  it('las cuatro cuentas de banco exigen con CUALQUIER método (hasta BillPocket)', () => {
    for (const cuenta of CUENTAS_COBRO_EXIGEN_FACTURA) {
      for (const metodo of [
        'BILLPOCKET',
        'EFECTIVO',
        'PAYWISE',
        'DOLARES',
        'OTRO',
        'TRANSFERENCIA',
        null,
      ]) {
        expect([
          cuenta,
          metodo,
          cobroExigeFactura({
            cuenta_destino: cuenta,
            metodo_cobro: metodo,
            monto: 100,
          }),
        ]).toEqual([cuenta, metodo, true]);
      }
    }
  });

  it("'Paywise' NO exige aunque el método sea transferencia", () => {
    expect(
      cobroExigeFactura({
        cuenta_destino: 'Paywise',
        metodo_cobro: 'TRANSFERENCIA',
        monto: 100,
      }),
    ).toBe(false);
  });

  it('la cuenta se recorta (espacios en los extremos)', () => {
    expect(
      cobroExigeFactura({
        cuenta_destino: '  HSBC Pesos  ',
        metodo_cobro: 'BILLPOCKET',
        monto: 1,
      }),
    ).toBe(true);
    expect(cuentaExigeFactura('  Paywise ')).toBe(false);
  });

  it('sin cuenta decide el método: HSBC_LINK / TRANSFERENCIA / CHEQUE exigen', () => {
    for (const metodo of ['HSBC_LINK', 'TRANSFERENCIA', 'CHEQUE']) {
      expect([
        metodo,
        cobroExigeFactura({ metodo_cobro: metodo, monto: 50 }),
      ]).toEqual([metodo, true]);
      expect([
        metodo,
        cobroExigeFactura({
          cuenta_destino: null,
          metodo_cobro: metodo,
          monto: 50,
        }),
      ]).toEqual([metodo, true]);
      expect([
        metodo,
        cobroExigeFactura({
          cuenta_destino: '',
          metodo_cobro: metodo,
          monto: 50,
        }),
      ]).toEqual([metodo, true]);
    }
    expect(METODOS_COBRO_EXIGEN_FACTURA_SIN_CUENTA).toEqual([
      'HSBC_LINK',
      'TRANSFERENCIA',
      'CHEQUE',
    ]);
  });

  it('sin cuenta: BILLPOCKET / EFECTIVO / PAYWISE / DOLARES / OTRO / null no exigen', () => {
    for (const metodo of [
      'BILLPOCKET',
      'EFECTIVO',
      'PAYWISE',
      'DOLARES',
      'OTRO',
      null,
      undefined,
      '',
    ]) {
      expect([
        metodo,
        cobroExigeFactura({ metodo_cobro: metodo, monto: 50 }),
      ]).toEqual([metodo, false]);
    }
  });

  it('cuenta DESCONOCIDA (legado fuera del catálogo) ⇒ decide el método', () => {
    expect(cuentaExigeFactura('Banamex')).toBeNull();
    expect(
      cobroExigeFactura({
        cuenta_destino: 'Banamex',
        metodo_cobro: 'TRANSFERENCIA',
        monto: 50,
      }),
    ).toBe(true);
    expect(
      cobroExigeFactura({
        cuenta_destino: 'Banamex',
        metodo_cobro: 'BILLPOCKET',
        monto: 50,
      }),
    ).toBe(false);
  });

  it('monto 0 / negativo (reembolso) / NaN / undefined / null ⇒ nunca exige', () => {
    for (const monto of [0, -100, Number.NaN, undefined, null, 'x']) {
      expect([
        monto,
        cobroExigeFactura({
          cuenta_destino: 'HSBC Pesos',
          metodo_cobro: 'TRANSFERENCIA',
          monto,
        }),
      ]).toEqual([monto, false]);
    }
    // El monto puede venir como texto numérico de PostgREST.
    expect(
      cobroExigeFactura({ cuenta_destino: 'HSBC Pesos', monto: '1000.50' }),
    ).toBe(true);
  });

  it('CUENTAS_COBRO_EXIGEN_FACTURA es subconjunto de CUENTAS_COBRO (Paywise fuera)', () => {
    for (const c of CUENTAS_COBRO_EXIGEN_FACTURA) {
      expect(CUENTAS_COBRO).toContain(c);
    }
    expect(CUENTAS_COBRO_EXIGEN_FACTURA).not.toContain('Paywise');
    expect(cuentaExigeFactura(null)).toBeNull();
    expect(cuentaExigeFactura(undefined)).toBeNull();
    expect(cuentaExigeFactura('')).toBeNull();
  });
});

describe('vueloExigeFactura — tri-estado del vuelo', () => {
  it('sin cobros ⇒ SIN_COBROS; solo reembolsos ⇒ SIN_COBROS', () => {
    expect(vueloExigeFactura([])).toBe('SIN_COBROS');
    expect(
      vueloExigeFactura([
        {
          cuenta_destino: 'HSBC Pesos',
          metodo_cobro: 'TRANSFERENCIA',
          monto: -500,
        },
      ]),
    ).toBe('SIN_COBROS');
  });

  it('mezcla con UNO que exige ⇒ EXIGE', () => {
    expect(
      vueloExigeFactura([
        { metodo_cobro: 'BILLPOCKET', monto: 100 },
        { metodo_cobro: 'EFECTIVO', monto: 100 },
        {
          cuenta_destino: 'Scotiabank Dólares',
          metodo_cobro: 'DOLARES',
          monto: 100,
        },
      ]),
    ).toBe('EXIGE');
  });

  // Revisión 13-oct-2026: la exigencia del VUELO es por el NETO de cada
  // cuenta (o método sin cuenta) y moneda — el reembolso se clasifica por SU
  // cuenta/método sin mirar el signo.
  it('anticipo por transferencia a HSBC Dólares devuelto COMPLETO (misma cuenta y moneda) ⇒ NO_EXIGE', () => {
    expect(
      vueloExigeFactura([
        {
          cuenta_destino: 'HSBC Dólares',
          metodo_cobro: 'TRANSFERENCIA',
          moneda: 'USD',
          monto: 1000,
        },
        {
          cuenta_destino: 'HSBC Dólares',
          metodo_cobro: 'TRANSFERENCIA',
          moneda: 'USD',
          monto: -1000,
        },
      ]),
    ).toBe('NO_EXIGE');
    // Transferencia sin cuenta devuelta y el vuelo pagado por BillPocket.
    expect(
      vueloExigeFactura([
        { metodo_cobro: 'TRANSFERENCIA', moneda: 'MXN', monto: 5000 },
        { metodo_cobro: 'TRANSFERENCIA', moneda: 'MXN', monto: -5000 },
        { metodo_cobro: 'BILLPOCKET', moneda: 'MXN', monto: 5000 },
      ]),
    ).toBe('NO_EXIGE');
  });

  it('reembolso PARCIAL ⇒ EXIGE (quedó dinero en la cuenta); centavos de redondeo no exigen', () => {
    expect(
      vueloExigeFactura([
        { cuenta_destino: 'HSBC Pesos', moneda: 'MXN', monto: 1000 },
        { cuenta_destino: 'HSBC Pesos', moneda: 'MXN', monto: -400 },
      ]),
    ).toBe('EXIGE');
    expect(
      vueloExigeFactura([
        { cuenta_destino: 'HSBC Pesos', moneda: 'MXN', monto: 0.1 },
        { cuenta_destino: 'HSBC Pesos', moneda: 'MXN', monto: 0.2 },
        { cuenta_destino: 'HSBC Pesos', moneda: 'MXN', monto: -0.3 },
      ]),
    ).toBe('NO_EXIGE');
  });

  it('el reembolso solo netea su MISMA cuenta/método y moneda: en efectivo, en otra moneda o sin moneda ⇒ sigue EXIGE (jamás se suman USD y MXN)', () => {
    const hsbc = {
      cuenta_destino: 'HSBC Dólares',
      metodo_cobro: 'TRANSFERENCIA',
      moneda: 'USD',
      monto: 1000,
    };
    for (const reembolso of [
      { metodo_cobro: 'EFECTIVO', moneda: 'USD', monto: -1000 },
      { cuenta_destino: 'HSBC Dólares', moneda: 'MXN', monto: -1000 },
      { cuenta_destino: 'HSBC Dólares', monto: -1000 },
    ]) {
      expect([reembolso, vueloExigeFactura([hsbc, reembolso])]).toEqual([
        reembolso,
        'EXIGE',
      ]);
    }
  });

  it('todos sin exigir ⇒ NO_EXIGE (y el reembolso no cuenta)', () => {
    expect(
      vueloExigeFactura([
        { metodo_cobro: 'BILLPOCKET', monto: 100 },
        { cuenta_destino: 'Paywise', metodo_cobro: 'PAYWISE', monto: 100 },
        {
          cuenta_destino: 'HSBC Pesos',
          metodo_cobro: 'TRANSFERENCIA',
          monto: -100,
        },
      ]),
    ).toBe('NO_EXIGE');
  });
});

describe('textos de cuenta/origen (con `etiquetaMetodoCobro`, nunca «HSBC link»)', () => {
  it('cuentaDeCobroTexto', () => {
    expect(cuentaDeCobroTexto({ cuenta_destino: 'HSBC Pesos' })).toBe(
      'HSBC Pesos',
    );
    expect(cuentaDeCobroTexto({ metodo_cobro: 'TRANSFERENCIA' })).toBe(
      'Transferencia sin cuenta destino',
    );
    expect(cuentaDeCobroTexto({ metodo_cobro: 'HSBC_LINK' })).toBe(
      'Link de pago (HSBC) sin cuenta destino',
    );
    expect(
      cuentaDeCobroTexto({ cuenta_destino: '  ', metodo_cobro: 'CHEQUE' }),
    ).toBe('Cheque sin cuenta destino');
  });

  it('origenCobroTexto', () => {
    expect(origenCobroTexto({ cuenta_destino: 'HSBC Pesos' })).toBe(
      'en HSBC Pesos',
    );
    expect(origenCobroTexto({ metodo_cobro: 'TRANSFERENCIA' })).toBe(
      'por Transferencia',
    );
    expect(origenCobroTexto({ metodo_cobro: 'HSBC_LINK' })).toBe(
      'por Link de pago (HSBC)',
    );
    expect(origenCobroTexto({ metodo_cobro: 'CHEQUE' })).toBe('por Cheque');
  });

  it('cuentasQueExigenFactura: distintas, en orden, solo de las que exigen y en las que QUEDÓ dinero (neto por moneda)', () => {
    expect(
      cuentasQueExigenFactura([
        {
          cuenta_destino: 'Scotiabank Pesos',
          metodo_cobro: 'TRANSFERENCIA',
          moneda: 'MXN',
          monto: 10,
        },
        { metodo_cobro: 'BILLPOCKET', moneda: 'MXN', monto: 10 },
        { metodo_cobro: 'TRANSFERENCIA', moneda: 'MXN', monto: 10 },
        {
          cuenta_destino: 'Scotiabank Pesos',
          metodo_cobro: 'CHEQUE',
          moneda: 'MXN',
          monto: 10,
        },
        // Devuelto completo en la MISMA cuenta y moneda: no queda nada.
        {
          cuenta_destino: 'HSBC Dólares',
          metodo_cobro: 'DOLARES',
          moneda: 'USD',
          monto: 10,
        },
        {
          cuenta_destino: 'HSBC Dólares',
          metodo_cobro: 'DOLARES',
          moneda: 'USD',
          monto: -10,
        },
      ]),
    ).toEqual(['Scotiabank Pesos', 'Transferencia sin cuenta destino']);
    // La MISMA transferencia sin cuenta en USD y en MXN es UNA cuenta texto.
    expect(
      cuentasQueExigenFactura([
        { metodo_cobro: 'TRANSFERENCIA', moneda: 'USD', monto: 10 },
        { metodo_cobro: 'TRANSFERENCIA', moneda: 'MXN', monto: 10 },
        { metodo_cobro: 'TRANSFERENCIA', moneda: 'MXN', monto: -10 },
      ]),
    ).toEqual(['Transferencia sin cuenta destino']);
    // Lector sin `moneda`: el reembolso no netea (jamás se suman monedas).
    expect(
      cuentasQueExigenFactura([
        { cuenta_destino: 'HSBC Dólares', metodo_cobro: 'DOLARES', monto: 10 },
        { cuenta_destino: 'HSBC Dólares', metodo_cobro: 'DOLARES', monto: -10 },
      ]),
    ).toEqual(['HSBC Dólares']);
    expect(cuentasQueExigenFactura([])).toEqual([]);
  });
});
