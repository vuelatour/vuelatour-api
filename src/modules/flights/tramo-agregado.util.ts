/**
 * TRAMO AGREGADO A UN VUELO YA CREADO — ¿es del CLIENTE o es OPERATIVO, y
 * qué `orden` le toca? (30-sep-2026, API 0.0.46, caso #364). FUENTE ÚNICA de
 * `POST /v1/flights/:id/operational-legs` (`createOperationalLeg`): la usan
 * la app («Editar vuelo» → paso `tramo_operativo`) y el panel («Agregar
 * tramo» de la asignación por tramo). PURO, con spec.
 *
 * Caso real: el #364 se dio de alta con CUN→CET y CET→PTU (ferry, 0 pax) y
 * Pablo agregó desde la app PTU→CUN con 4 pasajeros. Hasta el 0.0.45 este
 * endpoint insertaba SIEMPRE `solo_operativa: true` en `orden ≥ 100`, así que
 * el tramo del cliente quedó fuera de la cotización, del precio, del reparto
 * y de «adoptar operación», y la app lo pintó «Interno (no del cliente)» con
 * el número 100.
 *
 * Reglas:
 * 1. **Operativo** (`solo_operativa = true`, `orden ≥ 100`): FERRY, o parada
 *    de SERVICIO SIN pasajeros (posicionamiento a mantenimiento). Es la
 *    MISMA regla que el alta (`legsDeReserva`: `solo_operativa = es_ferry`)
 *    más el servicio vacío. Una parada de SERVICIO CON pasajeros es del
 *    cliente: en prod el #150 (CUN→CET, 5 pax, «ajustar el magneto»), el #84
 *    y el #57 son vuelos del cliente que dejan el avión en el taller y están
 *    cotizados — marcarlos operativos repetiría el bug del #364.
 * 2. **Comercial** (`solo_operativa = false`): todo lo demás. `orden` = el
 *    mayor `orden < 100` de los tramos NO cancelados + 1, saltando los
 *    números que ocupe un tramo cancelado (el índice único
 *    `escala_vuelo_id_orden_key` cubre TODAS las filas). Así queda en el
 *    rango 1..n que `quotes.replaceEscalas` maneja por UPSERT de `orden`:
 *    «adoptar operación» lo actualiza en su lugar, sin duplicarlo.
 * 3. **Freno de cronología (horas sagradas)**: la cadena de tacómetros
 *    (`propagarLlegadaASalidaSiguiente`, `fillTacoGaps`, rotaciones) camina
 *    por `orden`. Un tramo nuevo se AGREGA al final de la ruta; si ya hay un
 *    tramo NO cancelado en `orden ≥ 100` que va ANTES que él —ya voló o está
 *    volando (llegada, o salida que no es copia DEDUCIDA), o su fecha
 *    planeada es anterior a la del nuevo—, numerar el nuevo por debajo de
 *    100 lo pondría ANTES en la cadena: la salida se copiaría de la llegada
 *    equivocada y las horas del ferry se contarían dos veces. En ese caso el
 *    tramo queda OPERATIVO (orden ≥ 100, cronología intacta) y la respuesta
 *    lo dice en `aviso` (`AVISO_TRAMO_CLIENTE_OPERATIVO`). Sin fechas se
 *    asume lo que la lista ya pinta: los operativos ≥ 100 (el ferry de
 *    regreso) van al final.
 */

/** Rango de `orden` de los tramos OPERATIVOS agregados (los comerciales: 1..n). */
export const OPERATIVA_ORDEN_BASE = 100;

/** Columnas que `createOperationalLeg` lee para ubicar el tramo nuevo. */
export const ESCALAS_PARA_UBICAR_COLS =
  'orden, cancelada_at, taco_salida, taco_salida_origen, taco_llegada, fecha_salida_plan';

/** Aviso de un tramo agregado que quedó COMERCIAL (contrato del 0.0.46). */
export const AVISO_TRAMO_COMERCIAL =
  'Este tramo es del cliente: la cotización mostrará que la operación difiere y ofrecerá adoptarlo.';

/**
 * Aviso de un tramo del CLIENTE (no ferry) que quedó OPERATIVO por el freno
 * de cronología (regla 3): no entra a la cotización, y la oficina debe
 * saberlo. «Ajuste o extra» y no «agrégalo como tramo»: un tramo nuevo en la
 * cotización lo INSERTARÍA otra vez en la operación (replaceEscalas).
 */
export const AVISO_TRAMO_CLIENTE_OPERATIVO =
  'Este tramo es del cliente, pero va después de un tramo operativo (ferry o posicionamiento) del vuelo: quedó como operativo y no entra a la cotización. Si hay que cobrarlo, agrégalo como ajuste o extra en la cotización.';

/** Lo que importa del tramo que se agrega (subconjunto de `OperationalLegDto`). */
export interface TramoAgregadoInput {
  es_ferry?: boolean | null;
  tipo_parada?: string | null;
  pasajeros?: number | null;
  fecha_salida_plan?: Date | string | null;
}

