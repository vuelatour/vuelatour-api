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
 * Desde el 18-nov-2026 también vive aquí el HITO ANCLADO (`hitoAnclado`,
 * invariante 138): el programa NO avanza solo. El «próximo servicio» es el
 * primer hito del programa después del ÚLTIMO que un servicio HECHO dejó
 * atendido, exista o no su orden — y se queda ahí, con contador negativo,
 * hasta que alguien lo haga. Antes solo una orden abierta sostenía el hito, y
 * la orden no nacía cuando el servicio del ciclo ANTERIOR se había hecho
 * tarde (N4142R: el de 4,400 hecho a 4,406 «cubría» el de 4,500).
 *
 * Todo aquí es PURO (sin BD, sin fechas del sistema): se prueba con specs.
 */

/**
 * Tolerancia al comparar horas contra un hito. El hobbs y los hitos viajan a
 * 1 decimal; 0.05 es media décima (el criterio histórico del check).
 */
export const TOLERANCIA_HITO_HR = 0.05;

/**
 * VENTANA DE ANTICIPO (18-nov-2026, invariante 138): un servicio hecho hasta
 * 10 h ANTES de un hito cuenta para ESE hito. Es el mismo margen con el que
 * el programa automático crea la orden (`alerta_config.servicio_horas`, 10 h
 * por omisión): el mecánico mete el avión unas horas antes y ese servicio es
 * el del hito que viene. Más lejos que eso ya no es «un poco antes»: es el
 * servicio del hito ANTERIOR hecho tarde, y el que viene sigue pendiente.
 *
 * La usan TRES reglas que tienen que coincidir (por eso es una constante):
 * `posicionAtendida` (hasta dónde deja atendido el programa un servicio sin
 * horas programadas), la regla 2 de `mantenimientoCubreHito` (dedupe) y la
 * regla (b) de `hitoAtendido`. Si el dedupe usara una ventana más ancha que
 * la posición, daría por «cubierto» un hito que la ficha muestra pendiente y
 * su orden no se crearía nunca.
 */
export const VENTANA_ANTICIPO_HR = 10;

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

/** Horas a 1 decimal (como viajan el hobbs y los hitos). */
function r1(n: number): number {
  return Number(n.toFixed(1));
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
 * 2. Servicio de la MISMA etapa ya HECHO, capturado SIN horas programadas,
 *    que entró dentro de la ventana de anticipo del hito (horas ∈
 *    [hito − 10 − 0.05, hito + 0.05], `VENTANA_ANTICIPO_HR`): el hito está
 *    cubierto aunque el hobbs no lo rebase todavía — no re-crear lo que el
 *    mecánico acaba de terminar (verificación 26-ago-2026).
 *    Una fila CON horas programadas pertenece a ESE número y solo cubre por
 *    la regla 1. Hasta el 17-nov-2026 la ventana era el ciclo ENTERO
 *    ((hito − intervalo, hito + 0.05]) y no miraba las horas programadas: el
 *    servicio de 4,400 h del N4142R, hecho TARDE a 4,406 h, «cubría» el hito
 *    de 4,500 ⇒ su orden no se creó nunca y, al pasar las 4,500, el programa
 *    brincó a 4,550 (invariante 138).
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
      num(m.horas_programadas) == null &&
      cerca(m.etapa_intervalo_hr, hito.intervalo) &&
      ha != null &&
      ha >= hito.a_las - VENTANA_ANTICIPO_HR - TOLERANCIA_HITO_HR &&
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
 *  b) Un servicio de la MISMA etapa que es de ESTE hito o de uno POSTERIOR:
 *     - CON horas programadas: `horas_programadas ≥ hito − 0.05` (la fila
 *       declara su número: un servicio posterior de la misma etapa ya
 *       hecho deja atrás a este);
 *     - SIN horas programadas: `horas_aeronave ≥ hito − 10 − 0.05`
 *       (`VENTANA_ANTICIPO_HR`): entró un poco antes del hito, en el hito o
 *       DESPUÉS (un servicio tardío también atiende).
 *     Misma etapa a propósito —no «una mayor incluye a la menor»—: el dedupe
 *     tampoco lo asume, y si aquí lo asumiéramos la ficha daría por atendido
 *     un hito para el que el programa SÍ crea orden. Sin etapa capturada no
 *     se puede atribuir ⇒ no cuenta.
 *     Hasta el 17-nov-2026 bastaba `horas_aeronave > hito − intervalo`, sin
 *     mirar las horas programadas: el servicio del ciclo ANTERIOR hecho tarde
 *     (N4142R: programado a 4,400, hecho a 4,406) daba por atendido el hito
 *     de 4,500 (invariante 138).
 */
