import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateMantenimientoDto,
  CreateVencimientoDto,
  EstadoMantenimiento,
  UpdateMantenimientoDto,
} from './dto/engineering.dto';

const MANT_COLS =
  'id, aeronave_id, estado, pais, tipo, descripcion, fecha_programada, fecha_realizada, horas_aeronave, horas_programadas, costo_usd, proveedor, notas, etapa_intervalo_hr, tareas_realizadas, motor_id, helice_id, created_at';

/** El campo legado `tipo` (NOT NULL) se mantiene en sync con el nuevo `estado`. */
function tipoFromEstado(
  estado: EstadoMantenimiento,
): 'PROGRAMADO' | 'REALIZADO' {
  return estado === 'COMPLETADO' ? 'REALIZADO' : 'PROGRAMADO';
}

const VENC_COLS =
  'id, aeronave_id, tipo_documento_id, motor_id, piloto_id, vence_por, fecha_vencimiento, horas_limite, umbral_alerta_dias, referencia, archivo_url, notas, created_at';

@Injectable()
export class EngineeringService {
  private readonly logger = new Logger(EngineeringService.name);

  constructor(private readonly supabase: SupabaseService) {}

  // ===== Mantenimientos =====

  /**
   * Horas actuales de la aeronave (último Hobbs conocido = máximo tacómetro).
   * Regla de asignación por tramo: cuenta el tramo si `escala.aeronave_id` es
   * este avión, o si la escala no tiene avión propio y el vuelo sí lo es —
   * filtrar solo por `vuelo.aeronave_id` mezclaba lecturas de tramos volados
   * en OTRO avión.
   */
  private async horasActualesAeronave(aeronaveId: string): Promise<number> {
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
    // Nunca degradar a 0 en silencio: registraría horas de entrada falsas.
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

  /**
   * El componente (motor/hélice) de un servicio debe pertenecer al avión del
   * servicio — cruzarlos silenciosamente ensuciaría la bitácora.
   */
  private async validarComponenteDelAvion(
    aeronaveId: string,
    motorId?: string | null,
    heliceId?: string | null,
  ): Promise<void> {
    if (motorId) {
      const { data } = await this.supabase.service
        .from('motor')
        .select('aeronave_id')
        .eq('id', motorId)
        .maybeSingle();
      if (!data || data.aeronave_id !== aeronaveId)
        throw new BadRequestException(
          'El motor indicado no pertenece a esta aeronave',
        );
    }
    if (heliceId) {
      const { data } = await this.supabase.service
        .from('helice')
        .select('aeronave_id')
        .eq('id', heliceId)
        .maybeSingle();
      if (!data || data.aeronave_id !== aeronaveId)
        throw new BadRequestException(
          'La hélice indicada no pertenece a esta aeronave',
        );
    }
  }

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

  async createMantenimiento(
    aeronaveId: string,
    dto: CreateMantenimientoDto,
    userId: string,
  ) {
    // Compat con APKs viejos de la app: mandan `tipo` (PROGRAMADO/REALIZADO)
    // en vez de `estado`. Se mapea REALIZADO→COMPLETADO solo cuando no viene
    // `estado`; el `estado` explícito siempre gana. El DTO garantiza que al
    // menos uno de los dos está presente.
    const estado: EstadoMantenimiento =
      dto.estado ?? (dto.tipo === 'REALIZADO' ? 'COMPLETADO' : 'PROGRAMADO');
    // Al entrar a taller / completarse, si no dieron las horas de entrada, se
    // toman las horas actuales del avión (último tacómetro) automáticamente.
    let horasEntrada = dto.horas_aeronave ?? null;
    if (
      horasEntrada == null &&
      (estado === 'EN_TALLER' || estado === 'COMPLETADO')
    ) {
      horasEntrada = await this.horasActualesAeronave(aeronaveId);
    }
    await this.validarComponenteDelAvion(
      aeronaveId,
      dto.motor_id,
      dto.helice_id,
    );
    const { data, error } = await this.supabase.service
      .from('mantenimiento')
      .insert({
        aeronave_id: aeronaveId,
        estado,
        tipo: tipoFromEstado(estado),
        pais: dto.pais ?? null,
        descripcion: dto.descripcion,
        fecha_programada: dto.fecha_programada ?? null,
        fecha_realizada: dto.fecha_realizada ?? null,
        horas_aeronave: horasEntrada,
        horas_programadas: dto.horas_programadas ?? null,
        costo_usd: dto.costo_usd ?? null,
        proveedor: dto.proveedor ?? null,
        notas: dto.notas ?? null,
        etapa_intervalo_hr: dto.etapa_intervalo_hr ?? null,
        tareas_realizadas: (dto.tareas_realizadas ?? [])
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
        motor_id: dto.motor_id ?? null,
        helice_id: dto.helice_id ?? null,
        // Idempotencia (29-ago): un reintento con la misma llave colisiona
        // en uq_mantenimiento_client_request y devuelve la fila existente.
        client_request_id: dto.client_request_id ?? null,
        created_by: userId,
      })
      .select(MANT_COLS)
      .maybeSingle();
    if (error) {
      // Reintento con la misma llave de idempotencia (timeout tras commit /
      // outbox de la app): se devuelve el mantenimiento YA creado con el
      // mismo shape que un alta normal — el reintento se vuelve inocuo.
      if (
        error.code === '23505' &&
        dto.client_request_id &&
        error.message.includes('uq_mantenimiento_client_request')
      ) {
        const { data: existente, error: exErr } = await this.supabase.service
          .from('mantenimiento')
          .select(MANT_COLS)
          .eq('client_request_id', dto.client_request_id)
          .maybeSingle();
        if (!exErr && existente) {
          this.logger.log(
            `Mantenimiento idempotente: reintento con client_request_id ${dto.client_request_id} → se devuelve el existente ${existente.id as string} (sin duplicar).`,
          );
          return existente;
        }
      }
      throw new Error(error.message);
    }
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
    if (dto.fecha_programada !== undefined)
      patch.fecha_programada = dto.fecha_programada;
    if (dto.fecha_realizada !== undefined)
      patch.fecha_realizada = dto.fecha_realizada;
    if (dto.horas_aeronave !== undefined)
      patch.horas_aeronave = dto.horas_aeronave;
    if (dto.horas_programadas !== undefined)
      patch.horas_programadas = dto.horas_programadas;
    if (dto.costo_usd !== undefined) patch.costo_usd = dto.costo_usd;
    if (dto.proveedor !== undefined) patch.proveedor = dto.proveedor;
    if (dto.notas !== undefined) patch.notas = dto.notas;
    if (dto.etapa_intervalo_hr !== undefined)
      patch.etapa_intervalo_hr = dto.etapa_intervalo_hr;
    if (dto.tareas_realizadas !== undefined)
      patch.tareas_realizadas = dto.tareas_realizadas
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    if (dto.motor_id !== undefined || dto.helice_id !== undefined) {
      const { data: actual } = await this.supabase.service
        .from('mantenimiento')
        .select('aeronave_id')
        .eq('id', id)
        .maybeSingle();
      if (!actual) throw new NotFoundException(`Mantenimiento ${id} not found`);
      await this.validarComponenteDelAvion(
        actual.aeronave_id as string,
        dto.motor_id,
        dto.helice_id,
      );
      if (dto.motor_id !== undefined) patch.motor_id = dto.motor_id;
      if (dto.helice_id !== undefined) patch.helice_id = dto.helice_id;
    }

    // Al pasar a EN_TALLER/COMPLETADO sin horas de entrada, se toman las horas
    // actuales del avión automáticamente (solo si aún no estaban registradas).
    if (
      (dto.estado === 'EN_TALLER' || dto.estado === 'COMPLETADO') &&
      dto.horas_aeronave === undefined
    ) {
      const { data: actual } = await this.supabase.service
        .from('mantenimiento')
        .select('aeronave_id, horas_aeronave')
        .eq('id', id)
        .maybeSingle();
      if (actual && actual.horas_aeronave == null) {
        patch.horas_aeronave = await this.horasActualesAeronave(
          actual.aeronave_id as string,
        );
      }
    }

    const query = this.supabase.service.from('mantenimiento');
    const { data, error } =
      Object.keys(patch).length === 0
        ? await query.select(MANT_COLS).eq('id', id).maybeSingle()
        : await query
            .update(patch)
            .eq('id', id)
            .select(MANT_COLS)
            .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Mantenimiento ${id} not found`);
    return data;
  }

  // ===== Vencimientos (permisos/licencias/servicios por fecha u horas) =====

  async listVencimientos(aeronaveId: string) {
    const { data, error } = await this.supabase.service
      .from('vencimiento')
      .select(
        `${VENC_COLS}, critico, updated_at, created_by, updated_by, tipo_documento(nombre, es_critico)`,
      )
      .eq('aeronave_id', aeronaveId)
      .is('deleted_at', null)
      .order('fecha_vencimiento', { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);
    // Bitácora visible (pedido del mecánico, 18-ago-2026): quién registró y
    // quién editó al último cada documento — una sola consulta de nombres.
    const nombres = await this.nombresUsuarios(
      (data ?? []).flatMap((v) => [
        (v as { created_by?: string | null }).created_by,
        (v as { updated_by?: string | null }).updated_by,
      ]),
    );
    // Crítico EFECTIVO: el override del documento manda sobre el tipo (misma
    // regla que expirations.enrich) — el panel pinta el badge desde aquí.
    return (data ?? []).map((v) => {
      const row = v as Record<string, unknown> & {
        critico?: boolean | null;
        created_by?: string | null;
        updated_by?: string | null;
        tipo_documento?: { nombre?: string; es_critico?: boolean } | null;
      };
      const tipo = Array.isArray(row.tipo_documento)
        ? ((row.tipo_documento[0] ?? null) as {
            nombre?: string;
            es_critico?: boolean;
          } | null)
        : (row.tipo_documento ?? null);
      return {
        ...row,
        registrado_por: row.created_by
          ? (nombres.get(row.created_by) ?? null)
          : null,
        actualizado_por: row.updated_by
          ? (nombres.get(row.updated_by) ?? null)
          : null,
        tipo_documento: tipo
          ? {
              ...tipo,
              es_critico: row.critico ?? tipo.es_critico ?? false,
            }
          : null,
      };
    });
  }

  /**
   * Documentos ELIMINADOS del avión (borrado suave): quién y cuándo, para la
   * sección "Eliminados" de la ficha — de ahí ADMIN/COORDINADOR restauran
   * sin recapturar (pedido del mecánico tras perder Bianual/Batería ELT).
   */
  async listVencimientosEliminados(aeronaveId: string) {
    const { data, error } = await this.supabase.service
      .from('vencimiento')
      .select(
        `${VENC_COLS}, critico, deleted_at, deleted_by, tipo_documento(nombre, es_critico)`,
      )
      .eq('aeronave_id', aeronaveId)
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false });
    if (error) throw new Error(error.message);
    const nombres = await this.nombresUsuarios(
      (data ?? []).map((v) => (v as { deleted_by?: string | null }).deleted_by),
    );
    return (data ?? []).map((v) => {
      const row = v as Record<string, unknown> & {
        deleted_by?: string | null;
        tipo_documento?: { nombre?: string } | { nombre?: string }[] | null;
      };
      const tipo = Array.isArray(row.tipo_documento)
        ? (row.tipo_documento[0] ?? null)
        : (row.tipo_documento ?? null);
      return {
        ...row,
        tipo_documento: tipo,
        eliminado_por: row.deleted_by
          ? (nombres.get(row.deleted_by) ?? null)
          : null,
      };
    });
  }

  /** Nombres de usuario por id (para las bitácoras de documentos). */
  private async nombresUsuarios(
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    if (unicos.length === 0) return new Map();
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('id, nombre')
      .in('id', unicos);
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((u) => [u.id as string, u.nombre as string]),
    );
  }

  async createVencimiento(
    aeronaveId: string,
    dto: CreateVencimientoDto,
    userId: string,
  ) {
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
        // El DTO acepta estos dos (Swagger los documenta): descartarlos en
        // silencio rompía el contrato del alta.
        critico: dto.critico ?? null,
        archivo_url: dto.archivo_url ?? null,
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
  async fleetUpcoming(dias: number, incluirSinFecha = false) {
    const limite = new Date(Date.now() + dias * 86400 * 1000)
      .toISOString()
      .slice(0, 10);

    const { data: vencimientos, error: vErr } = await this.supabase.service
      .from('vencimiento')
      .select(
        'id, fecha_vencimiento, vence_por, horas_limite, referencia, aeronave_id, critico, archivo_url, tipo_documento(nombre, es_critico), aeronave(matricula), piloto:piloto_id(nombre), motor:motor_id(posicion, aeronave_id, aeronave:aeronave_id(matricula))',
      )
      .eq('vence_por', 'FECHA')
      .is('deleted_at', null)
      .not('fecha_vencimiento', 'is', null)
      .lte('fecha_vencimiento', limite)
      .order('fecha_vencimiento', { ascending: true });
    if (vErr) throw new Error(vErr.message);

    const { data: mantenimientos, error: mErr } = await this.supabase.service
      .from('mantenimiento')
      .select(
        'id, descripcion, fecha_programada, estado, aeronave_id, etapa_intervalo_hr, aeronave(matricula)',
      )
      .neq('estado', 'COMPLETADO')
      .not('fecha_programada', 'is', null)
      .lte('fecha_programada', limite)
      .order('fecha_programada', { ascending: true });
    if (mErr) throw new Error(mErr.message);

    // Crítico EFECTIVO también aquí (override ?? tipo): el ⚠ del home del
    // panel, /admin/ingenieria y la app del mecánico salen de este payload y
    // contradecían al badge del detalle del avión.
    const vencs = (vencimientos ?? []).map((v) => {
      const row = v as Record<string, unknown> & {
        critico?: boolean | null;
        archivo_url?: string | null;
        tipo_documento?:
          | { nombre?: string; es_critico?: boolean }
          | { nombre?: string; es_critico?: boolean }[]
          | null;
      };
      const tipo = Array.isArray(row.tipo_documento)
        ? (row.tipo_documento[0] ?? null)
        : (row.tipo_documento ?? null);
      // El path del bucket no sale del API (este payload lo lee también el
      // mecánico en la app): solo la bandera; el panel pide la URL firmada
      // por id con GET /expirations/:id/archivo (solo oficina).
      const { archivo_url, ...rest } = row;
      return {
        ...rest,
        tiene_archivo: !!archivo_url,
        tipo_documento: tipo
          ? { ...tipo, es_critico: row.critico ?? tipo.es_critico ?? false }
          : null,
      };
    });
    // PROGRAMADO sin fecha (auto-creados por el programa de horas): van AL
    // FRENTE — son los accionables ("confirma la fecha"). Solo para clientes
    // que lo piden (app nueva); el APK viejo no maneja fecha null aquí.
    let sinFecha: typeof mantenimientos = [];
    if (incluirSinFecha) {
      const { data: sf, error: sfErr } = await this.supabase.service
        .from('mantenimiento')
        .select(
          'id, descripcion, fecha_programada, estado, aeronave_id, etapa_intervalo_hr, aeronave(matricula)',
        )
        .neq('estado', 'COMPLETADO')
        .is('fecha_programada', null)
        .order('created_at', { ascending: false });
      if (sfErr) throw new Error(sfErr.message);
      sinFecha = sf ?? [];
    }
    return {
      vencimientos: vencs,
      mantenimientos: [...sinFecha, ...(mantenimientos ?? [])],
    };
  }
}
