/**
 * SONDA ÚNICA + LECTURAS de `reparto_pago` (1-oct-2026, API 0.0.49,
 * migración `20261001000001`).
 *
 * Vive APARTE de `RepartoPagoService` a propósito: la usan el servicio de
 * los pagos (que inyecta `ProfitSharingService` para la utilidad) y el
 * PRE-CIERRE (que vive dentro de `ProfitSharingService`). Con la sonda en el
 * servicio, el pre-cierre necesitaría inyectarlo y habría un ciclo de
 * dependencias. Una instancia por cliente Supabase (registro `WeakMap`, el
 * patrón de `columnaOpcional`): un solo sondeo para los dos.
 *
 * Reglas de la sonda (tabla, no columna):
 *  - Éxito ⇒ `true` memorizado para siempre (una tabla no desaparece).
 *  - 42P01 / PGRST205 (`esTablaInexistente`) ⇒ `false`, re-sondeo cada
 *    ≤ 10 min: aplicar la migración la enciende sola, sin redeploy.
 *  - Cualquier OTRO error ⇒ `true` SIN memorizar: no se oculta un problema
 *    real (la consulta de negocio lo reporta tal cual).
 * Si una lectura de negocio responde «tabla inexistente» de todos modos, la
 * sonda se apaga ahí mismo y la lectura devuelve `'sin_tabla'`.
 */
import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { COLUMNA_OPCIONAL_REINTENTO_MS } from '../../common/columna-opcional.util';
import { esTablaInexistente } from '../inventory/eliminar-movimiento.util';
import {
  COLS_REPARTO_PAGO,
  MIGRACION_REPARTO_PAGO,
  TABLA_REPARTO_PAGO,
  type RepartoPagoRow,
} from './reparto-pago.util';

/** Página de PostgREST (max-rows = 1000 corta sin avisar). */
export const PAGOS_PAGINA = 1000;
/** Tope de páginas: más que esto es un error de premisa (lectura fallida). */
export const PAGOS_MAX_PAGINAS = 10;

export interface FiltrosPagos {
  aeronave_id?: string;
  socio_id?: string;
}

export class LectorPagosSocios {
  private readonly logger = new Logger(LectorPagosSocios.name);
  /** null = sin sondear; true = existe (definitivo); false = no existe. */
  private estado: boolean | null = null;
  private ultimoSondeoMs = 0;
  private sondeoEnCurso: Promise<boolean> | null = null;
  private avisado = false;

  constructor(
    private readonly sb: SupabaseClient,
    private readonly ahora: () => number = () => Date.now(),
  ) {}

  /** ¿Existe la tabla? (memorizado; re-sondeo ≤ 10 min si no). */
  async disponible(): Promise<boolean> {
    if (this.estado === true) return true;
    if (
      this.estado === false &&
      this.ahora() - this.ultimoSondeoMs < COLUMNA_OPCIONAL_REINTENTO_MS
    ) {
      return false;
    }
    if (!this.sondeoEnCurso) {
      this.sondeoEnCurso = this.sondear().finally(() => {
        this.sondeoEnCurso = null;
      });
    }
    return this.sondeoEnCurso;
  }

  /** La consulta de negocio vio la tabla ausente: se apaga ya. */
  marcarAusente(): void {
    this.estado = false;
    this.ultimoSondeoMs = this.ahora();
    this.avisar();
  }

  private avisar(): void {
    if (this.avisado) return;
    this.avisado = true;
    this.logger.warn(
      `La tabla ${TABLA_REPARTO_PAGO} no existe todavía: los pagos a socios responden disponible:false / 503 hasta aplicar la migración ${MIGRACION_REPARTO_PAGO}.`,
    );
  }

  private async sondear(): Promise<boolean> {
    this.ultimoSondeoMs = this.ahora();
    try {
      const { error } = await this.sb
        .from(TABLA_REPARTO_PAGO)
        .select('id')
        .limit(1);
      if (!error) {
        if (this.estado === false) {
          this.logger.log(
            `La tabla ${TABLA_REPARTO_PAGO} ya existe: pagos a socios activados.`,
          );
        }
        this.estado = true;
        return true;
      }
      if (esTablaInexistente(error)) {
        this.estado = false;
        this.avisar();
        return false;
      }
      // Otro error (red, permisos…): no se oculta ni se memoriza.
      this.estado = null;
      return true;
    } catch {
      this.estado = null;
      return true;
    }
  }

  /**
   * Pagos VIVOS (`deleted_at is null`) de un mes (`periodo` = día 1),
   * PAGINADOS por id. `'sin_tabla'` si la migración no está; cualquier otro
   * error LANZA (jamás una lista recortada presentada como completa).
   */
  async pagosDelMes(
    periodo: string,
    filtros: FiltrosPagos = {},
  ): Promise<RepartoPagoRow[] | 'sin_tabla'> {
    const filas: RepartoPagoRow[] = [];
    for (let pagina = 0; ; pagina += 1) {
      if (pagina >= PAGOS_MAX_PAGINAS) {
        throw new Error(
          `más de ${PAGOS_MAX_PAGINAS * PAGOS_PAGINA} pagos a socios en el mes`,
        );
      }
      const desde = pagina * PAGOS_PAGINA;
      let q = this.sb
        .from(TABLA_REPARTO_PAGO)
        .select(COLS_REPARTO_PAGO)
        .eq('periodo', periodo)
        .is('deleted_at', null);
      if (filtros.aeronave_id) q = q.eq('aeronave_id', filtros.aeronave_id);
      if (filtros.socio_id) q = q.eq('socio_id', filtros.socio_id);
      const { data, error } = await q
        .order('id', { ascending: true })
        .range(desde, desde + PAGOS_PAGINA - 1);
      if (error) {
        if (esTablaInexistente(error)) {
          this.marcarAusente();
          return 'sin_tabla';
        }
        throw new Error(error.message);
      }
      const chunk = (data ?? []) as unknown as RepartoPagoRow[];
      filas.push(...chunk);
      if (chunk.length < PAGOS_PAGINA) break;
    }
    return filas;
  }
}

const registro = new WeakMap<SupabaseClient, LectorPagosSocios>();

/** Instancia compartida por cliente (servicio de pagos + pre-cierre). */
export function lectorPagosSocios(sb: SupabaseClient): LectorPagosSocios {
  let l = registro.get(sb);
  if (!l) {
    l = new LectorPagosSocios(sb);
    registro.set(sb, l);
  }
  return l;
}

/** Olvida la instancia de ese cliente (specs). */
export function resetLectorPagosSocios(sb: SupabaseClient): void {
  registro.delete(sb);
}
