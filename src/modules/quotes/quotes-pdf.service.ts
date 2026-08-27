import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
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
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'Generación de PDF no configurada (pyservices).',
      );
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
        cliente =
          ((data.razon_social_default as string) || (data.nombre as string)) ??
          cliente;
      }
    }

    // Aeronave cotizada (26-ago): matrícula + fotos EXTERIOR/INTERIOR desde
    // la galería aeronave_imagen (etiqueta; bucket público → fetch directo).
    // Best-effort: sin avión o sin fotos etiquetadas, el PDF sale sin sección.
    let matricula: string | null = null;
    let fotoExterior: string | null = null;
    let fotoInterior: string | null = null;
    // Ficha comercial (26-ago v2): la hoja del avión lleva modelo, tarjeta
    // "De un vistazo" y características — todo de la fila de aeronave.
    let avion: Record<string, unknown> | null = null;
    if (quote.aeronave_id) {
      const [{ data: av }, { data: imgs }] = await Promise.all([
        this.supabase.service
          .from('aeronave')
          .select(
            'matricula, modelo, velocidad_crucero_kts, asientos, num_motores, motor_hp, caracteristicas',
          )
          .eq('id', quote.aeronave_id as string)
          .maybeSingle(),
        this.supabase.service
          .from('aeronave_imagen')
          .select('url, etiqueta, content_type')
          .eq('aeronave_id', quote.aeronave_id as string)
          .in('etiqueta', ['EXTERIOR', 'INTERIOR']),
      ]);
      matricula = (av?.matricula as string) ?? null;
      avion = av ?? null;
      const descargar = async (
        url: string | null | undefined,
        mime: string | null | undefined,
      ): Promise<string | null> => {
        if (!url) return null;
        try {
          const res = await fetch(url);
          if (!res.ok) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          // 8 MB por foto: el payload viaja en JSON a pyservices.
          if (buf.byteLength > 8 * 1024 * 1024) return null;
          return `data:${mime || 'image/jpeg'};base64,${buf.toString('base64')}`;
        } catch {
          return null;
        }
      };
      const ext = (imgs ?? []).find((i) => i.etiqueta === 'EXTERIOR');
      const int_ = (imgs ?? []).find((i) => i.etiqueta === 'INTERIOR');
      fotoExterior = await descargar(
        ext?.url as string,
        ext?.content_type as string,
      );
      fotoInterior = await descargar(
        int_?.url as string,
        int_?.content_type as string,
      );
    }

    const ivaRaw = num(quote.iva_pct) ?? 0;
    // Recibo del cliente: la lista para TÍTULO/ITINERARIO/MAPA sale del
    // snapshot del cálculo (la ruta COMERCIAL exacta que configuró oficina,
    // con la bandera pdf_oculto por tramo — 27-ago); cotizaciones viejas sin
    // tramos en snapshot caen a las escalas del vuelo. QUIÉN decide si un
    // tramo se muestra es SOLO el switch pdf_oculto (regla 27-ago v2: los
    // ferry también salen si su switch está prendido — antes se filtraban
    // solos y "Mostrar en PDF" parecía roto). El precio NO cambia: ya está
    // en el desglose del snapshot.
    const tramosSnap = (
      (quote.calculo_snapshot as Record<string, unknown> | undefined)
        ?.tramos as Array<Record<string, unknown>> | undefined
    )?.filter((t) => t && typeof t === 'object');
    const escalas: Array<Record<string, unknown>> =
      tramosSnap && tramosSnap.length > 0
        ? tramosSnap
            .filter((t) => t.pdf_oculto !== true)
            .map((t, i) => ({
              orden: num(t.orden) ?? i + 1,
              origen_iata: (t.origen as string) ?? '',
              destino_iata: (t.destino as string) ?? '',
              millas_nauticas: t.millas,
              pasajeros: t.pasajeros,
              es_ferry: t.es_ferry === true,
              requiere_pernocta: t.requiere_pernocta === true,
              pernocta_costo_usd: t.pernocta_usd,
              tipo_parada: t.tipo_parada,
              servicio_notas: t.servicio_notas,
            }))
        : (
            (quote.escalas as Array<Record<string, unknown>> | undefined) ?? []
          ).filter(
            (e) =>
              (e as { solo_operativa?: boolean }).solo_operativa !== true &&
              (e as { pdf_oculto?: boolean }).pdf_oculto !== true,
          );

    // TUAS ligados al recibo CON su moneda (requisito del cliente): las líneas
    // del desglose canónico ya traen aeropuerto, unitario, pax y moneda.
    // Cotizaciones viejas sin snapshot → [] y la plantilla conserva la línea
    // única "TUAS".
    const snap = quote.calculo_snapshot as Record<string, unknown> | undefined;
    const desglose = snap?.desglose;
    const tuasDetalle = Array.isArray(desglose)
      ? (desglose as Array<Record<string, unknown>>)
          .filter(
            (d) =>
              d.clave === 'TUAS' &&
              typeof d.concepto === 'string' &&
              d.concepto,
          )
          .map((d) => d.concepto as string)
      : [];

    // Comisión del vendedor (regla jul 2026: se SUMA al precio del cliente):
    // NUNCA se lista en el recibo — se absorbe en el subtotal (mismo
    // mecanismo que el redondeo hacia arriba). Se toma la línea canónica
    // PRE-IVA del snapshot (su IVA ya viene dentro de iva_usd, así que
    // absorber solo el monto pre-IVA mantiene la columna sumando EXACTO el
    // total). Cotizaciones viejas (comisión fuera del total) no traen la
    // línea COMISION_VENDEDOR y no absorben nada.
    const comisionEnTotalUsd = Array.isArray(desglose)
      ? (desglose as Array<Record<string, unknown>>)
          .filter((d) => d.clave === 'COMISION_VENDEDOR')
          .reduce((acc, d) => acc + (num(d.monto_usd) ?? 0), 0)
      : 0;

    // Coordenadas de los aeropuertos del itinerario para el MAPA del PDF.
    const iatas = [
      ...new Set(
        escalas.flatMap((e) => [
          (e.origen_iata as string) ?? '',
          (e.destino_iata as string) ?? '',
        ]),
      ),
    ].filter(Boolean);
    const coordPorIata = new Map<string, { lat: number; lon: number }>();
    if (iatas.length > 0) {
      const { data: aps } = await this.supabase.service
        .from('aeropuerto')
        .select('iata, latitud, longitud')
        .in('iata', iatas);
      for (const a of aps ?? []) {
        const lat = num(a.latitud);
        const lon = num(a.longitud);
        if (lat != null && lon != null) {
          coordPorIata.set((a.iata as string).toUpperCase(), { lat, lon });
        }
      }
    }
    const mapaPuntos = escalas
      .map((e, i) => {
        const o = coordPorIata.get(
          ((e.origen_iata as string) ?? '').toUpperCase(),
        );
        const d = coordPorIata.get(
          ((e.destino_iata as string) ?? '').toUpperCase(),
        );
        if (!o || !d) return null;
        return {
          orden: num(e.orden) ?? i + 1,
          origen_iata: (e.origen_iata as string) ?? '',
          destino_iata: (e.destino_iata as string) ?? '',
          o_lat: o.lat,
          o_lon: o.lon,
          d_lat: d.lat,
          d_lon: d.lon,
          es_ferry: e.es_ferry === true,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const payload = {
      folio: String(quote.folio ?? ''),
      fecha:
        (quote.fecha_confirmacion as string) ??
        (quote.fecha_solicitud as string) ??
        null,
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
      // Presentación configurable por cotización (27-ago).
      mostrar_tarifa_hora: quote.pdf_mostrar_tarifa === true,
      mostrar_itinerario: quote.pdf_mostrar_itinerario !== false,
      subtotal_usd: (() => {
        // Recibo del CLIENTE: el redondeo hacia arriba (ajuste > 0) y la
        // comisión del vendedor (parte del total desde jul 2026) se ABSORBEN
        // aquí para que la columna del desglose sume EXACTO el total sin
        // revelar la cocina interna (regla: ninguno de los dos se lista).
        const base = num(quote.subtotal_vuelo_usd) ?? 0;
        const ajuste = num(quote.ajuste_final_usd) ?? 0;
        return (
          Math.round(
            (base + (ajuste > 0 ? ajuste : 0) + comisionEnTotalUsd) * 100,
          ) / 100
        );
      })(),
      tuas_usd: num(quote.tuas_usd) ?? 0,
      tuas_detalle: tuasDetalle,
      extras: (
        (quote.extras as Array<Record<string, unknown>> | undefined) ?? []
      ).map((e) => ({
        concepto: (e.concepto as string) ?? '',
        monto_usd: num(e.monto_usd) ?? 0,
        // Moneda nativa del extra (los pagados en pesos se muestran "· $X MXN").
        moneda: (e.moneda as string) ?? 'USD',
        monto_nativo: num(e.monto_nativo),
        aplica_iva: e.aplica_iva !== false,
      })),
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
      // Total MXN EXACTO por composición (vuelo.monto_total_mxn, ya persistido
      // por el motor) + TC congelado de la cotización, para la línea final.
      total_mxn: num(quote.monto_total_mxn),
      tc_usd_mxn: num(quote.tc_usd_mxn),
      moneda: 'USD',
      notas: (quote.notas as string) ?? null,
      // PDF profesional (26-ago): matrícula, fotos y mapa de ruta.
      matricula,
      // Avión EXTERNO (28-ago, venta broker): ficha capturada a mano — el
      // cliente ve "HAWKER 400 A · XA-REG" como en la cotización manual;
      // jamás la palabra "externo" (doc §9.1: el cliente no lo sabe).
      avion_externo:
        quote.es_externo === true
          ? [
              (quote.avion_externo_modelo as string | null)?.trim(),
              (quote.avion_externo_matricula as string | null)?.trim(),
            ]
              .filter((x): x is string => !!x)
              .join(' · ') || null
          : null,
      foto_exterior: fotoExterior,
      foto_interior: fotoInterior,
      // Ficha comercial "De un vistazo" (26-ago v2). El tiempo por tramo es
      // el del tramo MÁS LARGO: tiempo_hr del snapshot (motor canónico);
      // sin tramos calculados (REDONDO simple/viejas), aproximación
      // millas/velocidad SOLO para display — jamás para cobrar.
      avion_modelo: (avion?.modelo as string | null) ?? null,
      avion_velocidad_kts: num(avion?.velocidad_crucero_kts),
      avion_pasajeros: num(avion?.asientos),
      avion_num_motores: num(avion?.num_motores),
      avion_motor_hp: num(avion?.motor_hp),
      avion_caracteristicas: (avion?.caracteristicas as string[] | null) ?? [],
      avion_tiempo_tramo_hr: (() => {
        const tramosSnap =
          ((quote.calculo_snapshot as Record<string, unknown> | undefined)
            ?.tramos as Array<Record<string, unknown>> | undefined) ?? [];
        let max: number | null = null;
        for (const t of tramosSnap) {
          const th = num(t.tiempo_hr);
          if (th != null && th > 0) max = Math.max(max ?? 0, th);
        }
        if (max != null) return max;
        const kts = num(avion?.velocidad_crucero_kts);
        if (!kts || kts <= 0) return null;
        for (const e of escalas) {
          const mn = num(e.millas_nauticas);
          if (mn != null && mn > 0) max = Math.max(max ?? 0, mn / kts);
        }
        return max;
      })(),
      mapa_puntos: mapaPuntos,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${baseUrl}/reportes/cotizacion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ServiceUnavailableException(
          `pyservices respondió ${res.status} al generar el PDF`,
        );
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`render PDF falló: ${msg}`);
      throw new ServiceUnavailableException(
        `No se pudo generar el PDF: ${msg}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
