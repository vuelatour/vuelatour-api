import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { CreateMultaDto, ListMultasQuery, UpdateMultaDto } from './dto/multas.dto';

const COLS =
  'id, aeronave_id, piloto_id, fecha, monto, moneda, autoridad, descripcion, estado, referencia, notas, created_at, updated_at';
const LIST_COLS = `${COLS}, aeronave:aeronave_id(matricula), piloto:piloto_id(nombre)`;

@Injectable()
export class MultasService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListMultasQuery) {
    let q = this.supabase.service
      .from('multa')
      .select(LIST_COLS, { count: 'exact' })
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.piloto_id) q = q.eq('piloto_id', filters.piloto_id);
    if (filters.estado) q = q.eq('estado', filters.estado);
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { data: data ?? [], count: count ?? 0, limit: filters.limit, offset: filters.offset };
  }

  async create(dto: CreateMultaDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('multa')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async update(id: string, dto: UpdateMultaDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('multa')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Multa ${id} not found`);
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase.service.from('multa').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return { ok: true };
  }
}
