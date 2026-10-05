import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  diaCancun,
  diasEntreDiasCancun,
  fechaCortaCancun,
  moverDiasHoraParedCancun,
} from '../../common/fecha-cancun.util';

/**
 * ALINEAR LA FECHA DE LOS TRAMOS CON LA DE LA COTIZACIÓN (5-oct-2026, API
 * 0.0.55). `POST /v1/quotes/:id/revise` escribe `vuelo.fecha_vuelo` pero NO
 * mueve los tramos (`escala.fecha_salida_plan`, con hora): la cotización
 * dice el día nuevo y la operación (app del piloto, calendario) sigue en el
 * viejo. El panel pregunta en un modal y, si la oficina dice «Sí», llama a
 * `POST /v1/flights/:id/tramos/alinear-fecha`. Aquí vive la parte PURA:
 * qué se mueve, cuántos días, y los textos (es-MX) de errores y avisos.
 */

export const CODE_VUELO_YA_VOLO = 'VUELO_YA_VOLO';
export const CODE_VUELO_CANCELADO = 'VUELO_CANCELADO';
export const CODE_SIN_FECHA = 'SIN_FECHA';
export const CODE_TRAMOS_NO_MOVIDOS = 'TRAMOS_NO_MOVIDOS';
export const CODE_OPERACION_CAMBIO = 'OPERACION_CAMBIO';

export const MENSAJE_VUELO_YA_VOLO =
  'La operación ya empezó: la fecha de cada tramo se edita desde el vuelo.';
export const MENSAJE_VUELO_CANCELADO =
  'El vuelo está cancelado: no hay operación que mover.';
export const MENSAJE_SIN_FECHA =
  'El vuelo no tiene fecha: captúrala en la cotización o en el detalle del vuelo antes de mover los tramos.';
/**
 * 409 cuando el tramo ANCLA (la referencia del delta) cambió entre la lectura
 * y la escritura: el delta se calculó sobre una fecha que ya no existe, así
 * que no se mueve NADA (revisión 5-oct-2026).
 */
export const MENSAJE_OPERACION_CAMBIO =
  'El vuelo operativo cambió mientras guardabas y no se movió nada. Recarga y vuelve a intentarlo, o mueve la fecha desde el detalle del vuelo.';

/**
 * `fecha_vuelo` del cuerpo: instante COMPLETO con hora y zona (Z u offset).
 * `@IsDateString` solo acepta también «2026-10-13» (que `new Date` lee como
 * medianoche UTC = el día ANTERIOR en Cancún) y «2026-10-13T02:00» (que
 * depende de la zona del servidor). Fuente única del DTO y de su spec.
 */
export const RE_INSTANTE_ISO_CON_ZONA =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)$/i;
export const MENSAJE_FECHA_VUELO_SIN_ZONA =
  'fecha_vuelo debe ser un instante ISO 8601 con hora y zona (Z u offset), p. ej. 2026-10-13T14:00:00.000Z.';

/**
 * Texto del 503 cuando la base de datos falla A MEDIO CAMINO. `revertido` =
 * los tramos ya movidos se regresaron a su fecha anterior (no cambió nada).
 */
export function mensajeTramosNoMovidos(revertido: boolean): string {
  return revertido
    ? 'No se pudo mover el vuelo operativo (falló el guardado a medio camino) y no se cambió nada. Intenta de nuevo o mueve la fecha desde el detalle del vuelo.'
    : 'No se pudo mover todo el vuelo operativo: algunos tramos quedaron con la fecha nueva y otros no. Revisa las fechas de los tramos en el detalle del vuelo.';
}

export function errorVueloYaVolo(
  vueloId: string,
  folio: unknown,
): ConflictException {
  return new ConflictException({
    message: MENSAJE_VUELO_YA_VOLO,
    error: CODE_VUELO_YA_VOLO,
    details: { vuelo_id: vueloId, folio: folio ?? null },
  });
}

export function errorVueloCancelado(
  vueloId: string,
  folio: unknown,
): ConflictException {
  return new ConflictException({
    message: MENSAJE_VUELO_CANCELADO,
    error: CODE_VUELO_CANCELADO,
    details: { vuelo_id: vueloId, folio: folio ?? null },
  });
}

