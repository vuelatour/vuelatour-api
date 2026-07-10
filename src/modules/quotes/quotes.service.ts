import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AircraftService } from '../aircraft/aircraft.service';
import { AirportsService } from '../airports/airports.service';
import { RoutesService } from '../routes/routes.service';
import { SupabaseService } from '../supabase/supabase.service';
import { CalendarSyncService } from '../calendar/calendar-sync.service';
import { EmailService } from '../notifications/email.service';
import { NotificationsService } from '../realtime/notifications.service';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import {
  CalculateQuoteDto,
  EscalaInputDto,
  MetodoPago,
  TipoTarifa,
  TipoVuelo,
} from './dto/calculate-quote.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { EstadoVuelo, ListQuotesQuery } from './dto/list-quotes.query';
import { QuickAdjustQuoteDto } from './dto/quick-adjust.dto';
import { ReviseQuoteDto } from './dto/revise-quote.dto';

/** Tramo con sus detalles ya resueltos (defaults aplicados). */
export interface ResolvedLeg {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number;
  pasajeros: number; // ferry => 0; si no, leg.pasajeros ?? pax global
  /** Manifiesto de nombres de ESTE tramo (puede variar por escala / ir vacío). */
  pasajeros_nombres: string[];
  es_ferry: boolean;
  requiere_pernocta: boolean;
  pernocta_costo_usd: number; // 0 si no hay pernocta
  tipo_parada: 'NORMAL' | 'SERVICIO';
  servicio_notas: string | null;
  /** Nota operativa del tramo para el piloto (ej. "cargar gasolina aquí"). */
  notas: string | null;
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
  pasajeros_nombres?: string[] | null;
  es_ferry?: boolean | null;
  requiere_pernocta?: boolean | null;
  pernocta_costo_usd?: number | string | null;
  tipo_parada?: string | null;
  servicio_notas?: string | null;
  notas?: string | null;
  fecha_salida_plan?: Date | string | null;
}

/** Ruta sugerida por historial del cliente (grupo de itinerarios iguales). */
export interface RutaSugerida {
  clave: string;
  etiqueta: string;
  veces: number;
  ultima_fecha: string | null;
  ruta_id: string | null;
  tramos: Array<Record<string, unknown>>;
}

export interface TuasAeropuerto {
  iata: string;
  aplica: boolean;
  usd_pax: number;
  razon: string;
}

const IVA_DEFAULT = 0.16;
/** Prefijo del extra sintetizado por el motor para la comisión de BillPocket. */
const COMISION_BILLPOCKET_PREFIX = 'Comisión BillPocket';
const CALZOS_HR_POR_ATERRIZAJE = 0.15;
// Costo default de pernocta/viáticos por tramo (USD). Editable por tramo; confirmar
// el monto con finanzas. Se usa cuando el tramo marca pernocta sin costo explícito.
const PERNOCTA_COSTO_DEFAULT_USD = 150;

const VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, piloto_id, ruta_id, tipo, estado, es_externo, operador_externo, costo_externo_usd, cotizacion_version, origen_iata, destino_iata, millas_nauticas_one_way, es_redondo_auto, num_aterrizajes, pasajeros, pasajeros_nombres, pase_abordar, tiempo_cobrable_hr, tarifa_tipo, tarifa_hora_usd, subtotal_vuelo_usd, tuas_usd, iva_pct, iva_usd, monto_total_usd, viaticos_pernocta_usd, extras_total_usd, ajuste_final_usd, comision_vendedor_usd, comision_vendedor_nombre, tc_usd_mxn, monto_total_mxn, metodo_cobro, pago_anticipado_req, cotizacion_abierta, itinerario_operativo, extras, estado_permiso, fecha_solicitud, fecha_vuelo, fecha_traslado_final, fecha_confirmacion, fecha_cancelacion, motivo_cancelacion, google_calendar_id, facturado, cobrado, notas, notas_internas, calculo_snapshot, created_at, updated_at';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(
    private readonly aircraft: AircraftService,
    private readonly airports: AirportsService,
    private readonly routes: RoutesService,
    private readonly supabase: SupabaseService,
    private readonly calendar: CalendarSyncService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Pure calculation, no persistence. Returns the full breakdown.
   */
  async calculate(dto: CalculateQuoteDto) {
    const aeronave = await this.aircraft.findById(dto.aeronave_id);
    if (!aeronave.activa) throw new BadRequestException('Aeronave inactiva');

    const route = await this.resolveRoute(dto);
    const matriculaPrefix = this.derivarMatriculaPrefix(aeronave.matricula);

    // El "redondo automático" (×2) se eliminó: las millas son SIEMPRE la suma
    // explícita de los tramos del itinerario. resolveRoute rechaza los caminos
    // legacy que dependían de duplicar millas.
    const nmTotal = Number(route.millas_nauticas);

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

    // Conceptos extra (handler, comisariato, extensión de servicios…): los
    // gravados entran a la base de IVA; los no gravados se suman al final.
    const extras = (dto.extras ?? [])
      .map((e) => ({
        concepto: e.concepto.trim(),
        monto_usd: round2(Number(e.monto_usd) || 0),
        aplica_iva: e.aplica_iva ?? true,
      }))
      .filter((e) => e.concepto.length > 0 && e.monto_usd > 0)
      // La comisión BillPocket la sintetiza el MOTOR (línea abajo): se
      // descarta cualquier copia persistida para no duplicarla al re-cotizar.
      .filter((e) => !e.concepto.startsWith(COMISION_BILLPOCKET_PREFIX));
    const extrasConIva = extras
      .filter((e) => e.aplica_iva)
      .reduce((acc, e) => acc + e.monto_usd, 0);
    const extrasSinIva = extras
      .filter((e) => !e.aplica_iva)
      .reduce((acc, e) => acc + e.monto_usd, 0);

    const ivaAplicaPorMetodo =
      dto.metodo_pago === MetodoPago.TRANSFERENCIA ||
      dto.metodo_pago === MetodoPago.HSBC_LINK;
    const ivaPct =
      dto.iva_pct_override !== undefined
        ? dto.iva_pct_override
        : ivaAplicaPorMetodo
          ? IVA_DEFAULT
          : 0;
    // Integridad contable (balance): cada componente se redondea PRIMERO y el
    // total es la suma exacta de los componentes redondeados — el desglose
    // siempre cuadra al centavo con el total registrado.
    const subtotalR = round2(subtotal);
    const tuasR = round2(tuasTotal);
    const extrasConIvaR = round2(extrasConIva);
    const extrasSinIvaR = round2(extrasSinIva);
    const pernoctaR = round2(viaticosPernocta);
    // Ajuste (negativo = descuento, positivo = redondeo) ANTES del IVA: reduce la
    // base gravable para que el descuento también baje el IVA (si se cobra IVA).
    const ajusteFinal = round2(Number(dto.ajuste_final_usd) || 0);
    const baseIva = round2(subtotalR + tuasR + extrasConIvaR + ajusteFinal);
    const iva = round2(baseIva * ivaPct);
    const totalSinComision = round2(baseIva + iva + pernoctaR + extrasSinIvaR);

    // Comisión BillPocket (no factura → sin IVA): porcentaje CUSTOM que la
    // terminal cobra (5%, 9%… tope 20%). Se cobra al cliente como línea sin
    // IVA sobre todo lo demás, sintetizada como "extra" para que fluya igual
    // que cualquier concepto (desglose, PDF, reporte, balance) sin columnas
    // nuevas.
    const comisionPct =
      dto.metodo_pago === MetodoPago.BILLPOCKET
        ? Math.min(Number(dto.comision_billpocket_pct) || 0, 20)
        : 0;
    const comisionR = round2((totalSinComision * comisionPct) / 100);
    let extrasSinIvaRFinal = extrasSinIvaR;
    if (comisionR > 0) {
      extras.push({
        concepto: `${COMISION_BILLPOCKET_PREFIX} (${round2(comisionPct)}%)`,
        monto_usd: comisionR,
        aplica_iva: false,
      });
      extrasSinIvaRFinal = round2(extrasSinIvaR + comisionR);
    }
    const total = round2(totalSinComision + comisionR);
    // Comisión del vendedor (Itzy/Pablo/broker): sale del precio, no del
    // cliente — solo meta/neto, el total canónico queda intacto.
    const comisionVendedor = Math.min(
      round2(Number(dto.comision_vendedor_usd) || 0),
      total,
    );

    // Desglose canónico para el balance: cada concepto cobrado al cliente como
    // línea independiente; la suma de las líneas ES el total.
    const desglose: Array<{ clave: string; concepto: string; monto_usd: number }> = [
      {
        clave: 'TIEMPO_VUELO',
        concepto: `Tiempo de vuelo · ${round4(tiempoCobrableHr)} hr × $${round2(tarifaHora)}/hr`,
        monto_usd: subtotalR,
      },
      ...(tuasR > 0
        ? [{ clave: 'TUAS', concepto: 'TUAS', monto_usd: tuasR }]
        : []),
      ...extras.map((e) => ({
        clave: 'EXTRA',
        concepto: `${e.concepto}${e.aplica_iva ? '' : ' (sin IVA)'}`,
        monto_usd: e.monto_usd,
      })),
      // El ajuste/descuento se lista ANTES del IVA porque reduce la base gravable.
      ...(ajusteFinal !== 0
        ? [
            {
              clave: 'AJUSTE',
              concepto: ajusteFinal < 0 ? 'Descuento' : 'Redondeo',
              monto_usd: ajusteFinal,
            },
          ]
        : []),
      ...(iva > 0
        ? [
            {
              clave: 'IVA',
              concepto: `IVA ${round2(ivaPct * 100)}%`,
              monto_usd: iva,
            },
          ]
        : []),
      ...(pernoctaR > 0
        ? [
            {
              clave: 'PERNOCTA',
              concepto: 'Viáticos por pernocta (sin IVA)',
              monto_usd: pernoctaR,
            },
          ]
        : []),
    ];

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
          total_usd: tuasR,
        }
      : {
          usd_pax_default: dto.tuas_override_usd_pax,
          pasajeros: dto.pasajeros,
          origen: tuasAeropuertos[0],
          destino: tuasAeropuertos[1],
          total_usd: tuasR,
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
        base_usd: baseIva,
        monto_usd: iva,
        nota:
          dto.metodo_pago === MetodoPago.EFECTIVO
            ? 'Pago en efectivo: sin IVA (subtotal)'
            : ivaAplicaPorMetodo
              ? 'Pago facturable: IVA 16% sobre (subtotal + TUAS + extras gravados)'
              : `Método ${dto.metodo_pago}: sin IVA por default`,
      },
      extras: extras.length > 0 ? extras : null,
      // Desglose canónico para el balance: las líneas suman EXACTAMENTE el total.
      desglose,
      totales: {
        subtotal_vuelo_usd: subtotalR,
        tuas_total_usd: tuasR,
        viaticos_pernocta_usd: pernoctaR,
        extras_total_usd: round2(extrasConIvaR + extrasSinIvaRFinal),
        ajuste_final_usd: ajusteFinal,
        iva_usd: iva,
        total_usd: total,
      },
      meta: {
        calculado_at: new Date().toISOString(),
        version_motor: '1.3.1',
        comision_billpocket_pct: comisionPct > 0 ? round2(comisionPct) : null,
        // Comisión del VENDEDOR: informativa (NO altera el desglose canónico —
        // el cliente paga el total completo). El neto es lo que queda a
        // VuelaTour y fluye a reparto/reportes. Interna: nunca al PDF cliente.
        comision_vendedor_usd: comisionVendedor > 0 ? comisionVendedor : null,
        comision_vendedor_nombre:
          comisionVendedor > 0 ? (dto.comision_vendedor_nombre?.trim() || null) : null,
        neto_vuelatour_usd: comisionVendedor > 0 ? round2(total - comisionVendedor) : null,
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
      const raw = filters.q.trim();
      const term = `%${raw.toUpperCase()}%`;
      const conds = [`origen_iata.ilike.${term}`, `destino_iata.ilike.${term}`];
      // Folio exacto si es numérico.
      if (/^\d+$/.test(raw)) conds.push(`folio.eq.${raw}`);
      // Por nombre de cliente ("¿cuánto le cobré a Punta Pájaros?").
      const { data: clientes } = await this.supabase.service
        .from('cliente')
        .select('id')
        .ilike('nombre', `%${raw}%`)
        .limit(50);
      if (clientes && clientes.length > 0) {
        conds.push(`cliente_id.in.(${clientes.map((c) => c.id as string).join(',')})`);
      }
      // Por ciudad/nombre de aeropuerto ("Miami" → MIA/OPF/…): resuelve IATAs.
      const { data: aeropuertos } = await this.supabase.service
        .from('aeropuerto')
        .select('iata')
        .or(`ciudad.ilike.%${raw}%,nombre.ilike.%${raw}%`)
        .limit(20);
      for (const a of aeropuertos ?? []) {
        const iata = (a.iata as string)?.toUpperCase();
        if (iata) {
          conds.push(`origen_iata.eq.${iata}`, `destino_iata.eq.${iata}`);
        }
      }
      q = q.or(conds.join(','));
    }
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    // Ruta COMPLETA (origen → escalas → destino) por cotización para el listado.
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const rutas = await this.rutasIatasPorVuelo(
      rows.map((r) => r.id as string),
    );
    const dataConRuta = rows.map((r) => ({
      ...r,
      ruta_iatas:
        rutas.get(r.id as string) ??
        [r.origen_iata as string, r.destino_iata as string].filter(Boolean),
    }));
    return {
      data: dataConRuta,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /** Cadena de puntos de la ruta real (origen 1er tramo + destinos) por lote. */
  private async rutasIatasPorVuelo(
    vueloIds: string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (vueloIds.length === 0) return out;
    const { data } = await this.supabase.service
      .from('escala')
      .select('vuelo_id, orden, origen_iata, destino_iata')
      .in('vuelo_id', vueloIds)
      .eq('solo_operativa', false)
      .order('orden', { ascending: true });
    const porVuelo = new Map<string, Array<Record<string, unknown>>>();
    for (const e of data ?? []) {
      const vid = e.vuelo_id as string;
      (porVuelo.get(vid) ?? porVuelo.set(vid, []).get(vid)!).push(e);
    }
    for (const [vid, legs] of porVuelo) {
      if (legs.length === 0) continue;
      out.set(vid, [
        legs[0].origen_iata as string,
        ...legs.map((l) => l.destino_iata as string),
      ]);
    }
    return out;
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
      pasajeros_nombres: dto.pasajeros_nombres ?? [],
      pase_abordar: dto.pase_abordar ?? false,
      tiempo_cobrable_hr: breakdown.tiempos.cobrable_hr,
      tarifa_tipo: dto.tipo_tarifa,
      tarifa_hora_usd: breakdown.tarifa.usd_por_hora,
      subtotal_vuelo_usd: breakdown.totales.subtotal_vuelo_usd,
      tuas_usd: breakdown.totales.tuas_total_usd,
      iva_pct: breakdown.iva.porcentaje,
      iva_usd: breakdown.iva.monto_usd,
      monto_total_usd: breakdown.totales.total_usd,
      // TC declarado al cotizar (el pago puede entrar en pesos): habilita el
      // total MXN y sirve de respaldo para convertir cobros MXN sin TC.
      tc_usd_mxn: dto.tc_usd_mxn ?? null,
      monto_total_mxn: dto.tc_usd_mxn
        ? Math.round(breakdown.totales.total_usd * dto.tc_usd_mxn * 100) / 100
        : null,
      viaticos_pernocta_usd: breakdown.totales.viaticos_pernocta_usd,
      extras_total_usd: breakdown.totales.extras_total_usd,
      ajuste_final_usd: breakdown.totales.ajuste_final_usd,
      comision_vendedor_usd: breakdown.meta.comision_vendedor_usd ?? 0,
      comision_vendedor_nombre: breakdown.meta.comision_vendedor_nombre ?? null,
      metodo_cobro: dto.metodo_pago,
      cotizacion_abierta: dto.cotizacion_abierta ?? false,
      // Con ruta operativa: las escalas del vuelo son las del PILOTO y la
      // cotización nunca las pisa (replaceEscalas hace early-return).
      itinerario_operativo: (dto.escalas_operacion?.length ?? 0) > 0,
      extras: breakdown.extras ?? [],
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

    if ((dto.escalas_operacion?.length ?? 0) > 0) {
      // Ruta OPERATIVA (mismas semánticas que la reserva del vuelo rápido):
      // ferry → solo_operativa (el piloto lo ve, el cliente no) y pernocta
      // automática si el siguiente tramo sale otro día (hora Cancún).
      const itinerario = dto.escalas_operacion!;
      const dayCancun = (d: Date): string =>
        d.toLocaleDateString('en-CA', { timeZone: 'America/Cancun' });
      const fechaEfectiva = (i: number): Date | null =>
        itinerario[i]?.hora_salida ?? (i === 0 ? (dto.fecha_vuelo ?? null) : null);
      const legs = itinerario.map((e, i) => {
        let referencia: Date | null = null;
        for (let j = i; j >= 0 && !referencia; j--) referencia = fechaEfectiva(j);
        const siguiente = itinerario[i + 1]?.hora_salida ?? null;
        const pernocta =
          referencia != null &&
          siguiente != null &&
          dayCancun(siguiente) > dayCancun(referencia);
        return {
          vuelo_id: vuelo!.id as string,
          orden: i + 1,
          origen_iata: e.origen_iata.toUpperCase(),
          destino_iata: e.destino_iata.toUpperCase(),
          aeronave_id: dto.aeronave_id ?? null,
          pasajeros: e.es_ferry ? 0 : (e.pasajeros ?? null),
          pasajeros_nombres: e.pasajeros_nombres ?? [],
          es_ferry: e.es_ferry ?? false,
          solo_operativa: e.es_ferry ?? false,
          requiere_pernocta: pernocta,
          notas: e.notas ?? null,
          fecha_salida_plan: fechaEfectiva(i)?.toISOString(),
          created_by: userId,
          updated_by: userId,
        };
      });
      const { error: legsErr } = await this.supabase.service
        .from('escala')
        .insert(legs);
      if (legsErr) {
        this.logger.warn(
          `No se pudieron crear las escalas operativas del vuelo ${vuelo!.id}: ${legsErr.message}`,
        );
      }
    } else if (breakdown.ruta.escalas) {
      await this.replaceEscalas(vuelo!.id, breakdown.ruta.escalas, userId, {
        inicio: dto.fecha_vuelo?.toISOString() ?? null,
        fin: dto.fecha_traslado_final?.toISOString() ?? null,
      });
    }

    await this.appendVersionHistory(vuelo!.id, 1, dto, breakdown, 'Versión inicial', userId);

    void this.calendar.syncFlight(vuelo!.id);
    const escalas = await this.findEscalas(vuelo!.id);
    return { ...vuelo!, escalas };
  }

  async revise(vueloId: string, dto: ReviseQuoteDto, userId: string) {
    const current = await this.findById(vueloId);
    if (current.estado === 'CANCELADO') {
      throw new ConflictException('No se puede revisar una cotización cancelada.');
    }
    // Ajustes de última hora (extras, pax/TUAs, cierre de abiertas): la
    // cotización se puede revisar en cualquier estado mientras NO se haya
    // cobrado ni facturado. Cada revisión queda versionada en el historial.
    const estadoAvanzado =
      current.estado === 'CONFIRMADO' ||
      current.estado === 'EN_VUELO' ||
      current.estado === 'COMPLETADO';
    if (estadoAvanzado && (current.cobrado || current.facturado)) {
      throw new ConflictException(
        'El vuelo ya fue cobrado/facturado; la cotización ya no puede ajustarse.',
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
        ...(dto.fecha_vuelo !== undefined
          ? { fecha_vuelo: dto.fecha_vuelo.toISOString() }
          : {}),
        ...(dto.fecha_traslado_final !== undefined
          ? { fecha_traslado_final: dto.fecha_traslado_final.toISOString() }
          : {}),
        ...(dto.pasajeros_nombres !== undefined
          ? { pasajeros_nombres: dto.pasajeros_nombres }
          : {}),
        pase_abordar: dto.pase_abordar ?? false,
        tiempo_cobrable_hr: breakdown.tiempos.cobrable_hr,
        tarifa_tipo: dto.tipo_tarifa,
        tarifa_hora_usd: breakdown.tarifa.usd_por_hora,
        subtotal_vuelo_usd: breakdown.totales.subtotal_vuelo_usd,
        tuas_usd: breakdown.totales.tuas_total_usd,
        iva_pct: breakdown.iva.porcentaje,
        iva_usd: breakdown.iva.monto_usd,
        monto_total_usd: breakdown.totales.total_usd,
        tc_usd_mxn: dto.tc_usd_mxn ?? null,
        monto_total_mxn: dto.tc_usd_mxn
          ? Math.round(breakdown.totales.total_usd * dto.tc_usd_mxn * 100) / 100
          : null,
        viaticos_pernocta_usd: breakdown.totales.viaticos_pernocta_usd,
        extras_total_usd: breakdown.totales.extras_total_usd,
        ajuste_final_usd: breakdown.totales.ajuste_final_usd,
        comision_vendedor_usd: breakdown.meta.comision_vendedor_usd ?? 0,
        comision_vendedor_nombre: breakdown.meta.comision_vendedor_nombre ?? null,
        metodo_cobro: dto.metodo_pago,
        notas: dto.notas ?? current.notas,
        calculo_snapshot: breakdown,
        // Cotizar una RESERVA o SOLICITUD la convierte en COTIZADO; los estados
        // avanzados (abierta) conservan su estado al ajustar el precio.
        estado:
          current.estado === 'SOLICITUD' || current.estado === 'RESERVA'
            ? 'COTIZADO'
            : current.estado,
        cotizacion_abierta:
          dto.cotizacion_abierta ?? current.cotizacion_abierta ?? false,
        ...(dto.extras !== undefined ? { extras: breakdown.extras ?? [] } : {}),
        updated_by: userId,
      })
      .eq('id', vueloId)
      .select(VUELO_COLS)
      .maybeSingle();

    if (error) throw new Error(error.message);
    const pernoctasAntes = await this.pernoctaDestinos(vueloId);
    await this.replaceEscalas(vueloId, breakdown.ruta.escalas ?? null, userId, {
      inicio:
        dto.fecha_vuelo?.toISOString() ??
        (current.fecha_vuelo as string | null) ??
        null,
      fin:
        dto.fecha_traslado_final?.toISOString() ??
        (current.fecha_traslado_final as string | null) ??
        null,
    });
    const pernoctasDespues = await this.pernoctaDestinos(vueloId);
    void this.notifyPernoctaCambiada(updated!, pernoctasAntes, pernoctasDespues);
    await this.appendVersionHistory(vueloId, newVersion, dto, breakdown, dto.motivo, userId);
    // El precio cambió: la bandera `cobrado` se recalcula con la fuente
    // canónica (un anticipo previo puede ahora cubrir —o dejar de cubrir— el
    // total). Antes quedaba obsoleta hasta el siguiente cobro.
    await this.refreshCobradoTrasRecotizar(vueloId, updated!, userId);
    // Refleja fechas/tramos nuevos en el calendario (admin lee en vivo; esto
    // mueve también los eventos de Google si el vuelo ya estaba sincronizado).
    void this.calendar.syncFlight(vueloId);
    const escalas = await this.findEscalas(vueloId);
    return { ...updated!, escalas };
  }

  /**
   * Ajuste rápido desde el detalle de la cotización: extras y/o pasajeros, sin
   * rearmar el cotizador. Reconstruye el DTO de revisión desde lo persistido
   * (tramos, tarifa, método, IVA quedan idénticos) y delega en revise() — así
   * el recálculo y el versionado son los mismos de siempre.
   */
  async quickAdjust(
    vueloId: string,
    dto: QuickAdjustQuoteDto,
    userId: string,
  ) {
    const current = await this.findById(vueloId);
    if (current.estado === 'RESERVA') {
      throw new ConflictException(
        'La reserva aún no tiene precios: cotízala primero (botón Cotizar).',
      );
    }
    if (!current.aeronave_id) {
      throw new BadRequestException(
        'El vuelo no tiene aeronave asignada; usa "Revisar" para cotizar completo.',
      );
    }
    const escalas = (current.escalas ?? []) as Array<Record<string, unknown>>;
    if (escalas.length === 0) {
      throw new BadRequestException(
        'La cotización no tiene tramos registrados; usa "Revisar".',
      );
    }

    const oldPax = Number(current.pasajeros);
    const newPax = dto.pasajeros ?? oldPax;
    const reviseDto = {
      aeronave_id: current.aeronave_id as string,
      tipo: TipoVuelo.MULTIESCALA,
      // Tramos tal como están persistidos. Si cambia el pax global, los tramos
      // que usaban el global anterior lo heredan (los personalizados se quedan).
      escalas: escalas.map((e) => ({
        origen_iata: e.origen_iata as string,
        destino_iata: e.destino_iata as string,
        millas_nauticas: Number(e.millas_nauticas) || 0,
        pasajeros:
          e.es_ferry === true
            ? 0
            : dto.pasajeros !== undefined && Number(e.pasajeros) === oldPax
              ? undefined
              : ((e.pasajeros as number | null) ?? undefined),
        // Preserva el manifiesto por tramo en el ajuste rápido.
        pasajeros_nombres:
          e.es_ferry === true
            ? []
            : ((e.pasajeros_nombres as string[] | null) ?? undefined),
        es_ferry: e.es_ferry === true,
        requiere_pernocta: e.requiere_pernocta === true,
        pernocta_costo_usd:
          e.pernocta_costo_usd != null ? Number(e.pernocta_costo_usd) : undefined,
        tipo_parada: (e.tipo_parada as 'NORMAL' | 'SERVICIO') ?? 'NORMAL',
        servicio_notas: (e.servicio_notas as string | null) ?? undefined,
        notas: (e.notas as string | null) ?? undefined,
        fecha_salida_plan: e.fecha_salida_plan
          ? new Date(e.fecha_salida_plan as string)
          : undefined,
      })),
      tipo_tarifa: current.tarifa_tipo as TipoTarifa,
      pasajeros: newPax,
      pase_abordar: current.pase_abordar === true,
      metodo_pago: (current.metodo_cobro as MetodoPago) ?? MetodoPago.TRANSFERENCIA,
      // El ajuste rápido no debe borrar el TC pactado, la comisión BillPocket
      // ni la comisión del vendedor.
      tc_usd_mxn:
        Number(current.tc_usd_mxn) > 0 ? Number(current.tc_usd_mxn) : undefined,
      comision_billpocket_pct:
        (
          current.calculo_snapshot as {
            meta?: { comision_billpocket_pct?: number | null };
          } | null
        )?.meta?.comision_billpocket_pct ?? undefined,
      comision_vendedor_usd:
        Number(current.comision_vendedor_usd) > 0
          ? Number(current.comision_vendedor_usd)
          : undefined,
      comision_vendedor_nombre:
        (current.comision_vendedor_nombre as string | null) ?? undefined,
      cotizacion_abierta: current.cotizacion_abierta === true,
      // Se conserva la economía pactada: misma tarifa/hora y mismo % de IVA.
      tarifa_hora_override_usd:
        Number(current.tarifa_hora_usd) > 0
          ? Number(current.tarifa_hora_usd)
          : undefined,
      iva_pct_override: Number(current.iva_pct),
      extras: dto.extras ?? ((current.extras as never[]) ?? []),
      ajuste_final_usd: Number(current.ajuste_final_usd) || 0,
      motivo: dto.motivo?.trim() || 'Ajuste rápido desde el detalle (extras/pasajeros)',
    } as unknown as ReviseQuoteDto;

    return this.revise(vueloId, reviseDto, userId);
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

  /**
   * Rutas que el cliente suele pedir, según su historial real de vuelos:
   * agrupa los itinerarios por firma (cadena de tramos), cuenta veces y
   * recencia, y devuelve el detalle de tramos del vuelo más reciente de cada
   * grupo (listo para hidratar el cotizador de un tap).
   */
  async rutasSugeridas(clienteId: string): Promise<RutaSugerida[]> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, ruta_id, fecha_vuelo, estado, escalas:escala(orden, origen_iata, destino_iata, millas_nauticas, pasajeros, es_ferry, requiere_pernocta, pernocta_costo_usd, tipo_parada, servicio_notas)',
      )
      .eq('cliente_id', clienteId)
      .neq('estado', 'CANCELADO')
      .eq('es_externo', false)
      .order('fecha_vuelo', { ascending: false, nullsFirst: false })
      .limit(60);
    if (error) throw new Error(error.message);

    interface LegRow {
      orden: number;
      origen_iata: string;
      destino_iata: string;
      millas_nauticas: number | string | null;
      pasajeros: number | null;
      es_ferry: boolean | null;
      requiere_pernocta: boolean | null;
      pernocta_costo_usd: number | string | null;
      tipo_parada: string | null;
      servicio_notas: string | null;
    }

    const grupos = new Map<string, RutaSugerida>();
    for (const v of data ?? []) {
      const legs = (((v.escalas as LegRow[] | null) ?? []) as LegRow[])
        .slice()
        .sort((a, b) => a.orden - b.orden);
      if (legs.length === 0) continue;
      const clave = legs.map((l) => `${l.origen_iata}-${l.destino_iata}`).join('|');
      const existente = grupos.get(clave);
      if (existente) {
        existente.veces += 1;
        // El query viene ordenado por recencia: el primero ya trae el
        // itinerario y la fecha más recientes del grupo.
        existente.ruta_id ??= v.ruta_id as string | null;
        continue;
      }
      const etiqueta = [legs[0].origen_iata, ...legs.map((l) => l.destino_iata)].join(' → ');
      grupos.set(clave, {
        clave,
        etiqueta,
        veces: 1,
        ultima_fecha: (v.fecha_vuelo as string | null) ?? null,
        ruta_id: (v.ruta_id as string | null) ?? null,
        tramos: legs.map((l) => ({
          origen_iata: l.origen_iata,
          destino_iata: l.destino_iata,
          millas_nauticas: Number(l.millas_nauticas) || 0,
          // null = hereda los pax de la cotización NUEVA (copiar los pax del
          // vuelo histórico alteraba TUAS y descuadraba el total sugerido).
          pasajeros: l.es_ferry ? 0 : null,
          es_ferry: l.es_ferry === true,
          requiere_pernocta: l.requiere_pernocta === true,
          pernocta_costo_usd:
            l.pernocta_costo_usd != null ? Number(l.pernocta_costo_usd) : null,
          tipo_parada: l.tipo_parada === 'SERVICIO' ? 'SERVICIO' : 'NORMAL',
          servicio_notas: l.servicio_notas ?? null,
        })),
      });
    }

    return [...grupos.values()]
      .sort(
        (a, b) =>
          b.veces - a.veces ||
          (b.ultima_fecha ?? '').localeCompare(a.ultima_fecha ?? ''),
      )
      .slice(0, 5);
  }

  // ============ Internals ============

  /** Destinos del itinerario donde hay pernocta, en orden. */
  /**
   * Misma regla canónica que FlightsService.refreshCobradoFlag (cobrosEnUsd);
   * se replica aquí solo para no crear una dependencia circular de módulos.
   */
  private async refreshCobradoTrasRecotizar(
    vueloId: string,
    vuelo: Record<string, unknown>,
    userId: string,
  ): Promise<void> {
    const { data: cobros } = await this.supabase.service
      .from('cobro_vuelo')
      .select('monto, moneda, tc_usd_mxn')
      .eq('vuelo_id', vueloId);
    const { total_usd } = cobrosEnUsd(
      (cobros ?? []) as Array<Record<string, unknown>>,
      vuelo.tc_usd_mxn as number | null,
    );
    const deberia = total_usd >= Number(vuelo.monto_total_usd) - 1;
    if (deberia !== vuelo.cobrado) {
      await this.supabase.service
        .from('vuelo')
        .update({ cobrado: deberia, updated_by: userId })
        .eq('id', vueloId);
    }
  }

  private async pernoctaDestinos(vueloId: string): Promise<string[]> {
    const { data } = await this.supabase.service
      .from('escala')
      .select('orden, destino_iata')
      .eq('vuelo_id', vueloId)
      .eq('requiere_pernocta', true)
      .order('orden', { ascending: true });
    return (data ?? []).map((e) => e.destino_iata as string);
  }

  /**
   * Si la pernocta del itinerario cambió tras una revisión, avisa a los pilotos
   * asignados (al vuelo o a cualquier tramo) por socket/push — para que nadie
   * asuma que pernocta donde no es (o que NO pernocta donde sí).
   */
  private async notifyPernoctaCambiada(
    vuelo: Record<string, unknown>,
    antes: string[],
    despues: string[],
  ): Promise<void> {
    if (JSON.stringify(antes) === JSON.stringify(despues)) return;
    const { data: legs } = await this.supabase.service
      .from('escala')
      .select('piloto_id')
      .eq('vuelo_id', vuelo.id as string)
      .not('piloto_id', 'is', null);
    const pilotos = new Set<string>(
      [
        ...(legs ?? []).map((l) => l.piloto_id as string),
        vuelo.piloto_id as string | null,
      ].filter((p): p is string => !!p),
    );
    if (pilotos.size === 0) return;
    const cuerpo =
      despues.length > 0
        ? `🌙 Ahora pernoctas en ${despues.join(', ')} · ${vuelo.origen_iata as string} → ${vuelo.destino_iata as string} · folio #${vuelo.folio as number}`
        : `Este vuelo ya NO incluye pernocta · ${vuelo.origen_iata as string} → ${vuelo.destino_iata as string} · folio #${vuelo.folio as number}`;
    for (const pilotoId of pilotos) {
      void this.notifications.notifyUser(pilotoId, {
        tipo: 'pernocta_actualizada',
        titulo: 'Pernocta actualizada',
        cuerpo,
        data: { vuelo_id: vuelo.id, folio: vuelo.folio, pernoctas: despues },
        link: `/flights/${vuelo.id as string}`,
      });
    }
  }

  private async findEscalas(vueloId: string) {
    const { data, error } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, origen_iata, destino_iata, millas_nauticas, pasajeros, pasajeros_nombres, es_ferry, requiere_pernocta, pernocta_costo_usd, tipo_parada, servicio_notas, fecha_salida_plan, taco_salida, taco_llegada, hora_salida, hora_llegada, notas',
      )
      .eq('vuelo_id', vueloId)
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Sincroniza el plan de escalas con el itinerario cotizado, SIN destruir las
   * capturas: hace upsert por `orden` (UPDATE de los campos de plan preservando
   * tacómetros/fotos/horas reales y la asignación por tramo; INSERT de tramos
   * nuevos) y borra los sobrantes solo si no tienen tacómetro capturado. Esto
   * permite re-cotizar vuelos abiertos ya volados sin perder datos.
   */
  private async replaceEscalas(
    vueloId: string,
    escalas: ResolvedLeg[] | null,
    userId: string,
    fechas?: { inicio?: string | null; fin?: string | null },
  ): Promise<void> {
    // Vuelo con itinerario OPERATIVO capturado (Nueva cotización · paso 1):
    // TODAS sus escalas son la ruta real del piloto; la ruta comercial de la
    // cotización solo sirve para el precio y NO gestiona escalas.
    const { data: vueloFlag } = await this.supabase.service
      .from('vuelo')
      .select('itinerario_operativo')
      .eq('id', vueloId)
      .maybeSingle();
    if (vueloFlag?.itinerario_operativo === true) return;

    // Solo gestionamos los tramos COMERCIALES (cotizados). Los operativos
    // internos (solo_operativa=true) los administra operaciones aparte y NUNCA
    // se tocan aquí: ni se reordenan ni se borran al re-cotizar.
    const { data: existing, error: exErr } = await this.supabase.service
      .from('escala')
      .select('id, orden, taco_salida, taco_llegada, fecha_salida_plan')
      .eq('vuelo_id', vueloId)
      .eq('solo_operativa', false);
    if (exErr) throw new Error(`Failed to read escalas: ${exErr.message}`);
    const porOrden = new Map(
      (existing ?? []).map((e) => [e.orden as number, e]),
    );
    const tieneTaco = (e: { taco_salida: unknown; taco_llegada: unknown }) =>
      e.taco_salida != null || e.taco_llegada != null;

    const total = escalas?.length ?? 0;
    for (let idx = 0; idx < total; idx++) {
      const e = escalas![idx];
      const orden = idx + 1;
      const fechaPlan =
        e.fecha_salida_plan ??
        (idx === 0
          ? (fechas?.inicio ?? null)
          : idx === total - 1
            ? (fechas?.fin ?? null)
            : null);
      const planFields: Record<string, unknown> = {
        origen_iata: e.origen_iata.toUpperCase(),
        destino_iata: e.destino_iata.toUpperCase(),
        millas_nauticas: e.millas_nauticas,
        pasajeros: e.es_ferry ? 0 : e.pasajeros,
        pasajeros_nombres: e.es_ferry ? [] : e.pasajeros_nombres,
        es_ferry: e.es_ferry,
        requiere_pernocta: e.requiere_pernocta,
        pernocta_costo_usd: e.requiere_pernocta ? e.pernocta_costo_usd : null,
        tipo_parada: e.tipo_parada,
        servicio_notas: e.servicio_notas,
        notas: e.notas,
        updated_by: userId,
      };
      const actual = porOrden.get(orden);
      if (actual) {
        // No pisar con null una fecha ya planeada/asignada al tramo.
        if (fechaPlan != null || actual.fecha_salida_plan == null) {
          planFields.fecha_salida_plan = fechaPlan;
        }
        const { error } = await this.supabase.service
          .from('escala')
          .update(planFields)
          .eq('id', actual.id as string);
        if (error) throw new Error(`Failed to update escala ${orden}: ${error.message}`);
      } else {
        const { error } = await this.supabase.service.from('escala').insert({
          vuelo_id: vueloId,
          orden,
          ...planFields,
          fecha_salida_plan: fechaPlan,
          created_by: userId,
        });
        if (error) throw new Error(`Failed to insert escala ${orden}: ${error.message}`);
      }
    }

    // Sobrantes (orden > nuevo total): se eliminan solo si no tienen captura.
    const sobrantes = (existing ?? []).filter((e) => (e.orden as number) > total);
    for (const s of sobrantes) {
      if (tieneTaco(s)) {
        this.logger.warn(
          `Vuelo ${vueloId}: escala orden ${s.orden} tiene tacómetro capturado; se conserva aunque el plan cotizado ya no la incluye.`,
        );
        continue;
      }
      const { error } = await this.supabase.service
        .from('escala')
        .delete()
        .eq('id', s.id as string);
      if (error) throw new Error(`Failed to delete escala sobrante: ${error.message}`);
    }
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
        tc_usd_mxn: dto.tc_usd_mxn ?? null,
        monto_total_mxn: dto.tc_usd_mxn
          ? Math.round(breakdown.totales.total_usd * dto.tc_usd_mxn * 100) / 100
          : null,
        viaticos_pernocta_usd: breakdown.totales.viaticos_pernocta_usd,
        extras_total_usd: breakdown.totales.extras_total_usd,
        ajuste_final_usd: breakdown.totales.ajuste_final_usd,
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
        // Manifiesto por tramo: ferry sin pasajeros => vacío; nombres limpios.
        pasajeros_nombres: esFerry
          ? []
          : (l.pasajeros_nombres ?? [])
              .map((n) => n.trim())
              .filter((n) => n.length > 0),
        es_ferry: esFerry,
        requiere_pernocta: requierePernocta,
        pernocta_costo_usd: pernoctaCosto,
        tipo_parada: l.tipo_parada === 'SERVICIO' ? 'SERVICIO' : 'NORMAL',
        servicio_notas: l.servicio_notas ?? null,
        notas: l.notas ?? null,
        fecha_salida_plan:
          l.fecha_salida_plan instanceof Date
            ? l.fecha_salida_plan.toISOString()
            : (l.fecha_salida_plan ?? null),
      };
    });
  }

  private async resolveRoute(dto: CalculateQuoteDto): Promise<ResolvedRoute> {
    // Escalas explícitas = el itinerario PROPIO de la cotización (la plantilla
    // hidratada y posiblemente ajustada por el operador). Tienen prioridad;
    // ruta_id se conserva solo como referencia de la plantilla usada.
    if (
      dto.tipo === TipoVuelo.MULTIESCALA &&
      dto.escalas &&
      dto.escalas.length >= 1
    ) {
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
        ruta_id: dto.ruta_id ?? null,
        origen_iata: escalasNorm[0].origen_iata,
        destino_iata: escalasNorm[escalasNorm.length - 1].destino_iata,
        millas_nauticas: nmTotal,
        es_redondo_auto: false,
        num_aterrizajes: escalasNorm.length,
        escalas: escalasNorm,
      };
    }

    // Ruta del catalogo sin escalas explícitas: hidrata los tramos guardados.
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
      // Ruta legacy SIMPLE (redondo automático ×2): ya no se cotiza. El precio
      // dependía de duplicar millas implícitamente — edítala en Rutas para
      // convertirla a tramos explícitos.
      throw new BadRequestException(
        `La ruta ${r.origen_iata}→${r.destino_iata} es legacy (redondo automático). Edítala en Rutas para convertirla a tramos antes de cotizar.`,
      );
    }

    if (dto.tipo === TipoVuelo.MULTIESCALA) {
      throw new BadRequestException(
        'El itinerario requiere al menos 1 tramo (agrega el regreso si aplica).',
      );
    }
    // Modo ad-hoc legacy (origen/destino/millas sueltos con ×2 implícito):
    // eliminado junto con el "redondo automático". Toda cotización se arma por
    // tramos explícitos o con una ruta guardada.
    throw new BadRequestException(
      'Cotiza con una ruta guardada (ruta_id) o con el itinerario por tramos (escalas[]).',
    );
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
