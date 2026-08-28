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
