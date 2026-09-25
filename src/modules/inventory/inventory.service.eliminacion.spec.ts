jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
// notifications arrastra el gateway y `jose` (ESM), que jest no parsea.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { TipoMovimientoInventario } from './dto/inventory.dto';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Baja de un movimiento de cardex (21-sep-2026) — lado SERVICIO.
 *
 * Pedido del cliente: «podemos agregar una opcion para eliminar algunos
 * movimientos, pero que al momento de eliminarlos pida justificacion y
 * sepamos quien lo hizo». Lo que se prueba aquí es lo que el helper puro no
 * puede: los candados de DINERO (compra ligada, gasto conciliado/facturado),
 * que el borrado SIEMPRE pase por la función atómica de BD (jamás por pasos
 * sueltos), el 503 cuando falta la migración y que un reintento del outbox
 * no resucite lo eliminado.
 */

type Res = {
  data: unknown;
  error: null | { code?: string; message: string };
  count?: number | null;
};
type Llamada = { tabla: string; metodo: string; args: unknown[] };
type Fila = Record<string, unknown>;

interface Cfg {
  /** Cardex devuelto por cada lectura paginada, en orden (la última se repite). */
  cardex?: Fila[][];
  item?: Fila | null;
  movimiento?: Fila | null;
  compraLinea?: Res;
  gastos?: Fila[];
  cargos?: Fila[];
  /** Filas de factura_recibida que apuntan al gasto (FK `set null`). */
  facturas?: Fila[];
  /** Filas de inventario_movimiento_eliminado (listado). */
  eliminados?: Res;
  /** Fila de inventario_movimiento_eliminado por client_request_id. */
  eliminadoPorLlave?: Res;
  rpc?: Res;
}

const ITEM: Fila = { id: 'it-1', nombre: 'Aceite 15W-50', precio_venta: null };

const E1: Fila = {
  id: 'E1',
  item_id: 'it-1',
  tipo: 'ENTRADA',
  cantidad: 30,
  costo_unitario_usd: 94.71,
  moneda: 'MXN',
  costo_unitario_mxn: 1658.33,
  tc_usd_mxn: 17.51,
  fecha_movimiento: '2026-07-13',
  created_at: '2026-07-13T15:37:31Z',
  para_flota: false,
  aeronave: null,
};
const S1: Fila = {
  id: 'S1',
  item_id: 'it-1',
  tipo: 'SALIDA',
  cantidad: 4,
  costo_unitario_usd: 94.71,
  moneda: 'MXN',
  costo_unitario_mxn: 1658.33,
  tc_usd_mxn: 17.51,
  fecha_movimiento: '2026-07-17',
  created_at: '2026-07-20T16:46:52Z',
  para_flota: false,
  aeronave: { matricula: 'N4142R' },
};
const GASTO: Fila = {
  id: 'g-1',
  monto: 6633.32,
  moneda: 'MXN',
  categoria: 'REFACCION',
  medio_pago: 'BODEGA',
  conciliado: false,
  factura_recibida_id: null,
  estatus_facturacion: 'PENDIENTE',
  fecha_gasto: '2026-07-17',
  aeronave_id: 'a-1',
  aeronave: { matricula: 'N4142R' },
};

