import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateEngineDto,
  ListEnginesQuery,
  TransplantEngineDto,
  UpdateEngineDto,
} from './dto/engines.dto';

const COLS =
  'id, aeronave_id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tbo_horas, notas, created_at, updated_at';

@Injectable()
export class EnginesService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListEnginesQuery) {
    let q = this.supabase.service
      .from('motor')
      .select(COLS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.tipo) q = q.eq('tipo', filters.tipo);
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
      .from('motor')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Motor ${id} not found`);
    return data;
  }

  async create(dto: CreateEngineDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('motor')
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

  async update(id: string, dto: UpdateEngineDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('motor')
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
    if (!data) throw new NotFoundException(`Motor ${id} not found`);
    return data;
  }

  async transplant(id: string, dto: TransplantEngineDto, performedBy: string) {
    const motor = await this.findById(id);

    if (
      motor.aeronave_id === dto.aeronave_destino_id &&
      motor.posicion === dto.posicion_destino
    ) {
      throw new BadRequestException(
        'Destination aircraft+position equals current placement',
      );
    }

    const aeronaveOrigenId = motor.aeronave_id as string;
    const posicionOrigen = motor.posicion as string;

    const { error: updErr } = await this.supabase.service
      .from('motor')
      .update({
        aeronave_id: dto.aeronave_destino_id,
        posicion: dto.posicion_destino,
        updated_by: performedBy,
      })
      .eq('id', id);
    if (updErr) {
      if (updErr.code === '23505')
        throw new ConflictException(
          'Destination (aircraft, position) already has an engine — move the existing one first',
        );
      if (updErr.code === '23503')
        throw new BadRequestException('aeronave_destino_id does not exist');
      throw new Error(updErr.message);
    }

    const { error: logErr } = await this.supabase.service
      .from('motor_traslado')
      .insert({
        motor_id: id,
        aeronave_origen_id: aeronaveOrigenId,
        aeronave_destino_id: dto.aeronave_destino_id,
        posicion_origen: posicionOrigen,
        posicion_destino: dto.posicion_destino,
        horas_al_traslado: motor.horas_totales,
        motivo: dto.motivo,
        trasladado_por: performedBy,
      });
    if (logErr) {
      // Best-effort log; do not reverse the move silently. Surface the error.
      throw new Error(`Motor moved but audit log failed: ${logErr.message}`);
    }

    return this.findById(id);
  }

  async listTransplants(motorId: string) {
    const { data, error } = await this.supabase.service
      .from('motor_traslado')
      .select(
        'id, aeronave_origen_id, aeronave_destino_id, posicion_origen, posicion_destino, horas_al_traslado, motivo, trasladado_at, trasladado_por',
      )
      .eq('motor_id', motorId)
      .order('trasladado_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }
}
