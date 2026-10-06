// Dependencias que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../profit-sharing/profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));
jest.mock('./facturacion.client', () => ({ FacturacionClient: class {} }));
jest.mock('../flights/factura-cliente.service', () => ({
  FacturaClienteService: class {},
}));

import { BadGatewayException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { NOTA_FOLIO_NO_LEGIBLE } from './recibida-folio.util';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import type { FacturacionClient } from './facturacion.client';

/**
 * SERIE/FOLIO DE LAS FACTURAS RECIBIDAS (5-oct-2026, API 0.0.57). Pedido
 * del cliente: el número de la factura en «Notas» del Excel de
 * conciliación. Aquí se congela:
 *  - el INSERT de una factura con XML guarda `serie`, `folio` y sella
 *    `folio_releido_at` (con la migración 20261005000002); sin ella, el
 *    insert es el del 0.0.56; con un pyservices viejo NO se sella;
 *  - el cron `recibidas-releer-folio` relee los XML ya guardados: rellena,
 *    sella ilegibles con nota, NO sella si pyservices está caído o viejo,
 *    lote de 50, CAS `folio_releido_at is null` y candado anti-solape.
 */

type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };

interface Mundo {
  /** Migración 20261005000002 aplicada (columna `serie`). */
  conSerie?: boolean;
  /** Filas de `factura_recibida`. */
  recibidas?: Row[];
  /** Contenido de Storage (path ⇒ texto) o error por path. */
  archivos?: Record<string, string | { error: string }>;
  /** Parser: por contenido del XML ⇒ respuesta o error. */
  parse?: (xml: string) => Promise<Row>;
}

function armar(m: Mundo = {}) {
  const db: Row[] = (m.recibidas ?? []).map((r) => ({ ...r }));
  const llamadas: Array<{ tabla: string; ops: Op[] }> = [];
  const descargas: string[] = [];
  const subidas: string[] = [];

  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      llamadas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const sel = () =>
        String(
          (ops.find((o) => o.m === 'select')?.args[0] as string | undefined) ??
            '',
        );
      const op = (nombre: string) => ops.find((o) => o.m === nombre);
      const resolver = (): { data: unknown; error: Row | null } => {
        if (tabla !== 'factura_recibida') {
          if (tabla === 'gasto') return { data: { id: 'g-1' }, error: null };
          return { data: null, error: null };
        }
        const ins = op('insert');
        const upd = op('update');
        if (
          !m.conSerie &&
          (/\bserie\b/.test(sel()) ||
            /folio_releido_at/.test(
              JSON.stringify(ins?.args[0] ?? upd?.args[0] ?? {}),
            ) ||
            ops.some((o) => o.m === 'is' && o.args[0] === 'folio_releido_at'))
        ) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column factura_recibida.serie does not exist',
            },
          };
        }
        if (ins) {
          const fila = { id: `fr-${db.length + 1}`, ...(ins.args[0] as Row) };
          db.push(fila);
          return { data: fila, error: null };
        }
        let filas = db.filter((r) =>
          ops.every((o) => {
            if (o.m === 'eq') return r[o.args[0] as string] === o.args[1];
            if (o.m === 'is') return (r[o.args[0] as string] ?? null) === null;
            if (o.m === 'not') return (r[o.args[0] as string] ?? null) !== null;
            return true;
          }),
        );
        if (upd) {
          for (const r of filas) Object.assign(r, upd.args[0] as Row);
          return { data: filas, error: null };
        }
        const lim = op('limit');
        if (lim) filas = filas.slice(0, lim.args[0] as number);
        return { data: filas, error: null };
      };
      for (const met of [
        'select',
        'eq',
        'neq',
        'in',
        'is',
        'not',
        'order',
        'limit',
        'range',
        'insert',
        'update',
      ]) {
        q[met] = (...args: unknown[]) => {
          ops.push({ m: met, args });
          return q;
        };
      }
      q.maybeSingle = () => {
        const r = resolver();
        const lista: unknown[] | null = Array.isArray(r.data)
          ? (r.data as unknown[])
          : null;
        const d: unknown = lista ? (lista[0] ?? null) : r.data;
        return Promise.resolve({ data: d, error: r.error });
      };
      q.then = (res: (v: unknown) => unknown) => {
        const r = resolver();
        return Promise.resolve({
          data: Array.isArray(r.data) ? r.data : r.data ? [r.data] : [],
          error: r.error,
        }).then(res);
      };
      return q;
    },
    storage: {
      from() {
        return {
          upload: (path: string) => {
            subidas.push(path);
            return Promise.resolve({ error: null });
          },
          download: (path: string) => {
            descargas.push(path);
            const a = m.archivos?.[path];
            if (a == null) {
              return Promise.resolve({
                data: null,
                error: { message: 'Object not found' },
              });
            }
            if (typeof a === 'object') {
              return Promise.resolve({
                data: null,
                error: { message: a.error },
              });
            }
            const buf = Buffer.from(a);
            return Promise.resolve({
              data: {
                arrayBuffer: () =>
                  Promise.resolve(
                    buf.buffer.slice(
                      buf.byteOffset,
                      buf.byteOffset + buf.byteLength,
                    ),
                  ),
              },
              error: null,
            });
          },
          remove: () => Promise.resolve({ error: null }),
        };
      },
    },
  };

  const parseFacturaRecibida = jest.fn((b64: string) => {
    const xml = Buffer.from(b64, 'base64').toString();
    return m.parse ? m.parse(xml) : Promise.resolve({});
  });
  const svc = new InvoicesService(
    { service } as unknown as SupabaseService,
    {} as FacturacionClient,
    { parseFacturaRecibida } as unknown as PyservicesService,
    {} as ProfitSharingService,
  );
  return { svc, db, llamadas, descargas, subidas, parseFacturaRecibida };
}

