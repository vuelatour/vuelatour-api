import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { ListPilotsQuery } from './dto/pilots.dto';

const USUARIO_COLS =
  'id, supabase_auth_id, nombre, email, rol, estado, tiene_fondo_caja, tarjeta_terminacion, es_piloto_externo, telefono, avatar_url, created_at, updated_at';

const VUELO_COLS =
  'id, folio, estado, origen_iata, destino_iata, pasajeros, monto_total_usd, fecha_vuelo, cobrado';

@Injectable()
export class PilotsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Lista pilotos (rol=PILOTO) con métricas agregadas: vuelos del mes,
   * próximos, capturas del mes y fecha del último vuelo.
   */
  async list(filters: ListPilotsQuery) {
    let query = this.supabase.service
      .from('usuario')
      .select(USUARIO_COLS, { count: 'exact' })
      .eq('rol', 'PILOTO')
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
          ultimo_vuelo: null,
        },
      })),
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /**
   * Detalle del piloto: perfil + próximos vuelos + actividad reciente.
   */
  async findById(id: string) {
    const { data: pilot, error } = await this.supabase.service
      .from('usuario')
      .select(USUARIO_COLS)
      .eq('id', id)
      .eq('rol', 'PILOTO')
      .maybeSingle();

    if (error) throw new Error(`Failed to load pilot: ${error.message}`);
    if (!pilot) throw new NotFoundException(`Pilot ${id} not found`);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [proximosRes, completadosRes, gastosRes, capturasRes, fondoRes] =
      await Promise.all([
        this.supabase.service
          .from('vuelo')
          .select(VUELO_COLS)
          .eq('piloto_id', id)
          .in('estado', ['CONFIRMADO', 'EN_VUELO'])
          .gte('fecha_vuelo', now.toISOString())
          .order('fecha_vuelo', { ascending: true })
          .limit(5),
        this.supabase.service
          .from('vuelo')
          .select(VUELO_COLS)
          .eq('piloto_id', id)
          .eq('estado', 'COMPLETADO')
          .gte('fecha_vuelo', monthStart)
          .order('fecha_vuelo', { ascending: false })
          .limit(20),
        this.supabase.service
          .from('gasto')
          .select('id, categoria, monto, moneda, fecha_gasto, foto_url, vuelo_id, aeronave_id, created_at')
          .eq('usuario_captura_id', id)
          .gte('fecha_gasto', monthStart.slice(0, 10))
          .order('created_at', { ascending: false })
          .limit(10),
        this.supabase.service
          .from('escala')
          .select('id, vuelo_id, orden, origen_iata, destino_iata, taco_salida, taco_llegada, sincronizado_at, capturado_offline')
          .eq('capturado_por', id)
          .gte('sincronizado_at', monthStart)
          .order('sincronizado_at', { ascending: false })
          .limit(10),
        this.supabase.service
          .from('fondo_caja')
          .select('id, tipo, medio_pago_asociado, monto_asignado, moneda, activo')
          .eq('usuario_id', id)
          .eq('activo', true),
      ]);

    if (proximosRes.error) throw new Error(proximosRes.error.message);
    if (completadosRes.error) throw new Error(completadosRes.error.message);
    if (gastosRes.error) throw new Error(gastosRes.error.message);
    if (capturasRes.error) throw new Error(capturasRes.error.message);
    if (fondoRes.error) throw new Error(fondoRes.error.message);

    const completados = completadosRes.data ?? [];
    const totalCobradoMes = completados
      .filter((v) => v.cobrado)
      .reduce((acc, v) => acc + Number(v.monto_total_usd ?? 0), 0);

    return {
      ...pilot,
      stats: {
        vuelos_mes: completados.length,
        vuelos_proximos: proximosRes.data?.length ?? 0,
        capturas_mes: capturasRes.data?.length ?? 0,
        gastos_mes: gastosRes.data?.length ?? 0,
        total_cobrado_mes_usd: Math.round(totalCobradoMes * 100) / 100,
        ultimo_vuelo: completados[0]?.fecha_vuelo ?? null,
      },
      vuelos_proximos: proximosRes.data ?? [],
      vuelos_completados_mes: completados,
      gastos_recientes: gastosRes.data ?? [],
      capturas_recientes: capturasRes.data ?? [],
      fondos: fondoRes.data ?? [],
    };
  }

  private async bulkStats(pilotIds: string[]): Promise<Map<string, unknown>> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthStartDate = monthStart.slice(0, 10);

    const [vuelosMes, vuelosProximos, capturas, gastos] = await Promise.all([
      this.supabase.service
        .from('vuelo')
        .select('id, piloto_id, fecha_vuelo')
        .in('piloto_id', pilotIds)
        .eq('estado', 'COMPLETADO')
        .gte('fecha_vuelo', monthStart),
      this.supabase.service
        .from('vuelo')
        .select('id, piloto_id')
        .in('piloto_id', pilotIds)
        .in('estado', ['CONFIRMADO', 'EN_VUELO'])
        .gte('fecha_vuelo', now.toISOString()),
      this.supabase.service
        .from('escala')
        .select('id, capturado_por')
        .in('capturado_por', pilotIds)
        .gte('sincronizado_at', monthStart),
      this.supabase.service
        .from('gasto')
        .select('id, usuario_captura_id')
        .in('usuario_captura_id', pilotIds)
        .gte('fecha_gasto', monthStartDate),
    ]);

    const stats = new Map<
      string,
      {
        vuelos_mes: number;
        vuelos_proximos: number;
        capturas_mes: number;
        gastos_mes: number;
        ultimo_vuelo: string | null;
      }
    >();

    for (const id of pilotIds) {
      stats.set(id, {
        vuelos_mes: 0,
        vuelos_proximos: 0,
        capturas_mes: 0,
        gastos_mes: 0,
        ultimo_vuelo: null,
      });
    }

    for (const v of vuelosMes.data ?? []) {
      const s = stats.get(v.piloto_id);
      if (!s) continue;
      s.vuelos_mes += 1;
      if (!s.ultimo_vuelo || (v.fecha_vuelo && v.fecha_vuelo > s.ultimo_vuelo)) {
        s.ultimo_vuelo = v.fecha_vuelo ?? null;
      }
    }
    for (const v of vuelosProximos.data ?? []) {
      const s = stats.get(v.piloto_id);
      if (s) s.vuelos_proximos += 1;
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
}
