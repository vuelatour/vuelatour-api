import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Proveedores del TC oficial de referencia USD→MXN (decisión del cliente,
 * 28-ago-2026: open.er-api.com en lugar de Banxico — sin token ni registro).
 *
 *  - DIARIO (`OPEN_ER_API`): https://open.er-api.com/v6/latest/USD — una
 *    publicación al día (~00:00 UTC), SOLO el valor vigente, sin histórico.
 *    El cron lo guarda cada mañana y a partir de ahí cada día del calendario
 *    queda en `tipo_cambio_oficial` (también fines de semana).
 *  - HISTÓRICO (`ECB_FRANKFURTER`): para fechas ANTERIORES a que existiera
 *    el registro diario (cotizaciones de jul/ago-2026 sin TC) open.er-api no
 *    puede decir cuánto valía el dólar ese día; se toma la referencia del
 *    Banco Central Europeo vía api.frankfurter.dev (libre, sin llave, día
 *    hábil anterior en fines de semana). La fuente viaja en la fila para que
 *    la celda del Excel diga de dónde salió.
 *  - `BANXICO_FIX`: filas históricas de la implementación anterior (se
 *    conservan tal cual si existen).
 *
 * Contrato: `oficialPara(fecha)` NUNCA lanza — sin red o sin dato devuelve
 * null y el reporte deja el TC vacío (jamás inventa un número).
 */
export const FUENTE_DIARIA = 'OPEN_ER_API';
export const FUENTE_HISTORICA = 'ECB_FRANKFURTER';

const OPEN_ER_API_URL = 'https://open.er-api.com/v6/latest/USD';
const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1';
const TIMEOUT_MS = 6000;

/** Etiqueta legible de la fuente del TC oficial (celdas/notas de reportes). */
export function fuenteTcLegible(fuente: string | null | undefined): string {
  switch (fuente) {
    case FUENTE_DIARIA:
      return 'open.er-api';
    case FUENTE_HISTORICA:
      return 'BCE (frankfurter)';
    case 'BANXICO_FIX':
      return 'Banxico FIX (histórico)';
    default:
      return fuente ?? 'TC oficial';
  }
}

export interface TipoCambioDetalle {
  /** TC USD→MXN vigente para la fecha pedida. */
  tc: number;
  /** Día al que corresponde el dato (≤ fecha pedida: fin de semana → último publicado). */
  fecha_dato: string;
  fuente: string;
}

function addDays(iso: string, d: number): string {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

function hoyCancun(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Cancun',
  });
}

/**
 * Fecha ISO REAL (YYYY-MM-DD con día/mes válidos). El regex solo mira la
 * forma: "2026-13-01" lo pasa y `addDays` reventaba con RangeError (500 en
 * el reporte) — verificación 28-ago. Contrato "nunca lanza": inválida → null.
 */
