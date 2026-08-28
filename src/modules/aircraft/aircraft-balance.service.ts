import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AircraftService } from './aircraft.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { desgloseGastoPartes } from '../../common/desglose-gasto.util';
import { fetchRepartos } from '../../common/gasto-reparto.util';
import {
  PyservicesService,
  type BalanceAvionCobroPayload,
  type BalanceAvionGastoFilaPayload,
  type BalanceAvionHojaGastosPayload,
  type BalanceAvionPayload,
  type BalanceAvionVueloPayload,
  type BalanceGeneralResumenFilaPayload,
  type BalanceHojaOtrosMovimientosPayload,
  type BalanceOtroMovimientoFilaPayload,
} from '../pyservices/pyservices.service';

/** Columnas del vuelo que consume el balance (nombres reales de la tabla). */
const VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, estado, tipo, es_externo, fecha_vuelo, fecha_solicitud, fecha_traslado_final, origen_iata, destino_iata, tiempo_cobrable_hr, tarifa_hora_usd, iva_usd, monto_total_usd, monto_total_mxn, tc_usd_mxn, comision_vendedor_usd, cobrado';

// Mapeo de categorías de gasto por vuelo (contrato del balance):
// GAS aparte (litros/$ x litro); PERMISO e INDIRECTO van a sus hojas propias.
// Regla del cliente (27 jul 2026, ajustada el mismo día): cada gasto va a su
// columna POR CATEGORÍA sin importar el medio de pago (un taxi en efectivo es
// PILOTO). OTROS = solo FBO + categoría OTRO (comisariatos, varios); mover
// algo más a OTROS es decisión manual (se recategoriza el gasto). REFACCION y
// FIJO van a OPERACIONES. GAS conserva SIEMPRE su columna (litros/precio).
// El medio EFECTIVO solo se señala como "(efectivo)" en la nota de la celda.
const CAT_PILOTO = new Set(['COMIDA', 'HOTEL', 'TAXI', 'PILOTO_EXTERNO']);
const CAT_OTROS = new Set(['FBO', 'OTRO']);
// Etiquetas humanas para el desglose en la nota de la celda.
const CAT_LABEL: Record<string, string> = {
  GAS: 'Gas',
  ATERRIZAJE: 'Aterrizaje',
  TUAS: 'TUAs',
  FBO: 'FBO',
  COMIDA: 'Comida',
  HOTEL: 'Hotel',
  TAXI: 'Taxi',
  REFACCION: 'Refacción',
  FIJO: 'Fijo',
  OTRO: 'Otro',
  OPERACIONES: 'Operaciones',
  PILOTO_EXTERNO: 'Piloto externo',
};

interface VueloRow {
  id: string;
  folio: number | null;
  cliente_id: string | null;
  aeronave_id: string | null;
  estado: string;
  tipo: string | null;
  es_externo: boolean | null;
  fecha_vuelo: string | null;
  /** Día de la cotización: base del TC oficial de respaldo (27-ago). */
  fecha_solicitud?: string | null;
  fecha_traslado_final: string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  tiempo_cobrable_hr: string | number | null;
  tarifa_hora_usd: string | number | null;
  iva_usd: string | number | null;
  monto_total_usd: string | number | null;
  monto_total_mxn: string | number | null;
  tc_usd_mxn: string | number | null;
  comision_vendedor_usd: string | number | null;
  cobrado: boolean | null;
}

interface EscalaRow {
  id: string;
  vuelo_id: string;
  orden: number;
  origen_iata: string | null;
  destino_iata: string | null;
  taco_salida: string | number | null;
  taco_llegada: string | number | null;
  aeronave_id: string | null;
  fecha_salida_plan: string | null;
  /** Observaciones del equipo sobre las lecturas (Tacómetros en vivo). */
  taco_salida_obs: string | null;
  taco_llegada_obs: string | null;
  taco_obs_updated_by: string | null;
  taco_obs_updated_at: string | null;
}

interface CobroRow {
  vuelo_id: string;
  monto: string | number | null;
  moneda: string | null;
  tc_usd_mxn: string | number | null;
  metodo_cobro: string | null;
  fecha_cobro: string | null;
}

interface GastoRow {
  id?: string;
  vuelo_id: string | null;
  /** Tramo del gasto (pre-provisión de pistas): su avión manda. */
  escala_id: string | null;
  /** Avión del gasto (herencia: null = el del vuelo). */
  aeronave_id: string | null;
  categoria: string;
  monto: string | number | null;
  propina: string | number | null;
  moneda: string | null;
  tc_gasto: string | number | null;
  litros: string | number | null;
  fecha_gasto: string | null;
  notas: string | null;
  medio_pago: string | null;
  proveedor: { nombre?: string } | { nombre?: string }[] | null;
  /** Lectura IA de la factura: conceptos para separar el TUA embebido. */
  valor_ia_extraido: {
    conceptos?: Array<{ concepto: string; monto: number }>;
  } | null;
  /** Clon parcial del reparto manual (gasto_reparto). */
  es_reparto_parcial?: boolean;
}

interface SocioRow {
  socio_id: string;
  porcentaje: string | number;
  vigente_desde: string;
  vigente_hasta: string | null;
  usuario: { nombre?: string } | { nombre?: string }[] | null;
}

/** Número finito o null (null se PROPAGA: nunca un 0 falso). */
function num(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** Número positivo o null (para TCs y divisores). */
function pos(v: unknown): number | null {
  const x = num(v);
  return x != null && x > 0 ? x : null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function r2(x: number | null): number | null {
  return x == null ? null : round2(x);
}

/** Día Cancún (YYYY-MM-DD) de un timestamptz. */
function diaCancun(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Cancun',
  }).format(d);
}

/**
 * Balance mensual POR AVIÓN: réplica sistematizada del Excel de control del
 * equipo ("Balance N990GG"). El API calcula TODO el dinero (fórmulas del
 * contrato, verificadas contra el libro original); pyservices solo pinta el
 * XLSX y el panel solo lo descarga.
 *
 * Reglas sagradas que respeta:
 *  - Cortes de periodo en hora Cancún (T00:00:00-05:00 / T23:59:59-05:00).
 *  - Horas de vuelo DERIVADAS de tacómetros (taco_llegada − taco_salida).
 *  - null se propaga (celda vacía): un monto sin TC JAMÁS se suma crudo ni se
 *    vuelve 0 en silencio — se lista en la hoja "pendientes de captura".
 */
