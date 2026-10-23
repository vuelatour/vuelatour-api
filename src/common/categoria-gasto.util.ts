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
 *
 * DOS CATEGORÍAS DEL PAGO AL VENDEDOR (13-oct-2026, API 0.0.74, invariante
 * 61 del CLAUDE.md del API; pedido del cliente: «necesitamos una opcion que
 * sea Comision del vendedor pero que esa opcion si se cargue al balance del
 * avión, y dejamos el otro que se va a balance de vuelatour»):
 *  - `COMISION_VENDEDOR` = «Comisión del vendedor (VuelaTour)»: SIEMPRE la
 *    paga VuelaTour («otros movimientos»); nunca es costo del avión.
 *  - `COMISION_VENDEDOR_AVION` = «Comisión del vendedor (avión)»: la carga el
 *    avión del vuelo en su columna COMISIONES y en el reparto (SOLO por la
 *    fuente única `comisionesDelVuelo`).
 * TODA comparación de estas categorías es EXACTA (`Set.has` / `===`):
 * PROHIBIDO `startsWith` / `includes` / LIKE / regex sin ancla con
 * 'COMISION_VENDEDOR', porque es PREFIJO de 'COMISION_VENDEDOR_AVION'. El
 * eje genérico («¿es pago al vendedor?», «¿queda fuera del costo genérico
 * del avión?») usa la UNIÓN (`categoriaEsPagoVendedor`,
 * `CATEGORIAS_GASTO_FUERA_DEL_AVION`); QUIÉN paga lo decide SOLO
 * `ladoPagoVendedor`.
 *
 * COMISARIATO (13-oct-2026, API 0.0.75, invariante 63 del CLAUDE.md del
 * API; pedido del cliente: «agregar en la categoría de gastos: Comisariato;
 * entraría en [la columna OTROS de costos directos] en el balance del
 * avión»): snacks/bebidas de los PASAJEROS. Entró SOLO por su destino (el
 * de COMIDA, «Gastos directos del vuelo»): `categoriaExigeVuelo` la
 * deriva (candado del PILOTO) y NINGUNA lista de aquí cambió — no es de
 * EMPRESA, no es «sin avión» (sin avión SÍ es pendiente real, como COMIDA),
 * no es fuera del avión ni exige vuelo a todos los roles. Lo que la hace
 * columna OTROS y DIRECTO vive en sus lectores (`CAT_OTROS` del balance,
 * `DIRECTO` del reparto, `CATS_SIN_TUA_EMBEBIDO`, `CATEGORIAS_NO_LIGABLES`).
 *
 * OTROS MOVIMIENTOS (23-oct-2026, API 0.0.106, invariante 107 del CLAUDE.md
 * del API; pedido del cliente con la captura del select de categorías:
 * «Falta la opción de agregar un gasto a la hoja de "otros movimientos" en
 * el balance general»): `OTROS_MOVIMIENTOS` = «Otros movimientos
 * (VuelaTour)», destino PROPIO `DESTINO_OTROS_MOVIMIENTOS` (NO es el de
 * EMPRESA: no cae en «otros gastos»). Es un EGRESO DE VUELATOUR con vuelo y
 * avión opcionales: con vuelo egresa en el bloque de su vuelo de la hoja
 * «otros movimientos» del Balance general (y en «Otros ingresos» del Libro
 * Dinero, como el TUA pagado); sin vuelo, fila suelta. Nunca es costo del
 * avión (`CATEGORIAS_GASTO_FUERA_DEL_AVION`, EXCLUIDO del reparto) ni
 * «pendiente de avión» (`CATEGORIAS_GASTO_SIN_AVION`). Solo la OFICINA la
 * captura (`CATEGORIAS_SOLO_OFICINA`).
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
  /** Snacks/bebidas de los PASAJEROS (13-oct-2026, invariante 63): gasto
   *  directo del vuelo, columna OTROS del balance del avión. La comida de la
   *  tripulación es COMIDA. */
  COMISARIATO: 'Comisariato',
  /** Cualquier otro gasto directo del vuelo (20-oct-2026, invariante 97):
   *  columna OTROS de la fila del vuelo, como Comisariato. */
  OTROS_DIRECTOS_VUELO: 'Otros gastos directos del vuelo',
  HOTEL: 'Hotel',
  TAXI: 'Taxi / estacionamiento',
  REFACCION: 'Refacción',
  PERMISO: 'Permiso',
  PILOTO_EXTERNO: 'Piloto externo (honorario)',
  /** Pago al vendedor que paga VuelaTour (28-sep-2026; «(VuelaTour)» desde
   *  el 13-oct-2026): se aparea con la comisión cobrada en «otros
   *  movimientos» (invariantes 31 y 61 del CLAUDE.md del API). */
  COMISION_VENDEDOR: 'Comisión del vendedor (VuelaTour)',
  /** Pago al vendedor a cargo del avión (13-oct-2026, invariante 61): resta
   *  en la columna COMISIONES del avión del vuelo y en su reparto. */
  COMISION_VENDEDOR_AVION: 'Comisión del vendedor (avión)',
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
  /** Envíos y mensajería de la empresa (20-oct-2026, invariante 97). */
  PAQUETERIA: 'Paquetería',
  /** Egreso de VuelaTour para la hoja «otros movimientos» del Balance
   *  general (23-oct-2026, invariante 107): vuelo y avión opcionales, nunca
   *  costo del avión. */
  OTROS_MOVIMIENTOS: 'Otros movimientos (VuelaTour)',
};

