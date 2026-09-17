/**
 * TIPO DE CAMBIO — PRECISIÓN ÚNICA DEL SISTEMA (17-sep-2026).
 *
 * EL PROBLEMA (vuelo #314): la hoja de la cotización imprimía
 * «Total MXN (T.C. 16.9916) $100,000.00» y el diálogo «Registrar cobro»
 * decía «Total ≈ MXN $99,999.81». El operador captura el T.C. con los
 * decimales que necesita para que el total en pesos salga redondo
 * (100000 / 5885.25 = 16.991631749…); el motor componía
 * `monto_total_mxn = 100,000.00` con ESE TC completo y lo persistía, pero la
 * columna `vuelo.tc_usd_mxn` era `numeric(10,4)` y Postgres GUARDABA 16.9916.
 * Desde ahí, cualquier lector que RECALCULARA `usd × tc` obtenía 99,999.81 y
 * un cobro de 100,000 MXN convertía a 5,885.26 USD (un centavo de deuda
 * fantasma). Cita del cliente: «ese cambio cuando hace la conversión a pesos,
 * no sé por qué cuando son muchos decimales como que siempre cambia a como
 * está en la cotización».
 *
 * LAS DOS REGLAS (invariante 7 del repo):
 *
 * 1. **Un TC se guarda con 6 DECIMALES** (`numeric(12,6)` en `vuelo`,
 *    `cobro_vuelo`, `cobro_grupo`, `vuelo_grupo`, `cotizacion_version_history`
 *    y `gasto.tc_gasto`). TODO escritor lo pasa antes por `normalizarTc`, de
 *    modo que **lo que se persiste es EXACTAMENTE lo que se usó para
 *    componer los pesos** — nunca más la BD redondea a espaldas del motor.
 *    (`tipo_cambio_oficial.tc`, `compra.tc_usd_mxn` e
 *    `inventario_movimiento.tc_usd_mxn` se quedan en 4 decimales a propósito:
 *    son referencia y compras, no el precio que el cliente vio.)
 *
 * 2. **El total en pesos de un vuelo se LEE, jamás se recalcula**:
 *    `totalMxnDeVuelo` devuelve `monto_total_mxn` (el número exacto que el
 *    cliente vio en su cotización, compuesto por el motor con los renglones
 *    nativos en MXN incluidos) y solo cae a `round2(usd × tc)` cuando el
 *    vuelo no tiene total persistido (externos viejos, altas sin motor).
 *    Multiplicar `usd × tc` por tu cuenta reintroduce el bug aunque el TC
 *    tenga 6 decimales, porque las TUAS/extras capturadas en pesos entran al
 *    total TAL CUAL y no pasan por el TC.
 */

/** Decimales canónicos de un tipo de cambio en este sistema. */
export const TC_DECIMALES = 6;

const FACTOR_TC = 10 ** TC_DECIMALES;

/** Redondeo a 6 decimales (la precisión con la que la BD guarda un TC). */
export function round6(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  const abs = Math.abs(n);
  const r = Math.round((abs + Number.EPSILON) * FACTOR_TC) / FACTOR_TC;
  return n < 0 ? -r : r;
}

/** Redondeo a centavos (interno: la moneda siempre cierra en 2 decimales). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Normaliza un TC capturado (DTO, importador, derivación) a la precisión
 * canónica. `null` cuando no es un número positivo — "sin TC" se propaga
 * explícito (los lectores ya saben exponerlo en `sin_tc_*`), nunca como 0.
 *
 * Es IDEMPOTENTE: aplicarla a un TC ya normalizado devuelve el mismo valor,
 * así que un escritor puede llamarla en el motor y otra vez al persistir sin
 * que el número se mueva.
 */
export function normalizarTc(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return round6(n);
}

/** Columnas de dinero de un vuelo que definen su total en pesos. */
export interface VueloTotalMxn {
  /** `vuelo.monto_total_mxn`: el total EXACTO por composición del motor. */
  monto_total_mxn?: unknown;
  /** `vuelo.monto_total_usd`. */
  monto_total_usd?: unknown;
  /** `vuelo.tc_usd_mxn` (6 decimales). */
  tc_usd_mxn?: unknown;
}

/**
 * FUENTE ÚNICA del "total en pesos" de un vuelo.
 *
 * - Con `monto_total_mxn` persistido (lo normal desde el motor v1.3): ESE es
 *   el número — el mismo que se imprimió en la cotización del cliente. Un 0
 *   legítimo (cliente interno) también se respeta.
 * - Sin él: último respaldo `round2(monto_total_usd × tc_usd_mxn)`.
 * - Sin total en pesos ni TC: `null` (nunca 0 en falso).
 */
export function totalMxnDeVuelo(v: VueloTotalMxn): number | null {
  if (v.monto_total_mxn != null && v.monto_total_mxn !== '') {
    const persistido = Number(v.monto_total_mxn);
    if (Number.isFinite(persistido)) return persistido;
  }
  if (v.monto_total_usd == null || v.monto_total_usd === '') return null;
  const usd = Number(v.monto_total_usd);
  const tc = normalizarTc(v.tc_usd_mxn);
  if (!Number.isFinite(usd) || tc == null) return null;
  return round2(usd * tc);
}
