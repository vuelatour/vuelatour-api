jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
// notifications (aviso de baja de cardex, 21-sep) arrastra el gateway y
// `jose` (ESM), que jest no parsea.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InventoryService, MIGRACION_SALIDA_FLOTA } from './inventory.service';
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

/**
 * 22-sep-2026 · SALIDA «para todas las matrículas» contra una base SIN la
 * migración 20260922000003: el CHECK sin nombre de `20260515000004`
 * («toda SALIDA lleva avión») rechaza el INSERT con 23514. Antes eso era un
 * `throw new Error` ⇒ 500 ⇒ el filtro lo traducía al genérico «Alguno de los
 * valores capturados no es válido para este registro» — el toast rojo que
 * reportó el cliente, sin decir que lo que falta es la migración.
 */
const ERROR_23514 = {
  code: '23514',
  message:
    'new row for relation "inventario_movimiento" violates check constraint "inventario_movimiento_check"',
};

describe('InventoryService.createMovimiento — 23514 del movimiento', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
    error.mockRestore();
  });

  it('salida para toda la flota sin la migración: 503 MIGRACION_PENDIENTE (no 500) y NADA escrito', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        CARDEX, // FIFO de la salida
        { data: null, error: ERROR_23514 }, // insert rechazado por el CHECK viejo
      ],
    });
    let err: unknown;
    try {
      await service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.SALIDA,
          cantidad: 2,
          para_flota: true,
        },
        'u-ofi',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const cuerpo = (err as ServiceUnavailableException).getResponse() as {
      message: string;
      error: string;
      details: { migracion: string; constraint: string | null };
    };
    expect(cuerpo.error).toBe('MIGRACION_PENDIENTE');
    expect(cuerpo.details).toEqual({
      migracion: MIGRACION_SALIDA_FLOTA,
      constraint: 'inventario_movimiento_check',
    });
    // El mensaje dice qué hacer mientras tanto (es-MX, para el operador).
    expect(cuerpo.message).toContain(MIGRACION_SALIDA_FLOTA);
    expect(cuerpo.message).toContain('por avión');
    // El INSERT del movimiento es lo que falla: ni gastos ni compensación.
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(0);
    expect(de(llamadas, 'inventario_movimiento', 'delete')).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('cualquier OTRO 23514 (salida por avión): 400 legible con el constraint en details, nunca 500', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        CARDEX,
        {
          data: null,
          error: {
            code: '23514',
            message:
              'new row for relation "inventario_movimiento" violates check constraint "inventario_movimiento_moneda_chk"',
          },
        },
      ],
    });
    let err: unknown;
    try {
      await service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.SALIDA,
          cantidad: 2,
          aeronave_id: 'a-1',
        },
        'u-ofi',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      error: 'MOVIMIENTO_INVALIDO',
      details: { constraint: 'inventario_movimiento_moneda_chk' },
    });
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(0);
    // No es un fallo del sistema: no se registra como error del servidor.
    expect(error).not.toHaveBeenCalled();
  });

  it('con la migración YA aplicada, un 23514 del check nuevo es 400 del dato — jamás un 503 que mande a aplicar lo que ya existe', async () => {
    const { service } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        CARDEX,
        {
          data: null,
          error: {
            code: '23514',
            message:
              'new row for relation "inventario_movimiento" violates check constraint "inventario_movimiento_para_flota_chk"',
          },
        },
      ],
    });
    let err: unknown;
    try {
      await service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.SALIDA,
          cantidad: 2,
          para_flota: true,
        },
        'u-ofi',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      error: 'MOVIMIENTO_INVALIDO',
      details: { constraint: 'inventario_movimiento_para_flota_chk' },
    });
  });

  it('mensaje sin nombre de constraint: constraint null, jamás uno inventado', async () => {
    const { service } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        CARDEX,
        {
          data: null,
          error: { code: '23514', message: 'check constraint violated' },
        },
      ],
    });
    let err: unknown;
    try {
      await service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.SALIDA,
          cantidad: 2,
          para_flota: true,
        },
        'u-ofi',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      error: 'MIGRACION_PENDIENTE',
      details: { migracion: MIGRACION_SALIDA_FLOTA, constraint: null },
    });
  });
});

