import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateIssuingEntityDto,
  ListIssuingEntitiesQuery,
  UpdateIssuingEntityDto,
} from './dto/issuing-entities.dto';

const COLS =
  'id, codigo, razon_social, rfc, regimen_fiscal_sat, codigo_postal, direccion, email_facturacion, telefono, pac_proveedor, notas, activa, created_at, updated_at';

@Injectable()
export class IssuingEntitiesService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListIssuingEntitiesQuery) {
    let q = this.supabase.service
      .from('entidad_fiscal_emisora')
      .select(COLS, { count: 'exact' })
      .order('codigo', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (typeof filters.activa === 'boolean') q = q.eq('activa', filters.activa);
    else q = q.eq('activa', true);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(
        `codigo.ilike.${term},razon_social.ilike.${term},rfc.ilike.${term}`,
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
      .from('entidad_fiscal_emisora')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Entidad fiscal ${id} not found`);
    return data;
  }

  async findByCodigo(codigo: string) {
    const { data, error } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .select(COLS)
      .eq('codigo', codigo.toUpperCase())
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new NotFoundException(`Entidad fiscal ${codigo} not found`);
    return data;
  }

  async create(dto: CreateIssuingEntityDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .insert({
        ...dto,
        codigo: dto.codigo.toUpperCase(),
        created_by: createdBy,
        updated_by: createdBy,
      })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('codigo or rfc already exists');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateIssuingEntityDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const patch: Record<string, unknown> = { ...dto, updated_by: updatedBy };
    if (dto.codigo) patch.codigo = dto.codigo.toUpperCase();
    const { data, error } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .update(patch)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('codigo or rfc collision');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Entidad fiscal ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activa: false }, updatedBy);
  }
}