/** Updates a `factura_recibida` con su filtro CAS. */
const updates = (llamadas: Array<{ tabla: string; ops: Op[] }>) =>
  llamadas
    .filter(
      (l) =>
        l.tabla === 'factura_recibida' && l.ops.some((o) => o.m === 'update'),
    )
    .map((l) => ({
      patch: l.ops.find((o) => o.m === 'update')!.args[0] as Row,
      id: l.ops.find((o) => o.m === 'eq')?.args[1],
      cas: l.ops.some((o) => o.m === 'is' && o.args[0] === 'folio_releido_at'),
    }));

const b64 = (s: string) => Buffer.from(s).toString('base64');

/** Parser de prueba: el «XML» es JSON con lo que devolvería pyservices. */
const parseJson = (xml: string): Promise<Row> => {
  if (xml === 'ROTO') {
    return Promise.reject(
      new BadGatewayException(
        'pyservices respondio 422: {"detail":"El XML no es un CFDI legible"}',
      ),
    );
  }
  return Promise.resolve(JSON.parse(xml) as Row);
};

const fila = (id: string, extra: Row = {}): Row => ({
  id,
  xml_url: `recibidas/${id}.xml`,
  notas: null,
  serie: null,
  folio: null,
  folio_releido_at: null,
  created_at: '2026-09-01T00:00:00Z',
  ...extra,
});

