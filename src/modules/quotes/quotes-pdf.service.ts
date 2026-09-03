import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import type { EnvVars } from '../../config/env.schema';
import { puntosRutaVisible } from '../../common/ruta-visible.util';

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Vista de tramos PARA EL PDF del cliente: visibles renumerados 1..N, la
 * línea de ruta ya resuelta y las fechas de traslado ajustadas cuando el
 * primer/último tramo real quedó oculto.
 */
export interface EscalasPdfVisibles {
  /**
   * Tramos visibles RENUMERADOS 1..N (jamás exponen la posición original).
   * Cada uno trae `pdf_fecha` ('YYYY-MM-DD' | null): la fecha de PARED que
   * el cliente ve en el PDF para ese tramo (3-sep), sacada de la escala viva.
   */
  escalas: Array<Record<string, unknown>>;
  /** "CUN → AZP → BZE → CZM → CUN" uniendo solo puntos visibles; null sin tramos. */
  ruta: string | null;
  fechaTrasladoInicial: string | null;
  fechaTrasladoFinal: string | null;
  /**
   * Máximo tiempo_hr del snapshot entre TODOS los tramos cotizados — los
   * ocultos INCLUIDOS (decisión del cliente 2-sep: horas y TUAS del recibo
   * SIN ajuste por tramos ocultos; el filtro pdf_oculto es solo del
   * itinerario/mapa/ruta). Alimenta "De un vistazo".
   */
  tiempoTramoSnapMaxHr: number | null;
  /**
   * Máximo millas_nauticas entre TODOS los tramos comerciales (mismo criterio
   * 2-sep). Fallback de "De un vistazo" cuando el snapshot no trae tiempo_hr
   * (REDONDO simple / cotizaciones viejas): el render lo divide entre la
   * velocidad de crucero SOLO para display, jamás para cobrar.
   */
  millasTramoMaxNm: number | null;
}

/**
 * ÚNICO lugar donde se filtra `pdf_oculto` para el PDF de cotización: el
 * título (ruta), TRASLADOS, la tabla de itinerario y el mapa salen TODOS de
 * aquí. Presentación PURA (regla 27-ago): jamás toca el motor v1.3, el
 * desglose canónico ni los totales — el tramo oculto se sigue cobrando.
 *
 * Reglas:
 * - La lista base sale del snapshot (ruta COMERCIAL congelada que configuró
 *   oficina); sin tramos en snapshot (REDONDO simple / cotizaciones viejas)
 *   cae a las escalas del vuelo, sin `solo_operativa` ni canceladas
 *   (regla 27-jul: los lectores excluyen cancelados).
 * - El switch `pdf_oculto` MANDA desde la escala VIVA (cruce por `orden`):
 *   el snapshot solo se regenera en calculate/revise/quickAdjust, así que un
 *   toggle hecho fuera de "Revisar" (o una cotización pre-27-ago) solo vive
 *   en la escala. Sin escala viva de ese orden, decide el snapshot.
 * - Los visibles se RENUMERAN 1..N consecutivos ANTES de armar mapa y
 *   payload: el cliente jamás ve la posición original (delataría ocultos).
 * - Si el primer/último tramo real quedó oculto, la fecha de traslado
 *   inicial/final toma la `fecha_salida_plan` del primer/último VISIBLE
 *   (fallback: los campos del vuelo, como siempre) — default propuesto;
 *   pendiente confirmar con el cliente si las fechas de contrato se quedan.
 * - EXCEPCIÓN (decisión del cliente 2-sep): las HORAS del "De un vistazo"
 *   (`tiempoTramoSnapMaxHr` / `millasTramoMaxNm`) NO se filtran — salen de
 *   TODOS los tramos cotizados, ocultos incluidos (igual que los TUAS, que
 *   ya salían completos del desglose canónico).
 * - FECHA DEL TRAMO EN EL PDF (3-sep-2026): `pdf_fecha ?? null` de la escala
 *   VIVA cruzada por `orden` — fecha de PARED ('YYYY-MM-DD') que se imprime
 *   tal cual, SIN fallback a `fecha_salida_plan`/`fecha_vuelo` (esas son
 *   operativas y llevan hora/zona; si oficina no captura fecha, el PDF no
 *   imprime ninguna). Los ocultos ya se filtraron antes de renumerar, así
 *   que su fecha jamás viaja al payload. Presentación pura: no toca la ruta
 *   operativa, el snapshot ni el precio.
 */
