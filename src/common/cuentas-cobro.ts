import type { CobrosUsd } from './cobros-usd.util';
import { etiquetaMetodoCobro } from './metodo-cobro.util';
import { TOLERANCIA_COBRO_USD } from './semaforo-cobro.util';

/**
 * Cuentas que RECIBEN los cobros de vuelos (lista fija del cliente,
 * 28-ago-2026). Se guarda el nombre tal cual en `cobro_vuelo.cuenta_destino`
 * — el panel la ofrece como selector y el balance la muestra junto a la
 * comisión del banco para saber por dónde entró el dinero.
 */
export const CUENTAS_COBRO = [
  'Paywise',
  'HSBC Dólares',
  'HSBC Pesos',
  'Scotiabank Dólares',
  'Scotiabank Pesos',
] as const;

export type CuentaCobro = (typeof CUENTAS_COBRO)[number];

// ===== FACTURA OBLIGATORIA POR CUENTA DE COBRO (13-oct-2026, invariante 60) =====
//
// Decisión del cliente (lote del 13-oct-2026, decisión 4): un cobro que cae
// en HSBC Dólares / HSBC Pesos / Scotiabank Dólares / Scotiabank Pesos EXIGE
// factura del servicio al cliente. Paywise NO (link/pasarela sin factura,
// como BillPocket). Cuando el cobro no trae cuenta (o trae una fuera del
// catálogo), decide el MÉTODO: link de pago HSBC, transferencia y cheque
// exigen; BillPocket, efectivo, Paywise, dólares directo y «otro» no. Los
// reembolsos (monto ≤ 0) nunca exigen por sí solos.
//
// NETO (revisión 13-oct-2026; anticipo devuelto, decisión del cliente del
// 14-oct-2026: «¿Un anticipo devuelto lleva CFDI?» ⇒ «eso no»; API 0.0.77):
// a nivel VUELO la exigencia se decide por lo que QUEDÓ. Un reembolso (fila
// negativa de `createReembolso`, que conserva cuenta y método) se clasifica
// por SU cuenta/método sin mirar el signo y resta de ese grupo (cuenta o
// método sin cuenta + moneda). Regla 1, por moneda y sin T.C.: si una moneda
// quedó en cero (cobros y reembolsos de CUALQUIER cuenta o método), ningún
// grupo de esa moneda exige — el dinero devuelto completo no lleva factura
// salga por donde salga (misma cuenta, efectivo, otra cuenta o sin cuenta).
// Regla 2, SOLO en una devolución CRUZADA (alguna moneda quedó negativa: el
// reembolso salió en la otra moneda): si `cobrosEnUsd` del vuelo convirtió
// todo y quedó ≤ 1 USD (`TOLERANCIA_COBRO_USD`), nada exige. Lo retenido de
// una devolución parcial exige si quedó en una cuenta o método que la exige
// (también a ≤ 1 USD en la misma moneda: la regla 2 no se evalúa sin una
// moneda negativa); mezcla de cuentas en la MISMA moneda ⇒ conservador
// (exige); ENTRE monedas la moneda identifica el dinero (pesos devueltos
// completos y dólares retenidos en un método que no exige ⇒ no exige:
// excepción consciente, pregunta abierta al cliente). USD y MXN nunca se
// suman; un reembolso sin moneda no netea. Sin `cobrado` (lector sin T.C.)
// solo aplica la regla 1 (conservador).
//
// La regla es por CUENTA/MÉTODO, no por rol: el PILOTO también la dispara
// desde la app con HSBC_LINK (está en la whitelist `METODOS_COBRO_PILOTO` de
// flights.service.ts).
//
// FUENTE ÚNICA (pura, sin Nest ni Supabase): la consumen la columna «FACTURA
// VUELATOUR» de los Excel (`facturasDeVuelos`), la solicitud automática de
// factura (`FacturaSolicitudService.solicitarPorCobro`), el item de
// pre-cierre «vuelos cobrados en cuentas que exigen factura sin factura
// registrada» y —desde el 0.0.77— el bloque `factura_servicio` (`exigencia`,
// `origenes_exigen`: el panel ya no decide, pinta) y la marca
// `diferencia_cambiaria` del pre-cierre `cobros_en_cancelados`
// (`dineroDevueltoCompleto`). `cobrado` lo arma SOLO el lector con
// `cobrosEnUsd(cobros, vuelo.tc_usd_mxn)`. Las etiquetas de método salen
// SIEMPRE de `etiquetaMetodoCobro` (jamás la etiqueta retirada «HSBC link»,
// invariante 7).

