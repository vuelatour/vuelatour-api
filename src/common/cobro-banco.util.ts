/**
 * UN COBRO, VARIOS ABONOS: «CONCILIADO» = CUBIERTO (14-oct-2026, API 0.0.78,
 * invariante 77, migración `20261014000003`). Helpers PUROS (sin I/O): el
 * ESPEJO TS de lo que la BD decide para un cobro de vuelo contra los abonos
 * del banco —`neto_de_cobro`, `regla_cobro_cubierto`, la vista
 * `v_cobro_conciliacion` y el trigger A por cobro— para que TODO lector
 * (card del vuelo, Conciliación, «Cobros sin banco», Ingresos, Excel) diga
 * el MISMO estado sin leer la vista: el API calcula desde la puente
 * `movimiento_bancario_cobro` (20261012000002), así sus lecturas funcionan
 * ANTES de aplicar la migración (spec de paridad que lee el archivo SQL:
 * `cobro-banco.paridad.spec.ts`).
 *
 * Reglas (las de la BD, una por una):
 * - NETO = round(monto − comisión bancaria capturada, 2) si la comisión es
 *   > 0 y el resultado es positivo; si no, round(monto, 2).
 * - CUBIERTO (CASE ordenado, = `regla_cobro_cubierto`): algún abono en OTRA
 *   moneda ⇒ sí; sin abonos ⇒ no; neto ≤ 0 ⇒ sí; si no, Σ partes de SU
 *   moneda + 1e-6 ≥ neto − 1.00 (`TOLERANCIA_COBRO_BANCO`, la misma de
 *   `regla_gasto_cubierto`).
 * - Estados por cobro: CONCILIADO (cubierto, o vía su sobre) · PARCIAL (con
 *   abonos directos y sin cubrir) · VIA_ANTICIPO · SIN_CONCILIAR (método
 *   bancario sin abonos) · NO_BANCARIO. El `conciliado` de siempre =
 *   CONCILIADO o VIA_ANTICIPO: un PARCIAL ya no dice «Conciliado».
 *
 * La REGLA vive en la BD (trigger A, RPC G, candados D/E/K); esto es su
 * espejo para responder 409 claros ANTES de escribir y para anotar cada
 * cobro. No hay otro cálculo de neto / Σ / faltante de un cobro contra el
 * banco: quien lo necesite importa de aquí (regla de fuentes únicas).
 */
import type { ViaConciliacion } from './cobro-conciliado.util';
import {
  METODOS_COBRO_ABONO_AUTO,
  METODOS_COBRO_PASARELA,
} from './metodo-cobro.util';
import { redondearA } from './redondeo.util';
import { normalizarTc, round6 } from './tc.util';

/** Tolerancia de «cubierto» (= el 1.00 de `regla_cobro_cubierto` y de A; = `TOLERANCIA_CONCILIACION` de gastos). */
export const TOLERANCIA_COBRO_BANCO = 1.0;

/** Banda del T.C. implícito de un abono en OTRA moneda (= la del trigger A). */
export const TC_COBRO_MIN = 15;
export const TC_COBRO_MAX = 25;

/** El `+ 0.000001` de las comparaciones de la BD (absorbe el error de punto flotante). */
export const EPSILON_COBRO_BANCO = 0.000001;

/** Redondeo a centavos (la mecánica de siempre de conciliación). */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(v: unknown): number {
  return Number(v) || 0;
}

function textoONull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** `a IS DISTINCT FROM b` de SQL sobre textos (null = null). */
function distinto(a: string | null, b: string | null): boolean {
  return (a ?? null) !== (b ?? null);
}

/**
 * Lo que depositó el banco por un cobro: monto − comisión bancaria capturada
 * (si no da positivo, el monto). Espejo EXACTO de `neto_de_cobro` (BD). Se
 * MUDÓ aquí desde `conciliacion/cobros-lote.util.ts` (que la re-exporta):
 * misma firma y mismo resultado byte a byte.
 */
export function netoDeCobro(
  monto: number | string | null | undefined,
  comision: number | string | null | undefined,
): number {
  const m = Number(monto) || 0;
  const c = Number(comision) || 0;
  const neto = r2(m - (c > 0 ? c : 0));
  return neto > 0 ? neto : r2(m);
}

