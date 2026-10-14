import {
  COMISIONES_AL_AVION_DESDE_DEFAULT,
  SUFIJO_COMISION_BANCO_PARTE_VUELATOUR,
  TEXTO_PAGO_VENDEDOR_AVION_SIN_CARGO,
  aplicaComisionesAlAvion,
  comisionesDelVuelo,
  conceptoPagoVendedorACargoDelAvion,
  egresoPagoVendedorDeVuelo,
  etiquetaReglaComisiones,
  fmtMxnNota,
  fmtPctNota,
  motivoPagoVendedorAvionSinCargo,
  notaParteAvionDinero,
  pagoVendedorAvionEnUniverso,
  sufijoParteAvionDinero,
  sufijoPagoVendedorACargoDelAvion,
  sufijoPagoVendedorAvionSinCargo,
  textoPendienteCapturaVendedor,
  textoPendientePagoVendedorAvionSinCargo,
  textoPendienteVendedorSinTc,
  type ComisionVendedorDeAvion,
  type ComisionesDelVueloInput,
} from './comisiones-avion.util';
import type {
  GastoPagoVendedorRow,
  PagosVendedorDeVuelo,
} from './pago-vendedor.util';
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
 *
 * 13-oct-2026 (API 0.0.74, invariante 61; decisión 3 del lote del cliente
 * ajustada el mismo día —«dos categorías»—): la comisión del vendedor resta
 * SOLO como GASTO REAL y SOLO la «Comisión del vendedor (avión)»
 * (`COMISION_VENDEDOR_AVION`, entrada `gastos`); la «(VuelaTour)»
 * (`COMISION_VENDEDOR`) NUNCA la absorbe el avión. La PROVISIÓN murió en los
 * tres libros. Universo de la «(avión)»: COMPLETADO, o CANCELADO con cobros
 * retenidos (`retieneCobros`), en CUALQUIER fecha (la vigencia ya solo
 * gobierna la parte bancaria), sin exigir comisión cotizada ni partición
 * consistente. Los casos de absorción de la D3 se re-apuntaron a la
 * «(avión)» con las MISMAS cifras.
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

/**
 * Gasto «Comisión del vendedor (avión)» del vuelo (forma de `gasto`; MXN por
 * default): el ÚNICO que el avión absorbe (los casos de la D3 se
 * re-apuntaron aquí con las mismas cifras).
 */
const gastoCv = (
  monto: number | string,
  extra: Partial<GastoPagoVendedorRow> = {},
): GastoPagoVendedorRow => ({
  categoria: 'COMISION_VENDEDOR_AVION',
  monto,
  moneda: 'MXN',
  tc_gasto: null,
  fecha_gasto: '2026-09-28',
  ...extra,
});
/** Gasto «Comisión del vendedor (VuelaTour)»: el avión NUNCA lo absorbe. */
const gastoVt = (
  monto: number | string,
  extra: Partial<GastoPagoVendedorRow> = {},
): GastoPagoVendedorRow =>
  gastoCv(monto, { categoria: 'COMISION_VENDEDOR', ...extra });

/** Partes del vendedor en 0/false (sin pago «(avión)» absorbido). */
const SIN_VENDEDOR = {
  vendedor_mxn: 0,
  vendedor_usd: 0,
  vendedor_sin_tc: false,
  vendedor_usd_sin_tc_n: 0,
  vendedor_usd_sin_tc_mxn: 0,
};
/** Contadores de un vuelo COMPLETADO sin pagos al vendedor capturados. */
const SIN_PAGOS_COMPLETADO = {
  vendedor_avion_universo: true,
  vendedor_avion_pagos_n: 0,
  vendedor_vuelatour_pagos_n: 0,
  vendedor_absorbido: false,
  vendedor_pendiente_captura: false,
};