export function errorSinFecha(vueloId: string): BadRequestException {
  return new BadRequestException({
    message: MENSAJE_SIN_FECHA,
    error: CODE_SIN_FECHA,
    details: { vuelo_id: vueloId },
  });
}

export function errorOperacionCambio(
  vueloId: string,
  folio: unknown,
): ConflictException {
  return new ConflictException({
    message: MENSAJE_OPERACION_CAMBIO,
    error: CODE_OPERACION_CAMBIO,
    details: { vuelo_id: vueloId, folio: folio ?? null },
  });
}

export function errorTramosNoMovidos(
  vueloId: string,
  revertido: boolean,
  tecnico: string,
): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: mensajeTramosNoMovidos(revertido),
    error: CODE_TRAMOS_NO_MOVIDOS,
    details: { vuelo_id: vueloId, revertido, tecnico },
  });
}

/**
 * Aviso de REAGENDA de «Editar datos» del vuelo (`flights.update`).
 * `salida` / `regreso` llegan YA formateados en hora Cancún
 * (`fechaCancunTxt` del service); el que falte no se nombra.
 * NO es fuente única todavía: `revise` (`quotes.service`) arma la MISMA
 * plantilla con su propia copia (el contrato del 5-oct-2026 prohibió tocar
 * revise) — pendiente migrarla aquí la próxima vez que se toque revise. La
 * alineación de tramos tampoco la usa: manda `avisoOperacionMovida`.
 */
export function avisoReagendaVuelo(p: {
  folio: number | string | null | undefined;
  origen: string | null | undefined;
  destino: string | null | undefined;
  salida?: string | null;
  regreso?: string | null;
}): { titulo: string; cuerpo: string } {
  const partes: string[] = [];
  if (p.salida) partes.push(`ahora sale ${p.salida}`);
  if (p.regreso) partes.push(`el REGRESO ahora sale ${p.regreso}`);
  return {
    titulo: `Vuelo #${String(p.folio ?? '')} reagendado`,
    cuerpo: `${p.origen ?? ''} → ${p.destino ?? ''} ${partes.join(' y ')} (hora Cancún).`,
  };
}

/** Cuántos tramos nombra el aviso de la alineación antes de resumir. */
export const MAX_TRAMOS_EN_AVISO = 4;

/**
 * Aviso a la tripulación cuando la oficina mueve el vuelo OPERATIVO a la
 * fecha de la cotización. DISTINTO a propósito del de `revise` («Vuelo #N
 * reagendado · … ahora sale <fecha de la cotización>»), que sale segundos
 * antes por el mismo cambio: este nombra cada tramo MOVIDO con la hora que
 * conservó, así el piloto no recibe dos «ahora sale» con horas distintas
 * (revisión 5-oct-2026). Fechas con `fechaCortaCancun` («jue 15 oct 09:00»).
 * Más de `MAX_TRAMOS_EN_AVISO` tramos ⇒ los primeros 3 y «y N más».
 */
export function avisoOperacionMovida(p: {
  folio: number | string | null | undefined;
  tramos: ReadonlyArray<{
    origen_iata: string | null;
    destino_iata: string | null;
    fecha_salida_plan: string | null;
  }>;
}): { titulo: string; cuerpo: string } {
  const lineas = p.tramos.map((t) => {
    const cuando = fechaCortaCancun(t.fecha_salida_plan, { hora: true });
    return `${t.origen_iata ?? '?'} → ${t.destino_iata ?? '?'} ${cuando || 'sin fecha'}`;
  });
  const visibles =
    lineas.length > MAX_TRAMOS_EN_AVISO
      ? lineas.slice(0, MAX_TRAMOS_EN_AVISO - 1)
      : lineas;
  const resto = lineas.length - visibles.length;
  const lista = `${visibles.join(' · ')}${resto > 0 ? ` · y ${resto} más` : ''}`;
  return {
    titulo: `Vuelo #${String(p.folio ?? '')}: la operación cambió de día`,
    cuerpo: `Tramos movidos (hora Cancún): ${lista}.`,
  };
}

