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

/** Marca de resultado: el insert devuelve su propio payload (eco) + un id. */
const ECO = '__ECO__';

function armar(
  tablas: Record<string, Resultado[]>,
  columnaLlave = true,
  configuracion?: {
    numero: (clave: string, porDefecto: number) => Promise<number>;
  },
  /** TipoCambioService falso (T.C. oficial por fecha); sin él ⇒ «sin T.C.». */
  tipoCambio?: {
    oficialDetallePara: (
      fecha: string,
    ) => Promise<{ tc: number; fecha_dato: string; fuente: string } | null>;
  },
) {
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
      // Sonda de la migración de ubicaciones (25-sep-2026): presente.
      if (
        cadena.length === 2 &&
        cadena.some((l) => l.metodo === 'limit') &&
        sel?.args[0] === 'ubicacion_id'
      ) {
        return { data: [], error: null };
      }
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
      const r = siguiente(tabla);
      if (r.data === ECO) {
        const ins = cadena.find((l) => l.metodo === 'insert')?.args[0];
        const base = Array.isArray(ins) ? ins : [ins];
        const filas = base.map((f, i) => ({
          id: `${tabla}-eco-${i + 1}`,
          created_at: '2026-09-25T15:00:00+00:00',
          ...(f as Record<string, unknown>),
        }));
        return { data: Array.isArray(ins) ? filas : filas[0], error: null };
      }
      return r;
    };
    q.maybeSingle = () => Promise.resolve(resolver());
    q.then = (
      resolve: (v: Resultado) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(resolver()).then(resolve, reject);
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  return {
    service: new InventoryService(
      supabase,
      {} as never,
      undefined,
      configuracion as never,
      tipoCambio as never,
    ),
    llamadas,
  };
}

