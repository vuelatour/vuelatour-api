import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import { InventoryService } from './inventory.service';
import {
  ImportarInventarioDto,
  LOTE_ALTA_MASIVA,
  MAX_FILAS_INVENTARIO,
  TipoMovimientoInventario,
} from './dto/inventory.dto';
import { hoyCancun } from '../../common/fecha-cancun.util';
import {
  MONEDAS_INVENTARIO,
  UNIDADES_SUGERIDAS,
  validarFilasInventario,
  type CatalogoImportInventario,
  type FilaImportInventario,
} from './inventario-masivo.util';

export interface ImportarInventarioResult {
  total: number;
  ok: number;
  errores: number;
  duplicados: number;
  filas: FilaImportInventario[];
  /** Solo con confirmar=true: ítems creados en esta pasada. */
  creados?: number;
}

/**
 * Alta masiva de ítems de inventario desde Excel (mismo patrón que la carga
 * masiva de combustibles): la oficina descarga la plantilla con las
 * categorías reales, la llena y la sube. `importar` con confirmar=false solo
 * valida (preview, no escribe nada); con confirmar=true crea SOLO las filas
 * OK — ítem + empaque + ENTRADA inicial vía InventoryService (mismas reglas
 * de moneda/costo/TC que el alta manual). Idempotente: lo que ya existe (por
 * código o por nombre+número de parte) sale DUPLICADO y no se vuelve a crear,
 * así que reintentar el mismo archivo tras un fallo a medias no duplica.
 */
@Injectable()
export class InventarioMasivoService {
  private readonly logger = new Logger(InventarioMasivoService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
    private readonly inventory: InventoryService,
  ) {}

  /** Plantilla XLSX con las categorías reales + unidades sugeridas. */
  async plantillaXlsx(): Promise<Buffer> {
    const categorias = await this.inventory.listCategorias();
    return this.pyservices.generarPlantillaInventario({
      categorias,
      unidades: UNIDADES_SUGERIDAS,
      monedas: [...MONEDAS_INVENTARIO],
    });
  }

  async importar(
    dto: ImportarInventarioDto,
    userId: string,
  ): Promise<ImportarInventarioResult> {
    const parsed = await this.pyservices.parseInventario(
      dto.archivo_base64,
      dto.filename,
    );
    const crudas = parsed?.filas ?? [];
    if (crudas.length === 0) {
      throw new BadRequestException(
        'El archivo no contiene filas de datos. Llena la plantilla y vuelve a subirla.',
      );
    }
    if (crudas.length > MAX_FILAS_INVENTARIO) {
      throw new BadRequestException(
        `El archivo tiene ${crudas.length} filas: máximo ${MAX_FILAS_INVENTARIO} por archivo; divide el Excel en varios archivos y súbelos uno por uno.`,
      );
    }

    const catalogo = await this.cargarCatalogo();
    const filas = validarFilasInventario(crudas, catalogo);

    let creados: number | undefined;
    if (dto.confirmar === true) creados = await this.crearFilas(filas, userId);

    return {
      total: filas.length,
      ok: filas.filter((f) => f.estado === 'OK').length,
      errores: filas.filter((f) => f.estado === 'ERROR').length,
      duplicados: filas.filter((f) => f.estado === 'DUPLICADO').length,
      filas,
      ...(creados !== undefined ? { creados } : {}),
    };
  }

