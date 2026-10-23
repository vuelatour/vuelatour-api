/**
 * LECTOR ÚNICO de los CIERRES DE MES y CANDADO 409 `MES_CERRADO`
 * (16-oct-2026, API 0.0.88, invariante 89, migración `20261016000004`;
 * CIERRE POR AVIÓN desde el 23-oct-2026, API 0.0.104, invariante 105,
 * migración `20261023000001`).
 *
 * - `leerCierresMes(sb)`: las filas de `cierre_mes` (pocas: una por mes desde
 *   el inicio oficial) con el NOMBRE de quien cerró / reabrió. Sin la
 *   migración ⇒ `[]` sin consultar la tabla (sonda `cierreMesDisponible`).
 *   Desde la invariante 105 la fila global es DERIVADA (la escribe el API
 *   cuando el último avión activo del mes queda cerrado): `CERRADO` sigue
 *   siendo «toda la flota cerrada» para todos los lectores globales.
 * - `leerCierresMesAvion(sb)`: las filas de `cierre_mes_avion` (una por mes
 *   y avión) con nombres y matrícula. Sin la migración por avión ⇒ `[]`.
 * - `cierresCerrados(sb)`: los meses con `estado = 'CERRADO'` (la ÚNICA verdad
 *   de «mes cerrado»), con caché ≤ 60 s por cliente Supabase. Un mes PASADO
 *   que la caché da por abierto se relee si la caché tiene > 10 s (otra
 *   instancia del API pudo cerrarlo: el peor caso real es 10 s, no 60).
 *   `cierresAvionDeMes(sb, mes)`: los aviones CERRADOS de ese mes (misma
 *   caché y misma relectura). `olvidarCierres(sb)` invalida las dos
 *   (cerrar / reabrir del mismo proceso).
 * - `assertMesAbierto(sb, meses, registro, aviones?)`: el CANDADO de
 *   capturas. Cada mes 'YYYY-MM' (null/undefined ⇒ no bloquea) cerrado en la
 *   fila GLOBAL ⇒ 409; con `aviones`, también si alguno de esos aviones tiene
 *   `cierre_mes_avion` CERRADO en ese mes ⇒ 409 con `details.aeronave` y el
 *   texto «N621TX · Septiembre 2026 ya está cerrado…». Cuerpo:
 *   `{ message: textoMesCerrado, error: 'MES_CERRADO', details: { periodo,
 *   cerrado_at, cerrado_por: {id, nombre}, registro, aeronave? } }`
 *   (`aeronave` SOLO viaja con la migración por avión: null = fila global).
 *   Sin la migración no hay candado (nada puede estar cerrado). Un fallo de
 *   LECTURA del candado SUBE (nunca se deja pasar una captura «a ciegas»
 *   sobre un mes que podría estar cerrado).
 * - Quién pasa `aviones` (regla 5 de la invariante 105): gasto ⇒
 *   `avionDelGasto` + sus partes de reparto manual (`avionesDeGastoCandado`);
 *   cobro y vuelo ⇒ los aviones participantes del vuelo
 *   (`participantesDeVuelos`, factor > 0 de `participacionPorAeronave`);
 *   ingreso ⇒ `aeronave_id`; entrega a socio ⇒ el avión del reparto; AFAC
 *   real ⇒ el avión del vuelo; cotización ⇒ aviones del vuelo; inventario ⇒
 *   el avión de la salida. Registros SIN avión (caja chica, ingreso sin
 *   avión, gasto de empresa sin reparto) ⇒ solo la fila global.
 *
 * Es función (no servicio Nest) a propósito: lo llaman gastos, cobros,
 * ingresos, caja chica, entregas a socios, cotizaciones y grupos sin tocar
 * sus constructores ni crear ciclos de módulos (patrón `columnaOpcional`).
 */
import { ConflictException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  cierreMesDisponible,
  cierrePorAvionDisponible,
} from './cierre-mes-disponible.util';
import { hoyCancun } from './fecha-cancun.util';
import {
  type DiferimientoVuelo,
  esMesContable,
  estadoMesDerivado,
  type EstadoMesFlota,
  type GastoParaMesContable,
  mesContableDeGasto,
  mesContableDeVuelo,
  mesDePeriodo,
  textoMesCerrado,
} from './mes-contable.util';
import {
  avionDelGasto,
  participacionPorAeronave,
  type EscalaParticipacionInput,
} from './participacion-aeronave.util';
import { fetchNombresUsuarios } from './registrado-por.util';

/** Estados persistidos de `cierre_mes` y de `cierre_mes_avion`. */
export type EstadoCierreMes = 'CERRADO' | 'REABIERTO';

/** Columnas de `cierre_mes` que leen el estado y el candado (sin snapshots). */
export const CIERRE_MES_COLS =
  'periodo, estado, cerrado_at, cerrado_por, reabierto_at, reabierto_por, reabierto_motivo, version, totales, updated_at';

/** Columnas de `cierre_mes_avion` que leen el estado y el candado (sin snapshots). */
export const CIERRE_MES_AVION_COLS =
  'periodo, aeronave_id, estado, cerrado_at, cerrado_por, reabierto_at, reabierto_por, reabierto_motivo, version, totales, updated_at';

