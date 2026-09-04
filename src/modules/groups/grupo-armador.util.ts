/**
 * Cotización de GRUPO — helpers PUROS del armador (4-sep-2026, Enfoque A).
 *
 * Principio rector: LA CABECERA (`vuelo_grupo`) NO TIENE DINERO. Cada peso
 * vive en exactamente UN vuelo hijo (uno por avión); aquí solo se decide
 * CÓMO se reparten las definiciones del grupo entre los hijos y cómo se
 * LEE el total sumando sus desgloses canónicos. Nada de esto toca el motor
 * v1.3 (`QuotesService.calculate`): cada hijo se cotiza con su avión.
 *
 * Reglas de dinero (injertos de los jueces):
 * - Toda partición del grupo (ajuste, extras PROPORCIONAL) usa `repartirUsd`
 *   con PESOS EXACTOS (monto_i / Σ, sin redondear a 4 decimales) y el
 *   residuo de centavos cae en el hijo ANCLA (`principal`).
 * - Extras POR_PAX por persona: cantidad_i = pax_i del hijo (exacto sin
 *   residuo: Σ cantidad_i × unitario == pasajeros_total × unitario).
 * - El consolidado NUNCA recalcula: suma por clave las líneas `desglose[]`
 *   ya persistidas de los hijos vivos; Σ líneas == Σ totales exacto porque
 *   cada hijo ya cumple el invariante 3 del repo.
 */

import { randomUUID } from 'node:crypto';
import {
  repartirUsd,
  type ParticipacionAeronave,
} from '../../common/participacion-aeronave.util';
import { ORIGEN_EXTRA_GRUPO } from '../quotes/extras-grupo.util';

export type RepartoExtraGrupo = 'POR_PAX' | 'ANCLA' | 'PROPORCIONAL';

/** Definición de un extra en la cabecera (`vuelo_grupo.extras_grupo[]`). */
export interface ExtraGrupoDef {
  id: string;
  concepto: string;
  /** Cantidad total del grupo; null ⇒ por persona (= pasajeros_total). */
  cantidad: number | null;
  /** Unitario NATIVO en `moneda`. */
  unitario: number;
  moneda: 'USD' | 'MXN';
  aplica_iva: boolean;
  por_persona: boolean;
  reparto: RepartoExtraGrupo;
}

/** Tramo de la plantilla comercial del grupo (misma forma que EscalaInputDto). */
export interface PlantillaTramo {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number;
  es_ferry?: boolean | null;
  requiere_pernocta?: boolean | null;
  pernocta_costo_usd?: number | null;
  tipo_parada?: 'NORMAL' | 'SERVICIO' | null;
  servicio_notas?: string | null;
  notas?: string | null;
  pdf_oculto?: boolean | null;
}

/** Tramo ya resuelto para UN hijo (pax por tramo; ferry ⇒ 0). */
export interface TramoHijo {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number;
  pasajeros: number;
  es_ferry: boolean;
  requiere_pernocta: boolean;
  pernocta_costo_usd: number | null;
  tipo_parada: 'NORMAL' | 'SERVICIO';
  servicio_notas: string | null;
  notas: string | null;
  pdf_oculto: boolean | null;
  fecha_salida_plan: string | null;
}

