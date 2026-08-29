import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AircraftService } from './aircraft.service';
import {
  TipoCambioService,
  type TipoCambioDetalle,
} from '../tipo-cambio/tipo-cambio.service';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import {
  CATS_SIN_TUA_EMBEBIDO,
  desgloseGastoPartes,
  tuaEmbebidoDeGasto,
} from '../../common/desglose-gasto.util';
import { fetchRepartos } from '../../common/gasto-reparto.util';
import {
  cobradoParteAvion,
  ivaComisionVendedorUsd,
  pagoVendedorUsd,
  sobrecobroUsd,
  particionIngresoVuelo,
  type ParticionIngreso,
} from '../../common/ingreso-vuelo.util';
import {
  avionDelGasto,
  avionQueReporta,
  factorDe,
  parteFilaDeCobro,
  participacionPorAeronave,
  repartirUsd,
  type ParticipacionAeronave,
} from '../../common/participacion-aeronave.util';
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
  'id, folio, cliente_id, aeronave_id, estado, tipo, es_externo, operador_externo, costo_externo_usd, fecha_vuelo, fecha_solicitud, fecha_traslado_final, origen_iata, destino_iata, tiempo_cobrable_hr, tarifa_hora_usd, iva_pct, iva_usd, subtotal_vuelo_usd, ajuste_final_usd, tuas_usd, extras_total_usd, viaticos_pernocta_usd, monto_total_usd, monto_total_mxn, tc_usd_mxn, comision_vendedor_usd, cobrado, calculo_snapshot';

// Mapeo de categorías de gasto por vuelo (contrato del balance):
// GAS aparte (litros/$ x litro); PERMISO e INDIRECTO van a sus hojas propias.
// TUAS (regla 28-ago-2026): SOLO nota en la celda de OPERACIÓN — no suman en
// OP ni restan en ninguna hoja (el par TUA cobrado↔pagado vive en la pestaña
// "Otros movimientos" del Balance general).
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
  TAXI: 'Taxi / estacionamiento',
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
  /** Vuelo cubierto por un operador AJENO: quién (texto libre, p. ej. la
   *  matrícula XA-TYV) y lo que VuelaTour le paga en USD. Vive en el vuelo,
   *  NO en `gasto` — misma fuente que el reporte por vuelo y el reparto. */
  operador_externo?: string | null;
  costo_externo_usd?: string | number | null;
  fecha_vuelo: string | null;
  /** Día de la cotización: base del TC oficial de respaldo (27-ago). */
  fecha_solicitud?: string | null;
  fecha_traslado_final: string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  tiempo_cobrable_hr: string | number | null;
  tarifa_hora_usd: string | number | null;
  /** % de IVA de la cotización (fracción, ej. 0.16). */
  iva_pct?: string | number | null;
  iva_usd: string | number | null;
  /** Componentes del desglose (columnas persistidas): respaldo de la
   *  partición del ingreso cuando no hay snapshot v1.3. */
  subtotal_vuelo_usd?: string | number | null;
  ajuste_final_usd?: string | number | null;
  tuas_usd?: string | number | null;
  extras_total_usd?: string | number | null;
  viaticos_pernocta_usd?: string | number | null;
  monto_total_usd: string | number | null;
  monto_total_mxn: string | number | null;
  tc_usd_mxn: string | number | null;
  comision_vendedor_usd: string | number | null;
  cobrado: boolean | null;
  /** Snapshot del cotizador v1.3 (jsonb): desglose canónico e IVA. */
  calculo_snapshot?: unknown;
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
  /**
   * Tramo cancelado. La consulta los TRAE (verificación 28-ago): el mapa
   * escala→avión de `avionDelGasto` debe incluirlos (un gasto ligado a un
   * tramo cancelado sigue siendo de ese avión) y `participacionPorAeronave`
   * los excluye por su cuenta. Todo lo demás del libro (ruta, orden, horas,
   * tacos, recotizar) filtra `cancelada_at == null` localmente.
   */
  cancelada_at?: string | null;
  /** Tramo operativo (ferry / posicionamiento / parada técnica): no vende —
   *  no reparte la venta multi-avión (`participacionPorAeronave`). */
  solo_operativa?: boolean | null;
  es_ferry?: boolean | null;
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
  /** Comisión bancaria del cobro, en la MONEDA del cobro. */
  comision_banco_monto?: string | number | null;
  comision_banco_pct?: string | number | null;
  cuenta_destino?: string | null;
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
  /** Aeropuerto/lugar del gasto (IATA o texto libre): nota "Op CUN $x". */
  lugar?: string | null;
  medio_pago: string | null;
  proveedor: { nombre?: string } | { nombre?: string }[] | null;
  /** Lectura IA de la factura: conceptos para separar el TUA embebido. */
  valor_ia_extraido: {
    conceptos?: Array<{ concepto: string; monto: number }>;
  } | null;
  /** Clon parcial del reparto manual (gasto_reparto). */
  es_reparto_parcial?: boolean;
  /**
   * Solo en la consulta de COMBUSTIBLE del mes (fuente única `avionDelGasto`,
   * verificación 28-ago): avión crudo del tramo y del vuelo embebidos, para
   * resolver cargas de vuelos FUERA del periodo del libro sin otra consulta.
   */
  escala?:
    | { aeronave_id?: string | null }
    | { aeronave_id?: string | null }[]
    | null;
  vuelo?:
    | { aeronave_id?: string | null; es_externo?: boolean | null }
    | { aeronave_id?: string | null; es_externo?: boolean | null }[]
    | null;
}

/** Fila embebida (objeto o [objeto]) de PostgREST → objeto o null. */
function embebido<T extends object>(raw: T | T[] | null | undefined): T | null {
  const v: unknown = Array.isArray(raw) ? raw[0] : raw;
  return v && typeof v === 'object' ? (v as T) : null;
}

