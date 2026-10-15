// La cadena real de FlightsService arrastra googleapis y `jose` (ESM): se
// stubbea. ConciliacionService también (aquí solo se llama `linkCobro`).
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import type { HttpException } from '@nestjs/common';
import { IngresosService } from './ingresos.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { FlightsService } from '../flights/flights.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';
import type { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';

/**
 * UN COBRO, VARIOS ABONOS — ANTI DOBLE CONTEO EN INGRESOS (14-oct-2026, API
 * 0.0.78, invariante 77, D12). Un cobro PARCIAL todavía espera dinero: un
 * abono que cuadra con su FALTANTE es su pago, no «otro ingreso» ni un cobro
 * nuevo del vuelo. Caso real: #315 de Beh Kay ($3,400 en dos SPEI de
 * $1,700). Se congela:
 * - «registrar como otro ingreso» el 2.º SPEI ⇒ 409 ABONO_TIENE_COBRO_
 *   CANDIDATO con el texto del parcial y el candidato {parcial, faltante,
 *   monto_vinculado, abonos_n} (los demás candidatos, byte a byte);
 * - «Es el pago de un vuelo» con el 2.º SPEI para el vuelo #315 ⇒ el mismo
 *   409 («en vez de registrar otro cobro»), sin crear nada;
 * - un abono de la PASARELA no completa parciales; sin la sonda de
 *   20261014000003, como el 0.0.77;
 * - «Es el pago de un vuelo» con una comisión que el banco no descontó (o
 *   una pasarela sin la comisión real) ⇒ 409 COMISION_NO_CUADRA ANTES de
 *   crear el cobro (la liga lo rechazaría y la compensación lo borraría).
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const CTA = 'c0000000-0000-4000-8000-000000000001';
const CTA_PW = 'c0000000-0000-4000-8000-000000000002';
const V315 = 'f0000000-0000-4000-8000-000000000315';
const C315 = 'b0000000-0000-4000-8000-000000000315';
const M1 = 'a0000000-0000-4000-8000-000000000001';
const M2 = 'a0000000-0000-4000-8000-000000000002';
const M_PW = 'a0000000-0000-4000-8000-000000000003';
const M_5000 = 'a0000000-0000-4000-8000-000000000004';
const M_PW_BRUTO = 'a0000000-0000-4000-8000-000000000005';
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

/**
 * Mini-PostgREST de solo lectura con los embeds de estas lecturas (vuelo +
 * cliente, cuenta, abono de la puente). `bdVieja` = la sonda de
 * 20261014000003 responde el PGRST202 real.
 */
function fakeSupabase(db: Tablas, opts: { bdVieja?: boolean } = {}) {
  const log: Array<{ tabla: string; sel: string }> = [];
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
        log.push({ tabla, sel });
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
    rpc: (nombre: string) =>
      Promise.resolve(
        nombre === 'regla_cobro_cubierto' && opts.bdVieja
          ? {
              data: null,
              error: {
                code: 'PGRST202',
                message:
                  'Could not find the function public.regla_cobro_cubierto(p_cruzado, p_n_partes, p_neto, p_suma) in the schema cache',
              },
            }
          : { data: true, error: null },
      ),
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

const abono = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-16',
  tipo: 'ABONO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion: 'TRANSF INTERBANCARIA SPEI',
  referencia: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  ingreso_id: null,
  cobros_n: 0,
  created_at: '2026-09-17T15:22:46Z',
  ...extra,
});

