// INICIO OFICIAL en el CARDEX (auditoría 16-oct-2026, API 0.0.85,
// invariante 86): los movimientos anteriores al inicio no se listan y su
// lugar lo toma «Saldo inicial al 1-sep-2026», LEÍDO con los helpers del
// cardex (sin recalcular FIFO). Existencias y precio vigente intactos.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import { InventoryService } from './inventory.service';
import { TipoMovimientoInventario } from './dto/inventory.dto';
import { saldoInicialCardex } from './inventario-saldo-inicial.util';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';

const mov = (
  id: string,
  tipo: string,
  cantidad: number,
  fecha: string,
  costo = 0,
) => ({
  id,
  item_id: 'i1',
  tipo,
  cantidad,
  costo_unitario_usd: costo,
  moneda: 'USD',
  costo_unitario_mxn: null,
  tc_usd_mxn: 18,
  fecha_movimiento: fecha,
  created_at: `${fecha}T15:00:00Z`,
});

/** Carga inicial del 29-ago (10 a $5), salida del 30-ago (3), compra de
 *  septiembre (5 a $6) y salida de octubre (2). */
const MOVS = [
  mov('e-ago', 'ENTRADA', 10, '2026-08-29', 5),
  mov('s-ago', 'SALIDA', 3, '2026-08-30', 5),
  mov('e-sep', 'ENTRADA', 5, '2026-09-10', 6),
  mov('s-oct', 'SALIDA', 2, '2026-10-02', 6),
];

describe('saldoInicialCardex (util)', () => {
  it('existencia y último precio de compra tras el último movimiento previo', () => {
    const s = saldoInicialCardex(MOVS, INICIO)!;
    expect(s.fecha).toBe(INICIO);
    expect(s.etiqueta).toBe('Saldo inicial al 1-sep-2026');
    expect(s.existencia).toBe(7);
    expect(s.costo_vigente?.movimiento_id).toBe('e-ago');
    expect(s.costo_vigente?.unitario_usd).toBe(5);
  });

  it('sin inicio o sin movimientos previos ⇒ null', () => {
    expect(saldoInicialCardex(MOVS, null)).toBeNull();
    expect(saldoInicialCardex(MOVS.slice(2), INICIO)).toBeNull();
  });
});

