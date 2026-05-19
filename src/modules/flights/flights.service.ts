import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ExpirationsService } from '../expirations/expirations.service';
import type {
  AssignFlightDto,
  CreateExternalFlightDto,
  ListFlightsQuery,
  UpdateFlightDto,
} from './dto/flights.dto';
import type { CreateEscalaDto, UpdateEscalaDto } from './dto/escalas.dto';
import type { CreateCobroDto } from './dto/cobros.dto';

const VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, piloto_id, ruta_id, tipo, estado, es_externo, operador_externo, costo_externo_usd, cotizacion_version, origen_iata, destino_iata, pasajeros, monto_total_usd, fecha_vuelo, fecha_confirmacion, facturado, cobrado, notas, notas_internas, google_calendar_id, created_at, updated_at';

const ESCALA_COLS =
  'id, vuelo_id, orden, origen_iata, destino_iata, taco_salida, taco_llegada, foto_taco_salida_url, foto_taco_llegada_url, valor_ia_propuesto, hora_salida, hora_llegada, capturado_offline, sincronizado_at, capturado_por, corregido_por, nota_correccion, corregido_at, notas, created_at, updated_at';

const COBRO_COLS =
  'id, vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn, referencia, fecha_cobro, registrado_por, notas, created_at, updated_at';

