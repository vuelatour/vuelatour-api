/**
 * 1 ABONO ↔ N COBROS DE VUELO (12-oct-2026, API 0.0.71, invariante 56).
 * Helpers PUROS (sin I/O) de la liga de un abono del banco con varios
 * cobros: el NETO de cada cobro, la pre-validación del lote (ESPEJO de la
 * RPC `conciliacion_ligar_abono_cobros`, para responder 409 claros ANTES
 * de escribir), la lectura del error de la BD, los textos en es-MX y la
 * expansión de las partes de la puente como «ligas» para la fuente única
 * `cobro-conciliado.util`.
 *
 * La REGLA vive en la BD (RPC + triggers); esto es su espejo para no tocar
 * nada cuando se puede responder antes, y la traducción de sus códigos.
 */
import {
  alVincularAbono,
  cobroDeUnSoloAbono,
  cobroDeUnSoloAbonoSegunA,
  coberturaCobro,
  cubreCobro,
  EPSILON_COBRO_BANCO,
  faltanteFueraDe,
  netoDeCobro,
  ordenarPartesPorAntiguedad,
  TC_COBRO_MAX,
  TC_COBRO_MIN,
  TOLERANCIA_COBRO_BANCO,
  type AlVincular,
  type CobroParaCobertura,
  type ParteCobroBanco,
} from '../../common/cobro-banco.util';
import type { MovimientoLiga } from '../../common/cobro-conciliado.util';
import { etiquetaMetodoCobro } from '../../common/metodo-cobro.util';
import { normalizarTc } from '../../common/tc.util';
import { TOLERANCIA_TC_OFICIAL_PCT } from './auto-cruce.util';
import { fechaCortaEs, toleranciaLote } from './conciliacion-parcial.util';
import { mensajeMovimientoOmitido } from './omision.util';

/**
 * `netoDeCobro` se MUDÓ a `common/cobro-banco.util.ts` (invariante 77, espejo
 * de `neto_de_cobro`); se re-exporta aquí para no tocar a sus importadores.
 */
export { netoDeCobro };

/** Tope de cobros por abono (el mismo de la RPC y del DTO). */
export const LOTE_COBROS_MAX = 50;

/** Códigos 23514 que lanza la BD (hint) al ligar/desligar cobros. */
export const CODIGOS_ERROR_COBROS = [
  'LOTE_INVALIDO',
  'SOLO_ABONOS',
  'MOVIMIENTO_YA_LIGADO',
  'REVERSO_INVALIDO',
  'COBRO_NO_EXISTE',
  'COBRO_INVALIDO',
  'COBRO_DE_GRUPO',
  'COBRO_DE_ANTICIPO',
  'COBRO_YA_CONCILIADO',
  'LOTE_MONEDA_DISTINTA',
  'ABONO_NO_CUADRA',
  'LOTE_SOLO_API_NUEVO',
  'ABONO_LIGADO',
  'COBROS_INCOHERENTES',
  // 14-oct-2026 (invariante 75): ligar un abono OMITIDO de la conciliación
  // (trigger `trg_mov_bancario_omitido_sin_ligas`, por el UPDATE de
  // sincronía de la puente o el `cobro_id` directo).
  'MOVIMIENTO_OMITIDO',
  // 14-oct-2026 (invariante 77, migración 20261014000003): un cobro acepta
  // varios abonos. El trigger A los lanza por cobro (los tres primeros
  // cierran su message con « [ABONO_NO_CUADRA]»: un API ≤ 0.0.77 los lee
  // como ABONO_NO_CUADRA ⇒ 409, no 500); E protege el dinero del cobro.
  'ABONO_EXCEDE_COBRO',
  'COMISION_NO_CUADRA',
  'COBRO_MONEDA_DISTINTA',
  'COBRO_CONCILIADO',
] as const;
export type CodigoErrorCobros = (typeof CODIGOS_ERROR_COBROS)[number];

/**
 * Marca de compatibilidad con la que los códigos NUEVOS de la BD (0.0.78)
 * cierran su message: un API ≤ 0.0.77 no los conoce y busca un código
 * DENTRO del texto ⇒ los toma como ABONO_NO_CUADRA (409 genérico, no 500).
 * `leerErrorCobros` la retira del texto.
 */
export const TOKEN_ABONO_NO_CUADRA = ' [ABONO_NO_CUADRA]';

/** Redondeo a centavos (evita 0.30000000000000004). */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Cobro tal como lo ve la pre-validación (lo mínimo). */
export interface CobroParaLote {
  id: string;
  monto: number | string;
  moneda: string | null;
  comision_banco_monto?: number | string | null;
  folio?: number | null;
  cobro_grupo_id?: unknown;
  ingreso_anticipo_id?: unknown;
  /**
   * ADITIVOS (0.0.78, invariante 77): el T.C. del cobro y el del vuelo (la
   * referencia del ±2 % de un abono en OTRA moneda) y las partes de los
   * OTROS abonos del cobro (SIN las de este abono; ausente = sin otras).
   */
  tc_usd_mxn?: number | string | null;
  tc_vuelo?: number | string | null;
  otras?: ReadonlyArray<ParteCobroBanco>;
}

/** Códigos con los que `puedeLigarCobros` rechaza (los de la BD, mismo `details`). */
export type CodigoRechazoLoteCobros = Extract<
  CodigoErrorCobros,
  | 'LOTE_INVALIDO'
  | 'COBRO_INVALIDO'
  | 'COBRO_DE_GRUPO'
  | 'COBRO_DE_ANTICIPO'
  | 'LOTE_MONEDA_DISTINTA'
  | 'ABONO_NO_CUADRA'
  | 'ABONO_EXCEDE_COBRO'
  | 'COMISION_NO_CUADRA'
  | 'COBRO_MONEDA_DISTINTA'
  | 'COBRO_YA_CONCILIADO'
>;

export type VeredictoLoteCobros =
  | {
      ok: true;
      /**
       * Partes que escribiría la RPC (en el orden pedido) y lo que le
       * faltaba a cada cobro FUERA de este abono (invariante 77).
       */
      partes: Array<{
        cobro_id: string;
        monto_parte: number;
        faltante: number;
      }>;
      /** Σ de lo que les faltaba a los cobros (sin otros abonos = Σ netos). */
      suma: number;
      diferencia: number;
      tolerancia: number;
      /** Solo con UN cobro: el veredicto del espejo del trigger A (PARCIAL o CONCILIADO). */
      al_vincular?: AlVincular;
    }
  | {
      ok: false;
      codigo: CodigoRechazoLoteCobros;
      mensaje: string;
      details: Record<string, unknown>;
    };

/**
 * ESPEJO de la RPC G + el trigger A (20261014000003, invariante 77), con el
 * MISMO código y `details` que lanzaría la BD (el primer rechazo):
 * - cada cobro: reembolso (COBRO_INVALIDO), parte de sobre (COBRO_DE_GRUPO),
 *   de anticipo (COBRO_DE_ANTICIPO) y, en un lote, otra moneda
 *   (LOTE_MONEDA_DISTINTA);
 * - UN cobro ⇒ `alVincularAbono` (parte = |abono|): de más
 *   (ABONO_EXCEDE_COBRO), comisión o pasarela que no cuadra con el neto
 *   (COMISION_NO_CUADRA), otra moneda fuera de la banda 15–25 o a más de
 *   `toleranciaTcPct` del T.C. del cobro/vuelo (COBRO_MONEDA_DISTINTA), ya
 *   cubierto o «de un solo abono» con otro (COBRO_YA_CONCILIADO
 *   CUBIERTO | UN_SOLO_ABONO); un abono MENOR deja el cobro PARCIAL (ok);
 * - N ≥ 2 (lote) ⇒ cubierto o «de un solo abono» con otros ⇒
 *   COBRO_YA_CONCILIADO; parte = lo que le FALTA a cada cobro fuera de este
 *   abono y |Σ − |abono|| ≤ tolerancia_lote(N) (ABONO_NO_CUADRA con
 *   `cobros[i]` {neto, suma_otras, abonos_otros, faltante, parte}).
 * `toleranciaTcPct` ausente ⇒ solo la banda (como la BD).
 */
