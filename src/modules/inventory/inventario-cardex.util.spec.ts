import {
  agregadosDeItem,
  bloquesCardexDe,
  buildLayers,
  costoSinTc,
  costoUnitarioMxnDe,
  filtroPeriodo,
  MARGEN_VENTA_PCT_DEFAULT,
  margenVentaValido,
  montoGastoDeSalida,
  precioVentaDeSalida,
  resumenDiarioDe,
  sortChrono,
  statsFromLayers,
  ventaDeSalida,
  ventaUnitariaConMargen,
  ventaYGananciaDe,
  walkCardex,
  type MovCardex,
} from './inventario-cardex.util';

/**
 * Cardex sintético de UN ítem ("Aceite"), en pesos:
 *  01-ago  e1 ENTRADA 10 @ $100 MXN (capturada en pesos)
 *  01-ago  e2 ENTRADA  5 @ 6 USD × TC 18 = $108 MXN
 *  03-ago  s1 SALIDA   8 vendida a $150 MXN → N1   (FIFO 8×100 = 800)
 *  03-ago  s2 SALIDA   4 SIN precio (a costo)      (FIFO 2×100 + 2×108 = 416)
 *  05-ago  d1 DEVOLUCION 1 @ $100 MXN desde N1
 *  06-ago  s3 SALIDA   2 vendida a 10 USD × TC 18 = $180 → FLOTA (FIFO 2×108 = 216)
 *  10-ago  e3 ENTRADA  3 @ $0 (carga masiva sin costo)
 */
const CARDEX: MovCardex[] = [
  {
    id: 'e1',
    tipo: 'ENTRADA',
    cantidad: 10,
    costo_unitario_usd: 5.5,
    moneda: 'MXN',
    costo_unitario_mxn: 100,
    tc_usd_mxn: 18.18,
    fecha_movimiento: '2026-08-01',
    created_at: '2026-08-01T15:00:00Z',
    proveedor: { nombre: 'Proveedor Uno' },
    referencia: 'F-1',
  },
  {
    id: 'e2',
    tipo: 'ENTRADA',
    cantidad: 5,
    costo_unitario_usd: 6,
    moneda: 'USD',
    costo_unitario_mxn: null,
    tc_usd_mxn: 18,
    fecha_movimiento: '2026-08-01',
    created_at: '2026-08-01T16:00:00Z',
  },
  {
    id: 's1',
    tipo: 'SALIDA',
    cantidad: 8,
    costo_unitario_usd: 5.5,
    moneda: 'MXN',
    costo_unitario_mxn: 100,
    tc_usd_mxn: 18.18,
    venta_unitaria: 150,
    venta_moneda: 'MXN',
    fecha_movimiento: '2026-08-03',
    created_at: '2026-08-03T15:00:00Z',
    aeronave_id: 'a1',
    aeronave: { matricula: 'N1' },
  },
  {
    id: 's2',
    tipo: 'SALIDA',
    cantidad: 4,
    costo_unitario_usd: 5.75,
    moneda: 'USD',
    costo_unitario_mxn: 104,
    tc_usd_mxn: 18.09,
    venta_unitaria: null,
    venta_moneda: null,
    fecha_movimiento: '2026-08-03',
    created_at: '2026-08-03T16:00:00Z',
  },
  {
    id: 'd1',
    tipo: 'DEVOLUCION',
    cantidad: 1,
    costo_unitario_usd: 5.5,
    moneda: 'MXN',
    costo_unitario_mxn: 100,
    tc_usd_mxn: 18.18,
    fecha_movimiento: '2026-08-05',
    created_at: '2026-08-05T15:00:00Z',
    aeronave: { matricula: 'N1' },
  },
  {
    id: 's3',
    tipo: 'SALIDA',
    cantidad: 2,
    costo_unitario_usd: 6,
    moneda: 'USD',
    costo_unitario_mxn: 108,
    tc_usd_mxn: 18,
    venta_unitaria: 10,
    venta_moneda: 'USD',
    para_flota: true,
    fecha_movimiento: '2026-08-06',
    created_at: '2026-08-06T15:00:00Z',
  },
  {
    id: 'e3',
    tipo: 'ENTRADA',
    cantidad: 3,
    costo_unitario_usd: 0,
    moneda: 'MXN',
    costo_unitario_mxn: 0,
    tc_usd_mxn: null,
    fecha_movimiento: '2026-08-10',
    created_at: '2026-08-10T15:00:00Z',
  },
];

/** Mismo cardex en orden REVUELTO: nada debe depender del orden de llegada. */
const REVUELTO = [
  CARDEX[4],
  CARDEX[2],
  CARDEX[6],
  CARDEX[0],
  CARDEX[5],
  CARDEX[3],
  CARDEX[1],
];

