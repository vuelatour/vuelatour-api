/**
 * Horas de tacómetro de UN tramo — FUENTE ÚNICA (8-sep-2026).
 *
 * `taco_llegada − taco_salida` a 1 decimal (el horómetro marca décimas). La
 * usan el reporte por vuelo y el PDF «Cotización interna»; cualquier lector
 * nuevo de "cuánto voló este tramo" pasa por aquí, nunca resta a mano.
 * Sin ambas lecturas → null (jamás 0: un 0 falso se sumaría como volado).
 */
export function horasTacoDe(salida: unknown, llegada: unknown): number | null {
  const s = salida == null || salida === '' ? NaN : Number(salida);
  const l = llegada == null || llegada === '' ? NaN : Number(llegada);
  if (!Number.isFinite(s) || !Number.isFinite(l)) return null;
  return Number((l - s).toFixed(1));
}

/** Σ de horas de taco (1 decimal); null si ningún tramo trae dato. */
export function sumaHorasTaco(
  horas: ReadonlyArray<number | null | undefined>,
): number | null {
  const conDato = horas.filter((h): h is number => h != null);
  if (conDato.length === 0) return null;
  return Number(conDato.reduce((acc, h) => acc + h, 0).toFixed(1));
}
