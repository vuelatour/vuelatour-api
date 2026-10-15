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
import type { MovimientoLiga } from '../../common/cobro-conciliado.util';
import { toleranciaLote } from './conciliacion-parcial.util';
import { mensajeMovimientoOmitido } from './omision.util';

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
] as const;
export type CodigoErrorCobros = (typeof CODIGOS_ERROR_COBROS)[number];

/** Redondeo a centavos (evita 0.30000000000000004). */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Lo que depositó el banco por un cobro: monto − comisión bancaria capturada. */
export function netoDeCobro(
  monto: number | string | null | undefined,
  comision: number | string | null | undefined,
): number {
  const m = Number(monto) || 0;
  const c = Number(comision) || 0;
  const neto = r2(m - (c > 0 ? c : 0));
  return neto > 0 ? neto : r2(m);
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
 * `hint` (o del prefijo «CODIGO:» del mensaje), el `detail` es JSON.
 */
export function leerErrorCobros(err: ErrorCobrosLike | null | undefined): {
  codigo: CodigoErrorCobros | null;
  texto: string;
  details: Record<string, unknown> | null;
} {
  const msg = String(err?.message ?? '');
  const esCodigo = (c: unknown): c is CodigoErrorCobros =>
    typeof c === 'string' &&
    (CODIGOS_ERROR_COBROS as readonly string[]).includes(c);
  const hint = typeof err?.hint === 'string' ? err.hint.trim() : '';
  const prefijo = /^\s*([A-Z][A-Z_]+)\s*:/.exec(msg)?.[1];
  const codigo = esCodigo(hint)
    ? hint
    : esCodigo(prefijo)
      ? prefijo
      : (CODIGOS_ERROR_COBROS.find((c) => msg.includes(c)) ?? null);
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
    texto: msg.replace(/^\s*[A-Z][A-Z_]+\s*:\s*/, '').trim(),
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
    case 'ABONO_LIGADO':
      return 'Este abono paga varios cobros: no cambia de monto ni de cuenta ni se deja pendiente mientras los tenga ligados (desvincúlalos primero).';
    case 'COBROS_INCOHERENTES':
      return 'El abono quedó con sus cobros a medias: recarga la página y vuelve a intentarlo; si sigue igual, avisa a soporte.';
    case 'LOTE_INVALIDO':
      return textoBd || 'La lista de cobros no es válida.';
    case 'MOVIMIENTO_OMITIDO':
      return mensajeMovimientoOmitido(null);
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
 * Cada parte de la puente ⇒ UNA «liga» `{id: movimiento_id, cobro_id}` con
 * las demás columnas del movimiento (si viene embebido). Así la fuente
 * única `cobro-conciliado.util` (`movimientoDeCobro`, `cobroEstaConciliado`,
 * `conciliacionDeCobro`) ve un cobro de un lote exactamente como uno
 * ligado por el espejo, sin cambiar una línea.
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
 * diferencia $0.01» cuando no cuadra exacto.
 */
export function etiquetaConciliadoCobros(
  partes: ReadonlyArray<{
    folio?: number | null;
    cliente?: string | null;
    monto_parte: number | string;
  }>,
  diferencia: number | null,
): string {
  const n = partes.length;
  const items = partes.map((p) => {
    const vuelo = p.folio == null ? 'vuelo' : `vuelo #${p.folio}`;
    const quien = p.cliente ? ` · ${p.cliente}` : '';
    return `${vuelo}${quien} (${dinero(Number(p.monto_parte) || 0)})`;
  });
  const dif =
    diferencia != null && Math.abs(diferencia) >= 0.005
      ? ` · diferencia ${dinero(Math.abs(diferencia))}`
      : '';
  return `${n} cobros: ${items.join(' · ')}${dif}`;
}
