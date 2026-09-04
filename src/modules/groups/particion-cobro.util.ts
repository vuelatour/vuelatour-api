/**
 * SOBRE de cobro de grupo — partición PURA (4-sep-2026, Fase 2).
 *
 * Un pago único del cliente (`cobro_grupo`, el "sobre") se PARTE en N
 * `cobro_vuelo` (uno por avión hijo vivo) con pesos exactos. Principio
 * rector intacto: cada peso vive en exactamente UN `cobro_vuelo`;
 * `cobrosEnUsd` sigue leyendo SOLO `cobro_vuelo` (el sobre nunca entra a la
 * suma: es agrupación + conciliación con el banco).
 *
 * Regla AUTO (diseño A, «COBRO ÚNICO → SOBRE»):
 * - monto_usd = monto (USD) o monto / tc (MXN).
 * - Si |monto_usd − Σ saldos_i| ≤ 1 USD (saldo_i = total_i − cobrado_i, solo
 *   hijos vivos con saldo > 0) → LIQUIDACION: cada hijo recibe SU saldo en
 *   moneda nativa (saldo_i × tc si MXN, 2 decimales) y el residuo cae en el
 *   ancla para que Σ partes == monto EXACTO — así el último pago pone
 *   `cobrado=true` en los N hijos sin residuos.
 * - Si no → PROPORCIONAL: `repartirExacto` (= `repartirUsd`, la ÚNICA
 *   función de reparto con centavos por residuo mayor) con pesos
 *   total_i / Σ total y residuo al ancla. Funciona en cualquier moneda
 *   porque solo son pesos.
 * - Reembolso (monto < 0): PROPORCIONAL por neto COBRADO de cada hijo
 *   (cobrado_i / Σ) con candado |parte_i| ≤ cobrado_i (REEMBOLSO_EXCEDE con
 *   detalle por avión) — espejo del candado de `createReembolso`.
 * - MANUAL: `particion_manual` [{vuelo_id, monto}] con Σ == monto exacto;
 *   400 si no cuadra o si un hijo no es del grupo / está cancelado.
 * - Comisión bancaria (`comision_banco_monto`, BRUTO en `monto`) se parte
 *   con los MISMOS pesos (Σ exacta, residuo al ancla).
 * - Partes con monto 0 se omiten (`cobro_vuelo.monto <> 0`); hijos
 *   CANCELADOS nunca reciben partes.
 */

import { diaCancun } from '../../common/fecha-cancun.util';
import {
  repartirExacto,
  round2,
  type ProblemaGrupo,
} from './grupo-armador.util';

export type ModoParticionCobro = 'LIQUIDACION' | 'PROPORCIONAL' | 'MANUAL';
export type MonedaCobroGrupo = 'USD' | 'MXN';
export type SemaforoCobro = 'gris' | 'verde' | 'ambar' | 'rojo';

/** Tolerancia con la que "el pago cubre el saldo" (misma que refreshCobradoFlag). */
export const TOLERANCIA_LIQUIDACION_USD = 1;

export interface HijoParticionCobro {
  vuelo_id: string;
  folio?: number | null;
  posicion?: number | null;
  matricula?: string | null;
  /** Total cotizado del hijo (USD). */
  total_usd: number;
  /** Cobrado NETO del hijo en USD (fuente única cobrosEnUsd). */
  cobrado_usd: number;
  es_ancla: boolean;
  cancelado: boolean;
}

export interface ParticionManualItem {
  vuelo_id: string;
  monto: number;
}

export interface ParticionCobroInput {
  /** Monto NATIVO del sobre (≠ 0; negativo = reembolso). */
  monto: number;
  moneda: MonedaCobroGrupo;
  /** Obligatorio con MXN (para saldos y candados en USD). */
  tc?: number | null;
  /** Comisión bancaria del sobre en moneda nativa (solo cobros positivos). */
  comision_banco_monto?: number | null;
  hijos: HijoParticionCobro[];
  modo?: 'AUTO' | 'MANUAL' | null;
  particion_manual?: ParticionManualItem[] | null;
}

