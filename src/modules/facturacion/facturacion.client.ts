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
  conceptos: Array<{ descripcion: string; valor_unitario: number; cantidad?: number }>;
  csd_cer_b64: string;
  csd_key_b64: string;
  csd_password: string;
}

export interface TimbrarResult {
  ok: boolean;
  uuid?: string | null;
  fecha_timbrado?: string | null;
  xml_b64?: string | null;
  pdf_b64?: string | null;
  error?: string | null;
}

/** Cliente HTTP hacia pyservices para timbrar CFDI 4.0 (FEL). */
@Injectable()
export class FacturacionClient implements OnModuleInit {
  private readonly logger = new Logger(FacturacionClient.name);
  private baseUrl = '';
  private token = '';
  private timeoutMs = 45000;

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
    if (!this.enabled) {
      return { ok: false, error: 'Facturación no configurada (pyservices/credenciales ausentes).' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/facturacion/timbrar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': this.token },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, error: `pyservices respondió ${res.status}` };
      }
      return (await res.json()) as TimbrarResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`timbrar falló: ${msg}`);
      return { ok: false, error: `No se pudo contactar al servicio de timbrado: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
