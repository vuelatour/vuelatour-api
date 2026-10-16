import { BadRequestException } from '@nestjs/common';
import {
  etiquetaGastoPagoOperador,
  gastoRestaEnColumnasDelVuelo,
  pagoOperadorExternoEnGastos,
  resolverCostoExterno,
  usdDelPagoOperador,
} from './costo-externo.util';

describe('resolverCostoExterno (fuente única del costo del externo)', () => {
  it('USD: usd = monto tal cual, sin TC', () => {
    expect(
      resolverCostoExterno({ monto: 4500, moneda: 'USD', tcVuelo: 18 }),
    ).toEqual({ monto: 4500, moneda: 'USD', tc: null, usd: 4500 });
  });

  it('moneda omitida = USD (compat con payloads legados)', () => {
    expect(resolverCostoExterno({ monto: '1200.505' })).toEqual({
      monto: 1200.51,
      moneda: 'USD',
      tc: null,
      usd: 1200.51,
    });
  });

  it('MXN con TC del DTO: usd derivado = monto / tc (2 decimales)', () => {
    expect(
      resolverCostoExterno({ monto: 90000, moneda: 'MXN', tc: 18 }),
    ).toEqual({ monto: 90000, moneda: 'MXN', tc: 18, usd: 5000 });
  });

  it('MXN sin TC propio usa el de la cotización (respaldo)', () => {
    expect(
      resolverCostoExterno({ monto: 35000, moneda: 'MXN', tcVuelo: '17.5' }),
    ).toEqual({ monto: 35000, moneda: 'MXN', tc: 17.5, usd: 2000 });
  });

  it('MXN sin ningún TC: rechaza con 400 (jamás sumar crudo como USD)', () => {
    expect(() => resolverCostoExterno({ monto: 35000, moneda: 'MXN' })).toThrow(
      BadRequestException,
    );
  });

  it('TC fuera de la banda 15–25: rechaza con 400 (error de captura)', () => {
    expect(() =>
      resolverCostoExterno({ monto: 100, moneda: 'MXN', tc: 5 }),
    ).toThrow(BadRequestException);
    expect(() =>
      resolverCostoExterno({ monto: 100, moneda: 'MXN', tcVuelo: 30 }),
    ).toThrow(BadRequestException);
  });

  it('monto vacío/0/negativo = limpiar: las 4 columnas null', () => {
    const nulo = { monto: null, moneda: null, tc: null, usd: null };
    expect(resolverCostoExterno({ monto: null, moneda: 'MXN' })).toEqual(nulo);
    expect(resolverCostoExterno({ monto: 0, moneda: 'USD' })).toEqual(nulo);
    expect(resolverCostoExterno({ monto: undefined })).toEqual(nulo);
    expect(resolverCostoExterno({ monto: -10 })).toEqual(nulo);
  });
});

/**
 * EL PAGO AL OPERADOR EXTERNO ES EL GASTO REAL (16-oct-2026, invariante 88).
 * Casos reales de prod: #308 (CarlosMuciño, 10-sep-2026, T.C. 17) con costo
 * capturado $25,334.40 MXN (= 1,490.26 USD) Y el gasto NUCLEUM de
 * $25,334.40 que es su pago; #290 (mismo operador) solo con gasto.
 */