function entrada(
  extra: Partial<ComisionesDelVueloInput> & { vuelo?: VueloIngresoInput },
): ComisionesDelVueloInput {
  const { vuelo, ...resto } = extra;
  return {
    diaVuelo: '2026-09-10',
    vigenteDesde: VIGENCIA,
    cobros: [],
    gastos: [],
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
  it('ANTES de la vigencia SIN «(avión)»: no aplica, no lleva COMISIONES y todo en 0 (aunque haya comisión bancaria y una «(VuelaTour)»)', () => {
    const r = comisionesDelVuelo(
      entrada({
        diaVuelo: '2026-08-31',
        vuelo: V501,
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
        gastos: [gastoVt(3000)],
      }),
    );
    expect(r).toEqual({
      aplica: false,
      lleva_comisiones: false,
      banco_mxn: 0,
      banco_usd: 0,
      total_mxn: 0,
      total_usd: 0,
      detalle: [],
      banco_sin_tc: 0,
      ...SIN_VENDEDOR,
      ...SIN_PAGOS_COMPLETADO,
      vendedor_vuelatour_pagos_n: 1,
    });
  });

  it('ANTES de la vigencia CON «(avión)»: el avión SÍ la carga (la elección explícita manda); banco 0 aunque haya comisión bancaria y el detalle solo trae el vendedor', () => {
    const r = comisionesDelVuelo(
      entrada({
        diaVuelo: '2026-08-31',
        vuelo: V501,
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
        gastos: [gastoCv(3000)],
      }),
    );
    expect(r).toEqual({
      aplica: false,
      lleva_comisiones: true,
      banco_mxn: 0,
      banco_usd: 0,
      vendedor_mxn: 3000,
      vendedor_usd: 150,
      total_mxn: 3000,
      total_usd: 150,
      detalle: ['Comisión vendedor · $3,000.00 · gasto real'],
      banco_sin_tc: 0,
      vendedor_sin_tc: false,
      vendedor_avion_universo: true,
      vendedor_avion_pagos_n: 1,
      vendedor_vuelatour_pagos_n: 0,
      vendedor_absorbido: true,
      // Fuera de la vigencia no hay checklist de captura.
      vendedor_pendiente_captura: false,
      vendedor_usd_sin_tc_n: 0,
      vendedor_usd_sin_tc_mxn: 0,
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
      total_mxn: 1020,
      total_usd: 60,
      detalle: [
        'Comisión bancaria · Transferencia 5 % · $1,020.00 (parte del avión 100 %)',
      ],
      banco_sin_tc: 0,
      lleva_comisiones: true,
      // #235 no cobra comisión del vendedor ni trae pagos: nada del vendedor
      // y ningún pendiente de captura.
      ...SIN_VENDEDOR,
      ...SIN_PAGOS_COMPLETADO,
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

  it('parte de VuelaTour en el vuelo: la comisión bancaria se prorratea con el MISMO factor del cobro; SIN gasto real el vendedor no resta nada (la provisión murió) aunque el avión sea quien absorbe', () => {
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
    // COMPLETADO de la vigencia con comisión cotizada y sin pagos: el
    // balance avisa que falta capturarlo…
    expect(r.vendedor_pendiente_captura).toBe(true);
    expect(r.vendedor_absorbido).toBe(false);
    // …pero sin pago capturado no resta ni un peso (hasta el 0.0.73: 1,600
    // de provisión = 80 USD × K 20).
    expect(r.vendedor_avion_pagos_n).toBe(0);
    expect(r.vendedor_usd).toBe(0);
    expect(r.vendedor_mxn).toBe(0);
    expect(r.total_mxn).toBe(313.9);
    expect(r.total_usd).toBe(15.7);
    expect(r.detalle).toEqual([
      'Comisión bancaria · $350.00 (parte del avión 89.69 %: $313.90)',
    ]);
  });

  it('con «(avión)»: 1 gasto MXN de 3,000 en COMPLETADO consistente con comisión cotizada ⇒ resta EXACTAMENTE lo pagado (× parte del avión), USD = ÷ K', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
        gastos: [gastoCv(3000)],
        vendedorNombre: 'Vendedor Uno',
      }),
    );
    expect(r.vendedor_absorbido).toBe(true);
    expect(r.vendedor_avion_pagos_n).toBe(1);
    expect(r.vendedor_pendiente_captura).toBe(false);
    expect(r.vendedor_mxn).toBe(3000);
    expect(r.vendedor_usd).toBe(150);
    expect(r.vendedor_sin_tc).toBe(false);
    expect(r.vendedor_usd_sin_tc_n).toBe(0);
    expect(r.vendedor_usd_sin_tc_mxn).toBe(0);
    expect(r.total_mxn).toBe(3313.9);
    expect(r.total_usd).toBe(165.7);
    expect(r.detalle).toEqual([
      '2 conceptos',
      'Comisión bancaria · Transferencia 5 % · $350.00 (parte del avión 89.69 %: $313.90)',
      'Comisión vendedor (Vendedor Uno) · $3,000.00 · gasto real',
    ]);
    // Sin nombre de vendedor: «Comisión vendedor · …».
    const sinNombre = comisionesDelVuelo(
      entrada({ vuelo: V501, gastos: [gastoCv(3000)] }),
    );
    expect(sinNombre.detalle).toEqual([
      'Comisión vendedor · $3,000.00 · gasto real',
    ]);
  });

  it('2 gastos ⇒ «(2 pagos)», suma CRUDA y round2 al final; los gastos de OTRA categoría del vuelo no cuentan', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        gastos: [
          gastoCv(1000, { fecha_gasto: '2026-09-12' }),
          gastoCv('600', { fecha_gasto: '2026-09-15' }),
          gastoCv(1500, { categoria: 'TUAS' }),
          gastoCv(250000, { categoria: 'OTRO' }),
        ],
        vendedorNombre: 'Vendedor Uno',
      }),
    );
    expect(r.vendedor_avion_pagos_n).toBe(2);
    expect(r.vendedor_mxn).toBe(1600);
    expect(r.vendedor_usd).toBe(80);
    expect(r.detalle).toEqual([
      'Comisión vendedor (Vendedor Uno) · $1,600.00 · gasto real (2 pagos)',
    ]);
    // 3 × 0.004 = 0.012 ⇒ 0.01 al final (por gasto daría 0.00).
    const cruda = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        gastos: [gastoCv(0.004), gastoCv(0.004), gastoCv(0.004)],
      }),
    );
    expect(cruda.vendedor_mxn).toBe(0.01);
  });

  it('gasto USD: MXN × tc_gasto (no el K) y USD tal cual; sin tc_gasto ⇒ el K del vuelo', () => {
    const conTc = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        gastos: [gastoCv(80, { moneda: 'USD', tc_gasto: 18 })],
      }),
    );
    expect(conTc.vendedor_mxn).toBe(1440);
    expect(conTc.vendedor_usd).toBe(80);
    expect(conTc.vendedor_sin_tc).toBe(false);
    const conK = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        gastos: [gastoCv(80, { moneda: 'USD', tc_gasto: null })],
      }),
    );
    expect(conK.vendedor_mxn).toBe(1600);
    expect(conK.vendedor_usd).toBe(80);
  });

  it('gasto USD sin NINGÚN T.C.: no entra a pesos (`vendedor_sin_tc`), sí resta en USD, y la nota lo dice', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        tcVenta: null,
        gastos: [gastoCv(80, { moneda: 'USD', tc_gasto: null })],
        vendedorNombre: 'Vendedor Uno',
      }),
    );
    expect(r.vendedor_absorbido).toBe(true);
    expect(r.vendedor_avion_pagos_n).toBe(1);
    expect(r.vendedor_sin_tc).toBe(true);
    expect(r.vendedor_mxn).toBe(0);
    expect(r.vendedor_usd).toBe(80);
    expect(r.vendedor_usd_sin_tc_n).toBe(0);
    expect(r.detalle).toEqual([
      'Comisión vendedor (Vendedor Uno) · $80.00 USD sin T.C. — no suma en pesos',
    ]);
    // Dos pagos USD sin ningún T.C.: la suma en USD, la misma línea.
    const dos = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        tcVenta: null,
        gastos: [
          gastoCv(80, { moneda: 'USD' }),
          gastoCv(50, { moneda: 'USD' }),
        ],
      }),
    );
    expect(dos.vendedor_usd).toBe(130);
    expect(dos.vendedor_avion_pagos_n).toBe(2);
    expect(dos.detalle).toEqual([
      'Comisión vendedor · $130.00 USD sin T.C. — no suma en pesos',
    ]);
  });

  it('gasto MXN sin tc_gasto ni K: resta en pesos y NO llega a dólares (`vendedor_usd_sin_tc_n` / `_mxn` = su parte del avión)', () => {
    const r = comisionesDelVuelo(
      entrada({ vuelo: V501, tcVenta: null, gastos: [gastoCv(3000)] }),
    );
    expect(r.vendedor_mxn).toBe(3000);
    expect(r.vendedor_usd).toBe(0);
    expect(r.vendedor_sin_tc).toBe(false);
    expect(r.vendedor_usd_sin_tc_n).toBe(1);
    expect(r.vendedor_usd_sin_tc_mxn).toBe(3000);
    expect(r.detalle).toEqual(['Comisión vendedor · $3,000.00 · gasto real']);
  });

  it('mixto (MXN 1,000 + USD 50 sin ningún T.C.): cada moneda suma lo que convirtió y la nota cuenta el pago USD que no llegó a pesos', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        tcVenta: null,
        gastos: [gastoCv(1000), gastoCv(50, { moneda: 'USD' })],
      }),
    );
    expect(r.vendedor_avion_pagos_n).toBe(2);
    expect(r.vendedor_mxn).toBe(1000);
    expect(r.vendedor_usd).toBe(50);
    expect(r.vendedor_sin_tc).toBe(true);
    expect(r.vendedor_usd_sin_tc_n).toBe(1);
    expect(r.vendedor_usd_sin_tc_mxn).toBe(1000);
    expect(r.detalle).toEqual([
      'Comisión vendedor · $1,000.00 · gasto real (2 pagos) · 1 pago USD sin T.C. — no suma en pesos',
    ]);
    const dos = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        tcVenta: null,
        gastos: [
          gastoCv(1000),
          gastoCv(50, { moneda: 'USD' }),
          gastoCv(30, { moneda: 'USD' }),
        ],
      }),
    );
    expect(dos.detalle).toEqual([
      'Comisión vendedor · $1,000.00 · gasto real (3 pagos) · 2 pagos USD sin T.C. — no suman en pesos',
    ]);
  });

  it('«IVA 16 %» ya no cambia nada: el pago real no depende del IVA cotizado (#247 con 5,000 pagados ⇒ 5,000)', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V247,
        tcVenta: 16.956,
        gastos: [gastoCv(5000)],
        vendedorNombre: 'Pablo Canales',
      }),
    );
    // Hasta el 0.0.73: provisión 322.48 USD × 16.956 = 5,467.97.
    expect(r.vendedor_mxn).toBe(5000);
    expect(r.vendedor_usd).toBe(294.88);
    expect(r.banco_mxn).toBe(0);
    expect(r.detalle).toEqual([
      'Comisión vendedor (Pablo Canales) · $5,000.00 · gasto real',
    ]);
  });

  it('vendedor SIN comisión cotizada: una «(VuelaTour)» NO la absorbe el avión (solo la bancaria); una «(avión)» SÍ, y la nota dice que no hay línea que aparear', () => {
    const sinComision = {
      ...V501,
      comision_vendedor_usd: 0,
      monto_total_usd: 2150,
    };
    const vt = comisionesDelVuelo(
      entrada({
        vuelo: sinComision,
        cobros: [cobroMxn(500, { tc_usd_mxn: 20 })],
        gastos: [gastoVt(500)],
        vendedorNombre: 'Nadie',
      }),
    );
    expect(vt.vendedor_absorbido).toBe(false);
    expect(vt.vendedor_vuelatour_pagos_n).toBe(1);
    expect(vt.vendedor_avion_pagos_n).toBe(0);
    expect(vt.vendedor_mxn).toBe(0);
    expect(vt.vendedor_usd).toBe(0);
    expect(vt.detalle).toHaveLength(1);
    expect(vt.detalle[0]).toMatch(/^Comisión bancaria · Transferencia 5 % · /);
    // La «(avión)» no exige comisión cotizada (la elección explícita manda).
    const av = comisionesDelVuelo(
      entrada({
        vuelo: sinComision,
        cobros: [cobroMxn(500, { tc_usd_mxn: 20 })],
        gastos: [gastoCv(500)],
        vendedorNombre: 'Nadie',
      }),
    );
    expect(av.vendedor_absorbido).toBe(true);
    expect(av.vendedor_mxn).toBe(500);
    expect(av.vendedor_usd).toBe(25);
    expect(av.detalle).toHaveLength(3);
    expect(av.detalle[0]).toBe('2 conceptos');
    expect(av.detalle[2]).toBe(
      'Comisión vendedor (Nadie) · $500.00 · gasto real · sin comisión cobrada en la cotización',
    );
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
      // Pago real de 5,804.64 (lo que valía la provisión: así el reparto
      // 50/50 se verifica a mano).
      gastos: [gastoCv(5804.64)],
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
    // Pago real 5,804.64 ⇒ 2,902.32 y 2,902.32 (Σ == el gasto al centavo);
    // en USD ÷ 18 = 322.48 ⇒ 161.24 y 161.24.
    expect(a.vendedor_mxn).toBe(2902.32);
    expect(b.vendedor_mxn).toBe(2902.32);
    expect(a.vendedor_mxn + b.vendedor_mxn).toBe(5804.64);
    expect(a.vendedor_usd + b.vendedor_usd).toBeCloseTo(322.48, 10);
    expect(a.vendedor_avion_pagos_n).toBe(1);
    expect(b.vendedor_avion_pagos_n).toBe(1);
    expect(a.vendedor_absorbido && b.vendedor_absorbido).toBe(true);
    // El centavo impar va al principal (residuo mayor, empate ⇒ principal).
    expect(a.banco_mxn).toBeGreaterThanOrEqual(b.banco_mxn);
    expect(a.detalle[0]).toBe('2 conceptos');
    expect(a.detalle[1]).toMatch(
      /^Comisión bancaria · Transferencia 5 % · \$630\.01 \(parte del avión 43\.0\d %: \$\d+\.\d{2}\)$/,
    );
    expect(a.detalle[2]).toBe(
      'Comisión vendedor (Pablo Canales) · $5,804.64 · gasto real (parte del avión 50 %: $2,902.32)',
    );
    // Un pago con centavo impar: Σ de los aviones == el gasto al centavo.
    const impar = { ...comun, gastos: [gastoCv(1000.01)] };
    const ia = comisionesDelVuelo(
      entrada({ ...impar, parteAvion: parteDe('av-a') }),
    );
    const ib = comisionesDelVuelo(
      entrada({ ...impar, parteAvion: parteDe('av-b') }),
    );
    expect(Math.round((ia.vendedor_mxn + ib.vendedor_mxn) * 100) / 100).toBe(
      1000.01,
    );
  });

  it('CANCELADO CON cobros retenidos: lo retenido es 100 % del avión (comisión completa) y la «(avión)» SÍ la absorbe, con la nota de que no hay comisión cobrada', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        estado: 'CANCELADO',
        cobros: [cobroMxn(350, { monto: 7000, tc_usd_mxn: 20 })],
        gastos: [gastoCv(1600)],
      }),
    );
    expect(r.banco_mxn).toBe(350);
    expect(r.vendedor_avion_universo).toBe(true);
    expect(r.vendedor_absorbido).toBe(true);
    expect(r.vendedor_mxn).toBe(1600);
    expect(r.vendedor_usd).toBe(80);
    expect(r.detalle).toEqual([
      '2 conceptos',
      'Comisión bancaria · Transferencia 5 % · $350.00 (parte del avión 100 %)',
      'Comisión vendedor · $1,600.00 · gasto real · vuelo cancelado: sin comisión cobrada',
    ]);
  });

  it('CANCELADO SIN cobros retenidos (reembolso total / cobro sin monto): el avión NO absorbe la «(avión)» aunque haya gasto — la paga VuelaTour', () => {
    for (const cobros of [
      // cobro con comisión pero sin monto: nada retenido.
      [cobroMxn(350, { tc_usd_mxn: 20 })],
      // reembolso neto 0.
      [
        cobroMxn(350, { monto: 7000, tc_usd_mxn: 20 }),
        cobroMxn(null, { monto: -7000, tc_usd_mxn: 20 }),
      ],
    ]) {
      const r = comisionesDelVuelo(
        entrada({
          vuelo: V501,
          estado: 'CANCELADO',
          cobros,
          gastos: [gastoCv(1600)],
        }),
      );
      expect(r.banco_mxn).toBe(350);
      expect(r.vendedor_avion_universo).toBe(false);
      expect(r.vendedor_absorbido).toBe(false);
      expect(r.vendedor_avion_pagos_n).toBe(1);
      expect(r.vendedor_mxn).toBe(0);
      expect(r.vendedor_usd).toBe(0);
      expect(r.detalle).toEqual([
        'Comisión bancaria · Transferencia 5 % · $350.00 (parte del avión 100 %)',
      ]);
    }
  });

  it('partición INCONSISTENTE: la bancaria completa al avión y la «(avión)» SÍ la absorbe (sin apareo: lo dice la nota)', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: { ...V501, monto_total_usd: 9999 },
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
        gastos: [gastoCv(1600)],
      }),
    );
    expect(
      particionIngresoVuelo({ ...V501, monto_total_usd: 9999 }).inconsistente,
    ).toBe(true);
    expect(r.vendedor_absorbido).toBe(true);
    expect(r.vendedor_mxn).toBe(1600);
    expect(r.vendedor_usd).toBe(80);
    expect(r.banco_mxn).toBe(350);
    expect(r.detalle[2]).toBe(
      'Comisión vendedor · $1,600.00 · gasto real · desglose de la cotización inconsistente: sin apareo',
    );
    // Sin pagos capturados, la partición inconsistente apaga el checklist.
    const sinPago = comisionesDelVuelo(
      entrada({
        vuelo: { ...V501, monto_total_usd: 9999 },
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
      }),
    );
    expect(sinPago.vendedor_pendiente_captura).toBe(false);
  });

  it('varias comisiones bancarias + vendedor (gasto real): una línea por concepto y «3 conceptos»', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V247,
        tcVenta: 17,
        gastos: [gastoCv(5000)],
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

describe('comisionesDelVuelo — revisión 6-oct-2026 (universo del avión = invariante 50)', () => {
  it('el pago real del vendedor lo absorbe el avión SOLO en COMPLETADO (el universo del reparto): un vuelo aún no realizado no lo carga aunque el gasto exista, pero su comisión bancaria sí (sigue al cobro)', () => {
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
          gastos: [gastoCv(1600)],
          vendedorNombre: 'Vendedor Uno',
        }),
      );
      expect(r.aplica).toBe(true);
      expect(r.vendedor_avion_universo).toBe(false);
      expect(r.vendedor_absorbido).toBe(false);
      expect(r.vendedor_avion_pagos_n).toBe(1);
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
    // El mismo vuelo COMPLETADO sí lo carga.
    const completado = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
        gastos: [gastoCv(1600)],
      }),
    );
    expect(completado.vendedor_absorbido).toBe(true);
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
      total_mxn: 0,
      total_usd: 0,
      detalle: [],
      banco_sin_tc: 0,
      lleva_comisiones: true,
      ...SIN_VENDEDOR,
      ...SIN_PAGOS_COMPLETADO,
      vendedor_avion_universo: false,
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
 * EGRESO DEL VENDEDOR «A CARGO DEL AVIÓN» EN «OTROS MOVIMIENTOS»
 * (13-oct-2026, API 0.0.74, invariante 61): el gasto real ya resta en la
 * columna COMISIONES de cada avión, así que la pestaña lo muestra con
 * egreso $0.00 y dice quién lo carga.
 */
