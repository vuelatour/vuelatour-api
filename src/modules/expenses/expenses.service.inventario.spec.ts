// Mismos stubs que expenses.service.sin-vuelo.spec.ts.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { HttpException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CategoriaGasto, MedioPago, Moneda } from './dto/expenses.dto';
import type { CreateGastoDto } from './dto/expenses.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';
import { CODIGO_INVENTARIO } from './refaccion-inventario.util';

/**
 * REFACCIÓN A INVENTARIO/TIENDA desde el alta (12-oct-2026, invariante 57).
 * Lo que se custodia: (1) el bloque se valida ANTES de insertar nada; (2) el
 * gasto de compra se crea SIN avión ni vuelo (el avión paga por la SALIDA);
 * (3) la cadena compra → recibir → precio → salida con los argumentos
 * exactos; (4) una etapa que falla NO borra el gasto ni tumba el alta: lo
 * dice en `inventario.avisos`; (5) un PATCH con `inventario` rebota.
 */
type Llamada = { metodo: string; args: unknown[] };

function armar(
  extra: {
    tcOficial?: number | null;
    /** Sin la migración 20261019000001 (42703 al nombrar `por_pagar`). */
    sinPorPagar?: boolean;
  } = {},
) {
  const llamadas: Llamada[] = [];
  const supabase = {
    service: {
      from: (tabla: string) => {
        llamadas.push({ metodo: 'from', args: [tabla] });
        const q: Record<string, unknown> = {};
        let error: { code: string; message: string } | null = null;
        const registra =
          (metodo: string) =>
          (...args: unknown[]) => {
            llamadas.push({ metodo, args });
            if (
              metodo === 'select' &&
              extra.sinPorPagar &&
              typeof args[0] === 'string' &&
              /\bpor_pagar\b/.test(args[0])
            ) {
              error = {
                code: '42703',
                message: 'column gasto.por_pagar does not exist',
              };
            }
            return q;
          };
        for (const m of [
          'select',
          'eq',
          'neq',
          'in',
          'is',
          'not',
          'or',
          'gte',
          'lte',
          'order',
          'range',
          'limit',
          'insert',
          'update',
        ]) {
          q[m] = registra(m);
        }
        q.maybeSingle = () =>
          Promise.resolve(
            error
              ? { data: null, error }
              : {
                  data: {
                    id: 'g-nuevo',
                    monto: '1000.00',
                    moneda: 'MXN',
                    fecha_gasto: '2026-10-12',
                  },
                  error: null,
                },
          );
        q.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            error ? { data: null, error } : { data: [], error: null },
          ).then(resolve);
        return q;
      },
    },
  } as unknown as SupabaseService;
  const notifications = {
    notifyRole: jest.fn().mockResolvedValue(undefined),
    notifyUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
  const nada = {} as never;
  const configuracion = { numero: jest.fn().mockResolvedValue(1) } as never;
  const compras = {
    create: jest.fn().mockResolvedValue({ id: 'c-1', folio: 12 }),
    recibir: jest.fn().mockResolvedValue({
      id: 'c-1',
      folio: 12,
      lineas: [
        {
          item_id: 'it-1',
          inventario_movimiento_id: 'ent-1',
          nombre: 'Filtro CH48110',
        },
      ],
    }),
  };
  const inventory = {
    findItem: jest.fn().mockResolvedValue({
      id: 'it-9',
      nombre: 'Bujía REM38E',
      numero_parte: 'REM38E',
      categoria: 'Refacción',
    }),
    updateItem: jest.fn().mockResolvedValue({}),
    createMovimiento: jest.fn().mockResolvedValue({
      id: 'sal-1',
      gasto_generado: { id: 'g-bodega', monto: 900, moneda: 'MXN' },
    }),
    tcOficialDe: jest
      .fn()
      .mockResolvedValue(
        extra.tcOficial === undefined
          ? { tc: 17.5 }
          : extra.tcOficial == null
            ? null
            : { tc: extra.tcOficial },
      ),
  };
  const service = new ExpensesService(
    supabase,
    notifications,
    nada,
    nada,
    configuracion,
    nada,
    nada,
    undefined,
    compras as never,
    inventory as never,
  );
  return { service, llamadas, compras, inventory };
}

