import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CalendarSyncService } from '../calendar/calendar-sync.service';
import { EmailService } from '../notifications/email.service';
import { NotificationsService } from '../realtime/notifications.service';
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
  CreateEscalaDto,
  TacoAiReadDto,
  UpdateEscalaDto,
} from './dto/escalas.dto';
import type { CreateCobroDto } from './dto/cobros.dto';

const VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, piloto_id, ruta_id, tipo, estado, es_externo, operador_externo, costo_externo_usd, cotizacion_version, origen_iata, destino_iata, pasajeros, pasajeros_nombres, monto_total_usd, cotizacion_abierta, fecha_vuelo, fecha_traslado_final, fecha_confirmacion, estado_permiso, foto_plan_vuelo_url, facturado, cobrado, notas, notas_internas, google_calendar_id, created_at, updated_at';

// NOTA: aeronave_id/piloto_id/estado_permiso del tramo orden=1 (ida) se mantienen
// como ESPEJO de vuelo.aeronave_id/piloto_id/estado_permiso (sincronizado por la app,
// ver syncVueloFromIdaEscala / mirrorVueloToIdaEscala). El resto de los tramos son
// independientes.
const ESCALA_COLS =
  'id, vuelo_id, orden, origen_iata, destino_iata, aeronave_id, piloto_id, estado_permiso, fecha_salida_plan, foto_plan_vuelo_url, google_calendar_id, pasajeros, es_ferry, requiere_pernocta, pernocta_costo_usd, tipo_parada, servicio_notas, taco_salida, taco_llegada, foto_taco_salida_url, foto_taco_llegada_url, valor_ia_propuesto, revision_requerida, revision_motivo, hora_salida, hora_llegada, capturado_offline, sincronizado_at, capturado_por, corregido_por, nota_correccion, corregido_at, notas, created_at, updated_at';

// Umbrales de consistencia para la marca AMARILLA (revisión manual).
const AI_VS_MANUAL_TOL_HR = 0.3; // |lectura manual − sugerida IA| en horas
const DURATION_TOL_PCT = 0.4; // desviación de duración vs promedio histórico
const MIN_MUESTRAS = 3; // muestras mínimas para confiar en el promedio

// Tarea 9: validación obligatoria de tacómetro.
const MSG_TACO = 'Debes registrar el tacómetro antes de continuar.';

interface EscalaTaco {
  orden: number;
  taco_salida: string | number | null;
  taco_llegada: string | number | null;
}

const COBRO_COLS =
  'id, vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn, referencia, fecha_cobro, foto_voucher_url, registrado_por, notas, created_at, updated_at';

// Tarea 11: métodos con tarjeta que exigen foto de voucher.
const METODOS_TARJETA = new Set(['BILLPOCKET', 'HSBC_LINK']);

