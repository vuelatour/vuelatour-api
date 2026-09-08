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
  type AeropuertoInternoRow,
  type CobroInternoRow,
  type EscalaInternaRow,
} from './quotes-pdf-interno.util';
import { QuotesService } from './quotes.service';

/**
 * Escala mínima: SOLO lo que fecha cada tramo cotizado (plan / fecha de
 * pared del PDF) y lo que identifica el par para el cruce con el snapshot.
 * Nada operativo (tacos, tripulación): eso vive en el reporte del vuelo.
 */
const ESCALA_INTERNA_COLS =
  'id, orden, origen_iata, destino_iata, fecha_salida_plan, pdf_fecha, solo_operativa, cancelada_at';

/**
 * PDF «Cotización interna» v2 (8-sep-2026): hermano de QuotesPdfService para
 * la OFICINA — una hoja, sin fotos, SOLO lo de la cotización (tabla de
 * tramos con nombre de ciudad, desglose canónico, TUAS cobradas, comisión
 * del vendedor con su pago, cobros con comisión bancaria y neto). NUNCA se
 * manda al cliente.
 *
 * Aquí solo se CARGAN los insumos (cada uno desde su fuente única:
 * `quotes.findById` → snapshot canónico + ficha cotizada; `flights.listCobros`
 * → cobros con sobre y conciliado; escalas mínimas para fechar tramos;
 * catálogo de aeropuertos para el nombre de ciudad; nombres) y se delega el
 * armado al helper PURO `armarCotizacionInternaPayload`. Ningún query fallido
 * degrada a "sin datos": un interno con cero cobros de un vuelo pagado sería
 * una mentira numérica.
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
    // aeronave_cotizada/operativa (404 si no existe).
    const quote = (await this.quotes.findById(quoteId)) as Record<
      string,
      unknown
    >;
    const sb = this.supabase.service;

    const [escalasRes, cobros, clienteRes, creadoRes, apoyos] =
      await Promise.all([
        sb
          .from('escala')
          .select(ESCALA_INTERNA_COLS)
          .eq('vuelo_id', quoteId)
          .order('orden', { ascending: true }),
        // Fuente única de cobros por vuelo: COBRO_COLS + sobre de grupo +
        // conciliado (cobro-conciliado.util).
        this.flights.listCobros(quoteId),
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

    // Nombres (piloto/copiloto del vuelo, apoyos, quién cotizó, quién
    // registró cada cobro) en UNA consulta.
    const userIds = [
      quote.piloto_id,
      quote.copiloto_id,
      creadoPorId,
      ...apoyos.map((a) => a.usuario_id),
      ...(cobros as CobroInternoRow[]).map((c) => c.registrado_por),
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);

    // Aeropuertos del itinerario COTIZADO (snapshot.tramos) + escalas +
    // origen/destino del vuelo: nombre de ciudad para la tabla de tramos.
    const snapTramos = (
      quote.calculo_snapshot as {
        tramos?: Array<{ origen?: unknown; destino?: unknown }> | null;
      } | null
    )?.tramos;
    const iatas = [
      ...(Array.isArray(snapTramos)
        ? snapTramos.flatMap((t) => [t?.origen, t?.destino])
        : []),
      ...escalas.flatMap((e) => [e.origen_iata, e.destino_iata]),
      quote.origen_iata,
      quote.destino_iata,
    ]
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim().toUpperCase());

    const [usuariosRes, aeropuertosRes] = await Promise.all([
      userIds.length > 0
        ? sb
            .from('usuario')
            .select('id, nombre')
            .in('id', [...new Set(userIds)])
        : Promise.resolve({ data: [], error: null }),
      iatas.length > 0
        ? sb
            .from('aeropuerto')
            .select('iata, nombre, ciudad')
            .in('iata', [...new Set(iatas)])
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (usuariosRes.error) {
      throw new Error(
        `Cotización interna ${quoteId}: fallo al leer usuarios: ${usuariosRes.error.message}`,
      );
    }
    if (aeropuertosRes.error) {
      throw new Error(
        `Cotización interna ${quoteId}: fallo al leer aeropuertos: ${aeropuertosRes.error.message}`,
      );
    }
    const nombrePorId = new Map<string, string>();
    for (const u of usuariosRes.data ?? []) {
      nombrePorId.set(u.id as string, u.nombre as string);
    }
    const aeropuertoPorIata = new Map<string, AeropuertoInternoRow>();
    for (const a of aeropuertosRes.data ?? []) {
      const iata =
        typeof a.iata === 'string' ? a.iata.trim().toUpperCase() : '';
      if (!iata) continue;
      aeropuertoPorIata.set(iata, {
        iata,
        nombre: (a.nombre as string | null) ?? null,
        ciudad: (a.ciudad as string | null) ?? null,
      });
    }

    return armarCotizacionInternaPayload({
      quote,
      escalas,
      cobros,
      cliente: clienteRes.data ?? null,
      nombrePorId,
      aeropuertoPorIata,
      apoyos,
      creadoPorId,
      generadoPor: user?.nombre ?? null,
    });
  }
}
