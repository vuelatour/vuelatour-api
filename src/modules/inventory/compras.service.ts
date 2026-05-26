import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import type { EnvVars } from '../../config/env.schema';
import { InventoryService } from './inventory.service';
import { TipoMovimientoInventario } from './dto/inventory.dto';
import type { ExtraerCompraDto, ImportarCompraDto } from './dto/compras.dto';

export interface CompraExtraida {
  proveedor: string | null;
  fecha: string | null;
  moneda: string;
  lineas: Array<{
    nombre: string;
    numero_parte: string | null;
    cantidad: number;
    precio_unitario_usd: number | null;
    total_usd: number | null;
  }>;
  subtotal_usd: number | null;
  shipping_usd: number | null;
  impuestos_usd: number | null;
  total_usd: number | null;
  confianza: number;
  notas: string;
  modelo: string;
}

/** Extracción de PDF de compra (pyservices/Claude) e importación al inventario. */
@Injectable()
export class ComprasService {
  private readonly logger = new Logger(ComprasService.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
    private readonly inventory: InventoryService,
  ) {}

  async extraer(dto: ExtraerCompraDto): Promise<CompraExtraida> {
    const baseUrl = this.config.get('PYSERVICES_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException('Extracción de PDF no configurada (pyservices).');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(`${baseUrl}/compras/extraer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
        body: JSON.stringify({ pdf_base64: dto.pdf_base64 }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ServiceUnavailableException(`pyservices respondió ${res.status} al extraer el PDF`);
      }
      return (await res.json()) as CompraExtraida;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`extraer compra falló: ${msg}`);
      throw new ServiceUnavailableException(`No se pudo extraer el PDF: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Crea (o reutiliza) cada ítem y registra una ENTRADA por línea. Reutiliza por
   * número de parte si existe; si no, por nombre+categoría.
   */
  async importar(dto: ImportarCompraDto, userId: string) {
    let itemsCreados = 0;
    let entradas = 0;

    for (const linea of dto.lineas) {
      const itemId = await this.findOrCreateItem(linea, userId, () => {
        itemsCreados += 1;
      });
      await this.inventory.createMovimiento(
        itemId,
        {
          tipo: TipoMovimientoInventario.ENTRADA,
          cantidad: linea.cantidad,
          costo_unitario_usd: linea.costo_unitario_usd,
          proveedor_id: dto.proveedor_id,
          fecha_orden: dto.fecha_orden,
          referencia: dto.referencia,
        },
        userId,
      );
      entradas += 1;
    }

    return { items_creados: itemsCreados, entradas };
  }

  private async findOrCreateItem(
    linea: ImportarCompraDto['lineas'][number],
    userId: string,
    onCreate: () => void,
  ): Promise<string> {
    const svc = this.supabase.service;

    if (linea.numero_parte) {
      const { data } = await svc
        .from('inventario_item')
        .select('id')
        .eq('numero_parte', linea.numero_parte)
        .eq('activo', true)
        .limit(1)
        .maybeSingle();
      if (data) return (data as { id: string }).id;
    } else {
      const { data } = await svc
        .from('inventario_item')
        .select('id')
        .ilike('nombre', linea.nombre)
        .eq('categoria', linea.categoria)
        .eq('activo', true)
        .limit(1)
        .maybeSingle();
      if (data) return (data as { id: string }).id;
    }

    const created = await this.inventory.createItem(
      {
        nombre: linea.nombre,
        numero_parte: linea.numero_parte,
        categoria: linea.categoria,
      },
      userId,
    );
    onCreate();
    return (created as { id: string }).id;
  }
}
