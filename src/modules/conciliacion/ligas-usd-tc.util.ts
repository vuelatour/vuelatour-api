/**
 * LIGAS USD ↔ MXN FUERA DE LUGAR (13-oct-2026, lote 2, API 0.0.75,
 * invariante 70). PURO: arma la línea del aviso del pre-cierre «Gastos en
 * dólares conciliados con un tipo de cambio fuera de lugar» y de la marca ⚠
 * de Conciliación. La DECISIÓN (¿está fuera de lugar?) vive en
 * `auto-cruce.util` (`evaluarTcCruce` + `ligaUsdFueraDeLugar`); aquí solo se
 * redacta y se ordena. Nada se corrige solo: la oficina desvincula y
 * vincula el cargo correcto.
 */
import { primeraLinea, type TcCruceUsd } from './auto-cruce.util';
import { fechaCortaEs, montoBonito } from './conciliacion-parcial.util';

/** Una liga cruzada (gasto USD ↔ cargo en pesos) fuera de lugar. */
export interface LigaUsdTcFueraDeLugar {
  gasto_id: string;
  fecha_gasto: string | null;
  monto_usd: number;
  /** El T.C. que la BD derivó de la liga (`gasto.tc_gasto`). */
  tc_gasto: number | null;
  categoria: string | null;
  descripcion_gasto: string;
  vuelo_id: string | null;
  vuelo_folio: number | null;
  movimiento_id: string;
  fecha_cargo: string | null;
  monto_cargo: number;
  cuenta_bancaria_id: string | null;
  /** Alias de la cuenta del cargo. */
  cuenta: string | null;
  descripcion_cargo: string | null;
  tc_cruce: TcCruceUsd;
  texto: string;
}

export interface ResultadoLigasUsdTc {
  ligas: LigaUsdTcFueraDeLugar[];
  /** Ligas en banda que no se pudieron revisar: sin T.C. oficial del día del cargo. */
  sin_verificar: number;
}

/** Tope del texto del gasto en la línea del aviso. */
export const DESCRIPCION_GASTO_USD_MAX = 60;

/**
 * Qué compra fue: 1.ª línea de las notas, si no el lugar, si no el
 * proveedor, si no «gasto en USD»; con más de 60 caracteres se corta en 59
 * + «…» (por puntos de código: un acento no se parte).
 */
export function descripcionGastoUsd(g: {
  notas?: string | null;
  lugar?: string | null;
  proveedor?: string | null;
}): string {
  const s =
    primeraLinea(g.notas) ||
    (g.lugar ?? '').trim() ||
    (g.proveedor ?? '').trim() ||
    'gasto en USD';
  const puntos = [...s];
  return puntos.length > DESCRIPCION_GASTO_USD_MAX
    ? `${puntos
        .slice(0, DESCRIPCION_GASTO_USD_MAX - 1)
        .join('')
        .trimEnd()}…`
    : s;
}

/**
 * «$422.86 USD · Aircraft Spruce & Specialty Co. · Michelin Tube
 * 7.00-6/8.00… (01 sep) ↔ cargo «ASA CANCUN» de $8,939.38 del 01 sep
 * (COMBUSTIBLE): T.C. 21.14 · oficial 17.01 (+24.3 %): lejos del oficial».
 */
export function textoLigaUsdTc(
  l: Omit<LigaUsdTcFueraDeLugar, 'texto'>,
): string {
  return `${montoBonito(l.monto_usd)} USD · ${l.descripcion_gasto} (${fechaCortaEs(l.fecha_gasto) ?? l.fecha_gasto ?? ''}) ↔ cargo «${l.descripcion_cargo ?? ''}» de ${montoBonito(l.monto_cargo)} del ${fechaCortaEs(l.fecha_cargo) ?? l.fecha_cargo ?? ''} (${l.cuenta ?? 'cuenta sin alias'}): ${l.tc_cruce.texto}`;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Orden del aviso: fecha del cargo, fecha del gasto e id del gasto. */
export function ordenarLigasUsdTc<
  T extends Pick<
    LigaUsdTcFueraDeLugar,
    'fecha_cargo' | 'fecha_gasto' | 'gasto_id'
  >,
>(ligas: readonly T[]): T[] {
  return [...ligas].sort(
    (a, b) =>
      cmp(a.fecha_cargo ?? '', b.fecha_cargo ?? '') ||
      cmp(a.fecha_gasto ?? '', b.fecha_gasto ?? '') ||
      cmp(a.gasto_id, b.gasto_id),
  );
}
