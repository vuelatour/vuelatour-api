// La cadena real de FlightsService arrastra googleapis y `jose` (ESM): se
// stubbea (sus métodos se inyectan como mocks). ConciliacionService es la
// REAL en la prueba de paridad con «cobros sin banco».
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IngresosService } from './ingresos.service';
import { ConciliacionService } from '../conciliacion/conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { FlightsService } from '../flights/flights.service';
import type { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';

/**
 * INGRESOS (24-sep-2026, contrato §5 y §12.5) — servicio contra una BD EN
 * MEMORIA. Se congela: cada 400 del alta con su `code`, el TC oficial y
 * TC_REQUERIDO, la idempotencia PRIMERO (alta, alta desde abono y
 * aplicación), los dos candados anti doble conteo del alta desde un abono
 * (caso real #235 y la línea repetida), la compensación cuando la liga
 * falla, los candados de la edición contra el VIGENTE y el estado
 * FUSIONADO, los argumentos EXACTOS con los que un anticipo crea su cobro,
 * «Es el pago de un vuelo» y el resumen SIN doble conteo — con el MISMO
 * «sin conciliar» que «Cobros sin banco».
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const CTA = 'c0000000-0000-4000-8000-000000000001';
const CTA_USD = 'c0000000-0000-4000-8000-000000000002';
const CTA_PW = 'c0000000-0000-4000-8000-000000000003';
const K_CRISTY = 'e0000000-0000-4000-8000-00000000000c';
const K_OTRO = 'e0000000-0000-4000-8000-00000000000d';
const V_1 = 'f0000000-0000-4000-8000-000000000001';
const G_1 = 'a0000000-0000-4000-8000-00000000000a';
const M_CRISTY = 'b0000000-0000-4000-8000-000000000235';
const ADMIN: AuthenticatedUser = {
  authId: 'a',
  userId: 'u-admin',
  email: 'x@y',
  nombre: 'Admin',
  rol: Rol.ADMIN,
  estado: 'ACTIVO' as AuthenticatedUser['estado'],
  jwt: '',
};
const COORD: AuthenticatedUser = {
  ...ADMIN,
  userId: 'u-coord',
  rol: Rol.COORDINADOR,
};
const LLAVE = '11111111-1111-4111-8111-111111111111';
const LLAVE2 = '22222222-2222-4222-8222-222222222222';

function partirOr(cond: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of cond) {
    if (ch === '(') nivel += 1;
    if (ch === ')') nivel -= 1;
    if (ch === ',' && nivel === 0) {
      out.push(actual);
      actual = '';
      continue;
    }
    actual += ch;
  }
  if (actual) out.push(actual);
  return out;
}

const txt = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : v == null
        ? ''
        : JSON.stringify(v);

const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const iso = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
  if (iso(a) && iso(b)) return Date.parse(String(a)) - Date.parse(String(b));
  const sa = txt(a);
  const sb = txt(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

interface OpcionesBd {
  sinMigracion?: boolean;
  /** Error que devuelve la PRÓXIMA operación `op` sobre `tabla`. */
  fallar?: Array<{
    tabla: string;
    op: 'insert' | 'update';
    error: { code: string; message: string };
  }>;
}

function fakeSupabase(db: Tablas, opts: OpcionesBd = {}) {
  let seq = 0;
  const subidos: string[] = [];
  const retirados: string[] = [];
  const service = {
    storage: {
      from: () => ({
        upload: (path: string) => {
          subidos.push(path);
          return Promise.resolve({ data: { path }, error: null });
        },
        remove: (paths: string[]) => {
          retirados.push(...paths);
          return Promise.resolve({ data: null, error: null });
        },
        createSignedUrl: (path: string) =>
          Promise.resolve({
            data: { signedUrl: `https://firmada/${path}` },
            error: null,
          }),
      }),
    },
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let patch: Row = {};
      let aInsertar: Row[] = [];
      let rango: [number, number] | null = null;
      let limite: number | null = null;
      const orden: Array<[string, boolean]> = [];
      let prohibido = opts.sinMigracion && tabla === 'ingreso';
      const marcar = (t: string) => {
        if (opts.sinMigracion && /\bingreso_(anticipo_)?id\b/.test(t)) {
          prohibido = true;
        }
      };
      const ejecutar = (unico: boolean) => {
        if (prohibido) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column ingreso_id does not exist',
            },
          };
        }
        if (op === 'insert' || op === 'update') {
          const i = (opts.fallar ?? []).findIndex(
            (f) => f.tabla === tabla && f.op === op,
          );
          if (i >= 0) {
            const [f] = opts.fallar!.splice(i, 1);
            return { data: null, error: f.error };
          }
        }
        if (op === 'insert') {
          const creados = aInsertar.map((r) => ({
            id: `${tabla}-${++seq}`,
            folio: tabla === 'ingreso' ? 100 + seq : undefined,
            created_at: '2026-09-24T12:00:00Z',
            updated_at: '2026-09-24T12:00:00Z',
            archivos_historial: [],
            deleted_at: null,
            ...r,
          }));
          db[tabla] = [...(db[tabla] ?? []), ...creados];
          return { data: unico ? (creados[0] ?? null) : creados, error: null };
        }
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        if (op === 'update') {
          filas.forEach((r) =>
            Object.assign(r, patch, { updated_at: '2026-09-24T13:00:00Z' }),
          );
        }
        if (op === 'delete') {
          db[tabla] = (db[tabla] ?? []).filter((r) => !filas.includes(r));
        }
        let out = filas.map((r) => ({ ...r }));
        for (const [col, asc] of [...orden].reverse()) {
          out.sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
        }
        if (rango) out = out.slice(rango[0], rango[1] + 1);
        if (limite != null) out = out.slice(0, limite);
        return {
          data: unico ? (out[0] ?? null) : out,
          error: null,
          count: filas.length,
        };
      };
      const cumple = (r: Row, cond: string): boolean => {
        const m = /^([^.]+)\.([a-z]+)\.(.*)$/.exec(cond);
        if (!m) return false;
        const [, col, o, raw] = m;
        const v = r[col];
        if (o === 'is') return (v ?? null) === null && raw === 'null';
        if (o === 'not') return raw === 'is.null' ? (v ?? null) !== null : true;
        if (o === 'eq') return String(v) === raw;
        if (o === 'in') {
          return raw
            .replace(/^\(|\)$/g, '')
            .split(',')
            .includes(String(v));
        }
        return false;
      };
      const api: Record<string, unknown> = {
        select(s?: string) {
          marcar(s ?? '');
          return api;
        },
        insert(r: Row | Row[]) {
          op = 'insert';
          aInsertar = Array.isArray(r) ? r : [r];
          marcar(Object.keys(aInsertar[0] ?? {}).join(','));
          return api;
        },
        update(p: Row) {
          op = 'update';
          patch = p;
          marcar(Object.keys(p).join(','));
          return api;
        },
        delete() {
          op = 'delete';
          return api;
        },
        eq(col: string, val: unknown) {
          marcar(col);
          filtros.push((r) => r[col] === val);
          return api;
        },
        neq(col: string, val: unknown) {
          filtros.push((r) => r[col] !== val);
          return api;
        },
        is(col: string, val: unknown) {
          marcar(col);
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        not(col: string, o: string, val: unknown) {
          marcar(col);
          if (o === 'is' && val === null) {
            filtros.push((r) => (r[col] ?? null) !== null);
          }
          return api;
        },
        ilike(col: string, val: string) {
          const pat = val.replace(/%/g, '').toLowerCase();
          filtros.push((r) => txt(r[col]).toLowerCase().includes(pat));
          return api;
        },
        in(col: string, vals: unknown[]) {
          marcar(col);
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        or(cond: string) {
          marcar(cond);
          filtros.push((r) => partirOr(cond).some((c) => cumple(r, c)));
          return api;
        },
        gte(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) >= 0);
          return api;
        },
        lte(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) <= 0);
          return api;
        },
        gt(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) > 0);
          return api;
        },
        lt(col: string, val: unknown) {
          filtros.push((r) => cmp(r[col], val) < 0);
          return api;
        },
        order(col: string, o?: { ascending?: boolean }) {
          orden.push([col, o?.ascending !== false]);
          return api;
        },
        range(a: number, b: number) {
          rango = [a, b];
          return api;
        },
        limit(n: number) {
          limite = n;
          return api;
        },
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        single: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
  };
  return {
    supabase: { service } as unknown as SupabaseService,
    subidos,
    retirados,
  };
}

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'Scotia MXN',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
      {
        id: CTA_USD,
        alias: 'Scotia USD',
        banco: 'Scotiabank',
        moneda: 'USD',
        tipo: 'BANCO',
      },
      {
        id: CTA_PW,
        alias: 'Paywise',
        banco: 'Paywise',
        moneda: 'MXN',
        tipo: 'PASARELA',
      },
    ],
    cliente: [
      { id: K_CRISTY, nombre: 'Cristy Chavez', activo: true },
      { id: K_OTRO, nombre: 'Otro Cliente', activo: true },
    ],
    vuelo: [{ id: V_1, folio: 312, cliente_id: K_CRISTY }],
    aeronave: [{ id: 'av-1', matricula: 'XA-VGV' }],
    gasto: [{ id: G_1 }],
    usuario: [{ id: 'u-admin', nombre: 'Admin' }],
    ingreso: [],
    ingreso_bitacora: [],
    cobro_vuelo: [],
    cobro_grupo: [],
    movimiento_bancario: [],
    conciliacion_clasificacion: [],
    tarjeta_corporativa: [],
    ...extra,
  };
}

