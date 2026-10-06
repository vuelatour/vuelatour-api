/**
 * VINCULAR UN GASTO NO BANCARIO A UN CARGO DEL BANCO, CON JUSTIFICACIÓN
 * (6-oct-2026, API 0.0.63, sin migración).
 *
 * Caso real (texto del cliente): cargo de $212.00 del 07-sep-2026 (ASUR
 * CANCUN, cuenta GASTOS GNRAL). «Ningún piloto subió ese gasto, no pudimos
 * identificar quién lo utilizó, pero el 27 y 28 hubo 2 gastos de
 * estacionamiento por ese monto y Mari los facturó para no perder la
 * deducción del impuesto. Por eso queremos asociarlo a uno de los 2, sin
 * cambiar la forma de pago, ya que eso afectaría la caja de los pilotos.»
 *
 * Regla: un gasto en EFECTIVO (o PERSONAL_*) SÍ se puede ligar a un cargo
 * del banco, pero SOLO con una razón escrita, y la liga NO toca el medio de
 * pago (caja chica no lee `gasto.conciliado`: la caja de los pilotos no se
 * mueve). La razón queda anotada en los DOS lados:
 *
 *  - Cargo (`movimiento_bancario.notas`), una línea por gasto:
 *    «Vinculado a gasto en EFECTIVO del 28-sep-2026 (Taxi / estacionamiento
 *    · vuelo #330 · $212.00): <justificación> — <usuario>, 06-oct-2026»
 *  - Gasto (`gasto.notas`), una línea por cargo:
 *    «⚠ Conciliado con el cargo bancario del 07-sep-2026 ($212.00 · ASUR
 *    CANCUN) sin cambiar el medio de pago (EFECTIVO): <justificación> —
 *    <usuario>, 06-oct-2026»
 *
 * Aquí vive, PURO y con spec, TODO el texto de la regla: las dos líneas, su
 * alta idempotente (una línea por par cargo ↔ gasto; la misma no se
 * duplica, una razón nueva la reemplaza), su retiro al desvincular (regex de
 * la forma EXACTA: lo que escribió la oficina queda intacto) y los mensajes
 * del 400 `JUSTIFICACION_REQUERIDA` y del 409 `GASTO_BODEGA`. Etiquetas de
 * medio y categoría: las utils de siempre (`etiquetaMedioPago`,
 * `etiquetaCategoriaGasto`). Fechas `dd-mmm-aaaa` cortando el texto
 * (jamás `new Date`: restaría un día en Cancún).
 */
import { etiquetaCategoriaGasto } from './categoria-gasto.util';
import { etiquetaMedioPago } from './medio-pago.util';

/** Largo de la justificación (después de recortar). */
export const JUSTIFICACION_MIN = 10;
export const JUSTIFICACION_MAX = 300;

/** Tope de la leyenda del banco dentro de la nota del gasto. */
const DESCRIPCION_NOTA_MAX = 80;

/** Lo que la nota del CARGO dice del gasto. */
export interface GastoDeNota {
  fecha_gasto: string | null;
  monto: number;
  moneda: string | null;
  medio_pago: string | null;
  categoria: string | null;
  vuelo_folio: number | null;
}

/** Lo que la nota del GASTO dice del cargo. */
export interface CargoDeNota {
  fecha: string | null;
  /** |monto| del cargo. */
  monto: number;
  /** Moneda de la CUENTA del cargo. */
  moneda: string | null;
  /** Leyenda del banco («ASUR CANCUN»). */
  descripcion: string | null;
}

/** Quién, cuándo y por qué (las dos líneas la llevan igual). */
export interface FirmaVinculo {
  justificacion: string;
  /** Nombre de quien ligó (vacío ⇒ «Oficina»). */
  usuario: string | null | undefined;
  /** Día Cancún YYYY-MM-DD de la liga (`hoyCancun()`). */
  hoy: string;
}

const MESES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const;

/** Texto en UNA línea (las notas son por renglón). */
function unaLinea(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function partesFecha(
  fecha: string | null | undefined,
): { d: string; mes: string; a: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha ?? ''));
  if (!m) return null;
  const mes = MESES[Number(m[2]) - 1];
  return mes ? { d: m[3], mes, a: m[1] } : null;
}

