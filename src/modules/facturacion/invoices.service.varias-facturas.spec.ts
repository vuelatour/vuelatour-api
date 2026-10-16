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

import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { sha256Hex } from './gasto-facturas.util';
import {
  conteoFacturasDeGastos,
  facturasDeGastos,
} from './gasto-facturas.lector';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import type { FacturacionClient } from './facturacion.client';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * VARIAS FACTURAS RECIBIDAS POR GASTO (16-oct-2026, API 0.0.87, invariante
 * 87). BD EN MEMORIA que emula lo que hace Postgres: el trigger
 * `gasto_sync_facturacion` (null→valor FACTURADA; valor→null con FACTURADA
 * ⇒ PENDIENTE), el trigger NUEVO principal ⇒ puente (solo con la
 * migración), la FK en cascada de la puente y `uuid_fiscal` UNIQUE. Sin la
 * migración, nombrar `pdf_sha256` responde 42703 y la puente PGRST205.
 *
 * Lo que se congela (pedido del cliente: ASA entrega 5 CFDI por carga):
 *  - el mismo PDF dos veces ⇒ UNA fila (en un envío y entre envíos);
 *  - `ya_existia` guarda el PDF que faltaba;
 *  - una segunda factura NO reemplaza a la principal;
 *  - quitar la principal promueve otra y el estatus queda bien;
 *  - VIP SAESA (una factura → N gastos) sigue igual;
 *  - sin la tabla ⇒ conducta 0.0.85.
 */

type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };

const USER = 'u-oficina';
const b64 = (s: string) => Buffer.from(s).toString('base64');
/** «XML» de prueba: JSON con lo que devolvería pyservices. */
const xml = (o: Row) => b64(JSON.stringify(o));
/** `id` de la respuesta (la fila de la factura viene como Record). */
const idDe = (r: unknown) => (r as { id: string }).id;

interface Mundo {
  /** Migración 20261016000003 aplicada (puente + pdf_sha256). */
  conTabla?: boolean;
  gastos?: Row[];
  facturas?: Row[];
  puente?: Row[];
  /** Archivos ya en Storage (path ⇒ contenido). */
  storage?: Record<string, string>;
}

