import {
  adjuntarLigasRefacciones,
  costoMxnDeFilaRefaccion,
  costoTotalMxnDeSalida,
} from './refacciones-costo.util';

/**
 * Hoja «refacciones» del Balance GENERAL (25-sep-2026, API 0.0.36): el costo
 * de cada salida de bodega se convierte con el MISMO T.C. con que la fila
 * convierte la VENTA (el `tc_gasto` de SU gasto, o el promedio del libro).
 * Así la migración de T.C. del inventario (20260925000003, que solo toca
 * `inventario_movimiento.tc_usd_mxn`) no mueve la ganancia de la hoja.
 */

/** La salida real del aceite a XA-VGV (01-sep): 12 × 21.25 USD. */
const SALIDA_ACEITE = {
  cantidad: 12,
  moneda: 'USD',
  costo_unitario_usd: 21.25,
  costo_unitario_mxn: null,
  tc_usd_mxn: 17.0077, // YA con la migración de T.C. aplicada
  para_flota: false,
};

describe('costoMxnDeFilaRefaccion — el costo al T.C. de la VENTA de la fila', () => {
  it('gasto SIN tc_gasto (los 10 del 01-sep) ⇒ el T.C. promedio del libro, NO el 17.0077 del movimiento (mismo número que antes de la migración)', () => {
    const costo = costoMxnDeFilaRefaccion({
      mov: SALIDA_ACEITE,
      fila: { tc_gasto: null, monto_original: 318.75, monto_mxn: 5482.5 },
      tcPromedio: 17.2,
    });
    expect(costo).toBe(4386); // 255 × 17.20
    // Antes de la migración el movimiento no traía T.C. y caía al mismo promedio.
    expect(
      costoMxnDeFilaRefaccion({
        mov: { ...SALIDA_ACEITE, tc_usd_mxn: null },
        fila: { tc_gasto: null, monto_original: 318.75, monto_mxn: 5482.5 },
        tcPromedio: 17.2,
      }),
    ).toBe(costo);
  });

  it('gasto CON tc_gasto (salidas nuevas: T.C. oficial del día de la venta) ⇒ ese', () => {
    expect(
      costoMxnDeFilaRefaccion({
        mov: SALIDA_ACEITE,
        fila: { tc_gasto: 17.0077, monto_original: 318.75, monto_mxn: 5421.2 },
        tcPromedio: 17.2,
      }),
    ).toBe(4336.96); // round2(255 × 17.0077)
  });

  it('salida en PESOS: el costo nativo tal cual (sin T.C.)', () => {
    expect(
      costoTotalMxnDeSalida(
        {
          cantidad: 4,
          moneda: 'MXN',
          costo_unitario_usd: 94.71,
          costo_unitario_mxn: 1658.33,
          tc_usd_mxn: 17.51,
        },
        null,
      ),
    ).toBe(6633.32);
  });

  it('USD sin NINGÚN T.C. ⇒ undefined (la celda queda vacía, jamás un número falso)', () => {
    expect(
      costoMxnDeFilaRefaccion({
        mov: SALIDA_ACEITE,
        fila: { tc_gasto: null, monto_original: 318.75, monto_mxn: null },
        tcPromedio: null,
      }),
    ).toBeUndefined();
  });

  it('salida de FLOTA con dos gastos hermanos de tc_gasto distinto (uno editado a mano) ⇒ cada fila con el SUYO', () => {
    const flota = { ...SALIDA_ACEITE, cantidad: 2, para_flota: true };
    // 2 × 21.25 = 42.50 USD; dos gastos de 26.5625 USD cada uno.
    const suma = 53.13;
    const a = costoMxnDeFilaRefaccion({
      mov: flota,
      fila: { tc_gasto: 17.0077, monto_original: 26.57, monto_mxn: 451.89 },
      tcPromedio: 17.2,
      sumaMontoFlota: suma,
    });
    const b = costoMxnDeFilaRefaccion({
      mov: flota,
      fila: { tc_gasto: 18, monto_original: 26.56, monto_mxn: 478.08 },
      tcPromedio: 17.2,
      sumaMontoFlota: suma,
    });
    // round2(42.50 × tc) × parte / Σ, cada una con SU T.C.:
    // 722.83 × 26.57 / 53.13 = 361.48 · 765.00 × 26.56 / 53.13 = 382.43
    expect(a).toBe(361.48);
    expect(b).toBe(382.43);
    expect(a).not.toBe(b);
    // Sin base de prorrateo ⇒ null.
    expect(
      costoMxnDeFilaRefaccion({
        mov: flota,
        fila: { tc_gasto: 18, monto_original: 26.56, monto_mxn: 478.08 },
        tcPromedio: 17.2,
        sumaMontoFlota: 0,
      }),
    ).toBeNull();
  });
});

describe('adjuntarLigasRefacciones — el tc_gasto cae en la fila correcta', () => {
  it('con fechas desordenadas: mismo sort estable que buildHoja (por fecha_gasto)', () => {
    const gastos = [
      {
        fecha_gasto: '2026-09-15',
        inventario_movimiento_id: 'm-c',
        tc_gasto: '17.2',
      },
      {
        fecha_gasto: '2026-09-01',
        inventario_movimiento_id: 'm-a',
        tc_gasto: null,
      },
      {
        fecha_gasto: '2026-09-15',
        inventario_movimiento_id: 'm-d',
        tc_gasto: 18,
      },
      {
        fecha_gasto: '2026-09-03',
        inventario_movimiento_id: 'm-b',
        tc_gasto: 17.0077,
      },
    ];
    // Las filas de la hoja YA vienen ordenadas por fecha (buildHoja).
    const filas = ['2026-09-01', '2026-09-03', '2026-09-15', '2026-09-15'].map(
      (fecha) => ({ fecha }),
    );
    const r = adjuntarLigasRefacciones(filas, gastos);
    expect(r).toEqual([
      { fecha: '2026-09-01', inventario_movimiento_id: 'm-a', tc_gasto: null },
      {
        fecha: '2026-09-03',
        inventario_movimiento_id: 'm-b',
        tc_gasto: 17.0077,
      },
      // Empate de fecha: el orden de llegada se conserva (sort estable).
      { fecha: '2026-09-15', inventario_movimiento_id: 'm-c', tc_gasto: 17.2 },
      { fecha: '2026-09-15', inventario_movimiento_id: 'm-d', tc_gasto: 18 },
    ]);
  });
});
