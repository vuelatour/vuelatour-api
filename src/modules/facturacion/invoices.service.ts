import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { FacturacionClient } from './facturacion.client';

interface ListPendientesFilters {
  desde?: string;
  hasta?: string;
  cliente_id?: string;
  limit: number;
  offset: number;
}

const FACTURA_COLS =
  'id, vuelo_id, cliente_id, entidad_fiscal_emisora_id, estado, serie, folio, uuid_fiscal, total, moneda, xml_url, pdf_url, fecha_timbrado, error_mensaje, created_at';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly fel: FacturacionClient,
  ) {}

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
  async emitir(vueloId: string, emisoraId: string, userId: string) {
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
    const faltanReceptor = ['rfc', 'regimen_fiscal_receptor', 'uso_cfdi', 'codigo_postal'].filter(
      (k) => !(cliente as Record<string, unknown>)[k],
    );
    if (faltanReceptor.length > 0) {
      throw new BadRequestException(
        `Faltan datos fiscales del cliente: ${faltanReceptor.join(', ')}.`,
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
      receptor: {
        rfc: cliente.rfc as string,
        nombre: (cliente.razon_social_default || cliente.nombre) as string,
        domicilio_fiscal: cliente.codigo_postal as string,
        regimen_fiscal: cliente.regimen_fiscal_receptor as string,
        uso_cfdi: cliente.uso_cfdi as string,
      },
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
    const base = `${vuelo.id}/VT-${vuelo.folio}`;
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

    const { data: factura, error: fErr } = await this.supabase.service
      .from('factura')
      .insert({
        vuelo_id: vuelo.id,
        cliente_id: vuelo.cliente_id,
        entidad_fiscal_emisora_id: emisoraId,
        estado: 'TIMBRADA',
        uuid_fiscal: result.uuid,
        total: totalMxn,
        moneda: 'MXN',
        fel_referencia: `VT-${vuelo.folio}`,
        xml_url: xmlPath,
        pdf_url: pdfPath,
        fecha_timbrado: result.fecha_timbrado ?? new Date().toISOString(),
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
}
