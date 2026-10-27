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
 * Desde el 27-oct-2026 también vive aquí el HITO PENDIENTE
 * (`hitoPendienteDeOrden`): el programa cíclico NO brinca al siguiente
 * servicio mientras una orden ya alcanzada siga abierta (invariante 108).
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

/** Columnas mínimas de `mantenimiento` que necesitan el dedupe, el campo
 *  `orden` y el hito pendiente. Un solo select para los tres usos.
 *  `motor_id`/`helice_id` dejan FUERA los overhauls de componente (27-oct-2026). */
export const MANT_HITO_COLS =
  'id, estado, horas_programadas, etapa_intervalo_hr, fecha_realizada, fecha_programada, horas_aeronave, notas, motor_id, helice_id';

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
  /** Overhaul de un COMPONENTE (motor/hélice): entra al taller el componente,
   *  no la célula — nunca es un servicio del programa del avión. */
  motor_id?: string | null;
  helice_id?: string | null;
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

/** ¿Ya se HIZO? (`estado` COMPLETADO o `fecha_realizada`; el complemento
 *  exacto de `ordenEstaAbierta`, para que nunca haya una tercera lectura). */
export function servicioHecho(m: MantenimientoHitoRow): boolean {
  return !ordenEstaAbierta(m);
}

/**
 * ¿Es un servicio DEL AVIÓN? El overhaul de un motor o de una hélice se
 * guarda en la misma tabla con `motor_id`/`helice_id`: es del componente y
 * no puede sostener ni cubrir un hito del programa de la célula.
 */
