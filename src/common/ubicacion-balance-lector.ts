/**
 * LECTOR COMPARTIDO de «¿en qué libro y en qué mes vive este gasto?»
 * (invariantes 72 y 82). La REGLA es `ubicacionBalanceDeGasto` (PURA,
 * fuente única); aquí solo vive la LECTURA en lote que la alimenta, mudada
 * SIN cambio de conducta de `ConciliacionService.anotarUbicacionBalance`
 * (15-oct-2026) para que Caja chica (`getFondoDetail`) la reuse:
 *  - gastos con `GASTO_UBICACION_COLS` (embeds por COLUMNA) y sus repartos
 *    (`fetchRepartos`): lecturas PRINCIPALES — si cualquiera falla ⇒ null
 *    (el llamador no anota NADA: sin la llave el panel no pinta enlaces);
 *  - escalas VIVAS solo de los gastos que lo necesitan
 *    (`necesitaTramosVivos`, caso #255): best-effort, si falla no se
 *    verifica;
 *  - matrículas: COSMÉTICAS, si fallan `matricula: null`.
 * Lotes `in (…)` de ≤ 200 ids sin repetidos (como `leerPorLotes`). Nunca
 * lanza. Un gasto que no volvió en la lectura NO está en el mapa (el
 * llamador lo deja sin la llave); null en el mapa = no vive en ningún libro.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { cierreMesDisponible } from './cierre-mes-disponible.util';
import { fetchRepartos, type GastoRepartoFila } from './gasto-reparto.util';
import {
  necesitaTramosVivos,
  ubicacionBalanceDeGasto,
  type GastoParaUbicacion,
  type HojaLibroAvion,
  type HojaLibroGeneral,
  type UbicacionBalanceGasto,
} from './ubicacion-balance-gasto.util';

/**
 * Lo que necesita `ubicacionBalanceDeGasto`, en una lectura PROPIA (nunca en
 * el select principal del llamador: un embed rechazado lo tumbaría). Embeds
 * en la forma por COLUMNA que ya corre en prod (`pendienteGasSinAvion`).
 */
export const GASTO_UBICACION_COLS =
  'id, categoria, fecha_gasto, monto, vuelo_id, aeronave_id, escala_id, inventario_movimiento_id, escala:escala_id(aeronave_id), vuelo:vuelo_id(fecha_vuelo, aeronave_id, es_externo)';

/**
 * CIERRE DE MES (16-oct-2026, invariante 89): con la migración
 * `20261016000004` el embed del vuelo trae además `fecha_contable` (el mes
 * contable: un vuelo diferido arrastra sus gastos de eje vuelo al mes
 * destino). Sin ella, `GASTO_UBICACION_COLS` tal cual (0.0.87).
 */
export const GASTO_UBICACION_COLS_CONTABLE =
  'id, categoria, fecha_gasto, monto, vuelo_id, aeronave_id, escala_id, inventario_movimiento_id, escala:escala_id(aeronave_id), vuelo:vuelo_id(fecha_vuelo, aeronave_id, es_externo, periodo_contable, fecha_contable)';

/** Columnas de la lectura según la sonda del cierre de mes. */
export function gastoUbicacionCols(cierreDisponible: boolean): string {
  return cierreDisponible
    ? GASTO_UBICACION_COLS_CONTABLE
    : GASTO_UBICACION_COLS;
}

/** Tamaño de lote de las lecturas `in (…)` (el de `leerPorLotes`). */
export const LOTE_UBICACION_BALANCE = 200;

/** Un avión del enlace (matrícula cosmética: null si no se pudo leer). */
export interface AvionBalanceGasto {
  id: string;
  matricula: string | null;
}

/**
 * El campo `balance` que ven los clientes (Conciliación y Caja chica):
 * la ubicación de la regla con los aviones ya como `{id, matricula}`,
 * ordenados por matrícula (null al final).
 */
export interface BalanceDeGasto {
  periodo: UbicacionBalanceGasto['periodo'];
  eje: UbicacionBalanceGasto['eje'];
  aviones: AvionBalanceGasto[];
  general: boolean;
  hoja_avion: HojaLibroAvion | null;
  hoja_general: HojaLibroGeneral | null;
}

/** Lo mínimo de un logger de Nest (`warn`). */
export interface LoggerUbicacionBalance {
  warn(mensaje: string): void;
}

type Consulta = PromiseLike<{
  data: unknown[] | null;
  error: { message: string } | null;
}>;

const msgDe = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** `in (…)` en lotes de ≤ `LOTE_UBICACION_BALANCE` ids; un error se LANZA. */
async function porLotes(
  ids: ReadonlyArray<string>,
  consulta: (lote: string[]) => Consulta,
): Promise<Array<Record<string, unknown>>> {
  const unicos = [...new Set(ids.filter(Boolean))];
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < unicos.length; i += LOTE_UBICACION_BALANCE) {
    const { data, error } = await consulta(
      unicos.slice(i, i + LOTE_UBICACION_BALANCE),
    );
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  return out;
}