/** #315 ($3,400) con el 1.er SPEI de $1,700 (M1) ligado; el 2.º (M2) libre. */
function mundo(): Tablas {
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'EJE SCOTIA',
        banco: 'Scotiabank',
        moneda: 'MXN',
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
    ingreso: [],
    cobro_vuelo: [
      {
        id: C315,
        vuelo_id: V315,
        monto: 3400,
        moneda: 'MXN',
        metodo_cobro: 'TRANSFERENCIA',
        comision_banco_monto: null,
        fecha_cobro: '2026-09-15T17:00:00Z',
        cobro_grupo_id: null,
        ingreso_anticipo_id: null,
        client_request_id: null,
      },
    ],
    cobro_grupo: [],
    movimiento_bancario: [
      abono(M1, 1700, {
        fecha: '2026-09-15',
        conciliado: true,
        cobro_id: C315,
        cobros_n: 1,
      }),
      abono(M2, 1700),
      abono(M_PW, 1700, { cuenta_bancaria_id: CTA_PW }),
      abono(M_5000, 5000),
      abono(M_PW_BRUTO, 9000, {
        cuenta_bancaria_id: CTA_PW,
        monto_bruto: 10000,
      }),
    ],
    movimiento_bancario_cobro: [
      { movimiento_id: M1, cobro_id: C315, monto_parte: 1700 },
    ],
  };
}

function armar(db: Tablas, opts: { bdVieja?: boolean } = {}) {
  const f = fakeSupabase(db, opts);
  const flights = {
    assertAccess: jest.fn().mockResolvedValue(undefined),
    createCobro: jest.fn().mockResolvedValue({
      id: 'b0000000-0000-4000-8000-00000000c0de',
      monto: 5000,
      metodo_cobro: 'TRANSFERENCIA',
    }),
    deleteCobro: jest.fn(),
    listCobros: jest.fn().mockResolvedValue([]),
    solicitarFacturaPorCobros: jest.fn().mockResolvedValue({ solicitados: [] }),
    avisarCambioSolicitudAutomatica: jest.fn().mockResolvedValue(undefined),
  };
  const conciliacion = { linkCobro: jest.fn().mockResolvedValue({}) };
  const svc = new IngresosService(
    f.supabase,
    flights as unknown as FlightsService,
    conciliacion as unknown as ConciliacionService,
    {} as TipoCambioService,
    {} as PyservicesService,
  );
  return { svc, flights, conciliacion, log: f.log };
}

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

/** «Registrar como otro ingreso» el abono `movId`. */
const otroIngreso = (movId: string, monto: number, extra: Row = {}) =>
  JSON.stringify({
    categoria: 'OTRO_INGRESO',
    fecha: '2026-09-16',
    descripcion: 'Depósito sin identificar',
    monto,
    moneda: 'MXN',
    metodo: 'TRANSFERENCIA',
    movimiento_bancario_id: movId,
    client_request_id: LLAVE,
    ...extra,
  });

/** Acceso al freno (privado) para las variantes. */
function cuadranCon(
  svc: IngresosService,
  movId: string,
  db: Tablas,
  opts?: { pasarela?: boolean },
) {
  const abonoRow = db.movimiento_bancario.find((m) => m.id === movId) as Row;
  return (
    svc as unknown as {
      cobrosQueCuadranConAbono: (
        a: Row,
        m: string,
        v?: string,
        o?: { pasarela?: boolean },
      ) => Promise<Row[]>;
    }
  ).cobrosQueCuadranConAbono(abonoRow, 'MXN', undefined, opts);
}

