import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { Rol } from '../../common/types/auth.types';
import { PushService, type DispositivoPush } from './push.service';
import { RealtimeGateway } from './realtime.gateway';

export interface NotificationInput {
  tipo: string;
  titulo: string;
  cuerpo?: string;
  data?: Record<string, unknown>;
  link?: string;
}

/**
 * Resultado de entrega de una notificación a un usuario (3-sep-2026): la
 * fila persistida NO garantiza que al usuario le llegue nada — sin
 * dispositivos registrados el push se omite. Los llamadores que informan a
 * la oficina (eventos de flota) muestran este detalle.
 */
export interface EntregaNotificacion {
  /** true = fila persistida en `notificacion` (y socket/push disparados). */
  notificado: boolean;
  /** Dispositivos del usuario en `dispositivo_push` al momento del envío. */
  push_dispositivos: number;
  /** Plataformas distintas de esos dispositivos ('android', 'ios', …). */
  plataformas: string[];
}

const SIN_ENTREGA: EntregaNotificacion = {
  notificado: false,
  push_dispositivos: 0,
  plataformas: [],
};

const NOTIF_COLS = 'id, usuario_id, tipo, titulo, cuerpo, data, link, leida, created_at, read_at';
const SOCKET_EVENT = 'notification';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly gateway: RealtimeGateway,
    private readonly push: PushService,
  ) {}

  private pushPayload(n: NotificationInput) {
    return {
      title: n.titulo,
      body: n.cuerpo,
      data: {
        tipo: n.tipo,
        link: n.link ?? '',
        // FCM exige strings: null/undefined viajan como '' (antes "null");
        // objetos como JSON (antes "[object Object]").
        ...Object.fromEntries(
          Object.entries(n.data ?? {}).map(([k, v]) => [
            k,
            v == null
              ? ''
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v as string | number | boolean),
          ]),
        ),
      },
    };
  }

  /**
   * Persiste y emite una notificación a un usuario. Best-effort (nunca
   * lanza). Devuelve `true` solo si la notificación quedó PERSISTIDA: los
   * llamadores con reintento (alerts.dispatch) marcan su dedupe solo tras una
   * entrega exitosa. La mayoría de llamadores puede ignorar el retorno.
   */
  async notifyUser(usuarioId: string, n: NotificationInput): Promise<boolean> {
    return (await this.notifyUserDetallado(usuarioId, n)).notificado;
  }

  /**
   * Igual que `notifyUser`, pero devuelve el DETALLE de entrega: si quedó la
   * fila y cuántos dispositivos push tenía el usuario (0 = no le llegará
   * nada al teléfono aunque la campana de la app lo muestre al abrirla).
   * Best-effort: nunca lanza.
   */
  async notifyUserDetallado(
    usuarioId: string,
    n: NotificationInput,
  ): Promise<EntregaNotificacion> {
    try {
      // Los pilotos EXTERNOS no tienen acceso al sistema (doc 3.7): no se les
      // genera notificación (ni fila, ni socket, ni push) por ningún camino.
      const { data: target } = await this.supabase.service
        .from('usuario')
        .select('es_piloto_externo')
        .eq('id', usuarioId)
        .maybeSingle();
      if (target?.es_piloto_externo === true) return SIN_ENTREGA;

      const { data, error } = await this.supabase.service
        .from('notificacion')
        .insert({
          usuario_id: usuarioId,
          tipo: n.tipo,
          titulo: n.titulo,
          cuerpo: n.cuerpo ?? null,
          data: n.data ?? {},
          link: n.link ?? null,
        })
        .select(NOTIF_COLS)
        .maybeSingle();
      if (error) throw new Error(error.message);
      this.gateway.emitToUser(usuarioId, SOCKET_EVENT, data);

      // Dispositivos: una lectura que el push reutiliza (no consulta doble).
      // Si falla, la notificación ya quedó: se reporta 0 y el push consulta
      // por su cuenta.
      let dispositivos: DispositivoPush[] | undefined;
      try {
        dispositivos = await this.push.dispositivosDe(usuarioId);
      } catch (err) {
        this.logger.warn(
          `dispositivosDe(${usuarioId}) falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      void this.push.sendToUser(usuarioId, this.pushPayload(n), dispositivos);
      return {
        notificado: true,
        push_dispositivos: dispositivos?.length ?? 0,
        plataformas: [
          ...new Set(
            (dispositivos ?? [])
              .map((d) => d.plataforma)
              .filter((p): p is string => !!p),
          ),
        ],
      };
    } catch (err) {
      this.logger.warn(
        `notifyUser(${usuarioId}) falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return SIN_ENTREGA;
    }
  }

  /**
   * Persiste una fila por cada usuario ACTIVO del rol y emite al room del rol.
   * `excludeUsuarioId` evita auto-notificar a quien disparó el evento.
   * Best-effort (nunca lanza). Devuelve el NÚMERO de usuarios a los que quedó
   * persistida la notificación (0 = sin destinatarios o falló): los
   * llamadores con reintento (alerts.dispatch) marcan su dedupe solo tras una
   * entrega exitosa. La mayoría de llamadores puede ignorar el retorno.
   */
  async notifyRole(
    rol: Rol,
    n: NotificationInput,
    excludeUsuarioId?: string,
  ): Promise<number> {
    try {
      const { data: users, error: usersErr } = await this.supabase.service
        .from('usuario')
        .select('id')
        .eq('rol', rol)
        .eq('estado', 'ACTIVO')
        // Externos sin acceso: fuera de los broadcasts por rol.
        .eq('es_piloto_externo', false);
      if (usersErr) throw new Error(usersErr.message);

      const targets = (users ?? [])
        .map((u) => (u as { id: string }).id)
        .filter((id) => id !== excludeUsuarioId);
      if (targets.length === 0) return 0;

      const rows = targets.map((id) => ({
        usuario_id: id,
        tipo: n.tipo,
        titulo: n.titulo,
        cuerpo: n.cuerpo ?? null,
        data: n.data ?? {},
        link: n.link ?? null,
      }));
      const { error } = await this.supabase.service.from('notificacion').insert(rows);
      if (error) throw new Error(error.message);

      // Push a cada destinatario (best-effort, no-op si está deshabilitado).
      const payload = this.pushPayload(n);
      for (const id of targets) void this.push.sendToUser(id, payload);

      // Emisión en vivo: al room del rol (excepto el emisor, que ya tiene su
      // propio room por usuario y queda excluido de la persistencia arriba).
      this.gateway.emitToRole(rol, SOCKET_EVENT, {
        tipo: n.tipo,
        titulo: n.titulo,
        cuerpo: n.cuerpo ?? null,
        data: n.data ?? {},
        link: n.link ?? null,
        created_at: new Date().toISOString(),
      });
      return targets.length;
    } catch (err) {
      this.logger.warn(
        `notifyRole(${rol}) falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  async list(
    usuarioId: string,
    opts: { limit: number; offset: number; unreadOnly: boolean },
  ) {
    let q = this.supabase.service
      .from('notificacion')
      .select(NOTIF_COLS, { count: 'exact' })
      .eq('usuario_id', usuarioId)
      .order('created_at', { ascending: false })
      .range(opts.offset, opts.offset + opts.limit - 1);
    if (opts.unreadOnly) q = q.eq('leida', false);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { data: data ?? [], count: count ?? 0, limit: opts.limit, offset: opts.offset };
  }

  async unreadCount(usuarioId: string): Promise<number> {
    const { count, error } = await this.supabase.service
      .from('notificacion')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId)
      .eq('leida', false);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  async markRead(usuarioId: string, id: string): Promise<{ updated: boolean }> {
    const { error, count } = await this.supabase.service
      .from('notificacion')
      .update({ leida: true, read_at: new Date().toISOString() }, { count: 'exact' })
      .eq('id', id)
      .eq('usuario_id', usuarioId)
      .eq('leida', false);
    if (error) throw new Error(error.message);
    return { updated: (count ?? 0) > 0 };
  }

  async markAllRead(usuarioId: string): Promise<{ updated: number }> {
    const { error, count } = await this.supabase.service
      .from('notificacion')
      .update({ leida: true, read_at: new Date().toISOString() }, { count: 'exact' })
      .eq('usuario_id', usuarioId)
      .eq('leida', false);
    if (error) throw new Error(error.message);
    return { updated: count ?? 0 };
  }
}
