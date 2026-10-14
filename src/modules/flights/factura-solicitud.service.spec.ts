jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import { HttpException, Logger } from '@nestjs/common';
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
    q.range = () => q;
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

/**
 * Cobro de `cobro_vuelo` (el que dispara la solicitud ya está escrito cuando
 * corre el gancho): desde el 0.0.77 el VUELO también debe exigir factura.
 */
const cobroFila = (
  id: string,
  vuelo_id: string,
  monto: number,
  extra: Fila = {},
): Fila => ({
  id,
  vuelo_id,
  monto,
  moneda: 'MXN',
  tc_usd_mxn: 17.3,
  cuenta_destino: 'HSBC Pesos',
  metodo_cobro: 'TRANSFERENCIA',
  ...extra,
});

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

describe('FacturaSolicitudService — estatus manual «Facturado» (13-oct-2026, caso #376, invariante 65)', () => {
  it('pedida, sin factura registrada y marcada «Facturado» a mano ⇒ bloque marcado_sin_registro, fuera de «por facturar»; el select del vuelo lee factura_estatus', async () => {
    const { svc, db } = armar({
      vuelo: [
        vuelo(V1, 376, {
          factura_solicitada_at: '2026-10-05T20:07:46Z',
          factura_solicitada_por: ITZI,
          factura_estatus: 'FACTURADO',
        }),
      ],
    });
    // Captura los SELECT de filas de vuelo (las que traen `facturado`).
    const selects: string[] = [];
    const servicio = db.supabase.service as unknown as {
      from: (t: string) => Record<string, unknown>;
    };
    const fromOriginal = servicio.from;
    servicio.from = (t: string) => {
      const q = fromOriginal(t);
      const sel = q.select as (s: string) => unknown;
      q.select = (c: string) => {
        if (t === 'vuelo' && c.includes('facturado')) selects.push(c);
        return sel(c);
      };
      return q;
    };
    const b = await svc.bloqueDeVuelo(V1);
    expect(b).toMatchObject({
      por_facturar: false,
      marcado_sin_registro: true,
      facturas: [],
      canceladas: 0,
    });
    expect(b?.solicitud?.solicitada_por).toEqual({ id: ITZI, nombre: 'Itzi' });
    expect((await svc.resumenesDeVuelos([V1])).get(V1)).toEqual({
      solicitada: true,
      por_facturar: false,
      paga_contra_factura: false,
      facturas: 0,
    });
    expect(selects.length).toBeGreaterThan(0);
    for (const c of selects) expect(c).toContain('factura_estatus');
  });

  it('control: el MISMO vuelo con SIN_FACTURA sigue por facturar y sin la marca', async () => {
    const { svc } = armar({
      vuelo: [
        vuelo(V1, 376, {
          factura_solicitada_at: '2026-10-05T20:07:46Z',
          factura_solicitada_por: ITZI,
          factura_estatus: 'SIN_FACTURA',
        }),
      ],
    });
    expect(await svc.bloqueDeVuelo(V1)).toMatchObject({
      por_facturar: true,
      marcado_sin_registro: false,
    });
  });

  it('retirar: el bloque devuelto (sin solicitud) trae marcado_sin_registro: false', async () => {
    const { svc } = armar({
      vuelo: [
        vuelo(V1, 341, { factura_solicitada_at: '2026-09-20T10:00:00Z' }),
      ],
    });
    const r = await svc.retirar(V1, actor);
    expect(r.factura_servicio).toMatchObject({
      solicitud: null,
      por_facturar: false,
      marcado_sin_registro: false,
    });
  });
});

