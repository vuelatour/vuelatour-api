jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
// notifications arrastra el gateway y `jose` (ESM), que jest no parsea.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import { Logger } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Hoja "inventario" del Balance general (`resumenTiendita`) — MONEDAS.
 *
 * Reporte del cliente (22-sep-2026): la columna «VALOR A COSTO MXN» decía
 * «Aceite 15w 50 · 30 · $3,300.00 MXN» cuando la única ENTRADA del producto
 * fue 30 × 110 **USD** sin tipo de cambio. Medido en producción: 67 de las 68
 * ENTRADAs (66 productos) son USD sin TC (la carga VTF-INV-001 del 29-ago
 * completada con el PATCH de costo), así que casi TODA esa columna —y su
 * total— eran dólares disfrazados de pesos. Decisión del cliente: mostrarlos
 * en dólares, aparte, en vez de sumarlos como pesos.
 *
 * Lo que se prueba aquí: que `valor_costo_mxn` SOLO trae pesos reales, que la
 * parte en dólares viaja en `valor_costo_usd`/`sin_tc`, que los totales
 * cuadran con la Σ de las filas moneda por moneda y que ninguna fila se
 * pierde por quedarse sin valor en pesos.
 *
 * Desde el API 0.0.36 (25-sep-2026) el VALOR A COSTO es existencia × ÚLTIMO
 * PRECIO DE COMPRA al T.C. oficial de HOY: con T.C. de hoy todo va en pesos;
 * sin él (servicio sin TipoCambioService, o sin dato), lo que se compró al
 * último en dólares va aparte, en dólares — jamás sumado como pesos.
 */

type Fila = Record<string, unknown>;
type Res = { data: unknown; error: null | { message: string }; count?: number };

const ITEMS: Fila[] = [
  { id: 'it-a', nombre: 'Aceite 15w 50', numero_parte: null },
  { id: 'it-b', nombre: 'Bujia', numero_parte: 'REM40E' },
  { id: 'it-c', nombre: 'Cable', numero_parte: null },
];

const mov = (
  id: string,
  item_id: string,
  tipo: 'ENTRADA' | 'SALIDA',
  cantidad: number,
  costo: number,
  moneda: 'MXN' | 'USD',
  tc: number | null = null,
  extra: Fila = {},
): Fila => ({
  id,
  item_id,
  tipo,
  cantidad,
  costo_unitario_usd: costo,
  moneda,
  costo_unitario_mxn: moneda === 'MXN' ? costo : null,
  tc_usd_mxn: tc,
  venta_unitaria: null,
  venta_moneda: null,
  fecha_movimiento: '2026-08-29',
  created_at: `2026-08-29T15:00:00Z`,
  para_flota: false,
  aeronave: null,
  ...extra,
});

/**
 * a) el caso REAL (todo en dólares sin TC), b) un ítem MIXTO (una capa en
 * pesos + una en dólares sin TC) y c) un ítem enteramente en pesos.
 */
const CARDEX: Fila[] = [
  mov('a1', 'it-a', 'ENTRADA', 30, 110, 'USD'),
  mov('b1', 'it-b', 'ENTRADA', 10, 200, 'MXN'),
  mov('b2', 'it-b', 'ENTRADA', 5, 40, 'USD'),
  mov('c1', 'it-c', 'ENTRADA', 4, 50, 'MXN'),
];

/** TipoCambioService falso: T.C. oficial fijo para cualquier fecha. */
const tcFijo = (tc: number) => ({
  oficialDetallePara: (fecha: string) =>
    Promise.resolve({ tc, fecha_dato: fecha, fuente: 'OPEN_ER_API' }),
});

function armar(cardex: Fila[] = CARDEX, items: Fila[] = ITEMS, tcHoy?: number) {
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    const cadena: string[] = [];
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'limit']) {
      q[m] = (...args: unknown[]) => {
        cadena.push(m);
        void args;
        return q;
      };
    }
    const resolver = (): Res => {
      switch (tabla) {
        case 'inventario_movimiento':
          return { data: cardex, error: null, count: cardex.length };
        case 'inventario_item':
          return { data: items, error: null };
        default:
          return { data: [], error: null, count: 0 };
      }
    };
    q.maybeSingle = () => Promise.resolve(resolver());
    q.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(resolve, reject);
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  return new InventoryService(
    supabase,
    {} as never,
    undefined,
    undefined,
    tcHoy != null ? (tcFijo(tcHoy) as never) : undefined,
  );
}

