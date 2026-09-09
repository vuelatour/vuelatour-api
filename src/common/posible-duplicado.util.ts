import type { SupabaseClient } from '@supabase/supabase-js';
import { rangoDiasCancun } from './avion-ocupado.util';
import { fechaCortaCancun } from './fecha-cancun.util';

/**
 * Detector de POSIBLE DUPLICADO de una reserva (diseño offline v2, 9-sep-2026).
 *
 * Un vuelo agendado sin señal desde la app y el mismo vuelo agendado después
 * por otra persona en el panel (o desde otro teléfono) se subirían los dos.
 * Antes de crear la reserva se buscan vuelos VIVOS del mismo cliente cuyo
 * itinerario [fecha_vuelo, fecha_fin] solape el día Cancún de la nueva y que
 * además compartan avión O el origen→destino del tramo 1. Es una heurística
 * de AVISO: solo bloquea (409 POSIBLE_DUPLICADO) cuando el caller lo pide con
 * `rechazar_posible_duplicado` y no trae `aceptar_posible_duplicado`; el
 * panel y la APK vieja solo ven el texto en `avisos[]`.
 *
 * Falsos positivos reales de VuelaTour que se EXCLUYEN a propósito: hijos de
 * grupo multi-avión (`grupo_id`), cliente interno (`es_interno`: vuelos de la
 * empresa, varios por día) y brokers (`es_broker`: revenden varios vuelos el
 * mismo día). Filtro PURO (sin IO) + UNA consulta.
 */

export interface EscalaDuplicadoRow {
  orden: number;
  origen_iata: string | null;
  destino_iata: string | null;
  aeronave_id: string | null;
  cancelada_at: string | null;
}

export interface VueloDuplicadoRow {
  id: string;
  folio: number | null;
  estado: string | null;
  cliente_id?: string | null;
  aeronave_id: string | null;
  fecha_vuelo: string | null;
  fecha_fin?: string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  grupo_id?: string | null;
  escalas?: EscalaDuplicadoRow[] | null;
  aeronave?:
    | { matricula?: string | null }
    | { matricula?: string | null }[]
    | null;
  piloto?: { nombre?: string | null } | { nombre?: string | null }[] | null;
  grupo?: { folio?: number | null } | { folio?: number | null }[] | null;
}

/** Lo que se sabe de la reserva NUEVA antes de insertarla. */
export interface ReservaCandidata {
  aeronave_id: string | null;
  /** Tramo 1 de la nueva reserva (itinerario[0] u origen/destino tentativos). */
  origen_iata: string;
  destino_iata: string;
  /** Banderas del cliente: interno/broker → el detector no aplica. */
  cliente_es_interno?: boolean | null;
  cliente_es_broker?: boolean | null;
}

/** Resumen que viaja en `details.vuelos[]` y en el texto del aviso. */
export interface ResumenDuplicado {
  id: string;
  folio: number | null;
  fecha_vuelo: string | null;
  /** "09:00" en hora Cancún (null sin fecha). */
  hora: string | null;
  /** IATAs de los tramos vivos unidos: "CUN → HOL → CUN". */
  ruta: string;
  aeronave_matricula: string | null;
  piloto_nombre: string | null;
  grupo_folio: number | null;
}

function unwrap<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Tramo 1 EFECTIVO: primera escala viva por orden; sin escalas, el vuelo. */
function tramoUno(v: VueloDuplicadoRow): {
  origen: string | null;
  destino: string | null;
  aeronave_id: string | null;
} {
  const vivas = (v.escalas ?? [])
    .filter((e) => e.cancelada_at == null)
    .sort((a, b) => Number(a.orden) - Number(b.orden));
  const e = vivas[0];
  if (!e) {
    return {
      origen: v.origen_iata,
      destino: v.destino_iata,
      aeronave_id: v.aeronave_id,
    };
  }
  return {
    origen: e.origen_iata,
    destino: e.destino_iata,
    aeronave_id: e.aeronave_id ?? v.aeronave_id,
  };
}

const up = (s: string | null | undefined): string => (s ?? '').toUpperCase();

/**
 * Filtro PURO sobre vuelos ya leídos (mismo cliente, misma ventana): deja
 * los que de verdad parecen el mismo vuelo. Sin IO — testeable.
 */