/** Subconjunto de `CUENTAS_COBRO` que exige factura ('Paywise' queda fuera). */
export const CUENTAS_COBRO_EXIGEN_FACTURA = [
  'HSBC Dólares',
  'HSBC Pesos',
  'Scotiabank Dólares',
  'Scotiabank Pesos',
] as const;

/**
 * Respaldo por MÉTODO, SOLO cuando `cuenta_destino` está vacía o fuera del
 * catálogo (cobros viejos, anticipo aplicado, «es el pago de un vuelo» desde
 * el banco, cobro del piloto por link HSBC).
 */
export const METODOS_COBRO_EXIGEN_FACTURA_SIN_CUENTA: readonly string[] = [
  'HSBC_LINK',
  'TRANSFERENCIA',
  'CHEQUE',
];

/** Lo mínimo de un `cobro_vuelo` (o del sobre `cobro_grupo`) para decidir. */
export interface CobroExigeFacturaRow {
  cuenta_destino?: unknown;
  metodo_cobro?: unknown;
  monto?: unknown;
  /**
   * Moneda del cobro (`cobro_vuelo.moneda`; revisión 13-oct-2026): con ella
   * un reembolso NETEA contra los cobros de su misma cuenta/método y moneda
   * (`vueloExigeFactura`, `cuentasQueExigenFactura`) y la moneda entera se
   * mide por la regla 1 (14-oct-2026). Sin ella el reembolso no netea nada
   * (jamás se suman USD y MXN). `cobroExigeFactura` no la usa.
   */
  moneda?: unknown;
  /**
   * T.C. del cobro (`cobro_vuelo.tc_usd_mxn`; 14-oct-2026, API 0.0.77): la
   * regla NO lo usa; lo lee el LECTOR para armar `cobrado` con la fuente
   * única `cobrosEnUsd(cobros, vuelo.tc_usd_mxn)`.
   */
  tc_usd_mxn?: unknown;
}

/**
 * Lo cobrado del vuelo en USD por la fuente única
 * `cobrosEnUsd(cobros, vuelo.tc_usd_mxn)` (invariante 2): el insumo de la
 * regla 2 (devolución CRUZADA). Lo arma SOLO el lector; null/ausente = el
 * llamador no tiene T.C. ⇒ solo aplica la regla 1 (conservador).
 */
export type CobradoDelVuelo = Pick<CobrosUsd, 'total_usd' | 'sin_tc_count'>;

function cuentaTexto(cuenta: unknown): string {
  return typeof cuenta === 'string' ? cuenta.trim() : '';
}

function metodoTexto(metodo: unknown): string {
  return typeof metodo === 'string' ? metodo.trim() : '';
}

function monedaTexto(moneda: unknown): string {
  return typeof moneda === 'string' ? moneda.trim() : '';
}

/** Lo que queda en un grupo por debajo de esto es cero (centavos). */
const TOLERANCIA_NETO = 0.005;

/**
 * ¿La CUENTA decide? `true` = exige (una de las cuatro), `false` = no exige
 * ('Paywise'), `null` = no decide (vacía, null o un texto fuera de
 * `CUENTAS_COBRO`: entonces decide el método).
 */
export function cuentaExigeFactura(cuenta: unknown): boolean | null {
  const t = cuentaTexto(cuenta);
  if (!t) return null;
  if ((CUENTAS_COBRO_EXIGEN_FACTURA as readonly string[]).includes(t)) {
    return true;
  }
  if ((CUENTAS_COBRO as readonly string[]).includes(t)) return false;
  return null;
}

