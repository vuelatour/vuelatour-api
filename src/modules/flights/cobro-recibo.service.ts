import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import {
  PyservicesService,
  type ReciboAbonoPdfPayload,
  type ReciboPdfPayload,
} from '../pyservices/pyservices.service';
import { SupabaseService } from '../supabase/supabase.service';
import { COBRO_COLS } from './flights.service';

/**
 * Tolerancia de redondeo multi-moneda (misma regla que `refreshCobradoFlag`
 * y que el panel — caso #131): hasta 1 USD de saldo es redondeo, no deuda.
 */
const TOLERANCIA_COBRO_USD = 1;

/** Etiquetas legibles de método de cobro (mismo mapa que el panel admin). */
const METODO_LABELS: Record<string, string> = {
  TRANSFERENCIA: 'Transferencia',
  HSBC_LINK: 'HSBC link',
  CHEQUE: 'Cheque',
  BILLPOCKET: 'BillPocket',
  EFECTIVO: 'Efectivo',
  DOLARES: 'Dólares',
  OTRO: 'Otro',
};

/**
 * Recibo de pago (PDF NO fiscal) de UN cobro: comprobante amable para el
 * cliente que pagó una parcialidad — no sustituye al CFDI. El dinero sale de
 * las fuentes únicas del repo (cobrosEnUsd; jamás se recalcula aparte) y la
 * comisión bancaria NUNCA aparece (el recibo muestra el BRUTO que pagó el
 * cliente). Un vuelo CANCELADO con cobro real (cargo por cancelación,
 * anticipo retenido) SÍ tiene recibo.
 */
