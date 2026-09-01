import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import { desgloseGastoLineas } from '../../common/desglose-gasto.util';
import { normalizarCodigo } from '../inventory/inventario-codigo.util';
import { IaUsoService, type UsoIaPayload } from '../ia-uso/ia-uso.service';

/**
 * Datos de registro del consumo de IA de una lectura (best-effort). El call
 * site decide la CATEGORÍA (ej. /vision/gasto sirve a GASTO_TICKET y a
 * REANALISIS); sin `categoria` se usa el default del método.
 */
export interface RegistroVision {
  categoria?: string;
  usuarioId?: string | null;
  contexto?: Record<string, unknown>;
}

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
  /**
   * Calidad de la FOTO para leer el instrumento. BAJA = la lectura puede traer
   * dígitos equivocados (caso real 28 jul 2026: foto borrosa, la IA leyó
   * 1621.8 y el tambor decía .9). Opcional: pyservices viejo no lo manda.
   */
  calidad_foto?: 'ALTA' | 'MEDIA' | 'BAJA';
  modelo: string;
  /** Consumo de tokens (aditivo; pyservices viejo no lo manda). */
  uso_ia?: UsoIaPayload | null;
}

export interface GastoTicketVisionInput {
  imageBase64?: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  imageUrl?: string;
  /** Varias fotos del MISMO documento (hojas de una factura); máx 8. */
  images?: Array<{
    imageBase64?: string;
    mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    imageUrl?: string;
  }>;
  /** Factura en PDF (base64). */
  pdfBase64?: string;
  /** Factura en Excel (.xlsx) o CSV (base64) + nombre para el parser. */
  excelBase64?: string;
  excelFilename?: string;
}

export interface GastoTicketVisionResult {
  monto: number | null;
  /** Propina si el ticket la muestra como línea (el monto ya la incluye). */
  propina?: number | null;
  moneda: 'MXN' | 'USD' | null;
  fecha: string | null;
  proveedor: string | null;
  /** Folio/remisión impreso en el ticket (llave anti-duplicados). */
  folio?: string | null;
  concepto: string | null;
  categoria_sugerida: string | null;
  medio_pago: 'EFECTIVO' | 'TARJETA_CORP' | 'TRANSFERENCIA' | null;
  tarjeta_terminacion: string | null;
  /** Renglones del ticket (incl. IVA como renglón si viene aparte; suma = total). */
  conceptos?: Array<{ concepto: string; monto: number }>;
  /** Desglose compuesto (regla FBO/TUA) tal como se guardará en las notas. */
  desglose_lineas?: string[];
  /** Matrícula de la aeronave si aparece en el documento (facturas de FBO). */
  matricula?: string | null;
  confianza: number;
  legible: boolean;
  notas: string;
  modelo: string;
  /** Consumo de tokens (aditivo; pyservices viejo no lo manda). */
  uso_ia?: UsoIaPayload | null;
}

