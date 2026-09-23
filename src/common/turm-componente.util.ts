/**
 * T.U.R.M. = **TIEMPO desde la Última Reparación Mayor** = TSO (22-sep-2026).
 *
 * FUENTE ÚNICA de la conversión «lo que la oficina copia de la bitácora
 * física» → `tso_base` (la columna que viaja con el componente y desde la
 * que se deriva el TSO vivo, `tso_base + delta del taco`).
 *
 * EL BUG QUE CORRIGE (reporte del cliente, hélice del XB-ANU): el API leía
 * `turm_componente` como «horas del componente EN su último overhaul» y
 * guardaba `tso_base = horas_totales − turm_componente`. En la bitácora
 * física T.U.R.M. es lo CONTRARIO: las horas voladas DESDE esa reparación.
 * La oficina capturó T.T. 2708 y T.U.R.M. 364 (hélice s/n 782316, TBO 2000)
 * y el sistema guardó `tso_base = 2708 − 364 = 2344`: la ficha pintaba
 * «TSO 2,344.00 · Restantes −344.00 · Vida usada 100 %» y el avión aparecía
 * con «TBO agotado» en el semáforo de aptitud. Con la lectura correcta,
 * `tso_base = 364` ⇒ TSO 364, restantes 1,636, vida 18.2 %.
 *
 * Reglas:
 * - `turm = null` ⇒ **sin overhaul registrado**: `tso_base = null` (el
 *   estado cae al respaldo «TSO = horas de vida», ver `componenteEstado`).
 * - `turm` numérico ⇒ es el TSO **de hoy**: `tso_base = turm − delta del
 *   taco desde el ancla`, redondeado a 1 decimal (misma precisión que el
 *   resto de las horas del repo). Con el componente recién anclado el delta
 *   es 0 y `tso_base = turm` (caso XB-ANU). Ver el bloque de
 *   `resolverTsoBase`: sin restar el delta, el N4142R (anclado 1,098 h
 *   atrás) guardaría un TSO inflado en esas mismas horas.
 * - `turm > horas de vida VIVAS` ⇒ **400 con texto claro**: nadie puede
 *   haber volado más desde la reparación que en toda la vida del
 *   componente. Sin este candado, el error de captura entra igual y vuelve
 *   a romper la ficha (era justo lo que pasaba al revés).
 *
 * PURO a propósito (sin Nest ni Supabase): lo usan `engines.service` y
 * `propellers.service` en `create` y `update`, y su spec congela el caso
 * REAL del XB-ANU.
 */

/** Redondeo a 1 decimal, el mismo de `horas-componente.util`. */
const r1 = (x: number): number => Number(x.toFixed(1));

const fmt = (x: number): string =>
  x.toLocaleString('es-MX', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

export type ResolucionTsoBase =
  | { ok: true; tso_base: number | null }
  | { ok: false; mensaje: string };

/**
 * Mensaje del 400 cuando el T.U.R.M. capturado supera las horas totales.
 * Exportado para que el spec (y quien lea el contrato) use el texto EXACTO.
 */
export function mensajeTurmSuperaTotales(
  turm: number,
  horasBase: number,
): string {
  return (
    `El tiempo desde el overhaul (T.U.R.M. = ${fmt(turm)} h) no puede superar ` +
    `las horas totales del componente (T.T. = ${fmt(horasBase)} h). En la ` +
    'bitácora, T.T. son las horas de vida y T.U.R.M. las horas voladas DESDE ' +
    'la última reparación mayor: revisa cuál de los dos se capturó al revés.'
  );
}

/** Mensaje del 400 cuando el T.U.R.M. capturado es negativo. */
export function mensajeTurmNegativo(turm: number): string {
  return (
    `El tiempo desde el overhaul (T.U.R.M. = ${fmt(turm)} h) no puede ser ` +
    'negativo.'
  );
}

/**
 * `tso_base` que hay que guardar para un T.U.R.M. capturado de la bitácora.
 *
 * **EL T.U.R.M. QUE SE TECLEA ES EL DE HOY, Y `tso_base` ESTÁ ANCLADO**
 * (revisión adversaria 22-sep-2026). `tso_base` no es el TSO que se ve: es el
 * TSO **en el ancla** (`aeronave_horas_ref`), y el vivo lo reconstruye
 * `componenteEstado` sumando el delta del taco (invariante 1):
 *
 *   TSO vivo = tso_base + (hobbs − aeronave_horas_ref)
 *
 * La oficina copia de la bitácora el T.U.R.M. de HOY —y es también lo que el
 * panel le prellena, porque `componenteEstado` devuelve el TSO VIVO—, así que
 * guardarlo TAL CUAL sin descontar el delta lo inflaría en esa misma
 * cantidad. No es teórico: las dos hélices del **N4142R** están ancladas en
 * 4448.9 con el taco en 5546.9 (**delta 1,098 h**), de modo que teclear
 * «TURM 2,400» habría guardado 2,400 y la ficha habría respondido 3,498 —el
 * mismo desconcierto que reportó el cliente, al revés. Por eso:
 *
 *   tso_base = T.U.R.M. tecleado − delta   (puede quedar NEGATIVO: es
 *   legítimo y el cálculo vivo lo compensa — así funcionaba ya el código
 *   anterior, que lo documentaba igual)
 *
 * Con el componente recién anclado (create, o update que re-ancla porque
 * cambiaron las horas totales) el delta es 0 y `tso_base = turm`, que es el
 * caso del XB-ANU.
 *
 * @param horasBase horas totales (T.T.) con las que queda anclado el
 *   componente en esta misma escritura (`dto.horas_totales` si cambió, si no
 *   las guardadas). `null`/`undefined` cuenta como 0.
 * @param turm T.U.R.M. de la bitácora = horas DESDE el último overhaul **al
 *   día de HOY**. `null` = sin overhaul registrado.
 * @param deltaVivo horas voladas desde el ancla (`hobbs − aeronave_horas_ref`,
 *   ya recortado a ≥ 0). 0 cuando esta misma escritura re-ancla.
 */
export function resolverTsoBase(
  horasBase: number | null | undefined,
  turm: number | null,
  deltaVivo: number | null | undefined = 0,
): ResolucionTsoBase {
  if (turm == null) return { ok: true, tso_base: null };
  const turmR = r1(Number(turm));
  if (!Number.isFinite(turmR)) {
    return { ok: false, mensaje: mensajeTurmNegativo(Number(turm)) };
  }
  if (turmR < 0) return { ok: false, mensaje: mensajeTurmNegativo(turmR) };
  const deltaN = Number(deltaVivo ?? 0);
  const deltaR = Number.isFinite(deltaN) ? Math.max(0, r1(deltaN)) : 0;
  // El techo es la vida VIVA del componente (T.T. anclado + lo volado), que
  // es el TSN que el panel pinta al lado y contra el que la oficina compara.
  const tsnVivo = r1(r1(Number(horasBase ?? 0) || 0) + deltaR);
  if (turmR > tsnVivo) {
    return { ok: false, mensaje: mensajeTurmSuperaTotales(turmR, tsnVivo) };
  }
  return { ok: true, tso_base: r1(turmR - deltaR) };
}
