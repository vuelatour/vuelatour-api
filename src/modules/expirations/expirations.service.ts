import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  AmbitoDocumento,
  EstadoVencimiento,
  FormaVencimiento,
} from './dto/expirations.dto';
import type {
  CreateVencimientoDto,
  ListVencimientosQuery,
  UpdateVencimientoDto,
} from './dto/expirations.dto';

const COLS =
  'id, tipo_documento_id, aeronave_id, piloto_id, motor_id, vence_por, fecha_vencimiento, horas_limite, umbral_alerta_dias, referencia, archivo_url, notas, created_at, updated_at';

/** Horas restantes a partir de las cuales un vencimiento por HORAS se marca PROXIMO. */
const HORAS_ALERTA = 25;

interface TipoInfo {
  id: string;
  nombre: string;
  ambito: AmbitoDocumento;
  es_critico: boolean;
  umbral_alerta_dias: number;
}

interface VencimientoRow {
  id: string;
  tipo_documento_id: string;
  aeronave_id: string | null;
  piloto_id: string | null;
  motor_id: string | null;
  vence_por: FormaVencimiento;
  fecha_vencimiento: string | null;
  horas_limite: string | null;
  umbral_alerta_dias: number | null;
}

@Injectable()
export class ExpirationsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListVencimientosQuery) {
    let q = this.supabase.service
      .from('vencimiento')
      .select(COLS)
      .order('fecha_vencimiento', { ascending: true, nullsFirst: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.piloto_id) q = q.eq('piloto_id', filters.piloto_id);
    if (filters.motor_id) q = q.eq('motor_id', filters.motor_id);
    if (filters.tipo_documento_id)
      q = q.eq('tipo_documento_id', filters.tipo_documento_id);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as VencimientoRow[];
    const tipos = await this.loadTipos(rows.map((r) => r.tipo_documento_id));
    const horasMotor = await this.loadMotorHoras(
      rows.map((r) => r.motor_id).filter((m): m is string => !!m),
    );

    let enriched = rows.map((r) => this.enrich(r, tipos, horasMotor));
    if (filters.ambito)
      enriched = enriched.filter((v) => v.tipo?.ambito === filters.ambito);
    if (filters.estado)
      enriched = enriched.filter((v) => v.estado === filters.estado);

    return {
      data: enriched,
      count: enriched.length,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const row = await this.fetchRow(id);
    const tipos = await this.loadTipos([row.tipo_documento_id]);
    const horasMotor = await this.loadMotorHoras(
      row.motor_id ? [row.motor_id] : [],
    );
    return this.enrich(row, tipos, horasMotor);
  }

  async create(dto: CreateVencimientoDto, userId: string) {
    const tipo = await this.requireTipo(dto.tipo_documento_id);
    this.assertTargetMatchesAmbito(tipo.ambito, dto);
    this.assertVencePorCoherente(dto);

    const { data, error } = await this.supabase.service
      .from('vencimiento')
      .insert({
        tipo_documento_id: dto.tipo_documento_id,
        aeronave_id: dto.aeronave_id ?? null,
        piloto_id: dto.piloto_id ?? null,
        motor_id: dto.motor_id ?? null,
        vence_por: dto.vence_por,
        fecha_vencimiento:
          dto.vence_por === FormaVencimiento.FECHA
            ? dto.fecha_vencimiento
            : null,
        horas_limite:
          dto.vence_por === FormaVencimiento.HORAS ? dto.horas_limite : null,
        umbral_alerta_dias: dto.umbral_alerta_dias ?? null,
        referencia: dto.referencia ?? null,
        archivo_url: dto.archivo_url ?? null,
        notas: dto.notas ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      if (error.code === '23514')
        throw new BadRequestException('Datos del vencimiento inconsistentes');
      throw new Error(error.message);
    }
    return this.findById((data as VencimientoRow).id);
  }

  async update(id: string, dto: UpdateVencimientoDto, userId: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const current = await this.fetchRow(id);

    const tipoId = dto.tipo_documento_id ?? current.tipo_documento_id;
    const tipo = await this.requireTipo(tipoId);
    const vencePor = dto.vence_por ?? current.vence_por;
    const merged = {
      tipo_documento_id: tipoId,
      vence_por: vencePor,
      aeronave_id:
        dto.aeronave_id !== undefined ? dto.aeronave_id : current.aeronave_id,
      piloto_id:
        dto.piloto_id !== undefined ? dto.piloto_id : current.piloto_id,
      motor_id: dto.motor_id !== undefined ? dto.motor_id : current.motor_id,
      fecha_vencimiento:
        dto.fecha_vencimiento !== undefined
          ? dto.fecha_vencimiento
          : current.fecha_vencimiento,
      horas_limite:
        dto.horas_limite !== undefined
          ? dto.horas_limite
          : current.horas_limite
            ? Number(current.horas_limite)
            : undefined,
    };
    this.assertTargetMatchesAmbito(tipo.ambito, merged);
    this.assertVencePorCoherente(merged);

    const patch: Record<string, unknown> = { ...dto, updated_by: userId };
    // Normaliza los campos de limite segun vence_por para no dejar datos cruzados.
    patch.fecha_vencimiento =
      vencePor === FormaVencimiento.FECHA ? merged.fecha_vencimiento : null;
    patch.horas_limite =
      vencePor === FormaVencimiento.HORAS ? merged.horas_limite : null;

    const { data, error } = await this.supabase.service
      .from('vencimiento')
      .update(patch)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      if (error.code === '23514')
        throw new BadRequestException('Datos del vencimiento inconsistentes');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Vencimiento ${id} not found`);
    return this.findById(id);
  }

  async remove(id: string) {
    await this.fetchRow(id);
    const { error } = await this.supabase.service
      .from('vencimiento')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: true, id };
  }

  /**
   * Documentos criticos VENCIDOS de una aeronave (incluye sus motores) y/o de
   * un piloto. Lo usa el modulo de vuelos para bloquear asignacion/inicio
   * (doc 4.3). Lista vacia = no hay bloqueos.
   */
  async findBlockingExpirations(opts: {
    aeronaveId?: string;
    pilotoId?: string;
  }): Promise<
    Array<{
      id: string;
      tipo_nombre: string;
      objetivo: 'aeronave' | 'piloto' | 'motor';
    }>
  > {
    const { aeronaveId, pilotoId } = opts;
    if (!aeronaveId && !pilotoId) return [];

    let motorIds: string[] = [];
    if (aeronaveId) {
      const { data: motores, error: mErr } = await this.supabase.service
        .from('motor')
        .select('id')
        .eq('aeronave_id', aeronaveId);
      if (mErr) throw new Error(mErr.message);
      motorIds = (motores ?? []).map((m) => m.id as string);
    }

    const orParts: string[] = [];
    if (aeronaveId) orParts.push(`aeronave_id.eq.${aeronaveId}`);
    if (pilotoId) orParts.push(`piloto_id.eq.${pilotoId}`);
    if (motorIds.length > 0)
      orParts.push(`motor_id.in.(${motorIds.join(',')})`);

    const { data, error } = await this.supabase.service
      .from('vencimiento')
      .select(COLS)
      .or(orParts.join(','));
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as VencimientoRow[];
    const tipos = await this.loadTipos(rows.map((r) => r.tipo_documento_id));
    const horasMotor = await this.loadMotorHoras(
      rows.map((r) => r.motor_id).filter((m): m is string => !!m),
    );

    return rows
      .map((r) => this.enrich(r, tipos, horasMotor))
      .filter(
        (v) => v.estado === EstadoVencimiento.VENCIDO && v.tipo?.es_critico,
      )
      .map((v) => ({
        id: v.id,
        tipo_nombre: v.tipo?.nombre ?? 'Documento',
        objetivo: v.aeronave_id
          ? ('aeronave' as const)
          : v.piloto_id
            ? ('piloto' as const)
            : ('motor' as const),
      }));
  }

  // ============ helpers ============

  private async fetchRow(id: string): Promise<VencimientoRow> {
    const { data, error } = await this.supabase.service
      .from('vencimiento')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vencimiento ${id} not found`);
    return data;
  }

  private async requireTipo(id: string): Promise<TipoInfo> {
    const { data, error } = await this.supabase.service
      .from('tipo_documento')
      .select('id, nombre, ambito, es_critico, umbral_alerta_dias')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new BadRequestException(`Tipo de documento ${id} not found`);
    return data;
  }

  private async loadTipos(ids: string[]): Promise<Map<string, TipoInfo>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const { data, error } = await this.supabase.service
      .from('tipo_documento')
      .select('id, nombre, ambito, es_critico, umbral_alerta_dias')
      .in('id', unique);
    if (error) throw new Error(error.message);
    return new Map((data as TipoInfo[]).map((t) => [t.id, t]));
  }

