/**
 * Columna OPCIONAL: tolerar que una migración todavía no esté aplicada en
 * producción sin romper el contrato (9-sep-2026, alta sin internet).
 *
 * Caso concreto: `piloto_descanso.client_request_id` y
 * `evento_flota.client_request_id` las crea la migración
 * `20260909000003_offline_client_request_id.sql`. Si el API se despliega
 * ANTES de aplicarla, todo select/insert que nombre la columna respondería
 * 42703 (undefined_column) → 500 para TODOS (panel incluido). Con este
 * helper el código sondea UNA vez si la columna existe y, mientras no
 * exista, la omite (lectores devuelven `client_request_id: null`, altas sin
 * idempotencia). Vuelve a sondear como máximo cada 10 min para activarse
 * solo cuando la migración entre, sin reiniciar el API.
 *
 * Reglas:
 * - 42703 (o mensaje con «column» y «does not exist») → `false`, memorizado
 *   hasta el siguiente re-sondeo (≤ 10 min). Un solo `warn` por instancia.
 * - Éxito → `true` memorizado para siempre (una columna no desaparece).
 * - CUALQUIER otro error o excepción → `true` SIN memorizar: no se oculta
 *   un problema real (la consulta de negocio lo reportará tal cual) y el
 *   siguiente llamado vuelve a sondear.
 */
import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Ventana mínima entre sondeos cuando la columna NO existe. */
export const COLUMNA_OPCIONAL_REINTENTO_MS = 10 * 60_000;

/** Migración que crea `client_request_id` en piloto_descanso/evento_flota. */
export const MIGRACION_OFFLINE_CLIENT_REQUEST = '20260909000003';

export interface ErrorColumnaLike {
  code?: string | null;
  message?: string | null;
}

/** ¿El error de PostgREST/Postgres es «la columna no existe»? */
export function esColumnaInexistente(
  err: ErrorColumnaLike | null | undefined,
): boolean {
  if (!err) return false;
  if (err.code === '42703') return true;
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('column') && msg.includes('does not exist');
}

export interface ColumnaOpcionalOpciones {
  /** Ventana entre sondeos cuando la columna no existe (default 10 min). */
  reintentoMs?: number;
  /** Reloj inyectable (specs). Default `Date.now`. */
  ahora?: () => number;
  /** Texto del `warn` (una sola vez) cuando la columna no existe. */
  mensajeAusente?: string;
}

export class ColumnaOpcional {
  private readonly logger = new Logger(ColumnaOpcional.name);
  private readonly reintentoMs: number;
  private readonly ahora: () => number;
  private readonly mensajeAusente: string;
  /** null = sin sondear; true = existe (definitivo); false = no existe. */
  private estado: boolean | null = null;
  private ultimoSondeoMs = 0;
  private sondeoEnCurso: Promise<boolean> | null = null;
  private avisado = false;

  constructor(
    private readonly supabase: SupabaseClient,
    readonly tabla: string,
    readonly columna: string,
    opts: ColumnaOpcionalOpciones = {},
  ) {
    this.reintentoMs = opts.reintentoMs ?? COLUMNA_OPCIONAL_REINTENTO_MS;
    this.ahora = opts.ahora ?? (() => Date.now());
    this.mensajeAusente =
      opts.mensajeAusente ??
      `Columna ${tabla}.${columna} no existe todavía: se omite hasta aplicar la migración pendiente`;
  }

  /** `true` si la columna existe (o no se pudo saber); `false` si NO existe. */
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
    let error: ErrorColumnaLike | null = null;
    try {
      const res = await this.supabase
        .from(this.tabla)
        .select(this.columna)
        .limit(1);
      error = res.error ?? null;
    } catch (e) {
      // Excepción de red/cliente: no es «la columna no existe».
      error = {
        code: null,
        message: e instanceof Error ? e.message : String(e),
      };
      this.estado = null;
      return true;
    }
    if (!error) {
      if (this.estado === false) {
        this.logger.log(
          `Columna ${this.tabla}.${this.columna} ya existe: funcionalidad activada`,
        );
      }
      this.estado = true;
      return true;
    }
    if (esColumnaInexistente(error)) {
      this.estado = false;
      if (!this.avisado) {
        this.avisado = true;
        this.logger.warn(this.mensajeAusente);
      }
      return false;
    }
    // Otro error (permisos, red, timeout…): no ocultarlo, no memorizar.
    this.estado = null;
    return true;
  }
}

// ===== Registro por cliente: una instancia (y un sondeo) por tabla.columna =====

const registro = new WeakMap<SupabaseClient, Map<string, ColumnaOpcional>>();

/**
 * Instancia compartida por `tabla.columna` para el mismo cliente Supabase,
 * para que varios servicios (pilots, calendar, alerts) no sondeen cada uno.
 * Las `opts` solo se usan al crearla la primera vez.
 */
export function columnaOpcional(
  supabase: SupabaseClient,
  tabla: string,
  columna: string,
  opts?: ColumnaOpcionalOpciones,
): ColumnaOpcional {
  let porTabla = registro.get(supabase);
  if (!porTabla) {
    porTabla = new Map();
    registro.set(supabase, porTabla);
  }
  const llave = `${tabla}.${columna}`;
  let inst = porTabla.get(llave);
  if (!inst) {
    inst = new ColumnaOpcional(supabase, tabla, columna, opts);
    porTabla.set(llave, inst);
  }
  return inst;
}

/** Olvida todas las instancias registradas de ese cliente (specs). */
export function resetColumnasOpcionales(supabase: SupabaseClient): void {
  registro.delete(supabase);
}

// ===== Instancias conocidas (migración 20260909000003) =====

/** `piloto_descanso.client_request_id` (idempotencia de descansos). */
export function clientRequestIdDescanso(
  supabase: SupabaseClient,
): ColumnaOpcional {
  return columnaOpcional(supabase, 'piloto_descanso', 'client_request_id', {
    mensajeAusente: `Columna piloto_descanso.client_request_id no existe todavía: descansos sin idempotencia hasta aplicar la migración ${MIGRACION_OFFLINE_CLIENT_REQUEST}`,
  });
}

/** `evento_flota.client_request_id` (idempotencia de eventos NO-vuelo). */
export function clientRequestIdEvento(
  supabase: SupabaseClient,
): ColumnaOpcional {
  return columnaOpcional(supabase, 'evento_flota', 'client_request_id', {
    mensajeAusente: `Columna evento_flota.client_request_id no existe todavía: eventos sin idempotencia hasta aplicar la migración ${MIGRACION_OFFLINE_CLIENT_REQUEST}`,
  });
}