describe('costoUnitarioMxnDe / ventaYGananciaDe', () => {
  it('costo en pesos: MXN tal cual, USD × TC, USD sin TC tal cual', () => {
    expect(
      costoUnitarioMxnDe({
        costo_unitario_usd: 5.5,
        moneda: 'MXN',
        costo_unitario_mxn: 100,
        tc_usd_mxn: 18.18,
      }),
    ).toEqual({ mxn: 100, pesosExactos: true, enMxn: true });
    expect(
      costoUnitarioMxnDe({
        costo_unitario_usd: 6,
        moneda: 'USD',
        costo_unitario_mxn: null,
        tc_usd_mxn: 18,
      }),
    ).toEqual({ mxn: 108, pesosExactos: true, enMxn: false });
    expect(
      costoUnitarioMxnDe({
        costo_unitario_usd: 6,
        moneda: 'USD',
        costo_unitario_mxn: null,
        tc_usd_mxn: null,
      }),
    ).toEqual({ mxn: 6, pesosExactos: false, enMxn: false });
  });

  it('utilidad por venta: MXN, USD con TC ponderado y salida sin precio', () => {
    expect(ventaYGananciaDe({ cantidad: 8, venta_unitaria: 150 }, 800)).toEqual(
      {
        ventaUnitMxn: 150,
        ventaTotalMxn: 1200,
        gananciaMxn: 400,
        sinTc: false,
      },
    );
    expect(
      ventaYGananciaDe(
        {
          cantidad: 2,
          venta_unitaria: 10,
          venta_moneda: 'USD',
          tc_usd_mxn: 18,
        },
        216,
      ),
    ).toEqual({
      ventaUnitMxn: 180,
      ventaTotalMxn: 360,
      gananciaMxn: 144,
      sinTc: false,
    });
    // Venta con pérdida: se reporta negativa, jamás se recorta a 0.
    expect(ventaYGananciaDe({ cantidad: 1, venta_unitaria: 90 }, 100)).toEqual({
      ventaUnitMxn: 90,
      ventaTotalMxn: 90,
      gananciaMxn: -10,
      sinTc: false,
    });
    expect(
      ventaYGananciaDe({ cantidad: 4, venta_unitaria: null }, 416),
    ).toEqual({
      ventaUnitMxn: null,
      ventaTotalMxn: null,
      gananciaMxn: null,
      sinTc: false,
    });
  });

  it('monedas: USD sin TC jamás se suma como MXN — se expone (sinTc)', () => {
    // Venta en dólares sin tipo de cambio: no hay pesos que reportar.
    expect(
      ventaYGananciaDe(
        {
          cantidad: 2,
          venta_unitaria: 10,
          venta_moneda: 'USD',
          tc_usd_mxn: null,
        },
        216,
      ),
    ).toEqual({
      ventaUnitMxn: null,
      ventaTotalMxn: null,
      gananciaMxn: null,
      sinTc: true,
    });
    // Venta en pesos pero costo FIFO que consumió capas USD sin TC: la venta
    // sí es dinero real en pesos, la ganancia no se puede calcular.
    expect(
      ventaYGananciaDe({ cantidad: 2, venta_unitaria: 150 }, null, true),
    ).toEqual({
      ventaUnitMxn: 150,
      ventaTotalMxn: 300,
      gananciaMxn: null,
      sinTc: true,
    });
    // Salida a costo sobre capas sin TC: sigue sin venta, pero avisa.
    expect(
      ventaYGananciaDe({ cantidad: 2, venta_unitaria: null }, null, true),
    ).toMatchObject({ gananciaMxn: null, sinTc: true });
    expect(costoSinTc({ costo_unitario_usd: 6, moneda: 'USD' })).toBe(true);
    expect(
      costoSinTc({ costo_unitario_usd: 6, moneda: 'USD', tc_usd_mxn: 18 }),
    ).toBe(false);
    // $0 vale 0 en cualquier moneda: las entradas "sin costo" no son sin TC.
    expect(costoSinTc({ costo_unitario_usd: 0, moneda: 'USD' })).toBe(false);
  });
});