/** Fila existente del vuelo (cualquier estado, canceladas incluidas). */
export interface EscalaParaUbicar {
  orden?: unknown;
  cancelada_at?: unknown;
  taco_salida?: unknown;
  taco_salida_origen?: unknown;
  taco_llegada?: unknown;
  fecha_salida_plan?: unknown;
}

export interface UbicacionTramo {
  orden: number;
  /** false ⇒ `solo_operativa = true`. */
  comercial: boolean;
  /** Texto para la oficina (null = nada que avisar). */
  aviso: string | null;
}

const ordenDe = (e: EscalaParaUbicar): number | null => {
  const n = Math.trunc(Number(e.orden));
  return Number.isFinite(n) && n >= 1 ? n : null;
};

const msDe = (v: unknown): number | null => {
  let t: number;
  if (v instanceof Date) t = v.getTime();
  else if (typeof v === 'string' && v !== '') t = new Date(v).getTime();
  else return null;
  return Number.isFinite(t) ? t : null;
};

const llevaPax = (pasajeros: unknown): boolean => Number(pasajeros) > 0;

/** Regla 1: ¿el tramo que se agrega es OPERATIVO (no del cliente)? */
export function esTramoOperativo(t: TramoAgregadoInput): boolean {
  if (t.es_ferry === true) return true;
  return t.tipo_parada === 'SERVICIO' && !llevaPax(t.pasajeros);
}

/** ¿El tramo ya voló o está volando? (una salida DEDUCIDA es solo una copia) */
function yaArranco(e: EscalaParaUbicar): boolean {
  if (e.taco_llegada != null) return true;
  return e.taco_salida != null && e.taco_salida_origen !== 'DEDUCIDO';
}

/**
 * Reglas 1–3: dónde va el tramo nuevo y si es del cliente. `existentes` son
 * TODAS las escalas del vuelo (canceladas incluidas: ocupan su `orden`).
 */
export function ubicarTramoAgregado(
  nuevo: TramoAgregadoInput,
  existentes: ReadonlyArray<EscalaParaUbicar>,
): UbicacionTramo {
  const ordenes = existentes.map(ordenDe).filter((n): n is number => n != null);
  const ocupados = new Set(ordenes);
  const maxOrden = ordenes.reduce((m, n) => Math.max(m, n), 0);
  const ordenOperativo = Math.max(maxOrden + 1, OPERATIVA_ORDEN_BASE);
  if (esTramoOperativo(nuevo)) {
    return { orden: ordenOperativo, comercial: false, aviso: null };
  }

  const activos = existentes.filter((e) => e.cancelada_at == null);
  const fechaNuevo = msDe(nuevo.fecha_salida_plan);
  const operativoAntes = activos.some((e) => {
    const o = ordenDe(e);
    if (o == null || o < OPERATIVA_ORDEN_BASE) return false;
    if (yaArranco(e)) return true;
    const f = msDe(e.fecha_salida_plan);
    return fechaNuevo != null && f != null && f < fechaNuevo;
  });

  let orden =
    activos
      .map(ordenDe)
      .filter((n): n is number => n != null && n < OPERATIVA_ORDEN_BASE)
      .reduce((m, n) => Math.max(m, n), 0) + 1;
  while (ocupados.has(orden)) orden++;

  // Con un operativo antes (o sin lugar en el rango comercial: 99 tramos):
  // operativo, y la oficina se entera de que el tramo del cliente no se
  // cotiza solo.
  if (operativoAntes || orden >= OPERATIVA_ORDEN_BASE) {
    return {
      orden: ordenOperativo,
      comercial: false,
      aviso: AVISO_TRAMO_CLIENTE_OPERATIVO,
    };
  }
  return { orden, comercial: true, aviso: AVISO_TRAMO_COMERCIAL };
}

/**
 * `comercial`/`aviso` de un tramo YA guardado (replay idempotente): se
 * derivan de la fila, así el reintento devuelve lo mismo que el alta.
 */
export function avisoDeTramoGuardado(fila: {
  solo_operativa?: unknown;
  es_ferry?: unknown;
  tipo_parada?: unknown;
  pasajeros?: unknown;
}): { comercial: boolean; aviso: string | null } {
  if (fila.solo_operativa !== true) {
    return { comercial: true, aviso: AVISO_TRAMO_COMERCIAL };
  }
  const operativoPorRegla = esTramoOperativo({
    es_ferry: fila.es_ferry === true,
    tipo_parada: (fila.tipo_parada as string | null | undefined) ?? null,
    pasajeros: fila.pasajeros == null ? null : Number(fila.pasajeros),
  });
  return {
    comercial: false,
    aviso: operativoPorRegla ? null : AVISO_TRAMO_CLIENTE_OPERATIVO,
  };
}
