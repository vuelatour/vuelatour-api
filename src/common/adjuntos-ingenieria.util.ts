/**
 * ARCHIVOS DE INGENIERÍA (17-nov-2026, API 0.0.140, invariante 135): piezas
 * COMUNES de `adjunto_ingenieria` que usan módulos que no se importan entre
 * sí (engineering, engines, propellers).
 *
 * Las llaves foráneas de `adjunto_ingenieria` van sin cascada (la migración
 * `20261117000001` no puede llevar esa cláusula), así que borrar un motor o
 * una hélice con archivos CHOCARÍA con la llave. `engines.service` y
 * `propellers.service` retiran antes esas filas con
 * `retirarAdjuntosDeComponenteMayor` y, si el borrado del componente falla,
 * las reponen con `reponerAdjuntos` — nunca se pierde un archivo por un
 * borrado que no ocurrió.
 */
import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { esTablaInexistente } from './columna-opcional.util';

export const TABLA_ADJUNTO_INGENIERIA = 'adjunto_ingenieria';
export const TABLA_COMPONENTE_AERONAVE = 'componente_aeronave';
/** Bucket PRIVADO donde viven los archivos (el mismo de permisos y seguros). */
export const BUCKET_ADJUNTOS_INGENIERIA = 'documentos-flota';
/** Migración que crea `componente_aeronave` y `adjunto_ingenieria`. */
export const MIGRACION_INGENIERIA_COMPONENTES = '20261117000001';

export type ColumnaComponenteMayor = 'motor_id' | 'helice_id';

export interface AdjuntosRetirados {
  /** Filas COMPLETAS que se quitaron (para reponerlas si hace falta). */
  filas: Array<Record<string, unknown>>;
  /** Llaves de sus archivos en el bucket. */
  paths: string[];
}

const SIN_ADJUNTOS: AdjuntosRetirados = { filas: [], paths: [] };
const logger = new Logger('AdjuntosIngenieria');

/**
 * Quita TODAS las filas de `adjunto_ingenieria` de un motor o una hélice
 * (también las ya dadas de baja: la llave foránea no distingue) y las
 * devuelve completas. Tabla inexistente (migración sin aplicar) ⇒ nada que
 * quitar. Cualquier otro error se LANZA: sin quitar las filas, el borrado
 * del componente chocaría con la llave de todos modos.
 */
export async function retirarAdjuntosDeComponenteMayor(
  sb: SupabaseClient,
  columna: ColumnaComponenteMayor,
  id: string,
): Promise<AdjuntosRetirados> {
  const { data, error } = await sb
    .from(TABLA_ADJUNTO_INGENIERIA)
    .select('*')
    .eq(columna, id);
  if (error) {
    if (esTablaInexistente(error)) return SIN_ADJUNTOS;
    throw new Error(error.message);
  }
  const filas = (data ?? []) as Array<Record<string, unknown>>;
  if (filas.length === 0) return SIN_ADJUNTOS;
  const { error: errQuitar } = await sb
    .from(TABLA_ADJUNTO_INGENIERIA)
    .delete()
    .eq(columna, id);
  if (errQuitar) {
    if (esTablaInexistente(errQuitar)) return SIN_ADJUNTOS;
    throw new Error(errQuitar.message);
  }
  return {
    filas,
    paths: filas
      .map((f) => f.storage_path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0),
  };
}

/**
 * Repone las filas retiradas cuando el borrado del componente NO ocurrió.
 * Best-effort: si falla se registra (con los ids) y no tapa el error
 * original del borrado.
 */
export async function reponerAdjuntos(
  sb: SupabaseClient,
  filas: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  if (filas.length === 0) return;
  try {
    const { error } = await sb
      .from(TABLA_ADJUNTO_INGENIERIA)
      .insert([...filas]);
    if (error) {
      logger.error(
        `No se pudieron reponer ${filas.length} archivo(s) de ingeniería (${filas
          .map((f) => String(f.id))
          .join(', ')}): ${error.message}`,
      );
    }
  } catch (err) {
    logger.error(
      `Falló la reposición de ${filas.length} archivo(s) de ingeniería: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Retira del bucket los archivos de un componente que YA se borró (nadie más
 * conoce esas llaves). Best-effort: un archivo residual no rompe nada.
 */
export async function borrarArchivosDeAdjuntos(
  sb: SupabaseClient,
  paths: readonly string[],
  contexto: string,
): Promise<void> {
  if (paths.length === 0) return;
  try {
    const { error } = await sb.storage
      .from(BUCKET_ADJUNTOS_INGENIERIA)
      .remove([...paths]);
    if (error) {
      logger.warn(
        `No se pudieron borrar ${paths.length} archivo(s) de ${contexto}: ${error.message}`,
      );
    }
  } catch (err) {
    logger.warn(
      `Falló el borrado de ${paths.length} archivo(s) de ${contexto}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
