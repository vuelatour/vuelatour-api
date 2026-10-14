import { cobrosEnUsd } from './cobros-usd.util';
import {
  CUENTAS_COBRO,
  CUENTAS_COBRO_EXIGEN_FACTURA,
  METODOS_COBRO_EXIGEN_FACTURA_SIN_CUENTA,
  cobroExigeFactura,
  cuentaDeCobroTexto,
  cuentaExigeFactura,
  cuentasQueExigenFactura,
  devolucionCruzadaCompleta,
  dineroDevueltoCompleto,
  origenCobroTexto,
  origenesQueExigenFactura,
  sumaPorMoneda,
  vueloExigeFactura,
  type CobroExigeFacturaRow,
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

  // Decisión del cliente del 14-oct-2026 («¿Un anticipo devuelto lleva
  // CFDI?» ⇒ «eso no»): el caso EN EFECTIVO se INVIERTE (regla 1: la moneda
  // quedó en cero); en otra moneda SIN T.C. y sin moneda sigue EXIGE.
  it('devuelto COMPLETO en efectivo (misma moneda) ⇒ NO_EXIGE (regla 1, se invierte el 14-oct-2026)', () => {
    expect(
      vueloExigeFactura([
        {
          cuenta_destino: 'HSBC Dólares',
          metodo_cobro: 'TRANSFERENCIA',
          moneda: 'USD',
          monto: 1000,
        },
        { metodo_cobro: 'EFECTIVO', moneda: 'USD', monto: -1000 },
      ]),
    ).toBe('NO_EXIGE');
  });

  it('devuelto en OTRA moneda sin T.C. o SIN moneda ⇒ sigue EXIGE (jamás se suman USD y MXN)', () => {
    const hsbc = {
      cuenta_destino: 'HSBC Dólares',
      metodo_cobro: 'TRANSFERENCIA',
      moneda: 'USD',
      monto: 1000,
    };
    for (const reembolso of [
      { cuenta_destino: 'HSBC Dólares', moneda: 'MXN', monto: -1000 },
      { cuenta_destino: 'HSBC Dólares', monto: -1000 },
    ]) {
      const filas = [hsbc, reembolso];
      // Con o sin `cobrado` (MXN sin T.C. ⇒ sin_tc_count 1; sin moneda ⇒
      // no es USD ni MXN): la regla 2 no aplica.
      expect([reembolso, vueloExigeFactura(filas)]).toEqual([
        reembolso,
        'EXIGE',
      ]);
      expect([
        reembolso,
        vueloExigeFactura(filas, cobrosEnUsd(filas, null)),
      ]).toEqual([reembolso, 'EXIGE']);
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

/**
 * ANTICIPO DEVUELTO (decisión del cliente del 14-oct-2026, API 0.0.77): la
 * tabla de verdad COMPLETA de la spec (T1–T8, N1–N16, R1–R7′, #215 de
 * producción y los bordes 1.00 / 1.01), con `cobrado` armado por la fuente
 * única `cobrosEnUsd(cobros, vuelo.tc_usd_mxn)` (las cifras de la tabla).
 * Regla 1: por moneda, exacta y sin T.C. Regla 2: SOLO en devolución
 * CRUZADA (alguna moneda negativa) y ≤ 1 USD. Revisión F1: R1, R2, R3, R5 y
 * R6 (parciales a ≤ 1 USD en la MISMA moneda) siguen EXIGIENDO.
 */
const HD = (monto: number): CobroExigeFacturaRow => ({
  cuenta_destino: 'HSBC Dólares',
  metodo_cobro: 'TRANSFERENCIA',
  moneda: 'USD',
  monto,
});
const HP = (monto: number, tc: number | null = 17.3): CobroExigeFacturaRow => ({
  cuenta_destino: 'HSBC Pesos',
  metodo_cobro: 'TRANSFERENCIA',
  moneda: 'MXN',
  monto,
  ...(tc != null ? { tc_usd_mxn: tc } : {}),
});
const EF = (
  moneda: 'USD' | 'MXN',
  monto: number,
  tc?: number,
): CobroExigeFacturaRow => ({
  metodo_cobro: 'EFECTIVO',
  moneda,
  monto,
  ...(tc ? { tc_usd_mxn: tc } : {}),
});
const MXN = (
  metodo: string,
  monto: number,
  tc?: number,
  cuenta?: string,
): CobroExigeFacturaRow => ({
  ...(cuenta ? { cuenta_destino: cuenta } : {}),
  metodo_cobro: metodo,
  moneda: 'MXN',
  monto,
  ...(tc ? { tc_usd_mxn: tc } : {}),
});
/** T.C. de #215 en producción (vuelo.tc_usd_mxn). */
const TC_215 = 17.300002;

interface CasoTabla {
  caso: string;
  filas: CobroExigeFacturaRow[];
  tcVuelo: number | null;
  cobradoUsd: number;
  sinTc: number;
  nueva: 'EXIGE' | 'NO_EXIGE' | 'SIN_COBROS';
  cuentas: string[];
}

const TABLA: CasoTabla[] = [
  {
    caso: 'T1 misma cuenta',
    filas: [HD(1000), HD(-1000)],
    tcVuelo: null,
    cobradoUsd: 0,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'T2 transferencia sin cuenta devuelta + BillPocket',
    filas: [
      MXN('TRANSFERENCIA', 5000),
      MXN('TRANSFERENCIA', -5000),
      MXN('BILLPOCKET', 5000),
    ],
    tcVuelo: null,
    cobradoUsd: 0,
    sinTc: 3,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'T3 parcial HSBC Pesos 1,000 − 400',
    filas: [HP(1000, null), HP(-400, null)],
    tcVuelo: null,
    cobradoUsd: 0,
    sinTc: 2,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'T4 centavos 0.1 + 0.2 − 0.3',
    filas: [HP(0.1, null), HP(0.2, null), HP(-0.3, null)],
    tcVuelo: null,
    cobradoUsd: 0,
    sinTc: 3,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'T5 (SE INVIERTE) devuelto en EFECTIVO USD',
    filas: [HD(1000), EF('USD', -1000)],
    tcVuelo: null,
    cobradoUsd: 0,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'T6 otra moneda sin T.C.',
    filas: [
      HD(1000),
      { cuenta_destino: 'HSBC Dólares', moneda: 'MXN', monto: -1000 },
    ],
    tcVuelo: null,
    cobradoUsd: 1000,
    sinTc: 1,
    nueva: 'EXIGE',
    cuentas: ['HSBC Dólares'],
  },
  {
    caso: 'T7 reembolso SIN moneda',
    filas: [HD(1000), { cuenta_destino: 'HSBC Dólares', monto: -1000 }],
    tcVuelo: null,
    cobradoUsd: 1000,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Dólares'],
  },
  {
    caso: 'T8 todos sin exigir',
    filas: [
      { metodo_cobro: 'BILLPOCKET', monto: 100 },
      { cuenta_destino: 'Paywise', metodo_cobro: 'PAYWISE', monto: 100 },
      {
        cuenta_destino: 'HSBC Pesos',
        metodo_cobro: 'TRANSFERENCIA',
        monto: -100,
      },
    ],
    tcVuelo: null,
    cobradoUsd: 0,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'N1 por transferencia SIN cuenta',
    filas: [HP(30000), MXN('TRANSFERENCIA', -30000, 17.3)],
    tcVuelo: TC_215,
    cobradoUsd: 0,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'N2 desde Scotiabank Pesos',
    filas: [HP(30000), MXN('TRANSFERENCIA', -30000, 17.3, 'Scotiabank Pesos')],
    tcVuelo: TC_215,
    cobradoUsd: 0,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'N3 sin cuenta devuelta con cuenta',
    filas: [MXN('TRANSFERENCIA', 13195, 17), HP(-13195, 17)],
    tcVuelo: 17,
    cobradoUsd: 0,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'N4 mismos pesos a otro T.C.',
    filas: [HP(30000), EF('MXN', -30000, 17.5)],
    tcVuelo: TC_215,
    cobradoUsd: 19.82,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'N5 USD devuelto en MXN (cruzada)',
    filas: [HD(1000), HP(-17500, 17.5)],
    tcVuelo: 17.5,
    cobradoUsd: 0,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'N6 MXN devuelto en USD (cruzada)',
    filas: [HP(30000), EF('USD', -1733.53)],
    tcVuelo: TC_215,
    cobradoUsd: 0.57,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'N7 pesos devueltos, dólares en efectivo retenidos (excepción consciente)',
    filas: [
      HP(10000, 17),
      EF('MXN', -10000, 17),
      { metodo_cobro: 'DOLARES', moneda: 'USD', monto: 500 },
    ],
    tcVuelo: 17,
    cobradoUsd: 500,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'N8 parcial (penalización 1,500)',
    filas: [HP(30000), EF('MXN', -28500, 17.3)],
    tcVuelo: TC_215,
    cobradoUsd: 86.71,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'N9 ambiguo en una moneda',
    filas: [HP(15000), MXN('BILLPOCKET', 15000, 17.3), EF('MXN', -15000, 17.3)],
    tcVuelo: TC_215,
    cobradoUsd: 867.05,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'N10 cruzada que retiene 28.57 USD',
    filas: [HD(1000), HP(-17000, 17.5)],
    tcVuelo: 17.5,
    cobradoUsd: 28.57,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Dólares'],
  },
  {
    caso: 'N11 MXN sin ningún T.C. + reembolso USD',
    filas: [HP(17500, null), EF('USD', -1000)],
    tcVuelo: null,
    cobradoUsd: -1000,
    sinTc: 1,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'N12 sin reembolso',
    filas: [HP(240, 17)],
    tcVuelo: 17,
    cobradoUsd: 14.12,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'N13 solo un reembolso',
    filas: [EF('USD', -100)],
    tcVuelo: null,
    cobradoUsd: -100,
    sinTc: 0,
    nueva: 'SIN_COBROS',
    cuentas: [],
  },
  {
    caso: 'N14 ambiguo con un BillPocket nuevo',
    filas: [HP(30000), EF('MXN', -30000, 17.3), MXN('BILLPOCKET', 5000, 17.3)],
    tcVuelo: TC_215,
    cobradoUsd: 289.02,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'N15 todo devuelto en dólares',
    filas: [HP(30000), HD(1000), EF('USD', -2734.1)],
    tcVuelo: TC_215,
    cobradoUsd: 0,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'N16 parcial en dólares',
    filas: [HP(30000), HD(1000), EF('USD', -1500)],
    tcVuelo: TC_215,
    cobradoUsd: 1234.1,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'R1 misma cuenta retiene 17 MXN (F1)',
    filas: [HP(30000), HP(-29983)],
    tcVuelo: TC_215,
    cobradoUsd: 0.98,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'R2 misma cuenta retiene 0.99 USD (F1)',
    filas: [HD(1000), HD(-999.01)],
    tcVuelo: null,
    cobradoUsd: 0.99,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Dólares'],
  },
  {
    caso: 'R3 retiene 10,000 MXN a T.C. 11.534 (F1)',
    filas: [HP(30000), EF('MXN', -20000, 11.534)],
    tcVuelo: TC_215,
    cobradoUsd: 0.1,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'R5 penalización al T.C. mínimo del candado (F1)',
    filas: [HP(30000), EF('MXN', -28500, 16.4351)],
    tcVuelo: TC_215,
    cobradoUsd: 0.01,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'R5 por transferencia sin cuenta (F1)',
    filas: [HP(30000), MXN('TRANSFERENCIA', -28500, 16.4351)],
    tcVuelo: TC_215,
    cobradoUsd: 0.01,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'R6 mixto (F1)',
    filas: [HP(30000), HD(1000), EF('USD', -1000), EF('MXN', -28500, 16.44)],
    tcVuelo: TC_215,
    cobradoUsd: 0.53,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: 'R7 pesos devueltos, dólares directos retenidos (F4)',
    filas: [
      HP(17500, 17.5),
      { metodo_cobro: 'DOLARES', moneda: 'USD', monto: 1000 },
      EF('MXN', -17500, 17.5),
    ],
    tcVuelo: 17.5,
    cobradoUsd: 1000,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'R7′ control en la misma moneda',
    filas: [
      HP(17500, 17.5),
      MXN('BILLPOCKET', 17500, 17.5),
      EF('MXN', -17500, 17.5),
    ],
    tcVuelo: 17.5,
    cobradoUsd: 1000,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Pesos'],
  },
  {
    caso: '#215 de producción (BillPocket − efectivo)',
    filas: [MXN('BILLPOCKET', 30000, 17.3), EF('MXN', -14250, 17.2414)],
    tcVuelo: TC_215,
    cobradoUsd: 907.61,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'Borde 1.00',
    filas: [HD(1001), HP(-17500, 17.5)],
    tcVuelo: 17.5,
    cobradoUsd: 1,
    sinTc: 0,
    nueva: 'NO_EXIGE',
    cuentas: [],
  },
  {
    caso: 'Borde 1.01',
    filas: [HD(1001.01), HP(-17500, 17.5)],
    tcVuelo: 17.5,
    cobradoUsd: 1.01,
    sinTc: 0,
    nueva: 'EXIGE',
    cuentas: ['HSBC Dólares'],
  },
];

describe('anticipo devuelto (14-oct-2026) — tabla de verdad con `cobrado`', () => {
  it.each(TABLA)('$caso', (t) => {
    const cobrado = cobrosEnUsd(t.filas, t.tcVuelo);
    expect([t.caso, cobrado.total_usd, cobrado.sin_tc_count]).toEqual([
      t.caso,
      t.cobradoUsd,
      t.sinTc,
    ]);
    expect([t.caso, vueloExigeFactura(t.filas, cobrado)]).toEqual([
      t.caso,
      t.nueva,
    ]);
    expect([t.caso, cuentasQueExigenFactura(t.filas, cobrado)]).toEqual([
      t.caso,
      t.cuentas,
    ]);
  });

  it('sin `cobrado` solo aplica la regla 1: las devoluciones CRUZADAS siguen exigiendo (N5, N6, N15, borde 1.00)', () => {
    for (const c of ['N5', 'N6', 'N15', 'Borde 1.00']) {
      const t = TABLA.find((x) => x.caso.startsWith(c))!;
      expect([c, vueloExigeFactura(t.filas)]).toEqual([c, 'EXIGE']);
      expect([c, vueloExigeFactura(t.filas, null)]).toEqual([c, 'EXIGE']);
    }
    // La regla 1 no necesita T.C.: N1–N4 y T5 sin `cobrado` también.
    for (const c of ['N1', 'N2', 'N3', 'N4', 'T5']) {
      const t = TABLA.find((x) => x.caso.startsWith(c))!;
      expect([c, vueloExigeFactura(t.filas)]).toEqual([c, 'NO_EXIGE']);
    }
  });

  it('sin reembolsos la regla nueva da EXACTAMENTE lo de antes (con y sin `cobrado`)', () => {
    for (const filas of [
      [HP(240, 17)],
      [MXN('BILLPOCKET', 100, 17)],
      [HD(1000), MXN('BILLPOCKET', 100, 17)],
      [{ metodo_cobro: 'TRANSFERENCIA', monto: 50 }],
    ]) {
      expect(vueloExigeFactura(filas, cobrosEnUsd(filas, 17))).toBe(
        vueloExigeFactura(filas),
      );
    }
  });
});

describe('sumaPorMoneda / devolucionCruzadaCompleta / dineroDevueltoCompleto / origenesQueExigenFactura', () => {
  it('sumaPorMoneda: Σ por moneda de cobros Y reembolsos de cualquier cuenta; el reembolso sin moneda no entra', () => {
    const s = sumaPorMoneda([
      HD(1000),
      HP(-17500, 17.5),
      EF('USD', -200),
      { cuenta_destino: 'HSBC Dólares', monto: -5 },
      { monto: 0, moneda: 'USD' },
    ]);
    expect([...s.entries()]).toEqual([
      ['USD', 800],
      ['MXN', -17500],
    ]);
  });

  it('devolucionCruzadaCompleta: SOLO con una moneda negativa, cobro y reembolso, USD/MXN, todo convertido y ≤ 1 USD', () => {
    const cobrado = (filas: CobroExigeFacturaRow[], tc: number | null) =>
      cobrosEnUsd(filas, tc);
    // Sin moneda negativa ⇒ false aunque lo cobrado quede ≤ 1 USD (R2, F1).
    const r2 = [HD(1000), HD(-999.01)];
    expect(cobrado(r2, null).total_usd).toBe(0.99);
    expect(devolucionCruzadaCompleta(r2, cobrado(r2, null))).toBe(false);
    // Sin reembolso ⇒ false; solo reembolso ⇒ false.
    expect(
      devolucionCruzadaCompleta([HD(1000)], { total_usd: 0, sin_tc_count: 0 }),
    ).toBe(false);
    expect(
      devolucionCruzadaCompleta([EF('USD', -100)], {
        total_usd: -100,
        sin_tc_count: 0,
      }),
    ).toBe(false);
    // Una fila sin moneda ⇒ false.
    const sinMoneda = [
      HD(1000),
      HP(-17500, 17.5),
      { cuenta_destino: 'HSBC Dólares', monto: -1 },
    ];
    expect(
      devolucionCruzadaCompleta(sinMoneda, { total_usd: 0, sin_tc_count: 0 }),
    ).toBe(false);
    // sin_tc_count > 0 ⇒ false; sin `cobrado` ⇒ false.
    const n5 = [HD(1000), HP(-17500, 17.5)];
    expect(
      devolucionCruzadaCompleta(n5, { total_usd: 0, sin_tc_count: 1 }),
    ).toBe(false);
    expect(devolucionCruzadaCompleta(n5)).toBe(false);
    expect(devolucionCruzadaCompleta(n5, null)).toBe(false);
    expect(devolucionCruzadaCompleta(n5, cobrado(n5, 17.5))).toBe(true);
    // Bordes: 1.00 ⇒ true; 1.01 ⇒ false.
    const b100 = [HD(1001), HP(-17500, 17.5)];
    const b101 = [HD(1001.01), HP(-17500, 17.5)];
    expect(devolucionCruzadaCompleta(b100, cobrado(b100, 17.5))).toBe(true);
    expect(devolucionCruzadaCompleta(b101, cobrado(b101, 17.5))).toBe(false);
  });

  it('dineroDevueltoCompleto: N4 sí, N8 no, #215 no, solo reembolso no; la cruzada solo con `cobrado`', () => {
    const t = (c: string) => TABLA.find((x) => x.caso.startsWith(c))!;
    const con = (c: string) =>
      dineroDevueltoCompleto(t(c).filas, cobrosEnUsd(t(c).filas, t(c).tcVuelo));
    expect(con('N4')).toBe(true);
    expect(con('N8')).toBe(false);
    expect(con('#215')).toBe(false);
    expect(con('N13')).toBe(false);
    expect(con('T1')).toBe(true);
    expect(con('N5')).toBe(true);
    expect(dineroDevueltoCompleto(t('N5').filas)).toBe(false);
    // Sin reembolso, nunca.
    expect(con('N12')).toBe(false);
  });

  it('origenesQueExigenFactura: «en HSBC Pesos» / «por Transferencia», distintos, solo grupos con neto > 0.005', () => {
    expect(origenesQueExigenFactura([HP(1000, 17)])).toEqual(['en HSBC Pesos']);
    expect(
      origenesQueExigenFactura([
        { metodo_cobro: 'TRANSFERENCIA', moneda: 'MXN', monto: 100 },
        { metodo_cobro: 'TRANSFERENCIA', moneda: 'USD', monto: 10 },
        HP(1000, 17),
        MXN('BILLPOCKET', 100, 17),
      ]),
    ).toEqual(['por Transferencia', 'en HSBC Pesos']);
    // Devuelto completo (regla 1) o cruzada con `cobrado` (regla 2) ⇒ [].
    expect(origenesQueExigenFactura([HD(1000), EF('USD', -1000)])).toEqual([]);
    const n5 = [HD(1000), HP(-17500, 17.5)];
    expect(origenesQueExigenFactura(n5, cobrosEnUsd(n5, 17.5))).toEqual([]);
    expect(origenesQueExigenFactura(n5)).toEqual(['en HSBC Dólares']);
  });
});
