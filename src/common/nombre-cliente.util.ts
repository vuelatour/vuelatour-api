/**
 * Cliente por NOMBRE desde la app sin internet (diseño offline v2, 9-sep-2026).
 *
 * La reserva puede llegar con `cliente_nombre` en vez de `cliente_id` (el
 * cliente no existía en la copia local del catálogo). Antes de crear uno, se
 * busca entre TODOS los clientes (activos e inactivos) comparando el nombre
 * NORMALIZADO: "Juan  Pérez ", "juan perez" y "JUAN PÉREZ" son el mismo
 * cliente — `idx_cliente_nombre_lower` no es único y `ClientsService.create`
 * no deduplica, así que sin esto dos teléfonos (o un homónimo inactivo
 * oculto en las listas) producirían clientes duplicados.
 */

export interface ClienteNombreRow {
  id: string;
  nombre: string;
  activo: boolean;
}

/** trim + colapsar espacios + sin acentos/diacríticos + minúsculas. */
export function normalizarNombreCliente(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Busca el cliente cuyo nombre normalizado coincide. Prefiere uno ACTIVO;
 * si solo hay inactivos devuelve el primero (el caller lo reactiva). `null`
 * si no hay ninguno o el nombre queda vacío tras normalizar.
 */
export function buscarClientePorNombre<T extends ClienteNombreRow>(
  clientes: T[],
  nombre: string,
): T | null {
  const objetivo = normalizarNombreCliente(nombre);
  if (!objetivo) return null;
  const iguales = clientes.filter(
    (c) => normalizarNombreCliente(c.nombre ?? '') === objetivo,
  );
  if (iguales.length === 0) return null;
  return iguales.find((c) => c.activo === true) ?? iguales[0];
}

/** Nombre limpio con el que se CREA el cliente (espacios colapsados, sin
 *  tocar mayúsculas ni acentos: así lo escribió la oficina). */
export function nombreClienteParaCrear(nombre: string): string {
  return nombre.replace(/\s+/g, ' ').trim();
}
