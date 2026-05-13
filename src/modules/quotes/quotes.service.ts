import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AircraftService } from '../aircraft/aircraft.service';
import { AirportsService } from '../airports/airports.service';
import { RoutesService } from '../routes/routes.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  CalculateQuoteDto,
  MetodoPago,
  TipoTarifa,
} from './dto/calculate-quote.dto';
import { CreateQuoteDto, TipoVuelo } from './dto/create-quote.dto';
import { EstadoVuelo, ListQuotesQuery } from './dto/list-quotes.query';
import { ReviseQuoteDto } from './dto/revise-quote.dto';

interface ResolvedRoute {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number;
  es_redondo_auto: boolean;
  num_aterrizajes: number;
  ruta_id: string | null;
}

const IVA_DEFAULT = 0.16;
const CALZOS_HR_POR_ATERRIZAJE = 0.15;

const VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, piloto_id, ruta_id, tipo, estado, es_externo, operador_externo, costo_externo_usd, cotizacion_version, origen_iata, destino_iata, millas_nauticas_one_way, es_redondo_auto, num_aterrizajes, pasajeros, pase_abordar, tiempo_cobrable_hr, tarifa_tipo, tarifa_hora_usd, subtotal_vuelo_usd, tuas_usd, iva_pct, iva_usd, monto_total_usd, tc_usd_mxn, monto_total_mxn, metodo_cobro, pago_anticipado_req, fecha_solicitud, fecha_vuelo, fecha_confirmacion, fecha_cancelacion, motivo_cancelacion, google_calendar_id, facturado, cobrado, notas, notas_internas, calculo_snapshot, created_at, updated_at';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

@Injectable()
export class QuotesService {
  constructor(
    private readonly aircraft: AircraftService,
    private readonly airports: AirportsService,
    private readonly routes: RoutesService,
    private readonly supabase: SupabaseService,
  ) {}

  /**
   * Pure calculation, no persistence. Returns the full breakdown.
   */
  async calculate(dto: CalculateQuoteDto) {
    const aeronave = await this.aircraft.findById(dto.aeronave_id);
    if (!aeronave.activa) throw new BadRequestException('Aeronave inactiva');

    const route = await this.resolveRoute(dto);
    const matriculaPrefix = this.derivarMatriculaPrefix(aeronave.matricula);

    const nmTotal = route.es_redondo_auto
      ? Number(route.millas_nauticas) * 2
      : Number(route.millas_nauticas);

    const velocidadKts = Number(aeronave.velocidad_crucero_kts);
    if (!velocidadKts || velocidadKts <= 0) {
      throw new BadRequestException(
        `Aeronave ${aeronave.matricula} no tiene velocidad_crucero_kts válida`,
      );
    }
    const tiempoVueloHr = nmTotal / velocidadKts;
    const calzosHr = route.num_aterrizajes * CALZOS_HR_POR_ATERRIZAJE;
    const tiempoCobrableHr = tiempoVueloHr + calzosHr;

    const tarifaHora =
      dto.tarifa_hora_override_usd ??
      (dto.tipo_tarifa === TipoTarifa.PUBLICO
        ? Number(aeronave.tarifa_hora_pub_usd)
        : Number(aeronave.tarifa_hora_broker_usd));
    if (!tarifaHora || tarifaHora <= 0) {
      throw new BadRequestException(
        `Aeronave ${aeronave.matricula} no tiene tarifa ${dto.tipo_tarifa} configurada y no se proveyó tarifa_hora_override_usd`,
      );
    }
    const subtotal = tiempoCobrableHr * tarifaHora;

    const tuasOrigen = await this.computeTuas(
      route.origen_iata,
      matriculaPrefix,
      dto.pase_abordar ?? false,
      dto.tuas_override_usd_pax,
    );
    const tuasDestino = await this.computeTuas(
      route.destino_iata,
      matriculaPrefix,
      dto.pase_abordar ?? false,
      dto.tuas_override_usd_pax,
    );
    const tuasTotal =
      (tuasOrigen.aplica ? tuasOrigen.usd_pax * dto.pasajeros : 0) +
      (tuasDestino.aplica ? tuasDestino.usd_pax * dto.pasajeros : 0);

    const ivaAplicaPorMetodo =
      dto.metodo_pago === MetodoPago.TRANSFERENCIA ||
      dto.metodo_pago === MetodoPago.HSBC_LINK;
    const ivaPct =
      dto.iva_pct_override !== undefined
        ? dto.iva_pct_override
        : ivaAplicaPorMetodo
          ? IVA_DEFAULT
          : 0;
    const baseIva = subtotal + tuasTotal;
    const iva = baseIva * ivaPct;
    const total = baseIva + iva;

    return {
      aeronave: {
        id: aeronave.id,
        matricula: aeronave.matricula,
        modelo: aeronave.modelo,
        pais_registro: aeronave.pais_registro,
        velocidad_crucero_kts: velocidadKts,
      },
      ruta: {
        id: route.ruta_id,
        origen_iata: route.origen_iata,
        destino_iata: route.destino_iata,
        millas_nauticas_base: Number(route.millas_nauticas),
        millas_nauticas_totales: round2(nmTotal),
        es_redondo_auto: route.es_redondo_auto,
        num_aterrizajes: route.num_aterrizajes,
      },
      tiempos: {
        vuelo_hr: round4(tiempoVueloHr),
        calzos_hr: round4(calzosHr),
        cobrable_hr: round4(tiempoCobrableHr),
      },
      tarifa: {
        tipo: dto.tipo_tarifa,
        usd_por_hora: round2(tarifaHora),
        proviene_de_override: dto.tarifa_hora_override_usd !== undefined,
      },
      tuas: {
        usd_pax_default: dto.tuas_override_usd_pax,
        pasajeros: dto.pasajeros,
        origen: tuasOrigen,
        destino: tuasDestino,
        total_usd: round2(tuasTotal),
      },
      iva: {
        aplica_por_metodo_pago: ivaAplicaPorMetodo,
        porcentaje: round4(ivaPct),
        base_usd: round2(baseIva),
        monto_usd: round2(iva),
        nota:
          dto.metodo_pago === MetodoPago.EFECTIVO
            ? 'Pago en efectivo: sin IVA (subtotal)'
            : ivaAplicaPorMetodo
              ? 'Pago facturable: IVA 16% sobre (subtotal + TUAS)'
              : `Método ${dto.metodo_pago}: sin IVA por default`,
      },
      totales: {
        subtotal_vuelo_usd: round2(subtotal),
        tuas_total_usd: round2(tuasTotal),
        iva_usd: round2(iva),
        total_usd: round2(total),
      },
      meta: {
        calculado_at: new Date().toISOString(),
        version_motor: '1.0.0',
      },
    };
  }

