import { MEDIOS_BANCARIOS } from '../conciliacion/gastos-candidatos.util';

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
 *    Paywise, pago domiciliado) sin cargo ligado: lo que la oficina
 *    persigue.
 *  - NO_APLICA: efectivo / personal / bodega sin cargo ligado — no se
 *    concilia con el banco.
 */
export type EstadoBanco =
  | 'CONCILIADO'
  | 'PARCIAL'
  | 'SIN_CONCILIAR'
  | 'NO_APLICA';

/**
 * Los únicos medios que cruzan con el banco: se LEEN de la fuente única
 * `MEDIOS_BANCARIOS` (conciliación) — hasta el 13-oct-2026 era una copia a
 * mano y un medio nuevo (DOMICILIADO, invariante 64) podía quedar «—» en la
 * columna «Banco» aunque la conciliación sí lo persiguiera.
 */
const MEDIOS_BANCO: ReadonlySet<string> = new Set(MEDIOS_BANCARIOS);

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

/**
 * Columna «Medio» del Excel de GASTOS SIN BANCO (13-oct-2026, invariante
 * 64). Antes era un ternario en `reporteGastosSinBancoXlsx` que rotulaba
 * «Transferencia» a todo lo que no fuera tarjeta ni PayWise: un pago
 * domiciliado salía como transferencia (mentira en un reporte). Los textos
 * de los medios de siempre son byte a byte los de antes («Tarjeta **** 1234»,
 * «Tarjeta», «PayWise», «Transferencia»).
 */
export function etiquetaMedioSinBanco(
  medio: string | null | undefined,
  terminacion?: string | null,
): string {
  if (medio === 'TARJETA_CORP') {
    return `Tarjeta${terminacion ? ` **** ${terminacion}` : ''}`;
  }
  if (medio === 'PAYWISE') return 'PayWise';
  if (medio === 'DOMICILIADO') return 'Pago domiciliado';
  return 'Transferencia';
}