  private async cargarCatalogo(): Promise<CatalogoImportInventario> {
    const svc = this.supabase.service;
    const [categorias, itemsRes, empRes] = await Promise.all([
      this.inventory.listCategorias(),
      svc
        .from('inventario_item')
        .select('id, nombre, numero_parte, codigo, activo')
        .limit(5000),
      svc
        .from('inventario_item_empaque')
        .select('codigo, item:inventario_item!item_id(nombre)')
        .not('codigo', 'is', null),
    ]);
    if (itemsRes.error) throw new Error(itemsRes.error.message);
    if (empRes.error) throw new Error(empRes.error.message);
    const items = (itemsRes.data ?? []).map((r) => {
      const x = r as Record<string, unknown>;
      return {
        id: String(x.id),
        nombre: String(x.nombre ?? ''),
        numero_parte: (x.numero_parte as string | null) ?? null,
        codigo: (x.codigo as string | null) ?? null,
        activo: x.activo !== false,
      };
    });
    const empaques = (empRes.data ?? []).map((r) => {
      const x = r as Record<string, unknown>;
      const item = x.item as { nombre?: string } | { nombre?: string }[] | null;
      const nombre = Array.isArray(item) ? item[0]?.nombre : item?.nombre;
      return { codigo: String(x.codigo), item_nombre: nombre ?? '' };
    });
    return { categorias, items, empaques };
  }

  /**
   * Crea las filas OK en LOTES de LOTE_ALTA_MASIVA en paralelo (si una falla,
   * las demás siguen). Los códigos ya se cruzaron contra toda la bodega en
   * `cargarCatalogo` + `validarFilasInventario` (una sola carga), así que
   * createItem no repite esas consultas por fila; el índice único y el
   * trigger de la BD siguen siendo la última defensa. Una fila cuya ENTRADA
   * inicial falle NO deja el ítem a medias: se borra y la fila queda en
   * ERROR con el motivo — así el reintento del archivo la vuelve a intentar
   * en vez de marcarla DUPLICADO sin stock.
   */
  private async crearFilas(
    filas: FilaImportInventario[],
    userId: string,
  ): Promise<number> {
    const pendientes = filas.filter((f) => f.estado === 'OK');
    // Una sola fecha para toda la carga (día Cancún, no el UTC del server).
    const fechaMovimiento = hoyCancun();
    let creados = 0;
    for (let i = 0; i < pendientes.length; i += LOTE_ALTA_MASIVA) {
      const lote = pendientes.slice(i, i + LOTE_ALTA_MASIVA);
      const resultados = await Promise.all(
        lote.map((fila) => this.crearFila(fila, userId, fechaMovimiento)),
      );
      creados += resultados.filter(Boolean).length;
    }
    this.logger.log(
      `Alta masiva de inventario: ${creados} ítems creados de ${filas.length} filas (usuario ${userId})`,
    );
    return creados;
  }

  /** true si la fila quedó creada; en fallo la marca ERROR (y deshace). */
  private async crearFila(
    fila: FilaImportInventario,
    userId: string,
    fechaMovimiento: string,
  ): Promise<boolean> {
    const { item, empaque, entrada_inicial } = fila.crear;
    let itemId: string | null = null;
    try {
      const creado = (await this.inventory.createItem(
        { ...item, empaques: empaque ? [empaque] : undefined },
        userId,
        { codigosYaVerificados: true },
      )) as { id: string };
      itemId = creado.id;
      if (entrada_inicial) {
        await this.inventory.createMovimiento(
          itemId,
          {
            tipo: TipoMovimientoInventario.ENTRADA,
            ...entrada_inicial,
            fecha_movimiento: fechaMovimiento,
            referencia: 'Alta masiva',
            notas: 'Existencia inicial (alta masiva)',
          },
          userId,
        );
      }
      fila.item_id = itemId;
      fila.mensajes.push(
        entrada_inicial ? 'Creado con su existencia inicial.' : 'Creado.',
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (itemId) await this.deshacerItem(itemId, fila.fila);
      fila.estado = 'ERROR';
      fila.mensajes.push(`No se pudo crear: ${msg}`);
      return false;
    }
  }

  private async deshacerItem(itemId: string, fila: number): Promise<void> {
    const { error } = await this.supabase.service
      .from('inventario_item')
      .delete()
      .eq('id', itemId);
    if (error) {
      this.logger.error(
        `Alta masiva fila ${fila}: el ítem ${itemId} quedó creado sin su existencia inicial y no se pudo borrar (${error.message}).`,
      );
    }
  }
}
