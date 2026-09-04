/**
 * Bandera `calculo_snapshot.meta.grupo.precio_desactualizado` (4-sep-2026,
 * precedente caso #80): cuando la OPERACIÓN cambia el avión efectivo de un
 * hijo de grupo (assign / assignEscala / reassign-aircraft) sin recotizar,
 * el precio del hijo sigue calculado con el avión del snapshot
 * (`snapshot.aeronave.id`: otra velocidad, otra tarifa, otro prefijo de
 * TUAS). Aquí SOLO se marca la bandera — el dinero no se toca; el panel
 * ofrece recotizar y `quotes.revise` la limpia al regenerar el snapshot.
 *
 * Helper PURO: recibe el snapshot y devuelve el snapshot nuevo (merge
 * aditivo, jamás pisa otras claves) y si hubo cambio. Sin `meta.grupo` no
 * inventa uno (el vuelo no es de grupo o nació antes); sin
 * `snapshot.aeronave.id` (reserva sin precio) no hay contra qué comparar.
 * Volver al avión cotizado apaga la bandera.
 */
export function marcarPrecioDesactualizado(
  snapshot: unknown,
  aeronaveEfectivaId: string | null | undefined,
): { snapshot: Record<string, unknown>; cambio: boolean } {
  const snap =
    snapshot && typeof snapshot === 'object'
      ? (snapshot as Record<string, unknown>)
      : {};
  const meta =
    snap.meta && typeof snap.meta === 'object'
      ? (snap.meta as Record<string, unknown>)
      : null;
  const grupo =
    meta?.grupo && typeof meta.grupo === 'object'
      ? (meta.grupo as Record<string, unknown>)
      : null;
  if (!meta || !grupo) return { snapshot: snap, cambio: false };
  const avionCotizado =
    (snap.aeronave as { id?: string | null } | null | undefined)?.id ?? null;
  if (!avionCotizado || !aeronaveEfectivaId) {
    return { snapshot: snap, cambio: false };
  }
  const desactualizado = avionCotizado !== aeronaveEfectivaId;
  const actual = grupo.precio_desactualizado === true;
  if (actual === desactualizado) return { snapshot: snap, cambio: false };
  return {
    snapshot: {
      ...snap,
      meta: {
        ...meta,
        grupo: { ...grupo, precio_desactualizado: desactualizado },
      },
    },
    cambio: true,
  };
}
