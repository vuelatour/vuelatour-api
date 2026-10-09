/**
 * ESTADO DE CONCILIACIÓN CON EL BANCO de un gasto (9-oct-2026; pedido de
 * oficina: «un apartado donde me diga si el gasto está conciliado con el
 * banco»). Helper PURO, fuente única del Excel de gastos (`listXlsx`) y
 * espejo del panel (`lib/admin/conciliacion-estado.ts`).
 *
 *  - CONCILIADO: `gasto.conciliado` true — lo escribe solo la BD cuando los
 *    cargos ligados CUBREN el gasto (también un gasto en efectivo ligado con
 *    justificación, 6-oct-2026).
 *  - PARCIAL: hay cargos ligados pero no cubren (`monto_vinculado` > 0 sin
 *    `conciliado`; aditivos de `list()`).
 *  - SIN_CONCILIAR: medio bancario (tarjeta corporativa, transferencia,
 *    Paywise) sin cargo ligado: lo que la oficina persigue.
 *  - NO_APLICA: efectivo / personal / bodega sin cargo ligado — no se
 *    concilia con el banco.
 */
export type EstadoBanco =
  | 'CONCILIADO'
  | 'PARCIAL'
  | 'SIN_CONCILIAR'
  | 'NO_APLICA';

/** Espejo de `MEDIOS_BANCARIOS` (conciliación): los únicos que cruzan con el banco. */
const MEDIOS_BANCO: ReadonlySet<string> = new Set([
  'TARJETA_CORP',
  'TRANSFERENCIA',
  'PAYWISE',
]);

const ETIQUETA: Record<EstadoBanco, string> = {
  CONCILIADO: 'Conciliado',
  PARCIAL: 'Parcial',
  SIN_CONCILIAR: 'Sin conciliar',
  NO_APLICA: '',
};

function numero(x: unknown): number {
  const n = typeof x === 'number' ? x : Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function estadoBancoGasto(g: {
  conciliado?: boolean | null;
  medio_pago?: string | null;
  monto_vinculado?: number | string | null;
}): EstadoBanco {
  if (g.conciliado === true) return 'CONCILIADO';
  if (numero(g.monto_vinculado) > 0) return 'PARCIAL';
  return MEDIOS_BANCO.has(g.medio_pago ?? '') ? 'SIN_CONCILIAR' : 'NO_APLICA';
}

/** Texto de la columna «Banco» del Excel (vacío = no aplica). */
export function etiquetaEstadoBanco(estado: EstadoBanco): string {
  return ETIQUETA[estado];
}
