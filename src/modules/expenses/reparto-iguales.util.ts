/**
 * NÓMINA: REPARTO EN PARTES IGUALES ENTRE AVIONES (16-oct-2026, API 0.0.90,
 * invariante 91) — `POST /v1/expenses/reparto-iguales`
 * (`ExpensesService.putRepartoIguales`). Pedido del cliente: «sumar todo lo
 * de la nómina y repartir en partes iguales a los aviones que yo elija…
 * por lotes o todos de un jalón».
 *
 * PURO (sin BD ni Nest salvo el tipo de la excepción) y FUENTE ÚNICA de:
 *  - la aritmética en CENTAVOS ENTEROS (`repartirIgualesCents`): cada pago
 *    se reparte por separado (conserva su `gasto_reparto`, su mes y su
 *    trazabilidad); Σ partes == monto EXACTO (sin remanente para
 *    VuelaTour); el residuo de centavos ROTA entre los aviones a lo largo
 *    del lote con un cursor POR MONEDA (`planRepartoIguales`), así que el
 *    total por avión de un lote difiere a lo más 1 ¢ dentro de cada moneda;
 *  - el orden determinista (aviones por matrícula, pagos por fecha e id);
 *  - los totales por moneda (jamás mezcla monedas);
 *  - los códigos y TEXTOS es-MX de los errores por pago.
 *
 * El panel NO calcula montos: pinta los que devuelve el API (`simular`).
 */
import { HttpException } from '@nestjs/common';
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import {
  CATEGORIA_GASTO_LABEL,
  etiquetaCategoriaGasto,
} from '../../common/categoria-gasto.util';
import { CATEGORIAS_REPARTIBLES } from '../../common/gasto-reparto.util';
import type { CategoriaGasto } from './dto/expenses.dto';

/** Máximo de pagos por petición (DTO). */
export const REPARTO_IGUALES_MAX_GASTOS = 200;
/** Máximo de aviones por petición (DTO). */
export const REPARTO_IGUALES_MAX_AVIONES = 20;
/** Lote de lectura de `gasto` por `.in('id', …)`. */
export const REPARTO_IGUALES_LOTE_LECTURA = 150;

/** Columnas del pago que necesita el núcleo `reemplazarRepartoDeGasto`. */
export const GASTO_REPARTO_IGUALES_COLS =
  'id, categoria, monto, moneda, fecha_gasto, vuelo_id, aeronave_id';

/** Códigos de error (el `code` de cada pago y el del 400 del lote). */
export const CODIGO_REPARTO_IGUALES = {
  AERONAVE_INACTIVA: 'AERONAVE_INACTIVA',
  GASTO_NO_EXISTE: 'GASTO_NO_EXISTE',
  CATEGORIA_NO_REPARTIBLE: 'CATEGORIA_NO_REPARTIBLE',
  GASTO_CON_VUELO: 'GASTO_CON_VUELO',
  MONTO_MUY_CHICO: 'MONTO_MUY_CHICO',
  MES_CERRADO: 'MES_CERRADO',
  ERROR: 'ERROR',
} as const;

/** 400 del LOTE: algún avión pedido no existe o está inactivo. */
export const MENSAJE_AERONAVE_INACTIVA =
  'Alguno de los aviones elegidos no existe o está inactivo: solo se reparte entre aviones activos.';
export const MENSAJE_GASTO_NO_EXISTE =
  'Este pago ya no existe (pudo haberse eliminado): recarga la lista.';
export const MENSAJE_GASTO_CON_VUELO =
  'Este pago está ligado a un vuelo: su avión lo decide el vuelo, no el reparto.';
export const MENSAJE_ERROR_REPARTO_IGUALES =
  'No se pudo aplicar el reparto de este pago. Intenta de nuevo; si persiste, avisa a soporte.';

/** Etiquetas de las categorías que se reparten (orden del catálogo). */
const ETIQUETAS_REPARTIBLES = (
  Object.keys(CATEGORIA_GASTO_LABEL) as CategoriaGasto[]
)
  .filter((c) => CATEGORIAS_REPARTIBLES.has(c))
  .map((c) => CATEGORIA_GASTO_LABEL[c]);

