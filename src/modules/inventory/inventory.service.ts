import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  PyservicesService,
  type TablaColumnaPayload,
} from '../pyservices/pyservices.service';
import {
  CreateInventarioItemDto,
  CreateMovimientoDto,
  ListInventarioQuery,
  ListMovimientosQuery,
  TipoMovimientoInventario,
  UpdateInventarioItemDto,
} from './dto/inventory.dto';

const ITEM_COLS =
  'id, nombre, numero_parte, codigo, categoria, stock_minimo, ubicacion, unidad, notas, foto_url, foto_storage_path, activo, created_at, updated_at';

/** Bucket PÚBLICO de fotos de producto (el cliente sube; el API borra). */
const FOTOS_BUCKET = 'inventario-fotos';
const MOV_COLS =
  'id, item_id, tipo, cantidad, costo_unitario_usd, moneda, costo_unitario_mxn, tc_usd_mxn, aeronave_id, proveedor_id, fecha_movimiento, fecha_orden, fecha_cargo_banco, referencia, notas, registrado_por, created_at';

/** Movimiento mínimo necesario para reconstruir el cardex FIFO. */
type MovForFifo = {
  tipo: string;
  cantidad: number | string;
  costo_unitario_usd: number | string;
  moneda?: string | null;
  costo_unitario_mxn?: number | string | null;
  tc_usd_mxn?: number | string | null;
  fecha_movimiento: string;
  created_at: string;
};

// cost = costo USD interno (reparto); costMxn = costo en pesos por unidad
// (para VER el valorizado en MXN, la moneda operativa del cliente).
type FifoLayer = {
  qty: number;
  cost: number;
  costMxn: number;
  /** El costo en pesos es REAL (compra en MXN, o USD con TC) y no el USD copiado. */
  pesosExactos: boolean;
  /** La capa se COMPRÓ en pesos. */
  enMxn: boolean;
};

const EPS = 1e-9;

/**
 * Resto de una DEVOLUCION que NO se pudo revertir contra los gastos de bodega
 * (viaja en la respuesta de createMovimiento como `reversion_pendiente`).
 */
export interface ReversionPendiente {
  /** Monto que quedó sin revertir, en la moneda nativa de la devolución. */
  sin_revertir: number;
  moneda: 'MXN' | 'USD';
  /** Gastos en otra moneda que se saltaron por no tener NINGÚN TC. */
  gastos_sin_tc: number;
}

/** Campos de costo de un movimiento (lo mínimo para expresarlo en pesos). */
type MovCosto = Pick<
  MovForFifo,
  'costo_unitario_usd' | 'moneda' | 'costo_unitario_mxn' | 'tc_usd_mxn'
>;

/**
 * Costo unitario en PESOS de un movimiento — lo que el cliente VE (bodega se
 * maneja en MXN): capturado en MXN → costo_unitario_mxn; en USD con TC →
 * usd × TC; sin TC → el número USD tal cual (no pasa cuando todo se maneja en
 * pesos). FUENTE ÚNICA: la usan las capas FIFO (buildLayers) y el Excel del
 * cardex — no duplicar el criterio.
 */
