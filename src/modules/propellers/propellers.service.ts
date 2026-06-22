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
  'id, aeronave_id, posicion, numero_serie, fabricante, modelo, horas_totales, tbo_horas, aeronave_horas_ref, notas, created_at, updated_at';

@Injectable()
export class PropellersService {
  constructor(private readonly supabase: SupabaseService) {}

  /** Horas actuales (último Hobbs) de un avión = máximo tacómetro registrado. */
  private async currentHobbs(aeronaveId: string): Promise<number> {
    const { data } = await this.supabase.service
      .from('escala')
      .select('taco_salida, taco_llegada, vuelo:vuelo_id!inner(aeronave_id, estado)')
      .eq('vuelo.aeronave_id', aeronaveId)
      .neq('vuelo.estado', 'CANCELADO');
    let max = 0;
    for (const e of (data ?? []) as Array<Record<string, unknown>>) {
      for (const v of [e.taco_salida, e.taco_llegada]) {
        if (v != null) max = Math.max(max, Number(v));
      }
    }
    return Number(max.toFixed(1));
  }

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
    const ref = await this.currentHobbs(dto.aeronave_id);
    const { data, error } = await this.supabase.service
      .from('helice')
      .insert({
        ...dto,
        aeronave_horas_ref: ref,
        created_by: createdBy,
        updated_by: createdBy,
      })
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
    const patch: Record<string, unknown> = { ...dto, updated_by: updatedBy };
    if (dto.horas_totales !== undefined) {
      const helice = await this.findById(id);
      patch.aeronave_horas_ref = await this.currentHobbs(
        helice.aeronave_id as string,
      );
    }
    const { data, error } = await this.supabase.service
      .from('helice')
      .update(patch)
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
