import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import type { ProfitSharingQuery } from './dto/profit-sharing.dto';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import {
  expandirConReparto,
  fetchRepartos,
} from '../../common/gasto-reparto.util';
import {
  cobradoParteAvion,
  particionIngresoVuelo,
} from '../../common/ingreso-vuelo.util';
import { tuaEmbebidoDeGasto } from '../../common/desglose-gasto.util';

/** Categorias de gasto que cuentan como GASTO DIRECTO del avion (doc 4.8). */
const DIRECTO = new Set([
  'GAS',
  // OPERACIONES es la categoría operativa REAL de pistas/aeródromos (la app
  // y el módulo de pistas la usan; ATERRIZAJE/FBO son legacy). Sin ella, las
  // cuotas de VIP SAESA no restaban en el reparto e inflaban la utilidad.
  'OPERACIONES',
  'ATERRIZAJE',
  // 'TUAS' YA NO está aquí (regla 7 del cliente, 28-ago-2026): el TUA pagado
  // al aeropuerto es un traslado al pasajero, no costo del avión — su egreso
  // vive en "Otros movimientos" del Balance general (apareado con el TUA
  // cobrado, que tampoco es venta del avión). Ver TUAS_CAT abajo.
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
/**
 * TUA pagado (regla 7, 28-ago-2026): grupo EXCLUIDO del reparto — solo nota de
 * operación; el egreso se aparea con el TUA cobrado en Otros movimientos.
 */
const TUAS_CAT = 'TUAS';
const TUAS_CLAVE_DETALLE = 'TUAS (egreso VuelaTour — Otros movimientos)';
/**
 * TUA EMBEBIDO en facturas de aeródromo/handling (leído por IA): esa parte se
 * descuenta del costo del avión con la FUENTE ÚNICA `tuaEmbebidoDeGasto`
 * (toda categoría CON vuelo salvo CATS_SIN_TUA_EMBEBIDO) — la MISMA regla que
 * el Balance por avión y el Libro Dinero. Antes este archivo traía su propia
 * lista blanca de 4 categorías y el reparto divergía del balance.
 */
const TUA_EMBEBIDO_CLAVE_DETALLE = 'TUA embebido (excluido)';
/** Leyenda del bloque informativo `otros_ingresos_vuelatour` (regla 6). */
const OTROS_INGRESOS_LEYENDA =
  'Ingreso de VuelaTour (TUAS, extras y pernocta cobrados con su IVA): vive en Otros movimientos del Balance general; no se reparte.';

interface AeronaveRow {
  id: string;
  matricula: string;
  modelo: string;
}
interface VueloRow {
  id: string;
  aeronave_id: string | null;
  /**
   * COMPLETADO o CANCELADO (regla del cliente 28-ago-2026): un cancelado
   * puede tener dinero real — cobros NO reembolsados (cargo por cancelación /
   * anticipo retenido) y gastos (se voló a recoger, cancelaron, ferry de
   * regreso) — y ambos cuentan en el reparto.
   */
  estado: string;
  monto_total_usd: string | null;
  tc_usd_mxn: string | null;
  cobrado: boolean;
  /** Comisión de quien vendió: se descuenta del ingreso (neto VuelaTour). */
  comision_vendedor_usd: string | null;
  // Insumos de `particionIngresoVuelo` (venta del avión vs ingreso de
  // VuelaTour — regla 6). Sin snapshot el util cae a estas columnas.
  subtotal_vuelo_usd: string | null;
  ajuste_final_usd: string | null;
  iva_usd: string | null;
  iva_pct: string | null;
  tuas_usd: string | null;
  extras_total_usd: string | null;
  viaticos_pernocta_usd: string | null;
  calculo_snapshot: unknown;
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
  vuelo_id: string | null;
  categoria: string;
  monto: string | number;
  moneda: string;
  tc_gasto: string | null;
  /** Propina (ya incluida en `monto`): fuera de la base del desglose IA. */
  propina?: string | number | null;
  /** Renglones leídos por IA de la factura (para separar el TUA embebido). */
  valor_ia_extraido?: {
    conceptos?: Array<{ concepto: string; monto: number }> | null;
  } | null;
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
      // Informativo global (regla 6): ingreso de VuelaTour cobrado en vuelos
      // de la flota — vive en Otros movimientos, no entra a ninguna cascada.
      otros_ingresos_vuelatour_total_usd:
        result.otros_ingresos_vuelatour.cobrado_usd,
      aviones: result.aviones.map((a) => ({
        matricula: a.aeronave.matricula,
        modelo: a.aeronave.modelo,
        // Venta del AVIÓN cobrada (sin TUAS/extras/pernocta ni su IVA).
        ingresos_cobrado_usd: a.ingresos.cobrado_usd,
        otros_ingresos_vuelatour_usd: a.ingresos.otros_ingresos_vuelatour_usd,
        comisiones_venta_usd: a.ingresos.comisiones_venta_usd,
        pendiente_cobro_usd: a.ingresos.pendiente_cobro_usd,
        // Deuda completa del cliente (informativa: el pendiente de arriba es
        // solo la parte del avión).
        pendiente_bruto_usd: a.ingresos.pendiente_bruto_usd,
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
        otros_ingresos_vuelatour: {
          vuelos: 0,
          cobrado_usd: 0,
          pendiente_usd: 0,
          desglose: { tuas_usd: 0, extras_usd: 0, pernocta_usd: 0, iva_usd: 0 },
          leyenda: OTROS_INGRESOS_LEYENDA,
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
      // Externo CANCELADO (28-ago): lo retenido al cliente sí es ingreso; el
      // costo pactado con el operador NO se resta (el servicio no se prestó;
      // si el operador cobró penalización va como gasto del vuelo) ni se
      // reclama como "sin costo".
      if (v.estado === 'CANCELADO') continue;
      if (v.costo_externo_usd == null) {
        extSinCosto += 1;
      } else {
        extCosto += Number(v.costo_externo_usd);
      }
    }
    const extCobradoR = round2(extCobrado);
    const extCostoR = round2(extCosto);

    // INGRESO DE VUELATOUR del periodo (regla 6, 28-ago-2026): TUAS + extras
    // + pernocta cobrados (+ su IVA) en vuelos de la FLOTA. Sale de los
    // mismos acumuladores por avión (misma partición, mismos cobros), así
    // Σ cobrado_bruto == Σ venta avión cobrada + este bloque, al centavo.
    // Bloque INFORMATIVO: no se reparte ni entra a ninguna cascada; su lugar
    // contable es la pestaña Otros movimientos del Balance general. Los
    // vuelos EXTERNOS (bloque `externos`) quedan fuera a propósito: su
    // dinero no se parte (no hay avión de flota que repartir).
    const otrosIngresosVuelatour = aviones.reduce(
      (acc, a) => {
        const oi = a.detalle.otros_ingresos_vuelatour;
        acc.vuelos += oi.vuelos;
        acc.cobrado_usd += a.ingresos.otros_ingresos_vuelatour_usd;
        acc.pendiente_usd += a.ingresos.otros_ingresos_vuelatour_pendiente_usd;
        acc.desglose.tuas_usd += oi.desglose.tuas_usd;
        acc.desglose.extras_usd += oi.desglose.extras_usd;
        acc.desglose.pernocta_usd += oi.desglose.pernocta_usd;
        acc.desglose.iva_usd += oi.desglose.iva_usd;
        return acc;
      },
      {
        vuelos: 0,
        cobrado_usd: 0,
        pendiente_usd: 0,
        desglose: { tuas_usd: 0, extras_usd: 0, pernocta_usd: 0, iva_usd: 0 },
      },
    );

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
      otros_ingresos_vuelatour: {
        vuelos: otrosIngresosVuelatour.vuelos,
        cobrado_usd: round2(otrosIngresosVuelatour.cobrado_usd),
        pendiente_usd: round2(otrosIngresosVuelatour.pendiente_usd),
        // Desglose PRE-IVA cotizado (no cobrado) de los vuelos con precio del
        // periodo + su IVA: para entender de qué se compone el bloque.
        desglose: {
          tuas_usd: round2(otrosIngresosVuelatour.desglose.tuas_usd),
          extras_usd: round2(otrosIngresosVuelatour.desglose.extras_usd),
          pernocta_usd: round2(otrosIngresosVuelatour.desglose.pernocta_usd),
          iva_usd: round2(otrosIngresosVuelatour.desglose.iva_usd),
        },
        leyenda: OTROS_INGRESOS_LEYENDA,
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
    //
    // REGLA 6 (cliente, 28-ago-2026): del total que paga el cliente solo la
    // VENTA DEL AVIÓN (tiempo + ajuste + comisión del vendedor + su IVA) es
    // del avión y se reparte. TUAS/extras/pernocta cobrados (+ su IVA) son
    // ingreso de VuelaTour (Otros movimientos del Balance general) y quedan
    // FUERA de la cascada. La partición es la fuente única
    // `particionIngresoVuelo`; lo cobrado se PRORRATEA con `factor_avion`
    // (= avion_usd exacto con el vuelo pagado completo; parcial en
    // proporción). El factor NO se topa: un SOBRECOBRO se reparte en la
    // misma proporción avión/VuelaTour, así el bruto cobrado siempre es
    // parte avión + parte VuelaTour al centavo y nada desaparece.
    let cobrado = 0; // venta del avión cobrada (lo que SÍ se reparte)
    let cobradoBruto = 0; // todo lo cobrado al cliente (avión + VuelaTour)
    let pendiente = 0; // parte del avión aún no cobrada
    // Deuda COMPLETA del cliente (avión + VuelaTour): misma fórmula que el
    // pre-cierre `cobros_pendientes` — Σ max(0, total − cobrado) por vuelo.
    let pendienteBruto = 0;
    let otrosIngresosVT = 0; // parte de VuelaTour cobrada (informativa)
    let otrosIngresosVTPendiente = 0;
    let vuelosConOtrosIngresos = 0;
    // Desglose PRE-IVA cotizado (+ IVA) de la parte VuelaTour de TODOS los
    // vuelos con precio del periodo — informativo, no es lo cobrado.
    const desgloseVT = {
      tuas_usd: 0,
      extras_usd: 0,
      pernocta_usd: 0,
      iva_usd: 0,
    };
    let vuelosCobrados = 0;
    let vuelosPendientes = 0;
    let cobrosSinTcMxn = 0;
    // Comisiones de venta (Itzy/Pablo/broker): el cliente paga el total —
    // que desde jul 2026 YA incluye la comisión sumada al precio — pero esa
    // parte no es de VuelaTour: se descuenta del ingreso a repartir y el
    // neto queda ≈ precio base. Se hace efectiva contra lo cobrado (tope:
    // lo cobrado de la VENTA DEL AVIÓN, que es donde viaja la comisión —
    // este Math.min SÍ se queda: no se descuenta comisión de dinero que aún
    // no entra).
    let comisionesVenta = 0;
    // Desglose por vuelo: se llena en el MISMO loop y con los MISMOS números
    // que los agregados (misma conversión cobrosEnUsd, misma partición,
    // mismo tope de comisión) para que la suma del detalle cuadre exacto con
    // ingresos.*. total_usd/cobrado_usd/pendiente_usd conservan su sentido
    // de siempre (total del CLIENTE y lo cobrado BRUTO — el panel los suma);
    // los campos *_avion_* y otros_ingresos_vuelatour_* son ADITIVOS.
    // otros_ingresos_vuelatour_usd es lo COBRADO de la parte VuelaTour
    // (Σ detalle == ingresos.otros_ingresos_vuelatour_usd: el pie del detalle
    // del panel cuadra con la card); lo COTIZADO y lo PENDIENTE van en sus
    // propios campos — antes viajaba lo cotizado bajo el nombre del cobrado
    // y el pie no cuadraba con la card.
    const detalleVuelos: Array<{
      id: string;
      folio: number | null;
      fecha: string | null;
      ruta: string;
      es_externo: boolean;
      total_usd: number;
      cobrado_usd: number;
      pendiente_usd: number;
      venta_avion_usd: number;
      cobrado_avion_usd: number;
      pendiente_avion_usd: number;
      otros_ingresos_vuelatour_usd: number;
      otros_ingresos_vuelatour_cotizado_usd: number;
      otros_ingresos_vuelatour_pendiente_usd: number;
      cobrado_bruto_usd: number;
      particion_fuente: 'desglose' | 'columnas' | 'sin_precio';
      particion_inconsistente: boolean;
      comision_vendedor_usd: number;
      cobrado: boolean;
      cobros_sin_tc_mxn: number;
      /**
       * ADITIVO (28-ago-2026): vuelo CANCELADO con dinero real. Su cobro
       * retenido entra al 100 % como venta del avión (venta_avion_usd ==
       * cobrado_avion_usd), sin partición VuelaTour ni pendiente.
       */
      cancelado: boolean;
    }> = [];
    for (const v of ctx.vuelos) {
      if (v.aeronave_id !== a.id) continue;
      const p = particionIngresoVuelo(v);
      const conv = cobrosEnUsd(
        ctx.cobrosPorVuelo.get(v.id) ?? [],
        v.tc_usd_mxn == null ? null : Number(v.tc_usd_mxn),
      );
      // VUELO CANCELADO (regla del cliente, 28-ago-2026): lo cobrado y NO
      // reembolsado (cargo por cancelación / anticipo retenido) es ingreso
      // real del avión — entra al 100 % como venta del avión, SIN partición
      // (no se vendieron TUAS/extras/pernocta: el servicio no se prestó),
      // SIN pendiente (la cotización ya no es una cuenta por cobrar) y SIN
      // comisión del vendedor (no hubo venta que comisionar). Sus gastos
      // entran como los de cualquier vuelo (por categoría, abajo).
      const esCancelado = v.estado === 'CANCELADO';
      // Cancelado sin cobros (ni USD ni MXN sin TC): no aporta ingreso ni
      // cuenta como vuelo del reparto — sus gastos, si los hay, ya entran por
      // categoría abajo (ctx.gastos por aeronave_id). Así detalle.vuelos ==
      // vuelos_cobrados + vuelos_pendientes por construcción.
      if (esCancelado && conv.total_usd <= 0 && conv.sin_tc_mxn <= 0) continue;
      const cobradoAvion = esCancelado
        ? conv.total_usd
        : cobradoParteAvion(conv.total_usd, p);
      const cobradoVT = esCancelado ? 0 : round2(conv.total_usd - cobradoAvion);
      const pendienteAvion = esCancelado
        ? 0
        : Math.max(0, round2(p.avion_usd - cobradoAvion));
      const pendienteBrutoVuelo = esCancelado
        ? 0
        : Math.max(0, round2(p.total_usd - conv.total_usd));
      const pendienteVT = esCancelado
        ? 0
        : Math.max(0, round2(p.vuelatour_usd - cobradoVT));
      const comisionEfectiva = esCancelado
        ? 0
        : Math.min(Number(v.comision_vendedor_usd ?? 0), cobradoAvion);
      cobrado += cobradoAvion;
      cobradoBruto += conv.total_usd;
      otrosIngresosVT += cobradoVT;
      otrosIngresosVTPendiente += pendienteVT;
      // Un cancelado no aporta al bloque informativo de ingreso VuelaTour
      // (ni conteo ni desglose cotizado): nada de eso se vendió.
      if (!esCancelado && p.vuelatour_usd > 0) {
        vuelosConOtrosIngresos += 1;
        desgloseVT.tuas_usd += p.tuas_usd;
        desgloseVT.extras_usd += p.extras_usd;
        desgloseVT.pernocta_usd += p.pernocta_usd;
        desgloseVT.iva_usd += p.iva_vuelatour_usd;
      }
      cobrosSinTcMxn += conv.sin_tc_mxn;
      pendiente += pendienteAvion;
      pendienteBruto += pendienteBrutoVuelo;
      comisionesVenta += comisionEfectiva;
      // Conteos: un cancelado nunca es "pendiente" (no hay saldo por cobrar);
      // cuenta como cobrado solo si de verdad retuvo dinero.
      if (esCancelado) {
        vuelosCobrados += 1; // ya se filtró arriba: siempre retuvo dinero
      } else if (v.cobrado) vuelosCobrados += 1;
      else vuelosPendientes += 1;
      detalleVuelos.push({
        id: v.id,
        folio: v.folio ?? null,
        fecha: diaCancun(v.fecha_vuelo),
        ruta: `${v.origen_iata ?? '—'} → ${v.destino_iata ?? '—'}`,
        es_externo: v.es_externo === true,
        // Cancelado: el total del cliente es lo retenido (la cotización ya
        // no es deuda) — así el pie del panel (Σ venta) cuadra con la card.
        total_usd: esCancelado ? conv.total_usd : p.total_usd,
        cobrado_usd: conv.total_usd,
        pendiente_usd: pendienteBrutoVuelo,
        venta_avion_usd: esCancelado ? cobradoAvion : p.avion_usd,
        cobrado_avion_usd: cobradoAvion,
        pendiente_avion_usd: pendienteAvion,
        otros_ingresos_vuelatour_usd: cobradoVT,
        otros_ingresos_vuelatour_cotizado_usd: esCancelado
          ? 0
          : p.vuelatour_usd,
        otros_ingresos_vuelatour_pendiente_usd: pendienteVT,
        cobrado_bruto_usd: conv.total_usd,
        particion_fuente: p.fuente,
        particion_inconsistente: esCancelado ? false : p.inconsistente,
        comision_vendedor_usd: round2(comisionEfectiva),
        // Cancelado con dinero retenido = cobrado (no hay saldo pendiente);
        // los cancelados sin cobros ya no llegan aquí.
        cobrado: esCancelado || v.cobrado,
        cobros_sin_tc_mxn: conv.sin_tc_mxn,
        cancelado: esCancelado,
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
    // TUA EMBEBIDO en facturas de aeródromo (regla 7): se descuenta del costo
    // del avión ANTES de convertir y se acumula para una fila informativa
    // del detalle (transparencia: el total de la categoría ya no es la suma
    // cruda de sus gastos).
    let tuaEmbebidoUsd = 0;
    let tuaEmbebidoCount = 0;
    for (const g of ctx.gastos) {
      if (g.aeronave_id !== a.id) continue;
      // Parciales del reparto MANUAL (gasto_reparto): la categoría
      // INDIRECTO repartida SÍ cuenta (grupo INDIRECTO — esta feature ES la
      // decisión que estaba pendiente; SIN reparto sigue EXCLUIDA = empresa,
      // idéntico a antes). Un FIJO repartido va al grupo FIJO manual (suma
      // en otros_prorrateados junto al pool — mismo campo de la cascada).
      const esTuas = g.categoria === TUAS_CAT;
      const grupo: GrupoGasto =
        // TUA pagado (regla 7): jamás costo del avión, con o sin reparto.
        esTuas
          ? 'EXCLUIDO'
          : // GASOLINA repartida a mano cuenta como "otros gastos" del avión
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
      const clave = esTuas
        ? TUAS_CLAVE_DETALLE
        : g.es_reparto_parcial
          ? `${g.categoria} (repartido)`
          : g.categoria;
      const acc = porCategoria.get(clave) ?? {
        grupo,
        count: 0,
        usd: 0,
        sin_tc_count: 0,
        sin_tc_mxn: 0,
      };
      // Monto EFECTIVO del avión = monto − TUA embebido (en la moneda del
      // gasto), convertido con la MISMA regla/TC de siempre. Sin TC el gasto
      // entero sigue en sin_tc_* (nada se convierte a medias).
      const tuaEmbebido = tuaEmbebidoDeGasto(g);
      const usd = this.toUsd(
        tuaEmbebido > 0
          ? { ...g, monto: round2(Number(g.monto) - tuaEmbebido) }
          : g,
      );
      if (usd === null) {
        acc.sin_tc_count += 1;
        acc.sin_tc_mxn += Number(g.monto);
      } else {
        acc.count += 1;
        acc.usd += usd;
        if (tuaEmbebido > 0) {
          tuaEmbebidoCount += 1;
          tuaEmbebidoUsd += this.toUsd({ ...g, monto: tuaEmbebido }) ?? 0;
        }
      }
      porCategoria.set(clave, acc);
    }
    if (tuaEmbebidoCount > 0) {
      // Fila informativa (grupo EXCLUIDO: no suma a ningún agregado): cuánto
      // TUA embebido se le quitó al costo del avión en este periodo.
      porCategoria.set(TUA_EMBEBIDO_CLAVE_DETALLE, {
        grupo: 'EXCLUIDO',
        count: tuaEmbebidoCount,
        usd: tuaEmbebidoUsd,
        sin_tc_count: 0,
        sin_tc_mxn: 0,
      });
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
        // VENTA DEL AVIÓN cobrada (regla 6): mismo nombre de siempre — el
        // PDF/XLSX/panel no cambian y la cascada saldo = cobrado − comisiones
        // − gastos − reserva conserva su fórmula; solo cambia lo que entra.
        cobrado_usd: cobradoR,
        // ADITIVOS: bruto cobrado al cliente y la parte de VuelaTour
        // (cobrado_bruto == cobrado + otros_ingresos_vuelatour al centavo).
        cobrado_bruto_usd: round2(cobradoBruto),
        otros_ingresos_vuelatour_usd: round2(otrosIngresosVT),
        otros_ingresos_vuelatour_pendiente_usd: round2(
          otrosIngresosVTPendiente,
        ),
        comisiones_venta_usd: comisionesR,
        // Parte del AVIÓN aún no cobrada (coherente con la cascada: es lo que
        // le falta al avión para repartir). El nombre se conserva (PDF/XLSX/
        // panel); la deuda COMPLETA del cliente va ADITIVA abajo.
        pendiente_cobro_usd: round2(pendiente),
        // Deuda completa del cliente (avión + TUAS/extras/pernocta + IVA) =
        // Σ detalle.vuelos[].pendiente_usd; misma fórmula que el pre-cierre.
        pendiente_bruto_usd: round2(pendienteBruto),
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
        // Composición de la parte VuelaTour de este avión (alimenta el
        // bloque global `otros_ingresos_vuelatour` de compute()).
        otros_ingresos_vuelatour: {
          vuelos: vuelosConOtrosIngresos,
          desglose: {
            tuas_usd: round2(desgloseVT.tuas_usd),
            extras_usd: round2(desgloseVT.extras_usd),
            pernocta_usd: round2(desgloseVT.pernocta_usd),
            iva_usd: round2(desgloseVT.iva_usd),
          },
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
      // Completados del periodo (para cobros pendientes/parciales y para la
      // partición venta avión / VuelaTour — aviso extras_sin_desglose).
      sb
        .from('vuelo')
        .select(
          'id, folio, piloto_id, cliente_id, monto_total_usd, tc_usd_mxn, cobrado, subtotal_vuelo_usd, ajuste_final_usd, comision_vendedor_usd, iva_usd, iva_pct, tuas_usd, extras_total_usd, viaticos_pernocta_usd, calculo_snapshot',
        )
        .eq('estado', 'COMPLETADO')
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs),
      // Cancelados del periodo: pueden tener dinero real (cobros retenidos y
      // gastos) que YA cuenta en el reparto (regla 28-ago) — aquí solo se
      // enumeran para que la oficina confirme que ese dinero es de verdad.
      sb
        .from('vuelo')
        .select('id, folio, tc_usd_mxn')
        .eq('estado', 'CANCELADO')
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs),
      // Gastos del periodo con huecos de datos. El embed del vuelo solo
      // sirve para reconocer el GAS de un externo sin avión (abajo).
      sb
        .from('gasto')
        .select(
          'id, vuelo_id, aeronave_id, categoria, monto, moneda, tc_gasto, estatus_facturacion, medio_pago, conciliado, duplicado_sospechado, matricula_ia:valor_ia_extraido->>matricula, vuelo:vuelo_id(es_externo, aeronave_id)',
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
          pilotosPorVuelo.get(l.vuelo_id as string)?.add(l.piloto_id as string);
        }
      }
      const pilotoIds = [
        ...new Set([...pilotosPorVuelo.values()].flatMap((set) => [...set])),
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

    // Dinero real en vuelos CANCELADOS del periodo (regla del cliente,
    // 28-ago-2026): los cobros registrados (cargo por cancelación / anticipo
    // retenido) entran al reparto al 100 % como venta del avión y los gastos
    // ligados (se voló a recoger, ferry de regreso, pistas) restan como los de
    // cualquier vuelo. Estos dos renglones son INFORMATIVOS (no bloquean):
    // la oficina confirma que un cobro no fue reembolsado y que un gasto
    // corresponde a una operación que sí ocurrió (una pista provisionada de
    // un vuelo que jamás despegó se borra). NO se listan en cobros_pendientes:
    // un cancelado no tiene saldo por cobrar.
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

    // Extras SIN desglose exacto (regla 6): la venta del avión se separa de
    // TUAS/extras/pernocta con el desglose canónico del snapshot; si el
    // vuelo con precio no lo tiene (fuente 'columnas') y trae extras, o el
    // desglose no cuadra con el total (inconsistente → todo al avión), la
    // partición es aproximada. Aviso NO bloqueante: el dinero no se pierde
    // (cierre por diferencia), solo puede quedar mal repartido entre avión
    // y VuelaTour hasta revisar la cotización.
    const extrasSinDesglose = completados
      .filter((v) => {
        if (!(Number(v.monto_total_usd ?? 0) > 0)) return false;
        const p = particionIngresoVuelo(v);
        return (
          p.inconsistente ||
          (p.fuente === 'columnas' &&
            round2(p.tuas_usd + p.extras_usd + p.pernocta_usd) > 0)
        );
      })
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
    // Excepción (verificación 28-ago): el GAS de un vuelo EXTERNO sin avión
    // de referencia vive en la hoja "combustible" del libro EXTERNOS del
    // Balance general — no es dinero invisible y no debe bloquear el cierre
    // (mismo filtro que aircraft-balance.pendienteGasSinAvion).
    const esGasDeExternoSinAvion = (g: Record<string, unknown>): boolean => {
      const raw: unknown = g.vuelo;
      const v: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
      if (!v || typeof v !== 'object') return false;
      const row = v as { es_externo?: unknown; aeronave_id?: unknown };
      return row.es_externo === true && row.aeronave_id == null;
    };
    const gasSinAvion = sinAvion.filter(
      (g) => g.categoria === 'GAS' && !esGasDeExternoSinAvion(g),
    );
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
          'Solo se reparte lo cobrado: la parte del avión de este saldo queda fuera del reparto (el resto —TUAS/extras/pernocta— es ingreso de VuelaTour, tampoco cobrado).',
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
        clave: 'extras_sin_desglose',
        titulo: 'Vuelos con TUAS/extras sin desglose exacto',
        detalle:
          'No se puede separar con exactitud la venta del avión de los extras (TUAS/extras/pernocta son ingreso de VuelaTour, no del avión): revisa la cotización en el detalle del vuelo para regenerar el desglose. Mientras tanto se usan las columnas del vuelo, o todo el total va al avión si el desglose no cuadra.',
        count: extrasSinDesglose.length,
        vuelos: extrasSinDesglose,
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
      // Informativos (no bloquean): el dinero de vuelos cancelados YA cuenta
      // en el reparto; solo se pide confirmar que sea real.
      {
        clave: 'cobros_en_cancelados',
        titulo:
          'Vuelos cancelados con cobros retenidos (ya cuentan en el reparto)',
        detalle:
          'Cargo por cancelación o anticipo no reembolsado: entra al 100 % como venta del avión, sin saldo pendiente. Confirma que no se haya devuelto al cliente; si se reembolsó, corrige o elimina el cobro en el detalle del vuelo.',
        count: cobrosEnCancelados.length,
        monto_usd: round2(cobrosEnCanceladosUsd),
        vuelos: cobrosEnCancelados,
      },
      {
        clave: 'gastos_en_cancelados',
        titulo: 'Gastos ligados a vuelos cancelados (ya restan en el reparto)',
        detalle:
          'Se voló a recoger, ferry de regreso, pistas… son costo real del avión y ya se descuentan. Confirma que correspondan a algo que sí ocurrió: una pista provisionada de un vuelo que nunca despegó se borra en Gastos.',
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
   * Vuelos COMPLETADOS (los que realmente volaron) y CANCELADOS (regla del
   * cliente 28-ago-2026: sus cobros retenidos y sus gastos son dinero real y
   * entran al reparto — ver `computeAvion`). Las cotizaciones/reservas que
   * nunca se cerraron siguen fuera: no inflan el "pendiente de cobro" de los
   * socios. Cortes en hora Cancún (UTC−5): un vuelo nocturno del día 31
   * pertenece a SU mes.
   */
  private async fetchVuelos(desde: string, hasta: string): Promise<VueloRow[]> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, aeronave_id, estado, monto_total_usd, tc_usd_mxn, cobrado, comision_vendedor_usd, folio, fecha_vuelo, origen_iata, destino_iata, es_externo, costo_externo_usd, subtotal_vuelo_usd, ajuste_final_usd, iva_usd, iva_pct, tuas_usd, extras_total_usd, viaticos_pernocta_usd, calculo_snapshot',
      )
      .in('estado', ['COMPLETADO', 'CANCELADO'])
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
      .in('vuelo_id', vueloIds)
      // Tramos cancelados fuera (28-ago, cinturón): cancelEscala anula sus
      // lecturas, pero si un residuo conservara tacos sumaría horas de una
      // operación que no ocurrió. Los tramos vivos de un vuelo CANCELADO sí
      // entran: solo suman si tienen salida Y llegada, y la llegada siempre
      // es evidencia real (el sistema jamás la estima) — si el avión voló a
      // recoger y regresó ferry, esas horas movieron el horómetro y cuentan
      // en la reserva de overhaul.
      .is('cancelada_at', null);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchGastos(desde: string, hasta: string): Promise<GastoRow[]> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      // propina + valor_ia_extraido: para separar el TUA embebido en
      // facturas de aeródromo (regla 7) con la misma regla del balance.
      .select(
        'id, aeronave_id, vuelo_id, categoria, monto, moneda, tc_gasto, propina, valor_ia_extraido',
      )
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
