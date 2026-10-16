import { BadRequestException } from '@nestjs/common';
import { diaCancun } from './fecha-cancun.util';

/**
 * INICIO OFICIAL DEL SISTEMA (16-oct-2026, API 0.0.84, invariante 86).
 * FUENTE ÚNICA de las reglas del «piso»: la fecha vive en
 * `configuracion_sistema` (clave `fecha_inicio_oficial`, `valor_json =
 * ["AAAA-MM-DD"]`, día de pared Cancún) y la lee
 * `ConfiguracionService.inicioOficial()`. `null` = sin piso: todo se
 * comporta exactamente como 0.0.83.
 *
 * El piso SOLO OCULTA: se aplica en la ENTRADA de los lectores (listados,
 * ventanas por default y reportes por periodo), NUNCA en siembras, ventanas
 * ±N días, saldos ni detalle por id. Ningún número de un periodo que empiece
 * en el inicio o después cambia.
 */

/** Lector mínimo de la fecha (mocks parciales de ConfiguracionService). */
export interface LectorInicioOficial {
  inicioOficial?: () => Promise<string | null>;
}

/**
 * Fecha de inicio oficial a través de una envoltura tolerante: los specs
 * existentes pasan mocks PARCIALES de `ConfiguracionService` (p. ej.
 * `{ fecha: jest.fn() }`) o ninguno (`@Optional()`); llamar directo a
 * `cfg.inicioOficial()` los rompería. Sin servicio o sin el método ⇒ null.
 * Un fallo del lector también ⇒ null (best-effort: jamás tira un listado).
 */
export async function inicioOficialDe(
  cfg?: LectorInicioOficial | null,
): Promise<string | null> {
  if (!cfg || typeof cfg.inicioOficial !== 'function') return null;
  try {
    const v = await cfg.inicioOficial();
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Corte para columnas timestamptz: medianoche Cancún del día de inicio. */
export function corteTs(inicio: string): string {
  return `${inicio}T00:00:00-05:00`;
}

/**
 * `desde` con piso (días `AAAA-MM-DD`, comparación de texto). Sin inicio ⇒
 * `desde` tal cual; sin `desde` ⇒ el inicio; si no, el mayor.
 */
export function pisoDia(
  desde: string | undefined | null,
  inicio: string | null,
): string | undefined {
  const d = desde ?? undefined;
  if (!inicio) return d;
  if (!d) return inicio;
  return d.slice(0, 10) < inicio ? inicio : d;
}

/**
 * Rango con piso para LISTADOS: sube el `desde` y marca `vacio` cuando el
 * rango entero queda antes del inicio (el lector responde lista vacía,
 * nunca 400).
 */
export function rangoConPiso(
  r: { desde?: string | null; hasta?: string | null },
  inicio: string | null,
): { desde: string | undefined; hasta: string | undefined; vacio: boolean } {
  const hasta = r.hasta ?? undefined;
  const desde = pisoDia(r.desde, inicio);
  const vacio = !!inicio && !!hasta && hasta.slice(0, 10) < inicio;
  return { desde, hasta, vacio };
}

/** Mensaje del 400 de reportes (fecha en es-MX corta). */
export function mensajePeriodoAntesDelInicio(inicio: string): string {
  return `El sistema arranca el ${fechaInicioCorta(inicio)}. Elige un periodo a partir de esa fecha.`;
}

/**
 * REPORTES por periodo (rango obligatorio): si `hasta < inicio` ⇒ 400
 * `PERIODO_ANTES_DEL_INICIO` con `details {inicio}`; si no, `{desde: max,
 * hasta}`. Sin inicio ⇒ intacto. El periodo subido es el que se usa en
 * TODO (consultas, títulos, nombres de archivo).
 */
export function exigirPeriodoDesdeInicio(
  desde: string,
  hasta: string,
  inicio: string | null,
): { desde: string; hasta: string } {
  if (!inicio) return { desde, hasta };
  if (hasta.slice(0, 10) < inicio) {
    throw new BadRequestException({
      message: mensajePeriodoAntesDelInicio(inicio),
      error: 'PERIODO_ANTES_DEL_INICIO',
      details: { inicio },
    });
  }
  return { desde: desde.slice(0, 10) < inicio ? inicio : desde, hasta };
}

/**
 * ¿La fecha (día `AAAA-MM-DD` o timestamptz) cae antes del inicio? Un
 * instante se convierte primero a día Cancún: `2026-09-01T04:59:59Z` es el
 * 31-ago en Cancún ⇒ antes. Sin inicio o sin fecha ⇒ false.
 */
export function esAntesDelInicio(
  fechaOTs: string | null | undefined,
  inicio: string | null,
): boolean {
  if (!inicio || !fechaOTs) return false;
  let dia: string;
  try {
    dia = diaCancun(fechaOTs);
  } catch {
    return false;
  }
  return dia < inicio;
}

const MESES_CORTOS = [
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
];

/** `2026-09-01` ⇒ `1-sep-2026` (es-MX). Entrada inválida ⇒ tal cual. */
export function fechaInicioCorta(inicio: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(inicio);
  if (!m) return inicio;
  const mes = MESES_CORTOS[Number(m[2]) - 1];
  if (!mes) return inicio;
  return `${Number(m[3])}-${mes}-${m[1]}`;
}
