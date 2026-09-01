import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { hoyCancun } from '../../common/fecha-cancun.util';

/**
 * Bloque `uso_ia` que pyservices agrega (ADITIVO) a cada respuesta de IA.
 * Un pyservices viejo no lo manda (undefined) y una respuesta sin llamada a
 * Claude lo manda null: en ambos casos NO se registra nada.
 */
export interface UsoIaPayload {
  /** Modelo REAL servido (resp.model del SDK), no el configurado. */
  modelo?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** Tokens escritos a caché (cache_control ephemeral): se cobran a 1.25x. */
  cache_creation_input_tokens?: number | null;
  /** Tokens leídos de caché: se cobran a 0.10x de la tarifa input. */
  cache_read_input_tokens?: number | null;
}

export interface RegistroIaOpts {
  usuarioId?: string | null;
  contexto?: Record<string, unknown>;
}

/**
 * Tarifas USD por MILLÓN de tokens, por prefijo del id de modelo (el id real
 * trae sufijos de versión). Modelo desconocido = costo 0 CONSERVANDO modelo y
 * tokens: la fila queda reparable retroactivamente cuando se agregue la tarifa.
 */
const TARIFAS: ReadonlyArray<{
  prefijo: string;
  inUsdPorMillon: number;
  outUsdPorMillon: number;
}> = [
  { prefijo: 'claude-opus-4-8', inUsdPorMillon: 5, outUsdPorMillon: 25 },
  { prefijo: 'claude-opus-4-7', inUsdPorMillon: 5, outUsdPorMillon: 25 },
  { prefijo: 'claude-opus-4-6', inUsdPorMillon: 5, outUsdPorMillon: 25 },
  { prefijo: 'claude-opus-5', inUsdPorMillon: 5, outUsdPorMillon: 25 },
  { prefijo: 'claude-sonnet-4-6', inUsdPorMillon: 3, outUsdPorMillon: 15 },
  { prefijo: 'claude-sonnet-5', inUsdPorMillon: 2, outUsdPorMillon: 10 },
  { prefijo: 'claude-haiku-4-5', inUsdPorMillon: 1, outUsdPorMillon: 5 },
];

