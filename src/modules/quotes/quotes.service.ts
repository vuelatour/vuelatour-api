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
import { CalendarSyncService } from '../calendar/calendar-sync.service';
import {
  CalculateQuoteDto,
  EscalaInputDto,
  MetodoPago,
  TipoTarifa,
  TipoVuelo,
} from './dto/calculate-quote.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { EstadoVuelo, ListQuotesQuery } from './dto/list-quotes.query';
import { ReviseQuoteDto } from './dto/revise-quote.dto';

interface ResolvedRoute {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number; // total (suma para MULTIESCALA)
  es_redondo_auto: boolean;
  num_aterrizajes: number;
  ruta_id: string | null;
  escalas: EscalaInputDto[] | null; // null si es single-leg
}

export interface TuasAeropuerto {
  iata: string;
  aplica: boolean;
  usd_pax: number;
  razon: string;
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
    private readonly calendar: CalendarSyncService,
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

    // TUAS por cada aeropuerto único del itinerario (preserva orden de aparición).
    const aeropuertosOrdenados = route.escalas
      ? this.aeropuertosUnicos(route.escalas)
      : [route.origen_iata, route.destino_iata];

    const tuasAeropuertos: TuasAeropuerto[] = [];
    for (const iata of aeropuertosOrdenados) {
      tuasAeropuertos.push(
        await this.computeTuas(
          iata,
          matriculaPrefix,
          dto.pase_abordar ?? false,
          dto.tuas_override_usd_pax,
        ),
      );
    }
    const tuasTotal = tuasAeropuertos.reduce(
      (acc, t) => acc + (t.aplica ? t.usd_pax * dto.pasajeros : 0),
      0,
    );

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

    // Conservamos `origen` y `destino` siempre para retrocompat del frontend single-leg.
    // En MULTIESCALA `intermedios` lleva los demás aeropuertos.
    const tuasBlock = route.escalas
      ? {
          usd_pax_default: dto.tuas_override_usd_pax,
          pasajeros: dto.pasajeros,
          origen: tuasAeropuertos[0],
          destino: tuasAeropuertos[tuasAeropuertos.length - 1],
          intermedios: tuasAeropuertos.slice(1, -1),
          aeropuertos: tuasAeropuertos,
          total_usd: round2(tuasTotal),
        }
      : {
          usd_pax_default: dto.tuas_override_usd_pax,
          pasajeros: dto.pasajeros,
          origen: tuasAeropuertos[0],
          destino: tuasAeropuertos[1],
          total_usd: round2(tuasTotal),
        };

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
        escalas: route.escalas,
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
      tuas: tuasBlock,
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
        version_motor: '1.1.0',
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
    // Adjuntar escalas plan (sin tacometros - es lo que se mostro al cotizar).
    const escalas = await this.findEscalas(id);
    return { ...data, escalas };
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

    if (breakdown.ruta.escalas) {
      await this.replaceEscalas(vuelo!.id, breakdown.ruta.escalas, userId);
    }

    await this.appendVersionHistory(vuelo!.id, 1, dto, breakdown, 'Versión inicial', userId);

