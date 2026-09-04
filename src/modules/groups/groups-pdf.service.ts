import { Injectable, Logger } from '@nestjs/common';
import { puntosRutaVisible } from '../../common/ruta-visible.util';
import {
  PyservicesService,
  type CotizacionGrupoPdfAvion,
  type CotizacionGrupoPdfRequest,
} from '../pyservices/pyservices.service';
import { SupabaseService } from '../supabase/supabase.service';
import { GroupsService } from './groups.service';
import { round2, type LineaConsolidada } from './grupo-armador.util';

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * PDF ÚNICO de la cotización de grupo (hermano de quotes-pdf.service):
 * arma `CotizacionGrupoPdfRequest` con el consolidado YA calculado por
 * GroupsService (Σ de desgloses canónicos de los hijos vivos) y lo manda a
 * pyservices `POST /reportes/cotizacion-grupo`. Presentación pura: aquí no
 * se recalcula dinero. Regla del recibo del cliente (igual que el PDF de un
 * avión): la comisión del vendedor y el redondeo hacia arriba se ABSORBEN
 * en "Servicio aéreo"; el descuento sí se lista.
 */
@Injectable()
export class GroupsPdfService {
  private readonly logger = new Logger(GroupsPdfService.name);

  constructor(
    private readonly groups: GroupsService,
    private readonly pyservices: PyservicesService,
    private readonly supabase: SupabaseService,
  ) {}

  async render(grupoId: string): Promise<{ buffer: Buffer; folio: number }> {
    const payload = await this.payload(grupoId);
    const buffer = await this.pyservices.generateCotizacionGrupoPdf(payload);
    return { buffer, folio: payload.folio };
  }

