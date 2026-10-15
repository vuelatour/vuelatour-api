/**
 * SONDA ÚNICA de la migración `20261014000002_conciliacion_omitir_y_cargos_a_gasto.sql`
 * (14-oct-2026, API 0.0.77, invariantes 75 y 76): «Omitir la conciliación»
 * y «Varios cargos → un gasto». La migración crea, en UNA transacción, las
 * RPC `conciliacion_omitir_movimientos`, `conciliacion_quitar_omision` y
 * `conciliacion_ligar_cargos_a_gasto` (+ la canónica y el trigger): basta
 * sondear UNA. No hay columna nueva que sondear, así que se llama la RPC
 * con la lista VACÍA y una línea vacía:
 *
 * - 23514 (`LOTE_INVALIDO`, la primera validación de la RPC, antes de leer
 *   o escribir nada) ⇒ la migración está: «sí» memorizado PARA SIEMPRE;
 * - función ausente (`PGRST202` fuera del schema cache, o «function …
 *   does not exist» que NOMBRA una de sus RPC: `esOmisionCargosAusente`) ⇒
 *   «no», memorizado ≤ 10 min (se enciende sola al aplicarla, sin
 *   redeploy); un solo `warn`;
 * - cualquier otro error o excepción (red, permisos, timeout) ⇒ «sí» SIN
 *   memorizar: no se oculta un problema real (la llamada de negocio lo
 *   reporta tal cual) y el siguiente llamado vuelve a sondear.
 *
 * Mismas reglas que `columnaOpcional` / `TriggerUpdatedAt`. Tras un ROLLBACK
 * de la migración hay que REINICIAR el API (el «sí» se memoriza).
 *
 * Sin la migración: lo NUEVO de Conciliación responde 503 con código
 * estable (`CONCILIACION_OMITIR_NO_DISPONIBLE` para omitir / deshacer,
 * `CONCILIACION_CARGOS_A_GASTO_NO_DISPONIBLE` para varios cargos → un gasto
 * y para el alta por la suma) y TODO lo demás responde como el 0.0.76.
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { esFuncionInexistente } from './updated-at-trigger.util';

/** Migración que crea las RPC de omitir y de varios cargos → un gasto. */
export const MIGRACION_OMISION_CARGOS = '20261014000002';

/** RPC que se sondea (lista vacía ⇒ 23514 LOTE_INVALIDO sin tocar nada). */
export const RPC_SONDA_OMISION_CARGOS = 'conciliacion_omitir_movimientos';

/** RPC de la migración (un «no existe» que las nombre = migración ausente). */
export const RPCS_OMISION_CARGOS = [
  'conciliacion_omitir_movimientos',
  'conciliacion_quitar_omision',
  'conciliacion_ligar_cargos_a_gasto',
  'conciliacion_clasificacion_omitido',
] as const;

/** Ventana mínima entre sondeos cuando la migración NO está. */
export const OMISION_CARGOS_REINTENTO_MS = 10 * 60_000;

/** Texto del 503 (es-MX, para el operador; el detalle técnico va al log). */
export const MENSAJE_OPCION_NO_ACTIVA =
  'Esta opción todavía no está activa: avisa a sistemas.';

export interface ErrorSondaLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
}

export interface SondaOmisionCargosOpciones {
  reintentoMs?: number;
  /** Reloj inyectable (specs). */
  ahora?: () => number;
}

export class SondaOmisionCargos {
  private readonly logger = new Logger(SondaOmisionCargos.name);
  private readonly reintentoMs: number;
  private readonly ahora: () => number;
  /** null = sin sondear; true = está (definitivo); false = no está. */
  private estado: boolean | null = null;
  private ultimoSondeoMs = 0;
  private sondeoEnCurso: Promise<boolean> | null = null;
  private avisado = false;

  constructor(
    private readonly supabase: SupabaseClient,
    opts: SondaOmisionCargosOpciones = {},
  ) {
    this.reintentoMs = opts.reintentoMs ?? OMISION_CARGOS_REINTENTO_MS;
    this.ahora = opts.ahora ?? (() => Date.now());
  }

  /** `true` si la migración está (o no se pudo saber); `false` si NO está. */
  async disponible(): Promise<boolean> {
    if (this.estado === true) return true;
    if (
      this.estado === false &&
      this.ahora() - this.ultimoSondeoMs < this.reintentoMs
    ) {
      return false;
    }
    // Llamadas concurrentes comparten UN sondeo.
    if (!this.sondeoEnCurso) {
      this.sondeoEnCurso = this.sondear().finally(() => {
        this.sondeoEnCurso = null;
      });
    }
    return this.sondeoEnCurso;
  }