describe('sufijoPagoVendedorACargoDelAvion', () => {
  const avion = (
    matricula: string,
    vendedor_mxn: number,
    absorbido = true,
  ): ComisionVendedorDeAvion => ({ matricula, vendedor_mxn, absorbido });

  it('un avión con pesos y el monto de la pestaña dentro de la tolerancia ⇒ cifra del avión (2 decimales es-MX)', () => {
    expect(
      sufijoPagoVendedorACargoDelAvion([avion('XB-PEV', 3000)], 3000),
    ).toBe(' · a cargo del avión XB-PEV ($3,000.00 en su columna COMISIONES)');
    expect(
      sufijoPagoVendedorACargoDelAvion([avion('XB-PEV', 5467.97)], 5467.5),
    ).toBe(' · a cargo del avión XB-PEV ($5,467.97 en su columna COMISIONES)');
    expect(fmtMxnNota(5467.97)).toBe('$5,467.97');
  });

  it('la cifra se omite cuando |Σ partes − pagado| ≥ 1.00 (cadenas de T.C. distintas) o cuando la pestaña no tiene pesos', () => {
    expect(
      sufijoPagoVendedorACargoDelAvion([avion('XB-PEV', 3000)], 3001),
    ).toBe(' · a cargo del avión XB-PEV (resta en su columna COMISIONES)');
    expect(
      sufijoPagoVendedorACargoDelAvion([avion('XB-PEV', 3000)], 3000.99),
    ).toBe(' · a cargo del avión XB-PEV ($3,000.00 en su columna COMISIONES)');
    expect(
      sufijoPagoVendedorACargoDelAvion([avion('XB-PEV', 3000)], null),
    ).toBe(' · a cargo del avión XB-PEV (resta en su columna COMISIONES)');
  });

  it('avión sin pesos (gasto USD sin tc_gasto y vuelo sin K): lo absorbe en USD en su reparto', () => {
    expect(sufijoPagoVendedorACargoDelAvion([avion('XB-PEV', 0)], null)).toBe(
      ' · a cargo del avión XB-PEV (sin T.C. no entra en pesos a su columna COMISIONES; resta en USD en su reparto)',
    );
    // Con pesos en la pestaña pero no en el avión tampoco se imprime cifra.
    expect(sufijoPagoVendedorACargoDelAvion([avion('XB-PEV', 0)], 1600)).toBe(
      ' · a cargo del avión XB-PEV (sin T.C. no entra en pesos a su columna COMISIONES; resta en USD en su reparto)',
    );
  });

  it("varios aviones: «, » y « y »; los NO absorbidos no aparecen; lista vacía ⇒ ''", () => {
    expect(
      sufijoPagoVendedorACargoDelAvion(
        [
          avion('XB-TST', 900),
          avion('XB-DOS', 900),
          avion('XB-TRES', 0, false),
        ],
        1800,
      ),
    ).toBe(
      ' · a cargo de los aviones XB-TST ($900.00 en su columna COMISIONES) y XB-DOS ($900.00 en su columna COMISIONES)',
    );
    expect(
      sufijoPagoVendedorACargoDelAvion(
        [avion('A', 100), avion('B', 100), avion('C', 100)],
        300,
      ),
    ).toBe(
      ' · a cargo de los aviones A ($100.00 en su columna COMISIONES), B ($100.00 en su columna COMISIONES) y C ($100.00 en su columna COMISIONES)',
    );
    // Uno sin pesos ⇒ ningún avión imprime cifra (un solo monto por fila).
    expect(
      sufijoPagoVendedorACargoDelAvion([avion('A', 900), avion('B', 0)], 900),
    ).toBe(
      ' · a cargo de los aviones A (resta en su columna COMISIONES) y B (sin T.C. no entra en pesos a su columna COMISIONES; resta en USD en su reparto)',
    );
    expect(sufijoPagoVendedorACargoDelAvion([], 3000)).toBe('');
    expect(
      sufijoPagoVendedorACargoDelAvion([avion('A', 100, false)], 100),
    ).toBe('');
  });
});

