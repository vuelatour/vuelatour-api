/**
 * QUITAR UNA ESCALA INTERMEDIA QUE NO SE HIZO (2-nov-2026, API 0.0.114,
 * invariante 113). FUENTE ÚNICA de `POST /v1/flights/legs/:legId/quitar-escala`
 * (`FlightsService.quitarEscala`): la usan el panel («Quitar escala» en la
 * asignación por tramo) y la app del piloto. PURO, con spec.
 *
 * Caso real (#496, Pablo, 29-oct-2026): la ruta era CUN→HOL→TQO→CUN pero el
 * avión fue directo a Tulum sin bajar en Holbox. El piloto capturó llegadas
 * en los dos primeros tramos (misma aguja: 1682.3) y el vuelo quedó
 * COMPLETADO con una escala que nunca ocurrió. Ni «Cancelar tramo» (exige
 * que el tramo NO haya volado: 409 ESCALA_CON_TACO) ni «Eliminar tramo»
 * (sin tacómetro) servían: el vuelo SÍ voló, solo que con una parada menos.
 *
 * Regla: el tramo A (`:legId`) y el tramo ACTIVO siguiente B, con
 * `A.destino = B.origen` (la escala que se quita), se FUSIONAN en UN tramo
 * `A.origen → B.destino` que conserva la fila de A:
 *  - de A queda todo lo del ORIGEN: salida (hora, taco y su origen, foto,
 *    observación), fecha planeada, piloto/copiloto/avión, orden, evento de
 *    Google, plan de vuelo;
 *  - de B viene todo lo del DESTINO: llegada (hora, taco y su origen, foto,
 *    observación), permiso de pista, pernocta, tipo de parada y notas de
 *    servicio;
 *  - la llegada que A tenía (a la escala que no se hizo) se DESCARTA y queda
 *    escrita en la bitácora del tramo y en las notas internas del vuelo;
 *  - pasajeros = el mayor de los dos y el manifiesto es la unión (si alguien
 *    «subía» en la escala, sigue en el vuelo); ferry solo si los dos lo eran;
 *  - CHECK `taco_llegada > taco_salida`: si la llegada de B no supera la
 *    salida de A, una de las dos lecturas está mal; la SALIDA se retira (en
 *    amarillo, como hace la propagación cuando el deducido «cede») y la
 *    llegada —la evidencia de que el vuelo llegó— se conserva;
 *  - el tramo fusionado queda EN AMARILLO (`revision_requerida`) con el
 *    motivo al frente: horas sagradas — oficina confirma el tacómetro.
 * B se borra (sus gastos y apoyos pasan a A; el servicio lo hace) y los
 * tramos comerciales posteriores se renumeran (`orden − 1`).
 *
 * NO se fusionan: tramos cancelados, operativos (ferry/parada técnica, orden
 * ≥ 100: cancelarlos o editarlos), de aviones distintos, ni cuando B no sale
 * de donde llega A (la ruta no es continua). El último tramo activo no tiene
 * escala que quitar (cambiar el destino con «Editar tramo»). La cotización
 * NO cambia (igual que «Agregar tramo»: la pantalla de la cotización señala
 * «la operación difiere» y ofrece adoptarla).
 */
import { fechaHoraCancun } from '../../common/fecha-cancun.util';
import { leerBitacora, motivoDirecto } from '../../common/taco-motivo.util';

/** Lo que la regla lee de cada tramo (filas de `escala`, tal cual llegan). */
export interface TramoFusionable {
  id: string;
  vuelo_id: string;
  orden: number | string;
  origen_iata: string;
  destino_iata: string;
  aeronave_id?: string | null;
  estado_permiso?: string | null;
  pasajeros?: number | string | null;
  pasajeros_nombres?: string[] | null;
  es_ferry?: boolean | null;
  requiere_pernocta?: boolean | null;
  pernocta_costo_usd?: number | string | null;
  tipo_parada?: string | null;
  servicio_notas?: string | null;
  solo_operativa?: boolean | null;
  taco_salida?: number | string | null;
  taco_llegada?: number | string | null;
  taco_salida_origen?: string | null;
  taco_llegada_origen?: string | null;
  foto_taco_salida_url?: string | null;
  foto_taco_llegada_url?: string | null;
  taco_salida_obs?: string | null;
  taco_llegada_obs?: string | null;
  taco_obs_updated_by?: string | null;
  taco_obs_updated_at?: string | null;
  valor_ia_propuesto?: number | string | null;
  revision_motivo?: string | null;
  hora_salida?: string | null;
  hora_llegada?: string | null;
  capturado_offline?: boolean | null;
  sincronizado_at?: string | null;
  capturado_por?: string | null;
  notas?: string | null;
  cancelada_at?: string | null;
  monto_externo_usd?: number | string | null;
  taco_omitido_at?: string | null;
  taco_omitido_por?: string | null;
  taco_omitido_motivo?: string | null;
}

