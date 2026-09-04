import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  avionOcupadoEnFecha,
  avisoAvionOcupado,
} from '../../common/avion-ocupado.util';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import {
  movimientoDeSobre,
  MOV_LIGA_COLS,
  type MovimientoLiga,
} from '../../common/cobro-conciliado.util';
import { diaCancun } from '../../common/fecha-cancun.util';
import { CalendarSyncService } from '../calendar/calendar-sync.service';
import { resolverComisionBancaria } from '../flights/comision-bancaria.util';
import type {
  CreateCobroDto,
  CreateReembolsoDto,
} from '../flights/dto/cobros.dto';
import {
  FlightsService,
  type CobroParteDeSobreOpts,
} from '../flights/flights.service';
import type {
  CalculateQuoteDto,
  EscalaInputDto,
  MetodoPago,
  TipoTarifa,
} from '../quotes/dto/calculate-quote.dto';
import { TipoVuelo } from '../quotes/dto/calculate-quote.dto';
import type { CreateQuoteDto } from '../quotes/dto/create-quote.dto';
import type { ReviseQuoteDto } from '../quotes/dto/revise-quote.dto';
import { QuotesService, type GrupoHijoOpts } from '../quotes/quotes.service';
import { SupabaseService } from '../supabase/supabase.service';
import type { ArmarGrupoDto, AvionGrupoDto } from './dto/armar-grupo.dto';
import type { CreateCobroGrupoDto } from './dto/cobro-grupo.dto';
import type { CreateGrupoDto } from './dto/create-grupo.dto';
import type {
  QuitarAvionDto,
  ReemplazarAvionDto,
} from './dto/grupo-acciones.dto';
import type { ListGruposQuery } from './dto/list-grupos.query';
import type { ReviseGrupoDto } from './dto/revise-grupo.dto';
import {
  consolidarDesgloses,
  diagnosticoGrupo,
  duplicadosDePiloto,
  escalonarSalidas,
  estadoGrupoDe,
  materializarExtras,
  normalizarExtrasGrupo,
  proponerFlota,
  repartirAjuste,
  round2,
  tramosDeHijo,
  type Consolidado,
  type EstadoGrupo,
  type ExtraGrupoDef,
  type ExtraLineaHijo,
  type FichaAvionArmador,
  type HijoConsolidable,
  type PlantillaTramo,
  type ProblemaGrupo,
  type TramoHijo,
} from './grupo-armador.util';
import {
  cuadreSobre,
  diagnosticoSobres,
  ParticionCobroError,
  particionCobroGrupo,
  semaforoCobroGrupo,
  type HijoParticionCobro,
  type ParticionCobroResult,
  type SemaforoCobro,
} from './particion-cobro.util';

// ===== Tipos de filas =====

const CABECERA_COLS =
  'id, folio, cliente_id, nombre, fecha_vuelo, fecha_fin, pasajeros_total, escalas_plantilla, tarifa_tipo, metodo_cobro, pase_abordar, tc_usd_mxn, extras_grupo, ajuste_grupo_usd, vuelo_ancla_id, version, notas, notas_internas, pdf_mostrar_anexo_aviones, pdf_mostrar_subtotal_por_avion, pdf_mostrar_precio_por_persona, pdf_mostrar_tarifa, cancelado_at, cancelado_motivo, created_at, updated_at, created_by, updated_by, cliente:cliente!cliente_id(id, nombre, razon_social_default, es_interno)';

const HIJO_COLS =
  'id, folio, estado, aeronave_id, piloto_id, copiloto_id, grupo_id, grupo_posicion, grupo_pax, pasajeros, monto_total_usd, monto_total_mxn, tc_usd_mxn, cobrado, facturado, cotizacion_version, cotizacion_abierta, fecha_vuelo, fecha_fin, estado_permiso, extras, calculo_snapshot, tarifa_hora_usd, tiempo_cobrable_hr, ajuste_final_usd, metodo_cobro, metodo_cobro_detalle, notas_internas, es_externo, origen_iata, destino_iata, itinerario_operativo, escalas:escala(id, orden, origen_iata, destino_iata, aeronave_id, piloto_id, pasajeros, es_ferry, solo_operativa, cancelada_at, taco_llegada, fecha_salida_plan)';

interface ClienteRow {
  id: string;
  nombre: string;
  razon_social_default: string | null;
  es_interno: boolean | null;
}

export interface CabeceraRow {
  id: string;
  folio: number;
  cliente_id: string;
  nombre: string;
  fecha_vuelo: string;
  fecha_fin: string | null;
  pasajeros_total: number;
  escalas_plantilla: unknown;
  tarifa_tipo: string;
  metodo_cobro: string | null;
  pase_abordar: boolean;
  tc_usd_mxn: number | string | null;
  extras_grupo: unknown;
  ajuste_grupo_usd: number | string | null;
  vuelo_ancla_id: string | null;
  version: number;
  notas: string | null;
  notas_internas: string | null;
  pdf_mostrar_anexo_aviones: boolean;
  pdf_mostrar_subtotal_por_avion: boolean;
  pdf_mostrar_precio_por_persona: boolean;
  pdf_mostrar_tarifa: boolean;
  cancelado_at: string | null;
  cancelado_motivo: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  cliente: ClienteRow | ClienteRow[] | null;
}

interface EscalaHijoRow {
  id: string;
  orden: number;
  origen_iata: string;
  destino_iata: string;
  aeronave_id: string | null;
  piloto_id: string | null;
  pasajeros: number | null;
  es_ferry: boolean | null;
  solo_operativa: boolean | null;
  cancelada_at: string | null;
  taco_llegada: number | string | null;
  fecha_salida_plan: string | null;
}

export interface HijoRow {
  id: string;
  folio: number;
  estado: string;
  aeronave_id: string | null;
  piloto_id: string | null;
  copiloto_id: string | null;
  grupo_id: string;
  grupo_posicion: number | null;
  grupo_pax: number | null;
  pasajeros: number;
  monto_total_usd: number | string | null;
  monto_total_mxn: number | string | null;
  tc_usd_mxn: number | string | null;
  cobrado: boolean;
  facturado: boolean;
  cotizacion_version: number;
  cotizacion_abierta: boolean | null;
  fecha_vuelo: string | null;
  fecha_fin: string | null;
  estado_permiso: string | null;
  extras: unknown;
  calculo_snapshot: unknown;
  tarifa_hora_usd: number | string | null;
  tiempo_cobrable_hr: number | string | null;
  ajuste_final_usd: number | string | null;
  metodo_cobro: string | null;
  metodo_cobro_detalle: string | null;
  notas_internas: string | null;
  es_externo: boolean;
  origen_iata: string;
  destino_iata: string;
  itinerario_operativo: boolean | null;
  escalas: EscalaHijoRow[] | null;
}

interface FichaRow extends FichaAvionArmador {
  velocidad_crucero_kts: number | null;
  pais_registro: string | null;
}

// ===== SOBRE de cobro (Fase 2, 4-sep-2026) =====

const SOBRE_COLS =
  'id, grupo_id, monto, moneda, metodo_cobro, tc_usd_mxn, comision_banco_pct, comision_banco_monto, cuenta_destino, referencia, foto_voucher_url, fecha_cobro, modo_particion, registrado_por, notas, client_request_id, created_at, updated_at';

const PARTE_COLS =
  'id, vuelo_id, cobro_grupo_id, monto, moneda, tc_usd_mxn, comision_banco_monto, grupo_factor, fecha_cobro, created_at';

