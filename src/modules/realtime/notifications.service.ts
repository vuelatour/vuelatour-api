import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { Rol } from '../../common/types/auth.types';
import { RealtimeGateway } from './realtime.gateway';

export interface NotificationInput {
  tipo: string;
  titulo: string;
  cuerpo?: string;
  data?: Record<string, unknown>;
  link?: string;
}

const NOTIF_COLS = 'id, usuario_id, tipo, titulo, cuerpo, data, link, leida, created_at, read_at';
const SOCKET_EVENT = 'notification';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /** Persiste y emite una notificación a un usuario. Best-effort. */
  async notifyUser(usuarioId: string, n: NotificationInput): Promise<void> {
    try {
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
    } catch (err) {
      this.logger.warn(
        `notifyUser(${usuarioId}) falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Persiste una fila por cada usuario ACTIVO del rol y emite al room del rol.
   * `excludeUsuarioId` evita auto-notificar a quien disparó el evento.
   */
  async notifyRole(
    rol: Rol,
    n: NotificationInput,
    excludeUsuarioId?: string,
  ): Promise<void> {
    try {
      const { data: users, error: usersErr } = await this.supabase.service
        .from('usuario')
        .select('id')
        .eq('rol', rol)
        .eq('estado', 'ACTIVO');
      if (usersErr) throw new Error(usersErr.message);

      const targets = (users ?? [])
        .map((u) => (u as { id: string }).id)
        .filter((id) => id !== excludeUsuarioId);
      if (targets.length === 0) return;

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
    } catch (err) {
      this.logger.warn(
        `notifyRole(${rol}) falló: ${err instanceof Error ? err.message : String(err)}`,
      );
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
