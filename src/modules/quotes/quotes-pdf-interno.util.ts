/**
 * ARMADOR PURO del payload del PDF «Cotización interna» v2 (8-sep-2026,
 * feedback de administración con la foto de su formato de siempre).
 *
 * Documento de UNA hoja para la oficina con SOLO lo de la COTIZACIÓN:
 * fecha protagonista = día del vuelo; tabla de tramos desglosados (RUTA con
 * nombre de ciudad, FECHA del tramo, MILLAS, TIEMPO DE VUELO con calzos,
 * COSTO POR HORA, TOTAL POR TRAMO + fila TOTAL); desglose canónico; TUAS
 * solo las COBRADAS; cobros compactos; notas internas. NADA de operación
 * (tacos, horas voladas, avión operativo, piloto del tramo, traslados) ni de
 * partición / gastos / utilidad / CFDI — eso vive en el reporte del vuelo.
 * JAMÁS se manda al cliente.
 *
 * Disciplina de números (regla del workspace: fuentes únicas, nada de
 * cálculos paralelos):
 *  - Desglose = `calculo_snapshot.desglose` canónico v1.3 tal cual (orden y
 *    montos intactos; Σ == total). Aquí solo se ENRIQUECE cada línea con la
 *    operación que la produjo (cantidad × unitario) leída del mismo snapshot.
 *  - Tramos = `snapshot.tramos[]` (ruta comercial congelada; `tiempo_hr` YA
 *    incluye el calzo de 0.15 h del tramo). El ÚNICO número nuevo es
 *    `total_usd = round2(tiempo_hr × tarifa)` por tramo. La diferencia contra
 *    la línea TIEMPO_VUELO canónica NO se esconde ni se reparte: viaja como
 *    `tramos_ajuste_usd` con su motivo (hora mínima / sobrevuelo / horas
 *    pactadas / redondeo) para que Σ tramos + ajuste == servicio aéreo y el
 *    desglose siga intacto (invariante 3 del repo).
 *  - TUAS cobradas = `snapshot.tuas.filas` (el motor ya excluye exentas/$0).
 *  - Cobrado = `cobrosEnUsd`; pago al vendedor = `pagoVendedorUsd`
 *    (`particionIngresoVuelo` se usa SOLO para eso); conciliado = lo que ya
 *    trae `FlightsService.listCobros` (fuente única cobro-conciliado.util);
 *    semáforo = espejo del panel (`semaforo-cobro.util`).
 *  - Neto de un cobro = `monto − comision_banco_monto` (regla
 *    comision-bancaria.util: el neto nunca se persiste).
 *  - Fechas de pared en día Cancún (`diaCancun`, YYYY-MM-DD): pyservices
 *    trata esas cadenas como pared y no las reconvierte.
 *
 * Sin BD ni Nest: `QuotesPdfInternoService` carga los insumos y llama a
 * `armarCotizacionInternaPayload`; los specs lo prueban con snapshots
 * simulados.
 */
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import { diaCancun, fechaHoraCancun } from '../../common/fecha-cancun.util';
import { METODO_COBRO_LABELS } from '../../common/metodo-cobro.util';
import {
  ivaComisionVendedorUsd,
  pagoVendedorUsd,
  particionIngresoVuelo,
} from '../../common/ingreso-vuelo.util';
import { puntosRutaVisible } from '../../common/ruta-visible.util';
import { estadoCobroSemaforo } from '../../common/semaforo-cobro.util';
import {
  apoyosNivelVuelo,
  type VueloApoyoRow,
} from '../../common/tripulacion.util';
import type {
  CotizacionInternaCobroPdf,
  CotizacionInternaLineaPdf,
  CotizacionInternaPdfRequest,
  CotizacionInternaTramoCotizadoPdf,
  CotizacionInternaTuaCobradaPdf,
} from '../pyservices/pyservices.service';

// ===== Insumos (lo que carga el servicio) =====

/** Fila de `vuelo` como la devuelve `QuotesService.findById` (VUELO_COLS + extras). */
export type QuoteInternaRow = Record<string, unknown>;

