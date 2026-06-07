import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import { FacturacionClient, type TimbrarPayload } from './facturacion.client';

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
}

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
  'id, vuelo_id, cliente_id, entidad_fiscal_emisora_id, estado, serie, folio, uuid_fiscal, total, moneda, xml_url, pdf_url, fecha_timbrado, error_mensaje, tipo_comprobante, factura_relacionada_id, facturado_a_rfc, facturado_a_nombre, motivo_cancelacion, cancelada_at, created_at';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly fel: FacturacionClient,
    private readonly pyservices: PyservicesService,
    private readonly profitSharing: ProfitSharingService,
  ) {}

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
    const { buffer: excel } = await this.profitSharing.repartoXlsx({ desde, hasta });
    const archivos: { nombre: string; contenido_b64: string }[] = [
      {
        nombre: `reporte-mensual-${desde}-a-${hasta}.xlsx`,
        contenido_b64: excel.toString('base64'),
      },
    ];

    // 2) Facturas timbradas en el periodo: XML + PDF.
    const { data: facturas } = await this.supabase.service
      .from('factura')
      .select('serie, folio, uuid_fiscal, estado, tipo_comprobante, xml_url, pdf_url, fecha_timbrado')
      .eq('estado', 'TIMBRADA')
      .gte('fecha_timbrado', desde)
      .lte('fecha_timbrado', `${hasta}T23:59:59`)
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
          archivos.push({ nombre: `facturas/${base}.${ext}`, contenido_b64: b64 });
        } catch (e) {
          this.logger.warn(`cierre: no se pudo leer ${path}: ${(e as Error).message}`);
        }
      }
    }

    const buffer = await this.pyservices.generateZip({ archivos });
    return { buffer, desde, hasta };
  }

  /** Vuelos pagados aún sin facturar. */
  async listPendientes(f: ListPendientesFilters) {
    let q = this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, cliente_id, origen_iata, destino_iata, monto_total_usd, monto_total_mxn, fecha_vuelo, cliente:cliente_id(nombre, rfc)',
        { count: 'exact' },
      )
      .eq('cobrado', true)
      .eq('facturado', false)
      .neq('estado', 'CANCELADO')
      .order('fecha_vuelo', { ascending: false, nullsFirst: false })
      .range(f.offset, f.offset + f.limit - 1);
    if (f.desde) q = q.gte('fecha_vuelo', f.desde);
    if (f.hasta) q = q.lte('fecha_vuelo', f.hasta);
    if (f.cliente_id) q = q.eq('cliente_id', f.cliente_id);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { data: data ?? [], count: count ?? 0, limit: f.limit, offset: f.offset };
  }

  /** Facturas emitidas. */
  async listFacturas(filters: { estado?: string; emisora_id?: string; limit: number; offset: number }) {
    let q = this.supabase.service
      .from('factura')
      .select(
        `${FACTURA_COLS}, vuelo:vuelo_id(folio, origen_iata, destino_iata), emisora:entidad_fiscal_emisora_id(codigo, razon_social)`,
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.estado) q = q.eq('estado', filters.estado);
    if (filters.emisora_id) q = q.eq('entidad_fiscal_emisora_id', filters.emisora_id);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { data: data ?? [], count: count ?? 0, limit: filters.limit, offset: filters.offset };
  }

  /** URLs firmadas (1 h) del XML/PDF de las facturas (bucket privado). */
  async signFacturaFiles(paths: string[]): Promise<Record<string, string>> {
    const clean = [...new Set(paths.filter(Boolean))];
    if (clean.length === 0) return {};
    const { data } = await this.supabase.service.storage.from('facturas').createSignedUrls(clean, 3600);
    const map: Record<string, string> = {};
    for (const it of data ?? []) if (it.signedUrl && it.path) map[it.path] = it.signedUrl;
    return map;
  }

  private async downloadB64(bucket: string, path: string): Promise<string> {
    const { data, error } = await this.supabase.service.storage.from(bucket).download(path);
    if (error || !data) throw new Error(`No se pudo leer ${bucket}/${path}: ${error?.message ?? 'vacío'}`);
    const buf = Buffer.from(await data.arrayBuffer());
    return buf.toString('base64');
  }

  /**
   * Emite (timbra) el CFDI de un vuelo con la entidad emisora indicada.
   * Valida completitud fiscal, arma el payload, llama a pyservices/FEL, guarda
   * XML/PDF y la factura, y marca el vuelo como facturado.
   */
  async emitir(input: EmitirInput, userId: string) {
    const { vuelo_id: vueloId, entidad_fiscal_emisora_id: emisoraId } = input;
    const { data: vuelo, error: vErr } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, cliente_id, estado, origen_iata, destino_iata, cobrado, facturado, monto_total_usd, monto_total_mxn, tc_usd_mxn',
      )
      .eq('id', vueloId)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!vuelo) throw new NotFoundException(`Vuelo ${vueloId} no encontrado`);
    if (vuelo.facturado) throw new ConflictException('El vuelo ya está facturado.');
    if (!vuelo.cobrado) throw new ConflictException('El vuelo no está cobrado; no se puede facturar.');
    if (vuelo.estado === 'CANCELADO') throw new ConflictException('El vuelo está cancelado.');

    // Receptor (cliente) — datos fiscales obligatorios CFDI 4.0.
    const { data: cliente, error: cErr } = await this.supabase.service
      .from('cliente')
      .select('id, nombre, razon_social_default, rfc, regimen_fiscal_receptor, uso_cfdi, codigo_postal')
      .eq('id', vuelo.cliente_id)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!cliente) throw new BadRequestException('El vuelo no tiene cliente asociado.');

    // Receptor del CFDI: por defecto el cliente del vuelo; si se indicó "SE FACTURÓ A"
    // (caso 9.7) se usa ese receptor alterno y se persiste en la factura.
    const usaReceptorAlterno = Boolean(input.facturado_a_rfc);
    const receptor = usaReceptorAlterno
      ? {
          rfc: input.facturado_a_rfc as string,
          nombre: (input.facturado_a_nombre ?? '') as string,
          domicilio_fiscal: (input.facturado_a_cp ?? '') as string,
          regimen_fiscal: (input.facturado_a_regimen ?? '') as string,
          uso_cfdi: (input.facturado_a_uso_cfdi ?? '') as string,
        }
      : {
          rfc: cliente.rfc as string,
          nombre: (cliente.razon_social_default || cliente.nombre) as string,
          domicilio_fiscal: cliente.codigo_postal as string,
          regimen_fiscal: cliente.regimen_fiscal_receptor as string,
          uso_cfdi: cliente.uso_cfdi as string,
        };
    const faltanReceptor = (['rfc', 'nombre', 'domicilio_fiscal', 'regimen_fiscal', 'uso_cfdi'] as const).filter(
      (k) => !receptor[k],
    );
    if (faltanReceptor.length > 0) {
      throw new BadRequestException(
        usaReceptorAlterno
          ? `Faltan datos fiscales del receptor 'SE FACTURÓ A': ${faltanReceptor.join(', ')}.`
          : `Faltan datos fiscales del cliente: ${faltanReceptor.join(', ')}.`,
      );
    }

    // Emisor (entidad fiscal) + CSD.
    const { data: emisora, error: eErr } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .select('id, codigo, razon_social, rfc, regimen_fiscal_sat, codigo_postal, csd_cer_url, csd_key_url')
      .eq('id', emisoraId)
      .maybeSingle();
    if (eErr) throw new Error(eErr.message);
    if (!emisora) throw new NotFoundException('Entidad emisora no encontrada.');
    if (!emisora.csd_cer_url || !emisora.csd_key_url) {
      throw new BadRequestException(`La entidad ${emisora.codigo} no tiene CSD cargado.`);
    }
    const csdPassword =
      process.env[`CSD_PASSWORD_${emisora.codigo}`] ?? process.env.CSD_PASSWORD ?? '';
    if (!csdPassword) {
      throw new BadRequestException(`Falta la contraseña del CSD de ${emisora.codigo} (env CSD_PASSWORD).`);
    }

    const [cerB64, keyB64] = await Promise.all([
      this.downloadB64('csd', emisora.csd_cer_url as string),
      this.downloadB64('csd', emisora.csd_key_url as string),
    ]);

    // Importes en MXN. NOTA: mapeo simplificado (un concepto, IVA 16%); validar
    // contra FEL pruebas antes de producción.
    const totalMxn =
      Number(vuelo.monto_total_mxn) ||
      Number(vuelo.monto_total_usd) * (Number(vuelo.tc_usd_mxn) || 0);
    if (!totalMxn || totalMxn <= 0) {
      throw new BadRequestException('El vuelo no tiene monto en MXN para facturar.');
    }
    const valorUnitario = Math.round((totalMxn / 1.16) * 100) / 100;

    const result = await this.fel.timbrar({
      referencia: `VT-${vuelo.folio}`,
      moneda: 'MXN',
      forma_pago: '03',
      metodo_pago: 'PUE',
      lugar_expedicion: emisora.codigo_postal as string,
      emisor: {
        rfc: emisora.rfc as string,
        nombre: emisora.razon_social as string,
        regimen_fiscal: emisora.regimen_fiscal_sat as string,
      },
      receptor,
      conceptos: [
        {
          descripcion: `Servicio de transporte aéreo ${vuelo.origen_iata} → ${vuelo.destino_iata} (folio #${vuelo.folio})`,
          valor_unitario: valorUnitario,
          cantidad: 1,
        },
      ],
      csd_cer_b64: cerB64,
      csd_key_b64: keyB64,
      csd_password: csdPassword,
    });

    if (!result.ok) {
      throw new BadRequestException(result.error ?? 'No se pudo timbrar el CFDI.');
    }

    // Guarda XML/PDF en storage.
    const { xmlPath, pdfPath } = await this.uploadCfdiFiles(`${vuelo.id}/VT-${vuelo.folio}`, result);

    const { data: factura, error: fErr } = await this.supabase.service
      .from('factura')
      .insert({
        vuelo_id: vuelo.id,
        cliente_id: vuelo.cliente_id,
        entidad_fiscal_emisora_id: emisoraId,
        estado: 'TIMBRADA',
        tipo_comprobante: 'I',
        uuid_fiscal: result.uuid,
        total: totalMxn,
        moneda: 'MXN',
        fel_referencia: `VT-${vuelo.folio}`,
        xml_url: xmlPath,
        pdf_url: pdfPath,
        fecha_timbrado: result.fecha_timbrado ?? new Date().toISOString(),
        // Receptor alterno (caso 9.7 "SE FACTURÓ A"); NULL si se facturó al cliente del vuelo.
        facturado_a_rfc: usaReceptorAlterno ? receptor.rfc : null,
        facturado_a_nombre: usaReceptorAlterno ? receptor.nombre : null,
        facturado_a_regimen: usaReceptorAlterno ? receptor.regimen_fiscal : null,
        facturado_a_cp: usaReceptorAlterno ? receptor.domicilio_fiscal : null,
        facturado_a_uso_cfdi: usaReceptorAlterno ? receptor.uso_cfdi : null,
        created_by: userId,
      })
      .select(FACTURA_COLS)
      .maybeSingle();
    if (fErr) throw new Error(fErr.message);

    await this.supabase.service
      .from('vuelo')
      .update({ facturado: true, updated_by: userId })
      .eq('id', vuelo.id);

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
      throw new ConflictException(`La factura no está TIMBRADA (estado: ${factura.estado}).`);
    }
    if (!factura.uuid_fiscal) {
      throw new BadRequestException('La factura no tiene UUID fiscal; no se puede cancelar.');
    }
    if (dto.motivo === '01' && !dto.folio_sustitucion) {
      throw new BadRequestException(
        'El motivo 01 requiere el folio (UUID) de la factura que la sustituye.',
      );
    }

    const emisora = await this.getEmisora(factura.entidad_fiscal_emisora_id as string);

    const result = await this.fel.cancelar({
      uuid: factura.uuid_fiscal as string,
      rfc_emisor: emisora.rfc as string,
      motivo: dto.motivo,
      folio_sustitucion: dto.folio_sustitucion ?? null,
    });
    if (!result.ok) {
      throw new BadRequestException(result.error ?? 'No se pudo cancelar el CFDI.');
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
      throw new BadRequestException('La factura original no tiene UUID fiscal.');
    }
    if (original.tipo_comprobante === 'E') {
      throw new BadRequestException('No se puede emitir una nota de crédito sobre otra nota de crédito.');
    }

    const emisora = await this.getEmisora(original.entidad_fiscal_emisora_id as string);
    if (!emisora.csd_cer_url || !emisora.csd_key_url) {
      throw new BadRequestException(`La entidad ${emisora.codigo} no tiene CSD cargado.`);
    }
    const csdPassword =
      process.env[`CSD_PASSWORD_${emisora.codigo}`] ?? process.env.CSD_PASSWORD ?? '';
    if (!csdPassword) {
      throw new BadRequestException(`Falta la contraseña del CSD de ${emisora.codigo} (env CSD_PASSWORD).`);
    }
    const [cerB64, keyB64] = await Promise.all([
      this.downloadB64('csd', emisora.csd_cer_url as string),
      this.downloadB64('csd', emisora.csd_key_url as string),
    ]);

    // Receptor = el de la factura original (alterno si lo hubo, si no el del cliente del vuelo).
    const receptor = await this.receptorDeFactura(original);

    // Monto: el indicado en el DTO o, por defecto, el total de la factura original.
    const montoTotal = dto.monto && dto.monto > 0 ? dto.monto : Number(original.total);
    if (!montoTotal || montoTotal <= 0) {
      throw new BadRequestException('Monto de la nota de crédito inválido.');
    }
    const valorUnitario = Math.round((montoTotal / 1.16) * 100) / 100;

    // Sufijo corto para no colisionar con el UNIQUE de fel_referencia si se emiten
    // varias notas (créditos parciales) sobre la misma factura.
    const referencia = `NC-${original.fel_referencia ?? original.id}-${Date.now().toString(36)}`;
    const payload: TimbrarPayload = {
      referencia,
      moneda: (original.moneda as string) ?? 'MXN',
      forma_pago: '03',
      metodo_pago: 'PUE',
      lugar_expedicion: emisora.codigo_postal as string,
      tipo_comprobante: 'E',
      cfdi_relacionado_uuid: original.uuid_fiscal as string,
      tipo_relacion: dto.tipo_relacion ?? '01',
      emisor: {
        rfc: emisora.rfc as string,
        nombre: emisora.razon_social as string,
        regimen_fiscal: emisora.regimen_fiscal_sat as string,
      },
      receptor,
      conceptos: [
        {
          descripcion:
            dto.descripcion ?? `Nota de crédito sobre CFDI ${original.uuid_fiscal}`,
          valor_unitario: valorUnitario,
          cantidad: 1,
        },
      ],
      csd_cer_b64: cerB64,
      csd_key_b64: keyB64,
      csd_password: csdPassword,
    };

    const result = await this.fel.notaCredito(payload);
    if (!result.ok) {
      throw new BadRequestException(result.error ?? 'No se pudo timbrar la nota de crédito.');
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
        total: montoTotal,
        moneda: (original.moneda as string) ?? 'MXN',
        fel_referencia: referencia,
        xml_url: xmlPath,
        pdf_url: pdfPath,
        fecha_timbrado: result.fecha_timbrado ?? new Date().toISOString(),
        facturado_a_rfc: original.facturado_a_rfc ?? null,
        facturado_a_nombre: original.facturado_a_nombre ?? null,
        facturado_a_regimen: original.facturado_a_regimen ?? null,
        facturado_a_cp: original.facturado_a_cp ?? null,
        facturado_a_uso_cfdi: original.facturado_a_uso_cfdi ?? null,
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
    if (!data) throw new NotFoundException(`Factura ${facturaId} no encontrada`);
    return data as Record<string, unknown>;
  }

  /** Carga la entidad emisora (con CSD) o lanza 404. */
  private async getEmisora(emisoraId: string) {
    const { data, error } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .select('id, codigo, razon_social, rfc, regimen_fiscal_sat, codigo_postal, csd_cer_url, csd_key_url')
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
      .select('nombre, razon_social_default, rfc, regimen_fiscal_receptor, uso_cfdi, codigo_postal')
      .eq('id', factura.cliente_id as string)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!cliente) throw new BadRequestException('La factura original no tiene cliente asociado.');
    return {
      rfc: cliente.rfc as string,
      nombre: (cliente.razon_social_default || cliente.nombre) as string,
      domicilio_fiscal: cliente.codigo_postal as string,
      regimen_fiscal: cliente.regimen_fiscal_receptor as string,
      uso_cfdi: cliente.uso_cfdi as string,
    };
  }

  /** Sube XML/PDF (base64) al bucket privado `facturas` y devuelve sus paths. */
  private async uploadCfdiFiles(
    base: string,
    result: { xml_b64?: string | null; pdf_b64?: string | null },
  ): Promise<{ xmlPath: string | null; pdfPath: string | null }> {
    let xmlPath: string | null = null;
    let pdfPath: string | null = null;
    if (result.xml_b64) {
      xmlPath = `${base}.xml`;
      await this.supabase.service.storage
        .from('facturas')
        .upload(xmlPath, Buffer.from(result.xml_b64, 'base64'), {
          contentType: 'application/xml',
          upsert: true,
        });
    }
    if (result.pdf_b64) {
      pdfPath = `${base}.pdf`;
      await this.supabase.service.storage
        .from('facturas')
        .upload(pdfPath, Buffer.from(result.pdf_b64, 'base64'), {
          contentType: 'application/pdf',
          upsert: true,
        });
    }
    return { xmlPath, pdfPath };
  }
}
