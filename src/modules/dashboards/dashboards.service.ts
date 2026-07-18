import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import {
  PyservicesService,
  type TablaColumnaPayload,
} from '../pyservices/pyservices.service';
import type {
  GastosQuery,
  HorasPilotoQuery,
  OperativoQuery,
  OverviewQuery,
  TarjetasQuery,
} from './dto/dashboards.dto';

const ABIERTOS = ['SOLICITUD', 'COTIZADO', 'CONFIRMADO', 'EN_VUELO'];

/** Límite informativo de horas de vuelo por piloto al mes (doc 5.10 / 5.6). */
const LIMITE_HORAS_MES = 90;

interface VueloPeriodoRow {
  estado: string;
  cliente_id: string;
  monto_total_usd: string | null;
}

interface VueloOpsRow {
  id: string;
  estado: string;
  fecha_solicitud: string | null;
  fecha_vuelo: string | null;
}

interface GastoRow {
  aeronave_id: string | null;
  usuario_captura_id: string | null;
  categoria: string;
  monto: string;
  moneda: string;
  tc_gasto: string | null;
  medio_pago: string | null;
  tarjeta_terminacion: string | null;
}

interface VueloHorasRow {
  id: string;
  aeronave_id: string | null;
  piloto_id: string | null;
  monto_total_usd: string | null;
  cobrado: boolean;
}

interface EscalaTacoRow {
  vuelo_id: string;
  taco_salida: string | number | null;
  taco_llegada: string | number | null;
}