describe('FIFO: sortChrono / walkCardex / statsFromLayers', () => {
  it('ordena por fecha y desempata por created_at aunque lleguen revueltos', () => {
    expect(sortChrono(REVUELTO).map((m) => m.id)).toEqual([
      'e1',
      'e2',
      's1',
      's2',
      'd1',
      's3',
      'e3',
    ]);
  });

  it('stock corriente y costo FIFO MXN por salida', () => {
    const walk = walkCardex(REVUELTO);
    expect(walk.get('e1')).toEqual({
      stockDespues: 10,
      costoMxnFifo: null,
      costoUsdFifo: null,
      sinTc: false,
    });
    expect(walk.get('e2')).toEqual({
      stockDespues: 15,
      costoMxnFifo: null,
      costoUsdFifo: null,
      sinTc: false,
    });
    expect(walk.get('s1')).toEqual({
      stockDespues: 7,
      costoMxnFifo: 800,
      // El MISMO costo en la moneda canónica: 8 × 5.5 USD.
      costoUsdFifo: 44,
      sinTc: false,
    });
    // Cruza dos capas: 2 × 100 (resto de e1) + 2 × 108 (e2).
    expect(walk.get('s2')).toEqual({
      stockDespues: 3,
      costoMxnFifo: 416,
      // 2 × 5.5 (resto de e1) + 2 × 6 (e2) USD.
      costoUsdFifo: 23,
      sinTc: false,
    });
    expect(walk.get('d1')).toEqual({
      stockDespues: 4,
      costoMxnFifo: null,
      costoUsdFifo: null,
      sinTc: false,
    });
    expect(walk.get('s3')).toEqual({
      stockDespues: 2,
      costoMxnFifo: 216,
      costoUsdFifo: 12,
      sinTc: false,
    });
    expect(walk.get('e3')).toEqual({
      stockDespues: 5,
      costoMxnFifo: null,
      costoUsdFifo: null,
      sinTc: false,
    });
  });

  it('stats de las capas vivas (existencia y valorizado a hoy)', () => {
    const stats = statsFromLayers(buildLayers(REVUELTO));
    // Quedan 1 × 108 (e2), 1 × 100 (d1) y 3 × 0 (e3).
    expect(stats.stock).toBe(5);
    expect(stats.valor_mxn).toBe(208);
    expect(stats.costo_fifo_mxn_actual).toBe(108);
    // Todo el cardex está en pesos reales: nada que reportar en dólares.
    expect(stats.valor_usd_sin_tc).toBe(0);
    expect(stats.pesos_exactos).toBe(true);
  });

  /**
   * MONEDAS del VALORIZADO (22-sep-2026, invariante 8). Caso REAL del
   * cliente: la hoja de inventario del balance decía «Aceite 15w 50 · 30 ·
   * $3,300.00 MXN» cuando la única entrada era 30 × 110 USD SIN tipo de
   * cambio — la columna sumaba dólares y los rotulaba pesos.
   */
  describe('statsFromLayers: USD sin TC jamás se suma como MXN', () => {
    const entrada = (
      id: string,
      cantidad: number,
      costo: number,
      moneda: 'MXN' | 'USD',
      tc: number | null = null,
    ): MovCardex => ({
      id,
      tipo: 'ENTRADA',
      cantidad,
      costo_unitario_usd: costo,
      moneda,
      costo_unitario_mxn: moneda === 'MXN' ? costo : null,
      tc_usd_mxn: tc,
      fecha_movimiento: '2026-08-29',
      created_at: `2026-08-29T15:00:0${id.slice(-1)}Z`,
    });

    it('caso real (30 × 110 USD sin TC): el valor sale en DÓLARES, no en pesos', () => {
      const stats = statsFromLayers(
        buildLayers([entrada('u1', 30, 110, 'USD')]),
      );
      expect(stats.stock).toBe(30);
      expect(stats.valor_mxn).toBe(0);
      expect(stats.valor_usd_sin_tc).toBe(3300);
      expect(stats.pesos_exactos).toBe(false);
      // El USD interno del reparto NO cambia (mismas 30 × 110).
      expect(stats.valor_usd).toBe(3300);
    });

    it('ítem MIXTO: cada moneda en su campo, sin mezclarse jamás', () => {
      const stats = statsFromLayers(
        buildLayers([
          entrada('m1', 10, 200, 'MXN'), // $2,000 MXN reales
          entrada('u2', 5, 40, 'USD'), // 200 USD sin TC
          entrada('t3', 2, 6, 'USD', 18), // 2 × 108 = $216 MXN reales
        ]),
      );
      expect(stats.stock).toBe(17);
      expect(stats.valor_mxn).toBe(2216);
      expect(stats.valor_usd_sin_tc).toBe(200);
      expect(stats.pesos_exactos).toBe(false);
    });

    it('una ENTRADA a $0 sin TC no ensucia la bandera ($0 vale 0 en cualquier moneda)', () => {
      const stats = statsFromLayers(
        buildLayers([
          entrada('m4', 4, 50, 'MXN'),
          entrada('z5', 3, 0, 'USD'), // carga masiva sin costo
        ]),
      );
      expect(stats.valor_mxn).toBe(200);
      expect(stats.valor_usd_sin_tc).toBe(0);
      expect(stats.pesos_exactos).toBe(true);
    });

    it('la capa en dólares consumida por el FIFO deja de pesar en el valorizado', () => {
      const salida: MovCardex = {
        id: 's9',
        tipo: 'SALIDA',
        cantidad: 30,
        costo_unitario_usd: 110,
        moneda: 'USD',
        costo_unitario_mxn: null,
        tc_usd_mxn: null,
        fecha_movimiento: '2026-09-01',
        created_at: '2026-09-01T15:00:00Z',
      };
      const stats = statsFromLayers(
        buildLayers([
          entrada('u1', 30, 110, 'USD'),
          salida,
          entrada('m2', 2, 150, 'MXN'),
        ]),
      );
      expect(stats.stock).toBe(2);
      expect(stats.valor_mxn).toBe(300);
      expect(stats.valor_usd_sin_tc).toBe(0);
      expect(stats.pesos_exactos).toBe(true);
    });
  });
});

