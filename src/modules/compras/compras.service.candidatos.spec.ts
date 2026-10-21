// Mismos stubs que expenses.service.inventario.spec.ts: InventoryService
// arrastra el gateway de notificaciones (`jose`, ESM puro).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { HttpException } from '@nestjs/common';
import type { InventoryService } from '../inventory/inventory.service';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  ComprasService,
  DIAS_CANDIDATOS_DEFAULT,
  MENSAJE_ENTRADA_TC_REQUERIDO,
  rolSugeridoCandidato,
} from './compras.service';
import { GastosCandidatosQuery } from './dto/compras.dto';

/**
 * «Vincular gasto ya registrado» y «Entrada desde un gasto» (21-oct-2026,
 * invariante 101) + los campos nuevos de la lista (`gasto_estado`…).
 * PostgREST falso por tabla: cada consulta registra sus llamadas y responde
 * las filas configuradas; `create`/`recibir` se espían (ya tienen su propia
 * cobertura).
 */
type Llamada = { tabla: string; metodo: string; args: unknown[] };

function fakeSupabase(
  tablas: Record<string, { rows?: unknown[]; single?: unknown }>,
) {
  const llamadas: Llamada[] = [];
  const from = (tabla: string) => {
    llamadas.push({ tabla, metodo: 'from', args: [tabla] });
    const q: Record<string, unknown> = {};
    const registra =
      (metodo: string) =>
      (...args: unknown[]) => {
        llamadas.push({ tabla, metodo, args });
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
      'delete',
    ]) {
      q[m] = registra(m);
    }
    q.maybeSingle = () =>
      Promise.resolve({ data: tablas[tabla]?.single ?? null, error: null });
    q.then = (resolve: (v: unknown) => unknown) => {
      const rows = tablas[tabla]?.rows ?? [];
      return Promise.resolve({
        data: rows,
        error: null,
        count: rows.length,
      }).then(resolve);
    };
    return q;
  };
  return {
    supabase: { service: { from } } as unknown as SupabaseService,
    llamadas,
  };
}

const GASTOS = [
  {
    id: 'g-ref',
    categoria: 'REFACCION',
    monto: '722.90',
    moneda: 'USD',
    tc_gasto: null,
    fecha_gasto: '2026-10-02T17:00:00+00:00',
    proveedor_id: 'prov-as',
    notas: 'Filtros y bujías\nDesglose: …',
    compra_id: null,
    valor_ia_extraido: null,
    medio_pago: 'TRANSFERENCIA',
    inventario_movimiento_id: null,
    folio_ticket: 'AS-1',
    conciliado: true,
    proveedor: { id: 'prov-as', nombre: 'Aircraft Spruce' },
  },
  {
    id: 'g-ups',
    categoria: 'PAQUETERIA',
    monto: '350.00',
    moneda: 'MXN',
    tc_gasto: '18.1',
    fecha_gasto: '2026-10-05T17:00:00+00:00',
    proveedor_id: null,
    notas: 'UPS envío de la caja',
    compra_id: null,
    valor_ia_extraido: null,
    medio_pago: 'TARJETA_CORP',
    inventario_movimiento_id: null,
    folio_ticket: null,
    conciliado: false,
    proveedor: null,
  },
  {
    id: 'g-bodega',
    categoria: 'REFACCION',
    monto: '900.00',
    moneda: 'MXN',
    tc_gasto: null,
    fecha_gasto: '2026-10-06T17:00:00+00:00',
    proveedor_id: null,
    notas: 'Salida de bodega',
    compra_id: null,
    valor_ia_extraido: null,
    medio_pago: 'BODEGA',
    inventario_movimiento_id: null,
    folio_ticket: null,
    conciliado: false,
    proveedor: null,
  },
  {
    id: 'g-gas',
    categoria: 'GAS',
    monto: '5000.00',
    moneda: 'MXN',
    tc_gasto: null,
    fecha_gasto: '2026-10-07T17:00:00+00:00',
    proveedor_id: null,
    notas: 'Turbosina',
    compra_id: null,
    valor_ia_extraido: null,
    medio_pago: 'TRANSFERENCIA',
    inventario_movimiento_id: null,
    folio_ticket: null,
    conciliado: false,
    proveedor: null,
  },
  {
    id: 'g-aduana',
    categoria: 'OTRO',
    monto: '1200.00',
    moneda: 'MXN',
    tc_gasto: null,
    fecha_gasto: '2026-10-08T17:00:00+00:00',
    proveedor_id: null,
    notas: 'Aduana pedimento 123',
    compra_id: null,
    valor_ia_extraido: null,
    medio_pago: 'TRANSFERENCIA',
    inventario_movimiento_id: null,
    folio_ticket: null,
    conciliado: false,
    proveedor: null,
  },
];

