// La cadena real de FlightsService/notifications arrastra googleapis y
// `jose` (ESM): se stubbean; aquí se prueba el CONTRATO del registro.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));

import { HttpException, Logger } from '@nestjs/common';
import { FacturasEmitidasService } from './facturas-emitidas.service';
import { FacturaSolicitudService } from '../flights/factura-solicitud.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { FlightsService } from '../flights/flights.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';

/**
 * FACTURAS EMITIDAS (24-sep-2026) — servicio contra una BD EN MEMORIA que
 * interpreta el subconjunto de PostgREST que usa el módulo (filtros, `or`,
 * embeds `factura:`/`vuelo:`/`cliente:`/`grupo:`, índices únicos).
 * Se congela: 409 con la existente, rollback de storage, archivos que NUNCA
 * se borran, 422 del XML, 503 sin migración, FACTURADO por CAS, aviso a
 * quien pidió, VUELO_SIGUE_FACTURADO y consultas `.in` en lotes de 200.
 */

type Fila = Record<string, unknown>;

interface Opciones {
  migracion?: boolean;
  /** Falla la operación `op` sobre `tabla` (una vez). */
  fallar?: Array<{ tabla: string; op: 'insert' | 'update' | 'delete' }>;
  /**
   * false = SIN la migración 20261016000001 (facturas por cobro): nombrar
   * `cobro_vuelo.factura_emitida_id` responde 42703 (la sonda se apaga).
   */
  cobroFactura?: boolean;
}

/** Texto comparable de un valor desconocido de la BD en memoria. */
const txt = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : v == null
        ? ''
        : JSON.stringify(v);

const USUARIO = 'aaaaaaaa-0000-4000-8000-0000000000u1';
const ITZI = 'aaaaaaaa-0000-4000-8000-0000000000u2';

function fakeDb(datos: Record<string, Fila[]>, opts: Opciones = {}) {
  const tablas: Record<string, Fila[]> = {};
  for (const [k, v] of Object.entries(datos))
    tablas[k] = v.map((f) => ({ ...f }));
  const tabla = (t: string) => (tablas[t] ??= []);
  const fallar = [...(opts.fallar ?? [])];
  const maxIn = { valor: 0 };
  const subidos: string[] = [];
  const borrados: string[][] = [];
  const firmados: string[] = [];
  let seq = 0;

  const valorDe = (fila: Fila, col: string): unknown => {
    if (col.includes('.')) {
      const [rel, c] = col.split('.');
      const r = fila[rel];
      const obj: unknown = Array.isArray(r) ? (r as unknown[])[0] : r;
      return obj ? (obj as Fila)[c] : undefined;
    }
    return fila[col];
  };
  const ilike = (v: unknown, pat: string) => {
    const re = new RegExp(
      '^' +
        pat
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/%/g, '.*')
          .replace(/_/g, '.') +
        '$',
      'i',
    );
    return typeof v === 'string' && re.test(v);
  };
  const cond = (fila: Fila, expr: string): boolean => {
    const [col, op, ...resto] = expr.split('.');
    const val = resto.join('.');
    const v = valorDe(fila, col);
    if (op === 'eq') return String(v) === val;
    if (op === 'ilike') return ilike(v, val);
    if (op === 'is') return val === 'null' ? v == null : String(v) === val;
    return false;
  };

  const embeds = (t: string, select: string, fila: Fila): Fila => {
    const out = { ...fila };
    if (t === 'factura_emitida_vuelo') {
      if (select.includes('factura:')) {
        out.factura =
          tabla('factura_emitida').find((f) => f.id === fila.factura_id) ??
          null;
      }
      if (select.includes('vuelo:')) {
        out.vuelo = tabla('vuelo').find((v) => v.id === fila.vuelo_id) ?? null;
      }
    }
    if (t === 'vuelo') {
      if (select.includes('cliente:')) {
        out.cliente =
          tabla('cliente').find((c) => c.id === fila.cliente_id) ?? null;
      }
      if (select.includes('grupo:')) {
        out.grupo =
          tabla('vuelo_grupo').find((g) => g.id === fila.grupo_id) ?? null;
      }
    }
    return out;
  };

  const from = (t: string) => {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let select = '*';
    let payload: unknown = null;
    let devolver = false;
    const filtros: Array<(f: Fila) => boolean> = [];
    let rango: [number, number] | null = null;
    let limite: number | null = null;
    let inner = false;
    /** La consulta nombra `cobro_vuelo.factura_emitida_id` (sonda apagada ⇒ 42703). */
    let nombraFactura = false;
    const marcar = (col: string) => {
      if (t === 'cobro_vuelo' && col.includes('factura_emitida_id')) {
        nombraFactura = true;
      }
    };

    /** Trigger A de 20261016000001 (espejo mínimo): la factura VIGENTE ligada al vuelo. */
    const triggerA = (fila: Fila, facturaId: unknown) => {
      if (typeof facturaId !== 'string' || !facturaId) return null;
      if (Number(fila.monto) <= 0) return 'REEMBOLSO_SIN_FACTURA';
      if (fila.cobro_grupo_id) return 'COBRO_DE_GRUPO';
      const f = tabla('factura_emitida').find((x) => x.id === facturaId);
      if (!f || f.deleted_at || f.estatus !== 'VIGENTE')
        return 'FACTURA_NO_VIGENTE';
      const liga = tabla('factura_emitida_vuelo').find(
        (l) => l.factura_id === facturaId && l.vuelo_id === fila.vuelo_id,
      );
      return liga ? null : 'FACTURA_NO_LIGADA_AL_VUELO';
    };
    /** Trigger B (cancelar / baja) y FK ON DELETE SET NULL. */
    const soltarCobros = (facturaId: unknown) => {
      for (const c of tabla('cobro_vuelo')) {
        if (c.factura_emitida_id === facturaId) c.factura_emitida_id = null;
      }
    };

    const ejecutar = (): { data: unknown; error: unknown; count?: number } => {
      if (
        opts.migracion === false &&
        select.includes('factura_solicitada_at')
      ) {
        return {
          data: null,
          error: {
            code: '42703',
            message: 'column vuelo.factura_solicitada_at does not exist',
          },
        };
      }
      if (opts.cobroFactura === false && nombraFactura) {
        return {
          data: null,
          error: {
            code: '42703',
            message: 'column cobro_vuelo.factura_emitida_id does not exist',
          },
        };
      }
      const i = fallar.findIndex((x) => x.tabla === t && x.op === op);
      if (i >= 0 && op !== 'select') {
        fallar.splice(i, 1);
        return {
          data: null,
          error: { code: 'XX000', message: `falla ${op} ${t}` },
        };
      }
      if (op === 'insert') {
        const filas = (Array.isArray(payload) ? payload : [payload]) as Fila[];
        for (const f of filas) {
          if (t === 'factura_emitida') {
            const vivas = tabla(t).filter((x) => x.deleted_at == null);
            const choca = vivas.find(
              (x) =>
                txt(x.emisora_id) === txt(f.emisora_id) &&
                txt(x.serie).toUpperCase() === txt(f.serie).toUpperCase() &&
                String(x.folio).toUpperCase() === String(f.folio).toUpperCase(),
            );
            if (choca) {
              return {
                data: null,
                error: {
                  code: '23505',
                  message:
                    'duplicate key value violates unique constraint "uq_factura_emitida_serie_folio"',
                },
              };
            }
            f.folio_num = (() => {
              const d = String(f.folio).replace(/\D/g, '');
              return d ? String(Number(d)) : null;
            })();
            f.created_at ??= `2026-09-24T10:00:0${seq++ % 10}Z`;
            f.updated_at ??= f.created_at;
            f.archivos_historial ??= [];
            f.deleted_at ??= null;
          }
          if (t === 'factura_emitida_vuelo') {
            const dup = tabla(t).find(
              (x) => x.factura_id === f.factura_id && x.vuelo_id === f.vuelo_id,
            );
            if (dup) {
              return {
                data: null,
                error: {
                  code: '23505',
                  message: 'duplicate key factura_emitida_vuelo_pkey',
                },
              };
            }
          }
          tabla(t).push({ ...f });
        }
        return { data: devolver ? filas : null, error: null };
      }
      let filas = tabla(t).map((f) =>
        op === 'select' ? embeds(t, select, f) : f,
      );
      filas = filas.filter((f) => filtros.every((fn) => fn(f)));
      if (inner && select.includes('!inner')) {
        filas = filas.filter((f) => f.factura != null);
      }
      if (op === 'update') {
        const p = payload as Fila;
        if (t === 'cobro_vuelo' && 'factura_emitida_id' in p) {
          for (const f of filas) {
            const codigo = triggerA(f, p.factura_emitida_id);
            if (codigo) {
              return {
                data: null,
                error: {
                  code: '23514',
                  message: `${codigo}: trigger A`,
                  hint: codigo,
                  details: JSON.stringify({ cobro_id: f.id }),
                },
              };
            }
          }
        }
        for (const f of filas) Object.assign(f, p);
        if (t === 'factura_emitida') {
          for (const f of filas) {
            if (p.estatus === 'CANCELADA' || p.deleted_at) soltarCobros(f.id);
          }
        }
        return {
          data: devolver ? filas.map((f) => ({ ...f })) : null,
          error: null,
        };
      }
      if (op === 'delete') {
        const quitar = new Set(filas);
        tablas[t] = tabla(t).filter((f) => !quitar.has(f));
        if (t === 'factura_emitida') {
          // FK: ON DELETE SET NULL en cobro_vuelo, CASCADE en el puente.
          for (const f of filas) soltarCobros(f.id);
          const ids = new Set(filas.map((f) => f.id));
          tablas.factura_emitida_vuelo = tabla('factura_emitida_vuelo').filter(
            (l) => !ids.has(l.factura_id),
          );
        }
        return { data: null, error: null };
      }
      if (rango) filas = filas.slice(rango[0], rango[1] + 1);
      if (limite != null) filas = filas.slice(0, limite);
      return { data: filas, error: null, count: filas.length };
    };

    const q: Record<string, unknown> = {};
    const encadenar = (fn: () => void) => () => {
      fn();
      return q;
    };
    q.select = (s?: string) => {
      if (op === 'select') select = s ?? '*';
      else devolver = true;
      if (s?.includes('!inner')) inner = true;
      marcar(s ?? '');
      return q;
    };
    q.insert = (p: unknown) => {
      op = 'insert';
      payload = p;
      return q;
    };
    q.update = (p: unknown) => {
      op = 'update';
      payload = p;
      marcar(Object.keys((p as Fila) ?? {}).join(','));
      return q;
    };
    q.delete = () => {
      op = 'delete';
      return q;
    };
    q.eq = (c: string, v: unknown) =>
      encadenar(() => {
        marcar(c);
        filtros.push((f) => String(valorDe(f, c)) === String(v));
      })();
    q.neq = (c: string, v: unknown) =>
      encadenar(() => filtros.push((f) => valorDe(f, c) !== v))();
    q.is = (c: string, v: unknown) =>
      encadenar(() =>
        filtros.push((f) =>
          v === null ? valorDe(f, c) == null : valorDe(f, c) === v,
        ),
      )();
    q.not = (c: string, _op: string, v: unknown) =>
      encadenar(() =>
        filtros.push((f) =>
          v === null ? valorDe(f, c) != null : valorDe(f, c) !== v,
        ),
      )();
    q.in = (c: string, arr: unknown[]) =>
      encadenar(() => {
        maxIn.valor = Math.max(maxIn.valor, arr.length);
        filtros.push((f) => arr.map(String).includes(String(valorDe(f, c))));
      })();
    q.ilike = (c: string, pat: string) =>
      encadenar(() => filtros.push((f) => ilike(valorDe(f, c), pat)))();
    q.gte = (c: string, v: string) =>
      encadenar(() => filtros.push((f) => txt(valorDe(f, c)) >= v))();
    q.lte = (c: string, v: string) =>
      encadenar(() => filtros.push((f) => txt(valorDe(f, c)) <= v))();
    q.or = (expr: string) =>
      encadenar(() => {
        const partes = expr.split(',');
        filtros.push((f) => partes.some((p) => cond(f, p)));
      })();
    q.order = () => q;
    q.range = (d: number, h: number) => {
      rango = [d, h];
      return q;
    };
    q.limit = (n: number) => {
      limite = n;
      return q;
    };
    q.maybeSingle = () => {
      const r = ejecutar();
      const d = r.data;
      return Promise.resolve({
        data: Array.isArray(d) ? ((d as unknown[])[0] ?? null) : d,
        error: r.error,
      });
    };
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(ejecutar()).then(res, rej);
    return q;
  };

  const service = {
    from,
    storage: {
      from: () => ({
        upload: (path: string) => {
          subidos.push(path);
          return Promise.resolve({ error: null });
        },
        remove: (paths: string[]) => {
          borrados.push(paths);
          return Promise.resolve({ error: null });
        },
        createSignedUrl: (path: string) => {
          firmados.push(path);
          return Promise.resolve({
            data: { signedUrl: `https://firmada/${path}` },
            error: null,
          });
        },
      }),
    },
  };
  return {
    supabase: { service } as unknown as SupabaseService,
    tablas,
    maxIn,
    subidos,
    borrados,
    firmados,
  };
}

