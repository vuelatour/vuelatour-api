jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import { HttpException } from '@nestjs/common';
import { FacturaSolicitudService } from './factura-solicitud.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';

/**
 * «Necesito factura» (pedido de Itzi, 24-sep-2026): la solicitud es
 * IDEMPOTENTE (la segunda vez no cambia quién/cuándo ni re-avisa), en un
 * GRUPO manda UNA notificación con todos los folios, un vuelo CANCELADO
 * responde 409 y sin la migración 503. BD en memoria mínima.
 */
type Fila = Record<string, unknown>;

function fakeDb(
  datos: Record<string, Fila[]>,
  opts: { migracion?: boolean } = {},
) {
  const tablas: Record<string, Fila[]> = {};
  for (const [k, v] of Object.entries(datos))
    tablas[k] = v.map((f) => ({ ...f }));
  const tabla = (t: string) => (tablas[t] ??= []);
  const updates: Array<{ tabla: string; patch: Fila; ids: string[] }> = [];
  const from = (t: string) => {
    let op: 'select' | 'update' = 'select';
    let select = '';
    let patch: Fila = {};
    let devolver = false;
    const filtros: Array<(f: Fila) => boolean> = [];
    const ejecutar = () => {
      if (
        opts.migracion === false &&
        select.includes('factura_solicitada_at')
      ) {
        return {
          data: null,
          error: { code: '42703', message: 'column does not exist' },
        };
      }
      let filas = tabla(t).filter((f) => filtros.every((fn) => fn(f)));
      if (t === 'factura_emitida_vuelo' && select.includes('factura:')) {
        filas = filas
          .map((l) => ({
            ...l,
            factura:
              tabla('factura_emitida').find((f) => f.id === l.factura_id) ??
              null,
          }))
          .filter((l) => l.factura && l.factura.deleted_at == null);
      }
      if (op === 'update') {
        for (const f of filas) Object.assign(f, patch);
        updates.push({
          tabla: t,
          patch,
          ids: filas.map((f) => f.id as string),
        });
        return {
          data: devolver ? filas.map((f) => ({ ...f })) : null,
          error: null,
        };
      }
      return { data: filas.map((f) => ({ ...f })), error: null };
    };
    const q: Record<string, unknown> = {};
    q.select = (s: string) => {
      if (op === 'select') select = s;
      else devolver = true;
      return q;
    };
    q.update = (p: Fila) => {
      op = 'update';
      patch = p;
      return q;
    };
    q.eq = (c: string, v: unknown) => {
      filtros.push((f) => f[c] === v);
      return q;
    };
    q.neq = (c: string, v: unknown) => {
      filtros.push((f) => f[c] !== v);
      return q;
    };
    q.in = (c: string, arr: unknown[]) => {
      filtros.push((f) => arr.includes(f[c]));
      return q;
    };
    q.is = (c: string, v: unknown) => {
      if (!c.includes('.'))
        filtros.push((f) => (v === null ? f[c] == null : f[c] === v));
      return q;
    };
    q.not = (c: string, _o: string, v: unknown) => {
      filtros.push((f) => (v === null ? f[c] != null : f[c] !== v));
      return q;
    };
    q.limit = () => q;
    q.order = () => q;
    q.maybeSingle = () => {
      const r = ejecutar();
      return Promise.resolve({
        data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
        error: r.error,
      });
    };
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(ejecutar()).then(res);
    return q;
  };
  return {
    supabase: { service: { from } } as unknown as SupabaseService,
    tablas,
    updates,
  };
}

const ITZI = 'aaaaaaaa-0000-4000-8000-00000000000a';
const MARY = 'aaaaaaaa-0000-4000-8000-00000000000b';
const V1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const V2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const V3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const G = 'cccccccc-0000-4000-8000-000000000001';

const vuelo = (id: string, folio: number, extra: Fila = {}): Fila => ({
  id,
  folio,
  estado: 'CONFIRMADO',
  facturado: false,
  cliente_id: 'cli-1',
  fecha_vuelo: '2026-09-27T14:00:00Z',
  monto_total_usd: '8050.40',
  grupo_id: null,
  factura_solicitada_at: null,
  factura_solicitada_por: null,
  factura_solicitud_nota: null,
  factura_paga_contra_factura: false,
  ...extra,
});

