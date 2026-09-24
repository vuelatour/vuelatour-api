// Mismos stubs que flights.service.baja.spec.ts (notifications → jose,
// calendar-sync → googleapis, vision → SDK de IA, pilots → push).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pilots/pilots.service', () => ({ PilotsService: class {} }));

import { HttpException } from '@nestjs/common';
import { FlightsService } from './flights.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';

/**
 * FlightsService con el registro de FACTURAS EMITIDAS (24-sep-2026):
 *  - borrar/purgar un vuelo con factura VIGENTE ligada ⇒ 409; con solo
 *    canceladas/borradas ⇒ se desligan, quedan en la bitácora y se REPONEN
 *    si el DELETE del vuelo falla;
 *  - comprobante del cobro: 409 COBRO_DE_GRUPO, CAS 409 COMPROBANTE_CAMBIO
 *    y el archivo ANTERIOR nunca se borra;
 *  - `cobroStatus` parte los ids en lotes de 200.
 */
type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };
type Resultado = {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number | null;
};

const METODOS = [
  'select',
  'eq',
  'neq',
  'in',
  'is',
  'not',
  'or',
  'gte',
  'lte',
  'order',
  'limit',
  'insert',
  'update',
  'delete',
];

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';
const COBRO = 'aaaaaaaa-0000-4000-8000-0000000000c1';

const tiene = (ops: Op[], m: string) => ops.some((o) => o.m === m);
const esHead = (ops: Op[]) =>
  ops.some(
    (o) =>
      o.m === 'select' && (o.args[1] as { head?: boolean } | undefined)?.head,
  );
const selectDe = (ops: Op[]) => {
  const s = ops.find((o) => o.m === 'select')?.args[0];
  return typeof s === 'string' ? s : '';
};

interface Mundo {
  migracion?: boolean;
  ligas?: Row[];
  deleteVueloFalla?: boolean;
  /** El DELETE del puente (quitar ligas desligables) falla. */
  ligasDeleteFalla?: boolean;
  cobro?: Row | null;
  /** El UPDATE CAS del comprobante no encuentra la fila (alguien cambió). */
  casPierde?: boolean;
}

function armar(m: Mundo = {}) {
  const llamadas: Array<{ tabla: string; ops: Op[] }> = [];
  const inserts: Record<string, unknown[]> = {};
  const deletes: Array<{ tabla: string; ops: Op[] }> = [];
  const subidos: string[] = [];
  const borrados: string[][] = [];
  const resolver = (tabla: string, ops: Op[]): Resultado => {
    const ins = ops.find((o) => o.m === 'insert');
    if (ins) (inserts[tabla] ??= []).push(ins.args[0]);
    if (tiene(ops, 'delete')) deletes.push({ tabla, ops });
    if (
      m.migracion === false &&
      selectDe(ops).includes('factura_solicitada_at')
    ) {
      return { error: { code: '42703', message: 'column does not exist' } };
    }
    switch (tabla) {
      case 'vuelo':
        if (tiene(ops, 'delete')) {
          return m.deleteVueloFalla
            ? { error: { code: '23503', message: 'FK RESTRICT' } }
            : {};
        }
        if (selectDe(ops).startsWith('id, tc_usd_mxn')) return { data: [] };
        return {
          data: {
            id: V1,
            folio: 118,
            estado: 'CANCELADO',
            cliente_id: null,
            aeronave_id: null,
            fecha_vuelo: '2026-09-14T14:00:00+00:00',
            cobrado: false,
            facturado: false,
            grupo_id: null,
          },
        };
      case 'cobro_vuelo':
        if (esHead(ops)) return { count: 0 };
        if (tiene(ops, 'update')) {
          return m.casPierde ? { data: [] } : { data: [{ id: COBRO }] };
        }
        if (selectDe(ops).startsWith('id, vuelo_id, foto_voucher_url')) {
          return { data: m.cobro === undefined ? null : m.cobro };
        }
        return { data: [] };
      case 'cobro_grupo':
        return { data: { grupo_id: 'grupo-1' } };
      case 'gasto':
      case 'factura':
        return esHead(ops) ? { count: 0 } : { data: [] };
      case 'escala':
        return { data: [] };
      case 'factura_emitida_vuelo':
        if (ins) return {};
        if (tiene(ops, 'delete')) {
          return m.ligasDeleteFalla
            ? { error: { code: 'XX000', message: 'falla el puente' } }
            : {};
        }
        return { data: m.ligas ?? [] };
      case 'vuelo_eliminado':
        if (ins) return { data: { id: 'be-1' } };
        return {};
      default:
        return {};
    }
  };
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      llamadas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => {
        const r = resolver(tabla, ops);
        return {
          data: r.data === undefined ? (lista ? [] : null) : r.data,
          error: r.error ?? null,
          count: r.count ?? null,
        };
      };
      for (const met of METODOS) {
        q[met] = (...args: unknown[]) => {
          ops.push({ m: met, args });
          return q;
        };
      }
      q.maybeSingle = () => Promise.resolve(resolve(false));
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(true)).then(res, rej);
      return q;
    },
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
        createSignedUrl: (path: string) =>
          Promise.resolve({
            data: { signedUrl: `https://firmada/${path}` },
            error: null,
          }),
      }),
    },
  };
  const notifications = {
    notifyUser: jest.fn().mockResolvedValue(true),
    notifyRole: jest.fn().mockResolvedValue(1),
  } as unknown as NotificationsService;
  const calendar = {
    syncFlight: jest.fn().mockResolvedValue(undefined),
    removeFlight: jest.fn().mockResolvedValue(undefined),
  } as unknown as CalendarSyncService;
  const flights = new FlightsService(
    { service } as unknown as SupabaseService,
    calendar,
    {} as EmailService,
    {} as VisionService,
    notifications,
    {
      findBlockingExpirations: jest.fn().mockResolvedValue([]),
    } as unknown as ExpirationsService,
    { refreshPermisosDeVuelo: jest.fn() } as unknown as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
  return { flights, llamadas, inserts, deletes, subidos, borrados };
}

