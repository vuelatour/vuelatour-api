/**
 * PRE-CIERRE · `gastos_por_pagar` (19-oct-2026, API 0.0.95, invariante 93;
 * revisión del 19-oct-2026, hallazgos P1 y P2). PURO.
 *
 * Un gasto «por pagar» pertenece al periodo por su MES CONTABLE, con la MISMA
 * regla del candado de mes cerrado (`gastoDelCandado` + `diaContableDeGasto`,
 * invariante 89): eje vuelo ⇒ el mes contable de su vuelo; eje gasto ⇒
 * `fecha_gasto`. Sin la migración del cierre el embed del vuelo no trae
 * `fecha_contable` y el eje vuelo usa `fecha_vuelo`, como los libros.
 *
 * Por qué no `fecha_gasto` (caso del 30-sep): un TAXI por pagar del vuelo
 * #400 del 30-sep, fechado el 1-oct, cuenta en los libros de SEPTIEMBRE (eje
 * vuelo). Con el filtro por fecha no frenaba el cierre de septiembre, sí el
 * de octubre, y una vez cerrado septiembre marcarlo pagado o borrarlo daba
 * 409 MES_CERRADO: el gasto quedaba atrapado.
 */
import { CATEGORIA_NOMINA } from '../../common/categoria-gasto.util';
import {
  gastoDelCandado,
  type VueloDelCandado,
} from '../../common/cierre-mes.lector';
import { vueloEmbebido } from '../../common/hojas-balance.util';
import { diaContableDeGasto } from '../../common/mes-contable.util';

/**
 * Columnas del gasto por pagar para decidir su mes contable (las del candado
 * + el embed de su vuelo). `colsVuelo` = las columnas EXTRA del vuelo con la
 * sonda del cierre (`colsVueloContable`), '' sin ella.
 */
export function selectPorPagarPrecierre(colsVuelo: string): string {
  return `id, monto, moneda, fecha_gasto, por_pagar, conciliado, categoria, vuelo_id, aeronave_id, escala_id, vuelo:vuelo_id(fecha_vuelo, aeronave_id, es_externo${colsVuelo})`;
}

/**
 * Día (YYYY-MM-DD) en el que CUENTA el gasto por pagar: el que evalúa el
 * candado de mes cerrado (sin escala embebida ni repartos, como él). `null`
 * sin ninguna fecha legible.
 */
export function diaContablePorPagar(g: Record<string, unknown>): string | null {
  const vuelo = vueloEmbebido(g) as VueloDelCandado | null;
  return diaContableDeGasto(gastoDelCandado(g, vuelo));
}

/** ¿El gasto por pagar es de este periodo (su día contable en `[desde, hasta]`)? */
export function porPagarEnPeriodoContable(
  g: Record<string, unknown>,
  desde: string,
  hasta: string,
): boolean {
  const dia = diaContablePorPagar(g);
  return dia != null && dia >= desde.slice(0, 10) && dia <= hasta.slice(0, 10);
}

/**
 * `ids_nomina` del renglón (ADITIVO, P2): el subconjunto de `ids` —en su
 * orden— cuya categoría es NOMINA. La nómina vive solo en su módulo
 * (invariante 91): el panel la resuelve en Nómina, no en Gastos.
 */
export function idsNominaDe(
  lista: ReadonlyArray<Record<string, unknown>>,
  ids: readonly string[],
): string[] {
  const nomina = new Set(
    lista
      .filter((g) => g.categoria === CATEGORIA_NOMINA)
      .map((g) => (typeof g.id === 'string' ? g.id : '')),
  );
  return ids.filter((id) => nomina.has(id));
}
