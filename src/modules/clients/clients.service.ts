import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateClienteDto,
  ListClientesQuery,
  UpdateClienteDto,
} from './dto/clients.dto';

const COLS =
  'id, nombre, telefono, email, razon_social_default, rfc, canal_origen, es_broker, notas, activo, created_at, updated_at';

@Injectable()
export class ClientsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListClientesQuery) {
    let q = this.supabase.service
      .from('cliente')
      .select(COLS, { count: 'exact' })
      .order('nombre', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.canal_origen) q = q.eq('canal_origen', filters.canal_origen);
    if (typeof filters.es_broker === 'boolean') q = q.eq('es_broker', filters.es_broker);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(
        `nombre.ilike.${term},email.ilike.${term},telefono.ilike.${term},rfc.ilike.${term}`,
      );
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
      .from('cliente')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Cliente ${id} not found`);
    return data;
  }

  async create(dto: CreateClienteDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('cliente')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505') throw new BadRequestException('Conflict — cliente already exists');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateClienteDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('cliente')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Cliente ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activo: false }, updatedBy);
  }
}