describe('conceptoPagoVendedorACargoDelAvion', () => {
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
  const PABLO = 'comisión vendedor (Pablo Canales)';
  const xbPev: ComisionVendedorDeAvion[] = [
    { matricula: 'XB-PEV', vendedor_mxn: 3000, absorbido: true },
  ];
  /**
   * Los casos de la D3 (solo «(avión)», con línea): `pagos` = `pagosAvion`,
   * sin VuelaTour ni `sinLinea` ⇒ la salida es byte a byte la de la D3.
   */
  const conceptoD3 = (a: {
    etiquetaComision: string;
    pagos: PagosVendedorDeVuelo;
    lineaMxn: number | null;
    aviones: ReadonlyArray<ComisionVendedorDeAvion>;
  }): string =>
    conceptoPagoVendedorACargoDelAvion({ ...a, pagosAvion: a.pagos });

  it('gramática exacta: pago exacto, «(2 pagos)», «excede» y «faltan» vs lo COBRADO con la tolerancia de siempre', () => {
    expect(
      conceptoD3({
        etiquetaComision: PABLO,
        pagos: pago(3000),
        lineaMxn: 3000,
        aviones: xbPev,
      }),
    ).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real · a cargo del avión XB-PEV ($3,000.00 en su columna COMISIONES)',
    );
    expect(
      conceptoD3({
        etiquetaComision: PABLO,
        pagos: pago(3000, { n: 2 }),
        lineaMxn: 2700,
        aviones: xbPev,
      }),
    ).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real (2 pagos) · excede $300.00 MXN · a cargo del avión XB-PEV ($3,000.00 en su columna COMISIONES)',
    );
    expect(
      conceptoD3({
        etiquetaComision: 'comisión vendedor (Alex Saab)',
        pagos: pago(1500),
        lineaMxn: 1800,
        aviones: [{ matricula: 'XB-TST', vendedor_mxn: 1500, absorbido: true }],
      }),
    ).toBe(
      'pago comisión vendedor (Alex Saab) · gasto real · parcial: faltan $300.00 MXN · a cargo del avión XB-TST ($1,500.00 en su columna COMISIONES)',
    );
    // Tolerancia 0.99 / 1.00 (la misma de `conceptoPagoVendedorReal`).
    const c = (pagado: number) =>
      conceptoD3({
        etiquetaComision: PABLO,
        pagos: pago(pagado),
        lineaMxn: 2030,
        aviones: [
          { matricula: 'XB-PEV', vendedor_mxn: pagado, absorbido: true },
        ],
      });
    expect(c(2029.01)).not.toMatch(/faltan|excede/);
    expect(c(2030.99)).not.toMatch(/faltan|excede/);
    expect(c(2029)).toContain(' · parcial: faltan $1.00 MXN · a cargo');
    expect(c(2031)).toContain(' · excede $1.00 MXN · a cargo');
  });

  it('NUNCA lleva « (USD sin TC)» aunque haya pagos sin T.C. (el egreso es 0 de verdad y la marca anularía el lado del bloque VUELATOUR)', () => {
    const parcial = conceptoD3({
      etiquetaComision: PABLO,
      pagos: pago(6000, { n: 2, sinTc: 1 }),
      lineaMxn: 2700,
      aviones: [{ matricula: 'XB-PEV', vendedor_mxn: 6000, absorbido: true }],
    });
    expect(parcial).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real (2 pagos) · a cargo del avión XB-PEV ($6,000.00 en su columna COMISIONES)',
    );
    const ninguno = conceptoD3({
      etiquetaComision: PABLO,
      pagos: pago(null, { sinTc: 1 }),
      lineaMxn: 2700,
      aviones: [{ matricula: 'XB-PEV', vendedor_mxn: 0, absorbido: true }],
    });
    expect(ninguno).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real · a cargo del avión XB-PEV (sin T.C. no entra en pesos a su columna COMISIONES; resta en USD en su reparto)',
    );
    for (const t of [parcial, ninguno]) {
      expect(t).not.toMatch(/\bsin TC\b/);
      expect(t).not.toMatch(/USD sin TC/);
    }
  });

  it('todos empiezan con «pago comisión vendedor» y ninguno contiene «PROVISIÓN (»', () => {
    for (const pagos of [
      pago(3000),
      pago(null, { sinTc: 1 }),
      pago(1, { n: 3 }),
    ]) {
      const t = conceptoD3({
        etiquetaComision: 'comisión vendedor',
        pagos,
        lineaMxn: 3000,
        aviones: xbPev,
      });
      expect(t.startsWith('pago comisión vendedor · gasto real')).toBe(true);
      expect(t).not.toMatch(/PROVISI[OÓ]N \(/);
      expect(t).not.toContain('cubierto por');
    }
  });
});

