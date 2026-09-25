/**
 * UBICACIONES DE BODEGA — catálogo `inventario_ubicacion` (25-sep-2026).
 *
 * Pedido del cliente: «aprovechar poner una columna de ubicación, ya que
 * tenemos varias ubicaciones donde pueden estar guardadas las refacciones»
 * (Oficina vieja · Oficina nueva · Locker del aeropuerto · Bodega del taller
 * de Mérida · Bodega del taller de Cozumel). Hasta hoy `inventario_item`
 * tenía un TEXTO libre (`ubicacion`: 69 «Bodega Cancún», 2 «Corner», 1
 * «Bodega Córner»); desde la migración 20260925000001 el ítem apunta al
 * catálogo con `ubicacion_id` y el texto es su ESPEJO (trigger), o —sin id—
 * el texto LEGADO de antes, que NO se mapea adivinando: la oficina elige la
 * ubicación nueva y mientras tanto el panel lo pinta «(anterior)».
 *
 * Helpers PUROS (sin BD) con spec. El servicio los usa en createItem,
 * updateItem, la lista y el Excel.
 */

/** Migración que crea el catálogo, la FK y el margen de la tienda. */
export const MIGRACION_INVENTARIO_UBICACION = '20260925000001';

/** Valor del filtro «sin ubicación nueva» (`ubicacion_id` null). */
export const FILTRO_SIN_UBICACION = 'sin';

/** Sufijo que marca una ubicación LEGADA (texto de antes del catálogo). */
export const SUFIJO_UBICACION_ANTERIOR = '(anterior)';

/** Fila mínima del catálogo para resolver textos. */
export interface UbicacionCatalogo {
  id: string;
  nombre: string;
  activo: boolean;
}

/**
 * Llave de comparación de un nombre de ubicación: sin diacríticos, en
 * minúsculas, espacios colapsados y sin espacios en los extremos. «Bodega
 * del taller de Mérida», «bodega del taller de merida» y «BODEGA  DEL TALLER
 * DE MÉRIDA» son la MISMA ubicación.
 */
export function normalizarNombreUbicacion(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nombre limpio para guardar: sin espacios en los extremos ni dobles. */
export function limpiarNombreUbicacion(s: string): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Un cliente VIEJO (app Flutter, alta masiva, compras) sigue mandando la
 * ubicación como TEXTO. Si coincide (sin acentos ni mayúsculas) con una
 * ubicación ACTIVA del catálogo —o con la que el ítem YA tiene, aunque esté
 * desactivada— se liga su id y el texto pasa a ser el nombre del catálogo.
 * Si no coincide, queda como texto LEGADO tal cual (sin id): jamás se adivina
 * que «Bodega Cancún» es «Oficina nueva».
 */
export function resolverUbicacionDeTexto(
  texto: string,
  catalogo: UbicacionCatalogo[],
  actualId?: string | null,
): { ubicacion_id: string | null; ubicacion: string } {
  const limpio = String(texto ?? '').trim();
  const clave = normalizarNombreUbicacion(limpio);
  if (clave) {
    const u = catalogo.find(
      (c) =>
        normalizarNombreUbicacion(c.nombre) === clave &&
        (c.activo || (actualId != null && c.id === actualId)),
    );
    if (u) return { ubicacion_id: u.id, ubicacion: u.nombre };
  }
  return { ubicacion_id: null, ubicacion: limpio };
}

/**
 * Ubicación de otra ubicación del catálogo con el MISMO nombre (sin acentos
 * ni mayúsculas), o null. `excluirId` = la que se está renombrando.
 */
export function ubicacionDuplicada<T extends { id: string; nombre: string }>(
  nombre: string,
  catalogo: T[],
  excluirId?: string | null,
): T | null {
  const clave = normalizarNombreUbicacion(nombre);
  return (
    catalogo.find(
      (c) =>
        c.id !== excluirId && normalizarNombreUbicacion(c.nombre) === clave,
    ) ?? null
  );
}

/** Las llaves de ubicación que viajan en cada ítem (con la migración). */
export interface CamposUbicacionItem {
  /** Texto A MOSTRAR (catálogo o legado; null = sin ubicación). La app Flutter lo sigue leyendo. */
  ubicacion: string | null;
  ubicacion_id: string | null;
  /** = ubicacion cuando ubicacion_id ≠ null. */
  ubicacion_nombre: string | null;
  /** = ubicacion cuando ubicacion_id = null (null si no hay texto). */
  ubicacion_legado: string | null;
}

/**
 * Llaves de ubicación de una fila de `inventario_item` (con la migración
 * aplicada): el trigger garantiza que, con id, `ubicacion` ES el nombre del
 * catálogo, así que no hace falta un join.
 */
export function camposUbicacionDeItem(it: {
  ubicacion?: unknown;
  ubicacion_id?: unknown;
}): CamposUbicacionItem {
  const texto =
    typeof it.ubicacion === 'string' && it.ubicacion.trim()
      ? it.ubicacion.trim()
      : null;
  const id =
    typeof it.ubicacion_id === 'string' && it.ubicacion_id
      ? it.ubicacion_id
      : null;
  return {
    ubicacion: texto,
    ubicacion_id: id,
    ubicacion_nombre: id ? texto : null,
    ubicacion_legado: id ? null : texto,
  };
}

/**
 * Texto de la celda «Ubicación» del Excel del inventario: catálogo = nombre;
 * legado = «Bodega Cancún (anterior)»; sin ubicación = ''. Sin la migración
 * (`conCatalogo` false) el texto va tal cual, como siempre.
 */
export function textoUbicacionExcel(
  it: { ubicacion?: unknown; ubicacion_id?: unknown },
  conCatalogo: boolean,
): string {
  const texto =
    typeof it.ubicacion === 'string' && it.ubicacion.trim()
      ? it.ubicacion.trim()
      : '';
  if (!conCatalogo || !texto) return texto;
  const id =
    typeof it.ubicacion_id === 'string' && it.ubicacion_id
      ? it.ubicacion_id
      : null;
  return id ? texto : `${texto} ${SUFIJO_UBICACION_ANTERIOR}`;
}

/** Mensajes es-MX de los errores del catálogo (una sola redacción). */
export const MENSAJES_UBICACION = {
  noDisponible: `Las ubicaciones de bodega todavía no están disponibles: falta aplicar la migración ${MIGRACION_INVENTARIO_UBICACION}.`,
  duplicada: (nombre: string) => `Ya existe la ubicación «${nombre}».`,
  enUso: (nombre: string, n: number) =>
    `«${nombre}» tiene ${n} producto(s) activo(s); muévelos primero a otra ubicación.`,
  inactiva: (nombre: string) =>
    `La ubicación «${nombre}» está desactivada; actívala o elige otra.`,
  noExiste: 'La ubicación ya no existe.',
} as const;
