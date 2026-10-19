import { assertMesAbierto } from '../../common/cierre-mes.lector';
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
import { PyservicesService } from '../pyservices/pyservices.service';
import {
  CONCEPTO_CAJA,
  TIPO_GASTO_CAJA,
  TIPO_REPOSICION,
  efectoMovimientoCaja,
  historialConSaldo,
  lecturaFondo,
  porReponerCaja,
  round2,
  saldoCaja,
  tramoDeReposicion,
  type EntradaConSaldo,
  type EntradaHistorialCaja,
  type TramoReposicion,
} from '../../common/caja-chica-saldo.util';
import {
  armarExcelCaja,
  tablaXlsxDeCaja,
  type ExtraGastoXlsx,
  type ModoExcelCaja,
} from './caja-chica-reposicion-xlsx';
// Gastos por pagar (invariante 93, revisión P7): resalte en el Excel de UNA
// reposición de los marcados pagados después de registrarla (best-effort).
import { marcadosPagadosEnBitacora } from './gasto-marcado-pagado.lector';
import { etiquetaCategoriaGasto } from '../../common/categoria-gasto.util';
import {
  leerUbicacionBalance,
  type BalanceDeGasto,
} from '../../common/ubicacion-balance-lector';
import { hoyCancun, restarMeses } from '../../common/fecha-cancun.util';
import { inicioOficialDe, pisoDia } from '../../common/inicio-oficial.util';
// GASTOS «POR PAGAR» (19-oct-2026, invariante 93): un EFECTIVO por pagar
// vigente NO es del libro (saldo, por reponer, reposición): entra con su
// fecha real al marcarse pagado. Sonda ÚNICA de la columna y regla pura.
import {
  colsPorPagar,
  porPagarDisponible,
} from '../../common/por-pagar-disponible.util';
import {
  estadoPagoGasto,
  porPagarVigente,
  type EstadoPagoGasto,
} from '../expenses/por-pagar.util';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  CreateCajaMovimientoDto,
  CreateFondoDto,
  ListFondosQuery,
  MI_CAJA_HISTORIAL_LIMIT_DEFAULT,
  MI_CAJA_HISTORIAL_MESES_ATRAS,
  MiCajaHistorialQuery,
  MonedaCaja,
  TipoMovimientoCaja,
  UpdateCajaMovimientoDto,
  UpdateFondoDto,
} from './dto/caja-chica.dto';

const FONDO_COLS =
  'id, usuario_id, moneda, activo, es_acumulada, monto_fondo, fondo_origen_id, notas, created_at, updated_at, usuario:usuario!usuario_id(nombre, email, rol)';
const MOV_COLS =
  'id, fondo_id, tipo, monto, moneda, fecha, autorizado_por, referencia, notas, registrado_por, espejo_de_id, created_at';

type CajaMov = {
  tipo: string;
  monto: number | string;
  fecha?: string;
  created_at?: string;
};

type FondoRow = Record<string, unknown> & {
  id: string;
  usuario_id: string;
  moneda: string;
  es_acumulada?: boolean;
  monto_fondo?: number | string | null;
  usuario?: unknown;
};

/**
 * Gasto EFECTIVO «por pagar» vigente de la caja (invariante 93): aún no sale
 * de la caja. Lista ADITIVA `por_pagar` del detalle y de `/caja-chica/me`.
 */
export type GastoPorPagarCaja = {
  id: string;
  fecha_gasto: string;
  monto: number;
  moneda: string;
  categoria: string | null;
  concepto: string;
  estado_pago: EstadoPagoGasto;
};

/** Texto de un valor de PostgREST (texto o número); otro tipo ⇒ ''. */
function txt(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** Primera línea de las notas, el lugar o la etiqueta de la categoría. */
function conceptoGastoCaja(g: Record<string, unknown>): string {
  const linea = txt(g.notas).split('\n')[0].trim();
  if (linea) return linea;
  const lugar = txt(g.lugar).trim();
  if (lugar) return lugar;
  return etiquetaCategoriaGasto((g.categoria as string | null) ?? null);
}

/**
 * Lista `por_pagar` (orden por fecha, luego captura e id) y su total en la
 * moneda del fondo (centavos enteros).
 */
function listaPorPagarCaja(
  gastos: Array<Record<string, unknown>>,
  hoy: string,
): { lista: GastoPorPagarCaja[]; total: number } {
  const ordenados = [...gastos].sort((a, b) => {
    const fa = txt(a.fecha_gasto);
    const fb = txt(b.fecha_gasto);
    if (fa !== fb) return fa < fb ? -1 : 1;
    const ca = txt(a.created_at);
    const cb = txt(b.created_at);
    if (ca !== cb) return ca < cb ? -1 : 1;
    return txt(a.id) < txt(b.id) ? -1 : 1;
  });
  let cents = 0;
  const lista = ordenados.map((g): GastoPorPagarCaja => {
    const monto = Number(g.monto);
    cents += Number.isFinite(monto) ? Math.round(monto * 100) : 0;
    return {
      id: txt(g.id),
      fecha_gasto: txt(g.fecha_gasto).slice(0, 10),
      monto: Number.isFinite(monto) ? monto : 0,
      moneda: txt(g.moneda),
      categoria: (g.categoria as string | null) ?? null,
      concepto: conceptoGastoCaja(g),
      estado_pago: estadoPagoGasto(g, hoy),
    };
  });
  return { lista, total: cents / 100 };
}

/** Entrada del libro unificado (movimiento de caja o gasto en efectivo). */
type EntradaLibro = EntradaHistorialCaja & {
  id: string;
  tipo: string;
  moneda: string;
  /** Mismo criterio que el panel: mov → notas ?? referencia; gasto → notas ?? etiqueta de categoría. */
  descripcion: string | null;
  notas: string | null;
  referencia: string | null;
  categoria: string | null;
  lugar: string | null;
  vuelo_id: string | null;
  vuelo_folio: number | null;
  registrado_por_nombre: string | null;
  autorizado_por_nombre: string | null;
  /** Solo gastos y solo con la migración (invariante 93; en el libro, PAGADO). */
  por_pagar?: boolean;
  estado_pago?: EstadoPagoGasto;
};

/**
 * Columnas de PRESENTACIÓN de los gastos del Excel de reposición (consulta
 * aparte por id: el libro —montos, orden y saldo— sigue saliendo SOLO de
 * `cargarLibro`, y el detalle/app no cargan embeds que no usan).
 */
const GASTO_XLSX_COLS =
  'id, estatus_comprobante, estatus_facturacion, capturado_en, created_at, aeronave:aeronave!aeronave_id(matricula), creador:usuario!created_by(nombre)';

/** Ids por consulta `.in(...)` (la URL de PostgREST no crece sin tope). */
const LOTE_IDS = 200;

/**
 * Ids por `.in(...)` de las lecturas de «a quién se repuso» (invariante 83):
 * uuids de 36 caracteres ⇒ ≤ 150 por consulta mantiene la URL corta.
 */
const LOTE_ESPEJOS = 150;

/** Libros de cajas hijas que se cargan a la vez (invariante 83). */
const TOPE_LIBROS_HIJAS = 4;

/**
 * Caja (y su dueño, nombre VIVO) de la REPOSICIÓN que originó un espejo
 * (invariante 83): el renglón «Reintegro a dirección» de la caja madre dice
 * a quién se le repuso.
 */
export type RepuestoA = {
  fondo_id: string;
  usuario_id: string;
  nombre: string | null;
};

/**
 * Una caja que ESTA caja fondea (`fondo_origen_id` = esta), con lo que tiene
 * por reponer según la MISMA fuente que su tarjeta y su Excel (invariante 83).
 */
export type CajaFondeada = {
  fondo_id: string;
  usuario_id: string;
  nombre: string | null;
  moneda: string;
  activo: boolean;
  por_reponer: number;
  ultima_reposicion: { fecha: string; monto: number } | null;
};

/** `fn` sobre cada elemento con a lo más `tope` promesas vivas; mismo orden. */
async function mapConTope<T, R>(
  items: T[],
  tope: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < items.length) {
      const i = siguiente++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(tope, items.length) }, trabajador),
  );
  return out;
}

/** PostgREST devuelve el embed como objeto o arreglo según la relación. */
function unwrapEmbed<T>(v: unknown): T | null {
  const x: unknown = Array.isArray(v) ? (v as unknown[])[0] : v;
  return x && typeof x === 'object' ? (x as T) : null;
}

function nombreEmbed(v: unknown): string | null {
  const n = unwrapEmbed<{ nombre?: unknown }>(v)?.nombre;
  return typeof n === 'string' && n ? n : null;
}

