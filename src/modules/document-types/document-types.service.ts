import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateTipoDocumentoDto,
  ListTiposDocumentoQuery,
  UpdateTipoDocumentoDto,
} from './dto/document-types.dto';

const COLS =
  'id, nombre, ambito, forma_default, umbral_alerta_dias, es_critico, notas, activo, created_at, updated_at';

@Injectable()
export class DocumentTypesService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListTiposDocumentoQuery) {
    let q = this.supabase.service
      .from('tipo_documento')
      .select(COLS, { count: 'exact' })
      .order('ambito', { ascending: true })
      .order('nombre', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.ambito) q = q.eq('ambito', filters.ambito);
    if (filters.q) q = q.ilike('nombre', `%${filters.q}%`);

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
      .from('tipo_documento')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Tipo de documento ${id} not found`);
    return data;
  }

  async create(dto: CreateTipoDocumentoDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('tipo_documento')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException(
          `Ya existe un tipo "${dto.nombre}" para el ambito ${dto.ambito}`,
        );
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateTipoDocumentoDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('tipo_documento')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('Conflicto: nombre + ambito ya existe');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Tipo de documento ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activo: false }, updatedBy);
  }
}