/**
 * ¿ESTE cobro exige factura? Monto no finito o ≤ 0 (reembolsos) ⇒ nunca; la
 * cuenta MANDA cuando decide; si no, decide el método (vacío ⇒ no).
 */
export function cobroExigeFactura(c: CobroExigeFacturaRow): boolean {
  const monto = Number(c.monto);
  if (!Number.isFinite(monto) || monto <= 0) return false;
  const porCuenta = cuentaExigeFactura(c.cuenta_destino);
  if (porCuenta !== null) return porCuenta;
  const metodo = metodoTexto(c.metodo_cobro);
  return (
    metodo !== '' && METODOS_COBRO_EXIGEN_FACTURA_SIN_CUENTA.includes(metodo)
  );
}

/** Tri-estado del VUELO (la etiqueta de la columna es del vuelo). */
export type ExigenciaFacturaVuelo = 'EXIGE' | 'NO_EXIGE' | 'SIN_COBROS';

function cobrosPositivos<T extends CobroExigeFacturaRow>(
  cobros: ReadonlyArray<T>,
): T[] {
  return cobros.filter((c) => {
    const m = Number(c.monto);
    return Number.isFinite(m) && m > 0;
  });
}

/** Filas con monto finito ≠ 0 (el 0 y lo no numérico no son dinero). */
function filasConDinero<T extends CobroExigeFacturaRow>(
  cobros: ReadonlyArray<T>,
): T[] {
  return cobros.filter((c) => {
    const m = Number(c.monto);
    return Number.isFinite(m) && m !== 0;
  });
}

/** ¿Hay al menos un cobro positivo Y un reembolso? */
function hayCobroYReembolso(
  filas: ReadonlyArray<CobroExigeFacturaRow>,
): boolean {
  return (
    filas.some((c) => Number(c.monto) > 0) &&
    filas.some((c) => Number(c.monto) < 0)
  );
}

/**
 * Σ por moneda (`moneda` recortada) de las filas con monto finito ≠ 0 —
 * cobros Y reembolsos de CUALQUIER cuenta o método—; un reembolso SIN moneda
 * no entra (jamás se suman monedas). Insumo de la regla 1 (14-oct-2026).
 */
export function sumaPorMoneda(
  cobros: ReadonlyArray<CobroExigeFacturaRow>,
): Map<string, number> {
  const suma = new Map<string, number>();
  for (const c of filasConDinero(cobros)) {
    const m = Number(c.monto);
    const moneda = monedaTexto(c.moneda);
    if (m < 0 && moneda === '') continue;
    suma.set(moneda, (suma.get(moneda) ?? 0) + m);
  }
  return suma;
}

/**
 * REGLA 2 — devolución CRUZADA completa (decisión del cliente del
 * 14-oct-2026; revisión F1): SOLO si alguna moneda quedó con Σ < −0.005 (el
 * reembolso salió en la OTRA moneda), hay al menos un cobro positivo y un
 * reembolso, toda fila con dinero es USD o MXN (los dos literales que
 * convierte `cobrosEnUsd`), y `cobrado` convirtió TODO (`sin_tc_count` 0) y
 * quedó ≤ `TOLERANCIA_COBRO_USD` (1). Sin una moneda negativa NO se evalúa:
 * una devolución PARCIAL en la misma moneda no pasa por «completa» por
 * quedar a ≤ 1 USD (p. ej. 1,500 MXN de penalización retenidos con el
 * reembolso tecleado al T.C. mínimo que pasa el candado de
 * `createReembolso`). Sin `cobrado` ⇒ false (conservador).
 */
