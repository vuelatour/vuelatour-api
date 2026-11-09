jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { EmailService } from '../notifications/email.service';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  bloqueoCorreoConfirmacion,
  QuotesCorreoService,
} from './quotes-correo.service';

/**
 * CORREO AL CLIENTE: MANUAL, CON VISTA PREVIA Y BITÁCORA (9-nov-2026, API
 * 0.0.133, invariante 128). Pedido de la oficina: «que solo hasta que ellos
 * le den en enviar de forma manual… y saber si se mandó o no y con qué
 * contenido». Supabase y Resend se simulan: se prueba el CONTRATO.
 */
const VUELO = 'vvvvvvvv-0000-4000-8000-000000000538';
const CLIENTE = 'cccccccc-0000-4000-8000-000000000001';
const ITZEL = 'uuuuuuuu-0000-4000-8000-0000000000it';

type Row = Record<string, unknown>;

function vuelo(extra: Row = {}): Row {
  return {
    id: VUELO,
    folio: 538,
    estado: 'CONFIRMADO',
    cliente_id: CLIENTE,
    origen_iata: 'CUN',
    destino_iata: 'CUN',
    pasajeros: 3,
    fecha_vuelo: '2027-01-03T13:00:00+00:00',
    monto_total_usd: 2488.2,
    ...extra,
  };
}