/**
 * 22-sep-2026 · EL SEGUNDO CANDADO de la salida de flota (revisión
 * adversaria). Relajar el CHECK de `inventario_movimiento` NO alcanza: la
 * liga `gasto.inventario_movimiento_id` nació con índice ÚNICO
 * (`uq_gasto_inventario_movimiento`, `20260703000001`, cuando una salida
 * generaba UN gasto) y la flota crea N gastos con el MISMO movimiento ⇒ el
 * segundo renglón del lote choca con 23505. Verificado contra prod el
 * 22-sep-2026 con un INSERT REAL revertido: con los dos CHECK nuevos puestos,
 * el lote seguía muriendo con «duplicate key value violates unique constraint
 * "uq_gasto_inventario_movimiento"». La misma migración lo cambia por un
 * índice normal; mientras tanto el API lo trata como lo que es (falta la
 * migración), no como un duplicado del operador.
 */
const CARDEX_FLOTA = {
  data: [
    {
      id: 'mv-e1',
      tipo: 'ENTRADA',
      cantidad: 30,
      costo_unitario_usd: 10,
      moneda: 'USD',
      costo_unitario_mxn: null,
      tc_usd_mxn: null,
      fecha_movimiento: '2026-08-01',
      created_at: '2026-08-01T00:00:00+00:00',
    },
  ],
  error: null,
  count: 1,
};
/** La salida del reporte del cliente: 12 piezas a 21.25 USD = 255.00 USD. */
const MOV_FLOTA = {
  ...MOV,
  id: 'mv-flota',
  cantidad: 12,
  aeronave_id: null,
  venta_unitaria: 21.25,
  venta_moneda: 'USD',
  fecha_movimiento: '2026-09-01',
};
/** La flota activa de hoy en prod (7 aviones, ordenados por matrícula). */
const FLOTA_ACTIVA = {
  data: [
    { id: 'av-1', matricula: 'N4142R' },
    { id: 'av-2', matricula: 'N58BT' },
    { id: 'av-3', matricula: 'N621TX' },
    { id: 'av-4', matricula: 'N990GG' },
    { id: 'av-5', matricula: 'XA-VGV' },
    { id: 'av-6', matricula: 'XB-ANU' },
    { id: 'av-7', matricula: 'XB-PEV' },
  ],
  error: null,
};
const DTO_FLOTA = {
  tipo: TipoMovimientoInventario.SALIDA,
  cantidad: 12,
  para_flota: true,
  venta_unitaria: 21.25,
  venta_moneda: 'USD' as const,
};