/** Línea de extra MATERIALIZADA en un hijo (viaja a `vuelo.extras[]`). */
export interface ExtraLineaHijo {
  concepto: string;
  /** Monto NATIVO (solo cuando NO viene cantidad × unitario). */
  monto_usd: number;
  cantidad?: number;
  unitario?: number;
  moneda: 'USD' | 'MXN';
  aplica_iva: boolean;
  por_persona?: boolean;
  origen: 'GRUPO';
  grupo_extra_id: string;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Texto seguro de un valor jsonb desconocido ('' si no es texto/número). */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// ===== Partición con pesos EXACTOS =====

/**
 * Reparte `monto` entre claves con pesos EXACTOS (peso_i / Σ, sin redondeo
 * intermedio) vía `repartirUsd` (centavos por residuo mayor, Σ == monto
 * exacto); el residuo de empates cae en `principal` (el hijo ANCLA). Pesos
 * ≤ 0 se ignoran; si ningún peso es positivo, todo va al principal (o a la
 * primera clave). Monto 0 ⇒ todas las partes 0.
 */
export function repartirExacto(
  monto: number,
  pesos: ReadonlyMap<string, number>,
  principal: string | null,
): Map<string, number> {
  const out = new Map<string, number>();
  const claves = [...pesos.keys()];
  if (claves.length === 0) return out;
  for (const k of claves) out.set(k, 0);
  const m = round2(monto);
  if (m === 0) return out;
  const positivos = claves.filter((k) => (pesos.get(k) ?? 0) > 0);
  const total = positivos.reduce((acc, k) => acc + (pesos.get(k) ?? 0), 0);
  const factores = new Map<string, number>();
  if (positivos.length === 0 || total <= 0) {
    const receptor = principal && pesos.has(principal) ? principal : claves[0];
    factores.set(receptor, 1);
  } else {
    for (const k of positivos) factores.set(k, (pesos.get(k) ?? 0) / total);
  }
  const p: ParticipacionAeronave = {
    factores,
    pesos: new Map(pesos),
    tramos_por_avion: new Map(),
    tramos_activos: 0,
    fuente: 'tramos',
    multi_avion: factores.size > 1,
    principal: principal && factores.has(principal) ? principal : null,
  };
  for (const [k, v] of repartirUsd(m, p)) out.set(k, v);
  return out;
}

// ===== Flota =====

export interface FichaAvionArmador {
  id: string;
  matricula: string;
  modelo: string | null;
  asientos: number | null;
  activa: boolean;
  tarifa_hora_pub_usd: number | null;
  tarifa_hora_broker_usd: number | null;
}

export interface AvionPropuesto {
  aeronave_id: string;
  pax: number;
  rotaciones: 1 | 2;
}

export interface PropuestaFlota {
  aviones: AvionPropuesto[];
  /** Σ asientos de los aviones propuestos. */
  asientos_total: number;
  /** Pax que NO caben en una sola oleada (0 = todo cabe). */
  faltan: number;
}

/**
 * Propone la flota para `pasajerosTotal`: greedy por asientos DESC (empate:
 * tarifa pública más barata primero) hasta cubrir el total; cada avión se
 * llena y el último recibe el resto. Si toda la flota no alcanza, entran
 * TODOS llenos y `faltan` dice cuántos pax quedan fuera (el caller ofrece
 * doble rotación / reactivar / externo). Aviones sin asientos en catálogo
 * no se proponen (no hay con qué contar).
 */
export function proponerFlota(
  fichas: FichaAvionArmador[],
  pasajerosTotal: number,
): PropuestaFlota {
  const candidatos = fichas
    .filter((f) => f.activa && (f.asientos ?? 0) > 0)
    .sort((a, b) => {
      const d = (b.asientos ?? 0) - (a.asientos ?? 0);
      if (d !== 0) return d;
      return (
        (a.tarifa_hora_pub_usd ?? Number.MAX_SAFE_INTEGER) -
        (b.tarifa_hora_pub_usd ?? Number.MAX_SAFE_INTEGER)
      );
    });
  const aviones: AvionPropuesto[] = [];
  let restantes = Math.max(0, Math.floor(pasajerosTotal));
  let asientosTotal = 0;
  for (const f of candidatos) {
    if (restantes <= 0) break;
    const asientos = f.asientos ?? 0;
    const pax = Math.min(asientos, restantes);
    aviones.push({ aeronave_id: f.id, pax, rotaciones: 1 });
    asientosTotal += asientos;
    restantes -= pax;
  }
  return { aviones, asientos_total: asientosTotal, faltan: restantes };
}

// ===== Tramos por hijo (rotaciones) =====

function tramoBase(
  t: PlantillaTramo,
  pax: number,
  opts: { ferry?: boolean; notaFerry?: string } = {},
): TramoHijo {
  const esFerry = opts.ferry === true || t.es_ferry === true;
  return {
    origen_iata: t.origen_iata.toUpperCase(),
    destino_iata: t.destino_iata.toUpperCase(),
    millas_nauticas: Number(t.millas_nauticas) || 0,
    pasajeros: esFerry ? 0 : pax,
    es_ferry: esFerry,
    // Un ferry de doble rotación no pernocta ni presta servicio: las marcas
    // de la plantilla viven solo en las copias con pasajeros.
    requiere_pernocta: opts.ferry ? false : t.requiere_pernocta === true,
    pernocta_costo_usd: opts.ferry
      ? null
      : t.requiere_pernocta === true
        ? (t.pernocta_costo_usd ?? null)
        : null,
    tipo_parada: opts.ferry
      ? 'NORMAL'
      : t.tipo_parada === 'SERVICIO'
        ? 'SERVICIO'
        : 'NORMAL',
    servicio_notas: opts.ferry ? null : (t.servicio_notas ?? null),
    notas: opts.ferry ? (opts.notaFerry ?? null) : (t.notas ?? null),
    pdf_oculto: t.pdf_oculto == null ? null : t.pdf_oculto === true,
    fecha_salida_plan: null,
  };
}

export interface TramosHijoResult {
  tramos: TramoHijo[];
  /** Pax por oleada: [pax] con 1 rotación; [w1, w2] con 2. */
  pax_por_rotacion: number[];
}

/**
 * Tramos del hijo a partir de la plantilla y su pax:
 * - 1 rotación: la plantilla con `pasajeros = pax` (ferry ⇒ 0).
 * - 2 rotaciones (el avión da DOBLE VUELTA porque no cabe todo): la
 *   plantilla debe ser ida y vuelta (nº PAR de tramos, cerrando en el
 *   origen). Ida = primera mitad, regreso = segunda mitad. Secuencia:
 *   ida(w1) · regreso FERRY · ida(w2) · regreso(w1) · ida FERRY · regreso(w2)
 *   con w1 = asientos (se llena el avión) y w2 = pax − w1 (sin asientos en
 *   catálogo, mitad y mitad). Un solo hijo con 6 tramos: tacos, gastos y
 *   balance siguen siendo de UN vuelo.
 */
export function tramosDeHijo(
  plantilla: PlantillaTramo[],
  pax: number,
  rotaciones: 1 | 2,
  asientos: number | null,
): TramosHijoResult {
  if (plantilla.length === 0) {
    throw new Error('La plantilla del grupo no tiene tramos.');
  }
  if (rotaciones !== 2) {
    return {
      tramos: plantilla.map((t) => tramoBase(t, pax)),
      pax_por_rotacion: [pax],
    };
  }
  const n = plantilla.length;
  const cierra =
    plantilla[n - 1].destino_iata.toUpperCase() ===
    plantilla[0].origen_iata.toUpperCase();
  if (n % 2 !== 0 || !cierra) {
    throw new Error(
      'La doble rotación solo aplica a itinerarios de ida y vuelta (número par de tramos que regresan al origen).',
    );
  }
  const w1 =
    asientos != null && asientos > 0
      ? Math.min(pax, asientos)
      : Math.ceil(pax / 2);
  const w2 = pax - w1;
  if (w2 <= 0) {
    throw new Error(
      `El avión no necesita doble rotación: sus ${pax} pasajeros caben en una sola vuelta.`,
    );
  }
  const ida = plantilla.slice(0, n / 2);
  const regreso = plantilla.slice(n / 2);
  const ferryNota = 'Ferry · doble rotación del grupo';
  const tramos: TramoHijo[] = [
    ...ida.map((t) => tramoBase(t, w1)),
    ...regreso.map((t) =>
      tramoBase(t, 0, { ferry: true, notaFerry: ferryNota }),
    ),
    ...ida.map((t) => tramoBase(t, w2)),
    ...regreso.map((t) => tramoBase(t, w1)),
    ...ida.map((t) => tramoBase(t, 0, { ferry: true, notaFerry: ferryNota })),
    ...regreso.map((t) => tramoBase(t, w2)),
  ];
  return { tramos, pax_por_rotacion: [w1, w2] };
}

// ===== Extras del grupo → hijos =====

export interface HijoParaExtras {
  /** Clave estable del hijo (posición o vuelo_id). */
  key: string;
  /** grupo_pax del hijo (todas sus vueltas). */
  pax: number;
}

/**
 * Normaliza la lista de extras de la cabecera (DTO o jsonb persistido) a
 * `ExtraGrupoDef[]` con defaults: moneda USD, IVA true, por_persona true
 * (si no viene cantidad), reparto POR_PAX; id nuevo cuando falta (con
 * `idNuevo`, default `crypto.randomUUID`). Conceptos vacíos o unitario ≤ 0
 * se descartan.
 */
export function normalizarExtrasGrupo(
  entrada: unknown,
  idNuevo: () => string = () => randomUUID(),
): ExtraGrupoDef[] {
  if (!Array.isArray(entrada)) return [];
  const out: ExtraGrupoDef[] = [];
  for (const raw of entrada as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') continue;
    const concepto = str(raw.concepto).trim();
    const unitario = round2(Number(raw.unitario) || 0);
    if (!concepto || unitario <= 0) continue;
    const cantidadRaw = raw.cantidad == null ? null : Number(raw.cantidad);
    const cantidad =
      cantidadRaw != null && Number.isFinite(cantidadRaw) && cantidadRaw > 0
        ? cantidadRaw
        : null;
    const porPersona =
      raw.por_persona == null ? cantidad == null : raw.por_persona === true;
    const reparto =
      raw.reparto === 'ANCLA' || raw.reparto === 'PROPORCIONAL'
        ? raw.reparto
        : 'POR_PAX';
    out.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : idNuevo(),
      concepto,
      cantidad: porPersona ? null : cantidad,
      unitario,
      moneda: raw.moneda === 'MXN' ? 'MXN' : 'USD',
      aplica_iva: raw.aplica_iva !== false,
      por_persona: porPersona,
      reparto,
    });
  }
  return out;
}

