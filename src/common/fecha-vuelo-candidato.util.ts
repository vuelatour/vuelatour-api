/**
 * Fecha del vuelo de un candidato de cobro (12-oct-2026, invariante 54).
 * Pedido del cliente: «agregar la fecha del vuelo y la fecha de cobro porque
 * por ejemplo el vuelo es del 04 de octubre y el 06 se cobró y solo estamos
 * viendo el del cobro». PostgREST entrega `vuelo.fecha_vuelo` como texto
 * ISO; cualquier otra cosa (relación sin resolver, null) es «sin fecha».
 */
export function fechaVueloDe(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}