/**
 * Destino PROPIO de «Otros movimientos (VuelaTour)» (23-oct-2026, invariante
 * 107). A PROPÓSITO distinto de `DESTINO_EMPRESA`: la categoría NO entra a
 * `CATEGORIAS_GASTO_EMPRESA` (no va a la hoja «otros gastos»; su lugar es
 * la hoja «otros movimientos», apareada con el ingreso de VuelaTour de su
 * vuelo o como fila suelta). Texto IDÉNTICO en panel y app.
 */
export const DESTINO_OTROS_MOVIMIENTOS =
  'Otros movimientos (Balance general VuelaTour)';

/** A dónde se va el gasto POR DEFAULT (texto verde del selector de captura). */
export const CATEGORIA_GASTO_DESTINO: Record<CategoriaGasto, string> = {
  GAS: 'Combustible (en el balance del avión)',
  ATERRIZAJE: 'Gastos directos del vuelo (en el balance del avión)',
  OPERACIONES: 'Gastos directos del vuelo (en el balance del avión)',
  TUAS: 'Gastos directos del vuelo (en el balance del avión)',
  FBO: 'Gastos directos del vuelo (en el balance del avión)',
  COMIDA: 'Gastos directos del vuelo (en el balance del avión)',
  // COMISARIATO (13-oct-2026, invariante 63): el MISMO destino que COMIDA ⇒
  // `categoriaExigeVuelo` la deriva sola (candado solo del PILOTO).
  COMISARIATO: 'Gastos directos del vuelo (en el balance del avión)',
  // OTROS_DIRECTOS_VUELO (20-oct-2026, invariante 97): el destino de
  // COMISARIATO ⇒ `categoriaExigeVuelo` la deriva sola.
  OTROS_DIRECTOS_VUELO: 'Gastos directos del vuelo (en el balance del avión)',
  HOTEL: 'Gastos directos del vuelo (en el balance del avión)',
  TAXI: 'Gastos directos del vuelo (en el balance del avión)',
  PILOTO_EXTERNO: 'Gastos directos del vuelo (en el balance del avión)',
  // Las dos del pago al vendedor (13-oct-2026, invariante 61): NO empiezan
  // con «Gastos directos del vuelo» ni son el destino de EMPRESA ⇒
  // `CATEGORIAS_GASTO_EMPRESA` NO cambia (ninguna va a «otros gastos»). Los
  // textos son simétricos a propósito («no es / sí es costo del avión»).
  COMISION_VENDEDOR:
    'Pago al vendedor (otros movimientos VuelaTour; no es costo del avión)',
  COMISION_VENDEDOR_AVION:
    'Pago al vendedor (columna COMISIONES del balance del avión; sí es costo del avión)',
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
  // PAQUETERIA (20-oct-2026, invariante 97): destino de EMPRESA ⇒ entra sola
  // a CATEGORIAS_GASTO_EMPRESA (y por ella a «sin avión»).
  PAQUETERIA: 'Otros gastos (Balance general VuelaTour)',
  PERSONAL_DUENO: 'Gastos personales de los dueños (fuera de la empresa)',
  // OTROS_MOVIMIENTOS (23-oct-2026, invariante 107): destino PROPIO — ni
  // «Gastos directos del vuelo» (no exige vuelo) ni el de EMPRESA (no va a
  // «otros gastos»).
  OTROS_MOVIMIENTOS: DESTINO_OTROS_MOVIMIENTOS,
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
 *
 * `COMISION_VENDEDOR_AVION` NO está A PROPÓSITO (13-oct-2026, invariante
 * 61): este arreglo arma el `not.in(...)` de PostgREST y un literal que el
 * enum de la BD todavía no conoce revienta la LECTURA (22P02) — la bandeja,
 * la sugerencia por IA y la alerta diaria se caerían con un API desplegado
 * antes de la migración 20261013000003. Consecuencia aceptada: una
 * «Comisión del vendedor (avión)» con `aeronave_id` null (vuelo sin avión
 * de la flota) sale en la bandeja «sin avión», en la alerta y en el
 * pre-cierre (los cuatro usan ESTA MISMA lista); asignarle avión al gasto NO
 * cambia quién paga: la salida es reclasificarla a «(VuelaTour)».
 */
export const CATEGORIAS_GASTO_SIN_AVION: readonly string[] = [
  ...CATEGORIAS_GASTO_EMPRESA,
  'INDIRECTO',
  'PERSONAL_DUENO',
  // COMISION_VENDEDOR (28-sep-2026): pago al vendedor, no es costo de ningún
  // avión — una comisión de un vuelo sin avión NO es «pendiente de avión».
  // OJO (crítica 28-sep): este arreglo arma un `not.in(...)` de PostgREST y
  // un literal que el enum de la BD no conoce revienta la LECTURA (22P02)
  // ⇒ el API que lo trae exige la migración 20260928000001 ANTES del deploy.
  'COMISION_VENDEDOR',
  // OTROS_MOVIMIENTOS (23-oct-2026, invariante 107): egreso de VuelaTour
  // de la hoja «otros movimientos» — con o sin vuelo, con o sin avión
  // sellado, jamás es «pendiente de avión» (el avión solo informa). Mismo
  // aviso de PostgREST: la migración 20261023000002 YA está aplicada en prod
  // (23-oct-2026), antes de este API.
  'OTROS_MOVIMIENTOS',
];

/**
 * COMISIÓN DEL VENDEDOR como gasto (pedido del cliente, 28-sep-2026: «¿cómo
 * registro el pago de la comisión a Saab para que aparezca en otros
 * movimientos? Si lo capturo como "Otros gastos VuelaTour" queda
 * duplicado»). Invariantes 31 y 61 del CLAUDE.md del API.
 *
 * `CATEGORIA_PAGO_VENDEDOR` = «Comisión del vendedor (VuelaTour)»: el pago
 * al vendedor que paga VuelaTour (la comisión cobrada es ingreso de
 * VuelaTour, regla 28-ago-2026). NO es costo de ningún avión, NO va a la
 * hoja «otros gastos», y se APAREA con la línea de comisión cobrada del
 * vuelo en «otros movimientos» (Balance general) y en «Otros ingresos»
 * (Libro Dinero) (`src/common/pago-vendedor.util.ts`); sin pago capturado
 * la fila no lleva egreso (invariantes 58 y 61).
 */
export const CATEGORIA_PAGO_VENDEDOR = 'COMISION_VENDEDOR';

/**
 * «Comisión del vendedor (avión)» (13-oct-2026, invariante 61): el pago al
 * vendedor que CARGA EL AVIÓN del vuelo en su columna COMISIONES y en el
 * reparto a socios (vuelo COMPLETADO o CANCELADO con cobros retenidos, por
 * participación, en el mes del vuelo; fuente única `comisionesDelVuelo`).
 * Fuera de ese universo la paga VuelaTour en «otros movimientos», con aviso.
 */
export const CATEGORIA_PAGO_VENDEDOR_AVION = 'COMISION_VENDEDOR_AVION';

/**
 * «Comisariato» (13-oct-2026, invariante 63): snacks/bebidas/comisariato de
 * los PASAJEROS. Gasto DIRECTO del vuelo: columna OTROS de la fila del vuelo
 * (junto al FBO), grupo DIRECTO en el reparto, exige vuelo solo al PILOTO.
 * Para los lectores que necesitan el literal (balance, reparto, compras).
 */
export const CATEGORIA_COMISARIATO = 'COMISARIATO';
/** Literal de «Otros gastos directos del vuelo» (20-oct-2026, invariante
 *  97): columna OTROS del balance, como COMISARIATO. */
export const CATEGORIA_OTROS_DIRECTOS_VUELO = 'OTROS_DIRECTOS_VUELO';

/**
 * «Otros movimientos (VuelaTour)» (23-oct-2026, API 0.0.106, invariante
 * 107): EGRESO DE VUELATOUR que vive en la hoja «otros movimientos» del
 * Balance general — con vuelo, como línea de egreso del bloque de su vuelo
 * (el avión del vuelo solo informa); sin vuelo, como fila suelta. Jamás es
 * costo del avión (fila del vuelo, «Gastos Indirectos», reparto: EXCLUIDO)
 * ni «otros gastos» de la empresa. Para los lectores que necesitan el
 * literal (balance, Libro Dinero, reparto, compras, candado del cierre).
 */
export const CATEGORIA_OTROS_MOVIMIENTOS = 'OTROS_MOVIMIENTOS';

/**
 * Categorías que SOLO captura la OFICINA (23-oct-2026, invariante 107): un
 * PILOTO, MECANICO o VISITANTE que las manda en el ALTA de un gasto recibe
 * 400 `CATEGORIA_SOLO_OFICINA` (`mensajeCategoriaSoloOficina`); la edición
 * no se bloquea (la app re-manda la categoría vigente). Patrón de
 * `MEDIOS_SOLO_OFICINA`. Hoy solo «Otros movimientos (VuelaTour)»: un
 * egreso del Balance general que la oficina decide; el piloto registra el
 * gasto del vuelo con su categoría (Operaciones, Hotel, Comida…).
 */
export const CATEGORIAS_SOLO_OFICINA: ReadonlySet<string> = new Set([
  CATEGORIA_OTROS_MOVIMIENTOS,
]);

/** Texto del 400 `CATEGORIA_SOLO_OFICINA` de «Otros movimientos (VuelaTour)». */
export const MENSAJE_OTROS_MOVIMIENTOS_SOLO_OFICINA =
  '«Otros movimientos (VuelaTour)» la registra la oficina: es un egreso de VuelaTour para la hoja «otros movimientos» del Balance general. Si es un gasto del vuelo, elige su categoría (Operaciones, Hotel, Comida…).';

/** El texto del 400 `CATEGORIA_SOLO_OFICINA` según la categoría enviada. */
export function mensajeCategoriaSoloOficina(cat: string): string {
  if (cat === CATEGORIA_OTROS_MOVIMIENTOS)
    return MENSAJE_OTROS_MOVIMIENTOS_SOLO_OFICINA;
  return `«${etiquetaCategoriaGasto(cat)}» la registra la oficina.`;
}

/**
 * «Nómina» (16-oct-2026, API 0.0.90, invariante 91): vive en su módulo
 * (fuera de Gastos y de Otros gastos) y SOLO cuenta en los libros
 * REPARTIDA entre aviones (sus parciales van a «Gastos Indirectos» de cada
 * avión). Sin reparto no entra a ningún balance: ni a «otros gastos» del
 * general (`gastosEmpresaYSueltos`), ni tiene ubicación
 * (`ubicacionBalanceDeGasto` ⇒ null); la celda «Avión» dice «Sin
 * repartir» y el pre-cierre la BLOQUEA (`nomina_sin_repartir`). Sigue
 * siendo categoría de EMPRESA (destino de arriba): el Libro Dinero, el
 * tablero y el reparto a socios no cambian.
 */
export const CATEGORIA_NOMINA = 'NOMINA';

/** Quién paga un pago al vendedor: VuelaTour o el avión del vuelo. */
export type LadoPagoVendedor = 'VUELATOUR' | 'AVION';

/** Las DOS categorías del pago al vendedor (comparación EXACTA). */
export const CATEGORIAS_GASTO_PAGO_VENDEDOR: ReadonlySet<string> = new Set([
  CATEGORIA_PAGO_VENDEDOR,
  CATEGORIA_PAGO_VENDEDOR_AVION,
]);

/**
 * ¿Es un pago al vendedor de CUALQUIERA de las dos categorías? Es el
 * predicado del EJE GENÉRICO («¿es pago al vendedor?»: fuera del costo
 * genérico del avión, fuera de Z, fuera del aviso de avión que no vuela,
 * oculto al piloto…). QUIÉN lo paga lo decide SOLO `ladoPagoVendedor`.
 * Igualdad exacta (`Set.has`): nada de prefijos.
 */
export function categoriaEsPagoVendedor(
  cat: string | null | undefined,
): boolean {
  return !!cat && CATEGORIAS_GASTO_PAGO_VENDEDOR.has(cat);
}

/**
 * Lado del pago al vendedor, por IGUALDAD EXACTA: «(VuelaTour)» ⇒
 * 'VUELATOUR', «(avión)» ⇒ 'AVION', cualquier otra cosa (otra categoría,
 * minúsculas, prefijos, 'COMISION_VENDEDOR_AVIONX', null) ⇒ null.
 */
export function ladoPagoVendedor(
  cat: string | null | undefined,
): LadoPagoVendedor | null {
  if (cat === CATEGORIA_PAGO_VENDEDOR) return 'VUELATOUR';
  if (cat === CATEGORIA_PAGO_VENDEDOR_AVION) return 'AVION';
  return null;
}

/**
 * Vuelo obligatorio para TODOS los roles (la oficina incluida). A diferencia
 * de `categoriaExigeVuelo` —que el API solo impone al PILOTO: la oficina
 * carga gastos sueltos y los liga después—, una comisión sin vuelo no tiene
 * con qué aparearse y quedaría fuera de todo libro. Las DOS categorías del
 * pago al vendedor (13-oct-2026). Respaldo en BD: CHECKs
 * `gasto_comision_vendedor_exige_vuelo` (20260928000002) y
 * `gasto_comision_vendedor_avion_exige_vuelo` (20261013000004).
 */
export const CATEGORIAS_GASTO_VUELO_OBLIGATORIO: ReadonlySet<string> = new Set([
  CATEGORIA_PAGO_VENDEDOR,
  CATEGORIA_PAGO_VENDEDOR_AVION,
]);

/** ¿La categoría exige vuelo para CUALQUIER rol? (ver arriba). */
export function categoriaExigeVueloSiempre(
  cat: string | null | undefined,
): boolean {
  return !!cat && CATEGORIAS_GASTO_VUELO_OBLIGATORIO.has(cat);
}

/**
 * NO son costo GENÉRICO de ningún avión aunque traigan vuelo/avión sellados:
 * las de EMPRESA (van a «otros gastos») ∪ las DOS del pago al vendedor.
 * Fuente única de los lectores cuyo propósito es «¿resta al avión / al vuelo
 * por el eje genérico?» (fila del vuelo del balance, ficha, tablero, grupo,
 * reporte por vuelo, acreditación del Libro Dinero). La «Comisión del
 * vendedor (avión)» entra a un libro SOLO por `comisionesDelVuelo` (columna
 * COMISIONES y reparto), nunca por este eje: si un lector la sumara aquí,
 * se contaría dos veces. Los lectores que arman la hoja «otros gastos»
 * siguen usando `CATEGORIAS_GASTO_EMPRESA`: ninguna comisión va ahí.
 */
export const CATEGORIAS_GASTO_FUERA_DEL_AVION: ReadonlySet<string> = new Set([
  ...CATEGORIAS_GASTO_EMPRESA,
  ...CATEGORIAS_GASTO_PAGO_VENDEDOR,
  // OTROS_MOVIMIENTOS (23-oct-2026, invariante 107): egreso de VuelaTour de
  // la hoja «otros movimientos» del Balance general — fuera de la fila del
  // vuelo, de «Gastos Indirectos», del tablero por avión, de la ficha, del
  // reporte por vuelo y del candado «mes del vuelo» de la fecha, aunque
  // traiga vuelo o avión sellados. NO va a «otros gastos» (no es de EMPRESA).
  CATEGORIA_OTROS_MOVIMIENTOS,
]);

/** ¿El gasto queda fuera del costo del avión/vuelo? (ver arriba). */
export function categoriaFueraDelAvion(
  cat: string | null | undefined,
): boolean {
  return !!cat && CATEGORIAS_GASTO_FUERA_DEL_AVION.has(cat);
}

/**
 * Migración que agrega cada categoría NUEVA al enum `categoria_gasto` (el
 * 400 del cinturón la nombra).
 */
export const MIGRACION_DE_CATEGORIA: Readonly<Record<string, string>> = {
  COMISION_VENDEDOR: '20260928000001',
  COMISION_VENDEDOR_AVION: '20261013000003',
  // COMISARIATO (13-oct-2026, invariante 63): 22.º valor del enum, al final.
  COMISARIATO: '20261013000001',
  // 20-oct-2026 (invariante 97): 23.º y 24.º valores, al final.
  PAQUETERIA: '20261020000001',
  OTROS_DIRECTOS_VUELO: '20261020000002',
  // 23-oct-2026 (invariante 107): 25.º valor, al final (aplicada en prod).
  OTROS_MOVIMIENTOS: '20261023000002',
};

/**
 * Texto del 400 cuando la BD todavía no tiene el valor de
 * «Comisión del vendedor (VuelaTour)» (el de siempre, con la etiqueta nueva:
 * `mensajeCategoriaSinMigracion` lo arma igual para cada categoría).
 */
export const MENSAJE_CATEGORIA_SIN_MIGRACION =
  '«Comisión del vendedor (VuelaTour)» necesita la migración 20260928000001 en la base de datos; avisa a sistemas (el gasto no se guardó).';

/**
 * Texto del 400 cuando la BD todavía no tiene el valor `COMISARIATO`
 * (migración 20261013000001): lo arma `mensajeCategoriaSinMigracion` con la
 * misma plantilla; aquí queda escrito para los specs y la paridad.
 */
export const MENSAJE_COMISARIATO_SIN_MIGRACION =
  '«Comisariato» necesita la migración 20261013000001 en la base de datos; avisa a sistemas (el gasto no se guardó).';

/**
 * Texto del 400 cuando la BD todavía no tiene el valor `OTROS_MOVIMIENTOS`
 * (migración 20261023000002, aplicada en prod el 23-oct-2026): misma
 * plantilla de `mensajeCategoriaSinMigracion`; aquí para los specs.
 */
export const MENSAJE_OTROS_MOVIMIENTOS_SIN_MIGRACION =
  '«Otros movimientos (VuelaTour)» necesita la migración 20261023000002 en la base de datos; avisa a sistemas (el gasto no se guardó).';

/**
 * 22P02 «invalid input value for enum categoria_gasto: "COMISION_VENDEDOR_AVION"»
 * al ESCRIBIR ⇒ texto 400 (nunca 500: un 500 invita al outbox a reintentar).
 *
 * (Crítica 28-sep-2026) Es SOLO un cinturón del insert/update: NO hace que el
 * API tolere una BD sin la migración — las LECTURAS con el literal nuevo
 * (`.eq('categoria', …)` de los candados anti-duplicado, best-effort, y el
 * filtro `?categoria=` del listado) pueden reventar con 22P02. La garantía
 * real es el orden del despliegue (migración antes del API). Devuelve texto
 * SOLO si se cumplen las cuatro:
 *  - la categoría ENVIADA está en `MIGRACION_DE_CATEGORIA`;
 *  - `code === '22P02'`;
 *  - el mensaje habla del enum `categoria_gasto`;
 *  - el mensaje trae la categoría enviada ENTRE COMILLAS DOBLES (Postgres
 *    cita el valor así): con un `includes` sin comillas, 'COMISION_VENDEDOR'
 *    casaría con el mensaje de 'COMISION_VENDEDOR_AVION' (es su prefijo).
 */
export function mensajeCategoriaSinMigracion(
  error: { code?: string | null; message?: string | null },
  categoriaEnviada: string | null | undefined,
): string | null {
  if (!categoriaEnviada) return null;
  const migracion = MIGRACION_DE_CATEGORIA[categoriaEnviada];
  if (!migracion) return null;
  if (error.code !== '22P02') return null;
  const msg = error.message ?? '';
  if (!/categoria_gasto/.test(msg)) return null;
  if (!msg.includes(`"${categoriaEnviada}"`)) return null;
  return `«${etiquetaCategoriaGasto(categoriaEnviada)}» necesita la migración ${migracion} en la base de datos; avisa a sistemas (el gasto no se guardó).`;
}

/**
 * 23514 de uno de los dos CHECK «exige vuelo» del pago al vendedor ⇒ la
 * categoría que nombra el CHECK (la del 400 GASTO_REQUIERE_VUELO). Sale del
 * NOMBRE del CHECK y no del dto: en un PATCH que solo quita el vuelo,
 * `dto.categoria` viene undefined. El nombre viejo
 * (`gasto_comision_vendedor_exige_vuelo`) NO es subcadena del nuevo
 * (`gasto_comision_vendedor_avion_exige_vuelo`). Cualquier otro error ⇒ null.
 */
export function categoriaDeCheckExigeVuelo(error: {
  code?: string | null;
  message?: string | null;
}): string | null {
  if (error.code !== '23514') return null;
  const m = /gasto_comision_vendedor(_avion)?_exige_vuelo/.exec(
    error.message ?? '',
  );
  if (!m) return null;
  return m[1] ? CATEGORIA_PAGO_VENDEDOR_AVION : CATEGORIA_PAGO_VENDEDOR;
}

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
  // COMISION_VENDEDOR (28-sep-2026) y COMISION_VENDEDOR_AVION (13-oct-2026):
  // la comisión siempre es de un vuelo; su candado además aplica a TODOS los
  // roles (`categoriaExigeVueloSiempre`).
  'COMISION_VENDEDOR',
  'COMISION_VENDEDOR_AVION',
]);

/** Prefijo del destino que marca a una categoría como "del vuelo". */
const DESTINO_DIRECTO_DE_VUELO = 'Gastos directos del vuelo';

/**
 * ¿Esta categoría EXIGE vuelo? (helper puro, 11-sep-2026 — pedido de la app:
 * "quiero registrar un gasto sin vuelo").
 *
 * Regla: es del vuelo si su destino por default son los «Gastos directos del
 * vuelo» (ATERRIZAJE, OPERACIONES, TUAS, FBO, COMIDA, COMISARIATO —desde el
 * 13-oct-2026, solo por su destino—, HOTEL, TAXI, PILOTO_EXTERNO) o si está
 * en la lista de arriba (PERMISO y, desde el
 * 28-sep-2026, COMISION_VENDEDOR —y desde el 13-oct-2026
 * COMISION_VENDEDOR_AVION— que además exigen vuelo a TODOS los roles, ver
 * `categoriaExigeVueloSiempre`). Las de
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
