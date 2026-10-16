import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { Cron } from '@nestjs/schedule';
import {
  corteTs,
  esAntesDelInicio,
  exigirPeriodoDesdeInicio,
  inicioOficialDe,
} from '../../common/inicio-oficial.util';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import { columnaOpcional } from '../../common/columna-opcional.util';
import { serieFolioRecibidaDisponible } from '../../common/serie-folio-recibida-disponible.util';
import { FacturaClienteService } from '../flights/factura-cliente.service';
import { normalizarTc, totalMxnDeVuelo } from '../../common/tc.util';
import { SEGUNDOS_URL_PUNTUAL } from '../../common/url-firmada.util';
import { PyservicesService } from '../pyservices/pyservices.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import {
  FacturacionClient,
  type PreviewPayload,
  type TimbrarPayload,
  type TimbrarResult,
} from './facturacion.client';
import type { UpdateRecibidaDto } from './dto/invoices.dto';
import {
  errorFacturasGastoNoDisponible,
  gastoFacturasDisponible,
} from '../../common/gasto-facturas-disponible.util';
import {
  agruparArchivos,
  notaPdfSinXml,
  PREFIJO_NOTA_PDF_SIN_XML,
  sha256Hex,
  siguientePrincipal,
  type ArchivoLeido,
  type GrupoFactura,
} from './gasto-facturas.util';
import {
  detalleFacturasDeGasto,
  ligasDeFacturas,
  ligasDeGastos,
} from './gasto-facturas.lector';
import {
  camposSerieFolioInsert,
  clasificarFalloRelectura,
  cortarRelecturaPorPyservices,
  notasConFolioNoLegible,
  RELECTURA_FOLIO_LOTE,
  serieFolioDelCfdi,
} from './recibida-folio.util';

interface ListPendientesFilters {
  desde?: string;
  hasta?: string;
  cliente_id?: string;
  limit: number;
  offset: number;
}

/** Receptor alterno opcional (caso 9.7 "SE FACTURÓ A"). */
interface FacturadoA {
  facturado_a_rfc?: string;
  facturado_a_nombre?: string;
  facturado_a_regimen?: string;
  facturado_a_cp?: string;
  facturado_a_uso_cfdi?: string;
}

interface EmitirInput extends FacturadoA {
  vuelo_id: string;
  entidad_fiscal_emisora_id: string;
  /** Venta al PÚBLICO EN GENERAL (XAXX010101000): el cliente no pide factura. */
  publico_en_general?: boolean;
  periodicidad?: string;
  /** TC MXN/USD pactado para vuelos cotizados en USD sin TC (externos). */
  tc_usd_mxn?: number;
}

/** Métodos con los que se puede facturar ANTES del cobro (pedido de Itzy). */
const METODOS_FACTURABLES = new Set([
  'TRANSFERENCIA',
  'HSBC_LINK',
  'BILLPOCKET',
  'CHEQUE',
  // PAYWISE (9-sep-2026): link/pasarela, mismo trato que BillPocket.
  'PAYWISE',
]);

/** RFC genérico SAT para residentes en el extranjero. */
const RFC_EXTRANJERO = 'XEXX010101000';

/** Fila del vuelo con lo necesario para facturar (tipado del select). */
interface VueloFacturable {
  id: string;
  folio: number | string;
  cliente_id: string;
  estado: string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  fecha_vuelo: string | null;
  cobrado: boolean;
  facturado: boolean;
  metodo_cobro: string | null;
  monto_total_usd: number | null;
  monto_total_mxn: number | null;
  tc_usd_mxn: number | null;
}

/** Fila de la entidad fiscal emisora (tipado del select). */
interface EmisoraFiscal {
  id: string;
  codigo: string;
  razon_social: string;
  rfc: string;
  regimen_fiscal_sat: string;
  codigo_postal: string;
  csd_cer_url: string | null;
  csd_key_url: string | null;
}

/**
 * Paquete que DEFINE el CFDI de un vuelo: receptor efectivo, importes,
 * forma/método de pago, InformacionGlobal y concepto. emitir() y preview()
 * salen del MISMO prepararEmision() — la vista previa nunca puede diferir de
 * lo que se timbra (fiabilidad numérica).
 */
interface EmisionPreparada {
  vuelo: VueloFacturable;
  emisora: EmisoraFiscal;
  receptor: TimbrarPayload['receptor'];
  esPublicoGeneral: boolean;
  /** Receptor con RFC genérico XEXX010101000 (cliente extranjero o alterno). */
  esExtranjero: boolean;
  totalMxn: number;
  valorUnitario: number;
  iva: number;
  formaPago: string;
  metodoPago: string;
  informacionGlobal?: TimbrarPayload['informacion_global'];
  descripcionConcepto: string;
  /** TC pactado pendiente de persistir en el vuelo — SOLO emitir() lo escribe. */
  tcPactado?: { tc_usd_mxn: number; monto_total_mxn: number };
}

/**
 * c_FormaPago del SAT por método de cobro interno: hardcodear '03'
 * (transferencia) declaraba mal los cobros en efectivo, terminal o cheque.
 */
const FORMA_PAGO_SAT: Record<string, string> = {
  EFECTIVO: '01',
  DOLARES: '01', // efectivo en dólares: mismo c_FormaPago 01
  CHEQUE: '02',
  TRANSFERENCIA: '03',
  HSBC_LINK: '03', // el link HSBC liquida vía transferencia/SPEI
  BILLPOCKET: '04', // terminal = tarjeta de crédito
  PAYWISE: '04', // link/pasarela: el cliente paga con tarjeta
  OTRO: '99', // método manual: "Por definir" — el operador corrige al timbrar
};

interface CancelarInput {
  motivo: string;
  folio_sustitucion?: string;
}

interface NotaCreditoInput {
  factura_id: string;
  tipo_relacion?: string;
  monto?: number;
  descripcion?: string;
}

const FACTURA_COLS =
  'id, vuelo_id, cliente_id, entidad_fiscal_emisora_id, estado, serie, folio, uuid_fiscal, pac_id, total, moneda, xml_url, pdf_url, fecha_timbrado, error_mensaje, tipo_comprobante, factura_relacionada_id, facturado_a_rfc, facturado_a_nombre, motivo_cancelacion, cancelada_at, created_at';

const RECIBIDA_COLS =
  'id, uuid_fiscal, emisor_rfc, emisor_nombre, receptor_rfc, receptor_nombre, tipo_comprobante, subtotal, total, moneda, fecha_emision, conceptos_resumen, xml_url, estado, gasto_id, aeronave_id, categoria_sugerida, notas, created_at, updated_at';

/**
 * `factura_recibida.pdf_url` la crea la migración `20260923000001`. Mientras
 * no esté aplicada, los selects la OMITEN (el API sigue funcionando igual
 * que hoy) y subir un PDF responde un 409 que dice qué falta — nunca se
 * guarda a medias ni se pierde el papel en silencio.
 */
const MIGRACION_PDF_RECIBIDA = '20260923000001';

/**
 * Resultado de UNA corrida del cron `recibidas-releer-folio` (5-oct-2026):
 * cuántas facturas leyó y qué pasó con cada una (log + specs).
 */
export interface ResumenRelecturaFolio {
  /** `false` = la migración 20261005000002 no está aplicada: no hizo nada. */
  disponible: boolean;
  /** Filas tomadas del buzón (≤ RELECTURA_FOLIO_LOTE). */
  leidas: number;
  /** Selladas con folio (serie opcional). */
  con_folio: number;
  /** Selladas sin folio (el CFDI no trae Serie/Folio). */
  sin_folio: number;
  /** Selladas como ilegibles (XML roto o ausente) con la nota. */
  ilegibles: number;
  /** NO selladas: pyservices/Storage caído o pyservices viejo. */
  reintentar: number;
}

/** Tope de facturas por envío en «Subir facturas» de un gasto. */
const MAX_ARCHIVOS_GASTO = 10;

/** Qué pasó con cada factura de un envío de «Subir facturas». */
export interface DetalleFacturaSubida {
  /** Posiciones (0-based) de `archivos[]` que resultaron ser ESTA factura. */
  archivos: number[];
  factura_id: string;
  /**
   * NUEVA = se creó en el buzón y se ligó; EXISTENTE = ya estaba en el buzón
   * (mismo UUID o mismo PDF) y se ligó a este gasto; YA_EN_ESTE_GASTO = ya
   * estaba ligada a este gasto (no cambió nada salvo lo de abajo).
   */
  resultado: 'NUEVA' | 'EXISTENTE' | 'YA_EN_ESTE_GASTO';
  /** Se guardó el PDF que le faltaba a una factura que ya existía. */
  pdf_agregado: boolean;
  /** Un PDF sin XML ya subido se COMPLETÓ con su XML (datos del CFDI). */
  xml_agregado: boolean;
  /** `true` salvo en NUEVA (mismo sentido que el `ya_existia` de siempre). */
  ya_existia: boolean;
}