const V1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const V2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const CLI = 'cccccccc-0000-4000-8000-000000000001';
const EM1 = 'dddddddd-0000-4000-8000-000000000001';
const EM2 = 'dddddddd-0000-4000-8000-000000000002';

const vuelo = (id: string, folio: number, extra: Fila = {}): Fila => ({
  id,
  folio,
  estado: 'CONFIRMADO',
  cliente_id: CLI,
  grupo_id: null,
  fecha_vuelo: '2026-09-27T14:00:00+00:00',
  monto_total_usd: '8050.40',
  monto_total_mxn: '136856.80',
  tc_usd_mxn: '17.000000',
  cobrado: false,
  cotizacion_abierta: false,
  es_externo: false,
  facturado: false,
  factura_estatus: 'SIN_FACTURA',
  factura_solicitada_at: null,
  factura_solicitada_por: null,
  factura_solicitud_nota: null,
  factura_paga_contra_factura: false,
  ...extra,
});

const facturaFila = (
  id: string,
  serie: string | null,
  folio: string,
  extra: Fila = {},
): Fila => ({
  id,
  serie,
  folio,
  folio_num: folio.replace(/\D/g, '')
    ? String(Number(folio.replace(/\D/g, '')))
    : null,
  uuid: null,
  fecha_emision: '2026-09-20',
  estatus: 'VIGENTE',
  emisor_rfc: null,
  emisor_nombre: null,
  emisora_id: null,
  receptor_rfc: null,
  receptor_nombre: null,
  cliente_id: CLI,
  moneda: 'USD',
  subtotal: '6940.00',
  iva: '1110.40',
  total: '8050.40',
  metodo_pago: 'PPD',
  forma_pago: '99',
  notas: null,
  es_parcial: false,
  archivos_historial: [],
  pdf_path: `emitidas/${id}/viejo.pdf`,
  pdf_nombre: 'viejo.pdf',
  pdf_subido_at: '2026-09-20T10:00:00Z',
  pdf_subido_por: USUARIO,
  xml_path: null,
  xml_nombre: null,
  xml_subido_at: null,
  xml_subido_por: null,
  cancelada_at: null,
  cancelada_por: null,
  motivo_cancelacion: null,
  created_at: '2026-09-20T10:00:00Z',
  created_by: USUARIO,
  updated_at: '2026-09-20T10:00:00Z',
  deleted_at: null,
  ...extra,
});

function base(extra: Record<string, Fila[]> = {}): Record<string, Fila[]> {
  return {
    vuelo: [vuelo(V1, 341), vuelo(V2, 342)],
    cliente: [
      {
        id: CLI,
        nombre: 'Maqar',
        rfc: 'MMA150622P83',
        razon_social_default: 'MAQAR MACHINERY',
        es_interno: false,
        activo: true,
      },
    ],
    entidad_fiscal_emisora: [
      {
        id: EM1,
        razon_social: 'Aero Charter Cancun S.A. de C.V.',
        rfc: null,
        activa: true,
      },
      {
        id: EM2,
        razon_social: 'Aerodinamica de Monterrey',
        rfc: null,
        activa: true,
      },
    ],
    usuario: [
      { id: USUARIO, nombre: 'Mary Cruz' },
      { id: ITZI, nombre: 'Itzi' },
    ],
    factura_emitida: [],
    factura_emitida_vuelo: [],
    ...extra,
  };
}

function armar(datos: Record<string, Fila[]>, opts: Opciones = {}) {
  const db = fakeDb(datos, opts);
  const notifyUser = jest.fn().mockResolvedValue(true);
  const notifications = { notifyUser } as unknown as NotificationsService;
  const cobroStatus = jest.fn((ids: string[]) =>
    Promise.resolve(
      Object.fromEntries(
        ids.map((id) => [id, { total_cobrado: 0, sin_tc_count: 0 }]),
      ),
    ),
  );
  const flights = { cobroStatus } as unknown as FlightsService;
  const leerPdfEmitida = jest.fn();
  const generateTablaXlsx = jest.fn().mockResolvedValue(Buffer.from('xlsx'));
  const pyservices = {
    leerPdfEmitida,
    generateTablaXlsx,
  } as unknown as PyservicesService;
  const configuracion = {
    destinatariosFacturacion: jest
      .fn()
      .mockResolvedValue([{ id: USUARIO, nombre: 'Mary Cruz' }]),
  } as unknown as ConfiguracionService;
  const solicitud = new FacturaSolicitudService(
    db.supabase,
    notifications,
    configuracion,
  );
  const svc = new FacturasEmitidasService(
    db.supabase,
    flights,
    solicitud,
    pyservices,
    notifications,
  );
  return {
    svc,
    db,
    notifyUser,
    cobroStatus,
    leerPdfEmitida,
    generateTablaXlsx,
  };
}

const PDF = (nombre = 'A-123.pdf') => ({
  buffer: Buffer.from('%PDF-1.7\n...contenido...'),
  originalname: nombre,
  mimetype: 'application/pdf',
  size: 30,
});

const XML = (serie: string, folio: string, uuid: string) => ({
  buffer: Buffer.from(
    `<cfdi:Comprobante Serie="${serie}" Folio="${folio}" Fecha="2026-09-24T10:00:00" Total="8050.40" Moneda="USD" TipoDeComprobante="I"><cfdi:Complemento><tfd:TimbreFiscalDigital UUID="${uuid}"/></cfdi:Complemento></cfdi:Comprobante>`,
  ),
  originalname: 'cfdi.xml',
  mimetype: 'text/xml',
  size: 200,
});

const datos = (d: Record<string, unknown>) =>
  JSON.stringify({
    serie: 'A',
    folio: '123',
    fecha_emision: '2026-09-24',
    moneda: 'USD',
    total: 8050.4,
    ...d,
  });

async function codigoDe(
  p: Promise<unknown>,
): Promise<{ status: number; code: string; body: Fila }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      const body = e.getResponse() as Fila;
      return { status: e.getStatus(), code: String(body.error), body };
    }
    throw e;
  }
  throw new Error('no lanzó');
}

const actor = { userId: USUARIO, nombre: 'Mary Cruz' };

describe('FacturasEmitidasService — sin la migración', () => {
  it('503 FACTURAS_EMITIDAS_NO_DISPONIBLE en lista, alta y conteo', async () => {
    const { svc } = armar(base(), { migracion: false });
    for (const p of [
      svc.lista({ limit: 100, offset: 0 }),
      svc.crear(datos({}), undefined, actor),
      svc.conteoPorFacturar(),
    ]) {
      const r = await codigoDe(p);
      expect(r.status).toBe(503);
      expect(r.code).toBe('FACTURAS_EMITIDAS_NO_DISPONIBLE');
    }
  });
});