export function puedeLigarCobros(input: {
  montoAbono: number | string;
  monedaCuenta: string | null;
  /** Tipo de la cuenta del abono (BANCO | PASARELA): la pasarela concilia UN abono = neto. */
  tipoCuenta?: string | null;
  /** ±% del T.C. de referencia para un abono en otra moneda (`TOLERANCIA_TC_OFICIAL_PCT`). */
  toleranciaTcPct?: number | null;
  cobros: ReadonlyArray<CobroParaLote>;
}): VeredictoLoteCobros {
  const monto = r2(Math.abs(Number(input.montoAbono) || 0));
  const cobros = input.cobros;
  const n = cobros.length;
  if (n === 0 || n > LOTE_COBROS_MAX) {
    return {
      ok: false,
      codigo: 'LOTE_INVALIDO',
      mensaje:
        n === 0
          ? 'Elige al menos un cobro.'
          : `Un abono paga a lo más ${LOTE_COBROS_MAX} cobros.`,
      details: { n },
    };
  }
  const folioDe = (c: CobroParaLote) =>
    c.folio == null ? '?' : String(c.folio);
  // (1) Candados de cada cobro (los de G, en el orden pedido).
  for (const c of cobros) {
    const m = Number(c.monto) || 0;
    if (m <= 0) {
      return {
        ok: false,
        codigo: 'COBRO_INVALIDO',
        mensaje: `El cobro del vuelo #${folioDe(c)} es un reembolso (monto negativo): sale como cargo en el banco, no como abono.`,
        details: { cobro_id: c.id, folio: c.folio ?? null, monto: m },
      };
    }
    if (typeof c.cobro_grupo_id === 'string' && c.cobro_grupo_id) {
      return {
        ok: false,
        codigo: 'COBRO_DE_GRUPO',
        mensaje: `El cobro del vuelo #${folioDe(c)} es parte del sobre de un grupo: concilia el abono contra el sobre del grupo, no contra sus partes.`,
        details: {
          cobro_id: c.id,
          folio: c.folio ?? null,
          cobro_grupo_id: c.cobro_grupo_id,
        },
      };
    }
    if (typeof c.ingreso_anticipo_id === 'string' && c.ingreso_anticipo_id) {
      return {
        ok: false,
        codigo: 'COBRO_DE_ANTICIPO',
        mensaje: `El cobro del vuelo #${folioDe(c)} salió de un anticipo: su dinero se concilia una sola vez, como anticipo.`,
        details: {
          cobro_id: c.id,
          folio: c.folio ?? null,
          ingreso_anticipo_id: c.ingreso_anticipo_id,
        },
      };
    }
    if (
      n >= 2 &&
      input.monedaCuenta &&
      c.moneda &&
      c.moneda !== input.monedaCuenta
    ) {
      return {
        ok: false,
        codigo: 'LOTE_MONEDA_DISTINTA',
        mensaje: `El cobro del vuelo #${folioDe(c)} está en ${c.moneda} y la cuenta en ${input.monedaCuenta}: cuando un abono paga varios cobros, todos van en la moneda de la cuenta.`,
        details: {
          cobro_id: c.id,
          folio: c.folio ?? null,
          moneda_cobro: c.moneda,
          moneda_cuenta: input.monedaCuenta,
        },
      };
    }
  }
  const pasarela = input.tipoCuenta === 'PASARELA';
  if (n === 1) {
    return veredictoUnCobro(cobros[0], {
      monto,
      monedaCuenta: input.monedaCuenta,
      pasarela,
      toleranciaTcPct: input.toleranciaTcPct ?? Number.POSITIVE_INFINITY,
    });
  }
  // (2) LOTE: cada cobro entra por lo que le FALTA fuera de este abono.
  let suma = 0;
  const partes: Array<{
    cobro_id: string;
    monto_parte: number;
    faltante: number;
  }> = [];
  const detalle: Array<Record<string, unknown>> = [];
  for (const c of cobros) {
    const otras = c.otras ?? [];
    const cob = coberturaCobro(c, otras);
    if (otras.length > 0) {
      const rechazo = rechazoPorOtrosAbonos(c, otras, {
        cruzada: input.monedaCuenta != null && c.moneda !== input.monedaCuenta,
        pasarela,
      });
      if (rechazo) return rechazo;
    }
    const faltante =
      otras.length === 0 ? cob.neto : Math.max(r2(cob.neto - cob.suma), 0);
    suma = r2(suma + faltante);
    partes.push({ cobro_id: c.id, monto_parte: faltante, faltante });
    detalle.push({
      id: c.id,
      folio: c.folio ?? null,
      monto: r2(Number(c.monto) || 0),
      neto: cob.neto,
      suma_otras: cob.suma,
      abonos_otros: otras.length,
      faltante,
      parte: faltante,
    });
  }
  const tolerancia = toleranciaLote(n);
  const diferencia = r2(monto - suma);
  if (Math.abs(diferencia) > tolerancia + EPSILON_COBRO_BANCO) {
    return {
      ok: false,
      codigo: 'ABONO_NO_CUADRA',
      mensaje: mensajeAbonoNoCuadra({
        n,
        suma,
        monto_abono: monto,
        diferencia,
        tolerancia,
        moneda: input.monedaCuenta,
        porFaltante: detalle.some((d) => Number(d.abonos_otros) > 0),
      }),
      details: {
        monto_abono: monto,
        suma_cobros: suma,
        diferencia,
        tolerancia,
        moneda: input.monedaCuenta,
        cobros: detalle,
      },
    };
  }
  return { ok: true, partes, suma, diferencia, tolerancia };
}

/**
 * `details` del COBRO_YA_CONCILIADO de la BD (A y G: neto, suma_ligada,
 * abonos_otros, movimiento_ids por antigüedad y `movimiento_id` = el más
 * antiguo, compatible) + `moneda` y `abonos_detalle` para el texto.
 */
function detallesOtrosAbonos(
  c: CobroParaLote,
  otras: ReadonlyArray<ParteCobroBanco>,
): Record<string, unknown> {
  const cob = coberturaCobro(c, otras);
  const movs = cob.movimiento_ids;
  return {
    cobro_id: c.id,
    folio: c.folio ?? null,
    neto: cob.neto,
    suma_ligada: cob.suma,
    abonos_otros: otras.length,
    movimiento_ids: movs,
    movimiento_id: movs[0] ?? null,
    moneda: c.moneda,
    abonos_detalle: abonosCortos(otras),
  };
}

/** Partes de otros abonos en corto (fecha y monto) para el texto del 409. */
function abonosCortos(
  partes: ReadonlyArray<ParteCobroBanco>,
): Array<{ movimiento_id: string; fecha: string | null; monto_parte: number }> {
  return ordenarPartesPorAntiguedad(partes).map((p) => ({
    movimiento_id: p.movimiento_id,
    fecha: p.fecha,
    monto_parte: p.monto_parte,
  }));
}

/**
 * COBRO_YA_CONCILIADO por los OTROS abonos del cobro (el bloque «con
 * otras» de A y G): cubierto o con uno en otra moneda ⇒ CUBIERTO; «de un
 * solo abono» (comisión, abono de pasarela o en otra moneda, otro abono de
 * la pasarela) ⇒ UN_SOLO_ABONO con `por`. null = puede recibir este abono.
 * `details` = el de la BD + `moneda` y `abonos_detalle` (fechas y montos,
 * para el texto; la BD solo manda ids).
 */
function rechazoPorOtrosAbonos(
  c: CobroParaLote,
  otras: ReadonlyArray<ParteCobroBanco>,
  abono: { cruzada: boolean; pasarela: boolean },
): Extract<VeredictoLoteCobros, { ok: false }> | null {
  const cob = coberturaCobro(c, otras);
  const comun = detallesOtrosAbonos(c, otras);
  if (cob.cruzado || cubreCobro(cob.neto, otras.length, false, cob.suma)) {
    const details = { ...comun, motivo: 'CUBIERTO' };
    return {
      ok: false,
      codigo: 'COBRO_YA_CONCILIADO',
      mensaje: mensajeErrorCobros('COBRO_YA_CONCILIADO', details, ''),
      details,
    };
  }
  const comision = (Number(c.comision_banco_monto) || 0) > 0;
  if (comision || abono.pasarela || abono.cruzada || cob.pasarela) {
    const por = abono.cruzada
      ? 'MONEDA_DISTINTA'
      : abono.pasarela || cob.pasarela
        ? 'PASARELA'
        : 'COMISION';
    const details = { ...comun, motivo: 'UN_SOLO_ABONO', por };
    return {
      ok: false,
      codigo: 'COBRO_YA_CONCILIADO',
      mensaje: mensajeErrorCobros('COBRO_YA_CONCILIADO', details, ''),
      details,
    };
  }
  return null;
}

/**
 * UN cobro: el espejo del trigger A (`alVincularAbono`) traducido a los
 * códigos y `details` de la BD. PARCIAL o CONCILIADO ⇒ ok con parte =
 * |abono| (el panel confirma el parcial; la BD no exige bandera, D3).
 */