interface Mocks {
  flights: {
    createCobro: jest.Mock;
    deleteCobro: jest.Mock;
    findById: jest.Mock;
    assertAccess: jest.Mock;
    cobroStatus: jest.Mock;
    listCobros: jest.Mock;
  };
  conciliacion: {
    linkIngreso: jest.Mock;
    linkCobro: jest.Mock;
    intentarCruzarIngreso: jest.Mock;
  };
  tipoCambio: { oficialDetallePara: jest.Mock };
  pyservices: { generateTablaXlsx: jest.Mock };
}

function armar(
  db: Tablas,
  opts: OpcionesBd & { conciliacionReal?: boolean } = {},
) {
  const f = fakeSupabase(db, opts);
  const mocks: Mocks = {
    flights: {
      createCobro: jest.fn((_v: string, dto: Row) =>
        Promise.resolve({
          id: 'c-nuevo',
          vuelo_id: _v,
          fecha_cobro: (dto.fecha_cobro as Date).toISOString(),
          registrado_por: 'u-admin',
          created_at: '2026-09-24T12:00:00Z',
          ...dto,
          fecha_cobro_iso: undefined,
        }),
      ),
      deleteCobro: jest.fn().mockResolvedValue({ ok: true }),
      findById: jest.fn((id: string) => {
        const v = db.vuelo.find((x) => x.id === id);
        if (!v) return Promise.reject(new NotFoundException('Vuelo no existe'));
        return Promise.resolve(v);
      }),
      assertAccess: jest.fn().mockResolvedValue(undefined),
      cobroStatus: jest.fn().mockResolvedValue({}),
      listCobros: jest.fn().mockResolvedValue([]),
    },
    conciliacion: {
      linkIngreso: jest.fn().mockResolvedValue({}),
      linkCobro: jest.fn().mockResolvedValue({}),
      intentarCruzarIngreso: jest.fn().mockResolvedValue({ ligado: false }),
    },
    tipoCambio: {
      oficialDetallePara: jest
        .fn()
        .mockResolvedValue({ tc: 18.2, fecha_dato: '2026-09-10', fuente: 'x' }),
    },
    pyservices: {
      generateTablaXlsx: jest.fn().mockResolvedValue(Buffer.from('x')),
    },
  };
  const conciliacion = opts.conciliacionReal
    ? new ConciliacionService(
        { get: () => '' } as unknown as ConstructorParameters<
          typeof ConciliacionService
        >[0],
        f.supabase,
        {} as PyservicesService,
        { registrar: jest.fn() } as unknown as IaUsoService,
      )
    : (mocks.conciliacion as unknown as ConciliacionService);
  const svc = new IngresosService(
    f.supabase,
    mocks.flights as unknown as FlightsService,
    conciliacion,
    mocks.tipoCambio as unknown as TipoCambioService,
    mocks.pyservices as unknown as PyservicesService,
  );
  return {
    svc,
    db,
    mocks,
    conciliacion,
    subidos: f.subidos,
    retirados: f.retirados,
  };
}

const datos = (extra: Row = {}): string =>
  JSON.stringify({
    categoria: 'OTRO_INGRESO',
    fecha: '2026-09-10',
    descripcion: 'Renta de hangar a tercero',
    monto: 5000,
    moneda: 'MXN',
    metodo: 'TRANSFERENCIA',
    cuenta_bancaria_id: CTA,
    ...extra,
  });

const pdf = {
  buffer: Buffer.from('%PDF-1.7 comprobante'),
  originalname: 'comprobante.pdf',
  mimetype: 'application/pdf',
};

async function error(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!e) throw new Error('se esperaba un error');
  const r = (e as HttpException).getResponse?.() as
    | { error?: string; details?: Row; message?: string }
    | undefined;
  return { e, code: r?.error, details: r?.details, message: r?.message };
}

const ingresoRow = (id: string, extra: Row = {}): Row => ({
  id,
  folio: 12,
  categoria: 'OTRO_INGRESO',
  fecha: '2026-09-10',
  descripcion: 'Renta de hangar',
  monto: 5000,
  comision_monto: null,
  moneda: 'MXN',
  tc_usd_mxn: null,
  metodo: 'TRANSFERENCIA',
  cuenta_bancaria_id: CTA,
  referencia: null,
  pagador: null,
  cliente_id: null,
  vuelo_id: null,
  aeronave_id: null,
  gasto_id: null,
  notas: null,
  archivo_path: null,
  archivo_nombre: null,
  archivos_historial: [],
  client_request_id: null,
  deleted_at: null,
  deleted_by: null,
  motivo_baja: null,
  created_at: '2026-09-10T12:00:00Z',
  created_by: 'u-admin',
  updated_at: '2026-09-10T12:00:00Z',
  updated_by: 'u-admin',
  ...extra,
});

// =====================================================================
describe('alta — validaciones con su code (antes de escribir nada)', () => {
  it.each<[string, Row, string]>([
    [
      'anticipo sin cliente',
      { categoria: 'ANTICIPO_CLIENTE' },
      'CATEGORIA_EXIGE_CLIENTE',
    ],
    [
      'anticipo con vuelo',
      {
        categoria: 'ANTICIPO_CLIENTE',
        cliente_id: K_CRISTY,
        vuelo_id: V_1,
      },
      'ANTICIPO_CON_VUELO',
    ],
    ['vuelo en OTRO_INGRESO', { vuelo_id: V_1 }, 'VUELO_SOLO_EN_REEMBOLSO'],
    ['gasto en OTRO_INGRESO', { gasto_id: G_1 }, 'GASTO_SOLO_EN_REEMBOLSO'],
    [
      'transferencia sin cuenta',
      { cuenta_bancaria_id: null },
      'EFECTIVO_SIN_CUENTA',
    ],
    [
      'cuenta inexistente',
      { cuenta_bancaria_id: '99999999-9999-4999-8999-999999999999' },
      'CUENTA_NO_EXISTE',
    ],
    [
      'USD en cuenta MXN',
      { moneda: 'USD', tc_usd_mxn: 18 },
      'MONEDA_DISTINTA_CUENTA',
    ],
    ['fecha futura', { fecha: '2999-01-01' }, 'FECHA_FUTURA'],
    ['comisión = monto', { comision_monto: 5000 }, 'COMISION_INVALIDA'],
    ['concepto corto', { descripcion: '  ab ' }, 'DESCRIPCION_INVALIDA'],
    [
      'cliente inexistente',
      { cliente_id: '99999999-9999-4999-8999-999999999999' },
      'CLIENTE_NO_EXISTE',
    ],
    [
      'reembolso con vuelo inexistente',
      {
        categoria: 'REEMBOLSO_DEVOLUCION',
        vuelo_id: '99999999-9999-4999-8999-999999999999',
      },
      'VUELO_NO_EXISTE',
    ],
    ['campo extra', { inventado: 1 }, 'DATOS_INVALIDOS'],
    ['categoría desconocida', { categoria: 'COBRO_VUELO' }, 'DATOS_INVALIDOS'],
  ])('%s ⇒ 400 %s', async (_c, extra, esperado) => {
    const { svc, db, subidos } = armar(mundo());
    const r = await error(svc.crear(datos(extra), pdf, ADMIN));
    expect(r.code).toBe(esperado);
    expect(db.ingreso).toHaveLength(0);
    expect(subidos).toHaveLength(0);
  });

  it('efectivo sin cuenta y reembolso con vuelo SÍ entran', async () => {
    const { svc, db } = armar(mundo());
    await svc.crear(
      datos({
        categoria: 'REEMBOLSO_DEVOLUCION',
        metodo: 'EFECTIVO',
        cuenta_bancaria_id: null,
        vuelo_id: V_1,
        gasto_id: G_1,
      }),
      undefined,
      ADMIN,
    );
    expect(db.ingreso[0]).toMatchObject({
      categoria: 'REEMBOLSO_DEVOLUCION',
      cuenta_bancaria_id: null,
      vuelo_id: V_1,
    });
  });

  it('archivo de otro tipo ⇒ 400 ARCHIVO_TIPO_INVALIDO; > 10 MB ⇒ 413', async () => {
    const { svc } = armar(mundo());
    const heic = { ...pdf, originalname: 'foto.heic', mimetype: 'image/heic' };
    expect((await error(svc.crear(datos(), heic, ADMIN))).code).toBe(
      'ARCHIVO_TIPO_INVALIDO',
    );
    const grande = { ...pdf, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) };
    const r = await error(svc.crear(datos(), grande, ADMIN));
    expect(r.code).toBe('ARCHIVO_MUY_GRANDE');
    expect((r.e as HttpException).getStatus()).toBe(413);
  });
});