/** «Comida» no se reparte: solo los gastos generales (…). */
export function mensajeCategoriaNoRepartible(
  categoria: string | null | undefined,
): string {
  const etiqueta = etiquetaCategoriaGasto(categoria) || 'Sin categoría';
  return `«${etiqueta}» no se reparte entre aviones: solo los gastos generales (${ETIQUETAS_REPARTIBLES.join(', ')}).`;
}

/** «$0.03 MXN no alcanza para repartir entre 4 aviones…». */
export function mensajeMontoMuyChico(
  totalCents: number,
  moneda: string | null | undefined,
  n: number,
): string {
  return `${fmtDineroTexto(totalCents / 100, moneda ?? 'MXN')} no alcanza para repartir entre ${n} aviones: cada avión necesita al menos un centavo.`;
}

/** Error de UN pago en la respuesta. */
export interface ErrorRepartoIguales {
  code: string;
  message: string;
}

/**
 * Error de un pago a partir de lo que lanzó el núcleo o un candado:
 * HttpException ⇒ su `code` (el `error` del cuerpo, normalizado como el
 * `AllExceptionsFilter`: «Bad Request» ⇒ BAD_REQUEST) y su `message`;
 * cualquier otra cosa ⇒ `ERROR` con el texto genérico (quien llama deja el
 * detalle técnico en el log). `esHttp` dice cuál de los dos fue.
 */
export function errorRepartoDeExcepcion(err: unknown): ErrorRepartoIguales & {
  esHttp: boolean;
} {
  if (!(err instanceof HttpException)) {
    return {
      code: CODIGO_REPARTO_IGUALES.ERROR,
      message: MENSAJE_ERROR_REPARTO_IGUALES,
      esHttp: false,
    };
  }
  const r = err.getResponse();
  let message = err.message;
  let code: string = err.name;
  if (typeof r === 'string') {
    message = r;
  } else if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if (typeof o.message === 'string') message = o.message;
    else if (Array.isArray(o.message)) message = o.message.join('; ');
    if (typeof o.error === 'string' && o.error.trim()) code = o.error;
  }
  return {
    code: code.toUpperCase().replace(/\s+/g, '_'),
    message,
    esHttp: true,
  };
}

/** Centavos enteros de un monto (number o numeric en texto); null si no es finito. */
export function centavosDe(monto: unknown): number | null {
  if (monto == null || monto === '') return null;
  const n = Number(monto);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Monto con 2 decimales a partir de centavos enteros. */
export function montoDeCentavos(cents: number): number {
  return cents / 100;
}

/** Resultado de repartir UN pago. */
export interface RepartoIgualesCents {
  /** Una parte por avión, en el orden de los aviones. Σ == totalCents. */
  cents: number[];
  /** Cursor para el SIGUIENTE pago del lote (misma moneda). */
  cursor: number;
}

/**
 * Partes iguales en centavos: `base = floor(T/n)`, `residuo = T − base·n`;
 * los `residuo` centavos extra van a los índices `(cursor + k) % n`
 * (k < residuo) y el cursor avanza `residuo` posiciones mod n. Σ == T
 * exacto. `T < n` ⇒ alguna parte queda en 0 (quien llama lo rechaza: el
 * CHECK `monto > 0` de `gasto_reparto` no admite ceros).
 * Lanza RangeError con `n` no entero ≥ 1 o `T` no entero ≥ 0.
 */
export function repartirIgualesCents(
  totalCents: number,
  n: number,
  cursor = 0,
): RepartoIgualesCents {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`n debe ser un entero ≥ 1 (llegó ${n})`);
  }
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new RangeError(
      `totalCents debe ser un entero ≥ 0 (llegó ${totalCents})`,
    );
  }
  const inicio = Number.isInteger(cursor) ? ((cursor % n) + n) % n : 0;
  const base = Math.floor(totalCents / n);
  const residuo = totalCents - base * n;
  const cents = new Array<number>(n).fill(base);
  for (let k = 0; k < residuo; k += 1) cents[(inicio + k) % n] += 1;
  return { cents, cursor: (inicio + residuo) % n };
}

/** Un pago YA validado, en el orden del lote. */
export interface PagoParaPlan {
  id: string;
  moneda: string;
  totalCents: number;
}

