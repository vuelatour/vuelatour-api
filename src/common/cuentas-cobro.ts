import { etiquetaMetodoCobro } from './metodo-cobro.util';

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
// reembolsos (monto ≤ 0) nunca exigen.
//
// La regla es por CUENTA/MÉTODO, no por rol: el PILOTO también la dispara
// desde la app con HSBC_LINK (está en la whitelist `METODOS_COBRO_PILOTO` de
// flights.service.ts).
//
// FUENTE ÚNICA (pura, sin Nest ni Supabase): la consumen la columna «FACTURA
// VUELATOUR» de los Excel (`facturasDeVuelos`), la solicitud automática de
// factura (`FacturaSolicitudService.solicitarPorCobro`) y el item de
// pre-cierre «vuelos cobrados en cuentas que exigen factura sin factura
// registrada». Las etiquetas de método salen SIEMPRE de `etiquetaMetodoCobro`
// (jamás la etiqueta retirada «HSBC link», invariante 7).

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
}

function cuentaTexto(cuenta: unknown): string {
  return typeof cuenta === 'string' ? cuenta.trim() : '';
}

function metodoTexto(metodo: unknown): string {
  return typeof metodo === 'string' ? metodo.trim() : '';
}

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

/**
 * Exigencia del VUELO sobre TODOS sus cobros positivos (de cualquier fecha;
 * las partes de un sobre de grupo entran porque `crearParte` copia cuenta y
 * método del sobre a cada parte): alguno exige ⇒ EXIGE; ninguno ⇒ NO_EXIGE;
 * sin cobros positivos (vacío o solo reembolsos) ⇒ SIN_COBROS.
 */
export function vueloExigeFactura(
  cobros: ReadonlyArray<CobroExigeFacturaRow>,
): ExigenciaFacturaVuelo {
  const positivos = cobrosPositivos(cobros);
  if (positivos.length === 0) return 'SIN_COBROS';
  return positivos.some((c) => cobroExigeFactura(c)) ? 'EXIGE' : 'NO_EXIGE';
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
 * `cuentaDeCobroTexto` DISTINTOS, en orden de aparición, SOLO de los cobros
 * que exigen factura (para el pre-cierre).
 */
export function cuentasQueExigenFactura(
  cobros: ReadonlyArray<CobroExigeFacturaRow>,
): string[] {
  const out: string[] = [];
  for (const c of cobros) {
    if (!cobroExigeFactura(c)) continue;
    const t = cuentaDeCobroTexto(c);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
