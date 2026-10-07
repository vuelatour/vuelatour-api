import {
  COMISIONES_AL_AVION_DESDE_DEFAULT,
  SUFIJO_COMISION_BANCO_PARTE_VUELATOUR,
  aplicaComisionesAlAvion,
  comisionesDelVuelo,
  etiquetaReglaComisiones,
  fmtMxnNota,
  fmtPctNota,
  pagoVendedorCubiertoPorAvion,
  type ComisionesDelVueloInput,
} from './comisiones-avion.util';
import type { PagosVendedorDeVuelo } from './pago-vendedor.util';
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
    estado: 'COMPLETADO',
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
        estado: 'CANCELADO',
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

describe('comisionesDelVuelo — revisión 6-oct-2026', () => {
  it('provisión del vendedor SOLO en COMPLETADO (el universo del reparto): un vuelo aún no realizado no la carga, pero su comisión bancaria sí (sigue al cobro)', () => {
    for (const estado of [
      'SOLICITUD',
      'COTIZADO',
      'RESERVA',
      'CONFIRMADO',
      'EN_VUELO',
      null,
      undefined,
    ]) {
      const r = comisionesDelVuelo(
        entrada({
          vuelo: V501,
          estado,
          cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
          vendedorNombre: 'Vendedor Uno',
        }),
      );
      expect(r.aplica).toBe(true);
      expect(r.vendedor_mxn).toBe(0);
      expect(r.vendedor_usd).toBe(0);
      expect(r.vendedor_sin_tc).toBe(false);
      // La bancaria del anticipo, como en un COMPLETADO.
      expect(r.banco_mxn).toBe(313.9);
      expect(r.banco_usd).toBe(15.7);
      expect(r.total_mxn).toBe(313.9);
      expect(r.detalle).toEqual([
        'Comisión bancaria · Transferencia 5 % · $350.00 (parte del avión 89.69 %: $313.90)',
      ]);
    }
    // El mismo vuelo COMPLETADO sí la carga.
    const completado = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
      }),
    );
    expect(completado.vendedor_mxn).toBe(1600);
    expect(completado.total_mxn).toBe(1913.9);
  });

  it('un vuelo aún no realizado SIN cobros no carga nada (ni nota): su venta la neutraliza POR COBRAR', () => {
    const r = comisionesDelVuelo(
      entrada({ vuelo: V501, estado: 'COTIZADO', cobros: [] }),
    );
    expect(r).toEqual({
      aplica: true,
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

  it('SOBRECOBRO: el factor se topa como `cobradoParteAvion` (cobrado al avión ÷ cobrado del vuelo) — el excedente y su comisión son de VuelaTour', () => {
    // #235: 1,200 USD todo del avión, cobrado 1,320 USD con 33 USD de
    // comisión ⇒ el avión recibe 1,200 de 1,320 (90.91 %).
    const usd = (monto: number, comision: number | null, tc = 18) => ({
      monto,
      moneda: 'USD',
      tc_usd_mxn: tc,
      comision_banco_monto: comision,
      metodo_cobro: 'TRANSFERENCIA',
    });
    const r = comisionesDelVuelo(
      entrada({ vuelo: V235, tcVenta: 18, cobros: [usd(1320, 33)] }),
    );
    // 33 × 1,200/1,320 = 30 USD; 594 MXN × 1,200/1,320 = 540.
    expect(r.banco_usd).toBe(30);
    expect(r.banco_mxn).toBe(540);
    expect(r.detalle).toEqual([
      'Comisión bancaria · Transferencia · $33.00 USD = $594.00 (parte del avión 90.91 %: $540.00)',
    ]);
    // Con parte de VuelaTour: #501 (factor 2,000/2,230 = 89.69 %) cobrado
    // 2,400 USD ⇒ tope 2,000/2,400 = 83.33 %.
    const r501 = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        tcVenta: 20,
        cobros: [usd(2400, 24, 20)],
      }),
    );
    expect(r501.banco_usd).toBe(20);
    expect(r501.banco_mxn).toBe(400);
    // Pagado EXACTO o parcial: el factor de siempre (sin tope).
    const exacto = comisionesDelVuelo(
      entrada({ vuelo: V235, tcVenta: 18, cobros: [usd(1200, 36)] }),
    );
    expect(exacto.banco_usd).toBe(36);
    const parcial = comisionesDelVuelo(
      entrada({ vuelo: V501, tcVenta: 20, cobros: [usd(1115, 22.3, 20)] }),
    );
    // 22.30 × 2,000/2,230 = 20.
    expect(parcial.banco_usd).toBe(20);
    // CANCELADO con dinero retenido: siempre 100 % del avión.
    const cancelado = comisionesDelVuelo(
      entrada({
        vuelo: V235,
        estado: 'CANCELADO',
        cobros: [usd(1500, 45)],
      }),
    );
    expect(cancelado.banco_usd).toBe(45);
  });

  it('SOBRECOBRO con cobros MXN sin T.C. propio: lo cobrado del vuelo sale con el K de respaldo (cadena de `cobrosEnUsd`)', () => {
    // 1,200 USD × 20 = 24,000 MXN; se cobraron 26,400 MXN (1,320 USD al K)
    // con 264 de comisión ⇒ 1,200/1,320 = 90.91 % ⇒ 240 MXN al avión.
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V235,
        tcVenta: 20,
        cobros: [cobroMxn(264, { monto: 26400, tc_usd_mxn: null })],
      }),
    );
    expect(r.banco_mxn).toBe(240);
    expect(r.banco_usd).toBe(12);
  });
});

