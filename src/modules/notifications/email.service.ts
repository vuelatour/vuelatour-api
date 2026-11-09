import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { EnvVars } from '../../config/env.schema';

export interface PilotAssignmentData {
  to: string;
  pilotoNombre: string;
  folio: string | number;
  origenIata: string;
  destinoIata: string;
  /** Ruta OPERATIVA completa con escalas (ej. "CUN → PCE → HOL → PCE → CUN").
   *  Evita malentendidos: el piloto ve todo el itinerario, no solo los extremos. */
  rutaCompleta?: string;
  pasajeros: number;
  fechaVuelo: string | null;
  /** Destinos donde el piloto pernocta. Vacío = sin pernocta (también se informa). */
  pernoctas?: string[];
}

export interface UserInvitationData {
  to: string;
  nombre: string;
  rol: string;
  /** True si es un reenvío (cambia el asunto/copy). */
  reenvio?: boolean;
}

/**
 * Envío de correos vía Resend. Best-effort: si falla (key ausente, dominio sin
 * verificar, rate limit) se loguea y NO se propaga el error, para no romper la
 * operación que disparó el correo (ej. confirmar una cotización).
 */
const ROL_LABELS: Record<string, string> = {
  ADMIN: 'Administrador',
  COORDINADOR: 'Coordinador',
  ANALISTA: 'Analista',
  FACTURACION: 'Facturación',
  PILOTO: 'Piloto',
  SOCIO: 'Socio',
  MECANICO: 'Mecánico',
};

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;
  private from = '';
  private appUrl = '';

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  onModuleInit() {
    const apiKey = this.config.get('RESEND_API_KEY', { infer: true });
    this.from = this.config.get('RESEND_FROM', { infer: true });
    this.appUrl = this.config.get('APP_PUBLIC_URL', { infer: true });
    if (!apiKey) {
      this.logger.log(
        'Resend disabled (RESEND_API_KEY vacío) — correos no se envían',
      );
      return;
    }
    this.resend = new Resend(apiKey);
    this.logger.log(`Email (Resend) activo · from: ${this.from}`);
  }

  /** ¿Resend está configurado? (para que el caller informe si no se envió). */
  get enabled(): boolean {
    return !!this.resend;
  }

  /** Desde qué dirección salen los correos («VuelaTour <notificaciones@…>»). */
  get remitente(): string {
    return this.from;
  }

  /**
   * Envío GENÉRICO con RESULTADO (9-nov-2026, invariante 128): a diferencia
   * de los `send*` best-effort, quien llama necesita saber si salió o no
   * para registrarlo en la bitácora `correo_cliente`. NUNCA lanza.
   */
  async enviar(msg: {
    to: string;
    asunto: string;
    html: string;
    texto: string;
  }): Promise<{ ok: boolean; id: string | null; error: string | null }> {
    if (!this.resend) {
      return {
        ok: false,
        id: null,
        error: 'El envío de correos está apagado en el servidor.',
      };
    }
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.from,
        to: msg.to,
        subject: msg.asunto,
        html: msg.html,
        text: msg.texto,
      });
      if (error) {
        const texto =
          typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : JSON.stringify(error);
        this.logger.error(
          `Resend error (${msg.asunto}): ${JSON.stringify(error)}`,
        );
        return { ok: false, id: null, error: texto };
      }
      const id =
        data && typeof (data as { id?: unknown }).id === 'string'
          ? data.id
          : null;
      this.logger.log(`Correo enviado a ${msg.to} · ${msg.asunto}`);
      return { ok: true, id, error: null };
    } catch (err) {
      const texto = err instanceof Error ? err.message : String(err);
      this.logger.error(`enviar(${msg.asunto}) falló: ${texto}`);
      return { ok: false, id: null, error: texto };
    }
  }

  /**
   * Invitación de acceso a la plataforma. El usuario ya quedó pre-autorizado en
   * la BD; este correo le avisa y lo manda a iniciar sesión con su correo de
   * Google. Devuelve true si el correo se envió correctamente.
   */
  async sendUserInvitation(data: UserInvitationData): Promise<boolean> {
    if (!this.resend) {
      this.logger.warn(
        'sendUserInvitation: Resend deshabilitado, no se envía invitación',
      );
      return false;
    }
    if (!data.to) {
      this.logger.warn('sendUserInvitation: usuario sin email');
      return false;
    }
    const rolLabel = ROL_LABELS[data.rol] ?? data.rol;
    const loginUrl = `${this.appUrl.replace(/\/$/, '')}/login`;
    const subject = data.reenvio
      ? 'Recordatorio: tu acceso a VuelaTour'
      : 'Te invitaron a VuelaTour';
    try {
      const { error } = await this.resend.emails.send({
        from: this.from,
        to: data.to,
        subject,
        html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d1d1d">
  <div style="background:#102a43;padding:24px;border-radius:12px 12px 0 0">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">VuelaTour</h1>
    <p style="color:#9fb3c8;margin:4px 0 0;font-size:13px">Aero Charter Cancún</p>
  </div>
  <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;padding:24px">
    <p style="font-size:15px">Hola <strong>${data.nombre}</strong>,</p>
    <p style="font-size:15px">Tienes acceso a la plataforma de VuelaTour con el rol de <strong>${rolLabel}</strong>.</p>
    <p style="font-size:15px">Inicia sesión con este mismo correo (<strong>${data.to}</strong>), que ya quedó autorizado. Puedes entrar con tu cuenta de Google o con la contraseña que te compartan:</p>
    <div style="text-align:center;margin:24px 0">
      <a href="${loginUrl}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 28px;border-radius:10px">Iniciar sesión</a>
    </div>
    <p style="font-size:13px;color:#6b7280">Si el botón no funciona, copia y pega esta dirección:<br><span style="color:#102a43">${loginUrl}</span></p>
    <p style="font-size:13px;color:#6b7280;margin-top:24px">Si crees que recibiste este correo por error, ignóralo.</p>
  </div>
</div>`.trim(),
        text: [
          `Hola ${data.nombre},`,
          '',
          `Tienes acceso a la plataforma de VuelaTour con el rol de ${rolLabel}.`,
          `Inicia sesión con este mismo correo (${data.to}) — con Google o la contraseña que te compartan:`,
          loginUrl,
          '',
          'Si crees que recibiste este correo por error, ignóralo.',
        ].join('\n'),
      });
      if (error) {
        this.logger.error(
          `Resend error (invitación ${data.to}): ${JSON.stringify(error)}`,
        );
        return false;
      }
      this.logger.log(`Invitación enviada a ${data.to}`);
      return true;
    } catch (err) {
      this.logger.error(
        `sendUserInvitation(${data.to}) falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  async sendPilotAssignment(data: PilotAssignmentData): Promise<void> {
    if (!this.resend) return;
    if (!data.to) {
      this.logger.warn(
        `Vuelo #${data.folio}: piloto sin email, no se envía aviso de asignación`,
      );
      return;
    }
    try {
      const fecha = data.fechaVuelo
        ? `${new Date(data.fechaVuelo).toLocaleString('es-MX', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: 'America/Cancun',
          })} (hora de Cancún)`
        : 'Por confirmar';
      const tienePernocta = (data.pernoctas?.length ?? 0) > 0;
      const pernoctaLabel = tienePernocta
        ? `🌙 Sí — en ${data.pernoctas!.join(', ')}`
        : 'No (regreso según itinerario)';
      // Ruta COMPLETA con escalas: el piloto debe ver todo el itinerario, no
      // solo CUN → CUN (los extremos engañan en redondos/multiescala).
      const ruta =
        data.rutaCompleta && data.rutaCompleta.trim()
          ? data.rutaCompleta
          : `${data.origenIata} → ${data.destinoIata}`;

      const { error } = await this.resend.emails.send({
        from: this.from,
        to: data.to,
        subject: `Vuelo asignado · ${ruta} (folio #${data.folio})${tienePernocta ? ' · 🌙 con pernocta' : ''}`,
        html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d1d1d">
  <div style="background:#102a43;padding:24px;border-radius:12px 12px 0 0">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">VuelaTour</h1>
    <p style="color:#9fb3c8;margin:4px 0 0;font-size:13px">Aero Charter Cancún</p>
  </div>
  <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;padding:24px">
    <p style="font-size:15px">Hola <strong>${data.pilotoNombre}</strong>,</p>
    <p style="font-size:15px">Se te asignó un nuevo vuelo.</p>
    <div style="font-size:28px;font-weight:800;letter-spacing:-1px;margin:16px 0;color:#102a43;line-height:1.3">
      ${ruta}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:8px 0;color:#6b7280">Folio</td><td style="padding:8px 0;text-align:right;font-weight:600">#${data.folio}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Pasajeros</td><td style="padding:8px 0;text-align:right;font-weight:600">${data.pasajeros}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Fecha</td><td style="padding:8px 0;text-align:right;font-weight:600">${fecha}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Pernocta</td><td style="padding:8px 0;text-align:right;font-weight:600;${tienePernocta ? 'color:#b45309' : ''}">${pernoctaLabel}</td></tr>
    </table>
    <p style="font-size:13px;color:#6b7280;margin-top:24px">Revisa los detalles en la app VuelaTour Pilotos.</p>
  </div>
</div>`.trim(),
        text: [
          `Hola ${data.pilotoNombre},`,
          '',
          'Se te asignó un nuevo vuelo.',
          '',
          `Folio: #${data.folio}`,
          `Ruta: ${ruta}`,
          `Pasajeros: ${data.pasajeros}`,
          `Fecha: ${fecha}`,
          `Pernocta: ${pernoctaLabel}`,
          '',
          'Revisa los detalles en la app VuelaTour Pilotos.',
        ].join('\n'),
      });
      if (error) {
        this.logger.error(
          `Resend error (asignación) vuelo #${data.folio}: ${JSON.stringify(error)}`,
        );
        return;
      }
      this.logger.log(
        `Aviso de asignación enviado a ${data.to} (vuelo #${data.folio})`,
      );
    } catch (err) {
      this.logger.error(
        `sendPilotAssignment(#${data.folio}) falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Correo genérico de alerta (Tarea 8). Best-effort. */
  async sendAlert(
    to: string,
    subject: string,
    titulo: string,
    cuerpo: string,
  ): Promise<void> {
    if (!this.resend || !to) return;
    try {
      const { error } = await this.resend.emails.send({
        from: this.from,
        to,
        subject,
        html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d1d1d">
  <div style="background:#102a43;padding:20px;border-radius:12px 12px 0 0">
    <h1 style="color:#fff;margin:0;font-size:18px;font-weight:700">VuelaTour</h1>
    <p style="color:#9fb3c8;margin:4px 0 0;font-size:12px">Aero Charter Cancún</p>
  </div>
  <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;padding:24px">
    <p style="font-size:16px;font-weight:700;margin:0 0 8px">${titulo}</p>
    <p style="font-size:14px;color:#374151;margin:0;white-space:pre-line">${cuerpo}</p>
    <p style="font-size:12px;color:#6b7280;margin-top:24px">Esta es una alerta automática del sistema VuelaTour.</p>
  </div>
</div>`.trim(),
        text: `${titulo}\n\n${cuerpo}\n\n— Alerta automática de VuelaTour.`,
      });
      if (error) {
        this.logger.error(`Resend error (alerta): ${JSON.stringify(error)}`);
      }
    } catch (err) {
      this.logger.error(
        `sendAlert falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
