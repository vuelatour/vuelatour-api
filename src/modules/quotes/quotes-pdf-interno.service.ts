import { Injectable } from '@nestjs/common';
import { apoyosDeVuelo } from '../../common/tripulacion.util';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { FlightsService } from '../flights/flights.service';
import {
  PyservicesService,
  type CotizacionInternaPdfRequest,
} from '../pyservices/pyservices.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  armarCotizacionInternaPayload,
  type CobroInternoRow,
  type EscalaInternaRow,
  type FichaAvionInterna,
} from './quotes-pdf-interno.util';
import { QuotesService } from './quotes.service';

/** Escala con tacos, tripulación y cancelación (lo que el interno pinta por tramo). */
const ESCALA_INTERNA_COLS =
  'id, orden, origen_iata, destino_iata, aeronave_id, piloto_id, copiloto_id, pasajeros, es_ferry, es_sobrevuelo, solo_operativa, requiere_pernocta, pernocta_costo_usd, fecha_salida_plan, taco_salida, taco_llegada, taco_salida_origen, taco_llegada_origen, hora_salida, hora_llegada, revision_requerida, cancelada_at, cancelada_motivo';

const FACTURA_INTERNA_COLS =
  'id, serie, folio, uuid_fiscal, estado, total, moneda, fecha_timbrado, facturado_a_nombre, cancelada_at, created_at';

/**
 * PDF «Cotización interna» (8-sep-2026): hermano de QuotesPdfService para
 * la OFICINA — una hoja, sin fotos, con la cocina completa (comisión del
 * vendedor, horas cotizadas vs tacos, cobros con comisión bancaria y neto,
 * gastos, CFDI). NUNCA se manda al cliente.
 *
 * Aquí solo se CARGAN los insumos (cada uno desde su fuente única:
 * `quotes.findById` → snapshot canónico + fichas cotizada/operativa;
 * `flights.listCobros` → cobros con sobre y conciliado; escalas vivas con
 * tacos; gastos con su TC; facturas; nombres) y se delega el armado al
 * helper PURO `armarCotizacionInternaPayload`. Ningún query fallido degrada
 * a "sin datos": un interno con cero cobros de un vuelo pagado sería una
 * mentira numérica.
 */
@Injectable()
export class QuotesPdfInternoService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly quotes: QuotesService,
    private readonly flights: FlightsService,
    private readonly pyservices: PyservicesService,
  ) {}

  async render(
    quoteId: string,
    user: AuthenticatedUser | null,
  ): Promise<{ buffer: Buffer; folio: string }> {
    const payload = await this.payload(quoteId, user);
    const buffer = await this.pyservices.generateCotizacionInternaPdf(payload);
    return { buffer, folio: payload.folio || quoteId.slice(0, 8) };
  }

  /** Payload completo (expuesto para inspección/pruebas desde el panel). */
  async payload(
    quoteId: string,
    user: AuthenticatedUser | null,
  ): Promise<CotizacionInternaPdfRequest> {
    // findById: VUELO_COLS + escalas plan + particion_ingreso +
    // participacion_aviones + aeronave_cotizada/operativa (404 si no existe).
    const quote = (await this.quotes.findById(quoteId)) as Record<
      string,
      unknown
    >;
    const sb = this.supabase.service;

    const [
      escalasRes,
      cobros,
      gastosRes,
      facturasRes,
      clienteRes,
      creadoRes,
      apoyos,
    ] = await Promise.all([
      sb
        .from('escala')
        .select(ESCALA_INTERNA_COLS)
        .eq('vuelo_id', quoteId)
        .order('orden', { ascending: true }),
      // Fuente única de cobros por vuelo: COBRO_COLS + sobre de grupo +
      // conciliado (cobro-conciliado.util).
      this.flights.listCobros(quoteId),
      sb
        .from('gasto')
        .select('categoria, monto, moneda, tc_gasto')
        .eq('vuelo_id', quoteId),
      sb
        .from('factura')
        .select(FACTURA_INTERNA_COLS)
        .eq('vuelo_id', quoteId)
        .order('created_at', { ascending: true }),
      quote.cliente_id
        ? sb
            .from('cliente')
            .select('nombre, razon_social_default, rfc, es_broker')
            .eq('id', quote.cliente_id as string)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      // created_by no viaja en VUELO_COLS: lectura mínima aparte.
      sb.from('vuelo').select('created_by').eq('id', quoteId).maybeSingle(),
      apoyosDeVuelo(sb, quoteId),
    ]);
    for (const [nombre, res] of [
      ['escalas', escalasRes],
      ['gastos', gastosRes],
      ['facturas', facturasRes],
      ['cliente', clienteRes],
      ['vuelo', creadoRes],
    ] as const) {
      if (res.error) {
        throw new Error(
          `Cotización interna ${quoteId}: fallo al leer ${nombre}: ${res.error.message}`,
        );
      }
    }
    const escalas = (escalasRes.data ?? []) as unknown as EscalaInternaRow[];
    const creadoPorId =
      typeof creadoRes.data?.created_by === 'string'
        ? creadoRes.data.created_by
        : null;

    // Nombres (piloto/copiloto del vuelo y por tramo, apoyos, quién cotizó,
    // quién registró cada cobro) en UNA consulta.
    const userIds = [
      quote.piloto_id,
      quote.copiloto_id,
      creadoPorId,
      ...escalas.flatMap((e) => [e.piloto_id, e.copiloto_id]),
      ...apoyos.map((a) => a.usuario_id),
      ...(cobros as CobroInternoRow[]).map((c) => c.registrado_por),
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);
    const nombrePorId = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: us, error } = await sb
        .from('usuario')
        .select('id, nombre')
        .in('id', [...new Set(userIds)]);
      if (error) {
        throw new Error(
          `Cotización interna ${quoteId}: fallo al leer usuarios: ${error.message}`,
        );
      }
      for (const u of us ?? []) {
        nombrePorId.set(u.id as string, u.nombre as string);
      }
    }

    // Fichas de avión (tramos con herencia, cotizado, operativo,
    // participación multi-avión) en UNA consulta.
    const snapAeronave = (
      quote.calculo_snapshot as { aeronave?: { id?: unknown } } | null
    )?.aeronave;
    const aeronaveIds = [
      quote.aeronave_id,
      typeof snapAeronave?.id === 'string' ? snapAeronave.id : null,
      ...escalas.map((e) => e.aeronave_id),
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);
    const aeronavePorId = new Map<string, FichaAvionInterna>();
    if (aeronaveIds.length > 0) {
      const { data: avs, error } = await sb
        .from('aeronave')
        .select('id, matricula, modelo')
        .in('id', [...new Set(aeronaveIds)]);
      if (error) {
        throw new Error(
          `Cotización interna ${quoteId}: fallo al leer aeronaves: ${error.message}`,
        );
      }
      for (const a of avs ?? []) {
        aeronavePorId.set(a.id as string, {
          matricula: (a.matricula as string | null) ?? null,
          modelo: (a.modelo as string | null) ?? null,
        });
      }
    }

    return armarCotizacionInternaPayload({
      quote,
      escalas,
      cobros,
      gastos: gastosRes.data ?? [],
      facturas: facturasRes.data ?? [],
      cliente: clienteRes.data ?? null,
      nombrePorId,
      aeronavePorId,
      apoyos,
      creadoPorId,
      generadoPor: user?.nombre ?? null,
    });
  }
}