describe('agregadosDeItem (mismo número que la hoja Inventario del balance)', () => {
  it('acumulado histórico', () => {
    const a = agregadosDeItem(REVUELTO);
    expect(a.compradas_cant).toBe(18); // 10 + 5 + 3 — la devolución NO es compra
    expect(a.compradas_costo_mxn).toBe(1540); // 1000 + 540 + 0
    expect(a.salidas_cant).toBe(14); // 8 + 4 + 2 (con y sin precio)
    expect(a.ventas_mxn).toBe(1560); // 1200 + 360 — la salida a costo no es venta
    expect(a.costo_ventas_mxn).toBe(1016); // 800 + 216
    expect(a.utilidad_mxn).toBe(544); // 400 + 144
    expect(a.matriculas).toEqual(['N1', '—', 'FLOTA']);
    expect(a.con_entradas_sin_costo).toBe(true);
  });

  it('con periodo: solo suma lo del corte, pero el FIFO corre sobre todo el cardex', () => {
    const a = agregadosDeItem(
      REVUELTO,
      filtroPeriodo('2026-08-03', '2026-08-05'),
    );
    expect(a.compradas_cant).toBeNull();
    expect(a.compradas_costo_mxn).toBeNull();
    expect(a.salidas_cant).toBe(12);
    expect(a.ventas_mxn).toBe(1200);
    expect(a.costo_ventas_mxn).toBe(800); // capas del 1-ago, fuera del corte
    expect(a.utilidad_mxn).toBe(400);
    expect(a.matriculas).toEqual(['N1', '—']);
  });

  it('sin salidas con precio la utilidad es null (nunca un 0 falso)', () => {
    const a = agregadosDeItem([CARDEX[0], CARDEX[1], CARDEX[3]]);
    expect(a.salidas_cant).toBe(4);
    expect(a.ventas_mxn).toBeNull();
    expect(a.utilidad_mxn).toBeNull();
    expect(a.con_entradas_sin_costo).toBe(false);
  });

  it('un cardex vacío no tiene actividad', () => {
    expect(agregadosDeItem([])).toEqual({
      compradas_cant: null,
      compradas_costo_mxn: null,
      salidas_cant: null,
      ventas_mxn: null,
      costo_ventas_mxn: null,
      utilidad_mxn: null,
      // Llaves de la tienda (25-sep-2026): null/0 sin actividad.
      ventas_cant: null,
      ventas_usd: null,
      costo_ventas_usd: null,
      utilidad_usd: null,
      ventas_sin_utilidad: 0,
      matriculas: [],
      con_entradas_sin_costo: false,
      con_movimientos_sin_tc: false,
    });
  });

  it('USD sin TC: se excluye y se avisa (con_movimientos_sin_tc), nunca se suma como MXN', () => {
    const usdSinTc: MovCardex = {
      id: 'u1',
      tipo: 'ENTRADA',
      cantidad: 2,
      costo_unitario_usd: 50, // sin tc_usd_mxn: no hay pesos
      moneda: 'USD',
      fecha_movimiento: '2026-08-02',
      created_at: '2026-08-02T15:00:00Z',
    };
    const ventaSobreUsd: MovCardex = {
      id: 'su',
      tipo: 'SALIDA',
      cantidad: 3, // 2 del remanente de e1 (MXN) + 1 de la capa USD sin TC
      costo_unitario_usd: 50,
      moneda: 'USD',
      venta_unitaria: 1500,
      venta_moneda: 'MXN',
      fecha_movimiento: '2026-08-04',
      created_at: '2026-08-04T15:00:00Z',
    };
    // e1 (10 @ $100) · u1 (2 @ 50 USD sin TC) · s1 (8 de e1) · su (3: cruza a u1)
    const CON_USD = [CARDEX[0], usdSinTc, CARDEX[2], ventaSobreUsd];
    const a = agregadosDeItem(CON_USD);
    // s1 (8 de e1 a $100) sigue exacta; la salida sobre la capa USD sin TC
    // aporta su venta en pesos (real) pero NO una utilidad ni un costo.
    expect(a.compradas_cant).toBe(12);
    expect(a.compradas_costo_mxn).toBe(1000); // 2 × 50 USD NO se suma como $100 MXN
    expect(a.ventas_mxn).toBe(5700); // 1200 + 4500 (la venta en pesos sí es real)
    expect(a.costo_ventas_mxn).toBe(800);
    expect(a.utilidad_mxn).toBe(400); // solo s1 — jamás 4500 − (200 + 50 "MXN")
    expect(a.con_movimientos_sin_tc).toBe(true);
    const walk = walkCardex(CON_USD);
    expect(walk.get('u1')).toMatchObject({ sinTc: true, costoMxnFifo: null });
    expect(walk.get('su')).toEqual({
      stockDespues: 1,
      costoMxnFifo: null,
      // Sin TC no hay pesos, pero el costo en USD SÍ existe y es el que
      // delata un cambio de capas: 2 × 5.5 (e1) + 1 × 50 (u1).
      costoUsdFifo: 61,
      sinTc: true,
    });
    const b = bloquesCardexDe('Aceite', CON_USD);
    expect(b.compras[1]).toMatchObject({
      sin_tc: true,
      precio_unitario_mxn: null,
      total_mxn: null,
      moneda_captura: 'USD',
      costo_unitario_capturado: 50,
      descripcion: 'Aceite · sin TC',
    });
    expect(b.ventas[0]).toMatchObject({ sin_tc: false, ganancia_mxn: 400 });
    expect(b.ventas[1]).toMatchObject({
      a_costo: false,
      sin_tc: true,
      precio_unitario_mxn: 1500,
      total_mxn: 4500,
      costo_fifo_mxn: null,
      ganancia_mxn: null,
    });
    expect(b.totales.con_movimientos_sin_tc).toBe(true);
    const dias = resumenDiarioDe(CON_USD);
    expect(dias.map((d) => d.sin_tc)).toEqual([false, true, false, true]);
    // Una entrada a $0 en USD sin TC NO es un caso de TC (vale 0 en cualquier
    // moneda): el cardex de referencia no se marca.
    expect(agregadosDeItem(REVUELTO).con_movimientos_sin_tc).toBe(false);
  });
});