describe('textos de la regla', () => {
  it('la etiqueta sale de la vigencia CONFIGURADA', () => {
    expect(etiquetaReglaComisiones('2026-09-01')).toBe('regla sep-2026');
    expect(etiquetaReglaComisiones('2026-10-15')).toBe(
      'regla desde 15-oct-2026',
    );
  });

  it('sufijo del egreso de comisión bancaria de VuelaTour en «otros movimientos»', () => {
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

/**
 * EGRESO DEL VENDEDOR CUBIERTO POR LOS AVIONES (7-oct-2026, API 0.0.66):
 * pedido del cliente «en "otros movimientos", en el ingreso estás duplicando
 * la comisión». La provisión ya resta en la columna COMISIONES de cada avión:
 * VuelaTour solo paga lo que el pago real la EXCEDE.
 */
describe('pagoVendedorCubiertoPorAvion', () => {
  const sinPago: PagosVendedorDeVuelo = {
    n: 0,
    pagadoMxn: null,
    sinTc: 0,
    fecha: null,
  };
  const pago = (
    pagadoMxn: number | null,
    extra: Partial<PagosVendedorDeVuelo> = {},
  ): PagosVendedorDeVuelo => ({
    n: 1,
    pagadoMxn,
    sinTc: 0,
    fecha: '2026-09-28',
    ...extra,
  });
  const xbPev = [{ matricula: 'XB-PEV', vendedor_mxn: 5467.97 }];
  const PABLO = 'comisión vendedor (Pablo Canales)';

  it('sin pago real: egreso 0 y el concepto del contrato (caso del cliente, $5,467.97)', () => {
    expect(
      pagoVendedorCubiertoPorAvion({
        etiquetaComision: PABLO,
        aviones: xbPev,
        pagos: sinPago,
      }),
    ).toEqual({
      egreso_mxn: 0,
      concepto:
        'pago comisión vendedor (Pablo Canales) · cubierto por el avión XB-PEV (provisión $5,467.97 en su balance)',
      provision_mxn: 5467.97,
    });
  });

  it('pago real MAYOR que la provisión: VuelaTour paga SOLO el exceso y el concepto dice «excede»', () => {
    const r = pagoVendedorCubiertoPorAvion({
      etiquetaComision: PABLO,
      aviones: [{ matricula: 'XB-DOS', vendedor_mxn: 2700 }],
      pagos: pago(3000),
    });
    expect(r.egreso_mxn).toBe(300);
    expect(r.concepto).toBe(
      'pago comisión vendedor (Pablo Canales) · cubierto por el avión XB-DOS (provisión $2,700.00 en su balance) · gasto real $3,000.00 · excede $300.00 MXN',
    );
  });

  it('pago real MENOR que la provisión: egreso 0 y «parcial: faltan» (aún se le debe al vendedor; el avión ya lo cargó)', () => {
    const r = pagoVendedorCubiertoPorAvion({
      etiquetaComision: 'comisión vendedor (Alex Saab)',
      aviones: [{ matricula: 'XB-TST', vendedor_mxn: 1800 }],
      pagos: pago(1500),
    });
    expect(r.egreso_mxn).toBe(0);
    expect(r.concepto).toBe(
      'pago comisión vendedor (Alex Saab) · cubierto por el avión XB-TST (provisión $1,800.00 en su balance) · gasto real $1,500.00 · parcial: faltan $300.00 MXN',
    );
  });

  it('pago real IGUAL a la provisión (caso #251, $4,080): egreso 0, sin «excede» ni «faltan»', () => {
    const r = pagoVendedorCubiertoPorAvion({
      etiquetaComision: 'comisión vendedor (Alex Saab)',
      aviones: [{ matricula: 'N990GG', vendedor_mxn: 4080 }],
      pagos: pago(4080),
    });
    expect(r.egreso_mxn).toBe(0);
    expect(r.concepto).toBe(
      'pago comisión vendedor (Alex Saab) · cubierto por el avión N990GG (provisión $4,080.00 en su balance) · gasto real $4,080.00',
    );
  });

  it('diferencias menores a la tolerancia: el egreso es EXACTO aunque el texto no las nombre', () => {
    const r = pagoVendedorCubiertoPorAvion({
      etiquetaComision: PABLO,
      aviones: [{ matricula: 'XB-DOS', vendedor_mxn: 2700 }],
      pagos: pago(2700.4),
    });
    expect(r.egreso_mxn).toBe(0.4);
    expect(r.concepto).not.toMatch(/excede|faltan/);
  });

  it('MULTI-AVIÓN: cada avión con SU provisión; Σ provisiones cubre el pago y los de 0 no aparecen', () => {
    const r = pagoVendedorCubiertoPorAvion({
      etiquetaComision: PABLO,
      aviones: [
        { matricula: 'XB-TST', vendedor_mxn: 900 },
        { matricula: 'XB-DOS', vendedor_mxn: 900 },
        { matricula: 'XB-TRES', vendedor_mxn: 0 },
      ],
      pagos: pago(2000, { n: 2 }),
    });
    expect(r.provision_mxn).toBe(1800);
    expect(r.egreso_mxn).toBe(200);
    expect(r.concepto).toBe(
      'pago comisión vendedor (Pablo Canales) · cubierto por los aviones XB-TST (provisión $900.00 en su balance) y XB-DOS (provisión $900.00 en su balance) · gasto real $2,000.00 (2 pagos) · excede $200.00 MXN',
    );
  });

  it('pagos USD sin T.C.: ninguno convierte ⇒ egreso null (jamás un 0 falso); parcial ⇒ el exceso de lo que sí convirtió, sin comparar', () => {
    const ninguno = pagoVendedorCubiertoPorAvion({
      etiquetaComision: PABLO,
      aviones: xbPev,
      pagos: pago(null, { sinTc: 1 }),
    });
    expect(ninguno.egreso_mxn).toBeNull();
    expect(ninguno.concepto).toBe(
      'pago comisión vendedor (Pablo Canales) · cubierto por el avión XB-PEV (provisión $5,467.97 en su balance) · gasto real (USD sin TC)',
    );
    const parcial = pagoVendedorCubiertoPorAvion({
      etiquetaComision: PABLO,
      aviones: xbPev,
      pagos: pago(6000, { n: 2, sinTc: 1 }),
    });
    expect(parcial.egreso_mxn).toBe(532.03);
    expect(parcial.concepto).toBe(
      'pago comisión vendedor (Pablo Canales) · cubierto por el avión XB-PEV (provisión $5,467.97 en su balance) · gasto real $6,000.00 (2 pagos) (parcial: USD sin TC)',
    );
  });

  it('todos los conceptos empiezan con «pago comisión vendedor» (el clasificador de la nota los reconoce)', () => {
    for (const pagos of [sinPago, pago(3000), pago(null, { sinTc: 1 })]) {
      expect(
        pagoVendedorCubiertoPorAvion({
          etiquetaComision: 'comisión vendedor',
          aviones: xbPev,
          pagos,
        }).concepto.startsWith('pago comisión vendedor · cubierto por'),
      ).toBe(true);
    }
  });
});