function armar(
  tablas: Record<string, { rows?: unknown[]; single?: unknown }>,
  extra: { tcOficial?: number | null } = {},
) {
  const { supabase, llamadas } = fakeSupabase(tablas);
  const inventory = {
    findItem: jest.fn().mockResolvedValue({
      id: 'it-1',
      nombre: 'Filtro CH48110',
      numero_parte: 'CH48110',
      categoria: 'Refacción',
    }),
    tcOficialDe: jest
      .fn()
      .mockResolvedValue(
        extra.tcOficial === null ? null : { tc: extra.tcOficial ?? 18.2 },
      ),
    createMovimiento: jest.fn(),
  };
  const service = new ComprasService(
    supabase,
    inventory as unknown as InventoryService,
  );
  return { service, llamadas, inventory };
}

const query = (
  extra: Partial<GastosCandidatosQuery> = {},
): GastosCandidatosQuery =>
  Object.assign(new GastosCandidatosQuery(), { limite: 100 }, extra);

async function falla(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      const r = e.getResponse() as { error?: string; message?: string };
      return {
        status: e.getStatus(),
        code: r.error,
        message: typeof r === 'string' ? r : r.message,
      };
    }
    throw e;
  }
  throw new Error('no falló');
}

describe('gastosCandidatos («Vincular gasto ya registrado»)', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-10-21T18:00:00Z')),
  );
  afterEach(() => jest.useRealTimers());

  it('ventana por default: 120 días hasta hoy (Cancún), sin compra ni cargo de bodega, fecha desc', async () => {
    const { service, llamadas } = armar({ gasto: { rows: GASTOS } });
    const r = await service.gastosCandidatos(query());
    expect(DIAS_CANDIDATOS_DEFAULT).toBe(120);
    expect(r.ventana).toEqual({ desde: '2026-06-23', hasta: '2026-10-21' });
    const de = (m: string) =>
      llamadas
        .filter((l) => l.tabla === 'gasto' && l.metodo === m)
        .map((l) => l.args);
    expect(de('is')).toEqual([
      ['compra_id', null],
      ['inventario_movimiento_id', null],
    ]);
    expect(de('gte')).toEqual([['fecha_gasto', '2026-06-23T00:00:00-05:00']]);
    expect(de('lte')).toEqual([['fecha_gasto', '2026-10-21T23:59:59-05:00']]);
    expect(de('order')[0]).toEqual(['fecha_gasto', { ascending: false }]);
    expect(de('eq')).toEqual([]);
  });

  it('excluye el cargo contable de bodega y las categorías no ligables; sugiere el rol y dice quién puede ser mercancía', async () => {
    const { service } = armar({ gasto: { rows: GASTOS } });
    const r = await service.gastosCandidatos(query());
    expect(r.data.map((g) => g.id)).toEqual(['g-ref', 'g-ups', 'g-aduana']);
    expect(r.total).toBe(3);
    expect(r.truncado).toBe(false);
    expect(r.data[0]).toEqual({
      id: 'g-ref',
      fecha_gasto: '2026-10-02',
      categoria: 'REFACCION',
      monto: 722.9,
      moneda: 'USD',
      tc_gasto: null,
      medio_pago: 'TRANSFERENCIA',
      folio_ticket: 'AS-1',
      descripcion: 'Filtros y bujías',
      proveedor: { id: 'prov-as', nombre: 'Aircraft Spruce' },
      conciliado: true,
      rol_sugerido: 'MERCANCIA',
      puede_mercancia: true,
    });
    expect(r.data[1]).toMatchObject({
      id: 'g-ups',
      rol_sugerido: 'ENVIO',
      puede_mercancia: false,
      tc_gasto: 18.1,
    });
    expect(r.data[2]).toMatchObject({
      id: 'g-aduana',
      rol_sugerido: 'IMPUESTOS',
      puede_mercancia: true,
    });
  });

  it('solo_mercancia deja REFACCION/OTRO/OPERACIONES; la búsqueda cruza notas, folio, proveedor y monto sin acentos', async () => {
    const { service } = armar({ gasto: { rows: GASTOS } });
    expect(
      (
        await service.gastosCandidatos(query({ solo_mercancia: true }))
      ).data.map((g) => g.id),
    ).toEqual(['g-ref', 'g-aduana']);
    expect(
      (await service.gastosCandidatos(query({ q: 'ENVIO' }))).data.map(
        (g) => g.id,
      ),
    ).toEqual(['g-ups']);
    expect(
      (await service.gastosCandidatos(query({ q: 'aircraft' }))).data.map(
        (g) => g.id,
      ),
    ).toEqual(['g-ref']);
    expect(
      (await service.gastosCandidatos(query({ q: 'as-1' }))).data.map(
        (g) => g.id,
      ),
    ).toEqual(['g-ref']);
    expect(
      (await service.gastosCandidatos(query({ q: '722.9' }))).data.map(
        (g) => g.id,
      ),
    ).toEqual(['g-ref']);
    expect(
      (await service.gastosCandidatos(query({ q: 'nada que ver' }))).data,
    ).toEqual([]);
  });

  it('proveedor y fechas explícitos van a la consulta; `limite` corta la respuesta pero `total` dice cuántos había', async () => {
    const { service, llamadas } = armar({ gasto: { rows: GASTOS } });
    const r = await service.gastosCandidatos(
      query({
        proveedor_id: 'prov-as',
        desde: '2026-09-01',
        hasta: '2026-10-10',
        limite: 1,
      }),
    );
    const de = (m: string) =>
      llamadas
        .filter((l) => l.tabla === 'gasto' && l.metodo === m)
        .map((l) => l.args);
    expect(de('eq')).toEqual([['proveedor_id', 'prov-as']]);
    expect(de('gte')).toEqual([['fecha_gasto', '2026-09-01T00:00:00-05:00']]);
    expect(de('lte')).toEqual([['fecha_gasto', '2026-10-10T23:59:59-05:00']]);
    expect(r.data).toHaveLength(1);
    expect(r.total).toBe(3);
    expect(r.ventana).toEqual({ desde: '2026-09-01', hasta: '2026-10-10' });
  });

  it('rolSugeridoCandidato: el texto manda (envío/impuestos); sin pista, mercancía para una refacción y «otro» para lo demás', () => {
    expect(rolSugeridoCandidato('REFACCION', 'DHL guía 123')).toBe('ENVIO');
    expect(rolSugeridoCandidato('OTRO', 'arancel aduana')).toBe('IMPUESTOS');
    expect(rolSugeridoCandidato('REFACCION', 'filtros')).toBe('MERCANCIA');
    expect(rolSugeridoCandidato('OTRO', 'servicio')).toBe('OTRO');
  });
});