function veredictoUnCobro(
  c: CobroParaLote,
  abono: {
    monto: number;
    monedaCuenta: string | null;
    pasarela: boolean;
    toleranciaTcPct: number;
  },
): VeredictoLoteCobros {
  const otras = c.otras ?? [];
  const al = alVincularAbono({
    cobro: c,
    tcVuelo: normalizarTc(c.tc_vuelo ?? null),
    otras,
    abono: {
      monto: abono.monto,
      moneda_cuenta: abono.monedaCuenta,
      pasarela: abono.pasarela,
    },
    toleranciaTcPct: abono.toleranciaTcPct,
  });
  const cob = coberturaCobro(c, otras);
  const montoCobro = r2(Number(c.monto) || 0);
  const folio = c.folio ?? null;
  const rechazo = (
    codigo: CodigoRechazoLoteCobros,
    details: Record<string, unknown>,
  ): VeredictoLoteCobros => ({
    ok: false,
    codigo,
    mensaje: mensajeErrorCobros(codigo, details, ''),
    details,
  });
  switch (al.estado) {
    case 'YA_CUBIERTO':
      return rechazo('COBRO_YA_CONCILIADO', {
        ...detallesOtrosAbonos(c, otras),
        motivo: 'CUBIERTO',
      });
    case 'UN_SOLO_ABONO':
      return rechazo('COBRO_YA_CONCILIADO', {
        ...detallesOtrosAbonos(c, otras),
        motivo: 'UN_SOLO_ABONO',
        por: al.motivo,
      });
    case 'MONEDA_DISTINTA':
      return rechazo('COBRO_MONEDA_DISTINTA', {
        cobro_id: c.id,
        folio,
        motivo: al.motivo,
        moneda_cobro: c.moneda,
        moneda_cuenta: abono.monedaCuenta,
        neto: cob.neto,
        parte: abono.monto,
        tc_implicito: al.tc_implicito,
        tc_referencia: al.tc_referencia,
        desvio_pct: al.desvio_pct,
        tc_min: TC_COBRO_MIN,
        tc_max: TC_COBRO_MAX,
        tc_referencia_origen:
          al.tc_referencia == null
            ? null
            : normalizarTc(c.tc_usd_mxn ?? null) != null
              ? 'COBRO'
              : 'VUELO',
      });
    case 'EXCEDE':
      return rechazo('ABONO_EXCEDE_COBRO', {
        cobro_id: c.id,
        folio,
        moneda: c.moneda,
        monto_cobro: montoCobro,
        neto: cob.neto,
        suma_otras: cob.suma,
        abonos_otros: otras.length,
        parte: abono.monto,
        faltante: al.faltante_antes,
        excedente: al.sobrante,
        un_solo: al.un_solo,
      });
    case 'COMISION_NO_CUADRA': {
      const comisionReal = al.comision_real ?? 0;
      const corregir = comisionRealParaCorregir(montoCobro, abono.monto);
      return rechazo('COMISION_NO_CUADRA', {
        cobro_id: c.id,
        folio,
        moneda: c.moneda,
        monto_cobro: montoCobro,
        comision_capturada: r2(
          (Number(c.comision_banco_monto) || 0) > 0
            ? Number(c.comision_banco_monto)
            : 0,
        ),
        neto: cob.neto,
        parte: abono.monto,
        comision_real: comisionReal,
        comision_real_pct:
          montoCobro > 0 ? r2((comisionReal / montoCobro) * 100) : null,
        por: al.motivo,
        corregible: otras.length === 0 && corregir.valida,
      });
    }
    case 'PARCIAL':
    case 'CONCILIADO':
      break;
  }
  return {
    ok: true,
    partes: [
      {
        cobro_id: c.id,
        monto_parte: abono.monto,
        faltante: al.faltante_antes,
      },
    ],
    suma: al.faltante_antes,
    diferencia: r2(abono.monto - al.faltante_antes),
    tolerancia: 0,
    al_vincular: al,
  };
}

/**
 * Por qué no aplica «Corregir la comisión y vincular» (400
 * CORREGIR_COMISION_NO_APLICA). `PARCIAL` y `NO_HACE_FALTA` (revisión del
 * 15-oct-2026): el veredicto SIN corregir no es COMISION_NO_CUADRA.
 */
export type MotivoCorregirComisionNoAplica =
  | 'VARIOS_COBROS'
  | 'SOBRE'
  | 'CON_ABONOS'
  | 'DEPOSITO_MAYOR'
  | 'SIN_COBRO'
  | 'MONEDA_DISTINTA'
  | 'DEPOSITO_INVALIDO'
  | 'PARCIAL'
  | 'NO_HACE_FALTA';

/**
 * La comisión REAL que «Corregir la comisión y vincular» escribiría:
 * r2(monto − |abono|), un centavo de ruido ⇒ 0. Vale si 0 ≤ comisión <
 * monto; un depósito MAYOR que el cobro ⇒ DEPOSITO_MAYOR (eso es un abono
 * de más, no una comisión); un depósito en 0 ⇒ DEPOSITO_INVALIDO.
 */
export function comisionRealParaCorregir(
  montoCobro: number | string,
  montoAbono: number | string,
): {
  valida: boolean;
  comision: number;
  motivo: MotivoCorregirComisionNoAplica | null;
} {
  const monto = r2(Number(montoCobro) || 0);
  let x = r2(monto - r2(Math.abs(Number(montoAbono) || 0)));
  if (Math.abs(x) <= 0.01) x = 0;
  if (x < 0) return { valida: false, comision: x, motivo: 'DEPOSITO_MAYOR' };
  if (!(x < monto)) {
    return { valida: false, comision: x, motivo: 'DEPOSITO_INVALIDO' };
  }
  return { valida: true, comision: x, motivo: null };
}

/** Texto es-MX del 400 CORREGIR_COMISION_NO_APLICA. */
export function mensajeCorregirComisionNoAplica(
  motivo: MotivoCorregirComisionNoAplica,
): string {
  if (motivo === 'PARCIAL') {
    return 'Este cobro no tiene comisión del banco: un depósito menor es un pago parcial, no una comisión. Vincúlalo sin corregir (quedará «Conciliado parcial» hasta que llegue lo que falta) o, si de verdad hubo comisión, captúrala en el cobro del vuelo.';
  }
  if (motivo === 'NO_HACE_FALTA') {
    return 'El depósito ya cuadra con lo que espera el cobro: vincúlalo sin corregir la comisión.';
  }
  const base =
    'La comisión solo se corrige al vincular UN cobro de vuelo que todavía no tiene abonos, cuando el depósito es menor o igual que el cobro.';
  if (motivo === 'MONEDA_DISTINTA') {
    return `${base} El depósito está en otra moneda que el cobro: corrige el cobro en el vuelo.`;
  }
  return base;
}

/** Lo que decide `decidirCorregirComision` (sin escribir nada). */
export type DecisionCorregirComision =
  | { aplica: true; comision: number }
  | { aplica: false; motivo: MotivoCorregirComisionNoAplica }
  | { aplica: false; rechazo: Extract<VeredictoLoteCobros, { ok: false }> };

/**
 * ¿Aplica «Corregir la comisión y vincular» a ESTE abono y ESTE cobro?
 * (0.0.78, D6; ENDURECIDA en la revisión del 15-oct-2026: el API es el
 * candado, no el botón del panel). SOLO cuando el veredicto SIN corregir
 * —`puedeLigarCobros` con la comisión VIGENTE, el mismo de la liga— es
 * COMISION_NO_CUADRA (comisión capturada o abono de la pasarela) y la
 * comisión real vale (= `details.corregible`). En orden, y sin escribir:
 * - el cobro ya tiene abonos (este incluido) ⇒ CON_ABONOS;
 * - la cuenta está en otra moneda ⇒ MONEDA_DISTINTA;
 * - cualquier otro rechazo del veredicto (parte de un sobre, cobro de un
 *   anticipo, reembolso, abono de más…) ⇒ `rechazo`: ESE 409/400, el mismo
 *   que sin la bandera (antes la comisión se escribía y el rechazo llegaba
 *   después: la PARTE de un sobre perdía el reparto de su comisión);
 * - el abono ya cuadra ⇒ NO_HACE_FALTA; dejaría el cobro PARCIAL (banco sin
 *   comisión: un pago en partes, no una comisión) ⇒ PARCIAL;
 * - depósito mayor que el cobro o en 0 ⇒ DEPOSITO_MAYOR / DEPOSITO_INVALIDO
 *   (`comisionRealParaCorregir`).
 */
export function decidirCorregirComision(i: {
  cobro: CobroParaLote;
  /** Partes de TODOS los abonos del cobro (este incluido). */
  nPartes: number;
  montoAbono: number | string;
  monedaCuenta: string | null;
  tipoCuenta?: string | null;
  toleranciaTcPct?: number | null;
}): DecisionCorregirComision {
  if (i.nPartes > 0) return { aplica: false, motivo: 'CON_ABONOS' };
  if (i.cobro.moneda !== i.monedaCuenta) {
    return { aplica: false, motivo: 'MONEDA_DISTINTA' };
  }
  const v = puedeLigarCobros({
    montoAbono: i.montoAbono,
    monedaCuenta: i.monedaCuenta,
    tipoCuenta: i.tipoCuenta,
    toleranciaTcPct: i.toleranciaTcPct,
    cobros: [i.cobro],
  });
  if (v.ok) {
    return {
      aplica: false,
      motivo: v.al_vincular?.estado === 'PARCIAL' ? 'PARCIAL' : 'NO_HACE_FALTA',
    };
  }
  if (v.codigo !== 'COMISION_NO_CUADRA') return { aplica: false, rechazo: v };
  const real = comisionRealParaCorregir(i.cobro.monto, i.montoAbono);
  if (!real.valida) {
    return { aplica: false, motivo: real.motivo ?? 'DEPOSITO_MAYOR' };
  }
  return { aplica: true, comision: real.comision };
}

/** Un cobro sugerido para completar un abono que EXCEDE a su cobro (D4). */
export interface SugeridoCobro {
  cobro_id: string;
  vuelo_id: string | null;
  folio: number | null;
  cliente: string | null;
  fecha_cobro: string | null;
  monto: number;
  moneda: string | null;
  /** Lo que le falta FUERA de este abono (sin abonos = su neto). */
  faltante: number;
}

/** Tope de sugeridos por 409 / candidato (D4). */
export const SUGERIDOS_MAX = 3;
/** ±centavos con los que un faltante «es» el excedente (D4). */
export const TOLERANCIA_SUGERIDO = 0.02;

/**
 * Sugeridos de un ABONO_EXCEDE_COBRO (D4): del universo de «Vincular» (los
 * cobros SIN cubrir de la cuenta, en su moneda, ±60 días: quien llama ya
 * quitó los ocupados), los que les FALTA ≈ el excedente (±0.02), por
 * cercanía de su fecha a la del abono (y fecha, id), sin `excluir`; ≤ 3.
 */