export function devolucionCruzadaCompleta(
  cobros: ReadonlyArray<CobroExigeFacturaRow>,
  cobrado?: CobradoDelVuelo | null,
): boolean {
  if (!cobrado) return false;
  const suma = sumaPorMoneda(cobros);
  if (![...suma.values()].some((s) => s < -TOLERANCIA_NETO)) return false;
  const filas = filasConDinero(cobros);
  if (!hayCobroYReembolso(filas)) return false;
  if (!filas.every((c) => c.moneda === 'USD' || c.moneda === 'MXN')) {
    return false;
  }
  return (
    cobrado.sin_tc_count === 0 && cobrado.total_usd <= TOLERANCIA_COBRO_USD
  );
}

/**
 * DEFINICIÓN ÚNICA de «el dinero del vuelo se devolvió COMPLETO»
 * (14-oct-2026): hubo cobro positivo y reembolso, y toda moneda quedó con
 * Σ ≤ 0.005 (regla 1) o es una devolución CRUZADA completa (regla 2). La usa
 * el pre-cierre `cobros_en_cancelados` para su marca `diferencia_cambiaria`
 * (lo que el reparto todavía cuenta de un vuelo así es diferencia
 * cambiaria). `netosQueExigen` aplica exactamente las mismas dos reglas.
 */
export function dineroDevueltoCompleto(
  cobros: ReadonlyArray<CobroExigeFacturaRow>,
  cobrado?: CobradoDelVuelo | null,
): boolean {
  if (!hayCobroYReembolso(filasConDinero(cobros))) return false;
  if (devolucionCruzadaCompleta(cobros, cobrado)) return true;
  return [...sumaPorMoneda(cobros).values()].every((s) => s <= TOLERANCIA_NETO);
}

/** Lo que quedó en una cuenta (o método sin cuenta) que exige factura. */
interface NetoQueExige {
  /** `cuentaDeCobroTexto` del grupo ('HSBC Pesos' / 'Transferencia sin cuenta destino'). */
  texto: string;
  /** `origenCobroTexto` del grupo ('en HSBC Pesos' / 'por Transferencia'). */
  origen: string;
  neto: number;
}

/**
 * NETO por grupo (`cuentaDeCobroTexto` + moneda) de los cobros que EXIGEN
 * factura, en orden de aparición (revisión 13-oct-2026). Cada fila se
 * clasifica por su cuenta/método SIN mirar el signo (`cobroExigeFactura`
 * con |monto|): un reembolso resta del grupo de SU cuenta y moneda. Un
 * reembolso sin moneda no netea (jamás se suman monedas); un cobro positivo
 * sin moneda cuenta en su propio grupo, como siempre. ANTICIPO DEVUELTO
 * (14-oct-2026): la regla 2 (`devolucionCruzadaCompleta`) vacía la lista y
 * la regla 1 salta los grupos de una moneda cuya Σ total quedó ≤ 0.005.
 */
function netosQueExigen(
  cobros: ReadonlyArray<CobroExigeFacturaRow>,
  cobrado?: CobradoDelVuelo | null,
): NetoQueExige[] {
  if (devolucionCruzadaCompleta(cobros, cobrado)) return []; // regla 2
  const suma = sumaPorMoneda(cobros);
  const grupos = new Map<string, NetoQueExige>();
  for (const c of cobros) {
    const m = Number(c.monto);
    if (!Number.isFinite(m) || m === 0) continue;
    if (!cobroExigeFactura({ ...c, monto: Math.abs(m) })) continue;
    const moneda = monedaTexto(c.moneda);
    if (m < 0 && moneda === '') continue;
    // Regla 1: esa moneda se devolvió completa (cualquier cuenta o método).
    if ((suma.get(moneda) ?? 0) <= TOLERANCIA_NETO) continue;
    const texto = cuentaDeCobroTexto(c);
    const clave = `${texto}\u0000${moneda}`;
    const g = grupos.get(clave);
    if (g) g.neto += m;
    else grupos.set(clave, { texto, origen: origenCobroTexto(c), neto: m });
  }
  return [...grupos.values()];
}