@Injectable()
export class AircraftBalanceService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
    private readonly aircraft: AircraftService,
    private readonly tipoCambio: TipoCambioService,
  ) {}

  async xlsx(
    aircraftId: string,
    desde?: string,
    hasta?: string,
  ): Promise<{
    buffer: Buffer;
    matricula: string;
    desde: string;
    hasta: string;
  }> {
    const def = this.mesCorrienteCancun();
    const d = desde ?? def.desde;
    const h = hasta ?? def.hasta;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{4}-\d{2}-\d{2}$/.test(h)) {
      throw new BadRequestException('desde/hasta deben ser YYYY-MM-DD');
    }
    if (d > h) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const payload = await this.buildPayload(aircraftId, d, h);
    // Avisos de FLOTA también en el libro individual (verificación 26-ago):
    // una carga de combustible SIN avión podría ser de ESTE avión y aquí
    // resta cero veces sin señal — quien cierra con un solo libro debe verlo.
    payload.pendientes.unshift(...(await this.pendienteGasSinAvion(d, h)));
    const buffer = await this.pyservices.generateBalanceAvionXlsx(payload);
    return { buffer, matricula: payload.matricula, desde: d, hasta: h };
  }

  /**
   * Balance GENERAL de la flota (regla 18-ago, consolidado): hoja RESUMEN
   * al frente (una fila por avión = los TOTALES de su libro + fila TOTALES
   * de flota) y UN solo juego de hojas con los datos de TODOS los aviones
   * JUNTOS — reporte horas, combustible (mensual, 26-ago), gastos
   * indirectos, otros gastos (incluye TUAS), permisos, balance (bloques por
   * avión) y pendientes. Mismo motor y números que el individual; cero
   * cálculos paralelos. Vuelos multi-avión no se duplican en la suma:
   * horas/costos van al avión de cada tramo y la venta solo al principal.
   */
  async xlsxGeneral(
    desde?: string,
    hasta?: string,
  ): Promise<{ buffer: Buffer; desde: string; hasta: string }> {
    const def = this.mesCorrienteCancun();
    const d = desde ?? def.desde;
    const h = hasta ?? def.hasta;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{4}-\d{2}-\d{2}$/.test(h)) {
      throw new BadRequestException('desde/hasta deben ser YYYY-MM-DD');
    }
    if (d > h) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const { data: aviones, error } = await this.supabase.service
      .from('aeronave')
      .select('id, matricula, color_calendario')
      .order('matricula');
    if (error) throw new Error(error.message);

    const libros: BalanceAvionPayload[] = [];
    const resumen: BalanceGeneralResumenFilaPayload[] = [];
    const acc = {
      vuelos: 0,
      horas: 0,
      horasCobradas: 0,
      venta: 0,
      costo: 0,
      combustible: 0,
      comisiones: 0,
      ganancia: 0,
      cobrado: 0,
      porCobrar: 0,
      pendientes: 0,
    };
    for (const a of aviones ?? []) {
      const p = await this.buildPayload(a.id as string, d, h);
      const t = p.totales;
      // Aviones sin actividad en el periodo: fuera (ruido en el general).
      // "Actividad" incluye el dinero de las HOJAS (verificación 26-ago:
      // XB-ANU sin vuelos pero con gas y otros gastos quedaba FUERA del
      // general y sus pesos restaban CERO veces — el dinero jamás
      // desaparece en silencio). Filas sin monto MXN (USD sin TC) también
      // cuentan como actividad: hay algo que resolver.
      const hojaConDinero = (hoja: {
        filas: Array<{ monto_mxn: number | null }>;
        total_mxn: number;
      }) => hoja.total_mxn !== 0 || hoja.filas.some((f) => f.monto_mxn == null);
      const actividad =
        p.vuelos.length > 0 ||
        t.costo_total_mxn !== 0 ||
        (t.total_mxn ?? 0) !== 0 ||
        hojaConDinero(p.combustible ?? { filas: [], total_mxn: 0 }) ||
        hojaConDinero(p.gastos_indirectos) ||
        hojaConDinero(p.otros_gastos) ||
        hojaConDinero(p.permisos);
      if (!actividad) continue;
      // Color del avión (leyenda + filas teñidas — como la tabla "Color
      // calendario" del equipo; editable en el apartado del avión).
      p.avion_color = (a.color_calendario as string | null) ?? null;
      libros.push(p);
      // "Gasto de combustible" del mes: columna propia en el RESUMEN.
      // Identidad IMPRESA en la leyenda del Excel: VENTA − COSTO −
      // COMBUSTIBLE − COMISIONES = GANANCIA (la ganancia por fila ya neteaba
      // la comisión del vendedor; sin su columna el cruce descuadraba —
      // verificación 26-ago). Filas COMPARTIDO con costos rompen el cruce
      // (su Y suma a COSTO pero su ganancia es null): la leyenda lo dice.
      const combustibleMxn = p.combustible?.total_mxn ?? 0;
      const gananciaMxn =
        t.ganancia_mxn != null ? round2(t.ganancia_mxn - combustibleMxn) : null;
      resumen.push({
        matricula: p.matricula,
        color: p.avion_color,
        vuelos: p.vuelos.length,
        horas: t.tiempo_vuelo,
        horas_cobradas: t.horas_cobradas,
        venta_mxn: t.total_mxn,
        costo_mxn: t.costo_total_mxn,
        combustible_mxn: combustibleMxn,
        comisiones_mxn: t.comision_vendedor_mxn,
        ganancia_mxn: gananciaMxn,
        cobrado_mxn: t.cobrado_mxn,
        por_cobrar_mxn: t.por_cobrar_mxn,
        pendientes: p.pendientes.length,
      });
      acc.vuelos += p.vuelos.length;
      acc.horas += t.tiempo_vuelo ?? 0;
      acc.horasCobradas += t.horas_cobradas ?? 0;
      acc.venta += t.total_mxn ?? 0;
      acc.costo += t.costo_total_mxn ?? 0;
      acc.combustible += combustibleMxn;
      acc.comisiones += t.comision_vendedor_mxn ?? 0;
      acc.ganancia += gananciaMxn ?? 0;
      acc.cobrado += t.cobrado_mxn ?? 0;
      acc.porCobrar += t.por_cobrar_mxn ?? 0;
      acc.pendientes += p.pendientes.length;
    }
    // ===== CONSOLIDADO (regla del cliente, 18-ago): UN solo juego de hojas
    // con los datos de TODOS los aviones juntos. Cada fila viaja con el
    // color de su avión; las sumas son sumas de los totales por avión (los
    // dos campos de PROMEDIO son promedio simple de los no nulos — mismo
    // criterio que la nota al pie del libro individual).
    const sumT = (f: (t: BalanceAvionPayload['totales']) => number | null) =>
      round2(libros.reduce((s, p) => s + (f(p.totales) ?? 0), 0));
    const avgT = (f: (t: BalanceAvionPayload['totales']) => number | null) => {
      const vals = libros
        .map((p) => f(p.totales))
        .filter((x): x is number => x != null);
      return vals.length
        ? round2(vals.reduce((s, x) => s + x, 0) / vals.length)
        : null;
    };
    const totalesFlota: BalanceAvionPayload['totales'] = {
      horas_cobradas: sumT((t) => t.horas_cobradas),
      tiempo_vuelo: sumT((t) => t.tiempo_vuelo),
      total_mxn: sumT((t) => t.total_mxn),
      iva_mxn: sumT((t) => t.iva_mxn),
      subtotal_mxn: sumT((t) => t.subtotal_mxn),
      gas_mxn: sumT((t) => t.gas_mxn),
      gas_litros: sumT((t) => t.gas_litros),
      op_mxn: sumT((t) => t.op_mxn),
      piloto_mxn: sumT((t) => t.piloto_mxn),
      otros_mxn: sumT((t) => t.otros_mxn),
      permiso_afac_mxn: sumT((t) => t.permiso_afac_mxn),
      costo_total_mxn: sumT((t) => t.costo_total_mxn),
      remanente_mxn: sumT((t) => t.remanente_mxn),
      dif_iva_mxn: sumT((t) => t.dif_iva_mxn),
      comision_vendedor_mxn: sumT((t) => t.comision_vendedor_mxn),
      ganancia_mxn: sumT((t) => t.ganancia_mxn),
      ganancia_usd: sumT((t) => t.ganancia_usd),
      cobrado_mxn: sumT((t) => t.cobrado_mxn),
      por_cobrar_mxn: sumT((t) => t.por_cobrar_mxn),
      por_cobrar_usd: sumT((t) => t.por_cobrar_usd),
      tc_promedio: avgT((t) => t.tc_promedio),
      costo_hr_prom_usd: avgT((t) => t.costo_hr_prom_usd),
      otros_ingresos_usd: sumT((t) => t.otros_ingresos_usd),
    };
    const porFecha = (
      x: { fecha: string | null },
      y: { fecha: string | null },
    ) => String(x.fecha ?? '').localeCompare(String(y.fecha ?? ''));
    const hojaFlota = (
      pick: (
        p: BalanceAvionPayload,
      ) => BalanceAvionPayload['gastos_indirectos'],
    ): BalanceAvionPayload['gastos_indirectos'] => {
      const filas = libros
        .flatMap((p) =>
          pick(p).filas.map((f) => ({
            ...f,
            detalle: `${p.matricula} · ${f.detalle ?? ''}`,
            avion_color: p.avion_color ?? null,
          })),
        )
        .sort(porFecha);
      const totalMxn = round2(
        libros.reduce((s, p) => s + (pick(p).total_mxn ?? 0), 0),
      );
      const usd = round2(libros.reduce((s, p) => s + (pick(p).usd ?? 0), 0));
      const horas = totalesFlota.tiempo_vuelo;
      return {
        filas,
        total_mxn: totalMxn,
        usd,
        usd_hr: horas > 0 && usd !== 0 ? round2(usd / horas) : null,
      };
    };
    const consolidado: BalanceAvionPayload = {
      generado: new Date().toISOString(),
      matricula: 'FLOTA',
      modelo: null,
      avion_color: null,
      periodo_desde: d,
      periodo_hasta: h,
      permiso_afac_usd_hr: null,
      tc_promedio: totalesFlota.tc_promedio,
      horas_voladas_hr: totalesFlota.tiempo_vuelo,
      vuelos: libros
        .flatMap((p) =>
          p.vuelos.map((v) => ({ ...v, avion_color: p.avion_color ?? null })),
        )
        // Cronológico REAL entre aviones: orden_ts (salida planeada del
        // primer tramo del avión de la fila) desempata los días con varios
        // vuelos; fecha sola dejaba las filas en orden arbitrario y la
        // cadena de tacómetros parecía rota.
        .sort(
          (x, y) =>
            String(x.orden_ts ?? x.fecha ?? '').localeCompare(
              String(y.orden_ts ?? y.fecha ?? ''),
            ) || (Number(x.folio) || 0) - (Number(y.folio) || 0),
        ),
      totales: totalesFlota,
      gastos_indirectos: hojaFlota((p) => p.gastos_indirectos),
      otros_gastos: hojaFlota((p) => p.otros_gastos),
      permisos: hojaFlota((p) => p.permisos),
      // Hoja COMBUSTIBLE de flota: mismas filas por avión (con litros) +
      // totales de litros y $/L promedio del periodo.
      combustible: (() => {
        const vaciaCombustible = {
          filas: [],
          total_mxn: 0,
          usd: 0,
          usd_hr: null,
        };
        const base = hojaFlota((p) => p.combustible ?? vaciaCombustible);
        const litrosTotalFlota = round2(
          libros.reduce((s, p) => s + (p.combustible?.litros_total ?? 0), 0),
        );
        return {
          ...base,
          litros_total: litrosTotalFlota,
          precio_litro_prom:
            litrosTotalFlota > 0 && base.total_mxn > 0
              ? round2(base.total_mxn / litrosTotalFlota)
              : null,
        };
      })(),
      // La hoja "balance" del general se pinta por BLOQUES desde `aviones`
      // (los socios son por avión): este campo no se renderiza.
      balance: {
        utilidad_antes_usd: 0,
        combustible_usd: null,
        gastos_indirectos_usd: null,
        otros_usd: null,
        permisos_usd: null,
        utilidad_despues_usd: null,
        por_cobrar_usd: 0,
        utilidad_cobrada_usd: null,
        socios: [],
      },
      // Pestaña "Otros movimientos" (28-ago): conceptos cobrados vs pagados
      // por vuelo + dinero sin avión/sin vuelo. Solo en el GENERAL.
      otros_movimientos: await this.buildOtrosMovimientos(d, h),
      pendientes: [
        // Cargas de combustible SIN avión: no aparecen en NINGÚN balance ni
        // en el reparto — el dinero jamás desaparece en silencio.
        ...(await this.pendienteGasSinAvion(d, h)),
        // Gastos de vuelos EXTERNOS sin avión: tampoco aparecen en ningún
        // balance (el vuelo no vive en ningún libro) — decisión de dónde
        // colgarlos pendiente del cliente; mientras, se gritan aquí.
        ...(await this.pendienteExternosSinAvion(d, h)),
        ...libros.flatMap((p) =>
          p.pendientes.map((texto) => `${p.matricula}: ${texto}`),
        ),
      ],
    };

    const buffer = await this.pyservices.generateBalanceGeneralXlsx({
      generado: new Date().toISOString(),
      periodo_desde: d,
      periodo_hasta: h,
      resumen,
      resumen_totales: {
        matricula: 'TOTALES',
        color: null,
        vuelos: acc.vuelos,
        horas: round2(acc.horas),
        horas_cobradas: round2(acc.horasCobradas),
        venta_mxn: round2(acc.venta),
        costo_mxn: round2(acc.costo),
        combustible_mxn: round2(acc.combustible),
        comisiones_mxn: round2(acc.comisiones),
        ganancia_mxn: round2(acc.ganancia),
        cobrado_mxn: round2(acc.cobrado),
        por_cobrar_mxn: round2(acc.porCobrar),
        pendientes: acc.pendientes,
      },
      consolidado,
      aviones: libros,
    });
    return { buffer, desde: d, hasta: h };
  }

  /** Periodo default: mes corriente EN HORA CANCÚN (no UTC). */
  /**
   * Última llegada de tacómetro del avión ANTES del periodo (siembra de la
   * cadena de saltos): el horómetro solo sube, así que max(taco_llegada)
   * previa = la última cronológica — sin ordenar por columna embebida.
   * Misma herencia escala-primero que el resto del libro. null si no hay.
   */
  private async ultimaLlegadaAntesDe(
    aircraftId: string,
    desde: string,
  ): Promise<number | null> {
    const corte = `${desde}T00:00:00-05:00`;
    const sb = this.supabase.service;
    const [propias, heredadas] = await Promise.all([
      sb
        .from('escala')
        .select('taco_llegada, vuelo:vuelo_id!inner(fecha_vuelo)')
        .eq('aeronave_id', aircraftId)
        .is('cancelada_at', null)
        .not('taco_llegada', 'is', null)
        .lt('vuelo.fecha_vuelo', corte)
        .order('taco_llegada', { ascending: false })
        .limit(1),
      sb
        .from('escala')
        .select('taco_llegada, vuelo:vuelo_id!inner(fecha_vuelo, aeronave_id)')
        .is('aeronave_id', null)
        .eq('vuelo.aeronave_id', aircraftId)
        .is('cancelada_at', null)
        .not('taco_llegada', 'is', null)
        .lt('vuelo.fecha_vuelo', corte)
        .order('taco_llegada', { ascending: false })
        .limit(1),
    ]);
    // Best-effort: sin siembra la primera fila simplemente no se valida.
    if (propias.error || heredadas.error) return null;
    const candidatos = [...(propias.data ?? []), ...(heredadas.data ?? [])]
      .map((e) => Number((e as { taco_llegada: unknown }).taco_llegada))
      .filter((n) => Number.isFinite(n));
    return candidatos.length ? Math.max(...candidatos) : null;
  }

  private mesCorrienteCancun(): { desde: string; hasta: string } {
    const hoy = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Cancun',
    }).format(new Date()); // YYYY-MM-DD
    const [y, m] = [Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7))];
    const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      desde: `${hoy.slice(0, 7)}-01`,
      hasta: `${hoy.slice(0, 7)}-${String(ultimoDia).padStart(2, '0')}`,
    };
  }

  private async buildPayload(
    aircraftId: string,
    desde: string,
    hasta: string,
  ): Promise<BalanceAvionPayload> {
    const sb = this.supabase.service;

    const { data: avion, error: avionErr } = await sb
      .from('aeronave')
      .select(
        'id, matricula, modelo, permiso_afac_usd_hr, servicio_intervalos, servicio_horas_base',
      )
      .eq('id', aircraftId)
      .maybeSingle();
    if (avionErr) throw new Error(avionErr.message);
    if (!avion) throw new NotFoundException(`Aeronave ${aircraftId} not found`);

    // TODOS los estados, CANCELADO incluido: el Excel registra vuelos
    // cancelados con costos ya incurridos (se marcan por estado).
    const vuelosRes = await sb
      .from('vuelo')
      .select(VUELO_COLS)
      .eq('aeronave_id', aircraftId)
      .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`)
      .order('fecha_vuelo', { ascending: true });
    if (vuelosRes.error) throw new Error(vuelosRes.error.message);
    const vuelos = (vuelosRes.data ?? []) as VueloRow[];

    // VUELOS COMPARTIDOS (multi-avión, 17-ago-2026): tramos volados por ESTE
    // avión dentro de vuelos cuyo avión principal es OTRO. El vuelo aparece
    // en AMBOS balances — cada avión con SUS tramos, horas y gastos. La
    // VENTA completa se queda en el balance del avión principal (el
    // prorrateo del precio entre aviones es decisión pendiente del cliente)
    // y la fila compartida lo dice en la ruta.
    const idsPropios = new Set(vuelos.map((v) => v.id));
    const { data: escalasAjenas, error: eaErr } = await sb
      .from('escala')
      // !inner + filtro de fecha del vuelo: acotado al periodo desde la BD
      // (sin esto, el histórico completo del avión acabaría truncado por el
      // cap de 1000 filas de PostgREST y se perderían compartidos en silencio).
      .select('vuelo_id, vuelo:vuelo_id!inner(fecha_vuelo)')
      .eq('aeronave_id', aircraftId)
      .is('cancelada_at', null)
      .gte('vuelo.fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('vuelo.fecha_vuelo', `${hasta}T23:59:59-05:00`);
    if (eaErr) throw new Error(eaErr.message);
    const idsCompartidos = [
      ...new Set(
        (escalasAjenas ?? [])
          .map((e) => e.vuelo_id as string)
          .filter((id) => !idsPropios.has(id)),
      ),
    ];
    if (idsCompartidos.length) {
      const { data: compartidos, error: compErr } = await sb
        .from('vuelo')
        .select(VUELO_COLS)
        .in('id', idsCompartidos)
        .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
        .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`);
      if (compErr) throw new Error(compErr.message);
      vuelos.push(...((compartidos ?? []) as VueloRow[]));
      vuelos.sort((a, b) =>
        String(a.fecha_vuelo ?? '').localeCompare(String(b.fecha_vuelo ?? '')),
      );
    }
    const vueloIds = vuelos.map((v) => v.id);

    const vacio = { data: [], error: null } as const;
    const [
      escalasRes,
      cobrosRes,
      gastosVueloRes,
      gastosAvionRes,
      gastosGasRes,
      sociosRes,
    ] = await Promise.all([
      vueloIds.length
        ? sb
            .from('escala')
            .select(
              'id, vuelo_id, orden, origen_iata, destino_iata, taco_salida, taco_llegada, aeronave_id, fecha_salida_plan, taco_salida_obs, taco_llegada_obs, taco_obs_updated_by, taco_obs_updated_at',
            )
            .in('vuelo_id', vueloIds)
            // Tramos cancelados fuera: ni horas ni "pendiente de captura".
            .is('cancelada_at', null)
            .order('orden', { ascending: true })
        : Promise.resolve(vacio),
      vueloIds.length
        ? sb
            .from('cobro_vuelo')
            .select(
              'vuelo_id, monto, moneda, tc_usd_mxn, metodo_cobro, fecha_cobro',
            )
            .in('vuelo_id', vueloIds)
            .order('fecha_cobro', { ascending: true })
        : Promise.resolve(vacio),
      vueloIds.length
        ? sb
            .from('gasto')
            .select(
              'id, vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre)',
            )
            .in('vuelo_id', vueloIds)
            .order('fecha_gasto', { ascending: true })
        : Promise.resolve(vacio),
      // Gastos del avión SIN vuelo en el periodo (fecha_gasto es DATE:
      // comparación de días, sin componente horaria).
      sb
        .from('gasto')
        .select(
          'id, vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre)',
        )
        .eq('aeronave_id', aircraftId)
        .is('vuelo_id', null)
        .gte('fecha_gasto', desde)
        .lte('fecha_gasto', hasta)
        .order('fecha_gasto', { ascending: true }),
      // COMBUSTIBLE del avión en el MES (regla 26-ago-2026): el gas se
      // controla POR AVIÓN + fecha_gasto, con o sin vuelo — mismo eje y
      // mismo filtro CRUDO por aeronave_id que usa el reparto a socios
      // (profit-sharing), para que la hoja "combustible" y el reparto den
      // EXACTAMENTE el mismo dinero. Ya no se persigue la asignación por
      // vuelo (el vuelo_id del gasto queda informativo).
      sb
        .from('gasto')
        .select(
          'id, vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre)',
        )
        .eq('aeronave_id', aircraftId)
        .eq('categoria', 'GAS')
        .gte('fecha_gasto', desde)
        .lte('fecha_gasto', hasta)
        .order('fecha_gasto', { ascending: true }),
      sb
        .from('aeronave_socio')
        .select(
          'socio_id, porcentaje, vigente_desde, vigente_hasta, usuario:socio_id(nombre)',
        )
        .eq('aeronave_id', aircraftId),
    ]);
    // Un query fallido NO degrada a "sin datos": un balance sin cobros o sin
    // gastos de un mes real es una mentira numérica silenciosa.
    for (const [nombre, res] of [
      ['escalas', escalasRes],
      ['cobros', cobrosRes],
      ['gastos de vuelos', gastosVueloRes],
      ['gastos del avión', gastosAvionRes],
      ['combustible', gastosGasRes],
      ['socios', sociosRes],
    ] as const) {
      if (res.error) {
        throw new Error(
          `Balance ${avion.matricula as string}: fallo al leer ${nombre}: ${res.error.message}`,
        );
      }
    }

    const escalas = (escalasRes.data ?? []) as unknown as EscalaRow[];
    // Autores de las observaciones de taco (una sola consulta de nombres).
    const obsAutores = new Map<string, string>();
    {
      const ids = [
        ...new Set(
          escalas
            .map((e) => e.taco_obs_updated_by)
            .filter((x): x is string => !!x),
        ),
      ];
      if (ids.length > 0) {
        const { data: usuarios } = await sb
          .from('usuario')
          .select('id, nombre')
          .in('id', ids);
        for (const u of usuarios ?? []) {
          obsAutores.set(u.id as string, (u.nombre as string) ?? 'equipo');
        }
      }
    }
    const cobros = (cobrosRes.data ?? []) as unknown as CobroRow[];
    const gastosVuelo = (gastosVueloRes.data ?? []) as unknown as GastoRow[];
    const gastosAvionCrudos = (gastosAvionRes.data ??
      []) as unknown as GastoRow[];
    const gastosGas = (gastosGasRes.data ?? []) as unknown as GastoRow[];

    // ===== REPARTO MANUAL (gasto_reparto, 26-ago-2026) =====
    // Regla única (misma que el reparto a socios): el reparto GANA sobre
    // aeronave_id. (1) Un gasto de ESTE avión que fue repartido se EXCLUYE
    // (sus parciales mandan); (2) los PARCIALES hacia este avión entran como
    // filas sintéticas con el monto parcial y la moneda/TC del padre — un
    // gasto SIN avión repartido hacia acá no entraba con el filtro crudo.
    // El remanente no se carga a nadie (gasto de la EMPRESA VuelaTour).
    const repartosHaciaAvionRes = await sb
      .from('gasto_reparto')
      .select(
        'aeronave_id, monto, gasto:gasto_id!inner(id, vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre))',
      )
      .eq('aeronave_id', aircraftId)
      .is('gasto.vuelo_id', null)
      .gte('gasto.fecha_gasto', desde)
      .lte('gasto.fecha_gasto', hasta);
    if (repartosHaciaAvionRes.error) {
      throw new Error(
        `Balance ${avion.matricula as string}: fallo al leer repartos: ${repartosHaciaAvionRes.error.message}`,
      );
    }
    const repartidosIds = await fetchRepartos(
      sb,
      gastosAvionCrudos.map((g) => g.id ?? '').filter(Boolean),
    );
    const parcialesAvion: GastoRow[] = (
      (repartosHaciaAvionRes.data ?? []) as Array<Record<string, unknown>>
    ).map((r) => {
      const padre = (Array.isArray(r.gasto)
        ? r.gasto[0]
        : r.gasto) as unknown as GastoRow;
      const nota = (padre.notas ?? '').split('\n')[0].trim();
      return {
        ...padre,
        aeronave_id: aircraftId,
        monto: Number(r.monto),
        notas: [
          nota || null,
          `reparto manual: $${Number(r.monto).toLocaleString('es-MX', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} de $${Number(padre.monto).toLocaleString('es-MX', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} ${padre.moneda ?? 'MXN'}`,
        ]
          .filter(Boolean)
          .join(' · '),
        es_reparto_parcial: true,
      };
    });
    const gastosAvion: GastoRow[] = [
      ...gastosAvionCrudos.filter((g) => !g.id || !repartidosIds.has(g.id)),
      ...parcialesAvion,
    ];
    const sociosAll = (sociosRes.data ?? []) as unknown as SocioRow[];

    // Nombres de clientes (columna CLAVE del Excel) + bandera de cliente
    // INTERNO (reposicionamiento/demostración/servicio): venta $0 esperada,
    // sin regaños de cobranza — la fila sí se queda (costos reales del avión).
    const clienteIds = [
      ...new Set(vuelos.map((v) => v.cliente_id).filter(Boolean)),
    ] as string[];
    const clientePorId = new Map<string, string>();
    const clientesInternos = new Set<string>();
    if (clienteIds.length) {
      const { data: cls, error: clsErr } = await sb
        .from('cliente')
        .select('id, nombre, es_interno')
        .in('id', clienteIds);
      if (clsErr) throw new Error(clsErr.message);
      for (const c of cls ?? []) {
        clientePorId.set(c.id as string, c.nombre as string);
        if (c.es_interno === true) clientesInternos.add(c.id as string);
      }
    }

    const escalasPorVuelo = new Map<string, EscalaRow[]>();
    for (const e of escalas) {
      const list = escalasPorVuelo.get(e.vuelo_id) ?? [];
      list.push(e);
      escalasPorVuelo.set(e.vuelo_id, list);
    }

    // Orden CRONOLÓGICO de las filas (caso #136/#105/#138, 18-ago-2026): con
    // varios vuelos el mismo día, fecha_vuelo trae la hora del tramo 1 del
    // VUELO — en una fila COMPARTIDA esa es la hora del OTRO avión y la
    // cadena de tacómetros sale desordenada. La fila se ordena por la salida
    // PLANEADA más temprana de los tramos de ESTE avión (herencia incluida);
    // sin tramos propios con plan cae a fecha_vuelo, y el folio desempata.
    const ordenTsPorVuelo = new Map<string, number>();
    for (const v of vuelos) {
      const planes = (escalasPorVuelo.get(v.id) ?? [])
        .filter((e) => (e.aeronave_id ?? v.aeronave_id) === aircraftId)
        .map((e) => Date.parse(e.fecha_salida_plan ?? ''))
        .filter((t) => Number.isFinite(t));
      const respaldo = Date.parse(v.fecha_vuelo ?? '');
      ordenTsPorVuelo.set(
        v.id,
        planes.length
          ? Math.min(...planes)
          : Number.isFinite(respaldo)
            ? respaldo
            : 0,
      );
    }
    vuelos.sort(
      (a, b) =>
        (ordenTsPorVuelo.get(a.id) ?? 0) - (ordenTsPorVuelo.get(b.id) ?? 0) ||
        (a.folio ?? 0) - (b.folio ?? 0),
    );

    // Matrículas para los avisos de vuelos multi-avión (fila compartida y
    // "tramos también en X").
    const matriculaPorAvion = new Map<string, string>([
      [aircraftId, avion.matricula as string],
    ]);
    const otrosAvionIds = [
      ...new Set([
        ...vuelos.map((v) => v.aeronave_id),
        ...escalas.map((e) => e.aeronave_id),
      ]),
    ].filter((id): id is string => id != null && !matriculaPorAvion.has(id));
    if (otrosAvionIds.length) {
      const { data: avs, error: avsErr } = await sb
        .from('aeronave')
        .select('id, matricula')
        .in('id', otrosAvionIds);
      if (avsErr) throw new Error(avsErr.message);
      for (const a of avs ?? [])
        matriculaPorAvion.set(a.id as string, a.matricula as string);
    }
    const cobrosPorVuelo = new Map<string, CobroRow[]>();
    for (const c of cobros) {
      const list = cobrosPorVuelo.get(c.vuelo_id) ?? [];
      list.push(c);
      cobrosPorVuelo.set(c.vuelo_id, list);
    }
    const gastosPorVuelo = new Map<string, GastoRow[]>();
    for (const g of gastosVuelo) {
      if (!g.vuelo_id) continue;
      const list = gastosPorVuelo.get(g.vuelo_id) ?? [];
      list.push(g);
      gastosPorVuelo.set(g.vuelo_id, list);
    }

    // ===== PASO 0: TC OFICIAL de respaldo (pedido 27-ago) =====
    // Vuelo sin TC capturado en la cotización: se usa el oficial (Banxico
    // FIX = DOF) del día de la COTIZACIÓN (fecha_solicitud; si no, el del
    // vuelo). La fila queda MARCADA (tc_venta_oficial) y el Excel la pinta.
    const tcOficialPorVuelo = new Map<string, number>();
    for (const v of vuelos) {
      if (pos(v.tc_usd_mxn) != null) continue;
      const dia = diaCancun(v.fecha_solicitud ?? v.fecha_vuelo);
      if (!dia) continue;
      const tc = await this.tipoCambio.oficialPara(dia);
      if (tc != null) tcOficialPorVuelo.set(v.id, tc);
    }

    // ===== PASO 1: TC de costos (Z) por vuelo =====
    // Promedio simple de tc_gasto de los gastos MXN del vuelo con TC (el TC
    // del día realmente registrado); fallback el TC de venta (K); sino null.
    const zPorVuelo = new Map<string, number | null>();
    for (const v of vuelos) {
      const tcs = (gastosPorVuelo.get(v.id) ?? [])
        .filter((g) => g.moneda === 'MXN')
        .map((g) => pos(g.tc_gasto))
        .filter((x): x is number => x != null);
      const z = tcs.length
        ? tcs.reduce((a, b) => a + b, 0) / tcs.length
        : (pos(v.tc_usd_mxn) ?? tcOficialPorVuelo.get(v.id) ?? null);
      zPorVuelo.set(v.id, z);
    }
    const zs = [...zPorVuelo.values()].filter((z): z is number => z != null);
    const tcPromedio = zs.length
      ? zs.reduce((a, b) => a + b, 0) / zs.length
      : null;

    const permisoAfacUsdHr = pos(avion.permiso_afac_usd_hr);
    const pendientes: string[] = [];
    const fmtDia = new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Cancun',
      day: '2-digit',
      month: 'short',
    });

    // ===== PASO 2: fila por vuelo =====
    const filasVuelo: BalanceAvionVueloPayload[] = [];
    const anValues: number[] = []; // costo hr USD (AN) para el promedio
    // TUAs/extras/pernocta cobrados al cliente: desde el 7-ago YA van
    // DENTRO del total de cada fila (desglose completo de la cotización);
    // este acumulado del pie es INFORMATIVO (no se traslada a ningún lado).
    let otrosIngresosPeriodoUsd = 0;
    // Partes TUA EMBEBIDAS en facturas (desglose IA): regla del cliente
    // (26-ago-2026) — los TUAS van a la hoja "otros gastos" del balance.
    // La parte ya viene convertida a MXN con el MISMO factor del gasto
    // (cierra por diferencia contra las partes de OPERACIONES/OTROS: nada
    // se cuenta doble ni se pierde). Se acumulan aquí y se funden a la hoja.
    const tuaEmbebidoFilas: Array<{
      fecha: string | null;
      detalle: string;
      monto_mxn: number | null;
      moneda_original: string | null;
      monto_original: number | null;
    }> = [];
    for (const v of vuelos) {
      const vEscalas = escalasPorVuelo.get(v.id) ?? [];
      // Fila COMPARTIDA: este avión solo voló algunos tramos; la venta y sus
      // cobros viven en el balance del avión principal.
      const esCompartido = v.aeronave_id !== aircraftId;
      const vCobros = esCompartido ? [] : (cobrosPorVuelo.get(v.id) ?? []);
      // Gastos del avión del TRAMO: en vuelos multi-avión cada balance carga
      // SOLO los gastos de su avión. Resolución (prioridad): avión de la
      // ESCALA del gasto (los flujos de captura suelen sellar el avión
      // PRINCIPAL aunque el gasto sea del tramo del otro — la escala no
      // miente) → gasto.aeronave_id → avión del vuelo.
      const escalaPorId = new Map(vEscalas.map((e) => [e.id, e]));
      const avionDelGasto = (g: GastoRow): string | null => {
        const esc = g.escala_id ? escalaPorId.get(g.escala_id) : undefined;
        return (
          (esc ? (esc.aeronave_id ?? v.aeronave_id) : null) ??
          g.aeronave_id ??
          v.aeronave_id
        );
      };
      const vGastos = (gastosPorVuelo.get(v.id) ?? []).filter(
        (g) => avionDelGasto(g) === aircraftId,
      );
      const z = zPorVuelo.get(v.id) ?? null;
      const esExterno = v.es_externo === true;

      // Ruta operativa: concatenación de escalas; fallback origen→destino.
      const codigos = vEscalas.length
        ? [
            vEscalas[0].origen_iata ?? '?',
            ...vEscalas.map((e) => e.destino_iata ?? '?'),
          ]
        : [v.origen_iata ?? '?', v.destino_iata ?? '?'];
      // Aviso multi-avión en la RUTA: la fila compartida dice dónde vive la
      // venta; la fila principal avisa qué tramos volaron en otro avión.
      const otrasMatriculas = [
        ...new Set(
          vEscalas
            .map((e) => e.aeronave_id)
            .filter((id): id is string => id != null && id !== aircraftId),
        ),
      ].map((id) => matriculaPorAvion.get(id) ?? '¿?');
      const rutaBase = codigos.join('-');
      const ruta = esCompartido
        ? `${rutaBase} · COMPARTIDO (venta en ${
            matriculaPorAvion.get(v.aeronave_id ?? '') ?? 'el avión principal'
          })`
        : otrasMatriculas.length
          ? `${rutaBase} · tramos también en ${otrasMatriculas.join(', ')}`
          : rutaBase;
      const folio = v.folio != null ? String(v.folio) : v.id.slice(0, 8);
      const etiqueta = `Vuelo #${folio} (${
        v.fecha_vuelo
          ? fmtDia.format(new Date(v.fecha_vuelo)).replace(/\s+/g, '-')
          : 'sin fecha'
      } ${ruta})`;

      // ----- Bloque VENTA -----
      // REGLA DEL LIBRO (7-ago, reporte del cliente vuelo #11): el TOTAL de
      // la fila es el DESGLOSE COMPLETO de la cotización (tiempo + TUAs +
      // extras + pernocta + ajustes, con su IVA) — cuadra contra los cobros.
      // La venta por horas (D×H) queda como columna informativa; el
      // acumulado de TUAs/extras del pie es solo informativo.
      // Fila compartida: la VENTA completa va en el balance del principal —
      // aquí todo el bloque venta queda vacío (no repartir es a propósito:
      // el prorrateo del precio es decisión pendiente del cliente).
      const D = esCompartido ? 0 : (num(v.tiempo_cobrable_hr) ?? 0); // horas cobradas
      const E = esCompartido ? null : num(v.tarifa_hora_usd);
      const totalSistemaUsd = esCompartido ? null : num(v.monto_total_usd);
      const ivaSistemaUsd = esCompartido ? null : num(v.iva_usd);
      // Con/sin IVA por vuelo (columna G del libro): si la cotización lleva
      // IVA, G = E×0.16; si no (sin factura), 0.
      const conIva = (ivaSistemaUsd ?? 0) > 0;
      const G = E != null ? (conIva ? round2(E * 0.16) : 0) : null;
      const H = E != null ? round2(E + (G ?? 0)) : null;
      // Venta por horas (informativa) — el libro original la usaba como la
      // fila entera, pero dejaba fuera TUAs/extras/ajustes.
      const ventaHorasUsd = H != null && D > 0 ? round2(D * H) : null;
      // TOTAL COBRADO AL CLIENTE = el DESGLOSE COMPLETO de la cotización
      // (tiempo + TUAs + extras + pernocta + ajustes + IVA). Reporte del
      // cliente 7 ago 2026 (vuelo #11): la fila decía 28,415.70 MXN cuando el
      // cobro real fue 30,315.85 — faltaban los TUAs y el ajuste, y "por
      // cobrar" quedaba negativo. Sin cotización, respaldo = horas × tarifa.
      const I =
        totalSistemaUsd != null && totalSistemaUsd !== 0
          ? round2(totalSistemaUsd)
          : ventaHorasUsd;
      const J =
        ivaSistemaUsd != null
          ? round2(ivaSistemaUsd)
          : G != null && D > 0
            ? round2(D * G)
            : null;
      const kCapturado = pos(v.tc_usd_mxn);
      const K = kCapturado ?? tcOficialPorVuelo.get(v.id) ?? null;
      const kOficial = kCapturado == null && K != null;
      const L = I != null && K != null ? round2(I * K) : null;
      const M = J != null && K != null ? round2(J * K) : null;
      const N = L != null ? round2(L - (M ?? 0)) : null;
      // TUAs/extras/pernocta/ajustes del periodo (total − venta por horas):
      // ahora es INFORMATIVO — ya están dentro de las filas, no se traslada.
      const otrosIngresosUsd =
        totalSistemaUsd != null && (ventaHorasUsd != null || D === 0)
          ? round2(totalSistemaUsd - (ventaHorasUsd ?? 0))
          : null;
      if (otrosIngresosUsd != null) otrosIngresosPeriodoUsd += otrosIngresosUsd;

      // ----- Bloque TIEMPO/TACO (derivado de tacómetros, fuente única) -----
      // Solo tramos volados en ESTE avión: con asignación por tramo, un tramo
      // en otro avión tiene tacómetro propio y mezclaría lecturas.
      // Herencia del avión del tramo (escala.aeronave_id ?? vuelo.aeronave_id):
      // en la fila del principal, los tramos sin avión propio son suyos; en la
      // fila COMPARTIDA solo cuentan los tramos explícitamente de este avión.
      // Observaciones del equipo sobre las lecturas de los tramos de ESTE
      // avión: van a las celdas TACO INICIO (salidas) y TACO FINAL
      // (llegadas) del Excel — ámbar + nota con quién y cuándo.
      const obsLinea = (e: EscalaRow, lado: 'salida' | 'llegada'): string => {
        const texto =
          lado === 'salida' ? e.taco_salida_obs : e.taco_llegada_obs;
        const autor = e.taco_obs_updated_by
          ? (obsAutores.get(e.taco_obs_updated_by) ?? 'equipo')
          : 'equipo';
        const fechaObs = diaCancun(e.taco_obs_updated_at);
        return `${e.origen_iata ?? '?'}→${e.destino_iata ?? '?'} ${lado}: ${
          texto ?? ''
        } — ${autor}${fechaObs ? `, ${fechaObs}` : ''}`;
      };
      const escalasDelAvion = vEscalas.filter(
        (e) => (e.aeronave_id ?? v.aeronave_id) === aircraftId,
      );
      let horas: number | null = null;
      for (const e of escalasDelAvion) {
        const s = num(e.taco_salida);
        const l = num(e.taco_llegada);
        if (s == null || l == null) continue;
        const h = l - s;
        if (h <= 0) continue;
        horas = (horas ?? 0) + h;
      }
      const O = r2(horas);
      const salidas = escalasDelAvion
        .map((e) => num(e.taco_salida))
        .filter((x): x is number => x != null);
      const llegadas = escalasDelAvion
        .map((e) => num(e.taco_llegada))
        .filter((x): x is number => x != null);
      const P = salidas.length ? salidas[0] : null;
      const Q = llegadas.length ? llegadas[llegadas.length - 1] : null;
      // Salto INTERNO: la salida de un tramo no empalma con la llegada del
      // tramo anterior DEL MISMO vuelo (el error de captura más común — un
      // dígito mal tecleado infla las horas facturadas y P/Q siguen
      // empalmando con los vuelos vecinos, así que la cadena no lo ve).
      let saltoInterno: string | null = null;
      for (let i = 1; i < escalasDelAvion.length; i++) {
        const sal = num(escalasDelAvion[i].taco_salida);
        const lleg = num(escalasDelAvion[i - 1].taco_llegada);
        if (sal == null || lleg == null) continue;
        if (Math.abs(sal - lleg) > 0.004) {
          const e = escalasDelAvion[i];
          saltoInterno = `${(e.origen_iata as string) ?? '?'}→${(e.destino_iata as string) ?? '?'}: salida ${sal} vs llegada previa ${lleg}`;
          break;
        }
      }

      // ----- Bloque COSTOS (MXN) -----
      // Conversión de un gasto USD a MXN: tc_gasto ?? Z del vuelo ?? TC
      // promedio del periodo. Sin ningún TC → null (pendiente), JAMÁS crudo.
      const gastoMxn = (g: GastoRow): number | null => {
        const monto = num(g.monto) ?? 0;
        if (g.moneda === 'MXN') return monto;
        const tc = pos(g.tc_gasto) ?? z ?? tcPromedio;
        return tc != null ? monto * tc : null;
      };
      let opMxn: number | null = null;
      let pilotoMxn: number | null = null;
      let otrosMxn: number | null = null;
      let usdSinTc = 0;
      let usdSinTcMonto = 0;
      // Desglose por celda (nota de Excel): una línea por gasto, con la
      // categoría, el proveedor/nota y el monto — "Comida · Starbucks — $206.00".
      const opDetalle: string[] = [];
      const pilotoDetalle: string[] = [];
      const otrosDetalle: string[] = [];
      const fmtMonto = (n: number) =>
        round2(n).toLocaleString('es-MX', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      const lineaDetalle = (
        g: GastoRow,
        mxn: number,
        sufijo = '',
        montoTexto?: string,
      ): string => {
        const prov = Array.isArray(g.proveedor)
          ? g.proveedor[0]?.nombre
          : g.proveedor?.nombre;
        // Solo la primera línea de la nota, recortada: la nota de celda es un
        // vistazo, no el expediente (ese vive en Gastos).
        const nota = (g.notas ?? '').split('\n')[0].trim().slice(0, 60);
        const etiqueta = [
          `${CAT_LABEL[g.categoria] ?? g.categoria}${sufijo}`,
          prov || null,
          nota || null,
        ]
          .filter(Boolean)
          .join(' · ');
        return `${etiqueta} — ${montoTexto ?? `$${fmtMonto(mxn)}`}`;
      };
      for (const g of vGastos) {
        // PERMISO va a su hoja (con o sin vuelo) y se excluye del costo del
        // vuelo para no contar doble; INDIRECTO no es costo directo.
        // GAS (26-ago-2026): el combustible dejó de ser costo POR VUELO — se
        // controla por avión/mes en su propia hoja "combustible" y resta UNA
        // sola vez en la cascada del balance (como indirectos/otros/permisos).
        if (
          g.categoria === 'PERMISO' ||
          g.categoria === 'INDIRECTO' ||
          g.categoria === 'GAS'
        )
          continue;
        if (g.categoria === 'TUAS') {
          // REGLA DEL CLIENTE (26-ago-2026): los TUAS van a la hoja "OTROS
          // GASTOS" del balance (antes, 17-ago, solo quedaban de nota y no
          // restaban en ningún lado — pero la VENTA de la fila sí incluye
          // los TUAs cobrados al cliente, así que la utilidad se inflaba).
          // No entra a las columnas de costo del vuelo (no es costo de
          // operar el avión); resta UNA vez vía la hoja. La nota de la celda
          // se conserva como vistazo.
          const mxnTua = gastoMxn(g);
          const sufijoTua = g.medio_pago === 'EFECTIVO' ? ' (efectivo)' : '';
          opDetalle.push(
            lineaDetalle(
              g,
              mxnTua ?? 0,
              sufijoTua,
              // Mismo vocabulario que el desglose de las notas del gasto;
              // la regla "va en OTROS GASTOS" vive en el pie ** de la hoja
              // (leyendas distintas parecían texto inventado — 24-ago).
              mxnTua != null
                ? `TUA $${fmtMonto(mxnTua)}**`
                : `TUA $${fmtMonto(num(g.monto) ?? 0)} ${g.moneda ?? 'USD'} sin TC**`,
            ),
          );
          // La fila de la hoja "otros gastos" nace AQUÍ, pre-convertida con
          // el MISMO monto de la nota (misma cadena de TC: tc_gasto ?? z ??
          // tcPromedio) y la MISMA atribución de avión (avionDelGasto,
          // escala-primero) — una sola regla para nota y resta; dos rutas
          // divergían por avión y por TC (verificación 26-ago).
          {
            const provNombre = Array.isArray(g.proveedor)
              ? g.proveedor[0]?.nombre
              : g.proveedor?.nombre;
            tuaEmbebidoFilas.push({
              fecha: g.fecha_gasto ?? null,
              detalle: [
                'TUA',
                provNombre || null,
                `vuelo #${folio}`,
                g.notas?.split('\n')[0]?.trim() || null,
              ]
                .filter(Boolean)
                .join(' · '),
              monto_mxn: mxnTua,
              moneda_original: g.moneda !== 'MXN' ? (g.moneda ?? null) : null,
              monto_original:
                g.moneda !== 'MXN' ? round2(num(g.monto) ?? 0) : null,
            });
            if (mxnTua == null) {
              pendientes.push(
                `Hoja "otros gastos" (${g.fecha_gasto ?? 'sin fecha'}): TUA en ${
                  g.moneda ?? 'USD'
                } por $${(num(g.monto) ?? 0).toLocaleString('en-US')} sin ningún TC — fila sin monto MXN`,
              );
            }
          }
          continue;
        }
        const mxn = gastoMxn(g);
        if (mxn == null) {
          usdSinTc += 1;
          usdSinTcMonto += num(g.monto) ?? 0;
          continue;
        }
        // "(efectivo)" en la nota es informativo: NO cambia la columna.
        const sufijo = g.medio_pago === 'EFECTIVO' ? ' (efectivo)' : '';
        // Partes TUA/FBO EMBEBIDAS en la factura (leídas por IA — caso ASUR
        // "aterrizaje, pernocta, TUA, plataforma, servicio FBO"): el desglose
        // MANDA sobre la categoría que eligió el capturista. Regla del libro
        // manual (TUA 17-ago-2026, FBO 18-ago-2026): a OPERACIONES va SOLO la
        // operación, el FBO se separa a la columna OTROS (SÍ es costo — ej.
        // factura $154.14 = Op $67.14 + FBO $87.00) y el TUA no suma a ningún
        // costo (traslado al pasajero); la nota lleva las partes POR SEPARADO.
        // Nunca aplica a GAS/PILOTO.
        const separarPartes = (): {
          opParte: number;
          tuaParte: number;
          fboParte: number;
        } | null => {
          const montoNativo = num(g.monto) ?? 0;
          if (montoNativo <= 0) return null;
          const partes = desgloseGastoPartes(
            g.valor_ia_extraido?.conceptos ?? [],
            round2(montoNativo - (num(g.propina) ?? 0)),
          );
          if (!partes || (partes.tua <= 0 && partes.fbo <= 0)) return null;
          // Conversión proporcional a MXN con el MISMO factor del gasto; la
          // operación cierra por diferencia para que las partes SUMEN el
          // gasto exacto (fiabilidad numérica del libro).
          const tuaParte = round2((partes.tua * mxn) / montoNativo);
          const fboParte = round2((partes.fbo * mxn) / montoNativo);
          const opParte = round2(mxn - tuaParte - fboParte);
          if (opParte < 0) return null; // no cuadra: mejor no separar
          return { opParte, tuaParte, fboParte };
        };
        if (CAT_PILOTO.has(g.categoria)) {
          pilotoMxn = (pilotoMxn ?? 0) + mxn;
          pilotoDetalle.push(lineaDetalle(g, mxn, sufijo));
        } else {
          // OPERACIONES, ATERRIZAJE, REFACCION, FIJO, FBO, OTRO y cualquier
          // categoría futura no mapeada. Con desglose IA reconocible la
          // factura se REPARTE entre columnas (op → OPERACIONES, FBO →
          // OTROS, TUA → solo nota); sin desglose, la categoría decide la
          // columna completa como siempre.
          const sep = separarPartes();
          if (sep) {
            // Espejo EXACTO del desglose impreso en las notas del gasto
            // (Operación / TUA (IVA incluido)): leyendas distintas hacían
            // dudar de la fuente. La regla del TUA vive en el pie **.
            const trozos = [
              sep.opParte > 0 ? `Operación $${fmtMonto(sep.opParte)}` : null,
              sep.fboParte > 0
                ? `FBO $${fmtMonto(sep.fboParte)} (en OTROS)`
                : null,
              sep.tuaParte > 0
                ? `TUA (IVA incluido) $${fmtMonto(sep.tuaParte)}**`
                : null,
            ]
              .filter(Boolean)
              .join(' · ');
            // Regla 26-ago-2026: la parte TUA embebida va a la hoja "otros
            // gastos" (resta UNA vez ahí); las partes de operación/FBO se
            // quedan en las columnas del vuelo — nada se cuenta doble.
            if (sep.tuaParte > 0) {
              const provNombre = Array.isArray(g.proveedor)
                ? g.proveedor[0]?.nombre
                : g.proveedor?.nombre;
              tuaEmbebidoFilas.push({
                fecha: g.fecha_gasto ?? null,
                detalle: [
                  'TUA (IVA incluido)',
                  provNombre || null,
                  `vuelo #${folio}`,
                ]
                  .filter(Boolean)
                  .join(' · '),
                monto_mxn: sep.tuaParte,
                moneda_original: null,
                monto_original: null,
              });
            }
            if (sep.opParte > 0) {
              opMxn = (opMxn ?? 0) + sep.opParte;
              opDetalle.push(lineaDetalle(g, mxn, sufijo, trozos));
            }
            if (sep.fboParte > 0) {
              otrosMxn = (otrosMxn ?? 0) + sep.fboParte;
              otrosDetalle.push(
                lineaDetalle(
                  g,
                  sep.fboParte,
                  sufijo,
                  [
                    sep.opParte > 0
                      ? `FBO $${fmtMonto(sep.fboParte)} (la operación va en OPERACIONES)`
                      : `FBO $${fmtMonto(sep.fboParte)}`,
                    sep.opParte <= 0 && sep.tuaParte > 0
                      ? `TUA (IVA incluido) $${fmtMonto(sep.tuaParte)}**`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
              );
            }
            // Factura que quedó SOLO en TUA (op y FBO en cero): no toca
            // columnas, pero el dinero no desaparece del vistazo.
            if (sep.opParte <= 0 && sep.fboParte <= 0) {
              opDetalle.push(lineaDetalle(g, mxn, sufijo, trozos));
            }
          } else if (CAT_OTROS.has(g.categoria)) {
            // OTROS = solo FBO + categoría OTRO (comisariatos, varios).
            otrosMxn = (otrosMxn ?? 0) + mxn;
            otrosDetalle.push(lineaDetalle(g, mxn, sufijo));
          } else {
            opMxn = (opMxn ?? 0) + mxn;
            opDetalle.push(lineaDetalle(g, mxn, sufijo));
          }
        }
      }
      // Provisión AFAC (X) = tarifa USD/hr × TC de costos × horas COBRADAS —
      // solo si el avión tiene la config Y hay TC Y hay horas cobradas.
      const X =
        permisoAfacUsdHr != null && z != null && D > 0
          ? round2(permisoAfacUsdHr * z * D)
          : null;
      // Y sin combustible (26-ago-2026): el gas resta en su hoja mensual.
      const Y = round2(
        (opMxn ?? 0) + (pilotoMxn ?? 0) + (otrosMxn ?? 0) + (X ?? 0),
      );

      // ----- Bloque INDICADORES USD e IVA -----
      const AE = z != null ? Y / z : null;
      const AF = AE != null ? AE / 1.16 : null;
      const AG = AE != null && AF != null ? AE - AF : null;
      const AH = AG != null && z != null ? AG * z : null;
      // Fila compartida: sin venta aquí, remanente/ganancia serían "−costos"
      // y se leerían como pérdida falsa — van vacíos (los costos sí suman).
      const AI = esCompartido ? null : round2((L ?? 0) - Y);
      const AJ = esCompartido ? null : round2((M ?? 0) - (AH ?? 0));
      // Comisión del vendedor: vuelo.comision_vendedor_usd. Regla jul 2026:
      // va SUMADA al precio del cliente — el ingreso que la cubre viaja en
      // otros_ingresos (total sistema − venta por horas, al pie); aquí solo
      // se descuenta el PAGO al vendedor de la fila. A MXN con el TC de
      // venta (K); sin K queda pendiente.
      const comUsd = pos(v.comision_vendedor_usd);
      const AK = comUsd != null && K != null ? round2(comUsd * K) : null;
      if (comUsd != null && K == null) {
        pendientes.push(
          `${etiqueta}: comisión de vendedor en USD sin TC de venta — no entra al balance MXN`,
        );
      }
      const AL = AI != null ? round2(AI - (AK ?? 0)) : null;
      // Ganancia USD con respaldo de TC (verificación 26-ago): un vuelo sin
      // z (traslado sin cotizar con gastos MXN) aportaba su AL a
      // ganancia_mxn pero desaparecía de ganancia_usd — la utilidad USD de
      // la cascada (base del reparto) quedaba inflada en silencio. Misma
      // cadena que la conversión de gastos: z ?? tcPromedio.
      const tcGanancia = z ?? tcPromedio;
      const AM =
        AL != null && tcGanancia != null ? round2(AL / tcGanancia) : null;
      const AN = AE != null && O != null && O > 0 ? AE / O : null;
      const AO = AN != null ? AN / 1.16 : null;
      // Y=0 (fila compartida sin gastos sellados a este avión aún) daría un
      // 0 falso que contamina el promedio COSTO X HORA del periodo.
      if (AN != null && Y > 0) anValues.push(AN);

      // ----- Bloque STATUS DE COBROS -----
      let cobroSinTc = 0;
      const cobrosOut: BalanceAvionCobroPayload[] = vCobros.map((c) => {
        const monto = num(c.monto) ?? 0;
        let mxn: number | null;
        if (c.moneda === 'MXN') {
          mxn = round2(monto);
        } else {
          const tc = pos(c.tc_usd_mxn) ?? K;
          mxn = tc != null ? round2(monto * tc) : null;
        }
        if (mxn == null) cobroSinTc += 1;
        return {
          fecha: diaCancun(c.fecha_cobro),
          monto_mxn: mxn,
          metodo: c.metodo_cobro ?? null,
        };
      });
      const cobradoMxn = round2(
        cobrosOut.reduce((acc, c) => acc + (c.monto_mxn ?? 0), 0),
      );
      const porCobrarMxn = round2((L ?? 0) - cobradoMxn);
      const porCobrarUsd = K != null ? round2(porCobrarMxn / K) : null;
      const statusCobro =
        v.cobrado === true
          ? 'Cobrado'
          : vCobros.length > 0
            ? 'Parcial'
            : (L ?? 0) > 0
              ? 'Pendiente'
              : '—';

      // ----- Pendientes de captura por vuelo (lista generosa) -----
      const cancelado = v.estado === 'CANCELADO';
      const yaVolo = v.estado === 'EN_VUELO' || v.estado === 'COMPLETADO';
      // Cliente INTERNO: venta $0 es lo esperado (operación propia) — no se
      // regaña por cotización/cobranza; los pendientes OPERATIVOS (tacos,
      // gas, TC) siguen aplicando igual.
      const esClienteInterno =
        v.cliente_id != null && clientesInternos.has(v.cliente_id);
      if (
        (totalSistemaUsd ?? 0) === 0 &&
        D === 0 &&
        !cancelado &&
        !esClienteInterno &&
        // La fila compartida no lleva venta a propósito: no es un pendiente.
        !esCompartido
      ) {
        pendientes.push(
          `${etiqueta}: sin cotización — montos de venta en $0 (¿traslado/servicio o falta cotizar?)`,
        );
      }
      if ((L ?? 0) > 0 && vCobros.length === 0) {
        pendientes.push(`${etiqueta}: sin cobros registrados`);
      }
      // (El combustible ya no se vigila POR VUELO: la vigilancia es mensual
      // por avión — ver pendientes de la hoja "combustible".)
      if (O == null && !esExterno && !cancelado) {
        pendientes.push(
          yaVolo
            ? `${etiqueta}: sin tacómetros — horas voladas vacías`
            : `${etiqueta}: sin tacómetros (vuelo aún no volado — ok si es futuro)`,
        );
      }
      if (usdSinTc > 0) {
        pendientes.push(
          `${etiqueta}: ${usdSinTc} gasto(s) en USD por $${usdSinTcMonto.toLocaleString(
            'en-US',
          )} sin ningún TC — fuera del costo MXN (captura su TC en Gastos)`,
        );
      }
      // Fecha del gasto fuera del periodo del libro (dedazos dd/mm o de
      // año, verificación 26-ago): la fila lo incluye por pertenecer al
      // vuelo, pero el reparto, el Libro Dinero y la conciliación (eje
      // fecha_gasto) lo ponen en OTRO mes — los libros del cierre divergen.
      const fechasFuera = vGastos.filter(
        (g) =>
          g.fecha_gasto != null &&
          (g.fecha_gasto < desde || g.fecha_gasto > hasta),
      );
      if (fechasFuera.length > 0) {
        pendientes.push(
          `${etiqueta}: ${fechasFuera.length} gasto(s) con fecha (${fechasFuera
            .map((g) => g.fecha_gasto)
            .join(
              ', ',
            )}) FUERA del periodo del libro — corrige la fecha en Gastos o el reparto/Libro lo contarán en otro mes`,
        );
      }
      if (cobroSinTc > 0) {
        pendientes.push(
          `${etiqueta}: ${cobroSinTc} cobro(s) en USD sin TC (ni TC del vuelo) — parcialidad vacía en MXN`,
        );
      }
      // Regla del cliente: NUNCA se cobran menos horas de las voladas. Si el
      // tacómetro registró más de lo cotizado, hay que recotizar el vuelo
      // (revisar cotización con las horas reales). Solo aplica con cotización
      // (D>0; sin cotización ya sale su propio pendiente) y con cliente NO
      // interno (interno no cobra: recotizar no cambiaría un peso).
      // Horas de TODO el viaje (todas las matrículas): en vuelos multi-avión
      // comparar solo los tramos de este avión dejaba ciego el candado de
      // recotizar (ida 1.4 + regreso 1.5 = 2.9 hr > 2.4 cobradas y nadie
      // avisaba). Solo en la fila del principal (la compartida no lleva D).
      let horasViaje: number | null = null;
      for (const e of vEscalas) {
        const s = num(e.taco_salida);
        const l = num(e.taco_llegada);
        if (s == null || l == null) continue;
        const h = l - s;
        if (h <= 0) continue;
        horasViaje = (horasViaje ?? 0) + h;
      }
      if (
        D > 0 &&
        horasViaje != null &&
        horasViaje - D > 0.01 &&
        !esClienteInterno &&
        !esCompartido
      ) {
        pendientes.push(
          `${etiqueta}: voló ${horasViaje.toFixed(2)} hr (todas las matrículas) y solo se cobraron ${D.toFixed(
            2,
          )} — recotizar con las horas reales (lo cobrado no puede ser menor a lo volado)`,
        );
      }
      // Fila COMPARTIDA con costos: hasta que el cliente decida el prorrateo
      // multi-avión, estos costos NO restan en la utilidad de NINGÚN balance
      // (aquí no hay venta; el principal ya no los carga) — decirlo, no
      // esconderlo.
      if (esCompartido && Y > 0) {
        pendientes.push(
          // OJO: aplica a los costos de COLUMNAS (Y). Las partes/gastos TUA
          // de esta fila SÍ restan (hoja "otros gastos" de ESTE avión) y el
          // GAS resta en su hoja mensual — solo Y espera el prorrateo.
          `${etiqueta} (fila compartida): $${Y.toLocaleString('es-MX', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} MXN de costos de columnas de este avión no restan en ninguna utilidad — prorrateo multi-avión pendiente de decisión del cliente (los TUA y el combustible de la fila sí restan en sus hojas)`,
        );
      }
      // Gasto asignado a un avión que NO vuela ningún tramo del vuelo: no
      // aparecería en NINGÚN balance (regla sagrada: el dinero jamás
      // desaparece en silencio). Solo se evalúa en la fila del principal
      // para no duplicar el aviso.
      if (!esCompartido) {
        const avionesDelVuelo = new Set(
          [v.aeronave_id, ...vEscalas.map((e) => e.aeronave_id)].filter(
            (x): x is string => x != null,
          ),
        );
        for (const g of gastosPorVuelo.get(v.id) ?? []) {
          const avionG = avionDelGasto(g);
          if (avionG != null && !avionesDelVuelo.has(avionG)) {
            pendientes.push(
              `${etiqueta}: gasto ${CAT_LABEL[g.categoria] ?? g.categoria} por $${(
                num(g.monto) ?? 0
              ).toLocaleString('es-MX')} ${g.moneda ?? ''} asignado a ${
                matriculaPorAvion.get(avionG) ?? 'otro avión'
              }, que no vuela ningún tramo de este vuelo — corregir el avión del gasto (así no aparece en ningún balance)`,
            );
          }
        }
      }

      const cliente = v.cliente_id
        ? (clientePorId.get(v.cliente_id) ?? null)
        : null;
      filasVuelo.push({
        // CLAVE del libro: folio del sistema + nombre del cliente (el libro
        // original usaba claves tipo "vt<apellido>"; el nombre real es más
        // claro para el equipo y el folio amarra la fila al sistema).
        clave: `#${folio}${cliente ? ` · ${cliente}` : ''}`,
        folio,
        cliente,
        estado: v.estado,
        es_externo: esExterno,
        fecha: diaCancun(v.fecha_vuelo),
        // Llave interna de orden cronológico (salida planeada de los tramos
        // de ESTE avión): el consolidado de flota ordena con ella — no se
        // pinta en el Excel.
        orden_ts: new Date(ordenTsPorVuelo.get(v.id) ?? 0).toISOString(),
        fecha_fin:
          diaCancun(v.fecha_traslado_final) !== diaCancun(v.fecha_vuelo)
            ? diaCancun(v.fecha_traslado_final)
            : null,
        ruta,
        horas_cobradas: round2(D),
        tarifa_usd: r2(E),
        iva_hr_usd: G,
        total_usd: I, // total del sistema: desglose completo c/TUAs y extras (7-ago)
        iva_usd: J,
        tc_venta: K,
        tc_venta_oficial: kOficial,
        total_mxn: L,
        iva_mxn: M,
        subtotal_mxn: N,
        tiempo_vuelo: O,
        taco_inicio: P,
        taco_inicio_obs: escalasDelAvion
          .filter((e) => (e.taco_salida_obs ?? '').trim().length > 0)
          .map((e) => obsLinea(e, 'salida')),
        taco_fin_obs: escalasDelAvion
          .filter((e) => (e.taco_llegada_obs ?? '').trim().length > 0)
          .map((e) => obsLinea(e, 'llegada')),
        taco_fin: Q,
        salto_taco_interno: saltoInterno != null,
        salto_taco_interno_detalle: saltoInterno,
        // Combustible fuera de la fila (hoja mensual "combustible"): los
        // campos gas_* se conservan en el contrato (py viejo los ignora).
        gas_mxn: null,
        gas_litros: null,
        gas_precio_litro: null,
        op_mxn: r2(opMxn),
        piloto_mxn: r2(pilotoMxn),
        otros_mxn: r2(otrosMxn),
        gas_detalle: [],
        op_detalle: opDetalle,
        piloto_detalle: pilotoDetalle,
        otros_detalle: otrosDetalle,
        permiso_afac_mxn: X,
        costo_total_mxn: Y,
        tc_costos: z,
        costo_usd: r2(AE),
        costo_usd_siva: r2(AF),
        iva_pagado_usd: r2(AG),
        iva_pagado_mxn: r2(AH),
        remanente_mxn: AI,
        dif_iva_mxn: AJ,
        comision_vendedor_mxn: AK,
        ganancia_mxn: AL,
        ganancia_usd: AM,
        costo_hr_usd: r2(AN),
        costo_hr_usd_siva: r2(AO),
        // Fila compartida: el status de cobro pertenece a la venta (vive en
        // el otro balance) — mostrarlo aquí despistaba ("Cobrado" con venta
        // vacía).
        status_cobro: esCompartido ? '—' : statusCobro,
        cobros: cobrosOut,
        cobrado_mxn: cobradoMxn,
        por_cobrar_mxn: porCobrarMxn,
        por_cobrar_usd: porCobrarUsd,
      });
    }

    // ===== Saltos en la cadena de tacómetros (24-ago-2026) =====
    // Mismo amarillo que el detalle del avión en el panel: el taco INICIAL de
    // una fila debe empalmar con el taco FINAL de la fila anterior del avión
    // (filasVuelo ya viene en orden cronológico por orden_ts; las COMPARTIDO
    // traen tacos propios y entran a la cadena). Tolerancia 0.004: los
    // valores llegan de numeric y el estricto daría falsos positivos por
    // flotante; cualquier diferencia real (>= 0.01 del horómetro) marca.
    {
      // Siembra: última llegada del avión ANTES del periodo (la costura
      // entre meses es justo donde el cierre necesita la señal). El
      // horómetro solo sube → max(taco_llegada) previo = el último
      // cronológico, sin depender de ordenar por columna embebida.
      let tacoFinPrevio: number | null = await this.ultimaLlegadaAntesDe(
        aircraftId,
        desde,
      );
      for (const fila of filasVuelo) {
        if (fila.taco_inicio != null && tacoFinPrevio != null) {
          const salta = Math.abs(fila.taco_inicio - tacoFinPrevio) > 0.004;
          fila.salto_taco_inicio = salta;
          fila.salto_taco_esperado = salta ? tacoFinPrevio : null;
        }
        if (fila.taco_fin != null) {
          tacoFinPrevio = fila.taco_fin;
        } else if (fila.taco_inicio != null) {
          // Llegada sin capturar: la cadena se corta (compararse contra un
          // fin de 2+ filas atrás señalaría al vuelo equivocado; el hueco
          // real ya lo vigila la hoja de pendientes).
          tacoFinPrevio = null;
        }
      }
    }

    // ===== Totales del periodo (suma de no nulos; promedios SOLO no nulos) =====
    const sum = (f: (r: BalanceAvionVueloPayload) => number | null): number =>
      round2(filasVuelo.reduce((acc, r) => acc + (f(r) ?? 0), 0));
    const horasVoladas = sum((r) => r.tiempo_vuelo);
    const totales = {
      horas_cobradas: sum((r) => r.horas_cobradas),
      tiempo_vuelo: horasVoladas,
      total_mxn: sum((r) => r.total_mxn),
      iva_mxn: sum((r) => r.iva_mxn),
      subtotal_mxn: sum((r) => r.subtotal_mxn),
      gas_mxn: sum((r) => r.gas_mxn),
      gas_litros: sum((r) => r.gas_litros),
      op_mxn: sum((r) => r.op_mxn),
      piloto_mxn: sum((r) => r.piloto_mxn),
      otros_mxn: sum((r) => r.otros_mxn),
      permiso_afac_mxn: sum((r) => r.permiso_afac_mxn),
      costo_total_mxn: sum((r) => r.costo_total_mxn),
      remanente_mxn: sum((r) => r.remanente_mxn),
      dif_iva_mxn: sum((r) => r.dif_iva_mxn),
      comision_vendedor_mxn: sum((r) => r.comision_vendedor_mxn),
      ganancia_mxn: sum((r) => r.ganancia_mxn),
      ganancia_usd: sum((r) => r.ganancia_usd),
      cobrado_mxn: sum((r) => r.cobrado_mxn),
      por_cobrar_mxn: sum((r) => r.por_cobrar_mxn),
      por_cobrar_usd: sum((r) => r.por_cobrar_usd),
      tc_promedio: tcPromedio != null ? round2(tcPromedio) : null,
      costo_hr_prom_usd: anValues.length
        ? round2(anValues.reduce((a, b) => a + b, 0) / anValues.length)
        : null,
      // Informativo al pie: NO suma en las columnas (va al control general).
      otros_ingresos_usd: round2(otrosIngresosPeriodoUsd),
    };

    // ===== Hojas de gastos (indirectos / otros / permisos) =====
    // INDIRECTO ligado a vuelo no debería existir, pero si existe NO se pierde:
    // cae a su hoja igual que los sin vuelo.
    // Con vuelos COMPARTIDOS en la lista, gastosVuelo trae también gastos del
    // OTRO avión: las hojas solo cargan los de ESTE (herencia por gasto).
    const avionPorVuelo = new Map(vuelos.map((v) => [v.id, v.aeronave_id]));
    const gastosVueloDelAvion = gastosVuelo.filter(
      (g) =>
        (g.aeronave_id ??
          (g.vuelo_id ? avionPorVuelo.get(g.vuelo_id) : null)) === aircraftId,
    );
    const filasIndirectos = [
      ...gastosAvion.filter((g) => g.categoria === 'INDIRECTO'),
      ...gastosVueloDelAvion.filter((g) => g.categoria === 'INDIRECTO'),
    ];
    // GAS fuera de "otros gastos": el combustible tiene su propia hoja
    // mensual — dejarlo aquí lo contaría DOS veces en la cascada.
    // TUAS (regla 26-ago-2026): van a esta hoja — ya no suman en las
    // columnas del vuelo (la venta de la fila sí incluye los TUAs cobrados;
    // sin esta salida la utilidad se inflaba). Los TUAS CON vuelo entran
    // pre-convertidos desde el row-loop (tuaEmbebidoFilas: misma atribución
    // de avión y mismo TC que su nota de celda); aquí solo los SIN vuelo.
    const filasOtros = gastosAvion.filter(
      (g) =>
        g.categoria !== 'INDIRECTO' &&
        g.categoria !== 'PERMISO' &&
        g.categoria !== 'GAS',
    );
    // Permisos: pagos reales de PERMISO del avión, CON o SIN vuelo.
    const filasPermisos = [
      ...gastosAvion.filter((g) => g.categoria === 'PERMISO'),
      ...gastosVueloDelAvion.filter((g) => g.categoria === 'PERMISO'),
    ];
    const hojaIndirectos = this.buildHoja(
      filasIndirectos,
      tcPromedio,
      horasVoladas,
      'gastos indirectos',
      pendientes,
    );
    let hojaOtros = this.buildHoja(
      filasOtros,
      tcPromedio,
      horasVoladas,
      'otros gastos',
      pendientes,
    );
    // Partes TUA embebidas (ya en MXN con el factor exacto del gasto): se
    // funden al ledger y el resumen de la hoja se recalcula con las MISMAS
    // fórmulas de buildHoja (usd = total/tcPromedio; usd_hr = usd/horas).
    if (tuaEmbebidoFilas.length > 0) {
      const filasMerged = [...hojaOtros.filas, ...tuaEmbebidoFilas].sort(
        (a, b) => String(a.fecha ?? '').localeCompare(String(b.fecha ?? '')),
      );
      const totalMxn = round2(
        hojaOtros.total_mxn +
          tuaEmbebidoFilas.reduce((s, f) => s + (f.monto_mxn ?? 0), 0),
      );
      // Misma regla que buildHoja: una fila sin MXN (sin TC) anula el USD
      // de la hoja — la cascada queda pendiente, no numérica a medias.
      const usd = filasMerged.some((f) => f.monto_mxn == null)
        ? null
        : totalMxn === 0
          ? 0
          : tcPromedio != null
            ? round2(totalMxn / tcPromedio)
            : null;
      hojaOtros = {
        filas: filasMerged,
        total_mxn: totalMxn,
        usd,
        usd_hr:
          usd != null && horasVoladas > 0 ? round2(usd / horasVoladas) : null,
      };
    }
    const hojaPermisos = this.buildHoja(
      filasPermisos,
      tcPromedio,
      horasVoladas,
      'permisos',
      pendientes,
    );
    // ===== Hoja COMBUSTIBLE (26-ago-2026): el gas del avión en el MES =====
    // Eje fecha_gasto + aeronave_id crudo (idéntico al reparto a socios);
    // con o sin vuelo. Litros y $/L viven aquí, ya no por vuelo.
    const hojaCombustibleBase = this.buildHoja(
      gastosGas,
      tcPromedio,
      horasVoladas,
      'combustible',
      pendientes,
    );
    const litrosPorFila = [...gastosGas]
      .sort((a, b) => (a.fecha_gasto ?? '').localeCompare(b.fecha_gasto ?? ''))
      .map((g) => pos(g.litros));
    let litrosAcum = 0;
    for (const l of litrosPorFila) litrosAcum += l ?? 0;
    const litrosTotal = round2(litrosAcum);
    const hojaCombustible = {
      ...hojaCombustibleBase,
      filas: hojaCombustibleBase.filas.map((f, i) => ({
        ...f,
        litros: litrosPorFila[i] ?? null,
      })),
      litros_total: litrosTotal,
      precio_litro_prom:
        litrosTotal > 0 && hojaCombustibleBase.total_mxn > 0
          ? round2(hojaCombustibleBase.total_mxn / litrosTotal)
          : null,
    };
    // Vigilancia MENSUAL del combustible (sustituye a los regaños por vuelo):
    // un avión que voló sin una sola carga en el mes es captura faltante.
    if (horasVoladas > 0 && gastosGas.length === 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: voló ${horasVoladas.toFixed(
          1,
        )} hr en el periodo y no hay NINGUNA carga de combustible capturada`,
      );
    }
    const gasSinLitrosMes = gastosGas.filter(
      (g) => pos(g.litros) == null,
    ).length;
    if (gasSinLitrosMes > 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: ${gasSinLitrosMes} carga(s) de combustible sin litros — el $/litro del mes queda incompleto`,
      );
    }
    // $/L fuera de banda (verificación 26-ago: XB-PEV a $103.50/L, ~3× el
    // mercado — litros o monto mal capturados): banda generosa 10–80 MXN/L.
    for (let i = 0; i < hojaCombustible.filas.length; i++) {
      const fila = hojaCombustible.filas[i];
      const litros = fila.litros;
      if (fila.monto_mxn == null || litros == null || litros <= 0) continue;
      const precio = fila.monto_mxn / litros;
      if (precio > 80 || precio < 10) {
        pendientes.push(
          `Avión ${avion.matricula as string}: carga de combustible del ${
            fila.fecha ?? 'sin fecha'
          } con $/litro inusual ($${round2(precio).toLocaleString(
            'es-MX',
          )}/L) — revisar litros y monto en Combustibles`,
        );
      }
    }

    // ===== Balance (todo USD; null se propaga si falta TC) =====
    const utilidadAntes = totales.ganancia_usd;
    const hojasUsd = [
      hojaCombustible.usd,
      hojaIndirectos.usd,
      hojaOtros.usd,
      hojaPermisos.usd,
    ];
    const utilidadDespues = hojasUsd.every((u) => u != null)
      ? round2(
          utilidadAntes -
            (hojaCombustible.usd ?? 0) -
            (hojaIndirectos.usd ?? 0) -
            (hojaOtros.usd ?? 0) -
            (hojaPermisos.usd ?? 0),
        )
      : null;
    const porCobrarUsdTotal = totales.por_cobrar_usd;
    const utilidadCobrada =
      utilidadDespues != null
        ? round2(utilidadDespues - porCobrarUsdTotal)
        : null;

    // Socios vigentes en el periodo (mismo criterio de vigencia que el módulo
    // de reparto) con nombre real desde usuario.
    const socios = sociosAll
      .filter(
        (s) =>
          s.vigente_desde <= hasta &&
          (s.vigente_hasta === null || s.vigente_hasta >= desde),
      )
      .sort((a, b) => Number(b.porcentaje) - Number(a.porcentaje))
      .map((s) => {
        const u = Array.isArray(s.usuario) ? s.usuario[0] : s.usuario;
        const pct = Number(s.porcentaje);
        return {
          nombre: u?.nombre ?? 'Socio',
          porcentaje: pct,
          monto_usd:
            utilidadCobrada != null
              ? round2((pct / 100) * utilidadCobrada)
              : null,
        };
      });

    // ===== Pendientes a nivel avión =====
    if (hojaIndirectos.filas.length === 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: sin gastos INDIRECTOS en el periodo — verificar que no falte captura`,
      );
    }
    if (permisoAfacUsdHr == null) {
      pendientes.push(
        `Avión ${avion.matricula as string}: provisión permiso AFAC no configurada (campo "Aportación AFAC USD/hr" en la ficha del avión) — columna PERMISO AFAC vacía`,
      );
    }
    if (tcOficialPorVuelo.size > 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: ${tcOficialPorVuelo.size} vuelo(s) sin tipo de cambio en la cotización — se usó el TC oficial (Banxico FIX / DOF) del día de la cotización; celdas marcadas en azul claro en la hoja maestra`,
      );
    }
    if (tcPromedio == null && vuelos.length > 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: sin TC de costos en ningún vuelo del periodo — indicadores USD vacíos`,
      );
    }
    if (socios.length === 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: sin socios vigentes configurados — el balance no reparte la utilidad`,
      );
    } else {
      pendientes.push(
        `Socios: porcentajes registrados ${socios
          .map((s) => `${s.nombre} ${s.porcentaje}%`)
          .join(' / ')} — verificar contra el reparto real del avión`,
      );
    }
    if (utilidadDespues == null) {
      pendientes.push(
        `Avión ${avion.matricula as string}: hojas de gastos sin TC promedio — la utilidad después de gastos queda vacía`,
      );
    }
    if (vuelos.length === 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: sin vuelos en el periodo ${desde} a ${hasta}`,
      );
    }
    // Servicio por horas (pedido del mecánico, 18-ago-2026): la hoja de
    // pendientes también avisa el PRÓXIMO servicio del programa — mismo
    // cálculo que la ficha del avión y la alerta push (proximoServicio,
    // cada intervalo cuenta desde la base y manda el más cercano). El
    // tacómetro usado es el último del PERIODO: el libro es el cierre del
    // mes y así se lee (con el mes corriente = el hobbs actual).
    const intervalosServicio = (
      (avion.servicio_intervalos as unknown[]) ?? []
    ).map(Number);
    let maxTacoPeriodo = 0;
    for (const e of escalas) {
      if (
        (e.aeronave_id ?? avionPorVuelo.get(e.vuelo_id) ?? null) !== aircraftId
      )
        continue;
      for (const t of [num(e.taco_salida), num(e.taco_llegada)])
        if (t != null && t > maxTacoPeriodo) maxTacoPeriodo = t;
    }
    if (intervalosServicio.filter((n) => n > 0).length === 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: sin programa de servicio por horas configurado (ficha del avión → Programa de servicio)`,
      );
    } else if (maxTacoPeriodo > 0) {
      const prox = this.aircraft.proximoServicio(
        intervalosServicio,
        Number(avion.servicio_horas_base ?? 0),
        maxTacoPeriodo,
      );
      if (prox) {
        pendientes.push(
          `Avión ${avion.matricula as string}: próximo servicio de ${prox.intervalo} h a las ${prox.a_las} — faltan ${prox.faltan} h (último tacómetro del periodo: ${maxTacoPeriodo.toFixed(1)})`,
        );
      }
    }

    return {
      generado: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Cancun',
      }).format(new Date()),
      matricula: avion.matricula as string,
      modelo: (avion.modelo as string | null) ?? null,
      periodo_desde: desde,
      periodo_hasta: hasta,
      permiso_afac_usd_hr: permisoAfacUsdHr,
      tc_promedio: totales.tc_promedio,
      horas_voladas_hr: horasVoladas,
      vuelos: filasVuelo,
      totales,
      gastos_indirectos: hojaIndirectos,
      otros_gastos: hojaOtros,
      permisos: hojaPermisos,
      combustible: hojaCombustible,
      balance: {
        utilidad_antes_usd: utilidadAntes,
        combustible_usd: hojaCombustible.usd,
        gastos_indirectos_usd: hojaIndirectos.usd,
        otros_usd: hojaOtros.usd,
        permisos_usd: hojaPermisos.usd,
        utilidad_despues_usd: utilidadDespues,
        por_cobrar_usd: porCobrarUsdTotal,
        utilidad_cobrada_usd: utilidadCobrada,
        socios,
      },
      pendientes,
    };
  }

  /**
   * Hoja tipo ledger (gastos indirectos / otros / permisos): filas + resumen
   * al TC promedio del periodo. Un gasto USD sin TC (ni tc_gasto ni promedio)
   * queda con monto_mxn null Y se reporta en pendientes — nunca desaparece.
   */
  /**
   * Cargas de combustible del periodo SIN avión: invisibles para el balance
   * de todos los aviones Y para el reparto (que filtra aeronave_id crudo).
   * Se gritan al frente del consolidado — asignarles avión es el paso #1.
   */
  private async pendienteGasSinAvion(
    desde: string,
    hasta: string,
  ): Promise<string[]> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('monto, moneda')
      .eq('categoria', 'GAS')
      .is('aeronave_id', null)
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta);
    if (error) throw new Error(error.message);
    const filas = data ?? [];
    if (filas.length === 0) return [];
    const porMoneda = new Map<string, number>();
    for (const g of filas) {
      const m = (g.moneda as string) ?? 'MXN';
      porMoneda.set(m, (porMoneda.get(m) ?? 0) + (num(g.monto) ?? 0));
    }
    const montos = [...porMoneda.entries()]
      .map(
        ([m, t]) =>
          `$${round2(t).toLocaleString('es-MX', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} ${m}`,
      )
      .join(' + ');
    return [
      `FLOTA: ${filas.length} carga(s) de combustible SIN avión por ${montos} — no aparecen en el balance de ningún avión ni en el reparto; asígnales aeronave en Combustibles`,
    ];
  }

  /**
   * Gastos ligados a vuelos SIN avión (externos con aeronave null): el vuelo
   * no vive en ningún libro y el gasto no resta en ningún balance ni en el
   * reparto. Caso real ago-2026: $50,347 MXN de dos externos (verificación
   * 26-ago). El tratamiento definitivo espera decisión del cliente.
   */

  /**
   * Pestaña "Otros movimientos" del Balance GENERAL (28-ago, réplica de la
   * hoja manual "dinero otros ingresos" del cliente): por vuelo, los
   * conceptos cobrados al cliente (líneas TUAS/EXTRA/PERNOCTA del desglose
   * canónico v1.3, en MXN con el TC de venta) apareados con lo PAGADO solo
   * cuando el mapeo es ESTRUCTURAL — TUAS ↔ gastos TUAS + TUA embebido
   * (misma regla probada del Libro Dinero), PERNOCTA ↔ gastos HOTEL del
   * vuelo, comisión bancaria de los cobros ↔ línea BillPocket. El resto de
   * conceptos queda como filas adyacentes por clave (el equipo los lee
   * juntos; el sistema jamás afirma un apareo que no puede garantizar).
   * Además: filas SUELTAS con el dinero hoy invisible en este Excel —
   * gastos sin vuelo NI avión NI reparto, GAS sin avión y los gastos de
   * vuelos EXTERNOS sin avión (caso $50,347 ago-2026).
   */
  private async buildOtrosMovimientos(
    desde: string,
    hasta: string,
  ): Promise<BalanceHojaOtrosMovimientosPayload> {
    const sb = this.supabase.service;
    const { data: vuelosData, error: vErr } = await sb
      .from('vuelo')
      .select(
        'id, folio, cliente_id, aeronave_id, es_externo, operador_externo, fecha_vuelo, tc_usd_mxn, monto_total_usd, monto_total_mxn, calculo_snapshot, cliente:cliente_id(nombre)',
      )
      .in('estado', ['CONFIRMADO', 'EN_VUELO', 'COMPLETADO'])
      .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`)
      .order('fecha_vuelo', { ascending: true });
    if (vErr) throw new Error(vErr.message);
    const vuelos = (vuelosData ?? []) as Array<Record<string, unknown>>;
    const vueloIds = vuelos.map((v) => v.id as string);

    const vacio = { data: [], error: null } as const;
    const [avionesRes, gastosRes, cobrosRes, facturasRes, sueltosRes, gasRes] =
      await Promise.all([
        sb.from('aeronave').select('id, matricula, color_calendario'),
        vueloIds.length
          ? sb
              .from('gasto')
              .select(
                'vuelo_id, aeronave_id, categoria, monto, propina, moneda, tc_gasto, fecha_gasto, lugar, valor_ia_extraido',
              )
              .in('vuelo_id', vueloIds)
          : Promise.resolve(vacio),
        vueloIds.length
          ? sb
              .from('cobro_vuelo')
              .select(
                'vuelo_id, moneda, tc_usd_mxn, fecha_cobro, comision_banco_monto',
              )
              .in('vuelo_id', vueloIds)
              .order('fecha_cobro', { ascending: true })
          : Promise.resolve(vacio),
        vueloIds.length
          ? sb
              .from('factura')
              .select('vuelo_id, serie, folio, estado')
              .in('vuelo_id', vueloIds)
              .neq('estado', 'CANCELADA')
          : Promise.resolve(vacio),
        // Gastos de EMPRESA hoy invisibles en este Excel: sin vuelo, sin
        // avión (PERSONAL_DUENO fuera; GAS tiene su fila propia abajo).
        sb
          .from('gasto')
          .select(
            'id, categoria, monto, moneda, tc_gasto, fecha_gasto, lugar, proveedor:proveedor_id(nombre)',
          )
          .is('vuelo_id', null)
          .is('aeronave_id', null)
          .neq('categoria', 'PERSONAL_DUENO')
          .neq('categoria', 'GAS')
          .gte('fecha_gasto', desde)
          .lte('fecha_gasto', hasta)
          .order('fecha_gasto', { ascending: true }),
        // GAS sin avión (mismo universo que pendienteGasSinAvion).
        sb
          .from('gasto')
          .select('id, monto, moneda, tc_gasto, fecha_gasto, lugar')
          .eq('categoria', 'GAS')
          .is('aeronave_id', null)
          .gte('fecha_gasto', desde)
          .lte('fecha_gasto', hasta)
          .order('fecha_gasto', { ascending: true }),
      ]);
    for (const r of [
      avionesRes,
      gastosRes,
      cobrosRes,
      facturasRes,
      sueltosRes,
      gasRes,
    ]) {
      if (r.error) throw new Error(r.error.message);
    }
    const aviones = new Map(
      ((avionesRes.data ?? []) as Array<Record<string, unknown>>).map((a) => [
        a.id as string,
        {
          matricula: a.matricula as string,
          color: (a.color_calendario as string | null) ?? null,
        },
      ]),
    );
    const gastosPorVuelo = new Map<string, Array<Record<string, unknown>>>();
    for (const g of (gastosRes.data ?? []) as Array<Record<string, unknown>>) {
      const vid = g.vuelo_id as string;
      (gastosPorVuelo.get(vid) ?? gastosPorVuelo.set(vid, []).get(vid)!).push(
        g,
      );
    }
    const cobrosPorVuelo = new Map<string, Array<Record<string, unknown>>>();
    for (const c of (cobrosRes.data ?? []) as Array<Record<string, unknown>>) {
      const vid = c.vuelo_id as string;
      (cobrosPorVuelo.get(vid) ?? cobrosPorVuelo.set(vid, []).get(vid)!).push(
        c,
      );
    }
    const facturaPorVuelo = new Map<string, string>();
    for (const f of (facturasRes.data ?? []) as Array<
      Record<string, unknown>
    >) {
      const vid = f.vuelo_id as string;
      if (!vid || facturaPorVuelo.has(vid)) continue;
      const etiqueta = [f.serie, f.folio].filter(Boolean).join('-');
      if (etiqueta) facturaPorVuelo.set(vid, etiqueta);
    }

    // TC promedio del periodo (fallback de gastos sueltos sin TC propio).
    const tcs: number[] = [];
    const tcDe = (v: Record<string, unknown>): number | null => {
      const totalUsd = num(v.monto_total_usd);
      const totalMxn = num(v.monto_total_mxn);
      return (
        pos(v.tc_usd_mxn) ??
        (totalMxn != null && totalUsd != null && totalUsd > 0
          ? totalMxn / totalUsd
          : null)
      );
    };
    for (const v of vuelos) {
      const tc = tcDe(v);
      if (tc != null) tcs.push(tc);
    }
    const tcPromedio = tcs.length
      ? tcs.reduce((a, b) => a + b, 0) / tcs.length
      : null;

    // Clave del libro manual: vt + primer nombre del cliente + folio (el
    // folio da la traza al vuelo; el libro manual lleva su propio contador).
    const claveDe = (v: Record<string, unknown>): string => {
      const cli = Array.isArray(v.cliente) ? v.cliente[0] : v.cliente;
      const nombre = ((cli as { nombre?: string } | null)?.nombre ?? '').trim();
      const primera = nombre.split(/\s+/)[0] ?? '';
      const limpia = primera.toLowerCase().replace(/[^a-záéíóúüñ0-9]/gi, '');
      return `vt${limpia}${String(v.folio ?? '')}`;
    };
    // Regla del workbook (misma que buildHoja): MXN directo; USD con su
    // tc_gasto propio o el TC promedio del periodo; sin ninguno → null (la
    // fila sale visible con la nota, jamás sumada en falso).
    const gastoMxn = (g: Record<string, unknown>, monto: number) =>
      g.moneda === 'MXN'
        ? monto
        : (pos(g.tc_gasto) ?? tcPromedio) != null
          ? monto * (pos(g.tc_gasto) ?? tcPromedio)!
          : null;

    const filas: BalanceOtroMovimientoFilaPayload[] = [];
    for (const v of vuelos) {
      const avion = aviones.get(v.aeronave_id as string);
      const externoSinAvion = v.es_externo === true && !v.aeronave_id;
      const tc = tcDe(v);
      const clave = claveDe(v);
      const color = avion?.color ?? null;
      const factura = facturaPorVuelo.get(v.id as string) ?? null;
      // timestamptz → DÍA Cancún (un vuelo vespertino se corría al día UTC).
      const fechaVuelo = diaCancun((v.fecha_vuelo as string) ?? null);
      const gastosV = gastosPorVuelo.get(v.id as string) ?? [];
      const snapshot = v.calculo_snapshot as {
        desglose?: { clave?: string; concepto?: string; monto_usd?: number }[];
      } | null;

      const base = {
        clave,
        avion_color: color,
        fecha_vuelo: fechaVuelo,
        factura,
      };
      const filaVacia = {
        ...base,
        concepto_egreso: null as string | null,
        egreso_mxn: null as number | null,
        fecha_egreso: null as string | null,
        concepto_ingreso: null as string | null,
        ingreso_mxn: null as number | null,
        fecha_ingreso: null as string | null,
        remanente_mxn: null as number | null,
      };

      // ===== INGRESOS: líneas TUAS/EXTRA/PERNOCTA del desglose canónico
      // (misma regla que la hoja "Otros ingresos" del Libro Dinero). =====
      // El egreso TUAS se adjunta SOLO a la primera línea TUAS (una línea
      // por aeropuerto: repetirlo duplicaba la columna egreso).
      let egresoTuasAsignado = false;
      let egresoPernoctaAsignado = false;
      let comisionBancoAsignada = false;

      // Comisión bancaria de los cobros del vuelo, a MXN (MXN directo; USD
      // con su TC propio o el de venta; sin TC no se suma en falso).
      let comisionBancoMxn = 0;
      let comisionSinTc = false;
      let fechaComision: string | null = null;
      for (const c of cobrosPorVuelo.get(v.id as string) ?? []) {
        const monto = num(c.comision_banco_monto);
        if (monto == null || monto <= 0) continue;
        const tcc = pos(c.tc_usd_mxn) ?? tc;
        const mxn =
          c.moneda === 'MXN' ? monto : tcc != null ? monto * tcc : null;
        if (mxn == null) {
          // Cobro USD sin ningún TC: la comisión no se convierte — se deja
          // RASTRO (nota en la fila) en vez de desaparecer en silencio.
          comisionSinTc = true;
          continue;
        }
        comisionBancoMxn += mxn;
        // timestamptz → DÍA Cancún.
        fechaComision ??= diaCancun((c.fecha_cobro as string) ?? null);
      }

      for (const linea of snapshot?.desglose ?? []) {
        const claveLinea = String(linea.clave ?? '');
        if (!/^(TUAS|EXTRA|PERNOCTA)/.test(claveLinea)) continue;
        const montoUsd = num(linea.monto_usd);
        if (montoUsd == null || montoUsd === 0) continue;
        const ingresoMxn = tc != null ? r2(montoUsd * tc) : null;
        let egresoMxn: number | null = null;
        let conceptoEgreso: string | null = null;
        let fechaEgreso: string | null = null;
        // Externos sin avión: TODOS sus gastos salen como filas propias
        // abajo — aparearlos aquí además los contaría dos veces.
        if (claveLinea === 'TUAS' && !egresoTuasAsignado && !externoSinAvion) {
          let suma = 0;
          let hubo = false;
          for (const g of gastosV) {
            const monto = num(g.monto) ?? 0;
            let parte = 0;
            if (g.categoria === 'TUAS') {
              parte = monto;
            } else if (
              monto > 0 &&
              !['GAS', 'COMIDA', 'HOTEL', 'TAXI', 'PILOTO_EXTERNO'].includes(
                g.categoria as string,
              )
            ) {
              const partes = desgloseGastoPartes(
                (
                  g as {
                    valor_ia_extraido?: {
                      conceptos?: Array<{ concepto: string; monto: number }>;
                    } | null;
                  }
                ).valor_ia_extraido?.conceptos ?? [],
                round2(monto - (num(g.propina) ?? 0)),
              );
              if (partes && partes.tua > 0) parte = partes.tua;
            }
            if (parte <= 0) continue;
            const parteMxn = gastoMxn(g, parte);
            if (parteMxn == null || parteMxn <= 0) continue;
            suma += parteMxn;
            hubo = true;
            fechaEgreso ??= (g.fecha_gasto as string) ?? null;
          }
          if (hubo) {
            egresoMxn = r2(suma);
            conceptoEgreso = 'tuas pagadas';
            egresoTuasAsignado = true;
          }
        } else if (
          claveLinea === 'PERNOCTA' &&
          !egresoPernoctaAsignado &&
          !externoSinAvion
        ) {
          // Viáticos de pernocta cobrados ↔ hoteles pagados del vuelo
          // (apareo estructural: la categoría HOTEL es el costo real).
          let suma = 0;
          let hubo = false;
          for (const g of gastosV) {
            if (g.categoria !== 'HOTEL') continue;
            const mxn = gastoMxn(g, num(g.monto) ?? 0);
            if (mxn == null || mxn <= 0) continue;
            suma += mxn;
            hubo = true;
            fechaEgreso ??= (g.fecha_gasto as string) ?? null;
          }
          if (hubo) {
            egresoMxn = r2(suma);
            conceptoEgreso = 'hotel pagado';
            egresoPernoctaAsignado = true;
          }
        } else if (
          claveLinea === 'EXTRA' &&
          String(linea.concepto ?? '').startsWith('Comisión BillPocket') &&
          !comisionBancoAsignada &&
          comisionBancoMxn > 0
        ) {
          // La comisión cobrada al cliente (línea BillPocket) contra lo que
          // el banco realmente descontó de los cobros.
          egresoMxn = r2(comisionBancoMxn);
          conceptoEgreso = `comisión del banco${
            comisionSinTc ? ' (parcial: cobro USD sin TC)' : ''
          }`;
          fechaEgreso = fechaComision;
          comisionBancoAsignada = true;
        }
        filas.push({
          ...filaVacia,
          concepto_egreso: conceptoEgreso,
          egreso_mxn: egresoMxn,
          fecha_egreso: fechaEgreso,
          concepto_ingreso: `${String(linea.concepto ?? claveLinea).toLowerCase()}${
            ingresoMxn == null ? ' (USD sin TC de venta)' : ''
          }`,
          ingreso_mxn: ingresoMxn,
          fecha_ingreso: fechaVuelo,
          // Coherencia de columnas: Σremanente == Σingreso − Σegreso aunque
          // un lado falte (el egreso pagado es real y resta igual).
          remanente_mxn:
            ingresoMxn != null || egresoMxn != null
              ? r2((ingresoMxn ?? 0) - (egresoMxn ?? 0))
              : null,
        });
      }

      // Banco que descontó comisión SIN línea BillPocket que la cubra
      // (transferencia HSBC, links): fila de solo-egreso — el costo existe
      // aunque no se haya cobrado al cliente.
      if ((comisionBancoMxn > 0 || comisionSinTc) && !comisionBancoAsignada) {
        const egreso = comisionBancoMxn > 0 ? r2(comisionBancoMxn) : null;
        filas.push({
          ...filaVacia,
          concepto_egreso: `comisión bancaria${
            comisionSinTc
              ? comisionBancoMxn > 0
                ? ' (parcial: cobro USD sin TC)'
                : ' (USD sin TC)'
              : ''
          }`,
          egreso_mxn: egreso,
          fecha_egreso: fechaComision,
          remanente_mxn: egreso != null ? r2(-egreso) : null,
        });
      }

      // Vuelo EXTERNO sin avión: sus gastos no viven en ningún libro por
      // avión — aquí salen TODOS como filas de solo-egreso bajo su clave.
      if (externoSinAvion) {
        for (const g of gastosV) {
          // GAS lo posee la fila suelta "gas sin avión" (contarlo aquí
          // también duplicaría el egreso); un gasto con avión propio ya
          // vive en las hojas de ese avión de ESTE mismo workbook.
          if (g.categoria === 'GAS' || g.aeronave_id != null) continue;
          const monto = num(g.monto) ?? 0;
          if (monto <= 0) continue;
          const mxn = gastoMxn(g, monto);
          const sinTc = mxn == null;
          filas.push({
            ...filaVacia,
            concepto_egreso: `${String(g.categoria ?? '').toLowerCase()}${
              g.lugar ? ` · ${g.lugar as string}` : ''
            }${sinTc ? ' (USD sin TC)' : ''}`,
            egreso_mxn: r2(mxn),
            fecha_egreso: (g.fecha_gasto as string) ?? null,
            remanente_mxn: mxn != null ? r2(-mxn) : null,
          });
        }
      }
    }

    // ===== Filas SUELTAS: dinero sin avión y sin vuelo (hoy invisible en
    // este Excel; el grito de pendientes se conserva). Sin TC propio se usa
    // el promedio del periodo; sin ninguno, la fila sale con egreso vacío y
    // la nota (USD sin TC) — visible, jamás sumada en falso. =====
    const sueltas: BalanceOtroMovimientoFilaPayload[] = [];
    const sueltaDe = (
      g: Record<string, unknown>,
      clave: string,
    ): BalanceOtroMovimientoFilaPayload => {
      const monto = num(g.monto) ?? 0;
      const mxn = gastoMxn(g, monto);
      const sinTc = mxn == null;
      const prov = Array.isArray(g.proveedor) ? g.proveedor[0] : g.proveedor;
      const proveedor = (prov as { nombre?: string } | null)?.nombre ?? null;
      return {
        clave,
        avion_color: null,
        fecha_vuelo: null,
        concepto_egreso: `${String(g.categoria ?? clave).toLowerCase()}${
          proveedor
            ? ` · ${proveedor}`
            : g.lugar
              ? ` · ${g.lugar as string}`
              : ''
        }${sinTc ? ' (USD sin TC)' : ''}`,
        egreso_mxn: r2(mxn),
        fecha_egreso: (g.fecha_gasto as string) ?? null,
        concepto_ingreso: null,
        ingreso_mxn: null,
        fecha_ingreso: null,
        remanente_mxn: mxn != null ? r2(-mxn) : null,
        factura: null,
      };
    };
    const sueltos = (sueltosRes.data ?? []) as Array<Record<string, unknown>>;
    if (sueltos.length) {
      // El reparto manual GANA: un gasto repartido ya vive en los libros de
      // sus aviones — aquí solo entra lo que nadie reclama.
      const repartos = await fetchRepartos(
        sb,
        sueltos.map((g) => g.id as string),
      );
      for (const g of sueltos) {
        const partes = repartos.get(g.id as string) ?? [];
        if (partes.length === 0) {
          sueltas.push(sueltaDe(g, 'empresa'));
          continue;
        }
        // Reparto PARCIAL: los parciales viven en las hojas de sus aviones;
        // el remanente de empresa (Σ < monto) no vive en NINGUNA — sale
        // aquí (misma moneda del gasto).
        const asignado = partes.reduce((a, x) => a + (num(x.monto) ?? 0), 0);
        const remanente = round2((num(g.monto) ?? 0) - asignado);
        if (remanente > 0) {
          sueltas.push(
            sueltaDe(
              { ...g, monto: remanente },
              'empresa (remanente de reparto)',
            ),
          );
        }
      }
    }
    for (const g of (gasRes.data ?? []) as Array<Record<string, unknown>>) {
      sueltas.push(sueltaDe(g, 'gas sin avión'));
    }

    return { filas, filas_sueltas: sueltas };
  }

  private async pendienteExternosSinAvion(
    desde: string,
    hasta: string,
  ): Promise<string[]> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('monto, moneda, vuelo:vuelo_id!inner(folio, aeronave_id)')
      .is('aeronave_id', null)
      .not('vuelo_id', 'is', null)
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta);
    if (error) throw new Error(error.message);
    const filas = ((data ?? []) as Array<Record<string, unknown>>).filter(
      (g) => {
        const v = (Array.isArray(g.vuelo) ? g.vuelo[0] : g.vuelo) as {
          aeronave_id?: string | null;
        } | null;
        return v?.aeronave_id == null;
      },
    );
    if (filas.length === 0) return [];
    const porMoneda = new Map<string, number>();
    const folios = new Set<string>();
    for (const g of filas) {
      const m = (g.moneda as string) ?? 'MXN';
      porMoneda.set(m, (porMoneda.get(m) ?? 0) + (num(g.monto) ?? 0));
      const v = (Array.isArray(g.vuelo) ? g.vuelo[0] : g.vuelo) as {
        folio?: number | null;
      } | null;
      const folio = v?.folio;
      if (folio != null) folios.add(`#${folio}`);
    }
    const montos = [...porMoneda.entries()]
      .map(
        ([m, t]) =>
          `$${round2(t).toLocaleString('es-MX', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} ${m}`,
      )
      .join(' + ');
    return [
      `FLOTA: ${filas.length} gasto(s) de vuelos EXTERNOS sin avión (${[...folios].join(', ')}) por ${montos} — no aparecen en el balance de ningún avión ni en el reparto (tratamiento pendiente de decisión)`,
    ];
  }

  private buildHoja(
    gastos: GastoRow[],
    tcPromedio: number | null,
    horasVoladas: number,
    nombreHoja: string,
    pendientes: string[],
  ): BalanceAvionHojaGastosPayload {
    const filas: BalanceAvionGastoFilaPayload[] = [...gastos]
      .sort((a, b) => (a.fecha_gasto ?? '').localeCompare(b.fecha_gasto ?? ''))
      .map((g) => {
        const monto = num(g.monto) ?? 0;
        const proveedor = Array.isArray(g.proveedor)
          ? g.proveedor[0]?.nombre
          : g.proveedor?.nombre;
        const detalle =
          g.notas?.trim() ||
          [g.categoria, proveedor].filter(Boolean).join(' · ');
        let mxn: number | null;
        if (g.moneda === 'MXN') {
          mxn = round2(monto);
        } else {
          const tc = pos(g.tc_gasto) ?? tcPromedio;
          mxn = tc != null ? round2(monto * tc) : null;
          if (mxn == null) {
            pendientes.push(
              `Hoja "${nombreHoja}" (${g.fecha_gasto ?? 'sin fecha'}): gasto en ${
                g.moneda ?? 'USD'
              } por $${monto.toLocaleString('en-US')} sin ningún TC — fila sin monto MXN`,
            );
          } else if (pos(g.tc_gasto) == null && monto > 5000) {
            // Defensa anti-moneda-equivocada (caso real 26-ago: salida de
            // bodega de aceite capturada como $39,799.92 "USD" → ~$730k MXN
            // falsos con el TC promedio): un gasto USD grande sin TC propio
            // se convierte, pero SE GRITA para que alguien verifique.
            pendientes.push(
              `Hoja "${nombreHoja}" (${g.fecha_gasto ?? 'sin fecha'}): gasto GRANDE en ${
                g.moneda ?? 'USD'
              } por $${monto.toLocaleString('en-US')} sin TC propio, convertido con TC promedio (~$${mxn.toLocaleString('es-MX', { maximumFractionDigits: 0 })} MXN) — VERIFICAR moneda y TC en Gastos`,
            );
          }
        }
        return {
          fecha: g.fecha_gasto ?? null,
          detalle,
          monto_mxn: mxn,
          moneda_original: g.moneda !== 'MXN' ? (g.moneda ?? null) : null,
          monto_original: g.moneda !== 'MXN' ? round2(monto) : null,
        };
      });
    const totalMxn = round2(
      filas.reduce((acc, f) => acc + (f.monto_mxn ?? 0), 0),
    );
    // "Hoja vacía" (usd = 0 real) ≠ "hoja con filas NO convertibles":
    // si alguna fila quedó sin monto MXN (USD sin ningún TC), el USD de la
    // hoja es null y la CASCADA queda pendiente — antes salía numérica
    // omitiendo ese dinero en silencio (null se propaga, jamás 0 falso).
    const hayFilaSinMxn = filas.some((f) => f.monto_mxn == null);
    const usd = hayFilaSinMxn
      ? null
      : totalMxn === 0
        ? 0
        : tcPromedio != null
          ? round2(totalMxn / tcPromedio)
          : null;
    const usdHr =
      usd != null && horasVoladas > 0 ? round2(usd / horasVoladas) : null;
    return { filas, total_mxn: totalMxn, usd, usd_hr: usdHr };
  }
}
