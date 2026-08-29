import {
  cobradoParteAvion,
  cobradoParteVuelatour,
  pagoVendedorUsd,
  particionIngresoVuelo,
  sobrecobroUsd,
} from './ingreso-vuelo.util';

// Vuelo real #192 (prod, ago-2026): 3.1667 hr × $700 + TUAS 250 + extras
// 1,250 + redondeo 8.66 + IVA 594.67 = 4,320.00; base IVA 3,716.67.
const V192 = {
  monto_total_usd: '4320.00',
  subtotal_vuelo_usd: '2216.67',
  ajuste_final_usd: '8.66',
  comision_vendedor_usd: '0.00',
  iva_usd: '594.67',
  iva_pct: '0.1600',
  tuas_usd: '250.00',
  extras_total_usd: '1250.00',
  viaticos_pernocta_usd: '0.00',
  calculo_snapshot: {
    desglose: [
      {
        clave: 'TIEMPO_VUELO',
        concepto: 'Tiempo de vuelo',
        monto_usd: 2216.67,
      },
      { clave: 'TUAS', concepto: 'TUA CUN', monto_usd: 125 },
      { clave: 'TUAS', concepto: 'TUA CTM', monto_usd: 125 },
      { clave: 'EXTRA', concepto: 'ESPERA', monto_usd: 50 },
      { clave: 'EXTRA', concepto: 'Extensión de servicios', monto_usd: 1200 },
      { clave: 'AJUSTE', concepto: 'Redondeo', monto_usd: 8.66 },
      { clave: 'IVA', concepto: 'IVA 16%', monto_usd: 594.67 },
    ],
    iva: { porcentaje: 0.16, base_usd: 3716.67, monto_usd: 594.67 },
    meta: { redondeo_auto_usd: 8.66 },
  },
};

