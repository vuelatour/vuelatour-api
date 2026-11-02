/**
 * NÚMERO DE FACTURA Y FECHA DE PAGO EN «PISTAS POR PAGAR» (2-nov-2026, API
 * 0.0.115, invariante 114). Pedido de la oficina: «un cuadro donde pueda
 * poner número de factura y fecha de pago» al generar los gastos de pista.
 *
 * Una factura de VIP SAESA ampara VARIOS aterrizajes y `gasto.folio_ticket`
 * es ÚNICO en la BD (`uq_gasto_folio_ticket_norm`, desde 4 caracteres): el
 * segundo gasto con el mismo folio rebotaría con 409. La regla de la oficina
 * para «una factura ↔ varios gastos» ya existe: «fact NNNN» en la PRIMERA
 * línea de las notas de cada gasto, que Conciliación lee
 * (`factura-concepto.util#numerosDeGasto`). Aquí se escribe «Factura NNNN»
 * como primera línea; si lo tecleado ya empieza con la clave (fact, factura,
 * fac, prefactura) se respeta tal cual. El amarre real del CFDI sigue siendo
 * Facturas recibidas (`POST /invoices/recibidas/de-gasto`).
 *
 * PURO, con spec (`pistas-generar.util.spec.ts`, que además comprueba que
 * Conciliación lee el número de la línea escrita).
 */

/** Largo máximo del número de factura capturado (DTO `MaxLength`). */
export const FACTURA_PISTAS_MAX = 40;

/** Clave que Conciliación reconoce al inicio: fac / fact / factura(s) / prefactura. */
const CLAVE_FACTURA = /^(pre\s*)?fac(t(ura)?s?)?\b/i;

/** Primera línea de las notas con la factura, o null si no se capturó. */
export function lineaFacturaPistas(
  folio: string | null | undefined,
): string | null {
  const limpio = (folio ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FACTURA_PISTAS_MAX);
  if (!limpio) return null;
  return CLAVE_FACTURA.test(limpio) ? limpio : `Factura ${limpio}`;
}

/** Notas del gasto de pista: la factura (si hay) va en la PRIMERA línea. */
export function notasConFactura(
  folio: string | null | undefined,
  notas: string,
): string {
  const linea = lineaFacturaPistas(folio);
  return linea ? `${linea}\n${notas}` : notas;
}