/** Usuario de un sello del cierre. */
export interface UsuarioCierre {
  id: string;
  nombre: string;
}

/** Una fila de `cierre_mes`, ya legible. */
export interface CierreMesLeido {
  /** 'YYYY-MM'. */
  periodo: string;
  estado: EstadoCierreMes;
  cerrado_at: string | null;
  cerrado_por: UsuarioCierre | null;
  reabierto_at: string | null;
  reabierto_por: UsuarioCierre | null;
  reabierto_motivo: string | null;
  version: number;
  totales: Record<string, unknown> | null;
  updated_at: string | null;
}

/** Una fila de `cierre_mes_avion`, ya legible (invariante 105). */
export interface CierreAvionLeido extends CierreMesLeido {
  aeronave_id: string;
  /** Matrícula del avión (lectura de cortesía; null si no se resolvió). */
  matricula: string | null;
}

/** Avión del 409 `MES_CERRADO` (details.aeronave). */
export interface AeronaveCandado {
  id: string;
  matricula: string | null;
}

/** Registro cuya captura se evalúa contra el candado. */
export type RegistroCandado =
  | 'gasto'
  | 'cobro'
  | 'ingreso'
  | 'caja_chica'
  | 'entrega_socio'
  | 'cotizacion'
  | 'vuelo'
  // Costo real AFAC de un vuelo (16-oct-2026, invariante 90): por el mes
  // CONTABLE del vuelo.
  | 'afac_real';

/** Código del 409. */
export const CODIGO_MES_CERRADO = 'MES_CERRADO';

/** Vida de la caché de meses cerrados. */
export const CIERRES_CACHE_MS = 60_000;
/** Antigüedad a partir de la cual un mes pasado «abierto» se relee. */
export const CIERRES_RELECTURA_MS = 10_000;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

function filaLeida(
  f: Record<string, unknown>,
  usuario: (id: unknown) => UsuarioCierre | null,
): CierreMesLeido | null {
  const periodo = mesDePeriodo(str(f.periodo));
  if (!periodo || !esMesContable(periodo)) return null;
  return {
    periodo,
    estado: f.estado === 'REABIERTO' ? 'REABIERTO' : 'CERRADO',
    cerrado_at: str(f.cerrado_at),
    cerrado_por: usuario(f.cerrado_por),
    reabierto_at: str(f.reabierto_at),
    reabierto_por: usuario(f.reabierto_por),
    reabierto_motivo: str(f.reabierto_motivo),
    version: Number(f.version) || 1,
    totales:
      f.totales && typeof f.totales === 'object'
        ? (f.totales as Record<string, unknown>)
        : null,
    updated_at: str(f.updated_at),
  };
}

async function usuariosDe(
  sb: SupabaseClient,
  filas: Array<Record<string, unknown>>,
): Promise<(id: unknown) => UsuarioCierre | null> {
  const nombres = await fetchNombresUsuarios(
    sb,
    filas.flatMap((f) => [str(f.cerrado_por), str(f.reabierto_por)]),
  );
  return (id: unknown): UsuarioCierre | null => {
    const s = str(id);
    return s ? { id: s, nombre: nombres.get(s) ?? 'la oficina' } : null;
  };
}

/**
 * Filas de `cierre_mes` (orden por periodo). Sin la migración ⇒ `[]` sin
 * consultar. Un error de lectura LANZA (el llamador decide si es
 * best-effort).
 */
export async function leerCierresMes(
  sb: SupabaseClient,
): Promise<CierreMesLeido[]> {
  if (!(await cierreMesDisponible(sb))) return [];
  const { data, error } = await sb
    .from('cierre_mes')
    .select(CIERRE_MES_COLS)
    .order('periodo', { ascending: true });
  if (error) throw new Error(`Cierres de mes: ${error.message}`);
  const filas = (data ?? []) as Array<Record<string, unknown>>;
  const usuario = await usuariosDe(sb, filas);
  const out: CierreMesLeido[] = [];
  for (const f of filas) {
    const leida = filaLeida(f, usuario);
    if (leida) out.push(leida);
  }
  return out;
}

/**
 * Matrículas de esos aviones (una consulta; cortesía: un fallo deja null).
 */
async function matriculasDe(
  sb: SupabaseClient,
  ids: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const unicos = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, string>();
  if (unicos.length === 0) return out;
  const { data, error } = await sb
    .from('aeronave')
    .select('id, matricula')
    .in('id', unicos);
  if (error) return out;
  for (const a of (data ?? []) as Array<Record<string, unknown>>) {
    const id = str(a.id);
    const mat = str(a.matricula);
    if (id && mat) out.set(id, mat);
  }
  return out;
}

/**
 * Filas de `cierre_mes_avion` (orden por periodo y matrícula) con nombres y
 * matrícula (invariante 105). Sin la migración por avión ⇒ `[]` sin
 * consultar. Un error de lectura LANZA.
 */
