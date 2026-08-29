import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  PyservicesService,
  type CardexLibroEntradaPayload,
  type CardexLibroSalidaPayload,
  type TablaColumnaPayload,
} from '../pyservices/pyservices.service';
import {
  CreateInventarioItemDto,
  CreateMovimientoDto,
  EmpaqueInputDto,
  FotoInventarioDto,
  ListInventarioQuery,
  ListMovimientosQuery,
  TipoMovimientoInventario,
  UpdateEmpaqueDto,
  UpdateInventarioItemDto,
  UpdateMovimientoCostoDto,
} from './dto/inventory.dto';
import { normalizarCodigo } from './inventario-codigo.util';
import { hoyCancun } from '../../common/fecha-cancun.util';

const ITEM_COLS =
  'id, nombre, marca, numero_parte, codigo, categoria, stock_minimo, ubicacion, unidad, precio_venta, precio_venta_moneda, descripcion, notas, foto_url, foto_storage_path, fotos_adicionales, activo, created_at, updated_at';

/** Empaques (cajas) del ítem: factor = unidades por empaque; codigo = barras de la caja. */
const EMPAQUE_COLS =
  'id, item_id, nombre, factor, codigo, activo, created_at, updated_at';
/** Joins del cardex: avión, proveedor y el empaque con que se capturó. */
const MOV_JOINS =
  'aeronave:aeronave!aeronave_id(matricula), proveedor:proveedor!proveedor_id(nombre), empaque:inventario_item_empaque!empaque_id(nombre, factor)';

/** Bucket PÚBLICO de fotos de producto (el cliente sube; el API borra). */
const FOTOS_BUCKET = 'inventario-fotos';
const MOV_COLS =
  'id, item_id, tipo, cantidad, empaque_id, cantidad_empaques, costo_unitario_usd, moneda, costo_unitario_mxn, tc_usd_mxn, venta_unitaria, venta_moneda, aeronave_id, proveedor_id, fecha_movimiento, fecha_orden, fecha_cargo_banco, referencia, notas, registrado_por, created_at';

type EmpaqueRow = {
  id: string;
  item_id: string;
  nombre: string;
  factor: number | string;
  codigo: string | null;
  activo: boolean;
};