/** T.C. oficial por fecha (el de las cotizaciones); fecha sin dato ⇒ null. */
function tcPorFecha(tabla: Record<string, number>) {
  const oficialDetallePara = jest.fn((fecha: string) =>
    Promise.resolve(
      tabla[fecha] != null
        ? { tc: tabla[fecha], fecha_dato: fecha, fuente: 'OPEN_ER_API' }
        : null,
    ),
  );
  return { oficialDetallePara };
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
      // El replay NO recalcula precio ni margen (25-sep-2026).
      venta_origen: null,
      margen_pct: null,
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
      // Desde el 27-nov-2026 los aviones del reparto se leen ANTES del insert.
      aeronave: [FLOTA_ACTIVA],
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
      aeronave: [FLOTA_ACTIVA],
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
      aeronave: [FLOTA_ACTIVA],
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

/**
 * 25-sep-2026 · TIENDA VuelaTour: toda SALIDA a un avión SIN precio se cobra
 * al ÚLTIMO PRECIO DE COMPRA + margen (`inventario_margen_venta_pct`, 25 %;
 * antes del API 0.0.36, costo FIFO), en la moneda de esa compra. El precio
 * capturado (> 0) y el del producto siguen ganando; el 0 explícito sigue
 * siendo «a costo».
 */
describe('InventoryService.createMovimiento — margen de la tienda', () => {
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

  /** Carga VTF-INV-001: 120 × 21.25 USD sin TC. */
  const CARDEX_USD = {
    data: [
      {
        id: 'e-usd',
        tipo: 'ENTRADA',
        cantidad: 120,
        costo_unitario_usd: 21.25,
        moneda: 'USD',
        costo_unitario_mxn: null,
        tc_usd_mxn: null,
        fecha_movimiento: '2026-08-29',
        created_at: '2026-08-29T17:36:43+00:00',
      },
    ],
    error: null,
    count: 1,
  };
  /** Una capa comprada en PESOS: 30 × $1,658.33 MXN a TC 17.51. */
  const CARDEX_MXN = {
    data: [
      {
        id: 'e-mxn',
        tipo: 'ENTRADA',
        cantidad: 30,
        costo_unitario_usd: 94.71,
        moneda: 'MXN',
        costo_unitario_mxn: 1658.33,
        tc_usd_mxn: 17.51,
        fecha_movimiento: '2026-07-13',
        created_at: '2026-07-13T15:37:31+00:00',
      },
    ],
    error: null,
    count: 1,
  };
  const SALIDA_12 = {
    tipo: TipoMovimientoInventario.SALIDA,
    cantidad: 12,
    aeronave_id: 'a-xavgv',
  };
  const salida = (
    cardex: Resultado,
    item: Record<string, unknown> = ITEM,
    configuracion?: {
      numero: (clave: string, porDefecto: number) => Promise<number>;
    },
  ) =>
    armar(
      {
        inventario_item: [{ data: item, error: null }],
        inventario_movimiento: [
          cardex, // FIFO de la salida
          { data: ECO, error: null }, // insert (eco del payload)
          cardex, // stock resultante
        ],
        gasto: [{ data: ECO, error: null }],
      },
      true,
      configuracion,
    );
  const insertDe = (llamadas: Llamada[], tabla: string) =>
    de(llamadas, tabla, 'insert')[0].args[0] as Record<string, unknown>;

  it('sin precio ⇒ último precio + 25 % en la moneda de la compra (USD, sin TipoCambioService): 12 × 26.5625 = 318.75 USD', async () => {
    const { service, llamadas } = salida(CARDEX_USD);
    const res = await service.createMovimiento('i-1', SALIDA_12, 'u-ofi');
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      tipo: 'SALIDA',
      cantidad: 12,
      costo_unitario_usd: 21.25,
      moneda: 'USD',
      venta_unitaria: 26.5625,
      venta_moneda: 'USD',
    });
    const gasto = insertDe(llamadas, 'gasto');
    expect(gasto).toMatchObject({
      categoria: 'REFACCION',
      medio_pago: 'BODEGA',
      monto: 318.75,
      moneda: 'USD',
      tc_gasto: null,
    });
    expect(String(gasto.notas)).toContain('(último precio + 25 %)');
    expect(String(gasto.notas)).not.toContain('FIFO');
    expect(res).toMatchObject({
      venta_origen: 'MARGEN',
      margen_pct: 25,
      tc_venta: null,
      aviso: null,
      regla_costo: 'ULTIMO_PRECIO',
      costo_vigente: { movimiento_id: 'e-usd', unitario: 21.25, moneda: 'USD' },
    });
  });

  it('config AUSENTE (fila sin sembrar) ⇒ 25 % por default', async () => {
    const numero = jest.fn((_c: string, porDefecto: number) =>
      Promise.resolve(porDefecto),
    );
    const { service, llamadas } = salida(CARDEX_USD, ITEM, { numero });
    const res = await service.createMovimiento('i-1', SALIDA_12, 'u-ofi');
    expect(numero).toHaveBeenCalledWith('inventario_margen_venta_pct', 25);
    expect(insertDe(llamadas, 'gasto')).toMatchObject({ monto: 318.75 });
    expect(res).toMatchObject({ venta_origen: 'MARGEN', margen_pct: 25 });
  });

  it('config 12.5 ⇒ ese margen; config fuera de rango ⇒ 25', async () => {
    const r1 = salida(CARDEX_USD, ITEM, {
      numero: () => Promise.resolve(12.5),
    });
    const a = await r1.service.createMovimiento('i-1', SALIDA_12, 'u-ofi');
    // 21.25 × 1.125 = 23.90625 → 23.9063 (4 dec) × 12 = 286.8756 → 286.88
    expect(insertDe(r1.llamadas, 'inventario_movimiento')).toMatchObject({
      venta_unitaria: 23.9063,
    });
    expect(insertDe(r1.llamadas, 'gasto')).toMatchObject({ monto: 286.88 });
    expect(a).toMatchObject({ margen_pct: 12.5 });
    const r2 = salida(CARDEX_USD, ITEM, { numero: () => Promise.resolve(400) });
    await r2.service.createMovimiento('i-1', SALIDA_12, 'u-ofi');
    expect(insertDe(r2.llamadas, 'gasto')).toMatchObject({ monto: 318.75 });
  });

  it('config 0 ⇒ a costo (sin venta, sin utilidad)', async () => {
    const { service, llamadas } = salida(CARDEX_USD, ITEM, {
      numero: () => Promise.resolve(0),
    });
    const res = await service.createMovimiento('i-1', SALIDA_12, 'u-ofi');
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      venta_unitaria: null,
      venta_moneda: null,
    });
    const gasto = insertDe(llamadas, 'gasto');
    expect(gasto).toMatchObject({ monto: 255, moneda: 'USD' });
    expect(String(gasto.notas)).toContain('(a costo)');
    expect(res).toMatchObject({ venta_origen: 'A_COSTO', margen_pct: null });
  });

  it('DTO 0 explícito ⇒ a costo aunque haya margen', async () => {
    const { service, llamadas } = salida(CARDEX_USD);
    const res = await service.createMovimiento(
      'i-1',
      { ...SALIDA_12, venta_unitaria: 0 },
      'u-ofi',
    );
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      venta_unitaria: null,
    });
    expect(insertDe(llamadas, 'gasto')).toMatchObject({ monto: 255 });
    expect(res).toMatchObject({ venta_origen: 'A_COSTO', margen_pct: null });
  });

  it('el precio del PRODUCTO gana al margen (con su moneda)', async () => {
    const { service, llamadas } = salida(CARDEX_USD, {
      ...ITEM,
      precio_venta: 450,
      precio_venta_moneda: 'MXN',
    });
    const res = await service.createMovimiento('i-1', SALIDA_12, 'u-ofi');
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      venta_unitaria: 450,
      venta_moneda: 'MXN',
    });
    const gasto = insertDe(llamadas, 'gasto');
    expect(gasto).toMatchObject({ monto: 5400, moneda: 'MXN' });
    expect(String(gasto.notas)).toContain('(precio de venta)');
    expect(res).toMatchObject({
      venta_origen: 'PRECIO_PRODUCTO',
      margen_pct: null,
    });
  });

  it('el precio CAPTURADO gana a todo', async () => {
    const { service, llamadas } = salida(CARDEX_USD, {
      ...ITEM,
      precio_venta: 450,
      precio_venta_moneda: 'MXN',
    });
    const res = await service.createMovimiento(
      'i-1',
      { ...SALIDA_12, venta_unitaria: 30, venta_moneda: 'USD' },
      'u-ofi',
    );
    expect(insertDe(llamadas, 'gasto')).toMatchObject({
      monto: 360,
      moneda: 'USD',
    });
    expect(res).toMatchObject({ venta_origen: 'PRECIO_CAPTURADO' });
  });

  it('compra vigente en PESOS ⇒ el margen va en PESOS: 4 × 2,072.9125 = 8,291.65 MXN (tc_gasto null sin T.C. oficial)', async () => {
    const { service, llamadas } = salida(CARDEX_MXN);
    const res = await service.createMovimiento(
      'i-1',
      { ...SALIDA_12, cantidad: 4 },
      'u-ofi',
    );
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      moneda: 'MXN',
      costo_unitario_mxn: 1658.33,
      venta_unitaria: 2072.9125,
      venta_moneda: 'MXN',
    });
    expect(insertDe(llamadas, 'gasto')).toMatchObject({
      monto: 8291.65,
      moneda: 'MXN',
      // API 0.0.36: el T.C. del gasto es el oficial del día de la VENTA (sin
      // TipoCambioService, ninguno); ya no el ponderado de las capas.
      tc_gasto: null,
    });
    expect(res).toMatchObject({ venta_origen: 'MARGEN', margen_pct: 25 });
  });

  it('para toda la flota ⇒ el TOTAL con margen se prorratea al centavo (residuo en el primero)', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        CARDEX_USD,
        { data: ECO, error: null },
        CARDEX_USD,
      ],
      aeronave: [FLOTA_ACTIVA],
      gasto: [{ data: ECO, error: null }],
    });
    const res = await service.createMovimiento(
      'i-1',
      { tipo: TipoMovimientoInventario.SALIDA, cantidad: 12, para_flota: true },
      'u-ofi',
    );
    const filas = de(llamadas, 'gasto', 'insert')[0].args[0] as Array<
      Record<string, unknown>
    >;
    expect(filas).toHaveLength(7);
    const montos = filas.map((f) => Number(f.monto));
    // 318.75 / 7 = 45.5357… → 45.54 × 6 = 273.24; primero = 318.75 − 273.24 = 45.51
    expect(montos[0]).toBe(45.51);
    expect(montos.slice(1)).toEqual([45.54, 45.54, 45.54, 45.54, 45.54, 45.54]);
    expect(Math.round(montos.reduce((s, m) => s + m, 0) * 100) / 100).toBe(
      318.75,
    );
    expect(String(filas[0].notas)).toContain('último precio + 25 %');
    expect(res).toMatchObject({
      venta_origen: 'MARGEN',
      margen_pct: 25,
      gasto_generado: { prorrateado: true, aviones: 7, monto_total: 318.75 },
    });
  });

  it('ENTRADA: sin venta_origen ni margen', async () => {
    const { service } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [{ data: ECO, error: null }, CARDEX_USD],
    });
    const res = await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.ENTRADA,
        cantidad: 5,
        moneda: 'USD',
        costo_unitario_usd: 10,
      },
      'u-ofi',
    );
    expect(res).toMatchObject({ venta_origen: null, margen_pct: null });
  });
});

