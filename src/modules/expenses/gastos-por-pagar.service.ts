import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../realtime/notifications.service';
import { porPagarDisponible } from '../../common/por-pagar-disponible.util';
import { hoyCancun } from '../../common/fecha-cancun.util';
import {
  CLAVE_ALERTA_POR_PAGAR,
  LINK_GASTOS_POR_PAGAR,
  MOTIVO_RECORDATORIO_POR_PAGAR,
  TITULO_RECORDATORIO_HOY,
  TITULO_RECORDATORIO_VENCIDO,
  claveRecordatorioPorPagar,
  cuerpoRecordatorioPorPagar,
  estadoPagoGasto,
  sumarDias,
} from './por-pagar.util';

/** Filas por página (max-rows de PostgREST). */
const PAGINA = 1000;
/** Tope de páginas por corrida (jamás una lectura sin fin). */
const MAX_PAGINAS = 20;
/** Ids por `in (…)` (la URL de PostgREST no crece sin tope). */
const LOTE_USUARIOS = 150;

/** Resumen de una corrida (log y specs). */
export interface ResumenRecordatorioPorPagar {
  activo: boolean;
  hoy: string;
  candidatos: number;
  avisados: number;
  ya_avisados: number;
  saltados: number;
  fallos: number;
}

type GastoPorPagarAviso = {
  id: string;
  categoria: string | null;
  monto: number | string | null;
  moneda: string | null;
  fecha_gasto: string;
  por_pagar: boolean | null;
  conciliado: boolean | null;
  created_by: string | null;
  vuelo: { folio?: number | null } | Array<{ folio?: number | null }> | null;
};

/**
 * RECORDATORIO de gastos «por pagar» (19-oct-2026, API 0.0.95, invariante
 * 93). Cada día a las 09:00 Cancún avisa por push a quien CAPTURÓ el gasto
 * (`created_by`) cuando su fecha es HOY («Gasto por pagar hoy») o fue AYER
 * («Gasto por pagar vencido», UNA vez). Tipo `gasto_registrado` (la app ya
 * lo pinta con su ícono) con `data.motivo = 'gasto_por_pagar'`.
 *
 * Aviso DIRECTO (`notifyUser`, sin fila en `alerta_config`) con dedupe en
 * `alerta_emitida` (`gasto_por_pagar:<gasto>:<día Cancún>`), patrón de los
 * recordatorios de eventos de `alerts`: se consulta ANTES y se marca
 * DESPUÉS de entregar (si no se entregó, la clave queda libre). Sin
 * `created_by` o con el usuario inactivo, se salta. Candado en memoria
 * (Railway = 1 réplica), nunca lanza y detrás de la sonda: sin la migración
 * no lee nada.
 */
@Injectable()
export class GastosPorPagarService {
  private readonly logger = new Logger(GastosPorPagarService.name);
  private enCurso = false;
  /** Reloj inyectable (specs). */
  ahora: () => Date = () => new Date();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 9 * * *', { timeZone: 'America/Cancun' })
  async runRecordatorios(): Promise<void> {
    await this.recordar();
  }

