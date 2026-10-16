/**
 * LECTOR ÚNICO de los CIERRES DE MES y CANDADO 409 `MES_CERRADO`
 * (16-oct-2026, API 0.0.88, invariante 89, migración `20261016000004`).
 *
 * - `leerCierresMes(sb)`: las filas de `cierre_mes` (pocas: una por mes desde
 *   el inicio oficial) con el NOMBRE de quien cerró / reabrió. Sin la
 *   migración ⇒ `[]` sin consultar la tabla (sonda `cierreMesDisponible`).
 * - `cierresCerrados(sb)`: los meses con `estado = 'CERRADO'` (la ÚNICA verdad
 *   de «mes cerrado»), con caché ≤ 60 s por cliente Supabase. Un mes PASADO
 *   que la caché da por abierto se relee si la caché tiene > 10 s (otra
 *   instancia del API pudo cerrarlo: el peor caso real es 10 s, no 60).
 *   `olvidarCierres(sb)` la invalida (cerrar / reabrir del mismo proceso).
 * - `assertMesAbierto(sb, meses, registro)`: el CANDADO de capturas. Cada mes
 *   'YYYY-MM' (null/undefined ⇒ no bloquea) cerrado ⇒ 409
 *   `{ message: textoMesCerrado, error: 'MES_CERRADO', details: { periodo,
 *   cerrado_at, cerrado_por: {id, nombre}, registro } }`. Sin la migración no
 *   hay candado (nada puede estar cerrado). Un fallo de LECTURA del candado
 *   SUBE (nunca se deja pasar una captura «a ciegas» sobre un mes que podría
 *   estar cerrado).
 *
 * Es función (no servicio Nest) a propósito: lo llaman gastos, cobros,
 * ingresos, caja chica, entregas a socios, cotizaciones y grupos sin tocar
 * sus constructores ni crear ciclos de módulos (patrón `columnaOpcional`).
 */
import { ConflictException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cierreMesDisponible } from './cierre-mes-disponible.util';
import { hoyCancun } from './fecha-cancun.util';
import {
  type DiferimientoVuelo,
  esMesContable,
  mesContableDeGasto,
  mesContableDeVuelo,
  mesDePeriodo,
  textoMesCerrado,
} from './mes-contable.util';
import { fetchNombresUsuarios } from './registrado-por.util';

/** Estados persistidos de `cierre_mes`. */
export type EstadoCierreMes = 'CERRADO' | 'REABIERTO';

/** Columnas de `cierre_mes` que leen el estado y el candado (sin snapshots). */
export const CIERRE_MES_COLS =
  'periodo, estado, cerrado_at, cerrado_por, reabierto_at, reabierto_por, reabierto_motivo, version, totales, updated_at';

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

/** Registro cuya captura se evalúa contra el candado. */
export type RegistroCandado =
  | 'gasto'
  | 'cobro'
  | 'ingreso'
  | 'caja_chica'
  | 'entrega_socio'
  | 'cotizacion'
  | 'vuelo';

/** Código del 409. */
export const CODIGO_MES_CERRADO = 'MES_CERRADO';

/** Vida de la caché de meses cerrados. */
export const CIERRES_CACHE_MS = 60_000;
/** Antigüedad a partir de la cual un mes pasado «abierto» se relee. */
export const CIERRES_RELECTURA_MS = 10_000;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

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
  const nombres = await fetchNombresUsuarios(
    sb,
    filas.flatMap((f) => [str(f.cerrado_por), str(f.reabierto_por)]),
  );
  const usuario = (id: unknown): UsuarioCierre | null => {
    const s = str(id);
    return s ? { id: s, nombre: nombres.get(s) ?? 'la oficina' } : null;
  };
  const out: CierreMesLeido[] = [];
  for (const f of filas) {
    const periodo = mesDePeriodo(str(f.periodo));
    if (!periodo || !esMesContable(periodo)) continue;
    out.push({
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
    });
  }
  return out;
}

// ===== Caché de meses CERRADOS (candado) =====

