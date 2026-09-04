/**
 * FUENTE ÚNICA de "¿este cobro está conciliado con el banco?" (4-sep-2026,
 * sobre de cobro de grupo — Fase 2).
 *
 * El banco enlaza un ABONO a UN cobro por dos caminos EXCLUYENTES (CHECK
 * `movimiento_bancario_cobro_excluyente`):
 * - `movimiento_bancario.cobro_id`       → cobro de vuelo normal (1 ↔ 1,
 *   `uq_mov_bancario_cobro`).
 * - `movimiento_bancario.cobro_grupo_id` → SOBRE de grupo (`cobro_grupo`,
 *   1 ↔ 1, `uq_mov_bancario_cobro_grupo`). Sus PARTES
 *   (`cobro_vuelo.cobro_grupo_id`) NUNCA tienen movimiento propio: heredan
 *   la conciliación del sobre.
 *
 * Todo lector que decida "conciliado" de un cobro pasa por aquí: la lista de
 * cobros por vuelo (badge del detalle), el candado del PATCH/DELETE por
 * vuelo, el detalle del grupo (sobre), el auto-cruce y la bandeja/reporte de
 * conciliación. Las consultas a `movimiento_bancario` deben traer
 * `MOV_LIGA_COLS` (cobro_id Y cobro_grupo_id): sin `cobro_grupo_id` el
 * helper no puede ver la liga del sobre y una parte se leería como "sin
 * conciliar" en falso.
 */

/** Columnas mínimas de movimiento_bancario para decidir la liga. */
export const MOV_LIGA_COLS = 'id, cobro_id, cobro_grupo_id';

export interface CobroConciliable {
  id: string;
  /** Parte de un sobre de grupo (null/undefined en cobros normales). */
  cobro_grupo_id?: unknown;
}

export interface MovimientoLiga {
  id?: unknown;
  cobro_id?: unknown;
  cobro_grupo_id?: unknown;
}

function idStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Id del sobre del que este cobro es parte (null si es un cobro normal). */
export function sobreDeCobro(cobro: CobroConciliable): string | null {
  return idStr(cobro.cobro_grupo_id);
}

export function esParteDeSobre(cobro: CobroConciliable): boolean {
  return sobreDeCobro(cobro) !== null;
}

/** Movimiento bancario enlazado al SOBRE (o null). */
export function movimientoDeSobre<M extends MovimientoLiga>(
  sobreId: string,
  movimientos: ReadonlyArray<M>,
): M | null {
  if (!sobreId) return null;
  return movimientos.find((m) => idStr(m.cobro_grupo_id) === sobreId) ?? null;
}

export function sobreEstaConciliado(
  sobreId: string,
  movimientos: ReadonlyArray<MovimientoLiga>,
): boolean {
  return movimientoDeSobre(sobreId, movimientos) !== null;
}

/**
 * Movimiento bancario que concilia este cobro: el enlazado DIRECTO
 * (`cobro_id`) o, si el cobro es parte de un sobre, el enlazado al sobre
 * (`cobro_grupo_id`). null = sin conciliar.
 */
export function movimientoDeCobro<M extends MovimientoLiga>(
  cobro: CobroConciliable,
  movimientos: ReadonlyArray<M>,
): M | null {
  const directo = movimientos.find((m) => idStr(m.cobro_id) === cobro.id);
  if (directo) return directo;
  const sobreId = sobreDeCobro(cobro);
  return sobreId ? movimientoDeSobre(sobreId, movimientos) : null;
}

export function cobroEstaConciliado(
  cobro: CobroConciliable,
  movimientos: ReadonlyArray<MovimientoLiga>,
): boolean {
  return movimientoDeCobro(cobro, movimientos) !== null;
}

/**
 * Filtro PostgREST (`.or(...)`) para traer SOLO los movimientos que ligan a
 * estos cobros o sobres. null cuando no hay nada que buscar (el caller se
 * salta la consulta). Los ids son uuid: no necesitan comillas.
 */
export function filtroLigaCobros(
  cobroIds: ReadonlyArray<string>,
  sobreIds: ReadonlyArray<string>,
): string | null {
  const conds: string[] = [];
  const cobros = [...new Set(cobroIds.filter(Boolean))];
  const sobres = [...new Set(sobreIds.filter(Boolean))];
  if (cobros.length > 0) conds.push(`cobro_id.in.(${cobros.join(',')})`);
  if (sobres.length > 0) conds.push(`cobro_grupo_id.in.(${sobres.join(',')})`);
  return conds.length > 0 ? conds.join(',') : null;
}