export interface ConstanciaFiscalVisionInput {
  /** Constancia en PDF (base64). Excluyente con imageBase64. */
  pdfBase64?: string;
  /** Foto de la constancia (base64). Requiere mediaType. */
  imageBase64?: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

/** Respuesta de pyservices POST /vision/constancia-fiscal (snake_case). */
export interface ConstanciaFiscalVisionResult {
  disponible: boolean;
  legible: boolean;
  rfc: string | null;
  razon_social: string | null;
  /** Clave c_RegimenFiscal (3 dígitos) detectada en la constancia. */
  regimen_fiscal: string | null;
  regimen_descripcion: string | null;
  cp: string | null;
  domicilio: string | null;
  confianza: number;
  motivo?: string | null;
  /** Consumo de tokens (aditivo; pyservices viejo no lo manda). */
  uso_ia?: UsoIaPayload | null;
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
  /** Folio/remisión impreso en el ticket (ej. "Remision: 2622242310" de ASA). */
  folio?: string | null;
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
  /** Consumo de tokens (aditivo; pyservices viejo no lo manda). */
  uso_ia?: UsoIaPayload | null;
}

export interface InventarioItemVisionInput {
  /** Fotos del MISMO producto desde distintos ángulos / la caja (1–8). */
  images: Array<{
    imageBase64?: string;
    mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    imageUrl?: string;
  }>;
  /** Categorías existentes en bodega: la IA elige una (o propone una corta). */
  categorias: string[];
  /** Códigos ya escaneados: verdad para la IA (no los reinventa). */
  codigosEscaneados?: string[];
}

/** Respuesta de pyservices POST /vision/inventario-item (todo opcional/null). */
export interface InventarioItemVisionResult {
  nombre: string | null;
  marca: string | null;
  numero_parte: string | null;
  /** Código de barras de la UNIDAD, dígitos seguidos sin espacios. */
  codigo_barras: string | null;
  categoria: string | null;
  unidad: string | null;
  /** Contenido / presentación de la unidad (ej. "946 mL"). */
  contenido: string | null;
  descripcion: string | null;
  /** Si alguna foto es la caja: nombre 'Caja de N', factor N y su código. */
  empaque: {
    nombre: string | null;
    factor: number | null;
    codigo_barras: string | null;
  } | null;
  confianza: number;
  notas_ia: string | null;
  modelo?: string;
  /** Consumo de tokens (aditivo; pyservices viejo no lo manda). */
  uso_ia?: UsoIaPayload | null;
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

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly iaUso: IaUsoService,
  ) {}