export interface ParteCobroGrupo {
  vuelo_id: string;
  folio: number | null;
  posicion: number | null;
  matricula: string | null;
  /** Parte NATIVA (2 decimales, ≠ 0; negativa en reembolsos). */
  monto: number;
  /** La misma parte convertida a USD (informativa). */
  monto_usd: number;
  /** Peso con el que recibió su parte (6 decimales; Σ ≈ 1). */
  factor: number;
  comision_banco_monto: number | null;
  saldo_antes_usd: number;
  saldo_despues_usd: number;
}

export interface ParticionCobroResult {
  modo_particion: ModoParticionCobro;
  monto: number;
  monto_usd: number;
  moneda: MonedaCobroGrupo;
  tc: number | null;
  partes: ParteCobroGrupo[];
  verificacion: {
    suma_partes: number;
    monto: number;
    cuadra: boolean;
    suma_comision: number | null;
    comision: number | null;
    cuadra_comision: boolean;
  };
  avisos: string[];
}

export type CodigoParticionCobro =
  | 'MONTO_CERO'
  | 'SIN_TC'
  | 'SIN_HIJOS'
  | 'REEMBOLSO_EXCEDE'
  | 'PARTICION_NO_CUADRA'
  | 'HIJO_INVALIDO'
  | 'COMISION_INVALIDA';

/** Detalle por avión del candado REEMBOLSO_EXCEDE. */
export interface ExcesoReembolso {
  vuelo_id: string;
  folio: number | null;
  posicion: number | null;
  matricula: string | null;
  reembolso_usd: number;
  cobrado_usd: number;
}

/** Error tipado del helper puro: el service lo traduce a 400/409. */
export class ParticionCobroError extends Error {
  constructor(
    public readonly code: CodigoParticionCobro,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ParticionCobroError';
  }
}

