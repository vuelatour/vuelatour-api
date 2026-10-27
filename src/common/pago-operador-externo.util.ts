/**
 * EL PAGO AL OPERADOR EXTERNO SE MARCA EN EL GASTO (27-oct-2026, API
 * 0.0.110, invariante 110, migración `20261027000001`). PURO, con spec.
 *
 * Caso #453 (oscar02-251026, Simon Herrera, 25-oct-2026): la oficina cotizó
 * «lo que cobra el operador» en $840 USD; al pagarle, Simon cobró 840 + IVA
 * al T.C. del día = $18,182.00 MXN, capturado como gasto OPERACIONES del
 * vuelo. La coincidencia ±1 % de la invariante 88 no lo reconoció (17 %
 * arriba) y el Balance general sumó los dos en OPERACIONES. Pedido de la
 * oficina: «que lo que yo ponga en la cotización sea informativo … y que
 * tome nada más de referencia el gasto que puso Ale».
 *
 * Regla: el gasto que la oficina MARCA `es_pago_operador_externo` ES el pago
 * al operador (uno o varios: anticipo + liquidación). Con marca, la
 * coincidencia de montos deja de decidir; el costo cotizado
 * (`vuelo.costo_externo_*`) queda como referencia del margen al cotizar y
 * como nota en los libros. Sin marca, la invariante 88 sigue igual.
 *
 * Quién marca: la OFICINA (los mismos roles que marcan «Pago de AFAC»); solo
 * en un gasto CON vuelo cubierto por externo y de una categoría que resta en
 * las columnas del vuelo (`gastoRestaEnColumnasDelVuelo`). La BD garantiza
 * marca ⇒ vuelo externo (trigger `trg_gasto_pago_operador_externo_con_vuelo`:
 * sin vuelo o con vuelo propio la marca se apaga en la misma escritura); el
 * API valida categoría, rol y vuelo ANTES de escribir, con mensajes claros.
 */
import { Rol } from './types/auth.types';
import { ROLES_AFAC_REAL } from './afac-real.util';

/** Lo mínimo de un gasto para decidir la marca. */
export interface GastoConMarcaPagoOperador {
  es_pago_operador_externo?: boolean | null;
}

/**
 * Fuente ÚNICA de «¿este gasto es el pago al operador externo?». Sin la
 * columna en la lectura ⇒ `undefined` ⇒ false.
 */
export function esPagoOperadorExterno(
  g: GastoConMarcaPagoOperador | null | undefined,
): boolean {
  return g != null && g.es_pago_operador_externo === true;
}

/** Quién marca el pago al operador: la oficina (los mismos roles del AFAC). */
export const ROLES_PAGO_OPERADOR_EXTERNO: readonly Rol[] = ROLES_AFAC_REAL;

/** ¿El rol puede marcar/desmarcar «pago al operador externo»? */
export function rolMarcaPagoOperador(rol: Rol | null | undefined): boolean {
  return rol != null && ROLES_PAGO_OPERADOR_EXTERNO.includes(rol);
}

/** Códigos de error (`error`) del 400/403 de la marca. */
export const CODIGO_PAGO_OPERADOR = {
  SOLO_OFICINA: 'PAGO_OPERADOR_SOLO_OFICINA',
  SIN_VUELO: 'PAGO_OPERADOR_SIN_VUELO',
  VUELO_NO_EXTERNO: 'PAGO_OPERADOR_VUELO_NO_EXTERNO',
  CATEGORIA: 'PAGO_OPERADOR_CATEGORIA',
} as const;

export const MENSAJE_PAGO_OPERADOR_SOLO_OFICINA =
  'Solo la oficina (admin, facturación o coordinador) puede marcar un gasto como pago al operador externo.';
export const MENSAJE_PAGO_OPERADOR_SIN_VUELO =
  'Para marcar el gasto como pago al operador externo, primero liga el gasto al vuelo que cubrió ese operador.';
export function mensajePagoOperadorVueloNoExterno(
  folio: number | string | null | undefined,
): string {
  const ref = folio != null && folio !== '' ? `#${folio}` : 'elegido';
  return `El vuelo ${ref} no está cubierto por un operador externo: la marca «pago al operador externo» solo aplica a vuelos cubiertos por externo (Detalle del vuelo → Cubrir con externo).`;
}
export const MENSAJE_PAGO_OPERADOR_CATEGORIA =
  'Esta categoría no puede ser el pago al operador externo: usa una categoría del vuelo (por ejemplo Operaciones); TUAS, combustible, permisos, gastos de empresa, pago al vendedor y «otros movimientos» no restan en las columnas del vuelo.';
