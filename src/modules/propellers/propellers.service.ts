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

  /**
   * Horas actuales (último Hobbs) de un avión = máximo tacómetro registrado.
   * Regla de asignación por tramo: cuenta el tramo si `escala.aeronave_id` es
   * este avión, o si la escala no tiene avión propio y el vuelo sí lo es —
   * filtrar solo por `vuelo.aeronave_id` mezclaba lecturas de tramos volados
   * en OTRO avión.
   */
  private async currentHobbs(aeronaveId: string): Promise<number> {
    const [propias, heredadas] = await Promise.all([
      this.supabase.service
        .from('escala')
        .select('taco_salida, taco_llegada, vuelo:vuelo_id!inner(estado)')
        .eq('aeronave_id', aeronaveId)
        .neq('vuelo.estado', 'CANCELADO'),
      this.supabase.service
        .from('escala')
        .select(
          'taco_salida, taco_llegada, vuelo:vuelo_id!inner(aeronave_id, estado)',
        )
        .is('aeronave_id', null)
        .eq('vuelo.aeronave_id', aeronaveId)
        .neq('vuelo.estado', 'CANCELADO'),
    ]);
    // Nunca degradar a hobbs=0 en silencio: re-anclaría aeronave_horas_ref
    // en 0 y las horas vivas se inflarían con todo el histórico.
    if (propias.error) throw new Error(propias.error.message);
    if (heredadas.error) throw new Error(heredadas.error.message);
    const escalas = [
      ...((propias.data ?? []) as Array<Record<string, unknown>>),
      ...((heredadas.data ?? []) as Array<Record<string, unknown>>),
    ];
    let max = 0;
    for (const e of escalas) {
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
    // Re-anclar aeronave_horas_ref SOLO con cambio real de horas_totales: el
    // form del panel reenvía todos los campos, y re-anclar con el mismo valor
    // borraría las horas vivas acumuladas desde el último anclaje
    // (horas vivas = horas_totales + hobbs − ref). Valor igual → se ignora.
    if (dto.horas_totales !== undefined) {
      const helice = await this.findById(id);
      if (Number(dto.horas_totales) === Number(helice.horas_totales)) {
        delete patch.horas_totales;
      } else {
        patch.aeronave_horas_ref = await this.currentHobbs(
          helice.aeronave_id as string,
        );
      }
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