/**
 * LA regla de «cobro cubierto» (= `regla_cobro_cubierto`, CASE ordenado):
 * cruzado ⇒ true; sin partes ⇒ false; neto ≤ 0 ⇒ true; si no,
 * r2(suma) + 1e-6 ≥ r2(neto) − 1.00.
 */
export function cubreCobro(
  neto: number,
  nPartes: number,
  cruzado: boolean,
  suma: number,
): boolean {
  if (cruzado === true) return true;
  if ((Number(nPartes) || 0) === 0) return false;
  if (r2(num(neto)) <= 0) return true;
  return (
    r2(num(suma)) + EPSILON_COBRO_BANCO >=
    r2(num(neto)) - TOLERANCIA_COBRO_BANCO
  );
}

/**
 * Una parte de la puente (o, sin 20261012000002, la liga del espejo con
 * parte = |abono|) con lo que del ABONO hace falta para la cobertura y para
 * pintarlo. `monto_parte` va en la moneda de la CUENTA del abono.
 */
export interface ParteCobroBanco {
  movimiento_id: string;
  cobro_id: string;
  monto_parte: number;
  /** Moneda de la cuenta del abono (null = no se pudo leer ⇒ cuenta como OTRA moneda, como el `is distinct from` de la vista). */
  moneda_cuenta: string | null;
  /** La cuenta del abono es una PASARELA (Paywise). */
  pasarela: boolean;
  /** DATE del banco (YYYY-MM-DD). */
  fecha: string | null;
  /** `created_at` del MOVIMIENTO (desempate de la antigüedad, como la vista). */
  created_at: string | null;
  /** |monto| del abono. */
  monto_abono: number | null;
  /** Cuántos cobros paga ese abono (espejo `cobros_n`; 1 en el espejo legado). */
  cobros_n: number | null;
  cuenta_bancaria_id: string | null;
  cuenta_alias: string | null;
}

/** Una fila de `v_cobro_conciliacion` (estado del cobro contra el banco). */
export interface CoberturaCobro {
  neto: number;
  /** Abonos ligados. */
  n_partes: number;
  /** Algún abono de una cuenta en OTRA moneda (1↔1: cubre por definición). */
  cruzado: boolean;
  /** Algún abono de una cuenta PASARELA. */
  pasarela: boolean;
  /** Σ partes de los abonos en SU moneda (r2). */
  suma: number;
  /** cruzado ⇒ neto; si no, suma. */
  monto_vinculado: number;
  /** neto ≤ 0 o cruzado ⇒ 0; si no, max(r2(neto − suma), 0) (sin abonos = neto). */
  faltante: number;
  /** sin abonos o cruzado ⇒ 0; si no, max(r2(suma − neto), 0). */
  sobrante: number;
  /** `regla_cobro_cubierto(neto, n_partes, cruzado, suma)`. */
  cubierto: boolean;
  /** Abonos por antigüedad (fecha, created_at, movimiento_id). */
  movimiento_ids: string[];
}

/** Lo mínimo de un cobro para su cobertura (una fila cruda de `cobro_vuelo` sirve). */
export interface CobroParaCobertura {
  monto?: unknown;
  moneda?: unknown;
  comision_banco_monto?: unknown;
}

/** [ms, microsegundos «000000»] de un instante ISO (null si no se puede leer). */
function claveInstante(s: string | null): [number, string] | null {
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const frac = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(s)?.[1] ?? '';
  return [ms, `${frac}000000`.slice(0, 6)];
}

function compararNulosAlFinal<T>(
  a: T | null,
  b: T | null,
  cmp: (x: T, y: T) => number,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b);
}

/**
 * Orden de ANTIGÜEDAD de los abonos de un cobro (el `order by m.fecha,
 * m.created_at, p.movimiento_id` de la vista; nulos al final, como el ASC
 * de Postgres). El uuid se compara como texto (= su orden de bytes).
 */
