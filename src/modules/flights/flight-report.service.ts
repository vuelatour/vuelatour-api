import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  TipoCambioService,
  type TipoCambioDetalle,
} from '../tipo-cambio/tipo-cambio.service';
import { diaCancun } from '../../common/fecha-cancun.util';
import {
  PyservicesService,
  type ReporteVueloLineaPayload,
  type ReporteVueloPayload,
} from '../pyservices/pyservices.service';
import {
  categoriaEsDeEmpresa,
  categoriaEsPagoVendedor,
  categoriaFueraDelAvion,
  etiquetaCategoriaGasto,
} from '../../common/categoria-gasto.util';
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import { horasTacoDe, sumaHorasTaco } from '../../common/horas-taco.util';
import {
  colsTacoOmitido,
  tacoOmitidoDisponible,
} from '../../common/taco-omitido-disponible.util';
import {
  esTramoOmitido,
  textoTacoOmitido,
} from '../../common/taco-omitido.util';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
// AFAC POR VUELO (16-oct-2026, invariante 90; revisión adversaria): un
// PERMISO marcado «Pago de AFAC» lo paga VuelaTour — se LISTA pero no resta
// en la economía del vuelo (como en el balance, el reparto y el Libro
// Dinero). Detrás de la sonda de la migración 20261016000005.
import {
  afacRealDisponible,
  colPagoAfac,
} from '../../common/afac-real-disponible.util';
import { esPagoAfac } from '../../common/afac-real.util';
import {
  etiquetaGastoPagoOperador,
  pagoOperadorExternoEnGastos,
} from '../../common/costo-externo.util';
import { totalMxnDeVuelo } from '../../common/tc.util';
import {
  pagoVendedorUsd,
  particionIngresoVuelo,
} from '../../common/ingreso-vuelo.util';
import {
  participacionPorAeronave,
  repartirUsd,
} from '../../common/participacion-aeronave.util';

/** Etiqueta legible de la fuente del peso del reparto multi-avión. */
function fuenteParticipacionLabel(fuente: string): string {
  switch (fuente) {
    case 'tacos':
      return 'horas reales de tacómetro';
    case 'cotizacion':
      return 'horas cotizadas por tramo';
    case 'tramos':
      return 'partes iguales por tramo';
    default:
      return 'tramos';
  }
}

/** Columnas del vuelo necesarias para el reporte (incluye el desglose de precio
 *  e iva_pct/calculo_snapshot para la partición venta avión / VuelaTour). */