async function rebote(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    const r = err.getResponse() as Record<string, unknown>;
    return {
      status: err.getStatus(),
      code: r.error as string,
      message: err.message,
      details: r.details as Record<string, unknown> | undefined,
    };
  }
  throw new Error('no rebotó');
}

const liga = (
  factura_id: string,
  estatus: string,
  deleted_at: string | null = null,
) => ({
  factura_id,
  vuelo_id: V1,
  created_at: '2026-09-20T10:00:00Z',
  created_by: USER,
  factura: {
    serie: 'A',
    folio: factura_id.replace('f-', ''),
    estatus,
    deleted_at,
  },
});

describe('purgeFlight / deleteFlight — facturas emitidas ligadas', () => {
  it('con factura VIGENTE ⇒ 409 VUELO_CON_FACTURA_EMITIDA ANTES de la bitácora', async () => {
    const w = armar({ ligas: [liga('f-123', 'VIGENTE')] });
    const r = await rebote(
      w.flights.purgeFlight(V1, 'limpieza de prueba', USER),
    );
    expect(r).toMatchObject({
      status: 409,
      code: 'VUELO_CON_FACTURA_EMITIDA',
      message:
        'El vuelo #118 tiene la factura A-123 registrada. Cancélala o desliga el vuelo en Facturas emitidas antes de borrarlo.',
      details: { facturas: ['A-123'] },
    });
    expect(w.inserts.vuelo_eliminado).toBeUndefined();
    expect(w.deletes).toEqual([]);
    // Mismo candado en el borrado de borradores.
    const d = await rebote(w.flights.deleteFlight(V1, USER));
    expect(d.code).toBe('VUELO_CON_FACTURA_EMITIDA');
  });

  it('solo canceladas/borradas: van a la bitácora y se desligan justo antes del DELETE', async () => {
    const w = armar({
      ligas: [
        liga('f-120', 'CANCELADA'),
        liga('f-121', 'VIGENTE', '2026-09-22T00:00:00Z'),
      ],
    });
    await w.flights.purgeFlight(V1, 'limpieza de prueba', USER);
    const snap = (w.inserts.vuelo_eliminado[0] as Row).snapshot as Row;
    expect(snap.facturas_emitidas_desligadas).toEqual([
      {
        factura_id: 'f-120',
        etiqueta: 'A-120',
        estatus: 'CANCELADA',
        borrada: false,
      },
      {
        factura_id: 'f-121',
        etiqueta: 'A-121',
        estatus: 'VIGENTE',
        borrada: true,
      },
    ]);
    const orden = w.deletes.map((d) => d.tabla);
    expect(orden.indexOf('factura_emitida_vuelo')).toBeLessThan(
      orden.indexOf('vuelo'),
    );
    const del = w.deletes.find((d) => d.tabla === 'factura_emitida_vuelo')!;
    expect(del.ops.find((o) => o.m === 'in')?.args).toEqual([
      'factura_id',
      ['f-120', 'f-121'],
    ]);
  });

  it('si el DELETE del vuelo falla, las ligas se REPONEN y la bitácora se revierte', async () => {
    const w = armar({
      ligas: [liga('f-120', 'CANCELADA')],
      deleteVueloFalla: true,
    });
    const r = await rebote(
      w.flights.purgeFlight(V1, 'limpieza de prueba', USER),
    );
    expect(r.status).toBe(409);
    expect(w.inserts.factura_emitida_vuelo).toEqual([
      [
        {
          factura_id: 'f-120',
          vuelo_id: V1,
          created_at: '2026-09-20T10:00:00Z',
          created_by: USER,
        },
      ],
    ]);
    expect(w.deletes.map((d) => d.tabla)).toContain('vuelo_eliminado');
  });

  it('si NO se pueden quitar las ligas, nada destructivo corre: sin borrar tramos ni vuelo y la bitácora se revierte', async () => {
    // Antes el DELETE del puente iba DESPUÉS de borrar los tramos: un fallo
    // ahí dejaba el vuelo vivo, SIN tramos y «eliminado» en la bitácora.
    for (const borrar of ['purge', 'delete'] as const) {
      const w = armar({
        ligas: [liga('f-120', 'CANCELADA')],
        ligasDeleteFalla: true,
      });
      await expect(
        borrar === 'purge'
          ? w.flights.purgeFlight(V1, 'limpieza de prueba', USER)
          : w.flights.deleteFlight(V1, USER),
      ).rejects.toThrow('falla el puente');
      const tablas = w.deletes.map((d) => d.tabla);
      expect(tablas).not.toContain('escala');
      expect(tablas).not.toContain('vuelo');
      expect(tablas).not.toContain('cotizacion_version_history');
      expect(tablas).toContain('vuelo_eliminado');
    }
  });

  it('sin la migración no consulta el puente', async () => {
    const w = armar({ migracion: false, ligas: [liga('f-1', 'VIGENTE')] });
    await w.flights.purgeFlight(V1, 'limpieza de prueba', USER);
    expect(w.llamadas.some((l) => l.tabla === 'factura_emitida_vuelo')).toBe(
      false,
    );
  });
});

