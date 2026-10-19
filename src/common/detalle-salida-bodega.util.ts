/**
 * DETALLE de una SALIDA DE BODEGA en los balances, SIN el precio de compra
 * ni el de venta (19-oct-2026, pedido del cliente con la captura de la hoja
 * «refacciones» del XA-VGV: «debemos quitar de la descripción de cosas que
 * se le han cargado al avión lo del precio en el que se compró y en lo que
 * se vendió, porque eso nos delata con los socios si ven este balance»).
 *
 * La nota que el API guarda en el gasto REFACCION / BODEGA de una salida
 * (`inventory.service#crearGastoDeSalida` y la de toda la flota) dice cómo se
 * fijó el cargo: «(precio de venta)», «(último precio + 25 %)», «(a costo)»
 * —hasta el 0.0.35, «(costo FIFO + 25 %)» / «(costo FIFO)»—, la de flota
 * «(toda la flota, 1/7 del precio de venta): … (precio de venta $36.42
 * USD)», y las 10 salidas del 01-sep llevan además la cláusula del re-precio
 * («Re-preciado 25-sep-2026: costo FIFO + 25 % (utilidad de la tienda
 * VuelaTour…); antes $373.75 USD», migración 20260925000002). Las de jul/ago
 * llevan «Corrección 28-ago-2026: costo en PESOS…». Todo eso es información
 * de VuelaTour (cuánto le costó la pieza y su margen): el socio solo debe
 * leer QUÉ se le cargó («Salida de bodega: 1 × Llanta 6.00-6»); el MONTO
 * cargado sigue en su columna.
 *
 * Regla (PURA, solo texto; jamás toca la nota guardada — la oficina la sigue
 * viendo completa en Gastos):
 *  - solo se tocan los renglones que EMPIEZAN con «Salida de bodega»; los
 *    demás pasan tal cual;
 *  - del primer tramo (antes del primer « · ») se quita la etiqueta del
 *    precio al FINAL —una presentación como «(Galón)» o «(2 barrenos)» se
 *    queda— y, en la de flota, «del precio de venta» / «del costo»;
 *  - de los tramos siguientes se quitan «ref 0» (relleno, como en el cardex),
 *    «Re-preciado…/Re-preciada…» y «Corrección …: costo…»; una referencia
 *    real («ref OT-123») u otro texto que agregó la oficina se queda.
 */

const PREFIJO_SALIDA = 'Salida de bodega';
const SEPARADOR = ' · ';

/** Etiqueta de cómo se fijó el cargo, al final del primer tramo. */
const RE_ETIQUETA_PRECIO =
  /\s*\((?:precio de venta|último precio \+ [\d.,]+\s?%|a costo|costo FIFO(?: \+ [\d.,]+\s?%)?|costo)(?: \$[\d,]+(?:\.\d+)? [A-Z]{3})?\)\s*$/i;

/** «(toda la flota, 1/7 del precio de venta)» ⇒ «(toda la flota, 1/7)». */
const RE_FLOTA = /\(toda la flota, 1\/(\d+) del (?:precio de venta|costo)\)/i;

/** Tramos que se quitan después del primero. */
const TRAMOS_FUERA: RegExp[] = [
  /^ref\s*0?$/i,
  /^re-preciad[oa]\b/i,
  /^corrección\b.*\bcosto\b/i,
];

function limpiarRenglonSalida(renglon: string): string {
  const [primero, ...resto] = renglon.split(SEPARADOR);
  const principal = primero
    .replace(RE_FLOTA, '(toda la flota, 1/$1)')
    .replace(RE_ETIQUETA_PRECIO, '')
    .trimEnd();
  const quedan = resto.filter(
    (t) => !TRAMOS_FUERA.some((re) => re.test(t.trim())),
  );
  return [principal, ...quedan].join(SEPARADOR);
}

/**
 * La nota de un gasto lista para un balance: cada renglón «Salida de
 * bodega…» sin precio de compra ni de venta; lo demás, igual. `null` /
 * vacío ⇒ tal cual.
 */
export function detalleSinPreciosDeBodega(texto: string): string;
export function detalleSinPreciosDeBodega(
  texto: string | null | undefined,
): string | null | undefined;
export function detalleSinPreciosDeBodega(
  texto: string | null | undefined,
): string | null | undefined {
  if (!texto) return texto;
  return texto
    .split('\n')
    .map((r) =>
      r.trimStart().startsWith(PREFIJO_SALIDA) ? limpiarRenglonSalida(r) : r,
    )
    .join('\n');
}
