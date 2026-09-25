import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';
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
  CreateUbicacionDto,
  EmpaqueInputDto,
  FotoInventarioDto,
  ListInventarioQuery,
  ListMovimientosQuery,
  MoverUbicacionDto,
  TipoMovimientoInventario,
  UpdateEmpaqueDto,
  UpdateInventarioItemDto,
  UpdateMovimientoCostoDto,
  UpdateUbicacionDto,
} from './dto/inventory.dto';
import {
  CONFIG_INVENTARIO_MARGEN_VENTA_PCT,
  ConfiguracionService,
  INVENTARIO_MARGEN_VENTA_PCT_DEFAULT,
} from '../configuracion/configuracion.service';
// Catálogo de ubicaciones de bodega (25-sep-2026): helpers puros con spec.
import {
  camposUbicacionDeItem,
  FILTRO_SIN_UBICACION,
  limpiarNombreUbicacion,
  MENSAJES_UBICACION,
  MIGRACION_INVENTARIO_UBICACION,
  resolverUbicacionDeTexto,
  textoUbicacionExcel,
  ubicacionDuplicada,
} from './inventario-ubicacion.util';
import { normalizarCodigo } from './inventario-codigo.util';
// Baja de un movimiento de cardex (21-sep-2026): simulación pura de la existencia
// sin el movimiento + códigos estables del 409 (con spec).
import {
  cantidadTxt,
  codigoDeErrorEliminacion,
  esTablaInexistente,
  evaluarEliminacion,
  mensajeDeErrorEliminacion,
  montoTxt,
  MIGRACION_MOVIMIENTO_ELIMINADO,
  type CodigoBloqueoEliminacion,
  type EvaluacionEliminacion,
  type MovEliminable,
} from './eliminar-movimiento.util';
import { esFuncionInexistente } from '../../common/updated-at-trigger.util';
import { hoyCancun } from '../../common/fecha-cancun.util';
import { capturadoAhora } from '../../common/capturado-en.util';
import { columnaOpcional } from '../../common/columna-opcional.util';
import { clientRequestIdEnUso } from '../../common/client-request-id.util';
// Costo vigente (último precio de compra), T.C. por movimiento, venta/utilidad
// y agregados del cardex: fuente única (con spec).
import {
  agregadosDeItem,
  bloquesCardexDe,
  costoSinTc,
  costoUnitarioMxnDe,
  costoVigenteEn,
  EPS,
  etiquetaCargoDeSalida,
  existenciaDe,
  fijaPrecio,
  filtroPeriodo,
  margenVentaValido,
  montoGastoDeSalida,
  precioTxt,
  precioVentaDeSalida,
  REGLA_COSTO,
  resumenDiarioDe,
  nombreDeJoin,
  round,
  salidasQueDependenDe,
  sortChrono,
  statsDe,
  TEXTOS_INVENTARIO,
  textoEntradaConSalidas,
  textoSalidaAntesDeLaCompra,
  ventaDeSalida,
  type AgregadosItem,
  type CostoVigente,
  type MovCardex,
  type MovCosto,
  type MovForFifo,
  type OrigenVenta,
  type StatsInventario,
} from './inventario-cardex.util';
// T.C. oficial del día: la MISMA función que usa el cotizador (25-sep-2026).
import {
  fuenteTcLegible,
  TipoCambioService,
  type TipoCambioDetalle,
} from '../tipo-cambio/tipo-cambio.service';
import { redondearA } from '../../common/redondeo.util';

export { MIGRACION_INVENTARIO_UBICACION };

const ITEM_COLS =
  'id, nombre, marca, numero_parte, codigo, categoria, stock_minimo, ubicacion, unidad, precio_venta, precio_venta_moneda, descripcion, notas, foto_url, foto_storage_path, fotos_adicionales, activo, created_at, updated_at';

/** Columnas del catálogo `inventario_ubicacion` (migración 20260925000001). */
const UBICACION_COLS = 'id, nombre, orden, activo, created_at, updated_at';

/** Default del texto de ubicación SIN la migración (comportamiento 0.0.34). */
const UBICACION_LEGADO_DEFAULT = 'Bodega Cancún';

/** Ubicación del catálogo tal como la devuelve el API (con sus productos activos). */
export interface InventarioUbicacionRow {
  id: string;
  nombre: string;
  orden: number;
  activo: boolean;
  productos: number;
  created_at: string;
  updated_at: string;
}

/** Movimiento del cardex completo que lee la tienda / la hoja inventario. */
type MovTiendita = MovCardex & { id: string; item_id: string };

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

/** Índice único parcial de `inventario_movimiento.client_request_id`. */
const UQ_INV_MOVIMIENTO_CLIENT_REQUEST = 'uq_inv_movimiento_client_request';

/**
 * Migración que permite la SALIDA «para todas las matrículas» sin avión
 * (relaja el CHECK sin nombre de `20260515000004`). Mientras no esté
 * aplicada, esa captura rebota 23514 y el API responde 503
 * MIGRACION_PENDIENTE en vez del 500 genérico de antes.
 */
export const MIGRACION_SALIDA_FLOTA = '20260922000003';

/**
 * Los DOS checks CON NOMBRE que trae esa migración. Si un 23514 los cita, la
 * migración ya está aplicada: el rechazo es del DATO (400), no de la base.
 */
const CHECKS_SALIDA_FLOTA = [
  'inventario_movimiento_salida_destino_chk',
  'inventario_movimiento_para_flota_chk',
];

/**
 * Índice ÚNICO legado de `gasto.inventario_movimiento_id` (`20260703000001`,
 * cuando una salida generaba UN solo gasto). La misma migración
 * `20260922000003` lo cambia por uno normal: la salida de flota crea N gastos
 * ligados al MISMO movimiento y el segundo renglón del lote choca con 23505.
 */
const UQ_GASTO_INVENTARIO_MOVIMIENTO = 'uq_gasto_inventario_movimiento';

/** Bitácora forense de bajas de cardex (migración 20260921000001). */
const TABLA_MOVIMIENTO_ELIMINADO = 'inventario_movimiento_eliminado';
/** Borrado ATÓMICO (auditoría + gastos + movimiento) de la misma migración. */
const RPC_ELIMINAR_MOVIMIENTO = 'inventario_eliminar_movimiento';

/**
 * Texto de un valor `unknown` que viene de PostgREST (columna de texto o
 * ENUM). Nunca `[object Object]`: lo que no sea escalar cae al default.
 */
function textoDe(v: unknown, porDefecto = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return porDefecto;
}

