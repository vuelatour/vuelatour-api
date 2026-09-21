/**
 * REDONDEO DECIMAL — la mecánica compartida de las tres precisiones del
 * sistema (22-sep-2026).
 *
 * `tc.util` (6 decimales), `horas.util` (8) y `tarifa.util` (6) son la MISMA
 * regla aplicada a los tres factores del precio: **lo que se persiste es
 * EXACTAMENTE lo que se usó para multiplicar**. Los tres traían una copia
 * literal de este redondeo; aquí vive una sola vez para que el borde del
 * `.5` —el `Number.EPSILON` de abajo— no se corrija en un archivo y se quede
 * viejo en los otros dos.
 *
 * NO cambia ningún contrato: `round6` y `round8` siguen exportándose desde
 * sus utils con la misma firma y el mismo resultado (sus specs lo congelan).
 */

/**
 * Redondea a `decimales` decimales con la mecánica de siempre.
 *
 * - `Number.EPSILON` corrige el borde del `.5`: en float64, `1.005 * 100` es
 *   `100.49999999999999` y `Math.round` lo bajaría a 1.00.
 * - El signo se aplica al final (se redondea el valor absoluto) para que
 *   `-2.5` y `2.5` se alejen del cero por igual; `Math.round(-2.5)` es `-2`.
 * - Un no-número se propaga como `NaN`, nunca como 0 en falso: quien llama
 *   decide qué significa "sin dato" (los `normalizar*` devuelven `null`).
 */
export function redondearA(n: number, decimales: number): number {
  if (!Number.isFinite(n)) return NaN;
  const factor = 10 ** decimales;
  const abs = Math.abs(n);
  const r = Math.round((abs + Number.EPSILON) * factor) / factor;
  return n < 0 ? -r : r;
}

/**
 * Decimales SIGNIFICATIVOS de un número ya redondeado a `maximo` decimales
 * (0…`maximo`): cuántos hacen falta para escribirlo sin perder nada.
 *
 * Es lo que distingue un **eco truncado** (un cliente que leyó un valor
 * guardado con la precisión vieja y lo devuelve tal cual) de una EDICIÓN
 * real: el eco siempre trae MENOS decimales que lo persistido.
 */
export function decimalesSignificativos(v: number, maximo: number): number {
  if (!Number.isFinite(v)) return 0;
  for (let d = 0; d < maximo; d++) {
    const f = 10 ** d;
    if (Math.round(v * f) / f === v) return d;
  }
  return maximo;
}
