import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';

export interface VencimientoExtraerInput {
  /** PDF en base64 (sin prefijo data:). */
  pdfBase64?: string;
  /** Alternativa: imagen en base64 (sin prefijo data:). Requiere mediaType. */
  imageBase64?: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export interface VencimientoExtraerResult {
  matricula: string | null;
  tipo_documento: string | null;
  fecha_vigencia: string | null;
  fecha_vencimiento: string | null;
  emisor: string | null;
  confianza: number;
  notas: string;
  modelo: string;
}

/**
 * Cliente HTTP hacia pyservices (FastAPI) para extraer por IA los datos de un
 * documento de vencimiento renovado (póliza/seguro/tarjeta de circulación) y
 * pre-llenar el alta de vencimiento (doc 7.6).
 *
 * Best-effort: si pyservices no está configurado o falla, devuelve null y el
 * alta cae a captura manual (nunca bloquea al operador).
 */
@Injectable()
export class ExpirationsClient implements OnModuleInit {
  private readonly logger = new Logger(ExpirationsClient.name);
  private baseUrl = '';
  private token = '';
  private timeoutMs = 30000;

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  onModuleInit() {
    this.baseUrl = this.config.get('PYSERVICES_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    this.timeoutMs = this.config.get('PYSERVICES_TIMEOUT_MS', { infer: true });
    if (!this.baseUrl || !this.token) {
      this.logger.log(
        'Extracción IA de vencimientos deshabilitada (PYSERVICES_BASE_URL/INTERNAL_SHARED_TOKEN vacíos)',
      );
    }
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  /**
   * Extrae matrícula, tipo, vigencia, vencimiento y emisor de un PDF o imagen.
   * Best-effort: null si pyservices no está activo, falta la fuente o falla.
   */
  async extraer(input: VencimientoExtraerInput): Promise<VencimientoExtraerResult | null> {
    if (!this.enabled) return null;
    if (!input.pdfBase64 && !input.imageBase64) {
      this.logger.warn('extraer vencimiento sin documento (ni pdf ni imagen)');
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/vencimientos/extraer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.token,
        },
        body: JSON.stringify({
          pdf_base64: input.pdfBase64,
          image_base64: input.imageBase64,
          media_type: input.mediaType,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`pyservices /vencimientos/extraer respondió ${res.status}`);
        return null;
      }
      return (await res.json()) as VencimientoExtraerResult;
    } catch (err) {
      this.logger.warn(
        `extraer vencimiento falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