export function filtrarPosiblesDuplicados<T extends VueloDuplicadoRow>(
  rows: T[],
  nueva: ReservaCandidata,
): T[] {
  if (nueva.cliente_es_interno === true || nueva.cliente_es_broker === true) {
    return [];
  }
  const origenNuevo = up(nueva.origen_iata);
  const destinoNuevo = up(nueva.destino_iata);
  return rows.filter((v) => {
    if (v.estado === 'CANCELADO') return false;
    if (v.grupo_id) return false;
    const t1 = tramoUno(v);
    const mismoAvion =
      !!nueva.aeronave_id &&
      (v.aeronave_id === nueva.aeronave_id ||
        t1.aeronave_id === nueva.aeronave_id);
    const mismaRuta =
      up(t1.origen) === origenNuevo && up(t1.destino) === destinoNuevo;
    return mismoAvion || mismaRuta;
  });
}

const FMT_HORA_CANCUN = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Cancun',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function horaCancun(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return FMT_HORA_CANCUN.format(d).replace(/^24:/, '00:');
}

/** "lun 14 sep" en hora Cancún (fuente única fechaCortaCancun). */
function diaCortoCancun(iso: string | null): string | null {
  return fechaCortaCancun(iso) || null;
}

/** Ruta de los tramos vivos ("CUN → HOL → CUN"); sin tramos, la del vuelo. */
export function rutaDeDuplicado(v: VueloDuplicadoRow): string {
  const vivas = (v.escalas ?? [])
    .filter((e) => e.cancelada_at == null)
    .sort((a, b) => Number(a.orden) - Number(b.orden));
  if (vivas.length === 0) {
    return [v.origen_iata, v.destino_iata].filter(Boolean).join(' → ');
  }
  const puntos = [vivas[0].origen_iata, ...vivas.map((e) => e.destino_iata)];
  return puntos.filter(Boolean).join(' → ');
}

export function resumirDuplicado(v: VueloDuplicadoRow): ResumenDuplicado {
  return {
    id: v.id,
    folio: v.folio ?? null,
    fecha_vuelo: v.fecha_vuelo ?? null,
    hora: horaCancun(v.fecha_vuelo ?? null),
    ruta: rutaDeDuplicado(v),
    aeronave_matricula: unwrap(v.aeronave)?.matricula ?? null,
    piloto_nombre: unwrap(v.piloto)?.nombre ?? null,
    grupo_folio: unwrap(v.grupo)?.folio ?? null,
  };
}

/** «Posible duplicado: #118 · lun 14 sep 09:00 · CUN → HOL · XA-VGV». */
export function textoPosibleDuplicado(r: ResumenDuplicado): string {
  const dia = diaCortoCancun(r.fecha_vuelo);
  const cuando = [dia, r.hora].filter(Boolean).join(' ');
  const partes = [
    `#${r.folio ?? '?'}`,
    cuando || null,
    r.ruta || null,
    r.aeronave_matricula,
  ].filter((p): p is string => !!p);
  return `Posible duplicado: ${partes.join(' · ')}`;
}

/** Select único del detector (embeds ligeros: matrícula, piloto, grupo). */
export const DUPLICADO_SELECT =
  'id, folio, estado, cliente_id, aeronave_id, fecha_vuelo, fecha_fin, origen_iata, destino_iata, grupo_id, aeronave:aeronave_id(matricula), piloto:piloto_id(nombre), grupo:vuelo_grupo!grupo_id(folio), escalas:escala(orden, origen_iata, destino_iata, aeronave_id, cancelada_at)';

/**
 * UNA consulta (mismo cliente, vivos, solape de días Cancún con
 * [fecha_vuelo, fecha_fin] — mismos cortes `T00:00:00-05:00` /
 * `T23:59:59-05:00` que `avionOcupadoEnFecha`) + el filtro puro. Un error de
 * lectura lanza: el caller decide (la reserva no debe crearse "a ciegas"
 * cuando la oficina pidió rechazar duplicados).
 */
export async function buscarPosiblesDuplicados(
  sb: SupabaseClient,
  p: {
    clienteId: string;
    fechaVuelo: string | Date;
    fechaFin?: string | Date | null;
    nueva: ReservaCandidata;
  },
): Promise<ResumenDuplicado[]> {
  if (
    p.nueva.cliente_es_interno === true ||
    p.nueva.cliente_es_broker === true
  ) {
    return [];
  }
  const { desde, hasta } = rangoDiasCancun(p.fechaVuelo, p.fechaFin);
  const { data, error } = await sb
    .from('vuelo')
    .select(DUPLICADO_SELECT)
    .eq('cliente_id', p.clienteId)
    .neq('estado', 'CANCELADO')
    .is('grupo_id', null)
    .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`)
    .gte('fecha_fin', `${desde}T00:00:00-05:00`)
    .order('fecha_vuelo', { ascending: true })
    .limit(20);
  if (error) throw new Error(error.message);
  return filtrarPosiblesDuplicados(
    (data ?? []) as unknown as VueloDuplicadoRow[],
    p.nueva,
  ).map(resumirDuplicado);
}
