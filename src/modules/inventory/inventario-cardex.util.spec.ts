import * as util from './inventario-cardex.util';
import {
  agregadosDeItem,
  aMxn,
  aUsd,
  bloquesCardexDe,
  costoDeSalida,
  costoUnitarioMxnDe,
  costoVigenteEn,
  etiquetaCargoDeSalida,
  existenciaDe,
  fechaCardexEsMx,
  fijaPrecio,
  filtroPeriodo,
  MARGEN_VENTA_PCT_DEFAULT,
  margenVentaValido,
  montoGastoDeSalida,
  montosDeCompra,
  precioTxt,
  precioVentaDeSalida,
  REGLA_COSTO,
  resumenDiarioDe,
  round,
  salidasQueDependenDe,
  sortChrono,
  statsDe,
  textoEntradaConSalidas,
  textoSalidaAntesDeLaCompra,
  ventaDeSalida,
  ventaUnitariaConMargen,
  walkCardex,
  type MovCardex,
} from './inventario-cardex.util';
import {
  cardexProd25sep,
  ITEM_ACEITE,
  todosLosMovimientos,
} from './cardex-prod-25sep.fixture-spec';

/**
 * REGLA DE COSTO del 25-sep-2026 (API 0.0.36): ÚLTIMO PRECIO DE COMPRA +
 * T.C. OFICIAL DEL DÍA. Pedido del cliente: «Compramos aceite en agosto a 21
 * DLS teniendo en stock unos 10, vendemos 5 … en septiembre compramos 5 pero
 * ahora están a 30 DLS, entonces el remanente que teníamos de agosto ahora
 * igual su costo de 30 DLS» + «En el tipo de cambio, que sea los mismos que
 * usan en las cotizaciones (Tipo de cambio del día de la venta)».
 */

/** ENTRADA (compra). `tc` = el T.C. de la fila (capturado u oficial). */
function ent(
  id: string,
  cantidad: number,
  costo: number,
  moneda: 'MXN' | 'USD',
  tc: number | null,
  fecha: string,
  creado = `${fecha}T15:00:00Z`,
  extra: Partial<MovCardex> = {},
): MovCardex {
  return {
    id,
    tipo: 'ENTRADA',
    cantidad,
    costo_unitario_usd: moneda === 'MXN' && tc ? round(costo / tc, 4) : costo,
    moneda,
    costo_unitario_mxn: moneda === 'MXN' ? costo : null,
    tc_usd_mxn: tc,
    fecha_movimiento: fecha,
    created_at: creado,
    ...extra,
  };
}

/** SALIDA tal como la GUARDA el API: costo de la compra vigente + T.C. del día de la venta. */
function sal(
  id: string,
  cantidad: number,
  p: {
    costo: number;
    moneda: 'MXN' | 'USD';
    /** costo_unitario_usd de la compra vigente (solo si moneda MXN). */
    costoUsd?: number;
    tc: number | null;
    venta?: number | null;
    ventaMoneda?: 'MXN' | 'USD' | null;
    fecha: string;
    creado?: string;
    matricula?: string;
    flota?: boolean;
  },
): MovCardex {
  return {
    id,
    tipo: 'SALIDA',
    cantidad,
    costo_unitario_usd: p.moneda === 'MXN' ? (p.costoUsd ?? 0) : p.costo,
    moneda: p.moneda,
    costo_unitario_mxn: p.moneda === 'MXN' ? p.costo : null,
    tc_usd_mxn: p.tc,
    venta_unitaria: p.venta ?? null,
    venta_moneda: p.venta != null ? (p.ventaMoneda ?? 'MXN') : null,
    fecha_movimiento: p.fecha,
    created_at: p.creado ?? `${p.fecha}T18:00:00Z`,
    para_flota: p.flota === true,
    aeronave_id: p.matricula ? `a-${p.matricula}` : null,
    aeronave: p.matricula ? { matricula: p.matricula } : null,
  };
}

// =====================================================================
// 1) El ejemplo del cliente, en DÓLARES
// =====================================================================

describe('ejemplo del cliente (USD): el remanente de agosto vale lo de septiembre', () => {
  const E1 = ent('E1', 10, 21, 'USD', 17, '2026-08-10');
  const S1 = sal('S1', 5, {
    costo: 21,
    moneda: 'USD',
    tc: 17.1,
    venta: 26.25,
    ventaMoneda: 'USD',
    fecha: '2026-08-15',
    matricula: 'XA-VGV',
  });
  const E2 = ent('E2', 5, 30, 'USD', 17.2, '2026-09-05');
  const movs = [E1, S1, E2];

  it('existencia 10; el valorizado usa 30 USD para TODO (300 USD = $5,301.87 MXN al T.C. de hoy)', () => {
    expect(existenciaDe(movs)).toBe(10);
    const st = statsDe(movs, { hoy: '2026-09-25', tcHoy: 17.6729 });
    expect(st.costo_vigente).toMatchObject({
      movimiento_id: 'E2',
      unitario: 30,
      moneda: 'USD',
      tc_compra: 17.2,
    });
    expect(st.valor_usd).toBe(300);
    expect(st.valor_mxn).toBe(5301.87);
    expect(st.costo_vigente_mxn).toBe(530.19);
    expect(st.valor_usd_sin_tc).toBe(0);
    expect(st.pesos_exactos).toBe(true);
  });

  it('la siguiente salida cuesta 30 (FIFO habría dicho 21) y se cobra a 37.5000 USD (+25 %)', () => {
    const vig = costoVigenteEn(movs, { fecha: '2026-09-25' })!;
    expect(vig.unitario).toBe(30);
    expect(vig.unitario).not.toBe(21);
    const precio = precioVentaDeSalida({
      costoUnitario: vig.unitario,
      monedaSalida: vig.moneda,
      margenPct: 25,
    });
    expect(precio).toEqual({
      ventaUnitaria: 37.5,
      ventaMoneda: 'USD',
      origen: 'MARGEN',
    });
    const S2 = sal('S2', 1, {
      costo: 30,
      moneda: 'USD',
      tc: 17.6729,
      venta: precio.ventaUnitaria,
      ventaMoneda: 'USD',
      fecha: '2026-09-25',
    });
    expect(montoGastoDeSalida(S2)).toMatchObject({
      monto: 37.5,
      moneda: 'USD',
    });
    const v = ventaDeSalida(S2);
    expect(v).toMatchObject({
      ventaTotalMxn: 662.73,
      costoMxn: 530.19,
      gananciaMxn: 132.54,
      gananciaUsdOriginal: 7.5,
      monedaUtilidad: 'MXN',
      tcVenta: 17.6729,
    });
    // Venta y costo redondeados por separado: 1 ¢ contra utilidad USD × T.C.
    expect(
      Math.abs((v.gananciaMxn as number) - round(7.5 * 17.6729, 2)),
    ).toBeLessThanOrEqual(0.01 + 1e-9);
  });

  it('la S1 conserva su costo de 21 USD y su utilidad NO cambia al entrar la compra de 30', () => {
    expect(costoVigenteEn(movs, { alRegistrar: S1 })?.unitario).toBe(21);
    expect(costoDeSalida(S1)).toMatchObject({
      moneda: 'USD',
      unitario: 21,
      total: 105,
      total_mxn: 1795.5,
    });
    const antes = ventaDeSalida(S1);
    expect(antes.ventaTotalMxn).toBe(2244.38);
    expect(antes.gananciaMxn).toBe(448.88);
    // Mismo resultado con o sin E2 en el cardex (el costo vive en la fila).
    expect(agregadosDeItem([E1, S1]).utilidad_mxn).toBe(448.88);
    expect(agregadosDeItem(movs).utilidad_mxn).toBe(448.88);
  });
});

