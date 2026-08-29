import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Tripulación por TRAMO (29-ago-2026) — fuente única de "quién va en el
 * vuelo" y "quién va en cada tramo":
 *
 *  · Piloto del tramo: `escala.piloto_id ?? vuelo.piloto_id` (herencia).
 *  · Copiloto del tramo: `escala.copiloto_id ?? vuelo.copiloto_id` (misma
 *    disciplina de herencia que el piloto).
 *  · Apoyos: tabla `vuelo_apoyo` (0..N). `escala_id` null = apoyo de TODO el
 *    vuelo; con valor = apoyo solo de ese tramo. Apoyos efectivos de un
 *    tramo = los del vuelo ∪ los del tramo. `vuelo.apoyo_id` es SOLO el
 *    espejo del primer apoyo de nivel vuelo (lectores legados / app vieja):
 *    lo mantiene `syncApoyoEspejo` y nadie lo escribe por separado.
 *
 * Las funciones puras (sin BD) viven aquí para poder probarlas con jest;
 * flights/pilots/expenses/report las consumen en vez de recalcular a mano.
 */

export interface VueloApoyoRow {
  id?: string;
  vuelo_id?: string;
  escala_id: string | null;
  usuario_id: string;
  created_at?: string | null;
}

export interface EscalaTripulacionInput {
  id: string;
  piloto_id?: string | null;
  copiloto_id?: string | null;
  cancelada_at?: string | null;
}

export interface VueloTripulacionInput {
  piloto_id?: string | null;
  copiloto_id?: string | null;
  /** Espejo legado: solo se usa si `vuelo_apoyo` no tiene filas del vuelo. */
  apoyo_id?: string | null;
}

/** Relación del usuario actual con un vuelo (la app la pinta y gatea). */
export interface MiTripulacion {
  piloto: boolean;
  copiloto: boolean;
  apoyo: boolean;
  /** Ids de escala (tramos vivos) donde es piloto EFECTIVO (con herencia). */
  tramos_piloto: string[];
  /** Ids de escala (tramos vivos) donde es copiloto EFECTIVO (con herencia). */
  tramos_copiloto: string[];
  /** Ids de escala (tramos vivos) donde va de apoyo (del vuelo o del tramo). */
  tramos_apoyo: string[];
  /** ¿Tiene alguna relación con el vuelo? (acceso en la app / assertAccess). */
  es_tripulante: boolean;
  /** Regla: el apoyo NO captura tacómetros; piloto/copiloto (vuelo o tramo) sí. */
  puede_capturar_tacos: boolean;
}

export type OrigenApoyo = 'vuelo' | 'tramo';

const idStr = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

/** Piloto EFECTIVO de un tramo: el suyo o, si no tiene, el del vuelo. */
export function pilotoEfectivo(
  escala: { piloto_id?: unknown },
  vuelo: { piloto_id?: unknown } | null | undefined,
): string | null {
  return idStr(escala.piloto_id) ?? idStr(vuelo?.piloto_id);
}

/** Copiloto EFECTIVO de un tramo: el suyo o, si no tiene, el del vuelo. */
export function copilotoEfectivo(
  escala: { copiloto_id?: unknown },
  vuelo: { copiloto_id?: unknown } | null | undefined,
): string | null {
  return idStr(escala.copiloto_id) ?? idStr(vuelo?.copiloto_id);
}

/**
 * Apoyos de NIVEL VUELO (escala_id null) en orden de alta — el primero es el
 * espejo `vuelo.apoyo_id`. Sin duplicados.
 */
export function apoyosNivelVuelo(apoyos: VueloApoyoRow[]): string[] {
  const out: string[] = [];
  const filas = apoyos
    .filter((a) => a.escala_id == null)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  for (const a of filas) {
    if (a.usuario_id && !out.includes(a.usuario_id)) out.push(a.usuario_id);
  }
  return out;
}

/** Apoyos SOLO de ese tramo (escala_id = id), en orden de alta. */
export function apoyosDeTramo(
  escalaId: string,
  apoyos: VueloApoyoRow[],
): string[] {
  const out: string[] = [];
  const filas = apoyos
    .filter((a) => a.escala_id === escalaId)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  for (const a of filas) {
    if (a.usuario_id && !out.includes(a.usuario_id)) out.push(a.usuario_id);
  }
  return out;
}

/**
 * Apoyos EFECTIVOS de un tramo = los del vuelo ∪ los del tramo, con su
 * origen. Si alguien está en ambos, gana 'vuelo' (va en todo el viaje).
 */