export interface VueloParaFusion {
  estado?: string | null;
  aeronave_id?: string | null;
}

export type RechazoFusion = {
  code:
    | 'ESCALA_CANCELADA'
    | 'VUELO_CANCELADO'
    | 'ESCALA_FINAL'
    | 'ESCALA_NO_ENLAZA'
    | 'ESCALA_OPERATIVA'
    | 'ESCALAS_DISTINTO_AVION';
  message: string;
  details: Record<string, unknown>;
};

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function txt(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

/**
 * ¿Por qué NO se puede quitar la escala entre A y B? null = sí se puede.
 * `b` es el tramo ACTIVO siguiente por `orden` (null si A es el último).
 */
export function porQueNoSeQuitaEscala(
  a: TramoFusionable,
  b: TramoFusionable | null,
  vuelo: VueloParaFusion,
): RechazoFusion | null {
  if (a.cancelada_at) {
    return {
      code: 'ESCALA_CANCELADA',
      message:
        'El tramo está cancelado: no tiene escala que quitar (restáuralo primero si sí voló).',
      details: { escala_id: a.id, cancelada_at: a.cancelada_at },
    };
  }
  if (vuelo.estado === 'CANCELADO') {
    return {
      code: 'VUELO_CANCELADO',
      message: 'El vuelo está CANCELADO: restáuralo antes de corregir su ruta.',
      details: { escala_id: a.id, vuelo_id: a.vuelo_id },
    };
  }
  if (!b) {
    return {
      code: 'ESCALA_FINAL',
      message: `Es el último tramo activo del vuelo: no hay escala siguiente que quitar. Si el vuelo no llegó a ${a.destino_iata}, cambia el destino con «Editar tramo».`,
      details: { escala_id: a.id, destino_iata: a.destino_iata },
    };
  }
  if (a.destino_iata !== b.origen_iata) {
    return {
      code: 'ESCALA_NO_ENLAZA',
      message: `El tramo siguiente sale de ${b.origen_iata}, no de ${a.destino_iata}: la ruta no es continua y la escala no se puede quitar sola. Corrige la ruta con «Editar tramo».`,
      details: {
        escala_id: a.id,
        siguiente_id: b.id,
        destino_iata: a.destino_iata,
        siguiente_origen_iata: b.origen_iata,
      },
    };
  }
  if (a.solo_operativa || b.solo_operativa) {
    return {
      code: 'ESCALA_OPERATIVA',
      message:
        'Un tramo operativo (ferry o parada técnica) no se fusiona con otro: si no voló, cancélalo con «Cancelar tramo»; si cambió su ruta, edítalo.',
      details: {
        escala_id: a.id,
        siguiente_id: b.id,
        operativa_a: !!a.solo_operativa,
        operativa_b: !!b.solo_operativa,
      },
    };
  }
  const avionA = a.aeronave_id ?? vuelo.aeronave_id ?? null;
  const avionB = b.aeronave_id ?? vuelo.aeronave_id ?? null;
  if (avionA !== avionB) {
    return {
      code: 'ESCALAS_DISTINTO_AVION',
      message:
        'Los dos tramos van en aviones distintos: no se pueden fusionar en uno.',
      details: {
        escala_id: a.id,
        siguiente_id: b.id,
        aeronave_a: avionA,
        aeronave_b: avionB,
      },
    };
  }
  return null;
}

/** Descripción corta de una llegada para bitácora y notas. */
export function descripcionLlegada(t: TramoFusionable): string {
  const taco = num(t.taco_llegada);
  const partes: string[] = [];
  if (taco != null) {
    partes.push(
      `taco ${taco}${t.taco_llegada_origen ? ` (${t.taco_llegada_origen})` : ''}`,
    );
  }
  const hora = fechaHoraCancun(t.hora_llegada ?? null);
  if (hora) partes.push(`a las ${hora}`);
  if (t.foto_taco_llegada_url) partes.push('con foto');
  return partes.length ? partes.join(' ') : 'sin lectura';
}

export interface FusionTramos {
  /** PATCH de la fila de A (el tramo que sobrevive). */
  patch: Record<string, unknown>;
  /** Ruta del tramo fusionado. */
  origen_iata: string;
  destino_iata: string;
  /** La escala que se quitó (destino de A = origen de B). */
  escala_iata: string;
  /** Llegada de A descartada (a la escala que no se hizo). */
  descartada: {
    hora_llegada: string | null;
    taco_llegada: number | null;
    taco_llegada_origen: string | null;
    con_foto: boolean;
  };
  /** La salida de A se retiró porque la llegada de B no la superaba. */
  salida_retirada: boolean;
  /** Alerta que encabeza `revision_motivo` del tramo fusionado. */
  alerta: string;
  /** Línea para las notas internas del vuelo (sin fecha ni motivo). */
  resumen: string;
  /** Aviso para quien lo pidió (null = nada que advertir aparte). */
  aviso: string | null;
}

function maxIso(a: string | null | undefined, b: string | null | undefined) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return b ?? null;
  if (Number.isNaN(tb)) return a ?? null;
  return tb > ta ? b! : a!;
}