@Injectable()
export class CobroReciboService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
  ) {}

  /** vuelo_id del cobro — candado de acceso del PILOTO en el controller. */
  async vueloIdDeCobro(cobroId: string): Promise<string> {
    const { data, error } = await this.supabase.service
      .from('cobro_vuelo')
      .select('id, vuelo_id')
      .eq('id', cobroId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Cobro ${cobroId} not found`);
    return data.vuelo_id as string;
  }

  /** Renderiza el recibo en PDF (pyservices) y devuelve su folio legible. */
  async pdf(cobroId: string): Promise<{ buffer: Buffer; folioRecibo: string }> {
    const { payload, folioRecibo } = await this.buildRecibo(cobroId);
    const buffer = await this.pyservices.generateReciboPdf(payload);
    return { buffer, folioRecibo };
  }

  /** Arma el payload del recibo — todo calculado aquí; pyservices solo pinta. */
  private async buildRecibo(
    cobroId: string,
  ): Promise<{ payload: ReciboPdfPayload; folioRecibo: string }> {
    const sb = this.supabase.service;
    const { data: cobro, error } = await sb
      .from('cobro_vuelo')
      .select(COBRO_COLS)
      .eq('id', cobroId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!cobro) throw new NotFoundException(`Cobro ${cobroId} not found`);

    const monto = Number(cobro.monto);
    if (!Number.isFinite(monto) || monto <= 0) {
      throw new ConflictException(
        'Un reembolso no genera recibo de pago (solo los cobros positivos).',
      );
    }

    const vueloId = cobro.vuelo_id as string;
    const [vueloRes, escalasRes, cobrosRes] = await Promise.all([
      sb
        .from('vuelo')
        .select(
          'id, folio, cliente_id, origen_iata, destino_iata, fecha_vuelo, monto_total_usd, tc_usd_mxn',
        )
        .eq('id', vueloId)
        .maybeSingle(),
      sb
        .from('escala')
        .select('orden, origen_iata, destino_iata, solo_operativa')
        .eq('vuelo_id', vueloId)
        // Tramos cancelados fuera de la ruta: no volaron.
        .is('cancelada_at', null)
        .order('orden', { ascending: true }),
      sb
        .from('cobro_vuelo')
        .select(COBRO_COLS)
        .eq('vuelo_id', vueloId)
        .order('created_at', { ascending: true }),
    ]);
    // Un query fallido NO degrada a "sin datos": un recibo con saldo mal por
    // cobros ilegibles sería una mentira numérica silenciosa.
    if (vueloRes.error) throw new Error(vueloRes.error.message);
    if (escalasRes.error) throw new Error(escalasRes.error.message);
    if (cobrosRes.error) throw new Error(cobrosRes.error.message);
    const v = vueloRes.data;
    if (!v) throw new NotFoundException(`Vuelo ${vueloId} not found`);

    // Cliente: razón social si existe; degrada a nombre y a "Cliente".
    let clienteNombre = 'Cliente';
    if (v.cliente_id) {
      const { data: cli } = await sb
        .from('cliente')
        .select('nombre, razon_social_default')
        .eq('id', v.cliente_id)
        .maybeSingle();
      clienteNombre =
        ((cli?.razon_social_default as string | null) ||
          (cli?.nombre as string | null)) ??
        'Cliente';
    }

    // Ruta COMERCIAL "CUN → CZM → CUN" (misma regla que el reporte por
    // vuelo): tramos no operativos; sin ellos, todos; sin escalas, el vuelo.
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

    // Folio legible REC-<folio>-<n>: n = posición 1-based del cobro entre
    // los POSITIVOS del vuelo por created_at asc. Documento NO fiscal:
    // borrar un cobro renumera los recibos posteriores (aceptado).
    const todos = (cobrosRes.data ?? []) as Array<Record<string, unknown>>;
    const positivos = todos.filter((c) => Number(c.monto) > 0);
    const idxPositivo = positivos.findIndex(
      (c) => (c.id as string) === cobroId,
    );
    const n = idxPositivo >= 0 ? idxPositivo + 1 : positivos.length + 1;
    const folioRecibo = `REC-${String(v.folio ?? '')}-${n}`;

    // Cobrado a la fecha NETO: fuente ÚNICA cobrosEnUsd sobre TODOS los
    // cobros del vuelo (los reembolsos RESTAN — no se filtran de la suma).
    const conv = cobrosEnUsd(todos, v.tc_usd_mxn as number | null);
    const totalCotizacion = Number(v.monto_total_usd) || 0;
    const saldo = Math.max(
      0,
      Number((totalCotizacion - conv.total_usd).toFixed(2)),
    );
    // Liquidado con la tolerancia del repo; un vuelo sin precio ($0) nunca
    // se sella LIQUIDADO (trampa $0: mismo gate que refreshCobradoFlag).
    const liquidado = totalCotizacion > 0 && saldo <= TOLERANCIA_COBRO_USD;

    // Cobros MXN sin TC: fuera de la suma pero JAMÁS en silencio.
    const sinTcNota =
      conv.sin_tc_count > 0
        ? `Existen ${conv.sin_tc_count} cobro(s) en MXN por $${conv.sin_tc_mxn.toLocaleString(
            'en-US',
            { minimumFractionDigits: 2, maximumFractionDigits: 2 },
          )} MXN sin tipo de cambio registrado: no están incluidos en "Cobrado a la fecha" ni en el saldo pendiente.`
        : null;

    // TC y equivalente USD del cobro (solo MXN): el TC propio o el de la
    // cotización — misma cascada que cobrosEnUsd.
    let tcUsado: number | null = null;
    let equivalenteUsd: number | null = null;
    if (cobro.moneda === 'MXN') {
      const propio = Number(cobro.tc_usd_mxn);
      const delVuelo = Number(v.tc_usd_mxn);
      tcUsado = propio > 0 ? propio : delVuelo > 0 ? delVuelo : null;
      if (tcUsado) equivalenteUsd = Number((monto / tcUsado).toFixed(2));
    }

    // Historial: abonos POSITIVOS anteriores a este cobro + TODOS los
    // reembolsos (restan del "cobrado a la fecha" aunque sean posteriores),
    // en orden cronológico. Cada uno en su moneda nativa.
    const idxTodos = todos.findIndex((c) => (c.id as string) === cobroId);
    const previos: ReciboAbonoPdfPayload[] = todos
      .filter((c, i) => {
        const m = Number(c.monto);
        if (!Number.isFinite(m) || m === 0) return false;
        if (m < 0) return true; // reembolso: siempre visible
        return idxTodos >= 0 && i < idxTodos;
      })
      .map((c) => ({
        fecha:
          (c.fecha_cobro as string | null) ?? (c.created_at as string | null),
        monto: Number(c.monto),
        moneda: (c.moneda as string) ?? 'USD',
        etiqueta: Number(c.monto) < 0 ? 'Reembolso' : 'Abono',
      }));

    const metodoCrudo = (cobro.metodo_cobro as string | null) ?? '';
    const payload: ReciboPdfPayload = {
      folio_recibo: folioRecibo,
      cliente: clienteNombre,
      vuelo_folio: String(v.folio ?? ''),
      ruta,
      // Fechas en ISO: pyservices las formatea en hora Cancún.
      fecha_vuelo: (v.fecha_vuelo as string | null) ?? null,
      fecha_cobro:
        (cobro.fecha_cobro as string | null) ??
        (cobro.created_at as string | null),
      // BRUTO que pagó el cliente — la comisión bancaria NUNCA va al recibo.
      monto,
      moneda: (cobro.moneda as string) ?? 'USD',
      tc_usd_mxn: tcUsado,
      equivalente_usd: equivalenteUsd,
      metodo: METODO_LABELS[metodoCrudo] ?? metodoCrudo,
      cuenta_destino: (cobro.cuenta_destino as string | null) ?? null,
      referencia: (cobro.referencia as string | null) ?? null,
      total_cotizacion_usd: Number(totalCotizacion.toFixed(2)),
      cobrado_a_la_fecha_usd: conv.total_usd,
      saldo_pendiente_usd: saldo,
      liquidado,
      sin_tc_nota: sinTcNota,
      notas: (cobro.notas as string | null) ?? null,
      cobros_previos: previos,
    };
    return { payload, folioRecibo };
  }
}