/** Cantidad TOTAL del extra en el grupo (por persona = pasajeros_total). */
export function cantidadTotalExtra(
  def: ExtraGrupoDef,
  pasajerosTotal: number,
): number {
  return def.por_persona
    ? Math.max(0, pasajerosTotal)
    : Math.max(0, def.cantidad ?? 0);
}

/**
 * Materializa los extras de la cabecera en líneas por hijo:
 * - POR_PAX (default) por persona: cantidad_i = pax_i (Σ exacto). Con
 *   cantidad explícita (no por persona) equivale a PROPORCIONAL.
 * - PROPORCIONAL: monto_total = round2(cantidad × unitario) repartido por
 *   pax con pesos exactos (residuo al ancla); las partes viajan como MONTO.
 * - ANCLA: toda la línea (cantidad × unitario) en el hijo ancla.
 * Toda línea nace `origen: 'GRUPO'` + `grupo_extra_id` — el motor conserva
 * su cantidad (no la liga al pax del vuelo) y revise/quickAdjust del hijo
 * la anclan.
 */
export function materializarExtras(
  defs: ExtraGrupoDef[],
  hijos: HijoParaExtras[],
  anclaKey: string | null,
  pasajerosTotal: number,
): Map<string, ExtraLineaHijo[]> {
  const out = new Map<string, ExtraLineaHijo[]>();
  for (const h of hijos) out.set(h.key, []);
  if (hijos.length === 0) return out;
  const ancla = anclaKey && out.has(anclaKey) ? anclaKey : hijos[0].key;
  const pesosPax = new Map(hijos.map((h) => [h.key, Math.max(0, h.pax)]));
  for (const def of defs) {
    const unitario = round2(Number(def.unitario) || 0);
    if (!def.concepto?.trim() || unitario <= 0) continue;
    const cantidadTotal = cantidadTotalExtra(def, pasajerosTotal);
    if (cantidadTotal <= 0) continue;
    const base = {
      concepto: def.concepto.trim(),
      moneda: def.moneda,
      aplica_iva: def.aplica_iva,
      origen: ORIGEN_EXTRA_GRUPO as 'GRUPO',
      grupo_extra_id: def.id,
    };
    if (def.reparto === 'ANCLA') {
      out.get(ancla)!.push({
        ...base,
        monto_usd: 0,
        cantidad: cantidadTotal,
        unitario,
        ...(def.por_persona ? { por_persona: true } : {}),
      });
      continue;
    }
    if (def.reparto === 'POR_PAX' && def.por_persona) {
      for (const h of hijos) {
        if (h.pax <= 0) continue;
        out.get(h.key)!.push({
          ...base,
          monto_usd: 0,
          cantidad: h.pax,
          unitario,
          por_persona: true,
        });
      }
      continue;
    }
    // PROPORCIONAL (y POR_PAX con cantidad explícita): reparto del MONTO.
    const montoTotal = round2(cantidadTotal * unitario);
    const partes = repartirExacto(montoTotal, pesosPax, ancla);
    for (const h of hijos) {
      const parte = partes.get(h.key) ?? 0;
      if (parte === 0) continue;
      out.get(h.key)!.push({ ...base, monto_usd: parte });
    }
  }
  return out;
}