/** Etiqueta legible de la fuente del TC oficial (para celdas y avisos). */
function fuenteTcLegible(fuente: string | null | undefined): string {
  switch (fuente) {
    case 'OPEN_ER_API':
      return 'open.er-api';
    case 'ECB_FRANKFURTER':
      return 'BCE (frankfurter)';
    case 'BANXICO_FIX':
      return 'Banxico FIX (histórico)';
    default:
      return fuente ? String(fuente) : 'referencia';
  }
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

/** Fila embebida `vuelo:vuelo_id(…)` de un gasto (PostgREST: objeto o [objeto]). */
function vueloEmbebido(
  g: Record<string, unknown>,
): Record<string, unknown> | null {
  const raw: unknown = g.vuelo;
  const v: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/**
 * Vuelo EXTERNO sin avión de referencia: su dinero (gastos, GAS sin avión
 * sellado, costo del operador) vive en el libro EXTERNOS del mes del vuelo —
 * NO es "sin avión" para los avisos de flota ni para el pre-cierre.
 */
function esVueloExternoSinAvion(v: Record<string, unknown> | null): boolean {
  return v != null && v.es_externo === true && v.aeronave_id == null;
}

/**
 * Avión de un gasto leído con `escala:escala_id(aeronave_id)` y
 * `vuelo:vuelo_id(aeronave_id)` embebidos — la MISMA fuente única
 * `avionDelGasto` (escala → gasto → vuelo, con herencia) sin necesitar el
 * mapa de escalas del libro. Para avisos y filas sueltas.
 */
function avionDeGastoEmbebido(g: Record<string, unknown>): string | null {
  const esc = embebido(
    g.escala as { aeronave_id?: string | null } | null | undefined,
  );
  const mapa = new Map<string, { aeronave_id?: string | null }>();
  if (typeof g.escala_id === 'string' && esc) mapa.set(g.escala_id, esc);
  const vuelo = vueloEmbebido(g);
  return avionDelGasto(
    {
      escala_id: (g.escala_id as string | null) ?? null,
      aeronave_id: (g.aeronave_id as string | null) ?? null,
    },
    mapa,
    (vuelo?.aeronave_id as string | null) ?? null,
  );
}

/** "$1,234.00 MXN + $56.00 USD" — resumen por moneda para los avisos. */
function resumenMontosPorMoneda(
  filas: Array<{ monto?: unknown; moneda?: unknown }>,
): string {
  const porMoneda = new Map<string, number>();
  for (const g of filas) {
    const m = typeof g.moneda === 'string' && g.moneda ? g.moneda : 'MXN';
    porMoneda.set(m, (porMoneda.get(m) ?? 0) + (num(g.monto) ?? 0));
  }
  return [...porMoneda.entries()]
    .map(
      ([m, t]) =>
        `$${round2(t).toLocaleString('es-MX', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} ${m}`,
    )
    .join(' + ');
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
 * % de IVA REAL de la cotización como fracción (0.16): snapshot v1.3 →
 * columna iva_pct → 0.16 por default. Un valor en puntos (16) se normaliza.
 */
function ivaPctDe(v: VueloRow): number {
  const snap = v.calculo_snapshot as {
    iva?: { porcentaje?: unknown } | null;
  } | null;
  const raw = pos(snap?.iva?.porcentaje) ?? pos(v.iva_pct) ?? 0.16;
  return raw > 1 ? raw / 100 : raw;
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
   * indirectos (del avión sin vuelo), otros gastos (administrativos
   * repartidos), permisos, balance (bloques por avión), otros movimientos
   * (ingreso de VuelaTour: TUAS/extras/pernocta cobrados vs pagados, regla
   * 28-ago) y pendientes. Mismo motor y números que el individual; cero
   * cálculos paralelos. Vuelos multi-avión no se duplican en la suma:
   * horas/costos van al avión de cada tramo y la VENTA DEL AVIÓN se
   * reparte entre los aviones en partes iguales por tramo vendido (regla B
   * 28-ago, participacionPorAeronave: Σ partes == venta exacta); la parte
   * de VuelaTour (TUAs/extras/pernocta/comisión del vendedor) se informa
   * una sola vez, en la fila del avión que reporta (`avionQueReporta`: el
   * principal si participa; si no, el primer participante). El RESUMEN
   * cuenta VUELOS distintos en TOTALES (una fila por libro no es un vuelo
   * más), y Σ venta sigue siendo Σ de libros.
   *
   * Libro EXTERNOS (regla del cliente, 28-ago tarde): los vuelos cubiertos
   * por un operador ajeno SIN avión de referencia (es_externo, aeronave_id
   * null) son "un vuelo más" del general — mismo row-loop de buildPayload
   * en modo externos (avión pseudo 'EXTERNOS'): entran a la hoja maestra,
   * al RESUMEN (fila EXTERNOS) y a cobranza, con el costo del operador en
   * OPERACIONES. No generan bloque en la hoja "balance" (no tienen socios)
   * y sus TUAs/extras siguen la regla de todos en "Otros movimientos".
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

    // `libros` = TODO lo que consolida el general (aviones + EXTERNOS):
    // hoja maestra, cobranza, hojas de gastos, totales de flota.
    // `librosAviones` = solo aviones reales: bloques de la hoja "balance"
    // (los socios son POR avión; EXTERNOS no tiene y no genera bloque).
    const libros: BalanceAvionPayload[] = [];
    const librosAviones: BalanceAvionPayload[] = [];
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
    // UN memo de TC oficial por día para TODOS los libros y la pestaña
    // "Otros movimientos" (latencia, 28-ago): un mismo día se consulta una
    // sola vez al TC oficial de referencia (open.er-api / BCE) en todo el
    // general. Cero cambio numérico. Guarda el DETALLE (tc + fuente + día
    // del dato) para que cada fila diga de dónde salió su K.
    const memoTc = new Map<string, Promise<TipoCambioDetalle | null>>();
    // Vuelos DISTINTOS de la flota (verificación 28-ago): un vuelo
    // multi-avión es una fila en CADA libro (cada avión lo voló y lleva su
    // parte de la venta), así que Σ de la columna VUELOS del RESUMEN puede
    // superar este conteo — la fila TOTALES cuenta vuelos, no filas.
    const vuelosFlota = new Set<string>();
    // Libros sin actividad en el periodo: fuera (ruido en el general).
    // "Actividad" incluye el dinero de las HOJAS (verificación 26-ago:
    // XB-ANU sin vuelos pero con gas y otros gastos quedaba FUERA del
    // general y sus pesos restaban CERO veces — el dinero jamás
    // desaparece en silencio). Filas sin monto MXN (USD sin TC) también
    // cuentan como actividad: hay algo que resolver.
    const hojaConDinero = (hoja: {
      filas: Array<{ monto_mxn: number | null }>;
      total_mxn: number;
    }) => hoja.total_mxn !== 0 || hoja.filas.some((f) => f.monto_mxn == null);
    const tieneActividad = (p: BalanceAvionPayload): boolean => {
      const t = p.totales;
      return (
        p.vuelos.length > 0 ||
        t.costo_total_mxn !== 0 ||
        (t.total_mxn ?? 0) !== 0 ||
        hojaConDinero(p.combustible ?? { filas: [], total_mxn: 0 }) ||
        hojaConDinero(p.gastos_indirectos) ||
        hojaConDinero(p.otros_gastos) ||
        hojaConDinero(p.permisos)
      );
    };
    // UNA sola aritmética de RESUMEN para todos los libros (aviones y
    // EXTERNOS): fila = los TOTALES del libro, acumulados en `acc`.
    const registrar = (
      p: BalanceAvionPayload,
      color: string | null,
      esAvion: boolean,
    ) => {
      if (!tieneActividad(p)) return;
      const t = p.totales;
      // Color del avión (leyenda + filas teñidas — como la tabla "Color
      // calendario" del equipo; editable en el apartado del avión). El
      // libro EXTERNOS no tiene color: pyservices pinta sus filas en gris.
      p.avion_color = color;
      libros.push(p);
      if (esAvion) librosAviones.push(p);
      // "Gasto de combustible" del mes: columna propia en el RESUMEN.
      // Identidad IMPRESA en la leyenda del Excel: VENTA − COSTO −
      // COMBUSTIBLE = GANANCIA. Regla A (28-ago tarde): la comisión del
      // vendedor ya NO es costo del avión (es ingreso de VuelaTour con su
      // pago apareado en "Otros movimientos"), así que comisiones_mxn queda
      // en 0 — el campo se conserva por compatibilidad de shape con
      // pyservices. Filas COMPARTIDO ahora llevan su parte de la venta
      // (regla B) y su ganancia entra al cruce como cualquier fila; solo una
      // compartida SIN participación (tramos cancelados) tiene ganancia null.
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
      // Dedupe por vuelo (regla B): la venta sí se suma libro a libro (cada
      // uno lleva SU parte, Σ == venta del vuelo), pero el vuelo es uno.
      for (const f of p.vuelos) vuelosFlota.add(f.vuelo_id ?? f.clave);
      acc.vuelos = vuelosFlota.size;
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
    };
    for (const a of aviones ?? []) {
      registrar(
        await this.buildPayload(a.id as string, d, h, memoTc),
        (a.color_calendario as string | null) ?? null,
        true,
      );
    }
    // Libro EXTERNOS (regla 28-ago, tarde): vuelos de operador ajeno SIN
    // avión de referencia, con el MISMO row-loop. Entra al consolidado
    // (maestra, cobranza, totales) y al RESUMEN como una fila más; no a los
    // bloques de "balance" (sin socios). Solo si tuvo actividad.
    registrar(await this.buildPayload(null, d, h, memoTc), null, false);
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
    // TUA pagado de flota: null cuando la suma es 0 (celda vacía, no "$0").
    const tuaPagadoFlota = sumT((t) => t.tua_pagado_mxn ?? null);
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
      // Campos 28-ago (total del cliente, cobrado real, TUA nota, comisión
      // bancaria): sumas igual que el resto.
      cobrado_real_mxn: sumT((t) => t.cobrado_real_mxn ?? null),
      total_cotizacion_mxn: sumT((t) => t.total_cotizacion_mxn ?? null),
      tua_pagado_mxn: tuaPagadoFlota !== 0 ? tuaPagadoFlota : null,
      comision_banco_mxn: sumT((t) => t.comision_banco_mxn ?? null),
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
            // Secciones por matrícula en la hoja "combustible" (28-ago).
            matricula: p.matricula,
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
      otros_movimientos: await this.buildOtrosMovimientos(d, h, memoTc),
      pendientes: [
        // Cargas de combustible SIN avión: no aparecen en NINGÚN balance ni
        // en el reparto — el dinero jamás desaparece en silencio.
        ...(await this.pendienteGasSinAvion(d, h)),
        // Gastos de vuelos que no caen en NINGÚN libro (externo sin avión y
        // SIN fecha de vuelo): red de seguridad de la verificación 28-ago.
        ...(await this.pendienteGastosVueloSinLibro(d, h)),
        // Los vuelos EXTERNOS sin avión (y sus gastos / costo del operador)
        // viven en el libro EXTERNOS: sus pendientes salen abajo con el
        // prefijo "EXTERNOS:" como los de cualquier avión.
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
      // Bloques de la hoja "balance" (socios por avión): SOLO aviones
      // reales — el libro EXTERNOS no genera bloque.
      aviones: librosAviones,
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

  /**
   * TC OFICIAL de respaldo por vuelo — FUENTE ÚNICA de la cadena (28-ago):
   * solo para vuelos SIN tc_usd_mxn capturado → TC oficial de referencia
   * (open.er-api diario / BCE-frankfurter histórico, vía
   * `TipoCambioService.oficialDetallePara`) del día Cancún de la COTIZACIÓN
   * (fecha_solicitud; si no, el del vuelo). La usan la hoja maestra (PASO 0
   * de buildPayload) y la pestaña "Otros movimientos" del general: un mismo
   * vuelo se convierte con el MISMO K en ambos lados (antes la pestaña
   * usaba monto_total_mxn/monto_total_usd sin respaldo oficial y los pesos
   * no cuadraban entre hojas). Devuelve el DETALLE por vuelo (tc, fuente y
   * día real del dato) para que la fila lo publique.
   */
  private async tcOficialPorVuelos(
    vuelos: ReadonlyArray<{
      id: string;
      tc_usd_mxn?: unknown;
      fecha_solicitud?: unknown;
      fecha_vuelo?: unknown;
    }>,
    // Memo por DÍA compartido entre libros (latencia, 28-ago): el general
    // llamaba al TC oficial en serie por cada vuelo sin TC, por cada avión
    // y otra vez para la pestaña. Mismo día → misma promesa; cero cambio
    // numérico.
    memoPorDia: Map<string, Promise<TipoCambioDetalle | null>> = new Map(),
  ): Promise<Map<string, TipoCambioDetalle>> {
    const out = new Map<string, TipoCambioDetalle>();
    const str = (x: unknown): string | null =>
      typeof x === 'string' && x ? x : null;
    // Día de cada vuelo sin TC capturado (null = sin fecha: sin respaldo).
    const diaPorVuelo = new Map<string, string>();
    for (const v of vuelos) {
      if (pos(v.tc_usd_mxn) != null) continue;
      const dia = diaCancun(str(v.fecha_solicitud) ?? str(v.fecha_vuelo));
      if (dia) diaPorVuelo.set(v.id, dia);
    }
    // Verificación 28-ago: los días se resolvían EN SERIE (await dentro del
    // for) — el primer balance de un mes sin filas en tipo_cambio_oficial
    // pedía ~25 días al BCE uno tras otro. Ahora TODAS las promesas por día
    // se crean primero (memo compartido entre libros: un día = una promesa)
    // y se esperan después, con concurrencia acotada (~5 a la vez) para no
    // saturar a los proveedores. `oficialDetallePara` nunca lanza; el catch
    // es defensa (un día sin dato → sin respaldo, jamás rompe el libro).
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
    for (const dia of new Set(diaPorVuelo.values())) {
      if (memoPorDia.has(dia)) continue;
      memoPorDia.set(
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
    for (const [vueloId, dia] of diaPorVuelo) {
      const det = await memoPorDia.get(dia);
      if (det != null && det.tc > 0) out.set(vueloId, det);
    }
    return out;
  }

  /**
   * Libro de UN avión (`aircraftId`) o, con `aircraftId = null`, el libro
   * EXTERNOS (regla 28-ago tarde): los vuelos de operador ajeno SIN avión
   * de referencia (es_externo = true, aeronave_id null) con el MISMO
   * row-loop — solo cambian las consultas. En modo externos: avión pseudo
   * 'EXTERNOS' (sin permiso AFAC, sin servicio, sin socios), sin
   * compartidos ni gastos sin vuelo ni reparto parcial (hojas de
   * indirectos/otros/permisos vacías salvo PERMISO/INDIRECTO ligados a esos
   * vuelos; hoja combustible = GAS de esos vuelos SIN avión sellado — con
   * avión de flota vive en la hoja de ese avión), TODOS los gastos de esos
   * vuelos sin importar su
   * aeronave_id (no hay avión de flota que los reclame), sin tacos (horas
   * vacías), cobros/facturas por vuelo_id y K = tc_usd_mxn ?? oficial como
   * cualquier vuelo. El costo del operador entra a OPERACIONES en la fila.
   */
  private async buildPayload(
    aircraftId: string | null,
    desde: string,
    hasta: string,
    memoTc: Map<string, Promise<TipoCambioDetalle | null>> = new Map(),
  ): Promise<BalanceAvionPayload> {
    const sb = this.supabase.service;
    const modoExternos = aircraftId == null;

    interface AvionBalance {
      id: string | null;
      matricula: string;
      modelo: string | null;
      permiso_afac_usd_hr: unknown;
      servicio_intervalos: unknown;
      servicio_horas_base: unknown;
    }
    let avion: AvionBalance;
    if (modoExternos) {
      avion = {
        id: null,
        matricula: 'EXTERNOS',
        modelo: null,
        permiso_afac_usd_hr: null,
        servicio_intervalos: [],
        servicio_horas_base: 0,
      };
    } else {
      const { data: avionRow, error: avionErr } = await sb
        .from('aeronave')
        .select(
          'id, matricula, modelo, permiso_afac_usd_hr, servicio_intervalos, servicio_horas_base',
        )
        .eq('id', aircraftId)
        .maybeSingle();
      if (avionErr) throw new Error(avionErr.message);
      if (!avionRow)
        throw new NotFoundException(`Aeronave ${aircraftId} not found`);
      avion = avionRow;
    }
    const matricula = avion.matricula;
    // Prefijo de los pendientes a nivel libro ("Avión XB-PEV: …" /
    // "Externos: …").
    const etiquetaAvion = modoExternos ? 'Externos' : `Avión ${matricula}`;

    // TODOS los estados, CANCELADO incluido: el Excel registra vuelos
    // cancelados con costos ya incurridos (se marcan por estado).
    // Modo externos: es_externo = true AND aeronave_id IS NULL (los externos
    // CON avión de referencia viven en el libro de ese avión).
    const vuelosQuery = sb.from('vuelo').select(VUELO_COLS);
    const vuelosRes = await (
      modoExternos
        ? vuelosQuery.eq('es_externo', true).is('aeronave_id', null)
        : vuelosQuery.eq('aeronave_id', aircraftId)
    )
      .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`)
      .order('fecha_vuelo', { ascending: true });
    if (vuelosRes.error) throw new Error(vuelosRes.error.message);
    const vuelos = (vuelosRes.data ?? []) as VueloRow[];

    // VUELOS COMPARTIDOS (multi-avión, 17-ago-2026): tramos volados por ESTE
    // avión dentro de vuelos cuyo avión principal es OTRO. El vuelo aparece
    // en AMBOS balances — cada avión con SUS tramos, horas y gastos. Regla B
    // del cliente (28-ago tarde): la VENTA DEL AVIÓN (y sus cobros, por
    // cobrar y horas cobradas) se REPARTE entre los aviones por tramo con
    // `participacionPorAeronave` (fuente única; Σ partes == venta exacta) —
    // cada fila lleva SU parte y la ruta dice el porcentaje. (No aplica a
    // EXTERNOS: no hay avión de flota que vuele tramos ajenos.)
    const idsPropios = new Set(vuelos.map((v) => v.id));
    const { data: escalasAjenas, error: eaErr } = modoExternos
      ? { data: [], error: null }
      : await sb
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
    // TRAMO CANCELADO de este avión en un vuelo AJENO con GASTOS ligados
    // (verificación 28-ago): `escalasAjenas` filtra `cancelada_at null`, así
    // que si el único tramo de este avión se canceló el vuelo no entraba a
    // este libro — pero un gasto ligado a ese tramo ES de este avión
    // (contrato de `avionDelGasto`) y el reparto y el Libro Dinero sí lo
    // cargan aquí: el libro del avión lo perdía en silencio. Segunda
    // consulta: tramos cancelados de este avión en el periodo → gastos
    // ligados a ellos → vuelos. Esos vuelos entran con factor 0 (sin venta,
    // cobros ni horas: el tramo no voló) y su fila solo carga esos gastos
    // ("· TRAMO CANCELADO (solo gastos)"); sin gastos, el vuelo no entra
    // (ninguna fila vacía en el general).
    const vuelosSoloGastosCancelados = new Set<string>();
    if (!modoExternos) {
      const { data: escCanceladas, error: ecErr } = await sb
        .from('escala')
        .select('id, vuelo_id, vuelo:vuelo_id!inner(fecha_vuelo)')
        .eq('aeronave_id', aircraftId)
        .not('cancelada_at', 'is', null)
        .gte('vuelo.fecha_vuelo', `${desde}T00:00:00-05:00`)
        .lte('vuelo.fecha_vuelo', `${hasta}T23:59:59-05:00`);
      if (ecErr) throw new Error(ecErr.message);
      const yaEnLibro = new Set([...idsPropios, ...idsCompartidos]);
      const vueloDeEscala = new Map<string, string>();
      for (const e of escCanceladas ?? []) {
        const vid = e.vuelo_id as string;
        if (!yaEnLibro.has(vid)) vueloDeEscala.set(e.id as string, vid);
      }
      if (vueloDeEscala.size > 0) {
        const { data: gastosTramo, error: gtErr } = await sb
          .from('gasto')
          .select('escala_id')
          .in('escala_id', [...vueloDeEscala.keys()]);
        if (gtErr) throw new Error(gtErr.message);
        for (const g of gastosTramo ?? []) {
          const vid = vueloDeEscala.get(g.escala_id as string);
          if (vid) vuelosSoloGastosCancelados.add(vid);
        }
      }
      if (vuelosSoloGastosCancelados.size > 0) {
        const { data: conGastos, error: cgErr } = await sb
          .from('vuelo')
          .select(VUELO_COLS)
          .in('id', [...vuelosSoloGastosCancelados])
          .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
          .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`);
        if (cgErr) throw new Error(cgErr.message);
        vuelos.push(...((conGastos ?? []) as VueloRow[]));
        vuelos.sort((a, b) =>
          String(a.fecha_vuelo ?? '').localeCompare(
            String(b.fecha_vuelo ?? ''),
          ),
        );
      }
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
              'id, vuelo_id, orden, origen_iata, destino_iata, taco_salida, taco_llegada, aeronave_id, cancelada_at, solo_operativa, es_ferry, fecha_salida_plan, taco_salida_obs, taco_llegada_obs, taco_obs_updated_by, taco_obs_updated_at',
            )
            .in('vuelo_id', vueloIds)
            // Tramos cancelados INCLUIDOS (verificación 28-ago): el mapa
            // escala→avión de `avionDelGasto` los necesita (un gasto ligado
            // a un tramo cancelado sigue siendo de ese avión) y
            // `participacionPorAeronave` los excluye por su cuenta. Ruta,
            // orden, horas, tacos y recotizar filtran `cancelada_at == null`
            // localmente (comportamiento previo intacto).
            .order('orden', { ascending: true })
        : Promise.resolve(vacio),
      vueloIds.length
        ? sb
            .from('cobro_vuelo')
            .select(
              'vuelo_id, monto, moneda, tc_usd_mxn, metodo_cobro, fecha_cobro, comision_banco_monto, comision_banco_pct, cuenta_destino',
            )
            .in('vuelo_id', vueloIds)
            .order('fecha_cobro', { ascending: true })
        : Promise.resolve(vacio),
      vueloIds.length
        ? sb
            .from('gasto')
            .select(
              'id, vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, lugar, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre)',
            )
            .in('vuelo_id', vueloIds)
            .order('fecha_gasto', { ascending: true })
        : Promise.resolve(vacio),
      // Gastos del avión SIN vuelo en el periodo (fecha_gasto es DATE:
      // comparación de días, sin componente horaria). EXTERNOS no tiene
      // avión: nada que leer (los gastos sin vuelo son de la empresa).
      aircraftId != null
        ? sb
            .from('gasto')
            .select(
              'id, vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, lugar, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre)',
            )
            .eq('aeronave_id', aircraftId)
            .is('vuelo_id', null)
            .gte('fecha_gasto', desde)
            .lte('fecha_gasto', hasta)
            .order('fecha_gasto', { ascending: true })
        : Promise.resolve(vacio),
      // COMBUSTIBLE del MES (regla 26-ago-2026): el gas se controla POR
      // AVIÓN + fecha_gasto, con o sin vuelo. Verificación 28-ago: el avión
      // de cada carga se resuelve con la FUENTE ÚNICA `avionDelGasto`
      // (escala → gasto → vuelo, con herencia), igual que el resto de los
      // lectores (fila del vuelo, reparto a socios, Libro Dinero) — el
      // filtro crudo por aeronave_id mandaba una carga del tramo del OTRO
      // avión al libro del principal (los flujos de captura sellan el
      // principal). Por eso se traen TODAS las cargas del periodo (eje
      // fecha_gasto) con el avión crudo del tramo y del vuelo embebidos, y
      // abajo (hoja "combustible") se quedan las que resuelven a ESTE avión:
      // Σ de las hojas de la flota == Σ de las cargas del mes, cada una en
      // un solo libro. Cargas de vuelos FUERA del periodo del libro (vuelo
      // de julio, carga en agosto) se resuelven con esos embebidos — sin
      // otra consulta. Ya no se persigue la asignación por vuelo (el
      // vuelo_id del gasto queda informativo).
      // EXTERNOS (verificación 28-ago): el GAS de sus vuelos SIN avión
      // sellado (aeronave_id null) SIGUE AL VUELO como el resto de sus
      // gastos — hoja "combustible" de este libro (antes caía a "gas sin
      // avión" del general y al pre-cierre, que bloqueaba el mes por un
      // externo). Con avión de flota sellado ya vive en la hoja de ESE
      // avión: no se duplica. Sin filtro de fecha_gasto a propósito: el
      // externo vive en el EXTERNOS del mes de su fecha_vuelo y los avisos
      // de "gas sin avión" (eje fecha_gasto) lo excluyen — con eje
      // fecha_gasto una carga de otro mes no caería en ningún libro.
      aircraftId != null
        ? sb
            .from('gasto')
            .select(
              'id, vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, lugar, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre), escala:escala_id(aeronave_id), vuelo:vuelo_id(aeronave_id, es_externo)',
            )
            .eq('categoria', 'GAS')
            .gte('fecha_gasto', desde)
            .lte('fecha_gasto', hasta)
            .order('fecha_gasto', { ascending: true })
        : vueloIds.length
          ? sb
              .from('gasto')
              .select(
                'id, vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, lugar, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre)',
              )
              .in('vuelo_id', vueloIds)
              .is('aeronave_id', null)
              .eq('categoria', 'GAS')
              .order('fecha_gasto', { ascending: true })
          : Promise.resolve(vacio),
      aircraftId != null
        ? sb
            .from('aeronave_socio')
            .select(
              'socio_id, porcentaje, vigente_desde, vigente_hasta, usuario:socio_id(nombre)',
            )
            .eq('aeronave_id', aircraftId)
        : Promise.resolve(vacio),
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
          `Balance ${matricula}: fallo al leer ${nombre}: ${res.error.message}`,
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
    // Cargas del mes de TODA la flota (modo avión) o del libro EXTERNOS; el
    // filtro por avión (`avionDelGasto`) se aplica abajo, con el mapa de
    // escalas del libro ya armado (hoja "combustible").
    const gastosGasMes = (gastosGasRes.data ?? []) as unknown as GastoRow[];

    // ===== REPARTO MANUAL (gasto_reparto, 26-ago-2026) =====
    // Regla única (misma que el reparto a socios): el reparto GANA sobre
    // aeronave_id. (1) Un gasto de ESTE avión que fue repartido se EXCLUYE
    // (sus parciales mandan); (2) los PARCIALES hacia este avión entran como
    // filas sintéticas con el monto parcial y la moneda/TC del padre — un
    // gasto SIN avión repartido hacia acá no entraba con el filtro crudo.
    // El remanente no se carga a nadie (gasto de la EMPRESA VuelaTour).
    // EXTERNOS no recibe reparto (no es un avión).
    const repartosHaciaAvionRes =
      aircraftId != null
        ? await sb
            .from('gasto_reparto')
            .select(
              'aeronave_id, monto, gasto:gasto_id!inner(id, vuelo_id, escala_id, categoria, monto, propina, moneda, tc_gasto, litros, fecha_gasto, notas, lugar, medio_pago, aeronave_id, valor_ia_extraido, proveedor:proveedor_id(nombre))',
            )
            .eq('aeronave_id', aircraftId)
            .is('gasto.vuelo_id', null)
            .gte('gasto.fecha_gasto', desde)
            .lte('gasto.fecha_gasto', hasta)
        : vacio;
    if (repartosHaciaAvionRes.error) {
      throw new Error(
        `Balance ${matricula}: fallo al leer repartos: ${repartosHaciaAvionRes.error.message}`,
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
        // Tramos cancelados fuera del orden (como siempre).
        .filter((e) => e.cancelada_at == null)
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
    // "tramos también en X") y, en EXTERNOS, para señalar en la nota de la
    // celda el avión de flota al que se selló un gasto del vuelo ajeno.
    const matriculaPorAvion = new Map<string, string>(
      aircraftId != null ? [[aircraftId, matricula]] : [],
    );
    const otrosAvionIds = [
      ...new Set([
        ...vuelos.map((v) => v.aeronave_id),
        ...escalas.map((e) => e.aeronave_id),
        ...(modoExternos ? gastosVuelo.map((g) => g.aeronave_id) : []),
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
    // Vuelo sin TC capturado en la cotización: se usa el TC oficial de
    // referencia (open.er-api / BCE) del día de la COTIZACIÓN
    // (fecha_solicitud; si no, el del vuelo). La fila queda MARCADA
    // (tc_venta_oficial + fuente + día del dato) y el Excel la pinta.
    // MISMA cadena que "Otros movimientos" del general (tcOficialPorVuelos).
    const tcOficialPorVuelo = await this.tcOficialPorVuelos(vuelos, memoTc);

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
        : (pos(v.tc_usd_mxn) ?? tcOficialPorVuelo.get(v.id)?.tc ?? null);
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
    // INGRESO DE VUELATOUR (regla del cliente, 28-ago-2026): TUAS + extras
    // + pernocta + comisión del vendedor cobrados + su IVA quedan FUERA de
    // la venta de cada fila (particionIngresoVuelo, fuente única). Este
    // acumulado es lo EXCLUIDO: Σ filas.total_usd + otros_ingresos_usd ==
    // Σ monto_total_usd de los vuelos propios con precio NO cancelados
    // (regla 28-ago tarde: en un CANCELADO la venta es lo realmente
    // cobrado, sin partición — aporta 0 aquí). En vuelos MULTI-AVIÓN
    // (regla B) la identidad cierra entre los libros (la venta se reparte
    // por tramo; la parte de VuelaTour solo la informa el avión que
    // reporta — `avionQueReporta`). Vive
    // en la pestaña "Otros movimientos" del Balance general; aquí solo se
    // informa al pie (no suma en columnas).
    let otrosIngresosPeriodoUsd = 0;
    // Aeropuerto de cada gasto de OPERACIÓN (nota "Op CUN $x · Op MHL $y"
    // como el libro manual del cliente, 28-ago): se resuelve por `lugar`,
    // por el tramo (escala_id → destino) o por el texto de la nota/proveedor
    // contra el catálogo (IATA, ciudad, nombre) de los aeropuertos de la ruta.
    const { data: catAeropuertos } = await sb
      .from('aeropuerto')
      .select('iata, nombre, ciudad');
    const aeropuertoPorIata = new Map<
      string,
      { iata: string; tokens: string[] }
    >();
    const normalizar = (t: unknown): string =>
      (typeof t === 'string' ? t : '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    for (const a of (catAeropuertos ?? []) as Array<{
      iata: string;
      nombre: string | null;
      ciudad: string | null;
    }>) {
      const iata = String(a.iata ?? '').toUpperCase();
      if (!iata) continue;
      const tokens = [normalizar(a.ciudad), normalizar(a.nombre)]
        .map((x) => x.trim())
        .filter((x) => x.length >= 4);
      aeropuertoPorIata.set(iata, { iata, tokens });
    }
    // Mapa escala → fila, CON tramos cancelados (contrato de `avionDelGasto`:
    // un gasto ligado a un tramo cancelado sigue siendo de ese avión).
    const escalaPorId = new Map<string, EscalaRow>();
    for (const list of escalasPorVuelo.values())
      for (const e of list) escalaPorId.set(e.id, e);

    for (const v of vuelos) {
      // TODOS los tramos (cancelados incluidos): solo para la participación
      // (el util filtra) y para saber qué aviones tocó el vuelo (gastos).
      const vEscalasTodas = escalasPorVuelo.get(v.id) ?? [];
      // Tramos ACTIVOS: ruta, horas, tacos, recotizar (como siempre).
      const vEscalas = vEscalasTodas.filter((e) => e.cancelada_at == null);
      const esExterno = v.es_externo === true;
      // Fila COMPARTIDA: este avión voló tramos de un vuelo cuyo principal
      // es OTRO avión. (Nunca en EXTERNOS.)
      const esCompartido = !modoExternos && v.aeronave_id !== aircraftId;
      // Vuelo ajeno cuyo ÚNICO tramo de este avión se CANCELÓ y que entra al
      // libro solo por los gastos ligados a ese tramo (ver la consulta de
      // arriba): factor 0 (sin venta/cobros/horas), la fila solo carga
      // esos gastos y no se regaña por tacómetros.
      const soloGastosCancelado = vuelosSoloGastosCancelados.has(v.id);
      // ===== PARTICIPACIÓN POR AVIÓN (regla B del cliente, 28-ago tarde) =====
      // Fuente única `participacionPorAeronave`: en vuelos multi-avión la
      // VENTA DEL AVIÓN y lo que deriva de ella (IVA, horas cobradas, cobros,
      // por cobrar, retenido en cancelados) se reparte en partes iguales por
      // tramo VENDIDO entre los aviones (los tramos operativos — ferry /
      // posicionamiento — no venden); `factor` es la fracción de ESTE avión
      // (1 en vuelos de un solo avión; 0 si no participa). Los GASTOS no se
      // reparten (van al avión del tramo, `avionDelGasto`) y la parte de
      // VuelaTour no es de ningún avión (se informa una vez, en la fila del
      // avión que REPORTA — ver `reporta`).
      // EXTERNOS y vuelos es_externo: sin reparto (no hay avión de flota) —
      // factor 1 en la fila del principal, 0 en una compartida (como antes).
      const part: ParticipacionAeronave | null =
        modoExternos || esExterno
          ? null
          : participacionPorAeronave(v, vEscalasTodas);
      const factor =
        part != null ? factorDe(part, aircraftId) : esCompartido ? 0 : 1;
      const multiAvion = part?.multi_avion === true;
      // ¿Esta fila lleva (una parte de) la venta del avión?
      const conParte = factor > 0;
      // ¿Esta fila REPORTA la parte de VuelaTour (otros ingresos) y los
      // avisos de cotización/cobranza del vuelo? Fuente única
      // `avionQueReporta` (verificación 28-ago): el principal si participa;
      // si su único tramo se canceló y el regreso lo voló otro avión
      // (factor 0 en el principal), el primer avión participante — así la
      // parte de VuelaTour no desaparece de todos los libros y el principal
      // no grita "sin cotización"/"sin cobros" por una venta que no es suya.
      // En vuelos de un solo avión sigue siendo el principal; EXTERNOS y
      // es_externo (sin participación): la fila del principal, como antes.
      const reporta =
        part != null ? avionQueReporta(part) === aircraftId : !esCompartido;
      // Parte de ESTE avión de un monto del VUELO (USD, MXN u horas): en
      // multi-avión, centavos por residuo mayor (`repartirUsd`) — Σ partes
      // entre los libros == monto exacto. JAMÁS monto × factor redondeado
      // por separado en cada avión (descuadra centavos entre libros). Sin
      // reparto (un solo avión): el monto tal cual (cero cambio numérico
      // respecto al libro de siempre; 0 si este avión no participa).
      const parteAvion = (monto: number): number =>
        part == null || !part.multi_avion
          ? factor > 0
            ? monto
            : 0
          : (repartirUsd(monto, part).get(aircraftId as string) ?? 0);
      // Cobros del vuelo: TODAS las filas los leen (la compartida reparte su
      // parte; antes iban vacíos porque la venta vivía solo en el principal).
      const vCobros = cobrosPorVuelo.get(v.id) ?? [];
      // Gastos del avión del TRAMO: en vuelos multi-avión cada balance carga
      // SOLO los gastos de su avión — fuente única `avionDelGasto` (misma
      // prioridad en balance, reparto y Libro Dinero): avión de la ESCALA
      // del gasto con herencia (los flujos de captura suelen sellar el avión
      // PRINCIPAL aunque el gasto sea del tramo del otro — la escala no
      // miente) → gasto.aeronave_id → avión del vuelo.
      // EXTERNOS: TODOS los gastos del vuelo, con o sin aeronave_id — el
      // libro de un avión solo lee gastos de SUS vuelos y los sin vuelo de
      // su fecha, así que un gasto de un vuelo ajeno sellado a un avión de
      // flota no vive en ningún otro lado (la nota dice la matrícula).
      const avionDelGastoV = (g: GastoRow): string | null =>
        avionDelGasto(g, escalaPorId, v.aeronave_id);
      const vGastos = modoExternos
        ? (gastosPorVuelo.get(v.id) ?? [])
        : (gastosPorVuelo.get(v.id) ?? []).filter(
            (g) => avionDelGastoV(g) === aircraftId,
          );
      const z = zPorVuelo.get(v.id) ?? null;
      // Vuelo CANCELADO (regla del cliente 28-ago, tarde): puede tener
      // dinero REAL — cobros que NO se reembolsan (cargo por cancelación /
      // anticipo retenido) y gastos (se voló a recoger a la gente,
      // cancelaron y regresó ferry). Su VENTA es lo realmente cobrado
      // (100 % del avión, sin partición: TUAS/extras nunca se pagaron) y
      // nada queda "por cobrar"; los costos se listan como en cualquier
      // vuelo. Antes la fila tomaba la VENTA de la cotización como si se
      // hubiera volado y mostraba "por cobrar" contra ese total — falso.
      const cancelado = v.estado === 'CANCELADO';
      const operadorExterno =
        typeof v.operador_externo === 'string' && v.operador_externo.trim()
          ? v.operador_externo.trim()
          : null;

      // Ruta operativa: concatenación de escalas; fallback origen→destino.
      const codigos = vEscalas.length
        ? [
            vEscalas[0].origen_iata ?? '?',
            ...vEscalas.map((e) => e.destino_iata ?? '?'),
          ]
        : [v.origen_iata ?? '?', v.destino_iata ?? '?'];
      // Aviso multi-avión en la RUTA (regla B): cada fila dice su porcentaje
      // de la venta del avión, con quién la comparte y el peso del reparto.
      // Los "otros" aviones salen de la participación (herencia incluida:
      // un tramo sin avión propio es del principal); sin participación
      // (es_externo) se cae a los aviones explícitos de los tramos.
      const otrosAvionIdsFila = part
        ? [...part.factores.keys()].filter((id) => id !== aircraftId)
        : modoExternos
          ? []
          : [
              ...new Set(
                vEscalas
                  .map((e) => e.aeronave_id)
                  .filter(
                    (id): id is string => id != null && id !== aircraftId,
                  ),
              ),
            ];
      const otrasMatriculas = otrosAvionIdsFila.map(
        (id) => matriculaPorAvion.get(id) ?? '¿?',
      );
      const pctTexto = `${(Math.round(factor * 1000) / 10).toLocaleString(
        'es-MX',
      )} %`;
      // Peso del reparto (fuente única): `participacionPorAeronave` solo
      // emite 'tramos' (partes iguales por tramo vendido) o 'unico' — nunca
      // horas (ni cotizadas ni tacos: regla literal del cliente, #105
      // "mitad y mitad").
      const pesoTexto =
        part?.fuente === 'tramos'
          ? 'reparto por tramo (partes iguales por tramo vendido)'
          : null;
      // Vuelo EXTERNO (operador ajeno, con o sin avión de referencia): la
      // ruta lo dice — "… · EXTERNO XA-TYV".
      const rutaBase = `${codigos.join('-')}${
        esExterno ? ` · EXTERNO ${operadorExterno ?? '¿?'}` : ''
      }`;
      // Tramos CANCELADOS de este avión (etiqueta de la fila "solo gastos").
      const tramosCanceladosTexto = vEscalasTodas
        .filter(
          (e) =>
            e.cancelada_at != null &&
            (e.aeronave_id ?? v.aeronave_id) === aircraftId,
        )
        .map((e) => `${e.origen_iata ?? '?'}→${e.destino_iata ?? '?'}`)
        .join(', ');
      const ruta = esCompartido
        ? soloGastosCancelado
          ? `${rutaBase} · TRAMO CANCELADO (solo gastos${
              tramosCanceladosTexto ? `: ${tramosCanceladosTexto}` : ''
            }; venta en ${
              matriculaPorAvion.get(v.aeronave_id ?? '') ?? 'el avión principal'
            })`
          : conParte
            ? `${rutaBase} · COMPARTIDO ${pctTexto} (con ${
                matriculaPorAvion.get(v.aeronave_id ?? '') ??
                'el avión principal'
              }${pesoTexto ? ` · ${pesoTexto}` : ''})`
            : `${rutaBase} · COMPARTIDO (sin venta aquí: sus tramos no participan; venta en ${
                matriculaPorAvion.get(v.aeronave_id ?? '') ??
                'el avión principal'
              })`
        : part != null && !conParte && otrasMatriculas.length
          ? // Principal SIN participación (su único tramo vendido se canceló
            // y el resto lo voló otro avión): la venta — y la parte de
            // VuelaTour — la reporta el otro libro (`avionQueReporta`).
            `${rutaBase} · SIN VENTA AQUÍ (sus tramos no participan; venta en ${otrasMatriculas.join(
              ', ',
            )})`
          : multiAvion
            ? `${rutaBase} · ${pctTexto} (tramos también en ${otrasMatriculas.join(
                ', ',
              )}${pesoTexto ? ` · ${pesoTexto}` : ''})`
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
      // REGLA DEL CLIENTE (28-ago-2026, sustituye a la del 7-ago): el TOTAL
      // de la fila es la VENTA DEL AVIÓN = tiempo de vuelo + ajuste + el IVA
      // proporcional de esas partes (particionIngresoVuelo, fuente única —
      // jamás recalcular a mano). TUAS, extras, pernocta y la COMISIÓN DEL
      // VENDEDOR (regla A, 28-ago tarde: "como un extra") con su IVA son
      // INGRESO DE VUELATOUR: salen de la fila (otros_ingresos_usd) y viven
      // en la pestaña "Otros movimientos" del general, donde el pago al
      // vendedor se aparea como egreso. La venta por horas (D×H) queda como
      // columna informativa.
      // MULTI-AVIÓN (regla B): la venta del avión, su IVA, las horas
      // cobradas y los cobros se reparten por tramo con `parteAvion`
      // (repartirUsd: Σ partes entre libros == monto del vuelo exacto); la
      // fila compartida lleva SU parte y la del principal la suya. Una fila
      // sin participación (factor 0) va con el bloque venta vacío.
      // CANCELADO: no se cobran horas (la venta es lo retenido, abajo).
      // Horas cobradas de TODO el viaje (candado "recotizar" del principal).
      const horasCobrablesVuelo = cancelado
        ? 0
        : (num(v.tiempo_cobrable_hr) ?? 0);
      // D = parte de este avión de las horas cobradas (mismo reparto por
      // residuo mayor que el dinero: Σ D entre libros == horas del vuelo).
      const D = conParte ? parteAvion(horasCobrablesVuelo) : 0; // horas cobradas
      const E = conParte ? num(v.tarifa_hora_usd) : null;
      // Total del VUELO que paga el cliente (sin repartir: pendientes y red
      // de seguridad de "pagado completo" comparan contra el vuelo entero).
      const totalSistemaUsd = conParte ? num(v.monto_total_usd) : null;
      const ivaSistemaUsd = conParte ? num(v.iva_usd) : null;
      // Partición del ingreso (null sin participación: sin venta aquí).
      // pPrecio = la partición SOLO cuando hay precio (> 0); sin precio la
      // fila cae al respaldo horas × tarifa como siempre.
      const p: ParticionIngreso | null = conParte
        ? particionIngresoVuelo(v)
        : null;
      // CANCELADO: la partición NO aplica a la venta (p queda solo para el
      // total informativo de la cotización); I/J salen de los cobros.
      const pPrecio = p != null && p.total_usd > 0 && !cancelado ? p : null;
      // Con/sin IVA por vuelo (columna G del libro): si la cotización lleva
      // IVA, G = E × iva_pct REAL de la cotización (snapshot/columna; 0.16
      // si no hay dato); si no (sin factura / efectivo), 0.
      const conIva = (ivaSistemaUsd ?? 0) > 0;
      const G = E != null ? (conIva ? round2(E * ivaPctDe(v)) : 0) : null;
      const H = E != null ? round2(E + (G ?? 0)) : null;
      // Venta por horas (informativa) — el libro original la usaba como la
      // fila entera.
      const ventaHorasUsd = H != null && D > 0 ? round2(D * H) : null;
      // VENTA DEL AVIÓN (I) y su IVA proporcional (J). Sin cotización,
      // respaldo = horas × tarifa. Si el desglose no cuadra con el total
      // (pPrecio.inconsistente) la partición devuelve el total COMPLETO al
      // avión (no inventa dinero) y se avisa en pendientes.
      const kCapturado = pos(v.tc_usd_mxn);
      const kDetalle = kCapturado == null ? tcOficialPorVuelo.get(v.id) : null;
      const K = kCapturado ?? kDetalle?.tc ?? null;
      const kOficial = kCapturado == null && K != null;
      // CANCELADO (regla 28-ago tarde): VENTA = lo realmente cobrado —
      // cobrosEnUsd (fuente única; 100 % del avión, sin partición: los
      // TUAS/extras nunca se pagaron). Un cobro MXN sin TC toma K de
      // respaldo; si tampoco hay, se EXPONE en pendientes (jamás se suma
      // crudo). Si la cotización llevaba IVA, el cobro lo incluye: J se
      // desglosa hacia atrás con el iva_pct real. Sin cobros → venta $0
      // (los costos siguen restando: es la pérdida real del cancelado).
      // MULTI-AVIÓN: lo retenido también se reparte (parteAvion).
      const cobrosCancelado =
        cancelado && conParte ? cobrosEnUsd(vCobros, K) : null;
      let I: number | null;
      let J: number | null;
      if (cobrosCancelado != null) {
        I = parteAvion(cobrosCancelado.total_usd);
        const conIvaCancelado = conIva || pos(v.iva_pct) != null;
        J = conIvaCancelado ? round2(I - I / (1 + ivaPctDe(v))) : 0;
      } else {
        // Parte de ESTE avión de la venta del avión y de su IVA (regla B);
        // en vuelos de un solo avión parteAvion devuelve el monto tal cual.
        I = pPrecio != null ? parteAvion(pPrecio.avion_usd) : ventaHorasUsd;
        J =
          pPrecio != null
            ? parteAvion(pPrecio.iva_avion_usd)
            : ivaSistemaUsd != null
              ? parteAvion(ivaSistemaUsd)
              : G != null && D > 0
                ? round2(D * G)
                : null;
      }
      const L = I != null && K != null ? round2(I * K) : null;
      const M = J != null && K != null ? round2(J * K) : null;
      const N = L != null ? round2(L - (M ?? 0)) : null;
      // Ingreso de VUELATOUR de la fila (TUAS + extras + pernocta + comisión
      // del vendedor + su IVA + centavos de redondeo), EXCLUIDO de I: cierra
      // al centavo contra el total del cliente (I + otrosIngresosUsd ==
      // monto_total_usd en vuelos de un solo avión; en multi-avión, Σ I de
      // los libros + otrosIngresosUsd del principal == monto_total_usd).
      // No es de ningún avión: SOLO en la fila del avión que REPORTA
      // (`avionQueReporta`: el principal si participa; si no, el primer
      // participante) — 0 en las demás filas, que sí llevan su parte de la
      // venta.
      // CANCELADO: 0 — su dinero real ya es venta del avión; nada de la
      // cotización va a "Otros movimientos" (allá solo quedan sus egresos).
      const otrosIngresosUsd =
        p == null ? null : cancelado || !reporta ? 0 : p.vuelatour_usd;
      if (otrosIngresosUsd != null) otrosIngresosPeriodoUsd += otrosIngresosUsd;
      // Total de la cotización (lo que paga el cliente) y factor de venta —
      // informativos al lado de la venta del avión para que el cruce se vea.
      // MULTI-AVIÓN con precio: total de la FILA = su parte de la venta +
      // la parte de VuelaTour si esta fila la reporta (Σ filas de los libros
      // == total del cliente; así el consolidado no duplica la cotización).
      // Total del VUELO (sin repartir) para la red de seguridad de "pagado
      // completo". CANCELADO: la cotización viaja solo como referencia (sin
      // repartir). Si el principal no participa (factor 0) su fila no lleva
      // partición (p null) y el total del cliente lo publica completo el
      // avión que reporta (venta 100 % + VuelaTour).
      const totalCotizacionVueloUsd =
        totalSistemaUsd != null ? round2(totalSistemaUsd) : null;
      const totalCotizacionVueloMxn =
        totalCotizacionVueloUsd != null && K != null
          ? round2(totalCotizacionVueloUsd * K)
          : null;
      const totalCotizacionUsd =
        multiAvion && !cancelado && p != null
          ? round2((I ?? 0) + (otrosIngresosUsd ?? 0))
          : totalCotizacionVueloUsd;
      const totalCotizacionMxn =
        totalCotizacionUsd != null && K != null
          ? round2(totalCotizacionUsd * K)
          : null;
      // CANCELADO: 100 % del avión (sin partición).
      const ventaFactor = p != null ? (cancelado ? 1 : p.factor_avion) : null;

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
      // EXTERNOS: el horómetro del avión ajeno no es de la flota — tacos y
      // horas vacíos (la fila no se regaña por ello: esExterno).
      const escalasDelAvion = modoExternos
        ? []
        : vEscalas.filter(
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
      // Operación por aeropuerto (clave = IATA o '' = sin aeropuerto).
      const opPorAeropuerto = new Map<string, number>();
      const iatasRuta = [
        ...new Set(
          vEscalas
            .flatMap((e) => [e.origen_iata, e.destino_iata])
            .filter((x): x is string => !!x)
            .map((x) => x.toUpperCase()),
        ),
      ];
      const aeropuertoDeGasto = (g: GastoRow): string => {
        const candidatos = iatasRuta.length
          ? iatasRuta
          : [...aeropuertoPorIata.keys()];
        const buscar = (texto: string): string | null => {
          const t = normalizar(texto);
          if (!t) return null;
          for (const iata of candidatos) {
            if (new RegExp(`(^|[^a-z])${iata.toLowerCase()}([^a-z]|$)`).test(t))
              return iata;
          }
          for (const iata of candidatos) {
            const cat = aeropuertoPorIata.get(iata);
            if (cat?.tokens.some((tok) => t.includes(tok))) return iata;
          }
          return null;
        };
        const porLugar = g.lugar ? buscar(String(g.lugar)) : null;
        if (porLugar) return porLugar;
        const esc = g.escala_id ? escalaPorId.get(g.escala_id) : undefined;
        if (esc?.destino_iata) return esc.destino_iata.toUpperCase();
        const prov = Array.isArray(g.proveedor)
          ? g.proveedor[0]?.nombre
          : g.proveedor?.nombre;
        return buscar(`${(g.notas ?? '').split('\n')[0]} ${prov ?? ''}`) ?? '';
      };
      const sumarOp = (g: GastoRow, monto: number) => {
        opMxn = (opMxn ?? 0) + monto;
        const k = aeropuertoDeGasto(g);
        opPorAeropuerto.set(k, (opPorAeropuerto.get(k) ?? 0) + monto);
      };
      // TUA pagado de la fila (categoría TUAS + parte embebida): SOLO
      // informativo (regla 7, 28-ago) — no entra a Y ni a ninguna hoja.
      let tuaPagadoMxn: number | null = null;
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
        // EXTERNOS: si el gasto del vuelo ajeno quedó sellado a un avión de
        // flota, la nota lo dice (no vive en el libro de ese avión).
        const avionSellado =
          modoExternos && g.aeronave_id
            ? (matriculaPorAvion.get(g.aeronave_id) ?? null)
            : null;
        const etiqueta = [
          `${CAT_LABEL[g.categoria] ?? g.categoria}${sufijo}`,
          prov || null,
          nota || null,
          avionSellado ? `sellado a ${avionSellado}` : null,
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
          // REGLA DEL CLIENTE (28-ago-2026, sustituye a la del 26-ago): el
          // TUA pagado es SOLO NOTA en la celda de OPERACIÓN — no suma en OP
          // ni resta en ninguna hoja. Coherente con la venta: el TUA cobrado
          // al cliente tampoco está en la venta de la fila (es ingreso de
          // VuelaTour) y el par cobrado↔pagado vive en "Otros movimientos"
          // del general. Se acumula un informativo por fila (tua_pagado_mxn)
          // que NO entra a ningún total de dinero. Misma cadena de TC que la
          // nota (tc_gasto ?? z ?? tcPromedio).
          const mxnTua = gastoMxn(g);
          const sufijoTua = g.medio_pago === 'EFECTIVO' ? ' (efectivo)' : '';
          opDetalle.push(
            lineaDetalle(
              g,
              mxnTua ?? 0,
              sufijoTua,
              // Mismo vocabulario que el desglose de las notas del gasto;
              // la regla "solo nota" vive en el pie ** de la hoja (leyendas
              // distintas parecían texto inventado — 24-ago).
              mxnTua != null
                ? `TUA $${fmtMonto(mxnTua)}**`
                : `TUA $${fmtMonto(num(g.monto) ?? 0)} ${g.moneda ?? 'USD'} sin TC**`,
            ),
          );
          if (mxnTua != null) {
            tuaPagadoMxn = (tuaPagadoMxn ?? 0) + mxnTua;
          } else {
            pendientes.push(
              `${etiqueta}: TUA en ${g.moneda ?? 'USD'} por $${(
                num(g.monto) ?? 0
              ).toLocaleString('en-US')} sin ningún TC — la nota queda sin MXN`,
            );
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
        // Exclusión ÚNICA: CATS_SIN_TUA_EMBEBIDO (la misma que usa
        // tuaEmbebidoDeGasto en "Otros movimientos" del general — el TUA
        // pagado de un vuelo debe ser el MISMO número en ambas hojas).
        const separarPartes = (): {
          opParte: number;
          tuaParte: number;
          fboParte: number;
        } | null => {
          // Un parcial del reparto manual jamás se separa: sus renglones IA
          // son de la factura completa y no cuadran con el parcial.
          if (g.es_reparto_parcial || CATS_SIN_TUA_EMBEBIDO.has(g.categoria))
            return null;
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
            // Regla 28-ago-2026: la parte TUA embebida es SOLO NOTA (no
            // resta en ninguna hoja); las partes de operación/FBO se quedan
            // en las columnas del vuelo. Informativo por fila.
            if (sep.tuaParte > 0) {
              tuaPagadoMxn = (tuaPagadoMxn ?? 0) + sep.tuaParte;
            }
            if (sep.opParte > 0) {
              sumarOp(g, sep.opParte);
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
            sumarOp(g, mxn);
            opDetalle.push(lineaDetalle(g, mxn, sufijo));
          }
        }
      }
      // ----- Costo del OPERADOR externo (regla 28-ago, tarde) -----
      // Vuelo cubierto por un operador ajeno (con o sin avión de referencia):
      // lo que VuelaTour le paga vive en vuelo.costo_externo_usd, NO en
      // `gasto` (misma fuente que el reporte por vuelo y el reparto). Suma a
      // la columna OPERACIONES en MXN con el TC de VENTA (K) — sin K no se
      // suma en falso: pendiente. Solo en la fila del principal (ahí vive la
      // venta); la fila compartida no lo carga. Regla de captura: el pago al
      // operador va en "Cubrir con externo → costo", NO como gasto del vuelo
      // (si además se captura como gasto, restaría dos veces).
      // CANCELADO (verificación 28-ago, misma regla que el reparto): el costo
      // pactado con el operador NO se resta (el servicio no se prestó) ni se
      // reclama como "sin costo"; una penalización real del operador se
      // captura como gasto del vuelo y ya restó en las columnas de arriba.
      // Si hay costo capturado queda SOLO como nota informativa.
      if (esExterno && !esCompartido && cancelado) {
        const costoOperadorUsd = pos(v.costo_externo_usd);
        if (costoOperadorUsd != null) {
          opDetalle.push(
            `Costo operador externo (${operadorExterno ?? 'operador ¿?'}) $${costoOperadorUsd.toLocaleString(
              'en-US',
            )} USD — NO resta (vuelo cancelado; una penalización real del operador va como gasto del vuelo)`,
          );
        }
      } else if (esExterno && !esCompartido) {
        const costoOperadorUsd = pos(v.costo_externo_usd);
        const operadorTexto = operadorExterno ?? 'operador ¿?';
        // Gastos que SÍ restaron en las columnas de esta fila (el loop de
        // arriba ya los sumó; TUAS/GAS/PERMISO/INDIRECTO no restan aquí).
        // Verificación 28-ago: si la oficina capturó el pago al operador
        // TAMBIÉN como gasto, el costo se resta DOS veces y el sistema no
        // puede distinguirlo solo — se grita con la evidencia que hay.
        const gastosColumna = vGastos.filter(
          (g) => !['TUAS', 'GAS', 'PERMISO', 'INDIRECTO'].includes(g.categoria),
        );
        const gastosColumnaMxn = gastosColumna.reduce(
          (acc, g) => acc + (gastoMxn(g) ?? 0),
          0,
        );
        if (costoOperadorUsd != null) {
          if (K != null) {
            const costoOperadorMxn = round2(costoOperadorUsd * K);
            opMxn = (opMxn ?? 0) + costoOperadorMxn;
            opDetalle.push(
              `Costo operador externo (${operadorTexto}) — $${fmtMonto(
                costoOperadorMxn,
              )}`,
            );
            if (gastosColumna.length > 0) {
              // Coincidencia ±1 % con el costo (en MXN por la misma cadena
              // de TC de la fila, o en USD nativo si el gasto es USD y su
              // tc_gasto difiere de K): casi seguro es el MISMO pago.
              const coinciden = gastosColumna.filter((g) => {
                const mxn = gastoMxn(g);
                if (
                  mxn != null &&
                  Math.abs(mxn - costoOperadorMxn) <= costoOperadorMxn * 0.01
                )
                  return true;
                const nativo = num(g.monto);
                return (
                  g.moneda !== 'MXN' &&
                  nativo != null &&
                  Math.abs(nativo - costoOperadorUsd) <= costoOperadorUsd * 0.01
                );
              }).length;
              pendientes.push(
                `${etiqueta}: externo con ${gastosColumna.length} gasto(s) capturado(s) por $${fmtMonto(
                  gastosColumnaMxn,
                )} ADEMÁS del costo del operador (${operadorTexto}, $${costoOperadorUsd.toLocaleString(
                  'en-US',
                )} USD) — verifica que el pago al operador no esté también como gasto (se resta doble)${
                  coinciden > 0
                    ? `; ${coinciden} gasto(s) coinciden con el costo del operador`
                    : ''
                }`,
              );
            }
          } else {
            pendientes.push(
              `${etiqueta}: costo del operador externo (${operadorTexto}) por $${costoOperadorUsd.toLocaleString(
                'en-US',
              )} USD sin TC de venta — fuera del costo MXN (captura el TC en la cotización)`,
            );
          }
        } else if ((totalSistemaUsd ?? 0) > 0) {
          if (gastosColumna.length > 0) {
            // Hay gastos de operación pero ningún costo del operador: o el
            // pago se capturó como gasto (entonces NO falta nada) o falta
            // el costo — solo la oficina lo sabe.
            pendientes.push(
              `${etiqueta}: externo sin costo del operador capturado pero con ${gastosColumna.length} gasto(s) de operación por $${fmtMonto(
                gastosColumnaMxn,
              )} (posible pago al operador) — si NO son el pago al operador, falta capturar el costo (Detalle del vuelo → Cubrir con externo → costo)`,
            );
          } else {
            pendientes.push(
              `${etiqueta}: externo sin costo del operador capturado — ganancia BRUTA (Detalle del vuelo → Cubrir con externo → costo)`,
            );
          }
        }
      }
      // Encabezado de la nota de OPERACIONES por aeropuerto ("Op CUN $x ·
      // Op MHL $y"), el formato del libro manual del cliente; lo que no se
      // pudo ubicar sale como "Op (sin aeropuerto)". Solo si hay operación
      // por aeropuerto (el costo del operador externo es su propia línea).
      if ((opMxn ?? 0) > 0 && opPorAeropuerto.size > 0) {
        const orden = (k: string) => {
          const i = iatasRuta.indexOf(k);
          return i < 0 ? 999 : i;
        };
        const partes = [...opPorAeropuerto.entries()]
          .filter(([, m]) => m > 0)
          .sort((a, b) => orden(a[0]) - orden(b[0]))
          .map(([k, m]) => `Op ${k || '(sin aeropuerto)'} $${fmtMonto(m)}`);
        if (partes.length) opDetalle.unshift(partes.join(' · '));
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
      // Fila SIN participación en la venta (compartida con tramos que no
      // participan): remanente/ganancia serían "−costos" y se leerían como
      // pérdida falsa — van vacíos (los costos sí suman). Una compartida CON
      // parte (regla B) sí cierra contra su parte de la venta.
      const AI = conParte ? round2((L ?? 0) - Y) : null;
      const AJ = conParte ? round2((M ?? 0) - (AH ?? 0)) : null;
      // Comisión del vendedor — REGLA A (28-ago tarde): es INGRESO DE
      // VUELATOUR "como un extra" (particionIngresoVuelo la deja fuera de la
      // venta del avión) y su PAGO al vendedor es egreso de VuelaTour: ambos
      // viven apareados en "Otros movimientos" del Balance general. El
      // libro por avión NI la cobra NI la descuenta: la columna AK queda
      // vacía en toda fila (el campo se conserva por compatibilidad de
      // shape con pyservices) y la ganancia es el remanente tal cual.
      // (Antes: AK = comisión × K restaba aquí y 0 en cancelados; ahora no
      // aplica en ningún estado.)
      const AK: number | null = null;
      const AL = AI;
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
      // MULTI-AVIÓN (regla B, verificación 28-ago): cada parcialidad y su
      // comisión bancaria viajan en la fila con la PARTE DE ESTA FILA —
      // fuente única `parteFilaDeCobro` (la misma del Libro Dinero): la
      // parte del AVIÓN del depósito (× factor de la partición) repartida
      // por tramo + TODA la parte de VuelaTour en la fila que reporta. Así
      // la fila cuadra consigo misma (su total_cotizacion = su parte de la
      // venta + la parte VuelaTour que reporta) y Σ entre libros == el
      // depósito real — cobrado_real_mxn y comision_banco_mxn del
      // consolidado no cuentan dos veces el mismo depósito. (Antes el
      // depósito ENTERO se repartía por factor, VuelaTour incluido, y la
      // fila que reporta no cerraba: #132 caso de la verificación.) Con un
      // solo avión el helper devuelve el monto tal cual. Sin participación
      // (factor 0) la fila no lista cobros (la venta no vive aquí).
      const parteFila = (montoVuelo: number): number =>
        parteFilaDeCobro(montoVuelo, p, part, aircraftId, reporta, cancelado);
      // Texto del método en multi-avión: qué lleva esta fila del cobro.
      const sufijoParteFila = multiAvion
        ? ` · parte de esta fila (${pctTexto} de la venta del avión${
            p != null && !cancelado && p.total_usd > 0 && p.vuelatour_usd > 0
              ? reporta
                ? ' + ingreso VuelaTour'
                : '; el ingreso VuelaTour va en la fila que reporta'
              : ''
          })`
        : '';
      let cobroSinTc = 0;
      let comisionSinTc = 0;
      // Depósitos REALES del vuelo entero en MXN (sin repartir): red de
      // seguridad de "pagado completo" contra el total del cliente.
      let cobradoRealVueloMxn = 0;
      const cobrosOut: BalanceAvionCobroPayload[] = (
        conParte ? vCobros : []
      ).map((c) => {
        const monto = num(c.monto) ?? 0;
        // TC del cobro: el propio; si no, el de venta (K).
        const tcCobro = pos(c.tc_usd_mxn) ?? K;
        let mxn: number | null;
        if (c.moneda === 'MXN') {
          mxn = round2(monto);
        } else {
          mxn = tcCobro != null ? round2(monto * tcCobro) : null;
        }
        if (mxn == null) cobroSinTc += 1;
        else cobradoRealVueloMxn += mxn;
        // Comisión bancaria (punto 9 del cliente, 28-ago): viene en la
        // MONEDA del cobro; MXN directo, USD × TC del cobro; sin TC → null
        // (jamás se suma en falso — se avisa en pendientes).
        const comision = pos(c.comision_banco_monto);
        let comisionMxn: number | null = null;
        if (comision != null) {
          comisionMxn =
            c.moneda === 'MXN'
              ? round2(comision)
              : tcCobro != null
                ? round2(comision * tcCobro)
                : null;
          if (comisionMxn == null) comisionSinTc += 1;
        }
        return {
          fecha: diaCancun(c.fecha_cobro),
          monto_mxn: mxn != null ? parteFila(mxn) : null,
          metodo: multiAvion
            ? `${c.metodo_cobro ?? '—'}${sufijoParteFila}`
            : (c.metodo_cobro ?? null),
          comision_mxn: comisionMxn != null ? parteFila(comisionMxn) : null,
          cuenta: c.cuenta_destino?.trim() || null,
        };
      });
      cobradoRealVueloMxn = round2(cobradoRealVueloMxn);
      // Lo cobrado REAL (parcialidades tal cual — la parte de esta fila en
      // multi-avión) vs lo que cuenta para el AVIÓN (regla 28-ago): el cobro
      // se prorratea con el factor de la partición (venta del avión / total
      // del cliente) — la parte de TUAS/extras/pernocta/comisión cobrada es
      // ingreso de VuelaTour, no del avión. Con el vuelo pagado completo y
      // el mismo TC, cobradoMxn == L.
      // MULTI-AVIÓN (verificación 28-ago): cobrado_real_mxn sale de UNA
      // sola partición del MXN real del VUELO (`parteFilaDeCobro` sobre el
      // total depositado: parte del avión por tramo + VuelaTour en la fila
      // que reporta; Σ entre libros == depósitos reales exacto), no de la
      // suma de las partes por cobro (tres cobros de $33.33 al 50 % daban
      // $50.01 / $49.98 contra $50.00 / $49.99 del vuelo). El centavo de
      // diferencia contra las líneas por cobro se absorbe en la última
      // línea convertible para que las parcialidades listadas SUMEN
      // cobrado_real_mxn. En vuelos de un solo avión no cambia nada.
      // NOTA: cobrado_mxn (parte del avión) viaja por USD (cobrosEnUsd →
      // cobradoParteAvion → parteAvion → × K) y cobrado_real_mxn por MXN
      // (depósitos → parteFilaDeCobro): en filas repartidas difieren — la
      // fila que reporta lleva además lo cobrado de VuelaTour — y pueden
      // diferir centavos aun sin parte VuelaTour; son dos caminos distintos
      // a propósito (uno es "cuánto es del avión", el otro "cuánto entró al
      // banco por esta fila").
      const cobradoRealMxn = conParte ? parteFila(cobradoRealVueloMxn) : 0;
      {
        const sumaLineas = round2(
          cobrosOut.reduce((acc, c) => acc + (c.monto_mxn ?? 0), 0),
        );
        const delta = round2(cobradoRealMxn - sumaLineas);
        if (Math.abs(delta) >= 0.005) {
          const ultima = [...cobrosOut]
            .reverse()
            .find((c) => c.monto_mxn != null);
          if (ultima)
            ultima.monto_mxn = round2((ultima.monto_mxn ?? 0) + delta);
        }
      }
      // Parte del AVIÓN de lo cobrado: la MISMA fuente que el reparto a
      // socios (cobrosEnUsd con K de respaldo → cobradoParteAvion) y UNA
      // sola conversión a MXN. Antes se redondeaba dos veces (Σ round2(cobro
      // × TC) × factor → round2) y ~17% de los vuelos pagados completos
      // quedaban con POR COBRAR $0.01 en rojo junto a "Cobrado". Sin K o sin
      // partición cae al prorrateo del MXN real.
      // MULTI-AVIÓN: la parte del avión (del vuelo entero) se reparte con
      // parteAvion — la venta y lo cobrado se reparten POR SEPARADO (cada
      // uno con Σ exacta entre libros) y el por cobrar de la fila se deriva
      // de ellos, así la identidad por fila "por cobrar = venta − cobrado"
      // es exacta y Σ por cobrar entre libros == por cobrar del vuelo (el
      // centavo impar cae en la fila del principal por el residuo mayor).
      // Ej. #105 (50/50): venta 2,175 → 1,087.50 / 1,087.50; cobrado
      // 2,171.43 → 1,085.72 (principal) / 1,085.71; por cobrar 3.57 →
      // 1.78 (principal) / 1.79.
      let cobradoMxn: number;
      if (cobrosCancelado != null) {
        // CANCELADO: la venta ES lo cobrado — 100 % del avión, sin partición
        // ni tope. En MXN se toma L (la misma venta re-expresada al TC de
        // venta) para que venta − cobrado == por cobrar == 0 exacto — el
        // mismo criterio que la red de seguridad de "pagado completo"; los
        // depósitos tal cual siguen en cobrado_real_mxn. Sin K (venta MXN
        // vacía) caen los pesos reales.
        cobradoMxn = L ?? cobradoRealMxn;
      } else if (K != null && p != null) {
        const cobradoAvionUsd = parteAvion(
          cobradoParteAvion(cobrosEnUsd(vCobros, K).total_usd, p),
        );
        cobradoMxn = round2(cobradoAvionUsd * K);
      } else {
        cobradoMxn = round2(cobradoRealMxn * (ventaFactor ?? 1));
      }
      // Red de seguridad: pagado COMPLETO (lo depositado del VUELO == total
      // del cliente al centavo) → la parte del avión es L EXACTO (la de esta
      // fila), sin flotante. Solo con precio (> 0): sin cotización, 0 == 0
      // no es "pagado".
      if (
        L != null &&
        totalCotizacionVueloMxn != null &&
        totalCotizacionVueloMxn > 0 &&
        Math.abs(cobradoRealVueloMxn - totalCotizacionVueloMxn) <= 0.01
      ) {
        cobradoMxn = L;
      }
      // CANCELADO: nada queda por cobrar (lo no retenido no es venta). El
      // status reutiliza los rótulos que pyservices ya colorea ('Cobrado'
      // en verde / '—'); la columna ESTADO va en rojo y la fila lleva la
      // bandera `cancelado`.
      // POR COBRAR = venta − cobrado TAL CUAL (semántica del libro): puede
      // ser NEGATIVO y eso es información — sobrecobro, o cobros en un vuelo
      // sin TC / sin precio (venta MXN vacía con depósitos reales). El
      // max(0, …) que se introdujo con el multi-avión ocultaba ese negativo
      // en vuelos de UN avión (regresión, verificación 28-ago); en filas
      // repartidas un −$0.01 por el reparto de centavos por separado (venta
      // vs cobrado) es raro y se deja tal cual (la identidad por fila manda).
      const porCobrarMxn =
        cobrosCancelado != null ? 0 : round2((L ?? 0) - cobradoMxn);
      const porCobrarUsd =
        cobrosCancelado != null
          ? 0
          : K != null
            ? round2(porCobrarMxn / K)
            : null;
      const statusCobro =
        cobrosCancelado != null
          ? vCobros.length > 0
            ? 'Cobrado'
            : '—'
          : v.cobrado === true
            ? 'Cobrado'
            : vCobros.length > 0
              ? 'Parcial'
              : (L ?? 0) > 0
                ? 'Pendiente'
                : '—';

      // ----- Pendientes de captura por vuelo (lista generosa) -----
      // (`cancelado` se define arriba: lo usa el bloque VENTA.)
      const yaVolo = v.estado === 'EN_VUELO' || v.estado === 'COMPLETADO';
      // Cliente INTERNO: venta $0 es lo esperado (operación propia) — no se
      // regaña por cotización/cobranza; los pendientes OPERATIVOS (tacos,
      // gas, TC) siguen aplicando igual.
      const esClienteInterno =
        v.cliente_id != null && clientesInternos.has(v.cliente_id);
      // Los avisos de COTIZACIÓN y COBRANZA son del VUELO (no del tramo):
      // salen una sola vez, en la fila del avión que REPORTA
      // (`avionQueReporta`: el principal si participa; si su único tramo se
      // canceló y el regreso lo voló otro, ese otro) — la fila compartida
      // (regla B) lleva su parte de la venta y sus cobros, pero repetir el
      // mismo aviso en dos libros era ruido en el general, y un principal
      // con factor 0 gritaba "sin cotización"/"sin cobros" por una venta
      // que vive en otro libro.
      if (
        (totalSistemaUsd ?? 0) === 0 &&
        D === 0 &&
        !cancelado &&
        !esClienteInterno &&
        reporta
      ) {
        pendientes.push(
          `${etiqueta}: sin cotización — montos de venta en $0 (¿traslado/servicio o falta cotizar?)`,
        );
      }
      // Partición del ingreso (regla 28-ago): si el desglose no cuadra, la
      // fila lleva el total completo (no se inventa dinero) y se grita; sin
      // snapshot v1.3 la partición se estima con las columnas persistidas.
      if (pPrecio != null && pPrecio.inconsistente && reporta) {
        pendientes.push(
          `${etiqueta}: el desglose de la cotización no cuadra con el total — la fila lleva el total completo; revisar la cotización`,
        );
      }
      if (
        pPrecio != null &&
        reporta &&
        pPrecio.fuente === 'columnas' &&
        pPrecio.tuas_usd +
          pPrecio.extras_usd +
          pPrecio.pernocta_usd +
          pPrecio.comision_vendedor_usd >
          0
      ) {
        pendientes.push(
          `${etiqueta}: sin desglose canónico (snapshot viejo): partición estimada con columnas`,
        );
      }
      // (CANCELADO sin cobros: L = 0 → no se regaña "sin cobros" ni "sin
      // cotización" — guards de arriba; su venta es exactamente lo retenido.)
      if ((L ?? 0) > 0 && vCobros.length === 0 && reporta) {
        pendientes.push(`${etiqueta}: sin cobros registrados`);
      }
      // CANCELADO con dinero retenido: lo que no se pudo convertir se grita
      // (la venta de la fila es exactamente lo cobrado — un cobro fuera
      // sería venta perdida en silencio).
      if (cobrosCancelado != null && reporta) {
        if (cobrosCancelado.sin_tc_count > 0) {
          pendientes.push(
            `${etiqueta}: cancelado con ${cobrosCancelado.sin_tc_count} cobro(s) en MXN por $${fmtMonto(
              cobrosCancelado.sin_tc_mxn,
            )} sin TC (ni TC del vuelo) — FUERA de la venta retenida (captura el TC del cobro o de la cotización)`,
          );
        }
        if (I != null && I > 0 && K == null) {
          pendientes.push(
            `${etiqueta}: cancelado con $${I.toLocaleString(
              'en-US',
            )} USD retenidos sin TC de venta — venta MXN vacía (captura el TC en la cotización)`,
          );
        }
      }
      if (comisionSinTc > 0 && reporta) {
        pendientes.push(
          `${etiqueta}: ${comisionSinTc} comisión(es) bancaria(s) en USD sin TC (ni TC del vuelo) — no entra al total de comisiones`,
        );
      }
      // (El combustible ya no se vigila POR VUELO: la vigilancia es mensual
      // por avión — ver pendientes de la hoja "combustible".)
      if (O == null && !esExterno && !cancelado && !soloGastosCancelado) {
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
      if (cobroSinTc > 0 && reporta) {
        pendientes.push(
          `${etiqueta}: ${cobroSinTc} cobro(s) en USD sin TC (ni TC del vuelo) — parcialidad vacía en MXN`,
        );
      }
      // Regla del cliente: NUNCA se cobran menos horas de las voladas. Si el
      // tacómetro registró más de lo cotizado, hay que recotizar el vuelo
      // (revisar cotización con las horas reales). Solo aplica con cotización
      // (D>0; sin cotización ya sale su propio pendiente) y con cliente NO
      // interno (interno no cobra: recotizar no cambiaría un peso).
      // Horas de TODO el viaje (todas las matrículas) contra las horas
      // cobradas COMPLETAS del vuelo (horasCobrablesVuelo, sin el factor
      // multi-avión — D es solo la parte de este avión): en vuelos
      // multi-avión comparar solo los tramos de este avión dejaba ciego el
      // candado de recotizar (ida 1.4 + regreso 1.5 = 2.9 hr > 2.4 cobradas
      // y nadie avisaba). Solo en la fila del avión que reporta. Tramos
      // activos (vEscalas): un tramo cancelado no voló.
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
        horasCobrablesVuelo > 0 &&
        horasViaje != null &&
        horasViaje - horasCobrablesVuelo > 0.01 &&
        !esClienteInterno &&
        reporta
      ) {
        pendientes.push(
          `${etiqueta}: voló ${horasViaje.toFixed(2)} hr (todas las matrículas) y solo se cobraron ${horasCobrablesVuelo.toFixed(
            2,
          )} — recotizar con las horas reales (lo cobrado no puede ser menor a lo volado)`,
        );
      }
      // (Regla B, 28-ago tarde: la fila COMPARTIDA ya lleva su parte de la
      // venta, así que sus costos de columnas SÍ restan contra ella — el
      // antiguo aviso "costos que no restan en ninguna utilidad" ya no
      // aplica.)
      // Gasto asignado a un avión que NO vuela ningún tramo del vuelo: no
      // aparecería en NINGÚN balance (regla sagrada: el dinero jamás
      // desaparece en silencio). Solo se evalúa en la fila del avión que
      // reporta para no duplicar el aviso. En EXTERNOS no aplica: la fila
      // carga TODOS los gastos del vuelo (la nota señala el avión sellado).
      // Aviones del vuelo CON tramos cancelados (un gasto ligado a un tramo
      // cancelado es de ese avión — contrato de `avionDelGasto`).
      if (reporta && !modoExternos) {
        const avionesDelVuelo = new Set(
          [v.aeronave_id, ...vEscalasTodas.map((e) => e.aeronave_id)].filter(
            (x): x is string => x != null,
          ),
        );
        for (const g of gastosPorVuelo.get(v.id) ?? []) {
          const avionG = avionDelGastoV(g);
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

      // Fila "solo gastos" SIN nada que mostrar en sus columnas (sus gastos
      // fueron a una hoja aparte — permisos/indirectos/combustible): no se
      // pinta una fila vacía; los pendientes de arriba se conservan.
      if (
        soloGastosCancelado &&
        Y === 0 &&
        opDetalle.length === 0 &&
        pilotoDetalle.length === 0 &&
        otrosDetalle.length === 0
      ) {
        continue;
      }
      const cliente = v.cliente_id
        ? (clientePorId.get(v.cliente_id) ?? null)
        : null;
      filasVuelo.push({
        // CLAVE del libro: folio del sistema + nombre del cliente (el libro
        // original usaba claves tipo "vt<apellido>"; el nombre real es más
        // claro para el equipo y el folio amarra la fila al sistema).
        clave: `#${folio}${cliente ? ` · ${cliente}` : ''}`,
        // Id del vuelo (verificación 28-ago): el consolidado de flota
        // deduplica con él el conteo de VUELOS (un multi-avión es una fila
        // por libro). pyservices no lo pinta.
        vuelo_id: v.id,
        folio,
        cliente,
        estado: v.estado,
        // Bandera explícita (28-ago tarde): venta = cobros retenidos, sin
        // partición ni "por cobrar"; pyservices puede rotularla.
        cancelado,
        // Fila que solo carga los gastos de un tramo cancelado de este
        // avión en un vuelo ajeno (factor 0; ver la consulta de arriba).
        solo_gastos_tramo_cancelado: soloGastosCancelado || undefined,
        es_externo: esExterno,
        operador_externo: esExterno ? operadorExterno : null,
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
        // Participación de este avión en la venta del vuelo (regla B):
        // 1 en vuelos de un solo avión; fracción en multi-avión.
        participacion: factor,
        multi_avion: multiAvion,
        participacion_fuente: part?.fuente ?? 'unico',
        horas_cobradas: round2(D),
        tarifa_usd: r2(E),
        iva_hr_usd: G,
        total_usd: I, // venta del AVIÓN (parte de este avión): tiempo + ajuste + IVA proporcional (regla 28-ago)
        iva_usd: J,
        tc_venta: K,
        tc_venta_oficial: kOficial,
        // Fuente y día real del TC oficial de referencia (open.er-api /
        // BCE) cuando la cotización no trae TC — la celda del Excel lo dice.
        tc_venta_oficial_fuente: kDetalle
          ? fuenteTcLegible(kDetalle.fuente)
          : undefined,
        tc_venta_oficial_fecha: kDetalle?.fecha_dato,
        total_mxn: L,
        iva_mxn: M,
        subtotal_mxn: N,
        // Total del CLIENTE y partición (informativos, regla 28-ago):
        // total_usd + otros_ingresos_usd == total_cotizacion_usd — salvo en
        // CANCELADO (total_usd = cobros retenidos, otros_ingresos_usd = 0;
        // la cotización viaja solo como referencia).
        total_cotizacion_usd: totalCotizacionUsd,
        total_cotizacion_mxn: totalCotizacionMxn,
        venta_factor: ventaFactor,
        otros_ingresos_usd: otrosIngresosUsd,
        // TUA pagado (solo nota; null si no hubo).
        tua_pagado_mxn:
          tuaPagadoMxn != null && round2(tuaPagadoMxn) !== 0
            ? round2(tuaPagadoMxn)
            : null,
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
        // Fila sin participación en la venta: el status de cobro pertenece
        // a la venta (vive en otro balance) — mostrarlo aquí despistaba
        // ("Cobrado" con venta vacía). Con parte (regla B) el status es el
        // mismo del principal (derivado de los mismos cobros del vuelo).
        status_cobro: conParte ? statusCobro : '—',
        cobros: cobrosOut,
        cobrado_mxn: cobradoMxn,
        cobrado_real_mxn: cobradoRealMxn,
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
      // (EXTERNOS: sin tacos, sin cadena.)
      let tacoFinPrevio: number | null =
        aircraftId != null
          ? await this.ultimaLlegadaAntesDe(aircraftId, desde)
          : null;
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
    const tuaPagadoPeriodo = sum((r) => r.tua_pagado_mxn ?? null);
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
      cobrado_real_mxn: sum((r) => r.cobrado_real_mxn ?? null),
      // CANCELADO: su cotización viaja en la fila solo como referencia (no se
      // cobró ni se cobrará) — fuera del total del periodo para que el pie
      // cuadre con la venta real (Σ total_mxn + otros ingresos).
      total_cotizacion_mxn: sum((r) =>
        r.cancelado ? null : (r.total_cotizacion_mxn ?? null),
      ),
      por_cobrar_mxn: sum((r) => r.por_cobrar_mxn),
      por_cobrar_usd: sum((r) => r.por_cobrar_usd),
      tc_promedio: tcPromedio != null ? round2(tcPromedio) : null,
      costo_hr_prom_usd: anValues.length
        ? round2(anValues.reduce((a, b) => a + b, 0) / anValues.length)
        : null,
      // Ingreso de VuelaTour EXCLUIDO de las filas (regla 28-ago): no suma
      // en las columnas; va a "Otros movimientos" del general.
      otros_ingresos_usd: round2(otrosIngresosPeriodoUsd),
      // TUA pagado (solo nota, regla 7): informativo, fuera de Y y de la
      // cascada. null cuando no hubo (celda vacía, no "$0").
      tua_pagado_mxn: tuaPagadoPeriodo !== 0 ? tuaPagadoPeriodo : null,
      // Comisiones bancarias convertibles de los cobros de las filas.
      comision_banco_mxn: round2(
        filasVuelo.reduce(
          (acc, r) =>
            acc + r.cobros.reduce((a, c) => a + (c.comision_mxn ?? 0), 0),
          0,
        ),
      ),
    };

    // ===== Hojas de gastos: clasificación por ORIGEN (regla 28-ago-2026,
    // sustituye a la clasificación solo por categoría) =====
    //  - GAS → hoja "combustible" (query mensual aparte, abajo). Dejarlo en
    //    otra hoja lo contaría DOS veces en la cascada.
    //  - PERMISO → hoja "permisos" (con o sin vuelo).
    //  - Parcial de un REPARTO MANUAL (es_reparto_parcial: FIJO/OTRO/
    //    INDIRECTO/GASOLINA/VISITA de la empresa repartidos a mano) → hoja
    //    "otros gastos": administrativos repartidos, la parte de este avión.
    //  - Resto con aeronave_id DIRECTO y SIN vuelo (INDIRECTO, OTRO, FIJO,
    //    REFACCION, OPERACIONES, …) → hoja "gastos indirectos": gastos que
    //    no se pueden ligar a un vuelo pero sí al avión.
    //  - TUAS sin vuelo → FUERA (regla 7: el TUA no resta en ninguna hoja;
    //    se lista en "Otros movimientos" del general y se avisa aquí).
    //  - INDIRECTO ligado a vuelo no debería existir, pero si existe NO se
    //    pierde: cae a indirectos (defensa).
    // La cascada no cambia: suma las 4 hojas.
    // Con vuelos COMPARTIDOS en la lista, gastosVuelo trae también gastos del
    // OTRO avión: las hojas solo cargan los de ESTE (herencia por gasto).
    // EXTERNOS: todos los gastos de sus vuelos (misma regla que la fila) —
    // un PERMISO/INDIRECTO de un vuelo ajeno cae a su hoja aquí, no se
    // pierde.
    const avionPorVuelo = new Map(vuelos.map((v) => [v.id, v.aeronave_id]));
    // Misma fuente única que la fila del vuelo (`avionDelGasto`: escala →
    // gasto → vuelo, con herencia) — un PERMISO/INDIRECTO ligado al tramo
    // del otro avión iba al principal con el filtro crudo.
    const gastosVueloDelAvion = modoExternos
      ? gastosVuelo
      : gastosVuelo.filter(
          (g) =>
            avionDelGasto(
              g,
              escalaPorId,
              g.vuelo_id ? (avionPorVuelo.get(g.vuelo_id) ?? null) : null,
            ) === aircraftId,
        );
    // Categorías con destino propio (o sin destino: TUAS).
    const HOJAS_APARTE = new Set(['GAS', 'PERMISO', 'TUAS']);
    const filasIndirectos = [
      ...gastosAvion.filter(
        (g) => g.es_reparto_parcial !== true && !HOJAS_APARTE.has(g.categoria),
      ),
      ...gastosVueloDelAvion.filter((g) => g.categoria === 'INDIRECTO'),
    ];
    const filasOtros = gastosAvion.filter(
      (g) => g.es_reparto_parcial === true && !HOJAS_APARTE.has(g.categoria),
    );
    // Permisos: pagos reales de PERMISO del avión, CON o SIN vuelo.
    const filasPermisos = [
      ...gastosAvion.filter((g) => g.categoria === 'PERMISO'),
      ...gastosVueloDelAvion.filter((g) => g.categoria === 'PERMISO'),
    ];
    // TUAS sin vuelo (regla 7): no restan en ninguna hoja — se avisa para
    // que el dinero no parezca perdido (viven en "Otros movimientos").
    const tuasSinVuelo = gastosAvion.filter((g) => g.categoria === 'TUAS');
    if (tuasSinVuelo.length > 0) {
      const porMoneda = new Map<string, number>();
      for (const g of tuasSinVuelo) {
        const m = g.moneda ?? 'MXN';
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
      pendientes.push(
        `${etiquetaAvion}: ${tuasSinVuelo.length} gasto(s) TUAS sin vuelo por ${montos} — no restan en ninguna hoja (regla 28-ago: el TUA es solo nota); viven en "Otros movimientos" del Balance general (pestaña que lista vuelos de TODOS los estados) — liga cada gasto a su vuelo si lo tiene`,
      );
    }
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
    // ===== Hoja COMBUSTIBLE (26-ago-2026): el gas del avión en el MES =====
    // Eje fecha_gasto, con o sin vuelo. Litros y $/L viven aquí, ya no por
    // vuelo. El avión de cada carga es el de la FUENTE ÚNICA `avionDelGasto`
    // (verificación 28-ago; misma regla que la fila del vuelo, el reparto a
    // socios y el Libro Dinero): escala del gasto (con herencia) → avión
    // sellado en el gasto → avión del vuelo. Escalas de vuelos del libro:
    // `escalaPorId` (cancelados incluidos); escalas/vuelos FUERA del
    // periodo del libro (vuelo de julio, carga en agosto): el avión crudo
    // embebido en la consulta (misma información, sin otra consulta). Una
    // carga sin vuelo cae al avión sellado, como siempre.
    // EXTERNOS: su consulta ya trae solo el GAS de sus vuelos sin avión.
    const gastosGas: GastoRow[] = modoExternos
      ? gastosGasMes
      : gastosGasMes.filter((g) => {
          const escalaEmb = embebido(g.escala);
          const mapa =
            g.escala_id && !escalaPorId.has(g.escala_id) && escalaEmb
              ? new Map<string, { aeronave_id?: string | null }>([
                  [g.escala_id, escalaEmb],
                ])
              : escalaPorId;
          const vueloAvion = g.vuelo_id
            ? (avionPorVuelo.get(g.vuelo_id) ??
              embebido(g.vuelo)?.aeronave_id ??
              null)
            : null;
          return avionDelGasto(g, mapa, vueloAvion) === aircraftId;
        });
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
        `${etiquetaAvion}: voló ${horasVoladas.toFixed(
          1,
        )} hr en el periodo y no hay NINGUNA carga de combustible capturada`,
      );
    }
    const gasSinLitrosMes = gastosGas.filter(
      (g) => pos(g.litros) == null,
    ).length;
    if (gasSinLitrosMes > 0) {
      pendientes.push(
        `${etiquetaAvion}: ${gasSinLitrosMes} carga(s) de combustible sin litros — el $/litro del mes queda incompleto`,
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
          `${etiquetaAvion}: carga de combustible del ${
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

    // ===== Pendientes a nivel avión (los de ficha/socios/servicio no
    // aplican al libro EXTERNOS: no es un avión) =====
    if (!modoExternos && hojaIndirectos.filas.length === 0) {
      pendientes.push(
        `${etiquetaAvion}: sin gastos del avión sin vuelo (indirectos) en el periodo — verificar que no falte captura`,
      );
    }
    if (!modoExternos && permisoAfacUsdHr == null) {
      pendientes.push(
        `${etiquetaAvion}: provisión permiso AFAC no configurada (campo "Aportación AFAC USD/hr" en la ficha del avión) — columna PERMISO AFAC vacía`,
      );
    }
    if (tcOficialPorVuelo.size > 0) {
      const fuentes = [
        ...new Set(
          [...tcOficialPorVuelo.values()].map((d) => fuenteTcLegible(d.fuente)),
        ),
      ].join(' / ');
      pendientes.push(
        `${etiquetaAvion}: ${tcOficialPorVuelo.size} vuelo(s) sin tipo de cambio en la cotización — se usó el TC oficial de referencia (open.er-api / BCE) del día de la cotización (fuente: ${fuentes}); celdas marcadas en azul claro en la hoja maestra`,
      );
    }
    if (tcPromedio == null && vuelos.length > 0) {
      pendientes.push(
        `${etiquetaAvion}: sin TC de costos en ningún vuelo del periodo — indicadores USD vacíos`,
      );
    }
    if (modoExternos) {
      // EXTERNOS no tiene socios ni bloque de reparto: nada que avisar.
    } else if (socios.length === 0) {
      pendientes.push(
        `${etiquetaAvion}: sin socios vigentes configurados — el balance no reparte la utilidad`,
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
        `${etiquetaAvion}: hojas de gastos sin TC promedio — la utilidad después de gastos queda vacía`,
      );
    }
    if (vuelos.length === 0) {
      pendientes.push(
        `${etiquetaAvion}: sin vuelos en el periodo ${desde} a ${hasta}`,
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
      // Tramos cancelados fuera (como siempre: la consulta ahora los trae).
      if (e.cancelada_at != null) continue;
      if (
        (e.aeronave_id ?? avionPorVuelo.get(e.vuelo_id) ?? null) !== aircraftId
      )
        continue;
      for (const t of [num(e.taco_salida), num(e.taco_llegada)])
        if (t != null && t > maxTacoPeriodo) maxTacoPeriodo = t;
    }
    if (modoExternos) {
      // Sin avión de flota: sin programa de servicio que vigilar.
    } else if (intervalosServicio.filter((n) => n > 0).length === 0) {
      pendientes.push(
        `${etiquetaAvion}: sin programa de servicio por horas configurado (ficha del avión → Programa de servicio)`,
      );
    } else if (maxTacoPeriodo > 0) {
      const prox = this.aircraft.proximoServicio(
        intervalosServicio,
        Number(avion.servicio_horas_base ?? 0),
        maxTacoPeriodo,
      );
      if (prox) {
        pendientes.push(
          `${etiquetaAvion}: próximo servicio de ${prox.intervalo} h a las ${prox.a_las} — faltan ${prox.faltan} h (último tacómetro del periodo: ${maxTacoPeriodo.toFixed(1)})`,
        );
      }
    }

    return {
      generado: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Cancun',
      }).format(new Date()),
      matricula,
      modelo: avion.modelo,
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
      .select(
        'monto, moneda, escala_id, aeronave_id, escala:escala_id(aeronave_id), vuelo:vuelo_id(es_externo, aeronave_id)',
      )
      .eq('categoria', 'GAS')
      .is('aeronave_id', null)
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta);
    if (error) throw new Error(error.message);
    // El GAS de un vuelo EXTERNO sin avión NO está perdido: vive en la hoja
    // "combustible" del libro EXTERNOS del mes del vuelo (verificación
    // 28-ago). Mismo filtro en "Otros movimientos" y en el pre-cierre.
    const filas = ((data ?? []) as Array<Record<string, unknown>>).filter(
      (g) => !esVueloExternoSinAvion(vueloEmbebido(g)),
    );
    // Sin avión SELLADO pero con tramo/vuelo que sí resuelve un avión
    // (`avionDelGasto`, verificación 28-ago): la hoja "combustible" de ese
    // avión ya las carga — no están perdidas, pero el pre-cierre sigue
    // marcándolas "sin avión" hasta que se selle la aeronave.
    const resueltas = filas.filter((g) => avionDeGastoEmbebido(g) != null);
    const perdidas = filas.filter((g) => avionDeGastoEmbebido(g) == null);
    const out: string[] = [];
    if (perdidas.length > 0) {
      out.push(
        `FLOTA: ${perdidas.length} carga(s) de combustible SIN avión por ${resumenMontosPorMoneda(
          perdidas,
        )} — no aparecen en el balance de ningún avión ni en el reparto; asígnales aeronave en Combustibles`,
      );
    }
    if (resueltas.length > 0) {
      out.push(
        `FLOTA: ${resueltas.length} carga(s) de combustible sin avión SELLADO por ${resumenMontosPorMoneda(
          resueltas,
        )} — el balance las atribuye al avión de su tramo/vuelo (hoja "combustible"), pero el pre-cierre las sigue marcando sin avión: sella la aeronave en Combustibles`,
      );
    }
    return out;
  }

  /**
   * Red de seguridad (verificación 28-ago): gastos del periodo (eje
   * fecha_gasto) ligados a un vuelo SIN avión que no cae en NINGÚN libro.
   * Todos los libros (EXTERNOS incluido) y "Otros movimientos" filtran por
   * fecha_vuelo: un externo SIN fecha (prod: #166 COTIZADO con $1,595.37 de
   * gastos) no entra a ningún mes y, sin este aviso, su dinero desaparecía
   * en silencio. Un externo CON fecha en otro mes NO se avisa (vive en el
   * EXTERNOS de ese mes). Un vuelo sin avión que no es externo es imposible
   * por CHECK — se cubre por defensa. El GAS sellado a un avión de flota sí
   * vive (hoja combustible de ese avión, eje fecha_gasto): fuera.
   */
  private async pendienteGastosVueloSinLibro(
    desde: string,
    hasta: string,
  ): Promise<string[]> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(
        'categoria, monto, moneda, aeronave_id, vuelo:vuelo_id!inner(folio, aeronave_id, es_externo, fecha_vuelo)',
      )
      .is('vuelo.aeronave_id', null)
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta);
    if (error) throw new Error(error.message);
    const filas = ((data ?? []) as Array<Record<string, unknown>>).filter(
      (g) => {
        const v = vueloEmbebido(g);
        if (v == null || v.aeronave_id != null) return false;
        if (g.categoria === 'GAS' && g.aeronave_id != null) return false;
        return v.es_externo !== true || v.fecha_vuelo == null;
      },
    );
    if (filas.length === 0) return [];
    const folios = [
      ...new Set(
        filas.map((g) => {
          const v = vueloEmbebido(g);
          const f = v?.folio;
          const folio =
            typeof f === 'number' || typeof f === 'string' ? `#${f}` : '#¿?';
          const motivo =
            v?.es_externo === true ? 'externo sin fecha de vuelo' : 'sin avión';
          return `${folio}: ${motivo}`;
        }),
      ),
    ].join(', ');
    return [
      `FLOTA: ${filas.length} gasto(s) por ${resumenMontosPorMoneda(
        filas,
      )} de vuelos que no caen en ningún libro de este periodo (${folios}) — asigna fecha en Detalle del vuelo`,
    ];
  }

  /**
   * Colapsa las filas (una por concepto) de un vuelo de "Otros movimientos"
   * en UNA sola: ingresos sumados / egresos sumados, y el detalle en
   * `nota_ingreso` / `nota_egreso` (comentario de la celda en el Excel).
   * Un concepto sin MXN (USD sin TC) NO se suma: se marca en el concepto y
   * queda listado en la nota sin monto. El remanente = ingreso − egreso.
   */
  private colapsarFilasDeVuelo(
    filasVuelo: BalanceOtroMovimientoFilaPayload[],
    fmt: (n: number) => string,
  ): BalanceOtroMovimientoFilaPayload {
    const tipoDe = (c: string): string => {
      const t = c.toLowerCase();
      if (t.startsWith('tua')) return 'TUAs';
      if (t.startsWith('viáticos pernocta')) return 'pernocta';
      if (t.startsWith('iva')) return 'IVA';
      if (t.startsWith('viáticos') || t.startsWith('viaticos'))
        return 'pernocta';
      if (t.startsWith('sobrecobro')) return 'sobrecobro';
      if (t.startsWith('hotel')) return 'hotel';
      // Comisión del VENDEDOR (regla A) y su pago: ANTES del genérico
      // "comisión…", que está reservado a la comisión BANCARIA.
      if (
        t.startsWith('pago comisión vendedor') ||
        t.startsWith('pago comision vendedor')
      )
        return 'pago comisión vendedor';
      if (
        t.startsWith('comisión vendedor') ||
        t.startsWith('comision vendedor')
      )
        return 'comisión vendedor';
      if (t.startsWith('comisión') || t.startsWith('comision'))
        return 'comisión bancaria';
      if (t.startsWith('ajuste')) return 'ajuste';
      return c.includes('extra') || /^(espera|catering|transfer)/.test(t)
        ? 'extras'
        : t.split(' ')[0];
    };
    const lado = (
      key: 'ingreso' | 'egreso',
    ): {
      concepto: string | null;
      monto: number | null;
      fecha: string | null;
      nota: string | null;
    } => {
      const cKey = `concepto_${key}` as const;
      const mKey = `${key}_mxn` as const;
      const fKey = `fecha_${key}` as const;
      const rows = filasVuelo.filter((f) => f[cKey]);
      if (rows.length === 0)
        return { concepto: null, monto: null, fecha: null, nota: null };
      const conMonto = rows.filter((f) => f[mKey] != null);
      const sinTc = rows.filter(
        (f) => f[mKey] == null && !/referencia, no suma/.test(f[cKey] ?? ''),
      );
      const monto =
        conMonto.length > 0
          ? round2(conMonto.reduce((a, f) => a + (f[mKey] ?? 0), 0))
          : null;
      const tipos = [...new Set(rows.map((f) => tipoDe(f[cKey] ?? '')))];
      const concepto =
        rows.length === 1
          ? rows[0][cKey]
          : `${tipos.join(' + ')}${key === 'ingreso' ? ' con IVA' : ''} · ${rows.length} conceptos (ver nota)${
              sinTc.length ? ' (parcial: USD sin TC)' : ''
            }`;
      const fecha =
        rows
          .map((f) => f[fKey])
          .filter((x): x is string => !!x)
          .sort()[0] ?? null;
      const nota = rows
        .map(
          (f) =>
            `${f[cKey] ?? ''} = ${f[mKey] != null ? `$${fmt(f[mKey] ?? 0)}` : '—'}`,
        )
        .join('\n');
      return { concepto, monto, fecha, nota };
    };
    const ing = lado('ingreso');
    const egr = lado('egreso');
    const base = filasVuelo[0];
    return {
      clave: base.clave,
      avion_color: base.avion_color,
      estado: base.estado,
      fecha_vuelo: base.fecha_vuelo,
      factura: base.factura,
      concepto_ingreso: ing.concepto,
      ingreso_mxn: ing.monto,
      fecha_ingreso: ing.fecha,
      nota_ingreso: ing.nota,
      concepto_egreso: egr.concepto,
      egreso_mxn: egr.monto,
      fecha_egreso: egr.fecha,
      nota_egreso: egr.nota,
      remanente_mxn:
        ing.monto == null && egr.monto == null
          ? null
          : round2((ing.monto ?? 0) - (egr.monto ?? 0)),
    };
  }

  /**
   * Pestaña "Otros movimientos" del Balance GENERAL (28-ago, réplica de la
   * hoja manual "dinero otros ingresos" del cliente): por vuelo, los
   * conceptos cobrados al cliente (líneas TUAS/EXTRA/PERNOCTA/
   * COMISION_VENDEDOR del desglose canónico v1.3, en MXN con el TC de
   * venta) apareados con lo PAGADO solo cuando el mapeo es ESTRUCTURAL —
   * TUAS ↔ gastos TUAS + TUA embebido (tuaEmbebidoDeGasto, misma regla del
   * Libro Dinero), PERNOCTA ↔ gastos HOTEL del vuelo (solo REFERENCIA: el
   * hotel ya resta en PILOTO del avión), comisión bancaria de los cobros ↔
   * línea BillPocket, COMISIÓN DEL VENDEDOR ↔ su pago al vendedor
   * (PROVISIÓN por el mismo monto con fecha del vuelo: no hay categoría de
   * gasto para ese pago — regla A, 28-ago tarde). El resto de conceptos
   * queda como filas adyacentes por clave (el equipo los lee juntos; el
   * sistema jamás afirma un apareo que no puede garantizar).
   * Además: filas SUELTAS con el dinero hoy invisible en este Excel —
   * gastos sin vuelo NI avión NI reparto, GAS sin avión y TUAS sin vuelo.
   *
   * Reglas 28-ago (6 y 7): el ingreso de VUELATOUR (TUAS + extras +
   * pernocta + comisión del vendedor + su IVA) sale de
   * particionIngresoVuelo — la MISMA fuente que la venta del avión de la
   * hoja maestra — y una fila de cierre por vuelo ("iva y redondeo de
   * tuas/extras") garantiza Σ venta del avión + Σ ingresos de esta pestaña
   * == Σ total del cliente — identidad que EXCLUYE a los vuelos CANCELADO
   * (regla 28-ago tarde: su venta = cobros retenidos, sin partición; nada
   * de su cotización es ingreso de nadie — tampoco la comisión del
   * vendedor). El TUA PAGADO no resta en ninguna hoja por avión: esta
   * pestaña es su único lugar (apareado con la línea TUAS cobrada,
   * solo-egreso sin ella, suelto sin vuelo). Esta pestaña es POR VUELO: en
   * vuelos multi-avión (regla B) nada se reparte aquí.
   *
   * Universo: los MISMOS vuelos que la hoja maestra (TODOS los estados —
   * CANCELADO/COTIZADO/RESERVA incluidos — y el mismo K de venta vía
   * tcOficialPorVuelos); cada fila por vuelo lleva `estado` para que el
   * Excel pinte los cancelados. Un CANCELADO NO emite líneas de ingreso
   * (TUAS/extras/pernocta, IVA, sobrecobro): su dinero real ya es venta del
   * avión en la maestra; SÍ conserva sus egresos (TUA pagado, comisión
   * bancaria de sus cobros) como filas de solo-egreso, como cualquier
   * vuelo. Los vuelos EXTERNOS (con o sin avión) son
   * un vuelo más (regla 28-ago tarde): su venta, el costo del operador y
   * sus gastos viven en la hoja maestra (libro del avión de referencia o
   * libro EXTERNOS del general); aquí solo sus TUAs/extras/pernocta, el
   * sobrecobro y la comisión bancaria, como en cualquier vuelo.
   */
  private async buildOtrosMovimientos(
    desde: string,
    hasta: string,
    memoTc: Map<string, Promise<TipoCambioDetalle | null>> = new Map(),
  ): Promise<BalanceHojaOtrosMovimientosPayload> {
    const sb = this.supabase.service;
    const { data: vuelosData, error: vErr } = await sb
      .from('vuelo')
      .select(
        'id, folio, cliente_id, aeronave_id, estado, fecha_vuelo, fecha_solicitud, tc_usd_mxn, monto_total_usd, monto_total_mxn, subtotal_vuelo_usd, ajuste_final_usd, comision_vendedor_usd, comision_vendedor_nombre, iva_usd, iva_pct, tuas_usd, extras_total_usd, viaticos_pernocta_usd, calculo_snapshot, cliente:cliente_id(nombre)',
      )
      // MISMO universo que la hoja maestra (buildPayload): TODOS los
      // estados, CANCELADO/COTIZADO/RESERVA incluidos, externos con y sin
      // avión (regla 28-ago tarde: el externo es un vuelo más — su venta y
      // costo del operador viven en la maestra; aquí solo sus TUAs/extras
      // como los de todos). Filtrar por estado aquí hacía desaparecer del
      // general el TUA pagado de un cancelado. Los CANCELADO solo aportan
      // EGRESOS (regla 28-ago tarde: su venta = cobros retenidos, sin
      // partición; ver abajo). Cada fila viaja con `estado` y pyservices lo
      // pinta (CANCELADO en rojo).
      .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`)
      .order('fecha_vuelo', { ascending: true });
    if (vErr) throw new Error(vErr.message);
    const vuelos = (vuelosData ?? []) as Array<Record<string, unknown>>;
    const vueloIds = vuelos.map((v) => v.id as string);

    const vacio = { data: [], error: null } as const;
    const [
      avionesRes,
      gastosRes,
      cobrosRes,
      facturasRes,
      sueltosRes,
      gasRes,
      tuasSinVueloRes,
    ] = await Promise.all([
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
              'vuelo_id, monto, moneda, tc_usd_mxn, fecha_cobro, comision_banco_monto',
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
      // GAS sin avión (mismo universo que pendienteGasSinAvion: el de un
      // externo sin avión se excluye abajo — vive en el libro EXTERNOS; el
      // que resuelve avión por su tramo/vuelo también — vive en la hoja
      // "combustible" de ese avión).
      sb
        .from('gasto')
        .select(
          'id, monto, moneda, tc_gasto, fecha_gasto, lugar, escala_id, aeronave_id, escala:escala_id(aeronave_id), vuelo:vuelo_id(es_externo, aeronave_id)',
        )
        .eq('categoria', 'GAS')
        .is('aeronave_id', null)
        .gte('fecha_gasto', desde)
        .lte('fecha_gasto', hasta)
        .order('fecha_gasto', { ascending: true }),
      // TUAS sin vuelo CON avión (regla 7, 28-ago): fuera de las hojas del
      // avión (solo aviso ahí) — aquí es su único lugar. Los TUAS sin
      // vuelo SIN avión ya vienen en `sueltos`.
      sb
        .from('gasto')
        .select(
          'id, aeronave_id, categoria, monto, moneda, tc_gasto, fecha_gasto, lugar, proveedor:proveedor_id(nombre)',
        )
        .eq('categoria', 'TUAS')
        .is('vuelo_id', null)
        .not('aeronave_id', 'is', null)
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
      tuasSinVueloRes,
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
    const fmtMontoOM = (n: number) =>
      round2(n).toLocaleString('es-MX', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
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

    // TC de VENTA por vuelo: la MISMA cadena que la hoja maestra (K =
    // tc_usd_mxn capturado ?? TC oficial de referencia (open.er-api / BCE)
    // del día de la cotización, vía tcOficialPorVuelos con el MISMO memo
    // por día) — un vuelo se convierte con el mismo K en ambos lados.
    // monto_total_mxn/monto_total_usd queda como ÚLTIMO respaldo (vuelos
    // viejos sin TC ni dato oficial del día).
    const tcOficial = await this.tcOficialPorVuelos(
      vuelos.map((v) => ({
        id: v.id as string,
        tc_usd_mxn: v.tc_usd_mxn,
        fecha_solicitud: v.fecha_solicitud,
        fecha_vuelo: v.fecha_vuelo,
      })),
      memoTc,
    );
    // TC promedio del periodo (fallback de gastos sueltos sin TC propio).
    const tcs: number[] = [];
    const tcDe = (v: Record<string, unknown>): number | null => {
      const totalUsd = num(v.monto_total_usd);
      const totalMxn = num(v.monto_total_mxn);
      return (
        pos(v.tc_usd_mxn) ??
        tcOficial.get(v.id as string)?.tc ??
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
      const tc = tcDe(v);
      const clave = claveDe(v);
      const color = avion?.color ?? null;
      const factura = facturaPorVuelo.get(v.id as string) ?? null;
      // timestamptz → DÍA Cancún (un vuelo vespertino se corría al día UTC).
      const fechaVuelo = diaCancun((v.fecha_vuelo as string) ?? null);
      const gastosV = gastosPorVuelo.get(v.id as string) ?? [];
      const snapshot = v.calculo_snapshot as {
        desglose?: { clave?: string; concepto?: string; monto_usd?: number }[];
        meta?: { comision_vendedor_nombre?: unknown } | null;
      } | null;
      // Quién cobra la comisión del vendedor (regla A): columna del vuelo;
      // respaldo, la meta del snapshot. Etiqueta corta de la línea de
      // ingreso y de su pago apareado.
      const nombreVendedor =
        (typeof v.comision_vendedor_nombre === 'string' &&
          v.comision_vendedor_nombre.trim()) ||
        (typeof snapshot?.meta?.comision_vendedor_nombre === 'string' &&
          snapshot.meta.comision_vendedor_nombre.trim()) ||
        null;
      const etiquetaComision = `comisión vendedor${
        nombreVendedor ? ` (${nombreVendedor})` : ''
      }`;
      // CANCELADO (regla 28-ago tarde): SIN líneas de ingreso — lo cobrado
      // (retenido) es venta del avión en la hoja maestra, al 100 %, y nada
      // de la cotización se pagó. Solo quedan sus EGRESOS reales (TUA
      // pagado, comisión bancaria de sus cobros) como filas de solo-egreso.
      const canceladoOM = (v.estado as string | null) === 'CANCELADO';
      // Las filas de ESTE vuelo se generan línea por línea y al final se
      // colapsan en UNA (pedido del cliente 28-ago, ver abajo).
      const inicioFilasVuelo = filas.length;

      const base = {
        clave,
        avion_color: color,
        fecha_vuelo: fechaVuelo,
        factura,
        // Estado del vuelo (mismo universo que la maestra): pyservices pinta
        // CANCELADO en rojo. Las filas sueltas (sin vuelo) no lo llevan.
        estado: (v.estado as string | null) ?? null,
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
      // (misma regla que la hoja "Otros ingresos" del Libro Dinero) + UNA
      // fila de cierre por vuelo con el IVA de esos conceptos y el redondeo
      // (regla 28-ago): la parte de VuelaTour sale de particionIngresoVuelo
      // (la MISMA fuente única que la venta del avión de la hoja maestra),
      // así Σ venta del avión + Σ ingresos de esta pestaña == Σ total del
      // cliente, al centavo (vuelos NO cancelados). =====
      const p = particionIngresoVuelo({
        monto_total_usd: num(v.monto_total_usd),
        subtotal_vuelo_usd: num(v.subtotal_vuelo_usd),
        ajuste_final_usd: num(v.ajuste_final_usd),
        comision_vendedor_usd: num(v.comision_vendedor_usd),
        iva_usd: num(v.iva_usd),
        iva_pct: num(v.iva_pct),
        tuas_usd: num(v.tuas_usd),
        extras_total_usd: num(v.extras_total_usd),
        viaticos_pernocta_usd: num(v.viaticos_pernocta_usd),
        calculo_snapshot: v.calculo_snapshot,
      });
      // Σ USD de las líneas que SÍ se listan abajo (base del cierre).
      let sumLineasUsd = 0;
      // El egreso TUAS se adjunta SOLO a la primera línea TUAS (una línea
      // por aeropuerto: repetirlo duplicaba la columna egreso).
      let egresoTuasAsignado = false;
      let egresoPernoctaAsignado = false;
      let comisionBancoAsignada = false;

      // TUA PAGADO del vuelo (categoría TUAS + parte TUA embebida en
      // facturas de aeródromo vía tuaEmbebidoDeGasto — FUENTE ÚNICA, misma
      // exclusión CATS_SIN_TUA_EMBEBIDO que la fila del vuelo en la hoja
      // maestra), a MXN con la regla del workbook. Regla 7 (28-ago): el TUA
      // pagado no resta en ninguna hoja por avión — ESTA pestaña es su único
      // lugar: apareado con la línea TUAS cobrada o, sin línea, como fila de
      // solo-egreso. Vale para externos igual que para la flota (regla
      // 28-ago tarde: el externo es un vuelo más).
      let tuaPagadoMxn = 0;
      let tuaPagadoHubo = false;
      let tuaSinTc = false;
      let fechaTua: string | null = null;
      for (const g of gastosV) {
        const monto = num(g.monto) ?? 0;
        const parte =
          g.categoria === 'TUAS'
            ? monto
            : tuaEmbebidoDeGasto({
                vuelo_id: (g.vuelo_id as string | null) ?? null,
                categoria: (g.categoria as string | null) ?? null,
                monto: g.monto as string | number | null,
                propina: g.propina as string | number | null,
                valor_ia_extraido: g.valor_ia_extraido,
                es_reparto_parcial: g.es_reparto_parcial === true,
              });
        if (parte <= 0) continue;
        const parteMxn = gastoMxn(g, parte);
        if (parteMxn == null) {
          // USD sin ningún TC: rastro en la fila, jamás sumado en falso.
          tuaSinTc = true;
          continue;
        }
        if (parteMxn <= 0) continue;
        tuaPagadoMxn += parteMxn;
        tuaPagadoHubo = true;
        fechaTua ??= (g.fecha_gasto as string) ?? null;
      }
      const conceptoTuasPagadas = `tuas pagadas${
        tuaSinTc
          ? tuaPagadoHubo
            ? ' (parcial: USD sin TC)'
            : ' (USD sin TC)'
          : ''
      }`;

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

      // Líneas de VuelaTour del desglose con su IVA YA SUMADO (pedido del
      // cliente 28-ago tarde: "TUA MHL = $500" y se entiende, sin renglón
      // aparte de IVA). El IVA de VuelaTour (p.iva_vuelatour_usd) se
      // reparte proporcional entre las líneas GRAVADAS (TUAS y extras sin
      // "(sin IVA)"; la pernocta no grava) y los centavos de redondeo se
      // absorben en la última línea: Σ líneas == p.vuelatour_usd exacto.
      const desgloseVT: {
        clave?: string;
        concepto?: string;
        monto_usd?: number;
      }[] = canceladoOM ? [] : (snapshot?.desglose ?? []);
      // Regla A (28-ago tarde): la COMISIÓN DEL VENDEDOR es una línea más
      // del ingreso de VuelaTour ("como un extra"): gravada (su IVA se
      // pliega igual que TUAS/extras) y apareada abajo con su PAGO.
      const lineasVT = desgloseVT
        .filter((l) =>
          /^(TUAS|EXTRA|PERNOCTA|COMISION_VENDEDOR)/.test(
            String(l.clave ?? ''),
          ),
        )
        .map((l) => ({
          clave: String(l.clave ?? ''),
          concepto: String(l.concepto ?? l.clave ?? ''),
          montoUsd: num(l.monto_usd) ?? 0,
        }))
        .filter((l) => l.montoUsd !== 0);
      const gravada = (l: { clave: string; concepto: string }) =>
        l.clave === 'TUAS' ||
        l.clave === 'COMISION_VENDEDOR' ||
        (l.clave === 'EXTRA' && !/\(sin IVA\)\s*$/i.test(l.concepto));
      const esComision = (l: { clave: string }) =>
        l.clave === 'COMISION_VENDEDOR';
      // PAGO AL VENDEDOR — fuente única `pagoVendedorUsd` (comisión + su
      // IVA cuando la cotización grava; verificación 28-ago: aquí y en el
      // Libro Dinero se provisionaba comisión + IVA prorrateado, mientras
      // el reporte por vuelo restaba solo la comisión — dos definiciones).
      // La línea COMISION_VENDEDOR se lista con ESE total (no con un
      // prorrateo del IVA de VuelaTour que podía diferir un centavo) y su
      // provisión apareada toma el mismo número: el par ingreso/egreso
      // cierra en 0 por construcción. Con partición inconsistente no hay
      // partición que provisionar (líneas crudas, sin IVA; la fila de
      // cierre las neutraliza).
      const pagoVendedor = p.inconsistente ? 0 : pagoVendedorUsd(p);
      const ivaComision = p.inconsistente ? 0 : ivaComisionVendedorUsd(p);
      const comisionLineasUsd = round2(
        lineasVT.filter(esComision).reduce((a, l) => a + l.montoUsd, 0),
      );
      // IVA de VuelaTour que queda para TUAS/extras gravados (el de la
      // comisión ya viaja dentro de pagoVendedor).
      const baseGravada = round2(
        lineasVT
          .filter((l) => gravada(l) && !esComision(l))
          .reduce((a, l) => a + l.montoUsd, 0),
      );
      const ivaVT = p.inconsistente
        ? 0
        : round2(p.iva_vuelatour_usd - ivaComision);
      const lineasConIva = lineasVT.map((l) => ({
        ...l,
        totalUsd: esComision(l)
          ? // Normalmente UNA línea (motor v1.3): lleva pagoVendedor entero;
            // con varias, proporcional a su monto.
            p.inconsistente || comisionLineasUsd <= 0
            ? l.montoUsd
            : round2((pagoVendedor * l.montoUsd) / comisionLineasUsd)
          : round2(
              l.montoUsd +
                (gravada(l) && baseGravada > 0
                  ? round2((ivaVT * l.montoUsd) / baseGravada)
                  : 0),
            ),
      }));
      // Sin desglose canónico (fuente 'columnas'): la comisión del vendedor
      // se lista igual desde p.comision_vendedor_usd (> 0) con el MISMO
      // helper (pagoVendedorUsd: comisión + su IVA solo si la cotización
      // grava, topado en la parte de VuelaTour). El resto (TUAS/extras/
      // pernocta + IVA) sigue en la fila de cierre de abajo (que se calcula
      // por diferencia: Σ líneas + cierre == p.vuelatour_usd exacto).
      if (
        !canceladoOM &&
        !p.inconsistente &&
        p.fuente === 'columnas' &&
        p.comision_vendedor_usd > 0
      ) {
        lineasConIva.push({
          clave: 'COMISION_VENDEDOR',
          concepto: 'Comisión del vendedor',
          montoUsd: p.comision_vendedor_usd,
          totalUsd: pagoVendedor,
        });
      }
      if (
        lineasConIva.length > 0 &&
        !p.inconsistente &&
        p.fuente === 'desglose'
      ) {
        // El residuo (centavos del prorrateo del IVA) lo absorbe la ÚLTIMA
        // línea que NO sea la comisión del vendedor — así esa línea queda
        // EXACTAMENTE en pagoVendedorUsd y su provisión cierra en 0. Si la
        // comisión es la única línea, la absorbe ella y la provisión toma
        // ese mismo total (el par sigue cerrando en 0).
        const receptor =
          [...lineasConIva].reverse().find((l) => !esComision(l)) ??
          lineasConIva[lineasConIva.length - 1];
        const residuo = round2(
          p.vuelatour_usd - lineasConIva.reduce((a, l) => a + l.totalUsd, 0),
        );
        if (Math.abs(residuo) >= 0.005)
          receptor.totalUsd = round2(receptor.totalUsd + residuo);
      }
      const etiquetaCorta = (l: {
        clave: string;
        concepto: string;
      }): string => {
        if (l.clave === 'TUAS') {
          const m = /^TUA\s+([A-Za-z]{3})/i.exec(l.concepto);
          return m ? `TUA ${m[1].toUpperCase()}` : 'TUA';
        }
        if (l.clave === 'PERNOCTA') return 'viáticos pernocta';
        if (l.clave === 'COMISION_VENDEDOR') return etiquetaComision;
        return l.concepto
          .replace(/\s*\(sin IVA\)\s*$/i, '')
          .split(' · ')[0]
          .trim();
      };
      for (const linea of lineasConIva) {
        const claveLinea = linea.clave;
        const montoUsd = linea.totalUsd;
        sumLineasUsd += montoUsd;
        const ingresoMxn = tc != null ? r2(montoUsd * tc) : null;
        let egresoMxn: number | null = null;
        let conceptoEgreso: string | null = null;
        let fechaEgreso: string | null = null;
        // TUA cobrado ↔ TUA pagado (pre-calculado arriba).
        if (
          claveLinea === 'TUAS' &&
          !egresoTuasAsignado &&
          (tuaPagadoHubo || tuaSinTc)
        ) {
          egresoMxn = tuaPagadoHubo ? r2(tuaPagadoMxn) : null;
          conceptoEgreso = conceptoTuasPagadas;
          fechaEgreso = fechaTua;
          egresoTuasAsignado = true;
        } else if (claveLinea === 'PERNOCTA' && !egresoPernoctaAsignado) {
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
            // REFERENCIA, no egreso: el hotel YA resta en la columna PILOTO
            // del avión en la hoja maestra — sumarlo aquí también duplicaba
            // el costo en la narrativa. Decisión pendiente del cliente: si
            // el hotel debe SALIR del avión, este egreso se vuelve real y la
            // columna PILOTO lo suelta (una sola regla, nunca las dos).
            egresoMxn = null;
            conceptoEgreso = `hotel pagado $${round2(suma).toLocaleString(
              'es-MX',
              { minimumFractionDigits: 2, maximumFractionDigits: 2 },
            )} — ya resta en PILOTO del avión (referencia, no suma)`;
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
        } else if (claveLinea === 'COMISION_VENDEDOR' && !p.inconsistente) {
          // PAGO al vendedor (regla A, 28-ago tarde): hoy NO existe
          // categoría de gasto para este pago (CategoriaGasto no tiene
          // "comisión de venta"), así que se PROVISIONA por el MISMO monto
          // de la línea cobrada — pagoVendedorUsd(p) × K (comisión + su IVA,
          // fuente única; el neto de VuelaTour es el precio base, regla
          // 23-jul; si el residuo del prorrateo cayó en esta línea, la
          // provisión toma ese mismo total) — con fecha del vuelo; la fila
          // cierra en remanente 0 exacto. SOLO cuando existe la línea de
          // ingreso de comisión y la partición es consistente (con
          // partición inconsistente no hay ingreso real que aparear: la
          // fila de cierre neutraliza las líneas). El concepto lo dice
          // ("PROVISIÓN") y la nota de la celda lo repite. Cuando exista la
          // categoría, aparear con el gasto real como se hace con TUAS y
          // dejar la provisión solo cuando no haya gasto. Prefijo "pago
          // comisión vendedor" a propósito: el clasificador de la nota
          // (colapsarFilasDeVuelo) reserva "comisión…" a secas para la
          // comisión BANCARIA. Una provisión por CADA línea de comisión
          // (normalmente una): Σ egresos == Σ ingresos de comisión.
          egresoMxn = ingresoMxn;
          conceptoEgreso = `pago ${etiquetaComision} · PROVISIÓN (mismo monto que lo cobrado: comisión + IVA; sin gasto real capturado)${
            ingresoMxn == null ? ' (USD sin TC de venta)' : ''
          }`;
          fechaEgreso = fechaVuelo;
        }
        filas.push({
          ...filaVacia,
          concepto_egreso: conceptoEgreso,
          egreso_mxn: egresoMxn,
          fecha_egreso: fechaEgreso,
          concepto_ingreso: `${etiquetaCorta(linea)}${
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

      // Cierre del ingreso de VuelaTour: con desglose v1.3 el IVA y el
      // redondeo YA van dentro de cada línea (arriba), así que este residuo
      // es 0 y no sale fila. Solo queda para los casos sin líneas: UNA fila
      // por vuelo, solo si mueve ≥ 1 centavo. Si el desglose no cuadró (p.inconsistente) la
      // venta del avión lleva el total COMPLETO y esta fila NEUTRALIZA las
      // líneas de arriba (el cuadre se conserva; el balance lo grita). Sin
      // snapshot v1.3 (fuente 'columnas') no hay líneas que listar: esta
      // fila lleva TODO el ingreso de VuelaTour y lo dice en el concepto.
      // CANCELADO: sin ingreso alguno (residuo 0).
      const residuoUsd = canceladoOM
        ? 0
        : round2(p.vuelatour_usd - sumLineasUsd);
      const residuoMxn = tc != null ? r2(residuoUsd * tc) : null;
      if (
        residuoMxn != null
          ? Math.abs(residuoMxn) >= 0.01
          : Math.abs(residuoUsd) >= 0.01
      ) {
        const sinTcVenta = residuoMxn == null ? ' (USD sin TC de venta)' : '';
        filas.push({
          ...filaVacia,
          concepto_ingreso: p.inconsistente
            ? 'ajuste: desglose de la cotización inconsistente (la venta del avión lleva el total completo)'
            : p.fuente === 'columnas'
              ? `tuas/extras/pernocta cobrados + iva (sin desglose canónico: estimado con columnas)${sinTcVenta}`
              : `iva y redondeo de tuas/extras${sinTcVenta}`,
          ingreso_mxn: residuoMxn,
          fecha_ingreso: fechaVuelo,
          remanente_mxn: residuoMxn,
        });
      }

      // TUA pagado SIN línea TUAS cobrada en el desglose (vuelo cotizado sin
      // TUAS, TUA que apareció en la factura del aeródromo…): fila de
      // solo-egreso — el pago existe aunque no se haya trasladado al
      // cliente (patrón de la comisión bancaria sin línea BillPocket).
      if ((tuaPagadoHubo || tuaSinTc) && !egresoTuasAsignado) {
        const egreso = tuaPagadoHubo ? r2(tuaPagadoMxn) : null;
        filas.push({
          ...filaVacia,
          concepto_egreso: conceptoTuasPagadas,
          egreso_mxn: egreso,
          fecha_egreso: fechaTua,
          remanente_mxn: egreso != null ? r2(-egreso) : null,
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

      // SOBRECOBRO (regla del cliente 28-ago-2026): lo cobrado por encima de
      // la cotización no es del avión (cobradoParteAvion lo topa) — es
      // ingreso de VuelaTour y sale aquí como los extras. Misma fuente que
      // el reparto (cobrosEnUsd + partición). CANCELADO: no aplica — TODO lo
      // cobrado es venta del avión (no hay "por encima de la cotización").
      if (!canceladoOM) {
        const vCobrosOM = (cobrosPorVuelo.get(v.id as string) ?? []) as Array<{
          monto: string | number | null;
          moneda: string | null;
          tc_usd_mxn: string | number | null;
          fecha_cobro: string | null;
        }>;
        if (vCobrosOM.length > 0 && p.total_usd > 0) {
          const cobradoUsd = cobrosEnUsd(
            vCobrosOM.map((c) => ({
              monto: c.monto,
              moneda: c.moneda,
              tc_usd_mxn: c.tc_usd_mxn,
            })),
            tc ?? undefined,
          ).total_usd;
          const exceso = sobrecobroUsd(cobradoUsd, p);
          if (exceso >= 0.01) {
            const ingreso = tc != null ? r2(exceso * tc) : null;
            const ultimo = vCobrosOM[vCobrosOM.length - 1];
            filas.push({
              ...filaVacia,
              concepto_ingreso: `sobrecobro (cobrado $${fmtMontoOM(exceso)} USD por encima de la cotización)${
                ingreso == null ? ' (USD sin TC de venta)' : ''
              }`,
              ingreso_mxn: ingreso,
              fecha_ingreso: diaCancun(ultimo?.fecha_cobro ?? null),
              remanente_mxn: ingreso,
            });
          }
        }
      }

      // (Los vuelos EXTERNOS ya no tienen bloque propio aquí — regla 28-ago
      // tarde: su venta, el costo del operador y sus gastos viven en la hoja
      // maestra, en el libro EXTERNOS del general o en el del avión de
      // referencia; en esta pestaña solo sus TUAs/extras/pernocta, el
      // sobrecobro y la comisión bancaria, como en cualquier vuelo.)

      // ===== UNA FILA POR VUELO (pedido del cliente, tarde del 28-ago):
      // los ingresos del vuelo van SUMADOS en una celda y los egresos en
      // otra, con el desglose línea por línea en la NOTA de cada celda
      // (pyservices la pinta como comentario de Excel). Ahorra espacio y se
      // lee mejor; el dinero es el mismo: Σ de las líneas que ya se
      // calcularon arriba. Un concepto sin TC no se suma en falso: la celda
      // lleva "(parcial: USD sin TC)" y la nota lo muestra sin monto.
      const filasVuelo = filas.splice(inicioFilasVuelo);
      if (filasVuelo.length > 1) {
        filas.push(this.colapsarFilasDeVuelo(filasVuelo, fmtMontoOM));
      } else if (filasVuelo.length === 1) {
        filas.push(filasVuelo[0]);
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
          // TUAS sin vuelo (regla 7): clave propia — no restan en ninguna
          // hoja por avión; aquí es su único lugar.
          sueltas.push(
            sueltaDe(g, g.categoria === 'TUAS' ? 'tuas sin vuelo' : 'empresa'),
          );
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
      // GAS de un vuelo EXTERNO sin avión: hoja "combustible" del libro
      // EXTERNOS (no es "gas sin avión" — se contaría dos veces).
      if (esVueloExternoSinAvion(vueloEmbebido(g))) continue;
      // GAS sin avión SELLADO pero con tramo/vuelo que resuelve avión
      // (`avionDelGasto`): vive en la hoja "combustible" de ese avión —
      // aquí se contaría dos veces (el aviso de pendientes lo sigue
      // señalando para que se selle la aeronave).
      if (avionDeGastoEmbebido(g) != null) continue;
      sueltas.push(sueltaDe(g, 'gas sin avión'));
    }
    // TUAS sin vuelo CON avión (regla 7, 28-ago): el libro del avión solo
    // los avisa (no restan en ninguna hoja) — aquí es su único lugar, con la
    // matrícula en el concepto y el color del avión.
    for (const g of (tuasSinVueloRes.data ?? []) as Array<
      Record<string, unknown>
    >) {
      const av = aviones.get(g.aeronave_id as string);
      const base = sueltaDe(g, 'tuas sin vuelo');
      sueltas.push({
        ...base,
        avion_color: av?.color ?? null,
        concepto_egreso: `${av?.matricula ?? 'avión ¿?'} · ${
          base.concepto_egreso ?? 'tuas'
        }`,
      });
    }

    return { filas, filas_sueltas: sueltas };
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
