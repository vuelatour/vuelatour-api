/**
 * Orden del reporte Excel de conciliación = el del estado de cuenta que se
 * subió (12-oct-2026, invariante 55). PURO, con spec.
 *
 * Pedido del cliente: «cuando se exporta el estado de cuenta me lo acomoda
 * diferente al estado de cuenta que subimos, y para comparar necesitamos
 * tenga el mismo orden». Cada línea importada desde el API 0.0.69 guarda
 * `orden_archivo` (su posición en el archivo) y `estado_cuenta_id` (de qué
 * archivo salió).
 *
 * Regla: si TODAS las líneas del reporte salieron del MISMO archivo y
 * traen su posición, se respeta esa posición tal cual (sea el archivo
 * cronológico o del más nuevo al más viejo: así lo ve el cliente en su
 * banco). Si no (varios archivos, líneas capturadas a mano o importadas
 * antes del 0.0.69), orden cronológico de siempre —fecha ascendente— y,
 * dentro del mismo día, primero las que traen posición de archivo (por
 * archivo y posición) y luego las demás por `created_at`. Estable: lo que
 * empata conserva el orden en que llegó.
 */
export interface LineaOrdenable {
  fecha?: unknown;
  created_at?: unknown;
  estado_cuenta_id?: unknown;
  orden_archivo?: unknown;
}

const posicion = (l: LineaOrdenable): number | null =>
  typeof l.orden_archivo === 'number' && Number.isFinite(l.orden_archivo)
    ? l.orden_archivo
    : null;

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/** ¿Todas las líneas salieron del mismo archivo y traen su posición? */
export function mismoArchivoCompleto(
  lineas: readonly LineaOrdenable[],
): boolean {
  if (lineas.length === 0) return false;
  const archivo = lineas[0].estado_cuenta_id;
  if (typeof archivo !== 'string' || archivo === '') return false;
  return lineas.every(
    (l) => l.estado_cuenta_id === archivo && posicion(l) !== null,
  );
}

export function ordenarComoEstadoDeCuenta<T extends LineaOrdenable>(
  lineas: readonly T[],
): T[] {
  const copia = [...lineas];
  if (mismoArchivoCompleto(copia)) {
    return copia.sort((a, b) => (posicion(a) ?? 0) - (posicion(b) ?? 0));
  }
  return copia.sort((a, b) => {
    const porFecha = texto(a.fecha).localeCompare(texto(b.fecha));
    if (porFecha !== 0) return porFecha;
    const pa = posicion(a);
    const pb = posicion(b);
    if (pa !== null && pb !== null) {
      const porArchivo = texto(a.estado_cuenta_id).localeCompare(
        texto(b.estado_cuenta_id),
      );
      return porArchivo !== 0 ? porArchivo : pa - pb;
    }
    if (pa !== null) return -1;
    if (pb !== null) return 1;
    return texto(a.created_at).localeCompare(texto(b.created_at));
  });
}
