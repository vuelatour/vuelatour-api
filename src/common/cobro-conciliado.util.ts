/**
 * FUENTE ÚNICA de "¿este cobro tiene LIGA con el banco, y por dónde?"
 * (4-sep-2026, sobre de cobro de grupo — Fase 2).
 *
 * El banco enlaza un ABONO a un cobro por dos caminos EXCLUYENTES (CHECK
 * `movimiento_bancario_cobro_excluyente`):
 * - liga DIRECTA → cobro de vuelo normal. Desde el 12-oct-2026 (invariante
 *   56) la fuente es la PUENTE `movimiento_bancario_cobro` y
 *   `movimiento_bancario.cobro_id` es su espejo; desde el 14-oct-2026
 *   (invariante 77, migración 20261014000003, que retira
 *   `uq_mov_bancario_cobro`) la liga es M:N: un cobro se paga con 1..N
 *   abonos y un abono paga 1..N cobros. El lector único
 *   `conciliacion/ligas-cobro.lector.ts` devuelve UNA liga por (abono,
 *   cobro).
 * - `movimiento_bancario.cobro_grupo_id` → SOBRE de grupo (`cobro_grupo`,
 *   1 ↔ 1, `uq_mov_bancario_cobro_grupo`). Sus PARTES
 *   (`cobro_vuelo.cobro_grupo_id`) NUNCA tienen movimiento propio: heredan
 *   la conciliación del sobre.
 *
 * OJO (invariante 77): «CONCILIADO» de un cobro ya NO es «tiene liga»: es
 * CUBIERTO (Σ de sus abonos ≥ neto − $1.00) y lo decide
 * `common/cobro-banco.util.ts` (`coberturaCobro` ⇒ `estadoBancoCobro`).
 * `movimientoDeCobro`, `cobroEstaConciliado` y `conciliacionDeCobro`
 * conservan su conducta —«tiene liga» y POR DÓNDE— porque es el criterio
 * del CANDADO de dinero (fail-closed: también un cobro PARCIAL está
 * ligado); ningún lector de ESTADO vuelve a usarlas para pintar
 * «conciliado». Las consultas a `movimiento_bancario` deben traer
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
  /**
   * ADITIVO (invariante 77): lo que ESE abono aporta a ESE cobro, cuando la
   * liga sale de la PUENTE (`ligasDesdePartes`). Ausente en una liga del
   * espejo (sin 20261012000002: la parte es el |abono| completo).
   */
  monto_parte?: number;
  /**
   * ADITIVOS (invariante 78, solo con `leerLigasDeCobros({ conAutor: true
   * })`): CUÁNDO y QUIÉN creó la PARTE de la puente (`created_at` /
   * `created_by` de la parte, NO los del movimiento embebido). Ausentes sin
   * la opción y en una liga del espejo.
   */
  parte_created_at?: string | null;
  ligada_por?: string | null;
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

/**
 * ¿El cobro tiene LIGA con el banco (directa o la de su sobre)? Es el
 * criterio del CANDADO de dinero; el ESTADO («conciliado» = cubierto) sale
 * de `cobro-banco.util` (invariante 77).
 */
export function cobroEstaConciliado(
  cobro: CobroConciliable,
  movimientos: ReadonlyArray<MovimientoLiga>,
): boolean {
  return movimientoDeCobro(cobro, movimientos) !== null;
}

/**
 * TODAS las ligas DIRECTAS del cobro (M:N desde el 14-oct-2026, invariante
 * 77), sin repetir movimiento, en el orden en que llegan. [] = sin liga
 * directa (la de un sobre o un anticipo no cuenta aquí).
 */
