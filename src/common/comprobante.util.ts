/**
 * COMPROBANTE DEL GASTO — dos opciones, no tres (pedido del cliente,
 * 14-sep-2026).
 *
 * El cliente pidió: «en lugar de Factura solo colocar dos opciones:
 * Comprobante (aplica para tickets, vouchers, etc.) y Sin comprobante». La
 * pregunta que responde este campo es una sola: **¿trajo papel o no?**
 * «¿ya se facturó?» es OTRA cosa y vive en `gasto.estatus_facturacion`
 * (semáforo de oficina) — la señal del comprobante NUNCA sirvió para
 * afirmar facturado: la app marca `FACTURA` con CUALQUIER foto, aunque sea
 * un ticket de gasolina.
 *
 * SIN MIGRACIÓN: el enum de BD (`public.estatus_comprobante`) sigue con sus
 * tres valores y nadie reescribe filas. La regla de lectura es esta:
 *
 *  - `FACTURA`         → «Con comprobante» (valor que GUARDA hoy el panel y
 *                        el que ya manda la app cuando hay foto).
 *  - `VALE`            → «Con comprobante» — LEGADO (cargas masivas de
 *                        combustible con comprobante TICKET, capturas
 *                        viejas). Se lee igual, **no se reescribe solo**.
 *  - `SIN_COMPROBANTE` → «Sin comprobante» (default de la columna).
 *
 * FUENTE ÚNICA del API: quien pinte o decida sobre el comprobante (Excel de
 * gastos, historial, avisos) usa estos helpers — no compara contra
 * `'FACTURA'` a mano. El panel tiene su espejo en
 * `vuelatour-next/src/lib/admin/comprobante-badge.ts` (ahí la etiqueta es de
 * BADGE: solo pinta «Sin comp.», porque la miniatura ya dice que hay papel).
 * Paridad manual, mismo patrón que `categoria-gasto.util.ts`.
 */

/** Valor del enum que significa "no entregó nada". */
export const SIN_COMPROBANTE = 'SIN_COMPROBANTE';

/**
 * Valor que se GUARDA cuando hay comprobante (ticket, voucher o factura).
 * Es el que ya escribía la app al adjuntar foto: así el panel y la app
 * dicen lo mismo y no nace un tercer significado.
 */
export const CON_COMPROBANTE = 'FACTURA';

/**
 * Valor LEGADO que también significa "hay comprobante". Se lee, nunca se
 * escribe desde el panel (ver `estatus_comprobante` del diálogo de
 * verificar: un guardado que no toca el campo conserva el VALE).
 */
export const COMPROBANTE_LEGADO_VALE = 'VALE';

/**
 * ¿El gasto trae comprobante? Cualquier valor que no sea `SIN_COMPROBANTE`
 * (FACTURA, VALE o un código viejo) cuenta como papel entregado.
 *
 * Sin dato (null / '' — imposible hoy: la columna es NOT NULL con default)
 * responde **false**: no se afirma un comprobante que nadie capturó.
 */
export function hayComprobante(estatus: string | null | undefined): boolean {
  const codigo = (estatus ?? '').trim();
  if (!codigo) return false;
  return codigo !== SIN_COMPROBANTE;
}

/**
 * Etiqueta es-MX del comprobante para REPORTES y textos del API (Excel de
 * gastos, historial): dos únicas salidas, «Con comprobante» / «Sin
 * comprobante». La palabra «Factura» desapareció de estos textos a
 * propósito — se confundía con el semáforo de facturación.
 */
export function etiquetaComprobante(
  estatus: string | null | undefined,
): string {
  return hayComprobante(estatus) ? 'Con comprobante' : 'Sin comprobante';
}
