import { fechaInicioCorta } from '../../common/inicio-oficial.util';
import {
  costoVigenteEn,
  existenciaDe,
  sortChrono,
  walkCardex,
  type CostoVigente,
  type MovForFifo,
} from './inventario-cardex.util';

/**
 * INICIO OFICIAL en el CARDEX (invariante 86, auditoría 16-oct-2026, API
 * 0.0.85). Los movimientos anteriores al inicio NO se listan (ficha del
 * artículo, `/inventory/movimientos` y su Excel, ficha y cardex libro), pero
 * la existencia y el precio vigente de HOY siguen saliendo del cardex
 * COMPLETO. En su lugar viaja este renglón sintético «Saldo inicial al
 * 1-sep-2026», armado con los MISMOS helpers del cardex (`walkCardex`,
 * `costoVigenteEn`) sobre las filas anteriores: NO se recalcula FIFO ni
 * existencia, solo se LEE el estado tras el último movimiento previo.
 */
export interface SaldoInicialCardex {
  /** Día del inicio oficial (AAAA-MM-DD). */
  fecha: string;
  /** «Saldo inicial al 1-sep-2026» (es-MX, listo para pintar). */
  etiqueta: string;
  /** Existencia tras el ÚLTIMO movimiento anterior al inicio. */
  existencia: number;
  /** Último precio de compra vigente a esa fecha (null = ninguno). */
  costo_vigente: CostoVigente | null;
}

/** ¿El movimiento es anterior al inicio? (`fecha_movimiento` es date). */
export function movAntesDelInicio(
  m: Pick<MovForFifo, 'fecha_movimiento'>,
  inicio: string | null,
): boolean {
  return !!inicio && String(m.fecha_movimiento).slice(0, 10) < inicio;
}

/**
 * Renglón «Saldo inicial al …» del cardex de UN artículo. `movs` = TODO su
 * cardex (cualquier orden). null sin inicio o sin movimientos anteriores
 * (entonces no hay renglón sintético).
 */
export function saldoInicialCardex(
  movs: MovForFifo[],
  inicio: string | null,
): SaldoInicialCardex | null {
  if (!inicio) return null;
  const previos = sortChrono(movs).filter((m) => movAntesDelInicio(m, inicio));
  if (previos.length === 0) return null;
  const ultimo = previos[previos.length - 1];
  const paso = ultimo.id ? walkCardex(movs).get(ultimo.id) : undefined;
  return {
    fecha: inicio,
    etiqueta: `Saldo inicial al ${fechaInicioCorta(inicio)}`,
    existencia: paso ? paso.stockDespues : existenciaDe(previos),
    costo_vigente: costoVigenteEn(previos, { fecha: inicio }),
  };
}
