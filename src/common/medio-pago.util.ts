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
  /** Cargo automático a la cuenta (suscripciones, seguros, servicios);
   *  bancario, se concilia como transferencia (13-oct-2026, invariante 64). */
  DOMICILIADO: 'Pago domiciliado',
  /** Efectivo de la empresa que NO sale de ninguna caja chica (20-oct-2026,
   *  invariante 97): no bancario y fuera de los fondos. */
  EFECTIVO_EMPRESA: 'Efectivo de la empresa (no de fondo)',
};

/**
 * Medios que SOLO registra la oficina (PILOTO, MECANICO y VISITANTE ⇒ 400
 * `MEDIO_SOLO_OFICINA` en el ALTA): el pago domiciliado (invariante 64) y el
 * efectivo de la empresa (20-oct-2026, invariante 97: decisión del cliente,
 * «solo oficina»; un piloto paga con el efectivo de SU fondo).
 */
export const MEDIOS_SOLO_OFICINA: ReadonlySet<string> = new Set([
  'DOMICILIADO',
  'EFECTIVO_EMPRESA',
]);

/** Texto del 400 `MEDIO_SOLO_OFICINA` para el efectivo de la empresa. */
export const MENSAJE_EFECTIVO_EMPRESA_SOLO_OFICINA =
  'El efectivo de la empresa lo registra la oficina: si pagaste con el efectivo de tu fondo, elige «Efectivo».';

/** El texto del 400 `MEDIO_SOLO_OFICINA` según el medio enviado. */
export function mensajeMedioSoloOficina(medio: string): string {
  return medio === 'EFECTIVO_EMPRESA'
    ? MENSAJE_EFECTIVO_EMPRESA_SOLO_OFICINA
    : MENSAJE_MEDIO_SOLO_OFICINA;
}

/**
 * «Pago domiciliado» lo registra SOLO la oficina (13-oct-2026, invariante
 * 64): un PILOTO, MECANICO o VISITANTE que lo manda en el ALTA de un gasto
 * recibe 400 `MEDIO_SOLO_OFICINA` con este texto (la edición no se bloquea:
 * la app re-manda el medio vigente).
 */
export const MENSAJE_MEDIO_SOLO_OFICINA =
  'El pago domiciliado lo registra la oficina: elige otro medio de pago.';

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

/**
 * CUENTA DE DONDE SALIÓ EL PAGO (20-oct-2026, invariante 98): medios que
 * llevan `gasto.cuenta_bancaria_id`. La tarjeta corporativa NO (su cuenta la
 * dice la terminación); el efectivo y los personales tampoco. Espejo EXACTO
 * en el panel (`lib/admin/cuentas-gasto.ts`) y en la app.
 */
export const MEDIOS_CON_CUENTA: readonly string[] = [
  'TRANSFERENCIA',
  'DOMICILIADO',
  'PAYWISE',
];

/** ¿Este medio lleva la cuenta de donde salió el pago? */
export function medioLlevaCuenta(medio: string | null | undefined): boolean {
  return MEDIOS_CON_CUENTA.includes((medio ?? '').trim());
}

/**
 * La cuenta que se GUARDA en el gasto (alta o PATCH), regla única:
 *  - el medio efectivo no lleva cuenta ⇒ null (cambiar de transferencia a
 *    efectivo LIMPIA la cuenta, como la tarjeta con su terminación);
 *  - la llave no viajó ⇒ `undefined` (se conserva la que había);
 *  - si viajó, su valor (uuid o null para quitarla).
 */
export function cuentaParaGuardar(
  medioEfectivo: string | null | undefined,
  enviada: string | null | undefined,
  actual: string | null | undefined,
): string | null | undefined {
  if (!medioLlevaCuenta(medioEfectivo)) {
    return actual != null || enviada != null ? null : undefined;
  }
  if (enviada === undefined) return undefined;
  return enviada === '' ? null : enviada;
}