export async function leerCierresMesAvion(
  sb: SupabaseClient,
): Promise<CierreAvionLeido[]> {
  if (!(await cierrePorAvionDisponible(sb))) return [];
  const { data, error } = await sb
    .from('cierre_mes_avion')
    .select(CIERRE_MES_AVION_COLS)
    .order('periodo', { ascending: true });
  if (error) throw new Error(`Cierres de mes por avión: ${error.message}`);
  const filas = (data ?? []) as Array<Record<string, unknown>>;
  const [usuario, matriculas] = await Promise.all([
    usuariosDe(sb, filas),
    matriculasDe(
      sb,
      filas.map((f) => str(f.aeronave_id)).filter((x): x is string => !!x),
    ),
  ]);
  const out: CierreAvionLeido[] = [];
  for (const f of filas) {
    const leida = filaLeida(f, usuario);
    const aeronaveId = str(f.aeronave_id);
    if (!leida || !aeronaveId) continue;
    out.push({
      ...leida,
      aeronave_id: aeronaveId,
      matricula: matriculas.get(aeronaveId) ?? null,
    });
  }
  out.sort(
    (a, b) =>
      a.periodo.localeCompare(b.periodo) ||
      (a.matricula ?? '').localeCompare(b.matricula ?? '', 'es') ||
      a.aeronave_id.localeCompare(b.aeronave_id),
  );
  return out;
}

// ===== Caché de meses CERRADOS (candado) =====

interface CacheCierres {
  leidoMs: number;
  cerrados: Map<string, CierreMesLeido>;
  /** 'YYYY-MM' ⇒ aeronave_id ⇒ fila CERRADA de ese avión (invariante 105). */
  avion: Map<string, Map<string, CierreAvionLeido>>;
}

const caches = new WeakMap<SupabaseClient, CacheCierres>();
const enCurso = new WeakMap<SupabaseClient, Promise<CacheCierres>>();

/** Reloj inyectable (specs). */
let ahoraMs: () => number = () => Date.now();

/** Specs: reloj fijo (o `null` para volver a `Date.now`). */
export function relojCierresParaSpecs(f: (() => number) | null): void {
  ahoraMs = f ?? (() => Date.now());
}

/** Olvida la caché de ese cliente (cerrar / reabrir, specs). */
export function olvidarCierres(sb: SupabaseClient): void {
  caches.delete(sb);
  enCurso.delete(sb);
}

async function releer(sb: SupabaseClient): Promise<CacheCierres> {
  let p = enCurso.get(sb);
  if (!p) {
    p = Promise.all([leerCierresMes(sb), leerCierresMesAvion(sb)])
      .then(([filas, filasAvion]) => {
        const avion = new Map<string, Map<string, CierreAvionLeido>>();
        for (const f of filasAvion) {
          if (f.estado !== 'CERRADO') continue;
          const porId =
            avion.get(f.periodo) ?? new Map<string, CierreAvionLeido>();
          porId.set(f.aeronave_id, f);
          avion.set(f.periodo, porId);
        }
        const c: CacheCierres = {
          leidoMs: ahoraMs(),
          cerrados: new Map(
            filas
              .filter((f) => f.estado === 'CERRADO')
              .map((f) => [f.periodo, f]),
          ),
          avion,
        };
        caches.set(sb, c);
        return c;
      })
      .finally(() => enCurso.delete(sb));
    enCurso.set(sb, p);
  }
  return p;
}

/**
 * Meses CERRADOS ('YYYY-MM' ⇒ fila). Caché ≤ 60 s; `fresco` relee. Sin la
 * migración ⇒ mapa vacío.
 */
export async function cierresCerrados(
  sb: SupabaseClient,
  opts: { fresco?: boolean } = {},
): Promise<Map<string, CierreMesLeido>> {
  const c = caches.get(sb);
  if (!opts.fresco && c && ahoraMs() - c.leidoMs < CIERRES_CACHE_MS) {
    return c.cerrados;
  }
  return (await releer(sb)).cerrados;
}

async function cacheVigente(sb: SupabaseClient): Promise<CacheCierres> {
  const c = caches.get(sb);
  if (!c || ahoraMs() - c.leidoMs >= CIERRES_CACHE_MS) return releer(sb);
  return c;
}

/** ¿Hay que releer un mes PASADO que la caché da por abierto? */
function releerMesPasado(c: CacheCierres, mes: string): boolean {
  return (
    mes < hoyCancun(new Date(ahoraMs())).slice(0, 7) &&
    ahoraMs() - c.leidoMs >= CIERRES_RELECTURA_MS
  );
}

/** El cierre vigente de ese mes, o null si está abierto. */
export async function cierreDeMes(
  sb: SupabaseClient,
  mes: string,
): Promise<CierreMesLeido | null> {
  if (!esMesContable(mes)) return null;
  let c = await cacheVigente(sb);
  let fila = c.cerrados.get(mes) ?? null;
  // Un mes PASADO que la caché da por abierto: otra instancia pudo cerrarlo.
  if (!fila && releerMesPasado(c, mes)) {
    c = await releer(sb);
    fila = c.cerrados.get(mes) ?? null;
  }
  return fila;
}

/**
 * Aviones CERRADOS de ese mes (aeronave_id ⇒ fila), invariante 105. Misma
 * caché y misma relectura de un mes pasado que `cierreDeMes`. Sin la
 * migración por avión ⇒ mapa vacío.
 */