export function compararAntiguedadParte(
  a: Pick<ParteCobroBanco, 'fecha' | 'created_at' | 'movimiento_id'>,
  b: Pick<ParteCobroBanco, 'fecha' | 'created_at' | 'movimiento_id'>,
): number {
  const porFecha = compararNulosAlFinal(
    textoONull(a.fecha),
    textoONull(b.fecha),
    (x, y) => (x < y ? -1 : x > y ? 1 : 0),
  );
  if (porFecha !== 0) return porFecha;
  const porAlta = compararNulosAlFinal(
    claveInstante(textoONull(a.created_at)),
    claveInstante(textoONull(b.created_at)),
    (x, y) =>
      x[0] !== y[0] ? x[0] - y[0] : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0,
  );
  if (porAlta !== 0) return porAlta;
  return a.movimiento_id < b.movimiento_id
    ? -1
    : a.movimiento_id > b.movimiento_id
      ? 1
      : 0;
}

/** Copia ordenada por antigüedad (no muta la entrada). */
export function ordenarPartesPorAntiguedad<
  P extends Pick<ParteCobroBanco, 'fecha' | 'created_at' | 'movimiento_id'>,
>(partes: ReadonlyArray<P>): P[] {
  return [...partes].sort(compararAntiguedadParte);
}

/**
 * Cobertura de UN cobro con sus partes (= una fila de
 * `v_cobro_conciliacion`). `partes` son TODAS las ligas directas del cobro
 * (de cualquier abono).
 */
export function coberturaCobro(
  c: CobroParaCobertura,
  partes: ReadonlyArray<ParteCobroBanco>,
): CoberturaCobro {
  const neto = netoDeCobro(
    c.monto as number | string | null | undefined,
    c.comision_banco_monto as number | string | null | undefined,
  );
  const moneda = textoONull(c.moneda);
  let cruzado = false;
  let pasarela = false;
  let sumaCruda = 0;
  for (const p of partes) {
    if (distinto(p.moneda_cuenta, moneda)) cruzado = true;
    if (p.pasarela === true) pasarela = true;
    if (
      p.moneda_cuenta !== null &&
      moneda !== null &&
      p.moneda_cuenta === moneda
    ) {
      sumaCruda += num(p.monto_parte);
    }
  }
  const n = partes.length;
  const suma = r2(sumaCruda);
  return {
    neto,
    n_partes: n,
    cruzado,
    pasarela,
    suma,
    monto_vinculado: cruzado ? neto : suma,
    faltante: neto <= 0 || cruzado ? 0 : Math.max(r2(neto - suma), 0),
    sobrante: n === 0 || cruzado ? 0 : Math.max(r2(suma - neto), 0),
    cubierto: cubreCobro(neto, n, cruzado, suma),
    movimiento_ids: ordenarPartesPorAntiguedad(partes).map(
      (p) => p.movimiento_id,
    ),
  };
}

/** Lo que le falta a un cobro FUERA de un abono (la `v_faltante` de la RPC G). */
export interface FaltanteFueraDe {
  faltante: number;
  n_otras: number;
  /** Σ de las partes de los OTROS abonos en la moneda del cobro. */
  suma_otras: number;
  /** Los otros abonos ya lo cubren (`regla_cobro_cubierto(neto, n, false, suma)`, como A y G). */
  cubierto_por_otras: boolean;
  cruzado_otras: boolean;
  pasarela_otras: boolean;
  otras: ParteCobroBanco[];
}

/**
 * Las partes de los OTROS abonos de un cobro (≠ `movimientoId`) y lo que le
 * falta fuera de ese abono: sin otras ⇒ neto; con otras ⇒ max(r2(neto −
 * suma_otras), 0). Excluir el propio movimiento hace idéntica una re-liga
 * del mismo abono (la G escribe como DIFF).
 */
export function faltanteFueraDe(
  c: CobroParaCobertura,
  partes: ReadonlyArray<ParteCobroBanco>,
  movimientoId: string,
): FaltanteFueraDe {
  const otras = partes.filter((p) => p.movimiento_id !== movimientoId);
  const cob = coberturaCobro(c, otras);
  return {
    faltante:
      otras.length === 0 ? cob.neto : Math.max(r2(cob.neto - cob.suma), 0),
    n_otras: otras.length,
    suma_otras: cob.suma,
    cubierto_por_otras: cubreCobro(cob.neto, otras.length, false, cob.suma),
    cruzado_otras: cob.cruzado,
    pasarela_otras: cob.pasarela,
    otras: ordenarPartesPorAntiguedad(otras),
  };
}