function costoUnitarioMxnDe(m: MovCosto): {
  mxn: number;
  /** El costo en pesos es REAL (compra en MXN, o USD con TC), no el USD copiado. */
  pesosExactos: boolean;
  /** La capa/movimiento se capturó en pesos. */
  enMxn: boolean;
} {
  const usd = Number(m.costo_unitario_usd);
  const enMxn = m.moneda === 'MXN' && m.costo_unitario_mxn != null;
  const conTc = m.tc_usd_mxn != null && Number(m.tc_usd_mxn) > 0;
  const mxn = enMxn
    ? Number(m.costo_unitario_mxn)
    : conTc
      ? round(usd * Number(m.tc_usd_mxn), 2)
      : usd;
  return { mxn, pesosExactos: enMxn || conTc, enMxn };
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
  ) {}

  private readonly logger = new Logger(InventoryService.name);

  /** Inventario valorizado en Excel (respeta los filtros del listado). */
  async itemsXlsx(filters: ListInventarioQuery): Promise<Buffer> {
    const { data, valor_total_mxn } = await this.listItems({
      ...filters,
      limit: 2000,
      offset: 0,
    });
    // El cliente maneja el inventario en PESOS: el Excel valoriza en MXN (el
    // USD interno solo alimenta el reparto, no este reporte de bodega).
    const columnas: TablaColumnaPayload[] = [
      { label: 'Ítem' },
      { label: 'Código' },
      { label: 'No. parte' },
      { label: 'Categoría' },
      { label: 'Ubicación' },
      { label: 'Stock', tipo: 'numero' },
      { label: 'Unidad' },
      { label: 'Mínimo', tipo: 'numero' },
      { label: 'Costo FIFO (MXN)', tipo: 'money' },
      { label: 'Valor (MXN)', tipo: 'money' },
    ];
    const filas = data.map((it) => {
      const x = it as Record<string, unknown>;
      return [
        (x.nombre as string) ?? '',
        (x.codigo as string) ?? '',
        (x.numero_parte as string) ?? '',
        (x.categoria as string) ?? '',
        (x.ubicacion as string) ?? '',
        x.stock as number,
        (x.unidad as string) ?? '',
        (x.stock_minimo as number) ?? null,
        x.costo_fifo_mxn_actual as number,
        x.valor_mxn as number,
      ];
    });
    const totales = [
      'TOTAL',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      valor_total_mxn,
    ];
    return this.pyservices.generateTablaXlsx({
      titulo: 'Inventario valorizado',
      subtitulo: `Generado ${new Date().toISOString().slice(0, 10)}`,
      columnas,
      filas,
      totales,
    });
  }

  /** Cardex (movimientos de inventario) en Excel. */
  async movimientosXlsx(filters: ListMovimientosQuery): Promise<Buffer> {
    const { data } = await this.listMovimientos({
      ...filters,
      limit: 5000,
      offset: 0,
    });
    // El cliente maneja bodega en PESOS: el costo visible va en MXN con el
    // MISMO criterio de las capas FIFO (costoUnitarioMxnDe); el USD interno
    // (el que alimenta el reparto) se exporta etiquetado para que nadie lo
    // lea como pesos (caso aceites 28-ago-2026: una columna "Costo unit." sin
    // moneda mostraba 94.71 donde el cliente esperaba ~1,658 MXN).
    const columnas: TablaColumnaPayload[] = [
      { label: 'Fecha' },
      { label: 'Tipo' },
      { label: 'Ítem' },
      { label: 'No. parte' },
      { label: 'Cantidad', tipo: 'numero' },
      { label: 'Costo unit. (MXN)', tipo: 'money' },
      { label: 'Moneda captura' },
      { label: 'TC', tipo: 'numero' },
      { label: 'Costo unit. USD (interno)', tipo: 'money' },
      { label: 'Avión' },
      { label: 'Proveedor' },
      { label: 'Referencia' },
    ];
    const filas = data.map((m) => {
      const x = m as Record<string, unknown>;
      const item = x.item as { nombre?: string; numero_parte?: string } | null;
      const aeronave = x.aeronave as { matricula?: string } | null;
      const proveedor = x.proveedor as { nombre?: string } | null;
      const costo: MovCosto = {
        costo_unitario_usd: x.costo_unitario_usd as number | string,
        moneda: x.moneda as string | null,
        costo_unitario_mxn: x.costo_unitario_mxn as number | string | null,
        tc_usd_mxn: x.tc_usd_mxn as number | string | null,
      };
      const tc = Number(costo.tc_usd_mxn);
      return [
        (x.fecha_movimiento as string) ?? '',
        (x.tipo as string) ?? '',
        item?.nombre ?? '',
        item?.numero_parte ?? '',
        Number(x.cantidad),
        costo.costo_unitario_usd != null
          ? round(costoUnitarioMxnDe(costo).mxn, 2)
          : null,
        costo.moneda === 'MXN' ? 'MXN' : 'USD',
        Number.isFinite(tc) && tc > 0 ? round(tc, 4) : null,
        costo.costo_unitario_usd != null
          ? Number(costo.costo_unitario_usd)
          : null,
        aeronave?.matricula ?? '',
        proveedor?.nombre ?? '',
        (x.referencia as string) ?? '',
      ];
    });
    return this.pyservices.generateTablaXlsx({
      titulo: 'Cardex de inventario',
      subtitulo: `Generado ${new Date().toISOString().slice(0, 10)}`,
      columnas,
      filas,
    });
  }

  // ===== Cálculo FIFO =====

  /** Orden cronológico estable: fecha_movimiento y, a igualdad, created_at. */
  private sortChrono(movs: MovForFifo[]): MovForFifo[] {
    return [...movs].sort((a, b) => {
      if (a.fecha_movimiento !== b.fecha_movimiento)
        return a.fecha_movimiento < b.fecha_movimiento ? -1 : 1;
      return a.created_at < b.created_at
        ? -1
        : a.created_at > b.created_at
          ? 1
          : 0;
    });
  }

  /**
   * Reconstruye las capas FIFO restantes procesando los movimientos en orden.
   * ENTRADA/DEVOLUCION/AJUSTE agregan capa; SALIDA consume de las más antiguas.
   */
  private buildLayers(movs: MovForFifo[]): FifoLayer[] {
    const layers: FifoLayer[] = [];
    for (const m of this.sortChrono(movs)) {
      const cant = Number(m.cantidad);
      if (m.tipo === TipoMovimientoInventario.SALIDA) {
        let need = cant;
        while (need > EPS && layers.length > 0) {
          const layer = layers[0];
          const take = Math.min(need, layer.qty);
          layer.qty -= take;
          need -= take;
          if (layer.qty <= EPS) layers.shift();
        }
      } else {
        // Costo en pesos de la capa: criterio único (costoUnitarioMxnDe).
        const { mxn, pesosExactos, enMxn } = costoUnitarioMxnDe(m);
        layers.push({
          qty: cant,
          cost: Number(m.costo_unitario_usd),
          costMxn: mxn,
          pesosExactos,
          enMxn,
        });
      }
    }
    return layers;
  }

  private statsFromLayers(layers: FifoLayer[]): {
    stock: number;
    valor_usd: number;
    costo_fifo_actual: number;
    valor_mxn: number;
    costo_fifo_mxn_actual: number;
  } {
    const stock = layers.reduce((s, l) => s + l.qty, 0);
    const valor_usd = layers.reduce((s, l) => s + l.qty * l.cost, 0);
    const valor_mxn = layers.reduce((s, l) => s + l.qty * l.costMxn, 0);
    return {
      stock: round(stock),
      valor_usd: round(valor_usd, 2),
      costo_fifo_actual: round(layers[0]?.cost ?? 0, 2),
      valor_mxn: round(valor_mxn, 2),
      costo_fifo_mxn_actual: round(layers[0]?.costMxn ?? 0, 2),
    };
  }

  /**
   * Consume `qty` de las capas FIFO. Devuelve el costo total en USD (interno)
   * y en MXN (`mxn` = null si alguna capa consumida no tiene pesos reales);
   * `todoMxn` = todas las capas consumidas se COMPRARON en pesos — el gasto
   * de bodega sale entonces en MXN, la moneda operativa del cliente. Lanza
   * si no alcanza.
   */
  private consumeFifo(
    layers: FifoLayer[],
    qty: number,
  ): { usd: number; mxn: number | null; todoMxn: boolean } {
    const disponible = layers.reduce((s, l) => s + l.qty, 0);
    if (disponible + EPS < qty) {
      // Sin nada en existencia el mensaje debe DECIR qué hacer: el stock se
      // deriva del cardex, así que un ítem recién dado de alta arranca en 0
      // aunque la pieza ya esté físicamente en la bodega (caso 6 ago 2026).
      throw new BadRequestException(
        disponible <= EPS
          ? 'Este ítem no tiene existencia registrada: captura primero una ENTRADA con la cantidad y su costo (aunque la pieza ya esté en bodega). El stock sale del cardex, no del alta del ítem.'
          : `Stock insuficiente: disponible ${round(disponible)}, salida solicitada ${qty}.`,
      );
    }
    let need = qty;
    let usd = 0;
    let mxn = 0;
    let pesosExactos = true;
    let todoMxn = true;
    for (const layer of layers) {
      if (need <= EPS) break;
      const take = Math.min(need, layer.qty);
      usd += take * layer.cost;
      mxn += take * layer.costMxn;
      if (!layer.pesosExactos) pesosExactos = false;
      if (!layer.enMxn) todoMxn = false;
      need -= take;
    }
    return {
      usd,
      mxn: pesosExactos ? mxn : null,
      todoMxn: todoMxn && pesosExactos,
    };
  }

  private async movsForItem(itemId: string): Promise<MovForFifo[]> {
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(
        'tipo, cantidad, costo_unitario_usd, moneda, costo_unitario_mxn, tc_usd_mxn, fecha_movimiento, created_at',
      )
      .eq('item_id', itemId);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  // ===== Ítems =====

  async listItems(filters: ListInventarioQuery) {
    let q = this.supabase.service
      .from('inventario_item')
      .select(ITEM_COLS, { count: 'exact' })
      .order('nombre', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.categoria) q = q.eq('categoria', filters.categoria);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(
        `nombre.ilike.${term},numero_parte.ilike.${term},codigo.ilike.${term}`,
      );
    }

    const { data: items, error, count } = await q;
    if (error) throw new Error(error.message);
    const rows = items ?? [];

    // Stock + valorizado por ítem (un solo barrido del cardex de los ítems listados).
    const ids = rows.map((r) => (r as { id: string }).id);
    const movsByItem = await this.movsByItems(ids);
    let data = rows.map((r) => {
      const it = r as Record<string, unknown> & {
        id: string;
        stock_minimo: number | null;
      };
      const stats = this.statsFromLayers(
        this.buildLayers(movsByItem.get(it.id) ?? []),
      );
      return {
        ...it,
        ...stats,
        bajo_stock:
          it.stock_minimo != null && stats.stock < Number(it.stock_minimo),
      };
    });

    if (filters.bajo_stock === true) data = data.filter((d) => d.bajo_stock);

    return {
      data,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
      valor_total_usd: round(
        data.reduce((s, d) => s + d.valor_usd, 0),
        2,
      ),
      valor_total_mxn: round(
        data.reduce((s, d) => s + d.valor_mxn, 0),
        2,
      ),
    };
  }

  private async movsByItems(
    itemIds: string[],
  ): Promise<Map<string, MovForFifo[]>> {
    const map = new Map<string, MovForFifo[]>();
    if (itemIds.length === 0) return map;
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(
        'item_id, tipo, cantidad, costo_unitario_usd, moneda, costo_unitario_mxn, tc_usd_mxn, fecha_movimiento, created_at',
      )
      .in('item_id', itemIds);
    if (error) throw new Error(error.message);
    for (const m of data ?? []) {
      const k = (m as { item_id: string }).item_id;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m);
    }
    return map;
  }

  async findItem(id: string) {
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .select(ITEM_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Ítem ${id} not found`);
    return data;
  }

  /** Detalle del ítem con cardex completo y stats FIFO. */
  async getItemDetail(id: string) {
    const item = await this.findItem(id);
    const { data: movs, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(
        `${MOV_COLS}, aeronave:aeronave!aeronave_id(matricula), proveedor:proveedor!proveedor_id(nombre)`,
      )
      .eq('item_id', id)
      .order('fecha_movimiento', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    const stats = this.statsFromLayers(this.buildLayers(movs ?? []));
    return { ...item, ...stats, movimientos: movs ?? [] };
  }

  async createItem(dto: CreateInventarioItemDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .insert({
        nombre: dto.nombre,
        numero_parte: dto.numero_parte,
        codigo: dto.codigo,
        categoria: dto.categoria,
        stock_minimo: dto.stock_minimo ?? 0,
        ubicacion: dto.ubicacion ?? 'Bodega Cancún',
        unidad: dto.unidad || null,
        notas: dto.notas,
        foto_url: dto.foto_url || null,
        foto_storage_path: dto.foto_storage_path || null,
        created_by: userId,
        updated_by: userId,
      })
      .select(ITEM_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }

  async updateItem(id: string, dto: UpdateInventarioItemDto, userId: string) {
    if (Object.keys(dto).length === 0) return this.findItem(id);
    // Si cambia (o se quita) la foto, el archivo anterior se borra del bucket
    // BEST-EFFORT con la service key — el cliente nunca borra de Storage.
    let fotoAnterior: string | null = null;
    if (dto.foto_storage_path !== undefined) {
      const current = await this.findItem(id);
      const previa =
        (current as { foto_storage_path?: string | null }).foto_storage_path ??
        null;
      if (previa && previa !== dto.foto_storage_path) fotoAnterior = previa;
    }
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select(ITEM_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Ítem ${id} not found`);
    if (fotoAnterior) {
      void this.supabase.service.storage
        .from(FOTOS_BUCKET)
        .remove([fotoAnterior])
        .catch(() => undefined);
    }
    return data;
  }

  async softDeleteItem(id: string, userId: string) {
    return this.updateItem(id, { activo: false }, userId);
  }

  // ===== Movimientos (cardex) =====

  async createMovimiento(
    itemId: string,
    dto: CreateMovimientoDto,
    userId: string,
  ) {
    const item = (await this.findItem(itemId)) as { nombre: string }; // 404 si no existe

    let costoUnitario: number;
    // Captura en PESOS (default operativo del cliente) o en USD (compras tipo
    // Aircraft Spruce). La moneda CANÓNICA interna sigue siendo USD: FIFO,
    // valorizado y el gasto de bodega que entra al reparto no cambian.
    let moneda: 'MXN' | 'USD' = dto.moneda ?? 'USD';
    let costoMxn: number | null = null;
    let tc: number | null = null;

    if (dto.tipo === TipoMovimientoInventario.SALIDA) {
      if (!dto.aeronave_id && dto.para_flota !== true) {
        throw new BadRequestException(
          'La salida debe registrar el avión (aeronave_id) o marcarse para toda la flota (para_flota).',
        );
      }
      if (dto.aeronave_id && dto.para_flota === true) {
        throw new BadRequestException(
          'Una salida para toda la flota no lleva avión específico.',
        );
      }
      const layers = this.buildLayers(await this.movsForItem(itemId));
      const consumo = this.consumeFifo(layers, dto.cantidad);
      costoUnitario = round(consumo.usd / dto.cantidad, 4);
      // El costo FIFO interno sigue en USD, pero si las capas consumidas se
      // compraron en PESOS la salida se expresa en MXN (moneda 'MXN' +
      // costo_unitario_mxn + TC ponderado) para que el cardex y el gasto de
      // bodega digan lo que realmente se pagó. Caso aceites 28-ago-2026: una
      // entrada en pesos capturada como USD multiplicó ×17 el costo del avión.
      if (consumo.mxn != null) {
        costoMxn = round(consumo.mxn / dto.cantidad, 4);
        tc = consumo.usd > 0 ? round(consumo.mxn / consumo.usd, 4) : null;
      }
      moneda = consumo.todoMxn && consumo.mxn != null ? 'MXN' : 'USD';
    } else if (moneda === 'MXN') {
      if (dto.costo_unitario_mxn == null || !(Number(dto.tc_usd_mxn) > 0)) {
        throw new BadRequestException(
          'Captura en MXN: se requieren costo_unitario_mxn y tc_usd_mxn (tipo de cambio de la compra).',
        );
      }
      costoMxn = dto.costo_unitario_mxn;
      tc = Number(dto.tc_usd_mxn);
      costoUnitario = round(costoMxn / tc, 4);
    } else {
      if (dto.costo_unitario_usd == null) {
        throw new BadRequestException(
          'costo_unitario_usd es requerido para ENTRADA, DEVOLUCION y AJUSTE.',
        );
      }
      costoUnitario = dto.costo_unitario_usd;
    }

    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .insert({
        item_id: itemId,
        tipo: dto.tipo,
        cantidad: dto.cantidad,
        costo_unitario_usd: costoUnitario,
        moneda,
        costo_unitario_mxn: costoMxn,
        tc_usd_mxn: tc,
        para_flota:
          dto.tipo === TipoMovimientoInventario.SALIDA &&
          dto.para_flota === true,
        aeronave_id: dto.aeronave_id ?? null,
        proveedor_id: dto.proveedor_id ?? null,
        fecha_movimiento: dto.fecha_movimiento ?? undefined,
        fecha_orden: dto.fecha_orden ?? null,
        fecha_cargo_banco: dto.fecha_cargo_banco ?? null,
        referencia: dto.referencia ?? null,
        notas: dto.notas ?? null,
        registrado_por: userId,
        created_by: userId,
        updated_by: userId,
      })
      .select(MOV_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referencia no encontrada: ${error.message}`,
        );
      throw new Error(error.message);
    }

    // Puente inventario → gastos (diseño 5.6): "el cargo al avión ocurre al
    // sacar la pieza de bodega". La SALIDA genera el gasto REFACCION con el
    // costo FIFO para que llegue al reporte mensual del avión y al reparto.
    // La DEVOLUCION con avión revierte ese cargo.
    let gastoGenerado: Record<string, unknown> | null = null;
    // Resto de una DEVOLUCION que no se pudo revertir (null = todo revertido):
    // viaja como `reversion_pendiente` para que el dinero no se pierda en
    // silencio (la UI puede ignorarlo; el warn en el log se conserva).
    let reversionPendiente: ReversionPendiente | null = null;
    if (
      dto.tipo === TipoMovimientoInventario.SALIDA &&
      dto.para_flota === true
    ) {
      gastoGenerado = await this.crearGastosDeSalidaFlota(
        data as Record<string, unknown>,
        item.nombre,
        userId,
      );
    } else if (dto.tipo === TipoMovimientoInventario.SALIDA) {
      gastoGenerado = await this.crearGastoDeSalida(
        data as Record<string, unknown>,
        item.nombre,
        userId,
      );
    } else if (
      dto.tipo === TipoMovimientoInventario.DEVOLUCION &&
      dto.aeronave_id
    ) {
      // Usar el costo USD ya resuelto arriba: en captura MXN el dto no trae
      // costo_unitario_usd y la reversión quedaría en 0 en silencio.
      reversionPendiente = await this.revertirGastoPorDevolucion(
        itemId,
        dto,
        costoUnitario,
        item.nombre,
        userId,
      );
    }

    const stats = this.statsFromLayers(
      this.buildLayers(await this.movsForItem(itemId)),
    );
    return {
      ...data,
      stock_resultante: stats.stock,
      valor_usd: stats.valor_usd,
      gasto_generado: gastoGenerado,
      reversion_pendiente: reversionPendiente,
    };
  }

  /**
   * Crea el gasto REFACCION del avión a partir de una SALIDA de bodega.
   * medio_pago 'BODEGA': el dinero salió del banco al COMPRAR la pieza, no al
   * consumirla, así que este cargo no debe cruzarse con la conciliación
   * bancaria. Si el costo FIFO es 0 (capas capturadas sin costo) no hay nada
   * que cargar y solo se registra en el cardex.
   */
  private async crearGastoDeSalida(
    mov: Record<string, unknown>,
    itemNombre: string,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const { monto, moneda, tcGasto } = montoGastoDeSalida(mov);
    if (monto <= 0) return null;

    const { data, error } = await this.supabase.service
      .from('gasto')
      .insert({
        usuario_captura_id: userId,
        categoria: 'REFACCION',
        monto,
        moneda,
        tc_gasto: tcGasto,
        fecha_gasto: mov.fecha_movimiento,
        medio_pago: 'BODEGA',
        estatus_comprobante: 'SIN_COMPROBANTE',
        aeronave_id: mov.aeronave_id,
        proveedor_id: mov.proveedor_id ?? null,
        inventario_movimiento_id: mov.id,
        notas:
          `Salida de bodega: ${Number(mov.cantidad)} × ${itemNombre} (costo FIFO)` +
          (mov.referencia ? ` · ref ${mov.referencia as string}` : ''),
        created_by: userId,
        updated_by: userId,
      })
      .select('id, monto, moneda, categoria')
      .maybeSingle();
    if (error) {
      // El movimiento de cardex ya quedó registrado; no lo revertimos, pero el
      // cargo económico debe quedar visible como pendiente para no descuadrar
      // el reporte del avión en silencio.
      this.logger.error(
        `SALIDA ${mov.id as string}: no se pudo crear el gasto REFACCION (${error.message}). Capturarlo manualmente.`,
      );
      return null;
    }
    return data;
  }

  /**
   * SALIDA "para todas las matrículas" (aceites/consumibles de flota): el
   * costo FIFO total se PRORRATEA en partes iguales entre los aviones
   * ACTIVOS — un gasto REFACCION medio BODEGA por avión, todos ligados al
   * mismo movimiento. Los centavos de diferencia se ajustan en el primer
   * avión para que la suma sea EXACTA al costo de la salida.
   */
  private async crearGastosDeSalidaFlota(
    mov: Record<string, unknown>,
    itemNombre: string,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const { monto, moneda, tcGasto } = montoGastoDeSalida(mov);
    if (monto <= 0) return null;

    const { data: aviones, error: avErr } = await this.supabase.service
      .from('aeronave')
      .select('id, matricula')
      .eq('activa', true)
      .order('matricula');
    if (avErr || !aviones || aviones.length === 0) {
      this.logger.error(
        `SALIDA flota ${mov.id as string}: sin aviones activos para prorratear (${avErr?.message ?? 'lista vacía'}). Capturar el gasto manualmente.`,
      );
      return null;
    }

    const n = aviones.length;
    const base = round(monto / n, 2);
    // El primero absorbe el residuo de redondeo: base×(n−1) + primero == monto.
    const primero = round(monto - base * (n - 1), 2);

    const filas = aviones.map((a, i) => ({
      usuario_captura_id: userId,
      origen: 'SISTEMA',
      categoria: 'REFACCION',
      monto: i === 0 ? primero : base,
      moneda,
      tc_gasto: tcGasto,
      fecha_gasto: mov.fecha_movimiento,
      medio_pago: 'BODEGA',
      estatus_comprobante: 'SIN_COMPROBANTE',
      aeronave_id: a.id,
      proveedor_id: mov.proveedor_id ?? null,
      inventario_movimiento_id: mov.id,
      notas:
        `Salida de bodega (toda la flota, 1/${n} del costo): ${Number(mov.cantidad)} × ${itemNombre} (costo FIFO $${monto.toFixed(2)} ${moneda})` +
        (mov.referencia ? ` · ref ${mov.referencia as string}` : ''),
      created_by: userId,
      updated_by: userId,
    }));

    const { data, error } = await this.supabase.service
      .from('gasto')
      .insert(filas)
      .select('id, monto, moneda, categoria');
    if (error) {
      this.logger.error(
        `SALIDA flota ${mov.id as string}: no se pudieron crear los gastos prorrateados (${error.message}). Capturarlos manualmente.`,
      );
      return null;
    }
    return {
      prorrateado: true,
      aviones: n,
      monto_total: monto,
      gastos: (data ?? []).length,
    };
  }

  /**
   * DEVOLUCION con avión: revierte el cargo automático. Reduce (o elimina) los
   * gastos generados por SALIDAs de este ítem a ese avión, empezando por el más
   * reciente, hasta cubrir el monto devuelto. Best-effort: las devoluciones son
   * excepcionales (≈1%) y cualquier resto se ajusta desde /admin/expenses.
   * Las salidas de FLOTA no se revierten aquí: se corrigen desde Gastos.
   *
   * El monto por revertir se lleva en la MONEDA NATIVA de la devolución (MXN
   * si se capturó en pesos; si no, USD) y cada gasto se convierte SOLO cuando
   * su moneda difiere: con el tc_gasto de ESE gasto o, si no lo trae (gasto
   * de bodega USD histórico), con el TC tecleado en la devolución
   * (`tc_usd_mxn`, obligatorio en captura MXN). Peso contra peso, dólar
   * contra dólar: antes todo se pasaba a USD con el TC de la devolución y se
   * comparaba contra el tc_gasto del gasto — dos TC distintos dejaban
   * centavos (o pesos) sin cuadrar. Sin NINGÚN TC el gasto se salta y se
   * cuenta en `gastos_sin_tc` (antes ese `continue` era silencioso y una
   * devolución MXN contra un gasto USD sin TC no revertía nada).
   *
   * Devuelve el RESTO que no se pudo revertir (null cuando se revirtió todo)
   * para que `createMovimiento` lo exponga como `reversion_pendiente`: el
   * dinero jamás desaparece en silencio (además del warn en el log).
   */
  private async revertirGastoPorDevolucion(
    itemId: string,
    dto: CreateMovimientoDto,
    costoUnitarioUsd: number,
    itemNombre: string,
    userId: string,
  ): Promise<ReversionPendiente | null> {
    const devEnMxn = dto.moneda === 'MXN' && dto.costo_unitario_mxn != null;
    const monedaDev: 'MXN' | 'USD' = devEnMxn ? 'MXN' : 'USD';
    let porRevertir = round(
      Number(dto.cantidad) *
        (devEnMxn ? Number(dto.costo_unitario_mxn) : costoUnitarioUsd),
      2,
    );
    if (porRevertir <= 0) return null;
    // TC de respaldo para gastos en OTRA moneda sin tc_gasto propio.
    const tcDev = Number(dto.tc_usd_mxn);
    let sinTc = 0;
    try {
      // Gastos automáticos de este ítem+avión (via la liga al cardex).
      const { data: movs } = await this.supabase.service
        .from('inventario_movimiento')
        .select('id')
        .eq('item_id', itemId)
        .eq('tipo', 'SALIDA')
        .eq('aeronave_id', dto.aeronave_id!);
      const movIds = (movs ?? []).map((m) => m.id as string);

      if (movIds.length > 0) {
        const { data: gastos } = await this.supabase.service
          .from('gasto')
          .select('id, monto, moneda, tc_gasto')
          .in('inventario_movimiento_id', movIds)
          .order('fecha_gasto', { ascending: false })
          .order('created_at', { ascending: false });

        for (const g of gastos ?? []) {
          if (porRevertir <= 0) break;
          const monto = Number(g.monto);
          const monedaG: 'MXN' | 'USD' = g.moneda === 'MXN' ? 'MXN' : 'USD';
          // `aDev` = multiplicador gasto → moneda de la devolución. Misma
          // moneda: 1 (sin TC de por medio). Distinta: con el tc_gasto del
          // gasto o, sin él, el TC de la devolución; sin ninguno no se puede
          // cuadrar y queda al ajuste manual (contado en gastos_sin_tc).
          let aDev: number;
          if (monedaG === monedaDev) {
            aDev = 1;
          } else {
            const tcG = Number(g.tc_gasto);
            const tcUsar = tcG > 0 ? tcG : tcDev > 0 ? tcDev : 0;
            if (!(tcUsar > 0)) {
              sinTc += 1;
              continue;
            }
            aDev = monedaG === 'MXN' ? 1 / tcUsar : tcUsar;
          }
          const montoEnDev = round(monto * aDev, 2);
          if (montoEnDev <= porRevertir + EPS) {
            await this.supabase.service
              .from('gasto')
              .delete()
              .eq('id', g.id as string);
            porRevertir = round(porRevertir - montoEnDev, 2);
          } else {
            await this.supabase.service
              .from('gasto')
              .update({
                monto: round(monto - porRevertir / aDev, 2),
                notas: `Ajustado por devolución a bodega de ${itemNombre}`,
                updated_by: userId,
              })
              .eq('id', g.id as string);
            porRevertir = 0;
          }
        }
      }
    } catch (err) {
      this.logger.error(
        `revertirGastoPorDevolucion falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (porRevertir > 0) {
      const motivo =
        sinTc > 0
          ? `${sinTc} gasto(s) en otra moneda sin TC`
          : 'no hay gastos automáticos suficientes';
      this.logger.warn(
        `DEVOLUCION de ${itemNombre}: quedaron $${porRevertir} ${monedaDev} sin revertir (${motivo}). Ajustar manualmente.`,
      );
      return {
        sin_revertir: porRevertir,
        moneda: monedaDev,
        gastos_sin_tc: sinTc,
      };
    }
    return null;
  }

  async listMovimientos(filters: ListMovimientosQuery) {
    let q = this.supabase.service
      .from('inventario_movimiento')
      .select(
        `${MOV_COLS}, item:inventario_item!item_id(nombre, numero_parte, categoria), aeronave:aeronave!aeronave_id(matricula), proveedor:proveedor!proveedor_id(nombre)`,
        { count: 'exact' },
      )
      .order('fecha_movimiento', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.item_id) q = q.eq('item_id', filters.item_id);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.tipo) q = q.eq('tipo', filters.tipo);
    if (filters.desde) q = q.gte('fecha_movimiento', filters.desde);
    if (filters.hasta) q = q.lte('fecha_movimiento', filters.hasta);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }
}

function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Monto/moneda del gasto de bodega que nace de una SALIDA: en MXN cuando la
 * salida quedó expresada en pesos (todas las capas consumidas se compraron en
 * pesos); si no, en USD. `tc_gasto` = TC ponderado de las capas (si lo hay)
 * para que el balance en pesos reproduzca lo realmente pagado.
 */
function montoGastoDeSalida(mov: Record<string, unknown>): {
  monto: number;
  moneda: 'MXN' | 'USD';
  tcGasto: number | null;
} {
  const cant = Number(mov.cantidad);
  const enMxn = mov.moneda === 'MXN' && mov.costo_unitario_mxn != null;
  const tc = Number(mov.tc_usd_mxn);
  const tcGasto = Number.isFinite(tc) && tc > 0 ? tc : null;
  const monto = round(
    cant * Number(enMxn ? mov.costo_unitario_mxn : mov.costo_unitario_usd),
    2,
  );
  return { monto, moneda: enMxn ? 'MXN' : 'USD', tcGasto };
}
