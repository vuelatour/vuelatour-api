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

/**
 * Línea de TUA capturada en la CABECERA del grupo (`vuelo_grupo.tuas_lineas`,
 * 5-sep-2026): misma forma que `TuaLineaDto` del cotizador de un avión.
 * Viaja TAL CUAL al `CalculateQuoteDto` de CADA hijo — cada uno resuelve su
 * exención por prefijo de matrícula (XA/XB/N) con SU avión, igual que en
 * una cotización individual. La cabecera sigue sin dinero: aquí solo vive
 * el unitario capturado por aeropuerto.
 */
export interface TuaLineaGrupo {
  iata: string;
  /** Monto por pasajero NATIVO en `moneda`. */
  monto_pax: number;
  moneda: 'USD' | 'MXN';
}

/**
 * jsonb de la cabecera (o el DTO) → líneas válidas: IATA en mayúsculas
 * (3-4 letras), monto ≥ 0 a 2 decimales, moneda USD por default y UNA línea
 * por aeropuerto (la primera gana). Nunca lanza: una cabecera vieja sin la
 * columna o con basura da [] (= comportamiento previo, catálogo).
 */
export function normalizarTuasLineas(entrada: unknown): TuaLineaGrupo[] {
  if (!Array.isArray(entrada)) return [];
  const out: TuaLineaGrupo[] = [];
  const vistos = new Set<string>();
  for (const raw of entrada as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') continue;
    const iata = str(raw.iata).trim().toUpperCase();
    const monto = Number(raw.monto_pax);
    if (iata.length < 3 || iata.length > 4 || vistos.has(iata)) continue;
    if (!Number.isFinite(monto) || monto < 0) continue;
    vistos.add(iata);
    out.push({
      iata,
      monto_pax: round2(monto),
      moneda: raw.moneda === 'MXN' ? 'MXN' : 'USD',
    });
  }
  return out;
}

export interface HijoConsolidable {
  key: string;
  posicion: number | null;
  matricula: string | null;
  /** Modelo del avión efectivo del hijo; sin él se toma el del snapshot. */
  modelo?: string | null;
  cancelado?: boolean;
  calculo_snapshot: unknown;
  total_usd: number;
  total_mxn: number | null;
}

/** Parte de un hijo (posición/matrícula/modelo) en una línea consolidada. */
export interface ParteAvionConsolidada {
  key: string;
  posicion: number | null;
  matricula: string | null;
  modelo: string | null;
  monto_usd: number;
  /** TIEMPO_VUELO: horas cobrables del hijo (`snapshot.tiempos.cobrable_hr`). */
  horas_hr?: number;
  /** TIEMPO_VUELO: tarifa efectiva del hijo (`snapshot.tarifa.usd_por_hora`). */
  tarifa_hora_usd?: number;
  /** TUAS: pax del hijo en ese aeropuerto (gravados o exentos). */
  pax?: number;
  /** TUAS: el hijo quedó exento ahí (prefijo de matrícula / pase de abordar). */
  exento?: boolean;
}

/** Un hijo dentro del apartado TUAS de un aeropuerto. */
export interface TuasAvionConsolidado {
  key: string;
  posicion: number | null;
  matricula: string | null;
  modelo: string | null;
  pax: number;
  /** Unitario NATIVO que pagó el hijo (null si exento). */
  unitario: number | null;
  moneda: 'USD' | 'MXN' | null;
  unitario_usd: number | null;
  monto_usd: number;
  exento: boolean;
  /** Razón del motor ("Matricula N exenta en CUN", "monto capturado"…). */
  razon: string | null;
}

/**
 * OPERACIÓN VISIBLE de cada línea (5-sep-2026): los números que el panel y
 * el PDF pintan "sutilmente" al lado del monto («44 pax × $20.85»,
 * «1.50 h × $1,750.00», «16 % de $18,622.00») SIN calcular nada del lado
 * del cliente. Todo sale de los snapshots persistidos de los hijos; nunca
 * se recalcula un monto.
 */
