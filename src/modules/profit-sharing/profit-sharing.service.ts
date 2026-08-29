import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import {
  fuenteTcLegible,
  TipoCambioService,
  type TipoCambioDetalle,
} from '../tipo-cambio/tipo-cambio.service';
import type { ProfitSharingQuery } from './dto/profit-sharing.dto';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import {
  expandirConReparto,
  fetchRepartos,
} from '../../common/gasto-reparto.util';
import {
  cobradoParteAvion,
  pagoVendedorUsd,
  particionIngresoVuelo,
} from '../../common/ingreso-vuelo.util';
import { tuaEmbebidoDeGasto } from '../../common/desglose-gasto.util';
import {
  avionDelGasto,
  avionQueReporta,
  factorDe,
  participacionPorAeronave,
  repartirUsd,
  type ParticipacionAeronave,
} from '../../common/participacion-aeronave.util';

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
// NOMINA (29-ago) es espejo EXACTO de la categoría INDIRECTO: tampoco está
// en ningún set (sin repartir = EXCLUIDA, gasto de la empresa); repartida a
// mano SÍ cuenta al avión (grupo INDIRECTO, ver compute).
// SERVICIOS (29-ago) es espejo de REFACCION: gasto directo del avión.
const INDIRECTO = new Set(['REFACCION', 'SERVICIOS']);
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
/**
 * Leyenda del bloque informativo `tc_oficial` (regla del cliente, 29-ago-2026):
 * una cotización sin TC (no se sabía cuándo volaría) y un gasto MXN sin TC
 * capturado se convierten con el TC oficial de referencia del día — la MISMA
 * cadena que el Balance por avión/general (tc capturado ?? oficial del día).
 */
const TC_OFICIAL_LEYENDA =
  'Cobros y gastos en MXN sin tipo de cambio capturado se convierten con el TC oficial de referencia (open.er-api / BCE) del día de la cotización o del gasto; capturar el TC en el vuelo o en el gasto lo sustituye.';
/** Leyenda del bloque informativo `otros_ingresos_vuelatour` (regla 6). */
const OTROS_INGRESOS_LEYENDA =
  'Ingreso de VuelaTour (TUAS, extras, pernocta y comisión del vendedor cobrados con su IVA): vive en Otros movimientos del Balance general; no se reparte.';

/** Etiqueta legible de la fuente del peso del reparto multi-avión. */
function fuenteParticipacionLabel(
  fuente: ParticipacionAeronave['fuente'],
): string {
  switch (fuente) {
    case 'tacos':
      return 'por horas reales de tacómetro';
    case 'cotizacion':
      return 'por horas cotizadas por tramo';
    case 'tramos':
      return 'partes iguales por tramo';
    default:
      return '';
  }
}

/** "50 %", "33.33 %". */
function pctLabel(f: number): string {
  return `${Math.round(f * 10000) / 100} %`;
}

// El avión que REPORTA la parte de VuelaTour, los avisos no repartibles
// (cobros MXN sin TC), el bloque informativo `otros_ingresos_vuelatour` y los
// CONTEOS de vuelos de un vuelo multi-avión es `avionQueReporta` (fuente
// única, misma regla que el balance por avión y el Libro Dinero).

