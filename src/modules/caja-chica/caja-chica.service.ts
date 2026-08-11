import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  CreateCajaMovimientoDto,
  CreateFondoDto,
  ListFondosQuery,
  MonedaCaja,
  TipoMovimientoCaja,
  UpdateFondoDto,
} from './dto/caja-chica.dto';

const FONDO_COLS =
  'id, usuario_id, moneda, activo, es_acumulada, notas, created_at, updated_at, usuario:usuario!usuario_id(nombre, email, rol)';
const MOV_COLS =
  'id, fondo_id, tipo, monto, moneda, fecha, autorizado_por, referencia, notas, registrado_por, created_at';

type CajaMov = { tipo: string; monto: number | string };
type EfectivoGasto = { monto: number | string };

@Injectable()
export class CajaChicaService {
  constructor(private readonly supabase: SupabaseService) {}

  /** Efecto con signo de un movimiento de caja. AJUSTE conserva su signo. */
  private signed(m: CajaMov): number {
    const monto = Number(m.monto);
    return m.tipo === TipoMovimientoCaja.REINTEGRO ? -monto : monto;
  }

  /**
   * Saldo del fondo. Modo clásico: lo entregado menos lo gastado. Modo
   * ACUMULADO (es_acumulada, pedido 6 ago 2026): el número es lo POR REPONER
   * al usuario — sube con cada gasto en efectivo y las REPOSICIONES lo
   * regresan a cero. Es el mismo cálculo con el signo invertido; una sola
   * fórmula para que jamás diverjan.
   */
  private saldoFromParts(
    movs: CajaMov[],
    efectivo: EfectivoGasto[],
    esAcumulada = false,
  ): number {
    const movTotal = movs.reduce((s, m) => s + this.signed(m), 0);
    const efectivoTotal = efectivo.reduce((s, g) => s + Number(g.monto), 0);
    const saldo = round(movTotal - efectivoTotal, 2);
    return esAcumulada ? round(-saldo, 2) : saldo;
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
        saldo: this.saldoFromParts(
          movsByFondo.get(fo.id) ?? [],
          efectivo,
          fo.es_acumulada === true,
        ),
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
      .select('fondo_id, tipo, monto')
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

  /** Detalle con historial unificado (movimientos + gastos efectivo) y saldo corrido. */
  async getFondoDetail(id: string) {
    const fondo = (await this.findFondo(id)) as Record<string, unknown> & {
      id: string;
      usuario_id: string;
      moneda: string;
    };

    const [movsRes, gastosRes] = await Promise.all([
      this.supabase.service
        .from('caja_chica_movimiento')
        .select(
          `${MOV_COLS}, autorizado:usuario!autorizado_por(nombre), registrado:usuario!registrado_por(nombre)`,
        )
        .eq('fondo_id', id),
      this.supabase.service
        .from('gasto')
        // vuelo:vuelo_id(folio) — el historial enlaza al vuelo del gasto: la
        // oficina audita "¿de qué vuelo salió este efectivo?" sin buscarlo.
        .select(
          'id, monto, moneda, fecha_gasto, categoria, notas, foto_url, vuelo_id, vuelo:vuelo_id(folio)',
        )
        .eq('medio_pago', 'EFECTIVO')
        .eq('usuario_captura_id', fondo.usuario_id),
    ]);
    // El saldo es dinero: nunca calcularlo con datos parciales.
    if (movsRes.error) throw new Error(movsRes.error.message);
    if (gastosRes.error) throw new Error(gastosRes.error.message);
    const movs = movsRes.data;
    const gastos = gastosRes.data;

    const efectivo = (gastos ?? []).filter(
      (g) => (g as { moneda: string }).moneda === fondo.moneda,
    );

    type Entry = {
      id: string;
      fecha: string;
      origen: 'caja' | 'gasto';
      tipo: string;
      monto: number;
      descripcion: string | null;
      created_at: string;
      /** Vuelo del gasto (si lo tiene): el panel enlaza a su detalle. */
      vuelo_id: string | null;
      vuelo_folio: number | null;
    };

    const entries: Entry[] = [
      ...(movs ?? []).map((m) => {
        const mm = m as Record<string, unknown> & {
          id: string;
          tipo: string;
          fecha: string;
          created_at: string;
          notas: string | null;
          referencia: string | null;
        };
        return {
          id: mm.id,
          fecha: mm.fecha,
          origen: 'caja' as const,
          tipo: mm.tipo,
          monto: this.signed(mm as unknown as CajaMov),
          descripcion: mm.notas ?? mm.referencia ?? null,
          created_at: mm.created_at,
          vuelo_id: null,
          vuelo_folio: null,
        };
      }),
      ...efectivo.map((g) => {
        const gg = g as Record<string, unknown> & {
          id: string;
          fecha_gasto: string;
          categoria: string;
          notas: string | null;
          monto: number | string;
          vuelo_id: string | null;
          vuelo: { folio: number } | { folio: number }[] | null;
        };
        // PostgREST devuelve el embed como objeto o arreglo según la relación.
        const vuelo = Array.isArray(gg.vuelo) ? gg.vuelo[0] : gg.vuelo;
        return {
          id: gg.id,
          fecha: gg.fecha_gasto,
          origen: 'gasto' as const,
          tipo: 'GASTO',
          monto: -Number(gg.monto),
          descripcion: gg.notas ?? gg.categoria,
          created_at: gg.fecha_gasto,
          vuelo_id: gg.vuelo_id ?? null,
          vuelo_folio: vuelo?.folio ?? null,
        };
      }),
    ];

    // Saldo corrido en orden cronológico ascendente.
    entries.sort((a, b) =>
      a.fecha !== b.fecha
        ? a.fecha < b.fecha
          ? -1
          : 1
        : a.created_at < b.created_at
          ? -1
          : a.created_at > b.created_at
            ? 1
            : 0,
    );
    let corrido = 0;
    const historialAsc = entries.map((e) => {
      corrido = round(corrido + e.monto, 2);
      return { ...e, saldo: corrido };
    });

    return {
      ...fondo,
      saldo: corrido,
      movimientos: movs ?? [],
      historial: historialAsc.reverse(),
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
    const { data, error } = await this.supabase.service
      .from('caja_chica_fondo')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select(FONDO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Fondo ${id} not found`);
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
    return data!;
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
      this.supabase.service
        .from('gasto')
        .select(
          'id, fecha_gasto, monto, moneda, categoria, lugar, notas, vuelo_id, vuelo:vuelo_id(folio)',
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
    const saldo = this.saldoFromParts(
      allMovs.data ?? [],
      efectivo,
      (fo as { es_acumulada?: boolean }).es_acumulada === true,
    );

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
      ([moneda, total]) => ({ moneda, total: round(total) }),
    );

    return {
      fondo,
      saldo,
      movimientos: movs ?? [],
      gastos: gastosLista,
      efectivo_otras_monedas: efectivoOtrasMonedas,
    };
  }
}

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}
