/**
 * ARMADOR PURO del payload del PDF «Cotización interna» (8-sep-2026).
 *
 * Documento de UNA hoja para la oficina (administración imprime la
 * cotización SIN fotos ni fichas de avión y CON toda la cocina interna:
 * comisión del vendedor, horas cotizadas vs tacos, cobros con comisión
 * bancaria y neto, gastos). JAMÁS se manda al cliente.
 *
 * Disciplina de números (regla del workspace: fuentes únicas, nada de
 * cálculos paralelos):
 *  - Desglose = `calculo_snapshot.desglose` canónico v1.3 tal cual (orden y
 *    montos intactos; Σ == total). Aquí solo se ENRIQUECE cada línea con la
 *    operación que la produjo (cantidad × unitario) leída del mismo snapshot
 *    (`tiempos`, `tarifa`, `tuas.filas`, `extras`, `meta`) para que la
 *    plantilla la escriba sin recalcular. Los TUAS exentos viajan como
 *    líneas sintéticas a $0 (`exento: true`): no alteran la suma.
 *  - Cobrado = `cobrosEnUsd`; partición = `particionIngresoVuelo`; pago al
 *    vendedor = `pagoVendedorUsd`; multi-avión = `participacionPorAeronave`
 *    + `repartirUsd`; conciliado = lo que ya trae `FlightsService.listCobros`
 *    (fuente única cobro-conciliado.util); semáforo = espejo del panel
 *    (`semaforo-cobro.util`).
 *  - Horas voladas por tramo = `taco_llegada − taco_salida` a 1 decimal
 *    (mismo patrón que el reporte por vuelo); el total suma solo tramos no
 *    cancelados con dato.
 *  - Neto de un cobro = `monto − comision_banco_monto` (regla
 *    comision-bancaria.util: el neto nunca se persiste).
 *
 * Sin BD ni Nest: `QuotesPdfInternoService` carga los insumos y llama a
 * `armarCotizacionInternaPayload`; los specs lo prueban con snapshots
 * simulados.
 */
import { etiquetaCategoriaGasto } from '../../common/categoria-gasto.util';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import { fechaHoraCancun } from '../../common/fecha-cancun.util';
import { horasTacoDe, sumaHorasTaco } from '../../common/horas-taco.util';
import {
  ivaComisionVendedorUsd,
  pagoVendedorUsd,
  particionIngresoVuelo,
} from '../../common/ingreso-vuelo.util';
import {
  participacionPorAeronave,
  repartirUsd,
  type EscalaParticipacionInput,
} from '../../common/participacion-aeronave.util';
import { puntosRutaVisible } from '../../common/ruta-visible.util';
import { estadoCobroSemaforo } from '../../common/semaforo-cobro.util';
import {
  apoyosNivelVuelo,
  type VueloApoyoRow,
} from '../../common/tripulacion.util';
import type {
  CotizacionInternaCobroPdf,
  CotizacionInternaFacturaPdf,
  CotizacionInternaGastoCategoriaPdf,
  CotizacionInternaLineaPdf,
  CotizacionInternaPdfRequest,
  CotizacionInternaTramoPdf,
  ReporteVueloParticipacionPayload,
} from '../pyservices/pyservices.service';

// ===== Insumos (lo que carga el servicio) =====

/** Fila de `vuelo` como la devuelve `QuotesService.findById` (VUELO_COLS + extras). */
export type QuoteInternaRow = Record<string, unknown>;

/** Escala VIVA con tacos y tripulación (query propia del servicio, orden asc, canceladas incluidas). */
export interface EscalaInternaRow {
  id?: string | null;
  orden: number | string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  aeronave_id?: string | null;
  piloto_id?: string | null;
  copiloto_id?: string | null;
  pasajeros?: number | string | null;
  es_ferry?: boolean | null;
  es_sobrevuelo?: boolean | null;
  solo_operativa?: boolean | null;
  requiere_pernocta?: boolean | null;
  pernocta_costo_usd?: number | string | null;
  fecha_salida_plan?: string | null;
  taco_salida?: number | string | null;
  taco_llegada?: number | string | null;
  taco_salida_origen?: string | null;
  taco_llegada_origen?: string | null;
  hora_salida?: string | null;
  hora_llegada?: string | null;
  revision_requerida?: boolean | null;
  cancelada_at?: string | null;
  cancelada_motivo?: string | null;
}

/** Fila de `FlightsService.listCobros` (COBRO_COLS + cobro_grupo + conciliado). */
export interface CobroInternoRow {
  id?: string;
  monto?: unknown;
  moneda?: unknown;
  metodo_cobro?: unknown;
  tc_usd_mxn?: unknown;
  comision_banco_pct?: unknown;
  comision_banco_monto?: unknown;
  cuenta_destino?: unknown;
  referencia?: unknown;
  fecha_cobro?: unknown;
  registrado_por?: unknown;
  notas?: unknown;
  created_at?: unknown;
  grupo_factor?: unknown;
  cobro_grupo?: {
    grupo_folio?: number | null;
    monto_total?: number;
    moneda?: string;
  } | null;
  conciliado?: boolean;
  [k: string]: unknown;
}