/** `2026-09-28` ⇒ `28-sep-2026`; sin fecha legible ⇒ `sin fecha`. */
export function fechaNota(fecha: string | null | undefined): string {
  const p = partesFecha(fecha);
  return p ? `${p.d}-${p.mes}-${p.a}` : 'sin fecha';
}

/** `2026-09-28` ⇒ `28 sep` (mensajes del API, como `fechaCortaEs`). */
export function fechaMensaje(fecha: string | null | undefined): string {
  const p = partesFecha(fecha);
  return p ? `${p.d} ${p.mes}` : 'sin fecha';
}

/** `$1,234.50` (+ « USD» fuera de pesos). Determinista: sin Intl. */
export function montoNota(monto: number, moneda?: string | null): string {
  const n = Math.abs(Math.round((Number(monto) || 0) * 100) / 100);
  const [ent, dec] = n.toFixed(2).split('.');
  const m = (moneda ?? '').trim();
  const sufijo = m && m !== 'MXN' ? ` ${m}` : '';
  return `$${ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}${sufijo}`;
}

/** Medio en MAYÚSCULAS con su etiqueta de siempre: «EFECTIVO», «PERSONAL PABLO». */
export function medioNota(medio: string | null | undefined): string {
  return (etiquetaMedioPago(medio) ?? 'sin medio').toLocaleUpperCase('es-MX');
}

/** Justificación en UNA línea y ≤ `JUSTIFICACION_MAX` (el DTO ya la acota). */
export function limpiarJustificacion(j: string | null | undefined): string {
  return unaLinea(j).slice(0, JUSTIFICACION_MAX).trim();
}

function firmante(usuario: string | null | undefined): string {
  return unaLinea(usuario) || 'Oficina';
}

function descripcionNota(d: string | null | undefined): string {
  const t = unaLinea(d);
  return t.length > DESCRIPCION_NOTA_MAX
    ? `${t.slice(0, DESCRIPCION_NOTA_MAX - 1).trimEnd()}…`
    : t;
}

