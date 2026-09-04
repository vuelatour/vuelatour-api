/**
 * Extras con `cantidad × unitario` y extras de GRUPO — helpers PUROS del
 * motor de cotización (4-sep-2026, base de la cotización de grupo).
 *
 * - Un extra puede venir como monto a secas (legado: `monto_usd` nativo) o
 *   como `cantidad × unitario` (tour 9 × $85): entonces el MONTO SE DERIVA
 *   (`montoDerivado`) y el concepto del desglose se pinta "Tour · 9 × $85.00".
 * - `por_persona`: en una cotización de UN avión la cantidad se liga a los
 *   pasajeros del vuelo en cada recálculo. En un extra de GRUPO (origen
 *   'GRUPO') la cantidad la fija el grupo (`grupo_pax` del hijo — en la
 *   doble rotación es 10 aunque `vuelo.pasajeros` sea 5) y AQUÍ no se toca.
 * - `anclarExtrasDeGrupo`: `revise`/`quickAdjust` del hijo CONSERVAN las
 *   líneas origen='GRUPO' persistidas (igual que anclan `cliente_id`): lo
 *   que mande el front para esas líneas se descarta. Solo el escritor del
 *   grupo (flag interno `desdeGrupo`) las reemplaza.
 */

export const ORIGEN_EXTRA_GRUPO = 'GRUPO';
export const ORIGEN_EXTRA_VUELO = 'VUELO';

export interface ExtraConCantidad {
  concepto: string;
  monto_usd?: number | string | null;
  cantidad?: number | string | null;
  unitario?: number | string | null;
  por_persona?: boolean | null;
  origen?: string | null;
  grupo_extra_id?: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** true si el renglón trae cantidad Y unitario válidos (≥ 0). */
export function tieneCantidadUnitario(e: ExtraConCantidad): boolean {
  if (e.cantidad == null || e.unitario == null) return false;
  const c = Number(e.cantidad);
  const u = Number(e.unitario);
  return Number.isFinite(c) && Number.isFinite(u) && c >= 0 && u >= 0;
}

/** Monto NATIVO derivado = round2(cantidad × unitario). */
export function montoDerivado(
  cantidad: number | string,
  unitario: number | string,
): number {
  return round2((Number(cantidad) || 0) * (Number(unitario) || 0));
}

const FMT_MONTO = new Intl.NumberFormat('es-MX', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const FMT_CANTIDAD = new Intl.NumberFormat('es-MX', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** "9 × $85.00" / "9 × $1,500.00 MXN" (es-MX, 2 decimales en el unitario). */
export function etiquetaCantidadUnitario(
  cantidad: number | string,
  unitario: number | string,
  moneda: 'USD' | 'MXN' = 'USD',
): string {
  const c = FMT_CANTIDAD.format(Number(cantidad) || 0);
  const u = FMT_MONTO.format(Number(unitario) || 0);
  return `${c} × $${u}${moneda === 'MXN' ? ' MXN' : ''}`;
}

/** Monto formateado es-MX con 2 decimales ("13,500.00"). */
export function formatoMonto(n: number): string {
  return FMT_MONTO.format(Number(n) || 0);
}

/**
 * Cantidad EFECTIVA de un extra `por_persona` en una cotización de un avión:
 * los pasajeros del vuelo. Las líneas de GRUPO conservan su cantidad (la
 * fija el grupo). Sin `por_persona`, la cantidad capturada tal cual.
 */
export function cantidadEfectiva(
  e: ExtraConCantidad,
  pasajeros: number,
): number {
  if (e.por_persona === true && e.origen !== ORIGEN_EXTRA_GRUPO) {
    return Math.max(0, Number(pasajeros) || 0);
  }
  return Math.max(0, Number(e.cantidad) || 0);
}

/**
 * Ancla de los extras de GRUPO al revisar un hijo: devuelve la lista que
 * debe entrar al motor = líneas GRUPO PERSISTIDAS (intactas) + líneas del
 * front que NO sean de grupo. Una línea entrante se considera "de grupo"
 * (y se descarta) si trae origen 'GRUPO', o su `grupo_extra_id` coincide
 * con una persistida, o es la MISMA línea re-enviada sin banderas por un
 * panel viejo (mismo concepto —trim, sin mayúsculas— y mismo monto). Una
 * línea con el mismo concepto pero OTRO monto se conserva como propia del
 * vuelo: mejor un duplicado visible que un descarte silencioso.
 *
 * `entrantes` undefined: sin líneas de grupo persistidas ⇒ undefined (el
 * caller conserva su semántica de "no tocar extras"); con ellas ⇒ TODOS los
 * extras persistidos (grupo y propios) entran al motor — omitir la lista
 * jamás borra nada.
 */
export function anclarExtrasDeGrupo<T extends ExtraConCantidad>(
  persistidos: unknown,
  entrantes: T[] | undefined,
): Array<T | ExtraConCantidad> | undefined {
  const lista = Array.isArray(persistidos)
    ? (persistidos as ExtraConCantidad[])
    : [];
  const deGrupo = lista.filter((e) => e?.origen === ORIGEN_EXTRA_GRUPO);
  if (deGrupo.length === 0) return entrantes;
  if (entrantes === undefined) return [...lista];
  const ids = new Set(
    deGrupo.map((e) => e.grupo_extra_id).filter((x): x is string => !!x),
  );
  const clave = (e: ExtraConCantidad): string =>
    String(e.concepto ?? '')
      .trim()
      .toLowerCase();
  const montoDe = (e: ExtraConCantidad): number =>
    tieneCantidadUnitario(e)
      ? montoDerivado(e.cantidad!, e.unitario!)
      : round2(Number(e.monto_usd) || 0);
  const reenviadas = new Set(deGrupo.map((e) => `${clave(e)}|${montoDe(e)}`));
  const propios = entrantes.filter((e) => {
    if (e.origen === ORIGEN_EXTRA_GRUPO) return false;
    if (e.grupo_extra_id && ids.has(e.grupo_extra_id)) return false;
    if (reenviadas.has(`${clave(e)}|${montoDe(e)}`)) return false;
    return true;
  });
  return [...deGrupo, ...propios];
}

/**
 * Extras que entran al motor cuando el escritor es el GRUPO (`desdeGrupo`
 * en `quotes.revise`): las líneas que manda el grupo (materializadas,
 * origen 'GRUPO') REEMPLAZAN a las GRUPO persistidas, pero las líneas
 * PROPIAS del hijo (origen 'VUELO' o legado sin bandera — p. ej. un catering
 * capturado solo en ese avión) se CONSERVAN: re-materializar el grupo jamás
 * borra en silencio lo que oficina agregó en el hijo (el consolidado las
 * lista con su matrícula). Sin entrantes ⇒ solo quedan las propias.
 */
export function mezclarExtrasDesdeGrupo<T extends ExtraConCantidad>(
  persistidos: unknown,
  entrantes: T[] | undefined,
): Array<T | ExtraConCantidad> {
  const lista = Array.isArray(persistidos)
    ? (persistidos as ExtraConCantidad[])
    : [];
  const propios = lista.filter((e) => e && e.origen !== ORIGEN_EXTRA_GRUPO);
  return [...(entrantes ?? []), ...propios];
}
