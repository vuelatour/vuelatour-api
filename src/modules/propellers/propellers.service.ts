import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AircraftService } from '../aircraft/aircraft.service';
import type {
  CreatePropellerDto,
  ListPropellersQuery,
  OverhaulPropellerDto,
  TransplantPropellerDto,
  UpdatePropellerDto,
} from './dto/propellers.dto';

const COLS =
  'id, aeronave_id, posicion, numero_serie, fabricante, modelo, horas_totales, turm, tso_base, tbo_horas, tbo_fecha, aeronave_horas_ref, notas, created_at, updated_at';

const EVENTO_COLS =
  'id, tipo_evento, aeronave_id, aeronave_origen_id, posicion, hobbs_avion, hobbs_avion_origen, horas_componente, horas_desde_overhaul, fecha, motivo, created_at, aeronave:aeronave_id(matricula), aeronave_origen:aeronave_origen_id(matricula), realizado:realizado_por(nombre)';

@Injectable()
export class PropellersService {
  constructor(
    private readonly supabase: SupabaseService,
    // Eje de horas y aritmética de componentes: fuente ÚNICA en
    // aircraft.service (currentHobbs + componenteEstado) — no duplicar.
    private readonly aircraft: AircraftService,
  ) {}

  /** Bitácora del componente (equivalente a la entrada de bitácora física). */
  private async logEvento(
    heliceId: string,
    evento: {
      tipo_evento: 'INSTALACION' | 'TRASLADO' | 'OVERHAUL' | 'AJUSTE';
      aeronave_id: string | null;
      aeronave_origen_id?: string | null;
      posicion?: string | null;
      hobbs_avion?: number | null;
      hobbs_avion_origen?: number | null;
      horas_componente?: number | null;
      horas_desde_overhaul?: number | null;
      fecha?: string | null;
      motivo?: string | null;
      realizado_por?: string | null;
    },
  ): Promise<void> {
    const { fecha, ...rest } = evento;
    const { error } = await this.supabase.service
      .from('componente_evento')
      .insert({
        helice_id: heliceId,
        ...rest,
        ...(fecha ? { fecha } : {}),
      });
    if (error) {
      throw new Error(
        `Hélice guardada pero la bitácora falló: ${error.message}`,
      );
    }
  }