/** Pagos de un lado (forma de `pagosVendedorDeVuelo`). */
const pagosDe = (
  pagadoMxn: number | null,
  extra: Partial<PagosVendedorDeVuelo> = {},
): PagosVendedorDeVuelo => ({
  n: 1,
  pagadoMxn,
  sinTc: 0,
  fecha: '2026-09-28',
  ...extra,
});
const NINGUNO: PagosVendedorDeVuelo = {
  n: 0,
  pagadoMxn: null,
  sinTc: 0,
  fecha: null,
};
const PABLO_CANALES = 'comisión vendedor (Pablo Canales)';
const avionDe = (
  matricula: string,
  vendedor_mxn: number,
): ComisionVendedorDeAvion => ({ matricula, vendedor_mxn, absorbido: true });

/**
 * DOS CATEGORÍAS (13-oct-2026, invariante 61): la «(VuelaTour)» nunca la
 * absorbe el avión; la «(avión)» sí, en su universo (COMPLETADO o CANCELADO
 * con cobros retenidos), en cualquier fecha.
 */
describe('comisionesDelVuelo — dos categorías (13-oct-2026)', () => {
  it('(1) una «(VuelaTour)» en un COMPLETADO de la vigencia con comisión cotizada: vendedor 0, no absorbida, contada, detalle solo bancario', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        cobros: [cobroMxn(350, { tc_usd_mxn: 20 })],
        gastos: [gastoVt(3000)],
        vendedorNombre: 'Vendedor Uno',
      }),
    );
    expect(r.aplica).toBe(true);
    expect(r.lleva_comisiones).toBe(true);
    expect(r.vendedor_mxn).toBe(0);
    expect(r.vendedor_usd).toBe(0);
    expect(r.vendedor_absorbido).toBe(false);
    expect(r.vendedor_vuelatour_pagos_n).toBe(1);
    expect(r.vendedor_avion_pagos_n).toBe(0);
    // Hay pago (de VuelaTour): el checklist de captura se apaga.
    expect(r.vendedor_pendiente_captura).toBe(false);
    expect(r.total_mxn).toBe(313.9);
    expect(r.detalle).toEqual([
      'Comisión bancaria · Transferencia 5 % · $350.00 (parte del avión 89.69 %: $313.90)',
    ]);
  });

  it('(5) mixto: solo la parte «(avión)» resta en el avión', () => {
    const r = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        gastos: [gastoVt(2000), gastoCv(1000)],
      }),
    );
    expect(r.vendedor_avion_pagos_n).toBe(1);
    expect(r.vendedor_vuelatour_pagos_n).toBe(1);
    expect(r.vendedor_absorbido).toBe(true);
    expect(r.vendedor_mxn).toBe(1000);
    expect(r.vendedor_usd).toBe(50);
    expect(r.detalle).toEqual(['Comisión vendedor · $1,000.00 · gasto real']);
  });

  it('(7) una «(VuelaTour)» MXN sin K NO entra a `vendedor_usd_sin_tc_*` (filtro EXACTO por lado)', () => {
    const mixto = comisionesDelVuelo(
      entrada({
        vuelo: V501,
        tcVenta: null,
        gastos: [gastoVt(3000), gastoCv(1000)],
      }),
    );
    expect(mixto.vendedor_usd_sin_tc_n).toBe(1);
    expect(mixto.vendedor_usd_sin_tc_mxn).toBe(1000);
    const soloVt = comisionesDelVuelo(
      entrada({ vuelo: V501, tcVenta: null, gastos: [gastoVt(3000)] }),
    );
    expect(soloVt.vendedor_usd_sin_tc_n).toBe(0);
    expect(soloVt.vendedor_usd_sin_tc_mxn).toBe(0);
    expect(soloVt.vendedor_mxn).toBe(0);
  });

  it('(8) `vendedor_pendiente_captura` solo con vigencia ∧ COMPLETADO ∧ consistente ∧ cotizada ∧ 0 pagos de las dos', () => {
    const base = { vuelo: V501, cobros: [] };
    expect(comisionesDelVuelo(entrada(base)).vendedor_pendiente_captura).toBe(
      true,
    );
    // Un pago de cualquiera de las dos lo apaga.
    expect(
      comisionesDelVuelo(entrada({ ...base, gastos: [gastoVt(1)] }))
        .vendedor_pendiente_captura,
    ).toBe(false);
    expect(
      comisionesDelVuelo(entrada({ ...base, gastos: [gastoCv(1)] }))
        .vendedor_pendiente_captura,
    ).toBe(false);
    // No completado, antes de la vigencia o sin comisión cotizada: no.
    for (const e of [
      { estado: 'CONFIRMADO' },
      { estado: 'CANCELADO' },
      { diaVuelo: '2026-08-31' },
      { vuelo: V235 },
    ]) {
      expect(
        comisionesDelVuelo(entrada({ ...base, ...e }))
          .vendedor_pendiente_captura,
      ).toBe(false);
    }
  });

  it('(3) antes de la vigencia: la parte bancaria NO entra aunque el vuelo absorba una «(avión)» (multi-avión incluido)', () => {
    const vuelo = { aeronave_id: 'av-a', calculo_snapshot: null };
    const part = participacionPorAeronave(vuelo, [
      { id: 'e1', orden: 1, aeronave_id: null, cancelada_at: null },
      { id: 'e2', orden: 2, aeronave_id: 'av-b', cancelada_at: null },
    ]);
    const parteDe = (avion: string) => (m: number) =>
      repartirUsd(m, part).get(avion) ?? 0;
    const comun = {
      diaVuelo: '2026-08-20',
      vuelo: V247,
      tcVenta: 18,
      cobros: [cobroMxn(630.01, { tc_usd_mxn: 18 })],
      gastos: [gastoCv(1000.01)],
      participacion: 0.5,
    };
    const a = comisionesDelVuelo(
      entrada({ ...comun, parteAvion: parteDe('av-a') }),
    );
    const b = comisionesDelVuelo(
      entrada({ ...comun, parteAvion: parteDe('av-b') }),
    );
    for (const r of [a, b]) {
      expect(r.aplica).toBe(false);
      expect(r.lleva_comisiones).toBe(true);
      expect(r.banco_mxn).toBe(0);
      expect(r.banco_usd).toBe(0);
      expect(r.detalle).toHaveLength(1);
    }
    // (6) Σ de los aviones == el pago al centavo.
    expect(Math.round((a.vendedor_mxn + b.vendedor_mxn) * 100) / 100).toBe(
      1000.01,
    );
  });
});

