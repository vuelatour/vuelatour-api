import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { ListAeronavesQuery } from './dto/list-aeronaves.query';
import type { CreateAeronaveDto } from './dto/create-aeronave.dto';
import type { UpdateAeronaveDto } from './dto/update-aeronave.dto';
import type {
  CreateAeronaveSocioDto,
  UpdateAeronaveSocioDto,
} from './dto/upsert-aeronave-socio.dto';
import type {
  CreateAeronaveImagenDto,
  UpdateAeronaveImagenDto,
} from './dto/aeronave-imagen.dto';

const AERONAVE_COLS =
  'id, matricula, modelo, pais_registro, num_motores, velocidad_crucero_kts, asientos, tarifa_hora_pub_usd, tarifa_hora_broker_usd, reserva_overhaul_hr_usd, color_calendario, ubicacion_base, activa, notas, created_at, updated_at';

const IMAGEN_COLS =
  'id, aeronave_id, storage_path, url, alt_text, orden, es_principal, size_bytes, content_type, created_at, updated_at';

const IMAGENES_BUCKET = 'aeronave-imagenes';

@Injectable()
export class AircraftService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListAeronavesQuery) {
    let query = this.supabase.service
      .from('aeronave')
      .select(AERONAVE_COLS, { count: 'exact' })
      .order('matricula', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.pais_registro) query = query.eq('pais_registro', filters.pais_registro);
    if (typeof filters.activa === 'boolean') query = query.eq('activa', filters.activa);
    if (filters.q) {
      const term = `%${filters.q}%`;
      query = query.or(`matricula.ilike.${term},modelo.ilike.${term}`);
    }