describe('«Registrar como otro ingreso» — el 2.º SPEI es lo que le FALTA a #315', () => {
  it('⇒ 409 ABONO_TIENE_COBRO_CANDIDATO con el texto del parcial y el candidato {parcial, faltante, monto_vinculado, abonos_n}', async () => {
    const { svc } = armar(mundo());
    const r = await error(svc.crear(otroIngreso(M2, 1700), undefined, ADMIN));
    expect(r.code).toBe('ABONO_TIENE_COBRO_CANDIDATO');
    expect(r.message).toBe(
      'El cobro del vuelo #315 ($3,400.00 MXN) ya tiene un abono de $1,700.00 y le faltan $1,700.00: vincula este abono a ese cobro en vez de registrarlo como ingreso. Si de verdad es otro dinero, confírmalo.',
    );
    const candidatos = (r.details as { candidatos: Row[] }).candidatos;
    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]).toMatchObject({
      tipo: 'COBRO_VUELO',
      id: C315,
      etiqueta: 'Cobro · vuelo #315',
      cliente: 'Beh Kay',
      fecha: '2026-09-15',
      monto: 3400,
      neto: 3400,
      parcial: true,
      faltante: 1700,
      monto_vinculado: 1700,
      abonos_n: 1,
    });
    // Lo interno (vuelo y folio) no viaja.
    expect(Object.keys(candidatos[0]).sort()).toEqual(
      [
        'abonos_n',
        'cliente',
        'etiqueta',
        'faltante',
        'fecha',
        'fecha_vuelo',
        'id',
        'monto',
        'monto_vinculado',
        'neto',
        'parcial',
        'tipo',
      ].sort(),
    );
  });

  it('el freno: tolerancia ±1.00 sobre el faltante (como siempre); una cifra lejana, un abono de la PASARELA o la BD vieja ⇒ nada', async () => {
    const db = mundo();
    const { svc } = armar(db);
    // 1,700.80 contra el faltante de 1,700 ⇒ cuadra (±1.00 de Ingresos).
    db.movimiento_bancario.push(
      abono('a0000000-0000-4000-8000-000000000009', 1700.8),
    );
    expect(
      await cuadranCon(svc, 'a0000000-0000-4000-8000-000000000009', db),
    ).toHaveLength(1);
    db.movimiento_bancario.push(
      abono('a0000000-0000-4000-8000-000000000010', 1200),
    );
    expect(
      await cuadranCon(svc, 'a0000000-0000-4000-8000-000000000010', db),
    ).toEqual([]);
    // La pasarela no completa parciales: se sabe por la cuenta del abono
    // (leída) o porque quien llama ya lo sabe.
    expect(await cuadranCon(svc, M_PW, db)).toEqual([]);
    expect(await cuadranCon(svc, M2, db, { pasarela: true })).toEqual([]);

    const vieja = armar(mundo(), { bdVieja: true });
    expect(await cuadranCon(vieja.svc, M2, db)).toEqual([]);
  });

  it('método PAYWISE sin comisión con un SPEI de banco (la BD SÍ acepta el 2.º SPEI) ⇒ el freno lo ve: 409 ABONO_TIENE_COBRO_CANDIDATO (revisión del 15-oct-2026: antes el método lo daba por «de un solo abono» y los 1,700 contaban dos veces)', async () => {
    const db = mundo();
    Object.assign(db.cobro_vuelo[0], {
      metodo_cobro: 'PAYWISE',
      comision_banco_monto: 0,
    });
    const { svc } = armar(db);
    const r = await error(svc.crear(otroIngreso(M2, 1700), undefined, ADMIN));
    expect(r.code).toBe('ABONO_TIENE_COBRO_CANDIDATO');
    expect((r.details as { candidatos: Row[] }).candidatos).toEqual([
      expect.objectContaining({ id: C315, parcial: true, faltante: 1700 }),
    ]);
    // Con comisión capturada sí es «de un solo abono» (A lo rechaza): ni
    // un abono EXACTO a su faltante (3,300 − 1,700 = 1,600) lo frena.
    const conComision = mundo();
    Object.assign(conComision.cobro_vuelo[0], {
      metodo_cobro: 'PAYWISE',
      comision_banco_monto: 100,
    });
    const M1600 = 'a0000000-0000-4000-8000-000000001600';
    conComision.movimiento_bancario.push(abono(M1600, 1600));
    const otro = armar(conComision);
    expect(await cuadranCon(otro.svc, M1600, conComision)).toEqual([]);
  });

  it('un cobro CUBIERTO no detiene nada (su faltante es 0)', async () => {
    const db = mundo();
    db.movimiento_bancario_cobro.push({
      movimiento_id: 'a0000000-0000-4000-8000-0000000000aa',
      cobro_id: C315,
      monto_parte: 1700,
    });
    db.movimiento_bancario.push(
      abono('a0000000-0000-4000-8000-0000000000aa', 1700, {
        conciliado: true,
        cobro_id: C315,
        cobros_n: 1,
      }),
    );
    const { svc } = armar(db);
    expect(await cuadranCon(svc, M2, db)).toEqual([]);
  });
});

