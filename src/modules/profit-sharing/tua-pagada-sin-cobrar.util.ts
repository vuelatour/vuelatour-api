/**
 * PRE-CIERRE → «Vuelos con TUA pagada por Operación sin TUA cobrada al
 * cliente» (15-oct-2026, PEDIDO 4 del cliente). Sustituye al renglón
 * `tua_cobrada_sin_pagada` (13-oct-2026, invariante 66), RETIRADO a pedido
 * textual: «el que nos importa es cuando no se cotizó pero sí se pagó
 * nosotros Operación los TUAS».
 *
 * Aquí vive también el UNIVERSO COMPARTIDO de los dos renglones inversos
 * (`candidatosPrecierreInversos`, que usa además
 * `transporte_pagado_sin_cotizar`) y la fuente de lo PACTADO
 * (`extrasPactados`).
 *
 * Universo: vuelos COMPLETADO del periodo (cortes Cancún), PROPIOS
 * (`es_externo` ≠ true), cliente NO interno (reposicionamiento/demostración/
 * servicio no tienen a quién cobrarle: misma regla que `cobros_pendientes`)
 * y con total > 0 (`particionIngresoVuelo(v).total_usd`): los de $0 no
 * cotizaron nada y ya viven en `vuelos_sin_precio`; los vuelos de servicio
 * no se cotizan ⇒ fuera por construcción, sin leer `escala`.
 *
 * TUA cobrada = 0 por la FUENTE ÚNICA `particionIngresoVuelo(v).tuas_usd`
 * (prohibido leer `vuelo.tuas_usd` o el snapshot a mano). TUA pagada > 0 por
 * la FUENTE ÚNICA `trasladosPagadosDeGasto(g).tua` (gasto TUAS entero, TUA
 * embebida leída por la IA que CUADRA o `tua_incluida` de la oficina) sobre
 * los gastos con `vuelo_id` de CUALQUIER fecha. `pase_abordar = true` ENTRA
 * marcado (cobro doble o lectura mal etiquetada: decide la oficina).
 * Montos por moneda del gasto, JAMÁS sumados entre sí.
 *
 * Aviso NO bloqueante y sin «descartar». Helpers PUROS: la consulta vive en
 * `profit-sharing.service` (`inversosPrecierre`).
 */
import {
  particionIngresoVuelo,
  type VueloIngresoInput,
} from '../../common/ingreso-vuelo.util';
import { trasladosPagadosDeGasto } from '../../common/desglose-gasto.util';

export const CLAVE_PRECIERRE_TUA_PAGADA_SIN_COBRAR = 'tua_pagada_sin_cobrar';

export const TITULO_PRECIERRE_TUA_PAGADA_SIN_COBRAR =
  'Vuelos con TUA pagada por Operación sin TUA cobrada al cliente';

export const DETALLE_PRECIERRE_TUA_PAGADA_SIN_COBRAR =
  'Vuelos completados del periodo cuya cotización NO cobra TUA (tarifa de uso de aeropuerto) y que sí tienen un gasto que la paga: un gasto «TUAS» o una factura de aeropuerto con la TUA separada (leída por la IA o capturada en «TUA incluida en este gasto»). Operación pagó una TUA que no se le cobró al cliente: abre la cotización y enciende «Se cobran TUAS» (o agrégala como extra). Si el pasajero compró su pase de abordar y pagó su propia TUA, revisa la factura en Gastos → «Verificar / editar» (una TUA ahí sería cobro doble o una lectura mal etiquetada). Montos: TUA pagada con IVA, en la moneda del gasto. No bloquea el cierre.';

/** Texto cuando la lectura FALLÓ: el 0 no significa «no hay». */
export const DETALLE_PRECIERRE_TUA_PAGADA_SIN_COBRAR_FALLIDA =
  'No se pudo verificar la TUA pagada de los vuelos del periodo: revisa las facturas de aeropuerto en Gastos y las cotizaciones sin TUAS antes de cerrar.';

/** Vuelo COMPLETADO tal como lo lee el pre-cierre (select de completados + pase_abordar + extras). */
export interface VueloInversoRow extends VueloIngresoInput {
  id?: unknown;
  folio?: unknown;
  fecha_vuelo?: unknown;
  aeronave_id?: unknown;
  es_externo?: unknown;
  cliente_id?: unknown;
  pase_abordar?: unknown;
  extras?: unknown;
}

/** Universo COMPARTIDO de los dos renglones inversos. */
export interface VueloCandidatoInverso {
  id: string;
  folio: number;
  fecha_vuelo: string | null;
  aeronave_id: string | null;
  /** `vuelo.pase_abordar === true`. */
  pase_abordar: boolean;
  /** `round2(particionIngresoVuelo(v).tuas_usd)` (pre-IVA, USD). */
  tua_cobrada_usd: number;
  /** `extrasPactados(v)`. */
  extras: unknown;
}

