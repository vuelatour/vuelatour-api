/**
 * Ventana semanal JUSTA para correcciones/bajas de gastos que la app encola
 * sin red (10-sep-2026, Lote 2 Ola B · B3).
 *
 * `assertOwnEnVentana` evaluaba «hoy ≤ límite de la semana de captura» al
 * RECIBIR el PATCH/DELETE: una corrección hecha el domingo sin señal y
 * subida el martes rebotaba 403 por culpa de la señal, no del piloto. Ahora
 * el PATCH (`UpdateGastoDto.capturado_en`) y el DELETE (`?capturado_en=`)
 * traen el momento REAL de la corrección: la semana se evalúa contra ese
 * sello cuando viene y es ≤ ahora (jamás a futuro), y la bitácora del gasto
 * conserva «corrección capturada el … · recibida el …».
 *
 * Helpers PUROS (con spec). La validación del sello es la ESTRICTA de
 * gastos (`resolverCapturadoEn`: zona obligatoria, no futuro > 10 min,
 * ≥ 2020 → 400 legible), igual que en el alta.
 */
import {
  fechaSelloCancun,
  resolverCapturadoEn,
  SELLO_CAPTURA_MIN_MS,
} from '../../common/capturado-en.util';
import { diaCancun, hoyCancun } from '../../common/fecha-cancun.util';

export interface SelloCorreccion {
  /** Instante de la corrección acotado a `ahora` (ms epoch). */
  ms: number;
  /** ISO UTC del instante acotado. */
  iso: string;
  /** Día Cancún (YYYY-MM-DD) de la corrección. */
  dia: string;
}

/**
 * Sello de la corrección: null si no viene; 400 si viene mal (zona, futuro
 * > 10 min, año absurdo); si viene ≤ 10 min a futuro (reloj adelantado) se
 * ACOTA a `ahora` — nunca se evalúa una semana contra un día futuro.
 */
export function resolverSelloCorreccion(
  capturadoEn: string | null | undefined,
  ahora: Date = new Date(),
): SelloCorreccion | null {
  if (capturadoEn == null || String(capturadoEn).trim() === '') return null;
  const iso = resolverCapturadoEn(capturadoEn, ahora);
  const ms = Math.min(Date.parse(iso), ahora.getTime());
  const isoAcotado = new Date(ms).toISOString();
  return { ms, iso: isoAcotado, dia: diaCancun(isoAcotado) };
}

/** Día Cancún contra el que se evalúa la ventana: el del sello, si no hoy. */
export function diaReferenciaVentana(
  sello: SelloCorreccion | null,
  ahora: Date = new Date(),
): string {
  return sello ? sello.dia : hoyCancun(ahora);
}

export type AccionCorreccion = 'Corrección' | 'Baja';

/**
 * Línea de bitácora (va a `notas`, que el trigger `tg_gasto_bitacora`
 * registra en el diff): `[Corrección capturada en la app el 14 sep 09:00 ·
 * recibida el 16 sep 11:32]`. null cuando no hay sello o la corrección fue
 * "en línea" (≤ 2 min de diferencia: sin ruido).
 */
export function lineaSelloCorreccion(
  accion: AccionCorreccion,
  sello: SelloCorreccion | null,
  ahora: Date = new Date(),
): string | null {
  if (!sello) return null;
  if (ahora.getTime() - sello.ms <= SELLO_CAPTURA_MIN_MS) return null;
  return `[${accion} capturada en la app el ${fechaSelloCancun(new Date(sello.ms))} · recibida el ${fechaSelloCancun(ahora)}]`;
}