describe('cron recibidas-releer-folio', () => {
  it('sin la migración NO hace nada (ni descarga ni parsea)', async () => {
    const { svc, descargas, parseFacturaRecibida } = armar({
      conSerie: false,
      recibidas: [fila('a')],
      archivos: { 'recibidas/a.xml': '{}' },
    });
    const r = await svc.releerFoliosRecibidas();
    expect(r).toMatchObject({ disponible: false, leidas: 0 });
    expect(descargas).toHaveLength(0);
    expect(parseFacturaRecibida).not.toHaveBeenCalled();
  });

  it('rellena serie/folio y sella; un CFDI sin Serie/Folio también se sella; solo-PDF fuera', async () => {
    const { svc, db, llamadas, descargas } = armar({
      conSerie: true,
      recibidas: [
        fila('asur', { notas: 'ASUR' }),
        fila('sin-serie'),
        fila('solo-pdf', { xml_url: null }),
        fila('ya-leida', {
          folio: '9',
          folio_releido_at: '2026-10-05T00:00:00Z',
        }),
      ],
      archivos: {
        'recibidas/asur.xml': JSON.stringify({
          uuid_fiscal: 'u-1',
          serie: 'FEACZM',
          folio: '72128',
        }),
        'recibidas/sin-serie.xml': JSON.stringify({
          uuid_fiscal: 'u-2',
          serie: null,
          folio: null,
        }),
      },
      parse: parseJson,
    });
    const r = await svc.releerFoliosRecibidas();
    expect(r).toEqual({
      disponible: true,
      leidas: 2,
      con_folio: 1,
      sin_folio: 1,
      ilegibles: 0,
      reintentar: 0,
    });
    expect(descargas).toEqual([
      'recibidas/asur.xml',
      'recibidas/sin-serie.xml',
    ]);
    const asur = db.find((x) => x.id === 'asur')!;
    expect(asur).toMatchObject({
      serie: 'FEACZM',
      folio: '72128',
      notas: 'ASUR',
    });
    expect(typeof asur.folio_releido_at).toBe('string');
    expect(db.find((x) => x.id === 'sin-serie')).toMatchObject({
      serie: null,
      folio: null,
    });
    expect(
      db.find((x) => x.id === 'sin-serie')!.folio_releido_at,
    ).not.toBeNull();
    // Solo-PDF y la ya leída: intactas.
    expect(db.find((x) => x.id === 'solo-pdf')!.folio_releido_at).toBeNull();
    expect(db.find((x) => x.id === 'ya-leida')!.folio).toBe('9');
    // Todo UPDATE lleva el CAS `folio_releido_at is null` y NO toca notas.
    const u = updates(llamadas);
    expect(u).toHaveLength(2);
    expect(u.every((x) => x.cas)).toBe(true);
    expect(u[0].patch).not.toHaveProperty('notas');
    // La consulta del lote: con XML, sin sellar, de 50 en 50.
    const lote = llamadas.find(
      (l) =>
        l.tabla === 'factura_recibida' &&
        l.ops.some((o) => o.m === 'select' && o.args[0] === 'id, xml_url'),
    )!;
    expect(lote.ops).toEqual(
      expect.arrayContaining([
        { m: 'not', args: ['xml_url', 'is', null] },
        { m: 'is', args: ['folio_releido_at', null] },
        { m: 'limit', args: [50] },
      ]),
    );
  });

  it('XML ilegible (422) ⇒ sella con «Folio no legible del XML» y sigue con la siguiente', async () => {
    const { svc, db } = armar({
      conSerie: true,
      recibidas: [fila('rota', { notas: 'Proveedor X' }), fila('buena')],
      archivos: {
        'recibidas/rota.xml': 'ROTO',
        'recibidas/buena.xml': JSON.stringify({ serie: 'A', folio: '0411' }),
      },
      parse: parseJson,
    });
    const r = await svc.releerFoliosRecibidas();
    expect(r).toMatchObject({ ilegibles: 1, con_folio: 1, reintentar: 0 });
    const rota = db.find((x) => x.id === 'rota')!;
    expect(rota.notas).toBe(`Proveedor X\n${NOTA_FOLIO_NO_LEGIBLE}`);
    expect(rota.folio_releido_at).not.toBeNull();
    expect(rota.folio).toBeNull();
    expect(db.find((x) => x.id === 'buena')).toMatchObject({
      serie: 'A',
      folio: '0411',
    });
  });

  it('XML ausente en Storage ⇒ sellado con la nota; error de red de Storage ⇒ solo se salta esa', async () => {
    const { svc, db } = armar({
      conSerie: true,
      recibidas: [fila('borrado'), fila('red'), fila('ok')],
      archivos: {
        'recibidas/red.xml': { error: 'fetch failed' },
        'recibidas/ok.xml': JSON.stringify({ serie: null, folio: '15' }),
      },
      parse: parseJson,
    });
    const r = await svc.releerFoliosRecibidas();
    expect(r).toMatchObject({
      leidas: 3,
      ilegibles: 1,
      reintentar: 1,
      con_folio: 1,
    });
    expect(db.find((x) => x.id === 'borrado')!.notas).toBe(
      NOTA_FOLIO_NO_LEGIBLE,
    );
    expect(db.find((x) => x.id === 'red')!.folio_releido_at).toBeNull();
    expect(db.find((x) => x.id === 'ok')).toMatchObject({ folio: '15' });
  });

  it('pyservices CAÍDO ⇒ no sella nada y corta la corrida tras DOS fallos seguidos (reintenta el siguiente tick)', async () => {
    const { svc, db, llamadas, parseFacturaRecibida } = armar({
      conSerie: true,
      recibidas: [fila('a'), fila('b'), fila('c')],
      archivos: {
        'recibidas/a.xml': '{}',
        'recibidas/b.xml': '{}',
        'recibidas/c.xml': '{}',
      },
      parse: () =>
        Promise.reject(
          new BadGatewayException(
            'No se pudo contactar a pyservices: ECONNREFUSED',
          ),
        ),
    });
    const r = await svc.releerFoliosRecibidas();
    expect(r).toMatchObject({ leidas: 2, reintentar: 2, ilegibles: 0 });
    expect(parseFacturaRecibida).toHaveBeenCalledTimes(2);
    expect(updates(llamadas)).toHaveLength(0);
    expect(db.every((x) => x.folio_releido_at === null)).toBe(true);
    expect(db.every((x) => x.notas === null)).toBe(true);
  });

  it('un XML que TUMBA a pyservices (5xx) no bloquea la cola: se salta y siguen las demás', async () => {
    // Revisión 5-oct-2026: el lote sale siempre en el mismo orden; antes un
    // 5xx de UNA factura cortaba la corrida y esa fila, sin sellar,
    // encabezaba todas las siguientes ⇒ ninguna otra se releía jamás.
    const tumba = (xml: string): Promise<Row> =>
      xml === 'VENENO'
        ? Promise.reject(
            new BadGatewayException(
              'pyservices respondio 500: Internal Server Error',
            ),
          )
        : parseJson(xml);
    const { svc, db } = armar({
      conSerie: true,
      recibidas: [fila('veneno'), fila('b'), fila('veneno2'), fila('c')],
      archivos: {
        'recibidas/veneno.xml': 'VENENO',
        'recibidas/b.xml': JSON.stringify({ serie: 'A', folio: '1' }),
        'recibidas/veneno2.xml': 'VENENO',
        'recibidas/c.xml': JSON.stringify({ serie: 'A', folio: '2' }),
      },
      parse: tumba,
    });
    const r = await svc.releerFoliosRecibidas();
    expect(r).toMatchObject({
      leidas: 4,
      con_folio: 2,
      ilegibles: 0,
      reintentar: 2,
    });
    // Las envenenadas NO se sellan (el siguiente tick las reintenta)…
    expect(db.find((x) => x.id === 'veneno')!.folio_releido_at).toBeNull();
    expect(db.find((x) => x.id === 'veneno2')!.folio_releido_at).toBeNull();
    expect(db.find((x) => x.id === 'veneno')!.notas).toBeNull();
    // …y las de atrás sí se leyeron (el contador se reinicia al responder).
    expect(db.find((x) => x.id === 'b')).toMatchObject({ folio: '1' });
    expect(db.find((x) => x.id === 'c')).toMatchObject({ folio: '2' });
  });

  it('422 de VALIDACIÓN de FastAPI (detail lista) NO sella: es pyservices, no el XML', async () => {
    const { svc, db, llamadas } = armar({
      conSerie: true,
      recibidas: [fila('a'), fila('b'), fila('c')],
      archivos: {
        'recibidas/a.xml': '{}',
        'recibidas/b.xml': '{}',
        'recibidas/c.xml': '{}',
      },
      parse: () =>
        Promise.reject(
          new BadGatewayException(
            'pyservices respondio 422: {"detail":[{"type":"missing","loc":["body","xml_b64"],"msg":"Field required"}]}',
          ),
        ),
    });
    const r = await svc.releerFoliosRecibidas();
    expect(r).toMatchObject({ leidas: 2, reintentar: 2, ilegibles: 0 });
    expect(updates(llamadas)).toHaveLength(0);
    expect(db.every((x) => x.folio_releido_at === null)).toBe(true);
    expect(db.every((x) => x.notas === null)).toBe(true);
  });

  it('ilegible: relee las notas JUSTO antes de sellar (no pisa una edición de la oficina) y lleva CAS sobre ellas', async () => {
    let tabla: Row[] = [];
    const { svc, db, llamadas } = armar({
      conSerie: true,
      recibidas: [fila('rota', { notas: 'Proveedor X' })],
      archivos: { 'recibidas/rota.xml': 'ROTO' },
      // La oficina edita las notas (PATCH de recibidas) mientras la
      // corrida descarga y parsea.
      parse: (xml) => {
        const f = tabla.find((x) => x.id === 'rota')!;
        f.notas = 'Proveedor X · pagar el viernes';
        return parseJson(xml);
      },
    });
    tabla = db;
    const r = await svc.releerFoliosRecibidas();
    expect(r).toMatchObject({ ilegibles: 1, reintentar: 0 });
    expect(db[0].notas).toBe(
      `Proveedor X · pagar el viernes\n${NOTA_FOLIO_NO_LEGIBLE}`,
    );
    const u = updates(llamadas);
    expect(u).toHaveLength(1);
    expect(u[0].cas).toBe(true);
    const opsUpdate = llamadas.find(
      (l) =>
        l.tabla === 'factura_recibida' && l.ops.some((o) => o.m === 'update'),
    )!.ops;
    expect(opsUpdate).toEqual(
      expect.arrayContaining([
        { m: 'eq', args: ['notas', 'Proveedor X · pagar el viernes'] },
      ]),
    );
  });

  it('ilegible SIN notas: CAS `notas is null`', async () => {
    const { svc, db, llamadas } = armar({
      conSerie: true,
      recibidas: [fila('rota')],
      archivos: { 'recibidas/rota.xml': 'ROTO' },
      parse: parseJson,
    });
    expect(await svc.releerFoliosRecibidas()).toMatchObject({ ilegibles: 1 });
    expect(db[0].notas).toBe(NOTA_FOLIO_NO_LEGIBLE);
    const opsUpdate = llamadas.find(
      (l) =>
        l.tabla === 'factura_recibida' && l.ops.some((o) => o.m === 'update'),
    )!.ops;
    expect(opsUpdate).toEqual(
      expect.arrayContaining([{ m: 'is', args: ['notas', null] }]),
    );
  });

  it('pyservices VIEJO (sin las llaves serie/folio) ⇒ no sella y corta', async () => {
    const { svc, llamadas } = armar({
      conSerie: true,
      recibidas: [fila('a'), fila('b')],
      archivos: {
        'recibidas/a.xml': JSON.stringify({ uuid_fiscal: 'u' }),
        'recibidas/b.xml': JSON.stringify({ uuid_fiscal: 'v' }),
      },
      parse: parseJson,
    });
    const r = await svc.releerFoliosRecibidas();
    expect(r).toMatchObject({ leidas: 1, reintentar: 1 });
    expect(updates(llamadas)).toHaveLength(0);
  });

  it('lote de 50: con 60 pendientes, una corrida lee 50 y la siguiente las 10 restantes', async () => {
    const recibidas = Array.from({ length: 60 }, (_, i) =>
      fila(`f${String(i).padStart(2, '0')}`),
    );
    const archivos: Record<string, string> = {};
    for (const r of recibidas) {
      archivos[r.xml_url as string] = JSON.stringify({
        serie: 'S',
        folio: r.id,
      });
    }
    const { svc, db } = armar({
      conSerie: true,
      recibidas,
      archivos,
      parse: parseJson,
    });
    expect(await svc.releerFoliosRecibidas()).toMatchObject({
      leidas: 50,
      con_folio: 50,
    });
    expect(await svc.releerFoliosRecibidas()).toMatchObject({
      leidas: 10,
      con_folio: 10,
    });
    expect(await svc.releerFoliosRecibidas()).toMatchObject({ leidas: 0 });
    expect(db.every((x) => x.folio === x.id)).toBe(true);
  });

  it('candado: una segunda corrida simultánea no hace nada', async () => {
    let soltar: () => void = () => undefined;
    const espera = new Promise<void>((res) => {
      soltar = res;
    });
    const { svc, parseFacturaRecibida } = armar({
      conSerie: true,
      recibidas: [fila('a')],
      archivos: {
        'recibidas/a.xml': JSON.stringify({ serie: null, folio: '1' }),
      },
      parse: async (xml) => {
        await espera;
        return parseJson(xml);
      },
    });
    const primera = svc.releerFoliosRecibidas();
    // Deja que la primera llegue al parser.
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    await expect(svc.releerFoliosRecibidas()).resolves.toBeNull();
    soltar();
    await expect(primera).resolves.toMatchObject({ con_folio: 1 });
    expect(parseFacturaRecibida).toHaveBeenCalledTimes(1);
  });
});

