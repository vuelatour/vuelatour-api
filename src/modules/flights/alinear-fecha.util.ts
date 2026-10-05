import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  diaCancun,
  diasEntreDiasCancun,
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

export const MENSAJE_VUELO_YA_VOLO =
  'La operación ya empezó: la fecha de cada tramo se edita desde el vuelo.';
export const MENSAJE_VUELO_CANCELADO =
  'El vuelo está cancelado: no hay operación que mover.';
export const MENSAJE_SIN_FECHA =
  'El vuelo no tiene fecha: captúrala en la cotización o en el detalle del vuelo antes de mover los tramos.';

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
 * Aviso de REAGENDA a la tripulación — fuente única del texto que ya
 * mandaba «Editar datos» del vuelo (`flights.update`) y que ahora manda
 * también la alineación de tramos. `salida` / `regreso` llegan YA formateados
 * en hora Cancún (`fechaCancunTxt` del service); el que falte no se nombra.
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

export interface TramoAlinearInput {
  id: string;
  orden: number | string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  fecha_salida_plan: string | null;
  cancelada_at?: unknown;
}

export interface TramoAlineado {
  id: string;
  orden: number | null;
  origen_iata: string | null;
  destino_iata: string | null;
  fecha_salida_plan_antes: string | null;
  /** Fecha PROPUESTA (igual a la anterior si el tramo no se mueve). */
  fecha_salida_plan: string | null;
}

export interface PlanAlinearFecha {
  /** Instante objetivo (ISO UTC): `dto.fecha_vuelo ?? vuelo.fecha_vuelo`. */
  fecha_objetivo: string;
  /** Su día en Cancún (YYYY-MM-DD). */
  dia_objetivo: string;
  /** Día Cancún del PRIMER tramo vivo con fecha (null = ninguno la tiene). */
  dia_referencia: string | null;
  /** objetivo − referencia; null sin referencia; 0 = ya está alineado. */
  delta_dias: number | null;
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
 * QUÉ SE MUEVE — puro. Reglas (contrato del 5-oct-2026):
 * - Solo tramos VIVOS (`cancelada_at` nulo), ordenados por `orden`.
 * - Referencia = día Cancún del PRIMER tramo vivo con `fecha_salida_plan`.
 *   `delta_dias = día objetivo − referencia`.
 * - `delta = 0` ⇒ no se mueve nada (idempotente: un segundo «Sí» o un
 *   reintento no vuelve a sumar días).
 * - Cada tramo vivo CON fecha se mueve `delta` días conservando su HORA DE
 *   PARED en Cancún; los tramos sin fecha se quedan sin fecha (heredan el
 *   día del anterior, como siempre).
 * - Sin referencia (ningún tramo con fecha) el PRIMER tramo vivo recibe el
 *   instante objetivo tal cual (lo que hace `mirrorVueloToIdaEscala`) y los
 *   demás quedan; `delta_dias = null`.
 * - `fecha_traslado_final` se mueve `delta` días SOLO si estaba alineada con
 *   la operación (mismo día Cancún que el ÚLTIMO tramo vivo con fecha, antes
 *   de mover). Si `revise` ya la cambió en la cotización (la oficina movió
 *   salida Y regreso), ya dice el día que pidió el cliente: moverla otra vez
 *   la desplazaría DOS veces.
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
  const referencia = conFecha[0] ?? null;
  const ultimo = conFecha.length > 0 ? conFecha[conFecha.length - 1] : null;
  const diaReferencia = referencia
    ? diaCancun(referencia.fecha_salida_plan as string)
    : null;
  const delta =
    diaReferencia == null
      ? null
      : diasEntreDiasCancun(diaReferencia, diaObjetivo);

  const mover: string[] = [];
  const tramos: TramoAlineado[] = vivos.map((t, i) => {
    const antes = t.fecha_salida_plan ?? null;
    let nueva = antes;
    if (delta == null) {
      // Sin referencia: solo el primer tramo vivo recibe el objetivo.
      if (i === 0) nueva = fechaObjetivo;
    } else if (delta !== 0 && antes) {
      nueva = moverDiasHoraParedCancun(antes, delta);
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
    };
  });

  const regresoAntes = p.fechaTrasladoFinal ?? null;
  const moverRegreso =
    delta != null &&
    delta !== 0 &&
    regresoAntes != null &&
    ultimo != null &&
    diaCancun(regresoAntes) === diaCancun(ultimo.fecha_salida_plan as string);
  return {
    fecha_objetivo: fechaObjetivo,
    dia_objetivo: diaObjetivo,
    dia_referencia: diaReferencia,
    delta_dias: delta,
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