export function movimientosDeCobro<M extends MovimientoLiga>(
  cobro: CobroConciliable,
  movimientos: ReadonlyArray<M>,
): M[] {
  const vistos = new Set<string>();
  const out: M[] = [];
  for (const m of movimientos) {
    if (idStr(m.cobro_id) !== cobro.id) continue;
    const id = idStr(m.id);
    if (id === null || vistos.has(id)) continue;
    vistos.add(id);
    out.push(m);
  }
  return out;
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

// =====================================================================
// ANTICIPOS (24-sep-2026, contrato de ingresos §7.4-bis) — SOLO ADITIVO.
//
// Un cobro de vuelo nacido de un ANTICIPO (`cobro_vuelo.ingreso_anticipo_id`)
// NO tiene movimiento propio: el abono del banco se liga UNA vez al anticipo
// (`movimiento_bancario.ingreso_id`). «Conciliado» de ese cobro = su anticipo
// está conciliado. Todo lo de arriba (liga directa y sobre) no cambia:
// `movimientoDeCobro` sigue viendo SOLO directo/sobre A PROPÓSITO — el
// candado de PATCH/DELETE de cobros (`assertCobroSinConciliar`) lo usa, y
// desaplicar un cobro de anticipo conciliado está permitido (el abono queda
// ligado al anticipo, que conserva el dinero; ningún movimiento apunta al
// cobro). Las columnas nuevas solo se piden con la sonda
// `ingresosDisponibles` (sin migración no existen).
// =====================================================================

/** `MOV_LIGA_COLS` + `ingreso_id` (SOLO con la migración de ingresos). */
export const MOV_LIGA_COLS_CON_INGRESO =
  'id, cobro_id, cobro_grupo_id, ingreso_id';

export interface CobroConciliableAnticipo extends CobroConciliable {
  /** Anticipo del que salió el cobro (null/undefined en cobros normales). */
  ingreso_anticipo_id?: unknown;
}

/** Por dónde concilia un cobro: liga directa, su sobre o su anticipo. */
export type ViaConciliacion = 'DIRECTO' | 'SOBRE' | 'ANTICIPO';

/** Id del anticipo del que salió este cobro (null si es un cobro normal). */
export function anticipoDeCobro(
  cobro: CobroConciliableAnticipo,
): string | null {
  return idStr(cobro.ingreso_anticipo_id);
}

/**
 * Movimiento que concilia el cobro y POR QUÉ VÍA: directo/sobre
 * (`movimientoDeCobro`, igual que hoy) o, si el cobro salió de un anticipo,
 * el movimiento con `ingreso_id` = su anticipo. null = sin conciliar.
 */
export function conciliacionDeCobro<
  M extends MovimientoLiga & { ingreso_id?: unknown },
>(
  cobro: CobroConciliableAnticipo,
  movimientos: ReadonlyArray<M>,
): { mov: M; via: ViaConciliacion } | null {
  const mov = movimientoDeCobro(cobro, movimientos);
  if (mov) {
    return {
      mov,
      via: idStr(mov.cobro_id) === cobro.id ? 'DIRECTO' : 'SOBRE',
    };
  }
  const anticipo = anticipoDeCobro(cobro);
  if (!anticipo) return null;
  const porAnticipo = movimientos.find((m) => idStr(m.ingreso_id) === anticipo);
  return porAnticipo ? { mov: porAnticipo, via: 'ANTICIPO' } : null;
}

/**
 * `filtroLigaCobros` + `ingreso_id.in.(…)` de los anticipos: UNA consulta
 * trae las tres vías. null cuando no hay nada que buscar.
 */
export function filtroLigaCobrosConAnticipos(
  cobroIds: ReadonlyArray<string>,
  sobreIds: ReadonlyArray<string>,
  anticipoIds: ReadonlyArray<string>,
): string | null {
  const conds: string[] = [];
  const base = filtroLigaCobros(cobroIds, sobreIds);
  if (base) conds.push(base);
  const anticipos = [...new Set(anticipoIds.filter(Boolean))];
  if (anticipos.length > 0)
    conds.push(`ingreso_id.in.(${anticipos.join(',')})`);
  return conds.length > 0 ? conds.join(',') : null;
}
