/**
 * Fuentes del T.C. oficial de referencia USD→MXN y su etiqueta legible —
 * PURO (`common/` no importa módulos). `TipoCambioService` las RE-EXPORTA
 * (mismos nombres, mismo comportamiento); los utils puros que arman textos
 * con la fuente —la nota «T.C. A USD» de la hoja «Otros ingresos» del
 * balance (14-oct-2026, API 0.0.77)— las importan de AQUÍ: así no dependen
 * del servicio (Nest, Supabase), que los specs sustituyen con `jest.mock`.
 */

/** open.er-api.com: una publicación al día, solo el valor vigente. */
export const FUENTE_DIARIA = 'OPEN_ER_API';
/** Banco Central Europeo vía api.frankfurter.dev (fechas anteriores). */
export const FUENTE_HISTORICA = 'ECB_FRANKFURTER';

/** Etiqueta legible de la fuente del TC oficial (celdas/notas de reportes). */
export function fuenteTcLegible(fuente: string | null | undefined): string {
  switch (fuente) {
    case FUENTE_DIARIA:
      return 'open.er-api';
    case FUENTE_HISTORICA:
      return 'BCE (frankfurter)';
    case 'BANXICO_FIX':
      return 'Banxico FIX (histórico)';
    default:
      return fuente ?? 'TC oficial';
  }
}
