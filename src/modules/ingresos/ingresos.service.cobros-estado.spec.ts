// La cadena real de FlightsService arrastra googleapis y `jose` (ESM): se
// stubbea. ConciliacionService es la REAL en la prueba de paridad con
// «Cobros sin banco».
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import { IngresosService } from './ingresos.service';
import { ConciliacionService } from '../conciliacion/conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { FlightsService } from '../flights/flights.service';
import type { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';

/**
 * UN COBRO, VARIOS ABONOS en Ingresos (14-oct-2026, API 0.0.78, invariante
 * 77). La lista conserva sus 4 estados: un cobro con abonos que NO lo
 * completan viaja como SIN_CONCILIAR + el aditivo `conciliacion.parcial`
 * {monto_vinculado, faltante, abonos_n}; el resumen lo cuenta en
 * `sin_conciliar` (el MISMO número que «Cobros sin banco»); y el replay de
 * «Es el pago de un vuelo» reconoce SU abono aunque el cobro tenga otros.
 * Caso real: #315 de Beh Kay ($3,400 en dos SPEI de $1,700).
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const CTA = 'c0000000-0000-4000-8000-000000000001';
const V315 = 'f0000000-0000-4000-8000-000000000315';
const LLAVE = '11111111-1111-4111-8111-111111111111';
const ADMIN = {
  authId: 'a',
  userId: 'u-admin',
  email: 'x@y',
  nombre: 'Admin',
  rol: Rol.ADMIN,
  estado: 'ACTIVO',
  jwt: '',
} as unknown as AuthenticatedUser;

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

/** Columnas que NO existen sin sus migraciones (las demás, sí). */
const AUSENTES = [
  'gastos_n',
  'reverso_de_id',
  'orden_archivo',
  'folio_releido_at',
];

/** Mini-PostgREST con los embeds de estas lecturas (vuelo + cliente, cuenta, abono de la puente). */
function fakeSupabase(db: Tablas) {
  const conCuenta = (sel: string, r: Row | undefined): Row | null => {
    if (!r) return null;
    return sel.includes('cuenta:cuenta_bancaria')
      ? {
          ...r,
          cuenta:
            (db.cuenta_bancaria ?? []).find(
              (c) => c.id === r.cuenta_bancaria_id,
            ) ?? null,
        }
      : { ...r };
  };
  const embeber = (tabla: string, sel: string, r: Row): Row => {
    let out: Row = { ...r };
    if (/\bvuelo:vuelo!vuelo_id\(/.test(sel)) {
      const v = (db.vuelo ?? []).find((x) => x.id === r.vuelo_id) ?? null;
      out.vuelo = v
        ? {
            ...v,
            cliente:
              (db.cliente ?? []).find((c) => c.id === v.cliente_id) ?? null,
          }
        : null;
    }
    if (/\bsobre:cobro_grupo!/.test(sel)) out.sobre = null;
    if (/\bmovimiento:movimiento_bancario!movimiento_id\(/.test(sel)) {
      out.movimiento = conCuenta(
        sel,
        (db.movimiento_bancario ?? []).find((x) => x.id === r.movimiento_id),
      );
    } else if (tabla === 'movimiento_bancario') {
      out = conCuenta(sel, out) as Row;
    }
    return out;
  };
  const service = {
    storage: { from: () => ({}) },
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let sel = '';
      let rango: [number, number] | null = null;
      let limite: number | null = null;
      const orden: Array<[string, boolean]> = [];
      let prohibido = false;
      const marcar = (t: string) => {
        if (AUSENTES.some((c) => new RegExp(`\\b${c}\\b`).test(t))) {
          prohibido = true;
        }
      };
      const ejecutar = (unico: boolean) => {
        if (prohibido) {
          return {
            data: null,
            error: { code: '42703', message: 'column x does not exist' },
          };
        }
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        let out = filas.map((r) => embeber(tabla, sel, r));
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
      const api: Record<string, unknown> = {
        select(s?: string) {
          sel = s ?? '';
          marcar(sel);
          return api;
        },
        eq(col: string, val: unknown) {
          filtros.push((r) => r[col] === val);
          return api;
        },
        neq(col: string, val: unknown) {
          filtros.push((r) => r[col] !== val);
          return api;
        },
        is(col: string, val: unknown) {
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        not(col: string, o: string, val: unknown) {
          if (o === 'is' && val === null) {
            filtros.push((r) => (r[col] ?? null) !== null);
          }
          return api;
        },
        in(col: string, vals: unknown[]) {
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        or() {
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
    rpc: () => Promise.resolve({ data: true, error: null }),
  };
  return { supabase: { service } as unknown as SupabaseService };
}

const abono = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-15',
  tipo: 'ABONO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion: 'TRANSF INTERBANCARIA SPEI',
  referencia: null,
  conciliado: true,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  ingreso_id: null,
  cobros_n: 1,
  created_at: '2026-10-06T15:22:46Z',
  ...extra,
});

const cobro = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  vuelo_id: V315,
  monto,
  moneda: 'MXN',
  metodo_cobro: 'TRANSFERENCIA',
  comision_banco_monto: null,
  fecha_cobro: '2026-09-15T17:00:00Z',
  referencia: null,
  notas: null,
  registrado_por: 'u-admin',
  created_at: '2026-09-15T17:00:00Z',
  cobro_grupo_id: null,
  ingreso_anticipo_id: null,
  ...extra,
});

/**
 * #315 ($3,400) con UN SPEI de $1,700 (m1, 15-sep); #316 ($1,000) cubierto
 * por m3; #317 ($500) libre. `conSegundo` liga el 2.º SPEI (m2, 16-sep).
 */
function mundo(conSegundo = false): Tablas {
  const movs = [
    abono('m1', 1700, { cobro_id: 'c315', fecha: '2026-09-15' }),
    abono('m2', 1700, {
      fecha: '2026-09-16',
      ...(conSegundo
        ? { cobro_id: 'c315' }
        : { conciliado: false, cobros_n: 0 }),
    }),
    abono('m3', 1000, { cobro_id: 'c316' }),
  ];
  const partes = [
    { movimiento_id: 'm1', cobro_id: 'c315', monto_parte: 1700 },
    { movimiento_id: 'm3', cobro_id: 'c316', monto_parte: 1000 },
    ...(conSegundo
      ? [{ movimiento_id: 'm2', cobro_id: 'c315', monto_parte: 1700 }]
      : []),
  ];
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'EJE SCOTIA',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
    ],
    cliente: [{ id: 'k-behkay', nombre: 'Beh Kay', activo: true }],
    vuelo: [
      {
        id: V315,
        folio: 315,
        estado: 'COMPLETADO',
        fecha_vuelo: '2026-09-15T14:00:00Z',
        cliente_id: 'k-behkay',
      },
    ],
    usuario: [{ id: 'u-admin', nombre: 'Admin' }],
    ingreso: [],
    ingreso_bitacora: [],
    cobro_vuelo: [cobro('c315', 3400), cobro('c316', 1000), cobro('c317', 500)],
    cobro_grupo: [],
    movimiento_bancario: movs,
    movimiento_bancario_cobro: partes,
    conciliacion_clasificacion: [],
    tarjeta_corporativa: [],
  };
}

function armar(db: Tablas) {
  const f = fakeSupabase(db);
  const conciliacion = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    f.supabase,
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  const flights = {
    createCobro: jest.fn(),
    listCobros: jest.fn().mockResolvedValue([]),
  };
  const svc = new IngresosService(
    f.supabase,
    flights as unknown as FlightsService,
    conciliacion,
    {} as TipoCambioService,
    { generateTablaXlsx: jest.fn() } as unknown as PyservicesService,
  );
  return { svc, conciliacion, flights };
}

const PERIODO = { desde: '2026-09-01', hasta: '2026-09-30' };

describe('Ingresos — un cobro PARCIAL (invariante 77)', () => {
  it('entradas: #315 con un SPEI de $1,700 = «Sin conciliar» + parcial; el cubierto y el libre como siempre', async () => {
    const { svc } = armar(mundo());
    const r = await svc.entradas({ ...PERIODO, limit: 50, offset: 0 });
    const por = new Map(r.data.map((e) => [e.id, e]));
    expect(por.get('c315')?.conciliacion).toEqual({
      estado: 'SIN_CONCILIAR',
      movimiento_id: 'm1',
      parcial: { monto_vinculado: 1700, faltante: 1700, abonos_n: 1 },
    });
    expect(por.get('c316')?.conciliacion).toEqual({
      estado: 'CONCILIADO',
      movimiento_id: 'm3',
      parcial: null,
    });
    expect(por.get('c317')?.conciliacion).toEqual({
      estado: 'SIN_CONCILIAR',
      movimiento_id: null,
      parcial: null,
    });
    // El filtro «Sin conciliar» trae el parcial (la misma regla del resumen).
    const sin = await svc.entradas({
      ...PERIODO,
      conciliacion: 'sin_conciliar',
      limit: 50,
      offset: 0,
    });
    expect(sin.data.map((e) => e.id).sort()).toEqual(['c315', 'c317']);
  });

  it('con el 2.º SPEI: CONCILIADO, sin parcial y movimiento_id = el abono MÁS ANTIGUO', async () => {
    const { svc } = armar(mundo(true));
    const r = await svc.entradas({ ...PERIODO, limit: 50, offset: 0 });
    expect(r.data.find((e) => e.id === 'c315')?.conciliacion).toEqual({
      estado: 'CONCILIADO',
      movimiento_id: 'm1',
      parcial: null,
    });
  });

  it('resumen: el parcial cuenta en «sin conciliar» con el MISMO número que «Cobros sin banco»', async () => {
    const { svc, conciliacion } = armar(mundo());
    const r = await svc.resumen(PERIODO);
    const csb = await conciliacion.cobrosSinBanco(PERIODO.desde, PERIODO.hasta);
    const mxn = csb.por_moneda.find((m) => m.moneda === 'MXN');
    // #315 (3,400, parcial) + #317 (500, libre); #316 está cubierto.
    expect(mxn?.monto).toBe(3900);
    expect(csb.parciales).toBe(1);
    expect(r.por_moneda[0].cobros_vuelo).toMatchObject({
      conciliado: 1000,
      sin_conciliar: 3900,
    });
    expect(r.por_moneda[0].cobros_vuelo.sin_conciliar).toBe(mxn?.monto);
  });
});

describe('«Es el pago de un vuelo» — el replay busca SU abono entre TODAS las ligas', () => {
  it('cobro ya creado con esa llave y ligado a este abono y a OTRO ⇒ 200 idempotente (no CLIENT_REQUEST_ID_EN_USO)', async () => {
    const db = mundo(true);
    // El cobro nació de m2 («Es el pago de un vuelo»); m1 lo ligó después.
    db.cobro_vuelo[0].client_request_id = LLAVE;
    const { svc, flights } = armar(db);
    const r = await svc.cobroDeVueloDesdeAbono(
      'm2',
      { vuelo_id: V315, client_request_id: LLAVE },
      ADMIN,
    );
    expect(r).toMatchObject({ movimiento_id: 'm2', idempotente: true });
    expect(flights.createCobro).not.toHaveBeenCalled();
  });

  it('ligado SOLO a otro abono ⇒ 409 CLIENT_REQUEST_ID_EN_USO (como siempre)', async () => {
    const db = mundo();
    db.cobro_vuelo[0].client_request_id = LLAVE;
    db.movimiento_bancario[1].conciliado = false;
    const { svc } = armar(db);
    const err = await svc
      .cobroDeVueloDesdeAbono(
        'm2',
        { vuelo_id: V315, client_request_id: LLAVE },
        ADMIN,
      )
      .catch((e: unknown) => e);
    expect(
      (err as { getResponse: () => { error?: string } }).getResponse().error,
    ).toBe('CLIENT_REQUEST_ID_EN_USO');
  });
});