describe('InventoryService.createMovimiento — salida de flota: los N gastos', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
    error.mockRestore();
  });

  it('camino feliz: UN gasto por avión activo, Σ EXACTA al centavo y el residuo en el primero', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        CARDEX_FLOTA, // FIFO de la salida
        { data: MOV_FLOTA, error: null }, // insert del movimiento
        CARDEX_FLOTA, // stock resultante
      ],
      aeronave: [FLOTA_ACTIVA],
      gasto: [
        {
          data: FLOTA_ACTIVA.data.map((a, i) => ({
            id: `g-${i + 1}`,
            monto: i === 0 ? 36.42 : 36.43,
            moneda: 'USD',
            categoria: 'REFACCION',
          })),
          error: null,
        },
      ],
    });
    const res = await service.createMovimiento('i-1', DTO_FLOTA, 'u-ofi');

    expect(res).toMatchObject({
      id: 'mv-flota',
      gasto_generado: {
        prorrateado: true,
        aviones: 7,
        monto_total: 255,
        gastos: 7,
      },
    });
    // El movimiento va SIN avión y marcado para la flota (lo que el CHECK
    // viejo rechazaba).
    const mov = de(llamadas, 'inventario_movimiento', 'insert')[0]
      .args[0] as Record<string, unknown>;
    expect(mov).toMatchObject({ para_flota: true, aeronave_id: null });

    // FIABILIDAD NUMÉRICA: 36.42 + 6 × 36.43 == 255.00, al centavo.
    const filas = de(llamadas, 'gasto', 'insert')[0].args[0] as Array<
      Record<string, unknown>
    >;
    expect(filas).toHaveLength(7);
    const montos = filas.map((f) => Number(f.monto));
    expect(montos[0]).toBe(36.42);
    expect(montos.slice(1)).toEqual([36.43, 36.43, 36.43, 36.43, 36.43, 36.43]);
    expect(Math.round(montos.reduce((s, m) => s + m, 0) * 100) / 100).toBe(255);
    expect(montos.every((m) => m > 0)).toBe(true);
    // Un avión distinto por gasto, todos ligados al MISMO movimiento.
    expect(new Set(filas.map((f) => f.aeronave_id)).size).toBe(7);
    for (const f of filas) {
      expect(f).toMatchObject({
        origen: 'SISTEMA',
        categoria: 'REFACCION',
        medio_pago: 'BODEGA',
        estatus_comprobante: 'SIN_COMPROBANTE',
        moneda: 'USD',
        inventario_movimiento_id: 'mv-flota',
        fecha_gasto: '2026-09-01',
      });
    }
    // Camino feliz: nada que compensar.
    expect(de(llamadas, 'inventario_movimiento', 'delete')).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
  });

  it('índice único todavía puesto (migración a medias): 503 MIGRACION_PENDIENTE, el movimiento se revierte y NADA queda escrito', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        CARDEX_FLOTA,
        { data: MOV_FLOTA, error: null }, // el CHECK ya lo deja entrar
        { data: null, error: null }, // compensación: delete del movimiento
      ],
      aeronave: [FLOTA_ACTIVA],
      gasto: [
        {
          data: null,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "uq_gasto_inventario_movimiento"',
          },
        },
      ],
    });
    let err: unknown;
    try {
      await service.createMovimiento('i-1', DTO_FLOTA, 'u-ofi');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const cuerpo = (err as ServiceUnavailableException).getResponse() as {
      message: string;
      error: string;
      details: { migracion: string; constraint: string; aviones: number };
    };
    expect(cuerpo.error).toBe('MIGRACION_PENDIENTE');
    expect(cuerpo.details).toEqual({
      migracion: MIGRACION_SALIDA_FLOTA,
      constraint: 'uq_gasto_inventario_movimiento',
      aviones: 7,
    });
    // El mensaje dice qué hacer mientras tanto, en es-MX y sin hablar de
    // «duplicados» (no hay ninguno que el operador pueda buscar).
    expect(cuerpo.message).toContain(MIGRACION_SALIDA_FLOTA);
    expect(cuerpo.message).toContain('por avión');
    expect(cuerpo.message).not.toContain('duplicad');
    // COMPENSACIÓN: el stock no baja sin su cargo.
    expect(de(llamadas, 'inventario_movimiento', 'delete')).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('otro 23505 del lote de gastos (no el índice de la liga): sigue siendo el error de siempre, no un 503 que mande a aplicar la migración', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        CARDEX_FLOTA,
        { data: MOV_FLOTA, error: null },
        { data: null, error: null },
      ],
      aeronave: [FLOTA_ACTIVA],
      gasto: [
        {
          data: null,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "uq_gasto_folio_ticket"',
          },
        },
      ],
    });
    await expect(
      service.createMovimiento('i-1', DTO_FLOTA, 'u-ofi'),
    ).rejects.toThrow(/se revirtió/);
    expect(de(llamadas, 'inventario_movimiento', 'delete')).toHaveLength(1);
  });
});
