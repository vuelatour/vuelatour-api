import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import type { ProfitSharingQuery } from './dto/profit-sharing.dto';
import { cobrosEnUsd } from '../../common/cobros-usd.util';

/** Categorias de gasto que cuentan como GASTO DIRECTO del avion (doc 4.8). */
const DIRECTO = new Set([
  'GAS',
  // OPERACIONES es la categoría operativa REAL de pistas/aeródromos (la app
  // y el módulo de pistas la usan; ATERRIZAJE/FBO son legacy). Sin ella, las
  // cuotas de VIP SAESA no restaban en el reparto e inflaban la utilidad.
  'OPERACIONES',
  'ATERRIZAJE',
  'TUAS',
  'FBO',
  'COMIDA',
  'HOTEL',
  'TAXI',
  // Honorario del piloto externo (freelance, doc 3.7): costo directo del
  // vuelo — fuera de este set el reparto lo ignoraría e inflaría la utilidad.
  'PILOTO_EXTERNO',
  'OTRO',
]);
/** Talleres, aceites, refacciones, mecanicos. */
// OJO: la CATEGORÍA de gasto 'INDIRECTO' (captura sin vuelo, jul 2026) NO
// está en ningún set A PROPÓSITO: cae al else y el reparto la ignora hasta
// que el equipo decida su tratamiento. No "arreglarlo" sin esa decisión.
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
  id: string;
  aeronave_id: string | null;
  monto_total_usd: string | null;
  tc_usd_mxn: string | null;
  cobrado: boolean;
  /** Comisión de quien vendió: se descuenta del ingreso (neto VuelaTour). */
  comision_vendedor_usd: string | null;
}
interface CobroRow {
  vuelo_id: string;
  monto: string;
  moneda: string;
  tc_usd_mxn: string | null;
}
interface EscalaHorasRow {
  vuelo_id: string;
  aeronave_id: string | null;
  taco_salida: string | null;
  taco_llegada: string | null;
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
      // Fecha de generación en hora de Cancún (UTC−5), no UTC.
      generado: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Cancun',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date()),
      aviones: result.aviones.map((a) => ({
        matricula: a.aeronave.matricula,
        modelo: a.aeronave.modelo,
        ingresos_cobrado_usd: a.ingresos.cobrado_usd,
        comisiones_venta_usd: a.ingresos.comisiones_venta_usd,
        pendiente_cobro_usd: a.ingresos.pendiente_cobro_usd,
        horas_voladas_hr: a.horas_voladas_hr,
        gastos_directos_usd: a.gastos.directos_usd,
        gastos_indirectos_usd: a.gastos.indirectos_usd,
        permisos_usd: a.gastos.permisos_usd,
        otros_usd: a.gastos.otros_prorrateados_usd,
        reserva_overhaul_usd: a.reserva_overhaul_usd,
        saldo_usd: a.saldo_disponible_usd,
        // Advertencias de integridad: montos que NO pudieron entrar al balance.
        gastos_sin_tc_mxn: a.gastos.gastos_sin_tc_mxn,
        cobros_sin_tc_mxn: a.ingresos.cobros_sin_tc_mxn,
        reserva_incompleta: a.reserva_overhaul_incompleta,
        reparto: a.reparto.map((r) => ({
          socio_nombre: r.socio_nombre,
          porcentaje: r.porcentaje,
          monto_usd: r.monto_usd,
        })),
      })),
    };
    return {
      payload,
      desde: result.periodo.desde,
      hasta: result.periodo.hasta,
    };
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
    const vueloIds = vuelos.map((v) => v.id);
    const [cobros, escalas] = await Promise.all([
      this.fetchCobros(vueloIds),
      this.fetchEscalasHoras(vueloIds),
    ]);

    // Ingreso canónico por vuelo: suma de cobro_vuelo convertida a USD
    // (cobrosEnUsd, la MISMA fuente que la bandera `cobrado` y el reporte por
    // vuelo). Soporta cobro parcial: lo recibido cuenta, el resto es pendiente.
    const cobrosPorVuelo = new Map<string, CobroRow[]>();
    for (const c of cobros) {
      const list = cobrosPorVuelo.get(c.vuelo_id) ?? [];
      list.push(c);
      cobrosPorVuelo.set(c.vuelo_id, list);
    }

    // Horas voladas del periodo por avión (por tramo: el avión de la escala
    // puede diferir del principal del vuelo). Base de la reserva de overhaul.
    const vueloAvion = new Map<string, string | null>(
      vuelos.map((v) => [v.id, v.aeronave_id]),
    );
    const horasPorAvion = new Map<string, number>();
    for (const e of escalas) {
      if (e.taco_salida == null || e.taco_llegada == null) continue;
      const h = Number(e.taco_llegada) - Number(e.taco_salida);
      if (!Number.isFinite(h) || h <= 0) continue;
      const avionId = e.aeronave_id ?? vueloAvion.get(e.vuelo_id) ?? null;
      if (!avionId) continue;
      horasPorAvion.set(avionId, (horasPorAvion.get(avionId) ?? 0) + h);
    }

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
        cobrosPorVuelo,
        horasPorAvion,
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
      cobrosPorVuelo: Map<string, CobroRow[]>;
      horasPorAvion: Map<string, number>;
      gastos: GastoRow[];
      socios: SocioRow[];
      reservas: ReservaRow[];
      nombres: Map<string, string>;
      otrosPorAvion: number;
      periodo: ProfitSharingQuery;
    },
  ) {
    // "Solo se reparte lo cobrado" (doc 4.8) con DINERO REAL: la suma de
    // cobro_vuelo en USD (fuente canónica), no el monto cotizado del vuelo.
    // Un vuelo pagado al 90% aporta su 90% y deja el resto como pendiente.
    let cobrado = 0;
    let pendiente = 0;
    let vuelosCobrados = 0;
    let vuelosPendientes = 0;
    let cobrosSinTcMxn = 0;
    // Comisiones de venta (Itzy/Pablo/broker): el cliente paga el total, pero
    // esa parte no es de VuelaTour — se descuenta del ingreso a repartir. Se
    // hace efectiva contra lo cobrado (tope: lo cobrado del vuelo).
    let comisionesVenta = 0;
    for (const v of ctx.vuelos) {
      if (v.aeronave_id !== a.id) continue;
      const monto = Number(v.monto_total_usd ?? 0);
      const conv = cobrosEnUsd(
        ctx.cobrosPorVuelo.get(v.id) ?? [],
        v.tc_usd_mxn == null ? null : Number(v.tc_usd_mxn),
      );
      cobrado += conv.total_usd;
      cobrosSinTcMxn += conv.sin_tc_mxn;
      pendiente += Math.max(0, monto - conv.total_usd);
      comisionesVenta += Math.min(
        Number(v.comision_vendedor_usd ?? 0),
        conv.total_usd,
      );
      if (v.cobrado) vuelosCobrados += 1;
      else vuelosPendientes += 1;
    }

    let directos = 0;
    let indirectos = 0;
    let permisos = 0;
    let sinTc = 0;
    let sinTcMxn = 0;
    for (const g of ctx.gastos) {
      if (g.aeronave_id !== a.id) continue;
      const usd = this.toUsd(g);
      if (usd === null) {
        sinTc += 1;
        sinTcMxn += Number(g.monto);
        continue;
      }
      if (DIRECTO.has(g.categoria)) directos += usd;
      else if (INDIRECTO.has(g.categoria)) indirectos += usd;
      else if (PERMISO.has(g.categoria)) permisos += usd;
      // FIJO se prorratea aparte; otras categorias no avion-especificas se ignoran.
    }

    // Reserva de overhaul DEL PERIODO = horas voladas del periodo × tarifa por
    // hora (sumada por motor: bimotor = 2 filas). Antes se multiplicaba por el
    // acumulado DE POR VIDA, restando lo mismo (y creciente) cada mes.
    const horasPeriodo = round2(ctx.horasPorAvion.get(a.id) ?? 0);
    const tarifaReserva = ctx.reservas
      .filter((r) => r.aeronave_id === a.id)
      .reduce((acc, r) => acc + Number(r.monto_por_hora_usd), 0);
    const reservaOverhaul = horasPeriodo * tarifaReserva;
    const reservaIncompleta = horasPeriodo > 0 && tarifaReserva <= 0;

    const saldo =
      cobrado -
      comisionesVenta -
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
        comisiones_venta_usd: round2(comisionesVenta),
        pendiente_cobro_usd: round2(pendiente),
        vuelos_cobrados: vuelosCobrados,
        vuelos_pendientes: vuelosPendientes,
        cobros_sin_tc_mxn: round2(cobrosSinTcMxn),
      },
      horas_voladas_hr: horasPeriodo,
      gastos: {
        directos_usd: round2(directos),
        indirectos_usd: round2(indirectos),
        permisos_usd: round2(permisos),
        otros_prorrateados_usd: round2(ctx.otrosPorAvion),
        gastos_sin_tc_count: sinTc,
        gastos_sin_tc_mxn: round2(sinTcMxn),
      },
      reserva_overhaul_usd: round2(reservaOverhaul),
      reserva_overhaul_incompleta: reservaIncompleta,
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

  /**
   * Checklist de PRE-CIERRE: todo lo que dejaría el cierre mensual incompleto
   * o mentiroso, detectado por el sistema en vez de cazado a mano. La meta es
   * que el empleado solo supervise: si `listo` es true, se puede cerrar.
   */
  async preCierre(q: ProfitSharingQuery) {
    if (q.desde > q.hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const sb = this.supabase.service;
    const desdeTs = `${q.desde}T00:00:00-05:00`;
    const hastaTs = `${q.hasta}T23:59:59-05:00`;

    const [
      pendRes,
      completadosRes,
      gastosRes,
      movRes,
      revRes,
      pistasRes,
      legsRes,
    ] = await Promise.all([
      // Vuelos del periodo que NO llegaron a COMPLETADO ni CANCELADO.
      sb
        .from('vuelo')
        .select('id, folio, estado, fecha_vuelo')
        .in('estado', [
          'SOLICITUD',
          'COTIZADO',
          'RESERVA',
          'CONFIRMADO',
          'EN_VUELO',
        ])
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs)
        .order('fecha_vuelo', { ascending: true }),
      // Completados del periodo (para cobros pendientes/parciales).
      sb
        .from('vuelo')
        .select('id, folio, piloto_id, monto_total_usd, tc_usd_mxn, cobrado')
        .eq('estado', 'COMPLETADO')
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs),
      // Gastos del periodo con huecos de datos.
      sb
        .from('gasto')
        .select(
          'id, aeronave_id, categoria, monto, moneda, tc_gasto, estatus_comprobante',
        )
        .gte('fecha_gasto', q.desde)
        .lte('fecha_gasto', q.hasta),
      // Movimientos bancarios del periodo sin conciliar.
      sb
        .from('movimiento_bancario')
        .select('id, tipo, monto')
        .eq('conciliado', false)
        .gte('fecha', q.desde)
        .lte('fecha', q.hasta),
      // Tacómetros en revisión (amarillos) de vuelos del periodo.
      sb
        .from('escala')
        .select('id, vuelo:vuelo_id!inner(folio, fecha_vuelo, estado)')
        .eq('revision_requerida', true)
        .neq('vuelo.estado', 'CANCELADO')
        .gte('vuelo.fecha_vuelo', desdeTs)
        .lte('vuelo.fecha_vuelo', hastaTs),
      // Aterrizajes fuera de CUN del periodo (candidatos a cuota de pista).
      sb
        .from('escala')
        .select(
          'id, destino_iata, vuelo:vuelo_id!inner(folio, fecha_vuelo, estado)',
        )
        .neq('destino_iata', 'CUN')
        .neq('vuelo.estado', 'CANCELADO')
        .gte('vuelo.fecha_vuelo', desdeTs)
        .lte('vuelo.fecha_vuelo', hastaTs),
      // Fechas de tramos: detectar tramos que "salen" antes que el anterior.
      sb
        .from('escala')
        .select(
          'vuelo_id, orden, fecha_salida_plan, vuelo:vuelo_id!inner(folio, estado)',
        )
        .not('fecha_salida_plan', 'is', null)
        .neq('vuelo.estado', 'CANCELADO')
        .gte('vuelo.fecha_vuelo', desdeTs)
        .lte('vuelo.fecha_vuelo', hastaTs),
    ]);
    for (const r of [
      pendRes,
      completadosRes,
      gastosRes,
      movRes,
      revRes,
      pistasRes,
      legsRes,
    ]) {
      if (r.error) throw new Error(r.error.message);
    }

    // Tramos fuera de orden cronológico (el "regreso" sale antes que la ida):
    // casi siempre es un dedazo al capturar la fecha (caso real: folio 10).
    // No altera montos, pero sí calendario/reportes por fecha — se avisa.
    const legs = (legsRes.data ?? []) as Array<Record<string, unknown>>;
    const legsPorVuelo = new Map<
      string,
      Array<{ orden: number; fecha: string }>
    >();
    for (const e of legs) {
      const list = legsPorVuelo.get(e.vuelo_id as string) ?? [];
      list.push({
        orden: Number(e.orden),
        fecha: e.fecha_salida_plan as string,
      });
      legsPorVuelo.set(e.vuelo_id as string, list);
    }
    const fechasFueraDeOrden: Array<{ id: string; folio: number }> = [];
    for (const [vueloId, list] of legsPorVuelo) {
      list.sort((a, b) => a.orden - b.orden);
      const desorden = list.some(
        (l, i) =>
          i > 0 &&
          new Date(l.fecha).getTime() < new Date(list[i - 1].fecha).getTime(),
      );
      if (desorden) {
        const row = legs.find((e) => e.vuelo_id === vueloId);
        const vuelo = row?.vuelo as Record<string, unknown> | undefined;
        fechasFueraDeOrden.push({
          id: vueloId,
          folio: Number(vuelo?.folio ?? 0),
        });
      }
    }
    fechasFueraDeOrden.sort((a, b) => a.folio - b.folio);

    // Aterrizajes sin su gasto de pista: la cuota de VIP SAESA se paga días
    // después — si no se provisiona, el reparto sale inflado.
    const escalasPista = (pistasRes.data ?? []) as Array<
      Record<string, unknown>
    >;
    let pistasSinGasto = 0;
    if (escalasPista.length > 0) {
      const { data: gastosPista, error: gpErr } = await sb
        .from('gasto')
        .select('escala_id, categoria')
        .in(
          'escala_id',
          escalasPista.map((e) => e.id as string),
        )
        .in('categoria', ['OPERACIONES', 'ATERRIZAJE']);
      if (gpErr) throw new Error(gpErr.message);
      const cubiertas = new Set(
        (gastosPista ?? []).map((g) => g.escala_id as string),
      );
      pistasSinGasto = escalasPista.filter(
        (e) => !cubiertas.has(e.id as string),
      ).length;
    }

    // Vuelos COMPLETADOS por piloto EXTERNO sin su honorario capturado: el
    // pago del freelance es gasto DIRECTO del vuelo — si falta, la utilidad
    // del reparto sale inflada en silencio.
    let externosSinHonorario = 0;
    {
      const completadosRows = (completadosRes.data ?? []) as Array<
        Record<string, unknown>
      >;
      const pilotoIds = [
        ...new Set(
          completadosRows
            .map((v) => v.piloto_id as string | null)
            .filter(Boolean),
        ),
      ] as string[];
      if (pilotoIds.length > 0) {
        const { data: exts, error: extErr } = await sb
          .from('usuario')
          .select('id')
          .in('id', pilotoIds)
          .eq('es_piloto_externo', true);
        if (extErr) throw new Error(extErr.message);
        const externos = new Set((exts ?? []).map((u) => u.id as string));
        const vuelosExternos = completadosRows.filter((v) =>
          externos.has(v.piloto_id as string),
        );
        if (vuelosExternos.length > 0) {
          const { data: gastosPE, error: gpeErr } = await sb
            .from('gasto')
            .select('vuelo_id')
            .in(
              'vuelo_id',
              vuelosExternos.map((v) => v.id as string),
            )
            .eq('categoria', 'PILOTO_EXTERNO');
          if (gpeErr) throw new Error(gpeErr.message);
          const cubiertos = new Set(
            (gastosPE ?? []).map((g) => g.vuelo_id as string),
          );
          externosSinHonorario = vuelosExternos.filter(
            (v) => !cubiertos.has(v.id as string),
          ).length;
        }
      }
    }

    const vuelosSinCompletar = (pendRes.data ?? []).map((v) => ({
      id: v.id as string,
      folio: v.folio as number,
      estado: v.estado as string,
      fecha_vuelo: v.fecha_vuelo as string | null,
    }));

    // Cobros pendientes con SALDO real (soporta pago parcial).
    const completados = (completadosRes.data ?? []) as Array<
      Record<string, unknown>
    >;
    const ids = completados.map((v) => v.id as string);
    const cobros = await this.fetchCobros(ids);
    const porVuelo = new Map<string, CobroRow[]>();
    for (const c of cobros) {
      const list = porVuelo.get(c.vuelo_id) ?? [];
      list.push(c);
      porVuelo.set(c.vuelo_id, list);
    }
    const cobrosPendientes: Array<{
      id: string;
      folio: number;
      total_usd: number;
      cobrado_usd: number;
      saldo_usd: number;
    }> = [];
    for (const v of completados) {
      const total = Number(v.monto_total_usd ?? 0);
      const conv = cobrosEnUsd(
        porVuelo.get(v.id as string) ?? [],
        v.tc_usd_mxn == null ? null : Number(v.tc_usd_mxn),
      );
      const saldo = round2(total - conv.total_usd);
      if (saldo > 1) {
        cobrosPendientes.push({
          id: v.id as string,
          folio: v.folio as number,
          total_usd: round2(total),
          cobrado_usd: conv.total_usd,
          saldo_usd: saldo,
        });
      }
    }

    const gastos = (gastosRes.data ?? []) as Array<Record<string, unknown>>;
    // FIJO e INDIRECTO no llevan avión por diseño: no bloquean el cierre.
    const sinAvion = gastos.filter(
      (g) =>
        g.aeronave_id == null &&
        g.categoria !== 'FIJO' &&
        g.categoria !== 'INDIRECTO',
    );
    const sinTc = gastos.filter(
      (g) => g.moneda === 'MXN' && !(Number(g.tc_gasto) > 0),
    );
    const sinComprobante = gastos.filter(
      (g) => g.estatus_comprobante !== 'FACTURA',
    );
    const movs = (movRes.data ?? []) as Array<Record<string, unknown>>;

    const items = [
      {
        clave: 'vuelos_sin_completar',
        titulo: 'Vuelos del periodo sin completar',
        detalle:
          'Sus horas e ingresos NO entran al cierre hasta completarse (o cancelarse).',
        count: vuelosSinCompletar.length,
        vuelos: vuelosSinCompletar,
      },
      {
        clave: 'tacos_en_revision',
        titulo: 'Tacómetros en revisión (amarillos)',
        detalle: 'Confírmalos o ajústalos en Tacómetros en vivo.',
        count: (revRes.data ?? []).length,
      },
      {
        clave: 'fechas_tramos_incoherentes',
        titulo: 'Vuelos con fechas de tramos fuera de orden',
        detalle:
          'Un tramo "sale" antes que el tramo anterior (dedazo de fecha): corrígelo en el detalle del vuelo → Asignación por tramo.',
        count: fechasFueraDeOrden.length,
        vuelos: fechasFueraDeOrden,
      },
      {
        clave: 'cobros_pendientes',
        titulo: 'Vuelos completados con saldo por cobrar',
        detalle:
          'Solo se reparte lo cobrado: este dinero queda fuera del reparto.',
        count: cobrosPendientes.length,
        monto_usd: round2(
          cobrosPendientes.reduce((acc, c) => acc + c.saldo_usd, 0),
        ),
        vuelos: cobrosPendientes,
      },
      {
        clave: 'gastos_sin_avion',
        titulo: 'Gastos sin avión asignado (bandeja)',
        detalle:
          'No se restan a ningún avión en el reparto. Meta: bandeja vacía.',
        count: sinAvion.length,
      },
      {
        clave: 'pistas_sin_gasto',
        titulo: 'Aterrizajes fuera de CUN sin gasto de pista',
        detalle:
          'La cuota de aeródromo (VIP SAESA) aún no está provisionada: genérala en Gastos → "Pistas por pagar" o el reparto saldrá inflado.',
        count: pistasSinGasto,
      },
      {
        clave: 'externos_sin_honorario',
        titulo: 'Vuelos de piloto externo sin honorario capturado',
        detalle:
          'El pago del freelance es gasto directo del vuelo (categoría "Piloto externo"): captúralo en Gastos y lígalo al vuelo, o el reparto saldrá inflado.',
        count: externosSinHonorario,
      },
      {
        clave: 'gastos_sin_tc',
        titulo: 'Gastos MXN sin tipo de cambio',
        detalle: 'Quedan FUERA del balance USD hasta capturarles TC.',
        count: sinTc.length,
        monto_mxn: round2(sinTc.reduce((acc, g) => acc + Number(g.monto), 0)),
      },
      {
        clave: 'gastos_sin_comprobante',
        titulo: 'Gastos sin factura (VALE / sin comprobante)',
        detalle: 'Aparecerán así en el paquete del contador.',
        count: sinComprobante.length,
      },
      {
        clave: 'sin_conciliar',
        titulo: 'Movimientos bancarios sin conciliar',
        detalle: 'El estado de cuenta no cuadra contra lo capturado.',
        count: movs.length,
        monto: round2(movs.reduce((acc, m) => acc + Number(m.monto), 0)),
      },
    ];

    // Lo único que BLOQUEA números: vuelos sin completar, tacos amarillos,
    // gastos sin TC. El resto es aviso (cobranza/conciliación son procesos).
    const bloqueantes = [
      'vuelos_sin_completar',
      'tacos_en_revision',
      'gastos_sin_tc',
    ];
    const listo = items
      .filter((i) => bloqueantes.includes(i.clave))
      .every((i) => i.count === 0);

    return { periodo: { desde: q.desde, hasta: q.hasta }, listo, items };
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

  /**
   * Solo vuelos COMPLETADOS (los que realmente volaron): las cotizaciones que
   * nunca se cerraron no inflan el "pendiente de cobro" de los socios. Cortes
   * en hora Cancún (UTC−5): un vuelo nocturno del día 31 pertenece a SU mes.
   */
  private async fetchVuelos(desde: string, hasta: string): Promise<VueloRow[]> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, aeronave_id, monto_total_usd, tc_usd_mxn, cobrado, comision_vendedor_usd',
      )
      .eq('estado', 'COMPLETADO')
      .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchCobros(vueloIds: string[]): Promise<CobroRow[]> {
    if (vueloIds.length === 0) return [];
    const { data, error } = await this.supabase.service
      .from('cobro_vuelo')
      .select('vuelo_id, monto, moneda, tc_usd_mxn')
      .in('vuelo_id', vueloIds);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchEscalasHoras(
    vueloIds: string[],
  ): Promise<EscalaHorasRow[]> {
    if (vueloIds.length === 0) return [];
    const { data, error } = await this.supabase.service
      .from('escala')
      .select('vuelo_id, aeronave_id, taco_salida, taco_llegada')
      .in('vuelo_id', vueloIds);
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
