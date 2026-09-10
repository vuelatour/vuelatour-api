/**
 * Sonda de TRIGGER `updated_at` (10-sep-2026, Lote 2 Ola B · B1).
 *
 * El control de versión `if_updated_at` → 409 CONFLICTO_VERSION (doc
 * funcional 6.1: gana el servidor + aviso) solo tiene sentido si
 * `updated_at` SE MUEVE en cada UPDATE. `mantenimiento`, `piloto_descanso` y
 * `evento_flota` no tenían `tg_set_updated_at` hasta la migración
 * `20260910000001_updated_at_triggers.sql`, que además crea la función
 * `updated_at_trigger_activo(p_tabla)` — «la función existe» ⇔ «la migración
 * ya se aplicó». Mientras no exista, el CAS se SALTA en esas tablas
 * (comportamiento de hoy: last-writer-wins) y se avisa UNA vez en el log.
 *
 * Mismas reglas de memoria que `ColumnaOpcional`:
 * - `true` (trigger activo) → memorizado para siempre;
 * - `false` (sin trigger / función ausente) → memorizado ≤ 10 min, luego
 *   re-sondea y se activa solo, sin reiniciar el API; un solo `warn`;
 * - cualquier otro error o excepción → `true` SIN memorizar (hacer el CAS
 *   contra un `updated_at` que no se mueve es inocuo: el cliente compara con
 *   el mismo valor que leyó, así que jamás produce un 409 falso; no se
 *   oculta el problema real y el siguiente llamado vuelve a sondear).
 */
import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Ventana mínima entre sondeos cuando el trigger NO está. */
export const TRIGGER_UPDATED_AT_REINTENTO_MS = 10 * 60_000;

/** Migración que crea los triggers y la función sonda. */
export const MIGRACION_UPDATED_AT_TRIGGERS = '20260910000001';

/** Función SQL (rpc) que responde si la tabla tiene tg_set_updated_at. */
export const RPC_UPDATED_AT_TRIGGER_ACTIVO = 'updated_at_trigger_activo';

export interface ErrorRpcLike {
  code?: string | null;
  message?: string | null;
}

/** ¿El error de PostgREST/Postgres es «la función no existe»? */
export function esFuncionInexistente(
  err: ErrorRpcLike | null | undefined,
): boolean {
  if (!err) return false;
  // PGRST202 = función fuera del schema cache; 42883 = undefined_function.
  if (err.code === 'PGRST202' || err.code === '42883') return true;
  const msg = (err.message ?? '').toLowerCase();
  return (
    msg.includes('could not find the function') ||
    (msg.includes('function') && msg.includes('does not exist'))
  );
}

export interface TriggerUpdatedAtOpciones {
  reintentoMs?: number;
  /** Reloj inyectable (specs). */
  ahora?: () => number;
  /** Texto del `warn` (una sola vez) cuando el trigger no está. */
  mensajeAusente?: string;
}

export class TriggerUpdatedAt {
  private readonly logger = new Logger(TriggerUpdatedAt.name);
  private readonly reintentoMs: number;
  private readonly ahora: () => number;
  private readonly mensajeAusente: string;
  /** null = sin sondear; true = trigger activo (definitivo); false = no. */
  private estado: boolean | null = null;
  private ultimoSondeoMs = 0;
  private sondeoEnCurso: Promise<boolean> | null = null;
  private avisado = false;

  constructor(
    private readonly supabase: SupabaseClient,
    readonly tabla: string,
    opts: TriggerUpdatedAtOpciones = {},
  ) {
    this.reintentoMs = opts.reintentoMs ?? TRIGGER_UPDATED_AT_REINTENTO_MS;
    this.ahora = opts.ahora ?? (() => Date.now());
    this.mensajeAusente =
      opts.mensajeAusente ??
      `Tabla ${tabla} sin trigger de updated_at: el control de versión if_updated_at se salta (gana el último) hasta aplicar la migración ${MIGRACION_UPDATED_AT_TRIGGERS}`;
  }

  /** `true` si el trigger está (o no se pudo saber); `false` si NO está. */
  async disponible(): Promise<boolean> {
    if (this.estado === true) return true;
    if (
      this.estado === false &&
      this.ahora() - this.ultimoSondeoMs < this.reintentoMs
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

  /** Olvida lo memorizado (specs). */
  reset(): void {
    this.estado = null;
    this.ultimoSondeoMs = 0;
    this.sondeoEnCurso = null;
    this.avisado = false;
  }

  private ausente(): boolean {
    this.estado = false;
    if (!this.avisado) {
      this.avisado = true;
      this.logger.warn(this.mensajeAusente);
    }
    return false;
  }

  private async sondear(): Promise<boolean> {
    this.ultimoSondeoMs = this.ahora();
    let data: unknown = null;
    let error: ErrorRpcLike | null = null;
    try {
      const res = await this.supabase.rpc(RPC_UPDATED_AT_TRIGGER_ACTIVO, {
        p_tabla: this.tabla,
      });
      data = res.data;
      error = res.error ?? null;
    } catch {
      // Excepción de red/cliente: no es «no hay trigger».
      this.estado = null;
      return true;
    }
    if (!error) {
      if (data === true) {
        if (this.estado === false) {
          this.logger.log(
            `Tabla ${this.tabla} ya tiene trigger de updated_at: control de versión activado`,
          );
        }
        this.estado = true;
        return true;
      }
      // La función existe pero el trigger no (migración aplicada a medias).
      return this.ausente();
    }
    if (esFuncionInexistente(error)) return this.ausente();
    // Otro error (permisos, red, timeout…): no ocultarlo, no memorizar.
    this.estado = null;
    return true;
  }
}

// ===== Registro por cliente: una instancia (y un sondeo) por tabla =====

const registro = new WeakMap<SupabaseClient, Map<string, TriggerUpdatedAt>>();

/**
 * Instancia compartida por tabla para el mismo cliente Supabase (varios
 * servicios no sondean cada uno). Las `opts` solo cuentan al crearla.
 */
export function triggerUpdatedAt(
  supabase: SupabaseClient,
  tabla: string,
  opts?: TriggerUpdatedAtOpciones,
): TriggerUpdatedAt {
  let porTabla = registro.get(supabase);
  if (!porTabla) {
    porTabla = new Map();
    registro.set(supabase, porTabla);
  }
  let inst = porTabla.get(tabla);
  if (!inst) {
    inst = new TriggerUpdatedAt(supabase, tabla, opts);
    porTabla.set(tabla, inst);
  }
  return inst;
}

/** Olvida todas las instancias registradas de ese cliente (specs). */
export function resetTriggersUpdatedAt(supabase: SupabaseClient): void {
  registro.delete(supabase);
}
