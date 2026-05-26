import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  CreateInventarioItemDto,
  CreateMovimientoDto,
  ListInventarioQuery,
  ListMovimientosQuery,
  TipoMovimientoInventario,
  UpdateInventarioItemDto,
} from './dto/inventory.dto';

const ITEM_COLS =
  'id, nombre, numero_parte, categoria, stock_minimo, ubicacion, notas, activo, created_at, updated_at';
const MOV_COLS =
  'id, item_id, tipo, cantidad, costo_unitario_usd, aeronave_id, proveedor_id, fecha_movimiento, fecha_orden, fecha_cargo_banco, referencia, notas, registrado_por, created_at';

/** Movimiento mínimo necesario para reconstruir el cardex FIFO. */
type MovForFifo = {
  tipo: string;
  cantidad: number | string;
  costo_unitario_usd: number | string;
  fecha_movimiento: string;
  created_at: string;
};

type FifoLayer = { qty: number; cost: number };

const EPS = 1e-9;

@Injectable()
export class InventoryService {
  constructor(private readonly supabase: SupabaseService) {}

  // ===== Cálculo FIFO =====

  /** Orden cronológico estable: fecha_movimiento y, a igualdad, created_at. */
  private sortChrono(movs: MovForFifo[]): MovForFifo[] {
    return [...movs].sort((a, b) => {
      if (a.fecha_movimiento !== b.fecha_movimiento)
        return a.fecha_movimiento < b.fecha_movimiento ? -1 : 1;
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    });
  }

  /**
   * Reconstruye las capas FIFO restantes procesando los movimientos en orden.
   * ENTRADA/DEVOLUCION/AJUSTE agregan capa; SALIDA consume de las más antiguas.
   */
  private buildLayers(movs: MovForFifo[]): FifoLayer[] {
    const layers: FifoLayer[] = [];
    for (const m of this.sortChrono(movs)) {
      const cant = Number(m.cantidad);
      if (m.tipo === TipoMovimientoInventario.SALIDA) {
        let need = cant;
        while (need > EPS && layers.length > 0) {
          const layer = layers[0];
          const take = Math.min(need, layer.qty);
          layer.qty -= take;
          need -= take;
          if (layer.qty <= EPS) layers.shift();
        }
      } else {
        layers.push({ qty: cant, cost: Number(m.costo_unitario_usd) });
      }
    }
    return layers;
  }

  private statsFromLayers(layers: FifoLayer[]): {
    stock: number;
    valor_usd: number;
    costo_fifo_actual: number;
  } {
    const stock = layers.reduce((s, l) => s + l.qty, 0);
    const valor_usd = layers.reduce((s, l) => s + l.qty * l.cost, 0);
    return {
      stock: round(stock),
      valor_usd: round(valor_usd, 2),
      costo_fifo_actual: round(layers[0]?.cost ?? 0, 2),
    };
  }

  /** Consume `qty` de las capas FIFO. Devuelve el costo total o lanza si no alcanza. */
  private consumeFifo(layers: FifoLayer[], qty: number): number {
    const disponible = layers.reduce((s, l) => s + l.qty, 0);
    if (disponible + EPS < qty) {
      throw new BadRequestException(
        `Stock insuficiente: disponible ${round(disponible)}, salida solicitada ${qty}.`,
      );
    }
    let need = qty;
    let total = 0;
    for (const layer of layers) {
      if (need <= EPS) break;
      const take = Math.min(need, layer.qty);
      total += take * layer.cost;
      need -= take;
    }
    return total;
  }

  private async movsForItem(itemId: string): Promise<MovForFifo[]> {
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select('tipo, cantidad, costo_unitario_usd, fecha_movimiento, created_at')
      .eq('item_id', itemId);
    if (error) throw new Error(error.message);
    return (data ?? []) as MovForFifo[];
  }

  // ===== Ítems =====

  async listItems(filters: ListInventarioQuery) {
    let q = this.supabase.service
      .from('inventario_item')
      .select(ITEM_COLS, { count: 'exact' })
      .order('nombre', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.categoria) q = q.eq('categoria', filters.categoria);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(`nombre.ilike.${term},numero_parte.ilike.${term}`);
    }

    const { data: items, error, count } = await q;
    if (error) throw new Error(error.message);
    const rows = items ?? [];

    // Stock + valorizado por ítem (un solo barrido del cardex de los ítems listados).
    const ids = rows.map((r) => (r as { id: string }).id);
    const movsByItem = await this.movsByItems(ids);
    let data = rows.map((r) => {
      const it = r as Record<string, unknown> & { id: string; stock_minimo: number | null };
      const stats = this.statsFromLayers(this.buildLayers(movsByItem.get(it.id) ?? []));
      return {
        ...it,
        ...stats,
        bajo_stock: it.stock_minimo != null && stats.stock < Number(it.stock_minimo),
      };
    });