function dto(extra: Partial<CreateGastoDto> = {}): CreateGastoDto {
  return {
    categoria: CategoriaGasto.REFACCION,
    monto: 1000,
    moneda: Moneda.MXN,
    tc_gasto: 17.5,
    fecha_gasto: '2026-10-12',
    medio_pago: MedioPago.TRANSFERENCIA,
    aeronave_id: 'av-1',
    inventario: {
      nombre: 'Filtro CH48110',
      cantidad: 2,
      precio_venta: 450,
      precio_venta_moneda: 'MXN',
      vender_al_avion: true,
    },
    ...extra,
  };
}

async function rebote(p: Promise<unknown>) {
  try {
    await p;
    throw new Error('no rebotó');
  } catch (e) {
    const err = e as HttpException;
    const body = err.getResponse() as { message?: string; error?: string };
    return { status: err.getStatus(), body };
  }
}

const inserts = (llamadas: Llamada[]) =>
  llamadas
    .filter((l) => l.metodo === 'insert')
    .map((l) => l.args[0] as Record<string, unknown>);

describe('refacción a Inventario/Tienda: validación antes de la BD', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T18:00:00Z')),
  );
  afterEach(() => jest.useRealTimers());

  it('solo REFACCION, y sin ítem ni nombre no entra nada', async () => {
    const { service, llamadas, compras } = armar();
    const r1 = await rebote(
      service.create(
        dto({ categoria: CategoriaGasto.OPERACIONES }),
        'u-admin',
        Rol.ADMIN,
      ),
    );
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe(CODIGO_INVENTARIO.SOLO_REFACCION);
    const r2 = await rebote(
      service.create(
        dto({
          inventario: {
            cantidad: 1,
            precio_venta: 10,
            precio_venta_moneda: 'MXN',
          },
        }),
        'u-admin',
        Rol.ADMIN,
      ),
    );
    expect(r2.body.error).toBe(CODIGO_INVENTARIO.ITEM_REQUERIDO);
    expect(inserts(llamadas)).toHaveLength(0);
    expect(compras.create).not.toHaveBeenCalled();
  });

  it('«vender al avión» sin avión rebota; en pesos sin T.C. propio ni oficial rebota TC_REQUERIDO', async () => {
    const { service } = armar();
    const r = await rebote(
      service.create(dto({ aeronave_id: undefined }), 'u-admin', Rol.ADMIN),
    );
    expect(r.body.error).toBe(CODIGO_INVENTARIO.AVION_REQUERIDO);
    const sinTc = armar({ tcOficial: null });
    const r2 = await rebote(
      sinTc.service.create(dto({ tc_gasto: undefined }), 'u-admin', Rol.ADMIN),
    );
    expect(r2.body.error).toBe(CODIGO_INVENTARIO.TC_REQUERIDO);
    expect(inserts(sinTc.llamadas)).toHaveLength(0);
  });

  it('un PATCH con `inventario` rebota con código estable', async () => {
    const { service } = armar();
    const r = await rebote(
      service.update(
        'g-1',
        {
          inventario: {
            cantidad: 1,
            precio_venta: 1,
            precio_venta_moneda: 'MXN',
          },
        } as never,
        'u-admin',
        Rol.ADMIN,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(CODIGO_INVENTARIO.SOLO_AL_CREAR);
  });
});