describe('resumenDiarioDe (bloque RESUMEN: existencia al cierre por día)', () => {
  it('una fila por día con el stock tras el último movimiento y la utilidad del día', () => {
    const dias = resumenDiarioDe(REVUELTO);
    expect(dias.map((d) => d.fecha)).toEqual([
      '2026-08-01',
      '2026-08-03',
      '2026-08-05',
      '2026-08-06',
      '2026-08-10',
    ]);
    expect(dias[0]).toEqual({
      fecha: '2026-08-01',
      entradas_cant: 15,
      salidas_cant: 0,
      existencia_cierre: 15,
      ventas_mxn: null,
      costo_ventas_mxn: null,
      utilidad_mxn: null,
      ventas_usd: null,
      costo_ventas_usd: null,
      utilidad_usd: null,
      sin_tc: false,
    });
    // Dos salidas el mismo día: existencia al CIERRE (3), utilidad solo de la
    // que llevó precio (400; la salida a costo no aporta ni resta).
    expect(dias[1]).toEqual({
      fecha: '2026-08-03',
      entradas_cant: 0,
      salidas_cant: 12,
      existencia_cierre: 3,
      ventas_mxn: 1200,
      costo_ventas_mxn: 800,
      utilidad_mxn: 400,
      ventas_usd: null,
      costo_ventas_usd: null,
      utilidad_usd: null,
      sin_tc: false,
    });
    expect(dias[2]).toMatchObject({
      entradas_cant: 1,
      existencia_cierre: 4,
      utilidad_mxn: null,
    });
    expect(dias[3]).toMatchObject({
      salidas_cant: 2,
      existencia_cierre: 2,
      ventas_mxn: 360,
      utilidad_mxn: 144,
    });
    expect(dias[4]).toMatchObject({
      entradas_cant: 3,
      existencia_cierre: 5,
      utilidad_mxn: null,
    });
  });

  it('el desempate por created_at manda dentro del día (salida antes que entrada tardía)', () => {
    // Mismo día: la ENTRADA se creó ANTES (14:00) que la SALIDA (15:00) aunque
    // llegue después en el arreglo → el cierre del día es 10 − 4 = 6.
    const dias = resumenDiarioDe([
      {
        id: 's',
        tipo: 'SALIDA',
        cantidad: 4,
        costo_unitario_usd: 5,
        moneda: 'MXN',
        costo_unitario_mxn: 100,
        fecha_movimiento: '2026-09-01',
        created_at: '2026-09-01T15:00:00Z',
      },
      {
        id: 'e',
        tipo: 'ENTRADA',
        cantidad: 10,
        costo_unitario_usd: 5,
        moneda: 'MXN',
        costo_unitario_mxn: 100,
        fecha_movimiento: '2026-09-01',
        created_at: '2026-09-01T14:00:00Z',
      },
    ]);
    expect(dias).toHaveLength(1);
    expect(dias[0].existencia_cierre).toBe(6);
  });

  it('con periodo lista solo esos días pero la existencia arrastra el historial', () => {
    const dias = resumenDiarioDe(
      REVUELTO,
      filtroPeriodo('2026-08-05', '2026-08-06'),
    );
    expect(dias.map((d) => d.fecha)).toEqual(['2026-08-05', '2026-08-06']);
    expect(dias[0].existencia_cierre).toBe(4);
    expect(dias[1].existencia_cierre).toBe(2);
  });

  it('la suma de utilidades por día es la utilidad del ítem', () => {
    const dias = resumenDiarioDe(REVUELTO);
    const suma = dias.reduce((s, d) => s + (d.utilidad_mxn ?? 0), 0);
    expect(suma).toBe(agregadosDeItem(REVUELTO).utilidad_mxn);
  });
});