/**
 * Exigencia del VUELO sobre TODOS sus cobros (de cualquier fecha; las
 * partes de un sobre de grupo entran porque `crearParte` copia cuenta y
 * método del sobre a cada parte): sin cobros positivos (vacío o solo
 * reembolsos) ⇒ SIN_COBROS; si en alguna cuenta (o método sin cuenta) que
 * exige QUEDA dinero —neto de sus reembolsos, por moneda: `netosQueExigen`—
 * ⇒ EXIGE; si no ⇒ NO_EXIGE (también un anticipo devuelto completo por
 * cualquier vía: reglas 1 y 2). `cobrado` = `cobrosEnUsd(cobros,
 * vuelo.tc_usd_mxn)` del lector (insumo de la regla 2); sin él solo aplica la
 * regla 1.
 */
export function vueloExigeFactura(
  cobros: ReadonlyArray<CobroExigeFacturaRow>,
  cobrado?: CobradoDelVuelo | null,
): ExigenciaFacturaVuelo {
  const positivos = cobrosPositivos(cobros);
  if (positivos.length === 0) return 'SIN_COBROS';
  return netosQueExigen(cobros, cobrado).some((g) => g.neto > TOLERANCIA_NETO)
    ? 'EXIGE'
    : 'NO_EXIGE';
}

/**
 * Cuenta del cobro como texto: la capturada tal cual ('HSBC Pesos') o, sin
 * cuenta, la etiqueta del método ('Transferencia sin cuenta destino', 'Link
 * de pago (HSBC) sin cuenta destino', 'Cheque sin cuenta destino').
 */
export function cuentaDeCobroTexto(c: CobroExigeFacturaRow): string {
  const cuenta = cuentaTexto(c.cuenta_destino);
  if (cuenta) return cuenta;
  const metodo = metodoTexto(c.metodo_cobro);
  return `${etiquetaMetodoCobro(metodo || null)} sin cuenta destino`;
}

/**
 * Origen del cobro para notas y avisos: 'en HSBC Pesos' (con cuenta) o 'por
 * Transferencia' / 'por Link de pago (HSBC)' / 'por Cheque' (sin cuenta).
 */
export function origenCobroTexto(c: CobroExigeFacturaRow): string {
  const cuenta = cuentaTexto(c.cuenta_destino);
  if (cuenta) return `en ${cuenta}`;
  const metodo = metodoTexto(c.metodo_cobro);
  return `por ${etiquetaMetodoCobro(metodo || null)}`;
}

/**
 * `cuentaDeCobroTexto` DISTINTOS, en orden de aparición, SOLO de las cuentas
 * (o métodos sin cuenta) que exigen factura y en las que QUEDÓ dinero, neto
 * de sus reembolsos por moneda (para el pre-cierre; revisión 13-oct-2026),
 * con las reglas 1 y 2 del anticipo devuelto (`cobrado` como en
 * `vueloExigeFactura`).
 */
export function cuentasQueExigenFactura(
  cobros: ReadonlyArray<CobroExigeFacturaRow>,
  cobrado?: CobradoDelVuelo | null,
): string[] {
  const out: string[] = [];
  for (const g of netosQueExigen(cobros, cobrado)) {
    if (g.neto <= TOLERANCIA_NETO) continue;
    if (!out.includes(g.texto)) out.push(g.texto);
  }
  return out;
}

/**
 * `origenCobroTexto` DISTINTOS ('en HSBC Pesos' / 'por Transferencia'), en
 * orden de aparición, de los MISMOS grupos que `cuentasQueExigenFactura`
 * (neto > 0.005 con las reglas 1 y 2). Desde el API 0.0.77 viaja en
 * `factura_servicio.origenes_exigen`: el panel arma con ellos el chip
 * «Factura obligatoria: cobro en HSBC Pesos» sin decidir nada.
 */
export function origenesQueExigenFactura(
  cobros: ReadonlyArray<CobroExigeFacturaRow>,
  cobrado?: CobradoDelVuelo | null,
): string[] {
  const out: string[] = [];
  for (const g of netosQueExigen(cobros, cobrado)) {
    if (g.neto <= TOLERANCIA_NETO) continue;
    if (!out.includes(g.origen)) out.push(g.origen);
  }
  return out;
}
