import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  CONCEPTO_CAJA,
  TIPO_GASTO_CAJA,
  efectoMovimientoCaja,
  historialConSaldo,
  lecturaFondo,
  porReponerCaja,
  round2,
  saldoCaja,
  type EntradaConSaldo,
  type EntradaHistorialCaja,
} from '../../common/caja-chica-saldo.util';
import { etiquetaCategoriaGasto } from '../../common/categoria-gasto.util';
import { hoyCancun, restarMeses } from '../../common/fecha-cancun.util';
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
};

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
  constructor(private readonly supabase: SupabaseService) {}

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
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('usuario_captura_id, monto, moneda')
      .eq('medio_pago', 'EFECTIVO')
      .in('usuario_captura_id', usuarioIds);
    if (error) throw new Error(error.message);
    for (const g of data ?? []) {
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
  }> {
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
          'id, monto, moneda, fecha_gasto, categoria, lugar, notas, vuelo_id, created_at, vuelo:vuelo_id(folio)',
        )
        .eq('medio_pago', 'EFECTIVO')
        .eq('usuario_captura_id', fondo.usuario_id),
    ]);
    // El saldo es dinero: nunca calcularlo con datos parciales.
    if (movsRes.error) throw new Error(movsRes.error.message);
    if (gastosRes.error) throw new Error(gastosRes.error.message);
    const movs = (movsRes.data ?? []) as Record<string, unknown>[];
    const efectivo = (
      (gastosRes.data ?? []) as Record<string, unknown>[]
    ).filter((g) => g.moneda === fondo.moneda);
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
    };
  }

  /** Detalle con historial unificado (movimientos + gastos efectivo) y saldo corrido. */
  async getFondoDetail(id: string) {
    const fondo = (await this.findFondo(id)) as FondoRow;
    const { movs, efectivo, historial } = await this.cargarLibro(fondo);
    const ultimo = historial[historial.length - 1];
    const esAcumulada = fondo.es_acumulada === true;

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
        }))
        .reverse(),
      ultima_reposicion: this.ultimaReposicion(movs as CajaMov[]),
    };
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

    const { data, error } = await this.supabase.service
      .from('caja_chica_movimiento')
      .insert({
        fondo_id: fondoId,
        tipo: dto.tipo,
        monto: dto.monto,
        moneda: fondo.moneda,
        fecha: dto.fecha ?? undefined,
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
      .select('id, espejo_de_id')
      .eq('id', id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${id} not found`);
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
    const [movsRes, gastosRes, gastosListaRes] = await Promise.all([
      this.supabase.service
        .from('caja_chica_movimiento')
        .select(MOV_COLS)
        .eq('fondo_id', fo.id)
        .order('fecha', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(20),
      this.supabase.service
        .from('gasto')
        .select('monto, moneda')
        .eq('medio_pago', 'EFECTIVO')
        .eq('usuario_captura_id', userId),
      // La LISTA visible de "mi caja" (la app la pinta agrupada por día,
      // como la nota del cliente): los mismos gastos EFECTIVO que alimentan
      // el saldo, con concepto y folio del vuelo. Recientes primero.
      // `created_at` (aditivo, 1-sep-2026): la app gatea Corregir/Borrar por
      // fecha de CAPTURA (ventana de edición), no por fecha del ticket.
      this.supabase.service
        .from('gasto')
        .select(
          'id, fecha_gasto, monto, moneda, categoria, lugar, notas, vuelo_id, created_at, vuelo:vuelo_id(folio)',
        )
        .eq('medio_pago', 'EFECTIVO')
        .eq('usuario_captura_id', userId)
        .order('fecha_gasto', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(200),
    ]);
    // El saldo es dinero: nunca calcularlo con datos parciales.
    if (movsRes.error) throw new Error(movsRes.error.message);
    if (gastosRes.error) throw new Error(gastosRes.error.message);
    if (gastosListaRes.error) throw new Error(gastosListaRes.error.message);
    const movs = movsRes.data;
    const gastos = gastosRes.data;
    const gastosLista = (gastosListaRes.data ?? []).map((g) => {
      const vuelo = (Array.isArray(g.vuelo) ? g.vuelo[0] : g.vuelo) as {
        folio?: number;
      } | null;
      const { vuelo: _omit, ...rest } = g as Record<string, unknown>;
      void _omit;
      return { ...rest, folio: vuelo?.folio ?? null };
    });

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
    const desde =
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
    if (!valida(desde) || (hasta !== null && !valida(hasta))) {
      throw new BadRequestException(
        'desde/hasta deben ser fechas válidas YYYY-MM-DD.',
      );
    }
    if (hasta !== null && hasta < desde) {
      throw new BadRequestException(
        'hasta debe ser igual o posterior a desde.',
      );
    }

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
      })),
    };
  }
}