function armar(m: Mundo = {}) {
  const conTabla = m.conTabla ?? true;
  let reloj = 0;
  const ts = () =>
    new Date(Date.UTC(2026, 9, 16, 12, 0, reloj++)).toISOString();
  let seq = 0;
  const db: Record<string, Row[]> = {
    gasto: (m.gastos ?? []).map((g) => ({
      factura_recibida_id: null,
      estatus_facturacion: 'PENDIENTE',
      monto: 100,
      moneda: 'MXN',
      ...g,
    })),
    factura_recibida: (m.facturas ?? []).map((f) => ({
      uuid_fiscal: null,
      pdf_url: null,
      pdf_sha256: null,
      xml_url: null,
      gasto_id: null,
      estado: 'CLASIFICADA',
      notas: null,
      total: null,
      moneda: null,
      created_at: ts(),
      ...f,
    })),
    gasto_factura_recibida: (m.puente ?? []).map((p) => ({
      created_at: ts(),
      created_by: null,
      ...p,
    })),
  };
  const storage = new Map<string, Buffer>(
    Object.entries(m.storage ?? {}).map(([k, v]) => [k, Buffer.from(v)]),
  );
  const subidas: string[] = [];
  const retirados: string[] = [];

  /** Triggers de `gasto` al cambiar la principal (BEFORE + AFTER). */
  const alCambiarPrincipal = (g: Row, antes: unknown) => {
    const ahora = g.factura_recibida_id;
    if (antes == null && ahora != null) g.estatus_facturacion = 'FACTURADA';
    else if (
      antes != null &&
      ahora == null &&
      g.estatus_facturacion === 'FACTURADA'
    )
      g.estatus_facturacion = 'PENDIENTE';
    if (conTabla && ahora != null) {
      const ya = db.gasto_factura_recibida.some(
        (p) => p.gasto_id === g.id && p.factura_recibida_id === ahora,
      );
      if (!ya)
        db.gasto_factura_recibida.push({
          gasto_id: g.id,
          factura_recibida_id: ahora,
          created_at: ts(),
          created_by: g.updated_by ?? null,
        });
    }
  };

  const cumple = (r: Row, ops: Op[]) =>
    ops.every((o) => {
      const [c, a, b] = o.args as [string, unknown, unknown];
      switch (o.m) {
        case 'eq':
          return r[c] === a;
        case 'neq':
          return r[c] !== a;
        case 'in':
          return (a as unknown[]).includes(r[c]);
        case 'is':
          return (r[c] ?? null) === a;
        case 'not':
          if (a === 'is') return (r[c] ?? null) !== b;
          if (a === 'in')
            return !String(b)
              .replace(/[()]/g, '')
              .split(',')
              .includes(String(r[c]));
          return true;
        default:
          return true;
      }
    });

  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      const q: Record<string, unknown> = {};
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
        'or',
        'insert',
        'upsert',
        'update',
        'delete',
      ]) {
        q[met] = (...args: unknown[]) => {
          ops.push({ m: met, args });
          return q;
        };
      }
      const op = (n: string) => ops.find((o) => o.m === n);
      const filtros = () =>
        ops.filter((o) => ['eq', 'neq', 'in', 'is', 'not'].includes(o.m));
      const ejecutar = (): { data: unknown; error: Row | null } => {
        const selArg = op('select')?.args[0];
        const sel = typeof selArg === 'string' ? selArg : '';
        if (!conTabla) {
          if (tabla === 'gasto_factura_recibida')
            return {
              data: null,
              error: {
                code: 'PGRST205',
                message:
                  "Could not find the table 'public.gasto_factura_recibida' in the schema cache",
              },
            };
          const cuerpo = JSON.stringify(
            op('insert')?.args[0] ?? op('update')?.args[0] ?? {},
          );
          if (
            sel.includes('pdf_sha256') ||
            cuerpo.includes('pdf_sha256') ||
            ops.some((o) => o.args[0] === 'pdf_sha256')
          )
            return {
              data: null,
              error: {
                code: '42703',
                message: 'column factura_recibida.pdf_sha256 does not exist',
              },
            };
        }
        const filas = db[tabla];
        if (!filas) return { data: [], error: null };
        const ins = op('insert');
        if (ins) {
          const nuevas = ([] as Row[]).concat(ins.args[0] as Row | Row[]);
          for (const n of nuevas) {
            if (
              tabla === 'factura_recibida' &&
              n.uuid_fiscal &&
              filas.some((f) => f.uuid_fiscal === n.uuid_fiscal)
            )
              return {
                data: null,
                error: { code: '23505', message: 'duplicate key uuid_fiscal' },
              };
          }
          const out = nuevas.map((n) => {
            const fila: Row = {
              id: `${tabla === 'factura_recibida' ? 'fr' : 'x'}-${++seq}`,
              created_at: ts(),
              pdf_sha256: null,
              ...n,
            };
            filas.push(fila);
            return fila;
          });
          return { data: out, error: null };
        }
        const ups = op('upsert');
        if (ups) {
          const n = ups.args[0] as Row;
          const ya = filas.some(
            (p) =>
              p.gasto_id === n.gasto_id &&
              p.factura_recibida_id === n.factura_recibida_id,
          );
          if (!ya) filas.push({ created_at: ts(), ...n });
          return { data: null, error: null };
        }
        const sel2 = filas.filter((r) => cumple(r, filtros()));
        const upd = op('update');
        if (upd) {
          const patch = upd.args[0] as Row;
          for (const r of sel2) {
            const antes = r.factura_recibida_id;
            if (
              tabla === 'factura_recibida' &&
              patch.uuid_fiscal &&
              filas.some((f) => f !== r && f.uuid_fiscal === patch.uuid_fiscal)
            )
              return { data: null, error: { code: '23505', message: 'dup' } };
            Object.assign(r, patch);
            if (tabla === 'gasto' && 'factura_recibida_id' in patch)
              alCambiarPrincipal(r, antes);
          }
          return { data: sel2.map((r) => ({ ...r })), error: null };
        }
        if (op('delete')) {
          for (const r of sel2) filas.splice(filas.indexOf(r), 1);
          if (tabla === 'factura_recibida') {
            for (const r of sel2) {
              db.gasto_factura_recibida = db.gasto_factura_recibida.filter(
                (p) => p.factura_recibida_id !== idDe(r),
              );
              for (const g of db.gasto)
                if (g.factura_recibida_id === idDe(r)) {
                  g.factura_recibida_id = null;
                  alCambiarPrincipal(g, idDe(r));
                }
            }
          }
          return { data: null, error: null };
        }
        let res = sel2.map((r) => ({ ...r }));
        const ord = op('order');
        if (ord) {
          const c = ord.args[0] as string;
          res.sort((a, b) => String(a[c]).localeCompare(String(b[c])));
        }
        const lim = op('limit');
        if (lim) res = res.slice(0, lim.args[0] as number);
        // Embed de gastos donde es la principal (respuestas de recibidas).
        if (
          tabla === 'factura_recibida' &&
          sel.includes('gastos:gasto!factura_recibida_id')
        ) {
          res = res.map((f) => ({
            ...f,
            gastos: db.gasto
              .filter((g) => g.factura_recibida_id === f.id)
              .map((g) => ({ id: g.id, monto: g.monto })),
          }));
        }
        return { data: res, error: null };
      };
      q.maybeSingle = () => {
        const r = ejecutar();
        const d: unknown = Array.isArray(r.data)
          ? ((r.data as unknown[])[0] ?? null)
          : r.data;
        return Promise.resolve({ data: d, error: r.error });
      };
      q.then = (
        res: (v: unknown) => unknown,
        rej?: (e: unknown) => unknown,
      ) => {
        const r = ejecutar();
        return Promise.resolve({
          data: Array.isArray(r.data) ? r.data : r.data ? [r.data] : [],
          error: r.error,
        }).then(res, rej);
      };
      return q;
    },
    storage: {
      from() {
        return {
          upload: (path: string, buf: Buffer) => {
            subidas.push(path);
            storage.set(path, buf);
            return Promise.resolve({ error: null });
          },
          download: (path: string) => {
            const buf = storage.get(path);
            if (!buf)
              return Promise.resolve({
                data: null,
                error: { message: 'Object not found' },
              });
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
          remove: (paths: string[]) => {
            retirados.push(...paths);
            return Promise.resolve({ error: null });
          },
          createSignedUrls: (paths: string[]) =>
            Promise.resolve({
              data: paths.map((p) => ({
                path: p,
                signedUrl: `https://x/${p}`,
              })),
            }),
        };
      },
    },
  };

  const parseFacturaRecibida = jest.fn((x: string) =>
    Promise.resolve(JSON.parse(Buffer.from(x, 'base64').toString()) as Row),
  );
  const svc = new InvoicesService(
    { service } as unknown as SupabaseService,
    {} as FacturacionClient,
    { parseFacturaRecibida } as unknown as PyservicesService,
    {} as ProfitSharingService,
  );
  const gasto = (id: string) => db.gasto.find((g) => g.id === id)!;
  const ligas = (gid: string) =>
    db.gasto_factura_recibida
      .filter((p) => p.gasto_id === gid)
      .map((p) => p.factura_recibida_id);
  return {
    svc,
    db,
    sb: service as unknown as SupabaseClient,
    subidas,
    retirados,
    gasto,
    ligas,
    parseFacturaRecibida,
  };
}