interface CacheCierres {
  leidoMs: number;
  cerrados: Map<string, CierreMesLeido>;
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
    p = leerCierresMes(sb)
      .then((filas) => {
        const c: CacheCierres = {
          leidoMs: ahoraMs(),
          cerrados: new Map(
            filas
              .filter((f) => f.estado === 'CERRADO')
              .map((f) => [f.periodo, f]),
          ),
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

/** El cierre vigente de ese mes, o null si está abierto. */
export async function cierreDeMes(
  sb: SupabaseClient,
  mes: string,
): Promise<CierreMesLeido | null> {
  if (!esMesContable(mes)) return null;
  let c = caches.get(sb);
  if (!c || ahoraMs() - c.leidoMs >= CIERRES_CACHE_MS) c = await releer(sb);
  let fila = c.cerrados.get(mes) ?? null;
  // Un mes PASADO que la caché da por abierto: otra instancia pudo cerrarlo.
  if (
    !fila &&
    mes < hoyCancun(new Date(ahoraMs())).slice(0, 7) &&
    ahoraMs() - c.leidoMs >= CIERRES_RELECTURA_MS
  ) {
    c = await releer(sb);
    fila = c.cerrados.get(mes) ?? null;
  }
  return fila;
}

/** 409 `MES_CERRADO` armado (fuente única del cuerpo). */
export function errorMesCerrado(
  cierre: CierreMesLeido,
  registro: RegistroCandado,
): ConflictException {
  return new ConflictException({
    message: textoMesCerrado({
      periodo: cierre.periodo,
      cerrado_at: cierre.cerrado_at,
      cerrado_por_nombre: cierre.cerrado_por?.nombre ?? null,
    }),
    error: CODIGO_MES_CERRADO,
    details: {
      periodo: cierre.periodo,
      cerrado_at: cierre.cerrado_at,
      cerrado_por: cierre.cerrado_por,
      registro,
    },
  });
}

/**
 * CANDADO de capturas: si alguno de `meses` está CERRADO ⇒ 409
 * `MES_CERRADO`. null/undefined/'' se ignoran (sin fecha ⇒ sin candado).
 * Sin la migración no consulta nada.
 */
export async function assertMesAbierto(
  sb: SupabaseClient,
  meses: string | null | undefined | ReadonlyArray<string | null | undefined>,
  registro: RegistroCandado,
): Promise<void> {
  const lista = (Array.isArray(meses) ? meses : [meses]).filter(
    (m): m is string => esMesContable(m),
  );
  if (lista.length === 0) return;
  if (!(await cierreMesDisponible(sb))) return;
  for (const mes of [...new Set(lista)].sort()) {
    const cierre = await cierreDeMes(sb, mes);
    if (cierre) throw errorMesCerrado(cierre, registro);
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

/**
 * CANDADO de un COBRO (alta, edición, baja, sobre de grupo, anticipo
 * aplicado): el mes que se evalúa es SIEMPRE el mes CONTABLE del VUELO
 * (todos los lectores leen los cobros por `vuelo_id`, sin filtro de fecha:
 * un cobro cambia el mes en que cuenta su vuelo, no el de su fecha). Un
 * vuelo diferido a un mes abierto acepta cobros aunque su fecha real sea de
 * un mes cerrado.
 */
export async function assertCobroEnMesAbierto(
  sb: SupabaseClient,
  vueloIds: string | ReadonlyArray<string>,
): Promise<void> {
  if (!(await cierreMesDisponible(sb))) return;
  const ids = [
    ...new Set(Array.isArray(vueloIds) ? vueloIds : [vueloIds]),
  ].filter((x): x is string => typeof x === 'string' && x !== '');
  for (const id of ids) {
    const v = await leerVueloMesContable(sb, id);
    await assertMesAbierto(sb, mesContableDeVuelo(v), 'cobro');
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
  return mesContableDeGasto({
    id: g.id ?? '',
    categoria: g.categoria ?? null,
    fecha_gasto: g.fecha_gasto ?? null,
    monto: g.monto ?? null,
    vuelo_id: g.vuelo_id ?? null,
    aeronave_id: g.aeronave_id ?? null,
    escala_id: g.escala_id ?? null,
    vuelo,
  });
}

/**
 * Candado de UN gasto (estado antes y/o después). `esReplay` (alta con
 * llave de idempotencia): si el mes está cerrado PERO la llave ya creó el
 * gasto, no rebota — el alta devuelve el existente (un reintento del
 * outbox jamás se vuelve «fallido» por un cierre posterior).
 */
export async function assertGastoEnMesAbierto(
  sb: SupabaseClient,
  gastos: ReadonlyArray<GastoParaCandado | null | undefined>,
  esReplay?: () => Promise<boolean>,
): Promise<void> {
  if (!(await cierreMesDisponible(sb))) return;
  const meses: string[] = [];
  for (const g of gastos) {
    if (!g) continue;
    const m = await mesCandadoDeGasto(sb, g);
    if (m) meses.push(m);
  }
  try {
    await assertMesAbierto(sb, meses, 'gasto');
  } catch (e) {
    if (esReplay && (await esReplay())) return;
    throw e;
  }
}

/**
 * Diferimientos VIGENTES (`revertido_at is null`) de esos vuelos, de la
 * bitácora `cierre_mes_vuelo`. Sin la migración o sin ids ⇒ `[]`. Un error
 * de lectura LANZA (los libros no se pintan con marcas inventadas).
 */
export async function leerDiferimientos(
  sb: SupabaseClient,
  vueloIds: ReadonlyArray<string>,
): Promise<DiferimientoVuelo[]> {
  const ids = [...new Set(vueloIds.filter(Boolean))];
  if (ids.length === 0) return [];
  if (!(await cierreMesDisponible(sb))) return [];
  const out: DiferimientoVuelo[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb
      .from('cierre_mes_vuelo')
      .select(
        'vuelo_id, periodo_origen, periodo_destino, folio, cliente, aeronave_id, matricula, venta_usd, cobrado_usd, por_cobrar_usd, motivo, created_at',
      )
      .in('vuelo_id', ids.slice(i, i + 200))
      .is('revertido_at', null)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`Diferimientos del cierre: ${error.message}`);
    for (const f of (data ?? []) as Array<Record<string, unknown>>) {
      const origen = mesDePeriodo(str(f.periodo_origen));
      const destino = mesDePeriodo(str(f.periodo_destino));
      if (!origen || !destino) continue;
      out.push({
        vuelo_id: String(f.vuelo_id),
        origen,
        destino,
        folio: f.folio == null ? null : Number(f.folio),
        cliente: str(f.cliente),
        aeronave_id: str(f.aeronave_id),
        matricula: str(f.matricula),
        venta_usd: Number(f.venta_usd) || 0,
        cobrado_usd: Number(f.cobrado_usd) || 0,
        por_cobrar_usd: Number(f.por_cobrar_usd) || 0,
        motivo:
          f.motivo === 'COBRO_PARCIAL' || f.motivo === 'COBRO_POSTERIOR'
            ? f.motivo
            : 'SIN_COBRO',
      });
    }
  }
  return out;
}
