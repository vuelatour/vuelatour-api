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

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
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
        .select('token')
        .eq('usuario_id', usuarioId);
      if (error) throw new Error(error.message);

      const tokens = (data ?? []).map((d) => (d as { token: string }).token);
      if (tokens.length === 0) return;

      const res = await this.messaging.sendEachForMulticast({
        tokens,
        notification: { title: push.title, body: push.body },
        data: push.data ?? {},
      });

      const stale: string[] = [];
      res.responses.forEach((r, i) => {
        if (!r.success && r.error && INVALID_TOKEN_CODES.has(r.error.code)) {
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
