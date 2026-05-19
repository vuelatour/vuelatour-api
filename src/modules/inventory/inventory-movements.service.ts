import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { TipoMovimientoInventario } from './dto/inventory-movements.dto';
import type {
  CreateInventoryMovementDto,
  ListInventoryMovementsQuery,
} from './dto/inventory-movements.dto';

const COLS =
  'id, item_id, tipo, cantidad, costo_unitario_usd, aeronave_id, proveedor_id, fecha_movimiento, fecha_orden, fecha_cargo_banco, referencia, notas, registrado_por, created_at, updated_at';

interface MovimientoRow {
  id: string;
  item_id: string;
  tipo: TipoMovimientoInventario;
  cantidad: string;
  costo_unitario_usd: string;
  aeronave_id: string | null;
  proveedor_id: string | null;
  fecha_movimiento: string;
  created_at: string;
}

interface Layer {
  qty: number;
  cost: number;
}

export interface StockSummary {
  stock_actual: number;
  valor_usd: number;
}

const ADDS = new Set<TipoMovimientoInventario>([
  TipoMovimientoInventario.ENTRADA,
  TipoMovimientoInventario.DEVOLUCION,
]);

@Injectable()
export class InventoryMovementsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListInventoryMovementsQuery) {
    let q = this.supabase.service
      .from('inventario_movimiento')
      .select(COLS, { count: 'exact' })
      .order('fecha_movimiento', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.item_id) q = q.eq('item_id', filters.item_id);
    if (filters.tipo) q = q.eq('tipo', filters.tipo);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.proveedor_id) q = q.eq('proveedor_id', filters.proveedor_id);
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

  /** Cardex de un item: movimientos en orden cronologico con saldo corrido. */
  async cardex(itemId: string) {
    const movs = await this.fetchMovimientos(itemId);
    let saldo = 0;
    return movs.map((m) => {
      const qty = Number(m.cantidad);
      saldo += ADDS.has(m.tipo) ? qty : -qty;
      return { ...m, saldo: Math.round(saldo * 100) / 100 };
    });
  }

  /** Stock y valor (FIFO) por item. */
  async stockSummaryMap(itemIds: string[]): Promise<Map<string, StockSummary>> {
    const unique = [...new Set(itemIds)];
    const result = new Map<string, StockSummary>();
    if (unique.length === 0) return result;

    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(
        'id, item_id, tipo, cantidad, costo_unitario_usd, fecha_movimiento, created_at',
      )
      .in('item_id', unique)
      .order('fecha_movimiento', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    const porItem = new Map<string, MovimientoRow[]>();
    for (const m of (data ?? []) as MovimientoRow[]) {
      const arr = porItem.get(m.item_id) ?? [];
      arr.push(m);
      porItem.set(m.item_id, arr);
    }
    for (const id of unique) {
      const layers = this.replayLayers(porItem.get(id) ?? []);
      result.set(id, this.summarize(layers));
    }
    return result;
  }

  async create(dto: CreateInventoryMovementDto, userId: string) {
    const item = await this.requireActiveItem(dto.item_id);

    if (dto.tipo === TipoMovimientoInventario.SALIDA && !dto.aeronave_id) {
      throw new BadRequestException(
        'Una SALIDA debe indicar la aeronave destino',
      );
    }

    let costoUnitario: number;
    if (ADDS.has(dto.tipo)) {
      if (dto.costo_unitario_usd === undefined) {
        throw new BadRequestException(
          `${dto.tipo} requiere costo_unitario_usd`,
        );
      }
      costoUnitario = dto.costo_unitario_usd;
    } else {
      // SALIDA / AJUSTE: el costo sale del FIFO sobre las capas existentes.
      const layers = this.replayLayers(
        await this.fetchMovimientos(dto.item_id),
      );
      const disponible = layers.reduce((acc, l) => acc + l.qty, 0);
      if (dto.cantidad > disponible + 1e-9) {
        throw new BadRequestException(
          `Stock insuficiente para ${item.nombre}: disponible ${round2(disponible)}, solicitado ${dto.cantidad}`,
        );
      }
      costoUnitario = this.consumeFifo(layers, dto.cantidad);
    }

    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .insert({
        item_id: dto.item_id,
        tipo: dto.tipo,
        cantidad: dto.cantidad,
        costo_unitario_usd: round2(costoUnitario),
        aeronave_id: dto.aeronave_id ?? null,
        proveedor_id: dto.proveedor_id ?? null,
        fecha_movimiento: dto.fecha_movimiento ?? null,
        fecha_orden: dto.fecha_orden ?? null,
        fecha_cargo_banco: dto.fecha_cargo_banco ?? null,
        referencia: dto.referencia ?? null,
        notas: dto.notas ?? null,
        registrado_por: userId,
        created_by: userId,
        updated_by: userId,
      })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      if (error.code === '23514')
        throw new BadRequestException('Datos del movimiento inconsistentes');
      throw new Error(error.message);
    }
    return data!;
  }

  // ============ helpers ============

  private async fetchMovimientos(itemId: string): Promise<MovimientoRow[]> {
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(COLS)
      .eq('item_id', itemId)
      .order('fecha_movimiento', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async requireActiveItem(
    itemId: string,
  ): Promise<{ id: string; nombre: string; activo: boolean }> {
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .select('id, nombre, activo')
      .eq('id', itemId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Item ${itemId} not found`);
    const item = data;
    if (!item.activo) {
      throw new BadRequestException(`El item ${item.nombre} esta inactivo`);
    }
    return item;
  }

  /** Reproduce el cardex en orden y devuelve las capas FIFO vigentes. */
  private replayLayers(movimientos: MovimientoRow[]): Layer[] {
    const layers: Layer[] = [];
    for (const m of movimientos) {
      const qty = Number(m.cantidad);
      if (ADDS.has(m.tipo)) {
        layers.push({ qty, cost: Number(m.costo_unitario_usd) });
      } else {
        // SALIDA / AJUSTE historico: consume capas; los datos ya son validos.
        let restante = qty;
        while (restante > 1e-9 && layers.length > 0) {
          const capa = layers[0];
          const toma = Math.min(capa.qty, restante);
          capa.qty -= toma;
          restante -= toma;
          if (capa.qty <= 1e-9) layers.shift();
        }
      }
    }
    return layers;
  }

  /** Consume `cantidad` de las capas (mutandolas) y devuelve el costo unitario ponderado. */
  private consumeFifo(layers: Layer[], cantidad: number): number {
    let restante = cantidad;
    let costoTotal = 0;
    while (restante > 1e-9 && layers.length > 0) {
      const capa = layers[0];
      const toma = Math.min(capa.qty, restante);
      costoTotal += toma * capa.cost;
      capa.qty -= toma;
      restante -= toma;
      if (capa.qty <= 1e-9) layers.shift();
    }
    return cantidad > 0 ? costoTotal / cantidad : 0;
  }

  private summarize(layers: Layer[]): StockSummary {
    const stock = layers.reduce((acc, l) => acc + l.qty, 0);
    const valor = layers.reduce((acc, l) => acc + l.qty * l.cost, 0);
    return { stock_actual: round2(stock), valor_usd: round2(valor) };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
