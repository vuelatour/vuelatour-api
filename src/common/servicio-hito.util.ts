/**
 * ¿QUÉ ORDEN DE MANTENIMIENTO CUBRE ESTE HITO DEL PROGRAMA DE SERVICIO?
 * (20-sep-2026)
 *
 * FUENTE ÚNICA de la regla, compartida por los DOS lados que tienen que
 * coincidir siempre:
 *  - el DEDUPE de `AlertsService.checkServicioPorHoras` /
 *    `revisarServicioDeAvion` — jamás crear dos veces la misma orden (ni
 *    duplicar la que el mecánico ya levantó a mano), y
 *  - el campo `proximo_servicio.orden` de la ficha del avión
 *    (`AircraftService.aircraftMetrics` y `tacometroHistorial`), que le dice
 *    al operador si la orden YA existe y en qué va.
 *
 * Si la regla viviera en dos lados podría desincronizarse y dejar el peor de
 * los mundos: la tarjeta diciendo «no hay orden» mientras el check decide
 * «ya existe» — y entonces nadie la crea nunca.
 *
 * Todo aquí es PURO (sin BD, sin fechas del sistema): se prueba con specs.
 */

/**
 * Tolerancia al comparar horas contra un hito. El hobbs y los hitos viajan a
 * 1 decimal; 0.05 es media décima (el criterio histórico del check).
 */
export const TOLERANCIA_HITO_HR = 0.05;

/**
 * Prefijo EXACTO de `mantenimiento.notas` cuando la orden la creó el programa
 * automático. Lo ESCRIBE el check y lo LEE `orden.automatica`: una sola
 * constante para que no puedan divergir (si divergieran, la tarjeta diría
 * «la levantó alguien a mano» de una orden que creó el sistema).
 */
export const NOTA_SERVICIO_AUTOMATICO = 'Creado automáticamente';

/** Columnas mínimas de `mantenimiento` que necesitan el dedupe y el campo
 *  `orden`. Un solo select para los dos usos. */
export const MANT_HITO_COLS =
  'id, estado, horas_programadas, etapa_intervalo_hr, fecha_realizada, fecha_programada, horas_aeronave, notas';

/** Hito del programa cíclico: «servicio de <intervalo> h a las <a_las> h». */
export interface HitoServicio {
  a_las: number;
  intervalo: number;
}

/** Fila de `mantenimiento` (solo lo que la regla mira). */
export interface MantenimientoHitoRow {
  id: string;
  estado?: string | null;
  horas_programadas?: number | string | null;
  etapa_intervalo_hr?: number | string | null;
  fecha_realizada?: string | null;
  fecha_programada?: string | null;
  horas_aeronave?: number | string | null;
  notas?: string | null;
}