describe('FacturaSolicitudService.solicitarPorCobro (13-oct-2026, invariante 60)', () => {
  const HSBC = {
    monto: 8050.4,
    cuenta_destino: 'HSBC Pesos',
    metodo_cobro: 'TRANSFERENCIA',
  };

  it('crea la solicitud con la nota exacta, el actor como solicitante, paga=false, UN aviso con data.origen COBRO y cobro_id; excluye al actor', async () => {
    const { svc, db, notifyUser, destinatariosFacturacion } = armar({
      vuelo: [vuelo(V1, 341)],
      cobro_vuelo: [cobroFila('c-1', V1, 8050.4)],
    });
    const r = await svc.solicitarPorCobro({
      vueloIds: [V1],
      cobro: HSBC,
      actorId: ITZI,
      cobroId: 'c-1',
    });
    expect(r).toEqual({ solicitados: [341], notificados: ['Mary Cruz'] });
    expect(db.tablas.vuelo[0]).toMatchObject({
      factura_solicitada_por: ITZI,
      factura_solicitud_nota: 'Solicitada automáticamente: cobro en HSBC Pesos',
      factura_paga_contra_factura: false,
      updated_by: ITZI,
    });
    expect(typeof db.tablas.vuelo[0].factura_solicitada_at).toBe('string');
    const upd = db.updates.filter((u) => u.tabla === 'vuelo');
    expect(upd).toHaveLength(1);
    expect(upd[0].ids).toEqual([V1]);
    expect(destinatariosFacturacion).toHaveBeenCalledWith(ITZI);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser).toHaveBeenCalledWith(MARY, {
      tipo: 'factura_solicitada',
      titulo: 'Factura pendiente: vuelo #341',
      cuerpo:
        'Cobro en HSBC Pesos registrado por Itzi: el vuelo #341 necesita factura · Maqar · 27 sep · Total $8,050.40 USD.',
      link: `/admin/facturas-emitidas?resaltar=${V1}#por-facturar`,
      data: {
        vuelo_id: V1,
        folio: 341,
        paga_contra_factura: false,
        origen: 'COBRO',
        cobro_id: 'c-1',
        cobro_grupo_id: null,
      },
    });
  });

  it('IDEMPOTENTE: la segunda llamada no escribe ni re-avisa (SIN_CANDIDATOS)', async () => {
    const { svc, db, notifyUser } = armar({
      vuelo: [vuelo(V1, 341)],
      cobro_vuelo: [cobroFila('c-1', V1, 8050.4)],
    });
    await svc.solicitarPorCobro({ vueloIds: [V1], cobro: HSBC, actorId: ITZI });
    const r = await svc.solicitarPorCobro({
      vueloIds: [V1],
      cobro: HSBC,
      actorId: MARY,
      cobroId: 'c-2',
    });
    expect(r).toEqual({
      solicitados: [],
      notificados: [],
      motivo: 'SIN_CANDIDATOS',
    });
    expect(db.updates.filter((u) => u.tabla === 'vuelo')).toHaveLength(1);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(db.tablas.vuelo[0].factura_solicitada_por).toBe(ITZI);
  });

  it('vuelo con solicitud PREVIA («Necesito factura») ⇒ nota intacta y 0 avisos', async () => {
    const { svc, db, notifyUser } = armar({
      vuelo: [
        vuelo(V1, 341, {
          factura_solicitada_at: '2026-09-20T10:00:00Z',
          factura_solicitada_por: MARY,
          factura_solicitud_nota: 'Lo pide para pagar',
          factura_paga_contra_factura: true,
        }),
      ],
    });
    const r = await svc.solicitarPorCobro({
      vueloIds: [V1],
      cobro: HSBC,
      actorId: ITZI,
    });
    expect(r.motivo).toBe('SIN_CANDIDATOS');
    expect(db.updates).toHaveLength(0);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(db.tablas.vuelo[0]).toMatchObject({
      factura_solicitada_por: MARY,
      factura_solicitud_nota: 'Lo pide para pagar',
      factura_paga_contra_factura: true,
    });
  });

  it('con factura REGISTRADA (emitida VIGENTE / CFDI / folio / estatus FACTURADO) o CANCELADO ⇒ nada que pedir', async () => {
    const emitida = {
      id: 'f-1',
      serie: 'A',
      folio: '0424',
      folio_num: 424,
      uuid: null,
      fecha_emision: '2026-09-24',
      estatus: 'VIGENTE',
      total: '8050.40',
      moneda: 'USD',
      metodo_pago: 'PPD',
      pdf_path: 'emitidas/f-1/a.pdf',
      xml_path: null,
      deleted_at: null,
    };
    const casos: Array<[string, Record<string, Fila[]>]> = [
      [
        'emitida VIGENTE',
        {
          vuelo: [vuelo(V1, 341)],
          factura_emitida: [emitida],
          factura_emitida_vuelo: [{ factura_id: 'f-1', vuelo_id: V1 }],
        },
      ],
      [
        'CFDI vivo',
        {
          vuelo: [vuelo(V1, 341, { facturado: true })],
          factura: [
            { vuelo_id: V1, serie: 'VT', folio: '5', estado: 'TIMBRADA' },
          ],
        },
      ],
      ['folio tecleado', { vuelo: [vuelo(V1, 341, { factura_folio: 'A-1' })] }],
      [
        'estatus FACTURADO',
        { vuelo: [vuelo(V1, 341, { factura_estatus: 'FACTURADO' })] },
      ],
      ['CANCELADO', { vuelo: [vuelo(V1, 341, { estado: 'CANCELADO' })] }],
    ];
    for (const [nombre, datos] of casos) {
      // Con el cobro en HSBC ya escrito (el vuelo SÍ exige): lo que lo deja
      // fuera es la factura registrada o el estado.
      const { svc, db, notifyUser } = armar({
        ...datos,
        cobro_vuelo: [cobroFila('c-1', V1, 8050.4)],
      });
      const r = await svc.solicitarPorCobro({
        vueloIds: [V1],
        cobro: HSBC,
        actorId: ITZI,
      });
      expect([nombre, r]).toEqual([
        nombre,
        { solicitados: [], notificados: [], motivo: 'SIN_CANDIDATOS' },
      ]);
      expect([nombre, db.updates.length]).toEqual([nombre, 0]);
      expect([nombre, notifyUser.mock.calls.length]).toEqual([nombre, 0]);
      expect([nombre, db.tablas.vuelo[0].factura_solicitada_at]).toEqual([
        nombre,
        null,
      ]);
    }
  });

  it('cobro que NO exige (BillPocket) ⇒ NO_EXIGE sin tocar la BD', async () => {
    const { svc, db, notifyUser } = armar({ vuelo: [vuelo(V1, 341)] });
    const r = await svc.solicitarPorCobro({
      vueloIds: [V1],
      cobro: { monto: 100, metodo_cobro: 'BILLPOCKET' },
      actorId: ITZI,
    });
    expect(r).toEqual({ solicitados: [], notificados: [], motivo: 'NO_EXIGE' });
    expect(db.updates).toHaveLength(0);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(db.tablas.vuelo[0].factura_solicitada_at).toBeNull();
  });

  it('sin la migración ⇒ NO_DISPONIBLE sin lanzar (nunca 503 desde un cobro)', async () => {
    const { svc, db } = armar(
      { vuelo: [vuelo(V1, 341)] },
      { migracion: false },
    );
    await expect(
      svc.solicitarPorCobro({ vueloIds: [V1], cobro: HSBC, actorId: ITZI }),
    ).resolves.toEqual({
      solicitados: [],
      notificados: [],
      motivo: 'NO_DISPONIBLE',
    });
    expect(db.updates).toHaveLength(0);
  });

  it('un fallo de la BD ⇒ resuelve FALLO con warn (jamás rechaza)', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { svc, db } = armar({ vuelo: [vuelo(V1, 341)] });
      const servicio = db.supabase.service as unknown as {
        from: (t: string) => unknown;
      };
      const original = servicio.from;
      servicio.from = (t: string) => {
        if (t === 'cobro_vuelo') throw new Error('timeout');
        return original(t);
      };
      await expect(
        svc.solicitarPorCobro({
          vueloIds: [V1],
          cobro: HSBC,
          actorId: ITZI,
          cobroId: 'c-9',
        }),
      ).resolves.toEqual({ solicitados: [], notificados: [], motivo: 'FALLO' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Solicitud automática de factura falló (el cobro c-9 quedó registrado): timeout',
        ),
      );
      expect(db.updates).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('dos vuelos de un SOBRE ⇒ UN update y UNA notificación por destinatario con «grupo G-12» y cobro_grupo_id', async () => {
    const { svc, db, notifyUser } = armar({
      vuelo: [
        vuelo(V1, 341, { grupo_id: G }),
        vuelo(V2, 342, { grupo_id: G }),
        vuelo(V3, 343, { grupo_id: G }),
      ],
      vuelo_grupo: [{ id: G, folio: 12 }],
      // Las partes del sobre (copian cuenta y método del sobre).
      cobro_vuelo: [
        cobroFila('p-1', V1, 4025.2, { cobro_grupo_id: 'sg-1' }),
        cobroFila('p-2', V2, 4025.2, { cobro_grupo_id: 'sg-1' }),
      ],
    });
    const r = await svc.solicitarPorCobro({
      vueloIds: [V1, V2],
      cobro: HSBC,
      actorId: ITZI,
      cobroGrupoId: 'sg-1',
    });
    expect(r).toEqual({ solicitados: [341, 342], notificados: ['Mary Cruz'] });
    const upd = db.updates.filter((u) => u.tabla === 'vuelo');
    expect(upd).toHaveLength(1);
    expect([...upd[0].ids].sort()).toEqual([V1, V2].sort());
    // El hermano sin parte (V3) no se toca.
    expect(db.tablas.vuelo[2].factura_solicitada_at).toBeNull();
    expect(notifyUser).toHaveBeenCalledTimes(1);
    const [, n] = notifyUser.mock.calls[0] as [string, Fila];
    expect(n.titulo).toBe('Factura pendiente: grupo G-12');
    expect(n.cuerpo).toBe(
      'Cobro en HSBC Pesos registrado por Itzi: los vuelos #341 y #342 (grupo G-12) necesitan factura · Maqar · 27 sep.',
    );
    expect(n.data).toEqual({
      vuelo_id: V1,
      folio: 341,
      paga_contra_factura: false,
      vuelo_ids: [V1, V2],
      grupo_id: G,
      origen: 'COBRO',
      cobro_id: null,
      cobro_grupo_id: 'sg-1',
    });
  });
});

