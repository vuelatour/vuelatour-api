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

/** Destino por default que marca a una categoría como gasto de la EMPRESA. */
const DESTINO_EMPRESA = 'Otros gastos (Balance general VuelaTour)';

/**
 * CATEGORÍAS DE EMPRESA — «la categoría de empresa manda sobre el vuelo»
 * (regla del cliente, 11-sep-2026). Su gasto es de VuelaTour, no del avión:
 * va SIEMPRE a la hoja "otros gastos" del Balance general (eje `fecha_gasto`)
 * AUNQUE traiga vuelo o aeronave sellados, y NO resta en la fila del vuelo,
 * ni en las hojas del libro del avión, ni en su cascada de utilidad.
 *
 * Se DERIVA de `CATEGORIA_GASTO_DESTINO` (mismo patrón que
 * `categoriaExigeVuelo`): una categoría nueva con ese destino entra sola y
 * nadie tiene que acordarse de copiarla a una segunda lista — el spec
 * congela la membresía exacta de hoy, así que un cambio de destino que mueva
 * dinero falla en pruebas en vez de hacerlo en silencio.
 *
 * Fuera a propósito: `PERSONAL_DUENO` (dinero personal del dueño, fuera de
 * la empresa), `GAS` (hoja "combustible" del avión) y todo lo indirecto del
 * avión (INDIRECTO, SERVICIOS, REFACCION).
 */
export const CATEGORIAS_GASTO_EMPRESA: ReadonlySet<string> = new Set(
  (Object.keys(CATEGORIA_GASTO_DESTINO) as CategoriaGasto[]).filter(
    (c) => CATEGORIA_GASTO_DESTINO[c] === DESTINO_EMPRESA,
  ),
);

/** ¿El gasto es de la EMPRESA aunque traiga vuelo/avión? (ver arriba). */
export function categoriaEsDeEmpresa(cat: string | null | undefined): boolean {
  return !!cat && CATEGORIAS_GASTO_EMPRESA.has(cat);
}

/**
 * Categorías que NUNCA son "pendiente de asignarle avión" — FUENTE ÚNICA de
 * la bandeja de pendientes (`expenses.list?pendientes=1`), de su sugerencia
 * por IA (`sugerirAsignaciones`), de la alerta diaria `gastos_sin_avion` y
 * del pre-cierre del reparto. Si las cuatro no usan la MISMA lista, los
 * conteos no cuadran y la bandeja "que debe quedar vacía" nunca se vacía.
 *
 *  - Las de EMPRESA (11-sep-2026): son de VuelaTour CON o SIN vuelo — se
 *    administran en la pantalla "Otros gastos". Antes la lista se escribía a
 *    mano en cada lector y un `.or('categoria.neq.OTRO,vuelo_id.not.is.null')`
 *    dejaba dentro al OTRO CON vuelo.
 *  - `INDIRECTO`: captura general, sin avión por diseño (jul 2026).
 *  - `PERSONAL_DUENO`: jamás lleva avión (dinero personal del dueño).
 *
 * `SERVICIOS` y `REFACCION` NO están: sin avión SÍ son pendientes reales.
 * Se expone como arreglo de strings para armar el `not.in(...)` de PostgREST.
 */
export const CATEGORIAS_GASTO_SIN_AVION: readonly string[] = [
  ...CATEGORIAS_GASTO_EMPRESA,
  'INDIRECTO',
  'PERSONAL_DUENO',
];

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

/**
 * Categorías que SIEMPRE pertenecen a un vuelo aunque su destino por default
 * no diga "Gastos directos del vuelo": la TUA/el permiso se pagan POR un
 * vuelo y el honorario del piloto externo es de la operación que voló. Se
 * listan aparte porque su destino contable es otro (hoja de permisos /
 * directo del vuelo).
 *
 * **GAS salió de esta lista el 11-sep-2026** (pedido del cliente): un PILOTO
 * también carga combustible EN BASE sin vuelo (igual que el mecánico, que ya
 * estaba fuera del candado), y la pantalla de combustible de la app ofrece
 * "Sin vuelo". El combustible no se pierde sin vuelo: su eje es `fecha_gasto`
 * y su hoja "combustible" del balance se arma por AVIÓN (`aeronave_id`), no
 * por vuelo — el pre-cierre ya vigila el GAS sin avión (ese sí bloquea).
 */
const CATEGORIAS_GASTO_SIEMPRE_DE_VUELO: ReadonlySet<string> = new Set([
  'TUAS',
  'PERMISO',
  'PILOTO_EXTERNO',
]);

/** Prefijo del destino que marca a una categoría como "del vuelo". */
const DESTINO_DIRECTO_DE_VUELO = 'Gastos directos del vuelo';

/**
 * ¿Esta categoría EXIGE vuelo? (helper puro, 11-sep-2026 — pedido de la app:
 * "quiero registrar un gasto sin vuelo").
 *
 * Regla: es del vuelo si su destino por default son los «Gastos directos del
 * vuelo» (ATERRIZAJE, OPERACIONES, TUAS, FBO, COMIDA, HOTEL, TAXI,
 * PILOTO_EXTERNO) o si está en la lista de arriba (PERMISO). Las de
 * EMPRESA/indirectos (INDIRECTO, SERVICIOS, NOMINA, GASOLINA, OTRO, VISITA,
 * FIJO, PERSONAL_DUENO), REFACCION (va a inventario) y GAS (11-sep-2026: el
 * piloto también carga combustible en base) se capturan sin vuelo.
 *
 * Se deriva de `CATEGORIA_GASTO_DESTINO` a propósito: una categoría nueva
 * hereda la regla desde su destino, sin otra lista que mantener. Un código
 * que el enum no conoce ⇒ false (no se inventan candados sobre datos viejos).
 */
export function categoriaExigeVuelo(cat: string | null | undefined): boolean {
  if (!cat) return false;
  if (CATEGORIAS_GASTO_SIEMPRE_DE_VUELO.has(cat)) return true;
  const destino = destinoCategoriaGasto(cat);
  return destino != null && destino.startsWith(DESTINO_DIRECTO_DE_VUELO);
}
