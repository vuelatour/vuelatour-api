jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { TipoMovimientoInventario } from './dto/inventory.dto';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * STOCK POR UBICACIÓN Y TRASPASOS (27-oct-2026, invariante 111) en
 * `createMovimiento`. Harness COPIADO de `inventory.service.movimiento.spec`
 * (cola de respuestas por tabla; el insert hace ECO de su payload). Caso de
 * la oficina: el filtro CH48108 con principal Bodega Corner — entrada de 3 y
 * salida de 2 sin bodega (⇒ Corner 1) y entrada de 1 en Locker Toledo.
 */
type Resultado = {
  data: unknown;
  error: null | { code?: string; message: string };
  count?: number | null;
};
type Llamada = { tabla: string; metodo: string; args: unknown[] };
const ECO = '__ECO__';

function armar(tablas: Record<string, Resultado[]>) {
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
      'is',
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
      // Sondas de columnas opcionales (`select(col).limit(1)`): presentes.
      if (
        cadena.length === 2 &&
        cadena.some((l) => l.metodo === 'limit') &&
        ['client_request_id', 'ubicacion_id'].includes(String(sel?.args[0]))
      ) {
        return { data: [], error: null };
      }
      const r = siguiente(tabla);
      if (r.data === ECO) {
        const ins = cadena.find((l) => l.metodo === 'insert')?.args[0];
        const base = Array.isArray(ins) ? ins : [ins];
        const filas = base.map((f, i) => ({
          id: `${tabla}-eco-${i + 1}`,
          created_at: '2026-10-27T15:00:00+00:00',
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
      undefined,
      undefined,
    ),
    llamadas,
  };
}

const de = (llamadas: Llamada[], tabla: string, metodo: string) =>
  llamadas.filter((l) => l.tabla === tabla && l.metodo === metodo);

const CORNER = '11111111-1111-4111-8111-111111111111';
const TOLEDO = '22222222-2222-4222-8222-222222222222';
const LOC_CORNER = { id: CORNER, nombre: 'Bodega Corner', activo: true };
const LOC_TOLEDO = { id: TOLEDO, nombre: 'Locker Toledo', activo: true };
const CATALOGO = { data: [LOC_CORNER, LOC_TOLEDO], error: null };

const ITEM = {
  id: 'i-1',
  nombre: 'Filtro de aceite roscado CH48108',
  precio_venta: null,
  precio_venta_moneda: null,
  ubicacion: 'Bodega Corner',
  ubicacion_id: CORNER,
};
const ITEM_SIN_PRINCIPAL = { ...ITEM, ubicacion: 'Corner', ubicacion_id: null };

const E1 = {
  id: 'mv-e1',
  tipo: 'ENTRADA',
  cantidad: 3,
  costo_unitario_usd: 46.06,
  moneda: 'USD',
  costo_unitario_mxn: null,
  tc_usd_mxn: 17.0077,
  fecha_movimiento: '2026-09-01',
  created_at: '2026-09-01T15:00:00+00:00',
  ubicacion_id: null,
  ubicacion_destino_id: null,
};
const S1 = {
  ...E1,
  id: 'mv-s1',
  tipo: 'SALIDA',
  cantidad: 2,
  created_at: '2026-09-01T18:00:00+00:00',
};
const E2 = {
  ...E1,
  id: 'mv-e2',
  cantidad: 1,
  fecha_movimiento: '2026-10-26',
  created_at: '2026-10-26T15:00:00+00:00',
  ubicacion_id: TOLEDO,
};
/** Cardex: Corner (principal) 1 · Toledo 1 · total 2. */
const CARDEX = { data: [E1, S1, E2], error: null, count: 3 };

async function rebote(p: Promise<unknown>) {
  try {
    await p;
    throw new Error('no rebotó');
  } catch (e) {
    return e as BadRequestException | ConflictException;
  }
}

describe('createMovimiento — TRASPASO entre ubicaciones (invariante 111)', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it('traspasa 1 de la principal (origen omitido) a Toledo: insert sin costo/avión/venta, sin gasto, y la respuesta trae el reparto', async () => {
    const T1 = {
      ...E1,
      id: 'mv-t1',
      tipo: 'TRASPASO',
      cantidad: 1,
      costo_unitario_usd: 0,
      tc_usd_mxn: null,
      fecha_movimiento: '2026-10-27',
      created_at: '2026-10-27T15:00:00+00:00',
      ubicacion_destino_id: TOLEDO,
    };
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_ubicacion: [{ data: LOC_TOLEDO, error: null }, CATALOGO],
      inventario_movimiento: [
        CARDEX, // existencia en la bodega de origen
        { data: ECO, error: null }, // insert
        { data: [E1, S1, E2, T1], error: null, count: 4 }, // stock resultante
      ],
    });
    const res = await service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.TRASPASO,
        cantidad: 1,
        ubicacion_destino_id: TOLEDO,
        notas: 'se lo llevó Toño',
      },
      'u-ofi',
    );
    const insert = de(llamadas, 'inventario_movimiento', 'insert')[0]
      .args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      item_id: 'i-1',
      tipo: 'TRASPASO',
      cantidad: 1,
      costo_unitario_usd: 0,
      moneda: 'USD',
      costo_unitario_mxn: null,
      tc_usd_mxn: null,
      venta_unitaria: null,
      venta_moneda: null,
      para_flota: false,
      aeronave_id: null,
      proveedor_id: null,
      ubicacion_id: null,
      ubicacion_destino_id: TOLEDO,
      notas: 'se lo llevó Toño',
    });
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(0);
    expect(res).toMatchObject({
      tipo: 'TRASPASO',
      stock_resultante: 2,
      gasto_generado: null,
      venta_origen: null,
      costo_vigente: null,
      tc_venta: null,
      ubicacion_nombre: null,
      ubicacion_destino_nombre: 'Locker Toledo',
      stock_por_ubicacion: [
        {
          ubicacion_id: CORNER,
          nombre: 'Bodega Corner',
          cantidad: 0,
          es_principal: true,
        },
        {
          ubicacion_id: TOLEDO,
          nombre: 'Locker Toledo',
          cantidad: 2,
          es_principal: false,
        },
      ],
    });
  });

  it('400: sin destino, destino = origen efectivo, destino fuera de un traspaso; nada se inserta', async () => {
    const sin = armar({ inventario_item: [{ data: ITEM, error: null }] });
    const e1 = await rebote(
      sin.service.createMovimiento(
        'i-1',
        { tipo: TipoMovimientoInventario.TRASPASO, cantidad: 1 },
        'u-ofi',
      ),
    );
    expect(e1).toBeInstanceOf(BadRequestException);
    expect(e1.getResponse()).toMatchObject({ error: 'TRASPASO_SIN_DESTINO' });

    const mismo = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_ubicacion: [{ data: LOC_CORNER, error: null }],
    });
    const e2 = await rebote(
      mismo.service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.TRASPASO,
          cantidad: 1,
          ubicacion_destino_id: CORNER,
        },
        'u-ofi',
      ),
    );
    expect(e2.getResponse()).toMatchObject({ error: 'TRASPASO_MISMO_ORIGEN' });
    expect((e2.getResponse() as { message: string }).message).toContain(
      'Bodega Corner',
    );

    const entrada = armar({ inventario_item: [{ data: ITEM, error: null }] });
    const e3 = await rebote(
      entrada.service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.ENTRADA,
          cantidad: 1,
          moneda: 'USD',
          costo_unitario_usd: 46.06,
          ubicacion_destino_id: TOLEDO,
        },
        'u-ofi',
      ),
    );
    expect(e3.getResponse()).toMatchObject({ error: 'DESTINO_SOLO_TRASPASO' });
    for (const a of [sin, mismo, entrada]) {
      expect(de(a.llamadas, 'inventario_movimiento', 'insert')).toHaveLength(0);
    }
  });

  it('409 STOCK_UBICACION_INSUFICIENTE: el traspaso pide más de lo que hay en el origen; details.por_ubicacion dice dónde está', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_ubicacion: [{ data: LOC_TOLEDO, error: null }, CATALOGO],
      inventario_movimiento: [CARDEX],
    });
    const e = await rebote(
      service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.TRASPASO,
          cantidad: 2,
          ubicacion_destino_id: TOLEDO,
        },
        'u-ofi',
      ),
    );
    expect(e).toBeInstanceOf(ConflictException);
    const cuerpo = e.getResponse() as {
      message: string;
      error: string;
      details: Record<string, unknown>;
    };
    expect(cuerpo.error).toBe('STOCK_UBICACION_INSUFICIENTE');
    expect(cuerpo.message).toBe(
      'En Bodega Corner hay 1 y el traspaso pide 2. Dónde está: Bodega Corner 1 · Locker Toledo 1. Elige otra bodega o registra un traspaso.',
    );
    expect(cuerpo.details).toEqual({
      ubicacion_id: CORNER,
      ubicacion: 'Bodega Corner',
      disponible: 1,
      solicitado: 2,
      por_ubicacion: [
        {
          ubicacion_id: CORNER,
          nombre: 'Bodega Corner',
          cantidad: 1,
          es_principal: true,
        },
        {
          ubicacion_id: TOLEDO,
          nombre: 'Locker Toledo',
          cantidad: 1,
          es_principal: false,
        },
      ],
    });
    expect(de(llamadas, 'inventario_movimiento', 'insert')).toHaveLength(0);
  });

  it('SALIDA desde una bodega sin existencia suficiente ⇒ 409 (la existencia TOTAL sí alcanzaba); nada se inserta ni se cobra', async () => {
    const { service, llamadas } = armar({
      inventario_item: [{ data: ITEM, error: null }],
      inventario_ubicacion: [{ data: LOC_TOLEDO, error: null }, CATALOGO],
      inventario_movimiento: [CARDEX],
    });
    const e = await rebote(
      service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.SALIDA,
          cantidad: 2,
          aeronave_id: 'a-1',
          ubicacion_id: TOLEDO,
        },
        'u-ofi',
      ),
    );
    expect(e).toBeInstanceOf(ConflictException);
    const cuerpo = e.getResponse() as { message: string; error: string };
    expect(cuerpo.error).toBe('STOCK_UBICACION_INSUFICIENTE');
    expect(cuerpo.message).toContain(
      'En Locker Toledo hay 1 y la salida pide 2',
    );
    expect(de(llamadas, 'inventario_movimiento', 'insert')).toHaveLength(0);
    expect(de(llamadas, 'gasto', 'insert')).toHaveLength(0);
  });

  it('producto SIN principal: el traspaso sale del cajón «Sin ubicación» (lo sin bodega) y se valida contra él', async () => {
    const ok = armar({
      inventario_item: [{ data: ITEM_SIN_PRINCIPAL, error: null }],
      inventario_ubicacion: [{ data: LOC_TOLEDO, error: null }, CATALOGO],
      inventario_movimiento: [
        CARDEX,
        { data: ECO, error: null },
        CARDEX, // (la cola se repite: el último resultado)
      ],
    });
    const res = await ok.service.createMovimiento(
      'i-1',
      {
        tipo: TipoMovimientoInventario.TRASPASO,
        cantidad: 1,
        ubicacion_destino_id: TOLEDO,
      },
      'u-ofi',
    );
    expect(res).toMatchObject({
      tipo: 'TRASPASO',
      ubicacion_destino_nombre: 'Locker Toledo',
    });
    const insert = de(ok.llamadas, 'inventario_movimiento', 'insert')[0]
      .args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      ubicacion_id: null,
      ubicacion_destino_id: TOLEDO,
    });

    const mucho = armar({
      inventario_item: [{ data: ITEM_SIN_PRINCIPAL, error: null }],
      inventario_ubicacion: [{ data: LOC_TOLEDO, error: null }, CATALOGO],
      inventario_movimiento: [CARDEX],
    });
    const e = await rebote(
      mucho.service.createMovimiento(
        'i-1',
        {
          tipo: TipoMovimientoInventario.TRASPASO,
          cantidad: 2,
          ubicacion_destino_id: TOLEDO,
        },
        'u-ofi',
      ),
    );
    const cuerpo = e.getResponse() as {
      message: string;
      details: { por_ubicacion: Array<Record<string, unknown>> };
    };
    expect(cuerpo.message).toContain(
      'En la ubicación principal hay 1 y el traspaso pide 2',
    );
    // «Sin ubicación» al final, sin marca de principal.
    expect(cuerpo.details.por_ubicacion).toEqual([
      {
        ubicacion_id: TOLEDO,
        nombre: 'Locker Toledo',
        cantidad: 1,
        es_principal: false,
      },
      { ubicacion_id: null, nombre: null, cantidad: 1, es_principal: false },
    ]);
  });
});
