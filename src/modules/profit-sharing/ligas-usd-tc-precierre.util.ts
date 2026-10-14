/**
 * PRE-CIERRE → «Gastos en dólares conciliados con un tipo de cambio fuera
 * de lugar» (13-oct-2026, lote 2, API 0.0.75, invariante 70).
 *
 * Caso real (Aircraft Spruce): el tubo Michelin (422.86 USD) quedó
 * conciliado con «ASA CANCUN» $8,939.38 (T.C. 21.14 contra un oficial de
 * 17.01, +24.3 %) y la BD derivó de esa liga un `tc_gasto` que movía los
 * pesos del gasto en el balance y en el reparto. Este renglón lista las
 * ligas cruzadas (gasto USD ↔ cargo en pesos) cuyo T.C. implícito queda a
 * más de ±2 % del oficial del día del CARGO o fuera de la banda 15–25. La
 * lectura y la regla viven en conciliación (`ligasUsdTcFueraDeLugar`,
 * `auto-cruce.util`); aquí, PURO, solo el renglón y sus textos.
 *
 * Aviso NO bloqueante (`bloqueantes`/`listo` no cambian): una compra
 * legítima con sobreprecio del banco > 2 % seguirá saliendo cada mes (no
 * hay «descartar» sin decisión del cliente). El sistema no corrige nada
 * solo.
 */
import {
  TC_IMPLICITO_MAX,
  TC_IMPLICITO_MIN,
  TOLERANCIA_TC_OFICIAL_PCT,
} from '../conciliacion/auto-cruce.util';
import type {
  LigaUsdTcFueraDeLugar,
  ResultadoLigasUsdTc,
} from '../conciliacion/ligas-usd-tc.util';

export const CLAVE_PRECIERRE_LIGAS_USD_TC = 'gastos_usd_tc_fuera_de_lugar';

export const TITULO_PRECIERRE_LIGAS_USD_TC =
  'Gastos en dólares conciliados con un tipo de cambio fuera de lugar';

export const DETALLE_PRECIERRE_LIGAS_USD_TC = `Su cargo del banco en pesos da un tipo de cambio a más de ±${TOLERANCIA_TC_OFICIAL_PCT} % del oficial del día del cargo (o fuera de la banda ${TC_IMPLICITO_MIN}–${TC_IMPLICITO_MAX}): casi seguro es OTRO cargo, y el T.C. que la base de datos derivó de él mueve los pesos de ese gasto en el balance y en el reparto. Revísalos en Conciliación: desvincula y vincula el cargo correcto. Si de verdad fue así, el aviso seguirá saliendo, pero no bloquea el cierre. El sistema no corrige nada solo.`;

/** La lectura FALLÓ (null, excepción o método ausente): el 0 no significa «no hay». */
export const DETALLE_PRECIERRE_LIGAS_USD_TC_FALLIDA =
  'No se pudo revisar el tipo de cambio de los gastos en dólares conciliados: vuelve a abrir el pre-cierre en unos minutos.';

/**
 * Ligas en banda SIN T.C. oficial del día de su cargo. `conLigas` = la frase
 * que se AGREGA al detalle cuando también hay ligas fuera de lugar; sin
 * ligas, el detalle completo (y el renglón queda «sin verificar»).
 */
export function textoSinVerificarLigasUsdTc(
  n: number,
  conLigas: boolean,
): string {
  const uno = n === 1;
  if (conLigas) {
    return uno
      ? ' Además, 1 gasto en dólares conciliado no se pudo revisar: no hay T.C. oficial del día de su cargo.'
      : ` Además, ${n} gastos en dólares conciliados no se pudieron revisar: no hay T.C. oficial del día de su cargo.`;
  }
  return uno
    ? 'No se pudo revisar el tipo de cambio de 1 gasto en dólares conciliado: no hay T.C. oficial del día de su cargo. Vuelve a abrir el pre-cierre más tarde.'
    : `No se pudo revisar el tipo de cambio de ${n} gastos en dólares conciliados: no hay T.C. oficial del día de su cargo. Vuelve a abrir el pre-cierre más tarde.`;
}

/** El renglón del pre-cierre (va justo después de `gastos_bancarios_sin_conciliar`). */
// `type` (no `interface`): los specs leen los items como filas con índice.
export type ItemPrecierreLigasUsdTc = {
  clave: typeof CLAVE_PRECIERRE_LIGAS_USD_TC;
  titulo: string;
  detalle: string;
  /** = `ligas.length`. */
  count: number;
  ligas: LigaUsdTcFueraDeLugar[];
  sin_verificar: number;
  lectura_fallida: boolean;
};

/**
 * `r` null ⇒ lectura fallida (texto de reintento). Sin ligas y con
 * `sin_verificar` > 0 ⇒ también «sin verificar» con su propio texto. Con
 * ligas y `sin_verificar` > 0, el detalle suma la frase «Además, …» y
 * `lectura_fallida` queda en false.
 */
export function itemPrecierreLigasUsdTc(
  r: ResultadoLigasUsdTc | null,
): ItemPrecierreLigasUsdTc {
  const ligas = r?.ligas ?? [];
  const sinVerificar = r?.sin_verificar ?? 0;
  const lecturaFallida = r === null || (ligas.length === 0 && sinVerificar > 0);
  const detalle =
    r === null
      ? DETALLE_PRECIERRE_LIGAS_USD_TC_FALLIDA
      : ligas.length === 0 && sinVerificar > 0
        ? textoSinVerificarLigasUsdTc(sinVerificar, false)
        : `${DETALLE_PRECIERRE_LIGAS_USD_TC}${sinVerificar > 0 ? textoSinVerificarLigasUsdTc(sinVerificar, true) : ''}`;
  return {
    clave: CLAVE_PRECIERRE_LIGAS_USD_TC,
    titulo: TITULO_PRECIERRE_LIGAS_USD_TC,
    detalle,
    count: ligas.length,
    ligas,
    sin_verificar: sinVerificar,
    lectura_fallida: lecturaFallida,
  };
}
