import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import type { ProfitSharingQuery } from './dto/profit-sharing.dto';

/** Categorias de gasto que cuentan como GASTO DIRECTO del avion (doc 4.8). */
const DIRECTO = new Set([
  'GAS',
  'ATERRIZAJE',
  'TUAS',
  'FBO',
  'COMIDA',
  'HOTEL',
  'TAXI',
  'OTRO',
]);
/** Talleres, aceites, refacciones, mecanicos. */
const INDIRECTO = new Set(['REFACCION']);
const PERMISO = new Set(['PERMISO']);
/** Sueldos, seguros: se prorratean entre aviones activos. */
const FIJO = 'FIJO';

interface AeronaveRow {
  id: string;
  matricula: string;
  modelo: string;
}
interface VueloRow {
  aeronave_id: string | null;
  monto_total_usd: string | null;
  cobrado: boolean;
}
interface GastoRow {
  aeronave_id: string | null;
  categoria: string;
  monto: string;
  moneda: string;
  tc_gasto: string | null;
}
interface SocioRow {
  aeronave_id: string;
  socio_id: string;
  porcentaje: string;
  vigente_desde: string;
  vigente_hasta: string | null;
}
interface ReservaRow {
  aeronave_id: string;
  monto_por_hora_usd: string;
  horas_acumuladas: string;
}

