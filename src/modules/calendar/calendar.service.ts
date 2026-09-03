import {
  NotificationsService,
  type EntregaNotificacion,
} from '../realtime/notifications.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { diaCancun, hoyCancun } from '../../common/fecha-cancun.util';
import { PushService } from '../realtime/push.service';
import { SupabaseService } from '../supabase/supabase.service';
import { CalendarSyncService } from './calendar-sync.service';
import type {
  CalendarRangeQuery,
  CreateEventoFlotaDto,
  UpdateEventoFlotaDto,
} from './dto/calendar.dto';
import {
  aEventoMe,
  avisoEventoBase,
  cambiosRelevantes,
  cuerpoEvento,
  EVENTO_FLOTA_COLS,
  horaCancun,
  mapEventoRow,
  rangoMisEventos,
  sumarDias,
  type EventoFlotaRow,
  type EventoInterno,
  type EventoMe,
} from './evento-flota.util';

/**
 * Resultado del aviso al responsable de un evento (POST/PATCH eventos):
 * la oficina ve si el aviso pudo llegar al teléfono (3-sep-2026).
 */
export interface AvisoEvento extends EntregaNotificacion {
  responsable_id: string;
  nombre: string | null;
}

// Paleta del equipo (21-ago-2026): externos en rosa pálido #F0DCDB.
const EXTERNAL_COLOR = '#F0DCDB';
// Color de alerta para vuelos con permiso de pista pendiente. Configurable.
const PERMISO_PENDIENTE_COLOR = '#F59E0B';
// Vuelo propio confirmado pero todavía SIN avión asignado (acción pendiente).
const SIN_ASIGNAR_COLOR = '#8B5CF6';
// Reserva tentativa: espacio apartado sin cotización ("espérame y te confirmo").
const TENTATIVO_COLOR = '#64748B';
// Vuelo CANCELADO: se queda en el calendario como historial de operaciones
// (pedido del cliente, ago 2026) — en rojo y con la etiqueta CANCELADO.
const CANCELADO_COLOR = '#EF4444';