export interface GastoInternoRow {
  categoria?: string | null;
  monto?: number | string | null;
  moneda?: string | null;
  tc_gasto?: number | string | null;
}

export interface FacturaInternaRow {
  serie?: string | null;
  folio?: string | number | null;
  uuid_fiscal?: string | null;
  estado?: string | null;
  total?: number | string | null;
  moneda?: string | null;
  fecha_timbrado?: string | null;
  facturado_a_nombre?: string | null;
  cancelada_at?: string | null;
  created_at?: string | null;
}

export interface ClienteInternoRow {
  nombre?: string | null;
  razon_social_default?: string | null;
  rfc?: string | null;
  es_broker?: boolean | null;
}

export interface FichaAvionInterna {
  matricula: string | null;
  modelo: string | null;
}

export interface CotizacionInternaInsumos {
  quote: QuoteInternaRow;
  escalas: EscalaInternaRow[];
  cobros: CobroInternoRow[];
  gastos: GastoInternoRow[];
  facturas: FacturaInternaRow[];
  cliente: ClienteInternoRow | null;
  /** usuario.id → nombre (piloto, copiloto, apoyos, created_by, registrado_por). */
  nombrePorId: ReadonlyMap<string, string>;
  /** aeronave.id → ficha (tramos, cotizado, operativo, participación). */
  aeronavePorId: ReadonlyMap<string, FichaAvionInterna>;
  apoyos: VueloApoyoRow[];
  /** `vuelo.created_by` (no viene en VUELO_COLS). */
  creadoPorId: string | null;
  generadoPor: string | null;
  /** Instante de generación (default: ahora). */
  ahora?: Date;
}

// ===== Helpers =====

const ESTADO_LABEL: Record<string, string> = {
  RESERVA: 'Reserva',
  SOLICITUD: 'Solicitud',
  COTIZADO: 'Cotizado',
  CONFIRMADO: 'Confirmado',
  EN_VUELO: 'En vuelo',
  COMPLETADO: 'Completado',
  CANCELADO: 'Cancelado',
};

/** Mismo mapa que el recibo de cobro y el panel admin (+ PAYWISE, 2-sep). */
const METODO_LABEL: Record<string, string> = {
  TRANSFERENCIA: 'Transferencia',
  HSBC_LINK: 'HSBC link',
  CHEQUE: 'Cheque',
  BILLPOCKET: 'BillPocket',
  EFECTIVO: 'Efectivo',
  DOLARES: 'Dólares',
  OTRO: 'Otro',
  PAYWISE: 'Paywise',
};

const TARIFA_LABEL: Record<string, string> = {
  PUBLICO: 'Público',
  BROKER: 'Broker',
};

/** Categorías que NO son dinero de la empresa (fuera de todo total). */
const CATEGORIAS_FUERA = new Set(['PERSONAL_DUENO']);

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function round1(n: number): number {
  return Number(n.toFixed(1));
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function arr(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v)
    ? (v.filter((x) => x && typeof x === 'object') as Array<
        Record<string, unknown>
      >)
    : [];
}

/** PostgREST devuelve la relación embebida como objeto o como arreglo de uno. */
function rel(v: unknown): Record<string, unknown> | null {
  if (Array.isArray(v)) return obj(v[0]);
  return obj(v);
}

/** Folio (número o texto) como cadena; null si no es imprimible. */
function folioTexto(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return str(v);
}

/** Re-export: la fuente única vive en `src/common/horas-taco.util.ts`. */
export { horasTacoDe };

/** Etiqueta "Modelo · Matrícula" (lo que haya). */
function fichaTexto(f: FichaAvionInterna | null | undefined): string | null {
  if (!f) return null;
  const t = [str(f.modelo), str(f.matricula)].filter(Boolean).join(' · ');
  return t || null;
}

// ===== Armador =====

