// INVENTARIO CON TODO EL HISTORIAL (18-oct-2026). Pedido del cliente: «en
// inventario sí debemos mostrar lo de agosto y julio, solo en inventario» y
// «cambiar el formato del Cardex del producto en forma de lista por orden de
// fecha … en el Excel que se descarga debería venir stock inicio del mes y
// stock final del mes y cantidad de unidades vendidas». El inventario ya no
// lleva el piso del inicio oficial (invariante 86) aunque la fila esté
// encendida; la lista por fecha sale de `bloquesCardexDe` y el resumen por
// mes del mismo recorrido del stock.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import { InventoryService } from './inventory.service';
import {
  bloquesCardexDe,
  cardexCronologicoDe,
  mesesCardexDe,
} from './inventario-cardex.util';
import { ComprasService } from '../compras/compras.service';
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
  extra: Record<string, unknown> = {},
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
  ...extra,
});

/** Carga inicial del 29-ago (10 a $5), salida del 30-ago a costo (3),
 *  compra de septiembre (5 a $6) y venta de octubre (2 a $8). */
const MOVS = [
  mov('e-ago', 'ENTRADA', 10, '2026-08-29', 5),
  mov('s-ago', 'SALIDA', 3, '2026-08-30', 5),
  mov('e-sep', 'ENTRADA', 5, '2026-09-10', 6),
  mov('s-oct', 'SALIDA', 2, '2026-10-02', 6, {
    venta_unitaria: 8,
    venta_moneda: 'USD',
    aeronave: { matricula: 'XA-VGV' },
    referencia: '0',
  }),
];

