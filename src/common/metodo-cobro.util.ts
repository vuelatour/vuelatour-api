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

/**
 * ETIQUETAS es-MX. FUENTE ÚNICA: el panel (`lib/admin/metodos-pago.ts`) y la
 * app copian ESTA tabla, y es la que imprimen el recibo de pago y el PDF
 * interno de la cotización.
 *
 * 22-sep-2026 (palabras del cliente: «en vuelos, apartado COBRO, colocar las
 * opciones link de pago, transferencia, efectivo»): los dos métodos que la
 * oficina llama «link de pago» lo dicen con esas palabras y entre paréntesis
 * quién cobra. Los VALORES del enum (`metodo_cobro` de la BD) NO cambian —
 * cambiarlos rompería cobros históricos, conciliación y whitelist del piloto.
 */
export const METODO_COBRO_LABELS: Record<string, string> = {
  HSBC_LINK: 'Link de pago (HSBC)',
  PAYWISE: 'Link de pago (Paywise)',
  TRANSFERENCIA: 'Transferencia',
  EFECTIVO: 'Efectivo',
  CHEQUE: 'Cheque',
  BILLPOCKET: 'BillPocket',
  // «Dólares DIRECTO» = efectivo en dólares en mano, para que no se confunda
  // con una transferencia a la cuenta en dólares. Es la etiqueta que el panel
  // ya pintaba; el API decía «Dólares» y el recibo impreso no coincidía con
  // la pantalla (revisión adversaria 22-sep-2026).
  DOLARES: 'Dólares directo',
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