export function sugeridosParaExcedente(
  universo: ReadonlyArray<SugeridoCobro>,
  excedente: number,
  fechaAbono: string | null,
  excluir: Iterable<string> = [],
): SugeridoCobro[] {
  const exc = r2(Number(excedente) || 0);
  if (!(exc > 0)) return [];
  const fuera = new Set(excluir);
  const ref = fechaAbono
    ? Date.parse(`${fechaAbono.slice(0, 10)}T00:00:00Z`)
    : NaN;
  const dist = (s: SugeridoCobro): number => {
    const t = s.fecha_cobro ? Date.parse(s.fecha_cobro) : NaN;
    return Number.isFinite(t) && Number.isFinite(ref)
      ? Math.abs(t - ref)
      : Number.POSITIVE_INFINITY;
  };
  const vistos = new Set<string>();
  return universo
    .filter((s) => {
      if (fuera.has(s.cobro_id) || vistos.has(s.cobro_id)) return false;
      const f = r2(Number(s.faltante) || 0);
      if (!(f > 0)) return false;
      if (Math.abs(f - exc) > TOLERANCIA_SUGERIDO + EPSILON_COBRO_BANCO) {
        return false;
      }
      vistos.add(s.cobro_id);
      return true;
    })
    .sort(
      (a, b) =>
        dist(a) - dist(b) ||
        String(a.fecha_cobro ?? '').localeCompare(
          String(b.fecha_cobro ?? ''),
        ) ||
        a.cobro_id.localeCompare(b.cobro_id),
    )
    .slice(0, SUGERIDOS_MAX);
}

/**
 * ¿El cobro está OCUPADO para ESTE abono (no es candidato ni sugerido)? Sin
 * la sonda de 20261014000003: con cualquier liga de OTRO abono (como el
 * 0.0.77). Con ella: cubierto por los otros abonos o con uno en otra moneda;
 * para un abono de la PASARELA, con cualquier otro abono (la pasarela no
 * recibe parciales: un cobro de la pasarela es «de un solo abono»).
 */
export function cobroOcupadoParaAbono(
  c: CobroParaCobertura,
  partes: ReadonlyArray<ParteCobroBanco>,
  movimientoId: string,
  opts: { conParciales: boolean; pasarela: boolean },
): boolean {
  const f = faltanteFueraDe(c, partes, movimientoId);
  if (f.n_otras === 0) return false;
  if (!opts.conParciales) return true;
  return f.cubierto_por_otras || f.cruzado_otras || opts.pasarela;
}

/** Cómo entra un cobro de vuelo al universo AUTOMÁTICO de un abono. */
export interface CobroParaCruce {
  /** false = ocupado para este abono (no es candidato del auto). */
  libre: boolean;
  /**
   * Cobro PARCIAL: lo que le FALTA fuera de este abono (solo cuadra por ese
   * monto exacto). null = sin otros abonos (cuadra por neto/bruto).
   */
  faltante: number | null;
}

/**
 * ¿Cómo entra un cobro al universo del AUTO-CRUCE de un abono (D11) y de los
 * frenos anti doble conteo (D12: `cobrosExactosLibresDeAbono`, Ingresos)?
 * (invariante 77). Sobre `cobroOcupadoParaAbono` (la MISMA regla de los
 * candidatos y los sugeridos):
 * - sin otros abonos ⇒ libre, `faltante: null` (neto/bruto, como siempre);
 * - ocupado para «Vincular» (sin la sonda de 20261014000003: cualquier otro
 *   abono; con ella: cubierto, con un abono en otra moneda, o este abono
 *   es de la PASARELA, que no recibe parciales) ⇒ ocupado;
 * - parcial «de un solo abono» ⇒ ocupado: no admite otro abono. Para LIGAR
 *   (el auto-cruce, por omisión) es `cobroDeUnSoloAbono`: comisión
 *   capturada, parte de la pasarela o cruzada y también el MÉTODO PAYWISE
 *   (el auto no adivina: a mano sí se completa). Con `freno: true` (los
 *   frenos anti doble conteo, que solo AVISAN; revisión del 15-oct-2026) es
 *   la regla del trigger A sin el método (`cobroDeUnSoloAbonoSegunA`): un
 *   parcial que la BD sí deja completar todavía espera ese dinero;
 * - parcial de BANCO ⇒ libre con `faltante` = lo que le falta FUERA de este
 *   abono (`faltanteFueraDe`). Quien llama solo lo liga si el abono es
 *   EXACTAMENTE ese faltante: el auto nunca crea un parcial.
 * `movimientoId` null = un abono sin ligas (nada que excluir).
 */
export function cobroParaCruce(
  c: CobroParaCobertura & { metodo_cobro?: unknown },
  partes: ReadonlyArray<ParteCobroBanco>,
  movimientoId: string | null,
  opts: { conParciales: boolean; pasarela: boolean; freno?: boolean },
): CobroParaCruce {
  const movId = movimientoId ?? '';
  const f = faltanteFueraDe(c, partes, movId);
  if (f.n_otras === 0) return { libre: true, faltante: null };
  const unSolo =
    opts.freno === true
      ? cobroDeUnSoloAbonoSegunA(c, f.otras)
      : cobroDeUnSoloAbono(c, f.otras);
  if (cobroOcupadoParaAbono(c, partes, movId, opts) || unSolo) {
    return { libre: false, faltante: null };
  }
  return { libre: true, faltante: f.faltante };
}

/** Lo que el API decide al vincular un abono con un SOBRE de grupo (D8). */
export interface AlVincularSobre {
  estado: 'CONCILIADO' | 'SOBRE_NO_CUADRA';
  /** |abono| − neto del sobre (> 0: sobra; < 0: falta). */
  diferencia: number;
  neto: number;
}

/**
 * Regla NUEVA del sobre (D8, solo en el API: el neto del sobre vive en
 * `cobro_grupo`): abono de una cuenta BANCO en la moneda del sobre ⇒
 * |abono| = neto del sobre (`netoDeCobro`) ± $1.00, o SOBRE_NO_CUADRA. Una
 * cuenta PASARELA, otra moneda o la cuenta sin leer ⇒ como hoy (CONCILIADO).
 */
export function alVincularSobre(i: {
  montoAbono: number | string;
  monedaCuenta: string | null;
  tipoCuenta: string | null;
  sobre: { monto?: unknown; moneda?: unknown; comision_banco_monto?: unknown };
}): AlVincularSobre {
  const neto = netoDeCobro(
    i.sobre.monto as number | string | null | undefined,
    i.sobre.comision_banco_monto as number | string | null | undefined,
  );
  const abono = r2(Math.abs(Number(i.montoAbono) || 0));
  const diferencia = r2(abono - neto);
  const aplica =
    i.tipoCuenta !== 'PASARELA' &&
    i.monedaCuenta != null &&
    i.monedaCuenta === i.sobre.moneda;
  return {
    estado:
      aplica &&
      Math.abs(diferencia) > TOLERANCIA_COBRO_BANCO + EPSILON_COBRO_BANCO
        ? 'SOBRE_NO_CUADRA'
        : 'CONCILIADO',
    diferencia,
    neto,
  };
}

