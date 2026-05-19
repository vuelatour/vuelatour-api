import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { ListUsuariosQuery } from './dto/list-usuarios.query';
import type { UpdateUsuarioDto } from './dto/update-usuario.dto';
import type { UpdateSelfDto } from './dto/update-self.dto';

const COLUMNS =
  'id, supabase_auth_id, nombre, email, rol, estado, tiene_fondo_caja, tarjeta_terminacion, es_piloto_externo, telefono, avatar_url, created_at, updated_at';

export interface UsuarioRow {
  id: string;
  supabase_auth_id: string;
  nombre: string;
  email: string;
  rol: string;
  estado: string;
  tiene_fondo_caja: boolean;
  tarjeta_terminacion: string | null;
  es_piloto_externo: boolean;
  telefono: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListUsuariosQuery) {
    let query = this.supabase.service
      .from('usuario')
      .select(COLUMNS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.rol) query = query.eq('rol', filters.rol);
    if (filters.estado) query = query.eq('estado', filters.estado);
    if (filters.q) {
      const term = `%${filters.q}%`;
      query = query.or(`nombre.ilike.${term},email.ilike.${term}`);
    }

    const { data, error, count } = await query;
    if (error) throw new Error(`Failed to list usuarios: ${error.message}`);

    return {
      data: (data ?? []) as UsuarioRow[],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string): Promise<UsuarioRow> {
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select(COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) throw new Error(`Failed to load usuario: ${error.message}`);
    if (!data) throw new NotFoundException(`Usuario ${id} not found`);
    return data;
  }

  async findByAuthId(authId: string): Promise<UsuarioRow> {
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select(COLUMNS)
      .eq('supabase_auth_id', authId)
      .maybeSingle();

    if (error) throw new Error(`Failed to load usuario: ${error.message}`);
    if (!data) throw new NotFoundException('Usuario not provisioned');
    return data;
  }

  async update(
    id: string,
    patch: UpdateUsuarioDto,
    updatedBy: string,
  ): Promise<UsuarioRow> {
    if (Object.keys(patch).length === 0) {
      return this.findById(id);
    }
    const { data, error } = await this.supabase.service
      .from('usuario')
      .update({ ...patch, updated_by: updatedBy })
      .eq('id', id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw new Error(`Failed to update usuario: ${error.message}`);
    if (!data) throw new NotFoundException(`Usuario ${id} not found`);
    return data;
  }

  async updateSelf(
    authId: string,
    patch: UpdateSelfDto,
    updatedBy: string,
  ): Promise<UsuarioRow> {
    if (Object.keys(patch).length === 0) {
      return this.findByAuthId(authId);
    }
    const { data, error } = await this.supabase.service
      .from('usuario')
      .update({ ...patch, updated_by: updatedBy })
      .eq('supabase_auth_id', authId)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw new Error(`Failed to update self: ${error.message}`);
    if (!data) throw new NotFoundException('Usuario not provisioned');
    return data;
  }

  async softDelete(id: string, updatedBy: string): Promise<UsuarioRow> {
    return this.update(id, { estado: 'INACTIVO' as never }, updatedBy);
  }
}
