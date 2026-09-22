/**
 * FUENTE ÚNICA de «¿quién registró este cobro?» (22-sep-2026, pedido del
 * cliente: «sería buenísimo si se pudiera ver ahí en la lista de cobros de un
 * vuelo quién registró el cobro»).
 *
 * El dato SIEMPRE estuvo en la base (`cobro_vuelo.registrado_por` y
 * `cobro_grupo.registrado_por`, FK a `usuario.id`), pero viaja como uuid y
 * nadie lo traducía. Este helper lo resuelve a NOMBRE y lo expone como el
 * campo **ADITIVO** `registrado_por_nombre`.
 *
 * Reglas (las tres son contrato, no detalles):
 *
 * 1. **En LOTE, una consulta por respuesta.** `adjuntarNombreRegistrado`
 *    recoge los ids DISTINTOS de toda la lista y hace UN `select ... in (...)`.
 *    Jamás una consulta por cobro: la card del vuelo pinta 10–20 filas y el
 *    detalle del grupo varias decenas.
 * 2. **Nunca un nombre inventado.** Usuario borrado, id que no resuelve,
 *    `nombre` vacío o un fallo de lectura ⇒ `registrado_por_nombre: null`.
 *    El panel ya sabe no pintar nada con `null` (helper `textoRegistroCobro`).
 * 3. **ADITIVO de verdad.** Solo AÑADE la llave; el resto del objeto queda
 *    idéntico (mismo orden, mismos tipos). En particular la fila sigue siendo
 *    un `CobroLike` válido para `cobrosEnUsd` (invariante 2), para el recibo
 *    PDF y para el CFDI, que ignoran las llaves que no conocen. Por eso el
 *    nombre NO se resuelve con un embed dentro de `COBRO_COLS`: un embed
 *    cambiaría la forma de la fila para TODOS esos lectores.
 *
 * Lectura, además, TOLERANTE: si `usuario` no se puede leer, se devuelve el
 * mapa vacío (todos `null`) en vez de tumbar la lista de cobros — el dinero
 * de la card vale más que la cortesía de un nombre.
 */
import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

const logger = new Logger('RegistradoPor');

/** Columnas mínimas para resolver el nombre de quien registró. */
export const USUARIO_NOMBRE_COLS = 'id, nombre';

/** Fila con la FK `registrado_por` (cobro de vuelo o sobre de grupo). */
export interface ConRegistradoPor {
  registrado_por?: unknown;
}

/** El mismo objeto + el campo aditivo ya resuelto. */
export type ConNombreRegistrado<T> = T & { registrado_por_nombre: string | null };

function idStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Nombre presentable o null (un string vacío/blanco NO es un nombre). */
function nombreStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const limpio = v.trim().replace(/\s+/g, ' ');
  return limpio.length > 0 ? limpio : null;
}

/** Ids DISTINTOS de `registrado_por` presentes en la lista (sin nulls). */
export function idsRegistradoPor(
  filas: ReadonlyArray<ConRegistradoPor>,
): string[] {
  const ids = new Set<string>();
  for (const f of filas) {
    const id = idStr(f.registrado_por);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Mapa `usuario_id → nombre` de esos ids, en UNA consulta. Ids repetidos o
 * vacíos se ignoran; lista vacía ⇒ ni una consulta. Un error de lectura se
 * registra y devuelve el mapa vacío (todos saldrán como `null`).
 */
export async function fetchNombresUsuarios(
  sb: SupabaseClient,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const unicos = [...new Set(ids.map(idStr).filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (unicos.length === 0) return out;
  // NUNCA lanza: el nombre es cortesía, la lista de cobros es dinero. El
  // try/catch cubre lo que `error` no alcanza (un rechazo del cliente antes
  // de que PostgREST conteste): sin él, `Promise.all` de `adjuntarSobres`
  // tumbaría el snapshot entero del vuelo por no poder pintar un nombre.
  try {
    const { data, error } = await sb
      .from('usuario')
      .select(USUARIO_NOMBRE_COLS)
      .in('id', unicos);
    if (error) {
      logger.warn(
        `No se pudieron resolver ${unicos.length} nombre(s) de usuario: ${error.message}. Los cobros saldrán con registrado_por_nombre = null.`,
      );
      return out;
    }
    for (const u of (data ?? []) as Array<Record<string, unknown>>) {
      const id = idStr(u.id);
      const nombre = nombreStr(u.nombre);
      if (id && nombre) out.set(id, nombre);
    }
  } catch (err) {
    logger.warn(
      `Falló la lectura de ${unicos.length} nombre(s) de usuario: ${err instanceof Error ? err.message : String(err)}. Los cobros saldrán con registrado_por_nombre = null.`,
    );
    return new Map<string, string>();
  }
  return out;
}

/**
 * Pega `registrado_por_nombre` a cada fila con un mapa YA resuelto (para
 * quien lee los nombres junto con otros: el PDF interno, por ejemplo).
 * Función PURA: no consulta nada.
 */
export function conNombreRegistrado<T extends ConRegistradoPor>(
  filas: ReadonlyArray<T>,
  nombres: ReadonlyMap<string, string>,
): Array<ConNombreRegistrado<T>> {
  return filas.map((f) => {
    const id = idStr(f.registrado_por);
    return {
      ...f,
      registrado_por_nombre: (id && nombres.get(id)) || null,
    };
  });
}

/**
 * Atajo de los dos de arriba: lee los nombres en UNA consulta y devuelve la
 * lista con el campo aditivo. Es el único camino que deberían usar los
 * lectores de cobros (lista del vuelo, sobres del grupo).
 */
export async function adjuntarNombreRegistrado<T extends ConRegistradoPor>(
  sb: SupabaseClient,
  filas: ReadonlyArray<T>,
): Promise<Array<ConNombreRegistrado<T>>> {
  if (filas.length === 0) return [];
  const nombres = await fetchNombresUsuarios(sb, idsRegistradoPor(filas));
  return conNombreRegistrado(filas, nombres);
}
