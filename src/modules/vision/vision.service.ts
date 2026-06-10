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

export interface GastoTicketVisionInput {
  imageBase64?: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  imageUrl?: string;
}

export interface GastoTicketVisionResult {
  monto: number | null;
  moneda: 'MXN' | 'USD' | null;
  fecha: string | null;
  proveedor: string | null;
  concepto: string | null;
  categoria_sugerida: string | null;
  confianza: number;
  legible: boolean;
  notas: string;
  modelo: string;
}

export interface CombustibleTicketVisionInput {
  imageBase64?: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  imageUrl?: string;
}

export interface CombustibleTicketVisionResult {
  litros: number | null;
  precio_litro: number | null;
  total: number | null;
  moneda: 'MXN' | 'USD' | null;
  aeropuerto: string | null;
  tipo_combustible: 'TURBOSINA' | 'AVGAS' | null;
  fecha: string | null;
  /** Hora de la carga HH:MM (24h) — clave para ligar el ticket al vuelo. */
  hora: string | null;
  proveedor: string | null;
  /** Últimos 4 dígitos de la tarjeta usada, si aparecen en el ticket. */
  tarjeta_terminacion: string | null;
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

  /**
   * Extrae datos de un ticket de gasto (monto, fecha, proveedor, concepto,
   * categoría sugerida). Best-effort: null si pyservices no está activo o falla,
   * y la captura cae a manual.
   */
  async readGastoTicket(input: GastoTicketVisionInput): Promise<GastoTicketVisionResult | null> {
    if (!this.enabled) return null;
    if (!input.imageBase64 && !input.imageUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/vision/gasto`, {
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
        this.logger.warn(`pyservices /vision/gasto respondió ${res.status}`);
        return null;
      }
      return (await res.json()) as GastoTicketVisionResult;
    } catch (err) {
      this.logger.warn(
        `readGastoTicket falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Extrae datos de un ticket de combustible (litros, precio/litro, total,
   * aeropuerto, tipo). Best-effort: null si pyservices no está activo o falla.
   */
  async readCombustibleTicket(
    input: CombustibleTicketVisionInput,
  ): Promise<CombustibleTicketVisionResult | null> {
    if (!this.enabled) return null;
    if (!input.imageBase64 && !input.imageUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/vision/combustible`, {
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
        this.logger.warn(`pyservices /vision/combustible respondió ${res.status}`);
        return null;
      }
      return (await res.json()) as CombustibleTicketVisionResult;
    } catch (err) {
      this.logger.warn(
        `readCombustibleTicket falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