/**
 * 25-sep-2026 · API 0.0.36 — ÚLTIMO PRECIO DE COMPRA + T.C. OFICIAL DEL DÍA
 * al ESCRIBIR. Pedido del cliente: «que los precios se ajusten en automático
 * al último registrado» y «En el tipo de cambio, que sea los mismos que usan
 * en las cotizaciones (Tipo de cambio del día de la venta)».
 */
describe('InventoryService.createMovimiento — último precio y T.C. oficial', () => {
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

  const fila = (
    id: string,
    tipo: 'ENTRADA' | 'SALIDA',
    cantidad: number,
    costo: number,
    fecha: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    tipo,
    cantidad,
    costo_unitario_usd: costo,
    moneda: 'USD',
    costo_unitario_mxn: null,
    tc_usd_mxn: 17,
    fecha_movimiento: fecha,
    created_at: `${fecha}T15:00:00+00:00`,
    ...extra,
  });
  /** El ejemplo del cliente: 10 @ 21 USD, salen 5, entran 5 @ 30 USD. */
  const EJEMPLO = {
    data: [
      fila('e1', 'ENTRADA', 10, 21, '2026-08-10'),
      fila('s1', 'SALIDA', 5, 21, '2026-08-15'),
      fila('e2', 'ENTRADA', 5, 30, '2026-09-05'),
    ],
    error: null,
    count: 3,
  };
  const TC = tcPorFecha({
    '2026-09-01': 17.0077,
    '2026-09-25': 17.6729,
    '2026-08-29': 17.0115,
  });
  const insertDe = (llamadas: Llamada[], tabla: string) =>
    de(llamadas, tabla, 'insert')[0]?.args[0] as Record<string, unknown>;

  it('SALIDA con dos precios distintos cobra el ÚLTIMO (FIFO habría cobrado 21): 1 × 37.50 USD, T.C. del día de la venta', async () => {
    const tc = tcPorFecha({ '2026-09-25': 17.6729 });
    const { service, llamadas } = armar(
      {
        inventario_item: [{ data: ITEM, error: null }],
        inventario_movimiento: [EJEMPLO, { data: ECO, error: null }, EJEMPLO],
        gasto: [{ data: ECO, error: null }],
      },
      true,
      undefined,
      tc,
    );
    const res = await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.SALIDA,
        cantidad: 1,
        aeronave_id: 'a-xavgv',
        fecha_movimiento: '2026-09-25',
      },
      'u-ofi',
    );
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      costo_unitario_usd: 30,
      moneda: 'USD',
      costo_unitario_mxn: null,
      tc_usd_mxn: 17.6729,
      venta_unitaria: 37.5,
      venta_moneda: 'USD',
    });
    expect(insertDe(llamadas, 'gasto')).toMatchObject({
      monto: 37.5,
      moneda: 'USD',
      tc_gasto: 17.6729,
    });
    expect(res).toMatchObject({
      costo_vigente: { movimiento_id: 'e2', unitario: 30 },
      tc_venta: 17.6729,
      venta_origen: 'MARGEN',
    });
    expect(tc.oficialDetallePara).toHaveBeenCalledWith('2026-09-25');
  });

  it('SALIDA con fecha ATRASADA ⇒ el costo vigente Y el T.C. de ESA fecha', async () => {
    const { service, llamadas } = armar(
      {
        inventario_item: [{ data: ITEM, error: null }],
        inventario_movimiento: [EJEMPLO, { data: ECO, error: null }, EJEMPLO],
        gasto: [{ data: ECO, error: null }],
      },
      true,
      undefined,
      TC,
    );
    await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.SALIDA,
        cantidad: 1,
        aeronave_id: 'a-xavgv',
        fecha_movimiento: '2026-09-01',
      },
      'u-ofi',
    );
    // El 01-sep el último precio era el de agosto (21) y el T.C. el del 01-sep.
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      costo_unitario_usd: 21,
      tc_usd_mxn: 17.0077,
      venta_unitaria: 26.25,
    });
  });

  it('SALIDA anterior a TODA compra con costo ⇒ 400 SALIDA_ANTES_DE_LA_COMPRA y NADA escrito', async () => {
    const { service, llamadas } = armar(
      {
        inventario_item: [{ data: ITEM, error: null }],
        inventario_movimiento: [EJEMPLO],
      },
      true,
      undefined,
      TC,
    );
    const err = await service
      .createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.SALIDA,
          cantidad: 1,
          aeronave_id: 'a-xavgv',
          fecha_movimiento: '2026-08-01',
        },
        'u-ofi',
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      error: 'SALIDA_ANTES_DE_LA_COMPRA',
      message:
        'La salida es del 1 ago 2026 y la primera compra con costo de este producto es del 10 ago 2026: corrige la fecha de la salida o captura antes la compra.',
    });
    expect(de(llamadas, 'inventario_movimiento', 'insert')).toHaveLength(0);
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(0);
  });

  it('sin ninguna compra con costo (solo entradas a $0) ⇒ a costo $0, sin gasto, con aviso SIN_COSTO_VIGENTE', async () => {
    const soloCero = {
      data: [fila('e0', 'ENTRADA', 3, 0, '2026-08-29', { tc_usd_mxn: null })],
      error: null,
      count: 1,
    };
    const { service, llamadas } = armar(
      {
        inventario_item: [{ data: ITEM, error: null }],
        inventario_movimiento: [soloCero, { data: ECO, error: null }, soloCero],
      },
      true,
      undefined,
      TC,
    );
    const res = await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.SALIDA,
        cantidad: 1,
        aeronave_id: 'a-xavgv',
        fecha_movimiento: '2026-09-01',
      },
      'u-ofi',
    );
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      costo_unitario_usd: 0,
      venta_unitaria: null,
    });
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(0);
    expect(res).toMatchObject({
      aviso: 'SIN_COSTO_VIGENTE',
      costo_vigente: null,
      gasto_generado: null,
    });
    const msg = String((res as { aviso_mensaje: string }).aviso_mensaje);
    expect(msg).toContain('no tiene ninguna compra con costo');
    expect(msg).toContain('sin cargo al avión');
    // El costo queda congelado en la fila: completar la compra NO la cobra
    // (revisión adversaria 25-sep-2026).
    expect(msg).toContain('esta se queda sin cargo');
  });

  it('sin compra con costo pero CON precio capturado ⇒ sí hay cargo al avión y el aviso NO dice «sin cargo»', async () => {
    const soloCero = {
      data: [fila('e0', 'ENTRADA', 3, 0, '2026-08-29', { tc_usd_mxn: null })],
      error: null,
      count: 1,
    };
    const { service, llamadas } = armar(
      {
        inventario_item: [{ data: ITEM, error: null }],
        inventario_movimiento: [soloCero, { data: ECO, error: null }, soloCero],
        gasto: [{ data: ECO, error: null }],
      },
      true,
      undefined,
      TC,
    );
    const res = await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.SALIDA,
        cantidad: 1,
        aeronave_id: 'a-xavgv',
        fecha_movimiento: '2026-09-01',
        venta_unitaria: 50,
        venta_moneda: 'USD',
      },
      'u-ofi',
    );
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      costo_unitario_usd: 0,
      venta_unitaria: 50,
      venta_moneda: 'USD',
    });
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(1);
    expect(insertDe(llamadas, 'gasto')).toMatchObject({
      monto: 50,
      moneda: 'USD',
      tc_gasto: 17.0077,
    });
    expect(res).toMatchObject({
      aviso: 'SIN_COSTO_VIGENTE',
      venta_origen: 'PRECIO_CAPTURADO',
    });
    const msg = String((res as { aviso_mensaje: string }).aviso_mensaje);
    expect(msg).toContain('no tiene ninguna compra con costo');
    expect(msg).toContain('se le cobró su precio de venta');
    expect(msg).not.toContain('sin cargo al avión');
  });

  it('ENTRADA en USD sin T.C. ⇒ el oficial de SU fecha; con T.C. capturado ⇒ ese (4 decimales)', async () => {
    const correr = async (dto: Record<string, unknown>) => {
      const { service, llamadas } = armar(
        {
          inventario_item: [{ data: ITEM, error: null }],
          inventario_movimiento: [{ data: ECO, error: null }, EJEMPLO],
        },
        true,
        undefined,
        TC,
      );
      await service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.ENTRADA,
          cantidad: 5,
          moneda: 'USD',
          costo_unitario_usd: 21.25,
          fecha_movimiento: '2026-08-29',
          ...dto,
        },
        'u-ofi',
      );
      return insertDe(llamadas, 'inventario_movimiento');
    };
    expect(await correr({})).toMatchObject({ tc_usd_mxn: 17.0115 });
    expect(await correr({ tc_usd_mxn: 17.123456 })).toMatchObject({
      tc_usd_mxn: 17.1235,
    });
  });

  it('ENTRADA en PESOS sin T.C. ⇒ el oficial del día de la compra; sin oficial ⇒ 400 y nada escrito', async () => {
    const { service, llamadas } = armar(
      {
        inventario_item: [{ data: ITEM, error: null }],
        inventario_movimiento: [{ data: ECO, error: null }, EJEMPLO],
      },
      true,
      undefined,
      TC,
    );
    await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.ENTRADA,
        cantidad: 2,
        moneda: 'MXN',
        costo_unitario_mxn: 350,
        fecha_movimiento: '2026-09-01',
      },
      'u-ofi',
    );
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      moneda: 'MXN',
      costo_unitario_mxn: 350,
      tc_usd_mxn: 17.0077,
      costo_unitario_usd: 20.5789, // round4(350 / 17.0077)
    });

    const sinDato = armar(
      { inventario_item: [{ data: ITEM, error: null }] },
      true,
      undefined,
      TC,
    );
    await expect(
      sinDato.service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.ENTRADA,
          cantidad: 2,
          moneda: 'MXN',
          costo_unitario_mxn: 350,
          fecha_movimiento: '2025-01-01',
        },
        'u-ofi',
      ),
    ).rejects.toThrow(/No hay T\.C\. oficial para esa fecha/);
    expect(
      de(sinDato.llamadas, 'inventario_movimiento', 'insert'),
    ).toHaveLength(0);
  });

  it('SIN TipoCambioService (clientes/specs viejos): todo igual, T.C. en null', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [{ data: ECO, error: null }, EJEMPLO],
    });
    await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.ENTRADA,
        cantidad: 5,
        moneda: 'USD',
        costo_unitario_usd: 21.25,
      },
      'u-ofi',
    );
    expect(insertDe(llamadas, 'inventario_movimiento')).toMatchObject({
      tc_usd_mxn: null,
    });
  });

  it('el T.C. oficial se pide UNA vez por fecha (memo): alta masiva / recepción de compras', async () => {
    const tc = tcPorFecha({ '2026-08-29': 17.0115 });
    const { service } = armar(
      {
        inventario_item: [{ data: ITEM, error: null }],
        inventario_movimiento: [{ data: ECO, error: null }, EJEMPLO],
      },
      true,
      undefined,
      tc,
    );
    for (let i = 0; i < 3; i++) {
      await service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.ENTRADA,
          cantidad: 1,
          moneda: 'USD',
          costo_unitario_usd: 10,
          fecha_movimiento: '2026-08-29',
        },
        'u-ofi',
      );
    }
    expect(tc.oficialDetallePara).toHaveBeenCalledTimes(1);
    expect(await service.tcOficialDe('2026-08-29')).toMatchObject({
      tc: 17.0115,
    });
  });
});

