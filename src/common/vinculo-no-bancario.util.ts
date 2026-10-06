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
 *    · vuelo #330 · $212.00 · gasto 3f9a1c2e): <justificación> — <usuario>,
 *    06-oct-2026»
 *  - Gasto (`gasto.notas`), una línea por cargo:
 *    «⚠ Conciliado con el cargo bancario del 07-sep-2026 ($212.00 · ASUR
 *    CANCUN) sin cambiar el medio de pago (EFECTIVO): <justificación> —
 *    <usuario>, 06-oct-2026»
 *
 * «gasto 3f9a1c2e» (revisión 6-oct-2026) = los 8 primeros caracteres del id
 * del gasto: es la LLAVE de la línea del cargo. Con fecha · categoría ·
 * vuelo · monto como llave, dos estacionamientos iguales del mismo día en
 * un lote compartían UNA línea (y soltar uno borraba la del otro), y un
 * gasto al que le cambiaban la categoría o el vuelo después de ligarse
 * (siguen editables) dejaba su línea huérfana en el cargo al soltarlo. La
 * línea del GASTO no lo necesita: fecha, monto y leyenda del cargo vienen
 * del estado de cuenta y no se editan.
 *
 * Aquí vive, PURO y con spec, TODO el texto de la regla: las dos líneas, su
 * alta idempotente (una línea por par cargo ↔ gasto; la misma no se
 * duplica, una razón nueva la reemplaza), su retiro al desvincular (regex de
 * la forma EXACTA: lo que escribió la oficina —texto, renglones en blanco,
 * espacios y fines de línea— queda intacto) y los mensajes del 400
 * `JUSTIFICACION_REQUERIDA` y de los 409 `GASTO_BODEGA` y
 * `NO_BANCARIO_OTRA_MONEDA`. Etiquetas de medio y categoría: las utils de
 * siempre (`etiquetaMedioPago`, `etiquetaCategoriaGasto`). Fechas
 * `dd-mmm-aaaa` cortando el texto (jamás `new Date`: restaría un día en
 * Cancún).
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
  /** Id del gasto: sus 8 primeros caracteres son la llave de la línea. */
  id: string;
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

