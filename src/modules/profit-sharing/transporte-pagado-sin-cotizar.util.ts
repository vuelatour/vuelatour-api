/**
 * PRE-CIERRE → «Vuelos con transporte pagado sin transporte cotizado»
 * (15-oct-2026, PEDIDO 4 del cliente: «Igual con los transportes, porque
 * pasa que no se cotizó el transporte pero luego sí se pide»).
 *
 * Universo: el MISMO de `tua_pagada_sin_cobrar`
 * (`candidatosPrecierreInversos`: completados propios, cliente no interno,
 * total > 0). Un vuelo se lista si algún gasto con su `vuelo_id` (de
 * CUALQUIER fecha, monto > 0) parece transporte de PASAJEROS
 * (`pareceTransporteDePasajeros`, heurística de texto congelada con prod) y
 * lo PACTADO (`extrasPactados`: `calculo_snapshot.extras`, respaldo
 * `vuelo.extras`) no trae ningún extra de transporte (`cotizoTransporte`).
 *
 * Es una SEÑAL, no una certeza: el `detalle` lo dice y nada se resuelve
 * solo; lo manual es «Seguimiento de la cotización» (invariante 32). Montos
 * = el gasto ENTERO (un taxi no se desglosa) por moneda, JAMÁS sumadas entre
 * sí. NO bloquea; sin «descartar». Helpers PUROS: la consulta vive en
 * `profit-sharing.service` (`inversosPrecierre`).
 */
import {
  cotizoTransporte,
  pareceTransporteDePasajeros,
  textoGastoTransporte,
  type GastoTextoTransporte,
} from '../../common/transporte-pasajeros.util';
import {
  ordenPorFechaFolio,
  type VueloCandidatoInverso,
} from './tua-pagada-sin-cobrar.util';

export const CLAVE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR =
  'transporte_pagado_sin_cotizar';

export const TITULO_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR =
  'Vuelos con transporte pagado sin transporte cotizado';

export const DETALLE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR =
  'Es una SEÑAL, no una certeza: vuelos completados del periodo con un gasto que parece transporte de PASAJEROS (traslado, transfer, camioneta, taxi privado…) y una cotización sin ningún extra de transporte. Revisa si se cobró: si no, agrégalo como extra en la cotización o anótalo en el detalle del vuelo → «Seguimiento de la cotización» para cobrarlo después. Los traslados de la tripulación (Uber, ADO, estacionamiento, ferry, tren) no cuentan. Montos: lo pagado, en la moneda del gasto. No bloquea el cierre.';

/** Texto cuando la lectura FALLÓ: el 0 no significa «no hay». */
export const DETALLE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR_FALLIDA =
  'No se pudo verificar los transportes pagados de los vuelos del periodo: revisa los gastos «Taxi / estacionamiento» de cada vuelo contra su cotización antes de cerrar.';

export interface GastoTransportePrecierre {
  id: string;
  /** `textoGastoTransporte` (≤ 60). */
  texto: string;
  /** `round2(Number(g.monto))`: el gasto entero, en su moneda. */
  monto: number;
  moneda: string;
}

export interface VueloTransporteSinCotizar {
  id: string;
  folio: number;
  fecha_vuelo: string | null;
  matricula: string | null;
  monto_mxn: number;
  monto_usd: number;
  gastos: GastoTransportePrecierre[];
}

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Candidatos con algún gasto de transporte de pasajeros y sin transporte
 * cotizado; `gastos[]` por `id` asc; vuelos por `fecha_vuelo` (empate por
 * folio; sin fecha, al final).
 */
export function vuelosConTransportePagadoSinCotizar(args: {
  candidatos: ReadonlyArray<VueloCandidatoInverso>;
  gastos: ReadonlyArray<Record<string, unknown>>;
  matriculas: ReadonlyMap<string, string>;
}): VueloTransporteSinCotizar[] {
  const porVuelo = new Map<string, GastoTransportePrecierre[]>();
  for (const g of args.gastos) {
    if (typeof g.vuelo_id !== 'string' || typeof g.id !== 'string') continue;
    const monto = Number(g.monto);
    if (!Number.isFinite(monto) || !(monto > 0)) continue;
    const gt = g as GastoTextoTransporte;
    if (!pareceTransporteDePasajeros(gt)) continue;
    const lista = porVuelo.get(g.vuelo_id) ?? [];
    lista.push({
      id: g.id,
      texto: textoGastoTransporte(gt),
      monto: round2(monto),
      moneda: typeof g.moneda === 'string' && g.moneda ? g.moneda : 'MXN',
    });
    porVuelo.set(g.vuelo_id, lista);
  }
  const out: VueloTransporteSinCotizar[] = [];
  for (const v of args.candidatos) {
    const gastos = porVuelo.get(v.id);
    if (!gastos || gastos.length === 0) continue;
    if (cotizoTransporte(v.extras)) continue;
    const ordenados = [...gastos].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    out.push({
      id: v.id,
      folio: v.folio,
      fecha_vuelo: v.fecha_vuelo,
      matricula: v.aeronave_id
        ? (args.matriculas.get(v.aeronave_id) ?? null)
        : null,
      monto_mxn: round2(
        ordenados
          .filter((g) => g.moneda !== 'USD')
          .reduce((a, g) => a + g.monto, 0),
      ),
      monto_usd: round2(
        ordenados
          .filter((g) => g.moneda === 'USD')
          .reduce((a, g) => a + g.monto, 0),
      ),
      gastos: ordenados,
    });
  }
  return out.sort(ordenPorFechaFolio);
}
