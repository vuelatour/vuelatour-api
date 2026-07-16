import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  PyservicesService,
  type ReporteVueloLineaPayload,
  type ReporteVueloPayload,
} from '../pyservices/pyservices.service';
import { cobrosEnUsd } from '../../common/cobros-usd.util';

/** Columnas del vuelo necesarias para el reporte (incluye el desglose de precio). */
const REPORTE_COLS =
  'id, folio, cliente_id, aeronave_id, piloto_id, copiloto_id, tipo, estado, origen_iata, destino_iata, pasajeros, pasajeros_nombres, fecha_vuelo, fecha_traslado_final, monto_total_usd, monto_total_mxn, tc_usd_mxn, tarifa_tipo, tarifa_hora_usd, tiempo_cobrable_hr, subtotal_vuelo_usd, tuas_usd, iva_usd, viaticos_pernocta_usd, extras_total_usd, ajuste_final_usd, comision_vendedor_usd, comision_vendedor_nombre, metodo_cobro';

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Arma el reporte consolidado de UN vuelo (cotización + ingreso + tacómetro +
 * combustible + gastos) y lo renderiza en PDF/Excel vía pyservices.
 */
@Injectable()
export class FlightReportService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
  ) {}

  async pdf(flightId: string): Promise<Buffer> {
    return this.pyservices.generateReporteVueloPdf(await this.buildPayload(flightId));
  }

  async xlsx(flightId: string): Promise<Buffer> {
    return this.pyservices.generateReporteVueloXlsx(await this.buildPayload(flightId));
  }

  /** Folio del vuelo (para nombrar el archivo descargado). */
  async folio(flightId: string): Promise<string> {
    const { data } = await this.supabase.service
      .from('vuelo')
      .select('folio')
      .eq('id', flightId)
      .maybeSingle();
    return data?.folio != null ? String(data.folio) : flightId.slice(0, 8);
  }

  private async buildPayload(flightId: string): Promise<ReporteVueloPayload> {
    const sb = this.supabase.service;
    const { data: v, error } = await sb
      .from('vuelo')
      .select(REPORTE_COLS)
      .eq('id', flightId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!v) throw new NotFoundException(`Vuelo ${flightId} not found`);

    const [{ data: cliente }, { data: aeronave }, escalasRes, cobrosRes, gastosRes] =
      await Promise.all([
        v.cliente_id
          ? sb.from('cliente').select('nombre').eq('id', v.cliente_id).maybeSingle()
          : Promise.resolve({ data: null }),
        v.aeronave_id
          ? sb.from('aeronave').select('matricula, modelo').eq('id', v.aeronave_id).maybeSingle()
          : Promise.resolve({ data: null }),
        sb
          .from('escala')
          .select(
            'orden, origen_iata, destino_iata, pasajeros, pasajeros_nombres, taco_salida, taco_llegada, solo_operativa, es_ferry, requiere_pernocta',
          )
          .eq('vuelo_id', flightId)
          .order('orden', { ascending: true }),
        sb
          .from('cobro_vuelo')
          .select(
            'monto, moneda, tc_usd_mxn, metodo_cobro, fecha_cobro, comision_banco_pct, comision_banco_monto',
          )
          .eq('vuelo_id', flightId)
          .order('fecha_cobro', { ascending: true }),
        sb
          .from('gasto')
          .select('fecha_gasto, categoria, monto, moneda, litros, lugar, notas, proveedor:proveedor_id(nombre)')
          .eq('vuelo_id', flightId)
          .order('fecha_gasto', { ascending: true }),
      ]);

    // Un query fallido NO puede degradar a "sin datos": un reporte con cero
    // cobros de un vuelo pagado es una mentira numérica silenciosa (peor que
    // un error visible). Se truena aquí y el panel muestra el fallo.
    for (const [nombre, res] of [
      ['escalas', escalasRes],
      ['cobros', cobrosRes],
      ['gastos', gastosRes],
    ] as const) {
      if (res.error) {
        throw new Error(
          `Reporte del vuelo ${flightId}: fallo al leer ${nombre}: ${res.error.message}`,
        );
      }
    }

    // Nombres de piloto/copiloto.
    const userIds = [v.piloto_id, v.copiloto_id].filter(Boolean) as string[];
    const nombrePorId = new Map<string, string>();
    if (userIds.length) {
      const { data: us } = await sb.from('usuario').select('id, nombre').in('id', userIds);
      for (const u of us ?? []) nombrePorId.set(u.id as string, u.nombre as string);
    }

    const escalas = (escalasRes.data ?? []) as Array<Record<string, unknown>>;
    const comerciales = escalas.filter((e) => e.solo_operativa !== true);
    const rutaLegs = comerciales.length > 0 ? comerciales : escalas;
    const ruta =
      rutaLegs.length > 0
        ? [
            rutaLegs[0].origen_iata as string,
            ...rutaLegs.map((e) => e.destino_iata as string),
          ].join(' → ')
        : `${v.origen_iata as string} → ${v.destino_iata as string}`;

    // pasajeros_nombres es ARREGLO en BD (manifiesto por tramo); el esquema
    // del PDF espera TEXTO — un [] crudo tiraba TODO el reporte (422).
    const nombresATexto = (v: unknown): string | null => {
      if (Array.isArray(v)) {
        const s = v.filter((x) => typeof x === 'string' && x.trim()).join(', ');
        return s || null;
      }
      return typeof v === 'string' && v.trim() ? v : null;
    };

    const tramos = escalas.map((e, idx) => {
      const s = e.taco_salida == null ? null : n(e.taco_salida);
      const l = e.taco_llegada == null ? null : n(e.taco_llegada);
      return {
        // Numeración VISIBLE secuencial: el orden interno puede ser >=100
        // (tramos operativos agregados a mano, para que el cotizador no los
        // pise) y confundía en el PDF ("tramo 100").
        orden: idx + 1,
        ruta: `${e.origen_iata as string} → ${e.destino_iata as string}`,
        pasajeros: e.pasajeros == null ? null : n(e.pasajeros),
        pasajeros_nombres: nombresATexto(e.pasajeros_nombres),
        taco_salida: s,
        taco_llegada: l,
        horas: s != null && l != null ? Number((l - s).toFixed(1)) : null,
        es_ferry: e.es_ferry === true,
      };
    });

    // Comparación pedida por el cliente: horas COTIZADAS (ruta comercial, lo
    // que pagó el cliente) vs horas VOLADAS (ruta operativa completa, según
    // tacómetros). El delta positivo es la utilidad operativa que buscan
    // maximizar (salir de otra base, pernoctar, aprovechar ferries). Las notas
    // explican el motivo del ahorro SIN captura extra: se derivan de los datos
    // que ya existen en las escalas.
    const horasCotizadas = v.tiempo_cobrable_hr == null ? null : n(v.tiempo_cobrable_hr);
    const horasConDato = tramos.filter((t) => t.horas != null);
    const horasVoladas =
      horasConDato.length > 0
        ? Number(horasConDato.reduce((acc, t) => acc + (t.horas ?? 0), 0).toFixed(1))
        : null;
    const notasHoras: string[] = [];
    const primerOrigen = (escalas[0]?.origen_iata as string | undefined) ?? null;
    if (primerOrigen && primerOrigen !== 'CUN') {
      notasHoras.push(`El avión salió de ${primerOrigen} (no de CUN): se ahorró el posicionamiento.`);
    }
    for (const e of escalas) {
      if (e.requiere_pernocta === true) {
        notasHoras.push(`Pernoctó en ${e.destino_iata as string}: el regreso no se voló el mismo día.`);
      }
    }
    const ferries = escalas.filter((e) => e.es_ferry === true).length;
    if (ferries > 0) {
      notasHoras.push(
        `${ferries} tramo${ferries === 1 ? '' : 's'} ferry (sin pasajeros) dentro del itinerario operativo.`,
      );
    }
    if (horasCotizadas != null && horasVoladas != null) {
      const delta = Number((horasCotizadas - horasVoladas).toFixed(1));
      if (delta > 0) {
        notasHoras.push(`Se volaron ${delta} hrs MENOS de las cotizadas: utilidad operativa a favor.`);
      } else if (delta < 0) {
        notasHoras.push(`Se volaron ${Math.abs(delta)} hrs MÁS de las cotizadas: revisar el itinerario.`);
      }
    }

    const cobros: ReporteVueloLineaPayload[] = (cobrosRes.data ?? []).map((c) => ({
      fecha: (c.fecha_cobro as string) ?? null,
      concepto: (c.metodo_cobro as string) ?? 'Cobro',
      // La comisión bancaria del cobro se muestra en su renglón: el banco
      // depositó monto − comisión (pedido del cliente: el reporte no cuadraba
      // con el estado de cuenta).
      detalle:
        n(c.comision_banco_monto) > 0
          ? `Comisión banco ${Number(c.comision_banco_pct ?? 0)}% − $${n(
              c.comision_banco_monto,
            ).toFixed(2)} ${(c.moneda as string) ?? ''}`.trim()
          : null,
      moneda: (c.moneda as string) ?? 'USD',
      monto: n(c.monto),
    }));
    // Total cobrado por la fuente canónica: cada cobro convertido a USD con su
    // TC (o el del vuelo). Antes se sumaban MXN y USD crudos → saldos absurdos.
    const conv = cobrosEnUsd(
      (cobrosRes.data ?? []) as Array<Record<string, unknown>>,
      v.tc_usd_mxn as number | null,
    );
    const totalCobrado = conv.total_usd;
    if (conv.sin_tc_count > 0) {
      notasHoras.push(
        `${conv.sin_tc_count} cobro(s) en MXN por $${conv.sin_tc_mxn.toLocaleString('en-US')} sin tipo de cambio: NO están en el total cobrado — captura su TC.`,
      );
    }
    // Comisiones bancarias a USD con la MISMA regla de conversión que los
    // cobros (pseudo-cobros por el monto de la comisión): total antes de
    // comisión vs neto que realmente entró al banco.
    const comisionesConv = cobrosEnUsd(
      ((cobrosRes.data ?? []) as Array<Record<string, unknown>>)
        .filter((c) => n(c.comision_banco_monto) > 0)
        .map((c) => ({
          monto: c.comision_banco_monto,
          moneda: c.moneda,
          tc_usd_mxn: c.tc_usd_mxn,
        })),
      v.tc_usd_mxn as number | null,
    );
    const comisionesBancoUsd = comisionesConv.total_usd;

    const gastosRows = (gastosRes.data ?? []) as Array<Record<string, unknown>>;
    const proveedorNombre = (g: Record<string, unknown>): string | null => {
      const p = g.proveedor as { nombre?: string } | { nombre?: string }[] | null;
      if (Array.isArray(p)) return p[0]?.nombre ?? null;
      return p?.nombre ?? null;
    };
    const combustible: ReporteVueloLineaPayload[] = gastosRows
      .filter((g) => g.categoria === 'GAS')
      .map((g) => ({
        fecha: (g.fecha_gasto as string) ?? null,
        detalle:
          [g.lugar, g.litros != null ? `${n(g.litros)} L` : null]
            .filter(Boolean)
            .join(' · ') || 'Combustible',
        moneda: (g.moneda as string) ?? 'MXN',
        monto: n(g.monto),
      }));
    const gastos: ReporteVueloLineaPayload[] = gastosRows
      .filter((g) => g.categoria !== 'GAS')
      .map((g) => ({
        fecha: (g.fecha_gasto as string) ?? null,
        concepto:
          g.categoria === 'PILOTO_EXTERNO'
            ? 'Piloto externo'
            : ((g.categoria as string) ?? 'OTRO'),
        // El detalle incluye el DESGLOSE que compone el servidor (Operación /
        // TUA / FBO con IVA) — el cliente lo pidió explícitamente EN el
        // reporte. Se aplana a una línea para el PDF/Excel.
        detalle:
          [
            proveedorNombre(g),
            (g.notas as string | null)?.replace(/\s*\n+\s*/g, ' · ') || null,
          ]
            .filter(Boolean)
            .join(' · ') || null,
        moneda: (g.moneda as string) ?? 'MXN',
        monto: n(g.monto),
      }));

    const matricula = (aeronave as { matricula?: string; modelo?: string } | null);

    return {
      generado: new Date().toISOString(),
      folio: v.folio != null ? String(v.folio) : flightId.slice(0, 8),
      cliente: (cliente as { nombre?: string } | null)?.nombre ?? '',
      aeronave: matricula
        ? [matricula.matricula, matricula.modelo].filter(Boolean).join(' · ')
        : null,
      piloto: v.piloto_id ? (nombrePorId.get(v.piloto_id as string) ?? null) : null,
      copiloto: v.copiloto_id ? (nombrePorId.get(v.copiloto_id as string) ?? null) : null,
      tipo: (v.tipo as string) ?? '',
      estado: (v.estado as string) ?? '',
      ruta,
      fecha_vuelo: (v.fecha_vuelo as string) ?? null,
      fecha_traslado_final: (v.fecha_traslado_final as string) ?? null,
      pasajeros: n(v.pasajeros),
      pasajeros_nombres: nombresATexto(v.pasajeros_nombres),
      tarifa_tipo: (v.tarifa_tipo as string) ?? null,
      tarifa_hora_usd: v.tarifa_hora_usd == null ? null : n(v.tarifa_hora_usd),
      tiempo_cobrable_hr: v.tiempo_cobrable_hr == null ? null : n(v.tiempo_cobrable_hr),
      subtotal_usd: n(v.subtotal_vuelo_usd),
      tuas_usd: n(v.tuas_usd),
      iva_usd: n(v.iva_usd),
      viaticos_pernocta_usd: n(v.viaticos_pernocta_usd),
      extras_total_usd: n(v.extras_total_usd),
      ajuste_final_usd: n(v.ajuste_final_usd),
      total_usd: n(v.monto_total_usd),
      total_mxn: v.monto_total_mxn == null ? null : n(v.monto_total_mxn),
      tc_usd_mxn: v.tc_usd_mxn == null ? null : n(v.tc_usd_mxn),
      // Comisión del vendedor: se muestra DESPUÉS del total (el cliente paga
      // el total completo); neto = lo que queda a VuelaTour.
      comision_vendedor_usd: n(v.comision_vendedor_usd),
      comision_vendedor_nombre: (v.comision_vendedor_nombre as string | null) ?? null,
      neto_vuelatour_usd:
        n(v.comision_vendedor_usd) > 0
          ? Number((n(v.monto_total_usd) - n(v.comision_vendedor_usd)).toFixed(2))
          : null,
      metodo_cobro: (v.metodo_cobro as string) ?? null,
      tramos,
      horas_cotizadas_hr: horasCotizadas,
      horas_voladas_hr: horasVoladas,
      horas_delta_hr:
        horasCotizadas != null && horasVoladas != null
          ? Number((horasCotizadas - horasVoladas).toFixed(1))
          : null,
      notas_horas: notasHoras,
      cobros,
      total_cobrado_usd: Number(totalCobrado.toFixed(2)),
      // Comisiones del banco: el saldo del CLIENTE se calcula contra el bruto
      // (pagó completo); el neto es lo que de verdad entró a la cuenta.
      comision_banco_usd: Number(comisionesBancoUsd.toFixed(2)),
      total_cobrado_neto_usd:
        comisionesBancoUsd > 0
          ? Number((totalCobrado - comisionesBancoUsd).toFixed(2))
          : null,
      saldo_usd: Number((n(v.monto_total_usd) - totalCobrado).toFixed(2)),
      combustible,
      gastos,
    };
  }
}