export interface TramoAlinearInput {
  id: string;
  orden: number | string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  fecha_salida_plan: string | null;
  cancelada_at?: unknown;
}

/**
 * Por qué un tramo CON fecha NO se recorre aunque haya delta (revisión
 * 5-oct-2026). Los dos casos son tramos que YA dicen lo que dice la
 * cotización — `revise` los llenó o los espejó con la fecha nueva:
 * - `ya_en_la_fecha`: el primer tramo está EXACTAMENTE en el instante
 *   objetivo y otro tramo posterior tiene un día anterior (revise llenó el
 *   tramo 1 vacío con la salida nueva). No es referencia ni se mueve.
 * - `dia_del_regreso`: está en el día del REGRESO de la cotización y ese
 *   regreso no se mueve (lo escribió la oficina y sigue siendo coherente).
 */
export type MotivoConservaTramo = 'ya_en_la_fecha' | 'dia_del_regreso';

export interface TramoAlineado {
  id: string;
  orden: number | null;
  origen_iata: string | null;
  destino_iata: string | null;
  fecha_salida_plan_antes: string | null;
  /** Fecha PROPUESTA (igual a la anterior si el tramo no se mueve). */
  fecha_salida_plan: string | null;
  /** ADITIVO: por qué no se recorre (null = se recorre o no tiene fecha). */
  se_conserva: MotivoConservaTramo | null;
}

export interface PlanAlinearFecha {
  /** Instante objetivo (ISO UTC): `dto.fecha_vuelo ?? vuelo.fecha_vuelo`. */
  fecha_objetivo: string;
  /** Su día en Cancún (YYYY-MM-DD). */
  dia_objetivo: string;
  /** Día Cancún del tramo de REFERENCIA (null = ningún tramo tiene fecha). */
  dia_referencia: string | null;
  /** objetivo − referencia; null sin referencia; 0 = ya está alineado. */
  delta_dias: number | null;
  /**
   * Tramo ANCLA: la referencia del delta o, sin referencia, el tramo que
   * recibe el objetivo. Se escribe PRIMERO: si su CAS falla, el delta se
   * calculó sobre una fecha que ya no existe y no se mueve NADA (409).
   */
  ancla_id: string | null;
  /** Tramos VIVOS por `orden`, con la fecha anterior y la propuesta. */
  tramos: TramoAlineado[];
  /** Ids de los tramos a escribir (en el orden de `tramos`). */
  mover: string[];
  fecha_traslado_final_antes: string | null;
  /** Regreso propuesto (igual al anterior si no se mueve). */
  fecha_traslado_final: string | null;
  mover_traslado_final: boolean;
}

const ordenDe = (v: unknown, respaldo: number): number => {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : respaldo;
};