describe('refacción a Inventario/Tienda con fecha FUTURA (gastos por pagar, revisión P12)', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T18:00:00Z')),
  );
  afterEach(() => jest.useRealTimers());

  it('fecha después de hoy (queda «por pagar») ⇒ 400 INVENTARIO_FECHA_FUTURA ANTES de insertar o tocar compras/inventario', async () => {
    const { service, llamadas, compras, inventory } = armar();
    const r = await rebote(
      service.create(dto({ fecha_gasto: '2026-10-20' }), 'u-admin', Rol.ADMIN),
    );
    expect(r).toEqual({
      status: 400,
      body: {
        error: 'INVENTARIO_FECHA_FUTURA',
        message:
          'Una refacción con fecha futura queda «por pagar»: guárdala sin entrada a Inventario/Tienda y registra la entrada desde Inventario/Tienda (Compras) el día que llegue la pieza.',
      },
    });
    expect(inserts(llamadas)).toHaveLength(0);
    expect(compras.create).not.toHaveBeenCalled();
    expect(compras.recibir).not.toHaveBeenCalled();
    expect(inventory.createMovimiento).not.toHaveBeenCalled();
    expect(inventory.tcOficialDe).not.toHaveBeenCalled();
  });

  it('«lo pago al rato» con fecha de HOY sí entra (la pieza llegó hoy): la cadena de siempre', async () => {
    const { service, compras, inventory } = armar();
    await service.create(dto({ por_pagar: true }), 'u-admin', Rol.ADMIN);
    expect(compras.create).toHaveBeenCalledTimes(1);
    expect(inventory.createMovimiento).toHaveBeenCalledTimes(1);
  });

  it('SIN la migración 20261019000001: como el 0.0.94 (la fecha futura de oficina entra a la cadena)', async () => {
    const { service, compras } = armar({ sinPorPagar: true });
    await service.create(
      dto({ fecha_gasto: '2026-10-20' }),
      'u-admin',
      Rol.ADMIN,
    );
    expect(compras.create).toHaveBeenCalledTimes(1);
  });
});

