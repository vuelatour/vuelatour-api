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

  /**
   * SINCRONÍA tarjeta↔usuario (26-ago): la FUENTE DE VERDAD del vínculo es
   * tarjeta_corporativa.usuario_id (la app preselecciona la tarjeta del
   * usuario por él y los tableros resuelven titulares contra el catálogo);
   * usuario.tarjeta_terminacion es un ESPEJO derivado (columna "Tarjeta" de
   * Usuarios, perfil del piloto, default informativo). Tras CUALQUIER
   * escritura del vínculo se recalcula el espejo de los usuarios afectados
   * desde el catálogo — con varias tarjetas vinculadas, el espejo apunta a
   * la vinculada más recientemente. Jamás editar el espejo por fuera
   * (users.service delega aquí su lado del vínculo).
   */
  async recalcularEspejoUsuario(
    usuarioIds: Array<string | null | undefined>,
  ): Promise<void> {
    const ids = [...new Set(usuarioIds.filter((v): v is string => !!v))];
    for (const uid of ids) {
      const { data, error: qErr } = await this.supabase.service
        .from('tarjeta_corporativa')
        .select('terminacion')
        .eq('usuario_id', uid)
        .eq('activa', true)
        .order('updated_at', { ascending: false })
        .limit(1);
      if (qErr) throw new Error(qErr.message);
      const { error } = await this.supabase.service
        .from('usuario')
        .update({
          tarjeta_terminacion:
            ((data?.[0]?.terminacion as string | undefined) ?? '') || '',
        })
        .eq('id', uid);
      // Un espejo fallido = divergencia silenciosa: mejor tronar y reintentar.
      if (error) throw new Error(error.message);
    }
  }

  async create(dto: CreateCardDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('terminacion already exists');
      if (error.code === '23503')
        throw new BadRequestException(
          'usuario_id or cuenta_bancaria_id does not exist',
        );
      throw new Error(error.message);
    }
    if (data?.usuario_id) {
      await this.recalcularEspejoUsuario([data.usuario_id as string]);
    }
    return data!;
  }

  async update(id: string, dto: UpdateCardDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    // Dueño ANTES del cambio: su espejo también se recalcula (cubre cambio
    // de usuario, cambio de terminación y desactivación de la tarjeta).
    const prev = (await this.findById(id)) as { usuario_id: string | null };
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('terminacion collision');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Tarjeta ${id} not found`);
    await this.recalcularEspejoUsuario([
      prev.usuario_id,
      data.usuario_id as string | null,
    ]);
    return data;
  }

  async linkUser(id: string, usuarioId: string | null, updatedBy: string) {
    const prev = (await this.findById(id)) as { usuario_id: string | null };
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .update({ usuario_id: usuarioId, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException('usuario_id does not exist');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Tarjeta ${id} not found`);
    await this.recalcularEspejoUsuario([
      prev.usuario_id,
      data.usuario_id as string | null,
    ]);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activa: false }, updatedBy);
  }
}
