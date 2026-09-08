import {
  estadoCobroSemaforo,
  pendienteCobro,
  TOLERANCIA_COBRO_USD,
} from './semaforo-cobro.util';

/**
 * Espejo del panel (`vuelatour-next/src/lib/admin/cobros.ts`): misma
 * taxonomía y misma tolerancia de redondeo (caso #131).
 */
describe('estadoCobroSemaforo (espejo server-side del panel)', () => {
  it('tolerancia: hasta 1 USD de diferencia es redondeo, no deuda', () => {
    expect(TOLERANCIA_COBRO_USD).toBe(1);
    expect(pendienteCobro(3596, 3595.99)).toBe(0);
    expect(pendienteCobro(3596, 3594.5)).toBe(1.5);
  });

  it('cobrado por bandera o por tolerancia → verde', () => {
    expect(
      estadoCobroSemaforo({
        montoTotalUsd: 1000,
        cobrado: true,
        totalCobradoUsd: 0,
      }),
    ).toMatchObject({ key: 'COBRADO', color: 'verde', label: 'Cobrado' });
    expect(
      estadoCobroSemaforo({
        montoTotalUsd: 3596,
        cobrado: false,
        totalCobradoUsd: 3595.99,
      }),
    ).toMatchObject({ key: 'COBRADO', color: 'verde' });
  });

  it('con abonos → parcial (amarillo); sin ningún cobro → rojo', () => {
    const parcial = estadoCobroSemaforo({
      montoTotalUsd: 1000,
      cobrado: false,
      totalCobradoUsd: 400,
    });
    expect(parcial).toMatchObject({ key: 'PARCIAL', color: 'amarillo' });
    expect(parcial.title).toContain('Cobrado $400 de $1,000 USD');
    expect(
      estadoCobroSemaforo({
        montoTotalUsd: 1000,
        cobrado: false,
        totalCobradoUsd: 0,
      }),
    ).toMatchObject({ key: 'SIN_COBROS', color: 'rojo', label: 'Sin cobro' });
  });

  it('cobros MXN sin TC (no convierten) cuentan como parcial, nunca como "sin cobro"', () => {
    const r = estadoCobroSemaforo({
      montoTotalUsd: 1000,
      cobrado: false,
      totalCobradoUsd: 0,
      sinTcCount: 1,
    });
    expect(r).toMatchObject({ key: 'PARCIAL', color: 'amarillo' });
    expect(r.title).toContain('sin TC');
  });

  it('no aplica (gris): abierta, sin precio, interno, cancelado, en cotización', () => {
    expect(
      estadoCobroSemaforo({
        montoTotalUsd: 1000,
        cobrado: false,
        totalCobradoUsd: 0,
        cotizacionAbierta: true,
      }),
    ).toMatchObject({ key: 'NO_APLICA', color: 'gris', label: 'Abierta' });
    expect(
      estadoCobroSemaforo({
        montoTotalUsd: 0,
        cobrado: false,
        totalCobradoUsd: 0,
      }),
    ).toMatchObject({ key: 'NO_APLICA', label: 'Sin precio' });
    expect(
      estadoCobroSemaforo({
        montoTotalUsd: 0,
        cobrado: false,
        totalCobradoUsd: 0,
        esInterno: true,
      }),
    ).toMatchObject({ key: 'NO_APLICA', label: 'Interno' });
    // Cancelado ANTES de parcial: nunca invita a cobrar el saldo.
    expect(
      estadoCobroSemaforo({
        montoTotalUsd: 1000,
        cobrado: false,
        totalCobradoUsd: 300,
        cancelado: true,
      }),
    ).toMatchObject({ key: 'NO_APLICA', label: 'Con cobros' });
    expect(
      estadoCobroSemaforo({
        montoTotalUsd: 1000,
        cobrado: false,
        totalCobradoUsd: 0,
        enCotizacion: true,
      }),
    ).toMatchObject({ key: 'NO_APLICA', label: '—' });
  });

  it('sin lote de cobros (null) degrada a "Por cobrar"', () => {
    expect(
      estadoCobroSemaforo({
        montoTotalUsd: 1000,
        cobrado: false,
        totalCobradoUsd: null,
      }),
    ).toMatchObject({ key: 'SIN_COBROS', label: 'Por cobrar', color: 'rojo' });
  });
});
