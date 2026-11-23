/**
 * COBRO DE UN VUELO CON UTILIDADES DEL SOCIO (23-nov-2026, API 0.0.148,
 * invariante 143). Pedido del dueño: «algunos socios dicen que se pague esa
 * cotización de ese vuelo descontándolo de las utilidades del mes;
 * necesitamos una forma para que se cobre de las utilidades y les salga en su
 * balance por avión y en el balance general».
 *
 * EL MODELO (sin contabilidad nueva): son DOS filas de las tablas de siempre,
 * ligadas 1 a 1 por `cobro_vuelo.reparto_pago_id`:
 *  - un COBRO del vuelo (`cobro_vuelo`, método `OTRO`): el vuelo queda cobrado
 *    para todos los libros, que leen `cobrosEnUsd` como siempre;
 *  - una ENTREGA al socio (`reparto_pago`, método `OTRO`): su cuenta corriente
 *    y el «entregado / por entregar» del balance la restan como cualquier
 *    entrega (`movimientosDeCuenta`, `entregasPorSocioDelAvion`).
 * Equivale a «VuelaTour le entrega sus utilidades y el socio paga su vuelo con
 * ellas» sin que el dinero se mueva. Ningún lector de dinero cambió: lo único
 * nuevo son las ETIQUETAS (este archivo) y el desglose del balance.
 *
 * «Esta entrega es el pago de un vuelo» = existe un cobro que la cita. La
 * liga vive SOLO en el cobro: al reasignar el avión el cobro viaja al vuelo
 * clon con su liga, así que la entrega nunca apunta a un vuelo viejo.
 *
 * Sonda ÚNICA (patrón `columnaOpcional`): todo select/insert que nombre
 * `cobro_vuelo.reparto_pago_id` va detrás de `cobroUtilidadesDisponible`. Sin
 * la migración 20261123000001 el alta responde 503
 * `COBRO_UTILIDADES_NO_DISPONIBLE` y las lecturas salen sin las llaves nuevas.
 */
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional, esColumnaInexistente } from './columna-opcional.util';
import { esFuncionInexistente } from './updated-at-trigger.util';

/** Migración que crea `cobro_vuelo.reparto_pago_id`, el alta atómica y los candados. */
export const MIGRACION_COBRO_UTILIDADES = '20261123000001';
/** Función de BD que inserta la entrega y el cobro en UNA transacción. */
export const RPC_COBRO_UTILIDADES = 'cobro_utilidades_registrar';
/** Método con que se guardan las DOS filas (el enum y el CHECK no cambiaron). */
export const METODO_COBRO_UTILIDADES = 'OTRO';
/** Cómo se llama en pantalla, recibos y libros. */
export const ETIQUETA_COBRO_UTILIDADES = 'Utilidades del socio';
/** Motivo de la baja de la entrega cuando se quita el cobro (igual que el trigger). */
export const MOTIVO_BAJA_ENTREGA_DE_VUELO =
  'Se quitó el cobro con utilidades del vuelo';

export const MENSAJE_COBRO_UTILIDADES_NO_DISPONIBLE = `Todavía no se puede cobrar un vuelo con utilidades del socio: falta aplicar la migración ${MIGRACION_COBRO_UTILIDADES}.`;

/** ¿Ya está aplicada la migración? (memorizado; re-sondeo ≤ 10 min). */
export function cobroUtilidadesDisponible(
  sb: SupabaseClient,
): Promise<boolean> {
  return columnaOpcional(sb, 'cobro_vuelo', 'reparto_pago_id', {
    mensajeAusente:
      `Columna cobro_vuelo.reparto_pago_id no existe todavía: cobrar un vuelo ` +
      `con utilidades del socio responde 503 COBRO_UTILIDADES_NO_DISPONIBLE y ` +
      `las lecturas salen sin la liga hasta aplicar la migración ${MIGRACION_COBRO_UTILIDADES}`,
  }).disponible();
}

/**
 * Sufijo para un select de `cobro_vuelo`: `', reparto_pago_id'` con la
 * migración, `''` sin ella (la columna NUNCA se nombra sin la sonda).
 */
export function colCobroUtilidades(disponible: boolean): string {
  return disponible ? ', reparto_pago_id' : '';
}

/** 503 estructurado `COBRO_UTILIDADES_NO_DISPONIBLE`. */
export function errorCobroUtilidadesNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_COBRO_UTILIDADES_NO_DISPONIBLE,
    error: 'COBRO_UTILIDADES_NO_DISPONIBLE',
    details: { migracion: MIGRACION_COBRO_UTILIDADES },
  });
}