    const escalas = await this.findEscalas(vuelo!.id);
    return { ...vuelo!, escalas };
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
        tipo: dto.tipo ?? current.tipo,
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
    await this.replaceEscalas(vueloId, breakdown.ruta.escalas ?? null, userId);
    await this.appendVersionHistory(vueloId, newVersion, dto, breakdown, dto.motivo, userId);
    const escalas = await this.findEscalas(vueloId);
    return { ...updated!, escalas };
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
    void this.calendar.syncFlight(vueloId);
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
    void this.calendar.removeFlight(vueloId);
    return data!;
  }

  // ============ Internals ============

  private async findEscalas(vueloId: string) {
    const { data, error } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, origen_iata, destino_iata, millas_nauticas, taco_salida, taco_llegada, hora_salida, hora_llegada, notas',
      )
      .eq('vuelo_id', vueloId)
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Reemplaza el plan de escalas. Solo aplica para MULTIESCALA. Para vuelos no
   * multiescala que tuvieran escalas (cambio de tipo en revise), las borra.
   */
  private async replaceEscalas(
    vueloId: string,
    escalas: EscalaInputDto[] | null,
    userId: string,
  ): Promise<void> {
    const { error: delErr } = await this.supabase.service
      .from('escala')
      .delete()
      .eq('vuelo_id', vueloId);
    if (delErr) throw new Error(`Failed to clear escalas: ${delErr.message}`);

    if (!escalas || escalas.length === 0) return;

    const rows = escalas.map((e, idx) => ({
      vuelo_id: vueloId,
      orden: idx + 1,
      origen_iata: e.origen_iata.toUpperCase(),
      destino_iata: e.destino_iata.toUpperCase(),
      millas_nauticas: e.millas_nauticas,
      created_by: userId,
      updated_by: userId,
    }));
    const { error: insErr } = await this.supabase.service
      .from('escala')
      .insert(rows);
    if (insErr) throw new Error(`Failed to insert escalas: ${insErr.message}`);
  }

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
    // Ruta del catalogo (incluye multiescala con tramos hidratados).
    // Prioritaria sobre dto.tipo / dto.escalas porque el catalogo es la fuente.
    if (dto.ruta_id) {
      const r = await this.routes.findById(dto.ruta_id);
      if (!r.activa) throw new BadRequestException('Ruta inactiva');
      if (r.tipo === 'MULTIESCALA' && r.tramos && r.tramos.length >= 2) {
        const escalasNorm: EscalaInputDto[] = r.tramos.map((t) => ({
          origen_iata: t.origen_iata.toUpperCase(),
          destino_iata: t.destino_iata.toUpperCase(),
          millas_nauticas: Number(t.millas_nauticas),
        }));
        return {
          ruta_id: r.id,
          origen_iata: escalasNorm[0].origen_iata,
          destino_iata: escalasNorm[escalasNorm.length - 1].destino_iata,
          millas_nauticas: escalasNorm.reduce((acc, e) => acc + e.millas_nauticas, 0),
          es_redondo_auto: false,
          num_aterrizajes: escalasNorm.length,
          escalas: escalasNorm,
        };
      }
      return {
        ruta_id: r.id,
        origen_iata: r.origen_iata,
        destino_iata: r.destino_iata,
        millas_nauticas: Number(r.millas_nauticas),
        es_redondo_auto: r.es_redondo_auto,
        num_aterrizajes: r.num_aterrizajes,
        escalas: null,
      };
    }

    // Sin ruta_id: MULTIESCALA requiere escalas[] explicitas.
    if (dto.tipo === TipoVuelo.MULTIESCALA) {
      if (!dto.escalas || dto.escalas.length < 2) {
        throw new BadRequestException(
          'MULTIESCALA requiere al menos 2 escalas (origen->intermedio->destino).',
        );
      }
      for (let i = 0; i < dto.escalas.length - 1; i++) {
        const a = dto.escalas[i].destino_iata.toUpperCase();
        const b = dto.escalas[i + 1].origen_iata.toUpperCase();
        if (a !== b) {
          throw new BadRequestException(
            `Escala ${i + 2}: el origen (${b}) debe coincidir con el destino de la escala ${i + 1} (${a}).`,
          );
        }
      }
      const escalasNorm: EscalaInputDto[] = dto.escalas.map((e) => ({
        origen_iata: e.origen_iata.toUpperCase(),
        destino_iata: e.destino_iata.toUpperCase(),
        millas_nauticas: Number(e.millas_nauticas),
      }));
      const nmTotal = escalasNorm.reduce((acc, e) => acc + e.millas_nauticas, 0);
      return {
        ruta_id: null,
        origen_iata: escalasNorm[0].origen_iata,
        destino_iata: escalasNorm[escalasNorm.length - 1].destino_iata,
        millas_nauticas: nmTotal,
        es_redondo_auto: false,
        num_aterrizajes: escalasNorm.length,
        escalas: escalasNorm,
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
      escalas: null,
    };
  }

  /**
   * Aeropuertos únicos del itinerario en orden de aparición. Para
   * CUN-HOL-CZM-CUN devuelve [CUN, HOL, CZM] (sin duplicar el regreso a CUN
   * porque TUAS por aeropuerto se cobra por aeropuerto, no por aterrizaje).
   */
  private aeropuertosUnicos(escalas: EscalaInputDto[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of escalas) {
      for (const iata of [e.origen_iata, e.destino_iata]) {
        const u = iata.toUpperCase();
        if (!seen.has(u)) {
          seen.add(u);
          out.push(u);
        }
      }
    }
    return out;
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
  ): Promise<TuasAeropuerto> {
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
