import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import type { ProfitSharingQuery } from './dto/profit-sharing.dto';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import {
  expandirConReparto,
  fetchRepartos,
} from '../../common/gasto-reparto.util';

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
  // Campos informativos para el desglose por avión (detalle.vuelos); no
  // alteran ningún cálculo del reparto.
  folio: number | null;
  fecha_vuelo: string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  es_externo: boolean;
  /** Solo externos: lo que cobra el operador dueño del avión. */
  costo_externo_usd: string | null;
}

/** Grupo del reparto al que aporta una categoría de gasto (doc 4.8). */
type GrupoGasto = 'DIRECTO' | 'INDIRECTO' | 'PERMISO' | 'FIJO' | 'EXCLUIDO';

interface GastoCategoriaAcc {
  grupo: GrupoGasto;
  /** Gastos que SÍ convirtieron a USD (los sin TC van en sin_tc_count). */
  count: number;
  usd: number;
  sin_tc_count: number;
  sin_tc_mxn: number;
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
  id: string;
  aeronave_id: string | null;
  categoria: string;
  monto: string | number;
  moneda: string;
  tc_gasto: string | null;
  /** Clon parcial generado por el reparto manual (gasto_reparto). */
  es_reparto_parcial?: boolean;
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
        // El PDF/XLSX a socios es el reporte VITAL: si las vigencias de
        // socios traslapan mal (total ≠ 100%), la advertencia debe viajar
        // impresa — la web ya lo delataba con un badge, el papel no.
        reparto_porcentaje_total: a.reparto_porcentaje_total,
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
      // MISMO shape que la respuesta normal: el panel lee gastos_sin_tc y
      // externos antes de revisar aviones.length (sin esto crasheaba antes
      // de llegar a su propio EmptyState).
      return {
        periodo: { desde: q.desde, hasta: q.hasta },
        gastos_sin_tc: { count: 0, monto_mxn: 0 },
        externos: {
          vuelos: 0,
          cobrado_usd: 0,
          costo_usd: 0,
          utilidad_usd: 0,
          sin_costo_count: 0,
          cobros_sin_tc_mxn: 0,
        },
        aviones: [],
      };
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

    // REPARTO MANUAL (26-ago-2026, gasto_reparto): el reparto GANA sobre
    // aeronave_id — el gasto repartido se sustituye por sus PARCIALES (uno
    // por avión, moneda/TC del padre) y el remanente queda como gasto de la
    // EMPRESA (no se carga a nadie). Regla única en gasto-reparto.util.
    const repartos = await fetchRepartos(
      this.supabase.service,
      gastos.map((g) => g.id),
    );
    const { atribuciones: gastosAtribuidos } = expandirConReparto(
      gastos,
      repartos,
    );

