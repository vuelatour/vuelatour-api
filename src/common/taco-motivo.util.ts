/**
 * `escala.revision_motivo` guarda DOS cosas separadas por "; ":
 *
 * 1. Los PENDIENTES detectados por el sistema (lo accionable) — van primero
 *    porque la app del piloto pinta el campo crudo cuando hay que revisar.
 * 2. Un bloque `Registro: …` con la BITÁCORA de procedencia: cómo entró el
 *    número (IA, con qué confianza y calidad de foto, quién lo aceptó) y quién
 *    lo confirmó. Sobrevive a la confirmación — es la explicación del dato,
 *    no una alerta.
 *
 * FUENTE ÚNICA de ese formato (el panel tiene su espejo en
 * `@/lib/taco-procedencia`): quien mande texto al piloto usa
 * `soloPendientes`, y quien reconstruya el motivo usa los otros helpers.
 */
export const PROCEDENCIA_PREFIX = 'Registro: ';

/**
 * Prefijo estable de una corrección A LA BAJA pendiente de oficina. Es
 * PEGAJOSA: applyConsistencyFlag la conserva entre recálculos (una captura
 * posterior del mismo tramo NO la apaga) y solo confirmTaco la retira al
 * reconstruir el motivo — sin esto, el amarillo de una corrección moría en
 * silencio con la siguiente captura.
 */
export const CORRECCION_BAJA_PREFIX =
  'Corrección a la baja pendiente de oficina: ';

/** Chunks de corrección a la baja aún pendientes en un revision_motivo. */
export function correccionesBajaPendientes(
  motivo: string | null | undefined,
): string[] {
  return partes(motivo).filter((c) => c.startsWith(CORRECCION_BAJA_PREFIX));
}

/**
 * Motivo para ESCRITORES DIRECTOS de revision_motivo (updates que no pasan
 * por el recálculo de consistencia): pone la alerta nueva al frente y
 * CONSERVA los chunks pegajosos (corrección a la baja pendiente) y la
 * bitácora del motivo previo — un escritor directo jamás debe borrar la
 * evidencia de una corrección sin revisar.
 */
export function motivoDirecto(
  previo: string | null | undefined,
  alerta: string,
  bitacoraExtra?: string,
): string {
  const bitacora = bitacoraExtra
    ? agregarProcedencia(leerBitacora(previo), bitacoraExtra)
    : leerBitacora(previo);
  return [
    alerta,
    ...correccionesBajaPendientes(previo).filter((c) => c !== alerta),
    bitacora ? `${PROCEDENCIA_PREFIX}${bitacora}` : null,
  ]
    .filter((p): p is string => !!p)
    .join('; ')
    .slice(0, 1800);
}

const partes = (motivo: string | null | undefined): string[] =>
  (motivo ?? '')
    .split('; ')
    .map((c) => c.trim())
    .filter(Boolean);

/** Bitácora previa (sin el prefijo). null si la fila no tiene. */
export function leerBitacora(motivo: string | null | undefined): string | null {
  const chunk = partes(motivo).find((c) => c.startsWith(PROCEDENCIA_PREFIX));
  return chunk ? chunk.slice(PROCEDENCIA_PREFIX.length) : null;
}

/**
 * Solo lo accionable (sin la bitácora): es lo que se le dice al piloto en el
 * push y en "Mis registros" — el historial completo lo ve la oficina.
 */
export function soloPendientes(
  motivo: string | null | undefined,
): string | null {
  const resto = partes(motivo).filter((c) => !c.startsWith(PROCEDENCIA_PREFIX));
  return resto.length ? resto.join('; ') : null;
}

/** Agrega una línea a la bitácora sin repetirla y sin crecer sin fin. */
export function agregarProcedencia(
  previo: string | null,
  linea: string,
): string {
  const base = (previo ?? '').trim();
  if (!base) return linea.slice(0, 1200);
  if (base.includes(linea)) return base;
  return `${base} · ${linea}`.slice(-1200);
}