@Injectable()
export class DashboardsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly profitSharing: ProfitSharingService,
    private readonly pyservices: PyservicesService,
  ) {}

  /** Horas por piloto en Excel (mismos datos del tablero). */
  async horasPilotoXlsx(q: HorasPilotoQuery): Promise<Buffer> {
    const r = await this.horasPiloto(q);
    const columnas: TablaColumnaPayload[] = [
      { label: 'Piloto' },
      { label: 'Horas (periodo)', tipo: 'numero' },
      { label: 'Vuelos (periodo)', tipo: 'entero' },
      { label: 'Horas mes actual', tipo: 'numero' },
      { label: 'Límite mes', tipo: 'numero' },
      { label: 'Restantes mes', tipo: 'numero' },
      { label: 'Excede límite' },
    ];
    const filas = r.pilotos.map((p) => [
      p.nombre,
      p.horas_periodo,
      p.vuelos_periodo,
      p.horas_mes_actual,
      p.limite_horas_mes,
      p.horas_restantes_mes,
      p.excede_limite ? 'Sí' : 'No',
    ]);
    const totales = [
      'TOTAL',
      r.resumen.horas_periodo_total,
      null,
      null,
      null,
      null,
      null,
    ];
    return this.pyservices.generateTablaXlsx({
      titulo: 'Horas por piloto',
      subtitulo: `Periodo ${q.desde} a ${q.hasta} · límite informativo ${LIMITE_HORAS_MES} hrs/mes`,
      columnas,
      filas,
      totales,
    });
  }

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

  /**
   * Tablero operativo (Itzel/COORDINADOR): solicitudes del día, cotizaciones
   * pendientes, tasa de conversión (cotizado→confirmado) del periodo y vuelos
   * de la próxima semana. Doc 5.10.
   */
  async operativo(q: OperativoQuery) {
    if (q.desde > q.hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }

    // Día actual en hora Cancún (regla del repo), no UTC: después de las
    // 19:00 el "hoy" UTC ya es mañana y el tablero mostraba 0 solicitudes.
    const diaCancun = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cancun' }).format(
        d,
      );
    const hoy = diaCancun(new Date());
    const hasta7 = diaCancun(new Date(Date.now() + 7 * 86_400_000));

    const [pipeline, vuelosPeriodo, solicitudesHoy, vuelosSemana] =
      await Promise.all([
        this.fetchEstadosAbiertos(),
        this.fetchVuelosOps(q.desde, q.hasta),
        this.fetchSolicitudesHoy(hoy),
        this.fetchVuelosSemana(hoy, hasta7),
      ]);

    // Pipeline en vivo (estado actual).
    let solicitudesAbiertas = 0;
    let cotizacionesPendientes = 0;
    let confirmados = 0;
    let enVuelo = 0;
    for (const e of pipeline) {
      if (e === 'SOLICITUD') solicitudesAbiertas += 1;
      else if (e === 'COTIZADO') cotizacionesPendientes += 1;
      else if (e === 'CONFIRMADO') confirmados += 1;
      else if (e === 'EN_VUELO') enVuelo += 1;
    }

    // Tasa de conversión del periodo: de los vuelos solicitados/cotizados en el
    // rango, qué proporción avanzó a confirmado o más (no se cuentan los que
    // siguen como solicitud o cotización abierta, ni los cancelados pre-confirmación).
    let cotizados = 0;
    let convertidos = 0;
    let cancelados = 0;
    for (const v of vuelosPeriodo) {
      // Avanzaron del estado COTIZADO (CONFIRMADO/EN_VUELO/COMPLETADO).
      const avanzado =
        v.estado === 'CONFIRMADO' ||
        v.estado === 'EN_VUELO' ||
        v.estado === 'COMPLETADO';
      if (v.estado === 'CANCELADO') cancelados += 1;
      // Base de conversión = todo lo que llegó al menos a cotización.
      if (v.estado !== 'SOLICITUD') cotizados += 1;
      if (avanzado) convertidos += 1;
    }
    const tasaConversion =
      cotizados > 0 ? round2((convertidos / cotizados) * 100) : 0;

    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      hoy: {
        solicitudes_del_dia: solicitudesHoy,
        solicitudes_abiertas: solicitudesAbiertas,
        cotizaciones_pendientes: cotizacionesPendientes,
        confirmados,
        en_vuelo: enVuelo,
      },
      conversion: {
        base_cotizados: cotizados,
        convertidos,
        cancelados,
        tasa_conversion_pct: tasaConversion,
      },
      vuelos_semana: vuelosSemana,
      vuelos_semana_total: vuelosSemana.length,
    };
  }

  /**
   * Tablero de gastos (Jimmy/ANALISTA): gasto por avión y periodo, horas
   * voladas, costo/hora y utilidad/hora. Las horas se derivan de las escalas
   * (taco_llegada − taco_salida) de los vuelos COMPLETADOS del periodo. Doc 5.10.
   */
  async gastos(q: GastosQuery) {
    if (q.desde > q.hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }

    const [aeronaves, gastos, vuelos] = await Promise.all([
      this.fetchAeronavesActivas(),
      this.fetchGastosPeriodo(q.desde, q.hasta),
      this.fetchVuelosHoras(q.desde, q.hasta),
    ]);

    // Horas voladas por vuelo (suma de escalas con taco completo).
    const horasPorVuelo = await this.horasPorVuelo(vuelos.map((v) => v.id));

    // Agrega ingresos cobrados y horas por avión (solo COMPLETADOS aportan horas).
    const ingresosPorAvion = new Map<string, number>();
    const horasPorAvion = new Map<string, number>();
    const vuelosPorAvion = new Map<string, number>();
    for (const v of vuelos) {
      if (!v.aeronave_id) continue;
      vuelosPorAvion.set(
        v.aeronave_id,
        (vuelosPorAvion.get(v.aeronave_id) ?? 0) + 1,
      );
      if (v.cobrado) {
        ingresosPorAvion.set(
          v.aeronave_id,
          (ingresosPorAvion.get(v.aeronave_id) ?? 0) +
            Number(v.monto_total_usd ?? 0),
        );
      }
      const h = horasPorVuelo.get(v.id) ?? 0;
      if (h > 0) {
        horasPorAvion.set(v.aeronave_id, (horasPorAvion.get(v.aeronave_id) ?? 0) + h);
      }
    }

    // Gasto en USD por avión (mismo criterio que el motor de reparto).
    const gastoPorAvion = new Map<string, number>();
    let sinTc = 0;
    let gastoSinAvion = 0;
    for (const g of gastos) {
      const usd = this.toUsd(g);
      if (usd === null) {
        sinTc += 1;
        continue;
      }
      if (!g.aeronave_id) {
        gastoSinAvion += usd;
        continue;
      }
      gastoPorAvion.set(g.aeronave_id, (gastoPorAvion.get(g.aeronave_id) ?? 0) + usd);
    }

    const aviones = aeronaves.map((a) => {
      const gastoUsd = round2(gastoPorAvion.get(a.id) ?? 0);
      const horas = round2(horasPorAvion.get(a.id) ?? 0);
      const ingresos = round2(ingresosPorAvion.get(a.id) ?? 0);
      const utilidad = round2(ingresos - gastoUsd);
      return {
        aeronave_id: a.id,
        matricula: a.matricula,
        modelo: a.modelo,
        vuelos: vuelosPorAvion.get(a.id) ?? 0,
        horas_voladas: horas,
        gastos_usd: gastoUsd,
        ingresos_cobrado_usd: ingresos,
        utilidad_usd: utilidad,
        costo_hora_usd: horas > 0 ? round2(gastoUsd / horas) : null,
        utilidad_hora_usd: horas > 0 ? round2(utilidad / horas) : null,
      };
    });

    const totalGasto = aviones.reduce((acc, a) => acc + a.gastos_usd, 0);
    const totalHoras = aviones.reduce((acc, a) => acc + a.horas_voladas, 0);

    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      resumen: {
        gastos_totales_usd: round2(totalGasto + gastoSinAvion),
        gastos_avion_usd: round2(totalGasto),
        gastos_sin_avion_usd: round2(gastoSinAvion),
        horas_voladas: round2(totalHoras),
        costo_hora_promedio_usd:
          totalHoras > 0 ? round2(totalGasto / totalHoras) : null,
        gastos_sin_tc: sinTc,
      },
      por_avion: aviones,
    };
  }

  /**
   * Dashboard de gastos por tarjeta corporativa (Ale/ADMIN): gasto en vivo por
   * tarjeta (terminación), por persona y por categoría dentro del periodo.
   * Doc 2.6 / 5.10. Considera gastos con medio_pago = TARJETA_CORP.
   */
  async tarjetas(q: TarjetasQuery) {
    if (q.desde > q.hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }

    const gastos = await this.fetchGastosTarjeta(q.desde, q.hasta);

    const porTarjeta = new Map<string, { usd: number; movs: number }>();
    const porPersona = new Map<string, { usd: number; movs: number }>();
    const porCategoria = new Map<string, { usd: number; movs: number }>();
    let totalUsd = 0;
    let sinTc = 0;

    for (const g of gastos) {
      const usd = this.toUsd(g);
      if (usd === null) {
        sinTc += 1;
        continue;
      }
      totalUsd += usd;
      const term = g.tarjeta_terminacion ?? 'SIN_TARJETA';
      const t = porTarjeta.get(term) ?? { usd: 0, movs: 0 };
      t.usd += usd;
      t.movs += 1;
      porTarjeta.set(term, t);

      const persona = g.usuario_captura_id ?? 'SIN_USUARIO';
      const p = porPersona.get(persona) ?? { usd: 0, movs: 0 };
      p.usd += usd;
      p.movs += 1;
      porPersona.set(persona, p);

      const c = porCategoria.get(g.categoria) ?? { usd: 0, movs: 0 };
      c.usd += usd;
      c.movs += 1;
      porCategoria.set(g.categoria, c);
    }

    const [titulares, nombres] = await Promise.all([
      this.fetchTitularesTarjeta([...porTarjeta.keys()]),
      this.fetchNombresUsuarios([...porPersona.keys()]),
    ]);

    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      resumen: {
        gasto_total_usd: round2(totalUsd),
        movimientos: gastos.length,
        tarjetas_con_gasto: porTarjeta.size,
        gastos_sin_tc: sinTc,
      },
      por_tarjeta: [...porTarjeta.entries()]
        .map(([term, v]) => ({
          terminacion: term,
          titular: titulares.get(term) ?? null,
          gasto_usd: round2(v.usd),
          movimientos: v.movs,
        }))
        .sort((a, b) => b.gasto_usd - a.gasto_usd),
      por_persona: [...porPersona.entries()]
        .map(([id, v]) => ({
          usuario_id: id === 'SIN_USUARIO' ? null : id,
          nombre: nombres.get(id) ?? 'Sin asignar',
          gasto_usd: round2(v.usd),
          movimientos: v.movs,
        }))
        .sort((a, b) => b.gasto_usd - a.gasto_usd),
      por_categoria: [...porCategoria.entries()]
        .map(([categoria, v]) => ({
          categoria,
          gasto_usd: round2(v.usd),
          movimientos: v.movs,
        }))
        .sort((a, b) => b.gasto_usd - a.gasto_usd),
    };
  }

  /**
   * Horas de piloto (COORDINADOR/ADMIN): horas voladas por piloto en el periodo
   * (suma de taco_llegada − taco_salida de escalas de vuelos COMPLETADOS), más
   * el acumulado del mes en curso para señalar el límite informativo de 90 hrs.
   * Doc 5.10 / 5.6. El límite NO bloquea, solo informa.
   */
  async horasPiloto(q: HorasPilotoQuery) {
    if (q.desde > q.hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }

    // Mes en curso para el control del límite de 90 hrs — corte en hora
    // Cancún (regla del repo), no UTC: un vuelo del día 31 en la noche caía
    // en el mes equivocado.
    const hoyCancun = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Cancun',
    }).format(new Date());
    const mesDesde = `${hoyCancun.slice(0, 7)}-01`;
    const mesHasta = hoyCancun;

    const [vuelosPeriodo, vuelosMes] = await Promise.all([
      this.fetchVuelosCompletadosConPiloto(q.desde, q.hasta),
      this.fetchVuelosCompletadosConPiloto(mesDesde, mesHasta),
    ]);

    // Horas POR TRAMO: la ida y el regreso pueden volarlos pilotos distintos
    // (asignación por tramo) — atribuir todo el vuelo al piloto principal
    // inflaba al de la ida y desaparecía al del regreso.
    const [periodoPorPiloto, mesPorPiloto] = await Promise.all([
      this.horasPorPilotoTramo(vuelosPeriodo),
      this.horasPorPilotoTramo(vuelosMes),
    ]);

    const pilotoIds = [
      ...new Set([...periodoPorPiloto.keys(), ...mesPorPiloto.keys()]),
    ];
    const nombres = await this.fetchNombresUsuarios(pilotoIds);

    const pilotos = pilotoIds
      .map((id) => {
        const periodo = periodoPorPiloto.get(id) ?? { horas: 0, vuelos: new Set<string>() };
        const horasMes = round2(mesPorPiloto.get(id)?.horas ?? 0);
        return {
          piloto_id: id,
          nombre: nombres.get(id) ?? 'Piloto',
          horas_periodo: round2(periodo.horas),
          vuelos_periodo: periodo.vuelos.size,
          horas_mes_actual: horasMes,
          limite_horas_mes: LIMITE_HORAS_MES,
          excede_limite: horasMes > LIMITE_HORAS_MES,
          horas_restantes_mes: round2(LIMITE_HORAS_MES - horasMes),
        };
      })
      .sort((a, b) => b.horas_periodo - a.horas_periodo);

    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      mes_actual: { desde: mesDesde, hasta: mesHasta },
      limite_horas_mes: LIMITE_HORAS_MES,
      resumen: {
        horas_periodo_total: round2(
          pilotos.reduce((acc, p) => acc + p.horas_periodo, 0),
        ),
        pilotos_con_actividad: pilotos.filter((p) => p.horas_periodo > 0).length,
        pilotos_sobre_limite: pilotos.filter((p) => p.excede_limite).length,
      },
      pilotos,
    };
  }

  // ============ helpers ============

  /** Convierte un gasto a USD. null = no se pudo (MXN sin tc_gasto). */
  private toUsd(g: {
    monto: string;
    moneda: string;
    tc_gasto: string | null;
  }): number | null {
    if (g.moneda === 'USD') return Number(g.monto);
    if (g.tc_gasto && Number(g.tc_gasto) > 0) {
      return Number(g.monto) / Number(g.tc_gasto);
    }
    return null;
  }

  /**
   * Horas voladas por vuelo: suma de (taco_llegada − taco_salida) de las escalas
   * con ambas lecturas. Devuelve un mapa vuelo_id → horas. Pagina los IDs para
   * no exceder el límite de la consulta `in`.
   */
  private async horasPorVuelo(
    vueloIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (vueloIds.length === 0) return out;
    const CHUNK = 200;
    for (let i = 0; i < vueloIds.length; i += CHUNK) {
      const slice = vueloIds.slice(i, i + CHUNK);
      const { data, error } = await this.supabase.service
        .from('escala')
        .select('vuelo_id, taco_salida, taco_llegada')
        .in('vuelo_id', slice);
      if (error) throw new Error(error.message);
      for (const e of (data as EscalaTacoRow[] | null) ?? []) {
        const salida = e.taco_salida === null ? NaN : Number(e.taco_salida);
        const llegada = e.taco_llegada === null ? NaN : Number(e.taco_llegada);
        if (Number.isFinite(salida) && Number.isFinite(llegada) && llegada > salida) {
          out.set(e.vuelo_id, (out.get(e.vuelo_id) ?? 0) + (llegada - salida));
        }
      }
    }
    return out;
  }

  // ============ fetchers ============

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
      .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchVuelosOps(
    desde: string,
    hasta: string,
  ): Promise<VueloOpsRow[]> {
    // Conversión: nos basamos en la fecha de solicitud (entrada al embudo).
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('id, estado, fecha_solicitud, fecha_vuelo')
      .gte('fecha_solicitud', `${desde}T00:00:00-05:00`)
      .lte('fecha_solicitud', `${hasta}T23:59:59-05:00`);
    if (error) throw new Error(error.message);
    return (data as VueloOpsRow[] | null) ?? [];
  }

  private async fetchSolicitudesHoy(hoy: string): Promise<number> {
    const { count, error } = await this.supabase.service
      .from('vuelo')
      .select('id', { count: 'exact', head: true })
      .gte('fecha_solicitud', `${hoy}T00:00:00-05:00`)
      .lte('fecha_solicitud', `${hoy}T23:59:59-05:00`);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  private async fetchVuelosSemana(
    hoy: string,
    hasta: string,
  ): Promise<
    Array<{
      id: string;
      folio: number | null;
      estado: string;
      origen_iata: string | null;
      destino_iata: string | null;
      fecha_vuelo: string | null;
      piloto_id: string | null;
      aeronave_id: string | null;
    }>
  > {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, estado, origen_iata, destino_iata, fecha_vuelo, piloto_id, aeronave_id',
      )
      .in('estado', ['CONFIRMADO', 'EN_VUELO'])
      .gte('fecha_vuelo', `${hoy}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`)
      .order('fecha_vuelo', { ascending: true });
    if (error) throw new Error(error.message);
    return (data as never) ?? [];
  }

  private async fetchAeronavesActivas(): Promise<
    Array<{ id: string; matricula: string; modelo: string }>
  > {
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .select('id, matricula, modelo')
      .eq('activa', true)
      .order('matricula', { ascending: true });
    if (error) throw new Error(error.message);
    return (data as never) ?? [];
  }

  private async fetchGastosPeriodo(
    desde: string,
    hasta: string,
  ): Promise<GastoRow[]> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(
        'aeronave_id, usuario_captura_id, categoria, monto, moneda, tc_gasto, medio_pago, tarjeta_terminacion',
      )
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta);
    if (error) throw new Error(error.message);
    return (data as GastoRow[] | null) ?? [];
  }

  private async fetchGastosTarjeta(
    desde: string,
    hasta: string,
  ): Promise<GastoRow[]> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(
        'aeronave_id, usuario_captura_id, categoria, monto, moneda, tc_gasto, medio_pago, tarjeta_terminacion',
      )
      .eq('medio_pago', 'TARJETA_CORP')
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta);
    if (error) throw new Error(error.message);
    return (data as GastoRow[] | null) ?? [];
  }

  private async fetchVuelosHoras(
    desde: string,
    hasta: string,
  ): Promise<VueloHorasRow[]> {
    // Solo vuelos COMPLETADOS aportan horas reales (tacómetro cerrado).
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('id, aeronave_id, piloto_id, monto_total_usd, cobrado')
      .eq('estado', 'COMPLETADO')
      .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`);
    if (error) throw new Error(error.message);
    return (data as VueloHorasRow[] | null) ?? [];
  }

  private async fetchVuelosCompletadosConPiloto(
    desde: string,
    hasta: string,
  ): Promise<Array<{ id: string; piloto_id: string | null }>> {
    // Sin exigir piloto a nivel vuelo: el piloto puede vivir solo en el
    // tramo (ida/regreso con pilotos distintos) y esas horas también cuentan.
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('id, piloto_id')
      .eq('estado', 'COMPLETADO')
      .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`);
    if (error) throw new Error(error.message);
    return (data as Array<{ id: string; piloto_id: string | null }> | null) ?? [];
  }

  /**
   * Horas voladas por PILOTO a partir de los tacómetros de cada tramo
   * (taco_llegada − taco_salida), atribuidas al piloto del tramo o, si el
   * tramo no tiene, al piloto del vuelo — la MISMA regla que el perfil del
   * piloto en la app (users.horasDelMes) y el semáforo de asignación.
   */
  private async horasPorPilotoTramo(
    vuelos: Array<{ id: string; piloto_id: string | null }>,
  ): Promise<Map<string, { horas: number; vuelos: Set<string> }>> {
    const out = new Map<string, { horas: number; vuelos: Set<string> }>();
    if (vuelos.length === 0) return out;
    const pilotoPorVuelo = new Map(vuelos.map((v) => [v.id, v.piloto_id]));
    const ids = vuelos.map((v) => v.id);
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { data, error } = await this.supabase.service
        .from('escala')
        .select('vuelo_id, piloto_id, taco_salida, taco_llegada')
        .in('vuelo_id', slice);
      if (error) throw new Error(error.message);
      for (const e of (data as Array<Record<string, unknown>> | null) ?? []) {
        const salida = e.taco_salida === null ? NaN : Number(e.taco_salida);
        const llegada = e.taco_llegada === null ? NaN : Number(e.taco_llegada);
        if (!Number.isFinite(salida) || !Number.isFinite(llegada) || llegada <= salida) {
          continue;
        }
        const pid =
          (e.piloto_id as string | null) ??
          pilotoPorVuelo.get(e.vuelo_id as string) ??
          null;
        if (!pid) continue;
        const prev = out.get(pid) ?? { horas: 0, vuelos: new Set<string>() };
        prev.horas += llegada - salida;
        prev.vuelos.add(e.vuelo_id as string);
        out.set(pid, prev);
      }
    }
    return out;
  }

  private async fetchTitularesTarjeta(
    terminaciones: string[],
  ): Promise<Map<string, string>> {
    const clean = terminaciones.filter((t) => t && t !== 'SIN_TARJETA');
    if (clean.length === 0) return new Map();
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .select('terminacion, nombre_titular')
      .in('terminacion', clean);
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((t) => [
        t.terminacion as string,
        t.nombre_titular as string,
      ]),
    );
  }

  private async fetchNombresUsuarios(
    ids: string[],
  ): Promise<Map<string, string>> {
    const clean = ids.filter((id) => id && id !== 'SIN_USUARIO');
    if (clean.length === 0) return new Map();
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('id, nombre')
      .in('id', clean);
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((u) => [u.id as string, u.nombre as string]),
    );
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