function armar(
  datos: Record<string, Fila[]>,
  opts: { migracion?: boolean } = {},
) {
  const db = fakeDb(
    {
      cliente: [{ id: 'cli-1', nombre: 'Maqar' }],
      usuario: [
        { id: ITZI, nombre: 'Itzi' },
        { id: MARY, nombre: 'Mary Cruz' },
      ],
      factura_emitida: [],
      factura_emitida_vuelo: [],
      ...datos,
    },
    opts,
  );
  const notifyUser = jest.fn().mockResolvedValue(true);
  const destinatariosFacturacion = jest
    .fn()
    .mockResolvedValue([{ id: MARY, nombre: 'Mary Cruz' }]);
  const svc = new FacturaSolicitudService(
    db.supabase,
    { notifyUser } as unknown as NotificationsService,
    { destinatariosFacturacion } as unknown as ConfiguracionService,
  );
  return { svc, db, notifyUser, destinatariosFacturacion };
}

async function error(
  p: Promise<unknown>,
): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      return {
        status: e.getStatus(),
        code: String((e.getResponse() as Fila).error),
      };
    }
    throw e;
  }
  throw new Error('no lanzó');
}

const actor = { userId: ITZI, nombre: 'Itzi' };

describe('FacturaSolicitudService.solicitar', () => {
  it('primera vez: guarda quién/cuándo/nota, avisa a facturación y devuelve el bloque', async () => {
    const { svc, db, notifyUser, destinatariosFacturacion } = armar({
      vuelo: [vuelo(V1, 341)],
    });
    const r = await svc.solicitar(
      V1,
      { nota: '  Lo pide para pagar ', paga_contra_factura: true },
      actor,
    );
    expect(r).toMatchObject({
      nueva: true,
      vuelos: [341],
      notificados: ['Mary Cruz'],
      factura_servicio: {
        por_facturar: true,
        facturas: [],
        canceladas: 0,
        solicitud: {
          solicitada_por: { id: ITZI, nombre: 'Itzi' },
          nota: 'Lo pide para pagar',
          paga_contra_factura: true,
        },
      },
    });
    expect(destinatariosFacturacion).toHaveBeenCalledWith(ITZI);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser).toHaveBeenCalledWith(MARY, {
      tipo: 'factura_solicitada',
      titulo: 'Factura pedida: vuelo #341',
      cuerpo:
        'Itzi pidió factura del vuelo #341 · Maqar · 27 sep · Total $8,050.40 USD. El cliente paga hasta recibir la factura. Nota: Lo pide para pagar',
      link: `/admin/facturas-emitidas?resaltar=${V1}#por-facturar`,
      data: { vuelo_id: V1, folio: 341, paga_contra_factura: true },
    });
    expect(db.tablas.vuelo[0].factura_solicitada_por).toBe(ITZI);
  });

  it('IDEMPOTENTE: la segunda vez solo cambia lo que viene y NO re-avisa', async () => {
    const { svc, db, notifyUser } = armar({
      vuelo: [
        vuelo(V1, 341, {
          factura_solicitada_at: '2026-09-20T10:00:00Z',
          factura_solicitada_por: MARY,
          factura_solicitud_nota: 'vieja',
        }),
      ],
    });
    const r = await svc.solicitar(V1, { paga_contra_factura: true }, actor);
    expect(r.nueva).toBe(false);
    expect(r.vuelos).toEqual([]);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(db.tablas.vuelo[0]).toMatchObject({
      factura_solicitada_at: '2026-09-20T10:00:00Z',
      factura_solicitada_por: MARY,
      factura_solicitud_nota: 'vieja',
      factura_paga_contra_factura: true,
    });
    // nota "" la borra.
    await svc.solicitar(V1, { nota: '' }, actor);
    expect(db.tablas.vuelo[0].factura_solicitud_nota).toBeNull();
  });

  it('todo_el_grupo: hijos NO cancelados, UN update y UNA notificación por destinatario', async () => {
    const { svc, db, notifyUser } = armar({
      vuelo: [
        vuelo(V1, 341, { grupo_id: G }),
        vuelo(V2, 342, { grupo_id: G }),
        vuelo(V3, 343, { grupo_id: G, estado: 'CANCELADO' }),
      ],
      vuelo_grupo: [{ id: G, folio: 12 }],
    });
    const r = await svc.solicitar(V2, { todo_el_grupo: true }, actor);
    expect(r.vuelos).toEqual([341, 342]);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    const [, n] = notifyUser.mock.calls[0] as [string, Fila];
    expect(n.titulo).toBe('Factura pedida: grupo G-12');
    expect(n.cuerpo).toBe(
      'Itzi pidió factura de los vuelos #341 y #342 (grupo G-12) · Maqar · 27 sep.',
    );
    expect(n.data).toMatchObject({ vuelo_ids: [V1, V2], grupo_id: G });
    const upd = db.updates.filter((u) => u.tabla === 'vuelo');
    expect(upd).toHaveLength(1);
    expect(upd[0].ids.sort()).toEqual([V1, V2].sort());
    expect(db.tablas.vuelo[2].factura_solicitada_at).toBeNull();
  });

  it('vuelo CANCELADO ⇒ 409 VUELO_CANCELADO; inexistente ⇒ 404; sin migración ⇒ 503', async () => {
    const a = armar({ vuelo: [vuelo(V1, 341, { estado: 'CANCELADO' })] });
    expect(await error(a.svc.solicitar(V1, {}, actor))).toEqual({
      status: 409,
      code: 'VUELO_CANCELADO',
    });
    expect(await error(a.svc.solicitar(V2, {}, actor))).toEqual({
      status: 404,
      code: 'VUELO_NO_EXISTE',
    });
    const b = armar({ vuelo: [vuelo(V1, 341)] }, { migracion: false });
    expect(await error(b.svc.solicitar(V1, {}, actor))).toEqual({
      status: 503,
      code: 'FACTURAS_EMITIDAS_NO_DISPONIBLE',
    });
    expect(await b.svc.bloqueDeVuelo(V1)).toBeNull();
    expect((await b.svc.resumenesDeVuelos([V1])).size).toBe(0);
  });

  it('sin destinatarios (quien pide ES facturación) ⇒ se guarda y notificados = []', async () => {
    const { svc, destinatariosFacturacion, notifyUser } = armar({
      vuelo: [vuelo(V1, 341)],
    });
    destinatariosFacturacion.mockResolvedValue([]);
    const r = await svc.solicitar(V1, {}, actor);
    expect(r).toMatchObject({ nueva: true, notificados: [] });
    expect(notifyUser).not.toHaveBeenCalled();
  });
});

