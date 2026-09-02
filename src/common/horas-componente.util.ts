/**
 * Aritmética ÚNICA de horas derivadas del tacómetro (invariante 1 del repo):
 *
 *   horas vivas de un componente = horas_totales + (hobbs − aeronave_horas_ref)
 *   tiempo del planeador        = planeador_horas_base + (hobbs − planeador_taco_ref)
 *
 * `recortar: true` es el "hoy" del panel y las alertas (componenteEstado,
 * tiempoTotalPlaneador): un delta negativo se recorta a 0 — una referencia
 * anclada por arriba del taco actual jamás RESTA vida al componente.
 * `recortar: false` es la bitácora impresa: reconstruye renglones ANTERIORES
 * a la referencia (taco 100.0 con base 5226.1 anclada en 151.9 ⇒ 5174.2).
 *
 * Todo lector de "horas de motor/hélice/planeador" pasa por aquí; no
 * reescribir la resta en otro lado.
 */

export interface OpcionesHorasDerivadas {
  /** true ⇒ delta negativo se vuelve 0 (estado actual); false ⇒ histórico. */
  recortar: boolean;
}

export interface ComponenteConBase {
  horas_totales?: unknown;
  aeronave_horas_ref?: unknown;
}

export interface AeronaveConBasePlaneador {
  planeador_horas_base?: unknown;
  planeador_taco_ref?: unknown;
}

const r1 = (x: number): number => Number(x.toFixed(1));

/** Horas voladas desde que el tacómetro marcaba `ref` (sin ref ⇒ 0). */
export function deltaDesdeReferencia(
  hobbs: number,
  ref: number | null,
  opts: OpcionesHorasDerivadas,
): number {
  if (ref == null) return 0;
  const delta = hobbs - ref;
  return opts.recortar ? Math.max(0, delta) : delta;
}

/**
 * Horas vivas de un motor/hélice a un tacómetro dado. Devuelve también el
 * delta porque el TSO (tso_base + delta) usa el mismo desplazamiento.
 */
export function horasVivasComponente(
  c: ComponenteConBase,
  hobbs: number,
  opts: OpcionesHorasDerivadas,
): { delta: number; horas: number } {
  const ht = Number(c.horas_totales ?? 0);
  const ref =
    c.aeronave_horas_ref != null ? Number(c.aeronave_horas_ref) : null;
  const delta = deltaDesdeReferencia(hobbs, ref, opts);
  return { delta, horas: r1(ht + delta) };
}

/**
 * Tiempo total del planeador (célula) a un tacómetro dado. Con base/ref en
 * 0 equivale al tacómetro (comportamiento histórico del avión sin ficha).
 */
export function tiempoPlaneador(
  aeronave: AeronaveConBasePlaneador,
  hobbs: number,
  opts: OpcionesHorasDerivadas,
): number {
  const base = Number(aeronave.planeador_horas_base ?? 0);
  const ref = Number(aeronave.planeador_taco_ref ?? 0);
  return r1(base + deltaDesdeReferencia(hobbs, ref, opts));
}
