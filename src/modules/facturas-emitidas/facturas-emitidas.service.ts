import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { SupabaseService } from '../supabase/supabase.service';
import { FlightsService } from '../flights/flights.service';
import { FacturaSolicitudService } from '../flights/factura-solicitud.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import { NotificationsService } from '../realtime/notifications.service';
import {
  errorFacturasNoDisponibles,
  facturaEmitidaDisponible,
} from '../../common/factura-emitida-disponible.util';
import { fetchNombresUsuarios } from '../../common/registrado-por.util';
import { hoyCancun } from '../../common/fecha-cancun.util';
import {
  LIMITE_ARCHIVO_FACTURA_BYTES,
  extraerCfdiCompleto,
  monedaCfdi,
  normalizarRfc,
  validarArchivoFactura,
  xmlDeclaraDoctype,
  type ArchivoMultipart,
  type CfdiCompleto,
} from '../flights/factura-cliente.util';
import {
  COLS_SOLICITUD_FACTURA,
  esPorFacturar,
  solicitudDe,
  textoAvisoEmitida,
  type VueloSolicitudRow,
} from '../flights/factura-solicitud.util';
import { FacturaEmitidaDatosDto } from './dto/facturas-emitidas.dto';
import type {
  ExportFacturasEmitidasQuery,
  ListFacturasEmitidasQuery,
  VuelosCandidatosQuery,
} from './dto/facturas-emitidas.dto';
import {
  COLS_FACTURA_EMITIDA,
  COLS_VUELO_LIGADO,
  PAGINA_BD,
  RE_RFC,
  RE_UUID_FISCAL,
  avisoTotalDistintoVuelo,
  buscarYaRegistrada,
  calcularAlertas,
  claveCompacta,
  cobroResumenDe,
  compararFacturas,
  enLotes,
  etiquetaFactura,
  facturaExistenteDe,
  faltanDatosFiscales,
  filtrarFacturas,
  huecosPorSerie,
  interpretarBusquedaVuelo,
  normalizarFolio,
  normalizarNombreEmpresa,
  normalizarSerie,
  normalizarUuidEntrada,
  numeroONull,
  patronIlikeSeguro,
  redondear2,
  rutaIatasDe,
  textoONull,
  totalVueloDe,
  totalesPorMoneda,
  verificarEmisor,
  type CandidatoDuplicado,
  type EmisoraRef,
  type FacturaEmitidaRow,
  type FacturaFiltrable,
  type FiltrosFacturas,
  type LigaFacturaVuelo,
  type VueloLigadoRow,
} from './facturas-emitidas.util';
import { payloadExcelFacturas } from './facturas-emitidas-xlsx';
import type {
  AlertaFactura,
  AvisoFactura,
  CamposLeidosFactura,
  FacturaEmitida,
  FacturaExistente,
  GrupoDeVueloFactura,
  LecturaArchivoFactura,
  ListaFacturasEmitidas,
  MetodoPagoFactura,
  MonedaFactura,
  PorFacturarItem,
  ResultadoGuardarFactura,
  ResumenFacturas,
  VueloCandidatoFactura,
} from './facturas-emitidas.types';

/** Bucket PRIVADO de las facturas (el mismo de la factura por vuelo). */
export const BUCKET_FACTURAS = 'facturas';
/** Vigencia de la URL firmada del PDF/XML (10 min). */
export const SEGUNDOS_URL_FIRMADA = 600;

/** Archivos multipart que recibe el controlador (FileFieldsInterceptor). */
export interface ArchivosFactura {
  pdf?: ArchivoMultipart[];
  xml?: ArchivoMultipart[];
}

/** Quién hace la operación (AuthenticatedUser recortado). */
export interface ActorFactura {
  userId: string;
  nombre?: string | null;
}

type TipoArchivo = 'pdf' | 'xml';

interface ArchivoValido {
  buffer: Buffer;
  nombre: string;
  extension: TipoArchivo;
}

interface ArchivoSubido {
  tipo: TipoArchivo;
  path: string;
  nombre: string;
}

interface ClienteRef {
  id: string;
  nombre: string;
  rfc: string | null;
  razon_social_default: string | null;
  es_interno: boolean;
  activo?: boolean | null;
}

/** Vuelo que se liga (validación + avisos + efectos). */
interface VueloParaLigar extends VueloSolicitudRow {
  id: string;
  folio: number;
  estado: string;
  cliente_id: string | null;
  grupo_id: string | null;
  monto_total_usd: unknown;
  monto_total_mxn: unknown;
  tc_usd_mxn: unknown;
  factura_estatus?: string | null;
  facturado?: boolean | null;
  cliente?: { nombre?: string | null; rfc?: string | null } | null;
}

const COLS_VUELO_PARA_LIGAR = `id, folio, estado, cliente_id, grupo_id, monto_total_usd, monto_total_mxn, tc_usd_mxn, factura_estatus, facturado, ${COLS_SOLICITUD_FACTURA}, cliente:cliente_id(nombre, rfc)`;

/** Datos ya normalizados (lo que se escribe en la fila). */
interface DatosNormalizados {
  serie?: string | null;
  folio?: string;
  uuid?: string | null;
  fecha_emision?: string;
  emisor_rfc?: string | null;
  emisor_nombre?: string | null;
  emisora_id?: string | null;
  receptor_rfc?: string | null;
  receptor_nombre?: string | null;
  cliente_id?: string | null;
  moneda?: MonedaFactura;
  subtotal?: number | null;
  iva?: number | null;
  total?: number;
  metodo_pago?: MetodoPagoFactura | null;
  forma_pago?: string | null;
  notas?: string | null;
  es_parcial?: boolean;
  vuelo_ids?: string[];
}

/** Contexto para convertir filas en `FacturaEmitida`. */
interface Contexto {
  alertas: Map<string, AlertaFactura[]>;
  vigentesPorVuelo: Map<string, string[]>;
  etiquetaDe: Map<string, string>;
  ligasPorFactura: Map<string, LigaFacturaVuelo[]>;
  clientes: Map<string, ClienteRef>;
  emisoras: Map<string, EmisoraRef>;
  nombres: Map<string, string>;
  cobros: Record<
    string,
    { total_cobrado: number; sin_tc_count: number }
  > | null;
}

const CAMPOS_NULLABLES_TEXTO = [
  'serie',
  'uuid',
  'emisor_rfc',
  'emisor_nombre',
  'receptor_rfc',
  'receptor_nombre',
  'forma_pago',
  'notas',
  'metodo_pago',
  'emisora_id',
  'cliente_id',
];

function mensajeErrores(errores: ValidationError[]): string[] {
  const out: string[] = [];
  for (const e of errores) {
    const restricciones = Object.values(e.constraints ?? {});
    if (restricciones.length > 0) out.push(...restricciones);
    else out.push(`${e.property}: valor inválido`);
    if (e.children?.length) out.push(...mensajeErrores(e.children));
  }
  return out;
}

function unwrap<T>(rel: T | T[] | null | undefined): T | null {
  if (Array.isArray(rel)) return rel[0] ?? null;
  return rel ?? null;
}

/**
 * FACTURAS EMITIDAS — registro de las facturas que hace facturación A MANO
 * (pedido de Ale, 24-sep-2026). NO es la facturación automática del PAC
 * (tabla `factura`, `/admin/facturas`): esa queda intacta.
 *
 * Todo camino responde 503 `FACTURAS_EMITIDAS_NO_DISPONIBLE` sin la
 * migración 20260924000003. Las decisiones (duplicados, orden, alertas,
 * huecos, avisos) viven en `facturas-emitidas.util.ts` (puro, con spec).
 * Los ARCHIVOS nunca se borran del bucket salvo lo recién subido de una
 * operación que FALLÓ: quitar/reemplazar solo desreferencia y deja rastro en
 * `archivos_historial` (el #297 perdió su PDF con un «Quitar»).
 */
@Injectable()
export class FacturasEmitidasService {
  private readonly logger = new Logger(FacturasEmitidasService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly flights: FlightsService,
    private readonly solicitud: FacturaSolicitudService,
    private readonly pyservices: PyservicesService,
    private readonly notifications: NotificationsService,
  ) {}

  private get sb() {
    return this.supabase.service;
  }

  private async asegurarDisponible(): Promise<void> {
    if (!(await facturaEmitidaDisponible(this.sb))) {
      throw errorFacturasNoDisponibles();
    }
  }

  // ======================================================================
  // LECTURAS BASE
  // ======================================================================

  /** Lee TODAS las filas de una consulta en páginas de 1000 (anti-cap). */
  private async leerTodo<T>(
    consulta: (
      desde: number,
      hasta: number,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let desde = 0; ; desde += PAGINA_BD) {
      const { data, error } = await consulta(desde, desde + PAGINA_BD - 1);
      if (error) throw new Error(error.message);
      const filas = (data ?? []) as T[];
      out.push(...filas);
      if (filas.length < PAGINA_BD) break;
    }
    return out;
  }

  /** Todas las facturas NO borradas. */
  private cargarFacturas(): Promise<FacturaEmitidaRow[]> {
    return this.leerTodo<FacturaEmitidaRow>((d, h) =>
      this.sb
        .from('factura_emitida')
        .select(COLS_FACTURA_EMITIDA)
        .is('deleted_at', null)
        .order('id')
        .range(d, h),
    );
  }