describe('alta — TC de un ingreso de resultado en USD', () => {
  it('sin TC ⇒ el OFICIAL de su fecha (con aviso)', async () => {
    const { svc, db, mocks } = armar(mundo());
    const r = await svc.crear(
      datos({ moneda: 'USD', cuenta_bancaria_id: CTA_USD }),
      undefined,
      ADMIN,
    );
    expect(mocks.tipoCambio.oficialDetallePara).toHaveBeenCalledWith(
      '2026-09-10',
    );
    expect(db.ingreso[0].tc_usd_mxn).toBe(18.2);
    expect(r.avisos.join(' ')).toMatch(/oficial/);
  });

  it('sin TC y sin oficial ⇒ 400 TC_REQUERIDO', async () => {
    const { svc, db, mocks } = armar(mundo());
    mocks.tipoCambio.oficialDetallePara.mockResolvedValue(null);
    const r = await error(
      svc.crear(
        datos({ moneda: 'USD', cuenta_bancaria_id: CTA_USD }),
        undefined,
        ADMIN,
      ),
    );
    expect(r.code).toBe('TC_REQUERIDO');
    expect(db.ingreso).toHaveLength(0);
  });

  it('APORTACIÓN en USD no necesita TC (no es resultado)', async () => {
    const { svc, db, mocks } = armar(mundo());
    await svc.crear(
      datos({
        categoria: 'APORTACION_PRESTAMO',
        moneda: 'USD',
        cuenta_bancaria_id: CTA_USD,
      }),
      undefined,
      ADMIN,
    );
    expect(mocks.tipoCambio.oficialDetallePara).not.toHaveBeenCalled();
    expect(db.ingreso[0].tc_usd_mxn).toBeNull();
  });

  it('TC con decimales de más se NORMALIZA a 6', async () => {
    const { svc, db } = armar(mundo());
    await svc.crear(
      datos({
        moneda: 'USD',
        cuenta_bancaria_id: CTA_USD,
        tc_usd_mxn: 18.12345678,
      }),
      undefined,
      ADMIN,
    );
    expect(db.ingreso[0].tc_usd_mxn).toBe(18.123457);
  });
});

describe('alta — escribe, sube el comprobante e idempotencia', () => {
  it('201: insert + comprobante + camino inverso', async () => {
    const { svc, db, subidos, mocks } = armar(mundo());
    const r = await svc.crear(datos({ client_request_id: LLAVE }), pdf, ADMIN);
    expect(db.ingreso).toHaveLength(1);
    expect(subidos[0]).toMatch(/^ingresos\/ingreso-1\/[0-9a-f-]+\.pdf$/);
    expect(db.ingreso[0]).toMatchObject({
      archivo_nombre: 'comprobante.pdf',
      client_request_id: LLAVE,
      created_by: 'u-admin',
    });
    expect(r.ingreso).toMatchObject({ etiqueta: 'ING-101', neto: 5000 });
    expect(r.movimiento_id).toBeNull();
    expect(mocks.conciliacion.intentarCruzarIngreso).toHaveBeenCalledWith(
      'ingreso-1',
      'u-admin',
    );
  });

  it('reintento con la MISMA llave ⇒ el existente con idempotente:true (sin 2.º insert)', async () => {
    const { svc, db } = armar(mundo());
    await svc.crear(datos({ client_request_id: LLAVE }), undefined, ADMIN);
    const r = await svc.crear(
      datos({ client_request_id: LLAVE }),
      undefined,
      ADMIN,
    );
    expect(r.idempotente).toBe(true);
    expect(db.ingreso).toHaveLength(1);
  });

  it('un 23514 de un CHECK se traduce a su code (nunca 500)', async () => {
    const { svc } = armar(mundo(), {
      fallar: [
        {
          tabla: 'ingreso',
          op: 'insert',
          error: {
            code: '23514',
            message:
              'new row for relation "ingreso" violates check constraint "ingreso_vuelo_chk"',
          },
        },
      ],
    });
    const r = await error(svc.crear(datos(), undefined, ADMIN));
    expect(r.code).toBe('VUELO_SOLO_EN_REEMBOLSO');
  });
});