/**
 * Ubicación en el balance de cada gasto de `gastoIds`, en lote. Devuelve
 * null si falló una lectura PRINCIPAL (gastos o repartos; deja un warn
 * «`etiqueta` sin enlaces al balance …»); si no, el mapa id ⇒ `balance`.
 *
 * INICIO OFICIAL (invariante 86): con `inicio`, un gasto cuyo libro es de un
 * mes que TERMINA antes del inicio sale con `balance: null` (no vive en un
 * libro que se pueda abrir: el reporte de ese periodo responde 400
 * PERIODO_ANTES_DEL_INICIO). Sin `inicio` ⇒ conducta de siempre.
 */
export async function leerUbicacionBalance(
  sb: SupabaseClient,
  gastoIds: ReadonlyArray<string>,
  logger: LoggerUbicacionBalance,
  etiqueta = 'Conciliación',
  inicio: string | null = null,
): Promise<Map<string, BalanceDeGasto | null> | null> {
  const ids = [
    ...new Set(gastoIds.filter((x) => typeof x === 'string' && x !== '')),
  ];
  const out = new Map<string, BalanceDeGasto | null>();
  if (ids.length === 0) return out;
  let gastos: GastoParaUbicacion[];
  let repartos: Map<string, GastoRepartoFila[]>;
  try {
    const cols = gastoUbicacionCols(await cierreMesDisponible(sb));
    const [filasGasto, deReparto] = await Promise.all([
      porLotes(ids, (lote) => sb.from('gasto').select(cols).in('id', lote)),
      fetchRepartos(sb, ids),
    ]);
    gastos = filasGasto as unknown as GastoParaUbicacion[];
    repartos = deReparto;
  } catch (err) {
    logger.warn(
      `${etiqueta} sin enlaces al balance (lectura de gastos o repartos): ${msgDe(err)}`,
    );
    return null;
  }
  // Escalas VIVAS solo de los vuelos que lo necesitan (caso #255).
  const verificar = gastos.filter((g) => necesitaTramosVivos(g));
  let tramosVivos: Map<string, string[]> | null = null;
  if (verificar.length > 0) {
    try {
      const vueloIds = [...new Set(verificar.map((g) => g.vuelo_id as string))];
      const escalas = await porLotes(vueloIds, (lote) =>
        sb
          .from('escala')
          .select('vuelo_id, aeronave_id')
          .in('vuelo_id', lote)
          .is('cancelada_at', null),
      );
      tramosVivos = new Map(vueloIds.map((v) => [v, [] as string[]]));
      for (const e of escalas) {
        if (typeof e.aeronave_id !== 'string') continue;
        tramosVivos.get(e.vuelo_id as string)?.push(e.aeronave_id);
      }
    } catch (err) {
      logger.warn(
        `Enlaces al balance sin verificar tramos vivos: ${msgDe(err)}`,
      );
      tramosVivos = null;
    }
  }
  const ubicacion = new Map<string, UbicacionBalanceGasto | null>();
  for (const g of gastos) {
    if (typeof g.id !== 'string') continue;
    const conTramos =
      tramosVivos && g.vuelo_id && necesitaTramosVivos(g)
        ? {
            ...g,
            aviones_con_tramo_vivo: tramosVivos.get(g.vuelo_id) ?? [],
          }
        : g;
    ubicacion.set(
      g.id,
      ubicacionBalanceDeGasto(
        conTramos,
        (repartos.get(g.id) ?? []).map((r) => ({
          aeronave_id: r.aeronave_id,
          monto: r.monto,
        })),
      ),
    );
  }
  // Matrículas: COSMÉTICAS (si fallan, null; jamás se quita `balance`).
  const avionIds = [
    ...new Set([...ubicacion.values()].flatMap((u) => (u ? u.aviones : []))),
  ];
  const matriculas = new Map<string, string>();
  if (avionIds.length > 0) {
    try {
      const aviones = await porLotes(avionIds, (lote) =>
        sb.from('aeronave').select('id, matricula').in('id', lote),
      );
      for (const a of aviones) {
        if (typeof a.id === 'string' && typeof a.matricula === 'string') {
          matriculas.set(a.id, a.matricula);
        }
      }
    } catch (err) {
      logger.warn(`Enlaces al balance sin matrículas: ${msgDe(err)}`);
    }
  }
  for (const [id, ubic] of ubicacion) {
    const u = ubic && inicio && ubic.periodo.hasta < inicio ? null : ubic;
    out.set(
      id,
      u
        ? {
            periodo: u.periodo,
            eje: u.eje,
            aviones: u.aviones
              .map((a) => ({ id: a, matricula: matriculas.get(a) ?? null }))
              .sort((x, y) =>
                x.matricula == null
                  ? y.matricula == null
                    ? 0
                    : 1
                  : y.matricula == null
                    ? -1
                    : x.matricula.localeCompare(y.matricula),
              ),
            general: u.general,
            hoja_avion: u.hoja_avion,
            hoja_general: u.hoja_general,
          }
        : null,
    );
  }
  return out;
}