  /** Facturas NO borradas por id (lotes de 200). */
  private async facturasPorIds(ids: string[]): Promise<FacturaEmitidaRow[]> {
    const out: FacturaEmitidaRow[] = [];
    for (const lote of enLotes([...new Set(ids)])) {
      const { data, error } = await this.sb
        .from('factura_emitida')
        .select(COLS_FACTURA_EMITIDA)
        .in('id', lote)
        .is('deleted_at', null);
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as unknown as FacturaEmitidaRow[]));
    }
    return out;
  }

  /** Una factura no borrada o 404 FACTURA_NO_EXISTE. */
  private async facturaOFalla(id: string): Promise<FacturaEmitidaRow> {
    const { data, error } = await this.sb
      .from('factura_emitida')
      .select(COLS_FACTURA_EMITIDA)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException({
        message: 'Esa factura no existe o se eliminó del registro.',
        error: 'FACTURA_NO_EXISTE',
        details: { id },
      });
    }
    return data;
  }

  /** TODAS las ligas del puente con su vuelo (anti-cap). */
  private cargarTodasLasLigas(): Promise<LigaFacturaVuelo[]> {
    return this.leerTodo<LigaFacturaVuelo>((d, h) =>
      this.sb
        .from('factura_emitida_vuelo')
        .select(`factura_id, vuelo_id, vuelo:vuelo_id(${COLS_VUELO_LIGADO})`)
        .order('factura_id')
        .order('vuelo_id')
        .range(d, h),
    ).then((ls) => ls.map((l) => ({ ...l, vuelo: unwrap(l.vuelo) })));
  }

  /**
   * Ligas de un CONJUNTO de facturas + TODAS las ligas de sus vuelos (con la
   * factura embebida, no borrada): con eso se calculan las alertas de esas
   * facturas sin leer todo el registro (`DUPLICADO_VUELO` depende de las
   * otras vigentes del vuelo).
   */
  private async contextoDeFacturas(facturas: FacturaRowLike[]): Promise<{
    ligas: LigaFacturaVuelo[];
    facturasRef: Array<{
      id: string;
      serie: string | null;
      folio: string;
      estatus: string;
      es_parcial: boolean | null;
      pdf_path: string | null;
    }>;
  }> {
    const ids = facturas.map((f) => f.id);
    const propias: LigaFacturaVuelo[] = [];
    for (const lote of enLotes(ids)) {
      const { data, error } = await this.sb
        .from('factura_emitida_vuelo')
        .select('factura_id, vuelo_id')
        .in('factura_id', lote);
      if (error) throw new Error(error.message);
      propias.push(
        ...(
          (data ?? []) as Array<{ factura_id: string; vuelo_id: string }>
        ).map((l) => ({ ...l, vuelo: null })),
      );
    }
    const vueloIds = [...new Set(propias.map((l) => l.vuelo_id))];
    const ligas: LigaFacturaVuelo[] = [];
    const facturasRef = new Map<
      string,
      {
        id: string;
        serie: string | null;
        folio: string;
        estatus: string;
        es_parcial: boolean | null;
        pdf_path: string | null;
      }
    >();
    for (const f of facturas) {
      facturasRef.set(f.id, {
        id: f.id,
        serie: f.serie,
        folio: f.folio,
        estatus: f.estatus,
        es_parcial: f.es_parcial,
        pdf_path: f.pdf_path,
      });
    }
    for (const lote of enLotes(vueloIds)) {
      const { data, error } = await this.sb
        .from('factura_emitida_vuelo')
        .select(
          `factura_id, vuelo_id, factura:factura_emitida!inner(id, serie, folio, estatus, es_parcial, pdf_path, deleted_at), vuelo:vuelo_id(${COLS_VUELO_LIGADO})`,
        )
        .in('vuelo_id', lote)
        .is('factura.deleted_at', null);
      if (error) throw new Error(error.message);
      for (const l of (data ?? []) as Array<Record<string, unknown>>) {
        const fac = unwrap(
          l.factura as {
            id: string;
            serie: string | null;
            folio: string;
            estatus: string;
            es_parcial: boolean | null;
            pdf_path: string | null;
            deleted_at?: string | null;
          } | null,
        );
        if (!fac || fac.deleted_at) continue;
        if (!facturasRef.has(fac.id)) {
          facturasRef.set(fac.id, {
            id: fac.id,
            serie: fac.serie,
            folio: fac.folio,
            estatus: fac.estatus,
            es_parcial: fac.es_parcial,
            pdf_path: fac.pdf_path,
          });
        }
        ligas.push({
          factura_id: l.factura_id as string,
          vuelo_id: l.vuelo_id as string,
          vuelo: unwrap(l.vuelo as VueloLigadoRow | VueloLigadoRow[] | null),
        });
      }
    }
    return { ligas, facturasRef: [...facturasRef.values()] };
  }

  private async cargarEmisoras(): Promise<EmisoraRef[]> {
    const { data, error } = await this.sb
      .from('entidad_fiscal_emisora')
      .select('id, razon_social, rfc, activa')
      .order('razon_social');
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async cargarClientes(
    ids: string[],
  ): Promise<Map<string, ClienteRef>> {
    const out = new Map<string, ClienteRef>();
    for (const lote of enLotes([...new Set(ids.filter(Boolean))])) {
      const { data, error } = await this.sb
        .from('cliente')
        .select('id, nombre, rfc, razon_social_default, es_interno, activo')
        .in('id', lote);
      if (error) throw new Error(error.message);
      for (const c of (data ?? []) as ClienteRef[]) out.set(c.id, c);
    }
    return out;
  }

  /** Semáforo de cobro por la FUENTE ÚNICA; si falla ⇒ null («Por cobrar»). */
  private async cobrosSeguros(
    vueloIds: string[],
  ): Promise<Record<
    string,
    { total_cobrado: number; sin_tc_count: number }
  > | null> {
    const ids = [...new Set(vueloIds.filter(Boolean))];
    if (ids.length === 0) return {};
    try {
      return await this.flights.cobroStatus(ids);
    } catch (e) {
      this.logger.warn(
        `cobroStatus falló para ${ids.length} vuelo(s): ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /** Arma el contexto de presentación de un conjunto de facturas. */
  private async armarContexto(
    facturas: FacturaEmitidaRow[],
    ligas: LigaFacturaVuelo[],
    facturasRef: Array<{
      id: string;
      serie: string | null;
      folio: string;
      estatus: string;
      es_parcial: boolean | null;
      pdf_path: string | null;
    }>,
    opts: {
      clientes?: Map<string, ClienteRef>;
      emisoras?: EmisoraRef[];
      conCobros?: boolean;
    } = {},
  ): Promise<Contexto> {
    const calc = calcularAlertas(facturasRef, ligas);
    const idsVisibles = new Set(facturas.map((f) => f.id));
    const ligasPorFactura = new Map<string, LigaFacturaVuelo[]>();
    for (const l of ligas) {
      if (!idsVisibles.has(l.factura_id)) continue;
      (
        ligasPorFactura.get(l.factura_id) ??
        ligasPorFactura.set(l.factura_id, []).get(l.factura_id)!
      ).push(l);
    }
    const vuelosVisibles = [...ligasPorFactura.values()]
      .flat()
      .map((l) => l.vuelo)
      .filter((v): v is VueloLigadoRow => !!v);
    const idsClientes = [
      ...facturas.map((f) => f.cliente_id),
      ...vuelosVisibles.map((v) => v.cliente_id),
    ].filter((x): x is string => !!x);
    const faltantes = opts.clientes
      ? idsClientes.filter((id) => !opts.clientes!.has(id))
      : idsClientes;
    const [clientesExtra, emisoras, nombres, cobros] = await Promise.all([
      this.cargarClientes(faltantes),
      opts.emisoras ? Promise.resolve(opts.emisoras) : this.cargarEmisoras(),
      fetchNombresUsuarios(
        this.sb,
        facturas.flatMap((f) => [
          f.created_by,
          f.pdf_subido_por,
          f.cancelada_por,
        ]),
      ),
      opts.conCobros === false
        ? Promise.resolve(null)
        : this.cobrosSeguros(vuelosVisibles.map((v) => v.id)),
    ]);
    const clientes = new Map([...(opts.clientes ?? []), ...clientesExtra]);
    return {
      alertas: calc.porFactura,
      vigentesPorVuelo: calc.vigentesPorVuelo,
      etiquetaDe: new Map(
        facturasRef.map((f) => [f.id, etiquetaFactura(f.serie, f.folio)]),
      ),
      ligasPorFactura,
      clientes,
      emisoras: new Map(emisoras.map((e) => [e.id, e])),
      nombres,
      cobros,
    };
  }

  /** Fila de BD ⇒ `FacturaEmitida` del contrato (jamás expone paths). */
  private construir(f: FacturaEmitidaRow, ctx: Contexto): FacturaEmitida {
    const ligas = ctx.ligasPorFactura.get(f.id) ?? [];
    const vuelos = ligas
      .filter((l) => !!l.vuelo)
      .map((l) => {
        const v = l.vuelo!;
        const cli = v.cliente_id ? ctx.clientes.get(v.cliente_id) : undefined;
        const status = ctx.cobros ? (ctx.cobros[v.id] ?? null) : null;
        return {
          id: v.id,
          folio: Number(v.folio),
          fecha_vuelo: v.fecha_vuelo ?? null,
          estado: v.estado,
          cliente_nombre: cli?.nombre ?? null,
          total: totalVueloDe(v),
          cobro: cobroResumenDe(v, status, cli?.es_interno === true),
          otras_vigentes: (ctx.vigentesPorVuelo.get(v.id) ?? [])
            .filter((id) => id !== f.id)
            .map((id) => ctx.etiquetaDe.get(id) ?? '')
            .filter(Boolean),
        };
      })
      .sort((a, b) => {
        if (a.fecha_vuelo === b.fecha_vuelo) return a.folio - b.folio;
        if (!a.fecha_vuelo) return 1;
        if (!b.fecha_vuelo) return -1;
        return a.fecha_vuelo < b.fecha_vuelo ? -1 : 1;
      });
    const emisora = f.emisora_id ? ctx.emisoras.get(f.emisora_id) : undefined;
    const cliente = f.cliente_id ? ctx.clientes.get(f.cliente_id) : undefined;
    const historial = Array.isArray(f.archivos_historial)
      ? f.archivos_historial.length
      : 0;
    return {
      id: f.id,
      serie: f.serie ?? null,
      folio: f.folio,
      folio_num: numeroONull(f.folio_num),
      etiqueta: etiquetaFactura(f.serie, f.folio),
      uuid: f.uuid ?? null,
      fecha_emision: f.fecha_emision,
      estatus: f.estatus === 'CANCELADA' ? 'CANCELADA' : 'VIGENTE',
      emisor_rfc: f.emisor_rfc ?? null,
      emisor_nombre: f.emisor_nombre ?? null,
      emisora: f.emisora_id
        ? {
            id: f.emisora_id,
            razon_social: emisora?.razon_social ?? 'Razón social',
          }
        : null,
      receptor_rfc: f.receptor_rfc ?? null,
      receptor_nombre: f.receptor_nombre ?? null,
      cliente: f.cliente_id
        ? { id: f.cliente_id, nombre: cliente?.nombre ?? '' }
        : null,
      moneda: f.moneda === 'USD' ? 'USD' : 'MXN',
      subtotal: numeroONull(f.subtotal),
      iva: numeroONull(f.iva),
      total: numeroONull(f.total) ?? 0,
      metodo_pago:
        f.metodo_pago === 'PUE' || f.metodo_pago === 'PPD'
          ? f.metodo_pago
          : null,
      forma_pago: f.forma_pago ?? null,
      notas: f.notas ?? null,
      es_parcial: f.es_parcial === true,
      pdf: f.pdf_path
        ? {
            nombre: f.pdf_nombre ?? null,
            subido_at: f.pdf_subido_at ?? null,
            subido_por_nombre: f.pdf_subido_por
              ? (ctx.nombres.get(f.pdf_subido_por) ?? null)
              : null,
          }
        : null,
      xml: f.xml_path
        ? { nombre: f.xml_nombre ?? null, subido_at: f.xml_subido_at ?? null }
        : null,
      archivos_anteriores: historial,
      vuelos,
      alertas: ctx.alertas.get(f.id) ?? [],
      cancelada:
        f.estatus === 'CANCELADA' && f.cancelada_at
          ? {
              at: f.cancelada_at,
              por_nombre: f.cancelada_por
                ? (ctx.nombres.get(f.cancelada_por) ?? null)
                : null,
              motivo: f.motivo_cancelacion ?? '',
            }
          : null,
      created_at: f.created_at,
      created_por_nombre: f.created_by
        ? (ctx.nombres.get(f.created_by) ?? null)
        : null,
      updated_at: f.updated_at,
    };
  }

  /** Una factura completa (alertas incluidas) sin leer todo el registro. */
  private async facturaCompleta(id: string): Promise<FacturaEmitida> {
    const fila = await this.facturaOFalla(id);
    const { ligas, facturasRef } = await this.contextoDeFacturas([fila]);
    const ctx = await this.armarContexto([fila], ligas, facturasRef);
    return this.construir(fila, ctx);
  }

  // ======================================================================
  // LISTA, DETALLE, EXPORT
  // ======================================================================

  /** Todo el registro con alertas (base de la lista y del Excel). */
  private async registroCompleto(): Promise<{
    facturas: FacturaEmitidaRow[];
    ligas: LigaFacturaVuelo[];
    emisoras: EmisoraRef[];
    clientes: Map<string, ClienteRef>;
    filtrables: FacturaFiltrable[];
    ctxBase: ReturnType<typeof calcularAlertas>;
  }> {
    const [facturas, ligasTodas, emisoras] = await Promise.all([
      this.cargarFacturas(),
      this.cargarTodasLasLigas(),
      this.cargarEmisoras(),
    ]);
    const vivas = new Set(facturas.map((f) => f.id));
    // Ligas de facturas borradas NO cuentan (todo lector filtra deleted_at).
    const ligas = ligasTodas.filter((l) => vivas.has(l.factura_id));
    const calc = calcularAlertas(facturas, ligas);
    const clientes = await this.cargarClientes(
      facturas.map((f) => f.cliente_id).filter((x): x is string => !!x),
    );
    const vuelosDe = new Map<string, LigaFacturaVuelo[]>();
    for (const l of ligas) {
      (
        vuelosDe.get(l.factura_id) ??
        vuelosDe.set(l.factura_id, []).get(l.factura_id)!
      ).push(l);
    }
    const filtrables: FacturaFiltrable[] = facturas.map((f) => {
      const ls = vuelosDe.get(f.id) ?? [];
      return {
        id: f.id,
        serie: f.serie,
        folio: f.folio,
        uuid: f.uuid,
        estatus: f.estatus,
        fecha_emision: f.fecha_emision,
        receptor_nombre: f.receptor_nombre,
        receptor_rfc: f.receptor_rfc,
        cliente_id: f.cliente_id,
        cliente_nombre: f.cliente_id
          ? (clientes.get(f.cliente_id)?.nombre ?? null)
          : null,
        emisora_id: f.emisora_id,
        vuelo_ids: ls.map((l) => l.vuelo_id),
        vuelo_folios: ls
          .map((l) => (l.vuelo ? Number(l.vuelo.folio) : null))
          .filter((x): x is number => x != null),
        alertas: calc.porFactura.get(f.id) ?? [],
      };
    });
    return { facturas, ligas, emisoras, clientes, filtrables, ctxBase: calc };
  }

  private resumenDe(
    facturas: FacturaEmitidaRow[],
    ligas: LigaFacturaVuelo[],
    calc: ReturnType<typeof calcularAlertas>,
    emisoras: EmisoraRef[],
    porFacturar: number,
  ): ResumenFacturas {
    const vigentes = facturas.filter((f) => f.estatus === 'VIGENTE');
    const conLiga = new Set(ligas.map((l) => l.factura_id));
    const razon = new Map(emisoras.map((e) => [e.id, e.razon_social]));
    return {
      registradas: facturas.length,
      vigentes: vigentes.length,
      canceladas: facturas.length - vigentes.length,
      sin_pdf: vigentes.filter((f) => !f.pdf_path).length,
      sin_vuelo: vigentes.filter((f) => !conLiga.has(f.id)).length,
      vuelos_con_varias: calc.vuelosDuplicados.size,
      en_vuelo_cancelado: vigentes.filter((f) =>
        (calc.porFactura.get(f.id) ?? []).includes('VUELO_CANCELADO'),
      ).length,
      por_facturar: porFacturar,
      totales_vigentes: totalesPorMoneda(facturas),
      huecos: huecosPorSerie(facturas, (id) => razon.get(id) ?? null),
    };
  }

  private validarRango(q: { desde?: string; hasta?: string }): void {
    if (q.desde && q.hasta && q.desde > q.hasta) {
      throw new BadRequestException({
        message: 'La fecha «desde» es posterior a «hasta».',
        error: 'RANGO_INVALIDO',
        details: { desde: q.desde, hasta: q.hasta },
      });
    }
  }

  private async conteoSeguro(): Promise<number> {
    try {
      return (await this.conteoPorFacturar()).por_facturar;
    } catch (e) {
      this.logger.warn(
        `Conteo de por facturar falló: ${e instanceof Error ? e.message : String(e)}`,
      );
      return 0;
    }
  }

  /** `GET /v1/facturas-emitidas` */
  async lista(
    query: ListFacturasEmitidasQuery,
  ): Promise<ListaFacturasEmitidas> {
    await this.asegurarDisponible();
    this.validarRango(query);
    const reg = await this.registroCompleto();
    const filtros = this.filtrosDe(query);
    const idsFiltrados = new Set(
      filtrarFacturas(reg.filtrables, filtros).map((f) => f.id),
    );
    const filtradas = reg.facturas
      .filter((f) => idsFiltrados.has(f.id))
      .sort(compararFacturas(query.orden ?? 'folio_desc'));
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const pagina = filtradas.slice(offset, offset + limit);
    const [ctx, porFacturar] = await Promise.all([
      this.armarContexto(pagina, reg.ligas, reg.facturas, {
        clientes: reg.clientes,
        emisoras: reg.emisoras,
      }),
      this.conteoSeguro(),
    ]);
    const vigentesFiltradas = filtradas.filter((f) => f.estatus === 'VIGENTE');
    return {
      data: pagina.map((f) => this.construir(f, ctx)),
      count: filtradas.length,
      limit,
      offset,
      resumen: this.resumenDe(
        reg.facturas,
        reg.ligas,
        reg.ctxBase,
        reg.emisoras,
        porFacturar,
      ),
      filtrado: {
        count: vigentesFiltradas.length,
        totales: totalesPorMoneda(vigentesFiltradas),
      },
    };
  }

  private filtrosDe(q: ExportFacturasEmitidasQuery): FiltrosFacturas {
    return {
      q: q.q,
      desde: q.desde,
      hasta: q.hasta,
      cliente_id: q.cliente_id,
      emisora_id: q.emisora_id,
      serie: q.serie,
      estatus: q.estatus,
      vuelo_id: q.vuelo_id,
      alerta: q.alerta,
    };
  }

  /** `GET /v1/facturas-emitidas/:id` */
  async obtener(id: string): Promise<FacturaEmitida> {
    await this.asegurarDisponible();
    return this.facturaCompleta(id);
  }

  /** `GET /v1/facturas-emitidas/export.xlsx` */
  async exportXlsx(
    query: ExportFacturasEmitidasQuery,
  ): Promise<{ buffer: Buffer; filename: string }> {
    await this.asegurarDisponible();
    this.validarRango(query);
    const reg = await this.registroCompleto();
    const filtros = this.filtrosDe(query);
    const ids = new Set(
      filtrarFacturas(reg.filtrables, filtros).map((f) => f.id),
    );
    const filtradas = reg.facturas
      .filter((f) => ids.has(f.id))
      .sort(compararFacturas(query.orden ?? 'folio_desc'));
    const [ctx, porFacturar] = await Promise.all([
      this.armarContexto(filtradas, reg.ligas, reg.facturas, {
        clientes: reg.clientes,
        emisoras: reg.emisoras,
      }),
      this.conteoSeguro(),
    ]);
    const facturas = filtradas.map((f) => this.construir(f, ctx));
    const resumen = this.resumenDe(
      reg.facturas,
      reg.ligas,
      reg.ctxBase,
      reg.emisoras,
      porFacturar,
    );
    let clienteNombre: string | null = null;
    if (query.cliente_id) {
      clienteNombre =
        reg.clientes.get(query.cliente_id)?.nombre ??
        (await this.cargarClientes([query.cliente_id])).get(query.cliente_id)
          ?.nombre ??
        null;
    }
    const emisoraNombre =
      query.emisora_id && query.emisora_id !== 'SIN_EMISORA'
        ? (reg.emisoras.find((e) => e.id === query.emisora_id)?.razon_social ??
          null)
        : null;
    const payload = payloadExcelFacturas({
      facturas,
      resumen,
      filtros,
      nombres: { cliente: clienteNombre, emisora: emisoraNombre },
    });
    const buffer = await this.pyservices.generateTablaXlsx(payload);
    return { buffer, filename: `facturas-emitidas-${hoyCancun()}.xlsx` };
  }

  // ======================================================================
  // POR FACTURAR
  // ======================================================================

  /** Vuelos con solicitud (no cancelados, sin CFDI del PAC), anti-cap. */
  private vuelosConSolicitud<T>(cols: string): Promise<T[]> {
    return this.leerTodo<T>((d, h) =>
      this.sb
        .from('vuelo')
        .select(cols)
        .not('factura_solicitada_at', 'is', null)
        .neq('estado', 'CANCELADO')
        .order('id')
        .range(d, h),
    );
  }

  /** `GET /v1/facturas-emitidas/por-facturar/conteo` (badge del menú). */
  async conteoPorFacturar(): Promise<{
    por_facturar: number;
    paga_contra_factura: number;
  }> {
    await this.asegurarDisponible();
    const vuelos = (
      await this.vuelosConSolicitud<VueloSolicitudRow & { id: string }>(
        `id, estado, facturado, ${COLS_SOLICITUD_FACTURA}`,
      )
    ).filter((v) => v.facturado !== true);
    const ligadas = await this.solicitud.ligadasDeVuelos(
      vuelos.map((v) => v.id),
    );
    let porFacturar = 0;
    let paga = 0;
    for (const v of vuelos) {
      const vigentes = (ligadas.get(v.id) ?? []).filter(
        (f) => f.estatus === 'VIGENTE',
      ).length;
      if (!esPorFacturar(v, vigentes)) continue;
      porFacturar += 1;
      if (v.factura_paga_contra_factura === true) paga += 1;
    }
    return { por_facturar: porFacturar, paga_contra_factura: paga };
  }

  /** Aviones vivos por grupo (1 consulta por lote de grupos). */
  private async avionesPorGrupo(
    grupoIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const lote of enLotes([...new Set(grupoIds.filter(Boolean))])) {
      const { data, error } = await this.sb
        .from('vuelo')
        .select('grupo_id')
        .in('grupo_id', lote)
        .neq('estado', 'CANCELADO')
        .limit(10000);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<{ grupo_id: string }>) {
        out.set(r.grupo_id, (out.get(r.grupo_id) ?? 0) + 1);
      }
    }
    return out;
  }

  private grupoDe(
    rel: unknown,
    conteo: Map<string, number>,
  ): GrupoDeVueloFactura | null {
    const g = unwrap(
      rel as
        | { id: string; folio: unknown; nombre: string | null }
        | Array<{ id: string; folio: unknown; nombre: string | null }>
        | null,
    );
    if (!g) return null;
    return {
      id: g.id,
      folio: g.folio == null ? null : Number(g.folio),
      nombre: g.nombre ?? null,
      total_aviones: conteo.get(g.id) ?? 0,
    };
  }

  /** Ruta comercial por vuelo (escalas no operativas; lotes de 200). */
  private async rutasPorVuelo(ids: string[]): Promise<Map<string, string[]>> {
    const porVuelo = new Map<
      string,
      Array<{ origen_iata: string | null; destino_iata: string | null }>
    >();
    for (const lote of enLotes(ids)) {
      const { data, error } = await this.sb
        .from('escala')
        .select('vuelo_id, orden, origen_iata, destino_iata')
        .in('vuelo_id', lote)
        .eq('solo_operativa', false)
        .order('orden', { ascending: true })
        .limit(10000);
      if (error) throw new Error(error.message);
      for (const e of (data ?? []) as Array<Record<string, unknown>>) {
        const vid = e.vuelo_id as string;
        (porVuelo.get(vid) ?? porVuelo.set(vid, []).get(vid)!).push({
          origen_iata: (e.origen_iata as string | null) ?? null,
          destino_iata: (e.destino_iata as string | null) ?? null,
        });
      }
    }
    const out = new Map<string, string[]>();
    for (const [vid, es] of porVuelo) out.set(vid, rutaIatasDe(es, {}));
    return out;
  }

  /** `GET /v1/facturas-emitidas/por-facturar` */
  async porFacturar(): Promise<{ data: PorFacturarItem[]; count: number }> {
    await this.asegurarDisponible();
    type Fila = VueloSolicitudRow & {
      id: string;
      folio: number;
      estado: string;
      fecha_vuelo: string | null;
      origen_iata: string | null;
      destino_iata: string | null;
      es_externo: boolean | null;
      factura_estatus: string | null;
      monto_total_usd: unknown;
      monto_total_mxn: unknown;
      tc_usd_mxn: unknown;
      cobrado: boolean | null;
      cotizacion_abierta: boolean | null;
      cliente: Record<string, unknown> | Record<string, unknown>[] | null;
      grupo: unknown;
    };
    const filas = (
      await this.vuelosConSolicitud<Fila>(
        `id, folio, estado, fecha_vuelo, origen_iata, destino_iata, es_externo, facturado, factura_estatus, monto_total_usd, monto_total_mxn, tc_usd_mxn, cobrado, cotizacion_abierta, ${COLS_SOLICITUD_FACTURA}, cliente:cliente_id(id, nombre, rfc, razon_social_default, regimen_fiscal_receptor, uso_cfdi, codigo_postal, domicilio_fiscal, pais_residencia, es_interno), grupo:grupo_id(id, folio, nombre)`,
      )
    ).filter((v) => v.facturado !== true);
    const ligadas = await this.solicitud.ligadasDeVuelos(
      filas.map((v) => v.id),
    );
    const pendientes = filas.filter((v) =>
      esPorFacturar(
        v,
        (ligadas.get(v.id) ?? []).filter((f) => f.estatus === 'VIGENTE').length,
      ),
    );
    const ids = pendientes.map((v) => v.id);
    const grupoIds = pendientes
      .map((v) => unwrap(v.grupo as { id: string } | null)?.id)
      .filter((x): x is string => !!x);
    const [cobros, nombres, rutas, conteoGrupos] = await Promise.all([
      this.cobrosSeguros(ids),
      fetchNombresUsuarios(
        this.sb,
        pendientes.map((v) => v.factura_solicitada_por),
      ),
      this.rutasPorVuelo(ids),
      this.avionesPorGrupo(grupoIds),
    ]);
    const data: PorFacturarItem[] = pendientes.map((v) => {
      const c = unwrap(v.cliente);
      const status = cobros ? (cobros[v.id] ?? null) : null;
      const estatusManual =
        v.factura_estatus === 'FACTURADO' ||
        v.factura_estatus === 'ELABORADA_ENVIADA'
          ? v.factura_estatus
          : 'SIN_FACTURA';
      const str = (x: unknown) =>
        typeof x === 'string' && x.trim() !== '' ? x : null;
      return {
        vuelo: {
          id: v.id,
          folio: Number(v.folio),
          estado: v.estado,
          fecha_vuelo: v.fecha_vuelo ?? null,
          ruta_iatas: rutas.get(v.id) ?? rutaIatasDe([], v),
          es_externo: v.es_externo === true,
          grupo: this.grupoDe(v.grupo, conteoGrupos),
          estatus_manual: estatusManual,
        },
        cliente: c
          ? {
              id: c.id as string,
              nombre: (c.nombre as string) ?? '',
              rfc: str(c.rfc),
              razon_social: str(c.razon_social_default),
              regimen_fiscal: str(c.regimen_fiscal_receptor),
              uso_cfdi: str(c.uso_cfdi),
              codigo_postal: str(c.codigo_postal),
              domicilio_fiscal: str(c.domicilio_fiscal),
              pais_residencia: str(c.pais_residencia),
            }
          : null,
        faltan_datos_fiscales: faltanDatosFiscales(c),
        total: totalVueloDe(v),
        cobro: cobroResumenDe(v, status, c?.es_interno === true),
        solicitud: solicitudDe(
          v,
          v.factura_solicitada_por
            ? (nombres.get(v.factura_solicitada_por) ?? null)
            : null,
        )!,
        facturas_canceladas: (ligadas.get(v.id) ?? []).filter(
          (f) => f.estatus === 'CANCELADA',
        ).length,
      };
    });
    data.sort((a, b) => {
      const pa = a.solicitud.paga_contra_factura ? 1 : 0;
      const pb = b.solicitud.paga_contra_factura ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return a.solicitud.solicitada_at < b.solicitud.solicitada_at
        ? -1
        : a.solicitud.solicitada_at > b.solicitud.solicitada_at
          ? 1
          : a.vuelo.folio - b.vuelo.folio;
    });
    return { data, count: data.length };
  }

  // ======================================================================
  // VUELOS CANDIDATOS (selector del diálogo)
  // ======================================================================

  /** `GET /v1/facturas-emitidas/vuelos-candidatos` */
  async vuelosCandidatos(
    query: VuelosCandidatosQuery,
  ): Promise<VueloCandidatoFactura[]> {
    await this.asegurarDisponible();
    const cols = `id, folio, fecha_vuelo, estado, cliente_id, monto_total_usd, monto_total_mxn, tc_usd_mxn, facturado, ${COLS_SOLICITUD_FACTURA}, cliente:cliente_id(nombre, rfc), grupo:grupo_id(id, folio, nombre)`;
    type Fila = VueloSolicitudRow & {
      id: string;
      folio: number;
      fecha_vuelo: string | null;
      estado: string;
      cliente_id: string | null;
      monto_total_usd: unknown;
      monto_total_mxn: unknown;
      tc_usd_mxn: unknown;
      cliente: unknown;
      grupo: unknown;
    };
    const LIMITE = 20;
    let filas: Fila[] = [];
    let conQ = false;
    const base = () => this.sb.from('vuelo').select(cols);
    const leer = async (
      consulta: PromiseLike<{
        data: unknown;
        error: { message: string } | null;
      }>,
    ): Promise<Fila[]> => {
      const { data, error } = await consulta;
      if (error) throw new Error(error.message);
      return (data ?? []) as Fila[];
    };

    if (query.ids) {
      const ids = query.ids
        .split(',')
        .map((s) => s.trim())
        .filter((s) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            s,
          ),
        )
        .slice(0, 50);
      filas = ids.length > 0 ? await leer(base().in('id', ids)) : [];
    } else if (query.grupo_id) {
      filas = await leer(
        base()
          .eq('grupo_id', query.grupo_id)
          .neq('estado', 'CANCELADO')
          .order('fecha_vuelo', { ascending: false, nullsFirst: false })
          .limit(50),
      );
    } else {
      const b = interpretarBusquedaVuelo(query.q, hoyCancun());
      if (b.tipo === 'vacia') {
        const [pendientes, recientes] = await Promise.all([
          this.vuelosConSolicitud<Fila>(cols),
          leer(
            base()
              .neq('estado', 'CANCELADO')
              .order('fecha_vuelo', { ascending: false, nullsFirst: false })
              .limit(LIMITE),
          ),
        ]);
        const ligadasP = await this.solicitud.ligadasDeVuelos(
          pendientes.map((v) => v.id),
        );
        const porFacturar = pendientes
          .filter(
            (v) =>
              v.facturado !== true &&
              esPorFacturar(
                v,
                (ligadasP.get(v.id) ?? []).filter(
                  (f) => f.estatus === 'VIGENTE',
                ).length,
              ),
          )
          .sort((a, b) =>
            (a.factura_solicitada_at ?? '') < (b.factura_solicitada_at ?? '')
              ? -1
              : 1,
          );
        const vistos = new Set(porFacturar.map((v) => v.id));
        filas = [
          ...porFacturar,
          ...recientes.filter((v) => !vistos.has(v.id)),
        ].slice(0, LIMITE);
      } else {
        conQ = true;
        if (b.tipo === 'folio') {
          filas = await leer(base().eq('folio', b.folio).limit(LIMITE));
        } else if (b.tipo === 'dia') {
          filas = await leer(
            base()
              .gte('fecha_vuelo', `${b.dia}T00:00:00-05:00`)
              .lte('fecha_vuelo', `${b.dia}T23:59:59-05:00`)
              .order('fecha_vuelo', { ascending: false, nullsFirst: false })
              .limit(LIMITE),
          );
        } else {
          const pat = patronIlikeSeguro(b.texto);
          const { data: clientes, error } = await this.sb
            .from('cliente')
            .select('id')
            .or(`nombre.ilike.%${pat}%,razon_social_default.ilike.%${pat}%`)
            .limit(50);
          if (error) throw new Error(error.message);
          const idsCli = ((clientes ?? []) as Array<{ id: string }>).map(
            (c) => c.id,
          );
          filas =
            idsCli.length > 0
              ? await leer(
                  base()
                    .in('cliente_id', idsCli)
                    .order('fecha_vuelo', {
                      ascending: false,
                      nullsFirst: false,
                    })
                    .limit(LIMITE * 2),
                )
              : [];
        }
      }
    }
    if (conQ) {
      // Con búsqueda, los cancelados SÍ salen (el cargo por cancelación
      // también se factura) pero al final.
      filas = [
        ...filas.filter((v) => v.estado !== 'CANCELADO'),
        ...filas.filter((v) => v.estado === 'CANCELADO'),
      ].slice(0, LIMITE);
    }
    const ids = filas.map((v) => v.id);
    const grupoIds = filas
      .map((v) => unwrap(v.grupo as { id: string } | null)?.id)
      .filter((x): x is string => !!x);
    const [ligadas, conteoGrupos] = await Promise.all([
      this.solicitud.ligadasDeVuelos(ids),
      this.avionesPorGrupo(grupoIds),
    ]);
    return filas.map((v) => {
      const cli = unwrap(v.cliente as { nombre?: string; rfc?: string } | null);
      const vig = (ligadas.get(v.id) ?? []).filter(
        (f) => f.estatus === 'VIGENTE',
      );
      return {
        id: v.id,
        folio: Number(v.folio),
        fecha_vuelo: v.fecha_vuelo ?? null,
        estado: v.estado,
        cliente_id: v.cliente_id ?? '',
        cliente_nombre: cli?.nombre ?? null,
        cliente_rfc: cli?.rfc ?? null,
        total: totalVueloDe(v),
        facturas_vigentes: vig.map((f) => etiquetaFactura(f.serie, f.folio)),
        solicitud: esPorFacturar(v, vig.length),
        grupo: this.grupoDe(v.grupo, conteoGrupos),
      };
    });
  }

  // ======================================================================
  // ARCHIVOS: validación y subida
  // ======================================================================

  /** Valida el archivo del campo `pdf` o `xml` (null = no vino). */
  private validarCampoArchivo(
    file: ArchivoMultipart | undefined,
    campo: TipoArchivo,
  ): ArchivoValido | null {
    if (!file) return null;
    const buffer = file.buffer ?? Buffer.alloc(0);
    const v = validarArchivoFactura({
      nombre: file.originalname,
      mime: file.mimetype,
      bytes: buffer.length,
    });
    if (!v.ok) {
      const cuerpo = { message: v.mensaje, error: v.codigo };
      if (v.codigo === 'ARCHIVO_MUY_GRANDE') {
        throw new PayloadTooLargeException({
          ...cuerpo,
          details: {
            bytes: buffer.length,
            limite_bytes: LIMITE_ARCHIVO_FACTURA_BYTES,
          },
        });
      }
      throw new BadRequestException(cuerpo);
    }
    const esPdfReal = buffer
      .subarray(0, 1024)
      .toString('latin1')
      .includes('%PDF-');
    if (v.extension !== campo || (campo === 'pdf' && !esPdfReal)) {
      throw new BadRequestException({
        message:
          campo === 'pdf'
            ? 'En «PDF» va el PDF de la factura'
            : 'En «XML» va el XML del CFDI',
        error: 'ARCHIVO_TIPO_INVALIDO',
        details: { campo, nombre: v.nombre },
      });
    }
    return { buffer, nombre: v.nombre, extension: campo };
  }

  private archivosDe(files: ArchivosFactura | undefined): {
    pdf: ArchivoValido | null;
    xml: ArchivoValido | null;
  } {
    return {
      pdf: this.validarCampoArchivo(files?.pdf?.[0], 'pdf'),
      xml: this.validarCampoArchivo(files?.xml?.[0], 'xml'),
    };
  }

  /** CFDI del XML con las defensas (DOCTYPE ⇒ 422; ilegible ⇒ 422). */
  private leerXmlObligatorio(xml: ArchivoValido): CfdiCompleto {
    if (xmlDeclaraDoctype(xml.buffer)) {
      throw new UnprocessableEntityException({
        message:
          'Ese XML declara un DOCTYPE/ENTITY y no se acepta por seguridad. Descarga el XML original del CFDI.',
        error: 'XML_NO_PERMITIDO',
      });
    }
    const cfdi = extraerCfdiCompleto(xml.buffer);
    if (!cfdi) {
      throw new UnprocessableEntityException({
        message: 'Ese XML no es un CFDI legible.',
        error: 'XML_ILEGIBLE',
      });
    }
    return cfdi;
  }

  private async subirArchivos(
    facturaId: string,
    archivos: ArchivoValido[],
  ): Promise<ArchivoSubido[]> {
    const subidos: ArchivoSubido[] = [];
    for (const a of archivos) {
      const path = `emitidas/${facturaId}/${randomUUID()}.${a.extension}`;
      const { error } = await this.sb.storage
        .from(BUCKET_FACTURAS)
        .upload(path, a.buffer, {
          contentType:
            a.extension === 'pdf' ? 'application/pdf' : 'application/xml',
          upsert: false,
        });
      if (error) {
        await this.borrarRecienSubidos(subidos.map((s) => s.path));
        throw new Error(
          `No se pudo guardar el archivo de la factura: ${error.message}`,
        );
      }
      subidos.push({ tipo: a.extension, path, nombre: a.nombre });
    }
    return subidos;
  }

  /**
   * ÚNICO `storage.remove` del módulo: lo RECIÉN subido de una operación que
   * FALLÓ (nunca referenciado). Un archivo que alguna vez quedó en una fila
   * NUNCA se borra (se desreferencia a `archivos_historial`).
   */
  private async borrarRecienSubidos(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.sb.storage.from(BUCKET_FACTURAS).remove(paths);
    if (error) {
      this.logger.warn(
        `No se pudo retirar ${paths.join(', ')} (operación fallida): ${error.message}`,
      );
    }
  }

  // ======================================================================
  // DATOS: parseo, validación y normalización
  // ======================================================================

  private async parsearDatos(
    datosJson: string,
    alta: boolean,
  ): Promise<{
    datos: DatosNormalizados;
    traeEmisora: boolean;
    traeCliente: boolean;
  }> {
    let raw: unknown;
    try {
      raw = JSON.parse(datosJson);
    } catch {
      throw new BadRequestException({
        message: 'El JSON de la factura no se pudo leer',
        error: 'DATOS_INVALIDOS',
        details: { errores: ['El JSON de la factura no se pudo leer'] },
      });
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException({
        message: 'El JSON de la factura no se pudo leer',
        error: 'DATOS_INVALIDOS',
        details: {
          errores: ['Se esperaba un objeto con los datos de la factura'],
        },
      });
    }
    const obj = { ...(raw as Record<string, unknown>) };
    // "" ⇒ null en los opcionales de texto (el panel manda vacíos).
    for (const k of CAMPOS_NULLABLES_TEXTO) {
      if (typeof obj[k] === 'string' && obj[k].trim() === '') {
        obj[k] = null;
      }
    }
    const dto = plainToInstance(FacturaEmitidaDatosDto, obj);
    const errores = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const mensajes = mensajeErrores(errores);
    const d = dto;
    const tiene = (k: string) => Object.prototype.hasOwnProperty.call(obj, k);

    const datos: DatosNormalizados = {};
    if (tiene('serie')) datos.serie = normalizarSerie(d.serie);
    if (tiene('folio')) {
      const folio = normalizarFolio(d.folio);
      if (!folio) mensajes.push('El folio no puede ir vacío');
      else if (folio.length > 40)
        mensajes.push('El folio no puede pasar de 40 caracteres');
      else datos.folio = folio;
    }
    if (tiene('uuid')) {
      const uuid = normalizarUuidEntrada(d.uuid);
      if (uuid && !RE_UUID_FISCAL.test(uuid)) {
        mensajes.push(
          'El folio fiscal (UUID) debe tener el formato 8-4-4-4-12',
        );
      } else datos.uuid = uuid;
    }
    if (tiene('fecha_emision') && d.fecha_emision) {
      const dt = new Date(`${d.fecha_emision}T12:00:00Z`);
      if (
        Number.isNaN(dt.getTime()) ||
        dt.toISOString().slice(0, 10) !== d.fecha_emision
      ) {
        mensajes.push('La fecha de emisión no es una fecha válida');
      } else datos.fecha_emision = d.fecha_emision;
    }
    const rfcs: Array<'emisor_rfc' | 'receptor_rfc'> = [
      'emisor_rfc',
      'receptor_rfc',
    ];
    const rfcInvalidos: string[] = [];
    for (const k of rfcs) {
      if (!tiene(k)) continue;
      const r = normalizarRfc(d[k]);
      if (r && !RE_RFC.test(r)) rfcInvalidos.push(r);
      else datos[k] = r;
    }
    if (tiene('emisor_nombre'))
      datos.emisor_nombre = textoONull(d.emisor_nombre);
    if (tiene('receptor_nombre'))
      datos.receptor_nombre = textoONull(d.receptor_nombre);
    if (tiene('emisora_id')) datos.emisora_id = d.emisora_id ?? null;
    if (tiene('cliente_id')) datos.cliente_id = d.cliente_id ?? null;
    if (tiene('moneda') && d.moneda) datos.moneda = d.moneda;
    if (tiene('subtotal')) {
      datos.subtotal =
        d.subtotal == null ? null : redondear2(Number(d.subtotal));
    }
    if (tiene('iva'))
      datos.iva = d.iva == null ? null : redondear2(Number(d.iva));
    if (tiene('total') && d.total != null) {
      const t = redondear2(Number(d.total));
      if (!(t > 0)) mensajes.push('El total debe ser mayor a 0');
      else datos.total = t;
    }
    if (tiene('metodo_pago')) datos.metodo_pago = d.metodo_pago ?? null;
    if (tiene('forma_pago')) datos.forma_pago = d.forma_pago ?? null;
    // Notas: solo se recortan los extremos — `textoONull` colapsa TODO
    // espacio y convertía una nota de varios renglones en una sola línea.
    if (tiene('notas')) {
      datos.notas = typeof d.notas === 'string' ? d.notas.trim() || null : null;
    }
    if (tiene('es_parcial') && d.es_parcial != null)
      datos.es_parcial = d.es_parcial === true;
    if (tiene('vuelo_ids') && Array.isArray(d.vuelo_ids)) {
      datos.vuelo_ids = [...new Set(d.vuelo_ids)];
    }

    if (alta) {
      if (!datos.folio && !mensajes.some((m) => m.startsWith('El folio'))) {
        mensajes.push('Falta el folio');
      }
      if (!datos.fecha_emision && !mensajes.some((m) => m.includes('fecha'))) {
        mensajes.push('Falta la fecha de emisión');
      }
      if (!datos.moneda) mensajes.push('Falta la moneda (MXN o USD)');
      if (
        datos.total == null &&
        !mensajes.some((m) => m.startsWith('El total'))
      ) {
        mensajes.push('Falta el total');
      }
    }
    if (mensajes.length > 0) {
      throw new BadRequestException({
        message: `Revisa los datos de la factura: ${mensajes.join('; ')}.`,
        error: 'DATOS_INVALIDOS',
        details: { errores: mensajes },
      });
    }
    if (rfcInvalidos.length > 0) {
      throw new BadRequestException({
        message: `El RFC ${rfcInvalidos.join(', ')} no tiene un formato válido (3–4 letras, 6 dígitos y 3 caracteres).`,
        error: 'RFC_INVALIDO',
        details: { rfcs: rfcInvalidos },
      });
    }
    return {
      datos,
      traeEmisora: tiene('emisora_id'),
      traeCliente: tiene('cliente_id') && datos.cliente_id != null,
    };
  }

  /** 422 XML_NO_CUADRA si el XML es de OTRA factura (uuid o número). */
  private verificarXmlCuadra(
    cfdi: CfdiCompleto,
    factura: {
      uuid?: string | null;
      serie?: string | null;
      folio?: string | null;
    },
  ): void {
    const uuidFactura = (factura.uuid ?? '').toUpperCase();
    if (cfdi.uuid && uuidFactura && cfdi.uuid !== uuidFactura) {
      throw new UnprocessableEntityException({
        message: `El XML es del folio fiscal ${cfdi.uuid} y estás registrando el ${uuidFactura}. Revisa que sea el archivo correcto.`,
        error: 'XML_NO_CUADRA',
        details: { campo: 'uuid', en_xml: cfdi.uuid, en_factura: uuidFactura },
      });
    }
    if (cfdi.folio && factura.folio) {
      const enXml = claveCompacta(cfdi.serie, cfdi.folio);
      const enFactura = claveCompacta(factura.serie, factura.folio);
      if (enXml !== enFactura) {
        const eXml = etiquetaFactura(cfdi.serie, cfdi.folio);
        const eFac = etiquetaFactura(factura.serie ?? null, factura.folio);
        throw new UnprocessableEntityException({
          message: `El XML es de la factura ${eXml} y estás registrando la ${eFac}. Revisa que sea el archivo correcto.`,
          error: 'XML_NO_CUADRA',
          details: { campo: 'folio', en_xml: eXml, en_factura: eFac },
        });
      }
    }
  }

  /** Vuelos a ligar (con lo necesario para avisos/efectos); 400 si falta alguno. */
  private async vuelosParaLigar(
    ids: string[],
  ): Promise<Map<string, VueloParaLigar>> {
    const out = new Map<string, VueloParaLigar>();
    for (const lote of enLotes(ids)) {
      const { data, error } = await this.sb
        .from('vuelo')
        .select(COLS_VUELO_PARA_LIGAR)
        .in('id', lote);
      if (error) throw new Error(error.message);
      for (const v of (data ?? []) as unknown as VueloParaLigar[]) {
        out.set(v.id, {
          ...v,
          folio: Number(v.folio),
          cliente: unwrap(
            v.cliente as
              | VueloParaLigar['cliente']
              | VueloParaLigar['cliente'][],
          ),
        });
      }
    }
    const faltan = ids.filter((id) => !out.has(id));
    if (faltan.length > 0) {
      throw new BadRequestException({
        message:
          faltan.length === 1
            ? 'Uno de los vuelos elegidos ya no existe. Quítalo y vuelve a intentar.'
            : `${faltan.length} de los vuelos elegidos ya no existen. Quítalos y vuelve a intentar.`,
        error: 'VUELOS_NO_EXISTEN',
        details: { ids: faltan },
      });
    }
    return out;
  }

  /** Candidatos de duplicado (no borradas) por número y/o UUID. */
  private async candidatosDuplicado(p: {
    uuid?: string | null;
    serie?: string | null;
    folio?: string | null;
  }): Promise<
    Array<CandidatoDuplicado & { estatus: string; fecha_emision: string }>
  > {
    const cols = 'id, serie, folio, uuid, emisora_id, estatus, fecha_emision';
    const out = new Map<
      string,
      CandidatoDuplicado & { estatus: string; fecha_emision: string }
    >();
    const consultas: Array<
      PromiseLike<{ data: unknown; error: { message: string } | null }>
    > = [];
    if (p.folio) {
      const soloDigitos = (s: string) =>
        s.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
      // `folio_num` (columna generada) = TODOS los dígitos del FOLIO. Una
      // serie con dígitos («F1» + «23») y la misma factura capturada sin
      // serie («F1-23», folio_num 123) solo se encuentran por los dígitos de
      // la CLAVE COMPACTA (y, al revés, por el ÚLTIMO tramo de dígitos del
      // folio: «F1-23» ⇒ 23); sin eso el 409 no veía el duplicado y lo
      // dejaba entrar (la BD tampoco: su índice es por serie+folio EXACTOS).
      // El filtro exacto sigue siendo `claveCompacta` en JS.
      const tramos = p.folio.match(/\d+/g) ?? [];
      const sufijos = tramos
        .slice(-4)
        .map((_, i, arr) => soloDigitos(arr.slice(i).join('')));
      const numeros = new Set(
        [
          soloDigitos(p.folio),
          soloDigitos(claveCompacta(p.serie ?? null, p.folio)),
          ...sufijos,
        ].filter((d) => d !== ''),
      );
      const conds = [`folio.ilike.${patronIlikeSeguro(p.folio)}`];
      for (const n of numeros) conds.push(`folio_num.eq.${n}`);
      consultas.push(
        this.sb
          .from('factura_emitida')
          .select(cols)
          .is('deleted_at', null)
          .or(conds.join(','))
          .limit(500),
      );
    }
    if (p.uuid) {
      consultas.push(
        this.sb
          .from('factura_emitida')
          .select(cols)
          .is('deleted_at', null)
          .eq('uuid', p.uuid.toUpperCase())
          .limit(10),
      );
    }
    for (const r of await Promise.all(consultas)) {
      if (r.error) throw new Error(r.error.message);
      for (const f of (r.data ?? []) as Array<
        CandidatoDuplicado & { estatus: string; fecha_emision: string }
      >) {
        out.set(f.id, f);
      }
    }
    return [...out.values()];
  }

  /** Folios de los vuelos ligados a una factura (para «ya registrada»). */
  private async vuelosDeFactura(
    facturaId: string,
  ): Promise<Array<{ id: string; folio: number }>> {
    const { data, error } = await this.sb
      .from('factura_emitida_vuelo')
      .select('vuelo_id, vuelo:vuelo_id(id, folio)')
      .eq('factura_id', facturaId);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<Record<string, unknown>>)
      .map((l) => unwrap(l.vuelo as { id: string; folio: unknown } | null))
      .filter((v): v is { id: string; folio: unknown } => !!v)
      .map((v) => ({ id: v.id, folio: Number(v.folio) }));
  }

  /** «Ya está registrada» (misma regla para 409 y leer-archivo). */
  private async yaRegistrada(p: {
    uuid?: string | null;
    serie?: string | null;
    folio?: string | null;
    emisora_id?: string | null;
    excluirId?: string | null;
  }): Promise<{ tipo: 'UUID' | 'FOLIO'; existente: FacturaExistente } | null> {
    const candidatos = await this.candidatosDuplicado({
      uuid: p.uuid,
      serie: p.serie,
      folio: p.folio,
    });
    const hit = buscarYaRegistrada(candidatos, p);
    if (!hit) return null;
    const vuelos = await this.vuelosDeFactura(hit.fila.id);
    return { tipo: hit.tipo, existente: facturaExistenteDe(hit.fila, vuelos) };
  }

  private conflictoDuplicado(
    tipo: 'UUID' | 'FOLIO',
    existente: FacturaExistente,
  ): ConflictException {
    return new ConflictException({
      message: existente.mensaje,
      error: tipo === 'UUID' ? 'UUID_DUPLICADO' : 'FACTURA_DUPLICADA',
      details: { existente },
    });
  }

  /** ¿El error de Postgres es la violación de un índice único nuestro? */
  private indiceUnicoViolado(err: {
    code?: string;
    message?: string;
    details?: string;
  }): 'FOLIO' | 'UUID' | null {
    if (err.code !== '23505') return null;
    const txt = `${err.message ?? ''} ${err.details ?? ''}`;
    if (txt.includes('uq_factura_emitida_uuid')) return 'UUID';
    if (txt.includes('uq_factura_emitida_serie_folio')) return 'FOLIO';
    return null;
  }

  // ======================================================================
  // AVISOS Y EFECTOS
  // ======================================================================

  /** Otras VIGENTES (no borradas) por vuelo, excluyendo `excluirId`. */
  private async otrasVigentesPorVuelo(
    vueloIds: string[],
    excluirId: string,
  ): Promise<Map<string, string[]>> {
    const ligadas = await this.solicitud.ligadasDeVuelos(vueloIds);
    const out = new Map<string, string[]>();
    for (const [vid, fs] of ligadas) {
      const otras = fs
        .filter((f) => f.id !== excluirId && f.estatus === 'VIGENTE')
        .map((f) => etiquetaFactura(f.serie, f.folio));
      if (otras.length > 0) out.set(vid, otras);
    }
    return out;
  }

  private async avisosDeGuardado(p: {
    id: string;
    estatus: string;
    etiqueta: string;
    es_parcial: boolean;
    moneda: MonedaFactura;
    total: number;
    receptor_rfc: string | null;
    vuelos: VueloParaLigar[];
    avisosEmisor: AvisoFactura[];
  }): Promise<AvisoFactura[]> {
    const avisos: AvisoFactura[] = [...p.avisosEmisor];
    if (p.estatus === 'VIGENTE' && p.vuelos.length > 0) {
      try {
        const otras = await this.otrasVigentesPorVuelo(
          p.vuelos.map((v) => v.id),
          p.id,
        );
        for (const v of p.vuelos) {
          const o = otras.get(v.id);
          if (!o) continue;
          const lista =
            o.length === 1
              ? `la factura ${o[0]} vigente`
              : `las facturas ${o.slice(0, -1).join(', ')} y ${o[o.length - 1]} vigentes`;
          avisos.push({
            code: 'VUELO_CON_OTRA_FACTURA',
            mensaje: `El vuelo #${v.folio} ya tiene ${lista}. Si es anticipo y finiquito está bien; si es una re-emisión, cancela la anterior.`,
            details: { vuelo_id: v.id, folio: v.folio, otras: o },
          });
        }
      } catch (e) {
        this.logger.warn(
          `No se pudieron revisar otras facturas vigentes: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (p.receptor_rfc) {
      for (const v of p.vuelos) {
        const rfcCliente = normalizarRfc(v.cliente?.rfc ?? null);
        if (rfcCliente && rfcCliente !== p.receptor_rfc) {
          avisos.push({
            code: 'RECEPTOR_DISTINTO_CLIENTE',
            mensaje: `El RFC receptor (${p.receptor_rfc}) no coincide con el RFC del cliente del vuelo #${v.folio} (${rfcCliente}).`,
            details: {
              vuelo_id: v.id,
              folio: v.folio,
              receptor_rfc: p.receptor_rfc,
              cliente_rfc: rfcCliente,
            },
          });
        }
      }
    }
    const total = avisoTotalDistintoVuelo({
      estatus: p.estatus,
      es_parcial: p.es_parcial,
      moneda: p.moneda,
      total: p.total,
      etiqueta: p.etiqueta,
      vuelos: p.vuelos,
    });
    if (total) avisos.push(total);
    return avisos;
  }

  /**
   * Efectos de ligar una factura VIGENTE a vuelos NUEVOS (best-effort, jamás
   * tumban la respuesta): (a) `factura_estatus` SIN_FACTURA ⇒ FACTURADO con
   * CAS (nunca baja; no es columna del trigger de Google, no encola nada);
   * (b) aviso `factura_emitida` a quien pidió la factura (≠ actor), UNO por
   * persona aunque la factura cubra varios de sus vuelos.
   */
  private async efectosDeLigar(
    factura: { id: string; etiqueta: string },
    vuelos: VueloParaLigar[],
    actor: ActorFactura,
  ): Promise<void> {
    if (vuelos.length === 0) return;
    try {
      const { error } = await this.sb
        .from('vuelo')
        .update({ factura_estatus: 'FACTURADO', updated_by: actor.userId })
        .in(
          'id',
          vuelos.map((v) => v.id),
        )
        .eq('factura_estatus', 'SIN_FACTURA');
      if (error) throw new Error(error.message);
    } catch (e) {
      this.logger.warn(
        `Factura ${factura.etiqueta} ligada, pero no se pudo marcar FACTURADO: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      const porPersona = new Map<string, VueloParaLigar[]>();
      for (const v of vuelos) {
        const quien = v.factura_solicitada_at ? v.factura_solicitada_por : null;
        if (!quien || quien === actor.userId) continue;
        (porPersona.get(quien) ?? porPersona.set(quien, []).get(quien)!).push(
          v,
        );
      }
      if (porPersona.size === 0) return;
      const actorNombre =
        (actor.nombre ?? '').trim() ||
        (await fetchNombresUsuarios(this.sb, [actor.userId])).get(
          actor.userId,
        ) ||
        'Facturación';
      for (const [usuarioId, vs] of porPersona) {
        const ordenados = [...vs].sort((a, b) => a.folio - b.folio);
        const primero = ordenados[0];
        const { titulo, cuerpo } = textoAvisoEmitida({
          actor: actorNombre,
          etiqueta: factura.etiqueta,
          folios: ordenados.map((v) => v.folio),
          cliente: primero.cliente?.nombre ?? null,
        });
        await this.notifications.notifyUser(usuarioId, {
          tipo: 'factura_emitida',
          titulo,
          cuerpo,
          link: `/admin/quotes/${primero.id}#cobros-vuelo`,
          data: {
            vuelo_id: primero.id,
            folio: primero.folio,
            factura_id: factura.id,
          },
        });
      }
    } catch (e) {
      this.logger.warn(
        `Factura ${factura.etiqueta} ligada, pero el aviso a quien la pidió falló: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * `VUELO_SIGUE_FACTURADO`: tras cancelar/eliminar, cada vuelo que queda SIN
   * factura VIGENTE, con estatus manual «Facturado» y sin CFDI del PAC. El
   * estatus NO se baja solo (y la solicitud, si había, vuelve sola a «Por
   * facturar» por derivación, sin avisar a nadie).
   */
  private async avisosSigueFacturado(
    facturaId: string,
  ): Promise<AvisoFactura[]> {
    try {
      const vuelosIds = (await this.vuelosDeFactura(facturaId)).map(
        (v) => v.id,
      );
      if (vuelosIds.length === 0) return [];
      const [otras, vuelos] = await Promise.all([
        this.otrasVigentesPorVuelo(vuelosIds, facturaId),
        this.vuelosParaLigar(vuelosIds).catch(
          () => new Map<string, VueloParaLigar>(),
        ),
      ]);
      const avisos: AvisoFactura[] = [];
      for (const v of vuelos.values()) {
        if (otras.has(v.id)) continue;
        if (v.factura_estatus !== 'FACTURADO' || v.facturado === true) continue;
        avisos.push({
          code: 'VUELO_SIGUE_FACTURADO',
          mensaje: `El vuelo #${v.folio} se queda sin factura vigente y sigue marcado «Facturado». Si la vas a volver a emitir, regístrala; si no, cambia el estatus en el vuelo.`,
          details: { vuelo_id: v.id, folio: v.folio },
        });
      }
      return avisos.sort(
        (a, b) => Number(a.details?.folio ?? 0) - Number(b.details?.folio ?? 0),
      );
    } catch (e) {
      this.logger.warn(
        `No se pudo revisar el estatus de los vuelos de la factura ${facturaId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
  }

  /** Emisora: explícita (llave presente, aunque sea null) > detectada > null. */
  private async resolverEmisora(
    datos: DatosNormalizados,
    traeEmisora: boolean,
    emisorRfc: string | null,
    emisorNombre: string | null,
  ): Promise<{ emisoraId: string | null; avisos: AvisoFactura[] }> {
    const emisoras = await this.cargarEmisoras();
    const ver = verificarEmisor(emisorRfc, emisorNombre, emisoras);
    if (traeEmisora) {
      const id = datos.emisora_id ?? null;
      if (id && !emisoras.some((e) => e.id === id)) {
        throw new BadRequestException({
          message: 'La razón social elegida no existe.',
          error: 'EMISORA_NO_EXISTE',
          details: { emisora_id: id },
        });
      }
      // Elegida a mano y coincide con lo leído: sin avisos de emisor.
      const avisos = id && ver.emisora?.id === id ? [] : ver.avisos;
      return { emisoraId: id, avisos };
    }
    return { emisoraId: ver.emisora?.id ?? null, avisos: ver.avisos };
  }

  /**
   * El `cliente_id` EXPLÍCITO tiene que existir ANTES de subir nada: si no,
   * el INSERT/UPDATE reventaba con la FK (23503) ⇒ 500 genérico, y el
   * archivo recién subido quedaba por limpiar. 400 claro en su lugar.
   */
  private async asegurarClienteExiste(clienteId: string): Promise<void> {
    const { data, error } = await this.sb
      .from('cliente')
      .select('id')
      .eq('id', clienteId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new BadRequestException({
        message:
          'El cliente elegido ya no existe. Elige otro cliente y vuelve a intentar.',
        error: 'CLIENTE_NO_EXISTE',
        details: { cliente_id: clienteId },
      });
    }
  }

  /** Cliente: explícito > único cliente de los vuelos > RFC receptor único. */
  private async resolverCliente(
    explicito: string | null | undefined,
    vuelos: VueloParaLigar[],
    receptorRfc: string | null,
  ): Promise<string | null> {
    if (explicito) return explicito;
    const deVuelos = [
      ...new Set(
        vuelos.map((v) => v.cliente_id).filter((x): x is string => !!x),
      ),
    ];
    if (deVuelos.length === 1) return deVuelos[0];
    if (receptorRfc) {
      const { data, error } = await this.sb
        .from('cliente')
        .select('id')
        .eq('activo', true)
        .ilike('rfc', receptorRfc)
        .limit(2);
      if (!error && data && data.length === 1) return data[0].id as string;
    }
    return null;
  }

  // ======================================================================
  // ALTA
  // ======================================================================

  /** `POST /v1/facturas-emitidas` (multipart: `datos` + `pdf`/`xml`). */
  async crear(
    datosJson: string,
    files: ArchivosFactura | undefined,
    actor: ActorFactura,
  ): Promise<ResultadoGuardarFactura> {
    // 1) Sonda.
    await this.asegurarDisponible();
    // 2) Datos + archivos.
    const { datos, traeEmisora, traeCliente } = await this.parsearDatos(
      datosJson,
      true,
    );
    const { pdf, xml } = this.archivosDe(files);
    // 3) XML: defensas y que cuadre con lo capturado.
    if (xml) {
      const cfdi = this.leerXmlObligatorio(xml);
      this.verificarXmlCuadra(cfdi, datos);
      if (!datos.uuid && cfdi.uuid) datos.uuid = cfdi.uuid;
    }
    // 4) Vuelos (y el cliente explícito, que también es FK).
    const vueloIds = datos.vuelo_ids ?? [];
    const vuelos = await this.vuelosParaLigar(vueloIds);
    if (traeCliente && datos.cliente_id) {
      await this.asegurarClienteExiste(datos.cliente_id);
    }
    // 4b) Emisora (es parte del número: ANTES de buscar duplicados).
    const { emisoraId, avisos: avisosEmisor } = await this.resolverEmisora(
      datos,
      traeEmisora,
      datos.emisor_rfc ?? null,
      datos.emisor_nombre ?? null,
    );
    // 5) Duplicados ANTES de subir nada.
    const dup = await this.yaRegistrada({
      uuid: datos.uuid,
      serie: datos.serie,
      folio: datos.folio,
      emisora_id: emisoraId,
    });
    if (dup) throw this.conflictoDuplicado(dup.tipo, dup.existente);
    // 6) Archivos al bucket.
    const id = randomUUID();
    const subidos = await this.subirArchivos(
      id,
      [pdf, xml].filter((a): a is ArchivoValido => !!a),
    );
    // 7) Cliente.
    const listaVuelos = vueloIds.map((v) => vuelos.get(v)!);
    const clienteId = await this.resolverCliente(
      traeCliente ? datos.cliente_id : null,
      listaVuelos,
      datos.receptor_rfc ?? null,
    );
    // 8) INSERT.
    const ahora = new Date().toISOString();
    const archivoPdf = subidos.find((s) => s.tipo === 'pdf');
    const archivoXml = subidos.find((s) => s.tipo === 'xml');
    const fila = {
      id,
      serie: datos.serie ?? null,
      folio: datos.folio!,
      uuid: datos.uuid ?? null,
      fecha_emision: datos.fecha_emision!,
      estatus: 'VIGENTE',
      emisor_rfc: datos.emisor_rfc ?? null,
      emisor_nombre: datos.emisor_nombre ?? null,
      emisora_id: emisoraId,
      receptor_rfc: datos.receptor_rfc ?? null,
      receptor_nombre: datos.receptor_nombre ?? null,
      cliente_id: clienteId,
      moneda: datos.moneda!,
      subtotal: datos.subtotal ?? null,
      iva: datos.iva ?? null,
      total: datos.total!,
      metodo_pago: datos.metodo_pago ?? null,
      forma_pago: datos.forma_pago ?? null,
      notas: datos.notas ?? null,
      es_parcial: datos.es_parcial === true,
      pdf_path: archivoPdf?.path ?? null,
      pdf_nombre: archivoPdf?.nombre ?? null,
      pdf_subido_at: archivoPdf ? ahora : null,
      pdf_subido_por: archivoPdf ? actor.userId : null,
      xml_path: archivoXml?.path ?? null,
      xml_nombre: archivoXml?.nombre ?? null,
      xml_subido_at: archivoXml ? ahora : null,
      xml_subido_por: archivoXml ? actor.userId : null,
      created_by: actor.userId,
      updated_by: actor.userId,
    };
    const { error: insErr } = await this.sb
      .from('factura_emitida')
      .insert(fila);
    if (insErr) {
      await this.borrarRecienSubidos(subidos.map((s) => s.path));
      const indice = this.indiceUnicoViolado(insErr);
      if (indice) {
        const carrera = await this.yaRegistrada({
          uuid: indice === 'UUID' ? datos.uuid : null,
          serie: datos.serie,
          folio: indice === 'FOLIO' ? datos.folio : null,
          emisora_id: emisoraId,
        });
        if (carrera)
          throw this.conflictoDuplicado(carrera.tipo, carrera.existente);
        throw new ConflictException({
          message: 'Esa factura ya está registrada.',
          error: indice === 'UUID' ? 'UUID_DUPLICADO' : 'FACTURA_DUPLICADA',
        });
      }
      throw new Error(insErr.message);
    }
    // 9) Puente.
    if (vueloIds.length > 0) {
      const { error: puenteErr } = await this.sb
        .from('factura_emitida_vuelo')
        .insert(
          vueloIds.map((v) => ({
            factura_id: id,
            vuelo_id: v,
            created_by: actor.userId,
          })),
        );
      if (puenteErr) {
        // Sin ligas la factura quedaría a medias: se deshace TODO.
        await this.sb.from('factura_emitida').delete().eq('id', id);
        await this.borrarRecienSubidos(subidos.map((s) => s.path));
        throw new Error(
          `No se pudieron ligar los vuelos a la factura: ${puenteErr.message}`,
        );
      }
    }
    const etiqueta = etiquetaFactura(fila.serie, fila.folio);
    // 10) Efectos (best-effort).
    await this.efectosDeLigar({ id, etiqueta }, listaVuelos, actor);
    // 11) Respuesta con avisos.
    const avisos = await this.avisosDeGuardado({
      id,
      estatus: 'VIGENTE',
      etiqueta,
      es_parcial: fila.es_parcial,
      moneda: fila.moneda,
      total: fila.total,
      receptor_rfc: fila.receptor_rfc,
      vuelos: listaVuelos,
      avisosEmisor,
    });
    return { factura: await this.facturaCompleta(id), avisos };
  }

  // ======================================================================
  // EDICIÓN
  // ======================================================================

  /** Entrada de `archivos_historial` para el archivo que sale. */
  private entradaHistorial(
    f: FacturaEmitidaRow,
    tipo: TipoArchivo,
    accion: 'QUITADO' | 'REEMPLAZADO',
    userId: string,
  ): Record<string, unknown> | null {
    const path = tipo === 'pdf' ? f.pdf_path : f.xml_path;
    if (!path) return null;
    return {
      tipo,
      path,
      nombre: tipo === 'pdf' ? f.pdf_nombre : f.xml_nombre,
      subido_at: tipo === 'pdf' ? f.pdf_subido_at : f.xml_subido_at,
      quitado_at: new Date().toISOString(),
      quitado_por: userId,
      accion,
    };
  }

  private historialDe(f: FacturaRowLike): Record<string, unknown>[] {
    return Array.isArray(f.archivos_historial)
      ? (f.archivos_historial as Record<string, unknown>[])
      : [];
  }

  /** Patch de columnas para archivos NUEVOS (los viejos van al historial). */
  private patchArchivos(
    f: FacturaEmitidaRow,
    subidos: ArchivoSubido[],
    userId: string,
  ): Record<string, unknown> {
    if (subidos.length === 0) return {};
    const ahora = new Date().toISOString();
    const historial = [...this.historialDe(f)];
    const patch: Record<string, unknown> = {};
    for (const s of subidos) {
      const salida = this.entradaHistorial(f, s.tipo, 'REEMPLAZADO', userId);
      if (salida) historial.push(salida);
      patch[`${s.tipo}_path`] = s.path;
      patch[`${s.tipo}_nombre`] = s.nombre;
      patch[`${s.tipo}_subido_at`] = ahora;
      patch[`${s.tipo}_subido_por`] = userId;
    }
    patch.archivos_historial = historial;
    return patch;
  }

  /** `PATCH /v1/facturas-emitidas/:id` */
  async editar(
    id: string,
    datosJson: string,
    files: ArchivosFactura | undefined,
    actor: ActorFactura,
  ): Promise<ResultadoGuardarFactura> {
    await this.asegurarDisponible();
    const { datos, traeEmisora, traeCliente } = await this.parsearDatos(
      datosJson,
      false,
    );
    const { pdf, xml } = this.archivosDe(files);
    const hayDatos = Object.keys(datos).length > 0 || traeEmisora;
    if (!hayDatos && !pdf && !xml) {
      throw new BadRequestException({
        message: 'No hay nada que cambiar: manda algún dato o un archivo.',
        error: 'NADA_QUE_CAMBIAR',
      });
    }
    const actual = await this.facturaOFalla(id);
    // Valores FINALES (lo nuevo sobre lo que había).
    const final = {
      serie: datos.serie !== undefined ? datos.serie : actual.serie,
      folio: datos.folio ?? actual.folio,
      uuid: datos.uuid !== undefined ? datos.uuid : actual.uuid,
      emisor_rfc:
        datos.emisor_rfc !== undefined ? datos.emisor_rfc : actual.emisor_rfc,
      emisor_nombre:
        datos.emisor_nombre !== undefined
          ? datos.emisor_nombre
          : actual.emisor_nombre,
      receptor_rfc:
        datos.receptor_rfc !== undefined
          ? datos.receptor_rfc
          : actual.receptor_rfc,
    };
    if (xml) {
      const cfdi = this.leerXmlObligatorio(xml);
      this.verificarXmlCuadra(cfdi, final);
      if (!final.uuid && cfdi.uuid) {
        final.uuid = cfdi.uuid;
        datos.uuid = cfdi.uuid;
      }
    }
    // Vuelos: si viene la lista, REEMPLAZA el conjunto.
    const ligasActuales = (await this.vuelosDeFactura(id)).map((v) => v.id);
    const vueloIdsFinal = datos.vuelo_ids ?? ligasActuales;
    const vuelos = await this.vuelosParaLigar(vueloIdsFinal);
    const entran = vueloIdsFinal.filter((v) => !ligasActuales.includes(v));
    const salen = ligasActuales.filter((v) => !vueloIdsFinal.includes(v));

    // Emisora: solo se re-resuelve si vino la llave o si cambió el emisor.
    let emisoraId = actual.emisora_id;
    let avisosEmisor: AvisoFactura[] = [];
    const cambiaEmisor =
      datos.emisor_rfc !== undefined || datos.emisor_nombre !== undefined;
    if (traeEmisora || cambiaEmisor) {
      const r = await this.resolverEmisora(
        datos,
        traeEmisora,
        final.emisor_rfc,
        final.emisor_nombre,
      );
      emisoraId = traeEmisora
        ? r.emisoraId
        : (r.emisoraId ?? actual.emisora_id);
      avisosEmisor = r.avisos;
    }
    // Duplicados (excluyendo la propia fila) si cambia el número o el uuid.
    const cambiaNumero =
      datos.serie !== undefined ||
      datos.folio !== undefined ||
      emisoraId !== actual.emisora_id;
    const cambiaUuid = (final.uuid ?? null) !== (actual.uuid ?? null);
    if (cambiaNumero || cambiaUuid) {
      const dup = await this.yaRegistrada({
        uuid: cambiaUuid ? final.uuid : null,
        serie: final.serie,
        folio: cambiaNumero ? final.folio : null,
        emisora_id: emisoraId,
        excluirId: id,
      });
      if (dup) throw this.conflictoDuplicado(dup.tipo, dup.existente);
    }
    if (traeCliente && datos.cliente_id) {
      await this.asegurarClienteExiste(datos.cliente_id);
    }
    // Archivos nuevos (los anteriores NO se borran: van al historial).
    const subidos = await this.subirArchivos(
      id,
      [pdf, xml].filter((a): a is ArchivoValido => !!a),
    );
    const patch: Record<string, unknown> = {
      ...this.patchArchivos(actual, subidos, actor.userId),
      updated_by: actor.userId,
    };
    const copiar: Array<keyof DatosNormalizados> = [
      'serie',
      'folio',
      'uuid',
      'fecha_emision',
      'emisor_rfc',
      'emisor_nombre',
      'receptor_rfc',
      'receptor_nombre',
      'moneda',
      'subtotal',
      'iva',
      'total',
      'metodo_pago',
      'forma_pago',
      'notas',
      'es_parcial',
    ];
    for (const k of copiar) {
      if (datos[k] !== undefined) patch[k] = datos[k];
    }
    if (emisoraId !== actual.emisora_id) patch.emisora_id = emisoraId;
    if (datos.cliente_id !== undefined) {
      patch.cliente_id = traeCliente ? datos.cliente_id : null;
    }
    const { error: updErr } = await this.sb
      .from('factura_emitida')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null);
    if (updErr) {
      await this.borrarRecienSubidos(subidos.map((s) => s.path));
      const indice = this.indiceUnicoViolado(updErr);
      if (indice) {
        const carrera = await this.yaRegistrada({
          uuid: indice === 'UUID' ? final.uuid : null,
          serie: final.serie,
          folio: indice === 'FOLIO' ? final.folio : null,
          emisora_id: emisoraId,
          excluirId: id,
        });
        if (carrera)
          throw this.conflictoDuplicado(carrera.tipo, carrera.existente);
      }
      throw new Error(updErr.message);
    }
    // Ligas: entran y salen.
    if (entran.length > 0) {
      const { error } = await this.sb.from('factura_emitida_vuelo').insert(
        entran.map((v) => ({
          factura_id: id,
          vuelo_id: v,
          created_by: actor.userId,
        })),
      );
      if (error) {
        throw new Error(
          `La factura se guardó, pero no se pudieron ligar los vuelos nuevos: ${error.message}. Vuelve a intentarlo.`,
        );
      }
    }
    if (salen.length > 0) {
      const { error } = await this.sb
        .from('factura_emitida_vuelo')
        .delete()
        .eq('factura_id', id)
        .in('vuelo_id', salen);
      if (error) {
        throw new Error(
          `La factura se guardó, pero no se pudieron desligar vuelos: ${error.message}. Vuelve a intentarlo.`,
        );
      }
    }
    const factura = await this.facturaCompleta(id);
    const listaVuelos = vueloIdsFinal.map((v) => vuelos.get(v)!);
    if (factura.estatus === 'VIGENTE') {
      await this.efectosDeLigar(
        { id, etiqueta: factura.etiqueta },
        entran.map((v) => vuelos.get(v)!),
        actor,
      );
    }
    const avisos = await this.avisosDeGuardado({
      id,
      estatus: factura.estatus,
      etiqueta: factura.etiqueta,
      es_parcial: factura.es_parcial,
      moneda: factura.moneda,
      total: factura.total,
      receptor_rfc: factura.receptor_rfc,
      vuelos: listaVuelos,
      avisosEmisor,
    });
    return { factura, avisos };
  }

  // ======================================================================
  // CANCELAR / REACTIVAR / ELIMINAR
  // ======================================================================

  private motivoValido(motivo: string | null | undefined): string {
    const m = (motivo ?? '').replace(/\s+/g, ' ').trim();
    // Se cuentan CARACTERES (code points), como `char_length` del CHECK de la
    // BD: con `.length` (unidades UTF-16) «👍👍» pasaba aquí y la BD lo
    // rechazaba con 23514 ⇒ 500 en vez de este 400.
    const largo = [...m].length;
    if (largo < 3 || largo > 500) {
      throw new BadRequestException({
        message: 'Escribe el motivo (mínimo 3 letras).',
        error: 'MOTIVO_REQUERIDO',
      });
    }
    return m;
  }

  /** `POST /:id/cancelar` — conserva número y archivos. */
  async cancelar(
    id: string,
    motivo: string | undefined,
    actor: ActorFactura,
  ): Promise<ResultadoGuardarFactura> {
    await this.asegurarDisponible();
    const m = this.motivoValido(motivo);
    const actual = await this.facturaOFalla(id);
    if (actual.estatus === 'CANCELADA') {
      throw new ConflictException({
        message: `La factura ${etiquetaFactura(actual.serie, actual.folio)} ya está cancelada.`,
        error: 'FACTURA_YA_CANCELADA',
      });
    }
    const { error } = await this.sb
      .from('factura_emitida')
      .update({
        estatus: 'CANCELADA',
        cancelada_at: new Date().toISOString(),
        cancelada_por: actor.userId,
        motivo_cancelacion: m,
        updated_by: actor.userId,
      })
      .eq('id', id)
      .eq('estatus', 'VIGENTE')
      .is('deleted_at', null);
    if (error) throw new Error(error.message);
    const avisos = await this.avisosSigueFacturado(id);
    return { factura: await this.facturaCompleta(id), avisos };
  }

  /** `POST /:id/reactivar` */
  async reactivar(
    id: string,
    actor: ActorFactura,
  ): Promise<ResultadoGuardarFactura> {
    await this.asegurarDisponible();
    const actual = await this.facturaOFalla(id);
    if (actual.estatus !== 'CANCELADA') {
      throw new ConflictException({
        message: `La factura ${etiquetaFactura(actual.serie, actual.folio)} no está cancelada.`,
        error: 'FACTURA_NO_CANCELADA',
      });
    }
    const { error } = await this.sb
      .from('factura_emitida')
      .update({
        estatus: 'VIGENTE',
        cancelada_at: null,
        cancelada_por: null,
        motivo_cancelacion: null,
        updated_by: actor.userId,
      })
      .eq('id', id)
      .eq('estatus', 'CANCELADA')
      .is('deleted_at', null);
    if (error) throw new Error(error.message);
    const factura = await this.facturaCompleta(id);
    const ids = factura.vuelos.map((v) => v.id);
    const vuelos =
      ids.length > 0
        ? await this.vuelosParaLigar(ids)
        : new Map<string, VueloParaLigar>();
    const lista = ids.map((v) => vuelos.get(v)!);
    // Efecto (a) sí; el aviso a quien pidió ya salió cuando se ligó.
    await this.efectosDeLigar(
      { id, etiqueta: factura.etiqueta },
      lista.map((v) => ({ ...v, factura_solicitada_at: null })),
      actor,
    );
    const avisos = await this.avisosDeGuardado({
      id,
      estatus: 'VIGENTE',
      etiqueta: factura.etiqueta,
      es_parcial: factura.es_parcial,
      moneda: factura.moneda,
      total: factura.total,
      receptor_rfc: null,
      vuelos: lista,
      avisosEmisor: [],
    });
    return {
      factura,
      avisos: avisos.filter((a) => a.code === 'VUELO_CON_OTRA_FACTURA'),
    };
  }

  /** `DELETE /:id` (soft delete) — libera el número; archivos se conservan. */
  async eliminar(
    id: string,
    motivo: string | undefined,
    actor: ActorFactura,
  ): Promise<{ ok: true; id: string; avisos: AvisoFactura[] }> {
    await this.asegurarDisponible();
    const m = this.motivoValido(motivo);
    await this.facturaOFalla(id);
    const { error } = await this.sb
      .from('factura_emitida')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: actor.userId,
        motivo_baja: m,
        updated_by: actor.userId,
      })
      .eq('id', id)
      .is('deleted_at', null);
    if (error) throw new Error(error.message);
    const avisos = await this.avisosSigueFacturado(id);
    return { ok: true, id, avisos };
  }

  // ======================================================================
  // ARCHIVOS
  // ======================================================================

  /** `POST /:id/archivo` — reemplaza PDF y/o XML (el anterior va al historial). */
  async reemplazarArchivos(
    id: string,
    files: ArchivosFactura | undefined,
    actor: ActorFactura,
  ): Promise<FacturaEmitida> {
    await this.asegurarDisponible();
    const { pdf, xml } = this.archivosDe(files);
    if (!pdf && !xml) {
      throw new BadRequestException({
        message:
          'No llegó ningún archivo: manda el PDF y/o el XML de la factura.',
        error: 'SIN_ARCHIVO',
      });
    }
    const actual = await this.facturaOFalla(id);
    const patchExtra: Record<string, unknown> = {};
    if (xml) {
      const cfdi = this.leerXmlObligatorio(xml);
      this.verificarXmlCuadra(cfdi, actual);
      if (!actual.uuid && cfdi.uuid) {
        const dup = await this.yaRegistrada({ uuid: cfdi.uuid, excluirId: id });
        if (dup) throw this.conflictoDuplicado(dup.tipo, dup.existente);
        patchExtra.uuid = cfdi.uuid;
      }
    }
    const subidos = await this.subirArchivos(
      id,
      [pdf, xml].filter((a): a is ArchivoValido => !!a),
    );
    const { error } = await this.sb
      .from('factura_emitida')
      .update({
        ...this.patchArchivos(actual, subidos, actor.userId),
        ...patchExtra,
        updated_by: actor.userId,
      })
      .eq('id', id)
      .is('deleted_at', null);
    if (error) {
      await this.borrarRecienSubidos(subidos.map((s) => s.path));
      if (this.indiceUnicoViolado(error) === 'UUID') {
        const dup = await this.yaRegistrada({
          uuid: patchExtra.uuid as string,
          excluirId: id,
        });
        if (dup) throw this.conflictoDuplicado(dup.tipo, dup.existente);
      }
      throw new Error(error.message);
    }
    this.logger.log(
      `Factura ${etiquetaFactura(actual.serie, actual.folio)} (${id}): archivos ${subidos.map((s) => s.tipo).join('+')} reemplazados por ${actor.userId}; anteriores en archivos_historial`,
    );
    return this.facturaCompleta(id);
  }

  /**
   * `DELETE /:id/archivo?tipo=` — NO borra el objeto del bucket (incidente
   * #297): limpia las columnas y deja la entrada `QUITADO` en el historial.
   */
  async quitarArchivo(
    id: string,
    tipo: TipoArchivo,
    actor: ActorFactura,
  ): Promise<FacturaEmitida> {
    await this.asegurarDisponible();
    const actual = await this.facturaOFalla(id);
    const entrada = this.entradaHistorial(
      actual,
      tipo,
      'QUITADO',
      actor.userId,
    );
    if (!entrada) {
      throw new NotFoundException({
        message:
          tipo === 'pdf'
            ? 'Esta factura no tiene PDF adjunto.'
            : 'Esta factura no tiene XML adjunto.',
        error: 'ARCHIVO_NO_EXISTE',
      });
    }
    const patch: Record<string, unknown> = {
      [`${tipo}_path`]: null,
      [`${tipo}_nombre`]: null,
      [`${tipo}_subido_at`]: null,
      [`${tipo}_subido_por`]: null,
      archivos_historial: [...this.historialDe(actual), entrada],
      updated_by: actor.userId,
    };
    const { error } = await this.sb
      .from('factura_emitida')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null);
    if (error) throw new Error(error.message);
    this.logger.log(
      `Factura ${etiquetaFactura(actual.serie, actual.folio)} (${id}): ${tipo.toUpperCase()} quitado por ${actor.userId}; el objeto ${String(entrada.path)} se CONSERVA en el bucket`,
    );
    return this.facturaCompleta(id);
  }

  /** `GET /:id/archivo-url?tipo=` — URL firmada 600 s. */
  async archivoUrl(
    id: string,
    tipo: TipoArchivo,
  ): Promise<{ url: string; nombre: string | null }> {
    await this.asegurarDisponible();
    const f = await this.facturaOFalla(id);
    const path = tipo === 'pdf' ? f.pdf_path : f.xml_path;
    if (!path) {
      throw new NotFoundException({
        message:
          tipo === 'pdf'
            ? 'Esta factura no tiene PDF adjunto.'
            : 'Esta factura no tiene XML adjunto.',
        error: 'ARCHIVO_NO_EXISTE',
      });
    }
    const { data, error } = await this.sb.storage
      .from(BUCKET_FACTURAS)
      .createSignedUrl(path, SEGUNDOS_URL_FIRMADA);
    if (error || !data?.signedUrl) {
      throw new NotFoundException({
        message: `No se pudo abrir el archivo: ${error?.message ?? 'sin URL'}`,
        error: 'ARCHIVO_NO_EXISTE',
      });
    }
    return {
      url: data.signedUrl,
      nombre: (tipo === 'pdf' ? f.pdf_nombre : f.xml_nombre) ?? null,
    };
  }

  // ======================================================================
  // LEER ARCHIVO (sin guardar)
  // ======================================================================

  private camposVacios(): CamposLeidosFactura {
    return {
      serie: null,
      folio: null,
      uuid: null,
      fecha_emision: null,
      emisor_rfc: null,
      emisor_nombre: null,
      receptor_rfc: null,
      receptor_nombre: null,
      moneda: null,
      subtotal: null,
      iva: null,
      total: null,
      metodo_pago: null,
      forma_pago: null,
    };
  }

  /** `POST /v1/facturas-emitidas/leer-archivo` — nunca 500 por lectura. */
  async leerArchivo(
    files: ArchivosFactura | undefined,
  ): Promise<LecturaArchivoFactura> {
    await this.asegurarDisponible();
    const { pdf, xml } = this.archivosDe(files);
    if (!pdf && !xml) {
      throw new BadRequestException({
        message:
          'No llegó ningún archivo: suelta el PDF y/o el XML de la factura.',
        error: 'SIN_ARCHIVO',
      });
    }
    const avisos: AvisoFactura[] = [];
    let deXml: CamposLeidosFactura | null = null;
    if (xml) {
      if (xmlDeclaraDoctype(xml.buffer)) {
        throw new UnprocessableEntityException({
          message:
            'Ese XML declara un DOCTYPE/ENTITY y no se acepta por seguridad. Descarga el XML original del CFDI.',
          error: 'XML_NO_PERMITIDO',
        });
      }
      const cfdi = extraerCfdiCompleto(xml.buffer);
      if (!cfdi) {
        if (!pdf) {
          throw new UnprocessableEntityException({
            message: 'Ese XML no es un CFDI legible.',
            error: 'XML_ILEGIBLE',
          });
        }
        avisos.push({
          code: 'LECTURA_PDF',
          mensaje:
            'El XML no es un CFDI legible: se usaron solo los datos del PDF.',
        });
      } else {
        deXml = {
          serie: normalizarSerie(cfdi.serie),
          folio: normalizarFolio(cfdi.folio),
          uuid: cfdi.uuid,
          fecha_emision: cfdi.fecha_emision,
          emisor_rfc: cfdi.emisor_rfc,
          emisor_nombre: cfdi.emisor_nombre,
          receptor_rfc: cfdi.receptor_rfc,
          receptor_nombre: cfdi.receptor_nombre,
          moneda: cfdi.moneda,
          subtotal: cfdi.subtotal,
          iva: cfdi.iva,
          total: cfdi.total,
          metodo_pago: cfdi.metodo_pago,
          forma_pago: cfdi.forma_pago,
        };
        if (cfdi.tipo_comprobante && cfdi.tipo_comprobante !== 'I') {
          const nombres: Record<string, string> = {
            E: 'Egreso',
            P: 'Pago',
            T: 'Traslado',
            N: 'Nómina',
          };
          avisos.push({
            code: 'CFDI_NO_ES_INGRESO',
            mensaje: `Este CFDI es de tipo ${nombres[cfdi.tipo_comprobante] ?? cfdi.tipo_comprobante}, no una factura de ingreso.`,
            details: { tipo_comprobante: cfdi.tipo_comprobante },
          });
        }
        if (cfdi.moneda_raw && !cfdi.moneda) {
          avisos.push({
            code: 'MONEDA_NO_SOPORTADA',
            mensaje: `La factura está en ${cfdi.moneda_raw}: el registro solo maneja MXN y USD; elige la moneda a mano.`,
            details: { moneda: cfdi.moneda_raw },
          });
        }
      }
    }

    let dePdf: CamposLeidosFactura | null = null;
    let textoExtraido: boolean | null = null;
    if (pdf) {
      try {
        const r = await this.pyservices.leerPdfEmitida(
          pdf.buffer.toString('base64'),
        );
        textoExtraido = r.texto_extraido === true;
        const uuid = normalizarUuidEntrada(r.uuid);
        const rfcE = normalizarRfc(r.emisor_rfc);
        const rfcR = normalizarRfc(r.receptor_rfc);
        const metodo = (r.metodo_pago ?? '').toUpperCase();
        const num = (x: unknown) => {
          const n = numeroONull(x);
          return n == null ? null : redondear2(n);
        };
        dePdf = {
          serie: normalizarSerie(r.serie),
          folio: normalizarFolio(r.folio),
          uuid: uuid && RE_UUID_FISCAL.test(uuid) ? uuid : null,
          fecha_emision:
            r.fecha_emision && /^\d{4}-\d{2}-\d{2}$/.test(r.fecha_emision)
              ? r.fecha_emision
              : null,
          emisor_rfc: rfcE && RE_RFC.test(rfcE) ? rfcE : null,
          emisor_nombre: textoONull(r.emisor_nombre)?.slice(0, 300) ?? null,
          receptor_rfc: rfcR && RE_RFC.test(rfcR) ? rfcR : null,
          receptor_nombre: textoONull(r.receptor_nombre)?.slice(0, 300) ?? null,
          moneda: monedaCfdi(r.moneda),
          subtotal: num(r.subtotal),
          iva: num(r.iva),
          total: num(r.total),
          metodo_pago: metodo === 'PUE' || metodo === 'PPD' ? metodo : null,
          forma_pago:
            r.forma_pago && /^\d{2}$/.test(r.forma_pago) ? r.forma_pago : null,
        };
        let avisosPy = (Array.isArray(r.avisos) ? r.avisos : [])
          .filter((a): a is string => typeof a === 'string' && !!a.trim())
          .map((a) => a.trim());
        if (!textoExtraido) {
          // pyservices también manda texto_extraido=false con contraseña,
          // tope de tiempo o PDF dañado, y su aviso dice el motivo REAL.
          // «Parece escaneado» solo cuando no trae otro motivo (y sin repetir
          // el suyo de «parece escaneado»).
          const esEscaneado = (a: string) => /parece escaneado/i.test(a);
          if (!avisosPy.some((a) => !esEscaneado(a))) {
            avisos.push({
              code: 'PDF_SIN_TEXTO',
              mensaje:
                'El PDF parece escaneado (no tiene texto): captura los datos a mano o suelta el XML.',
            });
          }
          avisosPy = avisosPy.filter((a) => !esEscaneado(a));
        }
        for (const a of avisosPy) {
          avisos.push({ code: 'LECTURA_PDF', mensaje: a });
        }
      } catch (e) {
        this.logger.warn(
          `leer-pdf-emitida falló: ${e instanceof Error ? e.message : String(e)}`,
        );
        textoExtraido = false;
        avisos.push({
          code: 'PDF_NO_LEIDO',
          mensaje:
            'No pude leer el PDF automáticamente: captura los datos a mano (o suelta también el XML).',
        });
      }
    }

    // El XML MANDA; el PDF solo llena lo que el XML no trae.
    const campos = this.camposVacios();
    for (const k of Object.keys(campos) as Array<keyof CamposLeidosFactura>) {
      const v = deXml?.[k] ?? dePdf?.[k] ?? null;
      (campos as unknown as Record<string, unknown>)[k] = v;
    }
    if (deXml?.uuid && dePdf?.uuid && deXml.uuid !== dePdf.uuid) {
      avisos.push({
        code: 'PDF_XML_NO_CUADRAN',
        mensaje: `El PDF y el XML no son de la misma factura: el PDF dice folio fiscal ${dePdf.uuid} y el XML ${deXml.uuid}. Se usaron los datos del XML.`,
        details: { uuid_pdf: dePdf.uuid, uuid_xml: deXml.uuid },
      });
    }
    const faltan: string[] = [];
    if (!campos.folio) faltan.push('folio');
    if (campos.total == null) faltan.push('total');
    if (!campos.fecha_emision) faltan.push('fecha de emisión');
    if (!campos.uuid) faltan.push('folio fiscal (UUID)');
    if (faltan.length > 0 && (deXml || textoExtraido)) {
      avisos.push({
        code: 'CAMPOS_NO_ENCONTRADOS',
        mensaje: `No encontré: ${faltan.join(', ')}.`,
        details: { campos: faltan },
      });
    }

    const emisoras = await this.cargarEmisoras();
    const ver = verificarEmisor(
      campos.emisor_rfc,
      campos.emisor_nombre,
      emisoras,
    );
    avisos.push(...ver.avisos);

    let ya: FacturaExistente | null = null;
    if (campos.uuid || campos.folio) {
      const r = await this.yaRegistrada({
        uuid: campos.uuid,
        serie: campos.serie,
        folio: campos.folio,
        emisora_id: ver.emisora?.id ?? null,
      });
      ya = r?.existente ?? null;
    }

    return {
      campos,
      fuente: { xml: !!deXml, pdf: !!dePdf },
      texto_extraido: textoExtraido,
      ya_registrada: ya,
      cliente_sugerido: await this.clienteSugerido(
        campos.receptor_rfc,
        campos.receptor_nombre,
      ),
      emisora: ver.emisora,
      avisos,
    };
  }

  /** Cliente ACTIVO por RFC receptor; si no, por nombre normalizado. */
  private async clienteSugerido(
    rfc: string | null,
    nombre: string | null,
  ): Promise<LecturaArchivoFactura['cliente_sugerido']> {
    if (!rfc && !nombre) return null;
    try {
      const clientes = await this.leerTodo<{
        id: string;
        nombre: string;
        rfc: string | null;
        razon_social_default: string | null;
      }>((d, h) =>
        this.sb
          .from('cliente')
          .select('id, nombre, rfc, razon_social_default')
          .eq('activo', true)
          .order('nombre')
          .range(d, h),
      );
      if (rfc) {
        const porRfc = clientes.filter((c) => normalizarRfc(c.rfc) === rfc);
        if (porRfc.length > 0) {
          return { id: porRfc[0].id, nombre: porRfc[0].nombre, por: 'RFC' };
        }
      }
      const n = normalizarNombreEmpresa(nombre);
      if (n) {
        const porNombre = clientes.filter(
          (c) =>
            normalizarNombreEmpresa(c.razon_social_default) === n ||
            normalizarNombreEmpresa(c.nombre) === n,
        );
        if (porNombre.length > 0) {
          return {
            id: porNombre[0].id,
            nombre: porNombre[0].nombre,
            por: 'NOMBRE',
          };
        }
      }
    } catch (e) {
      this.logger.warn(
        `No se pudo sugerir cliente: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return null;
  }
}

/** Subconjunto de columnas de la fila que usan los helpers de contexto. */
type FacturaRowLike = Pick<
  FacturaEmitidaRow,
  | 'id'
  | 'serie'
  | 'folio'
  | 'estatus'
  | 'es_parcial'
  | 'pdf_path'
  | 'archivos_historial'
>;