/** El payload del insert a `factura_recibida`. */
const payloadInsert = (llamadas: Array<{ tabla: string; ops: Op[] }>) =>
  (llamadas
    .filter((l) => l.tabla === 'factura_recibida')
    .flatMap((l) => l.ops)
    .find((o) => o.m === 'insert')?.args[0] ?? {}) as Row;

/** Columnas del select de la respuesta del insert. */
const selectDelInsert = (llamadas: Array<{ tabla: string; ops: Op[] }>) =>
  llamadas
    .filter(
      (l) =>
        l.tabla === 'factura_recibida' && l.ops.some((o) => o.m === 'insert'),
    )
    .flatMap((l) => l.ops)
    .find((o) => o.m === 'select')?.args[0] as string;

describe('alta de facturas recibidas con serie/folio', () => {
  it('crearRecibida con la migración: guarda serie/folio, sella y los devuelve', async () => {
    const { svc, llamadas } = armar({
      conSerie: true,
      parse: () =>
        Promise.resolve({ uuid_fiscal: 'u-1', serie: 'A', folio: '0411' }),
    });
    await svc.crearRecibida(b64('<cfdi/>'), 'user-1');
    const p = payloadInsert(llamadas);
    expect(p).toMatchObject({ serie: 'A', folio: '0411' });
    expect(typeof p.folio_releido_at).toBe('string');
    expect(selectDelInsert(llamadas)).toMatch(/, serie, folio$/);
  });

  it('crearRecibida con pyservices VIEJO: serie/folio null y SIN sello (el cron la relee)', async () => {
    const { svc, llamadas } = armar({
      conSerie: true,
      parse: () => Promise.resolve({ uuid_fiscal: 'u-1' }),
    });
    await svc.crearRecibida(b64('<cfdi/>'), 'user-1');
    expect(payloadInsert(llamadas)).toMatchObject({
      serie: null,
      folio: null,
      folio_releido_at: null,
    });
  });

  it('crearRecibida SIN la migración: insert y select como el 0.0.56', async () => {
    const { svc, llamadas } = armar({
      conSerie: false,
      parse: () =>
        Promise.resolve({ uuid_fiscal: 'u-1', serie: 'A', folio: '0411' }),
    });
    await svc.crearRecibida(b64('<cfdi/>'), 'user-1');
    const p = payloadInsert(llamadas);
    expect(p).not.toHaveProperty('serie');
    expect(p).not.toHaveProperty('folio');
    expect(p).not.toHaveProperty('folio_releido_at');
    expect(selectDelInsert(llamadas)).not.toMatch(/serie/);
  });

  it('crearRecibidaDeGasto con XML: guarda serie/folio y sella', async () => {
    const { svc, llamadas } = armar({
      conSerie: true,
      parse: () =>
        Promise.resolve({
          uuid_fiscal: 'u-9',
          serie: 'FEACZM',
          folio: '72128',
        }),
    });
    await svc.crearRecibidaDeGasto(
      { gasto_id: 'g-1', xml_b64: b64('<cfdi/>') },
      'user-1',
    );
    const p = payloadInsert(llamadas);
    expect(p).toMatchObject({ serie: 'FEACZM', folio: '72128' });
    expect(typeof p.folio_releido_at).toBe('string');
  });

  it('crearRecibidaDeGasto SOLO PDF: sin serie/folio (no hay XML que leer)', async () => {
    const { svc, llamadas, parseFacturaRecibida } = armar({ conSerie: true });
    // `pdf_url` también se sondea: el fake la acepta (columna presente).
    await svc.crearRecibidaDeGasto(
      { gasto_id: 'g-1', pdf_b64: b64('%PDF') },
      'user-1',
    );
    expect(parseFacturaRecibida).not.toHaveBeenCalled();
    const p = payloadInsert(llamadas);
    expect(p).not.toHaveProperty('serie');
    expect(p).not.toHaveProperty('folio_releido_at');
    expect(p).toMatchObject({ xml_url: null });
  });
});
