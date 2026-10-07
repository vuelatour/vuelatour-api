import {
  COMISIONES_AL_AVION_DESDE_DEFAULT,
  SUFIJO_COMISION_BANCO_PARTE_VUELATOUR,
  aplicaComisionesAlAvion,
  comisionesDelVuelo,
  conceptoVendedorACargoDelAvion,
  etiquetaReglaComisiones,
  fmtMxnNota,
  fmtPctNota,
  type ComisionesDelVueloInput,
} from './comisiones-avion.util';
import {
  particionIngresoVuelo,
  type VueloIngresoInput,
} from './ingreso-vuelo.util';
import {
  participacionPorAeronave,
  repartirUsd,
} from './participacion-aeronave.util';

/**
 * COMISIONES A CARGO DEL AVIÓN (6-oct-2026, API 0.0.65): fuente única del
 * balance por avión y del reparto a socios. Casos del contrato: antes/después
 * de la vigencia, cobro USD con T.C., sin comisión, multi-avión (parte),
 * vendedor sin comisión, IVA 0 %.
 */

const VIGENCIA = COMISIONES_AL_AVION_DESDE_DEFAULT;
/** Un solo avión: la parte es el monto tal cual (como `parteAvion`). */
const todo = (m: number) => m;

/** Vuelo #235 real (2-sep-2026): 1,200 USD de tiempo, sin extras ni IVA. */
const V235: VueloIngresoInput = {
  monto_total_usd: 1200,
  subtotal_vuelo_usd: 1200,
  ajuste_final_usd: 0,
  comision_vendedor_usd: 0,
  iva_usd: 0,
  iva_pct: 0,
  tuas_usd: 0,
  extras_total_usd: 0,
  viaticos_pernocta_usd: 0,
  calculo_snapshot: null,
};

/**
 * Mundo de los specs de los libros (#501): 2,000 de tiempo + 100 TUAS + 50
 * extras + 80 de comisión del vendedor, sin IVA ⇒ factor del avión
 * 2000 / 2230.
 */
const V501: VueloIngresoInput = {
  monto_total_usd: 2230,
  subtotal_vuelo_usd: 2000,
  ajuste_final_usd: 0,
  comision_vendedor_usd: 80,
  iva_usd: 0,
  iva_pct: 0,
  tuas_usd: 100,
  extras_total_usd: 50,
  viaticos_pernocta_usd: 0,
  calculo_snapshot: null,
};

/** Vuelo real tipo #247 (Pablo Canales): comisión 278 USD + IVA 16 %. */
const V247: VueloIngresoInput = {
  monto_total_usd: 2306.08,
  subtotal_vuelo_usd: 1710,
  ajuste_final_usd: 0,
  comision_vendedor_usd: 278,
  iva_usd: 318.08,
  iva_pct: 0.16,
  tuas_usd: 0,
  extras_total_usd: 0,
  viaticos_pernocta_usd: 0,
  calculo_snapshot: null,
};

function entrada(
  extra: Partial<ComisionesDelVueloInput> & { vuelo?: VueloIngresoInput },
): ComisionesDelVueloInput {
  const { vuelo, ...resto } = extra;
  return {
    diaVuelo: '2026-09-10',
    vigenteDesde: VIGENCIA,
    cobros: [],
    tcVenta: 20,
    particion: particionIngresoVuelo(vuelo ?? V235),
    cancelado: false,
    parteAvion: todo,
    participacion: 1,
    vendedorNombre: null,
    ...resto,
  };
}

const cobroMxn = (
  comision: number | null,
  extra: Record<string, unknown> = {},
) => ({
  moneda: 'MXN',
  tc_usd_mxn: 17,
  comision_banco_monto: comision,
  comision_banco_pct: 5,
  metodo_cobro: 'TRANSFERENCIA',
  ...extra,
});

describe('aplicaComisionesAlAvion — vigencia por día Cancún del vuelo', () => {
  it('default: 1-sep-2026 (el cierre de septiembre)', () => {
    expect(COMISIONES_AL_AVION_DESDE_DEFAULT).toBe('2026-09-01');
  });

  it('el mismo día de la vigencia sí; el día anterior no; sin día no', () => {
    expect(aplicaComisionesAlAvion('2026-09-01', VIGENCIA)).toBe(true);
    expect(aplicaComisionesAlAvion('2026-10-06', VIGENCIA)).toBe(true);
    expect(aplicaComisionesAlAvion('2026-08-31', VIGENCIA)).toBe(false);
    expect(aplicaComisionesAlAvion(null, VIGENCIA)).toBe(false);
    expect(aplicaComisionesAlAvion(undefined, VIGENCIA)).toBe(false);
    expect(aplicaComisionesAlAvion('basura', VIGENCIA)).toBe(false);
  });
});