function armar(cfg: Cfg) {
  const llamadas: Llamada[] = [];
  const rpcs: Array<{ nombre: string; args: unknown }> = [];
  let cardexIdx = 0;
  const cardex = (): Fila[] => {
    const lista = cfg.cardex ?? [[E1, S1]];
    const filas = lista[Math.min(cardexIdx, lista.length - 1)] ?? [];
    cardexIdx += 1;
    return filas;
  };

  const from = (tabla: string) => {
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
      'order',
      'range',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = registra(m);
    }
    const tiene = (metodo: string) => cadena.some((l) => l.metodo === metodo);
    const resolver = (): Res => {
      const sel = cadena.find((l) => l.metodo === 'select');
      switch (tabla) {
        case 'inventario_item':
          return {
            data: cfg.item === undefined ? ITEM : cfg.item,
            error: null,
          };
        case 'inventario_movimiento': {
          // Sonda de columna opcional (client_request_id).
          if (sel?.args[0] === 'client_request_id') {
            return { data: [], error: null };
          }
          if (tiene('range')) {
            const filas = cardex();
            return { data: filas, error: null, count: filas.length };
          }
          return {
            data: cfg.movimiento === undefined ? S1 : cfg.movimiento,
            error: null,
          };
        }
        case 'compra_linea':
          return cfg.compraLinea ?? { data: null, error: null };
        case 'gasto':
          return { data: cfg.gastos ?? [GASTO], error: null };
        case 'movimiento_bancario':
          return { data: cfg.cargos ?? [], error: null };
        case 'factura_recibida':
          return { data: cfg.facturas ?? [], error: null };
        case 'inventario_movimiento_eliminado':
          return tiene('limit')
            ? (cfg.eliminadoPorLlave ?? { data: null, error: null })
            : (cfg.eliminados ?? { data: [], error: null });
        default:
          return { data: null, error: null };
      }
    };
    q.maybeSingle = () => Promise.resolve(resolver());
    q.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(resolve, reject);
    return q;
  };

  const rpc = (nombre: string, args: unknown) => {
    rpcs.push({ nombre, args });
    return Promise.resolve(
      cfg.rpc ?? {
        data: { auditoria_id: 'aud-1', gastos_eliminados: 1 },
        error: null,
      },
    );
  };

  const supabase = { service: { from, rpc } } as unknown as SupabaseService;
  return {
    service: new InventoryService(supabase, {} as never),
    llamadas,
    rpcs,
  };
}