describe('pagoVendedorAvionEnUniverso (2)', () => {
  const usd = (monto: number) => ({ monto, moneda: 'USD', tc_usd_mxn: null });
  const mxn = (monto: number) => ({ monto, moneda: 'MXN', tc_usd_mxn: null });

  it('COMPLETADO ⇒ sí (con o sin cobros)', () => {
    expect(
      pagoVendedorAvionEnUniverso({
        estado: 'COMPLETADO',
        cobros: [],
        tcVenta: null,
      }),
    ).toBe(true);
  });

  it('CANCELADO: con cobro USD sí; con cobro MXN sin T.C. sí; con reembolso neto 0 o sin cobros no', () => {
    expect(
      pagoVendedorAvionEnUniverso({
        estado: 'CANCELADO',
        cobros: [usd(500)],
        tcVenta: null,
      }),
    ).toBe(true);
    expect(
      pagoVendedorAvionEnUniverso({
        estado: 'CANCELADO',
        cobros: [mxn(8500)],
        tcVenta: null,
      }),
    ).toBe(true);
    expect(
      pagoVendedorAvionEnUniverso({
        estado: 'CANCELADO',
        cobros: [usd(500), usd(-500)],
        tcVenta: 17,
      }),
    ).toBe(false);
    expect(
      pagoVendedorAvionEnUniverso({
        estado: 'CANCELADO',
        cobros: [],
        tcVenta: 17,
      }),
    ).toBe(false);
  });

  it('CONFIRMADO, EN_VUELO, RESERVA, COTIZADO, SOLICITUD y sin estado ⇒ no (aunque haya cobros)', () => {
    for (const estado of [
      'CONFIRMADO',
      'EN_VUELO',
      'RESERVA',
      'COTIZADO',
      'SOLICITUD',
      null,
      undefined,
    ]) {
      expect(
        pagoVendedorAvionEnUniverso({
          estado,
          cobros: [usd(500)],
          tcVenta: 17,
        }),
      ).toBe(false);
    }
  });
});

describe('motivoPagoVendedorAvionSinCargo (9) y sus textos', () => {
  it('orden: sin avión ⇒ cancelado ⇒ no completado ⇒ sin fila', () => {
    // Un externo sin avión cancelado dice «sin avión».
    expect(
      motivoPagoVendedorAvionSinCargo({
        estado: 'CANCELADO',
        tieneAvion: false,
      }),
    ).toBe('SIN_AVION');
    expect(
      motivoPagoVendedorAvionSinCargo({
        estado: 'COMPLETADO',
        tieneAvion: false,
      }),
    ).toBe('SIN_AVION');
    expect(
      motivoPagoVendedorAvionSinCargo({
        estado: 'CANCELADO',
        tieneAvion: true,
      }),
    ).toBe('CANCELADO');
    for (const estado of ['CONFIRMADO', 'EN_VUELO', 'COTIZADO', null]) {
      expect(
        motivoPagoVendedorAvionSinCargo({ estado, tieneAvion: true }),
      ).toBe('NO_COMPLETADO');
    }
    expect(
      motivoPagoVendedorAvionSinCargo({
        estado: 'COMPLETADO',
        tieneAvion: true,
      }),
    ).toBe('SIN_FILA');
  });

  it('textos EXACTOS de cada motivo y del sufijo (sin «sin TC»)', () => {
    expect(TEXTO_PAGO_VENDEDOR_AVION_SIN_CARGO).toEqual({
      SIN_AVION: 'vuelo sin avión de la flota',
      CANCELADO: 'vuelo cancelado sin cobros retenidos',
      NO_COMPLETADO:
        'el vuelo aún no se completa: al completarse lo cargará el avión',
      SIN_FILA: 'ningún libro de avión la cargó',
    });
    expect(sufijoPagoVendedorAvionSinCargo('SIN_AVION')).toBe(
      ' · incluye «Comisión del vendedor (avión)» que ningún avión carga (vuelo sin avión de la flota): la paga VuelaTour',
    );
    for (const m of [
      'SIN_AVION',
      'CANCELADO',
      'NO_COMPLETADO',
      'SIN_FILA',
    ] as const) {
      expect(sufijoPagoVendedorAvionSinCargo(m)).not.toMatch(/sin TC/);
    }
  });
});

/**
 * «OTROS MOVIMIENTOS»: GRAMÁTICA ÚNICA DEL EGRESO DEL VENDEDOR (10) — los 8
 * casos del contrato §D con string, egreso y fecha EXACTOS.
 */