  async list(filters: ListPropellersQuery) {
    let q = this.supabase.service
      .from('helice')
      .select(`${COLS}, aeronave:aeronave_id(matricula, modelo)`, {
        count: 'exact',
      })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.posicion) q = q.eq('posicion', filters.posicion);
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);

    // Horas VIVAS derivadas (misma aritmética que el detalle del avión).
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const aeronaveIds = [
      ...new Set(rows.map((h) => h.aeronave_id as string).filter(Boolean)),
    ];
    const hobbsPorAvion = new Map<string, number>();
    await Promise.all(
      aeronaveIds.map(async (id) => {
        hobbsPorAvion.set(id, await this.aircraft.currentHobbs(id));
      }),
    );
    const enriched = rows.map((h) => ({
      ...h,
      ...this.aircraft.componenteEstado(
        h,
        hobbsPorAvion.get(h.aeronave_id as string) ?? 0,
        true,
      ),
    }));
    return {
      data: enriched,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const { data, error } = await this.supabase.service
      .from('helice')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Hélice ${id} not found`);
    return data;
  }

  async create(dto: CreatePropellerDto, createdBy: string) {
    const { turm_componente, ...rest } = dto;
    const ref = await this.aircraft.currentHobbs(dto.aeronave_id);
    // TURM en marco del componente (horas de la HÉLICE en su último
    // overhaul) → tso_base = horas base − turm_componente.
    const tsoBase =
      turm_componente != null
        ? Number((Number(dto.horas_totales ?? 0) - turm_componente).toFixed(1))
        : null;
    const { data, error } = await this.supabase.service
      .from('helice')
      .insert({
        ...rest,
        tso_base: tsoBase,
        aeronave_horas_ref: ref,
        created_by: createdBy,
        updated_by: createdBy,
      })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          'numero_serie or (aeronave,posicion) already exists',
        );
      if (error.code === '23503')
        throw new BadRequestException('aeronave_id does not exist');
      throw new Error(error.message);
    }
    const helice = data as Record<string, unknown>;
    await this.logEvento(helice.id as string, {
      tipo_evento: 'INSTALACION',
      aeronave_id: dto.aeronave_id,
      posicion: dto.posicion,
      hobbs_avion: ref,
      horas_componente: Number(dto.horas_totales ?? 0),
      horas_desde_overhaul: tsoBase != null ? Math.max(0, tsoBase) : null,
      motivo: 'Alta de la hélice',
      realizado_por: createdBy,
    });
    return helice;
  }

  async remove(id: string) {
    const helice = await this.findById(id);
    const { error } = await this.supabase.service
      .from('helice')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: true, id, numero_serie: String(helice.numero_serie) };
  }

  async update(id: string, dto: UpdatePropellerDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { turm_componente, ...rest } = dto;
    const patch: Record<string, unknown> = { ...rest, updated_by: updatedBy };
    // Re-anclar aeronave_horas_ref SOLO con cambio real de horas_totales: el
    // form del panel reenvía todos los campos, y re-anclar con el mismo valor
    // borraría las horas vivas acumuladas desde el último anclaje
    // (horas vivas = horas_totales + hobbs − ref). Valor igual → se ignora.
    const necesitaActual =
      dto.horas_totales !== undefined || turm_componente !== undefined;
    const helice = necesitaActual ? await this.findById(id) : null;
    let baseHoras = helice ? Number(helice.horas_totales) : null;
    let ajuste: {
      hobbs: number;
      anterior: number;
      nuevo: number | null;
    } | null = null;
    if (dto.horas_totales !== undefined && helice) {
      if (Number(dto.horas_totales) === Number(helice.horas_totales)) {
        delete patch.horas_totales;
      } else {
        const hobbs = await this.aircraft.currentHobbs(
          helice.aeronave_id as string,
        );
        const estadoPrevio = this.aircraft.componenteEstado(
          helice,
          hobbs,
          true,
        );
        patch.aeronave_horas_ref = hobbs;
        baseHoras = Number(dto.horas_totales);
        if (turm_componente === undefined) {
          patch.tso_base =
            estadoPrevio.turm_componente != null
              ? estadoPrevio.horas_desde_overhaul
              : null;
        }
        // El evento AJUSTE se registra DESPUÉS del update exitoso (abajo):
        // un update fallido no debe dejar bitácora huérfana.
        ajuste = {
          hobbs,
          anterior: Number(helice.horas_totales),
          nuevo: baseHoras,
        };
      }
    }
    if (turm_componente !== undefined && baseHoras != null) {
      patch.tso_base = Number((baseHoras - turm_componente).toFixed(1));
    }
    const { data, error } = await this.supabase.service
      .from('helice')
      .update(patch)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          'numero_serie or (aeronave,posicion) collision',
        );
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Hélice ${id} not found`);
    if (ajuste) {
      await this.logEvento(id, {
        tipo_evento: 'AJUSTE',
        aeronave_id: (data as Record<string, unknown>).aeronave_id as string,
        posicion: (data as Record<string, unknown>).posicion as string,
        hobbs_avion: ajuste.hobbs,
        horas_componente: ajuste.nuevo,
        motivo: `Corrección de base de horas: ${ajuste.anterior} → ${ajuste.nuevo}`,
        realizado_por: updatedBy,
      });
    }
    return data;
  }

  /**
   * Traslada la hélice a otro avión (antes era imposible: se borraba y
   * recreaba perdiendo la vida acumulada y sin bitácora). Congela TSN y TSO
   * vivos y re-ancla al Hobbs del destino; queda en la bitácora del
   * componente con el taco de ambos aviones.
   */
  async transplant(
    id: string,
    dto: TransplantPropellerDto,
    performedBy: string,
  ) {
    const helice = await this.findById(id);

    if (
      helice.aeronave_id === dto.aeronave_destino_id &&
      helice.posicion === dto.posicion_destino
    ) {
      throw new BadRequestException(
        'Destination aircraft+position equals current placement',
      );
    }

    const aeronaveOrigenId = helice.aeronave_id as string;
    const hobbsOrigen = await this.aircraft.currentHobbs(aeronaveOrigenId);
    const estado = this.aircraft.componenteEstado(helice, hobbsOrigen, true);
    const horasVida = estado.horas_actuales;
    const tsoVivo =
      estado.turm_componente != null ? estado.horas_desde_overhaul : null;
    const hobbsDestino = await this.aircraft.currentHobbs(
      dto.aeronave_destino_id,
    );

    const { error: updErr } = await this.supabase.service
      .from('helice')
      .update({
        aeronave_id: dto.aeronave_destino_id,
        posicion: dto.posicion_destino,
        horas_totales: horasVida,
        tso_base: tsoVivo,
        turm: 0,
        aeronave_horas_ref: hobbsDestino,
        updated_by: performedBy,
      })
      .eq('id', id);
    if (updErr) {
      if (updErr.code === '23505')
        throw new ConflictException(
          'Destination (aircraft, position) already has a propeller — move the existing one first',
        );
      if (updErr.code === '23503')
        throw new BadRequestException('aeronave_destino_id does not exist');
      throw new Error(updErr.message);
    }

    await this.logEvento(id, {
      tipo_evento: 'TRASLADO',
      aeronave_id: dto.aeronave_destino_id,
      aeronave_origen_id: aeronaveOrigenId,
      posicion: dto.posicion_destino,
      hobbs_avion: hobbsDestino,
      hobbs_avion_origen: hobbsOrigen,
      horas_componente: horasVida,
      horas_desde_overhaul: tsoVivo,
      motivo: dto.motivo,
      realizado_por: performedBy,
    });

    return this.findById(id);
  }

  /** Registra un OVERHAUL de la hélice: TSO a 0, TSN congelado, ancla al Hobbs actual. */
  async overhaul(id: string, dto: OverhaulPropellerDto, performedBy: string) {
    const helice = await this.findById(id);
    const hobbs = await this.aircraft.currentHobbs(
      helice.aeronave_id as string,
    );
    const estado = this.aircraft.componenteEstado(helice, hobbs, true);
    const patch: Record<string, unknown> = {
      horas_totales: estado.horas_actuales,
      aeronave_horas_ref: hobbs,
      tso_base: 0,
      turm: 0,
      updated_by: performedBy,
    };
    if (dto.tbo_horas !== undefined) patch.tbo_horas = dto.tbo_horas;
    if (dto.tbo_fecha !== undefined) patch.tbo_fecha = dto.tbo_fecha;
    const { data, error } = await this.supabase.service
      .from('helice')
      .update(patch)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Hélice ${id} not found`);
    await this.logEvento(id, {
      tipo_evento: 'OVERHAUL',
      aeronave_id: helice.aeronave_id as string,
      posicion: helice.posicion as string,
      hobbs_avion: hobbs,
      horas_componente: estado.horas_actuales,
      horas_desde_overhaul: 0,
      fecha: dto.fecha ?? null,
      motivo: dto.motivo ?? 'Overhaul (reparación mayor)',
      realizado_por: performedBy,
    });
    return data;
  }

  /** Bitácora completa de la hélice. */
  async listEventos(heliceId: string) {
    const { data, error } = await this.supabase.service
      .from('componente_evento')
      .select(EVENTO_COLS)
      .eq('helice_id', heliceId)
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }
}
