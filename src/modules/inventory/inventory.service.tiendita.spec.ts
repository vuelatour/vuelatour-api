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

function armar(cardex: Fila[] = CARDEX, items: Fila[] = ITEMS) {
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
  return new InventoryService(supabase, {} as never);
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

    // (b) MIXTO: 10 × $200 MXN reales + 5 × 40 USD sin TC, separados.
    expect(porNombre.get('Bujia · REM40E')).toMatchObject({
      existencia: 15,
      valor_costo_mxn: 2000,
      valor_costo_usd: 200,
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
    expect(r.total_valor_mxn).toBe(2200); // 0 + 2,000 + 200 — SOLO pesos
    expect(r.total_valor_usd).toBe(3500); // 3,300 + 200 — SOLO dólares
    expect(r.filas_sin_tc).toBe(2);
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
    expect(r.total_valor_usd).toBe(3500);
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

  it('sin capas en dólares, la hoja sale EXACTAMENTE como antes (0 y 0 filas marcadas)', async () => {
    const soloPesos = [
      mov('c1', 'it-c', 'ENTRADA', 4, 50, 'MXN'),
      // USD CON tipo de cambio: es un peso real (2 × 6 × 18 = $216).
      mov('c2', 'it-c', 'ENTRADA', 2, 6, 'USD', 18),
    ];
    const r = await armar(soloPesos, [ITEMS[2]]).resumenTiendita(
      '2026-08-01',
      '2026-08-31',
    );
    expect(r.filas).toHaveLength(1);
    expect(r.filas[0]).toMatchObject({
      valor_costo_mxn: 416,
      valor_costo_usd: null,
      sin_tc: false,
    });
    expect(r.total_valor_mxn).toBe(416);
    expect(r.total_valor_usd).toBe(0);
    expect(r.filas_sin_tc).toBe(0);
  });
});
