// Mismos stubs que el resto de los specs de flights: notifications arrastra
// el gateway y `jose` (ESM), calendar-sync googleapis, vision el SDK de IA y
// pilots el stack de push.
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

import { ConflictException } from '@nestjs/common';
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
import type { CreateCobroDto, UpdateCobroDto } from './dto/cobros.dto';
import { Moneda } from '../bank-accounts/dto/bank-accounts.dto';
import { MetodoPago } from '../quotes/dto/calculate-quote.dto';

/**
 * COBROS NACIDOS DE UN ANTICIPO (24-sep-2026, contrato de ingresos §7 y
 * §12.8). Se congela:
 * - `createCobro` SIN el 6.º parámetro inserta EXACTAMENTE lo de siempre; con
 *   él agrega solo `ingreso_anticipo_id`.
 * - `updateCobro` rechaza (409 COBRO_DE_ANTICIPO) cambiar el DINERO de un
 *   cobro de anticipo comparando contra el VIGENTE; referencia, fecha y T.C.
 *   sí se corrigen.
 * - `deleteCobro` («desaplicar») PASA aunque el anticipo esté conciliado
 *   (el candado usa `movimientoDeCobro`, que no ve la vía del anticipo) y
 *   deja la fila DESAPLICAR en la bitácora del anticipo.
 * - `adjuntarSobres` (chokepoint de lectura) marca conciliado un cobro cuyo
 *   ANTICIPO está conciliado (`conciliado_via: 'ANTICIPO'`); sin la
 *   migración, payload y consultas idénticos a hoy.
 */
type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };
type Resultado = {
  data?: unknown;
  error?: { code?: string; message: string } | null;
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
  'gt',
  'lt',
  'order',
  'limit',
  'range',
  'insert',
  'update',
  'delete',
];

function fakeSupabase(
  resolver: (tabla: string, ops: Op[], lista: boolean) => Resultado,
) {
  const consultas: Array<{ tabla: string; ops: Op[] }> = [];
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      consultas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => {
        const r = resolver(tabla, ops, lista);
        return {
          data: r.data === undefined ? (lista ? [] : null) : r.data,
          error: r.error ?? null,
          count: null,
        };
      };
      for (const m of METODOS) {
        q[m] = (...args: unknown[]) => {
          ops.push({ m, args });
          return q;
        };
      }
      q.maybeSingle = () => Promise.resolve(resolve(false));
      q.single = () => Promise.resolve(resolve(false));
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(true)).then(res, rej);
      return q;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, consultas };
}

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';
const ANT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const C_ANT = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const C_NORMAL = 'aaaaaaaa-0000-4000-8000-0000000000c2';

const sel = (ops: Op[]) =>
  (ops.find((o) => o.m === 'select')?.args[0] as string | undefined) ?? '';
const argsDe = (ops: Op[], m: string, col: string) =>
  ops.find((o) => o.m === m && o.args[0] === col)?.args[1];

interface Mundo {
  sinMigracion?: boolean;
  cobros?: Row[];
  movimientos?: Row[];
}

function cobroAnticipo(extra: Row = {}): Row {
  return {
    id: C_ANT,
    vuelo_id: V1,
    monto: 600,
    moneda: 'MXN',
    metodo_cobro: 'TRANSFERENCIA',
    tc_usd_mxn: 18.5,
    comision_banco_pct: null,
    comision_banco_monto: null,
    cuenta_destino: null,
    referencia: 'SPEI 123',
    fecha_cobro: '2026-09-10T17:00:00Z',
    foto_voucher_url: null,
    registrado_por: USER,
    notas: 'Aplicado del anticipo ING-12',
    created_at: '2026-09-10T17:00:00Z',
    updated_at: '2026-09-10T17:00:00Z',
    cobro_grupo_id: null,
    grupo_factor: null,
    ingreso_anticipo_id: ANT,
    ...extra,
  };
}

function cobroNormal(extra: Row = {}): Row {
  return {
    ...cobroAnticipo(),
    id: C_NORMAL,
    monto: 400,
    ingreso_anticipo_id: null,
    ...extra,
  };
}