// =====================================================================
describe('alta DESDE UN ABONO — candados anti doble conteo', () => {
  /** Caso REAL #235: SPEI directo de Cristy a la CLABE de Paywise. */
  const caso235 = (extra: Partial<Tablas> = {}) =>
    mundo({
      movimiento_bancario: [
        {
          id: M_CRISTY,
          cuenta_bancaria_id: CTA_PW,
          fecha: '2026-09-08',
          tipo: 'ABONO',
          monto: 19380,
          monto_bruto: null,
          comision_monto: null,
          descripcion: 'MARIA CRISTINA CHAVEZ BADIOLA : vuelo cristy badiola',
          referencia: null,
          conciliado: false,
          gasto_id: null,
          cobro_id: null,
          cobro_grupo_id: null,
          clasificacion_id: null,
          ingreso_id: null,
        },
      ],
      cobro_vuelo: [
        {
          id: 'c-235',
          vuelo_id: 'v-235',
          monto: 20400,
          moneda: 'MXN',
          metodo_cobro: 'TRANSFERENCIA',
          comision_banco_monto: 1020,
          fecha_cobro: '2026-09-08T17:00:00Z',
          cobro_grupo_id: null,
          ingreso_anticipo_id: null,
          vuelo: { folio: 235, cliente: { nombre: 'Cristy Chavez' } },
        },
      ],
      ...extra,
    });
  const desdeAbono = (extra: Row = {}) =>
    datos({
      monto: 19380,
      cuenta_bancaria_id: undefined,
      movimiento_bancario_id: M_CRISTY,
      client_request_id: LLAVE,
      ...extra,
    });

  it('#235: el abono cuadra con el cobro del vuelo ⇒ 409 ABONO_TIENE_COBRO_CANDIDATO (nada escrito)', async () => {
    const { svc, db, mocks } = armar(caso235());
    const r = await error(svc.crear(desdeAbono(), undefined, ADMIN));
    expect(r.code).toBe('ABONO_TIENE_COBRO_CANDIDATO');
    expect(r.message).toMatch(/vuelo #235 \(Cristy Chavez\)/);
    expect(r.details).toEqual({
      candidatos: [
        {
          tipo: 'COBRO_VUELO',
          id: 'c-235',
          etiqueta: 'Cobro · vuelo #235',
          cliente: 'Cristy Chavez',
          fecha: '2026-09-08',
          monto: 20400,
          neto: 19380,
        },
      ],
    });
    expect(db.ingreso).toHaveLength(0);
    expect(mocks.conciliacion.linkIngreso).not.toHaveBeenCalled();
  });

  it('#235 con aceptar_sin_cobro ⇒ se registra y se liga con ESA cuenta', async () => {
    const { svc, db, mocks } = armar(caso235());
    const r = await svc.crear(
      desdeAbono({ aceptar_sin_cobro: true }),
      undefined,
      ADMIN,
    );
    expect(db.ingreso[0].cuenta_bancaria_id).toBe(CTA_PW);
    expect(mocks.conciliacion.linkIngreso).toHaveBeenCalledWith(
      M_CRISTY,
      'ingreso-1',
      'u-admin',
    );
    expect(r.movimiento_id).toBe(M_CRISTY);
    // Con abono NO corre el camino inverso (la liga ya se hizo).
    expect(mocks.conciliacion.intentarCruzarIngreso).not.toHaveBeenCalled();
  });

  it('un REEMBOLSO que cuadra con un cobro también se detiene (suma a resultados)', async () => {
    const { svc } = armar(caso235());
    const r = await error(
      svc.crear(
        desdeAbono({ categoria: 'REEMBOLSO_DEVOLUCION' }),
        undefined,
        ADMIN,
      ),
    );
    expect(r.code).toBe('ABONO_TIENE_COBRO_CANDIDATO');
  });

  it('una APORTACIÓN no pasa por el candado de cobros (no es resultado ni anticipo)', async () => {
    const { svc, db } = armar(caso235());
    await svc.crear(
      desdeAbono({ categoria: 'APORTACION_PRESTAMO' }),
      undefined,
      ADMIN,
    );
    expect(db.ingreso).toHaveLength(1);
  });

  it('línea repetida del banco ⇒ 409 ABONO_POSIBLE_DUPLICADO; con aceptar_posible_duplicado pasa', async () => {
    const db = caso235({ cobro_vuelo: [] });
    db.movimiento_bancario.push({
      ...db.movimiento_bancario[0],
      id: 'm-cristy-2',
      referencia: '00000000006247178602',
      conciliado: true,
      clasificacion_id: 'cl-x',
    });
    const w = armar(db);
    const r = await error(w.svc.crear(desdeAbono(), undefined, ADMIN));
    expect(r.code).toBe('ABONO_POSIBLE_DUPLICADO');
    expect(r.details).toMatchObject({
      movimiento_id: 'm-cristy-2',
      conciliado: true,
    });
    await w.svc.crear(
      desdeAbono({
        aceptar_posible_duplicado: true,
        client_request_id: LLAVE2,
      }),
      undefined,
      ADMIN,
    );
    expect(w.db.ingreso).toHaveLength(1);
  });

  it('monto que no cuadra (±1.00) ⇒ 409 INGRESO_MONTO_DISTINTO', async () => {
    const { svc } = armar(caso235({ cobro_vuelo: [] }));
    const r = await error(
      svc.crear(desdeAbono({ monto: 19400 }), undefined, ADMIN),
    );
    expect(r.code).toBe('INGRESO_MONTO_DISTINTO');
    expect(r.details).toMatchObject({
      monto_abono: 19380,
      neto_ingreso: 19400,
    });
  });

  it('otra cuenta ⇒ 400 INGRESO_OTRA_CUENTA', async () => {
    const { svc } = armar(caso235({ cobro_vuelo: [] }));
    const r = await error(
      svc.crear(desdeAbono({ cuenta_bancaria_id: CTA }), undefined, ADMIN),
    );
    expect(r.code).toBe('INGRESO_OTRA_CUENTA');
  });

  it('COORDINADOR ⇒ 403 CONCILIAR_SOLO_ADMIN_FACTURACION', async () => {
    const { svc, db } = armar(caso235());
    const r = await error(svc.crear(desdeAbono(), undefined, COORD));
    expect(r.e).toBeInstanceOf(ForbiddenException);
    expect(r.code).toBe('CONCILIAR_SOLO_ADMIN_FACTURACION');
    expect(db.ingreso).toHaveLength(0);
  });

  it('si la LIGA falla: el ingreso se BORRA y el comprobante recién subido se retira', async () => {
    const { svc, db, mocks, subidos, retirados } = armar(
      caso235({ cobro_vuelo: [] }),
    );
    mocks.conciliacion.linkIngreso.mockRejectedValue(
      new ConflictException({ message: 'x', error: 'MOVIMIENTO_YA_LIGADO' }),
    );
    const r = await error(svc.crear(desdeAbono(), pdf, ADMIN));
    expect(r.code).toBe('MOVIMIENTO_YA_LIGADO');
    expect(db.ingreso).toHaveLength(0);
    expect(retirados).toEqual(subidos);
    expect(subidos).toHaveLength(1);
  });

  it('reintento de un alta desde abono YA ligada ⇒ 200 idempotente (no MOVIMIENTO_YA_LIGADO)', async () => {
    const db = caso235({
      ingreso: [
        ingresoRow('i-ya', {
          client_request_id: LLAVE,
          cuenta_bancaria_id: CTA_PW,
          monto: 19380,
        }),
      ],
    });
    db.movimiento_bancario[0] = {
      ...db.movimiento_bancario[0],
      ingreso_id: 'i-ya',
      conciliado: true,
    };
    const { svc, mocks } = armar(db);
    const r = await svc.crear(desdeAbono(), undefined, ADMIN);
    expect(r.idempotente).toBe(true);
    expect(r.movimiento_id).toBe(M_CRISTY);
    expect(mocks.conciliacion.linkIngreso).not.toHaveBeenCalled();
  });
});

// =====================================================================
describe('edición — candados contra el VIGENTE y estado FUSIONADO', () => {
  it('conciliado: el formulario completo con el MISMO dinero pasa; otro monto ⇒ 409 INGRESO_CONCILIADO', async () => {
    const w = armar(
      mundo({
        ingreso: [ingresoRow('i1')],
        movimiento_bancario: [
          { id: 'm1', ingreso_id: 'i1', fecha: '2026-09-10', monto: 5000 },
        ],
      }),
    );
    await w.svc.editar(
      'i1',
      JSON.stringify({
        monto: 5000,
        moneda: 'MXN',
        cuenta_bancaria_id: CTA,
        notas: 'hola',
      }),
      undefined,
      ADMIN,
    );
    expect(w.db.ingreso[0].notas).toBe('hola');
    const r = await error(
      w.svc.editar('i1', JSON.stringify({ monto: 5100 }), undefined, ADMIN),
    );
    expect(r.code).toBe('INGRESO_CONCILIADO');
    expect(r.details).toEqual({ movimiento_id: 'm1' });
  });

  it('anticipo con aplicaciones: ni categoría ni moneda; ni menos de lo aplicado', async () => {
    const w = armar(
      mundo({
        ingreso: [
          ingresoRow('ant', {
            categoria: 'ANTICIPO_CLIENTE',
            cliente_id: K_CRISTY,
            monto: 1000,
          }),
        ],
        cobro_vuelo: [
          {
            id: 'c1',
            monto: 600,
            comision_banco_monto: null,
            ingreso_anticipo_id: 'ant',
          },
        ],
      }),
    );
    expect(
      (
        await error(
          w.svc.editar(
            'ant',
            JSON.stringify({ categoria: 'OTRO_INGRESO', cliente_id: null }),
            undefined,
            ADMIN,
          ),
        )
      ).code,
    ).toBe('ANTICIPO_CON_APLICACIONES');
    const r = await error(
      w.svc.editar('ant', JSON.stringify({ monto: 500 }), undefined, ADMIN),
    );
    expect(r.code).toBe('ANTICIPO_MONTO_MENOR_A_APLICADO');
    expect(r.details).toEqual({ aplicado: 600, saldo: 400 });
    await w.svc.editar('ant', JSON.stringify({ monto: 700 }), undefined, ADMIN);
    expect(w.db.ingreso[0].monto).toBe(700);
  });

  it('un 23514 del TRIGGER (carrera) ⇒ 409 con su code, nunca 500', async () => {
    const w = armar(mundo({ ingreso: [ingresoRow('i1')] }), {
      fallar: [
        {
          tabla: 'ingreso',
          op: 'update',
          error: {
            code: '23514',
            message:
              'INGRESO_CONCILIADO: el ingreso ING-12 está conciliado con un abono del banco: desvincúlalo antes',
          },
        },
      ],
    });
    const r = await error(
      w.svc.editar('i1', JSON.stringify({ monto: 5100 }), undefined, ADMIN),
    );
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('INGRESO_CONCILIADO');
  });

  it('APORTACIÓN USD sin TC → OTRO_INGRESO: toma el TC oficial; sin oficial ⇒ TC_REQUERIDO', async () => {
    const base = () =>
      mundo({
        ingreso: [
          ingresoRow('i1', {
            categoria: 'APORTACION_PRESTAMO',
            moneda: 'USD',
            cuenta_bancaria_id: CTA_USD,
          }),
        ],
      });
    const w = armar(base());
    await w.svc.editar(
      'i1',
      JSON.stringify({ categoria: 'OTRO_INGRESO' }),
      undefined,
      ADMIN,
    );
    expect(w.db.ingreso[0]).toMatchObject({
      categoria: 'OTRO_INGRESO',
      tc_usd_mxn: 18.2,
    });
    const w2 = armar(base());
    w2.mocks.tipoCambio.oficialDetallePara.mockResolvedValue(null);
    expect(
      (
        await error(
          w2.svc.editar(
            'i1',
            JSON.stringify({ categoria: 'OTRO_INGRESO' }),
            undefined,
            ADMIN,
          ),
        )
      ).code,
    ).toBe('TC_REQUERIDO');
  });

  it('ponerle vuelo a un OTRO_INGRESO ⇒ VUELO_SOLO_EN_REEMBOLSO; quitarle la cuenta a una transferencia ⇒ EFECTIVO_SIN_CUENTA', async () => {
    const w = armar(mundo({ ingreso: [ingresoRow('i1')] }));
    expect(
      (
        await error(
          w.svc.editar(
            'i1',
            JSON.stringify({ vuelo_id: V_1 }),
            undefined,
            ADMIN,
          ),
        )
      ).code,
    ).toBe('VUELO_SOLO_EN_REEMBOLSO');
    expect(
      (
        await error(
          w.svc.editar(
            'i1',
            JSON.stringify({ cuenta_bancaria_id: null }),
            undefined,
            ADMIN,
          ),
        )
      ).code,
    ).toBe('EFECTIVO_SIN_CUENTA');
  });

  it('if_updated_at viejo ⇒ 409 CONFLICTO_VERSION', async () => {
    const w = armar(mundo({ ingreso: [ingresoRow('i1')] }));
    const r = await error(
      w.svc.editar(
        'i1',
        JSON.stringify({ notas: 'x', if_updated_at: '2026-01-01T00:00:00Z' }),
        undefined,
        ADMIN,
      ),
    );
    expect(r.code).toBe('CONFLICTO_VERSION');
  });

  it('archivo nuevo = REEMPLAZO: el anterior pasa al historial (nunca se borra)', async () => {
    const w = armar(
      mundo({
        ingreso: [
          ingresoRow('i1', {
            archivo_path: 'ingresos/i1/viejo.pdf',
            archivo_nombre: 'viejo.pdf',
          }),
        ],
      }),
    );
    await w.svc.editar('i1', '{}', pdf, ADMIN);
    expect(w.db.ingreso[0].archivo_nombre).toBe('comprobante.pdf');
    expect(w.db.ingreso[0].archivos_historial).toEqual([
      expect.objectContaining({
        path: 'ingresos/i1/viejo.pdf',
        accion: 'REEMPLAZADO',
      }),
    ]);
    expect(w.retirados).toEqual([]);
  });
});

describe('baja', () => {
  it('soft delete con motivo; conciliado / con aplicaciones / ya de baja ⇒ 409', async () => {
    const w = armar(
      mundo({
        ingreso: [
          ingresoRow('i-ok'),
          ingresoRow('i-conc'),
          ingresoRow('i-ant', {
            categoria: 'ANTICIPO_CLIENTE',
            cliente_id: K_CRISTY,
          }),
          ingresoRow('i-baja', {
            deleted_at: '2026-09-11T00:00:00Z',
            motivo_baja: 'error de captura',
          }),
        ],
        movimiento_bancario: [
          { id: 'm1', ingreso_id: 'i-conc', fecha: '2026-09-10', monto: 5000 },
        ],
        cobro_vuelo: [{ id: 'c1', monto: 100, ingreso_anticipo_id: 'i-ant' }],
      }),
    );
    expect((await error(w.svc.baja('i-ok', 'no', ADMIN))).code).toBe(
      'MOTIVO_INVALIDO',
    );
    await w.svc.baja('i-ok', 'capturado dos veces', ADMIN);
    expect(w.db.ingreso[0]).toMatchObject({
      deleted_by: 'u-admin',
      motivo_baja: 'capturado dos veces',
    });
    expect(
      (await error(w.svc.baja('i-conc', 'capturado dos veces', ADMIN))).code,
    ).toBe('INGRESO_CONCILIADO');
    expect(
      (await error(w.svc.baja('i-ant', 'capturado dos veces', ADMIN))).code,
    ).toBe('ANTICIPO_CON_APLICACIONES');
    expect(
      (await error(w.svc.baja('i-baja', 'capturado dos veces', ADMIN))).code,
    ).toBe('INGRESO_DADO_DE_BAJA');
  });
});

// =====================================================================
describe('aplicar un ANTICIPO a un vuelo', () => {
  const anticipo = (extra: Row = {}) =>
    ingresoRow('ant', {
      folio: 7,
      categoria: 'ANTICIPO_CLIENTE',
      cliente_id: K_CRISTY,
      monto: 10000,
      comision_monto: 885.7,
      metodo: 'PAYWISE',
      cuenta_bancaria_id: CTA_PW,
      referencia: 'PW-889',
      fecha: '2026-09-05',
      tc_usd_mxn: null,
      ...extra,
    });
  const dto = (extra: Row = {}) =>
    ({
      vuelo_id: V_1,
      monto: 3333.33,
      client_request_id: LLAVE,
      ...extra,
    }) as never;

  it('argumentos EXACTOS a createCobro (comisión proporcional, fecha del pago, 6.º parámetro)', async () => {
    const w = armar(mundo({ ingreso: [anticipo()] }));
    const r = await w.svc.aplicar(
      'ant',
      dto({ notas: 'mitad del viaje' }),
      ADMIN,
    );
    expect(w.mocks.flights.createCobro).toHaveBeenCalledWith(
      V_1,
      {
        monto: 3333.33,
        moneda: 'MXN',
        metodo_cobro: 'PAYWISE',
        cuenta_destino: null,
        tc_usd_mxn: undefined,
        comision_banco_monto: 295.23,
        referencia: 'PW-889',
        fecha_cobro: new Date('2026-09-05T12:00:00-05:00'),
        notas: 'Aplicado del anticipo ING-7 · mitad del viaje',
        client_request_id: LLAVE,
      },
      'u-admin',
      Rol.ADMIN,
      undefined,
      { ingreso_anticipo_id: 'ant' },
    );
    expect(w.mocks.flights.assertAccess).toHaveBeenCalledWith(V_1, ADMIN);
    expect(w.db.ingreso_bitacora).toEqual([
      expect.objectContaining({
        ingreso_id: 'ant',
        accion: 'APLICAR',
        nota: 'vuelo #312 · $3,333.33 MXN',
      }),
    ]);
    expect(r.aplicacion).toMatchObject({
      cobro_id: 'c-nuevo',
      vuelo_folio: 312,
      monto: 3333.33,
    });
  });

  it('anticipo SIN comisión ⇒ comision_banco_monto 0 EXPLÍCITO (nunca provisiona Paywise)', async () => {
    const w = armar(mundo({ ingreso: [anticipo({ comision_monto: null })] }));
    await w.svc.aplicar('ant', dto(), ADMIN);
    const args = (
      w.mocks.flights.createCobro.mock.calls[0] as unknown[]
    )[1] as Row;
    expect(args.comision_banco_monto).toBe(0);
  });

  it('saldo insuficiente ⇒ 409 ANTICIPO_SIN_SALDO con details', async () => {
    const w = armar(
      mundo({
        ingreso: [anticipo()],
        cobro_vuelo: [
          {
            id: 'c0',
            monto: 9000,
            comision_banco_monto: 797.13,
            ingreso_anticipo_id: 'ant',
          },
        ],
      }),
    );
    const r = await error(w.svc.aplicar('ant', dto({ monto: 1500 }), ADMIN));
    expect(r.code).toBe('ANTICIPO_SIN_SALDO');
    expect(r.details).toEqual({ saldo: 1000, monto: 1500 });
    expect(w.mocks.flights.createCobro).not.toHaveBeenCalled();
  });

  it('REINTENTO de una aplicación ya hecha con el saldo AGOTADO ⇒ 200 idempotente, sin 2.ª bitácora', async () => {
    const w = armar(
      mundo({
        ingreso: [anticipo()],
        cobro_vuelo: [
          {
            id: 'c-ya',
            vuelo_id: V_1,
            monto: 10000,
            moneda: 'MXN',
            comision_banco_monto: 885.7,
            fecha_cobro: '2026-09-05T17:00:00Z',
            registrado_por: 'u-admin',
            created_at: '2026-09-24T12:00:00Z',
            client_request_id: LLAVE,
            ingreso_anticipo_id: 'ant',
            vuelo: { folio: 312 },
          },
        ],
      }),
    );
    const r = await w.svc.aplicar('ant', dto({ monto: 10000 }), ADMIN);
    expect(r.idempotente).toBe(true);
    expect(r.anticipo).toEqual({ aplicado: 10000, saldo: 0 });
    expect(w.mocks.flights.createCobro).not.toHaveBeenCalled();
    expect(w.db.ingreso_bitacora).toHaveLength(0);
  });

  it('llave de un cobro de OTRO anticipo ⇒ 409 CLIENT_REQUEST_ID_EN_USO', async () => {
    const w = armar(
      mundo({
        ingreso: [anticipo()],
        cobro_vuelo: [
          { id: 'c-otro', client_request_id: LLAVE, ingreso_anticipo_id: null },
        ],
      }),
    );
    expect((await error(w.svc.aplicar('ant', dto(), ADMIN))).code).toBe(
      'CLIENT_REQUEST_ID_EN_USO',
    );
  });

  it('vuelo de OTRO cliente ⇒ 409 ANTICIPO_OTRO_CLIENTE; con aceptar_otro_cliente sí aplica', async () => {
    const w = armar(
      mundo({
        ingreso: [anticipo({ cliente_id: K_OTRO })],
      }),
    );
    const r = await error(w.svc.aplicar('ant', dto(), ADMIN));
    expect(r.code).toBe('ANTICIPO_OTRO_CLIENTE');
    expect(r.details).toEqual({
      cliente_anticipo: 'Otro Cliente',
      cliente_vuelo: 'Cristy Chavez',
    });
    await w.svc.aplicar('ant', dto({ aceptar_otro_cliente: true }), ADMIN);
    expect(w.mocks.flights.createCobro).toHaveBeenCalledTimes(1);
  });

  it('COBRO_EXCEDE_SALDO de createCobro pasa TAL CUAL', async () => {
    const w = armar(mundo({ ingreso: [anticipo()] }));
    w.mocks.flights.createCobro.mockRejectedValue(
      new ConflictException({ message: 'rebasa', error: 'COBRO_EXCEDE_SALDO' }),
    );
    expect((await error(w.svc.aplicar('ant', dto(), ADMIN))).code).toBe(
      'COBRO_EXCEDE_SALDO',
    );
    expect(w.db.ingreso_bitacora).toHaveLength(0);
  });

  it('el 23514 del TRIGGER (carrera de dos aplicaciones) ⇒ 409 ANTICIPO_SIN_SALDO', async () => {
    const w = armar(mundo({ ingreso: [anticipo()] }));
    w.mocks.flights.createCobro.mockRejectedValue(
      new Error(
        'ANTICIPO_SIN_SALDO: el anticipo ING-7 vale 10000.00, ya se aplicaron 9000.00 y este cobro (3333.33) lo rebasa',
      ),
    );
    const r = await error(w.svc.aplicar('ant', dto(), ADMIN));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('ANTICIPO_SIN_SALDO');
  });

  it('no es anticipo ⇒ 409 NO_ES_ANTICIPO', async () => {
    const w = armar(mundo({ ingreso: [ingresoRow('i1')] }));
    expect((await error(w.svc.aplicar('i1', dto(), ADMIN))).code).toBe(
      'NO_ES_ANTICIPO',
    );
  });

  it('desaplicar: 404 si el cobro no es de ese anticipo; si sí, deleteCobro', async () => {
    const w = armar(
      mundo({
        ingreso: [anticipo()],
        cobro_vuelo: [
          { id: 'c-a', monto: 3000, ingreso_anticipo_id: 'ant' },
          { id: 'c-n', monto: 100, ingreso_anticipo_id: null },
        ],
      }),
    );
    expect((await error(w.svc.desaplicar('ant', 'c-n', ADMIN))).code).toBe(
      'APLICACION_NO_EXISTE',
    );
    const r = await w.svc.desaplicar('ant', 'c-a', ADMIN);
    expect(w.mocks.flights.deleteCobro).toHaveBeenCalledWith('c-a', 'u-admin');
    expect(r.ok).toBe(true);
  });
});

// =====================================================================
describe('«Es el pago de un vuelo» (cobro-de-vuelo desde un abono)', () => {
  const conAbono = (mov: Row = {}) =>
    mundo({
      movimiento_bancario: [
        {
          id: 'm-leticia',
          cuenta_bancaria_id: CTA,
          fecha: '2026-09-09',
          tipo: 'ABONO',
          monto: 95000,
          monto_bruto: null,
          comision_monto: null,
          descripcion: 'LETICIA LEON ALVARADO : PAGO',
          referencia: '000125473315',
          conciliado: false,
          gasto_id: null,
          cobro_id: null,
          cobro_grupo_id: null,
          clasificacion_id: null,
          ingreso_id: null,
          ...mov,
        },
      ],
    });
  const dto = (extra: Row = {}) =>
    ({ vuelo_id: V_1, client_request_id: LLAVE, ...extra }) as never;

  it('crea el cobro por createCobro y lo liga (comisión 0 EXPLÍCITA)', async () => {
    const w = armar(conAbono());
    const r = await w.svc.cobroDeVueloDesdeAbono('m-leticia', dto(), ADMIN);
    expect(w.mocks.flights.createCobro).toHaveBeenCalledWith(
      V_1,
      {
        monto: 95000,
        moneda: 'MXN',
        metodo_cobro: 'TRANSFERENCIA',
        comision_banco_monto: 0,
        fecha_cobro: new Date('2026-09-09T12:00:00-05:00'),
        referencia: '000125473315',
        notas: 'Registrado desde el banco (2026-09-09)',
        client_request_id: LLAVE,
      },
      'u-admin',
      Rol.ADMIN,
    );
    expect(w.mocks.conciliacion.linkCobro).toHaveBeenCalledWith(
      'm-leticia',
      { cobro_id: 'c-nuevo' },
      'u-admin',
    );
    expect(r.movimiento_id).toBe('m-leticia');
  });

  it('cuenta PASARELA sin comision_monto ⇒ método PAYWISE y comisión 0 EXPLÍCITA', async () => {
    const w = armar(conAbono({ cuenta_bancaria_id: CTA_PW, monto: 19380 }));
    await w.svc.cobroDeVueloDesdeAbono('m-leticia', dto(), ADMIN);
    const args = (
      w.mocks.flights.createCobro.mock.calls[0] as unknown[]
    )[1] as Row;
    expect(args).toMatchObject({
      metodo_cobro: 'PAYWISE',
      comision_banco_monto: 0,
      monto: 19380,
    });
  });

  it('si la LIGA falla, el cobro recién creado se BORRA', async () => {
    const w = armar(conAbono());
    w.mocks.conciliacion.linkCobro.mockRejectedValue(
      new ConflictException({ message: 'x', error: 'MOVIMIENTO_YA_LIGADO' }),
    );
    const r = await error(
      w.svc.cobroDeVueloDesdeAbono('m-leticia', dto(), ADMIN),
    );
    expect(r.code).toBe('MOVIMIENTO_YA_LIGADO');
    expect(w.mocks.flights.deleteCobro).toHaveBeenCalledWith(
      'c-nuevo',
      'u-admin',
    );
  });

  it('monto que no cuadra ⇒ 409 INGRESO_MONTO_DISTINTO ANTES de crear nada', async () => {
    const w = armar(conAbono());
    const r = await error(
      w.svc.cobroDeVueloDesdeAbono('m-leticia', dto({ monto: 90000 }), ADMIN),
    );
    expect(r.code).toBe('INGRESO_MONTO_DISTINTO');
    expect(w.mocks.flights.createCobro).not.toHaveBeenCalled();
  });

  it('COORDINADOR ⇒ 403', async () => {
    const w = armar(conAbono());
    const r = await error(
      w.svc.cobroDeVueloDesdeAbono('m-leticia', dto(), COORD),
    );
    expect(r.code).toBe('CONCILIAR_SOLO_ADMIN_FACTURACION');
  });

  it('reintento ya ligado a ESTE abono ⇒ 200 idempotente', async () => {
    const db = conAbono({ cobro_id: 'c-ya', conciliado: true });
    db.cobro_vuelo = [{ id: 'c-ya', vuelo_id: V_1, client_request_id: LLAVE }];
    const w = armar(db);
    const r = await w.svc.cobroDeVueloDesdeAbono('m-leticia', dto(), ADMIN);
    expect(r.idempotente).toBe(true);
    expect(w.mocks.flights.createCobro).not.toHaveBeenCalled();
  });

  // Revisión adversaria 24-sep-2026: el vuelo YA tiene un cobro LIBRE que
  // cuadra con el abono (caso #235: 20,400 − 1,020 = 19,380). Crear otro
  // contaría el MISMO dinero dos veces en el vuelo (cobrosEnUsd).
  const cobroLibre = (extra: Row = {}): Row => ({
    id: 'c-libre',
    vuelo_id: V_1,
    monto: 20400,
    moneda: 'MXN',
    metodo_cobro: 'TRANSFERENCIA',
    comision_banco_monto: 1020,
    // Capturado MESES antes del depósito: el candado por vuelo no usa ventana.
    fecha_cobro: '2026-06-01T17:00:00Z',
    cobro_grupo_id: null,
    ingreso_anticipo_id: null,
    vuelo: { folio: 312, cliente: { nombre: 'Leticia León Alvarado' } },
    ...extra,
  });

  it('el vuelo YA tiene un cobro libre que cuadra ⇒ 409 ABONO_TIENE_COBRO_CANDIDATO (nada creado)', async () => {
    const db = conAbono({ monto: 19380 });
    db.cobro_vuelo = [cobroLibre()];
    const w = armar(db);
    const r = await error(
      w.svc.cobroDeVueloDesdeAbono('m-leticia', dto({ monto: 19380 }), ADMIN),
    );
    expect(r.code).toBe('ABONO_TIENE_COBRO_CANDIDATO');
    expect(r.message).toMatch(/vuelo #312 \(Leticia León Alvarado\)/);
    expect(r.details).toEqual({
      candidatos: [
        {
          tipo: 'COBRO_VUELO',
          id: 'c-libre',
          etiqueta: 'Cobro · vuelo #312',
          cliente: 'Leticia León Alvarado',
          fecha: '2026-06-01',
          monto: 20400,
          neto: 19380,
        },
      ],
    });
    expect(w.mocks.flights.createCobro).not.toHaveBeenCalled();
    expect(w.mocks.conciliacion.linkCobro).not.toHaveBeenCalled();
  });

  it('con aceptar_sin_cobro sí crea; un cobro YA ligado, de OTRO vuelo o de un anticipo no detiene', async () => {
    const db1 = conAbono({ monto: 19380 });
    db1.cobro_vuelo = [cobroLibre()];
    const w1 = armar(db1);
    await w1.svc.cobroDeVueloDesdeAbono(
      'm-leticia',
      dto({ monto: 19380, aceptar_sin_cobro: true }),
      ADMIN,
    );
    expect(w1.mocks.flights.createCobro).toHaveBeenCalledTimes(1);

    const db2 = conAbono({ monto: 19380 });
    db2.cobro_vuelo = [
      cobroLibre({ id: 'c-ligado' }),
      cobroLibre({ id: 'c-otro-vuelo', vuelo_id: 'v-otro' }),
      cobroLibre({ id: 'c-anticipo', ingreso_anticipo_id: 'i-ant' }),
    ];
    db2.movimiento_bancario.push({
      id: 'm-otro',
      cuenta_bancaria_id: CTA,
      fecha: '2026-06-01',
      tipo: 'ABONO',
      monto: 19380,
      conciliado: true,
      cobro_id: 'c-ligado',
    });
    const w2 = armar(db2);
    await w2.svc.cobroDeVueloDesdeAbono(
      'm-leticia',
      dto({ monto: 19380 }),
      ADMIN,
    );
    expect(w2.mocks.flights.createCobro).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================
describe('resumen y entradas — sin doble conteo y la regla de «cobros sin banco»', () => {
  const cobro = (
    id: string,
    monto: number,
    metodo: string,
    extra: Row = {},
  ): Row => ({
    id,
    vuelo_id: V_1,
    monto,
    moneda: 'MXN',
    metodo_cobro: metodo,
    comision_banco_monto: null,
    fecha_cobro: '2026-09-10T17:00:00Z',
    referencia: null,
    notas: null,
    registrado_por: 'u-admin',
    created_at: '2026-09-10T17:00:00Z',
    cobro_grupo_id: null,
    ingreso_anticipo_id: null,
    vuelo: {
      folio: 312,
      estado: 'COMPLETADO',
      fecha_vuelo: '2026-09-10T15:00:00Z',
      cliente: { nombre: 'Cristy Chavez' },
    },
    sobre: null,
    ...extra,
  });
  const periodo = () =>
    mundo({
      cobro_vuelo: [
        cobro('t1', 1000, 'TRANSFERENCIA'),
        cobro('t2', 700, 'TRANSFERENCIA'),
        cobro('ef', 300, 'EFECTIVO'),
        cobro('bp', 250, 'BILLPOCKET'),
        cobro('a1', 600, 'TRANSFERENCIA', { ingreso_anticipo_id: 'ant-1' }),
        cobro('a2', 200, 'TRANSFERENCIA', { ingreso_anticipo_id: 'ant-2' }),
        cobro('re', -100, 'TRANSFERENCIA'),
        cobro('dep', 900, 'TRANSFERENCIA', {
          fecha_cobro: '2026-09-12T17:00:00Z',
          vuelo: {
            folio: 400,
            estado: 'RESERVA',
            fecha_vuelo: '2999-01-01T15:00:00Z',
            cliente: null,
          },
        }),
      ],
      ingreso: [
        ingresoRow('ant-1', {
          folio: 1,
          categoria: 'ANTICIPO_CLIENTE',
          cliente_id: K_CRISTY,
          monto: 1000,
        }),
        ingresoRow('ant-2', {
          folio: 2,
          categoria: 'ANTICIPO_CLIENTE',
          cliente_id: K_CRISTY,
          monto: 200,
          fecha: '2026-08-20',
        }),
        ingresoRow('otro', {
          folio: 3,
          monto: 500,
          metodo: 'EFECTIVO',
          cuenta_bancaria_id: null,
        }),
        ingresoRow('apor', {
          folio: 4,
          categoria: 'APORTACION_PRESTAMO',
          monto: 2000,
        }),
      ],
      movimiento_bancario: [
        {
          id: 'm-t2',
          tipo: 'ABONO',
          cobro_id: 't2',
          cobro_grupo_id: null,
          ingreso_id: null,
          conciliado: true,
          fecha: '2026-09-10',
          monto: 700,
          cuenta_bancaria_id: CTA,
        },
        {
          id: 'm-ant2',
          tipo: 'ABONO',
          cobro_id: null,
          cobro_grupo_id: null,
          ingreso_id: 'ant-2',
          conciliado: true,
          fecha: '2026-08-20',
          monto: 200,
          cuenta_bancaria_id: CTA,
        },
        {
          id: 'm-libre',
          tipo: 'ABONO',
          cobro_id: null,
          cobro_grupo_id: null,
          ingreso_id: null,
          conciliado: false,
          fecha: '2026-09-11',
          monto: 333,
          cuenta_bancaria_id: CTA,
        },
      ],
    });

  it('los cobros de anticipo van a «aplicado» y NO al total; reembolsos aparte', async () => {
    const w = armar(periodo());
    const r = await w.svc.resumen({ desde: '2026-09-01', hasta: '2026-09-30' });
    const mxn = r.por_moneda[0];
    expect(mxn.moneda).toBe('MXN');
    expect(mxn.cobros_vuelo).toMatchObject({
      recibido: 3150,
      reembolsos: 100,
      n: 5,
    });
    expect(mxn.aplicado_de_anticipos).toEqual({ monto: 800, n: 2 });
    expect(mxn.depositos_por_volar).toEqual({ monto: 900, n: 1 });
    expect(mxn.otros_ingresos).toMatchObject({
      monto: 500,
      n: 1,
      no_bancario: 500,
    });
    expect(mxn.anticipos).toMatchObject({
      recibido: 1000,
      aplicado: 600,
      saldo: 400,
      n: 1,
      sin_conciliar: 1000,
    });
    expect(mxn.fuera_de_resultados).toEqual({ monto: 2000, n: 1 });
    // 3150 cobros + 500 otros + 1000 anticipo + 2000 aportación (sin los 800 aplicados).
    expect(mxn.total_recibido).toBe(6650);
    expect(mxn.neto_de_reembolsos).toBe(6550);
    expect(mxn.abonos_por_identificar).toEqual({ n: 1, monto: 333 });
    // Saldo de anticipos de CUALQUIER fecha (ant-2 ya se agotó).
    expect(r.anticipos_con_saldo).toEqual([
      { moneda: 'MXN', saldo: 400, n: 1 },
    ]);
  });

  it('«sin conciliar» de los cobros == «Cobros sin banco» del mismo periodo (una sola regla)', async () => {
    const w = armar(periodo(), { conciliacionReal: true });
    const r = await w.svc.resumen({ desde: '2026-09-01', hasta: '2026-09-30' });
    const csb = await w.conciliacion.cobrosSinBanco('2026-09-01', '2026-09-30');
    const total = csb.por_moneda.find((m) => m.moneda === 'MXN')?.monto ?? 0;
    // t1 1000 + dep 900 + a1 600 (anticipo SIN conciliar) — BillPocket y efectivo no.
    expect(total).toBe(2500);
    expect(r.por_moneda[0].cobros_vuelo.sin_conciliar).toBe(total);
  });

  it('entradas: orden por día, cuenta_en_total, VIA_ANTICIPO solo con el anticipo conciliado, BillPocket NO_BANCARIO', async () => {
    const w = armar(periodo());
    const r = await w.svc.entradas({
      desde: '2026-09-01',
      hasta: '2026-09-30',
      limit: 50,
      offset: 0,
    });
    const por = new Map(r.data.map((e) => [e.id, e]));
    expect(r.data[0].dia >= r.data[r.data.length - 1].dia).toBe(true);
    expect(por.get('a1')).toMatchObject({
      cuenta_en_total: false,
      anticipo_etiqueta: 'ING-1',
      conciliacion: { estado: 'SIN_CONCILIAR', movimiento_id: null },
    });
    expect(por.get('a2')).toMatchObject({
      cuenta_en_total: false,
      conciliacion: { estado: 'VIA_ANTICIPO', movimiento_id: 'm-ant2' },
    });
    expect(por.get('t2')?.conciliacion.estado).toBe('CONCILIADO');
    expect(por.get('bp')?.conciliacion.estado).toBe('NO_BANCARIO');
    expect(por.get('re')).toMatchObject({ es_reembolso: true, monto: -100 });
    expect(por.get('dep')?.por_volar).toBe(true);
    expect(por.get('otro')).toMatchObject({
      origen: 'INGRESO',
      etiqueta: 'ING-3',
      cuenta_en_total: true,
    });
    const porVolar = await w.svc.entradas({
      desde: '2026-09-01',
      hasta: '2026-09-30',
      vuelo: 'por_volar',
      limit: 50,
      offset: 0,
    });
    expect(porVolar.data.map((e) => e.id)).toEqual(['dep']);
  });

  it('lista de anticipos «con saldo» ignora el periodo; el banner filtra por cliente', async () => {
    const w = armar(periodo());
    const r = await w.svc.lista({
      vista: 'anticipos',
      cliente_id: K_CRISTY,
      desde: '2026-12-01',
      hasta: '2026-12-31',
      limit: 5,
      offset: 0,
    });
    expect(r.data.map((i) => [i.etiqueta, i.anticipo])).toEqual([
      ['ING-1', { aplicado: 600, saldo: 400, aplicaciones_n: 1 }],
    ]);
  });
});

describe('sin la migración', () => {
  it('todo responde 503 INGRESOS_NO_DISPONIBLE', async () => {
    const w = armar(mundo(), { sinMigracion: true });
    for (const p of [
      w.svc.resumen({}),
      w.svc.entradas({ limit: 50, offset: 0 }),
      w.svc.lista({ limit: 50, offset: 0 }),
      w.svc.crear(datos(), undefined, ADMIN),
      w.svc.obtener('i1'),
    ]) {
      const r = await error(p);
      expect(r.e).toBeInstanceOf(ServiceUnavailableException);
      expect(r.code).toBe('INGRESOS_NO_DISPONIBLE');
    }
  });
});

describe('vuelos candidatos y detalle', () => {
  it('cobrado SOLO de cobroStatus (cobrosEnUsd), saldo y otro cliente; sin cliente exige ≥ 2 caracteres', async () => {
    const w = armar(
      mundo({
        vuelo: [
          {
            id: V_1,
            folio: 312,
            cliente_id: K_CRISTY,
            fecha_vuelo: '2026-09-20T15:00:00Z',
            estado: 'CONFIRMADO',
            monto_total_usd: 2000,
            tc_usd_mxn: 18,
            cliente: { nombre: 'Cristy Chavez' },
          },
          {
            id: 'v-2',
            folio: 313,
            cliente_id: K_OTRO,
            fecha_vuelo: '2026-09-21T15:00:00Z',
            estado: 'RESERVA',
            monto_total_usd: 0,
            tc_usd_mxn: null,
            cliente: { nombre: 'Otro Cliente' },
          },
        ],
        escala: [
          {
            vuelo_id: V_1,
            orden: 1,
            origen_iata: 'CUN',
            destino_iata: 'MID',
            cancelada_at: null,
          },
          {
            vuelo_id: V_1,
            orden: 2,
            origen_iata: 'MID',
            destino_iata: 'CUN',
            cancelada_at: null,
          },
        ],
      }),
    );
    w.mocks.flights.cobroStatus.mockResolvedValue({
      [V_1]: { total_cobrado: 1500.5, sin_tc_count: 0 },
    });
    const r = await w.svc.vuelosCandidatos({ cliente_id: K_CRISTY });
    expect(r.data).toEqual([
      {
        vuelo_id: V_1,
        folio: 312,
        fecha_vuelo: '2026-09-20T15:00:00Z',
        estado: 'CONFIRMADO',
        cliente_nombre: 'Cristy Chavez',
        ruta: 'CUN → MID → CUN',
        monto_total_usd: 2000,
        cobrado_usd: 1500.5,
        saldo_usd: 499.5,
        tc_usd_mxn: 18,
        es_otro_cliente: false,
      },
    ]);
    const todos = await w.svc.vuelosCandidatos({
      cliente_id: K_CRISTY,
      alcance: 'todos',
      q: '313',
    });
    expect(todos.data[0]).toMatchObject({
      folio: 313,
      saldo_usd: null,
      es_otro_cliente: true,
    });
    expect((await error(w.svc.vuelosCandidatos({ q: 'a' }))).code).toBe(
      'BUSQUEDA_CORTA',
    );
  });

  it('detalle: aplicaciones, abono y bitácora con los campos en palabras', async () => {
    const w = armar(
      mundo({
        ingreso: [
          ingresoRow('ant', {
            categoria: 'ANTICIPO_CLIENTE',
            cliente_id: K_CRISTY,
            monto: 1000,
          }),
        ],
        cobro_vuelo: [
          {
            id: 'c1',
            vuelo_id: V_1,
            monto: 600,
            moneda: 'MXN',
            comision_banco_monto: null,
            fecha_cobro: '2026-09-11T17:00:00Z',
            registrado_por: 'u-admin',
            created_at: '2026-09-11T17:00:00Z',
            ingreso_anticipo_id: 'ant',
            vuelo: { folio: 312 },
          },
        ],
        movimiento_bancario: [
          {
            id: 'm1',
            ingreso_id: 'ant',
            fecha: '2026-09-10',
            monto: 1000,
            descripcion: 'SPEI CRISTY',
            cuenta: { alias: 'Scotia MXN' },
          },
        ],
        ingreso_bitacora: [
          {
            id: 'b1',
            ingreso_id: 'ant',
            accion: 'UPDATE',
            actor_id: 'u-admin',
            diff: { monto: { antes: 900, despues: 1000 } },
            nota: null,
            created_at: '2026-09-10T13:00:00Z',
          },
        ],
      }),
    );
    const d = await w.svc.obtener('ant');
    expect(d.ingreso).toMatchObject({
      anticipo: { aplicado: 600, saldo: 400, aplicaciones_n: 1 },
      conciliacion: { estado: 'CONCILIADO', movimiento_id: 'm1' },
    });
    expect(d.aplicaciones).toEqual([
      expect.objectContaining({ cobro_id: 'c1', vuelo_folio: 312, monto: 600 }),
    ]);
    expect(d.movimiento).toEqual({
      id: 'm1',
      fecha: '2026-09-10',
      monto: 1000,
      descripcion: 'SPEI CRISTY',
      cuenta_alias: 'Scotia MXN',
    });
    expect(d.bitacora[0]).toMatchObject({
      accion: 'UPDATE',
      actor_nombre: 'Admin',
      cambios: [{ campo: 'Monto', antes: 900, despues: 1000 }],
    });
    await expect(w.svc.obtener('no-existe')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
