import type { VueloApoyoRow } from './tripulacion.util';

/**
 * Campos ADITIVOS de búsqueda para las listas de vuelos de la app
 * (5-sep-2026, pedido del cliente: «que se pueda buscar por piloto, alguien
 * de la tripulación, destino, fecha, cliente o pasajero»). El buscador de la
 * app filtra LOCALMENTE lo que ya cargó (sin llamadas por tecla), así que el
 * listado tiene que traer embebido todo lo que se busca: nombres de la
 * tripulación completa, manifiesto por tramo, notas de tramo, razón social,
 * modelo del avión. Todo lo de aquí es PURO (sin BD) para probarlo con jest;
 * `flights.service.list` lo alimenta con las consultas por lote que ya hacía
 * (escala, vuelo_apoyo, usuario) — cero consultas nuevas, cero N+1.
 *
 * Contrato (todo opcional para clientes viejos; nada existente cambia):
 *  · `ruta_iatas`              — igual que antes (origen del 1er tramo +
 *                                destino de cada tramo, ferry y cancelados
 *                                incluidos: es la ruta OPERATIVA histórica).
 *  · `pasajeros_nombres_tramos`— unión sin duplicados de `escala.pasajeros_nombres`
 *                                de TODOS los tramos (cancelados incluidos: el
 *                                pasajero sigue ligado al vuelo como historial,
 *                                igual que `ruta_iatas`).
 *  · `notas_tramos`            — `escala.notas` no vacías, en orden de tramo.
 *  · `tripulacion_nombres`     — únicos de piloto, copiloto, apoyos (vuelo y
 *                                tramo) y piloto/copiloto EXPLÍCITOS de tramo.
 *  · `apoyos_tramo`            — [{ id, nombre, rol, escala_id }] (las filas de
 *                                `vuelo_apoyo` con escala_id); `apoyos` (nivel
 *                                vuelo, contrato 29-ago) no cambia.
 */

export interface EscalaResumenRow {
  vuelo_id: string;
  orden: number;
  origen_iata: string | null;
  destino_iata: string | null;
  /** Explícito del tramo (null = hereda del vuelo; NO se resuelve aquí). */
  piloto_id?: string | null;
  copiloto_id?: string | null;
  /** jsonb: array de strings en BD; se tolera cualquier forma. */
  pasajeros_nombres?: unknown;
  notas?: string | null;
  cancelada_at?: string | null;
}

export interface ResumenEscalas {
  ruta_iatas: string[];
  pasajeros_nombres_tramos: string[];
  notas_tramos: string[];
  /** Ids EXPLÍCITOS (sin herencia) de piloto de los tramos, sin repetir. */
  piloto_ids: string[];
  /** Ids EXPLÍCITOS (sin herencia) de copiloto de los tramos, sin repetir. */
  copiloto_ids: string[];
}

export interface ApoyoItem {
  id: string;
  nombre: string;
  rol: string | null;
}

export interface ApoyoTramoItem extends ApoyoItem {
  escala_id: string;
}

export type InfoUsuarios = Map<string, ApoyoItem>;

/** Nombre que pinta la app cuando el usuario ya no existe. */
export const NOMBRE_USUARIO_DESCONOCIDO = 'Usuario';

/**
 * Relación embebida de PostgREST: viene como objeto o como arreglo de uno
 * según la cardinalidad detectada; aquí siempre se lee como uno o null.
 */
export function unwrapRel<T>(rel: T | T[] | null | undefined): T | null {
  if (rel == null) return null;
  if (Array.isArray(rel)) return rel.length > 0 ? rel[0] : null;
  return rel;
}

/**
 * Textos únicos y limpios: recorta espacios, descarta vacíos/no-strings y
 * deduplica SIN distinguir mayúsculas ni espacios múltiples (se conserva la
 * primera forma escrita). Un jsonb mal formado (no arreglo) da [].
 */
export function nombresUnicos(
  ...listas: Array<Iterable<unknown> | null | undefined>
): string[] {
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const lista of listas) {
    if (lista == null || typeof lista === 'string') continue;
    for (const v of lista) {
      if (typeof v !== 'string') continue;
      const limpio = v.replace(/\s+/g, ' ').trim();
      if (!limpio) continue;
      const clave = limpio.toLocaleLowerCase('es-MX');
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      out.push(limpio);
    }
  }
  return out;
}