export interface OperacionServicio {
  tipo: 'SERVICIO';
  aviones: number;
  horas_total_hr: number;
}

export interface OperacionTuas {
  tipo: 'TUAS';
  iata: string;
  /** Pax que SÍ pagaron TUA en este aeropuerto (Σ filas de los hijos). */
  pax_gravados: number;
  /** Pax de aviones exentos (prefijo XA/XB/N o pase de abordar). */
  pax_exentos: number;
  /**
   * Unitario NATIVO común a todos los aviones gravados; null cuando NO es
   * uniforme entre aviones (entonces manda `detalle_por_avion`).
   */
  unitario: number | null;
  moneda: 'USD' | 'MXN' | null;
  /** Unitario en USD (igual a `unitario` si la línea es USD). */
  unitario_usd: number | null;
  /** Σ total nativo cuando la moneda es uniforme; null si mezcla monedas. */
  total_nativo: number | null;
  aviones_exentos: Array<{
    key: string;
    posicion: number | null;
    matricula: string | null;
    modelo: string | null;
    pax: number;
    razon: string | null;
  }>;
  detalle_por_avion: TuasAvionConsolidado[];
}

export interface OperacionExtra {
  tipo: 'EXTRA';
  /** Cantidad TOTAL del grupo y unitario NATIVO común; null si no aplica. */
  cantidad: number | null;
  unitario: number | null;
  moneda: 'USD' | 'MXN';
}

export interface OperacionIva {
  tipo: 'IVA';
  /** Porcentaje 0-100 (16); null si los hijos no coinciden o no lo traen. */
  pct: number | null;
  /** Σ bases gravables de los hijos con IVA; null si algún snapshot no la trae. */
  base_usd: number | null;
}

export interface OperacionPernocta {
  tipo: 'PERNOCTA';
  /** Paradas con pernocta (Σ tramos de los hijos). */
  paradas: number;
  /** Costo por parada cuando es uniforme; null si varía. */
  unitario_usd: number | null;
}

export interface OperacionAjuste {
  tipo: 'AJUSTE';
  /** Base sobre la que se aplicó: servicio + TUAS + extras + comisión. */
  base_usd: number;
}

export type OperacionLinea =
  | OperacionServicio
  | OperacionTuas
  | OperacionExtra
  | OperacionIva
  | OperacionPernocta
  | OperacionAjuste;

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
  /** Parte de cada hijo (posición/matrícula/modelo) en esta línea. */
  por_avion: ParteAvionConsolidada[];
  /** Operación visible (presentación); ausente en líneas sin fórmula. */
  operacion?: OperacionLinea;
}

/** Apartado TUAS por aeropuerto (incluye aeropuertos donde TODOS son exentos). */
export interface TuasAeropuertoConsolidado extends OperacionTuas {
  monto_usd: number;
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
  /** Operación del precio por persona («$21,601.52 ÷ 44»); null sin pax. */
  por_persona: { total_usd: number; pasajeros_total: number } | null;
  /**
   * Apartado TUAS del grupo (como el del cotizador de un avión): por
   * aeropuerto, pax gravados/exentos, unitario, aviones exentos por prefijo
   * y el detalle por avión. `aeropuertos` lista también los que quedaron en
   * $0 por exención (el desglose no).
   */
  tuas: {
    total_usd: number;
    total_mxn_nativo: number;
    aeropuertos: TuasAeropuertoConsolidado[];
  };
  horas_total_hr: number;
  verificacion: { suma_lineas_usd: number; total_usd: number; cuadra: boolean };
}

