import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateProveedorDto,
  ListProveedoresQuery,
  UpdateProveedorDto,
} from './dto/providers.dto';

const COLS =
  'id, nombre, rfc, tipo, pais, email, telefono, direccion, contacto, notas, activo, created_at, updated_at';

@Injectable()
export class ProvidersService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListProveedoresQuery) {
    let q = this.supabase.service
      .from('proveedor')
      .select(COLS, { count: 'exact' })
      .order('nombre', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.tipo) q = q.eq('tipo', filters.tipo);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(`nombre.ilike.${term},rfc.ilike.${term}`);
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
      .from('proveedor')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Proveedor ${id} not found`);
    return data;
  }

  /**
   * Nombre ya usado por OTRO proveedor activo (20-oct-2026, invariante 98):
   * sin acentos, mayúsculas ni espacios de más. El alta y el cambio de
   * nombre en línea desde el gasto responden 409 `PROVEEDOR_DUPLICADO` con
   * el existente, para que el panel lo elija en vez de duplicarlo.
   */
  private async assertNombreLibre(nombre: string, excepto?: string) {
    const clave = normalizarNombreProveedor(nombre);
    if (!clave) return;
    const { data, error } = await this.supabase.service
      .from('proveedor')
      .select('id, nombre')
      .eq('activo', true)
      .limit(2000);
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as Array<{ id: string; nombre: string }>;
    const otro = filas.find(
      (p) =>
        p.id !== excepto && normalizarNombreProveedor(p.nombre ?? '') === clave,
    );
    if (otro) {
      throw new ConflictException({
        message: `Ya existe el proveedor «${otro.nombre}»: elígelo de la lista.`,
        error: 'PROVEEDOR_DUPLICADO',
        details: { id: otro.id, nombre: otro.nombre },
      });
    }
  }

  async create(dto: CreateProveedorDto, createdBy: string) {
    await this.assertNombreLibre(dto.nombre);
    const { data, error } = await this.supabase.service
      .from('proveedor')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('Conflict on unique field');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateProveedorDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    if (typeof dto.nombre === 'string') {
      await this.assertNombreLibre(dto.nombre, id);
    }
    const { data, error } = await this.supabase.service
      .from('proveedor')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Proveedor ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activo: false }, updatedBy);
  }
}

/** «Gas Natural del Sureste, S.A.» y «gas natural del sureste sa» chocan. */
export function normalizarNombreProveedor(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}