/**
 * Ajuste/descuento del grupo (pre-IVA) repartido por BASE gravable de cada
 * hijo con pesos exactos; residuo al ancla. Cada hijo lo recibe como
 * `ajuste_final_usd` y su motor le aplica su IVA: Σ AJUSTE de hijos ==
 * ajuste del grupo exacto. Base ≤ 0 en todos ⇒ todo al ancla.
 */
export function repartirAjuste(
  ajusteGrupoUsd: number,
  basesPreIva: ReadonlyMap<string, number>,
  anclaKey: string | null,
): Map<string, number> {
  return repartirExacto(ajusteGrupoUsd, basesPreIva, anclaKey);
}

// ===== Salidas escalonadas =====

export interface AvionParaEscalonar {
  key: string;
  rotaciones: 1 | 2;
  /** Salida explícita capturada por oficina (gana sobre el escalonado). */
  fecha_salida_plan?: Date | string | null;
}

/**
 * Salida planeada por avión: el de DOBLE VUELTA sale primero (su segunda
 * tanda llega ~1 h 45 después), luego los demás en su orden, cada uno
 * `minutos` después del anterior. Una salida explícita se respeta y no
 * consume turno.
 */
export function escalonarSalidas(
  base: Date,
  aviones: AvionParaEscalonar[],
  minutos = 10,
): Map<string, Date> {
  const out = new Map<string, Date>();
  const orden = [...aviones].sort((a, b) => {
    if (a.rotaciones !== b.rotaciones) return a.rotaciones === 2 ? -1 : 1;
    return 0;
  });
  // Salidas explícitas primero: los turnos automáticos no las pisan (al
  // agregar un avión a un grupo ya escalonado toma el siguiente hueco).
  const ocupadas = new Set<number>();
  const pendientes: AvionParaEscalonar[] = [];
  for (const a of orden) {
    if (a.fecha_salida_plan) {
      const d =
        a.fecha_salida_plan instanceof Date
          ? a.fecha_salida_plan
          : new Date(a.fecha_salida_plan);
      if (!Number.isNaN(d.getTime())) {
        out.set(a.key, d);
        ocupadas.add(Math.round(d.getTime() / 60_000));
        continue;
      }
    }
    pendientes.push(a);
  }
  let turno = 0;
  for (const a of pendientes) {
    let t = base.getTime() + turno * minutos * 60_000;
    while (ocupadas.has(Math.round(t / 60_000))) {
      turno += 1;
      t = base.getTime() + turno * minutos * 60_000;
    }
    out.set(a.key, new Date(t));
    ocupadas.add(Math.round(t / 60_000));
    turno += 1;
  }
  return out;
}

// ===== Tripulación =====

export interface AvionConTripulacion {
  key: string;
  piloto_id?: string | null;
  copiloto_id?: string | null;
}

export interface DuplicadoPiloto {
  usuario_id: string;
  /** Claves (posiciones) de los hijos donde se repite. */
  posiciones: string[];
}

