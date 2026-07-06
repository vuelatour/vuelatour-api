import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';

export interface TacometroVisionInput {
  /** Imagen en base64 (sin prefijo data:). Requiere mediaType. */
  imageBase64?: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  /** Alternativa: URL pública o firmada de la imagen. */
  imageUrl?: string;
  /** Última lectura conocida de la aeronave: ancla de magnitud para la IA. */
  ultimo?: number | null;
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
  medio_pago: 'EFECTIVO' | 'TARJETA_CORP' | 'TRANSFERENCIA' | null;
  tarjeta_terminacion: string | null;
  /** Renglones del ticket (desglose por concepto), si los desglosa claramente. */
  conceptos?: Array<{ concepto: string; monto: number }>;
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
  /** Medio de pago detectado (EFECTIVO/TARJETA_CORP/TRANSFERENCIA). */
  medio_pago: 'EFECTIVO' | 'TARJETA_CORP' | 'TRANSFERENCIA' | null;
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

  /**
   * Diagnóstico de la visión IA (sin exponer secretos): si está habilitada y
   * si pyservices responde. Sirve para confirmar por qué "la foto no lee".
   */
  async health(): Promise<{
    habilitada: boolean;
    pyservices_url_configurada: boolean;
    token_configurado: boolean;
    pyservices_responde: boolean | null;
    detalle: string;
  }> {
    const base = {
      habilitada: this.enabled,
      pyservices_url_configurada: Boolean(this.baseUrl),
      token_configurado: Boolean(this.token),
    };
    if (!this.enabled) {
      return {
        ...base,
        pyservices_responde: null,
        detalle:
          'Visión deshabilitada: falta PYSERVICES_BASE_URL o INTERNAL_SHARED_TOKEN en el API.',
      };
    }
    // Llamada mínima: si la llave de Anthropic está mal, pyservices responde 502.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/vision/tacometro`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.token,
        },
        // 1px PNG transparente: válida para el contrato, basta para ver si la
        // IA responde o falla por config (llave/cuota).
        body: JSON.stringify({
          image_base64:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC',
          media_type: 'image/png',
        }),
        signal: controller.signal,
      });
      const detalle = await res.text().catch(() => '');
      return {
        ...base,
        pyservices_responde: res.ok,
        detalle: res.ok
          ? 'pyservices y la IA responden correctamente.'
          : `pyservices respondió ${res.status}: ${detalle.slice(0, 200)}`,
      };
    } catch (err) {
      return {
        ...base,
        pyservices_responde: false,
        detalle: `No se pudo contactar a pyservices: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
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
          ultimo: input.ultimo ?? undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Cuerpo del error para diagnosticar la causa (p. ej. "Claude no
        // disponible (401)" = llave de Anthropic inválida/vencida en pyservices).
        const detalle = await res.text().catch(() => '');
        this.logger.warn(
          `pyservices /vision/tacometro respondió ${res.status}: ${detalle.slice(0, 300)}`,
        );
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