    const { data, error, count } = await query;
    if (error) throw new Error(`list aeronaves failed: ${error.message}`);
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .select(AERONAVE_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Aeronave ${id} not found`);
    return data;
  }

  async getSnapshot(id: string) {
    const aeronave = await this.findById(id);
    const [motorsRes, propellersRes, ownersRes, reservesRes, imagenesRes] =
      await Promise.all([
        this.supabase.service
          .from('motor')
          .select('id, posicion, numero_serie, tipo, horas_totales, turm, tbo_horas')
          .eq('aeronave_id', id)
          .order('posicion'),
        this.supabase.service
          .from('helice')
          .select('id, posicion, numero_serie, horas_totales, tbo_horas')
          .eq('aeronave_id', id)
          .order('posicion'),
        this.supabase.service
          .from('aeronave_socio')
          .select('id, socio_id, porcentaje, vigente_desde, vigente_hasta, notas, usuario:socio_id(nombre, es_empresa, rol)')
          .eq('aeronave_id', id)
          .is('vigente_hasta', null)
          .order('porcentaje', { ascending: false }),
        this.supabase.service
          .from('reserva_overhaul')
          .select('id, motor_id, monto_por_hora_usd, horas_acumuladas')
          .eq('aeronave_id', id),
        this.supabase.service
          .from('aeronave_imagen')
          .select(IMAGEN_COLS)
          .eq('aeronave_id', id)
          .order('orden', { ascending: true })
          .order('created_at', { ascending: true }),
      ]);
    if (motorsRes.error) throw new Error(motorsRes.error.message);
    if (propellersRes.error) throw new Error(propellersRes.error.message);
    if (ownersRes.error) throw new Error(ownersRes.error.message);
    if (reservesRes.error) throw new Error(reservesRes.error.message);
    if (imagenesRes.error) throw new Error(imagenesRes.error.message);

    return {
      ...aeronave,
      motors: motorsRes.data ?? [],
      propellers: propellersRes.data ?? [],
      owners: ownersRes.data ?? [],
      overhaul_reserves: reservesRes.data ?? [],
      imagenes: imagenesRes.data ?? [],
    };
  }

  async create(dto: CreateAeronaveDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(AERONAVE_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505') throw new BadRequestException('matricula already exists');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateAeronaveDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(AERONAVE_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Aeronave ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activa: false }, updatedBy);
  }

  // ============ OWNERSHIP ============

  async listOwners(aeronaveId: string, includeHistory: boolean) {
    let q = this.supabase.service
      .from('aeronave_socio')
      .select(
        'id, socio_id, porcentaje, vigente_desde, vigente_hasta, notas, created_at, updated_at, usuario:socio_id(nombre, email, rol, es_empresa)',
      )
      .eq('aeronave_id', aeronaveId)
      .order('vigente_desde', { ascending: false });
    if (!includeHistory) q = q.is('vigente_hasta', null);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createOwner(aeronaveId: string, dto: CreateAeronaveSocioDto, createdBy: string) {
    await this.findById(aeronaveId);
    const { data, error } = await this.supabase.service
      .from('aeronave_socio')
      .insert({
        aeronave_id: aeronaveId,
        socio_id: dto.socio_id,
        porcentaje: dto.porcentaje,
        vigente_desde: dto.vigente_desde.toISOString().slice(0, 10),
        vigente_hasta: dto.vigente_hasta?.toISOString().slice(0, 10),
        notas: dto.notas,
        created_by: createdBy,
        updated_by: createdBy,
      })
      .select('id, socio_id, porcentaje, vigente_desde, vigente_hasta, notas')
      .maybeSingle();
    if (error) {
      if (error.code === '23503') throw new BadRequestException('socio_id does not exist');
      throw new Error(error.message);
    }
    return data!;
  }

  async updateOwner(ownerId: string, dto: UpdateAeronaveSocioDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('Empty patch');
    }
    const patch: Record<string, unknown> = { updated_by: updatedBy };
    if (dto.porcentaje !== undefined) patch.porcentaje = dto.porcentaje;
    if (dto.vigente_hasta !== undefined)
      patch.vigente_hasta = dto.vigente_hasta.toISOString().slice(0, 10);
    if (dto.notas !== undefined) patch.notas = dto.notas;

    const { data, error } = await this.supabase.service
      .from('aeronave_socio')
      .update(patch)
      .eq('id', ownerId)
      .select('id, aeronave_id, socio_id, porcentaje, vigente_desde, vigente_hasta, notas')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`aeronave_socio ${ownerId} not found`);
    return data;
  }

  async closeOwner(ownerId: string, vigenteHasta: Date, updatedBy: string) {
    return this.updateOwner(ownerId, { vigente_hasta: vigenteHasta }, updatedBy);
  }

  async listOverhaulReserves(aeronaveId: string) {
    await this.findById(aeronaveId);
    const { data, error } = await this.supabase.service
      .from('reserva_overhaul')
      .select('id, motor_id, monto_por_hora_usd, horas_acumuladas, notas, motor:motor_id(posicion, numero_serie)')
      .eq('aeronave_id', aeronaveId);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  // ============ Imagenes ============

  async listImagenes(aeronaveId: string) {
    await this.findById(aeronaveId);
    const { data, error } = await this.supabase.service
      .from('aeronave_imagen')
      .select(IMAGEN_COLS)
      .eq('aeronave_id', aeronaveId)
      .order('orden', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createImagen(
    aeronaveId: string,
    dto: CreateAeronaveImagenDto,
    userId: string,
  ) {
    await this.findById(aeronaveId);

    // Si es_principal=true, desmarcamos cualquier otra previa (unique index lo
    // exige y damos UX consistente sin pedir al frontend hacer dos llamadas).
    if (dto.es_principal) {
      await this.unsetPrincipal(aeronaveId);
    }

    // Si no hay imagenes todavia, esta automaticamente es la principal.
    const existing = await this.listImagenes(aeronaveId);
    const esPrincipal = dto.es_principal ?? existing.length === 0;
    const nextOrden =
      existing.length > 0 ? Math.max(...existing.map((i) => i.orden)) + 1 : 0;

    const { data, error } = await this.supabase.service
      .from('aeronave_imagen')
      .insert({
        aeronave_id: aeronaveId,
        storage_path: dto.storage_path,
        url: dto.url,
        alt_text: dto.alt_text,
        es_principal: esPrincipal,
        orden: nextOrden,
        size_bytes: dto.size_bytes,
        content_type: dto.content_type,
        created_by: userId,
        updated_by: userId,
      })
      .select(IMAGEN_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }

  async updateImagen(
    imagenId: string,
    dto: UpdateAeronaveImagenDto,
    userId: string,
  ) {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('Empty patch');
    }

    // Cargamos primero para resolver aeronave_id antes de tocar principales.
    const { data: current, error: currentErr } = await this.supabase.service
      .from('aeronave_imagen')
      .select('id, aeronave_id, es_principal')
      .eq('id', imagenId)
      .maybeSingle();
    if (currentErr) throw new Error(currentErr.message);
    if (!current) throw new NotFoundException(`imagen ${imagenId} not found`);

    // Si vamos a marcar como principal, desmarcamos las otras.
    if (dto.es_principal === true && !current.es_principal) {
      await this.unsetPrincipal(current.aeronave_id);
    }

    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.alt_text !== undefined) patch.alt_text = dto.alt_text;
    if (dto.orden !== undefined) patch.orden = dto.orden;
    if (dto.es_principal !== undefined) patch.es_principal = dto.es_principal;

    const { data, error } = await this.supabase.service
      .from('aeronave_imagen')
      .update(patch)
      .eq('id', imagenId)
      .select(IMAGEN_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`imagen ${imagenId} not found`);
    return data;
  }

  async deleteImagen(imagenId: string) {
    const { data: current, error: currentErr } = await this.supabase.service
      .from('aeronave_imagen')
      .select('id, aeronave_id, storage_path, es_principal')
      .eq('id', imagenId)
      .maybeSingle();
    if (currentErr) throw new Error(currentErr.message);
    if (!current) throw new NotFoundException(`imagen ${imagenId} not found`);

    // 1. Borramos el archivo del bucket (best-effort; si falla, no bloqueamos
    //    el delete de la fila para no dejar registros huerfanos).
    const { error: storageErr } = await this.supabase.service.storage
      .from(IMAGENES_BUCKET)
      .remove([current.storage_path]);
    if (storageErr) {
      // eslint-disable-next-line no-console
      console.warn(
        `Could not remove storage object ${current.storage_path}: ${storageErr.message}`,
      );
    }

    // 2. Borramos la fila.
    const { error } = await this.supabase.service
      .from('aeronave_imagen')
      .delete()
      .eq('id', imagenId);
    if (error) throw new Error(error.message);

    // 3. Si era la principal, promovemos a la siguiente (la de menor orden).
    if (current.es_principal) {
      const next = await this.listImagenes(current.aeronave_id);
      if (next.length > 0) {
        await this.supabase.service
          .from('aeronave_imagen')
          .update({ es_principal: true })
          .eq('id', next[0].id);
      }
    }

    return { ok: true };
  }

  private async unsetPrincipal(aeronaveId: string): Promise<void> {
    const { error } = await this.supabase.service
      .from('aeronave_imagen')
      .update({ es_principal: false })
      .eq('aeronave_id', aeronaveId)
      .eq('es_principal', true);
    if (error) throw new Error(error.message);
  }
}