// =====================================================================
// 2) El mismo ejemplo en PESOS
// =====================================================================

describe('ejemplo del cliente en PESOS (sin T.C. de por medio)', () => {
  const movs = [
    ent('E1', 10, 350, 'MXN', 17.5, '2026-08-10'),
    sal('S1', 5, {
      costo: 350,
      costoUsd: 20,
      moneda: 'MXN',
      tc: null,
      venta: 437.5,
      ventaMoneda: 'MXN',
      fecha: '2026-08-15',
    }),
    ent('E2', 5, 500, 'MXN', 17.5, '2026-09-05'),
  ];

  it('valorizado 10 × 500 = $5,000.00 MXN aunque no haya T.C. de hoy; la siguiente salida a 625.0000 MXN', () => {
    const st = statsDe(movs, { hoy: '2026-09-25', tcHoy: null });
    expect(st).toMatchObject({
      stock: 10,
      valor_mxn: 5000,
      valor_usd_sin_tc: 0,
      pesos_exactos: true,
      costo_vigente_mxn: 500,
      costo_fifo_mxn_actual: 500,
    });
    expect(st.costo_vigente).toMatchObject({ moneda: 'MXN', unitario: 500 });
    expect(
      precioVentaDeSalida({
        costoUnitario: st.costo_vigente!.unitario,
        monedaSalida: st.costo_vigente!.moneda,
        margenPct: 25,
      }),
    ).toEqual({ ventaUnitaria: 625, ventaMoneda: 'MXN', origen: 'MARGEN' });
  });

  it('venta en pesos sobre costo en pesos: utilidad sin T.C. (5 × 87.50 = $437.50)', () => {
    const v = ventaDeSalida(movs[1]);
    expect(v).toMatchObject({
      gananciaMxn: 437.5,
      costoMxn: 1750,
      ventaTotalMxn: 2187.5,
      monedaUtilidad: 'MXN',
      ventaTotalUsdOriginal: null,
      sinTc: false,
    });
  });
});

// =====================================================================
// 3) Qué FIJA precio, desempates y fechas futuras
// =====================================================================

