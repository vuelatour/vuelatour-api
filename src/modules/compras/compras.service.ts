import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { InventoryService } from '../inventory/inventory.service';
import { findOrCreateItem } from '../inventory/compras.service';
import { TipoMovimientoInventario } from '../inventory/dto/inventory.dto';
import {
  calcularCompra,
  parsearCantidadConcepto,
  RE_CONCEPTO_CARGO,
  rolPorTexto,
  round,
  type CargoFactura,
  type EstadoCompra,
  type MonedaCompra,
  type RolPagoCompra,
} from './compras.calculo';
import {
  RolPagoCompra as RolPagoDto,
  type AddPagoCompraDto,
  type CompraLineaDto,
  type CreateCompraDto,
  type ListComprasQuery,
  type UnirComprasDto,
  type UpdateCompraDto,
  type UpdatePagoCompraDto,
} from './dto/compras.dto';

const COMPRA_COLS =
  'id, folio, proveedor_id, fecha, referencia, moneda, tc_usd_mxn, estado, cargos_factura, recibida_at, notas, created_at, updated_at, created_by, updated_by';
const COMPRA_SEL = `${COMPRA_COLS}, proveedor:proveedor!proveedor_id(id, nombre)`;

const LINEA_COLS =
  'id, compra_id, orden, item_id, nombre, numero_parte, categoria, cantidad, costo_unitario, inventario_movimiento_id, created_at, updated_at';
// El movimiento se lee para saber con qué costo entró (aviso "recalcular").
const LINEA_SEL = `${LINEA_COLS}, item:inventario_item!item_id(id, nombre, numero_parte), movimiento:inventario_movimiento!inventario_movimiento_id(id, tipo, moneda, costo_unitario_usd, costo_unitario_mxn, tc_usd_mxn)`;

// Lo que el panel/app muestran de cada PAGO (el gasto sigue siendo dueño de
// su factura y su conciliación; aquí solo se resume).
const PAGO_SEL =
  'id, fecha_gasto, categoria, monto, moneda, tc_gasto, medio_pago, foto_url, notas, compra_rol, conciliado, compra_id, proveedor:proveedor!proveedor_id(id, nombre)';

// Lo que hace falta de un gasto para decidir si puede ser pago de una compra
// y para derivar la compra desde él.
const GASTO_FUENTE_SEL =
  'id, categoria, monto, moneda, tc_gasto, fecha_gasto, proveedor_id, notas, compra_id, valor_ia_extraido, aeronave_id, vuelo_id, escala_id, medio_pago, inventario_movimiento_id, proveedor:proveedor!proveedor_id(nombre)';

/** Categorías de gasto que pueden ser la factura de MERCANCÍA. */
const CATEGORIAS_MERCANCIA = ['REFACCION', 'OTRO', 'OPERACIONES'];
/**
 * Categorías que JAMÁS son pago de una compra de refacciones: dinero
 * personal del dueño, gastos de visita, gasolina de coches, combustible de
 * aviación, TUAS, permisos de pista y gastos fijos. Ligarlos metería al
 * costo de bodega dinero que no tiene nada que ver con la refacción.
 */
const CATEGORIAS_NO_LIGABLES = [
  'PERSONAL_DUENO',
  'VISITA',
  'GASOLINA',
  'GAS',
  'TUAS',
  'PERMISO',
  'FIJO',
];
const CATEGORIA_ITEM_DEFAULT = 'Refacción';

type CompraRow = {
  id: string;
  folio: number;
  proveedor_id: string | null;
  fecha: string;
  referencia: string | null;
  moneda: MonedaCompra;
  tc_usd_mxn: number | string | null;
  estado: EstadoCompra;
  cargos_factura: CargoFactura[] | null;
  recibida_at: string | null;
  notas: string | null;
  proveedor?: { id: string; nombre: string } | null;
  [k: string]: unknown;
};

type LineaRow = {
  id: string;
  compra_id: string;
  orden: number;
  item_id: string | null;
  nombre: string;
  numero_parte: string | null;
  categoria: string | null;
  cantidad: number | string;
  costo_unitario: number | string;
  inventario_movimiento_id: string | null;
  item?: { id: string; nombre: string; numero_parte: string | null } | null;
  movimiento?: {
    id: string;
    tipo: string;
    moneda: string | null;
    costo_unitario_usd: number | string;
    costo_unitario_mxn: number | string | null;
    tc_usd_mxn: number | string | null;
  } | null;
};

type PagoRow = {
  id: string;
  fecha_gasto: string;
  categoria: string;
  monto: number | string;
  moneda: string;
  tc_gasto: number | string | null;
  medio_pago: string | null;
  foto_url: string | null;
  notas: string | null;
  compra_rol: RolPagoCompra;
  conciliado: boolean | null;
  compra_id: string | null;
  proveedor?: { id: string; nombre: string } | null;
};

type GastoFuente = {
  id: string;
  categoria: string;
  monto: number | string;
  moneda: string;
  tc_gasto: number | string | null;
  fecha_gasto: string;
  proveedor_id: string | null;
  notas: string | null;
  compra_id: string | null;
  valor_ia_extraido: unknown;
  aeronave_id: string | null;
  vuelo_id: string | null;
  escala_id: string | null;
  medio_pago: string | null;
  /** Gasto generado por una SALIDA de cardex (cargo contable, no un pago). */
  inventario_movimiento_id: string | null;
  proveedor?: { nombre: string } | null;
};