/** Gasto BODEGA ligado a un movimiento, con su veredicto para la baja. */
export interface GastoLigado {
  id: string;
  monto: number;
  moneda: string;
  aeronave_matricula: string | null;
  fecha_gasto: string | null;
  /** true = este gasto NO se puede borrar (dinero ya cerrado). */
  bloqueado: boolean;
  motivo_bloqueo: string | null;
}

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
    /**
     * Aviso a ADMIN cuando alguien elimina un movimiento de cardex
     * (21-sep-2026). OPCIONAL a propósito: la baja NUNCA depende de él (y
     * los specs construyen el servicio sin él).
     */
    @Optional() private readonly notifications?: NotificationsService,
    /**
     * Margen de la tienda (`inventario_margen_venta_pct`, 25-sep-2026).
     * OPCIONAL: sin él (specs) o con la fila ausente el margen es 25 %.
     */
    @Optional() private readonly configuracion?: ConfiguracionService,
    /**
     * T.C. oficial del día (25-sep-2026, API 0.0.36): la MISMA fuente que las
     * cotizaciones (`oficialDetallePara`). OPCIONAL: sin él (specs viejos)
     * todo movimiento nuevo en dólares queda «sin T.C.» como en 0.0.35.
     */
    @Optional() private readonly tipoCambio?: TipoCambioService,
  ) {}

  private readonly logger = new Logger(InventoryService.name);

  /**
   * Memo del T.C. oficial POR FECHA (positivo y negativo, 10 min): la alta
   * masiva, importar una compra con IA y recibir una compra llaman
   * `createMovimiento` N veces con la misma fecha, y `oficialDetallePara`
   * puede ir a la red (6 s de timeout) por cada fecha pasada sin fila. Se
   * guarda la PROMESA para que dos llamadas simultáneas pidan una sola vez.
   */
  private readonly memoTc = new Map<
    string,
    { hasta: number; valor: Promise<TipoCambioDetalle | null> }
  >();

  /**
   * T.C. oficial del día `fecha` (YYYY-MM-DD, día Cancún) con la MISMA
   * función y la misma regla de respaldo que el cotizador
   * (`TipoCambioService.oficialDetallePara`: tabla con ventana de 7 días →
   * descarga del día / histórico BCE). Redondeado a 4 decimales (la
   * precisión de `inventario_movimiento.tc_usd_mxn`: lo persistido es lo que
   * se usó). NUNCA lanza: null = sin dato. Público: lo usa compras.service.
   */
  async tcOficialDe(fecha: string): Promise<TipoCambioDetalle | null> {
    if (!this.tipoCambio || !fecha) return null;
    const ahora = Date.now();
    const memo = this.memoTc.get(fecha);
    if (memo && memo.hasta > ahora) return memo.valor;
    const tipoCambio = this.tipoCambio;
    const valor = (async (): Promise<TipoCambioDetalle | null> => {
      try {
        const d = await tipoCambio.oficialDetallePara(fecha);
        const tc = d ? redondearA(Number(d.tc), 4) : NaN;
        return d && Number.isFinite(tc) && tc > 0 ? { ...d, tc } : null;
      } catch (e) {
        this.logger.warn(
          `T.C. oficial ${fecha} no disponible: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      }
    })();
    this.memoTc.set(fecha, { hasta: ahora + 10 * 60 * 1000, valor });
    return valor;
  }

  /** T.C. oficial de HOY (Cancún) — el del valorizado. */
  private tcHoy(): Promise<TipoCambioDetalle | null> {
    return this.tcOficialDe(hoyCancun());
  }

  /** Existencia + valorizado de un cardex con el T.C. oficial de hoy. */
  private async statsConTcHoy(
    movs: MovForFifo[],
    tcHoy?: TipoCambioDetalle | null,
  ): Promise<StatsInventario> {
    const tc = tcHoy === undefined ? await this.tcHoy() : tcHoy;
    return statsDe(movs, { hoy: hoyCancun(), tcHoy: tc?.tc ?? null });
  }

  /**
   * Margen vigente de la tienda (% sobre el último precio de compra). Best-effort: una
   * config caída o fuera de rango responde el default (25) — jamás tira una
   * salida de bodega.
   */
  private async margenVentaPct(): Promise<number> {
    if (!this.configuracion) return INVENTARIO_MARGEN_VENTA_PCT_DEFAULT;
    try {
      return margenVentaValido(
        await this.configuracion.numero(
          CONFIG_INVENTARIO_MARGEN_VENTA_PCT,
          INVENTARIO_MARGEN_VENTA_PCT_DEFAULT,
        ),
      );
    } catch {
      return INVENTARIO_MARGEN_VENTA_PCT_DEFAULT;
    }
  }

  // ===== Ubicaciones de bodega (catálogo, 25-sep-2026) =====
  // Sonda ÚNICA (`inventario_item.ubicacion_id`, migración 20260925000001):
  // mientras no exista, todo lo de ubicación se comporta como el API 0.0.34
  // (respuestas sin las llaves nuevas, alta con «Bodega Cancún») y lo NUEVO
  // (catálogo, mover, filtro, `ubicacion_id` en el DTO) responde 503
  // MIGRACION_PENDIENTE. Se enciende sola en ≤ 10 min al aplicarla.

  private ubicacionDisponible(): Promise<boolean> {
    return columnaOpcional(
      this.supabase.service,
      'inventario_item',
      'ubicacion_id',
      {
        mensajeAusente: `Columna inventario_item.ubicacion_id no existe todavía: ubicaciones de bodega (catálogo) apagadas hasta aplicar la migración ${MIGRACION_INVENTARIO_UBICACION}`,
      },
    ).disponible();
  }

  /** Columnas del ítem: `ubicacion_id` solo con la migración aplicada. */
  private itemCols(conCatalogo: boolean): string {
    return conCatalogo ? `${ITEM_COLS}, ubicacion_id` : ITEM_COLS;
  }

  private ubicacionesNoDisponibles(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      message: MENSAJES_UBICACION.noDisponible,
      error: 'MIGRACION_PENDIENTE',
      details: { migracion: MIGRACION_INVENTARIO_UBICACION },
    });
  }

  /** 503 claro si el catálogo todavía no existe en la base. */
  private async exigirUbicaciones(): Promise<void> {
    if (!(await this.ubicacionDisponible())) {
      throw this.ubicacionesNoDisponibles();
    }
  }

  /**
   * Fila de ítem con las llaves de ubicación (`ubicacion_id`,
   * `ubicacion_nombre`, `ubicacion_legado`; `ubicacion` = texto a mostrar).
   * Sin la migración la fila viaja tal cual (contrato 0.0.34).
   */
  private conUbicacion<T extends Record<string, unknown>>(
    row: T,
    conCatalogo: boolean,
  ): T {
    if (!conCatalogo) return row;
    return { ...row, ...camposUbicacionDeItem(row) };
  }

  /** Catálogo completo (activas e inactivas) por orden y nombre. */
  private async catalogoUbicaciones(): Promise<
    Array<Omit<InventarioUbicacionRow, 'productos'>>
  > {
    const { data, error } = await this.supabase.service
      .from('inventario_ubicacion')
      .select(UBICACION_COLS)
      .order('orden', { ascending: true })
      .order('nombre', { ascending: true });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<Record<string, unknown>>).map((u) => ({
      id: textoDe(u.id),
      nombre: textoDe(u.nombre),
      orden: Number(u.orden ?? 0),
      activo: u.activo !== false,
      created_at: textoDe(u.created_at),
      updated_at: textoDe(u.updated_at),
    }));
  }

  /** Productos ACTIVOS por ubicación (una lectura paginada, anti-cap). */
  private async productosPorUbicacion(): Promise<Map<string, number>> {
    const filas = await this.todasLasFilas<{
      id: string;
      ubicacion_id: string | null;
    }>((a, b) =>
      this.supabase.service
        .from('inventario_item')
        .select('id, ubicacion_id', { count: 'exact' })
        .eq('activo', true)
        .not('ubicacion_id', 'is', null)
        .order('id', { ascending: true })
        .range(a, b),
    );
    const map = new Map<string, number>();
    for (const f of filas) {
      if (f.ubicacion_id) {
        map.set(f.ubicacion_id, (map.get(f.ubicacion_id) ?? 0) + 1);
      }
    }
    return map;
  }

  /** GET ubicaciones: catálogo (por orden) con sus productos activos. */
  async listUbicaciones(
    incluirInactivas = false,
  ): Promise<InventarioUbicacionRow[]> {
    await this.exigirUbicaciones();
    const [catalogo, productos] = await Promise.all([
      this.catalogoUbicaciones(),
      this.productosPorUbicacion(),
    ]);
    return catalogo
      .filter((u) => incluirInactivas || u.activo)
      .map((u) => ({ ...u, productos: productos.get(u.id) ?? 0 }));
  }

  /** POST ubicaciones: alta (orden default = al final). */
  async createUbicacion(
    dto: CreateUbicacionDto,
    userId: string,
  ): Promise<InventarioUbicacionRow> {
    await this.exigirUbicaciones();
    const nombre = limpiarNombreUbicacion(dto.nombre);
    if (nombre.length < 2 || nombre.length > 50) {
      throw new BadRequestException(
        'El nombre de la ubicación va de 2 a 50 caracteres.',
      );
    }
    const catalogo = await this.catalogoUbicaciones();
    const dup = ubicacionDuplicada(nombre, catalogo);
    if (dup) {
      throw new ConflictException({
        message: MENSAJES_UBICACION.duplicada(dup.nombre),
        error: 'UBICACION_DUPLICADA',
        details: { id: dup.id, nombre: dup.nombre },
      });
    }
    const orden =
      dto.orden ??
      (catalogo.length > 0 ? Math.max(...catalogo.map((u) => u.orden)) + 1 : 1);
    const { data, error } = await this.supabase.service
      .from('inventario_ubicacion')
      .insert({ nombre, orden, created_by: userId, updated_by: userId })
      .select(UBICACION_COLS)
      .maybeSingle();
    if (error) throw this.errorDeUbicacion(error, nombre);
    return {
      ...(data as Omit<InventarioUbicacionRow, 'productos'>),
      productos: 0,
    };
  }

  /**
   * PATCH ubicaciones/:id: renombrar (el trigger propaga el nombre al texto
   * de sus productos), reordenar o (des)activar. Desactivar con productos
   * activos ⇒ 409 UBICACION_EN_USO (y la BD lo repite con un trigger).
   */
  async updateUbicacion(
    id: string,
    dto: UpdateUbicacionDto,
    userId: string,
  ): Promise<InventarioUbicacionRow> {
    await this.exigirUbicaciones();
    const catalogo = await this.catalogoUbicaciones();
    const actual = catalogo.find((u) => u.id === id);
    if (!actual) {
      throw new NotFoundException({
        message: MENSAJES_UBICACION.noExiste,
        error: 'UBICACION_NO_EXISTE',
      });
    }
    const cambios: Record<string, unknown> = {};
    if (dto.nombre !== undefined) {
      const nombre = limpiarNombreUbicacion(dto.nombre);
      if (nombre.length < 2 || nombre.length > 50) {
        throw new BadRequestException(
          'El nombre de la ubicación va de 2 a 50 caracteres.',
        );
      }
      const dup = ubicacionDuplicada(nombre, catalogo, id);
      if (dup) {
        throw new ConflictException({
          message: MENSAJES_UBICACION.duplicada(dup.nombre),
          error: 'UBICACION_DUPLICADA',
          details: { id: dup.id, nombre: dup.nombre },
        });
      }
      cambios.nombre = nombre;
    }
    if (dto.orden !== undefined) cambios.orden = dto.orden;
    if (dto.activo !== undefined) cambios.activo = dto.activo;
    if (Object.keys(cambios).length === 0) {
      throw new BadRequestException(
        'Nada que actualizar: manda nombre, orden o activo.',
      );
    }
    const productos = (await this.productosPorUbicacion()).get(id) ?? 0;
    if (dto.activo === false && actual.activo && productos > 0) {
      throw new ConflictException({
        message: MENSAJES_UBICACION.enUso(actual.nombre, productos),
        error: 'UBICACION_EN_USO',
        details: { productos },
      });
    }
    const { data, error } = await this.supabase.service
      .from('inventario_ubicacion')
      .update({ ...cambios, updated_by: userId })
      .eq('id', id)
      .select(UBICACION_COLS)
      .maybeSingle();
    if (error) {
      throw this.errorDeUbicacion(
        error,
        (cambios.nombre as string | undefined) ?? actual.nombre,
        productos,
      );
    }
    if (!data) {
      throw new NotFoundException({
        message: MENSAJES_UBICACION.noExiste,
        error: 'UBICACION_NO_EXISTE',
      });
    }
    return {
      ...(data as Omit<InventarioUbicacionRow, 'productos'>),
      productos,
    };
  }

  /**
   * Error de la BD en el catálogo → HTTP legible: 23505 (nombre repetido sin
   * distinguir mayúsculas) ⇒ 409 UBICACION_DUPLICADA; 23514 del trigger
   * «UBICACION_EN_USO…» (carrera: alguien movió un producto ahí entre la
   * lectura y el update) ⇒ 409 UBICACION_EN_USO — nunca un 500; otro 23514
   * (CHECK de nombre/orden) ⇒ 400.
   */
  private errorDeUbicacion(
    error: { code?: string; message: string },
    nombre: string,
    productos = 0,
  ): Error {
    if (error.code === '23505') {
      return new ConflictException({
        message: MENSAJES_UBICACION.duplicada(nombre),
        error: 'UBICACION_DUPLICADA',
      });
    }
    if (error.code === '23514') {
      if (/UBICACION_EN_USO/.test(error.message ?? '')) {
        const n = /tiene (\d+) producto/.exec(error.message ?? '')?.[1];
        const enUso = n != null ? Number(n) : productos;
        return new ConflictException({
          message: MENSAJES_UBICACION.enUso(nombre, enUso),
          error: 'UBICACION_EN_USO',
          details: { productos: enUso },
        });
      }
      return new BadRequestException({
        message:
          'El nombre de la ubicación va de 2 a 50 caracteres (sin espacios de sobra) y el orden no puede ser negativo.',
        error: 'UBICACION_INVALIDA',
        details: { tecnico: error.message },
      });
    }
    return new Error(error.message);
  }

  /** Ubicación destino válida (existe y está activa, salvo `actualId`). */
  private async ubicacionElegible(
    id: string,
    actualId?: string | null,
  ): Promise<{ id: string; nombre: string }> {
    const { data, error } = await this.supabase.service
      .from('inventario_ubicacion')
      .select('id, nombre, activo')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException({
        message: MENSAJES_UBICACION.noExiste,
        error: 'UBICACION_NO_EXISTE',
      });
    }
    const fila = data as unknown as Record<string, unknown>;
    const u = {
      id: textoDe(fila.id),
      nombre: textoDe(fila.nombre),
      activo: fila.activo !== false,
    };
    if (!u.activo && u.id !== actualId) {
      throw new BadRequestException({
        message: MENSAJES_UBICACION.inactiva(u.nombre),
        error: 'UBICACION_INACTIVA',
        details: { id: u.id },
      });
    }
    return { id: u.id, nombre: u.nombre };
  }

  /**
   * POST items/mover-ubicacion: mueve varios productos a una ubicación en UNA
   * sola escritura (el trigger escribe el texto espejo). Solo ítems ACTIVOS;
   * los que ya estaban ahí cuentan en `sin_cambio`, y los ids que no existen
   * o están dados de baja se reportan (no es error). No mueve stock ni dinero.
   */
  async moverUbicacion(dto: MoverUbicacionDto, userId: string) {
    await this.exigirUbicaciones();
    const ids = [...new Set(dto.item_ids)];
    const destino = await this.ubicacionElegible(dto.ubicacion_id);
    // `in (…)` en LOTES (revisión adversaria 25-sep-2026): el DTO admite 500
    // ids y con ~200 uuids la URL de PostgREST revienta (414, ver
    // `LOTE_IDS_BD` del espejo de Google). Mover es idempotente: si un lote
    // falla, reintentar mueve el resto y lo ya movido cuenta en `sin_cambio`.
    const filas: Array<{
      id: string;
      activo: boolean;
      ubicacion_id: string | null;
    }> = [];
    for (const lote of lotesDeIds(ids)) {
      const { data, error } = await this.supabase.service
        .from('inventario_item')
        .select('id, activo, ubicacion_id')
        .in('id', lote);
      if (error) throw new Error(error.message);
      filas.push(...((data ?? []) as typeof filas));
    }
    const porId = new Map(filas.map((f) => [f.id, f]));
    const noEncontrados: string[] = [];
    const inactivos: string[] = [];
    const porMover: string[] = [];
    let sinCambio = 0;
    for (const id of ids) {
      const f = porId.get(id);
      if (!f) noEncontrados.push(id);
      else if (f.activo === false) inactivos.push(id);
      else if (f.ubicacion_id === destino.id) sinCambio += 1;
      else porMover.push(id);
    }
    let movidos = 0;
    for (const lote of lotesDeIds(porMover)) {
      const { data: upd, error: eUpd } = await this.supabase.service
        .from('inventario_item')
        .update({ ubicacion_id: destino.id, updated_by: userId })
        .in('id', lote)
        .eq('activo', true)
        .select('id');
      if (eUpd) throw new Error(eUpd.message);
      movidos += (upd ?? []).length;
    }
    return {
      movidos,
      sin_cambio: sinCambio,
      no_encontrados: noEncontrados,
      inactivos,
      ubicacion: destino,
    };
  }

  /**
   * Campos de ubicación de un ALTA. Sin la migración: el texto de siempre
   * (default «Bodega Cancún»; `ubicacion_id` ⇒ 503). Con ella: `ubicacion_id`
   * gana (existe y activa); si solo viaja texto se liga al catálogo cuando
   * coincide y, si no, queda como legado; sin nada ⇒ sin ubicación (null).
   */
  private async ubicacionDeAlta(
    dto: CreateInventarioItemDto,
  ): Promise<Record<string, unknown>> {
    const conCatalogo = await this.ubicacionDisponible();
    if (!conCatalogo) {
      if (dto.ubicacion_id != null) throw this.ubicacionesNoDisponibles();
      return { ubicacion: dto.ubicacion ?? UBICACION_LEGADO_DEFAULT };
    }
    if (dto.ubicacion_id != null) {
      const u = await this.ubicacionElegible(dto.ubicacion_id);
      return { ubicacion_id: u.id, ubicacion: u.nombre };
    }
    if (textoNoVacio(dto.ubicacion)) {
      const r = resolverUbicacionDeTexto(
        dto.ubicacion,
        await this.catalogoUbicaciones(),
      );
      return { ubicacion_id: r.ubicacion_id, ubicacion: r.ubicacion };
    }
    return {};
  }

  /**
   * Campos de ubicación de una EDICIÓN (misma regla que el alta; la
   * ubicación que el ítem YA tiene se acepta aunque esté desactivada).
   * `ubicacion_id: null` ⇒ «Sin ubicación» (id y texto en null).
   */
  private async ubicacionDeEdicion(
    id: string,
    dto: UpdateInventarioItemDto,
  ): Promise<Record<string, unknown>> {
    if (dto.ubicacion_id === undefined && dto.ubicacion === undefined) {
      return {};
    }
    const conCatalogo = await this.ubicacionDisponible();
    if (dto.ubicacion_id !== undefined) {
      if (!conCatalogo) throw this.ubicacionesNoDisponibles();
      if (dto.ubicacion_id === null) {
        return { ubicacion_id: null, ubicacion: null };
      }
      const actual = (await this.findItem(id)) as { ubicacion_id?: unknown };
      const u = await this.ubicacionElegible(
        dto.ubicacion_id,
        typeof actual.ubicacion_id === 'string' ? actual.ubicacion_id : null,
      );
      return { ubicacion_id: u.id, ubicacion: u.nombre };
    }
    const texto = (dto.ubicacion ?? '').trim();
    if (!conCatalogo) return { ubicacion: texto };
    const actual = (await this.findItem(id)) as { ubicacion_id?: unknown };
    const r = resolverUbicacionDeTexto(
      texto,
      await this.catalogoUbicaciones(),
      typeof actual.ubicacion_id === 'string' ? actual.ubicacion_id : null,
    );
    return { ubicacion_id: r.ubicacion_id, ubicacion: r.ubicacion };
  }

  /**
   * Inventario valorizado en Excel (respeta los filtros del listado:
   * q/categoría/ubicación y desde/hasta para la utilidad).
   *
   * 25-sep-2026 (API 0.0.36): valorizado al ÚLTIMO PRECIO DE COMPRA con el
   * T.C. oficial de hoy, y lo vendido / la utilidad en PESOS (cada venta al
   * T.C. de su día). Las columnas en dólares («Valor USD (sin T.C.)»,
   * «Utilidad (USD sin T.C.)») solo aparecen si algún producto trae ese dato
   * (movimientos sin T.C.): cada moneda en su columna con su total, jamás
   * sumadas (invariante 8).
   */
  async itemsXlsx(filters: ListInventarioQuery): Promise<Buffer> {
    const {
      data,
      valor_total_mxn,
      valor_total_usd_sin_tc,
      margen_venta_pct,
      tc_hoy,
    } = await this.listItems({
      ...filters,
      limit: 2000,
      offset: 0,
    });
    const conCatalogo = await this.ubicacionDisponible();
    const filasBase = data.map((it) => it as Record<string, unknown>);
    const hayValorUsd = valor_total_usd_sin_tc !== 0;
    const hayUtilidadUsd = filasBase.some((x) => x.utilidad_usd != null);
    const columnas: TablaColumnaPayload[] = [
      { label: 'Ítem' },
      { label: 'Código' },
      { label: 'No. parte' },
      { label: 'Categoría' },
      { label: 'Ubicación' },
      { label: 'Stock', tipo: 'numero' },
      { label: 'Unidad' },
      { label: 'Mínimo', tipo: 'numero' },
      { label: 'Último precio de compra', tipo: 'numero' },
      { label: 'Moneda' },
      { label: 'Valor (MXN)', tipo: 'money' },
      { label: 'Vendido (MXN)', tipo: 'money' },
      { label: 'Utilidad (MXN)', tipo: 'money' },
      ...(hayValorUsd
        ? [{ label: 'Valor USD (sin T.C.)', tipo: 'money' as const }]
        : []),
      ...(hayUtilidadUsd
        ? [{ label: 'Utilidad (USD sin T.C.)', tipo: 'money' as const }]
        : []),
    ];
    // Totales sobre TODO lo exportado, cada moneda en su columna (null =
    // ningún producto trae dato en esa columna: celda vacía).
    let vendidoMxn: number | null = null;
    let utilidadMxn: number | null = null;
    let utilidadUsd: number | null = null;
    const filas = filasBase.map((x) => {
      const usdSinTc = Number(x.valor_usd_sin_tc ?? 0);
      const vMxn = x.ventas_mxn != null ? Number(x.ventas_mxn) : null;
      const uMxn = x.utilidad_mxn != null ? Number(x.utilidad_mxn) : null;
      const uUsd = x.utilidad_usd != null ? Number(x.utilidad_usd) : null;
      if (vMxn != null) vendidoMxn = round((vendidoMxn ?? 0) + vMxn, 2);
      if (uMxn != null) utilidadMxn = round((utilidadMxn ?? 0) + uMxn, 2);
      if (uUsd != null) utilidadUsd = round((utilidadUsd ?? 0) + uUsd, 2);
      const vig = x.costo_vigente as CostoVigente | null | undefined;
      return [
        (x.nombre as string) ?? '',
        (x.codigo as string) ?? '',
        (x.numero_parte as string) ?? '',
        (x.categoria as string) ?? '',
        textoUbicacionExcel(x, conCatalogo),
        x.stock as number,
        (x.unidad as string) ?? '',
        (x.stock_minimo as number) ?? null,
        vig ? round(vig.unitario, 4) : null,
        vig ? vig.moneda : '',
        x.valor_mxn as number,
        vMxn,
        uMxn,
        ...(hayValorUsd ? [usdSinTc !== 0 ? usdSinTc : null] : []),
        ...(hayUtilidadUsd ? [uUsd] : []),
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
      null,
      valor_total_mxn,
      vendidoMxn,
      utilidadMxn,
      ...(hayValorUsd ? [valor_total_usd_sin_tc] : []),
      ...(hayUtilidadUsd ? [utilidadUsd] : []),
    ];
    const periodo =
      filters.desde && filters.hasta
        ? `del ${filters.desde} al ${filters.hasta}`
        : filters.desde
          ? `desde el ${filters.desde}`
          : filters.hasta
            ? `hasta el ${filters.hasta}`
            : 'todo el historial';
    const valorizado = tc_hoy
      ? `valorizado al último precio de compra con el T.C. oficial de hoy ${tc_hoy.tc.toFixed(4)} (${fuenteTcLegible(tc_hoy.fuente)}, ${fechaGuion(tc_hoy.fecha_dato)})`
      : 'valorizado al último precio de compra (sin T.C. oficial de hoy: lo comprado en dólares va aparte)';
    return this.pyservices.generateTablaXlsx({
      titulo: 'Inventario valorizado',
      subtitulo: `Generado ${hoyCancun()} · ${valorizado} · utilidad: ${periodo} · margen vigente ${margen_venta_pct} %`,
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
    // criterio único costoUnitarioMxnDe (en una SALIDA la columna «TC» es el
    // T.C. oficial del día de la VENTA desde el API 0.0.36); el USD interno
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
        // USD sin T.C.: costoUnitarioMxnDe devuelve el número en DÓLARES
        // (pesosExactos=false) — pintarlo en la columna «(MXN)» sería un USD
        // disfrazado de pesos (invariante 8; revisión adversaria 25-sep-2026).
        // Celda vacía: el USD interno va en su propia columna.
        costo.costo_unitario_usd != null && !costoSinTc(costo)
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
      // Día Cancún (el ISO de UTC fechaba «mañana» de las 19:00 a las 23:59).
      subtitulo: `Generado ${hoyCancun()}`,
      columnas,
      filas,
    });
  }

  /**
   * Cardex de UN ítem en formato LIBRO (réplica del cuaderno del cliente):
   * bloque ENTRADAS | bloque SALIDAS lado a lado, con stock corriente,
   * venta, remanente y ganancia por salida. Los bloques son los MISMOS que
   * consume la ficha del producto en el panel (bloquesCardexDe — fuente
   * única; pyservices SOLO renderiza). Montos en PESOS: compras al T.C.
   * oficial de su día, ventas al del día de la venta; salida SIN precio de
   * venta = el avión pagó el costo (último precio de compra), así que el
   * libro la registra "vendida al costo" (ganancia 0).
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
    const { compras, ventas, totales } = bloquesCardexDe(
      item.nombre,
      movs,
      undefined,
      { hoy: hoyCancun() },
    );
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
      // ADITIVO (0.0.36): de qué T.C. salen los pesos (pyservices la pinta
      // en el subtítulo; uno viejo la ignora).
      nota: TEXTOS_INVENTARIO.notaLibro,
      entradas,
      salidas,
      // Total de COMPRA = solo las ENTRADAS (una devolución o un ajuste
      // regresan valor al stock, pero no son una compra). Total de VENTA =
      // toda la columna del libro: lo vendido con precio + lo que salió a
      // costo. Ganancia = la de las salidas con precio (las salidas a costo
      // aportan 0).
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
   * costo (existencia × último precio de compra al T.C. oficial de HOY —
   * todo el cardex, no una foto al corte), lo COMPRADO en el periodo (solo
   * ENTRADAs: una DEVOLUCION/AJUSTE regresa stock pero no es compra — mismo
   * criterio que el total de compra del cardex libro), las salidas del
   * periodo, lo VENDIDO a los aviones (Σ venta de las salidas CON precio al
   * T.C. del día de la venta — criterio único ventaDeSalida), la utilidad
   * (vendido − costo de esas salidas) y las matrículas a las que se aplicó.
   * FUENTES ÚNICAS: statsDe para stock y valorizado, agregadosDeItem para
   * compras/ventas/utilidad — cero cálculo paralelo. La consulta trae el
   * historial COMPLETO (existencia y precio vigente lo necesitan);
   * el corte desde/hasta se aplica EN MEMORIA sobre fecha_movimiento
   * (string YYYY-MM-DD, mismo eje que listMovimientos). Solo ítems con
   * actividad en el periodo O con stock/valor vivo; los eliminados con
   * movimiento del periodo SÍ cuentan (su dinero ya viajó).
   *
   * MONEDAS (22-sep-2026, invariante 8 — «jamás un USD sumado como MXN»):
   * `valor_costo_mxn` trae SOLO pesos reales y `valor_costo_usd` (+ `sin_tc`)
   * la parte comprada en dólares SIN tipo de cambio, que el Excel pinta en su
   * propia columna con su propio total (`total_valor_usd`) y una nota al pie
   * cuando `filas_sin_tc > 0`. Hasta hoy la columna sumaba las dos monedas y
   * las rotulaba «MXN»: 67 de las 68 ENTRADAs de producción son USD sin TC
   * (carga VTF-INV-001 del 29-ago), así que casi TODO el total de esa hoja
   * eran dólares disfrazados de pesos. Decisión del cliente: verlos en
   * dólares, aparte, en vez de sumarlos como pesos. Los dos campos nuevos son
   * ADITIVOS: un pyservices viejo los ignora y pinta la hoja de siempre.
   * Desde el API 0.0.36 (T.C. oficial en cada movimiento) las columnas en
   * dólares quedan vacías y pyservices las apaga solas; `tc_hoy` y
   * `regla_costo` viajan en la raíz para la nota del valor.
   */
  async resumenTiendita(
    desde: string,
    hasta: string,
  ): Promise<BalanceHojaInventarioPayload> {
    const [porItem, margen, tcHoy] = await Promise.all([
      this.agregadosPorItem(desde, hasta),
      this.margenVentaPct(),
      this.tcHoy(),
    ]);
    const ids = porItem.map((p) => p.item_id);
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
    for (const { item_id: itemId, movs, agregados: a } of porItem) {
      const stats = statsDe(movs, {
        hoy: hoyCancun(),
        tcHoy: tcHoy?.tc ?? null,
      });
      const actividadPeriodo = movs.some(enPeriodo);
      // `valor_usd_sin_tc` entra a la condición: desde que `valor_mxn` deja
      // fuera las capas USD sin TC, un ítem valorizado SOLO en dólares daría
      // `valor_mxn === 0` y desaparecería de la hoja en silencio.
      if (
        !actividadPeriodo &&
        stats.stock <= 0 &&
        stats.valor_mxn === 0 &&
        stats.valor_usd_sin_tc === 0
      ) {
        continue;
      }
      // Agregación única (agregadosDeItem, ya calculada en agregadosPorItem):
      // compras = solo ENTRADA; vendido/utilidad = solo SALIDAs con precio;
      // null sin actividad.
      const info = nombrePorItem.get(itemId);
      const nombre = info
        ? info.numero_parte
          ? `${info.nombre} · ${info.numero_parte}`
          : info.nombre
        : 'Ítem eliminado';
      // Movimientos USD sin TC: compras/utilidad afectadas van null (jamás
      // USD sumado como MXN). Eso NO tiene columna en la hoja: queda en el
      // log y el panel lo marca en ámbar (con_movimientos_sin_tc). El
      // VALORIZADO sí la tiene desde hoy (`valor_costo_usd`), y es una
      // pregunta distinta: mira las capas VIVAS, no todo el cardex — un ítem
      // cuyas capas en dólares ya se consumieron va `sin_tc: false` con su
      // valor 100 % en pesos, y aun así se registra en el log.
      if (a.con_movimientos_sin_tc) sinTc.push(nombre);
      filas.push({
        nombre,
        existencia: stats.stock,
        valor_costo_mxn: stats.valor_mxn,
        // 0 ⇒ null: celda vacía en el Excel, no un "$0.00 USD" que se lea
        // como «esto no vale nada en dólares».
        valor_costo_usd:
          stats.valor_usd_sin_tc !== 0 ? stats.valor_usd_sin_tc : null,
        sin_tc: !stats.pesos_exactos,
        compradas_cant: a.compradas_cant,
        compradas_costo_mxn: a.compradas_costo_mxn,
        salidas_cant: a.salidas_cant,
        vendido_mxn: a.ventas_mxn,
        utilidad_mxn: a.utilidad_mxn,
        // ADITIVOS (25-sep-2026, tienda): la utilidad en DÓLARES, aparte
        // (solo el RESPALDO de filas sin T.C. desde el API 0.0.36).
        vendido_usd: a.ventas_usd,
        utilidad_usd: a.utilidad_usd,
        ventas_sin_utilidad: a.ventas_sin_utilidad,
        // ADITIVOS (0.0.36): el USD original de las ventas USD-sobre-USD que
        // YA cuentan en pesos (pyservices no los pinta).
        vendido_usd_original: a.ventas_usd_original,
        utilidad_usd_original: a.utilidad_usd_original,
        matriculas: a.matriculas.length > 0 ? a.matriculas.join(' + ') : null,
      });
    }
    filas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    if (sinTc.length > 0) {
      this.logger.warn(
        `Hoja inventario ${desde}..${hasta}: ${sinTc.length} ítem(s) con movimientos USD sin TC (montos en pesos omitidos): ${sinTc.join(' | ')}`,
      );
    }
    // Σ en DÓLARES de las filas (null si ninguna trae USD): su propia
    // columna, jamás sumada con los pesos.
    const sumaUsd = (
      f: (x: BalanceInventarioItemFilaPayload) => number | null,
    ): number | null =>
      filas.some((x) => f(x) != null)
        ? round(
            filas.reduce((s, x) => s + (f(x) ?? 0), 0),
            2,
          )
        : null;
    return {
      filas,
      total_piezas: round(filas.reduce((s, f) => s + (f.existencia ?? 0), 0)),
      total_valor_mxn: round(
        filas.reduce((s, f) => s + (f.valor_costo_mxn ?? 0), 0),
        2,
      ),
      // Total APARTE, en su moneda: nunca se suma con el de pesos.
      total_valor_usd: round(
        filas.reduce((s, f) => s + (f.valor_costo_usd ?? 0), 0),
        2,
      ),
      filas_sin_tc: filas.filter((f) => f.sin_tc).length,
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
      total_vendido_usd: sumaUsd((f) => f.vendido_usd),
      total_utilidad_usd: sumaUsd((f) => f.utilidad_usd),
      filas_utilidad_incompleta: filas.filter((f) => f.ventas_sin_utilidad > 0)
        .length,
      margen_venta_pct: margen,
      // ADITIVOS (0.0.36): T.C. del valorizado y la regla de costo.
      tc_hoy: tcHoy,
      regla_costo: REGLA_COSTO,
    };
  }

  /**
   * Cardex COMPLETO de la bodega (todos los ítems, incluidos los dados de
   * baja: su dinero ya viajó) agrupado por ítem, con la agregación única
   * (`agregadosDeItem`) del periodo. Lo comparten la hoja «inventario» del
   * Balance general (`resumenTiendita`) y el resumen de la tienda
   * (`tiendaResumen`): el MISMO número en los dos lados.
   * `para_flota` NO está en la lista base de columnas de movimiento:
   * seleccionarlo explícito (como el cardex libro) o el "FLOTA" de las
   * salidas prorrateadas se perdería en silencio. Lectura paginada hasta
   * cubrir el count: existencia y precio vigente necesitan TODO el cardex.
   */
  private async agregadosPorItem(
    desde?: string | null,
    hasta?: string | null,
  ): Promise<
    Array<{ item_id: string; movs: MovTiendita[]; agregados: AgregadosItem }>
  > {
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
    const enPeriodo = filtroPeriodo(desde, hasta);
    return [...porItem].map(([item_id, movs]) => ({
      item_id,
      movs,
      agregados: agregadosDeItem(movs, enPeriodo),
    }));
  }

  /**
   * UTILIDAD DE LA TIENDA VuelaTour (25-sep-2026, `GET tienda/resumen`): lo
   * que se cobró a los aviones menos el costo de lo que salió (último precio
   * de compra), en el periodo (sin fechas = todo el historial), en PESOS al
   * T.C. del día de cada venta. Los dólares van SEPARADOS: `utilidad_usd` es
   * el respaldo de filas sin T.C.; `utilidad_usd_original` el USD de las
   * ventas USD-sobre-USD que ya cuentan en pesos (dato secundario, jamás
   * sumado). Fuente única: `agregadosPorItem` → `agregadosDeItem` →
   * `ventaDeSalida`.
   */
  async tiendaResumen(q: { desde?: string; hasta?: string } = {}) {
    if (q.desde && q.hasta && q.desde > q.hasta) {
      throw new BadRequestException(
        'El periodo está al revés: «desde» es posterior a «hasta».',
      );
    }
    const [porItem, margen] = await Promise.all([
      this.agregadosPorItem(q.desde, q.hasta),
      this.margenVentaPct(),
    ]);
    const suma = (
      f: (a: AgregadosItem) => number | null,
      decimales = 2,
    ): number | null =>
      porItem.some((p) => f(p.agregados) != null)
        ? round(
            porItem.reduce((s, p) => s + (f(p.agregados) ?? 0), 0),
            decimales,
          )
        : null;
    const conVentas = porItem.filter((p) => p.agregados.ventas_cant != null);
    return {
      periodo:
        q.desde || q.hasta
          ? { desde: q.desde ?? null, hasta: q.hasta ?? null }
          : null,
      margen_venta_pct: margen,
      utilidad_mxn: suma((a) => a.utilidad_mxn),
      utilidad_usd: suma((a) => a.utilidad_usd),
      ventas_mxn: suma((a) => a.ventas_mxn),
      ventas_usd: suma((a) => a.ventas_usd),
      costo_ventas_mxn: suma((a) => a.costo_ventas_mxn),
      costo_ventas_usd: suma((a) => a.costo_ventas_usd),
      unidades_cargadas: suma((a) => a.salidas_cant, 3) ?? 0,
      unidades_vendidas: suma((a) => a.ventas_cant, 3) ?? 0,
      productos_con_ventas: conVentas.length,
      ventas_sin_utilidad: porItem.reduce(
        (s, p) => s + p.agregados.ventas_sin_utilidad,
        0,
      ),
      // Solo importa donde hubo ventas: ahí la utilidad sale inflada por
      // una capa a $0 (un producto sin ventas no afecta la cifra).
      con_entradas_sin_costo: conVentas.some(
        (p) => p.agregados.con_entradas_sin_costo,
      ),
      // ADITIVOS (0.0.36).
      ventas_usd_original: suma((a) => a.ventas_usd_original),
      costo_ventas_usd_original: suma((a) => a.costo_ventas_usd_original),
      utilidad_usd_original: suma((a) => a.utilidad_usd_original),
      regla_costo: REGLA_COSTO,
    };
  }

  // ===== Cardex =====
  // Existencia, costo vigente y agregados viven en inventario-cardex.util.ts
  // (fuente única, puro y con spec).

  /**
   * Cardex mínimo del ítem para la existencia y el costo vigente de una
   * SALIDA nueva. Paginado hasta cubrir `count` (mismo anti-cap que
   * movsCardexCompleto): con el tope de 1000 filas de PostgREST una salida
   * nueva leería un cardex incompleto y el costo al avión saldría falso en
   * silencio.
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
    const conCatalogo = await this.ubicacionDisponible();
    // El filtro por ubicación es del catálogo: sin la migración no hay nada
    // por qué filtrar (503 claro, no una lista vacía que engañe).
    if (filters.ubicacion && !conCatalogo) {
      throw this.ubicacionesNoDisponibles();
    }
    let q = this.supabase.service
      .from('inventario_item')
      .select(this.itemCols(conCatalogo), { count: 'exact' })
      .order('nombre', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.categoria) q = q.eq('categoria', filters.categoria);
    if (filters.ubicacion) {
      q =
        filters.ubicacion.toLowerCase() === FILTRO_SIN_UBICACION
          ? q.is('ubicacion_id', null)
          : q.eq('ubicacion_id', filters.ubicacion);
    }
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(
        `nombre.ilike.${term},numero_parte.ilike.${term},codigo.ilike.${term}`,
      );
    }
    const { data: items, error, count } = await q;
    if (error) throw new Error(error.message);
    const rows = (items ?? []) as unknown as Array<
      Record<string, unknown> & { id: string; stock_minimo: number | null }
    >;

    // Stock + valorizado + utilidad por ítem (un solo barrido del cardex de
    // los ítems listados). Existencia y precio vigente miran SIEMPRE todo el
    // cardex; desde/hasta solo acotan qué compras/ventas SUMAN (sin query =
    // acumulado histórico). Valorizado = existencia × último precio de
    // compra al T.C. oficial de HOY (uno por petición).
    const ids = rows.map((r) => r.id);
    const [movsByItem, empaquesByItem, margen, tcHoy] = await Promise.all([
      this.movsByItems(ids),
      this.empaquesByItems(ids),
      this.margenVentaPct(),
      this.tcHoy(),
    ]);
    const enPeriodo = filtroPeriodo(filters.desde, filters.hasta);
    const hoy = hoyCancun();
    let data = rows.map((r) => {
      const it = this.conUbicacion(r, conCatalogo);
      const movs = movsByItem.get(it.id) ?? [];
      const stats = statsDe(movs, { hoy, tcHoy: tcHoy?.tc ?? null });
      // UTILIDAD del producto (tienda, 25-sep-2026): la MISMA agregación que
      // la hoja "inventario" del Balance general (agregadosDeItem) — lo que
      // se cobró a los aviones − el costo de esas salidas, en PESOS al T.C.
      // del día de cada venta (los dólares: solo el respaldo sin T.C. y el
      // USD original como dato secundario); null = nunca vendió.
      const a = agregadosDeItem(movs, enPeriodo);
      return {
        ...it,
        empaques: empaquesByItem.get(it.id) ?? [],
        ...stats,
        bajo_stock:
          it.stock_minimo != null && stats.stock < Number(it.stock_minimo),
        salidas_cant: a.salidas_cant,
        ventas_cant: a.ventas_cant,
        ventas_mxn: a.ventas_mxn,
        costo_ventas_mxn: a.costo_ventas_mxn,
        // `ganancia_mxn` se conserva (compat) = `utilidad_mxn`.
        ganancia_mxn: a.utilidad_mxn,
        utilidad_mxn: a.utilidad_mxn,
        ventas_usd: a.ventas_usd,
        costo_ventas_usd: a.costo_ventas_usd,
        utilidad_usd: a.utilidad_usd,
        ventas_sin_utilidad: a.ventas_sin_utilidad,
        con_entradas_sin_costo: a.con_entradas_sin_costo,
        con_movimientos_sin_tc: a.con_movimientos_sin_tc,
        // ADITIVOS (0.0.36).
        ventas_usd_original: a.ventas_usd_original,
        costo_ventas_usd_original: a.costo_ventas_usd_original,
        utilidad_usd_original: a.utilidad_usd_original,
        ventas_a_costo_mxn: a.ventas_a_costo_mxn,
        salidas_a_costo_cant: a.salidas_a_costo_cant,
        movimientos_sin_tc: a.movimientos_sin_tc,
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
      // ADITIVO (22-sep-2026): lo comprado en dólares SIN TC, en DÓLARES y
      // aparte — `valor_total_mxn` ya no lo incluye (invariante 8).
      valor_total_usd_sin_tc: round(
        data.reduce((s, d) => s + d.valor_usd_sin_tc, 0),
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
      // ADITIVOS (25-sep-2026): utilidad de la tienda POR PÁGINA, una suma por
      // moneda — jamás sumadas entre sí.
      utilidad_total_mxn: round(
        data.reduce((s, d) => s + (d.utilidad_mxn ?? 0), 0),
        2,
      ),
      utilidad_total_usd: round(
        data.reduce((s, d) => s + (d.utilidad_usd ?? 0), 0),
        2,
      ),
      margen_venta_pct: margen,
      // ADITIVOS (0.0.36): T.C. del valorizado, el USD original de las
      // ventas USD-sobre-USD (dato secundario, jamás sumado a los pesos) y la
      // regla de costo.
      tc_hoy: tcHoy,
      utilidad_total_usd_original: round(
        data.reduce((s, d) => s + (d.utilidad_usd_original ?? 0), 0),
        2,
      ),
      ventas_total_usd_original: round(
        data.reduce((s, d) => s + (d.ventas_usd_original ?? 0), 0),
        2,
      ),
      regla_costo: REGLA_COSTO,
    };
  }

  /**
   * Cardex de VARIOS ítems en una sola lectura (paginada hasta cubrir el
   * count: existencia y precio vigente necesitan el historial completo). Trae venta y para_flota
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

  async findItem(id: string): Promise<Record<string, unknown>> {
    const conCatalogo = await this.ubicacionDisponible();
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .select(this.itemCols(conCatalogo))
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Ítem ${id} not found`);
    return this.conUbicacion(
      data as unknown as Record<string, unknown>,
      conCatalogo,
    );
  }

  /**
   * Detalle del ítem con empaques, cardex completo y stats (existencia y
   * valorizado al último precio de compra con el T.C. oficial de hoy).
   */
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

    const stats = await this.statsConTcHoy(movs);
    const vigenteId = stats.costo_vigente?.movimiento_id ?? null;
    // Por movimiento, ADITIVO: `costo_unitario_mxn_efectivo` (costo unitario
    // en PESOS con el criterio único costoUnitarioMxnDe — null si la captura
    // fue USD sin TC: el panel entonces enseña el USD, jamás un "MXN" falso).
    // ENTRADA: si fija precio, si ES el precio vigente y cuántas salidas se
    // cobraron con él (el aviso ANTES de «Editar costo»). SALIDA: su costo
    // (el de la fila), venta y utilidad en pesos al T.C. del día de la venta
    // (ventaDeSalida). El resto de la fila viaja intacto.
    const salida = TipoMovimientoInventario.SALIDA as string;
    const entrada = TipoMovimientoInventario.ENTRADA as string;
    const movimientos = movs.map((x) => {
      const costo_unitario_mxn_efectivo =
        x.costo_unitario_usd != null && !costoSinTc(x)
          ? round(costoUnitarioMxnDe(x).mxn, 2)
          : null;
      if (x.tipo === entrada) {
        const deps = salidasQueDependenDe(movs, x.id);
        return {
          ...x,
          costo_unitario_mxn_efectivo,
          fija_precio: fijaPrecio(x),
          es_precio_vigente: vigenteId != null && x.id === vigenteId,
          salidas_con_este_precio: deps.length,
          salidas_sin_cargo: deps.filter((d) => d.sin_cargo).length,
        };
      }
      if (x.tipo !== salida) return { ...x, costo_unitario_mxn_efectivo };
      const v = ventaDeSalida(x);
      return {
        ...x,
        costo_unitario_mxn_efectivo,
        tc_venta: v.tcVenta,
        costo_total: v.costo.total,
        costo_moneda: v.costo.moneda,
        costo_total_mxn: v.costo.total_mxn,
        venta_total_mxn: v.ventaTotalMxn,
        ...(v.gananciaMxn != null ? { ganancia_mxn: v.gananciaMxn } : {}),
        // Respaldo sin T.C. (compat 0.0.35): utilidad en dólares.
        ...(v.gananciaUsd != null ? { ganancia_usd: v.gananciaUsd } : {}),
        ganancia_usd_original: v.gananciaUsdOriginal,
      };
    });
    return { ...item, ...stats, regla_costo: REGLA_COSTO, movimientos };
  }

  /**
   * FICHA DEL PRODUCTO (pedido del cliente 4-sep-2026, réplica de su Excel;
   * simplificada el 25-sep-2026: «Solo necesitamos el apartado de Compras |
   * Ventas | Resumen de ventas»): bloques COMPRAS | VENTAS (bloquesCardexDe
   * — los MISMOS del cardex formato libro en Excel), RESUMEN por día
   * (resumenDiarioDe), totales (agregadosDeItem — el mismo número que el
   * listado y que la hoja "inventario" del Balance general), el precio
   * vigente (último precio de compra y a cuánto se cobra la siguiente
   * salida) y `dinero_generado` (lo vendido y la utilidad del producto, que
   * el panel pinta TAL CUAL — no suma nada). Todo en PESOS: compras al T.C.
   * oficial de su día, ventas al del día de la venta. `desde`/`hasta`
   * (YYYY-MM-DD, día Cancún) acotan qué filas se listan y qué suma;
   * existencia y precio vigente miran SIEMPRE todo el cardex. Ligas a la
   * compra (compra_linea) y al gasto del avión (gasto.inventario_movimiento_id;
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
      ubicacion?: string | null;
      ubicacion_id?: string | null;
      ubicacion_nombre?: string | null;
      ubicacion_legado?: string | null;
    };
    const [movs, margen, tcHoy] = await Promise.all([
      this.movsCardexCompleto(itemId),
      this.margenVentaPct(),
      this.tcHoy(),
    ]);
    const hoy = hoyCancun();
    const enPeriodo = filtroPeriodo(q.desde, q.hasta);
    const { compras, ventas, totales } = bloquesCardexDe(
      item.nombre,
      movs,
      enPeriodo,
      { hoy },
    );
    const resumen_diario = resumenDiarioDe(movs, enPeriodo);
    const stats = statsDe(movs, { hoy, tcHoy: tcHoy?.tc ?? null });
    const idsDe = (rows: Array<{ movimiento_id: string | null }>) =>
      rows
        .map((r) => r.movimiento_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const [compraPorMov, gastoPorMov] = await Promise.all([
      this.compraIdPorMovimiento(idsDe(compras)),
      this.gastoIdPorMovimiento(idsDe(ventas)),
    ]);
    // Precio vigente y a cuánto se cobraría la siguiente salida SIN precio
    // capturado (la MISMA precedencia de createMovimiento: precio del
    // producto → último precio + margen → a costo).
    const vig = stats.costo_vigente;
    const siguiente = vig
      ? precioVentaDeSalida({
          itemPrecio: item.precio_venta ?? null,
          itemMoneda: item.precio_venta_moneda ?? null,
          costoUnitario: vig.unitario,
          monedaSalida: vig.moneda,
          margenPct: margen,
        })
      : null;
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
        // ADITIVOS (25-sep-2026): ubicación a mostrar y, con la migración
        // del catálogo, sus llaves (findItem ya las trae resueltas).
        ubicacion: item.ubicacion ?? null,
        ...('ubicacion_id' in item
          ? {
              ubicacion_id: item.ubicacion_id ?? null,
              ubicacion_nombre: item.ubicacion_nombre ?? null,
              ubicacion_legado: item.ubicacion_legado ?? null,
            }
          : {}),
      },
      // ADITIVO (0.0.36): el panel quita la palabra «FIFO» con ella.
      regla_costo: REGLA_COSTO,
      // Margen vigente de la tienda (textos de la ficha).
      margen_venta_pct: margen,
      moneda: 'MXN' as const,
      periodo:
        q.desde || q.hasta
          ? { desde: q.desde ?? null, hasta: q.hasta ?? null }
          : null,
      // ADITIVO (0.0.36): T.C. oficial de hoy (el del valorizado); null = sin dato.
      tc_hoy: tcHoy,
      // ADITIVO (0.0.36): último precio de compra (null = ninguna compra con costo).
      precio_vigente: vig
        ? {
            ...vig,
            unitario_mxn_hoy: stats.costo_vigente_mxn,
            siguiente_salida: {
              venta_unitaria: siguiente?.ventaUnitaria ?? null,
              moneda: siguiente?.ventaMoneda ?? null,
              origen: siguiente?.origen ?? 'A_COSTO',
            },
          }
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
        // La parte del valorizado que está en dólares SIN TC (solo si no hay
        // T.C. oficial de hoy) no entra a `valor_costo_mxn` (invariante 8);
        // viaja aparte para que el panel la pinte en su moneda.
        valor_costo_usd:
          stats.valor_usd_sin_tc !== 0 ? stats.valor_usd_sin_tc : null,
        valor_sin_tc: !stats.pesos_exactos,
      },
      // ADITIVO (0.0.36): «Dinero generado por este producto» — lo arma el
      // API desde agregadosDeItem (el panel NO suma). Pesos al T.C. del día
      // de cada venta; el USD original, dato secundario.
      dinero_generado: {
        vendido_mxn: totales.ventas_mxn,
        costo_mxn: totales.costo_ventas_mxn,
        utilidad_mxn: totales.utilidad_mxn,
        vendido_usd_original: totales.ventas_usd_original,
        utilidad_usd_original: totales.utilidad_usd_original,
        unidades_vendidas: totales.unidades_vendidas ?? 0,
        cargado_a_costo_mxn: totales.ventas_a_costo_mxn,
        unidades_a_costo: totales.salidas_a_costo_cant ?? 0,
        ventas_sin_utilidad: totales.ventas_sin_utilidad,
        utilidad_usd_sin_tc: totales.utilidad_usd,
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
   * los bloques y el Excel formato libro). Pagina hasta cubrir `count`:
   * existencia y precio vigente necesitan TODO el historial y una respuesta
   * cortada por el tope de PostgREST daría stock y costos falsos en silencio.
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
    // Ubicación (25-sep-2026): catálogo (`ubicacion_id`) o texto legado; sin
    // la migración, el texto de siempre con «Bodega Cancún» por default.
    const ubicacion = await this.ubicacionDeAlta(dto);
    const conCatalogo = await this.ubicacionDisponible();
    const cols = this.itemCols(conCatalogo);

    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .insert({
        nombre: dto.nombre,
        marca: dto.marca || null,
        numero_parte: dto.numero_parte,
        codigo,
        categoria: dto.categoria,
        stock_minimo: dto.stock_minimo ?? 0,
        ...ubicacion,
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
      .select(cols)
      .maybeSingle();
    if (error) throw this.errorDeCodigo(error, codigo);
    const item = this.conUbicacion(
      data as unknown as Record<string, unknown> & { id: string },
      conCatalogo,
    );
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
    // Con `ubicacion_id` el texto se ignora (no se valida); sin él, un texto
    // vacío sigue siendo 400 (clientes viejos ya lo omiten).
    if (
      dto.ubicacion_id === undefined &&
      dto.ubicacion !== undefined &&
      !textoNoVacio(dto.ubicacion)
    )
      throw new BadRequestException('La ubicación no puede ir vacía.');
    const cambios: Record<string, unknown> = { ...dto, updated_by: userId };
    if (dto.nombre !== undefined) cambios.nombre = dto.nombre.trim();
    if (dto.categoria !== undefined) cambios.categoria = dto.categoria.trim();
    // Ubicación (25-sep-2026): catálogo o texto legado (ubicacionDeEdicion).
    delete cambios.ubicacion;
    delete cambios.ubicacion_id;
    Object.assign(cambios, await this.ubicacionDeEdicion(id, dto));
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

    const conCatalogo = await this.ubicacionDisponible();
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .update(cambios)
      .eq('id', id)
      .select(this.itemCols(conCatalogo))
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
      ...this.conUbicacion(
        data as unknown as Record<string, unknown>,
        conCatalogo,
      ),
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
      ...item,
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
    const conCatalogo = await this.ubicacionDisponible();
    const { data, error } = await this.supabase.service
      .from('inventario_item')
      .update({
        activo: false,
        codigo: null,
        ...(notas !== undefined ? { notas } : {}),
        updated_by: userId,
      })
      .eq('id', id)
      .select(this.itemCols(conCatalogo))
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Ítem ${id} not found`);
    return {
      ...this.conUbicacion(
        data as unknown as Record<string, unknown>,
        conCatalogo,
      ),
      empaques: await this.listEmpaques(id),
    };
  }

  // ===== Movimientos (cardex) =====

  /**
   * Resuelve el costo de un movimiento que SUMA existencia (ENTRADA /
   * DEVOLUCION / AJUSTE) según la moneda de captura, con su T.C. FUENTE
   * ÚNICA: la usan createMovimiento y updateCostoEntrada — no duplicar el
   * criterio.
   *
   * T.C. (25-sep-2026, API 0.0.36 — «que sea los mismos que usan en las
   * cotizaciones»): el capturado (> 0) gana; si no viene, en USD se conserva
   * el de la fila (`tcFila`, solo al corregir un costo) y si tampoco, el
   * T.C. OFICIAL del día del movimiento (`tcOficialDe(fecha)`, la función del
   * cotizador); en MXN el oficial de su fecha, y sin ninguno ⇒ 400. Todo T.C.
   * que se escribe pasa por redondearA(tc, 4) (la precisión de la columna):
   * lo persistido es lo que se usó para derivar el USD interno.
   */
  private async resolverCostoEntrada(
    dto: {
      moneda?: 'MXN' | 'USD';
      costo_unitario_usd?: number;
      costo_unitario_mxn?: number;
      tc_usd_mxn?: number;
    },
    fecha: string,
    tcFila: number | null = null,
  ): Promise<{
    costoUnitario: number;
    moneda: 'MXN' | 'USD';
    costoMxn: number | null;
    tc: number | null;
  }> {
    const moneda: 'MXN' | 'USD' = dto.moneda ?? 'USD';
    const tcCapturado =
      Number(dto.tc_usd_mxn) > 0 ? redondearA(Number(dto.tc_usd_mxn), 4) : null;
    if (moneda === 'MXN') {
      if (dto.costo_unitario_mxn == null) {
        throw new BadRequestException(
          'Captura en MXN: se requiere costo_unitario_mxn (el tipo de cambio es opcional: vacío = T.C. oficial del día de la compra).',
        );
      }
      const tc = tcCapturado ?? (await this.tcOficialDe(fecha))?.tc ?? null;
      if (tc == null) {
        throw new BadRequestException(
          'Captura en MXN: se requieren costo_unitario_mxn y tc_usd_mxn (tipo de cambio de la compra). No hay T.C. oficial para esa fecha: captúralo a mano.',
        );
      }
      const costoMxn = dto.costo_unitario_mxn;
      return { costoUnitario: round(costoMxn / tc, 4), moneda, costoMxn, tc };
    }
    if (dto.costo_unitario_usd == null) {
      throw new BadRequestException(
        'costo_unitario_usd es requerido para ENTRADA, DEVOLUCION y AJUSTE.',
      );
    }
    const deFila = tcFila != null && tcFila > 0 ? redondearA(tcFila, 4) : null;
    const tc =
      tcCapturado ?? deFila ?? (await this.tcOficialDe(fecha))?.tc ?? null;
    return {
      costoUnitario: dto.costo_unitario_usd,
      moneda,
      costoMxn: null,
      tc,
    };
  }

  // ===== Idempotencia del cardex (10-sep-2026, B2) =====
  // Columna OPCIONAL `client_request_id` (migración 20260910000002): mientras
  // no exista, no hay pre-check ni columna en el insert (alta de siempre, sin
  // idempotencia). Se activa sola en ≤ 10 min tras aplicarla.
  private conClientRequestMovimiento(): Promise<boolean> {
    return columnaOpcional(
      this.supabase.service,
      'inventario_movimiento',
      'client_request_id',
      {
        mensajeAusente:
          'Columna inventario_movimiento.client_request_id no existe todavía: movimientos de cardex sin idempotencia hasta aplicar la migración 20260910000002',
      },
    ).disponible();
  }

  /**
   * Movimiento ya creado con esa llave EN ESE PRODUCTO (o null). Acotado al
   * ítem: una llave reutilizada en otro producto nunca devuelve un
   * movimiento ajeno (el insert choca en 23505 → 409 CLIENT_REQUEST_ID_EN_USO).
   */
  private async movimientoPorClientRequest(
    itemId: string,
    key: string,
  ): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(
        `${MOV_COLS}, para_flota, client_request_id, empaque:inventario_item_empaque!empaque_id(nombre, factor)`,
      )
      .eq('client_request_id', key)
      .eq('item_id', itemId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  }

  /**
   * Replay del alta (reintento del outbox con la misma llave): la MISMA
   * forma de respuesta que un alta fresca — movimiento + `gasto_generado`
   * (el/los gastos BODEGA ya ligados por `gasto.inventario_movimiento_id`,
   * invariante 8) + stock/valor actuales — sin volver a mover stock ni
   * dinero, y sin re-validar (el stock ya bajó con el primer intento).
   */
  private async movimientoIdempotente(
    fila: Record<string, unknown>,
    key: string,
  ) {
    this.logger.log(
      `Movimiento de cardex idempotente: reintento con client_request_id ${key} → se devuelve el existente ${String(fila.id)} (sin duplicar stock ni gasto).`,
    );
    const { data: gastos, error: gErr } = await this.supabase.service
      .from('gasto')
      .select('id, monto, moneda, categoria')
      .eq('inventario_movimiento_id', fila.id as string)
      .order('created_at', { ascending: true });
    if (gErr) throw new Error(gErr.message);
    const ligados = (gastos ?? []) as Array<Record<string, unknown>>;
    let gastoGenerado: Record<string, unknown> | null = null;
    if (fila.para_flota === true) {
      if (ligados.length > 0) {
        gastoGenerado = {
          prorrateado: true,
          aviones: ligados.length,
          monto_total: round(
            ligados.reduce((s, g) => s + Number(g.monto ?? 0), 0),
            2,
          ),
          gastos: ligados.length,
        };
      }
    } else {
      gastoGenerado = ligados[0] ?? null;
    }
    const stats = statsDe(await this.movsForItem(fila.item_id as string), {
      hoy: hoyCancun(),
      tcHoy: null,
    });
    const empaqueRaw = fila.empaque;
    const empaque = (
      Array.isArray(empaqueRaw) ? (empaqueRaw[0] ?? null) : empaqueRaw
    ) as { nombre?: string; factor?: number | string } | null;
    const mov: Record<string, unknown> = { ...fila };
    delete mov.empaque;
    delete mov.para_flota;
    return {
      ...mov,
      empaque: empaque
        ? { nombre: empaque.nombre, factor: Number(empaque.factor) }
        : null,
      stock_resultante: stats.stock,
      valor_usd: stats.valor_usd,
      gasto_generado: gastoGenerado,
      reversion_pendiente: null as ReversionPendiente | null,
      // El replay NO recalcula nada (el precio ya viajó al gasto).
      venta_origen: null as OrigenVenta | null,
      margen_pct: null as number | null,
      costo_vigente: null as CostoVigente | null,
      tc_venta:
        fila.tipo === (TipoMovimientoInventario.SALIDA as string) &&
        Number(fila.tc_usd_mxn) > 0
          ? Number(fila.tc_usd_mxn)
          : null,
      aviso: null as string | null,
      aviso_mensaje: null as string | null,
      regla_costo: REGLA_COSTO,
      client_request_id: key,
      idempotente: true as const,
    };
  }

  async createMovimiento(
    itemId: string,
    dto: CreateMovimientoDto,
    userId: string,
  ) {
    // Idempotencia (B2): pre-check por llave ANTES de cualquier validación —
    // un replay no debe re-validar (el stock ya bajó con el primer intento)
    // ni volver a generar el gasto BODEGA.
    const key =
      dto.client_request_id && (await this.conClientRequestMovimiento())
        ? dto.client_request_id
        : null;
    if (key) {
      const ya = await this.movimientoPorClientRequest(itemId, key);
      if (ya) return this.movimientoIdempotente(ya, key);
      // La oficina ELIMINÓ ese movimiento (21-sep-2026): un reintento del
      // outbox no lo resucita. 409 con `code` estable para que la app
      // descarte el pendiente en vez de reintentar para siempre.
      const eliminado = await this.eliminadoPorClientRequest(key);
      if (eliminado) {
        throw new ConflictException({
          message: `La oficina eliminó este movimiento${eliminado.eliminado_por_nombre ? ` (${eliminado.eliminado_por_nombre})` : ''}: «${eliminado.motivo}». Si hace falta, captúralo de nuevo desde cero.`,
          error: 'MOVIMIENTO_ELIMINADO',
          details: { client_request_id: key, motivo: eliminado.motivo },
        });
      }
    }
    const item = (await this.findItem(itemId)) as {
      nombre: string;
      precio_venta?: number | string | null;
      precio_venta_moneda?: 'MXN' | 'USD' | null;
    }; // 404 si no existe

    // Captura POR EMPAQUE (caja): la cantidad del cardex SIEMPRE va en
    // UNIDADES = cantidad_empaques × factor (fuente única de la existencia y
    // del gasto de bodega, que no cambian); el empaque y el nº de cajas se
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

    // Día Cancún del movimiento (el insert conserva lo que mandó el
    // cliente; para el costo vigente y el T.C. basta el día).
    const fechaDia = String(dto.fecha_movimiento ?? hoyCancun()).slice(0, 10);
    let costoUnitario: number;
    // Captura en PESOS (default operativo del cliente) o en USD (compras tipo
    // Aircraft Spruce). La moneda CANÓNICA interna sigue siendo USD
    // (`costo_unitario_usd`, el del reparto); los pesos de una captura MXN
    // son nativos.
    let moneda: 'MXN' | 'USD' = dto.moneda ?? 'USD';
    let costoMxn: number | null = null;
    let tc: number | null = null;
    // VENTA (decisión del cliente 29-ago-2026): en SALIDA el avión paga el
    // PRECIO DE VENTA (el capturado en la salida, o el del ítem como default).
    // Un 0 explícito en venta_unitaria = "esta salida va a costo".
    // TIENDA VuelaTour (decisión del cliente 25-sep-2026): SIN precio, el
    // avión paga el ÚLTIMO PRECIO DE COMPRA + margen de la tienda
    // (`inventario_margen_venta_pct`, 25 %), en la MISMA moneda de esa compra
    // — fuente única precioVentaDeSalida.
    let ventaUnitaria: number | null = null;
    let ventaMoneda: 'MXN' | 'USD' | null = null;
    let ventaOrigen: OrigenVenta | null = null;
    let margenAplicado: number | null = null;
    // ADITIVOS de la respuesta (0.0.36).
    let costoVigente: CostoVigente | null = null;
    let aviso: string | null = null;

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
      const movsItem = await this.movsForItem(itemId);
      // Existencia: todo el cardex (textos de siempre). El stock sale del
      // cardex, no del alta del ítem (caso 6 ago 2026).
      const disponible = existenciaDe(movsItem);
      if (disponible + EPS < cantidad) {
        throw new BadRequestException(
          disponible <= EPS
            ? 'Este ítem no tiene existencia registrada: captura primero una ENTRADA con la cantidad y su costo (aunque la pieza ya esté en bodega). El stock sale del cardex, no del alta del ítem.'
            : `Stock insuficiente: disponible ${round(disponible)}, salida solicitada ${cantidad}.`,
        );
      }
      // COSTO = ÚLTIMO PRECIO DE COMPRA vigente el día de la salida (25-sep-
      // 2026). Se GUARDA en la fila: nada posterior lo mueve (D1-bis).
      costoVigente = costoVigenteEn(movsItem, { fecha: fechaDia });
      if (!costoVigente) {
        // Hay compras con costo, pero todas con fecha POSTERIOR a la salida:
        // cobrarla a $0 en silencio sería un error de captura (400 claro).
        const primera = sortChrono(movsItem.filter(fijaPrecio))[0];
        if (primera) {
          throw new BadRequestException({
            message: textoSalidaAntesDeLaCompra(
              fechaDia,
              primera.fecha_movimiento,
            ),
            error: 'SALIDA_ANTES_DE_LA_COMPRA',
            details: {
              fecha_salida: fechaDia,
              fecha_primera_compra: primera.fecha_movimiento,
            },
          });
        }
        // Solo entradas a $0 (carga sin costo): a costo $0, sin gasto, como
        // siempre — y se AVISA.
        aviso = 'SIN_COSTO_VIGENTE';
      }
      costoUnitario = costoVigente?.unitario_usd ?? 0;
      moneda = costoVigente?.moneda ?? 'USD';
      costoMxn =
        costoVigente?.moneda === 'MXN' ? costoVigente.unitario_mxn : null;
      // T.C. del DÍA DE LA VENTA (el mismo de las cotizaciones): convierte
      // venta Y costo de esta salida y es el `tc_gasto` del cargo al avión.
      // Se SELLA al escribir; null si no hay dato (queda «sin T.C.»).
      tc = (await this.tcOficialDe(fechaDia))?.tc ?? null;
      // Precio de venta efectivo (fuente única precioVentaDeSalida): el del
      // DTO (> 0) gana; sin campo en el DTO se hereda el del ítem; sin
      // ninguno, último precio + margen de la tienda en la moneda de la
      // compra. La moneda del DTO acompaña a SU precio; la del ítem al suyo
      // (jamás cruzar precio de una fuente con moneda de otra).
      const margen = await this.margenVentaPct();
      const precio = precioVentaDeSalida({
        dtoVenta: dto.venta_unitaria ?? null,
        dtoMoneda: dto.venta_moneda ?? null,
        itemPrecio: item.precio_venta ?? null,
        itemMoneda: item.precio_venta_moneda ?? null,
        costoUnitario: costoVigente?.unitario ?? 0,
        monedaSalida: moneda,
        margenPct: margen,
      });
      ventaUnitaria = precio.ventaUnitaria;
      ventaMoneda = precio.ventaMoneda;
      ventaOrigen = precio.origen;
      margenAplicado = precio.origen === 'MARGEN' ? margen : null;
    } else {
      const costo = await this.resolverCostoEntrada(dto, fechaDia);
      costoUnitario = costo.costoUnitario;
      moneda = costo.moneda;
      costoMxn = costo.costoMxn;
      tc = costo.tc;
    }

    // Salida "para todas las matrículas": lo que REALMENTE se va a insertar
    // (la bandera solo aplica a SALIDA). Se resuelve aquí porque el manejo
    // del 23514 de abajo depende de ella.
    const salidaDeFlota =
      dto.tipo === TipoMovimientoInventario.SALIDA && dto.para_flota === true;

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
        // aquí (montoGastoDeSalida); null = la salida se cargó a costo.
        venta_unitaria: ventaUnitaria,
        venta_moneda: ventaUnitaria != null ? ventaMoneda : null,
        para_flota: salidaDeFlota,
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
        // Llave SOLO cuando viaja y la columna existe (insert de siempre si no).
        ...(key ? { client_request_id: key } : {}),
      })
      .select(MOV_COLS)
      .maybeSingle();
    if (error) {
      // Carrera con la misma llave (dos flushes del outbox): el primero ya
      // movió el stock y generó su gasto → se devuelve ese.
      if (
        error.code === '23505' &&
        key &&
        error.message.includes(UQ_INV_MOVIMIENTO_CLIENT_REQUEST)
      ) {
        const ya = await this.movimientoPorClientRequest(itemId, key);
        if (ya) return this.movimientoIdempotente(ya, key);
        // La llave pertenece a un movimiento de OTRO producto: ni la fila
        // ajena ni un 500 (el outbox lo reintentaría para siempre).
        throw clientRequestIdEnUso('movimiento', key);
      }
      if (error.code === '23503')
        throw new BadRequestException(
          `Referencia no encontrada: ${error.message}`,
        );
      // CHECK de la tabla (23514). Hasta el 22-sep-2026 esto era un 500 que
      // el filtro traducía al genérico «Alguno de los valores capturados no
      // es válido…»: el operador no tenía forma de saber QUÉ pasaba.
      if (error.code === '23514') {
        const constraint = nombreDeConstraint(error.message);
        // La salida "para todas las matrículas" va sin avión y el CHECK
        // original (`20260515000004`) exige avión en TODA salida: mientras
        // no se aplique `20260922000003` no hay nada que corregir en la
        // captura — es la BASE la que falta. 503 (no 400): no es culpa del
        // dato y el outbox de la app puede reintentarlo más tarde.
        // Si quien rechazó es uno de los checks que TRAE esa migración, la
        // migración SÍ está aplicada y el problema es el dato: 400, nunca un
        // 503 que mande a aplicar algo que ya existe.
        if (salidaDeFlota && !CHECKS_SALIDA_FLOTA.includes(constraint ?? '')) {
          this.logger.error(
            `Salida de bodega para toda la flota rechazada por la base: falta aplicar la migración ${MIGRACION_SALIDA_FLOTA} (${error.message}). No se escribió nada.`,
          );
          throw new ServiceUnavailableException({
            message: `La salida para toda la flota todavía no está disponible en la base: falta aplicar la migración ${MIGRACION_SALIDA_FLOTA}. Mientras tanto, captura la salida por avión (una por matrícula). No se guardó nada.`,
            error: 'MIGRACION_PENDIENTE',
            details: { migracion: MIGRACION_SALIDA_FLOTA, constraint },
          });
        }
        throw new BadRequestException({
          message:
            'Alguno de los valores del movimiento no cumple una regla de la base (por ejemplo cantidad o costo en cero, o una salida sin destino). Revisa los campos e intenta de nuevo.',
          error: 'MOVIMIENTO_INVALIDO',
          details: { constraint, tecnico: error.message },
        });
      }
      throw new Error(error.message);
    }

    // Puente inventario → gastos (diseño 5.6): "el cargo al avión ocurre al
    // sacar la pieza de bodega". La SALIDA genera el gasto REFACCION con su
    // precio (o su costo) para que llegue al reporte mensual del avión y al
    // reparto.
    // La DEVOLUCION con avión revierte ese cargo.
    let gastoGenerado: Record<string, unknown> | null = null;
    // Resto de una DEVOLUCION que no se pudo revertir (null = todo revertido):
    // viaja como `reversion_pendiente` para que el dinero no se pierda en
    // silencio (la UI puede ignorarlo; el warn en el log se conserva).
    let reversionPendiente: ReversionPendiente | null = null;
    // Cómo se cobró la salida (notas del gasto): precio, costo + margen o costo.
    const etiquetaCargo = etiquetaCargoDeSalida(ventaOrigen, margenAplicado);
    if (salidaDeFlota) {
      gastoGenerado = await this.crearGastosDeSalidaFlota(
        data as Record<string, unknown>,
        item.nombre,
        userId,
        presentacion,
        etiquetaCargo,
      );
    } else if (dto.tipo === TipoMovimientoInventario.SALIDA) {
      gastoGenerado = await this.crearGastoDeSalida(
        data as Record<string, unknown>,
        item.nombre,
        userId,
        presentacion,
        etiquetaCargo,
      );
    } else if (
      dto.tipo === TipoMovimientoInventario.DEVOLUCION &&
      dto.aeronave_id
    ) {
      // Usar el costo USD ya resuelto arriba: en captura MXN el dto no trae
      // costo_unitario_usd y la reversión quedaría en 0 en silencio. El T.C.
      // de respaldo es el RESUELTO (capturado u oficial), no el del DTO.
      reversionPendiente = await this.revertirGastoPorDevolucion(
        itemId,
        d,
        costoUnitario,
        item.nombre,
        userId,
        tc,
      );
    }

    // Solo existencia y USD interno: no hace falta el T.C. de hoy.
    const stats = statsDe(await this.movsForItem(itemId), {
      hoy: hoyCancun(),
      tcHoy: null,
    });
    return {
      ...data,
      empaque: empaque
        ? { nombre: empaque.nombre, factor: empaque.factor }
        : null,
      stock_resultante: stats.stock,
      valor_usd: stats.valor_usd,
      gasto_generado: gastoGenerado,
      reversion_pendiente: reversionPendiente,
      // ADITIVOS (25-sep-2026): de dónde salió el precio que paga el avión
      // (null fuera de SALIDA) y el margen aplicado (solo MARGEN).
      venta_origen: ventaOrigen,
      margen_pct: margenAplicado,
      // ADITIVOS (0.0.36): el último precio de compra con que se costeó la
      // SALIDA (null fuera de SALIDA), el T.C. del día de la venta sellado en
      // la fila y el aviso de una salida sin ninguna compra con costo.
      costo_vigente: costoVigente,
      tc_venta: dto.tipo === TipoMovimientoInventario.SALIDA ? tc : null,
      aviso,
      // Con precio (capturado o del producto) el avión SÍ pagó: el texto
      // «sin cargo al avión» sería falso — se dice que la venta entera
      // cuenta como utilidad.
      aviso_mensaje:
        aviso === 'SIN_COSTO_VIGENTE'
          ? ventaOrigen === 'PRECIO_CAPTURADO' ||
            ventaOrigen === 'PRECIO_PRODUCTO'
            ? TEXTOS_INVENTARIO.sinCostoVigenteConVenta
            : TEXTOS_INVENTARIO.sinCostoVigente
          : null,
      regla_costo: REGLA_COSTO,
      // Aditivo (10-sep-2026): la app deduplica su pendiente local con la
      // llave; null cuando no viajó o la columna aún no existe.
      client_request_id: key,
      idempotente: false as const,
    };
  }

  /**
   * Corrige el COSTO de una ENTRADA de cardex (caso carga masiva
   * [CARGA-INV-AGO29]: 63 entradas a $0 que el cliente completa con el
   * precio real). SOLO costo/moneda/TC — cantidad, fecha y tipo jamás.
   *
   * Regla de costo del 25-sep-2026 (API 0.0.36): el costo de cada SALIDA
   * está GUARDADO en su fila, así que corregir el precio de una compra solo
   * cambia el VALORIZADO y el precio de las SIGUIENTES salidas — ninguna
   * salida ya cobrada se mueve. Candados:
   *  - la entrada que nace de una COMPRA se corrige desde la compra (ahí se
   *    prorratean envío/impuestos);
   *  - RECONOCIMIENTO (D7): si alguna salida ya usó (o habría usado) este
   *    precio — `salidasQueDependenDe` —, sin `confirmar_salidas: true`
   *    responde 409 ENTRADA_CON_SALIDAS con la lista y NO escribe nada.
   *    Ningún cliente (panel viejo, script) cambia el precio de una compra
   *    usada sin ver qué salidas conservan su cargo — y cuáles salieron SIN
   *    cargo ($0), que completar el costo NO cobra. Re-costear una salida mal
   *    cobrada = eliminarla (baja con motivo) y volver a capturarla.
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
      throw new BadRequestException(TEXTOS_INVENTARIO.soloEntrada);
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

    // (iii) Candado de RECONOCIMIENTO: las salidas que se cobraron con este
    // precio CONSERVAN su costo (está en su fila); el operador lo confirma.
    const movs = await this.movsCardexCompleto(itemId);
    if (!movs.some((m) => m.id === movId)) {
      throw new NotFoundException(
        `Movimiento ${movId} no encontrado en el cardex del ítem`,
      );
    }
    const deps = salidasQueDependenDe(movs, movId);
    if (deps.length > 0 && dto.confirmar_salidas !== true) {
      const sinCargo = deps.filter((d) => d.sin_cargo).length;
      throw new ConflictException({
        message: textoEntradaConSalidas(deps.length, sinCargo),
        error: 'ENTRADA_CON_SALIDAS',
        details: { salidas: deps },
      });
    }

    // (iv) Costo nuevo con el MISMO criterio de createMovimiento. USD sin
    // T.C. en el DTO conserva el de la fila (o el oficial de su fecha).
    const tcFila = Number(actual.tc_usd_mxn);
    const costo = await this.resolverCostoEntrada(
      dto,
      textoDe(actual.fecha_movimiento, hoyCancun()).slice(0, 10),
      Number.isFinite(tcFila) && tcFila > 0 ? tcFila : null,
    );

    // (v) Bitácora en las notas: el costo anterior no se pierde en silencio.
    const enMxnAntes =
      actual.moneda === 'MXN' && actual.costo_unitario_mxn != null;
    const montoAntes = round(
      Number(
        enMxnAntes ? actual.costo_unitario_mxn : actual.costo_unitario_usd,
      ),
      4,
    );
    // precioTxt: 2 a 4 decimales y siempre con moneda («$21.50 USD», nunca
    // «$21.5 USD»).
    const notaCorreccion = `Costo corregido ${hoyCancun()}: antes ${precioTxt(montoAntes, enMxnAntes ? 'MXN' : 'USD')}`;
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

    // (vi) Stats recalculadas: valorizado al último precio con el T.C. de hoy.
    const stats = await this.statsConTcHoy(await this.movsForItem(itemId));
    return {
      ...(updated as Record<string, unknown>),
      stock_resultante: stats.stock,
      valor_usd: stats.valor_usd,
      valor_mxn: stats.valor_mxn,
      // ADITIVOS (22-sep-2026): `valor_mxn` solo trae pesos reales; la parte
      // en dólares sin TC viaja aparte.
      valor_usd_sin_tc: stats.valor_usd_sin_tc,
      pesos_exactos: stats.pesos_exactos,
      // ADITIVOS (0.0.36): las salidas que CONSERVAN su costo, el precio
      // vigente que queda y el T.C. del valorizado.
      salidas_conservan_costo: deps,
      costo_vigente: stats.costo_vigente,
      costo_vigente_mxn: stats.costo_vigente_mxn,
      tc_hoy: stats.tc_hoy,
      regla_costo: REGLA_COSTO,
    };
  }

  // ===== Baja de un movimiento de cardex (21-sep-2026) =====
  //
  // Pedido del cliente: «podemos agregar una opcion para eliminar algunos
  // movimientos, pero que al momento de eliminarlos pida justificacion y
  // sepamos quien lo hizo» (captura del cardex del aceite 15W-50 con tres
  // movimientos capturados por error el 29-ago).
  //
  // El cardex era APPEND-ONLY porque la existencia NO se guarda: se deriva
  // de él cada vez. Por eso la baja tiene TRES capas:
  //   1. `evaluarEliminacion` (helper puro, con specs): simula la existencia
  //      sin el movimiento y bloquea si quedaría negativa. Desde el API
  //      0.0.36 el costo de cada salida está GUARDADO en su fila (último
  //      precio de compra), así que ya no hay candado de costo: se informa
  //      si cambia el PRECIO VIGENTE (valorizado y siguiente salida).
  //   2. Este servicio: candados de DINERO (compra ligada, gasto conciliado /
  //      facturado / con cargo bancario) y 409 con `code` estable.
  //   3. La función de BD `inventario_eliminar_movimiento` (migración
  //      20260921000001): auditoría + gastos + movimiento en UNA transacción.
  //      Sin ella la baja responde 503 — nunca un borrado a medias por pasos
  //      sueltos desde aquí.

  /** Movimiento del ítem con sus joins, o 404. */
  private async movimientoDeItem(
    itemId: string,
    movId: string,
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.supabase.service
      .from('inventario_movimiento')
      .select(`${MOV_COLS}, para_flota, ${MOV_JOINS}`)
      .eq('id', movId)
      .eq('item_id', itemId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException(
        `Movimiento ${movId} no encontrado en este ítem`,
      );
    }
    return data;
  }

  /** Cardex COMPLETO del ítem en la forma que pide `evaluarEliminacion`. */
  private async movsEliminablesDeItem(
    itemId: string,
  ): Promise<MovEliminable[]> {
    const movs = await this.movsCardexCompleto(itemId);
    return movs.map((m) => ({
      ...m,
      id: String(m.id),
      aeronave_matricula: nombreDeJoin(m.aeronave, 'matricula'),
      para_flota: m.para_flota ?? false,
    }));
  }

  /** Compra de la que nace el movimiento (null = captura manual). */
  private async compraDeMovimiento(
    movId: string,
  ): Promise<{ folio: number | null } | null> {
    const { data, error } = await this.supabase.service
      .from('compra_linea')
      .select('id, compra:compra!compra_id(folio)')
      .eq('inventario_movimiento_id', movId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const raw = (data as Record<string, unknown>).compra;
    const compra = (Array.isArray(raw) ? (raw[0] ?? null) : raw) as {
      folio?: number;
    } | null;
    return { folio: compra?.folio ?? null };
  }

  /**
   * Gastos ligados al movimiento con su veredicto: `bloqueado` = borrarlo
   * tocaría dinero ya cerrado (conciliado con el banco, con cargo bancario
   * ligado —conciliación PARCIAL, 14-sep—, facturado) o el gasto ya no es de
   * bodega (alguien lo cambió en Gastos y la FK `set null` lo dejaría
   * huérfano en silencio).
   */
  private async gastosDeMovimiento(movId: string): Promise<GastoLigado[]> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(
        'id, monto, moneda, categoria, medio_pago, conciliado, factura_recibida_id, estatus_facturacion, fecha_gasto, aeronave_id, compra_id, aeronave:aeronave!aeronave_id(matricula)',
      )
      .eq('inventario_movimiento_id', movId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as Array<Record<string, unknown>>;
    if (filas.length === 0) return [];

    // Cargos bancarios y facturas recibidas ligados. Los DOS son FK con
    // `on delete set null`: borrar el gasto no avisa, solo deja el renglón
    // del banco / la factura apuntando a nada. Un gasto con pago PARCIAL no
    // está `conciliado` pero ya tiene banco detrás, y una factura puede
    // apuntar al gasto SIN que `gasto.factura_recibida_id` esté puesto (el
    // amarre no es simétrico — pendiente conocido del repo). Estos MISMOS
    // candados los repite la función de BD: si aquí faltaran, la vista previa
    // diría «se puede» y el DELETE contestaría 409.
    const ids = filas.map((g) => String(g.id));
    const [cargosRes, facturasRes] = await Promise.all([
      this.supabase.service
        .from('movimiento_bancario')
        .select('gasto_id')
        .in('gasto_id', ids),
      this.supabase.service
        .from('factura_recibida')
        .select('gasto_id')
        .in('gasto_id', ids),
    ]);
    if (cargosRes.error) throw new Error(cargosRes.error.message);
    if (facturasRes.error) throw new Error(facturasRes.error.message);
    const idsDeGasto = (rows: unknown) =>
      new Set(
        ((rows ?? []) as Array<{ gasto_id: string | null }>)
          .map((c) => c.gasto_id)
          .filter((id): id is string => !!id),
      );
    const conCargo = idsDeGasto(cargosRes.data);
    const conFactura = idsDeGasto(facturasRes.data);

    return filas.map((g) => {
      const id = textoDe(g.id);
      const esDeBodega =
        textoDe(g.categoria) === 'REFACCION' &&
        textoDe(g.medio_pago) === 'BODEGA';
      const conciliado = g.conciliado === true || conCargo.has(id);
      const facturado =
        g.factura_recibida_id != null ||
        conFactura.has(id) ||
        textoDe(g.estatus_facturacion) === 'FACTURADA';
      const motivo = conciliado
        ? 'Ya está conciliado con el banco: desconcílialo en Conciliación antes de eliminar el movimiento.'
        : facturado
          ? 'Ya tiene factura recibida: desligar la factura en Gastos antes de eliminar el movimiento.'
          : g.compra_id != null
            ? 'Es el pago de una compra: corrígelo desde Compras antes de eliminar el movimiento.'
            : !esDeBodega
              ? 'Este gasto ya no es una REFACCION de bodega (lo cambiaron en Gastos): revísalo ahí antes de eliminar el movimiento.'
              : null;
      return {
        id,
        monto: round(Number(g.monto ?? 0), 2),
        moneda: textoDe(g.moneda, 'MXN'),
        aeronave_matricula: nombreDeJoin(g.aeronave, 'matricula'),
        fecha_gasto: (g.fecha_gasto as string | null) ?? null,
        bloqueado: motivo != null,
        motivo_bloqueo: motivo,
      };
    });
  }

  /**
   * Orden de los candados (el primero que aplique manda): COMPRA (estructural)
   * → TIPO (devolución/ajuste no se borran) → DINERO (gasto cerrado) →
   * CARDEX (stock negativo). El mensaje SIEMPRE dice qué hacer para
   * desbloquearlo.
   */
  private resolverBloqueoEliminacion(
    cardex: EvaluacionEliminacion,
    compra: { folio: number | null } | null,
    gastos: GastoLigado[],
    tipo: string,
  ): { codigo: CodigoBloqueoEliminacion | null; mensaje: string } {
    if (compra) {
      return {
        codigo: 'MOVIMIENTO_DE_COMPRA',
        mensaje: `Esta ${tipo} nace de la compra #${compra.folio ?? '?'}: quítala o corrígela desde Compras (ahí se prorratean envío e impuestos).`,
      };
    }
    if (cardex.codigo_bloqueo === 'TIPO_NO_SOPORTADO') {
      return { codigo: 'TIPO_NO_SOPORTADO', mensaje: cardex.detalle };
    }
    const bloqueado = gastos.find((g) => g.bloqueado);
    if (bloqueado) {
      return {
        codigo: 'GASTO_BLOQUEADO',
        mensaje:
          `El gasto de ${montoTxt(bloqueado.monto)} ${bloqueado.moneda}${bloqueado.aeronave_matricula ? ` de ${bloqueado.aeronave_matricula}` : ''} que generó este movimiento no se puede eliminar. ${bloqueado.motivo_bloqueo ?? ''}`.trim(),
      };
    }
    return { codigo: cardex.codigo_bloqueo, mensaje: cardex.detalle };
  }

  /**
   * VISTA PREVIA de la baja (ADMIN): qué se va a eliminar, cómo queda la
   * existencia y qué gastos se van con el movimiento — o por qué NO se puede
   * y qué hay que hacer primero. Solo LEE: no cambia nada, y funciona aunque
   * la migración 20260921000001 todavía no esté aplicada (el 503 es de la
   * baja, no de la vista previa).
   */
  async previewEliminacionMovimiento(itemId: string, movId: string) {
    const mov = await this.movimientoDeItem(itemId, movId);
    const [compra, gastos, movs] = await Promise.all([
      this.compraDeMovimiento(movId),
      this.gastosDeMovimiento(movId),
      this.movsEliminablesDeItem(itemId),
    ]);
    // Carrera (alguien lo borró entre las dos lecturas): 404, no un 500.
    let cardex: EvaluacionEliminacion;
    try {
      cardex = evaluarEliminacion(movs, movId, hoyCancun());
    } catch {
      throw new NotFoundException(
        `Movimiento ${movId} no encontrado en este ítem`,
      );
    }
    const tipo = String(mov.tipo);
    const { codigo, mensaje } = this.resolverBloqueoEliminacion(
      cardex,
      compra,
      gastos,
      tipo,
    );
    return {
      permitido: codigo == null,
      codigo_bloqueo: codigo,
      mensaje,
      stock_antes: cardex.stock_antes,
      stock_despues: cardex.stock_despues,
      movimiento: {
        tipo,
        cantidad: round(Number(mov.cantidad), 2),
        fecha: mov.fecha_movimiento as string,
        // 'FLOTA' = salida prorrateada entre todos los aviones activos.
        aeronave:
          mov.para_flota === true
            ? 'FLOTA'
            : nombreDeJoin(mov.aeronave, 'matricula'),
      },
      gastos,
      de_compra: compra,
      // ADITIVOS (0.0.36): el último precio de compra hoy, con y sin el
      // movimiento (el diálogo lo dice en su propio renglón), y la lista de
      // salidas afectadas, SIEMPRE vacía (cada salida guarda su costo).
      precio_vigente_antes: cardex.precio_vigente_antes,
      precio_vigente_despues: cardex.precio_vigente_despues,
      cambia_precio_vigente: cardex.cambia_precio_vigente,
      salidas_afectadas: cardex.salidas_afectadas,
      regla_costo: REGLA_COSTO,
    };
  }

  /**
   * BAJA de un movimiento de cardex (SOLO ADMIN, con motivo ≥ 10 caracteres).
   * Re-evalúa TODOS los candados (la vista previa pudo quedar vieja) y delega
   * el borrado a la función de BD, que es atómica: auditoría + gastos
   * BODEGA + movimiento, o nada.
   */
  async eliminarMovimiento(
    itemId: string,
    movId: string,
    motivo: string,
    userId: string,
  ) {
    const item = (await this.findItem(itemId)) as { nombre: string }; // 404
    const previa = await this.previewEliminacionMovimiento(itemId, movId);
    if (!previa.permitido) {
      throw new ConflictException({
        message: previa.mensaje,
        error: previa.codigo_bloqueo,
        details: {
          movimiento_id: movId,
          stock_antes: previa.stock_antes,
          stock_despues: previa.stock_despues,
          gastos: previa.gastos.length,
        },
      });
    }

    const { data, error } = (await this.supabase.service.rpc(
      RPC_ELIMINAR_MOVIMIENTO,
      {
        p_movimiento: movId,
        p_item: itemId,
        p_motivo: motivo,
        p_usuario: userId,
      },
    )) as {
      data: unknown;
      error: { code?: string; message: string; hint?: string | null } | null;
    };
    if (error) {
      // La migración no está aplicada: 503 CLARO. Jamás un borrado por pasos
      // sueltos desde el API (movimiento sin gasto = costo del avión inflado).
      if (esFuncionInexistente(error)) {
        this.logger.error(
          `Baja de movimiento de cardex no disponible: falta aplicar la migración ${MIGRACION_MOVIMIENTO_ELIMINADO} (${error.message}). No se eliminó nada.`,
        );
        throw new ServiceUnavailableException({
          message: `La baja de movimientos de cardex todavía no está disponible en la base: falta aplicar la migración ${MIGRACION_MOVIMIENTO_ELIMINADO}. No se eliminó nada.`,
          error: 'MIGRACION_PENDIENTE',
          details: { migracion: MIGRACION_MOVIMIENTO_ELIMINADO },
        });
      }
      // El código viaja DOS veces desde la función: en el `hint` y como
      // prefijo del mensaje. Se lee primero el hint (dato estructurado) y el
      // mensaje queda de respaldo: si alguien reescribe el texto en es-MX, el
      // `code` del 409 no se convierte en un 500 silencioso.
      const codigo =
        codigoDeErrorEliminacion(error.hint) ??
        codigoDeErrorEliminacion(error.message);
      const mensaje = mensajeDeErrorEliminacion(error.message);
      if (
        codigo === 'MOVIMIENTO_NO_EXISTE' ||
        codigo === 'MOVIMIENTO_DE_OTRO_ITEM'
      ) {
        throw new NotFoundException({ message: mensaje, error: codigo });
      }
      if (codigo === 'MOTIVO_REQUERIDO' || codigo === 'USUARIO_REQUERIDO') {
        throw new BadRequestException({ message: mensaje, error: codigo });
      }
      if (codigo) {
        throw new ConflictException({
          message: mensaje,
          error: codigo,
          details: { movimiento_id: movId },
        });
      }
      throw new Error(error.message);
    }

    const resultado = (data ?? {}) as {
      auditoria_id?: string;
      gastos_eliminados?: number;
    };
    const stats = await this.statsConTcHoy(await this.movsForItem(itemId));
    this.logger.warn(
      `Movimiento de cardex ${movId} (${previa.movimiento.tipo} ${previa.movimiento.cantidad} · ${item.nombre}) ELIMINADO por ${userId}: «${motivo}». ${resultado.gastos_eliminados ?? 0} gasto(s) de bodega borrados; existencia ${previa.stock_antes} → ${stats.stock}. Auditoría ${resultado.auditoria_id ?? '?'}.`,
    );
    void this.avisarMovimientoEliminado(
      itemId,
      item.nombre,
      previa,
      motivo,
      userId,
      resultado.gastos_eliminados ?? 0,
    );

    return {
      ok: true as const,
      auditoria_id: resultado.auditoria_id ?? null,
      gastos_eliminados: resultado.gastos_eliminados ?? 0,
      stock_resultante: stats.stock,
      valor_usd: stats.valor_usd,
      valor_mxn: stats.valor_mxn,
      // ADITIVOS (22-sep-2026): el valorizado que queda, separado por moneda
      // (`valor_mxn` = pesos reales; el resto, en dólares sin TC).
      valor_usd_sin_tc: stats.valor_usd_sin_tc,
      pesos_exactos: stats.pesos_exactos,
      // ADITIVOS (0.0.36): el último precio de compra que queda.
      costo_vigente: stats.costo_vigente,
      costo_vigente_mxn: stats.costo_vigente_mxn,
      regla_costo: REGLA_COSTO,
    };
  }

  /**
   * Aviso in-app a la oficina (ADMIN) — best-effort, NUNCA rompe la baja:
   * quien elimina ya lo sabe (queda excluido), los demás se enteran con el
   * motivo. Sin NotificationsService (specs) no hace nada.
   */
  private async avisarMovimientoEliminado(
    itemId: string,
    itemNombre: string,
    previa: {
      movimiento: { tipo: string; cantidad: number; aeronave: string | null };
      stock_antes: number;
    },
    motivo: string,
    userId: string,
    gastosEliminados: number,
  ): Promise<void> {
    try {
      const destino = previa.movimiento.aeronave
        ? ` (${previa.movimiento.aeronave})`
        : '';
      await this.notifications?.notifyRole(
        Rol.ADMIN,
        {
          tipo: 'alerta_sistema',
          titulo: 'Movimiento de inventario eliminado',
          cuerpo: `${previa.movimiento.tipo} de ${cantidadTxt(previa.movimiento.cantidad)} × ${itemNombre}${destino}${gastosEliminados > 0 ? ` y ${gastosEliminados} gasto(s) de bodega` : ''}. Motivo: ${motivo}`,
          data: {
            item_id: itemId,
            item_nombre: itemNombre,
            motivo,
            gastos_eliminados: gastosEliminados,
          },
          link: `/admin/inventory/${itemId}`,
        },
        userId,
      );
    } catch (e) {
      this.logger.warn(
        `No se pudo avisar la baja del movimiento de cardex: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Historial de bajas del ítem (OFICINA): qué se eliminó, QUIÉN y POR QUÉ.
   * Con la migración sin aplicar devuelve `[]` y avisa en el log: la sección
   * del panel se ve vacía, no rota.
   */
  async listMovimientosEliminados(itemId: string) {
    await this.findItem(itemId); // 404 si el ítem no existe
    const { data, error } = await this.supabase.service
      .from(TABLA_MOVIMIENTO_ELIMINADO)
      .select(
        'id, movimiento_id, tipo, cantidad, fecha_movimiento, aeronave_matricula, motivo, eliminado_por, eliminado_por_nombre, eliminado_at, gastos_snapshot',
      )
      .eq('item_id', itemId)
      .order('eliminado_at', { ascending: false });
    if (error) {
      if (esTablaInexistente(error)) {
        this.logger.warn(
          `Historial de movimientos eliminados no disponible: falta aplicar la migración ${MIGRACION_MOVIMIENTO_ELIMINADO} (${error.message}).`,
        );
        return [];
      }
      throw new Error(error.message);
    }
    return ((data ?? []) as Array<Record<string, unknown>>).map((fila) => {
      const gastos = Array.isArray(fila.gastos_snapshot)
        ? (fila.gastos_snapshot as Array<Record<string, unknown>>)
        : [];
      // Todos los gastos de UN movimiento comparten moneda (montoGastoDeSalida
      // resuelve una sola para la salida): sumarlos no mezcla monedas.
      const moneda =
        gastos.length > 0 ? textoDe(gastos[0].moneda, 'MXN') : null;
      return {
        id: textoDe(fila.id),
        movimiento_id: textoDe(fila.movimiento_id),
        tipo: textoDe(fila.tipo),
        cantidad: round(Number(fila.cantidad), 2),
        fecha_movimiento: fila.fecha_movimiento as string,
        aeronave_matricula: (fila.aeronave_matricula as string | null) ?? null,
        motivo: textoDe(fila.motivo),
        eliminado_por: (fila.eliminado_por as string | null) ?? null,
        eliminado_por_nombre:
          (fila.eliminado_por_nombre as string | null) ?? null,
        eliminado_at: fila.eliminado_at as string,
        gastos_eliminados: gastos.length,
        monto_gastos:
          gastos.length > 0
            ? round(
                gastos.reduce((s, g) => s + Number(g.monto ?? 0), 0),
                2,
              )
            : null,
        moneda_gastos: moneda,
      };
    });
  }

  /**
   * ¿Esta llave del outbox pertenece a un movimiento que la oficina YA
   * eliminó? (21-sep-2026). Sin esto, el reintento de la app volvería a crear
   * el movimiento que alguien borró con justificación — y el stock quedaría
   * mal otra vez. Con la migración sin aplicar devuelve null (comportamiento
   * de siempre).
   */
  private async eliminadoPorClientRequest(
    key: string,
  ): Promise<{ motivo: string; eliminado_por_nombre: string | null } | null> {
    const { data, error } = await this.supabase.service
      .from(TABLA_MOVIMIENTO_ELIMINADO)
      .select('motivo, eliminado_por_nombre, eliminado_at')
      .eq('client_request_id', key)
      .order('eliminado_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      if (esTablaInexistente(error)) return null;
      throw new Error(error.message);
    }
    if (!data) return null;
    const fila = data as Record<string, unknown>;
    return {
      motivo: textoDe(fila.motivo),
      eliminado_por_nombre:
        (fila.eliminado_por_nombre as string | null) ?? null,
    };
  }

  /**
   * Crea el gasto REFACCION del avión a partir de una SALIDA de bodega.
   * medio_pago 'BODEGA': el dinero salió del banco al COMPRAR la pieza, no al
   * consumirla, así que este cargo no debe cruzarse con la conciliación
   * bancaria. Si el monto es 0 (salida a costo de una compra sin costo) no
   * hay nada que cargar y solo se registra en el cardex.
   */
  private async crearGastoDeSalida(
    mov: Record<string, unknown>,
    itemNombre: string,
    userId: string,
    presentacion: string | null = null,
    /** Cómo se cobró: «precio de venta» | «último precio + 25 %» | «a costo». */
    etiquetaCargo?: string,
  ): Promise<Record<string, unknown> | null> {
    const { monto, moneda, tcGasto, esVenta } = montoGastoDeSalida(mov);
    if (monto <= 0) return null;
    const etiqueta = etiquetaCargo ?? (esVenta ? 'precio de venta' : 'a costo');

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
          `Salida de bodega: ${Number(mov.cantidad)} × ${itemNombre}${presentacion ? ` (${presentacion})` : ''} (${etiqueta})` +
          (mov.referencia ? ` · ref ${mov.referencia as string}` : ''),
        // Gasto fabricado por el sistema: capturado = ahora (7-sep).
        capturado_en: capturadoAhora(),
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
   * cargo total (PRECIO DE VENTA si la salida lo lleva; si no, su costo —
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
    /** Cómo se cobró: «precio de venta» | «último precio + 25 %» | «a costo». */
    etiquetaCargo?: string,
  ): Promise<Record<string, unknown> | null> {
    const { monto, moneda, tcGasto, esVenta } = montoGastoDeSalida(mov);
    if (monto <= 0) return null;
    const etiqueta = etiquetaCargo ?? (esVenta ? 'precio de venta' : 'a costo');

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
        `Salida de bodega (toda la flota, 1/${n} del ${esVenta ? 'precio de venta' : 'costo'}): ${Number(mov.cantidad)} × ${itemNombre}${presentacion ? ` (${presentacion})` : ''} (${etiqueta} $${monto.toFixed(2)} ${moneda})` +
        (mov.referencia ? ` · ref ${mov.referencia as string}` : ''),
      // Gasto fabricado por el sistema: capturado = ahora (7-sep).
      capturado_en: capturadoAhora(),
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
      // SEGUNDO CANDADO de la misma migración (22-sep-2026): la liga
      // gasto→movimiento nació ÚNICA (`uq_gasto_inventario_movimiento`,
      // `20260703000001`, cuando el puente era 1 salida → 1 gasto). Los N
      // gastos de la flota comparten `inventario_movimiento_id`, así que el
      // segundo renglón del lote choca con 23505 si `20260922000003` no
      // relajó el índice. Es EXACTAMENTE el mismo diagnóstico que el 23514
      // del movimiento —falta la migración, el dato está bien— y merece el
      // mismo 503: un 500 traducido decía «Ya existe un registro con esos
      // mismos datos; revisa si está duplicado», que manda al operador a
      // buscar un duplicado que no existe.
      if (
        error.code === '23505' &&
        error.message.includes(UQ_GASTO_INVENTARIO_MOVIMIENTO)
      ) {
        this.logger.error(
          `Gastos prorrateados de la salida de flota rechazados por la base: falta aplicar la migración ${MIGRACION_SALIDA_FLOTA} (${error.message}). La salida se revirtió: no quedó nada escrito.`,
        );
        throw new ServiceUnavailableException({
          message: `La salida para toda la flota todavía no está disponible en la base: falta aplicar la migración ${MIGRACION_SALIDA_FLOTA} (el cargo se reparte en un gasto por avión y la base todavía admite uno solo). Mientras tanto, captura la salida por avión (una por matrícula). No se guardó nada.`,
          error: 'MIGRACION_PENDIENTE',
          details: {
            migracion: MIGRACION_SALIDA_FLOTA,
            constraint: UQ_GASTO_INVENTARIO_MOVIMIENTO,
            aviones: n,
          },
        });
      }
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
   * de bodega USD histórico), con el TC RESUELTO de la devolución (el
   * capturado o el oficial de su día — `tcDevolucion`). Peso contra peso, dólar
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
   * REALMENTE SE CARGÓ al avión, sea precio de venta o costo — así que
   * los gastos a precio de venta se revierten igual (se borran/reducen hasta
   * cubrir el monto devuelto); no hay que distinguirlos aquí.
   */
  private async revertirGastoPorDevolucion(
    itemId: string,
    dto: CreateMovimientoDto,
    costoUnitarioUsd: number,
    itemNombre: string,
    userId: string,
    /** T.C. resuelto de la devolución (capturado u oficial); null = sin T.C. */
    tcDevolucion: number | null = null,
  ): Promise<ReversionPendiente | null> {
    const devEnMxn = dto.moneda === 'MXN' && dto.costo_unitario_mxn != null;
    const monedaDev: 'MXN' | 'USD' = devEnMxn ? 'MXN' : 'USD';
    let porRevertir = round(
      Number(dto.cantidad) *
        (devEnMxn ? Number(dto.costo_unitario_mxn) : costoUnitarioUsd),
      2,
    );
    if (porRevertir <= 0) return null;
    // TC de respaldo para gastos en OTRA moneda sin tc_gasto propio: el
    // RESUELTO (capturado u oficial), no solo el que tecleó el operador.
    const tcDev = Number(tcDevolucion ?? dto.tc_usd_mxn);
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

/** '2026-09-25' → '25-sep-2026' (subtítulos de Excel; corta el string, jamás `new Date`). */
function fechaGuion(fecha: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha ?? '');
  if (!m) return fecha ?? '';
  const meses = [
    'ene',
    'feb',
    'mar',
    'abr',
    'may',
    'jun',
    'jul',
    'ago',
    'sep',
    'oct',
    'nov',
    'dic',
  ];
  return `${m[3]}-${meses[Number(m[2]) - 1] ?? m[2]}-${m[1]}`;
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
 * Nombre del CHECK que rechazó un INSERT/UPDATE (23514). Postgres lo manda
 * entrecomillado dentro del mensaje: «… violates check constraint
 * "inventario_movimiento_check"». Sirve para que el 400 diga CUÁL regla se
 * rompió (`details.constraint`) en vez del genérico de siempre; `null`
 * cuando el mensaje no trae nombre (nunca se inventa uno).
 */
function nombreDeConstraint(mensaje: string): string | null {
  return /check constraint "([^"]+)"/i.exec(mensaje ?? '')?.[1] ?? null;
}

/**
 * Ids por consulta `in (…)` de PostgREST: con ~200 uuids la URL revienta
 * (414). Mismo tope que `calendar-huerfanos.util#LOTE_IDS_BD`.
 */
export const LOTE_IDS_INVENTARIO = 150;

/** Parte `ids` en lotes de ≤ LOTE_IDS_INVENTARIO (vacío ⇒ ningún lote). */
function lotesDeIds(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += LOTE_IDS_INVENTARIO) {
    out.push(ids.slice(i, i + LOTE_IDS_INVENTARIO));
  }
  return out;
}