/**
 * «Editar costo» de una ENTRADA con la regla del último precio (D1-bis / D7):
 * ya no hay candado de «capa consumida»; las salidas que se cobraron con el
 * precio CONSERVAN su costo y el API exige reconocerlo (`confirmar_salidas`).
 */
describe('InventoryService.updateCostoEntrada — último precio y reconocimiento', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const ENTRADA = {
    id: 'e1',
    item_id: 'i-1',
    tipo: 'ENTRADA',
    cantidad: 10,
    costo_unitario_usd: 21.25,
    moneda: 'USD',
    costo_unitario_mxn: null,
    tc_usd_mxn: 17.0115,
    venta_unitaria: null,
    venta_moneda: null,
    fecha_movimiento: '2026-08-29',
    created_at: '2026-08-29T17:36:43+00:00',
    notas: null,
  };
  const SALIDA = {
    ...ENTRADA,
    id: 's1',
    tipo: 'SALIDA',
    cantidad: 4,
    tc_usd_mxn: 17.0077,
    venta_unitaria: 26.5625,
    venta_moneda: 'USD',
    fecha_movimiento: '2026-09-01',
    created_at: '2026-09-22T14:13:06+00:00',
    aeronave: { matricula: 'XA-VGV' },
  };
  const conSalida = { data: [ENTRADA, SALIDA], error: null, count: 2 };
  const sinSalida = { data: [ENTRADA], error: null, count: 1 };
  const DTO = { moneda: 'USD' as const, costo_unitario_usd: 23 };

  const correr = (
    cardex: Resultado,
    tc = tcPorFecha({ '2026-08-29': 17.0115 }),
  ) =>
    armar(
      {
        inventario_movimiento: [
          { data: ENTRADA, error: null }, // el movimiento
          cardex, // cardex completo (dependientes)
          { data: { ...ENTRADA, costo_unitario_usd: 23 }, error: null }, // update
          cardex, // stats
        ],
        compra_linea: [{ data: null, error: null }],
      },
      true,
      undefined,
      tc,
    );

  it('CON salidas que usaron el precio y sin confirmar ⇒ 409 ENTRADA_CON_SALIDAS con la lista, y la fila NO cambia', async () => {
    const { service, llamadas } = correr(conSalida);
    const err = await service
      .updateCostoEntrada('i-1', 'e1', DTO, 'u-ofi')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error: 'ENTRADA_CON_SALIDAS',
      message:
        'Este precio ya se usó en 1 salida(s) (conservan su costo; 0 sin cargo). Confirma para guardar el precio nuevo: aplica a la existencia y a las siguientes salidas.',
      details: {
        salidas: [
          {
            id: 's1',
            fecha: '2026-09-01',
            cantidad: 4,
            costo_unitario: 21.25,
            moneda: 'USD',
            sin_cargo: false,
            vendido_a: 'XA-VGV',
          },
        ],
      },
    });
    expect(de(llamadas, 'inventario_movimiento', 'update')).toHaveLength(0);
  });

  it('con confirmar_salidas: true ⇒ se guarda (ya no hay 409 de «capa consumida») y responde qué salidas conservan su costo', async () => {
    const { service, llamadas } = correr(conSalida);
    const res = await service.updateCostoEntrada(
      'i-1',
      'e1',
      { ...DTO, confirmar_salidas: true },
      'u-ofi',
    );
    expect(de(llamadas, 'inventario_movimiento', 'update')).toHaveLength(1);
    expect(
      de(llamadas, 'inventario_movimiento', 'update')[0].args[0],
    ).toMatchObject({
      costo_unitario_usd: 23,
      moneda: 'USD',
      // USD sin T.C. en el DTO: conserva el de la fila.
      tc_usd_mxn: 17.0115,
    });
    // Bitácora en notas con el dinero bien escrito (2–4 decimales + moneda).
    const notas = String(
      (
        de(llamadas, 'inventario_movimiento', 'update')[0].args[0] as {
          notas: string;
        }
      ).notas,
    );
    expect(notas).toMatch(
      /^Costo corregido \d{4}-\d{2}-\d{2}: antes \$21\.25 USD$/,
    );
    expect(res).toMatchObject({
      salidas_conservan_costo: [expect.objectContaining({ id: 's1' })],
      regla_costo: 'ULTIMO_PRECIO',
    });
  });

  it('la bitácora del costo anterior nunca escribe dinero con 1 decimal («$21.50 USD», no «$21.5 USD»)', async () => {
    const e = { ...ENTRADA, costo_unitario_usd: 21.5 };
    const cardex = { data: [e], error: null, count: 1 };
    const { service, llamadas } = armar(
      {
        inventario_movimiento: [
          { data: e, error: null },
          cardex,
          { data: { ...e, costo_unitario_usd: 23 }, error: null },
          cardex,
        ],
        compra_linea: [{ data: null, error: null }],
      },
      true,
      undefined,
      tcPorFecha({ '2026-08-29': 17.0115 }),
    );
    await service.updateCostoEntrada('i-1', 'e1', DTO, 'u-ofi');
    const upd = de(llamadas, 'inventario_movimiento', 'update')[0].args[0] as {
      notas: string;
    };
    expect(upd.notas).toMatch(/: antes \$21\.50 USD$/);
  });

  it('sin salidas dependientes ⇒ 200 sin necesidad del flag', async () => {
    const { service, llamadas } = correr(sinSalida);
    const res = await service.updateCostoEntrada('i-1', 'e1', DTO, 'u-ofi');
    expect(de(llamadas, 'inventario_movimiento', 'update')).toHaveLength(1);
    expect(res).toMatchObject({ salidas_conservan_costo: [] });
  });

  it('una SALIDA no se corrige aquí: 400 con el texto nuevo (sin «FIFO»)', async () => {
    const { service } = armar({
      inventario_movimiento: [{ data: SALIDA, error: null }],
    });
    const err = await service
      .updateCostoEntrada('i-1', 's1', DTO, 'u-ofi')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe(
      'Solo se corrige el costo de una ENTRADA: el de una salida es el que se cobró al avión, y las devoluciones/ajustes se corrigen con un movimiento nuevo.',
    );
    expect((err as Error).message).not.toContain('FIFO');
  });

  it('el candado de COMPRA sigue intacto', async () => {
    const { service, llamadas } = armar({
      inventario_movimiento: [{ data: ENTRADA, error: null }],
      compra_linea: [
        { data: { id: 'l-1', compra: { folio: 3 } }, error: null },
      ],
    });
    await expect(
      service.updateCostoEntrada('i-1', 'e1', DTO, 'u-ofi'),
    ).rejects.toThrow(/nace de la compra #3/);
    expect(de(llamadas, 'inventario_movimiento', 'update')).toHaveLength(0);
  });
});

