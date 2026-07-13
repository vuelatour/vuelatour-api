import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  'id, nombre, numero_parte, codigo, categoria, stock_minimo, ubicacion, unidad, notas, activo, created_at, updated_at';
const MOV_COLS =
  'id, item_id, tipo, cantidad, costo_unitario_usd, moneda, costo_unitario_mxn, tc_usd_mxn, aeronave_id, proveedor_id, fecha_movimiento, fecha_orden, fecha_cargo_banco, referencia, notas, registrado_por, created_at';

/** Movimiento mínimo necesario para reconstruir el cardex FIFO. */
type MovForFifo = {
  tipo: string;
  cantidad: number | string;
  costo_unitario_usd: number | string;
  fecha_movimiento: string;
  created_at: string;
};

type FifoLayer = { qty: number; cost: number };

const EPS = 1e-9;

@Injectable()
export class InventoryService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
  ) {}

  private readonly logger = new Logger(InventoryService.name);

  /** Inventario valorizado en Excel (respeta los filtros del listado). */
  async itemsXlsx(filters: ListInventarioQuery): Promise<Buffer> {
    const { data, valor_total_usd } = await this.listItems({
      ...filters,
      limit: 2000,
      offset: 0,
    });
    const columnas: TablaColumnaPayload[] = [
      { label: 'Ítem' },
      { label: 'Código' },
      { label: 'No. parte' },
      { label: 'Categoría' },
      { label: 'Ubicación' },
      { label: 'Stock', tipo: 'numero' },
      { label: 'Unidad' },
      { label: 'Mínimo', tipo: 'numero' },
      { label: 'Costo FIFO', tipo: 'money' },
      { label: 'Valor USD', tipo: 'money' },
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
        x.costo_fifo_actual as number,
        x.valor_usd as number,
      ];
    });
    const totales = ['TOTAL', null, null, null, null, null, null, null, null, valor_total_usd];
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
    const { data } = await this.listMovimientos({ ...filters, limit: 5000, offset: 0 });
    const columnas: TablaColumnaPayload[] = [
      { label: 'Fecha' },
      { label: 'Tipo' },
      { label: 'Ítem' },
      { label: 'No. parte' },
      { label: 'Cantidad', tipo: 'numero' },
      { label: 'Costo unit.', tipo: 'money' },
      { label: 'Avión' },
      { label: 'Proveedor' },
      { label: 'Referencia' },
    ];
    const filas = data.map((m) => {
      const x = m as Record<string, unknown>;
      const item = x.item as { nombre?: string; numero_parte?: string } | null;
      const aeronave = x.aeronave as { matricula?: string } | null;
      const proveedor = x.proveedor as { nombre?: string } | null;
      return [
        (x.fecha_movimiento as string) ?? '',
        (x.tipo as string) ?? '',
        item?.nombre ?? '',
        item?.numero_parte ?? '',
        Number(x.cantidad),
        x.costo_unitario_usd != null ? Number(x.costo_unitario_usd) : null,
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
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
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
        layers.push({ qty: cant, cost: Number(m.costo_unitario_usd) });
      }
    }
    return layers;
  }

  private statsFromLayers(layers: FifoLayer[]): {
    stock: number;
    valor_usd: number;
    costo_fifo_actual: number;
  } {
    const stock = layers.reduce((s, l) => s + l.qty, 0);
    const valor_usd = layers.reduce((s, l) => s + l.qty * l.cost, 0);
    return {
      stock: round(stock),
      valor_usd: round(valor_usd, 2),
      costo_fifo_actual: round(layers[0]?.cost ?? 0, 2),
    };
  }

  /** Consume `qty` de las capas FIFO. Devuelve el costo total o lanza si no alcanza. */
  private consumeFifo(layers: FifoLayer[], qty: number): number {
    const disponible = layers.reduce((s, l) => s + l.qty, 0);
    if (disponible + EPS < qty) {
      throw new BadRequestException(
        `Stock insuficiente: disponible ${round(disponible)}, salida solicitada ${qty}.`,
      );
    }
    let need = qty;
    let total = 0;
    for (const layer of layers) {
      if (need <= EPS) break;
      const take = Math.min(need, layer.qty);
      total += take * layer.cost;
      need -= take;
    }
    return total;
  }

  private async movsForItem(itemId: string): Promise<MovForFifo[]> {
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select('tipo, cantidad, costo_unitario_usd, fecha_movimiento, created_at')
      .eq('item_id', itemId);
    if (error) throw new Error(error.message);
    return (data ?? []) as MovForFifo[];
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
      q = q.or(`nombre.ilike.${term},numero_parte.ilike.${term},codigo.ilike.${term}`);
    }

    const { data: items, error, count } = await q;
    if (error) throw new Error(error.message);
    const rows = items ?? [];

    // Stock + valorizado por ítem (un solo barrido del cardex de los ítems listados).
    const ids = rows.map((r) => (r as { id: string }).id);
    const movsByItem = await this.movsByItems(ids);
    let data = rows.map((r) => {
      const it = r as Record<string, unknown> & { id: string; stock_minimo: number | null };
      const stats = this.statsFromLayers(this.buildLayers(movsByItem.get(it.id) ?? []));
      return {
        ...it,
        ...stats,
        bajo_stock: it.stock_minimo != null && stats.stock < Number(it.stock_minimo),
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
    };
  }

  private async movsByItems(itemIds: string[]): Promise<Map<string, MovForFifo[]>> {
    const map = new Map<string, MovForFifo[]>();
    if (itemIds.length === 0) return map;
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select('item_id, tipo, cantidad, costo_unitario_usd, fecha_movimiento, created_at')
      .in('item_id', itemIds);
    if (error) throw new Error(error.message);
    for (const m of data ?? []) {
      const k = (m as { item_id: string }).item_id;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m as MovForFifo);
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

    const stats = this.statsFromLayers(this.buildLayers((movs ?? []) as unknown as MovForFifo[]));
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
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select(ITEM_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Ítem ${id} not found`);
    return data;
  }

  async softDeleteItem(id: string, userId: string) {
    return this.updateItem(id, { activo: false }, userId);
  }

  // ===== Movimientos (cardex) =====

  async createMovimiento(itemId: string, dto: CreateMovimientoDto, userId: string) {
    const item = (await this.findItem(itemId)) as { nombre: string }; // 404 si no existe

    let costoUnitario: number;
    // Captura en PESOS (default operativo del cliente) o en USD (compras tipo
    // Aircraft Spruce). La moneda CANÓNICA interna sigue siendo USD: FIFO,
    // valorizado y el gasto de bodega que entra al reparto no cambian.
    let moneda: 'MXN' | 'USD' = dto.moneda ?? 'USD';
    let costoMxn: number | null = null;
    let tc: number | null = null;

    if (dto.tipo === TipoMovimientoInventario.SALIDA) {
      if (!dto.aeronave_id) {
        throw new BadRequestException('La salida debe registrar el avión (aeronave_id).');
      }
      const layers = this.buildLayers(await this.movsForItem(itemId));
      const total = this.consumeFifo(layers, dto.cantidad);
      costoUnitario = round(total / dto.cantidad, 4);
      moneda = 'USD'; // el costo FIFO es interno, siempre USD
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
        throw new BadRequestException(`Referencia no encontrada: ${error.message}`);
      throw new Error(error.message);
    }

    // Puente inventario → gastos (diseño 5.6): "el cargo al avión ocurre al
    // sacar la pieza de bodega". La SALIDA genera el gasto REFACCION con el
    // costo FIFO para que llegue al reporte mensual del avión y al reparto.
    // La DEVOLUCION con avión revierte ese cargo.
    let gastoGenerado: Record<string, unknown> | null = null;
    if (dto.tipo === TipoMovimientoInventario.SALIDA) {
      gastoGenerado = await this.crearGastoDeSalida(
        data as Record<string, unknown>,
        item.nombre,
        userId,
      );
    } else if (dto.tipo === TipoMovimientoInventario.DEVOLUCION && dto.aeronave_id) {
      await this.revertirGastoPorDevolucion(itemId, dto, item.nombre, userId);
    }

    const stats = this.statsFromLayers(this.buildLayers(await this.movsForItem(itemId)));
    return {
      ...data,
      stock_resultante: stats.stock,
      valor_usd: stats.valor_usd,
      gasto_generado: gastoGenerado,
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
    const monto = round(Number(mov.cantidad) * Number(mov.costo_unitario_usd), 2);
    if (monto <= 0) return null;

    const { data, error } = await this.supabase.service
      .from('gasto')
      .insert({
        usuario_captura_id: userId,
        categoria: 'REFACCION',
        monto,
        moneda: 'USD',
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
   * DEVOLUCION con avión: revierte el cargo automático. Reduce (o elimina) los
   * gastos generados por SALIDAs de este ítem a ese avión, empezando por el más
   * reciente, hasta cubrir el monto devuelto. Best-effort: las devoluciones son
   * excepcionales (≈1%) y cualquier resto se ajusta desde /admin/expenses.
   */
  private async revertirGastoPorDevolucion(
    itemId: string,
    dto: CreateMovimientoDto,
    itemNombre: string,
    userId: string,
  ): Promise<void> {
    try {
      let porRevertir = round(Number(dto.cantidad) * Number(dto.costo_unitario_usd ?? 0), 2);
      if (porRevertir <= 0) return;

      // Gastos automáticos de este ítem+avión (via la liga al cardex).
      const { data: movs } = await this.supabase.service
        .from('inventario_movimiento')
        .select('id')
        .eq('item_id', itemId)
        .eq('tipo', 'SALIDA')
        .eq('aeronave_id', dto.aeronave_id!);
      const movIds = (movs ?? []).map((m) => m.id as string);
      if (movIds.length === 0) return;

      const { data: gastos } = await this.supabase.service
        .from('gasto')
        .select('id, monto')
        .in('inventario_movimiento_id', movIds)
        .order('fecha_gasto', { ascending: false })
        .order('created_at', { ascending: false });

      for (const g of gastos ?? []) {
        if (porRevertir <= 0) break;
        const monto = Number(g.monto);
        if (monto <= porRevertir + EPS) {
          await this.supabase.service.from('gasto').delete().eq('id', g.id as string);
          porRevertir = round(porRevertir - monto, 2);
        } else {
          await this.supabase.service
            .from('gasto')
            .update({
              monto: round(monto - porRevertir, 2),
              notas: `Ajustado por devolución a bodega de ${itemNombre}`,
              updated_by: userId,
            })
            .eq('id', g.id as string);
          porRevertir = 0;
        }
      }
      if (porRevertir > 0) {
        this.logger.warn(
          `DEVOLUCION de ${itemNombre}: quedaron $${porRevertir} USD sin revertir (no hay gastos automáticos suficientes). Ajustar manualmente.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `revertirGastoPorDevolucion falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