describe('adjuntarComprobanteCobro', () => {
  const foto = {
    buffer: Buffer.from('jpeg-bytes'),
    nombre: 'voucher.JPG',
    mime: 'image/jpeg',
  };

  it('sube a oficina/<vuelo>/<cobro>/, CAS contra el anterior y NO borra el anterior', async () => {
    const w = armar({
      cobro: {
        id: COBRO,
        vuelo_id: V1,
        foto_voucher_url: 'uid/2026-09/viejo.jpg',
        cobro_grupo_id: null,
      },
    });
    const r = await w.flights.adjuntarComprobanteCobro(COBRO, foto, USER);
    expect(r.foto_voucher_url).toMatch(
      new RegExp(`^oficina/${V1}/${COBRO}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(r).toMatchObject({ id: COBRO, tipo: 'imagen' });
    expect(r.url).toBe(`https://firmada/${r.foto_voucher_url}`);
    expect(w.borrados).toEqual([]);
    const upd = w.llamadas.find(
      (l) => l.tabla === 'cobro_vuelo' && tiene(l.ops, 'update'),
    )!;
    expect(upd.ops.find((o) => o.m === 'update')?.args[0]).toEqual({
      foto_voucher_url: r.foto_voucher_url,
      updated_by: USER,
    });
    expect(upd.ops.filter((o) => o.m === 'eq').map((o) => o.args)).toEqual([
      ['id', COBRO],
      ['foto_voucher_url', 'uid/2026-09/viejo.jpg'],
    ]);
  });

  it('PDF sin comprobante previo: CAS `is null`, tipo pdf', async () => {
    const w = armar({
      cobro: {
        id: COBRO,
        vuelo_id: V1,
        foto_voucher_url: null,
        cobro_grupo_id: null,
      },
    });
    const r = await w.flights.adjuntarComprobanteCobro(
      COBRO,
      {
        buffer: Buffer.from('%PDF-1.4'),
        nombre: 'comprobante.pdf',
        mime: null,
      },
      USER,
    );
    expect(r.tipo).toBe('pdf');
    const upd = w.llamadas.find(
      (l) => l.tabla === 'cobro_vuelo' && tiene(l.ops, 'update'),
    )!;
    expect(upd.ops.find((o) => o.m === 'is')?.args).toEqual([
      'foto_voucher_url',
      null,
    ]);
  });

  it('CAS perdido ⇒ 409 COMPROBANTE_CAMBIO y se retira SOLO lo nuevo', async () => {
    const w = armar({
      casPierde: true,
      cobro: {
        id: COBRO,
        vuelo_id: V1,
        foto_voucher_url: 'uid/viejo.jpg',
        cobro_grupo_id: null,
      },
    });
    const r = await rebote(
      w.flights.adjuntarComprobanteCobro(COBRO, foto, USER),
    );
    expect(r).toMatchObject({ status: 409, code: 'COMPROBANTE_CAMBIO' });
    expect(w.borrados).toEqual([w.subidos]);
    expect(w.borrados[0]).not.toContain('uid/viejo.jpg');
  });

  it('parte de un sobre ⇒ 409 COBRO_DE_GRUPO; inexistente ⇒ 404; tipo inválido ⇒ 400', async () => {
    const g = armar({
      cobro: {
        id: COBRO,
        vuelo_id: V1,
        foto_voucher_url: null,
        cobro_grupo_id: 'sobre-1',
      },
    });
    const r = await rebote(
      g.flights.adjuntarComprobanteCobro(COBRO, foto, USER),
    );
    expect(r).toMatchObject({
      status: 409,
      code: 'COBRO_DE_GRUPO',
      details: { grupo_id: 'grupo-1', cobro_grupo_id: 'sobre-1' },
    });
    expect(g.subidos).toEqual([]);
    const n = armar({ cobro: null });
    expect(
      (await rebote(n.flights.adjuntarComprobanteCobro(COBRO, foto, USER)))
        .code,
    ).toBe('COBRO_NO_EXISTE');
    const t = armar({});
    const x = await rebote(
      t.flights.adjuntarComprobanteCobro(
        COBRO,
        {
          buffer: Buffer.from('x'),
          nombre: 'hoja.xlsx',
          mime: 'application/vnd.ms-excel',
        },
        USER,
      ),
    );
    expect(x).toMatchObject({
      status: 400,
      code: 'ARCHIVO_TIPO_INVALIDO',
      message: 'El comprobante se sube como foto (JPG, PNG, WEBP, HEIC) o PDF.',
    });
  });
});

describe('cobroStatus — lotes de 200', () => {
  it('250 vuelos ⇒ 2 consultas a cobro_vuelo y 2 a vuelo, con ≤ 200 ids cada una', async () => {
    const w = armar({});
    const ids = Array.from({ length: 250 }, (_, i) => `v-${i}`);
    const out = await w.flights.cobroStatus(ids);
    expect(Object.keys(out)).toHaveLength(250);
    const tamanos = (tabla: string) =>
      w.llamadas
        .filter((l) => l.tabla === tabla)
        .map(
          (l) => (l.ops.find((o) => o.m === 'in')?.args[1] as unknown[]).length,
        );
    expect(tamanos('cobro_vuelo')).toEqual([200, 50]);
    expect(tamanos('vuelo')).toEqual([200, 50]);
  });
});