export function armarCotizacionInternaPayload(
  insumos: CotizacionInternaInsumos,
): CotizacionInternaPdfRequest {
  const {
    quote: q,
    escalas,
    cobros,
    gastos,
    facturas,
    cliente,
    nombrePorId,
    aeronavePorId,
    apoyos,
    creadoPorId,
    generadoPor,
  } = insumos;
  const ahora = insumos.ahora ?? new Date();
  const nombreDe = (id: unknown): string | null =>
    typeof id === 'string' && id ? (nombrePorId.get(id) ?? null) : null;

  const snap = obj(q.calculo_snapshot);
  const tiempos = obj(snap?.tiempos);
  const tarifa = obj(snap?.tarifa);
  const tuas = obj(snap?.tuas);
  const ivaSnap = obj(snap?.iva);
  const totales = obj(snap?.totales);
  const meta = obj(snap?.meta);
  const tramosSnap = arr(snap?.tramos);
  const estado = str(q.estado) ?? '';
  const cancelado = estado === 'CANCELADO';
  const esExterno = q.es_externo === true;
  const esInterno = meta?.cliente_interno === true;
  const tcVuelo = num(q.tc_usd_mxn);
  const aeronaveId = str(q.aeronave_id);

  // ---- Horas ----
  const tiempoCobrable =
    num(tiempos?.cobrable_hr) ?? num(q.tiempo_cobrable_hr) ?? null;
  const tarifaHora = num(tarifa?.usd_por_hora) ?? num(q.tarifa_hora_usd);
  const vueloHr = num(tiempos?.vuelo_hr);
  const calzosHr = num(tiempos?.calzos_hr);
  const sobrevueloHr = num(tiempos?.sobrevuelo_hr);
  let horasCotizadas: number | null = null;
  if (vueloHr != null) {
    horasCotizadas = round4(vueloHr + (calzosHr ?? 0) + (sobrevueloHr ?? 0));
  } else if (tramosSnap.length > 0) {
    const suma = tramosSnap.reduce(
      (acc, t) => acc + (num(t.tiempo_hr) ?? 0),
      0,
    );
    horasCotizadas = suma > 0 ? round4(suma) : null;
  } else {
    horasCotizadas = tiempoCobrable;
  }

  // ---- Itinerario (escalas VIVAS; sin escalas cae al snapshot) ----
  const snapPorOrden = new Map<number, Record<string, unknown>>();
  for (const t of tramosSnap) {
    const o = num(t.orden);
    if (o != null && !snapPorOrden.has(o)) snapPorOrden.set(o, t);
  }
  const cotizada = obj(q.aeronave_cotizada);
  const snapAeronave = obj(snap?.aeronave);
  const cotizadaId = str(cotizada?.id) ?? str(snapAeronave?.id);
  const fichaCotizada: FichaAvionInterna | null = cotizada
    ? { matricula: str(cotizada.matricula), modelo: str(cotizada.modelo) }
    : snapAeronave
      ? {
          matricula: str(snapAeronave.matricula),
          modelo: str(snapAeronave.modelo),
        }
      : esExterno
        ? {
            matricula: str(q.avion_externo_matricula),
            modelo: str(q.avion_externo_modelo),
          }
        : null;
  const matriculaDeTramo = (escalaAeronaveId: unknown): string | null => {
    const id = str(escalaAeronaveId) ?? aeronaveId;
    if (str(escalaAeronaveId) == null && esExterno) {
      // Tramo sin avión propio en un vuelo cubierto por externo: vuela el
      // avión AJENO (el aeronave_id del vuelo es solo referencia de tarifa).
      return str(q.avion_externo_matricula);
    }
    return id ? (aeronavePorId.get(id)?.matricula ?? null) : null;
  };
  const escalasOrdenadas = [...escalas].sort(
    (a, b) => (num(a.orden) ?? 0) - (num(b.orden) ?? 0),
  );
  let tramos: CotizacionInternaTramoPdf[];
  if (escalasOrdenadas.length > 0) {
    tramos = escalasOrdenadas.map((e, idx) => {
      const ordenReal = num(e.orden) ?? idx + 1;
      const ts = snapPorOrden.get(ordenReal);
      // Cruce snapshot ↔ escala por orden Y mismo par origen/destino: con
      // itinerario operativo (ferries intercalados, otra base) el orden no
      // identifica el mismo tramo y se atribuirían horas ajenas.
      const horasCot =
        ts &&
        str(ts.origen) === str(e.origen_iata) &&
        str(ts.destino) === str(e.destino_iata)
          ? num(ts.tiempo_hr)
          : null;
      const esFerry = e.es_ferry === true;
      return {
        orden: idx + 1,
        orden_real: ordenReal,
        origen: str(e.origen_iata) ?? '',
        destino: str(e.destino_iata) ?? '',
        pasajeros: esFerry ? 0 : num(e.pasajeros),
        fecha_plan: str(e.fecha_salida_plan),
        hora_salida: str(e.hora_salida),
        hora_llegada: str(e.hora_llegada),
        matricula: matriculaDeTramo(e.aeronave_id),
        piloto: nombreDe(e.piloto_id) ?? nombreDe(q.piloto_id),
        taco_salida: num(e.taco_salida),
        taco_llegada: num(e.taco_llegada),
        taco_salida_origen: str(e.taco_salida_origen),
        taco_llegada_origen: str(e.taco_llegada_origen),
        horas_taco: horasTacoDe(e.taco_salida, e.taco_llegada),
        horas_cotizadas: horasCot,
        es_ferry: esFerry,
        solo_operativa: e.solo_operativa === true,
        es_sobrevuelo: e.es_sobrevuelo === true,
        requiere_pernocta: e.requiere_pernocta === true,
        pernocta_usd: num(e.pernocta_costo_usd) ?? 0,
        cancelado: e.cancelada_at != null,
        cancelada_motivo: str(e.cancelada_motivo),
        revision_requerida: e.revision_requerida === true,
      };
    });
  } else {
    tramos = tramosSnap.map((t, idx) => {
      const esFerry = t.es_ferry === true;
      return {
        orden: idx + 1,
        orden_real: num(t.orden) ?? idx + 1,
        origen: str(t.origen) ?? '',
        destino: str(t.destino) ?? '',
        pasajeros: esFerry ? 0 : num(t.pasajeros),
        fecha_plan: null,
        hora_salida: null,
        hora_llegada: null,
        matricula: fichaCotizada?.matricula ?? null,
        piloto: nombreDe(q.piloto_id),
        taco_salida: null,
        taco_llegada: null,
        taco_salida_origen: null,
        taco_llegada_origen: null,
        horas_taco: null,
        horas_cotizadas: num(t.tiempo_hr),
        es_ferry: esFerry,
        solo_operativa: false,
        es_sobrevuelo: false,
        requiere_pernocta: t.requiere_pernocta === true,
        pernocta_usd: num(t.pernocta_usd) ?? 0,
        cancelado: false,
        cancelada_motivo: null,
        revision_requerida: false,
      };
    });
  }
  // Voladas = Σ tacos de tramos NO cancelados (fuente única horas-taco.util).
  const horasVoladas = sumaHorasTaco(
    tramos.filter((t) => !t.cancelado).map((t) => t.horas_taco),
  );
  // Δ voladas − cotizadas ya calculado aquí: la plantilla solo lo pinta.
  const deltaHoras =
    horasVoladas != null && horasCotizadas != null
      ? round1(horasVoladas - horasCotizadas)
      : null;
  const vivas = escalasOrdenadas.filter((e) => e.cancelada_at == null);
  const ruta =
    vivas.length > 0
      ? puntosRutaVisible(vivas).join(' → ')
      : tramos.length > 0
        ? puntosRutaVisible(
            tramos.map((t) => ({
              origen_iata: t.origen,
              destino_iata: t.destino,
            })),
          ).join(' → ')
        : [str(q.origen_iata), str(q.destino_iata)]
            .filter(Boolean)
            .join(' → ') || null;

  // ---- Desglose canónico enriquecido ----
  const filasTuas = arr(tuas?.filas);
  const extrasSnap = arr(snap?.extras ?? q.extras);
  const modoComision =
    str(meta?.comision_vendedor_modo) ?? str(q.comision_vendedor_modo);
  const tarifaComision =
    num(meta?.comision_vendedor_tarifa_hr) ??
    num(q.comision_vendedor_tarifa_hr);
  const desgloseSnap = arr(snap?.desglose);
  let lineas: CotizacionInternaLineaPdf[];
  if (desgloseSnap.length > 0) {
    let idxTuas = 0;
    let idxExtra = 0;
    const filasUsadas = new Set<number>();
    lineas = desgloseSnap.map((d) => {
      const clave = str(d.clave) ?? '';
      const base: CotizacionInternaLineaPdf = {
        clave,
        concepto: str(d.concepto) ?? clave,
        monto_usd: num(d.monto_usd) ?? 0,
        exento: false,
      };
      if (clave === 'TIEMPO_VUELO') {
        if (tiempoCobrable != null && tarifaHora != null) {
          base.cantidad = tiempoCobrable;
          base.unitario = tarifaHora;
          base.moneda = 'USD';
        }
      } else if (clave === 'TUAS') {
        // Las líneas TUAS del desglose salen de `tuas.filas` en el mismo
        // orden; si no coinciden en número se cruza por IATA del concepto.
        let fila: Record<string, unknown> | undefined;
        const nTuas = desgloseSnap.filter((x) => x.clave === 'TUAS').length;
        if (filasTuas.length === nTuas) {
          fila = filasTuas[idxTuas];
        } else {
          const m = /^TUA\s+([A-Z0-9]{3,4})\b/i.exec(base.concepto);
          const iata = m ? m[1].toUpperCase() : null;
          const i = filasTuas.findIndex(
            (f, k) =>
              !filasUsadas.has(k) && str(f.iata)?.toUpperCase() === iata,
          );
          if (i >= 0) {
            filasUsadas.add(i);
            fila = filasTuas[i];
          }
        }
        idxTuas += 1;
        if (fila) {
          const pax = num(fila.pax);
          const unit = num(fila.monto_pax);
          if (pax != null && unit != null) {
            base.cantidad = pax;
            base.unitario = unit;
          }
          base.moneda = str(fila.moneda) ?? 'USD';
          const nativo = num(fila.total_nativo);
          if (nativo != null) base.monto_nativo = nativo;
          base.tc_aplicado = num(fila.tc_aplicado);
        }
      } else if (clave === 'EXTRA') {
        const nExtras = desgloseSnap.filter((x) => x.clave === 'EXTRA').length;
        // Las líneas EXTRA del desglose salen de `snapshot.extras` 1:1 y en
        // el mismo orden; con conteos distintos no se cruza (sin operación).
        const e =
          extrasSnap.length === nExtras ? extrasSnap[idxExtra] : undefined;
        idxExtra += 1;
        if (e) {
          const c = num(e.cantidad);
          const u = num(e.unitario);
          if (c != null && u != null) {
            base.cantidad = c;
            base.unitario = u;
          }
          base.moneda = str(e.moneda) ?? 'USD';
          const nativo = num(e.monto_nativo);
          if (nativo != null) base.monto_nativo = nativo;
          base.tc_aplicado = num(e.tc_aplicado);
          base.aplica_iva = e.aplica_iva !== false;
        }
      } else if (clave === 'COMISION_VENDEDOR') {
        if (
          modoComision === 'POR_HORA' &&
          tiempoCobrable != null &&
          tarifaComision != null
        ) {
          base.cantidad = tiempoCobrable;
          base.unitario = tarifaComision;
          base.moneda = 'USD';
        }
      }
      return base;
    });
  } else {
    // Cotización previa al motor v1.3 (sin snapshot): columnas espejo del
    // vuelo, una línea por componente distinto de cero — misma suma que
    // `particionIngresoVuelo` en su rama 'columnas'.
    const col = (
      clave: string,
      concepto: string,
      v: unknown,
    ): CotizacionInternaLineaPdf[] => {
      const n = num(v);
      return n != null && n !== 0
        ? [{ clave, concepto, monto_usd: round2(n), exento: false }]
        : [];
    };
    const tiempoLinea = col(
      'TIEMPO_VUELO',
      'Tiempo de vuelo',
      q.subtotal_vuelo_usd,
    );
    if (tiempoLinea[0] && tiempoCobrable != null && tarifaHora != null) {
      tiempoLinea[0].cantidad = tiempoCobrable;
      tiempoLinea[0].unitario = tarifaHora;
      tiempoLinea[0].moneda = 'USD';
    }
    lineas = [
      ...tiempoLinea,
      ...col('TUAS', 'TUAS', q.tuas_usd),
      ...col('EXTRA', 'Extras', q.extras_total_usd),
      ...col(
        'COMISION_VENDEDOR',
        `Comisión del vendedor${str(q.comision_vendedor_nombre) ? ` (${str(q.comision_vendedor_nombre)})` : ''}`,
        q.comision_vendedor_usd,
      ),
      ...col(
        'AJUSTE',
        (num(q.ajuste_final_usd) ?? 0) < 0 ? 'Descuento' : 'Redondeo',
        q.ajuste_final_usd,
      ),
      ...col('IVA', 'IVA', q.iva_usd),
      ...col(
        'PERNOCTA',
        'Viáticos por pernocta (sin IVA)',
        q.viaticos_pernocta_usd,
      ),
    ];
  }
  // TUAS EXENTOS: aeropuertos del itinerario cotizado sin fila cobrada.
  const iatasCobradas = new Set(
    filasTuas.map((f) => str(f.iata)?.toUpperCase()).filter(Boolean),
  );
  const tuasExentos: string[] = [];
  const razonExento = new Map<string, string | null>();
  const aeropuertosTuas: unknown[] = Array.isArray(tuas?.aeropuertos)
    ? tuas.aeropuertos
    : [];
  for (const a of aeropuertosTuas) {
    const iata =
      (typeof a === 'string' ? a : str(obj(a)?.iata))?.toUpperCase() ?? null;
    if (!iata || iatasCobradas.has(iata) || tuasExentos.includes(iata))
      continue;
    tuasExentos.push(iata);
    razonExento.set(iata, str(obj(a)?.razon));
  }
  if (tuasExentos.length > 0) {
    const paxVuelo = num(tuas?.pasajeros) ?? num(q.pasajeros);
    const sinteticas: CotizacionInternaLineaPdf[] = tuasExentos.map((iata) => ({
      clave: 'TUAS',
      concepto: `TUA ${iata} · exento${razonExento.get(iata) ? ` · ${razonExento.get(iata)}` : ''}`,
      monto_usd: 0,
      ...(paxVuelo != null ? { cantidad: paxVuelo, unitario: 0 } : {}),
      moneda: 'USD',
      exento: true,
    }));
    let pos = -1;
    lineas.forEach((l, i) => {
      if (l.clave === 'TUAS' || (pos < 0 && l.clave === 'TIEMPO_VUELO'))
        pos = i;
    });
    lineas.splice(pos + 1, 0, ...sinteticas);
  }

  // ---- Totales, IVA, partición ----
  const totalUsd = round2(
    num(q.monto_total_usd) ?? num(totales?.total_usd) ?? 0,
  );
  const ivaUsd = round2(num(ivaSnap?.monto_usd) ?? num(q.iva_usd) ?? 0);
  const ivaPctRaw = num(ivaSnap?.porcentaje) ?? num(q.iva_pct) ?? 0;
  const ivaPct = ivaPctRaw <= 1 ? round2(ivaPctRaw * 100) : round2(ivaPctRaw);
  const particion = particionIngresoVuelo(q);
  // CANCELADO / partición inconsistente: sin provisión al vendedor (misma
  // regla que findById, el reporte por vuelo y Otros movimientos).
  const pagoVendedor =
    cancelado || particion.inconsistente ? 0 : pagoVendedorUsd(particion);
  const comisionVendedor = particion.comision_vendedor_usd;
  const pagoVendedorOut =
    pagoVendedor > 0 ? pagoVendedor : comisionVendedor > 0 ? 0 : null;

  // ---- Participación multi-avión (fuente única) ----
  let participacionAviones: ReporteVueloParticipacionPayload[] = [];
  if (!esExterno) {
    const escalasPart: EscalaParticipacionInput[] = escalasOrdenadas;
    const p = participacionPorAeronave(
      { aeronave_id: aeronaveId, calculo_snapshot: q.calculo_snapshot },
      escalasPart,
    );
    if (p.multi_avion && particion.total_usd > 0) {
      const partes = repartirUsd(particion.avion_usd, p);
      const ids = [...p.factores.keys()].sort((a, b) =>
        a === p.principal ? -1 : b === p.principal ? 1 : 0,
      );
      participacionAviones = ids.map((id) => ({
        aeronave_id: id,
        matricula: aeronavePorId.get(id)?.matricula ?? '?',
        factor: p.factores.get(id) ?? 0,
        tramos: p.tramos_por_avion.get(id) ?? 0,
        venta_usd: partes.get(id) ?? 0,
      }));
    }
  }

  // ---- Cobros ----
  const cobrosOrdenados = [...cobros].sort((a, b) => {
    const fa = `${str(a.fecha_cobro) ?? ''}|${str(a.created_at) ?? ''}`;
    const fb = `${str(b.fecha_cobro) ?? ''}|${str(b.created_at) ?? ''}`;
    return fa.localeCompare(fb);
  });
  const cobrosOut: CotizacionInternaCobroPdf[] = cobrosOrdenados.map((c) => {
    const monto = num(c.monto) ?? 0;
    const comision = num(c.comision_banco_monto);
    const conv = cobrosEnUsd([c], tcVuelo);
    const metodo = str(c.metodo_cobro) ?? 'OTRO';
    const sobre = c.cobro_grupo ?? null;
    return {
      fecha: str(c.fecha_cobro),
      metodo,
      metodo_label: METODO_LABEL[metodo] ?? metodo,
      monto,
      moneda: str(c.moneda) ?? 'USD',
      tc: num(c.tc_usd_mxn),
      monto_usd: conv.sin_tc_count > 0 ? null : conv.total_usd,
      comision_pct: num(c.comision_banco_pct),
      comision_monto: comision != null && comision > 0 ? comision : null,
      neto: comision != null && comision > 0 ? round2(monto - comision) : monto,
      referencia: str(c.referencia),
      cuenta_destino: str(c.cuenta_destino),
      notas: str(c.notas),
      conciliado: c.conciliado === true,
      es_reembolso: monto < 0,
      sobre_grupo_folio:
        sobre && sobre.grupo_folio != null ? `G-${sobre.grupo_folio}` : null,
      sobre_grupo_monto_total: sobre ? (num(sobre.monto_total) ?? null) : null,
      sobre_grupo_moneda: sobre ? (str(sobre.moneda) ?? null) : null,
      grupo_factor: num(c.grupo_factor),
      registrado_por: nombreDe(c.registrado_por),
    };
  });
  const conv = cobrosEnUsd(cobros, tcVuelo);
  const totalCobrado = conv.total_usd;
  // Comisiones bancarias a USD con la MISMA regla (pseudo-cobros).
  const comisionesConv = cobrosEnUsd(
    cobros
      .filter((c) => (num(c.comision_banco_monto) ?? 0) > 0)
      .map((c) => ({
        monto: c.comision_banco_monto,
        moneda: c.moneda,
        tc_usd_mxn: c.tc_usd_mxn,
      })),
    tcVuelo,
  );
  const comisionBancoUsd = comisionesConv.total_usd;
  const semaforo = estadoCobroSemaforo({
    montoTotalUsd: totalUsd,
    cobrado: q.cobrado === true,
    totalCobradoUsd: totalCobrado,
    sinTcCount: conv.sin_tc_count,
    cotizacionAbierta: q.cotizacion_abierta === true,
    enCotizacion: estado === 'SOLICITUD' || estado === 'COTIZADO',
    cancelado,
    esInterno,
  });

  // ---- Gastos (USD directo; MXN ÷ tc_gasto; respaldo TC del vuelo; si no, sin TC) ----
  const porCategoria = new Map<string, { total: number; n: number }>();
  let gastosSinTcCount = 0;
  let gastosSinTcMxn = 0;
  let hayGastos = false;
  for (const g of gastos) {
    const cat = str(g.categoria) ?? 'OTRO';
    if (CATEGORIAS_FUERA.has(cat)) continue;
    hayGastos = true;
    const monto = num(g.monto) ?? 0;
    let usd: number | null;
    if (g.moneda === 'USD') usd = monto;
    else {
      const tc = num(g.tc_gasto);
      const tcOk =
        tc != null && tc > 0
          ? tc
          : tcVuelo != null && tcVuelo > 0
            ? tcVuelo
            : null;
      usd = tcOk ? monto / tcOk : null;
    }
    if (usd == null) {
      gastosSinTcCount += 1;
      gastosSinTcMxn += monto;
      continue;
    }
    const acc = porCategoria.get(cat) ?? { total: 0, n: 0 };
    acc.total += usd;
    acc.n += 1;
    porCategoria.set(cat, acc);
  }
  const gastosPorCategoria: CotizacionInternaGastoCategoriaPdf[] = [
    ...porCategoria.entries(),
  ]
    .map(([categoria, v]) => ({
      categoria,
      etiqueta: etiquetaCategoriaGasto(categoria),
      total_usd: round2(v.total),
      n: v.n,
    }))
    .sort((a, b) => b.total_usd - a.total_usd);
  const costoExterno = esExterno ? num(q.costo_externo_usd) : null;
  const gastosSuma = gastosPorCategoria.reduce(
    (acc, g) => acc + g.total_usd,
    0,
  );
  const gastosTotal =
    hayGastos || (costoExterno != null && costoExterno > 0)
      ? round2(gastosSuma + (costoExterno ?? 0))
      : null;
  const utilidadBase: 'cobrado' | 'total' =
    totalCobrado > 0 ? 'cobrado' : 'total';
  const utilidadBruta =
    gastosTotal != null
      ? round2(
          (utilidadBase === 'cobrado' ? totalCobrado : totalUsd) - gastosTotal,
        )
      : null;

  // ---- Facturación ----
  const facturasOut: CotizacionInternaFacturaPdf[] = facturas.map((f) => ({
    serie: str(f.serie),
    folio: f.folio == null ? null : String(f.folio),
    uuid_fiscal: str(f.uuid_fiscal),
    estado: str(f.estado),
    total: num(f.total),
    moneda: str(f.moneda),
    fecha_timbrado: str(f.fecha_timbrado),
    facturado_a_nombre: str(f.facturado_a_nombre),
    cancelada: f.cancelada_at != null,
  }));
  const vigentes = facturasOut.filter((f) => !f.cancelada);
  const cfdi =
    vigentes[vigentes.length - 1] ??
    facturasOut[facturasOut.length - 1] ??
    null;
  const cfdiFolio = cfdi
    ? [cfdi.serie, cfdi.folio].filter(Boolean).join('-') || cfdi.uuid_fiscal
    : null;
  const cfdiEstatus = cfdi
    ? cfdi.cancelada
      ? 'CANCELADA'
      : (cfdi.estado ?? 'TIMBRADA')
    : q.facturado === true
      ? 'Facturado (bandera del vuelo, sin CFDI ligado)'
      : null;

  // ---- Cabecera ----
  const operativaRaw = obj(q.aeronave_operativa);
  const operativaId = str(operativaRaw?.id) ?? aeronaveId;
  const fichaOperativa: FichaAvionInterna | null = esExterno
    ? null
    : operativaRaw
      ? {
          matricula: str(operativaRaw.matricula),
          modelo: str(operativaRaw.modelo),
        }
      : operativaId
        ? (aeronavePorId.get(operativaId) ?? null)
        : null;
  const operativaDifiere =
    fichaOperativa != null &&
    (cotizadaId == null || operativaId == null
      ? fichaOperativa.matricula !== fichaCotizada?.matricula
      : cotizadaId !== operativaId);
  const grupo = rel(q.grupo);
  const metaGrupo = obj(meta?.grupo);
  const combinado = rel(q.combinado);
  const metodoCobro = str(q.metodo_cobro);
  const tarifaTipo = str(tarifa?.tipo) ?? str(q.tarifa_tipo);

  return {
    folio: folioTexto(q.folio) ?? '',
    version: num(q.cotizacion_version),
    estado,
    estado_label: ESTADO_LABEL[estado] ?? estado,
    tipo: str(q.tipo),
    cliente: str(cliente?.nombre) ?? 'Cliente',
    razon_social: str(cliente?.razon_social_default),
    cliente_rfc: str(cliente?.rfc),
    es_broker: cliente?.es_broker === true,
    fecha: str(q.fecha_solicitud) ?? str(q.created_at),
    fecha_confirmacion: str(q.fecha_confirmacion),
    tarifa_tipo: tarifaTipo,
    tarifa_tipo_label: tarifaTipo
      ? (TARIFA_LABEL[tarifaTipo] ?? tarifaTipo)
      : null,
    tarifa_hora_usd: tarifaHora,
    tarifa_override: tarifa?.proviene_de_override === true,
    tarifa_preferencial: tarifa?.preferencial_cliente === true,
    metodo_cobro: metodoCobro,
    metodo_cobro_detalle: str(q.metodo_cobro_detalle),
    metodo_cobro_label: metodoCobro
      ? metodoCobro === 'OTRO' && str(q.metodo_cobro_detalle)
        ? `Otro · ${str(q.metodo_cobro_detalle)}`
        : (METODO_LABEL[metodoCobro] ?? metodoCobro)
      : null,
    tc_usd_mxn: tcVuelo,
    vendedor:
      str(meta?.comision_vendedor_nombre) ?? str(q.comision_vendedor_nombre),
    cotizado_por: nombreDe(creadoPorId),
    aeronave_cotizada_modelo: fichaCotizada?.modelo ?? null,
    aeronave_cotizada_matricula: fichaCotizada?.matricula ?? null,
    aeronave_operativa: operativaDifiere ? fichaTexto(fichaOperativa) : null,
    avion_externo: esExterno
      ? fichaTexto({
          modelo: str(q.avion_externo_modelo),
          matricula: str(q.avion_externo_matricula),
        })
      : null,
    operador_externo: esExterno ? str(q.operador_externo) : null,
    piloto: nombreDe(q.piloto_id),
    copiloto: nombreDe(q.copiloto_id),
    apoyos: apoyosNivelVuelo(apoyos)
      .map((id) => nombreDe(id))
      .filter((x): x is string => !!x),
    fecha_traslado_inicial: str(q.fecha_vuelo),
    fecha_traslado_final: str(q.fecha_traslado_final) ?? str(q.fecha_fin),
    pasajeros: num(q.pasajeros) ?? 0,
    ruta,
    itinerario_operativo: q.itinerario_operativo === true,
    cotizacion_abierta: q.cotizacion_abierta === true,
    es_interno: esInterno,
    es_externo: esExterno,
    grupo_folio: folioTexto(grupo?.folio)
      ? `G-${folioTexto(grupo?.folio)}`
      : null,
    grupo_posicion: num(q.grupo_posicion),
    grupo_total_aviones: num(metaGrupo?.total_aviones),
    combinado_con_folio: folioTexto(combinado?.folio),

    tramos,
    horas_cotizadas_hr: horasCotizadas,
    vuelo_hr: vueloHr,
    calzos_hr: calzosHr,
    sobrevuelo_hr: sobrevueloHr,
    horas_voladas_hr: horasVoladas,
    delta_horas_hr: deltaHoras,
    tiempo_cobrable_hr: tiempoCobrable,
    hora_minima_aplicada: tiempos?.minimo_hora_aplicado === true,
    cobrable_override: tiempos?.cobrable_proviene_de_override === true,

    lineas,
    tuas_exentos: tuasExentos,
    subtotal_vuelo_usd: round2(
      num(totales?.subtotal_vuelo_usd) ?? num(q.subtotal_vuelo_usd) ?? 0,
    ),
    tuas_usd: round2(num(totales?.tuas_total_usd) ?? num(q.tuas_usd) ?? 0),
    extras_total_usd: round2(
      num(totales?.extras_total_usd) ?? num(q.extras_total_usd) ?? 0,
    ),
    viaticos_pernocta_usd: round2(
      num(totales?.viaticos_pernocta_usd) ?? num(q.viaticos_pernocta_usd) ?? 0,
    ),
    comision_vendedor_usd: comisionVendedor,
    comision_vendedor_nombre:
      str(meta?.comision_vendedor_nombre) ?? str(q.comision_vendedor_nombre),
    comision_vendedor_modo: comisionVendedor > 0 ? modoComision : null,
    comision_vendedor_tarifa_hr:
      comisionVendedor > 0 && modoComision === 'POR_HORA'
        ? tarifaComision
        : null,
    iva_comision_vendedor_usd:
      pagoVendedor > 0 ? ivaComisionVendedorUsd(particion) : 0,
    pago_vendedor_usd: pagoVendedorOut,
    neto_vuelatour_usd:
      pagoVendedor > 0 ? round2(particion.total_usd - pagoVendedor) : null,
    ajuste_final_usd: round2(
      num(totales?.ajuste_final_usd) ?? num(q.ajuste_final_usd) ?? 0,
    ),
    descuento_usd: num(meta?.descuento_usd),
    redondeo_auto_usd: num(meta?.redondeo_auto_usd),
    total_pactado_usd: num(meta?.total_pactado_usd),
    comision_billpocket_pct: num(meta?.comision_billpocket_pct),
    subtotal_usd: round2(totalUsd - ivaUsd),
    iva_pct: ivaPct,
    iva_base_usd: num(ivaSnap?.base_usd),
    iva_usd: ivaUsd,
    iva_nota: str(ivaSnap?.nota),
    total_usd: totalUsd,
    total_mxn: num(q.monto_total_mxn) ?? num(totales?.total_mxn),
    mxn_nativos: num(totales?.mxn_nativos),
    version_motor: str(meta?.version_motor),
    calculado_at: str(meta?.calculado_at),
    venta_avion_usd: particion.total_usd > 0 ? particion.avion_usd : null,
    otros_ingresos_vuelatour_usd:
      particion.total_usd > 0 ? particion.vuelatour_usd : null,
    iva_avion_usd: particion.total_usd > 0 ? particion.iva_avion_usd : null,
    iva_vuelatour_usd:
      particion.total_usd > 0 ? particion.iva_vuelatour_usd : null,
    particion_fuente: particion.fuente,
    particion_inconsistente: particion.inconsistente,
    participacion_aviones: participacionAviones,

    cobros: cobrosOut,
    total_cobrado_usd: totalCobrado,
    cobros_sin_tc_count: conv.sin_tc_count,
    cobros_sin_tc_mxn: conv.sin_tc_mxn,
    comision_banco_usd: comisionBancoUsd,
    total_cobrado_neto_usd:
      comisionBancoUsd > 0 ? round2(totalCobrado - comisionBancoUsd) : null,
    saldo_usd: round2(totalUsd - totalCobrado),
    cobrado_flag: q.cobrado === true,
    semaforo_cobro: semaforo.color,
    semaforo_cobro_key: semaforo.key,
    semaforo_cobro_label: semaforo.label,

    gastos_por_categoria: gastosPorCategoria,
    gastos_total_usd: gastosTotal,
    gastos_sin_tc_count: gastosSinTcCount,
    gastos_sin_tc_mxn: round2(gastosSinTcMxn),
    costo_externo_usd: costoExterno,
    utilidad_bruta_usd: utilidadBruta,
    utilidad_base: utilidadBase,

    notas_cliente: str(q.notas),
    notas_internas: str(q.notas_internas),
    facturado: q.facturado === true,
    facturas: facturasOut,
    cfdi_estatus: cfdiEstatus,
    cfdi_folio: cfdiFolio,

    generado: ahora.toISOString(),
    generado_cancun: fechaHoraCancun(ahora),
    generado_por: generadoPor,
  };
}
