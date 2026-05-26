import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreatePropellerDto,
  ListPropellersQuery,
  UpdatePropellerDto,
} from './dto/propellers.dto';

const COLS =
  'id, aeronave_id, posicion, numero_serie, fabricante, modelo, horas_totales, tbo_horas, notas, created_at, updated_at';

@Injectable()
export class PropellersService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListPropellersQuery) {
    let q = this.supabase.service
      .from('helice')
      .select(COLS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.posicion) q = q.eq('posicion', filters.posicion);
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
      .from('helice')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Hélice ${id} not found`);
    return data;
  }

  async create(dto: CreatePropellerDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('helice')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          'numero_serie or (aeronave,posicion) already exists',
        );
      if (error.code === '23503')
        throw new BadRequestException('aeronave_id does not exist');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdatePropellerDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('helice')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          'numero_serie or (aeronave,posicion) collision',
        );
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Hélice ${id} not found`);
    return data;
  }
}