/** «Utilidades del socio (Macedo)»; sin nombre, la etiqueta a secas. */
export function etiquetaCobroConUtilidades(socio?: string | null): string {
  const nombre = (socio ?? '').trim();
  return nombre
    ? `${ETIQUETA_COBRO_UTILIDADES} (${nombre})`
    : ETIQUETA_COBRO_UTILIDADES;
}

/** Referencia que se guarda en la entrega: «Vuelo #498» (queda en su historial). */
export function referenciaEntregaDeVuelo(
  folio: number | string | null,
): string {
  return folio == null || folio === '' ? 'Vuelo' : `Vuelo #${folio}`;
}

/** Lo que el cobro dice de sus utilidades (ADITIVO en la lista de cobros). */
export interface UtilidadesDeCobro {
  entrega_id: string;
  socio_id: string;
  socio_nombre: string;
  aeronave_id: string | null;
  matricula: string | null;
  /** Mes del que se descuenta ('YYYY-MM'): `periodo` de la entrega. */
  mes: string | null;
}

/** El vuelo que paga una entrega (ADITIVO en `PagoSocio.vuelo`). */
export interface VueloDeEntrega {
  /** Id del VUELO. */
  id: string;
  folio: number | null;
  cobro_id: string;
  /** Día Cancún del vuelo ('YYYY-MM-DD'). */
  fecha: string | null;
  cliente: string | null;
  /** Matrícula del avión que VOLÓ (puede no ser el de las utilidades). */
  matricula: string | null;
}

type Fila = Record<string, unknown>;

/** Un embed de PostgREST (objeto o arreglo de uno) como fila, o null. */
const filaDe = (v: unknown): Fila | null => {
  const x: unknown = Array.isArray(v) ? v[0] : v;
  return x && typeof x === 'object' ? (x as Fila) : null;
};

const texto = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** Día de PARED de Cancún (UTC−5, sin horario de verano) de un instante. */
export function diaCancunDe(instante: unknown): string | null {
  if (typeof instante !== 'string' || !instante) return null;
  const t = new Date(instante).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - 5 * 3_600_000).toISOString().slice(0, 10);
}

const LOTE_IDS = 150;

/**
 * `entrega_id → vuelo` de las entregas que son el pago de un vuelo. Sin
 * `entregaIds` trae TODAS (son pocas: una por vuelo pagado con utilidades).
 * Sin la migración ⇒ mapa vacío (jamás lanza por la columna ausente); otro
 * error de lectura se LANZA (un mapa vacío falso escondería el desglose).
 */
export async function vuelosDeEntregas(
  sb: SupabaseClient,
  entregaIds?: ReadonlyArray<string>,
): Promise<Map<string, VueloDeEntrega>> {
  const out = new Map<string, VueloDeEntrega>();
  if (!(await cobroUtilidadesDisponible(sb))) return out;
  const ids = entregaIds ? [...new Set(entregaIds.filter(Boolean))] : null;
  if (ids && ids.length === 0) return out;
  const cols =
    'id, vuelo_id, reparto_pago_id, vuelo:vuelo_id(folio, fecha_vuelo, cliente:cliente_id(nombre), aeronave:aeronave_id(matricula))';
  const lotes: Array<string[] | null> = ids
    ? Array.from({ length: Math.ceil(ids.length / LOTE_IDS) }, (_, i) =>
        ids.slice(i * LOTE_IDS, (i + 1) * LOTE_IDS),
      )
    : [null];
  for (const lote of lotes) {
    const q = sb.from('cobro_vuelo').select(cols);
    const { data, error } = await (lote
      ? q.in('reparto_pago_id', lote)
      : q.not('reparto_pago_id', 'is', null).limit(1000));
    if (error) {
      if (esColumnaInexistente(error)) return new Map();
      throw new Error(error.message);
    }
    for (const f of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const entregaId = texto(f.reparto_pago_id);
      const vueloId = texto(f.vuelo_id);
      if (!entregaId || !vueloId) continue;
      const v = filaDe(f.vuelo);
      const folio = Number(v?.folio);
      out.set(entregaId, {
        id: vueloId,
        folio: Number.isFinite(folio) && folio > 0 ? folio : null,
        cobro_id: String(f.id),
        fecha: diaCancunDe(v?.fecha_vuelo),
        cliente: texto(filaDe(v?.cliente)?.nombre),
        matricula: texto(filaDe(v?.aeronave)?.matricula),
      });
    }
  }
  return out;
}

