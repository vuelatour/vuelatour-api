/**
 * FECHA CONTABLE DEL VUELO — primitivas PURAS (16-oct-2026, API 0.0.88,
 * invariante 89, migración `20261016000004_cierre_mes.sql`).
 *
 * «¿En qué mes cuenta este vuelo?» tiene UNA sola respuesta en todo el
 * sistema: `vuelo.fecha_contable` = `coalesce(periodo_contable, fecha_vuelo)`
 * (columna GENERADA de la BD). `periodo_contable` (medianoche Cancún del día
 * 1 del mes al que se DIFIRIÓ el vuelo al cerrar un mes) solo lo escribe el
 * servicio de cierres; `null` = el vuelo cuenta en el mes de su fecha real.
 *
 * Estas dos funciones son el espejo en TypeScript de esa expresión para las
 * filas que ya se leyeron (con o sin la migración: sin ella las columnas no
 * viajan y el resultado es el día Cancún de `fecha_vuelo`, lo de siempre).
 * Viven aparte de `mes-contable.util.ts` para que
 * `ubicacion-balance-gasto.util.ts` (la regla «a qué libro y a qué mes»)
 * pueda importarlas sin ciclo.
 */
import { diaCancun } from './fecha-cancun.util';

/** Lo mínimo de una fila de `vuelo` para decidir su mes contable. */
export interface VueloFechaContable {
  fecha_vuelo?: string | null;
  periodo_contable?: string | null;
  fecha_contable?: string | null;
}

/**
 * Día Cancún (YYYY-MM-DD) del EJE CONTABLE del vuelo: `fecha_contable`;
 * si la lectura no la trae, `periodo_contable ?? fecha_vuelo`. `null` sin
 * fecha legible (un vuelo sin `fecha_vuelo`): el llamador decide.
 */
export function diaContableDeVuelo(
  v: VueloFechaContable | null | undefined,
): string | null {
  if (!v) return null;
  const iso = v.fecha_contable ?? v.periodo_contable ?? v.fecha_vuelo ?? null;
  if (typeof iso !== 'string' || !iso) return null;
  try {
    return diaCancun(iso);
  } catch {
    return null;
  }
}

/** Mes contable 'YYYY-MM' del vuelo (ver `diaContableDeVuelo`). */
export function mesContableDeVuelo(
  v: VueloFechaContable | null | undefined,
): string | null {
  const dia = diaContableDeVuelo(v);
  return dia ? dia.slice(0, 7) : null;
}

/**
 * Mes REAL 'YYYY-MM' del vuelo (día Cancún de `fecha_vuelo`): el de las
 * horas, el calendario y la operación. Distinto del contable solo en un
 * vuelo diferido.
 */
export function mesRealDeVuelo(
  v: { fecha_vuelo?: string | null } | null | undefined,
): string | null {
  const iso = v?.fecha_vuelo ?? null;
  if (typeof iso !== 'string' || !iso) return null;
  try {
    return diaCancun(iso).slice(0, 7);
  } catch {
    return null;
  }
}

/** ¿El vuelo fue DIFERIDO a otro mes (periodo_contable con valor)? */
export function vueloDiferido(
  v: { periodo_contable?: string | null } | null | undefined,
): boolean {
  return typeof v?.periodo_contable === 'string' && v.periodo_contable !== '';
}
