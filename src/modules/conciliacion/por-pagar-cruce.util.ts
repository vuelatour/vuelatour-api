/**
 * AUTO-CRUCE DESDE EL BANCO y gastos «POR PAGAR» (19-oct-2026, API 0.0.95,
 * invariante 93; revisión P14 (b) del 19-oct-2026). PURO.
 *
 * Un gasto «por pagar» VIGENTE (estado ≠ PAGADO, `porPagarVigente`) se
 * capturó ANTES de pagarse: un cargo del banco con fecha ANTERIOR al día en
 * que se capturó no puede ser su pago. En el auto-cruce desde el BANCO
 * (importación del estado de cuenta y «Cruzar pendientes»: `autoMatchCargo`,
 * y su espejo, el motivo de los pendientes de la lista) ese gasto NO es
 * candidato de ese cargo. Lo decide `cargoPuedePagarGasto` con el día Cancún
 * de la captura (`capturado_en ?? created_at`). Solo detrás de la sonda de la
 * migración (sin ella, el 0.0.94 byte a byte). El alta y el PATCH de un gasto
 * por pagar vigente ni siquiera disparan el cruce (P14 (a), expenses).
 *
 * LÍMITE CONOCIDO (decisión del 19-oct-2026; se documenta, no se arregla
 * aquí): al ligar, el auto-cruce NO escribe la fecha del cargo. Un por pagar
 * que el banco liga queda PAGADO (conciliado ⇒ PAGADO) con su fecha
 * PROGRAMADA, como cualquier gasto a ±3 días del cargo: si las dos fechas
 * cruzan fin de mes, el gasto cuenta en el mes de la programada. El camino
 * manual («Marcar pagado» con la fecha real) sí deja la fecha del pago.
 */
import { diaCancun } from '../../common/fecha-cancun.util';
import {
  porPagarVigente,
  type FilaEstadoPago,
} from '../expenses/por-pagar.util';

/** Columnas EXTRA del select de candidatos (SOLO con la sonda de por pagar). */
export const COLS_CANDIDATO_POR_PAGAR =
  ', por_pagar, conciliado, capturado_en, created_at';

/** `COLS_CANDIDATO_POR_PAGAR` con la sonda; '' sin ella (no nombra la columna). */
export function colsCandidatoPorPagar(conPorPagar: boolean): string {
  return conPorPagar ? COLS_CANDIDATO_POR_PAGAR : '';
}

/** Lo que el filtro lee de una fila de gasto candidato. */
export type GastoCandidatoPorPagar = FilaEstadoPago & {
  capturado_en?: unknown;
  created_at?: unknown;
};

/** Día Cancún (YYYY-MM-DD) en que se capturó el gasto; null si no se lee. */
export function diaCapturaDeGasto(g: {
  capturado_en?: unknown;
  created_at?: unknown;
}): string | null {
  const iso =
    typeof g.capturado_en === 'string' && g.capturado_en
      ? g.capturado_en
      : typeof g.created_at === 'string' && g.created_at
        ? g.created_at
        : null;
  if (!iso) return null;
  try {
    return diaCancun(iso);
  } catch {
    return null;
  }
}

/**
 * ¿El cargo del día `fechaCargo` puede ser el PAGO de este gasto? `false`
 * SOLO para un por pagar VIGENTE capturado DESPUÉS del día del cargo. Todo lo
 * demás ⇒ `true`: un gasto pagado o conciliado, un por pagar capturado el
 * MISMO día del cargo o antes, o una captura / fecha de cargo ilegible
 * (jamás se descarta un candidato sin poder decidirlo).
 */
export function cargoPuedePagarGasto(
  g: GastoCandidatoPorPagar,
  fechaCargo: string,
  hoy: string,
): boolean {
  if (!porPagarVigente(g, hoy)) return true;
  const dia = diaCapturaDeGasto(g);
  const cargo = typeof fechaCargo === 'string' ? fechaCargo.slice(0, 10) : '';
  if (!dia || !/^\d{4}-\d{2}-\d{2}$/.test(cargo)) return true;
  return dia <= cargo;
}

/** El contexto del filtro de UN cargo (null = sin la sonda: no filtra). */
export interface FiltroPorPagarCruce {
  fechaCargo: string;
  hoy: string;
}

/**
 * Las filas candidatas SIN los por pagar capturados después del cargo, y
 * cuántos se descartaron. Sin filtro (`null`, sin la migración) devuelve las
 * mismas filas en el mismo orden.
 */
export function sinPorPagarPosterioresAlCargo<T extends object>(
  filas: ReadonlyArray<T>,
  filtro: FiltroPorPagarCruce | null,
): { filas: T[]; descartados: number } {
  if (!filtro) return { filas: [...filas], descartados: 0 };
  const quedan = filas.filter((g) =>
    cargoPuedePagarGasto(
      g as GastoCandidatoPorPagar,
      filtro.fechaCargo,
      filtro.hoy,
    ),
  );
  return { filas: quedan, descartados: filas.length - quedan.length };
}

/**
 * Frase que se SUMA al motivo de un cargo que se quedó sin candidato porque
 * los gastos del mismo monto eran por pagar capturados después del cargo.
 */
export function textoPorPagarPosteriorAlCargo(n: number): string {
  return n === 1
    ? '1 gasto «por pagar» del mismo monto se capturó después de este cargo: no puede ser su pago.'
    : `${n} gastos «por pagar» del mismo monto se capturaron después de este cargo: ninguno puede ser su pago.`;
}