    // Pool de gastos fijos (sueldos, seguros) de todo el periodo. Un FIJO
    // con reparto MANUAL sale del pool (sus parciales van directo al avión
    // elegido; contar ambos lo restaría DOBLE).
    let fijoPoolUsd = 0;
    let sinTcCount = 0;
    let sinTcMxn = 0;
    for (const g of gastosAtribuidos) {
      if (g.categoria !== FIJO || g.es_reparto_parcial) continue;
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
        gastos: gastosAtribuidos,
        socios,
        reservas,
        nombres,
        otrosPorAvion,
        periodo: q,
      }),
    );

    // Vuelos EXTERNOS del periodo (aeronave_id null: no entran a ninguna
    // card por avión). Su dinero cobrado ANTES desaparecía del reparto sin
    // rastro; aquí se hace visible como bloque informativo — la utilidad
    // externa NO se distribuye entre socios (el vuelo no es de un avión de
    // la flota) hasta que el cliente decida su tratamiento.
    let extCobrado = 0;
    let extCosto = 0;
    let extSinCosto = 0;
    let extSinTcMxn = 0;
    const externosVuelos = vuelos.filter((v) => v.es_externo === true);
    for (const v of externosVuelos) {
      const conv = cobrosEnUsd(
        cobrosPorVuelo.get(v.id) ?? [],
        v.tc_usd_mxn == null ? null : Number(v.tc_usd_mxn),
      );
      extCobrado += conv.total_usd;
      extSinTcMxn += conv.sin_tc_mxn;
      if (v.costo_externo_usd == null) {
        extSinCosto += 1;
      } else {
        extCosto += Number(v.costo_externo_usd);
      }
    }
    const extCobradoR = round2(extCobrado);
    const extCostoR = round2(extCosto);

    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      gastos_sin_tc: { count: sinTcCount, monto_mxn: round2(sinTcMxn) },
      externos: {
        vuelos: externosVuelos.length,
        cobrado_usd: extCobradoR,
        costo_usd: extCostoR,
        utilidad_usd: round2(extCobradoR - extCostoR),
        sin_costo_count: extSinCosto,
        cobros_sin_tc_mxn: round2(extSinTcMxn),
      },
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
    // Comisiones de venta (Itzy/Pablo/broker): el cliente paga el total —
    // que desde jul 2026 YA incluye la comisión sumada al precio — pero esa
    // parte no es de VuelaTour: se descuenta del ingreso a repartir y el
    // neto queda ≈ precio base. Se hace efectiva contra lo cobrado (tope:
    // lo cobrado del vuelo — este Math.min SÍ se queda: no se descuenta
    // comisión de dinero que aún no entra).
    let comisionesVenta = 0;
    // Desglose por vuelo: se llena en el MISMO loop y con los MISMOS números
    // que los agregados (misma conversión cobrosEnUsd, mismo tope de comisión)
    // para que la suma del detalle cuadre exacto con ingresos.*.
    const detalleVuelos: Array<{
      id: string;
      folio: number | null;
      fecha: string | null;
      ruta: string;
      es_externo: boolean;
      total_usd: number;
      cobrado_usd: number;
      pendiente_usd: number;
      comision_vendedor_usd: number;
      cobrado: boolean;
      cobros_sin_tc_mxn: number;
    }> = [];
    for (const v of ctx.vuelos) {
      if (v.aeronave_id !== a.id) continue;
      const monto = Number(v.monto_total_usd ?? 0);
      const conv = cobrosEnUsd(
        ctx.cobrosPorVuelo.get(v.id) ?? [],
        v.tc_usd_mxn == null ? null : Number(v.tc_usd_mxn),
      );
      const pendienteVuelo = Math.max(0, monto - conv.total_usd);
      const comisionEfectiva = Math.min(
        Number(v.comision_vendedor_usd ?? 0),
        conv.total_usd,
      );
      cobrado += conv.total_usd;
      cobrosSinTcMxn += conv.sin_tc_mxn;
      pendiente += pendienteVuelo;
      comisionesVenta += comisionEfectiva;
      if (v.cobrado) vuelosCobrados += 1;
      else vuelosPendientes += 1;
      detalleVuelos.push({
        id: v.id,
        folio: v.folio ?? null,
        fecha: diaCancun(v.fecha_vuelo),
        ruta: `${v.origen_iata ?? '—'} → ${v.destino_iata ?? '—'}`,
        es_externo: v.es_externo === true,
        total_usd: round2(monto),
        cobrado_usd: conv.total_usd,
        pendiente_usd: round2(pendienteVuelo),
        comision_vendedor_usd: round2(comisionEfectiva),
        cobrado: v.cobrado,
        cobros_sin_tc_mxn: conv.sin_tc_mxn,
      });
    }
    detalleVuelos.sort(
      (x, y) =>
        // Fecha asc; los sin fecha al final. Folio como desempate estable.
        (x.fecha ?? '9999-99-99').localeCompare(y.fecha ?? '9999-99-99') ||
        (x.folio ?? 0) - (y.folio ?? 0),
    );

    // Gastos acumulados POR CATEGORÍA (misma conversión toUsd, mismo filtro
    // de avión). Los agregados directos/indirectos/permisos/sin_tc se derivan
    // de ESTE acumulador, así el desglose cuadra con ellos por construcción.
    const porCategoria = new Map<string, GastoCategoriaAcc>();
    for (const g of ctx.gastos) {
      if (g.aeronave_id !== a.id) continue;
      // Parciales del reparto MANUAL (gasto_reparto): la categoría
      // INDIRECTO repartida SÍ cuenta (grupo INDIRECTO — esta feature ES la
      // decisión que estaba pendiente; SIN reparto sigue EXCLUIDA = empresa,
      // idéntico a antes). Un FIJO repartido va al grupo FIJO manual (suma
      // en otros_prorrateados junto al pool — mismo campo de la cascada).
      const grupo: GrupoGasto =
        // GASOLINA repartida a mano cuenta como "otros gastos" del avión
        // (mismo grupo que INDIRECTO repartido); sin reparto = EXCLUIDO.
        g.es_reparto_parcial &&
        (g.categoria === 'INDIRECTO' ||
          g.categoria === 'GASOLINA' ||
          g.categoria === 'VISITA')
          ? 'INDIRECTO'
          : g.es_reparto_parcial && g.categoria === FIJO
            ? 'FIJO'
            : DIRECTO.has(g.categoria)
              ? 'DIRECTO'
              : INDIRECTO.has(g.categoria)
                ? 'INDIRECTO'
                : PERMISO.has(g.categoria)
                  ? 'PERMISO'
                  : // FIJO se prorratea aparte; otras categorias no
                    // avion-especificas SIN reparto (p. ej. la categoría
                    // INDIRECTO) se EXCLUYEN — detalle solo transparencia.
                    'EXCLUIDO';
      // Clave separada para parciales: el detalle muestra "OTRO (repartido)"
      // y un FIJO/INDIRECTO repartido no colisiona con su versión cruda.
      const clave = g.es_reparto_parcial
        ? `${g.categoria} (repartido)`
        : g.categoria;
      const acc = porCategoria.get(clave) ?? {
        grupo,
        count: 0,
        usd: 0,
        sin_tc_count: 0,
        sin_tc_mxn: 0,
      };
      const usd = this.toUsd(g);
      if (usd === null) {
        acc.sin_tc_count += 1;
        acc.sin_tc_mxn += Number(g.monto);
      } else {
        acc.count += 1;
        acc.usd += usd;
      }
      porCategoria.set(clave, acc);
    }
    let directos = 0;
    let indirectos = 0;
    let permisos = 0;
    let fijoManual = 0;
    let sinTc = 0;
    let sinTcMxn = 0;
    for (const acc of porCategoria.values()) {
      if (acc.grupo === 'DIRECTO') directos += acc.usd;
      else if (acc.grupo === 'INDIRECTO') indirectos += acc.usd;
      else if (acc.grupo === 'PERMISO') permisos += acc.usd;
      else if (acc.grupo === 'FIJO') fijoManual += acc.usd;
      // EXCLUIDO no suma al balance (comportamiento original del else).
      sinTc += acc.sin_tc_count;
      sinTcMxn += acc.sin_tc_mxn;
    }
    const detalleGastos = [...porCategoria.entries()]
      .map(([categoria, acc]) => ({
        categoria,
        grupo: acc.grupo,
        count: acc.count,
        usd: round2(acc.usd),
        sin_tc_count: acc.sin_tc_count,
        sin_tc_mxn: round2(acc.sin_tc_mxn),
      }))
      .sort((x, y) => y.usd - x.usd);

    // Reserva de overhaul DEL PERIODO = horas voladas del periodo × tarifa por
    // hora (sumada por motor: bimotor = 2 filas). Antes se multiplicaba por el
    // acumulado DE POR VIDA, restando lo mismo (y creciente) cada mes.
    const horasPeriodo = round2(ctx.horasPorAvion.get(a.id) ?? 0);
    const tarifaReserva = ctx.reservas
      .filter((r) => r.aeronave_id === a.id)
      .reduce((acc, r) => acc + Number(r.monto_por_hora_usd), 0);
    const reservaOverhaul = horasPeriodo * tarifaReserva;
    const reservaIncompleta = horasPeriodo > 0 && tarifaReserva <= 0;

    // Disciplina v1.3 (redondear ANTES de sumar): el saldo se calcula con los
    // MISMOS componentes redondeados que se publican, así la cascada del PDF
    // cuadra al centavo (antes difería 1-3 ¢ por decimales largos de TC).
    const cobradoR = round2(cobrado);
    const comisionesR = round2(comisionesVenta);
    const directosR = round2(directos);
    const indirectosR = round2(indirectos);
    const permisosR = round2(permisos);
    // Pool automático + FIJO repartido a mano hacia ESTE avión: mismo campo
    // de la cascada (otros_prorrateados) — el PDF/XLSX no cambia de shape.
    const otrosR = round2(ctx.otrosPorAvion + fijoManual);
    const reservaR = round2(reservaOverhaul);
    const saldo = round2(
      cobradoR -
        comisionesR -
        directosR -
        indirectosR -
        permisosR -
        otrosR -
        reservaR,
    );

    // Reparto por residuo mayor (en centavos): con porcentajes que suman 100,
    // la suma de las partes da EXACTO el saldo (antes 50/50 de 100.01 daba
    // 50.01 + 50.01 = 100.02). Con ≠100% se reparte proporcional tal cual y
    // el badge/advertencia de porcentajes lo delata.
    const vigentes = ctx.socios.filter(
      (s) =>
        s.aeronave_id === a.id &&
        s.vigente_desde <= ctx.periodo.hasta &&
        (s.vigente_hasta === null || s.vigente_hasta >= ctx.periodo.desde),
    );
    const saldoCents = Math.round(saldo * 100);
    const partes = vigentes.map((s) => {
      const pct = Number(s.porcentaje);
      const exacto = (pct / 100) * saldoCents;
      return {
        s,
        pct,
        cents: Math.floor(exacto),
        resto: exacto - Math.floor(exacto),
      };
    });
    const repartoPct = partes.reduce((acc, p) => acc + p.pct, 0);
    let faltan =
      Math.round((repartoPct / 100) * saldoCents) -
      partes.reduce((acc, p) => acc + p.cents, 0);
    for (const p of [...partes].sort((x, y) => y.resto - x.resto)) {
      if (faltan <= 0) break;
      p.cents += 1;
      faltan -= 1;
    }
    const reparto = partes.map((p) => ({
      socio_id: p.s.socio_id,
      socio_nombre: ctx.nombres.get(p.s.socio_id) ?? 'Socio',
      porcentaje: p.pct,
      monto_usd: p.cents / 100,
    }));

    return {
      aeronave: { id: a.id, matricula: a.matricula, modelo: a.modelo },
      ingresos: {
        cobrado_usd: cobradoR,
        comisiones_venta_usd: comisionesR,
        pendiente_cobro_usd: round2(pendiente),
        vuelos_cobrados: vuelosCobrados,
        vuelos_pendientes: vuelosPendientes,
        cobros_sin_tc_mxn: round2(cobrosSinTcMxn),
      },
      horas_voladas_hr: horasPeriodo,
      gastos: {
        directos_usd: directosR,
        indirectos_usd: indirectosR,
        permisos_usd: permisosR,
        otros_prorrateados_usd: otrosR,
        gastos_sin_tc_count: sinTc,
        gastos_sin_tc_mxn: round2(sinTcMxn),
      },
      reserva_overhaul_usd: reservaR,
      reserva_overhaul_incompleta: reservaIncompleta,
      saldo_disponible_usd: saldo,
      reparto,
      reparto_porcentaje_total: round2(repartoPct),
      // Desglose ADITIVO del avión (vuelo por vuelo y gasto por categoría).
      // Sale de los mismos loops de arriba: sus sumas cuadran con los
      // agregados. El PDF/XLSX del reparto no lo consume (mapea campos
      // específicos en buildRepartoPayload).
      detalle: {
        vuelos: detalleVuelos,
        gastos_por_categoria: detalleGastos,
        reserva: {
          horas_hr: horasPeriodo,
          tarifa_hora_usd: round2(tarifaReserva),
          monto_usd: round2(reservaOverhaul),
        },
      },
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
      canceladosRes,
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
        .select(
          'id, folio, piloto_id, cliente_id, monto_total_usd, tc_usd_mxn, cobrado',
        )
        .eq('estado', 'COMPLETADO')
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs),
      // Cancelados del periodo: pueden tener dinero vivo (cobros por cargo de
      // cancelación y gastos provisionados) que el reparto ignora.
      sb
        .from('vuelo')
        .select('id, folio, tc_usd_mxn')
        .eq('estado', 'CANCELADO')
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs),
      // Gastos del periodo con huecos de datos.
      sb
        .from('gasto')
        .select(
          'id, vuelo_id, aeronave_id, categoria, monto, moneda, tc_gasto, estatus_facturacion, medio_pago, conciliado, duplicado_sospechado, matricula_ia:valor_ia_extraido->>matricula',
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
      // Tacómetros en revisión (amarillos) de vuelos del periodo. Tramos
      // cancelados fuera (no volaron: nada que revisar/capturar).
      sb
        .from('escala')
        .select('id, vuelo:vuelo_id!inner(folio, fecha_vuelo, estado)')
        .eq('revision_requerida', true)
        .is('cancelada_at', null)
        .neq('vuelo.estado', 'CANCELADO')
        .gte('vuelo.fecha_vuelo', desdeTs)
        .lte('vuelo.fecha_vuelo', hastaTs),
      // Aterrizajes fuera de CUN del periodo (candidatos a cuota de pista).
      // Externos fuera: sus pistas las paga el operador externo (mismo
      // criterio que expenses.pistasPendientes, o los conteos no cuadran).
      sb
        .from('escala')
        .select(
          'id, destino_iata, vuelo:vuelo_id!inner(folio, fecha_vuelo, estado, es_externo)',
        )
        .neq('destino_iata', 'CUN')
        .is('cancelada_at', null)
        .neq('vuelo.estado', 'CANCELADO')
        .eq('vuelo.es_externo', false)
        .gte('vuelo.fecha_vuelo', desdeTs)
        .lte('vuelo.fecha_vuelo', hastaTs),
      // Fechas de tramos: detectar tramos que "salen" antes que el anterior.
      sb
        .from('escala')
        .select(
          'vuelo_id, orden, fecha_salida_plan, vuelo:vuelo_id!inner(folio, estado)',
        )
        .not('fecha_salida_plan', 'is', null)
        .is('cancelada_at', null)
        .neq('vuelo.estado', 'CANCELADO')
        .gte('vuelo.fecha_vuelo', desdeTs)
        .lte('vuelo.fecha_vuelo', hastaTs),
    ]);
    for (const r of [
      pendRes,
      completadosRes,
      canceladosRes,
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
    let externosSinHonorarioVuelos: Array<{ id: string; folio: number }> = [];
    {
      const completadosRows = (completadosRes.data ?? []) as Array<
        Record<string, unknown>
      >;
      // Pilotos EFECTIVOS del vuelo: nivel vuelo + rotaciones por TRAMO
      // (barrido 28-ago: un externo que cubre solo un tramo — caso #129 —
      // escapaba a esta vigilancia y la utilidad quedaba inflada).
      const pilotosPorVuelo = new Map<string, Set<string>>();
      for (const v of completadosRows) {
        const set = new Set<string>();
        if (v.piloto_id) set.add(v.piloto_id as string);
        pilotosPorVuelo.set(v.id as string, set);
      }
      if (completadosRows.length > 0) {
        const { data: legsRot, error: legsErr } = await sb
          .from('escala')
          .select('vuelo_id, piloto_id')
          .in(
            'vuelo_id',
            completadosRows.map((v) => v.id as string),
          )
          .not('piloto_id', 'is', null)
          .is('cancelada_at', null);
        if (legsErr) throw new Error(legsErr.message);
        for (const l of legsRot ?? []) {
          pilotosPorVuelo
            .get(l.vuelo_id as string)
            ?.add(l.piloto_id as string);
        }
      }
      const pilotoIds = [
        ...new Set(
          [...pilotosPorVuelo.values()].flatMap((set) => [...set]),
        ),
      ];
      if (pilotoIds.length > 0) {
        const { data: exts, error: extErr } = await sb
          .from('usuario')
          .select('id')
          .in('id', pilotoIds)
          .eq('es_piloto_externo', true);
        if (extErr) throw new Error(extErr.message);
        const externos = new Set((exts ?? []).map((u) => u.id as string));
        const vuelosExternos = completadosRows.filter((v) =>
          [...(pilotosPorVuelo.get(v.id as string) ?? [])].some((pid) =>
            externos.has(pid),
          ),
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
          const sinHonorario = vuelosExternos.filter(
            (v) => !cubiertos.has(v.id as string),
          );
          externosSinHonorario = sinHonorario.length;
          // Folios para el checklist: sin ellos el operador llegaba a
          // Gastos sabiendo solo el conteo, sin poder identificar los
          // vuelos (era la única clave por-vuelo sin su arreglo `vuelos`).
          externosSinHonorarioVuelos = sinHonorario.map((v) => ({
            id: v.id as string,
            folio: v.folio as number,
          }));
        }
      }
    }

    // Dinero vivo en vuelos CANCELADOS del periodo: cobros registrados (cargo
    // por cancelación que hoy queda FUERA del reparto) y gastos ligados (p.ej.
    // pistas provisionadas de un vuelo que luego se canceló). Nadie los
    // vigilaba: no alteran el reparto, pero la oficina debe revisarlos.
    const cancelados = (canceladosRes.data ?? []) as Array<
      Record<string, unknown>
    >;
    const cobrosEnCancelados: Array<{
      id: string;
      folio: number;
      cobrado_usd: number;
    }> = [];
    let cobrosEnCanceladosUsd = 0;
    let gastosEnCanceladosCount = 0;
    const vuelosConGastoCancelado: Array<{ id: string; folio: number }> = [];
    if (cancelados.length > 0) {
      const idsCancelados = cancelados.map((v) => v.id as string);
      const [cobrosCanc, gastosCancRes] = await Promise.all([
        this.fetchCobros(idsCancelados),
        sb.from('gasto').select('id, vuelo_id').in('vuelo_id', idsCancelados),
      ]);
      if (gastosCancRes.error) throw new Error(gastosCancRes.error.message);

      const cobrosPorCancelado = new Map<string, CobroRow[]>();
      for (const c of cobrosCanc) {
        const list = cobrosPorCancelado.get(c.vuelo_id) ?? [];
        list.push(c);
        cobrosPorCancelado.set(c.vuelo_id, list);
      }
      const vuelosConGasto = new Set(
        (gastosCancRes.data ?? []).map((g) => g.vuelo_id as string),
      );
      for (const v of cancelados) {
        const lista = cobrosPorCancelado.get(v.id as string) ?? [];
        if (lista.length > 0) {
          // Fuente única de "cuánto se cobró en USD" (cobrosEnUsd); los MXN
          // sin TC quedan fuera del monto pero el vuelo sí cuenta.
          const conv = cobrosEnUsd(
            lista,
            v.tc_usd_mxn == null ? null : Number(v.tc_usd_mxn),
          );
          cobrosEnCancelados.push({
            id: v.id as string,
            folio: v.folio as number,
            cobrado_usd: conv.total_usd,
          });
          cobrosEnCanceladosUsd += conv.total_usd;
        }
        if (vuelosConGasto.has(v.id as string)) {
          vuelosConGastoCancelado.push({
            id: v.id as string,
            folio: v.folio as number,
          });
        }
      }
      gastosEnCanceladosCount = (gastosCancRes.data ?? []).length;
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
    // Clientes INTERNOS (reposicionamiento/demostración/servicio): operación
    // propia sin cobro esperado — sus vuelos NO son cuentas por cobrar y se
    // excluyen del regaño de cobranza (lookup en lote cliente_id→es_interno).
    const clientesInternos = new Set<string>();
    {
      const clienteIds = [
        ...new Set(
          completados
            .map((v) => v.cliente_id as string | null)
            .filter((c): c is string => !!c),
        ),
      ];
      if (clienteIds.length > 0) {
        const { data: internos, error: intErr } = await sb
          .from('cliente')
          .select('id')
          .in('id', clienteIds)
          .eq('es_interno', true);
        if (intErr) throw new Error(intErr.message);
        for (const c of internos ?? []) clientesInternos.add(c.id as string);
      }
    }
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
      // Cliente interno: nunca aparece como "saldo por cobrar" (aunque la
      // cotización llevara monto), es operación propia.
      if (clientesInternos.has(v.cliente_id as string)) continue;
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

    // Completados SIN precio de cliente REAL: el gate de `cobrado` exige
    // monto>0 y la alerta de cobranza los calla a propósito (Servicio/$0) —
    // este renglón es su ÚNICA vigilancia: sin cotización no hay cuenta por
    // cobrar y el ingreso del vuelo se pierde en silencio.
    const vuelosSinPrecio = completados
      .filter(
        (v) =>
          !clientesInternos.has(v.cliente_id as string) &&
          !(Number(v.monto_total_usd ?? 0) > 0),
      )
      .map((v) => ({ id: v.id as string, folio: v.folio as number }));

    const gastos = (gastosRes.data ?? []) as Array<Record<string, unknown>>;
    // Repartos manuales del periodo: un gasto con filas en gasto_reparto YA
    // está asignado (misma regla que la bandeja de Gastos — simetría).
    const repartosPre = await fetchRepartos(
      this.supabase.service,
      gastos.map((g) => g.id as string),
    );
    // FIJO e INDIRECTO no llevan avión por diseño: no bloquean el cierre.
    // OTRO sin vuelo tampoco: sin reparto es gasto de la EMPRESA VuelaTour
    // a propósito (regla 26-ago — se reparte en la pantalla Otros gastos).
    const sinAvion = gastos.filter(
      (g) =>
        g.aeronave_id == null &&
        g.categoria !== 'FIJO' &&
        g.categoria !== 'INDIRECTO' &&
        // PERSONAL_DUENO jamás lleva avión (gasto personal del dueño).
        g.categoria !== 'PERSONAL_DUENO' &&
        // GASOLINA (vehículos) tampoco: gasto de la empresa, se reparte a
        // mano en Otros gastos si acaso. VISITA ídem (rol visitante).
        g.categoria !== 'GASOLINA' &&
        g.categoria !== 'VISITA' &&
        !(g.categoria === 'OTRO' && g.vuelo_id == null) &&
        !repartosPre.has(g.id as string),
    );
    // Reparto incoherente: Σ parciales > monto del gasto (p. ej. se editó el
    // monto a la baja DESPUÉS de repartir) — el sobrante restaría dinero
    // inexistente a los aviones. Aviso para corregir en Otros gastos.
    const repartosIncoherentes = gastos.filter((g) => {
      const filas = repartosPre.get(g.id as string);
      if (!filas) return false;
      const suma = filas.reduce((acc, r) => acc + r.monto, 0);
      return Math.round(suma * 100) > Math.round(Number(g.monto ?? 0) * 100);
    });
    // COMBUSTIBLE sin avión (26-ago-2026): con el modelo "gas por avión/mes"
    // el aeronave_id es la ÚNICA liga del combustible al balance y al
    // reparto — una carga sin avión es dinero invisible. BLOQUEA el cierre.
    const gasSinAvion = sinAvion.filter((g) => g.categoria === 'GAS');
    // El caso inverso: un FIJO capturado CON avión se prorratea igual entre
    // toda la flota (el pool no mira aeronave_id) y en el detalle del avión
    // asignado aparece EXCLUIDO — doble lectura silenciosa. Aviso, no candado.
    const fijosConAvion = gastos.filter(
      // Un FIJO REPARTIDO a mano no es doble lectura: salió del pool y sus
      // parciales van al avión elegido (verificación 26-ago).
      (g) =>
        g.aeronave_id != null &&
        g.categoria === 'FIJO' &&
        !repartosPre.has(g.id as string),
    );
    const sinTc = gastos.filter(
      // PERSONAL_DUENO no entra al balance USD: su TC no bloquea el cierre.
      (g) =>
        g.moneda === 'MXN' &&
        !(Number(g.tc_gasto) > 0) &&
        g.categoria !== 'PERSONAL_DUENO',
    );
    // Seguimiento de oficina (estatus_facturacion), NO el comprobante del
    // piloto: la app marca FACTURA con cualquier foto, aunque sea un ticket.
    // BODEGA se excluye: es cargo contable del puente de inventario y su
    // factura vive en la ENTRADA del cardex — jamás tendrá factura propia
    // (dejarlo contaría ruido eterno en el pre-cierre).
    const sinFacturar = gastos.filter(
      // PERSONAL_DUENO: la factura a la empresa no aplica (gasto del dueño).
      (g) =>
        g.estatus_facturacion !== 'FACTURADA' &&
        g.medio_pago !== 'BODEGA' &&
        g.categoria !== 'PERSONAL_DUENO',
    );
    // Posibles duplicados con el flag aún encendido: cada uno resta DOBLE al
    // reparto hasta que alguien lo resuelva (borrar el repetido o marcar
    // "No es duplicado" en Gastos → pestaña Duplicados).
    const duplicadosSinResolver = gastos.filter(
      // Los PERSONAL_DUENO duplicados no tocan el reparto: se resuelven en
      // la bandeja Gastos → Duplicados, no estorban el cierre.
      (g) =>
        g.duplicado_sospechado === true && g.categoria !== 'PERSONAL_DUENO',
    );
    // El espejo que faltaba: los MOVIMIENTOS sin conciliar ya se vigilan,
    // pero un GASTO bancario que nadie cruzó (p. ej. el sobrante de un
    // duplicado cuya pareja ya se concilió) era invisible para siempre.
    const bancariosSinConciliar = gastos.filter(
      (g) =>
        (g.medio_pago === 'TARJETA_CORP' || g.medio_pago === 'TRANSFERENCIA') &&
        g.conciliado !== true,
    );
    // Matrícula del comprobante ≠ avión asignado (26-ago, cruce ASUR MID):
    // en cambios de avión a media jornada el recibo trae la matrícula REAL y
    // la herencia del vuelo puede colgar el gasto en el avión equivocado —
    // el costo resta en el balance que no es. Red mensual del aviso que ya
    // salta en la captura.
    const { data: flotaPre } = await sb
      .from('aeronave')
      .select('id, matricula');
    const normMat = (m: string) => m.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const avionPorMatricula = new Map(
      (flotaPre ?? []).map((a) => [
        normMat(a.matricula as string),
        a.id as string,
      ]),
    );
    const matriculaCruzada = gastos.filter((g) => {
      const mIa = g.matricula_ia;
      if (typeof mIa !== 'string' || !mIa.trim() || g.aeronave_id == null)
        return false;
      const delRecibo = avionPorMatricula.get(normMat(mIa));
      return delRecibo != null && delRecibo !== g.aeronave_id;
    });
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
        clave: 'vuelos_sin_precio',
        titulo: 'Vuelos completados sin cotizar (precio en $0)',
        detalle:
          'Se volaron pero su cotización quedó en $0: cotízalos para poder cobrarlos — sin precio no aparecen en cobranza ni en el reparto.',
        count: vuelosSinPrecio.length,
        vuelos: vuelosSinPrecio,
      },
      {
        clave: 'combustible_sin_avion',
        titulo: 'Cargas de combustible sin avión',
        detalle:
          'El combustible se controla por avión/mes: sin aeronave no resta ' +
          'en ningún balance ni en el reparto. Asigna el avión en Combustibles.',
        count: gasSinAvion.length,
        monto_mxn: round2(
          gasSinAvion.reduce((acc, g) => acc + Number(g.monto ?? 0), 0),
        ),
      },
      {
        clave: 'repartos_incoherentes',
        titulo: 'Repartos de gasto que suman MÁS que el gasto',
        detalle:
          'Se editó el monto después de repartir: corrige el reparto en Otros gastos (restaría dinero inexistente).',
        count: repartosIncoherentes.length,
      },
      {
        clave: 'gastos_sin_avion',
        titulo: 'Gastos sin avión asignado (bandeja)',
        detalle:
          'No se restan a ningún avión en el reparto. Meta: bandeja vacía.',
        count: sinAvion.length,
      },
      {
        clave: 'fijos_con_avion',
        titulo: 'Gastos FIJOS capturados con avión',
        detalle:
          'Los FIJOS se prorratean entre TODA la flota aunque tengan avión: quítales el avión o cámbiales la categoría para que resten donde corresponde.',
        count: fijosConAvion.length,
      },
      {
        clave: 'matricula_recibo_distinta',
        titulo: 'Gastos cuyo comprobante trae OTRA matrícula',
        detalle:
          'La IA leyó en el recibo una matrícula distinta al avión asignado (típico en cambios de avión a media jornada): el costo puede estar restando en el avión equivocado. Corrige el avión del gasto en Gastos.',
        count: matriculaCruzada.length,
      },
      {
        clave: 'duplicados_sin_resolver',
        titulo: 'Posibles gastos duplicados sin resolver',
        detalle:
          'Cada duplicado resta DOBLE al reparto. Revísalos en Gastos → pestaña Duplicados: borra el repetido o marca "No es duplicado".',
        count: duplicadosSinResolver.length,
      },
      {
        clave: 'gastos_bancarios_sin_conciliar',
        titulo: 'Gastos bancarios sin conciliar al corte',
        detalle:
          'Tarjeta corporativa o transferencia sin cruzar con el banco: puede ser conciliación pendiente… o el sobrante de un pago duplicado. Revísalos en Conciliación.',
        count: bancariosSinConciliar.length,
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
        vuelos: externosSinHonorarioVuelos,
      },
      {
        clave: 'cobros_en_cancelados',
        titulo: 'Vuelos cancelados con cobros registrados',
        detalle:
          'Cargo por cancelación fuera del reparto — revisar tratamiento.',
        count: cobrosEnCancelados.length,
        monto_usd: round2(cobrosEnCanceladosUsd),
        vuelos: cobrosEnCancelados,
      },
      {
        clave: 'gastos_en_cancelados',
        titulo: 'Gastos ligados a vuelos cancelados',
        detalle:
          'El vuelo se canceló pero sus gastos siguen vivos (p. ej. pistas provisionadas): bórralos o reasígnalos, o quedarán colgando fuera de toda vigilancia.',
        count: gastosEnCanceladosCount,
        vuelos: vuelosConGastoCancelado,
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
        titulo: 'Gastos sin facturar (pendientes o solicitados)',
        detalle:
          'Sin factura en mano — márcalos con el semáforo en Gastos. El ' +
          'seguimiento arrancó en ago 2026: lo anterior nace "Pendiente".',
        count: sinFacturar.length,
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
    // gastos sin TC y combustible sin avión (el gas del mes es por avión).
    // El resto es aviso (cobranza/conciliación son procesos).
    const bloqueantes = [
      'vuelos_sin_completar',
      'tacos_en_revision',
      'gastos_sin_tc',
      'combustible_sin_avion',
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
        'id, aeronave_id, monto_total_usd, tc_usd_mxn, cobrado, comision_vendedor_usd, folio, fecha_vuelo, origen_iata, destino_iata, es_externo, costo_externo_usd',
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
      .select('id, aeronave_id, categoria, monto, moneda, tc_gasto')
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

/** Día Cancún (YYYY-MM-DD) de un timestamptz; null si el vuelo no tiene fecha. */
function diaCancun(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Cancun' });
}