/** «Taxi / estacionamiento · vuelo #330 · $212.00». */
function detalleGasto(g: GastoDeNota): string {
  return [
    etiquetaCategoriaGasto(g.categoria) || null,
    g.vuelo_folio != null && Number.isFinite(Number(g.vuelo_folio))
      ? `vuelo #${g.vuelo_folio}`
      : null,
    montoNota(g.monto, g.moneda),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** «$212.00 · ASUR CANCUN». */
function detalleCargo(c: CargoDeNota): string {
  return [montoNota(c.monto, c.moneda), descripcionNota(c.descripcion) || null]
    .filter(Boolean)
    .join(' · ');
}

function cola(firma: FirmaVinculo): string {
  return `${limpiarJustificacion(firma.justificacion)} — ${firmante(firma.usuario)}, ${fechaNota(firma.hoy)}`;
}

/**
 * Línea del CARGO: «Vinculado a gasto en EFECTIVO del 28-sep-2026 (Taxi /
 * estacionamiento · vuelo #330 · $212.00): <justificación> — <usuario>,
 * 06-oct-2026».
 */
export function lineaNotaCargo(
  gasto: GastoDeNota,
  firma: FirmaVinculo,
): string {
  return `Vinculado a gasto en ${medioNota(gasto.medio_pago)} del ${fechaNota(gasto.fecha_gasto)} (${detalleGasto(gasto)}): ${cola(firma)}`;
}

/**
 * Línea del GASTO: «⚠ Conciliado con el cargo bancario del 07-sep-2026
 * ($212.00 · ASUR CANCUN) sin cambiar el medio de pago (EFECTIVO):
 * <justificación> — <usuario>, 06-oct-2026».
 */
export function lineaNotaGasto(
  cargo: CargoDeNota,
  medioGasto: string | null | undefined,
  firma: FirmaVinculo,
): string {
  return `⚠ Conciliado con el cargo bancario del ${fechaNota(cargo.fecha)} (${detalleCargo(cargo)}) sin cambiar el medio de pago (${medioNota(medioGasto)}): ${cola(firma)}`;
}

const FECHA_RE = String.raw`(?:\d{2}-[a-z]{3}-\d{4}|sin fecha)`;

/** Forma EXACTA de la línea del cargo (grupos 2 y 3 = la llave del gasto). */
const RE_LINEA_CARGO = new RegExp(
  String.raw`^Vinculado a gasto en (.+?) del (${FECHA_RE}) \((.+?)\): (.+) — (.+), ${FECHA_RE}$`,
);

/** Forma EXACTA de la línea del gasto (grupos 1 y 2 = la llave del cargo). */
const RE_LINEA_GASTO = new RegExp(
  String.raw`^⚠ Conciliado con el cargo bancario del (${FECHA_RE}) \((.+?)\) sin cambiar el medio de pago \((.+?)\): (.+) — (.+), ${FECHA_RE}$`,
);

type FormaLinea = 'CARGO' | 'GASTO';

/**
 * ¿Es una línea del vínculo? ⇒ su forma y su LLAVE (el otro lado del par:
 * fecha + detalle del gasto en la nota del cargo; fecha + detalle del cargo
 * en la del gasto). El medio NO entra en la llave: si la oficina corrige el
 * medio después, la línea se sigue reconociendo.
 */
function llaveDeLinea(
  linea: string,
): { forma: FormaLinea; llave: string } | null {
  const l = linea.trim();
  const c = RE_LINEA_CARGO.exec(l);
  if (c) return { forma: 'CARGO', llave: `${c[2]}|${c[3]}` };
  const g = RE_LINEA_GASTO.exec(l);
  if (g) return { forma: 'GASTO', llave: `${g[1]}|${g[2]}` };
  return null;
}

/** ¿El renglón lo escribió esta regla (cualquiera de las dos formas)? */
export function esLineaVinculoNoBancario(linea: string): boolean {
  return llaveDeLinea(linea) !== null;
}

/** ¿Las notas traen alguna línea del vínculo? (para no escribir de balde). */
export function tieneNotasVinculoNoBancario(
  notas: string | null | undefined,
): boolean {
  return (
    typeof notas === 'string' &&
    notas.split(/\r?\n/).some((l) => llaveDeLinea(l) !== null)
  );
}

/** Llave con la que la nota del CARGO nombra a este gasto. */
function llaveGasto(g: GastoDeNota): string {
  return `${fechaNota(g.fecha_gasto)}|${detalleGasto(g)}`;
}

/** Llave con la que la nota del GASTO nombra a este cargo. */
function llaveCargo(c: CargoDeNota): string {
  return `${fechaNota(c.fecha)}|${detalleCargo(c)}`;
}

/**
 * Agrega la línea SIN pisar lo que ya había. Idempotente: si ya está la
 * MISMA línea, las notas no cambian; si ya hay una línea del MISMO par
 * (misma llave) con otra razón, se reemplaza en su lugar (una línea por
 * par). Va al FINAL, separada por un renglón en blanco (el bloque
 * «Desglose:» del panel termina en el primer renglón vacío: pegada a él, la
 * limpieza del desglose se la llevaría); junto a otra línea del vínculo va
 * renglón seguido.
 */
export function agregarNotaVinculo(
  notas: string | null | undefined,
  linea: string,
): string {
  const nueva = linea.trim();
  const base = typeof notas === 'string' ? notas : '';
  const lineas = base.split(/\r?\n/);
  const k = llaveDeLinea(nueva);
  if (k) {
    const i = lineas.findIndex((l) => {
      const otra = llaveDeLinea(l);
      return !!otra && otra.forma === k.forma && otra.llave === k.llave;
    });
    if (i >= 0) {
      if (lineas[i].trim() === nueva) return base;
      lineas[i] = nueva;
      return lineas.join('\n');
    }
  }
  if (lineas.some((l) => l.trim() === nueva)) return base;
  const cuerpo = base.replace(/\s+$/, '');
  if (!cuerpo) return nueva;
  const ultima = cuerpo.split(/\r?\n/).pop() ?? '';
  const sep = llaveDeLinea(ultima) ? '\n' : '\n\n';
  return `${cuerpo}${sep}${nueva}`;
}

/** Qué líneas del vínculo se retiran (sin filtro: TODAS). */
export interface FiltroNotasVinculo {
  /** En las notas de un GASTO: solo la línea de ESTE cargo. */
  cargo?: CargoDeNota;
  /** En las notas de un CARGO: solo la línea de ESTE gasto. */
  gasto?: GastoDeNota;
}

/**
 * Retira las líneas del vínculo (al DESVINCULAR, en los dos lados). Sin
 * filtro, todas las de las dos formas; con `cargo`, solo la línea del gasto
 * que nombra a ese cargo; con `gasto`, solo la línea del cargo que nombra a
 * ese gasto. Lo que escribió la oficina queda intacto; los renglones en
 * blanco que dejó el retiro se compactan. Sin nada que retirar, las notas
 * salen IDÉNTICAS; vacías ⇒ null.
 */
export function quitarNotasVinculoNoBancario(
  notas: string | null | undefined,
  filtro?: FiltroNotasVinculo,
): string | null {
  if (typeof notas !== 'string') return null;
  const deCargo = filtro?.cargo ? llaveCargo(filtro.cargo) : null;
  const deGasto = filtro?.gasto ? llaveGasto(filtro.gasto) : null;
  const sinFiltro = deCargo === null && deGasto === null;
  const lineas = notas.split(/\r?\n/);
  const quedan = lineas.filter((l) => {
    const k = llaveDeLinea(l);
    if (!k) return true;
    if (sinFiltro) return false;
    if (deCargo !== null && k.forma === 'GASTO' && k.llave === deCargo) {
      return false;
    }
    if (deGasto !== null && k.forma === 'CARGO' && k.llave === deGasto) {
      return false;
    }
    return true;
  });
  if (quedan.length === lineas.length) return notas;
  const texto = quedan
    .join('\n')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim();
  return texto ? texto : null;
}

/** «28 sep», «27 sep y 28 sep», «24 sep, 27 sep, 28 sep y 2 más». */
function listaFechas(fechas: readonly string[]): string {
  const vistas = fechas.slice(0, 3);
  const resto = fechas.length - vistas.length;
  if (resto > 0) return `${vistas.join(', ')} y ${resto} más`;
  if (vistas.length <= 1) return vistas.join('');
  return `${vistas.slice(0, -1).join(', ')} y ${vistas[vistas.length - 1]}`;
}

/** «en efectivo» / «en «Personal Pablo»». */
function medioEnFrase(medio: string | null | undefined): string {
  if (medio === 'EFECTIVO') return 'en efectivo';
  return `en «${etiquetaMedioPago(medio) ?? 'sin medio de pago'}»`;
}

/**
 * Texto del 400 `JUSTIFICACION_REQUERIDA`: «El gasto del 28 sep está en
 * efectivo: para vincularlo a un cargo del banco escribe por qué (no cambia
 * el medio de pago).» — con varios, en plural y con sus fechas.
 */
export function mensajeJustificacionRequerida(
  gastos: ReadonlyArray<{
    fecha_gasto: string | null;
    medio_pago: string | null;
  }>,
): string {
  const cierre = 'escribe por qué (no cambia el medio de pago).';
  if (gastos.length === 0) {
    return `Para vincular un gasto que no se pagó con el banco a un cargo, ${cierre}`;
  }
  const medios = new Set(gastos.map((g) => g.medio_pago ?? ''));
  if (gastos.length === 1) {
    const [g] = gastos;
    return `El gasto del ${fechaMensaje(g.fecha_gasto)} está ${medioEnFrase(g.medio_pago)}: para vincularlo a un cargo del banco ${cierre}`;
  }
  if (medios.size === 1) {
    const fechas = gastos.map((g) => fechaMensaje(g.fecha_gasto));
    return `Los gastos del ${listaFechas(fechas)} están ${medioEnFrase(gastos[0].medio_pago)}: para vincularlos a un cargo del banco ${cierre}`;
  }
  const fechas = gastos.map(
    (g) => `${fechaMensaje(g.fecha_gasto)} (${medioEnFrase(g.medio_pago)})`,
  );
  return `Los gastos del ${listaFechas(fechas)} no se pagaron con el banco: para vincularlos a un cargo del banco ${cierre}`;
}

/**
 * Texto del 409 `GASTO_BODEGA`: una salida de inventario es un cargo
 * contable, jamás toca el banco (ni con justificación).
 */
export function mensajeGastoBodega(
  gastos: ReadonlyArray<{ fecha_gasto: string | null }>,
): string {
  const fechas = gastos.map((g) => fechaMensaje(g.fecha_gasto));
  if (fechas.length <= 1) {
    return `El gasto del ${fechas[0] ?? 'sin fecha'} es una salida de inventario (Bodega): no se pagó con el banco y no se puede vincular a un cargo.`;
  }
  return `Los gastos del ${listaFechas(fechas)} son salidas de inventario (Bodega): no se pagaron con el banco y no se pueden vincular a un cargo.`;
}