/**
 * Plan del LOTE: las partes de cada pago con un cursor POR MONEDA (el
 * residuo de un pago en dólares no le «debe» un centavo a un avión en
 * pesos). Mismo resultado en `simular` y al aplicar: la vista previa es lo
 * que se escribe.
 */
export function planRepartoIguales(
  pagos: ReadonlyArray<PagoParaPlan>,
  n: number,
): Map<string, number[]> {
  const cursores = new Map<string, number>();
  const out = new Map<string, number[]>();
  for (const p of pagos) {
    const r = repartirIgualesCents(p.totalCents, n, cursores.get(p.moneda));
    cursores.set(p.moneda, r.cursor);
    out.set(p.id, r.cents);
  }
  return out;
}

/** Orden de los aviones: matrícula ascendente (desempate por id). */
export function compararAvionesPorMatricula(
  a: { id: string; matricula: string | null },
  b: { id: string; matricula: string | null },
): number {
  const ma = a.matricula ?? '';
  const mb = b.matricula ?? '';
  if (ma !== mb) return ma < mb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Orden de los pagos: `fecha_gasto` ascendente, luego `id`. */
export function compararPagosPorFecha(
  a: { id: string; fecha_gasto: string | null },
  b: { id: string; fecha_gasto: string | null },
): number {
  const fa = a.fecha_gasto ?? '';
  const fb = b.fecha_gasto ?? '';
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Parte de un avión en la respuesta. */
export interface ParteRepartoIguales {
  aeronave_id: string;
  matricula: string | null;
  monto: number;
}

/** Total por moneda de los pagos OK del lote. */
export interface TotalRepartoIguales {
  moneda: string;
  monto: number;
  gastos_n: number;
  por_avion: ParteRepartoIguales[];
}

/**
 * Totales por moneda (MXN antes que USD; orden alfabético) de los pagos OK:
 * Σ de sus montos y, por avión (en el orden de `aviones`), Σ de sus
 * partes — todo en centavos enteros. Sin partes (quitar) ⇒ `por_avion: []`.
 */
export function totalesRepartoIguales(
  pagos: ReadonlyArray<{
    moneda: string;
    totalCents: number;
    partesCents: ReadonlyArray<number>;
  }>,
  aviones: ReadonlyArray<{ id: string; matricula: string | null }>,
): TotalRepartoIguales[] {
  const acc = new Map<
    string,
    { cents: number; n: number; porAvion: number[] | null }
  >();
  for (const p of pagos) {
    const a = acc.get(p.moneda) ?? { cents: 0, n: 0, porAvion: null };
    a.cents += p.totalCents;
    a.n += 1;
    if (p.partesCents.length > 0) {
      a.porAvion ??= aviones.map(() => 0);
      p.partesCents.forEach((c, i) => {
        if (i < a.porAvion!.length) a.porAvion![i] += c;
      });
    }
    acc.set(p.moneda, a);
  }
  return [...acc.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([moneda, a]) => ({
      moneda,
      monto: montoDeCentavos(a.cents),
      gastos_n: a.n,
      por_avion: a.porAvion
        ? aviones.map((av, i) => ({
            aeronave_id: av.id,
            matricula: av.matricula,
            monto: montoDeCentavos(a.porAvion![i]),
          }))
        : [],
    }));
}

/** Un pago en la respuesta. */
export interface GastoRepartoIguales {
  gasto_id: string;
  fecha_gasto: string | null;
  monto: number | null;
  moneda: string | null;
  ok: boolean;
  /** Tenía filas en `gasto_reparto` ANTES de esta petición. */
  ya_repartido: boolean;
  /** [] si se quita el reparto o si hubo error. */
  partes: ParteRepartoIguales[];
  error: ErrorRepartoIguales | null;
}

/** Respuesta 200 de `POST /v1/expenses/reparto-iguales`. */
export interface RespuestaRepartoIguales {
  simulado: boolean;
  /** `aeronave_ids` vacío: se QUITA el reparto de esos pagos. */
  quitar: boolean;
  /** Aviones en el orden usado (matrícula ascendente). */
  aeronaves: Array<{ id: string; matricula: string | null }>;
  gastos: GastoRepartoIguales[];
  /** Solo pagos OK; jamás mezcla monedas. */
  totales: TotalRepartoIguales[];
  /** Pagos OK (en `simular`: los que SE aplicarían). */
  aplicados: number;
  errores: number;
}
