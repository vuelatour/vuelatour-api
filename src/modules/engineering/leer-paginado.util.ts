/**
 * Lectura PAGINADA de PostgREST (17-nov-2026, invariante 135). PostgREST
 * corta en max-rows = 1000 SIN avisar: una lista que crece (archivos de un
 * avión, componentes con su historial) no puede quedarse en la primera
 * página. Se piden páginas con `.range()` hasta que una llega incompleta.
 *
 * El llamador arma la consulta de UNA página (con su `order` estable) y
 * decide qué hacer con el error (p. ej. «la tabla no existe» ⇒ migración
 * pendiente): aquí no se lanza ni se traga nada.
 */
export const PAGINA_POSTGREST = 1000;
/** Freno de seguridad: 20 páginas = 20,000 filas. */
export const PAGINAS_MAX = 20;

export interface ErrorPostgrest {
  message: string;
  code?: string | null;
}

export interface ResultadoPaginado<T> {
  filas: T[];
  error: ErrorPostgrest | null;
  /** `true` si se llegó al freno de seguridad (hay más filas sin leer). */
  truncado: boolean;
}

export async function leerPaginado<T>(
  pagina: (
    desde: number,
    hasta: number,
  ) => PromiseLike<{ data: unknown; error: ErrorPostgrest | null }>,
  tamano = PAGINA_POSTGREST,
): Promise<ResultadoPaginado<T>> {
  const filas: T[] = [];
  for (let i = 0; i < PAGINAS_MAX; i++) {
    const desde = i * tamano;
    const { data, error } = await pagina(desde, desde + tamano - 1);
    if (error) return { filas, error, truncado: false };
    const lote = (Array.isArray(data) ? data : []) as T[];
    filas.push(...lote);
    if (lote.length < tamano) return { filas, error: null, truncado: false };
  }
  return { filas, error: null, truncado: true };
}
