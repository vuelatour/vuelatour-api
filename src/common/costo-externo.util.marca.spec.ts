import {
  pagoOperadorExternoEnGastos,
  usdPagadoAlOperador,
} from './costo-externo.util';
import {
  esPagoOperadorExterno,
  mensajePagoOperadorVueloNoExterno,
  rolMarcaPagoOperador,
} from './pago-operador-externo.util';
import { Rol } from './types/auth.types';

/**
 * EL PAGO AL OPERADOR EXTERNO SE MARCA EN EL GASTO (27-oct-2026, invariante
 * 110). Caso real #453 (oscar02-251026, Simon Herrera, 25-oct-2026): costo
 * cotizado $840 USD con T.C. 18.4888 (= $15,530.59) y el gasto de Ale de
 * $18,182.00 MXN (840 + IVA al T.C. del día): 17 % arriba, fuera del ±1 % de
 * la invariante 88 — el balance lo sumaba dos veces ($33,712.59).
 */
describe('pagoOperadorExternoEnGastos — la marca de la oficina manda (invariante 110)', () => {
  const SIMON = {
    id: '807fa413',
    categoria: 'OPERACIONES',
    moneda: 'MXN',
    monto: '18182.00',
    tc_gasto: null,
    fecha_gasto: '2026-10-27',
    created_at: '2026-10-27T17:19:53+00:00',
    es_pago_operador_externo: true,
  };
  const base = {
    esExterno: true,
    cancelado: false,
    costoUsd: '840.00',
    tcVenta: 18.4888,
  };

  it('#453: el gasto marcado cubre aunque NO coincida con el costo cotizado (hoy: doble conteo)', () => {
    const d = pagoOperadorExternoEnGastos({ ...base, gastos: [SIMON] });
    expect(d.cubre).toBe(SIMON);
    expect(d.pagos).toEqual([SIMON]);
    expect(d.marcado).toBe(true);
    // 17 % arriba: la coincidencia ±1 % no lo reconoce…
    expect(d.coinciden).toEqual([]);
    expect(d.duplicados).toEqual([]);
    expect(d.costoMxn).toBe(15530.59);
    // …y sin la marca el costo seguiría sumando (conducta de la invariante 88).
    const sin = pagoOperadorExternoEnGastos({
      ...base,
      gastos: [{ ...SIMON, es_pago_operador_externo: false }],
    });
    expect(sin.cubre).toBeNull();
    expect(sin.pagos).toEqual([]);
    expect(sin.marcado).toBe(false);
  });

  it('marcado SIN costo cotizado ⇒ el gasto ES el costo (pagos, cubre; costoMxn null)', () => {
    const d = pagoOperadorExternoEnGastos({
      ...base,
      costoUsd: null,
      gastos: [SIMON],
    });
    expect(d.cubre).toBe(SIMON);
    expect(d.pagos).toEqual([SIMON]);
    expect(d.marcado).toBe(true);
    expect(d.coinciden).toEqual([]);
    expect(d.costoMxn).toBeNull();
  });

  it('varios marcados (anticipo + liquidación) ⇒ TODOS son el pago, del más antiguo al más nuevo', () => {
    const anticipo = {
      ...SIMON,
      id: 'anticipo',
      monto: '5000.00',
      fecha_gasto: '2026-10-20',
    };
    const liquidacion = { ...SIMON, id: 'liq', monto: '13182.00' };
    const d = pagoOperadorExternoEnGastos({
      ...base,
      gastos: [liquidacion, anticipo],
    });
    expect(d.pagos).toEqual([anticipo, liquidacion]);
    expect(d.cubre).toBe(anticipo);
    expect(d.duplicados).toEqual([]);
  });

  it('marcado + otro SIN marca que coincide con el costo ⇒ el marcado cubre y el otro es posible duplicado', () => {
    // 840 × 18.4888 = 15,530.59: un gasto exacto SIN marca.
    const coincide = {
      ...SIMON,
      id: 'coincide',
      monto: '15530.59',
      fecha_gasto: '2026-10-26',
      es_pago_operador_externo: false,
    };
    const d = pagoOperadorExternoEnGastos({
      ...base,
      gastos: [coincide, SIMON],
    });
    expect(d.cubre).toBe(SIMON);
    expect(d.pagos).toEqual([SIMON]);
    expect(d.coinciden).toEqual([coincide]);
    expect(d.duplicados).toEqual([coincide]);
    expect(d.marcado).toBe(true);
  });

  it('la marca en una categoría fuera de las columnas (TUAS, empresa, pago al vendedor) no cuenta', () => {
    for (const categoria of ['TUAS', 'GAS', 'OTRO', 'COMISION_VENDEDOR']) {
      const d = pagoOperadorExternoEnGastos({
        ...base,
        gastos: [{ ...SIMON, categoria }],
      });
      expect(d.cubre).toBeNull();
      expect(d.pagos).toEqual([]);
      expect(d.candidatos).toEqual([]);
    }
  });

  it('CANCELADO o no externo ⇒ nada cubre aunque haya marca (igual que la invariante 88)', () => {
    expect(
      pagoOperadorExternoEnGastos({ ...base, cancelado: true, gastos: [SIMON] })
        .pagos,
    ).toEqual([]);
    expect(
      pagoOperadorExternoEnGastos({
        ...base,
        esExterno: false,
        gastos: [SIMON],
      }).pagos,
    ).toEqual([]);
  });

  it('sin marcas, la coincidencia ±1 % decide igual que siempre y `pagos` = [cubre]', () => {
    const nucleum = {
      ...SIMON,
      id: 'nucleum',
      monto: '25334.40',
      es_pago_operador_externo: false,
    };
    const d = pagoOperadorExternoEnGastos({
      ...base,
      costoUsd: '1490.26',
      tcVenta: 17,
      gastos: [nucleum],
    });
    expect(d.cubre).toBe(nucleum);
    expect(d.pagos).toEqual([nucleum]);
    expect(d.marcado).toBe(false);
  });

  it('usdPagadoAlOperador: Σ de los pagos en USD (MXN ÷ tc_gasto ?? K); vacío o alguno sin T.C. ⇒ null', () => {
    expect(usdPagadoAlOperador([], 18.4888)).toBeNull();
    // 18,182 ÷ 18.4888 = 983.41 (lo que el reparto resta por #453).
    expect(usdPagadoAlOperador([SIMON], 18.4888)).toBeCloseTo(983.41, 2);
    expect(
      usdPagadoAlOperador(
        [
          { ...SIMON, monto: '5000.00' },
          { ...SIMON, moneda: 'USD', monto: 100, tc_gasto: null },
        ],
        20,
      ),
    ).toBe(350);
    expect(usdPagadoAlOperador([SIMON], null)).toBeNull();
    expect(
      usdPagadoAlOperador([{ ...SIMON, moneda: 'USD', monto: 974.4 }], null),
    ).toBe(974.4);
  });

  it('esPagoOperadorExterno, rolMarcaPagoOperador y el mensaje del vuelo propio', () => {
    expect(esPagoOperadorExterno(SIMON)).toBe(true);
    expect(esPagoOperadorExterno({ es_pago_operador_externo: false })).toBe(
      false,
    );
    expect(esPagoOperadorExterno({})).toBe(false);
    expect(esPagoOperadorExterno(null)).toBe(false);
    for (const rol of [Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR]) {
      expect(rolMarcaPagoOperador(rol)).toBe(true);
    }
    for (const rol of [Rol.PILOTO, Rol.MECANICO, Rol.SOCIO, undefined]) {
      expect(rolMarcaPagoOperador(rol)).toBe(false);
    }
    expect(mensajePagoOperadorVueloNoExterno(450)).toContain('El vuelo #450');
    expect(mensajePagoOperadorVueloNoExterno(null)).toContain(
      'El vuelo elegido',
    );
  });
});