export function fechaIsoValida(fecha: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const t = Date.parse(`${fecha}T12:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === fecha;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class TipoCambioService {
  private readonly logger = new Logger(TipoCambioService.name);
  /** Descargas recientes por clave (evita N llamadas por reporte / reintentos en bucle). */
  private readonly pedidos = new Map<string, number>();

  constructor(private readonly supabase: SupabaseService) {}

  /** TC oficial vigente para la fecha (YYYY-MM-DD) o null si no hay dato. */
  async oficialPara(fecha: string): Promise<number | null> {
    const d = await this.oficialDetallePara(fecha);
    return d?.tc ?? null;
  }

  /**
   * Igual que `oficialPara` pero con el día real del dato y su fuente (para
   * la nota de la celda). Orden: tabla → descarga del día (open.er-api)
   * cuando la fecha es hoy o futura → histórico (ECB) para fechas pasadas
   * sin registro. Ventana de respaldo: último dato dentro de los 7 días
   * anteriores a la fecha (fines de semana / festivos).
   */
  async oficialDetallePara(fecha: string): Promise<TipoCambioDetalle | null> {
    if (!fechaIsoValida(fecha)) return null;
    const desde = addDays(fecha, -7);
    try {
      const local = await this.buscar(desde, fecha);
      const hoy = hoyCancun();
      if (local) {
        // Fecha de HOY (o futura) resuelta con un dato de un día ANTERIOR
        // (el cron de las 07:05 falló o el proceso arrancó después): se
        // intenta bajar el del día — con el throttle de 10 min de
        // `descargarHoy` — para que el dato de hoy no dependa solo del
        // cron. Si no se pudo, vale el último publicado (como antes).
        if (fecha >= hoy && local.fecha_dato < hoy) {
          const bajado = await this.descargarHoy();
          if (bajado != null) return (await this.buscar(desde, fecha)) ?? local;
        }
        return local;
      }
      if (fecha >= hoy) {
        await this.descargarHoy();
      } else {
        await this.descargarHistorico(fecha);
      }
      return await this.buscar(desde, fecha);
    } catch (err) {
      this.logger.warn(
        `TC oficial ${fecha}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async buscar(
    desde: string,
    hasta: string,
  ): Promise<TipoCambioDetalle | null> {
    const { data, error } = await this.supabase.service
      .from('tipo_cambio_oficial')
      .select('fecha, tc, fuente')
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const tc = data ? Number(data.tc) : NaN;
    if (!data || !Number.isFinite(tc) || tc <= 0) return null;
    return {
      tc,
      fecha_dato: String(data.fecha),
      fuente: String(data.fuente ?? FUENTE_DIARIA),
    };
  }

  private yaPedido(clave: string, ventanaMs: number): boolean {
    const ultimo = this.pedidos.get(clave) ?? 0;
    if (Date.now() - ultimo < ventanaMs) return true;
    this.pedidos.set(clave, Date.now());
    return false;
  }

  /**
   * Baja el valor vigente de open.er-api.com y lo guarda con la fecha de HOY
   * (Cancún). Idempotente (upsert por fecha). Devuelve el TC guardado o null.
   */
  async descargarHoy(): Promise<number | null> {
    const hoy = hoyCancun();
    if (this.yaPedido(`hoy|${hoy}`, 10 * 60 * 1000)) return null;
    try {
      const json = (await fetchJson(OPEN_ER_API_URL)) as {
        result?: string;
        rates?: Record<string, unknown>;
      };
      const tc = Number(json?.rates?.MXN);
      if (json?.result !== 'success' || !Number.isFinite(tc) || tc <= 0) {
        this.logger.warn(`open.er-api sin MXN válido (${json?.result ?? '?'})`);
        return null;
      }
      const fila = { fecha: hoy, tc: round4(tc), fuente: FUENTE_DIARIA };
      const { error } = await this.supabase.service
        .from('tipo_cambio_oficial')
        .upsert(fila, { onConflict: 'fecha' });
      if (error) throw new Error(error.message);
      return fila.tc;
    } catch (err) {
      this.logger.warn(
        `No se pudo bajar el TC del día (open.er-api): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Fecha PASADA sin registro: referencia del BCE (frankfurter) para ese día
   * (devuelve el día hábil anterior si cae en fin de semana). Solo se
   * inserta si el día no tiene ya un dato (el diario manda).
   */
  async descargarHistorico(fecha: string): Promise<number | null> {
    if (this.yaPedido(`hist|${fecha}`, 60 * 60 * 1000)) return null;
    try {
      const json = (await fetchJson(
        `${FRANKFURTER_URL}/${fecha}?base=USD&symbols=MXN`,
      )) as { date?: string; rates?: Record<string, unknown> };
      const tc = Number(json?.rates?.MXN);
      const dia = typeof json?.date === 'string' ? json.date : null;
      if (
        !dia ||
        !/^\d{4}-\d{2}-\d{2}$/.test(dia) ||
        !Number.isFinite(tc) ||
        tc <= 0
      ) {
        this.logger.warn(`frankfurter sin MXN válido para ${fecha}`);
        return null;
      }
      const fila = { fecha: dia, tc: round4(tc), fuente: FUENTE_HISTORICA };
      const { error } = await this.supabase.service
        .from('tipo_cambio_oficial')
        .upsert(fila, { onConflict: 'fecha', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
      return fila.tc;
    } catch (err) {
      this.logger.warn(
        `No se pudo bajar el TC histórico ${fecha} (frankfurter): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * open.er-api publica ~00:00 UTC (≈19:00 Cancún del día anterior): a las
   * 07:05 Cancún de TODOS los días ya está el valor del día. Así cada fecha
   * del calendario queda registrada aunque nadie abra un reporte.
   */
  @Cron('5 7 * * *', {
    name: 'tipo-cambio-oficial',
    timeZone: 'America/Cancun',
  })
  async descargarDiario(): Promise<void> {
    const tc = await this.descargarHoy();
    if (tc != null)
      this.logger.log(`TC oficial ${hoyCancun()}: ${tc} (open.er-api)`);
  }

  /**
   * Respaldo a las 12:05 Cancún (verificación 28-ago): si la corrida de las
   * 07:05 falló (red / proveedor caído / deploy a esa hora) el día no se
   * queda sin dato. Mismo método, idempotente (upsert por fecha; el
   * throttle de 10 min no lo frena cinco horas después).
   */
  @Cron('5 12 * * *', {
    name: 'tipo-cambio-oficial-respaldo',
    timeZone: 'America/Cancun',
  })
  async descargarDiarioRespaldo(): Promise<void> {
    await this.descargarDiario();
  }
}