describe('previewEliminacionMovimiento', () => {
  it('SALIDA limpia: permitido, con el gasto de bodega que se va con ella', async () => {
    const { service } = armar({});
    const r = await service.previewEliminacionMovimiento('it-1', 'S1');
    expect(r.permitido).toBe(true);
    expect(r.codigo_bloqueo).toBeNull();
    expect(r.stock_antes).toBe(26);
    expect(r.stock_despues).toBe(30);
    expect(r.movimiento).toEqual({
      tipo: 'SALIDA',
      cantidad: 4,
      fecha: '2026-07-17',
      aeronave: 'N4142R',
    });
    expect(r.gastos).toEqual([
      {
        id: 'g-1',
        monto: 6633.32,
        moneda: 'MXN',
        aeronave_matricula: 'N4142R',
        fecha_gasto: '2026-07-17',
        bloqueado: false,
        motivo_bloqueo: null,
      },
    ]);
    expect(r.de_compra).toBeNull();
    expect(r.mensaje).toContain('Se puede eliminar');
    // API 0.0.36: sin candado de costo; el precio vigente no cambia al
    // quitar una salida y la lista de salidas afectadas viaja vacía.
    expect(r.mensaje).toContain('Ninguna salida cambia de costo');
    expect(r).toMatchObject({
      salidas_afectadas: [],
      cambia_precio_vigente: false,
      precio_vigente_antes: {
        movimiento_id: 'E1',
        unitario: 1658.33,
        moneda: 'MXN',
      },
      regla_costo: 'ULTIMO_PRECIO',
    });
  });

  it('una COMPRA más reciente que la salida SÍ se puede quitar (antes CAMBIA_COSTO_FIFO) y la vista previa dice que cambia el precio vigente', async () => {
    const E2: Fila = {
      ...E1,
      id: 'E2',
      cantidad: 10,
      costo_unitario_usd: 110,
      moneda: 'USD',
      costo_unitario_mxn: null,
      tc_usd_mxn: 17.0115,
      fecha_movimiento: '2026-08-29',
      created_at: '2026-08-29T17:36:43Z',
    };
    const { service } = armar({
      cardex: [[E1, S1, E2]],
      movimiento: E2,
      gastos: [],
    });
    const r = await service.previewEliminacionMovimiento('it-1', 'E2');
    expect(r.permitido).toBe(true);
    expect(r.codigo_bloqueo).toBeNull();
    expect(r.cambia_precio_vigente).toBe(true);
    expect(r.precio_vigente_despues).toMatchObject({ movimiento_id: 'E1' });
    expect(r.mensaje).toContain(
      'El último precio de compra pasa de $110.00 USD (29 ago 2026) a $1,658.33 MXN (13 jul 2026)',
    );
  });

  it('gasto CONCILIADO: bloquea con GASTO_BLOQUEADO y dice qué hacer', async () => {
    const { service } = armar({ gastos: [{ ...GASTO, conciliado: true }] });
    const r = await service.previewEliminacionMovimiento('it-1', 'S1');
    expect(r.permitido).toBe(false);
    expect(r.codigo_bloqueo).toBe('GASTO_BLOQUEADO');
    expect(r.gastos[0].bloqueado).toBe(true);
    expect(r.mensaje).toContain('$6,633.32 MXN');
    expect(r.mensaje).toContain('Conciliación');
  });

  it('gasto con CARGO bancario ligado (conciliación parcial) también bloquea', async () => {
    const { service } = armar({ cargos: [{ gasto_id: 'g-1' }] });
    const r = await service.previewEliminacionMovimiento('it-1', 'S1');
    expect(r.codigo_bloqueo).toBe('GASTO_BLOQUEADO');
  });

  it('gasto FACTURADO bloquea', async () => {
    const { service } = armar({
      gastos: [{ ...GASTO, estatus_facturacion: 'FACTURADA' }],
    });
    const r = await service.previewEliminacionMovimiento('it-1', 'S1');
    expect(r.codigo_bloqueo).toBe('GASTO_BLOQUEADO');
    expect(r.gastos[0].motivo_bloqueo).toContain('factura');
  });

  it('gasto que es el PAGO de una compra bloquea (mismo candado que la BD)', async () => {
    const { service } = armar({ gastos: [{ ...GASTO, compra_id: 'c-1' }] });
    const r = await service.previewEliminacionMovimiento('it-1', 'S1');
    expect(r.codigo_bloqueo).toBe('GASTO_BLOQUEADO');
    expect(r.gastos[0].motivo_bloqueo).toContain('Compras');
  });

  it('factura recibida que apunta al gasto SIN espejo en gasto.factura_recibida_id también bloquea', async () => {
    // El amarre no es simétrico (pendiente conocido del repo) y la FK es
    // `set null`: sin este candado, borrar el gasto dejaría la factura
    // apuntando a nada y la vista previa diría «se puede» mientras el DELETE
    // contestaría 409 desde la BD.
    const { service } = armar({ facturas: [{ gasto_id: 'g-1' }] });
    const r = await service.previewEliminacionMovimiento('it-1', 'S1');
    expect(r.codigo_bloqueo).toBe('GASTO_BLOQUEADO');
    expect(r.gastos[0].motivo_bloqueo).toContain('factura');
  });

  it('gasto que ya NO es de bodega bloquea (la FK set null lo dejaría huérfano)', async () => {
    const { service } = armar({
      gastos: [{ ...GASTO, medio_pago: 'TRANSFERENCIA' }],
    });
    const r = await service.previewEliminacionMovimiento('it-1', 'S1');
    expect(r.codigo_bloqueo).toBe('GASTO_BLOQUEADO');
    expect(r.gastos[0].motivo_bloqueo).toContain('REFACCION de bodega');
  });

  it('movimiento nacido de una COMPRA: manda ese candado sobre todos', async () => {
    const { service } = armar({
      movimiento: { ...E1, aeronave: null },
      compraLinea: {
        data: { id: 'cl-1', compra: { folio: 3 } },
        error: null,
      },
      gastos: [],
    });
    const r = await service.previewEliminacionMovimiento('it-1', 'E1');
    expect(r.permitido).toBe(false);
    expect(r.codigo_bloqueo).toBe('MOVIMIENTO_DE_COMPRA');
    expect(r.de_compra).toEqual({ folio: 3 });
    expect(r.mensaje).toContain('compra #3');
  });

  it('movimiento de otro ítem: 404', async () => {
    const { service } = armar({ movimiento: null });
    await expect(
      service.previewEliminacionMovimiento('it-1', 'S9'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('eliminarMovimiento', () => {
  const MOTIVO = 'captura duplicada del 29-ago';

  it('camino feliz: llama a la función ATÓMICA de BD y devuelve el stock nuevo', async () => {
    const { service, rpcs, llamadas } = armar({ cardex: [[E1, S1], [E1]] });
    const r = await service.eliminarMovimiento('it-1', 'S1', MOTIVO, 'u-admin');
    expect(rpcs).toEqual([
      {
        nombre: 'inventario_eliminar_movimiento',
        args: {
          p_movimiento: 'S1',
          p_item: 'it-1',
          p_motivo: MOTIVO,
          p_usuario: 'u-admin',
        },
      },
    ]);
    expect(r).toEqual({
      ok: true,
      auditoria_id: 'aud-1',
      gastos_eliminados: 1,
      stock_resultante: 30,
      valor_usd: 2841.3,
      // La entrada de este cardex se capturó en PESOS (1,658.33 con TC
      // 17.51): el valorizado es peso real y nada queda en dólares sin TC.
      valor_mxn: 49749.9,
      valor_usd_sin_tc: 0,
      pesos_exactos: true,
      // ADITIVOS (0.0.36): el último precio de compra que queda.
      costo_vigente: {
        movimiento_id: 'E1',
        fecha: '2026-07-13',
        moneda: 'MXN',
        unitario: 1658.33,
        unitario_usd: 94.71,
        unitario_mxn: 1658.33,
        tc_compra: 17.51,
      },
      costo_vigente_mxn: 1658.33,
      regla_costo: 'ULTIMO_PRECIO',
    });
    // NADA de borrados por pasos sueltos desde el API.
    expect(llamadas.filter((l) => l.metodo === 'delete')).toEqual([]);
  });

  it('bloqueado: 409 con `code` estable y SIN tocar la BD', async () => {
    const { service, rpcs } = armar({
      gastos: [{ ...GASTO, conciliado: true }],
    });
    const err = await service
      .eliminarMovimiento('it-1', 'S1', MOTIVO, 'u-admin')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error: 'GASTO_BLOQUEADO',
    });
    expect(rpcs).toEqual([]);
  });

  it('migración sin aplicar: 503 CLARO, nunca un borrado a medias', async () => {
    const { service } = armar({
      rpc: {
        data: null,
        error: {
          code: 'PGRST202',
          message:
            'Could not find the function public.inventario_eliminar_movimiento',
        },
      },
    });
    const err = await service
      .eliminarMovimiento('it-1', 'S1', MOTIVO, 'u-admin')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      error: 'MIGRACION_PENDIENTE',
    });
    expect(
      (
        (err as ServiceUnavailableException).getResponse() as {
          message: string;
        }
      ).message,
    ).toContain('20260921000001');
  });

  it('candado de la BD (carrera): su código viaja como 409 y el texto se limpia', async () => {
    const { service } = armar({
      rpc: {
        data: null,
        error: {
          code: 'P0001',
          message:
            'GASTO_BLOQUEADO: 1 de los gastos de este movimiento ya están conciliados con el banco...',
        },
      },
    });
    const err = await service
      .eliminarMovimiento('it-1', 'S1', MOTIVO, 'u-admin')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const cuerpo = (err as ConflictException).getResponse() as {
      error: string;
      message: string;
    };
    expect(cuerpo.error).toBe('GASTO_BLOQUEADO');
    expect(cuerpo.message.startsWith('1 de los gastos')).toBe(true);
  });

  it('el movimiento desapareció entre la vista previa y el borrado: 404', async () => {
    const { service } = armar({
      rpc: {
        data: null,
        error: {
          code: 'P0001',
          message:
            'MOVIMIENTO_NO_EXISTE: el movimiento S1 ya no está en el cardex.',
        },
      },
    });
    await expect(
      service.eliminarMovimiento('it-1', 'S1', MOTIVO, 'u-admin'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('motivo rechazado por la BD (última defensa): 400', async () => {
    const { service } = armar({
      rpc: {
        data: null,
        error: {
          code: 'P0001',
          message:
            'MOTIVO_REQUERIDO: la justificación debe tener al menos 10 caracteres (llegaron 5).',
        },
      },
    });
    await expect(
      service.eliminarMovimiento('it-1', 'S1', MOTIVO, 'u-admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el `hint` de la BD manda sobre el texto: el code sigue siendo estable', async () => {
    // Si alguien reescribe el mensaje en es-MX y le quita el prefijo, el
    // 409 NO puede degradarse a un 500 silencioso: el código viaja en `hint`.
    const { service } = armar({
      rpc: {
        data: null,
        error: {
          code: 'P0001',
          message:
            'Esta entrada nace de la compra #3; corrígela desde Compras.',
          hint: 'MOVIMIENTO_DE_COMPRA',
        } as { code?: string; message: string },
      },
    });
    const err = await service
      .eliminarMovimiento('it-1', 'S1', MOTIVO, 'u-admin')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error: 'MOVIMIENTO_DE_COMPRA',
    });
  });

  it('un error de BD cualquiera NO se disfraza de 409', async () => {
    const { service } = armar({
      rpc: {
        data: null,
        error: { code: '40P01', message: 'deadlock detected' },
      },
    });
    const err = await service
      .eliminarMovimiento('it-1', 'S1', MOTIVO, 'u-admin')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConflictException);
  });
});

describe('listMovimientosEliminados', () => {
  it('resume los gastos que se fueron con el movimiento', async () => {
    const { service } = armar({
      eliminados: {
        data: [
          {
            id: 'aud-1',
            movimiento_id: 'S1',
            tipo: 'SALIDA',
            cantidad: '4.00',
            fecha_movimiento: '2026-07-17',
            aeronave_matricula: 'N4142R',
            motivo: 'captura duplicada del 29-ago',
            eliminado_por: 'u-admin',
            eliminado_por_nombre: 'Alejandro Villalobos',
            eliminado_at: '2026-09-21T18:00:00Z',
            gastos_snapshot: [
              { id: 'g-1', monto: '6633.32', moneda: 'MXN' },
              { id: 'g-2', monto: '100.00', moneda: 'MXN' },
            ],
          },
        ],
        error: null,
      },
    });
    const r = await service.listMovimientosEliminados('it-1');
    expect(r).toEqual([
      {
        id: 'aud-1',
        movimiento_id: 'S1',
        tipo: 'SALIDA',
        cantidad: 4,
        fecha_movimiento: '2026-07-17',
        aeronave_matricula: 'N4142R',
        motivo: 'captura duplicada del 29-ago',
        eliminado_por: 'u-admin',
        eliminado_por_nombre: 'Alejandro Villalobos',
        eliminado_at: '2026-09-21T18:00:00Z',
        gastos_eliminados: 2,
        monto_gastos: 6733.32,
        moneda_gastos: 'MXN',
      },
    ]);
  });

  it('sin migración aplicada: [] (la sección del panel se ve vacía, no rota)', async () => {
    const { service } = armar({
      eliminados: {
        data: null,
        error: {
          code: 'PGRST205',
          message:
            "Could not find the table 'public.inventario_movimiento_eliminado' in the schema cache",
        },
      },
    });
    await expect(service.listMovimientosEliminados('it-1')).resolves.toEqual(
      [],
    );
  });
});

describe('createMovimiento · el outbox no resucita lo eliminado', () => {
  const KEY = '33333333-3333-4333-8333-333333333333';

  it('la llave de un movimiento ELIMINADO responde 409 MOVIMIENTO_ELIMINADO con el motivo', async () => {
    const { service } = armar({
      movimiento: null, // la llave ya no existe en el cardex
      eliminadoPorLlave: {
        data: {
          motivo: 'captura duplicada del 29-ago',
          eliminado_por_nombre: 'Alejandro Villalobos',
          eliminado_at: '2026-09-21T18:00:00Z',
        },
        error: null,
      },
    });
    const err = await service
      .createMovimiento(
        'it-1',
        {
          tipo: TipoMovimientoInventario.SALIDA,
          cantidad: 10,
          aeronave_id: 'a-1',
          client_request_id: KEY,
        },
        'u-mec',
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const cuerpo = (err as ConflictException).getResponse() as {
      error: string;
      message: string;
    };
    expect(cuerpo.error).toBe('MOVIMIENTO_ELIMINADO');
    expect(cuerpo.message).toContain('captura duplicada del 29-ago');
    expect(cuerpo.message).toContain('Alejandro Villalobos');
  });
});