function dinero(n: number, moneda?: string | null): string {
  const txt = `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return moneda ? `${txt} ${moneda}` : txt;
}

/** Texto es-MX del 409 ABONO_NO_CUADRA (lo arma el API, nunca la BD). */
export function mensajeAbonoNoCuadra(d: {
  n: number;
  suma: number;
  monto_abono: number;
  diferencia: number;
  tolerancia: number;
  moneda?: string | null;
  /**
   * Algún cobro del lote ya tenía abonos (invariante 77): cada uno entra por
   * lo que le FALTA y el texto lo dice; sin eso, el texto de siempre.
   */
  porFaltante?: boolean;
}): string {
  if (d.porFaltante === true) {
    const sobran = d.diferencia > 0;
    return (
      `A los ${d.n} cobros les faltan ${dinero(d.suma, d.moneda)} (lo que le falta a cada uno) ` +
      `y el abono es de ${dinero(d.monto_abono, d.moneda)}: ${sobran ? 'sobran' : 'faltan'} ` +
      `${dinero(Math.abs(d.diferencia), d.moneda)} (se admite hasta ` +
      `${dinero(d.tolerancia)} de diferencia por redondeos). ` +
      'Revisa qué cobros paga este abono o corrige el monto o la comisión de alguno.'
    );
  }
  const faltan = d.diferencia > 0;
  return (
    `Los ${d.n} cobros suman ${dinero(d.suma, d.moneda)} y el abono es de ` +
    `${dinero(d.monto_abono, d.moneda)}: ${faltan ? 'faltan' : 'sobran'} ` +
    `${dinero(Math.abs(d.diferencia), d.moneda)} (se admite hasta ` +
    `${dinero(d.tolerancia, d.moneda)} de diferencia por redondeos). ` +
    'Revisa qué cobros paga este abono o corrige el monto o la comisión de alguno.'
  );
}

/** Error de PostgREST/RPC como llega al service. */
export interface ErrorCobrosLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
  details?: string | null;
}

/**
 * Lee `{codigo, texto, details}` de un error de la RPC: el código sale del
 * `hint` (o del prefijo «CODIGO:» del mensaje), el `detail` es JSON. El
 * `texto` sale sin el prefijo y sin la marca « [ABONO_NO_CUADRA]» de los
 * códigos nuevos (invariante 77). `codigos` (por defecto la lista de hoy)
 * solo cambia en el spec que prueba la compatibilidad con el 0.0.77.
 */
export function leerErrorCobros(
  err: ErrorCobrosLike | null | undefined,
  codigos: ReadonlyArray<CodigoErrorCobros> = CODIGOS_ERROR_COBROS,
): {
  codigo: CodigoErrorCobros | null;
  texto: string;
  details: Record<string, unknown> | null;
} {
  const msg = String(err?.message ?? '');
  const esCodigo = (c: unknown): c is CodigoErrorCobros =>
    typeof c === 'string' && (codigos as readonly string[]).includes(c);
  const hint = typeof err?.hint === 'string' ? err.hint.trim() : '';
  const prefijo = /^\s*([A-Z][A-Z_]+)\s*:/.exec(msg)?.[1];
  const codigo = esCodigo(hint)
    ? hint
    : esCodigo(prefijo)
      ? prefijo
      : (codigos.find((c) => msg.includes(c)) ?? null);
  let details: Record<string, unknown> | null = null;
  if (typeof err?.details === 'string' && err.details.trim().startsWith('{')) {
    try {
      const v: unknown = JSON.parse(err.details);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        details = v as Record<string, unknown>;
      }
    } catch {
      details = null;
    }
  }
  return {
    codigo,
    texto: msg
      .replace(/^\s*[A-Z][A-Z_]+\s*:\s*/, '')
      .replace(/\s*\[ABONO_NO_CUADRA\]\s*$/, '')
      .trim(),
    details,
  };
}

/** Texto plano de un detalle (número o cadena); lo demás ⇒ el respaldo. */
function textoDe(v: unknown, respaldo = '?'): string {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return respaldo;
}

function num(
  details: Record<string, unknown> | null,
  k: string,
): number | null {
  const v = details?.[k];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function textoONull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** «15 sep · $1,700.00 y 16 sep · $1,700.00» (lista corta de abonos). */
function listaAbonos(
  abonos: ReadonlyArray<{ fecha?: unknown; monto_parte?: unknown }>,
): string {
  const items = abonos.map(
    (a) =>
      `${fechaCortaEs(textoONull(a.fecha)) ?? '?'} · ${dinero(Number(a.monto_parte) || 0)}`,
  );
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/** Abonos ya ligados de un `details` (lista corta que el API agrega; la BD no la manda). */
function abonosDeDetails(
  details: Record<string, unknown> | null,
): Array<{ fecha?: unknown; monto_parte?: unknown }> {
  const v = details?.abonos_detalle;
  return Array.isArray(v)
    ? v.filter(
        (x): x is { fecha?: unknown; monto_parte?: unknown } =>
          !!x && typeof x === 'object',
      )
    : [];
}

const CONSEJO_EXCEDE =
  'Si el depósito también pagó otro vuelo, márcalo junto con este para que la suma cuadre con el abono; si el cobro está mal capturado, corrígelo antes de vincular.';

/**
 * 409 ABONO_EXCEDE_COBRO (invariante 77): el abono es MAYOR que lo que le
 * falta al cobro (+ $1.00). Tres redacciones: cobro «de un solo abono»
 * (comisión o pasarela), cobro con abonos previos y primer abono.
 */
export function mensajeAbonoExcedeCobro(d: {
  folio?: unknown;
  moneda?: string | null;
  monto_cobro?: number | null;
  neto?: number | null;
  suma_otras?: number | null;
  abonos_otros?: number | null;
  parte?: number | null;
  faltante?: number | null;
  excedente?: number | null;
  un_solo?: boolean | null;
}): string {
  const folio = textoDe(d.folio);
  const m = d.moneda ?? null;
  if (d.parte == null || d.excedente == null) {
    return `Este abono es mayor que lo que falta del cobro del vuelo #${folio}. ${CONSEJO_EXCEDE}`;
  }
  if (d.un_solo === true) {
    return (
      `Este abono (${dinero(d.parte, m)}) es mayor que el cobro del vuelo #${folio}` +
      `${d.monto_cobro != null ? ` (${dinero(d.monto_cobro, m)})` : ''}, que se concilia con un solo depósito: ` +
      `sobran ${dinero(d.excedente, m)} sobre lo esperado. Revisa si el depósito pagó también otro vuelo o si el cobro está mal capturado.`
    );
  }
  if ((d.abonos_otros ?? 0) > 0 && d.suma_otras != null && d.faltante != null) {
    return (
      `Al cobro del vuelo #${folio}${d.neto != null ? ` (${dinero(d.neto, m)})` : ''} ya le vincularon ` +
      `${dinero(d.suma_otras, m)} y le faltan ${dinero(d.faltante, m)}; este abono es de ` +
      `${dinero(d.parte, m)}: sobran ${dinero(d.excedente, m)}. ${CONSEJO_EXCEDE}`
    );
  }
  return (
    `Este abono (${dinero(d.parte, m)}) es mayor que lo que falta del cobro del vuelo #${folio}` +
    `${d.faltante != null ? ` (${dinero(d.faltante, m)})` : ''}: sobran ${dinero(d.excedente, m)}. ${CONSEJO_EXCEDE}`
  );
}

/**
 * 409 COMISION_NO_CUADRA (invariante 77): un cobro con comisión (o pagado
 * por la pasarela) se concilia con UN abono = su neto ± $1.00; la diferencia
 * casi siempre es una comisión mal provisionada.
 */
export function mensajeComisionNoCuadra(d: {
  folio?: unknown;
  moneda?: string | null;
  monto_cobro?: number | null;
  comision_capturada?: number | null;
  neto?: number | null;
  parte?: number | null;
  comision_real?: number | null;
  /**
   * `false` (0.0.78): «Corregir la comisión y vincular» no aplica (el cobro
   * ya tiene abonos o el depósito rebasa el cobro) y el texto no la ofrece.
   * Ausente = como siempre.
   */
  corregible?: boolean | null;
}): string {
  const folio = textoDe(d.folio);
  const m = d.moneda ?? null;
  if (d.neto == null || d.parte == null || d.comision_real == null) {
    return `El depósito no cuadra con lo que espera el cobro del vuelo #${folio} después de la comisión: corrige la comisión del cobro antes de vincular.`;
  }
  const capturadaTxt =
    (d.comision_capturada ?? 0) > 0
      ? ` después de la comisión registrada (${dinero(d.comision_capturada ?? 0)})`
      : '';
  if (d.monto_cobro != null && d.parte > d.monto_cobro + 0.01) {
    // El banco depositó MÁS que el cobro (hasta $1.00): no hay comisión que
    // corregir hacia arriba; la registrada sobra.
    return (
      `El cobro del vuelo #${folio} (${dinero(d.monto_cobro, m)}) espera un depósito de ` +
      `${dinero(d.neto, m)}${capturadaTxt} y el banco depositó ${dinero(d.parte, m)}, más que el cobro: ` +
      'revisa la comisión registrada (el cliente pudo pagarla aparte) y corrígela en el vuelo antes de vincular.'
    );
  }
  if (d.corregible === false) {
    return (
      `El cobro del vuelo #${folio}${d.monto_cobro != null ? ` (${dinero(d.monto_cobro, m)})` : ''} espera un depósito de ` +
      `${dinero(d.neto, m)}${capturadaTxt} y el banco depositó ${dinero(d.parte, m)}: ` +
      `la comisión real fue ${dinero(d.comision_real, m)}. Corrige la comisión del cobro en el vuelo antes de vincular.`
    );
  }
  const pct =
    d.monto_cobro != null && d.monto_cobro > 0
      ? ` (${((d.comision_real / d.monto_cobro) * 100).toFixed(2)} %)`
      : '';
  return (
    `El cobro del vuelo #${folio}${d.monto_cobro != null ? ` (${dinero(d.monto_cobro, m)})` : ''} espera un depósito de ` +
    `${dinero(d.neto, m)}${capturadaTxt} y el banco depositó ${dinero(d.parte, m)}: ` +
    // Sin nombrar un botón del panel (revisión del 15-oct-2026): el 409 lo
    // ve también quien no lo tiene a la mano (registrar un ingreso, el panel
    // de antes); el panel nuevo agrega su propia salida en la descripción.
    `la comisión real fue ${dinero(d.comision_real, m)}${pct}. Corrige la comisión del cobro antes de vincular.`
  );
}

/**
 * 409 COBRO_YA_CONCILIADO con `motivo: 'CUBIERTO'` (invariante 77): los
 * OTROS abonos ya cubren el cobro. La lista de abonos solo sale si quien
 * llama la agrega (`abonos_detalle`: la BD manda ids, no fechas).
 */
export function mensajeCobroYaCubierto(d: {
  folio?: unknown;
  neto?: number | null;
  suma_ligada?: number | null;
  abonos_otros?: number | null;
  moneda?: string | null;
  abonos_detalle?: ReadonlyArray<{ fecha?: unknown; monto_parte?: unknown }>;
}): string {
  const folio = textoDe(d.folio);
  const n = Math.max(
    1,
    Math.trunc(d.abonos_otros ?? d.abonos_detalle?.length ?? 1),
  );
  const monto = d.neto ?? d.suma_ligada;
  const lista = listaAbonos(d.abonos_detalle ?? []);
  return (
    `El cobro del vuelo #${folio} ya está conciliado completo` +
    `${monto != null ? `: ${dinero(monto, d.moneda ?? null)}` : ''} con ${n} abono${n === 1 ? '' : 's'} del banco` +
    `${lista ? ` (${lista})` : ''}. Si este abono es otro pago del mismo vuelo, regístralo como un cobro nuevo; ` +
    'si uno de los abonos se ligó por error, desvincúlalo en Conciliación.'
  );
}

/**
 * 409 COBRO_YA_CONCILIADO con `motivo: 'UN_SOLO_ABONO'` (invariante 77): el
 * cobro se concilia con UN solo abono y ya tiene otro. `por` = la razón de
 * la BD: COMISION (cobro con comisión), PASARELA (algún abono de la
 * pasarela) o MONEDA_DISTINTA (ESTE abono es de una cuenta en otra moneda).
 */