/** Estado de un cobro contra el banco (los 5 de la lista y de la hoja). */
export type EstadoBancoCobro =
  | 'CONCILIADO'
  | 'PARCIAL'
  | 'VIA_ANTICIPO'
  | 'SIN_CONCILIAR'
  | 'NO_BANCARIO';

const METODOS_AUTO: ReadonlySet<string> = new Set(METODOS_COBRO_ABONO_AUTO);

/**
 * Estado del cobro: vía ANTICIPO ⇒ VIA_ANTICIPO; vía SOBRE ⇒ CONCILIADO;
 * vía DIRECTO ⇒ PARCIAL si la cobertura dice que NO está cubierto (sin
 * cobertura = respaldo del 0.0.77: CONCILIADO); sin vía ⇒ monto > 0 con
 * método ∈ METODOS_COBRO_ABONO_AUTO ⇒ SIN_CONCILIAR; el resto (efectivo,
 * dólares directo, BillPocket, otro, reembolsos) ⇒ NO_BANCARIO.
 */
export function estadoBancoCobro(p: {
  monto: number | string | null | undefined;
  metodo: string | null | undefined;
  via: ViaConciliacion | null | undefined;
  /** La de `coberturaCobro` (solo se lee `cubierto`); null = sin cobertura. */
  cobertura: Pick<CoberturaCobro, 'cubierto'> | null | undefined;
}): EstadoBancoCobro {
  if (p.via === 'ANTICIPO') return 'VIA_ANTICIPO';
  if (p.via === 'SOBRE') return 'CONCILIADO';
  if (p.via === 'DIRECTO') {
    return p.cobertura?.cubierto === false ? 'PARCIAL' : 'CONCILIADO';
  }
  if (num(p.monto) > 0 && p.metodo && METODOS_AUTO.has(p.metodo)) {
    return 'SIN_CONCILIAR';
  }
  return 'NO_BANCARIO';
}

/** El `conciliado` de siempre: CONCILIADO o VIA_ANTICIPO (un PARCIAL no). */
export function cobroCubiertoEnBanco(e: EstadoBancoCobro): boolean {
  return e === 'CONCILIADO' || e === 'VIA_ANTICIPO';
}

/** Cociente SIN redondear del T.C. implícito (el que compara la banda de A). */
function cocienteTcCobro(
  monedaCobro: string | null,
  monedaCuenta: string | null,
  neto: number,
  parte: number,
): number | null {
  if (monedaCobro === 'USD' && monedaCuenta === 'MXN') {
    return neto > 0 ? parte / neto : null;
  }
  if (monedaCobro === 'MXN' && monedaCuenta === 'USD') {
    return parte > 0 ? neto / parte : null;
  }
  return null;
}

/**
 * T.C. implícito de un abono en OTRA moneda contra el NETO del cobro (round6):
 * cobro USD + cuenta MXN ⇒ parte ÷ neto; cobro MXN + cuenta USD ⇒ neto ÷
 * parte; misma moneda, moneda desconocida o divisor 0 ⇒ null.
 */
export function tcImplicitoCobro(
  monedaCobro: string | null | undefined,
  monedaCuenta: string | null | undefined,
  neto: number,
  parte: number,
): number | null {
  const q = cocienteTcCobro(
    monedaCobro ?? null,
    monedaCuenta ?? null,
    Math.abs(num(neto)),
    Math.abs(num(parte)),
  );
  return q == null || !Number.isFinite(q) ? null : round6(q);
}

/** Qué pasaría al vincular ESTE abono a UN cobro (veredicto del API). */
export type ResultadoAlVincular =
  | 'CONCILIADO'
  | 'PARCIAL'
  | 'EXCEDE'
  | 'COMISION_NO_CUADRA'
  | 'YA_CUBIERTO'
  | 'UN_SOLO_ABONO'
  | 'MONEDA_DISTINTA';