describe('costoVigenteEn: qué fija el precio', () => {
  it('ENTRADA a $0, DEVOLUCION y AJUSTE no fijan precio', () => {
    const e = ent('e', 5, 21.25, 'USD', 17, '2026-08-29');
    const cero = ent('cero', 3, 0, 'USD', null, '2026-09-02');
    const dev: MovCardex = {
      ...ent('dev', 1, 99, 'USD', 17, '2026-09-03'),
      tipo: 'DEVOLUCION',
    };
    const aj: MovCardex = {
      ...ent('aj', 1, 77, 'USD', 17, '2026-09-04'),
      tipo: 'AJUSTE',
    };
    expect([e, cero, dev, aj].map(fijaPrecio)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(
      costoVigenteEn([e, cero, dev, aj], { fecha: '2026-09-30' })
        ?.movimiento_id,
    ).toBe('e');
    // La existencia SÍ cuenta la devolución, el ajuste y la entrada a $0.
    expect(existenciaDe([e, cero, dev, aj])).toBe(10);
  });

  it('mismo día: manda created_at y, a igualdad, el id; lo que llega revuelto se ordena igual', () => {
    const a = ent('a', 1, 10, 'USD', 17, '2026-09-01', '2026-09-01T10:00:00Z');
    const b = ent('b', 1, 20, 'USD', 17, '2026-09-01', '2026-09-01T11:00:00Z');
    const c = ent('c', 1, 30, 'USD', 17, '2026-09-01', '2026-09-01T11:00:00Z');
    expect(costoVigenteEn([c, a, b], { fecha: '2026-09-01' })?.unitario).toBe(
      30,
    );
    expect(sortChrono([c, b, a]).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('una compra con fecha FUTURA no es vigente hoy', () => {
    const hoy = ent('hoy', 1, 10, 'USD', 17, '2026-09-20');
    const futura = ent('fut', 1, 99, 'USD', 17, '2026-10-01');
    expect(
      costoVigenteEn([hoy, futura], { fecha: '2026-09-25' })?.unitario,
    ).toBe(10);
    expect(
      statsDe([hoy, futura], { hoy: '2026-09-25', tcHoy: 18 }).valor_usd,
    ).toBe(20);
  });

  it('salida ANTES de la primera compra con costo ⇒ null (el servicio responde 400)', () => {
    const compra = ent('e', 5, 10, 'USD', 17, '2026-09-10');
    expect(costoVigenteEn([compra], { fecha: '2026-09-05' })).toBeNull();
    expect(textoSalidaAntesDeLaCompra('2026-09-05', '2026-09-10')).toBe(
      'La salida es del 5 sep 2026 y la primera compra con costo de este producto es del 10 sep 2026: corrige la fecha de la salida o captura antes la compra.',
    );
  });

  it('corte «al registrar»: una compra capturada DESPUÉS con fecha atrasada no afecta a la salida', () => {
    const vieja = ent('v', 5, 10, 'USD', 17, '2026-08-01');
    const s = sal('s', 1, {
      costo: 10,
      moneda: 'USD',
      tc: 17,
      fecha: '2026-09-01',
      creado: '2026-09-01T12:00:00Z',
    });
    // Compra recibida tarde (folio 1/3/4): fecha 20-ago, capturada el 25-sep.
    const tarde = ent(
      't',
      5,
      50,
      'USD',
      17,
      '2026-08-20',
      '2026-09-25T12:00:00Z',
    );
    expect(
      costoVigenteEn([vieja, s, tarde], { alRegistrar: s })?.unitario,
    ).toBe(10);
    // Hoy el precio vigente SÍ es el de la compra tarde (fecha posterior a la vieja).
    expect(
      costoVigenteEn([vieja, s, tarde], { fecha: '2026-09-25' })?.unitario,
    ).toBe(50);
  });
});

// =====================================================================
// 5) Costo leído de la FILA — las 13 salidas reales de prod
// =====================================================================

describe('las 13 salidas reales: costo de la fila = costo con la regla nueva', () => {
  const cardex = cardexProd25sep();

  it('las 3 salidas del aceite en pesos: 6,633.32 / 3,316.66 / 39,799.92 MXN', () => {
    const aceite = cardex.get(ITEM_ACEITE)!;
    const porId = (id: string) => aceite.find((m) => m.id === id)!;
    expect(
      costoDeSalida(porId('d45dae06-7478-4f33-a412-00ae6a57e588')),
    ).toMatchObject({
      moneda: 'MXN',
      total: 6633.32,
      total_mxn: 6633.32,
    });
    expect(
      costoDeSalida(porId('a9378a18-54e1-4259-b65a-35de6dd533c0')).total,
    ).toBe(3316.66);
    expect(
      costoDeSalida(porId('533fce35-6088-432b-b41f-a242aa471b42')).total,
    ).toBe(39799.92);
  });

  it('para las 13, costoDeSalida(fila) == costoVigenteEn({ alRegistrar }) (mismo unitario y moneda)', () => {
    let vistas = 0;
    for (const movs of cardex.values()) {
      for (const s of movs) {
        if (s.tipo !== 'SALIDA') continue;
        vistas += 1;
        const vig = costoVigenteEn(movs, { alRegistrar: s })!;
        const fila = costoDeSalida(s);
        expect({
          id: s.id,
          moneda: vig.moneda,
          unitario: vig.unitario,
        }).toEqual({ id: s.id, moneda: fila.moneda, unitario: fila.unitario });
        // Y el monto del gasto de las 3 salidas a costo es ese costo.
        if (s.venta_unitaria == null) {
          expect(montoGastoDeSalida(s).monto).toBe(fila.total);
        }
      }
    }
    expect(vistas).toBe(13);
  });

  it('y las 13 cuestan LO MISMO con el FIFO recalculado hoy (ninguna cambia de costo con la regla nueva)', () => {
    // FIFO de referencia (solo para esta verificación): capas por orden
    // cronológico, cada salida consume de la más vieja.
    const fifo = (movs: MovCardex[]) => {
      const capas: Array<{ qty: number; usd: number; mxn: number | null }> = [];
      const out = new Map<string, { usd: number; mxn: number | null }>();
      for (const m of sortChrono(movs)) {
        const cant = Number(m.cantidad);
        if (m.tipo !== 'SALIDA') {
          capas.push({
            qty: cant,
            usd: Number(m.costo_unitario_usd),
            mxn: m.moneda === 'MXN' ? Number(m.costo_unitario_mxn) : null,
          });
          continue;
        }
        let need = cant;
        let usd = 0;
        let mxn: number | null = 0;
        while (need > 1e-9 && capas.length > 0) {
          const c = capas[0];
          const t = Math.min(need, c.qty);
          usd += t * c.usd;
          mxn = mxn != null && c.mxn != null ? mxn + t * c.mxn : null;
          c.qty -= t;
          need -= t;
          if (c.qty <= 1e-9) capas.shift();
        }
        out.set(m.id as string, {
          usd: round(usd, 2),
          mxn: mxn != null ? round(mxn, 2) : null,
        });
      }
      return out;
    };
    let comparadas = 0;
    for (const movs of cardex.values()) {
      const f = fifo(movs);
      for (const s of movs) {
        if (s.tipo !== 'SALIDA') continue;
        const c = costoDeSalida(s);
        const ref = f.get(s.id as string)!;
        expect({ id: s.id, usd: c.total_usd }).toEqual({
          id: s.id,
          usd: ref.usd,
        });
        if (c.moneda === 'MXN') expect(c.total).toBe(ref.mxn);
        comparadas += 1;
      }
    }
    expect(comparadas).toBe(13);
  });
});

// =====================================================================
// 6) T.C.: conversión del TOTAL nativo
// =====================================================================

describe('T.C. del día: compras al de la compra, ventas al de la venta', () => {
  it('aMxn / aUsd: total nativo × T.C.; sin T.C. ⇒ null (salvo $0)', () => {
    expect(aMxn(2550, 'USD', 17.0115)).toBe(43379.33);
    expect(aMxn(2550, 'USD', null)).toBeNull();
    expect(aMxn(0, 'USD', null)).toBe(0);
    expect(aMxn(49749.9, 'MXN', null)).toBe(49749.9);
    expect(aUsd(1751, 'MXN', 17.51)).toBe(100);
    expect(aUsd(1751, 'MXN', null)).toBeNull();
    expect(aUsd(21.25, 'USD', null)).toBe(21.25);
  });

  it('compra USD con T.C.: 120 × 21.25 × 17.0115 = $43,379.33; sin T.C. ⇒ null y se cuenta', () => {
    const con = ent('e', 120, 21.25, 'USD', 17.0115, '2026-08-29');
    expect(montosDeCompra(con)).toMatchObject({
      moneda: 'USD',
      total: 2550,
      total_mxn: 43379.33,
      precio_unitario_mxn: 361.49,
      sin_tc: false,
    });
    const sin = ent('e', 120, 21.25, 'USD', null, '2026-08-29');
    expect(montosDeCompra(sin)).toMatchObject({
      total_mxn: null,
      sin_tc: true,
    });
    const a = agregadosDeItem([sin]);
    expect(a.movimientos_sin_tc).toBe(1);
    expect(a.con_movimientos_sin_tc).toBe(true);
    expect(agregadosDeItem([con]).movimientos_sin_tc).toBe(0);
  });

  it('venta en PESOS sobre costo USD CON T.C. ⇒ utilidad en pesos; el USD original solo si las dos partes son dólares', () => {
    const s = sal('s', 2, {
      costo: 21.25,
      moneda: 'USD',
      tc: 17.0077,
      venta: 500,
      ventaMoneda: 'MXN',
      fecha: '2026-09-01',
    });
    const v = ventaDeSalida(s);
    expect(v).toMatchObject({
      ventaTotalMxn: 1000,
      costoMxn: 722.83, // round2(42.50 × 17.0077)
      gananciaMxn: 277.17,
      monedaUtilidad: 'MXN',
      ventaTotalUsdOriginal: null,
      gananciaUsdOriginal: null,
      utilidadIncompleta: false,
    });
  });

  it('venta USD sobre costo en PESOS: pesos con el T.C. de la venta; sin USD original', () => {
    const s = sal('s', 1, {
      costo: 1658.33,
      costoUsd: 94.71,
      moneda: 'MXN',
      tc: 17.0077,
      venta: 120,
      ventaMoneda: 'USD',
      fecha: '2026-09-01',
    });
    expect(ventaDeSalida(s)).toMatchObject({
      ventaTotalMxn: 2040.92,
      costoMxn: 1658.33,
      gananciaMxn: 382.59,
      gananciaUsdOriginal: null,
    });
  });
});

// =====================================================================
// 7) Respaldo sin T.C. (filas pre-migración) y la migración aplicada
// =====================================================================

describe('las 10 salidas de la tienda: antes y después de la migración de T.C.', () => {
  const suma = (tc: boolean) => {
    let mxn: number | null = null;
    let usd: number | null = null;
    let usdOrig: number | null = null;
    let ventas = 0;
    let costo = 0;
    for (const movs of cardexProd25sep({ tcOficial: tc }).values()) {
      const a = agregadosDeItem(movs);
      if (a.utilidad_mxn != null) mxn = round((mxn ?? 0) + a.utilidad_mxn, 2);
      if (a.utilidad_usd != null) usd = round((usd ?? 0) + a.utilidad_usd, 2);
      if (a.utilidad_usd_original != null)
        usdOrig = round((usdOrig ?? 0) + a.utilidad_usd_original, 2);
      ventas = round(ventas + (a.ventas_mxn ?? 0), 2);
      costo = round(costo + (a.costo_ventas_mxn ?? 0), 2);
    }
    return { mxn, usd, usdOrig, ventas, costo };
  };

  it('SIN T.C. (hoy): utilidad 535.35 USD y nada en pesos — idéntico a 0.0.35', () => {
    expect(suma(false)).toEqual({
      mxn: null,
      usd: 535.35,
      usdOrig: null,
      ventas: 0,
      costo: 0,
    });
  });

  it('CON el T.C. oficial (17.0077): $9,105.07 MXN, nada en el respaldo y 535.35 USD como dato secundario', () => {
    expect(suma(true)).toEqual({
      mxn: 9105.07,
      usd: null,
      usdOrig: 535.35,
      ventas: 45524.17,
      costo: 36419.1,
    });
  });

  it('por avión: N4142R +5,025.09 · XA-VGV +4,079.98 MXN', () => {
    const porAvion = new Map<string, number>();
    for (const m of todosLosMovimientos({ tcOficial: true })) {
      if (m.tipo !== 'SALIDA') continue;
      const g = ventaDeSalida(m).gananciaMxn;
      if (g == null) continue;
      const mat = (m.aeronave as { matricula: string }).matricula;
      porAvion.set(mat, round((porAvion.get(mat) ?? 0) + g, 2));
    }
    expect(Object.fromEntries(porAvion)).toEqual({
      'XA-VGV': 4079.98,
      N4142R: 5025.09,
    });
  });

  it('las compras del 29-ago y del 01-sep en pesos: $1,351,908.88 y $18,196.87', () => {
    const porFecha = new Map<string, number>();
    for (const m of todosLosMovimientos({ tcOficial: true })) {
      if (m.tipo !== 'ENTRADA' || m.moneda !== 'USD') continue;
      const t = montosDeCompra(m).total_mxn as number;
      porFecha.set(
        m.fecha_movimiento,
        round((porFecha.get(m.fecha_movimiento) ?? 0) + t, 2),
      );
    }
    expect(Object.fromEntries(porFecha)).toEqual({
      '2026-08-29': 1351908.88,
      '2026-09-01': 18196.87,
    });
  });

  it('valorizado de la bodega: 78,398.88 USD con FIFO y con último precio → $1,385,535.56 MXN al T.C. de hoy (17.6729)', () => {
    let usd = 0;
    let mxn = 0;
    let sinTcHoy = 0;
    for (const movs of cardexProd25sep({ tcOficial: true }).values()) {
      const st = statsDe(movs, { hoy: '2026-09-25', tcHoy: 17.6729 });
      usd = round(usd + st.valor_usd, 2);
      mxn = round(mxn + st.valor_mxn, 2);
      const sinTc = statsDe(movs, { hoy: '2026-09-25', tcHoy: null });
      sinTcHoy = round(sinTcHoy + sinTc.valor_usd_sin_tc, 2);
    }
    expect(usd).toBe(78398.88);
    expect(mxn).toBe(1385535.56);
    // Sin T.C. de hoy, lo comprado en dólares va aparte (jamás como pesos).
    expect(sinTcHoy).toBe(78398.88);
  });
});

// =====================================================================
// 8) Agregados, resumen por día y bloques
// =====================================================================

/**
 * Cardex sintético («Aceite»), tal como lo GUARDA el API 0.0.36:
 *  01-ago e1 ENTRADA 10 @ $100 MXN (T.C. 18.18)
 *  01-ago e2 ENTRADA  5 @ 6 USD (T.C. 18) — último precio desde aquí
 *  03-ago s1 SALIDA   8 a N1, vendida a $150 MXN — costo 6 USD, T.C. venta 18.5
 *  03-ago s2 SALIDA   4 SIN precio (a costo)    — costo 6 USD, T.C. 18.5
 *  05-ago d1 DEVOLUCION 1 @ $100 MXN desde N1
 *  06-ago s3 SALIDA   2 a la FLOTA a 10 USD      — costo 6 USD, T.C. 18
 *  10-ago e3 ENTRADA  3 @ $0 (carga sin costo)
 */
const CARDEX: MovCardex[] = [
  ent('e1', 10, 100, 'MXN', 18.18, '2026-08-01', '2026-08-01T15:00:00Z', {
    proveedor: { nombre: 'Proveedor Uno' },
    referencia: 'F-1',
  }),
  ent('e2', 5, 6, 'USD', 18, '2026-08-01', '2026-08-01T16:00:00Z'),
  sal('s1', 8, {
    costo: 6,
    moneda: 'USD',
    tc: 18.5,
    venta: 150,
    ventaMoneda: 'MXN',
    fecha: '2026-08-03',
    creado: '2026-08-03T15:00:00Z',
    matricula: 'N1',
  }),
  sal('s2', 4, {
    costo: 6,
    moneda: 'USD',
    tc: 18.5,
    fecha: '2026-08-03',
    creado: '2026-08-03T16:00:00Z',
  }),
  {
    ...ent('d1', 1, 100, 'MXN', 18.18, '2026-08-05'),
    tipo: 'DEVOLUCION',
    aeronave: { matricula: 'N1' },
  },
  sal('s3', 2, {
    costo: 6,
    moneda: 'USD',
    tc: 18,
    venta: 10,
    ventaMoneda: 'USD',
    fecha: '2026-08-06',
    flota: true,
  }),
  ent('e3', 3, 0, 'MXN', null, '2026-08-10'),
];
const REVUELTO = [
  CARDEX[4],
  CARDEX[2],
  CARDEX[6],
  CARDEX[0],
  CARDEX[5],
  CARDEX[3],
  CARDEX[1],
];

describe('agregadosDeItem (mismo número que la lista y la hoja Inventario del balance)', () => {
  it('acumulado histórico, en pesos al T.C. de cada movimiento', () => {
    const a = agregadosDeItem(REVUELTO);
    expect(a).toMatchObject({
      compradas_cant: 18,
      compradas_costo_mxn: 1540, // 1,000 + round2(30 × 18) + 0
      salidas_cant: 14,
      ventas_cant: 10,
      ventas_mxn: 1560, // 1,200 + round2(20 × 18)
      costo_ventas_mxn: 1104, // round2(48 × 18.5) + round2(12 × 18)
      utilidad_mxn: 456,
      ventas_usd: null,
      utilidad_usd: null,
      ventas_usd_original: 20, // solo s3 (dólares sobre dólares)
      costo_ventas_usd_original: 12,
      utilidad_usd_original: 8,
      ventas_a_costo_mxn: 444, // round2(24 × 18.5)
      salidas_a_costo_cant: 4,
      ventas_sin_utilidad: 0,
      matriculas: ['N1', '—', 'FLOTA'],
      con_entradas_sin_costo: true,
      con_movimientos_sin_tc: false,
      movimientos_sin_tc: 0,
    });
  });

  it('con periodo: solo suma lo del corte (las banderas miran todo el cardex)', () => {
    const a = agregadosDeItem(
      CARDEX,
      filtroPeriodo('2026-08-05', '2026-08-31'),
    );
    expect(a).toMatchObject({
      compradas_cant: 3,
      compradas_costo_mxn: 0,
      salidas_cant: 2,
      ventas_mxn: 360,
      utilidad_mxn: 144,
      ventas_a_costo_mxn: null,
      con_entradas_sin_costo: true,
    });
  });

  it('un cardex vacío no tiene actividad (null, nunca un 0 falso)', () => {
    expect(agregadosDeItem([])).toMatchObject({
      compradas_cant: null,
      compradas_costo_mxn: null,
      salidas_cant: null,
      ventas_mxn: null,
      utilidad_mxn: null,
      ventas_usd_original: null,
      ventas_a_costo_mxn: null,
      movimientos_sin_tc: 0,
    });
  });

  it('venta en PESOS sobre costo USD SIN T.C. ⇒ lo vendido sí suma, la utilidad no (incompleta)', () => {
    const cardex = [
      ent('e', 5, 21.25, 'USD', null, '2026-08-29'),
      sal('s', 1, {
        costo: 21.25,
        moneda: 'USD',
        tc: null,
        venta: 500,
        ventaMoneda: 'MXN',
        fecha: '2026-09-01',
      }),
    ];
    expect(agregadosDeItem(cardex)).toMatchObject({
      ventas_mxn: 500,
      costo_ventas_mxn: null,
      utilidad_mxn: null,
      ventas_sin_utilidad: 1,
      movimientos_sin_tc: 2,
    });
  });
});

describe('resumenDiarioDe (bloque RESUMEN)', () => {
  it('una fila por día: existencia al cierre y utilidad del día', () => {
    const dias = resumenDiarioDe(REVUELTO);
    expect(
      dias.map((d) => [
        d.fecha,
        d.entradas_cant,
        d.salidas_cant,
        d.existencia_cierre,
      ]),
    ).toEqual([
      ['2026-08-01', 15, 0, 15],
      ['2026-08-03', 0, 12, 3],
      ['2026-08-05', 1, 0, 4],
      ['2026-08-06', 0, 2, 2],
      ['2026-08-10', 3, 0, 5],
    ]);
    expect(dias[1]).toMatchObject({
      ventas_mxn: 1200,
      costo_ventas_mxn: 888,
      utilidad_mxn: 312,
      utilidad_usd_original: null,
    });
    expect(dias[3]).toMatchObject({
      ventas_mxn: 360,
      utilidad_mxn: 144,
      utilidad_usd_original: 8,
    });
    // Σ utilidad por día = utilidad del ítem.
    const suma = dias.reduce((s, d) => s + (d.utilidad_mxn ?? 0), 0);
    expect(round(suma, 2)).toBe(agregadosDeItem(CARDEX).utilidad_mxn);
  });

  it('con periodo: solo esos días, pero la existencia arrastra el historial', () => {
    const dias = resumenDiarioDe(CARDEX, filtroPeriodo('2026-08-05', null));
    expect(dias.map((d) => [d.fecha, d.existencia_cierre])).toEqual([
      ['2026-08-05', 4],
      ['2026-08-06', 2],
      ['2026-08-10', 5],
    ]);
  });
});

describe('bloquesCardexDe (COMPRAS | VENTAS — la ficha y el Excel formato libro)', () => {
  const b = bloquesCardexDe('Aceite', REVUELTO, undefined, {
    hoy: '2026-08-31',
  });

  it('COMPRAS: precio nativo con su T.C., total en pesos y el precio vigente marcado', () => {
    expect(b.compras.map((c) => c.movimiento_id)).toEqual([
      'e1',
      'e2',
      'd1',
      'e3',
    ]);
    expect(b.compras[0]).toMatchObject({
      tipo: 'ENTRADA',
      precio_unitario: 100,
      moneda: 'MXN',
      total: 1000,
      total_mxn: 1000,
      precio_unitario_mxn: 100,
      fija_precio: true,
      es_precio_vigente: false,
      descripcion: 'Aceite · Proveedor Uno · ref F-1',
      stock_despues: 10,
    });
    expect(b.compras[1]).toMatchObject({
      precio_unitario: 6,
      moneda: 'USD',
      tc_usd_mxn: 18,
      total: 30,
      total_usd: 30,
      total_mxn: 540,
      precio_unitario_mxn: 108,
      fija_precio: true,
      es_precio_vigente: true,
      sin_tc: false,
    });
    expect(b.compras[2]).toMatchObject({
      tipo: 'DEVOLUCION',
      fija_precio: false,
      es_precio_vigente: false,
      descripcion: 'DEVOLUCIÓN — Aceite · N1',
    });
    expect(b.compras[3]).toMatchObject({ sin_costo: true, fija_precio: false });
  });

  it('VENTAS: precio de venta, costo de la fila, utilidad y la salida a costo (ganancia 0)', () => {
    const porId = new Map(b.ventas.map((v) => [v.movimiento_id, v]));
    expect(porId.get('s1')).toMatchObject({
      a_costo: false,
      precio_unitario: 150,
      moneda: 'MXN',
      total: 1200,
      total_mxn: 1200,
      precio_unitario_mxn: 150,
      tc_venta: 18.5,
      costo_unitario: 6,
      costo_moneda: 'USD',
      costo_total: 48,
      costo_mxn: 888,
      costo_fifo_mxn: 888, // alias (un release)
      ganancia_mxn: 312,
      ganancia_usd_original: null,
      vendido_a: 'N1',
      remanente: 7,
    });
    expect(porId.get('s2')).toMatchObject({
      a_costo: true,
      precio_unitario: 6,
      moneda: 'USD',
      total: 24,
      total_mxn: 444,
      ganancia_mxn: 0,
      venta_total: null,
      descripcion: 'Aceite · a costo (último precio)',
      vendido_a: '—',
    });
    expect(porId.get('s3')).toMatchObject({
      vendido_a: 'FLOTA',
      para_flota: true,
      venta_total: 20,
      total_mxn: 360,
      ganancia_mxn: 144,
      venta_total_usd_original: 20,
      costo_usd_original: 12,
      ganancia_usd_original: 8,
    });
  });

  it('totales = los de agregadosDeItem (mismo número del listado y del balance)', () => {
    const a = agregadosDeItem(CARDEX);
    expect(b.totales).toMatchObject({
      compras_cant: a.compradas_cant,
      compras_mxn: 1540,
      ventas_cant: 14,
      ventas_mxn: 1560,
      ventas_a_costo_mxn: 444,
      costo_ventas_mxn: 1104,
      utilidad_mxn: 456,
      unidades_vendidas: 10,
      salidas_a_costo_cant: 4,
      utilidad_usd_original: 8,
      movimientos_sin_tc: 0,
    });
    // Σ de las filas.
    expect(
      round(
        b.ventas
          .filter((v) => !v.a_costo)
          .reduce((s, v) => s + (v.total_mxn ?? 0), 0),
        2,
      ),
    ).toBe(b.totales.ventas_mxn);
    expect(
      round(
        b.compras
          .filter((c) => c.tipo === 'ENTRADA')
          .reduce((s, c) => s + (c.total_mxn ?? 0), 0),
        2,
      ),
    ).toBe(b.totales.compras_mxn);
  });

  it('con periodo solo lista las filas del corte', () => {
    const p = bloquesCardexDe(
      'Aceite',
      CARDEX,
      filtroPeriodo('2026-08-06', null),
    );
    expect(p.compras.map((c) => c.movimiento_id)).toEqual(['e3']);
    expect(p.ventas.map((v) => v.movimiento_id)).toEqual(['s3']);
  });

  it('el aceite 15W-50 real (con el T.C. oficial): «Dinero generado» 16,263.61 / 13,010.89 / 3,252.72; a costo 49,749.90 (30 u.)', () => {
    const aceite = cardexProd25sep({ tcOficial: true }).get(ITEM_ACEITE)!;
    const r = bloquesCardexDe('Aceite 15W-50', aceite, undefined, {
      hoy: '2026-09-25',
    });
    expect(r.totales).toMatchObject({
      compras_cant: 150,
      compras_mxn: 93129.23, // 49,749.90 + 43,379.33
      ventas_mxn: 16263.61,
      costo_ventas_mxn: 13010.89,
      utilidad_mxn: 3252.72,
      ventas_usd_original: 956.25,
      utilidad_usd_original: 191.25,
      unidades_vendidas: 36,
      ventas_a_costo_mxn: 49749.9,
      salidas_a_costo_cant: 30,
      utilidad_usd: null,
      movimientos_sin_tc: 0,
    });
    expect(existenciaDe(aceite)).toBe(84);
    // El precio vigente es la compra del 29-ago.
    expect(r.compras.find((c) => c.es_precio_vigente)?.movimiento_id).toBe(
      'a614e7af-6b74-4f97-8a34-1277c97ffcf0',
    );
  });
});

describe('walkCardex / statsDe (bordes)', () => {
  it('walkCardex: stock corriente y el costo de cada salida (el de la fila)', () => {
    const w = walkCardex(REVUELTO);
    expect(w.get('s1')).toEqual({
      stockDespues: 7,
      costoMxn: 888,
      costoUsd: 48,
      sinTc: false,
    });
    expect(w.get('e2')).toMatchObject({ stockDespues: 15, costoMxn: null });
  });

  it('sin compra con costo o sin existencia ⇒ valor 0; vigente USD sin T.C. de hoy ⇒ en dólares aparte', () => {
    expect(
      statsDe([ent('c', 3, 0, 'USD', null, '2026-08-01')], {
        hoy: '2026-09-25',
        tcHoy: 17,
      }),
    ).toMatchObject({
      stock: 3,
      costo_vigente: null,
      valor_usd: 0,
      valor_mxn: 0,
    });
    const agotado = [
      ent('e', 2, 10, 'USD', 17, '2026-08-01'),
      sal('s', 2, {
        costo: 10,
        moneda: 'USD',
        tc: 17,
        fecha: '2026-08-02',
        matricula: 'N1',
      }),
    ];
    expect(statsDe(agotado, { hoy: '2026-09-25', tcHoy: 17 })).toMatchObject({
      stock: 0,
      valor_usd: 0,
      valor_mxn: 0,
    });
    const usd = [ent('e', 30, 110, 'USD', null, '2026-08-29')];
    expect(statsDe(usd, { hoy: '2026-09-25', tcHoy: null })).toMatchObject({
      valor_usd: 3300,
      valor_mxn: 0,
      valor_usd_sin_tc: 3300,
      pesos_exactos: false,
      costo_vigente_mxn: null,
      // JAMÁS el USD en un campo «mxn».
      costo_fifo_mxn_actual: 0,
      costo_fifo_actual: 110,
    });
  });
});

// =====================================================================
// 9) salidasQueDependenDe
// =====================================================================

describe('salidasQueDependenDe (quién se cobró con el precio de una compra)', () => {
  it('(a) solo las salidas entre la entrada y la siguiente compra con costo', () => {
    const movs = [
      ent('e1', 10, 21, 'USD', 17, '2026-08-01'),
      sal('s1', 2, {
        costo: 21,
        moneda: 'USD',
        tc: 17,
        venta: 26.25,
        ventaMoneda: 'USD',
        fecha: '2026-08-05',
        matricula: 'N1',
      }),
      ent('e2', 5, 30, 'USD', 17, '2026-09-01'),
      sal('s2', 1, {
        costo: 30,
        moneda: 'USD',
        tc: 17,
        venta: 37.5,
        ventaMoneda: 'USD',
        fecha: '2026-09-05',
        matricula: 'XA-VGV',
      }),
    ];
    expect(salidasQueDependenDe(movs, 'e1')).toEqual([
      {
        id: 's1',
        fecha: '2026-08-05',
        cantidad: 2,
        costo_unitario: 21,
        moneda: 'USD',
        sin_cargo: false,
        vendido_a: 'N1',
      },
    ]);
    expect(salidasQueDependenDe(movs, 'e2').map((s) => s.id)).toEqual(['s2']);
    // Una salida o un id ajeno no tienen dependientes.
    expect(salidasQueDependenDe(movs, 's1')).toEqual([]);
    expect(salidasQueDependenDe(movs, 'x')).toEqual([]);
  });

  it('(b) ENTRADA con fecha atrasada capturada DESPUÉS de la salida ⇒ la salida NO depende de ella', () => {
    const movs = [
      ent('vieja', 10, 21, 'USD', 17, '2026-08-01'),
      sal('s', 1, {
        costo: 21,
        moneda: 'USD',
        tc: 17,
        fecha: '2026-09-01',
        creado: '2026-09-01T12:00:00Z',
        matricula: 'N1',
      }),
      ent('tarde', 5, 36.85, 'USD', 17, '2026-08-05', '2026-09-25T12:00:00Z'),
    ];
    expect(salidasQueDependenDe(movs, 'tarde')).toEqual([]);
    expect(salidasQueDependenDe(movs, 'vieja').map((s) => s.id)).toEqual(['s']);
  });

  it('(c) ENTRADA a $0 con una salida posterior sin otra compra ⇒ aparece con sin_cargo', () => {
    const movs = [
      ent('cero', 5, 0, 'USD', null, '2026-08-29'),
      sal('s', 1, {
        costo: 0,
        moneda: 'USD',
        tc: 17,
        fecha: '2026-09-01',
        matricula: 'N1',
      }),
    ];
    expect(salidasQueDependenDe(movs, 'cero')).toEqual([
      expect.objectContaining({ id: 's', sin_cargo: true, costo_unitario: 0 }),
    ]);
  });

  it('(d) dos entradas el mismo día al mismo precio (CH48110 real, 1 + 3 @ 46.06) ⇒ la salida depende de la ÚLTIMA registrada antes que ella', () => {
    const ch48110 = cardexProd25sep().get('cfc395c2')!;
    expect(
      salidasQueDependenDe(ch48110, '7e00d444-0e8a-4be0-999d-2c2755a858c3').map(
        (s) => s.id,
      ),
    ).toEqual(['63c2a335-98e3-45f6-a665-6ba8b9d07807']);
    expect(
      salidasQueDependenDe(ch48110, '8d366e4a-ce3c-45f6-aa2b-97e6b58e180f'),
    ).toEqual([]);
  });

  it('texto del 409 ENTRADA_CON_SALIDAS', () => {
    expect(textoEntradaConSalidas(2, 1)).toBe(
      'Este precio ya se usó en 2 salida(s) (conservan su costo; 1 sin cargo). Confirma para guardar el precio nuevo: aplica a la existencia y a las siguientes salidas.',
    );
  });
});

// =====================================================================
// 10) Lo que se RETIRÓ del util
// =====================================================================

describe('el FIFO ya no existe en el util', () => {
  it('no exporta buildLayers / statsFromLayers / ventaYGananciaDe', () => {
    const exportados = Object.keys(util);
    for (const viejo of [
      'buildLayers',
      'statsFromLayers',
      'ventaYGananciaDe',
    ]) {
      expect(exportados).not.toContain(viejo);
    }
    expect(REGLA_COSTO).toBe('ULTIMO_PRECIO');
  });
});

// =====================================================================
// Lo que NO cambió: margen, precio, monto del gasto, periodo, textos
// =====================================================================

describe('costoUnitarioMxnDe (dato por fila)', () => {
  it('MXN tal cual, USD × TC, USD sin TC tal cual con pesosExactos false', () => {
    expect(costoUnitarioMxnDe(CARDEX[0])).toEqual({
      mxn: 100,
      pesosExactos: true,
      enMxn: true,
    });
    expect(costoUnitarioMxnDe(CARDEX[1])).toEqual({
      mxn: 108,
      pesosExactos: true,
      enMxn: false,
    });
    expect(
      costoUnitarioMxnDe({
        costo_unitario_usd: 21.25,
        moneda: 'USD',
        tc_usd_mxn: null,
      }),
    ).toEqual({ mxn: 21.25, pesosExactos: false, enMxn: false });
  });
});

describe('filtroPeriodo', () => {
  const m = (fecha: string): MovCardex => ({
    tipo: 'ENTRADA',
    cantidad: 1,
    costo_unitario_usd: 1,
    fecha_movimiento: fecha,
    created_at: `${fecha}T12:00:00Z`,
  });
  it('sin cotas acepta todo; con cotas es inclusivo por día (string YYYY-MM-DD)', () => {
    expect(filtroPeriodo()(m('2026-01-01'))).toBe(true);
    const f = filtroPeriodo('2026-08-01', '2026-08-31');
    expect(f(m('2026-07-31'))).toBe(false);
    expect(f(m('2026-08-01'))).toBe(true);
    expect(f(m('2026-08-31'))).toBe(true);
    expect(f(m('2026-09-01'))).toBe(false);
    expect(filtroPeriodo('2026-08-15', null)(m('2026-12-31'))).toBe(true);
    expect(filtroPeriodo(null, '2026-08-15')(m('2026-08-16'))).toBe(false);
  });
});

describe('margenVentaValido / ventaUnitariaConMargen', () => {
  it('solo acepta un número finito de 0 a 100; lo demás ⇒ 25', () => {
    expect(MARGEN_VENTA_PCT_DEFAULT).toBe(25);
    expect(margenVentaValido(25)).toBe(25);
    expect(margenVentaValido(12.5)).toBe(12.5);
    expect(margenVentaValido(0)).toBe(0);
    expect(margenVentaValido(100)).toBe(100);
    for (const malo of [-1, 101, NaN, Infinity, '25', null, undefined, {}]) {
      expect(margenVentaValido(malo)).toBe(25);
    }
  });

  it('costo × (1 + pct/100) a 4 decimales; costo o margen ≤ 0 ⇒ 0 (sin venta)', () => {
    expect(ventaUnitariaConMargen(21.25, 25)).toBe(26.5625);
    expect(ventaUnitariaConMargen(46.06, 25)).toBe(57.575);
    expect(ventaUnitariaConMargen(155.94, 25)).toBe(194.925);
    expect(ventaUnitariaConMargen(1658.33, 25)).toBe(2072.9125);
    expect(ventaUnitariaConMargen(30, 25)).toBe(37.5);
    expect(ventaUnitariaConMargen(100, 12.5)).toBe(112.5);
    expect(ventaUnitariaConMargen(0, 25)).toBe(0);
    expect(ventaUnitariaConMargen(-5, 25)).toBe(0);
    expect(ventaUnitariaConMargen(21.25, 0)).toBe(0);
  });
});

describe('precioVentaDeSalida — precedencia de siempre + el margen al final', () => {
  const base = {
    costoUnitario: 21.25,
    monedaSalida: 'USD' as const,
    margenPct: 25,
  };
  it.each([
    [
      'DTO > 0 gana, con SU moneda',
      {
        dtoVenta: 30,
        dtoMoneda: 'MXN' as const,
        itemPrecio: 99,
        itemMoneda: 'USD' as const,
      },
      { ventaUnitaria: 30, ventaMoneda: 'MXN', origen: 'PRECIO_CAPTURADO' },
    ],
    [
      'DTO > 0 sin moneda ⇒ la del ítem',
      { dtoVenta: 30, itemMoneda: 'USD' as const },
      { ventaUnitaria: 30, ventaMoneda: 'USD', origen: 'PRECIO_CAPTURADO' },
    ],
    [
      'DTO > 0 sin moneda ni ítem ⇒ MXN',
      { dtoVenta: 30.123456 },
      {
        ventaUnitaria: 30.1235,
        ventaMoneda: 'MXN',
        origen: 'PRECIO_CAPTURADO',
      },
    ],
    [
      'DTO 0 explícito ⇒ a costo (aunque el ítem tenga precio y haya margen)',
      { dtoVenta: 0, itemPrecio: 99, itemMoneda: 'USD' as const },
      { ventaUnitaria: null, ventaMoneda: null, origen: 'A_COSTO' },
    ],
    [
      'sin DTO: el precio del ítem, con la moneda del ítem',
      { itemPrecio: '45.5', itemMoneda: 'USD' as const },
      { ventaUnitaria: 45.5, ventaMoneda: 'USD', origen: 'PRECIO_PRODUCTO' },
    ],
    [
      'sin DTO ni precio: último precio + 25 % en la moneda de la compra (USD)',
      {},
      { ventaUnitaria: 26.5625, ventaMoneda: 'USD', origen: 'MARGEN' },
    ],
    [
      'margen en PESOS cuando la compra vigente fue en pesos',
      { costoUnitario: 1658.33, monedaSalida: 'MXN' as const },
      { ventaUnitaria: 2072.9125, ventaMoneda: 'MXN', origen: 'MARGEN' },
    ],
    [
      'margen 0 ⇒ a costo',
      { margenPct: 0 },
      { ventaUnitaria: null, ventaMoneda: null, origen: 'A_COSTO' },
    ],
    [
      'costo 0 (sin compra con costo) ⇒ a costo',
      { costoUnitario: 0 },
      { ventaUnitaria: null, ventaMoneda: null, origen: 'A_COSTO' },
    ],
    [
      'precio del ítem 0 no es precio: cae al margen',
      { itemPrecio: 0, itemMoneda: 'MXN' as const },
      { ventaUnitaria: 26.5625, ventaMoneda: 'USD', origen: 'MARGEN' },
    ],
  ])('%s', (_t, p, esperado) => {
    expect(precioVentaDeSalida({ ...base, ...p })).toEqual(esperado);
  });
});

describe('montoGastoDeSalida (fuente única del cargo al avión)', () => {
  it('con venta: cantidad × venta en su moneda; tc_gasto = T.C. de la fila (el del día de la venta)', () => {
    expect(
      montoGastoDeSalida({
        cantidad: 12,
        venta_unitaria: 26.5625,
        venta_moneda: 'USD',
        moneda: 'USD',
        costo_unitario_usd: 21.25,
        tc_usd_mxn: 17.0077,
      }),
    ).toEqual({
      monto: 318.75,
      moneda: 'USD',
      tcGasto: 17.0077,
      esVenta: true,
    });
  });
  it('sin venta: el costo de la fila, en pesos si la compra vigente fue en pesos', () => {
    expect(
      montoGastoDeSalida({
        cantidad: 4,
        venta_unitaria: null,
        moneda: 'MXN',
        costo_unitario_mxn: 1658.33,
        costo_unitario_usd: 94.71,
        tc_usd_mxn: 17.51,
      }),
    ).toEqual({
      monto: 6633.32,
      moneda: 'MXN',
      tcGasto: 17.51,
      esVenta: false,
    });
  });
  it('la venta de ventaDeSalida ES el monto del gasto', () => {
    for (const m of todosLosMovimientos({ tcOficial: true })) {
      if (m.tipo !== 'SALIDA') continue;
      const g = montoGastoDeSalida(m);
      const v = ventaDeSalida(m);
      if (g.esVenta) expect(v.ventaTotal).toBe(g.monto);
      else expect(v.costo.total).toBe(g.monto);
    }
  });
});

describe('textos es-MX', () => {
  it('precioTxt: 2 a 4 decimales, siempre con moneda; fechas cortadas del string', () => {
    expect(precioTxt(26.5625, 'USD')).toBe('$26.5625 USD');
    expect(precioTxt(21.25, 'USD')).toBe('$21.25 USD');
    expect(precioTxt(1658.33, 'MXN')).toBe('$1,658.33 MXN');
    expect(precioTxt(30, 'USD')).toBe('$30.00 USD');
    expect(precioTxt(21.205, 'USD')).toBe('$21.205 USD');
    expect(fechaCardexEsMx('2026-09-05')).toBe('5 sep 2026');
  });
  it('etiqueta del gasto: «último precio + 25 %» | «precio de venta» | «a costo»', () => {
    expect(etiquetaCargoDeSalida('MARGEN', 25)).toBe('último precio + 25 %');
    expect(etiquetaCargoDeSalida('PRECIO_PRODUCTO', null)).toBe(
      'precio de venta',
    );
    expect(etiquetaCargoDeSalida('PRECIO_CAPTURADO', null)).toBe(
      'precio de venta',
    );
    expect(etiquetaCargoDeSalida('A_COSTO', null)).toBe('a costo');
    expect(etiquetaCargoDeSalida(null, null)).toBe('a costo');
  });
});