export async function cierresAvionDeMes(
  sb: SupabaseClient,
  mes: string,
): Promise<Map<string, CierreAvionLeido>> {
  if (!esMesContable(mes)) return new Map();
  let c = await cacheVigente(sb);
  let porId = c.avion.get(mes);
  if (!porId && releerMesPasado(c, mes)) {
    c = await releer(sb);
    porId = c.avion.get(mes);
  }
  return porId ?? new Map();
}

/**
 * 409 `MES_CERRADO` armado (fuente única del cuerpo). `aeronave`:
 * `undefined` = sin la migración por avión (details de siempre, byte a
 * byte); `null` = cerrado por la fila GLOBAL (toda la flota); objeto = el
 * avión cuyo cierre rebota la captura («N621TX · Septiembre 2026 ya está
 * cerrado…»).
 */
export function errorMesCerrado(
  cierre: CierreMesLeido,
  registro: RegistroCandado,
  aeronave?: AeronaveCandado | null,
): ConflictException {
  return new ConflictException({
    message: textoMesCerrado({
      periodo: cierre.periodo,
      cerrado_at: cierre.cerrado_at,
      cerrado_por_nombre: cierre.cerrado_por?.nombre ?? null,
      matricula: aeronave?.matricula ?? null,
    }),
    error: CODIGO_MES_CERRADO,
    details: {
      periodo: cierre.periodo,
      cerrado_at: cierre.cerrado_at,
      cerrado_por: cierre.cerrado_por,
      registro,
      ...(aeronave !== undefined ? { aeronave } : {}),
    },
  });
}

/**
 * CANDADO de capturas: si alguno de `meses` está CERRADO (fila global) ⇒
 * 409 `MES_CERRADO`; con `aviones` (invariante 105), también si alguno de
 * esos aviones está CERRADO en ese mes. null/undefined/'' se ignoran (sin
 * fecha ⇒ sin candado). Sin la migración no consulta nada.
 */
export async function assertMesAbierto(
  sb: SupabaseClient,
  meses: string | null | undefined | ReadonlyArray<string | null | undefined>,
  registro: RegistroCandado,
  aviones?: ReadonlyArray<string | null | undefined> | null,
): Promise<void> {
  const lista = (Array.isArray(meses) ? meses : [meses]).filter(
    (m): m is string => esMesContable(m),
  );
  if (lista.length === 0) return;
  if (!(await cierreMesDisponible(sb))) return;
  const porAvion = await cierrePorAvionDisponible(sb);
  const ids = [
    ...new Set(
      (aviones ?? []).filter((a): a is string => typeof a === 'string' && !!a),
    ),
  ];
  for (const mes of [...new Set(lista)].sort()) {
    const cierre = await cierreDeMes(sb, mes);
    if (cierre)
      throw errorMesCerrado(cierre, registro, porAvion ? null : undefined);
    if (!porAvion || ids.length === 0) continue;
    const porId = await cierresAvionDeMes(sb, mes);
    for (const id of ids) {
      const f = porId.get(id);
      if (f) {
        throw errorMesCerrado(f, registro, {
          id: f.aeronave_id,
          matricula: f.matricula,
        });
      }
    }
  }
}

// ===== Mes CONTABLE de los registros que el candado evalúa =====

/** Columnas del vuelo para decidir su mes contable (solo con la migración). */
export const VUELO_MES_CONTABLE_COLS =
  'id, folio, fecha_vuelo, periodo_contable, fecha_contable, aeronave_id, es_externo';

/** El vuelo leído para el candado. */
export interface VueloMesContable {
  id: string;
  folio: number | null;
  fecha_vuelo: string | null;
  periodo_contable: string | null;
  fecha_contable: string | null;
  aeronave_id: string | null;
  es_externo: boolean | null;
}

/**
 * Lee el vuelo para el candado (null si no existe). Sin la migración ⇒ null
 * sin consultar (no hay candado). Un error de lectura LANZA.
 */
export async function leerVueloMesContable(
  sb: SupabaseClient,
  vueloId: string | null | undefined,
): Promise<VueloMesContable | null> {
  if (!vueloId) return null;
  if (!(await cierreMesDisponible(sb))) return null;
  const { data, error } = await sb
    .from('vuelo')
    .select(VUELO_MES_CONTABLE_COLS)
    .eq('id', vueloId)
    .maybeSingle();
  if (error)
    throw new Error(`Candado de mes cerrado (vuelo): ${error.message}`);
  return data ?? null;
}

// ===== Aviones de un vuelo / de un gasto (invariante 105) =====

/** Columnas de `escala` para la participación por avión. */
export const ESCALA_PARTICIPACION_COLS =
  'id, vuelo_id, orden, aeronave_id, cancelada_at, solo_operativa, es_ferry';

/** Lo mínimo del vuelo para saber qué aviones participan. */
export interface VueloParaParticipantes {
  id: string;
  aeronave_id?: string | null;
  es_externo?: boolean | null;
}

/**
 * Aviones PARTICIPANTES (factor > 0 de `participacionPorAeronave`, fuente
 * única del balance por avión y del reparto: tramos vendidos, avión con
 * herencia) de cada vuelo: vuelo_id ⇒ aeronave_id[]. Un vuelo sin tramos
 * resolubles ⇒ su avión principal; un externo sin avión ⇒ []. UNA lectura
 * de `escala` en lotes de 200. Sin la migración por avión ⇒ mapa vacío sin
 * consultar (nadie pasa aviones al candado). Un error de lectura LANZA.
 */
