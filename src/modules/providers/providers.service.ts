import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateProveedorDto,
  ListProveedoresQuery,
  UpdateProveedorDto,
} from './dto/providers.dto';

const COLS =
  'id, nombre, rfc, tipo, pais, email, telefono, direccion, contacto, notas, activo, created_at, updated_at';

@Injectable()
export class ProvidersService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListProveedoresQuery) {
    let q = this.supabase.service
      .from('proveedor')
      .select(COLS, { count: 'exact' })
      .order('nombre', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.tipo) q = q.eq('tipo', filters.tipo);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(`nombre.ilike.${term},rfc.ilike.${term}`);
    }
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const { data, error } = await this.supabase.service
      .from('proveedor')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Proveedor ${id} not found`);
    return data;
  }

  async create(dto: CreateProveedorDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('proveedor')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('Conflict on unique field');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateProveedorDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('proveedor')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Proveedor ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activo: false }, updatedBy);
  }
}