  /** Olvida lo memorizado (specs). */
  reset(): void {
    this.estado = null;
    this.ultimoSondeoMs = 0;
    this.sondeoEnCurso = null;
    this.avisado = false;
  }

  private async sondear(): Promise<boolean> {
    this.ultimoSondeoMs = this.ahora();
    let error: ErrorSondaLike | null = null;
    try {
      const res = await this.supabase.rpc(RPC_SONDA_OMISION_CARGOS, {
        p_movimiento_ids: [],
        p_linea: '',
        p_actor: null,
      });
      error = res.error ?? null;
    } catch {
      // Excepción de red/cliente: no es «falta la migración».
      this.estado = null;
      return true;
    }
    // La validación de la lista es lo PRIMERO que hace la RPC: un 23514
    // (o, por si cambia el formato, el hint/prefijo LOTE_INVALIDO) prueba
    // que existe. Sin error (no debería pasar) también existe.
    if (
      !error ||
      error.code === '23514' ||
      error.hint === 'LOTE_INVALIDO' ||
      /^\s*LOTE_INVALIDO\s*:/.test(error.message ?? '')
    ) {
      if (this.estado === false) {
        this.logger.log(
          `Migración ${MIGRACION_OMISION_CARGOS} aplicada: «Omitir la conciliación» y «Varios cargos → un gasto» activados`,
        );
      }
      this.estado = true;
      return true;
    }
    // Solo «la función NO está» (PGRST202, o un «function … does not
    // exist» que nombra una de sus RPC): un 42883 «operator does not
    // exist» es un BUG de un cuerpo plpgsql, no la migración ausente.
    if (esOmisionCargosAusente(error)) {
      this.estado = false;
      if (!this.avisado) {
        this.avisado = true;
        this.logger.warn(
          `RPC ${RPC_SONDA_OMISION_CARGOS} no existe todavía: «Omitir la conciliación» y «Varios cargos → un gasto» responden 503 hasta aplicar la migración ${MIGRACION_OMISION_CARGOS} (lo demás de Conciliación sigue como hoy)`,
        );
      }
      return false;
    }
    // Otro error (permisos, red, timeout…): no ocultarlo, no memorizar.
    this.estado = null;
    return true;
  }
}

// ===== Registro por cliente: una instancia (y un sondeo) por cliente =====

const registro = new WeakMap<SupabaseClient, SondaOmisionCargos>();

/** Instancia compartida para este cliente Supabase (specs: `.reset()`). */
export function sondaOmisionCargos(
  supabase: SupabaseClient,
  opts?: SondaOmisionCargosOpciones,
): SondaOmisionCargos {
  let inst = registro.get(supabase);
  if (!inst) {
    inst = new SondaOmisionCargos(supabase, opts);
    registro.set(supabase, inst);
  }
  return inst;
}

/** ¿Está aplicada la migración 20261014000002? (memorizado; re-sondeo ≤ 10 min). */
export function omisionCargosDisponible(
  supabase: SupabaseClient,
): Promise<boolean> {
  return sondaOmisionCargos(supabase).disponible();
}

/** 503 de «Omitir la conciliación» / «Deshacer la omisión». */
export function errorOmitirNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_OPCION_NO_ACTIVA,
    error: 'CONCILIACION_OMITIR_NO_DISPONIBLE',
    details: { migracion: MIGRACION_OMISION_CARGOS },
  });
}

/** 503 de «Varios cargos → un gasto» (y del alta por la suma). */
export function errorCargosAGastoNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_OPCION_NO_ACTIVA,
    error: 'CONCILIACION_CARGOS_A_GASTO_NO_DISPONIBLE',
    details: { migracion: MIGRACION_OMISION_CARGOS },
  });
}

/**
 * ¿El error de una RPC de la migración dice que NO está (todavía)?
 * `PGRST202` (fuera del schema cache) o un «function … does not exist» que
 * NOMBRA una de sus RPC. Un 42883 «operator does not exist» (el incidente
 * del 15-sep-2026) es un BUG de un cuerpo plpgsql y NO cuenta.
 */
export function esOmisionCargosAusente(
  err: ErrorSondaLike | null | undefined,
): boolean {
  if (!err) return false;
  if (err.code === 'PGRST202') return true;
  const msg = (err.message ?? '').toLowerCase();
  if (msg.includes('operator does not exist')) return false;
  if (!esFuncionInexistente(err)) return false;
  return RPCS_OMISION_CARGOS.some((r) => msg.includes(r));
}