describe('resumenTiendita: el valor en dólares sin TC NUNCA se suma como pesos', () => {
  it('cada moneda en su columna, y los totales cuadran con la Σ de las filas', async () => {
    const r = await armar().resumenTiendita('2026-08-01', '2026-08-31');
    const porNombre = new Map(r.filas.map((f) => [f.nombre, f]));

    // (a) Caso REAL: 30 × 110 USD sin TC. En pesos NO vale 3,300 — vale 0.
    expect(porNombre.get('Aceite 15w 50')).toMatchObject({
      existencia: 30,
      valor_costo_mxn: 0,
      valor_costo_usd: 3300,
      sin_tc: true,
    });

    // (b) MIXTO: 10 × $200 MXN + 5 × 40 USD sin TC. Último precio = la
    // compra en dólares (mismo instante: desempate por id) ⇒ las 15 piezas
    // valen 40 USD, y sin T.C. de hoy van en DÓLARES (15 × 40 = 600).
    expect(porNombre.get('Bujia · REM40E')).toMatchObject({
      existencia: 15,
      valor_costo_mxn: 0,
      valor_costo_usd: 600,
      sin_tc: true,
    });

    // (c) Todo en pesos: nada que reportar en dólares.
    expect(porNombre.get('Cable')).toMatchObject({
      existencia: 4,
      valor_costo_mxn: 200,
      valor_costo_usd: null,
      sin_tc: false,
    });

    expect(r.total_piezas).toBe(49);
    expect(r.total_valor_mxn).toBe(200); // 0 + 0 + 200 — SOLO pesos
    expect(r.total_valor_usd).toBe(3900); // 3,300 + 600 — SOLO dólares
    expect(r.filas_sin_tc).toBe(2);
    expect(r.regla_costo).toBe('ULTIMO_PRECIO');
    expect(r.tc_hoy).toBeNull();
    // Σ de las filas, moneda por moneda (jamás una suma de las dos).
    expect(r.total_valor_mxn).toBe(
      r.filas.reduce((s, f) => s + (f.valor_costo_mxn ?? 0), 0),
    );
    expect(r.total_valor_usd).toBe(
      r.filas.reduce((s, f) => s + (f.valor_costo_usd ?? 0), 0),
    );
    expect(r.filas_sin_tc).toBe(r.filas.filter((f) => f.sin_tc).length);
  });

  it('un producto valorizado SOLO en dólares sigue apareciendo aunque no tenga actividad en el periodo', async () => {
    // Periodo posterior a todo el cardex: sin compras ni salidas que sumar,
    // pero la existencia (y su valor en dólares) sigue viva. Antes el filtro
    // miraba solo `valor_mxn`, que ahora es 0 para este producto.
    const r = await armar().resumenTiendita('2026-09-01', '2026-09-30');
    const fila = r.filas.find((f) => f.nombre === 'Aceite 15w 50');
    expect(fila).toMatchObject({
      existencia: 30,
      valor_costo_mxn: 0,
      valor_costo_usd: 3300,
      sin_tc: true,
      compradas_cant: null, // la compra quedó fuera del periodo
    });
    expect(r.total_valor_usd).toBe(3900);
  });

  it('CON el T.C. oficial de hoy (17.6729) todo el valorizado va en pesos; nada en dólares', async () => {
    const r = await armar(CARDEX, ITEMS, 17.6729).resumenTiendita(
      '2026-08-01',
      '2026-08-31',
    );
    const porNombre = new Map(r.filas.map((f) => [f.nombre, f]));
    expect(porNombre.get('Aceite 15w 50')).toMatchObject({
      valor_costo_mxn: 58320.57, // round2(3,300 × 17.6729)
      valor_costo_usd: null,
      sin_tc: false,
    });
    expect(porNombre.get('Bujia · REM40E')).toMatchObject({
      valor_costo_mxn: 10603.74, // round2(600 × 17.6729)
      valor_costo_usd: null,
      sin_tc: false,
    });
    expect(r.total_valor_mxn).toBe(69124.31);
    expect(r.total_valor_usd).toBe(0);
    expect(r.filas_sin_tc).toBe(0);
    expect(r.tc_hoy).toMatchObject({ tc: 17.6729, fuente: 'OPEN_ER_API' });
  });

  it('el aviso en el log se conserva (la hoja no tiene columna para las compras sin TC)', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await armar().resumenTiendita('2026-08-01', '2026-08-31');
      const texto = warn.mock.calls.map((c) => String(c[0])).join(' | ');
      expect(texto).toContain('USD sin TC');
      expect(texto).toContain('Aceite 15w 50');
      expect(texto).toContain('Bujia · REM40E');
      expect(texto).not.toContain('Cable');
    } finally {
      warn.mockRestore();
    }
  });

  it('sin nada en dólares sin T.C., la hoja no marca ninguna fila (0 y 0)', async () => {
    const soloPesos = [
      mov('c1', 'it-c', 'ENTRADA', 4, 50, 'MXN'),
      // Último precio: 6 USD (T.C. 18 de SU compra); el valorizado usa el de
      // HOY (18.5): 6 piezas × 6 USD = 36 USD × 18.5 = $666.
      mov('c2', 'it-c', 'ENTRADA', 2, 6, 'USD', 18),
    ];
    const r = await armar(soloPesos, [ITEMS[2]], 18.5).resumenTiendita(
      '2026-08-01',
      '2026-08-31',
    );
    expect(r.filas).toHaveLength(1);
    expect(r.filas[0]).toMatchObject({
      valor_costo_mxn: 666,
      valor_costo_usd: null,
      sin_tc: false,
      // Compras del periodo en pesos, cada una al T.C. de SU día:
      // 4 × 50 + round2(12 × 18) = 200 + 216.
      compradas_costo_mxn: 416,
    });
    expect(r.total_valor_mxn).toBe(666);
    expect(r.total_valor_usd).toBe(0);
    expect(r.filas_sin_tc).toBe(0);
    // Tienda (25-sep-2026): sin ventas en dólares, nada en las columnas USD.
    expect(r.filas[0]).toMatchObject({
      vendido_usd: null,
      utilidad_usd: null,
      ventas_sin_utilidad: 0,
    });
    expect(r.total_vendido_usd).toBeNull();
    expect(r.total_utilidad_usd).toBeNull();
    expect(r.filas_utilidad_incompleta).toBe(0);
    expect(r.margen_venta_pct).toBe(25);
  });
});