/**
 * 27-nov-2026 · SALIDA PARA ALGUNAS MATRÍCULAS (invariante 146). Pedido de la
 * oficina (Jimmy): «necesito me den la opción de marcar algunas matrículas ya
 * que necesito poner solo 4 matrículas y no todas». `aeronave_ids` reparte el
 * cargo SOLO entre las elegidas; sin lista, toda la flota activa (como
 * siempre). Los aviones se resuelven y validan ANTES de escribir el cardex.
 */
describe('InventoryService.createMovimiento — salida para ALGUNAS matrículas', () => {
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

  /** Las 4 que pidió la oficina, en el orden en que PostgREST las devuelva. */
  const ELEGIDAS = {
    data: [
      { id: 'av-4', matricula: 'N990GG', activa: true },
      { id: 'av-1', matricula: 'N4142R', activa: true },
      { id: 'av-3', matricula: 'N621TX', activa: true },
      { id: 'av-2', matricula: 'N58BT', activa: true },
    ],
    error: null,
  };
  /** 1 pieza a $100.01: 4 partes de $25.00 y el centavo que sobra. */
  const MOV_4 = {
    ...MOV_FLOTA,
    id: 'mv-4',
    cantidad: 1,
    venta_unitaria: 100.01,
  };
  const DTO_4 = {
    tipo: TipoMovimientoInventario.SALIDA,
    cantidad: 1,
    para_flota: true,
    venta_unitaria: 100.01,
    venta_moneda: 'USD' as const,
    aeronave_ids: ['av-4', 'av-1', 'av-3', 'av-2'],
  };

  it('camino feliz: UN gasto por matrícula ELEGIDA (no por toda la flota), Σ exacta y el residuo en la primera', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        CARDEX_FLOTA,
        { data: MOV_4, error: null },
        CARDEX_FLOTA,
      ],
      aeronave: [ELEGIDAS],
      gasto: [
        {
          data: [1, 2, 3, 4].map((i) => ({
            id: `g-${i}`,
            monto: i === 1 ? 25.01 : 25,
            moneda: 'USD',
            categoria: 'REFACCION',
          })),
          error: null,
        },
      ],
    });
    const res = await service.createMovimiento('i-1', DTO_4, 'u-ofi');

    // Los aviones se piden POR ID (los elegidos), no «todos los activos».
    const lecturaAviones = de(llamadas, 'aeronave', 'in');
    expect(lecturaAviones).toHaveLength(1);
    expect(lecturaAviones[0].args).toEqual(['id', DTO_4.aeronave_ids]);

    // El movimiento guarda la lista, ORDENADA por matrícula (el orden del reparto).
    const mov = de(llamadas, 'inventario_movimiento', 'insert')[0]
      .args[0] as Record<string, unknown>;
    expect(mov).toMatchObject({
      para_flota: true,
      aeronave_id: null,
      aeronave_ids: ['av-1', 'av-2', 'av-3', 'av-4'],
    });

    // FIABILIDAD NUMÉRICA: 25.01 + 3 × 25.00 == 100.01, al centavo.
    const filas = de(llamadas, 'gasto', 'insert')[0].args[0] as Array<
      Record<string, unknown>
    >;
    expect(filas).toHaveLength(4);
    expect(filas.map((f) => f.aeronave_id)).toEqual([
      'av-1',
      'av-2',
      'av-3',
      'av-4',
    ]);
    const montos = filas.map((f) => Number(f.monto));
    expect(montos).toEqual([25.01, 25, 25, 25]);
    expect(Math.round(montos.reduce((s, m) => s + m, 0) * 100) / 100).toBe(
      100.01,
    );
    for (const f of filas) {
      expect(f).toMatchObject({
        categoria: 'REFACCION',
        medio_pago: 'BODEGA',
        inventario_movimiento_id: 'mv-4',
      });
      // La nota dice entre cuántas se repartió (nunca «toda la flota»).
      expect(String(f.notas)).toContain(
        'Salida de bodega (4 matrículas, 1/4 del precio de venta): 1 × Aceite W100',
      );
      expect(String(f.notas)).not.toContain('toda la flota');
    }

    expect(res).toMatchObject({
      id: 'mv-4',
      matriculas_flota: ['N4142R', 'N58BT', 'N621TX', 'N990GG'],
      gasto_generado: {
        prorrateado: true,
        aviones: 4,
        monto_total: 100.01,
        gastos: 4,
        matriculas: ['N4142R', 'N58BT', 'N621TX', 'N990GG'],
      },
    });
    expect(de(llamadas, 'inventario_movimiento', 'delete')).toHaveLength(0);
  });

  it('toda la flota (SIN lista) sigue igual: la fila no lleva aeronave_ids y la nota dice «toda la flota»', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        CARDEX_FLOTA,
        { data: MOV_FLOTA, error: null },
        CARDEX_FLOTA,
      ],
      aeronave: [FLOTA_ACTIVA],
      gasto: [{ data: [], error: null }],
    });
    const res = await service.createMovimiento('i-1', DTO_FLOTA, 'u-ofi');
    const mov = de(llamadas, 'inventario_movimiento', 'insert')[0]
      .args[0] as Record<string, unknown>;
    expect(mov).toMatchObject({ para_flota: true, aeronave_id: null });
    expect('aeronave_ids' in mov).toBe(false);
    const filas = de(llamadas, 'gasto', 'insert')[0].args[0] as Array<
      Record<string, unknown>
    >;
    expect(filas).toHaveLength(7);
    expect(String(filas[0].notas)).toContain(
      'Salida de bodega (toda la flota, 1/7 del precio de venta): 12 × Aceite W100',
    );
    expect(res).toMatchObject({ matriculas_flota: null });
  });

  it('una matrícula dada de BAJA en la lista: 400 MATRICULAS_INVALIDAS que la nombra y NADA escrito', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [CARDEX_FLOTA],
      aeronave: [
        {
          data: [
            { id: 'av-1', matricula: 'N4142R', activa: true },
            { id: 'av-9', matricula: 'XB-IJP', activa: false },
          ],
          error: null,
        },
      ],
    });
    const err = await service
      .createMovimiento(
        'i-1',
        { ...DTO_4, aeronave_ids: ['av-1', 'av-9'] },
        'u-ofi',
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      error: 'MATRICULAS_INVALIDAS',
      details: { aeronave_ids: ['av-9'] },
    });
    expect((err as Error).message).toContain('XB-IJP');
    expect((err as Error).message).toContain('está dada de baja');
    expect(de(llamadas, 'inventario_movimiento', 'insert')).toHaveLength(0);
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(0);
  });

  it('una matrícula que ya NO existe: 400 MATRICULAS_INVALIDAS y nada escrito', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      aeronave: [
        {
          data: [{ id: 'av-1', matricula: 'N4142R', activa: true }],
          error: null,
        },
      ],
    });
    const err = await service
      .createMovimiento(
        'i-1',
        { ...DTO_4, aeronave_ids: ['av-1', 'av-fantasma'] },
        'u-ofi',
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      error: 'MATRICULAS_INVALIDAS',
      details: { aeronave_ids: ['av-fantasma'] },
    });
    expect(de(llamadas, 'inventario_movimiento', 'insert')).toHaveLength(0);
  });

  it('la lista SIN «repartir» (para_flota) o en una ENTRADA: 400 MATRICULAS_SIN_REPARTO, sin leer ni escribir nada', async () => {
    for (const dto of [
      { ...DTO_4, para_flota: false, aeronave_id: 'av-1' },
      {
        tipo: TipoMovimientoInventario.ENTRADA,
        cantidad: 3,
        costo_unitario_usd: 10,
        aeronave_ids: ['av-1', 'av-2'],
      },
    ]) {
      const { service, llamadas } = armar({
        inventario_item: [{ data: ITEM, error: null }],
      });
      const err = await service
        .createMovimiento('i-1', dto, 'u-ofi')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        error: 'MATRICULAS_SIN_REPARTO',
      });
      expect(de(llamadas, 'aeronave', 'select')).toHaveLength(0);
      expect(de(llamadas, 'inventario_movimiento', 'insert')).toHaveLength(0);
    }
  });

  it('sin aviones activos y sin lista: 400 FLOTA_VACIA antes de escribir (ya no hay movimiento que revertir)', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      aeronave: [{ data: [], error: null }],
    });
    const err = await service
      .createMovimiento('i-1', DTO_FLOTA, 'u-ofi')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      error: 'FLOTA_VACIA',
    });
    expect(de(llamadas, 'inventario_movimiento', 'insert')).toHaveLength(0);
    expect(de(llamadas, 'inventario_movimiento', 'delete')).toHaveLength(0);
  });
});

