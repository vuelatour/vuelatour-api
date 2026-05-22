import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';

export interface TacometroVisionInput {
  /** Imagen en base64 (sin prefijo data:). Requiere mediaType. */
  imageBase64?: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  /** Alternativa: URL pública o firmada de la imagen. */
  imageUrl?: string;
}

export interface TacometroVisionResult {
  lectura: number | null;
  confianza: number;
  legible: boolean;
  notas: string;
  modelo: string;
}

/**
 * Cliente HTTP hacia pyservices (FastAPI) para lectura de tacómetros por visión.
 *
 * Best-effort: si pyservices no está configurado o falla, devuelve null y la
 * captura cae a manual + sugerencia histórica (nunca bloquea al piloto).
 */
@Injectable()
export class VisionService implements OnModuleInit {
  private readonly logger = new Logger(VisionService.name);
  private baseUrl = '';
  private token = '';
  private timeoutMs = 30000;

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  onModuleInit() {
    this.baseUrl = this.config.get('PYSERVICES_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    this.timeoutMs = this.config.get('PYSERVICES_TIMEOUT_MS', { infer: true });
    if (!this.baseUrl || !this.token) {
      this.logger.log('Visión IA deshabilitada (PYSERVICES_BASE_URL/INTERNAL_SHARED_TOKEN vacíos)');
      return;
    }
    this.logger.log(`Visión IA activa · pyservices: ${this.baseUrl}`);
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  async readTacometro(input: TacometroVisionInput): Promise<TacometroVisionResult | null> {
    if (!this.enabled) return null;
    if (!input.imageBase64 && !input.imageUrl) {
      this.logger.warn('readTacometro sin imagen (ni base64 ni url)');
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/vision/tacometro`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.token,
        },
        body: JSON.stringify({
          image_base64: input.imageBase64,
          media_type: input.mediaType,
          image_url: input.imageUrl,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`pyservices /vision/tacometro respondió ${res.status}`);
        return null;
      }
      const data = (await res.json()) as TacometroVisionResult;
      return data;
    } catch (err) {
      this.logger.warn(
        `readTacometro falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