function unwrap<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return value;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationsService,
    private readonly calendarSync: CalendarSyncService,
    private readonly push: PushService,
  ) {}

  async listEvents(q: CalendarRangeQuery) {
    const now = new Date();
    const from = q.from ?? now;
    const to =
      q.to ??
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 30,
        23,
        59,
        59,
      );

    let query = this.supabase.service
      .from('vuelo')
      .select(
        // copiloto/apoyos (29-ago, aditivo): tripulación por tramo en el evento.
        'id, folio, fecha_vuelo, fecha_traslado_final, fecha_fin, tipo, estado, es_externo, origen_iata, destino_iata, pasajeros, monto_total_usd, aeronave_id, piloto_id, copiloto_id, cliente_id, operador_externo, estado_permiso, google_calendar_id, aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre), copiloto:copiloto_id(nombre), cliente:cliente_id(nombre), apoyos:vuelo_apoyo(escala_id, usuario_id, usuario:usuario_id(nombre)), escalas:escala(id, orden, origen_iata, destino_iata, fecha_salida_plan, es_ferry, pasajeros, aeronave_id, piloto_id, copiloto_id, estado_permiso, cancelada_at, aeronave:aeronave_id(matricula, color_calendario), piloto:piloto_id(nombre), copiloto:copiloto_id(nombre))',
      )
      // Solapamiento de [fecha_vuelo, fecha_fin] con el rango pedido.
      // fecha_fin (trigger BD) ya es max(fecha_salida_plan) del itinerario:
      // cubre el regreso del redondo Y los tramos de un viaje multi-día que
      // caen en otro mes (antes esos desaparecían de la vista del mes).
      .lte('fecha_vuelo', to.toISOString())
      .gte('fecha_fin', from.toISOString())
      .order('fecha_vuelo', { ascending: true });

    // Los CANCELADOS se incluyen por defecto desde ago 2026: el calendario es
    // el registro de operaciones del cliente ("existió la solicitud, luego se
    // canceló"). Se pintan en rojo con etiqueta; `incluir_cancelados=false`
    // permite excluirlos explícitamente.
    if (q.incluir_cancelados === false) {
      query = query.neq('estado', 'CANCELADO');
    }
    // Filtros con asignación por TRAMO (barrido 28-ago, patrón de
    // flights.list): un piloto/avión asignado solo a un tramo de otro vuelo
    // quedaba fuera del filtro. Ningún consumidor los manda hoy, pero el
    // primero que los adopte los necesita correctos.
    if (q.aeronave_id) {
      const { data: legsAv } = await this.supabase.service
        .from('escala')
        .select('vuelo_id')
        .eq('aeronave_id', q.aeronave_id)
        .is('cancelada_at', null);
      const ids = [...new Set((legsAv ?? []).map((l) => l.vuelo_id as string))];
      query = ids.length
        ? query.or(`aeronave_id.eq.${q.aeronave_id},id.in.(${ids.join(',')})`)
        : query.eq('aeronave_id', q.aeronave_id);
    }
    if (q.piloto_id) {
      // 29-ago: también copiloto (vuelo o tramo) y apoyo (vuelo_apoyo).
      const [{ data: legsPi }, { data: apoyosPi }] = await Promise.all([
        this.supabase.service
          .from('escala')
          .select('vuelo_id')
          .or(`piloto_id.eq.${q.piloto_id},copiloto_id.eq.${q.piloto_id}`)
          .is('cancelada_at', null),
        this.supabase.service
          .from('vuelo_apoyo')
          .select('vuelo_id')
          .eq('usuario_id', q.piloto_id),
      ]);
      const ids = [
        ...new Set([
          ...(legsPi ?? []).map((l) => l.vuelo_id as string),
          ...(apoyosPi ?? []).map((a) => a.vuelo_id as string),
        ]),
      ];
      const ors = [
        `piloto_id.eq.${q.piloto_id}`,
        `copiloto_id.eq.${q.piloto_id}`,
        `apoyo_id.eq.${q.piloto_id}`,
      ];
      if (ids.length) ors.push(`id.in.(${ids.join(',')})`);
      query = query.or(ors.join(','));
    }
    if (q.solo_externos) query = query.eq('es_externo', true);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const inRange = (iso: string | null): boolean => {
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return !Number.isNaN(t) && t >= fromMs && t <= toMs;
    };
    const horaOf = (iso: string | null): string | null =>
      iso
        ? new Date(iso).toLocaleTimeString('es-MX', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Cancun',
          })
        : null;

    const events = (data ?? []).flatMap((row) => {
      const v = row as unknown as {
        id: string;
        folio: number;
        fecha_vuelo: string | null;
        fecha_traslado_final: string | null;
        tipo: string | null;
        estado: string;
        es_externo: boolean;
        origen_iata: string;
        destino_iata: string;
        pasajeros: number;
        monto_total_usd: string;
        aeronave_id: string | null;
        piloto_id: string | null;
        copiloto_id: string | null;
        cliente_id: string;
        operador_externo: string | null;
        estado_permiso: string | null;
        google_calendar_id: string | null;
        aeronave:
          | { matricula: string; color_calendario: string | null }
          | { matricula: string; color_calendario: string | null }[]
          | null;
        piloto: { nombre: string } | { nombre: string }[] | null;
        copiloto: { nombre: string } | { nombre: string }[] | null;
        cliente: { nombre: string } | { nombre: string }[] | null;
        apoyos: Array<{
          escala_id: string | null;
          usuario_id: string;
          usuario: { nombre: string } | { nombre: string }[] | null;
        }> | null;
        escalas: Array<{
          id: string;
          orden: number;
          origen_iata: string;
          destino_iata: string;
          fecha_salida_plan: string | null;
          es_ferry: boolean;
          pasajeros: number | null;
          aeronave_id: string | null;
          piloto_id: string | null;
          copiloto_id: string | null;
          estado_permiso: string | null;
          cancelada_at: string | null;
          aeronave:
            | { matricula: string; color_calendario: string | null }
            | { matricula: string; color_calendario: string | null }[]
            | null;
          piloto: { nombre: string } | { nombre: string }[] | null;
          copiloto: { nombre: string } | { nombre: string }[] | null;
        }> | null;
      };
      const cliente = unwrap(v.cliente);
      const escalaPorOrden = new Map(
        (v.escalas ?? []).map((e) => [e.orden, e]),
      );

      // Construye un evento usando la asignación del TRAMO (escala), con respaldo
      // en la asignación a nivel de vuelo cuando el tramo no exista todavía.
      const buildEvent = (params: {
        idSuffix: string;
        escalaOrden: number;
        fecha: string | null;
        tramo?: 'ida' | 'regreso';
        origen: string;
        destino: string;
        prefijo?: string;
        pasajeros?: number;
      }): Record<string, unknown> | null => {
        if (!inRange(params.fecha)) return null;
        const escala = escalaPorOrden.get(params.escalaOrden);
        // HERENCIA CANÓNICA (regla del repo, bug 28-ago): un tramo sin
        // avión/piloto propio HEREDA el del vuelo — el detalle lo pinta
        // "(del vuelo)" y está ASIGNADO. Antes los ids resolvían a null
        // cuando la escala existía (los NOMBRES sí heredaban): la tarjeta
        // mostraba al piloto y a la vez "⚠ Falta asignar".
        const aeronaveId = escala?.aeronave_id ?? v.aeronave_id;
        const pilotoId = escala?.piloto_id ?? v.piloto_id;
        const aeronave = unwrap(escala?.aeronave ?? v.aeronave);
        const piloto = unwrap(escala?.piloto ?? v.piloto);
        // Copiloto con la MISMA herencia que el piloto; apoyos efectivos del
        // tramo = los del vuelo ∪ los del tramo (29-ago, aditivo).
        const copilotoId = escala?.copiloto_id ?? v.copiloto_id;
        const copiloto = unwrap(escala?.copiloto ?? v.copiloto);
        const apoyosVistos = new Set<string>();
        const apoyos = (v.apoyos ?? [])
          .filter(
            (a) =>
              a.escala_id == null ||
              (escala != null && a.escala_id === escala.id),
          )
          .sort(
            (a, b) =>
              (a.escala_id == null ? 0 : 1) - (b.escala_id == null ? 0 : 1),
          )
          .filter((a) => {
            if (apoyosVistos.has(a.usuario_id)) return false;
            apoyosVistos.add(a.usuario_id);
            return true;
          })
          .map((a) => ({
            id: a.usuario_id,
            nombre: unwrap(a.usuario)?.nombre ?? null,
            origen: a.escala_id == null ? 'vuelo' : 'tramo',
          }));
        const estadoPermiso = escala
          ? (escala.estado_permiso ?? null)
          : v.estado_permiso;

        const aeronaveStr = v.es_externo
          ? (v.operador_externo ?? 'Externo')
          : (aeronave?.matricula ?? 'sin avión');
        // Cancelado a nivel VUELO o el TRAMO del evento cancelado (no voló):
        // ambos se quedan como historial en rojo y sin edición rápida.
        const esCancelado =
          v.estado === 'CANCELADO' || escala?.cancelada_at != null;
        // Un cancelado ya no acarrea pendientes: sin ⚠ de permiso/asignación.
        const permisoPendiente = !esCancelado && estadoPermiso === 'pendiente';
        const sinAsignar =
          v.estado === 'CONFIRMADO' &&
          !v.es_externo &&
          (!aeronaveId || !pilotoId);
        const esTentativo = v.estado === 'RESERVA';
        // El cancelado domina el color (historial); luego el tentativo (es un
        // espacio apartado, no un vuelo firme).
        const color = esCancelado
          ? CANCELADO_COLOR
          : esTentativo
            ? TENTATIVO_COLOR
            : sinAsignar
              ? SIN_ASIGNAR_COLOR
              : permisoPendiente
                ? PERMISO_PENDIENTE_COLOR
                : v.es_externo
                  ? EXTERNAL_COLOR
                  : (aeronave?.color_calendario ?? '#9CA3AF');
        const hora = horaOf(params.fecha);
        return {
          id: `${v.id}${params.idSuffix}`,
          vuelo_id: v.id,
          escala_id: escala?.id ?? null,
          folio: v.folio,
          estado: v.estado,
          // Bandera única para los lectores (panel y app): cubre vuelo
          // cancelado Y tramo cancelado sin duplicar la lógica allá.
          cancelado: esCancelado,
          estado_permiso: estadoPermiso,
          es_externo: v.es_externo,
          sin_asignar: sinAsignar,
          color,
          cliente_id: v.cliente_id,
          cliente_nombre: cliente?.nombre ?? null,
          aeronave_id: aeronaveId,
          aeronave_matricula: aeronave?.matricula ?? null,
          operador_externo: v.operador_externo,
          piloto_id: pilotoId,
          piloto_nombre: piloto?.nombre ?? null,
          copiloto_id: copilotoId ?? null,
          copiloto_nombre: copiloto?.nombre ?? null,
          apoyos,
          pasajeros: params.pasajeros ?? v.pasajeros,
          monto_total_usd: Number(v.monto_total_usd),
          google_calendar_id: v.google_calendar_id,
          fecha_vuelo: params.fecha,
          hora,
          tramo: params.tramo,
          origen_iata: params.origen,
          destino_iata: params.destino,
          title: `${esCancelado ? 'CANCELADO · ' : esTentativo ? 'Tentativo · ' : ''}${params.prefijo ?? ''}${hora ? `${hora} · ` : ''}${aeronaveStr} ${params.origen}-${params.destino} (${params.pasajeros ?? v.pasajeros} pax)${sinAsignar ? ' ⚠ sin asignar' : permisoPendiente ? ' ⚠ permiso' : ''}`,
        };
      };

      const out: Array<Record<string, unknown>> = [];
      const escalasOrdenadas = [...(v.escalas ?? [])].sort(
        (a, b) => a.orden - b.orden,
      );

      // Multiescala: los tramos cancelados individualmente NO entran a la
      // cadena del día (no volaron); si TODOS los del día están cancelados,
      // el día se pinta con el primero (cancelado, en rojo) como historial.
      const escalasVivas = escalasOrdenadas.filter((e) => !e.cancelada_at);
      if (v.tipo === 'MULTIESCALA' && escalasOrdenadas.length > 0) {
        // UN evento por vuelo por DÍA (no por tramo): el itinerario del día se
        // muestra encadenado ("CZM-PCE-CZM-CUN"), como lo maneja el cliente en
        // su calendario. Un tramo sin fecha propia se asume del mismo día que
        // el tramo anterior; si sale otro día, abre un evento nuevo (pernocta
        // o viaje multi-día).
        const dayOf = (iso: string): string =>
          new Date(iso).toLocaleDateString('en-CA', {
            timeZone: 'America/Cancun',
          });
        type Grupo = { fecha: string; legs: typeof escalasOrdenadas };
        const grupos: Grupo[] = [];
        // La cadena se arma con los tramos VIVOS; si el vuelo entero quedó
        // sin tramos vivos, se usa todo (evento cancelado como historial).
        const base = escalasVivas.length > 0 ? escalasVivas : escalasOrdenadas;
        base.forEach((e, i) => {
          const fecha = e.fecha_salida_plan ?? (i === 0 ? v.fecha_vuelo : null);
          const ultimo = grupos[grupos.length - 1];
          if (fecha && (!ultimo || dayOf(fecha) !== dayOf(ultimo.fecha))) {
            grupos.push({ fecha, legs: [e] });
          } else if (ultimo) {
            ultimo.legs.push(e);
          }
        });
        grupos.forEach((g, gi) => {
          const puntos = [
            g.legs[0].origen_iata,
            ...g.legs.map((l) => l.destino_iata),
          ];
          const pax = g.legs
            .filter((l) => !l.es_ferry)
            .reduce((m, l) => Math.max(m, l.pasajeros ?? 0), 0);
          const todoFerry = g.legs.every((l) => l.es_ferry);
          const ev = buildEvent({
            idSuffix: gi === 0 ? '' : `:dia:${gi}`,
            escalaOrden: g.legs[0].orden,
            fecha: g.fecha,
            // La cadena completa del día en el label: "CZM-PCE-CZM" → "CUN".
            origen: puntos.slice(0, -1).join('-'),
            destino: puntos[puntos.length - 1],
            prefijo: todoFerry ? 'Ferry · ' : undefined,
            pasajeros: pax,
          });
          if (ev) out.push(ev);
        });
        return out;
      }

      // IDA (orden 1, en fecha_vuelo).
      const ida = buildEvent({
        idSuffix: '',
        escalaOrden: 1,
        fecha: v.fecha_vuelo,
        tramo: 'ida',
        origen: v.origen_iata,
        destino: v.destino_iata,
      });
      if (ida) out.push(ida);
      // REGRESO de vuelo redondo (orden 2, IATAs invertidos). La hora REAL es
      // la planeada del tramo (asignación por tramo la actualiza); el
      // fecha_traslado_final del vuelo es el respaldo comercial — sin el
      // fallback, cambiar la hora del regreso no se reflejaba aquí.
      if (v.tipo === 'REDONDO') {
        const regreso = buildEvent({
          idSuffix: ':regreso',
          escalaOrden: 2,
          fecha:
            escalaPorOrden.get(2)?.fecha_salida_plan ?? v.fecha_traslado_final,
          tramo: 'regreso',
          origen: v.destino_iata,
          destino: v.origen_iata,
          prefijo: '↩ Regreso · ',
        });
        if (regreso) out.push(regreso);
      }
      return out;
    });

    // Descansos de pilotos en el rango: un evento por día de descanso, para
    // que se pinten en el calendario junto a los vuelos (pedido del cliente).
    const DESCANSO_COLOR = '#14B8A6';
    const fromDay = from.toISOString().slice(0, 10);
    const toDay = to.toISOString().slice(0, 10);
    let dq = this.supabase.service
      .from('piloto_descanso')
      .select(
        'id, piloto_id, fecha_inicio, fecha_fin, motivo, piloto:usuario!piloto_id(nombre)',
      )
      .lte('fecha_inicio', toDay)
      .gte('fecha_fin', fromDay);
    if (q.piloto_id) dq = dq.eq('piloto_id', q.piloto_id);
    const { data: descansos } = q.solo_externos ? { data: [] } : await dq;
    for (const d of descansos ?? []) {
      const piloto = Array.isArray(d.piloto) ? d.piloto[0] : d.piloto;
      const nombre = (piloto as { nombre?: string } | null)?.nombre ?? 'Piloto';
      const ini = new Date(`${d.fecha_inicio as string}T12:00:00Z`);
      const fin = new Date(`${d.fecha_fin as string}T12:00:00Z`);
      for (let t = ini.getTime(); t <= fin.getTime(); t += 86_400_000) {
        const day = new Date(t).toISOString().slice(0, 10);
        if (day < fromDay || day > toDay) continue;
        events.push({
          id: `descanso:${d.id as string}:${day}`,
          tipo_evento: 'descanso',
          descanso_id: d.id,
          vuelo_id: null,
          escala_id: null,
          folio: null,
          fecha_vuelo: `${day}T12:00:00Z`,
          hora: null,
          estado: 'DESCANSO',
          estado_permiso: null,
          es_externo: false,
          title: `Descansa · ${nombre}${d.motivo ? ` (${d.motivo as string})` : ''}`,
          color: DESCANSO_COLOR,
          piloto_id: d.piloto_id,
          piloto_nombre: nombre,
        });
      }
    }
    // Eventos NO-vuelo (21-ago-2026: lavado, trámites, visitas): salen junto
    // a vuelos y descansos. Con avión toman su color de calendario; sin
    // avión, azul cielo propio (leyenda "Evento"). Multi-día = un evento por
    // día, igual que los descansos.
    const EVENTO_COLOR = '#0EA5E9';
    let eq = this.supabase.service
      .from('evento_flota')
      .select(EVENTO_FLOTA_COLS)
      .lte('fecha', to.toISOString())
      .or(`fecha_fin.is.null,fecha_fin.gte.${from.toISOString()}`)
      .gte('fecha', new Date(from.getTime() - 40 * 86_400_000).toISOString());
    if (q.aeronave_id) eq = eq.eq('aeronave_id', q.aeronave_id);
    // FIX 3-sep-2026 (incidente "Llenar Bitácora"): con piloto_id los eventos
    // se OMITÍAN por completo y la vista por piloto no mostraba lo que le
    // tocaba. Ahora se filtran por responsable, con el mismo cap de -40 días
    // y la misma expansión multi-día.
    if (q.piloto_id) eq = eq.eq('responsable_id', q.piloto_id);
    const { data: eventosFlota, error: evErr } = q.solo_externos
      ? { data: [], error: null }
      : await eq;
    if (evErr) throw new Error(evErr.message);
    const eventosMap = (
      (eventosFlota ?? []) as unknown as EventoFlotaRow[]
    ).map(mapEventoRow);
    // Entregabilidad del aviso (3-sep): la oficina ve si el responsable tiene
    // la app registrada — UNA consulta agrupada, no N+1.
    const conteoPush = await this.push.contarDispositivosPorUsuario(
      eventosMap
        .map((e) => e.responsable_id)
        .filter((id): id is string => !!id),
    );
    for (const ev of eventosMap) {
      const matricula = ev.aeronave_matricula;
      const color = ev.aeronave_color ?? EVENTO_COLOR;
      const iniDia = diaCancun(ev.fecha);
      const finDia = ev.fecha_fin ? diaCancun(ev.fecha_fin) : iniDia;
      const hora = horaCancun(ev.fecha);
      const ini = new Date(`${iniDia}T12:00:00Z`);
      const fin = new Date(`${finDia}T12:00:00Z`);
      for (let t = ini.getTime(); t <= fin.getTime(); t += 86_400_000) {
        const day = new Date(t).toISOString().slice(0, 10);
        if (day < fromDay || day > toDay) continue;
        events.push({
          id: `evento:${ev.id}:${day}`,
          tipo_evento: 'evento',
          evento_id: ev.id,
          titulo: ev.titulo,
          notas: ev.notas,
          vuelo_id: null,
          escala_id: null,
          folio: null,
          // La app y el panel leen la fecha SIEMPRE de esta llave; el primer
          // día conserva la hora real, los siguientes van a mediodía UTC
          // (mismo truco de los descansos para caer en el día Cancún).
          fecha_vuelo: day === iniDia ? ev.fecha : `${day}T12:00:00Z`,
          hora: day === iniDia ? hora : null,
          estado: 'EVENTO',
          estado_permiso: null,
          es_externo: false,
          cancelado: false,
          sin_asignar: false,
          title: `Evento · ${ev.titulo}${matricula ? ` · ${matricula}` : ''}`,
          color,
          aeronave_id: ev.aeronave_id,
          aeronave_matricula: matricula,
          piloto_id: ev.responsable_id,
          piloto_nombre: ev.responsable_nombre,
          // null = sin responsable; 0 = el responsable NO tiene la app
          // registrada (la oficina debe avisarle por otro medio).
          responsable_push_dispositivos: ev.responsable_id
            ? (conteoPush.get(ev.responsable_id) ?? 0)
            : null,
        });
      }
    }

    // MANTENIMIENTOS con fecha (26-ago): PROGRAMADO ámbar / EN_TALLER rojo,
    // un pin en su fecha_programada (DATE → mediodía UTC = día Cancún, mismo
    // truco de descansos/eventos). OPT-IN vía incluir_mantenimientos: el APK
    // viejo no conoce el tipo y no debe recibirlo. Vista de piloto no aplica.
    if (q.incluir_mantenimientos === true && !q.piloto_id && !q.solo_externos) {
      let mq = this.supabase.service
        .from('mantenimiento')
        .select(
          'id, descripcion, estado, fecha_programada, horas_programadas, etapa_intervalo_hr, aeronave_id, aeronave:aeronave_id(matricula, color_calendario)',
        )
        .neq('estado', 'COMPLETADO')
        .not('fecha_programada', 'is', null)
        .gte('fecha_programada', fromDay)
        .lte('fecha_programada', toDay)
        .order('fecha_programada', { ascending: true });
      if (q.aeronave_id) mq = mq.eq('aeronave_id', q.aeronave_id);
      const { data: mants, error: mErr } = await mq;
      if (mErr) throw new Error(mErr.message);
      interface MantRow {
        id: string;
        descripcion: string | null;
        estado: string | null;
        fecha_programada: string;
        aeronave_id: string | null;
        aeronave:
          | { matricula?: string | null }
          | Array<{ matricula?: string | null }>
          | null;
      }
      for (const m of (mants ?? []) as unknown as MantRow[]) {
        const aero = Array.isArray(m.aeronave)
          ? (m.aeronave[0] ?? null)
          : m.aeronave;
        const matricula = aero?.matricula ?? null;
        const enTaller = m.estado === 'EN_TALLER';
        const desc = m.descripcion ?? 'Servicio';
        events.push({
          id: `mant:${m.id}`,
          tipo_evento: 'mantenimiento',
          mantenimiento_id: m.id,
          titulo: desc,
          vuelo_id: null,
          escala_id: null,
          folio: null,
          fecha_vuelo: `${m.fecha_programada}T12:00:00Z`,
          hora: null,
          estado: enTaller ? 'EN_TALLER' : 'PROGRAMADO',
          estado_permiso: null,
          es_externo: false,
          cancelado: false,
          sin_asignar: false,
          title: `Servicio · ${matricula ?? 'avión'} · ${desc}`,
          color: enTaller ? '#EF4444' : '#F59E0B',
          aeronave_id: m.aeronave_id ?? null,
          aeronave_matricula: matricula,
          piloto_id: null,
          piloto_nombre: null,
        });
      }
    }

    events.sort((a, b) =>
      String((a as { fecha_vuelo?: string }).fecha_vuelo ?? '').localeCompare(
        String((b as { fecha_vuelo?: string }).fecha_vuelo ?? ''),
      ),
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      count: events.length,
      events,
    };
  }

  // ===== Eventos NO-vuelo (evento_flota) =====
  //
  // Incidente 3-sep-2026 ("Llenar Bitácora"): el aviso al responsable era un
  // `alerta_sistema` sin hora/avión/link, el piloto no tenía dispositivo
  // push, su app no leía eventos y la oficina no supo que no le llegó nada.
  // Desde entonces: 4 tipos propios (evento_asignado / evento_actualizado /
  // evento_cancelado / recordatorio_evento), cuerpo SIEMPRE con hora Cancún,
  // matrícula y notas, link a /me/eventos?dia=…, y POST/PATCH devuelven el
  // resultado de entrega (`aviso`) para que la oficina confirme por otro
  // medio cuando el responsable no tiene la app registrada.

  /** Fila completa (embeds incluidos) o null. */
  private async cargarEvento(id: string): Promise<EventoInterno | null> {
    const { data, error } = await this.supabase.service
      .from('evento_flota')
      .select(EVENTO_FLOTA_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapEventoRow(data) : null;
  }

  /**
   * Aviso al responsable con detalle de entrega. `null` si no hay
   * responsable o si el actor ES el responsable (quien se agenda algo a sí
   * mismo ya lo sabe — única exclusión de auto-aviso que se conserva).
   */
  private async avisarResponsable(
    ev: EventoInterno,
    actorId: string,
    tipo: 'evento_asignado' | 'evento_actualizado',
  ): Promise<AvisoEvento | null> {
    if (!ev.responsable_id || ev.responsable_id === actorId) return null;
    const entrega = await this.notifications.notifyUserDetallado(
      ev.responsable_id,
      {
        tipo,
        titulo:
          tipo === 'evento_asignado'
            ? 'Te asignaron un evento'
            : 'Evento actualizado',
        cuerpo: cuerpoEvento(ev),
        ...avisoEventoBase(ev),
      },
    );
    return {
      responsable_id: ev.responsable_id,
      nombre: ev.responsable_nombre,
      ...entrega,
    };
  }

  /** `aviso` cuando NO se mandó nada (PATCH sin cambios relevantes): la
   *  oficina igual ve si el responsable tiene la app registrada. */
  private async avisoSinEnvio(ev: EventoInterno): Promise<AvisoEvento | null> {
    if (!ev.responsable_id) return null;
    let dispositivos: { plataforma: string | null }[] = [];
    try {
      dispositivos = await this.push.dispositivosDe(ev.responsable_id);
    } catch {
      /* best-effort: se reporta 0 */
    }
    return {
      responsable_id: ev.responsable_id,
      nombre: ev.responsable_nombre,
      notificado: false,
      push_dispositivos: dispositivos.length,
      plataformas: [
        ...new Set(
          dispositivos.map((d) => d.plataforma).filter((p): p is string => !!p),
        ),
      ],
    };
  }

  /**
   * Espejo en el Google Calendar compartido (best-effort, patrón descansos
   * de pilots.service): nunca bloquea. Con `google_calendar_id` actualiza;
   * sin él crea (si la sync está apagada, calendar-sync hace no-op). El id
   * de Google lo persiste calendar-sync (única pluma de esa columna).
   */
  private espejoGoogle(ev: EventoInterno): void {
    void this.calendarSync
      .upsertEventoFlotaEvent({
        id: ev.id,
        titulo: ev.titulo,
        fecha: ev.fecha,
        fecha_fin: ev.fecha_fin,
        aeronave_matricula: ev.aeronave_matricula,
        responsable_nombre: ev.responsable_nombre,
        notas: ev.notas,
        google_calendar_id: ev.google_calendar_id,
      })
      .catch(() => undefined);
  }

  private static readonly REFERENCIA_ROTA = '23503';

  /** Alta de un evento NO-vuelo (oficina o app). */
  async createEvento(dto: CreateEventoFlotaDto, userId: string) {
    if (dto.fecha_fin && dto.fecha_fin < dto.fecha) {
      throw new BadRequestException(
        'La fecha fin no puede ser anterior al inicio.',
      );
    }
    const { data, error } = await this.supabase.service
      .from('evento_flota')
      .insert({
        titulo: dto.titulo.trim(),
        fecha: dto.fecha.toISOString(),
        fecha_fin: dto.fecha_fin?.toISOString() ?? null,
        aeronave_id: dto.aeronave_id ?? null,
        responsable_id: dto.responsable_id ?? null,
        notas: dto.notas?.trim() || null,
        created_by: userId,
        updated_by: userId,
      })
      .select(EVENTO_FLOTA_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === CalendarService.REFERENCIA_ROTA)
        throw new BadRequestException(
          `Referencia no encontrada: ${error.message}`,
        );
      throw new Error(error.message);
    }
    if (!data) throw new Error('No se pudo crear el evento');
    const ev = mapEventoRow(data);
    // Se ESPERA el aviso: la respuesta le dice a la oficina si llegó.
    const aviso = await this.avisarResponsable(ev, userId, 'evento_asignado');
    this.espejoGoogle(ev);
    return {
      ...aEventoMe(ev),
      responsable_nombre: ev.responsable_nombre,
      aviso,
    };
  }

  /**
   * Edición de un evento NO-vuelo. `undefined` = no tocar; `null` = limpiar
   * (avión, responsable, fin, notas). Valida fin ≥ inicio con los valores
   * RESULTANTES, sella updated_by, re-sincroniza Google y avisa:
   *  - responsable nuevo ≠ anterior → evento_asignado al nuevo y
   *    evento_cancelado ("Ya no te toca") al anterior;
   *  - mismo responsable y cambia fecha/fin/avión/título/notas →
   *    evento_actualizado.
   */
  async updateEvento(id: string, dto: UpdateEventoFlotaDto, userId: string) {
    const prev = await this.cargarEvento(id);
    if (!prev) throw new NotFoundException(`Evento ${id} not found`);

    const fecha = dto.fecha instanceof Date ? dto.fecha : new Date(prev.fecha);
    if (Number.isNaN(fecha.getTime())) {
      throw new BadRequestException('Fecha inválida.');
    }
    const fechaFin =
      dto.fecha_fin === undefined
        ? prev.fecha_fin
          ? new Date(prev.fecha_fin)
          : null
        : (dto.fecha_fin ?? null);
    if (fechaFin && fechaFin < fecha) {
      throw new BadRequestException(
        'La fecha fin no puede ser anterior al inicio.',
      );
    }
    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    if (dto.titulo !== undefined) {
      const titulo = typeof dto.titulo === 'string' ? dto.titulo.trim() : '';
      if (!titulo) throw new BadRequestException('El título es obligatorio.');
      patch.titulo = titulo;
    }
    if (dto.fecha !== undefined) patch.fecha = fecha.toISOString();
    if (dto.fecha_fin !== undefined)
      patch.fecha_fin = fechaFin?.toISOString() ?? null;
    if (dto.aeronave_id !== undefined)
      patch.aeronave_id = dto.aeronave_id ?? null;
    if (dto.responsable_id !== undefined)
      patch.responsable_id = dto.responsable_id ?? null;
    if (dto.notas !== undefined) patch.notas = dto.notas?.trim() || null;

    const { data, error } = await this.supabase.service
      .from('evento_flota')
      .update(patch)
      .eq('id', id)
      .select(EVENTO_FLOTA_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === CalendarService.REFERENCIA_ROTA)
        throw new BadRequestException(
          `Referencia no encontrada: ${error.message}`,
        );
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Evento ${id} not found`);
    const next = mapEventoRow(data);

    let aviso: AvisoEvento | null = null;
    if (prev.responsable_id !== next.responsable_id) {
      // El anterior deja de tenerlo en su agenda: se le avisa con los datos
      // que él conocía (fecha/avión previos).
      if (prev.responsable_id && prev.responsable_id !== userId) {
        void this.notifications.notifyUser(prev.responsable_id, {
          tipo: 'evento_cancelado',
          titulo: 'Evento cancelado',
          cuerpo: `Ya no te toca: ${cuerpoEvento(prev)}`,
          ...avisoEventoBase(prev),
        });
      }
      aviso = await this.avisarResponsable(next, userId, 'evento_asignado');
    } else if (next.responsable_id && next.responsable_id !== userId) {
      aviso = cambiosRelevantes(prev, next)
        ? await this.avisarResponsable(next, userId, 'evento_actualizado')
        : await this.avisoSinEnvio(next);
    }
    this.espejoGoogle(next);
    return {
      ...aEventoMe(next),
      responsable_nombre: next.responsable_nombre,
      aviso,
    };
  }

  /** Elimina un evento NO-vuelo (la UI confirma antes). */
  async removeEvento(id: string) {
    const ev = await this.cargarEvento(id);
    if (!ev) throw new NotFoundException(`Evento ${id} not found`);
    const { error } = await this.supabase.service
      .from('evento_flota')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    // Su espejo en Google también se quita (best-effort, fire-and-forget).
    void this.calendarSync.removeEventoFlotaEvent({
      google_calendar_id: ev.google_calendar_id,
    });
    // El responsable también debe saber que el evento se quitó (26-ago);
    // con hora/avión para que reconozca CUÁL (3-sep).
    if (ev.responsable_id) {
      void this.notifications.notifyUser(ev.responsable_id, {
        tipo: 'evento_cancelado',
        titulo: 'Evento cancelado',
        cuerpo: `Se quitó del calendario: ${cuerpoEvento(ev)}`,
        ...avisoEventoBase(ev),
      });
    }
    return { ok: true };
  }

  /**
   * Eventos donde el usuario es RESPONSABLE (GET /v1/me/eventos): una fila
   * por evento (sin expandir por día). Solapamiento de
   * [fecha, coalesce(fecha_fin, fecha)] con el rango en cortes Cancún.
   */
  async listEventosDeResponsable(
    usuarioId: string,
    desde?: string,
    hasta?: string,
  ): Promise<EventoMe[]> {
    const r = rangoMisEventos(desde, hasta);
    if (
      Number.isNaN(Date.parse(r.desdeTs)) ||
      Number.isNaN(Date.parse(r.hastaTs))
    ) {
      throw new BadRequestException(
        'desde/hasta deben ser fechas válidas YYYY-MM-DD.',
      );
    }
    if (r.hasta < r.desde) {
      throw new BadRequestException(
        'hasta debe ser igual o posterior a desde.',
      );
    }
    return this.eventosDeResponsableEntre(usuarioId, r.desdeTs, r.hastaTs);
  }

  /** Expediente del piloto: eventos de hoy → +`dias` días (máx `max`). */
  async eventosProximosDe(
    usuarioId: string,
    dias = 60,
    max = 10,
  ): Promise<EventoMe[]> {
    const hoy = hoyCancun();
    const r = rangoMisEventos(hoy, sumarDias(hoy, dias), hoy);
    return this.eventosDeResponsableEntre(usuarioId, r.desdeTs, r.hastaTs, max);
  }

  private async eventosDeResponsableEntre(
    usuarioId: string,
    desdeTs: string,
    hastaTs: string,
    limit?: number,
  ): Promise<EventoMe[]> {
    // Mismo instante en Z para el `.or()` (PostgREST lo parsea sin ruido).
    const desdeIso = new Date(desdeTs).toISOString();
    let q = this.supabase.service
      .from('evento_flota')
      .select(EVENTO_FLOTA_COLS)
      .eq('responsable_id', usuarioId)
      .lte('fecha', hastaTs)
      .or(
        `fecha_fin.gte.${desdeIso},and(fecha_fin.is.null,fecha.gte.${desdeIso})`,
      )
      .order('fecha', { ascending: true });
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as EventoFlotaRow[])
      .map(mapEventoRow)
      .map(aEventoMe);
  }
}
