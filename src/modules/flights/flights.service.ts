import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { tripulacionDeVuelo } from '../../common/tripulacion.util';
import { CalendarSyncService } from '../calendar/calendar-sync.service';
import { EmailService } from '../notifications/email.service';
import { NotificationsService } from '../realtime/notifications.service';
import {
  CONFIG_CAPTURA_TACO_FOTO_IA,
  ConfiguracionService,
} from '../configuracion/configuracion.service';
import { VisionService } from '../vision/vision.service';
import { ExpirationsService } from '../expirations/expirations.service';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import type {
  AssignFlightDto,
  CreateExternalFlightDto,
  CreateReservaDto,
  ListFlightsQuery,
  UpdateFlightDto,
} from './dto/flights.dto';
import type {
  AssignEscalaDto,
  CaptureTacoDto,
  ClearTacoDto,
  ConfirmTacoDto,
  CreateEscalaDto,
  OperationalLegDto,
  TacoAiReadDto,
  UpdateEscalaDto,
} from './dto/escalas.dto';
import type { CreateCobroDto, UpdateCobroDto } from './dto/cobros.dto';
import { AirportsService } from '../airports/airports.service';
import { cobrosEnUsd, type CobroLike } from '../../common/cobros-usd.util';
import {
  CORRECCION_BAJA_PREFIX,
  PROCEDENCIA_PREFIX,
  agregarProcedencia,
  correccionesBajaPendientes,
  leerBitacora,
  motivoDirecto,
  soloPendientes,
} from '../../common/taco-motivo.util';

const VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, piloto_id, copiloto_id, apoyo_id, ruta_id, tipo, estado, es_externo, operador_externo, costo_externo_usd, cotizacion_version, origen_iata, destino_iata, pasajeros, pasajeros_nombres, monto_total_usd, tc_usd_mxn, metodo_cobro, cotizacion_abierta, itinerario_operativo, fecha_vuelo, fecha_traslado_final, fecha_fin, fecha_confirmacion, estado_permiso, foto_plan_vuelo_url, facturado, cobrado, notas, notas_internas, google_calendar_id, created_at, updated_at';

// NOTA: aeronave_id/piloto_id/estado_permiso del tramo orden=1 (ida) se mantienen
// como ESPEJO de vuelo.aeronave_id/piloto_id/estado_permiso (sincronizado por la app,
// ver syncVueloFromIdaEscala / mirrorVueloToIdaEscala). El resto de los tramos son
// independientes.
const ESCALA_COLS =
  'id, vuelo_id, orden, origen_iata, destino_iata, aeronave_id, piloto_id, estado_permiso, fecha_salida_plan, foto_plan_vuelo_url, google_calendar_id, pasajeros, pasajeros_nombres, es_ferry, es_sobrevuelo, requiere_pernocta, pernocta_costo_usd, tipo_parada, servicio_notas, solo_operativa, taco_salida, taco_llegada, taco_salida_origen, taco_llegada_origen, foto_taco_salida_url, foto_taco_llegada_url, valor_ia_propuesto, revision_requerida, revision_motivo, hora_salida, hora_llegada, capturado_offline, sincronizado_at, capturado_por, corregido_por, nota_correccion, corregido_at, taco_salida_obs, taco_llegada_obs, taco_obs_updated_by, taco_obs_updated_at, notas, cancelada_at, cancelada_motivo, cancelada_por, created_at, updated_at';

// Umbrales de consistencia para la marca AMARILLA (revisión manual).
const AI_VS_MANUAL_TOL_HR = 0.3; // |lectura manual − sugerida IA| en horas
const DURATION_TOL_PCT = 0.4; // desviación de duración vs promedio histórico
const MIN_MUESTRAS = 3; // muestras mínimas para confiar en el promedio
// Fallback cuando el tramo aún no tiene histórico confiable: estimado por
// distancia (millas por aerovía / velocidad crucero). Es una referencia
// gruesa, por eso la tolerancia es MÁS ANCHA que la del histórico.
const DURATION_EST_TOL_PCT = 0.6;
// Lecturas "idénticas" al tramo anterior (foto/valor repetido, caso vuelo
// #71). Los tacos van a 1 decimal, así que ±0.01 = mismo número.
const TACO_REPETIDO_TOL_HR = 0.01;

// Único candado de tacómetro vigente: COMPLETAR exige las LLEGADAS (la foto
// del piloto). Iniciar nunca bloquea (la salida se autollena) — "la operación
// no se detiene".
const MSG_TACO = 'Debes registrar el tacómetro antes de continuar.';

/**
 * El equipo trabaja los tacómetros a 1 DECIMAL (regla del cliente, jul 2026):
 * algunos horómetros (XB-ANU) muestran centésimas y las capturas quedaban con
 * 2 decimales. TODA escritura de taco_salida/taco_llegada/valor_ia_propuesto
 * pasa por aquí — así la cadena (propagación, deducción, horas derivadas)
 * queda homogénea.
 */
function roundTaco(v: number | string): number {
  return Math.round(Number(v) * 10) / 10;
}

/**
 * Calidad de la foto según la IA. pyservices ya la manda; si viene de una
 * versión vieja se deduce de la confianza — NUNCA se asume ALTA en silencio:
 * una lectura dudosa que se ve "segura" es justo lo que rompió el caso del
 * 28 jul 2026 (foto borrosa, la IA leyó 1621.8 y el tambor decía .9).
 */
function calidadFoto(ia: {
  confianza?: number | null;
  calidad_foto?: string | null;
}): 'ALTA' | 'MEDIA' | 'BAJA' {
  const c = (ia.calidad_foto ?? '').toUpperCase();
  if (c === 'ALTA' || c === 'MEDIA' || c === 'BAJA') return c;
  const conf = Number(ia.confianza ?? 0);
  return conf >= 0.9 ? 'ALTA' : conf < 0.7 ? 'BAJA' : 'MEDIA';
}

/** Etiqueta legible de la calidad para la nota de procedencia. */
function calidadLabel(c: 'ALTA' | 'MEDIA' | 'BAJA'): string {
  return c === 'ALTA'
    ? 'calidad de foto buena'
    : c === 'MEDIA'
      ? 'calidad de foto regular'
      : 'calidad de foto BAJA (dígitos dudosos)';
}

interface EscalaTaco {
  orden: number;
  taco_salida: string | number | null;
  taco_llegada: string | number | null;
}

/**
 * Sugerencia de llegada pendiente (política del cliente, 25 jul 2026): el
 * sistema YA NO escribe valores estimados por promedio — los devuelve como
 * sugerencia para alertar (push al piloto, resumen nocturno a oficina). El
 * valor_estimado es SOLO referencia; jamás se persiste.
 */
export interface TacoSugerencia {
  escala_id: string;
  vuelo_id: string;
  folio: number;
  tramo: string;
  tipo: 'LLEGADA_VENCIDA';
  valor_estimado: number;
  minutos_promedio: number;
  vencida_desde: string | null;
  /** Piloto del tramo (o del vuelo) — uso interno para el push del cron. */
  piloto_id: string | null;
}

const COBRO_COLS =
  'id, vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn, comision_banco_pct, comision_banco_monto, cuenta_destino, referencia, fecha_cobro, foto_voucher_url, registrado_por, notas, created_at, updated_at';

// Tarea 11: métodos con tarjeta que exigen foto de voucher.
const METODOS_TARJETA = new Set(['BILLPOCKET', 'HSBC_LINK']);
// Métodos que el PILOTO puede cobrar en campo: efectivo (MXN/USD) y terminal de
// tarjeta. La transferencia la concilia la oficina, no el piloto.
const METODOS_COBRO_PILOTO = new Set([
  'EFECTIVO',
  'DOLARES',
  'BILLPOCKET',
  'HSBC_LINK',
]);