/** Invariante: principal ⇒ fila en la puente; ligas ⇒ principal. */
function invariante(db: Record<string, Row[]>) {
  for (const g of db.gasto) {
    const ls = db.gasto_factura_recibida.filter((p) => p.gasto_id === g.id);
    if (g.factura_recibida_id)
      expect(ls.map((p) => p.factura_recibida_id)).toContain(
        g.factura_recibida_id,
      );
    else expect(ls).toHaveLength(0);
  }
}

describe('Subir VARIAS facturas a un gasto (con la migración)', () => {
  it('el caso ASA: 5 CFDI con su PDF en un envío ⇒ 5 facturas, la primera principal, FACTURADA', async () => {
    const { svc, db, gasto, ligas } = armar({
      gastos: [{ id: 'g-asa', monto: 3601.77, moneda: 'MXN' }],
    });
    const totales = [2900, 300, 200, 150.77, 51];
    const r = await svc.crearRecibidaDeGasto(
      {
        gasto_id: 'g-asa',
        archivos: totales.map((t, i) => ({
          xml_b64: xml({ uuid_fiscal: `U${i}`, total: t, moneda: 'MXN' }),
          pdf_b64: b64(`%PDF ${i}`),
          nombre: `FCUN_${i}.pdf`,
        })),
      },
      USER,
    );
    expect(r.agregadas).toBe(5);
    expect(r.ya_existian).toBe(0);
    expect(r.facturas_multiples).toBe(true);
    expect(r.facturas).toHaveLength(5);
    expect(r.facturas[0]).toMatchObject({ principal: true, uuid_fiscal: 'U0' });
    expect(r.facturas.filter((f) => f.principal)).toHaveLength(1);
    expect(gasto('g-asa').estatus_facturacion).toBe('FACTURADA');
    expect(gasto('g-asa').factura_recibida_id).toBe(r.facturas[0].id);
    expect(ligas('g-asa')).toHaveLength(5);
    // Suma 3,601.77 = monto ⇒ sin aviso.
    expect(r.avisos).toEqual([]);
    // Cada PDF guardado con su huella.
    expect(
      db.factura_recibida.every(
        (f) => typeof f.pdf_sha256 === 'string' && f.pdf_sha256.length === 64,
      ),
    ).toBe(true);
    // Shape viejo intacto (el panel 0.0.85 lee `id` y `ya_existia`).
    expect(r).toMatchObject({ id: r.facturas[0].id, ya_existia: false });
    invariante(db);
  });

  it('aviso NO bloqueante cuando la suma no cuadra con el monto (± 1.00)', async () => {
    const { svc } = armar({
      gastos: [{ id: 'g1', monto: 3601.77, moneda: 'MXN' }],
    });
    const r = await svc.crearRecibidaDeGasto(
      {
        gasto_id: 'g1',
        archivos: [
          { xml_b64: xml({ uuid_fiscal: 'U1', total: 3000, moneda: 'MXN' }) },
          { xml_b64: xml({ uuid_fiscal: 'U2', total: 500, moneda: 'MXN' }) },
        ],
      },
      USER,
    );
    expect(r.avisos).toEqual([
      'Las facturas suman $3,500 MXN; el gasto es $3,601.77 MXN.',
    ]);
  });

  it('el MISMO PDF dos veces en un envío ⇒ UNA fila', async () => {
    const { svc, db, subidas } = armar({ gastos: [{ id: 'g1' }] });
    const r = await svc.crearRecibidaDeGasto(
      {
        gasto_id: 'g1',
        archivos: [
          { pdf_b64: b64('%PDF FCUN-1299718'), nombre: 'a.pdf' },
          { pdf_b64: b64('%PDF FCUN-1299718'), nombre: 'a (1).pdf' },
        ],
      },
      USER,
    );
    expect(db.factura_recibida).toHaveLength(1);
    expect(subidas).toHaveLength(1);
    expect(r.detalle).toEqual([
      expect.objectContaining({ archivos: [0, 1], resultado: 'NUEVA' }),
    ]);
    expect(r.facturas).toHaveLength(1);
    expect(r.facturas[0].nombre).toBe('a.pdf');
  });

  it('el MISMO PDF en un segundo envío ⇒ reutiliza la fila (YA_EN_ESTE_GASTO), no crea otra', async () => {
    const { svc, db } = armar({ gastos: [{ id: 'g1' }] });
    await svc.crearRecibidaDeGasto(
      { gasto_id: 'g1', pdf_b64: b64('%PDF X') },
      USER,
    );
    const r = await svc.crearRecibidaDeGasto(
      { gasto_id: 'g1', pdf_b64: b64('%PDF X') },
      USER,
    );
    expect(db.factura_recibida).toHaveLength(1);
    expect(r).toMatchObject({ agregadas: 0, ya_existian: 1, ya_existia: true });
    expect(r.facturas).toHaveLength(1);
  });

  it('caso Mary: el PDF ya estaba en el gasto ANTES de la migración (sin huella) ⇒ se calcula, se guarda y se reutiliza', async () => {
    const { svc, db } = armar({
      gastos: [
        {
          id: 'g-asa',
          factura_recibida_id: 'fr-vieja',
          estatus_facturacion: 'FACTURADA',
        },
      ],
      facturas: [
        {
          id: 'fr-vieja',
          pdf_url: 'recibidas/vieja.pdf',
          gasto_id: 'g-asa',
          notas: 'Factura en PDF (sin XML): ACC_FCUN_1299718.pdf',
        },
      ],
      puente: [{ gasto_id: 'g-asa', factura_recibida_id: 'fr-vieja' }],
      storage: { 'recibidas/vieja.pdf': '%PDF FCUN-1299718' },
    });
    const r = await svc.crearRecibidaDeGasto(
      {
        gasto_id: 'g-asa',
        pdf_b64: b64('%PDF FCUN-1299718'),
        pdf_nombre: 'otra vez.pdf',
      },
      USER,
    );
    expect(db.factura_recibida).toHaveLength(1);
    expect(db.factura_recibida[0].pdf_sha256).toBe(
      sha256Hex(Buffer.from('%PDF FCUN-1299718')),
    );
    expect(r).toMatchObject({ ya_existian: 1, agregadas: 0 });
  });

  it('una SEGUNDA factura NO reemplaza a la principal: se agrega', async () => {
    const { svc, db, gasto, ligas } = armar({
      gastos: [
        {
          id: 'g1',
          factura_recibida_id: 'fr-A',
          estatus_facturacion: 'FACTURADA',
        },
      ],
      facturas: [{ id: 'fr-A', uuid_fiscal: 'UA', gasto_id: 'g1' }],
      puente: [{ gasto_id: 'g1', factura_recibida_id: 'fr-A' }],
    });
    // Shape VIEJO (panel 0.0.85): también agrega.
    const r = await svc.crearRecibidaDeGasto(
      { gasto_id: 'g1', xml_b64: xml({ uuid_fiscal: 'UB' }) },
      USER,
    );
    expect(gasto('g1').factura_recibida_id).toBe('fr-A');
    expect(gasto('g1').estatus_facturacion).toBe('FACTURADA');
    expect(ligas('g1').sort()).toEqual(['fr-A', idDe(r)].sort());
    expect(r.facturas.map((f) => [f.id, f.principal])).toEqual([
      ['fr-A', true],
      [idDe(r), false],
    ]);
    expect(r.agregadas).toBe(1);
    invariante(db);
  });

  it('ya_existia (UUID en el buzón) GUARDA el PDF que faltaba, sin pisar uno que ya estaba', async () => {
    const { svc, db, subidas } = armar({
      gastos: [
        { id: 'g1' },
        {
          id: 'g2',
          factura_recibida_id: 'fr-U',
          estatus_facturacion: 'FACTURADA',
        },
      ],
      facturas: [
        {
          id: 'fr-U',
          uuid_fiscal: 'U-1',
          xml_url: 'recibidas/U-1.xml',
          gasto_id: 'g2',
        },
        {
          id: 'fr-P',
          uuid_fiscal: 'U-2',
          xml_url: 'recibidas/U-2.xml',
          pdf_url: 'recibidas/U-2.pdf',
        },
      ],
      puente: [{ gasto_id: 'g2', factura_recibida_id: 'fr-U' }],
    });
    const r = await svc.crearRecibidaDeGasto(
      {
        gasto_id: 'g1',
        archivos: [
          { xml_b64: xml({ uuid_fiscal: 'U-1' }), pdf_b64: b64('%PDF uno') },
          { xml_b64: xml({ uuid_fiscal: 'U-2' }), pdf_b64: b64('%PDF dos') },
        ],
      },
      USER,
    );
    const u = db.factura_recibida.find((f) => f.id === 'fr-U')!;
    expect(u.pdf_url).toBe('recibidas/U-1.pdf');
    expect(u.pdf_sha256).toBe(sha256Hex(Buffer.from('%PDF uno')));
    // El que ya tenía PDF no se toca ni se re-sube.
    expect(db.factura_recibida.find((f) => f.id === 'fr-P')!.pdf_url).toBe(
      'recibidas/U-2.pdf',
    );
    expect(subidas).toEqual(['recibidas/U-1.pdf']);
    expect(db.factura_recibida).toHaveLength(2);
    expect(
      r.detalle.map((d) => [d.factura_id, d.resultado, d.pdf_agregado]),
    ).toEqual([
      ['fr-U', 'EXISTENTE', true],
      ['fr-P', 'EXISTENTE', false],
    ]);
    // fr-U sigue amparando a g2 (VIP): aditivo.
    expect(db.gasto.find((g) => g.id === 'g2')!.factura_recibida_id).toBe(
      'fr-U',
    );
  });

  it('PDF sin XML subido antes y AHORA llega su XML con el mismo PDF ⇒ se COMPLETA la fila (no se duplica)', async () => {
    const { svc, db } = armar({ gastos: [{ id: 'g1' }] });
    await svc.crearRecibidaDeGasto(
      { gasto_id: 'g1', pdf_b64: b64('%PDF FCUN'), pdf_nombre: 'FCUN.pdf' },
      USER,
    );
    const r = await svc.crearRecibidaDeGasto(
      {
        gasto_id: 'g1',
        archivos: [
          {
            xml_b64: xml({ uuid_fiscal: 'U-FCUN', total: 100, moneda: 'MXN' }),
            pdf_b64: b64('%PDF FCUN'),
          },
        ],
      },
      USER,
    );
    expect(db.factura_recibida).toHaveLength(1);
    expect(db.factura_recibida[0]).toMatchObject({
      uuid_fiscal: 'U-FCUN',
      total: 100,
      xml_url: 'recibidas/U-FCUN.xml',
      notas: null,
    });
    expect(r.detalle[0]).toMatchObject({
      xml_agregado: true,
      resultado: 'YA_EN_ESTE_GASTO',
    });
  });

  it('gasto inexistente ⇒ 404 sin subir nada', async () => {
    const { svc, subidas } = armar({ gastos: [] });
    await expect(
      svc.crearRecibidaDeGasto(
        { gasto_id: 'nope', archivos: [{ pdf_b64: b64('%PDF') }] },
        USER,
      ),
    ).rejects.toThrow('not found');
    expect(subidas).toHaveLength(0);
  });

  it('validación: archivos + shape viejo juntos ⇒ 400; elemento vacío ⇒ 400 con su número', async () => {
    const { svc } = armar({ gastos: [{ id: 'g1' }] });
    await expect(
      svc.crearRecibidaDeGasto(
        {
          gasto_id: 'g1',
          xml_b64: xml({}),
          archivos: [{ pdf_b64: b64('%PDF') }],
        },
        USER,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      svc.crearRecibidaDeGasto(
        {
          gasto_id: 'g1',
          archivos: [{ pdf_b64: b64('%PDF') }, { nombre: 'x' }],
        },
        USER,
      ),
    ).rejects.toThrow(
      'El archivo #2 no trae ni el XML ni el PDF de la factura.',
    );
  });
});

describe('Quitar una factura de un gasto', () => {
  const mundo = () =>
    armar({
      gastos: [
        {
          id: 'g1',
          factura_recibida_id: 'fr-A',
          estatus_facturacion: 'FACTURADA',
        },
      ],
      facturas: [
        { id: 'fr-A', gasto_id: 'g1', total: 50, moneda: 'MXN' },
        { id: 'fr-B', gasto_id: 'g1', total: 50, moneda: 'MXN' },
        { id: 'fr-C', gasto_id: 'g1' },
      ],
      puente: [
        {
          gasto_id: 'g1',
          factura_recibida_id: 'fr-A',
          created_at: '2026-10-16T01:00:00Z',
        },
        {
          gasto_id: 'g1',
          factura_recibida_id: 'fr-C',
          created_at: '2026-10-16T03:00:00Z',
        },
        {
          gasto_id: 'g1',
          factura_recibida_id: 'fr-B',
          created_at: '2026-10-16T02:00:00Z',
        },
      ],
    });

  it('quitar la PRINCIPAL promueve la liga más antigua y el gasto sigue FACTURADA', async () => {
    const { svc, db, gasto, ligas } = mundo();
    const r = await svc.quitarFacturaDeGasto('fr-A', 'g1', USER);
    expect(gasto('g1').factura_recibida_id).toBe('fr-B');
    expect(gasto('g1').estatus_facturacion).toBe('FACTURADA');
    expect(ligas('g1').sort()).toEqual(['fr-B', 'fr-C']);
    expect(r).toMatchObject({
      ok: true,
      principal: 'fr-B',
      estatus_facturacion: 'FACTURADA',
    });
    expect(r.facturas.map((f) => [f.id, f.principal])).toEqual([
      ['fr-B', true],
      ['fr-C', false],
    ]);
    // La factura NO se borra; sin otro gasto queda SIN_CLASIFICAR y sin espejo.
    expect(db.factura_recibida.find((f) => f.id === 'fr-A')).toMatchObject({
      gasto_id: null,
      estado: 'SIN_CLASIFICAR',
    });
    invariante(db);
  });

  it('quitar todas ⇒ la última deja el gasto sin principal y PENDIENTE', async () => {
    const { svc, db, gasto } = mundo();
    await svc.quitarFacturaDeGasto('fr-A', 'g1', USER);
    await svc.quitarFacturaDeGasto('fr-C', 'g1', USER);
    expect(gasto('g1').factura_recibida_id).toBe('fr-B');
    const r = await svc.quitarFacturaDeGasto('fr-B', 'g1', USER);
    expect(gasto('g1')).toMatchObject({
      factura_recibida_id: null,
      estatus_facturacion: 'PENDIENTE',
    });
    expect(r).toMatchObject({
      principal: null,
      estatus_facturacion: 'PENDIENTE',
      facturas: [],
    });
    invariante(db);
  });

  it('quitar una NO principal no toca la principal ni el estatus', async () => {
    const { svc, gasto, ligas } = mundo();
    await svc.quitarFacturaDeGasto('fr-C', 'g1', USER);
    expect(gasto('g1')).toMatchObject({
      factura_recibida_id: 'fr-A',
      estatus_facturacion: 'FACTURADA',
    });
    expect(ligas('g1').sort()).toEqual(['fr-A', 'fr-B']);
  });

  it('una factura que no está ligada a ese gasto ⇒ 404 FACTURA_NO_LIGADA', async () => {
    const { svc } = armar({
      gastos: [{ id: 'g1' }],
      facturas: [{ id: 'fr-Z' }],
    });
    await expect(
      svc.quitarFacturaDeGasto('fr-Z', 'g1', USER),
    ).rejects.toMatchObject({
      response: { error: 'FACTURA_NO_LIGADA' },
    });
  });

  it('borrar la factura (deleteRecibida) promueve la siguiente en vez de dejar el gasto PENDIENTE', async () => {
    const { svc, db, gasto } = mundo();
    await svc.deleteRecibida('fr-A', USER);
    expect(gasto('g1')).toMatchObject({
      factura_recibida_id: 'fr-B',
      estatus_facturacion: 'FACTURADA',
    });
    expect(db.factura_recibida.map((f) => f.id).sort()).toEqual([
      'fr-B',
      'fr-C',
    ]);
    invariante(db);
  });
});

describe('VIP SAESA (una factura → N gastos) con la puente', () => {
  it('amarrarGastos sobre gastos SIN factura: igual que siempre (principal, FACTURADA) + la puente', async () => {
    const { svc, db, gasto, ligas } = armar({
      gastos: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }],
      facturas: [{ id: 'fr-VIP', estado: 'SIN_CLASIFICAR' }],
    });
    const r = await svc.amarrarGastos('fr-VIP', ['g1', 'g2', 'g3'], USER);
    for (const id of ['g1', 'g2', 'g3']) {
      expect(gasto(id)).toMatchObject({
        factura_recibida_id: 'fr-VIP',
        estatus_facturacion: 'FACTURADA',
      });
      expect(ligas(id)).toEqual(['fr-VIP']);
    }
    expect(r).toMatchObject({ estado: 'CLASIFICADA', gasto_id: 'g1' });
    expect((r as unknown as { gastos: unknown[] }).gastos).toHaveLength(3);

    // Reemplazar la lista: g2 y g3 salen (PENDIENTE, sin ligas).
    await svc.amarrarGastos('fr-VIP', ['g1'], USER);
    expect(gasto('g2')).toMatchObject({
      factura_recibida_id: null,
      estatus_facturacion: 'PENDIENTE',
    });
    expect(ligas('g2')).toEqual([]);
    expect(gasto('g1').factura_recibida_id).toBe('fr-VIP');
    invariante(db);
  });

  it('un gasto que ya tenía OTRA factura la conserva como principal y esta se le agrega', async () => {
    const { svc, gasto, ligas } = armar({
      gastos: [
        {
          id: 'g1',
          factura_recibida_id: 'fr-X',
          estatus_facturacion: 'FACTURADA',
        },
      ],
      facturas: [{ id: 'fr-X', gasto_id: 'g1' }, { id: 'fr-VIP' }],
      puente: [{ gasto_id: 'g1', factura_recibida_id: 'fr-X' }],
    });
    await svc.amarrarGastos('fr-VIP', ['g1'], USER);
    expect(gasto('g1').factura_recibida_id).toBe('fr-X');
    expect(ligas('g1').sort()).toEqual(['fr-VIP', 'fr-X']);
  });

  it('subir desde la fila de OTRO gasto el CFDI de VIP ya registrado: se suma a ese gasto sin desamarrar los demás', async () => {
    const { svc, gasto, ligas } = armar({
      gastos: [
        {
          id: 'g1',
          factura_recibida_id: 'fr-VIP',
          estatus_facturacion: 'FACTURADA',
        },
        { id: 'g2' },
      ],
      facturas: [{ id: 'fr-VIP', uuid_fiscal: 'U-VIP', gasto_id: 'g1' }],
      puente: [{ gasto_id: 'g1', factura_recibida_id: 'fr-VIP' }],
    });
    const r = await svc.crearRecibidaDeGasto(
      { gasto_id: 'g2', xml_b64: xml({ uuid_fiscal: 'U-VIP' }) },
      USER,
    );
    expect(r).toMatchObject({ id: 'fr-VIP', ya_existia: true, agregadas: 1 });
    expect(gasto('g1').factura_recibida_id).toBe('fr-VIP');
    expect(gasto('g2')).toMatchObject({
      factura_recibida_id: 'fr-VIP',
      estatus_facturacion: 'FACTURADA',
    });
    expect(ligas('g2')).toEqual(['fr-VIP']);
  });

  it('updateRecibida con gasto_id: la factura queda SOLO en ese gasto (los demás promueven/sueltan)', async () => {
    const { svc, db, gasto } = armar({
      gastos: [
        {
          id: 'g1',
          factura_recibida_id: 'fr-A',
          estatus_facturacion: 'FACTURADA',
        },
        { id: 'g2' },
      ],
      facturas: [{ id: 'fr-A', gasto_id: 'g1' }],
      puente: [{ gasto_id: 'g1', factura_recibida_id: 'fr-A' }],
    });
    await svc.updateRecibida('fr-A', { gasto_id: 'g2' }, USER);
    expect(gasto('g1')).toMatchObject({
      factura_recibida_id: null,
      estatus_facturacion: 'PENDIENTE',
    });
    expect(gasto('g2')).toMatchObject({
      factura_recibida_id: 'fr-A',
      estatus_facturacion: 'FACTURADA',
    });
    invariante(db);
  });
});

