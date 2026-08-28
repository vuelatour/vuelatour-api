import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { EnvVars } from '../../config/env.schema';
import { SupabaseService } from '../supabase/supabase.service';

/** Serie SF43718 = FIX (USD/MXN) que Banxico determina y el DOF publica. */
const SERIE_FIX = 'SF43718';

function addDays(iso: string, d: number): string {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

/**
 * Tipo de cambio OFICIAL por día (Banxico FIX, el que publica el DOF).
 * Fuente única para "no se capturó TC en la cotización": el balance lo usa
 * como respaldo marcando la celda. Fines de semana/festivos toman el último
 * publicado ANTES de la fecha (así lo hace el propio DOF).
 */
@Injectable()
export class TipoCambioService {
  private readonly logger = new Logger(TipoCambioService.name);
  /** Rangos ya pedidos a Banxico recientemente (evita N llamadas por reporte). */
  private readonly pedidos = new Map<string, number>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  /** TC oficial vigente para la fecha (YYYY-MM-DD) o null si no hay dato. */
  async oficialPara(fecha: string): Promise<number | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
    const desde = addDays(fecha, -7);
    const local = await this.buscar(desde, fecha);
    if (local != null) return local;
    await this.descargar(desde, fecha);
    return this.buscar(desde, fecha);
  }

  private async buscar(desde: string, hasta: string): Promise<number | null> {
    const { data, error } = await this.supabase.service
      .from('tipo_cambio_oficial')
      .select('fecha, tc')
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const tc = data ? Number(data.tc) : NaN;
    return Number.isFinite(tc) && tc > 0 ? tc : null;
  }

  /**
   * Baja el rango de Banxico (API SIE, header Bmx-Token) y lo guarda. Sin
   * token o con error de red NO truena: el reporte simplemente deja el TC
   * vacío como hasta hoy.
   */
  async descargar(desde: string, hasta: string): Promise<number> {
    const token = this.config.get('BANXICO_TOKEN', { infer: true });
    if (!token) return 0;
    const clave = `${desde}|${hasta}`;
    const ultimo = this.pedidos.get(clave) ?? 0;
    if (Date.now() - ultimo < 10 * 60 * 1000) return 0;
    this.pedidos.set(clave, Date.now());
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(
        `https://www.banxico.org.mx/SieAPIRest/service/v1/series/${SERIE_FIX}/datos/${desde}/${hasta}`,
        {
          headers: { 'Bmx-Token': token, Accept: 'application/json' },
          signal: ctrl.signal,
        },
      );
      clearTimeout(timer);
      if (!res.ok) {
        this.logger.warn(`Banxico respondió ${res.status} para ${clave}`);
        return 0;
      }
      const json = (await res.json()) as {
        bmx?: {
          series?: Array<{ datos?: Array<{ fecha: string; dato: string }> }>;
        };
      };
      const datos = json.bmx?.series?.[0]?.datos ?? [];
      const filas = datos
        .map((d) => {
          // Banxico manda dd/MM/yyyy y 'N/E' cuando no hay publicación.
          const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.fecha);
          const tc = Number(String(d.dato).replace(',', ''));
          if (!m || !Number.isFinite(tc) || tc <= 0) return null;
          return {
            fecha: `${m[3]}-${m[2]}-${m[1]}`,
            tc,
            fuente: 'BANXICO_FIX',
          };
        })
        .filter(
          (x): x is { fecha: string; tc: number; fuente: string } => x !== null,
        );
      if (filas.length === 0) return 0;
      const { error } = await this.supabase.service
        .from('tipo_cambio_oficial')
        .upsert(filas, { onConflict: 'fecha' });
      if (error) throw new Error(error.message);
      return filas.length;
    } catch (err) {
      this.logger.warn(
        `No se pudo bajar el TC oficial ${clave}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /** Banxico publica el FIX ~12:00 CDMX en días hábiles: se baja la semana. */
  @Cron('30 13 * * 1-5', {
    name: 'tipo-cambio-oficial',
    timeZone: 'America/Cancun',
  })
  async descargarSemana(): Promise<void> {
    const hoy = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Cancun',
    });
    const n = await this.descargar(addDays(hoy, -7), hoy);
    if (n > 0)
      this.logger.log(`TC oficial: ${n} día(s) actualizados hasta ${hoy}`);
  }
}