@Injectable()
export class ProfitSharingService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
  ) {}

  /** Construye el payload (compartido por el PDF y el Excel) desde el cómputo. */
  private async buildRepartoPayload(q: ProfitSharingQuery) {
    const result = await this.compute(q);
    const payload = {
      periodo_desde: result.periodo.desde,
      periodo_hasta: result.periodo.hasta,
      generado: new Date().toISOString().slice(0, 10),
      aviones: result.aviones.map((a) => ({
        matricula: a.aeronave.matricula,
        modelo: a.aeronave.modelo,
        ingresos_cobrado_usd: a.ingresos.cobrado_usd,
        pendiente_cobro_usd: a.ingresos.pendiente_cobro_usd,
        gastos_directos_usd: a.gastos.directos_usd,
        gastos_indirectos_usd: a.gastos.indirectos_usd,
        permisos_usd: a.gastos.permisos_usd,
        otros_usd: a.gastos.otros_prorrateados_usd,
        reserva_overhaul_usd: a.reserva_overhaul_usd,
        saldo_usd: a.saldo_disponible_usd,
        reparto: a.reparto.map((r) => ({
          socio_nombre: r.socio_nombre,
          porcentaje: r.porcentaje,
          monto_usd: r.monto_usd,
        })),
      })),
    };
    return { payload, desde: result.periodo.desde, hasta: result.periodo.hasta };
  }

  /** Genera el PDF del reparto delegando el render al microservicio Python. */
  async repartoPdf(
    q: ProfitSharingQuery,
  ): Promise<{ buffer: Buffer; desde: string; hasta: string }> {
    const { payload, desde, hasta } = await this.buildRepartoPayload(q);
    const buffer = await this.pyservices.generateRepartoPdf(payload);
    return { buffer, desde, hasta };
  }

  /** Genera el reporte mensual por avión en Excel (mismos datos). */
  async repartoXlsx(
    q: ProfitSharingQuery,
  ): Promise<{ buffer: Buffer; desde: string; hasta: string }> {
    const { payload, desde, hasta } = await this.buildRepartoPayload(q);
    const buffer = await this.pyservices.generateRepartoXlsx(payload);
    return { buffer, desde, hasta };
  }

  async compute(q: ProfitSharingQuery) {
    if (q.desde > q.hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }

    const aeronaves = await this.fetchAeronaves(q.aeronave_id);
    if (aeronaves.length === 0) {
      return { periodo: { desde: q.desde, hasta: q.hasta }, aviones: [] };
    }

    const [vuelos, gastos, socios, reservas] = await Promise.all([
      this.fetchVuelos(q.desde, q.hasta),
      this.fetchGastos(q.desde, q.hasta),
      this.fetchSocios(),
      this.fetchReservas(),
    ]);

    // Conteo de aviones activos para prorratear los gastos fijos.
    const activos = await this.countAeronavesActivas();

    // Pool de gastos fijos (sueldos, seguros) de todo el periodo.
    let fijoPoolUsd = 0;
    let sinTcCount = 0;
    let sinTcMxn = 0;
    for (const g of gastos) {
      if (g.categoria !== FIJO) continue;
      const usd = this.toUsd(g);
      if (usd === null) {
        sinTcCount += 1;
        sinTcMxn += Number(g.monto);
      } else {
        fijoPoolUsd += usd;
      }
    }
    const otrosPorAvion = activos > 0 ? fijoPoolUsd / activos : 0;

    const socioIds = [...new Set(socios.map((s) => s.socio_id))];
    const nombres = await this.fetchNombres(socioIds);

    const aviones = aeronaves.map((a) =>
      this.computeAvion(a, {
        vuelos,
        gastos,
        socios,
        reservas,
        nombres,
        otrosPorAvion,
        periodo: q,
      }),
    );

    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      gastos_sin_tc: { count: sinTcCount, monto_mxn: round2(sinTcMxn) },
      aviones,
    };
  }

  private computeAvion(
    a: AeronaveRow,
    ctx: {
      vuelos: VueloRow[];
      gastos: GastoRow[];
      socios: SocioRow[];
      reservas: ReservaRow[];
      nombres: Map<string, string>;
      otrosPorAvion: number;
      periodo: ProfitSharingQuery;
    },
  ) {
    let cobrado = 0;
    let pendiente = 0;
    let vuelosCobrados = 0;
    let vuelosPendientes = 0;
    for (const v of ctx.vuelos) {
      if (v.aeronave_id !== a.id) continue;
      const monto = Number(v.monto_total_usd ?? 0);
      if (v.cobrado) {
        cobrado += monto;
        vuelosCobrados += 1;
      } else {
        pendiente += monto;
        vuelosPendientes += 1;
      }
    }

    let directos = 0;
    let indirectos = 0;
    let permisos = 0;
    let sinTc = 0;
    for (const g of ctx.gastos) {
      if (g.aeronave_id !== a.id) continue;
      const usd = this.toUsd(g);
      if (usd === null) {
        sinTc += 1;
        continue;
      }
      if (DIRECTO.has(g.categoria)) directos += usd;
      else if (INDIRECTO.has(g.categoria)) indirectos += usd;
      else if (PERMISO.has(g.categoria)) permisos += usd;
      // FIJO se prorratea aparte; otras categorias no avion-especificas se ignoran.
    }

    // Reserva acumulada = tarifa por hora x horas voladas acumuladas (por motor).
    const reservaOverhaul = ctx.reservas
      .filter((r) => r.aeronave_id === a.id)
      .reduce(
        (acc, r) =>
          acc + Number(r.monto_por_hora_usd) * Number(r.horas_acumuladas),
        0,
      );

    const saldo =
      cobrado -
      directos -
      indirectos -
      permisos -
      ctx.otrosPorAvion -
      reservaOverhaul;

    const reparto = ctx.socios
      .filter(
        (s) =>
          s.aeronave_id === a.id &&
          s.vigente_desde <= ctx.periodo.hasta &&
          (s.vigente_hasta === null || s.vigente_hasta >= ctx.periodo.desde),
      )
      .map((s) => {
        const pct = Number(s.porcentaje);
        return {
          socio_id: s.socio_id,
          socio_nombre: ctx.nombres.get(s.socio_id) ?? 'Socio',
          porcentaje: pct,
          monto_usd: round2((pct / 100) * saldo),
        };
      });
    const repartoPct = reparto.reduce((acc, r) => acc + r.porcentaje, 0);

    return {
      aeronave: { id: a.id, matricula: a.matricula, modelo: a.modelo },
      ingresos: {
        cobrado_usd: round2(cobrado),
        pendiente_cobro_usd: round2(pendiente),
        vuelos_cobrados: vuelosCobrados,
        vuelos_pendientes: vuelosPendientes,
      },
      gastos: {
        directos_usd: round2(directos),
        indirectos_usd: round2(indirectos),
        permisos_usd: round2(permisos),
        otros_prorrateados_usd: round2(ctx.otrosPorAvion),
        gastos_sin_tc_count: sinTc,
      },
      reserva_overhaul_usd: round2(reservaOverhaul),
      reserva_overhaul_incompleta: false,
      saldo_disponible_usd: round2(saldo),
      reparto,
      reparto_porcentaje_total: round2(repartoPct),
    };
  }

  /** Convierte un gasto a USD. null = no se pudo (MXN sin tc_gasto). */
  private toUsd(g: GastoRow): number | null {
    if (g.moneda === 'USD') return Number(g.monto);
    if (g.tc_gasto && Number(g.tc_gasto) > 0) {
      return Number(g.monto) / Number(g.tc_gasto);
    }
    return null;
  }

  // ============ fetchers ============

  private async fetchAeronaves(aeronaveId?: string): Promise<AeronaveRow[]> {
    let q = this.supabase.service
      .from('aeronave')
      .select('id, matricula, modelo')
      .eq('activa', true)
      .order('matricula', { ascending: true });
    if (aeronaveId) q = q.eq('id', aeronaveId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async countAeronavesActivas(): Promise<number> {
    const { count, error } = await this.supabase.service
      .from('aeronave')
      .select('id', { count: 'exact', head: true })
      .eq('activa', true);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  private async fetchVuelos(desde: string, hasta: string): Promise<VueloRow[]> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('aeronave_id, monto_total_usd, cobrado')
      .gte('fecha_vuelo', desde)
      .lte('fecha_vuelo', `${hasta}T23:59:59`);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchGastos(desde: string, hasta: string): Promise<GastoRow[]> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('aeronave_id, categoria, monto, moneda, tc_gasto')
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchSocios(): Promise<SocioRow[]> {
    const { data, error } = await this.supabase.service
      .from('aeronave_socio')
      .select(
        'aeronave_id, socio_id, porcentaje, vigente_desde, vigente_hasta',
      );
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchReservas(): Promise<ReservaRow[]> {
    const { data, error } = await this.supabase.service
      .from('reserva_overhaul')
      .select('aeronave_id, monto_por_hora_usd, horas_acumuladas');
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchNombres(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('id, nombre')
      .in('id', ids);
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((u) => [u.id as string, u.nombre as string]),
    );
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