  // ============ Persistence ============

  async list(filters: ListQuotesQuery) {
    let q = this.supabase.service
      .from('vuelo')
      .select(VUELO_COLS, { count: 'exact' })
      .order('fecha_solicitud', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.cliente_id) q = q.eq('cliente_id', filters.cliente_id);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.estado) q = q.eq('estado', filters.estado);
    if (typeof filters.es_externo === 'boolean') q = q.eq('es_externo', filters.es_externo);
    if (filters.q) {
      const term = `%${filters.q.toUpperCase()}%`;
      q = q.or(`origen_iata.ilike.${term},destino_iata.ilike.${term}`);
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
      .from('vuelo')
      .select(VUELO_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${id} not found`);
    return data;
  }

  async findVersions(vueloId: string) {
    await this.findById(vueloId);
    const { data, error } = await this.supabase.service
      .from('cotizacion_version_history')
      .select('*')
      .eq('vuelo_id', vueloId)
      .order('version', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async create(dto: CreateQuoteDto, userId: string) {
    const breakdown = await this.calculate(dto);

    const insertPayload = {
      cliente_id: dto.cliente_id,
      aeronave_id: dto.aeronave_id,
      ruta_id: breakdown.ruta.id,
      tipo: dto.tipo ?? TipoVuelo.REDONDO,
      estado: 'COTIZADO',
      es_externo: false,
      cotizacion_version: 1,
      origen_iata: breakdown.ruta.origen_iata,
      destino_iata: breakdown.ruta.destino_iata,
      millas_nauticas_one_way: breakdown.ruta.millas_nauticas_base,
      es_redondo_auto: breakdown.ruta.es_redondo_auto,
      num_aterrizajes: breakdown.ruta.num_aterrizajes,
      pasajeros: dto.pasajeros,
      pase_abordar: dto.pase_abordar ?? false,
      tiempo_cobrable_hr: breakdown.tiempos.cobrable_hr,
      tarifa_tipo: dto.tipo_tarifa,
      tarifa_hora_usd: breakdown.tarifa.usd_por_hora,
      subtotal_vuelo_usd: breakdown.totales.subtotal_vuelo_usd,
      tuas_usd: breakdown.totales.tuas_total_usd,
      iva_pct: breakdown.iva.porcentaje,
      iva_usd: breakdown.iva.monto_usd,
      monto_total_usd: breakdown.totales.total_usd,
      metodo_cobro: dto.metodo_pago,
      fecha_vuelo: dto.fecha_vuelo?.toISOString(),
      notas: dto.notas,
      notas_internas: dto.notas_internas,
      calculo_snapshot: breakdown,
      created_by: userId,
      updated_by: userId,
    };

    const { data: vuelo, error } = await this.supabase.service
      .from('vuelo')
      .insert(insertPayload)
      .select(VUELO_COLS)
      .maybeSingle();

    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(`Referenced entity not found: ${error.message}`);
      throw new Error(error.message);
    }

    await this.appendVersionHistory(vuelo!.id, 1, dto, breakdown, 'Versión inicial', userId);
    return vuelo!;
  }

  async revise(vueloId: string, dto: ReviseQuoteDto, userId: string) {
    const current = await this.findById(vueloId);
    if (
      current.estado === 'CONFIRMADO' ||
      current.estado === 'EN_VUELO' ||
      current.estado === 'COMPLETADO' ||
      current.estado === 'CANCELADO'
    ) {
      throw new ConflictException(
        `No se puede revisar una cotización en estado ${current.estado}. Solo SOLICITUD o COTIZADO admiten revisión.`,
      );
    }

    const breakdown = await this.calculate(dto);
    const newVersion = current.cotizacion_version + 1;

    const { data: updated, error } = await this.supabase.service
      .from('vuelo')
      .update({
        cotizacion_version: newVersion,
        aeronave_id: dto.aeronave_id,
        ruta_id: breakdown.ruta.id,
        origen_iata: breakdown.ruta.origen_iata,
        destino_iata: breakdown.ruta.destino_iata,
        millas_nauticas_one_way: breakdown.ruta.millas_nauticas_base,
        es_redondo_auto: breakdown.ruta.es_redondo_auto,
        num_aterrizajes: breakdown.ruta.num_aterrizajes,
        pasajeros: dto.pasajeros,
        pase_abordar: dto.pase_abordar ?? false,
        tiempo_cobrable_hr: breakdown.tiempos.cobrable_hr,
        tarifa_tipo: dto.tipo_tarifa,
        tarifa_hora_usd: breakdown.tarifa.usd_por_hora,
        subtotal_vuelo_usd: breakdown.totales.subtotal_vuelo_usd,
        tuas_usd: breakdown.totales.tuas_total_usd,
        iva_pct: breakdown.iva.porcentaje,
        iva_usd: breakdown.iva.monto_usd,
        monto_total_usd: breakdown.totales.total_usd,
        metodo_cobro: dto.metodo_pago,
        notas: dto.notas ?? current.notas,
        calculo_snapshot: breakdown,
        estado: current.estado === 'SOLICITUD' ? 'COTIZADO' : current.estado,
        updated_by: userId,
      })
      .eq('id', vueloId)
      .select(VUELO_COLS)
      .maybeSingle();

    if (error) throw new Error(error.message);
    await this.appendVersionHistory(vueloId, newVersion, dto, breakdown, dto.motivo, userId);
    return updated!;
  }

  async confirm(vueloId: string, userId: string) {
    const current = await this.findById(vueloId);
    if (current.estado !== 'COTIZADO') {
      throw new ConflictException(
        `Solo cotizaciones en estado COTIZADO pueden confirmarse. Estado actual: ${current.estado}`,
      );
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({
        estado: 'CONFIRMADO',
        fecha_confirmacion: new Date().toISOString(),
        updated_by: userId,
      })
      .eq('id', vueloId)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }

  async cancel(vueloId: string, motivo: string | undefined, userId: string) {
    const current = await this.findById(vueloId);
    if (current.estado === 'COMPLETADO' || current.estado === 'CANCELADO') {
      throw new ConflictException(
        `No se puede cancelar un vuelo en estado ${current.estado}`,
      );
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({
        estado: 'CANCELADO',
        fecha_cancelacion: new Date().toISOString(),
        motivo_cancelacion: motivo ?? null,
        updated_by: userId,
      })
      .eq('id', vueloId)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }

  // ============ Internals ============

  private async appendVersionHistory(
    vueloId: string,
    version: number,
    dto: CalculateQuoteDto,
    breakdown: Awaited<ReturnType<QuotesService['calculate']>>,
    motivo: string,
    userId: string,
  ): Promise<void> {
    const { error } = await this.supabase.service
      .from('cotizacion_version_history')
      .insert({
        vuelo_id: vueloId,
        version,
        aeronave_id: dto.aeronave_id,
        ruta_id: breakdown.ruta.id,
        origen_iata: breakdown.ruta.origen_iata,
        destino_iata: breakdown.ruta.destino_iata,
        millas_nauticas_one_way: breakdown.ruta.millas_nauticas_base,
        es_redondo_auto: breakdown.ruta.es_redondo_auto,
        num_aterrizajes: breakdown.ruta.num_aterrizajes,
        pasajeros: dto.pasajeros,
        pase_abordar: dto.pase_abordar ?? false,
        tiempo_cobrable_hr: breakdown.tiempos.cobrable_hr,
        tarifa_tipo: dto.tipo_tarifa,
        tarifa_hora_usd: breakdown.tarifa.usd_por_hora,
        subtotal_vuelo_usd: breakdown.totales.subtotal_vuelo_usd,
        tuas_usd: breakdown.totales.tuas_total_usd,
        iva_pct: breakdown.iva.porcentaje,
        iva_usd: breakdown.iva.monto_usd,
        monto_total_usd: breakdown.totales.total_usd,
        metodo_cobro: dto.metodo_pago,
        calculo_snapshot: breakdown,
        motivo,
        created_by: userId,
      });
    if (error) throw new Error(`Failed to write cotizacion version history: ${error.message}`);
  }

  private async resolveRoute(dto: CalculateQuoteDto): Promise<ResolvedRoute> {
    if (dto.ruta_id) {
      const r = await this.routes.findById(dto.ruta_id);
      if (!r.activa) throw new BadRequestException('Ruta inactiva');
      return {
        ruta_id: r.id,
        origen_iata: r.origen_iata,
        destino_iata: r.destino_iata,
        millas_nauticas: Number(r.millas_nauticas),
        es_redondo_auto: r.es_redondo_auto,
        num_aterrizajes: r.num_aterrizajes,
      };
    }
    if (!dto.origen_iata || !dto.destino_iata || dto.millas_nauticas === undefined) {
      throw new BadRequestException(
        'Provee ruta_id o (origen_iata + destino_iata + millas_nauticas)',
      );
    }
    return {
      ruta_id: null,
      origen_iata: dto.origen_iata.toUpperCase(),
      destino_iata: dto.destino_iata.toUpperCase(),
      millas_nauticas: dto.millas_nauticas,
      es_redondo_auto: dto.es_redondo_auto ?? true,
      num_aterrizajes: dto.num_aterrizajes ?? 2,
    };
  }

  private derivarMatriculaPrefix(matricula: string): 'XA' | 'XB' | 'N' {
    const m = matricula.toUpperCase();
    if (m.startsWith('XA')) return 'XA';
    if (m.startsWith('XB')) return 'XB';
    if (m.startsWith('N')) return 'N';
    throw new BadRequestException(
      `Matrícula ${matricula} no reconocida (debe empezar con XA, XB o N)`,
    );
  }

  private async computeTuas(
    iata: string,
    matriculaPrefix: 'XA' | 'XB' | 'N',
    paseAbordar: boolean,
    override?: number,
  ): Promise<{ aplica: boolean; usd_pax: number; razon: string; iata: string }> {
    try {
      const result = await this.airports.computeTuasUsdPax(
        iata,
        matriculaPrefix,
        paseAbordar,
      );
      const usdPax = override !== undefined ? override : result.usd_pax;
      return {
        iata,
        aplica: result.aplica,
        usd_pax: result.aplica ? usdPax : 0,
        razon: result.razon,
      };
    } catch (e) {
      if (e instanceof NotFoundException) {
        return {
          iata,
          aplica: override !== undefined && override > 0,
          usd_pax: override ?? 0,
          razon: `Aeropuerto ${iata} no registrado en catálogo${override !== undefined ? ' — usando override' : ' — TUAS no calculada'}`,
        };
      }
      throw e;
    }
  }
}

export { EstadoVuelo };