function armar(m: Mundo = {}) {
  const inserts: Array<{ tabla: string; fila: Row }> = [];
  const updates: Array<{ tabla: string; patch: Row }> = [];
  const deletes: string[] = [];
  const cobros = m.cobros ?? [cobroAnticipo(), cobroNormal()];
  const movs = m.movimientos ?? [];
  const sinColumna = (ops: Op[]) =>
    m.sinMigracion &&
    /\bingreso_(anticipo_)?id\b/.test(sel(ops)) && {
      error: {
        code: '42703',
        message: 'column movimiento_bancario.ingreso_id does not exist',
      },
    };
  const { supabase, consultas } = fakeSupabase((tabla, ops, lista) => {
    const ins = ops.find((o) => o.m === 'insert');
    const upd = ops.find((o) => o.m === 'update');
    const del = ops.find((o) => o.m === 'delete');
    const err = sinColumna(ops);
    if (err) return err;
    switch (tabla) {
      case 'vuelo':
        if (upd) {
          updates.push({ tabla, patch: upd.args[0] as Row });
          return { data: null };
        }
        return {
          data: lista
            ? [{ id: V1, folio: 254, tc_usd_mxn: 18, cobrado: false }]
            : {
                id: V1,
                folio: 254,
                cliente_id: 'cli-1',
                estado: 'CONFIRMADO',
                monto_total_usd: 1000,
                tc_usd_mxn: 18,
                cobrado: false,
                metodo_cobro: 'TRANSFERENCIA',
              },
        };
      case 'cobro_vuelo': {
        if (ins) {
          inserts.push({ tabla, fila: ins.args[0] as Row });
          return { data: { id: 'c-new', ...(ins.args[0] as Row) } };
        }
        if (upd) {
          updates.push({ tabla, patch: upd.args[0] as Row });
          const id = argsDe(ops, 'eq', 'id');
          const fila = cobros.find((c) => c.id === id) ?? {};
          return { data: { ...fila, ...(upd.args[0] as Row) } };
        }
        if (del) {
          deletes.push(String(argsDe(ops, 'eq', 'id')));
          return { data: null };
        }
        // Ventana anti-gemelos: sin gemelos.
        if (argsDe(ops, 'eq', 'monto') !== undefined) return { data: [] };
        const id = argsDe(ops, 'eq', 'id');
        if (id !== undefined) {
          return { data: cobros.find((c) => c.id === id) ?? null };
        }
        const ids = argsDe(ops, 'in', 'id') as string[] | undefined;
        if (ids)
          return { data: cobros.filter((c) => ids.includes(c.id as string)) };
        return { data: cobros };
      }
      case 'movimiento_bancario': {
        const enIngreso = argsDe(ops, 'in', 'ingreso_id') as
          | string[]
          | undefined;
        if (enIngreso) {
          return {
            data: movs.filter((x) =>
              enIngreso.includes(x.ingreso_id as string),
            ),
          };
        }
        return { data: lista ? movs : (movs[0] ?? null) };
      }
      case 'ingreso':
        if (lista) return { data: [{ id: ANT, folio: 12 }] };
        return { data: { folio: 12 } };
      case 'ingreso_bitacora':
        if (ins) inserts.push({ tabla, fila: ins.args[0] as Row });
        return { data: null };
      default:
        return {};
    }
  });
  const service = new FlightsService(
    supabase,
    {
      syncFlight: jest.fn(),
      removeFlight: jest.fn(),
    } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {
      notifyUser: jest.fn().mockResolvedValue(true),
      notifyRole: jest.fn().mockResolvedValue(true),
    } as unknown as NotificationsService,
    {
      findBlockingExpirations: jest.fn().mockResolvedValue([]),
    } as unknown as ExpirationsService,
    { refreshPermisosDeVuelo: jest.fn() } as unknown as AirportsService,
    {
      numero: jest.fn().mockResolvedValue(8.857),
    } as unknown as ConfiguracionService,
    {} as PilotsService,
  );
  return { service, inserts, updates, deletes, consultas };
}

/** Llaves del insert de un cobro ANTES del cambio (byte-idéntico). */
const LLAVES_INSERT_COBRO = [
  'vuelo_id',
  'monto',
  'moneda',
  'metodo_cobro',
  'tc_usd_mxn',
  'comision_banco_pct',
  'comision_banco_monto',
  'cuenta_destino',
  'referencia',
  'fecha_cobro',
  'foto_voucher_url',
  'registrado_por',
  'notas',
  'client_request_id',
  'cobro_grupo_id',
  'grupo_factor',
  'created_by',
  'updated_by',
];

const dto = (extra: Partial<CreateCobroDto> = {}): CreateCobroDto => ({
  monto: 600,
  moneda: Moneda.MXN,
  metodo_cobro: MetodoPago.TRANSFERENCIA,
  ...extra,
});