export type MotivoAlVincular =
  | 'CUBIERTO'
  | 'MONEDA_DISTINTA'
  | 'PASARELA'
  | 'COMISION'
  | 'TC_FUERA_DE_BANDA'
  | 'TC_LEJOS';

export interface AlVincular {
  estado: ResultadoAlVincular;
  /** Lo que le falta al cobro FUERA de este abono (la `v_faltante` de G). */
  faltante_antes: number;
  /** Lo que le faltaría después de ligarlo (sin cambio si no se puede ligar). */
  faltante_despues: number;
  /** Solo EXCEDE: lo que sobra del abono. */
  sobrante: number;
  /** Solo COMISION_NO_CUADRA: max(r2(monto − |abono|), 0). */
  comision_real: number | null;
  /** Solo abono en otra moneda. */
  tc_implicito: number | null;
  tc_referencia: number | null;
  desvio_pct: number | null;
  motivo: MotivoAlVincular | null;
  /** El cobro se concilia con UN solo abono (comisión, pasarela u otra moneda). */
  un_solo: boolean;
}

/**
 * ESPEJO del trigger A para UN cobro, en el MISMO orden (el cobro ya pasó
 * COBRO_INVALIDO / COBRO_DE_GRUPO / COBRO_DE_ANTICIPO):
 * (1) con OTROS abonos: cruzados o ya cubierto ⇒ YA_CUBIERTO (CUBIERTO);
 *     comisión, abono de pasarela, abono cruzado o algún otro de pasarela ⇒
 *     UN_SOLO_ABONO (MONEDA_DISTINTA > PASARELA > COMISION);
 * (2) abono en OTRA moneda ⇒ T.C. implícito fuera de [15, 25] ⇒
 *     MONEDA_DISTINTA (TC_FUERA_DE_BANDA); con T.C. de referencia (el del
 *     cobro > 0; si no, el del vuelo > 0) y |desvío| (1 decimal, como
 *     `evaluarTcCruce`) > `toleranciaTcPct` ⇒ MONEDA_DISTINTA (TC_LEJOS,
 *     solo API); si no, CONCILIADO (un cobro cruzado queda cubierto);
 * (3) comisión capturada o abono de pasarela ⇒ |abono| > monto + 1.00 ⇒
 *     EXCEDE (un_solo); |abono − neto| > 1.00 ⇒ COMISION_NO_CUADRA; si no,
 *     CONCILIADO;
 * (4) banco sin comisión: Σ otros + |abono| > neto + 1.00 ⇒ EXCEDE; cubre ⇒
 *     CONCILIADO; si no, PARCIAL.
 * Las comparaciones llevan el + 0.000001 de la BD.
 */