interface SnapMin {
  aeronave?: { modelo?: unknown } | null;
  desglose?: Array<{
    clave?: unknown;
    concepto?: unknown;
    monto_usd?: unknown;
  }>;
  extras?: Array<Record<string, unknown>> | null;
  tuas?: {
    pasajeros?: unknown;
    total_mxn_nativo?: unknown;
    aeropuertos?: Array<{
      iata?: unknown;
      aplica?: unknown;
      razon?: unknown;
      monto_pax?: unknown;
      usd_pax?: unknown;
      moneda?: unknown;
    }>;
    filas?: Array<{
      iata?: unknown;
      total_usd?: unknown;
      total_nativo?: unknown;
      pax?: unknown;
      monto_pax?: unknown;
      moneda?: unknown;
      usd_pax?: unknown;
      razon?: unknown;
    }>;
  };
  tiempos?: { cobrable_hr?: unknown };
  tarifa?: { usd_por_hora?: unknown } | null;
  iva?: { porcentaje?: unknown; base_usd?: unknown } | null;
  tramos?: Array<{
    origen?: unknown;
    pasajeros?: unknown;
    es_ferry?: unknown;
    requiere_pernocta?: unknown;
    pernocta_usd?: unknown;
  }> | null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Suma por clave los desgloses canónicos de los hijos VIVOS (cancelados
 * fuera). EXTRA se agrupa por `grupo_extra_id` (Σ partes; cantidad Σ y
 * unitario común cuando todas las partes lo traen; en PROPORCIONAL —partes
 * como MONTO— la cantidad × unitario se recupera de `extrasDefs` SOLO si
 * Σ partes cuadra exacto con ella); un extra propio de un hijo se lista con
 * su matrícula. TUAS se agrupa por aeropuerto desde `snapshot.tuas.filas`
 * y los exentos salen de `snapshot.tuas.aeropuertos[].aplica=false` (pax
 * del hijo en ese aeropuerto = Σ tramos no-ferry que salen de ahí).
 * Σ líneas == Σ totales exacto (cada hijo ya cumple el invariante 3):
 * `verificacion.cuadra`. Cada línea lleva su `operacion` (presentación:
 * jamás recalcula un monto).
 */
export function consolidarDesgloses(
  hijos: HijoConsolidable[],
  pasajerosTotal: number | null,
  extrasDefs: ExtraGrupoDef[] = [],
): Consolidado {
  const vivos = hijos.filter((h) => !h.cancelado);
  const defsPorId = new Map(extrasDefs.map((d) => [d.id, d]));
  const paxTotal = pasajerosTotal && pasajerosTotal > 0 ? pasajerosTotal : 0;
  const tiempo: LineaConsolidada = {
    clave: 'TIEMPO_VUELO',
    concepto: '',
    monto_usd: 0,
    por_avion: [],
  };
  // TUAS por aeropuerto: agregado (gravados + exentos) en orden de aparición
  // del itinerario; las líneas del desglose se arman al final.
  interface TuasAgg extends TuasAeropuertoConsolidado {
    _unitarios: Set<string>;
    _monedas: Set<string>;
    _nativo: number;
  }
  const tuasAgg = new Map<string, TuasAgg>();
  const aggDe = (iata: string): TuasAgg => {
    let a = tuasAgg.get(iata);
    if (!a) {
      a = {
        tipo: 'TUAS',
        iata,
        monto_usd: 0,
        pax_gravados: 0,
        pax_exentos: 0,
        unitario: null,
        moneda: null,
        unitario_usd: null,
        total_nativo: null,
        aviones_exentos: [],
        detalle_por_avion: [],
        _unitarios: new Set<string>(),
        _monedas: new Set<string>(),
        _nativo: 0,
      };
      tuasAgg.set(iata, a);
    }
    return a;
  };
  // Cotización vieja sin filas: línea única "TUA" sin operación.
  let tuasStar: LineaConsolidada | null = null;
  let tuasMxnNativo = 0;
  const extrasGrupo = new Map<
    string,
    LineaConsolidada & {
      _unitarios: Set<number>;
      _cantOk: boolean;
      _nativo: number;
    }
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
  // Operación visible de IVA y pernocta (solo de los hijos que las llevan).
  let ivaBase: number | null = 0;
  let ivaPctOk = true;
  const ivaPcts = new Set<number>();
  let pernoctaParadas = 0;
  const pernoctaUnitarios = new Set<number>();

  for (const h of vivos) {
    const snap = (h.calculo_snapshot ?? {}) as SnapMin;
    const desglose = Array.isArray(snap.desglose) ? snap.desglose : [];
    const extras = Array.isArray(snap.extras) ? snap.extras : [];
    const modelo = h.modelo ?? (str(snap.aeronave?.modelo) || null);
    const quien = {
      key: h.key,
      posicion: h.posicion,
      matricula: h.matricula,
      modelo,
    };
    horas += num(snap.tiempos?.cobrable_hr);
    totalUsd = round2(totalUsd + round2(h.total_usd));
    if (totalMxn != null) {
      totalMxn = h.total_mxn == null ? null : round2(totalMxn + h.total_mxn);
    }
    tuasMxnNativo = round2(tuasMxnNativo + num(snap.tuas?.total_mxn_nativo));

    // Pax que el hijo PRESENTA por aeropuerto de SALIDA (tramos no-ferry):
    // es lo que el motor grava; sirve para contar los pax EXENTOS.
    const tramos = Array.isArray(snap.tramos) ? snap.tramos : [];
    const paxSalida = new Map<string, number>();
    for (const t of tramos) {
      const o = str(t.origen).toUpperCase();
      if (!o || t.es_ferry === true) continue;
      paxSalida.set(o, (paxSalida.get(o) ?? 0) + num(t.pasajeros));
    }
    const aeropuertos = Array.isArray(snap.tuas?.aeropuertos)
      ? snap.tuas.aeropuertos
      : [];
    // Orden del itinerario (todos los aeropuertos del hijo, exentos incluidos).
    for (const a of aeropuertos) {
      const iata = str(a.iata).toUpperCase();
      if (iata) aggDe(iata);
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
        const agg = aggDe(iata);
        const pax = num(f.pax);
        const unitario = round2(num(f.monto_pax));
        const moneda: 'USD' | 'MXN' = f.moneda === 'MXN' ? 'MXN' : 'USD';
        const unitarioUsd =
          f.usd_pax != null
            ? round4(num(f.usd_pax))
            : moneda === 'USD'
              ? unitario
              : null;
        agg.monto_usd = round2(agg.monto_usd + monto);
        agg.pax_gravados += pax;
        agg._unitarios.add(`${moneda}:${unitario}`);
        agg._monedas.add(moneda);
        agg._nativo = round2(
          agg._nativo +
            (f.total_nativo != null
              ? num(f.total_nativo)
              : moneda === 'USD'
                ? monto
                : 0),
        );
        agg.detalle_por_avion.push({
          ...quien,
          pax,
          unitario,
          moneda,
          unitario_usd: unitarioUsd,
          monto_usd: monto,
          exento: false,
          razon: str(f.razon) || null,
        });
      }
    } else if (tuasLineas.length > 0) {
      if (!tuasStar) {
        tuasStar = {
          clave: 'TUAS',
          concepto: 'TUA',
          monto_usd: 0,
          por_avion: [],
        };
      }
      tuasStar.monto_usd = round2(tuasStar.monto_usd + sumaLineas);
      tuasStar.por_avion.push({ ...quien, monto_usd: sumaLineas });
    }
    // Exentos (prefijo de matrícula / pase de abordar): el motor los deja en
    // snapshot.tuas.aeropuertos[] con aplica=false y su razón. Solo cuentan
    // si el hijo presenta pax ahí (un destino final sin salida no grava).
    // Un aeropuerto que APLICA pero cobra $0 (TUA capturada en $0 o catálogo
    // en $0) no genera fila en el motor: se conserva aquí como gravado a
    // $0.00 para que el apartado lo liste y el wizard no pierda la captura
    // (sin esto la fila desaparecía al teclear 0).
    const iatasConFila = new Set(
      filas.map((f) => str(f.iata).toUpperCase()).filter(Boolean),
    );
    for (const a of aeropuertos) {
      const iata = str(a.iata).toUpperCase();
      if (!iata) continue;
      const pax =
        tramos.length > 0
          ? (paxSalida.get(iata) ?? 0)
          : num(snap.tuas?.pasajeros);
      if (pax <= 0) continue;
      const razon = str(a.razon) || null;
      if (a.aplica !== false) {
        // Solo cuando el snapshot dice EXPLÍCITAMENTE $0 (monto_pax/usd_pax
        // presentes); un snapshot viejo sin esos campos no se inventa.
        const montoRaw = a.monto_pax ?? a.usd_pax;
        if (iatasConFila.has(iata) || montoRaw == null) continue;
        if (round2(num(montoRaw)) !== 0) continue;
        const agg = aggDe(iata);
        const moneda: 'USD' | 'MXN' = a.moneda === 'MXN' ? 'MXN' : 'USD';
        agg.pax_gravados += pax;
        agg._unitarios.add(`${moneda}:0`);
        agg._monedas.add(moneda);
        agg.detalle_por_avion.push({
          ...quien,
          pax,
          unitario: 0,
          moneda,
          unitario_usd: 0,
          monto_usd: 0,
          exento: false,
          razon,
        });
        continue;
      }
      const agg = aggDe(iata);
      agg.pax_exentos += pax;
      agg.aviones_exentos.push({ ...quien, pax, razon });
      agg.detalle_por_avion.push({
        ...quien,
        pax,
        unitario: null,
        moneda: null,
        unitario_usd: null,
        monto_usd: 0,
        exento: true,
        razon,
      });
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
            _nativo: 0,
          };
          extrasGrupo.set(gid, l);
        }
        l.monto_usd = round2(l.monto_usd + monto);
        l._nativo = round2(
          l._nativo +
            (meta.monto_nativo != null ? num(meta.monto_nativo) : monto),
        );
        if (meta.cantidad != null && meta.unitario != null) {
          l.cantidad = (l.cantidad ?? 0) + num(meta.cantidad);
          l._unitarios.add(round2(num(meta.unitario)));
        } else {
          l._cantOk = false;
        }
        l.por_avion.push({ ...quien, monto_usd: monto });
        return;
      }
      const cantidad =
        meta?.cantidad != null && meta?.unitario != null
          ? num(meta.cantidad)
          : null;
      const unitario =
        meta?.cantidad != null && meta?.unitario != null
          ? round2(num(meta.unitario))
          : null;
      extrasPropios.push({
        clave: 'EXTRA',
        concepto: `${str(d.concepto) || str(meta?.concepto) || 'Extra'}${
          h.matricula ? ` (${h.matricula})` : ''
        }`,
        monto_usd: monto,
        ...(meta?.moneda === 'MXN' ? { moneda: 'MXN' as const } : {}),
        por_avion: [{ ...quien, monto_usd: monto }],
        operacion: {
          tipo: 'EXTRA',
          cantidad,
          unitario,
          moneda: meta?.moneda === 'MXN' ? 'MXN' : 'USD',
        },
      });
    });
    for (const d of desglose) {
      const clave = str(d.clave);
      const monto = round2(num(d.monto_usd));
      if (clave === 'TIEMPO_VUELO') {
        tiempo.monto_usd = round2(tiempo.monto_usd + monto);
        tiempo.por_avion.push({
          ...quien,
          monto_usd: monto,
          horas_hr: round4(num(snap.tiempos?.cobrable_hr)),
          ...(snap.tarifa?.usd_por_hora != null
            ? { tarifa_hora_usd: round2(num(snap.tarifa.usd_por_hora)) }
            : {}),
        });
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
        if (snap.iva?.porcentaje != null) {
          ivaPcts.add(round2(num(snap.iva.porcentaje) * 100));
        } else {
          ivaPctOk = false;
        }
        ivaBase =
          ivaBase != null && snap.iva?.base_usd != null
            ? round2(ivaBase + num(snap.iva.base_usd))
            : null;
      } else if (clave === 'PERNOCTA') {
        const l = simple(clave, 'Viáticos por pernocta (sin IVA)');
        l.monto_usd = round2(l.monto_usd + monto);
        l.por_avion.push({ ...quien, monto_usd: monto });
        for (const t of tramos) {
          if (t.requiere_pernocta !== true) continue;
          pernoctaParadas += 1;
          pernoctaUnitarios.add(round2(num(t.pernocta_usd)));
        }
      }
    }
  }

  const horasR = round4(horas);
  tiempo.concepto = `Servicio aéreo · ${vivos.length} aeronave${vivos.length === 1 ? '' : 's'} · ${horasR} hr`;
  tiempo.operacion = {
    tipo: 'SERVICIO',
    aviones: vivos.length,
    horas_total_hr: horasR,
  };

  // Apartado TUAS + líneas del desglose (solo aeropuertos con monto).
  const tuasAeropuertos: TuasAeropuertoConsolidado[] = [];
  const tuasLineasFinal: LineaConsolidada[] = [];
  for (const agg of tuasAgg.values()) {
    const { _unitarios, _monedas, _nativo, ...resto } = agg;
    const ap: TuasAeropuertoConsolidado = resto;
    if (ap.pax_gravados === 0 && ap.pax_exentos === 0) continue;
    if (_unitarios.size === 1) {
      const [moneda, u] = [..._unitarios][0].split(':');
      ap.moneda = moneda === 'MXN' ? 'MXN' : 'USD';
      ap.unitario = Number(u);
      ap.unitario_usd =
        ap.moneda === 'USD'
          ? ap.unitario
          : (ap.detalle_por_avion.find((d) => !d.exento)?.unitario_usd ?? null);
    }
    ap.total_nativo =
      ap.pax_gravados > 0 && _monedas.size === 1 ? _nativo : null;
    tuasAeropuertos.push(ap);
    if (ap.monto_usd === 0) continue;
    const { monto_usd, ...operacion } = ap;
    tuasLineasFinal.push({
      clave: 'TUAS',
      concepto: `TUA ${ap.iata} · ${ap.pax_gravados} pax`,
      monto_usd,
      iata: ap.iata,
      pax: ap.pax_gravados,
      ...(ap.unitario != null && ap.moneda
        ? {
            cantidad: ap.pax_gravados,
            unitario: ap.unitario,
            moneda: ap.moneda,
          }
        : {}),
      por_avion: ap.detalle_por_avion.map((d) => ({
        key: d.key,
        posicion: d.posicion,
        matricula: d.matricula,
        modelo: d.modelo,
        monto_usd: d.monto_usd,
        pax: d.pax,
        exento: d.exento,
      })),
      operacion,
    });
  }
  if (tuasStar) tuasLineasFinal.push(tuasStar);

  const extrasFinal: LineaConsolidada[] = [];
  for (const l of extrasGrupo.values()) {
    const { _unitarios, _cantOk, _nativo, ...linea } = l;
    let cantidad: number | null = null;
    let unitario: number | null = null;
    if (_cantOk && _unitarios.size === 1 && linea.cantidad != null) {
      cantidad = linea.cantidad;
      unitario = [..._unitarios][0];
    } else {
      // PROPORCIONAL: las partes viajan como MONTO; la cantidad × unitario
      // vive en la definición de la cabecera y se muestra SOLO si Σ partes
      // (nativo) cuadra exacto con ella (un hijo cancelado la rompería).
      const def = linea.grupo_extra_id
        ? defsPorId.get(linea.grupo_extra_id)
        : undefined;
      if (def) {
        const cant = cantidadTotalExtra(def, paxTotal);
        const u = round2(def.unitario);
        if (cant > 0 && u > 0 && Math.abs(round2(cant * u) - _nativo) < 0.005) {
          cantidad = cant;
          unitario = u;
        }
      }
    }
    if (cantidad != null && unitario != null) {
      linea.cantidad = cantidad;
      linea.unitario = unitario;
      linea.concepto = `${linea.concepto} · ${cantidad} × $${unitario.toFixed(2)}${
        linea.moneda === 'MXN' ? ' MXN' : ''
      }`;
    } else {
      delete linea.cantidad;
    }
    linea.operacion = {
      tipo: 'EXTRA',
      cantidad,
      unitario,
      moneda: linea.moneda ?? 'USD',
    };
    extrasFinal.push(linea);
  }
  extrasFinal.push(...extrasPropios);
  const ajuste = simples.get('AJUSTE');
  if (ajuste) ajuste.concepto = ajuste.monto_usd < 0 ? 'Descuento' : 'Redondeo';
  const ivaLinea = simples.get('IVA');
  if (ivaLinea) {
    ivaLinea.operacion = {
      tipo: 'IVA',
      pct: ivaPctOk && ivaPcts.size === 1 ? [...ivaPcts][0] : null,
      base_usd: ivaBase,
    };
  }
  const pernocta = simples.get('PERNOCTA');
  if (pernocta && pernoctaParadas > 0) {
    pernocta.operacion = {
      tipo: 'PERNOCTA',
      paradas: pernoctaParadas,
      unitario_usd:
        pernoctaUnitarios.size === 1 ? [...pernoctaUnitarios][0] : null,
    };
  }

  const tuasUsd = round2(tuasLineasFinal.reduce((a, l) => a + l.monto_usd, 0));
  const extrasUsd = round2(extrasFinal.reduce((a, l) => a + l.monto_usd, 0));
  const comision = simples.get('COMISION_VENDEDOR');
  if (ajuste) {
    ajuste.operacion = {
      tipo: 'AJUSTE',
      base_usd: round2(
        tiempo.monto_usd + tuasUsd + extrasUsd + (comision?.monto_usd ?? 0),
      ),
    };
  }

  const desglose: LineaConsolidada[] = [
    ...(vivos.length > 0 ? [tiempo] : []),
    ...tuasLineasFinal,
    ...extrasFinal,
    ...(comision ? [comision] : []),
    ...(ajuste && ajuste.monto_usd !== 0 ? [ajuste] : []),
    ...(ivaLinea ? [ivaLinea] : []),
    ...(pernocta ? [pernocta] : []),
  ].filter((l) => l.monto_usd !== 0 || l.clave === 'TIEMPO_VUELO');

  const suma = round2(desglose.reduce((acc, l) => acc + l.monto_usd, 0));
  return {
    aviones: vivos.length,
    desglose,
    subtotal_aereo_usd: tiempo.monto_usd,
    tuas_usd: tuasUsd,
    extras_usd: extrasUsd,
    pernocta_usd: pernocta?.monto_usd ?? 0,
    comision_vendedor_usd: comision?.monto_usd ?? 0,
    ajuste_usd: ajuste?.monto_usd ?? 0,
    iva_usd: ivaLinea?.monto_usd ?? 0,
    total_usd: totalUsd,
    total_mxn: vivos.length === 0 ? null : totalMxn,
    por_persona_usd: paxTotal > 0 ? round2(totalUsd / paxTotal) : null,
    por_persona:
      paxTotal > 0 ? { total_usd: totalUsd, pasajeros_total: paxTotal } : null,
    tuas: {
      total_usd: tuasUsd,
      total_mxn_nativo: tuasMxnNativo,
      aeropuertos: tuasAeropuertos,
    },
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
  /**
   * SOBRE (4-sep-2026, Fase 2): un sobre de cobro del grupo no cuadra con sus
   * partes o tiene partes en hijos cancelados — lo produce
   * `diagnosticoSobres` (particion-cobro.util), misma lista que el resto.
   */
  tipo: 'PAX' | 'PRECIO_DESACTUALIZADO' | 'EXTRAS' | 'SOBRE';
  detalle: string;
  folio?: number | null;
  posicion?: number | null;
  /** Solo tipo SOBRE: el cobro_grupo afectado y su cuadre. */
  sobre_id?: string | null;
  monto?: number | null;
  suma_partes?: number | null;
  partes_en_cancelados?: number | null;
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
