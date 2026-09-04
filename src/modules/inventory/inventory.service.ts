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
  type BalanceHojaInventarioPayload,
  type BalanceInventarioItemFilaPayload,
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
// FIFO, venta/ganancia y agregados del cardex: fuente única (con spec).
import {
  agregadosDeItem,
  bloquesCardexDe,
  buildLayers,
  costoSinTc,
  costoUnitarioMxnDe,
  EPS,
  filtroPeriodo,
  resumenDiarioDe,
  round,
  sortChrono,
  statsFromLayers,
  ventaYGananciaDe,
  walkCardex,
  type FifoLayer,
  type MovCardex,
  type MovCosto,
  type MovForFifo,
} from './inventario-cardex.util';

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
   * venta, remanente y ganancia FIFO por salida. Los bloques son los MISMOS
   * que consume el detalle del producto en el panel (bloquesCardexDe —
   * fuente única; pyservices SOLO renderiza). Montos en PESOS con el
   * criterio único costoUnitarioMxnDe; salida SIN precio de venta = el avión
   * pagó el costo FIFO, así que el libro la registra "vendida al costo"
   * (ganancia 0).
   */
  async cardexLibroXlsx(
    itemId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const item = (await this.findItem(itemId)) as {
      nombre: string;
      numero_parte?: string | null;
      unidad?: string | null;
    };
    const movs = await this.movsCardexCompleto(itemId);
    const { compras, ventas, totales } = bloquesCardexDe(item.nombre, movs);
    const entradas: CardexLibroEntradaPayload[] = compras.map((c) => ({
      fecha: c.fecha,
      cantidad: c.cantidad,
      descripcion: c.descripcion,
      valor_compra_unitario: c.precio_unitario_mxn,
      valor_compra_total: c.total_mxn,
      stock_despues: c.stock_despues,
    }));
    const salidas: CardexLibroSalidaPayload[] = ventas.map((v) => ({
      fecha: v.fecha,
      cantidad: v.cantidad,
      descripcion: v.descripcion,
      venta_unitaria: v.precio_unitario_mxn,
      venta_total: v.total_mxn,
      remanente: v.remanente,
      ganancia: v.ganancia_mxn,
      vendido_a: v.vendido_a,
    }));

    const buffer = await this.pyservices.generateCardexLibroXlsx({
      titulo: `Cardex — ${item.nombre}`,
      item_nombre: item.nombre,
      numero_parte: item.numero_parte ?? null,
      unidad: item.unidad ?? null,
      generado: hoyCancun(),
      moneda: 'MXN',
      entradas,
      salidas,
      // Total de COMPRA = solo las ENTRADAS (una devolución o un ajuste
      // regresan valor al stock, pero no son una compra). Total de VENTA =
      // toda la columna del libro: lo vendido con precio + lo que salió a
      // costo FIFO. Ganancia = la de las salidas con precio (las salidas a
      // costo aportan 0).
      total_compra: totales.compras_mxn ?? 0,
      total_venta: round(
        (totales.ventas_mxn ?? 0) + (totales.ventas_a_costo_mxn ?? 0),
        2,
      ),
      total_ganancia: totales.utilidad_mxn ?? 0,
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

  /**
   * Resumen "tiendita" para la hoja `inventario` del BALANCE GENERAL
   * (30-ago-2026): una fila POR ÍTEM con su existencia ACTUAL y valor a
   * costo (stock FIFO A HOY — todo el cardex, no una foto al corte), lo
   * COMPRADO en el periodo (solo ENTRADAs: una DEVOLUCION/AJUSTE regresa
   * stock pero no es compra — mismo criterio que el total de compra del
   * cardex libro), las salidas del periodo, lo VENDIDO a los aviones
   * (Σ venta de las salidas CON precio — criterio único ventaYGananciaDe),
   * la utilidad (vendido − costo FIFO consumido) y las matrículas a las que
   * se aplicó. FUENTES ÚNICAS: buildLayers/statsFromLayers para stock y
   * valorizado, walkCardex + costoUnitarioMxnDe para los pesos — cero FIFO
   * paralelo. La consulta trae el historial COMPLETO (el FIFO lo necesita);
   * el corte desde/hasta se aplica EN MEMORIA sobre fecha_movimiento
   * (string YYYY-MM-DD, mismo eje que listMovimientos). Solo ítems con
   * actividad en el periodo O con stock/valor vivo; los eliminados con
   * movimiento del periodo SÍ cuentan (su dinero ya viajó).
   */
  async resumenTiendita(
    desde: string,
    hasta: string,
  ): Promise<BalanceHojaInventarioPayload> {
    type MovTiendita = MovCardex & { id: string; item_id: string };
    // para_flota NO está en la lista base de columnas de movimiento:
    // seleccionarlo explícito (como el cardex libro) o el "FLOTA" de las
    // salidas prorrateadas se perdería en silencio. Lectura paginada hasta
    // cubrir el count: el FIFO necesita TODO el cardex.
    const data = await this.todasLasFilas<MovTiendita>((a, b) =>
      this.supabase.service
        .from('inventario_movimiento')
        .select(
          'id, item_id, tipo, cantidad, costo_unitario_usd, moneda, costo_unitario_mxn, tc_usd_mxn, venta_unitaria, venta_moneda, fecha_movimiento, created_at, para_flota, aeronave:aeronave!aeronave_id(matricula)',
          { count: 'exact' },
        )
        .order('fecha_movimiento', { ascending: true })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(a, b),
    );
    const porItem = new Map<string, MovTiendita[]>();
    for (const m of data) {
      if (!porItem.has(m.item_id)) porItem.set(m.item_id, []);
      porItem.get(m.item_id)!.push(m);
    }
    const ids = [...porItem.keys()];
    const nombrePorItem = new Map<
      string,
      { nombre: string; numero_parte: string | null }
    >();
    if (ids.length > 0) {
      // SIN filtrar activo: un ítem eliminado con cardex sigue contando.
      const { data: items, error: eItems } = await this.supabase.service
        .from('inventario_item')
        .select('id, nombre, numero_parte')
        .in('id', ids);
      if (eItems) throw new Error(eItems.message);
      for (const it of (items ?? []) as Array<{
        id: string;
        nombre: string;
        numero_parte: string | null;
      }>) {
        nombrePorItem.set(it.id, {
          nombre: it.nombre,
          numero_parte: it.numero_parte,
        });
      }
    }

    const enPeriodo = filtroPeriodo(desde, hasta);
    const filas: BalanceInventarioItemFilaPayload[] = [];
    const sinTc: string[] = [];
    for (const [itemId, movs] of porItem) {
      const stats = statsFromLayers(buildLayers(movs));
      const actividadPeriodo = movs.some(enPeriodo);
      if (!actividadPeriodo && stats.stock <= 0 && stats.valor_mxn === 0) {
        continue;
      }
      // Agregación única (agregadosDeItem): compras = solo ENTRADA;
      // vendido/utilidad = solo SALIDAs con precio; null sin actividad.
      const a = agregadosDeItem(movs, enPeriodo);
      const info = nombrePorItem.get(itemId);
      const nombre = info
        ? info.numero_parte
          ? `${info.nombre} · ${info.numero_parte}`
          : info.nombre
        : 'Ítem eliminado';
      // Movimientos USD sin TC: compras/utilidad afectadas van null (jamás
      // USD sumado como MXN). La hoja no tiene columna de aviso: queda en el
      // log y el panel lo marca en ámbar (con_movimientos_sin_tc).
      if (a.con_movimientos_sin_tc) sinTc.push(nombre);
      filas.push({
        nombre,
        existencia: stats.stock,
        valor_costo_mxn: stats.valor_mxn,
        compradas_cant: a.compradas_cant,
        compradas_costo_mxn: a.compradas_costo_mxn,
        salidas_cant: a.salidas_cant,
        vendido_mxn: a.ventas_mxn,
        utilidad_mxn: a.utilidad_mxn,
        matriculas: a.matriculas.length > 0 ? a.matriculas.join(' + ') : null,
      });
    }
    filas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    if (sinTc.length > 0) {
      this.logger.warn(
        `Hoja inventario ${desde}..${hasta}: ${sinTc.length} ítem(s) con movimientos USD sin TC (montos en pesos omitidos): ${sinTc.join(' | ')}`,
      );
    }
    return {
      filas,
      total_piezas: round(filas.reduce((s, f) => s + (f.existencia ?? 0), 0)),
      total_valor_mxn: round(
        filas.reduce((s, f) => s + (f.valor_costo_mxn ?? 0), 0),
        2,
      ),
      total_compras_mxn: round(
        filas.reduce((s, f) => s + (f.compradas_costo_mxn ?? 0), 0),
        2,
      ),
      total_vendido_mxn: round(
        filas.reduce((s, f) => s + (f.vendido_mxn ?? 0), 0),
        2,
      ),
      total_utilidad_mxn: round(
        filas.reduce((s, f) => s + (f.utilidad_mxn ?? 0), 0),
        2,
      ),
    };
  }

  // ===== Cálculo FIFO =====
  // El FIFO vive en inventario-cardex.util.ts (fuente única, puro y con
  // spec); estos delegados conservan las firmas privadas que usa el resto
  // del servicio.

  /** Orden cronológico estable: fecha_movimiento y, a igualdad, created_at. */
  private sortChrono<T extends MovForFifo>(movs: T[]): T[] {
    return sortChrono(movs);
  }

  /** Capas FIFO restantes tras procesar los movimientos en orden. */
  private buildLayers(movs: MovForFifo[]): FifoLayer[] {
    return buildLayers(movs);
  }

  private statsFromLayers(layers: FifoLayer[]) {
    return statsFromLayers(layers);
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

  /** Stock corriente y costo FIFO MXN por movimiento (inventario-cardex.util). */
  private walkCardex(movs: MovForFifo[]) {
    return walkCardex(movs);
  }

  /**
   * Cardex mínimo del ítem para el FIFO de una SALIDA/corrección de costo.
   * Paginado hasta cubrir `count` (mismo anti-cap que movsCardexCompleto): con
   * el tope de 1000 filas de PostgREST una salida nueva consumiría capas de
   * un cardex incompleto y el costo al avión saldría falso en silencio.
   */
  private async movsForItem(itemId: string): Promise<MovForFifo[]> {
    return this.todasLasFilas<MovForFifo>((desde, hasta) =>
      this.supabase.service
        .from('inventario_movimiento')
        .select(
          'id, tipo, cantidad, costo_unitario_usd, moneda, costo_unitario_mxn, tc_usd_mxn, fecha_movimiento, created_at',
          { count: 'exact' },
        )
        .eq('item_id', itemId)
        .order('fecha_movimiento', { ascending: true })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(desde, hasta),
    );
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

    // Stock + valorizado + ganancia por ítem (un solo barrido del cardex de
    // los ítems listados). El FIFO corre SIEMPRE sobre todo el cardex;
    // desde/hasta solo acotan qué compras/ventas SUMAN (sin query =
    // acumulado histórico).
    const ids = rows.map((r) => (r as { id: string }).id);
    const [movsByItem, empaquesByItem] = await Promise.all([
      this.movsByItems(ids),
      this.empaquesByItems(ids),
    ]);
    const enPeriodo = filtroPeriodo(filters.desde, filters.hasta);
    let data = rows.map((r) => {
      const it = r as Record<string, unknown> & {
        id: string;
        stock_minimo: number | null;
      };
      const movs = movsByItem.get(it.id) ?? [];
      const stats = statsFromLayers(buildLayers(movs));
      // Ganancia / pérdida del producto: la MISMA agregación que la hoja
      // "inventario" del Balance general (agregadosDeItem) — ventas con
      // precio − costo FIFO de esas salidas; null = nunca vendió con precio.
      const a = agregadosDeItem(movs, enPeriodo);
      return {
        ...it,
        empaques: empaquesByItem.get(it.id) ?? [],
        ...stats,
        bajo_stock:
          it.stock_minimo != null && stats.stock < Number(it.stock_minimo),
        salidas_cant: a.salidas_cant,
        ventas_mxn: a.ventas_mxn,
        costo_ventas_mxn: a.costo_ventas_mxn,
        ganancia_mxn: a.utilidad_mxn,
        con_entradas_sin_costo: a.con_entradas_sin_costo,
        con_movimientos_sin_tc: a.con_movimientos_sin_tc,
      };
    });

    if (filters.bajo_stock === true) data = data.filter((d) => d.bajo_stock);

    return {
      data,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
      // Totales POR PÁGINA (el panel re-suma sobre todo lo leído).
      valor_total_usd: round(
        data.reduce((s, d) => s + d.valor_usd, 0),
        2,
      ),
      valor_total_mxn: round(
        data.reduce((s, d) => s + d.valor_mxn, 0),
        2,
      ),
      ventas_total_mxn: round(
        data.reduce((s, d) => s + (d.ventas_mxn ?? 0), 0),
        2,
      ),
      ganancia_total_mxn: round(
        data.reduce((s, d) => s + (d.ganancia_mxn ?? 0), 0),
        2,
      ),
    };
  }

  /**
   * Cardex de VARIOS ítems en una sola lectura (paginada hasta cubrir el
   * count: el FIFO necesita el historial completo). Trae venta y para_flota
   * para poder agregar ganancia por ítem (agregadosDeItem).
   */
  private async movsByItems(
    itemIds: string[],
  ): Promise<Map<string, MovCardex[]>> {
    const map = new Map<string, MovCardex[]>();
    if (itemIds.length === 0) return map;
    const data = await this.todasLasFilas<MovCardex & { item_id: string }>(
      (desde, hasta) =>
        this.supabase.service
          .from('inventario_movimiento')
          .select(
            'id, item_id, tipo, cantidad, costo_unitario_usd, moneda, costo_unitario_mxn, tc_usd_mxn, venta_unitaria, venta_moneda, para_flota, fecha_movimiento, created_at',
            { count: 'exact' },
          )
          .in('item_id', itemIds)
          .order('fecha_movimiento', { ascending: true })
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(desde, hasta),
    );
    for (const m of data) {
      const k = m.item_id;
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
    // para_flota NO está en MOV_COLS: explícito, o el cardex del detalle no
    // podría decir "FLOTA" en las salidas prorrateadas. Paginado hasta cubrir
    // el count (anti-cap): el stock del detalle debe ser el MISMO del listado.
    const movs = await this.todasLasFilas<
      Record<string, unknown> & MovCardex & { id: string; tipo: string }
    >((desde, hasta) =>
      this.supabase.service
        .from('inventario_movimiento')
        .select(`${MOV_COLS}, para_flota, ${MOV_JOINS}`, { count: 'exact' })
        .eq('item_id', id)
        .order('fecha_movimiento', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(desde, hasta),
    );

    const stats = statsFromLayers(buildLayers(movs));
    // Por movimiento, ADITIVO: `costo_unitario_mxn_efectivo` (costo unitario
    // en PESOS con el criterio único costoUnitarioMxnDe — el panel lo pinta
    // tal cual y ya no convierte monedas por su cuenta; null si la captura
    // fue USD sin TC: el panel entonces enseña el USD, jamás un "MXN" falso)
    // y, en las SALIDAs con venta, `ganancia_mxn` (venta total MXN − costo
    // FIFO MXN de las capas consumidas). El resto de la fila viaja intacto.
    const walk = walkCardex(movs);
    const salida = TipoMovimientoInventario.SALIDA as string;
    const movimientos = movs.map((x) => {
      const costo_unitario_mxn_efectivo =
        x.costo_unitario_usd != null && !costoSinTc(x)
          ? round(costoUnitarioMxnDe(x).mxn, 2)
          : null;
      if (x.tipo !== salida) return { ...x, costo_unitario_mxn_efectivo };
      const paso = walk.get(x.id);
      const { gananciaMxn } = ventaYGananciaDe(
        x,
        paso?.costoMxnFifo ?? null,
        paso?.sinTc === true,
      );
      return gananciaMxn != null
        ? { ...x, costo_unitario_mxn_efectivo, ganancia_mxn: gananciaMxn }
        : { ...x, costo_unitario_mxn_efectivo };
    });
    return { ...item, ...stats, movimientos };
  }

  /**
   * Resumen del PRODUCTO para el detalle del panel (pedido del cliente
   * 4-sep-2026, réplica de su Excel): bloques COMPRAS | VENTAS
   * (bloquesCardexDe — los MISMOS del cardex formato libro en Excel),
   * RESUMEN por día (resumenDiarioDe: existencia al cierre del día y
   * utilidad del día) y totales (agregadosDeItem — el mismo número que el
   * listado y que la hoja "inventario" del Balance general). Todo en PESOS.
   * `desde`/`hasta` (YYYY-MM-DD, día Cancún) acotan qué filas se listan y
   * qué suma; el FIFO corre SIEMPRE sobre todo el cardex. Ligas a la compra
   * (compra_linea) y al gasto del avión (gasto.inventario_movimiento_id;
   * null cuando la salida prorrateó a la flota y nacieron N gastos).
   */
  async resumenItem(
    itemId: string,
    q: { desde?: string; hasta?: string } = {},
  ) {
    const item = (await this.findItem(itemId)) as {
      id: string;
      nombre: string;
      numero_parte?: string | null;
      unidad?: string | null;
      categoria?: string | null;
      precio_venta?: number | string | null;
      precio_venta_moneda?: 'MXN' | 'USD' | null;
    };
    const movs = await this.movsCardexCompleto(itemId);
    const enPeriodo = filtroPeriodo(q.desde, q.hasta);
    const { compras, ventas, totales } = bloquesCardexDe(
      item.nombre,
      movs,
      enPeriodo,
    );
    const resumen_diario = resumenDiarioDe(movs, enPeriodo);
    const stats = statsFromLayers(buildLayers(movs));
    const idsDe = (rows: Array<{ movimiento_id: string | null }>) =>
      rows
        .map((r) => r.movimiento_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const [compraPorMov, gastoPorMov] = await Promise.all([
      this.compraIdPorMovimiento(idsDe(compras)),
      this.gastoIdPorMovimiento(idsDe(ventas)),
    ]);
    return {
      item: {
        id: item.id,
        nombre: item.nombre,
        numero_parte: item.numero_parte ?? null,
        unidad: item.unidad ?? null,
        categoria: item.categoria ?? null,
        precio_venta:
          item.precio_venta != null ? Number(item.precio_venta) : null,
        precio_venta_moneda: item.precio_venta_moneda ?? null,
      },
      moneda: 'MXN' as const,
      periodo:
        q.desde || q.hasta
          ? { desde: q.desde ?? null, hasta: q.hasta ?? null }
          : null,
      compras: compras.map((c) => ({
        ...c,
        compra_id: c.movimiento_id
          ? (compraPorMov.get(c.movimiento_id) ?? null)
          : null,
      })),
      ventas: ventas.map((v) => ({
        ...v,
        gasto_id: v.movimiento_id
          ? (gastoPorMov.get(v.movimiento_id) ?? null)
          : null,
      })),
      resumen_diario,
      totales: {
        ...totales,
        existencia_actual: stats.stock,
        valor_costo_mxn: stats.valor_mxn,
      },
    };
  }

  /** compra_id por movimiento (ENTRADAs que nacieron de una compra). */
  private async compraIdPorMovimiento(
    movIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (movIds.length === 0) return map;
    const { data, error } = await this.supabase.service
      .from('compra_linea')
      .select('compra_id, inventario_movimiento_id')
      .in('inventario_movimiento_id', movIds);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{
      compra_id: string | null;
      inventario_movimiento_id: string | null;
    }>) {
      if (r.compra_id && r.inventario_movimiento_id) {
        map.set(r.inventario_movimiento_id, r.compra_id);
      }
    }
    return map;
  }

  /**
   * gasto_id por movimiento (SALIDAs cargadas a un avión). Una salida a la
   * FLOTA genera N gastos: ahí no hay UN gasto que abrir (queda fuera).
   */
  private async gastoIdPorMovimiento(
    movIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (movIds.length === 0) return map;
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('id, inventario_movimiento_id')
      .in('inventario_movimiento_id', movIds);
    if (error) throw new Error(error.message);
    const repetidos = new Set<string>();
    for (const r of (data ?? []) as Array<{
      id: string;
      inventario_movimiento_id: string | null;
    }>) {
      const k = r.inventario_movimiento_id;
      if (!k) continue;
      if (map.has(k)) {
        repetidos.add(k);
        continue;
      }
      map.set(k, r.id);
    }
    for (const k of repetidos) map.delete(k);
    return map;
  }

  /**
   * Cardex COMPLETO de un ítem con joins y `para_flota` (lo que necesitan
   * los bloques y el Excel formato libro). Pagina hasta cubrir `count`: el
   * FIFO necesita TODO el historial y una respuesta cortada por el tope de
   * PostgREST daría stock y costos falsos en silencio.
   */
  private async movsCardexCompleto(itemId: string): Promise<MovCardex[]> {
    return this.todasLasFilas<MovCardex>((desde, hasta) =>
      this.supabase.service
        .from('inventario_movimiento')
        .select(`${MOV_COLS}, para_flota, ${MOV_JOINS}`, { count: 'exact' })
        .eq('item_id', itemId)
        .order('fecha_movimiento', { ascending: true })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(desde, hasta),
    );
  }

  /**
   * Lee TODAS las filas de una consulta paginando de 1000 en 1000 (tope por
   * respuesta de PostgREST) hasta cubrir el `count` exacto — mismo patrón
   * anti-cap del panel. La consulta debe traer un ORDER estable.
   */
  private async todasLasFilas<T>(
    consulta: (
      desde: number,
      hasta: number,
    ) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
      count: number | null;
    }>,
  ): Promise<T[]> {
    const PAGINA = 1000;
    const out: unknown[] = [];
    let total = Number.POSITIVE_INFINITY;
    while (out.length < total) {
      const { data, error, count } = await consulta(
        out.length,
        out.length + PAGINA - 1,
      );
      if (error) throw new Error(error.message);
      const filas = data ?? [];
      if (filas.length === 0) break;
      out.push(...filas);
      total = count ?? out.length;
    }
    return out as T[];
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