describe('egresoPagoVendedorDeVuelo (8 casos del contrato §D)', () => {
  const FECHA_VUELO = '2026-09-03';
  const caso = (a: {
    etiquetaComision?: string;
    vt?: PagosVendedorDeVuelo;
    av?: PagosVendedorDeVuelo;
    todos: PagosVendedorDeVuelo;
    lineaMxn?: number | null;
    sinLinea?: 'SIN_LINEA' | 'CANCELADO' | 'INCONSISTENTE';
    aviones?: ComisionVendedorDeAvion[];
    motivo?: 'SIN_AVION' | 'CANCELADO' | 'NO_COMPLETADO' | 'SIN_FILA';
  }) =>
    egresoPagoVendedorDeVuelo({
      etiquetaComision: a.etiquetaComision ?? PABLO_CANALES,
      pagosVuelatour: a.vt ?? NINGUNO,
      pagosAvion: a.av ?? NINGUNO,
      pagosTodos: a.todos,
      lineaMxn: a.lineaMxn ?? null,
      sinLinea: a.sinLinea,
      aviones: a.aviones ?? [],
      motivoSinCargo: a.motivo ?? 'NO_COMPLETADO',
      fechaVuelo: FECHA_VUELO,
    });

  it('sin pagos de ninguna de las dos ⇒ null (la fila no lleva egreso)', () => {
    expect(caso({ todos: NINGUNO, lineaMxn: 3000 })).toBeNull();
  });

  it('D1 · con línea, solo «(VuelaTour)» (byte a byte 0.0.73/D3)', () => {
    expect(
      caso({ vt: pagosDe(2500), todos: pagosDe(2500), lineaMxn: 3000 }),
    ).toEqual({
      egresoMxn: 2500,
      concepto:
        'pago comisión vendedor (Pablo Canales) · gasto real · parcial: faltan $500.00 MXN',
      fecha: '2026-09-28',
    });
  });

  it('D2 · con línea, solo «(avión)» que carga un avión (byte a byte D3): egreso $0.00', () => {
    expect(
      caso({
        av: pagosDe(3000),
        todos: pagosDe(3000),
        lineaMxn: 3000,
        aviones: [avionDe('XB-PEV', 3000)],
      }),
    ).toEqual({
      egresoMxn: 0,
      concepto:
        'pago comisión vendedor (Pablo Canales) · gasto real · a cargo del avión XB-PEV ($3,000.00 en su columna COMISIONES)',
      fecha: '2026-09-28',
    });
    // Sin fecha de pago: la del vuelo.
    expect(
      caso({
        av: pagosDe(3000, { fecha: null }),
        todos: pagosDe(3000, { fecha: null }),
        lineaMxn: 3000,
        aviones: [avionDe('XB-PEV', 3000)],
      })?.fecha,
    ).toBe(FECHA_VUELO);
  });

  it('D3 · con línea, MIXTO: egreso = solo VuelaTour; faltan/excede vs el TOTAL pagado; «(USD sin TC)» solo del tramo VuelaTour', () => {
    expect(
      caso({
        vt: pagosDe(2000, { fecha: '2026-10-02' }),
        av: pagosDe(1000, { fecha: '2026-10-05' }),
        todos: pagosDe(3000, { n: 2, fecha: '2026-10-05' }),
        lineaMxn: 3000,
        aviones: [avionDe('XB-PEV', 1000)],
      }),
    ).toEqual({
      egresoMxn: 2000,
      concepto:
        'pago comisión vendedor (Pablo Canales) · gasto real (2 pagos) · VuelaTour $2,000.00 · a cargo del avión XB-PEV ($1,000.00 en su columna COMISIONES)',
      fecha: '2026-10-02',
    });
    // faltan contra lo pagado en TOTAL (2,500 de 3,000).
    expect(
      caso({
        vt: pagosDe(1500),
        av: pagosDe(1000),
        todos: pagosDe(2500, { n: 2 }),
        lineaMxn: 3000,
        aviones: [avionDe('XB-PEV', 1000)],
      })?.concepto,
    ).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real (2 pagos) · parcial: faltan $500.00 MXN · VuelaTour $1,500.00 · a cargo del avión XB-PEV ($1,000.00 en su columna COMISIONES)',
    );
    // VuelaTour sin T.C.: egreso null y la marca SOLO en su tramo.
    const sinTc = caso({
      vt: pagosDe(null, { sinTc: 1 }),
      av: pagosDe(1000),
      todos: pagosDe(1000, { n: 2, sinTc: 1 }),
      lineaMxn: 3000,
      aviones: [avionDe('XB-PEV', 1000)],
    });
    expect(sinTc).toEqual({
      egresoMxn: null,
      concepto:
        'pago comisión vendedor (Pablo Canales) · gasto real (2 pagos) · VuelaTour (USD sin TC) · a cargo del avión XB-PEV ($1,000.00 en su columna COMISIONES)',
      fecha: '2026-09-28',
    });
    expect(
      caso({
        vt: pagosDe(2000, { n: 2, sinTc: 1 }),
        av: pagosDe(1000),
        todos: pagosDe(3000, { n: 3, sinTc: 1 }),
        lineaMxn: 3000,
        aviones: [avionDe('XB-PEV', 1000)],
      })?.concepto,
    ).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real (3 pagos) · VuelaTour $2,000.00 (parcial: USD sin TC) · a cargo del avión XB-PEV ($1,000.00 en su columna COMISIONES)',
    );
  });

  it('D4 · con línea y una «(avión)» que ningún avión carga: VuelaTour egresa las dos y el concepto dice por qué', () => {
    expect(
      caso({
        av: pagosDe(3000),
        todos: pagosDe(3000),
        lineaMxn: 3000,
        motivo: 'NO_COMPLETADO',
      }),
    ).toEqual({
      egresoMxn: 3000,
      concepto:
        'pago comisión vendedor (Pablo Canales) · gasto real · incluye «Comisión del vendedor (avión)» que ningún avión carga (el vuelo aún no se completa: al completarse lo cargará el avión): la paga VuelaTour',
      fecha: '2026-09-28',
    });
    // Mixto que nadie carga: egreso = Σ de las dos.
    expect(
      caso({
        vt: pagosDe(500),
        av: pagosDe(1000),
        todos: pagosDe(1500, { n: 2 }),
        lineaMxn: 1500,
        motivo: 'SIN_AVION',
      }),
    ).toEqual({
      egresoMxn: 1500,
      concepto:
        'pago comisión vendedor (Pablo Canales) · gasto real (2 pagos) · incluye «Comisión del vendedor (avión)» que ningún avión carga (vuelo sin avión de la flota): la paga VuelaTour',
      fecha: '2026-09-28',
    });
  });

  it('D5 · sin línea, solo «(VuelaTour)» (byte a byte)', () => {
    expect(
      caso({
        etiquetaComision: 'comisión vendedor',
        vt: pagosDe(1305),
        todos: pagosDe(1305),
        sinLinea: 'SIN_LINEA',
      }),
    ).toEqual({
      egresoMxn: 1305,
      concepto:
        'pago comisión vendedor · sin comisión cobrada en la cotización',
      fecha: '2026-09-28',
    });
  });

  it('D6 · sin línea, solo «(avión)» que carga un avión: fila INFORMATIVA, egreso $0.00', () => {
    expect(
      caso({
        etiquetaComision: 'comisión vendedor',
        av: pagosDe(1305),
        todos: pagosDe(1305),
        sinLinea: 'SIN_LINEA',
        aviones: [avionDe('N621TX', 1305)],
      }),
    ).toEqual({
      egresoMxn: 0,
      concepto:
        'pago comisión vendedor · sin comisión cobrada en la cotización · a cargo del avión N621TX ($1,305.00 en su columna COMISIONES)',
      fecha: '2026-09-28',
    });
  });

  it('D7 · sin línea, MIXTO (cancelado con cobros retenidos)', () => {
    expect(
      caso({
        etiquetaComision: 'comisión vendedor',
        vt: pagosDe(500),
        av: pagosDe(1000),
        todos: pagosDe(1500, { n: 2 }),
        sinLinea: 'CANCELADO',
        aviones: [avionDe('XB-PEV', 1000)],
      }),
    ).toEqual({
      egresoMxn: 500,
      concepto:
        'pago comisión vendedor · vuelo cancelado: sin comisión cobrada (2 pagos) · VuelaTour $500.00 · a cargo del avión XB-PEV ($1,000.00 en su columna COMISIONES)',
      fecha: '2026-09-28',
    });
  });

  it('D8 · sin línea y una «(avión)» que nadie carga', () => {
    expect(
      caso({
        etiquetaComision: 'comisión vendedor',
        av: pagosDe(1000),
        todos: pagosDe(1000),
        sinLinea: 'CANCELADO',
        motivo: 'CANCELADO',
      }),
    ).toEqual({
      egresoMxn: 1000,
      concepto:
        'pago comisión vendedor · vuelo cancelado: sin comisión cobrada · incluye «Comisión del vendedor (avión)» que ningún avión carga (vuelo cancelado sin cobros retenidos): la paga VuelaTour',
      fecha: '2026-09-28',
    });
  });

  it('variantes del sufijo: varios aviones, cifras que no cuadran y avión sin pesos', () => {
    expect(
      caso({
        av: pagosDe(1000),
        todos: pagosDe(1000),
        lineaMxn: 1000,
        aviones: [avionDe('XB-TST', 500), avionDe('XB-DOS', 500)],
      })?.concepto,
    ).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real · a cargo de los aviones XB-TST ($500.00 en su columna COMISIONES) y XB-DOS ($500.00 en su columna COMISIONES)',
    );
    expect(
      caso({
        av: pagosDe(1010),
        todos: pagosDe(1010),
        lineaMxn: 1010,
        aviones: [avionDe('XB-PEV', 1000)],
      })?.concepto,
    ).toBe(
      'pago comisión vendedor (Pablo Canales) · gasto real · a cargo del avión XB-PEV (resta en su columna COMISIONES)',
    );
    const sinPesos = caso({
      av: pagosDe(null, { sinTc: 1 }),
      todos: pagosDe(null, { sinTc: 1 }),
      lineaMxn: 1000,
      aviones: [avionDe('XB-PEV', 0)],
    });
    expect(sinPesos).toEqual({
      egresoMxn: 0,
      concepto:
        'pago comisión vendedor (Pablo Canales) · gasto real · a cargo del avión XB-PEV (sin T.C. no entra en pesos a su columna COMISIONES; resta en USD en su reparto)',
      fecha: '2026-09-28',
    });
  });

  it('reglas fijas: todos empiezan con «pago comisión vendedor», ninguno con «PROVISIÓN (», los de $0.00 nunca llevan «sin TC»', () => {
    const casos = [
      caso({ vt: pagosDe(1), todos: pagosDe(1), lineaMxn: 1 }),
      caso({
        av: pagosDe(null, { sinTc: 2, n: 2 }),
        todos: pagosDe(null, { sinTc: 2, n: 2 }),
        lineaMxn: 1,
        aviones: [avionDe('A', 0)],
      }),
      caso({
        av: pagosDe(5, { sinTc: 1, n: 2 }),
        todos: pagosDe(5, { sinTc: 1, n: 2 }),
        sinLinea: 'INCONSISTENTE',
        aviones: [avionDe('A', 5)],
      }),
      caso({
        av: pagosDe(1),
        todos: pagosDe(1),
        sinLinea: 'SIN_LINEA',
        motivo: 'SIN_FILA',
      }),
    ];
    for (const f of casos) {
      expect(f).not.toBeNull();
      expect(f!.concepto).toMatch(/^pago comisión vendedor/);
      expect(f!.concepto).not.toMatch(/PROVISI[OÓ]N \(/);
      if (f!.egresoMxn === 0) expect(f!.concepto).not.toMatch(/\bsin TC\b/);
    }
  });
});