export function escalasVisiblesPdf(
  quote: Record<string, unknown>,
): EscalasPdfVisibles {
  // Escalas VIVAS por orden (fuente de verdad del switch pdf_oculto y de la
  // fecha_salida_plan por tramo; findEscalas ya las trae ordenadas).
  const escalasVivas =
    (quote.escalas as Array<Record<string, unknown>> | undefined) ?? [];
  const vivaPorOrden = new Map<number, Record<string, unknown>>();
  for (const e of escalasVivas) {
    const o = num(e.orden);
    if (o != null && !vivaPorOrden.has(o)) vivaPorOrden.set(o, e);
  }
  const ocultoSnap = (t: Record<string, unknown>): boolean => {
    const viva = vivaPorOrden.get(num(t.orden) ?? Number.NaN);
    if (viva && viva.pdf_oculto != null) return viva.pdf_oculto === true;
    return t.pdf_oculto === true;
  };
  // Fecha SOLO para el PDF (3-sep): sale de la escala VIVA por orden
  // (`escala.pdf_fecha`, columna date → 'YYYY-MM-DD'); slice(0, 10) es
  // defensivo por si el driver devolviera un timestamp. Sin captura = null:
  // NUNCA cae a fecha_salida_plan/fecha_vuelo (operativas, con hora/zona) y
  // jamás pasa por new Date() (asumiría UTC y movería el día).
  const fechaPdfDeOrden = (orden: unknown): string | null => {
    const viva = vivaPorOrden.get(num(orden) ?? Number.NaN);
    const f = viva?.pdf_fecha;
    return typeof f === 'string' && f ? f.slice(0, 10) : null;
  };

  const tramosSnap = (
    (quote.calculo_snapshot as Record<string, unknown> | undefined)?.tramos as
      | Array<Record<string, unknown>>
      | undefined
  )?.filter((t) => t && typeof t === 'object');

  // Lista visible CON su orden ORIGINAL (para cruzar fechas y detectar si el
  // primer/último tramo real quedó oculto); se renumera al final.
  let visibles: Array<Record<string, unknown>>;
  let ordenPrimeraReal: number | null = null;
  let ordenUltimaReal: number | null = null;
  let tiempoTramoSnapMaxHr: number | null = null;
  let millasTramoMaxNm: number | null = null;
  if (tramosSnap && tramosSnap.length > 0) {
    ordenPrimeraReal = num(tramosSnap[0].orden) ?? 1;
    ordenUltimaReal = num(tramosSnap[tramosSnap.length - 1].orden) ?? null;
    // Horas del "De un vistazo" con TODOS los tramos — ocultos incluidos
    // (decisión del cliente 2-sep: horas y TUAS sin ajuste por ocultos).
    for (const t of tramosSnap) {
      const th = num(t.tiempo_hr);
      if (th != null && th > 0) {
        tiempoTramoSnapMaxHr = Math.max(tiempoTramoSnapMaxHr ?? 0, th);
      }
      const mn = num(t.millas);
      if (mn != null && mn > 0) {
        millasTramoMaxNm = Math.max(millasTramoMaxNm ?? 0, mn);
      }
    }
    visibles = tramosSnap
      .filter((t) => !ocultoSnap(t))
      .map((t) => ({
        orden: num(t.orden) ?? 0,
        origen_iata: (t.origen as string) ?? '',
        destino_iata: (t.destino as string) ?? '',
        millas_nauticas: t.millas,
        pasajeros: t.pasajeros,
        es_ferry: t.es_ferry === true,
        requiere_pernocta: t.requiere_pernocta === true,
        pernocta_costo_usd: t.pernocta_usd,
        tipo_parada: t.tipo_parada,
        servicio_notas: t.servicio_notas,
        pdf_fecha: fechaPdfDeOrden(t.orden),
      }));
  } else {
    const base = escalasVivas.filter(
      (e) => e.solo_operativa !== true && e.cancelada_at == null,
    );
    ordenPrimeraReal = base.length > 0 ? num(base[0].orden) : null;
    ordenUltimaReal = base.length > 0 ? num(base[base.length - 1].orden) : null;
    // Mismo criterio 2-sep: las millas del fallback salen de TODOS los
    // tramos comerciales, no solo de los visibles.
    for (const e of base) {
      const mn = num(e.millas_nauticas);
      if (mn != null && mn > 0) {
        millasTramoMaxNm = Math.max(millasTramoMaxNm ?? 0, mn);
      }
    }
    visibles = base
      .filter((e) => e.pdf_oculto !== true)
      .map((e) => ({ ...e, pdf_fecha: fechaPdfDeOrden(e.orden) }));
  }

  // Fechas de traslado: si el primer/último tramo REAL quedó oculto, la fecha
  // del vuelo delataría un tramo que el cliente no debe ver — se usa la
  // fecha_salida_plan del primer/último VISIBLE (fallback: campos del vuelo).
  const fechaPlanDeOrden = (orden: unknown): string | null => {
    const viva = vivaPorOrden.get(num(orden) ?? Number.NaN);
    const f = viva?.fecha_salida_plan;
    return typeof f === 'string' && f ? f : null;
  };
  let fechaTrasladoInicial = (quote.fecha_vuelo as string) ?? null;
  const primera = visibles[0];
  if (
    primera &&
    ordenPrimeraReal != null &&
    num(primera.orden) !== ordenPrimeraReal
  ) {
    fechaTrasladoInicial =
      fechaPlanDeOrden(primera.orden) ?? fechaTrasladoInicial;
  }
  let fechaTrasladoFinal = (quote.fecha_traslado_final as string) ?? null;
  const ultima = visibles[visibles.length - 1];
  if (
    ultima &&
    ordenUltimaReal != null &&
    num(ultima.orden) !== ordenUltimaReal
  ) {
    fechaTrasladoFinal = fechaPlanDeOrden(ultima.orden) ?? fechaTrasladoFinal;
  }

  // Línea de ruta uniendo SOLO puntos visibles (helper compartido con el
  // recibo de cobro). Con todo oculto queda null: pyservices degrada el
  // título a origen→destino del vuelo, sin tabla ni mapa (esperado).
  const ruta =
    visibles.length > 0 ? puntosRutaVisible(visibles).join(' → ') : null;

  // RENUMERAR 1..N consecutivos — SOLO el payload del PDF; jamás escala.orden
  // ni snapshot.tramos[].orden (orden es clave del UPSERT de replaceEscalas,
  // del espejo vuelo↔tramo1 y del cruce snapshot↔escala de arriba).
  const escalas = visibles.map((e, i) => ({ ...e, orden: i + 1 }));

  return {
    escalas,
    ruta,
    fechaTrasladoInicial,
    fechaTrasladoFinal,
    tiempoTramoSnapMaxHr,
    millasTramoMaxNm,
  };
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
    // Recibo del cliente: la lista para TÍTULO/TRASLADOS/ITINERARIO/MAPA sale
    // COMPLETA de escalasVisiblesPdf (único punto de filtrado de pdf_oculto,
    // regla 27-ago; los ferry también salen si su switch está prendido) —
    // visibles renumerados 1..N, ruta con huecos unidos y fechas de traslado
    // ajustadas. El precio NO cambia: ya está en el desglose del snapshot.
    const {
      escalas,
      ruta,
      fechaTrasladoInicial,
      fechaTrasladoFinal,
      tiempoTramoSnapMaxHr,
      millasTramoMaxNm,
    } = escalasVisiblesPdf(quote);

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
      fecha_traslado_inicial: fechaTrasladoInicial,
      fecha_traslado_final: fechaTrasladoFinal,
      // Ruta VISIBLE ya resuelta (con tramos ocultos, une los puntos que
      // quedan). Campo ADITIVO: pyservices lo usa para el título y conserva
      // su walk actual como fallback (skew tolerante en ambos sentidos).
      ruta,
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
        // Fecha de PARED SOLO para el PDF (3-sep): 'YYYY-MM-DD' | null, la
        // pinta pyservices sin hora ni zona. Campo ADITIVO (la plantilla
        // vieja lo ignora); sin fecha en ningún tramo no hay columna.
        fecha: (e.pdf_fecha as string | null | undefined) ?? null,
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
        // Máximo entre TODOS los tramos de la cotización, ocultos incluidos
        // (decisión del cliente 2-sep: horas y TUAS del recibo SIN ajuste
        // por tramos ocultos — pdf_oculto solo filtra itinerario/mapa/ruta).
        if (tiempoTramoSnapMaxHr != null) return tiempoTramoSnapMaxHr;
        const kts = num(avion?.velocidad_crucero_kts);
        if (!kts || kts <= 0) return null;
        return millasTramoMaxNm != null && millasTramoMaxNm > 0
          ? millasTramoMaxNm / kts
          : null;
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
