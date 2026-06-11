import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import type { EnvVars } from '../../config/env.schema';

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Genera el PDF de cotización delegando el render a pyservices (WeasyPrint). */
@Injectable()
export class QuotesPdfService {
  private readonly logger = new Logger(QuotesPdfService.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
  ) {}

  async render(quote: Record<string, unknown>): Promise<Buffer> {
    const baseUrl = this.config.get('PYSERVICES_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException('Generación de PDF no configurada (pyservices).');
    }

    // Nombre del cliente (la fila de vuelo solo trae cliente_id).
    let cliente = 'Cliente';
    if (quote.cliente_id) {
      const { data } = await this.supabase.service
        .from('cliente')
        .select('nombre, razon_social_default')
        .eq('id', quote.cliente_id as string)
        .maybeSingle();
      if (data) {
        cliente = ((data.razon_social_default as string) || (data.nombre as string)) ?? cliente;
      }
    }

    const ivaRaw = num(quote.iva_pct) ?? 0;
    const escalas = (quote.escalas as Array<Record<string, unknown>> | undefined) ?? [];

    const payload = {
      folio: String(quote.folio ?? ''),
      fecha: (quote.fecha_confirmacion as string) ?? (quote.fecha_solicitud as string) ?? null,
      cliente,
      origen: (quote.origen_iata as string) ?? '—',
      destino: (quote.destino_iata as string) ?? '—',
      tipo: (quote.tipo as string) ?? 'REDONDO',
      pasajeros: num(quote.pasajeros) ?? 1,
      fecha_traslado_inicial: (quote.fecha_vuelo as string) ?? null,
      fecha_traslado_final: (quote.fecha_traslado_final as string) ?? null,
      escalas: escalas.map((e) => ({
        orden: num(e.orden) ?? 0,
        origen: (e.origen_iata as string) ?? '',
        destino: (e.destino_iata as string) ?? '',
        // Detalle por tramo (la plantilla vieja ignora estas claves).
        pasajeros: e.es_ferry ? 0 : (num(e.pasajeros) ?? null),
        es_ferry: e.es_ferry === true,
        requiere_pernocta: e.requiere_pernocta === true,
        pernocta_usd: num(e.pernocta_costo_usd) ?? 0,
        tipo_parada: (e.tipo_parada as string) ?? 'NORMAL',
        servicio_notas: (e.servicio_notas as string) ?? null,
      })),
      tiempo_cobrable_hr: num(quote.tiempo_cobrable_hr),
      tarifa_hora_usd: num(quote.tarifa_hora_usd),
      subtotal_usd: num(quote.subtotal_vuelo_usd) ?? 0,
      tuas_usd: num(quote.tuas_usd) ?? 0,
      extras: ((quote.extras as Array<Record<string, unknown>> | undefined) ?? []).map(
        (e) => ({
          concepto: (e.concepto as string) ?? '',
          monto_usd: num(e.monto_usd) ?? 0,
          aplica_iva: e.aplica_iva !== false,
        }),
      ),
      extras_total_usd:
        num(
          (
            (quote.calculo_snapshot as Record<string, unknown> | undefined)
              ?.totales as Record<string, unknown> | undefined
          )?.extras_total_usd,
        ) ?? 0,
      viaticos_pernocta_usd:
        num(
          (
            (quote.calculo_snapshot as Record<string, unknown> | undefined)
              ?.totales as Record<string, unknown> | undefined
          )?.viaticos_pernocta_usd,
        ) ?? 0,
      // Recibo del CLIENTE: el descuento SÍ se muestra como línea; el redondeo
      // hacia arriba NUNCA (es cocina interna: queda absorbido en el total
      // cerrado). El desglose con ambos vive solo en el admin (balance).
      descuento_usd: (() => {
        const ajuste = num(quote.ajuste_final_usd) ?? 0;
        return ajuste < 0 ? Math.abs(ajuste) : 0;
      })(),
      iva_pct: ivaRaw <= 1 ? ivaRaw * 100 : ivaRaw, // normaliza 0.16 → 16
      iva_usd: num(quote.iva_usd) ?? 0,
      total_usd: num(quote.monto_total_usd) ?? 0,
      moneda: 'USD',
      notas: (quote.notas as string) ?? null,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${baseUrl}/reportes/cotizacion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ServiceUnavailableException(`pyservices respondió ${res.status} al generar el PDF`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`render PDF falló: ${msg}`);
      throw new ServiceUnavailableException(`No se pudo generar el PDF: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