export function esServicioDelAvion(m: MantenimientoHitoRow): boolean {
  return m.motor_id == null && m.helice_id == null;
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

// ───────────── Hito PENDIENTE: el programa no brinca (27-oct-2026) ─────────────

/** Intervalos válidos de un programa (positivos, sin repetidos). Es la MISMA
 *  limpieza que hace `AircraftService.proximoServicio`. */
export function intervalosDelPrograma(
  intervalos: readonly unknown[],
): number[] {
  return [
    ...new Set(
      intervalos
        .map((n) => num(n))
        .filter((n): n is number => n != null && n > 0),
    ),
  ];
}

/**
 * Intervalos del programa cíclico cuyos ciclos caen EXACTAMENTE en `aLas`
 * (`base + k × intervalo`, k ≥ 1, ±tolerancia), de menor a mayor. Vacío =
 * ese número NO es un hito del programa (una orden manual «a las 2,212 h»).
 */
export function intervalosEnHito(
  intervalos: readonly unknown[],
  base: unknown,
  aLas: number,
): number[] {
  const b = num(base) ?? 0;
  return intervalosDelPrograma(intervalos)
    .filter((int) => {
      const k = Math.round((aLas - b) / int);
      return k >= 1 && Math.abs(b + k * int - aLas) < TOLERANCIA_HITO_HR;
    })
    .sort((x, y) => x - y);
}

/** El hito que sostiene una orden ABIERTA ya alcanzada. */
export interface HitoPendiente extends HitoServicio {
  /** Intervalos del programa que caen en el hito (ascendente); si la orden
   *  está FUERA del programa, solo su etapa. */
  etapas_incluidas: number[];
  /** La orden abierta que lo sostiene (la de horas más bajas). */
  orden: MantenimientoHitoRow;
}

/**
 * ¿Este hito ya fue ATENDIDO por un servicio HECHO (aunque su orden siga
 * abierta por descuido)? Es lo que evita que una orden huérfana —el mecánico
 * registró el servicio terminado en OTRA fila y nunca cerró la programada—
 * deje al avión «vencido» para siempre.
 *
 *  a) La orden de ese hito se completó: `horas_programadas` ≈ hito (±0.05)
 *     — la regla 1 del dedupe.
 *  b) Un servicio de la MISMA etapa entró DESPUÉS del hito anterior de ese
 *     intervalo (`horas_aeronave > hito − intervalo`), antes o DESPUÉS del
 *     hito: es la regla 2 del dedupe sin su tope superior (un servicio tardío
 *     también atiende). Misma etapa a propósito —no «una mayor incluye a la
 *     menor»—: el dedupe tampoco lo asume, y si aquí lo asumiéramos la ficha
 *     daría por atendido un hito para el que el programa SÍ crea orden. Sin
 *     etapa capturada no se puede atribuir ⇒ no cuenta.
 */
export function hitoAtendido(
  hechos: readonly MantenimientoHitoRow[],
  hito: HitoServicio,
): boolean {
  return hechos.some((h) => {
    if (!servicioHecho(h) || !esServicioDelAvion(h)) return false;
    if (cerca(h.horas_programadas, hito.a_las)) return true;
    const ha = num(h.horas_aeronave);
    return (
      cerca(h.etapa_intervalo_hr, hito.intervalo) &&
      ha != null &&
      ha > hito.a_las - hito.intervalo
    );
  });
}

/**
 * EL HITO PENDIENTE (invariante 108, pedido del cliente 27-oct-2026): «la app
 * marca cuánto falta para el siguiente servicio, pero cuando no se pudo
 * hacer en tiempo y forma se brinca al siguiente; que tenga un contador
 * negativo hasta que se marque de concluido el servicio».
 *
 * Mientras exista una orden ABIERTA (PROGRAMADO / EN_TALLER) del avión cuyo
 * hito (`horas_programadas`) ya se alcanzó (`≤ horas + 0.05`), el «próximo
 * servicio» ES ese hito: `faltan` sale NEGATIVO y el programa cíclico no
 * avanza hasta que la orden se marque COMPLETADO (o hasta que otro registro
 * HECHO lo atienda, ver `hitoAtendido`). Con varias, manda la de horas más
 * bajas (a igualdad, `id` menor): lo más atrasado primero.
 *
 * Qué NO sostiene el programa (se ignora): órdenes de componente
 * (motor/hélice), órdenes sin `horas_programadas` (no tienen hito), y
 * órdenes con horas que NO son un hito del programa y sin etapa del
 * programa (un «cambio de llanta a las 2,230 h» no es un servicio por
 * horas). Sin programa (`intervalos` vacío) ⇒ `null`.
 *
 * Sin orden abierta alcanzada NO se inventa un vencido: un avión con
 * historial sin capturar (XB-ANU: base 1,253.9 y ningún mantenimiento) sigue
 * apuntando al siguiente hito del programa, como siempre.
 */
export function hitoPendienteDeOrden(args: {
  mantenimientos: readonly MantenimientoHitoRow[];
  intervalos: readonly unknown[];
  base: unknown;
  horas: number;
}): HitoPendiente | null {
  const ints = intervalosDelPrograma(args.intervalos);
  if (ints.length === 0 || !Number.isFinite(args.horas)) return null;
  const r1 = (n: number) => Number(n.toFixed(1));
  let mejor: HitoPendiente | null = null;
  for (const m of args.mantenimientos) {
    if (!esServicioDelAvion(m) || !ordenEstaAbierta(m)) continue;
    const aLas = num(m.horas_programadas);
    if (aLas == null || aLas > args.horas + TOLERANCIA_HITO_HR) continue;
    const incluidas = intervalosEnHito(ints, args.base, aLas);
    let intervalo: number | null =
      incluidas.length > 0 ? incluidas[incluidas.length - 1] : null;
    if (intervalo == null) {
      const etapa = num(m.etapa_intervalo_hr);
      intervalo =
        etapa != null && ints.some((i) => cerca(i, etapa)) ? etapa : null;
    }
    if (intervalo == null) continue;
    const hito: HitoServicio = { a_las: r1(aLas), intervalo };
    if (hitoAtendido(args.mantenimientos, hito)) continue;
    const gana =
      mejor == null ||
      hito.a_las < mejor.a_las - TOLERANCIA_HITO_HR ||
      (Math.abs(hito.a_las - mejor.a_las) <= TOLERANCIA_HITO_HR &&
        m.id.localeCompare(mejor.orden.id) < 0);
    if (gana) {
      mejor = {
        ...hito,
        etapas_incluidas: incluidas.length > 0 ? incluidas : [intervalo],
        orden: m,
      };
    }
  }
  return mejor;
}