type DbError = { code?: string; message: string };

/** Día Cancún (UTC−5) de un timestamptz. */
function diaCancun(iso: string): string {
  return new Date(new Date(iso).getTime() - 5 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

function primeraLinea(texto: string | null | undefined): string {
  return (texto ?? '').split('\n')[0].trim();
}

/** Valor del JSON de la IA como texto (solo string/number; lo demás = ''). */
function texto(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function tcDe(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

@Injectable()
export class ComprasService {
  private readonly logger = new Logger(ComprasService.name);

  /**
   * Candado en memoria POR COMPRA: recibir/recostear/editar/borrar la misma
   * compra se serializan (doble clic, dos pestañas). No sustituye al reclamo
   * atómico por línea (`recibirInterno`), que cubre el caso de dos procesos.
   */
  private readonly candados = new Map<string, Promise<unknown>>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly inventory: InventoryService,
  ) {}

  private async conCandado<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previo = this.candados.get(id) ?? Promise.resolve();
    // Se encadena tras el anterior aunque ese haya fallado; al terminar se
    // limpia solo si sigue siendo el último de la cola.
    const actual = previo.catch(() => undefined).then(fn);
    this.candados.set(id, actual);
    try {
      return await actual;
    } finally {
      if (this.candados.get(id) === actual) this.candados.delete(id);
    }
  }

  // ===== Lectura =====

  async list(q: ListComprasQuery) {
    let query = this.supabase.service
      .from('compra')
      .select(COMPRA_SEL, { count: 'exact' })
      .order('fecha', { ascending: false })
      .order('folio', { ascending: false })
      .range(q.offset, q.offset + q.limit - 1);
    if (q.estado) query = query.eq('estado', q.estado);
    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    const compras = (data ?? []) as unknown as CompraRow[];
    if (compras.length === 0) return { data: [], count: count ?? 0 };

    const ids = compras.map((c) => c.id);
    const [lineasPorCompra, pagosPorCompra] = await Promise.all([
      this.lineasDe(ids),
      this.pagosDe(ids),
    ]);

    const rows = compras.map((c) => {
      const lineas = lineasPorCompra.get(c.id) ?? [];
      const pagos = pagosPorCompra.get(c.id) ?? [];
      const { resumen } = calcularCompra(c, lineas, pagos);
      return {
        id: c.id,
        folio: c.folio,
        proveedor: c.proveedor ?? null,
        fecha: c.fecha,
        referencia: c.referencia,
        moneda: c.moneda,
        estado: c.estado,
        n_lineas: lineas.length,
        n_pagos: pagos.length,
        total_mercancia: resumen.total_mercancia,
        total: resumen.total,
        total_mxn: resumen.total_mxn,
        total_usd: resumen.total_usd,
      };
    });
    return { data: rows, count: count ?? 0 };
  }

  async getDetail(id: string) {
    const compra = await this.findCompra(id);
    const [lineasMap, pagosMap] = await Promise.all([
      this.lineasDe([id]),
      this.pagosDe([id]),
    ]);
    return this.armarDetalle(
      compra,
      lineasMap.get(id) ?? [],
      pagosMap.get(id) ?? [],
    );
  }

  private armarDetalle(
    compra: CompraRow,
    lineas: LineaRow[],
    pagos: PagoRow[],
  ) {
    const entrada = lineas.map((l) => ({
      ...l,
      costo_unitario_recibido: this.costoRecibido(l, compra.moneda),
    }));
    const calc = calcularCompra(compra, entrada, pagos);
    return {
      ...compra,
      proveedor: compra.proveedor ?? null,
      lineas: calc.lineas.map((l) => {
        // El movimiento crudo no sale al cliente (solo sirvió para el aviso).
        const { movimiento: _m, ...rest } = l;
        void _m;
        return {
          ...rest,
          cantidad: Number(l.cantidad),
          costo_unitario: Number(l.costo_unitario),
          item: l.item ?? null,
        };
      }),
      pagos: pagos.map((p) => ({
        id: p.id,
        fecha_gasto: p.fecha_gasto,
        categoria: p.categoria,
        monto: Number(p.monto),
        moneda: p.moneda,
        tc_gasto: p.tc_gasto == null ? null : Number(p.tc_gasto),
        medio_pago: p.medio_pago,
        proveedor: p.proveedor ?? null,
        foto_url: p.foto_url,
        notas: primeraLinea(p.notas) || null,
        compra_rol: p.compra_rol,
        conciliado: p.conciliado === true,
      })),
      resumen: calc.resumen,
    };
  }

  /**
   * Costo unitario con el que ENTRÓ la línea al cardex, en la moneda de la
   * compra (la columna guarda 4 decimales; se compara con `TOL_RECIBIDO`).
   */
  private costoRecibido(l: LineaRow, moneda: MonedaCompra): number | null {
    const m = l.movimiento;
    if (!m) return null;
    if (moneda === 'MXN') {
      return m.costo_unitario_mxn == null ? null : Number(m.costo_unitario_mxn);
    }
    return Number(m.costo_unitario_usd);
  }

  private async findCompra(id: string): Promise<CompraRow> {
    const { data, error } = await this.supabase.service
      .from('compra')
      .select(COMPRA_SEL)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException('La compra no existe.');
    return data as unknown as CompraRow;
  }

  /**
   * Trae TODAS las filas paginando en bloques de 1000: PostgREST trunca a
   * 1000 por default y el excedente se perdía EN SILENCIO (una compra sin
   * sus líneas o sin sus pagos = costo mal prorrateado). El builder debe
   * traer un ORDEN TOTAL (…, id) para que las páginas no se traslapen. El
   * error nunca se degrada a [].
   */
  private async fetchTodas<T>(
    builder: (
      from: number,
      to: number,
    ) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>,
  ): Promise<T[]> {
    const PAGE = 1000;
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await builder(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const chunk = (data ?? []) as T[];
      out.push(...chunk);
      if (chunk.length < PAGE) break;
    }
    return out;
  }

  private async lineasDe(
    compraIds: string[],
  ): Promise<Map<string, LineaRow[]>> {
    const filas = await this.fetchTodas<LineaRow>((from, to) =>
      this.supabase.service
        .from('compra_linea')
        .select(LINEA_SEL)
        .in('compra_id', compraIds)
        .order('compra_id', { ascending: true })
        .order('orden', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );
    const map = new Map<string, LineaRow[]>();
    for (const row of filas) {
      const arr = map.get(row.compra_id) ?? [];
      arr.push(row);
      map.set(row.compra_id, arr);
    }
    return map;
  }

  private async pagosDe(compraIds: string[]): Promise<Map<string, PagoRow[]>> {
    const filas = await this.fetchTodas<PagoRow>((from, to) =>
      this.supabase.service
        .from('gasto')
        .select(PAGO_SEL)
        .in('compra_id', compraIds)
        .order('compra_id', { ascending: true })
        .order('fecha_gasto', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );
    const map = new Map<string, PagoRow[]>();
    for (const row of filas) {
      const key = row.compra_id as string;
      const arr = map.get(key) ?? [];
      arr.push(row);
      map.set(key, arr);
    }
    return map;
  }

  /** Líneas de la compra que YA tienen su ENTRADA en el cardex. */
  private async lineasRecibidas(compraId: string): Promise<number> {
    const { count, error } = await this.supabase.service
      .from('compra_linea')
      .select('id', { count: 'exact', head: true })
      .eq('compra_id', compraId)
      .not('inventario_movimiento_id', 'is', null);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  private async findGasto(id: string): Promise<GastoFuente> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(GASTO_FUENTE_SEL)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`El gasto ${id} no existe.`);
    return data as unknown as GastoFuente;
  }

  private async findGastos(ids: string[]): Promise<GastoFuente[]> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(GASTO_FUENTE_SEL)
      .in('id', ids);
    if (error) throw new Error(error.message);
    const gastos = (data ?? []) as unknown as GastoFuente[];
    const faltan = ids.filter((id) => !gastos.some((g) => g.id === id));
    if (faltan.length > 0) {
      throw new NotFoundException(`No existe el gasto ${faltan[0]}.`);
    }
    return gastos;
  }

  /** Errores de BD al escribir la compra → 400 legibles (no 500). */
  private lanzarErrorCompra(error: DbError): never {
    if (error.code === '23503')
      throw new BadRequestException('Proveedor no encontrado.');
    if (error.code === '22007' || error.code === '22008')
      throw new BadRequestException('fecha inválida (YYYY-MM-DD)');
    throw new Error(error.message);
  }

  private msgCargosSinTc(n: number): string {
    return `${n} cargo(s) sin tipo de cambio: captura el TC de la compra o del gasto (o recibe forzando).`;
  }

  // ===== Alta =====

  async create(dto: CreateCompraDto, userId: string) {
    let gasto: GastoFuente | null = null;
    let derivado: ReturnType<typeof this.derivarDesdeGasto> | null = null;
    if (dto.gasto_mercancia_id) {
      gasto = await this.findGasto(dto.gasto_mercancia_id);
      this.assertGastoLigable(gasto, 'MERCANCIA');
      derivado = this.derivarDesdeGasto(gasto);
    }

    const moneda: MonedaCompra = dto.moneda ?? derivado?.moneda ?? 'USD';
    const tc = dto.tc_usd_mxn ?? derivado?.tc_usd_mxn ?? null;
    const lineas: CompraLineaDto[] =
      dto.lineas && dto.lineas.length > 0
        ? dto.lineas
        : (derivado?.lineas ?? []);

    const { data, error } = await this.supabase.service
      .from('compra')
      .insert({
        proveedor_id: dto.proveedor_id ?? derivado?.proveedor_id ?? null,
        fecha: dto.fecha ?? derivado?.fecha ?? undefined,
        referencia: dto.referencia ?? derivado?.referencia ?? null,
        moneda,
        tc_usd_mxn: tc,
        estado: 'ABIERTA',
        cargos_factura: derivado?.cargos_factura ?? [],
        notas: dto.notas ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select('id')
      .maybeSingle();
    if (error) this.lanzarErrorCompra(error);
    const compraId = (data as { id: string }).id;

    // Si las líneas o la liga fallan, la compra recién creada se va con
    // ellas: jamás una compra huérfana a medio armar.
    try {
      if (lineas.length > 0) await this.insertarLineas(compraId, lineas, 1);
      if (gasto) {
        await this.ligarGasto(gasto.id, compraId, 'MERCANCIA', userId);
      }
    } catch (err) {
      await this.deshacerCompra(compraId, userId, 'create');
      throw err;
    }

    return this.getDetail(compraId);
  }

  /**
   * Une N gastos sueltos en una compra: el de mercancía da las líneas; los
   * demás se ligan como cargo con el rol que sugieren sus notas/conceptos/
   * proveedor (IMPUESTOS > ENVIO > OTRO). TODOS se validan ANTES de crear la
   * compra: si uno no es ligable, no nace nada.
   */
  async unir(dto: UnirComprasDto, userId: string) {
    const ids = Array.from(new Set([...dto.gasto_ids, dto.mercancia_gasto_id]));
    const gastos = await this.findGastos(ids);
    const mercancia = gastos.find((g) => g.id === dto.mercancia_gasto_id)!;
    const roles = new Map<string, RolPagoCompra>();
    for (const g of gastos) {
      const rol: RolPagoCompra =
        g.id === mercancia.id ? 'MERCANCIA' : rolPorTexto(this.textoDe(g));
      this.assertGastoLigable(g, rol);
      roles.set(g.id, rol);
    }

    const detalle = await this.create(
      { gasto_mercancia_id: mercancia.id },
      userId,
    );
    try {
      for (const g of gastos) {
        if (g.id === mercancia.id) continue;
        await this.ligarGasto(g.id, detalle.id, roles.get(g.id)!, userId);
      }
    } catch (err) {
      await this.deshacerCompra(detalle.id, userId, 'unir');
      throw err;
    }
    return this.getDetail(detalle.id);
  }

  /**
   * Un gasto puede ser PAGO de una compra si: no pertenece ya a una (409),
   * no es el cargo contable de una SALIDA de cardex — medio BODEGA o ligado
   * a un movimiento (409): ese "gasto" es la pieza saliendo de bodega, no
   * dinero pagado —, su categoría es de refacciones/servicios (400 para las
   * de `CATEGORIAS_NO_LIGABLES`) y, si va como MERCANCIA, es REFACCION/OTRO/
   * OPERACIONES (400).
   */
  private assertGastoLigable(
    g: GastoFuente,
    rol: RolPagoCompra,
    compraId?: string,
  ): void {
    if (g.compra_id) {
      throw new ConflictException(
        compraId && g.compra_id === compraId
          ? 'Ese gasto ya está ligado a esta compra.'
          : 'Ese gasto ya pertenece a otra compra; quítalo de ahí primero.',
      );
    }
    if (g.medio_pago === 'BODEGA' || g.inventario_movimiento_id) {
      throw new ConflictException(
        'Ese gasto es un cargo contable del cardex (salida de bodega), no un pago: no se liga a una compra.',
      );
    }
    if (CATEGORIAS_NO_LIGABLES.includes(g.categoria)) {
      throw new BadRequestException(
        `Un gasto ${g.categoria} no puede ser pago de una compra de refacciones.`,
      );
    }
    if (rol === 'MERCANCIA' && !CATEGORIAS_MERCANCIA.includes(g.categoria)) {
      throw new BadRequestException(
        `La factura de mercancía debe ser un gasto REFACCION, OTRO u OPERACIONES (este es ${g.categoria}).`,
      );
    }
  }

  /** Texto para la heurística de rol: notas + conceptos IA + proveedor. */
  private textoDe(g: GastoFuente): string {
    const ia = g.valor_ia_extraido as
      | {
          conceptos?: Array<{ concepto?: unknown }>;
          concepto?: unknown;
          proveedor?: unknown;
        }
      | null
      | undefined;
    const conceptos = (ia?.conceptos ?? []).map((c) => texto(c?.concepto));
    return [
      g.notas ?? '',
      texto(ia?.concepto),
      texto(ia?.proveedor),
      g.proveedor?.nombre ?? '',
      ...conceptos,
    ].join('\n');
  }

  /**
   * Del gasto de mercancía: proveedor/fecha/moneda/TC + líneas desde los
   * conceptos que leyó la IA. "(xN)" → cantidad N y costo = monto/N; los
   * conceptos que son cargos (Shipping, Tax…) van a cargos_factura; sin
   * conceptos → una sola línea por el monto completo.
   */
  private derivarDesdeGasto(g: GastoFuente): {
    proveedor_id: string | null;
    fecha: string;
    referencia: string | null;
    moneda: MonedaCompra;
    tc_usd_mxn: number | null;
    lineas: CompraLineaDto[];
    cargos_factura: CargoFactura[];
  } {
    const ia = g.valor_ia_extraido as
      | {
          conceptos?: Array<{ concepto?: unknown; monto?: unknown }>;
          concepto?: unknown;
          folio?: unknown;
        }
      | null
      | undefined;
    const conceptos = (ia?.conceptos ?? [])
      .map((c) => ({
        concepto: texto(c?.concepto).trim(),
        monto: Number(c?.monto),
      }))
      .filter((c) => c.concepto && Number.isFinite(c.monto) && c.monto !== 0);

    const lineas: CompraLineaDto[] = [];
    const cargos: CargoFactura[] = [];
    for (const c of conceptos) {
      // Negativo = descuento: no es una refacción, resta como cargo.
      if (c.monto < 0 || RE_CONCEPTO_CARGO.test(c.concepto)) {
        cargos.push({ concepto: c.concepto, monto: round(c.monto, 2) });
        continue;
      }
      const { nombre, cantidad } = parsearCantidadConcepto(c.concepto);
      lineas.push({
        nombre: nombre.slice(0, 200),
        cantidad,
        costo_unitario: round(c.monto / cantidad, 4),
      });
    }
    if (lineas.length === 0 && Number(g.monto) > 0) {
      // Sin desglose: toda la factura es una línea (los cargos detectados se
      // descuentan para no contar el envío dos veces).
      const cargosTotal = cargos.reduce((s, c) => s + c.monto, 0);
      const nombre =
        primeraLinea(g.notas) ||
        texto(ia?.concepto).trim() ||
        (g.proveedor?.nombre
          ? `Compra ${g.proveedor.nombre}`
          : CATEGORIA_ITEM_DEFAULT);
      lineas.push({
        nombre: nombre.slice(0, 200),
        cantidad: 1,
        costo_unitario: round(Math.max(0, Number(g.monto) - cargosTotal), 4),
      });
    }
    const moneda: MonedaCompra = g.moneda === 'MXN' ? 'MXN' : 'USD';
    return {
      proveedor_id: g.proveedor_id,
      fecha: diaCancun(g.fecha_gasto),
      referencia: texto(ia?.folio).trim().slice(0, 120) || null,
      moneda,
      tc_usd_mxn: tcDe(g.tc_gasto),
      lineas,
      cargos_factura: cargos,
    };
  }

  private async insertarLineas(
    compraId: string,
    lineas: CompraLineaDto[],
    ordenInicial: number,
  ): Promise<void> {
    if (lineas.length === 0) return;
    const { error } = await this.supabase.service.from('compra_linea').insert(
      lineas.map((l, i) => ({
        compra_id: compraId,
        orden: ordenInicial + i,
        item_id: l.item_id ?? null,
        nombre: l.nombre,
        numero_parte: l.numero_parte || null,
        categoria: l.categoria || null,
        cantidad: l.cantidad,
        costo_unitario: l.costo_unitario,
      })),
    );
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(`Ítem no encontrado: ${error.message}`);
      throw new Error(error.message);
    }
  }

  // ===== Edición =====

  /**
   * Bajo el candado de la compra: cambiar el TC de una compra RECIBIDA
   * recostea sus ENTRADAS (misma rutina que recibir) y no debe cruzarse con
   * una recepción en curso.
   */
  async update(id: string, dto: UpdateCompraDto, userId: string) {
    return this.conCandado(id, () => this.updateInterno(id, dto, userId));
  }

  private async updateInterno(
    id: string,
    dto: UpdateCompraDto,
    userId: string,
  ) {
    const compra = await this.findCompra(id);
    const recibida = compra.estado === 'RECIBIDA';
    const nRecibidas = await this.lineasRecibidas(id);
    // "En cardex" = recibida O con líneas que ya entraron (recepción a
    // medias): en ambos casos las líneas/moneda/cargos ya pesan en bodega.
    const enCardex = recibida || nRecibidas > 0;
    if (
      enCardex &&
      (dto.lineas !== undefined ||
        dto.moneda !== undefined ||
        dto.cargos_factura !== undefined)
    ) {
      throw new ConflictException(
        recibida
          ? 'La compra ya fue recibida: sus líneas, moneda y cargos de factura ya no se editan (liga pagos o recalcula).'
          : `La compra ya tiene ${nRecibidas} línea(s) en el cardex (recepción a medias): sus líneas, moneda y cargos de factura ya no se editan; termina de recibirla.`,
      );
    }

    const tcActual = tcDe(compra.tc_usd_mxn);
    const tcNuevo =
      dto.tc_usd_mxn === undefined ? undefined : tcDe(dto.tc_usd_mxn);
    const cambiaTc = tcNuevo !== undefined && tcNuevo !== tcActual;
    if (cambiaTc && enCardex && compra.moneda === 'MXN' && tcNuevo == null) {
      throw new ConflictException(
        'La compra en pesos ya tiene ENTRADAS en el cardex: el tipo de cambio no se quita (cámbialo por otro para recostearlas).',
      );
    }
    if (cambiaTc && recibida) {
      // Con el TC nuevo ningún cargo puede quedarse fuera del prorrateo: se
      // verifica ANTES de guardar para no dejar el TC cambiado y las
      // ENTRADAS sin recostear.
      const [lineasMap, pagosMap] = await Promise.all([
        this.lineasDe([id]),
        this.pagosDe([id]),
      ]);
      const calc = calcularCompra(
        { ...compra, tc_usd_mxn: tcNuevo },
        lineasMap.get(id) ?? [],
        pagosMap.get(id) ?? [],
      );
      const n = calc.resumen.cargos_sin_tc.length;
      if (n > 0) {
        throw new BadRequestException(
          `${this.msgCargosSinTc(n)} Con ese TC las ENTRADAS quedarían incompletas.`,
        );
      }
    }

    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.proveedor_id !== undefined) patch.proveedor_id = dto.proveedor_id;
    if (dto.fecha !== undefined) patch.fecha = dto.fecha;
    if (dto.referencia !== undefined) patch.referencia = dto.referencia;
    if (dto.moneda !== undefined) patch.moneda = dto.moneda;
    if (tcNuevo !== undefined) patch.tc_usd_mxn = tcNuevo;
    if (dto.notas !== undefined) patch.notas = dto.notas;
    if (dto.cargos_factura !== undefined) {
      patch.cargos_factura = dto.cargos_factura.map((c) => ({
        concepto: c.concepto.trim(),
        monto: round(c.monto, 2),
      }));
    }

    const { error } = await this.supabase.service
      .from('compra')
      .update(patch)
      .eq('id', id);
    if (error) this.lanzarErrorCompra(error);

    if (dto.lineas !== undefined) await this.reemplazarLineas(id, dto.lineas);

    if (cambiaTc && recibida) {
      // Recosteo de las ENTRADAS con el TC nuevo (fuente única: la misma
      // rutina de recibir; ya estamos bajo el candado).
      this.logger.log(
        `compra #${compra.folio}: TC ${tcActual ?? '—'} → ${tcNuevo ?? '—'}, recosteando ENTRADAS`,
      );
      return this.recibirInterno(id, userId, false);
    }
    return this.getDetail(id);
  }

  /** Reemplazo completo: con id → update; sin id → insert; ausentes → delete. */
  private async reemplazarLineas(
    compraId: string,
    lineas: CompraLineaDto[],
  ): Promise<void> {
    const svc = this.supabase.service;
    const { data: actuales, error } = await svc
      .from('compra_linea')
      .select('id')
      .eq('compra_id', compraId);
    if (error) throw new Error(error.message);
    const existentes = new Set(
      ((actuales ?? []) as { id: string }[]).map((r) => r.id),
    );
    const conservar = new Set<string>();

    let orden = 1;
    const nuevas: CompraLineaDto[] = [];
    for (const l of lineas) {
      if (l.id && existentes.has(l.id)) {
        conservar.add(l.id);
        const { error: e } = await svc
          .from('compra_linea')
          .update({
            orden,
            item_id: l.item_id ?? null,
            nombre: l.nombre,
            numero_parte: l.numero_parte || null,
            categoria: l.categoria || null,
            cantidad: l.cantidad,
            costo_unitario: l.costo_unitario,
          })
          .eq('id', l.id);
        if (e) throw new Error(e.message);
      } else {
        nuevas.push({ ...l, id: undefined });
        // El orden de las nuevas se asigna al insertar (continúa la cuenta).
      }
      orden += 1;
    }
    const borrar = [...existentes].filter((x) => !conservar.has(x));
    if (borrar.length > 0) {
      const { error: e } = await svc
        .from('compra_linea')
        .delete()
        .in('id', borrar);
      if (e) throw new Error(e.message);
    }
    // Insertar nuevas conservando la posición relativa que traían en el body.
    if (nuevas.length > 0) {
      let pos = 0;
      const conOrden = lineas
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => !(l.id && existentes.has(l.id)))
        .map(({ i }) => i + 1);
      const { error: e } = await svc.from('compra_linea').insert(
        nuevas.map((l) => ({
          compra_id: compraId,
          orden: conOrden[pos++] ?? orden,
          item_id: l.item_id ?? null,
          nombre: l.nombre,
          numero_parte: l.numero_parte || null,
          categoria: l.categoria || null,
          cantidad: l.cantidad,
          costo_unitario: l.costo_unitario,
        })),
      );
      if (e) {
        if (e.code === '23503')
          throw new BadRequestException(`Ítem no encontrado: ${e.message}`);
        throw new Error(e.message);
      }
    }
  }

  // ===== Pagos (gastos ligados) =====

  async addPago(id: string, dto: AddPagoCompraDto, userId: string) {
    await this.findCompra(id);
    const gasto = await this.findGasto(dto.gasto_id);
    this.assertGastoLigable(gasto, dto.rol, id);
    await this.ligarGasto(gasto.id, id, dto.rol, userId);
    return this.getDetail(id);
  }

  /**
   * Cambia el rol de un pago YA ligado. Un solo UPDATE condicionado a
   * `compra_id = id` (atómico: si alguien lo desligó entre tanto, 404 y no
   * se toca nada). Pasarlo a MERCANCIA exige categoría de mercancía.
   */
  async updatePago(
    id: string,
    gastoId: string,
    dto: UpdatePagoCompraDto,
    userId: string,
  ) {
    await this.findCompra(id);
    if (dto.rol === RolPagoDto.MERCANCIA) {
      const gasto = await this.findGasto(gastoId);
      if (!CATEGORIAS_MERCANCIA.includes(gasto.categoria)) {
        throw new BadRequestException(
          `La factura de mercancía debe ser un gasto REFACCION, OTRO u OPERACIONES (este es ${gasto.categoria}).`,
        );
      }
    }
    const { data, error } = await this.supabase.service
      .from('gasto')
      .update({ compra_rol: dto.rol, updated_by: userId })
      .eq('id', gastoId)
      .eq('compra_id', id)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new NotFoundException('Ese gasto no está ligado a esta compra.');
    }
    return this.getDetail(id);
  }

  async removePago(id: string, gastoId: string, userId: string) {
    await this.findCompra(id);
    const { data, error } = await this.supabase.service
      .from('gasto')
      .update({ compra_id: null, compra_rol: null, updated_by: userId })
      .eq('id', gastoId)
      .eq('compra_id', id)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new NotFoundException('Ese gasto no está ligado a esta compra.');
    }
    return this.getDetail(id);
  }

  private async ligarGasto(
    gastoId: string,
    compraId: string,
    rol: RolPagoCompra,
    userId: string,
  ): Promise<void> {
    const { error } = await this.supabase.service
      .from('gasto')
      .update({ compra_id: compraId, compra_rol: rol, updated_by: userId })
      .eq('id', gastoId);
    if (error) throw new Error(error.message);
  }

  // ===== Recepción → ENTRADAS del cardex =====

  /**
   * Recibir = una ENTRADA por línea con el costo FINAL (factura + cargos).
   * Si ya estaba recibida (llegó un cargo después), re-costea las ENTRADAS
   * existentes; las SALIDAS ya registradas conservan su costo (aviso).
   * Con cargos sin TC responde 400 salvo `forzar` (el costo entraría
   * incompleto a bodega y nadie se enteraría).
   */
  async recibir(id: string, userId: string, forzar = false) {
    return this.conCandado(id, () => this.recibirInterno(id, userId, forzar));
  }

  private async recibirInterno(id: string, userId: string, forzar: boolean) {
    const compra = await this.findCompra(id);
    const [lineasMap, pagosMap] = await Promise.all([
      this.lineasDe([id]),
      this.pagosDe([id]),
    ]);
    const lineas = lineasMap.get(id) ?? [];
    const pagos = pagosMap.get(id) ?? [];
    if (lineas.length === 0) {
      throw new BadRequestException('La compra no tiene líneas que recibir.');
    }
    const tc = tcDe(compra.tc_usd_mxn);
    if (compra.moneda === 'MXN' && tc == null) {
      throw new BadRequestException(
        'Compra en pesos: captura el tipo de cambio (tc_usd_mxn) antes de recibir.',
      );
    }

    const calc = calcularCompra(
      compra,
      lineas.map((l) => ({
        ...l,
        costo_unitario_recibido: this.costoRecibido(l, compra.moneda),
      })),
      pagos,
    );
    const sinTc = calc.resumen.cargos_sin_tc.length;
    if (sinTc > 0 && !forzar) {
      throw new BadRequestException(this.msgCargosSinTc(sinTc));
    }
    const yaRecibida = compra.estado === 'RECIBIDA';
    const avisos = calc.resumen.avisos.filter(
      (a) => !a.startsWith('recalcular:'),
    );
    const svc = this.supabase.service;
    const fecha = compra.fecha;
    const referencia =
      `Compra #${compra.folio}${compra.referencia ? ` · ${compra.referencia}` : ''}`.slice(
        0,
        100,
      );
    const itemIds: string[] = [];
    // ENTRADAS creadas en ESTA llamada: si algo falla a medias se deshacen
    // (la FK de la línea es `set null`, así que la línea vuelve a "no
    // recibida" sola) y la compra no queda con cardex a medias.
    const creadas: string[] = [];

    try {
      for (const l of calc.lineas) {
        const final = l.costo_unitario_final;
        if (l.inventario_movimiento_id && l.movimiento) {
          // Recosteo de la ENTRADA existente (update directo: no hay
          // "editar movimiento" en InventoryService).
          const patch =
            compra.moneda === 'MXN'
              ? {
                  moneda: 'MXN',
                  costo_unitario_mxn: final,
                  tc_usd_mxn: tc,
                  costo_unitario_usd: round(final / (tc as number), 4),
                  updated_by: userId,
                }
              : {
                  moneda: 'USD',
                  costo_unitario_usd: final,
                  costo_unitario_mxn: null,
                  tc_usd_mxn: tc,
                  updated_by: userId,
                };
          const { error } = await svc
            .from('inventario_movimiento')
            .update(patch)
            .eq('id', l.inventario_movimiento_id);
          if (error) throw new Error(error.message);
          if (l.item_id) itemIds.push(l.item_id);
          continue;
        }

        let itemId = l.item_id;
        if (!itemId) {
          const { id: creado } = await findOrCreateItem(
            svc,
            this.inventory,
            {
              nombre: l.nombre,
              numero_parte: l.numero_parte,
              categoria: l.categoria || CATEGORIA_ITEM_DEFAULT,
            },
            userId,
          );
          itemId = creado;
        }
        const mov = (await this.inventory.createMovimiento(
          itemId,
          {
            tipo: TipoMovimientoInventario.ENTRADA,
            cantidad: Number(l.cantidad),
            moneda: compra.moneda,
            ...(compra.moneda === 'MXN'
              ? { costo_unitario_mxn: final, tc_usd_mxn: tc as number }
              : {
                  costo_unitario_usd: final,
                  // ENTRADA en USD con TC conocido: createMovimiento lo
                  // conserva para que el cardex exprese la capa en pesos
                  // reales (costoUnitarioMxnDe usa usd × tc).
                  ...(tc ? { tc_usd_mxn: tc } : {}),
                }),
            proveedor_id: compra.proveedor_id ?? undefined,
            fecha_movimiento: fecha,
            fecha_orden: fecha,
            referencia,
          },
          userId,
        )) as { id: string };
        creadas.push(mov.id);
        // Reclamo ATÓMICO de la línea: solo liga si NADIE la ligó antes
        // (otra sesión/proceso recibiendo la misma compra). Si no ligó, la
        // ENTRADA recién creada sobra y se deshace en el catch.
        const { data: ligada, error: eLinea } = await svc
          .from('compra_linea')
          .update({ item_id: itemId, inventario_movimiento_id: mov.id })
          .eq('id', l.id)
          .is('inventario_movimiento_id', null)
          .select('id');
        if (eLinea) throw new Error(eLinea.message);
        if (!ligada || ligada.length === 0) {
          throw new ConflictException(
            'La compra se está recibiendo en otra sesión; recárgala.',
          );
        }
        itemIds.push(itemId);
      }
    } catch (err) {
      await this.deshacerEntradas(creadas, compra.folio);
      throw err;
    }

    if (yaRecibida && itemIds.length > 0) {
      const { count, error } = await svc
        .from('inventario_movimiento')
        .select('id', { count: 'exact', head: true })
        .in('item_id', itemIds)
        .eq('tipo', 'SALIDA')
        .gte('fecha_movimiento', fecha);
      if (error) throw new Error(error.message);
      if ((count ?? 0) > 0) {
        avisos.push('las salidas ya registradas conservan su costo anterior');
      }
    }

    const { error: eCompra } = await svc
      .from('compra')
      .update({
        estado: 'RECIBIDA',
        recibida_at: yaRecibida ? compra.recibida_at : new Date().toISOString(),
        updated_by: userId,
      })
      .eq('id', id);
    if (eCompra) throw new Error(eCompra.message);

    this.logger.log(
      `compra #${compra.folio} ${yaRecibida ? 'recosteada' : 'recibida'}: ${calc.lineas.length} líneas, factor ${calc.resumen.factor}${sinTc > 0 ? ` (forzada con ${sinTc} cargo(s) sin TC)` : ''}`,
    );
    // Detalle fresco (las ENTRADAS ya coinciden con el costo final, así que
    // el aviso "recalcular" desaparece) + los avisos de esta operación.
    const detalle = await this.getDetail(id);
    const todos = Array.from(new Set([...detalle.resumen.avisos, ...avisos]));
    return {
      ...detalle,
      resumen: { ...detalle.resumen, avisos: todos },
      avisos: todos,
    };
  }

  /**
   * Borra las ENTRADAS creadas en una recepción que falló a medias (una
   * ENTRADA no genera gasto; la línea vuelve a null por la FK). Un fallo de
   * la propia limpieza se registra pero NO tapa el error original.
   */
  private async deshacerEntradas(
    movIds: string[],
    folio: number,
  ): Promise<void> {
    if (movIds.length === 0) return;
    const { error } = await this.supabase.service
      .from('inventario_movimiento')
      .delete()
      .in('id', movIds);
    if (error) {
      this.logger.error(
        `compra #${folio}: recepción fallida y no se pudieron deshacer ${movIds.length} ENTRADAS: ${error.message}`,
      );
      return;
    }
    this.logger.warn(
      `compra #${folio}: recepción fallida, se deshicieron ${movIds.length} ENTRADAS`,
    );
  }

  // ===== Baja =====

  /**
   * Bajo el candado: no se borra una compra mientras otra sesión la recibe.
   * Se niega si ya está RECIBIDA o si alguna línea ya entró al cardex
   * (recepción a medias): esas ENTRADAS pesan en el inventario.
   */
  async remove(id: string, userId: string) {
    return this.conCandado(id, () => this.removeInterno(id, userId));
  }

  private async removeInterno(id: string, userId: string) {
    const compra = await this.findCompra(id);
    if (compra.estado === 'RECIBIDA') {
      throw new ConflictException(
        'La compra ya fue recibida (sus entradas están en el cardex): no se elimina.',
      );
    }
    const nRecibidas = await this.lineasRecibidas(id);
    if (nRecibidas > 0) {
      throw new ConflictException(
        `La compra ya tiene ${nRecibidas} línea(s) con ENTRADA en el cardex (recepción a medias): no se elimina; termina de recibirla.`,
      );
    }
    await this.borrarCompra(id, userId);
    return { deleted: true, id };
  }

  /** Desliga sus gastos (el CHECK compra_id↔compra_rol lo exige) y borra la compra (líneas en cascada). */
  private async borrarCompra(id: string, userId: string): Promise<void> {
    const svc = this.supabase.service;
    const { error: eGastos } = await svc
      .from('gasto')
      .update({ compra_id: null, compra_rol: null, updated_by: userId })
      .eq('compra_id', id);
    if (eGastos) throw new Error(eGastos.message);
    const { error } = await svc.from('compra').delete().eq('id', id);
    if (error) throw new Error(error.message);
  }

  /** Limpieza de una compra que falló a medio armar; el error original manda. */
  private async deshacerCompra(
    id: string,
    userId: string,
    origen: string,
  ): Promise<void> {
    try {
      await this.borrarCompra(id, userId);
      this.logger.warn(`${origen}: compra ${id} deshecha por fallo a medias`);
    } catch (e) {
      this.logger.error(
        `${origen}: no se pudo deshacer la compra ${id} tras un fallo: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
