/**
 * ETIQUETAS Y DESTINO POR DEFAULT DE LAS CATEGORÍAS DE GASTO — fuente única
 * (pedido del cliente, 2-sep-2026).
 *
 * SOLO PRESENTACIÓN: los códigos del enum `CategoriaGasto` (GAS, OTRO, …)
 * NO cambian en BD, DTOs, comparaciones ni prompts; ninguna regla de
 * clasificación, reparto o balance mira estas etiquetas. Todo texto que un
 * humano lee (Excel, PDF, push, mensajes de error, "Mis registros") pasa
 * por `etiquetaCategoriaGasto`, nunca por el código crudo ni su lowercase.
 *
 * Los textos son IDÉNTICOS en panel (vuelatour-next), app (vuelatour-flutter)
 * y API: si uno cambia, cambian los tres.
 *
 * `CATEGORIA_GASTO_DESTINO` es documentación viva: a dónde se va el gasto POR
 * DEFAULT (la oficina luego puede reacomodarlo con el reparto manual). Se
 * pinta en verde junto a cada categoría en el selector de captura y en el
 * Swagger del DTO. No es una regla de negocio ejecutable: la clasificación
 * real vive en el balance por avión / reparto / Libro Dinero.
 *
 * `import type`: el util NO importa el enum en runtime (el DTO importa este
 * util para su descripción Swagger; un import de valor sería un ciclo y el
 * enum llegaría undefined al evaluar los records). El tipado
 * `Record<CategoriaGasto, string>` obliga a completar TODAS las claves: una
 * categoría nueva en el enum no compila hasta tener etiqueta y destino.
 */
import type { CategoriaGasto } from '../modules/expenses/dto/expenses.dto';

/** Etiqueta es-MX (sentence case) de cada categoría — homologada panel/app/API. */
export const CATEGORIA_GASTO_LABEL: Record<CategoriaGasto, string> = {
  GAS: 'Gasavión / Turbosina',
  ATERRIZAJE: 'Aterrizaje',
  OPERACIONES: 'Operaciones',
  TUAS: 'TUAS',
  FBO: 'FBO',
  COMIDA: 'Comida',
  HOTEL: 'Hotel',
  TAXI: 'Taxi / estacionamiento',
  REFACCION: 'Refacción',
  PERMISO: 'Permiso',
  PILOTO_EXTERNO: 'Piloto externo (honorario)',
  /** Legado, solo lectura (fuera de los selectores desde el 2-sep-2026). */
  FIJO: 'Gasto fijo',
  INDIRECTO: 'Gastos indirectos de avión',
  NOMINA: 'Nómina',
  SERVICIOS: 'Servicios (avión)',
  GASOLINA: 'Gasolina (vehículos)',
  /** Legado, solo lectura (la fija la app al rol VISITANTE). */
  VISITA: 'Visita',
  PERSONAL_DUENO: 'Gasto personal del dueño',
  OTRO: 'Otros gastos VuelaTour',
};

/** A dónde se va el gasto POR DEFAULT (texto verde del selector de captura). */
export const CATEGORIA_GASTO_DESTINO: Record<CategoriaGasto, string> = {
  GAS: 'Combustible (en el balance del avión)',
  ATERRIZAJE: 'Gastos directos del vuelo (en el balance del avión)',
  OPERACIONES: 'Gastos directos del vuelo (en el balance del avión)',
  TUAS: 'Gastos directos del vuelo (en el balance del avión)',
  FBO: 'Gastos directos del vuelo (en el balance del avión)',
  COMIDA: 'Gastos directos del vuelo (en el balance del avión)',
  HOTEL: 'Gastos directos del vuelo (en el balance del avión)',
  TAXI: 'Gastos directos del vuelo (en el balance del avión)',
  PILOTO_EXTERNO: 'Gastos directos del vuelo (en el balance del avión)',
  REFACCION:
    'Inventario en el Balance general VuelaTour; al salir del inventario se vende al avión y cae en sus Gastos Indirectos',
  PERMISO: 'Hoja de permisos (en el balance del avión)',
  INDIRECTO: 'Gastos indirectos del avión (en el balance del avión)',
  SERVICIOS: 'Gastos indirectos del avión (en el balance del avión)',
  NOMINA: 'Otros gastos (Balance general VuelaTour)',
  GASOLINA: 'Otros gastos (Balance general VuelaTour)',
  OTRO: 'Otros gastos (Balance general VuelaTour)',
  FIJO: 'Otros gastos (Balance general VuelaTour)',
  VISITA: 'Otros gastos (Balance general VuelaTour)',
  PERSONAL_DUENO: 'Gastos personales de los dueños (fuera de la empresa)',
};

/**
 * Etiqueta humana de un código de categoría. Fallback para códigos que el
 * enum no conoce (datos viejos, valores libres de la IA): el código
 * capitalizado con guiones bajos a espacios ("FOO_BAR" → "Foo bar", igual
 * que panel y app). Vacío/null → cadena vacía (los
 * callers que arman listas con `.filter(Boolean)` lo descartan solos).
 */
export function etiquetaCategoriaGasto(cat: string | null | undefined): string {
  if (!cat) return '';
  const label = (CATEGORIA_GASTO_LABEL as Record<string, string | undefined>)[
    cat
  ];
  if (label) return label;
  const limpio = cat.replace(/_/g, ' ').toLowerCase();
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

/** Destino por default de un código; null si el enum no lo conoce. */
export function destinoCategoriaGasto(
  cat: string | null | undefined,
): string | null {
  if (!cat) return null;
  return (
    (CATEGORIA_GASTO_DESTINO as Record<string, string | undefined>)[cat] ?? null
  );
}

/**
 * Texto para la descripción Swagger del campo `categoria`: una línea por
 * código con "código → etiqueta → destino por default". Derivado de los
 * records de arriba (sin duplicar textos).
 */
export function descripcionCategoriasGasto(): string {
  const lineas = (Object.keys(CATEGORIA_GASTO_LABEL) as CategoriaGasto[]).map(
    (c) => `${c} → ${CATEGORIA_GASTO_LABEL[c]} → ${CATEGORIA_GASTO_DESTINO[c]}`,
  );
  return [
    'Categoría del gasto. Código → etiqueta (UI) → destino por default (la oficina puede reacomodarlo después):',
    ...lineas,
  ].join('\n');
}