describe('createCobro — 6.º parámetro INTERNO del anticipo', () => {
  it('SIN el 6.º parámetro el insert es el de siempre (mismas llaves, mismo orden)', async () => {
    const w = armar();
    await w.service.createCobro(V1, dto(), USER);
    const fila = w.inserts.find((i) => i.tabla === 'cobro_vuelo')!.fila;
    expect(Object.keys(fila)).toEqual(LLAVES_INSERT_COBRO);
    expect(fila).not.toHaveProperty('ingreso_anticipo_id');
  });

  it('CON el anticipo agrega SOLO ingreso_anticipo_id (al final)', async () => {
    const w = armar();
    await w.service.createCobro(V1, dto(), USER, undefined, undefined, {
      ingreso_anticipo_id: ANT,
    });
    const fila = w.inserts.find((i) => i.tabla === 'cobro_vuelo')!.fila;
    expect(Object.keys(fila)).toEqual([
      ...LLAVES_INSERT_COBRO,
      'ingreso_anticipo_id',
    ]);
    expect(fila.ingreso_anticipo_id).toBe(ANT);
  });
});

describe('updateCobro — el dinero de un cobro de anticipo no se toca', () => {
  it.each<[string, UpdateCobroDto]>([
    ['monto', { monto: 700 }],
    ['moneda', { moneda: Moneda.USD }],
    ['método', { metodo_cobro: MetodoPago.EFECTIVO }],
    ['comisión (monto)', { comision_banco_monto: 10 }],
    ['comisión (%)', { comision_banco_pct: 2 }],
  ])('%s distinto del VIGENTE ⇒ 409 COBRO_DE_ANTICIPO', async (_c, patch) => {
    const w = armar();
    const err = await w.service
      .updateCobro(C_ANT, patch, USER)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const r = (err as ConflictException).getResponse() as Row;
    expect(r.error).toBe('COBRO_DE_ANTICIPO');
    expect(r.details).toEqual({ ingreso_id: ANT, etiqueta: 'ING-12' });
    expect(String(r.message)).toMatch(/desaplícalo/);
    expect(w.updates.filter((u) => u.tabla === 'cobro_vuelo')).toHaveLength(0);
  });

  it('el formulario completo con el MISMO dinero + referencia/fecha/T.C. nuevos SÍ pasa', async () => {
    const w = armar();
    await w.service.updateCobro(
      C_ANT,
      {
        monto: 600,
        moneda: Moneda.MXN,
        metodo_cobro: MetodoPago.TRANSFERENCIA,
        comision_banco_monto: 0,
        referencia: 'SPEI corregido',
        tc_usd_mxn: 18.9,
        fecha_cobro: new Date('2026-09-11T17:00:00Z'),
      },
      USER,
    );
    const patch = w.updates.find((u) => u.tabla === 'cobro_vuelo')!.patch;
    expect(patch.referencia).toBe('SPEI corregido');
    expect(patch.tc_usd_mxn).toBe(18.9);
  });

  it('el MISMO dinero reenviado NO recalcula la comisión (Σ aplicaciones == comisión del anticipo)', async () => {
    // Revisión adversaria 24-sep-2026: 98,765.43 con comisión 8,747.21
    // guarda el % en 8.8566 (4 dec) y recalcular desde él daba 8,747.26 —
    // editar solo la referencia movía 5 centavos del anticipo.
    const w = armar({
      cobros: [
        cobroAnticipo({
          monto: 98765.43,
          comision_banco_monto: 8747.21,
          comision_banco_pct: 8.8566,
        }),
        cobroNormal(),
      ],
    });
    await w.service.updateCobro(
      C_ANT,
      {
        monto: 98765.43,
        moneda: Moneda.MXN,
        metodo_cobro: MetodoPago.TRANSFERENCIA,
        comision_banco_pct: 8.8566,
        referencia: 'SPEI corregido',
      },
      USER,
    );
    const patch = w.updates.find((u) => u.tabla === 'cobro_vuelo')!.patch;
    expect(patch.referencia).toBe('SPEI corregido');
    for (const k of [
      'monto',
      'moneda',
      'metodo_cobro',
      'comision_banco_monto',
      'comision_banco_pct',
    ]) {
      expect(patch).not.toHaveProperty(k);
    }
  });

  it('un cobro NORMAL sigue corrigiéndose como siempre', async () => {
    const w = armar();
    await w.service.updateCobro(C_NORMAL, { monto: 450 }, USER);
    const patch = w.updates.find((u) => u.tabla === 'cobro_vuelo')!.patch;
    expect(patch.monto).toBe(450);
  });

  it('SIN la migración: ni lee la liga ni rebota (comportamiento de hoy)', async () => {
    const w = armar({ sinMigracion: true, cobros: [cobroNormal()] });
    await w.service.updateCobro(C_NORMAL, { monto: 450 }, USER);
    const lectura = w.consultas.find(
      (c) =>
        c.tabla === 'cobro_vuelo' &&
        c.ops.some((o) => o.m === 'eq' && o.args[0] === 'id') &&
        !c.ops.some((o) => o.m === 'update'),
    )!;
    expect(sel(lectura.ops)).toBe(
      'id, vuelo_id, monto, comision_banco_pct, cobro_grupo_id',
    );
  });
});

