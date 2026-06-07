import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateMantenimientoDto,
  CreateVencimientoDto,
  EstadoMantenimiento,
  UpdateMantenimientoDto,
} from './dto/engineering.dto';

const MANT_COLS =
  'id, aeronave_id, estado, pais, tipo, descripcion, fecha_programada, fecha_realizada, horas_aeronave, costo_usd, proveedor, notas, created_at';

/** El campo legado `tipo` (NOT NULL) se mantiene en sync con el nuevo `estado`. */
function tipoFromEstado(estado: EstadoMantenimiento): 'PROGRAMADO' | 'REALIZADO' {
  return estado === 'COMPLETADO' ? 'REALIZADO' : 'PROGRAMADO';
}

const VENC_COLS =
  'id, aeronave_id, tipo_documento_id, motor_id, piloto_id, vence_por, fecha_vencimiento, horas_limite, umbral_alerta_dias, referencia, archivo_url, notas, created_at';

@Injectable()
export class EngineeringService {
  constructor(private readonly supabase: SupabaseService) {}

  // ===== Mantenimientos =====

  async listMantenimientos(aeronaveId: string) {
    const { data, error } = await this.supabase.service
      .from('mantenimiento')
      .select(MANT_COLS)
      .eq('aeronave_id', aeronaveId)
      .order('fecha_programada', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createMantenimiento(aeronaveId: string, dto: CreateMantenimientoDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('mantenimiento')
      .insert({
        aeronave_id: aeronaveId,
        estado: dto.estado,
        tipo: tipoFromEstado(dto.estado),
        pais: dto.pais ?? null,
        descripcion: dto.descripcion,
        fecha_programada: dto.fecha_programada ?? null,
        fecha_realizada: dto.fecha_realizada ?? null,
        horas_aeronave: dto.horas_aeronave ?? null,
        costo_usd: dto.costo_usd ?? null,
        proveedor: dto.proveedor ?? null,
        notas: dto.notas ?? null,
        created_by: userId,
      })
      .select(MANT_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  /** Actualiza un servicio (incluye transicionar estado programado→en taller→completado). */
  async updateMantenimiento(id: string, dto: UpdateMantenimientoDto) {
    const patch: Record<string, unknown> = {};
    if (dto.estado !== undefined) {
      patch.estado = dto.estado;
      patch.tipo = tipoFromEstado(dto.estado);
    }
    if (dto.descripcion !== undefined) patch.descripcion = dto.descripcion;
    if (dto.pais !== undefined) patch.pais = dto.pais;
    if (dto.fecha_programada !== undefined) patch.fecha_programada = dto.fecha_programada;
    if (dto.fecha_realizada !== undefined) patch.fecha_realizada = dto.fecha_realizada;
    if (dto.horas_aeronave !== undefined) patch.horas_aeronave = dto.horas_aeronave;
    if (dto.costo_usd !== undefined) patch.costo_usd = dto.costo_usd;
    if (dto.proveedor !== undefined) patch.proveedor = dto.proveedor;
    if (dto.notas !== undefined) patch.notas = dto.notas;

    const query = this.supabase.service.from('mantenimiento');
    const { data, error } =
      Object.keys(patch).length === 0
        ? await query.select(MANT_COLS).eq('id', id).maybeSingle()
        : await query.update(patch).eq('id', id).select(MANT_COLS).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Mantenimiento ${id} not found`);
    return data;
  }

  // ===== Vencimientos (permisos/licencias/servicios por fecha u horas) =====

  async listVencimientos(aeronaveId: string) {
    const { data, error } = await this.supabase.service
      .from('vencimiento')
      .select(`${VENC_COLS}, tipo_documento(nombre, es_critico)`)
      .eq('aeronave_id', aeronaveId)
      .order('fecha_vencimiento', { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createVencimiento(aeronaveId: string, dto: CreateVencimientoDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('vencimiento')
      .insert({
        aeronave_id: aeronaveId,
        tipo_documento_id: dto.tipo_documento_id,
        motor_id: dto.motor_id ?? null,
        piloto_id: dto.piloto_id ?? null,
        vence_por: dto.vence_por,
        fecha_vencimiento: dto.fecha_vencimiento ?? null,
        horas_limite: dto.horas_limite ?? null,
        umbral_alerta_dias: dto.umbral_alerta_dias ?? null,
        referencia: dto.referencia ?? null,
        notas: dto.notas ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select(VENC_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async documentTypes() {
    const { data, error } = await this.supabase.service
      .from('tipo_documento')
      .select('id, nombre, ambito, umbral_alerta_dias, es_critico')
      .eq('activo', true)
      .order('nombre');
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  // ===== Dashboard consolidado de flota =====

  /** Vencimientos por fecha de toda la flota dentro de la ventana (incluye vencidos). */
  async fleetUpcoming(dias: number) {
    const limite = new Date(Date.now() + dias * 86400 * 1000).toISOString().slice(0, 10);

    const { data: vencimientos, error: vErr } = await this.supabase.service
      .from('vencimiento')
      .select(
        'id, fecha_vencimiento, vence_por, horas_limite, referencia, aeronave_id, tipo_documento(nombre, es_critico), aeronave(matricula)',
      )
      .eq('vence_por', 'FECHA')
      .not('fecha_vencimiento', 'is', null)
      .lte('fecha_vencimiento', limite)
      .order('fecha_vencimiento', { ascending: true });
    if (vErr) throw new Error(vErr.message);

    const { data: mantenimientos, error: mErr } = await this.supabase.service
      .from('mantenimiento')
      .select('id, descripcion, fecha_programada, estado, aeronave_id, aeronave(matricula)')
      .neq('estado', 'COMPLETADO')
      .not('fecha_programada', 'is', null)
      .lte('fecha_programada', limite)
      .order('fecha_programada', { ascending: true });
    if (mErr) throw new Error(mErr.message);

    return { vencimientos: vencimientos ?? [], mantenimientos: mantenimientos ?? [] };
  }
}