describe('textos de los pendientes del balance y del Libro Dinero (11)', () => {
  const E = 'Vuelo #233 (03-sep CUN-MID)';

  it('pendiente de captura: dice cómo capturarlo en cualquiera de las dos', () => {
    expect(textoPendienteCapturaVendedor(E, 162.4)).toBe(
      "Vuelo #233 (03-sep CUN-MID): comisión del vendedor cotizada ($162.40 USD) sin pago capturado — captúralo en Gastos ligado a este vuelo como «Comisión del vendedor (avión)» si lo carga el avión (resta en su columna COMISIONES) o como «Comisión del vendedor (VuelaTour)» si lo paga VuelaTour ('otros movimientos' del Balance general)",
    );
  });

  it('pendiente sin T.C. de la «(avión)»', () => {
    expect(textoPendienteVendedorSinTc(E)).toBe(
      'Vuelo #233 (03-sep CUN-MID): pago al vendedor «Comisión del vendedor (avión)» en USD sin T.C. (ni tc_gasto ni T.C. de venta) — no entra a COMISIONES en pesos; en el reparto sí resta en USD (captura el T.C. del gasto o el de la cotización)',
    );
  });

  it('pendiente «(avión)» que ningún avión carga: singular y plural', () => {
    expect(textoPendientePagoVendedorAvionSinCargo(E, 1, 'NO_COMPLETADO')).toBe(
      "Vuelo #233 (03-sep CUN-MID): gasto «Comisión del vendedor (avión)» que ningún avión carga (el vuelo aún no se completa: al completarse lo cargará el avión) — lo paga VuelaTour en 'otros movimientos' del Balance general; si el pago es de VuelaTour, reclasifícalo a «Comisión del vendedor (VuelaTour)»",
    );
    expect(textoPendientePagoVendedorAvionSinCargo(E, 2, 'SIN_AVION')).toBe(
      "Vuelo #233 (03-sep CUN-MID): 2 gastos «Comisión del vendedor (avión)» que ningún avión carga (vuelo sin avión de la flota) — los paga VuelaTour en 'otros movimientos' del Balance general; si el pago es de VuelaTour, reclasifícalos a «Comisión del vendedor (VuelaTour)»",
    );
  });

  it('Libro Dinero: sufijo del concepto y nota de la celda («» sin «(avión)»; jamás «sin TC»)', () => {
    expect(sufijoParteAvionDinero(NINGUNO, true)).toBe('');
    expect(notaParteAvionDinero(NINGUNO, false)).toBe('');
    expect(sufijoParteAvionDinero(pagosDe(3000), true)).toBe(
      ' · incluye «Comisión del vendedor (avión)» por $3,000.00: la resta el avión en el Balance general',
    );
    expect(sufijoParteAvionDinero(pagosDe(null, { sinTc: 1 }), true)).toBe(
      ' · incluye «Comisión del vendedor (avión)»: la resta el avión en el Balance general',
    );
    expect(sufijoParteAvionDinero(pagosDe(3000), false)).toBe(
      ' · incluye «Comisión del vendedor (avión)» que ningún avión carga',
    );
    expect(notaParteAvionDinero(pagosDe(3000), true)).toBe(
      ' De ese pago, $3,000.00 MXN se capturó como «Comisión del vendedor (avión)»: en el Balance general y en el reparto lo resta el avión (columna COMISIONES); este libro registra la salida de dinero de VuelaTour.',
    );
    expect(notaParteAvionDinero(pagosDe(null, { sinTc: 1 }), true)).toBe(
      ' De ese pago, una parte se capturó como «Comisión del vendedor (avión)»: en el Balance general y en el reparto lo resta el avión (columna COMISIONES); este libro registra la salida de dinero de VuelaTour.',
    );
    expect(notaParteAvionDinero(pagosDe(3000), false)).toBe(
      ' Incluye pagos «Comisión del vendedor (avión)» de un vuelo que ningún avión carga: también en el Balance general los paga VuelaTour.',
    );
    for (const t of [
      sufijoParteAvionDinero(pagosDe(null, { sinTc: 1 }), true),
      notaParteAvionDinero(pagosDe(null, { sinTc: 1 }), true),
    ]) {
      expect(t).not.toMatch(/sin TC/);
    }
  });
});
