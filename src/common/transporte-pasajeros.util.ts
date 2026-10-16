/**
 * ¿Este gasto parece TRANSPORTE DE PASAJEROS? (15-oct-2026, PEDIDO 4 del
 * cliente: «pasa que no se cotizó el transporte pero luego sí se pide»).
 *
 * Heurística PURA de texto, congelada con los textos REALES de prod
 * (jul-oct 2026) en `transporte-pasajeros.util.spec.ts`. Alimenta el renglón
 * del pre-cierre `transporte_pagado_sin_cotizar` (es una SEÑAL, no una
 * certeza: el `detalle` lo dice y nada se resuelve solo).
 *
 * Regla: categoría ∈ {TAXI, OPERACIONES} ∧ ¬VETO ∧ (FUERTE ∨ (TAXI ∧ DÉBIL)).
 *  - Texto evaluado = lugar · proveedor de la IA · PRIMERA línea de notas
 *    (el resto de las notas suele ser el desglose de la IA o historia: el
 *    #40 trae «Taxi de fbo a ado» en la línea 5 de un reembolso).
 *  - FUERTES en las dos categorías: traslado, transporte, transfer(s),
 *    camioneta, van(s), shuttle. `\btransfers?\b`: «transferencia» (SPEI)
 *    NO es transfer.
 *  - DÉBILES solo en TAXI: privado, turístico, tour(s). En OPERACIONES
 *    «AVIALOGIA / Dolphin Air Tours» (tiempo de vuelo de un externo) o un
 *    «hangar privado» no son transporte.
 *  - VETOS (tripulación / logística / otro servicio) ganan sobre cualquier
 *    señal y van con límite de palabra: «Traslado» y «privado» NO disparan
 *    el veto «ado»; «turista» (Tren Maya) no es «turístic».
 *
 * Falsos negativos ACEPTADOS: «Servicio de taxi en Chetumal» (#167, sin
 * señal) y un traslado de pasajeros a un «hotel» (se veta).
 */
import { etiquetaCategoriaGasto } from './categoria-gasto.util';

/** Categorías donde se busca transporte de PASAJEROS. */
export const CATEGORIAS_TRANSPORTE_PASAJEROS: readonly string[] = [
  'TAXI',
  'OPERACIONES',
];

/** Señales FUERTES (TAXI y OPERACIONES). `\btransfers?\b`: «transferencia» (SPEI) NO es transfer. */
export const RE_TRANSPORTE_FUERTE =
  /traslad|\btransport|\btra[ns]{1,2}fer(?:s|es)?\b|camioneta|\bvans?\b|shuttle/i;

/** Señales DÉBILES (solo TAXI: en OPERACIONES «Dolphin Air Tours» o «hangar privado» no son transporte). */
export const RE_TRANSPORTE_DEBIL = /privad|tur[ií]stic|\btours?\b/i;

/**
 * Vetos = tripulación / logística / otro servicio. Ganan sobre cualquier
 * señal. Con límites de palabra: «Traslado» y «privado» NO disparan el veto
 * «ado»; «turista» (Tren Maya) no es «turístic».
 */
export const RE_TRANSPORTE_VETO =
  /\buber\b|\bdidis?\b|\bado\b|estacionamiento|restaurante|\bhotel|\bfbo\b|\bpilotos?\b|\btren\b|\bferry\b|\bapto\b|\bmoto\s?taxi|app\s+de\s+(?:transporte|viajes)|\d\s*km\b|gasolina|\bboletos?\b|transferencia|\bmuelle\b/i;

export interface GastoTextoTransporte {
  categoria?: string | null;
  lugar?: string | null;
  notas?: string | null;
  valor_ia_extraido?: unknown;
}

/** Proveedor que leyó la IA (`valor_ia_extraido.proveedor`), solo si es texto no vacío. */
function proveedorIa(valorIa: unknown): string {
  if (!valorIa || typeof valorIa !== 'object') return '';
  const p = (valorIa as { proveedor?: unknown }).proveedor;
  return typeof p === 'string' ? p.trim() : '';
}