/** Chip del renglón `tua_pagada_sin_cobrar`. */
export interface VueloTuaPagadaSinCobrar {
  id: string;
  folio: number;
  fecha_vuelo: string | null;
  matricula: string | null;
  /** Σ TUA pagada (IVA incluido) de los gastos en MXN. */
  tua_pagada_mxn: number;
  /** Σ TUA pagada (IVA incluido) de los gastos en USD. */
  tua_pagada_usd: number;
  pase_abordar: boolean;
  /** Número de gastos del vuelo que pagan TUA. */
  gastos_n: number;
}

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Lo PACTADO: `calculo_snapshot.extras` (ExtraCalculado[], lo que escribe
 * `revise()`); respaldo `vuelo.extras` SOLO cuando el snapshot no trae
 * arreglo; nada ⇒ `[]`. (Prod 15-oct-2026: paridad 65/65.)
 */
export function extrasPactados(v: {
  calculo_snapshot?: unknown;
  extras?: unknown;
}): unknown[] {
  const snap = v.calculo_snapshot;
  if (snap && typeof snap === 'object') {
    const ex = (snap as { extras?: unknown }).extras;
    if (Array.isArray(ex)) return ex as unknown[];
  }
  return Array.isArray(v.extras) ? (v.extras as unknown[]) : [];
}

/**
 * Universo de los renglones inversos: COMPLETADO (ya filtrado por la
 * consulta) propios, con id, cliente NO interno y total > 0.
 */
export function candidatosPrecierreInversos(
  completados: ReadonlyArray<VueloInversoRow>,
  clientesInternos: ReadonlySet<string>,
): VueloCandidatoInverso[] {
  const out: VueloCandidatoInverso[] = [];
  for (const v of completados) {
    if (typeof v.id !== 'string' || v.es_externo === true) continue;
    if (typeof v.cliente_id === 'string' && clientesInternos.has(v.cliente_id))
      continue;
    const particion = particionIngresoVuelo(v);
    if (!(particion.total_usd > 0)) continue;
    out.push({
      id: v.id,
      folio: Number(v.folio ?? 0),
      fecha_vuelo: typeof v.fecha_vuelo === 'string' ? v.fecha_vuelo : null,
      aeronave_id: typeof v.aeronave_id === 'string' ? v.aeronave_id : null,
      pase_abordar: v.pase_abordar === true,
      tua_cobrada_usd: round2(particion.tuas_usd),
      extras: extrasPactados(v),
    });
  }
  return out;
}

/**
 * TUA pagada por `vuelo_id`, en la moneda de cada gasto (fuente única
 * `trasladosPagadosDeGasto`): `{ mxn, usd, n }` con `n` = gastos que pagan
 * TUA. El enum `public.moneda` solo tiene MXN/USD: lo que no sea USD es MXN.
 */
export function tuaPagadaPorVuelo(
  gastos: ReadonlyArray<Record<string, unknown>>,
): Map<string, { mxn: number; usd: number; n: number }> {
  const out = new Map<string, { mxn: number; usd: number; n: number }>();
  for (const g of gastos) {
    if (typeof g.vuelo_id !== 'string' || !g.vuelo_id) continue;
    const tua = trasladosPagadosDeGasto(g).tua;
    if (!(tua > 0)) continue;
    const acc = out.get(g.vuelo_id) ?? { mxn: 0, usd: 0, n: 0 };
    if (g.moneda === 'USD') acc.usd = round2(acc.usd + tua);
    else acc.mxn = round2(acc.mxn + tua);
    acc.n += 1;
    out.set(g.vuelo_id, acc);
  }
  return out;
}

/** Comparador común: `fecha_vuelo` asc, empate por folio, sin fecha al final. */
export function ordenPorFechaFolio<
  T extends { fecha_vuelo: string | null; folio: number },
>(a: T, b: T): number {
  const ms = (f: string | null) => {
    const t = f ? Date.parse(f) : NaN;
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  };
  return ms(a.fecha_vuelo) - ms(b.fecha_vuelo) || a.folio - b.folio;
}

/**
 * Los candidatos SIN TUA cobrada y CON TUA pagada, con su matrícula (o
 * null), por `fecha_vuelo` (empate por folio; sin fecha, al final).
 */
export function vuelosConTuaPagadaSinCobrar(args: {
  candidatos: ReadonlyArray<VueloCandidatoInverso>;
  gastos: ReadonlyArray<Record<string, unknown>>;
  matriculas: ReadonlyMap<string, string>;
}): VueloTuaPagadaSinCobrar[] {
  const pagada = tuaPagadaPorVuelo(args.gastos);
  const out: VueloTuaPagadaSinCobrar[] = [];
  for (const v of args.candidatos) {
    if (v.tua_cobrada_usd > 0) continue;
    const p = pagada.get(v.id);
    if (!p || !(p.mxn > 0 || p.usd > 0)) continue;
    out.push({
      id: v.id,
      folio: v.folio,
      fecha_vuelo: v.fecha_vuelo,
      matricula: v.aeronave_id
        ? (args.matriculas.get(v.aeronave_id) ?? null)
        : null,
      tua_pagada_mxn: round2(p.mxn),
      tua_pagada_usd: round2(p.usd),
      pase_abordar: v.pase_abordar,
      gastos_n: p.n,
    });
  }
  return out.sort(ordenPorFechaFolio);
}