describe('FacturasEmitidasService — alta', () => {
  it('registra con PDF, liga el vuelo, sube FACTURADO por CAS y responde 201 con la factura', async () => {
    const { svc, db } = armar(base());
    const r = await svc.crear(
      datos({ vuelo_ids: [V1], emisora_id: EM1 }),
      { pdf: [PDF()] },
      actor,
    );
    expect(r.factura).toMatchObject({
      etiqueta: 'A-123',
      folio_num: 123,
      total: 8050.4,
      subtotal: null,
      moneda: 'USD',
      cliente: { id: CLI, nombre: 'Maqar' },
      emisora: { id: EM1 },
      pdf: { nombre: 'A-123.pdf', subido_por_nombre: 'Mary Cruz' },
      alertas: [],
    });
    expect(r.factura.vuelos).toHaveLength(1);
    expect(r.factura.vuelos[0]).toMatchObject({
      folio: 341,
      total: { usd: 8050.4, mxn: 136856.8 },
      cobro: { semaforo: { key: 'SIN_COBROS' } },
    });
    // Jamás se exponen paths.
    expect(JSON.stringify(r.factura)).not.toContain('emitidas/');
    expect(db.subidos[0]).toMatch(
      /^emitidas\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/,
    );
    expect(db.tablas.vuelo.find((v) => v.id === V1)?.factura_estatus).toBe(
      'FACTURADO',
    );
  });

  it('el estatus MANUAL solo sube desde SIN_FACTURA (nunca pisa otro)', async () => {
    const { svc, db } = armar(
      base({
        vuelo: [vuelo(V1, 341, { factura_estatus: 'ELABORADA_ENVIADA' })],
      }),
    );
    await svc.crear(datos({ vuelo_ids: [V1] }), undefined, actor);
    expect(db.tablas.vuelo[0].factura_estatus).toBe('ELABORADA_ENVIADA');
  });

  it('409 FACTURA_DUPLICADA con la existente: «A-123» sin serie vs A/00123', async () => {
    const { svc, db } = armar(
      base({
        factura_emitida: [facturaFila('f-1', 'A', '00123')],
        factura_emitida_vuelo: [{ factura_id: 'f-1', vuelo_id: V1 }],
      }),
    );
    const r = await codigoDe(
      svc.crear(datos({ serie: '', folio: 'A-123' }), { pdf: [PDF()] }, actor),
    );
    expect(r.status).toBe(409);
    expect(r.code).toBe('FACTURA_DUPLICADA');
    expect(r.body.message).toBe('Ya está registrada: A-00123 del vuelo #341.');
    expect((r.body.details as Fila).existente).toMatchObject({
      id: 'f-1',
      etiqueta: 'A-00123',
      vuelos: [{ id: V1, folio: 341 }],
    });
    // ANTES de subir nada.
    expect(db.subidos).toEqual([]);
  });

  it('409 también con serie CON DÍGITOS: «F1»+«23» ⇄ «F1-23» sin serie (en los dos sentidos)', async () => {
    // folio_num de «F1-23» es 123 y el de «23» es 23: buscar solo por los
    // dígitos del folio dejaba entrar el duplicado (la BD tampoco lo ve).
    const ida = armar(
      base({ factura_emitida: [facturaFila('f-1', null, 'F1-23')] }),
    );
    const r1 = await codigoDe(
      ida.svc.crear(datos({ serie: 'F1', folio: '23' }), undefined, actor),
    );
    expect(r1.code).toBe('FACTURA_DUPLICADA');
    const vuelta = armar(
      base({ factura_emitida: [facturaFila('f-2', 'F1', '23')] }),
    );
    const r2 = await codigoDe(
      vuelta.svc.crear(datos({ serie: '', folio: 'F1-23' }), undefined, actor),
    );
    expect(r2.code).toBe('FACTURA_DUPLICADA');
  });

  it('cliente_id explícito inexistente ⇒ 400 CLIENTE_NO_EXISTE antes de subir nada (no un 500 de FK)', async () => {
    const { svc, db } = armar(base());
    const r = await codigoDe(
      svc.crear(
        datos({ cliente_id: 'cccccccc-0000-4000-8000-000000000999' }),
        { pdf: [PDF()] },
        actor,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.code).toBe('CLIENTE_NO_EXISTE');
    expect(db.subidos).toEqual([]);
  });

  it('emisora NULL es comodín (choca); otra razón social NO choca', async () => {
    const d = base({
      factura_emitida: [facturaFila('f-1', 'A', '1', { emisora_id: EM1 })],
    });
    const { svc } = armar(d);
    const r = await codigoDe(
      svc.crear(datos({ folio: '1', emisora_id: null }), undefined, actor),
    );
    expect(r.code).toBe('FACTURA_DUPLICADA');
    const otra = await svc.crear(
      datos({ folio: '1', emisora_id: EM2 }),
      undefined,
      actor,
    );
    expect(otra.factura.emisora?.id).toBe(EM2);
  });

  it('409 UUID_DUPLICADO', async () => {
    const uuid = 'D08B6837-A3B5-45AF-96E1-36F07FBA8FAF';
    const { svc } = armar(
      base({ factura_emitida: [facturaFila('f-1', 'Z', '9', { uuid })] }),
    );
    const r = await codigoDe(
      svc.crear(datos({ uuid: uuid.toLowerCase() }), undefined, actor),
    );
    expect(r.code).toBe('UUID_DUPLICADO');
  });

  it('422 XML_NO_CUADRA si el XML es de otra factura; UUID del XML se usa si no se capturó', async () => {
    const { svc } = armar(base());
    const r = await codigoDe(
      svc.crear(
        datos({}),
        { xml: [XML('A', '124', 'D08B6837-A3B5-45AF-96E1-36F07FBA8FAF')] },
        actor,
      ),
    );
    expect(r.status).toBe(422);
    expect(r.code).toBe('XML_NO_CUADRA');
    expect(r.body.details).toEqual({
      campo: 'folio',
      en_xml: 'A-124',
      en_factura: 'A-123',
    });
    const ok = await svc.crear(
      datos({ serie: null, folio: 'A-00123' }),
      { xml: [XML('A', '123', 'd08b6837-a3b5-45af-96e1-36f07fba8faf')] },
      actor,
    );
    expect(ok.factura.uuid).toBe('D08B6837-A3B5-45AF-96E1-36F07FBA8FAF');
  });

  it('XML con DOCTYPE ⇒ 422 XML_NO_PERMITIDO; PDF en el campo XML ⇒ 400', async () => {
    const { svc } = armar(base());
    const malo = {
      ...XML('A', '123', 'D08B6837-A3B5-45AF-96E1-36F07FBA8FAF'),
      buffer: Buffer.from(
        '<!DOCTYPE x [<!ENTITY a "b">]><cfdi:Comprobante Folio="1"/>',
      ),
    };
    expect(
      (await codigoDe(svc.crear(datos({}), { xml: [malo] }, actor))).code,
    ).toBe('XML_NO_PERMITIDO');
    const r = await codigoDe(
      svc.crear(datos({}), { xml: [PDF('x.pdf')] }, actor),
    );
    expect(r).toMatchObject({ status: 400, code: 'ARCHIVO_TIPO_INVALIDO' });
    expect(r.body.message).toBe('En «XML» va el XML del CFDI');
  });

  it('400 DATOS_INVALIDOS (faltantes / JSON roto / campo extra) y RFC_INVALIDO', async () => {
    const { svc } = armar(base());
    const falta = await codigoDe(
      svc.crear(JSON.stringify({ serie: 'A' }), undefined, actor),
    );
    expect(falta.code).toBe('DATOS_INVALIDOS');
    expect((falta.body.details as Fila).errores).toEqual(
      expect.arrayContaining([
        'Falta el folio',
        'Falta la moneda (MXN o USD)',
        'Falta el total',
      ]),
    );
    expect((await codigoDe(svc.crear('{roto', undefined, actor))).code).toBe(
      'DATOS_INVALIDOS',
    );
    expect(
      (await codigoDe(svc.crear(datos({ hackeo: 1 }), undefined, actor))).code,
    ).toBe('DATOS_INVALIDOS');
    expect(
      (
        await codigoDe(
          svc.crear(datos({ receptor_rfc: 'abc' }), undefined, actor),
        )
      ).code,
    ).toBe('RFC_INVALIDO');
  });

  it('400 VUELOS_NO_EXISTEN', async () => {
    const { svc } = armar(base());
    const r = await codigoDe(
      svc.crear(
        datos({ vuelo_ids: ['bbbbbbbb-0000-4000-8000-00000000dead'] }),
        undefined,
        actor,
      ),
    );
    expect(r.code).toBe('VUELOS_NO_EXISTEN');
  });

  it('ROLLBACK de storage si el INSERT falla', async () => {
    const { svc, db } = armar(base(), {
      fallar: [{ tabla: 'factura_emitida', op: 'insert' }],
    });
    await expect(
      svc.crear(datos({}), { pdf: [PDF()] }, actor),
    ).rejects.toThrow();
    expect(db.borrados).toEqual([db.subidos]);
    expect(db.tablas.factura_emitida).toHaveLength(0);
  });

  it('ROLLBACK total si el PUENTE falla: se borra la factura y lo subido', async () => {
    const { svc, db } = armar(base(), {
      fallar: [{ tabla: 'factura_emitida_vuelo', op: 'insert' }],
    });
    await expect(
      svc.crear(datos({ vuelo_ids: [V1] }), { pdf: [PDF()] }, actor),
    ).rejects.toThrow(/ligar los vuelos/);
    expect(db.tablas.factura_emitida).toHaveLength(0);
    expect(db.borrados).toEqual([db.subidos]);
  });

  it('avisa a quien PIDIÓ la factura (una vez por persona) y nunca al actor', async () => {
    const pedida = {
      factura_solicitada_at: '2026-09-24T09:00:00Z',
      factura_solicitada_por: ITZI,
    };
    const { svc, notifyUser } = armar(
      base({ vuelo: [vuelo(V1, 341, pedida), vuelo(V2, 342, pedida)] }),
    );
    await svc.crear(datos({ vuelo_ids: [V1, V2] }), undefined, actor);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser).toHaveBeenCalledWith(
      ITZI,
      expect.objectContaining({
        tipo: 'factura_emitida',
        titulo: 'Ya está la factura A-123',
        cuerpo:
          'Mary Cruz registró la factura A-123 de los vuelos #341 y #342 · Maqar.',
        link: `/admin/quotes/${V1}#cobros-vuelo`,
      }),
    );
    // Si quien registra es quien pidió, no se avisa a sí mismo.
    const otro = armar(
      base({
        vuelo: [vuelo(V1, 341, { ...pedida, factura_solicitada_por: USUARIO })],
      }),
    );
    await otro.svc.crear(datos({ vuelo_ids: [V1] }), undefined, actor);
    expect(otro.notifyUser).not.toHaveBeenCalled();
  });

  it('avisos: otra vigente en el vuelo, receptor distinto, total distinto, emisor ajeno', async () => {
    const { svc } = armar(
      base({
        factura_emitida: [facturaFila('f-1', 'A', '120')],
        factura_emitida_vuelo: [{ factura_id: 'f-1', vuelo_id: V1 }],
      }),
    );
    const r = await svc.crear(
      datos({
        vuelo_ids: [V1],
        total: 7350.69,
        receptor_rfc: 'XAXX010101000',
        emisor_rfc: 'SIN9408027L7',
        emisor_nombre: 'SEGUROS INBURSA',
      }),
      undefined,
      actor,
    );
    expect(r.avisos.map((a) => a.code).sort()).toEqual(
      [
        'EMISOR_NO_VUELATOUR',
        'EMISOR_SIN_VERIFICAR',
        'RECEPTOR_DISTINTO_CLIENTE',
        'TOTAL_DISTINTO_VUELO',
        'VUELO_CON_OTRA_FACTURA',
      ].sort(),
    );
    expect(
      r.avisos.find((a) => a.code === 'VUELO_CON_OTRA_FACTURA')?.mensaje,
    ).toBe(
      // Texto del 16-oct-2026 (facturas por cobro, invariante 84).
      'El vuelo #341 ya tiene la factura A-120 vigente. Si esta cubre otros cobros del mismo vuelo, asígnaselos en «¿Qué cobros cubre?»; si es una re-emisión, cancela la anterior.',
    );
    expect(r.factura.alertas).toContain('DUPLICADO_VUELO');
  });
});