/**
 * 27-nov-2026 · CORREGIR LA CANTIDAD DE UNA ENTRADA (invariante 146). Caso
 * real: la entrada del 30-oct del aceite 15W-50 se capturó con 13 y entraron
 * 12 («por error de dedo puse 13»). La regla numérica vive en
 * `corregir-cantidad.util` (con su spec); aquí, los candados del servicio y
 * QUÉ se escribe.
 */
describe('InventoryService.corregirCantidadEntrada', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const E13 = {
    ...MOV,
    id: 'e13',
    tipo: 'ENTRADA',
    cantidad: '13.00',
    aeronave_id: null,
    moneda: 'MXN',
    costo_unitario_mxn: 281.5,
    costo_unitario_usd: 15.091,
    tc_usd_mxn: 18.6535,
    fecha_movimiento: '2026-10-30',
    created_at: '2026-10-29T22:08:10+00:00',
    notas: null,
    para_flota: false,
    aeronave_ids: null,
  };
  const APERTURA = {
    ...E13,
    id: 'e0',
    cantidad: '168.00',
    fecha_movimiento: '2026-10-01',
    created_at: '2026-10-01T10:00:00+00:00',
  };
  const SALIDA_60 = {
    ...MOV,
    id: 's60',
    cantidad: '60.00',
    fecha_movimiento: '2026-11-26',
    created_at: '2026-11-26T18:24:54+00:00',
    para_flota: false,
    aeronave_ids: null,
  };
  const CARDEX_13 = {
    data: [APERTURA, E13, SALIDA_60],
    error: null,
    count: 3,
  };
  const cardexCon = (cantidad: string) => ({
    data: [APERTURA, { ...E13, cantidad }, SALIDA_60],
    error: null,
    count: 3,
  });

  it('13 → 12: actualiza SOLO la cantidad (CAS por la cantidad leída), deja la nota con quién/cuándo/antes y la existencia baja una pieza', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        { data: E13, error: null }, // movimientoDeItem
        CARDEX_13, // cardex completo (evaluación)
        { data: { ...E13, cantidad: '12.00' }, error: null }, // update
        cardexCon('12.00'), // stats después
      ],
      compra_linea: [{ data: null, error: null }],
      usuario: [{ data: { nombre: 'Jimmy Chi' }, error: null }],
    });
    const res = await service.corregirCantidadEntrada(
      'i-1',
      'e13',
      { cantidad: 12, motivo: 'Error de dedo' },
      'u-jimmy',
    );

    const upd = de(llamadas, 'inventario_movimiento', 'update');
    expect(upd).toHaveLength(1);
    const cambios = upd[0].args[0] as Record<string, unknown>;
    expect(cambios.cantidad).toBe(12);
    expect(cambios.updated_by).toBe('u-jimmy');
    expect(String(cambios.notas)).toMatch(
      /^Cantidad corregida \d{2}\/\d{2}\/\d{4} por Jimmy Chi: antes 13, ahora 12: Error de dedo$/,
    );
    // NI costo, NI fecha, NI tipo, NI empaque (no se capturó por empaque).
    expect(Object.keys(cambios).sort()).toEqual([
      'cantidad',
      'notas',
      'updated_by',
    ]);
    // CAS: el UPDATE va acotado a la cantidad que se evaluó.
    const eqs = de(llamadas, 'inventario_movimiento', 'eq').map((l) => l.args);
    expect(eqs).toContainEqual(['cantidad', '13.00']);

    expect(res).toMatchObject({
      id: 'e13',
      cantidad_antes: 13,
      cantidad_despues: 12,
      stock_antes: 121,
      stock_resultante: 120,
    });
    // Ningún gasto se toca: una entrada manual no lleva dinero.
    expect(de(llamadas, 'gasto', 'from')).toHaveLength(0);
  });

  it('una nota previa se CONSERVA y la corrección se agrega al final', async () => {
    const conNota = { ...E13, notas: 'Llegó con la factura 881' };
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        { data: conNota, error: null },
        { data: [APERTURA, conNota, SALIDA_60], error: null, count: 3 },
        { data: { ...conNota, cantidad: '12.00' }, error: null },
        cardexCon('12.00'),
      ],
      compra_linea: [{ data: null, error: null }],
      usuario: [{ data: null, error: null }],
    });
    await service.corregirCantidadEntrada(
      'i-1',
      'e13',
      { cantidad: 12 },
      'u-x',
    );
    const cambios = de(llamadas, 'inventario_movimiento', 'update')[0]
      .args[0] as Record<string, unknown>;
    // Sin nombre de usuario no se inventa quién.
    expect(String(cambios.notas)).toMatch(
      /^Llegó con la factura 881 · Cantidad corregida \d{2}\/\d{2}\/\d{4}: antes 13, ahora 12$/,
    );
  });

  it('capturada por EMPAQUE: el desglose («2 × Caja») se suelta y queda en la nota', async () => {
    const porCaja = {
      ...E13,
      cantidad: '24.00',
      empaque_id: 'emp-1',
      cantidad_empaques: '2.00',
      empaque: { nombre: 'Caja', factor: 12 },
      notas: '2 × Caja',
    };
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        { data: porCaja, error: null },
        { data: [APERTURA, porCaja, SALIDA_60], error: null, count: 3 },
        { data: { ...porCaja, cantidad: '23.00' }, error: null },
        {
          data: [APERTURA, { ...porCaja, cantidad: '23.00' }, SALIDA_60],
          error: null,
          count: 3,
        },
      ],
      compra_linea: [{ data: null, error: null }],
      usuario: [{ data: { nombre: 'Jimmy Chi' }, error: null }],
    });
    await service.corregirCantidadEntrada(
      'i-1',
      'e13',
      { cantidad: 23 },
      'u-jimmy',
    );
    const cambios = de(llamadas, 'inventario_movimiento', 'update')[0]
      .args[0] as Record<string, unknown>;
    expect(cambios).toMatchObject({
      cantidad: 23,
      empaque_id: null,
      cantidad_empaques: null,
    });
    expect(String(cambios.notas)).toContain('antes 24 (2 × Caja), ahora 23');
  });

  it('entrada que nace de una COMPRA: 409 MOVIMIENTO_DE_COMPRA y nada escrito', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [{ data: E13, error: null }],
      compra_linea: [
        { data: { id: 'l-1', compra: { folio: 14 } }, error: null },
      ],
    });
    const err = await service
      .corregirCantidadEntrada('i-1', 'e13', { cantidad: 12 }, 'u-x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error: 'MOVIMIENTO_DE_COMPRA',
    });
    expect((err as Error).message).toContain('compra #14');
    expect(de(llamadas, 'inventario_movimiento', 'update')).toHaveLength(0);
  });

  it('bajar más de lo que ya salió: 409 STOCK_NEGATIVO con lo mínimo que puede quedar, y nada escrito', async () => {
    // 5 entran y de ahí salen 5: la entrada no puede bajar de 5.
    const e5 = {
      ...E13,
      id: 'e5',
      cantidad: '5.00',
      fecha_movimiento: '2026-09-01',
      created_at: '2026-09-01T10:00:00+00:00',
    };
    const s5 = {
      ...SALIDA_60,
      id: 's5',
      cantidad: '5.00',
      fecha_movimiento: '2026-09-02',
      created_at: '2026-09-02T10:00:00+00:00',
    };
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        { data: e5, error: null },
        { data: [e5, s5, APERTURA], error: null, count: 3 },
      ],
      compra_linea: [{ data: null, error: null }],
    });
    const err = await service
      .corregirCantidadEntrada('i-1', 'e5', { cantidad: 3 }, 'u-x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error: 'STOCK_NEGATIVO',
      details: { cantidad_antes: 5, cantidad_despues: 3 },
    });
    expect((err as Error).message).toContain('Lo menos que puede quedar es 5');
    expect(de(llamadas, 'inventario_movimiento', 'update')).toHaveLength(0);
  });

  it('la misma cantidad (400 SIN_CAMBIO) y una SALIDA (400 TIPO_NO_SOPORTADO) no escriben nada', async () => {
    const casos: Array<[string, Record<string, unknown>, number, string]> = [
      ['e13', E13, 13, 'SIN_CAMBIO'],
      ['s60', SALIDA_60, 50, 'TIPO_NO_SOPORTADO'],
    ];
    for (const [id, fila, cantidad, codigo] of casos) {
      const { service, llamadas } = armar({
        inventario_item: [{ data: ITEM, error: null }],
        inventario_movimiento: [{ data: fila, error: null }, CARDEX_13],
        compra_linea: [{ data: null, error: null }],
      });
      const err = await service
        .corregirCantidadEntrada('i-1', id, { cantidad }, 'u-x')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        error: codigo,
      });
      expect(de(llamadas, 'inventario_movimiento', 'update')).toHaveLength(0);
    }
  });

  it('carrera: si la cantidad cambió entre la lectura y el guardado (0 filas), 409 MOVIMIENTO_CAMBIO', async () => {
    const { service } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_movimiento: [
        { data: E13, error: null },
        CARDEX_13,
        { data: null, error: null }, // el UPDATE con CAS no tocó ninguna fila
      ],
      compra_linea: [{ data: null, error: null }],
      usuario: [{ data: { nombre: 'Jimmy Chi' }, error: null }],
    });
    const err = await service
      .corregirCantidadEntrada('i-1', 'e13', { cantidad: 12 }, 'u-x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error: 'MOVIMIENTO_CAMBIO',
    });
  });
});