export async function participantesDeVuelos(
  sb: SupabaseClient,
  vuelos: ReadonlyArray<VueloParaParticipantes>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const lista = vuelos.filter((v) => !!v?.id);
  if (lista.length === 0) return out;
  if (!(await cierrePorAvionDisponible(sb))) return out;
  const ids = [...new Set(lista.map((v) => v.id))];
  const escalasPorVuelo = new Map<string, EscalaParticipacionInput[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb
      .from('escala')
      .select(ESCALA_PARTICIPACION_COLS)
      .in('vuelo_id', ids.slice(i, i + 200));
    if (error) {
      throw new Error(`Aviones del vuelo (candado): ${error.message}`);
    }
    for (const e of (data ?? []) as Array<Record<string, unknown>>) {
      const vueloId = str(e.vuelo_id);
      if (!vueloId) continue;
      const l = escalasPorVuelo.get(vueloId) ?? [];
      l.push({
        id: str(e.id),
        orden: e.orden as number | string | null,
        aeronave_id: str(e.aeronave_id),
        cancelada_at: str(e.cancelada_at),
        solo_operativa: e.solo_operativa === true,
        es_ferry: e.es_ferry === true,
      });
      escalasPorVuelo.set(vueloId, l);
    }
  }
  for (const v of lista) {
    const p = participacionPorAeronave(
      { aeronave_id: v.aeronave_id ?? null },
      v.es_externo === true ? [] : (escalasPorVuelo.get(v.id) ?? []),
    );
    const aviones = [...p.factores.entries()]
      .filter(([, f]) => f > 0)
      .map(([id]) => id);
    out.set(
      v.id,
      aviones.length > 0 ? aviones : v.aeronave_id ? [v.aeronave_id] : [],
    );
  }
  return out;
}

/** Aviones participantes de UN vuelo ya leído (`[]` sin la migración por avión). */
export async function avionesDelVueloCandado(
  sb: SupabaseClient,
  v: VueloParaParticipantes | null | undefined,
): Promise<string[]> {
  if (!v) return [];
  return (await participantesDeVuelos(sb, [v])).get(v.id) ?? [];
}

/**
 * CANDADO de un COBRO (alta, edición, baja, sobre de grupo, anticipo
 * aplicado): el mes que se evalúa es SIEMPRE el mes CONTABLE del VUELO
 * (todos los lectores leen los cobros por `vuelo_id`, sin filtro de fecha:
 * un cobro cambia el mes en que cuenta su vuelo, no el de su fecha). Un
 * vuelo diferido a un mes abierto acepta cobros aunque su fecha real sea de
 * un mes cerrado. Con el cierre por avión (invariante 105) los aviones son
 * los PARTICIPANTES del vuelo.
 */
export async function assertCobroEnMesAbierto(
  sb: SupabaseClient,
  vueloIds: string | ReadonlyArray<string>,
): Promise<void> {
  if (!(await cierreMesDisponible(sb))) return;
  const ids = [
    ...new Set(Array.isArray(vueloIds) ? vueloIds : [vueloIds]),
  ].filter((x): x is string => typeof x === 'string' && x !== '');
  const leidos: VueloMesContable[] = [];
  for (const id of ids) {
    const v = await leerVueloMesContable(sb, id);
    if (v) leidos.push(v);
  }
  const participantes = await participantesDeVuelos(sb, leidos);
  for (const v of leidos) {
    await assertMesAbierto(
      sb,
      mesContableDeVuelo(v),
      'cobro',
      participantes.get(v.id),
    );
  }
}

/** Lo mínimo de un gasto para decidir su mes contable. */
export interface GastoParaCandado {
  id?: string | null;
  categoria?: string | null;
  fecha_gasto?: string | null;
  monto?: number | string | null;
  vuelo_id?: string | null;
  aeronave_id?: string | null;
  escala_id?: string | null;
}

/** Lo mínimo del vuelo que el eje del gasto necesita (leído o embebido). */
export type VueloDelCandado = Pick<
  VueloMesContable,
  'fecha_vuelo' | 'aeronave_id' | 'es_externo'
> &
  Partial<Pick<VueloMesContable, 'periodo_contable' | 'fecha_contable'>>;

/**
 * El gasto TAL COMO lo evalúa el candado (PURO, fuente única de la forma):
 * sus columnas de eje + SU vuelo, sin la escala embebida ni repartos (el
 * candado no los lee). La usan `mesCandadoDeGasto` y el renglón
 * `gastos_por_pagar` del pre-cierre (revisión del 19-oct-2026, invariante
 * 93): así el pre-cierre cuenta un gasto por pagar en el MISMO mes que el
 * candado protegería al cerrarse (eje vuelo ⇒ mes contable del vuelo; eje
 * gasto ⇒ `fecha_gasto`). Sin `fecha_contable` en el vuelo (lectura sin la
 * migración del cierre) el eje vuelo usa `fecha_vuelo`.
 */
