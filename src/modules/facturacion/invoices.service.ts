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
import { columnaOpcional } from '../../common/columna-opcional.util';
import { FacturaClienteService } from '../flights/factura-cliente.service';
import { normalizarTc, totalMxnDeVuelo } from '../../common/tc.util';
import { PyservicesService } from '../pyservices/pyservices.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import {
  FacturacionClient,
  type PreviewPayload,
  type TimbrarPayload,
  type TimbrarResult,
} from './facturacion.client';
import type { UpdateRecibidaDto } from './dto/invoices.dto';

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
    desde: string,
    hasta: string,
  ): Promise<{ buffer: Buffer; desde: string; hasta: string }> {
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

  /** Columnas de `factura_recibida` según lo que exista en la BD. */
  private async colsRecibida(): Promise<string> {
    return (await this.conPdfRecibida())
      ? `${RECIBIDA_COLS}, pdf_url`
      : RECIBIDA_COLS;
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
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
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
    return data!;
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
   *     `ya_existia: true` (antes: 409 y callejón sin salida).
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
    },
    userId: string,
  ) {
    const xmlB64 = (dto.xml_b64 ?? '').trim();
    const pdfB64 = (dto.pdf_b64 ?? '').trim();
    if (!xmlB64 && !pdfB64) {
      throw new BadRequestException(
        'Sube al menos un archivo: el XML del CFDI o el PDF de la factura.',
      );
    }
    const conPdf = await this.conPdfRecibida();
    if (pdfB64 && !conPdf) {
      throw new ConflictException({
        message:
          'Guardar el PDF de la factura todavía no está habilitado en la ' +
          'base de datos (falta aplicar la migración). Sube el XML por ' +
          'ahora, o vuelve a intentarlo en unos minutos.',
        error: 'PDF_FACTURA_NO_DISPONIBLE',
        details: { migracion: MIGRACION_PDF_RECIBIDA },
      });
    }

    const { data: gasto, error: gErr } = await this.supabase.service
      .from('gasto')
      .select('id, factura_recibida_id')
      .eq('id', dto.gasto_id)
      .maybeSingle();
    if (gErr) throw new Error(gErr.message);
    if (!gasto) {
      throw new NotFoundException(`Gasto ${dto.gasto_id} not found`);
    }

    // Con XML: se parsea ANTES de subir nada (si el CFDI no es legible, no
    // queda basura en el bucket).
    const p = xmlB64
      ? await this.pyservices.parseFacturaRecibida(xmlB64)
      : null;

    // ¿Esa factura ya estaba en el buzón? Entonces solo se le suma el gasto.
    if (p?.uuid_fiscal) {
      const { data: previa, error: pErr } = await this.supabase.service
        .from('factura_recibida')
        .select('id')
        .eq('uuid_fiscal', p.uuid_fiscal)
        .maybeSingle();
      if (pErr) throw new Error(pErr.message);
      if (previa) {
        const id = previa.id as string;
        await this.amarrarGastoAdicional(id, dto.gasto_id, userId);
        return {
          ...(await this.recibidaPorId(id)),
          ya_existia: true,
        };
      }
    }

    // Base del nombre en Storage: el UUID fiscal (identifica al CFDI) o uno
    // propio para las facturas que llegan solo en PDF.
    const base = (p?.uuid_fiscal ?? randomUUID()).replace(/[^a-zA-Z0-9-]/g, '');
    const subidos: string[] = [];
    let xmlPath: string | null = null;
    let pdfPath: string | null = null;
    // Una vez insertada la fila, los archivos son SUYOS: un fallo posterior
    // (amarre, relectura) ya no puede borrarlos o la factura quedaría
    // apuntando a papeles que no existen.
    let filaCreada = false;
    try {
      if (xmlB64) {
        xmlPath = `recibidas/${base}.xml`;
        const { error } = await this.supabase.service.storage
          .from('facturas')
          .upload(xmlPath, Buffer.from(xmlB64, 'base64'), {
            contentType: 'application/xml',
            upsert: true,
          });
        if (error)
          throw new Error(`No se pudo guardar el XML: ${error.message}`);
        subidos.push(xmlPath);
      }
      if (pdfB64) {
        pdfPath = `recibidas/${base}.pdf`;
        const { error } = await this.supabase.service.storage
          .from('facturas')
          .upload(pdfPath, Buffer.from(pdfB64, 'base64'), {
            contentType: 'application/pdf',
            upsert: true,
          });
        if (error)
          throw new Error(`No se pudo guardar el PDF: ${error.message}`);
        subidos.push(pdfPath);
      }

      const notas = !p
        ? `Factura en PDF (sin XML)${dto.pdf_nombre ? `: ${dto.pdf_nombre}` : ''}`
        : null;
      const { data, error } = await this.supabase.service
        .from('factura_recibida')
        .insert({
          uuid_fiscal: p?.uuid_fiscal ?? null,
          emisor_rfc: p?.emisor_rfc ?? null,
          emisor_nombre: p?.emisor_nombre ?? null,
          receptor_rfc: p?.receptor_rfc ?? null,
          receptor_nombre: p?.receptor_nombre ?? null,
          tipo_comprobante: p?.tipo_comprobante ?? null,
          subtotal: p?.subtotal ?? null,
          total: p?.total ?? null,
          moneda: p?.moneda ?? null,
          fecha_emision: p?.fecha_emision ?? null,
          conceptos_resumen: p?.conceptos_resumen ?? null,
          xml_url: xmlPath,
          ...(conPdf ? { pdf_url: pdfPath } : {}),
          // Nace amarrada: llegó desde la fila de un gasto concreto.
          estado: 'CLASIFICADA',
          gasto_id: dto.gasto_id,
          notas,
          created_by: userId,
          updated_by: userId,
        })
        .select('id')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') {
          throw new ConflictException('Esa factura (UUID) ya está registrada.');
        }
        throw new Error(error.message);
      }
      const id = (data as { id: string }).id;
      filaCreada = true;
      await this.amarrarGastoAdicional(id, dto.gasto_id, userId);
      return { ...(await this.recibidaPorId(id)), ya_existia: false };
    } catch (e) {
      // Nada a medias: si la fila NO entró, los archivos no se quedan. Si sí
      // entró, se conservan (la factura ya vive en el buzón y el amarre se
      // puede rehacer desde el panel).
      if (!filaCreada && subidos.length > 0) {
        const { error } = await this.supabase.service.storage
          .from('facturas')
          .remove(subidos);
        if (error) {
          this.logger.warn(
            `Factura del gasto ${dto.gasto_id} falló y no se pudieron borrar ${subidos.join(', ')}: ${error.message}`,
          );
        }
      }
      throw e;
    }
  }

  /**
   * Amarra UN gasto a una factura recibida SIN tocar los demás gastos que ya
   * ampara (a diferencia de `amarrarGastos`, que reemplaza la lista). El
   * trigger `gasto_sync_facturacion` lo deja en FACTURADA.
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
    return data as unknown as Record<string, unknown>;
  }

  async deleteRecibida(id: string) {
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
    if (f.desde) {
      q = q.gte(
        'fecha_vuelo',
        /^\d{4}-\d{2}-\d{2}$/.test(f.desde)
          ? `${f.desde}T00:00:00-05:00`
          : f.desde,
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

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /** URLs firmadas (1 h) del XML/PDF de las facturas (bucket privado). */
  async signFacturaFiles(paths: string[]): Promise<Record<string, string>> {
    const clean = [...new Set(paths.filter(Boolean))];
    if (clean.length === 0) return {};
    const { data } = await this.supabase.service.storage
      .from('facturas')
      .createSignedUrls(clean, 3600);
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