/**
 * Un mismo usuario no puede ir en dos hijos del MISMO request (ni como
 * piloto y copiloto del mismo hijo): los hijos vuelan a la misma hora.
 * `pilotosDisponibilidad` solo ve vuelos YA existentes, por eso este chequeo
 * vive aparte (409 en el armador).
 */
export function duplicadosDePiloto(
  aviones: AvionConTripulacion[],
): DuplicadoPiloto[] {
  const apariciones = new Map<string, string[]>();
  for (const a of aviones) {
    for (const uid of [a.piloto_id, a.copiloto_id]) {
      if (!uid) continue;
      const lista = apariciones.get(uid) ?? [];
      lista.push(a.key);
      apariciones.set(uid, lista);
    }
  }
  return [...apariciones.entries()]
    .filter(([, pos]) => pos.length > 1)
    .map(([usuario_id, posiciones]) => ({ usuario_id, posiciones }));
}

// ===== Consolidado (lector puro de desgloses persistidos) =====

export interface HijoConsolidable {
  key: string;
  posicion: number | null;
  matricula: string | null;
  cancelado?: boolean;
  calculo_snapshot: unknown;
  total_usd: number;
  total_mxn: number | null;
}

export interface LineaConsolidada {
  clave: string;
  concepto: string;
  monto_usd: number;
  cantidad?: number;
  unitario?: number;
  moneda?: 'USD' | 'MXN';
  grupo_extra_id?: string;
  iata?: string;
  pax?: number;
  aplica_iva?: boolean;
  /** Parte de cada hijo (posición/matrícula) en esta línea. */
  por_avion: Array<{
    key: string;
    posicion: number | null;
    matricula: string | null;
    monto_usd: number;
  }>;
}

export interface Consolidado {
  aviones: number;
  desglose: LineaConsolidada[];
  subtotal_aereo_usd: number;
  tuas_usd: number;
  extras_usd: number;
  pernocta_usd: number;
  comision_vendedor_usd: number;
  ajuste_usd: number;
  iva_usd: number;
  total_usd: number;
  total_mxn: number | null;
  por_persona_usd: number | null;
  horas_total_hr: number;
  verificacion: { suma_lineas_usd: number; total_usd: number; cuadra: boolean };
}