  private async loadMotorHoras(ids: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const { data, error } = await this.supabase.service
      .from('motor')
      .select('id, horas_totales')
      .in('id', unique);
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((m) => [m.id as string, Number(m.horas_totales)]),
    );
  }

  private enrich(
    row: VencimientoRow,
    tipos: Map<string, TipoInfo>,
    horasMotor: Map<string, number>,
  ) {
    const tipo = tipos.get(row.tipo_documento_id) ?? null;
    const motorHoras = row.motor_id
      ? (horasMotor.get(row.motor_id) ?? null)
      : null;
    const calc = this.computeEstado(
      row,
      tipo?.umbral_alerta_dias ?? 30,
      motorHoras,
    );
    return {
      ...row,
      tipo: tipo
        ? {
            nombre: tipo.nombre,
            ambito: tipo.ambito,
            es_critico: tipo.es_critico,
          }
        : null,
      ...calc,
    };
  }

  private computeEstado(
    row: VencimientoRow,
    umbralTipo: number,
    motorHoras: number | null,
  ): {
    estado: EstadoVencimiento;
    dias_restantes: number | null;
    horas_restantes: number | null;
  } {
    if (row.vence_por === FormaVencimiento.PERMANENTE) {
      return {
        estado: EstadoVencimiento.PERMANENTE,
        dias_restantes: null,
        horas_restantes: null,
      };
    }

    if (row.vence_por === FormaVencimiento.FECHA && row.fecha_vencimiento) {
      const dias = this.diasHasta(row.fecha_vencimiento);
      const umbral = row.umbral_alerta_dias ?? umbralTipo;
      const estado =
        dias < 0
          ? EstadoVencimiento.VENCIDO
          : dias <= umbral
            ? EstadoVencimiento.PROXIMO
            : EstadoVencimiento.VIGENTE;
      return { estado, dias_restantes: dias, horas_restantes: null };
    }

    if (row.vence_por === FormaVencimiento.HORAS && row.horas_limite) {
      if (motorHoras === null) {
        return {
          estado: EstadoVencimiento.INDETERMINADO,
          dias_restantes: null,
          horas_restantes: null,
        };
      }
      const restantes =
        Math.round((Number(row.horas_limite) - motorHoras) * 100) / 100;
      const estado =
        restantes <= 0
          ? EstadoVencimiento.VENCIDO
          : restantes <= HORAS_ALERTA
            ? EstadoVencimiento.PROXIMO
            : EstadoVencimiento.VIGENTE;
      return { estado, dias_restantes: null, horas_restantes: restantes };
    }

    return {
      estado: EstadoVencimiento.INDETERMINADO,
      dias_restantes: null,
      horas_restantes: null,
    };
  }

  /** Dias enteros desde hoy (UTC) hasta la fecha dada. Negativo = ya vencio. */
  private diasHasta(fechaIso: string): number {
    const hoy = new Date();
    const hoyUtc = Date.UTC(
      hoy.getUTCFullYear(),
      hoy.getUTCMonth(),
      hoy.getUTCDate(),
    );
    const fecha = new Date(`${fechaIso}T00:00:00Z`).getTime();
    return Math.round((fecha - hoyUtc) / 86_400_000);
  }

  private assertTargetMatchesAmbito(
    ambito: AmbitoDocumento,
    target: {
      aeronave_id?: string | null;
      piloto_id?: string | null;
      motor_id?: string | null;
    },
  ): void {
    const map: Record<AmbitoDocumento, string | null | undefined> = {
      [AmbitoDocumento.AERONAVE]: target.aeronave_id,
      [AmbitoDocumento.PILOTO]: target.piloto_id,
      [AmbitoDocumento.MOTOR]: target.motor_id,
    };
    const expected = map[ambito];
    const others = (Object.keys(map) as AmbitoDocumento[])
      .filter((k) => k !== ambito)
      .map((k) => map[k]);
    if (!expected) {
      throw new BadRequestException(
        `El tipo es de ambito ${ambito}; falta el ${ambito.toLowerCase()}_id`,
      );
    }
    if (others.some((o) => !!o)) {
      throw new BadRequestException(
        `El tipo es de ambito ${ambito}; no debe llevar otro objetivo`,
      );
    }
  }

  private assertVencePorCoherente(dto: {
    vence_por: FormaVencimiento;
    fecha_vencimiento?: string | null;
    horas_limite?: number | null;
  }): void {
    if (dto.vence_por === FormaVencimiento.FECHA && !dto.fecha_vencimiento) {
      throw new BadRequestException(
        'vence_por=FECHA requiere fecha_vencimiento',
      );
    }
    if (
      dto.vence_por === FormaVencimiento.HORAS &&
      (dto.horas_limite === undefined ||
        dto.horas_limite === null ||
        dto.horas_limite <= 0)
    ) {
      throw new BadRequestException(
        'vence_por=HORAS requiere horas_limite > 0',
      );
    }
  }
}