export function mensajeCobroUnSoloAbono(d: {
  folio?: unknown;
  por?: unknown;
}): string {
  const folio = textoDe(d.folio);
  if (d.por === 'PASARELA') {
    return `El cobro del vuelo #${folio} se pagó por la pasarela (Paywise) y ya tiene un depósito: en la pasarela cada pago es una transacción con su comisión. Registra el segundo pago como otro cobro del vuelo y vincúlalo a él.`;
  }
  if (d.por === 'MONEDA_DISTINTA') {
    return `El cobro del vuelo #${folio} ya tiene otro abono ligado y este abono es de una cuenta en otra moneda: un abono en otra moneda solo concilia UN cobro completo, sin otros abonos. Desvincula el otro abono en Conciliación o registra el cobro en la moneda del depósito.`;
  }
  return `El cobro del vuelo #${folio} tiene comisión bancaria y ya tiene un abono: un cobro con comisión (link de pago) se concilia con UN solo depósito. Si el cliente pagó en dos cargos, registra un cobro por cada cargo.`;
}

function desvioTexto(desvio: number): string {
  if (desvio > 0) return `+${desvio.toFixed(1)} %`;
  if (desvio < 0) return `−${Math.abs(desvio).toFixed(1)} %`;
  return '0.0 %';
}

/**
 * 409 COBRO_MONEDA_DISTINTA (invariante 77): abono en OTRA moneda con un T.C.
 * implícito fuera de la banda 15–25 (BD) o lejos del T.C. de referencia
 * (`TC_LEJOS`, solo API: ±2 % del T.C. del cobro o, sin él, del vuelo).
 */
export function mensajeCobroMonedaDistinta(d: {
  folio?: unknown;
  motivo?: unknown;
  moneda_cobro?: string | null;
  moneda_cuenta?: string | null;
  neto?: number | null;
  parte?: number | null;
  tc_implicito?: number | null;
  tc_referencia?: number | null;
  desvio_pct?: number | null;
  tc_min?: number | null;
  tc_max?: number | null;
  /** De dónde salió la referencia (por defecto, el cobro). */
  tc_referencia_origen?: 'COBRO' | 'VUELO' | null;
}): string {
  const folio = textoDe(d.folio);
  const tc = d.tc_implicito != null ? d.tc_implicito.toFixed(2) : '?';
  if (
    d.motivo === 'TC_LEJOS' &&
    d.tc_referencia != null &&
    d.desvio_pct != null
  ) {
    const abono =
      d.parte != null ? ` de ${dinero(d.parte, d.moneda_cuenta ?? null)}` : '';
    const cobro =
      d.neto != null ? ` de ${dinero(d.neto, d.moneda_cobro ?? null)}` : '';
    const de = d.tc_referencia_origen === 'VUELO' ? 'del vuelo' : 'del cobro';
    return (
      `El abono${abono} contra el cobro${cobro} del vuelo #${folio} da un tipo de cambio de ${tc}, ` +
      `lejos del T.C. ${de} (${d.tc_referencia.toFixed(2)}, ${desvioTexto(d.desvio_pct)}): ` +
      '¿el depósito pagó también otro cobro? Un abono en otra moneda solo concilia UN cobro completo; ' +
      'si así llegó el dinero, registra el cobro en la moneda del depósito.'
    );
  }
  return (
    `El cobro del vuelo #${folio} está en ${textoDe(d.moneda_cobro)} y el abono en ${textoDe(d.moneda_cuenta)}: ` +
    `el tipo de cambio que resulta (${tc}) no tiene sentido (se espera entre ${d.tc_min ?? 15} y ${d.tc_max ?? 25}). ` +
    'Revisa que sea el abono correcto.'
  );
}

/**
 * 409 COBRO_CONCILIADO (invariante 77): el dinero de un cobro con abonos
 * ligados no cambia. Sin datos ⇒ el texto de la carrera con el trigger E de
 * la BD; con los datos del candado del API (`flights.updateCobro` /
 * `deleteCobro`):
 * - vía SOBRE ⇒ «Desvincula el sobre primero» (el de siempre);
 * - PARCIAL ⇒ «conciliado PARCIAL con el banco ($1,700.00 MXN de $3,400.00
 *   MXN, abono del 15 sep)…»;
 * - 2+ abonos ⇒ «conciliado con 2 abonos del banco (15 sep · $1,700.00 y
 *   15 sep · $1,700.00)…»;
 * - 1 abono ⇒ el de siempre.
 */
export function mensajeCobroConciliado(d?: {
  via?: 'DIRECTO' | 'SOBRE' | null;
  parcial?: boolean | null;
  abonos?: ReadonlyArray<{ fecha?: unknown; monto_parte?: unknown }>;
  monto_vinculado?: number | null;
  neto?: number | null;
  moneda?: string | null;
}): string {
  if (!d) {
    return 'El cobro tiene abonos del banco vinculados: su monto, moneda, comisión, sobre o anticipo no cambian mientras esté conciliado; desvincúlalo en Conciliación primero.';
  }
  if (d.via === 'SOBRE') {
    return 'Este cobro es parte de un sobre de grupo conciliado con un movimiento bancario. Desvincula el sobre primero en Conciliación.';
  }
  const abonos = d.abonos ?? [];
  const n = abonos.length;
  const m = d.moneda ?? null;
  if (d.parcial === true && d.monto_vinculado != null && d.neto != null) {
    const fechas = abonos.map((a) => fechaCortaEs(textoONull(a.fecha)) ?? '?');
    const cuales =
      n <= 1
        ? `abono del ${fechas[0] ?? '?'}`
        : `abonos del ${fechas.slice(0, -1).join(', ')} y ${fechas[fechas.length - 1]}`;
    return (
      `Este cobro está conciliado PARCIAL con el banco (${dinero(d.monto_vinculado, m)} de ${dinero(d.neto, m)}, ${cuales}). ` +
      'Para cambiar su monto, moneda, tipo de cambio o comisión, o para eliminarlo, primero desvincula ' +
      `${n <= 1 ? 'ese abono' : 'esos abonos'} en Conciliación.`
    );
  }
  if (n >= 2) {
    return (
      `Este cobro está conciliado con ${n} abonos del banco (${listaAbonos(abonos)}). ` +
      'Para cambiar su dinero o eliminarlo, primero desvincula esos abonos en Conciliación.'
    );
  }
  return 'Este cobro está conciliado con un movimiento bancario. Desvincúlalo primero en Conciliación.';
}

/**
 * 409 SOBRE_NO_CUADRA (D8, solo API): el abono de una cuenta de banco no es
 * el neto del sobre del grupo (± $1.00).
 */
export function mensajeSobreNoCuadra(d: {
  grupo_folio?: unknown;
  monto_abono: number;
  neto_sobre: number;
  /** |abono| − neto del sobre. */
  diferencia: number;
  moneda?: string | null;
  /** El sobre trae comisión bancaria capturada. */
  con_comision?: boolean | null;
}): string {
  const m = d.moneda ?? null;
  const g = `G-${textoDe(d.grupo_folio)}`;
  const faltan = d.diferencia < 0;
  return (
    `El abono (${dinero(d.monto_abono, m)}) no cuadra con el sobre del grupo ${g} ` +
    `(${dinero(d.neto_sobre, m)}${d.con_comision === true ? ' después de la comisión' : ''}): ` +
    `${faltan ? 'faltan' : 'sobran'} ${dinero(Math.abs(d.diferencia), m)}. ` +
    'Revisa que sea el depósito del grupo o corrige el sobre antes de vincular.'
  );
}

/**
 * 409 COMISION_NO_CUADRA de «Es el pago de un vuelo» (Ingresos, invariante
 * 77): el cobro que se iba a registrar con su comisión NO se podría ligar a
 * su abono (un cobro con comisión o pagado por la pasarela se concilia con
 * UN depósito = su neto ± $1.00). Se dice ANTES de crearlo.
 */
export function mensajeComisionAlRegistrarCobro(d: {
  moneda?: string | null;
  comision_capturada: number;
  neto: number;
  parte: number;
  comision_real: number;
}): string {
  const m = d.moneda ?? null;
  const esperado =
    d.comision_capturada > 0
      ? `Con la comisión de ${dinero(d.comision_capturada)} el banco tendría que haber depositado ${dinero(d.neto, m)}`
      : `Sin comisión el depósito tendría que ser de ${dinero(d.neto, m)}`;
  const real =
    d.comision_real > 0.01
      ? `la comisión real es ${dinero(d.comision_real)}. Captura esa comisión`
      : 'el banco no descontó comisión. Déjala en 0';
  return (
    `${esperado}, pero depositó ${dinero(d.parte, m)}: ${real} y vuelve a registrar el pago ` +
    '(un cobro con comisión se concilia con un depósito igual a su neto).'
  );
}

/**
 * 409 ABONO_TIENE_COBRO_CANDIDATO de Ingresos cuando el candidato es un
 * cobro PARCIAL (invariante 77, D12): el abono cuadra con lo que le FALTA,
 * así que es su pago — ni «otro ingreso» (`destino` INGRESO) ni un cobro
 * nuevo del vuelo (`destino` COBRO, «Es el pago de un vuelo»).
 */
export function mensajeAbonoDeCobroParcial(
  d: {
    folio?: unknown;
    moneda?: string | null;
    monto: number;
    monto_vinculado: number;
    abonos_n: number;
    faltante: number;
  },
  destino: 'INGRESO' | 'COBRO',
): string {
  const n = Math.max(1, Math.trunc(Number(d.abonos_n) || 0));
  const ya =
    n === 1
      ? `un abono de ${dinero(d.monto_vinculado)}`
      : `${n} abonos por ${dinero(d.monto_vinculado)}`;
  return (
    `El cobro del vuelo #${textoDe(d.folio)} (${dinero(d.monto, d.moneda ?? null)}) ya tiene ` +
    `${ya} y le faltan ${dinero(d.faltante)}: vincula este abono a ese cobro en vez de ` +
    (destino === 'INGRESO'
      ? 'registrarlo como ingreso.'
      : 'registrar otro cobro.')
  );
}