/** La orden ABIERTA que cubre el hito, tal como la expone el snapshot. */
export interface OrdenServicio {
  id: string;
  /** PROGRAMADO (con o sin fecha) o EN_TALLER (ya entró). */
  estado: 'PROGRAMADO' | 'EN_TALLER';
  /** `null` = programada pero SIN fecha confirmada (lo normal al nacer). */
  fecha_programada: string | null;
  /** La creó el programa automático (no el mecánico a mano). */
  automatica: boolean;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** ¿`v` es el mismo número que `objetivo` dentro de la tolerancia del hito? */
function cerca(v: unknown, objetivo: number): boolean {
  const n = num(v);
  return n != null && Math.abs(n - objetivo) < TOLERANCIA_HITO_HR;
}

/**
 * ¿Esta orden CUBRE el hito? (criterio del dedupe, EN CUALQUIER ESTADO)
 *
 * 1. Mismo hito por horas programadas (±0.05) — da igual el estado.
 * 2. Servicio de la MISMA etapa ya HECHO dentro del ciclo actual (entró a
 *    horas ∈ (hito − intervalo, hito + 0.05]): el hito está cubierto aunque
 *    el hobbs no lo rebase todavía — no re-crear lo que el mecánico acaba de
 *    terminar (verificación 26-ago-2026).
 * 3. Entrada MANUAL abierta de la misma etapa SIN horas programadas: es la
 *    que levantó el mecánico; duplicarla sería ruido.
 */
export function mantenimientoCubreHito(
  m: MantenimientoHitoRow,
  hito: HitoServicio,
): boolean {
  if (cerca(m.horas_programadas, hito.a_las)) return true;
  if (m.estado === 'COMPLETADO' || m.fecha_realizada != null) {
    const ha = num(m.horas_aeronave);
    return (
      cerca(m.etapa_intervalo_hr, hito.intervalo) &&
      ha != null &&
      ha > hito.a_las - hito.intervalo &&
      ha <= hito.a_las + TOLERANCIA_HITO_HR
    );
  }
  return (
    m.horas_programadas == null && cerca(m.etapa_intervalo_hr, hito.intervalo)
  );
}

/** La primera orden (en cualquier estado) que cubre el hito, o `null`. */
export function mantenimientoQueCubreHito(
  mantenimientos: readonly MantenimientoHitoRow[],
  hito: HitoServicio,
): MantenimientoHitoRow | null {
  return mantenimientos.find((m) => mantenimientoCubreHito(m, hito)) ?? null;
}

/** ¿Hay ya una orden para este hito? (lo que decide NO crear otra). */
export function hitoYaTieneOrden(
  mantenimientos: readonly MantenimientoHitoRow[],
  hito: HitoServicio,
): boolean {
  return mantenimientos.some((m) => mantenimientoCubreHito(m, hito));
}

/**
 * ¿La orden sigue ABIERTA? Un COMPLETADO (o con `fecha_realizada`) ya no es
 * «lo que hay que atender»: cubre el hito para el dedupe, pero no se muestra
 * como orden pendiente en la tarjeta.
 * Filas legadas sin `estado` cuentan como PROGRAMADO (el enum llegó después).
 */
export function ordenEstaAbierta(m: MantenimientoHitoRow): boolean {
  return m.fecha_realizada == null && m.estado !== 'COMPLETADO';
}

/** ¿La creó el programa automático? (prefijo exacto en `notas`). */
export function ordenEsAutomatica(m: MantenimientoHitoRow): boolean {
  return (m.notas ?? '').trimStart().startsWith(NOTA_SERVICIO_AUTOMATICO);
}

/** Mapea una fila abierta al contrato público `orden`. `null` si está cerrada. */
export function ordenDeServicio(
  m: MantenimientoHitoRow | null | undefined,
): OrdenServicio | null {
  if (!m || !ordenEstaAbierta(m)) return null;
  return {
    id: m.id,
    estado: m.estado === 'EN_TALLER' ? 'EN_TALLER' : 'PROGRAMADO',
    fecha_programada: (m.fecha_programada as string | null) ?? null,
    automatica: ordenEsAutomatica(m),
  };
}

/**
 * La orden ABIERTA que cubre el hito (la que el panel pinta bajo «Próximo
 * servicio»), o `null` si el hito aún no tiene orden viva.
 *
 * Con varias candidatas (no debería, pero el mecánico puede haber levantado
 * una a mano el mismo día) gana la MÁS AVANZADA y determinista: EN_TALLER →
 * PROGRAMADO con fecha → PROGRAMADO sin fecha; a igualdad, la de `id` menor.
 */
export function ordenAbiertaDelHito(
  mantenimientos: readonly MantenimientoHitoRow[],
  hito: HitoServicio,
): OrdenServicio | null {
  const abiertas = mantenimientos
    .filter((m) => ordenEstaAbierta(m) && mantenimientoCubreHito(m, hito))
    .map((m) => ordenDeServicio(m))
    .filter((o): o is OrdenServicio => o != null);
  if (abiertas.length === 0) return null;
  const rango = (o: OrdenServicio) =>
    o.estado === 'EN_TALLER' ? 0 : o.fecha_programada ? 1 : 2;
  return abiertas.sort((a, b) => {
    const d = rango(a) - rango(b);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  })[0];
}