    if (filters.bajo_stock === true) data = data.filter((d) => d.bajo_stock);

    return {
      data,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
      valor_total_usd: round(
        data.reduce((s, d) => s + d.valor_usd, 0),
        2,
      ),
    };
  }

  private async movsByItems(itemIds: string[]): Promise<Map<string, MovForFifo[]>> {
    const map = new Map<string, MovForFifo[]>();
    if (itemIds.length === 0) return map;
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select('item_id, tipo, cantidad, costo_unitario_usd, fecha_movimiento, created_at')
      .in('item_id', itemIds);
    if (error) throw new Error(error.message);
    for (const m of data ?? []) {
      const k = (m as { item_id: string }).item_id;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m as MovForFifo);
    }
    return map;
  }

  async findItem(id: string) {
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .select(ITEM_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Ítem ${id} not found`);
    return data;
  }

  /** Detalle del ítem con cardex completo y stats FIFO. */
  async getItemDetail(id: string) {
    const item = await this.findItem(id);
    const { data: movs, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(
        `${MOV_COLS}, aeronave:aeronave!aeronave_id(matricula), proveedor:proveedor!proveedor_id(nombre)`,
      )
      .eq('item_id', id)
      .order('fecha_movimiento', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    const stats = this.statsFromLayers(this.buildLayers((movs ?? []) as unknown as MovForFifo[]));
    return { ...item, ...stats, movimientos: movs ?? [] };
  }

  async createItem(dto: CreateInventarioItemDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .insert({
        nombre: dto.nombre,
        numero_parte: dto.numero_parte,
        categoria: dto.categoria,
        stock_minimo: dto.stock_minimo ?? 0,
        ubicacion: dto.ubicacion ?? 'Bodega Cancún',
        notas: dto.notas,
        created_by: userId,
        updated_by: userId,
      })
      .select(ITEM_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }

  async updateItem(id: string, dto: UpdateInventarioItemDto, userId: string) {
    if (Object.keys(dto).length === 0) return this.findItem(id);
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select(ITEM_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Ítem ${id} not found`);
    return data;
  }

  async softDeleteItem(id: string, userId: string) {
    return this.updateItem(id, { activo: false }, userId);
  }

  // ===== Movimientos (cardex) =====

  async createMovimiento(itemId: string, dto: CreateMovimientoDto, userId: string) {
    await this.findItem(itemId); // 404 si no existe

    let costoUnitario: number;

    if (dto.tipo === TipoMovimientoInventario.SALIDA) {
      if (!dto.aeronave_id) {
        throw new BadRequestException('La salida debe registrar el avión (aeronave_id).');
      }
      const layers = this.buildLayers(await this.movsForItem(itemId));
      const total = this.consumeFifo(layers, dto.cantidad);
      costoUnitario = round(total / dto.cantidad, 4);
    } else {
      if (dto.costo_unitario_usd == null) {
        throw new BadRequestException(
          'costo_unitario_usd es requerido para ENTRADA, DEVOLUCION y AJUSTE.',
        );
      }
      costoUnitario = dto.costo_unitario_usd;
    }

    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .insert({
        item_id: itemId,
        tipo: dto.tipo,
        cantidad: dto.cantidad,
        costo_unitario_usd: costoUnitario,
        aeronave_id: dto.aeronave_id ?? null,
        proveedor_id: dto.proveedor_id ?? null,
        fecha_movimiento: dto.fecha_movimiento ?? undefined,
        fecha_orden: dto.fecha_orden ?? null,
        fecha_cargo_banco: dto.fecha_cargo_banco ?? null,
        referencia: dto.referencia ?? null,
        notas: dto.notas ?? null,
        registrado_por: userId,
        created_by: userId,
        updated_by: userId,
      })
      .select(MOV_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(`Referencia no encontrada: ${error.message}`);
      throw new Error(error.message);
    }

    const stats = this.statsFromLayers(this.buildLayers(await this.movsForItem(itemId)));
    return { ...data, stock_resultante: stats.stock, valor_usd: stats.valor_usd };
  }

  async listMovimientos(filters: ListMovimientosQuery) {
    let q = this.supabase.service
      .from('inventario_movimiento')
      .select(
        `${MOV_COLS}, item:inventario_item!item_id(nombre, numero_parte, categoria), aeronave:aeronave!aeronave_id(matricula), proveedor:proveedor!proveedor_id(nombre)`,
        { count: 'exact' },
      )
      .order('fecha_movimiento', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.item_id) q = q.eq('item_id', filters.item_id);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.tipo) q = q.eq('tipo', filters.tipo);
    if (filters.desde) q = q.gte('fecha_movimiento', filters.desde);
    if (filters.hasta) q = q.lte('fecha_movimiento', filters.hasta);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }
}

function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}