/**
 * QUÉ SE MUEVE — puro. Contrato del 5-oct-2026 + revisión del mismo día
 * (el «Sí» mueve el vuelo OPERATIVO, jamás reescribe lo que la oficina
 * acaba de guardar en la cotización). Reglas:
 * - Solo tramos VIVOS (`cancelada_at` nulo), ordenados por `orden`.
 * - REFERENCIA = primer tramo vivo con `fecha_salida_plan`, SALVO que esté
 *   exactamente en el instante objetivo y algún tramo posterior tenga un
 *   día anterior: entonces `revise` lo llenó con la salida nueva (estaba
 *   vacío), ya dice lo que dice la cotización (`ya_en_la_fecha`) y la
 *   referencia es el siguiente tramo con fecha. `delta_dias = día objetivo −
 *   día de la referencia`.
 * - `delta = 0` ⇒ no se mueve nada (idempotente: un segundo «Sí» o un
 *   reintento no vuelve a sumar días).
 * - El REGRESO (`fecha_traslado_final`) es de la COTIZACIÓN (la oficina lo
 *   escribe en «Fecha traslado final»): se RESPETA mientras sea coherente
 *   (su día ≥ el día objetivo). Se recorre `delta` días SOLO si
 *   (a) quedó ANTES de la salida nueva (`delta > 0`), o
 *   (b) el vuelo operativo era de UN DÍA — todos los tramos con fecha y el
 *   regreso en el día de la referencia —: un viaje de un día se mueve
 *   completo, con su regreso (en prod, 71 de los 79 vuelos con regreso de
 *   los últimos 120 días lo tienen el mismo día de la salida).
 * - Si el regreso NO se mueve y es coherente, los tramos (salvo la
 *   referencia) que YA están en el día del regreso se quedan
 *   (`dia_del_regreso`): `revise` llenó el tramo final vacío con el regreso
 *   nuevo o la operación ya coincide con él. Moverlos mandaría la operación
 *   (y antes, también la cotización) a días que nadie escribió.
 * - Todo otro tramo con fecha se recorre `delta` días CONSERVANDO SU HORA
 *   DE PARED en Cancún; los tramos sin fecha se quedan sin fecha.
 * - Sin referencia (ningún tramo con fecha) el PRIMER tramo vivo recibe el
 *   instante objetivo tal cual (lo que hace `mirrorVueloToIdaEscala`) y los
 *   demás quedan; `delta_dias = null`.
 * Con `fechaObjetivo` como texto, debe ser un instante con zona (el DTO lo
 * exige con `RE_INSTANTE_ISO_CON_ZONA`; `vuelo.fecha_vuelo` de PostgREST ya
 * lo es).
 */
