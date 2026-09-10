jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { ConflictException, Logger } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { TipoMovimientoInventario } from './dto/inventory.dto';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Lote 2 Ola B (10-sep-2026) · B2 en el cardex: POST
 * /inventory/items/:id/movimientos idempotente por `client_request_id`. El
 * replay (pre-check por llave o 23505 sobre uq_inv_movimiento_client_request)
 * devuelve el movimiento YA creado con su gasto BODEGA ligado
 * (gasto.inventario_movimiento_id) y el stock actual, sin volver a mover
 * stock ni dinero. Con la columna ausente, alta de siempre.
 */
type Resultado = {
  data: unknown;
  error: null | { code?: string; message: string };
  count?: number | null;
};
type Llamada = { tabla: string; metodo: string; args: unknown[] };

function armar(tablas: Record<string, Resultado[]>, columnaLlave = true) {
  const llamadas: Llamada[] = [];
  const cursor: Record<string, number> = {};
  const siguiente = (tabla: string): Resultado => {
    const lista = tablas[tabla] ?? [{ data: null, error: null }];
    const i = cursor[tabla] ?? 0;
    cursor[tabla] = i + 1;
    return lista[Math.min(i, lista.length - 1)];
  };
  const from = (tabla: string) => {
    llamadas.push({ tabla, metodo: 'from', args: [tabla] });
    const cadena: Llamada[] = [];
    const q: Record<string, unknown> = {};
    const registra =
      (metodo: string) =>
      (...args: unknown[]) => {
        const l = { tabla, metodo, args };
        llamadas.push(l);
        cadena.push(l);
        return q;
      };
    for (const m of [
      'select',
      'eq',
      'in',
      'gte',
      'lte',
      'order',
      'range',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = registra(m);
    }
    const resolver = (): Resultado => {
      const sel = cadena.find((l) => l.metodo === 'select');
      const esSonda =
        cadena.length === 2 &&
        cadena.some((l) => l.metodo === 'limit') &&
        sel?.args[0] === 'client_request_id';
      if (esSonda) {
        return columnaLlave
          ? { data: [], error: null }
          : {
              data: null,
              error: {
                code: '42703',
                message:
                  'column inventario_movimiento.client_request_id does not exist',
              },
            };
      }
      return siguiente(tabla);
    };
    q.maybeSingle = () => Promise.resolve(resolver());
    q.then = (
      resolve: (v: Resultado) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(resolver()).then(resolve, reject);
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  return { service: new InventoryService(supabase, {} as never), llamadas };
}

const de = (llamadas: Llamada[], tabla: string, metodo: string) =>
  llamadas.filter((l) => l.tabla === tabla && l.metodo === metodo);

const KEY = '33333333-3333-4333-8333-333333333333';
const ITEM = { id: 'i-1', nombre: 'Aceite W100', precio_venta: null };
const MOV = {
  id: 'mv-1',
  item_id: 'i-1',
  tipo: 'SALIDA',
  cantidad: 2,
  empaque_id: null,
  cantidad_empaques: null,
  costo_unitario_usd: 10,
  moneda: 'USD',
  costo_unitario_mxn: null,
  tc_usd_mxn: null,
  venta_unitaria: null,
  venta_moneda: null,
  aeronave_id: 'a-1',
  proveedor_id: null,
  fecha_movimiento: '2026-09-10',
  fecha_orden: null,
  fecha_cargo_banco: null,
  referencia: null,
  notas: null,
  registrado_por: 'u-mec',
  created_at: '2026-09-10T15:00:00+00:00',
};
/** Cardex del ítem (movsForItem, paginado con count): una capa de 5 a $10. */
const CARDEX = {
  data: [
    {
      id: 'mv-0',
      tipo: 'ENTRADA',
      cantidad: 5,
      costo_unitario_usd: 10,
      moneda: 'USD',
      costo_unitario_mxn: null,
      tc_usd_mxn: null,
      fecha_movimiento: '2026-09-01',
      created_at: '2026-09-01T00:00:00+00:00',
    },
    MOV,
  ],
  error: null,
  count: 2,
};
const SIN_MAS = { data: [], error: null, count: 2 };

describe('InventoryService.createMovimiento — B2 idempotencia', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  it('replay por pre-check: devuelve el movimiento existente + gasto BODEGA ligado + stock, sin insert, sin gasto nuevo, sin validar', async () => {
    const { service, llamadas } = armar({
      inventario_movimiento: [
        {
          data: {
            ...MOV,
            para_flota: false,
            client_request_id: KEY,
            empaque: null,
          },
          error: null,
        }, // pre-check por llave
        CARDEX, // movsForItem (stock)
        SIN_MAS,
      ],
      gasto: [
        {
          data: [
            { id: 'g-9', monto: 20, moneda: 'USD', categoria: 'REFACCION' },
          ],
          error: null,
        },
      ],
    });
    const res = await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.SALIDA,
        cantidad: 2,
        aeronave_id: 'a-1',
        client_request_id: KEY,
      },
      'u-mec',
    );
    expect(res).toMatchObject({
      id: 'mv-1',
      tipo: 'SALIDA',
      empaque: null,
      stock_resultante: 3,
      gasto_generado: {
        id: 'g-9',
        monto: 20,
        moneda: 'USD',
        categoria: 'REFACCION',
      },
      reversion_pendiente: null,
      client_request_id: KEY,
      idempotente: true,
    });
    expect(res).not.toHaveProperty('para_flota');
    expect(de(llamadas, 'inventario_movimiento', 'insert')).toHaveLength(0);
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(0);
    expect(de(llamadas, 'inventario_item', 'from')).toHaveLength(0);
    // El gasto ligado se busca por inventario_movimiento_id.
    expect(de(llamadas, 'gasto', 'eq')[0].args).toEqual([
      'inventario_movimiento_id',
      'mv-1',
    ]);
  });

  it('replay de una salida para toda la flota: gasto_generado prorrateado a partir de los N gastos ligados', async () => {
    const { service } = armar({
      inventario_movimiento: [
        {
          data: {
            ...MOV,
            aeronave_id: null,
            para_flota: true,
            client_request_id: KEY,
            empaque: null,
          },
          error: null,
        },
        CARDEX,
        SIN_MAS,
      ],
      gasto: [
        {
          data: [
            { id: 'g-1', monto: 10, moneda: 'USD', categoria: 'REFACCION' },
            { id: 'g-2', monto: 10, moneda: 'USD', categoria: 'REFACCION' },
          ],
          error: null,
        },
      ],
    });
    const res = await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.SALIDA,
        cantidad: 2,
        para_flota: true,
        client_request_id: KEY,
      },
      'u-mec',
    );
    expect(res).toMatchObject({
      gasto_generado: {
        prorrateado: true,
        aviones: 2,
        monto_total: 20,
        gastos: 2,
      },
      idempotente: true,
    });
  });

  it('alta fresca (ENTRADA) con llave: insert CON client_request_id y respuesta idempotente:false', async () => {
    const entrada = { ...MOV, id: 'mv-2', tipo: 'ENTRADA', cantidad: 5 };
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        { data: null, error: null }, // pre-check
        { data: entrada, error: null }, // insert
        CARDEX, // stock
        SIN_MAS,
      ],
    });
    const res = await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.ENTRADA,
        cantidad: 5,
        moneda: 'USD',
        costo_unitario_usd: 10,
        client_request_id: KEY,
      },
      'u-mec',
    );
    expect(res).toMatchObject({
      id: 'mv-2',
      client_request_id: KEY,
      idempotente: false,
    });
    const insert = de(llamadas, 'inventario_movimiento', 'insert')[0]
      .args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      item_id: 'i-1',
      tipo: 'ENTRADA',
      cantidad: 5,
      client_request_id: KEY,
    });
  });

  it('carrera: 23505 sobre uq_inv_movimiento_client_request → relee y devuelve el existente (idempotente:true)', async () => {
    const entrada = { ...MOV, id: 'mv-2', tipo: 'ENTRADA', cantidad: 5 };
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        { data: null, error: null }, // pre-check
        {
          data: null,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "uq_inv_movimiento_client_request"',
          },
        },
        {
          data: {
            ...entrada,
            para_flota: false,
            client_request_id: KEY,
            empaque: null,
          },
          error: null,
        }, // relectura
        CARDEX,
        SIN_MAS,
      ],
      gasto: [{ data: [], error: null }],
    });
    const res = await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.ENTRADA,
        cantidad: 5,
        moneda: 'USD',
        costo_unitario_usd: 10,
        client_request_id: KEY,
      },
      'u-mec',
    );
    expect(res).toMatchObject({
      id: 'mv-2',
      gasto_generado: null,
      idempotente: true,
    });
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(0);
  });

  it('llave usada en OTRO producto: 23505 y la relectura acotada al ítem no encuentra → 409 CLIENT_REQUEST_ID_EN_USO (nunca 500 ni el movimiento ajeno)', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        { data: null, error: null }, // pre-check acotado al ítem
        {
          data: null,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "uq_inv_movimiento_client_request"',
          },
        },
        { data: null, error: null }, // relectura acotada: nada en este ítem
      ],
    });
    let err: unknown;
    try {
      await service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.ENTRADA,
          cantidad: 5,
          moneda: 'USD',
          costo_unitario_usd: 10,
          client_request_id: KEY,
        },
        'u-mec',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error: 'CLIENT_REQUEST_ID_EN_USO',
      details: { client_request_id: KEY },
    });
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(0);
    // Pre-check y relectura acotan por ítem, no solo por llave.
    const porItem = de(llamadas, 'inventario_movimiento', 'eq').filter(
      (l) => l.args[0] === 'item_id' && l.args[1] === 'i-1',
    );
    expect(porItem).toHaveLength(2);
  });

  it('columna ausente: sin pre-check, insert SIN la llave, client_request_id null (alta de siempre)', async () => {
    const entrada = { ...MOV, id: 'mv-2', tipo: 'ENTRADA', cantidad: 5 };
    const { service, llamadas } = armar(
      {
        inventario_item: [{ data: ITEM, error: null }],
        inventario_movimiento: [
          { data: entrada, error: null }, // insert
          CARDEX,
          SIN_MAS,
        ],
      },
      false,
    );
    const res = await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.ENTRADA,
        cantidad: 5,
        moneda: 'USD',
        costo_unitario_usd: 10,
        client_request_id: KEY,
      },
      'u-mec',
    );
    expect(res).toMatchObject({
      id: 'mv-2',
      client_request_id: null,
      idempotente: false,
    });
    const insert = de(llamadas, 'inventario_movimiento', 'insert')[0]
      .args[0] as Record<string, unknown>;
    expect(insert).not.toHaveProperty('client_request_id');
    expect(
      de(llamadas, 'inventario_movimiento', 'eq').filter(
        (l) => l.args[0] === 'client_request_id',
      ),
    ).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