describe('FacturasEmitidasService — archivos: NUNCA se borra lo anterior', () => {
  it('reemplazar el PDF deja el anterior en archivos_historial y NO llama remove', async () => {
    const { svc, db } = armar(
      base({ factura_emitida: [facturaFila('f-1', 'A', '1')] }),
    );
    const r = await svc.reemplazarArchivos(
      'f-1',
      { pdf: [PDF('nuevo.pdf')] },
      actor,
    );
    expect(db.borrados).toEqual([]);
    const fila = db.tablas.factura_emitida[0];
    expect(fila.pdf_path).toBe(db.subidos[0]);
    expect(fila.archivos_historial).toEqual([
      expect.objectContaining({
        tipo: 'pdf',
        path: 'emitidas/f-1/viejo.pdf',
        accion: 'REEMPLAZADO',
        quitado_por: USUARIO,
      }),
    ]);
    expect(r.archivos_anteriores).toBe(1);
  });

  it('quitar el PDF solo desreferencia (QUITADO) y NO llama remove', async () => {
    const { svc, db } = armar(
      base({ factura_emitida: [facturaFila('f-1', 'A', '1')] }),
    );
    const r = await svc.quitarArchivo('f-1', 'pdf', actor);
    expect(db.borrados).toEqual([]);
    expect(r.pdf).toBeNull();
    expect(db.tablas.factura_emitida[0].archivos_historial).toEqual([
      expect.objectContaining({
        path: 'emitidas/f-1/viejo.pdf',
        accion: 'QUITADO',
      }),
    ]);
    expect((await codigoDe(svc.quitarArchivo('f-1', 'xml', actor))).code).toBe(
      'ARCHIVO_NO_EXISTE',
    );
  });

  it('si el UPDATE falla al reemplazar, se retira SOLO lo nuevo', async () => {
    const { svc, db } = armar(
      base({ factura_emitida: [facturaFila('f-1', 'A', '1')] }),
      {
        fallar: [{ tabla: 'factura_emitida', op: 'update' }],
      },
    );
    await expect(
      svc.reemplazarArchivos('f-1', { pdf: [PDF()] }, actor),
    ).rejects.toThrow();
    expect(db.borrados).toEqual([db.subidos]);
    expect(db.borrados[0]).not.toContain('emitidas/f-1/viejo.pdf');
  });

  it('XML de otra factura al reemplazar ⇒ 422 XML_NO_CUADRA', async () => {
    const { svc } = armar(
      base({
        factura_emitida: [
          facturaFila('f-1', 'A', '1', {
            uuid: 'D08B6837-A3B5-45AF-96E1-36F07FBA8FAF',
          }),
        ],
      }),
    );
    const r = await codigoDe(
      svc.reemplazarArchivos(
        'f-1',
        { xml: [XML('A', '1', 'D08B6837-A3B5-45AF-96E1-36F07FBA8FA0')] },
        actor,
      ),
    );
    expect(r.code).toBe('XML_NO_CUADRA');
    expect((r.body.details as Fila).campo).toBe('uuid');
  });

  it('URL firmada 600 s; sin PDF ⇒ 404', async () => {
    const { svc, db } = armar(
      base({
        factura_emitida: [
          facturaFila('f-1', 'A', '1'),
          facturaFila('f-2', 'A', '2', { pdf_path: null }),
        ],
      }),
    );
    expect(await svc.archivoUrl('f-1', 'pdf')).toEqual({
      url: 'https://firmada/emitidas/f-1/viejo.pdf',
      nombre: 'viejo.pdf',
    });
    expect(db.firmados).toEqual(['emitidas/f-1/viejo.pdf']);
    expect((await codigoDe(svc.archivoUrl('f-2', 'pdf'))).status).toBe(404);
  });
});

describe('FacturasEmitidasService — cancelar / eliminar / editar', () => {
  const conFactura = (vueloExtra: Fila = {}) =>
    base({
      vuelo: [
        vuelo(V1, 341, { factura_estatus: 'FACTURADO', ...vueloExtra }),
        vuelo(V2, 342),
      ],
      factura_emitida: [facturaFila('f-1', 'A', '1')],
      factura_emitida_vuelo: [{ factura_id: 'f-1', vuelo_id: V1 }],
    });

  it('cancelar avisa VUELO_SIGUE_FACTURADO y NO baja el estatus del vuelo', async () => {
    const { svc, db } = armar(conFactura());
    const r = await svc.cancelar('f-1', 'Re-emitida con otro RFC', actor);
    expect(r.factura.estatus).toBe('CANCELADA');
    expect(r.factura.cancelada).toMatchObject({
      motivo: 'Re-emitida con otro RFC',
      por_nombre: 'Mary Cruz',
    });
    expect(r.avisos).toEqual([
      expect.objectContaining({
        code: 'VUELO_SIGUE_FACTURADO',
        mensaje:
          'El vuelo #341 se queda sin factura vigente y sigue marcado «Facturado». Si la vas a volver a emitir, regístrala; si no, cambia el estatus en el vuelo.',
      }),
    ]);
    expect(db.tablas.vuelo[0].factura_estatus).toBe('FACTURADO');
    expect((await codigoDe(svc.cancelar('f-1', 'otra vez', actor))).code).toBe(
      'FACTURA_YA_CANCELADA',
    );
  });

  it('motivo corto ⇒ 400 MOTIVO_REQUERIDO', async () => {
    const { svc } = armar(conFactura());
    expect((await codigoDe(svc.cancelar('f-1', ' x ', actor))).code).toBe(
      'MOTIVO_REQUERIDO',
    );
    expect((await codigoDe(svc.eliminar('f-1', undefined, actor))).code).toBe(
      'MOTIVO_REQUERIDO',
    );
    // Se cuentan CARACTERES como el CHECK (char_length): «👍👍» son 2, no 4.
    expect((await codigoDe(svc.cancelar('f-1', '👍👍', actor))).code).toBe(
      'MOTIVO_REQUERIDO',
    );
  });

  it('eliminar = soft delete: libera el número y conserva archivos', async () => {
    const { svc, db } = armar(conFactura());
    const r = await svc.eliminar('f-1', 'Registrada por error', actor);
    expect(r).toMatchObject({ ok: true, id: 'f-1' });
    expect(db.tablas.factura_emitida[0]).toMatchObject({
      deleted_by: USUARIO,
      motivo_baja: 'Registrada por error',
    });
    expect(db.borrados).toEqual([]);
    expect((await codigoDe(svc.obtener('f-1'))).code).toBe('FACTURA_NO_EXISTE');
    // El mismo número vuelve a entrar.
    const again = await svc.crear(datos({ folio: '1' }), undefined, actor);
    expect(again.factura.etiqueta).toBe('A-1');
  });

  it('editar: {} sin archivos ⇒ 400 NADA_QUE_CAMBIAR; vuelo_ids REEMPLAZA', async () => {
    const { svc, db } = armar(conFactura());
    expect(
      (await codigoDe(svc.editar('f-1', '{}', undefined, actor))).code,
    ).toBe('NADA_QUE_CAMBIAR');
    const r = await svc.editar(
      'f-1',
      JSON.stringify({ vuelo_ids: [V2] }),
      undefined,
      actor,
    );
    expect(r.factura.vuelos.map((v) => v.folio)).toEqual([342]);
    expect(db.tablas.factura_emitida_vuelo).toEqual([
      expect.objectContaining({ factura_id: 'f-1', vuelo_id: V2 }),
    ]);
    // Las notas conservan sus renglones (solo se recortan los extremos).
    const n = await svc.editar(
      'f-1',
      JSON.stringify({ notas: '  Anticipo 50 %\nFiniquito al regresar  ' }),
      undefined,
      actor,
    );
    expect(n.factura.notas).toBe('Anticipo 50 %\nFiniquito al regresar');
  });

  it('editar a un número que ya existe ⇒ 409 (excluyendo la propia fila)', async () => {
    const { svc } = armar(
      base({
        factura_emitida: [
          facturaFila('f-1', 'A', '1'),
          facturaFila('f-2', 'A', '2'),
        ],
      }),
    );
    // Guardar su propio número no choca.
    await svc.editar('f-1', JSON.stringify({ folio: '001' }), undefined, actor);
    expect(
      (
        await codigoDe(
          svc.editar('f-1', JSON.stringify({ folio: '2' }), undefined, actor),
        )
      ).code,
    ).toBe('FACTURA_DUPLICADA');
  });
});