/** `escala.pasajeros_nombres` (jsonb) → strings limpios; no-arreglo → []. */
export function textosDeJson(valor: unknown): string[] {
  return Array.isArray(valor) ? nombresUnicos(valor) : [];
}

/**
 * Agrupa las escalas de un lote por vuelo y resume lo que buscan las listas.
 * El orden de tramo manda (se reordena por `orden` por si la consulta no lo
 * hizo). Vuelos sin escalas no aparecen en el mapa (el caller cae a
 * origen/destino del vuelo).
 */
export function resumirEscalasPorVuelo(
  rows: EscalaResumenRow[],
): Map<string, ResumenEscalas> {
  const porVuelo = new Map<string, EscalaResumenRow[]>();
  for (const e of rows) {
    if (!e?.vuelo_id) continue;
    const lista = porVuelo.get(e.vuelo_id) ?? [];
    lista.push(e);
    porVuelo.set(e.vuelo_id, lista);
  }
  const out = new Map<string, ResumenEscalas>();
  for (const [vid, legs] of porVuelo) {
    if (legs.length === 0) continue;
    const ordenadas = [...legs].sort((a, b) => a.orden - b.orden);
    const pasajeros = nombresUnicos(
      ...ordenadas.map((l) => textosDeJson(l.pasajeros_nombres)),
    );
    const notas = nombresUnicos(ordenadas.map((l) => l.notas ?? null));
    const pilotoIds = [
      ...new Set(
        ordenadas
          .map((l) => l.piloto_id)
          .filter((id): id is string => typeof id === 'string' && !!id),
      ),
    ];
    const copilotoIds = [
      ...new Set(
        ordenadas
          .map((l) => l.copiloto_id)
          .filter((id): id is string => typeof id === 'string' && !!id),
      ),
    ];
    out.set(vid, {
      ruta_iatas: [
        ordenadas[0].origen_iata as string,
        ...ordenadas.map((l) => l.destino_iata as string),
      ],
      pasajeros_nombres_tramos: pasajeros,
      notas_tramos: notas,
      piloto_ids: pilotoIds,
      copiloto_ids: copilotoIds,
    });
  }
  return out;
}

/** Item `{ id, nombre, rol }` con respaldo cuando el usuario ya no existe. */
export function apoyoItem(id: string, info: InfoUsuarios): ApoyoItem {
  return info.get(id) ?? { id, nombre: NOMBRE_USUARIO_DESCONOCIDO, rol: null };
}

/**
 * Apoyos de TRAMO (`vuelo_apoyo.escala_id` con valor) con nombre, en orden
 * de alta y sin repetir el mismo usuario en el mismo tramo. Los de nivel
 * vuelo NO entran (viven en `apoyos`, contrato 29-ago).
 */
export function apoyosTramoConNombre(
  filas: VueloApoyoRow[],
  info: InfoUsuarios,
): ApoyoTramoItem[] {
  const out: ApoyoTramoItem[] = [];
  const vistos = new Set<string>();
  const ordenadas = filas
    .filter((f) => f.escala_id != null && !!f.usuario_id)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  for (const f of ordenadas) {
    const clave = `${f.escala_id as string}|${f.usuario_id}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push({ ...apoyoItem(f.usuario_id, info), escala_id: f.escala_id! });
  }
  return out;
}

/**
 * Nombres de TODA la tripulación del vuelo para el buscador: piloto y
 * copiloto del vuelo, apoyos (vuelo y tramo) y piloto/copiloto explícitos de
 * tramo. Los ids sin usuario conocido se omiten (no se mete el respaldo
 * "Usuario" a la búsqueda). Únicos sin distinguir mayúsculas.
 */
export function tripulacionNombres(args: {
  piloto_nombre?: string | null;
  copiloto_nombre?: string | null;
  apoyoIds?: Iterable<string>;
  tramoIds?: Iterable<string>;
  info: InfoUsuarios;
}): string[] {
  const deIds = (ids: Iterable<string> | undefined): string[] =>
    [...(ids ?? [])].map((id) => args.info.get(id)?.nombre ?? '');
  return nombresUnicos(
    [args.piloto_nombre, args.copiloto_nombre],
    deIds(args.apoyoIds),
    deIds(args.tramoIds),
  );
}
