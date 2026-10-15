/**
 * SONDA ÚNICA de la migración `20261014000003_conciliacion_cobros_varios_abonos.sql`
 * (14-oct-2026, API 0.0.78, invariante 77): un cobro acepta VARIOS abonos
 * (la puente pasa a M:N, «Conciliado» = CUBIERTO, candados A/D/E/K y la RPC
 * G por faltante). No crea columnas: la señal más barata y exacta de «falta
 * la migración» es que su función pura no exista, así que se llama
 * `regla_cobro_cubierto(1, 1, false, 1)` (debe responder `true`):
 *
 * - `data === true` ⇒ la migración está: «sí» memorizado PARA SIEMPRE;
 * - función ausente (`esCobrosParcialesAusente`: `PGRST202` fuera del
 *   schema cache, o un 42883 «function … does not exist» que NOMBRA
 *   `regla_cobro_cubierto`) ⇒ «no», memorizado ≤ 10 min (se enciende sola
 *   al aplicarla, sin redeploy) y UN solo `warn`;
 * - cualquier otro error, una excepción o `data` ≠ true ⇒ «sí» SIN
 *   memorizar (patrón `TriggerUpdatedAt`: con la BD vieja la RPC G y el
 *   índice único siguen rechazando el segundo abono, nada se corrompe) y un
 *   solo `warn` por instancia.
 *
 * Modo ESTRICTO (`cobrosParcialesConfirmados`, revisión del 15-oct-2026):
 * «sí» SOLO con el `true` de la función ya memorizado o recién leído;
 * cualquier respuesta dudosa ⇒ «no». Lo usa lo que solo AFIRMA algo en
 * pantalla (`varios_abonos_por_cobro` de la hoja de Ingresos, invariante
 * 78): un best-effort jamás afirma lo que no pudo leer. Las escrituras
 * siguen con `cobrosParcialesDisponibles` (la BD es el candado).
 *
 * REGLA DURA: el SEGUNDO abono de un cobro, los candidatos parciales, el
 * auto-cruce por faltante y los faltantes de los frenos de Ingresos van
 * detrás de `cobrosParcialesDisponibles(sb)`. Las LECTURAS de estado
 * (parcial, faltante, «cobrado de más», «Cobros sin banco») NO: salen de la
 * puente de 20261012000002 con el espejo TS `common/cobro-banco.util.ts`.
 * Tras un ROLLBACK de la migración hay que REINICIAR el API (el «sí» se
 * memoriza).
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  esFuncionInexistente,
  TRIGGER_UPDATED_AT_REINTENTO_MS,
} from './updated-at-trigger.util';

/** Migración que habilita varios abonos por cobro. */
export const MIGRACION_COBROS_PARCIALES = '20261014000003';

/** Función pura que se sondea (`(1, 1, false, 1)` ⇒ true). */
export const RPC_SONDA_COBROS_PARCIALES = 'regla_cobro_cubierto';

/** Objetos de la migración que el API podría nombrar (el API NO lee la vista). */
export const OBJETOS_COBROS_PARCIALES = [
  'regla_cobro_cubierto',
  'neto_de_cobro',
  'v_cobro_conciliacion',
] as const;

/** Texto del 503 (es-MX, para el operador). */
export const MENSAJE_COBROS_PARCIALES_NO_DISPONIBLE =
  'Vincular un segundo abono al mismo cobro todavía no está habilitado en la base de datos (falta aplicar una actualización). Mientras, el cobro se queda como «Conciliado parcial»; si sigue igual en unos minutos, avisa a soporte.';

export interface ErrorSondaCobrosParciales {
  code?: string | null;
  message?: string | null;
}

/**
 * ¿El error dice que la migración NO está (todavía)? `PGRST202` (función
 * fuera del schema cache: la ÚNICA función que se sondea es
 * `regla_cobro_cubierto`), o un 42883 / «function … does not exist» SOLO si
 * el mensaje nombra `regla_cobro_cubierto`. Un «operator does not exist»
 * (42883 de un cuerpo plpgsql con un ENUM comparado sin `::text`, incidente
 * del 15-sep-2026) NUNCA es «falta la migración».
 */
export function esCobrosParcialesAusente(
  err: ErrorSondaCobrosParciales | null | undefined,
): boolean {
  if (!err) return false;
  if (err.code === 'PGRST202') return true;
  const msg = (err.message ?? '').toLowerCase();
  if (msg.includes('operator does not exist')) return false;
  if (!esFuncionInexistente(err)) return false;
  return msg.includes(RPC_SONDA_COBROS_PARCIALES);
}

export interface SondaCobrosParcialesOpciones {
  reintentoMs?: number;
  /** Reloj inyectable (specs). */
  ahora?: () => number;
}

export class SondaCobrosParciales {
  private readonly logger = new Logger(SondaCobrosParciales.name);
  private readonly reintentoMs: number;
  private readonly ahora: () => number;
  /** null = sin sondear; true = está (definitivo); false = no está. */
  private estado: boolean | null = null;
  private ultimoSondeoMs = 0;
  private sondeoEnCurso: Promise<boolean> | null = null;
  private avisadoAusente = false;
  private avisadoRaro = false;

