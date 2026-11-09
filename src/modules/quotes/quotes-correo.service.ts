import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { hoyCancun } from '../../common/fecha-cancun.util';
import { fetchNombresUsuarios } from '../../common/registrado-por.util';
import {
  armarCorreoConfirmacion,
  type CorreoArmado,
} from '../notifications/correo-confirmacion.util';
import { EmailService } from '../notifications/email.service';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  EnviarCorreoConfirmacionDto,
  ListCorreosClienteQuery,
} from './dto/correo-cliente.dto';

/**
 * CORREO AL CLIENTE: MANUAL, CON VISTA PREVIA Y BITÁCORA (9-nov-2026, API
 * 0.0.133, invariante 128).
 *
 * Hasta el 0.0.132 `QuotesService.confirm` mandaba SOLO el correo «Vuelo
 * confirmado» al cliente (best-effort, sin registro). La oficina lo
 * descubrió por un correo que llegó sin que nadie lo pidiera (folio #538) y
 * pidió: «que se cancele el envío automático…, que solo hasta que ellos le
 * den en enviar de forma manual, solo si se requiere, y saber si se mandó o
 * no y con qué contenido».
 *
 * Reglas:
 * - NADA sale solo. El único camino que manda un correo a un cliente es
 *   `enviar()` (POST con un humano detrás).
 * - Lo que se ve en la vista previa es lo que se manda: los dos arman el
 *   contenido con `armarCorreoConfirmacion` (PURO).
 * - TODO intento queda en `correo_cliente` (ENVIADO o FALLIDO) con el
 *   asunto/HTML/texto EXACTOS, el destinatario, el remitente y quién lo
 *   mandó. La tabla no tiene FK al vuelo a propósito (bitácora: sobrevive a
 *   la baja del vuelo, patrón `vuelo_eliminado`).
 * - Antes de enviar se LEE la bitácora: si no se puede leer, no se envía
 *   (un envío sin registro es justo lo que el cliente rechazó).
 * - Reenviar exige `reenviar: true` (409 `CORREO_YA_ENVIADO` si no): un
 *   doble clic no le manda dos correos al cliente.
 */

export const TIPO_CORREO_CONFIRMACION = 'CONFIRMACION_VUELO';

/** Estados en los que «Tu vuelo quedó CONFIRMADO» es verdad. */
export const ESTADOS_CORREO_CONFIRMACION: ReadonlyArray<string> = [
  'CONFIRMADO',
  'RESERVA',
];

const ESTADO_LABEL: Record<string, string> = {
  SOLICITUD: 'Solicitud',
  COTIZADO: 'Cotizado',
  RESERVA: 'Reserva',
  CONFIRMADO: 'Confirmado',
  EN_VUELO: 'En vuelo',
  COMPLETADO: 'Completado',
  CANCELADO: 'Cancelado',
};

export type CodigoBloqueoCorreo =
  | 'SIN_CLIENTE'
  | 'ESTADO_NO_CONFIRMADO'
  | 'SIN_EMAIL'
  | 'CORREO_APAGADO';

const CORREO_COLS =
  'id, vuelo_id, folio, tipo, cliente_id, cliente_nombre, destinatario, remitente, asunto, html, texto, estado, error, enviado_por, created_at';

const VUELO_CORREO_COLS =
  'id, folio, estado, cliente_id, origen_iata, destino_iata, pasajeros, fecha_vuelo, monto_total_usd';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const LIMITE_CORREOS_DEFAULT = 200;
export const DIAS_CORREOS_DEFAULT = 90;

type Fila = Record<string, unknown>;

/** Texto de una columna (lo que no sea string ⇒ ''). */
const txt = (v: unknown): string => (typeof v === 'string' ? v : '');

export type CorreoCliente = Fila & { enviado_por_nombre: string | null };

/** Bloqueo del envío (PURO): el primero que aplique, o null si se puede. */
export function bloqueoCorreoConfirmacion(p: {
  clienteId: string | null;
  clienteNombre: string | null;
  email: string | null;
  estado: string | null;
  correoActivo: boolean;
}): { codigo: CodigoBloqueoCorreo; motivo: string } | null {
  if (!p.clienteId) {
    return {
      codigo: 'SIN_CLIENTE',
      motivo:
        'Este vuelo no tiene cliente asignado: no hay a quién enviarle el correo.',
    };
  }
  if (!p.estado || !ESTADOS_CORREO_CONFIRMACION.includes(p.estado)) {
    const hoy = p.estado ? (ESTADO_LABEL[p.estado] ?? p.estado) : 'sin estado';
    return {
      codigo: 'ESTADO_NO_CONFIRMADO',
      motivo: `El correo dice «Tu vuelo quedó CONFIRMADO»: solo se puede enviar con el vuelo Confirmado o en Reserva (hoy está: ${hoy}).`,
    };
  }
  const email = (p.email ?? '').trim();
  if (!email || !EMAIL_RE.test(email)) {
    const quien = p.clienteNombre?.trim() || 'El cliente';
    return {
      codigo: 'SIN_EMAIL',
      motivo: email
        ? `El correo capturado de ${quien} («${email}») no es válido: corrígelo en Clientes y vuelve a intentar.`
        : `${quien} no tiene correo capturado: agrégalo en Clientes y vuelve a intentar.`,
    };
  }
  if (!p.correoActivo) {
    return {
      codigo: 'CORREO_APAGADO',
      motivo:
        'El envío de correos está apagado en el servidor: avisa a sistemas.',
    };
  }
  return null;
}