@Injectable()
export class FlightsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly expirations: ExpirationsService,
  ) {}

  /**
   * Bloquea operar un vuelo si la aeronave (o sus motores) o el piloto tienen
   * un documento critico vencido (doc 4.3). Los vuelos externos se omiten:
   * no usan aeronave ni piloto propios.
   */
  private async assertAirworthy(
    aeronaveId: string | null,
    pilotoId: string | null,
  ): Promise<void> {
    const blocking = await this.expirations.findBlockingExpirations({
      aeronaveId: aeronaveId ?? undefined,
      pilotoId: pilotoId ?? undefined,
    });
    if (blocking.length > 0) {
      const detalle = blocking
        .map((b) => `${b.tipo_nombre} (${b.objetivo})`)
        .join('; ');
      throw new ConflictException(
        `Documento(s) critico(s) vencido(s), no se puede operar el vuelo: ${detalle}`,
      );
    }
  }

  // ============ Vuelos ============

  async list(filters: ListFlightsQuery) {
    let q = this.supabase.service
      .from('vuelo')
      .select(VUELO_COLS, { count: 'exact' })
      .order('fecha_vuelo', { ascending: false, nullsFirst: false })
      .order('fecha_solicitud', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.cliente_id) q = q.eq('cliente_id', filters.cliente_id);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.piloto_id) q = q.eq('piloto_id', filters.piloto_id);
    if (filters.estado) q = q.eq('estado', filters.estado);
    if (typeof filters.es_externo === 'boolean')
      q = q.eq('es_externo', filters.es_externo);
    if (filters.desde) q = q.gte('fecha_vuelo', filters.desde.toISOString());
    if (filters.hasta) q = q.lte('fecha_vuelo', filters.hasta.toISOString());

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
      .from('vuelo')
      .select(VUELO_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${id} not found`);
    return data;
  }

  async snapshot(id: string) {
    const vuelo = await this.findById(id);
    const [escalas, cobros] = await Promise.all([
      this.listEscalas(id),
      this.listCobros(id),
    ]);
    const totalCobrado = cobros.reduce((acc, c) => acc + Number(c.monto), 0);
    return {
      ...vuelo,
      escalas,
      cobros,
      total_cobrado: Math.round(totalCobrado * 100) / 100,
    };
  }

  async update(id: string, dto: UpdateFlightDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const current = await this.findById(id);
    if (current.estado === 'CANCELADO' || current.estado === 'COMPLETADO') {
      throw new ConflictException(
        `No se puede modificar un vuelo en estado ${current.estado}`,
      );
    }
    const patch: Record<string, unknown> = { ...dto, updated_by: updatedBy };
    if (dto.fecha_vuelo) patch.fecha_vuelo = dto.fecha_vuelo.toISOString();
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update(patch)
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }
    return data!;
  }

  async assign(id: string, dto: AssignFlightDto, updatedBy: string) {
    const current = await this.findById(id);
    if (current.estado !== 'COTIZADO' && current.estado !== 'CONFIRMADO') {
      throw new ConflictException(
        `Solo se asigna en estado COTIZADO o CONFIRMADO. Actual: ${current.estado}`,
      );
    }
    if (current.es_externo && dto.aeronave_id) {
      throw new BadRequestException(
        'Vuelo externo no admite aeronave_id propia',
      );
    }
    const patch: Record<string, unknown> = { updated_by: updatedBy };
    if (dto.aeronave_id !== undefined) patch.aeronave_id = dto.aeronave_id;
    if (dto.piloto_id !== undefined) patch.piloto_id = dto.piloto_id;
    if (dto.fecha_vuelo !== undefined)
      patch.fecha_vuelo = dto.fecha_vuelo.toISOString();

    if (Object.keys(patch).length === 1) {
      throw new BadRequestException('Empty assign payload');
    }

    if (!current.es_externo) {
      const aeronaveId: string | null =
        dto.aeronave_id !== undefined
          ? dto.aeronave_id
          : ((current.aeronave_id as string | null) ?? null);
      const pilotoId: string | null =
        dto.piloto_id !== undefined
          ? dto.piloto_id
          : ((current.piloto_id as string | null) ?? null);
      await this.assertAirworthy(aeronaveId, pilotoId);
    }

    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update(patch)
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }
    return data!;
  }

  async start(id: string, updatedBy: string) {
    const current = await this.findById(id);
    if (current.estado !== 'CONFIRMADO') {
      throw new ConflictException(
        `Solo se inicia vuelo desde CONFIRMADO. Actual: ${current.estado}`,
      );
    }
    if (!current.es_externo) {
      if (!current.aeronave_id) {
        throw new BadRequestException(
          'No se puede iniciar sin aeronave_id asignada',
        );
      }
      if (!current.piloto_id) {
        throw new BadRequestException(
          'No se puede iniciar sin piloto_id asignado',
        );
      }
      await this.assertAirworthy(
        current.aeronave_id as string,
        current.piloto_id as string,
      );
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({ estado: 'EN_VUELO', updated_by: updatedBy })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }

  async complete(id: string, updatedBy: string) {
    const current = await this.findById(id);
    if (current.estado !== 'EN_VUELO') {
      throw new ConflictException(
        `Solo se completa vuelo desde EN_VUELO. Actual: ${current.estado}`,
      );
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({ estado: 'COMPLETADO', updated_by: updatedBy })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }

  async createExternal(dto: CreateExternalFlightDto, userId: string) {
    const payload = {
      cliente_id: dto.cliente_id,
      aeronave_id: null,
      es_externo: true,
      operador_externo: dto.operador_externo,
      costo_externo_usd: dto.costo_externo_usd,
      tipo: 'REDONDO',
      estado: 'CONFIRMADO',
      cotizacion_version: 1,
      origen_iata: dto.origen_iata.toUpperCase(),
      destino_iata: dto.destino_iata.toUpperCase(),
      es_redondo_auto: true,
      num_aterrizajes: 2,
      pasajeros: dto.pasajeros,
      pase_abordar: false,
      tiempo_cobrable_hr: 0,
      tarifa_tipo: 'PUBLICO',
      tarifa_hora_usd: 0,
      subtotal_vuelo_usd: dto.monto_total_usd,
      tuas_usd: 0,
      iva_pct: 0,
      iva_usd: 0,
      monto_total_usd: dto.monto_total_usd,
      fecha_vuelo: dto.fecha_vuelo?.toISOString(),
      fecha_confirmacion: new Date().toISOString(),
      notas: dto.notas,
      notas_internas: dto.notas_internas,
      created_by: userId,
      updated_by: userId,
    };
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .insert(payload)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }
    return data!;
  }

  // ============ Escalas ============

  async listEscalas(vueloId: string) {
    await this.findById(vueloId);
    const { data, error } = await this.supabase.service
      .from('escala')
      .select(ESCALA_COLS)
      .eq('vuelo_id', vueloId)
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createEscala(vueloId: string, dto: CreateEscalaDto, userId: string) {
    await this.findById(vueloId);
    const { data, error } = await this.supabase.service
      .from('escala')
      .insert({
        vuelo_id: vueloId,
        orden: dto.orden,
        origen_iata: dto.origen_iata.toUpperCase(),
        destino_iata: dto.destino_iata.toUpperCase(),
        hora_salida: dto.hora_salida?.toISOString(),
        hora_llegada: dto.hora_llegada?.toISOString(),
        notas: dto.notas,
        created_by: userId,
        updated_by: userId,
      })
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          `Ya existe una escala con orden ${dto.orden}`,
        );
      throw new Error(error.message);
    }
    return data!;
  }

  async updateEscala(escalaId: string, dto: UpdateEscalaDto, userId: string) {
    if (Object.keys(dto).length === 0) {
      const { data } = await this.supabase.service
        .from('escala')
        .select(ESCALA_COLS)
        .eq('id', escalaId)
        .maybeSingle();
      if (!data) throw new NotFoundException(`Escala ${escalaId} not found`);
      return data;
    }
    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.orden !== undefined) patch.orden = dto.orden;
    if (dto.origen_iata) patch.origen_iata = dto.origen_iata.toUpperCase();
    if (dto.destino_iata) patch.destino_iata = dto.destino_iata.toUpperCase();
    if (dto.hora_salida) patch.hora_salida = dto.hora_salida.toISOString();
    if (dto.hora_llegada) patch.hora_llegada = dto.hora_llegada.toISOString();
    if (dto.notas !== undefined) patch.notas = dto.notas;

    const { data, error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('id', escalaId)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('orden ya existe en este vuelo');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Escala ${escalaId} not found`);
    return data;
  }

  async deleteEscala(escalaId: string) {
    const { data: row, error: readErr } = await this.supabase.service
      .from('escala')
      .select('id, taco_salida, taco_llegada')
      .eq('id', escalaId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) throw new NotFoundException(`Escala ${escalaId} not found`);
    if (row.taco_salida !== null || row.taco_llegada !== null) {
      throw new ConflictException(
        'No se puede borrar una escala con tacómetro capturado (auditoría)',
      );
    }
    const { error } = await this.supabase.service
      .from('escala')
      .delete()
      .eq('id', escalaId);
    if (error) throw new Error(error.message);
    return { deleted: true, id: escalaId };
  }

  // ============ Cobros ============

  async listCobros(vueloId: string) {
    await this.findById(vueloId);
    const { data, error } = await this.supabase.service
      .from('cobro_vuelo')
      .select(COBRO_COLS)
      .eq('vuelo_id', vueloId)
      .order('fecha_cobro', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createCobro(vueloId: string, dto: CreateCobroDto, userId: string) {
    const vuelo = await this.findById(vueloId);
    if (vuelo.estado === 'CANCELADO') {
      throw new ConflictException(
        'No se puede registrar cobro en vuelo CANCELADO',
      );
    }
    const { data: cobro, error } = await this.supabase.service
      .from('cobro_vuelo')
      .insert({
        vuelo_id: vueloId,
        monto: dto.monto,
        moneda: dto.moneda,
        metodo_cobro: dto.metodo_cobro,
        tc_usd_mxn: dto.tc_usd_mxn,
        referencia: dto.referencia,
        fecha_cobro: dto.fecha_cobro?.toISOString(),
        registrado_por: userId,
        notas: dto.notas,
        created_by: userId,
        updated_by: userId,
      })
      .select(COBRO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);

    // Auto-mark cobrado=true si la suma de cobros >= monto_total_usd
    await this.refreshCobradoFlag(vueloId, userId);

    return cobro!;
  }

  private async refreshCobradoFlag(
    vueloId: string,
    userId: string,
  ): Promise<void> {
    const cobros = await this.listCobros(vueloId);
    const vuelo = await this.findById(vueloId);
    // Solo consideramos cobros en USD para esta heurística simple. En FASE de bancos
    // se hace una conciliación más sofisticada con multi-moneda + TC.
    const totalUsd = cobros
      .filter((c) => c.moneda === 'USD')
      .reduce((acc, c) => acc + Number(c.monto), 0);
    const totalMxnAsUsd = cobros
      .filter((c) => c.moneda === 'MXN' && c.tc_usd_mxn)
      .reduce((acc, c) => acc + Number(c.monto) / Number(c.tc_usd_mxn), 0);
    const aproximadoUsd = totalUsd + totalMxnAsUsd;
    const cobradoDeberiaSer = aproximadoUsd >= Number(vuelo.monto_total_usd);

    if (cobradoDeberiaSer !== vuelo.cobrado) {
      await this.supabase.service
        .from('vuelo')
        .update({ cobrado: cobradoDeberiaSer, updated_by: userId })
        .eq('id', vueloId);
    }
  }
}