const REPORTE_COLS =
  'id, folio, cliente_id, aeronave_id, piloto_id, copiloto_id, tipo, estado, es_externo, operador_externo, costo_externo_usd, origen_iata, destino_iata, pasajeros, pasajeros_nombres, fecha_vuelo, fecha_solicitud, fecha_traslado_final, monto_total_usd, monto_total_mxn, tc_usd_mxn, tarifa_tipo, tarifa_hora_usd, tiempo_cobrable_hr, subtotal_vuelo_usd, tuas_usd, iva_usd, iva_pct, viaticos_pernocta_usd, extras_total_usd, ajuste_final_usd, comision_vendedor_usd, comision_vendedor_nombre, metodo_cobro, combinado_con_id, calculo_snapshot';

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
    /**
     * T.C. oficial de respaldo del vuelo SIN T.C. en la cotización (revisión
     * del lote 2, 14-oct-2026: el K de los libros). @Optional: sin él (specs
     * armados a mano) el reporte convierte solo con el T.C. capturado, como
     * antes.
     */
    @Optional() private readonly tipoCambio?: TipoCambioService,
  ) {}

  /**
   * K DEL VUELO = el de los LIBROS (revisión del lote 2, 14-oct-2026,
   * invariante 73): el T.C. de la cotización (`tc_usd_mxn`) o, sin él, el
   * T.C. OFICIAL de referencia del día Cancún de la COTIZACIÓN
   * (`fecha_solicitud`; si no, el del vuelo) — la MISMA cadena que
   * `tcOficialPorVuelos` del balance por avión y `kComisionesDeVuelo` del
   * reparto. Antes el reporte solo tenía el capturado: en un vuelo sin él,
   * un pago al vendedor (o un gasto, o un cobro) en pesos sin T.C. propio NO
   * se restaba aquí y SÍ en los libros. Nunca lanza: sin servicio, sin
   * fecha o sin dato ⇒ null (el reporte lo avisa como siempre).
   */
  private async kOficialDeCotizacion(v: {
    fecha_solicitud?: unknown;
    fecha_vuelo?: unknown;
  }): Promise<TipoCambioDetalle | null> {
    if (!this.tipoCambio) return null;
    const str = (x: unknown): string | null =>
      typeof x === 'string' && x ? x : null;
    const fuente = str(v.fecha_solicitud) ?? str(v.fecha_vuelo);
    if (!fuente) return null;
    try {
      return await this.tipoCambio.oficialDetallePara(diaCancun(fuente));
    } catch {
      return null;
    }
  }

  async pdf(flightId: string): Promise<Buffer> {
    return this.pyservices.generateReporteVueloPdf(
      await this.buildPayload(flightId),
    );
  }

  async xlsx(flightId: string): Promise<Buffer> {
    return this.pyservices.generateReporteVueloXlsx(
      await this.buildPayload(flightId),
    );
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
    // Tacómetro omitido (invariante 79): columnas solo con la migración.
    const colsOmitido = colsTacoOmitido(await tacoOmitidoDisponible(sb));
    // Marca «Pago de AFAC» (invariante 90): solo con la migración.
    const colAfac = colPagoAfac(await afacRealDisponible(sb));

    const [
      { data: cliente },
      { data: aeronave },
      escalasRes,
      cobrosRes,
      gastosRes,
      apoyosRes,
    ] = await Promise.all([
      v.cliente_id
        ? sb
            .from('cliente')
            .select('nombre')
            .eq('id', v.cliente_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      v.aeronave_id
        ? sb
            .from('aeronave')
            .select('matricula, modelo')
            .eq('id', v.aeronave_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      sb
        .from('escala')
        .select(
          `id, orden, origen_iata, destino_iata, pasajeros, pasajeros_nombres, taco_salida, taco_llegada, solo_operativa, es_ferry, requiere_pernocta, aeronave_id, piloto_id, copiloto_id${colsOmitido}` as 'id, orden, origen_iata, destino_iata, pasajeros, pasajeros_nombres, taco_salida, taco_llegada, solo_operativa, es_ferry, requiere_pernocta, aeronave_id, piloto_id, copiloto_id',
        )
        .eq('vuelo_id', flightId)
        // Tramos cancelados fuera del reporte: no volaron (motivo visible en
        // el detalle del vuelo).
        .is('cancelada_at', null)
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
        .select(
          `id, fecha_gasto, created_at, categoria, monto, moneda, tc_gasto, litros, lugar, notas${colAfac}, proveedor:proveedor_id(nombre)` as 'id, fecha_gasto, created_at, categoria, monto, moneda, tc_gasto, litros, lugar, notas, proveedor:proveedor_id(nombre)',
        )
        .eq('vuelo_id', flightId)
        .order('fecha_gasto', { ascending: true }),
      // Tripulación de apoyo 0..N (29-ago): del vuelo y por tramo. Aditivo
      // e informativo: si falla, el reporte sale sin apoyos (no es dinero).
      sb
        .from('vuelo_apoyo')
        .select('escala_id, usuario_id, created_at')
        .eq('vuelo_id', flightId)
        .order('created_at', { ascending: true }),
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

    // Nombres de piloto/copiloto (del vuelo y por tramo) y de los apoyos.
    const apoyosRows = (
      apoyosRes.error ? [] : (apoyosRes.data ?? [])
    ) as Array<{
      escala_id: string | null;
      usuario_id: string;
      created_at?: string | null;
    }>;
    const userIds = [
      v.piloto_id,
      v.copiloto_id,
      // + quien omitió el tacómetro (invariante 79), en el MISMO lote.
      ...((escalasRes.data ?? []) as Array<Record<string, unknown>>).flatMap(
        (e) => [e.piloto_id, e.copiloto_id, e.taco_omitido_por],
      ),
      ...apoyosRows.map((a) => a.usuario_id),
    ].filter(Boolean) as string[];
    const nombrePorId = new Map<string, string>();
    if (userIds.length) {
      const { data: us } = await sb
        .from('usuario')
        .select('id, nombre')
        .in('id', userIds);
      for (const u of us ?? [])
        nombrePorId.set(u.id as string, u.nombre as string);
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

    const nombreDe = (id: unknown): string | null =>
      typeof id === 'string' && id ? (nombrePorId.get(id) ?? null) : null;
    const apoyosVuelo = apoyosRows
      .filter((a) => a.escala_id == null)
      .map((a) => nombreDe(a.usuario_id))
      .filter((x): x is string => !!x);
    const tramos = escalas.map((e, idx) => {
      const s = e.taco_salida == null ? null : n(e.taco_salida);
      const l = e.taco_llegada == null ? null : n(e.taco_llegada);
      // Tripulación por tramo (29-ago): piloto/copiloto EFECTIVOS (herencia
      // del vuelo) y apoyos efectivos (del vuelo ∪ del tramo).
      const apoyosTramo = apoyosRows
        .filter((a) => a.escala_id === (e.id as string))
        .map((a) => nombreDe(a.usuario_id))
        .filter((x): x is string => !!x && !apoyosVuelo.includes(x));
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
        horas: horasTacoDe(s, l),
        es_ferry: e.es_ferry === true,
        piloto: nombreDe(e.piloto_id) ?? nombreDe(v.piloto_id),
        copiloto: nombreDe(e.copiloto_id) ?? nombreDe(v.copiloto_id),
        apoyos: [...apoyosVuelo, ...apoyosTramo],
        // Tacómetro OMITIDO (invariante 79, ADITIVOS al final): se DICE,
        // nunca «pendiente»; `horas` sigue null (aporta 0 h).
        taco_omitido: esTramoOmitido(e),
        taco_omitido_motivo: esTramoOmitido(e)
          ? ((e.taco_omitido_motivo as string | null) ?? null)
          : null,
        taco_omitido_por_nombre: esTramoOmitido(e)
          ? nombreDe(e.taco_omitido_por)
          : null,
        taco_omitido_at: esTramoOmitido(e)
          ? ((e.taco_omitido_at as string | null) ?? null)
          : null,
      };
    });

    // Comparación pedida por el cliente: horas COTIZADAS (ruta comercial, lo
    // que pagó el cliente) vs horas VOLADAS (ruta operativa completa, según
    // tacómetros). El delta positivo es la utilidad operativa que buscan
    // maximizar (salir de otra base, pernoctar, aprovechar ferries). Las notas
    // explican el motivo del ahorro SIN captura extra: se derivan de los datos
    // que ya existen en las escalas.
    const horasCotizadas =
      v.tiempo_cobrable_hr == null ? null : n(v.tiempo_cobrable_hr);
    const horasVoladas = sumaHorasTaco(tramos.map((t) => t.horas));
    const notasHoras: string[] = [];
    const primerOrigen =
      (escalas[0]?.origen_iata as string | undefined) ?? null;
    if (primerOrigen && primerOrigen !== 'CUN') {
      notasHoras.push(
        `El avión salió de ${primerOrigen} (no de CUN): se ahorró el posicionamiento.`,
      );
    }
    for (const e of escalas) {
      if (e.requiere_pernocta === true) {
        notasHoras.push(
          `Pernoctó en ${e.destino_iata as string}: el regreso no se voló el mismo día.`,
        );
      }
    }
    const ferries = escalas.filter((e) => e.es_ferry === true).length;
    if (ferries > 0) {
      notasHoras.push(
        `${ferries} tramo${ferries === 1 ? '' : 's'} ferry (sin pasajeros) dentro del itinerario operativo.`,
      );
    }
    // Tramos con tacómetro OMITIDO (invariante 79): UNA línea por tramo con
    // quién, cuándo y por qué — sus horas no se contaron (0 h).
    for (const t of tramos) {
      if (!t.taco_omitido) continue;
      notasHoras.push(
        `Tramo ${t.orden} (${t.ruta}): ${textoTacoOmitido({
          nombre: t.taco_omitido_por_nombre,
          at: t.taco_omitido_at,
          motivo: t.taco_omitido_motivo,
        })} — sus horas no se contaron.`,
      );
    }
    if (horasCotizadas != null && horasVoladas != null) {
      const delta = Number((horasCotizadas - horasVoladas).toFixed(1));
      if (delta > 0) {
        notasHoras.push(
          `Se volaron ${delta} hrs MENOS de las cotizadas: utilidad operativa a favor.`,
        );
      } else if (delta < 0) {
        notasHoras.push(
          `Se volaron ${Math.abs(delta)} hrs MÁS de las cotizadas: revisar el itinerario.`,
        );
      }
    }

    // K del vuelo (el de los libros: capturado ?? oficial del día de la
    // cotización). TODO lo que está en pesos sin T.C. propio —cobros, sus
    // comisiones bancarias, gastos y pagos al vendedor— se convierte con él.
    const kCapturado =
      v.tc_usd_mxn != null && Number(v.tc_usd_mxn) > 0
        ? Number(v.tc_usd_mxn)
        : null;
    const kOficial =
      kCapturado == null ? await this.kOficialDeCotizacion(v) : null;
    const tcVuelo = kCapturado ?? kOficial?.tc ?? null;
    /** Cuántas partidas en pesos usaron el oficial (para su nota). */
    let usosKOficial = 0;
    if (kOficial != null) {
      usosKOficial += (cobrosRes.data ?? []).filter(
        (c) =>
          c.moneda === 'MXN' &&
          !(Number(c.tc_usd_mxn) > 0) &&
          Number(c.monto) > 0,
      ).length;
    }
    const cobros: ReporteVueloLineaPayload[] = (cobrosRes.data ?? []).map(
      (c) => ({
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
      }),
    );
    // Total cobrado por la fuente canónica: cada cobro convertido a USD con su
    // TC (o el del vuelo). Antes se sumaban MXN y USD crudos → saldos absurdos.
    const conv = cobrosEnUsd(cobrosRes.data ?? [], tcVuelo, kCapturado);
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
      tcVuelo,
      kCapturado,
    );
    const comisionesBancoUsd = comisionesConv.total_usd;

    const gastosRows = (gastosRes.data ?? []) as Array<Record<string, unknown>>;
    const proveedorNombre = (g: Record<string, unknown>): string | null => {
      const p = g.proveedor as
        | { nombre?: string }
        | { nombre?: string }[]
        | null;
      if (Array.isArray(p)) return p[0]?.nombre ?? null;
      return p?.nombre ?? null;
    };
    // EL PAGO AL OPERADOR EXTERNO ES EL GASTO REAL (16-oct-2026, invariante
    // 88; fuente única `pagoOperadorExternoEnGastos`, la MISMA del balance y
    // del reparto): si un gasto del vuelo coincide con el costo capturado
    // (±1 %), ESE gasto es el pago — el costo se cuenta UNA vez con lo
    // realmente pagado y el capturado queda como nota. Solo cubre si este
    // reporte lo cuenta (con T.C. para pasarlo a USD; si no, sigue el
    // costo capturado). CANCELADO: nunca cubre (conducta de siempre).
    const pagoOp = pagoOperadorExternoEnGastos({
      esExterno: v.es_externo === true,
      cancelado: v.estado === 'CANCELADO',
      costoUsd: v.costo_externo_usd as number | string | null,
      tcVenta: tcVuelo,
      gastos: gastosRows as Array<
        Record<string, unknown> & {
          categoria: string | null;
          moneda: string | null;
          monto: number | string | null;
        }
      >,
    });
    const cuentaEnUsd = (g: Record<string, unknown>): boolean =>
      g.moneda === 'USD' ||
      (g.tc_gasto != null && Number(g.tc_gasto) > 0) ||
      tcVuelo != null;
    const gastoPagoOperador =
      pagoOp.cubre != null && cuentaEnUsd(pagoOp.cubre) ? pagoOp.cubre : null;
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
        // Litros como dato (el Excel del equipo muestra litros y $/litro).
        litros: g.litros != null ? n(g.litros) : null,
      }));
    const gastos: ReporteVueloLineaPayload[] = gastosRows
      .filter((g) => g.categoria !== 'GAS')
      .map((g) => ({
        fecha: (g.fecha_gasto as string) ?? null,
        // Etiqueta humana homologada (fuente única categoria-gasto.util).
        concepto: etiquetaCategoriaGasto(
          (g.categoria as string | null) ?? 'OTRO',
        ),
        // El detalle incluye el DESGLOSE que compone el servidor (Operación /
        // TUA / FBO con IVA) — el cliente lo pidió explícitamente EN el
        // reporte. Se aplana a una línea para el PDF/Excel.
        detalle:
          [
            proveedorNombre(g),
            (g.notas as string | null)?.replace(/\s*\n+\s*/g, ' · ') || null,
            // LA CATEGORÍA DE EMPRESA MANDA SOBRE EL VUELO (11-sep-2026): se
            // LISTA (el dinero nunca desaparece) pero no resta en la
            // economía del vuelo — igual que en el balance y el Libro Dinero.
            categoriaEsDeEmpresa(g.categoria as string | null)
              ? 'gasto de VuelaTour — no resta al vuelo'
              : null,
            // PAGO AL VENDEDOR (28-sep-2026, invariante 31; desde el
            // 13-oct-2026, invariante 73, la ganancia resta estos gastos
            // REALES —las dos categorías— en la línea «pago al vendedor»):
            // se lista, pero no entra al costo — restarlo también como
            // gasto sería contarlo dos veces.
            categoriaEsPagoVendedor(g.categoria as string | null)
              ? 'pago al vendedor — ya descontado en «pago al vendedor» (no resta aparte)'
              : null,
            // PAGO DE AFAC (invariante 90): lo paga VuelaTour (comprobante
            // de los costos reales AFAC por vuelo del Balance general).
            esPagoAfac(
              g as { categoria?: string | null; es_pago_afac?: boolean | null },
            )
              ? 'pago de AFAC (lo paga VuelaTour) — no resta al vuelo'
              : null,
            // Invariante 88: este gasto ES el pago al operador externo.
            g === gastoPagoOperador
              ? 'pago al operador externo — cubre el costo capturado (no se suma dos veces)'
              : null,
          ]
            .filter(Boolean)
            .join(' · ') || null,
        moneda: (g.moneda as string) ?? 'MXN',
        monto: n(g.monto),
      }));

    const matricula = aeronave as {
      matricula?: string;
      modelo?: string;
    } | null;

    // TUAS ligados al reporte CON su moneda (requisito del cliente): las
    // líneas del desglose canónico del snapshot traen aeropuerto, unitario,
    // pax y moneda. Son sub-líneas INFORMATIVAS: la fila numérica "TUAS USD"
    // sigue siendo la que cuadra la suma. Vuelos viejos sin snapshot → [].
    const snap = v.calculo_snapshot as
      | Record<string, unknown>
      | null
      | undefined;
    const desgloseSnap = snap?.desglose;
    const tuasDetalle = Array.isArray(desgloseSnap)
      ? (desgloseSnap as Array<Record<string, unknown>>)
          .filter(
            (d) =>
              d.clave === 'TUAS' &&
              typeof d.concepto === 'string' &&
              d.concepto,
          )
          .map((d) => d.concepto as string)
      : [];

    // ===== Economía del vuelo (formato de los Excel de control del equipo:
    // "Balance VGV" / "Dinero <mes>") =====
    // Tacómetro global: primera salida y última llegada con lectura — SOLO de
    // los tramos volados en el avión del vuelo. Con asignación por tramo, un
    // tramo en OTRO avión tiene tacómetro propio: mezclar lecturas daría un
    // rango absurdo (fin − inicio ≠ horas). Si hay varias aeronaves, la tabla
    // por tramo sigue mostrando cada lectura.
    const escalasDelAvion = escalas.filter(
      (e) => e.aeronave_id == null || e.aeronave_id === v.aeronave_id,
    );
    const tacosSalida = escalasDelAvion
      .map((e) => (e.taco_salida == null ? null : n(e.taco_salida)))
      .filter((x): x is number => x != null);
    const tacosLlegada = escalasDelAvion
      .map((e) => (e.taco_llegada == null ? null : n(e.taco_llegada)))
      .filter((x): x is number => x != null);
    const tacoInicio = tacosSalida.length > 0 ? Math.min(...tacosSalida) : null;
    const tacoFin = tacosLlegada.length > 0 ? Math.max(...tacosLlegada) : null;

    // Gastos a USD con la MISMA regla de cobros y del Balance por avión:
    // USD directo; MXN ÷ tc_gasto; sin TC propio toma el K del vuelo de
    // RESPALDO (los gastos casi nunca traen TC capturado y el balance salía
    // sin restar nada) — desde el lote 2 (14-oct-2026) el K de los libros:
    // capturado ?? oficial del día de la cotización. Solo si tampoco hay K
    // se excluye y se reporta para que la oficina lo corrija.
    let gastosTcVueloCount = 0;
    const gastoUsd = (g: Record<string, unknown>): number | null => {
      if (g.moneda === 'USD') return n(g.monto);
      if (g.tc_gasto != null && Number(g.tc_gasto) > 0) {
        return n(g.monto) / Number(g.tc_gasto);
      }
      if (tcVuelo != null) {
        gastosTcVueloCount += 1;
        return n(g.monto) / tcVuelo;
      }
      return null;
    };
    let gastosTotalUsd = 0;
    let combustibleTotalUsd = 0;
    let gastosSinTcCount = 0;
    let gastosSinTcMxn = 0;
    for (const g of gastosRows) {
      // LA CATEGORÍA DE EMPRESA MANDA SOBRE EL VUELO (cliente, 11-sep-2026 —
      // fuente única `categoriaEsDeEmpresa`, la MISMA del Balance por avión,
      // del reparto a socios y del Libro Dinero): OTRO, NOMINA, GASOLINA,
      // FIJO y VISITA son gasto de VuelaTour aunque estén ligados al vuelo.
      // Se listan arriba (con su nota) pero NO restan en el remanente del
      // vuelo — si restaran aquí, este reporte contradiría la fila del mismo
      // vuelo en el balance, que ya los manda a la hoja "otros gastos".
      // COMISION_VENDEDOR (28-sep-2026, invariante 31) tampoco resta aquí:
      // la ganancia descuenta el pago al vendedor UNA vez, abajo (desde el
      // 13-oct-2026 el REAL de las dos categorías, invariante 73).
      if (categoriaFueraDelAvion(g.categoria as string | null)) continue;
      // PAGO DE AFAC marcado (16-oct-2026, invariante 90; decisión 4 del
      // cliente): lo paga VuelaTour — fuera del costo del vuelo, como en la
      // hoja «permisos» del balance y el grupo PERMISO del reparto (fuente
      // única `esPagoAfac`). Se lista arriba con su nota.
      if (esPagoAfac(g)) continue;
      const usd = gastoUsd(g);
      if (usd == null) {
        gastosSinTcCount += 1;
        gastosSinTcMxn += n(g.monto);
        continue;
      }
      if (g.categoria === 'GAS') combustibleTotalUsd += usd;
      else gastosTotalUsd += usd;
    }
    // Vuelo cubierto por OPERADOR EXTERNO: lo que se le paga es el costo
    // principal del vuelo — sin restarlo, el reporte pintaba el ingreso
    // completo como ganancia. `costo_externo_usd` ya está en USD (no
    // requiere TC). Se suma a los gastos del vuelo (así el balance Venta −
    // Gasolina − Gastos = REMANENTE sigue cuadrando exacto) y se pinta como
    // línea visible en la lista de gastos — SALVO que un gasto del vuelo sea
    // ese mismo pago (invariante 88, `gastoPagoOperador` arriba): entonces
    // ya restó como gasto y el costo capturado queda solo como nota.
    const costoExternoUsd = v.es_externo === true ? n(v.costo_externo_usd) : 0;
    if (v.combinado_con_id) {
      const { data: otro } = await this.supabase.service
        .from('vuelo')
        .select('folio')
        .eq('id', v.combinado_con_id as string)
        .maybeSingle();
      notasHoras.push(
        `Vuelo COMBINADO con #${(otro?.folio as number | undefined) ?? '?'} (estrategia de pernocta): los tramos ferry de ambos se cancelaron a propósito y un solo avión cubrió los dos. Los precios de ambos clientes quedaron intactos.`,
      );
    }
    if (v.es_externo === true && v.costo_externo_usd == null) {
      notasHoras.push(
        'Vuelo externo SIN costo del operador capturado: la ganancia mostrada es BRUTA (no se ha restado lo que cobra el operador).',
      );
    }
    if (costoExternoUsd > 0 && gastoPagoOperador != null) {
      // Invariante 88: el pago al operador YA está en los gastos (restó
      // arriba con lo realmente pagado); el costo capturado es solo nota.
      notasHoras.push(
        `Costo operador externo${
          v.operador_externo ? ` (${v.operador_externo as string})` : ''
        } $${costoExternoUsd.toLocaleString('en-US')} USD — cubierto por el gasto «${etiquetaGastoPagoOperador(gastoPagoOperador)}» (no se suma dos veces).`,
      );
      if (pagoOp.duplicados.length > 0) {
        notasHoras.push(
          `Vuelo externo con ${pagoOp.duplicados.length} gasto(s) más que también coinciden con el costo del operador: posible pago duplicado — verifica en Gastos (se contaría doble).`,
        );
      }
    } else if (costoExternoUsd > 0) {
      // Anti doble-conteo: si el pago al operador además se captura como
      // gasto del vuelo y NO coincide con el costo (invariante 88: si
      // coincide, el gasto lo cubre arriba), este reporte lo contaría dos
      // veces. Se AVISA cuando el externo trae gastos capturados. El pago
      // al vendedor (COMISION_VENDEDOR) no cuenta: no puede ser el pago al
      // operador.
      const gastosAviso = gastosRows.filter(
        (g) =>
          g.categoria !== 'GAS' &&
          !categoriaEsPagoVendedor(g.categoria as string | null),
      ).length;
      if (gastosAviso > 0) {
        notasHoras.push(
          `Vuelo externo con ${gastosAviso} gasto(s) capturado(s) ADEMÁS del costo del operador: verifica que el pago al operador no esté también capturado como gasto (se contaría doble).`,
        );
      }
      gastos.push({
        fecha: null,
        concepto: 'Costo operador externo',
        detalle: (v.operador_externo as string | null) || null,
        moneda: 'USD',
        monto: costoExternoUsd,
      });
      gastosTotalUsd += costoExternoUsd;
    }
    gastosTotalUsd = Number(gastosTotalUsd.toFixed(2));
    combustibleTotalUsd = Number(combustibleTotalUsd.toFixed(2));
    const costoVueloUsd = Number(
      (gastosTotalUsd + combustibleTotalUsd).toFixed(2),
    );
    if (gastosTcVueloCount > 0) {
      notasHoras.push(
        kOficial != null
          ? `${gastosTcVueloCount} gasto(s) en MXN sin T.C. propio convertidos con el T.C. oficial del día de la cotización (${tcVuelo}).`
          : `${gastosTcVueloCount} gasto(s) en MXN sin T.C. propio convertidos con el T.C. del vuelo (${tcVuelo}).`,
      );
      if (kOficial != null) usosKOficial += gastosTcVueloCount;
    }
    if (gastosSinTcCount > 0) {
      notasHoras.push(
        `${gastosSinTcCount} gasto(s) en MXN por $${gastosSinTcMxn.toLocaleString('en-US')} SIN tipo de cambio (y el vuelo no tiene T.C.): no entran al balance USD — captura su TC en Gastos.`,
      );
    }

    // Como el Excel del equipo: REMANENTE = venta (total c/IVA) − costo;
    // GANANCIA = remanente − PAGO AL VENDEDOR − comisiones bancarias;
    // GANANCIA X HR sobre horas COBRADAS (fallback voladas); % sobre venta
    // sin IVA. El pago al vendedor se resta UNA sola vez (aquí): el costo
    // del vuelo (gastos + combustible) no lo contiene — las dos categorías
    // del pago al vendedor se EXCLUYEN del costo arriba — y la venta es el
    // total del cliente, que incluye la comisión (regla 23-jul). Desde el
    // 13-oct-2026 (decisión 3 del cliente, invariante 73) el pago que se
    // resta es el REAL (los gastos de esas categorías), nunca el cotizado.
    const ventaUsd = n(v.monto_total_usd);
    const ventaSinIvaUsd = Number((ventaUsd - n(v.iva_usd)).toFixed(2));
    // Partición del ingreso (regla 6 + Regla A, 28-ago-2026): venta del
    // AVIÓN (tiempo + ajuste + su IVA) vs ingreso de VuelaTour (TUAS/extras/
    // pernocta/comisión del vendedor + su IVA). INFORMATIVA en este reporte:
    // remanente/ganancia siguen sobre la economía COMPLETA del vuelo (todo lo
    // que pagó el cliente contra todo lo que costó), pero se rotula que la
    // venta del avión ≠ total del cliente.
    const particion = particionIngresoVuelo(v);
    if (particion.vuelatour_usd > 0) {
      notasHoras.push(
        `Venta del avión $${particion.avion_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })} ≠ total del cliente $${particion.total_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}: los $${particion.vuelatour_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })} de TUAS/extras/pernocta/comisión del vendedor (con su IVA) son ingreso de VuelaTour (Otros movimientos), no del avión. El remanente y la ganancia de este reporte son de la economía completa del vuelo.`,
      );
    } else if (particion.inconsistente) {
      notasHoras.push(
        'El desglose de la cotización no cuadra con el total: no se pudo separar la venta del avión de los extras (todo el total se muestra como venta del avión). Revisa la cotización.',
      );
    }
    // REGLA B (28-ago-2026): vuelo MULTI-AVIÓN — la venta del avión se
    // reparte entre los aviones que volaron sus tramos (fuente única
    // participacionPorAeronave; centavos exactos con repartirUsd). Externos
    // no se reparten (sin avión de flota).
    const participacion =
      v.es_externo === true ? null : participacionPorAeronave(v, escalas);
    let participacionAviones: ReporteVueloPayload['participacion_aviones'];
    if (participacion?.multi_avion && particion.total_usd > 0) {
      const ids = [...participacion.factores.keys()];
      const { data: avs, error: avsErr } = await sb
        .from('aeronave')
        .select('id, matricula')
        .in('id', ids);
      if (avsErr) {
        throw new Error(
          `Reporte del vuelo ${flightId}: fallo al leer aeronaves: ${avsErr.message}`,
        );
      }
      const matriculaPorId = new Map(
        (avs ?? []).map((a) => [a.id as string, a.matricula as string]),
      );
      const partes = repartirUsd(particion.avion_usd, participacion);
      participacionAviones = ids.map((id) => ({
        aeronave_id: id,
        matricula: matriculaPorId.get(id) ?? '?',
        factor: participacion.factores.get(id) ?? 0,
        tramos: participacion.tramos_por_avion.get(id) ?? 0,
        venta_usd: partes.get(id) ?? 0,
      }));
      notasHoras.push(
        `Venta del avión repartida por ${fuenteParticipacionLabel(participacion.fuente)}: ${participacionAviones
          .map(
            (pa) =>
              `${pa.matricula} ${Math.round(pa.factor * 10000) / 100} % ($${pa.venta_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })})`,
          )
          .join(
            ' · ',
          )}. Los gastos van al avión del tramo al que están ligados; el ingreso de VuelaTour no se reparte.`,
      );
    }
    const hayEconomia = ventaUsd > 0 || costoVueloUsd > 0;
    const remanenteUsd = hayEconomia
      ? Number((ventaUsd - costoVueloUsd).toFixed(2))
      : null;
    // CANCELADO (verificación 28-ago; misma regla que el balance, el reparto
    // y "Otros movimientos"): el servicio no se prestó; el neto de VuelaTour
    // es lo retenido (cobros no reembolsados).
    const cancelado = v.estado === 'CANCELADO';
    // PAGO AL VENDEDOR = SOLO EL GASTO REAL (13-oct-2026, decisión 3 del
    // cliente «en todo: solo gastos reales», invariante 73). Hasta aquí el
    // reporte restaba el COTIZADO (`pagoVendedorUsd` = comisión + su IVA): la
    // provisión que la D3 sacó de todos los libros. Ahora resta la Σ de los
    // gastos del vuelo de las DOS categorías del pago al vendedor
    // («Comisión del vendedor (VuelaTour)» + «(avión)»; aquí no importa quién
    // lo absorbe: es la economía COMPLETA del vuelo), en TODO estado (un
    // cancelado con pago capturado también: es dinero que sí salió).
    // Conversión PURA con la MISMA regla de `gastoUsd` (USD directo; MXN ÷
    // tc_gasto > 0 o el T.C. del vuelo) — NO se llama a `gastoUsd`: su
    // efecto lateral `gastosTcVueloCount += 1` alteraría la nota de «gasto(s)
    // en MXN sin T.C. propio», que habla de los costos. Un pago en MXN sin
    // ningún T.C. NO se resta y se AVISA (jamás desaparece en silencio). Sin
    // gasto real no se resta nada: la comisión cotizada queda como dato y
    // como nota.
    const pagoCotizadoUsd = pagoVendedorUsd(particion);
    const pagosRealesVendedor = gastosRows.filter((g) =>
      categoriaEsPagoVendedor(g.categoria as string | null),
    );
    let pagoRealAcumUsd = 0;
    let pagosVendedorSinTc = 0;
    let pagosVendedorSinTcMxn = 0;
    for (const g of pagosRealesVendedor) {
      if (g.moneda === 'USD') {
        pagoRealAcumUsd += n(g.monto);
        continue;
      }
      const propio =
        g.tc_gasto != null && Number(g.tc_gasto) > 0
          ? Number(g.tc_gasto)
          : null;
      const tcg = propio ?? tcVuelo;
      if (tcg == null) {
        pagosVendedorSinTc += 1;
        pagosVendedorSinTcMxn += n(g.monto);
        continue;
      }
      if (propio == null && kOficial != null) usosKOficial += 1;
      pagoRealAcumUsd += n(g.monto) / tcg;
    }
    const pagoVendedor = Number(pagoRealAcumUsd.toFixed(2));
    const pagosConvertidos = pagosRealesVendedor.length - pagosVendedorSinTc;
    if (pagosConvertidos > 0) {
      notasHoras.push(
        cancelado
          ? `Pago real al vendedor capturado: ${fmtDineroTexto(pagoVendedor, 'USD')} en ${pagosConvertidos} gasto(s); el vuelo se canceló, pero es dinero que sí salió: la ganancia de este reporte lo resta.`
          : `Pago real al vendedor capturado: ${fmtDineroTexto(pagoVendedor, 'USD')} en ${pagosConvertidos} gasto(s); la ganancia de este reporte resta este pago real${
              pagoCotizadoUsd > 0
                ? ` (la comisión cotizada con su IVA es de ${fmtDineroTexto(pagoCotizadoUsd, 'USD')})`
                : ''
            }.`,
      );
    }
    if (pagosVendedorSinTc > 0) {
      notasHoras.push(
        `${pagosVendedorSinTc} pago(s) al vendedor en MXN por $${pagosVendedorSinTcMxn.toLocaleString('en-US')} SIN tipo de cambio (y el vuelo no tiene T.C.): no se restan de la ganancia — captura su T.C. en Gastos.`,
      );
    }
    // El K oficial NUNCA en silencio: qué T.C., de qué día y de qué fuente
    // (el MISMO que usan el balance y el reparto para este vuelo).
    if (kOficial != null && usosKOficial > 0) {
      notasHoras.push(
        `El vuelo no tiene T.C. en la cotización: lo que está en pesos sin T.C. propio (cobros, gastos y pagos al vendedor) se convirtió con el T.C. oficial de referencia del día de la cotización, ${kOficial.tc} (dato del ${kOficial.fecha_dato}, fuente ${kOficial.fuente}) — el mismo que usan el balance por avión y el reparto.`,
      );
    }
    if (pagosRealesVendedor.length === 0 && pagoCotizadoUsd > 0) {
      notasHoras.push(
        cancelado
          ? `Vuelo CANCELADO: comisión del vendedor cotizada ${fmtDineroTexto(pagoCotizadoUsd, 'USD')} sin gasto real capturado; este reporte no resta pago al vendedor y el neto de VuelaTour es lo retenido.`
          : `Comisión del vendedor cotizada ${fmtDineroTexto(pagoCotizadoUsd, 'USD')} sin gasto real capturado: la ganancia de este reporte no resta pago al vendedor (si ya se pagó, captúralo en Gastos como «Comisión del vendedor (VuelaTour)» o «Comisión del vendedor (avión)» ligado a este vuelo).`,
      );
    }
    // Con comisión cotizada o con algún pago capturado, la línea «pago al
    // vendedor» viaja SIEMPRE como número (0 explícito = no se resta nada:
    // pyservices no pinta la resta y su cascada cuadra con la ganancia).
    const conLineaVendedor =
      particion.comision_vendedor_usd > 0 || pagosRealesVendedor.length > 0;
    const gananciaFinalUsd =
      remanenteUsd != null
        ? Number((remanenteUsd - pagoVendedor - comisionesBancoUsd).toFixed(2))
        : null;
    const horasParaGanancia =
      horasCotizadas != null && horasCotizadas > 0
        ? horasCotizadas
        : horasVoladas;
    const gananciaXHrUsd =
      gananciaFinalUsd != null &&
      horasParaGanancia != null &&
      horasParaGanancia > 0
        ? Number((gananciaFinalUsd / horasParaGanancia).toFixed(2))
        : null;
    const gananciaPct =
      gananciaFinalUsd != null && ventaSinIvaUsd > 0
        ? Number((gananciaFinalUsd / ventaSinIvaUsd).toFixed(4))
        : null;

    return {
      generado: new Date().toISOString(),
      folio: v.folio != null ? String(v.folio) : flightId.slice(0, 8),
      cliente: (cliente as { nombre?: string } | null)?.nombre ?? '',
      aeronave: matricula
        ? [matricula.matricula, matricula.modelo].filter(Boolean).join(' · ')
        : null,
      piloto: v.piloto_id
        ? (nombrePorId.get(v.piloto_id as string) ?? null)
        : null,
      copiloto: v.copiloto_id
        ? (nombrePorId.get(v.copiloto_id as string) ?? null)
        : null,
      // Apoyos de nivel vuelo (29-ago, aditivo; los por tramo van en tramos[]).
      apoyos: apoyosVuelo,
      tipo: (v.tipo as string) ?? '',
      estado: (v.estado as string) ?? '',
      ruta,
      fecha_vuelo: (v.fecha_vuelo as string) ?? null,
      fecha_traslado_final: (v.fecha_traslado_final as string) ?? null,
      pasajeros: n(v.pasajeros),
      pasajeros_nombres: nombresATexto(v.pasajeros_nombres),
      tarifa_tipo: (v.tarifa_tipo as string) ?? null,
      // TARIFA: viaja COMPLETA (6 decimales desde el 22-sep-2026, invariante
      // 23) y NO se redondea a la salida, al revés que las horas de abajo.
      // Verificado en `reporte_vuelo_xlsx.py`: esta celda pasa por
      // `money_cell`, que le pone el formato `"$"#,##0.00` — Excel muestra
      // $989.58 aunque el valor sea 989.583333 — y el PDF la imprime con
      // `_money`. La celda de HORAS, en cambio, se escribe SIN formato: por
      // eso aquella sí se recorta. Este reporte nunca multiplica la tarifa
      // para componer dinero (todos los montos viajan ya calculados).
      tarifa_hora_usd: v.tarifa_hora_usd == null ? null : n(v.tarifa_hora_usd),
      // PRESENTACIÓN, no factor (22-sep-2026, invariante 22): desde que las
      // horas pactadas se persisten con 8 decimales, la celda «HORAS» del
      // Excel (`reporte_vuelo_xlsx`, que la escribe SIN formato de número)
      // mostraría «2.33333333». Este reporte nunca multiplica estas horas
      // —el dinero viaja ya calculado— así que se redondea a los 4 decimales
      // de siempre. El factor exacto vive en `vuelo.tiempo_cobrable_hr` y en
      // el snapshot.
      tiempo_cobrable_hr:
        v.tiempo_cobrable_hr == null
          ? null
          : Math.round(n(v.tiempo_cobrable_hr) * 10000) / 10000,
      subtotal_usd: n(v.subtotal_vuelo_usd),
      tuas_usd: n(v.tuas_usd),
      tuas_detalle: tuasDetalle,
      iva_usd: n(v.iva_usd),
      viaticos_pernocta_usd: n(v.viaticos_pernocta_usd),
      extras_total_usd: n(v.extras_total_usd),
      ajuste_final_usd: n(v.ajuste_final_usd),
      total_usd: n(v.monto_total_usd),
      // Informativos (regla 6): venta del AVIÓN y parte de VuelaTour; suman
      // exacto el total (cierre por diferencia en particionIngresoVuelo).
      venta_avion_usd: particion.total_usd > 0 ? particion.avion_usd : null,
      otros_ingresos_vuelatour_usd:
        particion.total_usd > 0 ? particion.vuelatour_usd : null,
      // Regla B: reparto de la venta del avión entre aviones (solo multi).
      participacion_aviones: participacionAviones,
      // Total en pesos por la FUENTE ÚNICA (17-sep-2026): se LEE el
      // `monto_total_mxn` compuesto por el motor; un vuelo sin él (externos
      // viejos) cae a usd × TC de 6 decimales en vez de quedar en blanco.
      total_mxn: totalMxnDeVuelo(v),
      tc_usd_mxn: v.tc_usd_mxn == null ? null : n(v.tc_usd_mxn),
      // Comisión del vendedor: se muestra DESPUÉS del total (regla jul 2026:
      // el total del cliente YA la incluye — se le suma al precio). Regla A
      // (28-ago tarde): es ingreso de VuelaTour que se paga al vendedor — no
      // costo del avión; este reporte (economía completa) resta ese pago
      // una vez. `comision_vendedor_usd` sigue siendo la COTIZADA (dato de la
      // cotización). Desde el 13-oct-2026 (invariante 73)
      // `pago_vendedor_usd` = el pago REAL que resta la ganancia (Σ de los
      // gastos de las dos categorías, 0 explícito sin pago capturado si la
      // cotización trae comisión; null sin comisión ni pagos) y `neto` =
      // total − ese pago (CANCELADO: lo retenido − ese pago).
      comision_vendedor_usd: n(v.comision_vendedor_usd),
      comision_vendedor_nombre:
        (v.comision_vendedor_nombre as string | null) ?? null,
      pago_vendedor_usd: conLineaVendedor ? pagoVendedor : null,
      neto_vuelatour_usd: conLineaVendedor
        ? Number(
            (
              (cancelado ? totalCobrado : particion.total_usd) - pagoVendedor
            ).toFixed(2),
          )
        : null,
      // ADITIVOS (13-oct-2026, invariante 73): el pago al vendedor de este
      // reporte es SOLO gasto real (mismo nombre que la bandera de los
      // libros, invariante 61) y la cotizada con su IVA queda como DATO
      // (jamás se resta) para que pyservices la pinte en la sección de la
      // cotización. Un pyservices previo ignora las dos.
      comision_vendedor_solo_gasto_real: true as const,
      pago_vendedor_cotizado_usd: pagoCotizadoUsd > 0 ? pagoCotizadoUsd : null,
      // Dato de la COTIZACIÓN (método previsto; desde el 11-sep-2026 también
      // "cómo se cobró al final" cuando un cobro liquidó el vuelo). El
      // método REAL de cada abono va en cada línea de `cobros`
      // (`cobro_vuelo.metodo_cobro`) — jamás se pinta el del vuelo ahí.
      metodo_cobro: (v.metodo_cobro as string) ?? null,
      tramos,
      // A 4 decimales SOLO al salir (22-sep-2026, invariante 22): esta celda
      // del Excel tampoco lleva formato de número y mostraría «2.33333333».
      // `horasCotizadas` se conserva ENTERA arriba, que es la que divide en
      // `gananciaXHrUsd` — aquí solo se pinta.
      horas_cotizadas_hr:
        horasCotizadas == null
          ? null
          : Math.round(horasCotizadas * 10000) / 10000,
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
      // Economía del vuelo (Excel del equipo).
      taco_inicio: tacoInicio,
      taco_fin: tacoFin,
      gastos_total_usd: gastosTotalUsd,
      combustible_total_usd: combustibleTotalUsd,
      gastos_sin_tc_count: gastosSinTcCount,
      gastos_sin_tc_mxn: Number(gastosSinTcMxn.toFixed(2)),
      venta_sin_iva_usd: ventaSinIvaUsd,
      remanente_usd: remanenteUsd,
      ganancia_final_usd: gananciaFinalUsd,
      ganancia_x_hr_usd: gananciaXHrUsd,
      ganancia_pct: gananciaPct,
    };
  }
}
