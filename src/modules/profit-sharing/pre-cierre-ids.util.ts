/**
 * PRE-CIERRE · «Resolver →» QUE MARCA EN ÁMBAR (15-oct-2026, API 0.0.81,
 * PEDIDO 2, invariante 81).
 *
 * Pedido del cliente: «el botón de Resolver estaría genial que te marque bien
 * lo que se debe resolver en amarillo, para poder saber dónde atacar». El
 * panel lleva «Resolver →» a la pantalla de siempre y resalta las filas cuyo
 * id viaja aquí. Los renglones que cuentan GASTOS o MOVIMIENTOS bancarios no
 * traían ningún id: ganan el campo ADITIVO `ids` (los MISMOS registros que
 * suman en `count`, en el orden en que se cuentan).
 *
 * Helper PURO (sin Supabase): el servicio le pasa la lista que YA cuenta;
 * aquí no se agrega ninguna consulta ni se cambia ningún filtro.
 */

/** Tope de ids por renglón: un periodo desastroso no infla la respuesta. */
export const MAX_IDS_PRECIERRE = 500;

/**
 * Las dos llaves ADITIVAS del renglón. `ids_truncado` SOLO viaja (con
 * `true`) cuando se cortó en `MAX_IDS_PRECIERRE`; si no, la llave no existe.
 */
export interface IdsPrecierre {
  ids: string[];
  ids_truncado?: true;
}

/**
 * ids (string) de las filas CONTADAS, en su orden, sin repetidos, topados en
 * `MAX_IDS_PRECIERRE`. Un `id` que no sea string no vacío se salta (jamás se
 * inventa). Se esparce como ÚLTIMAS llaves del objeto del renglón
 * (`...idsPrecierre(lista)`), convención de aditivos del repo.
 */
export function idsPrecierre(
  filas: ReadonlyArray<{ id?: unknown }>,
): IdsPrecierre {
  const vistos = new Set<string>();
  for (const f of filas) {
    const id = f?.id;
    if (typeof id !== 'string' || id.trim() === '') continue;
    vistos.add(id);
  }
  const todos = [...vistos];
  if (todos.length > MAX_IDS_PRECIERRE) {
    return { ids: todos.slice(0, MAX_IDS_PRECIERRE), ids_truncado: true };
  }
  return { ids: todos };
}