/**
 * Lo que respondería «Vincular a este cobro» (la liga directa de UN cobro o
 * sobre SIN otros abonos, sin `corregir_comision`) para un candidato del
 * freno anti doble conteo de Ingresos (`cobrosQueCuadranConAbono`,
 * revisión del 15-oct-2026, invariante 77). El freno ofrece también los que
 * cuadran por BRUTO, y uno con comisión capturada (o un abono de la
 * pasarela) solo se liga por su NETO ± $1.00 (trigger A /
 * `alVincularAbono`; sobre: `alVincularSobre`, D8): ahí la liga rebota y el
 * 409 no puede decir «vincúlalo» a secas. `null` = la liga pasaría.
 * PURO: misma moneda (los candidatos se leen en la moneda del abono).
 */
export function ligaCandidatoNoCuadra(i: {
  tipo: 'COBRO_VUELO' | 'SOBRE_GRUPO';
  monto: number;
  neto: number;
  moneda: string;
  /** |abono| (lo que depositó el banco). */
  parte: number;
  pasarela: boolean;
}): {
  liga_no_cuadra: 'COMISION_NO_CUADRA' | 'SOBRE_NO_CUADRA';
  comision_real: number | null;
} | null {
  const comision = Math.max(r2(i.monto - i.neto), 0);
  if (i.tipo === 'SOBRE_GRUPO') {
    const v = alVincularSobre({
      montoAbono: i.parte,
      monedaCuenta: i.moneda,
      tipoCuenta: i.pasarela ? 'PASARELA' : 'BANCO',
      sobre: {
        monto: i.monto,
        moneda: i.moneda,
        comision_banco_monto: comision,
      },
    });
    return v.estado === 'SOBRE_NO_CUADRA'
      ? { liga_no_cuadra: 'SOBRE_NO_CUADRA', comision_real: null }
      : null;
  }
  const v = alVincularAbono({
    cobro: { monto: i.monto, moneda: i.moneda, comision_banco_monto: comision },
    tcVuelo: null,
    otras: [],
    abono: { monto: i.parte, moneda_cuenta: i.moneda, pasarela: i.pasarela },
    toleranciaTcPct: TOLERANCIA_TC_OFICIAL_PCT,
  });
  return v.estado === 'COMISION_NO_CUADRA'
    ? { liga_no_cuadra: 'COMISION_NO_CUADRA', comision_real: v.comision_real }
    : null;
}

/**
 * 409 ABONO_TIENE_COBRO_CANDIDATO de Ingresos cuando el candidato cuadra
 * con el MONTO (bruto) pero su liga directa rebotaría (`ligaCandidatoNoCuadra`):
 * dice qué espera el banco y que primero se corrige la comisión. No nombra
 * ningún botón del panel. `destino` INGRESO = «registrar como otro
 * ingreso»; COBRO = «Es el pago de un vuelo».
 */
export function mensajeAbonoCuadraSoloPorMonto(
  d: {
    tipo: 'COBRO_VUELO' | 'SOBRE_GRUPO';
    /** «el cobro del vuelo #374» / «el pago del grupo G-5». */
    quien: string;
    cliente: string | null;
    moneda?: string | null;
    monto: number;
    neto: number;
    parte: number;
    comision_real: number | null;
  },
  destino: 'INGRESO' | 'COBRO',
): string {
  const m = d.moneda ?? null;
  const cobro = d.tipo === 'COBRO_VUELO';
  const comision = Math.max(r2(d.monto - d.neto), 0);
  const tiene =
    comision > 0
      ? `tiene registrada una comisión de ${dinero(comision)} y `
      : '';
  const real =
    d.comision_real != null
      ? `, así que la comisión real fue ${dinero(d.comision_real)}`
      : '';
  const deQuien = d.quien.startsWith('el ')
    ? `del ${d.quien.slice(3)}`
    : `de ${d.quien}`;
  const base =
    `Este abono cuadra con el monto ${deQuien}${d.cliente ? ` (${d.cliente})` : ''}, ` +
    `pero ${cobro ? 'ese cobro' : 'ese pago'} ${tiene}espera un depósito de ${dinero(d.neto, m)}; ` +
    `el banco depositó ${dinero(d.parte, m)}${real}. `;
  return destino === 'INGRESO'
    ? `${base}Si es su pago, corrige la comisión ${cobro ? 'del cobro' : 'del pago del grupo'} y vincúlalo. Si de verdad es otro dinero, confírmalo.`
    : `${base}Si es su pago, corrige la comisión de ese cobro y vincúlalo en vez de registrar otro.`;
}

/** Texto es-MX (sin uuid crudos) de cada código de la BD. */
export function mensajeErrorCobros(
  codigo: CodigoErrorCobros,
  details: Record<string, unknown> | null,
  textoBd: string,
): string {
  const folio = textoDe(details?.folio);
  switch (codigo) {
    case 'ABONO_NO_CUADRA': {
      const n =
        num(details, 'n') ??
        (Array.isArray(details?.cobros) ? details.cobros.length : 0);
      const suma = num(details, 'suma_cobros');
      const monto = num(details, 'monto_abono');
      const dif = num(details, 'diferencia');
      const tol = num(details, 'tolerancia');
      if (suma != null && monto != null && dif != null && tol != null) {
        // 0.0.78 (invariante 77): algún cobro ya tenía abonos ⇒ cada uno
        // entró por lo que le FALTA y el texto lo dice.
        const porFaltante =
          Array.isArray(details?.cobros) &&
          details.cobros.some(
            (c: unknown) =>
              !!c &&
              typeof c === 'object' &&
              Number((c as { abonos_otros?: unknown }).abonos_otros) > 0,
          );
        return mensajeAbonoNoCuadra({
          n: n || 2,
          suma,
          monto_abono: monto,
          diferencia: dif,
          tolerancia: tol,
          moneda: typeof details?.moneda === 'string' ? details.moneda : null,
          porFaltante,
        });
      }
      return 'Los cobros elegidos no suman lo que depositó el banco: revisa qué cobros paga este abono.';
    }
    case 'LOTE_MONEDA_DISTINTA':
      return `El cobro del vuelo #${folio} está en ${textoDe(details?.moneda_cobro)} y la cuenta en ${textoDe(details?.moneda_cuenta)}: cuando un abono paga varios cobros, todos van en la moneda de la cuenta.`;
    case 'COBRO_YA_CONCILIADO':
      // 0.0.78 (invariante 77): la BD dice POR QUÉ (`motivo`); sin él, el
      // texto de siempre (BD previa o pre-validación del 0.0.77).
      if (details?.motivo === 'CUBIERTO') {
        return mensajeCobroYaCubierto({
          folio: details.folio,
          neto: num(details, 'neto'),
          suma_ligada: num(details, 'suma_ligada'),
          abonos_otros: num(details, 'abonos_otros'),
          moneda: textoONull(details.moneda),
          abonos_detalle: abonosDeDetails(details),
        });
      }
      if (details?.motivo === 'UN_SOLO_ABONO') {
        return mensajeCobroUnSoloAbono({
          folio: details.folio,
          por: details.por,
        });
      }
      return `El cobro del vuelo #${folio} ya está conciliado con otro movimiento bancario: desvincúlalo ahí si fue un error, o elige otro.`;
    case 'COBRO_DE_GRUPO':
      return `El cobro del vuelo #${folio} es parte del sobre de un grupo: concilia el abono contra el sobre del grupo, no contra sus partes.`;
    case 'COBRO_DE_ANTICIPO':
      return `El cobro del vuelo #${folio} salió de un anticipo: su dinero se concilia una sola vez, como anticipo.`;
    case 'COBRO_INVALIDO':
      return `El cobro del vuelo #${folio} es un reembolso (monto negativo): sale como cargo en el banco, no como abono.`;
    case 'COBRO_NO_EXISTE':
      return 'Alguno de los cobros ya no existe (lo borraron mientras conciliabas): recarga la página.';
    case 'SOLO_ABONOS':
      return 'Solo un abono (entrada de dinero) se concilia contra cobros de vuelo.';
    case 'MOVIMIENTO_YA_LIGADO':
      return 'Este movimiento ya está conciliado con un gasto, un sobre de grupo o un ingreso: desvincúlalo antes de vincularle cobros.';
    case 'REVERSO_INVALIDO':
      return 'Este abono es la devolución de un cargo: no se concilia contra cobros.';
    case 'LOTE_SOLO_API_NUEVO': {
      const n = num(details, 'cobros_n');
      return `Este abono paga ${n != null && n >= 2 ? `${Math.trunc(n)} cobros` : 'varios cobros'}: cambiarlo exige la conciliación actualizada (recarga la página).`;
    }
    case 'ABONO_LIGADO': {
      // 0.0.78 (invariante 77): el candado D vale desde UN cobro; un LOTE
      // además no se deja pendiente a mano.
      const n = num(details, 'cobros_n');
      return n != null && n >= 2
        ? `Este abono está conciliado con ${Math.trunc(n)} cobros de vuelo: no cambia de monto ni de cuenta ni se deja pendiente mientras los tenga ligados (desvincúlalos primero).`
        : 'Este abono está conciliado con cobro(s) de vuelo: no cambia de monto ni de cuenta mientras los tenga ligados (desvincúlalos primero).';
    }
    case 'COBROS_INCOHERENTES':
      return 'El abono quedó con sus cobros a medias: recarga la página y vuelve a intentarlo; si sigue igual, avisa a soporte.';
    case 'LOTE_INVALIDO':
      return textoBd || 'La lista de cobros no es válida.';
    case 'MOVIMIENTO_OMITIDO':
      return mensajeMovimientoOmitido(null);
    // 0.0.78 (invariante 77): un cobro acepta varios abonos.
    case 'ABONO_EXCEDE_COBRO':
      return mensajeAbonoExcedeCobro({
        folio: details?.folio,
        moneda: textoONull(details?.moneda),
        monto_cobro: num(details, 'monto_cobro'),
        neto: num(details, 'neto'),
        suma_otras: num(details, 'suma_otras'),
        abonos_otros: num(details, 'abonos_otros'),
        parte: num(details, 'parte'),
        faltante: num(details, 'faltante'),
        excedente: num(details, 'excedente'),
        un_solo: details?.un_solo === true,
      });
    case 'COMISION_NO_CUADRA':
      return mensajeComisionNoCuadra({
        folio: details?.folio,
        moneda: textoONull(details?.moneda),
        monto_cobro: num(details, 'monto_cobro'),
        comision_capturada: num(details, 'comision_capturada'),
        neto: num(details, 'neto'),
        parte: num(details, 'parte'),
        comision_real: num(details, 'comision_real'),
        corregible:
          typeof details?.corregible === 'boolean' ? details.corregible : null,
      });
    case 'COBRO_MONEDA_DISTINTA':
      return mensajeCobroMonedaDistinta({
        folio: details?.folio,
        motivo: details?.motivo,
        moneda_cobro: textoONull(details?.moneda_cobro),
        moneda_cuenta: textoONull(details?.moneda_cuenta),
        neto: num(details, 'neto'),
        parte: num(details, 'parte'),
        tc_implicito: num(details, 'tc_implicito'),
        tc_referencia: num(details, 'tc_referencia'),
        desvio_pct: num(details, 'desvio_pct'),
        tc_min: num(details, 'tc_min'),
        tc_max: num(details, 'tc_max'),
        tc_referencia_origen:
          details?.tc_referencia_origen === 'VUELO' ? 'VUELO' : null,
      });
    case 'COBRO_CONCILIADO':
      return mensajeCobroConciliado();
  }
}