/** Primera línea de las notas, sin espacios en los extremos ('' si no hay). */
function primeraLinea(notas: string | null | undefined): string {
  if (typeof notas !== 'string') return '';
  return (notas.split(/\r?\n/)[0] ?? '').trim();
}

/** Texto que se evalúa = [lugar, valor_ia_extraido.proveedor (string), PRIMERA línea de notas] no vacíos, unidos por « · ». */
export function textoDeGasto(g: GastoTextoTransporte): string {
  return [
    typeof g.lugar === 'string' ? g.lugar.trim() : '',
    proveedorIa(g.valor_ia_extraido),
    primeraLinea(g.notas),
  ]
    .filter((s) => s !== '')
    .join(' · ');
}

/** categoría ∈ CATEGORIAS ∧ ¬VETO ∧ (FUERTE ∨ (categoría === 'TAXI' ∧ DÉBIL)). */
export function pareceTransporteDePasajeros(g: GastoTextoTransporte): boolean {
  const cat = typeof g.categoria === 'string' ? g.categoria : '';
  if (!CATEGORIAS_TRANSPORTE_PASAJEROS.includes(cat)) return false;
  const texto = textoDeGasto(g);
  if (!texto || RE_TRANSPORTE_VETO.test(texto)) return false;
  if (RE_TRANSPORTE_FUERTE.test(texto)) return true;
  return cat === 'TAXI' && RE_TRANSPORTE_DEBIL.test(texto);
}

/**
 * Concepto de extra que es transporte (tolera «Tranfer», «Trasnfer»;
 * «Comision transferencia» NO). «Taxi» cuenta (revisión 0.0.81: el gasto TAXI
 * «Taxi privado…» dispara el renglón y la oficina, siguiendo el detalle, lo
 * cotiza como extra «Taxi privado»: sin esto el aviso no se apagaba nunca).
 */
export const RE_EXTRA_TRANSPORTE =
  /\btra[ns]{1,2}fer(?:s|es)?\b|traslad|\btransport|camioneta|\bvans?\b|shuttle|\btaxis?\b/i;

/**
 * ¿La cotización pactó un extra de transporte? `extras` es `unknown` a
 * propósito (jsonb crudo): no arreglo ⇒ false; algún `concepto` string que
 * cumpla `RE_EXTRA_TRANSPORTE` ⇒ true. Un «Tour» NO cuenta (el extra no
 * dice si incluye traslado).
 */
export function cotizoTransporte(extras: unknown): boolean {
  if (!Array.isArray(extras)) return false;
  return extras.some((e) => {
    if (!e || typeof e !== 'object') return false;
    const c = (e as { concepto?: unknown }).concepto;
    return typeof c === 'string' && RE_EXTRA_TRANSPORTE.test(c);
  });
}

export const TEXTO_GASTO_TRANSPORTE_MAX = 60;

const RE_SEGMENTO_META = /^(?:proveedor|matr[ií]cula)\s*:/i;

/**
 * Descripción corta para el chip: primera línea de notas partida por « · »,
 * sin los segmentos «Proveedor: …» / «Matrícula: …»; con ≥ 2 segmentos se
 * toma el ÚLTIMO (la IA escribe «<Proveedor> · <descripción>»); vacío ⇒
 * proveedor IA ⇒ lugar ⇒ etiquetaCategoriaGasto(categoria). Recorte a
 * `max` con «…» (max − 1 caracteres + «…»).
 */
export function textoGastoTransporte(
  g: GastoTextoTransporte,
  max: number = TEXTO_GASTO_TRANSPORTE_MAX,
): string {
  const segmentos = primeraLinea(g.notas)
    .split(' · ')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !RE_SEGMENTO_META.test(s));
  const base =
    segmentos[segmentos.length - 1] ||
    proveedorIa(g.valor_ia_extraido) ||
    (typeof g.lugar === 'string' ? g.lugar.trim() : '') ||
    etiquetaCategoriaGasto(g.categoria ?? null);
  return base.length > max ? `${base.slice(0, max - 1)}…` : base;
}