/**
 * `cobro_id → utilidades` de los cobros (de ESTA respuesta) pagados con
 * utilidades. Lectura aparte, como `anticiposDeCobros`: no toca `COBRO_COLS`.
 * Sin la migración ⇒ mapa vacío.
 */
export async function utilidadesDeCobros(
  sb: SupabaseClient,
  cobroIds: ReadonlyArray<string>,
): Promise<Map<string, UtilidadesDeCobro>> {
  const out = new Map<string, UtilidadesDeCobro>();
  const ids = [...new Set(cobroIds.filter(Boolean))];
  if (ids.length === 0) return out;
  if (!(await cobroUtilidadesDisponible(sb))) return out;
  const cols =
    'id, reparto_pago_id, entrega:reparto_pago_id(id, socio_id, aeronave_id, periodo, fecha_pago, socio:socio_id(nombre), aeronave:aeronave_id(matricula))';
  for (let i = 0; i < ids.length; i += LOTE_IDS) {
    // Los ids son los cobros de ESTA respuesta: el `reparto_pago_id` no nulo
    // se filtra en memoria (como `anticiposDeCobros`).
    const { data, error } = await sb
      .from('cobro_vuelo')
      .select(cols)
      .in('id', ids.slice(i, i + LOTE_IDS));
    if (error) {
      if (esColumnaInexistente(error)) return new Map();
      throw new Error(error.message);
    }
    for (const f of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const e = filaDe(f.entrega);
      const entregaId = texto(f.reparto_pago_id);
      const socioId = texto(e?.socio_id);
      if (!entregaId || !socioId) continue;
      const dia = texto(e?.periodo) ?? texto(e?.fecha_pago);
      out.set(String(f.id), {
        entrega_id: entregaId,
        socio_id: socioId,
        socio_nombre: texto(filaDe(e?.socio)?.nombre) ?? 'Socio',
        aeronave_id: texto(e?.aeronave_id),
        matricula: texto(filaDe(e?.aeronave)?.matricula),
        mes: dia ? dia.slice(0, 7) : null,
      });
    }
  }
  return out;
}

/**
 * Llave de un cobro para quien lo lee SIN su id (los libros): el vuelo, el
 * monto, la moneda y el instante del cobro.
 */
export function claveCobroUtilidades(c: {
  vuelo_id?: unknown;
  monto?: unknown;
  moneda?: unknown;
  fecha_cobro?: unknown;
}): string {
  const t =
    typeof c.fecha_cobro === 'string' ? new Date(c.fecha_cobro).getTime() : NaN;
  return [
    typeof c.vuelo_id === 'string' ? c.vuelo_id : '',
    Number(c.monto),
    typeof c.moneda === 'string' ? c.moneda : '',
    Number.isFinite(t) ? t : '',
  ].join('|');
}

/**
 * `claveCobroUtilidades → «Utilidades del socio (Nombre)»` de los cobros con
 * utilidades de esos vuelos (para la nota «cómo se cobró» de los libros). Sin
 * la migración ⇒ mapa vacío.
 */
export async function etiquetasUtilidadesDeVuelos(
  sb: SupabaseClient,
  vueloIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(vueloIds.filter(Boolean))];
  if (ids.length === 0) return out;
  if (!(await cobroUtilidadesDisponible(sb))) return out;
  const cols =
    'vuelo_id, monto, moneda, fecha_cobro, reparto_pago_id, entrega:reparto_pago_id(socio:socio_id(nombre))';
  for (let i = 0; i < ids.length; i += LOTE_IDS) {
    const { data, error } = await sb
      .from('cobro_vuelo')
      .select(cols)
      .in('vuelo_id', ids.slice(i, i + LOTE_IDS));
    if (error) {
      if (esColumnaInexistente(error)) return new Map();
      throw new Error(error.message);
    }
    for (const f of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      if (!texto(f.reparto_pago_id)) continue;
      const socio = texto(filaDe(filaDe(f.entrega)?.socio)?.nombre);
      out.set(claveCobroUtilidades(f), etiquetaCobroConUtilidades(socio));
    }
  }
  return out;
}

/** La entrega que cita un cobro (null si no es con utilidades o sin migración). */
export async function entregaDeCobro(
  sb: SupabaseClient,
  cobroId: string,
): Promise<string | null> {
  if (!(await cobroUtilidadesDisponible(sb))) return null;
  const { data, error } = await sb
    .from('cobro_vuelo')
    .select('id, reparto_pago_id')
    .eq('id', cobroId)
    .maybeSingle();
  if (error) {
    if (esColumnaInexistente(error)) return null;
    throw new Error(error.message);
  }
  return texto((data as Record<string, unknown> | null)?.reparto_pago_id);
}

