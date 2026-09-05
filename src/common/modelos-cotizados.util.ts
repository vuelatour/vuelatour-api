/**
 * MODELO(S) del avión COTIZADO — fuente única para el PDF de cotización y
 * el detalle del panel (feedback del cliente 4-sep-2026): el cliente debe
 * ver el TIPO de avión que se le cotizó (Seneca, Kodiak, Meridian…), NUNCA
 * la matrícula, porque a veces se cotiza en un avión y la ruta operativa va
 * en otro. Con tramos en aviones distintos se listan los modelos distintos.
 *
 * Reglas (presentación pura; no toca precio ni asignación):
 * - Vuelo cubierto por EXTERNO: solo `avion_externo_modelo` (el avión del
 *   snapshot es la REFERENCIA de tarifa y el cliente no debe verla).
 * - Tramos VIVOS y COMERCIALES (no cancelados, no `solo_operativa`, no
 *   ferry — mismo criterio que la participación por avión) con avión
 *   resuelto CON HERENCIA (`escala.aeronave_id ?? vuelo.aeronave_id`). Si
 *   participan ≥ 2 aviones distintos → sus modelos en orden de tramo, sin
 *   repetir (modelos iguales se colapsan).
 * - Un solo avión (o sin tramos): el modelo del SNAPSHOT (avión con el que
 *   se PACTÓ el precio); sin snapshot, el del avión del vuelo.
 */

export interface VueloModelosInput {
  aeronave_id?: string | null;
  es_externo?: boolean | null;
  avion_externo_modelo?: string | null;
  calculo_snapshot?: unknown;
}

export interface EscalaModelosInput {
  aeronave_id?: string | null;
  cancelada_at?: string | null;
  solo_operativa?: boolean | null;
  es_ferry?: boolean | null;
}

function limpio(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** Modelo del avión del snapshot (avión COTIZADO), o null. */
export function modeloCotizadoDe(v: VueloModelosInput): string | null {
  if (v.es_externo === true) return limpio(v.avion_externo_modelo);
  const snap = v.calculo_snapshot as
    | { aeronave?: { modelo?: unknown } | null }
    | null
    | undefined;
  return limpio(snap?.aeronave?.modelo);
}

/** Ids de aviones distintos de los tramos vendidos, en orden de tramo. */
export function avionesDeTramos(
  v: VueloModelosInput,
  escalas: EscalaModelosInput[] | null | undefined,
): string[] {
  const vivas = (escalas ?? []).filter((e) => e.cancelada_at == null);
  const comerciales = vivas.filter(
    (e) => e.solo_operativa !== true && e.es_ferry !== true,
  );
  const base = comerciales.length > 0 ? comerciales : vivas;
  const out: string[] = [];
  for (const e of base) {
    const id = e.aeronave_id ?? v.aeronave_id ?? null;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Modelos distintos a mostrar al cliente (ver cabecera). `modeloPorId`
 * resuelve el modelo de cada avión de los tramos; un id sin modelo se omite.
 */
export function modelosCotizados(
  v: VueloModelosInput,
  escalas: EscalaModelosInput[] | null | undefined,
  modeloPorId: ReadonlyMap<string, string | null | undefined>,
): string[] {
  if (v.es_externo === true) {
    const m = limpio(v.avion_externo_modelo);
    return m ? [m] : [];
  }
  const ids = avionesDeTramos(v, escalas);
  const out: string[] = [];
  const vistos = new Set<string>();
  const agregar = (m: string | null) => {
    if (!m) return;
    const k = m.toLowerCase();
    if (vistos.has(k)) return;
    vistos.add(k);
    out.push(m);
  };
  if (ids.length >= 2) {
    for (const id of ids) agregar(limpio(modeloPorId.get(id)));
    if (out.length > 0) return out;
  }
  agregar(modeloCotizadoDe(v));
  if (out.length === 0) {
    const unico = ids[0] ?? v.aeronave_id ?? null;
    if (unico) agregar(limpio(modeloPorId.get(unico)));
  }
  return out;
}