@Injectable()
export class FlightsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly calendar: CalendarSyncService,
    private readonly email: EmailService,
    private readonly vision: VisionService,
    private readonly notifications: NotificationsService,
    private readonly expirations: ExpirationsService,
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
    const [{ count: cobros }, { count: gastos }, { count: tacos }] = await Promise.all([
      sb.from('cobro_vuelo').select('id', { count: 'exact', head: true }).eq('vuelo_id', id),
      sb.from('gasto').select('id', { count: 'exact', head: true }).eq('vuelo_id', id),
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
    // Quita eventos de Google antes de perder los IDs.
    await this.calendar.removeFlight(id).catch(() => undefined);
    await sb.from('cotizacion_version_history').delete().eq('vuelo_id', id);
    await sb.from('escala').delete().eq('vuelo_id', id);
    const { error } = await sb.from('vuelo').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: true, id };
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
      throw new ConflictException(`No se puede reasignar un vuelo ${original.estado as string}.`);
    }
    if (original.aeronave_id === dto.aeronave_id) {
      throw new BadRequestException('Selecciona una aeronave distinta a la actual.');
    }
    await this.validateAssignTargets({ aeronaveId: dto.aeronave_id });

    const { data: aeronave } = await sb
      .from('aeronave')
      .select('matricula')
      .eq('id', dto.aeronave_id)
      .maybeSingle();
    const matricula = (aeronave?.matricula as string) ?? 'otra aeronave';

    // 1) Clon con la nueva aeronave (folio/ids/google nuevos, sin capturas).
    const clonPayload: Record<string, unknown> = { ...(original as Record<string, unknown>) };
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
        'orden, origen_iata, destino_iata, millas_nauticas, pasajeros, es_ferry, requiere_pernocta, pernocta_costo_usd, tipo_parada, servicio_notas, fecha_salida_plan, piloto_id, estado_permiso',
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

    // 3) Cobros del cliente → al vuelo que sí sale. (Los GASTOS se quedan: esa
    //    matrícula los absorbe y el siguiente vuelo solo paga su remanente.)
    await sb
      .from('cobro_vuelo')
      .update({ vuelo_id: (clon as { id: string }).id })
      .eq('vuelo_id', id);

    // 4) Original queda cancelado con el motivo auditable.
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
    const pilotoId = (clon as { piloto_id?: string | null }).piloto_id;
    if (pilotoId) void this.notifyPilotAssigned(pilotoId, clon as Record<string, unknown>);
    return clon!;
  }

  /** Envía aviso de asignación al piloto (best-effort), con info de pernocta. */
  private async notifyPilotAssigned(
    pilotoId: string,
    vuelo: Record<string, unknown>,
  ): Promise<void> {
    const [{ data: piloto }, pernoctas] = await Promise.all([
      this.supabase.service
        .from('usuario')
        .select('nombre, email')
        .eq('id', pilotoId)
        .maybeSingle(),
      this.pernoctasDeVuelo(vuelo.id as string),
    ]);
    const pernoctaTxt =
      pernoctas.length > 0
        ? ` · 🌙 Pernocta en ${pernoctas.join(', ')}`
        : ' · Sin pernocta';
    // Socket + push al piloto (independiente del email).
    void this.notifications.notifyUser(pilotoId, {
      tipo: 'vuelo_asignado',
      titulo: 'Nuevo vuelo asignado',
      cuerpo: `${vuelo.origen_iata as string} → ${vuelo.destino_iata as string} · folio #${vuelo.folio as number}${pernoctaTxt}`,
      data: { vuelo_id: vuelo.id, folio: vuelo.folio, pernoctas },
      link: `/flights/${vuelo.id as string}`,
    });

    const email = (piloto as { email: string | null } | null)?.email;
    if (!email) return;
    void this.email.sendPilotAssignment({
      to: email,
      pilotoNombre: (piloto as { nombre: string }).nombre ?? 'Piloto',
      folio: vuelo.folio as number,
      origenIata: vuelo.origen_iata as string,
      destinoIata: vuelo.destino_iata as string,
      pasajeros: Number(vuelo.pasajeros ?? 0),
      fechaVuelo: (vuelo.fecha_vuelo as string | null) ?? null,
      pernoctas,
    });
  }

  // ============ Vuelos ============

  async list(filters: ListFlightsQuery) {
    let q = this.supabase.service
      .from('vuelo')
      .select(`${VUELO_COLS}, aeronave:aeronave_id(matricula)`, { count: 'exact' })
      .order('fecha_vuelo', { ascending: false, nullsFirst: false })
      .order('fecha_solicitud', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.cliente_id) q = q.eq('cliente_id', filters.cliente_id);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.piloto_id) {
      // Incluye vuelos donde el piloto está asignado al vuelo (ida) o a CUALQUIER
      // tramo (p. ej. solo el regreso de un redondo con pilotos distintos).
      const { data: legVuelos } = await this.supabase.service
        .from('escala')
        .select('vuelo_id')
        .eq('piloto_id', filters.piloto_id);
      const ids = [
        ...new Set((legVuelos ?? []).map((e) => e.vuelo_id as string)),
      ];
      q = ids.length
        ? q.or(`piloto_id.eq.${filters.piloto_id},id.in.(${ids.join(',')})`)
        : q.eq('piloto_id', filters.piloto_id);
    }
    if (filters.estado) q = q.eq('estado', filters.estado);
    if (typeof filters.es_externo === 'boolean') q = q.eq('es_externo', filters.es_externo);
    if (filters.desde) q = q.gte('fecha_vuelo', filters.desde.toISOString());
    if (filters.hasta) q = q.lte('fecha_vuelo', filters.hasta.toISOString());

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    // Aplana la matrícula de la aeronave para el listado (móvil/portal).
    const rows = (data ?? []).map((r) => {
      const row = r as Record<string, unknown> & {
        aeronave?: { matricula?: string } | { matricula?: string }[] | null;
      };
      const a = row.aeronave;
      const matricula = Array.isArray(a) ? a[0]?.matricula : a?.matricula;
      const { aeronave: _omit, ...rest } = row;
      void _omit;
      return { ...rest, aeronave_matricula: matricula ?? null };
    });
    return {
      data: rows,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(VUELO_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${id} not found`);
    return data;
  }

  // ===== Aislamiento de pilotos (Tarea 15) =====

  /**
   * Un PILOTO solo puede operar/ver vuelos asignados a él: al vuelo (ida) o a
   * CUALQUIER tramo (p. ej. solo el regreso de un redondo). Otros roles no se
   * restringen.
   */
  async assertAccess(vueloId: string, current: AuthenticatedUser): Promise<void> {
    if (current.rol !== Rol.PILOTO) return;
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('piloto_id')
      .eq('id', vueloId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${vueloId} not found`);
    if (data.piloto_id === current.userId) return;
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
  async assertAccessByLeg(legId: string, current: AuthenticatedUser): Promise<void> {
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
   * Vista de cotización SEGURA para el piloto: solo campos no sensibles
   * (cliente, ruta, pasajeros, fechas, escalas, monto total cobrable). Oculta
   * comisiones, plataforma de cobro, IVA desglosado, overrides, márgenes y
   * costos internos. Un PILOTO solo puede ver el vuelo asignado a él.
   */
  async quoteView(id: string, current: AuthenticatedUser) {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, tipo, estado, origen_iata, destino_iata, pasajeros, pasajeros_nombres, monto_total_usd, fecha_vuelo, fecha_traslado_final, piloto_id, es_externo, cliente:cliente_id(nombre)',
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
      es_externo: boolean;
      cliente: { nombre: string } | { nombre: string }[] | null;
    };

    const escalas = await this.listEscalas(id);

    // Acceso: el piloto puede ver la cotización si está asignado al vuelo (ida) o
    // a cualquier tramo (p. ej. solo el regreso de un redondo con pilotos distintos).
    if (current.rol === Rol.PILOTO) {
      const asignadoATramo = escalas.some((e) => e.piloto_id === current.userId);
      if (v.piloto_id !== current.userId && !asignadoATramo) {
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
      })),
    };
  }

  private async aeronaveMatricula(
    aeronaveId: string | null | undefined,
  ): Promise<string | null> {
    if (!aeronaveId) return null;
    const { data } = await this.supabase.service
      .from('aeronave')
      .select('matricula')
      .eq('id', aeronaveId)
      .maybeSingle();
    return (data as { matricula?: string } | null)?.matricula ?? null;
  }

  async snapshot(id: string) {
    const vuelo = await this.findById(id);
    const [escalas, cobros, aeronaveMatricula] = await Promise.all([
      this.listEscalas(id),
      this.listCobros(id),
      this.aeronaveMatricula((vuelo as { aeronave_id?: string | null }).aeronave_id),
    ]);
    const escalasEnriquecidas = await this.enrichEscalasAssignment(escalas);
    const totalCobrado = cobros.reduce(
      (acc, c) => acc + Number(c.monto),
      0,
    );
    return {
      ...vuelo,
      aeronave_matricula: aeronaveMatricula,
      escalas: escalasEnriquecidas,
      cobros,
      total_cobrado: Math.round(totalCobrado * 100) / 100,
    };
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
    const nombrePorId = new Map((pilotos.data ?? []).map((p) => [p.id, p.nombre]));
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

  async update(id: string, dto: UpdateFlightDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const current = await this.findById(id);
    if (current.estado === 'CANCELADO' || current.estado === 'COMPLETADO') {
      throw new ConflictException(
        `No se puede modificar un vuelo en estado ${current.estado}`,
      );
    }

    // Operación y administración son caminos independientes: el piloto se puede
    // asignar aunque la cotización no esté confirmada (decisión Itzel/Alejandro).
    const asignandoPiloto =
      dto.piloto_id !== undefined && dto.piloto_id !== null && dto.piloto_id !== '';

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
        throw new BadRequestException(`Referenced entity not found: ${error.message}`);
      throw new Error(error.message);
    }
    void this.calendar.syncFlight(id);
    if (asignandoPiloto && dto.piloto_id !== current.piloto_id) {
      void this.notifyPilotAssigned(dto.piloto_id!, data!);
    }
    // Permiso de pista emitido (pendiente → emitido): avisa a admin/coordinador.
    if (dto.estado_permiso === 'emitido' && current.estado_permiso !== 'emitido') {
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
    // Espejo: el tramo de ida (orden=1) refleja el permiso del vuelo.
    await this.mirrorVueloToIdaEscala(id, { estado_permiso: estadoPermiso });
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
    return data;
  }

  /**
   * Guarda la foto del plan de vuelo de salida (vuelos hacia/desde pistas con
   * permiso). La sube el piloto desde la app; opcional, no bloqueante.
   */
  async setFlightPlan(id: string, fotoUrl: string, userId: string) {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({ foto_plan_vuelo_url: fotoUrl, updated_by: userId })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${id} not found`);
    return data;
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

    const { data: pilots } = await this.supabase.service
      .from('usuario')
      .select('id, nombre')
      .eq('rol', 'PILOTO')
      .eq('estado', 'ACTIVO')
      .order('nombre', { ascending: true });

    // Conflicto: otro vuelo (no cancelado) del mismo piloto ese día.
    const conflicto = new Map<string, number>();
    if (fecha) {
      const day = fecha.slice(0, 10);
      const { data: sameDay } = await this.supabase.service
        .from('vuelo')
        .select('id, folio, piloto_id')
        .gte('fecha_vuelo', `${day}T00:00:00`)
        .lte('fecha_vuelo', `${day}T23:59:59`)
        .neq('estado', 'CANCELADO')
        .neq('id', flightId)
        .not('piloto_id', 'is', null);
      for (const f of sameDay ?? []) {
        if (f.piloto_id) conflicto.set(f.piloto_id as string, f.folio as number);
      }
    }

    // Horas voladas (escalas de vuelos COMPLETADOS) en el mes del vuelo.
    const horas = new Map<string, number>();
    if (fecha) {
      const d = new Date(fecha);
      const mDesde = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
      const mHasta = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59),
      ).toISOString();
      const { data: vuelosMes } = await this.supabase.service
        .from('vuelo')
        .select('id, piloto_id')
        .eq('estado', 'COMPLETADO')
        .not('piloto_id', 'is', null)
        .gte('fecha_vuelo', mDesde)
        .lte('fecha_vuelo', mHasta);
      const pilotoPorVuelo = new Map(
        (vuelosMes ?? []).map((v) => [v.id as string, v.piloto_id as string]),
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
          if (!Number.isFinite(ts) || !Number.isFinite(tl) || tl <= ts) continue;
          // Atribuye las horas al piloto del tramo (ida/regreso pueden diferir);
          // si el tramo no tiene piloto propio, usa el del vuelo.
          const pid =
            (e.piloto_id as string | null) ?? pilotoPorVuelo.get(e.vuelo_id as string);
          if (!pid) continue;
          horas.set(pid, (horas.get(pid) ?? 0) + (tl - ts));
        }
      }
    }

    return (pilots ?? []).map((p) => {
      const h = Math.round((horas.get(p.id) ?? 0) * 10) / 10;
      const folio = conflicto.get(p.id);
      return {
        id: p.id,
        nombre: p.nombre,
        horas_mes: h,
        limite_horas_mes: LIMITE_HORAS_MES,
        excede_limite: h >= LIMITE_HORAS_MES,
        cerca_limite: h >= LIMITE_HORAS_MES * 0.9 && h < LIMITE_HORAS_MES,
        conflicto: folio != null,
        conflicto_folio: folio ?? null,
      };
    });
  }

  async assign(id: string, dto: AssignFlightDto, updatedBy: string) {
    const current = await this.findById(id);
    // Operación independiente de lo administrativo: se asigna avión/piloto en
    // cualquier estado operable (incluida la RESERVA sin cotizar).
    if (current.estado === 'COMPLETADO' || current.estado === 'CANCELADO') {
      throw new ConflictException(
        `No se asigna en estado ${current.estado}.`,
      );
    }
    if (current.es_externo && dto.aeronave_id) {
      throw new BadRequestException('Vuelo externo no admite aeronave_id propia');
    }

    const asignandoPiloto =
      dto.piloto_id !== undefined && dto.piloto_id !== null && dto.piloto_id !== '';

    // Doc 4.3: no se asigna avión/piloto con documento crítico vencido ni avión en taller.
    await this.validateAssignTargets({
      aeronaveId: dto.aeronave_id,
      pilotoId: asignandoPiloto ? dto.piloto_id : undefined,
    });

    const patch: Record<string, unknown> = { updated_by: updatedBy };
    if (dto.aeronave_id !== undefined) patch.aeronave_id = dto.aeronave_id;
    if (dto.piloto_id !== undefined) patch.piloto_id = dto.piloto_id;
    if (dto.fecha_vuelo !== undefined) patch.fecha_vuelo = dto.fecha_vuelo.toISOString();

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
        throw new BadRequestException(`Referenced entity not found: ${error.message}`);
      throw new Error(error.message);
    }
    // Espejo: el tramo de ida (orden=1) refleja la asignación del vuelo.
    await this.mirrorVueloToIdaEscala(id, {
      aeronave_id: dto.aeronave_id,
      piloto_id: dto.piloto_id,
      fecha_salida_plan:
        dto.fecha_vuelo !== undefined ? dto.fecha_vuelo.toISOString() : undefined,
    });
    void this.calendar.syncFlight(id);
    if (asignandoPiloto && dto.piloto_id !== current.piloto_id) {
      void this.notifyPilotAssigned(dto.piloto_id!, data!);
    }
    return data!;
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
    if (objetivos.aeronaveId || objetivos.pilotoId) {
      const bloqueos = await this.expirations.findBlockingExpirations(objetivos);
      if (bloqueos.length > 0) {
        const detalle = bloqueos
          .map((b) => `${b.tipo_nombre} (${b.objetivo})`)
          .join(', ');
        throw new ConflictException(
          `No se puede asignar: documento(s) crítico(s) vencido(s): ${detalle}`,
        );
      }
    }
    if (targets.aeronaveId && (await this.aircraftEnTaller(targets.aeronaveId))) {
      throw new ConflictException(
        'No se puede asignar: la aeronave está en taller (mantenimiento en curso).',
      );
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
    if (fields.aeronave_id !== undefined) patch.aeronave_id = fields.aeronave_id;
    if (fields.piloto_id !== undefined) patch.piloto_id = fields.piloto_id;
    if (fields.estado_permiso !== undefined) patch.estado_permiso = fields.estado_permiso;
    if (fields.fecha_salida_plan !== undefined)
      patch.fecha_salida_plan = fields.fecha_salida_plan;
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('vuelo_id', vueloId)
      .eq('orden', 1);
    if (error) this.logger.warn(`No se pudo espejar la ida del vuelo ${vueloId}: ${error.message}`);
  }

  /**
   * Asigna aeronave/piloto a UN TRAMO (escala) — permite ida y regreso con avión y
   * piloto distintos. Misma validación de documentos/taller que el vuelo. Si el
   * tramo es la ida (orden=1) espeja la asignación en el vuelo (compat).
   */
  async assignEscala(legId: string, dto: AssignEscalaDto, updatedBy: string) {
    const { data: escala, error: escErr } = await this.supabase.service
      .from('escala')
      .select('id, vuelo_id, orden, aeronave_id, piloto_id')
      .eq('id', legId)
      .maybeSingle();
    if (escErr) throw new Error(escErr.message);
    if (!escala) throw new NotFoundException(`Escala ${legId} not found`);

    const vuelo = await this.findById(escala.vuelo_id as string);
    // Operación independiente: asignable en cualquier estado operable.
    if (vuelo.estado === 'COMPLETADO' || vuelo.estado === 'CANCELADO') {
      throw new ConflictException(`No se asigna en estado ${vuelo.estado}.`);
    }
    if (vuelo.es_externo && dto.aeronave_id) {
      throw new BadRequestException('Vuelo externo no admite aeronave_id propia');
    }

    const asignandoPiloto =
      dto.piloto_id !== undefined && dto.piloto_id !== null && dto.piloto_id !== '';

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
        throw new BadRequestException(`Referenced entity not found: ${error.message}`);
      throw new Error(error.message);
    }

    // Si es la ida, espeja al vuelo (compat con lectores vuelo-level).
    if (escala.orden === 1) {
      const vueloPatch: Record<string, unknown> = { updated_by: updatedBy };
      if (dto.aeronave_id !== undefined) vueloPatch.aeronave_id = dto.aeronave_id;
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
        origen_iata: (data as { origen_iata?: string }).origen_iata ?? vuelo.origen_iata,
        destino_iata: (data as { destino_iata?: string }).destino_iata ?? vuelo.destino_iata,
      });
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
      .select('id, vuelo_id, orden, piloto_id, estado_permiso, origen_iata, destino_iata')
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

  async start(id: string, updatedBy: string) {
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
        throw new BadRequestException('No se puede iniciar sin aeronave_id asignada');
      }
      if (!current.piloto_id) {
        throw new BadRequestException('No se puede iniciar sin piloto_id asignado');
      }
    }
    // Tarea 9: no se inicia sin la lectura de tacómetro de salida.
    if (!current.es_externo && this.faltaSalidaInicial(await this.escalasTaco(id))) {
      throw new ConflictException(MSG_TACO);
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({ estado: 'EN_VUELO', updated_by: updatedBy })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    void this.calendar.syncFlight(id);
    return data!;
  }

  async complete(id: string, updatedBy: string) {
    const current = await this.findById(id);
    if (current.estado !== 'EN_VUELO') {
      throw new ConflictException(
        `Solo se completa vuelo desde EN_VUELO. Actual: ${current.estado}`,
      );
    }
    // Tarea 9: no se completa sin tacómetro de salida y llegada en todos los tramos.
    if (!current.es_externo && this.faltaTacoCompleto(await this.escalasTaco(id))) {
      throw new ConflictException(MSG_TACO);
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .update({ estado: 'COMPLETADO', updated_by: updatedBy })
      .eq('id', id)
      .select(VUELO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    void this.calendar.syncFlight(id);
    // Propaga las horas voladas a motor(es), hélice(s) y reserva de overhaul.
    try {
      await this.advanceComponentHours(
        id,
        (data?.aeronave_id as string | null) ?? null,
      );
    } catch (err) {
      this.logger.error(
        `No se pudieron avanzar las horas de componentes del vuelo ${id}: ${
          (err as Error).message
        }`,
      );
    }
    // Alimenta el histórico de tiempos por tramo (best-effort, no bloquea).
    try {
      await this.recordTramoTiempos(id);
    } catch (err) {
      // El recálculo de promedios nunca debe impedir cerrar el vuelo.
      void err;
    }
    return data!;
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
    return data!;
  }

  async createExternal(dto: CreateExternalFlightDto, userId: string) {
    const payload = {
      cliente_id: dto.cliente_id,
      aeronave_id: null,
      es_externo: true,
      operador_externo: dto.operador_externo,
      costo_externo_usd: dto.costo_externo_usd,
      tipo: 'REDONDO',
      estado: 'CONFIRMADO',
      cotizacion_version: 1,
      origen_iata: dto.origen_iata.toUpperCase(),
      destino_iata: dto.destino_iata.toUpperCase(),
      es_redondo_auto: true,
      num_aterrizajes: 2,
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
        throw new BadRequestException(`Referenced entity not found: ${error.message}`);
      throw new Error(error.message);
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
    const origen = dto.origen_iata.toUpperCase();
    const destino = dto.destino_iata.toUpperCase();
    const pasajeros = dto.pasajeros ?? 1;
    const payload = {
      cliente_id: dto.cliente_id,
      aeronave_id: dto.aeronave_id ?? null,
      piloto_id: dto.piloto_id ?? null,
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
        throw new BadRequestException(`Referenced entity not found: ${error.message}`);
      throw new Error(error.message);
    }

    // Tramos tentativos: ida (+ regreso invertido si hay fecha de regreso).
    const vueloId = data!.id as string;
    const legs = [
      {
        vuelo_id: vueloId,
        orden: 1,
        origen_iata: origen,
        destino_iata: destino,
        aeronave_id: dto.aeronave_id ?? null,
        piloto_id: dto.piloto_id ?? null,
        pasajeros,
        fecha_salida_plan: dto.fecha_vuelo.toISOString(),
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
              pasajeros,
              fecha_salida_plan: dto.fecha_traslado_final.toISOString(),
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

    if (dto.piloto_id) void this.notifyPilotAssigned(dto.piloto_id, data!);
    void this.calendar.syncFlight(vueloId);
    return data!;
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
    return data ?? [];
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
        notas: dto.notas,
        created_by: userId,
        updated_by: userId,
      })
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException(`Ya existe una escala con orden ${dto.orden}`);
      throw new Error(error.message);
    }
    return data!;
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
    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.orden !== undefined) patch.orden = dto.orden;
    if (dto.origen_iata) patch.origen_iata = dto.origen_iata.toUpperCase();
    if (dto.destino_iata) patch.destino_iata = dto.destino_iata.toUpperCase();
    if (dto.hora_salida) patch.hora_salida = dto.hora_salida.toISOString();
    if (dto.hora_llegada) patch.hora_llegada = dto.hora_llegada.toISOString();
    if (dto.notas !== undefined) patch.notas = dto.notas;

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
    return data;
  }

  async captureTaco(escalaId: string, dto: CaptureTacoDto, userId: string) {
    const { data: current, error: readErr } = await this.supabase.service
      .from('escala')
      .select('id, vuelo_id, orden, taco_salida, taco_llegada, capturado_por')
      .eq('id', escalaId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!current) throw new NotFoundException(`Escala ${escalaId} not found`);

    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('Empty taco payload');
    }

    // Validate monotonicity: new taco_salida/llegada must be >= existing capture
    if (dto.taco_salida !== undefined && current.taco_salida !== null) {
      if (Number(dto.taco_salida) < Number(current.taco_salida)) {
        throw new ConflictException(
          `taco_salida (${dto.taco_salida}) menor al valor previo (${current.taco_salida})`,
        );
      }
    }
    if (dto.taco_llegada !== undefined && current.taco_llegada !== null) {
      if (Number(dto.taco_llegada) < Number(current.taco_llegada)) {
        throw new ConflictException(
          `taco_llegada (${dto.taco_llegada}) menor al valor previo (${current.taco_llegada})`,
        );
      }
    }
    if (
      dto.taco_llegada !== undefined &&
      dto.taco_salida !== undefined &&
      Number(dto.taco_llegada) < Number(dto.taco_salida)
    ) {
      throw new ConflictException('taco_llegada no puede ser menor a taco_salida');
    }

    const patch: Record<string, unknown> = {
      updated_by: userId,
      capturado_por: userId,
      sincronizado_at: new Date().toISOString(),
    };
    if (dto.taco_salida !== undefined) patch.taco_salida = dto.taco_salida;
    if (dto.taco_llegada !== undefined) patch.taco_llegada = dto.taco_llegada;
    if (dto.foto_taco_salida_url !== undefined) patch.foto_taco_salida_url = dto.foto_taco_salida_url;
    if (dto.foto_taco_llegada_url !== undefined) patch.foto_taco_llegada_url = dto.foto_taco_llegada_url;
    if (dto.valor_ia_propuesto !== undefined) patch.valor_ia_propuesto = dto.valor_ia_propuesto;
    if (dto.hora_salida !== undefined) patch.hora_salida = dto.hora_salida.toISOString();
    if (dto.hora_llegada !== undefined) patch.hora_llegada = dto.hora_llegada.toISOString();
    if (dto.capturado_offline !== undefined) patch.capturado_offline = dto.capturado_offline;

    const { data, error } = await this.supabase.service
      .from('escala')
      .update(patch)
      .eq('id', escalaId)
      .select(ESCALA_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Escala ${escalaId} not found`);

    const finalRow = await this.applyConsistencyFlag(data, userId);
    void this.notifyTacoCaptured(finalRow);
    return finalRow;
  }

  /** Avisa a admin/coordinador que un piloto capturó tacómetro. */
  private async notifyTacoCaptured(escala: Record<string, unknown>): Promise<void> {
    const revision = Boolean(escala.revision_requerida);
    const ruta = `${escala.origen_iata as string} → ${escala.destino_iata as string}`;
    const payload = {
      tipo: 'taco_capturado',
      titulo: revision ? 'Tacómetro capturado · revisar' : 'Tacómetro capturado',
      cuerpo: revision
        ? `${ruta} — ${(escala.revision_motivo as string) ?? 'requiere revisión'}`
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
      .select('id, origen_iata, destino_iata, taco_salida')
      .eq('id', escalaId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!escala) throw new NotFoundException(`Escala ${escalaId} not found`);

    const ia = await this.vision.readTacometro({
      imageBase64: dto.image_base64,
      mediaType: dto.media_type,
      imageUrl: dto.image_url,
    });

    if (ia && ia.legible && ia.lectura !== null) {
      return {
        fuente: 'ia' as const,
        lectura: ia.lectura,
        confianza: ia.confianza,
        legible: true,
        notas: ia.notas,
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
  ): Promise<{ taco_llegada: number; minutos_promedio: number; muestras: number } | null> {
    if (which !== 'llegada' || tacoSalida === null) return null;
    const tramo = await this.getTramoPromedio(origen, destino);
    if (!tramo || tramo.muestras < MIN_MUESTRAS || tramo.minutos_promedio <= 0) return null;
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
    return { minutos_promedio: Number(data.minutos_promedio), muestras: Number(data.muestras) };
  }

  /**
   * Evalúa consistencia de la lectura y marca AMARILLO (revision_requerida) si:
   * (a) la lectura manual difiere de la sugerida por IA más de AI_VS_MANUAL_TOL_HR, o
   * (b) la duración taco (llegada − salida) se aleja del promedio histórico del tramo.
   * Persiste el resultado en la escala y devuelve la fila final.
   */
  private async applyConsistencyFlag(
    escala: Record<string, unknown>,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const tacoSalida = escala.taco_salida === null ? null : Number(escala.taco_salida);
    const tacoLlegada = escala.taco_llegada === null ? null : Number(escala.taco_llegada);
    const valorIa = escala.valor_ia_propuesto === null ? null : Number(escala.valor_ia_propuesto);
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

    // (b) Duración vs promedio histórico.
    if (tacoSalida !== null && tacoLlegada !== null && tacoLlegada >= tacoSalida) {
      const durMin = (tacoLlegada - tacoSalida) * 60;
      const tramo = await this.getTramoPromedio(
        escala.origen_iata as string,
        escala.destino_iata as string,
      );
      if (tramo && tramo.muestras >= MIN_MUESTRAS && tramo.minutos_promedio > 0) {
        const desv = Math.abs(durMin - tramo.minutos_promedio) / tramo.minutos_promedio;
        if (desv > DURATION_TOL_PCT) {
          motivos.push(
            `Duración ${Math.round(durMin)} min fuera de rango histórico (~${Math.round(tramo.minutos_promedio)} min)`,
          );
        }
      }
    }

    const revisionRequerida = motivos.length > 0;
    const revisionMotivo = revisionRequerida ? motivos.join('; ') : null;
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

      const { error } = await this.supabase.service.from('tramo_tiempo_promedio').upsert(
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

  /**
   * Galería de fotos de tacómetro de un vuelo, con URLs firmadas (bucket privado
   * taco-fotos, 1 h). Para el panel admin: ver la evidencia y la marca de revisión.
   */
  async tacoPhotos(vueloId: string) {
    const escalas = await this.listEscalas(vueloId);
    const paths: string[] = [];
    for (const e of escalas) {
      if (e.foto_taco_salida_url) paths.push(e.foto_taco_salida_url as string);
      if (e.foto_taco_llegada_url) paths.push(e.foto_taco_llegada_url as string);
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

  // ===== Validación de tacómetro (Tarea 9) =====

  /**
   * Al completar un vuelo, propaga las horas voladas (suma de
   * taco_llegada − taco_salida por escala) a los contadores lineales de los
   * motores y hélices del avión, y a la reserva de overhaul (horas_acumuladas).
   * Doc 5.2 / 5.7 / 5.9. Solo aplica a vuelos con avión propio (no externos).
   */
  private async advanceComponentHours(
    vueloId: string,
    aeronaveId: string | null,
  ): Promise<void> {
    if (!aeronaveId) return;
    const escalas = await this.escalasTaco(vueloId);
    let horas = 0;
    for (const e of escalas) {
      const salida = Number(e.taco_salida);
      const llegada = Number(e.taco_llegada);
      if (
        Number.isFinite(salida) &&
        Number.isFinite(llegada) &&
        llegada > salida
      ) {
        horas += llegada - salida;
      }
    }
    horas = Math.round(horas * 100) / 100;
    if (horas <= 0) return;
    await Promise.all([
      this.incrementHorasComponente('motor', aeronaveId, horas),
      this.incrementHorasComponente('helice', aeronaveId, horas),
      this.incrementReservaHoras(aeronaveId, horas),
    ]);
  }

  /** Suma `horas` a horas_totales de cada motor/hélice del avión. */
  private async incrementHorasComponente(
    tabla: 'motor' | 'helice',
    aeronaveId: string,
    horas: number,
  ): Promise<void> {
    const { data, error } = await this.supabase.service
      .from(tabla)
      .select('id, horas_totales')
      .eq('aeronave_id', aeronaveId);
    if (error) throw new Error(error.message);
    await Promise.all(
      (data ?? []).map((row) =>
        this.supabase.service
          .from(tabla)
          .update({ horas_totales: Number(row.horas_totales) + horas })
          .eq('id', row.id as string),
      ),
    );
  }

  /** Suma `horas` a horas_acumuladas de la reserva de overhaul del avión. */
  private async incrementReservaHoras(
    aeronaveId: string,
    horas: number,
  ): Promise<void> {
    const { data, error } = await this.supabase.service
      .from('reserva_overhaul')
      .select('id, horas_acumuladas')
      .eq('aeronave_id', aeronaveId);
    if (error) throw new Error(error.message);
    await Promise.all(
      (data ?? []).map((row) =>
        this.supabase.service
          .from('reserva_overhaul')
          .update({
            horas_acumuladas: Number(row.horas_acumuladas) + horas,
          })
          .eq('id', row.id as string),
      ),
    );
  }

  private async escalasTaco(vueloId: string): Promise<EscalaTaco[]> {
    const { data, error } = await this.supabase.service
      .from('escala')
      .select('orden, taco_salida, taco_llegada')
      .eq('vuelo_id', vueloId)
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    return (data as EscalaTaco[] | null) ?? [];
  }

  /** Falta la lectura de salida del primer tramo (o no hay escalas). */
  private faltaSalidaInicial(escalas: EscalaTaco[]): boolean {
    if (escalas.length === 0) return true;
    return escalas[0].taco_salida == null;
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
  async tacoStatus(ids: string[]): Promise<Record<string, { falta: boolean }>> {
    const out: Record<string, { falta: boolean }> = {};
    if (ids.length === 0) return out;
    const { data, error } = await this.supabase.service
      .from('escala')
      .select('vuelo_id, taco_salida, taco_llegada')
      .in('vuelo_id', ids);
    if (error) throw new Error(error.message);

    const acc = new Map<string, { count: number; salida: boolean; llegada: boolean }>();
    for (const id of ids) acc.set(id, { count: 0, salida: true, llegada: true });
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

  async deleteEscala(escalaId: string) {
    const { data: row, error: readErr } = await this.supabase.service
      .from('escala')
      .select('id, taco_salida, taco_llegada')
      .eq('id', escalaId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) throw new NotFoundException(`Escala ${escalaId} not found`);
    if (row.taco_salida !== null || row.taco_llegada !== null) {
      throw new ConflictException(
        'No se puede borrar una escala con tacómetro capturado (auditoría)',
      );
    }
    const { error } = await this.supabase.service.from('escala').delete().eq('id', escalaId);
    if (error) throw new Error(error.message);
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

  async createCobro(vueloId: string, dto: CreateCobroDto, userId: string, rol?: Rol) {
    const vuelo = await this.findById(vueloId);
    // Cargo por cancelación (Itzel): la oficina SÍ puede registrar un cobro en
    // un vuelo cancelado (ej. cliente canceló por clima y se le cobra algo);
    // el piloto en campo no.
    if (vuelo.estado === 'CANCELADO' && rol === Rol.PILOTO) {
      throw new ConflictException(
        'El vuelo está CANCELADO; los cargos por cancelación los registra la oficina.',
      );
    }
    // Tarea 9: el piloto no cobra en campo sin la lectura de tacómetro de salida.
    // (Admin/Facturación quedan exentos para no bloquear anticipos de oficina.)
    if (rol === Rol.PILOTO && !vuelo.es_externo && this.faltaSalidaInicial(await this.escalasTaco(vueloId))) {
      throw new ConflictException(MSG_TACO);
    }
    // Tarea 11: el piloto, al cobrar con tarjeta en campo, debe adjuntar el voucher.
    // (Admin/Facturación quedan exentos para conciliaciones de oficina sin foto.)
    if (rol === Rol.PILOTO && METODOS_TARJETA.has(dto.metodo_cobro) && !dto.foto_voucher_url) {
      throw new BadRequestException('Foto del voucher obligatoria para pagos con tarjeta.');
    }
    const { data: cobro, error } = await this.supabase.service
      .from('cobro_vuelo')
      .insert({
        vuelo_id: vueloId,
        monto: dto.monto,
        moneda: dto.moneda,
        metodo_cobro: dto.metodo_cobro,
        tc_usd_mxn: dto.tc_usd_mxn,
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
      data: { vuelo_id: vueloId, folio: vuelo.folio, monto: dto.monto, moneda: dto.moneda },
      link: `/admin/flights/${vueloId}`,
    };
    void this.notifications.notifyRole(Rol.ADMIN, payload, userId);
    void this.notifications.notifyRole(Rol.FACTURACION, payload, userId);

    return cobro!;
  }

  private async refreshCobradoFlag(vueloId: string, userId: string): Promise<void> {
    const cobros = await this.listCobros(vueloId);
    const vuelo = await this.findById(vueloId);
    // Solo consideramos cobros en USD para esta heurística simple. En FASE de bancos
    // se hace una conciliación más sofisticada con multi-moneda + TC.
    const totalUsd = cobros
      .filter((c) => c.moneda === 'USD')
      .reduce((acc, c) => acc + Number(c.monto), 0);
    const totalMxnAsUsd = cobros
      .filter((c) => c.moneda === 'MXN' && c.tc_usd_mxn)
      .reduce((acc, c) => acc + Number(c.monto) / Number(c.tc_usd_mxn!), 0);
    const aproximadoUsd = totalUsd + totalMxnAsUsd;
    const cobradoDeberiaSer = aproximadoUsd >= Number(vuelo.monto_total_usd);

    if (cobradoDeberiaSer !== vuelo.cobrado) {
      await this.supabase.service
        .from('vuelo')
        .update({ cobrado: cobradoDeberiaSer, updated_by: userId })
        .eq('id', vueloId);
    }
  }
}