function etiquetaHijo(h: {
  posicion?: number | null;
  folio?: number | null;
  matricula?: string | null;
}): string {
  const partes = [`avión ${h.posicion ?? '?'}`];
  if (h.matricula) partes.push(h.matricula);
  if (h.folio != null) partes.push(`#${h.folio}`);
  return partes.join(' ');
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function particionCobroGrupo(
  input: ParticionCobroInput,
): ParticionCobroResult {
  const monto = round2(Number(input.monto));
  if (!Number.isFinite(monto) || monto === 0) {
    throw new ParticionCobroError(
      'MONTO_CERO',
      'El monto del cobro del grupo no puede ser 0.',
    );
  }
  const moneda: MonedaCobroGrupo = input.moneda === 'MXN' ? 'MXN' : 'USD';
  const tc = Number(input.tc) > 0 ? Number(input.tc) : null;
  if (moneda === 'MXN' && !tc) {
    throw new ParticionCobroError(
      'SIN_TC',
      'Un cobro del grupo en pesos necesita tipo de cambio (tc_usd_mxn): sin él no se pueden calcular los saldos por avión.',
    );
  }
  const aUsd = (nativo: number): number =>
    moneda === 'USD' ? round2(nativo) : round2(nativo / (tc as number));
  const aNativo = (usd: number): number =>
    moneda === 'USD' ? round2(usd) : round2(usd * (tc as number));

  const vivos = input.hijos.filter((h) => !h.cancelado);
  if (vivos.length === 0) {
    throw new ParticionCobroError(
      'SIN_HIJOS',
      'El grupo no tiene aviones vivos que puedan recibir el cobro.',
    );
  }
  const porId = new Map(vivos.map((h) => [h.vuelo_id, h]));
  const ancla = vivos.find((h) => h.es_ancla)?.vuelo_id ?? null;
  const montoUsd = aUsd(monto);
  const avisos: string[] = [];

  // Comisión bancaria: solo en cobros positivos (CHECK
  // cobro_grupo_reembolso_sin_comision) y siempre menor al monto.
  const comisionCruda = Number(input.comision_banco_monto);
  const comision = comisionCruda > 0 ? round2(comisionCruda) : null;
  if (comision != null && monto < 0) {
    throw new ParticionCobroError(
      'COMISION_INVALIDA',
      'Un reembolso no lleva comisión bancaria: el cargo del banco se registra aparte.',
    );
  }
  if (comision != null && comision >= monto) {
    throw new ParticionCobroError(
      'COMISION_INVALIDA',
      'La comisión del banco no puede ser mayor o igual al monto del cobro.',
    );
  }

  const saldoDe = (h: HijoParticionCobro): number =>
    round2(Math.max(0, round2(h.total_usd) - round2(h.cobrado_usd)));

  let modo: ModoParticionCobro | null = null;
  let partesNativas = new Map<string, number>();
  let pesos = new Map<string, number>();

  // Partición manual mandada con modo AUTO: no se ignora en silencio (el
  // operador creería que sus montos se respetaron).
  if (input.modo !== 'MANUAL' && (input.particion_manual?.length ?? 0) > 0) {
    throw new ParticionCobroError(
      'HIJO_INVALIDO',
      'Mandaste una partición manual pero el modo es AUTO: elige modo MANUAL o quita particion_manual.',
    );
  }

  if (input.modo === 'MANUAL') {
    const lista = input.particion_manual ?? [];
    if (lista.length === 0) {
      throw new ParticionCobroError(
        'HIJO_INVALIDO',
        'La partición manual necesita al menos un avión con monto.',
      );
    }
    const vistos = new Set<string>();
    for (const it of lista) {
      const h = porId.get(it.vuelo_id);
      if (!h) {
        const cualquiera = input.hijos.find((x) => x.vuelo_id === it.vuelo_id);
        throw new ParticionCobroError(
          'HIJO_INVALIDO',
          cualquiera
            ? `El ${etiquetaHijo(cualquiera)} está cancelado: no recibe partes del sobre.`
            : `El vuelo ${it.vuelo_id} no pertenece a este grupo.`,
          { vuelo_id: it.vuelo_id },
        );
      }
      if (vistos.has(it.vuelo_id)) {
        throw new ParticionCobroError(
          'HIJO_INVALIDO',
          `El ${etiquetaHijo(h)} aparece dos veces en la partición manual.`,
          { vuelo_id: it.vuelo_id },
        );
      }
      vistos.add(it.vuelo_id);
      const m = round2(Number(it.monto) || 0);
      if (m === 0) continue;
      if (Math.sign(m) !== Math.sign(monto)) {
        throw new ParticionCobroError(
          'PARTICION_NO_CUADRA',
          `La parte del ${etiquetaHijo(h)} tiene signo distinto al cobro (${fmt(m)} contra ${fmt(monto)}).`,
          { vuelo_id: it.vuelo_id, monto: m },
        );
      }
      partesNativas.set(h.vuelo_id, m);
    }
    const suma = round2(
      [...partesNativas.values()].reduce((acc, v) => acc + v, 0),
    );
    if (suma !== monto) {
      throw new ParticionCobroError(
        'PARTICION_NO_CUADRA',
        `Las partes suman ${fmt(suma)} y el cobro es ${fmt(monto)} ${moneda}: faltan ${fmt(round2(monto - suma))} por repartir.`,
        { suma, monto, diferencia: round2(monto - suma) },
      );
    }
    pesos = new Map(
      [...partesNativas.entries()].map(([k, v]) => [k, Math.abs(v)]),
    );
    modo = 'MANUAL';
  } else if (monto > 0) {
    const conSaldo = vivos
      .map((h) => ({ h, saldo: saldoDe(h) }))
      .filter((x) => x.saldo > 0);
    const sumaSaldos = round2(conSaldo.reduce((acc, x) => acc + x.saldo, 0));
    const liquida =
      conSaldo.length > 0 &&
      Math.abs(montoUsd - sumaSaldos) <= TOLERANCIA_LIQUIDACION_USD;
    if (liquida) {
      const partes = new Map<string, number>(
        conSaldo.map((x) => [x.h.vuelo_id, aNativo(x.saldo)]),
      );
      const suma = round2([...partes.values()].reduce((a, b) => a + b, 0));
      const residuo = round2(monto - suma);
      if (residuo !== 0) {
        const receptor = conSaldo.some((x) => x.h.vuelo_id === ancla)
          ? (ancla as string)
          : [...conSaldo].sort((a, b) => b.saldo - a.saldo)[0].h.vuelo_id;
        partes.set(receptor, round2((partes.get(receptor) ?? 0) + residuo));
      }
      if ([...partes.values()].every((v) => v > 0)) {
        partesNativas = partes;
        pesos = new Map(partes);
        modo = 'LIQUIDACION';
      } else {
        avisos.push(
          'El pago cubre los saldos pero el residuo dejaría una parte en 0 o negativa: se repartió proporcionalmente al precio de cada avión.',
        );
      }
    }
    if (!modo) {
      pesos = new Map(
        vivos.map((h) => [h.vuelo_id, Math.max(0, round2(h.total_usd))]),
      );
      if ([...pesos.values()].every((p) => p <= 0)) {
        avisos.push(
          'Ningún avión vivo tiene precio: todo el cobro cae en el avión ancla.',
        );
      }
      partesNativas = repartirExacto(monto, pesos, ancla);
      modo = 'PROPORCIONAL';
      // Aviso (no candado): el reparto por PRECIO puede dejar un avión con
      // más cobrado que su precio (ya liquidado por su cuenta, o el pago
      // supera el saldo del grupo). El operador lo ve en la vista previa y
      // puede usar partición manual.
      if (montoUsd > sumaSaldos + TOLERANCIA_LIQUIDACION_USD) {
        avisos.push(
          `El pago ($${fmt(montoUsd)} USD) supera el saldo del grupo ($${fmt(sumaSaldos)} USD) por $${fmt(round2(montoUsd - sumaSaldos))} USD: algún avión quedará con cobrado mayor a su precio.`,
        );
      } else {
        const sobrepasados = vivos.filter((h) => {
          const parte = partesNativas.get(h.vuelo_id) ?? 0;
          return parte > 0 && aUsd(parte) > saldoDe(h) + 0.01;
        });
        if (sobrepasados.length > 0) {
          avisos.push(
            `Reparto proporcional al precio: ${sobrepasados
              .map((h) => `el ${etiquetaHijo(h)}`)
              .join(
                ', ',
              )} recibiría más que su saldo pendiente y quedaría con cobrado mayor a su precio. Si ese avión ya se pagó por su cuenta, usa partición manual.`,
          );
        }
      }
    }
  } else {
    pesos = new Map(
      vivos.map((h) => [h.vuelo_id, Math.max(0, round2(h.cobrado_usd))]),
    );
    const sumaCobrado = round2(
      [...pesos.values()].reduce((acc, v) => acc + v, 0),
    );
    if (sumaCobrado <= 0) {
      throw new ParticionCobroError(
        'REEMBOLSO_EXCEDE',
        'Ningún avión vivo del grupo tiene cobros netos: no hay nada que reembolsar.',
        [],
      );
    }
    partesNativas = repartirExacto(monto, pesos, ancla);
    modo = 'PROPORCIONAL';
  }

  // Candado del reembolso por hijo (espejo de createReembolso): ninguna
  // parte puede dejar el cobrado neto del avión en negativo.
  if (monto < 0) {
    const excesos: ExcesoReembolso[] = [];
    for (const [id, parte] of partesNativas) {
      if (parte === 0) continue;
      const h = porId.get(id)!;
      const parteUsd = Math.abs(aUsd(parte));
      const cobrado = round2(Math.max(0, h.cobrado_usd));
      if (parteUsd > cobrado + 0.01) {
        excesos.push({
          vuelo_id: id,
          folio: h.folio ?? null,
          posicion: h.posicion ?? null,
          matricula: h.matricula ?? null,
          reembolso_usd: parteUsd,
          cobrado_usd: cobrado,
        });
      }
    }
    if (excesos.length > 0) {
      throw new ParticionCobroError(
        'REEMBOLSO_EXCEDE',
        `El reembolso supera lo cobrado neto en ${excesos.length} avión(es): ${excesos
          .map(
            (e) =>
              `${etiquetaHijo(e)} devolvería $${fmt(e.reembolso_usd)} USD y solo tiene $${fmt(e.cobrado_usd)} USD cobrados`,
          )
          .join('; ')}. Revisa el monto o usa partición manual.`,
        excesos,
      );
    }
  }

  // Comisión con los MISMOS pesos que el monto (solo partes con monto).
  const activas = [...partesNativas.entries()].filter(([, v]) => v !== 0);
  let comisionPartes: Map<string, number> | null = null;
  if (comision != null) {
    const pesosActivos = new Map(
      activas.map(([k]) => [k, Math.max(0, pesos.get(k) ?? 0)]),
    );
    comisionPartes = repartirExacto(comision, pesosActivos, ancla);
    for (const [k, v] of activas) {
      const c = comisionPartes.get(k) ?? 0;
      if (c >= Math.abs(v)) {
        throw new ParticionCobroError(
          'COMISION_INVALIDA',
          `La comisión repartida al ${etiquetaHijo(porId.get(k)!)} ($${fmt(c)}) iguala o supera su parte ($${fmt(v)}): captura la comisión como % o revisa los montos.`,
          { vuelo_id: k, parte: v, comision: c },
        );
      }
    }
  }

  const sumaPesos = activas.reduce((acc, [k]) => acc + (pesos.get(k) ?? 0), 0);
  const ordenar = (a: HijoParticionCobro, b: HijoParticionCobro): number =>
    (a.posicion ?? 9999) - (b.posicion ?? 9999) ||
    (a.folio ?? 0) - (b.folio ?? 0);
  const partes: ParteCobroGrupo[] = activas
    .map(([id, parte]) => {
      const h = porId.get(id)!;
      const parteUsd = aUsd(parte);
      const saldoAntes = round2(round2(h.total_usd) - round2(h.cobrado_usd));
      return {
        vuelo_id: id,
        folio: h.folio ?? null,
        posicion: h.posicion ?? null,
        matricula: h.matricula ?? null,
        monto: parte,
        monto_usd: parteUsd,
        factor:
          sumaPesos > 0 ? round6((pesos.get(id) ?? 0) / sumaPesos) : round6(1),
        comision_banco_monto: comisionPartes
          ? (comisionPartes.get(id) ?? 0)
          : null,
        saldo_antes_usd: saldoAntes,
        saldo_despues_usd: round2(saldoAntes - parteUsd),
      };
    })
    .sort((a, b) => ordenar(porId.get(a.vuelo_id)!, porId.get(b.vuelo_id)!));

  const sumaPartes = round2(partes.reduce((acc, p) => acc + p.monto, 0));
  const sumaComision = comisionPartes
    ? round2(partes.reduce((acc, p) => acc + (p.comision_banco_monto ?? 0), 0))
    : null;
  return {
    modo_particion: modo,
    monto,
    monto_usd: montoUsd,
    moneda,
    tc,
    partes,
    verificacion: {
      suma_partes: sumaPartes,
      monto,
      cuadra: sumaPartes === monto,
      suma_comision: sumaComision,
      comision,
      cuadra_comision: comision == null || sumaComision === comision,
    },
    avisos,
  };
}

/**
 * Semáforo de cobro del GRUPO a partir de los semáforos de sus hijos VIVOS
 * (cada uno con la regla de siempre): verde si todos verdes, ámbar si alguno
 * parcial o mezcla, rojo si ninguno tiene cobro, gris si nada tiene precio.
 */
export function semaforoCobroGrupo(
  semaforos: ReadonlyArray<SemaforoCobro>,
): SemaforoCobro {
  const conPrecio = semaforos.filter((s) => s !== 'gris');
  if (conPrecio.length === 0) return 'gris';
  if (conPrecio.every((s) => s === 'verde')) return 'verde';
  if (conPrecio.every((s) => s === 'rojo')) return 'rojo';
  return 'ambar';
}

// ===== Cuadre / diagnóstico de sobres (conciliación, pre-cierre, alerta) =====

export interface ParteSobreDiagnostico {
  /** Monto NATIVO de la parte (cobro_vuelo.monto). */
  monto: number;
  /** La parte vive en un hijo CANCELADO (quitado del grupo). */
  cancelado: boolean;
}

export interface SobreDiagnostico {
  id: string;
  /** Monto NATIVO del sobre (negativo = reembolso). */
  monto: number;
  moneda: string;
  fecha_cobro?: string | null;
  partes: ParteSobreDiagnostico[];
}

export interface CuadreSobre {
  suma_partes: number;
  /** Σ partes == sobre (invariante del sobre). */
  cuadra: boolean;
  partes_en_cancelados: number;
  /** No cuadra O tiene partes en hijos cancelados: hay que re-partir. */
  descuadrado: boolean;
}

/**
 * Invariante del sobre (misma aritmética que `armarSobreSalida` del grupo y
 * que el check del pre-cierre): `cobro_grupo.monto == Σ cobro_vuelo.monto`
 * de sus partes, todas en hijos vivos. Puro: lo comparten el detalle del
 * grupo, el pre-cierre (`sobres_descuadrados`) y la alerta diaria.
 */
export function cuadreSobre(sobre: {
  monto: number;
  partes: ReadonlyArray<ParteSobreDiagnostico>;
}): CuadreSobre {
  const monto = round2(sobre.monto);
  const suma = round2(sobre.partes.reduce((acc, p) => acc + p.monto, 0));
  const cancelados = sobre.partes.filter((p) => p.cancelado).length;
  const cuadra = suma === monto;
  return {
    suma_partes: suma,
    cuadra,
    partes_en_cancelados: cancelados,
    descuadrado: !cuadra || cancelados > 0,
  };
}

function fmtMontoSobre(n: number): string {
  return Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Problemas tipo SOBRE de un grupo (misma forma que `diagnosticoGrupo`):
 * un sobre descuadrado o con partes en aviones cancelados. Mensaje único
 * para la alerta `grupo_desincronizado`, `avisos` del detalle y el
 * pre-cierre: «Sobre de $X del grupo G-12 descuadrado: re-parte desde
 * Cobros del grupo».
 */
export function diagnosticoSobres(
  grupoFolio: number | null,
  sobres: ReadonlyArray<SobreDiagnostico>,
): ProblemaGrupo[] {
  const out: ProblemaGrupo[] = [];
  const g = `G-${grupoFolio ?? '?'}`;
  for (const s of sobres) {
    const c = cuadreSobre(s);
    if (!c.descuadrado) continue;
    const etiqueta = s.monto < 0 ? 'Reembolso de grupo' : 'Sobre';
    const dia = s.fecha_cobro ? ` del ${diaCancun(s.fecha_cobro)}` : '';
    const motivos: string[] = [];
    if (!c.cuadra) {
      motivos.push(
        `sus partes suman $${fmtMontoSobre(c.suma_partes)} y el sobre es $${fmtMontoSobre(s.monto)}`,
      );
    }
    if (c.partes_en_cancelados > 0) {
      motivos.push(`${c.partes_en_cancelados} parte(s) en aviones cancelados`);
    }
    out.push({
      tipo: 'SOBRE',
      sobre_id: s.id,
      monto: round2(s.monto),
      suma_partes: c.suma_partes,
      partes_en_cancelados: c.partes_en_cancelados,
      detalle: `${etiqueta} de $${fmtMontoSobre(s.monto)} ${s.moneda}${dia} del grupo ${g} descuadrado (${motivos.join('; ')}): re-parte desde Cobros del grupo.`,
    });
  }
  return out;
}