/** Entero >= 0 defensivo (None/undefined/strings raros del wire → 0). */
function tokens(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Redondeo a 6 decimales (los costos por llamada son fracciones de centavo). */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Costo en USD de una llamada. Los tokens de caché NO vienen incluidos en
 * input_tokens: creación a 1.25x y lectura a 0.10x de la tarifa input —
 * ignorarlos subestimaría el costo (el system prompt de gasto-ticket es enorme
 * y viaja con cache_control en TODAS las llamadas).
 */
export function costoIaUsd(
  modelo: string,
  input: number,
  output: number,
  cacheCreacion: number,
  cacheLectura: number,
): number {
  const m = modelo.trim().toLowerCase();
  const tarifa = TARIFAS.find((t) => m.startsWith(t.prefijo));
  if (!tarifa) return 0;
  const usd =
    (input * tarifa.inUsdPorMillon +
      cacheCreacion * tarifa.inUsdPorMillon * 1.25 +
      cacheLectura * tarifa.inUsdPorMillon * 0.1 +
      output * tarifa.outUsdPorMillon) /
    1e6;
  return round6(usd);
}

type FilaUso = {
  categoria: string;
  modelo: string | null;
  input_tokens: number;
  output_tokens: number;
  costo_usd: number | string;
  created_at: string;
};

/**
 * Registro de consumo de IA (tabla `ia_uso`) + resumen para el panel.
 *
 * `registrar` es BEST-EFFORT y fire-and-forget: un fallo del log JAMÁS rompe
 * ni retrasa la llamada de visión que sí funcionó (usar
 * `void this.iaUso.registrar(...)` o llamarlo directo: no regresa promesa).
 */
@Injectable()
export class IaUsoService {
  private readonly logger = new Logger(IaUsoService.name);
  private static readonly PAGE = 1000;

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Inserta una fila en `ia_uso` sin bloquear el camino caliente. No inserta
   * si `uso` viene null/undefined (pyservices viejo o respuesta sin llamada a
   * Claude) o si input+output = 0. Los cache_* no tienen columna: viajan
   * dentro de `contexto` (jsonb) para no tocar la tabla.
   */
  registrar(
    categoria: string,
    uso: UsoIaPayload | null | undefined,
    opts?: RegistroIaOpts,
  ): void {
    try {
      if (!uso) return;
      const input = tokens(uso.input_tokens);
      const output = tokens(uso.output_tokens);
      if (input + output === 0) return;
      const cacheCreacion = tokens(uso.cache_creation_input_tokens);
      const cacheLectura = tokens(uso.cache_read_input_tokens);
      const modelo = (uso.modelo ?? '').trim();
      const contexto: Record<string, unknown> = { ...(opts?.contexto ?? {}) };
      if (cacheCreacion > 0)
        contexto.cache_creation_input_tokens = cacheCreacion;
      if (cacheLectura > 0) contexto.cache_read_input_tokens = cacheLectura;
      void this.supabase.service
        .from('ia_uso')
        .insert({
          categoria,
          modelo: modelo || null,
          input_tokens: input,
          output_tokens: output,
          costo_usd: costoIaUsd(
            modelo,
            input,
            output,
            cacheCreacion,
            cacheLectura,
          ),
          usuario_id: opts?.usuarioId ?? null,
          contexto: Object.keys(contexto).length > 0 ? contexto : null,
        })
        .then(
          ({ error }) => {
            if (error) {
              this.logger.warn(
                `No se pudo registrar ia_uso (${categoria}): ${error.message}`,
              );
            }
          },
          (err: unknown) => {
            this.logger.warn(
              `No se pudo registrar ia_uso (${categoria}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          },
        );
    } catch (err) {
      // Contrato: el registro jamás propaga — ni siquiera un bug propio.
      this.logger.warn(
        `registrar ia_uso (${categoria}) falló: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Resumen del consumo para el panel (defaults: mes actual en pared Cancún).
   * El saldo es ESTIMADO: los fallos 422/timeout gastan tokens que nunca
   * llegan al registro (best-effort asumido).
   */
  async resumen(desdeQ?: string, hastaQ?: string) {
    const hoy = hoyCancun();
    const desde = desdeQ ?? `${hoy.slice(0, 7)}-01`;
    const hasta = hastaQ ?? hoy;

    // Paredes Cancún (invariante 4): jamás T23:59:59 a secas.
    const filas = await this.fetchUso(
      `${desde}T00:00:00-05:00`,
      `${hasta}T23:59:59-05:00`,
    );

    const total = {
      llamadas: 0,
      input_tokens: 0,
      output_tokens: 0,
      costo_usd: 0,
    };
    const porCategoria = new Map<string, typeof total>();
    const porModelo = new Map<
      string,
      { llamadas: number; costo_usd: number }
    >();
    const porDia = new Map<string, { llamadas: number; costo_usd: number }>();
    for (const f of filas) {
      const costo = Number(f.costo_usd) || 0;
      total.llamadas += 1;
      total.input_tokens += f.input_tokens;
      total.output_tokens += f.output_tokens;
      total.costo_usd += costo;

      const cat = porCategoria.get(f.categoria) ?? {
        llamadas: 0,
        input_tokens: 0,
        output_tokens: 0,
        costo_usd: 0,
      };
      cat.llamadas += 1;
      cat.input_tokens += f.input_tokens;
      cat.output_tokens += f.output_tokens;
      cat.costo_usd += costo;
      porCategoria.set(f.categoria, cat);

      const modelo = f.modelo ?? '(sin modelo)';
      const mod = porModelo.get(modelo) ?? { llamadas: 0, costo_usd: 0 };
      mod.llamadas += 1;
      mod.costo_usd += costo;
      porModelo.set(modelo, mod);

      // Día en pared Cancún: una llamada de las 20:00 Cancún cae en el día
      // UTC siguiente — el eje del panel debe ser el día operativo.
      const dia = hoyCancun(new Date(f.created_at));
      const d = porDia.get(dia) ?? { llamadas: 0, costo_usd: 0 };
      d.llamadas += 1;
      d.costo_usd += costo;
      porDia.set(dia, d);
    }

    const checkpoint = await this.ultimoCheckpoint();
    // La suma posterior al checkpoint va SIN filtro desde/hasta: el saldo
    // corre desde el corte, no desde el rango que el panel esté mirando.
    const consumoDesdeCheckpoint = checkpoint
      ? await this.sumaDesde(checkpoint.created_at)
      : 0;

    return {
      desde,
      hasta,
      total: { ...total, costo_usd: round6(total.costo_usd) },
      por_categoria: [...porCategoria.entries()]
        .map(([categoria, v]) => ({
          categoria,
          ...v,
          costo_usd: round6(v.costo_usd),
        }))
        .sort((a, b) => b.costo_usd - a.costo_usd),
      por_modelo: [...porModelo.entries()]
        .map(([modelo, v]) => ({
          modelo,
          llamadas: v.llamadas,
          costo_usd: round6(v.costo_usd),
        }))
        .sort((a, b) => b.costo_usd - a.costo_usd),
      por_dia: [...porDia.entries()]
        .map(([dia, v]) => ({
          dia,
          llamadas: v.llamadas,
          costo_usd: round6(v.costo_usd),
        }))
        .sort((a, b) => a.dia.localeCompare(b.dia)),
      checkpoint,
      consumo_desde_checkpoint: round6(consumoDesdeCheckpoint),
      // ESTIMADO: hay huecos inevitables (422/timeout cobran tokens sin log).
      saldo_estimado: checkpoint
        ? round6(Number(checkpoint.saldo_usd) - consumoDesdeCheckpoint)
        : null,
    };
  }

  /** Inserta un checkpoint de saldo (lo teclea ADMIN desde la consola). */
  async guardarSaldo(saldoUsd: number, notas: string | null, userId: string) {
    const { data, error } = await this.supabase.service
      .from('ia_saldo_checkpoint')
      .insert({ saldo_usd: saldoUsd, notas, created_by: userId })
      .select('id, saldo_usd, notas, created_at')
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  /** Filas del periodo, paginadas de a 1000 (supabase capa en silencio). */
  private async fetchUso(
    desdeIso: string,
    hastaIso: string,
  ): Promise<FilaUso[]> {
    const filas: FilaUso[] = [];
    for (let from = 0; ; from += IaUsoService.PAGE) {
      const { data, error } = await this.supabase.service
        .from('ia_uso')
        .select(
          'categoria, modelo, input_tokens, output_tokens, costo_usd, created_at',
        )
        .gte('created_at', desdeIso)
        .lte('created_at', hastaIso)
        .order('created_at', { ascending: true })
        .range(from, from + IaUsoService.PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as FilaUso[];
      filas.push(...page);
      if (page.length < IaUsoService.PAGE) break;
    }
    return filas;
  }

  private async ultimoCheckpoint(): Promise<{
    saldo_usd: number;
    notas: string | null;
    created_at: string;
  } | null> {
    const { data, error } = await this.supabase.service
      .from('ia_saldo_checkpoint')
      .select('saldo_usd, notas, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      saldo_usd: Number(data.saldo_usd),
      notas: (data.notas as string | null) ?? null,
      created_at: data.created_at as string,
    };
  }

  /** Suma de costo_usd desde un instante (paginada, sin filtro de rango). */
  private async sumaDesde(createdAtIso: string): Promise<number> {
    let suma = 0;
    for (let from = 0; ; from += IaUsoService.PAGE) {
      const { data, error } = await this.supabase.service
        .from('ia_uso')
        .select('costo_usd')
        .gte('created_at', createdAtIso)
        .order('created_at', { ascending: true })
        .range(from, from + IaUsoService.PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as Array<{ costo_usd: number | string }>;
      for (const f of page) suma += Number(f.costo_usd) || 0;
      if (page.length < IaUsoService.PAGE) break;
    }
    return suma;
  }
}