  /** Payload completo (expuesto para pruebas/inspección desde el panel). */
  async payload(grupoId: string): Promise<CotizacionGrupoPdfRequest> {
    const g = await this.groups.findOne(grupoId);
    const consolidado = g.consolidado;
    const vivos = g.aviones.filter((a) => !a.cancelado);

    // Itinerario y mapa desde la plantilla (una sola vez): tramos visibles.
    const visibles = g.escalas_plantilla.filter((t) => t.pdf_oculto !== true);
    const ruta = visibles.length
      ? puntosRutaVisible(visibles).join(' → ')
      : null;
    const iatas = [
      ...new Set(visibles.flatMap((t) => [t.origen_iata, t.destino_iata])),
    ];
    const coord = new Map<string, { lat: number; lon: number }>();
    if (iatas.length > 0) {
      const { data: aps } = await this.supabase.service
        .from('aeropuerto')
        .select('iata, latitud, longitud')
        .in('iata', iatas);
      for (const a of aps ?? []) {
        const lat = num(a.latitud);
        const lon = num(a.longitud);
        if (lat != null && lon != null) {
          coord.set((a.iata as string).toUpperCase(), { lat, lon });
        }
      }
    }
    const mapaPuntos = visibles
      .map((t, i) => {
        const o = coord.get(t.origen_iata);
        const d = coord.get(t.destino_iata);
        if (!o || !d) return null;
        return {
          orden: i + 1,
          origen_iata: t.origen_iata,
          destino_iata: t.destino_iata,
          o_lat: o.lat,
          o_lon: o.lon,
          d_lat: d.lat,
          d_lon: d.lon,
          es_ferry: t.es_ferry === true,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Desglose apto para el cliente: servicio aéreo absorbe comisión del
    // vendedor y redondeo (>0); descuento (<0) se lista; TUAS por
    // aeropuerto; extras con "n × $u"; pernocta; IVA.
    const lineas = consolidado.desglose;
    const servicio = round2(
      consolidado.subtotal_aereo_usd +
        consolidado.comision_vendedor_usd +
        (consolidado.ajuste_usd > 0 ? consolidado.ajuste_usd : 0),
    );
    const descuento =
      consolidado.ajuste_usd < 0 ? round2(-consolidado.ajuste_usd) : 0;
    const linea = (l: LineaConsolidada) => ({
      clave: l.clave,
      concepto: l.concepto,
      monto_usd: l.monto_usd,
      ...(l.cantidad != null ? { cantidad: l.cantidad } : {}),
      ...(l.unitario != null ? { unitario: l.unitario } : {}),
      ...(l.moneda ? { moneda: l.moneda } : {}),
    });
    const desgloseCliente = [
      {
        clave: 'TIEMPO_VUELO',
        concepto: `Servicio aéreo · ${vivos.length} aeronave${vivos.length === 1 ? '' : 's'}`,
        monto_usd: servicio,
      },
      ...lineas.filter((l) => l.clave === 'TUAS').map(linea),
      ...lineas.filter((l) => l.clave === 'EXTRA').map(linea),
      ...(descuento > 0
        ? [{ clave: 'AJUSTE', concepto: 'Descuento', monto_usd: -descuento }]
        : []),
      ...lineas.filter((l) => l.clave === 'IVA').map(linea),
      ...lineas.filter((l) => l.clave === 'PERNOCTA').map(linea),
    ];
    const extras = lineas
      .filter((l) => l.clave === 'EXTRA')
      .map((l) => ({
        concepto: l.concepto,
        monto_usd: l.monto_usd,
        ...(l.cantidad != null ? { cantidad: l.cantidad } : {}),
        ...(l.unitario != null ? { unitario: l.unitario } : {}),
        moneda: l.moneda ?? 'USD',
        aplica_iva: l.aplica_iva !== false,
      }));
    const ivaPct = (() => {
      const base = round2(
        consolidado.total_usd - consolidado.iva_usd - consolidado.pernocta_usd,
      );
      if (consolidado.iva_usd <= 0 || base <= 0) return 0;
      const pct = Math.round((consolidado.iva_usd / base) * 100);
      return pct;
    })();

    // Fichas de los aviones + fotos por MODELO (primer avión de cada uno).
    const ids = [
      ...new Set(
        vivos.map((a) => a.aeronave?.id).filter((x): x is string => !!x),
      ),
    ];
    const fichas = new Map<string, Record<string, unknown>>();
    const fotos = new Map<
      string,
      {
        exterior?: { url: string; mime: string | null };
        interior?: { url: string; mime: string | null };
      }
    >();
    if (ids.length > 0) {
      const [{ data: avs }, { data: imgs }] = await Promise.all([
        this.supabase.service
          .from('aeronave')
          .select(
            'id, matricula, modelo, velocidad_crucero_kts, asientos, num_motores, motor_hp, caracteristicas',
          )
          .in('id', ids),
        this.supabase.service
          .from('aeronave_imagen')
          .select('aeronave_id, url, etiqueta, content_type')
          .in('aeronave_id', ids)
          .in('etiqueta', ['EXTERIOR', 'INTERIOR']),
      ]);
      for (const a of (avs ?? []) as Array<Record<string, unknown>>)
        fichas.set(a.id as string, a);
      for (const i of imgs ?? []) {
        const f = fotos.get(i.aeronave_id as string) ?? {};
        const entry = {
          url: i.url as string,
          mime: (i.content_type as string | null) ?? null,
        };
        if (i.etiqueta === 'EXTERIOR') f.exterior = entry;
        if (i.etiqueta === 'INTERIOR') f.interior = entry;
        fotos.set(i.aeronave_id as string, f);
      }
    }
    const descargar = async (
      url: string | undefined,
      mime: string | null | undefined,
    ): Promise<string | null> => {
      if (!url) return null;
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        // 4 MB por foto: hasta 6 modelos × 2 fotos viajan en JSON.
        if (buf.byteLength > 4 * 1024 * 1024) return null;
        return `data:${mime || 'image/jpeg'};base64,${buf.toString('base64')}`;
      } catch {
        return null;
      }
    };
    const modelosConFoto = new Set<string>();
    const aviones: CotizacionGrupoPdfAvion[] = [];
    for (const a of vivos) {
      const ficha = a.aeronave ? fichas.get(a.aeronave.id) : undefined;
      const modelo =
        (ficha?.modelo as string | null) ?? a.aeronave?.modelo ?? null;
      const clave = (modelo ?? a.aeronave?.id ?? '').toUpperCase();
      let fotoExt: string | null = null;
      let fotoInt: string | null = null;
      const f = a.aeronave ? fotos.get(a.aeronave.id) : undefined;
      if (clave && !modelosConFoto.has(clave) && f) {
        fotoExt = await descargar(f.exterior?.url, f.exterior?.mime);
        fotoInt = await descargar(f.interior?.url, f.interior?.mime);
        if (fotoExt || fotoInt) modelosConFoto.add(clave);
      }
      aviones.push({
        posicion: a.posicion ?? aviones.length + 1,
        modelo,
        matricula: a.aeronave?.matricula ?? null,
        asientos: a.aeronave?.asientos ?? num(ficha?.asientos),
        pasajeros: a.pax ?? a.pasajeros,
        rotaciones: a.rotaciones,
        tiempo_hr: a.horas_cobrables_hr,
        salida_estimada: a.salida_plan ?? null,
        subtotal_usd: a.total_usd,
        tarifa_hora_usd: a.tarifa_hora_usd,
        velocidad_kts: num(ficha?.velocidad_crucero_kts),
        num_motores: num(ficha?.num_motores),
        motor_hp: num(ficha?.motor_hp),
        caracteristicas: (ficha?.caracteristicas as string[] | null) ?? [],
        foto_exterior: fotoExt,
        foto_interior: fotoInt,
        foto_exterior_url: f?.exterior?.url ?? null,
        foto_interior_url: f?.interior?.url ?? null,
      });
    }

    const payload: CotizacionGrupoPdfRequest = {
      folio_grupo: `G-${g.folio}`,
      folio: g.folio,
      nombre: g.nombre,
      cliente: g.cliente
        ? g.cliente.razon_social_default || g.cliente.nombre
        : 'Cliente',
      fecha: g.fecha_vuelo,
      pasajeros_total: g.pasajeros_total,
      aviones_total: vivos.length,
      ruta,
      itinerario: visibles.map((t, i) => ({
        orden: i + 1,
        origen: t.origen_iata,
        destino: t.destino_iata,
        es_ferry: t.es_ferry === true,
        requiere_pernocta: t.requiere_pernocta === true,
        tipo_parada: t.tipo_parada ?? 'NORMAL',
        servicio_notas: t.servicio_notas ?? null,
        fecha: i === 0 ? this.groups.diaCancunDe(g.fecha_vuelo) : null,
      })),
      mapa_puntos: mapaPuntos,
      desglose_consolidado: desgloseCliente,
      servicio_aereo_usd: servicio,
      horas_total_hr: consolidado.horas_total_hr,
      tuas_usd: consolidado.tuas_usd,
      tuas_detalle: lineas
        .filter((l) => l.clave === 'TUAS')
        .map((l) => l.concepto),
      extras,
      extras_total_usd: consolidado.extras_usd,
      viaticos_pernocta_usd: consolidado.pernocta_usd,
      descuento_usd: descuento,
      subtotal_usd: round2(consolidado.total_usd - consolidado.iva_usd),
      iva_pct: ivaPct,
      iva_usd: consolidado.iva_usd,
      total_usd: consolidado.total_usd,
      total_mxn: consolidado.total_mxn,
      tc_usd_mxn: g.tc_usd_mxn,
      precio_por_persona_usd: consolidado.por_persona_usd,
      moneda: 'USD',
      mostrar_precio_por_persona: g.pdf_mostrar_precio_por_persona !== false,
      mostrar_tarifa: g.pdf_mostrar_tarifa === true,
      mostrar_anexo_aviones: g.pdf_mostrar_anexo_aviones !== false,
      mostrar_subtotal_por_avion: g.pdf_mostrar_subtotal_por_avion === true,
      mostrar_itinerario: true,
      aviones,
      notas: g.notas ?? null,
      condiciones: null,
    };
    if (!consolidado.verificacion.cuadra) {
      this.logger.warn(
        `PDF grupo G-${g.folio}: el consolidado no cuadra (Σ líneas ${consolidado.verificacion.suma_lineas_usd} vs total ${consolidado.total_usd}).`,
      );
    }
    return payload;
  }
}