function armar(inicio: string | null) {
  const g = supabaseGrabador((tabla) =>
    tabla === 'inventario_movimiento'
      ? { data: MOVS, error: null, count: MOVS.length }
      : undefined,
  );
  const generateCardexLibroXlsx = jest.fn().mockResolvedValue(Buffer.from('x'));
  const generateTablaXlsx = jest.fn().mockResolvedValue(Buffer.from('x'));
  const svc = new InventoryService(
    g.supabase,
    { generateCardexLibroXlsx, generateTablaXlsx } as never,
    undefined,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  Object.assign(svc as unknown as Record<string, unknown>, {
    findItemConEmpaques: jest
      .fn()
      .mockResolvedValue({ id: 'i1', nombre: 'Aceite', empaques: [] }),
    findItem: jest.fn().mockResolvedValue({ id: 'i1', nombre: 'Aceite' }),
    tcHoy: jest.fn().mockResolvedValue(null),
  });
  return { svc, generateCardexLibroXlsx, generateTablaXlsx, ...g };
}

describe('InventoryService — cardex con inicio oficial', () => {
  it('ficha del artículo: oculta movimientos previos; stock del cardex completo; saldo_inicial', async () => {
    const r = (await armar(INICIO).svc.getItemDetail('i1')) as unknown as {
      stock: number;
      movimientos: Array<{ id: string }>;
      saldo_inicial: { existencia: number } | null;
    };
    const r0 = (await armar(null).svc.getItemDetail('i1')) as unknown as {
      stock: number;
      movimientos: Array<{ id: string }>;
      saldo_inicial: unknown;
    };
    expect(r.movimientos.map((m) => m.id).sort()).toEqual(['e-sep', 's-oct']);
    expect(r.saldo_inicial?.existencia).toBe(7);
    expect(r.stock).toBe(10);
    expect(r0.stock).toBe(10);
    expect(r0.movimientos).toHaveLength(4);
    expect(r0.saldo_inicial).toBeNull();
  });

  it('/inventory/movimientos: desde sube; rango anterior vacío; sin_costo sin piso', async () => {
    const a = armar(INICIO);
    const r = await a.svc.listMovimientos({
      item_id: 'i1',
      limit: 50,
      offset: 0,
    });
    const lista = a
      .de('inventario_movimiento')
      .find((c) =>
        c.ops.some(
          (o) => o.m === 'range' && o.args[0] === 0 && o.args[1] === 49,
        ),
      )!;
    expect(a.lleva(lista, 'gte', 'fecha_movimiento', INICIO)).toBe(true);
    expect(r.saldo_inicial?.existencia).toBe(7);

    const vacio = await armar(INICIO).svc.listMovimientos({
      desde: '2026-08-01',
      hasta: '2026-08-31',
      limit: 50,
      offset: 0,
    });
    expect(vacio.data).toEqual([]);

    const b = armar(INICIO);
    await b.svc.listMovimientos({
      tipo: TipoMovimientoInventario.ENTRADA,
      sin_costo: true,
      limit: 500,
      offset: 0,
    });
    expect(
      b.de('inventario_movimiento')[0].ops.some((o) => o.m === 'gte'),
    ).toBe(false);
  });

  it('Excel del cardex de un artículo: renglón «Saldo inicial» al final', async () => {
    const a = armar(INICIO);
    await a.svc.movimientosXlsx({ item_id: 'i1' } as never);
    const filas = (
      (a.generateTablaXlsx.mock.calls as unknown[][])[0][0] as {
        filas: unknown[][];
      }
    ).filas;
    const ultima = filas[filas.length - 1];
    expect(ultima[1]).toBe('SALDO INICIAL');
    expect(ultima[2]).toBe('Saldo inicial al 1-sep-2026');
    expect(ultima[4]).toBe(7);
  });

  it('cardex libro: filas desde el inicio con stock corriente del cardex completo + renglón inicial', async () => {
    const a = armar(INICIO);
    await a.svc.cardexLibroXlsx('i1');
    const p = (a.generateCardexLibroXlsx.mock.calls as unknown[][])[0][0] as {
      entradas: Array<{
        descripcion: string;
        stock_despues: number;
        valor_compra_total: number | null;
      }>;
      salidas: Array<{ fecha: string; remanente: number }>;
    };
    expect(p.entradas[0].descripcion).toBe('Saldo inicial al 1-sep-2026');
    expect(p.entradas[0].valor_compra_total).toBeNull();
    expect(p.entradas[1].stock_despues).toBe(12);
    expect(p.salidas.map((s) => s.fecha)).toEqual(['2026-10-02']);

    const b = armar(null);
    await b.svc.cardexLibroXlsx('i1');
    const p0 = (b.generateCardexLibroXlsx.mock.calls as unknown[][])[0][0] as {
      entradas: unknown[];
      salidas: unknown[];
    };
    expect(p0.entradas).toHaveLength(2);
    expect(p0.salidas).toHaveLength(2);
  });
});

describe('InventoryService — ficha (resumen) y tienda con inicio oficial', () => {
  it('ficha: compras/ventas desde el inicio, existencia del cardex completo, saldo_inicial', async () => {
    const a = armar(INICIO);
    Object.assign(a.svc as unknown as Record<string, unknown>, {
      compraIdPorMovimiento: jest.fn().mockResolvedValue(new Map()),
      gastoIdPorMovimiento: jest.fn().mockResolvedValue(new Map()),
    });
    const r = await a.svc.resumenItem('i1');
    expect(r.compras.map((c) => c.movimiento_id)).toEqual(['e-sep']);
    expect(r.ventas.map((v) => v.movimiento_id)).toEqual(['s-oct']);
    expect(r.totales.existencia_actual).toBe(10);
    expect(r.saldo_inicial?.existencia).toBe(7);
    expect(r.periodo).toBeNull();
  });

  it('tienda: la utilidad suma desde el inicio (desde sube)', async () => {
    const a = armar(INICIO);
    const agregadosPorItem = jest.fn().mockResolvedValue([]);
    Object.assign(a.svc as unknown as Record<string, unknown>, {
      agregadosPorItem,
    });
    const r = await a.svc.tiendaResumen({ desde: '2026-08-01' });
    expect(agregadosPorItem).toHaveBeenCalledWith(INICIO, undefined);
    expect(r.periodo).toEqual({ desde: INICIO, hasta: null });
    const b = armar(null);
    const ag0 = jest.fn().mockResolvedValue([]);
    Object.assign(b.svc as unknown as Record<string, unknown>, {
      agregadosPorItem: ag0,
    });
    await b.svc.tiendaResumen({});
    expect(ag0).toHaveBeenCalledWith(undefined, undefined);
  });
});