interface AeronaveRow {
  id: string;
  matricula: string;
  modelo: string;
}
interface VueloRow {
  id: string;
  aeronave_id: string | null;
  /** Cliente del vuelo (nombre resuelto aparte: detalle.vuelos / PDF). */
  cliente_id: string | null;
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
  /**
   * Comisión de quien vendió (pre-IVA). Regla A (28-ago-2026 tarde): es
   * INGRESO DE VUELATOUR (como un extra) — ya viene dentro de
   * `vuelatour_usd` de la partición; el avión ni la cobra ni la descuenta.
   * Aquí solo es insumo de `particionIngresoVuelo` (rama columnas).
   */
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
  /**
   * Día de la COTIZACIÓN: sin tc_usd_mxn, los cobros MXN sin TC se convierten
   * con el TC oficial de ese día (fecha_solicitud ?? fecha_vuelo, hora
   * Cancún) — misma cadena que el balance (`tcOficialPorVuelos`).
   */
  fecha_solicitud: string | null;
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
  /** De `count`: los MXN convertidos con el TC oficial del día del gasto. */
  tc_oficial_count: number;
  tc_oficial_mxn: number;
}
interface CobroRow {
  vuelo_id: string;
  monto: string;
  moneda: string;
  tc_usd_mxn: string | null;
}
interface EscalaHorasRow {
  id: string;
  vuelo_id: string;
  orden: number | null;
  aeronave_id: string | null;
  /** Tramo cancelado: no suma horas ni participa en el reparto por avión. */
  cancelada_at: string | null;
  taco_salida: string | null;
  taco_llegada: string | null;
  /**
   * Tramo OPERATIVO (ferry / posicionamiento / parada técnica): no vendió,
   * no reparte la venta (`participacionPorAeronave`); sí suma horas reales.
   */
  solo_operativa: boolean | null;
  es_ferry: boolean | null;
  /** Ruta del tramo ("CUN→MID"): etiqueta de los tramos del avión en el PDF. */
  origen_iata: string | null;
  destino_iata: string | null;
}
interface GastoRow {
  id: string;
  aeronave_id: string | null;
  vuelo_id: string | null;
  /** Tramo al que está ligado el gasto (Regla B: su avión manda). */
  escala_id?: string | null;
  categoria: string;
  monto: string | number;
  moneda: string;
  tc_gasto: string | null;
  /** Día del gasto (date): TC oficial de respaldo cuando es MXN sin tc_gasto. */
  fecha_gasto?: string | null;
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
    private readonly tipoCambio: TipoCambioService,
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
      // Composición COTIZADA (pre-IVA + IVA) del bloque anterior; incluye la
      // comisión del vendedor (Regla A). Nombres = RepartoOtrosIngresosDesglose
      // de pyservices (app/schemas/reparto.py).
      otros_ingresos_vuelatour_desglose:
        result.otros_ingresos_vuelatour.desglose,
      // ADITIVO (29-ago-2026): cuántos vuelos/gastos del periodo se
      // convirtieron con el TC oficial de referencia (nota en PDF/XLSX).
      tc_oficial: result.tc_oficial,
      aviones: result.aviones.map((a) => ({
        matricula: a.aeronave.matricula,
        modelo: a.aeronave.modelo,
        // Venta del AVIÓN cobrada (sin TUAS/extras/pernocta/comisión del
        // vendedor ni su IVA; en multi-avión, la parte de este avión).
        ingresos_cobrado_usd: a.ingresos.cobrado_usd,
        otros_ingresos_vuelatour_usd: a.ingresos.otros_ingresos_vuelatour_usd,
        otros_ingresos_vuelatour_desglose:
          a.detalle.otros_ingresos_vuelatour.desglose,
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
        // ADITIVOS (29-ago): convertidos con el TC oficial del día — ya
        // DENTRO de los montos de arriba; solo alimentan una nota.
        gastos_tc_oficial: a.gastos.gastos_tc_oficial,
        cobros_tc_oficial_count: a.ingresos.cobros_tc_oficial_count,
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
        // Detalle de vuelos del avión (RepartoVueloLinea de pyservices): la
        // PARTE del avión cobrada / pendiente (misma cifra que la card y que
        // Σ ingresos.*); en multi-avión `participacion` < 1 y el PDF imprime
        // "#105 · 50 % (CUN-MID)". Sale del mismo loop que los agregados.
        vuelos: a.detalle.vuelos.map((v) => ({
          folio: v.folio,
          cliente: v.cliente,
          fecha: v.fecha,
          estado: v.estado,
          cobrado_usd: v.cobrado_avion_usd,
          pendiente_usd: v.pendiente_avion_usd,
          participacion: v.participacion ?? 1,
          multi_avion: v.multi_avion ?? false,
          tramos_avion: v.tramos_ruta_avion ?? v.tramos_avion ?? null,
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
        gastos_tc_oficial: { count: 0, monto_mxn: 0 },
        tc_oficial: {
          vuelos: 0,
          gastos: { count: 0, monto_mxn: 0 },
          fuentes: [] as string[],
          leyenda: TC_OFICIAL_LEYENDA,
        },
        externos: {
          vuelos: 0,
          cobrado_usd: 0,
          costo_usd: 0,
          comisiones_vendedor_usd: 0,
          utilidad_usd: 0,
          sin_costo_count: 0,
          cobros_sin_tc_mxn: 0,
          cobros_tc_oficial_count: 0,
        },
        otros_ingresos_vuelatour: {
          vuelos: 0,
          cobrado_usd: 0,
          pendiente_usd: 0,
          desglose: {
            tuas_usd: 0,
            extras_usd: 0,
            pernocta_usd: 0,
            comision_usd: 0,
            iva_usd: 0,
          },
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

    // TC OFICIAL DE RESPALDO (regla del cliente, 29-ago-2026) — UNA sola
    // resolución por día para todo el cómputo: (a) vuelos sin tc_usd_mxn con
    // cobros MXN sin TC → TC oficial del día de la COTIZACIÓN; (b) gastos
    // MXN sin tc_gasto → TC oficial del día del GASTO. Misma cadena que el
    // Balance por avión (tc capturado ?? oficial del día). Sin dato (sin
    // red) el monto sigue en sin_tc_* como siempre — jamás se inventa.
    const tcOficial = await this.resolverTcOficial(
      vuelos.filter((v) =>
        cobrosNecesitanTc(cobrosPorVuelo.get(v.id) ?? [], v.tc_usd_mxn),
      ),
      gastos,
    );

    // Horas voladas del periodo por avión (por tramo: el avión de la escala
    // puede diferir del principal del vuelo). Base de la reserva de overhaul.
    // Las horas REALES de cada avión son SIEMPRE por escala (Regla B): no se
    // reparten con el factor del vuelo.
    const vueloAvion = new Map<string, string | null>(
      vuelos.map((v) => [v.id, v.aeronave_id]),
    );
    const horasPorAvion = new Map<string, number>();
    const escalasPorVuelo = new Map<string, EscalaHorasRow[]>();
    // Mapa escala → avión (crudo; la herencia la aplica `avionDelGasto`).
    // Incluye tramos cancelados: un gasto ligado a un tramo cancelado sigue
    // siendo del avión de ese tramo.
    const escalaPorId = new Map<string, { aeronave_id: string | null }>();
    for (const e of escalas) {
      escalaPorId.set(e.id, { aeronave_id: e.aeronave_id });
      const list = escalasPorVuelo.get(e.vuelo_id) ?? [];
      list.push(e);
      escalasPorVuelo.set(e.vuelo_id, list);
      // Tramos cancelados fuera de las horas (cinturón, 28-ago): cancelEscala
      // anula sus lecturas, pero un residuo con tacos sumaría horas de una
      // operación que no ocurrió. Los tramos vivos de un vuelo CANCELADO sí
      // entran (avión que voló a recoger y regresó ferry: movió el horómetro).
      if (e.cancelada_at != null) continue;
      if (e.taco_salida == null || e.taco_llegada == null) continue;
      const h = Number(e.taco_llegada) - Number(e.taco_salida);
      if (!Number.isFinite(h) || h <= 0) continue;
      const avionId = e.aeronave_id ?? vueloAvion.get(e.vuelo_id) ?? null;
      if (!avionId) continue;
      horasPorAvion.set(avionId, (horasPorAvion.get(avionId) ?? 0) + h);
    }

    // REGLA B (cliente, 28-ago-2026): participación de cada avión en la VENTA
    // DEL AVIÓN de cada vuelo — fuente única `participacionPorAeronave`
    // (tramos activos, avión con herencia, pesos por horas cotizadas / por
    // tramo). Vuelos EXTERNOS no se reparten (sin avión de flota): conservan
    // su tratamiento (factor 1 al avión de referencia si lo hubiera, como
    // siempre, y el bloque `externos`).
    const participacionPorVuelo = new Map<string, ParticipacionAeronave>();
    for (const v of vuelos) {
      participacionPorVuelo.set(
        v.id,
        participacionPorAeronave(
          v,
          v.es_externo === true ? [] : (escalasPorVuelo.get(v.id) ?? []),
        ),
      );
    }

    // Escalas referidas por gastos del periodo pero de vuelos FUERA del
    // periodo (gasto de agosto de un vuelo de julio): se traen con su avión
    // ya heredado para que `avionDelGasto` resuelva igual que en el balance.
    const escalasFaltantes = [
      ...new Set(
        gastos
          .map((g) => g.escala_id)
          .filter((id): id is string => !!id && !escalaPorId.has(id)),
      ),
    ];
    for (const [id, aeronaveId] of await this.fetchAvionDeEscalas(
      escalasFaltantes,
    )) {
      escalaPorId.set(id, { aeronave_id: aeronaveId });
    }
    // Matrículas de TODA la flota (activa o no) para etiquetar el reparto
    // multi-avión ("tramos también en N4142R") aunque se filtre por avión.
    const matriculas = await this.fetchMatriculas();

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
    let fijosTcOficialCount = 0;
    let fijosTcOficialMxn = 0;
    for (const g of gastosAtribuidos) {
      if (g.categoria !== FIJO || g.es_reparto_parcial) continue;
      const conv = this.toUsd(g, tcOficial.gasto);
      if (conv === null) {
        sinTcCount += 1;
        sinTcMxn += Number(g.monto);
      } else {
        fijoPoolUsd += conv.usd;
        if (conv.oficial) {
          fijosTcOficialCount += 1;
          fijosTcOficialMxn += Number(g.monto);
        }
      }
    }
    const otrosPorAvion = activos > 0 ? fijoPoolUsd / activos : 0;

    const socioIds = [...new Set(socios.map((s) => s.socio_id))];
    const [nombres, clientes] = await Promise.all([
      this.fetchNombres(socioIds),
      this.fetchClientes([
        ...new Set(
          vuelos.map((v) => v.cliente_id).filter((id): id is string => !!id),
        ),
      ]),
    ]);

    const aviones = aeronaves.map((a) =>
      this.computeAvion(a, {
        vuelos,
        cobrosPorVuelo,
        horasPorAvion,
        participacionPorVuelo,
        escalaPorId,
        escalasPorVuelo,
        vueloAvion,
        matriculas,
        clientes,
        gastos: gastosAtribuidos,
        socios,
        reservas,
        nombres,
        otrosPorAvion,
        periodo: q,
        tcOficialVuelo: tcOficial.vuelo,
        tcOficialGasto: tcOficial.gasto,
      }),
    );

    // Vuelos EXTERNOS del periodo (aeronave_id null: no entran a ninguna
    // card por avión). Su dinero cobrado ANTES desaparecía del reparto sin
    // rastro; aquí se hace visible como bloque informativo — la utilidad
    // externa NO se distribuye entre socios (el vuelo no es de un avión de
    // la flota) hasta que el cliente decida su tratamiento.
    let extCobrado = 0;
    let extCosto = 0;
    let extComisionVendedor = 0;
    let extSinCosto = 0;
    let extSinTcMxn = 0;
    let extTcOficialCount = 0;
    const externosVuelos = vuelos.filter((v) => v.es_externo === true);
    for (const v of externosVuelos) {
      // Misma cadena de TC que los aviones de flota y el balance:
      // capturado en la cotización ?? oficial del día de la cotización.
      const tcOficialExt = tcOficial.vuelo.get(v.id);
      const conv = cobrosEnUsd(
        cobrosPorVuelo.get(v.id) ?? [],
        pos(v.tc_usd_mxn) ?? tcOficialExt?.tc ?? null,
      );
      if (tcOficialExt != null) extTcOficialCount += 1;
      extCobrado += conv.total_usd;
      extSinTcMxn += conv.sin_tc_mxn;
      // Externo CANCELADO (28-ago): lo retenido al cliente sí es ingreso; el
      // costo pactado con el operador NO se resta (el servicio no se prestó;
      // si el operador cobró penalización va como gasto del vuelo) ni se
      // reclama como "sin costo". Tampoco se provisiona pago al vendedor.
      if (v.estado === 'CANCELADO') continue;
      if (v.costo_externo_usd == null) {
        extSinCosto += 1;
      } else {
        extCosto += Number(v.costo_externo_usd);
      }
      // COMISIÓN DEL VENDEDOR en externos (verificación 28-ago): el vuelo
      // externo no se parte (no hay avión de flota), así que lo cobrado
      // incluye la comisión que el cliente pagó sumada al precio — y ese
      // dinero VuelaTour se lo paga al vendedor. Sin restarlo, la utilidad
      // externa quedaba inflada por el pago al vendedor. Fuente única
      // `pagoVendedorUsd` (comisión + su IVA cuando la cotización grava).
      extComisionVendedor += pagoVendedorUsd(particionIngresoVuelo(v));
    }
    const extCobradoR = round2(extCobrado);
    const extCostoR = round2(extCosto);
    const extComisionVendedorR = round2(extComisionVendedor);

    // INGRESO DE VUELATOUR del periodo (regla 6 + Regla A, 28-ago-2026): TUAS
    // + extras + pernocta + comisión del vendedor cobrados (+ su IVA) en
    // vuelos de la FLOTA. Sale de los mismos acumuladores por avión (misma
    // partición, mismos cobros; en multi-avión lo reporta UN solo avión), así
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
        acc.desglose.comision_usd += oi.desglose.comision_usd;
        acc.desglose.iva_usd += oi.desglose.iva_usd;
        return acc;
      },
      {
        vuelos: 0,
        cobrado_usd: 0,
        pendiente_usd: 0,
        desglose: {
          tuas_usd: 0,
          extras_usd: 0,
          pernocta_usd: 0,
          comision_usd: 0,
          iva_usd: 0,
        },
      },
    );

    // Agregado global INFORMATIVO del TC oficial (29-ago): Σ por avión
    // (cobros en el avión que reporta, gastos por avión) + pool de FIJOS +
    // externos. Los montos ya están DENTRO de las cifras del reparto; este
    // bloque solo dice cuántos se convirtieron así y con qué fuente.
    const tcOficialVuelos =
      aviones.reduce((acc, a) => acc + a.ingresos.cobros_tc_oficial_count, 0) +
      extTcOficialCount;
    const tcOficialGastos = aviones.reduce(
      (acc, a) => ({
        count: acc.count + a.gastos.gastos_tc_oficial.count,
        monto_mxn: acc.monto_mxn + a.gastos.gastos_tc_oficial.monto_mxn,
      }),
      { count: fijosTcOficialCount, monto_mxn: fijosTcOficialMxn },
    );
    const tcOficialFuentes = [
      ...new Set(
        [...tcOficial.vuelo.values(), ...tcOficial.gasto.values()].map((d) =>
          fuenteTcLegible(d.fuente),
        ),
      ),
    ].sort();

    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      gastos_sin_tc: { count: sinTcCount, monto_mxn: round2(sinTcMxn) },
      // ADITIVO (29-ago): FIJOS del pool convertidos con el TC oficial del
      // día del gasto (ya dentro de otros_prorrateados; NO están en
      // gastos_sin_tc).
      gastos_tc_oficial: {
        count: fijosTcOficialCount,
        monto_mxn: round2(fijosTcOficialMxn),
      },
      tc_oficial: {
        vuelos: tcOficialVuelos,
        gastos: {
          count: tcOficialGastos.count,
          monto_mxn: round2(tcOficialGastos.monto_mxn),
        },
        fuentes: tcOficialFuentes,
        leyenda: TC_OFICIAL_LEYENDA,
      },
      externos: {
        vuelos: externosVuelos.length,
        cobrado_usd: extCobradoR,
        costo_usd: extCostoR,
        // ADITIVO: pago al vendedor de los externos no cancelados (comisión
        // + IVA, `pagoVendedorUsd`); ya restado en utilidad_usd.
        comisiones_vendedor_usd: extComisionVendedorR,
        utilidad_usd: round2(extCobradoR - extCostoR - extComisionVendedorR),
        sin_costo_count: extSinCosto,
        cobros_sin_tc_mxn: round2(extSinTcMxn),
        // ADITIVO (29-ago): externos cuyos cobros MXN sin TC se convirtieron
        // con el TC oficial del día de la cotización.
        cobros_tc_oficial_count: extTcOficialCount,
      },
      otros_ingresos_vuelatour: {
        vuelos: otrosIngresosVuelatour.vuelos,
        cobrado_usd: round2(otrosIngresosVuelatour.cobrado_usd),
        pendiente_usd: round2(otrosIngresosVuelatour.pendiente_usd),
        // Desglose PRE-IVA cotizado (no cobrado) de los vuelos con precio del
        // periodo + su IVA: para entender de qué se compone el bloque.
        // comision_usd (ADITIVO, Regla A): comisión del vendedor — ingreso de
        // VuelaTour que se paga al vendedor (Otros movimientos).
        desglose: {
          tuas_usd: round2(otrosIngresosVuelatour.desglose.tuas_usd),
          extras_usd: round2(otrosIngresosVuelatour.desglose.extras_usd),
          pernocta_usd: round2(otrosIngresosVuelatour.desglose.pernocta_usd),
          comision_usd: round2(otrosIngresosVuelatour.desglose.comision_usd),
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
      /** Regla B: participación de cada avión en la venta de cada vuelo. */
      participacionPorVuelo: Map<string, ParticipacionAeronave>;
      /** escala.id → avión crudo del tramo (herencia en `avionDelGasto`). */
      escalaPorId: Map<string, { aeronave_id: string | null }>;
      /** vuelo.id → sus tramos (incluye cancelados; se filtran al etiquetar). */
      escalasPorVuelo: Map<string, EscalaHorasRow[]>;
      /** vuelo.id → avión principal del vuelo. */
      vueloAvion: Map<string, string | null>;
      /** aeronave.id → matrícula (toda la flota, para etiquetas). */
      matriculas: Map<string, string>;
      /** cliente.id → nombre (detalle.vuelos / PDF). */
      clientes: Map<string, string>;
      gastos: GastoRow[];
      socios: SocioRow[];
      reservas: ReservaRow[];
      nombres: Map<string, string>;
      otrosPorAvion: number;
      periodo: ProfitSharingQuery;
      /**
       * TC oficial de respaldo (29-ago): vuelo.id → detalle (solo vuelos sin
       * tc_usd_mxn con cobros MXN sin TC) y gasto.id → detalle (solo MXN sin
       * tc_gasto). Vacíos = todo capturado o sin red.
       */
      tcOficialVuelo: Map<string, TipoCambioDetalle>;
      tcOficialGasto: Map<string, TipoCambioDetalle>;
    },
  ) {
    // "Solo se reparte lo cobrado" (doc 4.8) con DINERO REAL: la suma de
    // cobro_vuelo en USD (fuente canónica), no el monto cotizado del vuelo.
    // Un vuelo pagado al 90% aporta su 90% y deja el resto como pendiente.
    //
    // REGLA 6 (cliente, 28-ago-2026): del total que paga el cliente solo la
    // VENTA DEL AVIÓN (tiempo + ajuste + su IVA) es del avión y se reparte.
    // TUAS/extras/pernocta/comisión del vendedor cobrados (+ su IVA) son
    // ingreso de VuelaTour (Otros movimientos del Balance general) y quedan
    // FUERA de la cascada. La partición es la fuente única
    // `particionIngresoVuelo`; lo cobrado se PRORRATEA con `factor_avion`
    // (= avion_usd exacto con el vuelo pagado completo; parcial en
    // proporción) y se TOPA en la venta del avión: el sobrecobro es de
    // VuelaTour (cobradoParteAvion), así el bruto cobrado siempre es parte
    // avión + parte VuelaTour al centavo y nada desaparece.
    //
    // REGLA B (cliente, 28-ago-2026): vuelo MULTI-AVIÓN (tramos en aviones
    // distintos) — la venta del avión y lo que deriva de ella (cobrado,
    // pendiente, retenido en cancelados) se REPARTE entre los aviones con
    // `repartirUsd` (centavos por residuo mayor: Σ partes == monto exacto).
    // La parte de VuelaTour NO se reparte: la reporta UN solo avión
    // (`avionQueReporta`, fuente única — misma regla que el balance por
    // avión y el Libro Dinero). Los gastos no se reparten: van al avión del
    // tramo al que están ligados (`avionDelGasto`).
    let cobrado = 0; // venta del avión cobrada (lo que SÍ se reparte)
    let cobradoBruto = 0; // todo lo cobrado al cliente (avión + VuelaTour)
    let pendiente = 0; // parte del avión aún no cobrada
    // Deuda COMPLETA del cliente (avión + VuelaTour): misma fórmula que el
    // pre-cierre `cobros_pendientes` — Σ max(0, total − cobrado) por vuelo
    // (en multi-avión, repartida: Σ sobre los aviones == esa fórmula).
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
      comision_usd: 0,
      iva_usd: 0,
    };
    let vuelosCobrados = 0;
    let vuelosPendientes = 0;
    let cobrosSinTcMxn = 0;
    // Vuelos cuyos cobros MXN sin TC se convirtieron con el TC oficial del
    // día de la cotización (29-ago): informativo, mismo criterio de conteo
    // que cobros_sin_tc (una vez, en el avión que reporta).
    let cobrosTcOficialCount = 0;
    // REGLA A (cliente, 28-ago-2026 tarde): la comisión del vendedor
    // (Itzy/Pablo/broker) es INGRESO DE VUELATOUR, como un extra — el
    // cliente la paga sumada al precio (regla 23-jul) y VuelaTour se la paga
    // al vendedor. Ya NO viaja en la venta del avión (particionIngresoVuelo
    // la manda a vuelatour_usd) y el avión NO la descuenta como costo:
    // `comisiones_venta_usd` queda en 0 SIEMPRE (el campo se conserva por
    // compatibilidad de shape con PDF/XLSX/panel). El pago al vendedor vive
    // apareado con su ingreso en Otros movimientos del Balance general.
    const comisionesVenta = 0;
    // Desglose por vuelo: se llena en el MISMO loop y con los MISMOS números
    // que los agregados (misma conversión cobrosEnUsd, misma partición,
    // mismo reparto multi-avión) para que la suma del detalle cuadre exacto
    // con ingresos.*. total_usd/cobrado_usd/pendiente_usd conservan su
    // sentido de siempre (total del CLIENTE y lo cobrado BRUTO — el panel
    // los suma); en multi-avión cada fila lleva SU parte del avión (+ la
    // parte VuelaTour solo en el avión que la reporta), de modo que Σ sobre
    // los aviones participantes == los totales del vuelo. Los campos
    // *_avion_* y otros_ingresos_vuelatour_* son ADITIVOS.
    // otros_ingresos_vuelatour_usd es lo COBRADO de la parte VuelaTour
    // (Σ detalle == ingresos.otros_ingresos_vuelatour_usd: el pie del detalle
    // del panel cuadra con la card); lo COTIZADO y lo PENDIENTE van en sus
    // propios campos — antes viajaba lo cotizado bajo el nombre del cobrado
    // y el pie no cuadraba con la card.
    const detalleVuelos: Array<{
      id: string;
      folio: number | null;
      /** ADITIVOS: nombre del cliente y estado (PDF/XLSX del reparto). */
      cliente: string | null;
      estado: string;
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
       * retenido entra como venta del avión (venta_avion_usd ==
       * cobrado_avion_usd), sin partición VuelaTour ni pendiente (en
       * multi-avión, repartido entre los aviones como la venta).
       */
      cancelado: boolean;
      /**
       * ADITIVOS (Regla B, 28-ago-2026): fracción de ESTE avión en la venta
       * del vuelo (1 en vuelos de un solo avión), si el vuelo lo volaron
       * varios aviones, cuántos de sus tramos activos voló este avión
       * ("1 de 2") y la fuente del peso (cotizacion | tramos | unico).
       */
      participacion?: number;
      multi_avion?: boolean;
      tramos_avion?: string;
      /** Ruta de los tramos VENDIDOS de este avión ("CUN→MID"), solo multi. */
      tramos_ruta_avion?: string;
      participacion_fuente?: ParticipacionAeronave['fuente'];
      /**
       * ADITIVO (29-ago-2026): presente solo cuando los cobros MXN sin TC de
       * este vuelo se convirtieron con el TC oficial de referencia del día
       * de la cotización (tc, día real del dato y fuente legible).
       */
      tc_oficial?: { tc: number; fecha_dato: string; fuente: string };
    }> = [];
    for (const v of ctx.vuelos) {
      // Regla B: el vuelo entra al avión si voló al menos un tramo activo
      // (factor > 0), no solo si es su avión principal.
      const part = ctx.participacionPorVuelo.get(v.id);
      const factor = part ? factorDe(part, a.id) : 0;
      if (!part || factor <= 0) continue;
      const reportaVT = avionQueReporta(part) === a.id;
      const p = particionIngresoVuelo(v);
      // TC de respaldo para cobros MXN sin TC propio: el de la cotización;
      // si no lo hay, el oficial del día de la cotización (29-ago; el mapa
      // solo trae vuelos que lo necesitan). Misma cadena que el balance.
      const tcOficialVuelo = ctx.tcOficialVuelo.get(v.id);
      const conv = cobrosEnUsd(
        ctx.cobrosPorVuelo.get(v.id) ?? [],
        pos(v.tc_usd_mxn) ?? tcOficialVuelo?.tc ?? null,
      );
      // VUELO CANCELADO (regla del cliente, 28-ago-2026): lo cobrado y NO
      // reembolsado (cargo por cancelación / anticipo retenido) es ingreso
      // real del avión — entra íntegro como venta del avión, SIN partición
      // (no se vendieron TUAS/extras/pernocta/comisión: el servicio no se
      // prestó) y SIN pendiente (la cotización ya no es una cuenta por
      // cobrar). Sus gastos entran como los de cualquier vuelo (por
      // categoría, abajo).
      const esCancelado = v.estado === 'CANCELADO';
      // Cancelado sin cobros (ni USD ni MXN sin TC): no aporta ingreso ni
      // cuenta como vuelo del reparto — sus gastos, si los hay, ya entran por
      // categoría abajo (ctx.gastos por avión del tramo). Así, en el avión
      // que reporta, detalle.vuelos == vuelos_cobrados + vuelos_pendientes
      // por construcción.
      if (esCancelado && conv.total_usd <= 0 && conv.sin_tc_mxn <= 0) continue;
      // ---- Números del VUELO completo (misma fórmula de siempre) ----
      const cobradoAvionVuelo = esCancelado
        ? conv.total_usd
        : cobradoParteAvion(conv.total_usd, p);
      const cobradoVT = esCancelado
        ? 0
        : round2(conv.total_usd - cobradoAvionVuelo);
      const ventaAvionVuelo = esCancelado ? cobradoAvionVuelo : p.avion_usd;
      const totalVuelo = esCancelado ? conv.total_usd : p.total_usd;
      const pendienteAvionVuelo = esCancelado
        ? 0
        : Math.max(0, round2(p.avion_usd - cobradoAvionVuelo));
      const pendienteBrutoVuelo = esCancelado
        ? 0
        : Math.max(0, round2(p.total_usd - conv.total_usd));
      const pendienteVT = esCancelado
        ? 0
        : Math.max(0, round2(p.vuelatour_usd - cobradoVT));
      // ---- Parte de ESTE avión (Regla B): repartirUsd, jamás monto ×
      // factor redondeado por separado (descuadra centavos). Con un solo
      // avión la parte es el monto completo. ----
      const parte = (monto: number): number =>
        repartirUsd(monto, part).get(a.id) ?? 0;
      const ventaAvion = parte(ventaAvionVuelo);
      const cobradoAvion = parte(cobradoAvionVuelo);
      const pendienteAvion = parte(pendienteAvionVuelo);
      // Fila del avión: su parte del avión + (solo en el que reporta) la
      // parte VuelaTour, CERRADA POR DIFERENCIA contra el total del vuelo
      // (total − parte avión de los demás), así Σ filas de todos los aviones
      // == total / cobrado / pendiente del vuelo al centavo. Con un solo
      // avión se reduce a los números de siempre.
      const totalFila = reportaVT
        ? round2(totalVuelo - ventaAvionVuelo + ventaAvion)
        : ventaAvion;
      const cobradoFila = reportaVT
        ? round2(conv.total_usd - cobradoAvionVuelo + cobradoAvion)
        : cobradoAvion;
      const pendienteFila = reportaVT
        ? Math.max(
            0,
            round2(pendienteBrutoVuelo - pendienteAvionVuelo + pendienteAvion),
          )
        : pendienteAvion;
      cobrado += cobradoAvion;
      cobradoBruto += cobradoFila;
      pendiente += pendienteAvion;
      pendienteBruto += pendienteFila;
      if (reportaVT) {
        otrosIngresosVT += cobradoVT;
        otrosIngresosVTPendiente += pendienteVT;
        // Un cancelado no aporta al bloque informativo de ingreso VuelaTour
        // (ni conteo ni desglose cotizado): nada de eso se vendió.
        if (!esCancelado && p.vuelatour_usd > 0) {
          vuelosConOtrosIngresos += 1;
          desgloseVT.tuas_usd += p.tuas_usd;
          desgloseVT.extras_usd += p.extras_usd;
          desgloseVT.pernocta_usd += p.pernocta_usd;
          desgloseVT.comision_usd += p.comision_vendedor_usd;
          desgloseVT.iva_usd += p.iva_vuelatour_usd;
        }
        // MXN sin TC no se puede repartir (no convirtió): el aviso viaja
        // una sola vez, con el avión que reporta el vuelo.
        cobrosSinTcMxn += conv.sin_tc_mxn;
        if (tcOficialVuelo != null) cobrosTcOficialCount += 1;
      }
      // CONTEOS (verificación 28-ago): SOLO en el avión que reporta el
      // vuelo — el KPI de flota del panel suma vuelos_cobrados/pendientes de
      // todos los aviones y un multi-avión contado en cada participante
      // salía DOBLE. El otro avión sigue viendo el vuelo en detalle.vuelos
      // (participacion / multi_avion) con su parte del dinero. Un cancelado
      // nunca es "pendiente" (no hay saldo por cobrar); cuenta como cobrado
      // solo si de verdad retuvo dinero.
      if (reportaVT) {
        if (esCancelado) {
          vuelosCobrados += 1; // ya se filtró arriba: siempre retuvo dinero
        } else if (v.cobrado) vuelosCobrados += 1;
        else vuelosPendientes += 1;
      }
      // Etiqueta multi-avión en la ruta: porcentaje, con quién se comparte y
      // la fuente del peso.
      let etiquetaParticipacion: string | null = null;
      if (part.multi_avion) {
        const otros = [...part.factores.keys()]
          .filter((id) => id !== a.id)
          .map((id) => ctx.matriculas.get(id) ?? '?')
          .join(', ');
        const fuente = fuenteParticipacionLabel(part.fuente);
        etiquetaParticipacion = reportaVT
          ? `${pctLabel(factor)} (tramos también en ${otros}${fuente ? `; ${fuente}` : ''})`
          : `COMPARTIDO ${pctLabel(factor)} (con ${otros}${fuente ? `; ${fuente}` : ''})`;
      }
      // Tramos VENDIDOS de este avión en el vuelo ("CUN→MID"): mismo filtro
      // que la fuente única (activos, no operativos, avión con herencia).
      const tramosRutaAvion = part.multi_avion
        ? (ctx.escalasPorVuelo.get(v.id) ?? [])
            .filter(
              (e) =>
                e.cancelada_at == null &&
                e.solo_operativa !== true &&
                e.es_ferry !== true &&
                (e.aeronave_id ?? v.aeronave_id) === a.id,
            )
            .map((e) => `${e.origen_iata ?? '?'}→${e.destino_iata ?? '?'}`)
            .join(', ')
        : '';
      detalleVuelos.push({
        id: v.id,
        folio: v.folio ?? null,
        cliente: v.cliente_id ? (ctx.clientes.get(v.cliente_id) ?? null) : null,
        estado: v.estado,
        fecha: diaCancun(v.fecha_vuelo),
        ruta: `${v.origen_iata ?? '—'} → ${v.destino_iata ?? '—'}${
          etiquetaParticipacion ? ` · ${etiquetaParticipacion}` : ''
        }`,
        es_externo: v.es_externo === true,
        // Cancelado: el total del cliente es lo retenido (la cotización ya
        // no es deuda) — así el pie del panel (Σ venta) cuadra con la card.
        total_usd: totalFila,
        cobrado_usd: cobradoFila,
        pendiente_usd: pendienteFila,
        venta_avion_usd: ventaAvion,
        cobrado_avion_usd: cobradoAvion,
        pendiente_avion_usd: pendienteAvion,
        otros_ingresos_vuelatour_usd: reportaVT ? cobradoVT : 0,
        otros_ingresos_vuelatour_cotizado_usd:
          reportaVT && !esCancelado ? p.vuelatour_usd : 0,
        otros_ingresos_vuelatour_pendiente_usd: reportaVT ? pendienteVT : 0,
        cobrado_bruto_usd: cobradoFila,
        particion_fuente: p.fuente,
        particion_inconsistente: esCancelado ? false : p.inconsistente,
        // Regla A: la comisión ya no se descuenta al avión (siempre 0; el
        // monto cotizado viaja en otros_ingresos_vuelatour.desglose).
        comision_vendedor_usd: 0,
        // Cancelado con dinero retenido = cobrado (no hay saldo pendiente);
        // los cancelados sin cobros ya no llegan aquí.
        cobrado: esCancelado || v.cobrado,
        cobros_sin_tc_mxn: reportaVT ? conv.sin_tc_mxn : 0,
        cancelado: esCancelado,
        participacion: factor,
        multi_avion: part.multi_avion,
        tramos_avion: part.multi_avion
          ? `${part.tramos_por_avion.get(a.id) ?? 0} de ${part.tramos_activos}`
          : undefined,
        tramos_ruta_avion: tramosRutaAvion || undefined,
        participacion_fuente: part.fuente,
        tc_oficial: tcOficialVuelo
          ? {
              tc: tcOficialVuelo.tc,
              fecha_dato: tcOficialVuelo.fecha_dato,
              fuente: fuenteTcLegible(tcOficialVuelo.fuente),
            }
          : undefined,
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
      // Avión del gasto (Regla B, misma prioridad en todos los lectores):
      // avión del TRAMO ligado (con herencia) → avión sellado en el gasto →
      // avión principal del vuelo. Un PARCIAL del reparto manual ya trae su
      // avión decidido (el reparto gana); sin vuelo manda aeronave_id.
      const avionGasto =
        g.es_reparto_parcial || !g.vuelo_id
          ? (g.aeronave_id ?? null)
          : avionDelGasto(
              g,
              ctx.escalaPorId,
              ctx.vueloAvion.get(g.vuelo_id) ?? null,
            );
      if (avionGasto !== a.id) continue;
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
            // NOMINA (29-ago): mismo tratamiento que INDIRECTO.
            g.es_reparto_parcial &&
              (g.categoria === 'INDIRECTO' ||
                g.categoria === 'NOMINA' ||
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
        tc_oficial_count: 0,
        tc_oficial_mxn: 0,
      };
      // Monto EFECTIVO del avión = monto − TUA embebido (en la moneda del
      // gasto), convertido con la MISMA regla/TC de siempre (tc_gasto ??
      // oficial del día del gasto). Sin TC el gasto entero sigue en sin_tc_*
      // (nada se convierte a medias).
      const tuaEmbebido = tuaEmbebidoDeGasto(g);
      const conv = this.toUsd(
        tuaEmbebido > 0
          ? { ...g, monto: round2(Number(g.monto) - tuaEmbebido) }
          : g,
        ctx.tcOficialGasto,
      );
      if (conv === null) {
        acc.sin_tc_count += 1;
        acc.sin_tc_mxn += Number(g.monto);
      } else {
        acc.count += 1;
        acc.usd += conv.usd;
        if (conv.oficial) {
          acc.tc_oficial_count += 1;
          acc.tc_oficial_mxn += Number(g.monto);
        }
        if (tuaEmbebido > 0) {
          tuaEmbebidoCount += 1;
          tuaEmbebidoUsd +=
            this.toUsd({ ...g, monto: tuaEmbebido }, ctx.tcOficialGasto)?.usd ??
            0;
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
        tc_oficial_count: 0,
        tc_oficial_mxn: 0,
      });
    }
    let directos = 0;
    let indirectos = 0;
    let permisos = 0;
    let fijoManual = 0;
    let sinTc = 0;
    let sinTcMxn = 0;
    let tcOficialCount = 0;
    let tcOficialMxn = 0;
    for (const acc of porCategoria.values()) {
      if (acc.grupo === 'DIRECTO') directos += acc.usd;
      else if (acc.grupo === 'INDIRECTO') indirectos += acc.usd;
      else if (acc.grupo === 'PERMISO') permisos += acc.usd;
      else if (acc.grupo === 'FIJO') fijoManual += acc.usd;
      // EXCLUIDO no suma al balance (comportamiento original del else).
      sinTc += acc.sin_tc_count;
      sinTcMxn += acc.sin_tc_mxn;
      tcOficialCount += acc.tc_oficial_count;
      tcOficialMxn += acc.tc_oficial_mxn;
    }
    const detalleGastos = [...porCategoria.entries()]
      .map(([categoria, acc]) => ({
        categoria,
        grupo: acc.grupo,
        count: acc.count,
        usd: round2(acc.usd),
        sin_tc_count: acc.sin_tc_count,
        sin_tc_mxn: round2(acc.sin_tc_mxn),
        // ADITIVOS (29-ago): de `count`, los convertidos con TC oficial.
        tc_oficial_count: acc.tc_oficial_count,
        tc_oficial_mxn: round2(acc.tc_oficial_mxn),
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
        // Deuda completa del cliente (avión + TUAS/extras/pernocta/comisión
        // + IVA) = Σ detalle.vuelos[].pendiente_usd; misma fórmula que el
        // pre-cierre (en multi-avión, la parte de este avión).
        pendiente_bruto_usd: round2(pendienteBruto),
        // Conteos SOLO del avión que reporta cada vuelo (multi-avión: un
        // vuelo, un conteo — el KPI de flota los suma por avión). En el
        // otro avión participante detalle.vuelos.length puede ser mayor.
        vuelos_cobrados: vuelosCobrados,
        vuelos_pendientes: vuelosPendientes,
        cobros_sin_tc_mxn: round2(cobrosSinTcMxn),
        // ADITIVO (29-ago): vuelos (contados en el avión que reporta) cuyos
        // cobros MXN sin TC entraron con el TC oficial del día de la
        // cotización — ya DENTRO de cobrado_usd; cobros_sin_tc_mxn solo
        // conserva lo que ni así convirtió.
        cobros_tc_oficial_count: cobrosTcOficialCount,
      },
      horas_voladas_hr: horasPeriodo,
      gastos: {
        directos_usd: directosR,
        indirectos_usd: indirectosR,
        permisos_usd: permisosR,
        otros_prorrateados_usd: otrosR,
        gastos_sin_tc_count: sinTc,
        gastos_sin_tc_mxn: round2(sinTcMxn),
        // ADITIVO (29-ago): gastos MXN sin tc_gasto convertidos con el TC
        // oficial del día del gasto (ya dentro de los montos de arriba; NO
        // están en gastos_sin_tc_*). Σ detalle.gastos_por_categoria.
        gastos_tc_oficial: {
          count: tcOficialCount,
          monto_mxn: round2(tcOficialMxn),
        },
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
        // comision_usd es ADITIVO (Regla A): comisión del vendedor cotizada.
        otros_ingresos_vuelatour: {
          vuelos: vuelosConOtrosIngresos,
          desglose: {
            tuas_usd: round2(desgloseVT.tuas_usd),
            extras_usd: round2(desgloseVT.extras_usd),
            pernocta_usd: round2(desgloseVT.pernocta_usd),
            comision_usd: round2(desgloseVT.comision_usd),
            iva_usd: round2(desgloseVT.iva_usd),
          },
        },
      },
    };
  }

  /**
   * Convierte un gasto a USD. null = no se pudo (MXN sin tc_gasto NI TC
   * oficial del día del gasto). `oficial` = true cuando el TC vino del
   * respaldo oficial (regla del cliente, 29-ago-2026) — solo para contarlo
   * en gastos_tc_oficial; el monto entra igual que uno con TC capturado.
   */
  private toUsd(
    g: GastoRow,
    tcOficialGasto: Map<string, TipoCambioDetalle>,
  ): { usd: number; oficial: boolean } | null {
    if (g.moneda === 'USD') return { usd: Number(g.monto), oficial: false };
    const propio = pos(g.tc_gasto);
    if (propio != null) {
      return { usd: Number(g.monto) / propio, oficial: false };
    }
    // El mapa solo trae gastos MXN sin tc_gasto (resolverTcOficial); un
    // parcial del reparto manual comparte el id (y la fecha) del padre.
    const oficial = tcOficialGasto.get(g.id)?.tc;
    if (oficial != null && oficial > 0) {
      return { usd: Number(g.monto) / oficial, oficial: true };
    }
    return null;
  }

  /**
   * TC OFICIAL de respaldo (regla del cliente, 29-ago-2026): por VUELO (sin
   * tc_usd_mxn → día Cancún de la cotización: fecha_solicitud, si no
   * fecha_vuelo) y por GASTO (MXN sin tc_gasto → día del gasto, columna
   * date). Un solo lote de días para ambos: cada día se consulta UNA vez
   * (`tcOficialPorDias`). Devuelve el DETALLE (tc, fuente, día real del
   * dato) para que el reparto diga de dónde salió cada conversión.
   */
  private async resolverTcOficial(
    vuelos: ReadonlyArray<
      Pick<VueloRow, 'id' | 'tc_usd_mxn' | 'fecha_solicitud' | 'fecha_vuelo'>
    >,
    gastos: ReadonlyArray<
      Pick<GastoRow, 'id' | 'moneda' | 'tc_gasto' | 'fecha_gasto'>
    >,
  ): Promise<{
    vuelo: Map<string, TipoCambioDetalle>;
    gasto: Map<string, TipoCambioDetalle>;
  }> {
    const diaVuelo = new Map<string, string>();
    for (const v of vuelos) {
      if (pos(v.tc_usd_mxn) != null) continue;
      const dia = diaCancun(v.fecha_solicitud ?? v.fecha_vuelo);
      if (dia) diaVuelo.set(v.id, dia);
    }
    const diaGasto = new Map<string, string>();
    for (const g of gastos) {
      if (g.moneda !== 'MXN' || pos(g.tc_gasto) != null) continue;
      const dia = diaDeFecha(g.fecha_gasto ?? null);
      if (dia) diaGasto.set(g.id, dia);
    }
    const porDia = await this.tcOficialPorDias([
      ...diaVuelo.values(),
      ...diaGasto.values(),
    ]);
    const vuelo = new Map<string, TipoCambioDetalle>();
    for (const [id, dia] of diaVuelo) {
      const det = porDia.get(dia);
      if (det) vuelo.set(id, det);
    }
    const gasto = new Map<string, TipoCambioDetalle>();
    for (const [id, dia] of diaGasto) {
      const det = porDia.get(dia);
      if (det) gasto.set(id, det);
    }
    return { vuelo, gasto };
  }

  /**
   * TC oficial de referencia por DÍA (open.er-api diario / BCE-frankfurter
   * histórico, vía `TipoCambioService.oficialDetallePara`) — mismo patrón
   * que `tcOficialPorVuelos` del balance: todas las promesas se crean
   * primero (un día = una consulta) y se esperan con concurrencia acotada
   * (~5) para no saturar a los proveedores. `oficialDetallePara` nunca
   * lanza; el catch es defensa: un día sin dato → sin respaldo (el monto
   * sigue en sin_tc_*, jamás se inventa un número ni se rompe el reparto).
   */
  private async tcOficialPorDias(
    dias: Iterable<string>,
  ): Promise<Map<string, TipoCambioDetalle>> {
    const MAX_CONCURRENTES = 5;
    let activos = 0;
    const cola: Array<() => void> = [];
    const adquirir = (): Promise<void> =>
      new Promise<void>((res) => {
        if (activos < MAX_CONCURRENTES) {
          activos += 1;
          res();
        } else {
          cola.push(() => {
            activos += 1;
            res();
          });
        }
      });
    const liberar = (): void => {
      activos -= 1;
      const siguiente = cola.shift();
      if (siguiente) siguiente();
    };
    const promesas = new Map<string, Promise<TipoCambioDetalle | null>>();
    for (const dia of new Set(dias)) {
      promesas.set(
        dia,
        (async (): Promise<TipoCambioDetalle | null> => {
          await adquirir();
          try {
            return await this.tipoCambio.oficialDetallePara(dia);
          } catch {
            return null;
          } finally {
            liberar();
          }
        })(),
      );
    }
    const out = new Map<string, TipoCambioDetalle>();
    for (const [dia, p] of promesas) {
      const det = await p;
      if (det != null && det.tc > 0) out.set(dia, det);
    }
    return out;
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
        // fecha_vuelo/fecha_solicitud: día del TC oficial de respaldo
        // (29-ago) para cobros MXN sin TC de cotizaciones sin tc_usd_mxn.
        .select(
          'id, folio, piloto_id, cliente_id, monto_total_usd, tc_usd_mxn, fecha_vuelo, fecha_solicitud, cobrado, subtotal_vuelo_usd, ajuste_final_usd, comision_vendedor_usd, iva_usd, iva_pct, tuas_usd, extras_total_usd, viaticos_pernocta_usd, calculo_snapshot',
        )
        .eq('estado', 'COMPLETADO')
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs),
      // Cancelados del periodo: pueden tener dinero real (cobros retenidos y
      // gastos) que YA cuenta en el reparto (regla 28-ago) — aquí solo se
      // enumeran para que la oficina confirme que ese dinero es de verdad.
      sb
        .from('vuelo')
        .select('id, folio, tc_usd_mxn, fecha_vuelo, fecha_solicitud')
        .eq('estado', 'CANCELADO')
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs),
      // Gastos del periodo con huecos de datos. El embed del vuelo solo
      // sirve para reconocer el GAS de un externo sin avión (abajo).
      sb
        .from('gasto')
        .select(
          // escala embebida: avión RESOLUBLE del gasto (`avionDelGasto`) para
          // el bloqueante de combustible sin avión.
          'id, vuelo_id, aeronave_id, escala_id, categoria, monto, moneda, tc_gasto, fecha_gasto, estatus_facturacion, medio_pago, conciliado, duplicado_sospechado, matricula_ia:valor_ia_extraido->>matricula, escala:escala_id(aeronave_id), vuelo:vuelo_id(es_externo, aeronave_id)',
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
    const completados = (completadosRes.data ?? []) as Array<
      Record<string, unknown>
    >;
    // COBROS de cancelados + completados (una consulta) y TC OFICIAL de
    // respaldo (regla del cliente, 29-ago-2026): un vuelo sin tc_usd_mxn con
    // cobros MXN sin TC se convierte con el TC oficial del día de la
    // cotización — la MISMA cadena que el reparto (`compute`) y el balance.
    // Antes esos cobros no convertían y el vuelo salía como "saldo por
    // cobrar" en falso. Lo que ni así convierte se lista en `cobros_sin_tc`.
    const cobrosPre = await this.fetchCobros(
      [...cancelados, ...completados].map((v) => v.id as string),
    );
    const cobrosPorVueloPre = new Map<string, CobroRow[]>();
    for (const c of cobrosPre) {
      const list = cobrosPorVueloPre.get(c.vuelo_id) ?? [];
      list.push(c);
      cobrosPorVueloPre.set(c.vuelo_id, list);
    }
    const tcOficialPre = await this.resolverTcOficial(
      [...cancelados, ...completados]
        .map((v) => ({
          id: v.id as string,
          tc_usd_mxn: (v.tc_usd_mxn as string | null) ?? null,
          fecha_solicitud: (v.fecha_solicitud as string | null) ?? null,
          fecha_vuelo: (v.fecha_vuelo as string | null) ?? null,
        }))
        .filter((v) =>
          cobrosNecesitanTc(cobrosPorVueloPre.get(v.id) ?? [], v.tc_usd_mxn),
        ),
      [],
    );
    /** cobrosEnUsd con la cadena tc de cotización ?? TC oficial del día. */
    const convCobros = (v: Record<string, unknown>) =>
      cobrosEnUsd(
        cobrosPorVueloPre.get(v.id as string) ?? [],
        pos(v.tc_usd_mxn) ?? tcOficialPre.vuelo.get(v.id as string)?.tc ?? null,
      );
    const cobrosTcOficialVuelos: Array<{ id: string; folio: number }> = [];
    const cobrosSinTcVuelos: Array<{ id: string; folio: number }> = [];
    let cobrosSinTcMxn = 0;
    for (const v of [...cancelados, ...completados]) {
      const conv = convCobros(v);
      const ref = { id: v.id as string, folio: v.folio as number };
      if (tcOficialPre.vuelo.has(ref.id)) cobrosTcOficialVuelos.push(ref);
      if (conv.sin_tc_mxn > 0) {
        cobrosSinTcVuelos.push(ref);
        cobrosSinTcMxn += conv.sin_tc_mxn;
      }
    }

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
      const gastosCancRes = await sb
        .from('gasto')
        .select('id, vuelo_id')
        .in('vuelo_id', idsCancelados);
      if (gastosCancRes.error) throw new Error(gastosCancRes.error.message);

      const vuelosConGasto = new Set(
        (gastosCancRes.data ?? []).map((g) => g.vuelo_id as string),
      );
      for (const v of cancelados) {
        const lista = cobrosPorVueloPre.get(v.id as string) ?? [];
        if (lista.length > 0) {
          // Fuente única de "cuánto se cobró en USD" (cobrosEnUsd, con el
          // TC oficial de respaldo); los MXN que ni así convierten quedan
          // fuera del monto pero el vuelo sí cuenta.
          const conv = convCobros(v);
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
      const conv = convCobros(v);
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

    // Extras SIN desglose exacto (regla 6 + Regla A): la venta del avión se
    // separa de TUAS/extras/pernocta/comisión del vendedor con el desglose
    // canónico del snapshot; si el vuelo con precio no lo tiene (fuente
    // 'columnas') y trae alguno de esos componentes, o el desglose no cuadra
    // con el total (inconsistente → todo al avión), la partición es
    // aproximada. Aviso NO bloqueante: el dinero no se pierde (cierre por
    // diferencia), solo puede quedar mal repartido entre avión y VuelaTour
    // hasta revisar la cotización.
    const extrasSinDesglose = completados
      .filter((v) => {
        if (!(Number(v.monto_total_usd ?? 0) > 0)) return false;
        const p = particionIngresoVuelo(v);
        return (
          p.inconsistente ||
          (p.fuente === 'columnas' &&
            round2(
              p.tuas_usd +
                p.extras_usd +
                p.pernocta_usd +
                p.comision_vendedor_usd,
            ) > 0)
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
        // NOMINA (29-ago): como INDIRECTO, sin avión por diseño. SERVICIOS
        // NO se exenta: sin avión SÍ bloquea (como REFACCION).
        g.categoria !== 'NOMINA' &&
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
    // Avión RESOLUBLE del gasto (misma fuente única que balance/reparto,
    // `avionDelGasto`: tramo con herencia → sellado → vuelo). Un GAS con
    // vuelo/tramo resoluble NO es dinero invisible (el reparto y la hoja
    // combustible de ese avión ya lo cargan) — antes el bloqueante gritaba
    // en falso por el aeronave_id crudo. Sigue en la bandeja informativa
    // `gastos_sin_avion` hasta que se selle la aeronave.
    const avionResoluble = (g: Record<string, unknown>): string | null => {
      const rawE: unknown = g.escala;
      const esc = (Array.isArray(rawE) ? (rawE as unknown[])[0] : rawE) as {
        aeronave_id?: string | null;
      } | null;
      const rawV: unknown = g.vuelo;
      const vuelo = (Array.isArray(rawV) ? (rawV as unknown[])[0] : rawV) as {
        aeronave_id?: string | null;
      } | null;
      const mapa = new Map<string, { aeronave_id?: string | null }>();
      if (typeof g.escala_id === 'string' && esc) mapa.set(g.escala_id, esc);
      return avionDelGasto(
        {
          escala_id: (g.escala_id as string | null) ?? null,
          aeronave_id: (g.aeronave_id as string | null) ?? null,
        },
        mapa,
        vuelo?.aeronave_id ?? null,
      );
    };
    const gasSinAvion = sinAvion.filter(
      (g) =>
        g.categoria === 'GAS' &&
        !esGasDeExternoSinAvion(g) &&
        avionResoluble(g) == null,
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
    // TC oficial del día del gasto (29-ago): los MXN sin TC que SÍ tienen
    // referencia oficial YA entran al reparto y al balance (informativo);
    // solo bloquean el cierre los que ni así convierten (sin red / sin dato).
    const tcOficialGastosPre = await this.resolverTcOficial(
      [],
      sinTc.map((g) => ({
        id: g.id as string,
        moneda: g.moneda as string,
        tc_gasto: (g.tc_gasto as string | null) ?? null,
        fecha_gasto: (g.fecha_gasto as string | null) ?? null,
      })),
    );
    const sinTcConOficial = sinTc.filter((g) =>
      tcOficialGastosPre.gasto.has(g.id as string),
    );
    const sinTcSinOficial = sinTc.filter(
      (g) => !tcOficialGastosPre.gasto.has(g.id as string),
    );
    const sumaMxn = (lista: Array<Record<string, unknown>>) =>
      round2(lista.reduce((acc, g) => acc + Number(g.monto), 0));
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
          'Solo se reparte lo cobrado: la parte del avión de este saldo queda fuera del reparto (el resto —TUAS/extras/pernocta/comisión del vendedor— es ingreso de VuelaTour, tampoco cobrado).',
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
          'No se puede separar con exactitud la venta del avión de los extras (TUAS/extras/pernocta/comisión del vendedor son ingreso de VuelaTour, no del avión): revisa la cotización en el detalle del vuelo para regenerar el desglose. Mientras tanto se usan las columnas del vuelo, o todo el total va al avión si el desglose no cuadra.',
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
          'Cargo por cancelación o anticipo no reembolsado: entra íntegro como venta del avión (repartido entre los aviones si el vuelo voló en más de uno), sin saldo pendiente. Confirma que no se haya devuelto al cliente; si se reembolsó, corrige o elimina el cobro en el detalle del vuelo.',
        count: cobrosEnCancelados.length,
        monto_usd: round2(cobrosEnCanceladosUsd),
        vuelos: cobrosEnCancelados,
        // ADITIVO: el panel lo pinta como aviso informativo, no pendiente.
        informativo: true,
      },
      {
        clave: 'gastos_en_cancelados',
        titulo: 'Gastos ligados a vuelos cancelados (ya restan en el reparto)',
        detalle:
          'Se voló a recoger, ferry de regreso, pistas… son costo real del avión y ya se descuentan. Confirma que correspondan a algo que sí ocurrió: una pista provisionada de un vuelo que nunca despegó se borra en Gastos.',
        count: gastosEnCanceladosCount,
        vuelos: vuelosConGastoCancelado,
        informativo: true,
      },
      // Informativos (29-ago): lo que YA se convirtió con el TC oficial de
      // referencia del día (open.er-api / BCE). No bloquean: el dinero sí
      // está en el reparto y en el balance; capturar el TC lo sustituye.
      {
        clave: 'gastos_tc_oficial',
        titulo: 'Gastos MXN sin TC capturado (convertidos con el TC oficial)',
        detalle:
          'Se convierten con el TC oficial de referencia del día del gasto (open.er-api / BCE) y ya restan en el reparto y en el balance. Si quieres usar el TC real del pago, captúralo en Gastos.',
        count: sinTcConOficial.length,
        monto_mxn: sumaMxn(sinTcConOficial),
        informativo: true,
      },
      {
        clave: 'cobros_tc_oficial',
        titulo: 'Vuelos con cobros MXN sin TC (convertidos con el TC oficial)',
        detalle:
          'La cotización no trae tipo de cambio: sus cobros en pesos se convierten con el TC oficial de referencia del día de la cotización (open.er-api / BCE) y ya cuentan como cobrados. Capturar el TC en el vuelo o en el cobro lo sustituye.',
        count: cobrosTcOficialVuelos.length,
        vuelos: cobrosTcOficialVuelos,
        informativo: true,
      },
      {
        clave: 'gastos_sin_tc',
        titulo: 'Gastos MXN sin tipo de cambio',
        detalle:
          'Sin TC capturado ni TC oficial de referencia disponible para su fecha: quedan FUERA del balance USD hasta capturarles TC.',
        count: sinTcSinOficial.length,
        monto_mxn: sumaMxn(sinTcSinOficial),
      },
      {
        clave: 'cobros_sin_tc',
        titulo: 'Vuelos con cobros MXN sin tipo de cambio',
        detalle:
          'Cobros en pesos sin TC en el cobro, en la cotización ni TC oficial de referencia para su fecha: NO cuentan como cobrados hasta capturarles TC en el vuelo.',
        count: cobrosSinTcVuelos.length,
        monto_mxn: round2(cobrosSinTcMxn),
        vuelos: cobrosSinTcVuelos,
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
    // gastos/cobros MXN que no convierten ni con el TC oficial (29-ago) y
    // combustible sin avión (el gas del mes es por avión). El resto es
    // aviso (cobranza/conciliación son procesos).
    const bloqueantes = [
      'vuelos_sin_completar',
      'tacos_en_revision',
      'gastos_sin_tc',
      'cobros_sin_tc',
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
        // fecha_solicitud: día de la cotización para el TC oficial de
        // respaldo (29-ago) cuando la cotización no trae tc_usd_mxn.
        'id, aeronave_id, cliente_id, estado, monto_total_usd, tc_usd_mxn, cobrado, comision_vendedor_usd, folio, fecha_vuelo, fecha_solicitud, origen_iata, destino_iata, es_externo, costo_externo_usd, subtotal_vuelo_usd, ajuste_final_usd, iva_usd, iva_pct, tuas_usd, extras_total_usd, viaticos_pernocta_usd, calculo_snapshot',
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
    // Se traen TAMBIÉN los tramos cancelados (cancelada_at): no suman horas
    // ni participan en el reparto (lo filtran compute() y la fuente única
    // participacionPorAeronave), pero un gasto ligado a un tramo cancelado
    // sigue siendo del avión de ese tramo (avionDelGasto). Los tramos vivos
    // de un vuelo CANCELADO sí suman horas: solo si tienen salida Y llegada,
    // y la llegada siempre es evidencia real (el sistema jamás la estima) —
    // si el avión voló a recoger y regresó ferry, esas horas movieron el
    // horómetro y cuentan en la reserva de overhaul.
    const { data, error } = await this.supabase.service
      .from('escala')
      // solo_operativa / es_ferry: la fuente única excluye los tramos
      // operativos del reparto de la venta (sin estas columnas un ferry
      // intercalado contaría como tramo vendido). origen/destino: etiqueta
      // "CUN→MID" de los tramos del avión en el PDF/XLSX.
      .select(
        'id, vuelo_id, orden, aeronave_id, cancelada_at, taco_salida, taco_llegada, solo_operativa, es_ferry, origen_iata, destino_iata',
      )
      .in('vuelo_id', vueloIds)
      // Orden DETERMINISTA (verificación 28-ago): sin ORDER BY el orden de
      // inserción en `participacionPorAeronave` (desempates de
      // `avionQueReporta`/`repartirUsd`) podía diferir del balance y del
      // Libro Dinero — mismo orden en los tres lectores.
      .order('vuelo_id', { ascending: true })
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Avión (ya con herencia del vuelo) de escalas sueltas — las referidas por
   * gastos del periodo cuyo vuelo NO es del periodo. Map escala.id → avión.
   */
  private async fetchAvionDeEscalas(
    escalaIds: string[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (escalaIds.length === 0) return out;
    const { data, error } = await this.supabase.service
      .from('escala')
      .select('id, aeronave_id, vuelo:vuelo_id(aeronave_id)')
      .in('id', escalaIds);
    if (error) throw new Error(error.message);
    for (const e of (data ?? []) as Array<Record<string, unknown>>) {
      const raw: unknown = e.vuelo;
      const vuelo = (Array.isArray(raw) ? raw[0] : raw) as {
        aeronave_id?: string | null;
      } | null;
      out.set(
        e.id as string,
        (e.aeronave_id as string | null) ?? vuelo?.aeronave_id ?? null,
      );
    }
    return out;
  }

  /** aeronave.id → matrícula de TODA la flota (etiquetas multi-avión). */
  private async fetchMatriculas(): Promise<Map<string, string>> {
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .select('id, matricula');
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((a) => [a.id as string, a.matricula as string]),
    );
  }

  private async fetchGastos(desde: string, hasta: string): Promise<GastoRow[]> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      // propina + valor_ia_extraido: para separar el TUA embebido en
      // facturas de aeródromo (regla 7) con la misma regla del balance.
      // escala_id: avión del gasto por tramo (Regla B, avionDelGasto).
      // fecha_gasto: día del TC oficial de respaldo (29-ago) en MXN sin TC.
      .select(
        'id, aeronave_id, vuelo_id, escala_id, categoria, monto, moneda, tc_gasto, propina, valor_ia_extraido, fecha_gasto',
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

  /** cliente.id → nombre (detalle.vuelos y detalle de vuelos del PDF/XLSX). */
  private async fetchClientes(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.service
      .from('cliente')
      .select('id, nombre')
      .in('id', ids);
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((c) => [c.id as string, c.nombre as string]),
    );
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

/** Número positivo o null (TCs y divisores; numeric de PostgREST llega string). */
function pos(v: unknown): number | null {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/** Día Cancún (YYYY-MM-DD) de un timestamptz; null si el vuelo no tiene fecha. */
function diaCancun(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Cancun' });
}

/**
 * Día (YYYY-MM-DD) de una columna `date` (fecha de pared: se respeta tal
 * cual — pasarla por `new Date` la interpretaría en UTC y en Cancún sería el
 * día ANTERIOR) o de un timestamptz (día Cancún).
 */
function diaDeFecha(fecha: string | null): string | null {
  if (!fecha) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  return diaCancun(fecha);
}

/**
 * ¿Algún cobro MXN sin TC propio y sin TC de cotización? Solo esos vuelos
 * piden el TC oficial del día (evita consultar días que nadie usaría).
 */
function cobrosNecesitanTc(cobros: CobroRow[], tcVuelo: unknown): boolean {
  if (pos(tcVuelo) != null) return false;
  return cobros.some(
    (c) =>
      c.moneda === 'MXN' && pos(c.tc_usd_mxn) == null && Number(c.monto) > 0,
  );
}