export function alVincularAbono(i: {
  cobro: CobroParaCobertura & { tc_usd_mxn?: unknown };
  tcVuelo: number | null | undefined;
  /** Partes de los OTROS abonos del cobro (sin las de este abono). */
  otras: ReadonlyArray<ParteCobroBanco>;
  abono: { monto: number; moneda_cuenta: string | null; pasarela: boolean };
  toleranciaTcPct: number;
}): AlVincular {
  const monto = r2(num(i.cobro.monto));
  const neto = netoDeCobro(
    i.cobro.monto as number | string | null | undefined,
    i.cobro.comision_banco_monto as number | string | null | undefined,
  );
  const comision = num(i.cobro.comision_banco_monto) > 0;
  const monedaCobro = textoONull(i.cobro.moneda);
  const parte = r2(Math.abs(num(i.abono.monto)));
  const cruzada =
    i.abono.moneda_cuenta !== null && i.abono.moneda_cuenta !== monedaCobro;
  const pasarela = i.abono.pasarela === true;
  const otrasCob = coberturaCobro(i.cobro, i.otras);
  const nOtras = i.otras.length;
  const sumaOtras = otrasCob.suma;
  const faltanteAntes = nOtras === 0 ? neto : Math.max(r2(neto - sumaOtras), 0);
  const unSolo =
    comision || pasarela || cruzada || otrasCob.cruzado || otrasCob.pasarela;
  const base: AlVincular = {
    estado: 'CONCILIADO',
    faltante_antes: faltanteAntes,
    faltante_despues: faltanteAntes,
    sobrante: 0,
    comision_real: null,
    tc_implicito: null,
    tc_referencia: null,
    desvio_pct: null,
    motivo: null,
    un_solo: unSolo,
  };

  // (1) Con OTROS abonos.
  if (nOtras > 0) {
    if (otrasCob.cruzado || cubreCobro(neto, nOtras, false, sumaOtras)) {
      return { ...base, estado: 'YA_CUBIERTO', motivo: 'CUBIERTO' };
    }
    if (comision || pasarela || cruzada || otrasCob.pasarela) {
      return {
        ...base,
        estado: 'UN_SOLO_ABONO',
        motivo: cruzada
          ? 'MONEDA_DISTINTA'
          : pasarela || otrasCob.pasarela
            ? 'PASARELA'
            : 'COMISION',
      };
    }
  }

  // (2) Otra moneda (1↔1).
  if (cruzada) {
    const q = cocienteTcCobro(monedaCobro, i.abono.moneda_cuenta, neto, parte);
    const tc = q == null || !Number.isFinite(q) ? null : round6(q);
    if (q == null || q < TC_COBRO_MIN || q > TC_COBRO_MAX) {
      return {
        ...base,
        estado: 'MONEDA_DISTINTA',
        motivo: 'TC_FUERA_DE_BANDA',
        tc_implicito: tc,
      };
    }
    const ref =
      normalizarTc(i.cobro.tc_usd_mxn) ?? normalizarTc(i.tcVuelo ?? null);
    if (ref != null && tc != null) {
      let desvio = redondearA((tc / ref - 1) * 100, 1);
      if (desvio === 0) desvio = 0; // −0 ⇒ 0
      if (Math.abs(desvio) > i.toleranciaTcPct) {
        return {
          ...base,
          estado: 'MONEDA_DISTINTA',
          motivo: 'TC_LEJOS',
          tc_implicito: tc,
          tc_referencia: ref,
          desvio_pct: desvio,
        };
      }
      return {
        ...base,
        faltante_despues: 0,
        tc_implicito: tc,
        tc_referencia: ref,
        desvio_pct: desvio,
      };
    }
    return { ...base, faltante_despues: 0, tc_implicito: tc };
  }

  // (3) Cobro «de un solo abono»: comisión capturada o abono de la pasarela.
  if (comision || pasarela) {
    if (parte > monto + TOLERANCIA_COBRO_BANCO + EPSILON_COBRO_BANCO) {
      return {
        ...base,
        estado: 'EXCEDE',
        sobrante: r2(parte - neto),
        un_solo: true,
      };
    }
    if (Math.abs(parte - neto) > TOLERANCIA_COBRO_BANCO + EPSILON_COBRO_BANCO) {
      return {
        ...base,
        estado: 'COMISION_NO_CUADRA',
        comision_real: Math.max(r2(monto - parte), 0),
        motivo: pasarela ? 'PASARELA' : 'COMISION',
      };
    }
    return { ...base, faltante_despues: Math.max(r2(neto - parte), 0) };
  }

  // (4) Cobro de BANCO sin comisión: varios abonos, nunca de más.
  const total = sumaOtras + parte;
  if (total > neto + TOLERANCIA_COBRO_BANCO + EPSILON_COBRO_BANCO) {
    return { ...base, estado: 'EXCEDE', sobrante: r2(total - neto) };
  }
  if (cubreCobro(neto, nOtras + 1, false, r2(total))) {
    return { ...base, faltante_despues: Math.max(r2(neto - total), 0) };
  }
  return { ...base, estado: 'PARCIAL', faltante_despues: r2(neto - total) };
}

/**
 * ¿El PATCH de un cobro mueve de verdad su DINERO frente a lo VIGENTE?
 * (patrón `cambiaDineroDelGasto` y del bloque de anticipo de `updateCobro`):
 * montos a centavos, el % con tolerancia 0.0001 (se guarda a 4 decimales),
 * el T.C. normalizado a 6 decimales (`normalizarTc`) y la comisión 0 = sin
 * comisión. Un campo AUSENTE no cambia. Sin la fila vigente ⇒ true si toca
 * algún campo de dinero (fail-closed). Lo usa el candado del cobro con
 * abonos (trigger E en la BD).
 */