/** Fila de la puente (lo mínimo) + su movimiento embebido, si se pidió. */
export interface ParteAbonoCobro {
  movimiento_id: string;
  cobro_id: string;
  monto_parte: number;
  movimiento?: MovimientoLiga | MovimientoLiga[] | null;
  /**
   * Solo con `leerLigasDeCobros({ conAutor: true })` (invariante 78): el
   * `created_at` de la PARTE y el nombre de quien la creó. Si vienen, la
   * liga los conserva con ESTOS nombres (el `created_at` de la liga es el
   * del MOVIMIENTO embebido y no se pisa).
   */
  parte_created_at?: string | null;
  ligada_por?: string | null;
}

/**
 * Cada parte de la puente ⇒ UNA «liga» `{id: movimiento_id, cobro_id,
 * monto_parte}` con las demás columnas del movimiento (si viene embebido).
 * Así la fuente única `cobro-conciliado.util` (`movimientoDeCobro`,
 * `cobroEstaConciliado`, `conciliacionDeCobro`) ve un cobro de un lote
 * exactamente como uno ligado por el espejo, sin cambiar una línea, y la
 * cobertura (`ligas-cobro.lector#partesDeLigas` ⇒ `coberturaCobro`) sabe
 * cuánto aporta cada abono (invariante 77).
 */
export function ligasDesdePartes(
  partes: ReadonlyArray<ParteAbonoCobro>,
): MovimientoLiga[] {
  const out: MovimientoLiga[] = [];
  for (const p of partes) {
    const mov = Array.isArray(p.movimiento) ? p.movimiento[0] : p.movimiento;
    out.push({
      ...(mov ?? {}),
      id: p.movimiento_id,
      cobro_id: p.cobro_id,
      cobro_grupo_id: null,
      // ADITIVO (invariante 77): lo que ESTE abono aporta a ESTE cobro.
      monto_parte: Number(p.monto_parte) || 0,
      // ADITIVOS (invariante 78): quién y cuándo creó la PARTE, solo si se
      // pidieron (sin `conAutor` la liga sale byte a byte igual).
      ...(p.parte_created_at !== undefined
        ? { parte_created_at: p.parte_created_at }
        : {}),
      ...(p.ligada_por !== undefined ? { ligada_por: p.ligada_por } : {}),
    });
  }
  return out;
}

/** Une ligas por `(id, cobro_id, cobro_grupo_id, ingreso_id)`, sin repetir. */
export function unirLigas<M extends MovimientoLiga & { ingreso_id?: unknown }>(
  ...listas: ReadonlyArray<ReadonlyArray<M>>
): M[] {
  const vistas = new Set<string>();
  const out: M[] = [];
  for (const l of listas) {
    for (const m of l) {
      const k = [m.id, m.cobro_id, m.cobro_grupo_id, m.ingreso_id]
        .map((v) => textoDe(v, ''))
        .join('|');
      if (vistas.has(k)) continue;
      vistas.add(k);
      out.push(m);
    }
  }
  return out;
}

/** |abono| − Σ partes (el centavo del lote); null sin partes. */
export function diferenciaLoteCobros(
  montoAbono: number | string,
  partes: ReadonlyArray<{ monto_parte: number | string }>,
): number | null {
  if (partes.length === 0) return null;
  const suma = partes.reduce((acc, p) => acc + (Number(p.monto_parte) || 0), 0);
  return r2(Math.abs(Number(montoAbono) || 0) - suma);
}

/**
 * «Conciliado con» del Excel para un abono con VARIOS cobros:
 * «2 cobros: vuelo #379 ($1,000.00) · vuelo #380 ($2,500.00)» + «·
 * diferencia $0.01» cuando no cuadra exacto. Desde el 0.0.78 (invariante
 * 77) un cobro entra al lote por lo que le FALTABA: si su parte no es su
 * neto, «vuelo #278 ($18,001.00 de $28,001.00 · completa el cobro)» (la
 * coletilla solo si con esa parte queda cubierto). Sin `neto`, como hoy.
 */
export function etiquetaConciliadoCobros(
  partes: ReadonlyArray<{
    folio?: number | null;
    cliente?: string | null;
    monto_parte: number | string;
    /** Neto del cobro (`netoDeCobro`); null/ausente = como el 0.0.77. */
    neto?: number | null;
    /** El cobro queda CUBIERTO con sus abonos (`coberturaCobro`). */
    completa?: boolean | null;
  }>,
  diferencia: number | null,
): string {
  const n = partes.length;
  const items = partes.map((p) => {
    const vuelo = p.folio == null ? 'vuelo' : `vuelo #${p.folio}`;
    const quien = p.cliente ? ` · ${p.cliente}` : '';
    const parte = Number(p.monto_parte) || 0;
    const deNeto =
      p.neto != null && Math.abs(parte - p.neto) >= 0.005
        ? ` de ${dinero(p.neto)}${p.completa === true ? ' · completa el cobro' : ''}`
        : '';
    return `${vuelo}${quien} (${dinero(parte)}${deNeto})`;
  });
  const dif =
    diferencia != null && Math.abs(diferencia) >= 0.005
      ? ` · diferencia ${dinero(Math.abs(diferencia))}`
      : '';
  return `${n} cobros: ${items.join(' · ')}${dif}`;
}

/**
 * «Conciliado con» del Excel para un abono con UN cobro (invariante 77):
 * «Cobro · vuelo #315 · Transferencia» de siempre y, según la cobertura del
 * cobro con TODOS sus abonos:
 * - el abono trae más que el cobro (liga vieja): «… · el abono trae $977.45
 *   de más»;
 * - el cobro sigue sin cubrir: «… · pago parcial: este abono $1,700.00 de
 *   $3,400.00 (faltan $1,700.00)»;
 * - cubierto con 2+ abonos: «… · 2 de 2 abonos ($3,400.00 cubierto)».
 */
export function etiquetaConciliadoCobroUnico(d: {
  folio?: number | null;
  metodo_cobro?: string | null;
  /** Lo que ESTE abono aporta al cobro. */
  monto_parte: number;
  neto: number;
  faltante: number;
  sobrante: number;
  cubierto: boolean;
  abonos_n: number;
  /** Lugar de ESTE abono entre los del cobro por antigüedad (1 = el más antiguo). */
  posicion?: number | null;
}): string {
  const base = [
    'Cobro',
    d.folio != null ? `vuelo #${d.folio}` : null,
    d.metodo_cobro ? etiquetaMetodoCobro(d.metodo_cobro) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (d.sobrante > TOLERANCIA_COBRO_BANCO) {
    return `${base} · el abono trae ${dinero(d.sobrante)} de más`;
  }
  if (!d.cubierto) {
    return `${base} · pago parcial: este abono ${dinero(d.monto_parte)} de ${dinero(d.neto)} (faltan ${dinero(d.faltante)})`;
  }
  if (d.abonos_n >= 2) {
    const pos = d.posicion != null && d.posicion > 0 ? String(d.posicion) : '?';
    return `${base} · ${pos} de ${d.abonos_n} abonos (${dinero(d.neto)} cubierto)`;
  }
  return base;
}
