import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { InventoryMovementsService } from './inventory-movements.service';
import type {
  CreateInventoryItemDto,
  ListInventoryItemsQuery,
  UpdateInventoryItemDto,
} from './dto/inventory-items.dto';

const COLS =
  'id, nombre, numero_parte, categoria, stock_minimo, ubicacion, notas, activo, created_at, updated_at';

interface ItemRow {
  id: string;
  nombre: string;
  numero_parte: string | null;
  categoria: string;
  stock_minimo: string | null;
  ubicacion: string;
  notas: string | null;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class InventoryItemsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly movements: InventoryMovementsService,
  ) {}

  async list(filters: ListInventoryItemsQuery) {
    let q = this.supabase.service
      .from('inventario_item')
      .select(COLS)
      .order('categoria', { ascending: true })
      .order('nombre', { ascending: true });

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.categoria) q = q.eq('categoria', filters.categoria);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(`nombre.ilike.${term},numero_parte.ilike.${term}`);
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as ItemRow[];
    const stock = await this.movements.stockSummaryMap(rows.map((r) => r.id));

    let enriched = rows.map((r) => this.enrich(r, stock));
    if (filters.bajo_stock) enriched = enriched.filter((i) => i.bajo_stock);

    const paged = enriched.slice(
      filters.offset,
      filters.offset + filters.limit,
    );
    return {
      data: paged,
      count: enriched.length,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const row = await this.fetchRow(id);
    const stock = await this.movements.stockSummaryMap([id]);
    return this.enrich(row, stock);
  }

  async create(dto: CreateInventoryItemDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('Conflict on unique field');
      throw new Error(error.message);
    }
    return this.enrich(data as ItemRow, new Map());
  }

  async update(id: string, dto: UpdateInventoryItemDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Item ${id} not found`);
    const stock = await this.movements.stockSummaryMap([id]);
    return this.enrich(data, stock);
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activo: false }, updatedBy);
  }

  private async fetchRow(id: string): Promise<ItemRow> {
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Item ${id} not found`);
    return data;
  }

  private enrich(
    row: ItemRow,
    stock: Map<string, { stock_actual: number; valor_usd: number }>,
  ) {
    const s = stock.get(row.id) ?? { stock_actual: 0, valor_usd: 0 };
    const minimo = row.stock_minimo !== null ? Number(row.stock_minimo) : null;
    return {
      ...row,
      stock_actual: s.stock_actual,
      valor_usd: s.valor_usd,
      bajo_stock: minimo !== null && s.stock_actual <= minimo,
    };
  }
}
