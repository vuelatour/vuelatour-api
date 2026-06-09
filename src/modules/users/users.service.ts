import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { EmailService } from '../notifications/email.service';
import type { CreateUsuarioDto } from './dto/create-usuario.dto';
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
  constructor(
    private readonly supabase: SupabaseService,
    private readonly email: EmailService,
  ) {}

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
    return data as UsuarioRow;
  }

  async findByAuthId(authId: string): Promise<UsuarioRow> {
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select(COLUMNS)
      .eq('supabase_auth_id', authId)
      .maybeSingle();

    if (error) throw new Error(`Failed to load usuario: ${error.message}`);
    if (!data) throw new NotFoundException('Usuario not provisioned');
    return data as UsuarioRow;
  }

  /**
   * Crea un usuario sin sesión de Supabase Auth todavía. Se usa para "invitar"
   * a un piloto: queda en estado INVITADO con supabase_auth_id=null. Al primer
   * login con Google, un trigger / proceso de provisión enlaza el auth_id.
   */
  async create(dto: CreateUsuarioDto, createdBy: string): Promise<UsuarioRow> {
    if (!dto.nombre?.trim() || !dto.email?.trim()) {
      throw new BadRequestException('nombre and email are required');
    }

    const payload: Record<string, unknown> = {
      nombre: dto.nombre.trim(),
      email: dto.email.trim().toLowerCase(),
      rol: dto.rol,
      estado: dto.estado ?? 'INVITADO',
      tiene_fondo_caja: dto.tiene_fondo_caja ?? false,
      tarjeta_terminacion: dto.tarjeta_terminacion ?? '',
      es_piloto_externo: dto.es_piloto_externo ?? false,
      telefono: dto.telefono ?? '',
      avatar_url: '',
      created_by: createdBy,
      updated_by: createdBy,
    };

    const { data, error } = await this.supabase.service
      .from('usuario')
      .insert(payload)
      .select(COLUMNS)
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(`Email already exists: ${dto.email}`);
      }
      throw new Error(`Failed to create usuario: ${error.message}`);
    }
    const usuario = data as UsuarioRow;
    // Aviso de invitación por correo (best-effort, no bloquea la creación).
    void this.email.sendUserInvitation({
      to: usuario.email,
      nombre: usuario.nombre,
      rol: usuario.rol,
    });
    return usuario;
  }

  /**
   * Reenvía el correo de invitación/acceso a un usuario ya existente. Devuelve
   * si el correo se envió (false si Resend está deshabilitado o falló).
   */
  async resendInvitation(id: string): Promise<{ ok: true; sent: boolean; email: string }> {
    const user = await this.findById(id);
    if (user.estado === 'INACTIVO') {
      throw new BadRequestException(
        'El usuario está inactivo; reactívalo antes de reenviar la invitación.',
      );
    }
    const sent = await this.email.sendUserInvitation({
      to: user.email,
      nombre: user.nombre,
      rol: user.rol,
      reenvio: true,
    });
    return { ok: true, sent, email: user.email };
  }

  async update(id: string, patch: UpdateUsuarioDto, updatedBy: string): Promise<UsuarioRow> {
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
    return data as UsuarioRow;
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
    return data as UsuarioRow;
  }

  async softDelete(id: string, updatedBy: string): Promise<UsuarioRow> {
    return this.update(id, { estado: 'INACTIVO' as never }, updatedBy);
  }

  /**
   * Define / restablece la contraseña de un usuario en Supabase Auth.
   *
   * - Si el usuario YA tiene `supabase_auth_id` (ya inició sesión con Google
   *   alguna vez) se actualiza su password con `auth.admin.updateUserById`.
   * - Si NO tiene `supabase_auth_id` (todavía no se loguea), se crea la cuenta
   *   en Supabase Auth con su mismo email + password indicado y se enlaza al
   *   row `usuario`. Útil para pre-cargar credenciales de pruebas antes del
   *   primer login.
   *
   * En ambos casos el usuario puede luego loguearse con email/contraseña o
   * con Google (Supabase une cuentas por email).
   */
  async resetPassword(
    id: string,
    newPassword: string,
    actorId: string,
  ): Promise<{ ok: true; created_auth_user: boolean; supabase_auth_id: string }> {
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters');
    }

    const user = await this.findById(id);

    if (user.supabase_auth_id) {
      const { error } = await this.supabase.service.auth.admin.updateUserById(
        user.supabase_auth_id,
        { password: newPassword },
      );
      if (error) {
        throw new Error(`Failed to update password: ${error.message}`);
      }
      return {
        ok: true,
        created_auth_user: false,
        supabase_auth_id: user.supabase_auth_id,
      };
    }

    // No auth user yet — create one with email/password and link.
    const { data: created, error: createErr } =
      await this.supabase.service.auth.admin.createUser({
        email: user.email,
        password: newPassword,
        email_confirm: true,
        user_metadata: { nombre: user.nombre, provisioned_by: actorId },
      });

    if (createErr || !created.user) {
      throw new Error(
        `Failed to create auth user: ${createErr?.message ?? 'unknown error'}`,
      );
    }

    const authId = created.user.id;
    const { error: linkErr } = await this.supabase.service
      .from('usuario')
      .update({ supabase_auth_id: authId, updated_by: actorId })
      .eq('id', id);

    if (linkErr) {
      throw new Error(`Failed to link auth user: ${linkErr.message}`);
    }

    return {
      ok: true,
      created_auth_user: true,
      supabase_auth_id: authId,
    };
  }
}