/**
 * El saldo del fondo (y el saldo corrido del historial) se calcula SOLO con
 * `src/common/caja-chica-saldo.util.ts` — fuente única compartida con la
 * alerta de caja en negativo. Aquí no hay fórmulas de dinero.
 */
@Injectable()
export class CajaChicaService {
  private readonly logger = new Logger(CajaChicaService.name);

  constructor(
    private readonly supabase: SupabaseService,
    // Excel de la reposición (24-sep-2026). @Optional: los specs construyen
    // el servicio con un solo argumento posicional.
    @Optional() private readonly pyservices?: PyservicesService,
    // Inicio oficial (invariante 86): SOLO para no ofrecer «Ver en balance…»
    // de un libro anterior al inicio. Saldo, libro y orden no lo usan.
    @Optional() private readonly configuracion?: ConfiguracionService,
  ) {}

  /**
   * Última REPOSICIÓN del fondo (fecha y monto) — null si nunca ha habido.
   * Pedido de oficina 14-ago: verla de un vistazo en lista y detalle.
   */
  private ultimaReposicion(
    movs: CajaMov[],
  ): { fecha: string; monto: number } | null {
    let mejor: CajaMov | null = null;
    for (const m of movs) {
      if (m.tipo !== TipoMovimientoCaja.REPOSICION || !m.fecha) continue;
      if (
        !mejor ||
        m.fecha > mejor.fecha! ||
        (m.fecha === mejor.fecha &&
          (m.created_at ?? '') > (mejor.created_at ?? ''))
      ) {
        mejor = m;
      }
    }
    return mejor ? { fecha: mejor.fecha!, monto: Number(mejor.monto) } : null;
  }

  /**
   * Fecha (YYYY-MM-DD) de la ÚLTIMA reposición del fondo ACTIVO del usuario —
   * null si no tiene fondo activo, si el fondo es de OTRA moneda o si nunca se
   * le ha repuesto. La usa `expenses.assertOwnEnVentana` (candado 1-sep-2026):
   * un gasto EFECTIVO con fecha ≤ esta ya quedó saldado en una reposición de
   * caja chica y no se corrige/borra desde la app — solo oficina.
   */
  async fechaUltimaReposicionDe(
    usuarioId: string,
    moneda: string,
  ): Promise<string | null> {
    const { data: fondo, error } = await this.supabase.service
      .from('caja_chica_fondo')
      .select('id, moneda')
      .eq('usuario_id', usuarioId)
      .eq('activo', true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!fondo || (fondo as { moneda: string }).moneda !== moneda) return null;
    const { data: movs, error: movErr } = await this.supabase.service
      .from('caja_chica_movimiento')
      .select('tipo, monto, fecha, created_at')
      .eq('fondo_id', (fondo as { id: string }).id)
      .eq('tipo', TipoMovimientoCaja.REPOSICION);
    if (movErr) throw new Error(movErr.message);
    return this.ultimaReposicion(movs ?? [])?.fecha ?? null;
  }

  // ===== Fondos =====