/** Referencia corta del gasto en la línea del cargo: «3f9a1c2e» (uuid en minúsculas). */
export function refGastoNota(id: string | null | undefined): string {
  return String(id ?? '')
    .trim()
    .slice(0, 8)
    .toLowerCase();
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
 * estacionamiento · vuelo #330 · $212.00 · gasto 3f9a1c2e): <justificación>
 * — <usuario>, 06-oct-2026».
 */
export function lineaNotaCargo(
  gasto: GastoDeNota,
  firma: FirmaVinculo,
): string {
  return `Vinculado a gasto en ${medioNota(gasto.medio_pago)} del ${fechaNota(gasto.fecha_gasto)} (${detalleGasto(gasto)} · gasto ${refGastoNota(gasto.id)}): ${cola(firma)}`;
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

/** Forma EXACTA de la línea del cargo (grupo 4 = la llave: «gasto 3f9a1c2e»). */
const RE_LINEA_CARGO = new RegExp(
  String.raw`^Vinculado a gasto en (.+?) del (${FECHA_RE}) \((.+?) · gasto ([\w-]{1,8})\): (.+) — (.+), ${FECHA_RE}$`,
);

/** Forma EXACTA de la línea del gasto (grupos 1 y 2 = la llave del cargo). */
const RE_LINEA_GASTO = new RegExp(
  String.raw`^⚠ Conciliado con el cargo bancario del (${FECHA_RE}) \((.+?)\) sin cambiar el medio de pago \((.+?)\): (.+) — (.+), ${FECHA_RE}$`,
);

type FormaLinea = 'CARGO' | 'GASTO';

/**
 * ¿Es una línea del vínculo? ⇒ su forma y su LLAVE (el otro lado del par:
 * la referencia «gasto 3f9a1c2e» en la nota del cargo; fecha + detalle del
 * cargo en la del gasto). Ni el medio ni la categoría, el vuelo o la fecha
 * del gasto entran en la llave del cargo: si la oficina los corrige
 * después, la línea se sigue reconociendo.
 */
function llaveDeLinea(
  linea: string,
): { forma: FormaLinea; llave: string } | null {
  const l = linea.trim();
  const c = RE_LINEA_CARGO.exec(l);
  if (c) return { forma: 'CARGO', llave: c[4].toLowerCase() };
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

/** Llave con la que la nota del GASTO nombra a este cargo. */
function llaveCargo(c: CargoDeNota): string {
  return `${fechaNota(c.fecha)}|${detalleCargo(c)}`;
}

/**
 * Un renglón de las notas con el fin de línea que lo SEPARA del anterior
 * (`''` en el primero). Reescribir por renglones así deja el texto de la
 * oficina byte a byte: sus espacios, sus renglones en blanco y sus `\r\n`.
 */
interface Renglon {
  texto: string;
  antes: string;
}

function renglones(notas: string): Renglon[] {
  const partes = notas.split(/(\r?\n)/);
  const out: Renglon[] = [];
  for (let i = 0; i < partes.length; i += 2) {
    out.push({ texto: partes[i], antes: i === 0 ? '' : partes[i - 1] });
  }
  return out;
}

/** Une los renglones; el primero que quede pierde su separador. */
function unirRenglones(rs: readonly Renglon[]): string {
  return rs.map((r, i) => (i === 0 ? r.texto : r.antes + r.texto)).join('');
}

const enBlanco = (r: Renglon | undefined) => !!r && r.texto.trim() === '';

/**
 * Agrega la línea SIN pisar lo que ya había. Idempotente: si ya está la
 * MISMA línea, las notas no cambian; si ya hay una línea del MISMO par
 * (misma llave) con otra razón, se reemplaza en su lugar (una línea por
 * par). Va justo después del ÚLTIMO renglón con texto, separada por un
 * renglón en blanco (el bloque «Desglose:» del panel termina en el primer
 * renglón vacío: pegada a él, la limpieza del desglose se la llevaría);
 * junto a otra línea del vínculo va renglón seguido. Lo de la oficina no se
 * toca (ni los blancos del final, que quedan después de la línea) y el fin
 * de línea es el de las notas (`\r\n` si ya lo usan).
 */
export function agregarNotaVinculo(
  notas: string | null | undefined,
  linea: string,
): string {
  const nueva = linea.trim();
  const base = typeof notas === 'string' ? notas : '';
  const rs = renglones(base);
  const k = llaveDeLinea(nueva);
  if (k) {
    const i = rs.findIndex((r) => {
      const otra = llaveDeLinea(r.texto);
      return !!otra && otra.forma === k.forma && otra.llave === k.llave;
    });
    if (i >= 0) {
      if (rs[i].texto.trim() === nueva) return base;
      rs[i] = { ...rs[i], texto: nueva };
      return unirRenglones(rs);
    }
  }
  if (rs.some((r) => r.texto.trim() === nueva)) return base;
  let ultimo = -1;
  for (let i = rs.length - 1; i >= 0; i -= 1) {
    if (!enBlanco(rs[i])) {
      ultimo = i;
      break;
    }
  }
  if (ultimo < 0) return nueva;
  const eol = base.includes('\r\n') ? '\r\n' : '\n';
  const insertar: Renglon[] = llaveDeLinea(rs[ultimo].texto)
    ? [{ texto: nueva, antes: eol }]
    : [
        { texto: '', antes: eol },
        { texto: nueva, antes: eol },
      ];
  rs.splice(ultimo + 1, 0, ...insertar);
  return unirRenglones(rs);
}

/** Qué líneas del vínculo se retiran (sin filtro: TODAS). */
export interface FiltroNotasVinculo {
  /** En las notas de un GASTO: solo la línea de ESTE cargo. */
  cargo?: CargoDeNota;
  /** En las notas de un CARGO: solo la línea de ESTE gasto (por su id). */
  gastoId?: string;
}

/**
 * Retira las líneas del vínculo (al DESVINCULAR, en los dos lados). Sin
 * filtro, todas las de las dos formas; con `cargo`, solo la línea del gasto
 * que nombra a ese cargo; con `gastoId`, solo la línea del cargo que nombra
 * a ese gasto («gasto 3f9a1c2e»). Se van SOLO esas líneas y, si un bloque
 * de líneas del vínculo se va COMPLETO, el renglón en blanco que
 * `agregarNotaVinculo` puso antes de él: agregar y quitar devuelve las notas
 * de antes byte a byte (texto, blancos y fines de línea de la oficina). Sin
 * nada que retirar, las notas salen IDÉNTICAS; vacías (o solo blancos) ⇒
 * null.
 */
export function quitarNotasVinculoNoBancario(
  notas: string | null | undefined,
  filtro?: FiltroNotasVinculo,
): string | null {
  if (typeof notas !== 'string') return null;
  // Sin filtro = TODAS; con filtro (aunque su id venga vacío) solo lo suyo:
  // un `gastoId` vacío jamás puede volverse «borra todo».
  const sinFiltro = filtro?.cargo == null && filtro?.gastoId == null;
  const deCargo = filtro?.cargo ? llaveCargo(filtro.cargo) : null;
  const deGasto =
    filtro?.gastoId != null ? refGastoNota(filtro.gastoId) || null : null;
  const rs = renglones(notas);
  const llaves = rs.map((r) => llaveDeLinea(r.texto));
  const quitar = llaves.map((k) => {
    if (!k) return false;
    if (sinFiltro) return true;
    if (deCargo !== null && k.forma === 'GASTO' && k.llave === deCargo) {
      return true;
    }
    return deGasto !== null && k.forma === 'CARGO' && k.llave === deGasto;
  });
  if (!quitar.some(Boolean)) return notas;
  // Bloque de líneas del vínculo que se va entero ⇒ también el renglón en
  // blanco de justo antes (el separador que puso el alta).
  for (let i = 0; i < rs.length; ) {
    if (!llaves[i]) {
      i += 1;
      continue;
    }
    let fin = i;
    while (fin + 1 < rs.length && llaves[fin + 1]) fin += 1;
    let entero = true;
    for (let j = i; j <= fin; j += 1) entero = entero && quitar[j];
    if (entero && i > 0 && enBlanco(rs[i - 1])) quitar[i - 1] = true;
    i = fin + 1;
  }
  const texto = unirRenglones(rs.filter((_, i) => !quitar[i]));
  return texto.trim() ? texto : null;
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

/**
 * Texto del 409 `NO_BANCARIO_OTRA_MONEDA` (revisión 6-oct-2026): un gasto
 * que no pasó por el banco solo se liga a un cargo de SU moneda. Cruzado
 * (dólares contra una cuenta en pesos), la BD le derivaría el tipo de cambio
 * de ese cargo (`recalcular_gasto_conciliado`), y ese cargo no lo pagó.
 */
export function mensajeNoBancarioOtraMoneda(
  gastos: ReadonlyArray<{ fecha_gasto: string | null; moneda: string | null }>,
  monedaCuenta: string | null | undefined,
): string {
  const monedas = [...new Set(gastos.map((g) => (g.moneda ?? '').trim()))];
  const en =
    monedas.length === 1 && monedas[0] ? `en ${monedas[0]}` : 'en otra moneda';
  const cuenta = monedaCuenta
    ? ` (este cargo es de una cuenta en ${monedaCuenta})`
    : '';
  if (gastos.length <= 1) {
    return `El gasto del ${fechaMensaje(gastos[0]?.fecha_gasto)} está ${en} y no se pagó con el banco: solo se puede vincular a un cargo de su misma moneda${cuenta}, para no cambiarle el tipo de cambio.`;
  }
  const fechas = gastos.map((g) => fechaMensaje(g.fecha_gasto));
  return `Los gastos del ${listaFechas(fechas)} están ${en} y no se pagaron con el banco: solo se pueden vincular a un cargo de su misma moneda${cuenta}, para no cambiarles el tipo de cambio.`;
}
