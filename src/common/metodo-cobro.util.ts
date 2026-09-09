/**
 * FUENTE ÚNICA de los métodos de cobro (enum `metodo_cobro` de la BD) en
 * lo que NO es validación de DTO (eso vive en `MetodoPago`,
 * quotes/dto/calculate-quote.dto.ts): etiquetas es-MX y los conjuntos que
 * deciden con qué se cruza el banco. Antes cada lector tenía su copia
 * (recibo, PDF interno, conciliación, pre-cierre) y agregar un método
 * (CHEQUE, OTRO, PAYWISE) obligaba a cazarlas una por una.
 *
 * PAYWISE (9-sep-2026): link/pasarela de cobro. Lo registra la OFICINA
 * (fuera de la whitelist del piloto), sin IVA por default (mismo trato que
 * BillPocket: terminal/pasarela sin factura salvo override), factura
 * pre-cobro como BillPocket (FormaPago SAT 04), y concilia contra el estado
 * de cuenta de Paywise por NETO (bruto − comisión) / BRUTO / referencia.
 */

export const METODO_COBRO_LABELS: Record<string, string> = {
  TRANSFERENCIA: 'Transferencia',
  HSBC_LINK: 'HSBC link',
  CHEQUE: 'Cheque',
  BILLPOCKET: 'BillPocket',
  PAYWISE: 'Paywise',
  EFECTIVO: 'Efectivo',
  DOLARES: 'Dólares',
  OTRO: 'Otro',
};

/** Etiqueta legible del método (código desconocido/null → tal cual o '—'). */
export function etiquetaMetodoCobro(metodo: string | null | undefined): string {
  if (!metodo) return '—';
  return METODO_COBRO_LABELS[metodo] ?? metodo;
}

/**
 * Métodos que llegan al banco/pasarela como ABONO identificable y se cruzan
 * SOLOS al importar un estado de cuenta (conciliación automática). También
 * son los que el pre-cierre vigila como "cobros bancarios sin conciliar".
 */
export const METODOS_COBRO_ABONO_AUTO: readonly string[] = [
  'TRANSFERENCIA',
  'HSBC_LINK',
  'CHEQUE',
  'PAYWISE',
];

/**
 * Candidatos MANUALES para un abono: + BILLPOCKET (el depósito de la
 * terminal también aparece en el estado de cuenta, pero agrupado/neteado —
 * el panel lo ofrece a mano, nunca solo).
 */
export const METODOS_COBRO_ABONO_MANUAL: readonly string[] = [
  ...METODOS_COBRO_ABONO_AUTO,
  'BILLPOCKET',
];

/** Métodos cuyo abono viene de una PASARELA (cuenta tipo PASARELA). */
export const METODOS_COBRO_PASARELA: readonly string[] = ['PAYWISE'];
