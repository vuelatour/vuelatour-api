import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import type { EnvVars } from '../../config/env.schema';
import { calcularCompra, type CargoFactura } from '../compras/compras.calculo';
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

/** Lo mínimo para ubicar/crear un ítem del inventario. */
export interface ItemRef {
  nombre: string;
  numero_parte?: string | null;
  categoria: string;
}

/** `id` (uuid) de una fila cruda de supabase; null si no viene. */
function idDe(row: unknown): string | null {
  if (row && typeof row === 'object' && 'id' in row) {
    const id = row.id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

/**
 * Reutiliza el ítem por número de parte si existe; si no, por nombre+categoría;
 * si tampoco, lo crea. Helper compartido (importación desde PDF y recepción
 * de compras — módulo `compras`) para que ambos caminos resuelvan el MISMO
 * ítem y el cardex no se parta en duplicados.
 */
export async function findOrCreateItem(
  svc: SupabaseClient,
  inventory: InventoryService,
  ref: ItemRef,
  userId: string,
): Promise<{ id: string; creado: boolean }> {
  if (ref.numero_parte) {
    const { data } = await svc
      .from('inventario_item')
      .select('id')
      .eq('numero_parte', ref.numero_parte)
      .eq('activo', true)
      .limit(1)
      .maybeSingle();
    const id = idDe(data);
    if (id) return { id, creado: false };
  } else {
    const { data } = await svc
      .from('inventario_item')
      .select('id')
      .ilike('nombre', ref.nombre)
      .eq('categoria', ref.categoria)
      .eq('activo', true)
      .limit(1)
      .maybeSingle();
    const id = idDe(data);
    if (id) return { id, creado: false };
  }

  const created = await inventory.createItem(
    {
      nombre: ref.nombre,
      numero_parte: ref.numero_parte ?? undefined,
      categoria: ref.categoria,
    },
    userId,
  );
  return { id: (created as { id: string }).id, creado: true };
}

/** Día Cancún (UTC−5) de un ISO; una fecha YYYY-MM-DD se respeta tal cual. */
function diaCancun(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return new Date(new Date(iso).getTime() - 5 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
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
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'Extracción de PDF no configurada (pyservices).',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(`${baseUrl}/compras/extraer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        body: JSON.stringify({ pdf_base64: dto.pdf_base64 }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ServiceUnavailableException(
          `pyservices respondió ${res.status} al extraer el PDF`,
        );
      }
      return (await res.json()) as CompraExtraida;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`extraer compra falló: ${msg}`);
      throw new ServiceUnavailableException(
        `No se pudo extraer el PDF: ${msg}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Importa una factura ya extraída: crea la COMPRA (sin gasto ligado — la
   * oficina lo liga después desde Compras), crea (o reutiliza) cada ítem y
   * registra una ENTRADA por línea con el costo FINAL (factura +
   * shipping/impuestos de la propia factura prorrateados por valor, misma
   * fuente única `calcularCompra`). Devuelve `compra_id`.
   *
   * Orden a prueba de fallos: se valida TODO antes de escribir, la compra
   * nace ABIERTA y solo se sella RECIBIDA cuando todas las ENTRADAS existen;
   * si algo truena a medias se borran las ENTRADAS creadas aquí y la compra
   * (las líneas caen en cascada) — nada de compras zombi sin cardex.
   */
  async importar(dto: ImportarCompraDto, userId: string) {
    const svc = this.supabase.service;
    const moneda: 'USD' | 'MXN' = dto.moneda === 'MXN' ? 'MXN' : 'USD';
    const tc = dto.tc_usd_mxn && dto.tc_usd_mxn > 0 ? dto.tc_usd_mxn : null;
    if (!dto.lineas || dto.lineas.length === 0) {
      throw new BadRequestException('La compra debe traer al menos una línea.');
    }
    if (moneda === 'MXN' && tc == null) {
      throw new BadRequestException(
        'Compra en pesos: captura el tipo de cambio (tc_usd_mxn) para importar.',
      );
    }
    const cargos: CargoFactura[] = [];
    if (dto.shipping_usd && dto.shipping_usd > 0) {
      cargos.push({ concepto: 'Shipping', monto: dto.shipping_usd });
    }
    if (dto.impuestos_usd && dto.impuestos_usd > 0) {
      cargos.push({ concepto: 'Impuestos', monto: dto.impuestos_usd });
    }
    const fecha = dto.fecha_orden ? diaCancun(dto.fecha_orden) : undefined;
    const calc = calcularCompra(
      { moneda, tc_usd_mxn: tc, cargos_factura: cargos, estado: 'ABIERTA' },
      dto.lineas.map((l) => ({ ...l, costo_unitario: l.costo_unitario_usd })),
      [],
    );

    const { data: compra, error: eCompra } = await svc
      .from('compra')
      .insert({
        proveedor_id: dto.proveedor_id ?? null,
        fecha,
        referencia: dto.referencia ?? null,
        moneda,
        tc_usd_mxn: tc,
        estado: 'ABIERTA',
        cargos_factura: cargos,
        notas: 'Importada desde PDF',
        created_by: userId,
        updated_by: userId,
      })
      .select('id, folio, fecha')
      .maybeSingle();
    if (eCompra) {
      if (eCompra.code === '23503')
        throw new BadRequestException('Proveedor no encontrado.');
      if (eCompra.code === '22007' || eCompra.code === '22008')
        throw new BadRequestException('fecha inválida (YYYY-MM-DD)');
      throw new Error(eCompra.message);
    }
    const {
      id: compraId,
      folio,
      fecha: fechaCompra,
    } = compra as {
      id: string;
      folio: number;
      fecha: string;
    };
    const referencia =
      `Compra #${folio}${dto.referencia ? ` · ${dto.referencia}` : ''}`.slice(
        0,
        100,
      );

    let itemsCreados = 0;
    let orden = 1;
    // ENTRADAS creadas en ESTA llamada (para deshacerlas si algo falla).
    const movIds: string[] = [];
    try {
      for (const linea of calc.lineas) {
        const { id: itemId, creado } = await findOrCreateItem(
          svc,
          this.inventory,
          linea,
          userId,
        );
        if (creado) itemsCreados += 1;
        // La factura puede venir en MXN (compra local) o USD (Aircraft
        // Spruce): el costo de cada línea se interpreta en la moneda
        // declarada y el movimiento guarda el original + TC (el saneado, no
        // el crudo del DTO); la contabilidad interna sigue USD.
        const mov = (await this.inventory.createMovimiento(
          itemId,
          {
            tipo: TipoMovimientoInventario.ENTRADA,
            cantidad: linea.cantidad,
            moneda,
            ...(moneda === 'MXN'
              ? {
                  costo_unitario_mxn: linea.costo_unitario_final,
                  tc_usd_mxn: tc as number,
                }
              : { costo_unitario_usd: linea.costo_unitario_final }),
            proveedor_id: dto.proveedor_id,
            fecha_movimiento: fechaCompra,
            fecha_orden: dto.fecha_orden,
            referencia,
          },
          userId,
        )) as { id: string };
        movIds.push(mov.id);
        if (moneda === 'USD' && tc) {
          // Capa USD con TC conocido: el cardex la expresa en pesos reales.
          const { error: eTc } = await svc
            .from('inventario_movimiento')
            .update({ tc_usd_mxn: tc, updated_by: userId })
            .eq('id', mov.id);
          if (eTc) throw new Error(eTc.message);
        }

        const { error: eLinea } = await svc.from('compra_linea').insert({
          compra_id: compraId,
          orden: orden++,
          item_id: itemId,
          nombre: linea.nombre,
          numero_parte: linea.numero_parte || null,
          categoria: linea.categoria || null,
          cantidad: linea.cantidad,
          costo_unitario: linea.costo_unitario_usd,
          inventario_movimiento_id: mov.id,
        });
        if (eLinea) throw new Error(eLinea.message);
      }

      // Todas las ENTRADAS existen: ahora sí queda RECIBIDA.
      const { error: eSello } = await svc
        .from('compra')
        .update({
          estado: 'RECIBIDA',
          recibida_at: new Date().toISOString(),
          updated_by: userId,
        })
        .eq('id', compraId);
      if (eSello) throw new Error(eSello.message);
    } catch (err) {
      await this.deshacerImportacion(compraId, folio, movIds);
      throw err;
    }

    return {
      items_creados: itemsCreados,
      entradas: movIds.length,
      compra_id: compraId,
      folio,
    };
  }

  /**
   * Limpieza de una importación fallida a medias: borra las ENTRADAS creadas
   * en esta llamada (una ENTRADA no genera gasto, así que no deja rastro en
   * dinero) y la compra (sus líneas caen en cascada). Un fallo de la propia
   * limpieza se registra pero NO tapa el error original.
   */
  private async deshacerImportacion(
    compraId: string,
    folio: number,
    movIds: string[],
  ): Promise<void> {
    const svc = this.supabase.service;
    try {
      if (movIds.length > 0) {
        const { error } = await svc
          .from('inventario_movimiento')
          .delete()
          .in('id', movIds);
        if (error) throw new Error(error.message);
      }
      const { error } = await svc.from('compra').delete().eq('id', compraId);
      if (error) throw new Error(error.message);
      this.logger.warn(
        `importar compra #${folio}: fallo a medias, se deshicieron ${movIds.length} ENTRADAS y la compra`,
      );
    } catch (e) {
      this.logger.error(
        `importar compra #${folio}: no se pudo deshacer la importación fallida (${movIds.length} ENTRADAS): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