export function gastoDelCandado(
  g: GastoParaCandado,
  vuelo: VueloDelCandado | null,
): GastoParaMesContable {
  return {
    id: g.id ?? '',
    categoria: g.categoria ?? null,
    fecha_gasto: g.fecha_gasto ?? null,
    monto: g.monto ?? null,
    vuelo_id: g.vuelo_id ?? null,
    aeronave_id: g.aeronave_id ?? null,
    escala_id: g.escala_id ?? null,
    vuelo,
  };
}

/**
 * Mes CONTABLE de un gasto para el candado: el eje de
 * `ubicacionBalanceDeGasto` (invariante 72) — eje VUELO ⇒ mes contable del
 * vuelo (un gasto de un vuelo diferido a un mes abierto se acepta aunque su
 * fecha sea del mes cerrado); eje GASTO (GAS, EMPRESA, sin vuelo, caja chica)
 * ⇒ `fecha_gasto`. Sin la migración ⇒ null (sin candado).
 */
export async function mesCandadoDeGasto(
  sb: SupabaseClient,
  g: GastoParaCandado,
  vueloLeido?: VueloMesContable | null,
): Promise<string | null> {
  if (!(await cierreMesDisponible(sb))) return null;
  const vuelo =
    vueloLeido !== undefined
      ? vueloLeido
      : await leerVueloMesContable(sb, g.vuelo_id ?? null);
  return mesContableDeGasto(gastoDelCandado(g, vuelo));
}

/**
 * Aviones a los que pertenece un GASTO para el candado (regla 5 de la
 * invariante 105): `avionDelGasto` (avión de su ESCALA con herencia ⇒ avión
 * sellado ⇒ avión principal del vuelo) + los aviones de sus partes de
 * reparto manual (`gasto_reparto`). `[]` = gasto sin avión (solo la fila
 * global). Sin la migración por avión ⇒ `[]` sin consultar.
 */
export async function avionesDeGastoCandado(
  sb: SupabaseClient,
  g: GastoParaCandado,
  vuelo: VueloDelCandado | null,
): Promise<string[]> {
  if (!(await cierrePorAvionDisponible(sb))) return [];
  const escalaPorId = new Map<string, { aeronave_id?: string | null }>();
  if (g.escala_id) {
    const { data, error } = await sb
      .from('escala')
      .select('id, aeronave_id')
      .eq('id', g.escala_id)
      .maybeSingle();
    if (error) {
      throw new Error(`Avión del gasto (candado): ${error.message}`);
    }
    if (data) {
      escalaPorId.set(g.escala_id, {
        aeronave_id: str((data as Record<string, unknown>).aeronave_id),
      });
    }
  }
  const aviones = new Set<string>();
  const propio = avionDelGasto(g, escalaPorId, vuelo?.aeronave_id ?? null);
  if (propio) aviones.add(propio);
  if (g.id) {
    const { data, error } = await sb
      .from('gasto_reparto')
      .select('aeronave_id')
      .eq('gasto_id', g.id);
    if (error) {
      throw new Error(`Reparto del gasto (candado): ${error.message}`);
    }
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const id = str(r.aeronave_id);
      if (id) aviones.add(id);
    }
  }
  return [...aviones];
}

/**
 * Candado de UN gasto (estado antes y/o después). `esReplay` (alta con
 * llave de idempotencia): si el mes está cerrado PERO la llave ya creó el
 * gasto, no rebota — el alta devuelve el existente (un reintento del
 * outbox jamás se vuelve «fallido» por un cierre posterior). Con el cierre
 * por avión (invariante 105) cada estado del gasto se evalúa con SUS
 * aviones (`avionesDeGastoCandado`).
 */
export async function assertGastoEnMesAbierto(
  sb: SupabaseClient,
  gastos: ReadonlyArray<GastoParaCandado | null | undefined>,
  esReplay?: () => Promise<boolean>,
): Promise<void> {
  if (!(await cierreMesDisponible(sb))) return;
  const porAvion = await cierrePorAvionDisponible(sb);
  const evaluados: Array<{ mes: string; aviones: string[] | undefined }> = [];
  for (const g of gastos) {
    if (!g) continue;
    const vuelo = await leerVueloMesContable(sb, g.vuelo_id ?? null);
    const m = await mesCandadoDeGasto(sb, g, vuelo);
    if (!m) continue;
    evaluados.push({
      mes: m,
      aviones: porAvion ? await avionesDeGastoCandado(sb, g, vuelo) : undefined,
    });
  }
  try {
    if (!porAvion) {
      await assertMesAbierto(
        sb,
        evaluados.map((e) => e.mes),
        'gasto',
      );
      return;
    }
    for (const e of [...evaluados].sort((a, b) => a.mes.localeCompare(b.mes))) {
      await assertMesAbierto(sb, e.mes, 'gasto', e.aviones);
    }
  } catch (e) {
    if (esReplay && (await esReplay())) return;
    throw e;
  }
}

// ===== Bloques `cierre` de los LIBROS con el cierre por avión (invariante 105) =====

/**
 * `aviones[].cierre_avion` del reparto (y `cierre_avion` de la pantalla por
 * avión; mismo shape en el payload del PDF/XLSX). SIEMPRE viaja con la
 * migración por avión ('ABIERTO' por defecto).
 */
