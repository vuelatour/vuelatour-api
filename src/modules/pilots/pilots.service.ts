import { NotificationsService } from '../realtime/notifications.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import { SupabaseService } from '../supabase/supabase.service';
import { CalendarSyncService } from '../calendar/calendar-sync.service';
import { UsersService } from '../users/users.service';
import type {
  CreateDescansoDto,
  CreatePilotoExternoDto,
  ListDescansosQuery,
  ListPilotsQuery,
} from './dto/pilots.dto';

const USUARIO_COLS =
  'id, supabase_auth_id, nombre, email, rol, estado, tiene_fondo_caja, tarjeta_terminacion, es_piloto_externo, telefono, avatar_url, created_at, updated_at';

const VUELO_COLS =
  'id, folio, estado, origen_iata, destino_iata, pasajeros, monto_total_usd, tc_usd_mxn, fecha_vuelo, fecha_fin, cobrado, piloto_id, copiloto_id, apoyo_id';

@Injectable()
export class PilotsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly calendarSync: CalendarSyncService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Hoy en hora Cancún (YYYY-MM-DD) — la operación vive en UTC−5. */
  private hoyCancun(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Cancun',
    }).format(new Date());
  }

  /** Corte del MES CORRIENTE en hora Cancún (invariante #4: nunca el mes del
   *  servidor — Railway corre en UTC y movía la noche del 31 al mes
   *  siguiente). */
  private mesActualCancun(): { desdeTs: string; desdeFecha: string } {
    const ym = this.hoyCancun().slice(0, 7);
    return { desdeTs: `${ym}-01T00:00:00-05:00`, desdeFecha: `${ym}-01` };
  }

  /** Rango COMPLETO de un mes (YYYY-MM) en hora Cancún; inválido/ausente =
   *  mes corriente. Permite consultar estadísticas de meses pasados. */
  private rangoMesCancun(mes?: string): {
    ym: string;
    desdeTs: string;
    hastaTs: string;
    desdeFecha: string;
    hastaFecha: string;
  } {
    const ym = /^\d{4}-(0[1-9]|1[0-2])$/.test(mes ?? '')
      ? (mes as string)
      : this.hoyCancun().slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const hastaFecha = `${ym}-${String(ultimoDia).padStart(2, '0')}`;
    return {
      ym,
      desdeTs: `${ym}-01T00:00:00-05:00`,
      hastaTs: `${hastaFecha}T23:59:59-05:00`,
      desdeFecha: `${ym}-01`,
      hastaFecha,
    };
  }

  /**
   * Condición OR de vuelos donde el usuario participa en CUALQUIER rol:
   * piloto del vuelo, copiloto, APOYO o piloto de algún TRAMO (p. ej. solo el
   * regreso de un redondo). MISMO criterio que GET /v1/flights?piloto_id —
   * sin esto, el expediente decía 0 vuelos para pilotos de rotación.
   */
  private async orRolesPiloto(id: string): Promise<string> {
    const { data: legVuelos } = await this.supabase.service
      .from('escala')
      .select('vuelo_id')
      .eq('piloto_id', id);
    const ids = [
      ...new Set((legVuelos ?? []).map((e) => e.vuelo_id as string)),
    ];
    const ors = [
      `piloto_id.eq.${id}`,
      `copiloto_id.eq.${id}`,
      `apoyo_id.eq.${id}`,
    ];
    if (ids.length) ors.push(`id.in.(${ids.join(',')})`);
    return ors.join(',');
  }

  /** Rol del usuario en un vuelo (para etiquetarlo en el expediente). */
  private rolEnVuelo(
    v: { piloto_id?: unknown; copiloto_id?: unknown; apoyo_id?: unknown },
    id: string,
  ): 'PILOTO' | 'COPILOTO' | 'APOYO' | 'TRAMO' {
    if (v.piloto_id === id) return 'PILOTO';
    if (v.copiloto_id === id) return 'COPILOTO';
    if (v.apoyo_id === id) return 'APOYO';
    return 'TRAMO';
  }

  /**
   * Lista pilotos (rol=PILOTO) con métricas agregadas: vuelos del mes,
   * próximos, capturas del mes y fecha del último vuelo.
   */
  async list(filters: ListPilotsQuery) {
    let query = this.supabase.service
      .from('usuario')
      .select(USUARIO_COLS, { count: 'exact' })
      .or('rol.eq.PILOTO,es_piloto.eq.true')
      .order('nombre', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.estado) query = query.eq('estado', filters.estado);
    if (typeof filters.externo === 'boolean') {
      query = query.eq('es_piloto_externo', filters.externo);
    }
    if (filters.q) {
      const term = `%${filters.q}%`;
      query = query.or(`nombre.ilike.${term},email.ilike.${term}`);
    }

    const { data: pilots, error, count } = await query;
    if (error) throw new Error(`Failed to list pilots: ${error.message}`);

    const ids = (pilots ?? []).map((p) => p.id);
    const stats = ids.length > 0 ? await this.bulkStats(ids) : new Map();

    return {
      data: (pilots ?? []).map((p) => ({
        ...p,
        stats: stats.get(p.id) ?? {
          vuelos_mes: 0,
          vuelos_proximos: 0,
          capturas_mes: 0,
          gastos_mes: 0,
          horas_mes: 0,
          ultimo_vuelo: null,
        },
      })),
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /**
   * Alta de piloto EXTERNO (doc 3.7): fila en usuario rol PILOTO con
   * es_piloto_externo=true, estado ACTIVO y SIN cuenta de auth — entra a los
   * selectores de asignación pero jamás puede loguearse (la allowlist de
   * signup y el enlace por email lo excluyen) ni recibe notificaciones.
   */
  async createExterno(dto: CreatePilotoExternoDto, createdBy: string) {
    const nombre = dto.nombre.trim();
    if (nombre.length < 2) {
      throw new BadRequestException(
        'El nombre del piloto externo es obligatorio',
      );
    }
    // Sin email no hay unicidad en BD: se evita el duplicado obvio por nombre.
    const { data: dup, error: dupErr } = await this.supabase.service
      .from('usuario')
      .select('id')
      .eq('es_piloto_externo', true)
      .neq('estado', 'INACTIVO')
      .ilike('nombre', nombre)
      .limit(1)
      .maybeSingle();
    if (dupErr) throw new Error(dupErr.message);
    if (dup) {
      throw new ConflictException(
        `Ya existe un piloto externo llamado "${nombre}". Si es otra persona, distínguelo (ej. apellido).`,
      );
    }
    const { data, error } = await this.supabase.service
      .from('usuario')
      .insert({
        nombre,
        email: dto.email?.trim() ? dto.email.trim().toLowerCase() : null,
        rol: 'PILOTO',
        estado: 'ACTIVO',
        es_piloto: true,
        es_piloto_externo: true,
        tiene_fondo_caja: false,
        telefono: dto.telefono ?? '',
        avatar_url: '',
        created_by: createdBy,
        updated_by: createdBy,
      })
      .select(USUARIO_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          `Ya existe un usuario con el email ${dto.email}`,
        );
      throw new Error(error.message);
    }
    return data!;
  }

  /**
   * Detalle del piloto: perfil + próximos vuelos + actividad reciente.
   */
  async findById(id: string, mes?: string) {
    const { data: pilot, error } = await this.supabase.service
      .from('usuario')
      .select(USUARIO_COLS)
      .eq('id', id)
      .or('rol.eq.PILOTO,es_piloto.eq.true')
      .maybeSingle();

    if (error) throw new Error(`Failed to load pilot: ${error.message}`);
    if (!pilot) throw new NotFoundException(`Pilot ${id} not found`);

    // Las stats son DEL MES elegido (?mes=YYYY-MM; default mes corriente):
    // el expediente permite revisar meses pasados. Activos/próximos y las
    // listas de recientes no dependen del mes.
    const { ym, desdeTs, hastaTs, desdeFecha, hastaFecha } =
      this.rangoMesCancun(mes);
    const hoy = this.hoyCancun();
    const hoyTs = `${hoy}T00:00:00-05:00`;
    const orRoles = await this.orRolesPiloto(id);
    const esExterno =
      (pilot as { es_piloto_externo?: boolean }).es_piloto_externo === true;

    const [
      activosRes,
      completadosRes,
      completadosMesRes,
      gastosRes,
      gastosCountRes,
      capturasRes,
      capturasCountRes,
      fondoRes,
      descansosRes,
      horas,
    ] = await Promise.all([
      // ACTIVOS Y PRÓXIMOS: EN_VUELO siempre (un vuelo en curso ya despegó y
      // desaparecía del expediente) + confirmados/reservas cuyo VIAJE aún no
      // termina — eje [fecha_vuelo, fecha_fin] para multi-día.
      this.supabase.service
        .from('vuelo')
        .select(VUELO_COLS)
        .or(orRoles)
        .in('estado', ['RESERVA', 'CONFIRMADO', 'EN_VUELO'])
        .or(
          `estado.eq.EN_VUELO,fecha_vuelo.gte.${hoyTs},fecha_fin.gte.${hoyTs}`,
        )
        .order('fecha_vuelo', { ascending: true })
        .limit(5),
      // Historial visible (recientes SIN acotar al mes: el expediente antes
      // quedaba vacío el día 1). El corte de mes vive en los COUNTS.
      this.supabase.service
        .from('vuelo')
        .select(VUELO_COLS)
        .or(orRoles)
        .eq('estado', 'COMPLETADO')
        .order('fecha_vuelo', { ascending: false })
        .limit(20),
      // Completados del MES para stats y cobrado (ids completos, no top-20).
      this.supabase.service
        .from('vuelo')
        .select('id, tc_usd_mxn, fecha_vuelo')
        .or(orRoles)
        .eq('estado', 'COMPLETADO')
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs)
        .limit(1000),
      this.supabase.service
        .from('gasto')
        .select(
          'id, categoria, monto, moneda, fecha_gasto, foto_url, vuelo_id, aeronave_id, created_at',
        )
        .eq('usuario_captura_id', id)
        .order('created_at', { ascending: false })
        .limit(10),
      // Los COUNTS de stats van aparte con count exacto: derivarlos de las
      // listas recortadas topaba el mes en 10/10/20 y contradecía la lista.
      this.supabase.service
        .from('gasto')
        .select('id', { count: 'exact', head: true })
        .eq('usuario_captura_id', id)
        .gte('fecha_gasto', desdeFecha)
        .lte('fecha_gasto', hastaFecha),
      this.supabase.service
        .from('escala')
        .select(
          'id, vuelo_id, orden, origen_iata, destino_iata, taco_salida, taco_llegada, sincronizado_at, capturado_offline',
        )
        .eq('capturado_por', id)
        .order('sincronizado_at', { ascending: false })
        .limit(10),
      this.supabase.service
        .from('escala')
        .select('id', { count: 'exact', head: true })
        .eq('capturado_por', id)
        .gte('sincronizado_at', desdeTs)
        .lte('sincronizado_at', hastaTs),
      this.supabase.service
        .from('fondo_caja')
        .select('id, tipo, medio_pago_asociado, monto_asignado, moneda, activo')
        .eq('usuario_id', id)
        .eq('activo', true),
      // Descansos vigentes o futuros: al asignar vuelos importa saberlos aquí.
      this.supabase.service
        .from('piloto_descanso')
        .select('id, fecha_inicio, fecha_fin, motivo')
        .eq('piloto_id', id)
        .gte('fecha_fin', hoy)
        .order('fecha_inicio', { ascending: true })
        .limit(5),
      // Horas del mes (Cancún, por tramo con herencia): fuente única
      // users.horasDelMes — la misma del dashboard y de /me/horas.
      this.users.horasDelMes(id, ym),
    ]);

    if (activosRes.error) throw new Error(activosRes.error.message);
    if (completadosRes.error) throw new Error(completadosRes.error.message);
    if (completadosMesRes.error)
      throw new Error(completadosMesRes.error.message);
    if (gastosRes.error) throw new Error(gastosRes.error.message);
    if (gastosCountRes.error) throw new Error(gastosCountRes.error.message);
    if (capturasRes.error) throw new Error(capturasRes.error.message);
    if (capturasCountRes.error) throw new Error(capturasCountRes.error.message);
    if (fondoRes.error) throw new Error(fondoRes.error.message);
    if (descansosRes.error) throw new Error(descansosRes.error.message);

    // Cobrado del mes = DINERO RECIBIDO vía cobrosEnUsd (fuente única,
    // invariante #2) — antes sumaba el precio cotizado de los marcados
    // cobrados: los parciales contaban $0 y luego el precio completo.
    const vuelosMes = completadosMesRes.data ?? [];
    let totalCobradoMes = 0;
    let cobradoSinTcMxn = 0;
    if (vuelosMes.length > 0) {
      const { data: cobros, error: cobrosErr } = await this.supabase.service
        .from('cobro_vuelo')
        .select('vuelo_id, monto, moneda, tc_usd_mxn')
        .in(
          'vuelo_id',
          vuelosMes.map((v) => v.id as string),
        );
      if (cobrosErr) throw new Error(cobrosErr.message);
      const porVuelo = new Map<string, typeof cobros>();
      for (const c of cobros ?? []) {
        const list = porVuelo.get(c.vuelo_id as string) ?? [];
        list.push(c);
        porVuelo.set(c.vuelo_id as string, list);
      }
      for (const v of vuelosMes) {
        const conv = cobrosEnUsd(
          porVuelo.get(v.id as string) ?? [],
          v.tc_usd_mxn == null ? null : Number(v.tc_usd_mxn),
        );
        totalCobradoMes += conv.total_usd;
        cobradoSinTcMxn += conv.sin_tc_mxn;
      }
    }

    // Honorarios del piloto EXTERNO: gastos categoría PILOTO_EXTERNO ligados
    // a SUS vuelos (los captura oficina — doc 3.7 "se les paga la tarifa que
    // ellos dictan"). Sin esto su expediente quedaba casi vacío.
    let honorarios: {
      total_usd: number;
      mes_usd: number;
      sin_tc_mxn: number;
      recientes: unknown[];
    } | null = null;
    if (esExterno) {
      const { data: vuelosTodos } = await this.supabase.service
        .from('vuelo')
        .select('id, folio')
        .or(orRoles)
        .limit(1000);
      const folios = new Map<string, number | null>(
        (vuelosTodos ?? []).map((v) => [
          v.id as string,
          (v.folio as number | null) ?? null,
        ]),
      );
      const ids = (vuelosTodos ?? []).map((v) => v.id as string);
      if (ids.length > 0) {
        const { data: pagos, error: pagosErr } = await this.supabase.service
          .from('gasto')
          .select('id, monto, moneda, tc_gasto, fecha_gasto, vuelo_id')
          .eq('categoria', 'PILOTO_EXTERNO')
          .in('vuelo_id', ids)
          .order('fecha_gasto', { ascending: false })
          .limit(1000);
        if (pagosErr) throw new Error(pagosErr.message);
        let total = 0;
        let mes = 0;
        let sinTc = 0;
        for (const p of pagos ?? []) {
          const usd =
            p.moneda === 'USD'
              ? Number(p.monto)
              : Number(p.tc_gasto) > 0
                ? Number(p.monto) / Number(p.tc_gasto)
                : null;
          if (usd === null) {
            sinTc += Number(p.monto);
            continue;
          }
          total += usd;
          const f = p.fecha_gasto as string;
          if (f >= desdeFecha && f <= hastaFecha) mes += usd;
        }
        honorarios = {
          total_usd: Math.round(total * 100) / 100,
          mes_usd: Math.round(mes * 100) / 100,
          sin_tc_mxn: Math.round(sinTc * 100) / 100,
          recientes: (pagos ?? []).slice(0, 10).map((p) => ({
            ...p,
            folio: folios.get(p.vuelo_id as string) ?? null,
          })),
        };
      } else {
        honorarios = { total_usd: 0, mes_usd: 0, sin_tc_mxn: 0, recientes: [] };
      }
    }

    const conRol = (v: Record<string, unknown>) => ({
      ...v,
      rol: this.rolEnVuelo(v, id),
    });
    const completados = (completadosRes.data ?? []).map(conRol);

    return {
      ...pilot,
      stats: {
        mes: ym,
        vuelos_mes: vuelosMes.length,
        vuelos_proximos: activosRes.data?.length ?? 0,
        capturas_mes: capturasCountRes.count ?? 0,
        gastos_mes: gastosCountRes.count ?? 0,
        total_cobrado_mes_usd: Math.round(totalCobradoMes * 100) / 100,
        cobrado_sin_tc_mxn: Math.round(cobradoSinTcMxn * 100) / 100,
        ultimo_vuelo:
          vuelosMes.length > 0
            ? (vuelosMes
                .map((v) => v.fecha_vuelo as string)
                .sort()
                .at(-1) ?? null)
            : ((completados[0] as { fecha_vuelo?: string | null } | undefined)
                ?.fecha_vuelo ?? null),
        horas_mes: horas.horas,
        horas_limite: horas.limite,
        horas_restantes: horas.restantes,
      },
      vuelos_proximos: (activosRes.data ?? []).map(conRol),
      vuelos_completados_mes: completados,
      gastos_recientes: gastosRes.data ?? [],
      capturas_recientes: capturasRes.data ?? [],
      fondos: fondoRes.data ?? [],
      descansos_proximos: descansosRes.data ?? [],
      honorarios,
    };
  }

  private async bulkStats(pilotIds: string[]): Promise<Map<string, unknown>> {
    // Cortes en hora CANCÚN (invariante #4) — antes el mes empezaba en la
    // medianoche UTC del servidor y la noche del 31 caía en el mes siguiente.
    const { desdeTs, desdeFecha } = this.mesActualCancun();
    const hoyTs = `${this.hoyCancun()}T00:00:00-05:00`;

    const [vuelosMes, vuelosProximos, capturas, gastos, escalasHoras] =
      await Promise.all([
        // Sin filtrar por piloto: la flota vuela pocos vuelos al mes y así se
        // cuentan también copiloto/apoyo/tramo (mismo criterio del expediente).
        this.supabase.service
          .from('vuelo')
          .select(
            'id, piloto_id, copiloto_id, apoyo_id, fecha_vuelo, escalas:escala(piloto_id)',
          )
          .eq('estado', 'COMPLETADO')
          .gte('fecha_vuelo', desdeTs),
        // EN_VUELO cuenta siempre (ya despegó y desaparecía del conteo).
        this.supabase.service
          .from('vuelo')
          .select(
            'id, piloto_id, copiloto_id, apoyo_id, estado, fecha_vuelo, fecha_fin, escalas:escala(piloto_id)',
          )
          .in('estado', ['RESERVA', 'CONFIRMADO', 'EN_VUELO'])
          .or(
            `estado.eq.EN_VUELO,fecha_vuelo.gte.${hoyTs},fecha_fin.gte.${hoyTs}`,
          ),
        this.supabase.service
          .from('escala')
          .select('id, capturado_por')
          .in('capturado_por', pilotIds)
          .gte('sincronizado_at', desdeTs),
        this.supabase.service
          .from('gasto')
          .select('id, usuario_captura_id')
          .in('usuario_captura_id', pilotIds)
          .gte('fecha_gasto', desdeFecha),
        // Horas voladas del mes por piloto (misma regla que users.horasDelMes:
        // piloto del TRAMO con herencia del vuelo, cancelados fuera).
        this.supabase.service
          .from('escala')
          .select(
            'piloto_id, taco_salida, taco_llegada, vuelo:vuelo_id!inner(piloto_id, estado, fecha_vuelo)',
          )
          .neq('vuelo.estado', 'CANCELADO')
          .gte('vuelo.fecha_vuelo', desdeTs),
      ]);

    const stats = new Map<
      string,
      {
        vuelos_mes: number;
        vuelos_proximos: number;
        capturas_mes: number;
        gastos_mes: number;
        horas_mes: number;
        ultimo_vuelo: string | null;
      }
    >();

    for (const id of pilotIds) {
      stats.set(id, {
        vuelos_mes: 0,
        vuelos_proximos: 0,
        capturas_mes: 0,
        gastos_mes: 0,
        horas_mes: 0,
        ultimo_vuelo: null,
      });
    }

    for (const e of escalasHoras.data ?? []) {
      if (e.taco_salida == null || e.taco_llegada == null) continue;
      const h = Number(e.taco_llegada) - Number(e.taco_salida);
      if (!Number.isFinite(h) || h <= 0) continue;
      const vuelo = (Array.isArray(e.vuelo) ? e.vuelo[0] : e.vuelo) as {
        piloto_id?: string | null;
      } | null;
      const pilotoTramo =
        (e.piloto_id as string | null) ?? vuelo?.piloto_id ?? null;
      const s = pilotoTramo ? stats.get(pilotoTramo) : undefined;
      if (s) s.horas_mes = Math.round((s.horas_mes + h) * 10) / 10;
    }

    // Ids de pilotos que participan en un vuelo, en CUALQUIER rol.
    const participantes = (v: Record<string, unknown>): Set<string> => {
      const out = new Set<string>();
      for (const key of ['piloto_id', 'copiloto_id', 'apoyo_id'] as const) {
        const val = v[key];
        if (typeof val === 'string') out.add(val);
      }
      const escalas = (v.escalas ?? []) as Array<{ piloto_id?: string | null }>;
      for (const e of escalas) {
        if (e.piloto_id) out.add(e.piloto_id);
      }
      return out;
    };

    for (const v of vuelosMes.data ?? []) {
      for (const pid of participantes(v)) {
        const s = stats.get(pid);
        if (!s) continue;
        s.vuelos_mes += 1;
        const fecha = (v as { fecha_vuelo?: string | null }).fecha_vuelo;
        if (!s.ultimo_vuelo || (fecha && fecha > s.ultimo_vuelo)) {
          s.ultimo_vuelo = fecha ?? null;
        }
      }
    }
    for (const v of vuelosProximos.data ?? []) {
      for (const pid of participantes(v)) {
        const s = stats.get(pid);
        if (s) s.vuelos_proximos += 1;
      }
    }
    for (const c of capturas.data ?? []) {
      const s = stats.get(c.capturado_por);
      if (s) s.capturas_mes += 1;
    }
    for (const g of gastos.data ?? []) {
      const s = stats.get(g.usuario_captura_id);
      if (s) s.gastos_mes += 1;
    }

    return stats;
  }

  // ===== Descansos (se pintan en el calendario y avisan al asignar) =====

  async listDescansos(q: ListDescansosQuery) {
    let query = this.supabase.service
      .from('piloto_descanso')
      .select(
        'id, piloto_id, fecha_inicio, fecha_fin, motivo, piloto:usuario!piloto_id(nombre)',
      )
      .order('fecha_inicio', { ascending: true });
    if (q.piloto_id) query = query.eq('piloto_id', q.piloto_id);
    // Solapamiento con el rango pedido: inicio <= hasta y fin >= desde.
    if (q.hasta) query = query.lte('fecha_inicio', q.hasta);
    if (q.desde) query = query.gte('fecha_fin', q.desde);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []).map((d) => {
      const piloto = Array.isArray(d.piloto) ? d.piloto[0] : d.piloto;
      return {
        ...d,
        piloto_nombre: (piloto as { nombre?: string } | null)?.nombre ?? null,
      };
    });
  }

  async createDescanso(
    pilotoId: string,
    dto: CreateDescansoDto,
    userId: string,
  ) {
    const inicio = dto.fecha_inicio.slice(0, 10);
    const fin = dto.fecha_fin.slice(0, 10);
    if (fin < inicio) {
      throw new BadRequestException(
        'fecha_fin no puede ser anterior a fecha_inicio',
      );
    }
    const { data, error } = await this.supabase.service
      .from('piloto_descanso')
      .insert({
        piloto_id: pilotoId,
        fecha_inicio: inicio,
        fecha_fin: fin,
        motivo: dto.motivo ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select('id, piloto_id, fecha_inicio, fecha_fin, motivo')
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new NotFoundException('Piloto no encontrado');
      throw new Error(error.message);
    }
    // Auditoría 26-ago: si OFICINA le pone el descanso al piloto, el piloto
    // debe enterarse (si lo capturó él mismo, no se auto-avisa).
    if (pilotoId !== userId) {
      void this.notifications.notifyUser(pilotoId, {
        tipo: 'alerta_sistema',
        titulo: 'Descanso registrado',
        cuerpo: `Del ${inicio} al ${fin}${dto.motivo ? ` · ${dto.motivo}` : ''}. Esos días no se te asignan vuelos.`,
        data: { descanso_id: (data?.id as string) ?? '' },
      });
    }

    // Espejo en el Google Calendar compartido (best-effort, no bloquea).
    void (async () => {
      try {
        const { data: piloto } = await this.supabase.service
          .from('usuario')
          .select('nombre')
          .eq('id', pilotoId)
          .maybeSingle();
        const eventId = await this.calendarSync.upsertDescansoEvent({
          piloto_nombre: (piloto?.nombre as string | undefined) ?? 'Piloto',
          fecha_inicio: inicio,
          fecha_fin: fin,
          motivo: dto.motivo ?? null,
        });
        if (eventId) {
          await this.supabase.service
            .from('piloto_descanso')
            .update({ google_calendar_id: eventId })
            .eq('id', data!.id as string);
        }
      } catch {
        /* best-effort */
      }
    })();

    return data!;
  }

  async deleteDescanso(id: string) {
    const { data, error } = await this.supabase.service
      .from('piloto_descanso')
      .delete()
      .eq('id', id)
      .select('id, google_calendar_id, piloto_id, fecha_inicio, fecha_fin')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Descanso ${id} not found`);
    void this.calendarSync.removeDescansoEvent(
      data.google_calendar_id as string | null,
    );
    // El piloto debe saber que su descanso se quitó (26-ago): esos días
    // vuelve a ser asignable.
    if (data.piloto_id) {
      void this.notifications.notifyUser(data.piloto_id as string, {
        tipo: 'alerta_sistema',
        titulo: 'Descanso eliminado',
        cuerpo: `Se quitó tu descanso del ${data.fecha_inicio as string} al ${data.fecha_fin as string}: esos días ya puedes tener vuelos.`,
        data: { descanso_id: id },
      });
    }
    return { ok: true };
  }
}
