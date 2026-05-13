import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateCardDto,
  ListCardsQuery,
  UpdateCardDto,
} from './dto/cards.dto';

const COLS =
  'id, terminacion, nombre_titular, usuario_id, banco, cuenta_bancaria_id, notas, activa, created_at, updated_at';

@Injectable()
export class CardsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListCardsQuery) {
    let q = this.supabase.service
      .from('tarjeta_corporativa')
      .select(COLS, { count: 'exact' })
      .order('terminacion', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (typeof filters.activa === 'boolean') q = q.eq('activa', filters.activa);
    else q = q.eq('activa', true);
    if (filters.usuario_id) q = q.eq('usuario_id', filters.usuario_id);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(`terminacion.ilike.${term},nombre_titular.ilike.${term}`);
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
      .from('tarjeta_corporativa')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Tarjeta ${id} not found`);
    return data;
  }

  async create(dto: CreateCardDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505') throw new ConflictException('terminacion already exists');
      if (error.code === '23503')
        throw new BadRequestException('usuario_id or cuenta_bancaria_id does not exist');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateCardDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505') throw new ConflictException('terminacion collision');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Tarjeta ${id} not found`);
    return data;
  }

  async linkUser(id: string, usuarioId: string | null, updatedBy: string) {
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .update({ usuario_id: usuarioId, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503') throw new BadRequestException('usuario_id does not exist');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Tarjeta ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activa: false }, updatedBy);
  }
}