  /** Una corrida completa. Nunca lanza; null = otra corrida en curso. */
  async recordar(): Promise<ResumenRecordatorioPorPagar | null> {
    if (this.enCurso) return null;
    this.enCurso = true;
    const hoy = hoyCancun(this.ahora());
    const resumen: ResumenRecordatorioPorPagar = {
      activo: false,
      hoy,
      candidatos: 0,
      avisados: 0,
      ya_avisados: 0,
      saltados: 0,
      fallos: 0,
    };
    try {
      if (!(await porPagarDisponible(this.supabase.service))) return resumen;
      resumen.activo = true;
      const ayer = sumarDias(hoy, -1);
      const gastos = (await this.leerCandidatos(ayer, hoy)).filter((g) => {
        const estado = estadoPagoGasto(g, hoy);
        const dia = String(g.fecha_gasto ?? '').slice(0, 10);
        return (
          (dia === hoy && estado === 'POR_PAGAR') ||
          (dia === ayer && estado === 'VENCIDO')
        );
      });
      resumen.candidatos = gastos.length;
      if (gastos.length === 0) return resumen;
      const activos = await this.usuariosActivos(
        gastos.map((g) => g.created_by).filter((x): x is string => !!x),
      );
      for (const g of gastos) {
        if (!g.created_by || !activos.has(g.created_by)) {
          resumen.saltados += 1;
          continue;
        }
        try {
          const clave = claveRecordatorioPorPagar(g.id, hoy);
          if (await this.yaEmitida(clave)) {
            resumen.ya_avisados += 1;
            continue;
          }
          const dia = String(g.fecha_gasto).slice(0, 10);
          const vuelo = Array.isArray(g.vuelo) ? g.vuelo[0] : g.vuelo;
          const ok = await this.notifications.notifyUser(g.created_by, {
            tipo: 'gasto_registrado',
            titulo:
              dia === hoy
                ? TITULO_RECORDATORIO_HOY
                : TITULO_RECORDATORIO_VENCIDO,
            cuerpo: cuerpoRecordatorioPorPagar({
              categoria: g.categoria,
              monto: g.monto,
              moneda: g.moneda,
              folio: typeof vuelo?.folio === 'number' ? vuelo.folio : null,
            }),
            data: {
              gasto_id: g.id,
              motivo: MOTIVO_RECORDATORIO_POR_PAGAR,
              fecha_gasto: dia,
            },
            link: LINK_GASTOS_POR_PAGAR,
          });
          if (!ok) {
            // Sin entrega (o piloto externo): la clave queda libre.
            resumen.saltados += 1;
            continue;
          }
          await this.marcar(clave);
          resumen.avisados += 1;
        } catch (err) {
          // Un gasto con problema (BD) no frena a los demás.
          resumen.fallos += 1;
          this.logger.warn(
            `Recordatorio de gasto por pagar ${g.id} falló: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      this.logger.log(
        `Recordatorio de gastos por pagar (${hoy}): ${resumen.avisados} avisados, ${resumen.ya_avisados} ya avisados, ${resumen.saltados} saltados, ${resumen.fallos} fallos de ${resumen.candidatos}.`,
      );
      return resumen;
    } catch (err) {
      this.logger.warn(
        `Recordatorio de gastos por pagar falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return resumen;
    } finally {
      this.enCurso = false;
    }
  }

  /** Gastos por pagar sin conciliar con fecha AYER u HOY (paginado). */
  private async leerCandidatos(
    ayer: string,
    hoy: string,
  ): Promise<GastoPorPagarAviso[]> {
    const out: GastoPorPagarAviso[] = [];
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
      const ini = pagina * PAGINA;
      const { data, error } = await this.supabase.service
        .from('gasto')
        .select(
          'id, categoria, monto, moneda, fecha_gasto, por_pagar, conciliado, created_by, vuelo:vuelo_id(folio)',
        )
        .eq('por_pagar', true)
        .eq('conciliado', false)
        .in('fecha_gasto', [ayer, hoy])
        .order('id', { ascending: true })
        .range(ini, ini + PAGINA - 1);
      if (error) throw new Error(error.message);
      const filas = (data ?? []) as unknown as GastoPorPagarAviso[];
      out.push(...filas);
      if (filas.length < PAGINA) return out;
    }
    this.logger.warn(
      `Recordatorio de gastos por pagar: más de ${MAX_PAGINAS * PAGINA} candidatos; se avisa a los leídos.`,
    );
    return out;
  }

  /** Ids de usuarios con `estado` ACTIVO (lotes ≤ 150). */
  private async usuariosActivos(ids: string[]): Promise<Set<string>> {
    const unicos = [...new Set(ids)];
    const activos = new Set<string>();
    for (let i = 0; i < unicos.length; i += LOTE_USUARIOS) {
      const { data, error } = await this.supabase.service
        .from('usuario')
        .select('id, estado')
        .in('id', unicos.slice(i, i + LOTE_USUARIOS));
      if (error) throw new Error(error.message);
      for (const u of (data ?? []) as Array<{ id: string; estado: unknown }>) {
        // `estado` es ENUM: se compara como texto.
        if (String(u.estado) === 'ACTIVO') activos.add(u.id);
      }
    }
    return activos;
  }

  /** ¿La clave ya se emitió? (consulta sin consumirla). */
  private async yaEmitida(clave: string): Promise<boolean> {
    const { count, error } = await this.supabase.service
      .from('alerta_emitida')
      .select('dedupe_key', { count: 'exact', head: true })
      .eq('dedupe_key', clave);
    if (error) throw new Error(error.message);
    return (count ?? 0) > 0;
  }

  /** Marca la clave DESPUÉS de entregar (23505 = otra corrida: mismo resultado). */
  private async marcar(clave: string): Promise<void> {
    const { error } = await this.supabase.service
      .from('alerta_emitida')
      .insert({ dedupe_key: clave, clave: CLAVE_ALERTA_POR_PAGAR });
    if (error && error.code !== '23505') throw new Error(error.message);
  }
}