@Injectable()
export class FlightsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly calendar: CalendarSyncService,
    private readonly email: EmailService,
    private readonly vision: VisionService,
    private readonly notifications: NotificationsService,
    private readonly expirations: ExpirationsService,
    private readonly airports: AirportsService,
    private readonly configuracion: ConfiguracionService,
  ) {}

  private readonly logger = new Logger(FlightsService.name);

  /**
   * Destinos del itinerario donde el piloto pernocta (tramos con
   * requiere_pernocta). Vacío = el piloto NO pernocta — clave para que no lo
   * asuma en destinos lejanos (ej. CUN–Huatulco sin pernocta).
   */
  private async pernoctasDeVuelo(vueloId: string): Promise<string[]> {
    const { data } = await this.supabase.service
      .from('escala')
      .select('orden, destino_iata, requiere_pernocta')
      .eq('vuelo_id', vueloId)
      .eq('requiere_pernocta', true)
      .order('orden', { ascending: true });
    return (data ?? []).map((e) => e.destino_iata as string);
  }

  /**
   * Ruta COMPLETA del vuelo como cadena "CUN → CZM → CUN": origen del primer
   * tramo + destino de cada tramo, en orden. Así el piloto ve todas las escalas
   * y no solo origen/destino (que en un redondo se ven iguales: "CUN → CUN").
   * Cae a origen/destino del vuelo si aún no hay escalas.
   */
  private async rutaDeVuelo(vuelo: Record<string, unknown>): Promise<string> {
    const { data } = await this.supabase.service
      .from('escala')
      .select('origen_iata, destino_iata, orden')
      .eq('vuelo_id', vuelo.id as string)
      .order('orden', { ascending: true });
    const legs = data ?? [];
    if (legs.length === 0) {
      return `${vuelo.origen_iata as string} → ${vuelo.destino_iata as string}`;
    }
    const puntos = [
      legs[0].origen_iata as string,
      ...legs.map((l) => l.destino_iata as string),
    ];
    return puntos.join(' → ');
  }

  /**
   * Mayor lectura de tacómetro registrada para una aeronave (el horómetro solo
   * sube). Sirve de ancla de magnitud para la IA al leer una foto nueva. Incluye
   * el taco_salida de la escala en curso (`incluir`) por si es la lectura más
   * reciente aún no comparada. Devuelve null si no hay historial.
   */
  private async ultimoTacoAeronave(
    aeronaveId: string | null,
    incluir: number | null,
  ): Promise<number | null> {
    let max = incluir ?? null;
    if (aeronaveId) {
      // Regla escala-primero (asignación por tramo): un tramo pertenece al
      // avión si escala.aeronave_id lo dice, o si no tiene asignación propia
      // y el vuelo es de este avión. Sin el segundo query, los tramos legados
      // con aeronave_id null serían invisibles para el ancla del horómetro.
      const [propias, heredadas] = await Promise.all([
        this.supabase.service
          .from('escala')
          .select('taco_salida, taco_llegada')
          .eq('aeronave_id', aeronaveId),
        this.supabase.service
          .from('escala')
          .select('taco_salida, taco_llegada, vuelo!inner(aeronave_id)')
          .is('aeronave_id', null)
          .eq('vuelo.aeronave_id', aeronaveId),
      ]);
      for (const e of [...(propias.data ?? []), ...(heredadas.data ?? [])]) {
        for (const v of [e.taco_salida, e.taco_llegada]) {
          if (v !== null && v !== undefined) {
            const n = Number(v);
            if (!Number.isNaN(n) && (max === null || n > max)) max = n;
          }
        }
      }
    }
    return max;
  }

  /**
   * DETALLE de la última lectura de tacómetro del avión (la de mayor valor:
   * el horómetro solo sube): valor, lado, origen y de qué vuelo/tramo salió.
   * La app la pinta INFORMATIVA en la captura del piloto — compara contra el
   * tacómetro físico y avisa al equipo si no cuadra (pedido 24-ago-2026).
   *
   * Reglas (ronda adversarial 24-ago):
   * - Tramos cancelados fuera (`cancelada_at`); los vuelos CANCELADO **sí
   *   cuentan** si la lectura es real — cancel() a nivel vuelo no anula tacos
   *   y esa lectura es historia física del horómetro (caso #180: excluirla
   *   desalineaba la card del auto-relleno y del tacómetro físico). Solo se
   *   descarta DEDUCIDO de vuelo cancelado (promesa de un vuelo que no fue).
   * - Top-N por lado en SQL (no bajar todo el historial: el cap de 1000
   *   filas de PostgREST haría silenciosamente incompleto el máximo).
   * - Si alguna query falla se devuelve null: mejor sin card que afirmar un
   *   "último taco" viejo calculado con la mitad de los datos.
   */
  private async ultimoTacoAeronaveDetalle(aeronaveId: string | null): Promise<{
    valor: number;
    lado: 'SALIDA' | 'LLEGADA';
    origen: string | null;
    vuelo_id: string | null;
    folio: number | null;
    fecha_vuelo: string | null;
    ruta: string | null;
    escala_id: string | null;
  } | null> {
    if (!aeronaveId) return null;
    type Row = {
      id: string;
      origen_iata: string | null;
      destino_iata: string | null;
      taco_salida: number | string | null;
      taco_llegada: number | string | null;
      taco_salida_origen: string | null;
      taco_llegada_origen: string | null;
      hora_salida: string | null;
      hora_llegada: string | null;
      fecha_salida_plan: string | null;
      vuelo: {
        id: string;
        folio: number | null;
        fecha_vuelo: string | null;
        estado: string | null;
        aeronave_id?: string | null;
      } | null;
    };
    const cols =
      'id, origen_iata, destino_iata, taco_salida, taco_llegada, ' +
      'taco_salida_origen, taco_llegada_origen, ' +
      'hora_salida, hora_llegada, fecha_salida_plan, ' +
      'vuelo!inner(id, folio, fecha_vuelo, estado, aeronave_id)';
    // Misma regla escala-primero con herencia que `ultimoTacoAeronave`:
    // 4 queries chiquitas (top 5 por lado, propias y heredadas).
    const porLado = (campo: 'taco_salida' | 'taco_llegada') => {
      const propias = this.supabase.service
        .from('escala')
        .select(cols)
        .eq('aeronave_id', aeronaveId)
        .is('cancelada_at', null)
        .not(campo, 'is', null)
        .order(campo, { ascending: false, nullsFirst: false })
        .limit(5);
      const heredadas = this.supabase.service
        .from('escala')
        .select(cols)
        .is('aeronave_id', null)
        .eq('vuelo.aeronave_id', aeronaveId)
        .is('cancelada_at', null)
        .not(campo, 'is', null)
        .order(campo, { ascending: false, nullsFirst: false })
        .limit(5);
      return [propias, heredadas];
    };
    const resultados = await Promise.all([
      ...porLado('taco_llegada'),
      ...porLado('taco_salida'),
    ]);
    if (resultados.some((r) => r.error)) return null;
    // Dedupe por escala: una misma fila puede venir en varias queries.
    const filas = new Map<string, Row>();
    for (const r of resultados) {
      for (const f of (r.data ?? []) as unknown as Row[]) filas.set(f.id, f);
    }
    let mejor: {
      valor: number;
      lado: 'SALIDA' | 'LLEGADA';
      origen: string | null;
      fecha: string | null;
      fila: Row;
    } | null = null;
    const esReal = (o: string | null) => o !== null && o !== 'DEDUCIDO';
    for (const fila of filas.values()) {
      const lados: [
        'LLEGADA' | 'SALIDA',
        number | string | null,
        string | null,
        string | null,
      ][] = [
        [
          'LLEGADA',
          fila.taco_llegada,
          fila.taco_llegada_origen,
          fila.hora_llegada,
        ],
        ['SALIDA', fila.taco_salida, fila.taco_salida_origen, fila.hora_salida],
      ];
      for (const [lado, crudo, origen, horaLado] of lados) {
        if (crudo === null || crudo === undefined) continue;
        const n = Number(crudo);
        if (Number.isNaN(n)) continue;
        // Un DEDUCIDO de vuelo cancelado es la promesa de un vuelo que no
        // fue: no sirve de referencia. Las lecturas REALES de vuelos
        // cancelados sí (el horómetro físico ya está en ese valor).
        if (fila.vuelo?.estado === 'CANCELADO' && !esReal(origen)) continue;
        const fecha =
          horaLado ?? fila.fecha_salida_plan ?? fila.vuelo?.fecha_vuelo ?? null;
        // Desempate DETERMINISTA a valor igual (las queries no traen orden
        // garantizado entre filas): evidencia real sobre DEDUCIDO, luego
        // LLEGADA sobre SALIDA (la llegada es la lectura original; la salida
        // siguiente es su copia), luego la fecha más reciente.
        let gana = false;
        if (mejor === null || n > mejor.valor) {
          gana = true;
        } else if (n === mejor.valor) {
          if (!esReal(mejor.origen) && esReal(origen)) gana = true;
          else if (esReal(origen) === esReal(mejor.origen)) {
            if (lado === 'LLEGADA' && mejor.lado === 'SALIDA') gana = true;
            else if (lado === mejor.lado && (fecha ?? '') > (mejor.fecha ?? ''))
              gana = true;
          }
        }
        if (gana)
          mejor = { valor: n, lado, origen: origen ?? null, fecha, fila };
      }
    }
    if (!mejor) return null;
    const f = mejor.fila;
    return {
      valor: mejor.valor,
      lado: mejor.lado,
      origen: mejor.origen,
      vuelo_id: f.vuelo?.id ?? null,
      folio: f.vuelo?.folio ?? null,
      // Fecha del LADO elegido (un viaje multi-día puede llegar días después
      // de su fecha_vuelo); cae a la fecha del vuelo si el tramo no la tiene.
      fecha_vuelo: mejor.fecha,
      ruta:
        f.origen_iata && f.destino_iata
          ? `${f.origen_iata} → ${f.destino_iata}`
          : null,
      escala_id: f.id ?? null,
    };
  }

  /**
   * Última lectura de tacómetro del AVIÓN del vuelo (historial completo del
   * horómetro, que solo sube). El panel la usa para PRECARGAR la salida al
   * capturar/corregir tacos en oficina — antes había que ir a buscar la
   * última lectura a mano en cada vuelo.
   */
  async ultimoTacoDeVuelo(
    vueloId: string,
  ): Promise<{ ultimo_taco: number | null }> {
    const vuelo = await this.findById(vueloId);
    const ultimo = await this.ultimoTacoAeronave(
      (vuelo.aeronave_id as string | null) ?? null,
      null,
    );
    return { ultimo_taco: ultimo };
  }

  /**
   * Elimina un vuelo SIN actividad (solicitudes/apartados fantasma que nunca
   * se confirmaron). Bloqueado si tiene cobros, gastos o tacómetros: esos se
   * cancelan (no se borran) para no perder el rastro contable.
   */
  async deleteFlight(id: string): Promise<{ deleted: true; id: string }> {
    const vuelo = await this.findById(id);
    if (vuelo.cobrado || vuelo.facturado) {
      throw new ConflictException(
        'El vuelo ya fue cobrado/facturado; cancélalo en lugar de borrarlo.',
      );
    }
    const sb = this.supabase.service;
    const [{ count: cobros }, { count: gastos }, { count: tacos }] =
      await Promise.all([
        sb
          .from('cobro_vuelo')
          .select('id', { count: 'exact', head: true })
          .eq('vuelo_id', id),
        sb
          .from('gasto')
          .select('id', { count: 'exact', head: true })
          .eq('vuelo_id', id),
        sb
          .from('escala')
          .select('id', { count: 'exact', head: true })
          .eq('vuelo_id', id)
          .not('taco_salida', 'is', null),
      ]);
    if ((cobros ?? 0) > 0 || (gastos ?? 0) > 0 || (tacos ?? 0) > 0) {
      throw new ConflictException(
        'El vuelo tiene actividad registrada (cobros, gastos o tacómetros); cancélalo en lugar de borrarlo para no perder el rastro.',
      );
    }
    // Aviso a la tripulación ANTES de borrar (21-ago): después ya no hay a
    // quién consultar. Se resuelve la lista ahora y se manda al final.
    const tripulacion = await this.tripulacionDeVuelo(id, vuelo);
    // Quita eventos de Google antes de perder los IDs.
    await this.calendar.removeFlight(id).catch(() => undefined);
    await sb.from('cotizacion_version_history').delete().eq('vuelo_id', id);
    await sb.from('escala').delete().eq('vuelo_id', id);
    const { error } = await sb.from('vuelo').delete().eq('id', id);
    if (error) throw new Error(error.message);
    for (const uid of tripulacion) {
      void this.notifications.notifyUser(uid, {
        tipo: 'alerta_sistema',
        titulo: `Vuelo #${vuelo.folio as number} eliminado`,
        cuerpo: `${vuelo.origen_iata as string} → ${vuelo.destino_iata as string} del ${this.fechaCancunTxt(vuelo.fecha_vuelo as string | null)} se eliminó del sistema: ya no vas.`,
        data: { folio: vuelo.folio },
      });
    }
    return { deleted: true, id };
  }

  /**
   * Borrado DEFINITIVO de un vuelo CANCELADO (solo ADMIN, pedido 26-ago).
   * A diferencia de deleteFlight (borradores sin actividad), aquí el vuelo
   * SÍ tuvo historia — por eso los candados son duros y queda huella:
   * - Solo estado CANCELADO (lo operativo se cancela, no se borra).
   * - CERO dinero colgando: cobros (RESTRICT en BD) y factura (NO ACTION)
   *   bloquean; los gastos ligados se rechazan AQUÍ porque su FK es
   *   SET NULL y quedarían huérfanos en silencio (reasignar/borrar antes).
   * - Bitácora forense en vuelo_eliminado (quién, cuándo, motivo, snapshot
   *   crudo del vuelo y sus tramos) ANTES de borrar.
   * - Limpieza: eventos de Google Calendar, fotos de taco (taco-fotos) y
   *   planes de vuelo (planes-vuelo) best-effort, notificaciones ligadas, y
   *   squawks desligados a propósito (la discrepancia es del avión).
   */
  async purgeFlight(
    id: string,
    motivo: string,
    userId: string,
  ): Promise<{ deleted: true; id: string; folio: number | null }> {
    const sb = this.supabase.service;
    const { data: vuelo, error: vErr } = await sb
      .from('vuelo')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!vuelo) throw new NotFoundException(`Vuelo ${id} not found`);
    if (vuelo.estado !== 'CANCELADO') {
      throw new ConflictException(
        'Solo un vuelo CANCELADO se puede eliminar definitivamente. Cancélalo primero (o usa el borrado normal si es un borrador sin actividad).',
      );
    }
    const folio = (vuelo.folio as number | null) ?? null;
    const [cobrosRes, gastosRes, facturasRes, escalasRes] = await Promise.all([
      sb
        .from('cobro_vuelo')
        .select('id', { count: 'exact', head: true })
        .eq('vuelo_id', id),
      sb
        .from('gasto')
        .select('id', { count: 'exact', head: true })
        .eq('vuelo_id', id),
      sb
        .from('factura')
        .select('id', { count: 'exact', head: true })
        .eq('vuelo_id', id),
      sb.from('escala').select('*').eq('vuelo_id', id).order('orden'),
    ]);
    if (escalasRes.error) throw new Error(escalasRes.error.message);
    const escalas = (escalasRes.data ?? []) as Array<Record<string, unknown>>;
    if ((cobrosRes.count ?? 0) > 0) {
      throw new ConflictException(
        `El vuelo #${folio ?? '?'} tiene ${cobrosRes.count} cobro(s) registrados — el dinero jamás se borra en cascada. Elimina o reasigna los cobros primero.`,
      );
    }
    if ((facturasRes.count ?? 0) > 0) {
      throw new ConflictException(
        `El vuelo #${folio ?? '?'} tiene factura ligada (CFDI): no se puede eliminar de la base.`,
      );
    }
    if ((gastosRes.count ?? 0) > 0) {
      throw new ConflictException(
        `El vuelo #${folio ?? '?'} tiene ${gastosRes.count} gasto(s) ligados que quedarían huérfanos. Reasígnalos a otro vuelo/avión o elimínalos primero (Gastos).`,
      );
    }

    // Nombres para la bitácora (best-effort).
    const [clienteRes, aeronaveRes] = await Promise.all([
      vuelo.cliente_id
        ? sb
            .from('cliente')
            .select('nombre')
            .eq('id', vuelo.cliente_id as string)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      vuelo.aeronave_id
        ? sb
            .from('aeronave')
            .select('matricula')
            .eq('id', vuelo.aeronave_id as string)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    // Fotos de storage: recolectar los paths ANTES del delete (los tramos
    // caen por CASCADE y nadie más conoce esos paths) — patrón engines.
    const tacoPaths: string[] = [];
    const planPaths: string[] = [];
    const planPath = (raw: unknown): string | null => {
      const txt = String(raw ?? '').trim();
      if (!txt) return null;
      const marker = '/planes-vuelo/';
      const idx = txt.indexOf(marker);
      if (idx === -1) return txt;
      const resto = txt.slice(idx + marker.length).split('?')[0];
      try {
        return decodeURIComponent(resto);
      } catch {
        return resto;
      }
    };
    for (const e of escalas) {
      if (e.foto_taco_salida_url)
        tacoPaths.push(e.foto_taco_salida_url as string);
      if (e.foto_taco_llegada_url)
        tacoPaths.push(e.foto_taco_llegada_url as string);
      const p = planPath(e.foto_plan_vuelo_url);
      if (p) planPaths.push(p);
    }
    const pv = planPath(vuelo.foto_plan_vuelo_url);
    if (pv) planPaths.push(pv);

    // Bitácora forense ANTES de borrar (si el delete falla, se revierte).
    const { data: bitacora, error: bitErr } = await sb
      .from('vuelo_eliminado')
      .insert({
        vuelo_id: id,
        folio,
        cliente_nombre:
          (clienteRes.data as { nombre?: string } | null)?.nombre ?? null,
        matricula:
          (aeronaveRes.data as { matricula?: string } | null)?.matricula ??
          null,
        fecha_vuelo: vuelo.fecha_vuelo ?? null,
        estado: vuelo.estado,
        tramos: escalas.length,
        motivo: motivo.trim(),
        snapshot: { vuelo, escalas },
        eliminado_por: userId,
      })
      .select('id')
      .maybeSingle();
    if (bitErr) throw new Error(bitErr.message);

    // Eventos de Google Calendar ANTES de perder los IDs.
    await this.calendar.removeFlight(id).catch(() => undefined);
    // Squawks: la discrepancia es del AVIÓN — se desliga a propósito (el
    // SET NULL lo haría igual; hacerlo explícito documenta la intención).
    await sb
      .from('aeronave_discrepancia')
      .update({ vuelo_id: null })
      .eq('vuelo_id', id);
    await sb.from('cotizacion_version_history').delete().eq('vuelo_id', id);
    await sb.from('escala').delete().eq('vuelo_id', id);
    const { error } = await sb.from('vuelo').delete().eq('id', id);
    if (error) {
      // Revertir la bitácora: el vuelo sigue existiendo.
      if (bitacora?.id) {
        await sb.from('vuelo_eliminado').delete().eq('id', bitacora.id);
      }
      if (error.code === '23503') {
        throw new ConflictException(
          'La base bloqueó el borrado: el vuelo tiene cobros o factura ligados (capturados mientras confirmabas).',
        );
      }
      throw new Error(error.message);
    }

    // Notificaciones ligadas al vuelo (referencia débil por jsonb): fuera —
    // apuntarían a un 404. Best-effort.
    try {
      await sb.from('notificacion').delete().eq('data->>vuelo_id', id);
    } catch {
      // Best-effort: una notificación residual no rompe nada.
    }
    // Fotos: best-effort (el vuelo ya no existe; un residuo no rompe nada).
    if (tacoPaths.length > 0) {
      const { error: stErr } = await sb.storage
        .from('taco-fotos')
        .remove(tacoPaths);
      if (stErr) {
        this.logger.warn(
          `purgeFlight #${folio ?? '?'}: ${tacoPaths.length} foto(s) de taco sin borrar: ${stErr.message}`,
        );
      }
    }
    if (planPaths.length > 0) {
      const { error: stErr } = await sb.storage
        .from('planes-vuelo')
        .remove(planPaths);
      if (stErr) {
        this.logger.warn(
          `purgeFlight #${folio ?? '?'}: ${planPaths.length} plan(es) de vuelo sin borrar: ${stErr.message}`,
        );
      }
    }
    this.logger.log(
      `Vuelo #${folio ?? '?'} (${id}) eliminado DEFINITIVAMENTE por ${userId}: ${motivo.trim()}`,
    );
    return { deleted: true, id, folio };
  }

  /**
   * Reasignación de aeronave de último minuto (acordado en reunión 10 jun):
   * el vuelo original queda CANCELADO conservando sus gastos (esa matrícula
   * los absorbe: factura de operación, combustible…), y se crea un CLON con
   * la nueva aeronave que hereda cotización, fechas, tramos plan y piloto.
   * Los cobros del cliente se MUEVEN al clon (pagó el vuelo que sí sale).
   */
  async reassignAircraft(
    id: string,
    dto: { aeronave_id: string; motivo?: string },
    userId: string,
  ) {
    const sb = this.supabase.service;
    const { data: original, error: e0 } = await sb
      .from('vuelo')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (e0) throw new Error(e0.message);
    if (!original) throw new NotFoundException(`Vuelo ${id} not found`);
    if (original.estado === 'CANCELADO' || original.estado === 'COMPLETADO') {
      throw new ConflictException(
        `No se puede reasignar un vuelo ${original.estado as string}.`,
      );
    }
    // Cubierto por externo: clonar aquí dejaría un vuelo con avión propio Y
    // es_externo=true (estado imposible). El camino soportado es Editar
    // externo → "Regresar a vuelo propio" y luego asignar.
    if (original.es_externo === true) {
      throw new ConflictException(
        'Vuelo cubierto por externo: primero regrésalo a vuelo propio (Editar externo → Regresar a vuelo propio).',
      );
    }
    if (original.aeronave_id === dto.aeronave_id) {
      throw new BadRequestException(
        'Selecciona una aeronave distinta a la actual.',
      );
    }
    await this.validateAssignTargets({ aeronaveId: dto.aeronave_id });

    const { data: aeronave } = await sb
      .from('aeronave')
      .select('matricula')
      .eq('id', dto.aeronave_id)
      .maybeSingle();
    const matricula = (aeronave?.matricula as string) ?? 'otra aeronave';

    // 1) Clon con la nueva aeronave (folio/ids/google nuevos, sin capturas).
    const clonPayload: Record<string, unknown> = {
      ...(original as Record<string, unknown>),
    };
    for (const k of [
      'id',
      'folio',
      'created_at',
      'updated_at',
      'google_calendar_id',
      'foto_plan_vuelo_url',
      // GENERATED ALWAYS en la BD (se calcula sola del origen): insertarla revienta.
      'pago_anticipado_req',
    ]) {
      delete clonPayload[k];
    }
    clonPayload.aeronave_id = dto.aeronave_id;
    clonPayload.created_by = userId;
    clonPayload.updated_by = userId;
    clonPayload.notas_internas = [
      (original.notas_internas as string | null) ?? '',
      `Reasignado desde el vuelo #${original.folio as number} (cambio de aeronave a ${matricula}).`,
    ]
      .filter(Boolean)
      .join('\n');
    const { data: clon, error: e1 } = await sb
      .from('vuelo')
      .insert(clonPayload)
      .select(VUELO_COLS)
      .maybeSingle();
    if (e1) throw new Error(e1.message);

    // 2) Tramos plan del original (sin tacómetros/horas reales).
    const { data: legs } = await sb
      .from('escala')
      .select(
        'orden, origen_iata, destino_iata, millas_nauticas, pasajeros, es_ferry, es_sobrevuelo, requiere_pernocta, pernocta_costo_usd, tipo_parada, servicio_notas, fecha_salida_plan, piloto_id, estado_permiso',
      )
      .eq('vuelo_id', id)
      .order('orden', { ascending: true });
    if (legs && legs.length > 0) {
      await sb.from('escala').insert(
        legs.map((l) => ({
          ...l,
          vuelo_id: (clon as { id: string }).id,
          aeronave_id: dto.aeronave_id,
          created_by: userId,
          updated_by: userId,
        })),
      );
    }

    // 3) Historial de cotización: el clon HEREDA las versiones del original
    //    (marcadas como heredadas, conservando su fecha para no romper la
    //    cronología) y se le agrega un renglón FINAL que documenta el cambio
    //    de aeronave como la versión vigente. Así no se pierde "por qué te
    //    cobro esto" al cambiar de avión a último minuto.
    const clonId = (clon as { id: string }).id;
    const origenMatricula =
      (
        await sb
          .from('aeronave')
          .select('matricula')
          .eq('id', original.aeronave_id as string)
          .maybeSingle()
      ).data?.matricula ?? 'la aeronave anterior';

    const { data: histOriginal } = await sb
      .from('cotizacion_version_history')
      .select('*')
      .eq('vuelo_id', id)
      .order('version', { ascending: true });

    let maxVersion = Number(original.cotizacion_version) || 1;
    if (histOriginal && histOriginal.length > 0) {
      for (const h of histOriginal) {
        maxVersion = Math.max(maxVersion, Number(h.version) || 0);
      }
      const heredadas = histOriginal.map((h) => {
        const row = { ...(h as Record<string, unknown>) };
        delete row.id; // nuevo uuid
        row.vuelo_id = clonId;
        const motivoPrev = (h.motivo as string | null)?.trim();
        row.motivo = `[Heredado de la cotización #${original.folio as number}] ${motivoPrev || `Versión v${h.version as number}`}`;
        return row;
      });
      await sb.from('cotizacion_version_history').insert(heredadas);
    }

    // Renglón final: el cambio de aeronave es la versión vigente del clon.
    const nuevaVersion = maxVersion + 1;
    const c = clon as Record<string, unknown>;
    await sb.from('cotizacion_version_history').insert({
      vuelo_id: clonId,
      version: nuevaVersion,
      aeronave_id: dto.aeronave_id,
      ruta_id: c.ruta_id,
      origen_iata: c.origen_iata,
      destino_iata: c.destino_iata,
      millas_nauticas_one_way: c.millas_nauticas_one_way,
      es_redondo_auto: c.es_redondo_auto,
      num_aterrizajes: c.num_aterrizajes,
      pasajeros: c.pasajeros,
      pase_abordar: c.pase_abordar,
      tiempo_cobrable_hr: c.tiempo_cobrable_hr,
      tarifa_tipo: c.tarifa_tipo,
      tarifa_hora_usd: c.tarifa_hora_usd,
      subtotal_vuelo_usd: c.subtotal_vuelo_usd,
      tuas_usd: c.tuas_usd,
      iva_pct: c.iva_pct,
      iva_usd: c.iva_usd,
      monto_total_usd: c.monto_total_usd,
      viaticos_pernocta_usd: c.viaticos_pernocta_usd,
      extras_total_usd: c.extras_total_usd,
      ajuste_final_usd: c.ajuste_final_usd,
      metodo_cobro: c.metodo_cobro,
      calculo_snapshot: c.calculo_snapshot,
      motivo: `Cambio de aeronave: de ${origenMatricula} a ${matricula} (último minuto). Viene del vuelo #${original.folio as number}.${dto.motivo?.trim() ? ` ${dto.motivo.trim()}` : ''}`,
      created_by: userId,
    });
    // El clon queda en la versión del cambio de aeronave (la timeline la marca
    // como "actual").
    await sb
      .from('vuelo')
      .update({ cotizacion_version: nuevaVersion, updated_by: userId })
      .eq('id', clonId);
    c.cotizacion_version = nuevaVersion;

    // 4) Cobros del cliente → al vuelo que sí sale. (Los GASTOS se quedan: esa
    //    matrícula los absorbe y el siguiente vuelo solo paga su remanente.)
    await sb
      .from('cobro_vuelo')
      .update({ vuelo_id: (clon as { id: string }).id })
      .eq('vuelo_id', id);

    // 5) Original queda cancelado con el motivo auditable.
    const motivoFinal = [
      `Reasignado a ${matricula} (vuelo #${(clon as { folio: number }).folio}).`,
      dto.motivo?.trim() || null,
    ]
      .filter(Boolean)
      .join(' ');
    await sb
      .from('vuelo')
      .update({
        estado: 'CANCELADO',
        fecha_cancelacion: new Date().toISOString(),
        motivo_cancelacion: motivoFinal,
        updated_by: userId,
      })
      .eq('id', id);

    void this.calendar.syncFlight(id);
    void this.calendar.syncFlight((clon as { id: string }).id);
    // TODA la tripulación del clon (piloto, copiloto, apoyo, pilotos de
    // tramo) se entera del cambio de avión y del folio nuevo — antes solo el
    // piloto recibía un "Nuevo vuelo asignado" sin contexto (21-ago).
    const clonRow = clon as Record<string, unknown>;
    void this.notificarTripulacion(clonRow, {
      titulo: `Vuelo #${original.folio as number}: cambio de avión`,
      cuerpo: `${original.origen_iata as string} → ${original.destino_iata as string} ahora vuela en ${matricula} como vuelo #${clonRow.folio as number} (el #${original.folio as number} quedó cancelado). Misma fecha y tripulación.`,
    });
    return clon!;
  }

  /** Envía aviso de asignación al piloto (best-effort), con info de pernocta. */
  private async notifyPilotAssigned(
    pilotoId: string,
    vuelo: Record<string, unknown>,
    rol: 'piloto' | 'copiloto' = 'piloto',
  ): Promise<void> {
    const [{ data: piloto }, pernoctas, ruta] = await Promise.all([
      this.supabase.service
        .from('usuario')
        .select('nombre, email, es_piloto_externo')
        .eq('id', pilotoId)
        .maybeSingle(),
      this.pernoctasDeVuelo(vuelo.id as string),
      this.rutaDeVuelo(vuelo),
    ]);
    // Piloto externo (doc 3.7): sin acceso al sistema — ni push ni email; la
    // coordinación con él es por WhatsApp fuera del sistema.
    if ((piloto as { es_piloto_externo?: boolean } | null)?.es_piloto_externo) {
      return;
    }
    const pernoctaTxt =
      pernoctas.length > 0
        ? ` · 🌙 Pernocta en ${pernoctas.join(', ')}`
        : ' · Sin pernocta';
    // Socket + push al piloto (independiente del email).
    void this.notifications.notifyUser(pilotoId, {
      tipo: 'vuelo_asignado',
      titulo:
        rol === 'copiloto'
          ? 'Vas de copiloto en un vuelo'
          : 'Nuevo vuelo asignado',
      cuerpo: `${rol === 'copiloto' ? 'Vas de COPILOTO · ' : ''}${ruta} · folio #${vuelo.folio as number} · ${this.fechaCancunTxt(vuelo.fecha_vuelo as string | null)}${pernoctaTxt}`,
      data: { vuelo_id: vuelo.id, folio: vuelo.folio, pernoctas, rol },
      link: `/flights/${vuelo.id as string}`,
    });

    // El correo de asignación es del piloto TITULAR (plantilla "tu vuelo"):
    // al copiloto le basta el push — evita que reciba un correo como si
    // fuera el responsable del vuelo (auditoría 21-ago-2026).
    if (rol === 'copiloto') return;
    const email = (piloto as { email: string | null } | null)?.email;
    if (!email) return;
    void this.email.sendPilotAssignment({
      to: email,
      pilotoNombre: (piloto as { nombre: string }).nombre ?? 'Piloto',
      folio: vuelo.folio as number,
      origenIata: vuelo.origen_iata as string,
      destinoIata: vuelo.destino_iata as string,
      // Ruta operativa completa (con escalas): el correo no debe mostrar solo
      // CUN → CUN — el piloto necesita ver todo el itinerario.
      rutaCompleta: ruta,
      pasajeros: Number(vuelo.pasajeros ?? 0),
      fechaVuelo: (vuelo.fecha_vuelo as string | null) ?? null,
      pernoctas,
    });
  }

  // ============ Vuelos ============

  async list(filters: ListFlightsQuery, current?: AuthenticatedUser) {
    // Embed ligero opt-in (viaje multi-día): fechas por tramo para que el
    // calendario de la app pinte cada día del itinerario sin cargar el
    // snapshot completo de cada vuelo.
    const embedEscalas =
      filters.embed === 'escalas_plan'
        ? ', escalas_plan:escala(orden, origen_iata, destino_iata, fecha_salida_plan, es_ferry, cancelada_at, piloto_id)'
        : '';
    // string plano: el parser TIPADO de supabase-js no digiere el template
    // con embed condicional (truena en compilación, no en runtime).
    const selectCols: string = `${VUELO_COLS}, aeronave:aeronave_id(matricula), cliente:cliente_id(nombre), piloto:piloto_id(nombre)${embedEscalas}`;
    let q = this.supabase.service
      .from('vuelo')
      .select(selectCols, { count: 'exact' })
      .order('fecha_vuelo', { ascending: false, nullsFirst: false })
      .order('fecha_solicitud', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.cliente_id) q = q.eq('cliente_id', filters.cliente_id);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.piloto_id) {
      // Incluye vuelos donde el usuario es piloto, copiloto o APOYO del vuelo
      // (ida), o piloto de CUALQUIER tramo (p. ej. solo el regreso de un
      // redondo con pilotos distintos). Copiloto y apoyo van a nivel vuelo
      // (todo el viaje); el apoyo lo ve en su app igual que el piloto.
      const { data: legVuelos } = await this.supabase.service
        .from('escala')
        .select('vuelo_id')
        .eq('piloto_id', filters.piloto_id);
      const ids = [
        ...new Set((legVuelos ?? []).map((e) => e.vuelo_id as string)),
      ];
      const ors = [
        `piloto_id.eq.${filters.piloto_id}`,
        `copiloto_id.eq.${filters.piloto_id}`,
        `apoyo_id.eq.${filters.piloto_id}`,
      ];
      if (ids.length) ors.push(`id.in.(${ids.join(',')})`);
      q = q.or(ors.join(','));
    }
    if (filters.estado) q = q.eq('estado', filters.estado);
    if (typeof filters.es_externo === 'boolean')
      q = q.eq('es_externo', filters.es_externo);
    // Filtro de estado de COBRO (petición del cliente, jul 2026). PARCIAL y
    // SIN_COBROS necesitan saber qué vuelos tienen cobros: una consulta de
    // ids (la tabla de cobros es chica) antes de paginar.
    if (filters.cobro) {
      if (filters.cobro === 'COBRADO') {
        q = q.eq('cobrado', true);
      } else {
        // Los tres restantes son "falta saldo": excluye cobrados y los $0
        // (reservas/cotizaciones sin precio no son cuentas por cobrar).
        q = q.eq('cobrado', false).gt('monto_total_usd', 0);
        if (filters.cobro !== 'POR_COBRAR') {
          const { data: conCobro, error: cobrosErr } =
            await this.supabase.service
              .from('cobro_vuelo')
              .select('vuelo_id')
              .limit(10000);
          if (cobrosErr) throw new Error(cobrosErr.message);
          const ids = [
            ...new Set((conCobro ?? []).map((c) => c.vuelo_id as string)),
          ];
          if (filters.cobro === 'PARCIAL') {
            // Con abonos y saldo pendiente.
            if (ids.length === 0)
              return {
                data: [],
                count: 0,
                limit: filters.limit,
                offset: filters.offset,
              };
            q = q.in('id', ids);
          } else {
            // SIN_COBROS: con precio y ni un cobro registrado.
            if (ids.length > 0) q = q.not('id', 'in', `(${ids.join(',')})`);
          }
        }
      }
    }
    // Fecha simple (filtros del panel) = límites del DÍA CANCÚN (regla del
    // repo); un ISO con hora (app) pasa tal cual.
    const soloFecha = /^\d{4}-\d{2}-\d{2}$/;
    // Solapamiento de rango [fecha_vuelo, fecha_fin] (viaje multi-día): un
    // vuelo cuenta en todo día que su itinerario toque — el home del piloto
    // lo necesita para ver su viaje el día del regreso. OJO: este eje es
    // SOLO del listado; el dinero del cierre mensual sigue en fecha_vuelo
    // (reportes/pre-cierre no cambian).
    if (filters.desde)
      q = q.gte(
        'fecha_fin',
        soloFecha.test(filters.desde)
          ? `${filters.desde}T00:00:00-05:00`
          : filters.desde,
      );
    if (filters.hasta)
      q = q.lte(
        'fecha_vuelo',
        soloFecha.test(filters.hasta)
          ? `${filters.hasta}T23:59:59-05:00`
          : filters.hasta,
      );

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    // Aplana matrícula + nombre de cliente/piloto para el listado (móvil/portal):
    // el selector de vuelos del app los usa para buscar e identificar el vuelo.
    const flatten = (
      rel: { nombre?: string } | { nombre?: string }[] | null | undefined,
    ) => (Array.isArray(rel) ? rel[0]?.nombre : rel?.nombre) ?? null;
    const rows = (data ?? []).map((r) => {
      const row = r as unknown as Record<string, unknown> & {
        aeronave?: { matricula?: string } | { matricula?: string }[] | null;
        cliente?: { nombre?: string } | { nombre?: string }[] | null;
        piloto?: { nombre?: string } | { nombre?: string }[] | null;
      };
      const a = row.aeronave;
      const matricula = Array.isArray(a) ? a[0]?.matricula : a?.matricula;
      const {
        aeronave: _omit,
        cliente: _omitCli,
        piloto: _omitPil,
        ...rest
      } = row;
      void _omit;
      void _omitCli;
      void _omitPil;
      return {
        ...rest,
        aeronave_matricula: matricula ?? null,
        cliente_nombre: flatten(row.cliente),
        piloto_nombre: flatten(row.piloto),
      };
    });
    // Ruta COMPLETA por vuelo (origen → escalas → destino) para los listados:
    // se resuelve en lote desde las escalas comerciales, no solo origen/destino.
    const rutas = await this.rutasIatasPorVuelo(
      rows.map((r) => (r as Record<string, unknown>).id as string),
    );
    const rowsConRuta = rows.map((r) => {
      const row = r as Record<string, unknown>;
      // Misma redacción por rol que findById/snapshot: el listado es la ruta
      // más usada por la app (el mecánico lista TODOS los vuelos) y sin esto
      // el candado de costo_externo_usd quedaba abierto por aquí.
      return this.redactVueloForRol(
        {
          ...row,
          ruta_iatas:
            rutas.get(row.id as string) ??
            [row.origen_iata as string, row.destino_iata as string].filter(
              Boolean,
            ),
        },
        current,
      );
    });
    return {
      data: rowsConRuta,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /**
   * Para un lote de vuelos, devuelve la cadena de puntos de la ruta OPERATIVA
   * completa (origen del primer tramo + destino de cada tramo, en orden),
   * INCLUYENDO los tramos solo_operativa (ferry/posicionamiento): este módulo
   * es la operación, y un reposicionamiento CUN→PCE se listaba como "CUN→CUN"
   * (el espejo comercial) al excluirlos. La ruta COMERCIAL (solo tramos
   * cobrables) vive en el listado de Cotizaciones, que tiene su propia copia.
   * Map vacío para vuelos sin escalas (el caller cae a origen/destino).
   */
  private async rutasIatasPorVuelo(
    vueloIds: string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (vueloIds.length === 0) return out;
    const { data } = await this.supabase.service
      .from('escala')
      .select('vuelo_id, orden, origen_iata, destino_iata')
      .in('vuelo_id', vueloIds)
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

  /**
   * Redacción por rol para la app de campo: PILOTO/MECANICO no reciben el
   * costo pactado con el operador externo (dato financiero interno del
   * margen). `operador_externo` y `notas_internas` NO se redactan: la app
   * Flutter los pinta (nombre del operador en tarjetas/listas y notas
   * internas en el detalle del vuelo). `comision_vendedor_*` no forma parte
   * de VUELO_COLS, así que estos endpoints nunca lo devuelven. Sin `current`
   * (llamadas internas / panel) se devuelve todo.
   */
  private redactVueloForRol<T extends Record<string, unknown>>(
    vuelo: T,
    current?: AuthenticatedUser,
  ): T {
    if (
      !current ||
      (current.rol !== Rol.PILOTO && current.rol !== Rol.MECANICO)
    ) {
      return vuelo;
    }
    const copia: Record<string, unknown> = { ...vuelo };
    delete copia.costo_externo_usd;
    return copia as T;
  }

  async findById(id: string, current?: AuthenticatedUser) {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(VUELO_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${id} not found`);
    return this.redactVueloForRol(data, current);
  }

  // ===== Aislamiento de pilotos (Tarea 15) =====

  /**
   * Un PILOTO solo puede operar/ver vuelos asignados a él: al vuelo (ida,
   * como piloto, copiloto o APOYO en tierra) o a CUALQUIER tramo (p. ej. solo
   * el regreso de un redondo). El apoyo ve y opera TODO igual que el piloto
   * — su único candado extra es el de tacómetros (assertPuedeCapturarTaco).
   * Otros roles no se restringen.
   */
  async assertAccess(
    vueloId: string,
    current: AuthenticatedUser,
  ): Promise<void> {
    // El VISITANTE no tiene NADA de vuelos (27-ago).
    if (current.rol === Rol.VISITANTE) {
      throw new ForbiddenException('El visitante no tiene acceso a vuelos.');
    }
    if (current.rol !== Rol.PILOTO) return;
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('piloto_id, copiloto_id, apoyo_id')
      .eq('id', vueloId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${vueloId} not found`);
    if (
      data.piloto_id === current.userId ||
      data.copiloto_id === current.userId ||
      data.apoyo_id === current.userId
    )
      return;
    // ¿Asignado a algún tramo de este vuelo?
    const { data: leg } = await this.supabase.service
      .from('escala')
      .select('id')
      .eq('vuelo_id', vueloId)
      .eq('piloto_id', current.userId)
      .limit(1)
      .maybeSingle();
    if (!leg) {
      throw new ForbiddenException('No tienes acceso a este vuelo');
    }
  }

  /** Igual que assertAccess pero resolviendo el vuelo a partir de la escala (leg). */
  async assertAccessByLeg(
    legId: string,
    current: AuthenticatedUser,
  ): Promise<void> {
    if (current.rol === Rol.VISITANTE) {
      throw new ForbiddenException('El visitante no tiene acceso a vuelos.');
    }
    if (current.rol !== Rol.PILOTO) return;
    const { data, error } = await this.supabase.service
      .from('escala')
      .select('vuelo_id')
      .eq('id', legId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Escala ${legId} not found`);
    await this.assertAccess(data.vuelo_id as string, current);
  }

  /**
   * Candado de tacómetros del APOYO: sustituye a assertAccessByLeg en las
   * rutas de taco del piloto (captura y lectura IA) — valida ACCESO y permiso
   * de captura con las mismas lecturas (sin queries extra). El apoyo ve y
   * opera el vuelo igual que el piloto, pero los tacómetros los captura quien
   * vuela: si la ÚNICA relación del solicitante con el vuelo es apoyo_id (no
   * es piloto, ni copiloto, ni piloto de tramo) se rechaza. confirmTaco es de
   * oficina (roles admin) y no pasa por aquí. Otros roles no se restringen.
   */
  async assertPuedeCapturarTaco(
    legId: string,
    current: AuthenticatedUser,
  ): Promise<void> {
    if (current.rol !== Rol.PILOTO) return;
    const { data: escala, error } = await this.supabase.service
      .from('escala')
      .select('vuelo_id')
      .eq('id', legId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!escala) throw new NotFoundException(`Escala ${legId} not found`);
    const vueloId = escala.vuelo_id as string;
    const { data, error: vErr } = await this.supabase.service
      .from('vuelo')
      .select('piloto_id, copiloto_id, apoyo_id')
      .eq('id', vueloId)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!data) throw new NotFoundException(`Vuelo ${vueloId} not found`);
    if (
      data.piloto_id === current.userId ||
      data.copiloto_id === current.userId
    )
      return;
    // ¿Piloto de algún tramo? (p. ej. solo el regreso de un redondo)
    const { data: leg } = await this.supabase.service
      .from('escala')
      .select('id')
      .eq('vuelo_id', vueloId)
      .eq('piloto_id', current.userId)
      .limit(1)
      .maybeSingle();
    if (leg) return;
    if (data.apoyo_id === current.userId) {
      throw new ForbiddenException(
        'Vas de APOYO en este vuelo: los tacómetros los captura el piloto.',
      );
    }
    throw new ForbiddenException('No tienes acceso a este vuelo');
  }

  /**
   * Vista de cotización SEGURA para el piloto: solo campos no sensibles
   * (cliente, ruta, pasajeros, fechas, escalas, monto total cobrable). Oculta
   * comisiones, plataforma de cobro, IVA desglosado, overrides, márgenes y
   * costos internos. Un PILOTO solo puede ver el vuelo asignado a él.
   */
  async quoteView(id: string, current: AuthenticatedUser) {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, tipo, estado, origen_iata, destino_iata, pasajeros, pasajeros_nombres, monto_total_usd, fecha_vuelo, fecha_traslado_final, piloto_id, copiloto_id, apoyo_id, es_externo, cliente:cliente_id(nombre)',
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${id} not found`);

    const v = data as unknown as {
      id: string;
      folio: number;
      tipo: string;
      estado: string;
      origen_iata: string;
      destino_iata: string;
      pasajeros: number;
      pasajeros_nombres: string[] | null;
      monto_total_usd: string | number;
      fecha_vuelo: string | null;
      fecha_traslado_final: string | null;
      piloto_id: string | null;
      copiloto_id: string | null;
      apoyo_id: string | null;
      es_externo: boolean;
      cliente: { nombre: string } | { nombre: string }[] | null;
    };

    const todasEscalas = await this.listEscalas(id);
    // La COTIZACIÓN refleja lo contratado: solo tramos comerciales (los
    // operativos internos viven en la operación del vuelo, no se cobran).
    const escalas = todasEscalas.filter(
      (e) => (e as { solo_operativa?: boolean }).solo_operativa !== true,
    );

    // Acceso: el piloto puede ver la cotización si está asignado al vuelo (ida),
    // como COPILOTO o como APOYO (a nivel vuelo: acompañan todo el viaje,
    // igual que en assertAccess y en el listado) o a cualquier tramo (p. ej.
    // solo el regreso de un redondo con pilotos distintos).
    if (current.rol === Rol.PILOTO) {
      const asignadoATramo = todasEscalas.some(
        (e) => e.piloto_id === current.userId,
      );
      if (
        v.piloto_id !== current.userId &&
        v.copiloto_id !== current.userId &&
        v.apoyo_id !== current.userId &&
        !asignadoATramo
      ) {
        throw new ForbiddenException(
          'No puedes ver la cotización de un vuelo que no tienes asignado',
        );
      }
    }

    const clienteRaw = v.cliente;
    const cliente = Array.isArray(clienteRaw) ? clienteRaw[0] : clienteRaw;

    return {
      id: v.id,
      folio: v.folio,
      tipo: v.tipo,
      estado: v.estado,
      cliente_nombre: cliente?.nombre ?? null,
      origen_iata: v.origen_iata,
      destino_iata: v.destino_iata,
      pasajeros: v.pasajeros,
      pasajeros_nombres: v.pasajeros_nombres ?? [],
      fecha_traslado_inicial: v.fecha_vuelo,
      fecha_traslado_final: v.fecha_traslado_final,
      monto_total_usd: Number(v.monto_total_usd),
      moneda: 'USD' as const,
      escalas: escalas.map((e) => ({
        orden: e.orden,
        origen_iata: e.origen_iata,
        destino_iata: e.destino_iata,
        // Datos operativos por tramo (sin financieros) para que el piloto vea su tramo.
        piloto_id: e.piloto_id ?? null,
        estado_permiso: e.estado_permiso ?? null,
        fecha_salida_plan: e.fecha_salida_plan ?? null,
        // Detalle por tramo: el piloto necesita ver cuánta gente sube en cada
        // escala, si es ferry/pernocta/parada de servicio, y la nota operativa.
        pasajeros: (e as { pasajeros?: number | null }).pasajeros ?? null,
        es_ferry: (e as { es_ferry?: boolean }).es_ferry === true,
        requiere_pernocta:
          (e as { requiere_pernocta?: boolean }).requiere_pernocta === true,
        pernocta_costo_usd:
          (e as { pernocta_costo_usd?: number | null }).pernocta_costo_usd ??
          null,
        tipo_parada:
          (e as { tipo_parada?: string | null }).tipo_parada ?? 'NORMAL',
        servicio_notas:
          (e as { servicio_notas?: string | null }).servicio_notas ?? null,
        notas: (e as { notas?: string | null }).notas ?? null,
      })),
    };
  }

  /**
   * Matrícula + velocidad crucero del avión del vuelo en UNA lectura: el
   * snapshot usa la matrícula para el encabezado y la velocidad para el
   * estimado de duración por distancia (fallback sin histórico).
   */
  private async aeronaveResumen(
    aeronaveId: string | null | undefined,
  ): Promise<{
    matricula: string | null;
    velocidad_crucero_kts: number | null;
  } | null> {
    if (!aeronaveId) return null;
    const { data } = await this.supabase.service
      .from('aeronave')
      .select('matricula, velocidad_crucero_kts')
      .eq('id', aeronaveId)
      .maybeSingle();
    if (!data) return null;
    const row = data as {
      matricula?: string;
      velocidad_crucero_kts?: number | string | null;
    };
    const vel = Number(row.velocidad_crucero_kts);
    return {
      matricula: row.matricula ?? null,
      velocidad_crucero_kts: Number.isFinite(vel) && vel > 0 ? vel : null,
    };
  }

  async snapshot(id: string, current?: AuthenticatedUser) {
    const vuelo = await this.findById(id, current);
    const aeronaveId =
      ((vuelo as { aeronave_id?: string | null }).aeronave_id as
        | string
        | null) ?? null;
    const apoyoId =
      ((vuelo as { apoyo_id?: string | null }).apoyo_id as string | null) ??
      null;
    const pilotoId =
      ((vuelo as { piloto_id?: string | null }).piloto_id as string | null) ??
      null;
    const copilotoId =
      ((vuelo as { copiloto_id?: string | null }).copiloto_id as
        | string
        | null) ?? null;
    const [
      escalas,
      cobros,
      aeronave,
      ultimoTacoAvion,
      ultimoTacoDetalle,
      apoyoNombre,
      pilotoNombre,
      copilotoNombre,
    ] = await Promise.all([
      this.listEscalas(id),
      this.listCobros(id),
      this.aeronaveResumen(aeronaveId),
      // Referencia para la app: validación en vivo de la SALIDA del tramo 1
      // (excepción donde el piloto sí fotografía la salida) — el tacómetro
      // nunca retrocede respecto al último taco conocido del avión.
      this.ultimoTacoAeronave(aeronaveId, null),
      // Informativo para el piloto: último taco del avión con procedencia,
      // para cotejar contra el tacómetro físico antes de capturar.
      this.ultimoTacoAeronaveDetalle(aeronaveId),
      this.nombreUsuario(apoyoId),
      // La app pinta la asignación en el DETALLE: sin estos nombres el vuelo
      // decía "Sin asignar" aunque el piloto sí estuviera asignado (#120).
      this.nombreUsuario(pilotoId),
      this.nombreUsuario(copilotoId),
    ]);
    const escalasEnriquecidas = await this.attachTramoEstimado(
      await this.enrichEscalasAssignment(escalas),
      aeronave?.velocidad_crucero_kts ?? null,
    );
    // total_cobrado SIEMPRE en USD vía la fuente única (invariante 2 del
    // repo): la suma cruda mezclaba monedas y un cobro parcial en MXN
    // inflaba el total — la app del piloto bloqueaba el cobro del saldo y el
    // panel pintaba pendientes negativos. Los MXN sin TC quedan expuestos.
    const conv = cobrosEnUsd(
      cobros,
      Number((vuelo as { tc_usd_mxn?: unknown }).tc_usd_mxn) || null,
    );
    // La app esconde la captura de tacómetros con esta bandera: true cuando el
    // solicitante va de APOYO y esa es su ÚNICA relación con el vuelo (no es
    // piloto, ni copiloto, ni piloto de tramo) — misma regla que el candado
    // del servidor (assertPuedeCapturarTaco).
    const esApoyo =
      current?.rol === Rol.PILOTO &&
      apoyoId != null &&
      apoyoId === current.userId &&
      (vuelo as { piloto_id?: string | null }).piloto_id !== current.userId &&
      (vuelo as { copiloto_id?: string | null }).copiloto_id !==
        current.userId &&
      !escalasEnriquecidas.some((e) => e.piloto_id === current.userId);
    return {
      ...vuelo,
      aeronave_matricula: aeronave?.matricula ?? null,
      piloto_nombre: pilotoNombre,
      copiloto_nombre: copilotoNombre,
      apoyo_nombre: apoyoNombre,
      es_apoyo: esApoyo,
      ultimo_taco_avion: ultimoTacoAvion,
      ultimo_taco_avion_detalle: ultimoTacoDetalle,
      escalas: escalasEnriquecidas,
      cobros,
      total_cobrado: Math.round(conv.total_usd * 100) / 100,
      cobros_sin_tc_count: conv.sin_tc_count,
      cobros_sin_tc_mxn: conv.sin_tc_mxn,
    };
  }

  /** Nombre de un usuario por id (lookup ligero; null si no hay id). */
  private async nombreUsuario(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const { data } = await this.supabase.service
      .from('usuario')
      .select('nombre')
      .eq('id', userId)
      .maybeSingle();
    return (data?.nombre as string | null) ?? null;
  }

  /**
   * Resuelve por lote matrícula de aeronave y nombre de piloto para cada tramo,
   * para que el admin pueda mostrar la asignación por tramo (ida/regreso).
   */
  private async enrichEscalasAssignment(
    escalas: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    if (escalas.length === 0) return escalas;
    const aeronaveIds = [
      ...new Set(escalas.map((e) => e.aeronave_id).filter(Boolean) as string[]),
    ];
    const pilotoIds = [
      ...new Set(escalas.map((e) => e.piloto_id).filter(Boolean) as string[]),
    ];
    const [aeronaves, pilotos] = await Promise.all([
      aeronaveIds.length
        ? this.supabase.service
            .from('aeronave')
            .select('id, matricula')
            .in('id', aeronaveIds)
        : Promise.resolve({ data: [] as { id: string; matricula: string }[] }),
      pilotoIds.length
        ? this.supabase.service
            .from('usuario')
            .select('id, nombre')
            .in('id', pilotoIds)
        : Promise.resolve({ data: [] as { id: string; nombre: string }[] }),
    ]);
    const matriculaPorId = new Map(
      (aeronaves.data ?? []).map((a) => [a.id, a.matricula]),
    );
    const nombrePorId = new Map(
      (pilotos.data ?? []).map((p) => [p.id, p.nombre]),
    );
    return escalas.map((e) => ({
      ...e,
      aeronave_matricula: e.aeronave_id
        ? (matriculaPorId.get(e.aeronave_id as string) ?? null)
        : null,
      piloto_nombre: e.piloto_id
        ? (nombrePorId.get(e.piloto_id as string) ?? null)
        : null,
    }));
  }

  /**
   * Adjunta a cada tramo referencias de duración y de lectura (la app del
   * piloto las usa para el recordatorio local offline y para VALIDAR EN VIVO
   * al capturar — advertir, nunca bloquear):
   *  - `tramo_min_promedio`: minutos según histórico, SOLO si es confiable
   *    (>= MIN_MUESTRAS). Null si aún no hay historial del tramo.
   *  - `tramo_min_estimado`: fallback SIEMPRE disponible = millas náuticas por
   *    aerovía (distancia_tramo) / velocidad crucero del avión del vuelo.
   *    Null si falta la distancia del par o la velocidad.
   *  - `tramo_llegada_anterior`: taco_llegada del tramo previo del MISMO avión
   *    (null en el primero) — para advertir una foto/valor repetido (caso
   *    vuelo #71: la llegada del tramo 1 se capturó también como llegada del
   *    tramo 2).
   */
  private async attachTramoEstimado(
    escalas: Array<Record<string, unknown>>,
    velocidadCruceroKts: number | null,
  ): Promise<Array<Record<string, unknown>>> {
    if (escalas.length === 0) return escalas;
    const pares = [
      ...new Set(
        escalas.map(
          (e) => `${e.origen_iata as string}|${e.destino_iata as string}`,
        ),
      ),
    ];
    const minPorPar = new Map<string, number>();
    const estPorPar = new Map<string, number>();
    await Promise.all(
      pares.map(async (par) => {
        const [o, d] = par.split('|');
        const [t, est] = await Promise.all([
          this.getTramoPromedio(o, d),
          this.getTramoMinEstimado(o, d, velocidadCruceroKts),
        ]);
        if (t && t.muestras >= MIN_MUESTRAS && t.minutos_promedio > 0) {
          minPorPar.set(par, Math.round(t.minutos_promedio));
        }
        if (est !== null) estPorPar.set(par, est);
      }),
    );
    return escalas.map((e, i) => {
      // Tramo previo del MISMO avión (cada matrícula lleva su horómetro):
      // el más cercano hacia atrás por orden. listEscalas ya viene ordenado.
      const prev = escalas
        .slice(0, i)
        .reverse()
        .find(
          (p) =>
            ((p.aeronave_id as string | null) ?? null) ===
            ((e.aeronave_id as string | null) ?? null),
        );
      const par = `${e.origen_iata as string}|${e.destino_iata as string}`;
      return {
        ...e,
        tramo_min_promedio: minPorPar.get(par) ?? null,
        tramo_min_estimado: estPorPar.get(par) ?? null,
        tramo_llegada_anterior:
          prev == null || prev.taco_llegada == null
            ? null
            : Number(prev.taco_llegada),
      };
    });
  }

  async update(id: string, dto: UpdateFlightDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const current = await this.findById(id);
    // El método de cobro pactado SOLO se edita aquí en vuelos externos sin
    // desglose canónico (los externos viejos nacían sin método y por eso no
    // salían en Facturas). En vuelos cotizados se cambia REVISANDO la
    // cotización: el método define el IVA y el total debe recalcularse.
    if (dto.metodo_cobro !== undefined) {
      const { data: snap } = await this.supabase.service
        .from('vuelo')
        .select('calculo_snapshot')
        .eq('id', id)
        .maybeSingle();
      if (!current.es_externo || snap?.calculo_snapshot != null) {
        throw new ConflictException(
          'Este vuelo tiene desglose de cotización: cambia el método de cobro revisando la cotización (recalcula el IVA).',
        );
      }
      if (current.facturado) {
        throw new ConflictException(
          'El vuelo ya está facturado; el método de cobro ya no puede cambiarse.',
        );
      }
    }
    // COMPLETADO sigue editable ÚNICAMENTE para poner el método de cobro (la
    // bandeja de Facturas incluye vuelos completados por cobrar).
    const soloMetodoCobro = Object.keys(dto).every((k) => k === 'metodo_cobro');
    if (
      current.estado === 'CANCELADO' ||
      (current.estado === 'COMPLETADO' && !soloMetodoCobro)
    ) {
      throw new ConflictException(
        `No se puede modificar un vuelo en estado ${current.estado}`,
      );
    }

    // Operación y administración son caminos independientes: el piloto se puede
    // asignar aunque la cotización no esté confirmada (decisión Itzel/Alejandro).
    const asignandoPiloto =
      dto.piloto_id !== undefined &&
      dto.piloto_id !== null &&
      dto.piloto_id !== '';
    // Doc 4.3, mismo candado que assign(): documento crítico vencido bloquea
    // también la asignación de piloto desde "Editar".
    if (asignandoPiloto) {
      await this.validateAssignTargets({ pilotoId: dto.piloto_id });
    }

    const patch: Record<string, unknown> = { ...dto, updated_by: updatedBy };
    if (dto.fecha_vuelo) patch.fecha_vuelo = dto.fecha_vuelo.toISOString();
    if (dto.fecha_traslado_final) {
      patch.fecha_traslado_final = dto.fecha_traslado_final.toISOString();
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update(patch)
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }
    // Espejo: al cambiar la fecha general (traslado inicial) desde "Editar",
    // el tramo 1 la refleja — es la salida real del itinerario (feedback de
    // pruebas: "cambié la hora y no se actualiza").
    if (dto.fecha_vuelo !== undefined || dto.piloto_id !== undefined) {
      await this.mirrorVueloToIdaEscala(id, {
        piloto_id: dto.piloto_id,
        fecha_salida_plan:
          dto.fecha_vuelo !== undefined
            ? dto.fecha_vuelo.toISOString()
            : undefined,
      });
    }
    void this.calendar.syncFlight(id);
    if (asignandoPiloto && dto.piloto_id !== current.piloto_id) {
      void this.notifyPilotAssigned(dto.piloto_id!, data!);
    }
    // Piloto REEMPLAZADO o quitado: el anterior también se entera (21-ago).
    if (
      dto.piloto_id !== undefined &&
      current.piloto_id &&
      current.piloto_id !== dto.piloto_id
    ) {
      this.notificarQuitado(
        current.piloto_id as string,
        data!,
        'piloto',
        `${current.origen_iata as string} → ${current.destino_iata as string}`,
      );
    }
    // Reagenda de último minuto (doc 4.3: "si Itzel cambia el vuelo a las 8am
    // y el piloto lo ve a las 10am es un problema grave"): si cambió la fecha
    // se avisa a TODA la tripulación vigente (piloto, copiloto, apoyo y
    // pilotos de tramo) — el recién asignado ya recibió su aviso.
    const fechaCambio =
      dto.fecha_vuelo !== undefined &&
      this.fechaCambia(dto.fecha_vuelo, current.fecha_vuelo);
    // El REGRESO también es reagenda (26-ago): cambiar fecha_traslado_final
    // era mudo y el tramo de regreso conservaba su fecha vieja en el
    // calendario de la app.
    const regresoCambio =
      dto.fecha_traslado_final !== undefined &&
      dto.fecha_traslado_final !== null &&
      this.fechaCambia(dto.fecha_traslado_final, current.fecha_traslado_final);
    if (regresoCambio) {
      await this.mirrorRegresoAUltimaEscala(id, dto.fecha_traslado_final!);
    }
    if (fechaCambio || regresoCambio) {
      const excluir =
        asignandoPiloto && dto.piloto_id !== current.piloto_id
          ? [dto.piloto_id!]
          : [];
      const partes: string[] = [];
      if (fechaCambio) {
        partes.push(`ahora sale ${this.fechaCancunTxt(dto.fecha_vuelo)}`);
      }
      if (regresoCambio) {
        partes.push(
          `el REGRESO ahora sale ${this.fechaCancunTxt(dto.fecha_traslado_final)}`,
        );
      }
      void this.notificarTripulacion(
        data!,
        {
          titulo: `Vuelo #${current.folio as number} reagendado`,
          cuerpo: `${current.origen_iata as string} → ${current.destino_iata as string} ${partes.join(' y ')} (hora Cancún).`,
        },
        excluir,
      );
    }
    // Permiso de pista emitido (pendiente → emitido): avisa a admin/coordinador.
    if (
      dto.estado_permiso === 'emitido' &&
      current.estado_permiso !== 'emitido'
    ) {
      const payload = {
        tipo: 'permiso_emitido',
        titulo: 'Permiso de pista emitido',
        cuerpo: `${current.origen_iata} → ${current.destino_iata} · folio #${current.folio}`,
        data: { vuelo_id: id, folio: current.folio },
        link: `/admin/flights/${id}`,
      };
      void this.notifications.notifyRole(Rol.ADMIN, payload, updatedBy);
      void this.notifications.notifyRole(Rol.COORDINADOR, payload, updatedBy);
    }
    return data!;
  }

  /**
   * Actualiza SOLO el permiso de pista. Lo pueden hacer Admin/Coordinador y el
   * piloto asignado al vuelo (p. ej. cuando el piloto recibe el permiso en el
   * aeropuerto). Al pasar a "emitido" avisa a Admin/Coordinador.
   */
  async updatePermiso(
    id: string,
    estadoPermiso: 'no_aplica' | 'pendiente' | 'emitido',
    user: { userId: string; rol: Rol },
  ) {
    const current = await this.findById(id);
    if (user.rol === Rol.PILOTO && current.piloto_id !== user.userId) {
      throw new ForbiddenException(
        'Solo el piloto asignado puede actualizar el permiso de este vuelo',
      );
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({ estado_permiso: estadoPermiso, updated_by: user.userId })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Flight ${id} not found`);
    // El botón a NIVEL VUELO habla de todo el vuelo: propaga a TODOS los
    // tramos vivos que requieren permiso (estado ≠ no_aplica), no solo a la
    // ida. Espejar solo orden=1 dejaba el regreso pendiente (misma pista) y
    // la re-derivación regresaba el vuelo a "pendiente"; y un vuelo cuyo
    // único tramo vivo es orden=2 (ida cancelada, caso #96) no espejaba nada.
    const { error: escErr } = await this.supabase.service
      .from('escala')
      .update({ estado_permiso: estadoPermiso, updated_by: user.userId })
      .eq('vuelo_id', id)
      .is('cancelada_at', null)
      .neq('estado_permiso', 'no_aplica');
    if (escErr)
      this.logger.warn(
        `No se pudo propagar el permiso a los tramos del vuelo ${id}: ${escErr.message}`,
      );
    void this.calendar.syncFlight(id);
    if (estadoPermiso === 'emitido' && current.estado_permiso !== 'emitido') {
      const payload = {
        tipo: 'permiso_emitido',
        titulo: 'Permiso de pista emitido',
        cuerpo: `${current.origen_iata} → ${current.destino_iata} · folio #${current.folio}`,
        data: { vuelo_id: id, folio: current.folio },
        link: `/admin/flights/${id}`,
      };
      void this.notifications.notifyRole(Rol.ADMIN, payload, user.userId);
      void this.notifications.notifyRole(Rol.COORDINADOR, payload, user.userId);
    }
    // Mismo espejo de redacción que setFlightPlan: el PILOTO actualiza el
    // permiso y no debe recibir el costo del operador externo de vuelta.
    return this.redactVueloForRol(data, {
      userId: user.userId,
      rol: user.rol,
    } as AuthenticatedUser);
  }

  /**
   * Guarda la foto del plan de vuelo de salida (vuelos hacia/desde pistas con
   * permiso). La sube el piloto desde la app; opcional, no bloqueante.
   */
  async setFlightPlan(
    id: string,
    fotoUrl: string,
    userId: string,
    actor?: AuthenticatedUser,
  ) {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({ foto_plan_vuelo_url: fotoUrl, updated_by: userId })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${id} not found`);
    // Misma redacción por rol que el resto de caminos que devuelven el vuelo:
    // el piloto adjunta el plan y no debe recibir el costo del operador.
    return this.redactVueloForRol(data, actor);
  }

  /**
   * URL firmada (1 h) de la foto del plan de vuelo (bucket PRIVADO
   * `planes-vuelo`). `foto_plan_vuelo_url` guarda el PATH dentro del bucket
   * (p. ej. `vuelo-<id>/plan-<ts>.jpg`); filas viejas guardaron la URL
   * pública completa (que da 400 al ser privado el bucket) — de esas se
   * extrae el path después de `/planes-vuelo/` sin migrar datos.
   */
  async flightPlanUrl(id: string): Promise<{ url: string | null }> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('foto_plan_vuelo_url')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${id} not found`);
    const raw = ((data.foto_plan_vuelo_url as string | null) ?? '').trim();
    if (!raw) return { url: null };
    let path = raw;
    const marker = '/planes-vuelo/';
    const idx = raw.indexOf(marker);
    if (idx !== -1) {
      // Compat: URL completa del bucket (pública o firmada) → solo el path.
      const resto = raw.slice(idx + marker.length).split('?')[0];
      try {
        path = decodeURIComponent(resto);
      } catch {
        path = resto; // valor malformado: se intenta tal cual
      }
    }
    const { data: signed, error: signErr } = await this.supabase.service.storage
      .from('planes-vuelo')
      .createSignedUrl(path, 3600);
    if (signErr || !signed?.signedUrl) {
      this.logger.warn(
        `flightPlanUrl: no se pudo firmar "${path}" del vuelo ${id}: ${signErr?.message ?? 'sin URL'}`,
      );
      return { url: null };
    }
    return { url: signed.signedUrl };
  }

  /**
   * True si la aeronave tiene un servicio de mantenimiento en curso (EN_TALLER).
   * Se usa para impedir asignarla a vuelos (Doc 4.3: "no en mantenimiento").
   */
  async aircraftEnTaller(aeronaveId: string): Promise<boolean> {
    const { data, error } = await this.supabase.service
      .from('mantenimiento')
      .select('id')
      .eq('aeronave_id', aeronaveId)
      .eq('estado', 'EN_TALLER')
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  }

  /**
   * Disponibilidad de pilotos para asignar este vuelo: marca conflicto si el
   * piloto ya tiene otro vuelo (no cancelado) el mismo día, y sus horas voladas
   * del mes del vuelo vs. el límite informativo de 90 hrs (doc 5.6/5.10).
   */
  async pilotosDisponibilidad(flightId: string) {
    const LIMITE_HORAS_MES = 90;
    const { data: flight } = await this.supabase.service
      .from('vuelo')
      .select('id, fecha_vuelo')
      .eq('id', flightId)
      .maybeSingle();
    const fecha = (flight?.fecha_vuelo as string | null) ?? null;
    // Día del vuelo en CANCÚN (regla del repo): slice(0,10) del ISO UTC ponía
    // los vuelos nocturnos (22:00 Cancún = día UTC siguiente) en el día
    // equivocado para conflictos y descansos.
    const dayCancun = fecha
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Cancun',
        }).format(new Date(fecha))
      : null;

    const { data: pilots } = await this.supabase.service
      .from('usuario')
      .select('id, nombre')
      .or('rol.eq.PILOTO,es_piloto.eq.true')
      .eq('estado', 'ACTIVO')
      .order('nombre', { ascending: true });

    // Conflicto: otro vuelo (no cancelado) del mismo piloto ese día.
    const conflicto = new Map<string, number>();
    if (dayCancun) {
      const day = dayCancun;
      // Solapamiento [fecha_vuelo, fecha_fin]: el piloto en el día 2..N de
      // un viaje multi-día también está ocupado — con el eje viejo aparecía
      // libre y se le podía doble-asignar sin aviso.
      const { data: sameDay } = await this.supabase.service
        .from('vuelo')
        .select('id, folio, piloto_id')
        .lte('fecha_vuelo', `${day}T23:59:59-05:00`)
        .gte('fecha_fin', `${day}T00:00:00-05:00`)
        .neq('estado', 'CANCELADO')
        .neq('id', flightId)
        .not('piloto_id', 'is', null);
      for (const f of sameDay ?? []) {
        if (f.piloto_id)
          conflicto.set(f.piloto_id as string, f.folio as number);
      }
    }

    // Horas voladas (escalas de vuelos COMPLETADOS) en el mes del vuelo.
    const horas = new Map<string, number>();
    if (fecha) {
      // Mes calendario en hora CANCÚN (regla del repo): con Date.UTC un vuelo
      // del día último en la noche caía en el mes siguiente.
      const diaCancun = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Cancun',
      }).format(new Date(fecha));
      const [anio, mes] = diaCancun.split('-').map(Number);
      const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
      const mDesde = `${diaCancun.slice(0, 7)}-01T00:00:00-05:00`;
      const mHasta = `${diaCancun.slice(0, 7)}-${String(ultimoDia).padStart(2, '0')}T23:59:59-05:00`;
      // Sin exigir piloto a nivel vuelo: el del tramo también cuenta.
      const { data: vuelosMes } = await this.supabase.service
        .from('vuelo')
        .select('id, piloto_id')
        .eq('estado', 'COMPLETADO')
        .gte('fecha_vuelo', mDesde)
        .lte('fecha_vuelo', mHasta);
      const pilotoPorVuelo = new Map(
        (vuelosMes ?? []).map((v) => [
          v.id as string,
          v.piloto_id as string | null,
        ]),
      );
      const ids = [...pilotoPorVuelo.keys()];
      if (ids.length) {
        const { data: escalas } = await this.supabase.service
          .from('escala')
          .select('vuelo_id, piloto_id, taco_salida, taco_llegada')
          .in('vuelo_id', ids);
        for (const e of escalas ?? []) {
          const ts = Number(e.taco_salida);
          const tl = Number(e.taco_llegada);
          if (!Number.isFinite(ts) || !Number.isFinite(tl) || tl <= ts)
            continue;
          // Atribuye las horas al piloto del tramo (ida/regreso pueden diferir);
          // si el tramo no tiene piloto propio, usa el del vuelo.
          const pid =
            (e.piloto_id as string | null) ??
            pilotoPorVuelo.get(e.vuelo_id as string);
          if (!pid) continue;
          horas.set(pid, (horas.get(pid) ?? 0) + (tl - ts));
        }
      }
    }

    // Descanso marcado ese día (piloto_descanso): avisa igual que un conflicto.
    const descansa = new Map<string, string>();
    if (dayCancun) {
      const day = dayCancun;
      const { data: descansos } = await this.supabase.service
        .from('piloto_descanso')
        .select('piloto_id, fecha_inicio, fecha_fin, motivo')
        .lte('fecha_inicio', day)
        .gte('fecha_fin', day);
      for (const d of descansos ?? []) {
        descansa.set(
          d.piloto_id as string,
          (d.motivo as string | null) ?? 'descanso',
        );
      }
    }

    return (pilots ?? []).map((p) => {
      const h = Math.round((horas.get(p.id) ?? 0) * 10) / 10;
      const folio = conflicto.get(p.id);
      const motivoDescanso = descansa.get(p.id) ?? null;
      return {
        id: p.id,
        nombre: p.nombre,
        horas_mes: h,
        limite_horas_mes: LIMITE_HORAS_MES,
        excede_limite: h >= LIMITE_HORAS_MES,
        cerca_limite: h >= LIMITE_HORAS_MES * 0.9 && h < LIMITE_HORAS_MES,
        conflicto: folio != null || motivoDescanso != null,
        conflicto_folio: folio ?? null,
        descansa: motivoDescanso != null,
        descanso_motivo: motivoDescanso,
      };
    });
  }

  async assign(id: string, dto: AssignFlightDto, updatedBy: string) {
    const current = await this.findById(id);
    // Operación independiente de lo administrativo: se asigna avión/piloto en
    // cualquier estado operable (incluida la RESERVA sin cotizar).
    if (current.estado === 'COMPLETADO' || current.estado === 'CANCELADO') {
      throw new ConflictException(`No se asigna en estado ${current.estado}.`);
    }
    if (current.es_externo && dto.aeronave_id) {
      throw new BadRequestException(
        'Vuelo externo no admite aeronave_id propia',
      );
    }

    const asignandoPiloto =
      dto.piloto_id !== undefined &&
      dto.piloto_id !== null &&
      dto.piloto_id !== '';

    // Doc 4.3: no se asigna avión/piloto con documento crítico vencido ni avión en taller.
    await this.validateAssignTargets({
      aeronaveId: dto.aeronave_id,
      pilotoId: asignandoPiloto ? dto.piloto_id : undefined,
    });

    // Copiloto (segundo piloto del viaje): valida que exista y no choque con el
    // piloto principal. null = quitarlo.
    const asignandoCopiloto =
      dto.copiloto_id !== undefined &&
      dto.copiloto_id !== null &&
      dto.copiloto_id !== '';
    if (asignandoCopiloto) {
      const pilotoFinal =
        dto.piloto_id !== undefined ? dto.piloto_id : current.piloto_id;
      if (dto.copiloto_id === pilotoFinal) {
        throw new BadRequestException(
          'El copiloto debe ser distinto al piloto.',
        );
      }
      await this.validateAssignTargets({ pilotoId: dto.copiloto_id! });
    }

    // APOYO del vuelo (caso Jimmy): va en tierra (maletas, facturas, cobros,
    // gastos) y opera el vuelo como el piloto EXCEPTO tacómetros. No vuela:
    // no se le aplican los candados de piloto (documentos críticos de
    // validateAssignTargets ni descansos/horas) — basta existir y estar
    // ACTIVO. null/'' = quitarlo (patrón copiloto).
    const asignandoApoyo =
      dto.apoyo_id !== undefined &&
      dto.apoyo_id !== null &&
      dto.apoyo_id !== '';
    if (asignandoApoyo) {
      const pilotoFinal: string | null =
        dto.piloto_id !== undefined
          ? dto.piloto_id
          : ((current as { piloto_id?: string | null }).piloto_id ?? null);
      const copilotoFinal: string | null =
        dto.copiloto_id !== undefined
          ? dto.copiloto_id
          : ((current as { copiloto_id?: string | null }).copiloto_id ?? null);
      if (dto.apoyo_id === pilotoFinal || dto.apoyo_id === copilotoFinal) {
        throw new BadRequestException(
          'El apoyo debe ser distinto al piloto y al copiloto.',
        );
      }
      await this.assertApoyoAsignable(dto.apoyo_id!);
    }

    const patch: Record<string, unknown> = { updated_by: updatedBy };
    if (dto.aeronave_id !== undefined) patch.aeronave_id = dto.aeronave_id;
    if (dto.piloto_id !== undefined) patch.piloto_id = dto.piloto_id;
    if (dto.copiloto_id !== undefined)
      patch.copiloto_id = dto.copiloto_id === '' ? null : dto.copiloto_id;
    if (dto.apoyo_id !== undefined)
      patch.apoyo_id = dto.apoyo_id === '' ? null : dto.apoyo_id;
    if (dto.fecha_vuelo !== undefined)
      patch.fecha_vuelo = dto.fecha_vuelo.toISOString();

    if (Object.keys(patch).length === 1) {
      throw new BadRequestException('Empty assign payload');
    }

    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update(patch)
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }
    // Espejo: el tramo de ida (orden=1) refleja la asignación del vuelo.
    await this.mirrorVueloToIdaEscala(id, {
      aeronave_id: dto.aeronave_id,
      piloto_id: dto.piloto_id,
      fecha_salida_plan:
        dto.fecha_vuelo !== undefined
          ? dto.fecha_vuelo.toISOString()
          : undefined,
    });
    // REGLA 26-ago-2026: reasignar el PILOTO a nivel VUELO aplica a TODOS
    // los tramos (antes solo se espejaba la ida y en un redondo el regreso
    // se quedaba con el piloto viejo en silencio). La reasignación POR TRAMO
    // (assignEscala) sigue tocando solo ese tramo — así se arman las
    // rotaciones. Los pilotos que pierden sus tramos reciben aviso.
    if (asignandoPiloto && dto.piloto_id !== current.piloto_id) {
      const { data: tramosVivos } = await this.supabase.service
        .from('escala')
        .select('id, orden, piloto_id, origen_iata, destino_iata')
        .eq('vuelo_id', id)
        .is('cancelada_at', null);
      const salientes = new Map<string, string[]>();
      for (const t of tramosVivos ?? []) {
        const pid = t.piloto_id as string | null;
        if (
          pid &&
          pid !== dto.piloto_id &&
          pid !== (current.piloto_id as string | null)
        ) {
          const lista = salientes.get(pid) ?? [];
          lista.push(
            `${(t.origen_iata as string) ?? '?'} → ${(t.destino_iata as string) ?? '?'}`,
          );
          salientes.set(pid, lista);
        }
      }
      const { error: tramosErr } = await this.supabase.service
        .from('escala')
        .update({ piloto_id: dto.piloto_id, updated_by: updatedBy })
        .eq('vuelo_id', id)
        .is('cancelada_at', null);
      if (tramosErr) {
        this.logger.warn(
          `assign ${id}: no se pudo aplicar el piloto a todos los tramos: ${tramosErr.message}`,
        );
      } else {
        for (const [uid, tramos] of salientes) {
          void this.notificarQuitado(
            uid,
            data!,
            'piloto',
            `tramo(s) ${tramos.join(', ')} reasignado(s) al nuevo piloto`,
          );
        }
      }
    }
    void this.calendar.syncFlight(id);
    if (asignandoPiloto && dto.piloto_id !== current.piloto_id) {
      void this.notifyPilotAssigned(dto.piloto_id!, data!);
    }
    // Avisa también al copiloto recién asignado (ve todo el vuelo).
    if (asignandoCopiloto && dto.copiloto_id !== current.copiloto_id) {
      void this.notifyPilotAssigned(dto.copiloto_id!, data!, 'copiloto');
    }
    // Y al apoyo recién asignado (opera el vuelo como el piloto, sin tacos).
    if (asignandoApoyo && dto.apoyo_id !== current.apoyo_id) {
      void this.notifyApoyoAssigned(dto.apoyo_id!, data!);
    }
    // Reagenda por assign (20-ago-2026, invariante doc 4.3): PATCH ya
    // avisaba al piloto cuando cambia la fecha con el MISMO piloto, pero la
    // edición rápida de la app y el calendario reagendan por AQUÍ y el
    // piloto no se enteraba ("si Itzel cambia el vuelo a las 8am y el piloto
    // lo ve a las 10am es un problema grave").
    // QUITADOS / REEMPLAZADOS (auditoría 21-ago-2026): el que deja de ir
    // también se entera — antes se le cambiaba el vuelo en silencio.
    const ruta = `${current.origen_iata as string} → ${current.destino_iata as string}`;
    if (
      dto.piloto_id !== undefined &&
      current.piloto_id &&
      current.piloto_id !== dto.piloto_id
    ) {
      this.notificarQuitado(current.piloto_id as string, data!, 'piloto', ruta);
    }
    if (
      dto.copiloto_id !== undefined &&
      current.copiloto_id &&
      current.copiloto_id !== dto.copiloto_id
    ) {
      this.notificarQuitado(
        current.copiloto_id as string,
        data!,
        'copiloto',
        ruta,
      );
    }
    if (
      dto.apoyo_id !== undefined &&
      current.apoyo_id &&
      current.apoyo_id !== dto.apoyo_id
    ) {
      this.notificarQuitado(current.apoyo_id as string, data!, 'apoyo', ruta);
    }
    // Los recién asignados ya recibieron su aviso con la fecha/avión
    // actuales: los demás cambios (fecha, avión) van al RESTO de la
    // tripulación — copiloto, apoyo y pilotos de tramo incluidos.
    const reciénAvisados = new Set<string>();
    if (asignandoPiloto && dto.piloto_id !== current.piloto_id)
      reciénAvisados.add(dto.piloto_id!);
    if (asignandoCopiloto && dto.copiloto_id !== current.copiloto_id)
      reciénAvisados.add(dto.copiloto_id!);
    if (asignandoApoyo && dto.apoyo_id !== current.apoyo_id)
      reciénAvisados.add(dto.apoyo_id!);
    const fechaCambioAssign =
      dto.fecha_vuelo !== undefined &&
      this.fechaCambia(dto.fecha_vuelo, current.fecha_vuelo);
    if (fechaCambioAssign) {
      // Reagenda (doc 4.3): a TODA la tripulación vigente.
      void this.notificarTripulacion(
        data!,
        {
          titulo: `Vuelo #${current.folio as number} reagendado`,
          cuerpo: `${ruta} ahora sale ${this.fechaCancunTxt(dto.fecha_vuelo)} (hora Cancún).`,
        },
        reciénAvisados,
      );
    }
    const avionCambio =
      dto.aeronave_id !== undefined &&
      dto.aeronave_id !== null &&
      dto.aeronave_id !== current.aeronave_id;
    if (avionCambio) {
      const { data: av } = await this.supabase.service
        .from('aeronave')
        .select('matricula')
        .eq('id', dto.aeronave_id as string)
        .maybeSingle();
      void this.notificarTripulacion(
        data!,
        {
          titulo: `Vuelo #${current.folio as number}: cambio de avión`,
          cuerpo: `${ruta} ahora vuela en ${(av?.matricula as string | undefined) ?? 'otro avión'}.`,
        },
        reciénAvisados,
      );
    }
    return data!;
  }

  /**
   * Valida que un usuario pueda asignarse como APOYO: que exista y esté
   * ACTIVO. A diferencia del piloto/copiloto (validateAssignTargets), al
   * apoyo NO se le validan documentos críticos ni descansos/horas de vuelo —
   * no vuela, va de apoyo en tierra.
   */
  private async assertApoyoAsignable(apoyoId: string): Promise<void> {
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('id, estado')
      .eq('id', apoyoId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new BadRequestException('El usuario de apoyo no existe.');
    }
    if (data.estado !== 'ACTIVO') {
      throw new ConflictException(
        'El usuario de apoyo está inactivo; actívalo antes de asignarlo.',
      );
    }
  }

  /**
   * Push al APOYO asignado: mismo tipo `vuelo_asignado` que el del piloto (la
   * app ya lo sabe pintar y el link redirige al vuelo), con cuerpo propio —
   * va de apoyo en tierra, no a volar.
   */
  // ===== Tripulación: un solo punto de aviso (auditoría 21-ago-2026) =====
  // Regla del cliente: "cuando en un vuelo se agregue, edite o cancele algo
  // que involucre a un tripulante (piloto, copiloto, ayudante) SIEMPRE se le
  // avisa al involucrado". Antes solo se avisaba al asignado NUEVO; el
  // quitado/reemplazado, el copiloto, el apoyo y los pilotos de otros tramos
  // no se enteraban de fechas, avión ni cancelaciones.

  /**
   * Tripulación EFECTIVA del vuelo: piloto, copiloto y apoyo del vuelo más
   * los pilotos explícitos de los tramos vivos. Los externos los filtra
   * notifyUser (sin acceso al sistema).
   */
  private tripulacionDeVuelo(
    vueloId: string,
    vuelo?: Record<string, unknown> | null,
  ): Promise<Set<string>> {
    return tripulacionDeVuelo(this.supabase.service, vueloId, vuelo);
  }

  /**
   * Avisa a TODA la tripulación del vuelo (menos `excluir`: los que ya
   * recibieron otro aviso en la misma acción, p. ej. el recién asignado).
   * Best-effort: jamás tumba la operación que lo dispara.
   */
  private async notificarTripulacion(
    vuelo: Record<string, unknown>,
    n: { titulo: string; cuerpo: string; tipo?: string },
    excluir: Iterable<string> = [],
  ): Promise<void> {
    try {
      const fuera = new Set(excluir);
      const ids = await this.tripulacionDeVuelo(vuelo.id as string, vuelo);
      for (const id of ids) {
        if (fuera.has(id)) continue;
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

  /** Aviso al tripulante que fue QUITADO o reemplazado en un vuelo/tramo. */
  private notificarQuitado(
    usuarioId: string | null | undefined,
    vuelo: Record<string, unknown>,
    rol: 'piloto' | 'copiloto' | 'apoyo',
    detalle?: string,
  ): void {
    if (!usuarioId) return;
    void this.notifications.notifyUser(usuarioId, {
      tipo: 'vuelo_asignado',
      titulo: `Ya no vas en el vuelo #${vuelo.folio as number}`,
      cuerpo: `Te quitaron como ${rol} del vuelo #${vuelo.folio as number}${detalle ? ` · ${detalle}` : ''}. Si tienes duda, confirma con la oficina.`,
      data: { vuelo_id: vuelo.id, folio: vuelo.folio, quitado: rol },
      link: `/flights/${vuelo.id as string}`,
    });
  }

  /** Fecha legible en Cancún para los avisos. */
  /** PostgREST devuelve '+00:00' sin milisegundos: comparar fechas por
   *  INSTANTE, no por string — el string crudo nunca era igual y disparaba
   *  avisos de "reagendado" falsos (auditoría 26-ago). */
  private fechaCambia(nueva: Date, actual: unknown): boolean {
    if (!actual) return true;
    const t = new Date(actual as string).getTime();
    return Number.isNaN(t) || nueva.getTime() !== t;
  }

  /** Espeja fecha_traslado_final a la ÚLTIMA escala viva (orden > 1): el
   *  calendario de la app prefiere la fecha de la escala — sin el espejo,
   *  el regreso reagendado seguía mostrando la fecha vieja. Best-effort. */
  private async mirrorRegresoAUltimaEscala(
    vueloId: string,
    fecha: Date,
  ): Promise<void> {
    try {
      const { data } = await this.supabase.service
        .from('escala')
        .select('id, orden')
        .eq('vuelo_id', vueloId)
        .is('cancelada_at', null)
        .order('orden', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data || Number(data.orden) <= 1) return; // sin tramo de regreso
      await this.supabase.service
        .from('escala')
        .update({ fecha_salida_plan: fecha.toISOString() })
        .eq('id', data.id as string);
    } catch (err) {
      this.logger.warn(
        `mirrorRegresoAUltimaEscala falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private fechaCancunTxt(iso: string | Date | null | undefined): string {
    if (!iso) return 'fecha por definir';
    return new Date(iso).toLocaleString('es-MX', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'America/Cancun',
    });
  }

  private async notifyApoyoAssigned(
    apoyoId: string,
    vuelo: Record<string, unknown>,
  ): Promise<void> {
    const ruta = await this.rutaDeVuelo(vuelo);
    const fecha = vuelo.fecha_vuelo
      ? new Date(vuelo.fecha_vuelo as string).toLocaleString('es-MX', {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: 'America/Cancun',
        })
      : 'fecha por definir';
    void this.notifications.notifyUser(apoyoId, {
      tipo: 'vuelo_asignado',
      titulo: 'Vas de apoyo en un vuelo',
      cuerpo: `Vas de APOYO en el vuelo #${vuelo.folio as number} · ${ruta} · ${fecha}`,
      data: { vuelo_id: vuelo.id, folio: vuelo.folio },
      link: `/flights/${vuelo.id as string}`,
    });
  }

  /**
   * Valida que un avión/piloto pueda asignarse (doc 4.3): sin documento crítico
   * vencido y sin la aeronave en taller. Reutilizable por vuelo y por tramo.
   */
  private async validateAssignTargets(targets: {
    aeronaveId?: string | null;
    pilotoId?: string | null;
  }): Promise<void> {
    const objetivos: { aeronaveId?: string; pilotoId?: string } = {};
    if (targets.aeronaveId) objetivos.aeronaveId = targets.aeronaveId;
    if (targets.pilotoId) objetivos.pilotoId = targets.pilotoId;
    // Documentos críticos vencidos: POLÍTICA (ago 2026) — ya NO bloquean (la
    // autoridad a veces autoriza vuelos limitados). Se resuelve al FINAL, tras
    // taller y squawk, para no avisar "se asignó" cuando esos SÍ rechazan.
    const bloqueos =
      objetivos.aeronaveId || objetivos.pilotoId
        ? await this.expirations.findBlockingExpirations(objetivos)
        : [];

    if (
      targets.aeronaveId &&
      (await this.aircraftEnTaller(targets.aeronaveId))
    ) {
      throw new ConflictException(
        'No se puede asignar: la aeronave está en taller (mantenimiento en curso).',
      );
    }
    // Un squawk de severidad ALTA sin resolver = avión no apto (doc 4.3): no
    // se asigna hasta resolver la discrepancia. BAJA/MEDIA no bloquean.
    if (targets.aeronaveId) {
      const { data: squawks } = await this.supabase.service
        .from('aeronave_discrepancia')
        .select('id, descripcion')
        .eq('aeronave_id', targets.aeronaveId)
        .neq('estado', 'RESUELTA')
        .eq('severidad', 'ALTA')
        .limit(3);
      if (squawks && squawks.length > 0) {
        throw new ConflictException(
          `No se puede asignar: discrepancia de severidad ALTA sin resolver (${squawks
            .map((s) => String(s.descripcion).slice(0, 60))
            .join('; ')}).`,
        );
      }
    }

    // Ya pasó taller y squawk: la asignación PROCEDE. Solo aquí se avisa a
    // administración (dedupe diario por documento) para no perder de vista el
    // crítico vencido — el semáforo del avión ya lo pinta NO APTO.
    if (bloqueos.length > 0) {
      const detalle = bloqueos
        .map((b) => `${b.tipo_nombre} (${b.objetivo})`)
        .join(', ');
      void (async () => {
        try {
          const hoy = new Date().toLocaleDateString('en-CA', {
            timeZone: 'America/Cancun',
          });
          for (const b of bloqueos) {
            const dedupeKey = `asignado_con_critico:${b.id}:${hoy}`;
            // Pre-chequeo: no re-avisar si ya salió hoy (evita duplicados si
            // el avión se asigna a dos tramos/vuelos el mismo día).
            const { count } = await this.supabase.service
              .from('alerta_emitida')
              .select('dedupe_key', { count: 'exact', head: true })
              .eq('dedupe_key', dedupeKey);
            if ((count ?? 0) > 0) continue;
            for (const rol of [Rol.ADMIN, Rol.COORDINADOR]) {
              await this.notifications.notifyRole(rol, {
                tipo: 'alerta_sistema',
                titulo: 'Asignación con documento crítico vencido',
                cuerpo: `Se asignó con ${detalle} vencido(s). El avión se puede seguir usando si la autoridad lo permite, pero hay que renovarlo pronto.`,
                data: { vencimiento_id: b.id },
                link: '/admin/expirations',
              });
            }
            // Marca DESPUÉS de entregar: si el push falla arriba, el siguiente
            // intento del día reintenta en vez de quedar mudo. El 23505 de una
            // carrera es benigno (otra corrida ya avisó).
            await this.supabase.service
              .from('alerta_emitida')
              .insert({ dedupe_key: dedupeKey, clave: 'critico_vencido' })
              .then(({ error }) => {
                if (error && error.code !== '23505') throw error;
              });
          }
        } catch (err) {
          this.logger.warn(
            `Aviso de asignación con crítico vencido falló: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      })();
    }
  }

  /**
   * Sincroniza el tramo de ida (orden=1) con la asignación del vuelo. Best-effort:
   * si el vuelo no tiene escalas (p. ej. externo), no hace nada. Solo escribe los
   * campos presentes en `fields`.
   */
  private async mirrorVueloToIdaEscala(
    vueloId: string,
    fields: {
      aeronave_id?: string | null;
      piloto_id?: string | null;
      estado_permiso?: 'no_aplica' | 'pendiente' | 'emitido';
      fecha_salida_plan?: string | null;
    },
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (fields.aeronave_id !== undefined)
      patch.aeronave_id = fields.aeronave_id;
    if (fields.piloto_id !== undefined) patch.piloto_id = fields.piloto_id;
    if (fields.estado_permiso !== undefined)
      patch.estado_permiso = fields.estado_permiso;
    if (fields.fecha_salida_plan !== undefined)
      patch.fecha_salida_plan = fields.fecha_salida_plan;
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('vuelo_id', vueloId)
      .eq('orden', 1);
    if (error)
      this.logger.warn(
        `No se pudo espejar la ida del vuelo ${vueloId}: ${error.message}`,
      );
  }

  /**
   * Asigna aeronave/piloto a UN TRAMO (escala) — permite ida y regreso con avión y
   * piloto distintos. Misma validación de documentos/taller que el vuelo. Si el
   * tramo es la ida (orden=1) espeja la asignación en el vuelo (compat).
   */
  async assignEscala(legId: string, dto: AssignEscalaDto, updatedBy: string) {
    const { data: escala, error: escErr } = await this.supabase.service
      .from('escala')
      .select('id, vuelo_id, orden, aeronave_id, piloto_id, cancelada_at')
      .eq('id', legId)
      .maybeSingle();
    if (escErr) throw new Error(escErr.message);
    if (!escala) throw new NotFoundException(`Escala ${legId} not found`);
    if (escala.cancelada_at) {
      throw new ConflictException(
        'Este tramo está cancelado: restáuralo antes de asignar avión/piloto.',
      );
    }

    const vuelo = await this.findById(escala.vuelo_id as string);
    // Operación independiente: asignable en cualquier estado operable.
    if (vuelo.estado === 'COMPLETADO' || vuelo.estado === 'CANCELADO') {
      throw new ConflictException(`No se asigna en estado ${vuelo.estado}.`);
    }
    if (vuelo.es_externo && dto.aeronave_id) {
      throw new BadRequestException(
        'Vuelo externo no admite aeronave_id propia',
      );
    }

    const asignandoPiloto =
      dto.piloto_id !== undefined &&
      dto.piloto_id !== null &&
      dto.piloto_id !== '';

    await this.validateAssignTargets({
      aeronaveId: dto.aeronave_id,
      pilotoId: asignandoPiloto ? dto.piloto_id : undefined,
    });

    const patch: Record<string, unknown> = { updated_by: updatedBy };
    if (dto.aeronave_id !== undefined) patch.aeronave_id = dto.aeronave_id;
    if (dto.piloto_id !== undefined) patch.piloto_id = dto.piloto_id;
    if (dto.fecha_salida_plan !== undefined)
      patch.fecha_salida_plan = dto.fecha_salida_plan.toISOString();
    if (Object.keys(patch).length === 1) {
      throw new BadRequestException('Empty assign payload');
    }

    const { data, error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('id', legId)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }

    // Si es la ida, espeja al vuelo (compat con lectores vuelo-level).
    if (escala.orden === 1) {
      const vueloPatch: Record<string, unknown> = { updated_by: updatedBy };
      if (dto.aeronave_id !== undefined)
        vueloPatch.aeronave_id = dto.aeronave_id;
      if (dto.piloto_id !== undefined) vueloPatch.piloto_id = dto.piloto_id;
      if (dto.fecha_salida_plan !== undefined)
        vueloPatch.fecha_vuelo = dto.fecha_salida_plan.toISOString();
      await this.supabase.service
        .from('vuelo')
        .update(vueloPatch)
        .eq('id', escala.vuelo_id as string);
    }

    void this.calendar.syncFlight(escala.vuelo_id as string);
    if (asignandoPiloto && dto.piloto_id !== escala.piloto_id) {
      void this.notifyPilotAssigned(dto.piloto_id!, {
        ...vuelo,
        origen_iata:
          (data as { origen_iata?: string }).origen_iata ?? vuelo.origen_iata,
        destino_iata:
          (data as { destino_iata?: string }).destino_iata ??
          vuelo.destino_iata,
      });
    }
    const o = (data as { origen_iata?: string }).origen_iata ?? '';
    const d = (data as { destino_iata?: string }).destino_iata ?? '';
    const tramoTxt = `${o} → ${d}`;
    // Piloto del TRAMO reemplazado/quitado: el anterior se entera (21-ago).
    if (
      dto.piloto_id !== undefined &&
      escala.piloto_id &&
      escala.piloto_id !== dto.piloto_id
    ) {
      this.notificarQuitado(
        escala.piloto_id as string,
        vuelo,
        'piloto',
        `tramo ${tramoTxt}`,
      );
    }
    const reciénAvisado =
      asignandoPiloto && dto.piloto_id !== escala.piloto_id
        ? [dto.piloto_id!]
        : [];
    // Reagenda del TRAMO (doc 4.3): a TODA la tripulación vigente (el piloto
    // efectivo del tramo por herencia, copiloto, apoyo y los demás tramos) —
    // la edición de horas por tramo de la app pasa por aquí.
    if (dto.fecha_salida_plan !== undefined) {
      void this.notificarTripulacion(
        vuelo,
        {
          titulo: `Vuelo #${vuelo.folio as number}: tramo reagendado`,
          cuerpo: `${tramoTxt} ahora sale ${this.fechaCancunTxt(dto.fecha_salida_plan)} (hora Cancún).`,
        },
        reciénAvisado,
      );
    }
    // Cambio de avión del tramo: todos se enteran.
    if (
      dto.aeronave_id !== undefined &&
      dto.aeronave_id !== null &&
      dto.aeronave_id !== escala.aeronave_id
    ) {
      const { data: av } = await this.supabase.service
        .from('aeronave')
        .select('matricula')
        .eq('id', dto.aeronave_id)
        .maybeSingle();
      void this.notificarTripulacion(
        vuelo,
        {
          titulo: `Vuelo #${vuelo.folio as number}: cambio de avión`,
          cuerpo: `El tramo ${tramoTxt} ahora vuela en ${(av?.matricula as string | undefined) ?? 'otro avión'}.`,
        },
        reciénAvisado,
      );
    }
    return data!;
  }

  /**
   * Actualiza el permiso de pista de UN TRAMO. Admin/Coordinador o el piloto
   * asignado a ese tramo. Si es la ida (orden=1) espeja en el vuelo. Al pasar a
   * "emitido" avisa a Admin/Coordinador.
   */
  async updateEscalaPermiso(
    legId: string,
    estadoPermiso: 'no_aplica' | 'pendiente' | 'emitido',
    user: { userId: string; rol: Rol },
  ) {
    const { data: escala, error: escErr } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, piloto_id, estado_permiso, origen_iata, destino_iata',
      )
      .eq('id', legId)
      .maybeSingle();
    if (escErr) throw new Error(escErr.message);
    if (!escala) throw new NotFoundException(`Escala ${legId} not found`);
    if (user.rol === Rol.PILOTO && escala.piloto_id !== user.userId) {
      throw new ForbiddenException(
        'Solo el piloto asignado puede actualizar el permiso de este tramo',
      );
    }
    const { data, error } = await this.supabase.service
      .from('escala')
      .update({ estado_permiso: estadoPermiso, updated_by: user.userId })
      .eq('id', legId)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Escala ${legId} not found`);

    if (escala.orden === 1) {
      await this.supabase.service
        .from('vuelo')
        .update({ estado_permiso: estadoPermiso, updated_by: user.userId })
        .eq('id', escala.vuelo_id as string);
    }

    void this.calendar.syncFlight(escala.vuelo_id as string);
    if (estadoPermiso === 'emitido' && escala.estado_permiso !== 'emitido') {
      const vuelo = await this.findById(escala.vuelo_id as string);
      const payload = {
        tipo: 'permiso_emitido',
        titulo: 'Permiso de pista emitido',
        cuerpo: `${escala.origen_iata as string} → ${escala.destino_iata as string} · folio #${vuelo.folio}`,
        data: { vuelo_id: escala.vuelo_id, folio: vuelo.folio },
        link: `/admin/flights/${escala.vuelo_id as string}`,
      };
      void this.notifications.notifyRole(Rol.ADMIN, payload, user.userId);
      void this.notifications.notifyRole(Rol.COORDINADOR, payload, user.userId);
    }
    return data;
  }

  async start(id: string, updatedBy: string, actor?: AuthenticatedUser) {
    const current = await this.findById(id);
    // Operación independiente de lo administrativo: el vuelo puede despegar
    // aunque la cotización siga abierta (RESERVA/COTIZADO). Los guards de
    // asignación y tacómetro se mantienen.
    const iniciables = ['RESERVA', 'SOLICITUD', 'COTIZADO', 'CONFIRMADO'];
    if (!iniciables.includes(current.estado as string)) {
      throw new ConflictException(
        `No se puede iniciar un vuelo en estado ${current.estado}.`,
      );
    }
    if (!current.es_externo) {
      if (!current.aeronave_id) {
        throw new BadRequestException(
          'No se puede iniciar sin aeronave_id asignada',
        );
      }
      if (!current.piloto_id) {
        throw new BadRequestException(
          'No se puede iniciar sin piloto_id asignado',
        );
      }
    }
    // La operación no se detiene: la salida del primer tramo ya no la captura
    // el piloto (una foto por escala = solo la llegada), así que aquí se llena
    // sola con el último tacómetro conocido del avión. Si no hay historial, el
    // vuelo inicia igual y la oficina la resuelve en Tacómetros en vivo.
    if (!current.es_externo) {
      await this.autoFillSalidaInicial(
        id,
        current.aeronave_id as string | null,
        updatedBy,
      );
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({ estado: 'EN_VUELO', updated_by: updatedBy })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    void this.calendar.syncFlight(id);
    return this.redactVueloForRol(data!, actor);
  }

  async complete(
    id: string,
    updatedBy: string | null,
    actor?: AuthenticatedUser,
  ) {
    const current = await this.findById(id);
    if (current.estado !== 'EN_VUELO') {
      throw new ConflictException(
        `Solo se completa vuelo desde EN_VUELO. Actual: ${current.estado}`,
      );
    }
    // Para completar solo se exigen las LLEGADAS (la única lectura que captura
    // el piloto). Las salidas son del sistema (último taco / propagación) y no
    // deben bloquear: si alguna falta, la oficina la ajusta en Tacómetros en vivo.
    if (
      !current.es_externo &&
      this.faltanLlegadas(await this.escalasTaco(id))
    ) {
      throw new ConflictException(MSG_TACO);
    }
    // CAS (compare-and-set): el UPDATE solo aplica si el vuelo SIGUE en
    // EN_VUELO. Dos caminos pueden completar casi a la vez (cada llegada de
    // syncEstadoDesdeTacos, el cron zombi, el botón del panel): sin la guarda,
    // el segundo repetía los side-effects (recordTramoTiempos, calendario).
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({ estado: 'COMPLETADO', updated_by: updatedBy })
      .eq('id', id)
      .eq('estado', 'EN_VUELO')
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      // 0 filas: alguien movió el estado entre la lectura y el write.
      const relectura = await this.findById(id);
      if (relectura.estado === 'COMPLETADO') {
        // Otro camino ya lo completó: éxito idempotente, sin duplicar
        // side-effects (ese camino ya corrió calendario + recordTramoTiempos).
        return this.redactVueloForRol(relectura, actor);
      }
      throw new ConflictException(
        `Solo se completa vuelo desde EN_VUELO. Actual: ${relectura.estado as string}`,
      );
    }
    void this.calendar.syncFlight(id);
    // Las horas de motor/hélice/overhaul NO se incrementan aquí: son DERIVADAS
    // de las escalas (horas vivas = horas_totales + hobbs − ref). Incrementar
    // además de derivar contaba cada vuelo DOS veces, y un ajuste de tacómetro
    // posterior al cierre jamás se reflejaba. Derivar es autocorregible.
    // Alimenta el histórico de tiempos por tramo (best-effort, no bloquea).
    try {
      await this.recordTramoTiempos(id);
    } catch (err) {
      // El recálculo de promedios nunca debe impedir cerrar el vuelo.
      void err;
    }
    return this.redactVueloForRol(data, actor);
  }

  /**
   * Cancela un vuelo (-> CANCELADO). Pensado para que ADMIN/COORDINADOR cierren
   * vuelos que quedaron atorados (p. ej. CONFIRMADO con fecha pasada y sin
   * tacómetros). El motivo se guarda auditado en notas_internas.
   */
  async cancel(id: string, motivo: string, updatedBy: string) {
    const current = await this.findById(id);
    if (current.estado === 'CANCELADO' || current.estado === 'COMPLETADO') {
      throw new ConflictException(
        `No se puede cancelar un vuelo en estado ${current.estado}`,
      );
    }
    const sello = `[Cancelado ${new Date().toISOString()}] ${motivo.trim()}`;
    const previas = (current.notas_internas as string | null)?.trim();
    const notas_internas = previas ? `${previas}\n${sello}` : sello;
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({ estado: 'CANCELADO', notas_internas, updated_by: updatedBy })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // El calendario elimina el evento cuando el vuelo pasa a CANCELADO.
    void this.calendar.syncFlight(id);
    // Tripulación completa (21-ago): nadie debe presentarse a un vuelo que
    // ya no existe.
    void this.notificarTripulacion(data!, {
      titulo: `Vuelo #${current.folio as number} CANCELADO`,
      cuerpo: `${current.origen_iata as string} → ${current.destino_iata as string} del ${this.fechaCancunTxt(current.fecha_vuelo as string | null)} se canceló. Motivo: ${motivo.trim()}`,
      tipo: 'alerta_sistema',
    });
    return data!;
  }

  /**
   * Convierte un vuelo cotizado con avión propio en CUBIERTO por operador
   * externo (pedido de Itzy): conserva la cotización al cliente tal cual;
   * libera avión y piloto (el externo no captura tacómetros — estado manual).
   * Llamado de nuevo sobre un externo, actualiza operador/costo.
   */
  async cubrirConExterno(
    id: string,
    dto: {
      operador_externo: string;
      costo_externo_usd: number;
      tc_usd_mxn?: number;
    },
    userId: string,
  ) {
    const current = await this.findById(id);
    if (current.estado === 'CANCELADO' || current.estado === 'COMPLETADO') {
      throw new ConflictException(
        `No se puede cubrir con externo en estado ${current.estado}.`,
      );
    }
    // TC pactado: sin él, un vuelo en USD no se puede facturar (CFDI en MXN).
    const tc = Number(dto.tc_usd_mxn) > 0 ? Number(dto.tc_usd_mxn) : null;
    // Composición MXN de la cotización (renglones nativos en pesos): el
    // findById no trae el snapshot — se lee aparte solo si hay TC.
    let snapTotales: { mxn_nativos?: number; usd_de_mxn?: number } | undefined;
    if (tc) {
      const { data: snapRow } = await this.supabase.service
        .from('vuelo')
        .select('calculo_snapshot')
        .eq('id', id)
        .maybeSingle();
      snapTotales = (
        snapRow?.calculo_snapshot as {
          totales?: { mxn_nativos?: number; usd_de_mxn?: number };
        } | null
      )?.totales;
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({
        es_externo: true,
        operador_externo: dto.operador_externo.trim(),
        costo_externo_usd: dto.costo_externo_usd,
        aeronave_id: null,
        piloto_id: null,
        copiloto_id: null,
        // El apoyo también sale: el vuelo lo opera un tercero (hueco
        // detectado en la auditoría de notificaciones, 21-ago-2026).
        apoyo_id: null,
        ...(tc
          ? {
              tc_usd_mxn: tc,
              // Con renglones nativos en MXN (TUAS/extras en pesos), el MXN
              // se recompone: componentes USD × tc + nativos TAL CUAL — la
              // fórmula plana pisaría el total exacto por composición.
              monto_total_mxn: (() => {
                const nativos = Number(snapTotales?.mxn_nativos) || 0;
                const usdDeMxn = Number(snapTotales?.usd_de_mxn) || 0;
                const totalUsd = Number(current.monto_total_usd);
                return nativos > 0
                  ? Math.round(
                      (Math.round((totalUsd - usdDeMxn) * tc * 100) / 100 +
                        nativos) *
                        100,
                    ) / 100
                  : Math.round(totalUsd * tc * 100) / 100;
              })(),
            }
          : {}),
        updated_by: userId,
      })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // Tripulación ANTES de soltar los tramos: a todos se les avisa que el
    // vuelo lo cubre un externo y ya no van (21-ago).
    const tripulacionPrevia = await this.tripulacionDeVuelo(id, current);
    // Los tramos sueltan avión/piloto propios (la ruta se conserva).
    await this.supabase.service
      .from('escala')
      .update({ aeronave_id: null, piloto_id: null })
      .eq('vuelo_id', id);
    void this.calendar.syncFlight(id);
    for (const uid of tripulacionPrevia) {
      void this.notifications.notifyUser(uid, {
        tipo: 'vuelo_asignado',
        titulo: `Ya no vas en el vuelo #${current.folio as number}`,
        cuerpo: `${current.origen_iata as string} → ${current.destino_iata as string} lo cubre ${dto.operador_externo.trim()} (operador externo): quedaste fuera de ese vuelo.`,
        data: { vuelo_id: id, folio: current.folio },
        link: `/flights/${id}`,
      });
    }
    return data!;
  }

  /**
   * Regresa un vuelo CUBIERTO por externo a vuelo PROPIO (el apoyo se cayó o
   * al final sí sale con avión de la casa): limpia operador/costo del apoyo
   * y el vuelo queda listo para asignar avión y piloto propios (tacómetros y
   * gastos vuelven a aplicar). La cotización del cliente no se toca.
   */
  async revertirExterno(id: string, userId: string) {
    const current = await this.findById(id);
    if (current.es_externo !== true) {
      throw new ConflictException('El vuelo no está cubierto por externo.');
    }
    if (current.estado === 'CANCELADO' || current.estado === 'COMPLETADO') {
      throw new ConflictException(
        `No se puede regresar a vuelo propio en estado ${current.estado as string}.`,
      );
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({
        es_externo: false,
        operador_externo: null,
        costo_externo_usd: null,
        updated_by: userId,
      })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    void this.calendar.syncFlight(id);
    return data!;
  }

  async createExternal(dto: CreateExternalFlightDto, userId: string) {
    // MULTIESCALA opcional: con tramos, la ruta del vuelo se deriva de ellos.
    const legs = (dto.escalas ?? []).map((e) => ({
      origen_iata: e.origen_iata.toUpperCase(),
      destino_iata: e.destino_iata.toUpperCase(),
      es_ferry: e.es_ferry === true,
    }));
    for (const l of legs) {
      if (l.origen_iata === l.destino_iata) {
        throw new BadRequestException(
          `Un tramo no puede tener el mismo origen y destino (${l.origen_iata}).`,
        );
      }
    }
    const origen = legs[0]?.origen_iata ?? dto.origen_iata.toUpperCase();
    const destino =
      legs.length > 0
        ? legs[legs.length - 1].destino_iata
        : dto.destino_iata.toUpperCase();
    const payload = {
      cliente_id: dto.cliente_id,
      aeronave_id: null,
      es_externo: true,
      operador_externo: dto.operador_externo,
      costo_externo_usd: dto.costo_externo_usd,
      tipo: legs.length > 1 ? 'MULTIESCALA' : 'REDONDO',
      estado: 'CONFIRMADO',
      cotizacion_version: 1,
      origen_iata: origen,
      destino_iata: destino,
      es_redondo_auto: legs.length === 0,
      num_aterrizajes: legs.length > 0 ? legs.length : 2,
      pasajeros: dto.pasajeros,
      pase_abordar: false,
      tiempo_cobrable_hr: 0,
      tarifa_tipo: 'PUBLICO',
      tarifa_hora_usd: 0,
      subtotal_vuelo_usd: dto.monto_total_usd,
      tuas_usd: 0,
      iva_pct: 0,
      iva_usd: 0,
      monto_total_usd: dto.monto_total_usd,
      // Sin método, el vuelo jamás aparecía en Facturas hasta cobrarse (los
      // facturables entran a la bandeja ANTES del cobro — pedido de Itzy).
      metodo_cobro: dto.metodo_cobro ?? 'TRANSFERENCIA',
      // TC pactado (opcional): sin MXN el CFDI no se puede emitir; también se
      // puede capturar después, al emitir la factura.
      tc_usd_mxn: Number(dto.tc_usd_mxn) > 0 ? Number(dto.tc_usd_mxn) : null,
      monto_total_mxn:
        Number(dto.tc_usd_mxn) > 0
          ? Math.round(dto.monto_total_usd * Number(dto.tc_usd_mxn) * 100) / 100
          : null,
      fecha_vuelo: dto.fecha_vuelo?.toISOString(),
      fecha_confirmacion: new Date().toISOString(),
      notas: dto.notas,
      notas_internas: dto.notas_internas,
      created_by: userId,
      updated_by: userId,
    };
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .insert(payload)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }
    // Tramos del externo (solo ruta, sin tacómetros: el estado es manual).
    if (data?.id && legs.length > 0) {
      const { error: escErr } = await this.supabase.service
        .from('escala')
        .insert(
          legs.map((l, i) => ({
            vuelo_id: data.id as string,
            orden: i + 1,
            origen_iata: l.origen_iata,
            destino_iata: l.destino_iata,
            es_ferry: l.es_ferry,
            pasajeros: l.es_ferry ? 0 : dto.pasajeros,
            // El primer tramo sale a la hora del vuelo (espejo estándar).
            fecha_salida_plan: i === 0 ? dto.fecha_vuelo?.toISOString() : null,
            created_by: userId,
          })),
        );
      if (escErr) {
        this.logger.warn(
          `Vuelo externo ${data.id as string}: no se pudieron crear los tramos: ${escErr.message}`,
        );
      }
    }
    if (data?.id) void this.calendar.syncFlight(data.id as string);
    return data!;
  }

  /**
   * Reserva tentativa: aparta el espacio en el calendario SIN cotización
   * (vuelo propio; el cliente aún no confirma o faltan costos para cotizar).
   * Precios en 0 — se cotiza después con "revisar" desde el detalle. Crea sus
   * tramos (ida + regreso si hay fecha final) para que la asignación por tramo
   * y el calendario por tramo funcionen desde el día uno.
   */
  async createReserva(dto: CreateReservaDto, userId: string) {
    if (dto.aeronave_id || dto.piloto_id) {
      await this.validateAssignTargets({
        aeronaveId: dto.aeronave_id,
        pilotoId: dto.piloto_id,
      });
    }
    // Copiloto (2 pilotos volando): debe ser un piloto válido y distinto del
    // titular. Se valida aparte para dar un mensaje claro.
    if (dto.copiloto_id) {
      if (dto.copiloto_id === dto.piloto_id) {
        throw new BadRequestException(
          'El copiloto debe ser distinto del piloto.',
        );
      }
      await this.validateAssignTargets({ pilotoId: dto.copiloto_id });
    }
    // Creación rápida con itinerario de OPERACIÓN: la ruta real del avión
    // (puede salir de otra base, con ferries). Mientras no exista cotización,
    // el vuelo muestra los extremos de la operación; la ruta comercial
    // (CUN→…→CUN) se arma después en el cotizador.
    const itinerario = (dto.escalas_operacion ?? []).map((e) => ({
      ...e,
      origen_iata: e.origen_iata.toUpperCase(),
      destino_iata: e.destino_iata.toUpperCase(),
    }));
    for (const [i, e] of itinerario.entries()) {
      // Un SOBREVUELO sale y regresa al mismo punto (CUN → CUN): la igualdad
      // solo se prohíbe en tramos de traslado normales.
      if (e.origen_iata === e.destino_iata && e.es_sobrevuelo !== true) {
        throw new BadRequestException(
          `Tramo ${i + 1}: origen y destino no pueden ser iguales (salvo sobrevuelo)`,
        );
      }
    }

    // Ruta comercial derivada (convención del cliente): la cotización SIEMPRE
    // abre y cierra en Cancún aunque la operación salga de otra base. El
    // destino comercial es el último destino de los tramos con pasajeros
    // (excluyendo CUN); la oficina la ajusta después en el cotizador.
    const destinosComerciales = itinerario
      .filter((e) => !e.es_ferry && e.destino_iata !== 'CUN')
      .map((e) => e.destino_iata);
    const origen = itinerario.length ? 'CUN' : dto.origen_iata!.toUpperCase();
    const destino = itinerario.length
      ? (destinosComerciales[destinosComerciales.length - 1] ?? 'CUN')
      : dto.destino_iata!.toUpperCase();
    const paxItinerario = itinerario
      .filter((e) => !e.es_ferry)
      .reduce((max, e) => Math.max(max, e.pasajeros ?? 0), 0);
    const pasajeros = dto.pasajeros ?? (paxItinerario > 0 ? paxItinerario : 1);
    const payload = {
      cliente_id: dto.cliente_id,
      aeronave_id: dto.aeronave_id ?? null,
      piloto_id: dto.piloto_id ?? null,
      copiloto_id: dto.copiloto_id ?? null,
      es_externo: false,
      tipo: 'MULTIESCALA',
      estado: 'RESERVA',
      cotizacion_version: 1,
      origen_iata: origen,
      destino_iata: destino,
      es_redondo_auto: false,
      num_aterrizajes: dto.fecha_traslado_final ? 2 : 1,
      pasajeros,
      pasajeros_nombres: dto.pasajeros_nombres ?? [],
      pase_abordar: false,
      tiempo_cobrable_hr: 0,
      tarifa_tipo: 'PUBLICO',
      tarifa_hora_usd: 0,
      subtotal_vuelo_usd: 0,
      tuas_usd: 0,
      iva_pct: 0,
      iva_usd: 0,
      monto_total_usd: 0,
      cotizacion_abierta: dto.cotizacion_abierta ?? false,
      itinerario_operativo: itinerario.length > 0,
      fecha_vuelo: dto.fecha_vuelo.toISOString(),
      fecha_traslado_final: dto.fecha_traslado_final?.toISOString(),
      notas: dto.notas,
      notas_internas: dto.notas_internas,
      created_by: userId,
      updated_by: userId,
    };
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .insert(payload)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }

    // Tramos: con itinerario de operación se crean TODOS los tramos reales
    // (los ferry como solo_operativa: el piloto los ve y captura tacómetro,
    // pero no se cotizan ni se muestran al cliente). Sin itinerario, el
    // comportamiento clásico: ida (+ regreso invertido si hay fecha).
    const vueloId = data!.id as string;
    // Pernocta SOLO manual (27-ago, regla del cliente): la derivación
    // automática por salto de fecha marcaba pernoctas que nadie pidió.
    const fechaEfectiva = (i: number): Date | null =>
      itinerario[i]?.hora_salida ?? (i === 0 ? dto.fecha_vuelo : null);
    const legs = itinerario.length
      ? itinerario.map((e, i) => {
          return {
            vuelo_id: vueloId,
            orden: i + 1,
            origen_iata: e.origen_iata,
            destino_iata: e.destino_iata,
            aeronave_id: dto.aeronave_id ?? null,
            piloto_id: dto.piloto_id ?? null,
            pasajeros: e.es_ferry ? 0 : (e.pasajeros ?? null),
            pasajeros_nombres: e.es_ferry ? [] : (e.pasajeros_nombres ?? []),
            es_ferry: e.es_ferry ?? false,
            es_sobrevuelo: e.es_sobrevuelo ?? false,
            solo_operativa: e.es_ferry ?? false,
            // Pernocta: SOLO la captura manual (27-ago).
            requiere_pernocta: e.requiere_pernocta ?? false,
            tipo_parada: e.tipo_parada ?? 'NORMAL',
            servicio_notas: e.servicio_notas ?? null,
            notas: e.notas ?? null,
            fecha_salida_plan: fechaEfectiva(i)?.toISOString(),
            created_by: userId,
            updated_by: userId,
          };
        })
      : [
          {
            vuelo_id: vueloId,
            orden: 1,
            origen_iata: origen,
            destino_iata: destino,
            aeronave_id: dto.aeronave_id ?? null,
            piloto_id: dto.piloto_id ?? null,
            pasajeros: pasajeros as number | null,
            pasajeros_nombres: [] as string[],
            es_ferry: false,
            solo_operativa: false,
            requiere_pernocta: false,
            notas: null as string | null,
            fecha_salida_plan: dto.fecha_vuelo.toISOString() as
              | string
              | undefined,
            created_by: userId,
            updated_by: userId,
          },
          ...(dto.fecha_traslado_final
            ? [
                {
                  vuelo_id: vueloId,
                  orden: 2,
                  origen_iata: destino,
                  destino_iata: origen,
                  aeronave_id: dto.aeronave_id ?? null,
                  piloto_id: dto.piloto_id ?? null,
                  pasajeros: pasajeros as number | null,
                  pasajeros_nombres: [] as string[],
                  es_ferry: false,
                  solo_operativa: false,
                  requiere_pernocta: false,
                  notas: null as string | null,
                  fecha_salida_plan: dto.fecha_traslado_final.toISOString() as
                    | string
                    | undefined,
                  created_by: userId,
                  updated_by: userId,
                },
              ]
            : []),
        ];
    const { error: legsErr } = await this.supabase.service
      .from('escala')
      .insert(legs);
    if (legsErr) {
      this.logger.warn(
        `Reserva ${vueloId}: no se pudieron crear los tramos tentativos: ${legsErr.message}`,
      );
    }

    // Permiso de pista: se deriva de los aeropuertos de la ruta. Antes solo
    // se hacía al CREAR una cotización, así que las reservas —el flujo con el
    // que hoy nacen casi todos los vuelos— nunca avisaban del permiso.
    await this.airports.refreshPermisosDeVuelo(vueloId);

    if (dto.piloto_id) void this.notifyPilotAssigned(dto.piloto_id, data!);
    // El copiloto también recibe su aviso (ve todo el vuelo en su app).
    if (dto.copiloto_id)
      void this.notifyPilotAssigned(dto.copiloto_id, data!, 'copiloto');
    void this.calendar.syncFlight(vueloId);
    return data!;
  }

  /**
   * Vuelo ANTERIOR del mismo avión (por fecha, no cancelado): desde el
   * detalle se audita la cadena de tacómetros — la salida del tramo 1 viene
   * del último taco del avión, es decir, de este vuelo previo.
   */
  async vueloAnterior(id: string) {
    const v = await this.findById(id);
    const aeronaveId = (v.aeronave_id as string | null) ?? null;
    const fecha = (v.fecha_vuelo as string | null) ?? null;
    if (!aeronaveId || !fecha) return { anterior: null };
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('id, folio, origen_iata, destino_iata, fecha_vuelo, estado')
      .eq('aeronave_id', aeronaveId)
      .neq('estado', 'CANCELADO')
      .neq('id', id)
      .lt('fecha_vuelo', fecha)
      .order('fecha_vuelo', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const ant = (data ?? [])[0];
    if (!ant) return { anterior: null };
    // Ruta operativa encadenada (tramos activos) para identificarlo mejor.
    const { data: escalas } = await this.supabase.service
      .from('escala')
      .select('orden, origen_iata, destino_iata')
      .eq('vuelo_id', ant.id as string)
      .is('cancelada_at', null)
      .order('orden', { ascending: true });
    const chain = escalas ?? [];
    const ruta = chain.length
      ? [
          chain[0].origen_iata as string,
          ...chain.map((e) => e.destino_iata as string),
        ].join(' → ')
      : `${ant.origen_iata as string} → ${ant.destino_iata as string}`;
    return {
      anterior: {
        id: ant.id as string,
        folio: ant.folio as number,
        ruta,
        fecha_vuelo: ant.fecha_vuelo as string | null,
        estado: ant.estado as string,
      },
    };
  }

  /**
   * Resumen de gastos YA registrados en el vuelo, para la tripulación
   * (piloto/copiloto/apoyo) en la app: con dos o tres personas capturando en
   * el mismo vuelo, ver lo que ya subió cada quien evita duplicados. Lista
   * ligera y sin datos sensibles (sin desgloses fiscales).
   */
  async gastosResumen(vueloId: string) {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(
        'id, categoria, monto, moneda, medio_pago, fecha_gasto, notas, created_at, usuario:usuario_captura_id(nombre)',
      )
      .eq('vuelo_id', vueloId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((g) => {
      const usuario = Array.isArray(g.usuario) ? g.usuario[0] : g.usuario;
      return {
        id: g.id as string,
        categoria: g.categoria as string,
        monto: Number(g.monto),
        moneda: g.moneda as string,
        medio_pago: (g.medio_pago as string | null) ?? null,
        fecha_gasto: (g.fecha_gasto as string | null) ?? null,
        // Solo la primera línea de la nota (identificar el gasto, no el
        // expediente completo).
        nota: ((g.notas as string | null) ?? '').split('\n')[0].trim() || null,
        capturado_por: (usuario as { nombre?: string } | null)?.nombre ?? null,
        created_at: g.created_at as string,
      };
    });
  }

  // ============ Escalas ============

  async listEscalas(vueloId: string) {
    await this.findById(vueloId);
    const { data, error } = await this.supabase.service
      .from('escala')
      .select(ESCALA_COLS)
      .eq('vuelo_id', vueloId)
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    const filas = data ?? [];

    // Nombres de quien capturó / corrigió cada lectura: el detalle del vuelo
    // muestra la MISMA procedencia que el tablero de tacómetros en vivo (la
    // oficina preguntaba "¿quién confirmó esto?" y ahí no se veía). Aditivo:
    // los consumidores internos ignoran estos campos.
    const ids = new Set<string>();
    for (const e of filas) {
      if (e.capturado_por) ids.add(e.capturado_por as string);
      if (e.corregido_por) ids.add(e.corregido_por as string);
    }
    const nombres = new Map<string, string>();
    if (ids.size > 0) {
      const { data: users } = await this.supabase.service
        .from('usuario')
        .select('id, nombre')
        .in('id', [...ids]);
      for (const u of users ?? []) {
        nombres.set(u.id as string, (u.nombre as string) ?? '');
      }
    }
    return filas.map((e) => ({
      ...e,
      // `revision_motivo` sale SOLO con lo accionable y la bitácora viaja
      // aparte en `procedencia`. En la base viven juntos (una sola columna),
      // pero la app del piloto pinta `revision_motivo` crudo y ahí el
      // historial estorba — además así el contrato dice lo que significa cada
      // cosa: motivo = por qué revisar, procedencia = cómo se registró.
      revision_motivo: soloPendientes(e.revision_motivo as string | null),
      procedencia: leerBitacora(e.revision_motivo as string | null),
      capturado_por_nombre: e.capturado_por
        ? (nombres.get(e.capturado_por as string) ?? null)
        : null,
      corregido_por_nombre: e.corregido_por
        ? (nombres.get(e.corregido_por as string) ?? null)
        : null,
    }));
  }

  async createEscala(vueloId: string, dto: CreateEscalaDto, userId: string) {
    await this.findById(vueloId);
    const { data, error } = await this.supabase.service
      .from('escala')
      .insert({
        vuelo_id: vueloId,
        orden: dto.orden,
        origen_iata: dto.origen_iata.toUpperCase(),
        destino_iata: dto.destino_iata.toUpperCase(),
        hora_salida: dto.hora_salida?.toISOString(),
        hora_llegada: dto.hora_llegada?.toISOString(),
        fecha_salida_plan: dto.fecha_salida_plan?.toISOString(),
        // Pasajeros por tramo (puede variar entre escalas). null = usa el
        // global del vuelo.
        pasajeros: dto.es_ferry ? 0 : (dto.pasajeros ?? null),
        pasajeros_nombres: dto.es_ferry ? [] : (dto.pasajeros_nombres ?? []),
        // Sobrevuelo por tramo (metadato operativo): el switch del editor lo manda.
        ...(dto.es_sobrevuelo !== undefined
          ? { es_sobrevuelo: dto.es_sobrevuelo }
          : {}),
        // Detalle operativo del tramo (paridad con el cotizador): ferry,
        // pernocta y parada de servicio también se capturan al CREAR la
        // escala — antes solo los aplicaba updateEscala y el switch de alta
        // se perdía en silencio.
        ...(dto.es_ferry !== undefined ? { es_ferry: dto.es_ferry } : {}),
        ...(dto.requiere_pernocta !== undefined
          ? { requiere_pernocta: dto.requiere_pernocta }
          : {}),
        ...(dto.tipo_parada !== undefined
          ? { tipo_parada: dto.tipo_parada }
          : {}),
        ...(dto.servicio_notas !== undefined
          ? { servicio_notas: dto.servicio_notas }
          : {}),
        notas: dto.notas,
        created_by: userId,
        updated_by: userId,
      })
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          `Ya existe una escala con orden ${dto.orden}`,
        );
      throw new Error(error.message);
    }
    // Un tramo nuevo puede meter una pista con permiso a la ruta.
    await this.airports.refreshPermisosDeVuelo(vueloId);
    void this.notificarTramoNuevo(vueloId, data as Record<string, unknown>);
    return data!;
  }

  // Los tramos operativos internos viven en un rango de orden propio (>=100)
  // para no colisionar nunca con los comerciales (1..N) al re-cotizar.
  private static readonly OPERATIVA_ORDEN_BASE = 100;

  /**
   * Agrega un tramo OPERATIVO interno (ferry, parada técnica, movimiento
   * interno, pernocta operativa): visible para piloto/calendario/tacómetro pero
   * EXCLUIDO del precio y de la cotización del cliente. No recalcula la
   * cotización. El orden se asigna en el rango operativo (>=100).
   */
  async createOperationalLeg(
    vueloId: string,
    dto: OperationalLegDto,
    userId: string,
  ) {
    await this.findById(vueloId);
    const { data: existentes } = await this.supabase.service
      .from('escala')
      .select('orden')
      .eq('vuelo_id', vueloId);
    const maxOrden = (existentes ?? []).reduce(
      (m, e) => Math.max(m, Number(e.orden) || 0),
      0,
    );
    const orden = Math.max(maxOrden + 1, FlightsService.OPERATIVA_ORDEN_BASE);

    const { data, error } = await this.supabase.service
      .from('escala')
      .insert({
        vuelo_id: vueloId,
        orden,
        solo_operativa: true,
        origen_iata: dto.origen_iata.toUpperCase(),
        destino_iata: dto.destino_iata.toUpperCase(),
        pasajeros: dto.es_ferry ? 0 : (dto.pasajeros ?? null),
        // Manifiesto por tramo (un ferry vuela vacío: sin nombres).
        pasajeros_nombres: dto.es_ferry ? [] : (dto.pasajeros_nombres ?? []),
        es_ferry: dto.es_ferry ?? false,
        es_sobrevuelo: dto.es_sobrevuelo ?? false,
        requiere_pernocta: dto.requiere_pernocta ?? false,
        tipo_parada: dto.tipo_parada ?? 'NORMAL',
        servicio_notas: dto.servicio_notas ?? null,
        fecha_salida_plan: dto.fecha_salida_plan?.toISOString() ?? null,
        notas: dto.notas ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error)
      throw new Error(`Failed to insert operational leg: ${error.message}`);
    // Un ferry/parada técnica también puede tocar una pista con permiso.
    await this.airports.refreshPermisosDeVuelo(vueloId);
    void this.calendar.syncFlight(vueloId);
    void this.notificarTramoNuevo(vueloId, data as Record<string, unknown>);
    return data!;
  }

  /** Tramo agregado a un vuelo (21-ago): la tripulación se entera. */
  private async notificarTramoNuevo(
    vueloId: string,
    escala: Record<string, unknown>,
  ): Promise<void> {
    try {
      const vuelo = await this.findById(vueloId);
      void this.notificarTripulacion(vuelo, {
        titulo: `Tramo nuevo · vuelo #${vuelo.folio as number}`,
        cuerpo: `Se agregó el tramo ${escala.origen_iata as string} → ${escala.destino_iata as string}${escala.fecha_salida_plan ? ` (sale ${this.fechaCancunTxt(escala.fecha_salida_plan as string)})` : ''}${escala.es_ferry === true ? ' · ferry' : ''}.`,
      });
    } catch {
      /* best-effort */
    }
  }

  async updateEscala(escalaId: string, dto: UpdateEscalaDto, userId: string) {
    if (Object.keys(dto).length === 0) {
      const { data } = await this.supabase.service
        .from('escala')
        .select(ESCALA_COLS)
        .eq('id', escalaId)
        .maybeSingle();
      if (!data) throw new NotFoundException(`Escala ${escalaId} not found`);
      return data;
    }
    // Fila PREVIA (26-ago): el panel y la app en edición mandan TODO
    // explícito, así que sin comparar contra lo anterior cada guardado
    // disparaba "tramo reagendado" falso, y el cambio de RUTA era mudo.
    const { data: prev, error: prevErr } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, origen_iata, destino_iata, fecha_salida_plan, vuelo:vuelo_id(estado)',
      )
      .eq('id', escalaId)
      .maybeSingle();
    if (prevErr) throw new Error(prevErr.message);
    if (!prev) throw new NotFoundException(`Escala ${escalaId} not found`);
    const estadoVuelo =
      ((prev as { vuelo?: { estado?: string } }).vuelo?.estado as string) ??
      null;
    const fechaTramoCambia =
      dto.fecha_salida_plan instanceof Date &&
      this.fechaCambia(
        dto.fecha_salida_plan,
        (prev as { fecha_salida_plan?: unknown }).fecha_salida_plan,
      );
    // Reagendar tramos de un vuelo cerrado divergiría del candado de
    // update() (que lanzaría 409 DESPUÉS de persistir la escala).
    if (
      fechaTramoCambia &&
      (estadoVuelo === 'COMPLETADO' || estadoVuelo === 'CANCELADO')
    ) {
      throw new ConflictException(
        `No se puede reagendar un tramo de un vuelo ${estadoVuelo}.`,
      );
    }
    // La fecha del tramo 1 ES la fecha del vuelo: limpiarla aquí dejaría el
    // espejo roto. Se valida ANTES de persistir.
    if (dto.fecha_salida_plan === null && Number(prev.orden) === 1) {
      throw new BadRequestException(
        'La fecha del tramo 1 es la fecha del vuelo: cámbiala editando el vuelo.',
      );
    }
    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.orden !== undefined) patch.orden = dto.orden;
    if (dto.origen_iata) patch.origen_iata = dto.origen_iata.toUpperCase();
    if (dto.destino_iata) patch.destino_iata = dto.destino_iata.toUpperCase();
    if (dto.hora_salida) patch.hora_salida = dto.hora_salida.toISOString();
    if (dto.hora_llegada) patch.hora_llegada = dto.hora_llegada.toISOString();
    if (dto.notas !== undefined) patch.notas = dto.notas;
    // Campos operativos (editar un tramo interno desde la operación del vuelo).
    if (dto.pasajeros !== undefined) patch.pasajeros = dto.pasajeros;
    if (dto.pasajeros_nombres !== undefined)
      patch.pasajeros_nombres = dto.pasajeros_nombres;
    if (dto.es_ferry !== undefined) patch.es_ferry = dto.es_ferry;
    if (dto.es_sobrevuelo !== undefined)
      patch.es_sobrevuelo = dto.es_sobrevuelo;
    if (dto.requiere_pernocta !== undefined)
      patch.requiere_pernocta = dto.requiere_pernocta;
    if (dto.tipo_parada !== undefined) patch.tipo_parada = dto.tipo_parada;
    if (dto.servicio_notas !== undefined)
      patch.servicio_notas = dto.servicio_notas;
    if (dto.fecha_salida_plan !== undefined)
      patch.fecha_salida_plan = dto.fecha_salida_plan?.toISOString() ?? null;
    // Un ferry vuela vacío (misma regla que replaceEscalas): si el caller
    // marca ferry sin mandar pasajeros/manifiesto, se limpian aquí — la app
    // vieja los omitía y quedaban nombres fantasma en tramos ferry.
    if (dto.es_ferry === true) {
      if (dto.pasajeros === undefined) patch.pasajeros = 0;
      if (dto.pasajeros_nombres === undefined) patch.pasajeros_nombres = [];
    }

    const { data, error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('id', escalaId)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('orden ya existe en este vuelo');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Escala ${escalaId} not found`);
    // Cambió la ruta del tramo: puede entrar (o salir) una pista con permiso.
    const rutaCambia =
      (dto.origen_iata !== undefined &&
        dto.origen_iata.toUpperCase() !== (prev.origen_iata as string)) ||
      (dto.destino_iata !== undefined &&
        dto.destino_iata.toUpperCase() !== (prev.destino_iata as string));
    if (dto.origen_iata !== undefined || dto.destino_iata !== undefined) {
      await this.airports.refreshPermisosDeVuelo(data.vuelo_id as string);
    }
    // Cambio de RUTA del tramo (26-ago): antes era mudo — el piloto volaba
    // con el itinerario viejo en la cabeza.
    if (rutaCambia) {
      try {
        const vuelo = await this.findById(data.vuelo_id as string);
        void this.notificarTripulacion(vuelo, {
          titulo: `Vuelo #${vuelo.folio as number}: cambió la ruta de un tramo`,
          cuerpo: `El tramo ${prev.origen_iata as string} → ${prev.destino_iata as string} ahora es ${data.origen_iata as string} → ${data.destino_iata as string}.`,
        });
      } catch {
        /* best-effort */
      }
      void this.calendar.syncFlight(data.vuelo_id as string);
    }
    // Espejo inverso: la salida plan del TRAMO 1 es la fecha del vuelo. Pasa
    // por update() para reusar el push de reagenda al piloto (doc 4.3) y el
    // sync de calendario. Los tramos 2+ solo refrescan el calendario.
    // OJO (26-ago): solo si la fecha REALMENTE cambió — la app manda todo
    // explícito y cada edición disparaba "reagendado" falso.
    if (dto.fecha_salida_plan instanceof Date && fechaTramoCambia) {
      if (Number(data.orden) === 1) {
        await this.update(
          data.vuelo_id as string,
          { fecha_vuelo: dto.fecha_salida_plan },
          userId,
        );
      } else {
        void this.calendar.syncFlight(data.vuelo_id as string);
        // Tramos 2+ (21-ago): la reagenda del tramo también se avisa a la
        // tripulación (antes solo refrescaba el calendario).
        try {
          const vuelo = await this.findById(data.vuelo_id as string);
          void this.notificarTripulacion(vuelo, {
            titulo: `Vuelo #${vuelo.folio as number}: tramo reagendado`,
            cuerpo: `${data.origen_iata as string} → ${data.destino_iata as string} ahora sale ${this.fechaCancunTxt(dto.fecha_salida_plan)} (hora Cancún).`,
          });
        } catch {
          /* best-effort */
        }
      }
    } else if (
      dto.fecha_salida_plan === null &&
      (prev as { fecha_salida_plan?: unknown }).fecha_salida_plan != null
    ) {
      // Limpiar la fecha de un tramo también es un cambio de agenda
      // (el caso orden=1 ya se rechazó antes de persistir).
      void this.calendar.syncFlight(data.vuelo_id as string);
      try {
        const vuelo = await this.findById(data.vuelo_id as string);
        void this.notificarTripulacion(vuelo, {
          titulo: `Vuelo #${vuelo.folio as number}: tramo sin fecha`,
          cuerpo: `Se quitó la fecha del tramo ${data.origen_iata as string} → ${data.destino_iata as string}: hereda el día del tramo anterior.`,
        });
      } catch {
        /* best-effort */
      }
    }
    return data;
  }

  async captureTaco(escalaId: string, dto: CaptureTacoDto, userId: string) {
    const { data: current, error: readErr } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, aeronave_id, taco_salida, taco_llegada, taco_salida_origen, taco_llegada_origen, capturado_por, cancelada_at, revision_motivo, vuelo:vuelo_id(fecha_vuelo, fecha_fin)',
      )
      .eq('id', escalaId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!current) throw new NotFoundException(`Escala ${escalaId} not found`);
    if (current.cancelada_at) {
      throw new ConflictException(
        'Este tramo está cancelado (no voló): no se capturan tacómetros. Si sí voló, restáuralo primero en el detalle del vuelo.',
      );
    }

    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('Empty taco payload');
    }

    // Normaliza a 1 decimal ANTES de validar: las validaciones, el patch y la
    // propagación al siguiente tramo usan el mismo valor redondeado.
    if (dto.taco_salida !== undefined)
      dto.taco_salida = roundTaco(dto.taco_salida);
    if (dto.taco_llegada !== undefined)
      dto.taco_llegada = roundTaco(dto.taco_llegada);
    if (dto.valor_ia_propuesto !== undefined && dto.valor_ia_propuesto !== null)
      dto.valor_ia_propuesto = roundTaco(dto.valor_ia_propuesto);

    // Validate monotonicity: new taco_salida/llegada must be >= existing capture.
    // Excepciones al "nunca retrocede" del MISMO campo del MISMO tramo:
    // - DEDUCIDO (promesa provisional del sistema) siempre cede ante la foto.
    // - La lectura PROPIA del capturador (PILOTO/IA) SÍ puede corregirse a la
    //   baja en vuelos RECIENTES (bug 17-ago: el piloto tecleó 5548.5, la
    //   foto real decía 5547.8 y el 409 lo dejaba sin poder corregir NI
    //   cambiar la foto; obligar a llamar a oficina dejaba el dato malo
    //   guardado). JAMÁS en silencio: el tramo queda AMARILLO — atómico con
    //   el valor y PEGAJOSO hasta que oficina confirme.
    // - Lo corregido por OFICINA es palabra final: no se mueve desde la app
    //   en NINGUNA dirección (permitir la subida abría un bypass: subir
    //   primero re-etiquetaba el origen y luego se podía bajar).
    if (
      dto.taco_salida !== undefined &&
      current.taco_salida !== null &&
      current.taco_salida_origen === 'OFICINA' &&
      Number(dto.taco_salida) !== Number(current.taco_salida)
    ) {
      throw new ConflictException(
        `La salida (${current.taco_salida}) ya fue corregida por la oficina y no puede cambiarse desde la app. Repórtalo a oficina para ajustarla.`,
      );
    }
    if (
      dto.taco_llegada !== undefined &&
      current.taco_llegada !== null &&
      current.taco_llegada_origen === 'OFICINA' &&
      Number(dto.taco_llegada) !== Number(current.taco_llegada)
    ) {
      throw new ConflictException(
        `La llegada (${current.taco_llegada}) ya fue corregida por la oficina y no puede cambiarse desde la app. Repórtalo a oficina para ajustarla.`,
      );
    }
    const correccionesALaBaja: string[] = [];
    let llegadaBajadaDesde: number | null = null;
    if (
      dto.taco_salida !== undefined &&
      current.taco_salida !== null &&
      current.taco_salida_origen !== 'DEDUCIDO' &&
      Number(dto.taco_salida) < Number(current.taco_salida)
    ) {
      correccionesALaBaja.push(
        `salida ${current.taco_salida} → ${dto.taco_salida}`,
      );
    }
    if (
      dto.taco_llegada !== undefined &&
      current.taco_llegada !== null &&
      current.taco_llegada_origen !== 'DEDUCIDO' &&
      Number(dto.taco_llegada) < Number(current.taco_llegada)
    ) {
      llegadaBajadaDesde = Number(current.taco_llegada);
      correccionesALaBaja.push(
        `llegada ${current.taco_llegada} → ${dto.taco_llegada}`,
      );
    }
    if (correccionesALaBaja.length > 0) {
      // Solo vuelos recientes: sin cierre mensual persistido, bajar horas de
      // un periodo ya repartido movería números ya pagados sin que nadie
      // tenga motivo para abrir ese vuelo viejo. Más de 7 días = con oficina.
      const vuelo = current.vuelo as {
        fecha_vuelo?: string | null;
        fecha_fin?: string | null;
      } | null;
      const fechaRef = vuelo?.fecha_fin ?? vuelo?.fecha_vuelo ?? null;
      // fecha_vuelo/fecha_fin son timestamptz: convertir AMBOS lados a día
      // Cancún antes de restar, o el conteo sale hasta un día corto.
      const aDiaCancun = (iso: string) =>
        new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cancun' }).format(
          new Date(iso),
        );
      const hoy = aDiaCancun(new Date().toISOString());
      const dias =
        fechaRef != null
          ? Math.floor(
              (Date.parse(hoy) - Date.parse(aDiaCancun(fechaRef))) / 86400000,
            )
          : null;
      if (dias == null || dias > 7) {
        throw new ConflictException(
          'Esta lectura es de hace más de 7 días: la corrección a la baja se hace con la oficina (Tacómetros en vivo).',
        );
      }
    }
    if (
      dto.taco_llegada !== undefined &&
      dto.taco_salida !== undefined &&
      Number(dto.taco_llegada) <= Number(dto.taco_salida)
    ) {
      throw new ConflictException(
        'La llegada debe ser mayor que la salida (las horas del tramo saldrían en cero o negativas).',
      );
    }
    // El check de la BD exige llegada > salida ESTRICTO; usar >= aquí para que
    // el rechazo llegue con explicación y no como error genérico de Postgres.
    if (
      dto.taco_salida !== undefined &&
      dto.taco_llegada === undefined &&
      current.taco_llegada !== null &&
      Number(dto.taco_salida) >= Number(current.taco_llegada)
    ) {
      throw new ConflictException(
        `La salida (${dto.taco_salida}) no puede ser igual o mayor que la llegada ya registrada de este tramo (${current.taco_llegada}). La foto de la salida se toma ANTES de volar el tramo; si la que está mal es la llegada, corrígela la oficina.`,
      );
    }
    // Camino solo-llegada contra una salida YA existente que la contradice
    // (llegada <= salida). Sin esta guarda el CHECK de BD (llegada > salida)
    // reventaba como 500 genérico (caso real vuelo #73: la cascada fabricó un
    // tramo fantasma de 0.4 h y el piloto no podía guardar su llegada real).
    // Un valor DEDUCIDO es una promesa provisional, jamás un candado contra
    // la evidencia real: la evidencia SIEMPRE gana, el deducido CEDE.
    let salidaDeducidaCede = false;
    if (
      dto.taco_llegada !== undefined &&
      dto.taco_salida === undefined &&
      current.taco_salida != null &&
      Number(dto.taco_llegada) <= Number(current.taco_salida)
    ) {
      if (current.taco_salida_origen === 'DEDUCIDO') {
        // El deducido cede: se libera el asiento de la salida (la propagación
        // de la llegada real del tramo anterior o la oficina lo rellenan — el
        // sistema se auto-repara) y entra la llegada REAL del piloto.
        salidaDeducidaCede = true;
      } else {
        throw new ConflictException(
          `La llegada (${dto.taco_llegada}) debe ser mayor que la salida ya registrada (${current.taco_salida}). El tacómetro nunca retrocede; revisa la foto o repórtalo a oficina.`,
        );
      }
    }

    const patch: Record<string, unknown> = {
      updated_by: userId,
      capturado_por: userId,
      sincronizado_at: new Date().toISOString(),
    };
    // UNA foto por escala (acuerdo de junta): el piloto solo captura la
    // LLEGADA. Si este tramo aún no tiene salida, se llena sola con el último
    // tacómetro conocido del avión — físicamente es el mismo número (el
    // horómetro no se mueve con el avión apagado).
    if (
      dto.taco_llegada !== undefined &&
      dto.taco_salida === undefined &&
      current.taco_salida == null
    ) {
      // Avión con herencia: el tramo sin avión propio es del avión del vuelo
      // — con el null crudo el ancla/relleno se apagaba en silencio.
      const ultimo = await this.ultimoTacoAeronave(
        (current.aeronave_id as string | null) ??
          (await this.aeronaveDelVuelo(current.vuelo_id as string)),
        null,
      );
      if (ultimo != null && ultimo <= Number(dto.taco_llegada)) {
        patch.taco_salida = ultimo;
        patch.taco_salida_origen = 'DEDUCIDO';
      }
    } else if (
      dto.taco_llegada !== undefined &&
      dto.taco_salida === undefined &&
      current.taco_salida != null &&
      current.taco_salida_origen === 'DEDUCIDO' &&
      !salidaDeducidaCede
    ) {
      // La salida DEDUCIDA de este tramo puede haber quedado VIEJA (caso
      // #123: se copió la llegada errónea del tramo anterior y el piloto la
      // corrigió después). Editar la llegada de ESTE tramo la re-sincroniza
      // con la llegada real del tramo anterior — la identidad física manda.
      const correcta = await this.llegadaDelTramoAnterior(
        current.vuelo_id as string,
        current.orden as number,
        current.aeronave_id as string | null,
      );
      if (correcta != null && correcta !== Number(current.taco_salida)) {
        // Escritura APARTE con guarda por origen (no en el patch): si el
        // piloto u oficina capturaron la salida real entre la lectura y este
        // write, el UPDATE afecta 0 filas y la captura real no se pisa jamás.
        const cabe = correcta < Number(dto.taco_llegada);
        await this.supabase.service
          .from('escala')
          .update(
            cabe
              ? {
                  taco_salida: correcta,
                  taco_salida_origen: 'DEDUCIDO',
                  updated_by: userId,
                }
              : {
                  // No cabe bajo la llegada capturada: la copia vieja cede en
                  // amarillo — jamás abandonar en silencio con el dato falso.
                  taco_salida: null,
                  taco_salida_origen: null,
                  revision_requerida: true,
                  revision_motivo: motivoDirecto(
                    (current.revision_motivo as string | null) ?? null,
                    `Salida estimada retirada: la llegada real del tramo anterior (${correcta}) no cabe bajo la llegada capturada (${dto.taco_llegada}) — revisar ambas lecturas en oficina`,
                  ),
                  updated_by: userId,
                },
          )
          .eq('id', escalaId)
          .eq('taco_salida_origen', 'DEDUCIDO');
      }
    }
    let alertaCede: string | null = null;
    if (salidaDeducidaCede) {
      // El CHECK de BD tolera salida NULL con llegada presente; nada de este
      // request la rellena de vuelta (el auto-fill de arriba solo corre cuando
      // current.taco_salida era null EN EL READ). El motivo se arma en el
      // bloque centralizado de abajo: conserva chunks pegajosos y bitácora,
      // y se fusiona con la corrección a la baja si vienen juntos.
      patch.taco_salida = null;
      patch.taco_salida_origen = null;
      patch.revision_requerida = true;
      alertaCede = `Salida estimada retirada: la llegada real (${dto.taco_llegada}) la contradecía — confirmar salida en oficina`;
    }
    if (dto.taco_salida !== undefined) {
      patch.taco_salida = dto.taco_salida;
      // Reenviar el MISMO valor no degrada el sello de OFICINA a PILOTO
      // (outbox idéntico tras una confirmación): con valor distinto ya
      // habría tronado el candado de arriba.
      if (current.taco_salida_origen !== 'OFICINA') {
        patch.taco_salida_origen = 'PILOTO';
      }
    }
    if (dto.taco_llegada !== undefined) {
      patch.taco_llegada = dto.taco_llegada;
      if (current.taco_llegada_origen !== 'OFICINA') {
        patch.taco_llegada_origen = 'PILOTO';
      }
    }
    if (dto.foto_taco_salida_url !== undefined)
      patch.foto_taco_salida_url = dto.foto_taco_salida_url;
    if (dto.foto_taco_llegada_url !== undefined)
      patch.foto_taco_llegada_url = dto.foto_taco_llegada_url;
    if (dto.valor_ia_propuesto !== undefined)
      patch.valor_ia_propuesto = dto.valor_ia_propuesto;
    if (dto.hora_salida !== undefined)
      patch.hora_salida = dto.hora_salida.toISOString();
    if (dto.hora_llegada !== undefined)
      patch.hora_llegada = dto.hora_llegada.toISOString();
    if (dto.capturado_offline !== undefined)
      patch.capturado_offline = dto.capturado_offline;

    const alertaCorreccion =
      correccionesALaBaja.length > 0
        ? `${CORRECCION_BAJA_PREFIX}${correccionesALaBaja.join(' · ')}`
        : null;
    if (alertaCorreccion || alertaCede) {
      // Amarillo ATÓMICO con el valor (mismo update: si la request muere
      // después, el reintento idéntico del outbox ya no detectaría la baja y
      // la corrección quedaría sin rastro) y PEGAJOSO (applyConsistencyFlag
      // conserva el chunk entre recálculos; solo confirmTaco lo retira).
      // Conserva chunks pegajosos previos y la bitácora; en el camino del
      // cede (que se salta el recálculo) la corrección también se asienta en
      // la bitácora — historial permanente que sobrevive a la confirmación.
      const previo = (current.revision_motivo as string | null) ?? null;
      let bitacoraPrev = leerBitacora(previo);
      if (salidaDeducidaCede && correccionesALaBaja.length > 0) {
        for (const c of correccionesALaBaja) {
          bitacoraPrev = agregarProcedencia(
            bitacoraPrev,
            `corregida a la baja: ${c}`,
          );
        }
      }
      patch.revision_requerida = true;
      patch.revision_motivo = [
        alertaCorreccion,
        alertaCede,
        ...correccionesBajaPendientes(previo).filter(
          (c) => c !== alertaCorreccion,
        ),
        bitacoraPrev ? `${PROCEDENCIA_PREFIX}${bitacoraPrev}` : null,
      ]
        .filter((p): p is string => !!p)
        .join('; ')
        .slice(0, 1800);
    }

    const { data, error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('id', escalaId)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) {
      // Violación de CHECK (llegada > salida) = datos que no cuadran, NO un
      // fallo transitorio: un 500 dispararía el reintento infinito del outbox
      // de la app. Se responde 409 con explicación accionable.
      if (
        error.code === '23514' ||
        /violates check constraint/i.test(error.message ?? '')
      ) {
        throw new ConflictException(
          'Las lecturas no cuadran entre sí (la llegada debe ser mayor que la salida). Revisa los valores; si hay un estimado del sistema estorbando, la oficina puede corregirlo en Tacómetros en vivo.',
        );
      }
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Escala ${escalaId} not found`);

    // Si el deducido cedió, la fila YA quedó en AMARILLO con su motivo
    // específico; applyConsistencyFlag recalcula desde cero y lo borraría
    // (sin salida no hay duración que evaluar). Oficina la revisa igual.
    // Procedencia de esta captura: qué leyó la IA, con qué confianza y calidad
    // de foto, y quién la aceptó. Si la foto salió dudosa, la lectura queda en
    // AMARILLO aunque los números cuadren — el caso del 28 jul 2026 (1621.8 vs
    // 1621.9) pasó todas las validaciones numéricas sin avisar a nadie.
    const procedencia: string[] = [];
    let forzarRevision: string | null = null;
    const lados: Array<'salida' | 'llegada'> = [];
    if (dto.taco_salida !== undefined) lados.push('salida');
    if (dto.taco_llegada !== undefined) lados.push('llegada');
    if (lados.length > 0) {
      const quien = (await this.nombreUsuario(userId)) ?? 'el piloto';
      const lado = lados.join(' y ');
      if (dto.ia_calidad_foto || dto.ia_confianza != null) {
        const calidad = calidadFoto({
          confianza: dto.ia_confianza,
          calidad_foto: dto.ia_calidad_foto,
        });
        const pct =
          dto.ia_confianza != null
            ? `, confianza ${Math.round(Number(dto.ia_confianza) * 100)}%`
            : '';
        const nota = dto.ia_notas?.trim() ? ` — ${dto.ia_notas.trim()}` : '';
        procedencia.push(
          `${lado} leída con IA (${calidadLabel(calidad)}${pct})${nota} y aceptada por ${quien}`,
        );
        if (calidad === 'BAJA') {
          forzarRevision =
            'La foto quedó BORROSA/dudosa: la IA pudo equivocarse de dígito — verificar contra la foto antes de dar por buena la lectura';
        }
      } else {
        procedencia.push(`${lado} capturada por ${quien}`);
      }
    }
    // La corrección a la baja también se asienta en la BITÁCORA (historial
    // permanente: sobrevive a la confirmación de oficina, a diferencia del
    // chunk pegajoso de alerta que confirmTaco retira al confirmar).
    if (correccionesALaBaja.length > 0) {
      procedencia.push(
        ...correccionesALaBaja.map((c) => `corregida a la baja: ${c}`),
      );
    }

    let finalRow = salidaDeducidaCede
      ? data
      : await this.applyConsistencyFlag(data, userId, {
          procedencia,
          forzarRevision,
        });
    // Ahorra un paso: la llegada de un tramo es la salida del siguiente. Si se
    // capturó taco_llegada, se copia como taco_salida del próximo tramo comercial
    // (mismo avión, salida aún vacía) para que el piloto no la reescriba.
    if (dto.taco_llegada !== undefined) {
      await this.propagarLlegadaASalidaSiguiente(
        current.vuelo_id as string,
        current.orden as number,
        current.aeronave_id as string | null,
        Number(dto.taco_llegada),
        userId,
      );
    }
    // La llegada corregida A LA BAJA pudo ser ANCLA (último taco del avión)
    // de la salida DEDUCIDA de un vuelo POSTERIOR: re-sincronizar esas copias
    // para que las horas del vuelo hijo no queden infladas en silencio.
    if (llegadaBajadaDesde != null && dto.taco_llegada !== undefined) {
      const avionCorreccion =
        (current.aeronave_id as string | null) ??
        (await this.aeronaveDelVuelo(current.vuelo_id as string));
      if (avionCorreccion) {
        await this.resincronizarAnclasDeCorreccion(
          escalaId,
          avionCorreccion,
          llegadaBajadaDesde,
          Number(dto.taco_llegada),
          userId,
        );
      }
    }
    // Sincronización offline con foto pero sin lectura confirmada por el
    // piloto: el servidor intenta leer la foto con IA. La lectura IA nunca se
    // da por buena — queda en AMARILLO (revision_requerida) hasta que oficina
    // la confirme.
    if (dto.capturado_offline && dto.pendiente_lectura) {
      finalRow = await this.resolverLecturaPendiente(finalRow, userId);
    }
    void this.notifyTacoCaptured(finalRow);
    // El estado del vuelo se DERIVA de los tacómetros (ya no hay botones
    // Iniciar/Finalizar): la primera captura lo pone EN_VUELO y, cuando no
    // faltan llegadas, en COMPLETADO. Best-effort: si algo falla aquí, la
    // captura ya quedó guardada — jamás se pierde ni se bloquea.
    try {
      await this.syncEstadoDesdeTacos(current.vuelo_id as string, userId);
    } catch (err) {
      this.logger.warn(
        `No se pudo derivar el estado del vuelo tras capturar taco: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return finalRow;
  }

  /**
   * Deriva el estado del vuelo a partir de sus tacómetros (reemplaza los
   * botones Iniciar/Finalizar). SOLO avanza, nunca retrocede:
   *   iniciable → EN_VUELO (con la primera lectura capturada)
   *   EN_VUELO  → COMPLETADO (cuando no faltan LLEGADAS)
   * Los vuelos externos (sin tacómetros) siguen manejándose a mano en el
   * panel. Un COMPLETADO/CANCELADO no vuelve atrás por una corrección de taco.
   */
  private async syncEstadoDesdeTacos(
    vueloId: string,
    userId: string | null,
  ): Promise<void> {
    const current = await this.findById(vueloId);
    if (current.es_externo) return;
    const estado = current.estado as string;
    const iniciables = ['RESERVA', 'SOLICITUD', 'COTIZADO', 'CONFIRMADO'];

    // "Inició": la captura del tacómetro es la señal de que el vuelo despegó.
    if (iniciables.includes(estado)) {
      const { error } = await this.supabase.service
        .from('vuelo')
        .update({ estado: 'EN_VUELO', updated_by: userId })
        .eq('id', vueloId);
      if (error) throw new Error(error.message);
      void this.calendar.syncFlight(vueloId);
    }

    // "Finalizó": todas las llegadas capturadas → cierra (reutiliza complete()
    // para arrastrar recordTramoTiempos + sync de calendario). complete() exige
    // estado EN_VUELO, que ya garantizamos arriba.
    if (estado === 'EN_VUELO' || iniciables.includes(estado)) {
      if (!this.faltanLlegadas(await this.escalasTaco(vueloId))) {
        await this.complete(vueloId, userId);
      }
    }
  }

  /**
   * Resuelve lecturas faltantes de una escala sincronizada offline: por cada
   * lado (salida/llegada) con foto pero sin valor, lee la foto con IA (URL
   * firmada del bucket privado). El resultado SIEMPRE queda marcado con
   * revision_requerida=true para confirmación en oficina; una lectura menor al
   * último tacómetro del avión no se aplica (solo se reporta el motivo). La
   * llegada resuelta por IA NO se propaga al siguiente tramo hasta confirmarse.
   */
  private async resolverLecturaPendiente(
    escala: Record<string, unknown>,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const motivos: string[] = [];
    const bitacoraLineas: string[] = [];
    const patch: Record<string, unknown> = {};
    const tacoSalidaActual =
      escala.taco_salida === null ? null : Number(escala.taco_salida);

    for (const which of ['salida', 'llegada'] as const) {
      const valor = escala[`taco_${which}`];
      const foto = escala[`foto_taco_${which}_url`] as string | null;
      if (valor !== null && valor !== undefined) continue;
      if (!foto) continue;

      const signed = await this.signedTacoUrl(foto);
      if (!signed) {
        motivos.push(
          `Foto de ${which} sincronizada pero no accesible — revisar`,
        );
        continue;
      }
      const ultimo = await this.ultimoTacoAeronave(
        (escala.aeronave_id as string | null) ??
          (await this.aeronaveDelVuelo(escala.vuelo_id as string)),
        tacoSalidaActual,
      );
      // Con la bandera apagada no se gastan créditos: la foto queda como
      // evidencia y el tramo en revisión para que oficina teclee la lectura
      // (mismo camino que cuando la IA no está disponible).
      const fotoIaActiva = await this.configuracion.isActiva(
        CONFIG_CAPTURA_TACO_FOTO_IA,
      );
      const ia = fotoIaActiva
        ? await this.vision.readTacometro({ imageUrl: signed, ultimo })
        : null;

      if (!ia || !ia.legible || ia.lectura === null) {
        motivos.push(
          fotoIaActiva
            ? `Foto de ${which} sincronizada sin lectura legible — capturar manualmente`
            : `Foto de ${which} sincronizada con la lectura IA desactivada — capturar manualmente`,
        );
        continue;
      }
      const lectura = Number(ia.lectura);
      if (ultimo !== null && lectura < ultimo) {
        motivos.push(
          `IA leyó ${which} ${lectura} menor al último tacómetro del avión (${ultimo}) — revisar foto`,
        );
        continue;
      }
      if (
        which === 'llegada' &&
        tacoSalidaActual !== null &&
        lectura < tacoSalidaActual
      ) {
        motivos.push(
          `IA leyó llegada ${lectura} menor a la salida (${tacoSalidaActual}) — revisar foto`,
        );
        continue;
      }
      patch[`taco_${which}`] = roundTaco(lectura);
      patch[`taco_${which}_origen`] = 'IA';
      patch.valor_ia_propuesto = roundTaco(lectura);
      const pct = Math.round((ia.confianza ?? 0) * 100);
      const calidad = calidadFoto(ia);
      const detalle = ia.notas?.trim() ? ` — ${ia.notas.trim()}` : '';
      bitacoraLineas.push(
        `${which} leída con IA al sincronizar (${calidadLabel(calidad)}, confianza ${pct}%)${detalle} · sin confirmar`,
      );
      motivos.push(
        calidad === 'BAJA'
          ? `Lectura de ${which} leída por IA de una foto BORROSA (confianza ${pct}%): pudo equivocarse de dígito — verificar contra la foto`
          : `Lectura de ${which} leída por IA al sincronizar (confianza ${pct}%) — confirmar en oficina`,
      );
    }

    // Una foto por escala: si la IA resolvió la llegada y la salida sigue
    // vacía (de salida nunca hay foto), se llena con el último taco del avión.
    if (
      patch.taco_llegada !== undefined &&
      tacoSalidaActual === null &&
      escala.foto_taco_salida_url == null
    ) {
      const ultimo = await this.ultimoTacoAeronave(
        (escala.aeronave_id as string | null) ??
          (await this.aeronaveDelVuelo(escala.vuelo_id as string)),
        null,
      );
      if (ultimo != null && ultimo <= Number(patch.taco_llegada)) {
        patch.taco_salida = ultimo;
        patch.taco_salida_origen = 'DEDUCIDO';
      }
    }

    if (motivos.length === 0) return escala;
    patch.revision_requerida = true;
    // Bitácora (cómo entró el número) primero y motivos de revisión después:
    // el mismo formato que usa applyConsistencyFlag.
    const bitacora = bitacoraLineas.reduce<string | null>(
      (acc, linea) => agregarProcedencia(acc, linea),
      leerBitacora((escala.revision_motivo as string | null) ?? null),
    );
    patch.revision_motivo = [
      motivos.join('; '),
      // Chunks pegajosos (corrección a la baja pendiente): sobreviven a esta
      // reescritura — solo confirmTaco los retira.
      ...correccionesBajaPendientes(
        (escala.revision_motivo as string | null) ?? null,
      ),
      bitacora ? `${PROCEDENCIA_PREFIX}${bitacora}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    patch.updated_by = userId;

    const { data, error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('id', escala.id as string)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) {
      this.logger.warn(`resolverLecturaPendiente falló: ${error.message}`);
      return escala;
    }
    return data ?? escala;
  }

  /** URL firmada (1 h) de una foto del bucket privado taco-fotos. */
  private async signedTacoUrl(path: string): Promise<string | null> {
    const { data } = await this.supabase.service.storage
      .from('taco-fotos')
      .createSignedUrl(path, 3600);
    return data?.signedUrl ?? null;
  }

  /**
   * Confirmación de oficina (amarillo → verde): limpia revision_requerida y
   * registra quién revisó. Permite corregir las lecturas en el mismo paso; si
   * se corrige la llegada, se propaga como salida del siguiente tramo.
   */
  /**
   * Borra las lecturas de UN tramo (solo oficina) para que el piloto las
   * vuelva a capturar. Caso que lo motivó (1 ago 2026): el primer vuelo se
   * demoró y el piloto capturó sus tacómetros en el vuelo equivocado — la
   * oficina solo podía CORREGIR el número, no dejar el tramo limpio.
   *
   * Por cada lado borrado se limpian lectura, origen, foto y hora real; la
   * bitácora de procedencia CONSERVA quién lo borró. Si el vuelo estaba
   * COMPLETADO y ahora le falta una llegada, regresa a EN_VUELO (el estado se
   * deriva de los tacómetros). El piloto del tramo recibe un push para
   * recapturar.
   */
  /**
   * Observación del EQUIPO sobre una lectura de taco (pedido 26-ago-2026):
   * texto deliberado que explica la lectura (recalibración, brinco
   * justificado, verificación). NO toca valores, estado, revisión ni
   * bitácora técnica — solo las columnas de observación. Se muestra en
   * Tacómetros en vivo, en el histórico del avión y en el Excel del
   * balance (celda ámbar + nota con quién y cuándo).
   */
  async tacoObs(
    escalaId: string,
    dto: { taco_salida_obs?: string | null; taco_llegada_obs?: string | null },
    userId: string,
  ) {
    const patch: Record<string, unknown> = {
      taco_obs_updated_by: userId,
      taco_obs_updated_at: new Date().toISOString(),
      updated_by: userId,
    };
    if (dto.taco_salida_obs !== undefined) {
      patch.taco_salida_obs = dto.taco_salida_obs?.trim() || null;
    }
    if (dto.taco_llegada_obs !== undefined) {
      patch.taco_llegada_obs = dto.taco_llegada_obs?.trim() || null;
    }
    const { data, error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('id', escalaId)
      .select(
        'id, vuelo_id, taco_salida_obs, taco_llegada_obs, taco_obs_updated_at',
      )
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Escala ${escalaId} not found`);
    return data;
  }

  async clearTaco(escalaId: string, dto: ClearTacoDto, userId: string) {
    const { data: current, error: readErr } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, origen_iata, destino_iata, piloto_id, taco_salida, taco_llegada, revision_motivo',
      )
      .eq('id', escalaId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!current) throw new NotFoundException(`Escala ${escalaId} not found`);

    const borrarSalida = dto.salida === true && current.taco_salida !== null;
    const borrarLlegada = dto.llegada === true && current.taco_llegada !== null;
    if (!borrarSalida && !borrarLlegada) {
      throw new ConflictException(
        'No hay lecturas que borrar en los lados seleccionados.',
      );
    }

    const quien = (await this.nombreUsuario(userId)) ?? 'oficina';
    const lados = [
      ...(borrarSalida ? ['salida'] : []),
      ...(borrarLlegada ? ['llegada'] : []),
    ].join(' y ');
    const bitacora = agregarProcedencia(
      leerBitacora((current.revision_motivo as string | null) ?? null),
      `${lados} borrada(s) por ${quien} (oficina) para recapturar`,
    );

    const patch: Record<string, unknown> = {
      // Sin lecturas no hay nada que revisar: el tramo queda esperando la
      // captura nueva (taco-live lo muestra en curso/vencido).
      revision_requerida: false,
      revision_motivo: `${PROCEDENCIA_PREFIX}${bitacora}`,
      valor_ia_propuesto: null,
      corregido_por: userId,
      corregido_at: new Date().toISOString(),
      updated_by: userId,
    };
    if (borrarSalida) {
      patch.taco_salida = null;
      patch.taco_salida_origen = null;
      patch.foto_taco_salida_url = null;
      patch.hora_salida = null;
    }
    if (borrarLlegada) {
      patch.taco_llegada = null;
      patch.taco_llegada_origen = null;
      patch.foto_taco_llegada_url = null;
      patch.hora_llegada = null;
    }

    const { data, error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('id', escalaId)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Escala ${escalaId} not found`);

    // Estado derivado: COMPLETADO exige todas las llegadas. Si el borrado
    // dejó un hueco, el vuelo regresa a EN_VUELO para poder recapturar (la
    // llegada nueva lo volverá a completar sola).
    const vueloId = current.vuelo_id as string;
    if (borrarLlegada) {
      const vuelo = await this.findById(vueloId);
      if (
        vuelo.estado === 'COMPLETADO' &&
        this.faltanLlegadas(await this.escalasTaco(vueloId))
      ) {
        await this.supabase.service
          .from('vuelo')
          .update({ estado: 'EN_VUELO', updated_by: userId })
          .eq('id', vueloId)
          .eq('estado', 'COMPLETADO');
        void this.calendar.syncFlight(vueloId);
      }
    }

    // Aviso al piloto del tramo: sin esto se entera hasta que alguien le
    // hable. Best-effort.
    const pilotoId =
      (current.piloto_id as string | null) ??
      ((await this.findById(vueloId)).piloto_id as string | null);
    if (pilotoId) {
      void this.notifications.notifyUser(pilotoId, {
        tipo: 'recordatorio_taco',
        titulo: 'Vuelve a capturar el tacómetro',
        cuerpo: `${current.origen_iata as string} → ${current.destino_iata as string}: la oficina borró la lectura de ${lados} para que la subas de nuevo.`,
        data: { escala_id: escalaId, vuelo_id: vueloId },
        link: `/flights/${vueloId}`,
      });
    }

    return data;
  }

  async confirmTaco(escalaId: string, dto: ConfirmTacoDto, userId: string) {
    const { data: current, error: readErr } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, aeronave_id, taco_salida, taco_salida_origen, taco_llegada, cancelada_at, revision_motivo',
      )
      .eq('id', escalaId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!current) throw new NotFoundException(`Escala ${escalaId} not found`);
    if (current.cancelada_at) {
      throw new ConflictException(
        'Este tramo está cancelado (no voló): no hay tacómetro que confirmar. Si sí voló, restáuralo primero.',
      );
    }

    // Regla de 1 decimal: normaliza lo tecleado por oficina antes de validar.
    if (dto.taco_salida !== undefined && dto.taco_salida !== null)
      dto.taco_salida = roundTaco(dto.taco_salida);
    if (dto.taco_llegada !== undefined && dto.taco_llegada !== null)
      dto.taco_llegada = roundTaco(dto.taco_llegada);

    const salida =
      dto.taco_salida ??
      (current.taco_salida === null ? null : Number(current.taco_salida));
    const llegada =
      dto.taco_llegada ??
      (current.taco_llegada === null ? null : Number(current.taco_llegada));
    // El CHECK de BD es ESTRICTO (llegada > salida): la igualdad también
    // revienta — mejor un 409 claro aquí que un 500 del CHECK.
    if (salida !== null && llegada !== null && llegada <= salida) {
      throw new ConflictException(
        `taco_llegada (${llegada}) debe ser MAYOR a taco_salida (${salida}): un tramo volado no puede quedar en 0.0 horas`,
      );
    }

    // La bitácora de procedencia NO se borra al confirmar: se le agrega quién
    // confirmó. Antes quedaba en null y el registro perdía toda explicación de
    // cómo había entrado el número (justo la duda de la oficina).
    const quienConfirma = (await this.nombreUsuario(userId)) ?? 'oficina';
    const corrige =
      (dto.taco_salida !== undefined && dto.taco_salida !== null) ||
      (dto.taco_llegada !== undefined && dto.taco_llegada !== null);
    const bitacora = agregarProcedencia(
      leerBitacora((current.revision_motivo as string | null) ?? null),
      `${corrige ? 'corregida' : 'confirmada'} por ${quienConfirma} (oficina)${
        dto.nota?.trim() ? `: ${dto.nota.trim()}` : ''
      }`,
    );
    const patch: Record<string, unknown> = {
      revision_requerida: false,
      revision_motivo: `${PROCEDENCIA_PREFIX}${bitacora}`,
      corregido_por: userId,
      corregido_at: new Date().toISOString(),
      updated_by: userId,
    };
    // Igual que captureTaco: si la oficina captura solo la LLEGADA (caso
    // piloto externo) y el tramo no tiene salida, se llena sola con el último
    // taco del avión (DEDUCIDO) — sin esto el tramo queda sin horas (las
    // horas voladas se derivan de llegada − salida).
    if (
      dto.taco_llegada !== undefined &&
      dto.taco_salida === undefined &&
      current.taco_salida == null
    ) {
      // Avión con herencia: el tramo sin avión propio es del avión del vuelo
      // — con el null crudo el ancla/relleno se apagaba en silencio.
      const ultimo = await this.ultimoTacoAeronave(
        (current.aeronave_id as string | null) ??
          (await this.aeronaveDelVuelo(current.vuelo_id as string)),
        null,
      );
      if (ultimo != null && ultimo <= Number(dto.taco_llegada)) {
        patch.taco_salida = ultimo;
        patch.taco_salida_origen = 'DEDUCIDO';
      }
    } else if (
      dto.taco_llegada !== undefined &&
      dto.taco_llegada !== null &&
      dto.taco_salida === undefined &&
      current.taco_salida != null &&
      current.taco_salida_origen === 'DEDUCIDO'
    ) {
      // Mismo re-sync que captureTaco (caso #123): al ajustar la llegada de
      // un tramo cuya salida DEDUCIDA quedó vieja, se corrige con la llegada
      // real del tramo anterior.
      const correcta = await this.llegadaDelTramoAnterior(
        current.vuelo_id as string,
        current.orden as number,
        current.aeronave_id as string | null,
      );
      if (correcta != null && correcta !== Number(current.taco_salida)) {
        if (correcta >= Number(dto.taco_llegada)) {
          // La oficina está viendo los números: mejor un error accionable
          // que un estado a medias.
          throw new ConflictException(
            `La llegada tecleada (${dto.taco_llegada}) es menor o igual a la llegada real del tramo anterior (${correcta}): revisa ambas lecturas.`,
          );
        }
        // Escritura APARTE con guarda por origen: una captura real
        // concurrente (piloto/oficina) no se pisa jamás.
        await this.supabase.service
          .from('escala')
          .update({
            taco_salida: correcta,
            taco_salida_origen: 'DEDUCIDO',
            updated_by: userId,
          })
          .eq('id', escalaId)
          .eq('taco_salida_origen', 'DEDUCIDO');
      }
    }
    if (dto.taco_salida !== undefined) {
      patch.taco_salida = dto.taco_salida;
      patch.taco_salida_origen = 'OFICINA';
    }
    if (dto.taco_llegada !== undefined) {
      patch.taco_llegada = dto.taco_llegada;
      patch.taco_llegada_origen = 'OFICINA';
    }
    if (dto.nota !== undefined) patch.nota_correccion = dto.nota;
    // Foto adjuntada por oficina (evidencia que faltaba o reemplazo de una
    // ilegible): mismo bucket taco-fotos que usa el piloto.
    if (dto.foto_taco_salida_url !== undefined)
      patch.foto_taco_salida_url = dto.foto_taco_salida_url;
    if (dto.foto_taco_llegada_url !== undefined)
      patch.foto_taco_llegada_url = dto.foto_taco_llegada_url;

    // Confirmar APAGA la vigilancia (revision_requerida=false): si el tramo
    // quedaría sin salida, nadie volvería a mirarlo y sus horas voladas
    // serían null en silencio. Mejor pedirla explícitamente.
    const salidaFinal: unknown =
      patch.taco_salida !== undefined ? patch.taco_salida : current.taco_salida;
    if (salidaFinal == null) {
      throw new ConflictException(
        'Este tramo no tiene taco de salida: captúrala o ajústala antes de confirmar — sin ella el tramo queda sin horas voladas.',
      );
    }

    const { data, error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('id', escalaId)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) {
      // CHECK taco_llegada > taco_salida (23514): datos que no cuadran = 409
      // accionable, nunca 500 (un 500 dispara reintentos del outbox).
      if ((error as { code?: string }).code === '23514') {
        throw new ConflictException(
          'Las lecturas no cuadran (la llegada debe ser mayor a la salida): revisa los números tecleados.',
        );
      }
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Escala ${escalaId} not found`);

    if (llegada !== null) {
      await this.propagarLlegadaASalidaSiguiente(
        current.vuelo_id as string,
        current.orden as number,
        current.aeronave_id as string | null,
        llegada,
        userId,
      );
    }
    // Oficina bajó la llegada: re-sincronizar las anclas de vuelos
    // POSTERIORES que copiaron el valor viejo (mismo hueco que la corrección
    // a la baja del piloto — la copia DEDUCIDA quedaba inflada en silencio).
    if (
      dto.taco_llegada != null &&
      current.taco_llegada != null &&
      Number(dto.taco_llegada) < Number(current.taco_llegada)
    ) {
      const avionCorreccion =
        (current.aeronave_id as string | null) ??
        (await this.aeronaveDelVuelo(current.vuelo_id as string));
      if (avionCorreccion) {
        await this.resincronizarAnclasDeCorreccion(
          escalaId,
          avionCorreccion,
          Number(current.taco_llegada),
          Number(dto.taco_llegada),
          userId,
        );
      }
    }

    // Estado derivado también cuando captura la OFICINA (caso piloto externo,
    // doc 3.7: Itzel sube los tacómetros): sin esto, un vuelo cuyas lecturas
    // entran solo por esta vía se quedaría en CONFIRMADO para siempre.
    // SOLO cuando la oficina TECLEÓ una lectura — confirmar sin cambios (el
    // botón "Confirmar" de taco-live manda {}) valida una lectura deducida,
    // no es evidencia de que el vuelo voló, y completar es irreversible.
    // Best-effort, igual que en captureTaco: la lectura ya quedó guardada.
    if (dto.taco_salida !== undefined || dto.taco_llegada !== undefined) {
      try {
        await this.syncEstadoDesdeTacos(current.vuelo_id as string, userId);
      } catch (err) {
        this.logger.warn(
          `No se pudo derivar el estado del vuelo tras confirmar taco: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Cierra el círculo de confianza con el piloto: le avisa que su lectura
    // pasó de amarillo a verde (confirmada) o que oficina la ajustó.
    void (async () => {
      try {
        const vuelo = await this.findById(current.vuelo_id as string);
        const pilotoId =
          (data.piloto_id as string | null) ??
          (vuelo.piloto_id as string | null);
        if (!pilotoId || pilotoId === userId) return;
        const ajustada =
          dto.taco_salida !== undefined || dto.taco_llegada !== undefined;
        await this.notifications.notifyUser(pilotoId, {
          tipo: 'taco_capturado',
          titulo: ajustada
            ? `Tacómetro ajustado por oficina · vuelo #${vuelo.folio as number}`
            : `Tacómetro confirmado · vuelo #${vuelo.folio as number}`,
          cuerpo: ajustada
            ? `${data.origen_iata as string} → ${data.destino_iata as string}: oficina ajustó la lectura (${salida ?? '—'} → ${llegada ?? '—'})${dto.nota ? ` · ${dto.nota}` : ''}.`
            : `${data.origen_iata as string} → ${data.destino_iata as string}: tu lectura quedó confirmada.`,
          data: { vuelo_id: current.vuelo_id, escala_id: escalaId },
          link: `/flights/${current.vuelo_id as string}`,
        });
      } catch {
        // best-effort: la notificación nunca bloquea la confirmación
      }
    })();
    return data;
  }

  /**
   * Copia el taco_llegada de un tramo como taco_salida del SIGUIENTE tramo
   * (por orden, incluidos ferries operativos: excluirlos saltaba el ferry y
   * sus horas se contaban DOS veces) del mismo vuelo y misma aeronave, solo si
   * ese siguiente tramo aún no tiene salida capturada. Best-effort: nunca pisa
   * una lectura existente ni cruza aviones distintos (cada matrícula lleva su
   * horómetro).
   */
  /**
   * Salida correcta de un tramo por identidad física: la LLEGADA REAL del
   * tramo activo anterior del mismo avión (el horómetro no se mueve apagado).
   * null si no hay tramo anterior con llegada.
   */
  private async llegadaDelTramoAnterior(
    vueloId: string,
    orden: number,
    aeronaveId: string | null,
  ): Promise<number | null> {
    const { data } = await this.supabase.service
      .from('escala')
      .select(
        'aeronave_id, taco_llegada, taco_llegada_origen, revision_requerida',
      )
      .eq('vuelo_id', vueloId)
      .lt('orden', orden)
      .is('cancelada_at', null)
      .order('orden', { ascending: false })
      .limit(1);
    const ant = (data ?? [])[0];
    if (!ant || ant.taco_llegada == null) return null;
    // Solo llegadas REALES y confirmadas viajan como copia: una llegada IA en
    // amarillo (sin confirmar) o un DEDUCIDO histórico no son evidencia.
    if (ant.taco_llegada_origen === 'DEDUCIDO') return null;
    if (ant.revision_requerida === true) return null;
    // Avión por tramo con herencia: un tramo sin avión propio pertenece al
    // del vuelo — null vs id explícito del MISMO avión no son aviones
    // distintos.
    const vueloAeronave = await this.aeronaveDelVuelo(vueloId);
    const antAvion = (ant.aeronave_id as string | null) ?? vueloAeronave;
    const miAvion = aeronaveId ?? vueloAeronave;
    if (antAvion !== miAvion) return null;
    return roundTaco(Number(ant.taco_llegada));
  }

  /** aeronave_id del vuelo (para resolver tramos con avión heredado). */
  private async aeronaveDelVuelo(vueloId: string): Promise<string | null> {
    const { data } = await this.supabase.service
      .from('vuelo')
      .select('aeronave_id')
      .eq('id', vueloId)
      .maybeSingle();
    return (data?.aeronave_id as string | null) ?? null;
  }

  /**
   * Una llegada corregida A LA BAJA pudo haber sido ancla (último taco del
   * avión) de la salida DEDUCIDA de un vuelo POSTERIOR del mismo avión:
   * re-sincroniza esas copias con el valor corregido (o las retira en
   * AMARILLO si ya no caben bajo su llegada). Sin esto, las horas del vuelo
   * hijo quedaban mal en silencio con el valor erróneo. Guarda atómica por
   * origen: una captura real hecha en medio jamás se pisa.
   */
  private async resincronizarAnclasDeCorreccion(
    escalaId: string,
    aeronaveId: string,
    viejo: number,
    nuevo: number,
    userId: string,
  ): Promise<void> {
    const { data } = await this.supabase.service
      .from('escala')
      .select(
        'id, aeronave_id, taco_llegada, revision_motivo, vuelo:vuelo_id(aeronave_id)',
      )
      .eq('taco_salida', viejo)
      .eq('taco_salida_origen', 'DEDUCIDO')
      .neq('id', escalaId)
      .is('cancelada_at', null);
    for (const raw of data ?? []) {
      const e = raw as Record<string, unknown> & {
        vuelo?: { aeronave_id?: string | null } | null;
      };
      // Mismo avión, con herencia (escala sin avión propio = avión del vuelo).
      const avion =
        (e.aeronave_id as string | null) ?? e.vuelo?.aeronave_id ?? null;
      if (avion !== aeronaveId) continue;
      const llegada = e.taco_llegada == null ? null : Number(e.taco_llegada);
      const cabe = llegada == null || nuevo < llegada;
      const previoHijo = (e.revision_motivo as string | null) ?? null;
      const lineaBitacora = `salida estimada re-anclada por corrección de la lectura origen (${viejo} → ${nuevo})`;
      await this.supabase.service
        .from('escala')
        .update(
          cabe
            ? {
                taco_salida: nuevo,
                taco_salida_origen: 'DEDUCIDO',
                revision_requerida: true,
                revision_motivo: motivoDirecto(
                  previoHijo,
                  `La salida estimada venía de una lectura que se corrigió (${viejo} → ${nuevo}) — verificar en oficina`,
                  lineaBitacora,
                ),
                updated_by: userId,
              }
            : {
                // No cabe bajo la llegada capturada del tramo hijo: la copia
                // cede en amarillo — jamás quedarse con el dato falso.
                taco_salida: null,
                taco_salida_origen: null,
                revision_requerida: true,
                revision_motivo: motivoDirecto(
                  previoHijo,
                  `Salida estimada retirada: la lectura de la que venía se corrigió (${viejo} → ${nuevo}) y ya no cabe bajo la llegada — confirmar salida en oficina`,
                  lineaBitacora,
                ),
                updated_by: userId,
              },
        )
        .eq('id', e.id as string)
        // Guarda doble: solo mientras SIGA deducida Y con el valor viejo —
        // una re-deducción concurrente con otro valor no se pisa.
        .eq('taco_salida_origen', 'DEDUCIDO')
        .eq('taco_salida', viejo);
    }
  }

  private async propagarLlegadaASalidaSiguiente(
    vueloId: string,
    orden: number,
    aeronaveId: string | null,
    tacoLlegada: number,
    userId: string,
  ): Promise<void> {
    // Un tramo cancelado no recibe propagación: la llegada salta al siguiente
    // tramo ACTIVO (mismo avión) — p. ej. ida → (regreso cancelado) → ferry.
    const { data: siguientes } = await this.supabase.service
      .from('escala')
      .select(
        'id, orden, aeronave_id, taco_salida, taco_salida_origen, taco_llegada, revision_motivo',
      )
      .eq('vuelo_id', vueloId)
      .gt('orden', orden)
      .is('cancelada_at', null)
      .order('orden', { ascending: true })
      .limit(1);
    const sig = (siguientes ?? [])[0];
    if (!sig) return;
    // Avión con herencia del vuelo: null = el del vuelo, no "otro avión".
    const vueloAeronave = await this.aeronaveDelVuelo(vueloId);
    const sigAvion = (sig.aeronave_id as string | null) ?? vueloAeronave;
    const miAvion = aeronaveId ?? vueloAeronave;
    if (sigAvion !== miAvion) return; // otro avión
    const valor = roundTaco(tacoLlegada);
    // La llegada REAL del tramo anterior es la salida física del siguiente.
    // Una salida DEDUCIDA es provisional (el cron pudo llenarla con el último
    // taco ANTES de que existiera esta llegada — caso real vuelo #71: quedó la
    // salida del tramo 1 en vez de su llegada) — la evidencia la CORRIGE.
    // Capturas reales (PILOTO/OFICINA/IA) no se pisan jamás.
    const esDeducida = sig.taco_salida_origen === 'DEDUCIDO';
    if (sig.taco_salida != null && !esDeducida) {
      // Captura real: no se pisa JAMÁS. Pero es la MISMA aguja física que la
      // llegada del tramo anterior: si difieren, una de las dos lecturas
      // está mal y se marca en amarillo (pasa cuando el piloto de la
      // siguiente rotación fotografió su salida antes de que el anterior
      // capturara su llegada — cambio de piloto a media jornada).
      if (Number(sig.taco_salida) !== valor) {
        const actual = (sig.revision_motivo as string | null) ?? '';
        if (!actual.includes('no coincide con la salida capturada')) {
          const motivo = `La llegada del tramo anterior (${valor}) no coincide con la salida capturada de este tramo (${Number(sig.taco_salida)}) — es la misma aguja: revisar ambas lecturas en oficina`;
          await this.supabase.service
            .from('escala')
            .update({
              revision_requerida: true,
              // motivoDirecto: conserva bitácora Y chunks pegajosos del
              // tramo siguiente (una corrección a la baja pendiente ahí no
              // debe borrarse por este aviso).
              revision_motivo: motivoDirecto(actual || null, motivo),
              updated_by: userId,
            })
            .eq('id', sig.id as string);
        }
      }
      return;
    }
    if (sig.taco_salida != null && Number(sig.taco_salida) === valor) return; // ya está bien
    // El constraint exige llegada > salida: si el tramo siguiente ya tiene una
    // llegada menor o igual al valor propagado, la copia deducida quedó
    // CONTRADICHA por la corrección (caso vuelo #123: el piloto corrigió la
    // llegada del tramo 1 y la salida vieja del tramo 2 se quedaba muda).
    // El deducido CEDE: se retira, en amarillo, y oficina resuelve — jamás se
    // abandona en silencio dejando el dato viejo como si fuera bueno.
    if (sig.taco_llegada != null && Number(sig.taco_llegada) <= valor) {
      if (esDeducida) {
        // La bitácora de procedencia ("Registro: …") y los chunks pegajosos
        // sobreviven al cede (motivoDirecto): son la explicación histórica
        // del dato y la evidencia de correcciones sin revisar.
        const motivo = `Salida estimada retirada: la llegada corregida del tramo anterior (${valor}) la contradice — revisar la llegada de este tramo y confirmar la salida en oficina`;
        await this.supabase.service
          .from('escala')
          .update({
            taco_salida: null,
            taco_salida_origen: null,
            revision_requerida: true,
            revision_motivo: motivoDirecto(
              (sig.revision_motivo as string | null) ?? null,
              motivo,
            ),
            updated_by: userId,
          })
          .eq('id', sig.id as string)
          .eq('taco_salida_origen', 'DEDUCIDO');
      }
      return;
    }
    // Guarda atómica además del check en memoria: si el piloto capturó la
    // salida entre la lectura y este write, el UPDATE afecta 0 filas (no-op)
    // y su lectura se respeta. Para corregir una DEDUCIDA, la guarda es por
    // origen (solo pisa mientras SIGA siendo deducida).
    //
    // La copia se escribe SIEMPRE como DEDUCIDO (invariante: las copias son
    // provisionales). Etiquetarla PILOTO/OFICINA la volvía "captura real" y
    // una corrección posterior de la llegada origen ya no podía arreglarla.
    let query = this.supabase.service
      .from('escala')
      .update({
        taco_salida: valor,
        taco_salida_origen: 'DEDUCIDO',
        updated_by: userId,
      })
      .eq('id', sig.id as string);
    query = esDeducida
      ? query.eq('taco_salida_origen', 'DEDUCIDO')
      : query.is('taco_salida', null);
    await query;
  }

  /** Avisa a admin/coordinador que un piloto capturó tacómetro. */
  /**
   * Bitácora del vuelo para el admin (punto 5): recordatorios de tacómetro
   * enviados al piloto y capturas de tacómetro registradas, en orden
   * cronológico. Se arma desde la tabla `notificacion` (que ya persiste cada
   * aviso) filtrando por el vuelo.
   */
  async flightBitacora(vueloId: string) {
    const { data, error } = await this.supabase.service
      .from('notificacion')
      .select(
        'id, tipo, titulo, cuerpo, data, created_at, usuario:usuario_id(nombre, rol)',
      )
      .in('tipo', ['recordatorio_taco', 'taco_capturado'])
      .eq('data->>vuelo_id', vueloId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    // Las notificaciones se insertan UNA POR DESTINATARIO (notifyRole a todos
    // los ADMIN/COORDINADOR); la bitácora es del EVENTO: colapsar las copias.
    // Clave = tipo+cuerpo+minuto (el fan-out ocurre en el mismo request; dos
    // eventos legítimos iguales en minutos distintos NO se colapsan).
    const vistos = new Set<string>();
    const eventos: Record<string, unknown>[] = [];
    for (const n of data ?? []) {
      const key = `${n.tipo}|${n.cuerpo}|${String(n.created_at).slice(0, 16)}`;
      if (vistos.has(key)) continue;
      vistos.add(key);
      const u = Array.isArray(n.usuario) ? n.usuario[0] : n.usuario;
      eventos.push({
        id: n.id,
        tipo: n.tipo,
        titulo: n.titulo,
        cuerpo: n.cuerpo,
        umbral: (n.data as { umbral?: number } | null)?.umbral ?? null,
        destinatario: (u as { nombre?: string } | null)?.nombre ?? null,
        destinatario_rol: (u as { rol?: string } | null)?.rol ?? null,
        created_at: n.created_at,
      });
    }
    return eventos;
  }

  private async notifyTacoCaptured(
    escala: Record<string, unknown>,
  ): Promise<void> {
    const revision = Boolean(escala.revision_requerida);
    const ruta = `${escala.origen_iata as string} → ${escala.destino_iata as string}`;
    const payload = {
      tipo: 'taco_capturado',
      titulo: revision
        ? 'Tacómetro capturado · revisar'
        : 'Tacómetro capturado',
      // Al piloto se le manda SOLO lo accionable: la bitácora de procedencia
      // es para la oficina y haría el push interminable en el teléfono.
      cuerpo: revision
        ? `${ruta} — ${soloPendientes(escala.revision_motivo as string | null) ?? 'requiere revisión'}`
        : ruta,
      data: {
        escala_id: escala.id,
        vuelo_id: escala.vuelo_id,
        revision_requerida: revision,
      },
      link: `/admin/flights/${escala.vuelo_id as string}`,
    };
    await this.notifications.notifyRole(Rol.ADMIN, payload);
    await this.notifications.notifyRole(Rol.COORDINADOR, payload);
  }

  /**
   * Lee el tacómetro de una foto con IA (visión), SIN guardar nada. La app la
   * usa para prellenar el campo tras subir la foto. Si la IA está deshabilitada,
   * falla o la foto sale ilegible, cae a una sugerencia histórica (solo para la
   * lectura de llegada, cuando ya hay taco_salida) — nunca bloquea al piloto.
   */
  async tacoAiRead(escalaId: string, dto: TacoAiReadDto) {
    const { data: escala, error } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, origen_iata, destino_iata, taco_salida, aeronave_id, cancelada_at',
      )
      .eq('id', escalaId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!escala) throw new NotFoundException(`Escala ${escalaId} not found`);
    if (escala.cancelada_at) {
      throw new ConflictException(
        'Este tramo está cancelado (no voló): no se leen tacómetros.',
      );
    }

    // Ancla de magnitud para la IA: la última lectura conocida de la aeronave.
    // Evita que confunda la décima con un entero (1555.8 vs 15558.1).
    const ultimo = await this.ultimoTacoAeronave(
      (escala.aeronave_id as string | null) ??
        (await this.aeronaveDelVuelo(escala.vuelo_id as string)),
      escala.taco_salida === null ? null : Number(escala.taco_salida),
    );

    // Bandera global "captura_taco_foto_ia" apagada → no se gastan créditos
    // de IA: se responde igual que cuando la visión no está disponible (la
    // app con caché vieja cae a captura manual + sugerencia histórica).
    const fotoIaActiva = await this.configuracion.isActiva(
      CONFIG_CAPTURA_TACO_FOTO_IA,
    );
    const ia = fotoIaActiva
      ? await this.vision.readTacometro({
          imageBase64: dto.image_base64,
          mediaType: dto.media_type,
          imageUrl: dto.image_url,
          ultimo,
        })
      : null;

    if (ia && ia.legible && ia.lectura !== null) {
      return {
        fuente: 'ia' as const,
        lectura: ia.lectura,
        confianza: ia.confianza,
        legible: true,
        notas: ia.notas,
        // La app avisa al piloto cuando la foto salió dudosa para que revise
        // los dígitos ANTES de guardar (y queda escrito en la procedencia).
        calidad_foto: calidadFoto(ia),
      };
    }

    // Fallback histórico: solo aplica a la llegada y si ya hay salida capturada.
    const fallback = await this.historicalArrivalSuggestion(
      escala.origen_iata,
      escala.destino_iata,
      dto.which,
      escala.taco_salida === null ? null : Number(escala.taco_salida),
    );

    return {
      fuente: fallback ? ('historico' as const) : ('ninguna' as const),
      lectura: null,
      confianza: 0,
      legible: false,
      notas: ia?.notas ?? 'IA no disponible',
      sugerencia_historica: fallback,
    };
  }

  /**
   * Sugerencia de taco_llegada = taco_salida + promedio histórico del tramo.
   * Devuelve null si no aplica (no es llegada, falta salida, o sin historial).
   */
  private async historicalArrivalSuggestion(
    origen: string,
    destino: string,
    which: 'salida' | 'llegada',
    tacoSalida: number | null,
  ): Promise<{
    taco_llegada: number;
    minutos_promedio: number;
    muestras: number;
  } | null> {
    if (which !== 'llegada' || tacoSalida === null) return null;
    const tramo = await this.getTramoPromedio(origen, destino);
    if (!tramo || tramo.muestras < MIN_MUESTRAS || tramo.minutos_promedio <= 0)
      return null;
    const horas = tramo.minutos_promedio / 60;
    return {
      taco_llegada: Math.round((tacoSalida + horas) * 10) / 10,
      minutos_promedio: tramo.minutos_promedio,
      muestras: tramo.muestras,
    };
  }

  private async getTramoPromedio(
    origen: string,
    destino: string,
  ): Promise<{ minutos_promedio: number; muestras: number } | null> {
    const { data, error } = await this.supabase.service
      .from('tramo_tiempo_promedio')
      .select('minutos_promedio, muestras')
      .eq('origen_iata', origen.toUpperCase())
      .eq('destino_iata', destino.toUpperCase())
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      minutos_promedio: Number(data.minutos_promedio),
      muestras: Number(data.muestras),
    };
  }

  /**
   * Estimado de duración del tramo en MINUTOS a partir de la DISTANCIA
   * (catálogo distancia_tramo, millas por aerovía) y la velocidad crucero de
   * la aeronave. Es el fallback cuando el tramo aún no junta MIN_MUESTRAS de
   * histórico: una referencia gruesa, pero suficiente para marcar en amarillo
   * lecturas absurdas (foto repetida, taco de otro tramo). Null si falta la
   * distancia del par o la velocidad. Nunca lanza: la referencia es opcional
   * y jamás debe tumbar una captura.
   */
  private async getTramoMinEstimado(
    origen: string,
    destino: string,
    velocidadKts: number | null,
  ): Promise<number | null> {
    if (!velocidadKts || velocidadKts <= 0) return null;
    const { data, error } = await this.supabase.service
      .from('distancia_tramo')
      .select('millas_nauticas')
      .eq('origen_iata', origen.toUpperCase())
      .eq('destino_iata', destino.toUpperCase())
      .maybeSingle();
    if (error) {
      this.logger.warn(
        `getTramoMinEstimado ${origen}→${destino}: ${error.message}`,
      );
      return null;
    }
    const nm = data == null ? null : Number(data.millas_nauticas);
    if (!nm || !Number.isFinite(nm) || nm <= 0) return null;
    return Math.round((nm / velocidadKts) * 60);
  }

  /** Velocidad crucero (kts) de una aeronave; null si no está configurada. */
  private async velocidadCruceroKts(
    aeronaveId: string | null,
  ): Promise<number | null> {
    if (!aeronaveId) return null;
    const { data } = await this.supabase.service
      .from('aeronave')
      .select('velocidad_crucero_kts')
      .eq('id', aeronaveId)
      .maybeSingle();
    const vel = Number(
      (data as { velocidad_crucero_kts?: number | string | null } | null)
        ?.velocidad_crucero_kts,
    );
    return Number.isFinite(vel) && vel > 0 ? vel : null;
  }

  /**
   * Evalúa consistencia de la lectura y marca AMARILLO (revision_requerida) si:
   * (a) la lectura manual difiere de la sugerida por IA más de AI_VS_MANUAL_TOL_HR,
   * (b) la duración taco (llegada − salida) se aleja del promedio histórico del
   *     tramo — y si el tramo aún no tiene histórico confiable, del estimado
   *     por distancia (tolerancia MÁS ANCHA: es referencia gruesa), o
   * (c) la lectura repite la del tramo anterior del mismo avión (foto/valor
   *     duplicado, caso real vuelo #71).
   * Solo marca en amarillo para oficina — la operación NUNCA se bloquea aquí.
   * Persiste el resultado en la escala y devuelve la fila final.
   */
  /**
   * Recalcula el semáforo de la lectura y ESCRIBE su procedencia.
   *
   * `revision_motivo` guarda dos cosas separadas por "; ": primero la
   * PROCEDENCIA (cómo entró el número: IA con qué confianza y calidad de foto,
   * quién lo aceptó) y después las inconsistencias detectadas. La procedencia
   * se conserva aunque la lectura quede en verde — es la bitácora que pedía la
   * oficina ("¿cómo sé que este dato se subió bien y quién lo confirmó?").
   * El AMARILLO lo prende solo `revision_requerida`, nunca el texto.
   */
  private async applyConsistencyFlag(
    escala: Record<string, unknown>,
    userId: string,
    extra?: { procedencia?: string[]; forzarRevision?: string | null },
  ): Promise<Record<string, unknown>> {
    const tacoSalida =
      escala.taco_salida === null ? null : Number(escala.taco_salida);
    const tacoLlegada =
      escala.taco_llegada === null ? null : Number(escala.taco_llegada);
    const valorIa =
      escala.valor_ia_propuesto === null
        ? null
        : Number(escala.valor_ia_propuesto);
    const motivos: string[] = [];

    // (a) Manual vs IA. valor_ia_propuesto refleja la última lectura sugerida;
    // la comparamos contra la lectura más reciente disponible.
    const lecturaManual = tacoLlegada ?? tacoSalida;
    if (valorIa !== null && lecturaManual !== null) {
      const delta = Math.abs(lecturaManual - valorIa);
      if (delta > AI_VS_MANUAL_TOL_HR) {
        motivos.push(`Lectura difiere de la IA (Δ ${delta.toFixed(1)} h)`);
      }
    }

    // (b) Duración vs promedio histórico. Sin histórico confiable, contra el
    // estimado por distancia (millas por aerovía / velocidad crucero) con
    // tolerancia MÁS ANCHA — así el tramo SIEMPRE tiene una referencia y una
    // foto repetida (duración ~0) no pasa en silencio.
    if (
      tacoSalida !== null &&
      tacoLlegada !== null &&
      tacoLlegada >= tacoSalida
    ) {
      const durMin = (tacoLlegada - tacoSalida) * 60;
      const tramo = await this.getTramoPromedio(
        escala.origen_iata as string,
        escala.destino_iata as string,
      );
      if (
        tramo &&
        tramo.muestras >= MIN_MUESTRAS &&
        tramo.minutos_promedio > 0
      ) {
        const desv =
          Math.abs(durMin - tramo.minutos_promedio) / tramo.minutos_promedio;
        if (desv > DURATION_TOL_PCT) {
          motivos.push(
            `Duración ${Math.round(durMin)} min fuera de rango histórico (~${Math.round(tramo.minutos_promedio)} min)`,
          );
        }
      } else {
        const velocidad = await this.velocidadCruceroKts(
          (escala.aeronave_id as string | null) ?? null,
        );
        const estimado = await this.getTramoMinEstimado(
          escala.origen_iata as string,
          escala.destino_iata as string,
          velocidad,
        );
        if (estimado !== null && estimado > 0) {
          const desv = Math.abs(durMin - estimado) / estimado;
          if (desv > DURATION_EST_TOL_PCT) {
            motivos.push(
              `Duración ${Math.round(durMin)} min fuera del estimado de la ruta (~${estimado} min)`,
            );
          }
        }
      }
    }

    // (c) Lectura repetida del tramo anterior (caso real vuelo #71: el piloto
    // capturó la llegada del tramo 1 también como llegada del tramo 2 —
    // misma foto/valor — y nada lo advirtió). Se compara contra el tramo
    // previo del MISMO avión (cada matrícula lleva su horómetro; se respeta
    // escala.aeronave_id como en el resto de la cadena). El error de lectura
    // se ignora a propósito: la referencia jamás tumba una captura.
    if (
      Number(escala.orden) > 1 &&
      (tacoSalida !== null || tacoLlegada !== null)
    ) {
      const { data: previas } = await this.supabase.service
        .from('escala')
        .select('orden, aeronave_id, taco_salida, taco_llegada')
        .eq('vuelo_id', escala.vuelo_id as string)
        .lt('orden', Number(escala.orden))
        .order('orden', { ascending: false });
      const prev = (previas ?? []).find(
        (p) =>
          ((p.aeronave_id as string | null) ?? null) ===
          ((escala.aeronave_id as string | null) ?? null),
      );
      if (prev) {
        const prevLlegada =
          prev.taco_llegada == null ? null : Number(prev.taco_llegada);
        const prevSalida =
          prev.taco_salida == null ? null : Number(prev.taco_salida);
        if (
          tacoLlegada !== null &&
          prevLlegada !== null &&
          Math.abs(tacoLlegada - prevLlegada) <= TACO_REPETIDO_TOL_HR
        ) {
          motivos.push(
            'Lectura idéntica a la llegada del tramo anterior — ¿se repitió la foto o el valor?',
          );
        }
        // La salida del tramo 1 la fotografía el piloto; en tramos 2+ una
        // salida tecleada (oficina) igual a la SALIDA del tramo anterior
        // implicaría un tramo previo de cero horas: valor repetido.
        if (
          tacoSalida !== null &&
          prevSalida !== null &&
          Math.abs(tacoSalida - prevSalida) <= TACO_REPETIDO_TOL_HR
        ) {
          motivos.push(
            'Lectura de salida idéntica a la salida del tramo anterior — ¿se repitió la foto o el valor?',
          );
        }
      }
    }

    // La foto dudosa es motivo de revisión aunque los números cuadren: el caso
    // del 28 jul 2026 pasó TODAS las validaciones numéricas (1621.8 en vez de
    // 1621.9 es un delta creíble) y nadie se enteró hasta ver la foto.
    if (extra?.forzarRevision) motivos.push(extra.forzarRevision);
    // Correcciones a la baja pendientes de oficina: PEGAJOSAS — se conservan
    // entre recálculos (la siguiente captura del tramo NO las apaga); solo
    // confirmTaco las retira al reconstruir el motivo desde cero.
    for (const c of correccionesBajaPendientes(
      (escala.revision_motivo as string | null) ?? null,
    )) {
      if (!motivos.includes(c)) motivos.push(c);
    }
    const revisionRequerida = motivos.length > 0;

    // Procedencia: vive en su propio bloque con prefijo estable y SOBREVIVE
    // aunque no haya nada que revisar. Las inconsistencias sí se recalculan
    // desde cero en cada pasada.
    const bitacoraPrevia = leerBitacora(
      (escala.revision_motivo as string | null) ?? null,
    );
    const bitacora = (extra?.procedencia ?? [])
      .filter(Boolean)
      .reduce<
        string | null
      >((acc, linea) => agregarProcedencia(acc, linea), bitacoraPrevia);
    // Lo ACCIONABLE primero: la app del piloto (versiones anteriores a esta
    // bitácora) pinta `revision_motivo` crudo cuando hay que revisar, y ahí
    // debe leerse antes el problema que el historial. El panel no depende del
    // orden: separa los bloques por el prefijo.
    const partes = [
      motivos.join('; ') || null,
      bitacora ? `${PROCEDENCIA_PREFIX}${bitacora}` : null,
    ].filter((p): p is string => !!p);
    const revisionMotivo = partes.length
      ? partes.join('; ').slice(0, 1800)
      : null;
    if (
      revisionRequerida === Boolean(escala.revision_requerida) &&
      revisionMotivo === (escala.revision_motivo ?? null)
    ) {
      return escala;
    }

    const { data, error } = await this.supabase.service
      .from('escala')
      .update({
        revision_requerida: revisionRequerida,
        revision_motivo: revisionMotivo,
        updated_by: userId,
      })
      .eq('id', escala.id as string)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? escala;
  }

  /**
   * Recalcula tramo_tiempo_promedio a partir de las escalas completas de un vuelo
   * (con taco_salida y taco_llegada). Promedio incremental por par origen→destino.
   */
  private async recordTramoTiempos(vueloId: string): Promise<void> {
    const escalas = await this.listEscalas(vueloId);
    for (const e of escalas) {
      const salida = e.taco_salida === null ? null : Number(e.taco_salida);
      const llegada = e.taco_llegada === null ? null : Number(e.taco_llegada);
      if (salida === null || llegada === null || llegada <= salida) continue;
      const durMin = (llegada - salida) * 60;
      const origen = (e.origen_iata as string).toUpperCase();
      const destino = (e.destino_iata as string).toUpperCase();

      const tramo = await this.getTramoPromedio(origen, destino);
      const muestras = tramo ? tramo.muestras : 0;
      const promedioPrev = tramo ? tramo.minutos_promedio : 0;
      const nuevoPromedio = (promedioPrev * muestras + durMin) / (muestras + 1);

      const { error } = await this.supabase.service
        .from('tramo_tiempo_promedio')
        .upsert(
          {
            origen_iata: origen,
            destino_iata: destino,
            minutos_promedio: Math.round(nuevoPromedio * 10) / 10,
            muestras: muestras + 1,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'origen_iata,destino_iata' },
        );
      if (error) throw new Error(error.message);
    }
  }

  // ===== Cierre del día: tacómetros pendientes =====

  /**
   * Cron de cierre del día (23:45 Cancún = 04:45 UTC; Cancún no observa DST).
   * Política del cliente (25 jul 2026): el sistema YA NO rellena huecos con
   * estimados por promedio (el cron calculaba lecturas, las subía, y chocaban
   * con las fotos reales de los pilotos). Ahora recorre los vuelos recientes,
   * corre la PROPAGACIÓN de lecturas reales (fillTacoGaps solo copia datos) y
   * con las sugerencias pendientes manda UN resumen a ADMIN/COORDINADOR para
   * que confirmen con los pilotos y capturen en Tacómetros en vivo.
   * Consecuencia asumida: un vuelo sin llegadas REALES ya no se completa solo
   * (complete() exige llegadas) — lo vigilan el cron zombi (warning), la
   * alerta de "sigue EN VUELO" y el pre-cierre.
   */
  @Cron('45 4 * * *', { name: 'taco-fill-gaps' })
  async fillTacoGapsDelDia(): Promise<void> {
    try {
      const desde = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const { data, error } = await this.supabase.service
        .from('vuelo')
        .select('id, folio')
        .in('estado', ['COMPLETADO', 'EN_VUELO'])
        .eq('es_externo', false)
        .gte('updated_at', desde);
      if (error) throw new Error(error.message);
      const pendientes: TacoSugerencia[] = [];
      for (const v of data ?? []) {
        try {
          const res = await this.fillTacoGaps(v.id as string, null);
          pendientes.push(...res.sugerencias);
        } catch (err) {
          this.logger.warn(
            `fillTacoGaps(${v.id as string}) falló: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (pendientes.length > 0) {
        const n = pendientes.length;
        const folios = [...new Set(pendientes.map((s) => s.folio))].sort(
          (a, b) => a - b,
        );
        const payload = {
          tipo: 'alerta_sistema',
          titulo:
            n === 1
              ? '1 tramo del día sin lectura de llegada'
              : `${n} tramos del día sin lectura de llegada`,
          cuerpo: `${n === 1 ? '1 tramo del día quedó' : `${n} tramos del día quedaron`} sin lectura de llegada — confirmar con los pilotos y capturarlas en Tacómetros en vivo. Vuelos: ${folios.map((f) => `#${f}`).join(', ')}.`,
          data: { count: n, folios },
          link: '/admin/taco-live',
        };
        await this.notifications.notifyRole(Rol.ADMIN, payload);
        await this.notifications.notifyRole(Rol.COORDINADOR, payload);
      }
    } catch (err) {
      this.logger.warn(
        `fillTacoGapsDelDia falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Vigilante EN VIVO (cada 10 min): para los vuelos del día (no cancelados),
   * si una escala ya debió terminar y no llegó su lectura, avisa al PILOTO
   * del tramo con push (estimado del promedio SOLO como referencia). CERO
   * escrituras de tacos — política del cliente (25 jul 2026): antes este cron
   * deducía la llegada y la subía, y chocaba con la foto real del piloto.
   * Un aviso por escala (dedupe `taco_vencido_<escala_id>` en alerta_emitida).
   */
  @Cron('*/10 * * * *', { name: 'taco-live-deduce' })
  async deduceTacosEnVivo(): Promise<void> {
    try {
      const now = new Date();
      const hoyCancun = now.toLocaleDateString('en-CA', {
        timeZone: 'America/Cancun',
      });
      // Solapamiento con HOY vía fecha_fin (viaje multi-día): el vuelo
      // sigue "de hoy" todos los días de su itinerario — sin esto, el
      // piloto no recibía el recordatorio del tramo de regreso del día 3.
      // fillTacoGaps ya evalúa el vencimiento POR ESCALA (fecha_salida_plan),
      // así que los días de estancia no generan avisos de más.
      const { data, error } = await this.supabase.service
        .from('vuelo')
        .select('id, fecha_vuelo, estado')
        .neq('estado', 'CANCELADO')
        .eq('es_externo', false)
        .lte('fecha_vuelo', `${hoyCancun}T23:59:59-05:00`)
        .gte('fecha_fin', `${hoyCancun}T00:00:00-05:00`);
      if (error) throw new Error(error.message);
      for (const v of data ?? []) {
        try {
          const res = await this.fillTacoGaps(v.id as string, null, {
            soloVencidasA: now,
          });
          for (const s of res.sugerencias) {
            await this.avisarTacoVencido(s);
          }
        } catch (err) {
          this.logger.warn(
            `deduceTacosEnVivo(${v.id as string}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `deduceTacosEnVivo falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Push al piloto del tramo vencido, UNA sola vez por escala. Sigue el
   * patrón de alerts.dispatch: la clave de dedupe se marca DESPUÉS de una
   * entrega exitosa — si el push falla, el siguiente run reintenta.
   */
  private async avisarTacoVencido(s: TacoSugerencia): Promise<void> {
    if (!s.piloto_id) return;
    const dedupeKey = `taco_vencido_${s.escala_id}`;
    const { count, error: countErr } = await this.supabase.service
      .from('alerta_emitida')
      .select('dedupe_key', { count: 'exact', head: true })
      .eq('dedupe_key', dedupeKey);
    if (countErr) throw new Error(countErr.message);
    if ((count ?? 0) > 0) return; // ya avisada
    const ok = await this.notifications.notifyUser(s.piloto_id, {
      tipo: 'recordatorio_taco',
      titulo: `Falta lectura de llegada · vuelo #${s.folio}`,
      cuerpo: `Tu tramo ${s.tramo} ya debió terminar y no hay lectura de llegada — captura la foto del tacómetro. (Estimado de referencia: ~${s.valor_estimado.toFixed(1)})`,
      data: { vuelo_id: s.vuelo_id, escala_id: s.escala_id, folio: s.folio },
      link: `/flights/${s.vuelo_id}`,
    });
    if (!ok) return; // sin entrega (o piloto externo): la clave queda libre
    const { error } = await this.supabase.service
      .from('alerta_emitida')
      .insert({ dedupe_key: dedupeKey, clave: 'taco_vencido' });
    // 23505 = otra corrida la marcó en paralelo: mismo resultado, no es error.
    if (error && error.code !== '23505') throw new Error(error.message);
  }

  /**
   * Tacómetros de UN vuelo — política del cliente (25 jul 2026): el sistema
   * NUNCA escribe valores ESTIMADOS (por promedio). Este método:
   *  - PROPAGA copias de dato real: salida vacía ← llegada del tramo anterior
   *    (mismo avión). Es una identidad física (el horómetro no se mueve con
   *    el avión apagado), no una estimación — sin ella se rompe "una foto por
   *    escala".
   *  - DEVUELVE `sugerencias` de llegadas pendientes (salida presente, sin
   *    llegada, promedio del tramo confiable): lo que ANTES escribía como
   *    DEDUCIDO ahora es alerta/recomendación (push al piloto en vivo,
   *    resumen nocturno a oficina). Requiere MIN_MUESTRAS para sugerir.
   */
  async fillTacoGaps(
    vueloId: string,
    userId: string | null,
    opts?: {
      /** Modo EN VIVO: solo sugiere llegadas cuya hora esperada de fin
       *  (salida real/plan + promedio del tramo + margen) ya venció a este
       *  instante. Sin esta opción (cierre del día) sugiere todos los
       *  pendientes calculables. */
      soloVencidasA?: Date;
    },
  ) {
    const vuelo = await this.findById(vueloId);
    // Tramos cancelados fuera de TODA la cadena: ni propagan, ni reciben
    // propagación, ni generan sugerencias/avisos de llegada vencida.
    const { data: escalasData, error: escErr } = await this.supabase.service
      .from('escala')
      .select(ESCALA_COLS)
      .eq('vuelo_id', vueloId)
      .is('cancelada_at', null)
      .order('orden', { ascending: true });
    if (escErr) throw new Error(escErr.message);
    // Avión con herencia: un tramo sin avión propio pertenece al del vuelo.
    // Comparar crudo (null vs id explícito del MISMO avión) saltaba la
    // propagación en tramos ferry heredados (caso vuelo #116, ago 2026).
    const vueloAeronave = (vuelo.aeronave_id as string | null) ?? null;
    const rows = (escalasData ?? []).map((e) => ({
      id: e.id as string,
      orden: Number(e.orden),
      origen: e.origen_iata as string,
      destino: e.destino_iata as string,
      aeronaveId: (e.aeronave_id as string | null) ?? vueloAeronave,
      pilotoId: (e.piloto_id as string | null) ?? null,
      fechaPlan: (e.fecha_salida_plan as string | null) ?? null,
      horaSalidaReal: (e.hora_salida as string | null) ?? null,
      salida: e.taco_salida === null ? null : Number(e.taco_salida),
      llegada: e.taco_llegada === null ? null : Number(e.taco_llegada),
      // Origen YA guardado en BD (solo cuenta si el valor existe; origen sin
      // valor sería un residuo): un DEDUCIDO histórico sigue siendo
      // provisional y la salida propagada desde él hereda la marca.
      llegadaOrigenBD:
        e.taco_llegada === null
          ? null
          : ((e.taco_llegada_origen as string | null) ?? null),
      // Una llegada en AMARILLO (IA de sync offline sin confirmar) NO se
      // propaga: la política dice que la lectura IA no viaja sin confirmación.
      llegadaSinConfirmar: e.revision_requerida === true,
      cambios: [] as string[],
      // Solo se escribe lo que RELLENÓ este proceso (estaba null al leer);
      // lo que ya tenía valor jamás se re-escribe (podría pisar una captura
      // del piloto ocurrida entre la lectura y el write).
      salidaRellenada: false,
    }));
    rows.sort((a, b) => a.orden - b.orden);

    // (1) PROPAGACIÓN (única escritura que queda): salida ← llegada del tramo
    // anterior (mismo avión). Copia de dato, no estimación. Una sola pasada
    // ordenada basta: la llegada de la que se copia siempre viene de BD (ya
    // no hay llegadas calculadas en memoria).
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.salida !== null) continue;
      const prev = rows[i - 1];
      if (prev.llegada === null || prev.aeronaveId !== r.aeronaveId) continue;
      // Llegada IA sin confirmar (amarilla): no se propaga — la política del
      // cliente exige confirmación antes de que una lectura IA viaje.
      if (prev.llegadaSinConfirmar) continue;
      r.salida = prev.llegada;
      r.salidaRellenada = true;
      r.cambios.push('salida tomada de la llegada del tramo anterior');
    }

    // (2) SUGERENCIAS (antes se escribían como DEDUCIDO, hoy solo se
    // reportan): llegada pendiente = salida presente sin llegada, con
    // promedio del tramo confiable. El valor es SOLO referencia — jamás se
    // persiste, así que ya no hay riesgo de fabricar tramos fantasma
    // (caso vuelo #73) y puede sugerirse también sobre una salida DEDUCIDA.
    const sugerencias: TacoSugerencia[] = [];
    for (const r of rows) {
      if (r.llegada !== null || r.salida === null) continue;
      const tramo = await this.getTramoPromedio(r.origen, r.destino);
      if (
        !tramo ||
        tramo.muestras < MIN_MUESTRAS ||
        tramo.minutos_promedio <= 0
      ) {
        continue;
      }
      // Hora esperada de fin: salida real (o plan) + promedio + 20 min de
      // margen. En vivo solo se sugiere lo VENCIDO (escalas futuras o en el
      // aire siguen "esperando dato").
      const base = r.horaSalidaReal ?? r.fechaPlan;
      const fin = base
        ? new Date(
            new Date(base).getTime() + (tramo.minutos_promedio + 20) * 60_000,
          )
        : null;
      if (opts?.soloVencidasA) {
        if (!fin || fin.getTime() > opts.soloVencidasA.getTime()) continue;
      } else if (fin && fin.getTime() > Date.now()) {
        // Cierre del día: un tramo planeado a FUTURO (regreso de un viaje
        // multi-día) no es "del día sin llegada" — reportarlo cada noche de
        // la estancia era falsa alarma. Los tramos sin fecha se conservan.
        continue;
      }
      sugerencias.push({
        escala_id: r.id,
        vuelo_id: vueloId,
        folio: Number(vuelo.folio),
        tramo: `${r.origen}→${r.destino}`,
        tipo: 'LLEGADA_VENCIDA',
        valor_estimado:
          Math.round((r.salida + tramo.minutos_promedio / 60) * 10) / 10,
        minutos_promedio: tramo.minutos_promedio,
        vencida_desde: fin ? fin.toISOString() : null,
        piloto_id: r.pilotoId ?? (vuelo.piloto_id as string | null),
      });
    }

    const actualizadas: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      if (!r.salidaRellenada) continue;
      const patch: Record<string, unknown> = {
        taco_salida: roundTaco(r.salida as number),
        // La COPIA propagada es SIEMPRE DEDUCIDO (misma regla que
        // propagarLlegadaASalidaSiguiente): etiquetarla PILOTO la volvía
        // "captura real" imborrable y una corrección posterior de la llegada
        // fuente ya no podía arreglarla (caso vuelo #123, cerrado ago 2026).
        taco_salida_origen: 'DEDUCIDO',
      };
      if (userId) patch.updated_by = userId;
      // Guarda condicional: si el piloto (o el cron gemelo) capturó entre la
      // lectura y este write, el UPDATE afecta 0 filas y su lectura se
      // respeta (0 filas NO es error).
      const { data, error } = await this.supabase.service
        .from('escala')
        .update(patch)
        .eq('id', r.id)
        .is('taco_salida', null)
        .select(ESCALA_COLS)
        .maybeSingle();
      if (error) {
        this.logger.warn(`fillTacoGaps escala ${r.id}: ${error.message}`);
        continue;
      }
      if (data) {
        actualizadas.push({
          escala_id: r.id,
          orden: r.orden,
          ruta: `${r.origen} → ${r.destino}`,
          taco_salida: r.salida,
          taco_llegada: r.llegada,
          cambios: r.cambios,
        });
      }
    }
    return {
      vuelo_id: vueloId,
      escalas_actualizadas: actualizadas.length,
      detalle: actualizadas,
      sugerencias,
    };
  }

  /**
   * Galería de fotos de tacómetro de un vuelo, con URLs firmadas (bucket privado
   * taco-fotos, 1 h). Para el panel admin: ver la evidencia y la marca de revisión.
   */
  /**
   * Tablero "Tacómetros en vivo": todas las escalas de los vuelos del día
   * (cualquier estatus salvo CANCELADO) con el estado de cada lectura, su
   * origen (piloto/IA/deducido/oficina), quién confirmó/ajustó, la hora
   * esperada de fin y las fotos firmadas. La oficina solo confirma o corrige;
   * la operación nunca espera.
   */
  async tacoLive(fecha?: string) {
    const dia =
      fecha ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/Cancun' });
    // Solapamiento con el día vía fecha_fin: un viaje multi-día aparece en
    // el tablero TODOS sus días (antes solo el día 1 y la oficina no podía
    // confirmar el tramo de regreso desde aquí).
    const { data: vuelos, error } = await this.supabase.service
      .from('vuelo')
      .select(
        `id, folio, estado, fecha_vuelo, fecha_fin, aeronave:aeronave_id(matricula), piloto:piloto_id(nombre), escalas:escala(${ESCALA_COLS})`,
      )
      .neq('estado', 'CANCELADO')
      .eq('es_externo', false)
      .lte('fecha_vuelo', `${dia}T23:59:59-05:00`)
      .gte('fecha_fin', `${dia}T00:00:00-05:00`)
      .order('fecha_vuelo', { ascending: true });
    if (error) throw new Error(error.message);

    const unwrapOne = <T>(v: T | T[] | null): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : v;

    // Fotos firmadas y nombres de quienes confirmaron/ajustaron, en lote.
    const paths: string[] = [];
    const userIds = new Set<string>();
    for (const v of vuelos ?? []) {
      for (const e of (v.escalas as Array<Record<string, unknown>>) ?? []) {
        if (e.foto_taco_salida_url)
          paths.push(e.foto_taco_salida_url as string);
        if (e.foto_taco_llegada_url)
          paths.push(e.foto_taco_llegada_url as string);
        if (e.corregido_por) userIds.add(e.corregido_por as string);
        if (e.capturado_por) userIds.add(e.capturado_por as string);
        if (e.taco_obs_updated_by) userIds.add(e.taco_obs_updated_by as string);
      }
    }
    const signed: Record<string, string> = {};
    if (paths.length) {
      const { data: urls } = await this.supabase.service.storage
        .from('taco-fotos')
        .createSignedUrls(paths, 3600);
      for (const item of urls ?? []) {
        if (item.signedUrl && item.path) signed[item.path] = item.signedUrl;
      }
    }
    const nombres = new Map<string, string>();
    if (userIds.size) {
      const { data: us } = await this.supabase.service
        .from('usuario')
        .select('id, nombre')
        .in('id', [...userIds]);
      for (const u of us ?? []) nombres.set(u.id as string, u.nombre as string);
    }

    // Matrícula por TRAMO (vuelos con aviones mezclados): cada tramo puede
    // volar en otro avión (escala.aeronave_id) y cada matrícula lleva SU
    // horómetro — sin esto el tablero mezclaba lecturas de dos aviones sin
    // decir cuál era cuál.
    const aeronaveIds = new Set<string>();
    for (const v of vuelos ?? []) {
      for (const e of (v.escalas as Array<Record<string, unknown>>) ?? []) {
        if (e.aeronave_id) aeronaveIds.add(e.aeronave_id as string);
      }
    }
    const matriculas = new Map<string, string>();
    if (aeronaveIds.size) {
      const { data: avs } = await this.supabase.service
        .from('aeronave')
        .select('id, matricula')
        .in('id', [...aeronaveIds]);
      for (const a of avs ?? [])
        matriculas.set(a.id as string, a.matricula as string);
    }

    const promedios = new Map<string, number | null>();
    const promedioDe = async (o: string, d: string): Promise<number | null> => {
      const k = `${o}-${d}`;
      if (!promedios.has(k)) {
        const t = await this.getTramoPromedio(o, d);
        promedios.set(
          k,
          t && t.muestras >= MIN_MUESTRAS && t.minutos_promedio > 0
            ? t.minutos_promedio
            : null,
        );
      }
      return promedios.get(k)!;
    };

    const ahora = Date.now();
    const out = [] as Array<Record<string, unknown>>;
    for (const v of vuelos ?? []) {
      const aeronave = unwrapOne(v.aeronave as { matricula?: string } | null);
      const piloto = unwrapOne(v.piloto as { nombre?: string } | null);
      // Tramos cancelados fuera del tablero: no piden captura ni ajuste.
      const escalas = [...((v.escalas as Array<Record<string, unknown>>) ?? [])]
        .filter((e) => e.cancelada_at == null)
        .sort((a, b) => Number(a.orden) - Number(b.orden));
      const filas = [] as Array<Record<string, unknown>>;
      // Día de cada tramo (Cancún): sin fecha propia hereda la del tramo
      // anterior (mismo criterio que el calendario) y el tramo 1 cae al día
      // del vuelo. Con esto la UI atenúa los tramos que no son del día
      // consultado en un viaje multi-día.
      const diaCancunDe = (iso: unknown): string | null =>
        typeof iso === 'string' && iso
          ? new Date(iso).toLocaleDateString('en-CA', {
              timeZone: 'America/Cancun',
            })
          : null;
      let diaTramo = diaCancunDe(v.fecha_vuelo);
      for (const e of escalas) {
        diaTramo = diaCancunDe(e.fecha_salida_plan) ?? diaTramo;
        const salida = e.taco_salida == null ? null : Number(e.taco_salida);
        const llegada = e.taco_llegada == null ? null : Number(e.taco_llegada);
        const prom = await promedioDe(
          e.origen_iata as string,
          e.destino_iata as string,
        );
        const base =
          (e.hora_salida as string | null) ??
          (e.fecha_salida_plan as string | null);
        const esperadoFin =
          base && prom != null
            ? new Date(
                new Date(base).getTime() + (prom + 20) * 60_000,
              ).toISOString()
            : null;
        // Estado de la escala para el tablero.
        let estado: string;
        if (e.revision_requerida) estado = 'REVISAR';
        else if (llegada != null) estado = 'OK';
        else if (esperadoFin && new Date(esperadoFin).getTime() < ahora)
          estado = 'VENCIDA';
        else if (salida != null || (base && new Date(base).getTime() < ahora))
          estado = 'EN_CURSO';
        else estado = 'ESPERANDO';
        // RECOMENDACIÓN para la fila sin llegada (EN_CURSO/VENCIDA): llegada
        // estimada = salida real + promedio del tramo, calculada AL VUELO —
        // JAMÁS se persiste (política del cliente, 25 jul 2026). Oficina la
        // usa como referencia al Ajustar. Sin salida no hay estimación.
        const llegadaEstimada =
          llegada == null && salida != null && prom != null
            ? Math.round((salida + prom / 60) * 10) / 10
            : null;
        filas.push({
          escala_id: e.id,
          orden: e.orden,
          origen_iata: e.origen_iata,
          destino_iata: e.destino_iata,
          // Avión de ESTE tramo (null = hereda el del vuelo).
          aeronave_matricula: e.aeronave_id
            ? (matriculas.get(e.aeronave_id as string) ?? null)
            : null,
          es_ferry: e.es_ferry === true,
          fecha_salida_plan: e.fecha_salida_plan ?? null,
          es_del_dia: diaTramo == null || diaTramo === dia,
          dia_tramo: diaTramo,
          esperado_fin: esperadoFin,
          estado,
          llegada_estimada: llegadaEstimada,
          minutos_promedio: prom,
          taco_salida: salida,
          taco_salida_origen: e.taco_salida_origen ?? null,
          taco_llegada: llegada,
          taco_llegada_origen: e.taco_llegada_origen ?? null,
          valor_ia_propuesto:
            e.valor_ia_propuesto == null ? null : Number(e.valor_ia_propuesto),
          revision_requerida: Boolean(e.revision_requerida),
          // Mismo corte que listEscalas: motivo = por qué revisar,
          // procedencia = cómo se registró la lectura.
          revision_motivo: soloPendientes(e.revision_motivo as string | null),
          procedencia: leerBitacora(e.revision_motivo as string | null),
          capturado_por_nombre: e.capturado_por
            ? (nombres.get(e.capturado_por as string) ?? null)
            : null,
          corregido_por_nombre: e.corregido_por
            ? (nombres.get(e.corregido_por as string) ?? null)
            : null,
          corregido_at: e.corregido_at ?? null,
          nota_correccion: e.nota_correccion ?? null,
          // Observaciones del equipo por lectura (van al histórico del
          // avión y al Excel del balance en ámbar con nota).
          taco_salida_obs: e.taco_salida_obs ?? null,
          taco_llegada_obs: e.taco_llegada_obs ?? null,
          taco_obs_por: e.taco_obs_updated_by
            ? (nombres.get(e.taco_obs_updated_by as string) ?? null)
            : null,
          taco_obs_fecha: e.taco_obs_updated_at
            ? String(e.taco_obs_updated_at).slice(0, 10)
            : null,
          foto_salida_url: e.foto_taco_salida_url
            ? (signed[e.foto_taco_salida_url as string] ?? null)
            : null,
          foto_llegada_url: e.foto_taco_llegada_url
            ? (signed[e.foto_taco_llegada_url as string] ?? null)
            : null,
        });
      }
      out.push({
        vuelo_id: v.id,
        folio: v.folio,
        estado: v.estado,
        fecha_vuelo: v.fecha_vuelo,
        matricula: aeronave?.matricula ?? null,
        piloto_nombre: piloto?.nombre ?? null,
        escalas: filas,
      });
    }
    return { fecha: dia, vuelos: out };
  }

  async tacoPhotos(vueloId: string) {
    const escalas = await this.listEscalas(vueloId);
    const paths: string[] = [];
    for (const e of escalas) {
      if (e.foto_taco_salida_url) paths.push(e.foto_taco_salida_url as string);
      if (e.foto_taco_llegada_url)
        paths.push(e.foto_taco_llegada_url as string);
    }
    const signed: Record<string, string> = {};
    if (paths.length > 0) {
      const { data } = await this.supabase.service.storage
        .from('taco-fotos')
        .createSignedUrls(paths, 3600);
      for (const item of data ?? []) {
        if (item.signedUrl && item.path) signed[item.path] = item.signedUrl;
      }
    }
    return escalas
      .filter((e) => e.foto_taco_salida_url || e.foto_taco_llegada_url)
      .map((e) => ({
        escala_id: e.id,
        orden: e.orden,
        origen_iata: e.origen_iata,
        destino_iata: e.destino_iata,
        taco_salida: e.taco_salida,
        taco_llegada: e.taco_llegada,
        valor_ia_propuesto: e.valor_ia_propuesto,
        revision_requerida: e.revision_requerida,
        revision_motivo: e.revision_motivo,
        foto_salida_url: e.foto_taco_salida_url
          ? (signed[e.foto_taco_salida_url as string] ?? null)
          : null,
        foto_llegada_url: e.foto_taco_llegada_url
          ? (signed[e.foto_taco_llegada_url as string] ?? null)
          : null,
        capturado_at: e.sincronizado_at,
      }));
  }

  // ===== Cierre automático y validación de tacómetro =====

  /**
   * Cierre nocturno de vuelos "zombi" (23:55 Cancún, tras el cierre de tacos):
   * un EN_VUELO cuya fecha ya pasó y que tiene todas sus LLEGADAS se completa
   * solo — sus horas, ingresos y reportes del mes no se pierden porque el
   * piloto olvidó el botón. Política del cliente (25 jul 2026): el sistema ya
   * NO fabrica llegadas con promedios, así que un vuelo sin llegadas REALES
   * queda EN_VUELO (warning abajo) hasta que el piloto suba su foto o la
   * oficina capture en Tacómetros en vivo — lo vigilan la alerta de "sigue EN
   * VUELO" (checkVuelosEstancados) y el pre-cierre.
   * También rescata vuelos CONFIRMADO con fecha pasada y TODAS las llegadas
   * completas (tacos que entraron por un camino que no derivó el estado, p.
   * ej. correcciones de oficina previas al sync de confirmTaco): se les corre
   * la misma sincronización derivada (CONFIRMADO→EN_VUELO→COMPLETADO por el
   * camino normal, con sus side-effects estándar).
   */
  // Segunda corrida MATUTINA (06:05 Cancún): el barrido de las 23:55 corre
  // cuando los vuelos del día aún son "de hoy" y no los toca — un zombi de
  // ayer (EN_VUELO con llegadas deducidas, caso #73) sobrevivía TODO el día
  // siguiente en el dashboard del piloto hasta el barrido nocturno.
  @Cron('5 11 * * *', { name: 'vuelos-zombi-matutino' })
  async cerrarVuelosZombisMatutino(): Promise<void> {
    return this.cerrarVuelosZombis();
  }

  @Cron('55 4 * * *', { name: 'vuelos-zombi' })
  async cerrarVuelosZombis(): Promise<void> {
    try {
      const hoyCancun = new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/Cancun',
      });
      const inicioHoy = `${hoyCancun}T00:00:00-05:00`;
      // Eje = fecha_fin (fin derivado del itinerario, trigger en BD): un
      // viaje MULTI-DÍA con tramos futuros no es zombi aunque su
      // fecha_vuelo (día 1) ya haya pasado.
      const { data, error } = await this.supabase.service
        .from('vuelo')
        .select('id, folio, fecha_vuelo, fecha_fin, estado')
        .in('estado', ['EN_VUELO', 'CONFIRMADO'])
        .eq('es_externo', false)
        .lt('fecha_fin', inicioHoy);
      if (error) throw new Error(error.message);
      for (const v of data ?? []) {
        try {
          // Doble guardia (por si fecha_fin quedara vieja): un tramo activo
          // planeado para hoy o después = el viaje sigue en curso; ni
          // cerrar ni regañar. El cierre prematuro dejaría el regreso
          // fuera del vuelo (y del cierre mensual).
          const { data: futuros } = await this.supabase.service
            .from('escala')
            .select('id')
            .eq('vuelo_id', v.id as string)
            .is('cancelada_at', null)
            .gte('fecha_salida_plan', inicioHoy)
            .limit(1);
          if ((futuros ?? []).length > 0) continue;
          const escalas = await this.escalasTaco(v.id as string);
          if (this.faltanLlegadas(escalas)) {
            // CONFIRMADO con llegadas incompletas no es zombi: puede que
            // nunca haya volado (lo resuelve la oficina: capturar o cancelar).
            if (v.estado === 'EN_VUELO') {
              this.logger.warn(
                `Vuelo zombi #${v.folio as number} sigue EN_VUELO con llegadas incompletas — requiere oficina`,
              );
            }
            continue;
          }
          if (v.estado === 'CONFIRMADO') {
            await this.syncEstadoDesdeTacos(v.id as string, null);
          } else {
            await this.complete(v.id as string, null);
          }
          this.logger.log(
            `Vuelo #${v.folio as number} completado automáticamente (cierre nocturno)`,
          );
        } catch (err) {
          this.logger.warn(
            `Autocierre del vuelo ${v.id as string} falló: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `cerrarVuelosZombis falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Llena la salida del primer tramo con el último tacómetro conocido del
   * avión (el horómetro no se mueve con el avión apagado). Nunca bloquea: si
   * no hay historial del avión, no hace nada y el vuelo inicia igual — la
   * lectura queda visible como faltante en Tacómetros en vivo para ajustarla.
   */
  private async autoFillSalidaInicial(
    vueloId: string,
    aeronaveId: string | null,
    userId: string,
  ): Promise<void> {
    const { data } = await this.supabase.service
      .from('escala')
      .select('id, taco_salida, taco_llegada')
      .eq('vuelo_id', vueloId)
      .is('cancelada_at', null)
      .order('orden', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!data || data.taco_salida != null) return;
    const ultimo = await this.ultimoTacoAeronave(aeronaveId, null);
    if (ultimo == null) return;
    // Nunca dejar salida > llegada (p. ej. si la llegada ya se capturó).
    if (data.taco_llegada != null && ultimo > Number(data.taco_llegada)) return;
    await this.supabase.service
      .from('escala')
      .update({
        taco_salida: roundTaco(ultimo),
        taco_salida_origen: 'DEDUCIDO',
        updated_by: userId,
      })
      .eq('id', data.id);
  }

  private async escalasTaco(vueloId: string): Promise<EscalaTaco[]> {
    // Tramos cancelados fuera: no exigen llegada ni cuentan para completar.
    const { data, error } = await this.supabase.service
      .from('escala')
      .select('orden, taco_salida, taco_llegada')
      .eq('vuelo_id', vueloId)
      .is('cancelada_at', null)
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /** Falta alguna lectura de LLEGADA (la única que captura el piloto). */
  private faltanLlegadas(escalas: EscalaTaco[]): boolean {
    if (escalas.length === 0) return true;
    return escalas.some((e) => e.taco_llegada == null);
  }

  /** Falta cualquier lectura (salida o llegada) en algún tramo, o no hay escalas. */
  private faltaTacoCompleto(escalas: EscalaTaco[]): boolean {
    if (escalas.length === 0) return true;
    return escalas.some((e) => e.taco_salida == null || e.taco_llegada == null);
  }

  /**
   * Estado de captura de tacómetro por vuelo (para el badge en admin).
   * `falta` = sin escalas, o algún tramo sin salida/llegada.
   */
  /**
   * Total cobrado (USD) por vuelo, en lote, para el semáforo de cobro de las
   * tablas de vuelos/cotizaciones (mismo patrón que tacoStatus). Fuente
   * única cobrosEnUsd con el tc del vuelo de respaldo: un MXN sin TC no se
   * suma — viaja en sin_tc_count para que el semáforo lo advierta en vez de
   * pintar "sin cobro" un vuelo ya pagado en pesos.
   */
  async cobroStatus(
    ids: string[],
  ): Promise<Record<string, { total_cobrado: number; sin_tc_count: number }>> {
    const out: Record<string, { total_cobrado: number; sin_tc_count: number }> =
      {};
    if (ids.length === 0) return out;
    const [cobrosRes, vuelosRes] = await Promise.all([
      this.supabase.service
        .from('cobro_vuelo')
        .select('vuelo_id, monto, moneda, tc_usd_mxn')
        .in('vuelo_id', ids)
        // Anti-cap de PostgREST (1000 filas): 200 vuelos con muchos abonos
        // truncarían el total EN SILENCIO y pintarían "parcial" un pagado.
        .limit(10000),
      this.supabase.service
        .from('vuelo')
        .select('id, tc_usd_mxn')
        .in('id', ids),
    ]);
    if (cobrosRes.error) throw new Error(cobrosRes.error.message);
    if (vuelosRes.error) throw new Error(vuelosRes.error.message);
    const tcPorVuelo = new Map<string, number | null>();
    for (const v of vuelosRes.data ?? []) {
      tcPorVuelo.set(v.id as string, Number(v.tc_usd_mxn) || null);
    }
    const grupos = new Map<
      string,
      { monto: unknown; moneda: unknown; tc_usd_mxn: unknown }[]
    >();
    for (const c of cobrosRes.data ?? []) {
      const list = grupos.get(c.vuelo_id as string) ?? [];
      list.push(c);
      grupos.set(c.vuelo_id as string, list);
    }
    for (const id of ids) {
      const conv = cobrosEnUsd(
        grupos.get(id) ?? [],
        tcPorVuelo.get(id) ?? null,
      );
      out[id] = {
        total_cobrado: Math.round(conv.total_usd * 100) / 100,
        sin_tc_count: conv.sin_tc_count,
      };
    }
    return out;
  }

  async tacoStatus(ids: string[]): Promise<Record<string, { falta: boolean }>> {
    const out: Record<string, { falta: boolean }> = {};
    if (ids.length === 0) return out;
    const { data, error } = await this.supabase.service
      .from('escala')
      .select('vuelo_id, taco_salida, taco_llegada')
      .in('vuelo_id', ids)
      .is('cancelada_at', null);
    if (error) throw new Error(error.message);

    const acc = new Map<
      string,
      { count: number; salida: boolean; llegada: boolean }
    >();
    for (const id of ids)
      acc.set(id, { count: 0, salida: true, llegada: true });
    for (const e of data ?? []) {
      const s = acc.get(e.vuelo_id as string);
      if (!s) continue;
      s.count++;
      if (e.taco_salida == null) s.salida = false;
      if (e.taco_llegada == null) s.llegada = false;
    }
    for (const [id, s] of acc) {
      out[id] = { falta: s.count === 0 || !s.salida || !s.llegada };
    }
    return out;
  }

  /** URLs firmadas (1 h) de vouchers de cobro (bucket privado cobro-vouchers). */
  async signCobroVouchers(paths: string[]): Promise<Record<string, string>> {
    const clean = [...new Set(paths.filter(Boolean))];
    if (clean.length === 0) return {};
    const { data } = await this.supabase.service.storage
      .from('cobro-vouchers')
      .createSignedUrls(clean, 3600);
    const map: Record<string, string> = {};
    for (const it of data ?? []) {
      if (it.signedUrl && it.path) map[it.path] = it.signedUrl;
    }
    return map;
  }

  /**
   * Cancela UN tramo que no voló (caso #74: avión en taller en MID, el regreso
   * nunca salió pero la cadena le fabricó lecturas DEDUCIDO):
   *  - lecturas/fotos REALES (PILOTO/OFICINA/IA) → 409: el tramo sí ocurrió;
   *    se corrige la ruta o se cancela el vuelo entero.
   *  - lecturas provisionales (DEDUCIDO) se ANULAN: las horas derivadas del
   *    tramo quedan en 0 sin tocar ningún lector (todas las sumas ignoran null).
   *  - el tramo queda excluido de completitud/propagación/sugerencias/taco-live
   *    (filtros por cancelada_at) y su evento de calendario se elimina.
   *  - si el vuelo estaba EN_VUELO y las llegadas de los tramos ACTIVOS ya
   *    están, el vuelo se completa solo (el tramo cancelado ya no lo detiene).
   */
  async cancelEscala(escalaId: string, motivo: string, userId: string) {
    const { data: row, error: readErr } = await this.supabase.service
      .from('escala')
      .select(ESCALA_COLS)
      .eq('id', escalaId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) throw new NotFoundException(`Escala ${escalaId} not found`);
    if (row.cancelada_at) {
      throw new ConflictException('Este tramo ya está cancelado.');
    }
    // Evidencia de que el tramo VOLÓ = su LLEGADA real (≠ DEDUCIDO) o
    // cualquier FOTO propia. La SALIDA nunca cuenta como evidencia, de ningún
    // origen: la llena el sistema (último taco / propagación de la llegada
    // del tramo anterior, hoy siempre marcada DEDUCIDO — pero hay salidas
    // históricas con origen heredado PILOTO, caso real #74: el regreso jamás
    // voló y su salida decía PILOTO por la propagación vieja).
    const llegadaReal =
      row.taco_llegada !== null && row.taco_llegada_origen !== 'DEDUCIDO';
    if (llegadaReal || row.foto_taco_salida_url || row.foto_taco_llegada_url) {
      throw new ConflictException(
        'El tramo tiene llegada o fotos reales de tacómetro: sí voló. Corrige la ruta con "Editar tramo" o cancela el vuelo completo.',
      );
    }
    // Nunca dejar el vuelo sin tramos activos: para eso está cancelar el vuelo.
    const { count: activos, error: cntErr } = await this.supabase.service
      .from('escala')
      .select('id', { count: 'exact', head: true })
      .eq('vuelo_id', row.vuelo_id as string)
      .is('cancelada_at', null)
      .neq('id', escalaId);
    if (cntErr) throw new Error(cntErr.message);
    if ((activos ?? 0) === 0) {
      throw new ConflictException(
        'Es el único tramo activo del vuelo: cancela el vuelo completo, no el tramo.',
      );
    }

    const { data, error } = await this.supabase.service
      .from('escala')
      .update({
        cancelada_at: new Date().toISOString(),
        cancelada_motivo: motivo.trim(),
        cancelada_por: userId,
        // Los DEDUCIDO eran promesas provisionales de una operación que no
        // ocurrió: se anulan para que las horas derivadas del tramo sean 0.
        taco_salida: null,
        taco_llegada: null,
        taco_salida_origen: null,
        taco_llegada_origen: null,
        valor_ia_propuesto: null,
        revision_requerida: false,
        revision_motivo: null,
        updated_by: userId,
      })
      .eq('id', escalaId)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);

    // El vuelo puede quedar completo ahora que este tramo no cuenta. Solo
    // AVANZA (EN_VUELO → COMPLETADO); jamás inicia un vuelo por cancelar.
    try {
      const vuelo = await this.findById(row.vuelo_id as string);
      if (
        !vuelo.es_externo &&
        vuelo.estado === 'EN_VUELO' &&
        !this.faltanLlegadas(await this.escalasTaco(row.vuelo_id as string))
      ) {
        await this.complete(row.vuelo_id as string, userId);
      }
    } catch (err) {
      // El cierre automático jamás bloquea la cancelación del tramo.
      this.logger.warn(
        `cancelEscala(${escalaId}): autocierre falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    void this.calendar.syncFlight(row.vuelo_id as string);
    void this.notifyTramoCancelado(row, motivo.trim());
    return data!;
  }

  /** Aviso al piloto del tramo (si hay) de que su tramo fue cancelado. */
  private async notifyTramoCancelado(
    escala: Record<string, unknown>,
    motivo: string,
    encabezado: { titulo: string; accion: string } = {
      titulo: 'Tramo cancelado',
      accion: 'se canceló',
    },
  ): Promise<void> {
    // A TODA la tripulación (21-ago): antes solo al piloto explícito del
    // tramo — si heredaba del vuelo, nadie se enteraba; y copiloto/apoyo
    // tampoco. El piloto explícito del tramo entra aunque ya no esté en
    // los "vivos" (el tramo acaba de cancelarse).
    try {
      const vuelo = await this.findById(escala.vuelo_id as string);
      const ids = await this.tripulacionDeVuelo(
        escala.vuelo_id as string,
        vuelo,
      );
      if (escala.piloto_id) ids.add(escala.piloto_id as string);
      for (const uid of ids) {
        void this.notifications.notifyUser(uid, {
          tipo: 'alerta_sistema',
          titulo: `${encabezado.titulo} · vuelo #${vuelo.folio as number}`,
          cuerpo: `El tramo ${escala.origen_iata as string} → ${escala.destino_iata as string} ${encabezado.accion}: ${motivo}. Ya no aparece en el itinerario ni pide tacómetro.`,
          data: {
            vuelo_id: escala.vuelo_id,
            escala_id: escala.id,
            folio: vuelo.folio,
          },
          link: `/flights/${escala.vuelo_id as string}`,
        });
      }
    } catch (err) {
      this.logger.warn(
        `notifyTramoCancelado falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Restaura un tramo cancelado a la ruta activa (motivo obligatorio,
   * sellado en las notas internas del vuelo — el de la CANCELACIÓN vivía en
   * la escala y se limpia aquí). Las lecturas anuladas al cancelar NO se
   * recuperan: el tramo vuelve "sin capturar" y lo rellenan la propagación,
   * el piloto u oficina (visible en Tacómetros en vivo).
   */
  async restoreEscala(escalaId: string, motivo: string, userId: string) {
    const { data: row, error: readErr } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, origen_iata, destino_iata, cancelada_at, cancelada_motivo',
      )
      .eq('id', escalaId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) throw new NotFoundException(`Escala ${escalaId} not found`);
    if (!row.cancelada_at) {
      throw new ConflictException('Este tramo no está cancelado.');
    }
    const { data, error } = await this.supabase.service
      .from('escala')
      .update({
        cancelada_at: null,
        cancelada_motivo: null,
        cancelada_por: null,
        updated_by: userId,
      })
      .eq('id', escalaId)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // Rastro auditable en las notas internas del vuelo (mismo patrón que la
    // cancelación de vuelo): quedan el motivo original y el de restaurar.
    try {
      const vuelo = await this.findById(row.vuelo_id as string);
      const sello =
        `[Tramo ${row.origen_iata as string}→${row.destino_iata as string} restaurado ${new Date().toISOString()}] ` +
        `${motivo.trim()} (cancelado antes por: ${((row.cancelada_motivo as string | null) ?? 's/motivo').trim()})`;
      const previas = (vuelo.notas_internas as string | null)?.trim();
      await this.supabase.service
        .from('vuelo')
        .update({
          notas_internas: previas ? `${previas}\n${sello}` : sello,
          updated_by: userId,
        })
        .eq('id', row.vuelo_id as string);
    } catch (err) {
      this.logger.warn(
        `restoreEscala(${escalaId}): sello en notas falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    void this.calendar.syncFlight(row.vuelo_id as string);
    // Tramo de vuelta (21-ago): quien recibió "tramo cancelado" debe saber
    // que se restauró — a toda la tripulación, como la cancelación.
    try {
      const vuelo = await this.findById(row.vuelo_id as string);
      void this.notificarTripulacion(vuelo, {
        titulo: `Tramo restaurado · vuelo #${vuelo.folio as number}`,
        cuerpo: `El tramo ${row.origen_iata as string} → ${row.destino_iata as string} vuelve al itinerario. Motivo: ${motivo.trim()}`,
        tipo: 'alerta_sistema',
      });
    } catch {
      /* best-effort */
    }
    return data!;
  }

  async deleteEscala(escalaId: string) {
    const { data: row, error: readErr } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, piloto_id, origen_iata, destino_iata, taco_salida, taco_llegada',
      )
      .eq('id', escalaId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) throw new NotFoundException(`Escala ${escalaId} not found`);
    if (row.taco_salida !== null || row.taco_llegada !== null) {
      throw new ConflictException(
        'No se puede borrar una escala con tacómetro capturado (auditoría)',
      );
    }
    const { error } = await this.supabase.service
      .from('escala')
      .delete()
      .eq('id', escalaId);
    if (error) throw new Error(error.message);
    // Auditoría 26-ago: borrar un tramo era MUDO — ni la tripulación ni el
    // piloto del tramo se enteraban, el calendario quedaba obsoleto y las
    // alertas de permiso no se re-derivaban. Mismo epílogo que cancelEscala.
    void this.calendar.syncFlight(row.vuelo_id as string);
    try {
      await this.airports.refreshPermisosDeVuelo(row.vuelo_id as string);
    } catch (err) {
      this.logger.warn(
        `refreshPermisosDeVuelo tras deleteEscala falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    void this.notifyTramoCancelado(row, 'oficina lo quitó del itinerario', {
      titulo: 'Tramo eliminado',
      accion: 'se eliminó',
    });
    return { deleted: true, id: escalaId };
  }

  // ============ Cobros ============

  async listCobros(vueloId: string) {
    await this.findById(vueloId);
    const { data, error } = await this.supabase.service
      .from('cobro_vuelo')
      .select(COBRO_COLS)
      .eq('vuelo_id', vueloId)
      .order('fecha_cobro', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createCobro(
    vueloId: string,
    dto: CreateCobroDto,
    userId: string,
    rol?: Rol,
  ) {
    const vuelo = await this.findById(vueloId);
    // Cargo por cancelación (Itzel): la oficina SÍ puede registrar un cobro en
    // un vuelo cancelado (ej. cliente canceló por clima y se le cobra algo);
    // el piloto en campo no.
    if (vuelo.estado === 'CANCELADO' && rol === Rol.PILOTO) {
      throw new ConflictException(
        'El vuelo está CANCELADO; los cargos por cancelación los registra la oficina.',
      );
    }
    // El piloto solo cobra en campo cuando el método acordado es efectivo o
    // tarjeta (tiene terminal). Transferencia/otros los registra la oficina.
    if (
      rol === Rol.PILOTO &&
      vuelo.metodo_cobro != null &&
      !METODOS_COBRO_PILOTO.has(vuelo.metodo_cobro as string)
    ) {
      throw new ForbiddenException(
        'Este vuelo se cobra por transferencia; el cobro lo registra administración.',
      );
    }
    // (Se retiró el candado de "tacómetro antes de cobrar": el cobro y la
    // captura del tacómetro son independientes; el cliente puede pagar antes
    // de que el piloto registre la lectura. El tacómetro sigue siendo
    // obligatorio para INICIAR y COMPLETAR el vuelo.)
    // El candado aplica también al método que TECLEA el piloto, no solo al
    // pactado en el vuelo: un cobro por transferencia siempre es de oficina.
    if (rol === Rol.PILOTO && !METODOS_COBRO_PILOTO.has(dto.metodo_cobro)) {
      throw new ForbiddenException(
        'Ese método de cobro lo registra administración, no el piloto.',
      );
    }
    // Tarea 11: el piloto, al cobrar con tarjeta en campo, debe adjuntar el voucher.
    // (Admin/Facturación quedan exentos para conciliaciones de oficina sin foto.)
    if (
      rol === Rol.PILOTO &&
      METODOS_TARJETA.has(dto.metodo_cobro) &&
      !dto.foto_voucher_url
    ) {
      throw new BadRequestException(
        'Foto del voucher obligatoria para pagos con tarjeta.',
      );
    }
    // Un cobro MXN sin TC "desaparecía" de todos los balances. Si el capturista
    // no lo da, se toma el TC de la cotización para que el dinero siempre
    // convierta a USD (fuente canónica cobrosEnUsd).
    const tcCobro =
      dto.tc_usd_mxn ??
      (dto.moneda === 'MXN' && Number(vuelo.tc_usd_mxn) > 0
        ? Number(vuelo.tc_usd_mxn)
        : undefined);
    // Comisión bancaria: el banco deposita monto − comisión; sin registrarla,
    // el reporte no cuadraba con el estado de cuenta. `monto` sigue siendo el
    // BRUTO que pagó el cliente (cobrado/cobrosEnUsd intactos).
    // Comisión por MONTO directo (el estado de cuenta trae pesos, no %):
    // manda sobre el %, y el % se deriva solo como referencia del reporte.
    const comisionMontoDirecto =
      Number(dto.comision_banco_monto) > 0
        ? Math.round(Number(dto.comision_banco_monto) * 100) / 100
        : null;
    const comisionPct = comisionMontoDirecto
      ? Math.round((comisionMontoDirecto / dto.monto) * 100 * 10000) / 10000
      : Number(dto.comision_banco_pct) > 0
        ? Number(dto.comision_banco_pct)
        : null;
    const comisionMonto =
      comisionMontoDirecto ??
      (comisionPct
        ? Math.round(dto.monto * (comisionPct / 100) * 100) / 100
        : null);
    if (comisionMonto != null && comisionMonto >= dto.monto) {
      throw new BadRequestException(
        'La comisión del banco no puede ser mayor o igual al monto del cobro.',
      );
    }
    const { data: cobro, error } = await this.supabase.service
      .from('cobro_vuelo')
      .insert({
        vuelo_id: vueloId,
        monto: dto.monto,
        moneda: dto.moneda,
        metodo_cobro: dto.metodo_cobro,
        tc_usd_mxn: tcCobro,
        comision_banco_pct: comisionPct,
        comision_banco_monto: comisionMonto,
        cuenta_destino: dto.cuenta_destino?.trim() || null,
        referencia: dto.referencia,
        fecha_cobro: dto.fecha_cobro?.toISOString(),
        foto_voucher_url: dto.foto_voucher_url,
        registrado_por: userId,
        notas: dto.notas,
        created_by: userId,
        updated_by: userId,
      })
      .select(COBRO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);

    // Auto-mark cobrado=true si la suma de cobros >= monto_total_usd
    await this.refreshCobradoFlag(vueloId, userId);

    const payload = {
      tipo: 'cobro_registrado',
      titulo: 'Cobro registrado',
      cuerpo: `${dto.moneda} ${Number(dto.monto).toLocaleString('en-US')} · folio #${vuelo.folio}`,
      data: {
        vuelo_id: vueloId,
        folio: vuelo.folio,
        monto: dto.monto,
        moneda: dto.moneda,
      },
      link: `/admin/flights/${vueloId}`,
    };
    void this.notifications.notifyRole(Rol.ADMIN, payload, userId);
    void this.notifications.notifyRole(Rol.FACTURACION, payload, userId);

    return cobro!;
  }

  /**
   * Recalcula la bandera `cobrado` con la fuente canónica (cobrosEnUsd): un
   * cobro MXN sin TC usa el tc_cotizacion del vuelo como respaldo, así un
   * vuelo pagado en pesos sí se marca cobrado. Tolerancia de 1 USD por
   * redondeos de conversión. Público: quotes.revise() también debe refrescar.
   */
  async refreshCobradoFlag(
    vueloId: string,
    userId: string | null,
  ): Promise<void> {
    const cobros = await this.listCobros(vueloId);
    const vuelo = await this.findById(vueloId);
    const { total_usd } = cobrosEnUsd(
      cobros,
      vuelo.tc_usd_mxn as number | null,
    );
    // Un vuelo SIN precio (total $0 = aún sin cotizar) nunca está "cobrado":
    // 0 >= 0 marcaba cobrado=true y eso BLOQUEABA revisar la cotización
    // justo del vuelo que más lo necesita (caso #38: reserva volada y
    // completada por tacos, sin cotización ni cobros, atorada en amarillo).
    const montoTotal = Number(vuelo.monto_total_usd);
    const cobradoDeberiaSer = montoTotal > 0 && total_usd >= montoTotal - 1;

    if (cobradoDeberiaSer !== vuelo.cobrado) {
      await this.supabase.service
        .from('vuelo')
        .update({ cobrado: cobradoDeberiaSer, updated_by: userId })
        .eq('id', vueloId);
    }
  }

  /**
   * Candado de conciliación (réplica del lado gasto, expenses.remove): un
   * cobro enlazado a un movimiento bancario ya cuadró una línea del banco.
   * Cambiarle el dinero o borrarlo dejaría el movimiento "conciliado"
   * apuntando a un número que ya no existe y la conciliación se
   * sobreestimaría en silencio.
   */
  private async assertCobroSinConciliar(cobroId: string): Promise<void> {
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id')
      .eq('cobro_id', cobroId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) {
      throw new ConflictException(
        'Este cobro está conciliado con un movimiento bancario. Desvincúlalo primero en Conciliación.',
      );
    }
  }

  /** Corrige un cobro capturado mal (oficina) y recalcula la bandera cobrado. */
  async updateCobro(
    cobroId: string,
    dto: UpdateCobroDto,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const { data: existing, error: findErr } = await this.supabase.service
      .from('cobro_vuelo')
      .select('id, vuelo_id, monto, comision_banco_pct')
      .eq('id', cobroId)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (!existing) throw new NotFoundException(`Cobro ${cobroId} not found`);

    // Editar el DINERO de un cobro conciliado rompería el cuadre con el banco
    // (la conciliación cruza por monto/neto y moneda). Referencia, fecha o
    // notas sí se pueden corregir sin desvincular.
    const tocaDinero =
      dto.monto !== undefined ||
      dto.moneda !== undefined ||
      dto.tc_usd_mxn !== undefined ||
      dto.comision_banco_pct !== undefined ||
      dto.comision_banco_monto !== undefined;
    if (tocaDinero) await this.assertCobroSinConciliar(cobroId);

    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.monto !== undefined) patch.monto = dto.monto;
    if (dto.moneda !== undefined) patch.moneda = dto.moneda;
    if (dto.metodo_cobro !== undefined) patch.metodo_cobro = dto.metodo_cobro;
    if (dto.tc_usd_mxn !== undefined) patch.tc_usd_mxn = dto.tc_usd_mxn;
    if (dto.referencia !== undefined) patch.referencia = dto.referencia;
    if (dto.cuenta_destino !== undefined)
      patch.cuenta_destino = dto.cuenta_destino.trim() || null;
    if (dto.fecha_cobro !== undefined)
      patch.fecha_cobro = dto.fecha_cobro.toISOString();
    if (dto.notas !== undefined) patch.notas = dto.notas;
    // La comisión bancaria se recalcula si cambia el % (0 = quitarla) o si
    // cambia el monto de un cobro que ya tenía comisión.
    const montoFinal = dto.monto ?? Number(existing.monto);
    if (dto.comision_banco_monto !== undefined) {
      // Monto directo (0 = quitarla): manda sobre el %; el % queda derivado.
      const cm =
        dto.comision_banco_monto > 0
          ? Math.round(dto.comision_banco_monto * 100) / 100
          : null;
      if (cm != null && cm >= montoFinal) {
        throw new BadRequestException(
          'La comisión del banco no puede ser mayor o igual al monto del cobro.',
        );
      }
      patch.comision_banco_monto = cm;
      patch.comision_banco_pct = cm
        ? Math.round((cm / montoFinal) * 100 * 10000) / 10000
        : null;
    } else {
      const pctFinal =
        dto.comision_banco_pct !== undefined
          ? dto.comision_banco_pct > 0
            ? dto.comision_banco_pct
            : null
          : Number(existing.comision_banco_pct) > 0
            ? Number(existing.comision_banco_pct)
            : null;
      if (dto.comision_banco_pct !== undefined || dto.monto !== undefined) {
        patch.comision_banco_pct = pctFinal;
        patch.comision_banco_monto = pctFinal
          ? Math.round(montoFinal * (pctFinal / 100) * 100) / 100
          : null;
      }
    }

    const { data, error } = await this.supabase.service
      .from('cobro_vuelo')
      .update(patch)
      .eq('id', cobroId)
      .select(COBRO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    await this.refreshCobradoFlag(existing.vuelo_id as string, userId);
    return data!;
  }

  /** Elimina un cobro capturado por error (oficina) y recalcula la bandera. */
  async deleteCobro(cobroId: string, userId: string): Promise<{ ok: true }> {
    const { data: existing, error: findErr } = await this.supabase.service
      .from('cobro_vuelo')
      .select('id, vuelo_id')
      .eq('id', cobroId)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (!existing) throw new NotFoundException(`Cobro ${cobroId} not found`);
    // Mismo candado que expenses.remove: borrar un cobro conciliado dejaría
    // el movimiento bancario cuadrado contra nada.
    await this.assertCobroSinConciliar(cobroId);
    const { error } = await this.supabase.service
      .from('cobro_vuelo')
      .delete()
      .eq('id', cobroId);
    if (error) throw new Error(error.message);
    await this.refreshCobradoFlag(existing.vuelo_id as string, userId);
    return { ok: true };
  }
}