describe('SIN la migración ⇒ conducta 0.0.85', () => {
  it('una factura por gasto: la segunda REEMPLAZA a la principal (como hoy) y no se toca la puente ni pdf_sha256', async () => {
    const { svc, db, gasto } = armar({
      conTabla: false,
      gastos: [
        {
          id: 'g1',
          factura_recibida_id: 'fr-A',
          estatus_facturacion: 'FACTURADA',
        },
      ],
      facturas: [{ id: 'fr-A', uuid_fiscal: 'UA', gasto_id: 'g1' }],
    });
    const r = await svc.crearRecibidaDeGasto(
      {
        gasto_id: 'g1',
        xml_b64: xml({ uuid_fiscal: 'UB' }),
        pdf_b64: b64('%PDF'),
      },
      USER,
    );
    expect(gasto('g1').factura_recibida_id).toBe(idDe(r));
    expect(r).toMatchObject({ ya_existia: false, facturas_multiples: false });
    expect(r.facturas.map((f) => f.id)).toEqual([idDe(r)]);
    expect(db.gasto_factura_recibida).toHaveLength(0);
    expect(
      db.factura_recibida.find((f) => f.id === idDe(r))!.pdf_sha256,
    ).toBeNull();
  });

  it('más de un archivo ⇒ 503 FACTURAS_GASTO_NO_DISPONIBLE ANTES de subir o escribir nada', async () => {
    const { svc, db, subidas, parseFacturaRecibida } = armar({
      conTabla: false,
      gastos: [{ id: 'g1' }],
    });
    await expect(
      svc.crearRecibidaDeGasto(
        {
          gasto_id: 'g1',
          archivos: [{ pdf_b64: b64('%PDF 1') }, { pdf_b64: b64('%PDF 2') }],
        },
        USER,
      ),
    ).rejects.toMatchObject({
      status: 503,
      response: {
        error: 'FACTURAS_GASTO_NO_DISPONIBLE',
        details: { migracion: '20261016000003' },
      },
    });
    expect(subidas).toHaveLength(0);
    expect(parseFacturaRecibida).not.toHaveBeenCalled();
    expect(db.factura_recibida).toHaveLength(0);
  });

  it('`archivos` con UN elemento = el shape viejo', async () => {
    const { svc, gasto } = armar({ conTabla: false, gastos: [{ id: 'g1' }] });
    const r = await svc.crearRecibidaDeGasto(
      { gasto_id: 'g1', archivos: [{ xml_b64: xml({ uuid_fiscal: 'U1' }) }] },
      USER,
    );
    expect(gasto('g1')).toMatchObject({
      factura_recibida_id: idDe(r),
      estatus_facturacion: 'FACTURADA',
    });
  });

  it('ya_existia también guarda el PDF que faltaba (sin huella: la columna no existe)', async () => {
    const { svc, db } = armar({
      conTabla: false,
      gastos: [{ id: 'g1' }],
      facturas: [{ id: 'fr-U', uuid_fiscal: 'U-1' }],
    });
    await svc.crearRecibidaDeGasto(
      {
        gasto_id: 'g1',
        xml_b64: xml({ uuid_fiscal: 'U-1' }),
        pdf_b64: b64('%PDF'),
      },
      USER,
    );
    expect(db.factura_recibida[0]).toMatchObject({
      pdf_url: 'recibidas/U-1.pdf',
      pdf_sha256: null,
    });
  });

  it('quitar la factura funciona sin la puente (principal ⇒ null, PENDIENTE)', async () => {
    const { svc, gasto } = armar({
      conTabla: false,
      gastos: [
        {
          id: 'g1',
          factura_recibida_id: 'fr-A',
          estatus_facturacion: 'FACTURADA',
        },
      ],
      facturas: [{ id: 'fr-A', gasto_id: 'g1' }],
    });
    const r = await svc.quitarFacturaDeGasto('fr-A', 'g1', USER);
    expect(gasto('g1')).toMatchObject({
      factura_recibida_id: null,
      estatus_facturacion: 'PENDIENTE',
    });
    expect(r).toMatchObject({ facturas_multiples: false, facturas: [] });
  });

  it('amarrarGastos y deleteRecibida: idénticos a 0.0.85', async () => {
    const { svc, gasto } = armar({
      conTabla: false,
      gastos: [{ id: 'g1' }, { id: 'g2' }],
      facturas: [{ id: 'fr-VIP' }],
    });
    await svc.amarrarGastos('fr-VIP', ['g1', 'g2'], USER);
    expect(gasto('g2').factura_recibida_id).toBe('fr-VIP');
    await svc.deleteRecibida('fr-VIP', USER);
    expect(gasto('g1')).toMatchObject({
      factura_recibida_id: null,
      estatus_facturacion: 'PENDIENTE',
    });
  });
});