/**
 * 25-sep-2026 · UTILIDAD DE LA TIENDA en la hoja «inventario» y en
 * `GET tienda/resumen`: la venta en dólares sobre costo en dólares (sin T.C.)
 * tiene utilidad en USD —antes «—»—, en SU columna; la venta en pesos sobre
 * dólares sin T.C. no se puede calcular (se cuenta y se avisa); los pesos
 * quedan EXACTAMENTE como antes. Jamás se suman las dos monedas.
 */
const TIENDA: Fila[] = [
  // Aceite: 120 × 21.25 USD sin TC (carga VTF-INV-001).
  mov('a1', 'it-a', 'ENTRADA', 120, 21.25, 'USD'),
  // 12 a XA-VGV y 24 a N4142R a costo + 25 % (26.5625 USD).
  mov('a2', 'it-a', 'SALIDA', 12, 21.25, 'USD', null, {
    venta_unitaria: 26.5625,
    venta_moneda: 'USD',
    fecha_movimiento: '2026-09-01',
    created_at: '2026-09-22T14:13:06Z',
    aeronave: { matricula: 'XA-VGV' },
  }),
  mov('a3', 'it-a', 'SALIDA', 24, 21.25, 'USD', null, {
    venta_unitaria: 26.5625,
    venta_moneda: 'USD',
    fecha_movimiento: '2026-09-01',
    created_at: '2026-09-22T14:14:18Z',
    aeronave: { matricula: 'N4142R' },
  }),
  // Bujía (mixta): en PESOS 10 × $200 + 5 × 40 USD sin TC; una venta en
  // pesos que consume SOLO pesos (utilidad MXN) y otra en pesos que llega a
  // las capas en dólares (incompleta).
  mov('b1', 'it-b', 'ENTRADA', 10, 200, 'MXN', 18),
  mov('b2', 'it-b', 'ENTRADA', 5, 40, 'USD'),
  mov('b3', 'it-b', 'SALIDA', 8, 200, 'MXN', 18, {
    venta_unitaria: 250,
    venta_moneda: 'MXN',
    fecha_movimiento: '2026-09-02',
    created_at: '2026-09-02T10:00:00Z',
    aeronave: { matricula: 'N990GG' },
  }),
  mov('b4', 'it-b', 'SALIDA', 4, 40, 'USD', null, {
    venta_unitaria: 900,
    venta_moneda: 'MXN',
    fecha_movimiento: '2026-09-03',
    created_at: '2026-09-03T10:00:00Z',
    aeronave: { matricula: 'N990GG' },
  }),
];
// En este mock la ENTRADA MXN lleva costo_unitario_usd = 200 (el helper
// copia el costo): el FIFO en pesos usa costo_unitario_mxn = 200 igual.