/**
 * Escala del vuelo (query mínima del servicio, orden asc): SOLO se usa para
 * fechar cada tramo cotizado (`fecha_salida_plan` / `pdf_fecha`) cruzando
 * por orden y par origen/destino, y como respaldo de ruta cuando el
 * snapshot no trae tramos. Nada operativo (tacos, tripulación) entra aquí.
 */
export interface EscalaInternaRow {
  id?: string | null;
  orden: number | string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  /** Instante operativo (timestamptz) → se pinta como día Cancún. */
  fecha_salida_plan?: string | null;
  /** Fecha de PARED capturada a mano solo para PDF (date YYYY-MM-DD). */
  pdf_fecha?: string | null;
  solo_operativa?: boolean | null;
  cancelada_at?: string | null;
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

export interface ClienteInternoRow {
  nombre?: string | null;
  razon_social_default?: string | null;
  rfc?: string | null;
  es_broker?: boolean | null;
}

/** Fila del catálogo `aeropuerto` (`iata, nombre, ciudad`). */
export interface AeropuertoInternoRow {
  iata?: string | null;
  nombre?: string | null;
  ciudad?: string | null;
}

export interface CotizacionInternaInsumos {
  quote: QuoteInternaRow;
  escalas: EscalaInternaRow[];
  cobros: CobroInternoRow[];
  cliente: ClienteInternoRow | null;
  /** usuario.id → nombre (piloto, copiloto, apoyos, created_by, registrado_por). */
  nombrePorId: ReadonlyMap<string, string>;
  /** IATA (mayúsculas) → ficha del catálogo, para el nombre de ciudad de la tabla. */
  aeropuertoPorIata: ReadonlyMap<string, AeropuertoInternoRow>;
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

/** Mismo mapa que el recibo de cobro y el panel admin (fuente única). */
const METODO_LABEL = METODO_COBRO_LABELS;

const TARIFA_LABEL: Record<string, string> = {
  PUBLICO: 'Público',
  BROKER: 'Broker',
};

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

/** Día Cancún YYYY-MM-DD de un ISO/date; null si viene vacío o inválido (nunca lanza). */
function diaSeguro(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    return diaCancun(s);
  } catch {
    return null;
  }
}

/** Etiqueta "Modelo · Matrícula" (lo que haya). */
function fichaTexto(f: {
  modelo: string | null;
  matricula: string | null;
}): string | null {
  const t = [str(f.modelo), str(f.matricula)].filter(Boolean).join(' · ');
  return t || null;
}

/** Horas decimales → "hh:mm" (1.3 → "01:18", 0.4 → "00:24"); nunca negativo. */
export function horasAHhmm(h: number): string {
  const m = Math.max(0, Math.round(h * 60));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Horas para texto: hasta 2 decimales sin ceros de relleno ("0.5", "2", "1.25"). */
function horasTexto(h: number): string {
  return String(Number(h.toFixed(2)));
}

/**
 * Nombre CORTO de un aeropuerto para la tabla de tramos ("Cancun", "Merida"
 * como en el formato de administración): `ciudad` del catálogo recortada al
 * primer segmento antes de la coma ("Tuxtla Gutierrez, Chiapas, MX" →
 * "Tuxtla Gutierrez"), sin espacios sobrantes y con inicial mayúscula
 * ("cozumel" → "Cozumel"); sin ciudad cae al `nombre` con la misma regla;
 * sin ninguno, el IATA.
 */
export function nombreCortoAeropuerto(
  iata: string,
  ficha: AeropuertoInternoRow | null | undefined,
): string {
  const primero = (v: unknown): string =>
    typeof v === 'string' ? (v.split(',')[0] ?? '').trim() : '';
  const base = primero(ficha?.ciudad) || primero(ficha?.nombre);
  if (!base) return iata;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// ===== Armador =====

export function armarCotizacionInternaPayload(
  insumos: CotizacionInternaInsumos,
): CotizacionInternaPdfRequest {
  const {
    quote: q,
    escalas,
    cobros,
    cliente,
    nombrePorId,
    aeropuertoPorIata,
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
  const rutaSnap = obj(snap?.ruta);
  const ivaSnap = obj(snap?.iva);
  const totales = obj(snap?.totales);
  const meta = obj(snap?.meta);
  const tramosSnap = arr(snap?.tramos);
  const estado = str(q.estado) ?? '';
  const cancelado = estado === 'CANCELADO';
  const esExterno = q.es_externo === true;
  const esInterno = meta?.cliente_interno === true;
  const tcVuelo = num(q.tc_usd_mxn);

  // ---- Horas (snapshot.tiempos) ----
  const tiempoCobrable =
    num(tiempos?.cobrable_hr) ?? num(q.tiempo_cobrable_hr) ?? null;
  const tarifaHora = num(tarifa?.usd_por_hora) ?? num(q.tarifa_hora_usd);
  const vueloHr = num(tiempos?.vuelo_hr);
  const calzosHr = num(tiempos?.calzos_hr);
  const sobrevueloHr = num(tiempos?.sobrevuelo_hr);
  const horaMinima = tiempos?.minimo_hora_aplicado === true;
  const cobrableOverride = tiempos?.cobrable_proviene_de_override === true;
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

  // ---- Avión cotizado (snapshot); sin snapshot cae al avión del vuelo ----
  const cotizada = obj(q.aeronave_cotizada);
  const snapAeronave = obj(snap?.aeronave);
  const operativaRaw = obj(q.aeronave_operativa);
  const fichaCotizada = cotizada
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
        : operativaRaw
          ? {
              matricula: str(operativaRaw.matricula),
              modelo: str(operativaRaw.modelo),
            }
          : null;

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
        ? [{ clave, concepto, monto_usd: round2(n) }]
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
  // Servicio aéreo canónico (línea TIEMPO_VUELO): el ancla contra la que se
  // concilia la tabla de tramos.
  const montoTiempoVuelo = round2(
    lineas.find((l) => l.clave === 'TIEMPO_VUELO')?.monto_usd ??
      num(totales?.subtotal_vuelo_usd) ??
      num(q.subtotal_vuelo_usd) ??
      0,
  );

  // ---- TUAS cobradas (solo las que se cobraron; las exentas no viajan) ----
  const tuasCobradas: CotizacionInternaTuaCobradaPdf[] = filasTuas
    .filter(
      (f) => (num(f.total_usd) ?? 0) > 0 || (num(f.total_nativo) ?? 0) > 0,
    )
    .map((f) => ({
      iata: (str(f.iata) ?? '').toUpperCase(),
      pax: num(f.pax) ?? 0,
      unitario: num(f.monto_pax) ?? 0,
      moneda: str(f.moneda) ?? 'USD',
      total_nativo: num(f.total_nativo) ?? num(f.total_usd) ?? 0,
      tc_aplicado: num(f.tc_aplicado),
      total_usd: round2(num(f.total_usd) ?? 0),
    }));

  // ---- Tramos cotizados (snapshot.tramos; fechas desde las escalas) ----
  const fechaVuelo = diaSeguro(q.fecha_vuelo);
  const fechaFin = diaSeguro(q.fecha_fin);
  const escalasOrdenadas = [...escalas].sort(
    (a, b) => (num(a.orden) ?? 0) - (num(b.orden) ?? 0),
  );
  const nombreDeIata = (iata: string): string =>
    nombreCortoAeropuerto(iata, aeropuertoPorIata.get(iata.toUpperCase()));
  // Cruce snapshot ↔ escala por orden Y mismo par origen/destino: con
  // itinerario operativo (ferries intercalados, otra base) el orden no
  // identifica el mismo tramo y se fecharía con un tramo ajeno.
  const escalaDeTramo = (
    orden: number,
    o: string,
    d: string,
  ): EscalaInternaRow | undefined =>
    escalasOrdenadas.find(
      (e) =>
        num(e.orden) === orden &&
        (str(e.origen_iata) ?? '').toUpperCase() === o &&
        (str(e.destino_iata) ?? '').toUpperCase() === d,
    );
  let tramosCot: CotizacionInternaTramoCotizadoPdf[];
  let puntosRuta: string[];
  if (tramosSnap.length > 0) {
    let ultimaFecha: string | null = null;
    tramosCot = tramosSnap.map((t, idx) => {
      const orden = num(t.orden) ?? idx + 1;
      const o = (str(t.origen) ?? '').toUpperCase();
      const d = (str(t.destino) ?? '').toUpperCase();
      const esc = escalaDeTramo(orden, o, d);
      // Día del tramo: plan de la escala → fecha de pared del PDF → el día
      // del tramo anterior (intermedios del mismo día) → día del vuelo.
      const fecha =
        diaSeguro(esc?.fecha_salida_plan) ??
        diaSeguro(esc?.pdf_fecha) ??
        ultimaFecha ??
        fechaVuelo;
      ultimaFecha = fecha;
      const tiempoHr = round4(num(t.tiempo_hr) ?? 0);
      // Tarifa por tramo solo si el snapshot algún día la trae (multi-avión
      // en el precio sigue pendiente): hoy es la ÚNICA del vuelo.
      const tarifaTramo = num(t.tarifa_usd_hr) ?? tarifaHora;
      const totalSnap = num(t.total_usd) ?? num(t.costo_usd);
      const total =
        totalSnap != null
          ? round2(totalSnap)
          : tarifaTramo != null
            ? round2(tiempoHr * tarifaTramo)
            : 0;
      const esFerry = t.es_ferry === true;
      const origenNombre = nombreDeIata(o);
      const destinoNombre = nombreDeIata(d);
      return {
        orden: idx + 1,
        ruta: `${origenNombre}-${destinoNombre}`,
        origen_iata: o,
        destino_iata: d,
        origen_nombre: origenNombre,
        destino_nombre: destinoNombre,
        fecha,
        millas: num(t.millas),
        tiempo_hr: tiempoHr,
        tiempo_hhmm: horasAHhmm(tiempoHr),
        tarifa_hora_usd: tarifaTramo,
        total_usd: total,
        pax: esFerry ? 0 : num(t.pasajeros),
        es_ferry: esFerry,
        pernocta: t.requiere_pernocta === true,
        pernocta_usd: num(t.pernocta_usd) ?? 0,
        tuas_usd: num(t.tuas_usd) ?? 0,
        consolidado: false,
      };
    });
    puntosRuta = puntosRutaVisible(
      tramosCot.map((t) => ({
        origen_iata: t.origen_iata,
        destino_iata: t.destino_iata,
      })),
    );
  } else {
    // RESPALDO: snapshot anterior al desglose por tramo o cotización sin
    // snapshot (motor viejo). UNA fila consolidada con los totales que el
    // snapshot/vuelo YA traen — jamás se re-deriva el motor por tramo.
    const vivas = escalasOrdenadas.filter(
      (e) => e.cancelada_at == null && e.solo_operativa !== true,
    );
    puntosRuta =
      vivas.length > 0
        ? puntosRutaVisible(vivas)
        : ([str(q.origen_iata), str(q.destino_iata)].filter(
            Boolean,
          ) as string[]);
    if (
      vivas.length === 0 &&
      (rutaSnap?.es_redondo_auto === true || q.es_redondo_auto === true) &&
      puntosRuta.length === 2
    ) {
      puntosRuta = [...puntosRuta, puntosRuta[0]];
    }
    const tiempoHr =
      vueloHr != null
        ? round4(vueloHr + (calzosHr ?? 0))
        : round4(tiempoCobrable ?? 0);
    const millasOneWay = num(q.millas_nauticas_one_way);
    const millas =
      num(rutaSnap?.millas_nauticas_totales) ??
      (millasOneWay != null
        ? round2(millasOneWay * (q.es_redondo_auto === true ? 2 : 1))
        : null);
    // Con snapshot (tiempos reales) el total se arma como en la tabla; sin
    // snapshot no hay tiempos por tramo: el servicio aéreo del vuelo tal cual.
    const total = snap
      ? tarifaHora != null
        ? round2(tiempoHr * tarifaHora)
        : 0
      : montoTiempoVuelo;
    const o = puntosRuta[0] ?? '';
    const d = puntosRuta[puntosRuta.length - 1] ?? '';
    const nombres = puntosRuta.map((p) => nombreDeIata(p));
    tramosCot =
      puntosRuta.length > 0
        ? [
            {
              orden: 1,
              ruta: nombres.join('-'),
              origen_iata: o,
              destino_iata: d,
              origen_nombre: nombres[0] ?? o,
              destino_nombre: nombres[nombres.length - 1] ?? d,
              fecha:
                diaSeguro(vivas[0]?.fecha_salida_plan) ??
                diaSeguro(vivas[0]?.pdf_fecha) ??
                fechaVuelo,
              millas,
              tiempo_hr: tiempoHr,
              tiempo_hhmm: horasAHhmm(tiempoHr),
              tarifa_hora_usd: tarifaHora,
              total_usd: total,
              pax: num(q.pasajeros),
              es_ferry: false,
              pernocta: false,
              pernocta_usd: 0,
              tuas_usd: 0,
              consolidado: true,
            },
          ]
        : [];
  }
  const tramosTiempoTotal = round4(
    tramosCot.reduce((acc, t) => acc + t.tiempo_hr, 0),
  );
  const tramosTotal = round2(
    tramosCot.reduce((acc, t) => acc + t.total_usd, 0),
  );
  // Ajuste = servicio aéreo canónico − Σ tramos. Se EXPONE con su motivo,
  // nunca se reparte entre tramos ni se toca el desglose.
  const tramosAjuste = round2(montoTiempoVuelo - tramosTotal);
  let tramosAjusteMotivo: string | null = null;
  if (Math.abs(tramosAjuste) >= 0.005) {
    const partes: string[] = [];
    if (cobrableOverride && tiempoCobrable != null) {
      partes.push(`Horas pactadas ${horasTexto(tiempoCobrable)} h`);
    } else {
      if (sobrevueloHr != null && sobrevueloHr > 0) {
        partes.push(`Sobrevuelo ${horasTexto(sobrevueloHr)} h`);
      }
      if (horaMinima) partes.push('Hora mínima 1.0 h');
    }
    tramosAjusteMotivo =
      partes.length > 0
        ? partes.join(' · ')
        : tarifaHora == null
          ? 'Tarifa no disponible'
          : 'Redondeo';
  }
  const ruta = puntosRuta.length > 0 ? puntosRuta.join(' → ') : null;

  // ---- Totales, IVA, pago al vendedor ----
  const totalUsd = round2(
    num(q.monto_total_usd) ?? num(totales?.total_usd) ?? 0,
  );
  const ivaUsd = round2(num(ivaSnap?.monto_usd) ?? num(q.iva_usd) ?? 0);
  const ivaPctRaw = num(ivaSnap?.porcentaje) ?? num(q.iva_pct) ?? 0;
  const ivaPct = ivaPctRaw <= 1 ? round2(ivaPctRaw * 100) : round2(ivaPctRaw);
  // particionIngresoVuelo SOLO para el pago al vendedor (fuente única
  // pagoVendedorUsd); la partición completa no viaja en este documento.
  const particion = particionIngresoVuelo(q);
  // CANCELADO / partición inconsistente: sin provisión al vendedor (misma
  // regla que findById, el reporte por vuelo y Otros movimientos).
  const pagoVendedor =
    cancelado || particion.inconsistente ? 0 : pagoVendedorUsd(particion);
  const comisionVendedor = particion.comision_vendedor_usd;
  const pagoVendedorOut =
    pagoVendedor > 0 ? pagoVendedor : comisionVendedor > 0 ? 0 : null;

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

  // ---- Cabecera ----
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
    fecha_vuelo: fechaVuelo,
    fecha_vuelo_fin:
      fechaFin != null && fechaFin !== fechaVuelo ? fechaFin : null,
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

    tramos_cotizados: tramosCot,
    tramos_tiempo_total_hr: tramosTiempoTotal,
    tramos_tiempo_total_hhmm: horasAHhmm(tramosTiempoTotal),
    tramos_total_usd: tramosTotal,
    tramos_ajuste_usd: tramosAjuste,
    tramos_ajuste_motivo: tramosAjusteMotivo,
    horas_cotizadas_hr: horasCotizadas,
    vuelo_hr: vueloHr,
    calzos_hr: calzosHr,
    sobrevuelo_hr: sobrevueloHr,
    tiempo_cobrable_hr: tiempoCobrable,
    hora_minima_aplicada: horaMinima,
    cobrable_override: cobrableOverride,

    lineas,
    tuas_cobradas: tuasCobradas,
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

    notas_cliente: str(q.notas),
    notas_internas: str(q.notas_internas),

    generado: ahora.toISOString(),
    generado_cancun: fechaHoraCancun(ahora),
    generado_por: generadoPor,
  };
}
