/**
 * Control de versión optimista para EDICIONES que la app encola sin internet
 * (10-sep-2026, Lote 2 · Ola B; regla del doc funcional 6.1: si el dato
 * cambió en el servidor después de la captura, GANA EL SERVIDOR y se avisa).
 *
 * Contrato (todas las rutas de edición que lo adoptan):
 * - El cliente manda `if_updated_at` = el `updated_at` de la fila tal como
 *   la leyó (ISO). OPCIONAL: sin él, la ruta se comporta como siempre
 *   (last-writer-wins; panel y APK vieja intactos).
 * - Con él, el UPDATE se hace con CAS (compare-and-set) sobre `updated_at`
 *   —mismo patrón que `complete()` de flights.service sobre `estado`— y los
 *   flujos multi-paso validan contra la fila leída ANTES del primer paso.
 * - Si no coincide → 409 ESTRUCTURADO `CONFLICTO_VERSION` con
 *   `details.actual` (la fila viva con sus columnas públicas),
 *   `updated_at_enviado` y `updated_at_actual`. La app descarta su
 *   pendiente, refresca y avisa; nunca decide por `message`.
 *
 * Comparación COMO INSTANTES con tolerancia de 1 ms: Postgres guarda
 * microsegundos y PostgREST los serializa (`…56.123456+00:00`); un cliente
 * que parsea a Date y re-serializa manda `…56.123Z`. Comparar strings
 * rompería siempre; el CAS en BD usa una VENTANA [t−1 ms, t+1 ms] por la
 * misma razón (un `.eq` exacto contra el texto reserializado da 0 filas).
 */
import { BadRequestException, ConflictException } from '@nestjs/common';

/** Tolerancia al comparar instantes (redondeo de timestamptz). */
export const CAS_TOLERANCIA_MS = 1;

/** `error`/`code` del 409 de versión. */
export const CODE_CONFLICTO_VERSION = 'CONFLICTO_VERSION';

/** Entidades con control de versión (texto del `message`). */
export type EntidadVersionada =
  | 'vuelo'
  | 'tramo'
  | 'gasto'
  | 'evento'
  | 'mantenimiento'
  | 'reporte';

/** Descripción compartida para los DTOs (`@ApiPropertyOptional`). */
export const IF_UPDATED_AT_DESC =
  'Control de versión OPCIONAL (10-sep-2026): `updated_at` de la fila tal ' +
  'como la leyó el cliente (ISO). Si el servidor tiene una versión más nueva ' +
  '(tolerancia 1 ms) no se escribe nada y responde 409 CONFLICTO_VERSION con ' +
  'details.actual (la fila viva), updated_at_enviado y updated_at_actual: ' +
  'gana el servidor y la app avisa. Sin el campo, comportamiento de siempre.';

/** Milisegundos desde epoch de un ISO/Date, o null si no es un instante. */
export function instanteDe(v: unknown): number | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * ¿`enviado` y `actual` son el MISMO instante (± tolerancia)? Si alguno no
 * se puede interpretar como instante → false (conflicto): nunca se escribe
 * "a ciegas" con una llave que no se entiende.
 */
export function mismaVersion(
  enviado: unknown,
  actual: unknown,
  toleranciaMs: number = CAS_TOLERANCIA_MS,
): boolean {
  const a = instanteDe(enviado);
  const b = instanteDe(actual);
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= toleranciaMs;
}

/**
 * Ventana [desde, hasta] (ISO) para el CAS en BD: `updated_at >= desde AND
 * updated_at <= hasta`. 400 si `enviado` no es un instante (el DTO ya lo
 * valida con @IsDateString; aquí es defensa).
 */
export function ventanaCas(
  enviado: string,
  toleranciaMs: number = CAS_TOLERANCIA_MS,
): { desde: string; hasta: string } {
  const t = instanteDe(enviado);
  if (t == null) {
    throw new BadRequestException(
      'if_updated_at debe ser una fecha ISO válida (el updated_at que leíste).',
    );
  }
  return {
    desde: new Date(t - toleranciaMs).toISOString(),
    hasta: new Date(t + toleranciaMs).toISOString(),
  };
}

/** Builder de PostgREST (o cualquier query encadenable) con gte/lte. */
export interface BuilderCas<T> {
  gte(columna: string, valor: string): T;
  lte(columna: string, valor: string): T;
}

/**
 * Aplica el CAS al builder del UPDATE: sin `enviado` devuelve el builder
 * intacto (comportamiento actual); con él añade la ventana sobre `columna`.
 * Si el UPDATE devuelve 0 filas, el caller relee y lanza `conflictoVersion`
 * (o 404 si la fila ya no existe).
 */
export function aplicarCas<T extends BuilderCas<T>>(
  q: T,
  enviado: string | undefined | null,
  columna = 'updated_at',
): T {
  if (!enviado) return q;
  const v = ventanaCas(enviado);
  return q.gte(columna, v.desde).lte(columna, v.hasta);
}

export interface ConflictoVersionInput {
  entidad: EntidadVersionada;
  /** Fila viva con sus columnas públicas (null si no se pudo releer). */
  actual: Record<string, unknown> | null;
  /** `if_updated_at` tal como llegó. */
  enviado: string;
  columna?: string;
}

/** Texto del 409 (es-MX, para el usuario). */
export function mensajeConflictoVersion(entidad: EntidadVersionada): string {
  return `Alguien modificó este ${entidad} después de tu captura; se conserva la versión del servidor.`;
}

/** 409 ESTRUCTURADO `CONFLICTO_VERSION` (el filtro lo expone como `code`). */
export function conflictoVersion(p: ConflictoVersionInput): ConflictException {
  const columna = p.columna ?? 'updated_at';
  return new ConflictException({
    message: mensajeConflictoVersion(p.entidad),
    error: CODE_CONFLICTO_VERSION,
    details: {
      actual: p.actual,
      updated_at_enviado: p.enviado,
      updated_at_actual:
        (p.actual?.[columna] as string | null | undefined) ?? null,
    },
  });
}

export type ResultadoAssertVersion = 'sin_llave' | 'verificado' | 'omitido';

/**
 * Pre-check de versión contra la fila YA LEÍDA (flujos multi-paso: se valida
 * una vez antes del primer write y no se vuelve a validar por paso).
 * - sin `enviado` → 'sin_llave' (nada que comparar).
 * - la fila no trae la columna (tabla sin trigger / migración pendiente) →
 *   'omitido': el caller decide si avisa (comportamiento actual, no rompe).
 * - distinta → lanza `conflictoVersion` con `actual` = la fila leída.
 */
export function assertVersion(p: {
  entidad: EntidadVersionada;
  enviado: string | undefined | null;
  actual: Record<string, unknown>;
  columna?: string;
}): ResultadoAssertVersion {
  if (!p.enviado) return 'sin_llave';
  const columna = p.columna ?? 'updated_at';
  const vivo = p.actual[columna];
  if (vivo === undefined || vivo === null) return 'omitido';
  if (!mismaVersion(p.enviado, vivo)) {
    throw conflictoVersion({
      entidad: p.entidad,
      actual: p.actual,
      enviado: p.enviado,
      columna,
    });
  }
  return 'verificado';
}