describe('FacturasEmitidasService — lista, por facturar y lotes', () => {
  it('lista: orden por número, resumen GLOBAL con huecos y filtrado del filtro', async () => {
    const { svc } = armar(
      base({
        factura_emitida: [
          facturaFila('f-1', 'A', '101'),
          facturaFila('f-2', 'A', '104', {
            estatus: 'CANCELADA',
            cancelada_at: '2026-09-21T00:00:00Z',
            motivo_cancelacion: 'x x x',
          }),
          facturaFila('f-3', 'A', '102', {
            pdf_path: null,
            moneda: 'MXN',
            total: '1000',
          }),
          facturaFila('f-4', 'A', '99', {
            deleted_at: '2026-09-22T00:00:00Z',
            motivo_baja: 'error',
          }),
        ],
        factura_emitida_vuelo: [{ factura_id: 'f-1', vuelo_id: V1 }],
      }),
    );
    const r = await svc.lista({ limit: 100, offset: 0 });
    expect(r.data.map((f) => f.etiqueta)).toEqual(['A-104', 'A-102', 'A-101']);
    expect(r.resumen).toMatchObject({
      registradas: 3,
      vigentes: 2,
      canceladas: 1,
      sin_pdf: 1,
      sin_vuelo: 1,
      totales_vigentes: [
        { moneda: 'MXN', total: 1000 },
        { moneda: 'USD', total: 8050.4 },
      ],
    });
    expect(r.resumen.huecos).toEqual([
      expect.objectContaining({
        serie: 'A',
        faltantes: ['A-103'],
        total_faltantes: 1,
      }),
    ]);
    const f = await svc.lista({
      limit: 100,
      offset: 0,
      estatus: 'VIGENTE',
      alerta: 'sin_pdf',
    });
    expect(f.data.map((x) => x.id)).toEqual(['f-3']);
    expect(f.filtrado).toEqual({
      count: 1,
      totales: [{ moneda: 'MXN', total: 1000 }],
    });
    expect(
      (
        await codigoDe(
          svc.lista({
            limit: 1,
            offset: 0,
            desde: '2026-09-30',
            hasta: '2026-09-01',
          }),
        )
      ).code,
    ).toBe('RANGO_INVALIDO');
  });

  it('con 250 vuelos, TODA consulta `.in` va en lotes de ≤ 200 y el semáforo se pide completo', async () => {
    const vuelos = Array.from({ length: 250 }, (_, i) =>
      vuelo(
        `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`,
        1000 + i,
        {
          factura_solicitada_at: '2026-09-24T09:00:00Z',
          factura_solicitada_por: ITZI,
        },
      ),
    );
    const facturas = vuelos.map((v, i) =>
      facturaFila(`f-${i}`, 'A', String(i + 1)),
    );
    const ligas = vuelos.map((v, i) => ({
      factura_id: `f-${i}`,
      vuelo_id: v.id,
    }));
    const { svc, db, cobroStatus } = armar(
      base({
        vuelo: vuelos,
        factura_emitida: facturas,
        factura_emitida_vuelo: ligas,
      }),
    );
    const r = await svc.lista({ limit: 500, offset: 0 });
    expect(r.data).toHaveLength(250);
    expect(cobroStatus).toHaveBeenCalledTimes(1);
    expect(cobroStatus.mock.calls[0][0].length).toBe(250);
    expect(db.maxIn.valor).toBeLessThanOrEqual(200);
    await svc.conteoPorFacturar();
    expect(db.maxIn.valor).toBeLessThanOrEqual(200);
  });

  it('por facturar: derivado, paga contra factura primero, datos fiscales faltantes', async () => {
    const { svc } = armar(
      base({
        vuelo: [
          vuelo(V1, 341, {
            factura_solicitada_at: '2026-09-20T09:00:00Z',
            factura_solicitada_por: ITZI,
          }),
          vuelo(V2, 342, {
            factura_solicitada_at: '2026-09-23T09:00:00Z',
            factura_solicitada_por: ITZI,
            factura_paga_contra_factura: true,
            factura_estatus: 'FACTURADO',
          }),
          vuelo('bbbbbbbb-0000-4000-8000-000000000003', 343, {
            factura_solicitada_at: '2026-09-19T09:00:00Z',
            estado: 'CANCELADO',
          }),
          vuelo('bbbbbbbb-0000-4000-8000-000000000004', 344, {
            factura_solicitada_at: '2026-09-19T09:00:00Z',
            facturado: true,
          }),
        ],
      }),
    );
    const r = await svc.porFacturar();
    // 13-oct-2026 (invariante 65, caso #376): el #342 está marcado
    // «Facturado» a mano SIN factura registrada ⇒ sale de la bandeja y del
    // badge y va a la nota `marcados_sin_registro` con la MISMA forma.
    expect(r.data.map((x) => x.vuelo.folio)).toEqual([341]);
    expect(r.count).toBe(1);
    expect(r.marcados_sin_registro.map((x) => x.vuelo.folio)).toEqual([342]);
    const m = r.marcados_sin_registro[0];
    expect(m.vuelo.estatus_manual).toBe('FACTURADO');
    expect(m.solicitud).toMatchObject({
      paga_contra_factura: true,
      solicitada_por: { id: ITZI, nombre: 'Itzi' },
    });
    expect(m.faltan_datos_fiscales).toEqual([
      'Régimen fiscal',
      'Uso de CFDI',
      'Código postal',
    ]);
    expect(r.data[0].facturas_del_cliente).toEqual([]);
    expect(await svc.conteoPorFacturar()).toEqual({
      por_facturar: 1,
      paga_contra_factura: 0,
      marcados_sin_registro: 1,
      ya_no_aplican: 0,
    });
  });

  it('con 250 vuelos POR FACTURAR de clientes distintos, la sugerencia de facturas del cliente también va en lotes de ≤ 200', async () => {
    const vuelos = Array.from({ length: 250 }, (_, i) =>
      vuelo(
        `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`,
        2000 + i,
        {
          cliente_id: `cli-${i}`,
          factura_solicitada_at: '2026-10-05T20:00:00Z',
          factura_solicitada_por: ITZI,
        },
      ),
    );
    const { svc, db } = armar(base({ vuelo: vuelos }));
    const r = await svc.porFacturar();
    expect(r.data).toHaveLength(250);
    expect(db.maxIn.valor).toBeLessThanOrEqual(200);
  });
});

/**
 * CASO #375/#376 (13-oct-2026, invariante 65). Itzi pidió factura de los dos
 * vuelos de January Davila ($904.51 USD c/u) el 5-oct; el 8-oct Mary
 * registró A-0440 ($31,435.91 MXN ≈ los DOS vuelos) y la ligó SOLO a #375.
 * El #376 se quedó —correctamente— en «Por facturar» hasta que Mary lo ligó
 * a mano el 13-oct. Prevención: la fila del #376 SUGIERE «Ligar a A-0440»
 * (`facturas_del_cliente`) y el estatus manual «Facturado» sin registro sale
 * de la bandeja a su nota.
 */
describe('FacturasEmitidasService — por facturar: caso #375/#376 (13-oct-2026)', () => {
  const A0440 = (extra: Fila = {}) =>
    facturaFila('f-440', 'A', '0440', {
      fecha_emision: '2026-10-08',
      moneda: 'MXN',
      subtotal: '27100.79',
      iva: '4335.12',
      total: '31435.91',
      ...extra,
    });
  const mundo376 = (extra: Record<string, Fila[]> = {}, v1: Fila = {}) =>
    base({
      vuelo: [
        vuelo(V1, 375, {
          factura_solicitada_at: '2026-10-05T20:04:47Z',
          factura_solicitada_por: ITZI,
          ...v1,
        }),
        vuelo(V2, 376, {
          factura_solicitada_at: '2026-10-05T20:07:46Z',
          factura_solicitada_por: ITZI,
        }),
      ],
      factura_emitida: [A0440()],
      factura_emitida_vuelo: [{ factura_id: 'f-440', vuelo_id: V1 }],
      ...extra,
    });

  it('ligada solo a #375 ⇒ #376 sigue por facturar y SUGIERE A-0440 con sus vuelos y su total', async () => {
    const { svc } = armar(mundo376());
    const r = await svc.porFacturar();
    expect(r.data.map((x) => x.vuelo.folio)).toEqual([376]);
    expect(r.marcados_sin_registro).toEqual([]);
    expect(r.data[0].facturas_del_cliente).toEqual([
      {
        id: 'f-440',
        etiqueta: 'A-0440',
        fecha_emision: '2026-10-08',
        total: 31435.91,
        moneda: 'MXN',
        vuelo_ids: [V1],
        vuelo_folios: [375],
      },
    ]);
    expect(await svc.conteoPorFacturar()).toEqual({
      por_facturar: 1,
      paga_contra_factura: 0,
      marcados_sin_registro: 0,
      ya_no_aplican: 0,
    });
  });

  it('ligada a los DOS ⇒ bandeja vacía y conteo en cero', async () => {
    const { svc } = armar(
      mundo376({
        factura_emitida_vuelo: [
          { factura_id: 'f-440', vuelo_id: V1 },
          { factura_id: 'f-440', vuelo_id: V2 },
        ],
      }),
    );
    const r = await svc.porFacturar();
    expect(r).toEqual({
      data: [],
      count: 0,
      marcados_sin_registro: [],
      ya_no_aplican: [],
    });
    expect(await svc.conteoPorFacturar()).toEqual({
      por_facturar: 0,
      paga_contra_factura: 0,
      marcados_sin_registro: 0,
      ya_no_aplican: 0,
    });
  });

  it('factura CANCELADA: el FACTURADO (por el CAS de ligar) cae en «marcados», el otro regresa a la bandeja y nadie la sugiere', async () => {
    const { svc } = armar(
      mundo376(
        {
          factura_emitida: [A0440({ estatus: 'CANCELADA' })],
          factura_emitida_vuelo: [
            { factura_id: 'f-440', vuelo_id: V1 },
            { factura_id: 'f-440', vuelo_id: V2 },
          ],
        },
        { factura_estatus: 'FACTURADO' },
      ),
    );
    const r = await svc.porFacturar();
    expect(r.data.map((x) => x.vuelo.folio)).toEqual([376]);
    expect(r.marcados_sin_registro.map((x) => x.vuelo.folio)).toEqual([375]);
    expect(r.marcados_sin_registro[0].facturas_canceladas).toBe(1);
    for (const it of [...r.data, ...r.marcados_sin_registro]) {
      expect(it.facturas_del_cliente).toEqual([]);
    }
    expect(await svc.conteoPorFacturar()).toEqual({
      por_facturar: 1,
      paga_contra_factura: 0,
      marcados_sin_registro: 1,
      ya_no_aplican: 0,
    });
  });

  it('NO se sugiere: borrada, de OTRO cliente o emitida antes de (solicitud − 30 días); el límite del día 30 SÍ', async () => {
    const OTRO = 'cccccccc-0000-4000-8000-000000000009';
    const { svc } = armar(
      mundo376({
        factura_emitida: [
          A0440({ deleted_at: '2026-10-09T10:00:00Z' }),
          facturaFila('f-otro', 'A', '0441', {
            cliente_id: OTRO,
            fecha_emision: '2026-10-08',
          }),
          facturaFila('f-vieja', 'A', '0300', { fecha_emision: '2026-08-26' }),
          // 5-oct 15:07 Cancún − 30 días = 5-sep (día Cancún): entra.
          facturaFila('f-limite', 'A', '0350', { fecha_emision: '2026-09-05' }),
        ],
        factura_emitida_vuelo: [],
      }),
    );
    const r = await svc.porFacturar();
    const del376 = r.data.find((x) => x.vuelo.folio === 376)!;
    expect(del376.facturas_del_cliente.map((f) => f.etiqueta)).toEqual([
      'A-0350',
    ]);
    // Sin vuelos ligados: la sugerencia lo dice con listas vacías.
    expect(del376.facturas_del_cliente[0]).toMatchObject({
      vuelo_ids: [],
      vuelo_folios: [],
      moneda: 'USD',
    });
  });

  it('máximo 3, recientes primero (fecha de emisión y luego número, ambos de mayor a menor)', async () => {
    const { svc } = armar(
      mundo376({
        factura_emitida: [
          facturaFila('f-1', 'A', '0501', { fecha_emision: '2026-10-01' }),
          facturaFila('f-2', 'A', '0502', { fecha_emision: '2026-10-09' }),
          facturaFila('f-3', 'A', '0503', { fecha_emision: '2026-10-09' }),
          facturaFila('f-4', 'A', '0504', { fecha_emision: '2026-09-20' }),
        ],
        factura_emitida_vuelo: [],
      }),
    );
    const r = await svc.porFacturar();
    const del375 = r.data.find((x) => x.vuelo.folio === 375)!;
    expect(del375.facturas_del_cliente.map((f) => f.etiqueta)).toEqual([
      'A-0503',
      'A-0502',
      'A-0501',
    ]);
  });

  it('si la lectura de la sugerencia falla, la bandeja responde igual (sin sugerencias) y se avisa en el log', async () => {
    const { svc, db } = armar(mundo376());
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const servicio = db.supabase.service as unknown as {
      from: (t: string) => Record<string, unknown>;
    };
    const fromOriginal = servicio.from;
    servicio.from = (t: string) => {
      const q = fromOriginal(t);
      if (t !== 'factura_emitida') return q;
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({
          data: null,
          error: { code: '57014', message: 'canceling statement' },
        }).then(res);
      return q;
    };
    const r = await svc.porFacturar();
    expect(r.data.map((x) => x.vuelo.folio)).toEqual([376]);
    expect(r.data[0].facturas_del_cliente).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no se pudieron sugerir facturas del cliente'),
    );
    warn.mockRestore();
  });
});

