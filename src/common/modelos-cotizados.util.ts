/**
 * MODELO(S) del avión COTIZADO — fuente única para el PDF de cotización y
 * el detalle del panel (feedback del cliente 4-sep-2026): el cliente debe
 * ver el TIPO de avión que se le cotizó (Seneca, Kodiak, Meridian…), NUNCA
 * la matrícula, porque a veces se cotiza en un avión y la ruta operativa va
 * en otro. Con tramos en aviones distintos se listan los modelos distintos.
 *
 * LA COTIZACIÓN ES INDEPENDIENTE DE LA OPERACIÓN (cliente, 12-sep-2026,
 * cotización #298): «se cotiza con un avión y se vuela con otro por distintos
 * motivos, pero la cotización no debe verse afectada por cambios en el vuelo
 * operativo». Por eso la hoja/PDF del cliente muestran SOLO el modelo del
 * SNAPSHOT vigente. La rama vieja «≥ 2 aviones en los tramos ⇒ sus modelos»
 * colaba un dato OPERATIVO en la cotización: reasignar un tramo cambiaba el
 * avión impreso en la hoja sin que nadie tocara la cotización. Ahora esa
 * rama es solo RESPALDO cuando NO hay snapshot (reserva sin cotizar).
 *
 * Reglas (presentación pura; no toca precio ni asignación):
 * - Vuelo cubierto por EXTERNO: solo `avion_externo_modelo` (el avión del
 *   snapshot es la REFERENCIA de tarifa y el cliente no debe verla).
 * - Con SNAPSHOT: su modelo y nada más (el avión con el que se PACTÓ el
 *   precio), sin importar en qué avión(es) se esté volando hoy.
 * - RESPALDO sin snapshot: los tramos VIVOS y COMERCIALES (no cancelados, no
 *   `solo_operativa`, no ferry — mismo criterio que la participación por
 *   avión) con avión resuelto CON HERENCIA (`escala.aeronave_id ??
 *   vuelo.aeronave_id`), sus modelos en orden de tramo y sin repetir; sin
 *   tramos, el modelo del avión del vuelo.
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

/**
 * Ids de aviones distintos de los tramos vendidos, en orden de tramo. Es un
 * dato OPERATIVO: desde el 12-sep-2026 solo alimenta el RESPALDO de
 * `modelosCotizados` (vuelo sin snapshot), nunca la hoja de una cotización
 * ya calculada.
 */
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
 * Modelo(s) a mostrar al cliente (ver cabecera): el del SNAPSHOT vigente. Con
 * snapshot, `modeloPorId` ni se consulta; solo alimenta el RESPALDO de un
 * vuelo SIN snapshot (un id sin modelo se omite).
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
  const out: string[] = [];
  const vistos = new Set<string>();
  const agregar = (m: string | null) => {
    if (!m) return;
    const k = m.toLowerCase();
    if (vistos.has(k)) return;
    vistos.add(k);
    out.push(m);
  };
  // El COTIZADO manda y CIERRA: un cambio de avión en la operación no toca
  // lo que el cliente ve en su cotización (12-sep-2026).
  const cotizado = modeloCotizadoDe(v);
  if (cotizado) {
    agregar(cotizado);
    return out;
  }
  // RESPALDO (sin snapshot: reserva sin cotizar todavía).
  const ids = avionesDeTramos(v, escalas);
  for (const id of ids) agregar(limpio(modeloPorId.get(id)));
  if (out.length === 0 && v.aeronave_id) {
    agregar(limpio(modeloPorId.get(v.aeronave_id)));
  }
  return out;
}

/**
 * AVIONES REALMENTE UTILIZADOS (control interno, 11-sep-2026) — el espejo
 * operativo de `modelosCotizados`: qué avión vuela HOY el itinerario, sin
 * importar con cuál se PACTÓ el precio. La cotización puede haberse hecho en
 * un Seneca y la operación salir en un Cessna: el PDF del cliente sigue
 * mostrando el MODELO cotizado y la oficina necesita ver los dos datos
 * separados ("aeronave cotizada" vs "aeronave utilizada").
 *
 * Reglas: tramos VIVOS (no cancelados) en orden de tramo, con la herencia de
 * todo el sistema (`escala.aeronave_id ?? vuelo.aeronave_id`); a diferencia
 * de `avionesDeTramos` NO se filtran ferries ni tramos solo-operativos (un
 * ferry también lo voló un avión). Sin tramos vivos, el avión del vuelo.
 * Ids distintos, orden de aparición.
 */
export function avionesUtilizados(
  v: VueloModelosInput,
  escalas: EscalaModelosInput[] | null | undefined,
): string[] {
  const out: string[] = [];
  for (const e of escalas ?? []) {
    if (e.cancelada_at != null) continue;
    const id = e.aeronave_id ?? v.aeronave_id ?? null;
    if (id && !out.includes(id)) out.push(id);
  }
  if (out.length === 0 && v.aeronave_id) out.push(v.aeronave_id);
  return out;
}