describe('particionIngresoVuelo', () => {
  it('parte el vuelo #192: avión = tiempo + redondeo + IVA proporcional; VuelaTour = extras + su IVA', () => {
    const p = particionIngresoVuelo(V192);
    expect(p.fuente).toBe('desglose');
    expect(p.inconsistente).toBe(false);
    expect(p.total_usd).toBe(4320);
    expect(p.iva_avion_usd).toBe(354.67); // 2216.67 × 0.16
    expect(p.avion_usd).toBe(2580); // 2216.67 + 8.66 + 354.67
    expect(p.vuelatour_usd).toBe(1740); // 1500 + 240 de IVA
    expect(p.iva_vuelatour_usd).toBe(240);
    expect(p.tuas_usd).toBe(250);
    expect(p.extras_usd).toBe(1250);
    expect(p.avion_usd + p.vuelatour_usd).toBeCloseTo(p.total_usd, 2);
  });

  it('prorratea cobros: pagado completo = venta del avión exacta; parcial proporcional', () => {
    const p = particionIngresoVuelo(V192);
    expect(cobradoParteAvion(4320, p)).toBe(2580);
    expect(cobradoParteVuelatour(4320, p)).toBe(1740);
    expect(cobradoParteAvion(2160, p)).toBe(1290);
    expect(cobradoParteAvion(0, p)).toBe(0);
  });

  it('sobrecobro: la parte del avión se topa en su venta y el exceso es de VuelaTour', () => {
    const p = particionIngresoVuelo(V192);
    expect(cobradoParteAvion(4500, p)).toBe(2580); // topado
    expect(cobradoParteVuelatour(4500, p)).toBe(1920); // 1740 + 180 de exceso
    expect(sobrecobroUsd(4500, p)).toBe(180);
    expect(sobrecobroUsd(4320, p)).toBe(0);
    expect(sobrecobroUsd(1000, p)).toBe(0);
  });

  it('sin IVA (efectivo): la comisión del vendedor es ingreso de VuelaTour (como un extra), no del avión', () => {
    const p = particionIngresoVuelo({
      monto_total_usd: 1500,
      calculo_snapshot: {
        desglose: [
          { clave: 'TIEMPO_VUELO', monto_usd: 1000 },
          { clave: 'COMISION_VENDEDOR', monto_usd: 100 },
          { clave: 'EXTRA', monto_usd: 300 },
          { clave: 'PERNOCTA', monto_usd: 100 },
        ],
        iva: { porcentaje: 0, base_usd: 0 },
      },
    });
    expect(p.avion_usd).toBe(1000);
    expect(p.comision_vendedor_usd).toBe(100);
    expect(p.vuelatour_usd).toBe(500);
    expect(p.iva_avion_usd).toBe(0);
    expect(p.pernocta_usd).toBe(100);
  });

  it('cotización #132 (comisión 832 + IVA): el IVA de la comisión también es de VuelaTour', () => {
    // 2.6 hr × 1,600 + TUA 200 + extra sin IVA 301.14 + comisión 832 +
    // IVA 16 % sobre 5,192 = 830.72 → total 6,323.86.
    const p = particionIngresoVuelo({
      monto_total_usd: '6323.86',
      calculo_snapshot: {
        desglose: [
          {
            clave: 'TIEMPO_VUELO',
            concepto: 'Tiempo de vuelo',
            monto_usd: 4160,
          },
          { clave: 'TUAS', concepto: 'TUA CTM', monto_usd: 200 },
          {
            clave: 'EXTRA',
            concepto: '5% pay wise (sin IVA)',
            monto_usd: 301.14,
          },
          {
            clave: 'COMISION_VENDEDOR',
            concepto: 'Comisión del vendedor (Riviera Charters)',
            monto_usd: 832,
          },
          { clave: 'IVA', concepto: 'IVA 16%', monto_usd: 830.72 },
        ],
        iva: { porcentaje: 0.16, base_usd: 5192, monto_usd: 830.72 },
      },
    });
    expect(p.fuente).toBe('desglose');
    expect(p.inconsistente).toBe(false);
    expect(p.iva_avion_usd).toBe(665.6);
    expect(p.avion_usd).toBe(4825.6);
    expect(p.comision_vendedor_usd).toBe(832);
    // 200 + 301.14 + 832 + IVA (32 + 133.12) = 1,498.26
    expect(p.vuelatour_usd).toBe(1498.26);
    expect(p.iva_vuelatour_usd).toBe(165.12);
    expect(p.avion_usd + p.vuelatour_usd).toBeCloseTo(6323.86, 2);
    // Pago al vendedor = comisión + su IVA (una sola regla para todos los
    // lectores): 832 + 133.12.
    expect(p.iva_frac).toBe(0.16);
    expect(pagoVendedorUsd(p)).toBe(965.12);
  });

  it('pago al vendedor sin IVA cuando la cotización no grava', () => {
    const p = particionIngresoVuelo({
      monto_total_usd: 1500,
      calculo_snapshot: {
        desglose: [
          { clave: 'TIEMPO_VUELO', monto_usd: 1000 },
          { clave: 'COMISION_VENDEDOR', monto_usd: 100 },
          { clave: 'EXTRA', monto_usd: 400 },
        ],
        iva: { porcentaje: 0, base_usd: 0 },
      },
    });
    expect(p.iva_frac).toBe(0);
    expect(pagoVendedorUsd(p)).toBe(100);
  });

  it('columnas con comisión: IVA del avión solo sobre tiempo + ajuste', () => {
    const p = particionIngresoVuelo({
      monto_total_usd: '1276.00',
      subtotal_vuelo_usd: '1000.00',
      ajuste_final_usd: '0',
      comision_vendedor_usd: '100',
      iva_usd: '176.00',
      iva_pct: '0.16',
      tuas_usd: '0',
      extras_total_usd: '0',
      viaticos_pernocta_usd: '0',
      calculo_snapshot: null,
    });
    expect(p.fuente).toBe('columnas');
    expect(p.avion_usd).toBe(1160);
    expect(p.vuelatour_usd).toBe(116); // comisión 100 + IVA 16
  });

  it('externo manual: varias líneas TIEMPO_VUELO (una por tramo) suman la venta', () => {
    const p = particionIngresoVuelo({
      monto_total_usd: 3480,
      calculo_snapshot: {
        desglose: [
          { clave: 'TIEMPO_VUELO', monto_usd: 1500 },
          { clave: 'TIEMPO_VUELO', monto_usd: 1500 },
          { clave: 'IVA', monto_usd: 480 },
        ],
        iva: { porcentaje: 0.16, base_usd: 3000 },
      },
    });
    expect(p.avion_usd).toBe(3480);
    expect(p.vuelatour_usd).toBe(0);
  });

  it('fallback por columnas cuando no hay desglose (externo rápido / snapshot viejo)', () => {
    const p = particionIngresoVuelo({
      monto_total_usd: '1392.00',
      subtotal_vuelo_usd: '1000.00',
      ajuste_final_usd: '0',
      comision_vendedor_usd: '0',
      iva_usd: '192.00',
      iva_pct: '0.16',
      tuas_usd: '200.00',
      extras_total_usd: '0',
      viaticos_pernocta_usd: '0',
      calculo_snapshot: null,
    });
    expect(p.fuente).toBe('columnas');
    expect(p.iva_avion_usd).toBe(160);
    expect(p.avion_usd).toBe(1160);
    expect(p.vuelatour_usd).toBe(232); // 200 + 32 IVA
  });

  it('precio PACTADO (delta post-IVA en la línea AJUSTE sin meta): el IVA del avión sale de la base gravable', () => {
    // Motor: tiempo 3,000 + TUAS 250 = base 3,250, IVA 520; pactado 3,800 →
    // AJUSTE 30 post-IVA (no gravable). Correcto: IVA avión 480, avión 3,510.
    const p = particionIngresoVuelo({
      monto_total_usd: 3800,
      calculo_snapshot: {
        desglose: [
          { clave: 'TIEMPO_VUELO', monto_usd: 1500 },
          { clave: 'TIEMPO_VUELO', monto_usd: 1500 },
          { clave: 'TUAS', monto_usd: 250 },
          { clave: 'AJUSTE', monto_usd: 30 },
          { clave: 'IVA', monto_usd: 520 },
        ],
        iva: { porcentaje: 0.16, base_usd: 3250 },
        meta: { total_pactado_usd: 3800, redondeo_auto_usd: null },
      },
    });
    expect(p.iva_avion_usd).toBe(480);
    expect(p.avion_usd).toBe(3510);
    expect(p.vuelatour_usd).toBe(290); // 250 + 40 de IVA
  });

  it('extras SIN IVA (comisión BillPocket) no entran a la base gravable', () => {
    const p = particionIngresoVuelo({
      monto_total_usd: 1466,
      calculo_snapshot: {
        desglose: [
          { clave: 'TIEMPO_VUELO', monto_usd: 1000 },
          { clave: 'EXTRA', concepto: 'Catering', monto_usd: 200 },
          {
            clave: 'EXTRA',
            concepto: 'Comisión BillPocket (5%) (sin IVA)',
            monto_usd: 74,
          },
          { clave: 'IVA', monto_usd: 192 },
        ],
        iva: { porcentaje: 0.16, base_usd: 1200 },
      },
    });
    expect(p.iva_avion_usd).toBe(160);
    expect(p.avion_usd).toBe(1160);
    expect(p.vuelatour_usd).toBe(306); // 200 + 32 IVA + 74
  });

  it('columnas que no representan el total: no inventa dinero (todo al avión) y lo marca', () => {
    const p = particionIngresoVuelo({
      monto_total_usd: 1500,
      calculo_snapshot: null,
    });
    expect(p.fuente).toBe('columnas');
    expect(p.inconsistente).toBe(true);
    expect(p.avion_usd).toBe(1500);
    expect(p.vuelatour_usd).toBe(0);
    expect(p.factor_avion).toBe(1);
  });

  it('cliente interno / sin precio: todo en cero, factor 1', () => {
    const p = particionIngresoVuelo({ monto_total_usd: 0 });
    expect(p.fuente).toBe('sin_precio');
    expect(p.avion_usd).toBe(0);
    expect(p.factor_avion).toBe(1);
  });

  it('desglose que no cuadra con el total: no inventa dinero (todo al avión) y lo marca', () => {
    const p = particionIngresoVuelo({
      monto_total_usd: 1000,
      calculo_snapshot: {
        desglose: [
          { clave: 'TIEMPO_VUELO', monto_usd: 500 },
          { clave: 'EXTRA', monto_usd: 100 },
        ],
      },
    });
    expect(p.inconsistente).toBe(true);
    expect(p.avion_usd).toBe(1000);
    expect(p.vuelatour_usd).toBe(0);
  });
});