describe('lista por fecha y resumen por mes (util)', () => {
  it('cardexCronologicoDe: compras y ventas en UN orden, con la existencia de cada paso', () => {
    const filas = cardexCronologicoDe(bloquesCardexDe('Aceite', MOVS));
    expect(
      filas.map((f) => [
        f.movimiento_id,
        f.tipo,
        f.entra,
        f.sale,
        f.existencia,
      ]),
    ).toEqual([
      ['e-ago', 'ENTRADA', 10, null, 10],
      ['s-ago', 'SALIDA', null, 3, 7],
      ['e-sep', 'ENTRADA', 5, null, 12],
      ['s-oct', 'SALIDA', null, 2, 10],
    ]);
    expect(filas.map((f) => f.mes)).toEqual([
      '2026-08',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
    // Detalle legible: la referencia «0» no dice nada y no se pinta.
    expect(filas[0].detalle).toBe('Entrada a bodega');
    expect(filas[1].detalle).toBe('Sin avión · a costo');
    expect(filas[3].detalle).toBe('XA-VGV');
    // Venta: 2 × 8 USD × 18 = 288; costo 2 × 6 × 18 = 216 ⇒ ganancia 72.
    expect(filas[3].total_mxn).toBe(288);
    expect(filas[3].ganancia_mxn).toBe(72);
    // A costo: ganancia 0 (el libro la registra «vendida al costo»).
    expect(filas[1].a_costo).toBe(true);
    expect(filas[1].ganancia_mxn).toBe(0);
  });

  it('el orden de un mismo día lo decide el alta, no el tipo', () => {
    const mismoDia = [
      mov('s1', 'SALIDA', 1, '2026-09-10', 6, {
        created_at: '2026-09-10T10:00:00Z',
      }),
      mov('e0', 'ENTRADA', 4, '2026-09-01', 6),
      mov('e1', 'ENTRADA', 2, '2026-09-10', 6, {
        created_at: '2026-09-10T12:00:00Z',
      }),
    ];
    const filas = cardexCronologicoDe(bloquesCardexDe('Aceite', mismoDia));
    expect(filas.map((f) => [f.movimiento_id, f.existencia])).toEqual([
      ['e0', 4],
      ['s1', 3],
      ['e1', 5],
    ]);
  });

  it('mesesCardexDe: stock al inicio, entradas, vendidas y stock al final, mes por mes hasta hoy', () => {
    const meses = mesesCardexDe(MOVS, { hoy: '2026-11-05' });
    expect(
      meses.map((m) => [
        m.mes,
        m.stock_inicio,
        m.entradas,
        m.unidades_vendidas,
        m.stock_final,
        m.movimientos,
        m.en_curso,
      ]),
    ).toEqual([
      ['2026-08', 0, 10, 3, 7, 2, false],
      ['2026-09', 7, 5, 0, 12, 1, false],
      ['2026-10', 12, 0, 2, 10, 1, false],
      // Mes sin movimientos: el stock se arrastra.
      ['2026-11', 10, 0, 0, 10, 0, true],
    ]);
    // Cuadre: final = inicio + entradas − vendidas, en cada mes.
    for (const m of meses) {
      expect(m.stock_final).toBe(
        m.stock_inicio + m.entradas - m.unidades_vendidas,
      );
    }
    // Vendido y utilidad del mes = agregadosDeItem del mes (la salida a
    // costo de agosto no es venta).
    expect(meses[0].vendido_mxn).toBeNull();
    expect(meses[2].vendido_mxn).toBe(288);
    expect(meses[2].utilidad_mxn).toBe(72);
    expect(meses[3].vendido_mxn).toBeNull();
  });

  it('mesesCardexDe: desde/hasta acotan los meses, el stock de apertura sale de TODO el cardex', () => {
    const meses = mesesCardexDe(MOVS, {
      hoy: '2026-11-05',
      desde: '2026-09-15',
      hasta: '2026-09-30',
    });
    expect(meses.map((m) => [m.mes, m.stock_inicio, m.stock_final])).toEqual([
      ['2026-09', 7, 12],
    ]);
    expect(mesesCardexDe([], { hoy: '2026-10-18' })).toEqual([]);
  });

  it('un movimiento fechado después de hoy alarga la lista hasta su mes', () => {
    const meses = mesesCardexDe(
      [...MOVS, mov('e-dic', 'ENTRADA', 1, '2026-12-01', 6)],
      { hoy: '2026-10-18' },
    );
    expect(meses.map((m) => m.mes)).toEqual([
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(meses.find((m) => m.mes === '2026-10')?.en_curso).toBe(true);
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
  const cfg = cfgInicio(inicio);
  const svc = new InventoryService(
    g.supabase,
    { generateCardexLibroXlsx, generateTablaXlsx } as never,
    undefined,
    cfg as unknown as ConfiguracionService,
  );
  Object.assign(svc as unknown as Record<string, unknown>, {
    findItemConEmpaques: jest
      .fn()
      .mockResolvedValue({ id: 'i1', nombre: 'Aceite', empaques: [] }),
    findItem: jest.fn().mockResolvedValue({ id: 'i1', nombre: 'Aceite' }),
    tcHoy: jest.fn().mockResolvedValue(null),
    compraIdPorMovimiento: jest.fn().mockResolvedValue(new Map()),
    gastoIdPorMovimiento: jest.fn().mockResolvedValue(new Map()),
  });
  return { svc, cfg, generateCardexLibroXlsx, generateTablaXlsx, ...g };
}

describe('InventoryService — todo el historial aunque el inicio oficial esté encendido', () => {
  it('ficha del artículo: los 4 movimientos (julio/agosto incluidos), sin saldo inicial', async () => {
    const a = armar(INICIO);
    const r = (await a.svc.getItemDetail('i1')) as unknown as {
      stock: number;
      movimientos: Array<{ id: string }>;
    };
    expect(r.movimientos.map((m) => m.id).sort()).toEqual([
      'e-ago',
      'e-sep',
      's-ago',
      's-oct',
    ]);
    expect(r.stock).toBe(10);
    expect(r).not.toHaveProperty('saldo_inicial');
    expect(a.cfg.inicioOficial).not.toHaveBeenCalled();
  });

  it('/inventory/movimientos: sin piso; un rango de agosto devuelve agosto', async () => {
    const a = armar(INICIO);
    const r = await a.svc.listMovimientos({
      item_id: 'i1',
      limit: 50,
      offset: 0,
    });
    expect(
      a.de('inventario_movimiento')[0].ops.some((o) => o.m === 'gte'),
    ).toBe(false);
    expect(r).not.toHaveProperty('saldo_inicial');

    const b = armar(INICIO);
    await b.svc.listMovimientos({
      desde: '2026-08-01',
      hasta: '2026-08-31',
      limit: 50,
      offset: 0,
    });
    const q = b.de('inventario_movimiento')[0];
    expect(b.lleva(q, 'gte', 'fecha_movimiento', '2026-08-01')).toBe(true);
    expect(b.lleva(q, 'lte', 'fecha_movimiento', '2026-08-31')).toBe(true);
  });

  it('Excel del cardex general: sin renglón «Saldo inicial»', async () => {
    const a = armar(INICIO);
    await a.svc.movimientosXlsx({ item_id: 'i1' } as never);
    const filas = (
      (a.generateTablaXlsx.mock.calls as unknown[][])[0][0] as {
        filas: unknown[][];
      }
    ).filas;
    expect(filas.some((f) => f[1] === 'SALDO INICIAL')).toBe(false);
  });

  it('cardex en Excel: formato de siempre COMPLETO + lista por fecha + resumen por mes', async () => {
    const a = armar(INICIO);
    await a.svc.cardexLibroXlsx('i1');
    const p = (a.generateCardexLibroXlsx.mock.calls as unknown[][])[0][0] as {
      entradas: Array<{ fecha: string; stock_despues: number }>;
      salidas: Array<{ fecha: string; remanente: number }>;
      movimientos: Array<{
        fecha: string;
        tipo: string;
        existencia: number;
        entra: number | null;
        sale: number | null;
      }>;
      meses: Array<{
        mes: string;
        etiqueta: string;
        stock_inicio: number;
        unidades_vendidas: number;
        stock_final: number;
      }>;
    };
    // Lo de siempre (un pyservices previo lo pinta), ya sin el saldo inicial.
    expect(p.entradas.map((e) => [e.fecha, e.stock_despues])).toEqual([
      ['2026-08-29', 10],
      ['2026-09-10', 12],
    ]);
    expect(p.salidas.map((s) => [s.fecha, s.remanente])).toEqual([
      ['2026-08-30', 7],
      ['2026-10-02', 10],
    ]);
    // Lo nuevo.
    expect(
      p.movimientos.map((m) => [
        m.fecha,
        m.tipo,
        m.entra,
        m.sale,
        m.existencia,
      ]),
    ).toEqual([
      ['2026-08-29', 'ENTRADA', 10, null, 10],
      ['2026-08-30', 'SALIDA', null, 3, 7],
      ['2026-09-10', 'ENTRADA', 5, null, 12],
      ['2026-10-02', 'SALIDA', null, 2, 10],
    ]);
    expect(
      p.meses
        .slice(0, 3)
        .map((m) => [
          m.mes,
          m.etiqueta,
          m.stock_inicio,
          m.unidades_vendidas,
          m.stock_final,
        ]),
    ).toEqual([
      ['2026-08', 'Agosto 2026', 0, 3, 7],
      ['2026-09', 'Septiembre 2026', 7, 0, 12],
      ['2026-10', expect.stringMatching(/^Octubre 2026/), 12, 2, 10],
    ]);
    expect(a.cfg.inicioOficial).not.toHaveBeenCalled();
  });

  it('ficha (resumen): compras y ventas de julio/agosto, con `orden` y `meses`', async () => {
    const a = armar(INICIO);
    const r = await a.svc.resumenItem('i1');
    expect(r.compras.map((c) => [c.movimiento_id, c.orden])).toEqual([
      ['e-ago', 0],
      ['e-sep', 2],
    ]);
    expect(r.ventas.map((v) => [v.movimiento_id, v.orden])).toEqual([
      ['s-ago', 1],
      ['s-oct', 3],
    ]);
    expect(
      r.meses.slice(0, 3).map((m) => [m.mes, m.stock_inicio, m.stock_final]),
    ).toEqual([
      ['2026-08', 0, 7],
      ['2026-09', 7, 12],
      ['2026-10', 12, 10],
    ]);
    expect(r.totales.existencia_actual).toBe(10);
    expect(r).not.toHaveProperty('saldo_inicial');
    expect(r.periodo).toBeNull();
  });

  it('ficha con periodo: `desde` tal cual (sin subirlo al inicio)', async () => {
    const a = armar(INICIO);
    const r = await a.svc.resumenItem('i1', {
      desde: '2026-08-01',
      hasta: '2026-08-31',
    });
    expect(r.compras.map((c) => c.movimiento_id)).toEqual(['e-ago']);
    expect(r.periodo).toEqual({ desde: '2026-08-01', hasta: '2026-08-31' });
    expect(r.meses.map((m) => m.mes)).toEqual(['2026-08']);
  });

  it('utilidad de la tienda: el `desde` pedido tal cual', async () => {
    const a = armar(INICIO);
    const agregadosPorItem = jest.fn().mockResolvedValue([]);
    Object.assign(a.svc as unknown as Record<string, unknown>, {
      agregadosPorItem,
    });
    const r = await a.svc.tiendaResumen({ desde: '2026-08-01' });
    expect(agregadosPorItem).toHaveBeenCalledWith('2026-08-01', undefined);
    expect(r.periodo).toEqual({ desde: '2026-08-01', hasta: null });
    await a.svc.tiendaResumen({});
    expect(agregadosPorItem).toHaveBeenLastCalledWith(undefined, undefined);
    expect(a.cfg.inicioOficial).not.toHaveBeenCalled();
  });
});

describe('ComprasService.list — sin piso del inicio oficial', () => {
  it('la lista de compras no filtra por fecha', async () => {
    const g = supabaseGrabador();
    const svc = new ComprasService(g.supabase, {} as never);
    await svc.list({ limit: 50, offset: 0 });
    expect(g.de('compra')[0].ops.some((o) => o.m === 'gte')).toBe(false);
  });
});