describe('entradaDesdeGasto («ya registramos el gasto; cuando llegue, vincular»)', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-10-21T18:00:00Z')),
  );
  afterEach(() => jest.useRealTimers());

  const gastoUsd = { ...GASTOS[0] };
  const gastoMxn = {
    ...GASTOS[0],
    id: 'g-mxn',
    moneda: 'MXN',
    monto: '13000.00',
    tc_gasto: null,
  };

  it('compra de UNA línea con el gasto como mercancía (costo = monto ÷ unidades, 4 decimales), recibida en el acto con la fecha de llegada', async () => {
    const { service, inventory } = armar({ gasto: { single: gastoUsd } });
    const create = jest
      .spyOn(service, 'create')
      .mockResolvedValue({ id: 'c-new', folio: 13 } as never);
    const recibir = jest.spyOn(service, 'recibir').mockResolvedValue({
      id: 'c-new',
      folio: 13,
      lineas: [{ inventario_movimiento_id: 'ent-1' }],
      avisos: [],
    } as never);
    const r = await service.entradaDesdeGasto(
      { gasto_id: 'g-ref', item_id: 'it-1', cantidad: 5 },
      'u-1',
    );
    expect(inventory.findItem).toHaveBeenCalledWith('it-1');
    expect(create).toHaveBeenCalledWith(
      {
        gasto_mercancia_id: 'g-ref',
        moneda: 'USD',
        fecha: '2026-10-21',
        lineas: [
          {
            item_id: 'it-1',
            nombre: 'Filtro CH48110',
            numero_parte: 'CH48110',
            categoria: 'Refacción',
            cantidad: 5,
            costo_unitario: 144.58,
          },
        ],
        cargos_factura: [],
      },
      'u-1',
    );
    // Gasto en dólares sin T.C.: no se inventa ninguno (createMovimiento pondrá el oficial).
    expect(inventory.tcOficialDe).not.toHaveBeenCalled();
    expect(recibir).toHaveBeenCalledWith('c-new', 'u-1', false);
    expect(r).toMatchObject({
      recibida: true,
      entrada_id: 'ent-1',
      avisos: [],
      compra: { id: 'c-new' },
    });
  });

  it('fecha, referencia, notas, proveedor y T.C. capturados viajan a la compra', async () => {
    const { service, inventory } = armar({ gasto: { single: gastoMxn } });
    const create = jest
      .spyOn(service, 'create')
      .mockResolvedValue({ id: 'c-new', folio: 13 } as never);
    jest.spyOn(service, 'recibir').mockResolvedValue({
      id: 'c-new',
      folio: 13,
      lineas: [],
      avisos: [],
    } as never);
    await service.entradaDesdeGasto(
      {
        gasto_id: 'g-mxn',
        item_id: 'it-1',
        cantidad: 2,
        fecha: '2026-10-15',
        referencia: ' F-9 ',
        notas: ' llegó por UPS ',
        proveedor_id: 'prov-x',
        tc_usd_mxn: 18.5,
      },
      'u-1',
    );
    expect(create.mock.calls[0][0]).toMatchObject({
      moneda: 'MXN',
      tc_usd_mxn: 18.5,
      fecha: '2026-10-15',
      referencia: 'F-9',
      notas: 'llegó por UPS',
      proveedor_id: 'prov-x',
      lineas: [{ cantidad: 2, costo_unitario: 6500 }],
    });
    expect(inventory.tcOficialDe).not.toHaveBeenCalled();
  });

  it('gasto en pesos sin T.C.: el oficial del día de llegada; sin él tampoco ⇒ 400 TC_REQUERIDO sin crear nada', async () => {
    const con = armar({ gasto: { single: gastoMxn } }, { tcOficial: 18.2 });
    const create = jest
      .spyOn(con.service, 'create')
      .mockResolvedValue({ id: 'c-new', folio: 13 } as never);
    jest.spyOn(con.service, 'recibir').mockResolvedValue({
      id: 'c-new',
      folio: 13,
      lineas: [],
      avisos: [],
    } as never);
    await con.service.entradaDesdeGasto(
      { gasto_id: 'g-mxn', item_id: 'it-1', cantidad: 1, fecha: '2026-10-15' },
      'u-1',
    );
    expect(con.inventory.tcOficialDe).toHaveBeenCalledWith('2026-10-15');
    expect(create.mock.calls[0][0]).toMatchObject({ tc_usd_mxn: 18.2 });

    const sin = armar({ gasto: { single: gastoMxn } }, { tcOficial: null });
    const createSin = jest.spyOn(sin.service, 'create');
    expect(
      await falla(
        sin.service.entradaDesdeGasto(
          { gasto_id: 'g-mxn', item_id: 'it-1', cantidad: 1 },
          'u-1',
        ),
      ),
    ).toEqual({
      status: 400,
      code: 'TC_REQUERIDO',
      message: MENSAJE_ENTRADA_TC_REQUERIDO,
    });
    expect(createSin).not.toHaveBeenCalled();
  });

  it('si la recepción falla, la compra queda con el gasto ligado y se dice (recibida=false + aviso con «Recíbela desde Compras»)', async () => {
    const { service } = armar({ gasto: { single: gastoUsd } });
    jest
      .spyOn(service, 'create')
      .mockResolvedValue({ id: 'c-new', folio: 13 } as never);
    jest
      .spyOn(service, 'recibir')
      .mockRejectedValue(
        new Error('La compra se está recibiendo en otra sesión; recárgala.'),
      );
    const getDetail = jest.spyOn(service, 'getDetail').mockResolvedValue({
      id: 'c-new',
      folio: 13,
      estado: 'ABIERTA',
    } as never);
    const r = await service.entradaDesdeGasto(
      { gasto_id: 'g-ref', item_id: 'it-1', cantidad: 5 },
      'u-1',
    );
    expect(getDetail).toHaveBeenCalledWith('c-new');
    expect(r).toMatchObject({
      recibida: false,
      entrada_id: null,
      compra: { id: 'c-new', estado: 'ABIERTA' },
    });
    expect(r.avisos[0]).toBe(
      'La compra #13 quedó registrada con el gasto vinculado, pero la pieza NO entró a bodega: La compra se está recibiendo en otra sesión; recárgala. Recíbela desde Compras.',
    );
  });

  it('un gasto que ya pertenece a una compra, o un cargo de bodega, rebota ANTES de crear nada', async () => {
    const ligado = armar({
      gasto: { single: { ...gastoUsd, compra_id: 'c-otra' } },
    });
    const create = jest.spyOn(ligado.service, 'create');
    expect(
      (
        await falla(
          ligado.service.entradaDesdeGasto(
            { gasto_id: 'g-ref', item_id: 'it-1', cantidad: 1 },
            'u-1',
          ),
        )
      ).status,
    ).toBe(409);
    const bodega = armar({
      gasto: { single: { ...gastoUsd, medio_pago: 'BODEGA' } },
    });
    expect(
      (
        await falla(
          bodega.service.entradaDesdeGasto(
            { gasto_id: 'g-ref', item_id: 'it-1', cantidad: 1 },
            'u-1',
          ),
        )
      ).status,
    ).toBe(409);
    const gas = armar({ gasto: { single: { ...gastoUsd, categoria: 'GAS' } } });
    expect(
      (
        await falla(
          gas.service.entradaDesdeGasto(
            { gasto_id: 'g-ref', item_id: 'it-1', cantidad: 1 },
            'u-1',
          ),
        )
      ).status,
    ).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(ligado.inventory.findItem).not.toHaveBeenCalled();
  });
});

