/**
 * HORAS PACTADAS — PRECISIÓN ÚNICA DEL SISTEMA (22-sep-2026).
 *
 * EL PROBLEMA (cotizaciones #322 y #302, capturas del cliente): la misma
 * cotización —XB-PEV, CUN→PTU→CUN, tarifa $600/hr, «Cobrable pactado»
 * 2.333333333 hr (= 2 h 20 min)— imprimía DOS totales distintos:
 * $1,400.00 / $1,624.00 la primera vez y $1,399.98 / $1,623.98 al reabrirla y
 * volver a guardarla. Cita del cliente: «no me lo redondea en la primer
 * captura de la cotización 322; aquí sí en la segunda captura de la 302».
 *
 * CAUSA RAÍZ (misma familia que el T.C. de 4 decimales, `tc.util.ts`): el
 * motor multiplicaba con la precisión COMPLETA que tecleó la oficina
 * (2.333333333 × 600 = 1,400.00) pero PERSISTÍA las horas redondeadas a 4
 * decimales —`round4` en el snapshot y `numeric(10,4)` en
 * `vuelo.tiempo_cobrable_hr`—. Al reabrir, el panel REHIDRATA el pactado
 * desde ese snapshot: 2.3333 × 600 = 1,399.98, y al guardar el descuadre
 * quedaba persistido. Historial real de #322: v1 = 1,400.00 (18-sep 17:07) →
 * v2 = 1,399.98 (17:16) con las MISMAS horas 2.3333.
 *
 * LA REGLA (invariante 22 del repo): **lo que se PERSISTE es EXACTAMENTE lo
 * que se usó para MULTIPLICAR**. El motor normaliza las horas cobrables a 8
 * decimales ANTES de calcular el subtotal y guarda ese mismo número (columnas
 * `numeric(14,8)`, migración `20260922000001_horas_pactadas_ocho_decimales`),
 * así reabrir y guardar sin tocar nada JAMÁS mueve un total.
 *
 * Por qué 8 y no 4 ni 6: 8 decimales bastan para que cualquier fracción de
 * hora tecleada como h:mm (2:20 → 2.33333333) reproduzca el centavo incluso a
 * tarifas altas — 2.33333333 × 9,750 = 22,749.99997 → $22,750.00 exacto,
 * mientras que con 2.3333 daba $22,749.68 (32 centavos de menos).
 */

/** Decimales canónicos de unas horas pactadas en este sistema. */
export const HORAS_DECIMALES = 8;

const FACTOR_HORAS = 10 ** HORAS_DECIMALES;

/**
 * Media unidad del 4.º decimal: el error MÁXIMO que puede introducir un
 * viaje de ida y vuelta por la precisión vieja (`round4` / `numeric(10,4)`).
 * Por debajo de esto no hay intención humana posible — nadie pacta horas al
 * quinto decimal — así que una diferencia menor es SIEMPRE el eco de una
 * copia truncada, nunca una edición.
 */
export const HORAS_TOLERANCIA_ECO = 0.00005;

/** Redondeo a 8 decimales (la precisión con la que la BD guarda las horas). */
export function round8(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  const abs = Math.abs(n);
  const r = Math.round((abs + Number.EPSILON) * FACTOR_HORAS) / FACTOR_HORAS;
  return n < 0 ? -r : r;
}

/**
 * Normaliza unas horas capturadas (DTO, snapshot, columna) a la precisión
 * canónica. `null` cuando no es un número positivo — "sin horas pactadas" se
 * propaga explícito, nunca como 0 (un 0 significaría "cobrar $0").
 *
 * Es IDEMPOTENTE: aplicarla a unas horas ya normalizadas devuelve el mismo
 * número, así que el motor puede llamarla al calcular y otra vez al
 * persistir sin que el valor se mueva.
 */
export function normalizarHoras(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return round8(n);
}

/** Decimales SIGNIFICATIVOS de unas horas ya normalizadas (0…8). */
function decimalesDe(v: number): number {
  for (let d = 0; d < HORAS_DECIMALES; d++) {
    const f = 10 ** d;
    if (Math.round(v * f) / f === v) return d;
  }
  return HORAS_DECIMALES;
}

/**
 * ¿`entrante` es el ECO TRUNCADO de `persistido` (y no una edición real)?
 *
 * Verdadero solo si difieren por MENOS de media unidad del 4.º decimal Y el
 * entrante tiene MENOS decimales: la firma exacta de un cliente que leyó unas
 * horas guardadas con la precisión vieja y las devolvió tal cual (panel
 * anterior al 22-sep, integración externa, borrador viejo en caché).
 *
 * Nunca se cumple cuando la oficina teclea MÁS precisión (2.3333 →
 * 2.33333333) ni cuando cambia el pactado de verdad (2.3333 → 2.3334, que a
 * $600/hr son 6 centavos, delta 6.67e-5 > la tolerancia): esas ediciones se
 * respetan siempre.
 *
 * PUNTO CIEGO CONOCIDO (revisión adversaria 22-sep-2026, decírselo a quien
 * toque esto): un eco truncado y un REDONDEO DELIBERADO a 4 decimales son el
 * MISMO número y no hay forma de distinguirlos. Si lo persistido es
 * 3.2969697 (vuelo #309, $1,650/hr) y la oficina teclea «3.297» a propósito
 * —que es exactamente `round4` de lo persistido, delta 3.03e-5— se ancla y su
 * edición de **5 centavos** se descarta en silencio. Es el precio de que
 * reabrir y guardar jamás mueva un total, y la decisión está tomada en ese
 * sentido: con el campo nuevo el operador VE «3.2969697» antes de teclear, y
 * para mover el precio de verdad tiene el ajuste/descuento. Si algún día hace
 * falta permitirlo, el camino limpio es un campo ADITIVO en el DTO («el
 * humano tocó las horas»), no bajar la tolerancia.
 */
export function esEcoDeHorasPactadas(
  entrante: number,
  persistido: number,
): boolean {
  if (!Number.isFinite(entrante) || !Number.isFinite(persistido)) return false;
  if (entrante === persistido) return false;
  if (Math.abs(entrante - persistido) > HORAS_TOLERANCIA_ECO) return false;
  return decimalesDe(entrante) < decimalesDe(persistido);
}

/**
 * HORAS PACTADAS REALMENTE PERSISTIDAS de un vuelo: entre el snapshot
 * (`calculo_snapshot.tiempos.cobrable_hr`) y la columna
 * (`vuelo.tiempo_cobrable_hr`) gana el que conserve MÁS decimales, siempre
 * que sean el MISMO pactado (difieren solo por el truncamiento viejo).
 *
 * Por qué hacen falta los dos: el backfill de la migración corrige ambos, pero
 * una fila que no se pudo tocar —o escrita por un API viejo— puede tener uno
 * de los dos truncado; leer el más preciso evita revivir el descuadre.
 * Si divergen DE VERDAD (otro pactado), manda el snapshot: es el registro
 * propio del motor, el mismo con el que compuso el precio.
 */
export function horasPactadasPersistidas(
  snapshot: unknown,
  columna: unknown,
): number | null {
  const s = normalizarHoras(snapshot);
  const c = normalizarHoras(columna);
  if (s == null) return c;
  if (c == null) return s;
  if (esEcoDeHorasPactadas(s, c)) return c;
  return s;
}
