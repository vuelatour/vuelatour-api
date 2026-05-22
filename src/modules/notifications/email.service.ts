import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { EnvVars } from '../../config/env.schema';

export interface FlightConfirmationData {
  to: string;
  clienteNombre: string;
  folio: string | number;
  origenIata: string;
  destinoIata: string;
  pasajeros: number;
  fechaVuelo: string | null;
  montoTotalUsd: number;
}

export interface PilotAssignmentData {
  to: string;
  pilotoNombre: string;
  folio: string | number;
  origenIata: string;
  destinoIata: string;
  pasajeros: number;
  fechaVuelo: string | null;
}

/**
 * Envío de correos vía Resend. Best-effort: si falla (key ausente, dominio sin
 * verificar, rate limit) se loguea y NO se propaga el error, para no romper la
 * operación que disparó el correo (ej. confirmar una cotización).
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;
  private from = '';

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  onModuleInit() {
    const apiKey = this.config.get('RESEND_API_KEY', { infer: true });
    this.from = this.config.get('RESEND_FROM', { infer: true });
    if (!apiKey) {
      this.logger.log('Resend disabled (RESEND_API_KEY vacío) — correos no se envían');
      return;
    }
    this.resend = new Resend(apiKey);
    this.logger.log(`Email (Resend) activo · from: ${this.from}`);
  }

  async sendFlightConfirmation(data: FlightConfirmationData): Promise<void> {
    if (!this.resend) return;
    if (!data.to) {
      this.logger.warn(`Vuelo #${data.folio}: cliente sin email, no se envía confirmación`);
      return;
    }
    try {
      const fecha = data.fechaVuelo
        ? new Date(data.fechaVuelo).toLocaleString('es-MX', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: 'America/Cancun',
          })
        : 'Por confirmar';
      const monto = `$${data.montoTotalUsd.toLocaleString('en-US')} USD`;

      const { error } = await this.resend.emails.send({
        from: this.from,
        to: data.to,
        subject: `Vuelo confirmado · ${data.origenIata} → ${data.destinoIata} (folio #${data.folio})`,
        html: this.buildHtml(data, fecha, monto),
        text: this.buildText(data, fecha, monto),
      });
      if (error) {
        this.logger.error(`Resend error vuelo #${data.folio}: ${JSON.stringify(error)}`);
        return;
      }
      this.logger.log(`Confirmación enviada a ${data.to} (vuelo #${data.folio})`);
    } catch (err) {
      this.logger.error(
        `sendFlightConfirmation(#${data.folio}) falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sendPilotAssignment(data: PilotAssignmentData): Promise<void> {
    if (!this.resend) return;
    if (!data.to) {
      this.logger.warn(`Vuelo #${data.folio}: piloto sin email, no se envía aviso de asignación`);
      return;
    }
    try {
      const fecha = data.fechaVuelo
        ? new Date(data.fechaVuelo).toLocaleString('es-MX', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: 'America/Cancun',
          })
        : 'Por confirmar';

      const { error } = await this.resend.emails.send({
        from: this.from,
        to: data.to,
        subject: `Vuelo asignado · ${data.origenIata} → ${data.destinoIata} (folio #${data.folio})`,
        html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d1d1d">
  <div style="background:#102a43;padding:24px;border-radius:12px 12px 0 0">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">VuelaTour</h1>
    <p style="color:#9fb3c8;margin:4px 0 0;font-size:13px">Aero Charter Cancún</p>
  </div>
  <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;padding:24px">
    <p style="font-size:15px">Hola <strong>${data.pilotoNombre}</strong>,</p>
    <p style="font-size:15px">Se te asignó un nuevo vuelo.</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:-1px;margin:16px 0;color:#102a43">
      ${data.origenIata} → ${data.destinoIata}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:8px 0;color:#6b7280">Folio</td><td style="padding:8px 0;text-align:right;font-weight:600">#${data.folio}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Pasajeros</td><td style="padding:8px 0;text-align:right;font-weight:600">${data.pasajeros}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Fecha</td><td style="padding:8px 0;text-align:right;font-weight:600">${fecha}</td></tr>
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
          `Ruta: ${data.origenIata} → ${data.destinoIata}`,
          `Pasajeros: ${data.pasajeros}`,
          `Fecha: ${fecha}`,
          '',
          'Revisa los detalles en la app VuelaTour Pilotos.',
        ].join('\n'),
      });
      if (error) {
        this.logger.error(`Resend error (asignación) vuelo #${data.folio}: ${JSON.stringify(error)}`);
        return;
      }
      this.logger.log(`Aviso de asignación enviado a ${data.to} (vuelo #${data.folio})`);
    } catch (err) {
      this.logger.error(
        `sendPilotAssignment(#${data.folio}) falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private buildText(d: FlightConfirmationData, fecha: string, monto: string): string {
    return [
      `Hola ${d.clienteNombre},`,
      '',
      `Tu vuelo con VuelaTour quedó CONFIRMADO.`,
      '',
      `Folio: #${d.folio}`,
      `Ruta: ${d.origenIata} → ${d.destinoIata}`,
      `Pasajeros: ${d.pasajeros}`,
      `Fecha: ${fecha}`,
      `Monto total: ${monto}`,
      '',
      'Gracias por volar con VuelaTour — Aero Charter Cancún.',
    ].join('\n');
  }

  private buildHtml(d: FlightConfirmationData, fecha: string, monto: string): string {
    return `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d1d1d">
  <div style="background:#102a43;padding:24px;border-radius:12px 12px 0 0">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">VuelaTour</h1>
    <p style="color:#9fb3c8;margin:4px 0 0;font-size:13px">Aero Charter Cancún</p>
  </div>
  <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;padding:24px">
    <p style="font-size:15px">Hola <strong>${d.clienteNombre}</strong>,</p>
    <p style="font-size:15px">Tu vuelo quedó <strong style="color:#10b981">CONFIRMADO</strong>.</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:-1px;margin:16px 0;color:#102a43">
      ${d.origenIata} → ${d.destinoIata}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:8px 0;color:#6b7280">Folio</td><td style="padding:8px 0;text-align:right;font-weight:600">#${d.folio}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Pasajeros</td><td style="padding:8px 0;text-align:right;font-weight:600">${d.pasajeros}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Fecha</td><td style="padding:8px 0;text-align:right;font-weight:600">${fecha}</td></tr>
      <tr><td style="padding:12px 0;color:#6b7280;border-top:1px solid #e5e5e5">Monto total</td><td style="padding:12px 0;text-align:right;font-weight:800;font-size:18px;color:#dc2626;border-top:1px solid #e5e5e5">${monto}</td></tr>
    </table>
    <p style="font-size:13px;color:#6b7280;margin-top:24px">Gracias por volar con VuelaTour.</p>
  </div>
</div>`.trim();
  }
}
