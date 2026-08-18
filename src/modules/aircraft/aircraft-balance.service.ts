import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AircraftService } from './aircraft.service';
import { desgloseGastoPartes } from '../../common/desglose-gasto.util';
import {
  PyservicesService,
  type BalanceAvionCobroPayload,
  type BalanceAvionGastoFilaPayload,
  type BalanceAvionHojaGastosPayload,
  type BalanceAvionPayload,
  type BalanceAvionVueloPayload,
  type BalanceGeneralResumenFilaPayload,
} from '../pyservices/pyservices.service';

/** Columnas del vuelo que consume el balance (nombres reales de la tabla). */
const VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, estado, tipo, es_externo, fecha_vuelo, fecha_traslado_final, origen_iata, destino_iata, tiempo_cobrable_hr, tarifa_hora_usd, iva_usd, monto_total_usd, monto_total_mxn, tc_usd_mxn, comision_vendedor_usd, cobrado';

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
    const buffer = await this.pyservices.generateBalanceAvionXlsx(payload);
    return { buffer, matricula: payload.matricula, desde: d, hasta: h };
  }

  /**
   * Balance GENERAL de la flota (pedido 18-ago, ajustado el mismo día): la
   * MISMA estructura que el libro individual pero con TODOS los aviones —
   * un workbook con las 6 hojas de cada avión intactas (mismo motor y
   * números; cero cálculos paralelos) + hoja RESUMEN al frente (una fila
   * por avión = los TOTALES de su libro, y fila TOTALES de flota). Vuelos
   * multi-avión no se duplican en la suma: horas/costos van al avión de
   * cada tramo y la venta solo al principal.
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
      ganancia: 0,
      cobrado: 0,
      porCobrar: 0,
      pendientes: 0,
    };
    for (const a of aviones ?? []) {
      const p = await this.buildPayload(a.id as string, d, h);
      const t = p.totales;
      // Aviones sin actividad en el periodo: fuera (ruido en el general).
      const actividad =
        p.vuelos.length > 0 ||
        t.costo_total_mxn !== 0 ||
        (t.total_mxn ?? 0) !== 0;
      if (!actividad) continue;
      // Color del avión (leyenda + filas teñidas — como la tabla "Color
      // calendario" del equipo; editable en el apartado del avión).
      p.avion_color = (a.color_calendario as string | null) ?? null;
      libros.push(p);
      resumen.push({
        matricula: p.matricula,
        color: p.avion_color,
        vuelos: p.vuelos.length,
        horas: t.tiempo_vuelo,
        horas_cobradas: t.horas_cobradas,
        venta_mxn: t.total_mxn,
        costo_mxn: t.costo_total_mxn,
        ganancia_mxn: t.ganancia_mxn,
        cobrado_mxn: t.cobrado_mxn,
        por_cobrar_mxn: t.por_cobrar_mxn,
        pendientes: p.pendientes.length,
      });
      acc.vuelos += p.vuelos.length;
      acc.horas += t.tiempo_vuelo ?? 0;
      acc.horasCobradas += t.horas_cobradas ?? 0;
      acc.venta += t.total_mxn ?? 0;
      acc.costo += t.costo_total_mxn ?? 0;
      acc.ganancia += t.ganancia_mxn ?? 0;
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
      pick: (p: BalanceAvionPayload) => BalanceAvionPayload['gastos_indirectos'],
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
            ) ||
            (Number(x.folio) || 0) - (Number(y.folio) || 0),
        ),
      totales: totalesFlota,
      gastos_indirectos: hojaFlota((p) => p.gastos_indirectos),
      otros_gastos: hojaFlota((p) => p.otros_gastos),
      permisos: hojaFlota((p) => p.permisos),
      // La hoja "balance" del general se pinta por BLOQUES desde `aviones`
      // (los socios son por avión): este campo no se renderiza.
      balance: {
        utilidad_antes_usd: 0,
        gastos_indirectos_usd: null,
        otros_usd: null,
        permisos_usd: null,
        utilidad_despues_usd: null,
        por_cobrar_usd: 0,
        utilidad_cobrada_usd: null,
        socios: [],
      },
      pendientes: libros.flatMap((p) =>
        p.pendientes.map((texto) => `${p.matricula}: ${texto}`),
      ),
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
    const [escalasRes, cobrosRes, gastosVueloRes, gastosAvionRes, sociosRes] =
      await Promise.all([
        vueloIds.length
          ? sb
              .from('escala')
              .select(
                'id, vuelo_id, orden, origen_iata, destino_iata, taco_salida, taco_llegada, aeronave_id, fecha_salida_plan',
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
                'vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre)',
              )
              .in('vuelo_id', vueloIds)
              .order('fecha_gasto', { ascending: true })
          : Promise.resolve(vacio),
        // Gastos del avión SIN vuelo en el periodo (fecha_gasto es DATE:
        // comparación de días, sin componente horaria).
        sb
          .from('gasto')
          .select(
            'vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre)',
          )
          .eq('aeronave_id', aircraftId)
          .is('vuelo_id', null)
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
      ['socios', sociosRes],
    ] as const) {
      if (res.error) {
        throw new Error(
          `Balance ${avion.matricula as string}: fallo al leer ${nombre}: ${res.error.message}`,
        );
      }
    }

    const escalas = (escalasRes.data ?? []) as unknown as EscalaRow[];
    const cobros = (cobrosRes.data ?? []) as unknown as CobroRow[];
    const gastosVuelo = (gastosVueloRes.data ?? []) as unknown as GastoRow[];
    const gastosAvion = (gastosAvionRes.data ?? []) as unknown as GastoRow[];
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
        : pos(v.tc_usd_mxn);
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
    // TUAs/extras/pernocta cobrados al cliente: NO van en las filas (regla
    // del libro) — se acumulan para informarlos al pie (van a la general).
    let otrosIngresosPeriodoUsd = 0;
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
      // REGLA DEL LIBRO (corrección 20-jul, indicación del cliente): la fila
      // individual lleva SOLO lo del vuelo — horas cobradas × tarifa, con o
      // sin IVA (fórmulas exactas del Excel original: I=D×H, J=D×G, L=I×K).
      // TUAs/extras/pernocta/transportes son OTROS INGRESOS y van al control
      // GENERAL, no a la fila: aquí solo se informa el acumulado del periodo
      // al pie para trasladarlo a la general.
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
      const K = pos(v.tc_usd_mxn);
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

      // ----- Bloque COSTOS (MXN) -----
      // Conversión de un gasto USD a MXN: tc_gasto ?? Z del vuelo ?? TC
      // promedio del periodo. Sin ningún TC → null (pendiente), JAMÁS crudo.
      const gastoMxn = (g: GastoRow): number | null => {
        const monto = num(g.monto) ?? 0;
        if (g.moneda === 'MXN') return monto;
        const tc = pos(g.tc_gasto) ?? z ?? tcPromedio;
        return tc != null ? monto * tc : null;
      };
      let gasMxn: number | null = null;
      let gasLitros: number | null = null;
      let opMxn: number | null = null;
      let pilotoMxn: number | null = null;
      let otrosMxn: number | null = null;
      let usdSinTc = 0;
      let usdSinTcMonto = 0;
      let gasSinLitros = 0;
      let tuvoGas = false;
      // Desglose por celda (nota de Excel): una línea por gasto, con la
      // categoría, el proveedor/nota y el monto — "Comida · Starbucks — $206.00".
      const gasDetalle: string[] = [];
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
        if (g.categoria === 'PERMISO' || g.categoria === 'INDIRECTO') continue;
        if (g.categoria === 'TUAS') {
          // REGLA DEL LIBRO (17-ago-2026): el TUA es un TRASLADO al pasajero,
          // JAMÁS costo de operar el avión — no entra a columnas ni al costo
          // total, y tampoco a "USD sin TC" (capturarle TC no lo metería a
          // ningún costo). Queda visible en la nota de la celda para que el
          // dinero no desaparezca del vistazo.
          const mxnTua = gastoMxn(g);
          const sufijoTua = g.medio_pago === 'EFECTIVO' ? ' (efectivo)' : '';
          opDetalle.push(
            lineaDetalle(
              g,
              mxnTua ?? 0,
              sufijoTua,
              mxnTua != null
                ? `TUA $${fmtMonto(mxnTua)} (no suma al costo)`
                : `TUA $${fmtMonto(num(g.monto) ?? 0)} ${g.moneda ?? 'USD'} sin TC (no suma al costo)`,
            ),
          );
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
        if (g.categoria === 'GAS') {
          tuvoGas = true;
          gasMxn = (gasMxn ?? 0) + mxn;
          const litros = pos(g.litros);
          // La línea del gas lleva sus litros: la misma nota anota GAS TOTAL
          // y GAS LITROS (se ve que son N cargas y de cuánto cada una).
          gasDetalle.push(
            `${lineaDetalle(g, mxn, sufijo)}${litros != null ? ` · ${litros} L` : ' · SIN LITROS'}`,
          );
          if (litros != null) gasLitros = (gasLitros ?? 0) + litros;
          else gasSinLitros += 1;
        } else if (CAT_PILOTO.has(g.categoria)) {
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
            const trozos = [
              sep.opParte > 0 ? `Op $${fmtMonto(sep.opParte)}` : null,
              sep.fboParte > 0
                ? `FBO $${fmtMonto(sep.fboParte)} (en OTROS)`
                : null,
              sep.tuaParte > 0
                ? `TUA $${fmtMonto(sep.tuaParte)} (no suma al costo)`
                : null,
            ]
              .filter(Boolean)
              .join(' · ');
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
                      ? `TUA $${fmtMonto(sep.tuaParte)} (no suma al costo)`
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
      const T =
        gasMxn != null && gasLitros != null && gasLitros > 0
          ? round2(gasMxn / gasLitros)
          : null;
      // Provisión AFAC (X) = tarifa USD/hr × TC de costos × horas COBRADAS —
      // solo si el avión tiene la config Y hay TC Y hay horas cobradas.
      const X =
        permisoAfacUsdHr != null && z != null && D > 0
          ? round2(permisoAfacUsdHr * z * D)
          : null;
      const Y = round2(
        (gasMxn ?? 0) +
          (opMxn ?? 0) +
          (pilotoMxn ?? 0) +
          (otrosMxn ?? 0) +
          (X ?? 0),
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
      const AM = AL != null && z != null ? round2(AL / z) : null;
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
      // En fila COMPARTIDA no se regaña por gas: los flujos de captura hoy
      // sellan el avión PRINCIPAL en el gasto, así que el gas de este tramo
      // suele vivir (correctamente detectable solo a mano) en el otro
      // balance — regañar aquí invitaría a capturar doble.
      if (!tuvoGas && usdSinTc === 0 && yaVolo && !esExterno && !esCompartido) {
        pendientes.push(`${etiqueta}: sin gastos de combustible (GAS)`);
      }
      if (gasSinLitros > 0) {
        pendientes.push(
          `${etiqueta}: ${gasSinLitros} gasto(s) GAS sin litros — precio por litro incompleto`,
        );
      }
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
          `${etiqueta} (fila compartida): $${Y.toLocaleString('es-MX', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} MXN de costos de este avión no restan en ninguna utilidad — prorrateo multi-avión pendiente de decisión del cliente`,
        );
      }
      // Gasto asignado a un avión que NO vuela ningún tramo del vuelo: no
      // aparecería en NINGÚN balance (regla sagrada: el dinero jamás
      // desaparece en silencio). Solo se evalúa en la fila del principal
      // para no duplicar el aviso.
      if (!esCompartido) {
        const avionesDelVuelo = new Set(
          [
            v.aeronave_id,
            ...vEscalas.map((e) => e.aeronave_id),
          ].filter((x): x is string => x != null),
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
        total_usd: I, // venta del vuelo = horas × tarifa c/IVA (regla del libro)
        iva_usd: J,
        tc_venta: K,
        total_mxn: L,
        iva_mxn: M,
        subtotal_mxn: N,
        tiempo_vuelo: O,
        taco_inicio: P,
        taco_fin: Q,
        gas_mxn: r2(gasMxn),
        gas_litros: gasLitros,
        gas_precio_litro: T,
        op_mxn: r2(opMxn),
        piloto_mxn: r2(pilotoMxn),
        otros_mxn: r2(otrosMxn),
        gas_detalle: gasDetalle,
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
    const filasOtros = gastosAvion.filter(
      (g) => g.categoria !== 'INDIRECTO' && g.categoria !== 'PERMISO',
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
    const hojaOtros = this.buildHoja(
      filasOtros,
      tcPromedio,
      horasVoladas,
      'otros gastos',
      pendientes,
    );
    const hojaPermisos = this.buildHoja(
      filasPermisos,
      tcPromedio,
      horasVoladas,
      'permisos',
      pendientes,
    );

    // ===== Balance (todo USD; null se propaga si falta TC) =====
    const utilidadAntes = totales.ganancia_usd;
    const hojasUsd = [hojaIndirectos.usd, hojaOtros.usd, hojaPermisos.usd];
    const utilidadDespues = hojasUsd.every((u) => u != null)
      ? round2(
          utilidadAntes -
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
        ((e.aeronave_id ?? avionPorVuelo.get(e.vuelo_id)) ?? null) !==
        aircraftId
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
      balance: {
        utilidad_antes_usd: utilidadAntes,
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
    // Sin partidas no hay nada que convertir: usd = 0 real, no null.
    const usd =
      totalMxn === 0
        ? 0
        : tcPromedio != null
          ? round2(totalMxn / tcPromedio)
          : null;
    const usdHr =
      usd != null && horasVoladas > 0 ? round2(usd / horasVoladas) : null;
    return { filas, total_mxn: totalMxn, usd, usd_hr: usdHr };
  }
}
