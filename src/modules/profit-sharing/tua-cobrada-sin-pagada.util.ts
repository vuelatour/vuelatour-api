/**
 * PRE-CIERRE → «Vuelos con TUA cobrada al cliente sin TUA pagada»
 * (13-oct-2026, TUA sistémica, invariante 66; decisión 2 del lote del
 * cliente del 13-oct-2026).
 *
 * Caso #383 (gasto 8c60e428): la IA leyó corrida la tabla resumen de ASUR y
 * llamó «Autobuses» a la Tarifa TUA de $559.63. Nada se separó: la fila del
 * vuelo cargó la TUA como OPERACIONES (costo del avión que no es suyo) y
 * «Otros movimientos» dejó la línea TUAS cobrada al cliente SIN egreso. Y el
 * #118 (45007a9c, ago-2026): sus renglones no cuadran por $29.71 y la TUA
 * nunca se separó. Este renglón los caza desde el lado del VUELO.
 *
 * Universo: vuelos COMPLETADO del periodo (cortes Cancún), PROPIOS
 * (`es_externo` ≠ true: la TUA de un externo va dentro del costo del
 * operador) con TUA COBRADA > 0 según la FUENTE ÚNICA de la partición del
 * ingreso (`particionIngresoVuelo(v).tuas_usd`, pre-IVA, la misma de «Otros
 * movimientos» y del Libro Dinero; prohibido leer `vuelo.tuas_usd` o el
 * snapshot a mano). Las particiones `inconsistente` ENTRAN a propósito:
 * «Otros movimientos» también lista sus líneas TUAS. Cancelados fuera.
 * Un vuelo sale si NINGÚN gasto con `vuelo_id` = el vuelo (de CUALQUIER
 * fecha: la factura del aeropuerto llega días después) paga TUA según
 * `tuaPagadaDeGasto` (un gasto «TUAS» entero, o una factura de aeropuerto
 * con la TUA separada — leída por la IA o capturada por la oficina en «TUA
 * incluida en este gasto»). Existencia, no monto: no se convierte moneda.
 *
 * Aviso NO bloqueante y sin «descartar» (como `vuelos_sin_gasto_operaciones`):
 * un vuelo que pagó la TUA en ventanilla sin factura deja el aviso vivo
 * (marcarlo exigiría una columna nueva; decisión del cliente).
 *
 * Helpers PUROS: la consulta vive en `profit-sharing.service`
 * (`vuelosTuaCobradaSinPagada`); aquí solo el universo y la respuesta.
 */
import {
  particionIngresoVuelo,
  type VueloIngresoInput,
} from '../../common/ingreso-vuelo.util';
import { tuaPagadaDeGasto } from '../../common/desglose-gasto.util';

export const CLAVE_PRECIERRE_TUA_COBRADA_SIN_PAGADA = 'tua_cobrada_sin_pagada';

export const TITULO_PRECIERRE_TUA_COBRADA_SIN_PAGADA =
  'Vuelos con TUA cobrada al cliente sin TUA pagada';

export const DETALLE_PRECIERRE_TUA_COBRADA_SIN_PAGADA =
  'Vuelos completados del periodo cuya cotización cobró TUA (tarifa de uso de aeropuerto) y que no tienen ningún gasto que la pague: ni un gasto «TUAS» ni una factura de aeropuerto con la TUA separada (leída por la IA o capturada en «TUA incluida en este gasto»). Si la TUA venía dentro de la factura del aeropuerto, hoy se está cargando al avión como operación: ábrela en Gastos → «Verificar / editar» y captura la TUA incluida; si se pagó aparte, captura el gasto TUAS en el vuelo. Montos: TUA cobrada sin IVA, en USD. No bloquea el cierre.';

/** Texto cuando la lectura FALLÓ: el 0 no significa «no hay». */
export const DETALLE_PRECIERRE_TUA_COBRADA_SIN_PAGADA_FALLIDA =
  'No se pudo verificar la TUA pagada de los vuelos del periodo: revisa los gastos de aeropuerto y «Otros movimientos» del Balance general antes de cerrar.';

/** Vuelo COMPLETADO del periodo, tal como lo lee el pre-cierre. */
export interface VueloTuaCobradaRow extends VueloIngresoInput {
  id?: unknown;
  folio?: unknown;
  fecha_vuelo?: unknown;
  aeronave_id?: unknown;
  es_externo?: unknown;
}

/** Candidato: vuelo propio con TUA cobrada (pre-IVA, USD). */
export interface VueloTuaCobrada {
  id: string;
  folio: number;
  fecha_vuelo: string | null;
  aeronave_id: string | null;
  tua_cobrada_usd: number;
}

/** Chip del checklist (`matricula` y `tua_cobrada_usd` aditivos). */
export interface VueloTuaCobradaSinPagada {
  id: string;
  folio: number;
  fecha_vuelo: string | null;
  matricula: string | null;
  tua_cobrada_usd: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Candidatos: COMPLETADO PROPIOS con TUA cobrada > 0 por la partición única
 * del ingreso (las inconsistentes incluidas).
 */
export function candidatosTuaCobrada(
  completados: ReadonlyArray<VueloTuaCobradaRow>,
): VueloTuaCobrada[] {
  const out: VueloTuaCobrada[] = [];
  for (const v of completados) {
    if (typeof v.id !== 'string' || v.es_externo === true) continue;
    const tua = round2(particionIngresoVuelo(v).tuas_usd);
    if (!(tua > 0)) continue;
    out.push({
      id: v.id,
      folio: Number(v.folio ?? 0),
      fecha_vuelo: typeof v.fecha_vuelo === 'string' ? v.fecha_vuelo : null,
      aeronave_id: typeof v.aeronave_id === 'string' ? v.aeronave_id : null,
      tua_cobrada_usd: tua,
    });
  }
  return out;
}

/**
 * `vuelo_id` de los vuelos con ALGÚN gasto que paga TUA
 * (`tuaPagadaDeGasto` > 0: gasto TUAS, o la TUA embebida con la de la
 * oficina). Existencia, no monto: no se convierte moneda.
 */
export function vuelosConTuaPagada(
  gastos: ReadonlyArray<Record<string, unknown>>,
): Set<string> {
  const out = new Set<string>();
  for (const g of gastos) {
    if (typeof g.vuelo_id !== 'string') continue;
    if (tuaPagadaDeGasto(g) > 0) out.add(g.vuelo_id);
  }
  return out;
}

/**
 * Los candidatos sin ningún gasto que pague TUA, con su matrícula (o null),
 * por `fecha_vuelo` (empate por folio; sin fecha, al final).
 */
export function vuelosConTuaCobradaSinPagada(args: {
  candidatos: ReadonlyArray<VueloTuaCobrada>;
  vuelosConTuaPagada: ReadonlySet<string>;
  matriculas: ReadonlyMap<string, string>;
}): VueloTuaCobradaSinPagada[] {
  const out: VueloTuaCobradaSinPagada[] = [];
  for (const v of args.candidatos) {
    if (args.vuelosConTuaPagada.has(v.id)) continue;
    out.push({
      id: v.id,
      folio: v.folio,
      fecha_vuelo: v.fecha_vuelo,
      matricula: v.aeronave_id
        ? (args.matriculas.get(v.aeronave_id) ?? null)
        : null,
      tua_cobrada_usd: v.tua_cobrada_usd,
    });
  }
  const ms = (f: string | null) => {
    const t = f ? Date.parse(f) : NaN;
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  };
  return out.sort(
    (a, b) => ms(a.fecha_vuelo) - ms(b.fecha_vuelo) || a.folio - b.folio,
  );
}