describe('FacturaSolicitudService.retirar y lectores', () => {
  it('retirar limpia las 4 columnas', async () => {
    const { svc, db } = armar({
      vuelo: [
        vuelo(V1, 341, {
          factura_solicitada_at: '2026-09-20T10:00:00Z',
          factura_solicitada_por: ITZI,
          factura_solicitud_nota: 'x',
          factura_paga_contra_factura: true,
        }),
      ],
    });
    const r = await svc.retirar(V1, actor);
    expect(r.factura_servicio.solicitud).toBeNull();
    expect(db.tablas.vuelo[0]).toMatchObject({
      factura_solicitada_at: null,
      factura_solicitada_por: null,
      factura_solicitud_nota: null,
      factura_paga_contra_factura: false,
    });
  });

  it('bloque: una factura VIGENTE ligada saca de «por facturar»', async () => {
    const { svc } = armar({
      vuelo: [
        vuelo(V1, 341, {
          factura_solicitada_at: '2026-09-20T10:00:00Z',
          factura_solicitada_por: ITZI,
        }),
      ],
      factura_emitida: [
        {
          id: 'f-1',
          serie: 'A',
          folio: '123',
          folio_num: '123',
          uuid: null,
          fecha_emision: '2026-09-24',
          estatus: 'VIGENTE',
          total: '8050.40',
          moneda: 'USD',
          metodo_pago: 'PPD',
          pdf_path: 'emitidas/f-1/a.pdf',
          xml_path: null,
          deleted_at: null,
        },
      ],
      factura_emitida_vuelo: [{ factura_id: 'f-1', vuelo_id: V1 }],
    });
    const b = await svc.bloqueDeVuelo(V1);
    expect(b).toMatchObject({
      por_facturar: false,
      facturas: [{ etiqueta: 'A-123', tiene_pdf: true }],
    });
    expect((await svc.resumenesDeVuelos([V1])).get(V1)).toEqual({
      solicitada: true,
      por_facturar: false,
      paga_contra_factura: false,
      facturas: 1,
    });
  });
});