export function planAlinearFecha(p: {
  fechaObjetivo: string | Date;
  tramos: TramoAlinearInput[] | null | undefined;
  fechaTrasladoFinal?: string | null;
}): PlanAlinearFecha {
  const objetivo =
    p.fechaObjetivo instanceof Date
      ? p.fechaObjetivo
      : new Date(p.fechaObjetivo);
  if (Number.isNaN(objetivo.getTime())) {
    throw new Error(`Fecha inválida: ${String(p.fechaObjetivo)}`);
  }
  const fechaObjetivo = objetivo.toISOString();
  const diaObjetivo = diaCancun(fechaObjetivo);
  const vivos = (p.tramos ?? [])
    .filter((t) => t.cancelada_at == null)
    .map((t, i) => ({ t, k: ordenDe(t.orden, i) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);
  const conFecha = vivos.filter((t) => !!t.fecha_salida_plan);
  const diaDe = (t: TramoAlinearInput): string =>
    diaCancun(t.fecha_salida_plan as string);

  // Tramo 1 llenado por revise con la salida NUEVA (estaba vacío).
  let yaEnFecha: TramoAlinearInput | null = null;
  if (
    conFecha.length >= 2 &&
    Date.parse(conFecha[0].fecha_salida_plan as string) === objetivo.getTime()
  ) {
    const dia0 = diaDe(conFecha[0]);
    if (conFecha.slice(1).some((t) => diaDe(t) < dia0)) {
      yaEnFecha = conFecha[0];
    }
  }
  const recorribles = conFecha.filter((t) => t !== yaEnFecha);
  const referencia = recorribles[0] ?? null;
  const diaReferencia = referencia ? diaDe(referencia) : null;
  const delta =
    diaReferencia == null
      ? null
      : diasEntreDiasCancun(diaReferencia, diaObjetivo);

  const regresoAntes = p.fechaTrasladoFinal ?? null;
  const diaRegreso = regresoAntes ? diaCancun(regresoAntes) : null;
  const viajeDeUnDia =
    diaRegreso != null &&
    diaRegreso === diaReferencia &&
    recorribles.every((t) => diaDe(t) === diaReferencia);
  const moverRegreso =
    delta != null &&
    delta !== 0 &&
    diaRegreso != null &&
    ((delta > 0 && diaRegreso < diaObjetivo) || viajeDeUnDia);
  // El regreso de la cotización MANDA: no se mueve y sigue siendo coherente.
  const regresoManda =
    diaRegreso != null && !moverRegreso && diaRegreso >= diaObjetivo;

  const mover: string[] = [];
  const tramos: TramoAlineado[] = vivos.map((t, i) => {
    const antes = t.fecha_salida_plan ?? null;
    let nueva = antes;
    let seConserva: MotivoConservaTramo | null = null;
    if (delta == null) {
      // Sin referencia: solo el primer tramo vivo recibe el objetivo.
      if (i === 0) nueva = fechaObjetivo;
    } else if (delta !== 0 && antes) {
      if (t === yaEnFecha) {
        seConserva = 'ya_en_la_fecha';
      } else if (
        t !== referencia &&
        regresoManda &&
        diaCancun(antes) === diaRegreso
      ) {
        seConserva = 'dia_del_regreso';
      } else {
        nueva = moverDiasHoraParedCancun(antes, delta);
      }
    }
    if (nueva !== antes) mover.push(t.id);
    const orden = Number(t.orden);
    return {
      id: t.id,
      orden: t.orden != null && Number.isFinite(orden) ? orden : null,
      origen_iata: t.origen_iata ?? null,
      destino_iata: t.destino_iata ?? null,
      fecha_salida_plan_antes: antes,
      fecha_salida_plan: nueva,
      se_conserva: seConserva,
    };
  });

  return {
    fecha_objetivo: fechaObjetivo,
    dia_objetivo: diaObjetivo,
    dia_referencia: diaReferencia,
    delta_dias: delta,
    ancla_id: delta == null ? (vivos[0]?.id ?? null) : (referencia?.id ?? null),
    tramos,
    mover,
    fecha_traslado_final_antes: regresoAntes,
    fecha_traslado_final:
      moverRegreso && regresoAntes != null && delta != null
        ? moverDiasHoraParedCancun(regresoAntes, delta)
        : regresoAntes,
    mover_traslado_final: moverRegreso,
  };
}

/** Tramo de la respuesta: la fecha con la que QUEDÓ (+ `movido`, aditivo). */
export interface TramoAlineadoRespuesta extends TramoAlineado {
  /** true = este tramo se escribió en esta llamada. */
  movido: boolean;
}

/** Respuesta de `POST /v1/flights/:id/tramos/alinear-fecha`. */
export interface RespuestaAlinearFecha {
  vuelo_id: string;
  folio: number | null;
  /** null = ningún tramo tenía fecha (el primero recibió la del vuelo). */
  delta_dias: number | null;
  fecha_objetivo: string;
  tramos: TramoAlineadoRespuesta[];
  fecha_traslado_final: string | null;
  tramos_movidos: number;
  /** ADITIVOS: el regreso antes de la llamada y si se movió. */
  fecha_traslado_final_antes: string | null;
  fecha_traslado_final_movida: boolean;
}

/**
 * Arma la respuesta con lo que REALMENTE se escribió: un tramo que cambió
 * entre la lectura y la escritura (CAS) conserva su fecha anterior y no
 * cuenta en `tramos_movidos`.
 */
export function respuestaAlinearFecha(p: {
  vueloId: string;
  folio: unknown;
  plan: PlanAlinearFecha;
  movidos: ReadonlySet<string>;
  regresoMovido: boolean;
}): RespuestaAlinearFecha {
  const folio = Number(p.folio);
  const tramos = p.plan.tramos.map((t) => {
    const movido = p.movidos.has(t.id);
    return {
      ...t,
      fecha_salida_plan: movido
        ? t.fecha_salida_plan
        : t.fecha_salida_plan_antes,
      movido,
    };
  });
  return {
    vuelo_id: p.vueloId,
    folio: p.folio != null && Number.isFinite(folio) ? folio : null,
    delta_dias: p.plan.delta_dias,
    fecha_objetivo: p.plan.fecha_objetivo,
    tramos,
    fecha_traslado_final: p.regresoMovido
      ? p.plan.fecha_traslado_final
      : p.plan.fecha_traslado_final_antes,
    tramos_movidos: tramos.filter((t) => t.movido).length,
    fecha_traslado_final_antes: p.plan.fecha_traslado_final_antes,
    fecha_traslado_final_movida: p.regresoMovido,
  };
}
