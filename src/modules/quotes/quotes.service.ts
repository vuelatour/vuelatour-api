import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AircraftService } from '../aircraft/aircraft.service';
import { AirportsService } from '../airports/airports.service';
import { RoutesService } from '../routes/routes.service';
import {
  PAGO_VENDEDOR_CON_IVA,
  pagoVendedorUsd,
  particionIngresoVuelo,
  type VueloIngresoInput,
} from '../../common/ingreso-vuelo.util';
import {
  participacionAvionesItems,
  participacionPorAeronave,
  type EscalaParticipacionInput,
  type FuenteParticipacion,
  type ParticipacionAvionItem,
} from '../../common/participacion-aeronave.util';
import { SupabaseService } from '../supabase/supabase.service';
import { CalendarSyncService } from '../calendar/calendar-sync.service';
import { EmailService } from '../notifications/email.service';
import { NotificationsService } from '../realtime/notifications.service';
import { tripulacionDeVuelo } from '../../common/tripulacion.util';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import { resolverCostoExterno } from '../../common/costo-externo.util';
import {
  CalculateQuoteDto,
  EscalaInputDto,
  MetodoPago,
  TipoTarifa,
  TipoVuelo,
} from './dto/calculate-quote.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { EstadoVuelo, ListQuotesQuery } from './dto/list-quotes.query';
import { QuickAdjustQuoteDto } from './dto/quick-adjust.dto';
import { ReviseQuoteDto } from './dto/revise-quote.dto';

/**
 * Tramo con sus detalles ya resueltos (defaults aplicados).
 *
 * NOTA (29-ago-2026): el modo "monto pactado por tramo" de externos sin
 * referencia se ELIMINÓ — todo vuelo externo se cotiza por el flujo NORMAL
 * (avión de referencia para tarifa/velocidad; extras/ajuste/total pactado
 * para aterrizar el precio). La columna BD `escala.monto_externo_usd` queda
 * huérfana/DEPRECADA (0 filas la usaban en prod): sin lectores ni escritores.
 */
export interface ResolvedLeg {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number;
  pasajeros: number; // ferry => 0; si no, leg.pasajeros ?? pax global
  /** Manifiesto de nombres de ESTE tramo (puede variar por escala / ir vacío). */
  pasajeros_nombres: string[];
  es_ferry: boolean;
  requiere_pernocta: boolean;
  pernocta_costo_usd: number; // 0 si no hay pernocta
  tipo_parada: 'NORMAL' | 'SERVICIO';
  servicio_notas: string | null;
  /** Nota operativa del tramo para el piloto (ej. "cargar gasolina aquí"). */
  notas: string | null;
  /** Fecha/hora planeada de salida del tramo (ISO). Null = sin definir aún. */
  fecha_salida_plan: string | null;
  /**
   * Ocultar este tramo del PDF (título/itinerario/mapa); el precio no cambia.
   * NULL = la bandera NO viajó en el DTO: `replaceEscalas` CONSERVA el valor
   * vivo de la escala (bug 1-sep "apago la visibilidad, vuelvo a entrar y
   * está activada": el editor rehidrata del snapshot y un guardado sin la
   * bandera la normalizaba a false, destapando el tramo). La bandera solo
   * cambia cuando viaja EXPLÍCITA.
   */
  pdf_oculto: boolean | null;
}

interface ResolvedRoute {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number; // total (suma para MULTIESCALA)
  es_redondo_auto: boolean;
  num_aterrizajes: number;
  ruta_id: string | null;
  escalas: ResolvedLeg[] | null; // null si es single-leg
}

/** Forma mínima de un tramo de entrada (escala de cotización o tramo de ruta). */
interface RawLeg {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number | string;
  pasajeros?: number | null;
  pasajeros_nombres?: string[] | null;
  es_ferry?: boolean | null;
  requiere_pernocta?: boolean | null;
  pernocta_costo_usd?: number | string | null;
  /** Ocultar este tramo del PDF (27-ago). */
  pdf_oculto?: boolean | null;
  tipo_parada?: string | null;
  servicio_notas?: string | null;
  notas?: string | null;
  fecha_salida_plan?: Date | string | null;
}

/** Ruta sugerida por historial del cliente (grupo de itinerarios iguales). */
export interface RutaSugerida {
  clave: string;
  etiqueta: string;
  veces: number;
  ultima_fecha: string | null;
  ruta_id: string | null;
  tramos: Array<Record<string, unknown>>;
}

export interface TuasAeropuerto {
  iata: string;
  aplica: boolean;
  /** Por pasajero en USD (canon; convertido si la línea es MXN). */
  usd_pax: number;
  /** Por pasajero NATIVO en la moneda de la línea (capturable). */
  monto_pax: number;
  moneda: 'USD' | 'MXN';
  /** TC congelado con el que se convirtió una línea MXN (null = USD puro). */
  tc_aplicado: number | null;
  razon: string;
}

const IVA_DEFAULT = 0.16;
/**
 * Elemento de `participacion_aviones` (campo ADITIVO del detalle de
 * cotización y del snapshot del vuelo; regla B 28-ago). Tipo y mapper viven
 * en la fuente única `participacion-aeronave.util` (mismo contrato que
 * antes; se re-exporta por compatibilidad).
 */
export type { ParticipacionAvionItem };

/** Prefijo del extra sintetizado por el motor para la comisión de BillPocket. */
const COMISION_BILLPOCKET_PREFIX = 'Comisión BillPocket';
const CALZOS_HR_POR_ATERRIZAJE = 0.15;
// Costo default de pernocta/viáticos por tramo (USD). Editable por tramo; confirmar
// el monto con finanzas. Se usa cuando el tramo marca pernocta sin costo explícito.
const PERNOCTA_COSTO_DEFAULT_USD = 150;

const VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, piloto_id, copiloto_id, apoyo_id, ruta_id, tipo, estado, es_externo, operador_externo, costo_externo_usd, costo_externo_monto, costo_externo_moneda, costo_externo_tc, avion_externo_modelo, avion_externo_matricula, cotizacion_version, origen_iata, destino_iata, millas_nauticas_one_way, es_redondo_auto, num_aterrizajes, pasajeros, pasajeros_nombres, pase_abordar, tiempo_cobrable_hr, tarifa_tipo, tarifa_hora_usd, subtotal_vuelo_usd, tuas_usd, iva_pct, iva_usd, monto_total_usd, viaticos_pernocta_usd, extras_total_usd, ajuste_final_usd, comision_vendedor_usd, comision_vendedor_nombre, comision_vendedor_modo, comision_vendedor_tarifa_hr, tc_usd_mxn, monto_total_mxn, metodo_cobro, metodo_cobro_detalle, pago_anticipado_req, cotizacion_abierta, pdf_mostrar_tarifa, pdf_mostrar_itinerario, itinerario_operativo, combinado_con_id, combinado:vuelo!combinado_con_id(folio), extras, estado_permiso, fecha_solicitud, fecha_vuelo, fecha_traslado_final, fecha_fin, fecha_confirmacion, fecha_cancelacion, motivo_cancelacion, google_calendar_id, facturado, cobrado, notas, notas_internas, calculo_snapshot, created_at, updated_at';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(
    private readonly aircraft: AircraftService,
    private readonly airports: AirportsService,
    private readonly routes: RoutesService,
    private readonly supabase: SupabaseService,
    private readonly calendar: CalendarSyncService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Contexto del cliente para el motor, resuelto en UNA sola lectura (embed
   * cliente → tarifa_cliente_aeronave filtrado por la aeronave):
   * - esInterno: pseudo-cliente de operación PROPIA (reposicionamiento,
   *   demostración, servicio) — sin hora mínima, tarifa default 0 y total $0
   *   válido; sus vuelos cuentan como COSTO del avión, no como venta.
   * - tarifaPreferencial: tarifa por hora pactada con el cliente para esta
   *   aeronave (USD/hr), o null si no tiene (se administra en su perfil).
   */
  private async contextoCliente(
    clienteId: string,
    aeronaveId: string,
  ): Promise<{ esInterno: boolean; tarifaPreferencial: number | null }> {
    const { data, error } = await this.supabase.service
      .from('cliente')
      .select('es_interno, tarifas:tarifa_cliente_aeronave(tarifa_hora_usd)')
      .eq('id', clienteId)
      .eq('tarifas.aeronave_id', aeronaveId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const filas = (data?.tarifas ?? []) as Array<{
      tarifa_hora_usd: number | string;
    }>;
    const tarifa = filas.length > 0 ? Number(filas[0].tarifa_hora_usd) : 0;
    return {
      esInterno: data?.es_interno === true,
      tarifaPreferencial: tarifa > 0 ? tarifa : null,
    };
  }

  /**
   * Método OTRO (manual, 18-ago-2026): exige el nombre escrito por la
   * oficina; con cualquier otro método el detalle se LIMPIA (cambiar de
   * OTRO a Transferencia no debe dejar un letrero viejo).
   */
  private resolverMetodoDetalle(dto: {
    metodo_pago: MetodoPago;
    metodo_pago_detalle?: string;
  }): string | null {
    if (dto.metodo_pago !== MetodoPago.OTRO) return null;
    const detalle = dto.metodo_pago_detalle?.trim();
    if (!detalle) {
      throw new BadRequestException(
        'Con el método "Otro" escribe cuál es (ej. PayPal, depósito en ventanilla).',
      );
    }
    return detalle;
  }

  /**
   * Pure calculation, no persistence. Returns the full breakdown.
   */
  async calculate(dto: CalculateQuoteDto) {
    // NOTA (29-ago-2026): el modo "externo sin referencia con monto pactado
    // por tramo" se ELIMINÓ. Todo vuelo — externo incluido — se cotiza por
    // el flujo NORMAL: aeronave_id es la referencia de tarifa/velocidad (en
    // externos, la ficha del avión AJENO vive en vuelo.avion_externo_*) y el
    // precio se aterriza con extras/ajuste/total pactado del canon v1.3.
    const aeronave = await this.aircraft.findById(dto.aeronave_id);
    if (!aeronave.activa) throw new BadRequestException('Aeronave inactiva');

    const route = await this.resolveRoute(dto);
    const matriculaPrefix = this.derivarMatriculaPrefix(aeronave.matricula);
    if (route.escalas) {
      // El DTO tolera millas 0 (borradores legados): la regla vive AQUÍ para
      // dar un mensaje claro — un tramo sin millas dejaría tiempo y precio
      // en 0 en silencio.
      const sinMillas = route.escalas.find((l) => !(l.millas_nauticas > 0));
      if (sinMillas) {
        throw new BadRequestException(
          `El tramo ${sinMillas.origen_iata} → ${sinMillas.destino_iata} no tiene millas náuticas: captúralas para calcular tiempo y precio.`,
        );
      }
    }

    // El "redondo automático" (×2) se eliminó: las millas son SIEMPRE la suma
    // explícita de los tramos del itinerario. resolveRoute rechaza los caminos
    // legacy que dependían de duplicar millas.
    const nmTotal = Number(route.millas_nauticas);

    const velocidadKts = Number(aeronave.velocidad_crucero_kts);
    if (!velocidadKts || velocidadKts <= 0) {
      throw new BadRequestException(
        `Aeronave ${aeronave.matricula} no tiene velocidad_crucero_kts válida`,
      );
    }
    const tiempoVueloHr = nmTotal / velocidadKts;
    const calzosHr = route.num_aterrizajes * CALZOS_HR_POR_ATERRIZAJE;
    // SOBREVUELO (ej. sobrevolar la isla 0.5 hr): tiempo extra cobrable que
    // se suma ANTES del mínimo de 1 hr.
    const sobrevueloHr = Math.max(0, Number(dto.sobrevuelo_hr) || 0);
    // CLIENTE INTERNO (jul 2026) + tarifa preferencial: UNA sola lectura.
    // Interno = pseudo-cliente de operación PROPIA ("Vuelos de
    // reposicionamiento", "Demostracion", "Servicio"): su cotización puede ir
    // en $0 total y con el tiempo real (sin hora mínima) porque no hay cobro
    // esperado — la operación (tacos/gastos) se registra normal y el vuelo
    // cuenta como COSTO del avión en su balance individual.
    const ctxCliente =
      dto.cliente_id && dto.aeronave_id
        ? await this.contextoCliente(dto.cliente_id, dto.aeronave_id)
        : { esInterno: false, tarifaPreferencial: null };
    const esInterno = ctxCliente.esInterno;

    // Hora mínima de facturación (regla del cliente, jul 2026): un vuelo corto
    // se cobra como hora completa — si el total del vuelo (tiempo + calzos)
    // queda debajo de 1 hr, se facturan 1.0 hr (0.8 → 1.0 × tarifa). Por
    // arriba de la hora se siguen cobrando las décimas reales. Cliente
    // INTERNO: sin hora mínima — se registra el tiempo REAL (puede ser 0); la
    // regla es de facturación a clientes y aquí no hay venta.
    const tiempoRealHr = tiempoVueloHr + calzosHr + sobrevueloHr;
    // COBRABLE pactado (26-ago, corrige al 25-ago): vuelo y calzos quedan
    // calculados e intocables — lo que la oficina decide a mano es la SUMA
    // final: aceptar la regla (mínimo 1 hr) o pactar otro total de horas.
    const cobrableOverride =
      dto.tiempo_cobrable_override_hr != null &&
      Number(dto.tiempo_cobrable_override_hr) > 0
        ? Number(dto.tiempo_cobrable_override_hr)
        : null;
    const cobrableRegla = esInterno ? tiempoRealHr : Math.max(1, tiempoRealHr);
    const tiempoCobrableHr = cobrableOverride ?? cobrableRegla;
    const minimoHoraAplicado =
      !esInterno && cobrableOverride == null && tiempoRealHr < 1;

    // Tarifa efectiva: override manual > tarifa preferencial pactada con el
    // cliente para ESTA aeronave > tarifa default del avión (público/broker).
    // Cliente INTERNO: default 0 sin exigir tarifa (el override sigue
    // permitiendo cobrar una operación interna excepcional).
    const tarifaPreferencial =
      dto.tarifa_hora_override_usd == null
        ? ctxCliente.tarifaPreferencial
        : null;
    const tarifaHora =
      dto.tarifa_hora_override_usd ??
      tarifaPreferencial ??
      (esInterno
        ? 0
        : dto.tipo_tarifa === TipoTarifa.PUBLICO
          ? Number(aeronave.tarifa_hora_pub_usd)
          : Number(aeronave.tarifa_hora_broker_usd));
    if (!esInterno && (!tarifaHora || tarifaHora <= 0)) {
      throw new BadRequestException(
        `Aeronave ${aeronave.matricula} no tiene tarifa ${dto.tipo_tarifa} configurada y no se proveyó tarifa_hora_override_usd`,
      );
    }
    const subtotal = tiempoCobrableHr * tarifaHora;

    // TUAS por cada aeropuerto único del itinerario (preserva orden de aparición),
    // para mostrar el desglose por aeropuerto.
    const aeropuertosOrdenados = route.escalas
      ? this.aeropuertosUnicos(route.escalas)
      : [route.origen_iata, route.destino_iata];

    // TC de la cotización: necesario para convertir líneas nativas en MXN
    // (TUAS/extras que se pagan en pesos aunque el vuelo se cotice en USD).
    const tcQuote = Number(dto.tc_usd_mxn) > 0 ? Number(dto.tc_usd_mxn) : null;
    // Línea de TUA capturada por aeropuerto (monto unitario + moneda): manda
    // sobre el catálogo y sobre el override global para ESE aeropuerto —
    // pass-through exacto de lo que el aeropuerto nos cobró.
    const lineaTua = (iata: string) =>
      (dto.tuas_lineas ?? []).find(
        (l) => l.iata.toUpperCase() === iata.toUpperCase(),
      );
    const resolveTua = async (iata: string): Promise<TuasAeropuerto> => {
      const base: TuasAeropuerto = await this.computeTuas(
        iata,
        matriculaPrefix,
        dto.pase_abordar ?? false,
        dto.tuas_override_usd_pax,
      );
      const linea = lineaTua(iata);
      if (!linea) {
        return {
          ...base,
          monto_pax: base.usd_pax,
          moneda: 'USD',
          tc_aplicado: null,
        };
      }
      if (
        linea.moneda === 'MXN' &&
        !tcQuote &&
        base.aplica &&
        linea.monto_pax > 0
      ) {
        throw new BadRequestException(
          `TUA de ${iata} capturada en MXN: captura primero el tipo de cambio (MXN por USD) de la cotización.`,
        );
      }
      if (linea.moneda === 'MXN' && !tcQuote) {
        // Línea MXN inerte (no aplica o monto 0): no exigir un TC irrelevante.
        return { ...base, monto_pax: 0, moneda: 'MXN', tc_aplicado: null };
      }
      const usdPax =
        linea.moneda === 'USD' ? linea.monto_pax : linea.monto_pax / tcQuote!;
      return {
        iata: base.iata,
        aplica: base.aplica,
        usd_pax: base.aplica ? usdPax : 0,
        monto_pax: base.aplica ? linea.monto_pax : 0,
        moneda: linea.moneda,
        tc_aplicado: linea.moneda === 'MXN' ? tcQuote : null,
        razon: `${base.razon} · monto capturado`,
      };
    };

    const tuasAeropuertos: TuasAeropuerto[] = [];
    for (const iata of aeropuertosOrdenados) {
      tuasAeropuertos.push(await resolveTua(iata));
    }
    const tuaPorIata = new Map(tuasAeropuertos.map((t) => [t.iata, t]));

    // TUAS total:
    // - MULTIESCALA: por tramo no-ferry, monto(aeropuerto de salida) × pax del tramo.
    // - REDONDO/single-leg: aeropuertos únicos × pax global (modelo histórico, sin cambio).
    // Cada FILA por aeropuerto acumula pax y totales NATIVOS: una fila MXN
    // entra al total en pesos TAL CUAL y al canon USD convertida con el TC.
    const tramosTuas: number[] = [];
    const tuasPaxPorIata = new Map<string, number>();
    // Por aeropuerto: qué tramos le cobran TUA y con cuántos pax (para
    // repartir el total de la FILA entre tramos sin descuadre de centavos).
    const tramosPorIata = new Map<
      string,
      Array<{ idx: number; pax: number }>
    >();
    if (route.escalas) {
      for (let idx = 0; idx < route.escalas.length; idx++) {
        const leg = route.escalas[idx];
        const t =
          tuaPorIata.get(leg.origen_iata) ??
          (await resolveTua(leg.origen_iata));
        const paxLeg = !leg.es_ferry && t.aplica ? leg.pasajeros : 0;
        tramosTuas.push(0);
        if (paxLeg > 0) {
          tuasPaxPorIata.set(
            t.iata,
            (tuasPaxPorIata.get(t.iata) ?? 0) + paxLeg,
          );
          const lista = tramosPorIata.get(t.iata) ?? [];
          lista.push({ idx, pax: paxLeg });
          tramosPorIata.set(t.iata, lista);
        }
      }
    } else {
      for (const t of tuasAeropuertos) {
        if (t.aplica) {
          tuasPaxPorIata.set(
            t.iata,
            (tuasPaxPorIata.get(t.iata) ?? 0) + dto.pasajeros,
          );
        }
      }
    }
    // Filas contables por aeropuerto (orden de aparición del itinerario).
    const tuasFilas = tuasAeropuertos
      .filter((t) => (tuasPaxPorIata.get(t.iata) ?? 0) > 0 && t.monto_pax > 0)
      .map((t) => {
        const pax = tuasPaxPorIata.get(t.iata)!;
        const totalNativo = round2(t.monto_pax * pax);
        const totalUsd =
          t.moneda === 'MXN' ? round2(totalNativo / tcQuote!) : totalNativo;
        return { ...t, pax, total_nativo: totalNativo, total_usd: totalUsd };
      });
    // El detalle por tramo se DERIVA de la fila (prorrateo por pax, residuo
    // al último tramo del aeropuerto): la suma por tramos cuadra EXACTA con
    // el total de TUAS — redondear tramo por tramo descuadraba ±1 centavo.
    for (const f of tuasFilas) {
      const legs = tramosPorIata.get(f.iata) ?? [];
      let asignado = 0;
      for (let i = 0; i < legs.length; i++) {
        const monto =
          i === legs.length - 1
            ? round2(f.total_usd - asignado)
            : round2((f.total_usd * legs[i].pax) / f.pax);
        tramosTuas[legs[i].idx] = monto;
        asignado = round2(asignado + monto);
      }
    }
    const tuasTotal = tuasFilas.reduce((acc, f) => acc + f.total_usd, 0);
    const tuasMxnNativo = round2(
      tuasFilas
        .filter((f) => f.moneda === 'MXN')
        .reduce((acc, f) => acc + f.total_nativo, 0),
    );
    const tuasUsdDeMxn = round2(
      tuasFilas
        .filter((f) => f.moneda === 'MXN')
        .reduce((acc, f) => acc + f.total_usd, 0),
    );

    // Pernocta / viáticos: suma de tramos con pernocta (fuera de la base de IVA).
    const viaticosPernocta = (route.escalas ?? []).reduce(
      (acc, leg) => acc + (leg.requiere_pernocta ? leg.pernocta_costo_usd : 0),
      0,
    );

    // Conceptos extra (handler, comisariato, extensión de servicios…): los
    // gravados entran a la base de IVA; los no gravados se suman al final.
    // Cada extra puede venir en USD o en MXN nativo (monto_usd = monto en la
    // moneda del renglón, nombre legado): el MXN entra al total en pesos TAL
    // CUAL y al canon USD convertido con el TC de la cotización.
    const extras = (dto.extras ?? [])
      .map((e) => {
        const moneda: 'USD' | 'MXN' = e.moneda === 'MXN' ? 'MXN' : 'USD';
        // Renglón MXN re-alimentado desde persistencia: monto_usd viene YA
        // convertido y el capturado vive en monto_nativo — preferirlo evita
        // tratar dólares como pesos al re-cotizar.
        const montoNativo = round2(
          Number(
            moneda === 'MXN' && e.monto_nativo != null
              ? e.monto_nativo
              : e.monto_usd,
          ) || 0,
        );
        if (moneda === 'MXN' && montoNativo > 0 && !tcQuote) {
          throw new BadRequestException(
            `Extra "${e.concepto}" capturado en MXN: captura primero el tipo de cambio (MXN por USD) de la cotización.`,
          );
        }
        return {
          concepto: e.concepto.trim(),
          monto_usd:
            moneda === 'MXN' ? round2(montoNativo / tcQuote!) : montoNativo,
          moneda,
          monto_nativo: montoNativo,
          tc_aplicado: moneda === 'MXN' ? tcQuote : null,
          aplica_iva: e.aplica_iva ?? true,
        };
      })
      .filter((e) => e.concepto.length > 0 && e.monto_usd > 0)
      // La comisión BillPocket la sintetiza el MOTOR (línea abajo): se
      // descarta cualquier copia persistida para no duplicarla al re-cotizar.
      .filter((e) => !e.concepto.startsWith(COMISION_BILLPOCKET_PREFIX));
    const extrasMxnNativo = round2(
      extras
        .filter((e) => e.moneda === 'MXN')
        .reduce((acc, e) => acc + e.monto_nativo, 0),
    );
    const extrasUsdDeMxn = round2(
      extras
        .filter((e) => e.moneda === 'MXN')
        .reduce((acc, e) => acc + e.monto_usd, 0),
    );
    const extrasConIva = extras
      .filter((e) => e.aplica_iva)
      .reduce((acc, e) => acc + e.monto_usd, 0);
    const extrasSinIva = extras
      .filter((e) => !e.aplica_iva)
      .reduce((acc, e) => acc + e.monto_usd, 0);

    const ivaAplicaPorMetodo =
      dto.metodo_pago === MetodoPago.TRANSFERENCIA ||
      dto.metodo_pago === MetodoPago.HSBC_LINK ||
      dto.metodo_pago === MetodoPago.CHEQUE;
    const ivaPct =
      dto.iva_pct_override !== undefined
        ? dto.iva_pct_override
        : ivaAplicaPorMetodo
          ? IVA_DEFAULT
          : 0;
    // Integridad contable (balance): cada componente se redondea PRIMERO y el
    // total es la suma exacta de los componentes redondeados — el desglose
    // siempre cuadra al centavo con el total registrado.
    const subtotalR = round2(subtotal);
    const tuasR = round2(tuasTotal);
    const extrasConIvaR = round2(extrasConIva);
    const extrasSinIvaR = round2(extrasSinIva);
    const pernoctaR = round2(viaticosPernocta);
    // Ajuste (negativo = descuento, positivo = redondeo manual) ANTES del IVA:
    // reduce la base gravable para que el descuento también baje el IVA.
    const ajusteBase = round2(Number(dto.ajuste_final_usd) || 0);

    // Comisión del VENDEDOR (Itzy/Pablo/broker) — regla nueva (jul 2026): se
    // SUMA al precio del cliente (ya NO sale del precio; el cliente siempre
    // la termina pagando). Entra al total como componente canónico PRE-IVA
    // con su propio redondeo: si la cotización lleva IVA, la comisión
    // también genera IVA (coherente con que el CFDI grava el total). El neto
    // VuelaTour (total − comisión) ahora equivale al precio base.
    // Modalidad POR_HORA: tarifa × horas cobradas, recalculada en cada
    // calculate/revise (si cambian las horas, cambia); FIJA: monto tal cual.
    const comisionVendedorModo: 'FIJA' | 'POR_HORA' =
      dto.comision_vendedor_modo === 'POR_HORA' ? 'POR_HORA' : 'FIJA';
    const comisionVendedorTarifaHr =
      comisionVendedorModo === 'POR_HORA'
        ? round2(Number(dto.comision_vendedor_tarifa_hr) || 0)
        : null;
    const comisionVendedor =
      comisionVendedorModo === 'POR_HORA'
        ? round2((comisionVendedorTarifaHr ?? 0) * tiempoCobrableHr)
        : round2(Number(dto.comision_vendedor_usd) || 0);

    // Comisión BillPocket (no factura → sin IVA): porcentaje CUSTOM que la
    // terminal cobra (5%, 9%… tope 20%). Se cobra al cliente como línea sin
    // IVA sobre todo lo demás, sintetizada como "extra" para que fluya igual
    // que cualquier concepto (desglose, PDF, reporte, balance) sin columnas
    // nuevas.
    const comisionPct =
      dto.metodo_pago === MetodoPago.BILLPOCKET
        ? Math.min(Number(dto.comision_billpocket_pct) || 0, 20)
        : 0;

    // Cadena canónica de totales EN FUNCIÓN del ajuste (mismo orden de
    // redondeo del invariante v1.3, ahora con la comisión del vendedor como
    // componente pre-IVA). Se usa para resolver el redondeo automático con
    // exactitud de centavo. El redondeo automático a $10 y el total pactado
    // siguen siendo el ÚLTIMO paso (post-IVA), después de la comisión.
    const calcTotales = (ajuste: number) => {
      const baseIva = round2(
        subtotalR + tuasR + extrasConIvaR + comisionVendedor + ajuste,
      );
      const iva = round2(baseIva * ivaPct);
      const totalSinComision = round2(
        baseIva + iva + pernoctaR + extrasSinIvaR,
      );
      const comisionR = round2((totalSinComision * comisionPct) / 100);
      const total = round2(totalSinComision + comisionR);
      return { baseIva, iva, totalSinComision, comisionR, total };
    };

    let ajusteFinal = ajusteBase;
    let tot = calcTotales(ajusteFinal);
    // REDONDEO AUTOMÁTICO (regla del cliente): el total SIEMPRE cierra hacia
    // arriba al siguiente múltiplo de $10 (976→980, 923→930, 991→1000). El
    // descuento (ajuste base) entra ANTES del IVA (lo reduce); el redondeo
    // automático se agrega DESPUÉS del IVA y de la comisión BillPocket —
    // como los conceptos sin IVA — para aterrizar EXACTO en el número
    // cerrado (la cadena redondeada por pasos no siempre puede alcanzar un
    // total arbitrario ajustando la base gravable). La línea AJUSTE del
    // desglose queda como redondeo − descuento y la suma sigue siendo exacta.
    // PRECIO PACTADO (vuelos cubiertos por externo: hay operadores más caros
    // y más económicos, el total se acuerda a mano): línea de AJUSTE directa
    // post-IVA — el MISMO mecanismo del redondeo automático — para aterrizar
    // EXACTO en lo pactado. Manda sobre el redondeo (sería redundante).
    // ELIMINADO DEL COTIZADOR (decisión del cliente, 2-sep-2026: "no tiene
    // por qué existir"): la CAPTURA manual desapareció del panel y
    // create()/revise() descartan un pactado NUEVO. Esta rama se CONSERVA
    // porque quickAdjust y la revisión del panel REHIDRATAN el pactado ya
    // persistido por este mismo campo del DTO (indistinguibles de una
    // captura manual): sin ella, los folios vivos 24/69/148 perderían su
    // total acordado al primer ajuste. NO retirarla sin migrar esos folios.
    const pactado = round2(Number(dto.total_pactado_usd) || 0);
    if (pactado > 0) {
      const extra = round2(pactado - tot.total);
      if (extra !== 0) {
        ajusteFinal = round2(ajusteFinal + extra);
        tot = { ...tot, total: pactado };
      }
    } else if (dto.redondeo_automatico) {
      const cents = Math.round(tot.total * 100);
      const targetCents = Math.ceil(cents / 1000) * 1000;
      if (targetCents > cents) {
        const extra = round2((targetCents - cents) / 100);
        ajusteFinal = round2(ajusteBase + extra);
        tot = { ...tot, total: round2(tot.total + extra) };
      }
    }

    const { baseIva, iva, comisionR } = tot;
    let extrasSinIvaRFinal = extrasSinIvaR;
    if (comisionR > 0) {
      extras.push({
        concepto: `${COMISION_BILLPOCKET_PREFIX} (${round2(comisionPct)}%)`,
        monto_usd: comisionR,
        moneda: 'USD',
        monto_nativo: comisionR,
        tc_aplicado: null,
        aplica_iva: false,
      });
      extrasSinIvaRFinal = round2(extrasSinIvaR + comisionR);
    }
    const total = tot.total;

    // Desglose canónico para el balance: cada concepto cobrado al cliente como
    // línea independiente; la suma de las líneas ES el total.
    const desglose: Array<{
      clave: string;
      concepto: string;
      monto_usd: number;
    }> = [
      {
        clave: 'TIEMPO_VUELO',
        concepto: `Tiempo de vuelo · ${round4(tiempoCobrableHr)} hr × $${round2(tarifaHora)}/hr${
          minimoHoraAplicado ? ' (mínimo 1 hr)' : ''
        }`,
        monto_usd: subtotalR,
      },
      // Una línea POR AEROPUERTO con unitario, pax y moneda (pass-through
      // auditable). La suma de filas (ya redondeadas) es exactamente tuasR.
      ...tuasFilas.map((f) => ({
        clave: 'TUAS',
        concepto:
          f.moneda === 'MXN'
            ? `TUA ${f.iata} · $${f.monto_pax.toFixed(2)} MXN × ${f.pax} pax = $${f.total_nativo.toFixed(2)} MXN`
            : `TUA ${f.iata} · $${f.monto_pax.toFixed(2)} × ${f.pax} pax`,
        monto_usd: f.total_usd,
      })),
      ...extras.map((e) => ({
        clave: 'EXTRA',
        concepto: `${e.concepto}${
          e.moneda === 'MXN' ? ` · $${e.monto_nativo.toFixed(2)} MXN` : ''
        }${e.aplica_iva ? '' : ' (sin IVA)'}`,
        monto_usd: e.monto_usd,
      })),
      // Comisión del vendedor (jul 2026): componente canónico PRE-IVA que se
      // SUMA al precio del cliente. Solo admin/balance — el PDF del cliente
      // la absorbe en el subtotal (nunca se lista ahí).
      ...(comisionVendedor > 0
        ? [
            {
              clave: 'COMISION_VENDEDOR',
              concepto: `Comisión del vendedor${
                dto.comision_vendedor_nombre?.trim()
                  ? ` (${dto.comision_vendedor_nombre.trim()})`
                  : ''
              }${
                comisionVendedorModo === 'POR_HORA'
                  ? ` · $${(comisionVendedorTarifaHr ?? 0).toFixed(2)}/hr × ${round4(tiempoCobrableHr)} hr`
                  : ''
              }`,
              monto_usd: comisionVendedor,
            },
          ]
        : []),
      // El ajuste/descuento se lista ANTES del IVA porque reduce la base gravable.
      ...(ajusteFinal !== 0
        ? [
            {
              clave: 'AJUSTE',
              concepto: ajusteFinal < 0 ? 'Descuento' : 'Redondeo',
              monto_usd: ajusteFinal,
            },
          ]
        : []),
      ...(iva > 0
        ? [
            {
              clave: 'IVA',
              concepto: `IVA ${round2(ivaPct * 100)}%`,
              monto_usd: iva,
            },
          ]
        : []),
      ...(pernoctaR > 0
        ? [
            {
              clave: 'PERNOCTA',
              concepto: 'Viáticos por pernocta (sin IVA)',
              monto_usd: pernoctaR,
            },
          ]
        : []),
    ];

    // Conservamos `origen` y `destino` siempre para retrocompat del frontend single-leg.
    // En MULTIESCALA `intermedios` lleva los demás aeropuertos.
    const tuasBlock = route.escalas
      ? {
          usd_pax_default: dto.tuas_override_usd_pax,
          pasajeros: dto.pasajeros,
          origen: tuasAeropuertos[0],
          destino: tuasAeropuertos[tuasAeropuertos.length - 1],
          intermedios: tuasAeropuertos.slice(1, -1),
          aeropuertos: tuasAeropuertos,
          // Filas CONTABLES por aeropuerto (unitario, moneda, pax, totales y
          // TC congelado): lo que se captura, se audita y se imprime.
          filas: tuasFilas,
          // Líneas CAPTURADAS tal cual (para re-alimentar revisiones/ajuste
          // rápido sin perder el pass-through).
          lineas_capturadas: dto.tuas_lineas ?? [],
          total_usd: tuasR,
          total_mxn_nativo: tuasMxnNativo,
        }
      : {
          usd_pax_default: dto.tuas_override_usd_pax,
          pasajeros: dto.pasajeros,
          origen: tuasAeropuertos[0],
          destino: tuasAeropuertos[1],
          filas: tuasFilas,
          lineas_capturadas: dto.tuas_lineas ?? [],
          total_usd: tuasR,
          total_mxn_nativo: tuasMxnNativo,
        };

    return {
      // Siempre el avión del catálogo (en externos, la REFERENCIA de tarifa;
      // la ficha del avión AJENO vive en vuelo.avion_externo_*).
      aeronave: {
        id: aeronave.id,
        matricula: aeronave.matricula,
        modelo: aeronave.modelo,
        pais_registro: aeronave.pais_registro,
        velocidad_crucero_kts: velocidadKts,
      },
      ruta: {
        id: route.ruta_id,
        origen_iata: route.origen_iata,
        destino_iata: route.destino_iata,
        millas_nauticas_base: Number(route.millas_nauticas),
        millas_nauticas_totales: round2(nmTotal),
        es_redondo_auto: route.es_redondo_auto,
        num_aterrizajes: route.num_aterrizajes,
        escalas: route.escalas,
      },
      tiempos: {
        vuelo_hr: round4(tiempoVueloHr),
        // Transparencia del cobrable pactado: lo que daría la regla y la
        // bandera viajan en el snapshot — el panel los muestra y el ajuste
        // rápido/revisión CONSERVAN el pactado (no re-derivar).
        cobrable_hr_regla: round4(cobrableRegla),
        cobrable_proviene_de_override: cobrableOverride != null,
        calzos_hr: round4(calzosHr),
        sobrevuelo_hr: round4(sobrevueloHr),
        cobrable_hr: round4(tiempoCobrableHr),
        // Vuelo corto: se facturó la hora completa (cobrable_hr = 1.0 aunque
        // el tiempo real vuelo+calzos fuera menor).
        minimo_hora_aplicado: minimoHoraAplicado,
      },
      tarifa: {
        tipo: dto.tipo_tarifa,
        usd_por_hora: round2(tarifaHora),
        // != null (no !== undefined): mismo gate que la cadena de tarifa, para
        // que un null explícito no marque override y preferencial a la vez.
        proviene_de_override: dto.tarifa_hora_override_usd != null,
        // La tarifa aplicada es la pactada con el cliente para esta aeronave.
        preferencial_cliente: tarifaPreferencial != null,
      },
      tuas: tuasBlock,
      // Desglose por tramo (null en single-leg/REDONDO simple).
      tramos: route.escalas
        ? route.escalas.map((leg, i) => ({
            orden: i + 1,
            origen: leg.origen_iata,
            destino: leg.destino_iata,
            millas: round2(leg.millas_nauticas),
            pasajeros: leg.pasajeros,
            es_ferry: leg.es_ferry,
            tiempo_hr:
              velocidadKts > 0
                ? round4(
                    leg.millas_nauticas / velocidadKts +
                      CALZOS_HR_POR_ATERRIZAJE,
                  )
                : 0,
            tuas_usd: round2(tramosTuas[i] ?? 0),
            requiere_pernocta: leg.requiere_pernocta,
            pernocta_usd: round2(leg.pernocta_costo_usd),
            tipo_parada: leg.tipo_parada,
            servicio_notas: leg.servicio_notas,
            // Puede ser NULL ("no viajó en el DTO"): el snapshot NO lo fuerza
            // a false — el PDF de todos modos prioriza la escala VIVA
            // (escalasVisiblesPdf) y null ahí cae al snapshot sin ocultar.
            pdf_oculto: leg.pdf_oculto,
          }))
        : null,
      iva: {
        aplica_por_metodo_pago: ivaAplicaPorMetodo,
        porcentaje: round4(ivaPct),
        base_usd: baseIva,
        monto_usd: iva,
        nota:
          dto.metodo_pago === MetodoPago.EFECTIVO
            ? 'Pago en efectivo: sin IVA (subtotal)'
            : ivaAplicaPorMetodo
              ? 'Pago facturable: IVA 16% sobre (subtotal + TUAS + extras gravados)'
              : `Método ${dto.metodo_pago}: sin IVA por default`,
      },
      extras: extras.length > 0 ? extras : null,
      // Desglose canónico para el balance: las líneas suman EXACTAMENTE el total.
      desglose,
      totales: {
        subtotal_vuelo_usd: subtotalR,
        tuas_total_usd: tuasR,
        viaticos_pernocta_usd: pernoctaR,
        extras_total_usd: round2(extrasConIvaR + extrasSinIvaRFinal),
        ajuste_final_usd: ajusteFinal,
        iva_usd: iva,
        total_usd: total,
        // TOTAL MXN EXACTO por composición: los componentes genuinamente USD
        // se convierten con el TC (un solo redondeo) y los renglones NATIVOS
        // en MXN entran en pesos TAL CUAL — así "vuelo USD @ TC + TUAS en
        // pesos" cuadra al centavo con lo realmente pagado. Sin renglones
        // MXN se reduce a total × tc (comportamiento histórico).
        mxn_nativos: round2(tuasMxnNativo + extrasMxnNativo),
        usd_de_mxn: round2(tuasUsdDeMxn + extrasUsdDeMxn),
        total_mxn: tcQuote
          ? round2(
              Math.round(
                (total - round2(tuasUsdDeMxn + extrasUsdDeMxn)) * tcQuote * 100,
              ) /
                100 +
                round2(tuasMxnNativo + extrasMxnNativo),
            )
          : null,
      },
      meta: {
        calculado_at: new Date().toISOString(),
        version_motor: '1.3.1',
        // CLIENTE INTERNO: trazabilidad de por qué el total puede ser $0 y no
        // corrió la hora mínima. `undefined` (no false) para que el snapshot
        // de clientes normales quede byte-idéntico (JSON omite el campo).
        cliente_interno: esInterno || undefined,
        comision_billpocket_pct: comisionPct > 0 ? round2(comisionPct) : null,
        // PRECIO PACTADO (externos): se PERSISTE para que revisiones y ajuste
        // rápido lo conserven — sin esto, cualquier recálculo posterior
        // pisaba el precio acordado en silencio. Con pactado activo, el
        // redondeo automático NO corrió (else-if): el meta lo refleja para
        // que la rehidratación no invente un "redondeo" con el delta.
        total_pactado_usd: pactado > 0 ? pactado : null,
        // Redondeo automático a número cerrado (múltiplo de $10, siempre
        // arriba): cuánto agregó el motor y el descuento base capturado —
        // permiten re-hidratar el cotizador y re-redondear en revisiones.
        redondeo_automatico:
          pactado > 0 ? false : dto.redondeo_automatico === true,
        redondeo_auto_usd:
          pactado > 0
            ? null
            : dto.redondeo_automatico === true
              ? round2(ajusteFinal - ajusteBase)
              : null,
        descuento_usd: ajusteBase < 0 ? round2(-ajusteBase) : null,
        // Comisión del VENDEDOR (jul 2026): componente canónico del total —
        // se SUMA al precio del cliente (línea COMISION_VENDEDOR del
        // desglose). El neto VuelaTour (total − comisión) equivale al precio
        // base (regla 23-jul). Para balance/reparto (regla 28-ago tarde,
        // `particionIngresoVuelo`) la comisión es INGRESO DE VUELATOUR —como
        // TUAs/extras/pernocta—, no venta del avión: los libros por avión ni
        // la cobran ni la descuentan; "Otros movimientos" la lista con su
        // pago al vendedor. Interna: nunca al PDF cliente (ahí se absorbe en
        // el subtotal). POR_HORA persiste modo+tarifa para recalcularse en
        // revisiones si cambian las horas.
        comision_vendedor_usd: comisionVendedor > 0 ? comisionVendedor : null,
        comision_vendedor_nombre:
          comisionVendedor > 0
            ? dto.comision_vendedor_nombre?.trim() || null
            : null,
        comision_vendedor_modo:
          comisionVendedor > 0 ? comisionVendedorModo : null,
        comision_vendedor_tarifa_hr:
          comisionVendedor > 0 && comisionVendedorModo === 'POR_HORA'
            ? comisionVendedorTarifaHr
            : null,
        // Neto = total − PAGO al vendedor (comisión + su IVA cuando la
        // cotización grava; misma regla que `pagoVendedorUsd`, la fuente
        // única del reporte por vuelo, Otros movimientos y el Libro Dinero).
        neto_vuelatour_usd:
          comisionVendedor > 0
            ? round2(
                total -
                  round2(
                    comisionVendedor +
                      (PAGO_VENDEDOR_CON_IVA
                        ? round2(comisionVendedor * ivaPct)
                        : 0),
                  ),
              )
            : null,
      },
    };
  }

  // ============ Persistence ============

  /**
   * Pax representativo del vuelo (para vuelo.pasajeros, que muchos lectores usan):
   * el máximo de pax entre tramos no-ferry. Si no hay tramos, usa el pax global.
   */
  private representativePax(
    breakdown: Awaited<ReturnType<QuotesService['calculate']>>,
    fallback: number,
  ): number {
    const tramos = breakdown.tramos;
    if (!tramos || tramos.length === 0) return fallback;
    const noFerry = tramos.filter((t) => !t.es_ferry).map((t) => t.pasajeros);
    return noFerry.length ? Math.max(...noFerry) : fallback;
  }

  async list(filters: ListQuotesQuery) {
    let q = this.supabase.service
      .from('vuelo')
      .select(VUELO_COLS, { count: 'exact' })
      .order('fecha_solicitud', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.cliente_id) q = q.eq('cliente_id', filters.cliente_id);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.estado) q = q.eq('estado', filters.estado);
    if (typeof filters.es_externo === 'boolean')
      q = q.eq('es_externo', filters.es_externo);
    if (filters.q) {
      // En PostgREST `.or()` las comas separan condiciones y los paréntesis
      // cierran el grupo: interpolarlos crudos rompe el parser (500) o inyecta
      // filtros. Se sustituyen por `_` (comodín de UN carácter en ilike), que
      // conserva el match ("Cancún, MX" sigue encontrando "Cancún, MX").
      const raw = filters.q.trim().replace(/[,()]/g, '_');
      const term = `%${raw.toUpperCase()}%`;
      const conds = [`origen_iata.ilike.${term}`, `destino_iata.ilike.${term}`];
      // Folio exacto si es numérico.
      if (/^\d+$/.test(raw)) conds.push(`folio.eq.${raw}`);
      // Por nombre de cliente ("¿cuánto le cobré a Punta Pájaros?").
      const { data: clientes } = await this.supabase.service
        .from('cliente')
        .select('id')
        .ilike('nombre', `%${raw}%`)
        .limit(50);
      if (clientes && clientes.length > 0) {
        conds.push(
          `cliente_id.in.(${clientes.map((c) => c.id as string).join(',')})`,
        );
      }
      // Por ciudad/nombre de aeropuerto ("Miami" → MIA/OPF/…): resuelve IATAs.
      const { data: aeropuertos } = await this.supabase.service
        .from('aeropuerto')
        .select('iata')
        .or(`ciudad.ilike.%${raw}%,nombre.ilike.%${raw}%`)
        .limit(20);
      for (const a of aeropuertos ?? []) {
        const iata = (a.iata as string)?.toUpperCase();
        if (iata) {
          conds.push(`origen_iata.eq.${iata}`, `destino_iata.eq.${iata}`);
        }
      }
      q = q.or(conds.join(','));
    }
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    // Ruta COMPLETA (origen → escalas → destino) por cotización para el listado.
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const rutas = await this.rutasIatasPorVuelo(
      rows.map((r) => r.id as string),
    );
    const dataConRuta = rows.map((r) => ({
      ...r,
      ruta_iatas:
        rutas.get(r.id as string) ??
        [r.origen_iata as string, r.destino_iata as string].filter(Boolean),
    }));
    return {
      data: dataConRuta,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /** Cadena de puntos de la ruta real (origen 1er tramo + destinos) por lote. */
  private async rutasIatasPorVuelo(
    vueloIds: string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (vueloIds.length === 0) return out;
    const { data } = await this.supabase.service
      .from('escala')
      .select('vuelo_id, orden, origen_iata, destino_iata')
      .in('vuelo_id', vueloIds)
      .eq('solo_operativa', false)
      .order('orden', { ascending: true });
    const porVuelo = new Map<string, Array<Record<string, unknown>>>();
    for (const e of data ?? []) {
      const vid = e.vuelo_id as string;
      (porVuelo.get(vid) ?? porVuelo.set(vid, []).get(vid)!).push(e);
    }
    for (const [vid, legs] of porVuelo) {
      if (legs.length === 0) continue;
      out.set(vid, [
        legs[0].origen_iata as string,
        ...legs.map((l) => l.destino_iata as string),
      ]);
    }
    return out;
  }

  async findById(id: string) {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(VUELO_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${id} not found`);
    // Adjuntar escalas plan (sin tacometros - es lo que se mostro al cotizar).
    const escalas = await this.findEscalas(id);
    // Partición del ingreso (regla 28-ago, fuente única): venta del AVIÓN
    // (tiempo + ajuste + su IVA) vs ingreso de VuelaTour (TUAs/extras/
    // pernocta/comisión del vendedor) — el panel la muestra en "Desglose
    // para balance".
    const particion = particionIngresoVuelo(
      data as unknown as VueloIngresoInput,
    );
    // PAGO AL VENDEDOR y NETO de VuelaTour — misma regla que el balance
    // ("Otros movimientos") y el reporte por vuelo (verificación 28-ago):
    // pago = comisión + su IVA (`pagoVendedorUsd`, fuente única; 0 con
    // partición inconsistente), neto = total − pago. Campos ADITIVOS en
    // `particion_ingreso` para que el panel ya no lea el
    // `meta.neto_vuelatour_usd` persistido (total − comisión pre-IVA, que
    // solo se regenera al revisar): #132 mostraba 5,491.86 contra 5,358.74
    // del reporte por vuelo. null sin comisión.
    const pagoVendedor = particion.inconsistente
      ? 0
      : pagoVendedorUsd(particion);
    const particion_ingreso = {
      ...particion,
      pago_vendedor_usd: pagoVendedor > 0 ? pagoVendedor : null,
      neto_vuelatour_usd:
        pagoVendedor > 0
          ? Math.round((particion.total_usd - pagoVendedor) * 100) / 100
          : null,
    };
    // Participación por avión (regla B 28-ago): con tramos en aviones
    // distintos, la venta del avión se reparte entre ellos. Se pasan TODAS
    // las escalas (la fuente única excluye las canceladas).
    const participacion = await this.participacionAvionesDe(
      data as unknown as {
        aeronave_id?: string | null;
        calculo_snapshot?: unknown;
      } & VueloIngresoInput,
      escalas,
    );
    return { ...data, escalas, particion_ingreso, ...participacion };
  }

  async findVersions(vueloId: string) {
    await this.findById(vueloId);
    const { data, error } = await this.supabase.service
      .from('cotizacion_version_history')
      .select('*')
      .eq('vuelo_id', vueloId)
      .order('version', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async create(dto: CreateQuoteDto, userId: string) {
    // cliente_id ahora también existe (opcional) en CalculateQuoteDto y
    // class-validator hereda ese @IsOptional: se re-valida aquí lo obligatorio.
    if (!dto.cliente_id) {
      throw new BadRequestException(
        'cliente_id es obligatorio para crear la cotización',
      );
    }
    // Vuelo CUBIERTO por operador externo: la cotización al cliente es normal
    // (el avión elegido solo da tarifa/velocidad de referencia), pero el vuelo
    // nace es_externo — sin avión propio ni tacómetros (estado manual).
    if (dto.es_externo && !dto.operador_externo?.trim()) {
      throw new BadRequestException(
        'Indica el operador externo que cubre el vuelo.',
      );
    }
    // PRECIO PACTADO eliminado del cotizador (decisión del cliente,
    // 2-sep-2026): una cotización NUEVA jamás nace con total pactado. El
    // campo del DTO subsiste SOLO como canal de rehidratación de
    // revise()/quickAdjust para folios que ya lo tenían persistido
    // (24/69/148); aquí se descarta en silencio (el panel ya no lo manda y
    // un cliente crudo del API tampoco puede colarlo).
    dto.total_pactado_usd = undefined;
    const breakdown = await this.calculate(dto);
    const reprPax = this.representativePax(breakdown, dto.pasajeros);

    // Permiso de pista: pendiente si origen/destino (o algún tramo) requiere permiso.
    const iatas = [
      breakdown.ruta.origen_iata,
      breakdown.ruta.destino_iata,
      ...(breakdown.ruta.escalas ?? []).flatMap((e) => [
        e.origen_iata,
        e.destino_iata,
      ]),
    ];
    const requierePermiso = await this.airports.anyRequiresPermit(iatas);

    // Costo del operador externo CON MONEDA (29-ago): lo capturado es
    // {monto, moneda}; costo_externo_usd se DERIVA aquí (fuente única
    // resolverCostoExterno) con el TC de la cotización como respaldo del MXN.
    const costoExterno = dto.es_externo
      ? resolverCostoExterno({
          monto: dto.costo_externo_monto ?? dto.costo_externo_usd,
          moneda: dto.costo_externo_moneda,
          tcVuelo: dto.tc_usd_mxn,
        })
      : { monto: null, moneda: null, tc: null, usd: null };

    const insertPayload = {
      cliente_id: dto.cliente_id,
      aeronave_id: dto.es_externo ? null : dto.aeronave_id,
      ruta_id: breakdown.ruta.id,
      tipo: dto.tipo ?? TipoVuelo.REDONDO,
      estado: 'COTIZADO',
      es_externo: dto.es_externo === true,
      operador_externo: dto.es_externo ? dto.operador_externo?.trim() : null,
      // Ficha del avión externo (28-ago): sale en el PDF del cliente.
      avion_externo_modelo: dto.es_externo
        ? (dto.avion_externo_modelo?.trim() ?? null)
        : null,
      avion_externo_matricula: dto.es_externo
        ? (dto.avion_externo_matricula?.trim() ?? null)
        : null,
      // null (no 0) cuando aún no se pacta: el reparto lo delata en
      // sin_costo_count — un 0 fingía utilidad = todo lo cobrado. Las 4
      // columnas se escriben JUNTAS; el usd es el DERIVADO que leen todos.
      costo_externo_usd: costoExterno.usd,
      costo_externo_monto: costoExterno.monto,
      costo_externo_moneda: costoExterno.moneda,
      costo_externo_tc: costoExterno.tc,
      cotizacion_version: 1,
      origen_iata: breakdown.ruta.origen_iata,
      destino_iata: breakdown.ruta.destino_iata,
      millas_nauticas_one_way: breakdown.ruta.millas_nauticas_base,
      es_redondo_auto: breakdown.ruta.es_redondo_auto,
      num_aterrizajes: breakdown.ruta.num_aterrizajes,
      pasajeros: reprPax,
      pasajeros_nombres: dto.pasajeros_nombres ?? [],
      pase_abordar: dto.pase_abordar ?? false,
      tiempo_cobrable_hr: breakdown.tiempos.cobrable_hr,
      tarifa_tipo: dto.tipo_tarifa,
      tarifa_hora_usd: breakdown.tarifa.usd_por_hora,
      subtotal_vuelo_usd: breakdown.totales.subtotal_vuelo_usd,
      tuas_usd: breakdown.totales.tuas_total_usd,
      iva_pct: breakdown.iva.porcentaje,
      iva_usd: breakdown.iva.monto_usd,
      monto_total_usd: breakdown.totales.total_usd,
      // TC declarado al cotizar (el pago puede entrar en pesos): habilita el
      // total MXN y sirve de respaldo para convertir cobros MXN sin TC.
      tc_usd_mxn: dto.tc_usd_mxn ?? null,
      monto_total_mxn: breakdown.totales.total_mxn ?? null,
      viaticos_pernocta_usd: breakdown.totales.viaticos_pernocta_usd,
      extras_total_usd: breakdown.totales.extras_total_usd,
      ajuste_final_usd: breakdown.totales.ajuste_final_usd,
      comision_vendedor_usd: breakdown.meta.comision_vendedor_usd ?? 0,
      comision_vendedor_nombre: breakdown.meta.comision_vendedor_nombre ?? null,
      comision_vendedor_modo: breakdown.meta.comision_vendedor_modo ?? null,
      comision_vendedor_tarifa_hr:
        breakdown.meta.comision_vendedor_tarifa_hr ?? null,
      metodo_cobro: dto.metodo_pago,
      metodo_cobro_detalle: this.resolverMetodoDetalle(dto),
      cotizacion_abierta: dto.cotizacion_abierta ?? false,
      // Presentación del PDF (27-ago): tarifa/hr apagada e itinerario
      // prendido por defecto; configurables por cotización.
      pdf_mostrar_tarifa: dto.pdf_mostrar_tarifa ?? false,
      pdf_mostrar_itinerario: dto.pdf_mostrar_itinerario ?? true,
      // Con ruta operativa: las escalas del vuelo son las del PILOTO y la
      // cotización nunca las pisa (replaceEscalas hace early-return).
      itinerario_operativo: (dto.escalas_operacion?.length ?? 0) > 0,
      extras: breakdown.extras ?? [],
      estado_permiso: requierePermiso ? 'pendiente' : 'no_aplica',
      fecha_vuelo: dto.fecha_vuelo?.toISOString(),
      fecha_traslado_final: dto.fecha_traslado_final?.toISOString(),
      notas: dto.notas,
      notas_internas: dto.notas_internas,
      calculo_snapshot: breakdown,
      created_by: userId,
      updated_by: userId,
    };

    const { data: vuelo, error } = await this.supabase.service
      .from('vuelo')
      .insert(insertPayload)
      .select(VUELO_COLS)
      .maybeSingle();

    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }

    if ((dto.escalas_operacion?.length ?? 0) > 0) {
      // Ruta OPERATIVA (mismas semánticas que la reserva del vuelo rápido):
      // ferry → solo_operativa (el piloto lo ve, el cliente no). La pernocta
      // es SOLO manual (27-ago, regla del cliente): la derivación automática
      // por salto de fecha marcaba pernoctas que nadie pidió.
      const itinerario = dto.escalas_operacion!;
      const fechaEfectiva = (i: number): Date | null =>
        itinerario[i]?.hora_salida ??
        (i === 0 ? (dto.fecha_vuelo ?? null) : null);
      const legs = itinerario.map((e, i) => {
        return {
          vuelo_id: vuelo!.id as string,
          orden: i + 1,
          origen_iata: e.origen_iata.toUpperCase(),
          destino_iata: e.destino_iata.toUpperCase(),
          // Mismo guard que el vuelo (línea del insert): un vuelo externo no
          // debe amarrar sus tramos al avión propio de referencia.
          aeronave_id: dto.es_externo ? null : (dto.aeronave_id ?? null),
          pasajeros: e.es_ferry ? 0 : (e.pasajeros ?? null),
          pasajeros_nombres: e.es_ferry ? [] : (e.pasajeros_nombres ?? []),
          es_ferry: e.es_ferry ?? false,
          es_sobrevuelo: e.es_sobrevuelo ?? false,
          solo_operativa: e.es_ferry ?? false,
          // Pernocta: SOLO la captura manual (27-ago) — sin derivación por
          // salto de fecha.
          requiere_pernocta: e.requiere_pernocta ?? false,
          tipo_parada: e.tipo_parada ?? 'NORMAL',
          servicio_notas: e.servicio_notas ?? null,
          notas: e.notas ?? null,
          fecha_salida_plan: fechaEfectiva(i)?.toISOString(),
          created_by: userId,
          updated_by: userId,
        };
      });
      const { error: legsErr } = await this.supabase.service
        .from('escala')
        .insert(legs);
      if (legsErr) {
        // COMPENSACIÓN (29-ago): jamás responder 201 con un vuelo SIN tramos
        // — parecía guardado y luego "no estaba" (calendario/asignación no lo
        // ven). Se borra el vuelo recién insertado y se lanza claro.
        await this.compensarVueloSinEscalas(vuelo!.id as string);
        throw new Error(
          `No se pudieron crear los tramos del itinerario y la cotización se descartó completa (nada quedó a medias): ${legsErr.message}. Intenta guardarla de nuevo.`,
        );
      }
    } else if (breakdown.ruta.escalas) {
      try {
        await this.replaceEscalas(vuelo!.id, breakdown.ruta.escalas, userId, {
          inicio: dto.fecha_vuelo?.toISOString() ?? null,
          fin: dto.fecha_traslado_final?.toISOString() ?? null,
        });
      } catch (err) {
        // Misma compensación: cotización sin tramos = fantasma.
        await this.compensarVueloSinEscalas(vuelo!.id as string);
        throw new Error(
          `No se pudieron crear los tramos de la cotización y se descartó completa (nada quedó a medias): ${err instanceof Error ? err.message : String(err)}. Intenta guardarla de nuevo.`,
        );
      }
    }
    // Permiso de pista POR TRAMO: el insert de arriba ya fijó el del vuelo,
    // pero cada escala se marca según SUS aeropuertos (misma fuente única que
    // usan reserva y edición de tramos).
    await this.airports.refreshPermisosDeVuelo(vuelo!.id);

    await this.appendVersionHistory(
      vuelo!.id,
      1,
      dto,
      breakdown,
      'Versión inicial',
      userId,
    );

    void this.calendar.syncFlight(vuelo!.id);
    const escalas = await this.findEscalas(vuelo!.id);
    return { ...vuelo!, escalas };
  }

  async revise(vueloId: string, dto: ReviseQuoteDto, userId: string) {
    const current = await this.findById(vueloId);
    if (current.estado === 'CANCELADO') {
      throw new ConflictException(
        'No se puede revisar una cotización cancelada.',
      );
    }
    // Vuelo de SERVICIO (regla del cliente, 27 jul 2026): mover el avión a
    // taller/mantenimiento no es un viaje del cliente — no se cotiza ni se
    // asigna a una cotización (quickAdjust queda cubierto: sin cotización
    // previa rechaza solo). Cubre el "Cotizar" de reservas y la revisión.
    await this.assertNoEsVueloDeServicio(vueloId);
    // Ventana de edición (pedido del cliente, jul 2026): la cotización —aún
    // CONFIRMADA— solo se ajusta mientras el vuelo sea del MES CORRIENTE o el
    // ANTERIOR (hora Cancún). Más atrás ya pertenece a cierres pasados y sus
    // números no se tocan. Cubre también quickAdjust y "Cotizar" reservas
    // viejas (ambos pasan por aquí). Cancún es UTC−5 fijo (sin DST).
    if (current.fecha_vuelo) {
      const ahoraCancun = new Date(Date.now() - 5 * 3_600_000);
      const inicioMesAnterior =
        Date.UTC(
          ahoraCancun.getUTCFullYear(),
          ahoraCancun.getUTCMonth() - 1,
          1,
        ) +
        5 * 3_600_000;
      if (
        new Date(current.fecha_vuelo as string).getTime() < inicioMesAnterior
      ) {
        throw new ConflictException(
          'El vuelo es de un mes ya cerrado (anterior al mes pasado): la cotización ya no puede ajustarse.',
        );
      }
    }
    // Ajustes de última hora (extras, pax/TUAs, cierre de abiertas): la
    // cotización se puede revisar en cualquier estado mientras NO se haya
    // cobrado ni facturado. Cada revisión queda versionada en el historial.
    const estadoAvanzado =
      current.estado === 'CONFIRMADO' ||
      current.estado === 'EN_VUELO' ||
      current.estado === 'COMPLETADO';
    if (estadoAvanzado && (current.cobrado || current.facturado)) {
      throw new ConflictException(
        'El vuelo ya fue cobrado/facturado; la cotización ya no puede ajustarse.',
      );
    }

    // La tarifa preferencial se resuelve SIEMPRE con el cliente real del
    // vuelo (no se confía en el que mande el front al revisar).
    dto.cliente_id = (current.cliente_id as string | null) ?? undefined;
    // Comisión del vendedor: si la revisión no trae la modalidad, se
    // re-resuelve desde lo persistido (patrón tarifa preferencial) — así una
    // comisión POR_HORA se recalcula con las horas nuevas aunque el front no
    // mande el modo. Quitar la comisión = enviar modo FIJA sin monto (o
    // POR_HORA con tarifa 0).
    if (dto.comision_vendedor_modo === undefined) {
      dto.comision_vendedor_modo =
        (current.comision_vendedor_modo as 'FIJA' | 'POR_HORA' | null) ??
        undefined;
      if (dto.comision_vendedor_tarifa_hr === undefined) {
        dto.comision_vendedor_tarifa_hr =
          Number(current.comision_vendedor_tarifa_hr) > 0
            ? Number(current.comision_vendedor_tarifa_hr)
            : undefined;
      }
    }
    // es_externo se ANCLA a lo persistido (patrón cliente_id): un front
    // malformado podía marcar externo un vuelo propio (o al revés) en
    // silencio. El revise de un externo EXIGE el avión de referencia
    // (aeronave_id) — el motor ya no tiene modo sin referencia.
    dto.es_externo = current.es_externo === true;
    // PRECIO PACTADO eliminado del cotizador (decisión del cliente,
    // 2-sep-2026): el valor del DTO solo se acepta como REHIDRATACIÓN de un
    // pactado YA persistido (el panel al revisar y quickAdjust re-envían el
    // del snapshot — no son distinguibles de una captura manual, así que se
    // ancla a lo persistido). Sin pactado vigente, se descarta: no puede
    // nacer uno nuevo por API. Omitirlo con pactado vigente SÍ lo suelta
    // (p. ej. "todo en $0" del panel), igual que antes.
    const pactadoVigente = Number(
      (
        current.calculo_snapshot as {
          meta?: { total_pactado_usd?: number | null };
        } | null
      )?.meta?.total_pactado_usd,
    );
    if (!(pactadoVigente > 0)) dto.total_pactado_usd = undefined;
    const breakdown = await this.calculate(dto);
    const reprPax = this.representativePax(breakdown, dto.pasajeros);
    const newVersion = current.cotizacion_version + 1;

    // El avión del cotizador es la REFERENCIA de tarifa. Si la operación ya
    // asignó un avión al tramo 1 (asignación por tramo), revisar el precio NO
    // lo pisa: vuelo.aeronave_id espeja la ida y la tabla de vuelos refleja
    // lo OPERACIONAL (caso vuelo #80: cotizado en XA-VGV, volado en N990GG —
    // registrar el cobro lo regresaba al avión de la cotización).
    // Primer tramo ACTIVO (vuelos combinados, 28-ago): con la ida ferry
    // cancelada, leer el orden=1 a secas rebotaba el avión del vuelo al del
    // tramo cancelado al revisar el precio.
    const { data: ida } = await this.supabase.service
      .from('escala')
      .select('aeronave_id')
      .eq('vuelo_id', vueloId)
      .is('cancelada_at', null)
      .order('orden', { ascending: true })
      .limit(1)
      .maybeSingle();
    const aeronaveOperativa =
      (ida?.aeronave_id as string | null) ?? dto.aeronave_id;

    const { data: updated, error } = await this.supabase.service
      .from('vuelo')
      .update({
        cotizacion_version: newVersion,
        tipo: dto.tipo ?? current.tipo,
        // Vuelo cubierto por externo: el avión del DTO es solo la REFERENCIA
        // de tarifa para el cálculo; el vuelo se queda sin avión propio.
        aeronave_id: current.es_externo ? null : aeronaveOperativa,
        ...(current.es_externo && dto.avion_externo_modelo !== undefined
          ? { avion_externo_modelo: dto.avion_externo_modelo?.trim() || null }
          : {}),
        ...(current.es_externo && dto.avion_externo_matricula !== undefined
          ? {
              avion_externo_matricula:
                dto.avion_externo_matricula?.trim() || null,
            }
          : {}),
        // Regla 28-ago (tarde): al cotizar/revisar un externo se capturan
        // TANTO lo que cobra el avión externo (costo, interno) COMO lo
        // pactado con el cliente — no son lo mismo. El operador solo se
        // reescribe si viene con texto; el costo se puede limpiar (null) y
        // el reparto lo delata en sin_costo_count.
        ...(current.es_externo && dto.operador_externo?.trim()
          ? { operador_externo: dto.operador_externo.trim() }
          : {}),
        ...(current.es_externo &&
        (dto.costo_externo_monto !== undefined ||
          dto.costo_externo_usd !== undefined)
          ? (() => {
              // Costo del externo CON MONEDA (29-ago): costo_externo_usd es
              // DERIVADO (fuente única resolverCostoExterno) y las 4
              // columnas viajan JUNTAS. null/0 = limpiar (las 4). TC de
              // respaldo del MXN: el de esta revisión o el ya persistido.
              const c = resolverCostoExterno({
                monto: dto.costo_externo_monto ?? dto.costo_externo_usd,
                moneda: dto.costo_externo_moneda,
                tcVuelo:
                  dto.tc_usd_mxn ??
                  (Number(current.tc_usd_mxn) > 0
                    ? Number(current.tc_usd_mxn)
                    : null),
              });
              return {
                costo_externo_usd: c.usd,
                costo_externo_monto: c.monto,
                costo_externo_moneda: c.moneda,
                costo_externo_tc: c.tc,
              };
            })()
          : {}),
        ruta_id: breakdown.ruta.id,
        origen_iata: breakdown.ruta.origen_iata,
        destino_iata: breakdown.ruta.destino_iata,
        millas_nauticas_one_way: breakdown.ruta.millas_nauticas_base,
        es_redondo_auto: breakdown.ruta.es_redondo_auto,
        num_aterrizajes: breakdown.ruta.num_aterrizajes,
        pasajeros: reprPax,
        ...(dto.fecha_vuelo !== undefined
          ? { fecha_vuelo: dto.fecha_vuelo.toISOString() }
          : {}),
        ...(dto.fecha_traslado_final !== undefined
          ? { fecha_traslado_final: dto.fecha_traslado_final.toISOString() }
          : {}),
        ...(dto.pasajeros_nombres !== undefined
          ? { pasajeros_nombres: dto.pasajeros_nombres }
          : {}),
        pase_abordar: dto.pase_abordar ?? false,
        tiempo_cobrable_hr: breakdown.tiempos.cobrable_hr,
        tarifa_tipo: dto.tipo_tarifa,
        tarifa_hora_usd: breakdown.tarifa.usd_por_hora,
        subtotal_vuelo_usd: breakdown.totales.subtotal_vuelo_usd,
        tuas_usd: breakdown.totales.tuas_total_usd,
        iva_pct: breakdown.iva.porcentaje,
        iva_usd: breakdown.iva.monto_usd,
        monto_total_usd: breakdown.totales.total_usd,
        tc_usd_mxn: dto.tc_usd_mxn ?? null,
        monto_total_mxn: breakdown.totales.total_mxn ?? null,
        viaticos_pernocta_usd: breakdown.totales.viaticos_pernocta_usd,
        extras_total_usd: breakdown.totales.extras_total_usd,
        ajuste_final_usd: breakdown.totales.ajuste_final_usd,
        comision_vendedor_usd: breakdown.meta.comision_vendedor_usd ?? 0,
        comision_vendedor_nombre:
          breakdown.meta.comision_vendedor_nombre ?? null,
        comision_vendedor_modo: breakdown.meta.comision_vendedor_modo ?? null,
        comision_vendedor_tarifa_hr:
          breakdown.meta.comision_vendedor_tarifa_hr ?? null,
        metodo_cobro: dto.metodo_pago,
        metodo_cobro_detalle: this.resolverMetodoDetalle(dto),
        notas: dto.notas ?? current.notas,
        calculo_snapshot: breakdown,
        // Cotizar una RESERVA o SOLICITUD la convierte en COTIZADO; los estados
        // avanzados (abierta) conservan su estado al ajustar el precio.
        estado:
          current.estado === 'SOLICITUD' || current.estado === 'RESERVA'
            ? 'COTIZADO'
            : current.estado,
        cotizacion_abierta:
          dto.cotizacion_abierta ?? current.cotizacion_abierta ?? false,
        pdf_mostrar_tarifa:
          dto.pdf_mostrar_tarifa ?? current.pdf_mostrar_tarifa ?? false,
        pdf_mostrar_itinerario:
          dto.pdf_mostrar_itinerario ?? current.pdf_mostrar_itinerario ?? true,
        ...(dto.extras !== undefined ? { extras: breakdown.extras ?? [] } : {}),
        updated_by: userId,
      })
      .eq('id', vueloId)
      // Candado optimista: el UPDATE solo aplica si la versión sigue siendo
      // la que se leyó y el vuelo no se facturó en medio. Dos revisiones
      // simultáneas (o revisar mientras facturación timbra) pisarían montos
      // sin dejar rastro en el historial de versiones.
      .eq('cotizacion_version', current.cotizacion_version)
      .eq('facturado', false)
      .select(VUELO_COLS)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!updated) {
      throw new ConflictException(
        'La cotización cambió mientras editabas (otra revisión o facturación). Recarga e intenta de nuevo.',
      );
    }
    const pernoctasAntes = await this.pernoctaDestinos(vueloId);
    try {
      await this.replaceEscalas(
        vueloId,
        breakdown.ruta.escalas ?? null,
        userId,
        {
          inicio:
            dto.fecha_vuelo?.toISOString() ??
            (current.fecha_vuelo as string | null) ??
            null,
          fin:
            dto.fecha_traslado_final?.toISOString() ??
            (current.fecha_traslado_final as string | null) ??
            null,
        },
      );
    } catch (err) {
      // NUNCA warn-only (auditoría 29-ago): el usuario debe saber qué quedó
      // aplicado — los MONTOS ya se escribieron (versión nueva), los TRAMOS
      // no. Reintentar "Revisar" vuelve a escribir los tramos.
      throw new Error(
        `Los montos de la cotización #${current.folio as number} YA se actualizaron (versión ${newVersion}), pero los TRAMOS no se pudieron escribir: ${err instanceof Error ? err.message : String(err)}. Vuelve a guardar la revisión para completar el itinerario.`,
      );
    }
    // Al revisar, la ruta puede ganar o perder una pista con permiso — y las
    // reservas llegan aquí con el permiso sin derivar (nacieron sin cotización).
    await this.airports.refreshPermisosDeVuelo(vueloId);
    const pernoctasDespues = await this.pernoctaDestinos(vueloId);
    void this.notifyPernoctaCambiada(updated, pernoctasAntes, pernoctasDespues);
    // Reagenda desde el cotizador (21-ago; ampliada 26-ago): fecha de salida
    // Y del REGRESO avisan a la tripulación (doc 4.3), comparando por
    // INSTANTE (el string crudo de PostgREST nunca era igual).
    const fechaTxt = (d: Date) =>
      d.toLocaleString('es-MX', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'America/Cancun',
      });
    const cambia = (nueva: Date | undefined, actual: unknown): boolean => {
      if (nueva === undefined) return false;
      if (!actual) return true;
      const t = new Date(actual as string).getTime();
      return Number.isNaN(t) || nueva.getTime() !== t;
    };
    const salidaCambio = cambia(dto.fecha_vuelo, current.fecha_vuelo);
    const regresoCambio = cambia(
      dto.fecha_traslado_final,
      current.fecha_traslado_final,
    );
    if (salidaCambio || regresoCambio) {
      const partes: string[] = [];
      if (salidaCambio) partes.push(`ahora sale ${fechaTxt(dto.fecha_vuelo!)}`);
      if (regresoCambio)
        partes.push(
          `el REGRESO ahora sale ${fechaTxt(dto.fecha_traslado_final!)}`,
        );
      void this.notificarTripulacion(updated, {
        titulo: `Vuelo #${current.folio as number} reagendado`,
        cuerpo: `${updated.origen_iata as string} → ${updated.destino_iata as string} ${partes.join(' y ')} (hora Cancún).`,
      });
    }
    // Cambio de AVIÓN al revisar (26-ago, paridad con assign): la referencia
    // operativa del cotizador puede pisar vuelo.aeronave_id sin que nadie
    // se enterara.
    if (
      !current.es_externo &&
      updated.aeronave_id &&
      updated.aeronave_id !== current.aeronave_id
    ) {
      try {
        const { data: av } = await this.supabase.service
          .from('aeronave')
          .select('matricula')
          .eq('id', updated.aeronave_id as string)
          .maybeSingle();
        void this.notificarTripulacion(updated, {
          titulo: `Vuelo #${current.folio as number}: cambio de avión`,
          cuerpo: `Ahora vuela en ${(av?.matricula as string) ?? 'otra aeronave'} (${updated.origen_iata as string} → ${updated.destino_iata as string}).`,
        });
      } catch {
        /* best-effort */
      }
    }
    try {
      await this.appendVersionHistory(
        vueloId,
        newVersion,
        dto,
        breakdown,
        dto.motivo,
        userId,
      );
    } catch (err) {
      // NUNCA warn-only (auditoría 29-ago): la revisión (montos y tramos) YA
      // quedó aplicada; solo falta el renglón del historial de versiones. El
      // mensaje dice exactamente qué quedó para que oficina no re-aplique a
      // ciegas.
      throw new Error(
        `La revisión de la cotización #${current.folio as number} SÍ quedó aplicada (versión ${newVersion}: montos y tramos), pero el HISTORIAL de versiones no se pudo escribir: ${err instanceof Error ? err.message : String(err)}. No re-captures los montos; reporta este error.`,
      );
    }
    // El precio cambió: la bandera `cobrado` se recalcula con la fuente
    // canónica (un anticipo previo puede ahora cubrir —o dejar de cubrir— el
    // total). Antes quedaba obsoleta hasta el siguiente cobro.
    await this.refreshCobradoTrasRecotizar(vueloId, updated, userId);
    // Refleja fechas/tramos nuevos en el calendario (admin lee en vivo; esto
    // mueve también los eventos de Google si el vuelo ya estaba sincronizado).
    void this.calendar.syncFlight(vueloId);
    const escalas = await this.findEscalas(vueloId);
    return { ...updated, escalas };
  }

  /**
   * Ajuste rápido desde el detalle de la cotización: extras y/o pasajeros, sin
   * rearmar el cotizador. Reconstruye el DTO de revisión desde lo persistido
   * (tramos, tarifa, método, IVA quedan idénticos) y delega en revise() — así
   * el recálculo y el versionado son los mismos de siempre.
   */
  async quickAdjust(vueloId: string, dto: QuickAdjustQuoteDto, userId: string) {
    const current = await this.findById(vueloId);
    const snapshot = current.calculo_snapshot as {
      meta?: {
        comision_billpocket_pct?: number | null;
        redondeo_automatico?: boolean | null;
        descuento_usd?: number | null;
        total_pactado_usd?: number | null;
      };
      tiempos?: {
        sobrevuelo_hr?: number | null;
        cobrable_hr?: number | null;
        cobrable_proviene_de_override?: boolean | null;
      };
      tuas?: { usd_pax_default?: number | null };
      aeronave?: { id?: string | null };
    } | null;
    const metaSnapshot = snapshot?.meta;
    if (current.estado === 'RESERVA') {
      throw new ConflictException(
        'La reserva aún no tiene precios: cotízala primero (botón Cotizar).',
      );
    }
    if (!current.aeronave_id) {
      throw new BadRequestException(
        'El vuelo no tiene aeronave asignada; usa "Revisar" para cotizar completo.',
      );
    }
    // TRAMOS PARA PRECIAR: normalmente los del vuelo (== los cotizados). Con
    // itinerario OPERATIVO las escalas son la RUTA DEL PILOTO (otra base y
    // usualmente SIN millas): re-preciar con ellas colapsaba el tiempo al
    // mínimo de 1 hr (caso #141, 18-ago-2026: 2.9065 hr → 1 hr y el total
    // cayó de $6,300 a $3,249). La ruta COMERCIAL congelada vive en
    // snapshot.ruta.escalas — con itinerario operativo se precia con ELLA;
    // replaceEscalas hace early-return en ese modo, así que los tramos del
    // piloto no se tocan.
    const esOperativo =
      (current as { itinerario_operativo?: boolean }).itinerario_operativo ===
      true;
    const rutaCotizada = (
      snapshot as {
        ruta?: { escalas?: Array<Record<string, unknown>> };
      } | null
    )?.ruta?.escalas;
    const escalas = (
      esOperativo && (rutaCotizada?.length ?? 0) > 0
        ? rutaCotizada!
        : ((current.escalas ?? []) as Array<Record<string, unknown>>)
    ) as Array<Record<string, unknown>>;
    if (escalas.length === 0) {
      throw new BadRequestException(
        'La cotización no tiene tramos registrados; usa "Revisar".',
      );
    }
    // Guarda de fiabilidad: si los tramos elegidos no traen millas pero la
    // cotización vigente SÍ cobraba horas de vuelo, el recálculo produciría
    // un total falso (mínimo 1 hr). Mejor un error claro que un precio malo.
    const millasTotal = escalas.reduce(
      (s, e) => s + (Number(e.millas_nauticas) || 0),
      0,
    );
    const sobrevueloPactado = Number(snapshot?.tiempos?.sobrevuelo_hr) || 0;
    const tiemposVigentes = (
      snapshot as {
        tiempos?: { vuelo_hr?: number | null; cobrable_hr?: number | null };
      } | null
    )?.tiempos;
    const vueloHrVigente = Number(tiemposVigentes?.vuelo_hr) || 0;
    const cobrableVigente = Number(tiemposVigentes?.cobrable_hr) || 0;
    // (a) La cotización cobraba horas POR MILLAS y los tramos ya no las
    // traen (aplica también con sobrevuelo mixto). (b) Snapshot al mínimo
    // sin base alguna (contaminado por un ajuste previo del bug): repreciar
    // perpetuaría el precio malo en silencio. Sobrevuelo PURO (vuelo_hr 0 +
    // sobrevuelo pactado) y cliente interno en 0 pasan de largo.
    const perdioMillas = millasTotal <= 0 && vueloHrVigente > 0;
    const minimoSinBase =
      millasTotal <= 0 &&
      sobrevueloPactado <= 0 &&
      vueloHrVigente <= 0 &&
      cobrableVigente > 0;
    if (perdioMillas || minimoSinBase) {
      throw new BadRequestException(
        'Los tramos con los que se cotizó ya no conservan sus millas: usa "Revisar" para recotizar la ruta comercial completa.',
      );
    }

    const oldPax = Number(current.pasajeros);
    const newPax = dto.pasajeros ?? oldPax;
    const reviseDto = {
      // AVIÓN DE REFERENCIA con el que se PACTÓ el precio (snapshot): manda
      // sobre el operativo — la velocidad de crucero y el prefijo de
      // matrícula (TUAS) del avión asignado por operación cambiarían las
      // horas/el precio en silencio. La asignación OPERATIVA no se toca:
      // revise() la protege con el espejo del tramo 1 (caso #80).
      aeronave_id: (snapshot?.aeronave?.id ?? current.aeronave_id) as string,
      tipo: TipoVuelo.MULTIESCALA,
      // Tramos tal como están persistidos. Si cambia el pax global, los tramos
      // que usaban el global anterior lo heredan (los personalizados se quedan).
      escalas: escalas.map((e) => ({
        origen_iata: e.origen_iata as string,
        destino_iata: e.destino_iata as string,
        millas_nauticas: Number(e.millas_nauticas) || 0,
        pasajeros:
          e.es_ferry === true
            ? 0
            : dto.pasajeros !== undefined && Number(e.pasajeros) === oldPax
              ? undefined
              : ((e.pasajeros as number | null) ?? undefined),
        // Preserva el manifiesto por tramo en el ajuste rápido.
        pasajeros_nombres:
          e.es_ferry === true
            ? []
            : ((e.pasajeros_nombres as string[] | null) ?? undefined),
        es_ferry: e.es_ferry === true,
        requiere_pernocta: e.requiere_pernocta === true,
        pernocta_costo_usd:
          e.pernocta_costo_usd != null
            ? Number(e.pernocta_costo_usd)
            : undefined,
        tipo_parada: (e.tipo_parada as 'NORMAL' | 'SERVICIO') ?? 'NORMAL',
        servicio_notas: (e.servicio_notas as string | null) ?? undefined,
        notas: (e.notas as string | null) ?? undefined,
        // Preservar lo que el ajuste rápido NO gestiona: sin esto el UPDATE
        // de replaceEscalas lo normalizaba a false y destapaba tramos
        // ocultos del PDF (bug 28-ago).
        pdf_oculto: e.pdf_oculto === true,
        fecha_salida_plan: e.fecha_salida_plan
          ? new Date(e.fecha_salida_plan as string)
          : undefined,
      })),
      tipo_tarifa: current.tarifa_tipo as TipoTarifa,
      pasajeros: newPax,
      pase_abordar: current.pase_abordar === true,
      metodo_pago:
        (current.metodo_cobro as MetodoPago) ?? MetodoPago.TRANSFERENCIA,
      // Método OTRO: el nombre manual pactado viaja congelado.
      metodo_pago_detalle:
        (current.metodo_cobro_detalle as string | null) ?? undefined,
      // El ajuste rápido no debe borrar el TC pactado, la comisión BillPocket
      // ni la comisión del vendedor: passthrough CONGELADO de modo + tarifa +
      // monto efectivo persistidos (el ajuste rápido no cambia tramos, así
      // que las horas — y una comisión POR_HORA — quedan idénticas).
      tc_usd_mxn:
        Number(current.tc_usd_mxn) > 0 ? Number(current.tc_usd_mxn) : undefined,
      comision_billpocket_pct:
        metaSnapshot?.comision_billpocket_pct ?? undefined,
      comision_vendedor_usd:
        Number(current.comision_vendedor_usd) > 0
          ? Number(current.comision_vendedor_usd)
          : undefined,
      comision_vendedor_modo:
        (current.comision_vendedor_modo as 'FIJA' | 'POR_HORA' | null) ??
        undefined,
      comision_vendedor_tarifa_hr:
        Number(current.comision_vendedor_tarifa_hr) > 0
          ? Number(current.comision_vendedor_tarifa_hr)
          : undefined,
      comision_vendedor_nombre:
        (current.comision_vendedor_nombre as string | null) ?? undefined,
      // Redondeo automático: se re-resuelve sobre el descuento BASE (no sobre
      // el ajuste ya redondeado) para no acumular redondeos entre revisiones.
      redondeo_automatico:
        metaSnapshot?.redondeo_automatico === true || undefined,
      cotizacion_abierta: current.cotizacion_abierta === true,
      // El sobrevuelo pactado y el override de TUAS también se conservan.
      sobrevuelo_hr:
        Number(snapshot?.tiempos?.sobrevuelo_hr) > 0
          ? Number(snapshot?.tiempos?.sobrevuelo_hr)
          : undefined,
      // El COBRABLE pactado también se conserva (si no, el ajuste rápido
      // re-aplicaría la regla y movería las horas pactadas en silencio).
      tiempo_cobrable_override_hr:
        snapshot?.tiempos?.cobrable_proviene_de_override === true &&
        Number(snapshot?.tiempos?.cobrable_hr) > 0
          ? Number(snapshot?.tiempos?.cobrable_hr)
          : undefined,
      tuas_override_usd_pax:
        snapshot?.tuas?.usd_pax_default != null
          ? Number(snapshot.tuas.usd_pax_default)
          : undefined,
      // Se conserva la economía pactada: misma tarifa/hora y mismo % de IVA.
      tarifa_hora_override_usd:
        Number(current.tarifa_hora_usd) > 0
          ? Number(current.tarifa_hora_usd)
          : undefined,
      iva_pct_override: Number(current.iva_pct),
      extras: dto.extras ?? (current.extras as never[]) ?? [],
      // Con redondeo automático, el ajuste base es SOLO el descuento (el
      // redondeo se vuelve a resolver con el total nuevo); sin él, se
      // conserva el ajuste manual tal cual. Con PRECIO PACTADO, el ajuste
      // manual previo era el delta al pactado: viaja solo el descuento y el
      // pactado re-genera su ajuste exacto (el total acordado NO se mueve).
      // (2-sep-2026: la captura manual del pactado se eliminó del cotizador;
      // este passthrough y la revisión del panel son las únicas vías vivas —
      // revise() lo ancla a lo persistido, así que este re-envío pasa.)
      ajuste_final_usd:
        metaSnapshot?.redondeo_automatico === true ||
        Number(metaSnapshot?.total_pactado_usd) > 0
          ? -(Number(metaSnapshot?.descuento_usd) || 0)
          : Number(current.ajuste_final_usd) || 0,
      total_pactado_usd:
        Number(metaSnapshot?.total_pactado_usd) > 0
          ? Number(metaSnapshot?.total_pactado_usd)
          : undefined,
      // TUAS capturadas por aeropuerto (pass-through): se conservan tal cual.
      tuas_lineas:
        (snapshot as { tuas?: { lineas_capturadas?: unknown[] } } | null)?.tuas
          ?.lineas_capturadas ?? undefined,
      motivo:
        dto.motivo?.trim() ||
        'Ajuste rápido desde el detalle (extras/pasajeros)',
    } as unknown as ReviseQuoteDto;

    // El espejo en Google Calendar viaja con revise(): su cola hace
    // `void this.calendar.syncFlight(vueloId)` tras aplicar la revisión (sin
    // early-returns antes), así que un cambio de pasajeros —que sale en el
    // summary del evento— queda sincronizado sin un segundo disparo aquí.
    return this.revise(vueloId, reviseDto, userId);
  }

  /**
   * Prende/apaga la visibilidad de UN tramo en el PDF de la cotización
   * escribiendo `escala.pdf_oculto` y NADA más: sin recálculo, sin versionar
   * y sin tocar el snapshot — presentación pura (regla 27-ago: el tramo
   * oculto se sigue cobrando) y el PDF lee la escala VIVA
   * (`escalasVisiblesPdf` prioriza `escala.pdf_oculto` sobre el snapshot).
   * Nace por el bug 1-sep ("apago la visibilidad, vuelvo a entrar y está
   * activada"): el toggle ya no depende de que un guardado del cotizador
   * arrastre la bandera — se escribe directo en la fuente de verdad.
   */
  async setPdfVisibilidad(
    vueloId: string,
    escalaId: string,
    oculto: boolean,
    userId: string,
  ): Promise<{ id: string; orden: number; pdf_oculto: boolean }> {
    // La escala debe pertenecer AL vuelo de la URL (nunca ocultar tramos de
    // otro vuelo por id suelto).
    const { data: escala, error: escErr } = await this.supabase.service
      .from('escala')
      .select('id, orden, vuelo_id')
      .eq('id', escalaId)
      .eq('vuelo_id', vueloId)
      .maybeSingle();
    if (escErr) throw new Error(`Failed to read escala: ${escErr.message}`);
    if (!escala) {
      throw new NotFoundException(
        'La escala no existe o no pertenece a este vuelo.',
      );
    }
    const { error } = await this.supabase.service
      .from('escala')
      .update({ pdf_oculto: oculto === true, updated_by: userId })
      .eq('id', escalaId);
    if (error) throw new Error(`Failed to update pdf_oculto: ${error.message}`);
    return {
      id: escala.id as string,
      orden: Number(escala.orden),
      pdf_oculto: oculto === true,
    };
  }

  async confirm(vueloId: string, userId: string) {
    const current = await this.findById(vueloId);
    if (current.estado !== 'COTIZADO') {
      throw new ConflictException(
        `Solo cotizaciones en estado COTIZADO pueden confirmarse. Estado actual: ${current.estado}`,
      );
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({
        estado: 'CONFIRMADO',
        fecha_confirmacion: new Date().toISOString(),
        updated_by: userId,
      })
      .eq('id', vueloId)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // REDONDO: crea los 2 tramos (ida + regreso) para asignarlos por separado.
    await this.ensureRedondoEscalas(data!, userId);
    void this.calendar.syncFlight(vueloId);
    void this.sendConfirmationEmail(data!);
    // Tripulación ya asignada (21-ago): el vuelo queda EN FIRME.
    void this.notificarTripulacion(data!, {
      titulo: `Vuelo #${data!.folio as number} confirmado`,
      cuerpo: `El cliente confirmó ${data!.origen_iata as string} → ${data!.destino_iata as string}${data!.fecha_vuelo ? ` del ${new Date(data!.fecha_vuelo as string).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Cancun' })}` : ''}: queda en firme.`,
    });
    return data!;
  }

  /**
   * Crea los 2 tramos de un vuelo REDONDO (ida orden=1, regreso orden=2 con IATAs
   * invertidos) para que ida y regreso se asignen por separado. Idempotente: si el
   * vuelo ya tiene escalas (MULTIESCALA, o un REDONDO ya inicializado) no hace nada.
   * El permiso de pista de cada tramo se deriva de aeropuerto.requiere_permiso.
   */
  private async ensureRedondoEscalas(
    vuelo: Record<string, unknown>,
    userId: string,
  ): Promise<void> {
    if (vuelo.tipo !== 'REDONDO') return;
    const vueloId = vuelo.id as string;
    const { count, error: cErr } = await this.supabase.service
      .from('escala')
      .select('id', { count: 'exact', head: true })
      .eq('vuelo_id', vueloId);
    if (cErr) throw new Error(cErr.message);
    if ((count ?? 0) > 0) return;

    const origen = vuelo.origen_iata as string;
    const destino = vuelo.destino_iata as string;
    const requierePermiso = await this.airports.anyRequiresPermit([
      origen,
      destino,
    ]);
    const permiso = requierePermiso ? 'pendiente' : 'no_aplica';

    const pax = Number(vuelo.pasajeros ?? 0);
    const rows = [
      {
        vuelo_id: vueloId,
        orden: 1,
        origen_iata: origen,
        destino_iata: destino,
        aeronave_id: (vuelo.aeronave_id as string | null) ?? null,
        piloto_id: (vuelo.piloto_id as string | null) ?? null,
        estado_permiso: permiso,
        fecha_salida_plan: (vuelo.fecha_vuelo as string | null) ?? null,
        pasajeros: pax,
        es_ferry: false,
        tipo_parada: 'NORMAL',
        created_by: userId,
        updated_by: userId,
      },
      {
        vuelo_id: vueloId,
        orden: 2,
        origen_iata: destino,
        destino_iata: origen,
        aeronave_id: null,
        piloto_id: null,
        estado_permiso: permiso,
        fecha_salida_plan:
          (vuelo.fecha_traslado_final as string | null) ?? null,
        // Regreso NO ferry por default (los pax suelen regresar); editable luego.
        pasajeros: pax,
        es_ferry: false,
        tipo_parada: 'NORMAL',
        created_by: userId,
        updated_by: userId,
      },
    ];
    const { error } = await this.supabase.service.from('escala').insert(rows);
    if (error)
      throw new Error(
        `No se pudieron crear los tramos del redondo: ${error.message}`,
      );
  }

  /** Envía el correo de confirmación al cliente (best-effort). */
  private async sendConfirmationEmail(
    vuelo: Record<string, unknown>,
  ): Promise<void> {
    const clienteId = vuelo.cliente_id as string | null;
    if (!clienteId) return;
    const { data: cliente } = await this.supabase.service
      .from('cliente')
      .select('nombre, email')
      .eq('id', clienteId)
      .maybeSingle();
    const email = (cliente as { email: string | null } | null)?.email;
    if (!email) return;
    void this.email.sendFlightConfirmation({
      to: email,
      clienteNombre: (cliente as { nombre: string }).nombre ?? 'Cliente',
      folio: vuelo.folio as number,
      origenIata: vuelo.origen_iata as string,
      destinoIata: vuelo.destino_iata as string,
      pasajeros: Number(vuelo.pasajeros ?? 0),
      fechaVuelo: (vuelo.fecha_vuelo as string | null) ?? null,
      montoTotalUsd: Number(vuelo.monto_total_usd ?? 0),
    });
  }

  async cancel(vueloId: string, motivo: string | undefined, userId: string) {
    const current = await this.findById(vueloId);
    if (current.estado === 'COMPLETADO' || current.estado === 'CANCELADO') {
      throw new ConflictException(
        `No se puede cancelar un vuelo en estado ${current.estado}`,
      );
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({
        estado: 'CANCELADO',
        fecha_cancelacion: new Date().toISOString(),
        motivo_cancelacion: motivo ?? null,
        updated_by: userId,
      })
      .eq('id', vueloId)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    void this.calendar.removeFlight(vueloId);
    // Tripulación completa (21-ago): cancelar desde la cotización también
    // avisa — antes este camino no notificaba a nadie.
    void this.notificarTripulacion(data!, {
      titulo: `Vuelo #${data!.folio as number} CANCELADO`,
      cuerpo: `${data!.origen_iata as string} → ${data!.destino_iata as string} se canceló${motivo ? `. Motivo: ${motivo}` : '.'}`,
      tipo: 'alerta_sistema',
    });
    return data!;
  }

  /**
   * Rutas que el cliente suele pedir, según su historial real de vuelos:
   * agrupa los itinerarios por firma (cadena de tramos), cuenta veces y
   * recencia, y devuelve el detalle de tramos del vuelo más reciente de cada
   * grupo (listo para hidratar el cotizador de un tap).
   */
  async rutasSugeridas(clienteId: string): Promise<RutaSugerida[]> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, ruta_id, fecha_vuelo, estado, escalas:escala(orden, origen_iata, destino_iata, millas_nauticas, pasajeros, es_ferry, requiere_pernocta, pernocta_costo_usd, tipo_parada, servicio_notas)',
      )
      .eq('cliente_id', clienteId)
      .neq('estado', 'CANCELADO')
      .eq('es_externo', false)
      .order('fecha_vuelo', { ascending: false, nullsFirst: false })
      .limit(60);
    if (error) throw new Error(error.message);

    interface LegRow {
      orden: number;
      origen_iata: string;
      destino_iata: string;
      millas_nauticas: number | string | null;
      pasajeros: number | null;
      es_ferry: boolean | null;
      requiere_pernocta: boolean | null;
      pernocta_costo_usd: number | string | null;
      tipo_parada: string | null;
      servicio_notas: string | null;
    }

    const grupos = new Map<string, RutaSugerida>();
    for (const v of data ?? []) {
      const legs = (v.escalas ?? []).slice().sort((a, b) => a.orden - b.orden);
      if (legs.length === 0) continue;
      // Solo se sugieren rutas con MILLAS en TODOS los tramos (27-ago):
      // aplicar una sugerencia con millas en 0 dejaba el tiempo (y el
      // precio) sin calcular y la oficina no entendía por qué.
      if (legs.some((l) => !(Number(l.millas_nauticas) > 0))) continue;
      const clave = legs
        .map((l) => `${l.origen_iata}-${l.destino_iata}`)
        .join('|');
      const existente = grupos.get(clave);
      if (existente) {
        existente.veces += 1;
        // El query viene ordenado por recencia: el primero ya trae el
        // itinerario y la fecha más recientes del grupo.
        existente.ruta_id ??= v.ruta_id as string | null;
        continue;
      }
      const etiqueta = [
        legs[0].origen_iata,
        ...legs.map((l) => l.destino_iata),
      ].join(' → ');
      grupos.set(clave, {
        clave,
        etiqueta,
        veces: 1,
        ultima_fecha: (v.fecha_vuelo as string | null) ?? null,
        ruta_id: (v.ruta_id as string | null) ?? null,
        tramos: legs.map((l) => ({
          origen_iata: l.origen_iata,
          destino_iata: l.destino_iata,
          millas_nauticas: Number(l.millas_nauticas) || 0,
          // null = hereda los pax de la cotización NUEVA (copiar los pax del
          // vuelo histórico alteraba TUAS y descuadraba el total sugerido).
          pasajeros: l.es_ferry ? 0 : null,
          es_ferry: l.es_ferry === true,
          requiere_pernocta: l.requiere_pernocta === true,
          pernocta_costo_usd:
            l.pernocta_costo_usd != null ? Number(l.pernocta_costo_usd) : null,
          tipo_parada: l.tipo_parada === 'SERVICIO' ? 'SERVICIO' : 'NORMAL',
          servicio_notas: l.servicio_notas ?? null,
        })),
      });
    }

    return [...grupos.values()]
      .sort(
        (a, b) =>
          b.veces - a.veces ||
          (b.ultima_fecha ?? '').localeCompare(a.ultima_fecha ?? ''),
      )
      .slice(0, 5);
  }

  // ============ Internals ============

  /** Destinos del itinerario donde hay pernocta, en orden. */
  /**
   * Misma regla canónica que FlightsService.refreshCobradoFlag (cobrosEnUsd);
   * se replica aquí solo para no crear una dependencia circular de módulos.
   */
  private async refreshCobradoTrasRecotizar(
    vueloId: string,
    vuelo: Record<string, unknown>,
    userId: string,
  ): Promise<void> {
    const { data: cobros, error: cobrosErr } = await this.supabase.service
      .from('cobro_vuelo')
      .select('monto, moneda, tc_usd_mxn')
      .eq('vuelo_id', vueloId);
    // Sin cobros leídos NO se toca la bandera: tratar el fallo como "0 cobros"
    // apagaría `cobrado` de un vuelo ya pagado en silencio.
    if (cobrosErr)
      throw new Error(
        `No se pudieron leer los cobros del vuelo para actualizar 'cobrado': ${cobrosErr.message}`,
      );
    const { total_usd } = cobrosEnUsd(
      cobros ?? [],
      vuelo.tc_usd_mxn as number | null,
    );
    // Mismo gate que refreshCobradoFlag: un total $0 (sin cotizar o cliente
    // INTERNO) nunca queda "cobrado" — 0 >= −1 lo marcaba true y eso
    // bloqueaba volver a revisar la cotización (revise rechaza cobrados).
    const montoTotal = Number(vuelo.monto_total_usd);
    const deberia = montoTotal > 0 && total_usd >= montoTotal - 1;
    if (deberia !== vuelo.cobrado) {
      await this.supabase.service
        .from('vuelo')
        .update({ cobrado: deberia, updated_by: userId })
        .eq('id', vueloId);
    }
  }

  private async pernoctaDestinos(vueloId: string): Promise<string[]> {
    const { data } = await this.supabase.service
      .from('escala')
      .select('orden, destino_iata')
      .eq('vuelo_id', vueloId)
      .eq('requiere_pernocta', true)
      .order('orden', { ascending: true });
    return (data ?? []).map((e) => e.destino_iata as string);
  }

  /**
   * Si la pernocta del itinerario cambió tras una revisión, avisa a los pilotos
   * asignados (al vuelo o a cualquier tramo) por socket/push — para que nadie
   * asuma que pernocta donde no es (o que NO pernocta donde sí).
   */
  /**
   * Aviso a TODA la tripulación del vuelo (piloto, copiloto, apoyo y
   * pilotos de tramo) — auditoría 21-ago-2026. Best-effort.
   */
  private async notificarTripulacion(
    vuelo: Record<string, unknown>,
    n: { titulo: string; cuerpo: string; tipo?: string },
  ): Promise<void> {
    try {
      const ids = await tripulacionDeVuelo(
        this.supabase.service,
        vuelo.id as string,
        vuelo,
      );
      for (const id of ids) {
        void this.notifications.notifyUser(id, {
          tipo: n.tipo ?? 'vuelo_asignado',
          titulo: n.titulo,
          cuerpo: n.cuerpo,
          data: { vuelo_id: vuelo.id, folio: vuelo.folio },
          link: `/flights/${vuelo.id as string}`,
        });
      }
    } catch (e) {
      this.logger.warn(
        `No se pudo avisar a la tripulación del vuelo ${vuelo.id as string}: ${(e as Error).message}`,
      );
    }
  }

  private async notifyPernoctaCambiada(
    vuelo: Record<string, unknown>,
    antes: string[],
    despues: string[],
  ): Promise<void> {
    if (JSON.stringify(antes) === JSON.stringify(despues)) return;
    // Toda la tripulación (copiloto y apoyo también pernoctan) — 21-ago.
    const pilotos = await tripulacionDeVuelo(
      this.supabase.service,
      vuelo.id as string,
      vuelo,
    );
    if (pilotos.size === 0) return;
    const cuerpo =
      despues.length > 0
        ? `🌙 Ahora pernoctas en ${despues.join(', ')} · ${vuelo.origen_iata as string} → ${vuelo.destino_iata as string} · folio #${vuelo.folio as number}`
        : `Este vuelo ya NO incluye pernocta · ${vuelo.origen_iata as string} → ${vuelo.destino_iata as string} · folio #${vuelo.folio as number}`;
    for (const pilotoId of pilotos) {
      void this.notifications.notifyUser(pilotoId, {
        tipo: 'pernocta_actualizada',
        titulo: 'Pernocta actualizada',
        cuerpo,
        data: { vuelo_id: vuelo.id, folio: vuelo.folio, pernoctas: despues },
        link: `/flights/${vuelo.id as string}`,
      });
    }
  }

  /**
   * Vuelo de SERVICIO = itinerario con al menos un tramo de parada SERVICIO y
   * CERO pasajeros en TODOS los tramos activos (taller/mantenimiento). El pax
   * se evalúa por tramo con null=0 a propósito: vuelo.pasajeros tiene piso
   * artificial de 1 en las reservas y el fallback "null hereda el global" es
   * una convención de TUAS, no evidencia de que viajen personas.
   */
  private async assertNoEsVueloDeServicio(vueloId: string): Promise<void> {
    const { data, error } = await this.supabase.service
      .from('escala')
      .select('tipo_parada, pasajeros')
      .eq('vuelo_id', vueloId)
      .is('cancelada_at', null);
    if (error) throw new Error(error.message);
    const escalas = data ?? [];
    if (escalas.length === 0) return;
    const tieneServicio = escalas.some((e) => e.tipo_parada === 'SERVICIO');
    const sinPasajeros = escalas.every((e) => !(Number(e.pasajeros) > 0));
    if (tieneServicio && sinPasajeros) {
      throw new ConflictException(
        'Vuelo de servicio (taller/parada técnica sin pasajeros): no se cotiza ni se asigna a una cotización. Si sí es un viaje del cliente, quita la marca de Servicio o captura los pasajeros del tramo.',
      );
    }
  }

  private async findEscalas(vueloId: string) {
    const { data, error } = await this.supabase.service
      .from('escala')
      .select(
        // aeronave_id: avión del TRAMO (null = hereda el del vuelo) — lo
        // necesita la participación por avión (regla B 28-ago).
        'id, vuelo_id, orden, origen_iata, destino_iata, aeronave_id, millas_nauticas, pasajeros, pasajeros_nombres, es_ferry, solo_operativa, pdf_oculto, requiere_pernocta, pernocta_costo_usd, tipo_parada, servicio_notas, fecha_salida_plan, taco_salida, taco_llegada, hora_salida, hora_llegada, notas, cancelada_at',
      )
      .eq('vuelo_id', vueloId)
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Participación por AVIÓN del vuelo (regla B 28-ago, fuente única
   * `participacionPorAeronave`): en un vuelo multi-avión la venta del avión
   * se reparte entre los aviones de sus tramos; aquí solo se EXPONE (el
   * panel pinta "· 50 % (tramos también en N4142R)"). Un solo avión →
   * un elemento con factor 1; sin avión → []. Matrículas en UNA consulta.
   * `venta_avion_usd` = parte de la venta del avión (`repartirUsd` sobre
   * `particionIngresoVuelo(v).avion_usd`; null sin precio). `horas` queda
   * siempre null (el peso es por tramos vendidos, nunca por horas).
   * Espejo del helper homónimo de flights.service (snapshot del vuelo).
   */
  private async participacionAvionesDe(
    vuelo: {
      aeronave_id?: string | null;
      calculo_snapshot?: unknown;
    } & VueloIngresoInput,
    escalas: EscalaParticipacionInput[],
  ): Promise<{
    participacion_aviones: ParticipacionAvionItem[];
    participacion_fuente: FuenteParticipacion;
  }> {
    const p = participacionPorAeronave(
      {
        aeronave_id: vuelo.aeronave_id ?? null,
        calculo_snapshot: vuelo.calculo_snapshot,
      },
      escalas,
    );
    const particion = particionIngresoVuelo(vuelo);
    const ids = [...p.factores.keys()];
    const matriculaPorId = new Map<string, string>();
    if (ids.length > 0) {
      const { data } = await this.supabase.service
        .from('aeronave')
        .select('id, matricula')
        .in('id', ids);
      for (const a of data ?? []) {
        matriculaPorId.set(a.id as string, a.matricula as string);
      }
    }
    return {
      // Mapper único (fuente única): principal primero, venta del avión
      // repartida al centavo, horas siempre null.
      participacion_aviones: participacionAvionesItems(
        p,
        particion.total_usd > 0 ? particion.avion_usd : null,
        matriculaPorId,
      ),
      participacion_fuente: p.fuente,
    };
  }

  /**
   * Sincroniza el plan de escalas con el itinerario cotizado, SIN destruir las
   * capturas: hace upsert por `orden` (UPDATE de los campos de plan preservando
   * tacómetros/fotos/horas reales y la asignación por tramo; INSERT de tramos
   * nuevos) y borra los sobrantes solo si no tienen tacómetro capturado. Esto
   * permite re-cotizar vuelos abiertos ya volados sin perder datos.
   */
  /**
   * COMPENSACIÓN de create() (29-ago): si el insert de escalas falló, el
   * vuelo recién creado se BORRA (junto con tramos parciales, si alcanzó a
   * escribir alguno) para no dejar una cotización fantasma con 201. Si el
   * borrado también falla solo se loguea fuerte: el error original se lanza
   * igual y el pre-cierre/panel ven el vuelo incompleto (no desaparece nada
   * en silencio).
   */
  private async compensarVueloSinEscalas(vueloId: string): Promise<void> {
    try {
      await this.supabase.service
        .from('cotizacion_version_history')
        .delete()
        .eq('vuelo_id', vueloId);
      await this.supabase.service
        .from('escala')
        .delete()
        .eq('vuelo_id', vueloId);
      const { error } = await this.supabase.service
        .from('vuelo')
        .delete()
        .eq('id', vueloId);
      if (error) throw new Error(error.message);
      this.logger.warn(
        `Vuelo ${vueloId} revertido: sus escalas no se pudieron crear (compensación de create).`,
      );
    } catch (err) {
      this.logger.error(
        `Vuelo ${vueloId} quedó SIN tramos y la compensación falló: ${err instanceof Error ? err.message : String(err)}. Revisarlo/borrarlo a mano.`,
      );
    }
  }

  private async replaceEscalas(
    vueloId: string,
    escalas: ResolvedLeg[] | null,
    userId: string,
    fechas?: { inicio?: string | null; fin?: string | null },
  ): Promise<void> {
    // Vuelo con itinerario OPERATIVO capturado (Nueva cotización · paso 1):
    // TODAS sus escalas son la ruta real del piloto; la ruta comercial de la
    // cotización solo sirve para el precio y NO gestiona escalas. OJO: si la
    // lectura del flag falla NO se puede seguir — fallar "abierto" aquí
    // pisaría la ruta del piloto con la comercial (el ajuste rápido ahora
    // precia con los tramos del snapshot, que son DISTINTOS).
    const { data: vueloFlag, error: flagErr } = await this.supabase.service
      .from('vuelo')
      .select('itinerario_operativo')
      .eq('id', vueloId)
      .maybeSingle();
    if (flagErr)
      throw new Error(
        `Failed to read itinerario_operativo: ${flagErr.message}`,
      );
    if (vueloFlag?.itinerario_operativo === true) return;

    // Solo gestionamos los tramos COMERCIALES (cotizados). Los operativos
    // internos (solo_operativa=true) los administra operaciones aparte y NUNCA
    // se tocan aquí: ni se reordenan ni se borran al re-cotizar.
    const { data: existing, error: exErr } = await this.supabase.service
      .from('escala')
      .select(
        'id, orden, taco_salida, taco_llegada, fecha_salida_plan, piloto_id, cancelada_at, origen_iata, destino_iata',
      )
      .eq('vuelo_id', vueloId)
      .eq('solo_operativa', false);
    if (exErr) throw new Error(`Failed to read escalas: ${exErr.message}`);
    const porOrden = new Map(
      (existing ?? []).map((e) => [e.orden as number, e]),
    );
    const tieneTaco = (e: { taco_salida: unknown; taco_llegada: unknown }) =>
      e.taco_salida != null || e.taco_llegada != null;

    const total = escalas?.length ?? 0;
    // Cambios que la tripulación DEBE saber (auditoría 26-ago): tramos
    // revividos, agregados y eliminados por la re-cotización. Se junta TODO
    // en un solo aviso al final (re-cotizar toca varios tramos a la vez y
    // un push por tramo sería spam).
    const cambios = {
      revividos: [] as string[],
      agregados: [] as string[],
      eliminados: [] as { ruta: string; piloto_id: string | null }[],
    };
    for (let idx = 0; idx < total; idx++) {
      const e = escalas![idx];
      const orden = idx + 1;
      const fechaPlan =
        e.fecha_salida_plan ??
        (idx === 0
          ? (fechas?.inicio ?? null)
          : idx === total - 1
            ? (fechas?.fin ?? null)
            : null);
      const planFields: Record<string, unknown> = {
        origen_iata: e.origen_iata.toUpperCase(),
        destino_iata: e.destino_iata.toUpperCase(),
        // Mismo aeropuerto = SOBREVUELO por definición (ej. ruta CUN→CUN de
        // Zona Hotelera): sin la marca, la validación operativa de escalas
        // rechazaría el tramo.
        es_sobrevuelo:
          e.origen_iata.toUpperCase() === e.destino_iata.toUpperCase(),
        millas_nauticas: e.millas_nauticas,
        pasajeros: e.es_ferry ? 0 : e.pasajeros,
        pasajeros_nombres: e.es_ferry ? [] : e.pasajeros_nombres,
        es_ferry: e.es_ferry,
        requiere_pernocta: e.requiere_pernocta,
        pernocta_costo_usd: e.requiere_pernocta ? e.pernocta_costo_usd : null,
        tipo_parada: e.tipo_parada,
        servicio_notas: e.servicio_notas,
        notas: e.notas,
        updated_by: userId,
      };
      // Bug 1-sep ("apago la visibilidad del tramo, vuelvo a entrar y está
      // activada"): el editor del panel rehidrata del SNAPSHOT, así que un
      // guardado que no trae la bandera NO debe pisar el valor VIVO de la
      // escala (que pudo cambiar con el PATCH pdf-visibilidad). La bandera
      // solo cambia cuando viaja EXPLÍCITA en el DTO; si no viaja (null), se
      // omite la columna y el UPDATE conserva lo que hay. En INSERT de tramo
      // nuevo, omitirla usa el default de BD (false = visible).
      if (e.pdf_oculto != null) {
        planFields.pdf_oculto = e.pdf_oculto === true;
      }
      const actual = porOrden.get(orden);
      if (actual) {
        // No pisar con null una fecha ya planeada/asignada al tramo.
        if (fechaPlan != null || actual.fecha_salida_plan == null) {
          planFields.fecha_salida_plan = fechaPlan;
        }
        // Re-cotizar redefine la ruta: si el tramo estaba CANCELADO
        // (operación), el nuevo plan lo revive — el cotizador es la fuente
        // de la ruta comercial y un tramo cancelado y cotizado a la vez
        // sería contradictorio.
        if (actual.cancelada_at != null) {
          cambios.revividos.push(
            `${e.origen_iata.toUpperCase()} → ${e.destino_iata.toUpperCase()}`,
          );
        }
        planFields.cancelada_at = null;
        planFields.cancelada_motivo = null;
        planFields.cancelada_por = null;
        const { error } = await this.supabase.service
          .from('escala')
          .update(planFields)
          .eq('id', actual.id as string);
        if (error)
          throw new Error(`Failed to update escala ${orden}: ${error.message}`);
      } else {
        const { error } = await this.supabase.service.from('escala').insert({
          vuelo_id: vueloId,
          orden,
          ...planFields,
          fecha_salida_plan: fechaPlan,
          created_by: userId,
        });
        if (error)
          throw new Error(`Failed to insert escala ${orden}: ${error.message}`);
        cambios.agregados.push(
          `${e.origen_iata.toUpperCase()} → ${e.destino_iata.toUpperCase()}`,
        );
      }
    }

    // Sobrantes (orden > nuevo total): se eliminan solo si no tienen captura.
    const sobrantes = (existing ?? []).filter(
      (e) => (e.orden as number) > total,
    );
    for (const s of sobrantes) {
      if (tieneTaco(s)) {
        this.logger.warn(
          `Vuelo ${vueloId}: escala orden ${s.orden} tiene tacómetro capturado; se conserva aunque el plan cotizado ya no la incluye.`,
        );
        continue;
      }
      const { error } = await this.supabase.service
        .from('escala')
        .delete()
        .eq('id', s.id as string);
      if (error)
        throw new Error(`Failed to delete escala sobrante: ${error.message}`);
      cambios.eliminados.push({
        ruta: `${(s.origen_iata as string) ?? '?'} → ${(s.destino_iata as string) ?? '?'}`,
        piloto_id: (s.piloto_id as string | null) ?? null,
      });
    }

    // Aviso consolidado del itinerario (26-ago): antes revivir/agregar/
    // eliminar tramos al re-cotizar era completamente mudo. En create()
    // el vuelo nace sin tripulación y no sale nada.
    if (
      cambios.revividos.length ||
      cambios.agregados.length ||
      cambios.eliminados.length
    ) {
      try {
        const vuelo = await this.findById(vueloId);
        const partes: string[] = [];
        if (cambios.agregados.length)
          partes.push(`tramos nuevos: ${cambios.agregados.join(', ')}`);
        if (cambios.revividos.length)
          partes.push(`tramos restaurados: ${cambios.revividos.join(', ')}`);
        if (cambios.eliminados.length)
          partes.push(
            `tramos eliminados: ${cambios.eliminados.map((x) => x.ruta).join(', ')}`,
          );
        void this.notificarTripulacion(vuelo, {
          titulo: `Vuelo #${vuelo.folio as number}: cambió el itinerario`,
          cuerpo: `Al re-cotizar: ${partes.join(' · ')}.`,
        });
        // El piloto EXPLÍCITO de un tramo eliminado puede ya no estar en la
        // tripulación vigente: aviso directo (patrón "quitado").
        for (const el of cambios.eliminados) {
          if (!el.piloto_id) continue;
          void this.notifications.notifyUser(el.piloto_id, {
            tipo: 'alerta_sistema',
            titulo: `Tramo eliminado · vuelo #${vuelo.folio as number}`,
            cuerpo: `El tramo ${el.ruta} que tenías asignado se eliminó al re-cotizar.`,
            data: { vuelo_id: vueloId, folio: vuelo.folio },
            link: `/flights/${vueloId}`,
          });
        }
      } catch (err) {
        this.logger.warn(
          `aviso de itinerario en replaceEscalas falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async appendVersionHistory(
    vueloId: string,
    version: number,
    dto: CalculateQuoteDto,
    breakdown: Awaited<ReturnType<QuotesService['calculate']>>,
    motivo: string,
    userId: string,
  ): Promise<void> {
    const { error } = await this.supabase.service
      .from('cotizacion_version_history')
      .insert({
        vuelo_id: vueloId,
        version,
        aeronave_id: dto.aeronave_id,
        ruta_id: breakdown.ruta.id,
        origen_iata: breakdown.ruta.origen_iata,
        destino_iata: breakdown.ruta.destino_iata,
        millas_nauticas_one_way: breakdown.ruta.millas_nauticas_base,
        es_redondo_auto: breakdown.ruta.es_redondo_auto,
        num_aterrizajes: breakdown.ruta.num_aterrizajes,
        pasajeros: dto.pasajeros,
        pase_abordar: dto.pase_abordar ?? false,
        tiempo_cobrable_hr: breakdown.tiempos.cobrable_hr,
        tarifa_tipo: dto.tipo_tarifa,
        tarifa_hora_usd: breakdown.tarifa.usd_por_hora,
        subtotal_vuelo_usd: breakdown.totales.subtotal_vuelo_usd,
        tuas_usd: breakdown.totales.tuas_total_usd,
        iva_pct: breakdown.iva.porcentaje,
        iva_usd: breakdown.iva.monto_usd,
        monto_total_usd: breakdown.totales.total_usd,
        tc_usd_mxn: dto.tc_usd_mxn ?? null,
        monto_total_mxn: breakdown.totales.total_mxn ?? null,
        viaticos_pernocta_usd: breakdown.totales.viaticos_pernocta_usd,
        extras_total_usd: breakdown.totales.extras_total_usd,
        ajuste_final_usd: breakdown.totales.ajuste_final_usd,
        metodo_cobro: dto.metodo_pago,
        calculo_snapshot: breakdown,
        motivo,
        created_by: userId,
      });
    if (error)
      throw new Error(
        `Failed to write cotizacion version history: ${error.message}`,
      );
  }

  /**
   * Resuelve los detalles por tramo aplicando defaults: ferry fuerza 0 pax;
   * pax = leg.pasajeros ?? pax global; pernocta_costo solo si requiere pernocta.
   */
  private resolveLegs(raw: RawLeg[], globalPax: number): ResolvedLeg[] {
    return raw.map((l) => {
      const esFerry = l.es_ferry ?? false;
      const requierePernocta = l.requiere_pernocta ?? false;
      const pernoctaCosto = requierePernocta
        ? l.pernocta_costo_usd != null
          ? Number(l.pernocta_costo_usd)
          : PERNOCTA_COSTO_DEFAULT_USD
        : 0;
      return {
        origen_iata: l.origen_iata.toUpperCase(),
        destino_iata: l.destino_iata.toUpperCase(),
        millas_nauticas: Number(l.millas_nauticas),
        pasajeros: esFerry ? 0 : (l.pasajeros ?? globalPax),
        // Manifiesto por tramo: ferry sin pasajeros => vacío; nombres limpios.
        pasajeros_nombres: esFerry
          ? []
          : (l.pasajeros_nombres ?? [])
              .map((n) => n.trim())
              .filter((n) => n.length > 0),
        es_ferry: esFerry,
        requiere_pernocta: requierePernocta,
        pernocta_costo_usd: pernoctaCosto,
        tipo_parada: l.tipo_parada === 'SERVICIO' ? 'SERVICIO' : 'NORMAL',
        servicio_notas: l.servicio_notas ?? null,
        notas: l.notas ?? null,
        // NO normalizar la ausencia a false: null = "no viajó" y la escala
        // viva conserva su pdf_oculto (ver doc de ResolvedLeg, bug 1-sep).
        pdf_oculto: l.pdf_oculto == null ? null : l.pdf_oculto === true,
        fecha_salida_plan:
          l.fecha_salida_plan instanceof Date
            ? l.fecha_salida_plan.toISOString()
            : (l.fecha_salida_plan ?? null),
      };
    });
  }

  private async resolveRoute(dto: CalculateQuoteDto): Promise<ResolvedRoute> {
    // Escalas explícitas = el itinerario PROPIO de la cotización (la plantilla
    // hidratada y posiblemente ajustada por el operador). Tienen prioridad;
    // ruta_id se conserva solo como referencia de la plantilla usada.
    if (
      dto.tipo === TipoVuelo.MULTIESCALA &&
      dto.escalas &&
      dto.escalas.length >= 1
    ) {
      for (let i = 0; i < dto.escalas.length - 1; i++) {
        const a = dto.escalas[i].destino_iata.toUpperCase();
        const b = dto.escalas[i + 1].origen_iata.toUpperCase();
        if (a !== b) {
          throw new BadRequestException(
            `Escala ${i + 2}: el origen (${b}) debe coincidir con el destino de la escala ${i + 1} (${a}).`,
          );
        }
      }
      const escalasNorm = this.resolveLegs(dto.escalas, dto.pasajeros);
      const nmTotal = escalasNorm.reduce(
        (acc, e) => acc + e.millas_nauticas,
        0,
      );
      return {
        ruta_id: dto.ruta_id ?? null,
        origen_iata: escalasNorm[0].origen_iata,
        destino_iata: escalasNorm[escalasNorm.length - 1].destino_iata,
        millas_nauticas: nmTotal,
        es_redondo_auto: false,
        num_aterrizajes: escalasNorm.length,
        escalas: escalasNorm,
      };
    }

    // Ruta del catalogo sin escalas explícitas: hidrata los tramos guardados.
    if (dto.ruta_id) {
      const r = await this.routes.findById(dto.ruta_id);
      if (!r.activa) throw new BadRequestException('Ruta inactiva');
      if (r.tipo === 'MULTIESCALA' && r.tramos && r.tramos.length >= 1) {
        // Hidrata los defaults por tramo de la plantilla guardada.
        const escalasNorm = this.resolveLegs(r.tramos, dto.pasajeros);
        return {
          ruta_id: r.id,
          origen_iata: escalasNorm[0].origen_iata,
          destino_iata: escalasNorm[escalasNorm.length - 1].destino_iata,
          millas_nauticas: escalasNorm.reduce(
            (acc, e) => acc + e.millas_nauticas,
            0,
          ),
          es_redondo_auto: false,
          num_aterrizajes: escalasNorm.length,
          escalas: escalasNorm,
        };
      }
      // Ruta legacy SIMPLE (redondo automático ×2): ya no se cotiza. El precio
      // dependía de duplicar millas implícitamente — edítala en Rutas para
      // convertirla a tramos explícitos.
      throw new BadRequestException(
        `La ruta ${r.origen_iata}→${r.destino_iata} es legacy (redondo automático). Edítala en Rutas para convertirla a tramos antes de cotizar.`,
      );
    }

    if (dto.tipo === TipoVuelo.MULTIESCALA) {
      throw new BadRequestException(
        'El itinerario requiere al menos 1 tramo (agrega el regreso si aplica).',
      );
    }
    // Modo ad-hoc legacy (origen/destino/millas sueltos con ×2 implícito):
    // eliminado junto con el "redondo automático". Toda cotización se arma por
    // tramos explícitos o con una ruta guardada.
    throw new BadRequestException(
      'Cotiza con una ruta guardada (ruta_id) o con el itinerario por tramos (escalas[]).',
    );
  }

  /**
   * Aeropuertos únicos del itinerario en orden de aparición. Para
   * CUN-HOL-CZM-CUN devuelve [CUN, HOL, CZM] (sin duplicar el regreso a CUN
   * porque TUAS por aeropuerto se cobra por aeropuerto, no por aterrizaje).
   */
  private aeropuertosUnicos(
    escalas: { origen_iata: string; destino_iata: string }[],
  ): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of escalas) {
      for (const iata of [e.origen_iata, e.destino_iata]) {
        const u = iata.toUpperCase();
        if (!seen.has(u)) {
          seen.add(u);
          out.push(u);
        }
      }
    }
    return out;
  }

  private derivarMatriculaPrefix(matricula: string): 'XA' | 'XB' | 'N' {
    const m = matricula.toUpperCase();
    if (m.startsWith('XA')) return 'XA';
    if (m.startsWith('XB')) return 'XB';
    if (m.startsWith('N')) return 'N';
    throw new BadRequestException(
      `Matrícula ${matricula} no reconocida (debe empezar con XA, XB o N)`,
    );
  }

  private async computeTuas(
    iata: string,
    matriculaPrefix: 'XA' | 'XB' | 'N',
    paseAbordar: boolean,
    override?: number,
  ): Promise<TuasAeropuerto> {
    try {
      const result = await this.airports.computeTuasUsdPax(
        iata,
        matriculaPrefix,
        paseAbordar,
      );
      const usdPax = override !== undefined ? override : result.usd_pax;
      return {
        iata,
        aplica: result.aplica,
        usd_pax: result.aplica ? usdPax : 0,
        monto_pax: result.aplica ? usdPax : 0,
        moneda: 'USD',
        tc_aplicado: null,
        razon: result.razon,
      };
    } catch (e) {
      if (e instanceof NotFoundException) {
        return {
          iata,
          aplica: override !== undefined && override > 0,
          usd_pax: override ?? 0,
          monto_pax: override ?? 0,
          moneda: 'USD',
          tc_aplicado: null,
          razon: `Aeropuerto ${iata} no registrado en catálogo${override !== undefined ? ' — usando override' : ' — TUAS no calculada'}`,
        };
      }
      throw e;
    }
  }
}

export { EstadoVuelo };