function armar(
  opts: {
    vuelo?: Row | null;
    cliente?: Row | null;
    bitacora?: Row[];
    errorBitacora?: boolean;
    errorInsert?: boolean;
    resend?: { ok: boolean; id: string | null; error: string | null };
    correoActivo?: boolean;
  } = {},
) {
  const bitacora: Row[] = [...(opts.bitacora ?? [])];
  const inserts: Row[] = [];
  const filtros: Array<{ tabla: string; m: string; args: unknown[] }> = [];
  const supabase = {
    service: {
      from(tabla: string) {
        let insertado: Row | null = null;
        const q: Record<string, unknown> = {};
        for (const m of [
          'select',
          'eq',
          'order',
          'in',
          'gte',
          'lte',
          'limit',
        ]) {
          q[m] = (...args: unknown[]) => {
            filtros.push({ tabla, m, args });
            return q;
          };
        }
        q.insert = (fila: Row) => {
          insertado = {
            id: `correo-${inserts.length + 1}`,
            created_at: '2026-11-09T21:00:00+00:00',
            ...fila,
          };
          inserts.push(fila);
          return q;
        };
        const lista = () => {
          if (tabla === 'correo_cliente') {
            return opts.errorBitacora
              ? { data: null, error: { message: 'relation does not exist' } }
              : { data: bitacora, error: null };
          }
          if (tabla === 'usuario') {
            return {
              data: [{ id: ITZEL, nombre: 'Itzel Villalobos' }],
              error: null,
            };
          }
          return { data: [], error: null };
        };
        q.maybeSingle = () => {
          if (tabla === 'vuelo') {
            return Promise.resolve({
              data: opts.vuelo === undefined ? vuelo() : opts.vuelo,
              error: null,
            });
          }
          if (tabla === 'cliente') {
            return Promise.resolve({
              data:
                opts.cliente === undefined
                  ? { id: CLIENTE, nombre: 'Palma', email: 'palma@example.com' }
                  : opts.cliente,
              error: null,
            });
          }
          if (tabla === 'correo_cliente' && insertado) {
            if (opts.errorInsert) {
              return Promise.resolve({
                data: null,
                error: { message: 'boom' },
              });
            }
            bitacora.unshift(insertado);
            return Promise.resolve({ data: insertado, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        };
        q.then = (
          res: (v: unknown) => unknown,
          rej?: (e: unknown) => unknown,
        ) => Promise.resolve(lista()).then(res, rej);
        return q;
      },
    },
  } as unknown as SupabaseService;
  const enviar = jest
    .fn()
    .mockResolvedValue(opts.resend ?? { ok: true, id: 're_123', error: null });
  const email = {
    enabled: opts.correoActivo ?? true,
    remitente: 'Vuelatour Notificaciones <notificaciones@notify.vuelatour.com>',
    enviar,
  } as unknown as EmailService;
  const service = new QuotesCorreoService(supabase, email);
  return { service, enviar, inserts, filtros };
}

const enviado = (extra: Row = {}): Row => ({
  id: 'correo-0',
  vuelo_id: VUELO,
  folio: 538,
  tipo: 'CONFIRMACION_VUELO',
  destinatario: 'palma@example.com',
  asunto: 'Vuelo confirmado · CUN → CUN (folio #538)',
  html: '<p>x</p>',
  estado: 'ENVIADO',
  error: null,
  enviado_por: ITZEL,
  created_at: '2026-11-09T15:29:00+00:00',
  ...extra,
});

describe('bloqueoCorreoConfirmacion (PURO)', () => {
  const base = {
    clienteId: CLIENTE,
    clienteNombre: 'Palma',
    email: 'palma@example.com',
    estado: 'CONFIRMADO',
    correoActivo: true,
  };
  it('CONFIRMADO o RESERVA con cliente y correo válido ⇒ se puede', () => {
    expect(bloqueoCorreoConfirmacion(base)).toBeNull();
    expect(
      bloqueoCorreoConfirmacion({ ...base, estado: 'RESERVA' }),
    ).toBeNull();
  });
  it('cada bloqueo con su código y un motivo en es-MX', () => {
    expect(
      bloqueoCorreoConfirmacion({ ...base, clienteId: null })?.codigo,
    ).toBe('SIN_CLIENTE');
    for (const estado of [
      'COTIZADO',
      'SOLICITUD',
      'EN_VUELO',
      'COMPLETADO',
      'CANCELADO',
    ]) {
      expect(bloqueoCorreoConfirmacion({ ...base, estado })?.codigo).toBe(
        'ESTADO_NO_CONFIRMADO',
      );
    }
    expect(
      bloqueoCorreoConfirmacion({ ...base, estado: 'COTIZADO' })?.motivo,
    ).toContain('hoy está: Cotizado');
    const sin = bloqueoCorreoConfirmacion({ ...base, email: null });
    expect(sin?.codigo).toBe('SIN_EMAIL');
    expect(sin?.motivo).toContain('Palma no tiene correo capturado');
    expect(
      bloqueoCorreoConfirmacion({ ...base, email: 'no-es-correo' })?.motivo,
    ).toContain('no es válido');
    expect(
      bloqueoCorreoConfirmacion({ ...base, correoActivo: false })?.codigo,
    ).toBe('CORREO_APAGADO');
  });
});

describe('QuotesCorreoService.vistaPrevia — no envía nada', () => {
  it('trae destinatario, remitente y el contenido; sin envíos previos', async () => {
    const w = armar();
    const p = await w.service.vistaPrevia(VUELO);
    expect(p).toMatchObject({
      puede_enviar: true,
      codigo: null,
      motivo: null,
      destinatario: 'palma@example.com',
      remitente:
        'Vuelatour Notificaciones <notificaciones@notify.vuelatour.com>',
      cliente_nombre: 'Palma',
      asunto: 'Vuelo confirmado · CUN → CUN (folio #538)',
      enviados: 0,
      ultimo_envio: null,
    });
    expect(p.html).toContain('$2,488.20 USD');
    expect(w.enviar).not.toHaveBeenCalled();
    expect(w.inserts).toHaveLength(0);
  });

  it('cliente sin correo ⇒ puede_enviar false con motivo, y aun así se ve el contenido', async () => {
    const w = armar({ cliente: { id: CLIENTE, nombre: 'Palma', email: null } });
    const p = await w.service.vistaPrevia(VUELO);
    expect(p.puede_enviar).toBe(false);
    expect(p.codigo).toBe('SIN_EMAIL');
    expect(p.destinatario).toBeNull();
    expect(p.asunto).toContain('folio #538');
  });

  it('con un envío previo: enviados y ultimo_envio con el NOMBRE de quien lo mandó', async () => {
    const w = armar({
      bitacora: [enviado(), enviado({ id: 'f', estado: 'FALLIDO' })],
    });
    const p = await w.service.vistaPrevia(VUELO);
    expect(p.enviados).toBe(1);
    expect(p.ultimo_envio).toEqual({
      created_at: '2026-11-09T15:29:00+00:00',
      enviado_por_nombre: 'Itzel Villalobos',
      destinatario: 'palma@example.com',
    });
  });
});

describe('QuotesCorreoService.enviar — el ÚNICO envío a un cliente', () => {
  it('envía y REGISTRA el contenido exacto, a quién, desde dónde y quién', async () => {
    const w = armar();
    const previa = await w.service.vistaPrevia(VUELO);
    const r = await w.service.enviar(VUELO, ITZEL, {});
    expect(r.enviado).toBe(true);
    expect(r.mensaje).toBe('Correo enviado a palma@example.com.');
    expect(w.enviar).toHaveBeenCalledTimes(1);
    // Lo que se vio en la vista previa es lo que se mandó y lo que se guardó.
    expect(w.enviar).toHaveBeenCalledWith({
      to: 'palma@example.com',
      asunto: previa.asunto,
      html: previa.html,
      texto: previa.texto,
    });
    expect(w.inserts).toHaveLength(1);
    expect(w.inserts[0]).toMatchObject({
      vuelo_id: VUELO,
      folio: 538,
      tipo: 'CONFIRMACION_VUELO',
      cliente_id: CLIENTE,
      cliente_nombre: 'Palma',
      destinatario: 'palma@example.com',
      remitente:
        'Vuelatour Notificaciones <notificaciones@notify.vuelatour.com>',
      asunto: previa.asunto,
      html: previa.html,
      texto: previa.texto,
      estado: 'ENVIADO',
      error: null,
      proveedor_id: 're_123',
      enviado_por: ITZEL,
    });
    expect(r.correo).toMatchObject({
      estado: 'ENVIADO',
      enviado_por_nombre: 'Itzel Villalobos',
    });
  });

  it('si Resend falla: 200 con enviado:false y queda FALLIDO con su error', async () => {
    const w = armar({
      resend: { ok: false, id: null, error: 'Domain is not verified' },
    });
    const r = await w.service.enviar(VUELO, ITZEL, {});
    expect(r.enviado).toBe(false);
    expect(r.mensaje).toContain(
      'No se pudo enviar el correo a palma@example.com',
    );
    expect(r.mensaje).toContain('Domain is not verified');
    expect(w.inserts[0]).toMatchObject({
      estado: 'FALLIDO',
      error: 'Domain is not verified',
      proveedor_id: null,
    });
  });

  it('ya enviado y sin reenviar ⇒ 409 CORREO_YA_ENVIADO, sin enviar ni escribir', async () => {
    const w = armar({ bitacora: [enviado()] });
    const err = await w.service
      .enviar(VUELO, ITZEL, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error: 'CORREO_YA_ENVIADO',
      details: {
        ultimo_envio: {
          destinatario: 'palma@example.com',
          enviado_por_nombre: 'Itzel Villalobos',
        },
      },
    });
    expect(w.enviar).not.toHaveBeenCalled();
    expect(w.inserts).toHaveLength(0);
  });

  it('con reenviar:true sí sale; un FALLIDO previo no pide confirmación', async () => {
    const w = armar({ bitacora: [enviado()] });
    expect(
      (await w.service.enviar(VUELO, ITZEL, { reenviar: true })).enviado,
    ).toBe(true);
    const f = armar({ bitacora: [enviado({ estado: 'FALLIDO' })] });
    expect((await f.service.enviar(VUELO, ITZEL, {})).enviado).toBe(true);
  });

  it('no enviable (COTIZADO, sin correo, correo apagado) ⇒ 409 CORREO_NO_ENVIABLE con su código', async () => {
    const casos: Array<[Parameters<typeof armar>[0], string]> = [
      [{ vuelo: vuelo({ estado: 'COTIZADO' }) }, 'ESTADO_NO_CONFIRMADO'],
      [{ cliente: { id: CLIENTE, nombre: 'Palma', email: '' } }, 'SIN_EMAIL'],
      [{ vuelo: vuelo({ cliente_id: null }) }, 'SIN_CLIENTE'],
      [{ correoActivo: false }, 'CORREO_APAGADO'],
    ];
    for (const [opts, codigo] of casos) {
      const w = armar(opts);
      const err = await w.service
        .enviar(VUELO, ITZEL, {})
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        error: 'CORREO_NO_ENVIABLE',
        details: { codigo },
      });
      expect(w.enviar).not.toHaveBeenCalled();
    }
  });

  it('si la bitácora no se puede LEER, no se envía nada (503)', async () => {
    const w = armar({ errorBitacora: true });
    await expect(w.service.enviar(VUELO, ITZEL, {})).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(w.enviar).not.toHaveBeenCalled();
  });

  it('si el correo salió pero no se pudo registrar, lo DICE (correo null + aviso)', async () => {
    const w = armar({ errorInsert: true });
    const r = await w.service.enviar(VUELO, ITZEL, {});
    expect(r.enviado).toBe(true);
    expect(r.correo).toBeNull();
    expect(r.mensaje).toContain('no se pudo guardar en el registro de correos');
  });

  it('dos envíos simultáneos del mismo vuelo: el segundo ⇒ 409 CORREO_EN_PROCESO', async () => {
    const w = armar();
    let soltar: (v: unknown) => void = () => undefined;
    w.enviar.mockImplementationOnce(
      () =>
        new Promise((res) => {
          soltar = () => res({ ok: true, id: 're_1', error: null });
        }),
    );
    const primero = w.service.enviar(VUELO, ITZEL, {});
    // Deja que el primero llegue hasta Resend.
    await new Promise((r) => setImmediate(r));
    const err = await w.service
      .enviar(VUELO, ITZEL, {})
      .catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error: 'CORREO_EN_PROCESO',
    });
    soltar(null);
    expect((await primero).enviado).toBe(true);
    expect(w.enviar).toHaveBeenCalledTimes(1);
    // Liberado: un reenvío posterior ya no choca con el candado.
    expect(
      (await w.service.enviar(VUELO, ITZEL, { reenviar: true })).enviado,
    ).toBe(true);
  });
});