  async listFondos(filters: ListFondosQuery) {
    let q = this.supabase.service
      .from('caja_chica_fondo')
      .select(FONDO_COLS, { count: 'exact' })
      .order('created_at', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);

    const { data: fondos, error, count } = await q;
    if (error) throw new Error(error.message);
    const rows = fondos ?? [];

    const fondoIds = rows.map((f) => (f as { id: string }).id);
    const usuarioIds = rows.map(
      (f) => (f as { usuario_id: string }).usuario_id,
    );
    const [movsByFondo, efectivoByUsuario] = await Promise.all([
      this.movsByFondos(fondoIds),
      this.efectivoByUsuarios(usuarioIds),
    ]);

    const data = rows.map((f) => {
      const fo = f as Record<string, unknown> & {
        id: string;
        usuario_id: string;
        moneda: string;
      };
      const efectivo = (efectivoByUsuario.get(fo.usuario_id) ?? []).filter(
        (g) => g.moneda === fo.moneda,
      );
      return {
        ...fo,
        saldo: saldoCaja(
          movsByFondo.get(fo.id) ?? [],
          efectivo,
          fo.es_acumulada === true,
        ),
        ultima_reposicion: this.ultimaReposicion(movsByFondo.get(fo.id) ?? []),
      };
    });

    return {
      data,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  private async movsByFondos(
    fondoIds: string[],
  ): Promise<Map<string, CajaMov[]>> {
    const map = new Map<string, CajaMov[]>();
    if (fondoIds.length === 0) return map;
    const { data, error } = await this.supabase.service
      .from('caja_chica_movimiento')
      // fecha/created_at: para derivar la última reposición sin otra query.
      .select('fondo_id, tipo, monto, fecha, created_at')
      .in('fondo_id', fondoIds);
    if (error) throw new Error(error.message);
    for (const m of data ?? []) {
      const k = (m as { fondo_id: string }).fondo_id;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m);
    }
    return map;
  }

  private async efectivoByUsuarios(
    usuarioIds: string[],
  ): Promise<Map<string, { monto: number | string; moneda: string }[]>> {
    const map = new Map<string, { monto: number | string; moneda: string }[]>();
    if (usuarioIds.length === 0) return map;
    // Invariante 93: con la migración, un EFECTIVO por pagar vigente no
    // cuenta en el saldo (se filtra en JS sobre lo ya leído).
    const conPorPagar = await porPagarDisponible(this.supabase.service);
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(
        `usuario_captura_id, monto, moneda${conPorPagar ? ', fecha_gasto, por_pagar, conciliado' : ''}`,
      )
      .eq('medio_pago', 'EFECTIVO')
      .in('usuario_captura_id', usuarioIds);
    if (error) throw new Error(error.message);
    const hoy = hoyCancun();
    for (const g of (data ?? []) as unknown as Array<
      Record<string, unknown> & {
        usuario_captura_id: string;
        monto: number | string;
        moneda: string;
      }
    >) {
      if (conPorPagar && porPagarVigente(g, hoy)) continue;
      const k = (g as { usuario_captura_id: string }).usuario_captura_id;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(g);
    }
    return map;
  }

  async findFondo(id: string) {
    const { data, error } = await this.supabase.service
      .from('caja_chica_fondo')
      .select(FONDO_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Fondo ${id} not found`);
    return data;
  }

  /**
   * Libro del fondo: movimientos de caja (con nombres de quien registró y
   * autorizó) + gastos en EFECTIVO del dueño en la moneda del fondo,
   * unificados y con saldo corrido ASC (`historialConSaldo`, fuente única).
   * Lo usan el detalle del panel y el historial del piloto en la app: mismo
   * libro, misma cifra por fila.
   */
  private async cargarLibro(fondo: FondoRow): Promise<{
    movs: Record<string, unknown>[];
    efectivo: { monto: number | string }[];
    historial: EntradaConSaldo<EntradaLibro>[];
    /**
     * EFECTIVO por pagar vigente de la moneda del fondo (invariante 93):
     * FUERA del libro. null = sin la migración (la llave no viaja).
     */
    porPagar: { lista: GastoPorPagarCaja[]; total: number } | null;
  }> {
    const conPorPagar = await porPagarDisponible(this.supabase.service);
    const [movsRes, gastosRes] = await Promise.all([
      this.supabase.service
        .from('caja_chica_movimiento')
        .select(
          `${MOV_COLS}, autorizado:usuario!autorizado_por(nombre), registrado:usuario!registrado_por(nombre)`,
        )
        .eq('fondo_id', fondo.id),
      this.supabase.service
        .from('gasto')
        // vuelo:vuelo_id(folio) — el historial enlaza al vuelo del gasto: la
        // oficina audita "¿de qué vuelo salió este efectivo?" sin buscarlo.
        // `created_at`: desempate dentro del día (orden de captura).
        .select(
          `id, monto, moneda, fecha_gasto, categoria, lugar, notas, vuelo_id, created_at, vuelo:vuelo_id(folio)${colsPorPagar(conPorPagar)}`,
        )
        .eq('medio_pago', 'EFECTIVO')
        .eq('usuario_captura_id', fondo.usuario_id),
    ]);
    // El saldo es dinero: nunca calcularlo con datos parciales.
    if (movsRes.error) throw new Error(movsRes.error.message);
    if (gastosRes.error) throw new Error(gastosRes.error.message);
    const movs = (movsRes.data ?? []) as Record<string, unknown>[];
    const deLaMoneda = (
      (gastosRes.data ?? []) as unknown as Record<string, unknown>[]
    ).filter((g) => g.moneda === fondo.moneda);
    // GASTOS POR PAGAR (invariante 93): el vigente (estado ≠ PAGADO) NO es
    // del libro; sin por pagar, el libro es byte a byte el de siempre.
    const hoy = hoyCancun();
    const efectivo = conPorPagar
      ? deLaMoneda.filter((g) => !porPagarVigente(g, hoy))
      : deLaMoneda;
    const porPagar = conPorPagar
      ? listaPorPagarCaja(
          deLaMoneda.filter((g) => porPagarVigente(g, hoy)),
          hoy,
        )
      : null;
    const duenoNombre = nombreEmbed(fondo.usuario);

    const entradas: EntradaLibro[] = [
      ...movs.map((m): EntradaLibro => {
        const mm = m as {
          id: string;
          tipo: string;
          monto: number | string;
          moneda: string;
          fecha: string;
          created_at: string;
          notas: string | null;
          referencia: string | null;
          autorizado?: unknown;
          registrado?: unknown;
        };
        return {
          id: mm.id,
          fecha: mm.fecha,
          origen: 'caja',
          tipo: mm.tipo,
          monto: efectoMovimientoCaja(mm),
          moneda: mm.moneda,
          descripcion: mm.notas ?? mm.referencia ?? null,
          notas: mm.notas ?? null,
          referencia: mm.referencia ?? null,
          categoria: null,
          lugar: null,
          vuelo_id: null,
          vuelo_folio: null,
          created_at: mm.created_at,
          registrado_por_nombre: nombreEmbed(mm.registrado),
          autorizado_por_nombre: nombreEmbed(mm.autorizado),
        };
      }),
      ...efectivo.map((g): EntradaLibro => {
        const gg = g as {
          id: string;
          fecha_gasto: string;
          categoria: string;
          lugar: string | null;
          notas: string | null;
          monto: number | string;
          moneda: string;
          vuelo_id: string | null;
          created_at: string | null;
          vuelo: unknown;
        };
        const vuelo = unwrapEmbed<{ folio?: number }>(gg.vuelo);
        return {
          id: gg.id,
          fecha: gg.fecha_gasto,
          origen: 'gasto',
          tipo: TIPO_GASTO_CAJA,
          monto: -Number(gg.monto),
          moneda: gg.moneda,
          descripcion: gg.notas ?? etiquetaCategoriaGasto(gg.categoria),
          notas: gg.notas ?? null,
          referencia: null,
          categoria: gg.categoria ?? null,
          lugar: gg.lugar ?? null,
          vuelo_id: gg.vuelo_id ?? null,
          vuelo_folio: vuelo?.folio ?? null,
          created_at: gg.created_at ?? gg.fecha_gasto,
          registrado_por_nombre: duenoNombre,
          autorizado_por_nombre: null,
          // Invariante 93 (con la migración): en el libro siempre PAGADO.
          ...(conPorPagar
            ? {
                por_pagar: g.por_pagar === true,
                estado_pago: estadoPagoGasto(g, hoy),
              }
            : {}),
        };
      }),
    ];

    const historial = historialConSaldo(entradas, {
      esAcumulada: fondo.es_acumulada === true,
      montoFondo: fondo.monto_fondo ?? null,
    });
    return {
      movs,
      efectivo: efectivo as { monto: number | string }[],
      historial,
      porPagar,
    };
  }

  /** Detalle con historial unificado (movimientos + gastos efectivo) y saldo corrido. */
  async getFondoDetail(id: string) {
    const fondo = (await this.findFondo(id)) as FondoRow;
    const { movs, efectivo, historial, porPagar } =
      await this.cargarLibro(fondo);
    const ultimo = historial[historial.length - 1];
    const esAcumulada = fondo.es_acumulada === true;
    const [balances, repuestoA, cajasFondeadas] = await Promise.all([
      this.balancesDeGastos(
        historial.filter((e) => e.origen === 'gasto').map((e) => e.id),
      ),
      this.repuestoADeEspejos(movs),
      this.cajasFondeadas(fondo.id),
    ]);

    return {
      ...fondo,
      // MISMO valor y signo que `listFondos` y `/caja-chica/me` (`saldoCaja`):
      // en caja ACUMULADA es positivo = por reponer (la card "Por reponer"
      // del panel lo pinta en ámbar cuando > 0). Antes salía el saldo CRUDO
      // del libro (negativo) y la lista decía +250 mientras el detalle decía
      // −250 para el mismo fondo (revisión adversarial 5-sep).
      saldo: saldoCaja(movs as CajaMov[], efectivo, esAcumulada),
      // Saldo crudo del libro (mismo signo que la columna Saldo del historial).
      saldo_libro: ultimo?.saldo ?? 0,
      movimientos: movs,
      // Shape del panel (`HistorialEntry`); `por_reponer` es ADITIVO (5-sep).
      historial: historial
        .map((e) => ({
          id: e.id,
          fecha: e.fecha,
          origen: e.origen,
          tipo: e.tipo,
          monto: e.monto,
          descripcion: e.descripcion,
          created_at: e.created_at,
          vuelo_id: e.vuelo_id,
          vuelo_folio: e.vuelo_folio,
          saldo: e.saldo,
          por_reponer: e.por_reponer,
          // ADITIVO (19-oct-2026, invariante 93), solo gastos y solo con la
          // migración: en el libro un gasto siempre está PAGADO.
          ...(e.origen === 'gasto' && e.estado_pago
            ? { por_pagar: e.por_pagar === true, estado_pago: e.estado_pago }
            : {}),
          // ADITIVO (15-oct-2026, invariante 82), SIEMPRE la última llave y
          // solo en los GASTOS: en qué libro y en qué mes vive (enlaces «Ver
          // en balance…» del panel). Sin la llave = lectura caída o gasto
          // que no volvió; null = no vive en ningún libro.
          ...(e.origen === 'gasto' && balances?.has(e.id)
            ? { balance: balances.get(e.id) ?? null }
            : {}),
          // ADITIVO (15-oct-2026, invariante 83), solo en los ESPEJOS (caja
          // madre): a quién se le repuso. Sin la llave = no es espejo o la
          // lectura cayó; null = la reposición/caja de origen ya no se leyó.
          ...(e.origen === 'caja' && repuestoA?.has(e.id)
            ? { repuesto_a: repuestoA.get(e.id) ?? null }
            : {}),
        }))
        .reverse(),
      ultima_reposicion: this.ultimaReposicion(movs as CajaMov[]),
      // ADITIVO (19-oct-2026, invariante 93), solo con la migración: los
      // EFECTIVO por pagar (aún no salen de la caja; FUERA del libro y del
      // saldo) y su total en la moneda del fondo.
      ...(porPagar
        ? { por_pagar: porPagar.lista, por_pagar_total: porPagar.total }
        : {}),
      // ADITIVO (15-oct-2026, invariante 83): cajas ACTIVAS que esta caja
      // fondea, con su por reponer. [] = no fondea ninguna; null = la lectura
      // cayó (jamás un [] falso).
      cajas_fondeadas: cajasFondeadas,
    };
  }

  /**
   * «A quién se repuso» de cada ESPEJO del libro (invariante 83): espejo →
   * REPOSICIÓN de origen (`espejo_de_id`) → su caja → dueño (nombre VIVO).
   * DOS lecturas en lote (≤ 150 ids por `in`). Devuelve el mapa id del
   * espejo → `RepuestoA | null` (null = origen o caja que no volvió).
   * BEST-EFFORT: si una lectura falla, null (warn) y NINGUNA entrada lleva la
   * llave; nunca lanza ni toca el libro. Sin espejos ⇒ mapa vacío sin leer.
   */
  private async repuestoADeEspejos(
    movs: Record<string, unknown>[],
  ): Promise<Map<string, RepuestoA | null> | null> {
    const espejos = movs
      .filter((m) => typeof m.espejo_de_id === 'string' && m.espejo_de_id)
      .map((m) => ({
        id: m.id as string,
        origenId: m.espejo_de_id as string,
      }));
    const out = new Map<string, RepuestoA | null>();
    if (espejos.length === 0) return out;
    try {
      const origenIds = [...new Set(espejos.map((e) => e.origenId))];
      const fondoDeOrigen = new Map<string, string>();
      for (let i = 0; i < origenIds.length; i += LOTE_ESPEJOS) {
        const { data, error } = await this.supabase.service
          .from('caja_chica_movimiento')
          .select('id, fondo_id')
          .in('id', origenIds.slice(i, i + LOTE_ESPEJOS));
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as Array<Record<string, unknown>>) {
          fondoDeOrigen.set(r.id as string, r.fondo_id as string);
        }
      }
      const fondoIds = [...new Set(fondoDeOrigen.values())];
      const cajas = new Map<string, RepuestoA>();
      for (let i = 0; i < fondoIds.length; i += LOTE_ESPEJOS) {
        const { data, error } = await this.supabase.service
          .from('caja_chica_fondo')
          .select('id, usuario_id, usuario:usuario!usuario_id(nombre)')
          .in('id', fondoIds.slice(i, i + LOTE_ESPEJOS));
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as Array<Record<string, unknown>>) {
          cajas.set(r.id as string, {
            fondo_id: r.id as string,
            usuario_id: r.usuario_id as string,
            nombre: nombreEmbed(r.usuario),
          });
        }
      }
      for (const e of espejos) {
        const fondoId = fondoDeOrigen.get(e.origenId);
        out.set(e.id, (fondoId && cajas.get(fondoId)) || null);
      }
      return out;
    } catch (err) {
      this.logger.warn(
        `Caja chica sin «a quién se repuso» en los espejos: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Cajas ACTIVAS que esta caja fondea (`caja_chica_fondo.fondo_origen_id` =
   * esta; el vínculo de las cajas vinculadas del 20-ago-2026), ordenadas por
   * nombre (es-MX), con `por_reponer` = la ÚLTIMA fila del libro de cada una
   * (`cargarLibro` → `historialConSaldo` → `porReponerCaja`; libro vacío ⇒
   * 0): la MISMA cifra que su tarjeta «Por reponer» del panel y su Excel de
   * lo pendiente — sin fórmula paralela. Libros en paralelo con tope
   * `TOPE_LIBROS_HIJAS`. BEST-EFFORT: si cualquier lectura falla ⇒ null
   * (warn), jamás un [] falso; nunca lanza.
   */
  private async cajasFondeadas(
    fondoId: string,
  ): Promise<CajaFondeada[] | null> {
    try {
      const { data, error } = await this.supabase.service
        .from('caja_chica_fondo')
        .select(FONDO_COLS)
        .eq('fondo_origen_id', fondoId)
        .eq('activo', true);
      if (error) throw new Error(error.message);
      const hijas = ((data ?? []) as FondoRow[]).filter(
        (h) => h.id !== fondoId,
      );
      const cajas = await mapConTope(
        hijas,
        TOPE_LIBROS_HIJAS,
        async (h): Promise<CajaFondeada> => {
          const { movs, historial } = await this.cargarLibro(h);
          const ultima = historial[historial.length - 1];
          return {
            fondo_id: h.id,
            usuario_id: h.usuario_id,
            nombre: nombreEmbed(h.usuario),
            moneda: h.moneda,
            activo: (h as { activo?: unknown }).activo === true,
            por_reponer: ultima ? ultima.por_reponer : 0,
            ultima_reposicion: this.ultimaReposicion(movs as CajaMov[]),
          };
        },
      );
      return cajas.sort((a, b) =>
        (a.nombre ?? '').localeCompare(b.nombre ?? '', 'es-MX', {
          sensitivity: 'base',
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Caja chica sin «cajas que fondea»: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Ubicación en el balance de los gastos del historial (invariante 82): UNA
   * llamada en lote al lector COMPARTIDO con Conciliación
   * (`leerUbicacionBalance`, regla de la invariante 72). BEST-EFFORT: si la
   * lectura falla devuelve null (warn) y el detalle sale sin la llave; nunca
   * lanza ni toca el libro, el saldo ni el orden.
   */
  private async balancesDeGastos(
    gastoIds: string[],
  ): Promise<Map<string, BalanceDeGasto | null> | null> {
    if (gastoIds.length === 0) return null;
    try {
      return await leerUbicacionBalance(
        this.supabase.service,
        gastoIds,
        this.logger,
        'Caja chica',
        await inicioOficialDe(this.configuracion),
      );
    } catch (err) {
      this.logger.warn(
        `Caja chica sin enlaces al balance: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Personas a las que se les puede abrir fondo. La verdad es la tabla
   * `caja_chica_fondo` — NUNCA el flag `usuario.tiene_fondo_caja`: ese flag lo
   * podía marcar la oficina a mano al invitar/editar al usuario y dejaba a la
   * persona fuera del selector para siempre sin tener fondo (jul 2026: Luis
   * Cáceres y Abraham Zamora). Aquí además se corrige el flag desincronizado.
   */
  async listElegibles() {
    const [usuariosRes, fondosRes] = await Promise.all([
      this.supabase.service
        .from('usuario')
        .select('id, nombre, email, rol, estado, es_piloto, tiene_fondo_caja')
        .neq('estado', 'INACTIVO')
        .order('nombre'),
      this.supabase.service.from('caja_chica_fondo').select('usuario_id'),
    ]);
    if (usuariosRes.error) throw new Error(usuariosRes.error.message);
    if (fondosRes.error) throw new Error(fondosRes.error.message);

    const conFondo = new Set((fondosRes.data ?? []).map((f) => f.usuario_id));
    const usuarios = (usuariosRes.data ?? []) as Array<{
      id: string;
      tiene_fondo_caja: boolean;
    }>;
    const elegibles = usuarios.filter((u) => !conFondo.has(u.id));

    // Auto-reparación del flag: si dice que tiene fondo y no existe la fila, se
    // apaga (el usuario ya aparece en el selector aunque esta escritura falle).
    const fantasmas = elegibles
      .filter((u) => u.tiene_fondo_caja)
      .map((u) => u.id);
    if (fantasmas.length > 0) {
      await this.supabase.service
        .from('usuario')
        .update({ tiene_fondo_caja: false })
        .in('id', fantasmas);
    }

    return { data: elegibles.map((u) => ({ ...u, tiene_fondo_caja: false })) };
  }

  async createFondo(dto: CreateFondoDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('caja_chica_fondo')
      .insert({
        usuario_id: dto.usuario_id,
        moneda: dto.moneda ?? 'MXN',
        es_acumulada: dto.es_acumulada ?? false,
        monto_fondo: dto.monto_fondo,
        notas: dto.notas,
        created_by: userId,
        updated_by: userId,
      })
      .select(FONDO_COLS)
      .maybeSingle();
    if (error) {
      // Ya existe fila para esa persona. Si el fondo estaba CERRADO se
      // reabre (crear otro es imposible por el unique y el selector lo
      // ofrecería en un bucle sin salida); si está activo, error claro.
      if (error.code === '23505') {
        const { data: existente } = await this.supabase.service
          .from('caja_chica_fondo')
          .select(FONDO_COLS)
          .eq('usuario_id', dto.usuario_id)
          .maybeSingle();
        const fondo = existente as { id: string; activo: boolean } | null;
        if (fondo && !fondo.activo) {
          return this.updateFondo(
            fondo.id,
            { activo: true, notas: dto.notas },
            userId,
          );
        }
        throw new BadRequestException(
          'Esa persona ya tiene un fondo de caja chica.',
        );
      }
      if (error.code === '23503')
        throw new BadRequestException('Usuario no encontrado.');
      throw new Error(error.message);
    }
    await this.supabase.service
      .from('usuario')
      .update({ tiene_fondo_caja: true })
      .eq('id', dto.usuario_id);
    return data!;
  }

  async updateFondo(id: string, dto: UpdateFondoDto, userId: string) {
    if (Object.keys(dto).length === 0) return this.findFondo(id);
    // CAJAS VINCULADAS (20-ago-2026): validar el vínculo ANTES de escribir.
    // `retroactivo` es una instrucción, no una columna — se separa del patch.
    const { retroactivo, ...patch } = dto;
    if (dto.fondo_origen_id != null) {
      await this.validarVinculo(id, dto.fondo_origen_id);
    }
    // Con vínculos vivos, ni cerrar la madre ni cambiar monedas: los espejos
    // copiarían montos crudos a otra denominación o caerían en una caja
    // invisible (hallazgos adversariales 20-ago).
    if (dto.activo === false || dto.moneda !== undefined) {
      const { data: hijas, error: hijasErr } = await this.supabase.service
        .from('caja_chica_fondo')
        .select('id')
        .eq('fondo_origen_id', id)
        .limit(1);
      if (hijasErr) throw new Error(hijasErr.message);
      const esMadre = (hijas ?? []).length > 0;
      if (dto.activo === false && esMadre) {
        throw new BadRequestException(
          'Esta caja fondea otras cajas: quita esos vínculos (Usuarios) antes de cerrarla.',
        );
      }
      if (dto.moneda !== undefined) {
        const actual = (await this.findFondo(id)) as {
          moneda: string;
          fondo_origen_id?: string | null;
        };
        if (
          dto.moneda !== actual.moneda &&
          (esMadre || actual.fondo_origen_id)
        ) {
          throw new BadRequestException(
            'Esta caja está vinculada (fondea o es fondeada): quita el vínculo antes de cambiar la moneda.',
          );
        }
      }
    }
    const { data, error } = await this.supabase.service
      .from('caja_chica_fondo')
      .update({ ...patch, updated_by: userId })
      .eq('id', id)
      .select(FONDO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Fondo ${id} not found`);
    if (dto.fondo_origen_id != null && retroactivo === true) {
      await this.crearEspejosRetroactivos(id, dto.fondo_origen_id, userId);
    }
    if (typeof dto.activo === 'boolean') {
      await this.supabase.service
        .from('usuario')
        .update({ tiene_fondo_caja: dto.activo })
        .eq('id', (data as { usuario_id: string }).usuario_id);
    }
    return data;
  }

  // ===== Movimientos =====

  async createMovimiento(
    fondoId: string,
    dto: CreateCajaMovimientoDto,
    userId: string,
  ) {
    const fondo = (await this.findFondo(fondoId)) as { moneda: MonedaCaja }; // 404 si no existe

    if (dto.monto === 0)
      throw new BadRequestException('El monto no puede ser cero.');
    if (dto.tipo !== TipoMovimientoCaja.AJUSTE && dto.monto < 0) {
      throw new BadRequestException(
        'REPOSICION y REINTEGRO requieren un monto positivo.',
      );
    }
    // El saldo del fondo se calcula en una sola moneda: rechazar mezclas.
    if (dto.moneda && dto.moneda !== fondo.moneda) {
      throw new BadRequestException(
        `El fondo maneja ${fondo.moneda}; registra el movimiento en esa moneda.`,
      );
    }
    // CIERRE DE MES (16-oct-2026, invariante 89): un movimiento de caja
    // chica con fecha en un mes cerrado ⇒ 409 MES_CERRADO.
    await assertMesAbierto(
      this.supabase.service,
      (dto.fecha || hoyCancun()).slice(0, 7),
      'caja_chica',
    );

    const { data, error } = await this.supabase.service
      .from('caja_chica_movimiento')
      .insert({
        fondo_id: fondoId,
        tipo: dto.tipo,
        monto: dto.monto,
        moneda: fondo.moneda,
        // Sin fecha ⇒ HOY en Cancún (invariante 83): el `DEFAULT
        // CURRENT_DATE` de la BD corre en UTC y de 19:00 a 23:59 Cancún ya
        // es «mañana» — la reposición y su espejo (que copia esta fecha)
        // quedaban un día adelante y el libro contaba como repuestos los
        // gastos de ese día siguiente.
        fecha: dto.fecha || hoyCancun(),
        autorizado_por: dto.autorizado_por ?? null,
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
    // Caja VINCULADA: la REPOSICIÓN genera su REINTEGRO espejo en la caja
    // madre — si el espejo no se puede escribir, la reposición se REVIERTE
    // (jamás dinero entregado sin descontar de la madre en silencio).
    const origenId = (fondo as { fondo_origen_id?: string | null })
      .fondo_origen_id;
    if (dto.tipo === TipoMovimientoCaja.REPOSICION && origenId) {
      try {
        await this.insertarEspejo(
          data as { id: string; monto: number | string; fecha: string | null },
          fondoId,
          origenId,
          userId,
        );
      } catch (e) {
        await this.supabase.service
          .from('caja_chica_movimiento')
          .delete()
          .eq('id', (data as { id: string }).id);
        throw e;
      }
    }
    return data!;
  }

  /** Nombre del dueño de un fondo (para las notas de los espejos). */
  private async nombreDeFondo(fondoId: string): Promise<string> {
    const { data } = await this.supabase.service
      .from('caja_chica_fondo')
      .select('usuario:usuario!usuario_id(nombre)')
      .eq('id', fondoId)
      .maybeSingle();
    const u = data?.usuario as
      | { nombre?: string }
      | { nombre?: string }[]
      | null;
    const nombre = Array.isArray(u) ? u[0]?.nombre : u?.nombre;
    return nombre ?? 'caja vinculada';
  }

  /** Inserta el REINTEGRO espejo de una reposición en la caja madre. */
  private async insertarEspejo(
    mov: { id: string; monto: number | string; fecha: string | null },
    fondoHijaId: string,
    origenId: string,
    userId: string,
  ) {
    const nombre = await this.nombreDeFondo(fondoHijaId);
    const origen = (await this.findFondo(origenId)) as {
      moneda: string;
      activo: boolean;
    };
    // Madre CERRADA: el descuento caería en una caja invisible (la lista
    // oculta las cerradas). Error claro; la reposición de la hija se
    // revierte en createMovimiento.
    if (origen.activo !== true) {
      throw new BadRequestException(
        'La caja madre que fondea esta caja está cerrada: reábrela o quita el vínculo (Usuarios) antes de registrar la reposición.',
      );
    }
    const { error } = await this.supabase.service
      .from('caja_chica_movimiento')
      .insert({
        fondo_id: origenId,
        tipo: TipoMovimientoCaja.REINTEGRO,
        monto: Number(mov.monto),
        moneda: origen.moneda,
        fecha: mov.fecha ?? undefined,
        referencia: `Fondeo a ${nombre}`,
        notas: 'Espejo automático de la reposición en la caja vinculada.',
        espejo_de_id: mov.id,
        registrado_por: userId,
        created_by: userId,
        updated_by: userId,
      });
    if (error)
      throw new Error(`No se pudo registrar el espejo: ${error.message}`);
  }

  /**
   * Valida el vínculo caja hija → caja madre: existe y está activa, misma
   * moneda, sin auto-vínculo ni ciclos (A→B→A dejaría espejos confusos).
   */
  private async validarVinculo(fondoId: string, origenId: string) {
    if (fondoId === origenId)
      throw new BadRequestException('Una caja no puede fondearse a sí misma.');
    const hijo = (await this.findFondo(fondoId)) as { moneda: string };
    const origen = (await this.findFondo(origenId)) as {
      moneda: string;
      activo: boolean;
      fondo_origen_id?: string | null;
    };
    if (origen.activo !== true)
      throw new BadRequestException('La caja madre está cerrada.');
    if (origen.moneda !== hijo.moneda)
      throw new BadRequestException(
        'Las dos cajas deben manejar la misma moneda.',
      );
    // Ciclos: sube por la cadena de orígenes desde la madre propuesta.
    let cursor = origen.fondo_origen_id ?? null;
    for (let i = 0; i < 10 && cursor; i++) {
      if (cursor === fondoId)
        throw new BadRequestException(
          'Vínculo circular: esa caja (directa o indirectamente) se fondea desde esta.',
        );
      const { data } = await this.supabase.service
        .from('caja_chica_fondo')
        .select('fondo_origen_id')
        .eq('id', cursor)
        .maybeSingle();
      cursor = (data?.fondo_origen_id as string | null) ?? null;
    }
  }

  /**
   * Espejos RETROACTIVOS al vincular: cada REPOSICIÓN ya registrada en la
   * caja hija sin espejo genera su REINTEGRO en la madre — así el fondeo
   * histórico ("el fondo que les di salió de mi caja") queda descontado.
   */
  private async crearEspejosRetroactivos(
    fondoId: string,
    origenId: string,
    userId: string,
  ) {
    const { data: repos, error } = await this.supabase.service
      .from('caja_chica_movimiento')
      .select('id, monto, fecha')
      .eq('fondo_id', fondoId)
      .eq('tipo', TipoMovimientoCaja.REPOSICION);
    if (error) throw new Error(error.message);
    const ids = (repos ?? []).map((m) => m.id as string);
    if (ids.length === 0) return;
    const { data: conEspejo, error: espErr } = await this.supabase.service
      .from('caja_chica_movimiento')
      .select('espejo_de_id')
      .in('espejo_de_id', ids);
    if (espErr) throw new Error(espErr.message);
    const ya = new Set((conEspejo ?? []).map((m) => m.espejo_de_id as string));
    for (const m of repos ?? []) {
      if (ya.has(m.id as string)) continue;
      await this.insertarEspejo(
        m as { id: string; monto: number | string; fecha: string | null },
        fondoId,
        origenId,
        userId,
      );
    }
  }

  /**
   * Corrige un movimiento ya registrado (caso Mari, 18-ago: el ingreso quedó
   * sin la fecha real y no había forma de corregirlo). El saldo del fondo es
   * DERIVADO de los movimientos: editar recalcula solo. La moneda no se
   * toca — la del fondo manda.
   */
  async updateMovimiento(
    id: string,
    dto: UpdateCajaMovimientoDto,
    userId: string,
  ) {
    const { data: mov, error: readErr } = await this.supabase.service
      .from('caja_chica_movimiento')
      .select(MOV_COLS)
      .eq('id', id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${id} not found`);
    // Un ESPEJO sigue a su origen: se corrige desde la reposición de la
    // caja vinculada, nunca directo (divergirían los dos lados).
    if ((mov as { espejo_de_id?: string | null }).espejo_de_id) {
      throw new ConflictException(
        'Este movimiento es el espejo de un fondeo automático: corrígelo desde la reposición de la caja vinculada.',
      );
    }
    const tipo = dto.tipo ?? (mov.tipo as TipoMovimientoCaja);
    const monto = dto.monto ?? Number(mov.monto);
    // CIERRE DE MES (invariante 89): corregir monto, tipo o fecha de un
    // movimiento de un mes cerrado (o llevarlo a uno) ⇒ 409 MES_CERRADO.
    if (
      dto.monto !== undefined ||
      dto.tipo !== undefined ||
      dto.fecha !== undefined
    ) {
      const fechaAntes = (mov as { fecha?: string | null }).fecha ?? null;
      await assertMesAbierto(
        this.supabase.service,
        [fechaAntes?.slice(0, 7), dto.fecha ? dto.fecha.slice(0, 7) : null],
        'caja_chica',
      );
    }
    if (monto === 0)
      throw new BadRequestException('El monto no puede ser cero.');
    if (tipo !== TipoMovimientoCaja.AJUSTE && monto < 0) {
      throw new BadRequestException(
        'REPOSICION y REINTEGRO requieren un monto positivo.',
      );
    }
    const { data, error } = await this.supabase.service
      .from('caja_chica_movimiento')
      .update({
        tipo,
        monto,
        ...(dto.fecha !== undefined ? { fecha: dto.fecha } : {}),
        ...(dto.autorizado_por !== undefined
          ? { autorizado_por: dto.autorizado_por || null }
          : {}),
        ...(dto.referencia !== undefined
          ? { referencia: dto.referencia || null }
          : {}),
        ...(dto.notas !== undefined ? { notas: dto.notas || null } : {}),
        updated_by: userId,
      })
      .eq('id', id)
      .select(MOV_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // Sincroniza el ESPEJO en la caja madre (si esta reposición lo tiene):
    // mismo monto y fecha; si el movimiento dejó de ser REPOSICIÓN, el
    // espejo se elimina (el fondeo ya no existe).
    const { data: espejo, error: espErr } = await this.supabase.service
      .from('caja_chica_movimiento')
      .select('id')
      .eq('espejo_de_id', id)
      .maybeSingle();
    if (espErr) throw new Error(espErr.message);
    if (espejo) {
      if (tipo === TipoMovimientoCaja.REPOSICION) {
        const { error: syncErr } = await this.supabase.service
          .from('caja_chica_movimiento')
          .update({
            monto,
            ...(dto.fecha !== undefined ? { fecha: dto.fecha } : {}),
            updated_by: userId,
          })
          .eq('id', espejo.id as string);
        if (syncErr) throw new Error(syncErr.message);
      } else {
        const { error: delErr } = await this.supabase.service
          .from('caja_chica_movimiento')
          .delete()
          .eq('id', espejo.id as string);
        if (delErr) throw new Error(delErr.message);
      }
    } else if (
      tipo === TipoMovimientoCaja.REPOSICION &&
      (mov as { tipo: string }).tipo !== TipoMovimientoCaja.REPOSICION
    ) {
      // SOLO cuando el movimiento CAMBIÓ a reposición en ESTA edición. Una
      // reposición pre-vínculo que se corrige (fecha/notas — caso Mari) NO
      // genera espejo en silencio: el histórico solo se descuenta con el
      // opt-in "retroactivo" al vincular (hallazgo adversarial 20-ago).
      const fondo = (await this.findFondo(
        (mov as { fondo_id: string }).fondo_id,
      )) as { fondo_origen_id?: string | null };
      if (fondo.fondo_origen_id) {
        await this.insertarEspejo(
          data as { id: string; monto: number | string; fecha: string | null },
          (mov as { fondo_id: string }).fondo_id,
          fondo.fondo_origen_id,
          userId,
        );
      }
    }
    return data!;
  }

  /** Elimina un movimiento (la UI confirma): el saldo recalcula solo.
   * Borrar una REPOSICIÓN de caja vinculada arrastra su espejo (CASCADE);
   * el espejo directo no se borra — se quita desde su origen. */
  async removeMovimiento(id: string) {
    const { data: mov, error: readErr } = await this.supabase.service
      .from('caja_chica_movimiento')
      .select('id, espejo_de_id, fecha')
      .eq('id', id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${id} not found`);
    // CIERRE DE MES (invariante 89): borrar un movimiento de un mes cerrado.
    await assertMesAbierto(
      this.supabase.service,
      typeof mov.fecha === 'string' ? mov.fecha.slice(0, 7) : null,
      'caja_chica',
    );
    if (mov.espejo_de_id) {
      throw new ConflictException(
        'Este movimiento es el espejo de un fondeo automático: elimina (o corrige) la reposición de la caja vinculada y el espejo se va con ella.',
      );
    }
    const { data, error } = await this.supabase.service
      .from('caja_chica_movimiento')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Movimiento ${id} not found`);
    return { ok: true };
  }

  // ===== App del piloto =====

  /** Fondo del usuario actual con saldo y movimientos recientes. null si no tiene. */
  async getMyFondo(userId: string) {
    const { data: fondo, error } = await this.supabase.service
      .from('caja_chica_fondo')
      .select(FONDO_COLS)
      .eq('usuario_id', userId)
      .eq('activo', true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!fondo) {
      return {
        fondo: null,
        saldo: 0,
        movimientos: [],
        gastos: [],
        efectivo_otras_monedas: [],
      };
    }

    const fo = fondo as Record<string, unknown> & {
      id: string;
      moneda: string;
    };
    // INICIO OFICIAL (invariante 86, auditoría 16-oct-2026, 0.0.85): SOLO
    // las LISTAS devueltas (movimientos recientes y gastos EFECTIVO) se
    // recortan a fecha ≥ inicio. El SALDO y la lectura del fondo salen del
    // libro COMPLETO (`allMovs` y `gastosRes`, sin piso).
    const inicio = await inicioOficialDe(this.configuracion);
    // GASTOS POR PAGAR (invariante 93): con la migración, el EFECTIVO por
    // pagar vigente sale del saldo, de la lectura y de la lista `gastos` y
    // viaja aparte en `por_pagar`; sin por pagar, todo byte a byte igual.
    const conPorPagar = await porPagarDisponible(this.supabase.service);
    const hoyPP = hoyCancun();
    let movsRecientesQ = this.supabase.service
      .from('caja_chica_movimiento')
      .select(MOV_COLS)
      .eq('fondo_id', fo.id);
    if (inicio) movsRecientesQ = movsRecientesQ.gte('fecha', inicio);
    let gastosListaQ = this.supabase.service
      .from('gasto')
      .select(
        `id, fecha_gasto, monto, moneda, categoria, lugar, notas, vuelo_id, created_at, vuelo:vuelo_id(folio)${colsPorPagar(conPorPagar)}`,
      )
      .eq('medio_pago', 'EFECTIVO')
      .eq('usuario_captura_id', userId);
    if (inicio) gastosListaQ = gastosListaQ.gte('fecha_gasto', inicio);
    const [movsRes, gastosRes, gastosListaRes] = await Promise.all([
      movsRecientesQ
        .order('fecha', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(20),
      this.supabase.service
        .from('gasto')
        .select(
          conPorPagar
            ? 'id, monto, moneda, fecha_gasto, categoria, lugar, notas, created_at, por_pagar, conciliado'
            : 'monto, moneda',
        )
        .eq('medio_pago', 'EFECTIVO')
        .eq('usuario_captura_id', userId),
      // La LISTA visible de "mi caja" (la app la pinta agrupada por día,
      // como la nota del cliente): los mismos gastos EFECTIVO que alimentan
      // el saldo, con concepto y folio del vuelo. Recientes primero.
      // `created_at` (aditivo, 1-sep-2026): la app gatea Corregir/Borrar por
      // fecha de CAPTURA (ventana de edición), no por fecha del ticket.
      gastosListaQ
        .order('fecha_gasto', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(200),
    ]);
    // El saldo es dinero: nunca calcularlo con datos parciales.
    if (movsRes.error) throw new Error(movsRes.error.message);
    if (gastosRes.error) throw new Error(gastosRes.error.message);
    if (gastosListaRes.error) throw new Error(gastosListaRes.error.message);
    const movs = movsRes.data;
    const todosGastos = (gastosRes.data ?? []) as unknown as Array<
      Record<string, unknown> & { monto: number | string; moneda: string }
    >;
    // El saldo y su lectura: sin los EFECTIVO por pagar vigentes.
    const gastos = conPorPagar
      ? todosGastos.filter((g) => !porPagarVigente(g, hoyPP))
      : todosGastos;
    const gastosLista = (
      (gastosListaRes.data ?? []) as unknown as Array<Record<string, unknown>>
    )
      .filter((g) => !conPorPagar || !porPagarVigente(g, hoyPP))
      .map((g) => {
        const vuelo = (Array.isArray(g.vuelo) ? g.vuelo[0] : g.vuelo) as {
          folio?: number;
        } | null;
        const { vuelo: _omit, conciliado: _conciliado, ...rest } = g;
        void _omit;
        void _conciliado;
        return {
          ...rest,
          folio: vuelo?.folio ?? null,
          // ADITIVO (invariante 93), solo con la migración.
          ...(conPorPagar
            ? {
                por_pagar: g.por_pagar === true,
                estado_pago: estadoPagoGasto(g, hoyPP),
              }
            : {}),
        };
      });
    // Lista ADITIVA (invariante 93): EFECTIVO por pagar de la moneda del
    // fondo, aún fuera de la caja.
    const porPagar = conPorPagar
      ? listaPorPagarCaja(
          todosGastos.filter(
            (g) => g.moneda === fo.moneda && porPagarVigente(g, hoyPP),
          ),
          hoyPP,
        )
      : null;

    const allMovs = await this.supabase.service
      .from('caja_chica_movimiento')
      .select('tipo, monto')
      .eq('fondo_id', fo.id);
    if (allMovs.error) throw new Error(allMovs.error.message);
    const efectivo = (gastos ?? []).filter(
      (g) => (g as { moneda: string }).moneda === fo.moneda,
    );
    const esAcumulada =
      (fo as { es_acumulada?: boolean }).es_acumulada === true;
    const saldo = saldoCaja(allMovs.data ?? [], efectivo, esAcumulada);
    // Lectura para el usuario (pedido 29-ago: "que diga lo usado, lo
    // disponible y el total asignado", no un saldo en negativo). Cálculo
    // ADITIVO sobre el mismo saldo — reglas en `lecturaFondo` (fuente única
    // con /me/caja-chica/movimientos):
    //  · asignado  = monto nominal del fondo.
    //  · entregado = Σ reposiciones/ajustes − reintegros registrados.
    //  · gastado   = Σ gastos en EFECTIVO del capturista (misma moneda).
    const asignado = round2(
      Number((fo as { monto_fondo?: unknown }).monto_fondo ?? 0),
    );
    const entregadoTotal = round2(
      (allMovs.data ?? []).reduce(
        (acc, m) => acc + efectoMovimientoCaja(m as CajaMov),
        0,
      ),
    );
    const gastadoTotal = round2(
      efectivo.reduce((acc, g) => acc + Number(g.monto), 0),
    );
    const { usado, disponible } = lecturaFondo({
      saldo,
      asignado,
      entregadoTotal,
      gastadoTotal,
      esAcumulada,
    });

    // Efectivo capturado en OTRA moneda: no alimenta el saldo del fondo (una
    // caja = una moneda y los movimientos de reposición se rechazan en otra
    // divisa), pero también es dinero del capturista que se repone aparte —
    // sin esto un gasto en USD quedaba invisible en el resumen.
    const otras = new Map<string, number>();
    for (const g of gastos ?? []) {
      const moneda = String(g.moneda ?? '');
      if (!moneda || moneda === fo.moneda) continue;
      otras.set(moneda, (otras.get(moneda) ?? 0) + Number(g.monto));
    }
    const efectivoOtrasMonedas = [...otras.entries()].map(
      ([moneda, total]) => ({ moneda, total: round2(total) }),
    );

    return {
      fondo,
      saldo,
      // ADITIVOS (29-ago): lectura amable del fondo; la app vieja los ignora.
      asignado,
      usado,
      disponible,
      entregado_total: entregadoTotal,
      gastado_total: gastadoTotal,
      movimientos: movs ?? [],
      gastos: gastosLista,
      efectivo_otras_monedas: efectivoOtrasMonedas,
      // ADITIVOS (19-oct-2026, invariante 93), solo con la migración.
      ...(porPagar
        ? { por_pagar: porPagar.lista, por_pagar_total: porPagar.total }
        : {}),
    };
  }

  // ===== Historial de MI caja (app, 5-sep-2026) =====

  /**
   * GET /v1/me/caja-chica/movimientos: el MISMO libro que ve la oficina en
   * el detalle del fondo (`cargarLibro` → `historialConSaldo`, fuente única),
   * en orden DESC (fecha, y dentro del día: caja antes que gastos, captura
   * más reciente primero) y con dos cifras por fila:
   *  · `saldo_despues`: saldo crudo del libro tras el movimiento (mismo
   *    signo que la columna Saldo del panel — negativo en caja acumulada).
   *  · `por_reponer_despues`: POSITIVO, lo que falta por reponer tras ese
   *    movimiento; regresa a 0 con una reposición completa (decisión del
   *    cliente 5-sep: coherente con la tarjeta POR REPONER de la app).
   * El corrido se calcula sobre el libro COMPLETO; ?desde/?hasta (días
   * Cancún sobre las fechas de pared) solo recortan lo devuelto. Solo el
   * fondo ACTIVO del usuario autenticado; sin fondo → fondo:null y [].
   */
  async getMyHistorial(userId: string, query: MiCajaHistorialQuery) {
    const limit = query.limit ?? MI_CAJA_HISTORIAL_LIMIT_DEFAULT;
    const desdePedido =
      query.desde ?? restarMeses(hoyCancun(), MI_CAJA_HISTORIAL_MESES_ATRAS);
    const hasta = query.hasta ?? null;
    // Fecha de pared REAL (Date.parse acepta '2026-02-31' y lo desborda a
    // marzo): se exige que el calendario devuelva el mismo día.
    const valida = (d: string) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
      if (!m) return false;
      const dt = new Date(
        Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
      );
      return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
    };
    if (!valida(desdePedido) || (hasta !== null && !valida(hasta))) {
      throw new BadRequestException(
        'desde/hasta deben ser fechas válidas YYYY-MM-DD.',
      );
    }
    if (hasta !== null && hasta < desdePedido) {
      throw new BadRequestException(
        'hasta debe ser igual o posterior a desde.',
      );
    }
    // INICIO OFICIAL (invariante 86, auditoría 16-oct-2026, 0.0.85): la
    // VENTANA sube al inicio (la validación de arriba usa lo pedido: un
    // rango anterior sale vacío, nunca 400). El corrido (`saldo_despues`,
    // `por_reponer_despues`) se sigue calculando con el libro COMPLETO.
    const desde =
      pisoDia(desdePedido, await inicioOficialDe(this.configuracion)) ??
      desdePedido;

    const { data: fondo, error } = await this.supabase.service
      .from('caja_chica_fondo')
      .select(FONDO_COLS)
      .eq('usuario_id', userId)
      .eq('activo', true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!fondo) {
      return {
        fondo: null,
        desde,
        hasta,
        count: 0,
        limit,
        truncado: false,
        movimientos: [],
      };
    }

    const fo = fondo as FondoRow;
    const { movs, efectivo, historial } = await this.cargarLibro(fo);
    const esAcumulada = fo.es_acumulada === true;
    const asignado = round2(Number(fo.monto_fondo ?? 0));
    const saldoLibro =
      historial.length > 0 ? historial[historial.length - 1].saldo : 0;
    // Mismo `saldo` que GET /caja-chica/me (acumulada: positivo = por reponer).
    const saldo = saldoCaja(movs as CajaMov[], efectivo, esAcumulada);
    const entregadoTotal = round2(
      movs.reduce((acc, m) => acc + efectoMovimientoCaja(m as CajaMov), 0),
    );
    const gastadoTotal = round2(
      efectivo.reduce((acc, g) => acc + Number(g.monto), 0),
    );
    const { usado, disponible } = lecturaFondo({
      saldo,
      asignado,
      entregadoTotal,
      gastadoTotal,
      esAcumulada,
    });
    const porReponer = porReponerCaja(saldoLibro, entregadoTotal, {
      esAcumulada,
      montoFondo: fo.monto_fondo ?? null,
    });

    const enVentana = historial.filter(
      (e) => e.fecha >= desde && (hasta === null || e.fecha <= hasta),
    );
    const recientes = [...enVentana].reverse().slice(0, limit);

    return {
      fondo: {
        id: fo.id,
        moneda: fo.moneda,
        es_acumulada: esAcumulada,
        monto_fondo: asignado > 0 ? asignado : null,
        saldo,
        saldo_libro: saldoLibro,
        por_reponer: porReponer,
        usado,
        disponible,
        asignado,
        ultima_reposicion: this.ultimaReposicion(movs as CajaMov[]),
      },
      desde,
      hasta,
      count: enVentana.length,
      limit,
      truncado: enVentana.length > limit,
      movimientos: recientes.map((e) => ({
        id: e.id,
        origen: e.origen,
        tipo: e.tipo,
        // Fecha de pared YYYY-MM-DD (columna `date`): la app agrupa por este
        // día tal cual, sin convertir zona (diaDesdeFechaSimple).
        fecha: e.fecha,
        created_at: e.created_at,
        monto: e.monto,
        moneda: e.moneda,
        concepto: CONCEPTO_CAJA[e.tipo] ?? e.tipo,
        descripcion: e.descripcion,
        nota: e.notas,
        referencia: e.referencia,
        categoria: e.categoria,
        categoria_label: e.categoria
          ? etiquetaCategoriaGasto(e.categoria)
          : null,
        lugar: e.lugar,
        folio_vuelo: e.vuelo_folio,
        vuelo_id: e.vuelo_id,
        gasto_id: e.origen === 'gasto' ? e.id : null,
        movimiento_id: e.origen === 'caja' ? e.id : null,
        saldo_despues: e.saldo,
        por_reponer_despues: e.por_reponer,
        registrado_por_nombre: e.registrado_por_nombre,
        autorizado_por_nombre: e.autorizado_por_nombre,
        // ADITIVO (19-oct-2026, invariante 93), solo gastos y con la
        // migración: en el libro un gasto siempre está PAGADO.
        ...(e.origen === 'gasto' && e.estado_pago
          ? { por_pagar: e.por_pagar === true, estado_pago: e.estado_pago }
          : {}),
      })),
    };
  }

  // ===== Excel de la REPOSICIÓN (24-sep-2026) =====

  /**
   * `GET /v1/caja-chica/movimientos/:id/reposicion.xlsx`: lo que ESA
   * reposición repuso — los gastos (y reintegros/ajustes) del libro entre la
   * reposición anterior y ésta, en el orden del historial y con el saldo que
   * el historial ya trae por fila. 404 si el movimiento no existe; 409
   * `MOVIMIENTO_NO_ES_REPOSICION` si es un reintegro/ajuste.
   */
  async reposicionXlsx(
    movimientoId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const { data: mov, error } = await this.supabase.service
      .from('caja_chica_movimiento')
      .select('id, fondo_id, tipo')
      .eq('id', movimientoId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!mov) {
      throw new NotFoundException('Ese movimiento de caja chica ya no existe.');
    }
    const tipo = (mov as { tipo: string }).tipo;
    if (tipo !== TIPO_REPOSICION) {
      throw new ConflictException({
        message: `Solo las reposiciones tienen Excel de lo repuesto; este movimiento es «${CONCEPTO_CAJA[tipo] ?? tipo}».`,
        error: 'MOVIMIENTO_NO_ES_REPOSICION',
        details: { movimiento_id: movimientoId, tipo },
      });
    }
    const fondo = (await this.findFondo(
      (mov as { fondo_id: string }).fondo_id,
    )) as FondoRow;
    const { historial } = await this.cargarLibro(fondo);
    const tramo = tramoDeReposicion(historial, movimientoId);
    if (!tramo) {
      // Imposible con un libro íntegro (la reposición es del mismo fondo):
      // si pasa, mejor un error claro que un Excel con otro periodo.
      throw new ConflictException({
        message:
          'No se encontró la reposición dentro del libro del fondo; recarga e intenta de nuevo.',
        error: 'REPOSICION_FUERA_DEL_LIBRO',
        details: { movimiento_id: movimientoId },
      });
    }
    return this.excelDeTramo('reposicion', fondo, tramo);
  }

  /**
   * `GET /v1/caja-chica/fondos/:id/por-reponer.xlsx`: el MISMO formato para
   * lo PENDIENTE hoy (desde la última reposición hasta el final del libro)
   * — para descargarlo ANTES de registrar la reposición.
   */
  async porReponerXlsx(
    fondoId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const fondo = (await this.findFondo(fondoId)) as FondoRow;
    const { historial } = await this.cargarLibro(fondo);
    const tramo = tramoDeReposicion(historial, null)!;
    return this.excelDeTramo('pendiente', fondo, tramo);
  }

  private async excelDeTramo(
    modo: ModoExcelCaja,
    fondo: FondoRow,
    tramo: TramoReposicion<EntradaLibro>,
  ): Promise<{ buffer: Buffer; filename: string }> {
    if (!this.pyservices) {
      throw new ServiceUnavailableException(
        'El generador de Excel no está disponible en este momento.',
      );
    }
    const origenId = (fondo as { fondo_origen_id?: string | null })
      .fondo_origen_id;
    const idsGastos = tramo.gastos.map((g) => g.id);
    const [extras, madre, marcadosPagados] = await Promise.all([
      this.extrasDeGastos(idsGastos),
      origenId ? this.nombreDeFondo(origenId) : Promise.resolve(null),
      // Solo UNA reposición tiene contra qué comparar (lo pendiente, no).
      modo === 'reposicion'
        ? marcadosPagadosEnBitacora(
            this.supabase.service,
            idsGastos,
            this.logger,
          )
        : Promise.resolve(new Map<string, string>()),
    ]);
    const monto = Number(fondo.monto_fondo ?? 0);
    const { payload, filename } = armarExcelCaja({
      modo,
      fondo: {
        responsable: nombreEmbed(fondo.usuario) ?? 'Sin nombre',
        moneda: fondo.moneda,
        es_acumulada: fondo.es_acumulada === true,
        monto_fondo: Number.isFinite(monto) && monto > 0 ? monto : null,
        caja_madre: madre,
      },
      tramo,
      extras,
      hoy: hoyCancun(),
      ahora: new Date(),
      marcadosPagados,
    });
    // Hoja dedicada de pyservices; si ese pyservices todavía no tiene el
    // endpoint (deploy desfasado ⇒ null), el MISMO contenido en el export
    // genérico ya desplegado. Nunca un 502 por el orden de los deploys.
    const buffer =
      (await this.pyservices.generateCajaChicaReposicionXlsx(payload)) ??
      (await this.pyservices.generateTablaXlsx(tablaXlsxDeCaja(payload)));
    return { buffer, filename };
  }

  /** Comprobante, facturación, matrícula y quién/cuándo capturó, por id. */
  private async extrasDeGastos(
    ids: string[],
  ): Promise<Map<string, ExtraGastoXlsx>> {
    const out = new Map<string, ExtraGastoXlsx>();
    const unicos = [...new Set(ids)];
    for (let i = 0; i < unicos.length; i += LOTE_IDS) {
      const { data, error } = await this.supabase.service
        .from('gasto')
        .select(GASTO_XLSX_COLS)
        .in('id', unicos.slice(i, i + LOTE_IDS));
      // Un Excel a medias sería peor que un error: el reporte es la prueba
      // de lo que se repuso.
      if (error) throw new Error(error.message);
      for (const g of (data ?? []) as Array<Record<string, unknown>>) {
        const aeronave = unwrapEmbed<{ matricula?: unknown }>(g.aeronave);
        out.set(g.id as string, {
          estatus_comprobante: (g.estatus_comprobante as string | null) ?? null,
          estatus_facturacion: (g.estatus_facturacion as string | null) ?? null,
          matricula:
            typeof aeronave?.matricula === 'string' ? aeronave.matricula : null,
          capturo: nombreEmbed(g.creador),
          capturado_en: (g.capturado_en as string | null) ?? null,
          created_at: (g.created_at as string | null) ?? null,
        });
      }
    }
    return out;
  }
}