/**
 * Fusión de A con B (ya validada con `porQueNoSeQuitaEscala`). PURA: solo
 * arma el PATCH y los textos; quién borra B, renumera y avisa es el servicio.
 */
export function fusionarTramos(
  a: TramoFusionable,
  b: TramoFusionable,
  p: {
    /** Instante del cambio (ISO). */
    ahora: string;
    /** Quién lo pidió (nombre o rol; va a la bitácora del tramo). */
    quien: string;
    /** Id del usuario para `updated_by`. */
    userId: string;
    /** ¿Existen las columnas del tacómetro omitido? (invariante 79). */
    omitidoOk: boolean;
  },
): FusionTramos {
  const tacoSalidaA = num(a.taco_salida);
  const tacoLlegadaB = num(b.taco_llegada);
  // CHECK escala: llegada > salida. Si no se cumple, una de las dos está
  // mal: la salida CEDE (en amarillo) y la llegada —la evidencia— se queda.
  const salidaRetirada =
    tacoSalidaA != null && tacoLlegadaB != null && tacoLlegadaB <= tacoSalidaA;

  const nombresA = Array.isArray(a.pasajeros_nombres)
    ? a.pasajeros_nombres
    : [];
  const nombresB = Array.isArray(b.pasajeros_nombres)
    ? b.pasajeros_nombres
    : [];
  const nombres = [...nombresA];
  for (const n of nombresB) if (!nombres.includes(n)) nombres.push(n);
  const paxA = num(a.pasajeros);
  const paxB = num(b.pasajeros);
  const pasajeros =
    paxA == null && paxB == null ? null : Math.max(paxA ?? 0, paxB ?? 0);
  const ferry = !!a.es_ferry && !!b.es_ferry;

  const notas = [txt(a.notas), txt(b.notas)].filter((n): n is string => !!n);
  const externoA = num(a.monto_externo_usd);
  const externoB = num(b.monto_externo_usd);
  const montoExterno =
    externoA == null && externoB == null
      ? null
      : Number(((externoA ?? 0) + (externoB ?? 0)).toFixed(2));

  const escala = a.destino_iata;
  const ruta = `${a.origen_iata}→${b.destino_iata}`;
  const alerta =
    `Escala en ${escala} quitada (no se aterrizó): tramos ${a.origen_iata}→${a.destino_iata} y ` +
    `${b.origen_iata}→${b.destino_iata} fusionados en ${ruta}; revisar salida, llegada y tacómetro en oficina`;
  const descartadaTxt = descripcionLlegada(a);
  const tomadaTxt = descripcionLlegada(b);
  let linea =
    `escala ${escala} quitada el ${fechaHoraCancun(p.ahora)} por ${p.quien}: ` +
    `llegada a ${escala} descartada (${descartadaTxt}) · ` +
    `llegada a ${b.destino_iata} tomada del tramo ${b.origen_iata}→${b.destino_iata} (${tomadaTxt})`;
  if (salidaRetirada) {
    linea += ` · salida ${tacoSalidaA} retirada: no cabe bajo la llegada ${tacoLlegadaB}`;
  }
  const bitacoraB = leerBitacora(b.revision_motivo);
  if (bitacoraB)
    linea += ` · del tramo ${b.origen_iata}→${b.destino_iata}: ${bitacoraB}`;
  // Las correcciones a la baja pendientes de B viajan con su llegada: el
  // previo combinado las conserva (motivoDirecto las relee de ahí).
  const previo = [a.revision_motivo, b.revision_motivo]
    .map((m) => txt(m))
    .filter((m): m is string => !!m)
    .join('; ');
  const revisionMotivo = motivoDirecto(previo || null, alerta, linea);

  const patch: Record<string, unknown> = {
    destino_iata: b.destino_iata,
    estado_permiso: b.estado_permiso ?? a.estado_permiso ?? 'no_aplica',
    hora_llegada: b.hora_llegada ?? null,
    taco_llegada: b.taco_llegada ?? null,
    taco_llegada_origen: b.taco_llegada_origen ?? null,
    foto_taco_llegada_url: b.foto_taco_llegada_url ?? null,
    taco_llegada_obs: b.taco_llegada_obs ?? null,
    valor_ia_propuesto: b.valor_ia_propuesto ?? a.valor_ia_propuesto ?? null,
    capturado_por: b.capturado_por ?? a.capturado_por ?? null,
    capturado_offline: !!a.capturado_offline || !!b.capturado_offline,
    sincronizado_at: maxIso(a.sincronizado_at, b.sincronizado_at),
    requiere_pernocta: !!b.requiere_pernocta,
    pernocta_costo_usd: b.pernocta_costo_usd ?? null,
    tipo_parada: b.tipo_parada ?? 'NORMAL',
    servicio_notas: b.servicio_notas ?? null,
    pasajeros: ferry ? 0 : pasajeros,
    pasajeros_nombres: ferry ? [] : nombres,
    es_ferry: ferry,
    notas: notas.length ? notas.join(' · ') : null,
    monto_externo_usd: montoExterno,
    revision_requerida: true,
    revision_motivo: revisionMotivo,
    updated_by: p.userId,
  };
  // Observaciones del tacómetro: si B trae la de llegada, su sello es el
  // más reciente; si no, se conserva el de A.
  if (b.taco_llegada_obs && b.taco_obs_updated_at) {
    patch.taco_obs_updated_at = maxIso(
      a.taco_obs_updated_at,
      b.taco_obs_updated_at,
    );
    patch.taco_obs_updated_by =
      patch.taco_obs_updated_at === b.taco_obs_updated_at
        ? (b.taco_obs_updated_by ?? null)
        : (a.taco_obs_updated_by ?? null);
  }
  if (salidaRetirada) {
    patch.taco_salida = null;
    patch.taco_salida_origen = null;
  }
  // Tacómetro omitido (invariante 79): la omisión de A era de la llegada a
  // la escala que ya no existe; la de B (su llegada) es la que sobrevive.
  // El CHECK exige llegada NULL con omisión: B omitido ⇒ B sin llegada.
  if (p.omitidoOk) {
    patch.taco_omitido_at = b.taco_omitido_at ?? null;
    patch.taco_omitido_por = b.taco_omitido_por ?? null;
    patch.taco_omitido_motivo = b.taco_omitido_motivo ?? null;
  }

  const avisos: string[] = [];
  if (salidaRetirada) {
    avisos.push(
      `La salida ${tacoSalidaA} del tramo no cabía bajo la llegada ${tacoLlegadaB}: se retiró y queda por confirmar en oficina.`,
    );
  }
  if (num(a.taco_llegada) != null) {
    avisos.push(
      `La llegada a ${escala} capturada (${descartadaTxt}) se descartó: queda en la bitácora del tramo.`,
    );
  }
  return {
    patch,
    origen_iata: a.origen_iata,
    destino_iata: b.destino_iata,
    escala_iata: escala,
    descartada: {
      hora_llegada: a.hora_llegada ?? null,
      taco_llegada: num(a.taco_llegada),
      taco_llegada_origen: a.taco_llegada_origen ?? null,
      con_foto: !!a.foto_taco_llegada_url,
    },
    salida_retirada: salidaRetirada,
    alerta,
    resumen: `${a.origen_iata}→${a.destino_iata} + ${b.origen_iata}→${b.destino_iata} ⇒ ${ruta}; ${linea}`,
    aviso: avisos.length ? avisos.join(' ') : null,
  };
}

/** Sello de las notas internas del vuelo (mismo patrón que cancelar/restaurar). */
export function selloEscalaQuitada(
  f: Pick<FusionTramos, 'escala_iata' | 'resumen'>,
  motivo: string,
  ahoraIso: string,
): string {
  return `[Escala ${f.escala_iata} quitada ${ahoraIso}] ${motivo.trim()} — ${f.resumen}`;
}

/** Aviso a la tripulación. */
export function textoAvisoEscalaQuitada(
  f: Pick<FusionTramos, 'escala_iata' | 'origen_iata' | 'destino_iata'>,
  motivo: string,
): string {
  return `Se quitó la escala en ${f.escala_iata}: el tramo ahora es ${f.origen_iata} → ${f.destino_iata}. Motivo: ${motivo.trim()}. Oficina revisará el tacómetro del tramo fusionado.`;
}