describe('FacturasEmitidasService — leer-archivo', () => {
  it('pyservices caído ⇒ campos vacíos + PDF_NO_LEIDO (nunca 500)', async () => {
    const { svc, leerPdfEmitida } = armar(base());
    leerPdfEmitida.mockRejectedValue(new Error('pyservices respondio 404'));
    const r = await svc.leerArchivo({ pdf: [PDF()] });
    expect(r.campos.folio).toBeNull();
    expect(r.texto_extraido).toBe(false);
    expect(r.avisos.map((a) => a.code)).toContain('PDF_NO_LEIDO');
  });

  it('sin texto: el motivo REAL de pyservices manda; «parece escaneado» solo si no hay otro', async () => {
    const { svc, leerPdfEmitida } = armar(base());
    const sinTexto = (avisos: string[]) => ({
      serie: null,
      folio: null,
      uuid: null,
      fecha_emision: null,
      emisor_rfc: null,
      emisor_nombre: null,
      receptor_rfc: null,
      receptor_nombre: null,
      subtotal: null,
      iva: null,
      total: null,
      moneda: null,
      metodo_pago: null,
      forma_pago: null,
      texto_extraido: false,
      paginas: 1,
      avisos,
    });
    // Contraseña: NO se dice «parece escaneado».
    leerPdfEmitida.mockResolvedValue(
      sinTexto([
        'El PDF está protegido con contraseña: captura los datos a mano.',
      ]),
    );
    let r = await svc.leerArchivo({ pdf: [PDF()] });
    expect(r.avisos.map((a) => a.code)).not.toContain('PDF_SIN_TEXTO');
    expect(r.avisos.map((a) => a.mensaje).join(' ')).toContain('contraseña');
    // Escaneado: UN solo aviso (el del API), sin repetir el de pyservices.
    leerPdfEmitida.mockResolvedValue(
      sinTexto(['El PDF no tiene texto (parece escaneado).']),
    );
    r = await svc.leerArchivo({ pdf: [PDF()] });
    expect(
      r.avisos.filter((a) => /escaneado/i.test(a.mensaje)).map((a) => a.code),
    ).toEqual(['PDF_SIN_TEXTO']);
  });

  it('XML manda, PDF llena lo que falta; «ya registrada» y cliente por RFC', async () => {
    const uuid = 'D08B6837-A3B5-45AF-96E1-36F07FBA8FAF';
    const { svc, leerPdfEmitida } = armar(
      base({ factura_emitida: [facturaFila('f-1', 'A', '123', { uuid })] }),
    );
    leerPdfEmitida.mockResolvedValue({
      serie: 'ZZ',
      folio: '9',
      uuid: 'D08B6837-A3B5-45AF-96E1-36F07FBA8FA0',
      fecha_emision: null,
      emisor_rfc: null,
      emisor_nombre: null,
      receptor_rfc: 'MMA150622P83',
      receptor_nombre: 'MAQAR MACHINERY',
      subtotal: 6940,
      iva: 1110.4,
      total: 8050.4,
      moneda: 'USD',
      metodo_pago: 'PPD',
      forma_pago: '99',
      texto_extraido: true,
      paginas: 1,
      avisos: ['Solo se leyeron las primeras 5 páginas.'],
    });
    const r = await svc.leerArchivo({
      pdf: [PDF()],
      xml: [XML('A', '123', uuid)],
    });
    expect(r.campos).toMatchObject({
      serie: 'A',
      folio: '123',
      uuid,
      receptor_rfc: 'MMA150622P83',
      subtotal: 6940,
      metodo_pago: 'PPD',
    });
    expect(r.fuente).toEqual({ xml: true, pdf: true });
    expect(r.avisos.map((a) => a.code)).toEqual(
      expect.arrayContaining(['PDF_XML_NO_CUADRAN', 'LECTURA_PDF']),
    );
    expect(r.ya_registrada?.mensaje).toBe(
      'Ya está registrada: A-123 (sin vuelo ligado).',
    );
    expect(r.cliente_sugerido).toEqual({
      id: CLI,
      nombre: 'Maqar',
      por: 'RFC',
    });
  });

  it('XML ilegible sin PDF ⇒ 422; sin archivos ⇒ 400 SIN_ARCHIVO', async () => {
    const { svc } = armar(base());
    const basura = { ...XML('A', '1', 'x'), buffer: Buffer.from('<nada/>') };
    expect((await codigoDe(svc.leerArchivo({ xml: [basura] }))).code).toBe(
      'XML_ILEGIBLE',
    );
    expect((await codigoDe(svc.leerArchivo({}))).code).toBe('SIN_ARCHIVO');
  });
});