export function apoyosEfectivosDeTramo(
  escalaId: string,
  apoyos: VueloApoyoRow[],
): Array<{ usuario_id: string; origen: OrigenApoyo }> {
  const out: Array<{ usuario_id: string; origen: OrigenApoyo }> = [];
  const vistos = new Set<string>();
  for (const uid of apoyosNivelVuelo(apoyos)) {
    vistos.add(uid);
    out.push({ usuario_id: uid, origen: 'vuelo' });
  }
  for (const uid of apoyosDeTramo(escalaId, apoyos)) {
    if (vistos.has(uid)) continue;
    vistos.add(uid);
    out.push({ usuario_id: uid, origen: 'tramo' });
  }
  return out;
}

/**
 * Relación de `userId` con el vuelo (función PURA; la BD la carga
 * `cargarTripulacion`). Reglas:
 *  - `piloto`/`copiloto`: a nivel vuelo.
 *  - `tramos_*`: por tramo VIVO con herencia (un tramo sin copiloto propio
 *    hereda el del vuelo, igual que el piloto).
 *  - `apoyo`: alguna fila en vuelo_apoyo (del vuelo o de cualquier tramo);
 *    tolera el espejo legado `vuelo.apoyo_id` si la tabla no tiene filas.
 *  - `es_tripulante`: cualquier relación, incluidas asignaciones EXPLÍCITAS
 *    en tramos cancelados (histórico: sigue viendo el vuelo).
 *  - `puede_capturar_tacos`: piloto o copiloto del vuelo o de algún tramo
 *    (también explícito en un tramo cancelado: el server nunca restringió la
 *    captura por tramo, es el mismo criterio de assertPuedeCapturarTaco de
 *    antes). Ir de apoyo NUNCA da el permiso, pero tampoco lo quita a quien
 *    además vuela.
 */
export function miTripulacion(
  userId: string,
  vuelo: VueloTripulacionInput | null | undefined,
  escalas: EscalaTripulacionInput[],
  apoyos: VueloApoyoRow[],
): MiTripulacion {
  const piloto = idStr(vuelo?.piloto_id) === userId;
  const copiloto = idStr(vuelo?.copiloto_id) === userId;
  const vivas = escalas.filter((e) => e.cancelada_at == null);
  const tramos_piloto = vivas
    .filter((e) => pilotoEfectivo(e, vuelo) === userId)
    .map((e) => e.id);
  const tramos_copiloto = vivas
    .filter((e) => copilotoEfectivo(e, vuelo) === userId)
    .map((e) => e.id);
  const hayFilasVuelo = apoyos.some((a) => a.escala_id == null);
  const apoyoVuelo = hayFilasVuelo
    ? apoyos.some((a) => a.escala_id == null && a.usuario_id === userId)
    : idStr(vuelo?.apoyo_id) === userId;
  const tramosApoyoExplicito = new Set(
    apoyos
      .filter((a) => a.escala_id != null && a.usuario_id === userId)
      .map((a) => a.escala_id as string),
  );
  const tramos_apoyo = vivas
    .filter((e) => apoyoVuelo || tramosApoyoExplicito.has(e.id))
    .map((e) => e.id);
  const apoyo = apoyoVuelo || tramosApoyoExplicito.size > 0;
  const explicitoEnTramo = escalas.some(
    (e) => idStr(e.piloto_id) === userId || idStr(e.copiloto_id) === userId,
  );
  const puede_capturar_tacos =
    piloto ||
    copiloto ||
    tramos_piloto.length > 0 ||
    tramos_copiloto.length > 0 ||
    explicitoEnTramo;
  const es_tripulante = puede_capturar_tacos || apoyo;
  return {
    piloto,
    copiloto,
    apoyo,
    tramos_piloto,
    tramos_copiloto,
    tramos_apoyo,
    es_tripulante,
    puede_capturar_tacos,
  };
}