export interface CierreAvionBloque {
  estado: EstadoCierreMes | 'ABIERTO';
  cerrado_at: string | null;
  cerrado_por_nombre: string | null;
  reabierto_at: string | null;
  reabierto_por_nombre: string | null;
  version: number | null;
  /** Saldo de hoy vs el guardado al cerrar ese avión (±0.01); null abierto. */
  coincide_con_snapshot: boolean | null;
}

/** Estado de la flota en un mes para los bloques `cierre` de los libros. */
export interface ResumenCierreFlota {
  /** La fila global (derivada) del mes. */
  global: CierreMesLeido | null;
  /** Filas `cierre_mes_avion` del mes (todas: CERRADO y REABIERTO). */
  filasAvion: CierreAvionLeido[];
  /** Flota activa (id ⇒ matrícula), orden de matrícula. */
  activos: Array<{ id: string; matricula: string }>;
  estado: EstadoMesFlota;
  /** El «M» de «N de M». */
  aviones_activos: number;
  /** Matrículas de los aviones CERRADOS del mes (activos o no), orden de matrícula. */
  aviones_cerrados: string[];
  /**
   * Vuelos «se queda» decididos por aviones CERRADOS del mes
   * (`totales.incluidos[]`): vuelo_id ⇒ el avión que DECIDIÓ (regla 2 de la
   * invariante 105: el primero que cerró).
   */
  decididos: Map<string, { aeronave_id: string; matricula: string | null }>;
}

/**
 * Resumen de la flota en `mes` para los libros (reparto, pre-cierre,
 * balances, Libro Dinero): estado DERIVADO (`estadoMesDerivado`),
 * `aviones_activos`, `aviones_cerrados` y las filas por avión. `null` sin la
 * migración por avión (los libros responden como el 0.0.103). Un error de
 * lectura LANZA.
 */
export async function resumenCierreFlota(
  sb: SupabaseClient,
  mes: string,
  global: CierreMesLeido | null,
): Promise<ResumenCierreFlota | null> {
  if (!esMesContable(mes)) return null;
  if (!(await cierrePorAvionDisponible(sb))) return null;
  const [filasTodas, aeronaves] = await Promise.all([
    leerCierresMesAvion(sb),
    sb
      .from('aeronave')
      .select('id, matricula, activa')
      .order('matricula', { ascending: true }),
  ]);
  if (aeronaves.error) {
    throw new Error(`Aeronaves (cierre por avión): ${aeronaves.error.message}`);
  }
  const activos = ((aeronaves.data ?? []) as Array<Record<string, unknown>>)
    .filter((a) => a.activa !== false)
    .map((a) => ({
      id: String(a.id),
      matricula: typeof a.matricula === 'string' ? a.matricula : '',
    }))
    .sort((a, b) => a.matricula.localeCompare(b.matricula, 'es'));
  const filasAvion = filasTodas.filter((f) => f.periodo === mes);
  const decididos = new Map<
    string,
    { aeronave_id: string; matricula: string | null }
  >();
  const cerradas = filasAvion
    .filter((f) => f.estado === 'CERRADO')
    .sort((a, b) => (a.cerrado_at ?? '').localeCompare(b.cerrado_at ?? ''));
  for (const f of cerradas) {
    const inc = Array.isArray(f.totales?.incluidos)
      ? (f.totales?.incluidos as Array<Record<string, unknown>>)
      : [];
    for (const i of inc) {
      const id = typeof i?.id === 'string' ? i.id : null;
      if (!id || decididos.has(id)) continue;
      // Quien heredó la decisión (`decidido_por`) no es quien decidió.
      const heredado =
        i.decidido_por && typeof i.decidido_por === 'object'
          ? (i.decidido_por as { aeronave_id?: unknown; matricula?: unknown })
          : null;
      decididos.set(id, {
        aeronave_id:
          typeof heredado?.aeronave_id === 'string'
            ? heredado.aeronave_id
            : f.aeronave_id,
        matricula:
          typeof heredado?.matricula === 'string'
            ? heredado.matricula
            : f.matricula,
      });
    }
  }
  return {
    global,
    filasAvion,
    activos,
    estado: estadoMesDerivado({ global, aviones: filasAvion }),
    aviones_activos: activos.length,
    aviones_cerrados: filasAvion
      .filter((f) => f.estado === 'CERRADO')
      .map((f) => f.matricula ?? f.aeronave_id)
      .sort((a, b) => a.localeCompare(b, 'es')),
    decididos,
  };
}

/**
 * `cierre_avion` de UN avión: su fila; sin fila, CERRADO si la flota está
 * cerrada (fila global CERRADO) o ABIERTO. `coincide` lo pone el libro
 * (compara su saldo de hoy con `totales.saldo_usd` de la fila).
 */
