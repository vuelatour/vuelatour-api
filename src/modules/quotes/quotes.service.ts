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
import { EmailService } from '../notifications/email.service';
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

/** Tramo con sus detalles ya resueltos (defaults aplicados). */
export interface ResolvedLeg {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number;
  pasajeros: number; // ferry => 0; si no, leg.pasajeros ?? pax global
  es_ferry: boolean;
  requiere_pernocta: boolean;
  pernocta_costo_usd: number; // 0 si no hay pernocta
  tipo_parada: 'NORMAL' | 'SERVICIO';
  servicio_notas: string | null;
  /** Fecha/hora planeada de salida del tramo (ISO). Null = sin definir aún. */
  fecha_salida_plan: string | null;
}

interface ResolvedRoute {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number; // total (suma para MULTIESCALA)
  es_redondo_auto: boolean;
  num_aterrizajes: number;
  ruta_id: string | null;
  escalas: ResolvedLeg[] | null; // null si es single-leg
}

/** Forma mínima de un tramo de entrada (escala de cotización o tramo de ruta). */
interface RawLeg {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number | string;
  pasajeros?: number | null;
  es_ferry?: boolean | null;
  requiere_pernocta?: boolean | null;
  pernocta_costo_usd?: number | string | null;
  tipo_parada?: string | null;
  servicio_notas?: string | null;
  fecha_salida_plan?: Date | string | null;
}

export interface TuasAeropuerto {
  iata: string;
  aplica: boolean;
  usd_pax: number;
  razon: string;
}

const IVA_DEFAULT = 0.16;
const CALZOS_HR_POR_ATERRIZAJE = 0.15;
// Costo default de pernocta/viáticos por tramo (USD). Editable por tramo; confirmar
// el monto con finanzas. Se usa cuando el tramo marca pernocta sin costo explícito.
const PERNOCTA_COSTO_DEFAULT_USD = 150;

const VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, piloto_id, ruta_id, tipo, estado, es_externo, operador_externo, costo_externo_usd, cotizacion_version, origen_iata, destino_iata, millas_nauticas_one_way, es_redondo_auto, num_aterrizajes, pasajeros, pase_abordar, tiempo_cobrable_hr, tarifa_tipo, tarifa_hora_usd, subtotal_vuelo_usd, tuas_usd, iva_pct, iva_usd, monto_total_usd, tc_usd_mxn, monto_total_mxn, metodo_cobro, pago_anticipado_req, estado_permiso, fecha_solicitud, fecha_vuelo, fecha_traslado_final, fecha_confirmacion, fecha_cancelacion, motivo_cancelacion, google_calendar_id, facturado, cobrado, notas, notas_internas, calculo_snapshot, created_at, updated_at';

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
    private readonly email: EmailService,
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

    // TUAS por cada aeropuerto único del itinerario (preserva orden de aparición),
    // para mostrar el desglose por aeropuerto.
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

    // TUAS total:
    // - MULTIESCALA: por tramo no-ferry, usd_pax(aeropuerto de salida) × pax del tramo.
    // - REDONDO/single-leg: aeropuertos únicos × pax global (modelo histórico, sin cambio).
    const tramosTuas: number[] = [];
    let tuasTotal = 0;
    if (route.escalas) {
      for (const leg of route.escalas) {
        const t = await this.computeTuas(
          leg.origen_iata,
          matriculaPrefix,
          dto.pase_abordar ?? false,
          dto.tuas_override_usd_pax,
        );
        const legTuas =
          !leg.es_ferry && t.aplica ? round2(t.usd_pax * leg.pasajeros) : 0;
        tramosTuas.push(legTuas);
        tuasTotal += legTuas;
      }
    } else {
      tuasTotal = tuasAeropuertos.reduce(
        (acc, t) => acc + (t.aplica ? t.usd_pax * dto.pasajeros : 0),
        0,
      );
    }

    // Pernocta / viáticos: suma de tramos con pernocta (fuera de la base de IVA).
    const viaticosPernocta = (route.escalas ?? []).reduce(
      (acc, leg) => acc + (leg.requiere_pernocta ? leg.pernocta_costo_usd : 0),
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
    const total = baseIva + iva + viaticosPernocta;

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
      // Desglose por tramo (null en single-leg/REDONDO simple).
      tramos: route.escalas
        ? route.escalas.map((leg, i) => ({
            orden: i + 1,
            origen: leg.origen_iata,
            destino: leg.destino_iata,
            millas: round2(leg.millas_nauticas),
            pasajeros: leg.pasajeros,
            es_ferry: leg.es_ferry,
            tiempo_hr: round4(
              leg.millas_nauticas / velocidadKts + CALZOS_HR_POR_ATERRIZAJE,
            ),
            tuas_usd: round2(tramosTuas[i] ?? 0),
            requiere_pernocta: leg.requiere_pernocta,
            pernocta_usd: round2(leg.pernocta_costo_usd),
            tipo_parada: leg.tipo_parada,
            servicio_notas: leg.servicio_notas,
          }))
        : null,
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
        viaticos_pernocta_usd: round2(viaticosPernocta),
        iva_usd: round2(iva),
        total_usd: round2(total),
      },
      meta: {
        calculado_at: new Date().toISOString(),
        version_motor: '1.2.0',
      },
    };
  }

  // ============ Persistence ============

  /**
   * Pax representativo del vuelo (para vuelo.pasajeros, que muchos lectores usan):
   * el máximo de pax entre tramos no-ferry. Si no hay tramos, usa el pax global.
   */
  private representativePax(
    breakdown: Awaited<ReturnType<QuotesService['calculate']>>,
    fallback: number,
  ): number {
    const tramos = breakdown.tramos;
    if (!tramos || tramos.length === 0) return fallback;
    const noFerry = tramos.filter((t) => !t.es_ferry).map((t) => t.pasajeros);
    return noFerry.length ? Math.max(...noFerry) : fallback;
  }

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
    const reprPax = this.representativePax(breakdown, dto.pasajeros);

    // Permiso de pista: pendiente si origen/destino (o algún tramo) requiere permiso.
    const iatas = [
      breakdown.ruta.origen_iata,
      breakdown.ruta.destino_iata,
      ...(breakdown.ruta.escalas ?? []).flatMap((e) => [e.origen_iata, e.destino_iata]),
    ];
    const requierePermiso = await this.airports.anyRequiresPermit(iatas);

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
      pasajeros: reprPax,
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
      estado_permiso: requierePermiso ? 'pendiente' : 'no_aplica',
      fecha_vuelo: dto.fecha_vuelo?.toISOString(),
      fecha_traslado_final: dto.fecha_traslado_final?.toISOString(),
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
      await this.replaceEscalas(vuelo!.id, breakdown.ruta.escalas, userId, {
        inicio: dto.fecha_vuelo?.toISOString() ?? null,
        fin: dto.fecha_traslado_final?.toISOString() ?? null,
      });
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
    const reprPax = this.representativePax(breakdown, dto.pasajeros);
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
        pasajeros: reprPax,
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
    await this.replaceEscalas(vueloId, breakdown.ruta.escalas ?? null, userId, {
      inicio: (current.fecha_vuelo as string | null) ?? null,
      fin: (current.fecha_traslado_final as string | null) ?? null,
    });
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
    // REDONDO: crea los 2 tramos (ida + regreso) para asignarlos por separado.
    await this.ensureRedondoEscalas(data!, userId);
    void this.calendar.syncFlight(vueloId);
    void this.sendConfirmationEmail(data!);
    return data!;
  }

  /**
   * Crea los 2 tramos de un vuelo REDONDO (ida orden=1, regreso orden=2 con IATAs
   * invertidos) para que ida y regreso se asignen por separado. Idempotente: si el
   * vuelo ya tiene escalas (MULTIESCALA, o un REDONDO ya inicializado) no hace nada.
   * El permiso de pista de cada tramo se deriva de aeropuerto.requiere_permiso.
   */
  private async ensureRedondoEscalas(
    vuelo: Record<string, unknown>,
    userId: string,
  ): Promise<void> {
    if (vuelo.tipo !== 'REDONDO') return;
    const vueloId = vuelo.id as string;
    const { count, error: cErr } = await this.supabase.service
      .from('escala')
      .select('id', { count: 'exact', head: true })
      .eq('vuelo_id', vueloId);
    if (cErr) throw new Error(cErr.message);
    if ((count ?? 0) > 0) return;

    const origen = vuelo.origen_iata as string;
    const destino = vuelo.destino_iata as string;
    const requierePermiso = await this.airports.anyRequiresPermit([origen, destino]);
    const permiso = requierePermiso ? 'pendiente' : 'no_aplica';

    const pax = Number(vuelo.pasajeros ?? 0);
    const rows = [
      {
        vuelo_id: vueloId,
        orden: 1,
        origen_iata: origen,
        destino_iata: destino,
        aeronave_id: (vuelo.aeronave_id as string | null) ?? null,
        piloto_id: (vuelo.piloto_id as string | null) ?? null,
        estado_permiso: permiso,
        fecha_salida_plan: (vuelo.fecha_vuelo as string | null) ?? null,
        pasajeros: pax,
        es_ferry: false,
        tipo_parada: 'NORMAL',
        created_by: userId,
        updated_by: userId,
      },
      {
        vuelo_id: vueloId,
        orden: 2,
        origen_iata: destino,
        destino_iata: origen,
        aeronave_id: null,
        piloto_id: null,
        estado_permiso: permiso,
        fecha_salida_plan: (vuelo.fecha_traslado_final as string | null) ?? null,
        // Regreso NO ferry por default (los pax suelen regresar); editable luego.
        pasajeros: pax,
        es_ferry: false,
        tipo_parada: 'NORMAL',
        created_by: userId,
        updated_by: userId,
      },
    ];
    const { error } = await this.supabase.service.from('escala').insert(rows);
    if (error) throw new Error(`No se pudieron crear los tramos del redondo: ${error.message}`);
  }

  /** Envía el correo de confirmación al cliente (best-effort). */
  private async sendConfirmationEmail(vuelo: Record<string, unknown>): Promise<void> {
    const clienteId = vuelo.cliente_id as string | null;
    if (!clienteId) return;
    const { data: cliente } = await this.supabase.service
      .from('cliente')
      .select('nombre, email')
      .eq('id', clienteId)
      .maybeSingle();
    const email = (cliente as { email: string | null } | null)?.email;
    if (!email) return;
    void this.email.sendFlightConfirmation({
      to: email,
      clienteNombre: (cliente as { nombre: string }).nombre ?? 'Cliente',
      folio: vuelo.folio as number,
      origenIata: vuelo.origen_iata as string,
      destinoIata: vuelo.destino_iata as string,
      pasajeros: Number(vuelo.pasajeros ?? 0),
      fechaVuelo: (vuelo.fecha_vuelo as string | null) ?? null,
      montoTotalUsd: Number(vuelo.monto_total_usd ?? 0),
    });
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
        'id, vuelo_id, orden, origen_iata, destino_iata, millas_nauticas, pasajeros, es_ferry, requiere_pernocta, pernocta_costo_usd, tipo_parada, servicio_notas, fecha_salida_plan, taco_salida, taco_llegada, hora_salida, hora_llegada, notas',
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
    escalas: ResolvedLeg[] | null,
    userId: string,
    fechas?: { inicio?: string | null; fin?: string | null },
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
      pasajeros: e.es_ferry ? 0 : e.pasajeros,
      es_ferry: e.es_ferry,
      requiere_pernocta: e.requiere_pernocta,
      pernocta_costo_usd: e.requiere_pernocta ? e.pernocta_costo_usd : null,
      tipo_parada: e.tipo_parada,
      servicio_notas: e.servicio_notas,
      // Fecha del tramo: explícita, o por default el 1er tramo hereda la fecha
      // de salida del vuelo y el último la del traslado final.
      fecha_salida_plan:
        e.fecha_salida_plan ??
        (idx === 0
          ? (fechas?.inicio ?? null)
          : idx === escalas.length - 1
            ? (fechas?.fin ?? null)
            : null),
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

  /**
   * Resuelve los detalles por tramo aplicando defaults: ferry fuerza 0 pax;
   * pax = leg.pasajeros ?? pax global; pernocta_costo solo si requiere pernocta.
   */
  private resolveLegs(raw: RawLeg[], globalPax: number): ResolvedLeg[] {
    return raw.map((l) => {
      const esFerry = l.es_ferry ?? false;
      const requierePernocta = l.requiere_pernocta ?? false;
      const pernoctaCosto = requierePernocta
        ? (l.pernocta_costo_usd != null
            ? Number(l.pernocta_costo_usd)
            : PERNOCTA_COSTO_DEFAULT_USD)
        : 0;
      return {
        origen_iata: l.origen_iata.toUpperCase(),
        destino_iata: l.destino_iata.toUpperCase(),
        millas_nauticas: Number(l.millas_nauticas),
        pasajeros: esFerry ? 0 : (l.pasajeros ?? globalPax),
        es_ferry: esFerry,
        requiere_pernocta: requierePernocta,
        pernocta_costo_usd: pernoctaCosto,
        tipo_parada: l.tipo_parada === 'SERVICIO' ? 'SERVICIO' : 'NORMAL',
        servicio_notas: l.servicio_notas ?? null,
        fecha_salida_plan:
          l.fecha_salida_plan instanceof Date
            ? l.fecha_salida_plan.toISOString()
            : (l.fecha_salida_plan ?? null),
      };
    });
  }

  private async resolveRoute(dto: CalculateQuoteDto): Promise<ResolvedRoute> {
    // Ruta del catalogo (incluye multiescala con tramos hidratados).
    // Prioritaria sobre dto.tipo / dto.escalas porque el catalogo es la fuente.
    if (dto.ruta_id) {
      const r = await this.routes.findById(dto.ruta_id);
      if (!r.activa) throw new BadRequestException('Ruta inactiva');
      if (r.tipo === 'MULTIESCALA' && r.tramos && r.tramos.length >= 1) {
        // Hidrata los defaults por tramo de la plantilla guardada.
        const escalasNorm = this.resolveLegs(r.tramos as RawLeg[], dto.pasajeros);
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
      if (!dto.escalas || dto.escalas.length < 1) {
        throw new BadRequestException(
          'El itinerario requiere al menos 1 tramo (agrega el regreso si aplica).',
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
      const escalasNorm = this.resolveLegs(dto.escalas as RawLeg[], dto.pasajeros);
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
  private aeropuertosUnicos(
    escalas: { origen_iata: string; destino_iata: string }[],
  ): string[] {
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