/** Todas las filas de `vuelo_apoyo` de un vuelo (nivel vuelo y por tramo). */
export async function apoyosDeVuelo(
  sb: SupabaseClient,
  vueloId: string,
): Promise<VueloApoyoRow[]> {
  const { data, error } = await sb
    .from('vuelo_apoyo')
    .select('id, vuelo_id, escala_id, usuario_id, created_at')
    .eq('vuelo_id', vueloId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Filas de `vuelo_apoyo` de VARIOS vuelos en una consulta (listados). */
export async function apoyosDeVuelos(
  sb: SupabaseClient,
  vueloIds: string[],
): Promise<Map<string, VueloApoyoRow[]>> {
  const out = new Map<string, VueloApoyoRow[]>();
  const ids = [...new Set(vueloIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await sb
    .from('vuelo_apoyo')
    .select('id, vuelo_id, escala_id, usuario_id, created_at')
    .in('vuelo_id', ids)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as VueloApoyoRow[]) {
    const vid = row.vuelo_id as string;
    const lista = out.get(vid) ?? [];
    lista.push(row);
    out.set(vid, lista);
  }
  return out;
}

/**
 * Mantiene `vuelo.apoyo_id` = PRIMER apoyo de nivel vuelo (o null). Es el
 * único escritor de esa columna desde el 29-ago-2026; TODA escritura en
 * `vuelo_apoyo` termina aquí. Devuelve el valor espejado.
 */
export async function syncApoyoEspejo(
  sb: SupabaseClient,
  vueloId: string,
): Promise<string | null> {
  const { data: filas, error } = await sb
    .from('vuelo_apoyo')
    .select('usuario_id, created_at')
    .eq('vuelo_id', vueloId)
    .is('escala_id', null)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const espejo = ((filas ?? [])[0]?.usuario_id as string | undefined) ?? null;
  const { data: vuelo } = await sb
    .from('vuelo')
    .select('apoyo_id')
    .eq('id', vueloId)
    .maybeSingle();
  if (!vuelo) return espejo;
  if ((vuelo.apoyo_id as string | null) === espejo) return espejo;
  const { error: upErr } = await sb
    .from('vuelo')
    .update({ apoyo_id: espejo })
    .eq('id', vueloId);
  if (upErr) throw new Error(upErr.message);
  return espejo;
}

/**
 * REEMPLAZA la lista de apoyos de un nivel (vuelo: `escalaId` null; tramo:
 * `escalaId` con valor) escribiendo SOLO la diferencia — así las altas y
 * bajas que devuelve son exactamente a quién avisar. Termina sincronizando
 * el espejo `vuelo.apoyo_id`.
 */
export async function reemplazarApoyos(
  sb: SupabaseClient,
  args: {
    vueloId: string;
    escalaId: string | null;
    usuarioIds: string[];
    createdBy?: string | null;
  },
): Promise<{ altas: string[]; bajas: string[]; actuales: string[] }> {
  const objetivo = [...new Set(args.usuarioIds.filter(Boolean))];
  let q = sb
    .from('vuelo_apoyo')
    .select('id, usuario_id')
    .eq('vuelo_id', args.vueloId);
  q = args.escalaId
    ? q.eq('escala_id', args.escalaId)
    : q.is('escala_id', null);
  const { data: actuales, error } = await q;
  if (error) throw new Error(error.message);
  const actualesIds = (actuales ?? []).map((a) => a.usuario_id as string);
  const bajas = actualesIds.filter((uid) => !objetivo.includes(uid));
  const altas = objetivo.filter((uid) => !actualesIds.includes(uid));
  if (bajas.length > 0) {
    const filasBaja = (actuales ?? [])
      .filter((a) => bajas.includes(a.usuario_id as string))
      .map((a) => a.id as string);
    const { error: delErr } = await sb
      .from('vuelo_apoyo')
      .delete()
      .in('id', filasBaja);
    if (delErr) throw new Error(delErr.message);
  }
  if (altas.length > 0) {
    const { error: insErr } = await sb.from('vuelo_apoyo').insert(
      altas.map((uid) => ({
        vuelo_id: args.vueloId,
        escala_id: args.escalaId,
        usuario_id: uid,
        created_by: args.createdBy ?? null,
      })),
    );
    // 23505 = carrera con otra escritura idéntica: el estado final es el
    // mismo, no se rompe la operación.
    if (insErr && insErr.code !== '23505') throw new Error(insErr.message);
  }
  await syncApoyoEspejo(sb, args.vueloId);
  return { altas, bajas, actuales: objetivo };
}

/**
 * Copia la tripulación de apoyo de un vuelo a su CLON (reasignación de
 * aeronave): los apoyos de nivel vuelo tal cual y los de cada tramo al
 * tramo del clon con el mismo `orden`. Termina sincronizando el espejo.
 */
export async function clonarApoyos(
  sb: SupabaseClient,
  args: {
    origenId: string;
    clonId: string;
    /** orden → id de escala del ORIGEN */
    escalasOrigen: Map<number, string>;
    /** orden → id de escala del CLON */
    escalasClon: Map<number, string>;
    createdBy?: string | null;
  },
): Promise<void> {
  const filas = await apoyosDeVuelo(sb, args.origenId);
  if (filas.length === 0) {
    await syncApoyoEspejo(sb, args.clonId);
    return;
  }
  const idPorOrdenOrigen = new Map<string, number>();
  for (const [orden, id] of args.escalasOrigen) idPorOrdenOrigen.set(id, orden);
  const nuevas: Array<Record<string, unknown>> = [];
  for (const f of filas) {
    let escalaId: string | null = null;
    if (f.escala_id) {
      const orden = idPorOrdenOrigen.get(f.escala_id);
      escalaId = orden != null ? (args.escalasClon.get(orden) ?? null) : null;
      // Tramo que no existe en el clon: el apoyo de ese tramo no viaja.
      if (!escalaId) continue;
    }
    nuevas.push({
      vuelo_id: args.clonId,
      escala_id: escalaId,
      usuario_id: f.usuario_id,
      created_by: args.createdBy ?? null,
    });
  }
  if (nuevas.length > 0) {
    const { error } = await sb.from('vuelo_apoyo').insert(nuevas);
    if (error && error.code !== '23505') throw new Error(error.message);
  }
  await syncApoyoEspejo(sb, args.clonId);
}

/**
 * Carga lo necesario para `miTripulacion` desde la BD: vuelo (piloto,
 * copiloto, espejo), escalas (id, piloto, copiloto, cancelación) y filas de
 * `vuelo_apoyo`. Lanza NotFound-like (null) si el vuelo no existe.
 */
export async function cargarTripulacion(
  sb: SupabaseClient,
  vueloId: string,
): Promise<{
  vuelo: VueloTripulacionInput;
  escalas: EscalaTripulacionInput[];
  apoyos: VueloApoyoRow[];
} | null> {
  const [{ data: vuelo, error: vErr }, { data: escalas, error: eErr }, apoyos] =
    await Promise.all([
      sb
        .from('vuelo')
        .select('piloto_id, copiloto_id, apoyo_id')
        .eq('id', vueloId)
        .maybeSingle(),
      sb
        .from('escala')
        .select('id, piloto_id, copiloto_id, cancelada_at')
        .eq('vuelo_id', vueloId),
      apoyosDeVuelo(sb, vueloId),
    ]);
  if (vErr) throw new Error(vErr.message);
  if (eErr) throw new Error(eErr.message);
  if (!vuelo) return null;
  return {
    vuelo: vuelo,
    escalas: escalas ?? [],
    apoyos,
  };
}

/**
 * Tripulación EFECTIVA de un vuelo (auditoría de notificaciones, 21-ago-2026;
 * ampliada 29-ago con copiloto por tramo y apoyos 0..N): piloto, copiloto y
 * apoyo(s) del vuelo + pilotos/copilotos explícitos de los tramos vivos +
 * apoyos de los tramos vivos. FUENTE ÚNICA para "¿a quién le avisamos?" —
 * la usan flights.service y quotes.service (evita dependencia circular entre
 * módulos). Los pilotos externos los filtra notifications.notifyUser (sin
 * acceso al sistema).
 */
export async function tripulacionDeVuelo(
  sb: SupabaseClient,
  vueloId: string,
  vuelo?: Record<string, unknown> | null,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let v = vuelo ?? null;
  if (!v) {
    const { data } = await sb
      .from('vuelo')
      .select('piloto_id, copiloto_id, apoyo_id')
      .eq('id', vueloId)
      .maybeSingle();
    v = data ?? null;
  }
  for (const k of ['piloto_id', 'copiloto_id', 'apoyo_id']) {
    const id = (v?.[k] as string | null | undefined) ?? null;
    if (id) ids.add(id);
  }
  const [{ data: escalas }, apoyos] = await Promise.all([
    sb
      .from('escala')
      .select('id, piloto_id, copiloto_id')
      .eq('vuelo_id', vueloId)
      .is('cancelada_at', null),
    apoyosDeVuelo(sb, vueloId).catch(() => [] as VueloApoyoRow[]),
  ]);
  const vivas = new Set<string>();
  for (const e of escalas ?? []) {
    vivas.add(e.id as string);
    if (e.piloto_id) ids.add(e.piloto_id as string);
    if (e.copiloto_id) ids.add(e.copiloto_id as string);
  }
  for (const a of apoyos) {
    if (a.escala_id == null || vivas.has(a.escala_id)) ids.add(a.usuario_id);
  }
  return ids;
}
