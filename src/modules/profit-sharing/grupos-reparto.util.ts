/**
 * GRUPOS DEL CLASIFICADOR DEL REPARTO A SOCIOS (doc 4.8): los conjuntos de
 * categorías con que `computeAvion` de `profit-sharing.service.ts` decide
 * el grupo de cada gasto (DIRECTO / INDIRECTO / PERMISO / EXCLUIDO) y el
 * pool de FIJO. Se MUDARON TAL CUAL del servicio el 14-oct-2026 (invariante
 * 74, SIN cambio de conducta: el ternario de `computeAvion` y el pool de
 * FIJO siguen en el servicio, byte a byte) para que la confirmación de
 * «Corregir la fecha del gasto» (`expenses/cambio-fecha-gasto.util.ts`)
 * diga QUÉ reparto se mueve sin redactar un clasificador paralelo: UNA
 * fuente. PURO (sin BD ni Nest); el spec congela la membresía.
 */

/** Categorias de gasto que cuentan como GASTO DIRECTO del avion (doc 4.8). */
export const DIRECTO: ReadonlySet<string> = new Set([
  'GAS',
  // OPERACIONES es la categoría operativa REAL de pistas/aeródromos (la app
  // y el módulo de pistas la usan; ATERRIZAJE/FBO son legacy). Sin ella, las
  // cuotas de VIP SAESA no restaban en el reparto e inflaban la utilidad.
  'OPERACIONES',
  'ATERRIZAJE',
  // 'TUAS' YA NO está aquí (regla 7 del cliente, 28-ago-2026): el TUA pagado
  // al aeropuerto es un traslado al pasajero, no costo del avión — su egreso
  // vive en "Otros movimientos" del Balance general (apareado con el TUA
  // cobrado, que tampoco es venta del avión). Ver TUAS_CAT abajo.
  'FBO',
  'COMIDA',
  'HOTEL',
  'TAXI',
  // Honorario del piloto externo (freelance, doc 3.7): costo directo del
  // vuelo — fuera de este set el reparto lo ignoraría e inflaría la utilidad.
  'PILOTO_EXTERNO',
  // COMISARIATO (13-oct-2026, invariante 63): snacks/bebidas de los
  // PASAJEROS = costo directo del vuelo (columna OTROS del balance); fuera
  // de este set caería a EXCLUIDO e inflaría la utilidad de los socios.
  'COMISARIATO',
  // «Otros gastos directos del vuelo» (20-oct-2026, invariante 97): la misma
  // regla que COMISARIATO (columna OTROS del balance).
  'OTROS_DIRECTOS_VUELO',
  // 'OTRO' YA NO está aquí (regla del cliente, 11-sep-2026 — LA CATEGORÍA DE
  // EMPRESA MANDA SOBRE EL VUELO): un OTRO con vuelo es gasto de VuelaTour,
  // no costo del avión. Ver `categoriaEsDeEmpresa` en el clasificador de
  // `computeAvion`. Sus PARTES de reparto manual sí van al avión.
]);
/** Talleres, aceites, refacciones, mecanicos. */
// La CATEGORÍA de gasto 'INDIRECTO' (captura sin vuelo, jul 2026) estuvo
// FUERA de todo set «hasta que el equipo decida su tratamiento»: el reparto
// la EXCLUÍA mientras el balance por avión la pintaba en su hoja «Gastos
// Indirectos». DECISIÓN DEL CLIENTE (20-oct-2026, invariante 99): «el total
// de Gastos indirectos no cuadra [388,937.57 en el Excel vs 318,737.57 en el
// reparto]… debemos hacer que cuadren» — eran 7 gastos INDIRECTO de N621TX
// (piloto/mecánico/administrativo de dos quincenas + una propina, 70,200
// MXN) que el balance cuenta. Desde hoy un INDIRECTO sellado a un avión
// cuenta como gasto INDIRECTO del avión, igual que en el balance.
// NOMINA (29-ago) NO: sin repartir = EXCLUIDA (gasto de la empresa,
// invariante 91); repartida a mano SÍ cuenta al avión (grupo INDIRECTO, ver
// compute).
// SERVICIOS (29-ago) es espejo de REFACCION: gasto directo del avión.
export const INDIRECTO: ReadonlySet<string> = new Set([
  'REFACCION',
  'SERVICIOS',
  'INDIRECTO',
]);
export const PERMISO: ReadonlySet<string> = new Set(['PERMISO']);
/**
 * Sueldos, seguros: se prorratean entre aviones activos (doc 4.8).
 *
 * NO es una excepción a la regla de empresa del 11-sep-2026: el FIJO nunca
 * se carga al avión DEL VUELO ni al avión sellado — sale del pool y se
 * reparte entre TODA la flota activa (`otrosPorAvion`). Lo que la regla
 * prohíbe es que el vuelo/avión de un gasto de empresa lo convierta en costo
 * de ESE avión; el prorrateo de sueldos entre la flota es otra decisión
 * (doc 4.8) y sigue viva. Un FIJO REPARTIDO a mano sí va a los aviones de
 * sus parciales (el reparto manual gana) y sale del pool.
 */
export const FIJO = 'FIJO';
/**
 * TUA pagado (regla 7, 28-ago-2026): grupo EXCLUIDO del reparto — solo nota de
 * operación; el egreso se aparea con el TUA cobrado en Otros movimientos.
 */
export const TUAS_CAT = 'TUAS';