describe('list: qué le falta a cada compra (campos ADITIVOS)', () => {
  it('recibida_at, tc_usd_mxn, total_factura y gasto_estado por fila', async () => {
    const compra = {
      id: 'c-1',
      folio: 12,
      proveedor_id: 'prov-as',
      fecha: '2026-10-02',
      referencia: 'AS-1',
      moneda: 'USD',
      tc_usd_mxn: '18.2000',
      estado: 'ABIERTA',
      cargos_factura: [{ concepto: 'Shipping', monto: 100.8 }],
      recibida_at: null,
      notas: null,
      proveedor: { id: 'prov-as', nombre: 'Aircraft Spruce' },
    };
    const lineas = [
      {
        id: 'l-1',
        compra_id: 'c-1',
        orden: 1,
        item_id: null,
        nombre: 'Filtro',
        numero_parte: null,
        categoria: null,
        cantidad: '3',
        costo_unitario: '120',
        inventario_movimiento_id: null,
        item: null,
        movimiento: null,
      },
      {
        id: 'l-2',
        compra_id: 'c-1',
        orden: 2,
        item_id: null,
        nombre: 'Bujía',
        numero_parte: null,
        categoria: null,
        cantidad: '2',
        costo_unitario: '85.55',
        inventario_movimiento_id: null,
        item: null,
        movimiento: null,
      },
      {
        id: 'l-3',
        compra_id: 'c-1',
        orden: 3,
        item_id: null,
        nombre: 'Empaque',
        numero_parte: null,
        categoria: null,
        cantidad: '1',
        costo_unitario: '91',
        inventario_movimiento_id: null,
        item: null,
        movimiento: null,
      },
    ];
    const { service } = armar({
      compra: { rows: [compra] },
      compra_linea: { rows: lineas },
      gasto: { rows: [] },
    });
    const r = await service.list(
      Object.assign(new (class {})(), { limit: 50, offset: 0 }) as never,
    );
    expect(r.count).toBe(1);
    expect(r.data[0]).toMatchObject({
      id: 'c-1',
      estado: 'ABIERTA',
      n_lineas: 3,
      n_pagos: 0,
      total_mercancia: 622.1,
      recibida_at: null,
      tc_usd_mxn: 18.2,
      total_factura: 722.9,
      gasto_estado: 'SIN_GASTO',
      gasto_mercancia: 0,
      gasto_faltante: null,
    });
  });
});
