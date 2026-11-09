/**
 * CONTENIDO del correo «Vuelo confirmado» que se le manda al CLIENTE. PURO
 * (sin Resend ni BD) para que la VISTA PREVIA del panel y el envío real
 * armen EXACTAMENTE el mismo asunto/HTML/texto, y para que la bitácora
 * `correo_cliente` guarde lo que de verdad salió.
 *
 * 9-nov-2026 (API 0.0.133, invariante 128): este correo salía SOLO al
 * confirmar una cotización; la oficina pidió que se mande únicamente cuando
 * alguien pulse «Enviar» y poder ver «si se mandó o no y con qué contenido».
 *
 * Datos del cliente que usa: su NOMBRE y su CORREO (`cliente.nombre`,
 * `cliente.email`). Del vuelo: folio, origen → destino, pasajeros, fecha de
 * salida (hora Cancún) y el total en USD. Nada más.
 */
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

export interface CorreoArmado {
  asunto: string;
  html: string;
  texto: string;
}

/** Texto seguro dentro del HTML (un nombre con «<» o «&» no rompe el correo). */
export function escaparHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** «3 de enero de 2027, 8:00 a.m. (hora de Cancún)» o «Por confirmar». */
export function fechaCorreoCliente(fechaVuelo: string | null): string {
  if (!fechaVuelo) return 'Por confirmar';
  const d = new Date(fechaVuelo);
  if (Number.isNaN(d.getTime())) return 'Por confirmar';
  return `${d.toLocaleString('es-MX', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Cancun',
  })} (hora de Cancún)`;
}

/**
 * «$2,488.20 USD»: SIEMPRE dos decimales (el correo del folio #538 decía
 * «$2,488.2 USD» porque `toLocaleString` a secas recorta el cero).
 */
export function montoCorreoCliente(montoTotalUsd: number): string {
  const n = Number.isFinite(montoTotalUsd) ? montoTotalUsd : 0;
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USD`;
}

export function armarCorreoConfirmacion(
  d: Omit<FlightConfirmationData, 'to'>,
): CorreoArmado {
  const fecha = fechaCorreoCliente(d.fechaVuelo);
  const monto = montoCorreoCliente(d.montoTotalUsd);
  const nombre = d.clienteNombre.trim() || 'Cliente';
  const ruta = `${d.origenIata} → ${d.destinoIata}`;
  const asunto = `Vuelo confirmado · ${ruta} (folio #${d.folio})`;
  const texto = [
    `Hola ${nombre},`,
    '',
    `Tu vuelo con VuelaTour quedó CONFIRMADO.`,
    '',
    `Folio: #${d.folio}`,
    `Ruta: ${ruta}`,
    `Pasajeros: ${d.pasajeros}`,
    `Fecha: ${fecha}`,
    `Monto total: ${monto}`,
    '',
    'Gracias por volar con VuelaTour — Aero Charter Cancún.',
  ].join('\n');
  const html = `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d1d1d">
  <div style="background:#102a43;padding:24px;border-radius:12px 12px 0 0">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">VuelaTour</h1>
    <p style="color:#9fb3c8;margin:4px 0 0;font-size:13px">Aero Charter Cancún</p>
  </div>
  <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;padding:24px">
    <p style="font-size:15px">Hola <strong>${escaparHtml(nombre)}</strong>,</p>
    <p style="font-size:15px">Tu vuelo quedó <strong style="color:#10b981">CONFIRMADO</strong>.</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:-1px;margin:16px 0;color:#102a43">
      ${escaparHtml(ruta)}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:8px 0;color:#6b7280">Folio</td><td style="padding:8px 0;text-align:right;font-weight:600">#${escaparHtml(String(d.folio))}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Pasajeros</td><td style="padding:8px 0;text-align:right;font-weight:600">${d.pasajeros}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Fecha</td><td style="padding:8px 0;text-align:right;font-weight:600">${escaparHtml(fecha)}</td></tr>
      <tr><td style="padding:12px 0;color:#6b7280;border-top:1px solid #e5e5e5">Monto total</td><td style="padding:12px 0;text-align:right;font-weight:800;font-size:18px;color:#dc2626;border-top:1px solid #e5e5e5">${monto}</td></tr>
    </table>
    <p style="font-size:13px;color:#6b7280;margin-top:24px">Gracias por volar con VuelaTour.</p>
  </div>
</div>`.trim();
  return { asunto, html, texto };
}