// ---------------------------------------------------------------------------
// Errores con `code` estable (el panel decide por `code`, jamás por el texto)
// ---------------------------------------------------------------------------

export const MENSAJE_COBRO_CON_UTILIDADES =
  'Este cobro se pagó con utilidades del socio: su monto, moneda, tipo de cambio, fecha y método no se corrigen. Quita el cobro y regístralo de nuevo.';

/** 409 al corregir el dinero de un cobro con utilidades. */
export function errorCobroConUtilidades(details?: unknown): ConflictException {
  return new ConflictException({
    message: MENSAJE_COBRO_CON_UTILIDADES,
    error: 'COBRO_CON_UTILIDADES',
    details,
  });
}

/** 409 al corregir o dar de baja, desde «Pagos a socios», la entrega de un vuelo. */
export function errorEntregaDeVuelo(v: VueloDeEntrega): ConflictException {
  const cual = v.folio != null ? `del vuelo #${v.folio}` : 'de un vuelo';
  return new ConflictException({
    message: `Esta entrega es el pago ${cual} con utilidades del socio: no se corrige ni se da de baja aquí. Quita el cobro en el vuelo (y regístralo de nuevo si hace falta).`,
    error: 'ENTREGA_DE_VUELO',
    details: { vuelo_id: v.id, folio: v.folio, cobro_id: v.cobro_id },
  });
}

/** Códigos que levantan la función y los triggers de la migración (en el `hint`). */
const CODIGOS_BD = [
  'UTILIDADES_LIGA_INMUTABLE',
  'COBRO_CON_UTILIDADES',
  'UTILIDADES_ENTREGA_NO_EXISTE',
  'UTILIDADES_ENTREGA_DADA_DE_BAJA',
  'UTILIDADES_MONTO_DISTINTO',
  'ENTREGA_DE_VUELO',
] as const;
export type CodigoBdCobroUtilidades = (typeof CODIGOS_BD)[number];

export interface ErrorBdLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
  details?: string | null;
}

/** Código de negocio de un error de la BD de este lote (hint o prefijo), o null. */
export function codigoBdCobroUtilidades(
  e: ErrorBdLike | null | undefined,
): CodigoBdCobroUtilidades | null {
  if (!e) return null;
  const hint = (e.hint ?? '').trim();
  const prefijo = (e.message ?? '').split(':')[0]?.trim() ?? '';
  return (
    CODIGOS_BD.find((c) => c === hint) ??
    CODIGOS_BD.find((c) => c === prefijo) ??
    null
  );
}

/** El texto de la BD sin su prefijo «CODIGO: ». */
function textoSinPrefijo(e: ErrorBdLike): string {
  const m = e.message ?? '';
  const i = m.indexOf(':');
  return (i >= 0 ? m.slice(i + 1) : m).trim();
}

/**
 * Error del ALTA atómica (`cobro_utilidades_registrar`) ⇒ excepción legible:
 * función ausente ⇒ 503; candados de la BD ⇒ 409; datos que la BD rechaza
 * (CHECK, FK, número fuera de rango) ⇒ 400. Lo demás se devuelve tal cual
 * (500): nada quedó escrito, la función es una sola transacción.
 */
export function errorAltaCobroUtilidades(
  e: ErrorBdLike,
): HttpException | Error {
  if (esFuncionInexistente(e) || esColumnaInexistente(e)) {
    return errorCobroUtilidadesNoDisponible();
  }
  const codigo = codigoBdCobroUtilidades(e);
  if (codigo) {
    return new ConflictException({
      message: textoSinPrefijo(e) || MENSAJE_COBRO_CON_UTILIDADES,
      error: codigo,
    });
  }
  if (e.code === '23514' || e.code === '22003' || e.code === '22P02') {
    return new BadRequestException({
      message:
        'Algún dato del cobro con utilidades no es válido (monto, moneda, tipo de cambio o fecha): revisa la captura.',
      error: 'COBRO_UTILIDADES_INVALIDO',
      details: { tecnico: e.message },
    });
  }
  if (e.code === '23503') {
    return new BadRequestException({
      message: 'El vuelo, el socio o el avión ya no existe.',
      error: 'COBRO_UTILIDADES_REFERENCIA_INVALIDA',
      details: { tecnico: e.message },
    });
  }
  return new Error(e.message ?? 'Error al registrar el cobro con utilidades');
}