describe('comisionesDelVuelo', () => {
  it('ANTES de la vigencia: no aplica y todo en 0 (aunque haya comisiones)', () => {
    const r = comisionesDelVuelo(
      entrada({
        diaVuelo: '2026-08-31',
        vuelo: V501,
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
      }),
    );
    expect(r).toEqual({
      aplica: false,
      banco_mxn: 0,
      banco_usd: 0,
      vendedor_mxn: 0,
      vendedor_usd: 0,
      total_mxn: 0,
      total_usd: 0,
      detalle: [],
      banco_sin_tc: 0,
      vendedor_sin_tc: false,
    });
  });

  it('caso del contrato (#235): comisión bancaria 5 % de 20,400 con el avión al 100 %', () => {
    const r = comisionesDelVuelo(
      entrada({ cobros: [cobroMxn(1020, { tc_usd_mxn: 17 })] }),
    );
    expect(r).toEqual({
      aplica: true,
      banco_mxn: 1020,
      banco_usd: 60,
      vendedor_mxn: 0,
      vendedor_usd: 0,
      total_mxn: 1020,
      total_usd: 60,
      detalle: [
        'Comisión bancaria · Transferencia 5 % · $1,020.00 (parte del avión 100 %)',
      ],
      banco_sin_tc: 0,
      vendedor_sin_tc: false,
    });
  });

  it('sin comisión bancaria ni del vendedor: aplica, todo en 0 y sin nota', () => {
    const r = comisionesDelVuelo(
      entrada({ cobros: [cobroMxn(null), cobroMxn(0)] }),
    );
    expect(r.aplica).toBe(true);
    expect(r.total_mxn).toBe(0);
    expect(r.total_usd).toBe(0);
    expect(r.detalle).toEqual([]);
  });

  it('parte de VuelaTour en el vuelo: la comisión se prorratea con el MISMO factor del cobro y se suma la provisión del vendedor', () => {
    const p = particionIngresoVuelo(V501);
    expect(p.factor_avion).toBeCloseTo(2000 / 2230, 12);
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        cobros: [
          {
            moneda: 'MXN',
            tc_usd_mxn: 20,
            comision_banco_monto: 350,
            comision_banco_pct: null,
            metodo_cobro: null,
          },
        ],
        vendedorNombre: 'Vendedor Uno',
      }),
    );
    // 350 × 0.896861 = 313.90 (MXN); 350 ÷ 20 = 17.50 USD × factor = 15.70.
    expect(r.banco_mxn).toBe(313.9);
    expect(r.banco_usd).toBe(15.7);
    // Comisión 80 USD sin IVA × K 20.
    expect(r.vendedor_usd).toBe(80);
    expect(r.vendedor_mxn).toBe(1600);
    expect(r.total_mxn).toBe(1913.9);
    expect(r.total_usd).toBe(95.7);
    expect(r.detalle).toEqual([
      '2 conceptos',
      'Comisión bancaria · $350.00 (parte del avión 89.69 %: $313.90)',
      'Comisión vendedor (Vendedor Uno) · $1,600.00 · provisión = cotizado (sin IVA)',
    ]);
  });

  it('IVA 16 %: la provisión es comisión + su IVA (pagoVendedorUsd) al K del vuelo', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V247,
        tcVenta: 16.956,
        vendedorNombre: 'Pablo Canales',
      }),
    );
    // 278 + 44.48 = 322.48 USD × 16.956 = 5,467.97.
    expect(r.vendedor_usd).toBe(322.48);
    expect(r.vendedor_mxn).toBe(5467.97);
    expect(r.banco_mxn).toBe(0);
    expect(r.detalle).toEqual([
      'Comisión vendedor (Pablo Canales) · $5,467.97 · provisión = cotizado + IVA',
    ]);
  });

  it('IVA 0 %: la provisión es solo la comisión cotizada', () => {
    const r = comisionesDelVuelo(entrada({ vuelo: V501, tcVenta: 17.5 }));
    expect(r.vendedor_usd).toBe(80);
    expect(r.vendedor_mxn).toBe(1400);
    expect(r.detalle).toEqual([
      'Comisión vendedor · $1,400.00 · provisión = cotizado (sin IVA)',
    ]);
  });

  it('vendedor SIN comisión cotizada: solo la bancaria (sin encabezado)', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: { ...V501, comision_vendedor_usd: 0, monto_total_usd: 2150 },
        cobros: [cobroMxn(500, { tc_usd_mxn: 20 })],
        vendedorNombre: 'Nadie',
      }),
    );
    expect(r.vendedor_mxn).toBe(0);
    expect(r.vendedor_usd).toBe(0);
    expect(r.detalle).toHaveLength(1);
    expect(r.detalle[0]).toMatch(/^Comisión bancaria · Transferencia 5 % · /);
  });

  it('cobro en USD con su T.C.: MXN = comisión × T.C. del cobro y USD tal cual', () => {
    const r = comisionesDelVuelo(
      entrada({
        cobros: [
          {
            moneda: 'USD',
            tc_usd_mxn: 18,
            comision_banco_monto: 50,
            comision_banco_pct: 4.2,
            metodo_cobro: 'HSBC_LINK',
          },
        ],
      }),
    );
    expect(r.banco_mxn).toBe(900);
    expect(r.banco_usd).toBe(50);
    expect(r.detalle).toEqual([
      'Comisión bancaria · Link de pago (HSBC) 4.2 % · $50.00 USD = $900.00 (parte del avión 100 %)',
    ]);
  });

  it('cobro en USD SIN T.C. propio: toma el K del vuelo', () => {
    const r = comisionesDelVuelo(
      entrada({
        tcVenta: 19,
        cobros: [
          {
            moneda: 'USD',
            tc_usd_mxn: null,
            comision_banco_monto: 10,
            metodo_cobro: 'TRANSFERENCIA',
          },
        ],
      }),
    );
    expect(r.banco_mxn).toBe(190);
    expect(r.banco_usd).toBe(10);
    expect(r.banco_sin_tc).toBe(0);
  });

  it('cobro en USD sin NINGÚN T.C.: no suma en pesos (sí en USD) y la nota lo dice', () => {
    const r = comisionesDelVuelo(
      entrada({
        tcVenta: null,
        cobros: [
          {
            moneda: 'USD',
            tc_usd_mxn: null,
            comision_banco_monto: 10,
            metodo_cobro: 'TRANSFERENCIA',
          },
        ],
      }),
    );
    expect(r.banco_mxn).toBe(0);
    expect(r.banco_usd).toBe(10);
    expect(r.banco_sin_tc).toBe(1);
    expect(r.detalle).toEqual([
      'Comisión bancaria · Transferencia · $10.00 USD sin T.C. — no suma',
    ]);
  });

  it('cobro MXN sin T.C. propio: el USD sale con el K del vuelo (cadena de cobrosEnUsd)', () => {
    const r = comisionesDelVuelo(
      entrada({
        tcVenta: 20,
        cobros: [cobroMxn(100, { tc_usd_mxn: null })],
      }),
    );
    expect(r.banco_mxn).toBe(100);
    expect(r.banco_usd).toBe(5);
  });

  it('MULTI-AVIÓN: cada avión lleva su parte por tramo (repartirUsd) y Σ de los aviones == comisión × factor', () => {
    const vuelo = { aeronave_id: 'av-a', calculo_snapshot: null };
    const part = participacionPorAeronave(vuelo, [
      { id: 'e1', orden: 1, aeronave_id: null, cancelada_at: null },
      { id: 'e2', orden: 2, aeronave_id: 'av-b', cancelada_at: null },
    ]);
    const parteDe = (avion: string) => (m: number) =>
      repartirUsd(m, part).get(avion) ?? 0;
    const comun = {
      vuelo: V247,
      tcVenta: 18,
      cobros: [cobroMxn(630.01, { tc_usd_mxn: 18 })],
      participacion: 0.5,
      vendedorNombre: 'Pablo Canales',
    };
    const a = comisionesDelVuelo(
      entrada({ ...comun, parteAvion: parteDe('av-a') }),
    );
    const b = comisionesDelVuelo(
      entrada({ ...comun, parteAvion: parteDe('av-b') }),
    );
    const factor = particionIngresoVuelo(V247).factor_avion;
    const bancoVuelo = Math.round(630.01 * factor * 100) / 100;
    expect(Math.round((a.banco_mxn + b.banco_mxn) * 100) / 100).toBe(
      bancoVuelo,
    );
    // Provisión 322.48 USD × 18 = 5,804.64 ⇒ 2,902.32 y 2,902.32.
    expect(a.vendedor_mxn).toBe(2902.32);
    expect(b.vendedor_mxn).toBe(2902.32);
    expect(a.vendedor_usd + b.vendedor_usd).toBeCloseTo(322.48, 10);
    // El centavo impar va al principal (residuo mayor, empate ⇒ principal).
    expect(a.banco_mxn).toBeGreaterThanOrEqual(b.banco_mxn);
    expect(a.detalle[0]).toBe('2 conceptos');
    expect(a.detalle[1]).toMatch(
      /^Comisión bancaria · Transferencia 5 % · \$630\.01 \(parte del avión 43\.0\d %: \$\d+\.\d{2}\)$/,
    );
    expect(a.detalle[2]).toBe(
      'Comisión vendedor (Pablo Canales) · $5,804.64 · provisión = cotizado + IVA (parte del avión 50 %: $2,902.32)',
    );
  });

  it('CANCELADO: lo retenido es 100 % del avión (comisión completa) y NO hay provisión del vendedor', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        cancelado: true,
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
      }),
    );
    expect(r.banco_mxn).toBe(350);
    expect(r.vendedor_mxn).toBe(0);
    expect(r.vendedor_usd).toBe(0);
    expect(r.detalle).toEqual([
      'Comisión bancaria · Transferencia 5 % · $350.00 (parte del avión 100 %)',
    ]);
  });

  it('partición INCONSISTENTE: sin provisión (no hay comisión que separar) y la bancaria completa al avión', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: { ...V501, monto_total_usd: 9999 },
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
      }),
    );
    expect(
      particionIngresoVuelo({ ...V501, monto_total_usd: 9999 }).inconsistente,
    ).toBe(true);
    expect(r.vendedor_mxn).toBe(0);
    expect(r.banco_mxn).toBe(350);
  });

  it('provisión sin T.C. de venta: no entra en pesos (sí en USD) y la nota lo dice', () => {
    const r = comisionesDelVuelo(
      entrada({ vuelo: V501, tcVenta: null, vendedorNombre: 'Vendedor Uno' }),
    );
    expect(r.vendedor_sin_tc).toBe(true);
    expect(r.vendedor_mxn).toBe(0);
    expect(r.vendedor_usd).toBe(80);
    expect(r.detalle).toEqual([
      'Comisión vendedor (Vendedor Uno) · $80.00 USD sin T.C. de venta — no suma en pesos',
    ]);
  });

  it('varias comisiones bancarias + vendedor: una línea por concepto y «3 conceptos»', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V247,
        tcVenta: 17,
        cobros: [
          cobroMxn(1000, { tc_usd_mxn: 17 }),
          cobroMxn(250, {
            tc_usd_mxn: 17,
            comision_banco_pct: 3.828,
            metodo_cobro: 'HSBC_LINK',
          }),
          cobroMxn(null),
        ],
      }),
    );
    expect(r.detalle[0]).toBe('3 conceptos');
    expect(r.detalle).toHaveLength(4);
    expect(r.detalle[2]).toMatch(
      /^Comisión bancaria · Link de pago \(HSBC\) 3\.83 % · \$250\.00 /,
    );
    expect(r.total_mxn).toBe(
      Math.round((r.banco_mxn + r.vendedor_mxn) * 100) / 100,
    );
  });
});

describe('textos de la regla', () => {
  it('la etiqueta sale de la vigencia CONFIGURADA', () => {
    expect(etiquetaReglaComisiones('2026-09-01')).toBe('regla sep-2026');
    expect(etiquetaReglaComisiones('2026-10-15')).toBe(
      'regla desde 15-oct-2026',
    );
  });

  it('concepto del ingreso de VuelaTour en «otros movimientos»', () => {
    expect(conceptoVendedorACargoDelAvion('XB-PEV', '2026-09-01')).toBe(
      'comisión del vendedor a cargo del avión XB-PEV (regla sep-2026)',
    );
    expect(SUFIJO_COMISION_BANCO_PARTE_VUELATOUR).toBe(
      ' (parte VuelaTour: la del avión va en su columna COMISIONES)',
    );
  });

  it('formatos de la nota', () => {
    expect(fmtMxnNota(20400)).toBe('$20,400.00');
    expect(fmtMxnNota(-5)).toBe('-$5.00');
    expect(fmtPctNota(5)).toBe('5');
    expect(fmtPctNota(5.0001)).toBe('5');
    expect(fmtPctNota(3.828)).toBe('3.83');
  });
});