describe('resumenTiendita: utilidad USD en su columna (tienda, 25-sep-2026)', () => {
  it('USD por fila y totales Σ USD aparte; los pesos como siempre; incompletas contadas', async () => {
    const r = await armar(TIENDA).resumenTiendita('2026-09-01', '2026-09-30');
    const porNombre = new Map(r.filas.map((f) => [f.nombre, f]));
    expect(porNombre.get('Aceite 15w 50')).toMatchObject({
      salidas_cant: 36,
      vendido_mxn: null,
      utilidad_mxn: null,
      vendido_usd: 956.25,
      utilidad_usd: 191.25,
      ventas_sin_utilidad: 0,
      matriculas: 'XA-VGV + N4142R',
    });
    expect(porNombre.get('Bujia · REM40E')).toMatchObject({
      salidas_cant: 12,
      vendido_mxn: 5600, // 8 × 250 + 4 × 900: la venta en pesos sí se expresa
      utilidad_mxn: 400, // solo la que consumió pesos: 2,000 − 1,600
      vendido_usd: null,
      utilidad_usd: null,
      ventas_sin_utilidad: 1,
    });
    expect(r.total_vendido_usd).toBe(956.25);
    expect(r.total_utilidad_usd).toBe(191.25);
    expect(r.total_utilidad_mxn).toBe(400);
    expect(r.filas_utilidad_incompleta).toBe(1);
    expect(r.margen_venta_pct).toBe(25);
  });

  it('tiendaResumen: utilidad de la tienda por moneda, unidades y productos con ventas', async () => {
    const svc = armar(TIENDA);
    const todo = await svc.tiendaResumen();
    expect(todo).toEqual({
      periodo: null,
      margen_venta_pct: 25,
      utilidad_mxn: 400,
      utilidad_usd: 191.25,
      ventas_mxn: 5600,
      ventas_usd: 956.25,
      costo_ventas_mxn: 1600,
      costo_ventas_usd: 765,
      unidades_cargadas: 48,
      unidades_vendidas: 48,
      productos_con_ventas: 2,
      ventas_sin_utilidad: 1,
      con_entradas_sin_costo: false,
      // ADITIVOS (0.0.36): sin T.C. en las salidas del aceite, su utilidad
      // es el RESPALDO en dólares (utilidad_usd); el USD «original» solo
      // existe para ventas que ya cuentan en pesos.
      ventas_usd_original: null,
      costo_ventas_usd_original: null,
      utilidad_usd_original: null,
      regla_costo: 'ULTIMO_PRECIO',
    });
    // Periodo sin salidas: null en cada moneda (no un 0 falso).
    const agosto = await svc.tiendaResumen({
      desde: '2026-08-01',
      hasta: '2026-08-31',
    });
    expect(agosto).toMatchObject({
      periodo: { desde: '2026-08-01', hasta: '2026-08-31' },
      utilidad_mxn: null,
      utilidad_usd: null,
      ventas_usd: null,
      unidades_cargadas: 0,
      unidades_vendidas: 0,
      productos_con_ventas: 0,
    });
    await expect(
      svc.tiendaResumen({ desde: '2026-09-30', hasta: '2026-09-01' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('con T.C. en las salidas (tras la migración): la utilidad del aceite cuenta en PESOS y el USD queda como original', async () => {
    const conTc = TIENDA.map((f) =>
      f.item_id === 'it-a'
        ? { ...f, tc_usd_mxn: f.tipo === 'SALIDA' ? 17.0077 : 17.0115 }
        : f,
    );
    const r = await armar(conTc).tiendaResumen();
    // 12 + 24 salidas: venta round2(318.75×17.0077)+round2(637.5×17.0077)
    // = 5,421.20 + 10,842.41; costo 4,336.96 + 8,673.93 ⇒ 3,252.72 (+400 de la bujía).
    expect(r).toMatchObject({
      utilidad_mxn: 3652.72,
      utilidad_usd: null,
      utilidad_usd_original: 191.25,
      ventas_usd_original: 956.25,
      ventas_usd: null,
    });
  });

  it('el margen del resumen sale de la configuración', async () => {
    const supabaseSvc = armar(TIENDA);
    // Mismo mock, con configuración que responde 12.5.
    const conCfg = new InventoryService(
      (supabaseSvc as unknown as { supabase: SupabaseService }).supabase,
      {} as never,
      undefined,
      { numero: () => Promise.resolve(12.5) } as never,
    );
    expect((await conCfg.tiendaResumen()).margen_venta_pct).toBe(12.5);
  });
});