/** El embed de gastos amarrados, igual en todas las respuestas de recibidas. */
const RECIBIDA_EMBED_GASTOS =
  'gastos:gasto!factura_recibida_id(id, categoria, monto, moneda, fecha_gasto, vuelo_id, lugar)';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly fel: FacturacionClient,
    private readonly pyservices: PyservicesService,
    private readonly profitSharing: ProfitSharingService,
    // Factura del SERVICIO por vuelo (22-sep-2026): timbrar un CFDI deja el
    // seguimiento administrativo en FACTURADO por la MISMA fuente que usa el
    // panel. @Optional: es un efecto secundario best-effort — la emisión
    // nunca se cae por él (y los specs no lo inyectan).
    @Optional()
    private readonly facturaCliente?: FacturaClienteService,
    // INICIO OFICIAL (16-oct-2026, invariante 86). @Optional y ÚLTIMO (los
    // specs construyen por posición; sin él ⇒ como 0.0.83).
    @Optional()
    private readonly configuracion?: ConfiguracionService,
  ) {}

  /** Diagnóstico de conexión con el PAC (no consume timbres ni toca BD). */
  pacHealth() {
    return this.fel.health();
  }

  /**
   * Paquete de cierre mensual (doc etapa 7): un .zip con el reporte mensual por
   * avión (Excel) + el XML y PDF de cada factura timbrada del periodo. Los
   * estados de cuenta no se almacenan en el sistema, así que se agregan aparte.
   */
  async cierreZip(
    desdePedido: string,
    hasta: string,
  ): Promise<{ buffer: Buffer; desde: string; hasta: string }> {
    // INICIO OFICIAL (invariante 86, forma R): periodo subido en el zip, el
    // Excel y el nombre; uno anterior ⇒ 400 PERIODO_ANTES_DEL_INICIO.
    const { desde } = exigirPeriodoDesdeInicio(
      desdePedido,
      hasta,
      await inicioOficialDe(this.configuracion),
    );
    // 1) Reporte mensual por avión (Excel) — reutiliza el cómputo de reparto.
    const { buffer: excel } = await this.profitSharing.repartoXlsx({
      desde,
      hasta,
    });
    const archivos: { nombre: string; contenido_b64: string }[] = [
      {
        nombre: `reporte-mensual-${desde}-a-${hasta}.xlsx`,
        contenido_b64: excel.toString('base64'),
      },
    ];

    // 2) Facturas timbradas en el periodo: XML + PDF.
    const { data: facturas } = await this.supabase.service
      .from('factura')
      .select(
        'serie, folio, uuid_fiscal, estado, tipo_comprobante, xml_url, pdf_url, fecha_timbrado',
      )
      .eq('estado', 'TIMBRADA')
      .gte('fecha_timbrado', `${desde}T00:00:00-05:00`)
      .lte('fecha_timbrado', `${hasta}T23:59:59-05:00`)
      .order('fecha_timbrado', { ascending: true });

    for (const f of (facturas ?? []) as Array<Record<string, unknown>>) {
      const base = `${(f.serie as string) ?? ''}${(f.folio as string) ?? ''}-${String(f.uuid_fiscal ?? '').slice(0, 8)}`;
      for (const [campo, ext] of [
        ['xml_url', 'xml'],
        ['pdf_url', 'pdf'],
      ] as const) {
        const path = f[campo] as string | null;
        if (!path) continue;
        try {
          const b64 = await this.downloadB64('facturas', path);
          archivos.push({
            nombre: `facturas/${base}.${ext}`,
            contenido_b64: b64,
          });
        } catch (e) {
          this.logger.warn(
            `cierre: no se pudo leer ${path}: ${(e as Error).message}`,
          );
        }
      }
    }

    const buffer = await this.pyservices.generateZip({ archivos });
    return { buffer, desde, hasta };
  }

  // ============ Facturas recibidas (buzón de CFDI de proveedores) ============

  /** ¿Existe ya `factura_recibida.pdf_url`? (sondeo memorizado ≤ 10 min) */
  private conPdfRecibida(): Promise<boolean> {
    return columnaOpcional(
      this.supabase.service,
      'factura_recibida',
      'pdf_url',
      {
        mensajeAusente:
          `Columna factura_recibida.pdf_url no existe todavía: las facturas ` +
          `recibidas van sin PDF hasta aplicar la migración ${MIGRACION_PDF_RECIBIDA}`,
      },
    ).disponible();
  }

  /**
   * ¿Existen ya `factura_recibida.serie/folio/folio_releido_at`? (migración
   * 20261005000002; sonda ÚNICA `common/serie-folio-recibida-disponible`).
   */
  private conSerieFolioRecibida(): Promise<boolean> {
    return serieFolioRecibidaDisponible(this.supabase.service);
  }

  /** Columnas de `factura_recibida` según lo que exista en la BD. */
  private async colsRecibida(): Promise<string> {
    const [conPdf, conSerie] = await Promise.all([
      this.conPdfRecibida(),
      this.conSerieFolioRecibida(),
    ]);
    // ADITIVAS y al final: `pdf_url` (20260923000001) y `serie`, `folio`
    // (20261005000002, 5-oct-2026: número de la factura del proveedor).
    return `${RECIBIDA_COLS}${conPdf ? ', pdf_url' : ''}${conSerie ? ', serie, folio' : ''}`;
  }

  /** Sube un XML recibido: lo parsea, lo guarda en Storage e inserta la fila. */
  async crearRecibida(xmlB64: string, userId: string) {
    const p = await this.pyservices.parseFacturaRecibida(xmlB64);
    const nombre = (p.uuid_fiscal ?? randomUUID()).replace(
      /[^a-zA-Z0-9-]/g,
      '',
    );
    const path = `recibidas/${nombre}.xml`;
    const { error: upErr } = await this.supabase.service.storage
      .from('facturas')
      .upload(path, Buffer.from(xmlB64, 'base64'), {
        contentType: 'application/xml',
        upsert: true,
      });
    if (upErr) throw new Error(`No se pudo guardar el XML: ${upErr.message}`);

    const { data, error } = await this.supabase.service
      .from('factura_recibida')
      .insert({
        uuid_fiscal: p.uuid_fiscal,
        emisor_rfc: p.emisor_rfc,
        emisor_nombre: p.emisor_nombre,
        receptor_rfc: p.receptor_rfc,
        receptor_nombre: p.receptor_nombre,
        tipo_comprobante: p.tipo_comprobante,
        subtotal: p.subtotal,
        total: p.total,
        moneda: p.moneda,
        fecha_emision: p.fecha_emision,
        conceptos_resumen: p.conceptos_resumen,
        xml_url: path,
        // ADITIVOS (5-oct-2026): serie/folio del CFDI, ya leídos del XML.
        ...camposSerieFolioInsert(
          p as unknown as Record<string, unknown>,
          await this.conSerieFolioRecibida(),
          new Date().toISOString(),
        ),
        created_by: userId,
        updated_by: userId,
      })
      .select(await this.colsRecibida())
      .maybeSingle();
    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('Esa factura (UUID) ya está registrada.');
      }
      throw new Error(error.message);
    }
    return data;
  }

  async listRecibidas(filters: {
    estado?: string;
    limit: number;
    offset: number;
  }) {
    let q = this.supabase.service
      .from('factura_recibida')
      .select(
        `${await this.colsRecibida()}, gasto:gasto_id(id, categoria, monto, moneda), aeronave:aeronave_id(matricula), ${RECIBIDA_EMBED_GASTOS}`,
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.estado) q = q.eq('estado', filters.estado);
    // INICIO OFICIAL (invariante 86): sin fecha de emisión (aún sin leer)
    // siguen visibles.
    const inicio = await inicioOficialDe(this.configuracion);
    if (inicio) {
      q = q.or(`fecha_emision.is.null,fecha_emision.gte.${corteTs(inicio)}`);
    }
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    // Gastos que ampara como factura ADICIONAL (puente, 16-oct-2026).
    await this.anexarGastosDeLaPuente(
      (data ?? []) as unknown as Array<Record<string, unknown>>,
    );
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async updateRecibida(id: string, dto: UpdateRecibidaDto, userId: string) {
    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.gasto_id !== undefined) patch.gasto_id = dto.gasto_id;
    if (dto.aeronave_id !== undefined) patch.aeronave_id = dto.aeronave_id;
    if (dto.categoria_sugerida !== undefined)
      patch.categoria_sugerida = dto.categoria_sugerida;
    if (dto.notas !== undefined) patch.notas = dto.notas;
    if (dto.estado !== undefined) patch.estado = dto.estado;
    // Amarrar a un gasto marca la factura como clasificada (si no se indicó estado).
    else if (dto.gasto_id) patch.estado = 'CLASIFICADA';

    const { data, error } = await this.supabase.service
      .from('factura_recibida')
      .update(patch)
      .eq('id', id)
      .select(await this.colsRecibida())
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Factura recibida ${id} not found`);

    // VARIAS FACTURAS POR GASTO (16-oct-2026, invariante 87): con la puente,
    // «reasignar el gasto» de ESTA factura = sus ligas quedan en exactamente
    // ese gasto (o en ninguno), promoviendo otra principal en los gastos que
    // la pierden y SIN reemplazar la principal del gasto que la recibe.
    if (dto.gasto_id !== undefined && (await this.conVariasFacturas())) {
      await this.sincronizarGastosDeFactura(
        id,
        dto.gasto_id ? [dto.gasto_id] : [],
        userId,
      );
      return data;
    }

    // Al reasignar/quitar el gasto, desamarra los anteriores (misma lógica
    // que amarrarGastos). El estatus_comprobante NO se toca: registra qué
    // entregó el piloto; el seguimiento "¿ya facturé?" vive en
    // estatus_facturacion y lo sincroniza el trigger de la BD con el amarre.
    if (dto.gasto_id !== undefined) {
      let unlink = this.supabase.service
        .from('gasto')
        .update({
          factura_recibida_id: null,
          updated_by: userId,
        })
        .eq('factura_recibida_id', id);
      if (dto.gasto_id) unlink = unlink.neq('id', dto.gasto_id);
      const { error: uErr } = await unlink;
      if (uErr) throw new Error(uErr.message);
    }

    // El gasto amarrado (camino legacy 1:1): el trigger lo marca FACTURADA.
    if (dto.gasto_id) {
      const { error: lErr } = await this.supabase.service
        .from('gasto')
        .update({
          factura_recibida_id: id,
          updated_by: userId,
        })
        .eq('id', dto.gasto_id);
      if (lErr) throw new Error(lErr.message);
    }
    return data;
  }

  /**
   * Amarra una factura recibida a VARIOS gastos (una factura de VIP SAESA
   * ampara varios aterrizajes/servicios). Reemplaza el amarre anterior: los
   * gastos fuera de la lista se desamarran y los de la lista quedan
   * `estatus_facturacion = FACTURADA` (lo pone el trigger
   * `gasto_sync_facturacion`, incluso desde NO_FACTURABLE: si hay factura,
   * está facturado). `estatus_comprobante` NO se toca — es el registro de
   * qué papel entregó quien capturó, y desde el 14-sep-2026 solo se lee como
   * «con / sin comprobante» (`src/common/comprobante.util.ts`). Lista vacía =
   * desamarrar todo.
   *
   * Con la puente (16-oct-2026, invariante 87) «reemplaza» se refiere a los
   * GASTOS de esta factura, nunca a las OTRAS facturas de cada gasto: un
   * gasto que ya tenía otra principal la conserva y esta se le AGREGA; un
   * gasto que sale y tenía más facturas promueve la siguiente.
   */
  async amarrarGastos(recibidaId: string, gastoIds: string[], userId: string) {
    const { data: recibida, error: rErr } = await this.supabase.service
      .from('factura_recibida')
      .select('id')
      .eq('id', recibidaId)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    if (!recibida)
      throw new NotFoundException(`Factura recibida ${recibidaId} not found`);

    if (await this.conVariasFacturas()) {
      await this.sincronizarGastosDeFactura(recibidaId, gastoIds, userId);
    } else {
      // Desamarra los gastos que ya no están en la lista. estatus_comprobante
      // NO se toca (es el registro de qué entregó el piloto); el trigger de la
      // BD regresa estatus_facturacion a PENDIENTE al quitar el amarre.
      let unlink = this.supabase.service
        .from('gasto')
        .update({
          factura_recibida_id: null,
          updated_by: userId,
        })
        .eq('factura_recibida_id', recibidaId);
      if (gastoIds.length > 0) {
        unlink = unlink.not('id', 'in', `(${gastoIds.join(',')})`);
      }
      const { error: uErr } = await unlink;
      if (uErr) throw new Error(uErr.message);

      if (gastoIds.length > 0) {
        // El trigger marca FACTURADA los gastos que reciben el amarre.
        const { error: lErr } = await this.supabase.service
          .from('gasto')
          .update({
            factura_recibida_id: recibidaId,
            updated_by: userId,
          })
          .in('id', gastoIds);
        if (lErr) throw new Error(lErr.message);
      }
    }

    const { data, error } = await this.supabase.service
      .from('factura_recibida')
      .update({
        estado: gastoIds.length > 0 ? 'CLASIFICADA' : 'SIN_CLASIFICAR',
        gasto_id: gastoIds[0] ?? null, // legacy 1:1
        updated_by: userId,
      })
      .eq('id', recibidaId)
      .select(`${await this.colsRecibida()}, ${RECIBIDA_EMBED_GASTOS}`)
      .maybeSingle();
    if (error) throw new Error(error.message);
    await this.anexarGastosDeLaPuente(
      data ? [data as unknown as Record<string, unknown>] : [],
    );
    return data!;
  }

  // ======= Varias facturas por gasto (16-oct-2026, invariante 87) =======

  /** ¿Está aplicada la migración 20261016000003? (sonda memorizada). */
  private conVariasFacturas(): Promise<boolean> {
    return gastoFacturasDisponible(this.supabase.service);
  }

  /** Gastos ligados HOY a una factura: puente ∪ principal (red). */
  private async gastosDeFactura(facturaId: string): Promise<string[]> {
    const ids = new Set(
      (await ligasDeFacturas(this.supabase.service, [facturaId])).map(
        (l) => l.gasto_id,
      ),
    );
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('id')
      .eq('factura_recibida_id', facturaId);
    if (error) throw new Error(error.message);
    for (const g of (data ?? []) as Array<{ id: string }>) ids.add(g.id);
    return [...ids];
  }

  /**
   * SUELTA una factura de UN gasto (con la puente). Orden que sostiene la
   * invariante «principal ⇒ fila en la puente» en TODO momento: (1) si era
   * la principal, el gasto pasa a la siguiente liga más antigua (o a null ⇒
   * el trigger lo regresa a PENDIENTE), con CAS sobre la principal; (2)
   * DESPUÉS se quita la fila de la puente. Devuelve la principal que quedó.
   */
  private async soltarFacturaDeGasto(
    facturaId: string,
    gastoId: string,
    userId: string,
  ): Promise<{ principal: string | null }> {
    const { data: g, error: gErr } = await this.supabase.service
      .from('gasto')
      .select('id, factura_recibida_id')
      .eq('id', gastoId)
      .maybeSingle();
    if (gErr) throw new Error(gErr.message);
    if (!g) return { principal: null };
    let principal = (g.factura_recibida_id as string | null) ?? null;
    if (principal === facturaId) {
      const ligas = await ligasDeGastos(this.supabase.service, [gastoId]);
      const siguiente = siguientePrincipal(ligas, facturaId);
      const { data: upd, error: uErr } = await this.supabase.service
        .from('gasto')
        .update({ factura_recibida_id: siguiente, updated_by: userId })
        .eq('id', gastoId)
        .eq('factura_recibida_id', facturaId)
        .select('id');
      if (uErr) throw new Error(uErr.message);
      if (((upd ?? []) as unknown[]).length === 0) {
        throw new ConflictException({
          message:
            'Las facturas de este gasto cambiaron mientras tanto. Recarga y vuelve a intentarlo.',
          error: 'GASTO_FACTURAS_CAMBIARON',
        });
      }
      principal = siguiente;
    }
    const { error: dErr } = await this.supabase.service
      .from('gasto_factura_recibida')
      .delete()
      .eq('gasto_id', gastoId)
      .eq('factura_recibida_id', facturaId);
    if (dErr) throw new Error(dErr.message);
    // Carrera (dos personas quitando facturas del MISMO gasto a la vez): si
    // entretanto otra petición PROMOVIÓ justo esta factura a principal, la
    // fila se repone (la invariante no se rompe) y se avisa con 409.
    const { data: g2, error: g2Err } = await this.supabase.service
      .from('gasto')
      .select('factura_recibida_id')
      .eq('id', gastoId)
      .maybeSingle();
    if (g2Err) throw new Error(g2Err.message);
    if (g2?.factura_recibida_id === facturaId) {
      await this.ligarFacturaAGasto(facturaId, gastoId, userId);
      throw new ConflictException({
        message:
          'Las facturas de este gasto cambiaron mientras tanto. Recarga y vuelve a intentarlo.',
        error: 'GASTO_FACTURAS_CAMBIARON',
      });
    }
    return { principal };
  }

  /**
   * LIGA una factura a UN gasto (con la puente), ADITIVO: la fila de la
   * puente y, SOLO si el gasto no tiene principal, la principal (CAS
   * `is null`: dos subidas simultáneas no se pisan). El trigger
   * `gasto_sync_facturacion` lo deja FACTURADA al recibir la principal.
   */
  private async ligarFacturaAGasto(
    facturaId: string,
    gastoId: string,
    userId: string,
  ): Promise<void> {
    const { error: iErr } = await this.supabase.service
      .from('gasto_factura_recibida')
      .upsert(
        {
          gasto_id: gastoId,
          factura_recibida_id: facturaId,
          created_by: userId,
        },
        { onConflict: 'gasto_id,factura_recibida_id', ignoreDuplicates: true },
      );
    if (iErr) throw new Error(iErr.message);
    const { error: pErr } = await this.supabase.service
      .from('gasto')
      .update({ factura_recibida_id: facturaId, updated_by: userId })
      .eq('id', gastoId)
      .is('factura_recibida_id', null);
    if (pErr) throw new Error(pErr.message);
  }

  /**
   * Deja la factura ligada EXACTAMENTE a `gastoIds` (con la puente): suelta
   * los que salen (promoviendo otra principal donde haga falta) y liga los
   * que entran sin tocar la principal que ya tuvieran. Ids de gastos que no
   * existen se ignoran (como el `update … in` de siempre).
   */
  private async sincronizarGastosDeFactura(
    facturaId: string,
    gastoIds: string[],
    userId: string,
  ): Promise<void> {
    const quedan = new Set(gastoIds);
    for (const gid of await this.gastosDeFactura(facturaId)) {
      if (!quedan.has(gid)) {
        await this.soltarFacturaDeGasto(facturaId, gid, userId);
      }
    }
    if (gastoIds.length === 0) return;
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('id')
      .in('id', [...quedan]);
    if (error) throw new Error(error.message);
    for (const g of (data ?? []) as Array<{ id: string }>) {
      await this.ligarFacturaAGasto(facturaId, g.id, userId);
    }
  }

  /**
   * `gastos` de las respuestas de recibidas (buzón, «Ver factura», amarrar)
   * con la puente: además de los gastos donde es la PRINCIPAL (el embed de
   * siempre), los que ampara como factura adicional. Mismo shape por
   * elemento; sin la migración no hace nada.
   */
  private async anexarGastosDeLaPuente(
    filas: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (filas.length === 0 || !(await this.conVariasFacturas())) return;
    const ligas = await ligasDeFacturas(
      this.supabase.service,
      filas.map((f) => String(f.id)),
    );
    const faltan = new Map<string, Set<string>>();
    for (const f of filas) {
      const ya = new Set(
        ((f.gastos as Array<{ id: string }> | null) ?? []).map((g) => g.id),
      );
      for (const l of ligas) {
        if (l.factura_recibida_id !== f.id || ya.has(l.gasto_id)) continue;
        const s = faltan.get(String(f.id)) ?? new Set<string>();
        s.add(l.gasto_id);
        faltan.set(String(f.id), s);
      }
    }
    const ids = [...new Set([...faltan.values()].flatMap((s) => [...s]))];
    if (ids.length === 0) return;
    const gastos = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await this.supabase.service
        .from('gasto')
        .select('id, categoria, monto, moneda, fecha_gasto, vuelo_id, lugar')
        .in('id', ids.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const g of (data ?? []) as Array<Record<string, unknown>>)
        gastos.set(String(g.id), g);
    }
    for (const f of filas) {
      const extra = [...(faltan.get(String(f.id)) ?? [])]
        .map((id) => gastos.get(id))
        .filter((g): g is Record<string, unknown> => !!g);
      if (extra.length === 0) continue;
      f.gastos = [
        ...((f.gastos as Array<Record<string, unknown>> | null) ?? []),
        ...extra,
      ];
    }
  }

  /**
   * Huellas de los PDF que ya tiene ESTE gasto y se subieron antes de la
   * migración (pdf_sha256 null): se calculan descargando el PDF y se
   * GUARDAN (best-effort; un fallo de Storage no tumba la subida). Así «el
   * mismo PDF otra vez» se reconoce también contra las facturas viejas del
   * gasto (caso FCUN-1299718 de Mary).
   */
  private async asegurarHuellasDelGasto(facturaIds: string[]): Promise<void> {
    if (facturaIds.length === 0) return;
    const { data, error } = await this.supabase.service
      .from('factura_recibida')
      .select('id, pdf_url, pdf_sha256')
      .in('id', facturaIds)
      .is('pdf_sha256', null)
      .not('pdf_url', 'is', null);
    if (error) throw new Error(error.message);
    for (const f of (data ?? []) as Array<{ id: string; pdf_url: string }>) {
      try {
        const { data: blob, error: dErr } = await this.supabase.service.storage
          .from('facturas')
          .download(f.pdf_url);
        if (dErr || !blob) continue;
        const sha = sha256Hex(Buffer.from(await blob.arrayBuffer()));
        await this.supabase.service
          .from('factura_recibida')
          .update({ pdf_sha256: sha })
          .eq('id', f.id)
          .is('pdf_sha256', null);
      } catch (e) {
        this.logger.warn(
          `No se pudo calcular la huella del PDF de la factura ${f.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /**
   * «SUBIR LA FACTURA DE **ESTE** GASTO» (22-sep-2026, palabras del cliente:
   * «en los registros de gastos, además de la opción facturada (a un lado)
   * agregar la opción para subir la factura correspondiente de dicho
   * gasto»).
   *
   * Antes hacían falta DOS llamadas (`POST recibidas` con el XML y luego
   * `amarrar-gastos`) y el PDF no tenía dónde guardarse. Aquí se registra la
   * factura Y se amarra el gasto en una sola operación, con tres diferencias
   * deliberadas respecto de `amarrarGastos`:
   *
   *  1. **El amarre es ADITIVO**: solo toca ESTE gasto. `amarrarGastos`
   *     REEMPLAZA la lista completa — usarlo desde la fila de un gasto
   *     desamarraría en silencio los demás gastos que ampara la misma
   *     factura (el caso VIP SAESA: una factura, varios aterrizajes).
   *  2. **El XML es OPCIONAL**: hay proveedores que solo mandan el PDF. Esa
   *     factura entra con `uuid_fiscal` null (la columna es única pero
   *     admite varios nulos) y sirve igual para marcar el gasto FACTURADA.
   *  3. **Un UUID ya registrado NO es un error**: es la MISMA factura
   *     amparando otro gasto. Se reutiliza la fila existente y se responde
   *     `ya_existia: true` (antes: 409 y callejón sin salida). Si esa fila no
   *     tenía PDF y ahora llega, el PDF SE GUARDA (16-oct-2026).
   *
   * VARIAS FACTURAS (16-oct-2026, invariante 87; ASA entrega 5 CFDI por
   * carga): `archivos[]` (1–10) = una factura por elemento. Con la migración
   * `20261016000003` cada factura se LIGA en la puente y se AGREGA a las que
   * el gasto ya tenga (la primera queda como principal si no había; nunca se
   * reemplaza). Deduplicación: por UUID fiscal y, para PDF sin XML, por la
   * huella SHA-256 del PDF (mismo PDF ⇒ misma fila); el mismo archivo dos
   * veces en un envío ⇒ una sola factura; reintentar un envío es seguro.
   * Sin la migración: conducta 0.0.85 (una factura, la nueva REEMPLAZA a la
   * principal) y más de un elemento ⇒ 503 `FACTURAS_GASTO_NO_DISPONIBLE`.
   *
   * Quien marca el gasto como FACTURADA sigue siendo el trigger de la BD
   * `gasto_sync_facturacion` al recibir el amarre; `estatus_comprobante` no
   * se toca (es el registro de qué papel entregó quien capturó).
   */
  async crearRecibidaDeGasto(
    dto: {
      gasto_id: string;
      xml_b64?: string;
      pdf_b64?: string;
      pdf_nombre?: string;
      archivos?: Array<{ xml_b64?: string; pdf_b64?: string; nombre?: string }>;
    },
    userId: string,
  ) {
    // 1) Normaliza: `archivos[]` o el shape viejo (= un solo elemento).
    const limpio = (v?: string) => (v ?? '').trim();
    let entradas: Array<{ xml: string; pdf: string; nombre: string | null }>;
    if (dto.archivos !== undefined) {
      if (
        limpio(dto.xml_b64) ||
        limpio(dto.pdf_b64) ||
        limpio(dto.pdf_nombre)
      ) {
        throw new BadRequestException(
          'Manda los archivos en «archivos» o un solo XML/PDF, no las dos cosas.',
        );
      }
      if (
        dto.archivos.length === 0 ||
        dto.archivos.length > MAX_ARCHIVOS_GASTO
      ) {
        throw new BadRequestException(
          `Sube entre 1 y ${MAX_ARCHIVOS_GASTO} facturas a la vez.`,
        );
      }
      entradas = dto.archivos.map((a, i) => {
        const xml = limpio(a.xml_b64);
        const pdf = limpio(a.pdf_b64);
        if (!xml && !pdf) {
          throw new BadRequestException(
            `El archivo #${i + 1} no trae ni el XML ni el PDF de la factura.`,
          );
        }
        return { xml, pdf, nombre: limpio(a.nombre) || null };
      });
    } else {
      const xml = limpio(dto.xml_b64);
      const pdf = limpio(dto.pdf_b64);
      if (!xml && !pdf) {
        throw new BadRequestException(
          'Sube al menos un archivo: el XML del CFDI o el PDF de la factura.',
        );
      }
      entradas = [{ xml, pdf, nombre: limpio(dto.pdf_nombre) || null }];
    }

    const conPdf = await this.conPdfRecibida();
    if (entradas.some((e) => e.pdf) && !conPdf) {
      throw new ConflictException({
        message:
          'Guardar el PDF de la factura todavía no está habilitado en la ' +
          'base de datos (falta aplicar la migración). Sube el XML por ' +
          'ahora, o vuelve a intentarlo en unos minutos.',
        error: 'PDF_FACTURA_NO_DISPONIBLE',
        details: { migracion: MIGRACION_PDF_RECIBIDA },
      });
    }
    const varias = await this.conVariasFacturas();
    if (!varias && entradas.length > 1) throw errorFacturasGastoNoDisponible();

    const { data: gasto, error: gErr } = await this.supabase.service
      .from('gasto')
      .select('id, factura_recibida_id, monto, moneda')
      .eq('id', dto.gasto_id)
      .maybeSingle();
    if (gErr) throw new Error(gErr.message);
    if (!gasto) {
      throw new NotFoundException(`Gasto ${dto.gasto_id} not found`);
    }

    // 2) Con XML: se parsea ANTES de subir nada (si un CFDI no es legible, no
    //    queda basura en el bucket ni facturas a medias del envío).
    const leidos: ArchivoLeido[] = [];
    for (const [i, e] of entradas.entries()) {
      const parse = e.xml
        ? ((await this.pyservices.parseFacturaRecibida(
            e.xml,
          )) as unknown as Record<string, unknown>)
        : null;
      const uuid =
        typeof parse?.uuid_fiscal === 'string' && parse.uuid_fiscal
          ? parse.uuid_fiscal
          : null;
      leidos.push({
        indice: i,
        xml_b64: e.xml || null,
        pdf_b64: e.pdf || null,
        nombre: e.nombre,
        uuid,
        pdf_sha256: e.pdf ? sha256Hex(Buffer.from(e.pdf, 'base64')) : null,
        xml_sha256: e.xml ? sha256Hex(Buffer.from(e.xml, 'base64')) : null,
        parse,
      });
    }
    const grupos = agruparArchivos(leidos);

    // 3) Ligas previas del gasto (para «ya estaba en este gasto»).
    const principalPrevia =
      (gasto.factura_recibida_id as string | null) ?? null;
    const previas = new Set<string>(
      varias
        ? (await ligasDeGastos(this.supabase.service, [dto.gasto_id])).map(
            (l) => l.factura_recibida_id,
          )
        : [],
    );
    if (principalPrevia) previas.add(principalPrevia);
    if (varias && grupos.some((g) => g.pdf_b64)) {
      await this.asegurarHuellasDelGasto([...previas]);
    }

    // 4) Cada grupo ⇒ UNA factura (reutilizada o nueva) ligada al gasto.
    const detalle: DetalleFacturaSubida[] = [];
    for (const g of grupos) {
      const r = await this.resolverFacturaDeGrupo(
        g,
        dto.gasto_id,
        userId,
        conPdf,
        varias,
      );
      const yaEnEsteGasto = previas.has(r.id);
      if (varias) {
        // Idempotente (upsert + principal solo si falta): también repara un
        // gasto con ligas y sin principal (p. ej. tras un rollback a 0.0.85).
        await this.ligarFacturaAGasto(r.id, dto.gasto_id, userId);
        await this.marcarEspejoYEstado(r.id, dto.gasto_id, userId);
      } else {
        // Conducta 0.0.85: la factura queda como LA del gasto.
        await this.amarrarGastoAdicional(r.id, dto.gasto_id, userId);
      }
      previas.add(r.id);
      detalle.push({
        archivos: g.indices,
        factura_id: r.id,
        resultado: yaEnEsteGasto
          ? 'YA_EN_ESTE_GASTO'
          : r.creada
            ? 'NUEVA'
            : 'EXISTENTE',
        pdf_agregado: r.pdf_agregado,
        xml_agregado: r.xml_agregado,
        ya_existia: !r.creada,
      });
    }

    // 5) Respuesta: la de siempre (primera factura + `ya_existia`) + lo nuevo.
    const primera = detalle[0];
    const { data: gastoDespues, error: g2Err } = await this.supabase.service
      .from('gasto')
      .select('id, factura_recibida_id, monto, moneda')
      .eq('id', dto.gasto_id)
      .maybeSingle();
    if (g2Err) throw new Error(g2Err.message);
    const det = await detalleFacturasDeGasto(this.supabase.service, {
      id: dto.gasto_id,
      factura_recibida_id:
        ((gastoDespues ?? gasto).factura_recibida_id as string | null) ?? null,
      monto: (gastoDespues ?? gasto).monto,
      moneda: (gastoDespues ?? gasto).moneda,
    });
    return {
      ...(await this.recibidaPorId(primera.factura_id)),
      ya_existia: primera.ya_existia,
      facturas: det.facturas,
      agregadas: detalle.filter((d) => d.resultado !== 'YA_EN_ESTE_GASTO')
        .length,
      ya_existian: detalle.filter((d) => d.resultado === 'YA_EN_ESTE_GASTO')
        .length,
      avisos: det.avisos,
      detalle,
      facturas_multiples: varias,
    };
  }

  /**
   * UNA factura del envío ⇒ su fila en el buzón: reutiliza por UUID fiscal
   * (y le guarda el PDF si no lo tenía), o —con la migración— por la huella
   * del PDF (un PDF sin XML ya subido; si ahora llega con su XML, la fila se
   * COMPLETA con los datos del CFDI en vez de duplicarse); si no, la crea.
   * Nada a medias: si la fila no entra, los archivos subidos se retiran.
   */
  private async resolverFacturaDeGrupo(
    g: GrupoFactura,
    gastoId: string,
    userId: string,
    conPdf: boolean,
    varias: boolean,
  ): Promise<{
    id: string;
    creada: boolean;
    pdf_agregado: boolean;
    xml_agregado: boolean;
  }> {
    const sb = this.supabase.service;
    const p = g.parse;
    const subir = async (
      path: string,
      b64: string,
      tipo: 'application/xml' | 'application/pdf',
    ) => {
      const { error } = await sb.storage
        .from('facturas')
        .upload(path, Buffer.from(b64, 'base64'), {
          contentType: tipo,
          upsert: true,
        });
      if (error)
        throw new Error(
          `No se pudo guardar el ${tipo === 'application/xml' ? 'XML' : 'PDF'}: ${error.message}`,
        );
    };

    // a) ¿Ese CFDI ya estaba en el buzón? Entonces solo se le suma el gasto
    //    (y el PDF que le faltaba).
    const porUuid = async () => {
      if (!g.uuid) return null;
      const { data, error } = await sb
        .from('factura_recibida')
        .select(conPdf ? 'id, pdf_url' : 'id')
        .eq('uuid_fiscal', g.uuid)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { id: string; pdf_url?: string | null } | null) ?? null;
    };
    const previa = await porUuid();
    if (previa) {
      const pdfAgregado = await this.guardarPdfFaltante(
        previa,
        g,
        conPdf,
        varias,
        userId,
      );
      return {
        id: previa.id,
        creada: false,
        pdf_agregado: pdfAgregado,
        xml_agregado: false,
      };
    }

    // b) Con la migración: el MISMO PDF ya está en el buzón.
    if (varias && g.pdf_sha256) {
      const { data, error } = await sb
        .from('factura_recibida')
        .select('id, uuid_fiscal, notas')
        .eq('pdf_sha256', g.pdf_sha256)
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) throw new Error(error.message);
      const mismo = (
        (data ?? []) as Array<{
          id: string;
          uuid_fiscal: string | null;
          notas: string | null;
        }>
      )[0];
      if (mismo) {
        // PDF sin XML subido antes y AHORA llega su XML: se completa la fila.
        if (g.xml_b64 && g.uuid && !mismo.uuid_fiscal) {
          const xmlPath = `recibidas/${this.baseArchivo(g.uuid)}.xml`;
          await subir(xmlPath, g.xml_b64, 'application/xml');
          const { data: upd, error: uErr } = await sb
            .from('factura_recibida')
            .update({
              ...this.camposDelCfdi(p),
              ...camposSerieFolioInsert(
                p,
                await this.conSerieFolioRecibida(),
                new Date().toISOString(),
              ),
              xml_url: xmlPath,
              // La nota «Factura en PDF (sin XML)» deja de ser cierta; una
              // nota escrita por la oficina se conserva.
              ...((mismo.notas ?? '').startsWith(PREFIJO_NOTA_PDF_SIN_XML)
                ? { notas: null }
                : {}),
              updated_by: userId,
            })
            .eq('id', mismo.id)
            .is('uuid_fiscal', null)
            .select('id');
          if (uErr) {
            if (uErr.code === '23505') {
              // Carrera: el UUID entró por otro lado ⇒ esa fila.
              const otra = await porUuid();
              if (otra)
                return {
                  id: otra.id,
                  creada: false,
                  pdf_agregado: false,
                  xml_agregado: false,
                };
            }
            throw new Error(uErr.message);
          }
          if (((upd ?? []) as unknown[]).length > 0) {
            return {
              id: mismo.id,
              creada: false,
              pdf_agregado: false,
              xml_agregado: true,
            };
          }
          const otra = await porUuid();
          if (otra)
            return {
              id: otra.id,
              creada: false,
              pdf_agregado: false,
              xml_agregado: false,
            };
        } else if (!g.xml_b64 || mismo.uuid_fiscal === g.uuid) {
          return {
            id: mismo.id,
            creada: false,
            pdf_agregado: false,
            xml_agregado: false,
          };
        }
        // Mismo PDF pero OTRO CFDI (raro): se registra aparte.
      }
    }

    // c) Factura nueva. Base del nombre en Storage: el UUID fiscal (identifica
    //    al CFDI) o uno propio para las facturas que llegan solo en PDF.
    const base = this.baseArchivo(g.uuid ?? randomUUID());
    const subidos: string[] = [];
    let xmlPath: string | null = null;
    let pdfPath: string | null = null;
    try {
      if (g.xml_b64) {
        xmlPath = `recibidas/${base}.xml`;
        await subir(xmlPath, g.xml_b64, 'application/xml');
        subidos.push(xmlPath);
      }
      if (g.pdf_b64) {
        pdfPath = `recibidas/${base}.pdf`;
        await subir(pdfPath, g.pdf_b64, 'application/pdf');
        subidos.push(pdfPath);
      }
      const notas = !p ? notaPdfSinXml(g.nombre) : null;
      const { data, error } = await sb
        .from('factura_recibida')
        .insert({
          ...this.camposDelCfdi(p),
          xml_url: xmlPath,
          ...(conPdf ? { pdf_url: pdfPath } : {}),
          ...(varias && pdfPath ? { pdf_sha256: g.pdf_sha256 } : {}),
          // ADITIVOS (5-oct-2026): serie/folio del CFDI (solo con XML).
          ...camposSerieFolioInsert(
            p,
            await this.conSerieFolioRecibida(),
            new Date().toISOString(),
          ),
          // Nace amarrada: llegó desde la fila de un gasto concreto.
          estado: 'CLASIFICADA',
          gasto_id: gastoId,
          notas,
          created_by: userId,
          updated_by: userId,
        })
        .select('id')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') {
          // Con la puente, una carrera por el MISMO UUID se resuelve
          // reutilizando la fila (es la misma factura); sin ella, el 409 de
          // siempre.
          const otra = varias ? await porUuid() : null;
          if (otra) {
            // Los archivos subidos usan el path del CFDI: son de esa fila.
            return {
              id: otra.id,
              creada: false,
              pdf_agregado: false,
              xml_agregado: false,
            };
          }
          throw new ConflictException('Esa factura (UUID) ya está registrada.');
        }
        throw new Error(error.message);
      }
      return {
        id: (data as { id: string }).id,
        creada: true,
        pdf_agregado: false,
        xml_agregado: false,
      };
    } catch (e) {
      // Nada a medias: la fila NO entró ⇒ los archivos no se quedan. (Con
      // UUID el path es el del CFDI: si otra fila ya lo usa, no se retira.)
      if (subidos.length > 0 && !(e instanceof ConflictException && g.uuid)) {
        const { error } = await sb.storage.from('facturas').remove(subidos);
        if (error) {
          this.logger.warn(
            `Factura del gasto ${gastoId} falló y no se pudieron borrar ${subidos.join(', ')}: ${error.message}`,
          );
        }
      }
      throw e;
    }
  }

  /** Base del nombre en Storage (sin caracteres raros). */
  private baseArchivo(s: string): string {
    return s.replace(/[^a-zA-Z0-9-]/g, '');
  }

  /** Campos del CFDI parseado para insertar/completar la fila. */
  private camposDelCfdi(p: Record<string, unknown> | null) {
    const v = (k: string): unknown => p?.[k] ?? null;
    return {
      uuid_fiscal: v('uuid_fiscal'),
      emisor_rfc: v('emisor_rfc'),
      emisor_nombre: v('emisor_nombre'),
      receptor_rfc: v('receptor_rfc'),
      receptor_nombre: v('receptor_nombre'),
      tipo_comprobante: v('tipo_comprobante'),
      subtotal: v('subtotal'),
      total: v('total'),
      moneda: v('moneda'),
      fecha_emision: v('fecha_emision'),
      conceptos_resumen: v('conceptos_resumen'),
    };
  }

  /**
   * `ya_existia` con PDF: si la factura del buzón NO tenía PDF y ahora llega,
   * se GUARDA (antes se descartaba en silencio). CAS `pdf_url is null`: nunca
   * pisa un PDF que ya estaba. Devuelve si se guardó.
   */
  private async guardarPdfFaltante(
    previa: { id: string; pdf_url?: string | null },
    g: GrupoFactura,
    conPdf: boolean,
    varias: boolean,
    userId: string,
  ): Promise<boolean> {
    if (!conPdf || !g.pdf_b64 || previa.pdf_url) return false;
    const pdfPath = `recibidas/${this.baseArchivo(g.uuid ?? previa.id)}.pdf`;
    const { error: upErr } = await this.supabase.service.storage
      .from('facturas')
      .upload(pdfPath, Buffer.from(g.pdf_b64, 'base64'), {
        contentType: 'application/pdf',
        upsert: true,
      });
    if (upErr) throw new Error(`No se pudo guardar el PDF: ${upErr.message}`);
    const { error } = await this.supabase.service
      .from('factura_recibida')
      .update({
        pdf_url: pdfPath,
        ...(varias ? { pdf_sha256: g.pdf_sha256 } : {}),
        updated_by: userId,
      })
      .eq('id', previa.id)
      .is('pdf_url', null);
    if (error) throw new Error(error.message);
    return true;
  }

  /**
   * Espejo legado `factura_recibida.gasto_id` (solo si estaba vacío, para no
   * borrar a cuál se amarró primero) y estado CLASIFICADA.
   */
  private async marcarEspejoYEstado(
    recibidaId: string,
    gastoId: string,
    userId: string,
  ): Promise<void> {
    const { data: fila, error: rErr } = await this.supabase.service
      .from('factura_recibida')
      .select('gasto_id, estado')
      .eq('id', recibidaId)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    const patch: Record<string, unknown> = {};
    if (!fila?.gasto_id) patch.gasto_id = gastoId;
    if (fila?.estado !== 'CLASIFICADA') patch.estado = 'CLASIFICADA';
    if (Object.keys(patch).length === 0) return;
    const { error: uErr } = await this.supabase.service
      .from('factura_recibida')
      .update({ ...patch, updated_by: userId })
      .eq('id', recibidaId);
    if (uErr) throw new Error(uErr.message);
  }

  /**
   * Amarra UN gasto a una factura recibida SIN tocar los demás gastos que ya
   * ampara (a diferencia de `amarrarGastos`, que reemplaza la lista). El
   * trigger `gasto_sync_facturacion` lo deja en FACTURADA. Camino SIN la
   * puente (0.0.85): la factura queda como LA del gasto.
   */
  private async amarrarGastoAdicional(
    recibidaId: string,
    gastoId: string,
    userId: string,
  ): Promise<void> {
    const { error } = await this.supabase.service
      .from('gasto')
      .update({ factura_recibida_id: recibidaId, updated_by: userId })
      .eq('id', gastoId);
    if (error) throw new Error(error.message);
    // `gasto_id` es el espejo legado 1:1: solo se llena si estaba vacío para
    // no borrar a cuál se amarró primero.
    const { data: fila, error: rErr } = await this.supabase.service
      .from('factura_recibida')
      .select('gasto_id, estado')
      .eq('id', recibidaId)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    const patch: Record<string, unknown> = { updated_by: userId };
    if (!fila?.gasto_id) patch.gasto_id = gastoId;
    if (fila?.estado !== 'CLASIFICADA') patch.estado = 'CLASIFICADA';
    const { error: uErr } = await this.supabase.service
      .from('factura_recibida')
      .update(patch)
      .eq('id', recibidaId);
    if (uErr) throw new Error(uErr.message);
  }

  /**
   * «QUITAR DE ESTE GASTO» (16-oct-2026, invariante 87): quita la liga de la
   * factura con ESE gasto. NO borra la factura (sigue en el buzón y en los
   * demás gastos que ampare). Si era la principal, el gasto pasa a la
   * siguiente (la liga más antigua) o se queda sin factura (el trigger lo
   * regresa a PENDIENTE). El espejo legado `factura_recibida.gasto_id` que
   * apuntaba a ese gasto pasa a otro gasto ligado o a null (y la factura sin
   * ningún gasto vuelve a SIN_CLASIFICAR, como `amarrarGastos([])`).
   * Funciona también sin la migración (quita la principal).
   */
  async quitarFacturaDeGasto(
    facturaId: string,
    gastoId: string,
    userId: string,
  ) {
    const sb = this.supabase.service;
    const { data: gasto, error: gErr } = await sb
      .from('gasto')
      .select('id, factura_recibida_id')
      .eq('id', gastoId)
      .maybeSingle();
    if (gErr) throw new Error(gErr.message);
    if (!gasto) throw new NotFoundException(`Gasto ${gastoId} not found`);
    const { data: factura, error: fErr } = await sb
      .from('factura_recibida')
      .select('id, gasto_id')
      .eq('id', facturaId)
      .maybeSingle();
    if (fErr) throw new Error(fErr.message);
    if (!factura)
      throw new NotFoundException(`Factura recibida ${facturaId} not found`);

    const varias = await this.conVariasFacturas();
    const ligada =
      gasto.factura_recibida_id === facturaId ||
      (varias &&
        (await ligasDeGastos(sb, [gastoId])).some(
          (l) => l.factura_recibida_id === facturaId,
        ));
    if (!ligada) {
      throw new NotFoundException({
        message: 'Esa factura no está ligada a este gasto.',
        error: 'FACTURA_NO_LIGADA',
      });
    }

    let principal: string | null;
    if (varias) {
      principal = (await this.soltarFacturaDeGasto(facturaId, gastoId, userId))
        .principal;
    } else {
      const { data: upd, error: uErr } = await sb
        .from('gasto')
        .update({ factura_recibida_id: null, updated_by: userId })
        .eq('id', gastoId)
        .eq('factura_recibida_id', facturaId)
        .select('id');
      if (uErr) throw new Error(uErr.message);
      if (((upd ?? []) as unknown[]).length === 0) {
        throw new ConflictException({
          message:
            'Las facturas de este gasto cambiaron mientras tanto. Recarga y vuelve a intentarlo.',
          error: 'GASTO_FACTURAS_CAMBIARON',
        });
      }
      principal = null;
    }

    // Espejo legado y estado de la factura.
    const restantes = varias
      ? await this.gastosDeFactura(facturaId)
      : await (async () => {
          const { data, error } = await sb
            .from('gasto')
            .select('id')
            .eq('factura_recibida_id', facturaId);
          if (error) throw new Error(error.message);
          return ((data ?? []) as Array<{ id: string }>).map((g) => g.id);
        })();
    const patch: Record<string, unknown> = {};
    if (restantes.length === 0) {
      patch.gasto_id = null;
      patch.estado = 'SIN_CLASIFICAR';
    } else if (factura.gasto_id === gastoId) {
      const ligasF = varias ? await ligasDeFacturas(sb, [facturaId]) : [];
      const orden = [...restantes].sort((a, b) => {
        const ca = ligasF.find((l) => l.gasto_id === a)?.created_at ?? '';
        const cb = ligasF.find((l) => l.gasto_id === b)?.created_at ?? '';
        return ca === cb ? (a < b ? -1 : 1) : ca < cb ? -1 : 1;
      });
      patch.gasto_id = orden[0];
    }
    if (Object.keys(patch).length > 0) {
      const { error: eErr } = await sb
        .from('factura_recibida')
        .update({ ...patch, updated_by: userId })
        .eq('id', facturaId);
      if (eErr) throw new Error(eErr.message);
    }

    const { data: despues, error: dErr } = await sb
      .from('gasto')
      .select('id, factura_recibida_id, estatus_facturacion, monto, moneda')
      .eq('id', gastoId)
      .maybeSingle();
    if (dErr) throw new Error(dErr.message);
    const det = await detalleFacturasDeGasto(
      sb,
      despues
        ? {
            id: gastoId,
            factura_recibida_id:
              (despues.factura_recibida_id as string | null) ?? null,
            monto: despues.monto,
            moneda: despues.moneda,
          }
        : { id: gastoId, factura_recibida_id: principal },
    );
    return {
      ok: true as const,
      gasto_id: gastoId,
      factura_recibida_id: facturaId,
      principal: despues
        ? ((despues.factura_recibida_id as string | null) ?? null)
        : principal,
      estatus_facturacion:
        (despues?.estatus_facturacion as string | null | undefined) ?? null,
      facturas: det.facturas,
      avisos: det.avisos,
      facturas_multiples: varias,
    };
  }

  /** Una factura recibida con sus gastos amarrados (respuesta canónica). */
  async recibidaPorId(id: string) {
    // string plano: el parser TIPADO de supabase-js no digiere el template
    // con columnas condicionales (truena en compilación, no en runtime) —
    // mismo caso que el embed opcional de `flights.list`.
    const cols: string = `${await this.colsRecibida()}, ${RECIBIDA_EMBED_GASTOS}`;
    const { data, error } = await this.supabase.service
      .from('factura_recibida')
      .select(cols)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Factura recibida ${id} not found`);
    const fila = data as unknown as Record<string, unknown>;
    await this.anexarGastosDeLaPuente([fila]);
    return fila;
  }

  // ===== Relectura del folio de las recibidas ya guardadas (5-oct-2026) =====

  /** Candado en proceso: una relectura a la vez (una instancia de Railway ⇒
   *  el mutex en memoria basta, como los crones de `alerts`). */
  private relecturaFolioEnCurso = false;

  /**
   * RELECTURA DEL FOLIO (5-oct-2026, API 0.0.57, invariante 44). Pedido del
   * cliente: el número de la factura en la columna «Notas» del Excel de
   * conciliación. Las 62 recibidas de prod se registraron cuando el parser
   * no leía `Serie`/`Folio`; este cron relee su XML guardado y las rellena
   * (59 con XML ⇒ ≤ 2 corridas; las 3 solo-PDF no tienen nada que leer).
   *
   * Reglas:
   * - Solo con la migración 20261005000002 (sonda): sin ella, no hace nada.
   * - Toma hasta `RELECTURA_FOLIO_LOTE` filas con `xml_url` y
   *   `folio_releido_at is null` (las más viejas primero).
   * - Leída ⇒ `serie`, `folio`, `folio_releido_at = now()` (con o sin
   *   folio: un CFDI sin Serie/Folio no se reintenta eternamente).
   * - XML ilegible (pyservices 400/422 con `detail` de texto) o ausente en
   *   Storage ⇒ se sella y se anota «Folio no legible del XML» al final de
   *   `notas`, releídas JUSTO antes del UPDATE y con CAS sobre ellas (una
   *   edición de la oficina durante la corrida no se pisa).
   * - pyservices caído/lento/sin configurar (fallo TRANSITORIO) ⇒ esa fila
   *   NO se sella y se sigue con la siguiente; con DOS fallos seguidos
   *   (`cortarRelecturaPorPyservices`) se corta la corrida (todas fallarían
   *   igual). Así un XML que tumba a pyservices no bloquea la cola. Un
   *   pyservices VIEJO (sin las llaves serie/folio) corta de inmediato. Un
   *   error de red de Storage solo salta ESA fila. El siguiente tick
   *   reintenta lo no sellado.
   * - El UPDATE lleva `folio_releido_at is null` (CAS): jamás pisa una fila
   *   que otro camino ya selló.
   * Nunca lanza: un fallo se registra con `warn`.
   */
  @Cron('*/10 * * * *', { name: 'recibidas-releer-folio' })
  async releerFoliosRecibidas(): Promise<ResumenRelecturaFolio | null> {
    if (this.relecturaFolioEnCurso) return null;
    this.relecturaFolioEnCurso = true;
    try {
      return await this.releerFoliosRecibidasLote();
    } catch (err) {
      this.logger.warn(
        `releerFoliosRecibidas falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      this.relecturaFolioEnCurso = false;
    }
  }

  private async releerFoliosRecibidasLote(): Promise<ResumenRelecturaFolio> {
    const resumen: ResumenRelecturaFolio = {
      disponible: false,
      leidas: 0,
      con_folio: 0,
      sin_folio: 0,
      ilegibles: 0,
      reintentar: 0,
    };
    if (!(await this.conSerieFolioRecibida())) return resumen;
    resumen.disponible = true;
    const sb = this.supabase.service;
    const { data, error } = await sb
      .from('factura_recibida')
      .select('id, xml_url')
      .not('xml_url', 'is', null)
      .is('folio_releido_at', null)
      .order('created_at', { ascending: true })
      .limit(RELECTURA_FOLIO_LOTE);
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as Array<{
      id: string;
      xml_url: string | null;
    }>;

    /** UPDATE con CAS; `false` si la BD lo rechazó (se reintenta). */
    const sellar = async (
      id: string,
      patch: Record<string, unknown>,
    ): Promise<boolean> => {
      const { error: uErr } = await sb
        .from('factura_recibida')
        .update(patch)
        .eq('id', id)
        .is('folio_releido_at', null);
      if (uErr) {
        this.logger.warn(
          `Relectura de folio: no se pudo guardar la factura ${id}: ${uErr.message}`,
        );
        return false;
      }
      return true;
    };

    /**
     * Sella una factura ILEGIBLE con la nota al final de `notas`. Las notas
     * se RELEEN justo antes del UPDATE (la corrida tarda minutos: la oficina
     * pudo editarlas con el PATCH de recibidas) y el UPDATE lleva CAS sobre
     * ellas además de `folio_releido_at is null`; si cambiaron en medio, se
     * reintenta una vez. `false` = no se pudo (el siguiente tick reintenta).
     */
    const sellarIlegible = async (id: string): Promise<boolean> => {
      for (let intento = 0; intento < 2; intento += 1) {
        const { data: actual, error: rErr } = await sb
          .from('factura_recibida')
          .select('notas')
          .eq('id', id)
          .is('folio_releido_at', null)
          .maybeSingle();
        if (rErr) {
          this.logger.warn(
            `Relectura de folio: no se pudieron releer las notas de la factura ${id}: ${rErr.message}`,
          );
          return false;
        }
        // Ya la selló otro camino (o se borró): nada que hacer.
        if (!actual) return true;
        const notasLeidas = (actual as { notas?: string | null }).notas ?? null;
        let q = sb
          .from('factura_recibida')
          .update({
            folio_releido_at: new Date().toISOString(),
            notas: notasConFolioNoLegible(notasLeidas),
          })
          .eq('id', id)
          .is('folio_releido_at', null);
        q =
          notasLeidas === null
            ? q.is('notas', null)
            : q.eq('notas', notasLeidas);
        const { data: escritas, error: uErr } = await q.select('id');
        if (uErr) {
          this.logger.warn(
            `Relectura de folio: no se pudo guardar la factura ${id}: ${uErr.message}`,
          );
          return false;
        }
        if ((escritas ?? []).length > 0) return true;
      }
      this.logger.warn(
        `Relectura de folio: las notas de la factura ${id} cambiaron durante la corrida (se reintenta)`,
      );
      return false;
    };

    // Fallos TRANSITORIOS de pyservices seguidos (se reinicia cuando
    // pyservices responde, bien o con un XML ilegible).
    let fallosPyservicesSeguidos = 0;
    for (const fila of filas) {
      if (!fila.xml_url) continue;
      resumen.leidas += 1;
      let parsed: Record<string, unknown>;
      try {
        const b64 = await this.downloadB64('facturas', fila.xml_url);
        try {
          parsed = (await this.pyservices.parseFacturaRecibida(
            b64,
          )) as unknown as Record<string, unknown>;
          fallosPyservicesSeguidos = 0;
        } catch (err) {
          if (clasificarFalloRelectura(err) === 'TRANSITORIO') {
            resumen.reintentar += 1;
            fallosPyservicesSeguidos += 1;
            const motivo = err instanceof Error ? err.message : String(err);
            if (cortarRelecturaPorPyservices(fallosPyservicesSeguidos)) {
              // Caído de verdad: las demás fallarían igual ⇒ siguiente tick.
              this.logger.warn(
                `Relectura de folio pausada (pyservices): ${motivo}`,
              );
              break;
            }
            // Puede ser ESTE XML: se sigue con la siguiente factura.
            this.logger.warn(
              `Relectura de folio: factura ${fila.id} sin leer por pyservices (se reintenta): ${motivo}`,
            );
            continue;
          }
          fallosPyservicesSeguidos = 0;
          throw err;
        }
      } catch (err) {
        if (clasificarFalloRelectura(err) === 'TRANSITORIO') {
          // Storage con un error de red: solo se salta ESTA fila.
          resumen.reintentar += 1;
          this.logger.warn(
            `Relectura de folio: factura ${fila.id} sin leer (se reintenta): ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        const ok = await sellarIlegible(fila.id);
        if (ok) resumen.ilegibles += 1;
        else resumen.reintentar += 1;
        this.logger.warn(
          `Relectura de folio: factura ${fila.id} con XML ilegible: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const sf = serieFolioDelCfdi(parsed);
      if (!sf.leido) {
        // pyservices anterior al 5-oct: no lee Serie/Folio. Sellar aquí
        // dejaría la factura sin folio PARA SIEMPRE.
        resumen.reintentar += 1;
        this.logger.warn(
          'Relectura de folio pausada: pyservices todavía no devuelve serie/folio (actualizarlo)',
        );
        break;
      }
      const ok = await sellar(fila.id, {
        serie: sf.serie,
        folio: sf.folio,
        folio_releido_at: new Date().toISOString(),
      });
      if (!ok) resumen.reintentar += 1;
      else if (sf.folio) resumen.con_folio += 1;
      else resumen.sin_folio += 1;
    }
    if (resumen.leidas > 0) {
      this.logger.log(
        `Relectura de folio de recibidas: ${resumen.leidas} leídas · ${resumen.con_folio} con folio · ${resumen.sin_folio} sin folio · ${resumen.ilegibles} ilegibles · ${resumen.reintentar} por reintentar`,
      );
    }
    return resumen;
  }

  async deleteRecibida(id: string, userId?: string) {
    // VARIAS FACTURAS POR GASTO (16-oct-2026, invariante 87): con la puente,
    // cada gasto donde era la PRINCIPAL promueve su siguiente factura (la
    // liga más antigua) en vez de quedarse sin factura; solo el gasto que no
    // tiene otra queda en null (⇒ PENDIENTE). Las filas de la puente se van
    // solas con la factura (FK en cascada).
    if (await this.conVariasFacturas()) {
      const { data: gastos, error: gErr } = await this.supabase.service
        .from('gasto')
        .select('id')
        .eq('factura_recibida_id', id);
      if (gErr) throw new Error(gErr.message);
      for (const g of (gastos ?? []) as Array<{ id: string }>) {
        const ligas = await ligasDeGastos(this.supabase.service, [g.id]);
        const { error: pErr } = await this.supabase.service
          .from('gasto')
          .update({
            factura_recibida_id: siguientePrincipal(ligas, id),
            ...(userId ? { updated_by: userId } : {}),
          })
          .eq('id', g.id)
          .eq('factura_recibida_id', id);
        if (pErr) throw new Error(pErr.message);
      }
    }
    // El FK gasto.factura_recibida_id es on delete set null, pero se limpia
    // explícito ANTES del delete para que el trigger de la BD regrese
    // estatus_facturacion a PENDIENTE (el comprobante del piloto no se toca).
    const { error: uErr } = await this.supabase.service
      .from('gasto')
      .update({
        factura_recibida_id: null,
      })
      .eq('factura_recibida_id', id);
    if (uErr) throw new Error(uErr.message);
    const { error } = await this.supabase.service
      .from('factura_recibida')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { ok: true };
  }

  /** Vuelos pagados aún sin facturar. */
  async listPendientes(f: ListPendientesFilters) {
    let q = this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, cliente_id, origen_iata, destino_iata, monto_total_usd, monto_total_mxn, fecha_vuelo, cobrado, metodo_cobro, cliente:cliente_id(nombre, rfc)',
        { count: 'exact' },
      )
      .eq('facturado', false)
      .neq('estado', 'CANCELADO')
      // Pagados (cualquier método) O confirmados por cobrar con método
      // FACTURABLE: hay clientes que piden la factura ANTES de pagar
      // (transferencia/link/terminal/cheque) — pedido de Itzy, 14 jul 2026.
      .or(
        // Mismo conjunto que METODOS_FACTURABLES (literal PostgREST).
        'cobrado.eq.true,and(metodo_cobro.in.(TRANSFERENCIA,HSBC_LINK,BILLPOCKET,CHEQUE,PAYWISE),estado.in.(CONFIRMADO,EN_VUELO,COMPLETADO))',
      )
      .order('fecha_vuelo', { ascending: false, nullsFirst: false })
      .range(f.offset, f.offset + f.limit - 1);
    // Fechas planas se anclan a hora Cancún (invariante #4): 'YYYY-MM-DD' a
    // secas corta en UTC y mueve vuelos de día/mes en el listado de pendientes.
    // INICIO OFICIAL (invariante 86): un `desde` anterior sube al inicio.
    // Sin `desde` (revisión 16-oct): piso que CONSERVA los vuelos sin
    // `fecha_vuelo` (una cotización sin fecha ya cobrada salía hoy en la
    // lista y no puede desaparecer), mismo criterio que cotizaciones.
    const inicio = await inicioOficialDe(this.configuracion);
    if (inicio && !f.desde) {
      q = q.or(`fecha_vuelo.is.null,fecha_vuelo.gte.${corteTs(inicio)}`);
    }
    const desdePend =
      inicio && f.desde && esAntesDelInicio(f.desde, inicio) ? inicio : f.desde;
    if (desdePend) {
      q = q.gte(
        'fecha_vuelo',
        /^\d{4}-\d{2}-\d{2}$/.test(desdePend)
          ? `${desdePend}T00:00:00-05:00`
          : desdePend,
      );
    }
    if (f.hasta) {
      q = q.lte(
        'fecha_vuelo',
        /^\d{4}-\d{2}-\d{2}$/.test(f.hasta)
          ? `${f.hasta}T23:59:59-05:00`
          : f.hasta,
      );
    }
    if (f.cliente_id) q = q.eq('cliente_id', f.cliente_id);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);

    // Ruta COMPLETA con escalas (comerciales; sin tramos internos): en el
    // listado solo se veía origen → destino y las rutas multiescala confundían.
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      const { data: escalas } = await this.supabase.service
        .from('escala')
        .select('vuelo_id, orden, origen_iata, destino_iata, solo_operativa')
        .in(
          'vuelo_id',
          rows.map((v) => v.id as string),
        )
        .is('cancelada_at', null)
        .order('orden', { ascending: true });
      const porVuelo = new Map<string, Array<Record<string, unknown>>>();
      for (const e of (escalas ?? []) as Array<Record<string, unknown>>) {
        const vid = e.vuelo_id as string;
        (porVuelo.get(vid) ?? porVuelo.set(vid, []).get(vid)!).push(e);
      }
      for (const v of rows) {
        const legs = porVuelo.get(v.id as string) ?? [];
        const comerciales = legs.filter((e) => e.solo_operativa !== true);
        const usar = comerciales.length > 0 ? comerciales : legs;
        v.ruta =
          usar.length > 0
            ? [usar[0].origen_iata, ...usar.map((e) => e.destino_iata)].join(
                ' → ',
              )
            : `${v.origen_iata as string} → ${v.destino_iata as string}`;
      }
    }
    return { data: rows, count: count ?? 0, limit: f.limit, offset: f.offset };
  }

  /** Facturas emitidas. */
  async listFacturas(filters: {
    estado?: string;
    emisora_id?: string;
    limit: number;
    offset: number;
  }) {
    let q = this.supabase.service
      .from('factura')
      .select(
        // El RFC del cliente permite al panel distinguir el caso 9.7 "SE
        // FACTURÓ A" (receptor ≠ cliente): facturado_a_* ahora se persiste en
        // TODAS las facturas (lo exige la cancelación), no solo en alternos.
        `${FACTURA_COLS}, vuelo:vuelo_id(folio, origen_iata, destino_iata, cliente:cliente_id(rfc)), emisora:entidad_fiscal_emisora_id(codigo, razon_social)`,
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.estado) q = q.eq('estado', filters.estado);
    if (filters.emisora_id)
      q = q.eq('entidad_fiscal_emisora_id', filters.emisora_id);
    // INICIO OFICIAL (invariante 86, auditoría 16-oct-2026, 0.0.85): CFDI
    // timbrados desde el inicio; los aún sin timbrar (null) se quedan.
    const inicio = await inicioOficialDe(this.configuracion);
    if (inicio) {
      q = q.or(`fecha_timbrado.is.null,fecha_timbrado.gte.${corteTs(inicio)}`);
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

  /**
   * URLs firmadas del XML/PDF de las facturas (bucket privado). Default 1 h
   * (`SEGUNDOS_URL_PUNTUAL`: el buzón de recibidas firma al CLIC);
   * `POST invoices/file-urls` pide 8 h (`SEGUNDOS_URL_MINIATURA`, 1-oct-2026)
   * porque `/admin/facturas` firma al RENDERIZAR y deja los enlaces XML/PDF
   * en pantalla — con 1 h abrían el JSON `InvalidJWT` de Supabase.
   */
  async signFacturaFiles(
    paths: string[],
    segundos: number = SEGUNDOS_URL_PUNTUAL,
  ): Promise<Record<string, string>> {
    const clean = [...new Set(paths.filter(Boolean))];
    if (clean.length === 0) return {};
    const { data } = await this.supabase.service.storage
      .from('facturas')
      .createSignedUrls(clean, segundos);
    const map: Record<string, string> = {};
    for (const it of data ?? [])
      if (it.signedUrl && it.path) map[it.path] = it.signedUrl;
    return map;
  }

  private async downloadB64(bucket: string, path: string): Promise<string> {
    const { data, error } = await this.supabase.service.storage
      .from(bucket)
      .download(path);
    if (error || !data)
      throw new Error(
        `No se pudo leer ${bucket}/${path}: ${error?.message ?? 'vacío'}`,
      );
    const buf = Buffer.from(await data.arrayBuffer());
    return buf.toString('base64');
  }

  /**
   * Prepara TODO lo que define el CFDI de un vuelo: receptor efectivo
   * (cliente / alterno 9.7 / público en general XAXX / extranjero XEXX),
   * importes MXN con IVA residual, forma/método de pago SAT,
   * InformacionGlobal y el concepto. La usan emitir() Y preview() — así la
   * vista previa muestra EXACTAMENTE lo que se timbraría. Valida completitud
   * fiscal pero NO aplica los candados de emisión (facturado/cobrado/estado,
   * que son de emitir()) y NO escribe en la BD (el TC pactado se devuelve en
   * tcPactado para que solo la emisión real lo persista).
   */
  private async prepararEmision(input: EmitirInput): Promise<EmisionPreparada> {
    const { vuelo_id: vueloId, entidad_fiscal_emisora_id: emisoraId } = input;
    const { data: vueloRow, error: vErr } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, cliente_id, estado, origen_iata, destino_iata, fecha_vuelo, cobrado, facturado, metodo_cobro, monto_total_usd, monto_total_mxn, tc_usd_mxn',
      )
      .eq('id', vueloId)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!vueloRow)
      throw new NotFoundException(`Vuelo ${vueloId} no encontrado`);
    const vuelo: VueloFacturable = vueloRow;

    // Receptor (cliente) — datos fiscales obligatorios CFDI 4.0.
    const { data: cliente, error: cErr } = await this.supabase.service
      .from('cliente')
      .select(
        'id, nombre, razon_social_default, rfc, regimen_fiscal_receptor, uso_cfdi, codigo_postal',
      )
      .eq('id', vuelo.cliente_id)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!cliente)
      throw new BadRequestException('El vuelo no tiene cliente asociado.');

    // Emisora (aquí NO se exige el CSD: el preview no firma nada; la emisión
    // real valida cer/key/contraseña en emitir()).
    const { data: emisoraRow, error: eErr } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .select(
        'id, codigo, razon_social, rfc, regimen_fiscal_sat, codigo_postal, csd_cer_url, csd_key_url',
      )
      .eq('id', emisoraId)
      .maybeSingle();
    if (eErr) throw new Error(eErr.message);
    if (!emisoraRow)
      throw new NotFoundException('Entidad emisora no encontrada.');
    const emisora: EmisoraFiscal = emisoraRow;

    // Receptor del CFDI: cliente del vuelo por default; "SE FACTURÓ A" (9.7)
    // si viene receptor alterno; PÚBLICO EN GENERAL (XAXX010101000) cuando el
    // cliente no pide factura; o EXTRANJERO (XEXX010101000) cuando el RFC
    // efectivo (del cliente o del alterno) es el genérico de residentes en el
    // extranjero.
    const esPublicoGeneral = input.publico_en_general === true;
    const usaReceptorAlterno =
      !esPublicoGeneral && Boolean(input.facturado_a_rfc);
    const rfcEfectivo = (
      (usaReceptorAlterno
        ? input.facturado_a_rfc
        : (cliente.rfc as string | null)) ?? ''
    ).toUpperCase();
    const esExtranjero = !esPublicoGeneral && rfcEfectivo === RFC_EXTRANJERO;
    // XAXX capturado como RFC del cliente SIN el switch de público en general:
    // el receptor saldría con nombre/régimen reales sin InformacionGlobal y el
    // PAC lo rechaza con un error críptico — mejor guiar al operador.
    if (!esPublicoGeneral && rfcEfectivo === 'XAXX010101000') {
      throw new BadRequestException(
        'El RFC del receptor es el genérico XAXX010101000: usa la opción «Público en gral.» para emitir esta factura.',
      );
    }

    const receptor: TimbrarPayload['receptor'] = esPublicoGeneral
      ? {
          rfc: 'XAXX010101000',
          nombre: 'PUBLICO EN GENERAL',
          // CFDI 4.0: DomicilioFiscalReceptor = CP del lugar de expedición
          // (el de la emisora).
          domicilio_fiscal: emisora.codigo_postal,
          regimen_fiscal: '616',
          uso_cfdi: 'S01',
        }
      : esExtranjero
        ? {
            // EXTRANJERO (XEXX010101000): mismas reglas SAT que público en
            // general (régimen 616, uso S01, CP de la emisora como domicilio
            // fiscal receptor) pero con el NOMBRE REAL del cliente y SIN nodo
            // InformacionGlobal (ese es exclusivo de XAXX).
            rfc: RFC_EXTRANJERO,
            nombre: usaReceptorAlterno
              ? (input.facturado_a_nombre ?? '')
              : ((cliente.razon_social_default || cliente.nombre) as string),
            domicilio_fiscal: emisora.codigo_postal,
            regimen_fiscal: '616',
            uso_cfdi: 'S01',
          }
        : usaReceptorAlterno
          ? {
              rfc: input.facturado_a_rfc as string,
              nombre: input.facturado_a_nombre ?? '',
              domicilio_fiscal: input.facturado_a_cp ?? '',
              regimen_fiscal: input.facturado_a_regimen ?? '',
              uso_cfdi: input.facturado_a_uso_cfdi ?? '',
            }
          : {
              rfc: cliente.rfc as string,
              nombre: (cliente.razon_social_default ||
                cliente.nombre) as string,
              domicilio_fiscal: cliente.codigo_postal as string,
              regimen_fiscal: cliente.regimen_fiscal_receptor as string,
              uso_cfdi: cliente.uso_cfdi as string,
            };
    if (esExtranjero) {
      // Al extranjero NO se le exigen CP/régimen/uso propios (van los
      // genéricos del SAT); solo el RFC (ya implícito) y el nombre real.
      if (!receptor.nombre) {
        throw new BadRequestException(
          usaReceptorAlterno
            ? "Falta la razón social/nombre del receptor extranjero 'SE FACTURÓ A'."
            : 'Falta la razón social/nombre del cliente extranjero.',
        );
      }
    } else if (!esPublicoGeneral) {
      const faltanReceptor = (
        [
          'rfc',
          'nombre',
          'domicilio_fiscal',
          'regimen_fiscal',
          'uso_cfdi',
        ] as const
      ).filter((k) => !receptor[k]);
      if (faltanReceptor.length > 0) {
        throw new BadRequestException(
          usaReceptorAlterno
            ? `Faltan datos fiscales del receptor 'SE FACTURÓ A': ${faltanReceptor.join(', ')}.`
            : `Faltan datos fiscales del cliente: ${faltanReceptor.join(', ')}.`,
        );
      }
    }

    // Importes en MXN. NOTA: mapeo simplificado (un concepto, IVA 16%); validar
    // contra FEL pruebas antes de producción.
    // FUENTE ÚNICA del total en pesos (17-sep-2026): `monto_total_mxn` tal
    // como lo compuso el motor; solo sin él, usd × TC. El CFDI tiene que
    // decir los MISMOS pesos que la cotización que firmó el cliente.
    // (Un `monto_total_mxn` persistido en 0 sigue cayendo al respaldo, como
    // antes: el `||` conserva la semántica histórica.)
    let totalMxn =
      totalMxnDeVuelo(vuelo) ||
      Math.round(
        Number(vuelo.monto_total_usd) *
          (normalizarTc(vuelo.tc_usd_mxn) ?? 0) *
          100,
      ) / 100;
    let tcPactado: EmisionPreparada['tcPactado'];
    if (
      (!totalMxn || totalMxn <= 0) &&
      input.tc_usd_mxn &&
      Number(vuelo.monto_total_usd) > 0
    ) {
      // Vuelos cotizados en USD sin TC (externos): el TC del DTO es el TC
      // PACTADO de la operación, así que se PERSISTE en el vuelo — cobrosEnUsd
      // (invariante #2) lo usa de respaldo y reparto/reportes ven el mismo MXN
      // que el CFDI, sin crear un cálculo paralelo. Aquí solo se CALCULA:
      // emitir() escribe tcPactado en el vuelo (el preview no toca la BD).
      // El TC pactado se PERSISTE con la precisión canónica (6 decimales):
      // el mismo número compone los pesos del CFDI y respalda cobrosEnUsd.
      const tcPactadoNorm = normalizarTc(input.tc_usd_mxn)!;
      totalMxn =
        Math.round(Number(vuelo.monto_total_usd) * tcPactadoNorm * 100) / 100;
      tcPactado = { tc_usd_mxn: tcPactadoNorm, monto_total_mxn: totalMxn };
    }
    if (!totalMxn || totalMxn <= 0) {
      throw new BadRequestException(
        'El vuelo no tiene monto en MXN para facturar (registra el monto MXN o envía tc_usd_mxn).',
      );
    }
    // IVA residual (total − subtotal redondeado): redondear subtotal e IVA por
    // separado descuadraba 1 centavo en ciertos montos y el CFDI dejaba de
    // cuadrar contra el cobro registrado (fiabilidad del cierre).
    const valorUnitario = Math.round((totalMxn / 1.16) * 100) / 100;
    const iva = Math.round((totalMxn - valorUnitario) * 100) / 100;

    // Nodo InformacionGlobal (obligatorio con XAXX010101000, y SOLO con XAXX:
    // el extranjero XEXX no lo lleva): el periodo fiscal es el del VUELO
    // (hora Cancún), no el del día en que se emite — facturar en los primeros
    // días del mes siguiente no debe mover la venta.
    const informacionGlobal = esPublicoGeneral
      ? this.informacionGlobalPara(input.periodicidad, vuelo.fecha_vuelo)
      : undefined;

    // Forma/método de pago SAT reales del cobro: hardcodear '03'/PUE declaraba
    // mal efectivo, terminal y cheque. Sin cobro aún → '99 por definir' + PPD;
    // el complemento de pago REP (fase A2 del plan) queda pendiente para
    // cerrar el ciclo PPD cuando entre el cobro.
    const formaPago = vuelo.cobrado
      ? (FORMA_PAGO_SAT[vuelo.metodo_cobro ?? ''] ?? '99')
      : '99';
    const metodoPago = vuelo.cobrado ? 'PUE' : 'PPD';

    const descripcionConcepto = `Servicio de transporte aéreo ${vuelo.origen_iata} → ${vuelo.destino_iata} (folio #${vuelo.folio})`;

    return {
      vuelo,
      emisora,
      receptor,
      esPublicoGeneral,
      esExtranjero,
      totalMxn,
      valorUnitario,
      iva,
      formaPago,
      metodoPago,
      informacionGlobal,
      descripcionConcepto,
      tcPactado,
    };
  }

  /**
   * Payload de timbrado/preview a partir del paquete preparado: emitir() le
   * agrega el CSD; el preview lo manda tal cual (pyservices renderiza el PDF
   * sin firmar). Un solo constructor = cero divergencia entre ambos.
   */
  private payloadCfdi(
    prep: EmisionPreparada,
    referencia: string,
  ): PreviewPayload {
    return {
      referencia,
      moneda: 'MXN',
      forma_pago: prep.formaPago,
      metodo_pago: prep.metodoPago,
      lugar_expedicion: prep.emisora.codigo_postal,
      informacion_global: prep.informacionGlobal,
      emisor: {
        rfc: prep.emisora.rfc,
        nombre: prep.emisora.razon_social,
        regimen_fiscal: prep.emisora.regimen_fiscal_sat,
      },
      receptor: prep.receptor,
      conceptos: [
        {
          descripcion: prep.descripcionConcepto,
          valor_unitario: prep.valorUnitario,
          cantidad: 1,
          iva: prep.iva,
        },
      ],
    };
  }

  /**
   * Vista previa del PDF del CFDI SIN timbrar: usa el MISMO prepararEmision()
   * que emitir(), por lo que el PDF mostrado nunca difiere del que se timbra.
   * No aplica los candados de emisión (facturado/estado/método), no usa el
   * candado CAS, no marca facturado y NO escribe en la BD — solo valida los
   * datos fiscales, para que el error se vea ANTES de intentar timbrar.
   */
  async preview(input: EmitirInput): Promise<Buffer> {
    const prep = await this.prepararEmision(input);
    // Referencia efímera solo para el render (no se persiste ni timbra).
    const referencia = `PREVIEW-${prep.vuelo.folio}-${Date.now().toString(36)}`;
    const result = await this.fel.preview(this.payloadCfdi(prep, referencia));
    if (!result.pdf_b64) {
      throw new BadRequestException(
        result.error ?? 'No se pudo generar la vista previa del CFDI.',
      );
    }
    return Buffer.from(result.pdf_b64, 'base64');
  }

  /**
   * Emite (timbra) el CFDI de un vuelo con la entidad emisora indicada.
   * El contenido del CFDI sale de prepararEmision() (compartido con el
   * preview); aquí van los candados de emisión, el CSD, el candado CAS
   * anti doble emisión y la persistencia (factura + XML/PDF).
   */
  async emitir(input: EmitirInput, userId: string) {
    const prep = await this.prepararEmision(input);
    const { vuelo, emisora, receptor, totalMxn } = prep;

    if (vuelo.facturado)
      throw new ConflictException('El vuelo ya está facturado.');
    // Se puede facturar ANTES del cobro con método facturable (hay clientes
    // que piden la factura para poder pagar) — con efectivo/dólares se exige
    // el cobro primero, como siempre.
    if (!vuelo.cobrado && !METODOS_FACTURABLES.has(vuelo.metodo_cobro ?? '')) {
      throw new ConflictException(
        'El vuelo no está cobrado y su método no es facturable por adelantado (transferencia, link, terminal o cheque).',
      );
    }
    if (vuelo.estado === 'CANCELADO')
      throw new ConflictException('El vuelo está cancelado.');
    // Antes del cobro solo se facturan vuelos ya confirmados/operados: timbrar
    // una cotización o reserva suelta emite CFDI de servicios que pueden no
    // prestarse nunca (y obliga a cancelarlos ante el SAT).
    if (
      !vuelo.cobrado &&
      !['CONFIRMADO', 'EN_VUELO', 'COMPLETADO'].includes(vuelo.estado ?? '')
    ) {
      throw new ConflictException(
        'Solo vuelos confirmados/en vuelo/completados se facturan antes del cobro.',
      );
    }

    // CSD de la emisora (solo la emisión real firma; el preview no lo usa).
    if (!emisora.csd_cer_url || !emisora.csd_key_url) {
      throw new BadRequestException(
        `La entidad ${emisora.codigo} no tiene CSD cargado.`,
      );
    }
    const csdPassword =
      process.env[`CSD_PASSWORD_${emisora.codigo}`] ??
      process.env.CSD_PASSWORD ??
      '';
    if (!csdPassword) {
      throw new BadRequestException(
        `Falta la contraseña del CSD de ${emisora.codigo} (env CSD_PASSWORD).`,
      );
    }

    const [cerB64, keyB64] = await Promise.all([
      this.downloadB64('csd', emisora.csd_cer_url),
      this.downloadB64('csd', emisora.csd_key_url),
    ]);

    // TC pactado calculado en prepararEmision(): se PERSISTE en el vuelo
    // (invariante #2 — cobrosEnUsd lo usa de respaldo y reparto/reportes ven
    // el mismo MXN que el CFDI). Solo la emisión real escribe.
    if (prep.tcPactado) {
      const { error: tcErr } = await this.supabase.service
        .from('vuelo')
        .update({ ...prep.tcPactado, updated_by: userId })
        .eq('id', vuelo.id);
      if (tcErr) throw new Error(tcErr.message);
    }

    // Referencia única POR EMISIÓN (no por vuelo): al refacturar tras una
    // cancelación, repetir `VT-<folio>` chocaba con el UNIQUE de
    // fel_referencia y el path de Storage pisaba el XML de la cancelada.
    const referencia = `VT-${vuelo.folio}-${Date.now().toString(36)}`;

    // Candado anti doble emisión (compare-and-set): el vuelo se marca
    // facturado ANTES de llamar al PAC. Marcarlo al final permitía que un
    // doble click (o dos requests concurrentes) pasara dos veces la
    // validación y timbrara DOS CFDI del mismo vuelo.
    const { data: lock, error: lockErr } = await this.supabase.service
      .from('vuelo')
      .update({ facturado: true, updated_by: userId })
      .eq('id', vuelo.id)
      .eq('facturado', false)
      .select('id');
    if (lockErr) throw new Error(lockErr.message);
    if (!lock || lock.length === 0) {
      throw new ConflictException(
        'El vuelo ya tiene una emisión en curso o factura timbrada.',
      );
    }

    let result: TimbrarResult;
    try {
      result = await this.fel.timbrar({
        ...this.payloadCfdi(prep, referencia),
        csd_cer_b64: cerB64,
        csd_key_b64: keyB64,
        csd_password: csdPassword,
      });
      if (!result.ok) {
        throw new BadRequestException(
          result.error ?? 'No se pudo timbrar el CFDI.',
        );
      }
    } catch (err) {
      // El timbrado NO se concretó: se libera el candado para poder
      // reintentar. Con timbrado exitoso el vuelo ya quedó facturado=true,
      // así que no hay update post-éxito que pueda perderse.
      await this.supabase.service
        .from('vuelo')
        .update({ facturado: false, updated_by: userId })
        .eq('id', vuelo.id);
      throw err;
    }

    // Guarda XML/PDF en storage (path por emisión: nunca pisa una cancelada).
    const { xmlPath, pdfPath } = await this.uploadCfdiFiles(
      `${vuelo.id}/${referencia}`,
      result,
    );

    const { data: factura, error: fErr } = await this.supabase.service
      .from('factura')
      .insert({
        vuelo_id: vuelo.id,
        cliente_id: vuelo.cliente_id,
        entidad_fiscal_emisora_id: emisora.id,
        estado: 'TIMBRADA',
        tipo_comprobante: 'I',
        uuid_fiscal: result.uuid,
        pac_id: result.pac_id ?? null,
        total: totalMxn,
        moneda: 'MXN',
        fel_referencia: referencia,
        xml_url: xmlPath,
        pdf_url: pdfPath,
        fecha_timbrado: result.fecha_timbrado ?? new Date().toISOString(),
        // Receptor EFECTIVO del CFDI (cliente, alterno 9.7, público en
        // general XAXX o extranjero XEXX), SIEMPRE persistido: cancelar() lo
        // manda a FEL (que lo exige) y la nota de crédito debe salir al MISMO
        // receptor del CFDI original — reconstruirlo del cliente del vuelo
        // timbraba mal las facturas de público en general.
        facturado_a_rfc: receptor.rfc,
        facturado_a_nombre: receptor.nombre,
        facturado_a_regimen: receptor.regimen_fiscal,
        facturado_a_cp: receptor.domicilio_fiscal,
        facturado_a_uso_cfdi: receptor.uso_cfdi,
        created_by: userId,
      })
      .select(FACTURA_COLS)
      .maybeSingle();
    if (fErr) throw new Error(fErr.message);

    // El seguimiento administrativo sigue al CFDI (22-sep-2026): timbrado ⇒
    // «Facturado». Best-effort: el timbre ya se consumió y `facturado = true`
    // (que es lo que manda en la derivación) ya quedó escrito.
    // Al CANCELAR el CFDI el estatus NO baja solo: la factura se elaboró y se
    // envió — que la oficina decida a mano si vuelve a «sin factura».
    await this.facturaCliente?.marcarFacturadoPorCfdi(vuelo.id, userId);

    return factura;
  }

  /**
   * Cancela un CFDI ante el SAT (vía pyservices/FEL). La factura debe estar
   * TIMBRADA y con UUID. Si la cancelación es aceptada: marca la factura como
   * CANCELADA (motivo + fecha) y libera el vuelo (facturado=false) para refacturar.
   */
  async cancelar(facturaId: string, dto: CancelarInput, userId: string) {
    const factura = await this.getFactura(facturaId);
    if (factura.estado !== 'TIMBRADA') {
      throw new ConflictException(
        `La factura no está TIMBRADA (estado: ${factura.estado}).`,
      );
    }
    if (!factura.uuid_fiscal) {
      throw new BadRequestException(
        'La factura no tiene UUID fiscal; no se puede cancelar.',
      );
    }
    if (dto.motivo === '01' && !dto.folio_sustitucion) {
      throw new BadRequestException(
        'El motivo 01 requiere el folio (UUID) de la factura que la sustituye.',
      );
    }

    const emisora = await this.getEmisora(
      factura.entidad_fiscal_emisora_id as string,
    );

    // FEL exige el RFC receptor en el detalle de cancelación. Las facturas
    // nuevas persisten SIEMPRE el receptor efectivo en facturado_a_*; para
    // filas viejas (solo guardaban el alterno) se reconstruye del cliente —
    // mandar null hacía rechazar la cancelación de facturas normales.
    const rfcReceptor =
      (factura.facturado_a_rfc as string | null) ??
      (factura.cliente_id ? (await this.receptorDeFactura(factura)).rfc : null);

    const result = await this.fel.cancelar({
      uuid: factura.uuid_fiscal as string,
      rfc_emisor: emisora.rfc as string,
      motivo: dto.motivo,
      folio_sustitucion: dto.folio_sustitucion ?? null,
      rfc_receptor: rfcReceptor,
      total: factura.total != null ? Number(factura.total) : null,
      // Facturama cancela por su Id de plataforma (null si se timbró con FEL).
      pac_id: (factura.pac_id as string | null) ?? null,
    });
    if (!result.ok) {
      throw new BadRequestException(
        result.error ?? 'No se pudo cancelar el CFDI.',
      );
    }

    const { data: updated, error: uErr } = await this.supabase.service
      .from('factura')
      .update({
        estado: 'CANCELADA',
        motivo_cancelacion: dto.motivo,
        cancelada_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', factura.id)
      .select(FACTURA_COLS)
      .maybeSingle();
    if (uErr) throw new Error(uErr.message);

    // Libera el vuelo para poder refacturar (solo facturas de Ingreso ligadas a un vuelo).
    if (factura.tipo_comprobante !== 'E' && factura.vuelo_id) {
      await this.supabase.service
        .from('vuelo')
        .update({ facturado: false, updated_by: userId })
        .eq('id', factura.vuelo_id);
    }

    return updated;
  }

  /**
   * Emite una nota de crédito (CFDI tipo Egreso) relacionada a una factura original
   * TIMBRADA. El receptor es el mismo de la factura original; el CFDI relacionado es su
   * UUID. Inserta una nueva fila factura con tipo_comprobante='E' y factura_relacionada_id.
   */
  async emitirNotaCredito(dto: NotaCreditoInput, userId: string) {
    const original = await this.getFactura(dto.factura_id);
    if (original.estado !== 'TIMBRADA') {
      throw new ConflictException(
        `Solo se puede emitir nota de crédito sobre una factura TIMBRADA (estado: ${original.estado}).`,
      );
    }
    if (!original.uuid_fiscal) {
      throw new BadRequestException(
        'La factura original no tiene UUID fiscal.',
      );
    }
    if (original.tipo_comprobante === 'E') {
      throw new BadRequestException(
        'No se puede emitir una nota de crédito sobre otra nota de crédito.',
      );
    }

    const emisora = await this.getEmisora(
      original.entidad_fiscal_emisora_id as string,
    );
    if (!emisora.csd_cer_url || !emisora.csd_key_url) {
      throw new BadRequestException(
        `La entidad ${emisora.codigo} no tiene CSD cargado.`,
      );
    }
    const csdPassword =
      process.env[`CSD_PASSWORD_${emisora.codigo}`] ??
      process.env.CSD_PASSWORD ??
      '';
    if (!csdPassword) {
      throw new BadRequestException(
        `Falta la contraseña del CSD de ${emisora.codigo} (env CSD_PASSWORD).`,
      );
    }
    const [cerB64, keyB64] = await Promise.all([
      this.downloadB64('csd', emisora.csd_cer_url as string),
      this.downloadB64('csd', emisora.csd_key_url as string),
    ]);

    // Receptor = el de la factura original (alterno si lo hubo, si no el del cliente del vuelo).
    const receptor = await this.receptorDeFactura(original);

    // Monto: el indicado en el DTO o, por defecto, el total de la factura original.
    const montoTotal =
      dto.monto && dto.monto > 0 ? dto.monto : Number(original.total);
    if (!montoTotal || montoTotal <= 0) {
      throw new BadRequestException('Monto de la nota de crédito inválido.');
    }
    // Tope de acreditación: la suma de notas TIMBRADAS sobre la misma factura
    // no puede exceder su total — el SAT rechaza egresos mayores al CFDI
    // relacionado y el excedente inflaría lo acreditado en el cierre.
    const { data: previas, error: ncPrevErr } = await this.supabase.service
      .from('factura')
      .select('total')
      .eq('factura_relacionada_id', original.id as string)
      .eq('tipo_comprobante', 'E')
      .eq('estado', 'TIMBRADA');
    if (ncPrevErr) throw new Error(ncPrevErr.message);
    const acreditado = (
      (previas ?? []) as Array<{ total: number | null }>
    ).reduce((suma, nc) => suma + Number(nc.total ?? 0), 0);
    const disponible =
      Math.round((Number(original.total) - acreditado) * 100) / 100;
    if (montoTotal > disponible) {
      throw new BadRequestException(
        `El monto excede lo acreditable: restan $${disponible.toFixed(2)} ` +
          `${(original.moneda as string) ?? 'MXN'} disponibles ` +
          `(ya hay $${acreditado.toFixed(2)} en notas de crédito timbradas sobre esta factura).`,
      );
    }
    // IVA residual (mismo criterio que la emisión): subtotal + IVA reproduce
    // exacto el monto acreditado, sin descuadre de 1 centavo.
    const valorUnitario = Math.round((montoTotal / 1.16) * 100) / 100;
    const iva = Math.round((montoTotal - valorUnitario) * 100) / 100;

    // CFDI global: si la original fue a PÚBLICO EN GENERAL, el SAT exige el
    // nodo InformacionGlobal también en el Egreso relacionado — mismo periodo
    // que la emisión (mes del vuelo en hora Cancún).
    let informacionGlobal: TimbrarPayload['informacion_global'];
    if ((original.facturado_a_rfc as string | null) === 'XAXX010101000') {
      let fechaVuelo: string | null = null;
      if (original.vuelo_id) {
        const { data: vuelo } = await this.supabase.service
          .from('vuelo')
          .select('fecha_vuelo')
          .eq('id', original.vuelo_id as string)
          .maybeSingle();
        fechaVuelo = (vuelo?.fecha_vuelo as string | null) ?? null;
      }
      informacionGlobal = this.informacionGlobalPara(undefined, fechaVuelo);
    }

    // Sufijo corto para no colisionar con el UNIQUE de fel_referencia si se emiten
    // varias notas (créditos parciales) sobre la misma factura.
    const referencia = `NC-${original.fel_referencia ?? original.id}-${Date.now().toString(36)}`;
    const payload: TimbrarPayload = {
      referencia,
      moneda: (original.moneda as string) ?? 'MXN',
      // La NC acredita un pago ya aplicado: siempre PUE, con la forma de pago
      // de la original ('03' de respaldo mientras factura no la persista).
      forma_pago: (original.forma_pago as string | null) ?? '03',
      metodo_pago: 'PUE',
      lugar_expedicion: emisora.codigo_postal as string,
      tipo_comprobante: 'E',
      cfdi_relacionado_uuid: original.uuid_fiscal as string,
      tipo_relacion: dto.tipo_relacion ?? '01',
      informacion_global: informacionGlobal,
      emisor: {
        rfc: emisora.rfc as string,
        nombre: emisora.razon_social as string,
        regimen_fiscal: emisora.regimen_fiscal_sat as string,
      },
      receptor,
      conceptos: [
        {
          descripcion:
            dto.descripcion ??
            `Nota de crédito sobre CFDI ${original.uuid_fiscal}`,
          valor_unitario: valorUnitario,
          cantidad: 1,
          iva,
        },
      ],
      csd_cer_b64: cerB64,
      csd_key_b64: keyB64,
      csd_password: csdPassword,
    };

    const result = await this.fel.notaCredito(payload);
    if (!result.ok) {
      throw new BadRequestException(
        result.error ?? 'No se pudo timbrar la nota de crédito.',
      );
    }

    const { xmlPath, pdfPath } = await this.uploadCfdiFiles(
      `${original.vuelo_id}/${referencia}`,
      result,
    );

    const { data: nota, error: nErr } = await this.supabase.service
      .from('factura')
      .insert({
        vuelo_id: original.vuelo_id,
        cliente_id: original.cliente_id,
        entidad_fiscal_emisora_id: original.entidad_fiscal_emisora_id,
        estado: 'TIMBRADA',
        tipo_comprobante: 'E',
        factura_relacionada_id: original.id,
        uuid_fiscal: result.uuid,
        pac_id: result.pac_id ?? null,
        total: montoTotal,
        moneda: (original.moneda as string) ?? 'MXN',
        fel_referencia: referencia,
        xml_url: xmlPath,
        pdf_url: pdfPath,
        fecha_timbrado: result.fecha_timbrado ?? new Date().toISOString(),
        // Receptor EFECTIVO con el que se timbró la NC (en facturas viejas
        // facturado_a_* venía NULL y la fila quedaba sin receptor): así su
        // propia cancelación no depende de reconstruirlo.
        facturado_a_rfc: receptor.rfc,
        facturado_a_nombre: receptor.nombre,
        facturado_a_regimen: receptor.regimen_fiscal,
        facturado_a_cp: receptor.domicilio_fiscal,
        facturado_a_uso_cfdi: receptor.uso_cfdi,
        created_by: userId,
      })
      .select(FACTURA_COLS)
      .maybeSingle();
    if (nErr) throw new Error(nErr.message);

    return nota;
  }

  // ── Helpers internos ──────────────────────────────────────────────────────

  /** Carga una factura con todas sus columnas o lanza 404. */
  private async getFactura(facturaId: string) {
    const { data, error } = await this.supabase.service
      .from('factura')
      .select('*')
      .eq('id', facturaId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new NotFoundException(`Factura ${facturaId} no encontrada`);
    return data as Record<string, unknown>;
  }

  /** Carga la entidad emisora (con CSD) o lanza 404. */
  private async getEmisora(emisoraId: string) {
    const { data, error } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .select(
        'id, codigo, razon_social, rfc, regimen_fiscal_sat, codigo_postal, csd_cer_url, csd_key_url',
      )
      .eq('id', emisoraId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException('Entidad emisora no encontrada.');
    return data as Record<string, unknown>;
  }

  /**
   * Reconstruye el receptor del CFDI a partir de una factura: usa el receptor
   * alterno ("SE FACTURÓ A") si está guardado, si no el del cliente del vuelo.
   */
  private async receptorDeFactura(
    factura: Record<string, unknown>,
  ): Promise<TimbrarPayload['receptor']> {
    if (factura.facturado_a_rfc) {
      return {
        rfc: factura.facturado_a_rfc as string,
        nombre: (factura.facturado_a_nombre ?? '') as string,
        domicilio_fiscal: (factura.facturado_a_cp ?? '') as string,
        regimen_fiscal: (factura.facturado_a_regimen ?? '') as string,
        uso_cfdi: (factura.facturado_a_uso_cfdi ?? '') as string,
      };
    }
    const { data: cliente, error } = await this.supabase.service
      .from('cliente')
      .select(
        'nombre, razon_social_default, rfc, regimen_fiscal_receptor, uso_cfdi, codigo_postal',
      )
      .eq('id', factura.cliente_id as string)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!cliente)
      throw new BadRequestException(
        'La factura original no tiene cliente asociado.',
      );
    return {
      rfc: cliente.rfc as string,
      nombre: (cliente.razon_social_default || cliente.nombre) as string,
      domicilio_fiscal: cliente.codigo_postal as string,
      regimen_fiscal: cliente.regimen_fiscal_receptor as string,
      uso_cfdi: cliente.uso_cfdi as string,
    };
  }

  /**
   * Nodo InformacionGlobal (público en general): el periodo fiscal es el del
   * VUELO (hora Cancún) cuando se conoce su fecha — emitir a inicios del mes
   * siguiente no debe mover la venta de periodo — y solo de respaldo el actual.
   */
  private informacionGlobalPara(
    periodicidad?: string,
    fechaRef?: string | null,
  ) {
    const fecha = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Cancun',
    }).format(fechaRef ? new Date(fechaRef) : new Date());
    return {
      periodicidad: periodicidad ?? '04',
      meses: fecha.slice(5, 7),
      anio: Number(fecha.slice(0, 4)),
    };
  }

  /**
   * Sube XML/PDF (base64) al bucket privado `facturas` y devuelve sus paths.
   * Si un upload falla se devuelve null para ese archivo: persistir un path
   * que no se escribió rompería descargas y el zip de cierre en silencio
   * (el XML siempre se puede re-descargar del PAC vía pac_id/uuid).
   */
  private async uploadCfdiFiles(
    base: string,
    result: { xml_b64?: string | null; pdf_b64?: string | null },
  ): Promise<{ xmlPath: string | null; pdfPath: string | null }> {
    let xmlPath: string | null = null;
    let pdfPath: string | null = null;
    if (result.xml_b64) {
      const path = `${base}.xml`;
      const { error } = await this.supabase.service.storage
        .from('facturas')
        .upload(path, Buffer.from(result.xml_b64, 'base64'), {
          contentType: 'application/xml',
          upsert: true,
        });
      if (error) {
        this.logger.error(
          `No se pudo subir el XML del CFDI a ${path}: ${error.message}`,
        );
      } else {
        xmlPath = path;
      }
    }
    if (result.pdf_b64) {
      const path = `${base}.pdf`;
      const { error } = await this.supabase.service.storage
        .from('facturas')
        .upload(path, Buffer.from(result.pdf_b64, 'base64'), {
          contentType: 'application/pdf',
          upsert: true,
        });
      if (error) {
        this.logger.error(
          `No se pudo subir el PDF del CFDI a ${path}: ${error.message}`,
        );
      } else {
        pdfPath = path;
      }
    }
    return { xmlPath, pdfPath };
  }
}