export function hitoAtendido(
  hechos: readonly MantenimientoHitoRow[],
  hito: HitoServicio,
): boolean {
  return hechos.some((h) => {
    if (!servicioHecho(h) || !esServicioDelAvion(h)) return false;
    if (cerca(h.horas_programadas, hito.a_las)) return true;
    if (!cerca(h.etapa_intervalo_hr, hito.intervalo)) return false;
    const hp = num(h.horas_programadas);
    if (hp != null) return hp >= hito.a_las - TOLERANCIA_HITO_HR;
    const ha = num(h.horas_aeronave);
    return (
      ha != null && ha >= hito.a_las - VENTANA_ANTICIPO_HR - TOLERANCIA_HITO_HR
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
 * Sin orden abierta alcanzada ESTA función no sostiene nada (`null`). Desde
 * el 18-nov-2026 el hito tampoco brinca sin orden: de eso se encarga
 * `hitoAnclado` (invariante 138), y `proximoServicioDetallado` se queda con
 * el más BAJO de los dos. Un avión sin NINGÚN servicio hecho del programa
 * (XB-ANU: base 1,253.9 y ningún mantenimiento) sigue apuntando al siguiente
 * hito del programa cíclico, como siempre: no se inventa un vencido.
 */
export function hitoPendienteDeOrden(args: {
  mantenimientos: readonly MantenimientoHitoRow[];
  intervalos: readonly unknown[];
  base: unknown;
  horas: number;
}): HitoPendiente | null {
  const ints = intervalosDelPrograma(args.intervalos);
  if (ints.length === 0 || !Number.isFinite(args.horas)) return null;
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

// ───────── Hito ANCLADO: el programa no avanza solo (18-nov-2026, inv. 138) ─────────

/** Un hito del programa con las etapas que caen en él. */
export interface HitoDelPrograma extends HitoServicio {
  /** Intervalos del programa cuyo ciclo cae en el hito (ascendente). El
   *  `intervalo` del hito es el MAYOR: el servicio grande incluye a los
   *  chicos (misma regla que `AircraftService.proximoServicio`). */
  etapas_incluidas: number[];
}

/**
 * El primer hito del programa cíclico (`base + k × intervalo`, k ≥ 1)
 * ESTRICTAMENTE después de `desde`. `null` sin programa.
 *
 * ROBUSTO AL PUNTO FLOTANTE cuando `desde` cae justo en un hito: con base
 * 329.6, `(1029.6 − 329.6) / 100` da 6.999999999999999 y un `floor` a secas
 * devolvería el MISMO hito de 1,029.6 en vez del siguiente. Por eso
 * `k = max(1, floor((desde − base + 0.05) / intervalo) + 1)`: todo lo que
 * esté a media décima del hito ES el hito, y el que sigue es el próximo.
 * `desde` por debajo de la base ⇒ el primer hito (`base + intervalo`).
 *
 * Empate entre intervalos ⇒ la etiqueta (`intervalo`) es el MAYOR y
 * `etapas_incluidas` los trae todos, de menor a mayor.
 */
export function siguienteHitoDespuesDe(
  intervalos: readonly unknown[],
  base: unknown,
  desde: number,
): HitoDelPrograma | null {
  const ints = intervalosDelPrograma(intervalos);
  if (ints.length === 0 || !Number.isFinite(desde)) return null;
  const b = num(base) ?? 0;
  let aLas: number | null = null;
  let incluidas: number[] = [];
  for (const int of ints) {
    const k = Math.max(
      1,
      Math.floor((desde - b + TOLERANCIA_HITO_HR) / int) + 1,
    );
    const hito = r1(b + k * int);
    if (aLas == null || hito < aLas - TOLERANCIA_HITO_HR) {
      aLas = hito;
      incluidas = [int];
    } else if (Math.abs(hito - aLas) <= TOLERANCIA_HITO_HR) {
      incluidas.push(int);
    }
  }
  if (aLas == null) return null;
  incluidas.sort((x, y) => x - y);
  return {
    a_las: aLas,
    intervalo: incluidas[incluidas.length - 1],
    etapas_incluidas: incluidas,
  };
}

/**
 * ¿HASTA QUÉ HORAS deja ATENDIDO el programa este servicio? `null` = no
 * cuenta para el programa (no está hecho, es de un componente, o no se puede
 * atribuir a ningún hito).
 *
 * CON `horas_programadas` la fila DECLARA su hito y la posición es ese
 * número, se haya hecho cuando se haya hecho (programado a 4,450 y hecho a
 * 4,455.1 ⇒ 4,450: el siguiente es 4,500, no 4,550). Cuenta si ese número es
 * un hito del programa (`intervalosEnHito`) O si la fila trae una etapa del
 * programa (la orden manual «50 hrs a las 2,212»). Con horas fuera del
 * programa y sin etapa —un «cambio de llanta a las 2,230», el «Servicio
 * 50,100» capturado a las 300 con base 329.6, o el servicio hecho EN la base
 * (1,500 con base 1,500)— no cuenta.
 *
 * SIN `horas_programadas` solo se puede atribuir por la etapa y el tacómetro
 * con el que entró (`horas_aeronave`):
 *  - si el siguiente hito del programa (en o después de ese tacómetro) está
 *    a ≤ 10 h (`VENTANA_ANTICIPO_HR`) y es de ESA etapa ⇒ se hizo un poco
 *    antes: la posición es ese hito;
 *  - si no ⇒ se hizo TARDE (o es de una etapa menor que la del hito): la
 *    posición es el tacómetro, y el primer hito después de él queda
 *    pendiente.
 * Sin etapa del programa (reparaciones, o un «50 Y 100 HRS» capturado como
 * texto libre) no cuenta: una reparación terminada después del hito no lo
 * atiende.
 */
export function posicionAtendida(
  m: MantenimientoHitoRow,
  intervalos: readonly unknown[],
  base: unknown,
): number | null {
  if (!servicioHecho(m) || !esServicioDelAvion(m)) return null;
  const ints = intervalosDelPrograma(intervalos);
  if (ints.length === 0) return null;
  const etapa = num(m.etapa_intervalo_hr);
  const etapaDelPrograma = etapa != null && ints.some((i) => cerca(i, etapa));
  const hp = num(m.horas_programadas);
  if (hp != null) {
    return etapaDelPrograma || intervalosEnHito(ints, base, hp).length > 0
      ? hp
      : null;
  }
  const ha = num(m.horas_aeronave);
  if (!etapaDelPrograma || ha == null) return null;
  // El primer hito EN o después del tacómetro (≥ ha − 0.05).
  const siguiente = siguienteHitoDespuesDe(
    ints,
    base,
    ha - 2 * TOLERANCIA_HITO_HR,
  );
  const unPocoAntes =
    siguiente != null &&
    siguiente.a_las - ha <= VENTANA_ANTICIPO_HR + TOLERANCIA_HITO_HR &&
    cerca(etapa, siguiente.intervalo);
  return unPocoAntes ? siguiente.a_las : ha;
}

/** Lo que necesitan `ultimoHitoAtendido` y `hitoAnclado`. */
export interface ArgsHitoAnclado {
  mantenimientos: readonly MantenimientoHitoRow[];
  intervalos: readonly unknown[];
  base: unknown;
  /** Tacómetro actual del avión. */
  horas: number;
}

/**
 * La posición MÁS ALTA que dejaron atendida los servicios HECHOS del
 * programa (`posicionAtendida`), o `null` si ninguno cuenta.
 *
 * GUARDA CONTRA ERRORES DE CAPTURA: se ignoran las posiciones por arriba de
 * `horas + (intervalo más chico del programa) + 0.05`. Un servicio hecho se
 * adelanta, a lo mucho, unas horas a su hito; un «hecho» de un hito a cientos
 * de horas en el futuro (dedazo, o una orden lejana cerrada por error) no
 * puede esconder los servicios que SÍ tocan.
 */
export function ultimoHitoAtendido(args: ArgsHitoAnclado): number | null {
  const ints = intervalosDelPrograma(args.intervalos);
  if (ints.length === 0 || !Number.isFinite(args.horas)) return null;
  const tope = args.horas + Math.min(...ints) + TOLERANCIA_HITO_HR;
  let ultimo: number | null = null;
  for (const m of args.mantenimientos) {
    const posicion = posicionAtendida(m, ints, args.base);
    if (posicion == null || posicion > tope) continue;
    if (ultimo == null || posicion > ultimo) ultimo = posicion;
  }
  return ultimo;
}

/**
 * EL HITO ANCLADO (invariante 138, reporte del cliente 17-nov-2026): «los
 * servicios, en vez de continuarse al siguiente de manera automática,
 * aparezcan "vencido por"… el N4142R ya se venció por como cinco horas y
 * aparece que faltan 45 horas… como que se brincó al siguiente servicio de
 * manera automática».
 *
 * El programa sigue siendo CÍCLICO (hitos `base + k × intervalo`), pero NO
 * avanza solo: el próximo servicio es el primer hito ESTRICTAMENTE después
 * del último que un servicio HECHO dejó atendido (`ultimoHitoAtendido`), y
 * ahí se queda —con `faltan` negativo si el tacómetro ya lo pasó— hasta que
 * otro servicio hecho lo atienda. No depende de que exista la orden: es
 * justo lo que permite CREARLA cuando el hito ya se venció.
 *
 * `null` = el avión no tiene NINGÚN servicio hecho del programa (XB-ANU:
 * cero mantenimientos): ahí sigue el programa cíclico desde el tacómetro,
 * como siempre — el historial sin capturar no se castiga con un vencido
 * inventado.
 */
export function hitoAnclado(args: ArgsHitoAnclado): HitoDelPrograma | null {
  const ultimo = ultimoHitoAtendido(args);
  if (ultimo == null) return null;
  return siguienteHitoDespuesDe(args.intervalos, args.base, ultimo);
}