export function cambiaDineroDelCobro(
  dto: {
    monto?: unknown;
    moneda?: unknown;
    tc_usd_mxn?: unknown;
    comision_banco_monto?: unknown;
    comision_banco_pct?: unknown;
  },
  actual: Record<string, unknown> | null | undefined,
): boolean {
  const toca =
    dto.monto !== undefined ||
    dto.moneda !== undefined ||
    dto.tc_usd_mxn !== undefined ||
    dto.comision_banco_monto !== undefined ||
    dto.comision_banco_pct !== undefined;
  if (!toca) return false;
  if (!actual) return true;
  const centavos = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  const comision = (v: unknown): number =>
    Number(v) > 0 ? Math.round(Number(v) * 100) : 0;
  const pct = (v: unknown): number => (Number(v) > 0 ? Number(v) : 0);
  if (dto.monto !== undefined) {
    const nuevo = centavos(dto.monto);
    const viejo = centavos(actual.monto);
    if (nuevo === null || viejo === null || nuevo !== viejo) return true;
  }
  if (
    dto.moneda !== undefined &&
    textoONull(dto.moneda) !== textoONull(actual.moneda)
  ) {
    return true;
  }
  if (
    dto.tc_usd_mxn !== undefined &&
    normalizarTc(dto.tc_usd_mxn) !== normalizarTc(actual.tc_usd_mxn)
  ) {
    return true;
  }
  if (
    dto.comision_banco_monto !== undefined &&
    comision(dto.comision_banco_monto) !== comision(actual.comision_banco_monto)
  ) {
    return true;
  }
  if (
    dto.comision_banco_pct !== undefined &&
    Math.abs(pct(dto.comision_banco_pct) - pct(actual.comision_banco_pct)) >
      0.0001
  ) {
    return true;
  }
  return false;
}

const METODOS_PASARELA: ReadonlySet<string> = new Set(METODOS_COBRO_PASARELA);

/**
 * La regla «de un solo abono» del TRIGGER A tal cual (sin el método): un
 * cobro con comisión bancaria capturada > 0, o con alguna parte de la
 * pasarela o de una cuenta en OTRA moneda, no admite otro abono de banco
 * (la rama UN_SOLO_ABONO de `alVincularAbono` vista desde el cobro). La usan
 * los FRENOS anti doble conteo (revisión del 15-oct-2026, D12): un parcial
 * que la BD sí deja completar todavía espera dinero aunque su método sea
 * PAYWISE.
 */
export function cobroDeUnSoloAbonoSegunA(
  c: CobroParaCobertura,
  partes: ReadonlyArray<ParteCobroBanco>,
): boolean {
  if (num(c.comision_banco_monto) > 0) return true;
  const moneda = textoONull(c.moneda);
  return partes.some(
    (p) => p.pasarela === true || distinto(p.moneda_cuenta, moneda),
  );
}

/**
 * ¿Este cobro se concilia con UN solo abono? (conciliación al revés de
 * Ingresos, invariante 78, R9): comisión bancaria capturada > 0, método de
 * la PASARELA (Paywise: su abono vendrá de la pasarela), o alguna de sus
 * partes es de la pasarela o de una cuenta en OTRA moneda. Es la rama
 * UN_SOLO_ABONO de `alVincularAbono` (y del trigger A) extraída para quien
 * no tiene un abono a la mano; el método PAYWISE la ANTICIPA para un cobro
 * todavía sin partes (A no mira el método: decide por la cuenta del abono;
 * para la regla de A sola, `cobroDeUnSoloAbonoSegunA`).
 */
export function cobroDeUnSoloAbono(
  c: CobroParaCobertura & { metodo_cobro?: unknown },
  partes: ReadonlyArray<ParteCobroBanco>,
): boolean {
  if (
    typeof c.metodo_cobro === 'string' &&
    METODOS_PASARELA.has(c.metodo_cobro)
  ) {
    return true;
  }
  return cobroDeUnSoloAbonoSegunA(c, partes);
}