describe('refacción a Inventario/Tienda: la cadena', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T18:00:00Z')),
  );
  afterEach(() => jest.useRealTimers());

  it('crea el gasto SIN avión/vuelo y encadena compra → recibir → precio → salida al avión', async () => {
    const { service, llamadas, compras, inventory } = armar();
    const r = (await service.create(
      dto({ vuelo_id: 'v-1' }),
      'u-admin',
      Rol.ADMIN,
    )) as unknown as {
      inventario: Record<string, unknown>;
    };
    const fila = inserts(llamadas).find((i) => i.categoria === 'REFACCION');
    expect(fila).toBeDefined();
    expect(fila?.aeronave_id ?? null).toBeNull();
    expect(fila?.vuelo_id ?? null).toBeNull();
    expect(fila).not.toHaveProperty('inventario');
    expect(compras.create).toHaveBeenCalledWith(
      expect.objectContaining({
        gasto_mercancia_id: 'g-nuevo',
        moneda: 'MXN',
        tc_usd_mxn: 17.5,
        notas: expect.stringContaining('Inventario/Tienda') as string,
        lineas: [
          { nombre: 'Filtro CH48110', cantidad: 2, costo_unitario: 500 },
        ],
      }),
      'u-admin',
    );
    expect(compras.recibir).toHaveBeenCalledWith('c-1', 'u-admin', true);
    expect(inventory.updateItem).toHaveBeenCalledWith(
      'it-1',
      { precio_venta: 450, precio_venta_moneda: 'MXN' },
      'u-admin',
    );
    expect(inventory.createMovimiento).toHaveBeenCalledWith(
      'it-1',
      expect.objectContaining({
        tipo: 'SALIDA',
        cantidad: 2,
        aeronave_id: 'av-1',
        venta_unitaria: 450,
        venta_moneda: 'MXN',
        fecha_movimiento: '2026-10-12',
        referencia: 'Gasto g-nuevo',
      }),
      'u-admin',
    );
    expect(r.inventario).toMatchObject({
      item_id: 'it-1',
      item_nombre: 'Filtro CH48110',
      item_creado: true,
      compra_id: 'c-1',
      compra_folio: 12,
      entrada_id: 'ent-1',
      precio_venta_guardado: true,
      salida: {
        movimiento_id: 'sal-1',
        gasto_id: 'g-bodega',
        monto: 900,
        moneda: 'MXN',
      },
      error: null,
      avisos: [],
    });
  });

  it('con ítem existente la línea viaja con su id y nombre; sin «vender al avión» no hay salida', async () => {
    const { service, compras, inventory } = armar();
    compras.recibir.mockResolvedValueOnce({
      lineas: [
        {
          item_id: 'it-9',
          inventario_movimiento_id: 'ent-2',
          nombre: 'Bujía REM38E',
        },
      ],
    });
    const r = (await service.create(
      dto({
        aeronave_id: undefined,
        inventario: {
          item_id: 'it-9',
          cantidad: 4,
          precio_venta: 0,
          precio_venta_moneda: 'USD',
          vender_al_avion: false,
        },
      }),
      'u-admin',
      Rol.ADMIN,
    )) as unknown as { inventario: Record<string, unknown> };
    expect(inventory.findItem).toHaveBeenCalledWith('it-9');
    const primeraCompra = (compras.create.mock.calls as unknown[][])[0][0];
    expect(primeraCompra).toMatchObject({
      lineas: [
        {
          item_id: 'it-9',
          nombre: 'Bujía REM38E',
          numero_parte: 'REM38E',
          categoria: 'Refacción',
          cantidad: 4,
          costo_unitario: 250,
        },
      ],
    });
    expect(inventory.createMovimiento).not.toHaveBeenCalled();
    expect(r.inventario).toMatchObject({
      item_id: 'it-9',
      item_creado: false,
      salida: null,
      error: null,
    });
  });

  it('si la compra no se recibe, el gasto queda, la compra abierta se dice y no hay salida', async () => {
    const { service, compras, inventory } = armar();
    compras.recibir.mockRejectedValueOnce(
      new Error('Compra en pesos: captura el tipo de cambio'),
    );
    const r = (await service.create(
      dto(),
      'u-admin',
      Rol.ADMIN,
    )) as unknown as {
      id: string;
      inventario: {
        error: string;
        avisos: string[];
        compra_folio: number | null;
      };
    };
    expect(r.id).toBe('g-nuevo');
    expect(r.inventario.error).toBe('RECIBIR');
    expect(r.inventario.compra_folio).toBe(12);
    expect(r.inventario.avisos[0]).toContain('compra #12 quedó ABIERTA');
    expect(inventory.createMovimiento).not.toHaveBeenCalled();
  });

  it('si la compra no se crea, el gasto queda y se dice cómo seguir; si falla la salida, la pieza está en bodega', async () => {
    const a = armar();
    a.compras.create.mockRejectedValueOnce(new Error('sin conexión'));
    const r1 = (await a.service.create(
      dto(),
      'u-admin',
      Rol.ADMIN,
    )) as unknown as {
      inventario: { error: string; avisos: string[] };
    };
    expect(r1.inventario.error).toBe('COMPRA');
    expect(r1.inventario.avisos[0]).toContain('«Crear compra»');
    expect(a.compras.recibir).not.toHaveBeenCalled();
    const b = armar();
    b.inventory.createMovimiento.mockRejectedValueOnce(
      new Error('SALIDA_ANTES_DE_LA_COMPRA'),
    );
    const r2 = (await b.service.create(
      dto(),
      'u-admin',
      Rol.ADMIN,
    )) as unknown as {
      inventario: {
        error: string;
        avisos: string[];
        entrada_id: string | null;
      };
    };
    expect(r2.inventario.error).toBe('SALIDA');
    expect(r2.inventario.entrada_id).toBe('ent-1');
    expect(r2.inventario.avisos[0]).toContain('NO se vendió al avión');
  });

  it('sin `inventario` el alta es la de siempre (ni compra ni inventario)', async () => {
    const { service, compras, inventory, llamadas } = armar();
    await service.create(dto({ inventario: undefined }), 'u-admin', Rol.ADMIN);
    expect(compras.create).not.toHaveBeenCalled();
    expect(inventory.createMovimiento).not.toHaveBeenCalled();
    const fila = inserts(llamadas).find((i) => i.categoria === 'REFACCION');
    expect(fila?.aeronave_id).toBe('av-1');
  });
});
