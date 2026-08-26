import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AircraftService } from '../aircraft/aircraft.service';
import type {
  CreateEngineDto,
  ListEnginesQuery,
  OverhaulEngineDto,
  TransplantEngineDto,
  UpdateEngineDto,
} from './dto/engines.dto';

const COLS =
  'id, aeronave_id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tso_base, tbo_horas, tbo_fecha, aeronave_horas_ref, notas, created_at, updated_at';

const EVENTO_COLS =
  'id, tipo_evento, aeronave_id, aeronave_origen_id, posicion, hobbs_avion, hobbs_avion_origen, horas_componente, horas_desde_overhaul, fecha, motivo, created_at, aeronave:aeronave_id(matricula), aeronave_origen:aeronave_origen_id(matricula), realizado:realizado_por(nombre)';

@Injectable()
export class EnginesService {
  private readonly logger = new Logger(EnginesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    // Eje de horas y aritmética de componentes: fuente ÚNICA en
    // aircraft.service (currentHobbs + componenteEstado) — no duplicar.
    private readonly aircraft: AircraftService,
  ) {}

  /** Bitácora del componente (equivalente a la entrada de bitácora física). */
  private async logEvento(
    motorId: string,
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
        motor_id: motorId,
        ...rest,
        // Sin fecha explícita, la BD pone el día Cancún de hoy.
        ...(fecha ? { fecha } : {}),
      });
    if (error) {
      // La bitácora es parte del contrato (diseño 9.3: log de auditoría):
      // no fallar en silencio.
      throw new Error(
        `Motor guardado pero la bitácora falló: ${error.message}`,
      );
    }
  }

  async list(filters: ListEnginesQuery) {
    let q = this.supabase.service
      .from('motor')
      .select(`${COLS}, aeronave:aeronave_id(matricula, modelo)`, {
        count: 'exact',
      })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.tipo) q = q.eq('tipo', filters.tipo);
    if (filters.posicion) q = q.eq('posicion', filters.posicion);
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);

    // Horas VIVAS derivadas (misma aritmética que el detalle del avión): el
    // listado global calculaba "restantes" con la base capturada y podía
    // contradecir al expediente (caso N990GG: 6,290 restantes con TBO 2,000).
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const aeronaveIds = [
      ...new Set(rows.map((m) => m.aeronave_id as string).filter(Boolean)),
    ];
    const hobbsPorAvion = new Map<string, number>();
    await Promise.all(
      aeronaveIds.map(async (id) => {
        hobbsPorAvion.set(id, await this.aircraft.currentHobbs(id));
      }),
    );
    const enriched = rows.map((m) => ({
      ...m,
      ...this.aircraft.componenteEstado(
        m,
        hobbsPorAvion.get(m.aeronave_id as string) ?? 0,
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
      .from('motor')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Motor ${id} not found`);
    return data;
  }

  async create(dto: CreateEngineDto, createdBy: string) {
    // Fija el Hobbs del avión como referencia: desde aquí, las horas de vida
    // del motor acumulan con lo que vuele el avión.
    const { turm_componente, ...rest } = dto;
    const ref = await this.aircraft.currentHobbs(dto.aeronave_id);
    // TURM en marco del componente (como la bitácora AFAC: horas del MOTOR en
    // su último overhaul) → tso_base = horas base − turm_componente.
    const tsoBase =
      turm_componente != null
        ? Number((Number(dto.horas_totales ?? 0) - turm_componente).toFixed(1))
        : null;
    const { data, error } = await this.supabase.service
      .from('motor')
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
    const motor = data as Record<string, unknown>;
    await this.logEvento(motor.id as string, {
      tipo_evento: 'INSTALACION',
      aeronave_id: dto.aeronave_id,
      posicion: dto.posicion,
      hobbs_avion: ref,
      horas_componente: Number(dto.horas_totales ?? 0),
      horas_desde_overhaul: tsoBase != null ? Math.max(0, tsoBase) : null,
      motivo: 'Alta del motor',
      realizado_por: createdBy,
    });
    return motor;
  }

  async update(id: string, dto: UpdateEngineDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { turm_componente, ...rest } = dto;
    const patch: Record<string, unknown> = { ...rest, updated_by: updatedBy };
    // Al re-registrar horas (corrección de base) se re-fija la referencia al
    // Hobbs actual para que la acumulación parta de ahí. PERO el form del
    // panel reenvía TODOS los campos aunque no se toquen: si horas_totales
    // llega con el MISMO valor guardado no es una corrección real, y
    // re-anclar borraría las horas vivas acumuladas desde el último anclaje
    // (horas vivas = horas_totales + hobbs − ref). Solo se re-ancla con un
    // cambio real tecleado; si el valor es igual se ignora el campo.
    const necesitaActual =
      dto.horas_totales !== undefined || turm_componente !== undefined;
    const motor = necesitaActual ? await this.findById(id) : null;
    let baseHoras = motor ? Number(motor.horas_totales) : null;
    let ajuste: {
      hobbs: number;
      anterior: number;
      nuevo: number | null;
    } | null = null;
    if (dto.horas_totales !== undefined && motor) {
      if (Number(dto.horas_totales) === Number(motor.horas_totales)) {
        delete patch.horas_totales;
      } else {
        const hobbs = await this.aircraft.currentHobbs(
          motor.aeronave_id as string,
        );
        const estadoPrevio = this.aircraft.componenteEstado(motor, hobbs, true);
        patch.aeronave_horas_ref = hobbs;
        baseHoras = Number(dto.horas_totales);
        // La corrección de TSN no toca el TSO: se preserva el TSO vivo en el
        // nuevo ancla (salvo que también venga turm_componente, abajo).
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
          anterior: Number(motor.horas_totales),
          nuevo: baseHoras,
        };
      }
    }
    if (turm_componente !== undefined && baseHoras != null) {
      // tso_base en el ancla = horas base − TURM del componente (puede ser
      // negativo si el overhaul quedó "adelante" de la base; el cálculo vivo
      // lo compensa con el delta del taco y el API recorta a 0 al mostrar).
      patch.tso_base = Number((baseHoras - turm_componente).toFixed(1));
    }
    const { data, error } = await this.supabase.service
      .from('motor')
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
    if (!data) throw new NotFoundException(`Motor ${id} not found`);
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

  async remove(id: string) {
    const motor = await this.findById(id);
    // Sus vencimientos caen por ON DELETE CASCADE: recolectar las copias de
    // documentos ANTES de borrar, o quedan huérfanas en el bucket para
    // siempre (nadie más conoce esos paths).
    const { data: vencs } = await this.supabase.service
      .from('vencimiento')
      .select('archivo_url')
      .eq('motor_id', id)
      .not('archivo_url', 'is', null);
    const { error } = await this.supabase.service
      .from('motor')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    const paths = ((vencs ?? []) as Array<{ archivo_url: string | null }>)
      .map((v) => v.archivo_url)
      .filter((p): p is string => !!p);
    if (paths.length > 0) {
      // Best-effort: el motor ya se borró; un archivo residual no rompe nada.
      const { error: stErr } = await this.supabase.service.storage
        .from('documentos-flota')
        .remove(paths);
      if (stErr) {
        this.logger.warn(
          `No se pudieron borrar ${paths.length} documento(s) del motor ${id}: ${stErr.message}`,
        );
      }
    }
    return { deleted: true, id, numero_serie: String(motor.numero_serie) };
  }

  async transplant(id: string, dto: TransplantEngineDto, performedBy: string) {
    const motor = await this.findById(id);

    if (
      motor.aeronave_id === dto.aeronave_destino_id &&
      motor.posicion === dto.posicion_destino
    ) {
      throw new BadRequestException(
        'Destination aircraft+position equals current placement',
      );
    }

    const aeronaveOrigenId = motor.aeronave_id as string;
    const posicionOrigen = motor.posicion as string;

    // Congela las horas de vida Y el TSO acumulados hasta el momento del
    // traslado, y re-referencia al Hobbs del avión destino (cada avión lleva
    // su propio Hobbs). El turm legado (escala del taco del avión ORIGEN) se
    // apaga: no significa nada en el avión destino — tso_base viaja con el
    // motor y mantiene el "desde overhaul" correcto.
    const hobbsOrigen = await this.aircraft.currentHobbs(aeronaveOrigenId);
    const estado = this.aircraft.componenteEstado(motor, hobbsOrigen, true);
    const horasVida = estado.horas_actuales;
    const tsoVivo =
      estado.turm_componente != null ? estado.horas_desde_overhaul : null;
    const hobbsDestino = await this.aircraft.currentHobbs(
      dto.aeronave_destino_id,
    );

    const { error: updErr } = await this.supabase.service
      .from('motor')
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
          'Destination (aircraft, position) already has an engine — move the existing one first',
        );
      if (updErr.code === '23503')
        throw new BadRequestException('aeronave_destino_id does not exist');
      throw new Error(updErr.message);
    }

    // Bitácora canónica del componente + tabla legada motor_traslado (los
    // lectores existentes de /transplants siguen funcionando igual).
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
    const { error: logErr } = await this.supabase.service
      .from('motor_traslado')
      .insert({
        motor_id: id,
        aeronave_origen_id: aeronaveOrigenId,
        aeronave_destino_id: dto.aeronave_destino_id,
        posicion_origen: posicionOrigen,
        posicion_destino: dto.posicion_destino,
        horas_al_traslado: horasVida,
        motivo: dto.motivo,
        trasladado_por: performedBy,
      });
    if (logErr) {
      // Best-effort log; do not reverse the move silently. Surface the error.
      throw new Error(`Motor moved but audit log failed: ${logErr.message}`);
    }

    return this.findById(id);
  }

  /**
   * Registra un OVERHAUL (reparación mayor): el TSO vuelve a 0, las horas de
   * vida (TSN) se congelan en el valor vivo y el ancla se re-fija al Hobbs
   * actual. Queda grabado en la bitácora del componente (como la entrada
   * física de la AFAC). Opcionalmente actualiza TBO por horas y calendario.
   */
  async overhaul(id: string, dto: OverhaulEngineDto, performedBy: string) {
    const motor = await this.findById(id);
    const hobbs = await this.aircraft.currentHobbs(motor.aeronave_id as string);
    const estado = this.aircraft.componenteEstado(motor, hobbs, true);
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
      .from('motor')
      .update(patch)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Motor ${id} not found`);
    await this.logEvento(id, {
      tipo_evento: 'OVERHAUL',
      aeronave_id: motor.aeronave_id as string,
      posicion: motor.posicion as string,
      hobbs_avion: hobbs,
      horas_componente: estado.horas_actuales,
      horas_desde_overhaul: 0,
      fecha: dto.fecha ?? null,
      motivo: dto.motivo ?? 'Overhaul (reparación mayor)',
      realizado_por: performedBy,
    });
    return data;
  }

  /** Bitácora completa del motor (instalaciones, traslados, overhauls, ajustes). */
  async listEventos(motorId: string) {
    const { data, error } = await this.supabase.service
      .from('componente_evento')
      .select(EVENTO_COLS)
      .eq('motor_id', motorId)
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async listTransplants(motorId: string) {
    const { data, error } = await this.supabase.service
      .from('motor_traslado')
      .select(
        'id, aeronave_origen_id, aeronave_destino_id, posicion_origen, posicion_destino, horas_al_traslado, motivo, trasladado_at, trasladado_por',
      )
      .eq('motor_id', motorId)
      .order('trasladado_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }
}
