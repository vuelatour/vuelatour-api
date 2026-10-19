import {
  COMISIONES_AL_AVION_DESDE_DEFAULT,
  comisionesDelVuelo,
  type ComisionesDelVueloInput,
} from './comisiones-avion.util';
import type { GastoPagoVendedorRow } from './pago-vendedor.util';
import {
  particionIngresoVuelo,
  type VueloIngresoInput,
} from './ingreso-vuelo.util';

/**
 * REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92): las dos
 * llaves ADITIVAS de `comisionesDelVuelo` —`banco_sin_pesos_usd` y
 * `vendedor_sin_pesos_usd`— dicen cuántos DÓLARES (parte del avión)
 * restaron en `total_usd` sin llegar a pesos. Viajan SOLO cuando son > 0:
 * con pesos completos el objeto es el de siempre, byte a byte.
 */

const V: VueloIngresoInput = {
  monto_total_usd: 1500,
  subtotal_vuelo_usd: 1500,
  ajuste_final_usd: 0,
  comision_vendedor_usd: 0,
  iva_usd: 0,
  iva_pct: 0,
  tuas_usd: 0,
  extras_total_usd: 0,
  viaticos_pernocta_usd: 0,
  calculo_snapshot: null,
};

const cobroUsd = (comision: number) => ({
  moneda: 'USD',
  monto: 1000,
  tc_usd_mxn: null,
  comision_banco_monto: comision,
  comision_banco_pct: null,
  metodo_cobro: 'TRANSFERENCIA',
});

const pagoAvion = (
  monto: number,
  extra: Partial<GastoPagoVendedorRow> = {},
): GastoPagoVendedorRow => ({
  categoria: 'COMISION_VENDEDOR_AVION',
  monto,
  moneda: 'USD',
  tc_gasto: null,
  fecha_gasto: '2026-09-20',
  ...extra,
});

function entrada(
  extra: Partial<ComisionesDelVueloInput>,
): ComisionesDelVueloInput {
  return {
    diaVuelo: '2026-09-15',
    vigenteDesde: COMISIONES_AL_AVION_DESDE_DEFAULT,
    cobros: [cobroUsd(30)],
    gastos: [],
    tcVenta: 18.25,
    particion: particionIngresoVuelo(V),
    estado: 'COMPLETADO',
    parteAvion: (m: number) => m,
    participacion: 1,
    vendedorNombre: null,
    ...extra,
  };
}

describe('comisionesDelVuelo — dólares que no llegaron a pesos (0.0.94)', () => {
  it('con K: comisión bancaria de un cobro USD en pesos (30 × 18.25) y SIN las llaves nuevas', () => {
    const r = comisionesDelVuelo(entrada({}));
    expect(r.banco_mxn).toBe(547.5);
    expect(r.banco_usd).toBe(30);
    expect('banco_sin_pesos_usd' in r).toBe(false);
    expect('vendedor_sin_pesos_usd' in r).toBe(false);
  });

  it('sin K: la comisión bancaria del cobro USD resta en dólares y su parte del avión va a `banco_sin_pesos_usd`', () => {
    const r = comisionesDelVuelo(entrada({ tcVenta: null }));
    expect(r.banco_usd).toBe(30);
    expect(r.banco_mxn).toBe(0);
    expect(r.banco_sin_tc).toBe(1);
    expect(r.banco_sin_pesos_usd).toBe(30);
    expect('vendedor_sin_pesos_usd' in r).toBe(false);
  });

  it('sin K: un pago «(avión)» en USD sin tc_gasto resta en dólares y va a `vendedor_sin_pesos_usd` (el que trae tc_gasto sí llega a pesos)', () => {
    const r = comisionesDelVuelo(
      entrada({
        tcVenta: null,
        cobros: [cobroUsd(0)],
        gastos: [pagoAvion(100), pagoAvion(50, { tc_gasto: 18 })],
      }),
    );
    expect(r.vendedor_usd).toBe(150);
    expect(r.vendedor_mxn).toBe(900);
    expect(r.vendedor_sin_tc).toBe(true);
    expect(r.vendedor_sin_pesos_usd).toBe(100);
    expect('banco_sin_pesos_usd' in r).toBe(false);
  });

  it('multi-avión: la parte del avión de los dólares sin pesos sale con `parteAvion`', () => {
    const r = comisionesDelVuelo(
      entrada({
        tcVenta: null,
        parteAvion: (m: number) => Math.round(m * 50) / 100,
        participacion: 0.5,
      }),
    );
    expect(r.banco_usd).toBe(15);
    expect(r.banco_sin_pesos_usd).toBe(15);
  });
});