describe('deleteCobro — desaplicar desde el vuelo', () => {
  it('anticipo CONCILIADO: el borrado PASA (el candado no ve la vía del anticipo) y deja DESAPLICAR', async () => {
    const w = armar({
      movimientos: [
        {
          id: 'm-ant',
          cobro_id: null,
          cobro_grupo_id: null,
          ingreso_id: ANT,
        },
      ],
    });
    await expect(w.service.deleteCobro(C_ANT, USER)).resolves.toEqual({
      ok: true,
    });
    expect(w.deletes).toEqual([C_ANT]);
    const bit = w.inserts.find((i) => i.tabla === 'ingreso_bitacora')!.fila;
    expect(bit).toMatchObject({
      ingreso_id: ANT,
      accion: 'DESAPLICAR',
      actor_id: USER,
      nota: 'vuelo #254 · $600 MXN',
    });
  });

  it('un cobro NORMAL conciliado directo sigue bloqueado (candado de siempre)', async () => {
    const w = armar({
      movimientos: [
        {
          id: 'm-dir',
          cobro_id: C_NORMAL,
          cobro_grupo_id: null,
          ingreso_id: null,
        },
      ],
    });
    await expect(w.service.deleteCobro(C_NORMAL, USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(w.deletes).toEqual([]);
  });

  it('cobro normal: sin fila de bitácora de ingresos', async () => {
    const w = armar();
    await w.service.deleteCobro(C_NORMAL, USER);
    expect(w.inserts.some((i) => i.tabla === 'ingreso_bitacora')).toBe(false);
  });
});

describe('adjuntarSobres (listCobros) — conciliado vía anticipo', () => {
  it('anticipo CONCILIADO ⇒ conciliado:true, via ANTICIPO y el abono del anticipo', async () => {
    const w = armar({
      movimientos: [
        {
          id: 'm-ant',
          cobro_id: null,
          cobro_grupo_id: null,
          ingreso_id: ANT,
        },
        {
          id: 'm-dir',
          cobro_id: C_NORMAL,
          cobro_grupo_id: null,
          ingreso_id: null,
        },
      ],
    });
    const lista = await w.service.listCobros(V1);
    const ant = lista.find((c) => c.id === C_ANT)!;
    expect(ant).toMatchObject({
      conciliado: true,
      movimiento_bancario_id: 'm-ant',
      conciliado_via: 'ANTICIPO',
      anticipo: { ingreso_id: ANT, etiqueta: 'ING-12' },
    });
    const normal = lista.find((c) => c.id === C_NORMAL)!;
    expect(normal).toMatchObject({
      conciliado: true,
      movimiento_bancario_id: 'm-dir',
      conciliado_via: 'DIRECTO',
      anticipo: null,
    });
  });

  it('anticipo SIN conciliar ⇒ el cobro sale sin conciliar', async () => {
    const w = armar();
    const lista = await w.service.listCobros(V1);
    expect(lista.find((c) => c.id === C_ANT)).toMatchObject({
      conciliado: false,
      movimiento_bancario_id: null,
      conciliado_via: null,
      anticipo: { ingreso_id: ANT, etiqueta: 'ING-12' },
    });
  });

  it('SIN la migración: sin campos nuevos y sin consultas extra', async () => {
    const w = armar({ sinMigracion: true, cobros: [cobroNormal()] });
    const lista = await w.service.listCobros(V1);
    expect(lista[0]).not.toHaveProperty('anticipo');
    expect(lista[0]).not.toHaveProperty('conciliado_via');
    // Ni la tabla `ingreso`, ni la lectura de la liga al anticipo, ni la
    // columna `ingreso_id` fuera de la sonda.
    expect(w.consultas.some((c) => c.tabla === 'ingreso')).toBe(false);
    const conColumnaNueva = w.consultas.filter(
      (c) =>
        /ingreso/.test(sel(c.ops)) &&
        // la sonda (select 'ingreso_id' + limit 1) es la única permitida
        !(sel(c.ops) === 'ingreso_id' && c.ops.some((o) => o.m === 'limit')),
    );
    expect(conColumnaNueva).toEqual([]);
  });
});
