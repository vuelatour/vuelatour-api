/**
 * «OTROS MOVIMIENTOS (VUELATOUR)» COMO GASTO (23-oct-2026, API 0.0.106,
 * invariante 107 del CLAUDE.md del API). Pedido del cliente (con la captura
 * del select de categorías del gasto): «Falta la opción de agregar un gasto a
 * la hoja de "otros movimientos" en el balance general.»
 *
 * PURO (sin BD ni Nest): la GRAMÁTICA ÚNICA con que el Balance general (hoja
 * «otros movimientos», `buildOtrosMovimientos`) y el Libro Dinero («Otros
 * ingresos» del vuelo y «otros gastos» sin vuelo) pintan un gasto de la
 * categoría `OTROS_MOVIMIENTOS`: el CONCEPTO de la línea de egreso, la clave
 * de la fila suelta y el orden determinista. Si cambia un texto, cambia aquí
 * y los dos libros lo siguen. Acepta las filas CRUDAS de PostgREST
 * (`Record<string, unknown>`): cada campo se verifica antes de usarse.
 *
 * Reglas:
 *  - El concepto es lo que escribió la oficina: la primera línea útil de
 *    `notas` (se saltan el bloque «Desglose:» de la IA y las líneas de aviso
 *    «⚠»); sin notas, la etiqueta «Otros movimientos (VuelaTour)».
 *  - Después, el proveedor (o el lugar) como en las sueltas de siempre, el
 *    sufijo de efectivo de las notas de celda del balance (« (efectivo)» /
 *    « (efectivo de la empresa)») y, si el gasto en USD no llegó a pesos,
 *    « (USD sin TC)» (la fila sale visible, jamás sumada en falso).
 *  - La CLAVE de la fila suelta es «otros movimientos sin vuelo» (paralela a
 *    «tuas sin vuelo»); con avión sellado el balance antepone la matrícula.
 */
import {
  CATEGORIA_OTROS_MOVIMIENTOS,
  etiquetaCategoriaGasto,
} from './categoria-gasto.util';

/** Clave de la fila SUELTA de «otros movimientos» (gasto sin vuelo). */
export const CLAVE_SUELTA_OTROS_MOVIMIENTOS = 'otros movimientos sin vuelo';

/**
 * Nota del concepto en «otros gastos» del Libro Dinero para un gasto SIN
 * vuelo: se LISTA (el dinero no se esconde) pero no suma al acumulado ni se
 * acredita a ningún avión — espejo del TUA pagado sin vuelo («(TUA pagado —
 * no resta: Otros movimientos)»).
 */
export const SUFIJO_DINERO_OTROS_MOVIMIENTOS =
  '(egreso VuelaTour — no resta: Otros movimientos)';

/**
 * Lo mínimo de un gasto para su concepto en los libros. Los campos van como
 * `unknown` a propósito: los libros leen filas crudas de PostgREST.
 */
export interface GastoOtroMovimiento {
  id?: unknown;
  categoria?: unknown;
  fecha_gasto?: unknown;
  notas?: unknown;
  lugar?: unknown;
  medio_pago?: unknown;
  proveedor?: unknown;
}

/** ¿Es un gasto «Otros movimientos (VuelaTour)»? (igualdad exacta). */
export function esOtroMovimiento(g: { categoria?: unknown }): boolean {
  return g.categoria === CATEGORIA_OTROS_MOVIMIENTOS;
}

/** Texto no vacío (recortado) o null. */
function texto(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Primera línea útil de las notas: lo que escribió la oficina. El bloque
 * «Desglose:» que anexa la IA va AL FINAL de las notas (`expenses.service`),
 * así que todo lo que sigue a ese marcador se ignora; las líneas de aviso
 * «⚠» se saltan.
 */
function tituloDeNotas(notas: unknown): string | null {
  if (typeof notas !== 'string') return null;
  for (const linea of notas.split('\n')) {
    const t = linea.trim();
    if (/^desglose:/i.test(t)) break;
    if (!t || t.startsWith('⚠')) continue;
    return t;
  }
  return null;
}

/** `proveedor:proveedor_id(nombre)` embebido (objeto o [objeto]). */
function nombreProveedor(proveedor: unknown): string | null {
  const raw: unknown = Array.isArray(proveedor) ? proveedor[0] : proveedor;
  if (raw == null || typeof raw !== 'object') return null;
  return texto((raw as { nombre?: unknown }).nombre);
}

/** El mismo sufijo de las notas de celda del balance (`sufijoEfectivo`). */
function sufijoEfectivo(medio: unknown): string {
  if (medio === 'EFECTIVO') return ' (efectivo)';
  if (medio === 'EFECTIVO_EMPRESA') return ' (efectivo de la empresa)';
  return '';
}

/**
 * Concepto de la línea de EGRESO del gasto en los libros:
 * «<notas | Otros movimientos (VuelaTour)>[ · <proveedor | lugar>][ (efectivo)][ (USD sin TC)]».
 */
export function conceptoOtroMovimiento(
  g: GastoOtroMovimiento,
  opts: { sinTc?: boolean } = {},
): string {
  const titulo =
    tituloDeNotas(g.notas) ??
    etiquetaCategoriaGasto(CATEGORIA_OTROS_MOVIMIENTOS);
  const referencia = nombreProveedor(g.proveedor) ?? texto(g.lugar);
  return `${titulo}${referencia ? ` · ${referencia}` : ''}${sufijoEfectivo(
    g.medio_pago,
  )}${opts.sinTc ? ' (USD sin TC)' : ''}`;
}

/**
 * Orden determinista de las líneas de un vuelo (y de las sueltas): por
 * `fecha_gasto` y después por `id`. PostgREST no ordena los gastos de los
 * vuelos; sin esto, dos descargas podían listar los egresos en distinto
 * orden dentro de la nota de la celda.
 */
export function ordenarOtrosMovimientos<
  T extends { fecha_gasto?: unknown; id?: unknown },
>(gastos: readonly T[]): T[] {
  const clave = (v: unknown): string => (typeof v === 'string' ? v : '');
  return [...gastos].sort((a, b) => {
    const f = clave(a.fecha_gasto).localeCompare(clave(b.fecha_gasto));
    return f !== 0 ? f : clave(a.id).localeCompare(clave(b.id));
  });
}