describe('lector de facturas por gasto', () => {
  it('con la puente: principal primero, conteo por gasto', async () => {
    const { sb } = armar({
      gastos: [{ id: 'g1', factura_recibida_id: 'fr-B' }, { id: 'g2' }],
      facturas: [{ id: 'fr-A' }, { id: 'fr-B' }],
      puente: [
        {
          gasto_id: 'g1',
          factura_recibida_id: 'fr-A',
          created_at: '2026-10-16T01:00:00Z',
        },
        {
          gasto_id: 'g1',
          factura_recibida_id: 'fr-B',
          created_at: '2026-10-16T02:00:00Z',
        },
      ],
    });
    const gastos = [
      { id: 'g1', factura_recibida_id: 'fr-B' },
      { id: 'g2', factura_recibida_id: null },
    ];
    const m = await facturasDeGastos(sb, gastos);
    expect(m.get('g1')!.map((f) => [f.id, f.principal])).toEqual([
      ['fr-B', true],
      ['fr-A', false],
    ]);
    expect(m.get('g2')).toEqual([]);
    const c = await conteoFacturasDeGastos(sb, gastos);
    expect([c.get('g1'), c.get('g2')]).toEqual([2, 0]);
  });

  it('sin la puente: solo la principal (y el conteo sin consultar)', async () => {
    const { sb } = armar({
      conTabla: false,
      gastos: [{ id: 'g1', factura_recibida_id: 'fr-A' }],
      facturas: [{ id: 'fr-A' }],
    });
    const m = await facturasDeGastos(sb, [
      { id: 'g1', factura_recibida_id: 'fr-A' },
    ]);
    expect(m.get('g1')!.map((f) => f.id)).toEqual(['fr-A']);
    const c = await conteoFacturasDeGastos(sb, [
      { id: 'g1', factura_recibida_id: 'fr-A' },
    ]);
    expect(c.get('g1')).toBe(1);
  });

  it('respuestas del buzón: `gastos` incluye los que ampara como factura ADICIONAL', async () => {
    const { svc } = armar({
      gastos: [{ id: 'g1', factura_recibida_id: 'fr-A' }],
      facturas: [{ id: 'fr-A' }, { id: 'fr-B' }],
      puente: [
        { gasto_id: 'g1', factura_recibida_id: 'fr-A' },
        { gasto_id: 'g1', factura_recibida_id: 'fr-B' },
      ],
    });
    const r = (await svc.recibidaPorId('fr-B')) as {
      gastos: Array<{ id: string }>;
    };
    expect(r.gastos.map((g) => g.id)).toEqual(['g1']);
  });
});

describe('POST recibidas/file-urls por rol', () => {
  it('COORDINADOR solo firma paths recibidas/…; ADMIN firma todo', async () => {
    const { svc } = armar();
    const ctrl = new InvoicesController(svc);
    const coord = { rol: Rol.COORDINADOR, userId: 'c' } as AuthenticatedUser;
    const admin = { rol: Rol.ADMIN, userId: 'a' } as AuthenticatedUser;
    const paths = [
      'recibidas/U-1.pdf',
      'cfdi/emitida.xml',
      'recibidas/../cfdi/x.xml',
    ];
    expect(Object.keys(await ctrl.recibidaFileUrls({ paths }, coord))).toEqual([
      'recibidas/U-1.pdf',
    ]);
    expect(
      Object.keys(await ctrl.recibidaFileUrls({ paths }, admin)),
    ).toHaveLength(3);
  });
});