/** Movimiento mínimo necesario para reconstruir el cardex FIFO. */
type MovForFifo = {
  /** Presente cuando hace falta localizar una capa concreta (updateCostoEntrada). */
  id?: string;
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

  /**
   * Cardex de UN ítem en formato LIBRO (réplica del cuaderno del cliente):
   * bloque ENTRADAS | bloque SALIDAS lado a lado, con stock corriente,
   * venta, remanente y ganancia FIFO por salida. Todo se calcula AQUÍ
   * (pyservices SOLO renderiza). Montos en PESOS con el criterio único
   * costoUnitarioMxnDe; salida SIN precio de venta = el avión pagó el costo
   * FIFO, así que el libro la registra "vendida al costo" (ganancia 0).
   */
  async cardexLibroXlsx(
    itemId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const item = (await this.findItem(itemId)) as {
      nombre: string;
      numero_parte?: string | null;
      unidad?: string | null;
    };
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(`${MOV_COLS}, para_flota, ${MOV_JOINS}`)
      .eq('item_id', itemId);
    if (error) throw new Error(error.message);
    const movs = (data ?? []) as MovForFifo[];
    const walk = this.walkCardex(movs);

    const entradas: CardexLibroEntradaPayload[] = [];
    const salidas: CardexLibroSalidaPayload[] = [];
    let totalCompra = 0;
    let totalVenta = 0;
    let totalGanancia = 0;
    for (const m of this.sortChrono(movs)) {
      const x = m as MovForFifo & MovVenta & Record<string, unknown>;
      const info = m.id ? walk.get(m.id) : undefined;
      const cant = Number(m.cantidad);
      const ref =
        typeof x.referencia === 'string' && x.referencia
          ? ` · ref ${x.referencia}`
          : '';
      if (m.tipo === (TipoMovimientoInventario.SALIDA as string)) {
        const costoMxnFifo = info?.costoMxnFifo ?? null;
        const venta = ventaYGananciaDe(x, costoMxnFifo);
        const aCosto = venta.ventaUnitMxn == null;
        const unit =
          venta.ventaUnitMxn ??
          (costoMxnFifo != null && cant > 0
            ? round(costoMxnFifo / cant, 2)
            : null);
        const total = venta.ventaTotalMxn ?? costoMxnFifo;
        const ganancia = venta.gananciaMxn ?? (total != null ? 0 : null);
        const vendidoA =
          x.para_flota === true
            ? 'FLOTA'
            : (nombreDeJoin(x.aeronave, 'matricula') ?? '—');
        salidas.push({
          fecha: String(m.fecha_movimiento ?? ''),
          cantidad: cant,
          descripcion: `${item.nombre}${aCosto ? ' · a costo FIFO' : ''}${ref}`,
          venta_unitaria: unit,
          venta_total: total,
          remanente: info?.stockDespues ?? 0,
          ganancia,
          vendido_a: vendidoA,
        });
        if (total != null) totalVenta = round(totalVenta + total, 2);
        if (ganancia != null)
          totalGanancia = round(totalGanancia + ganancia, 2);
      } else {
        // ENTRADA en su lugar natural; DEVOLUCION/AJUSTE también SUMAN stock
        // (así los procesa buildLayers) y van de este lado con su nota.
        const { mxn } = costoUnitarioMxnDe(x);
        const unit = round(mxn, 2);
        const total = round(mxn * cant, 2);
        const pref =
          m.tipo === (TipoMovimientoInventario.DEVOLUCION as string)
            ? 'DEVOLUCIÓN — '
            : m.tipo === (TipoMovimientoInventario.AJUSTE as string)
              ? 'AJUSTE — '
              : '';
        const origen =
          nombreDeJoin(x.proveedor, 'nombre') ??
          nombreDeJoin(x.aeronave, 'matricula');
        entradas.push({
          fecha: String(m.fecha_movimiento ?? ''),
          cantidad: cant,
          descripcion: `${pref}${item.nombre}${origen ? ` · ${origen}` : ''}${ref}`,
          valor_compra_unitario: unit,
          valor_compra_total: total,
          stock_despues: info?.stockDespues ?? 0,
        });
        // Total de COMPRA = solo las ENTRADAS (una devolución o un ajuste
        // regresan valor al stock, pero no son una compra).
        if (m.tipo === (TipoMovimientoInventario.ENTRADA as string))
          totalCompra = round(totalCompra + total, 2);
      }
    }

    const buffer = await this.pyservices.generateCardexLibroXlsx({
      titulo: `Cardex — ${item.nombre}`,
      item_nombre: item.nombre,
      numero_parte: item.numero_parte ?? null,
      unidad: item.unidad ?? null,
      generado: hoyCancun(),
      moneda: 'MXN',
      entradas,
      salidas,
      total_compra: totalCompra,
      total_venta: totalVenta,
      total_ganancia: totalGanancia,
    });
    const slug =
      item.nombre
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'item';
    return { buffer, filename: `cardex-libro-${slug}.xlsx` };
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
      if (m.tipo === (TipoMovimientoInventario.SALIDA as string)) {
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

  /**
   * Recorre el cardex en orden cronológico llevando el STOCK corriente y, por
   * cada SALIDA, el costo FIFO en PESOS de las capas que consumió (mismo
   * criterio de buildLayers/costoUnitarioMxnDe — no inventa otro FIFO, lo
   * reproduce paso a paso para poder reportarlo POR MOVIMIENTO). Lo usan el
   * cardex formato libro y la ganancia por salida del detalle del ítem.
   */
  private walkCardex(
    movs: MovForFifo[],
  ): Map<string, { stockDespues: number; costoMxnFifo: number | null }> {
    const out = new Map<
      string,
      { stockDespues: number; costoMxnFifo: number | null }
    >();
    const layers: FifoLayer[] = [];
    let stock = 0;
    for (const m of this.sortChrono(movs)) {
      const cant = Number(m.cantidad);
      if (m.tipo === (TipoMovimientoInventario.SALIDA as string)) {
        let need = cant;
        let mxn = 0;
        while (need > EPS && layers.length > 0) {
          const layer = layers[0];
          const take = Math.min(need, layer.qty);
          mxn += take * layer.costMxn;
          layer.qty -= take;
          need -= take;
          if (layer.qty <= EPS) layers.shift();
        }
        stock = round(stock - cant);
        if (m.id)
          out.set(m.id, { stockDespues: stock, costoMxnFifo: round(mxn, 2) });
      } else {
        const { mxn, pesosExactos, enMxn } = costoUnitarioMxnDe(m);
        layers.push({
          qty: cant,
          cost: Number(m.costo_unitario_usd),
          costMxn: mxn,
          pesosExactos,
          enMxn,
        });
        stock = round(stock + cant);
        if (m.id) out.set(m.id, { stockDespues: stock, costoMxnFifo: null });
      }
    }
    return out;
  }

  private async movsForItem(itemId: string): Promise<MovForFifo[]> {
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(
        'id, tipo, cantidad, costo_unitario_usd, moneda, costo_unitario_mxn, tc_usd_mxn, fecha_movimiento, created_at',
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
    const [movsByItem, empaquesByItem] = await Promise.all([
      this.movsByItems(ids),
      this.empaquesByItems(ids),
    ]);
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
        empaques: empaquesByItem.get(it.id) ?? [],
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

  /** Detalle del ítem con empaques, cardex completo y stats FIFO. */
  async getItemDetail(id: string) {
    const item = await this.findItemConEmpaques(id);
    const { data: movs, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(`${MOV_COLS}, ${MOV_JOINS}`)
      .eq('item_id', id)
      .order('fecha_movimiento', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    const stats = this.statsFromLayers(this.buildLayers(movs ?? []));
    // Ganancia por SALIDA con venta (venta total MXN − costo FIFO MXN de las
    // capas consumidas): ADITIVO — solo aparece cuando la salida llevó precio
    // de venta; el resto de filas viaja intacto.
    const walk = this.walkCardex(movs ?? []);
    const movimientos = (movs ?? []).map((m) => {
      const x = m as Record<string, unknown> & { id: string; tipo: string };
      if (x.tipo !== (TipoMovimientoInventario.SALIDA as string)) return m;
      const { gananciaMxn } = ventaYGananciaDe(
        x as unknown as MovVenta,
        walk.get(x.id)?.costoMxnFifo ?? null,
      );
      return gananciaMxn != null ? { ...x, ganancia_mxn: gananciaMxn } : m;
    });
    return { ...item, ...stats, movimientos };
  }

  /**
   * `opts.codigosYaVerificados`: la alta masiva ya cruzó los códigos contra
   * TODA la bodega en una sola carga (validarFilasInventario); repetir aquí
   * las 2 consultas por código sería redundante — el índice único y el
   * trigger de la BD siguen siendo la última defensa (409 legible).
   */
  /**
   * Valida y normaliza el PAR precio_venta / precio_venta_moneda (viajan
   * juntos): un precio > 0 exige su moneda (400 legible); un precio null o 0
   * limpia AMBOS (0 no es un precio de venta: dejaría al avión sin cargo en
   * silencio); la moneda sola se ignora (el panel siempre manda el par y su
   * select trae MXN por default aunque no haya precio).
   */
  private resolverPrecioVenta(dto: {
    precio_venta?: number | null;
    precio_venta_moneda?: 'MXN' | 'USD' | null;
  }): { precio: number | null; moneda: 'MXN' | 'USD' | null } {
    if (dto.precio_venta == null || !(Number(dto.precio_venta) > 0)) {
      return { precio: null, moneda: null };
    }
    if (
      dto.precio_venta_moneda !== 'MXN' &&
      dto.precio_venta_moneda !== 'USD'
    ) {
      throw new BadRequestException(
        'Captura la moneda del precio de venta (MXN o USD) junto con el precio.',
      );
    }
    return {
      precio: round(Number(dto.precio_venta), 4),
      moneda: dto.precio_venta_moneda,
    };
  }

  async createItem(
    dto: CreateInventarioItemDto,
    userId: string,
    opts: { codigosYaVerificados?: boolean } = {},
  ) {
    const codigo = normalizarCodigo(dto.codigo);
    const precioVenta = this.resolverPrecioVenta(dto);
    const empaques = this.prepararEmpaques(dto.empaques ?? [], codigo);
    // Un código identifica UNA cosa en bodega: se verifica aquí (409 legible)
    // y además lo bloquea el trigger de la BD (ítem ↔ empaque).
    if (!opts.codigosYaVerificados) {
      if (codigo) await this.assertCodigoLibre(codigo);
      for (const e of empaques) {
        if (e.codigo) await this.assertCodigoLibre(e.codigo);
      }
    }

    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .insert({
        nombre: dto.nombre,
        marca: dto.marca || null,
        numero_parte: dto.numero_parte,
        codigo,
        categoria: dto.categoria,
        stock_minimo: dto.stock_minimo ?? 0,
        ubicacion: dto.ubicacion ?? 'Bodega Cancún',
        unidad: dto.unidad || null,
        precio_venta: precioVenta.precio,
        precio_venta_moneda: precioVenta.moneda,
        descripcion: dto.descripcion || null,
        notas: dto.notas,
        foto_url: dto.foto_url || null,
        foto_storage_path: dto.foto_storage_path || null,
        fotos_adicionales: fotosPlanas(dto.fotos_adicionales),
        created_by: userId,
        updated_by: userId,
      })
      .select(ITEM_COLS)
      .maybeSingle();
    if (error) throw this.errorDeCodigo(error, codigo);
    const item = data as Record<string, unknown> & { id: string };
    if (empaques.length === 0) return { ...item, empaques: [] as EmpaqueRow[] };

    const { data: creados, error: eEmp } = await this.supabase.service
      .from('inventario_item_empaque')
      .insert(
        empaques.map((e) => ({
          item_id: item.id,
          nombre: e.nombre,
          factor: e.factor,
          codigo: e.codigo,
          activo: true,
          created_by: userId,
          updated_by: userId,
        })),
      )
      .select(EMPAQUE_COLS);
    if (eEmp) {
      // Alta atómica para el operador: sin ítem a medias (todavía no tiene
      // cardex, así que el borrado es limpio).
      await this.supabase.service
        .from('inventario_item')
        .delete()
        .eq('id', item.id);
      throw this.errorDeCodigo(
        eEmp,
        empaques
          .map((e) => e.codigo)
          .filter(Boolean)
          .join(', '),
      );
    }
    return { ...item, empaques: (creados ?? []) as EmpaqueRow[] };
  }

  async updateItem(id: string, dto: UpdateInventarioItemDto, userId: string) {
    if (Object.keys(dto).length === 0) return this.findItemConEmpaques(id);
    // Columnas NOT NULL: un null/vacío llegaba a la BD como 23502 (500).
    if (dto.nombre !== undefined && !textoNoVacio(dto.nombre))
      throw new BadRequestException('El nombre del ítem no puede ir vacío.');
    if (dto.categoria !== undefined && !textoNoVacio(dto.categoria))
      throw new BadRequestException('La categoría del ítem no puede ir vacía.');
    if (dto.ubicacion !== undefined && !textoNoVacio(dto.ubicacion))
      throw new BadRequestException('La ubicación no puede ir vacía.');
    const cambios: Record<string, unknown> = { ...dto, updated_by: userId };
    if (dto.nombre !== undefined) cambios.nombre = dto.nombre.trim();
    if (dto.categoria !== undefined) cambios.categoria = dto.categoria.trim();
    if (dto.ubicacion !== undefined) cambios.ubicacion = dto.ubicacion.trim();
    if (dto.codigo !== undefined) {
      const codigo = normalizarCodigo(dto.codigo);
      if (codigo) await this.assertCodigoLibre(codigo, { itemId: id });
      cambios.codigo = codigo;
    }
    if (dto.marca !== undefined) cambios.marca = dto.marca || null;
    if (dto.descripcion !== undefined)
      cambios.descripcion = dto.descripcion || null;
    if (dto.unidad !== undefined) cambios.unidad = dto.unidad || null;
    // Precio de venta: el PAR viaja junto (precio → exige moneda; null/0 →
    // limpia ambos). La moneda SOLA no dice nada: no se toca.
    if (dto.precio_venta !== undefined) {
      const precioVenta = this.resolverPrecioVenta(dto);
      cambios.precio_venta = precioVenta.precio;
      cambios.precio_venta_moneda = precioVenta.moneda;
    } else if (dto.precio_venta_moneda !== undefined) {
      delete cambios.precio_venta_moneda;
    }
    if (dto.fotos_adicionales !== undefined)
      cambios.fotos_adicionales = fotosPlanas(dto.fotos_adicionales);

    // Las fotos que dejan de estar referenciadas (principal o adicionales) se
    // borran del bucket BEST-EFFORT con la service key — el cliente nunca
    // borra de Storage. Una foto que solo cambia de lugar (principal ↔
    // adicional) se conserva.
    let porBorrar: string[] = [];
    if (
      dto.foto_storage_path !== undefined ||
      dto.fotos_adicionales !== undefined
    ) {
      const actual = (await this.findItem(id)) as {
        foto_storage_path?: string | null;
        fotos_adicionales?: unknown;
      };
      const previas = [
        actual.foto_storage_path ?? null,
        ...pathsDeFotos(actual.fotos_adicionales),
      ];
      const nuevas = new Set<string | null>([
        dto.foto_storage_path !== undefined
          ? (dto.foto_storage_path ?? null)
          : (actual.foto_storage_path ?? null),
        ...(dto.fotos_adicionales !== undefined
          ? fotosPlanas(dto.fotos_adicionales).map((f) => f.path)
          : pathsDeFotos(actual.fotos_adicionales)),
      ]);
      porBorrar = previas.filter((p): p is string => !!p && !nuevas.has(p));
    }

    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .update(cambios)
      .eq('id', id)
      .select(ITEM_COLS)
      .maybeSingle();
    if (error) throw this.errorDeCodigo(error, cambios.codigo as string | null);
    if (!data) throw new NotFoundException(`Ítem ${id} not found`);
    if (porBorrar.length > 0) {
      void this.supabase.service.storage
        .from(FOTOS_BUCKET)
        .remove(porBorrar)
        .catch(() => undefined);
    }
    return {
      ...(data as Record<string, unknown>),
      empaques: await this.listEmpaques(id),
    };
  }

  // ===== Empaques (cajas) y códigos de barras =====

  /** Categorías reales de bodega (distintas, orden alfabético es-MX). */
  async listCategorias(): Promise<string[]> {
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .select('categoria')
      .limit(5000);
    if (error) throw new Error(error.message);
    const set = new Set<string>();
    for (const r of data ?? []) {
      const c = String((r as { categoria?: unknown }).categoria ?? '').trim();
      if (c) set.add(c);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
  }

  async listEmpaques(itemId: string): Promise<EmpaqueRow[]> {
    const { data, error } = await this.supabase.service
      .from('inventario_item_empaque')
      .select(EMPAQUE_COLS)
      .eq('item_id', itemId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async empaquesByItems(
    itemIds: string[],
  ): Promise<Map<string, EmpaqueRow[]>> {
    const map = new Map<string, EmpaqueRow[]>();
    if (itemIds.length === 0) return map;
    const { data, error } = await this.supabase.service
      .from('inventario_item_empaque')
      .select(EMPAQUE_COLS)
      .in('item_id', itemIds)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    for (const e of (data ?? []) as EmpaqueRow[]) {
      if (!map.has(e.item_id)) map.set(e.item_id, []);
      map.get(e.item_id)!.push(e);
    }
    return map;
  }

  /** Ítem + sus empaques (forma que exponen GET items/:id y el lookup por código). */
  async findItemConEmpaques(id: string) {
    const item = await this.findItem(id);
    return {
      ...(item as Record<string, unknown>),
      empaques: await this.listEmpaques(id),
    };
  }

  private async findEmpaqueDeItem(
    itemId: string,
    empaqueId: string,
  ): Promise<EmpaqueRow> {
    const { data, error } = await this.supabase.service
      .from('inventario_item_empaque')
      .select(EMPAQUE_COLS)
      .eq('id', empaqueId)
      .eq('item_id', itemId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new NotFoundException('El empaque no existe o no es de este ítem.');
    return data;
  }

  /**
   * Normaliza y valida los empaques de un alta: nombre, factor > 0, código
   * sin espacios, distinto al de la unidad y sin repetirse entre sí.
   */
  private prepararEmpaques(
    lista: EmpaqueInputDto[],
    codigoItem: string | null,
  ): Array<{ nombre: string; factor: number; codigo: string | null }> {
    const vistos = new Set<string>();
    return lista.map((e) => {
      const nombre = (e.nombre ?? '').trim();
      if (!nombre)
        throw new BadRequestException(
          'Cada empaque necesita un nombre (ej. "Caja de 6").',
        );
      const factor = Number(e.factor);
      if (!(factor > 0))
        throw new BadRequestException(
          `Empaque "${nombre}": las unidades por empaque deben ser mayores a 0.`,
        );
      const codigo = normalizarCodigo(e.codigo);
      if (codigo) {
        if (codigoItem && codigo === codigoItem)
          throw new BadRequestException(
            `El código ${codigo} del empaque "${nombre}" es el mismo que el de la unidad: la caja debe tener su propio código de barras.`,
          );
        if (vistos.has(codigo))
          throw new BadRequestException(
            `El código ${codigo} se repite en dos empaques.`,
          );
        vistos.add(codigo);
      }
      return { nombre, factor: round(factor, 4), codigo };
    });
  }

  /**
   * 409 si el código ya identifica otra cosa en bodega (ítem o empaque). El
   * mensaje dice DÓNDE está para que el operador lo ubique: el índice único
   * de la BD (empaques) y el trigger (ítem ↔ empaque) son la última defensa,
   * pero `inventario_item.codigo` no tiene índice único, así que esta
   * verificación es la que evita dos productos con el mismo código.
   */
  private async assertCodigoLibre(
    codigo: string,
    opts: { itemId?: string; empaqueId?: string } = {},
  ): Promise<void> {
    let qi = this.supabase.service
      .from('inventario_item')
      .select('id, nombre')
      .eq('codigo', codigo)
      .limit(1);
    if (opts.itemId) qi = qi.neq('id', opts.itemId);
    const { data: it, error: eIt } = await qi.maybeSingle();
    if (eIt) throw new Error(eIt.message);
    if (it) {
      throw new ConflictException(
        `El código ${codigo} ya está registrado en el producto "${(it as { nombre?: string }).nombre ?? ''}".`,
      );
    }
    let qe = this.supabase.service
      .from('inventario_item_empaque')
      .select('id, nombre, item:inventario_item!item_id(nombre)')
      .eq('codigo', codigo)
      .limit(1);
    if (opts.empaqueId) qe = qe.neq('id', opts.empaqueId);
    const { data: em, error: eEm } = await qe.maybeSingle();
    if (eEm) throw new Error(eEm.message);
    if (em) {
      const x = em as {
        nombre?: string;
        item?: { nombre?: string } | { nombre?: string }[] | null;
      };
      const dueno = Array.isArray(x.item) ? x.item[0]?.nombre : x.item?.nombre;
      throw new ConflictException(
        `El código ${codigo} ya es el del empaque "${x.nombre ?? ''}" de "${dueno ?? ''}".`,
      );
    }
  }

  /** Error de BD → HTTP legible (23505 = código repetido, 23503 = referencia). */
  private errorDeCodigo(
    error: { code?: string; message: string },
    codigo?: string | null,
  ): Error {
    if (error.code === '23505') {
      // El trigger de la BD ya trae un mensaje en español ("El código X ya
      // pertenece a…"); el índice único, no.
      return new ConflictException(
        error.message.startsWith('El código')
          ? error.message
          : `El código ${codigo ?? ''} ya está registrado en bodega (otro producto o empaque).`,
      );
    }
    if (error.code === '23503')
      return new BadRequestException(
        `Referencia no encontrada: ${error.message}`,
      );
    if (error.code === '23502')
      return new BadRequestException(
        `Falta un dato obligatorio: ${error.message}`,
      );
    return new Error(error.message);
  }

  /**
   * Escaneo → ¿qué es este código? ITEM (unidad) o EMPAQUE (caja) con el
   * detalle completo del ítem (como GET items/:id). 404 "Código no
   * registrado" para que la app ofrezca darlo de alta. Solo resuelve ítems
   * y empaques ACTIVOS (y empaques de ítems activos): un ítem eliminado
   * libera su código (softDeleteItem), pero si algo quedó inactivo con
   * código por otra vía, el escáner no debe abrirlo ni preseleccionarlo.
   */
  async buscarPorCodigo(codigoRaw: string) {
    const codigo = normalizarCodigo(codigoRaw);
    if (!codigo) throw new BadRequestException('Código vacío.');
    const { data: it, error: eIt } = await this.supabase.service
      .from('inventario_item')
      .select('id')
      .eq('codigo', codigo)
      .eq('activo', true)
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (eIt) throw new Error(eIt.message);
    if (it) {
      return {
        tipo: 'ITEM' as const,
        item: await this.getItemDetail(it.id),
        empaque: null,
      };
    }
    const { data: em, error: eEm } = await this.supabase.service
      .from('inventario_item_empaque')
      .select(`${EMPAQUE_COLS}, item:inventario_item!item_id(activo)`)
      .eq('codigo', codigo)
      .eq('activo', true)
      .limit(1)
      .maybeSingle();
    if (eEm) throw new Error(eEm.message);
    if (em && itemActivoDe(em.item)) {
      const e = em as EmpaqueRow;
      return {
        tipo: 'EMPAQUE' as const,
        item: await this.getItemDetail(e.item_id),
        empaque: {
          id: e.id,
          nombre: e.nombre,
          factor: Number(e.factor),
          codigo: e.codigo,
          activo: e.activo,
        },
      };
    }
    throw new NotFoundException('Código no registrado');
  }

  async createEmpaque(itemId: string, dto: EmpaqueInputDto, userId: string) {
    const item = (await this.findItem(itemId)) as { codigo?: string | null };
    const [e] = this.prepararEmpaques([dto], item.codigo ?? null);
    if (e.codigo) await this.assertCodigoLibre(e.codigo);
    const { data, error } = await this.supabase.service
      .from('inventario_item_empaque')
      .insert({
        item_id: itemId,
        nombre: e.nombre,
        factor: e.factor,
        codigo: e.codigo,
        activo: true,
        created_by: userId,
        updated_by: userId,
      })
      .select(EMPAQUE_COLS)
      .maybeSingle();
    if (error) throw this.errorDeCodigo(error, e.codigo);
    return data as EmpaqueRow;
  }

  async updateEmpaque(
    itemId: string,
    empaqueId: string,
    dto: UpdateEmpaqueDto,
    userId: string,
  ) {
    const item = (await this.findItem(itemId)) as { codigo?: string | null };
    await this.findEmpaqueDeItem(itemId, empaqueId);
    const cambios: Record<string, unknown> = { updated_by: userId };
    if (dto.nombre !== undefined) {
      // null llega con el DTO parcial: nunca .trim() sobre él (era 500).
      const nombre = textoNoVacio(dto.nombre) ? dto.nombre.trim() : '';
      if (!nombre)
        throw new BadRequestException('El empaque necesita un nombre.');
      cambios.nombre = nombre;
    }
    if (dto.factor !== undefined) {
      if (!(Number(dto.factor) > 0))
        throw new BadRequestException(
          'Las unidades por empaque deben ser mayores a 0.',
        );
      cambios.factor = round(Number(dto.factor), 4);
    }
    if (dto.codigo !== undefined) {
      const codigo = normalizarCodigo(dto.codigo);
      if (codigo) {
        if (item.codigo && codigo === item.codigo)
          throw new BadRequestException(
            `El código ${codigo} es el de la unidad: la caja debe tener su propio código de barras.`,
          );
        await this.assertCodigoLibre(codigo, { empaqueId });
      }
      cambios.codigo = codigo;
    }
    if (dto.activo !== undefined) cambios.activo = dto.activo;
    const { data, error } = await this.supabase.service
      .from('inventario_item_empaque')
      .update(cambios)
      .eq('id', empaqueId)
      .eq('item_id', itemId)
      .select(EMPAQUE_COLS)
      .maybeSingle();
    if (error) throw this.errorDeCodigo(error, cambios.codigo as string | null);
    if (!data) throw new NotFoundException('Empaque no encontrado.');
    return data as EmpaqueRow;
  }

  /** Borra un empaque SIN movimientos; con cardex → 409 (desactivar). */
  async deleteEmpaque(itemId: string, empaqueId: string) {
    const e = await this.findEmpaqueDeItem(itemId, empaqueId);
    const { count, error: eCount } = await this.supabase.service
      .from('inventario_movimiento')
      .select('id', { count: 'exact', head: true })
      .eq('empaque_id', empaqueId);
    if (eCount) throw new Error(eCount.message);
    if ((count ?? 0) > 0) {
      throw new ConflictException(
        `El empaque "${e.nombre}" ya tiene ${count} movimiento(s) en el cardex: desactívalo (activo=false) en vez de borrarlo.`,
      );
    }
    const { error } = await this.supabase.service
      .from('inventario_item_empaque')
      .delete()
      .eq('id', empaqueId)
      .eq('item_id', itemId);
    if (error) throw new Error(error.message);
    return { ok: true, id: empaqueId };
  }

  /**
   * Borrado suave. El código de barras se LIBERA (codigo = null) y sus
   * empaques se desactivan liberando también los suyos: un ítem eliminado
   * no puede seguir dueño de un código que el operador querrá reutilizar al
   * dar de alta el producto de nuevo (antes el código quedaba bloqueado para
   * siempre y GET /codigo abría el ítem eliminado). Queda rastro en notas.
   */
  async softDeleteItem(id: string, userId: string) {
    const item = (await this.findItem(id)) as {
      codigo?: string | null;
      notas?: string | null;
    };
    const empaques = await this.listEmpaques(id);
    const fecha = hoyCancun().split('-').reverse().join('-'); // dd-mm-aaaa
    const rastro: string[] = [];
    if (item.codigo)
      rastro.push(
        `Código de barras liberado: ${item.codigo} (eliminado ${fecha})`,
      );
    for (const e of empaques) {
      if (e.codigo)
        rastro.push(
          `Código de barras del empaque "${e.nombre}" liberado: ${e.codigo} (eliminado ${fecha})`,
        );
    }
    const notas =
      rastro.length > 0
        ? [item.notas?.trim(), ...rastro].filter(Boolean).join('\n')
        : undefined;

    if (empaques.length > 0) {
      const { error: eEmp } = await this.supabase.service
        .from('inventario_item_empaque')
        .update({ activo: false, codigo: null, updated_by: userId })
        .eq('item_id', id);
      if (eEmp) throw new Error(eEmp.message);
    }
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .update({
        activo: false,
        codigo: null,
        ...(notas !== undefined ? { notas } : {}),
        updated_by: userId,
      })
      .eq('id', id)
      .select(ITEM_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Ítem ${id} not found`);
    return {
      ...(data as Record<string, unknown>),
      empaques: await this.listEmpaques(id),
    };
  }

  // ===== Movimientos (cardex) =====

  /**
   * Resuelve el costo de un movimiento que APILA capa (ENTRADA / DEVOLUCION /
   * AJUSTE) según la moneda de captura. FUENTE ÚNICA: la usan
   * createMovimiento y updateCostoEntrada — no duplicar el criterio.
   * MXN exige costo_unitario_mxn + tc_usd_mxn (> 0) y deriva el USD interno;
   * USD exige costo_unitario_usd, costoMxn queda null (la captura fue en
   * dólares) y el TC se conserva si viene, para expresar la capa en pesos
   * reales (costoUnitarioMxnDe = usd × tc).
   */
  private resolverCostoEntrada(dto: {
    moneda?: 'MXN' | 'USD';
    costo_unitario_usd?: number;
    costo_unitario_mxn?: number;
    tc_usd_mxn?: number;
  }): {
    costoUnitario: number;
    moneda: 'MXN' | 'USD';
    costoMxn: number | null;
    tc: number | null;
  } {
    const moneda: 'MXN' | 'USD' = dto.moneda ?? 'USD';
    if (moneda === 'MXN') {
      if (dto.costo_unitario_mxn == null || !(Number(dto.tc_usd_mxn) > 0)) {
        throw new BadRequestException(
          'Captura en MXN: se requieren costo_unitario_mxn y tc_usd_mxn (tipo de cambio de la compra).',
        );
      }
      const costoMxn = dto.costo_unitario_mxn;
      const tc = Number(dto.tc_usd_mxn);
      return { costoUnitario: round(costoMxn / tc, 4), moneda, costoMxn, tc };
    }
    if (dto.costo_unitario_usd == null) {
      throw new BadRequestException(
        'costo_unitario_usd es requerido para ENTRADA, DEVOLUCION y AJUSTE.',
      );
    }
    return {
      costoUnitario: dto.costo_unitario_usd,
      moneda,
      costoMxn: null,
      tc: Number(dto.tc_usd_mxn) > 0 ? Number(dto.tc_usd_mxn) : null,
    };
  }

  async createMovimiento(
    itemId: string,
    dto: CreateMovimientoDto,
    userId: string,
  ) {
    const item = (await this.findItem(itemId)) as {
      nombre: string;
      precio_venta?: number | string | null;
      precio_venta_moneda?: 'MXN' | 'USD' | null;
    }; // 404 si no existe

    // Captura POR EMPAQUE (caja): la cantidad del cardex SIEMPRE va en
    // UNIDADES = cantidad_empaques × factor (fuente única del FIFO y del
    // gasto de bodega, que no cambian); el empaque y el nº de cajas se
    // guardan solo como trazabilidad.
    let empaque: { id: string; nombre: string; factor: number } | null = null;
    let cantidad: number;
    if (dto.empaque_id != null || dto.cantidad_empaques != null) {
      if (!dto.empaque_id || !(Number(dto.cantidad_empaques) > 0)) {
        throw new BadRequestException(
          'Para capturar por empaque manda empaque_id y cantidad_empaques (> 0).',
        );
      }
      const e = await this.findEmpaqueDeItem(itemId, dto.empaque_id);
      if (e.activo === false) {
        throw new BadRequestException(
          `El empaque "${e.nombre}" está inactivo: captura por unidades o reactívalo.`,
        );
      }
      empaque = { id: e.id, nombre: e.nombre, factor: Number(e.factor) };
      const calculada = round(
        Number(dto.cantidad_empaques) * empaque.factor,
        2,
      );
      if (!(calculada > 0)) {
        throw new BadRequestException(
          'La cantidad en unidades resultó 0: revisa las unidades por empaque.',
        );
      }
      // La cantidad la calcula el API (round2). Si el cliente mandó la suya y
      // difiere ≤ 0.011 se ignora en silencio (redondeo con factores
      // decimales: 2.5 × 0.946 = 2.365 → 2.37 vs 2.36 del cliente); solo
      // una diferencia mayor es un error real de captura.
      if (dto.cantidad != null && Math.abs(dto.cantidad - calculada) > 0.011) {
        throw new BadRequestException(
          `La cantidad enviada (${dto.cantidad}) no coincide con ${dto.cantidad_empaques} × ${empaque.nombre} (${empaque.factor} c/u) = ${calculada} unidades.`,
        );
      }
      cantidad = calculada;
    } else {
      if (dto.cantidad == null || !(dto.cantidad > 0)) {
        throw new BadRequestException(
          'cantidad (en unidades) es requerida, o captura por empaque con empaque_id + cantidad_empaques.',
        );
      }
      cantidad = dto.cantidad;
    }
    const presentacion = empaque
      ? `${round(Number(dto.cantidad_empaques), 2)} × ${empaque.nombre}`
      : null;
    // DTO normalizado (cantidad resuelta) para el resto del flujo.
    const d: CreateMovimientoDto = { ...dto, cantidad };

    let costoUnitario: number;
    // Captura en PESOS (default operativo del cliente) o en USD (compras tipo
    // Aircraft Spruce). La moneda CANÓNICA interna sigue siendo USD: FIFO,
    // valorizado y el gasto de bodega que entra al reparto no cambian.
    let moneda: 'MXN' | 'USD' = dto.moneda ?? 'USD';
    let costoMxn: number | null = null;
    let tc: number | null = null;
    // VENTA (decisión del cliente 29-ago-2026): en SALIDA el avión paga el
    // PRECIO DE VENTA (el capturado en la salida, o el del ítem como default);
    // el costo FIFO queda para el inventario (capas/valorizado intactos). Sin
    // precio no cambia NADA: el gasto sale a costo FIFO como siempre. Un 0
    // explícito en venta_unitaria = "esta salida va a costo FIFO".
    let ventaUnitaria: number | null = null;
    let ventaMoneda: 'MXN' | 'USD' | null = null;

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
      const consumo = this.consumeFifo(layers, cantidad);
      costoUnitario = round(consumo.usd / cantidad, 4);
      // El costo FIFO interno sigue en USD, pero si las capas consumidas se
      // compraron en PESOS la salida se expresa en MXN (moneda 'MXN' +
      // costo_unitario_mxn + TC ponderado) para que el cardex y el gasto de
      // bodega digan lo que realmente se pagó. Caso aceites 28-ago-2026: una
      // entrada en pesos capturada como USD multiplicó ×17 el costo del avión.
      if (consumo.mxn != null) {
        costoMxn = round(consumo.mxn / cantidad, 4);
        tc = consumo.usd > 0 ? round(consumo.mxn / consumo.usd, 4) : null;
      }
      moneda = consumo.todoMxn && consumo.mxn != null ? 'MXN' : 'USD';
      // Precio de venta efectivo: el del DTO (> 0) gana; sin campo en el DTO
      // se hereda el del ítem. La moneda del DTO acompaña a SU precio; la del
      // ítem al suyo (jamás cruzar precio de una fuente con moneda de otra).
      if (dto.venta_unitaria != null) {
        if (Number(dto.venta_unitaria) > 0) {
          ventaUnitaria = round(Number(dto.venta_unitaria), 4);
          ventaMoneda =
            dto.venta_moneda ??
            (item.precio_venta_moneda === 'USD' ? 'USD' : 'MXN');
        }
      } else if (Number(item.precio_venta) > 0) {
        ventaUnitaria = round(Number(item.precio_venta), 4);
        ventaMoneda = item.precio_venta_moneda === 'USD' ? 'USD' : 'MXN';
      }
    } else {
      const costo = this.resolverCostoEntrada(dto);
      costoUnitario = costo.costoUnitario;
      moneda = costo.moneda;
      costoMxn = costo.costoMxn;
      tc = costo.tc;
    }

    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .insert({
        item_id: itemId,
        tipo: dto.tipo,
        cantidad,
        empaque_id: empaque?.id ?? null,
        cantidad_empaques: empaque
          ? round(Number(dto.cantidad_empaques), 2)
          : null,
        costo_unitario_usd: costoUnitario,
        moneda,
        costo_unitario_mxn: costoMxn,
        tc_usd_mxn: tc,
        // Venta al avión (solo SALIDA con precio): el gasto BODEGA sale de
        // aquí (montoGastoDeSalida); null = la salida se cargó a costo FIFO.
        venta_unitaria: ventaUnitaria,
        venta_moneda: ventaUnitaria != null ? ventaMoneda : null,
        para_flota:
          dto.tipo === TipoMovimientoInventario.SALIDA &&
          dto.para_flota === true,
        aeronave_id: dto.aeronave_id ?? null,
        proveedor_id: dto.proveedor_id ?? null,
        // Día Cancún explícito: el default current_date de la BD es UTC y de
        // las 19:00 a las 23:59 de Cancún fechaba la SALIDA "mañana", ANTES
        // de la ENTRADA del mismo día en el orden del cardex.
        fecha_movimiento: dto.fecha_movimiento ?? hoyCancun(),
        fecha_orden: dto.fecha_orden ?? null,
        fecha_cargo_banco: dto.fecha_cargo_banco ?? null,
        referencia: dto.referencia ?? null,
        // Por empaque: las notas arrancan con "N × <empaque>" (trazabilidad).
        notas: presentacion
          ? dto.notas
            ? `${presentacion} · ${dto.notas}`
            : presentacion
          : (dto.notas ?? null),
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
        presentacion,
      );
    } else if (dto.tipo === TipoMovimientoInventario.SALIDA) {
      gastoGenerado = await this.crearGastoDeSalida(
        data as Record<string, unknown>,
        item.nombre,
        userId,
        presentacion,
      );
    } else if (
      dto.tipo === TipoMovimientoInventario.DEVOLUCION &&
      dto.aeronave_id
    ) {
      // Usar el costo USD ya resuelto arriba: en captura MXN el dto no trae
      // costo_unitario_usd y la reversión quedaría en 0 en silencio.
      reversionPendiente = await this.revertirGastoPorDevolucion(
        itemId,
        d,
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
      empaque: empaque
        ? { nombre: empaque.nombre, factor: empaque.factor }
        : null,
      stock_resultante: stats.stock,
      valor_usd: stats.valor_usd,
      gasto_generado: gastoGenerado,
      reversion_pendiente: reversionPendiente,
    };
  }

  /**
   * Corrige el COSTO de una ENTRADA de cardex (caso carga masiva
   * [CARGA-INV-AGO29]: 63 entradas a $0 que el cliente completa con el
   * precio real). SOLO costo/moneda/TC — cantidad, fecha y tipo jamás.
   * Candados: la entrada que nace de una COMPRA se corrige desde la compra
   * (ahí se prorratean envío/impuestos), y una capa ya consumida por el FIFO
   * no se toca (su costo ya viajó a los gastos del avión).
   */
  async updateCostoEntrada(
    itemId: string,
    movId: string,
    dto: UpdateMovimientoCostoDto,
    userId: string,
  ) {
    // (i) El movimiento debe existir Y ser de este ítem; solo ENTRADA.
    const { data: mov, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(MOV_COLS)
      .eq('id', movId)
      .eq('item_id', itemId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!mov) {
      throw new NotFoundException(
        `Movimiento ${movId} no encontrado en este ítem`,
      );
    }
    const actual = mov as Record<string, unknown>;
    if (actual.tipo !== (TipoMovimientoInventario.ENTRADA as string)) {
      throw new BadRequestException(
        'Solo se corrige el costo de una ENTRADA: el de las salidas lo calcula el FIFO, y devoluciones/ajustes se corrigen con un movimiento nuevo.',
      );
    }

    // (ii) Candado de COMPRA: su costo lo calcula compras.service (factura +
    // envío/impuestos prorrateados); corregirlo aquí lo descuadraría.
    const { data: linea, error: eLinea } = await this.supabase.service
      .from('compra_linea')
      .select('id, compra:compra!compra_id(folio)')
      .eq('inventario_movimiento_id', movId)
      .maybeSingle();
    if (eLinea) throw new Error(eLinea.message);
    if (linea) {
      const compraRaw = (linea as Record<string, unknown>).compra;
      const compra = Array.isArray(compraRaw)
        ? (compraRaw[0] as { folio?: number } | undefined)
        : (compraRaw as { folio?: number } | null);
      throw new ConflictException(
        `Esta entrada nace de la compra #${compra?.folio ?? '?'}: corrige el costo desde la compra (ahí se prorratean envío e impuestos).`,
      );
    }

    // (iii) Candado FIFO: si las salidas ya consumieron unidades de ESTA capa,
    // su costo ya viajó a los gastos de avión y cambiarlo aquí descuadraría.
    // E_prev = capas apiladas ANTES de esta entrada (ENTRADA + DEVOLUCION +
    // AJUSTE — omitir devoluciones/ajustes daría falsos "ya consumidos");
    // S_total = todas las SALIDAS (el FIFO consume de la capa más vieja, así
    // que una salida posterior también puede haber llegado a esta capa).
    const movs = this.sortChrono(await this.movsForItem(itemId));
    const idx = movs.findIndex((m) => m.id === movId);
    if (idx < 0) {
      throw new NotFoundException(
        `Movimiento ${movId} no encontrado en el cardex del ítem`,
      );
    }
    const salida = TipoMovimientoInventario.SALIDA as string;
    const entradasPrevias = movs
      .slice(0, idx)
      .filter((m) => m.tipo !== salida)
      .reduce((s, m) => s + Number(m.cantidad), 0);
    const salidasTotales = movs
      .filter((m) => m.tipo === salida)
      .reduce((s, m) => s + Number(m.cantidad), 0);
    if (salidasTotales > entradasPrevias + EPS) {
      const consumidas = round(
        Math.min(Number(actual.cantidad), salidasTotales - entradasPrevias),
      );
      throw new ConflictException(
        `No se puede corregir: ${consumidas} de las ${round(Number(actual.cantidad))} unidades de esta entrada ya salieron de bodega y su costo FIFO ya viajó a los gastos del avión. Ajusta con una DEVOLUCION/AJUSTE o corrige el gasto directamente.`,
      );
    }

    // (iv) Costo nuevo con el MISMO criterio de createMovimiento.
    const costo = this.resolverCostoEntrada(dto);

    // (v) Bitácora en las notas: el costo anterior no se pierde en silencio.
    const enMxnAntes =
      actual.moneda === 'MXN' && actual.costo_unitario_mxn != null;
    const montoAntes = round(
      Number(
        enMxnAntes ? actual.costo_unitario_mxn : actual.costo_unitario_usd,
      ),
      4,
    );
    const notaCorreccion = `Costo corregido ${hoyCancun()}: antes $${montoAntes} ${enMxnAntes ? 'MXN' : 'USD'}`;
    const notas = textoNoVacio(actual.notas)
      ? `${actual.notas} · ${notaCorreccion}`
      : notaCorreccion;

    const { data: updated, error: eUpd } = await this.supabase.service
      .from('inventario_movimiento')
      .update({
        costo_unitario_usd: round(costo.costoUnitario, 4),
        moneda: costo.moneda,
        // Moneda USD ⇒ pesos en null: la captura fue en dólares.
        costo_unitario_mxn:
          costo.costoMxn != null ? round(costo.costoMxn, 4) : null,
        tc_usd_mxn: costo.tc,
        notas,
        updated_by: userId,
        // updated_at lo pone el trigger de la BD.
      })
      .eq('id', movId)
      .select(MOV_COLS)
      .maybeSingle();
    if (eUpd) throw new Error(eUpd.message);

    // (vi) Stats recalculadas (mismo patrón que createMovimiento).
    const stats = this.statsFromLayers(
      this.buildLayers(await this.movsForItem(itemId)),
    );
    return {
      ...(updated as Record<string, unknown>),
      stock_resultante: stats.stock,
      valor_usd: stats.valor_usd,
      valor_mxn: stats.valor_mxn,
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
    presentacion: string | null = null,
  ): Promise<Record<string, unknown> | null> {
    const { monto, moneda, tcGasto, esVenta } = montoGastoDeSalida(mov);
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
          `Salida de bodega: ${Number(mov.cantidad)} × ${itemNombre}${presentacion ? ` (${presentacion})` : ''} (${esVenta ? 'precio de venta' : 'costo FIFO'})` +
          (mov.referencia ? ` · ref ${mov.referencia as string}` : ''),
        created_by: userId,
        updated_by: userId,
      })
      .select('id, monto, moneda, categoria')
      .maybeSingle();
    if (error) {
      // COMPENSACIÓN (29-ago): el stock NO puede bajar sin su cargo — antes
      // se dejaba el movimiento y el gasto "pendiente de capturar a mano"
      // (descuadre silencioso). Se revierte la SALIDA y se lanza claro;
      // reintentar la salida es seguro.
      await this.revertirMovimientoSinGasto(mov.id as string, 'SALIDA');
      throw new Error(
        `La salida de bodega se revirtió: no se pudo crear el gasto REFACCION del avión (${error.message}). El stock no baja sin su cargo — intenta la salida de nuevo.`,
      );
    }
    return data;
  }

  /**
   * COMPENSACIÓN del puente inventario→gastos (29-ago): borra el movimiento
   * de cardex recién insertado cuando su gasto no se pudo crear. Si el
   * borrado también falla, solo se loguea fuerte — el error original se
   * lanza igual y el descuadre queda visible en el log (nada silencioso).
   */
  private async revertirMovimientoSinGasto(
    movId: string,
    contexto: string,
  ): Promise<void> {
    const { error } = await this.supabase.service
      .from('inventario_movimiento')
      .delete()
      .eq('id', movId);
    if (error) {
      this.logger.error(
        `${contexto} ${movId}: el gasto no se creó Y la reversión del movimiento falló (${error.message}). El stock bajó SIN cargo: capturar el gasto manualmente.`,
      );
    } else {
      this.logger.warn(
        `${contexto} ${movId} revertida: su gasto REFACCION no se pudo crear (compensación).`,
      );
    }
  }

  /**
   * SALIDA "para todas las matrículas" (aceites/consumibles de flota): el
   * cargo total (PRECIO DE VENTA si la salida lo lleva; si no, costo FIFO —
   * misma fuente única montoGastoDeSalida) se PRORRATEA en partes iguales
   * entre los aviones ACTIVOS — un gasto REFACCION medio BODEGA por avión,
   * todos ligados al mismo movimiento. Los centavos de diferencia se ajustan
   * en el primer avión para que la suma sea EXACTA al total de la salida.
   */
  private async crearGastosDeSalidaFlota(
    mov: Record<string, unknown>,
    itemNombre: string,
    userId: string,
    presentacion: string | null = null,
  ): Promise<Record<string, unknown> | null> {
    const { monto, moneda, tcGasto, esVenta } = montoGastoDeSalida(mov);
    if (monto <= 0) return null;

    const { data: aviones, error: avErr } = await this.supabase.service
      .from('aeronave')
      .select('id, matricula')
      .eq('activa', true)
      .order('matricula');
    if (avErr || !aviones || aviones.length === 0) {
      // Mismo patrón que la salida individual (29-ago): sin gastos no hay
      // cargo — el stock no puede bajar sin él.
      await this.revertirMovimientoSinGasto(mov.id as string, 'SALIDA flota');
      throw new Error(
        `La salida de bodega (flota) se revirtió: no hay aviones activos para prorratear el costo (${avErr?.message ?? 'lista vacía'}).`,
      );
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
        `Salida de bodega (toda la flota, 1/${n} del ${esVenta ? 'precio de venta' : 'costo'}): ${Number(mov.cantidad)} × ${itemNombre}${presentacion ? ` (${presentacion})` : ''} (${esVenta ? 'precio de venta' : 'costo FIFO'} $${monto.toFixed(2)} ${moneda})` +
        (mov.referencia ? ` · ref ${mov.referencia as string}` : ''),
      created_by: userId,
      updated_by: userId,
    }));

    const { data, error } = await this.supabase.service
      .from('gasto')
      .insert(filas)
      .select('id, monto, moneda, categoria');
    if (error) {
      // COMPENSACIÓN (29-ago): mismo invariante que la salida individual —
      // el stock no baja sin su cargo. Insert en lote = o entran todos los
      // gastos o ninguno; se revierte el movimiento y se lanza claro.
      await this.revertirMovimientoSinGasto(mov.id as string, 'SALIDA flota');
      throw new Error(
        `La salida de bodega (flota) se revirtió: no se pudieron crear los gastos prorrateados (${error.message}). Intenta la salida de nuevo.`,
      );
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
   *
   * VENTA (29-ago-2026): la reversión casa contra `gasto.monto` — LO QUE
   * REALMENTE SE CARGÓ al avión, sea precio de venta o costo FIFO — así que
   * los gastos a precio de venta se revierten igual (se borran/reducen hasta
   * cubrir el monto devuelto); no hay que distinguirlos aquí.
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
        `${MOV_COLS}, item:inventario_item!item_id(nombre, numero_parte, categoria), ${MOV_JOINS}`,
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
    // Pendientes de costo real (carga masiva a $0): solo cuando viene true.
    if (filters.sin_costo === true) q = q.eq('costo_unitario_usd', 0);

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

/** true si es un string con algo más que espacios (null/undefined/'' → false). */
function textoNoVacio(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** `activo` del ítem embebido en un join de supabase (objeto o arreglo). */
function itemActivoDe(raw: unknown): boolean {
  const it = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  return (
    !!it &&
    typeof it === 'object' &&
    (it as { activo?: unknown }).activo !== false
  );
}

/** Fotos adicionales como jsonb plano [{url, path}] (sin instancias de DTO). */
function fotosPlanas(
  fotos: FotoInventarioDto[] | null | undefined,
): Array<{ url: string; path: string }> {
  return (fotos ?? []).map((f) => ({ url: f.url, path: f.path }));
}

/** Paths de un jsonb de fotos (tolerante a basura). */
function pathsDeFotos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) =>
      f &&
      typeof f === 'object' &&
      typeof (f as { path?: unknown }).path === 'string'
        ? (f as { path: string }).path
        : null,
    )
    .filter((p): p is string => !!p);
}

/** Campos de VENTA de una salida (lo mínimo para expresarla en pesos). */
type MovVenta = {
  cantidad: number | string;
  venta_unitaria?: number | string | null;
  venta_moneda?: string | null;
  tc_usd_mxn?: number | string | null;
};

/**
 * Venta en PESOS y ganancia de una SALIDA — criterio único (cardex formato
 * libro y detalle del ítem): venta MXN va tal cual; venta USD se expresa en
 * pesos con el TC ponderado FIFO de la salida (mov.tc_usd_mxn) y, sin TC, el
 * número tal cual (mismo último recurso de costoUnitarioMxnDe — no pasa
 * cuando todo se maneja en pesos). Ganancia = venta total MXN − costo FIFO
 * MXN de las capas consumidas. Sin venta (salida cargada a costo) todo va
 * null: no hay ganancia que reportar.
 */
function ventaYGananciaDe(
  mov: MovVenta,
  costoMxnFifo: number | null,
): {
  ventaUnitMxn: number | null;
  ventaTotalMxn: number | null;
  gananciaMxn: number | null;
} {
  const cant = Number(mov.cantidad);
  const venta = mov.venta_unitaria != null ? Number(mov.venta_unitaria) : null;
  if (venta == null || !(venta > 0)) {
    return { ventaUnitMxn: null, ventaTotalMxn: null, gananciaMxn: null };
  }
  const tc = Number(mov.tc_usd_mxn);
  const unit =
    mov.venta_moneda === 'USD'
      ? tc > 0
        ? round(venta * tc, 2)
        : venta
      : venta;
  const total = round(unit * cant, 2);
  return {
    ventaUnitMxn: round(unit, 2),
    ventaTotalMxn: total,
    gananciaMxn: costoMxnFifo != null ? round(total - costoMxnFifo, 2) : null,
  };
}

/** Campo de un join embebido de supabase (objeto o arreglo), o null. */
function nombreDeJoin(raw: unknown, campo: string): string | null {
  const o = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  if (!o || typeof o !== 'object') return null;
  const v = (o as Record<string, unknown>)[campo];
  return typeof v === 'string' && v ? v : null;
}

/**
 * Monto/moneda del gasto de bodega que nace de una SALIDA — FUENTE ÚNICA del
 * monto/moneda/TC del cargo al avión (salida individual Y prorrateo de flota).
 *
 * CARGO A PRECIO DE VENTA (decisión del cliente 29-ago-2026): si la salida
 * lleva `venta_unitaria`, el avión paga venta_unitaria × cantidad en
 * `venta_moneda` (el costo FIFO queda SOLO para el inventario: capas,
 * valorizado y cardex no cambian). CRITERIO DE TC de la venta: `tc_gasto`
 * lleva el TC ponderado FIFO de las capas consumidas (mov.tc_usd_mxn) como
 * REFERENCIA — es el TC real de lo que costó la pieza y permite expresar el
 * gasto en la otra moneda para el reparto/balance; si las capas no traían TC,
 * queda null y los lectores aplican su respaldo de siempre (TC del día /
 * `vuelo.tc_usd_mxn`). Sin venta, NADA cambia: costo FIFO exacto como hoy
 * (en MXN cuando todas las capas consumidas se compraron en pesos, si no
 * USD; `tc_gasto` = TC ponderado de las capas).
 */
function montoGastoDeSalida(mov: Record<string, unknown>): {
  monto: number;
  moneda: 'MXN' | 'USD';
  tcGasto: number | null;
  /** true = el cargo salió del PRECIO DE VENTA (no del costo FIFO). */
  esVenta: boolean;
} {
  const cant = Number(mov.cantidad);
  const tc = Number(mov.tc_usd_mxn);
  const tcGasto = Number.isFinite(tc) && tc > 0 ? tc : null;
  const venta = mov.venta_unitaria != null ? Number(mov.venta_unitaria) : null;
  if (venta != null && venta > 0) {
    return {
      monto: round(cant * venta, 2),
      moneda: mov.venta_moneda === 'USD' ? 'USD' : 'MXN',
      tcGasto,
      esVenta: true,
    };
  }
  const enMxn = mov.moneda === 'MXN' && mov.costo_unitario_mxn != null;
  const monto = round(
    cant * Number(enMxn ? mov.costo_unitario_mxn : mov.costo_unitario_usd),
    2,
  );
  return { monto, moneda: enMxn ? 'MXN' : 'USD', tcGasto, esVenta: false };
}