interface SobreRow {
  id: string;
  grupo_id: string;
  monto: number | string;
  moneda: string;
  metodo_cobro: string;
  tc_usd_mxn: number | string | null;
  comision_banco_pct: number | string | null;
  comision_banco_monto: number | string | null;
  cuenta_destino: string | null;
  referencia: string | null;
  foto_voucher_url: string | null;
  fecha_cobro: string;
  modo_particion: string;
  registrado_por: string | null;
  notas: string | null;
  client_request_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ParteRow {
  id: string;
  vuelo_id: string;
  cobro_grupo_id: string;
  monto: number | string;
  moneda: string;
  tc_usd_mxn: number | string | null;
  comision_banco_monto: number | string | null;
  grupo_factor: number | string | null;
  fecha_cobro: string;
  created_at: string;
}

export interface ParteSobreSalida {
  cobro_vuelo_id: string;
  vuelo_id: string;
  folio: number | null;
  posicion: number | null;
  matricula: string | null;
  monto: number;
  factor: number | null;
  comision_banco_monto: number | null;
  /** La parte quedó en un hijo CANCELADO (quitado del grupo): re-partir. */
  cancelado: boolean;
}

/** Sobre con sus partes — shape de GET /grupos/:id/cobros y de findOne.cobros. */
export interface SobreSalida {
  id: string;
  grupo_id: string;
  monto: number;
  moneda: string;
  metodo_cobro: string;
  tc_usd_mxn: number | null;
  comision_banco_pct: number | null;
  comision_banco_monto: number | null;
  /** monto − comisión (por diferencia; nunca se guarda). */
  neto: number;
  cuenta_destino: string | null;
  referencia: string | null;
  foto_voucher_url: string | null;
  fecha_cobro: string;
  modo_particion: string;
  registrado_por: string | null;
  notas: string | null;
  client_request_id: string | null;
  created_at: string;
  updated_at: string;
  es_reembolso: boolean;
  partes: ParteSobreSalida[];
  partes_suma: number;
  /** Σ partes == monto (invariante del sobre). */
  cuadra: boolean;
  partes_en_cancelados: number;
  /** Existe movimiento_bancario.cobro_grupo_id = sobre (el banco enlaza al sobre). */
  conciliado: boolean;
  movimiento_bancario_id: string | null;
  recibo_disponible: boolean;
}

/** Entrada mínima para partir un sobre (DTO nuevo o sobre existente al re-partir). */
interface EntradaSobre {
  monto: number;
  moneda: string;
  tc_usd_mxn?: number | null;
  comision_banco_pct?: number | null;
  comision_banco_monto?: number | null;
  modo?: 'AUTO' | 'MANUAL' | null;
  particion_manual?: Array<{ vuelo_id: string; monto: number }> | null;
}

interface PreparacionSobre {
  particion: ParticionCobroResult;
  comision: { pct: number | null; monto: number | null };
  avisos: string[];
}

function fmtMonto(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface SnapshotMin {
  aeronave?: { id?: string | null } | null;
  tarifa?: { usd_por_hora?: number; proviene_de_override?: boolean } | null;
  tiempos?: {
    cobrable_hr?: number;
    cobrable_proviene_de_override?: boolean;
  } | null;
  iva?: { base_usd?: number } | null;
  totales?: { total_usd?: number; total_mxn?: number | null } | null;
  meta?: { grupo?: { precio_desactualizado?: boolean } | null } | null;
}

type Breakdown = Awaited<ReturnType<QuotesService['calculate']>>;

/** Un avión ya resuelto para armar/crear/revisar. */
interface AvionCtx {
  key: string;
  posicion: number;
  vuelo_id: string | null;
  aeronave_id: string;
  pax: number;
  rotaciones: 1 | 2;
  piloto_id: string | null;
  copiloto_id: string | null;
  tarifa_hora_override_usd?: number;
  tiempo_cobrable_override_hr?: number;
  fecha_salida_plan: Date | null;
  aceptar_discrepancia_alta: boolean;
}

interface ArmadoCtx {
  cliente: ClienteRow;
  fecha_vuelo: Date;
  pasajeros_total: number;
  plantilla: PlantillaTramo[];
  tarifa_tipo: TipoTarifa;
  metodo_pago: MetodoPago;
  metodo_pago_detalle?: string;
  tc_usd_mxn?: number;
  pase_abordar: boolean;
  extras: ExtraGrupoDef[];
  ajuste_grupo_usd: number;
  aviones: AvionCtx[];
  anclaKey: string | null;
}

interface HijoCalculado {
  avion: AvionCtx;
  ficha: FichaRow;
  tramos: TramoHijo[];
  pax_por_rotacion: number[];
  extras: ExtraLineaHijo[];
  ajuste_final_usd: number;
  salida: Date;
  base: CalculateQuoteDto;
  calculo: Breakdown;
}

interface AvisoAvion {
  avisos: string[];
  requiere_aceptar_discrepancia_alta: boolean;
  discrepancias_alta: { id: string; descripcion: string }[];
  piloto_sugerido: { id: string; nombre: string } | null;
}

interface Armado {
  ctx: ArmadoCtx;
  fichas: Map<string, FichaRow>;
  hijos: Map<string, HijoCalculado>;
  anclaKey: string;
  avisosPorAvion: Map<string, AvisoAvion>;
  avisosGrupo: string[];
  capacidad: {
    asientos_total: number;
    pax_asignados: number;
    faltan: number;
    opciones: Array<Record<string, unknown>>;
  };
  pilotos: {
    activos: number;
    libres: number;
    sin_asignar: number;
    faltan: number;
  };
  consolidado: Consolidado;
}

interface OpcionesArmado {
  /** Reglas duras + 409 de squawk sin aceptar (crear/revisar). */
  paraEscribir?: boolean;
  /** Ids de vuelos del propio grupo (no cuentan como doble reserva/conflicto). */
  vuelosPropios?: Set<string>;
  foliosPropios?: Set<number>;
  /** Claves cuyo avión NO cambió: no se re-validan taller/squawk. */
  avionSinCambio?: Set<string>;
  anclaKey?: string | null;
  /** Solo re-materializar (sin opciones de capacidad con corridas extra). */
  soloMotor?: boolean;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function unwrap<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function estadoAvanzado(estado: string): boolean {
  return (
    estado === 'CONFIRMADO' || estado === 'EN_VUELO' || estado === 'COMPLETADO'
  );
}

@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly quotes: QuotesService,
    private readonly flights: FlightsService,
    private readonly calendar: CalendarSyncService,
  ) {}

  // =====================================================================
  // Lectura
  // =====================================================================

  async cargarCabecera(id: string): Promise<CabeceraRow> {
    const { data, error } = await this.supabase.service
      .from('vuelo_grupo')
      .select(CABECERA_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Grupo ${id} no encontrado`);
    return data;
  }

  async cargarHijos(grupoId: string): Promise<HijoRow[]> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(HIJO_COLS)
      .eq('grupo_id', grupoId)
      .order('grupo_posicion', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async cargarFichas(ids: string[]): Promise<Map<string, FichaRow>> {
    const out = new Map<string, FichaRow>();
    const unicos = [...new Set(ids.filter(Boolean))];
    if (unicos.length === 0) return out;
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .select(
        'id, matricula, modelo, asientos, activa, tarifa_hora_pub_usd, tarifa_hora_broker_usd, velocidad_crucero_kts, pais_registro',
      )
      .in('id', unicos);
    if (error) throw new Error(error.message);
    for (const a of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      out.set(a.id as string, this.fichaDe(a));
    }
    return out;
  }

  private fichaDe(a: Record<string, unknown>): FichaRow {
    return {
      id: a.id as string,
      matricula: (a.matricula as string) ?? '',
      modelo: (a.modelo as string | null) ?? null,
      asientos: a.asientos == null ? null : Number(a.asientos),
      activa: a.activa === true,
      tarifa_hora_pub_usd:
        a.tarifa_hora_pub_usd == null ? null : Number(a.tarifa_hora_pub_usd),
      tarifa_hora_broker_usd:
        a.tarifa_hora_broker_usd == null
          ? null
          : Number(a.tarifa_hora_broker_usd),
      velocidad_crucero_kts:
        a.velocidad_crucero_kts == null
          ? null
          : Number(a.velocidad_crucero_kts),
      pais_registro: (a.pais_registro as string | null) ?? null,
    };
  }

  private async cargarFlota(): Promise<FichaRow[]> {
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .select(
        'id, matricula, modelo, asientos, activa, tarifa_hora_pub_usd, tarifa_hora_broker_usd, velocidad_crucero_kts, pais_registro',
      )
      .order('matricula', { ascending: true });
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(
      (a) => this.fichaDe(a),
    );
  }

  /** Aviones en taller y squawks ALTA abiertos, en dos consultas. */
  private async estadoAviones(ids: string[]): Promise<{
    enTaller: Set<string>;
    squawks: Map<string, { id: string; descripcion: string }[]>;
  }> {
    const enTaller = new Set<string>();
    const squawks = new Map<string, { id: string; descripcion: string }[]>();
    if (ids.length === 0) return { enTaller, squawks };
    const [tallerRes, sqRes] = await Promise.all([
      this.supabase.service
        .from('mantenimiento')
        .select('aeronave_id')
        .in('aeronave_id', ids)
        .eq('estado', 'EN_TALLER'),
      this.supabase.service
        .from('aeronave_discrepancia')
        .select('id, aeronave_id, descripcion')
        .in('aeronave_id', ids)
        .neq('estado', 'RESUELTA')
        .eq('severidad', 'ALTA'),
    ]);
    if (tallerRes.error) throw new Error(tallerRes.error.message);
    if (sqRes.error) throw new Error(sqRes.error.message);
    for (const t of tallerRes.data ?? []) enTaller.add(t.aeronave_id as string);
    for (const s of sqRes.data ?? []) {
      const lista = squawks.get(s.aeronave_id as string) ?? [];
      lista.push({ id: s.id as string, descripcion: String(s.descripcion) });
      squawks.set(s.aeronave_id as string, lista);
    }
    return { enTaller, squawks };
  }

  private async nombresUsuarios(ids: Array<string | null | undefined>) {
    const out = new Map<string, string>();
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    if (unicos.length === 0) return out;
    const { data } = await this.supabase.service
      .from('usuario')
      .select('id, nombre')
      .in('id', unicos);
    for (const u of data ?? []) out.set(u.id as string, u.nombre as string);
    return out;
  }

  // =====================================================================
  // Armador
  // =====================================================================

  private plantillaDe(entrada: unknown): PlantillaTramo[] {
    const lista = Array.isArray(entrada) ? entrada : [];
    const out: PlantillaTramo[] = [];
    for (const raw of lista as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== 'object') continue;
      const origen =
        typeof raw.origen_iata === 'string'
          ? raw.origen_iata.trim().toUpperCase()
          : '';
      const destino =
        typeof raw.destino_iata === 'string'
          ? raw.destino_iata.trim().toUpperCase()
          : '';
      if (!origen || !destino) continue;
      out.push({
        origen_iata: origen,
        destino_iata: destino,
        millas_nauticas: num(raw.millas_nauticas),
        es_ferry: raw.es_ferry === true,
        requiere_pernocta: raw.requiere_pernocta === true,
        pernocta_costo_usd:
          raw.pernocta_costo_usd == null ? null : num(raw.pernocta_costo_usd),
        tipo_parada: raw.tipo_parada === 'SERVICIO' ? 'SERVICIO' : 'NORMAL',
        servicio_notas: (raw.servicio_notas as string | null) ?? null,
        notas: (raw.notas as string | null) ?? null,
        pdf_oculto: raw.pdf_oculto == null ? null : raw.pdf_oculto === true,
      });
    }
    if (out.length === 0) {
      throw new BadRequestException(
        'El grupo necesita al menos un tramo en la plantilla (ej. CUN → CZA → CUN).',
      );
    }
    return out;
  }

  private async cargarCliente(clienteId: string): Promise<ClienteRow> {
    const { data, error } = await this.supabase.service
      .from('cliente')
      .select('id, nombre, razon_social_default, es_interno')
      .eq('id', clienteId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new NotFoundException(`Cliente ${clienteId} no encontrado`);
    return data;
  }

  private avionCtxDe(a: AvionGrupoDto, i: number, posicion: number): AvionCtx {
    return {
      key: a.vuelo_id ?? `nuevo-${i + 1}`,
      posicion,
      vuelo_id: a.vuelo_id ?? null,
      aeronave_id: a.aeronave_id,
      pax: Math.max(1, Math.floor(Number(a.pax) || 0)),
      rotaciones: a.rotaciones === 2 ? 2 : 1,
      piloto_id: a.piloto_id ?? null,
      copiloto_id: a.copiloto_id ?? null,
      tarifa_hora_override_usd: a.tarifa_hora_override_usd,
      tiempo_cobrable_override_hr: a.tiempo_cobrable_override_hr,
      fecha_salida_plan: a.fecha_salida_plan ?? null,
      aceptar_discrepancia_alta: a.aceptar_discrepancia_alta === true,
    };
  }

  /** DTO base del motor para un hijo. */
  private dtoBaseHijo(
    ctx: ArmadoCtx,
    avion: AvionCtx,
    tramos: TramoHijo[],
    extras: ExtraLineaHijo[],
    ajuste: number,
  ): CalculateQuoteDto {
    const escalas = tramos.map((t) => {
      const e: Record<string, unknown> = {
        origen_iata: t.origen_iata,
        destino_iata: t.destino_iata,
        millas_nauticas: t.millas_nauticas,
        pasajeros: t.pasajeros,
        es_ferry: t.es_ferry,
        requiere_pernocta: t.requiere_pernocta,
        tipo_parada: t.tipo_parada,
      };
      if (t.pernocta_costo_usd != null)
        e.pernocta_costo_usd = t.pernocta_costo_usd;
      if (t.servicio_notas) e.servicio_notas = t.servicio_notas;
      if (t.notas) e.notas = t.notas;
      if (t.pdf_oculto != null) e.pdf_oculto = t.pdf_oculto;
      if (t.fecha_salida_plan)
        e.fecha_salida_plan = new Date(t.fecha_salida_plan);
      return e as unknown as EscalaInputDto;
    });
    const paxMax = Math.max(
      1,
      ...tramos.filter((t) => !t.es_ferry).map((t) => t.pasajeros),
    );
    const dto: Record<string, unknown> = {
      aeronave_id: avion.aeronave_id,
      cliente_id: ctx.cliente.id,
      tipo: TipoVuelo.MULTIESCALA,
      escalas,
      tipo_tarifa: ctx.tarifa_tipo,
      pasajeros: paxMax,
      pase_abordar: ctx.pase_abordar,
      metodo_pago: ctx.metodo_pago,
      extras: extras.map((l) => ({ ...l })),
      ajuste_final_usd: ajuste,
      // Decisión 4-sep: el redondeo automático a $10 queda APAGADO en los
      // hijos; el número cerrado del grupo se logra con ajuste_grupo_usd.
      redondeo_automatico: false,
    };
    if (ctx.metodo_pago_detalle)
      dto.metodo_pago_detalle = ctx.metodo_pago_detalle;
    if (ctx.tc_usd_mxn) dto.tc_usd_mxn = ctx.tc_usd_mxn;
    if (avion.tarifa_hora_override_usd != null)
      dto.tarifa_hora_override_usd = avion.tarifa_hora_override_usd;
    if (avion.tiempo_cobrable_override_hr != null)
      dto.tiempo_cobrable_override_hr = avion.tiempo_cobrable_override_hr;
    return dto as unknown as CalculateQuoteDto;
  }

  /**
   * Corre el motor por hijo. Ronda 1 sin extras ANCLA ni ajuste (decide el
   * ancla = hijo de mayor total, salvo `ctx.anclaKey`); ronda 2 solo si hay
   * extras ANCLA o ajuste del grupo: reparte el ajuste por base gravable
   * (pesos exactos, residuo al ancla) y recalcula.
   */
  private async calcularHijos(
    ctx: ArmadoCtx,
    fichas: Map<string, FichaRow>,
  ): Promise<{ hijos: Map<string, HijoCalculado>; anclaKey: string }> {
    const salidas = escalonarSalidas(
      ctx.fecha_vuelo,
      ctx.aviones.map((a) => ({
        key: a.key,
        rotaciones: a.rotaciones,
        fecha_salida_plan: a.fecha_salida_plan,
      })),
    );
    const tramosPorKey = new Map<
      string,
      { tramos: TramoHijo[]; w: number[] }
    >();
    for (const a of ctx.aviones) {
      const ficha = fichas.get(a.aeronave_id);
      if (!ficha) {
        throw new BadRequestException(
          `Aeronave ${a.aeronave_id} no existe (avión ${a.posicion}).`,
        );
      }
      let r: ReturnType<typeof tramosDeHijo>;
      try {
        r = tramosDeHijo(ctx.plantilla, a.pax, a.rotaciones, ficha.asientos);
      } catch (err) {
        throw new BadRequestException(
          `Avión ${a.posicion} (${ficha.matricula}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const salida = salidas.get(a.key) ?? ctx.fecha_vuelo;
      r.tramos[0].fecha_salida_plan = salida.toISOString();
      tramosPorKey.set(a.key, { tramos: r.tramos, w: r.pax_por_rotacion });
    }
    const hijosPax = ctx.aviones.map((a) => ({ key: a.key, pax: a.pax }));
    const hayAncla = ctx.extras.some((e) => e.reparto === 'ANCLA');
    const ajusteGrupo = round2(ctx.ajuste_grupo_usd);

    const correr = async (
      extrasPorKey: Map<string, ExtraLineaHijo[]>,
      ajustes: Map<string, number>,
    ): Promise<Map<string, HijoCalculado>> => {
      const out = new Map<string, HijoCalculado>();
      for (const a of ctx.aviones) {
        const t = tramosPorKey.get(a.key)!;
        const extras = extrasPorKey.get(a.key) ?? [];
        const ajuste = ajustes.get(a.key) ?? 0;
        const base = this.dtoBaseHijo(ctx, a, t.tramos, extras, ajuste);
        const calculo = await this.quotes.calculate(base);
        out.set(a.key, {
          avion: a,
          ficha: fichas.get(a.aeronave_id)!,
          tramos: t.tramos,
          pax_por_rotacion: t.w,
          extras,
          ajuste_final_usd: ajuste,
          salida: salidas.get(a.key) ?? ctx.fecha_vuelo,
          base,
          calculo,
        });
      }
      return out;
    };

    // Ronda 1.
    const extras1 = materializarExtras(
      ctx.extras.filter((e) => e.reparto !== 'ANCLA'),
      hijosPax,
      null,
      ctx.pasajeros_total,
    );
    const ronda1 = await correr(extras1, new Map());
    let anclaKey =
      ctx.anclaKey && ronda1.has(ctx.anclaKey) ? ctx.anclaKey : null;
    if (!anclaKey) {
      let mejor: { key: string; total: number; posicion: number } | null = null;
      for (const [key, h] of ronda1) {
        const total = h.calculo.totales.total_usd;
        if (
          !mejor ||
          total > mejor.total ||
          (total === mejor.total && h.avion.posicion < mejor.posicion)
        ) {
          mejor = { key, total, posicion: h.avion.posicion };
        }
      }
      anclaKey = mejor?.key ?? ctx.aviones[0].key;
    }
    if (!hayAncla && ajusteGrupo === 0) {
      return { hijos: ronda1, anclaKey };
    }
    // Ronda 2: extras completos (ANCLA al ancla) + ajuste repartido por
    // base gravable de la ronda 1 (pesos exactos).
    const extras2 = materializarExtras(
      ctx.extras,
      hijosPax,
      anclaKey,
      ctx.pasajeros_total,
    );
    const bases = new Map<string, number>();
    for (const [key, h] of ronda1) {
      bases.set(key, Math.max(0, num(h.calculo.iva.base_usd)));
    }
    const ajustes = repartirAjuste(ajusteGrupo, bases, anclaKey);
    const ronda2 = await correr(extras2, ajustes);
    return { hijos: ronda2, anclaKey };
  }

  private consolidadoDe(
    hijos: Map<string, HijoCalculado>,
    pasajerosTotal: number,
  ): Consolidado {
    const lista: HijoConsolidable[] = [...hijos.values()].map((h) => ({
      key: h.avion.key,
      posicion: h.avion.posicion,
      matricula: h.ficha.matricula,
      calculo_snapshot: h.calculo,
      total_usd: h.calculo.totales.total_usd,
      total_mxn: h.calculo.totales.total_mxn ?? null,
    }));
    return consolidarDesgloses(lista, pasajerosTotal);
  }

  /**
   * Núcleo del armador (preview, crear y revisar comparten TODO):
   * propuesta de flota, capacidad, reglas duras, aviones (taller/squawk/
   * doble reserva), pilotos (disponibilidad + duplicados) y el motor por
   * hijo. No escribe nada.
   */
  private async prepararArmado(
    dto: ArmarGrupoDto,
    opts: OpcionesArmado = {},
    avionesPrevios?: AvionCtx[],
  ): Promise<Armado> {
    const cliente = await this.cargarCliente(dto.cliente_id);
    const plantilla = this.plantillaDe(dto.escalas_plantilla);
    const fechaVuelo = dto.fecha_vuelo;
    if (!(fechaVuelo instanceof Date) || Number.isNaN(fechaVuelo.getTime())) {
      throw new BadRequestException('fecha_vuelo inválida.');
    }
    const extras = normalizarExtrasGrupo(dto.extras_grupo ?? []);
    for (const e of dto.extras_grupo ?? []) {
      if (e.por_persona === false && (e.cantidad == null || e.cantidad <= 0)) {
        throw new BadRequestException(
          `El extra "${e.concepto}" no es por persona: indica la cantidad total.`,
        );
      }
    }
    const pasajerosTotal = Math.floor(Number(dto.pasajeros_total) || 0);

    // ---- Flota: la dada o la propuesta ----
    let aviones: AvionCtx[];
    let fichas: Map<string, FichaRow>;
    const avisosGrupo: string[] = [];
    const capacidad: Armado['capacidad'] = {
      asientos_total: 0,
      pax_asignados: 0,
      faltan: 0,
      opciones: [],
    };
    let flotaCompleta: FichaRow[] | null = null;
    if (avionesPrevios && avionesPrevios.length > 0) {
      aviones = avionesPrevios;
      fichas = await this.cargarFichas(aviones.map((a) => a.aeronave_id));
    } else if (dto.aviones && dto.aviones.length > 0) {
      aviones = dto.aviones.map((a, i) => this.avionCtxDe(a, i, i + 1));
      fichas = await this.cargarFichas(aviones.map((a) => a.aeronave_id));
    } else {
      flotaCompleta = await this.cargarFlota();
      const { enTaller } = await this.estadoAviones(
        flotaCompleta.map((f) => f.id),
      );
      const disponibles = flotaCompleta.filter(
        (f) => f.activa && !enTaller.has(f.id),
      );
      const propuesta = proponerFlota(disponibles, pasajerosTotal);
      aviones = propuesta.aviones.map((p, i) => ({
        key: `nuevo-${i + 1}`,
        posicion: i + 1,
        vuelo_id: null,
        aeronave_id: p.aeronave_id,
        pax: p.pax,
        rotaciones: p.rotaciones,
        piloto_id: null,
        copiloto_id: null,
        fecha_salida_plan: null,
        aceptar_discrepancia_alta: false,
      }));
      fichas = new Map(disponibles.map((f) => [f.id, f]));
      if (aviones.length === 0) {
        throw new ConflictException({
          message:
            'No hay aviones activos disponibles (fuera de taller) con asientos para armar el grupo.',
          error: 'SIN_FLOTA',
        });
      }
    }
    for (const a of aviones) {
      const f = fichas.get(a.aeronave_id);
      if (!f) {
        throw new BadRequestException(
          `Aeronave ${a.aeronave_id} (avión ${a.posicion}) no existe.`,
        );
      }
      if (!f.activa) {
        throw new BadRequestException(
          `${f.matricula} está inactiva: reactívala en Aeronaves antes de usarla en el grupo (avión ${a.posicion}).`,
        );
      }
    }

    // ---- Capacidad (regla dura por avión; faltantes como propuesta) ----
    let asientosTotal = 0;
    let paxAsignados = 0;
    for (const a of aviones) {
      const f = fichas.get(a.aeronave_id)!;
      const asientos = f.asientos ?? 0;
      asientosTotal += asientos * a.rotaciones;
      paxAsignados += a.pax;
      if (asientos > 0 && a.pax > asientos * a.rotaciones) {
        throw new ConflictException({
          message: `Avión ${a.posicion} (${f.matricula}): ${a.pax} pasajeros no caben en ${asientos} asientos${
            a.rotaciones === 2 ? ' × 2 vueltas' : ''
          }. Reparte pasajeros en otro avión, usa doble rotación o un avión externo.`,
          error: 'CAPACIDAD_EXCEDIDA',
          details: {
            aeronave_id: f.id,
            matricula: f.matricula,
            asientos,
            pax: a.pax,
            rotaciones: a.rotaciones,
            posicion: a.posicion,
          },
        });
      }
    }
    capacidad.asientos_total = asientosTotal;
    capacidad.pax_asignados = paxAsignados;
    capacidad.faltan = pasajerosTotal - paxAsignados;
    if (capacidad.faltan > 0) {
      avisosGrupo.push(
        `Faltan ${capacidad.faltan} pasajeros por acomodar (${paxAsignados} de ${pasajerosTotal}).`,
      );
    } else if (capacidad.faltan < 0) {
      avisosGrupo.push(
        `Los aviones suman ${paxAsignados} pasajeros y el grupo es de ${pasajerosTotal}: sobran ${-capacidad.faltan}.`,
      );
    }
    if (opts.paraEscribir && capacidad.faltan !== 0) {
      throw new ConflictException({
        message: `Los pasajeros por avión suman ${paxAsignados} y el grupo es de ${pasajerosTotal}. Cuadra el reparto antes de guardar.`,
        error: 'PAX_NO_CUADRAN',
        details: {
          pasajeros_total: pasajerosTotal,
          pax_asignados: paxAsignados,
          faltan: capacidad.faltan,
        },
      });
    }

    // ---- Pilotos: duplicados (409) y disponibilidad (avisos) ----
    const dup = duplicadosDePiloto(aviones);
    if (dup.length > 0) {
      const nombres = await this.nombresUsuarios(dup.map((d) => d.usuario_id));
      const posDe = (key: string) =>
        aviones.find((a) => a.key === key)?.posicion ?? key;
      throw new ConflictException({
        message: `Un mismo piloto no puede ir en dos aviones del grupo: ${dup
          .map(
            (d) =>
              `${nombres.get(d.usuario_id) ?? d.usuario_id} (aviones ${d.posiciones
                .map(posDe)
                .join(' y ')})`,
          )
          .join('; ')}.`,
        error: 'PILOTO_DUPLICADO',
        details: dup.map((d) => ({
          usuario_id: d.usuario_id,
          nombre: nombres.get(d.usuario_id) ?? null,
          posiciones: d.posiciones.map(posDe),
        })),
      });
    }
    const disponibilidad = await this.flights.pilotosDisponibilidadEnFecha(
      fechaVuelo.toISOString(),
      null,
    );
    const propios = opts.foliosPropios ?? new Set<number>();
    const porPiloto = new Map(disponibilidad.map((p) => [p.id, p]));
    const usados = new Set<string>();
    for (const a of aviones) {
      if (a.piloto_id) usados.add(a.piloto_id);
      if (a.copiloto_id) usados.add(a.copiloto_id);
    }
    const libres = disponibilidad.filter(
      (p) =>
        !p.descansa &&
        !p.excede_limite &&
        (!p.conflicto ||
          (p.conflicto_folio != null &&
            propios.has(Number(p.conflicto_folio)))) &&
        !usados.has(String(p.id)),
    );
    const avisosPorAvion = new Map<string, AvisoAvion>();
    let sugeridos = 0;
    for (const a of aviones) {
      const av: AvisoAvion = {
        avisos: [],
        requiere_aceptar_discrepancia_alta: false,
        discrepancias_alta: [],
        piloto_sugerido: null,
      };
      for (const [rol, uid] of [
        ['piloto', a.piloto_id],
        ['copiloto', a.copiloto_id],
      ] as const) {
        if (!uid) continue;
        const p = porPiloto.get(uid);
        if (!p) {
          av.avisos.push(`El ${rol} no está en la lista de pilotos activos.`);
          continue;
        }
        if (p.descansa)
          av.avisos.push(
            `${p.nombre} tiene descanso marcado ese día (${p.descanso_motivo ?? 'descanso'}).`,
          );
        if (
          p.conflicto &&
          !(p.conflicto_folio != null && propios.has(p.conflicto_folio))
        )
          av.avisos.push(
            `${p.nombre} ya tiene otro vuelo ese día (#${p.conflicto_folio ?? '?'}).`,
          );
        if (p.excede_limite)
          av.avisos.push(
            `${p.nombre} excede las ${p.limite_horas_mes} h del mes (${p.horas_mes} h).`,
          );
        else if (p.cerca_limite)
          av.avisos.push(
            `${p.nombre} está cerca del límite mensual (${p.horas_mes} h).`,
          );
      }
      if (!a.piloto_id) {
        const s = libres[sugeridos];
        if (s) {
          av.piloto_sugerido = { id: String(s.id), nombre: String(s.nombre) };
          sugeridos += 1;
        }
      }
      avisosPorAvion.set(a.key, av);
    }
    const sinAsignar = aviones.filter((a) => !a.piloto_id).length;
    const faltanPilotos = Math.max(0, sinAsignar - libres.length);
    if (faltanPilotos > 0) {
      avisosGrupo.push(
        `Faltan pilotos: ${faltanPilotos} de ${aviones.length} aviones sin piloto disponible (${libres.length} libres). Considera pilotos externos (gasto PILOTO_EXTERNO) o copilotos al mando.`,
      );
    }

    // ---- Aviones: taller (bloquea), squawk ALTA, doble reserva ----
    const aRevisar = aviones.filter((a) => !opts.avionSinCambio?.has(a.key));
    const { enTaller, squawks } = await this.estadoAviones([
      ...new Set(aRevisar.map((a) => a.aeronave_id)),
    ]);
    for (const a of aRevisar) {
      const f = fichas.get(a.aeronave_id)!;
      const av = avisosPorAvion.get(a.key)!;
      if (enTaller.has(a.aeronave_id)) {
        throw new ConflictException({
          message: `Avión ${a.posicion} (${f.matricula}) está en taller (mantenimiento en curso): no se puede vender en el grupo.`,
          error: 'AERONAVE_EN_TALLER',
          details: {
            aeronave_id: f.id,
            matricula: f.matricula,
            posicion: a.posicion,
          },
        });
      }
      const sq = squawks.get(a.aeronave_id) ?? [];
      if (sq.length > 0) {
        av.discrepancias_alta = sq;
        if (a.aceptar_discrepancia_alta) {
          av.avisos.push(
            `${f.matricula} tiene discrepancia ALTA sin resolver; se usa A SABIENDAS (se avisará al mecánico).`,
          );
        } else if (opts.paraEscribir) {
          throw new ConflictException({
            message: `Avión ${a.posicion} (${f.matricula}): discrepancia de severidad ALTA sin resolver (${sq
              .map((s) => s.descripcion.slice(0, 60))
              .join(
                '; ',
              )}). Confirma con aceptar_discrepancia_alta en ese avión; se avisará al mecánico.`,
            error: 'SQUAWK_ALTA_SIN_RESOLVER',
            details: {
              aeronave_id: f.id,
              matricula: f.matricula,
              posicion: a.posicion,
              discrepancias: sq,
            },
          });
        } else {
          av.requiere_aceptar_discrepancia_alta = true;
          av.avisos.push(
            `${f.matricula} tiene discrepancia ALTA sin resolver: ${sq
              .map((s) => s.descripcion.slice(0, 60))
              .join(
                '; ',
              )}. Se puede usar confirmándolo (aceptar_discrepancia_alta).`,
          );
        }
      }
    }
    // Doble reserva del avión: otro vuelo vivo del mismo avión ese día.
    for (const a of aviones) {
      const f = fichas.get(a.aeronave_id)!;
      const av = avisosPorAvion.get(a.key)!;
      const ocupados = (
        await avionOcupadoEnFecha(this.supabase.service, {
          aeronaveId: a.aeronave_id,
          fechaVuelo: fechaVuelo,
          fechaFin: null,
          excluirVueloId: a.vuelo_id,
        })
      ).filter((v) => !opts.vuelosPropios?.has(v.id));
      const aviso = avisoAvionOcupado(f.matricula, ocupados);
      if (aviso) av.avisos.push(aviso);
    }
    // El mismo avión dos veces en el request es una doble reserva segura.
    const vistos = new Map<string, number>();
    for (const a of aviones) {
      const prev = vistos.get(a.aeronave_id);
      if (prev != null) {
        avisosPorAvion
          .get(a.key)!
          .avisos.push(
            `El avión ${fichas.get(a.aeronave_id)!.matricula} ya está en el avión ${prev} del grupo: usa doble rotación en vez de repetirlo.`,
          );
      } else {
        vistos.set(a.aeronave_id, a.posicion);
      }
    }

    // ---- Motor por hijo ----
    const ctx: ArmadoCtx = {
      cliente,
      fecha_vuelo: fechaVuelo,
      pasajeros_total: pasajerosTotal,
      plantilla,
      tarifa_tipo: dto.tarifa_tipo,
      metodo_pago: dto.metodo_pago,
      metodo_pago_detalle: dto.metodo_pago_detalle,
      tc_usd_mxn: dto.tc_usd_mxn,
      pase_abordar: dto.pase_abordar === true,
      extras,
      ajuste_grupo_usd: round2(Number(dto.ajuste_grupo_usd) || 0),
      aviones,
      anclaKey: opts.anclaKey ?? null,
    };
    const { hijos, anclaKey } = await this.calcularHijos(ctx, fichas);

    // ---- Opciones para los pax que faltan (con costo calculado) ----
    if (capacidad.faltan > 0 && !opts.paraEscribir && !opts.soloMotor) {
      capacidad.opciones = await this.opcionesCapacidad(
        ctx,
        fichas,
        hijos,
        capacidad.faltan,
        flotaCompleta,
      );
    }

    return {
      ctx,
      fichas,
      hijos,
      anclaKey,
      avisosPorAvion,
      avisosGrupo,
      capacidad,
      pilotos: {
        activos: disponibilidad.length,
        libres: libres.length,
        sin_asignar: sinAsignar,
        faltan: faltanPilotos,
      },
      consolidado: this.consolidadoDe(hijos, pasajerosTotal),
    };
  }

  /** DOBLE_ROTACION (con costo delta), REACTIVAR y EXTERNO. */
  private async opcionesCapacidad(
    ctx: ArmadoCtx,
    fichas: Map<string, FichaRow>,
    hijos: Map<string, HijoCalculado>,
    faltan: number,
    flotaCompleta: FichaRow[] | null,
  ): Promise<Array<Record<string, unknown>>> {
    const opciones: Array<Record<string, unknown>> = [];
    // Doble rotación: aviones del grupo con 1 vuelta y asientos ≥ faltan,
    // los 4 más baratos por tarifa (cada delta = 2 corridas del motor).
    const candidatos = ctx.aviones
      .filter((a) => a.rotaciones === 1)
      .map((a) => ({ a, f: fichas.get(a.aeronave_id)! }))
      .filter(({ f }) => (f.asientos ?? 0) >= faltan)
      .sort(
        (x, y) =>
          (x.f.tarifa_hora_pub_usd ?? 1e9) - (y.f.tarifa_hora_pub_usd ?? 1e9),
      )
      .slice(0, 4);
    for (const { a, f } of candidatos) {
      try {
        const actual = hijos.get(a.key)!.calculo.totales.total_usd;
        const t = tramosDeHijo(ctx.plantilla, a.pax + faltan, 2, f.asientos);
        const extras = materializarExtras(
          ctx.extras.filter((e) => e.reparto !== 'ANCLA'),
          [{ key: a.key, pax: a.pax + faltan }],
          null,
          ctx.pasajeros_total,
        ).get(a.key)!;
        const dto = this.dtoBaseHijo(
          ctx,
          { ...a, pax: a.pax + faltan, rotaciones: 2 },
          t.tramos,
          extras,
          0,
        );
        const calc = await this.quotes.calculate(dto);
        opciones.push({
          tipo: 'DOBLE_ROTACION',
          aeronave_id: f.id,
          matricula: f.matricula,
          posicion: a.posicion,
          pax: a.pax + faltan,
          pax_por_rotacion: t.pax_por_rotacion,
          costo_delta_usd: round2(calc.totales.total_usd - actual),
          total_hijo_usd: calc.totales.total_usd,
          horas_hr: calc.tiempos.cobrable_hr,
        });
      } catch (err) {
        this.logger.warn(
          `Opción doble rotación ${f.matricula}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    opciones.sort((x, y) => {
      if (x.tipo !== 'DOBLE_ROTACION' || y.tipo !== 'DOBLE_ROTACION') return 0;
      return num(x.costo_delta_usd) - num(y.costo_delta_usd);
    });
    const flota = flotaCompleta ?? (await this.cargarFlota());
    for (const f of flota) {
      if (f.activa || (f.asientos ?? 0) <= 0) continue;
      opciones.push({
        tipo: 'REACTIVAR',
        aeronave_id: f.id,
        matricula: f.matricula,
        modelo: f.modelo,
        asientos: f.asientos,
        cubre: (f.asientos ?? 0) >= faltan,
      });
    }
    opciones.push({
      tipo: 'EXTERNO',
      detalle: `Cubrir ${faltan} pasajeros con un avión externo (cotización aparte por el flujo normal de externos).`,
    });
    return opciones;
  }

  private respuestaArmado(armado: Armado) {
    const { ctx, hijos, anclaKey, avisosPorAvion } = armado;
    return {
      cliente: {
        id: ctx.cliente.id,
        nombre: ctx.cliente.razon_social_default || ctx.cliente.nombre,
        es_interno: ctx.cliente.es_interno === true,
      },
      fecha_vuelo: ctx.fecha_vuelo.toISOString(),
      pasajeros_total: ctx.pasajeros_total,
      escalas_plantilla: ctx.plantilla,
      tarifa_tipo: ctx.tarifa_tipo,
      metodo_pago: ctx.metodo_pago,
      tc_usd_mxn: ctx.tc_usd_mxn ?? null,
      pase_abordar: ctx.pase_abordar,
      extras_grupo: ctx.extras,
      ajuste_grupo_usd: ctx.ajuste_grupo_usd,
      aviones: ctx.aviones.map((a) => {
        const h = hijos.get(a.key)!;
        const av = avisosPorAvion.get(a.key)!;
        return {
          key: a.key,
          posicion: a.posicion,
          vuelo_id: a.vuelo_id,
          aeronave: {
            id: h.ficha.id,
            matricula: h.ficha.matricula,
            modelo: h.ficha.modelo,
            asientos: h.ficha.asientos,
            velocidad_crucero_kts: h.ficha.velocidad_crucero_kts,
            tarifa_hora_usd: h.calculo.tarifa.usd_por_hora,
          },
          pax: a.pax,
          rotaciones: a.rotaciones,
          pax_por_rotacion: h.pax_por_rotacion,
          piloto_id: a.piloto_id,
          copiloto_id: a.copiloto_id,
          piloto_sugerido: av.piloto_sugerido,
          fecha_salida_plan: h.salida.toISOString(),
          tramos: h.tramos,
          extras: h.extras,
          ajuste_final_usd: h.ajuste_final_usd,
          es_ancla: a.key === anclaKey,
          avisos: av.avisos,
          requiere_aceptar_discrepancia_alta:
            av.requiere_aceptar_discrepancia_alta,
          discrepancias_alta: av.discrepancias_alta,
          calculo: h.calculo,
        };
      }),
      consolidado: armado.consolidado,
      avisos_grupo: armado.avisosGrupo,
      capacidad: armado.capacidad,
      pilotos: armado.pilotos,
    };
  }

  /** POST /v1/grupos/armar — preview sin escribir. */
  async armar(dto: ArmarGrupoDto) {
    const armado = await this.prepararArmado(dto);
    return this.respuestaArmado(armado);
  }

  // =====================================================================
  // Crear
  // =====================================================================

  private grupoOpts(
    cab: { id: string; folio: number },
    avion: AvionCtx,
    total: number,
  ): GrupoHijoOpts {
    return {
      id: cab.id,
      folio: cab.folio,
      posicion: avion.posicion,
      pax: avion.pax,
      total_aviones: total,
    };
  }

  private selloHijo(
    cab: { folio: number; nombre: string },
    a: AvionCtx,
    total: number,
  ) {
    return `[Grupo G-${cab.folio}] Avión ${a.posicion} de ${total} · ${cab.nombre} · ${a.pax} pax de este avión.`;
  }

  /** Borra un hijo recién creado (compensación de create; sin dinero aún). */
  private async borrarHijoRecienCreado(vueloId: string): Promise<void> {
    const sb = this.supabase.service;
    try {
      await this.calendar.removeFlight(vueloId).catch(() => undefined);
      await sb
        .from('cotizacion_version_history')
        .delete()
        .eq('vuelo_id', vueloId);
      await sb.from('vuelo_apoyo').delete().eq('vuelo_id', vueloId);
      await sb.from('escala').delete().eq('vuelo_id', vueloId);
      const { error } = await sb.from('vuelo').delete().eq('id', vueloId);
      if (error) throw new Error(error.message);
    } catch (err) {
      this.logger.error(
        `COMPENSACIÓN: no se pudo borrar el hijo ${vueloId} del grupo fallido: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Pre-check de asignación por avión con la MISMA regla que
   * flights.assign (taller bloquea, squawk ALTA exige aceptar, documentos
   * vencidos avisan a oficina). Devuelve los squawks aceptados por clave
   * para avisar al mecánico DESPUÉS de crear.
   */
  private async prevalidarAsignaciones(
    aviones: AvionCtx[],
  ): Promise<Map<string, { id: string; descripcion: string }[]>> {
    const out = new Map<string, { id: string; descripcion: string }[]>();
    for (const a of aviones) {
      const sq = await this.flights.validateAssignTargets(
        { aeronaveId: a.aeronave_id, pilotoId: a.piloto_id },
        { aceptarDiscrepanciaAlta: a.aceptar_discrepancia_alta },
      );
      if (a.copiloto_id) {
        await this.flights.validateAssignTargets({ pilotoId: a.copiloto_id });
      }
      out.set(a.key, sq);
    }
    return out;
  }

  /**
   * Crea UN hijo (motor + tramos + permisos + historial + calendario) y,
   * salvo `diferirTripulacion`, asigna tripulación / aparta. En `create()`
   * la tripulación se asigna DESPUÉS de que existan los N hijos: si el
   * avión k falla y se compensa, ningún piloto recibe el push de un vuelo
   * que ya no existe.
   */
  private async crearHijo(
    cab: { id: string; folio: number; nombre: string },
    h: HijoCalculado,
    total: number,
    userId: string,
    apartar: boolean,
    avisos: string[],
    diferirTripulacion = false,
  ): Promise<{ id: string; folio: number }> {
    const dto: CreateQuoteDto = {
      ...(h.base as CreateQuoteDto),
      fecha_vuelo: h.salida,
      notas_internas: this.selloHijo(cab, h.avion, total),
    };
    const creado = (await this.quotes.createParaGrupo(
      dto,
      userId,
      this.grupoOpts(cab, h.avion, total),
    )) as { id: string; folio: number };
    if (!diferirTripulacion) {
      await this.completarHijo(creado, h, userId, apartar, avisos);
    }
    return creado;
  }

  /** Tripulación (assign avisa al piloto) y, si aplica, RESERVA. Best-effort con aviso. */
  private async completarHijo(
    creado: { id: string; folio: number },
    h: HijoCalculado,
    userId: string,
    apartar: boolean,
    avisos: string[],
  ): Promise<void> {
    if (h.avion.piloto_id || h.avion.copiloto_id) {
      try {
        await this.flights.assign(
          creado.id,
          {
            ...(h.avion.piloto_id ? { piloto_id: h.avion.piloto_id } : {}),
            ...(h.avion.copiloto_id
              ? { copiloto_id: h.avion.copiloto_id }
              : {}),
          },
          userId,
        );
      } catch (err) {
        avisos.push(
          `Avión ${h.avion.posicion} (#${creado.folio}): el vuelo se creó pero no se pudo asignar la tripulación: ${err instanceof Error ? err.message : String(err)}. Asígnala desde el vuelo.`,
        );
      }
    }
    if (apartar) {
      // Apartar la flota: el hijo queda en RESERVA con su precio calculado y
      // la cotización abierta; confirmar el grupo lo promueve.
      const { error } = await this.supabase.service
        .from('vuelo')
        .update({
          estado: 'RESERVA',
          cotizacion_abierta: true,
          updated_by: userId,
        })
        .eq('id', creado.id)
        .eq('estado', 'COTIZADO');
      if (error) {
        avisos.push(
          `Avión ${h.avion.posicion} (#${creado.folio}): no se pudo marcar como RESERVA (${error.message}); quedó COTIZADO.`,
        );
      } else {
        void this.calendar.syncFlight(creado.id);
      }
    }
  }

  /** POST /v1/grupos — cabecera + N hijos con compensación total. */
  async create(dto: CreateGrupoDto, userId: string) {
    if (!dto.aviones || dto.aviones.length === 0) {
      throw new BadRequestException(
        'Indica los aviones del grupo (usa /grupos/armar para que el sistema proponga la flota).',
      );
    }
    // Al CREAR todos los aviones son nuevos: un `vuelo_id` colado no
    // representa nada (es campo de revisión).
    dto.aviones = dto.aviones.map((a) => ({ ...a, vuelo_id: undefined }));
    const armado = await this.prepararArmado(dto, { paraEscribir: true });
    const { ctx, hijos, anclaKey } = armado;
    const total = ctx.aviones.length;
    const squawksPorKey = await this.prevalidarAsignaciones(ctx.aviones);

    const sb = this.supabase.service;
    const { data: cabRaw, error: cabErr } = await sb
      .from('vuelo_grupo')
      .insert({
        cliente_id: ctx.cliente.id,
        nombre: dto.nombre.trim(),
        fecha_vuelo: ctx.fecha_vuelo.toISOString(),
        pasajeros_total: ctx.pasajeros_total,
        escalas_plantilla: ctx.plantilla,
        tarifa_tipo: ctx.tarifa_tipo,
        metodo_cobro: ctx.metodo_pago,
        pase_abordar: ctx.pase_abordar,
        tc_usd_mxn: ctx.tc_usd_mxn ?? null,
        extras_grupo: ctx.extras,
        ajuste_grupo_usd: ctx.ajuste_grupo_usd,
        notas: dto.notas ?? null,
        notas_internas: dto.notas_internas ?? null,
        pdf_mostrar_anexo_aviones: dto.pdf_mostrar_anexo_aviones ?? true,
        pdf_mostrar_subtotal_por_avion:
          dto.pdf_mostrar_subtotal_por_avion ?? false,
        pdf_mostrar_precio_por_persona:
          dto.pdf_mostrar_precio_por_persona ?? true,
        pdf_mostrar_tarifa: dto.pdf_mostrar_tarifa ?? false,
        created_by: userId,
        updated_by: userId,
      })
      .select('id, folio, nombre')
      .maybeSingle();
    if (cabErr) {
      if (cabErr.code === '23503')
        throw new BadRequestException(`Referencia inválida: ${cabErr.message}`);
      throw new Error(cabErr.message);
    }
    const cab = cabRaw as unknown as {
      id: string;
      folio: number;
      nombre: string;
    };

    const creados: Array<{ key: string; id: string; folio: number }> = [];
    const nuevos = new Set<string>();
    const avisos: string[] = [];
    try {
      for (const a of ctx.aviones) {
        // Idempotencia por posición (sin índice único a propósito): un hijo
        // vivo ya creado en esa posición no se duplica.
        const { data: existente } = await sb
          .from('vuelo')
          .select('id, folio')
          .eq('grupo_id', cab.id)
          .eq('grupo_posicion', a.posicion)
          .neq('estado', 'CANCELADO')
          .limit(1)
          .maybeSingle();
        if (existente) {
          creados.push({
            key: a.key,
            id: existente.id as string,
            folio: existente.folio as number,
          });
          continue;
        }
        const h = hijos.get(a.key)!;
        // Tripulación/apartar se difieren a que existan los N (ver abajo).
        const creado = await this.crearHijo(
          cab,
          h,
          total,
          userId,
          dto.apartar === true,
          avisos,
          true,
        );
        creados.push({ key: a.key, id: creado.id, folio: creado.folio });
        nuevos.add(a.key);
      }
    } catch (err) {
      // COMPENSACIÓN TOTAL: nada queda a medias (hijos creados + cabecera).
      for (const c of creados) await this.borrarHijoRecienCreado(c.id);
      await sb.from('vuelo_grupo').delete().eq('id', cab.id);
      const msg = err instanceof Error ? err.message : String(err);
      if (
        err instanceof ConflictException ||
        err instanceof BadRequestException
      ) {
        const body = err.getResponse();
        throw new ConflictException(
          typeof body === 'object' && body
            ? {
                ...(body as Record<string, unknown>),
                message: `No se creó el grupo (nada quedó a medias): ${msg}`,
              }
            : `No se creó el grupo (nada quedó a medias): ${msg}`,
        );
      }
      throw new ConflictException(
        `No se creó el grupo: falló uno de los aviones y se descartó todo (nada quedó a medias): ${msg}. Intenta de nuevo.`,
      );
    }

    // Ya existen los N hijos: tripulación (push al piloto) y apartar. Un
    // fallo aquí NO deshace el grupo: queda como aviso ("asígnala desde el
    // vuelo"), igual que en la revisión.
    for (const c of creados) {
      if (!nuevos.has(c.key)) continue;
      await this.completarHijo(
        { id: c.id, folio: c.folio },
        hijos.get(c.key)!,
        userId,
        dto.apartar === true,
        avisos,
      );
    }

    // Ancla + fecha_fin (Σ de hijos).
    const ancla = creados.find((c) => c.key === anclaKey) ?? creados[0];
    await this.sellarCabecera(
      cab.id,
      { vuelo_ancla_id: ancla?.id ?? null },
      userId,
    );
    // Squawks aceptados a sabiendas: aviso al mecánico por avión.
    for (const c of creados) {
      const sq = squawksPorKey.get(c.key) ?? [];
      const a = ctx.aviones.find((x) => x.key === c.key)!;
      if (sq.length > 0) {
        const { data: row } = await sb
          .from('vuelo')
          .select('id, folio, fecha_vuelo, origen_iata, destino_iata')
          .eq('id', c.id)
          .maybeSingle();
        if (row) this.flights.notificarSquawkAceptado(row, a.aeronave_id, sq);
      }
    }
    for (const a of ctx.aviones) {
      const av = armado.avisosPorAvion.get(a.key);
      for (const t of av?.avisos ?? [])
        avisos.push(`Avión ${a.posicion}: ${t}`);
    }
    avisos.push(...armado.avisosGrupo);
    const detalle = await this.findOne(cab.id);
    return { ...detalle, avisos: [...avisos, ...detalle.avisos] };
  }

  /** Actualiza ancla/fecha_fin de la cabecera (fecha_fin = max de hijos vivos). */
  private async sellarCabecera(
    grupoId: string,
    patch: Record<string, unknown>,
    userId: string,
  ): Promise<void> {
    const hijos = await this.cargarHijos(grupoId);
    const vivos = hijos.filter((h) => h.estado !== 'CANCELADO');
    const fechas = vivos
      .map((h) => h.fecha_fin ?? h.fecha_vuelo)
      .filter((x): x is string => !!x);
    const fechaFin = fechas.length ? fechas.sort()[fechas.length - 1] : null;
    const { error } = await this.supabase.service
      .from('vuelo_grupo')
      .update({ ...patch, fecha_fin: fechaFin, updated_by: userId })
      .eq('id', grupoId);
    if (error) this.logger.warn(`sellarCabecera ${grupoId}: ${error.message}`);
  }

  // =====================================================================
  // Detalle y lista
  // =====================================================================

  private rotacionesDe(h: HijoRow, plantillaLen: number): number {
    const comerciales = (h.escalas ?? []).filter(
      (e) => e.cancelada_at == null && e.solo_operativa !== true,
    ).length;
    if (plantillaLen > 0 && comerciales === plantillaLen * 3) return 2;
    return 1;
  }

  private hijoCongelado(h: HijoRow): string | null {
    if (h.facturado) return 'ya facturado';
    if (estadoAvanzado(h.estado) && h.cobrado) return 'ya cobrado';
    if (this.hijoEnMesCerrado(h)) return 'mes cerrado';
    return null;
  }

  /**
   * "Mes cerrado" = fecha_vuelo del hijo anterior al inicio del mes pasado
   * en hora Cancún (UTC−5). Regla ÚNICA para el candado de revisión del
   * grupo y para eliminar/re-partir un sobre de cobro: se evalúa por
   * separado de `hijoCongelado` porque ahí 'ya facturado'/'ya cobrado'
   * ganan y ocultarían el mes cerrado.
   */
  private hijoEnMesCerrado(h: HijoRow): boolean {
    if (!h.fecha_vuelo) return false;
    const ahoraCancun = new Date(Date.now() - 5 * 3_600_000);
    const inicioMesAnterior =
      Date.UTC(ahoraCancun.getUTCFullYear(), ahoraCancun.getUTCMonth() - 1, 1) +
      5 * 3_600_000;
    return new Date(h.fecha_vuelo).getTime() < inicioMesAnterior;
  }

  private async gastosPorHijo(ids: string[]) {
    const out = new Map<string, { usd: number; n: number; sin_tc: number }>();
    for (const id of ids) out.set(id, { usd: 0, n: 0, sin_tc: 0 });
    if (ids.length === 0) return out;
    const { data } = await this.supabase.service
      .from('gasto')
      .select('vuelo_id, monto, moneda, tc_gasto')
      .in('vuelo_id', ids)
      .limit(5000);
    const tcVuelo = new Map<string, number | null>();
    for (const g of data ?? []) {
      const vid = g.vuelo_id as string;
      const s = out.get(vid);
      if (!s) continue;
      s.n += 1;
      const monto = num(g.monto);
      if (g.moneda === 'USD') {
        s.usd = round2(s.usd + monto);
        continue;
      }
      const tc = num(g.tc_gasto) || tcVuelo.get(vid) || 0;
      if (tc > 0) s.usd = round2(s.usd + monto / tc);
      else s.sin_tc += 1;
    }
    return out;
  }

  async findOne(id: string) {
    const cab = await this.cargarCabecera(id);
    const hijos = await this.cargarHijos(id);
    const plantilla = this.plantillaDeSeguro(cab.escalas_plantilla);
    const extrasDefs = normalizarExtrasGrupo(cab.extras_grupo);
    const ids = hijos.map((h) => h.id);
    const [fichas, nombres, cobros, gastos] = await Promise.all([
      this.cargarFichas(hijos.map((h) => h.aeronave_id ?? '').filter(Boolean)),
      this.nombresUsuarios(hijos.flatMap((h) => [h.piloto_id, h.copiloto_id])),
      ids.length ? this.flights.cobroStatus(ids) : Promise.resolve({}),
      this.gastosPorHijo(ids),
    ]);
    const vivos = hijos.filter((h) => h.estado !== 'CANCELADO');
    const aviones = hijos.map((h) => {
      const ficha = h.aeronave_id ? fichas.get(h.aeronave_id) : undefined;
      const snap = (h.calculo_snapshot ?? {}) as SnapshotMin;
      const total = num(h.monto_total_usd);
      const cob = (
        cobros as Record<
          string,
          { total_cobrado: number; sin_tc_count: number }
        >
      )[h.id];
      const cobradoUsd = cob?.total_cobrado ?? 0;
      const semaforo =
        total <= 0
          ? 'gris'
          : cobradoUsd >= total - 1
            ? 'verde'
            : cobradoUsd > 0
              ? 'ambar'
              : 'rojo';
      const vivas = (h.escalas ?? []).filter((e) => e.cancelada_at == null);
      const g = gastos.get(h.id);
      const salida = vivas
        .slice()
        .sort((a, b) => a.orden - b.orden)
        .find((e) => e.fecha_salida_plan)?.fecha_salida_plan;
      return {
        vuelo_id: h.id,
        folio: h.folio,
        posicion: h.grupo_posicion,
        pax: h.grupo_pax,
        pasajeros: h.pasajeros,
        rotaciones: this.rotacionesDe(h, plantilla.length),
        estado: h.estado,
        cancelado: h.estado === 'CANCELADO',
        es_ancla: cab.vuelo_ancla_id === h.id,
        aeronave: ficha
          ? {
              id: ficha.id,
              matricula: ficha.matricula,
              modelo: ficha.modelo,
              asientos: ficha.asientos,
            }
          : null,
        aeronave_cotizada_id: snap.aeronave?.id ?? null,
        piloto: h.piloto_id
          ? { id: h.piloto_id, nombre: nombres.get(h.piloto_id) ?? null }
          : null,
        copiloto: h.copiloto_id
          ? { id: h.copiloto_id, nombre: nombres.get(h.copiloto_id) ?? null }
          : null,
        fecha_vuelo: h.fecha_vuelo,
        fecha_fin: h.fecha_fin,
        salida_plan: salida ?? h.fecha_vuelo,
        total_usd: round2(total),
        total_mxn:
          h.monto_total_mxn == null ? null : round2(num(h.monto_total_mxn)),
        tarifa_hora_usd: num(h.tarifa_hora_usd),
        horas_cobrables_hr: num(h.tiempo_cobrable_hr),
        cobrado: h.cobrado === true,
        cobrado_usd: cobradoUsd,
        sin_tc_count: cob?.sin_tc_count ?? 0,
        semaforo_cobro: semaforo,
        facturado: h.facturado === true,
        estado_permiso: h.estado_permiso,
        cotizacion_version: h.cotizacion_version,
        precio_desactualizado: snap.meta?.grupo?.precio_desactualizado === true,
        congelado: this.hijoCongelado(h),
        llegadas_faltantes: vivas.filter((e) => e.taco_llegada == null).length,
        tramos_vivos: vivas.length,
        gastos: g
          ? { usd: g.usd, n: g.n, sin_tc: g.sin_tc }
          : { usd: 0, n: 0, sin_tc: 0 },
        extras: h.extras,
      };
    });
    const consolidado = consolidarDesgloses(
      vivos.map((h) => ({
        key: h.id,
        posicion: h.grupo_posicion,
        matricula: h.aeronave_id
          ? (fichas.get(h.aeronave_id)?.matricula ?? null)
          : null,
        calculo_snapshot: h.calculo_snapshot,
        total_usd: num(h.monto_total_usd),
        total_mxn: h.monto_total_mxn == null ? null : num(h.monto_total_mxn),
      })),
      cab.pasajeros_total,
    );
    const problemas: ProblemaGrupo[] = diagnosticoGrupo(
      { pasajeros_total: cab.pasajeros_total, extras_grupo: extrasDefs },
      vivos.map((h) => ({
        posicion: h.grupo_posicion,
        folio: h.folio,
        grupo_pax: h.grupo_pax,
        extras: h.extras,
        calculo_snapshot: h.calculo_snapshot,
      })),
    );
    const cobradoTotal = round2(
      aviones
        .filter((a) => !a.cancelado)
        .reduce((acc, a) => acc + a.cobrado_usd, 0),
    );
    // SOBRES de cobro (Fase 2): agrupación + conciliación; el dinero sigue
    // saliendo de cobrosEnUsd por hijo (cobrado_usd/semáforos de arriba).
    const sobres = await this.sobresDeGrupo(cab.id, hijos, fichas);
    const semaforoGrupo = semaforoCobroGrupo(
      aviones
        .filter((a) => !a.cancelado)
        .map((a) => a.semaforo_cobro as SemaforoCobro),
    );
    const problemasSobres = this.problemasDeSobres(cab.folio, sobres);
    const estado: EstadoGrupo = estadoGrupoDe(hijos, cab.cancelado_at);
    const cliente = unwrap(cab.cliente);
    const { cliente: _c, ...cabPlano } = cab;
    void _c;
    return {
      ...cabPlano,
      folio_texto: `G-${cab.folio}`,
      tc_usd_mxn: cab.tc_usd_mxn == null ? null : Number(cab.tc_usd_mxn),
      ajuste_grupo_usd: num(cab.ajuste_grupo_usd),
      escalas_plantilla: plantilla,
      extras_grupo: extrasDefs,
      cliente: cliente
        ? {
            id: cliente.id,
            nombre: cliente.nombre,
            razon_social_default: cliente.razon_social_default,
            es_interno: cliente.es_interno === true,
          }
        : null,
      estado,
      aviones_vivos: vivos.length,
      aviones,
      consolidado,
      cobrado_usd: cobradoTotal,
      saldo_usd: round2(consolidado.total_usd - cobradoTotal),
      semaforo_cobro_grupo: semaforoGrupo,
      cobros: sobres,
      operacion: {
        llegadas_faltantes: aviones
          .filter((a) => !a.cancelado)
          .map((a) => ({
            vuelo_id: a.vuelo_id,
            folio: a.folio,
            posicion: a.posicion,
            faltan: a.llegadas_faltantes,
          })),
        gastos_usd: aviones.map((a) => ({
          vuelo_id: a.vuelo_id,
          folio: a.folio,
          posicion: a.posicion,
          ...a.gastos,
        })),
        permisos: aviones
          .filter((a) => !a.cancelado)
          .map((a) => ({
            vuelo_id: a.vuelo_id,
            folio: a.folio,
            posicion: a.posicion,
            estado_permiso: a.estado_permiso,
          })),
      },
      problemas: [...problemas, ...problemasSobres],
      avisos: [...problemas, ...problemasSobres].map((p) => p.detalle),
    };
  }

  private plantillaDeSeguro(entrada: unknown): PlantillaTramo[] {
    try {
      return this.plantillaDe(entrada);
    } catch {
      return [];
    }
  }

  async list(q: ListGruposQuery) {
    let query = this.supabase.service
      .from('vuelo_grupo')
      .select(CABECERA_COLS)
      .order('fecha_vuelo', { ascending: false })
      .limit(500);
    if (q.cliente_id) query = query.eq('cliente_id', q.cliente_id);
    if (q.desde) query = query.gte('fecha_vuelo', `${q.desde}T00:00:00-05:00`);
    if (q.hasta) query = query.lte('fecha_vuelo', `${q.hasta}T23:59:59-05:00`);
    if (q.q) {
      const raw = q.q.trim().replace(/[,()]/g, '_');
      const folio = raw.replace(/^g-?/i, '');
      const conds = [`nombre.ilike.%${raw}%`];
      if (/^\d+$/.test(folio)) conds.push(`folio.eq.${folio}`);
      query = query.or(conds.join(','));
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const cabeceras = (data ?? []) as unknown as CabeceraRow[];
    const ids = cabeceras.map((c) => c.id);
    const hijosPorGrupo = new Map<string, HijoRow[]>();
    if (ids.length > 0) {
      const { data: hijos, error: hErr } = await this.supabase.service
        .from('vuelo')
        .select(
          'id, folio, estado, grupo_id, grupo_posicion, grupo_pax, aeronave_id, monto_total_usd, monto_total_mxn, cobrado, facturado, fecha_vuelo, fecha_fin',
        )
        .in('grupo_id', ids)
        .limit(5000);
      if (hErr) throw new Error(hErr.message);
      for (const h of (hijos ?? []) as unknown as HijoRow[]) {
        const lista = hijosPorGrupo.get(h.grupo_id) ?? [];
        lista.push(h);
        hijosPorGrupo.set(h.grupo_id, lista);
      }
    }
    const filas = cabeceras.map((c) => {
      const hijos = hijosPorGrupo.get(c.id) ?? [];
      const vivos = hijos.filter((h) => h.estado !== 'CANCELADO');
      const plantilla = this.plantillaDeSeguro(c.escalas_plantilla);
      const cliente = unwrap(c.cliente);
      const totalUsd = round2(
        vivos.reduce((acc, h) => acc + num(h.monto_total_usd), 0),
      );
      const {
        cliente: _c,
        escalas_plantilla: _p,
        extras_grupo: _e,
        ...plano
      } = c;
      void _c;
      void _p;
      void _e;
      return {
        ...plano,
        folio_texto: `G-${c.folio}`,
        cliente_nombre: cliente
          ? cliente.razon_social_default || cliente.nombre
          : null,
        estado: estadoGrupoDe(hijos, c.cancelado_at),
        aviones: vivos.length,
        aviones_cancelados: hijos.length - vivos.length,
        pax_asignados: vivos.reduce((acc, h) => acc + (h.grupo_pax ?? 0), 0),
        total_usd: totalUsd,
        cobrados: vivos.filter((h) => h.cobrado).length,
        facturados: vivos.filter((h) => h.facturado).length,
        ruta_iatas: plantilla.length
          ? [plantilla[0].origen_iata, ...plantilla.map((t) => t.destino_iata)]
          : [],
      };
    });
    const filtradas = q.estado
      ? filas.filter((f) => f.estado === q.estado)
      : filas;
    return {
      data: filtradas.slice(q.offset, q.offset + q.limit),
      count: filtradas.length,
      limit: q.limit,
      offset: q.offset,
    };
  }

  // =====================================================================
  // Revisar
  // =====================================================================

  /** Contexto de un hijo vivo tal como está persistido (para re-materializar). */
  private avionCtxDeHijo(
    h: HijoRow,
    plantillaLen: number,
    i: number,
  ): AvionCtx {
    const snap = (h.calculo_snapshot ?? {}) as SnapshotMin;
    return {
      key: h.id,
      posicion: h.grupo_posicion ?? i + 1,
      vuelo_id: h.id,
      aeronave_id: h.aeronave_id ?? snap.aeronave?.id ?? '',
      pax: h.grupo_pax ?? h.pasajeros,
      rotaciones: this.rotacionesDe(h, plantillaLen) === 2 ? 2 : 1,
      piloto_id: h.piloto_id,
      copiloto_id: h.copiloto_id,
      tarifa_hora_override_usd:
        snap.tarifa?.proviene_de_override === true
          ? snap.tarifa.usd_por_hora
          : undefined,
      tiempo_cobrable_override_hr:
        snap.tiempos?.cobrable_proviene_de_override === true
          ? snap.tiempos.cobrable_hr
          : undefined,
      fecha_salida_plan: h.fecha_vuelo ? new Date(h.fecha_vuelo) : null,
      aceptar_discrepancia_alta: false,
    };
  }

  private dtoArmadoDesdeCabecera(
    cab: CabeceraRow,
    hijosVivos: HijoRow[],
    dto?: Partial<ReviseGrupoDto>,
  ): ArmarGrupoDto {
    const plantillaRaw =
      dto?.escalas_plantilla ?? (cab.escalas_plantilla as EscalaInputDto[]);
    const detalle =
      dto?.metodo_pago_detalle ??
      hijosVivos.find((h) => h.metodo_cobro_detalle)?.metodo_cobro_detalle ??
      undefined;
    return {
      cliente_id: cab.cliente_id,
      fecha_vuelo: dto?.fecha_vuelo ?? new Date(cab.fecha_vuelo),
      pasajeros_total: dto?.pasajeros_total ?? cab.pasajeros_total,
      escalas_plantilla: plantillaRaw,
      tarifa_tipo: (dto?.tarifa_tipo ?? cab.tarifa_tipo) as TipoTarifa,
      metodo_pago: (dto?.metodo_pago ??
        cab.metodo_cobro ??
        'TRANSFERENCIA') as MetodoPago,
      metodo_pago_detalle: detalle,
      tc_usd_mxn:
        dto?.tc_usd_mxn ??
        (cab.tc_usd_mxn == null ? undefined : Number(cab.tc_usd_mxn)),
      pase_abordar: dto?.pase_abordar ?? cab.pase_abordar,
      extras_grupo: (dto?.extras_grupo ??
        normalizarExtrasGrupo(
          cab.extras_grupo,
        )) as ArmarGrupoDto['extras_grupo'],
      ajuste_grupo_usd: dto?.ajuste_grupo_usd ?? num(cab.ajuste_grupo_usd),
    };
  }

  private reviseDtoDe(
    h: HijoCalculado,
    motivo: string,
    fechaCambio: boolean,
  ): ReviseQuoteDto {
    return {
      ...(h.base as ReviseQuoteDto),
      motivo,
      ...(fechaCambio ? { fecha_vuelo: h.salida } : {}),
    };
  }

  /** POST /v1/grupos/:id/revise */
  async revise(id: string, dto: ReviseGrupoDto, userId: string) {
    const cab = await this.cargarCabecera(id);
    if (cab.cancelado_at) {
      throw new ConflictException(
        'El grupo está cancelado: no se puede revisar.',
      );
    }
    const hijos = await this.cargarHijos(id);
    const vivos = hijos.filter((h) => h.estado !== 'CANCELADO');
    const porId = new Map(vivos.map((h) => [h.id, h]));
    const plantillaPrev = this.plantillaDeSeguro(cab.escalas_plantilla);
    const base = this.dtoArmadoDesdeCabecera(cab, vivos, dto);
    const fechaNueva = base.fecha_vuelo;
    const fechaCambio =
      Math.abs(fechaNueva.getTime() - new Date(cab.fecha_vuelo).getTime()) >
      1000;

    // ---- Aviones objetivo ----
    let objetivo: AvionCtx[];
    if (dto.aviones && dto.aviones.length > 0) {
      let siguientePos =
        Math.max(0, ...hijos.map((h) => h.grupo_posicion ?? 0)) + 1;
      objetivo = dto.aviones.map((a, i) => {
        if (a.vuelo_id) {
          const h = porId.get(a.vuelo_id);
          if (!h) {
            throw new BadRequestException(
              `El vuelo ${a.vuelo_id} no es un hijo vivo de este grupo.`,
            );
          }
          const prev = this.avionCtxDeHijo(h, plantillaPrev.length, i);
          return {
            ...prev,
            aeronave_id: a.aeronave_id,
            pax: Math.max(1, Math.floor(Number(a.pax) || 0)),
            rotaciones: a.rotaciones === 2 ? 2 : 1,
            piloto_id: a.piloto_id === undefined ? prev.piloto_id : a.piloto_id,
            copiloto_id:
              a.copiloto_id === undefined ? prev.copiloto_id : a.copiloto_id,
            tarifa_hora_override_usd:
              a.tarifa_hora_override_usd ??
              (a.aeronave_id === prev.aeronave_id
                ? prev.tarifa_hora_override_usd
                : undefined),
            tiempo_cobrable_override_hr:
              a.tiempo_cobrable_override_hr ??
              (a.aeronave_id === prev.aeronave_id
                ? prev.tiempo_cobrable_override_hr
                : undefined),
            fecha_salida_plan: a.fecha_salida_plan
              ? a.fecha_salida_plan
              : fechaCambio
                ? this.desfasar(
                    prev.fecha_salida_plan,
                    cab.fecha_vuelo,
                    fechaNueva,
                  )
                : prev.fecha_salida_plan,
            aceptar_discrepancia_alta: a.aceptar_discrepancia_alta === true,
          };
        }
        const nuevo = this.avionCtxDe(a, i, siguientePos);
        siguientePos += 1;
        return nuevo;
      });
    } else {
      objetivo = vivos.map((h, i) => {
        const prev = this.avionCtxDeHijo(h, plantillaPrev.length, i);
        return fechaCambio
          ? {
              ...prev,
              fecha_salida_plan: this.desfasar(
                prev.fecha_salida_plan,
                cab.fecha_vuelo,
                fechaNueva,
              ),
            }
          : prev;
      });
    }
    const objetivoIds = new Set(
      objetivo.map((a) => a.vuelo_id).filter((x): x is string => !!x),
    );
    const aCancelar = vivos.filter((h) => !objetivoIds.has(h.id));

    // ---- Candados de los hijos tocados ----
    const congelados: Array<{
      vuelo_id: string;
      folio: number;
      posicion: number | null;
      motivo: string;
    }> = [];
    for (const a of objetivo) {
      if (!a.vuelo_id) continue;
      const h = porId.get(a.vuelo_id)!;
      const m = this.hijoCongelado(h);
      if (m)
        congelados.push({
          vuelo_id: h.id,
          folio: h.folio,
          posicion: h.grupo_posicion,
          motivo: m,
        });
    }
    const noCancelables = aCancelar.filter((h) => h.estado === 'COMPLETADO');
    if (noCancelables.length > 0) {
      throw new ConflictException({
        message: `No se puede quitar un avión que ya voló (COMPLETADO): ${noCancelables.map((h) => `#${h.folio}`).join(', ')}.`,
        error: 'HIJOS_CONGELADOS',
        details: noCancelables.map((h) => ({
          vuelo_id: h.id,
          folio: h.folio,
          posicion: h.grupo_posicion,
          motivo: 'COMPLETADO',
        })),
      });
    }
    if (congelados.length > 0 && dto.solo_editables !== true) {
      throw new ConflictException({
        message: `Hay aviones cuya cotización ya no puede ajustarse (${congelados
          .map((c) => `#${c.folio}: ${c.motivo}`)
          .join(
            '; ',
          )}). Manda solo_editables=true para aplicar el cambio únicamente a los editables (el total del grupo cambia).`,
        error: 'HIJOS_CONGELADOS',
        details: congelados,
      });
    }
    const congeladoIds = new Set(congelados.map((c) => c.vuelo_id));

    // ---- Armado (validaciones + motor) ----
    const sinCambio = new Set(
      objetivo
        .filter(
          (a) =>
            a.vuelo_id && porId.get(a.vuelo_id)?.aeronave_id === a.aeronave_id,
        )
        .map((a) => a.key),
    );
    const armado = await this.prepararArmado(
      { ...base, aviones: undefined },
      {
        paraEscribir: true,
        vuelosPropios: new Set(vivos.map((h) => h.id)),
        foliosPropios: new Set(vivos.map((h) => h.folio)),
        avionSinCambio: sinCambio,
        anclaKey:
          cab.vuelo_ancla_id && objetivoIds.has(cab.vuelo_ancla_id)
            ? cab.vuelo_ancla_id
            : null,
      },
      objetivo,
    );
    const { ctx, hijos: calculados, anclaKey } = armado;
    const total = ctx.aviones.length;
    const nuevos = ctx.aviones.filter((a) => !a.vuelo_id);
    const cambiados = ctx.aviones.filter(
      (a) => a.vuelo_id && !sinCambio.has(a.key),
    );
    const squawksPorKey = await this.prevalidarAsignaciones([
      ...nuevos,
      ...cambiados,
    ]);

    // ---- Reclamar la revisión (candado optimista de versión) ----
    const sb = this.supabase.service;
    const { data: cabUpd, error: cabErr } = await sb
      .from('vuelo_grupo')
      .update({
        nombre: dto.nombre?.trim() || cab.nombre,
        fecha_vuelo: ctx.fecha_vuelo.toISOString(),
        pasajeros_total: ctx.pasajeros_total,
        escalas_plantilla: ctx.plantilla,
        tarifa_tipo: ctx.tarifa_tipo,
        metodo_cobro: ctx.metodo_pago,
        pase_abordar: ctx.pase_abordar,
        tc_usd_mxn: ctx.tc_usd_mxn ?? null,
        extras_grupo: ctx.extras,
        ajuste_grupo_usd: ctx.ajuste_grupo_usd,
        version: cab.version + 1,
        ...(dto.notas !== undefined ? { notas: dto.notas } : {}),
        ...(dto.notas_internas !== undefined
          ? { notas_internas: dto.notas_internas }
          : {}),
        ...(dto.pdf_mostrar_anexo_aviones !== undefined
          ? { pdf_mostrar_anexo_aviones: dto.pdf_mostrar_anexo_aviones }
          : {}),
        ...(dto.pdf_mostrar_subtotal_por_avion !== undefined
          ? {
              pdf_mostrar_subtotal_por_avion:
                dto.pdf_mostrar_subtotal_por_avion,
            }
          : {}),
        ...(dto.pdf_mostrar_precio_por_persona !== undefined
          ? {
              pdf_mostrar_precio_por_persona:
                dto.pdf_mostrar_precio_por_persona,
            }
          : {}),
        ...(dto.pdf_mostrar_tarifa !== undefined
          ? { pdf_mostrar_tarifa: dto.pdf_mostrar_tarifa }
          : {}),
        updated_by: userId,
      })
      .eq('id', id)
      .eq('version', cab.version)
      .select('id, folio, nombre')
      .maybeSingle();
    if (cabErr) throw new Error(cabErr.message);
    if (!cabUpd) {
      throw new ConflictException(
        'El grupo cambió mientras editabas (otra revisión). Recarga e intenta de nuevo.',
      );
    }
    const cabMin = cabUpd;
    const motivo = `Grupo G-${cabMin.folio} v${cab.version + 1}: ${dto.motivo.trim()}`;
    const avisos: string[] = [];
    const aplicados: string[] = [];
    const creadosIds = new Map<string, string>();

    try {
      for (const a of ctx.aviones) {
        const h = calculados.get(a.key)!;
        if (!a.vuelo_id) {
          const creado = await this.crearHijo(
            cabMin,
            h,
            total,
            userId,
            false,
            avisos,
          );
          creadosIds.set(a.key, creado.id);
          aplicados.push(`#${creado.folio} creado`);
          continue;
        }
        const prev = porId.get(a.vuelo_id)!;
        // Cambios operativos por assign (avisa a la tripulación, blanket a
        // tramos, avisos de capacidad/doble reserva).
        const patch: Record<string, unknown> = {};
        if (a.aeronave_id !== prev.aeronave_id) {
          patch.aeronave_id = a.aeronave_id;
          patch.aceptar_discrepancia_alta = a.aceptar_discrepancia_alta;
        }
        if ((a.piloto_id ?? null) !== (prev.piloto_id ?? null))
          patch.piloto_id = a.piloto_id;
        if ((a.copiloto_id ?? null) !== (prev.copiloto_id ?? null))
          patch.copiloto_id = a.copiloto_id;
        if (
          fechaCambio ||
          (a.fecha_salida_plan &&
            prev.fecha_vuelo &&
            Math.abs(
              a.fecha_salida_plan.getTime() -
                new Date(prev.fecha_vuelo).getTime(),
            ) > 1000)
        ) {
          patch.fecha_vuelo = h.salida;
        }
        if (Object.keys(patch).length > 0 && prev.estado !== 'COMPLETADO') {
          const r = (await this.flights.assign(a.vuelo_id, patch, userId)) as {
            avisos?: string[];
          };
          for (const t of r.avisos ?? [])
            avisos.push(`Avión ${a.posicion}: ${t}`);
        }
        if (congeladoIds.has(a.vuelo_id)) {
          avisos.push(
            `Avión ${a.posicion} (#${prev.folio}): cotización congelada (${congelados.find((c) => c.vuelo_id === a.vuelo_id)?.motivo}); su precio y extras no se tocaron.`,
          );
          continue;
        }
        await this.quotes.reviseParaGrupo(
          a.vuelo_id,
          this.reviseDtoDe(h, motivo, fechaCambio),
          userId,
          this.grupoOpts(cabMin, a, total),
        );
        aplicados.push(`#${prev.folio} revisado`);
      }
      for (const h of aCancelar) {
        await this.flights.cancel(
          h.id,
          `Quitado del grupo G-${cabMin.folio}: ${dto.motivo.trim()}`,
          userId,
          { silenciarAvisoGrupo: true },
        );
        aplicados.push(`#${h.folio} cancelado`);
      }
    } catch (err) {
      // No transaccional (auditoría 29-ago: nunca en silencio): se informa
      // exactamente qué quedó aplicado. `details.creados` trae los hijos
      // NUEVOS que ya existen para que el reintento los mande con su
      // `vuelo_id` (si no, se cancelarían y se crearían otra vez).
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConflictException({
        message: `La revisión del grupo G-${cabMin.folio} quedó A MEDIAS: ${aplicados.length ? `aplicado ${aplicados.join(', ')}; ` : ''}falló: ${msg}. La cabecera ya está en v${cab.version + 1}: vuelve a guardar la revisión para completar los aviones restantes.`,
        error: 'REVISION_A_MEDIAS',
        details: {
          version: cab.version + 1,
          aplicados,
          creados: [...creadosIds.entries()].map(([key, vuelo_id]) => {
            const a = ctx.aviones.find((x) => x.key === key);
            return {
              key,
              vuelo_id,
              posicion: a?.posicion ?? null,
              aeronave_id: a?.aeronave_id ?? null,
            };
          }),
        },
      });
    }
    // Squawks aceptados → mecánico.
    for (const a of [...nuevos, ...cambiados]) {
      const sq = squawksPorKey.get(a.key) ?? [];
      const vid = a.vuelo_id ?? creadosIds.get(a.key);
      if (sq.length === 0 || !vid) continue;
      const { data: row } = await sb
        .from('vuelo')
        .select('id, folio, fecha_vuelo, origen_iata, destino_iata')
        .eq('id', vid)
        .maybeSingle();
      if (row) this.flights.notificarSquawkAceptado(row, a.aeronave_id, sq);
    }
    const anclaVuelo =
      ctx.aviones.find((a) => a.key === anclaKey)?.vuelo_id ??
      creadosIds.get(anclaKey) ??
      cab.vuelo_ancla_id;
    await this.sellarCabecera(
      id,
      { vuelo_ancla_id: anclaVuelo ?? null },
      userId,
    );
    for (const a of ctx.aviones) {
      for (const t of armado.avisosPorAvion.get(a.key)?.avisos ?? [])
        avisos.push(`Avión ${a.posicion}: ${t}`);
    }
    avisos.push(...armado.avisosGrupo);
    const detalle = await this.findOne(id);
    return { ...detalle, avisos: [...avisos, ...detalle.avisos] };
  }

  /** Mantiene el desfase escalonado del hijo al mover la fecha base. */
  private desfasar(
    prev: Date | null,
    baseVieja: string,
    baseNueva: Date,
  ): Date {
    if (!prev) return baseNueva;
    const offset = prev.getTime() - new Date(baseVieja).getTime();
    return new Date(
      baseNueva.getTime() + (Number.isFinite(offset) ? offset : 0),
    );
  }

  /**
   * Re-materializa extras/ajuste en los hijos vivos tal como están (tras
   * quitar un avión o cambiar uno): mismo armado, sin tocar avión/piloto/
   * fecha. Los congelados se saltan con aviso.
   */
  private async rematerializar(
    id: string,
    motivo: string,
    userId: string,
    avisos: string[],
    anclaPreferida?: string | null,
  ): Promise<void> {
    const cab = await this.cargarCabecera(id);
    const hijos = await this.cargarHijos(id);
    const vivos = hijos.filter((h) => h.estado !== 'CANCELADO');
    if (vivos.length === 0) return;
    const plantillaLen = this.plantillaDeSeguro(cab.escalas_plantilla).length;
    const objetivo = vivos.map((h, i) =>
      this.avionCtxDeHijo(h, plantillaLen, i),
    );
    const base = this.dtoArmadoDesdeCabecera(cab, vivos);
    // Solo el motor: las validaciones de aviones/pilotos ya se hicieron.
    const armado = await this.prepararArmado(
      { ...base, aviones: undefined },
      {
        vuelosPropios: new Set(vivos.map((h) => h.id)),
        foliosPropios: new Set(vivos.map((h) => h.folio)),
        avionSinCambio: new Set(objetivo.map((a) => a.key)),
        soloMotor: true,
        anclaKey:
          anclaPreferida && vivos.some((h) => h.id === anclaPreferida)
            ? anclaPreferida
            : cab.vuelo_ancla_id &&
                vivos.some((h) => h.id === cab.vuelo_ancla_id)
              ? cab.vuelo_ancla_id
              : null,
      },
      objetivo,
    );
    const total = armado.ctx.aviones.length;
    for (const a of armado.ctx.aviones) {
      const h = vivos.find((x) => x.id === a.vuelo_id)!;
      const m = this.hijoCongelado(h);
      if (m) {
        avisos.push(
          `Avión ${a.posicion} (#${h.folio}): cotización congelada (${m}); sus extras/ajuste del grupo no se re-materializaron.`,
        );
        continue;
      }
      const calc = armado.hijos.get(a.key)!;
      await this.quotes.reviseParaGrupo(
        a.vuelo_id!,
        this.reviseDtoDe(calc, motivo, false),
        userId,
        this.grupoOpts({ id: cab.id, folio: cab.folio }, a, total),
      );
    }
    const anclaVuelo =
      armado.ctx.aviones.find((a) => a.key === armado.anclaKey)?.vuelo_id ??
      null;
    await this.sellarCabecera(id, { vuelo_ancla_id: anclaVuelo }, userId);
  }

  /** true si quitar/cambiar un avión obliga a re-materializar en los demás. */
  private requiereRematerializar(cab: CabeceraRow): boolean {
    const defs = normalizarExtrasGrupo(cab.extras_grupo);
    return (
      num(cab.ajuste_grupo_usd) !== 0 ||
      defs.some((d) => d.reparto !== 'POR_PAX' || !d.por_persona)
    );
  }

  // =====================================================================
  // Orquestaciones
  // =====================================================================

  /** POST /v1/grupos/:id/confirm */
  async confirm(id: string, userId: string) {
    const cab = await this.cargarCabecera(id);
    if (cab.cancelado_at)
      throw new ConflictException('El grupo está cancelado.');
    const vivos = (await this.cargarHijos(id)).filter(
      (h) => h.estado !== 'CANCELADO',
    );
    if (vivos.length === 0)
      throw new ConflictException('El grupo no tiene aviones vivos.');
    const porConfirmar = vivos.filter(
      (h) => h.estado === 'COTIZADO' || h.estado === 'RESERVA',
    );
    const raros = vivos.filter((h) => h.estado === 'SOLICITUD');
    if (raros.length > 0) {
      throw new ConflictException({
        message: `Hay aviones sin cotizar (${raros.map((h) => `#${h.folio}`).join(', ')}): revisa el grupo antes de confirmar.`,
        error: 'HIJOS_NO_CONFIRMABLES',
        details: raros.map((h) => ({
          vuelo_id: h.id,
          folio: h.folio,
          estado: h.estado,
        })),
      });
    }
    if (porConfirmar.length === 0) {
      throw new ConflictException(
        'Todos los aviones del grupo ya están confirmados (o ya volaron).',
      );
    }
    const confirmados: number[] = [];
    try {
      for (const h of porConfirmar) {
        if (h.estado === 'RESERVA') {
          // Nació apartado con precio: se promueve y se confirma.
          const { error } = await this.supabase.service
            .from('vuelo')
            .update({
              estado: 'COTIZADO',
              cotizacion_abierta: false,
              updated_by: userId,
            })
            .eq('id', h.id)
            .eq('estado', 'RESERVA');
          if (error) throw new Error(error.message);
        }
        await this.quotes.confirm(h.id, userId);
        confirmados.push(h.folio);
      }
    } catch (err) {
      throw new ConflictException(
        `Confirmación del grupo G-${cab.folio} a medias: ${confirmados.length ? `confirmados ${confirmados.map((f) => `#${f}`).join(', ')}; ` : ''}falló: ${err instanceof Error ? err.message : String(err)}. Vuelve a confirmar para completar.`,
      );
    }
    return this.findOne(id);
  }

  /** POST /v1/grupos/:id/cancel */
  async cancel(id: string, motivo: string, userId: string) {
    const cab = await this.cargarCabecera(id);
    if (cab.cancelado_at)
      throw new ConflictException('El grupo ya está cancelado.');
    const vivos = (await this.cargarHijos(id)).filter(
      (h) => h.estado !== 'CANCELADO',
    );
    const volados = vivos.filter((h) => h.estado === 'COMPLETADO');
    if (volados.length > 0) {
      throw new ConflictException({
        message: `No se puede cancelar el grupo: ${volados.map((h) => `#${h.folio}`).join(', ')} ya voló (COMPLETADO). Quita del grupo solo los aviones que no salieron.`,
        error: 'HIJOS_CONGELADOS',
        details: volados.map((h) => ({
          vuelo_id: h.id,
          folio: h.folio,
          posicion: h.grupo_posicion,
          motivo: 'COMPLETADO',
        })),
      });
    }
    const cancelados: number[] = [];
    try {
      for (const h of vivos) {
        await this.flights.cancel(
          h.id,
          `Grupo G-${cab.folio} cancelado: ${motivo.trim()}`,
          userId,
          {
            silenciarAvisoGrupo: true,
          },
        );
        cancelados.push(h.folio);
      }
    } catch (err) {
      throw new ConflictException(
        `Cancelación del grupo G-${cab.folio} a medias: ${cancelados.length ? `cancelados ${cancelados.map((f) => `#${f}`).join(', ')}; ` : ''}falló: ${err instanceof Error ? err.message : String(err)}. Vuelve a cancelar para completar.`,
      );
    }
    const { error } = await this.supabase.service
      .from('vuelo_grupo')
      .update({
        cancelado_at: new Date().toISOString(),
        cancelado_motivo: motivo.trim(),
        updated_by: userId,
      })
      .eq('id', id);
    if (error) throw new Error(error.message);
    return this.findOne(id);
  }

  /** PATCH /v1/grupos/:id/fecha */
  async reagendar(id: string, fecha: Date, userId: string) {
    const cab = await this.cargarCabecera(id);
    if (cab.cancelado_at)
      throw new ConflictException('El grupo está cancelado.');
    const vivos = (await this.cargarHijos(id)).filter(
      (h) => h.estado !== 'CANCELADO' && h.estado !== 'COMPLETADO',
    );
    const avisos: string[] = [];
    const aplicados: number[] = [];
    try {
      for (const h of vivos) {
        const nueva = this.desfasar(
          h.fecha_vuelo ? new Date(h.fecha_vuelo) : null,
          cab.fecha_vuelo,
          fecha,
        );
        const r = (await this.flights.assign(
          h.id,
          { fecha_vuelo: nueva },
          userId,
        )) as { avisos?: string[] };
        for (const t of r.avisos ?? [])
          avisos.push(`Avión ${h.grupo_posicion ?? '?'}: ${t}`);
        aplicados.push(h.folio);
      }
    } catch (err) {
      throw new ConflictException(
        `Reagenda del grupo G-${cab.folio} a medias: ${aplicados.length ? `movidos ${aplicados.map((f) => `#${f}`).join(', ')}; ` : ''}falló: ${err instanceof Error ? err.message : String(err)}. Vuelve a reagendar para completar.`,
      );
    }
    const { error } = await this.supabase.service
      .from('vuelo_grupo')
      .update({ fecha_vuelo: fecha.toISOString(), updated_by: userId })
      .eq('id', id);
    if (error) throw new Error(error.message);
    await this.sellarCabecera(id, {}, userId);
    const detalle = await this.findOne(id);
    return { ...detalle, avisos: [...avisos, ...detalle.avisos] };
  }

  /** DELETE /v1/grupos/:id/aviones/:vueloId */
  async quitarAvion(
    id: string,
    vueloId: string,
    dto: QuitarAvionDto,
    userId: string,
  ) {
    const cab = await this.cargarCabecera(id);
    if (cab.cancelado_at)
      throw new ConflictException('El grupo está cancelado.');
    const hijos = await this.cargarHijos(id);
    const hijo = hijos.find((h) => h.id === vueloId);
    if (!hijo)
      throw new NotFoundException(`El vuelo ${vueloId} no pertenece al grupo.`);
    if (hijo.estado === 'CANCELADO')
      throw new ConflictException(`El vuelo #${hijo.folio} ya está cancelado.`);
    if (hijo.estado === 'COMPLETADO')
      throw new ConflictException(
        `El vuelo #${hijo.folio} ya voló: no se puede quitar del grupo.`,
      );
    const restantes = hijos.filter(
      (h) => h.estado !== 'CANCELADO' && h.id !== vueloId,
    );
    const rematerializar =
      this.requiereRematerializar(cab) && restantes.length > 0;
    if (rematerializar) {
      const congelados = restantes
        .map((h) => ({ h, m: this.hijoCongelado(h) }))
        .filter((x) => x.m);
      if (congelados.length > 0) {
        throw new ConflictException({
          message: `Quitar el avión obliga a repartir de nuevo extras/ajuste del grupo, pero hay aviones congelados: ${congelados
            .map((x) => `#${x.h.folio} (${x.m})`)
            .join(', ')}.`,
          error: 'HIJOS_CONGELADOS',
          details: congelados.map((x) => ({
            vuelo_id: x.h.id,
            folio: x.h.folio,
            posicion: x.h.grupo_posicion,
            motivo: x.m,
          })),
        });
      }
    }
    const motivo = dto.motivo?.trim() || 'Quitado del grupo';
    // Partes de SOBRE en el hijo que sale: se quedan en el vuelo cancelado
    // (fuera del cobrado del grupo) hasta que oficina re-parta — decisión
    // pendiente del cliente, por eso NO se re-parte solo: se avisa.
    const partesSobre = await this.contarPartesDeSobre(vueloId);
    await this.flights.cancel(
      vueloId,
      `${motivo} (grupo G-${cab.folio})`,
      userId,
      {
        silenciarAvisoGrupo: true,
      },
    );
    const avisos: string[] = [];
    if (partesSobre > 0) {
      avisos.push(
        `El avión #${hijo.folio} tiene ${partesSobre} cobro(s) de sobre: re-parte los sobres desde Cobros del grupo para que ese dinero pase a los aviones que sí vuelan.`,
      );
    }
    if (rematerializar) {
      // El hijo YA está cancelado: un fallo al re-repartir no puede
      // responder 4xx como si nada hubiera pasado — se informa y el grupo
      // queda marcado por el diagnóstico (revisar lo completa).
      try {
        await this.rematerializar(
          id,
          `Grupo G-${cab.folio}: se quitó el avión ${hijo.grupo_posicion ?? ''} (#${hijo.folio})`,
          userId,
          avisos,
        );
      } catch (err) {
        avisos.push(
          `El avión #${hijo.folio} se quitó, pero no se pudieron re-repartir los extras/ajuste del grupo en los demás: ${err instanceof Error ? err.message : String(err)}. Revisa el grupo para completar el reparto.`,
        );
      }
    } else {
      const anclaNueva =
        cab.vuelo_ancla_id === vueloId
          ? (this.hijoMayorTotal(restantes)?.id ?? null)
          : cab.vuelo_ancla_id;
      await this.sellarCabecera(id, { vuelo_ancla_id: anclaNueva }, userId);
    }
    const detalle = await this.findOne(id);
    return { ...detalle, avisos: [...avisos, ...detalle.avisos] };
  }

  private hijoMayorTotal(hijos: HijoRow[]): HijoRow | null {
    let mejor: HijoRow | null = null;
    for (const h of hijos) {
      if (!mejor || num(h.monto_total_usd) > num(mejor.monto_total_usd))
        mejor = h;
    }
    return mejor;
  }

  /** POST /v1/grupos/:id/aviones/:vueloId/reemplazar */
  async reemplazarAvion(
    id: string,
    vueloId: string,
    dto: ReemplazarAvionDto,
    userId: string,
  ) {
    const cab = await this.cargarCabecera(id);
    if (cab.cancelado_at)
      throw new ConflictException('El grupo está cancelado.');
    const hijos = await this.cargarHijos(id);
    const hijo = hijos.find((h) => h.id === vueloId);
    if (!hijo)
      throw new NotFoundException(`El vuelo ${vueloId} no pertenece al grupo.`);
    if (hijo.estado === 'CANCELADO' || hijo.estado === 'COMPLETADO') {
      throw new ConflictException(
        `El vuelo #${hijo.folio} está ${hijo.estado}: no se reemplaza.`,
      );
    }
    const avisos: string[] = [];
    let vivoId = vueloId;
    if (dto.modo === 'ULTIMO_MINUTO') {
      const clon = (await this.flights.reassignAircraft(
        vueloId,
        {
          aeronave_id: dto.aeronave_id,
          motivo: dto.motivo,
          aceptar_discrepancia_alta: dto.aceptar_discrepancia_alta,
        },
        userId,
      )) as { id: string; folio: number };
      vivoId = clon.id;
      avisos.push(
        `El vuelo #${hijo.folio} quedó cancelado; el avión ${hijo.grupo_posicion ?? ''} ahora es el #${clon.folio}.`,
      );
      // Las partes de sobre viajan al clon (UPDATE de vuelo_id): el dinero
      // sigue en el avión vivo; solo si el precio cambia conviene re-partir.
      const partesSobre = await this.contarPartesDeSobre(clon.id);
      if (partesSobre > 0) {
        avisos.push(
          `Tiene ${partesSobre} cobro(s) de sobre: pasaron al vuelo #${clon.folio}. Si recotizas y cambia el precio, re-parte los sobres desde Cobros del grupo.`,
        );
      }
      if (dto.piloto_id) {
        const r = (await this.flights.assign(
          clon.id,
          { piloto_id: dto.piloto_id },
          userId,
        )) as { avisos?: string[] };
        avisos.push(...(r.avisos ?? []));
      }
    } else {
      const r = (await this.flights.assign(
        vueloId,
        {
          aeronave_id: dto.aeronave_id,
          ...(dto.piloto_id ? { piloto_id: dto.piloto_id } : {}),
          aceptar_discrepancia_alta: dto.aceptar_discrepancia_alta,
        },
        userId,
      )) as { avisos?: string[] };
      avisos.push(...(r.avisos ?? []));
    }
    if (dto.recotizar) {
      const actual = (await this.cargarHijos(id)).find((h) => h.id === vivoId);
      const m = actual ? this.hijoCongelado(actual) : 'no encontrado';
      if (m) {
        avisos.push(
          `Precio conservado: la cotización del vuelo está congelada (${m}). Queda marcado "precio calculado con otro avión" (precio_desactualizado).`,
        );
      } else if (actual) {
        // El avión YA cambió (assign/clon aplicados): si recotizar falla
        // (p. ej. los pax no caben en el avión nuevo — el assign solo
        // avisa, el motor sí bloquea con CAPACIDAD_EXCEDIDA) se informa y el
        // hijo conserva `precio_desactualizado` en vez de responder un 4xx
        // que haría creer que nada se aplicó.
        try {
          await this.recotizarHijo(cab, vivoId, dto.aeronave_id, userId);
          if (num(cab.ajuste_grupo_usd) !== 0) {
            avisos.push(
              'El ajuste del grupo se reparte por base gravable: revisa el grupo para re-repartirlo con el precio nuevo.',
            );
          }
        } catch (err) {
          avisos.push(
            `El avión se cambió pero NO se pudo recotizar el vuelo: ${err instanceof Error ? err.message : String(err)}. El precio queda marcado como calculado con otro avión (precio_desactualizado); corrígelo desde el grupo.`,
          );
        }
      }
    } else {
      avisos.push(
        'Precio sin recotizar: el hijo queda marcado "precio calculado con otro avión" hasta que se revise.',
      );
    }
    await this.sellarCabecera(id, {}, userId);
    const detalle = await this.findOne(id);
    return { ...detalle, avisos: [...avisos, ...detalle.avisos] };
  }

  /**
   * Recotiza UN hijo con su avión nuevo dentro del armado del grupo (mismo
   * ancla, mismos extras/ajuste); la tarifa/horas pactadas del avión viejo
   * no se arrastran (velocidad y tarifa distintas).
   */
  private async recotizarHijo(
    cab: CabeceraRow,
    vivoId: string,
    aeronaveId: string,
    userId: string,
  ): Promise<void> {
    const plantillaLen = this.plantillaDeSeguro(cab.escalas_plantilla).length;
    const vivos = (await this.cargarHijos(cab.id)).filter(
      (h) => h.estado !== 'CANCELADO',
    );
    const objetivo = vivos.map((h, i) => {
      const c = this.avionCtxDeHijo(h, plantillaLen, i);
      return h.id === vivoId
        ? {
            ...c,
            aeronave_id: aeronaveId,
            tarifa_hora_override_usd: undefined,
            tiempo_cobrable_override_hr: undefined,
          }
        : c;
    });
    const base = this.dtoArmadoDesdeCabecera(cab, vivos);
    const armado = await this.prepararArmado(
      { ...base, aviones: undefined },
      {
        vuelosPropios: new Set(vivos.map((h) => h.id)),
        foliosPropios: new Set(vivos.map((h) => h.folio)),
        avionSinCambio: new Set(objetivo.map((a) => a.key)),
        soloMotor: true,
        anclaKey:
          cab.vuelo_ancla_id && vivos.some((h) => h.id === cab.vuelo_ancla_id)
            ? cab.vuelo_ancla_id
            : null,
      },
      objetivo,
    );
    const a = armado.ctx.aviones.find((x) => x.vuelo_id === vivoId)!;
    const calc = armado.hijos.get(a.key)!;
    await this.quotes.reviseParaGrupo(
      vivoId,
      this.reviseDtoDe(
        calc,
        `Grupo G-${cab.folio}: recotizado con ${calc.ficha.matricula}`,
        false,
      ),
      userId,
      this.grupoOpts(
        { id: cab.id, folio: cab.folio },
        a,
        armado.ctx.aviones.length,
      ),
    );
  }

  // =====================================================================
  // SOBRE de cobro del grupo (Fase 2, 4-sep-2026)
  //
  // Un pago único del cliente = `cobro_grupo` (el sobre) partido en N
  // `cobro_vuelo` por el MISMO camino que el cobro por vuelo
  // (flights.createCobro / createReembolso con opts internos): cada peso
  // vive en exactamente UN cobro_vuelo, cobrosEnUsd sigue leyendo solo
  // cobro_vuelo, y el banco concilia contra el sobre (1 abono ↔ 1 sobre).
  // =====================================================================

  private async cargarSobre(id: string): Promise<SobreRow> {
    const { data, error } = await this.supabase.service
      .from('cobro_grupo')
      .select(SOBRE_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException(`Cobro de grupo ${id} no encontrado`);
    }
    return data;
  }

  private async cargarSobresDeGrupo(grupoId: string): Promise<SobreRow[]> {
    const { data, error } = await this.supabase.service
      .from('cobro_grupo')
      .select(SOBRE_COLS)
      .eq('grupo_id', grupoId)
      .order('fecha_cobro', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async cargarPartes(sobreIds: string[]): Promise<ParteRow[]> {
    if (sobreIds.length === 0) return [];
    const { data, error } = await this.supabase.service
      .from('cobro_vuelo')
      .select(PARTE_COLS)
      .in('cobro_grupo_id', sobreIds)
      .limit(10000);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Abonos del banco enlazados a estos sobres (uq_mov_bancario_cobro_grupo:
   * 1 ↔ 1). La decisión "conciliado" la toma la fuente única
   * `cobro-conciliado.util` (movimientoDeSobre) sobre estas filas.
   */
  private async movimientosDeSobres(
    sobreIds: string[],
  ): Promise<MovimientoLiga[]> {
    if (sobreIds.length === 0) return [];
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(MOV_LIGA_COLS)
      .in('cobro_grupo_id', sobreIds);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Candado de conciliación del SOBRE (espejo de assertCobroSinConciliar):
   * el banco enlaza al sobre, así que borrarlo dejaría el movimiento
   * "conciliado" contra nada. Las partes nunca tienen movimiento propio.
   */
  private async assertSobreSinConciliar(sobreId: string): Promise<void> {
    const mov = movimientoDeSobre(
      sobreId,
      await this.movimientosDeSobres([sobreId]),
    );
    const movId = mov && typeof mov.id === 'string' ? mov.id : null;
    if (movId) {
      throw new ConflictException({
        message:
          'Este cobro del grupo está conciliado con un movimiento bancario. Desvincúlalo primero en Conciliación.',
        error: 'COBRO_CONCILIADO',
        details: { cobro_grupo_id: sobreId, movimiento_bancario_id: movId },
      });
    }
  }

  /** Partes de sobre que viven en un vuelo (aviso al quitar/reemplazar). */
  private async contarPartesDeSobre(vueloId: string): Promise<number> {
    const { count, error } = await this.supabase.service
      .from('cobro_vuelo')
      .select('id', { count: 'exact', head: true })
      .eq('vuelo_id', vueloId)
      .not('cobro_grupo_id', 'is', null);
    if (error) {
      this.logger.warn(`contarPartesDeSobre ${vueloId}: ${error.message}`);
      return 0;
    }
    return count ?? 0;
  }

  private armarSobreSalida(
    sobre: SobreRow,
    partes: ParteRow[],
    hijosPorId: Map<string, HijoRow>,
    fichas: Map<string, FichaRow>,
    movs: ReadonlyArray<MovimientoLiga>,
  ): SobreSalida {
    const monto = round2(num(sobre.monto));
    const propias: ParteSobreSalida[] = partes
      .filter((p) => p.cobro_grupo_id === sobre.id)
      .map((p) => {
        const h = hijosPorId.get(p.vuelo_id);
        return {
          cobro_vuelo_id: p.id,
          vuelo_id: p.vuelo_id,
          folio: h?.folio ?? null,
          posicion: h?.grupo_posicion ?? null,
          matricula: h?.aeronave_id
            ? (fichas.get(h.aeronave_id)?.matricula ?? null)
            : null,
          monto: round2(num(p.monto)),
          factor: p.grupo_factor == null ? null : Number(p.grupo_factor),
          comision_banco_monto:
            p.comision_banco_monto == null
              ? null
              : round2(num(p.comision_banco_monto)),
          cancelado: h?.estado === 'CANCELADO',
        };
      })
      .sort(
        (a, b) =>
          (a.posicion ?? 9999) - (b.posicion ?? 9999) ||
          (a.folio ?? 0) - (b.folio ?? 0),
      );
    // Cuadre Σ partes == sobre: misma función pura que el pre-cierre y la
    // alerta diaria (cuadreSobre).
    const cuadre = cuadreSobre({ monto, partes: propias });
    const comision =
      sobre.comision_banco_monto == null
        ? null
        : round2(num(sobre.comision_banco_monto));
    const mov = movimientoDeSobre(sobre.id, movs);
    const movId = mov && typeof mov.id === 'string' ? mov.id : null;
    return {
      id: sobre.id,
      grupo_id: sobre.grupo_id,
      monto,
      moneda: sobre.moneda,
      metodo_cobro: sobre.metodo_cobro,
      tc_usd_mxn: sobre.tc_usd_mxn == null ? null : Number(sobre.tc_usd_mxn),
      comision_banco_pct:
        sobre.comision_banco_pct == null
          ? null
          : Number(sobre.comision_banco_pct),
      comision_banco_monto: comision,
      neto: comision == null ? monto : round2(monto - comision),
      cuenta_destino: sobre.cuenta_destino,
      referencia: sobre.referencia,
      foto_voucher_url: sobre.foto_voucher_url,
      fecha_cobro: sobre.fecha_cobro,
      modo_particion: sobre.modo_particion,
      registrado_por: sobre.registrado_por,
      notas: sobre.notas,
      client_request_id: sobre.client_request_id,
      created_at: sobre.created_at,
      updated_at: sobre.updated_at,
      es_reembolso: monto < 0,
      partes: propias,
      partes_suma: cuadre.suma_partes,
      cuadra: cuadre.cuadra,
      partes_en_cancelados: cuadre.partes_en_cancelados,
      conciliado: movId != null,
      movimiento_bancario_id: movId,
      recibo_disponible: monto > 0,
    };
  }

  /** Sobres del grupo con sus partes (una consulta por tabla). */
  private async sobresDeGrupo(
    grupoId: string,
    hijos: HijoRow[],
    fichas: Map<string, FichaRow>,
  ): Promise<SobreSalida[]> {
    const sobres = await this.cargarSobresDeGrupo(grupoId);
    if (sobres.length === 0) return [];
    const ids = sobres.map((s) => s.id);
    const [partes, movs] = await Promise.all([
      this.cargarPartes(ids),
      this.movimientosDeSobres(ids),
    ]);
    const hijosPorId = new Map(hijos.map((h) => [h.id, h]));
    return sobres.map((s) =>
      this.armarSobreSalida(s, partes, hijosPorId, fichas, movs),
    );
  }

  private async sobrePorId(sobreId: string): Promise<SobreSalida> {
    const sobre = await this.cargarSobre(sobreId);
    const hijos = await this.cargarHijos(sobre.grupo_id);
    const [fichas, partes, movs] = await Promise.all([
      this.cargarFichas(hijos.map((h) => h.aeronave_id ?? '').filter(Boolean)),
      this.cargarPartes([sobreId]),
      this.movimientosDeSobres([sobreId]),
    ]);
    return this.armarSobreSalida(
      sobre,
      partes,
      new Map(hijos.map((h) => [h.id, h])),
      fichas,
      movs,
    );
  }

  /**
   * Problemas tipo SOBRE del grupo — fuente única `diagnosticoSobres`
   * (particion-cobro.util): el MISMO texto que la alerta diaria
   * `grupo_desincronizado` y el pre-cierre (`sobres_descuadrados`).
   */
  private problemasDeSobres(
    grupoFolio: number | null,
    sobres: ReadonlyArray<SobreSalida>,
  ): ProblemaGrupo[] {
    return diagnosticoSobres(
      grupoFolio,
      sobres.map((s) => ({
        id: s.id,
        monto: s.monto,
        moneda: s.moneda,
        fecha_cobro: s.fecha_cobro,
        partes: s.partes,
      })),
    );
  }

  /** GET /v1/grupos/:id/cobros */
  async listarCobros(grupoId: string) {
    const cab = await this.cargarCabecera(grupoId);
    const hijos = await this.cargarHijos(grupoId);
    const fichas = await this.cargarFichas(
      hijos.map((h) => h.aeronave_id ?? '').filter(Boolean),
    );
    const cobros = await this.sobresDeGrupo(grupoId, hijos, fichas);
    return {
      grupo_id: cab.id,
      folio_texto: `G-${cab.folio}`,
      cobros,
      avisos: this.problemasDeSobres(cab.folio, cobros).map((p) => p.detalle),
    };
  }

  private traducirParticionError(err: unknown): Error {
    if (err instanceof ParticionCobroError) {
      if (err.code === 'REEMBOLSO_EXCEDE') {
        return new ConflictException({
          message: err.message,
          error: 'REEMBOLSO_EXCEDE',
          details: err.details,
        });
      }
      return new BadRequestException({
        message: err.message,
        error: err.code,
        details: err.details,
      });
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /**
   * Resuelve TC, comisión (regla única) y la partición del sobre con los
   * saldos VIVOS de cada hijo (fuente única cobroStatus → cobrosEnUsd). Al
   * re-partir, lo cobrado se mide SIN las partes del propio sobre.
   */
  private async prepararSobre(
    cab: CabeceraRow,
    entrada: EntradaSobre,
    opts: { excluirSobreId?: string } = {},
  ): Promise<PreparacionSobre> {
    const hijos = await this.cargarHijos(cab.id);
    const ids = hijos.map((h) => h.id);
    const [fichas, cobrado, viejas] = await Promise.all([
      this.cargarFichas(hijos.map((h) => h.aeronave_id ?? '').filter(Boolean)),
      ids.length
        ? this.flights.cobroStatus(ids)
        : Promise.resolve(
            {} as Record<
              string,
              { total_cobrado: number; sin_tc_count: number }
            >,
          ),
      opts.excluirSobreId
        ? this.cargarPartes([opts.excluirSobreId])
        : Promise.resolve([] as ParteRow[]),
    ]);
    const restar = new Map<string, number>();
    for (const h of hijos) {
      const propias = viejas.filter((p) => p.vuelo_id === h.id);
      if (propias.length > 0) {
        restar.set(
          h.id,
          cobrosEnUsd(propias, num(h.tc_usd_mxn) || null).total_usd,
        );
      }
    }
    const esMxn = entrada.moneda === 'MXN';
    const tcDto = Number(entrada.tc_usd_mxn);
    const tc =
      tcDto > 0
        ? tcDto
        : esMxn && num(cab.tc_usd_mxn) > 0
          ? num(cab.tc_usd_mxn)
          : null;
    const monto = round2(num(entrada.monto));
    if (
      monto < 0 &&
      (num(entrada.comision_banco_pct) > 0 ||
        num(entrada.comision_banco_monto) > 0)
    ) {
      throw new BadRequestException(
        'Un reembolso del grupo no lleva comisión bancaria: el cargo del banco se registra aparte.',
      );
    }
    const comision =
      monto > 0
        ? resolverComisionBancaria(
            monto,
            entrada.comision_banco_pct,
            entrada.comision_banco_monto,
          )
        : { pct: null, monto: null, excede: false };
    if (comision.excede) {
      throw new BadRequestException(
        'La comisión del banco no puede ser mayor o igual al monto del cobro.',
      );
    }
    const avisos: string[] = [];
    const hijosParticion: HijoParticionCobro[] = hijos.map((h) => {
      const c = cobrado[h.id];
      if (c?.sin_tc_count && h.estado !== 'CANCELADO') {
        avisos.push(
          `El avión ${h.grupo_posicion ?? '?'} (#${h.folio}) tiene ${c.sin_tc_count} cobro(s) en MXN sin tipo de cambio: no cuentan en su saldo.`,
        );
      }
      return {
        vuelo_id: h.id,
        folio: h.folio,
        posicion: h.grupo_posicion,
        matricula: h.aeronave_id
          ? (fichas.get(h.aeronave_id)?.matricula ?? null)
          : null,
        total_usd: num(h.monto_total_usd),
        cobrado_usd: round2((c?.total_cobrado ?? 0) - (restar.get(h.id) ?? 0)),
        es_ancla: cab.vuelo_ancla_id === h.id,
        cancelado: h.estado === 'CANCELADO',
      };
    });
    let particion: ParticionCobroResult;
    try {
      particion = particionCobroGrupo({
        monto,
        moneda: esMxn ? 'MXN' : 'USD',
        tc,
        comision_banco_monto: comision.monto,
        hijos: hijosParticion,
        modo: entrada.modo ?? 'AUTO',
        particion_manual: entrada.particion_manual ?? null,
      });
    } catch (err) {
      throw this.traducirParticionError(err);
    }
    return {
      particion,
      comision: { pct: comision.pct, monto: comision.monto },
      avisos: [...avisos, ...particion.avisos],
    };
  }

  /** POST /v1/grupos/:id/cobros/previsualizar (sin escribir). */
  async previsualizarCobro(grupoId: string, dto: CreateCobroGrupoDto) {
    const cab = await this.cargarCabecera(grupoId);
    if (cab.cancelado_at) {
      throw new ConflictException(
        'El grupo está cancelado: los cargos por cancelación se registran en cada vuelo.',
      );
    }
    const prep = await this.prepararSobre(cab, dto);
    const p = prep.particion;
    return {
      grupo_id: cab.id,
      folio_texto: `G-${cab.folio}`,
      modo_particion: p.modo_particion,
      monto: p.monto,
      moneda: p.moneda,
      monto_usd: p.monto_usd,
      tc_usd_mxn: p.tc,
      comision_banco_pct: prep.comision.pct,
      comision_banco_monto: prep.comision.monto,
      neto:
        prep.comision.monto == null
          ? p.monto
          : round2(p.monto - prep.comision.monto),
      partes: p.partes,
      verificacion: p.verificacion,
      avisos: prep.avisos,
    };
  }

  /**
   * Escribe UNA parte por el mismo camino que el cobro/reembolso por vuelo
   * (comisión, TC, refreshCobradoFlag; sin push ni ventana: son del sobre).
   */
  private async crearParte(
    cab: CabeceraRow,
    sobre: SobreRow,
    parte: {
      vuelo_id: string;
      monto: number;
      factor: number | null;
      comision_banco_monto: number | null;
      tc: number | null;
    },
    userId: string,
  ): Promise<void> {
    const opts: CobroParteDeSobreOpts = {
      cobro_grupo_id: sobre.id,
      grupo_factor: parte.factor,
      silenciarPush: true,
    };
    const fecha = sobre.fecha_cobro ? new Date(sobre.fecha_cobro) : undefined;
    const moneda = sobre.moneda as CreateCobroDto['moneda'];
    const metodo = sobre.metodo_cobro as CreateCobroDto['metodo_cobro'];
    if (parte.monto > 0) {
      const dtoParte: CreateCobroDto = {
        monto: parte.monto,
        moneda,
        metodo_cobro: metodo,
        tc_usd_mxn: parte.tc ?? undefined,
        comision_banco_monto: parte.comision_banco_monto ?? undefined,
        cuenta_destino: sobre.cuenta_destino ?? undefined,
        referencia: sobre.referencia ?? undefined,
        fecha_cobro: fecha,
        foto_voucher_url: sobre.foto_voucher_url ?? undefined,
        notas: sobre.notas ?? undefined,
      };
      await this.flights.createCobro(
        parte.vuelo_id,
        dtoParte,
        userId,
        undefined,
        opts,
      );
      return;
    }
    const dtoReembolso: CreateReembolsoDto = {
      monto: Math.abs(parte.monto),
      moneda,
      metodo_cobro: metodo,
      tc_usd_mxn: parte.tc ?? undefined,
      cuenta_destino: sobre.cuenta_destino ?? undefined,
      referencia: sobre.referencia ?? undefined,
      fecha_cobro: fecha,
      motivo:
        sobre.notas?.trim() || `Reembolso del sobre del grupo G-${cab.folio}`,
    };
    await this.flights.createReembolso(
      parte.vuelo_id,
      dtoReembolso,
      userId,
      opts,
    );
  }

  private async escribirPartes(
    cab: CabeceraRow,
    sobre: SobreRow,
    prep: PreparacionSobre,
    userId: string,
  ): Promise<void> {
    for (const parte of prep.particion.partes) {
      try {
        await this.crearParte(
          cab,
          sobre,
          {
            vuelo_id: parte.vuelo_id,
            monto: parte.monto,
            factor: parte.factor,
            comision_banco_monto: parte.comision_banco_monto,
            tc: prep.particion.tc,
          },
          userId,
        );
      } catch (err) {
        throw new Error(
          `avión ${parte.posicion ?? '?'} (#${parte.folio ?? '?'}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Borra todas las partes del sobre; devuelve los vuelos tocados. */
  private async borrarPartes(sobreId: string): Promise<string[]> {
    const { data, error } = await this.supabase.service
      .from('cobro_vuelo')
      .delete()
      .eq('cobro_grupo_id', sobreId)
      .select('vuelo_id');
    if (error) throw new Error(error.message);
    return [...new Set((data ?? []).map((r) => r.vuelo_id as string))];
  }

  /** Bandera `cobrado` de cada hijo tocado — best-effort (el dinero ya está). */
  private async refrescarCobrado(
    vueloIds: string[],
    userId: string,
  ): Promise<void> {
    for (const id of new Set(vueloIds)) {
      try {
        await this.flights.refreshCobradoFlag(id, userId);
      } catch (err) {
        this.logger.error(
          `refrescarCobrado ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Revierte un sobre a medio escribir: partes + sobre (best-effort, con
   * log). Devuelve `true` solo si NO quedó nada en BD — el mensaje al
   * operador depende de eso (jamás decir "no se guardó nada" en falso).
   */
  private async compensarSobre(
    sobreId: string,
    userId: string,
  ): Promise<boolean> {
    try {
      const vuelos = await this.borrarPartes(sobreId);
      const { error } = await this.supabase.service
        .from('cobro_grupo')
        .delete()
        .eq('id', sobreId);
      if (error) throw new Error(error.message);
      await this.refrescarCobrado(vuelos, userId);
      return true;
    } catch (err) {
      this.logger.error(
        `compensarSobre ${sobreId}: no se pudo revertir por completo (${err instanceof Error ? err.message : String(err)}). El sobre puede quedar descuadrado: elimínalo desde Cobros del grupo.`,
      );
      return false;
    }
  }

  private assertPartesFueraDeMesCerrado(
    cab: CabeceraRow,
    hijos: HijoRow[],
    partes: ParteRow[],
    accion: string,
  ): void {
    const conParte = new Set(partes.map((p) => p.vuelo_id));
    const cerrados = hijos.filter(
      (h) => conParte.has(h.id) && this.hijoEnMesCerrado(h),
    );
    if (cerrados.length > 0) {
      throw new ConflictException({
        message: `No se puede ${accion} el cobro del grupo G-${cab.folio}: tiene partes en vuelos de un mes ya cerrado (${cerrados
          .map((h) => `#${h.folio}`)
          .join(', ')}).`,
        error: 'MES_CERRADO',
        details: cerrados.map((h) => ({
          vuelo_id: h.id,
          folio: h.folio,
          posicion: h.grupo_posicion,
          fecha_vuelo: h.fecha_vuelo,
        })),
      });
    }
  }

  /**
   * POST /v1/grupos/:id/cobros — registra el sobre y sus N partes.
   * Idempotente por client_request_id (devuelve el existente con
   * `idempotente: true` → 200). Compensación total si falla una parte.
   */
  async registrarCobro(
    grupoId: string,
    dto: CreateCobroGrupoDto,
    userId: string,
  ): Promise<{ sobre: SobreSalida; idempotente: boolean }> {
    const sb = this.supabase.service;
    const cab = await this.cargarCabecera(grupoId);
    if (cab.cancelado_at) {
      throw new ConflictException(
        'El grupo está cancelado: los cargos por cancelación se registran en cada vuelo.',
      );
    }
    if (dto.client_request_id) {
      const { data: ya, error } = await sb
        .from('cobro_grupo')
        .select('id')
        .eq('client_request_id', dto.client_request_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (ya) {
        this.logger.log(
          `Sobre idempotente: reintento con client_request_id ${dto.client_request_id} → se devuelve el sobre ${ya.id as string}.`,
        );
        return {
          sobre: await this.sobrePorId(ya.id as string),
          idempotente: true,
        };
      }
    }
    const prep = await this.prepararSobre(cab, dto);
    const p = prep.particion;
    // Ventana anti-duplicado de 90 s a nivel SOBRE (doble clic sin llave).
    if (!dto.client_request_id) {
      const { data: gemelos } = await sb
        .from('cobro_grupo')
        .select('id, created_at')
        .eq('grupo_id', cab.id)
        .eq('monto', p.monto)
        .eq('moneda', p.moneda)
        .eq('metodo_cobro', dto.metodo_cobro)
        .gte('created_at', new Date(Date.now() - 90_000).toISOString())
        .limit(1);
      if ((gemelos ?? []).length > 0) {
        throw new ConflictException(
          'Parece el mismo cobro del grupo repetido: ya hay uno idéntico registrado hace menos de 90 segundos. Si de verdad son dos pagos iguales, espera un momento e inténtalo de nuevo.',
        );
      }
    }
    const { data: sobreData, error: insErr } = await sb
      .from('cobro_grupo')
      .insert({
        grupo_id: cab.id,
        monto: p.monto,
        moneda: p.moneda,
        metodo_cobro: dto.metodo_cobro,
        tc_usd_mxn: p.tc,
        comision_banco_pct: prep.comision.pct,
        comision_banco_monto: prep.comision.monto,
        cuenta_destino: dto.cuenta_destino?.trim() || null,
        referencia: dto.referencia?.trim() || null,
        foto_voucher_url: dto.foto_voucher_url ?? null,
        fecha_cobro: (dto.fecha_cobro ?? new Date()).toISOString(),
        modo_particion: p.modo_particion,
        registrado_por: userId,
        notas: dto.notas?.trim() || null,
        client_request_id: dto.client_request_id ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select(SOBRE_COLS)
      .maybeSingle();
    if (insErr) {
      if (
        insErr.code === '23505' &&
        dto.client_request_id &&
        insErr.message.includes('uq_cobro_grupo_client_request')
      ) {
        const { data: ya } = await sb
          .from('cobro_grupo')
          .select('id')
          .eq('client_request_id', dto.client_request_id)
          .maybeSingle();
        if (ya) {
          return {
            sobre: await this.sobrePorId(ya.id as string),
            idempotente: true,
          };
        }
      }
      throw new Error(insErr.message);
    }
    const sobre = sobreData as SobreRow;
    try {
      await this.escribirPartes(cab, sobre, prep, userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `registrarCobro G-${cab.folio}: falló una parte (${msg}); se revierte el sobre ${sobre.id}.`,
      );
      const revertido = await this.compensarSobre(sobre.id, userId);
      throw new ConflictException(
        revertido
          ? `No se pudo registrar el cobro del grupo G-${cab.folio}: ${msg}. No se guardó nada.`
          : `No se pudo registrar el cobro del grupo G-${cab.folio}: ${msg}. El sobre quedó a medias: revísalo en Cobros del grupo (elimínalo o re-pártelo) antes de volver a capturarlo.`,
      );
    }
    // UN aviso por sobre (no uno por avión), a quien hoy recibe cobro_registrado.
    const n = p.partes.length;
    this.flights.notificarCobroRegistrado(
      {
        tipo: 'cobro_registrado',
        titulo: p.monto < 0 ? 'Reembolso registrado' : 'Cobro registrado',
        cuerpo: `Grupo G-${cab.folio} · $${fmtMonto(Math.abs(p.monto))} ${p.moneda} · ${n} avión${n === 1 ? '' : 'es'}`,
        data: {
          grupo_id: cab.id,
          grupo_folio: cab.folio,
          cobro_grupo_id: sobre.id,
          monto: p.monto,
          moneda: p.moneda,
          aviones: n,
          modo_particion: p.modo_particion,
        },
        link: `/admin/quotes/grupo/${cab.id}`,
      },
      userId,
    );
    return { sobre: await this.sobrePorId(sobre.id), idempotente: false };
  }

  /** DELETE /v1/grupos/cobros/:cobroGrupoId — borra las N partes y el sobre. */
  async eliminarCobro(cobroGrupoId: string, userId: string) {
    const sobre = await this.cargarSobre(cobroGrupoId);
    const cab = await this.cargarCabecera(sobre.grupo_id);
    await this.assertSobreSinConciliar(sobre.id);
    const [partes, hijos] = await Promise.all([
      this.cargarPartes([sobre.id]),
      this.cargarHijos(cab.id),
    ]);
    this.assertPartesFueraDeMesCerrado(cab, hijos, partes, 'eliminar');
    const vuelos = await this.borrarPartes(sobre.id);
    const { error } = await this.supabase.service
      .from('cobro_grupo')
      .delete()
      .eq('id', sobre.id);
    if (error) {
      this.logger.error(
        `eliminarCobro ${sobre.id}: las ${partes.length} partes se eliminaron pero el sobre no: ${error.message}`,
      );
      throw new Error(error.message);
    }
    await this.refrescarCobrado(vuelos, userId);
    return {
      ok: true as const,
      cobro_grupo_id: sobre.id,
      grupo_id: cab.id,
      partes_eliminadas: partes.length,
      vuelos,
    };
  }

  /**
   * POST /v1/grupos/cobros/:id/repartir — regenera las partes SOLO entre los
   * hijos vivos con la regla AUTO (un avión se canceló o se agregó). Segura
   * porque el banco enlaza al sobre, no a las partes. Si falla, las partes
   * anteriores se restauran por el mismo camino.
   */
  async repartirCobro(cobroGrupoId: string, userId: string) {
    const sb = this.supabase.service;
    const sobre = await this.cargarSobre(cobroGrupoId);
    const cab = await this.cargarCabecera(sobre.grupo_id);
    if (cab.cancelado_at) {
      throw new ConflictException(
        'El grupo está cancelado: no se re-parten sus cobros.',
      );
    }
    const [partesViejas, hijos] = await Promise.all([
      this.cargarPartes([sobre.id]),
      this.cargarHijos(cab.id),
    ]);
    this.assertPartesFueraDeMesCerrado(cab, hijos, partesViejas, 're-partir');
    const prep = await this.prepararSobre(
      cab,
      {
        monto: num(sobre.monto),
        moneda: sobre.moneda,
        tc_usd_mxn: sobre.tc_usd_mxn == null ? null : Number(sobre.tc_usd_mxn),
        comision_banco_pct:
          sobre.comision_banco_pct == null
            ? null
            : Number(sobre.comision_banco_pct),
        comision_banco_monto:
          sobre.comision_banco_monto == null
            ? null
            : Number(sobre.comision_banco_monto),
        modo: 'AUTO',
      },
      { excluirSobreId: sobre.id },
    );
    const vuelosViejos = await this.borrarPartes(sobre.id);
    try {
      await this.escribirPartes(cab, sobre, prep, userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await this.borrarPartes(sobre.id);
        for (const v of partesViejas) {
          await this.crearParte(
            cab,
            sobre,
            {
              vuelo_id: v.vuelo_id,
              monto: round2(num(v.monto)),
              factor: v.grupo_factor == null ? null : Number(v.grupo_factor),
              comision_banco_monto:
                v.comision_banco_monto == null
                  ? null
                  : round2(num(v.comision_banco_monto)),
              tc: v.tc_usd_mxn == null ? null : Number(v.tc_usd_mxn),
            },
            userId,
          );
        }
        await this.refrescarCobrado(vuelosViejos, userId);
      } catch (err2) {
        this.logger.error(
          `repartirCobro ${sobre.id}: no se restauraron las partes anteriores: ${err2 instanceof Error ? err2.message : String(err2)}`,
        );
        throw new ConflictException(
          `No se pudo re-partir el cobro del grupo G-${cab.folio}: ${msg}. Además no se pudieron restaurar las partes anteriores: revisa el sobre en Cobros del grupo.`,
        );
      }
      throw new ConflictException(
        `No se pudo re-partir el cobro del grupo G-${cab.folio}: ${msg}. Las partes anteriores se conservaron.`,
      );
    }
    const { error: updErr } = await sb
      .from('cobro_grupo')
      .update({
        modo_particion: prep.particion.modo_particion,
        updated_by: userId,
      })
      .eq('id', sobre.id);
    if (updErr) {
      this.logger.warn(`repartirCobro ${sobre.id}: ${updErr.message}`);
    }
    // Los hijos que RECIBIERON parte ya se refrescaron en createCobro; los
    // que la PERDIERON (cancelados) se refrescan aquí.
    await this.refrescarCobrado(vuelosViejos, userId);
    const avisos = [...prep.avisos];
    if (prep.particion.modo_particion !== sobre.modo_particion) {
      avisos.push(
        `El sobre pasó de ${sobre.modo_particion} a ${prep.particion.modo_particion}.`,
      );
    }
    return { sobre: await this.sobrePorId(sobre.id), avisos };
  }

  /** Día Cancún de la salida del grupo (para etiquetas). */
  diaCancunDe(iso: string | null): string | null {
    return iso ? diaCancun(iso) : null;
  }
}