describe('pagoOperadorExternoEnGastos (el gasto real cubre el costo del operador)', () => {
  const NUCLEUM = {
    id: '51170876',
    categoria: 'OPERACIONES',
    moneda: 'MXN',
    monto: '25334.40',
    tc_gasto: null,
    fecha_gasto: '2026-09-15',
    created_at: '2026-09-15T19:31:58+00:00',
  };
  const PISTA = {
    id: '4f3ef2da',
    categoria: 'OPERACIONES',
    moneda: 'MXN',
    monto: '1118.12',
    tc_gasto: null,
    fecha_gasto: '2026-09-10',
    created_at: '2026-10-14T17:01:32+00:00',
  };
  const base = {
    esExterno: true,
    cancelado: false,
    costoUsd: '1490.26',
    tcVenta: 17,
  };

  it('#308: costo capturado + gasto igual ⇒ el gasto CUBRE (se cuenta una vez)', () => {
    const d = pagoOperadorExternoEnGastos({
      ...base,
      gastos: [PISTA, NUCLEUM],
    });
    expect(d.cubre).toBe(NUCLEUM);
    expect(d.coinciden).toEqual([NUCLEUM]);
    expect(d.duplicados).toEqual([]);
    expect(d.candidatos).toEqual([PISTA, NUCLEUM]);
    // 1,490.26 × 17 = 25,334.42 (el gasto, 25,334.40: −0.0001 %).
    expect(d.costoMxn).toBe(25334.42);
  });

  it('#290: solo gasto, sin costo capturado ⇒ nada cubre (igual que hoy)', () => {
    const d = pagoOperadorExternoEnGastos({
      ...base,
      costoUsd: null,
      tcVenta: 16.92166,
      gastos: [{ ...NUCLEUM, monto: '11046.60' }],
    });
    expect(d.cubre).toBeNull();
    expect(d.coinciden).toEqual([]);
    expect(d.candidatos).toHaveLength(1);
    expect(d.costoMxn).toBeNull();
  });

  it('costo sin gasto, o con un gasto que no coincide ⇒ nada cubre (igual que hoy)', () => {
    expect(
      pagoOperadorExternoEnGastos({ ...base, gastos: [] }).cubre,
    ).toBeNull();
    const d = pagoOperadorExternoEnGastos({ ...base, gastos: [PISTA] });
    expect(d.cubre).toBeNull();
    expect(d.candidatos).toEqual([PISTA]);
  });

  it('±1 %: el borde entra, un centavo más allá no', () => {
    // costo 1,000 USD × 20 = 20,000 MXN; 1 % = 200.
    const c = { ...base, costoUsd: 1000, tcVenta: 20 };
    const g = (monto: number) => ({ ...PISTA, monto });
    expect(
      pagoOperadorExternoEnGastos({ ...c, gastos: [g(20200)] }).cubre,
    ).not.toBeNull();
    expect(
      pagoOperadorExternoEnGastos({ ...c, gastos: [g(19800)] }).cubre,
    ).not.toBeNull();
    expect(
      pagoOperadorExternoEnGastos({ ...c, gastos: [g(20200.01)] }).cubre,
    ).toBeNull();
  });

  it('dos gastos que coinciden ⇒ cubre el más cercano y el otro es posible duplicado', () => {
    const lejos = { ...NUCLEUM, id: 'lejos', monto: '25500.00' };
    const d = pagoOperadorExternoEnGastos({
      ...base,
      gastos: [lejos, NUCLEUM],
    });
    expect(d.cubre).toBe(NUCLEUM);
    expect(d.duplicados).toEqual([lejos]);
    expect(d.coinciden).toEqual([NUCLEUM, lejos]);
  });

  it('empate exacto ⇒ cubre el más antiguo (fecha_gasto, luego alta, luego llegada)', () => {
    const despues = { ...NUCLEUM, id: 'despues', fecha_gasto: '2026-09-20' };
    expect(
      pagoOperadorExternoEnGastos({ ...base, gastos: [despues, NUCLEUM] })
        .cubre,
    ).toBe(NUCLEUM);
    const altaDespues = {
      ...NUCLEUM,
      id: 'alta',
      created_at: '2026-09-16T10:00:00+00:00',
    };
    expect(
      pagoOperadorExternoEnGastos({ ...base, gastos: [altaDespues, NUCLEUM] })
        .cubre,
    ).toBe(NUCLEUM);
    const a = { ...NUCLEUM, id: 'a', created_at: null };
    const b = { ...NUCLEUM, id: 'b', created_at: null };
    const d = pagoOperadorExternoEnGastos({ ...base, gastos: [a, b] });
    expect(d.cubre).toBe(a);
    expect(d.duplicados).toEqual([b]);
  });

  it('gasto en USD vs costo en USD: coincide en USD nativo aunque su T.C. difiera de K', () => {
    const usd = {
      ...NUCLEUM,
      moneda: 'USD',
      monto: 1490.26,
      tc_gasto: 18.5, // × 18.5 = 27,569.81 MXN: en pesos NO coincidiría
    };
    const d = pagoOperadorExternoEnGastos({ ...base, gastos: [usd] });
    expect(d.cubre).toBe(usd);
    // Sin K tampoco se pierde: la prueba en USD nativo no lo necesita.
    expect(
      pagoOperadorExternoEnGastos({ ...base, tcVenta: null, gastos: [usd] })
        .cubre,
    ).toBe(usd);
    // Un gasto en MXN sin K no se puede comparar: no cubre.
    expect(
      pagoOperadorExternoEnGastos({ ...base, tcVenta: null, gastos: [NUCLEUM] })
        .cubre,
    ).toBeNull();
  });

  it('CANCELADO o no externo ⇒ nunca cubre (igual que hoy)', () => {
    expect(
      pagoOperadorExternoEnGastos({
        ...base,
        cancelado: true,
        gastos: [NUCLEUM],
      }).cubre,
    ).toBeNull();
    expect(
      pagoOperadorExternoEnGastos({
        ...base,
        esExterno: false,
        gastos: [NUCLEUM],
      }).cubre,
    ).toBeNull();
  });

  it('solo gastos de las columnas: TUAS/GAS/PERMISO/INDIRECTO, empresa y pago al vendedor no pueden ser el pago', () => {
    for (const categoria of [
      'TUAS',
      'GAS',
      'PERMISO',
      'INDIRECTO',
      'OTRO',
      'NOMINA',
      'COMISION_VENDEDOR',
      'COMISION_VENDEDOR_AVION',
    ]) {
      expect(gastoRestaEnColumnasDelVuelo(categoria)).toBe(false);
      expect(
        pagoOperadorExternoEnGastos({
          ...base,
          gastos: [{ ...NUCLEUM, categoria }],
        }).cubre,
      ).toBeNull();
    }
    for (const categoria of ['OPERACIONES', 'ATERRIZAJE', 'FBO', 'HOTEL']) {
      expect(gastoRestaEnColumnasDelVuelo(categoria)).toBe(true);
    }
  });

  it('usdDelPagoOperador: USD tal cual; MXN ÷ tc_gasto ?? K; sin T.C. ⇒ null', () => {
    expect(
      usdDelPagoOperador({ ...NUCLEUM, moneda: 'USD', monto: 100 }, 17),
    ).toBe(100);
    expect(usdDelPagoOperador(NUCLEUM, 17)).toBeCloseTo(1490.2588, 4);
    expect(usdDelPagoOperador({ ...NUCLEUM, tc_gasto: '20' }, 17)).toBeCloseTo(
      1266.72,
      2,
    );
    expect(usdDelPagoOperador(NUCLEUM, null)).toBeNull();
  });

  it('etiquetaGastoPagoOperador: categoría · proveedor · primera línea de la nota', () => {
    expect(
      etiquetaGastoPagoOperador({
        categoria: 'OPERACIONES',
        notas:
          'VLO PTU 10 SEPTIEMBRE XBORN · Proveedor: NUCLEUM SA DE CV\notra',
        proveedor: null,
      }),
    ).toBe(
      'Operaciones · VLO PTU 10 SEPTIEMBRE XBORN · Proveedor: NUCLEUM SA DE CV',
    );
    expect(
      etiquetaGastoPagoOperador({
        categoria: 'OPERACIONES',
        notas: null,
        proveedor: [{ nombre: 'NUCLEUM' }],
      }),
    ).toBe('Operaciones · NUCLEUM');
  });
});
