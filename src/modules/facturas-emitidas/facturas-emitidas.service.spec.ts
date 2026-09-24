// La cadena real de FlightsService/notifications arrastra googleapis y
// `jose` (ESM): se stubbean; aquí se prueba el CONTRATO del registro.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));

import { HttpException } from '@nestjs/common';
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
        for (const f of filas) Object.assign(f, payload as Fila);
        return {
          data: devolver ? filas.map((f) => ({ ...f })) : null,
          error: null,
        };
      }
      if (op === 'delete') {
        const quitar = new Set(filas);
        tablas[t] = tabla(t).filter((f) => !quitar.has(f));
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
      return q;
    };
    q.delete = () => {
      op = 'delete';
      return q;
    };
    q.eq = (c: string, v: unknown) =>
      encadenar(() =>
        filtros.push((f) => String(valorDe(f, c)) === String(v)),
      )();
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
      'El vuelo #341 ya tiene la factura A-120 vigente. Si es anticipo y finiquito está bien; si es una re-emisión, cancela la anterior.',
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
    expect(r.data.map((x) => x.vuelo.folio)).toEqual([342, 341]);
    expect(r.data[0].vuelo.estatus_manual).toBe('FACTURADO');
    expect(r.data[0].solicitud).toMatchObject({
      paga_contra_factura: true,
      solicitada_por: { id: ITZI, nombre: 'Itzi' },
    });
    expect(r.data[0].faltan_datos_fiscales).toEqual([
      'Régimen fiscal',
      'Uso de CFDI',
      'Código postal',
    ]);
    expect(await svc.conteoPorFacturar()).toEqual({
      por_facturar: 2,
      paga_contra_factura: 1,
    });
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
