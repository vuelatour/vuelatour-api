/**
 * ETIQUETAS es-MX DE LOS MEDIOS DE PAGO DE UN GASTO — espejo exacto del
 * panel (11-sep-2026).
 *
 * Nace para la columna **PAGO** de la hoja "combustible" del balance por
 * avión: el cliente concilia las cargas contra los estados de cuenta del
 * banco y necesita ver CON QUÉ se pagó cada una (y, si fue tarjeta
 * corporativa, con cuál terminación).
 *
 * FUENTE de los textos: `vuelatour-next/src/lib/admin/medios-pago.ts`
 * (`MEDIO_PAGO_LABELS`). Panel y API dicen lo MISMO: si allá cambia una
 * etiqueta, cambia aquí (paridad manual, mismo patrón que
 * `categoria-gasto.util.ts`).
 *
 * SOLO PRESENTACIÓN: los códigos del enum (`EFECTIVO`, `TARJETA_CORP`, …)
 * no cambian en BD, DTOs ni comparaciones; ninguna regla de clasificación,
 * reparto o balance mira estas etiquetas.
 *
 * OJO — convive con `src/modules/expenses/medio-tarjeta.util.ts`, que tiene
 * su propio `etiquetaMedioPago(medio)` para AVISOS de captura (otros
 * textos: "PayWise", "Bodega", y `null → '—'` porque ahí siempre se pinta
 * algo). Este util es el de los REPORTES: `null → null` (celda vacía, jamás
 * un guion falso) y desconocido → código capitalizado. Converger ambos es
 * un pendiente declarado, no un descuido.
 */

/** Etiqueta es-MX de cada medio — idéntica a MEDIO_PAGO_LABELS del panel. */
export const MEDIO_PAGO_LABEL: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  TARJETA_CORP: 'Tarjeta corporativa',
  TRANSFERENCIA: 'Transferencia',
  /** Plataforma de pago de servicios aeroportuarios (recibos Paywise). */
  PAYWISE: 'Paywise',
  PERSONAL_PABLO: 'Personal Pablo',
  PERSONAL_ALE: 'Personal Ale',
  /** Cargo contable de inventario (salida de cardex): nunca toca el banco. */
  BODEGA: 'Bodega (inventario)',
};

/**
 * Etiqueta amable del medio de pago de un gasto, con la terminación de la
 * tarjeta cuando aplica (" ****1234").
 *
 *  - `TARJETA_CORP` + terminación → "Tarjeta corporativa ****1234"
 *    (la terminación SOLO vive con ese medio — CHECK `gasto_check` de BD —,
 *    así que en cualquier otro medio se ignora en vez de inventar texto).
 *  - Código que el catálogo no conoce (dato viejo, valor libre) → el código
 *    capitalizado con guiones bajos a espacios ("FOO_BAR" → "Foo bar"),
 *    mismo fallback que `etiquetaCategoriaGasto`.
 *  - Sin medio (null/undefined/vacío) → **null**: la celda queda VACÍA. En
 *    reportes un guion o un "Efectivo" por default serían una afirmación
 *    falsa (el medio se captura en blanco a propósito desde el 3-sep-2026).
 */
export function etiquetaMedioPago(
  medio: string | null | undefined,
  terminacion?: string | null,
): string | null {
  const codigo = (medio ?? '').trim();
  if (!codigo) return null;
  const conocida = MEDIO_PAGO_LABEL[codigo];
  const base =
    conocida ??
    (() => {
      const limpio = codigo.replace(/_/g, ' ').toLowerCase();
      return limpio.charAt(0).toUpperCase() + limpio.slice(1);
    })();
  if (codigo !== 'TARJETA_CORP') return base;
  const term = (terminacion ?? '').trim();
  return term ? `${base} ****${term}` : base;
}