  onModuleInit() {
    this.baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    this.token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    // La visión con Opus puede tomar 20-40s por foto: el timeout nunca baja
    // de 90s aunque PYSERVICES_TIMEOUT_MS sea menor (cortarla a 30s hacía que
    // la app mostrara "la IA no pudo leer" con el modelo grande).
    this.timeoutMs = Math.max(
      Number(this.config.get('PYSERVICES_TIMEOUT_MS', { infer: true })) ||
        30000,
      90000,
    );
    if (!this.baseUrl || !this.token) {
      this.logger.log(
        'Visión IA deshabilitada (PYSERVICES_BASE_URL/INTERNAL_SHARED_TOKEN vacíos)',
      );
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
      if (res.ok) {
        // El ping usa una imagen REAL: consume tokens y también se registra.
        try {
          const body = JSON.parse(detalle) as { uso_ia?: UsoIaPayload | null };
          this.iaUso.registrar('TACOMETRO', body.uso_ia, {
            contexto: { origen: 'health' },
          });
        } catch {
          /* respuesta no-JSON: sin registro */
        }
      }
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

  async readTacometro(
    input: TacometroVisionInput,
    reg?: RegistroVision,
  ): Promise<TacometroVisionResult | null> {
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
      this.iaUso.registrar(reg?.categoria ?? 'TACOMETRO', data.uso_ia, {
        usuarioId: reg?.usuarioId,
        contexto: reg?.contexto,
      });
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
  async readGastoTicket(
    input: GastoTicketVisionInput,
    reg?: RegistroVision,
  ): Promise<(GastoTicketVisionResult & { motivo?: string }) | null> {
    if (!this.enabled) return null;
    if (
      !input.imageBase64 &&
      !input.imageUrl &&
      !(input.images?.length ?? 0) &&
      !input.pdfBase64 &&
      !input.excelBase64
    ) {
      return null;
    }

    const controller = new AbortController();
    // Multi-página/PDF tarda más que una foto: margen extra sobre el timeout base.
    const esDocumento =
      (input.images?.length ?? 0) > 1 ||
      !!input.pdfBase64 ||
      !!input.excelBase64;
    const timer = setTimeout(
      () => controller.abort(),
      esDocumento ? Math.max(this.timeoutMs, 150_000) : this.timeoutMs,
    );
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
          images: input.images?.map((i) => ({
            image_base64: i.imageBase64,
            media_type: i.mediaType,
            image_url: i.imageUrl,
          })),
          pdf_base64: input.pdfBase64,
          excel_base64: input.excelBase64,
          excel_filename: input.excelFilename,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Devuelve el motivo real (ej. "Claude no disponible (404)" = modelo
        // mal escrito; timeout = ANTHROPIC_TIMEOUT_S corto) para que la app lo
        // muestre y el operador sepa QUÉ arreglar en vez de adivinar.
        const detalle = await res.text().catch(() => '');
        this.logger.warn(
          `pyservices /vision/gasto respondió ${res.status}: ${detalle.slice(0, 200)}`,
        );
        let motivo = `pyservices ${res.status}`;
        try {
          const j = JSON.parse(detalle) as { detail?: string };
          if (j.detail) motivo = j.detail;
        } catch {
          /* texto plano */
        }
        return { motivo } as GastoTicketVisionResult & { motivo: string };
      }
      const ai = (await res.json()) as GastoTicketVisionResult;
      this.iaUso.registrar(reg?.categoria ?? 'GASTO_TICKET', ai.uso_ia, {
        usuarioId: reg?.usuarioId,
        contexto: reg?.contexto,
      });
      // Desglose compuesto con la MISMA regla que se guardará en las notas
      // (FBO/TUA con IVA): el panel lo muestra al capturar para que la
      // oficina vea ANTES de guardar si la separación cuadró.
      const conceptos = (ai.conceptos ?? []).filter(
        (c) => c.concepto && Number.isFinite(c.monto) && c.monto > 0,
      );
      if (ai.legible && ai.monto != null && conceptos.length >= 2) {
        const propina = ai.propina != null && ai.propina > 0 ? ai.propina : 0;
        ai.desglose_lineas = desgloseGastoLineas(
          conceptos,
          Math.round((ai.monto - propina) * 100) / 100,
          ai.moneda ?? 'MXN',
        );
      }
      return ai;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`readGastoTicket falló: ${msg}`);
      return {
        motivo: msg.includes('abort')
          ? 'La lectura tardó demasiado (timeout API→pyservices)'
          : `Sin conexión con pyservices: ${msg.slice(0, 120)}`,
      } as GastoTicketVisionResult & { motivo: string };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Lee una constancia de situación fiscal (PDF del SAT o foto) y extrae RFC,
   * razón social, régimen, CP y domicilio para pre-llenar el alta del cliente.
   * Passthrough a pyservices /vision/constancia-fiscal. Best-effort: si falla
   * devuelve el motivo (misma UX que readGastoTicket) y la captura sigue manual.
   */
  async readConstanciaFiscal(
    input: ConstanciaFiscalVisionInput,
    reg?: RegistroVision,
  ): Promise<
    (ConstanciaFiscalVisionResult & { motivo?: string | null }) | null
  > {
    if (!this.enabled) return null;
    if (!input.pdfBase64 && !input.imageBase64) return null;

    const controller = new AbortController();
    // La constancia suele venir en PDF (varias hojas): mismo margen que los
    // documentos de gasto — cortar antes de 150s dejaba lecturas a medias.
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(this.timeoutMs, 150_000),
    );
    try {
      const res = await fetch(`${this.baseUrl}/vision/constancia-fiscal`, {
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
        // Motivo real del fallo (llave IA, timeout de pyservices…) para que
        // el panel lo muestre en vez de un genérico "no se pudo leer".
        const detalle = await res.text().catch(() => '');
        this.logger.warn(
          `pyservices /vision/constancia-fiscal respondió ${res.status}: ${detalle.slice(0, 200)}`,
        );
        let motivo = `pyservices ${res.status}`;
        try {
          const j = JSON.parse(detalle) as { detail?: string };
          if (j.detail) motivo = j.detail;
        } catch {
          /* texto plano */
        }
        return { motivo } as ConstanciaFiscalVisionResult & { motivo: string };
      }
      const data = (await res.json()) as ConstanciaFiscalVisionResult;
      this.iaUso.registrar(reg?.categoria ?? 'CONSTANCIA_FISCAL', data.uso_ia, {
        usuarioId: reg?.usuarioId,
        contexto: reg?.contexto,
      });
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`readConstanciaFiscal falló: ${msg}`);
      return {
        motivo: msg.includes('abort')
          ? 'La lectura tardó demasiado (timeout API→pyservices)'
          : `Sin conexión con pyservices: ${msg.slice(0, 120)}`,
      } as ConstanciaFiscalVisionResult & { motivo: string };
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
    reg?: RegistroVision,
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
        this.logger.warn(
          `pyservices /vision/combustible respondió ${res.status}`,
        );
        return null;
      }
      const data = (await res.json()) as CombustibleTicketVisionResult;
      this.iaUso.registrar(
        reg?.categoria ?? 'COMBUSTIBLE_TICKET',
        data.uso_ia,
        { usuarioId: reg?.usuarioId, contexto: reg?.contexto },
      );
      return data;
    } catch (err) {
      this.logger.warn(
        `readCombustibleTicket falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ficha de un producto de inventario desde varias fotos (mismo patrón que
   * readGastoTicket: best-effort, y si falla devuelve el MOTIVO legible para
   * que la app lo muestre en vez de un genérico "no se pudo leer"). Los
   * códigos de barras que regresa pasan por `normalizarCodigo` (sin
   * espacios, UPC-A canónico): la misma fuente única que el escáner y el
   * alta, para que lo que la IA lee coincida con lo que se busca.
   */
  async readInventarioItem(
    input: InventarioItemVisionInput,
    reg?: RegistroVision,
  ): Promise<(InventarioItemVisionResult & { motivo?: string }) | null> {
    if (!this.enabled) return null;
    const images = (input.images ?? []).filter(
      (i) => i.imageBase64 || i.imageUrl,
    );
    if (images.length === 0) return null;

    const controller = new AbortController();
    // Varias fotos = documento: mismo margen que las facturas multi-página.
    const timer = setTimeout(
      () => controller.abort(),
      images.length > 1 ? Math.max(this.timeoutMs, 150_000) : this.timeoutMs,
    );
    try {
      const res = await fetch(`${this.baseUrl}/vision/inventario-item`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.token,
        },
        body: JSON.stringify({
          images: images.map((i) => ({
            image_base64: i.imageBase64,
            media_type: i.mediaType,
            image_url: i.imageUrl,
          })),
          categorias: input.categorias ?? [],
          codigos_escaneados: input.codigosEscaneados?.length
            ? input.codigosEscaneados
            : undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detalle = await res.text().catch(() => '');
        this.logger.warn(
          `pyservices /vision/inventario-item respondió ${res.status}: ${detalle.slice(0, 200)}`,
        );
        let motivo = `pyservices ${res.status}`;
        try {
          const j = JSON.parse(detalle) as { detail?: string };
          if (j.detail) motivo = j.detail;
        } catch {
          /* texto plano */
        }
        return { motivo } as InventarioItemVisionResult & { motivo: string };
      }
      const ai = (await res.json()) as InventarioItemVisionResult;
      this.iaUso.registrar(reg?.categoria ?? 'INVENTARIO_ITEM', ai.uso_ia, {
        usuarioId: reg?.usuarioId,
        contexto: reg?.contexto,
      });
      ai.codigo_barras = normalizarCodigo(ai.codigo_barras);
      if (ai.empaque) {
        ai.empaque.codigo_barras = normalizarCodigo(ai.empaque.codigo_barras);
        const f = Number(ai.empaque.factor);
        ai.empaque.factor = Number.isFinite(f) && f > 0 ? f : null;
        // Un "empaque" sin factor ni código no aporta nada: se descarta.
        if (ai.empaque.factor == null && !ai.empaque.codigo_barras)
          ai.empaque = null;
      }
      return ai;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`readInventarioItem falló: ${msg}`);
      return {
        motivo: msg.includes('abort')
          ? 'La lectura tardó demasiado (timeout API→pyservices)'
          : `Sin conexión con pyservices: ${msg.slice(0, 120)}`,
      } as InventarioItemVisionResult & { motivo: string };
    } finally {
      clearTimeout(timer);
    }
  }
}