export function bloqueCierreAvion(
  fa: CierreAvionLeido | null,
  global: CierreMesLeido | null,
  coincide: boolean | null = null,
): CierreAvionBloque {
  if (fa) {
    return {
      estado: fa.estado,
      cerrado_at: fa.cerrado_at,
      cerrado_por_nombre: fa.cerrado_por?.nombre ?? null,
      reabierto_at: fa.reabierto_at,
      reabierto_por_nombre: fa.reabierto_por?.nombre ?? null,
      version: fa.version,
      coincide_con_snapshot: fa.estado === 'CERRADO' ? coincide : null,
    };
  }
  if (global?.estado === 'CERRADO') {
    return {
      estado: 'CERRADO',
      cerrado_at: global.cerrado_at,
      cerrado_por_nombre: global.cerrado_por?.nombre ?? null,
      reabierto_at: null,
      reabierto_por_nombre: null,
      version: global.version,
      coincide_con_snapshot: coincide,
    };
  }
  return {
    estado: 'ABIERTO',
    cerrado_at: null,
    cerrado_por_nombre: null,
    reabierto_at: null,
    reabierto_por_nombre: null,
    version: null,
    coincide_con_snapshot: null,
  };
}

/** ¿Coincide el saldo de hoy con el guardado al cerrar ese avión? (±0.01) */
export function coincideSaldoAvion(
  fa: CierreAvionLeido | null,
  saldoHoyUsd: number,
): boolean | null {
  if (!fa || fa.estado !== 'CERRADO') return null;
  const g = Number(fa.totales?.saldo_usd);
  if (!Number.isFinite(g)) return null;
  return (
    Math.abs(Math.round(saldoHoyUsd * 100) / 100 - Math.round(g * 100) / 100) <=
    0.01
  );
}

/** Columnas de la bitácora LEGADA `cierre_mes_vuelo` (cierre de toda la flota). */
const BITACORA_LEGADA_COLS =
  'vuelo_id, periodo_origen, periodo_destino, folio, cliente, aeronave_id, matricula, venta_usd, cobrado_usd, por_cobrar_usd, motivo, created_at';

/** Columnas de la bitácora VIVA `cierre_mes_avion_vuelo` (invariante 105). */
export const BITACORA_AVION_COLS =
  'vuelo_id, aeronave_id, periodo_origen, periodo_destino, folio, cliente, vuelo_aeronave_id, matricula, venta_usd, cobrado_usd, por_cobrar_usd, motivo, created_at';

function diferimientoDe(
  f: Record<string, unknown>,
  porAvion: boolean,
): DiferimientoVuelo | null {
  const origen = mesDePeriodo(str(f.periodo_origen));
  const destino = mesDePeriodo(str(f.periodo_destino));
  if (!origen || !destino) return null;
  return {
    vuelo_id: String(f.vuelo_id),
    origen,
    destino,
    folio: f.folio == null ? null : Number(f.folio),
    cliente: str(f.cliente),
    aeronave_id: porAvion
      ? (str(f.vuelo_aeronave_id) ?? str(f.aeronave_id))
      : str(f.aeronave_id),
    matricula: str(f.matricula),
    venta_usd: Number(f.venta_usd) || 0,
    cobrado_usd: Number(f.cobrado_usd) || 0,
    por_cobrar_usd: Number(f.por_cobrar_usd) || 0,
    motivo:
      f.motivo === 'COBRO_PARCIAL' || f.motivo === 'COBRO_POSTERIOR'
        ? f.motivo
        : 'SIN_COBRO',
    ...(porAvion ? { cierre_aeronave_id: str(f.aeronave_id) } : {}),
  };
}

/**
 * Diferimientos VIGENTES (`revertido_at is null`) de esos vuelos. Bitácora
 * LEGADA `cierre_mes_vuelo` (cierres de toda la flota anteriores a la
 * invariante 105; sin filas en prod) ∪, con la migración por avión, la
 * bitácora VIVA `cierre_mes_avion_vuelo` (cada fila dice qué avión cerró:
 * `cierre_aeronave_id`). Sin la migración o sin ids ⇒ `[]`. Un error de
 * lectura LANZA (los libros no se pintan con marcas inventadas).
 */
export async function leerDiferimientos(
  sb: SupabaseClient,
  vueloIds: ReadonlyArray<string>,
): Promise<DiferimientoVuelo[]> {
  const ids = [...new Set(vueloIds.filter(Boolean))];
  if (ids.length === 0) return [];
  if (!(await cierreMesDisponible(sb))) return [];
  const porAvion = await cierrePorAvionDisponible(sb);
  const out: Array<{ d: DiferimientoVuelo; creado: string }> = [];
  const leer = async (tabla: string, cols: string, avion: boolean) => {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb
        .from(tabla)
        .select(cols)
        .in('vuelo_id', ids.slice(i, i + 200))
        .is('revertido_at', null)
        .order('created_at', { ascending: true });
      if (error) throw new Error(`Diferimientos del cierre: ${error.message}`);
      for (const f of (data ?? []) as unknown as Array<
        Record<string, unknown>
      >) {
        const d = diferimientoDe(f, avion);
        if (d) out.push({ d, creado: str(f.created_at) ?? '' });
      }
    }
  };
  await leer('cierre_mes_vuelo', BITACORA_LEGADA_COLS, false);
  if (!porAvion) return out.map((x) => x.d);
  await leer('cierre_mes_avion_vuelo', BITACORA_AVION_COLS, true);
  return out.sort((a, b) => a.creado.localeCompare(b.creado)).map((x) => x.d);
}
