import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { SupabaseService } from '../supabase/supabase.service';
import type { EnvVars } from '../../config/env.schema';

export interface PushInput {
  title: string;
  body?: string;
  data?: Record<string, string>;
}

/** Fila de `dispositivo_push` (token FCM/APNs + plataforma). */
export interface DispositivoPush {
  token: string;
  plataforma: string | null;
}

// Solo códigos que de verdad significan "este token murió". OJO:
// 'messaging/invalid-argument' es un error de PAYLOAD, no de token — estaba
// aquí y un payload malo podía borrar tokens VÁLIDOS en masa (25-ago).
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * Envío de push vía Firebase Cloud Messaging (FCM/APNs). Best-effort: si la
 * credencial no está configurada, queda deshabilitado (no-op) y no rompe nada.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private messaging: admin.messaging.Messaging | null = null;

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
  ) {}

  onModuleInit() {
    const raw = this.config.get('FCM_SERVICE_ACCOUNT_JSON', { infer: true });
    if (!raw) {
      this.logger.log('Push deshabilitado (FCM_SERVICE_ACCOUNT_JSON vacío)');
      return;
    }
    try {
      const serviceAccount = JSON.parse(raw) as admin.ServiceAccount;
      const app =
        admin.apps.find((a) => a?.name === 'vuelatour-push') ??
        admin.initializeApp(
          { credential: admin.credential.cert(serviceAccount) },
          'vuelatour-push',
        );
      this.messaging = app.messaging();
      this.logger.log('Push (FCM) activo');
    } catch (err) {
      this.logger.error(
        `FCM_SERVICE_ACCOUNT_JSON inválido — push deshabilitado: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  get enabled(): boolean {
    return this.messaging !== null;
  }

  async registerToken(usuarioId: string, token: string, plataforma: string): Promise<void> {
    const { error } = await this.supabase.service.from('dispositivo_push').upsert(
      {
        usuario_id: usuarioId,
        token,
        plataforma,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );
    if (error) throw new Error(error.message);
  }

  async unregisterToken(token: string): Promise<void> {
    const { error } = await this.supabase.service
      .from('dispositivo_push')
      .delete()
      .eq('token', token);
    if (error) throw new Error(error.message);
  }

  /** Dispositivos registrados de un usuario (tokens + plataforma). */
  async dispositivosDe(usuarioId: string): Promise<DispositivoPush[]> {
    const { data, error } = await this.supabase.service
      .from('dispositivo_push')
      .select('token, plataforma')
      .eq('usuario_id', usuarioId);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Conteo de dispositivos por usuario en UNA consulta (calendario, lista
   * de usuarios, /me): la oficina necesita saber a quién NO le puede llegar
   * un push (incidente 3-sep-2026: el responsable de un evento no tenía la
   * app registrada y nadie lo supo). Los ids sin fila no aparecen (= 0).
   */
  async contarDispositivosPorUsuario(
    usuarioIds: string[],
  ): Promise<Map<string, number>> {
    const conteo = new Map<string, number>();
    const ids = [...new Set(usuarioIds.filter((id) => !!id))];
    if (ids.length === 0) return conteo;
    const { data, error } = await this.supabase.service
      .from('dispositivo_push')
      .select('usuario_id')
      .in('usuario_id', ids);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { usuario_id: string }[]) {
      conteo.set(row.usuario_id, (conteo.get(row.usuario_id) ?? 0) + 1);
    }
    return conteo;
  }

  /**
   * Envía push a todos los dispositivos de un usuario. Limpia tokens
   * inválidos. `dispositivos` permite reusar la lectura que ya hizo el
   * llamador (notifyUserDetallado) y evitar la segunda consulta.
   */
  async sendToUser(
    usuarioId: string,
    push: PushInput,
    dispositivos?: DispositivoPush[],
  ): Promise<void> {
    if (!this.messaging) return;
    try {
      const filas = dispositivos ?? (await this.dispositivosDe(usuarioId));
      const tokens = filas.map((d) => d.token);
      if (tokens.length === 0) {
        // Nunca más en silencio (3-sep-2026): un usuario sin dispositivo no
        // recibe NADA por push aunque la notificación quede persistida.
        this.logger.warn(
          `push a ${usuarioId} omitido: sin dispositivos registrados en dispositivo_push · "${push.title}"`,
        );
        return;
      }

      const res = await this.messaging.sendEachForMulticast({
        tokens,
        notification: { title: push.title, body: push.body },
        data: push.data ?? {},
        // iOS/APNs: prioridad alta + sonido; sin este bloque el banner llega
        // mudo (o de plano no se muestra) y "parece que no llegó" (25-ago).
        apns: {
          headers: {
            'apns-priority': '10',
            'apns-push-type': 'alert',
          },
          payload: {
            aps: { sound: 'default' },
          },
        },
        android: {
          priority: 'high',
        },
      });

      const stale: string[] = [];
      res.responses.forEach((r, i) => {
        if (r.success) return;
        // El fallo era INVISIBLE (nadie consultaba failureCount): un iOS sin
        // llave APNs en Firebase fallaba por token, en silencio, siempre.
        this.logger.warn(
          `push a ${usuarioId} falló [${filas[i]?.plataforma ?? '?'} …${tokens[i].slice(-8)}]: ${r.error?.code ?? '?'} ${r.error?.message ?? ''}`,
        );
        if (r.error && INVALID_TOKEN_CODES.has(r.error.code)) {
          stale.push(tokens[i]);
        }
      });
      if (stale.length > 0) {
        await this.supabase.service.from('dispositivo_push').delete().in('token', stale);
      }
    } catch (err) {
      this.logger.warn(
        `sendToUser(${usuarioId}) falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
