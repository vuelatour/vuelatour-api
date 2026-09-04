/**
 * Capacidad de asientos por TRAMO — helper PURO (fuente única, 4-sep-2026,
 * base de la cotización de grupo).
 *
 * Regla: en un tramo NO-ferry y NO-cancelado, los pasajeros del tramo no
 * pueden exceder los asientos del avión que lo vuela. El avión del tramo se
 * resuelve CON HERENCIA (`escala.aeronave_id ?? vuelo.aeronave_id`, misma
 * regla que tacos/participación). Un avión sin `asientos` en catálogo (null
 * o 0) NUNCA bloquea: no hay dato contra el cual comparar.
 *
 * Quién lo usa:
 * - `quotes.create/revise` (vuelos propios): 409 estructurado
 *   `CAPACIDAD_EXCEDIDA` (`conflictoCapacidad`).
 * - `flights.assign/assignEscala`: AVISO (`avisosCapacidad`), sin bloquear —
 *   la operación manda y la oficina decide.
 */

export interface EscalaCapacidadInput {
  orden: number;
  origen_iata?: string | null;
  destino_iata?: string | null;
  /** Avión del tramo (null = hereda el del vuelo). */
  aeronave_id?: string | null;
  /** Pax del tramo (null = usa `paxDefault`, el global del vuelo). */
  pasajeros?: number | null;
  es_ferry?: boolean | null;
  cancelada_at?: string | null;
}

export interface AsientosAvion {
  matricula?: string | null;
  asientos?: number | string | null;
}

export interface ExcesoCapacidad {
  orden: number;
  origen_iata: string | null;
  destino_iata: string | null;
  aeronave_id: string;
  matricula: string | null;
  pax: number;
  asientos: number;
}

/**
 * Tramos cuyo pax excede los asientos del avión que los vuela. Lista vacía
 * = todo cabe. Orden de salida = orden de los tramos.
 */
export function excesoDeCapacidad(
  escalas: EscalaCapacidadInput[],
  asientosPorAvion:
    | ReadonlyMap<string, AsientosAvion>
    | Record<string, AsientosAvion>,
  opts: { aeronaveVueloId?: string | null; paxDefault?: number | null } = {},
): ExcesoCapacidad[] {
  const fichas: ReadonlyMap<string, AsientosAvion> =
    asientosPorAvion instanceof Map
      ? (asientosPorAvion as ReadonlyMap<string, AsientosAvion>)
      : new Map(
          Object.entries(asientosPorAvion as Record<string, AsientosAvion>),
        );
  const lookup = (id: string): AsientosAvion | undefined => fichas.get(id);
  const out: ExcesoCapacidad[] = [];
  for (const e of [...escalas].sort((a, b) => a.orden - b.orden)) {
    if (e.cancelada_at) continue;
    if (e.es_ferry === true) continue;
    const avion = e.aeronave_id ?? opts.aeronaveVueloId ?? null;
    if (!avion) continue;
    const pax = Number(e.pasajeros ?? opts.paxDefault ?? 0) || 0;
    if (pax <= 0) continue;
    const ficha = lookup(avion);
    const asientos = Number(ficha?.asientos);
    if (!Number.isFinite(asientos) || asientos <= 0) continue;
    if (pax > asientos) {
      out.push({
        orden: e.orden,
        origen_iata: e.origen_iata ?? null,
        destino_iata: e.destino_iata ?? null,
        aeronave_id: avion,
        matricula: ficha?.matricula ?? null,
        pax,
        asientos,
      });
    }
  }
  return out;
}

export interface ConflictoCapacidad {
  message: string;
  error: 'CAPACIDAD_EXCEDIDA';
  details: {
    aeronave_id: string;
    matricula: string | null;
    asientos: number;
    pax: number;
    tramos: ExcesoCapacidad[];
  };
}

function tramoTxt(x: ExcesoCapacidad): string {
  return x.origen_iata && x.destino_iata
    ? `${x.origen_iata} → ${x.destino_iata}`
    : `tramo ${x.orden}`;
}

/**
 * Cuerpo del 409 estructurado (misma forma que SQUAWK_ALTA_SIN_RESOLVER:
 * `error` + `details` para que el panel lo reconozca). La cabecera lleva el
 * PEOR exceso (mayor pax − asientos); `tramos` trae todos. null sin excesos.
 */
export function conflictoCapacidad(
  excesos: ExcesoCapacidad[],
): ConflictoCapacidad | null {
  if (excesos.length === 0) return null;
  const peor = [...excesos].sort(
    (a, b) => b.pax - b.asientos - (a.pax - a.asientos),
  )[0];
  const lista = excesos
    .map(
      (x) =>
        `${tramoTxt(x)}: ${x.pax} pax en ${x.matricula ?? 'el avión'} (${x.asientos} asientos)`,
    )
    .join('; ');
  return {
    message: `Los pasajeros exceden los asientos del avión — ${lista}. Reparte los pasajeros en otro avión (cotización de grupo) o reduce el pax del tramo.`,
    error: 'CAPACIDAD_EXCEDIDA',
    details: {
      aeronave_id: peor.aeronave_id,
      matricula: peor.matricula,
      asientos: peor.asientos,
      pax: peor.pax,
      tramos: excesos,
    },
  };
}

/** Avisos legibles (uno por tramo) para respuestas que NO bloquean. */
export function avisosCapacidad(excesos: ExcesoCapacidad[]): string[] {
  return excesos.map(
    (x) =>
      `Capacidad: ${tramoTxt(x)} lleva ${x.pax} pax y ${x.matricula ?? 'el avión'} tiene ${x.asientos} asientos.`,
  );
}