  constructor(
    private readonly supabase: SupabaseClient,
    opts: SondaCobrosParcialesOpciones = {},
  ) {
    this.reintentoMs = opts.reintentoMs ?? TRIGGER_UPDATED_AT_REINTENTO_MS;
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

  /**
   * Modo ESTRICTO: `true` SOLO si la migración está CONFIRMADA (el `true`
   * de la función, memorizado o recién leído); «no», un error raro, una
   * excepción o un `data` ≠ true ⇒ `false`. Comparte el sondeo y la memoria
   * de `disponible()` (no sondea de más).
   */
  async confirmada(): Promise<boolean> {
    if (this.estado !== true) await this.disponible();
    return this.estado === true;
  }

  /** Olvida lo memorizado (specs). */
  reset(): void {
    this.estado = null;
    this.ultimoSondeoMs = 0;
    this.sondeoEnCurso = null;
    this.avisadoAusente = false;
    this.avisadoRaro = false;
  }

  /** «Sí» SIN memorizar (no se oculta un problema real) con un solo warn. */
  private raro(detalle: string): boolean {
    this.estado = null;
    if (!this.avisadoRaro) {
      this.avisadoRaro = true;
      this.logger.warn(
        `Sonda de ${MIGRACION_COBROS_PARCIALES} (${RPC_SONDA_COBROS_PARCIALES}) sin respuesta clara (${detalle}): se asume aplicada y se vuelve a sondear en la siguiente llamada`,
      );
    }
    return true;
  }

  private async sondear(): Promise<boolean> {
    this.ultimoSondeoMs = this.ahora();
    let data: unknown = null;
    let error: ErrorSondaCobrosParciales | null = null;
    try {
      const res = await this.supabase.rpc(RPC_SONDA_COBROS_PARCIALES, {
        p_neto: 1,
        p_n_partes: 1,
        p_cruzado: false,
        p_suma: 1,
      });
      data = res.data;
      error = res.error ?? null;
    } catch (e) {
      // Excepción de red/cliente: no es «falta la migración».
      return this.raro(e instanceof Error ? e.message : String(e));
    }
    if (!error) {
      if (data === true) {
        if (this.estado === false) {
          this.logger.log(
            `Migración ${MIGRACION_COBROS_PARCIALES} aplicada: un cobro ya acepta varios abonos`,
          );
        }
        this.estado = true;
        return true;
      }
      return this.raro(`respondió ${JSON.stringify(data)}`);
    }
    if (esCobrosParcialesAusente(error)) {
      this.estado = false;
      if (!this.avisadoAusente) {
        this.avisadoAusente = true;
        this.logger.warn(
          `Función ${RPC_SONDA_COBROS_PARCIALES} no existe todavía: el segundo abono de un cobro responde 503 CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE hasta aplicar la migración ${MIGRACION_COBROS_PARCIALES} (las lecturas del estado PARCIAL siguen funcionando desde la puente)`,
        );
      }
      return false;
    }
    // Otro error (permisos, red, timeout…): no ocultarlo, no memorizar.
    return this.raro(`${error.code ?? 'sin código'}: ${error.message ?? ''}`);
  }
}

// ===== Registro por cliente: una instancia (y un sondeo) por cliente =====

let registro = new WeakMap<SupabaseClient, SondaCobrosParciales>();

/** Instancia compartida para este cliente Supabase (las `opts` solo cuentan al crearla). */
export function sondaCobrosParciales(
  supabase: SupabaseClient,
  opts?: SondaCobrosParcialesOpciones,
): SondaCobrosParciales {
  let inst = registro.get(supabase);
  if (!inst) {
    inst = new SondaCobrosParciales(supabase, opts);
    registro.set(supabase, inst);
  }
  return inst;
}

/** ¿Está aplicada la migración 20261014000003? (memorizado; re-sondeo ≤ 10 min). */
export function cobrosParcialesDisponibles(
  supabase: SupabaseClient,
  opts?: SondaCobrosParcialesOpciones,
): Promise<boolean> {
  return sondaCobrosParciales(supabase, opts).disponible();
}

/**
 * ¿La migración 20261014000003 está CONFIRMADA? (modo estricto: una
 * respuesta dudosa ⇒ false). Para lo que solo AFIRMA en pantalla; las
 * escrituras van con `cobrosParcialesDisponibles`.
 */
export function cobrosParcialesConfirmados(
  supabase: SupabaseClient,
  opts?: SondaCobrosParcialesOpciones,
): Promise<boolean> {
  return sondaCobrosParciales(supabase, opts).confirmada();
}

/** 503 estructurado `CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE`. */
export function errorCobrosParcialesNoDisponibles(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: MENSAJE_COBROS_PARCIALES_NO_DISPONIBLE,
    error: 'CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE',
    details: { migracion: MIGRACION_COBROS_PARCIALES },
  });
}

/** Olvida TODAS las instancias (solo specs). */
export function reiniciarSondaCobrosParciales(): void {
  registro = new WeakMap<SupabaseClient, SondaCobrosParciales>();
}