describe('FacturasEmitidasService — selector de vuelos y Excel', () => {
  const V3 = 'bbbbbbbb-0000-4000-8000-000000000003';
  const mundo = () =>
    base({
      vuelo: [
        vuelo(V1, 341),
        vuelo(V2, 342, {
          fecha_vuelo: '2026-09-28T14:00:00+00:00',
          factura_solicitada_at: '2026-09-24T09:00:00Z',
          factura_solicitada_por: ITZI,
        }),
        vuelo(V3, 343, { estado: 'CANCELADO' }),
      ],
      factura_emitida: [facturaFila('f-1', 'A', '120')],
      factura_emitida_vuelo: [{ factura_id: 'f-1', vuelo_id: V1 }],
    });

  it('#folio incluye cancelados; sin q primero los «por facturar»', async () => {
    const { svc } = armar(mundo());
    const porFolio = await svc.vuelosCandidatos({ q: '#343' });
    expect(porFolio.map((v) => [v.folio, v.estado])).toEqual([
      [343, 'CANCELADO'],
    ]);
    const vacio = await svc.vuelosCandidatos({});
    expect(vacio[0]).toMatchObject({ folio: 342, solicitud: true });
    expect(vacio.map((v) => v.folio)).not.toContain(343);
    const v341 = vacio.find((v) => v.folio === 341)!;
    expect(v341).toMatchObject({
      facturas_vigentes: ['A-120'],
      solicitud: false,
      cliente_nombre: 'Maqar',
      cliente_rfc: 'MMA150622P83',
      total: { usd: 8050.4, mxn: 136856.8 },
    });
  });

  it('texto busca por cliente (cancelados al final) e `ids` hidrata', async () => {
    const { svc } = armar(mundo());
    const r = await svc.vuelosCandidatos({ q: 'maqar' });
    expect(r.map((v) => v.folio).at(-1)).toBe(343);
    const ids = await svc.vuelosCandidatos({ ids: `${V2},no-uuid` });
    expect(ids.map((v) => v.folio)).toEqual([342]);
  });

  it('Excel: mismos filtros, pyservices tabla-xlsx y nombre con el día Cancún', async () => {
    const { svc, generateTablaXlsx } = armar(mundo());
    const r = await svc.exportXlsx({ estatus: 'VIGENTE' });
    expect(r.filename).toMatch(/^facturas-emitidas-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const llamadas = generateTablaXlsx.mock.calls as unknown[][];
    const payload = llamadas[0][0] as {
      titulo: string;
      filas: unknown[][];
      subtitulo: string;
    };
    expect(payload.titulo).toBe('Facturas emitidas');
    expect(payload.subtitulo).toContain('Solo vigentes');
    expect(payload.filas).toHaveLength(1);
    expect(payload.filas[0][0]).toBe('A-120');
  });
});

/**
 * ANTICIPO DEVUELTO — solicitud AUTOMÁTICA que YA NO APLICA (14-oct-2026,
 * API 0.0.77, invariante 60): sale de `data`/`count`/`por_facturar`, viaja en
 * el aditivo `ya_no_aplican` (lista y conteo) y no va primero ni lleva el
 * chip en el selector de «Registrar factura» (F8). Si la lectura de los
 * cobros falla ⇒ POR_FACTURAR como antes (warn).
 */
describe('FacturasEmitidasService — solicitud automática que ya no aplica (14-oct-2026, API 0.0.77)', () => {
  const V3 = 'bbbbbbbb-0000-4000-8000-000000000003';
  const NOTA_AUTO = 'Solicitada automáticamente: cobro en HSBC Pesos';
  const cobro = (
    id: string,
    vuelo_id: string,
    monto: number,
    extra: Fila = {},
  ): Fila => ({
    id,
    vuelo_id,
    monto,
    moneda: 'MXN',
    tc_usd_mxn: 17,
    cuenta_destino: 'HSBC Pesos',
    metodo_cobro: 'TRANSFERENCIA',
    ...extra,
  });
  const mundoAuto = () =>
    base({
      vuelo: [
        // Automática con el anticipo DEVUELTO en efectivo ⇒ ya no aplica.
        vuelo(V1, 341, {
          factura_solicitada_at: '2026-09-20T09:00:00Z',
          factura_solicitada_por: ITZI,
          factura_solicitud_nota: NOTA_AUTO,
        }),
        // Automática con el dinero en HSBC ⇒ sigue por facturar.
        vuelo(V2, 342, {
          fecha_vuelo: '2026-09-28T14:00:00+00:00',
          factura_solicitada_at: '2026-09-24T09:00:00Z',
          factura_solicitada_por: ITZI,
          factura_solicitud_nota: NOTA_AUTO,
        }),
        // MANUAL con el dinero devuelto ⇒ sigue por facturar (la decidió una persona).
        vuelo(V3, 343, {
          factura_solicitada_at: '2026-09-25T09:00:00Z',
          factura_solicitada_por: ITZI,
          factura_solicitud_nota: 'La pidió el cliente',
        }),
      ],
      cobro_vuelo: [
        cobro('c-1', V1, 30000),
        cobro('r-1', V1, -30000, {
          cuenta_destino: null,
          metodo_cobro: 'EFECTIVO',
        }),
        cobro('c-2', V2, 30000),
        cobro('c-3', V3, 30000),
        cobro('r-3', V3, -30000, {
          cuenta_destino: null,
          metodo_cobro: 'EFECTIVO',
        }),
      ],
    });

  it('lista: la automática que ya no aplica va en `ya_no_aplican` (misma forma) y fuera de `data`/`count`; la manual sigue', async () => {
    const { svc } = armar(mundoAuto());
    const r = await svc.porFacturar();
    expect(r.data.map((x) => x.vuelo.folio)).toEqual([342, 343]);
    expect(r.count).toBe(2);
    expect(r.marcados_sin_registro).toEqual([]);
    expect(r.ya_no_aplican.map((x) => x.vuelo.folio)).toEqual([341]);
    expect(Object.keys(r.ya_no_aplican[0])).toEqual(Object.keys(r.data[0]));
    expect(r.ya_no_aplican[0].solicitud).toMatchObject({ nota: NOTA_AUTO });
    expect(Object.keys(r)).toEqual([
      'data',
      'count',
      'marcados_sin_registro',
      'ya_no_aplican',
    ]);
  });

  it('conteo: { por_facturar, paga_contra_factura, marcados_sin_registro, ya_no_aplican } (el badge sigue leyendo solo por_facturar)', async () => {
    const { svc } = armar(mundoAuto());
    expect(await svc.conteoPorFacturar()).toEqual({
      por_facturar: 2,
      paga_contra_factura: 0,
      marcados_sin_registro: 0,
      ya_no_aplican: 1,
    });
  });

  it('si la lectura de los cobros falla ⇒ cuentan como POR_FACTURAR (como antes) y queda un warn', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { svc, db } = armar(mundoAuto());
      const servicio = db.supabase.service as unknown as {
        from: (t: string) => unknown;
      };
      const original = servicio.from;
      servicio.from = (t: string) => {
        if (t === 'cobro_vuelo') throw new Error('timeout');
        return original(t);
      };
      expect(await svc.conteoPorFacturar()).toEqual({
        por_facturar: 3,
        paga_contra_factura: 0,
        marcados_sin_registro: 0,
        ya_no_aplican: 0,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('cuentan como «Por facturar», como antes'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('vuelosCandidatos (F8): sin búsqueda la automática que ya no aplica NO va primero y su `solicitud` es false', async () => {
    const { svc } = armar(mundoAuto());
    const vacio = await svc.vuelosCandidatos({});
    expect(vacio.slice(0, 2).map((v) => [v.folio, v.solicitud])).toEqual([
      [342, true],
      [343, true],
    ]);
    const v341 = vacio.find((v) => v.folio === 341)!;
    expect(v341.solicitud).toBe(false);
    // Por ids también: el chip ámbar sale solo de lo que cuenta.
    const ids = await svc.vuelosCandidatos({ ids: `${V1},${V2}` });
    expect(ids.map((v) => [v.folio, v.solicitud])).toEqual([
      [341, false],
      [342, true],
    ]);
  });
});

describe('FacturasEmitidasService — cobro_ids (facturas por cobro, 16-oct-2026, invariante 84)', () => {
  const F0420 = 'f-0420';
  // Los ids de cobro viajan como UUID (el DTO los valida).
  const C = (n: string) => `cccccccc-0000-4000-8000-0000000000${n}`;
  const c1 = C('c1');
  const c2 = C('c2');
  const c3 = C('c3');
  const c4 = C('c4');
  const c5 = C('c5');
  const cobroFila = (
    id: string,
    vuelo_id: string,
    monto: number,
    extra: Fila = {},
  ): Fila => ({
    id,
    vuelo_id,
    monto: String(monto),
    moneda: 'MXN',
    metodo_cobro: 'TRANSFERENCIA',
    cuenta_destino: 'Scotiabank Pesos',
    fecha_cobro: '2026-09-21T17:00:00Z',
    cobro_grupo_id: null,
    factura_emitida_id: null,
    tc_usd_mxn: '17.4',
    ...extra,
  });
  /** #341 como el #332 de prod: 4 cobros MXN y A-0420 (68,208) que ampara el de 68,208. */
  const mundo332 = (extra: Record<string, Fila[]> = {}) =>
    base({
      factura_emitida: [
        facturaFila(F0420, 'A', '0420', {
          moneda: 'MXN',
          total: '68208.00',
          subtotal: null,
          iva: null,
        }),
      ],
      factura_emitida_vuelo: [{ factura_id: F0420, vuelo_id: V1 }],
      cobro_vuelo: [
        cobroFila(c1, V1, 68208, { factura_emitida_id: F0420 }),
        cobroFila(c2, V1, 977.45, { fecha_cobro: '2026-09-15T17:00:00Z' }),
        cobroFila(c3, V1, 1700),
        cobroFila(c4, V1, 1700, { fecha_cobro: '2026-09-21T18:00:00Z' }),
        cobroFila(c5, V2, 5000),
      ],
      ...extra,
    });
  const segunda = (d: Record<string, unknown> = {}) =>
    datos({
      folio: '0455',
      moneda: 'MXN',
      total: 4377.45,
      vuelo_ids: [V1],
      emisora_id: EM1,
      ...d,
    });
  const codes = (avisos: Array<{ code: string }>) => avisos.map((a) => a.code);
  const facturaDe = (db: ReturnType<typeof fakeDb>, id: string) =>
    db.tablas.cobro_vuelo.find((c) => c.id === id)?.factura_emitida_id;

  it('crear con casillas: UN UPDATE liga los 3 cobros, la respuesta trae cobros[] y cobros_n, y NO avisa VUELO_CON_OTRA_FACTURA ni TOTAL_DISTINTO_*', async () => {
    const { svc, db } = armar(mundo332());
    const r = await svc.crear(
      segunda({ cobro_ids: [c2, c3, c4] }),
      { pdf: [PDF()] },
      actor,
    );
    const id = r.factura.id;
    expect([c2, c3, c4].map((c) => facturaDe(db, c))).toEqual([id, id, id]);
    expect(facturaDe(db, c1)).toBe(F0420);
    expect(
      r.factura.cobros.map((c) => [c.id, c.vuelo_folio, c.monto, c.moneda]),
    ).toEqual([
      [c2, 341, 977.45, 'MXN'],
      [c3, 341, 1700, 'MXN'],
      [c4, 341, 1700, 'MXN'],
    ]);
    expect(r.factura.vuelos[0]).toMatchObject({
      cobros_n: 3,
      cobros_sin_factura: 0,
    });
    expect(r.factura.alertas).toEqual([]);
    expect(r.factura.alertas_detalle).toEqual([]);
    expect(codes(r.avisos)).toEqual(
      expect.not.arrayContaining([
        'VUELO_CON_OTRA_FACTURA',
        'TOTAL_DISTINTO_VUELO',
        'TOTAL_DISTINTO_COBROS',
        'COBROS_SIN_FACTURA',
      ]),
    );
    // Con un total que no cuadra con lo marcado: TOTAL_DISTINTO_COBROS (no el del vuelo).
    const otra = armar(mundo332());
    const t = await otra.svc.crear(
      segunda({ folio: '0456', total: 4500, cobro_ids: [c2, c3, c4] }),
      { pdf: [PDF()] },
      actor,
    );
    expect(t.avisos).toContainEqual(
      expect.objectContaining({
        code: 'TOTAL_DISTINTO_COBROS',
        mensaje:
          'La factura A-0456 suma $4,500 MXN y los cobros que marcaste suman $4,377.45 MXN (3 cobros). Revisa el total o las casillas.',
      }),
    );
    expect(codes(t.avisos)).not.toContain('TOTAL_DISTINTO_VUELO');
  });

  it('cobro_ids AUSENTE ⇒ ni UPDATE ni COBROS_SIN_FACTURA; VUELO_CON_OTRA_FACTURA con el texto nuevo y el registro marca SIN_COBRO_ASIGNADO', async () => {
    const { svc, db } = armar(mundo332());
    const r = await svc.crear(segunda(), { pdf: [PDF()] }, actor);
    expect([c2, c3, c4].map((c) => facturaDe(db, c))).toEqual([
      null,
      null,
      null,
    ]);
    expect(codes(r.avisos)).not.toContain('COBROS_SIN_FACTURA');
    expect(r.avisos).toContainEqual(
      expect.objectContaining({
        code: 'VUELO_CON_OTRA_FACTURA',
        mensaje:
          'El vuelo #341 ya tiene la factura A-0420 vigente. Si esta cubre otros cobros del mismo vuelo, asígnaselos en «¿Qué cobros cubre?»; si es una re-emisión, cancela la anterior.',
      }),
    );
    expect(r.factura.alertas).toContain('DUPLICADO_VUELO');
    expect(r.factura.alertas_detalle).toEqual([
      {
        code: 'DUPLICADO_VUELO',
        motivo: 'SIN_COBRO_ASIGNADO',
        vuelo_folio: 341,
        mensaje:
          'El vuelo #341 tiene 2 facturas vigentes y A-0455 no ampara ningún cobro: asígnale los suyos o cancélala si es una re-emisión.',
      },
    ]);
    expect(r.factura.vuelos[0]).toMatchObject({
      cobros_n: 0,
      cobros_sin_factura: 3,
    });
  });

  it('cobro_ids `[]` ⇒ sin UPDATE y UN solo COBROS_SIN_FACTURA con los 12 vuelos adentro', async () => {
    const vuelos = Array.from({ length: 12 }, (_, i) =>
      vuelo(
        `bbbbbbbb-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
        400 + i,
      ),
    );
    const { svc, db } = armar(
      base({
        vuelo: vuelos,
        cobro_vuelo: vuelos.map((v, i) =>
          cobroFila(`g${i}`, v.id as string, 1000),
        ),
      }),
    );
    const r = await svc.crear(
      datos({
        moneda: 'MXN',
        total: 12000,
        vuelo_ids: vuelos.map((v) => v.id),
        cobro_ids: [],
        emisora_id: EM1,
      }),
      { pdf: [PDF()] },
      actor,
    );
    expect(
      db.tablas.cobro_vuelo.every((c) => c.factura_emitida_id === null),
    ).toBe(true);
    const sin = r.avisos.filter((a) => a.code === 'COBROS_SIN_FACTURA');
    expect(sin).toHaveLength(1);
    expect(sin[0].mensaje).toBe(
      'Quedan cobros sin factura asignada: #400 (1 cobro · $1,000 MXN), #401 (1 cobro · $1,000 MXN), #402 (1 cobro · $1,000 MXN), #403 (1 cobro · $1,000 MXN), #404 (1 cobro · $1,000 MXN) y 7 vuelos más.',
    );
    expect((sin[0].details as { vuelos: unknown[] }).vuelos).toHaveLength(12);
  });

  it('sin la sonda: cobro_ids no vacío ⇒ 503 ANTES de subir archivos; sin cobro_ids todo sigue igual (cobros [] y cobros_n 0)', async () => {
    const { svc, db } = armar(mundo332(), { cobroFactura: false });
    const r = await codigoDe(
      svc.crear(segunda({ cobro_ids: [c2] }), { pdf: [PDF()] }, actor),
    );
    expect(r.status).toBe(503);
    expect(r.code).toBe('COBRO_FACTURA_NO_DISPONIBLE');
    expect(db.subidos).toEqual([]);
    expect(db.tablas.factura_emitida).toHaveLength(1);
    const ok = await svc.crear(segunda(), { pdf: [PDF()] }, actor);
    expect(ok.factura.cobros).toEqual([]);
    expect(ok.factura.vuelos[0]).toMatchObject({
      cobros_n: 0,
      cobros_sin_factura: 0,
    });
    expect(ok.factura.alertas).toEqual([]);
    const cand = await svc.vuelosCandidatos({ ids: V1 });
    expect('cobros' in cand[0]).toBe(false);
  });

  it('validación: ya amparado por OTRA ⇒ 409 COBRO_CON_OTRA_FACTURA; de otro vuelo ⇒ 400; inexistente ⇒ 400; nada se sube', async () => {
    const { svc, db } = armar(mundo332());
    const otra = await codigoDe(
      svc.crear(segunda({ cobro_ids: [c1] }), { pdf: [PDF()] }, actor),
    );
    expect(otra.status).toBe(409);
    expect(otra.code).toBe('COBRO_CON_OTRA_FACTURA');
    expect(otra.body.message).toBe(
      'El cobro de $68,208 MXN del vuelo #341 ya tiene la factura A-0420. Quítaselo desde esa factura (Editar → ¿Qué cobros cubre?) o cámbialo desde el cobro en el vuelo.',
    );
    expect(otra.body.details).toEqual({
      cobro_id: c1,
      factura: { id: F0420, etiqueta: 'A-0420' },
    });
    const ajeno = await codigoDe(
      svc.crear(segunda({ cobro_ids: [c5] }), { pdf: [PDF()] }, actor),
    );
    expect(ajeno.code).toBe('COBROS_DE_OTRO_VUELO');
    expect(ajeno.body.message).toBe(
      'El cobro de $5,000 MXN del vuelo #342 no es de ninguno de los vuelos de esta factura. Agrega ese vuelo en «Vuelos» y vuelve a marcarlo.',
    );
    expect(
      (
        await codigoDe(
          svc.crear(
            segunda({
              cobro_ids: [c2, '99999999-0000-4000-8000-000000000000'],
            }),
            { pdf: [PDF()] },
            actor,
          ),
        )
      ).code,
    ).toBe('COBROS_NO_EXISTEN');
    expect(db.subidos).toEqual([]);
  });

  it('editar REEMPLAZA el conjunto en orden (ligas de vuelos → salen → entran); un fallo de «entran» responde 409 «La factura se guardó, pero…»', async () => {
    const { svc, db } = armar(mundo332());
    const r = await svc.editar(
      F0420,
      JSON.stringify({ vuelo_ids: [V1, V2], cobro_ids: [c2, c5] }),
      undefined,
      actor,
    );
    expect([c1, c2, c5].map((c) => facturaDe(db, c))).toEqual([
      null,
      F0420,
      F0420,
    ]);
    expect(
      r.factura.vuelos.map((v) => [v.folio, v.cobros_n, v.cobros_sin_factura]),
    ).toEqual([
      [341, 1, 3],
      [342, 1, 0],
    ]);
    expect(r.factura.cobros.map((c) => c.id)).toEqual([c2, c5]);
    // Mismo conjunto reenviado: nada cambia y no hay TOTAL_DISTINTO_VUELO (amparó cobros).
    const igual = await svc.editar(
      F0420,
      JSON.stringify({ cobro_ids: [c2, c5], notas: 'sin cambio' }),
      undefined,
      actor,
    );
    expect(codes(igual.avisos)).not.toContain('TOTAL_DISTINTO_VUELO');
    expect(codes(igual.avisos)).toContain('TOTAL_DISTINTO_COBROS');
    // Fallo del UPDATE de «entran»: la factura ya quedó guardada.
    const falla = armar(mundo332(), {
      fallar: [{ tabla: 'cobro_vuelo', op: 'update' }],
    });
    const e = await codigoDe(
      falla.svc.editar(
        F0420,
        JSON.stringify({ cobro_ids: [c1, c2], notas: 'guardada' }),
        undefined,
        actor,
      ),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe('COBROS_NO_ASIGNADOS');
    expect(String(e.body.message)).toMatch(
      /^La factura se guardó, pero no se pudieron asignar los cobros: .* Vuelve a intentarlo desde Editar\.$/,
    );
    expect(falla.db.tablas.factura_emitida[0].notas).toBe('guardada');
    // Una CANCELADA no recibe cobros.
    const canc = armar(
      mundo332({
        factura_emitida: [
          facturaFila(F0420, 'A', '0420', {
            moneda: 'MXN',
            total: '68208.00',
            estatus: 'CANCELADA',
            cancelada_at: '2026-10-01T10:00:00Z',
            motivo_cancelacion: 'prueba',
          }),
        ],
      }),
    );
    expect(
      (
        await codigoDe(
          canc.svc.editar(
            F0420,
            JSON.stringify({ cobro_ids: [c2] }),
            undefined,
            actor,
          ),
        )
      ).code,
    ).toBe('FACTURA_NO_VIGENTE');
  });

  it('carrera (revisión 16-oct): un cobro marcado recibe OTRA factura entre la validación y el UPDATE ⇒ no se pisa; crear deshace todo con 409 COBRO_CON_OTRA_FACTURA y editar responde 409 COBROS_NO_ASIGNADOS con el id', async () => {
    // El trigger A no mira si el cobro ya tenía factura: el UPDATE del
    // service solo liga los que siguen en null y compara el conteo.
    const simularCarrera = (svc: unknown, db: ReturnType<typeof fakeDb>) => {
      const privado = svc as {
        cobrosValidadosParaFactura: (p: unknown) => Promise<unknown>;
      };
      const original = privado.cobrosValidadosParaFactura.bind(privado);
      jest
        .spyOn(privado, 'cobrosValidadosParaFactura')
        .mockImplementation(async (p: unknown) => {
          const r = await original(p);
          // Otra pestaña liga c3 a otra factura justo después de validar.
          db.tablas.cobro_vuelo.find((c) => c.id === c3)!.factura_emitida_id =
            'f-otra';
          return r;
        });
    };
    const alta = armar(mundo332());
    simularCarrera(alta.svc, alta.db);
    const e = await codigoDe(
      alta.svc.crear(
        segunda({ cobro_ids: [c2, c3, c4] }),
        { pdf: [PDF()] },
        actor,
      ),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe('COBRO_CON_OTRA_FACTURA');
    expect(e.body.details).toEqual({ cobro_ids: [c3] });
    // Se deshizo todo: la factura no existe, c2/c4 volvieron a null y c3 conserva la otra.
    expect(
      alta.db.tablas.factura_emitida.map((f) => f.folio as string),
    ).toEqual(['0420']);
    expect([c2, c3, c4].map((c) => facturaDe(alta.db, c))).toEqual([
      null,
      'f-otra',
      null,
    ]);

    const edicion = armar(mundo332());
    simularCarrera(edicion.svc, edicion.db);
    const e2 = await codigoDe(
      edicion.svc.editar(
        F0420,
        JSON.stringify({ cobro_ids: [c1, c2, c3], notas: 'guardada' }),
        undefined,
        actor,
      ),
    );
    expect(e2.status).toBe(409);
    expect(e2.code).toBe('COBROS_NO_ASIGNADOS');
    expect(String(e2.body.message)).toBe(
      'La factura se guardó, pero no se pudieron asignar los cobros: Uno de los cobros marcados acaba de recibir otra factura (o ya no existe). Vuelve a intentarlo desde Editar.',
    );
    expect(e2.body.details).toEqual({ factura_id: F0420, cobro_ids: [c3] });
    expect(edicion.db.tablas.factura_emitida[0].notas).toBe('guardada');
    expect([c1, c2, c3].map((c) => facturaDe(edicion.db, c))).toEqual([
      F0420,
      F0420,
      'f-otra',
    ]);
  });

  it('quitar un vuelo suelta sus cobros y avisa COBROS_DESLIGADOS; cancelar y eliminar avisan con n; reactivar NO re-liga y avisa COBROS_SIN_FACTURA con el remate', async () => {
    const quita = armar(mundo332());
    const r = await quita.svc.editar(
      F0420,
      JSON.stringify({ vuelo_ids: [V2] }),
      undefined,
      actor,
    );
    expect(facturaDe(quita.db, c1)).toBeNull();
    expect(r.avisos[0]).toEqual({
      code: 'COBROS_DESLIGADOS',
      mensaje: 'Al quitar el vuelo #341, 1 cobro quedó sin factura asignada.',
      details: { vuelo_id: V1, cobro_ids: [c1] },
    });

    const { svc, db } = armar(mundo332());
    const c = await svc.cancelar(F0420, 'Re-emitida', actor);
    expect(c.avisos).toContainEqual({
      code: 'COBROS_DESLIGADOS',
      mensaje:
        'La factura A-0420 amparaba 1 cobro (#341); quedó sin factura asignada.',
      details: { cobro_ids: [c1], vuelo_ids: [V1] },
    });
    expect(facturaDe(db, c1)).toBeNull();
    const re = await svc.reactivar(F0420, actor);
    expect(facturaDe(db, c1)).toBeNull();
    expect(re.avisos).toEqual([
      expect.objectContaining({
        code: 'COBROS_SIN_FACTURA',
        mensaje:
          'Quedan cobros sin factura asignada: #341 (4 cobros · $72,585.45 MXN). Vuelve a asignarlos desde Editar → ¿Qué cobros cubre?',
      }),
    ]);

    const baja = armar(mundo332());
    const e = await baja.svc.eliminar(F0420, 'Capturada doble', actor);
    expect(codes(e.avisos)).toContain('COBROS_DESLIGADOS');
    expect(facturaDe(baja.db, c1)).toBeNull();
  });

  it('lista y detalle traen cobros[] y alertas_detalle[]; el Excel suma «Cobros que ampara»; los candidatos por ids traen `cobros` con su factura', async () => {
    const { svc, generateTablaXlsx } = armar(mundo332());
    const l = await svc.lista({ limit: 100, offset: 0 });
    expect(l.data[0].cobros).toEqual([
      {
        id: c1,
        vuelo_id: V1,
        vuelo_folio: 341,
        monto: 68208,
        moneda: 'MXN',
        fecha_cobro: '2026-09-21T17:00:00Z',
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'Scotiabank Pesos',
      },
    ]);
    expect(l.data[0].alertas_detalle).toEqual([]);
    expect(l.data[0].vuelos[0]).toMatchObject({
      cobros_n: 1,
      cobros_sin_factura: 3,
    });
    expect((await svc.obtener(F0420)).cobros.map((c) => c.id)).toEqual([c1]);
    await svc.exportXlsx({});
    const payload = (
      generateTablaXlsx.mock.calls as unknown as Array<
        [{ columnas: Array<{ label: string }>; filas: unknown[][] }]
      >
    )[0][0];
    expect(payload.columnas.at(-1)?.label).toBe('Cobros que ampara');
    expect(payload.filas[0].at(-1)).toBe('#341: $68,208 MXN (21 sep 2026)');
    const cand = await svc.vuelosCandidatos({ ids: V1 });
    expect(cand[0].cobros?.map((c) => [c.id, c.factura])).toEqual([
      [c2, null],
      [c1, { id: F0420, etiqueta: 'A-0420' }],
      [c3, null],
      [c4, null],
    ]);
  });
});
