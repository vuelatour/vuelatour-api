import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';

export interface TimbrarPayload {
  referencia: string;
  serie?: string;
  folio?: string;
  moneda: string;
  forma_pago: string;
  metodo_pago: string;
  lugar_expedicion: string;
  emisor: { rfc: string; nombre: string; regimen_fiscal: string };
  receptor: {
    rfc: string;
    nombre: string;
    domicilio_fiscal: string;
    regimen_fiscal: string;
    uso_cfdi: string;
  };
  conceptos: Array<{
    descripcion: string;
    valor_unitario: number;
    cantidad?: number;
    /**
     * IVA residual (total − subtotal) para que subtotal + IVA cuadre EXACTO
     * con el total cobrado. Aditivo: pyservices hoy recalcula el 16% y lo
     * ignora; debe adoptar este campo para cerrar el centavo en montos límite.
     */
    iva?: number;
  }>;
  /** PÚBLICO EN GENERAL (XAXX010101000): nodo InformacionGlobal del CFDI 4.0. */
  informacion_global?: { periodicidad: string; meses: string; anio: number };
  csd_cer_b64: string;
  csd_key_b64: string;
  csd_password: string;
  // Nota de crédito (CFDI tipo Egreso): el shape es el mismo que /timbrar.
  tipo_comprobante?: string;
  cfdi_relacionado_uuid?: string;
  tipo_relacion?: string;
}

export interface TimbrarResult {
  ok: boolean;
  uuid?: string | null;
  fecha_timbrado?: string | null;
  xml_b64?: string | null;
  pdf_b64?: string | null;
  /** Id del CFDI en el PAC (Facturama): se persiste para poder cancelar. */
  pac_id?: string | null;
  error?: string | null;
}

export interface CancelarPayload {
  uuid: string;
  rfc_emisor: string;
  motivo: string;
  folio_sustitucion?: string | null;
  // FEL exige RFC receptor y total del CFDI en el detalle de cancelación.
  rfc_receptor?: string | null;
  total?: number | null;
  /** Facturama: Id del CFDI en su plataforma (factura.pac_id). */
  pac_id?: string | null;
}

export interface CancelarResult {
  ok: boolean;
  estatus?: string | null;
  acuse_xml?: string | null;
  error?: string | null;
}

/**
 * Vista previa (sin timbrar): MISMO shape que /timbrar pero con el CSD
 * opcional — pyservices renderiza el PDF sin firmar ni tocar al PAC.
 */
export type PreviewPayload = Omit<
  TimbrarPayload,
  'csd_cer_b64' | 'csd_key_b64' | 'csd_password'
> &
  Partial<Pick<TimbrarPayload, 'csd_cer_b64' | 'csd_key_b64' | 'csd_password'>>;

export interface PreviewResult {
  ok?: boolean;
  /** PDF de la vista previa en base64 (respuesta de /facturacion/preview). */
  pdf_b64?: string | null;
  error?: string | null;
}

/** Cliente HTTP hacia pyservices para timbrar CFDI 4.0 (FEL). */
@Injectable()
export class FacturacionClient implements OnModuleInit {
  private readonly logger = new Logger(FacturacionClient.name);
  private baseUrl = '';
  private token = '';
  // Este cliente SOLO atiende timbrado/cancelación: pyservices reintenta
  // contra el PAC (hasta ~5 requests × 60 s) y abortar a los 45 s dejaba el
  // timbrado corriendo del otro lado — el reintento del operador duplicaba
  // el CFDI. Los demás consumos de pyservices tienen su propio cliente.
  private timeoutMs = 180000;

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  onModuleInit() {
    this.baseUrl = this.config.get('PYSERVICES_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!this.baseUrl || !this.token) {
      this.logger.log('Facturación: pyservices no configurado (timbrado deshabilitado)');
    }
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  async timbrar(payload: TimbrarPayload): Promise<TimbrarResult> {
    return this.post<TimbrarResult>('/facturacion/timbrar', payload, 'timbrar');
  }

  /** Timbra una nota de crédito (CFDI tipo Egreso) relacionada a una factura. */
  async notaCredito(payload: TimbrarPayload): Promise<TimbrarResult> {
    return this.post<TimbrarResult>('/facturacion/nota-credito', payload, 'nota-credito');
  }

  /** Solicita la cancelación de un CFDI ante el SAT vía pyservices. */
  async cancelar(payload: CancelarPayload): Promise<CancelarResult> {
    return this.post<CancelarResult>('/facturacion/cancelar', payload, 'cancelar');
  }

  /**
   * Vista previa del PDF del CFDI SIN timbrar: mismo payload que /timbrar
   * (CSD opcional). Mismo cliente/timeout que el timbrado — el render del
   * PDF en pyservices puede tardar y abortar antes dejaba previews "rotos".
   */
  async preview(payload: PreviewPayload): Promise<PreviewResult> {
    return this.post<PreviewResult>('/facturacion/preview', payload, 'preview');
  }

  /** POST defensivo hacia pyservices (timeout + AbortController + token interno). */
  private async post<T extends { ok?: boolean; error?: string | null }>(
    path: string,
    payload: unknown,
    op: string,
  ): Promise<T> {
    if (!this.enabled) {
      return {
        ok: false,
        error: 'Facturación no configurada (pyservices/credenciales ausentes).',
      } as T;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': this.token },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, error: `pyservices respondió ${res.status}` } as T;
      }
      return (await res.json()) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${op} falló: ${msg}`);
      return { ok: false, error: `No se pudo contactar al servicio de timbrado: ${msg}` } as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