describe('QuotesCorreoService.historial / listar', () => {
  it('historial del vuelo con enviado_por_nombre', async () => {
    const w = armar({ bitacora: [enviado()] });
    const { correos } = await w.service.historial(VUELO);
    expect(correos).toHaveLength(1);
    expect(correos[0].enviado_por_nombre).toBe('Itzel Villalobos');
  });

  it('listar corta el periodo en HORA CANCÚN y avisa si trunca', async () => {
    const w = armar({
      bitacora: [enviado(), enviado({ id: 'b' }), enviado({ id: 'c' })],
    });
    const r = await w.service.listar({
      desde: '2026-11-01',
      hasta: '2026-11-09',
      limite: 2,
    });
    expect(r.truncado).toBe(true);
    expect(r.correos).toHaveLength(2);
    expect(r).toMatchObject({ desde: '2026-11-01', hasta: '2026-11-09' });
    const de = (m: string) =>
      w.filtros.find((f) => f.tabla === 'correo_cliente' && f.m === m)?.args;
    expect(de('gte')).toEqual(['created_at', '2026-11-01T00:00:00-05:00']);
    expect(de('lte')).toEqual(['created_at', '2026-11-09T23:59:59.999-05:00']);
    expect(de('limit')).toEqual([3]);
  });

  it('sin fechas: últimos 90 días hasta hoy', async () => {
    const w = armar();
    const r = await w.service.listar({});
    expect(r.truncado).toBe(false);
    const dias =
      (new Date(`${r.hasta}T12:00:00Z`).getTime() -
        new Date(`${r.desde}T12:00:00Z`).getTime()) /
      86_400_000;
    expect(dias).toBe(90);
  });
});