@Injectable()
export class QuotesCorreoService {
  private readonly logger = new Logger(QuotesCorreoService.name);
  /** Envíos EN CURSO por vuelo (1 réplica en Railway: basta en memoria). */
  private readonly enCurso = new Set<string>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly email: EmailService,
  ) {}

  private async contexto(vueloId: string): Promise<{
    vuelo: Fila;
    clienteNombre: string | null;
    destinatario: string | null;
    armado: CorreoArmado;
    bloqueo: { codigo: CodigoBloqueoCorreo; motivo: string } | null;
  }> {
    const { data: vuelo, error } = await this.supabase.service
      .from('vuelo')
      .select(VUELO_CORREO_COLS)
      .eq('id', vueloId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!vuelo) {
      throw new NotFoundException({
        message: `Vuelo ${vueloId} not found`,
        error: 'VUELO_NO_EXISTE',
      });
    }
    const v = vuelo as Fila;
    const clienteId = typeof v.cliente_id === 'string' ? v.cliente_id : null;
    let clienteNombre: string | null = null;
    let email: string | null = null;
    if (clienteId) {
      const { data: cliente, error: cErr } = await this.supabase.service
        .from('cliente')
        .select('id, nombre, email')
        .eq('id', clienteId)
        .maybeSingle();
      if (cErr) throw new Error(cErr.message);
      const c = (cliente ?? {}) as Fila;
      clienteNombre =
        typeof c.nombre === 'string' && c.nombre.trim()
          ? c.nombre.trim()
          : null;
      email =
        typeof c.email === 'string' && c.email.trim() ? c.email.trim() : null;
    }
    const armado = armarCorreoConfirmacion({
      clienteNombre: clienteNombre ?? 'Cliente',
      folio: Number(v.folio ?? 0),
      origenIata: txt(v.origen_iata),
      destinoIata: txt(v.destino_iata),
      pasajeros: Number(v.pasajeros ?? 0),
      fechaVuelo: (v.fecha_vuelo as string | null) ?? null,
      montoTotalUsd: Number(v.monto_total_usd ?? 0),
    });
    const bloqueo = bloqueoCorreoConfirmacion({
      clienteId,
      clienteNombre,
      email,
      estado: typeof v.estado === 'string' ? v.estado : null,
      correoActivo: this.email.enabled,
    });
    return { vuelo: v, clienteNombre, destinatario: email, armado, bloqueo };
  }

  private async conNombres(filas: Fila[]): Promise<CorreoCliente[]> {
    const nombres = await fetchNombresUsuarios(
      this.supabase.service,
      filas.map((f) =>
        typeof f.enviado_por === 'string' ? f.enviado_por : null,
      ),
    );
    return filas.map((f) => ({
      ...f,
      enviado_por_nombre:
        (typeof f.enviado_por === 'string' && nombres.get(f.enviado_por)) ||
        null,
    }));
  }

  /** Bitácora del vuelo, más reciente primero. LANZA si no se puede leer. */
  private async leerBitacora(vueloId: string): Promise<Fila[]> {
    const { data, error } = await this.supabase.service
      .from('correo_cliente')
      .select(CORREO_COLS)
      .eq('vuelo_id', vueloId)
      .order('created_at', { ascending: false });
    if (error) {
      throw new ServiceUnavailableException({
        message:
          'No se pudo leer el registro de correos enviados. No se envió nada; intenta de nuevo en un momento.',
        error: 'BITACORA_CORREOS_NO_DISPONIBLE',
        details: { detalle: error.message },
      });
    }
    return data ?? [];
  }

  private ultimoEnviado(correos: CorreoCliente[]) {
    const u = correos.find((c) => c.estado === 'ENVIADO');
    if (!u) return null;
    return {
      created_at: u.created_at as string,
      enviado_por_nombre: u.enviado_por_nombre,
      destinatario: txt(u.destinatario),
    };
  }

  /** `GET /v1/quotes/:id/correos`. */
  async historial(vueloId: string): Promise<{ correos: CorreoCliente[] }> {
    return { correos: await this.conNombres(await this.leerBitacora(vueloId)) };
  }

  /** `GET /v1/quotes/:id/correo-confirmacion`: lo que se mandaría. No envía. */
  async vistaPrevia(vueloId: string) {
    const ctx = await this.contexto(vueloId);
    const correos = await this.conNombres(await this.leerBitacora(vueloId));
    return {
      puede_enviar: ctx.bloqueo === null,
      codigo: ctx.bloqueo?.codigo ?? null,
      motivo: ctx.bloqueo?.motivo ?? null,
      destinatario: ctx.destinatario,
      remitente: this.email.remitente || null,
      cliente_nombre: ctx.clienteNombre,
      asunto: ctx.armado.asunto,
      html: ctx.armado.html,
      texto: ctx.armado.texto,
      enviados: correos.filter((c) => c.estado === 'ENVIADO').length,
      ultimo_envio: this.ultimoEnviado(correos),
    };
  }

  /** `POST /v1/quotes/:id/correo-confirmacion`: el ÚNICO envío a un cliente. */
  async enviar(
    vueloId: string,
    userId: string,
    dto: EnviarCorreoConfirmacionDto,
  ): Promise<{
    enviado: boolean;
    mensaje: string;
    correo: CorreoCliente | null;
  }> {
    const ctx = await this.contexto(vueloId);
    if (ctx.bloqueo || !ctx.destinatario) {
      throw new ConflictException({
        message: ctx.bloqueo?.motivo ?? 'No se puede enviar el correo.',
        error: 'CORREO_NO_ENVIABLE',
        details: { codigo: ctx.bloqueo?.codigo ?? null },
      });
    }
    if (this.enCurso.has(vueloId)) {
      throw new ConflictException({
        message:
          'Ya se está enviando el correo de este vuelo: espera un momento y revisa el registro.',
        error: 'CORREO_EN_PROCESO',
      });
    }
    this.enCurso.add(vueloId);
    try {
      // La bitácora se LEE antes de enviar: sin registro no hay envío.
      const previos = await this.conNombres(await this.leerBitacora(vueloId));
      const ultimo = this.ultimoEnviado(previos);
      if (ultimo && dto.reenviar !== true) {
        throw new ConflictException({
          message: `Este correo ya se le envió al cliente (${ultimo.destinatario}). Confirma si quieres enviarlo otra vez.`,
          error: 'CORREO_YA_ENVIADO',
          details: { ultimo_envio: ultimo },
        });
      }
      const to = ctx.destinatario;
      const r = await this.email.enviar({
        to,
        asunto: ctx.armado.asunto,
        html: ctx.armado.html,
        texto: ctx.armado.texto,
      });
      const { data, error } = await this.supabase.service
        .from('correo_cliente')
        .insert({
          vuelo_id: vueloId,
          folio: ctx.vuelo.folio ?? null,
          tipo: TIPO_CORREO_CONFIRMACION,
          cliente_id: ctx.vuelo.cliente_id ?? null,
          cliente_nombre: ctx.clienteNombre,
          destinatario: to,
          remitente: this.email.remitente || null,
          asunto: ctx.armado.asunto,
          html: ctx.armado.html,
          texto: ctx.armado.texto,
          estado: r.ok ? 'ENVIADO' : 'FALLIDO',
          error: r.ok ? null : (r.error ?? 'Error desconocido').slice(0, 1000),
          proveedor_id: r.id,
          enviado_por: userId,
        })
        .select(CORREO_COLS)
        .maybeSingle();
      let correo: CorreoCliente | null = null;
      let sinRegistro = '';
      if (error || !data) {
        this.logger.error(
          `Vuelo #${String(ctx.vuelo.folio)}: el correo ${r.ok ? 'SÍ se envió' : 'falló'} pero no se pudo registrar en correo_cliente: ${error?.message ?? 'sin fila'}`,
        );
        sinRegistro =
          ' OJO: no se pudo guardar en el registro de correos; avisa a sistemas.';
      } else {
        [correo] = await this.conNombres([data]);
      }
      const mensaje = r.ok
        ? `Correo enviado a ${to}.${sinRegistro}`
        : `No se pudo enviar el correo a ${to}: ${r.error ?? 'error desconocido'}. El cliente no recibió nada; puedes intentarlo de nuevo.${sinRegistro}`;
      return { enviado: r.ok, mensaje, correo };
    } finally {
      this.enCurso.delete(vueloId);
    }
  }

  /** `GET /v1/quotes/correos`: todos los correos a clientes de un periodo. */
  async listar(q: ListCorreosClienteQuery) {
    const hasta = q.hasta ?? hoyCancun();
    const desde =
      q.desde ??
      hoyCancun(
        new Date(
          new Date(`${hasta}T12:00:00-05:00`).getTime() -
            DIAS_CORREOS_DEFAULT * 86_400_000,
        ),
      );
    const limite = q.limite ?? LIMITE_CORREOS_DEFAULT;
    // Cortes en hora Cancún (invariante 4).
    const { data, error } = await this.supabase.service
      .from('correo_cliente')
      .select(CORREO_COLS)
      .gte('created_at', `${desde}T00:00:00-05:00`)
      .lte('created_at', `${hasta}T23:59:59.999-05:00`)
      .order('created_at', { ascending: false })
      .limit(limite + 1);
    if (error) {
      throw new ServiceUnavailableException({
        message:
          'No se pudo leer el registro de correos enviados; intenta de nuevo en un momento.',
        error: 'BITACORA_CORREOS_NO_DISPONIBLE',
        details: { detalle: error.message },
      });
    }
    const filas = (data ?? []) as Fila[];
    const truncado = filas.length > limite;
    return {
      correos: await this.conNombres(truncado ? filas.slice(0, limite) : filas),
      truncado,
      desde,
      hasta,
    };
  }
}