describe('«Es el pago de un vuelo» — anti doble conteo por faltante y la comisión ANTES de crear', () => {
  it('el 2.º SPEI para el vuelo #315 ⇒ 409 ABONO_TIENE_COBRO_CANDIDATO («en vez de registrar otro cobro»), nada creado', async () => {
    const { svc, flights, conciliacion } = armar(mundo());
    const r = await error(
      svc.cobroDeVueloDesdeAbono(
        M2,
        { vuelo_id: V315, client_request_id: LLAVE },
        ADMIN,
      ),
    );
    expect(r.code).toBe('ABONO_TIENE_COBRO_CANDIDATO');
    expect(r.message).toBe(
      'El cobro del vuelo #315 ($3,400.00 MXN) ya tiene un abono de $1,700.00 y le faltan $1,700.00: vincula este abono a ese cobro en vez de registrar otro cobro.',
    );
    expect((r.details as { candidatos: Row[] }).candidatos[0]).toMatchObject({
      id: C315,
      parcial: true,
      faltante: 1700,
    });
    expect(flights.createCobro).not.toHaveBeenCalled();
    expect(conciliacion.linkCobro).not.toHaveBeenCalled();
  });

  it('comisión tecleada que el banco NO descontó (abono = bruto) ⇒ 409 COMISION_NO_CUADRA sin crear el cobro', async () => {
    const { svc, flights, conciliacion } = armar(mundo());
    const r = await error(
      svc.cobroDeVueloDesdeAbono(
        M_5000,
        {
          vuelo_id: V315,
          client_request_id: LLAVE,
          monto: 5000,
          comision_banco_monto: 250,
        },
        ADMIN,
      ),
    );
    expect(r.code).toBe('COMISION_NO_CUADRA');
    expect(r.message).toBe(
      'Con la comisión de $250.00 el banco tendría que haber depositado $4,750.00 MXN, pero depositó $5,000.00 MXN: el banco no descontó comisión. Déjala en 0 y vuelve a registrar el pago (un cobro con comisión se concilia con un depósito igual a su neto).',
    );
    expect(r.details).toMatchObject({
      movimiento_id: M_5000,
      monto_cobro: 5000,
      comision_capturada: 250,
      neto: 4750,
      parte: 5000,
      comision_real: 0,
      por: 'COMISION',
    });
    expect(flights.createCobro).not.toHaveBeenCalled();
    expect(conciliacion.linkCobro).not.toHaveBeenCalled();
  });

  it('pasarela con bruto y sin la comisión real (default 0) ⇒ 409 con la comisión real, sin crear', async () => {
    const { svc, flights } = armar(mundo());
    const r = await error(
      svc.cobroDeVueloDesdeAbono(
        M_PW_BRUTO,
        { vuelo_id: V315, client_request_id: LLAVE },
        ADMIN,
      ),
    );
    expect(r.code).toBe('COMISION_NO_CUADRA');
    expect(r.message).toBe(
      'Sin comisión el depósito tendría que ser de $10,000.00 MXN, pero depositó $9,000.00 MXN: la comisión real es $1,000.00. Captura esa comisión y vuelve a registrar el pago (un cobro con comisión se concilia con un depósito igual a su neto).',
    );
    expect(r.details).toMatchObject({ comision_real: 1000, por: 'PASARELA' });
    expect(flights.createCobro).not.toHaveBeenCalled();
  });

  it('control: el mismo abono de $5,000 sin comisión SÍ crea el cobro (comisión 0 explícita) y lo liga', async () => {
    const { svc, flights, conciliacion } = armar(mundo());
    await svc.cobroDeVueloDesdeAbono(
      M_5000,
      { vuelo_id: V315, client_request_id: LLAVE },
      ADMIN,
    );
    expect(flights.createCobro).toHaveBeenCalledTimes(1);
    const dtoCobro = (flights.createCobro.mock.calls[0] as unknown[])[1];
    expect(dtoCobro).toMatchObject({
      monto: 5000,
      comision_banco_monto: 0,
      metodo_cobro: 'TRANSFERENCIA',
    });
    expect(conciliacion.linkCobro).toHaveBeenCalledWith(
      M_5000,
      { cobro_id: 'b0000000-0000-4000-8000-00000000c0de' },
      'u-admin',
    );
  });
});
