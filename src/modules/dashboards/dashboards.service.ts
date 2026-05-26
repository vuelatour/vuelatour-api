import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import type { OverviewQuery } from './dto/dashboards.dto';

const ABIERTOS = ['SOLICITUD', 'COTIZADO', 'CONFIRMADO', 'EN_VUELO'];

interface VueloPeriodoRow {
  estado: string;
  cliente_id: string;
  monto_total_usd: string | null;
}

@Injectable()
export class DashboardsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly profitSharing: ProfitSharingService,
  ) {}

  /** Tablero ejecutivo: financiero del periodo + pipeline operativo + top clientes. */
  async overview(q: OverviewQuery) {
    if (q.desde > q.hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }

    const [profit, abiertos, vuelosPeriodo] = await Promise.all([
      this.profitSharing.compute({ desde: q.desde, hasta: q.hasta }),
      this.fetchEstadosAbiertos(),
      this.fetchVuelosPeriodo(q.desde, q.hasta),
    ]);

    // Financiero: se agrega del motor de reparto.
    let ingresosCobrados = 0;
    let ingresosPendientes = 0;
    let gastos = 0;
    let saldo = 0;
    const porAvion = profit.aviones.map((a) => {
      const gastosAvion =
        a.gastos.directos_usd +
        a.gastos.indirectos_usd +
        a.gastos.permisos_usd +
        a.gastos.otros_prorrateados_usd +
        a.reserva_overhaul_usd;
      ingresosCobrados += a.ingresos.cobrado_usd;
      ingresosPendientes += a.ingresos.pendiente_cobro_usd;
      gastos += gastosAvion;
      saldo += a.saldo_disponible_usd;
      return {
        aeronave_id: a.aeronave.id,
        matricula: a.aeronave.matricula,
        modelo: a.aeronave.modelo,
        vuelos: a.ingresos.vuelos_cobrados + a.ingresos.vuelos_pendientes,
        ingresos_cobrado_usd: a.ingresos.cobrado_usd,
        gastos_usd: round2(gastosAvion),
        saldo_usd: a.saldo_disponible_usd,
      };
    });

    // Pipeline operativo (estado actual, sin filtro de fecha).
    const pipeline = { solicitud: 0, cotizado: 0, confirmado: 0, en_vuelo: 0 };
    for (const e of abiertos) {
      if (e === 'SOLICITUD') pipeline.solicitud += 1;
      else if (e === 'COTIZADO') pipeline.cotizado += 1;
      else if (e === 'CONFIRMADO') pipeline.confirmado += 1;
      else if (e === 'EN_VUELO') pipeline.en_vuelo += 1;
    }

    // Vuelos del periodo: completados / cancelados + top clientes.
    let completados = 0;
    let cancelados = 0;
    const porCliente = new Map<string, { total: number; vuelos: number }>();
    for (const v of vuelosPeriodo) {
      if (v.estado === 'COMPLETADO') completados += 1;
      else if (v.estado === 'CANCELADO') cancelados += 1;
      const prev = porCliente.get(v.cliente_id) ?? { total: 0, vuelos: 0 };
      prev.total += Number(v.monto_total_usd ?? 0);
      prev.vuelos += 1;
      porCliente.set(v.cliente_id, prev);
    }

    const topClientes = await this.buildTopClientes(porCliente);

    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      resumen: {
        ingresos_cobrados_usd: round2(ingresosCobrados),
        ingresos_pendientes_usd: round2(ingresosPendientes),
        gastos_totales_usd: round2(gastos),
        saldo_disponible_usd: round2(saldo),
        vuelos_periodo: vuelosPeriodo.length,
        vuelos_completados: completados,
        vuelos_cancelados: cancelados,
      },
      por_avion: porAvion,
      operacion: {
        solicitudes: pipeline.solicitud,
        cotizaciones: pipeline.cotizado,
        confirmados: pipeline.confirmado,
        en_vuelo: pipeline.en_vuelo,
        completados_periodo: completados,
        cancelados_periodo: cancelados,
      },
      top_clientes: topClientes,
    };
  }

  private async fetchEstadosAbiertos(): Promise<string[]> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('estado')
      .in('estado', ABIERTOS);
    if (error) throw new Error(error.message);
    return (data ?? []).map((v) => v.estado as string);
  }

  private async fetchVuelosPeriodo(
    desde: string,
    hasta: string,
  ): Promise<VueloPeriodoRow[]> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('estado, cliente_id, monto_total_usd')
      .gte('fecha_vuelo', desde)
      .lte('fecha_vuelo', `${hasta}T23:59:59`);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async buildTopClientes(
    porCliente: Map<string, { total: number; vuelos: number }>,
  ) {
    const ids = [...porCliente.keys()];
    if (ids.length === 0) return [];
    const { data, error } = await this.supabase.service
      .from('cliente')
      .select('id, nombre')
      .in('id', ids);
    if (error) throw new Error(error.message);
    const nombres = new Map(
      (data ?? []).map((c) => [c.id as string, c.nombre as string]),
    );
    return [...porCliente.entries()]
      .map(([clienteId, v]) => ({
        cliente_id: clienteId,
        nombre: nombres.get(clienteId) ?? 'Cliente',
        vuelos: v.vuelos,
        ingresos_usd: round2(v.total),
      }))
      .sort((a, b) => b.ingresos_usd - a.ingresos_usd)
      .slice(0, 10);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
