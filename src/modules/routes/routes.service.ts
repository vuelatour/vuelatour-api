import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateRouteDto,
  ListRoutesQuery,
  UpdateRouteDto,
} from './dto/routes.dto';

const COLS =
  'id, origen_iata, destino_iata, millas_nauticas, es_redondo_auto, num_aterrizajes, fuente, notas, activa, created_at, updated_at';

@Injectable()
export class RoutesService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListRoutesQuery) {
    let q = this.supabase.service
      .from('ruta_predefinida')
      .select(COLS, { count: 'exact' })
      .order('origen_iata', { ascending: true })
      .order('destino_iata', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activa === 'boolean') q = q.eq('activa', filters.activa);
    else q = q.eq('activa', true);
    if (filters.origen) q = q.eq('origen_iata', filters.origen.toUpperCase());
    if (filters.destino) q = q.eq('destino_iata', filters.destino.toUpperCase());
    if (filters.q) {
      const term = `%${filters.q.toUpperCase()}%`;
      q = q.or(`origen_iata.ilike.${term},destino_iata.ilike.${term}`);
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
      .from('ruta_predefinida')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Ruta ${id} not found`);
    return data;
  }

  async findByOriginDestination(origen: string, destino: string) {
    const { data, error } = await this.supabase.service
      .from('ruta_predefinida')
      .select(COLS)
      .eq('origen_iata', origen.toUpperCase())
      .eq('destino_iata', destino.toUpperCase())
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async create(dto: CreateRouteDto, createdBy: string) {
    if (dto.origen_iata.toUpperCase() === dto.destino_iata.toUpperCase()) {
      throw new BadRequestException('origen_iata y destino_iata no pueden ser iguales');
    }
    const { data, error } = await this.supabase.service
      .from('ruta_predefinida')
      .insert({
        ...dto,
        origen_iata: dto.origen_iata.toUpperCase(),
        destino_iata: dto.destino_iata.toUpperCase(),
        created_by: createdBy,
        updated_by: createdBy,
      })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('Route already exists (origen+destino)');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateRouteDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const patch: Record<string, unknown> = { ...dto, updated_by: updatedBy };
    if (dto.origen_iata) patch.origen_iata = dto.origen_iata.toUpperCase();
    if (dto.destino_iata) patch.destino_iata = dto.destino_iata.toUpperCase();
    const { data, error } = await this.supabase.service
      .from('ruta_predefinida')
      .update(patch)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('Conflict: origen+destino combination already exists');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Ruta ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activa: false }, updatedBy);
  }
}