interface SnapMin {
  desglose?: Array<{
    clave?: unknown;
    concepto?: unknown;
    monto_usd?: unknown;
  }>;
  extras?: Array<Record<string, unknown>> | null;
  tuas?: {
    filas?: Array<{ iata?: unknown; total_usd?: unknown; pax?: unknown }>;
  };
  tiempos?: { cobrable_hr?: unknown };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Suma por clave los desgloses canónicos de los hijos VIVOS (cancelados
 * fuera). EXTRA se agrupa por `grupo_extra_id` (Σ partes; cantidad Σ y
 * unitario común cuando todas las partes lo traen); un extra propio de un
 * hijo se lista con su matrícula. TUAS se agrupa por aeropuerto desde
 * `snapshot.tuas.filas`. Σ líneas == Σ totales exacto (cada hijo ya cumple
 * el invariante 3): `verificacion.cuadra`.
 */
export function consolidarDesgloses(
  hijos: HijoConsolidable[],
  pasajerosTotal: number | null,
): Consolidado {
  const vivos = hijos.filter((h) => !h.cancelado);
  const tiempo: LineaConsolidada = {
    clave: 'TIEMPO_VUELO',
    concepto: '',
    monto_usd: 0,
    por_avion: [],
  };
  const tuasPorIata = new Map<string, LineaConsolidada>();
  const extrasGrupo = new Map<
    string,
    LineaConsolidada & { _unitarios: Set<number>; _cantOk: boolean }
  >();
  const extrasPropios: LineaConsolidada[] = [];
  const simples = new Map<string, LineaConsolidada>();
  const simple = (clave: string, concepto: string): LineaConsolidada => {
    let l = simples.get(clave);
    if (!l) {
      l = { clave, concepto, monto_usd: 0, por_avion: [] };
      simples.set(clave, l);
    }
    return l;
  };
  let horas = 0;
  let totalUsd = 0;
  let totalMxn: number | null = 0;

  for (const h of vivos) {
    const snap = (h.calculo_snapshot ?? {}) as SnapMin;
    const desglose = Array.isArray(snap.desglose) ? snap.desglose : [];
    const extras = Array.isArray(snap.extras) ? snap.extras : [];
    const quien = { key: h.key, posicion: h.posicion, matricula: h.matricula };
    horas += num(snap.tiempos?.cobrable_hr);
    totalUsd = round2(totalUsd + round2(h.total_usd));
    if (totalMxn != null) {
      totalMxn = h.total_mxn == null ? null : round2(totalMxn + h.total_mxn);
    }
    // TUAS por aeropuerto (filas contables del snapshot). Si el snapshot
    // no trae filas (cotización vieja) se cae a las líneas del desglose.
    const filasRaw = snap.tuas?.filas;
    const filas = Array.isArray(filasRaw) ? filasRaw : [];
    const tuasLineas = desglose.filter((d) => d.clave === 'TUAS');
    const sumaFilas = round2(
      filas.reduce((acc, f) => acc + num(f.total_usd), 0),
    );
    const sumaLineas = round2(
      tuasLineas.reduce((acc, d) => acc + num(d.monto_usd), 0),
    );
    if (filas.length > 0 && sumaFilas === sumaLineas) {
      for (const f of filas) {
        const iata = str(f.iata).toUpperCase();
        const monto = round2(num(f.total_usd));
        if (!iata || monto === 0) continue;
        let l = tuasPorIata.get(iata);
        if (!l) {
          l = {
            clave: 'TUAS',
            concepto: '',
            monto_usd: 0,
            iata,
            pax: 0,
            por_avion: [],
          };
          tuasPorIata.set(iata, l);
        }
        l.monto_usd = round2(l.monto_usd + monto);
        l.pax = (l.pax ?? 0) + num(f.pax);
        l.por_avion.push({ ...quien, monto_usd: monto });
      }
    } else if (tuasLineas.length > 0) {
      let l = tuasPorIata.get('*');
      if (!l) {
        l = { clave: 'TUAS', concepto: 'TUA', monto_usd: 0, por_avion: [] };
        tuasPorIata.set('*', l);
      }
      l.monto_usd = round2(l.monto_usd + sumaLineas);
      l.por_avion.push({ ...quien, monto_usd: sumaLineas });
    }
    // EXTRA: las líneas del desglose van en el mismo orden que
    // snapshot.extras[] (el motor las genera con extras.map). Si no
    // coinciden en número, todo se trata como propio del hijo.
    const extraLineas = desglose.filter((d) => d.clave === 'EXTRA');
    const alineados = extraLineas.length === extras.length;
    extraLineas.forEach((d, i) => {
      const monto = round2(num(d.monto_usd));
      const meta = alineados ? extras[i] : undefined;
      const gid = meta?.grupo_extra_id as string | undefined;
      if (gid && meta?.origen === ORIGEN_EXTRA_GRUPO) {
        let l = extrasGrupo.get(gid);
        if (!l) {
          l = {
            clave: 'EXTRA',
            concepto: str(meta.concepto),
            monto_usd: 0,
            grupo_extra_id: gid,
            moneda: meta.moneda === 'MXN' ? 'MXN' : 'USD',
            aplica_iva: meta.aplica_iva !== false,
            por_avion: [],
            _unitarios: new Set<number>(),
            _cantOk: true,
          };
          extrasGrupo.set(gid, l);
        }
        l.monto_usd = round2(l.monto_usd + monto);
        if (meta.cantidad != null && meta.unitario != null) {
          l.cantidad = (l.cantidad ?? 0) + num(meta.cantidad);
          l._unitarios.add(round2(num(meta.unitario)));
        } else {
          l._cantOk = false;
        }
        l.por_avion.push({ ...quien, monto_usd: monto });
        return;
      }
      extrasPropios.push({
        clave: 'EXTRA',
        concepto: `${str(d.concepto) || str(meta?.concepto) || 'Extra'}${
          h.matricula ? ` (${h.matricula})` : ''
        }`,
        monto_usd: monto,
        por_avion: [{ ...quien, monto_usd: monto }],
      });
    });
    for (const d of desglose) {
      const clave = str(d.clave);
      const monto = round2(num(d.monto_usd));
      if (clave === 'TIEMPO_VUELO') {
        tiempo.monto_usd = round2(tiempo.monto_usd + monto);
        tiempo.por_avion.push({ ...quien, monto_usd: monto });
      } else if (clave === 'COMISION_VENDEDOR') {
        const l = simple(clave, 'Comisión del vendedor');
        l.monto_usd = round2(l.monto_usd + monto);
        l.por_avion.push({ ...quien, monto_usd: monto });
      } else if (clave === 'AJUSTE') {
        const l = simple(clave, 'Ajuste');
        l.monto_usd = round2(l.monto_usd + monto);
        l.por_avion.push({ ...quien, monto_usd: monto });
      } else if (clave === 'IVA') {
        const l = simple(clave, str(d.concepto) || 'IVA');
        l.monto_usd = round2(l.monto_usd + monto);
        l.por_avion.push({ ...quien, monto_usd: monto });
      } else if (clave === 'PERNOCTA') {
        const l = simple(clave, 'Viáticos por pernocta (sin IVA)');
        l.monto_usd = round2(l.monto_usd + monto);
        l.por_avion.push({ ...quien, monto_usd: monto });
      }
    }
  }

  const horasR = round4(horas);
  tiempo.concepto = `Servicio aéreo · ${vivos.length} aeronave${vivos.length === 1 ? '' : 's'} · ${horasR} hr`;
  for (const [iata, l] of tuasPorIata) {
    if (iata !== '*') l.concepto = `TUA ${iata} · ${l.pax ?? 0} pax`;
  }
  const extrasFinal: LineaConsolidada[] = [];
  for (const l of extrasGrupo.values()) {
    const { _unitarios, _cantOk, ...linea } = l;
    if (_cantOk && _unitarios.size === 1 && linea.cantidad != null) {
      linea.unitario = [..._unitarios][0];
      linea.concepto = `${linea.concepto} · ${linea.cantidad} × $${linea.unitario.toFixed(2)}${
        linea.moneda === 'MXN' ? ' MXN' : ''
      }`;
    } else {
      delete linea.cantidad;
    }
    extrasFinal.push(linea);
  }
  extrasFinal.push(...extrasPropios);
  const ajuste = simples.get('AJUSTE');
  if (ajuste) ajuste.concepto = ajuste.monto_usd < 0 ? 'Descuento' : 'Redondeo';

  const desglose: LineaConsolidada[] = [
    ...(vivos.length > 0 ? [tiempo] : []),
    ...tuasPorIata.values(),
    ...extrasFinal,
    ...(simples.get('COMISION_VENDEDOR')
      ? [simples.get('COMISION_VENDEDOR')!]
      : []),
    ...(ajuste && ajuste.monto_usd !== 0 ? [ajuste] : []),
    ...(simples.get('IVA') ? [simples.get('IVA')!] : []),
    ...(simples.get('PERNOCTA') ? [simples.get('PERNOCTA')!] : []),
  ].filter((l) => l.monto_usd !== 0 || l.clave === 'TIEMPO_VUELO');

  const suma = round2(desglose.reduce((acc, l) => acc + l.monto_usd, 0));
  const tuasUsd = round2(
    [...tuasPorIata.values()].reduce((a, l) => a + l.monto_usd, 0),
  );
  const extrasUsd = round2(extrasFinal.reduce((a, l) => a + l.monto_usd, 0));
  return {
    aviones: vivos.length,
    desglose,
    subtotal_aereo_usd: tiempo.monto_usd,
    tuas_usd: tuasUsd,
    extras_usd: extrasUsd,
    pernocta_usd: simples.get('PERNOCTA')?.monto_usd ?? 0,
    comision_vendedor_usd: simples.get('COMISION_VENDEDOR')?.monto_usd ?? 0,
    ajuste_usd: ajuste?.monto_usd ?? 0,
    iva_usd: simples.get('IVA')?.monto_usd ?? 0,
    total_usd: totalUsd,
    total_mxn: vivos.length === 0 ? null : totalMxn,
    por_persona_usd:
      pasajerosTotal && pasajerosTotal > 0
        ? round2(totalUsd / pasajerosTotal)
        : null,
    horas_total_hr: horasR,
    verificacion: {
      suma_lineas_usd: suma,
      total_usd: totalUsd,
      cuadra: Math.abs(suma - totalUsd) < 0.005,
    },
  };
}

// ===== Estado derivado =====

export type EstadoGrupo =
  | 'RESERVA'
  | 'COTIZADO'
  | 'CONFIRMADO_PARCIAL'
  | 'CONFIRMADO'
  | 'EN_CURSO'
  | 'COMPLETADO'
  | 'CANCELADO';

/**
 * Estado del grupo DERIVADO de sus hijos (la cabecera no lo guarda):
 * CANCELADO si la cabecera lo está o todos los hijos lo están; EN_CURSO si
 * alguno vuela (o ya voló y otros no); COMPLETADO si todos los vivos
 * terminaron; CONFIRMADO / CONFIRMADO_PARCIAL / COTIZADO / RESERVA según
 * los pre-vuelo.
 */
export function estadoGrupoDe(
  hijos: Array<{ estado: string }>,
  canceladoAt: string | null | undefined,
): EstadoGrupo {
  if (canceladoAt) return 'CANCELADO';
  const vivos = hijos.filter((h) => h.estado !== 'CANCELADO');
  if (vivos.length === 0) return hijos.length > 0 ? 'CANCELADO' : 'COTIZADO';
  const estados = vivos.map((h) => h.estado);
  if (estados.includes('EN_VUELO')) return 'EN_CURSO';
  const completados = estados.filter((e) => e === 'COMPLETADO').length;
  if (completados === vivos.length) return 'COMPLETADO';
  if (completados > 0) return 'EN_CURSO';
  const confirmados = estados.filter((e) => e === 'CONFIRMADO').length;
  if (confirmados === vivos.length) return 'CONFIRMADO';
  if (confirmados > 0) return 'CONFIRMADO_PARCIAL';
  if (estados.every((e) => e === 'RESERVA')) return 'RESERVA';
  return 'COTIZADO';
}

// ===== Diagnóstico de desincronización =====

export interface HijoDiagnostico {
  posicion: number | null;
  folio: number | null;
  grupo_pax: number | null;
  extras: unknown;
  calculo_snapshot: unknown;
}

export interface ProblemaGrupo {
  tipo: 'PAX' | 'PRECIO_DESACTUALIZADO' | 'EXTRAS';
  detalle: string;
  folio?: number | null;
  posicion?: number | null;
}

/**
 * Qué está desincronizado entre la cabecera y sus hijos VIVOS (alerta
 * diaria `grupo_desincronizado` y `avisos` del detalle):
 * - PAX: Σ grupo_pax ≠ pasajeros_total (un avión se quitó/cambió sin
 *   re-armar).
 * - PRECIO_DESACTUALIZADO: la operación cambió el avión de un hijo sin
 *   recotizar (bandera del snapshot, precedente #80).
 * - EXTRAS: una línea GRUPO del hijo no corresponde a la cabecera (id
 *   huérfano, unitario/moneda/IVA distintos, cantidad ≠ pax en POR_PAX por
 *   persona, extra POR_PAX/ANCLA ausente) — alguien la editó fuera del
 *   grupo o la cabecera cambió sin re-materializar.
 */
export function diagnosticoGrupo(
  cabecera: { pasajeros_total: number; extras_grupo: ExtraGrupoDef[] },
  hijos: HijoDiagnostico[],
): ProblemaGrupo[] {
  const problemas: ProblemaGrupo[] = [];
  const sumaPax = hijos.reduce((acc, h) => acc + (h.grupo_pax ?? 0), 0);
  if (hijos.length > 0 && sumaPax !== cabecera.pasajeros_total) {
    problemas.push({
      tipo: 'PAX',
      detalle: `Los pasajeros por avión suman ${sumaPax} y el grupo es de ${cabecera.pasajeros_total}.`,
    });
  }
  const defs = new Map(cabecera.extras_grupo.map((d) => [d.id, d]));
  let anclaVistas = new Map<string, number>();
  for (const h of hijos) {
    const snap = h.calculo_snapshot as
      | { meta?: { grupo?: { precio_desactualizado?: boolean } } }
      | null
      | undefined;
    if (snap?.meta?.grupo?.precio_desactualizado === true) {
      problemas.push({
        tipo: 'PRECIO_DESACTUALIZADO',
        folio: h.folio,
        posicion: h.posicion,
        detalle: `Avión ${h.posicion ?? '?'} (vuelo #${h.folio ?? '?'}): vuela en otro avión distinto al cotizado — recotízalo desde el grupo.`,
      });
    }
    const lineas = (Array.isArray(h.extras) ? h.extras : []) as Array<
      Record<string, unknown>
    >;
    const vistos = new Set<string>();
    for (const l of lineas) {
      if (l.origen !== ORIGEN_EXTRA_GRUPO) continue;
      const gid =
        typeof l.grupo_extra_id === 'string' ? l.grupo_extra_id : null;
      const def = gid ? defs.get(gid) : undefined;
      if (!def) {
        problemas.push({
          tipo: 'EXTRAS',
          folio: h.folio,
          posicion: h.posicion,
          detalle: `Avión ${h.posicion ?? '?'} (vuelo #${h.folio ?? '?'}): el extra "${str(l.concepto)}" ya no existe en el grupo.`,
        });
        continue;
      }
      vistos.add(def.id);
      if (def.reparto === 'ANCLA') {
        anclaVistas.set(def.id, (anclaVistas.get(def.id) ?? 0) + 1);
      }
      const unit = l.unitario == null ? null : round2(num(l.unitario));
      const moneda = l.moneda === 'MXN' ? 'MXN' : 'USD';
      const iva = l.aplica_iva !== false;
      const malUnitario = unit != null && unit !== round2(def.unitario);
      const malCantidad =
        def.reparto === 'POR_PAX' &&
        def.por_persona &&
        l.cantidad != null &&
        num(l.cantidad) !== (h.grupo_pax ?? 0);
      if (
        malUnitario ||
        moneda !== def.moneda ||
        iva !== def.aplica_iva ||
        malCantidad
      ) {
        problemas.push({
          tipo: 'EXTRAS',
          folio: h.folio,
          posicion: h.posicion,
          detalle: `Avión ${h.posicion ?? '?'} (vuelo #${h.folio ?? '?'}): el extra "${def.concepto}" difiere de la cabecera (${
            malCantidad
              ? `cantidad ${num(l.cantidad)} ≠ ${h.grupo_pax ?? 0} pax`
              : malUnitario
                ? `unitario ${unit} ≠ ${def.unitario}`
                : 'moneda/IVA'
          }).`,
        });
      }
    }
    for (const def of defs.values()) {
      if (
        def.reparto === 'POR_PAX' &&
        def.por_persona &&
        (h.grupo_pax ?? 0) > 0 &&
        !vistos.has(def.id)
      ) {
        problemas.push({
          tipo: 'EXTRAS',
          folio: h.folio,
          posicion: h.posicion,
          detalle: `Avión ${h.posicion ?? '?'} (vuelo #${h.folio ?? '?'}): falta el extra "${def.concepto}" del grupo.`,
        });
      }
    }
  }
  for (const def of defs.values()) {
    if (def.reparto !== 'ANCLA' || hijos.length === 0) continue;
    const n = anclaVistas.get(def.id) ?? 0;
    if (n !== 1) {
      problemas.push({
        tipo: 'EXTRAS',
        detalle: `El extra "${def.concepto}" (al avión ancla) aparece en ${n} aviones; debe estar en exactamente uno.`,
      });
    }
  }
  anclaVistas = new Map();
  return problemas;
}
