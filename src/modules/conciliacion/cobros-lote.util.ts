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
  netoDeCobro,
  TOLERANCIA_COBRO_BANCO,
} from '../../common/cobro-banco.util';
import type { MovimientoLiga } from '../../common/cobro-conciliado.util';
import { etiquetaMetodoCobro } from '../../common/metodo-cobro.util';
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
}

export type VeredictoLoteCobros =
  | {
      ok: true;
      /** Partes que escribiría la RPC (en el orden pedido). */
      partes: Array<{ cobro_id: string; monto_parte: number }>;
      suma: number;
      diferencia: number;
      tolerancia: number;
    }
  | {
      ok: false;
      codigo: Extract<
        CodigoErrorCobros,
        | 'LOTE_INVALIDO'
        | 'COBRO_INVALIDO'
        | 'COBRO_DE_GRUPO'
        | 'COBRO_DE_ANTICIPO'
        | 'LOTE_MONEDA_DISTINTA'
        | 'ABONO_NO_CUADRA'
      >;
      mensaje: string;
      details: Record<string, unknown>;
    };

/**
 * ESPEJO de la RPC G: con UN cobro, parte = |abono| y sin cuadre (regla de
 * siempre); con N ≥ 2, todos en la moneda de la cuenta, parte = NETO y
 * |Σ − |abono|| ≤ tolerancia_lote(N). Devuelve el primer rechazo, con el
 * MISMO código y `details` que lanzaría la BD.
 */
export function puedeLigarCobros(input: {
  montoAbono: number | string;
  monedaCuenta: string | null;
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
  let suma = 0;
  const partes: Array<{ cobro_id: string; monto_parte: number }> = [];
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
    const neto = netoDeCobro(c.monto, c.comision_banco_monto);
    suma = r2(suma + neto);
    partes.push({ cobro_id: c.id, monto_parte: n === 1 ? monto : neto });
  }
  const tolerancia = n >= 2 ? toleranciaLote(n) : 0;
  const diferencia = r2(monto - suma);
  if (n >= 2 && Math.abs(diferencia) > tolerancia + 0.000001) {
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
      }),
      details: {
        monto_abono: monto,
        suma_cobros: suma,
        diferencia,
        tolerancia,
        moneda: input.monedaCuenta,
        cobros: cobros.map((c) => ({
          id: c.id,
          folio: c.folio ?? null,
          monto: r2(Number(c.monto) || 0),
          neto: netoDeCobro(c.monto, c.comision_banco_monto),
        })),
      },
    };
  }
  return { ok: true, partes, suma, diferencia, tolerancia };
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
}): string {
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
}): string {
  const folio = textoDe(d.folio);
  const m = d.moneda ?? null;
  if (d.neto == null || d.parte == null || d.comision_real == null) {
    return `El depósito no cuadra con lo que espera el cobro del vuelo #${folio} después de la comisión: corrige la comisión del cobro antes de vincular.`;
  }
  const pct =
    d.monto_cobro != null && d.monto_cobro > 0
      ? ` (${((d.comision_real / d.monto_cobro) * 100).toFixed(2)} %)`
      : '';
  const capturada =
    (d.comision_capturada ?? 0) > 0
      ? ` después de la comisión registrada (${dinero(d.comision_capturada ?? 0)})`
      : '';
  return (
    `El cobro del vuelo #${folio}${d.monto_cobro != null ? ` (${dinero(d.monto_cobro, m)})` : ''} espera un depósito de ` +
    `${dinero(d.neto, m)}${capturada} y el banco depositó ${dinero(d.parte, m)}: ` +
    `la comisión real fue ${dinero(d.comision_real, m)}${pct}. Corrige la comisión del cobro o usa ` +
    `«Corregir la comisión a ${dinero(d.comision_real)} y vincular».`
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
 * 409 COBRO_CONCILIADO (trigger E, invariante 77): el dinero de un cobro con
 * abonos ligados no cambia. La BD solo lo lanza en una carrera (el API
 * decide antes con su candado y su propio texto).
 */
export function mensajeCobroConciliado(): string {
  return 'El cobro tiene abonos del banco vinculados: su monto, moneda, comisión, sobre o anticipo no cambian mientras esté conciliado; desvincúlalo en Conciliación primero.';
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
        return mensajeAbonoNoCuadra({
          n: n || 2,
          suma,
          monto_abono: monto,
          diferencia: dif,
          tolerancia: tol,
          moneda: typeof details?.moneda === 'string' ? details.moneda : null,
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
