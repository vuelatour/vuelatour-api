import { BadRequestException } from '@nestjs/common';
import { InventarioMasivoService } from './inventario-masivo.service';
import type { InventoryService } from './inventory.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import { LOTE_ALTA_MASIVA, MAX_FILAS_INVENTARIO } from './dto/inventory.dto';

/**
 * Alta masiva: lo que se manda a InventoryService al confirmar (fecha del
 * movimiento en día Cancún, TC conservado en USD, códigos ya verificados,
 * lotes) y el tope de filas. InventoryService/Supabase/pyservices se
 * simulan: aquí no se prueba el FIFO ni la BD.
 */
describe('InventarioMasivoService', () => {
  const USER = 'user-1';
  let parseInventario: jest.Mock;
  let createItem: jest.Mock;
  let createMovimiento: jest.Mock;
  let svc: InventarioMasivoService;

  const filaMxn = {
    fila: 2,
    nombre: 'Aceite AeroShell W15W-50 1 qt',
    categoria: 'Aceites',
    codigo: '0 21400 06215 3',
    existencia_inicial: 24,
    costo_unitario: 320.5,
    moneda: 'MXN',
    tipo_cambio: 18.2,
  };
  const filaUsd = {
    fila: 3,
    nombre: 'Bujía REM38E',
    categoria: 'Bujías',
    existencia_inicial: 8,
    costo_unitario: 25,
    moneda: 'USD',
    tipo_cambio: 18.2,
  };

  beforeEach(() => {
    parseInventario = jest.fn();
    let n = 0;
    createItem = jest
      .fn()
      .mockImplementation(() => Promise.resolve({ id: `item-${++n}` }));
    createMovimiento = jest.fn().mockResolvedValue({ id: 'mov-1' });

    // Catálogo vacío: la consulta de ítems/empaques regresa sin filas.
    const consulta = () => {
      const q: Record<string, unknown> = {};
      const self = () => q;
      Object.assign(q, {
        select: self,
        limit: () => Promise.resolve({ data: [], error: null }),
        not: () => Promise.resolve({ data: [], error: null }),
      });
      return q;
    };
    const supabase = {
      service: { from: () => consulta() },
    } as unknown as SupabaseService;
    const pyservices = {
      parseInventario,
      generarPlantillaInventario: jest.fn(),
    } as unknown as PyservicesService;
    const inventory = {
      listCategorias: jest.fn().mockResolvedValue(['Aceites']),
      createItem,
      createMovimiento,
    } as unknown as InventoryService;
    svc = new InventarioMasivoService(supabase, pyservices, inventory);
  });

  afterEach(() => jest.useRealTimers());

  it('la ENTRADA inicial lleva fecha_movimiento del día Cancún (no el UTC del server)', async () => {
    // 00:30 UTC del 29 = 19:30 del 28 en Cancún.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-29T00:30:00Z'));
    parseInventario.mockResolvedValue({ filas: [filaMxn] });

    const r = await svc.importar(
      { archivo_base64: 'x', filename: 'a.xlsx', confirmar: true },
      USER,
    );

    expect(r.creados).toBe(1);
    expect(createMovimiento).toHaveBeenCalledTimes(1);
    const [itemId, dto] = createMovimiento.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(itemId).toBe('item-1');
    expect(dto.fecha_movimiento).toBe('2026-08-28');
    expect(dto).toMatchObject({
      tipo: 'ENTRADA',
      cantidad: 24,
      moneda: 'MXN',
      costo_unitario_mxn: 320.5,
      tc_usd_mxn: 18.2,
      referencia: 'Alta masiva',
    });
    // Los códigos ya se cruzaron contra la bodega en una sola carga.
    expect(createItem).toHaveBeenCalledWith(
      expect.objectContaining({ codigo: '021400062153' }),
      USER,
      { codigosYaVerificados: true },
    );
  });

  it('fila USD con tipo de cambio → entrada_inicial trae tc_usd_mxn', async () => {
    parseInventario.mockResolvedValue({ filas: [filaUsd] });

    const r = await svc.importar(
      { archivo_base64: 'x', filename: 'a.xlsx', confirmar: true },
      USER,
    );

    expect(r.ok).toBe(1);
    expect(r.filas[0].crear.entrada_inicial).toEqual({
      cantidad: 8,
      moneda: 'USD',
      costo_unitario_usd: 25,
      tc_usd_mxn: 18.2,
    });
    const [, dto] = createMovimiento.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(dto).toMatchObject({
      moneda: 'USD',
      costo_unitario_usd: 25,
      tc_usd_mxn: 18.2,
    });
    expect(dto.costo_unitario_mxn).toBeUndefined();
  });

  it('preview (confirmar=false) no escribe nada', async () => {
    parseInventario.mockResolvedValue({ filas: [filaMxn, filaUsd] });
    const r = await svc.importar(
      { archivo_base64: 'x', filename: 'a.xlsx' },
      USER,
    );
    expect(r.ok).toBe(2);
    expect(r.creados).toBeUndefined();
    expect(createItem).not.toHaveBeenCalled();
    expect(createMovimiento).not.toHaveBeenCalled();
  });

  it('más de MAX_FILAS_INVENTARIO filas → 400 con "divide el Excel"', async () => {
    const filas = Array.from({ length: MAX_FILAS_INVENTARIO + 1 }, (_, i) => ({
      fila: i + 2,
      nombre: `Ítem ${i}`,
      categoria: 'Aceites',
    }));
    parseInventario.mockResolvedValue({ filas });
    await expect(
      svc.importar({ archivo_base64: 'x', filename: 'a.xlsx' }, USER),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.importar({ archivo_base64: 'x', filename: 'a.xlsx' }, USER),
    ).rejects.toThrow(/máximo 200 por archivo; divide el Excel/);
    expect(createItem).not.toHaveBeenCalled();
  });

  it('confirmar crea en lotes: una fila que falla no detiene a las demás', async () => {
    const filas = Array.from({ length: LOTE_ALTA_MASIVA + 3 }, (_, i) => ({
      fila: i + 2,
      nombre: `Ítem ${i}`,
      categoria: 'Aceites',
    }));
    parseInventario.mockResolvedValue({ filas });
    createItem.mockImplementationOnce(() =>
      Promise.reject(new Error('falló la BD')),
    );

    const r = await svc.importar(
      { archivo_base64: 'x', filename: 'a.xlsx', confirmar: true },
      USER,
    );

    expect(createItem).toHaveBeenCalledTimes(LOTE_ALTA_MASIVA + 3);
    expect(r.creados).toBe(LOTE_ALTA_MASIVA + 2);
    expect(r.errores).toBe(1);
    const fallida = r.filas.find((f) => f.estado === 'ERROR');
    expect(fallida?.mensajes.join(' ')).toMatch(
      /No se pudo crear: falló la BD/,
    );
    // Sin existencia inicial no hay ENTRADA.
    expect(createMovimiento).not.toHaveBeenCalled();
  });
});