describe('bloquesCardexDe (COMPRAS | VENTAS — lo mismo que el Excel formato libro)', () => {
  const b = bloquesCardexDe('Aceite', REVUELTO);

  it('COMPRAS: entradas en pesos, devolución/ajuste con su nota, sin costo marcado', () => {
    expect(b.compras.map((c) => c.movimiento_id)).toEqual([
      'e1',
      'e2',
      'd1',
      'e3',
    ]);
    expect(b.compras[0]).toMatchObject({
      tipo: 'ENTRADA',
      cantidad: 10,
      precio_unitario_mxn: 100,
      total_mxn: 1000,
      moneda_captura: 'MXN',
      costo_unitario_capturado: 100,
      sin_costo: false,
      proveedor_nombre: 'Proveedor Uno',
      referencia: 'F-1',
      descripcion: 'Aceite · Proveedor Uno · ref F-1',
      stock_despues: 10,
    });
    expect(b.compras[1]).toMatchObject({
      moneda_captura: 'USD',
      costo_unitario_capturado: 6,
      tc_usd_mxn: 18,
      precio_unitario_mxn: 108,
      total_mxn: 540,
      stock_despues: 15,
    });
    expect(b.compras[2]).toMatchObject({
      tipo: 'DEVOLUCION',
      aeronave_matricula: 'N1',
      descripcion: 'DEVOLUCIÓN — Aceite · N1',
      stock_despues: 4,
    });
    expect(b.compras[3]).toMatchObject({
      sin_costo: true,
      total_mxn: 0,
      stock_despues: 5,
    });
  });

  it('VENTAS: precio, ganancia, remanente, FLOTA y la salida a costo (ganancia 0)', () => {
    expect(b.ventas.map((v) => v.movimiento_id)).toEqual(['s1', 's2', 's3']);
    expect(b.ventas[0]).toMatchObject({
      cantidad: 8,
      precio_unitario_mxn: 150,
      total_mxn: 1200,
      venta_moneda: 'MXN',
      a_costo: false,
      costo_fifo_mxn: 800,
      ganancia_mxn: 400,
      vendido_a: 'N1',
      remanente: 7,
    });
    expect(b.ventas[1]).toMatchObject({
      a_costo: true,
      precio_unitario_mxn: 104,
      total_mxn: 416,
      ganancia_mxn: 0,
      vendido_a: '—',
      venta_moneda: null,
      descripcion: 'Aceite · a costo FIFO',
      remanente: 3,
    });
    expect(b.ventas[2]).toMatchObject({
      venta_moneda: 'USD',
      venta_unitaria_capturada: 10,
      precio_unitario_mxn: 180,
      total_mxn: 360,
      ganancia_mxn: 144,
      vendido_a: 'FLOTA',
      para_flota: true,
      remanente: 2,
    });
  });

  it('totales = los del listado/balance; el libro suma toda la columna', () => {
    expect(b.totales).toEqual({
      compras_cant: 18,
      compras_mxn: 1540,
      ventas_cant: 14,
      ventas_mxn: 1560,
      ventas_a_costo_mxn: 416,
      costo_ventas_mxn: 1016,
      utilidad_mxn: 544,
      // Todo en pesos: nada en dólares (25-sep-2026).
      ventas_usd: null,
      costo_ventas_usd: null,
      utilidad_usd: null,
      ventas_sin_utilidad: 0,
      con_entradas_sin_costo: true,
      con_movimientos_sin_tc: false,
    });
    // Lo que el Excel formato libro pinta como TOTAL de la columna de venta y
    // de ganancia (Σ de las filas, incluyendo las salidas a costo con 0).
    const totalVentaLibro = b.ventas.reduce(
      (s, v) => s + (v.total_mxn ?? 0),
      0,
    );
    const totalGananciaLibro = b.ventas.reduce(
      (s, v) => s + (v.ganancia_mxn ?? 0),
      0,
    );
    expect(totalVentaLibro).toBe(
      (b.totales.ventas_mxn ?? 0) + (b.totales.ventas_a_costo_mxn ?? 0),
    );
    expect(totalGananciaLibro).toBe(b.totales.utilidad_mxn);
    const totalCompraLibro = b.compras
      .filter((c) => c.tipo === 'ENTRADA')
      .reduce((s, c) => s + (c.total_mxn ?? 0), 0);
    expect(totalCompraLibro).toBe(b.totales.compras_mxn);
  });

  it('con periodo solo lista las filas del corte', () => {
    const p = bloquesCardexDe(
      'Aceite',
      REVUELTO,
      filtroPeriodo('2026-08-03', '2026-08-03'),
    );
    expect(p.compras).toEqual([]);
    expect(p.ventas.map((v) => v.movimiento_id)).toEqual(['s1', 's2']);
    expect(p.totales.utilidad_mxn).toBe(400);
    expect(p.totales.ventas_a_costo_mxn).toBe(416);
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

// =====================================================================
// TIENDA VuelaTour (25-sep-2026): margen sobre el costo, precio de la
// salida y utilidad en UNA sola moneda.
// =====================================================================

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
      'sin DTO ni precio: costo + 25 % en la moneda del costo (USD)',
      {},
      { ventaUnitaria: 26.5625, ventaMoneda: 'USD', origen: 'MARGEN' },
    ],
    [
      'margen en PESOS cuando la salida es MXN (capas compradas en pesos)',
      { costoUnitario: 1658.33, monedaSalida: 'MXN' as const },
      { ventaUnitaria: 2072.9125, ventaMoneda: 'MXN', origen: 'MARGEN' },
    ],
    [
      'margen 0 ⇒ a costo',
      { margenPct: 0 },
      { ventaUnitaria: null, ventaMoneda: null, origen: 'A_COSTO' },
    ],
    [
      'costo 0 (entrada sin costo real) ⇒ a costo',
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

describe('ventaDeSalida — utilidad de UNA salida en UNA sola moneda', () => {
  const ent = (
    id: string,
    cantidad: number,
    costo: number,
    moneda: 'MXN' | 'USD',
    tc: number | null,
    dia = '2026-09-01',
  ): MovCardex => ({
    id,
    tipo: 'ENTRADA',
    cantidad,
    costo_unitario_usd: moneda === 'MXN' && tc ? costo / tc : costo,
    moneda,
    costo_unitario_mxn: moneda === 'MXN' ? costo : null,
    tc_usd_mxn: tc,
    fecha_movimiento: dia,
    created_at: `${dia}T10:00:00Z`,
  });
  const sal = (
    id: string,
    cantidad: number,
    venta: number | null,
    ventaMoneda: 'MXN' | 'USD' | null,
    tc: number | null = null,
  ): MovCardex => ({
    id,
    tipo: 'SALIDA',
    cantidad,
    costo_unitario_usd: 0,
    moneda: 'USD',
    tc_usd_mxn: tc,
    venta_unitaria: venta,
    venta_moneda: ventaMoneda,
    fecha_movimiento: '2026-09-02',
    created_at: '2026-09-02T10:00:00Z',
    aeronave: { matricula: 'XA-VGV' },
  });
  const de = (cardex: MovCardex[], id: string) => {
    const mov = cardex.find((m) => m.id === id)!;
    return { mov, v: ventaDeSalida(mov, walkCardex(cardex).get(id)) };
  };

  it('pesos exactos ⇒ cuenta en MXN (idéntico a ventaYGananciaDe)', () => {
    const { v } = de(CARDEX, 's1');
    expect(v).toMatchObject({
      conVenta: true,
      ventaMoneda: 'MXN',
      ventaTotal: 1200,
      ventaTotalMxn: 1200,
      gananciaMxn: 400,
      costoMxn: 800,
      gananciaUsd: null,
      monedaUtilidad: 'MXN',
      utilidadIncompleta: false,
      sinTc: false,
    });
  });

  it('venta USD CON TC ⇒ sigue contando en MXN como siempre', () => {
    const { v } = de(CARDEX, 's3');
    expect(v).toMatchObject({
      ventaMoneda: 'USD',
      ventaTotal: 20,
      ventaTotalMxn: 360,
      gananciaMxn: 144,
      gananciaUsd: null,
      monedaUtilidad: 'MXN',
    });
  });

  it('venta USD sobre capas USD SIN TC ⇒ cuenta en USD (antes «—»)', () => {
    const cardex = [
      ent('e', 5, 21.25, 'USD', null),
      sal('s', 2, 26.5625, 'USD'),
    ];
    const { mov, v } = de(cardex, 's');
    expect(v).toMatchObject({
      conVenta: true,
      ventaTotal: 53.13,
      ventaTotalMxn: null,
      gananciaMxn: null,
      ventaTotalUsd: 53.13,
      costoUsd: 42.5,
      gananciaUsd: 10.63,
      monedaUtilidad: 'USD',
      utilidadIncompleta: false,
      sinTc: true,
    });
    // La venta ES el monto del gasto BODEGA (misma regla de redondeo).
    expect(v.ventaTotal).toBe(montoGastoDeSalida(mov).monto);
  });

  it('venta USD sobre capas MXN (con su TC) + USD sin TC ⇒ USD: la capa en pesos ya vive en USD con el TC de SU compra', () => {
    const cardex = [
      ent('e1', 2, 1658.33, 'MXN', 17.51, '2026-07-13'),
      ent('e2', 3, 21.25, 'USD', null),
      sal('s', 4, 100, 'USD'),
    ];
    const { v } = de(cardex, 's');
    // costo USD = 2 × (1658.33/17.51) + 2 × 21.25 = 189.42 + 42.5 = 231.92
    expect(v).toMatchObject({
      ventaTotalUsd: 400,
      costoUsd: 231.92,
      gananciaUsd: 168.08,
      gananciaMxn: null,
      monedaUtilidad: 'USD',
    });
  });

  it('venta en PESOS sobre capas USD sin TC ⇒ incompleta (no hay cómo restarlas)', () => {
    const cardex = [ent('e', 5, 21.25, 'USD', null), sal('s', 1, 500, 'MXN')];
    const { v } = de(cardex, 's');
    expect(v).toMatchObject({
      conVenta: true,
      ventaMoneda: 'MXN',
      gananciaMxn: null,
      gananciaUsd: null,
      monedaUtilidad: null,
      utilidadIncompleta: true,
    });
  });

  it('a costo ⇒ ni venta ni utilidad, y NO es «incompleta»', () => {
    const cardex = [ent('e', 5, 21.25, 'USD', null), sal('s', 1, null, null)];
    const { v } = de(cardex, 's');
    expect(v).toMatchObject({
      conVenta: false,
      ventaMoneda: null,
      ventaTotal: null,
      gananciaMxn: null,
      gananciaUsd: null,
      monedaUtilidad: null,
      utilidadIncompleta: false,
    });
  });

  it('venta USD con T.C. en el movimiento sobre capas sin T.C. ⇒ vendido SOLO en USD (agregados y resumen diario)', () => {
    const cardex = [
      ent('e', 5, 21.25, 'USD', null),
      sal('s', 3, 26.5625, 'USD', 18),
    ];
    const { v } = de(cardex, 's');
    // La venta trae pesos por el T.C. del movimiento, pero su utilidad cuenta en USD.
    expect(v.ventaTotalMxn).not.toBeNull();
    expect(v.monedaUtilidad).toBe('USD');
    const a = agregadosDeItem(cardex);
    expect(a.ventas_mxn).toBeNull();
    expect(a.utilidad_mxn).toBeNull();
    expect(a.ventas_usd).toBe(v.ventaTotalUsd);
    expect(a.utilidad_usd).toBe(v.gananciaUsd);
    const dia = resumenDiarioDe(cardex).find((d) => d.salidas_cant > 0)!;
    expect(dia.ventas_mxn ?? null).toBeNull();
    expect(dia.ventas_usd).toBe(v.ventaTotalUsd);
  });

  it('NUNCA en las dos monedas, y la venta siempre = monto del gasto', () => {
    const casos: Array<[MovCardex[], string]> = [
      [CARDEX, 's1'],
      [CARDEX, 's2'],
      [CARDEX, 's3'],
      [[ent('e', 5, 21.25, 'USD', null), sal('s', 2, 26.5625, 'USD')], 's'],
      [[ent('e', 5, 21.25, 'USD', null), sal('s', 1, 500, 'MXN')], 's'],
      [[ent('e', 5, 21.25, 'USD', 18), sal('s', 3, 26.5625, 'USD', 18)], 's'],
      [[ent('e', 5, 300, 'MXN', 18), sal('s', 1, 375, 'MXN', 18)], 's'],
    ];
    for (const [cardex, id] of casos) {
      const { mov, v } = de(cardex, id);
      expect(v.gananciaMxn != null && v.gananciaUsd != null).toBe(false);
      if (v.gananciaMxn != null) expect(v.monedaUtilidad).toBe('MXN');
      if (v.gananciaUsd != null) expect(v.monedaUtilidad).toBe('USD');
      const g = montoGastoDeSalida(mov);
      if (g.esVenta) expect(v.ventaTotal).toBe(g.monto);
      else expect(v.conVenta).toBe(false);
    }
  });
});

describe('montoGastoDeSalida (movida al util el 25-sep-2026, mismo cuerpo)', () => {
  it('con venta: cantidad × venta en la moneda de la venta, TC ponderado de referencia', () => {
    expect(
      montoGastoDeSalida({
        cantidad: 12,
        venta_unitaria: 26.5625,
        venta_moneda: 'USD',
        moneda: 'USD',
        costo_unitario_usd: 21.25,
        tc_usd_mxn: null,
      }),
    ).toEqual({ monto: 318.75, moneda: 'USD', tcGasto: null, esVenta: true });
  });
  it('sin venta: costo FIFO en pesos cuando la salida es MXN', () => {
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
});

describe('agregados / resumen por día / bloques con utilidad en DÓLARES', () => {
  // Carga VTF-INV-001 (USD sin TC) + una salida a costo + una venta con
  // margen + una venta en pesos sobre dólares (incompleta).
  const USD: MovCardex[] = [
    {
      id: 'e',
      tipo: 'ENTRADA',
      cantidad: 10,
      costo_unitario_usd: 21.25,
      moneda: 'USD',
      tc_usd_mxn: null,
      fecha_movimiento: '2026-08-29',
      created_at: '2026-08-29T17:36:43Z',
    },
    {
      id: 'sc',
      tipo: 'SALIDA',
      cantidad: 1,
      costo_unitario_usd: 21.25,
      moneda: 'USD',
      tc_usd_mxn: null,
      venta_unitaria: null,
      venta_moneda: null,
      fecha_movimiento: '2026-08-30',
      created_at: '2026-08-30T10:00:00Z',
      aeronave: { matricula: 'N990GG' },
    },
    {
      id: 'sv',
      tipo: 'SALIDA',
      cantidad: 4,
      costo_unitario_usd: 21.25,
      moneda: 'USD',
      tc_usd_mxn: null,
      venta_unitaria: 26.5625,
      venta_moneda: 'USD',
      fecha_movimiento: '2026-09-01',
      created_at: '2026-09-01T10:00:00Z',
      aeronave: { matricula: 'XA-VGV' },
    },
    {
      id: 'sm',
      tipo: 'SALIDA',
      cantidad: 1,
      costo_unitario_usd: 21.25,
      moneda: 'USD',
      tc_usd_mxn: null,
      venta_unitaria: 500,
      venta_moneda: 'MXN',
      fecha_movimiento: '2026-09-01',
      created_at: '2026-09-01T11:00:00Z',
      aeronave: { matricula: 'N4142R' },
    },
  ];

  it('agregadosDeItem: USD aparte de los pesos, unidades vendidas y las incompletas', () => {
    const a = agregadosDeItem(USD);
    expect(a).toMatchObject({
      salidas_cant: 6,
      ventas_cant: 5,
      ventas_mxn: 500, // la venta en pesos sí se expresa…
      costo_ventas_mxn: null, // …pero su costo no
      utilidad_mxn: null,
      ventas_usd: 106.25,
      costo_ventas_usd: 85,
      utilidad_usd: 21.25,
      ventas_sin_utilidad: 1,
      con_movimientos_sin_tc: true,
    });
    // Periodo de agosto: solo la salida a costo (sin ventas).
    const ago = agregadosDeItem(USD, filtroPeriodo('2026-08-01', '2026-08-31'));
    expect(ago).toMatchObject({
      salidas_cant: 1,
      ventas_cant: null,
      ventas_usd: null,
      utilidad_usd: null,
      ventas_sin_utilidad: 0,
    });
  });

  it('un cardex todo en pesos da EXACTAMENTE los números de siempre y nada en USD', () => {
    const a = agregadosDeItem(CARDEX);
    expect(a).toMatchObject({
      ventas_mxn: 1560,
      costo_ventas_mxn: 1016,
      utilidad_mxn: 544,
      ventas_cant: 10,
      ventas_usd: null,
      costo_ventas_usd: null,
      utilidad_usd: null,
      ventas_sin_utilidad: 0,
    });
  });

  it('resumenDiarioDe: la utilidad USD del día, aparte', () => {
    const dias = resumenDiarioDe(USD);
    const sep = dias.find((d) => d.fecha === '2026-09-01')!;
    expect(sep).toMatchObject({
      salidas_cant: 5,
      ventas_mxn: 500,
      utilidad_mxn: null,
      ventas_usd: 106.25,
      costo_ventas_usd: 85,
      utilidad_usd: 21.25,
    });
    const ago30 = dias.find((d) => d.fecha === '2026-08-30')!;
    expect(ago30.utilidad_usd).toBeNull();
  });

  it('bloquesCardexDe: cada venta dice su total, costo USD, utilidad y moneda', () => {
    const b = bloquesCardexDe('Aceite 15W-50', USD);
    const porId = new Map(b.ventas.map((v) => [v.movimiento_id, v]));
    expect(porId.get('sv')).toMatchObject({
      a_costo: false,
      venta_moneda: 'USD',
      venta_total: 106.25,
      costo_fifo_usd: 85,
      ganancia_usd: 21.25,
      ganancia_mxn: null,
      moneda_utilidad: 'USD',
      utilidad_incompleta: false,
    });
    expect(porId.get('sc')).toMatchObject({
      a_costo: true,
      venta_total: null,
      costo_fifo_usd: 21.25,
      ganancia_usd: null,
      moneda_utilidad: null,
      utilidad_incompleta: false,
    });
    expect(porId.get('sm')).toMatchObject({
      venta_moneda: 'MXN',
      venta_total: 500,
      moneda_utilidad: null,
      utilidad_incompleta: true,
    });
    expect(b.totales).toMatchObject({
      ventas_usd: 106.25,
      costo_ventas_usd: 85,
      utilidad_usd: 21.25,
      ventas_sin_utilidad: 1,
    });
  });
});