/**
 * ANTICIPO DEVUELTO (14-oct-2026, API 0.0.77, invariante 60): la solicitud
 * automática solo se pide si el vuelo EXIGE; el bloque lleva la exigencia;
 * `exigenciasDeAutomaticas`; y el AVISO DE TRANSICIÓN (contrafactual, sin
 * escribir `vuelo`, nunca lanza).
 */
describe('FacturaSolicitudService — anticipo devuelto (14-oct-2026, API 0.0.77)', () => {
  const NOTA_AUTO = 'Solicitada automáticamente: cobro en HSBC Pesos';
  const automatica = (extra: Fila = {}): Fila =>
    vuelo(V1, 341, {
      factura_solicitada_at: '2026-10-01T10:00:00Z',
      factura_solicitada_por: ITZI,
      factura_solicitud_nota: NOTA_AUTO,
      tc_usd_mxn: 17.3,
      ...extra,
    });
  const devuelto = () => [
    cobroFila('c-1', V1, 30000),
    cobroFila('r-1', V1, -30000, {
      cuenta_destino: null,
      metodo_cobro: 'EFECTIVO',
    }),
  ];

  it('solicitarPorCobro sobre un vuelo cuyo dinero ya se devolvió ⇒ SIN_CANDIDATOS, sin update y el motivo en la bitácora', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    try {
      const { svc, db, notifyUser } = armar({
        vuelo: [vuelo(V1, 341)],
        cobro_vuelo: devuelto(),
      });
      // Corrigen la cuenta del cobro ya devuelto (updateCobro ⇒ gancho).
      const r = await svc.solicitarPorCobro({
        vueloIds: [V1],
        cobro: { monto: 30000, cuenta_destino: 'HSBC Pesos' },
        actorId: ITZI,
        cobroId: 'c-1',
      });
      expect(r).toEqual({
        solicitados: [],
        notificados: [],
        motivo: 'SIN_CANDIDATOS',
      });
      expect(db.updates).toHaveLength(0);
      expect(notifyUser).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(
          '#341: ya no exige factura (el dinero se devolvió o no quedó en una cuenta que la exija)',
        ),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('bloqueDeVuelo lleva exigencia, origenes_exigen y solicitud_ya_no_aplica (automática con el dinero devuelto)', async () => {
    const { svc } = armar({ vuelo: [automatica()], cobro_vuelo: devuelto() });
    const b = await svc.bloqueDeVuelo(V1);
    expect(b).toMatchObject({
      por_facturar: false,
      marcado_sin_registro: false,
      exigencia: 'NO_EXIGE',
      origenes_exigen: [],
      solicitud_ya_no_aplica: true,
    });
    const exige = armar({
      vuelo: [automatica()],
      cobro_vuelo: [cobroFila('c-1', V1, 30000)],
    });
    expect(await exige.svc.bloqueDeVuelo(V1)).toMatchObject({
      por_facturar: true,
      exigencia: 'EXIGE',
      origenes_exigen: ['en HSBC Pesos'],
      solicitud_ya_no_aplica: false,
    });
  });

  it('si la lectura de la factura falla, el bloque sale igual (exigencia null, [] y false) con un warn', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { svc, db } = armar({
        vuelo: [automatica()],
        cobro_vuelo: devuelto(),
      });
      const servicio = db.supabase.service as unknown as {
        from: (t: string) => unknown;
      };
      const original = servicio.from;
      servicio.from = (t: string) => {
        if (t === 'cobro_vuelo') throw new Error('timeout');
        return original(t);
      };
      const b = await svc.bloqueDeVuelo(V1);
      expect(b).toMatchObject({
        solicitud: { nota: NOTA_AUTO },
        por_facturar: true,
        exigencia: null,
        origenes_exigen: [],
        solicitud_ya_no_aplica: false,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('factura_servicio sin exigencia de 1 vuelo(s)'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('exigenciasDeAutomaticas: SOLO las automáticas vivas (una manual ni se lee); si falla ⇒ mapa vacío + warn', async () => {
    const { svc, db } = armar({
      vuelo: [
        automatica(),
        vuelo(V2, 342, {
          factura_solicitada_at: '2026-10-01T10:00:00Z',
          factura_solicitud_nota: 'La pidió el cliente',
        }),
      ],
      cobro_vuelo: [
        ...devuelto(),
        cobroFila('c-2', V2, 100, {
          cuenta_destino: null,
          metodo_cobro: 'EFECTIVO',
        }),
      ],
    });
    const filas = db.tablas.vuelo as unknown as Array<{ id: string }>;
    const m = await svc.exigenciasDeAutomaticas(filas);
    expect([...m.entries()]).toEqual([[V1, 'NO_EXIGE']]);
    // Sin automáticas: cero consultas.
    const servicio = db.supabase.service as unknown as {
      from: (t: string) => unknown;
    };
    const spy = jest.spyOn(servicio, 'from');
    expect((await svc.exigenciasDeAutomaticas([filas[1]])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const original = servicio.from;
      servicio.from = (t: string) => {
        if (t === 'cobro_vuelo') throw new Error('timeout');
        return original(t);
      };
      expect((await svc.exigenciasDeAutomaticas(filas)).size).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('cuentan como «Por facturar», como antes'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('resumenesDeVuelos: la automática que ya no aplica deja de ser por_facturar', async () => {
    const { svc } = armar({ vuelo: [automatica()], cobro_vuelo: devuelto() });
    expect((await svc.resumenesDeVuelos([V1])).get(V1)).toEqual({
      solicitada: true,
      por_facturar: false,
      paga_contra_factura: false,
      facturas: 0,
    });
  });

  describe('avisarCambioSolicitudAutomatica (transición, nunca el estado)', () => {
    it('reembolso que devuelve TODO ⇒ YA_NO_APLICA con tipo, título, cuerpo, link y data exactos (excluye al actor)', async () => {
      const { svc, db, notifyUser, destinatariosFacturacion } = armar({
        vuelo: [automatica()],
        cobro_vuelo: devuelto(),
      });
      const r = await svc.avisarCambioSolicitudAutomatica({
        vueloId: V1,
        actorId: MARY,
        motivo: 'REEMBOLSO',
        cambio: { tipo: 'ALTA', cobroId: 'r-1' },
      });
      expect(r).toEqual({
        transicion: 'YA_NO_APLICA',
        notificados: ['Mary Cruz'],
      });
      expect(destinatariosFacturacion).toHaveBeenCalledWith(MARY);
      expect(notifyUser).toHaveBeenCalledTimes(1);
      expect(notifyUser).toHaveBeenCalledWith(MARY, {
        tipo: 'factura_solicitud_ya_no_aplica',
        titulo: 'Ya no aplica: factura del vuelo #341',
        cuerpo:
          'Se registró la devolución del dinero del vuelo #341 · Maqar · 27 sep: un anticipo devuelto no lleva factura. Su solicitud automática salió de «Por facturar»; retírala desde ahí.',
        link: `/admin/facturas-emitidas?resaltar=${V1}#ya-no-aplican`,
        data: {
          vuelo_id: V1,
          folio: 341,
          origen: 'YA_NO_APLICA',
          motivo: 'REEMBOLSO',
          cobro_id: 'r-1',
        },
      });
      // Nunca escribe `vuelo` (el estado se reclasifica al LEER).
      expect(db.updates).toHaveLength(0);
    });

    it('un cobro nuevo que devuelve la exigencia ⇒ VUELVE_A_APLICAR (también un BillPocket: ambigüedad en la misma moneda, N14)', async () => {
      const { svc, notifyUser } = armar({
        vuelo: [automatica()],
        cobro_vuelo: [
          ...devuelto(),
          cobroFila('b-1', V1, 5000, {
            cuenta_destino: null,
            metodo_cobro: 'BILLPOCKET',
          }),
        ],
      });
      const r = await svc.avisarCambioSolicitudAutomatica({
        vueloId: V1,
        actorId: ITZI,
        motivo: 'COBRO_NUEVO',
        cambio: { tipo: 'ALTA', cobroId: 'b-1' },
      });
      expect(r.transicion).toBe('VUELVE_A_APLICAR');
      expect(notifyUser).toHaveBeenCalledWith(MARY, {
        tipo: 'factura_solicitud_vuelve_a_aplicar',
        titulo: 'Vuelve a aplicar: factura del vuelo #341',
        cuerpo:
          'Entró dinero al vuelo #341 · Maqar · 27 sep (cobro por BillPocket) y quedó en una cuenta que exige factura: su solicitud automática regresó a «Por facturar».',
        link: `/admin/facturas-emitidas?resaltar=${V1}#por-facturar`,
        data: {
          vuelo_id: V1,
          folio: 341,
          origen: 'VUELVE_A_APLICAR',
          motivo: 'COBRO_NUEVO',
          cobro_id: 'b-1',
        },
      });
    });

    it('BAJA del reembolso ⇒ VUELVE_A_APLICAR «Se eliminó un reembolso …»; CAMBIO de cuenta hacia efectivo ⇒ YA_NO_APLICA', async () => {
      const baja = armar({
        vuelo: [automatica()],
        cobro_vuelo: [cobroFila('c-1', V1, 30000)],
      });
      const rb = await baja.svc.avisarCambioSolicitudAutomatica({
        vueloId: V1,
        actorId: ITZI,
        motivo: 'COBRO_ELIMINADO',
        cambio: {
          tipo: 'BAJA',
          fila: {
            id: 'r-1',
            monto: -30000,
            moneda: 'MXN',
            tc_usd_mxn: 17.3,
            cuenta_destino: null,
            metodo_cobro: 'EFECTIVO',
          },
        },
      });
      expect(rb.transicion).toBe('VUELVE_A_APLICAR');
      const [, nb] = baja.notifyUser.mock.calls[0] as [string, Fila];
      expect(nb.cuerpo).toBe(
        'Se eliminó un reembolso del vuelo #341 · Maqar · 27 sep: quedó dinero en una cuenta que exige factura; su solicitud automática regresó a «Por facturar».',
      );
      expect(nb.data).toMatchObject({
        cobro_id: 'r-1',
        motivo: 'COBRO_ELIMINADO',
      });

      const cambio = armar({
        vuelo: [automatica()],
        cobro_vuelo: [
          cobroFila('c-1', V1, 30000, {
            cuenta_destino: null,
            metodo_cobro: 'EFECTIVO',
          }),
        ],
      });
      const rc = await cambio.svc.avisarCambioSolicitudAutomatica({
        vueloId: V1,
        actorId: ITZI,
        motivo: 'COBRO_CORREGIDO',
        cambio: {
          tipo: 'CAMBIO',
          cobroId: 'c-1',
          antes: {
            id: 'c-1',
            monto: 30000,
            cuenta_destino: 'HSBC Pesos',
            metodo_cobro: 'TRANSFERENCIA',
          },
        },
      });
      expect(rc.transicion).toBe('YA_NO_APLICA');
      const [, nc] = cambio.notifyUser.mock.calls[0] as [string, Fila];
      expect(nc.cuerpo).toBe(
        'Se corrigió un cobro del vuelo #341 · Maqar · 27 sep: ya no quedó dinero en una cuenta que exija factura. Su solicitud automática salió de «Por facturar»; retírala desde ahí.',
      );
    });

    it('sin transición ⇒ 0 avisos: un 2.º reembolso no re-avisa; un 2.º pago normal tampoco', async () => {
      const segundo = armar({
        vuelo: [automatica()],
        cobro_vuelo: [
          ...devuelto(),
          cobroFila('r-2', V1, -10, {
            cuenta_destino: null,
            metodo_cobro: 'EFECTIVO',
          }),
        ],
      });
      expect(
        await segundo.svc.avisarCambioSolicitudAutomatica({
          vueloId: V1,
          actorId: ITZI,
          motivo: 'REEMBOLSO',
          cambio: { tipo: 'ALTA', cobroId: 'r-2' },
        }),
      ).toEqual({
        transicion: null,
        notificados: [],
        motivo: 'SIN_TRANSICION',
      });
      expect(segundo.notifyUser).not.toHaveBeenCalled();
      const pago = armar({
        vuelo: [automatica()],
        cobro_vuelo: [cobroFila('c-1', V1, 1000), cobroFila('c-2', V1, 1000)],
      });
      expect(
        (
          await pago.svc.avisarCambioSolicitudAutomatica({
            vueloId: V1,
            actorId: ITZI,
            motivo: 'COBRO_NUEVO',
            cambio: { tipo: 'ALTA', cobroId: 'c-2' },
          })
        ).motivo,
      ).toBe('SIN_TRANSICION');
      expect(pago.notifyUser).not.toHaveBeenCalled();
    });

    it('manual, cancelado, FACTURADO a mano, CFDI del PAC o sin migración ⇒ nada y UNA sola consulta (la compuerta)', async () => {
      const casos: Array<[string, Fila, { migracion?: boolean }, string]> = [
        [
          'manual',
          automatica({ factura_solicitud_nota: 'La pidió el cliente' }),
          {},
          'SIN_SOLICITUD_AUTOMATICA',
        ],
        ['sin solicitud', vuelo(V1, 341), {}, 'SIN_SOLICITUD_AUTOMATICA'],
        ['cancelado', automatica({ estado: 'CANCELADO' }), {}, 'NO_APLICA'],
        [
          'FACTURADO a mano',
          automatica({ factura_estatus: 'FACTURADO' }),
          {},
          'NO_APLICA',
        ],
        ['CFDI del PAC', automatica({ facturado: true }), {}, 'NO_APLICA'],
        ['sin migración', automatica(), { migracion: false }, 'NO_DISPONIBLE'],
      ];
      for (const [nombre, v, opts, motivo] of casos) {
        const { svc, db, notifyUser } = armar(
          { vuelo: [v], cobro_vuelo: devuelto() },
          opts,
        );
        const servicio = db.supabase.service as unknown as {
          from: (t: string) => unknown;
        };
        const spy = jest.spyOn(servicio, 'from');
        const r = await svc.avisarCambioSolicitudAutomatica({
          vueloId: V1,
          actorId: ITZI,
          motivo: 'REEMBOLSO',
          cambio: { tipo: 'ALTA', cobroId: 'r-1' },
        });
        expect([nombre, r]).toEqual([
          nombre,
          { transicion: null, notificados: [], motivo },
        ]);
        expect([nombre, spy.mock.calls.map((c) => c[0])]).toEqual([
          nombre,
          ['vuelo'],
        ]);
        expect([nombre, notifyUser.mock.calls.length]).toEqual([nombre, 0]);
        spy.mockRestore();
      }
    });

    it('con factura REGISTRADA ⇒ nada (REGISTRADA); un fallo ⇒ FALLO con warn, jamás rechaza', async () => {
      const reg = armar({
        vuelo: [automatica({ factura_folio: 'A-9' })],
        cobro_vuelo: devuelto(),
      });
      expect(
        (
          await reg.svc.avisarCambioSolicitudAutomatica({
            vueloId: V1,
            actorId: ITZI,
            motivo: 'REEMBOLSO',
            cambio: { tipo: 'ALTA', cobroId: 'r-1' },
          })
        ).motivo,
      ).toBe('REGISTRADA');
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const { svc, db } = armar({
          vuelo: [automatica()],
          cobro_vuelo: devuelto(),
        });
        const servicio = db.supabase.service as unknown as {
          from: (t: string) => unknown;
        };
        const original = servicio.from;
        servicio.from = (t: string) => {
          if (t === 'cobro_vuelo') throw new Error('timeout');
          return original(t);
        };
        await expect(
          svc.avisarCambioSolicitudAutomatica({
            vueloId: V1,
            actorId: ITZI,
            motivo: 'REEMBOLSO',
            cambio: { tipo: 'ALTA', cobroId: 'r-1' },
          }),
        ).resolves.toEqual({
          transicion: null,
          notificados: [],
          motivo: 'FALLO',
        });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            `Aviso de la solicitud automática de factura falló (el dinero del vuelo ${V1} quedó registrado): timeout`,
          ),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});
