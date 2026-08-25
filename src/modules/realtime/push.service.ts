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

  /** Envía push a todos los dispositivos de un usuario. Limpia tokens inválidos. */
  async sendToUser(usuarioId: string, push: PushInput): Promise<void> {
    if (!this.messaging) return;
    try {
      const { data, error } = await this.supabase.service
        .from('dispositivo_push')
        .select('token, plataforma')
        .eq('usuario_id', usuarioId);
      if (error) throw new Error(error.message);

      const filas = (data ?? []) as { token: string; plataforma: string | null }[];
      const tokens = filas.map((d) => d.token);
      if (tokens.length === 0) return;

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
