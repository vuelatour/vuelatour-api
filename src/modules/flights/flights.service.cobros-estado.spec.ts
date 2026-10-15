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
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';

/**
 * UN COBRO, VARIOS ABONOS en la card del vuelo (14-oct-2026, API 0.0.78,
 * invariante 77): `adjuntarSobres` (el chokepoint de `listCobros`, del
 * snapshot y del PDF interno) dice `conciliado` = CUBIERTO con TODOS los
 * abonos del cobro y agrega `conciliacion_estado`, `ligado_banco`,
 * `neto_banco`, `monto_vinculado`/`faltante`/`sobrante` y `abonos_banco[]`
 * (por antigüedad) con las ligas que el lector único YA trae: cero
 * consultas nuevas. Caso real: las camionetas de Beh Kay (#315, $3,400 en
 * dos SPEI de $1,700). Los datos de hoy (1↔1 exacto, lote, Paywise, sobre,
 * anticipo) quedan con el MISMO `conciliado` del 0.0.77.
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const CTA = 'cta-eje';
const CTA_USD = 'cta-hsbc-usd';
const CTA_PW = 'cta-paywise';
const ANT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const S1 = 'aaaaaaaa-0000-4000-8000-0000000000e1';

interface Opciones {
  /** Columnas que no existen (42703 al nombrarlas en un select). */
  ausentes?: string[];
  /** Tabla que falla en su próxima lectura. */
  falla?: string;
}

function fakeSupabase(db: Tablas, opts: Opciones = {}) {
  const consultas: Array<{ tabla: string; sel: string; columna: string }> = [];
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
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      const q = { tabla, sel: '', columna: '' };
      let rango: [number, number] | null = null;
      const ejecutar = (unico: boolean) => {
        consultas.push(q);
        if (opts.falla === tabla) {
          return {
            data: null,
            error: { message: 'canceling statement due to statement timeout' },
          };
        }
        if (
          (opts.ausentes ?? []).some((c) =>
            new RegExp(`(^|[\\s,(])${c}([\\s,)]|$)`).test(q.sel),
          ) ||
          (tabla === 'movimiento_bancario_cobro' &&
            (opts.ausentes ?? []).includes('cobros_n'))
        ) {
          return {
            data: null,
            error: {
              code: '42703',
              message: `column ${tabla}.x does not exist`,
            },
          };
        }
        let rows = (db[tabla] ?? []).filter((r) => filtros.every((f) => f(r)));
        rows = rows.map((r) => {
          if (tabla === 'movimiento_bancario')
            return conCuenta(q.sel, r) as Row;
          if (
            tabla === 'movimiento_bancario_cobro' &&
            q.sel.includes('movimiento:')
          ) {
            return {
              ...r,
              movimiento: conCuenta(
                q.sel,
                (db.movimiento_bancario ?? []).find(
                  (m) => m.id === r.movimiento_id,
                ),
              ),
            };
          }
          if (tabla === 'cobro_grupo' && q.sel.includes('grupo:vuelo_grupo')) {
            return { ...r, grupo: { folio: 12 } };
          }
          return { ...r };
        });
        if (rango) rows = rows.slice(rango[0], rango[1] + 1);
        return { data: unico ? (rows[0] ?? null) : rows, error: null };
      };
      const api: Record<string, unknown> = {
        select(s?: string) {
          q.sel = s ?? '';
          return api;
        },
        eq(col: string, val: unknown) {
          filtros.push((r) => r[col] === val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          q.columna = col;
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        is(col: string, val: unknown) {
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        order: () => api,
        range(a: number, b: number) {
          rango = [a, b];
          return api;
        },
        limit: () => api,
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        single: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, consultas };
}

function armar(db: Tablas, opts: Opciones = {}) {
  const f = fakeSupabase(db, opts);
  const svc = new FlightsService(
    f.supabase,
    { syncFlight: jest.fn() } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {} as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
  return { svc, consultas: f.consultas };
}

const cobro = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  vuelo_id: V1,
  monto,
  moneda: 'MXN',
  metodo_cobro: 'TRANSFERENCIA',
  tc_usd_mxn: 17.15,
  comision_banco_pct: null,
  comision_banco_monto: null,
  cuenta_destino: 'Scotiabank Pesos',
  referencia: null,
  fecha_cobro: '2026-09-15T17:00:00Z',
  foto_voucher_url: null,
  registrado_por: null,
  notas: null,
  created_at: '2026-09-15T17:00:00Z',
  updated_at: '2026-09-15T17:00:00Z',
  cobro_grupo_id: null,
  grupo_factor: null,
  ingreso_anticipo_id: null,
  ...extra,
});

const abono = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-15',
  tipo: 'ABONO',
  monto,
  conciliado: true,
  cobro_id: null,
  cobro_grupo_id: null,
  ingreso_id: null,
  cobros_n: 0,
  created_at: '2026-10-06T15:22:46Z',
  ...extra,
});

const parte = (movId: string, cobroId: string, monto: number): Row => ({
  movimiento_id: movId,
  cobro_id: cobroId,
  monto_parte: monto,
});

function mundo(t: Partial<Tablas>): Tablas {
  return {
    vuelo: [{ id: V1, folio: 315, estado: 'COMPLETADO', tc_usd_mxn: 17.15 }],
    cuenta_bancaria: [
      { id: CTA, alias: 'EJE SCOTIA', moneda: 'MXN', tipo: 'BANCO' },
      { id: CTA_USD, alias: 'HSBC USD', moneda: 'USD', tipo: 'BANCO' },
      { id: CTA_PW, alias: 'Paywise', moneda: 'MXN', tipo: 'PASARELA' },
    ],
    usuario: [],
    cobro_grupo: [],
    ingreso: [],
    cobro_vuelo: [],
    movimiento_bancario: [],
    movimiento_bancario_cobro: [],
    ...t,
  };
}

/** Beh Kay: #315 $3,400 con UN SPEI de $1,700 (el ida) ligado. */
const MOV_IDA = 'mov-b-ida';
const MOV_VUELTA = 'mov-a-vuelta';
function camionetas(conSegundo = false): Tablas {
  const movs = [
    abono(MOV_IDA, 1700, {
      cobro_id: 'c315',
      cobros_n: 1,
      fecha: '2026-09-15',
    }),
  ];
  const partes = [parte(MOV_IDA, 'c315', 1700)];
  if (conSegundo) {
    // El 2.º SPEI es POSTERIOR aunque su id ordene primero.
    movs.push(
      abono(MOV_VUELTA, 1700, {
        cobro_id: 'c315',
        cobros_n: 1,
        fecha: '2026-09-16',
      }),
    );
    partes.push(parte(MOV_VUELTA, 'c315', 1700));
  }
  return mundo({
    cobro_vuelo: [cobro('c315', 3400)],
    movimiento_bancario: movs,
    movimiento_bancario_cobro: partes,
  });
}

const PILOTO = { userId: 'u-p', rol: Rol.PILOTO } as AuthenticatedUser;

describe('adjuntarSobres — «conciliado» = CUBIERTO (invariante 77)', () => {
  it('#315 con UN SPEI de $1,700: PARCIAL, no «conciliado», con lo que falta y su abono', async () => {
    const { svc } = armar(camionetas());
    const [c] = await svc.listCobros(V1);
    expect(c).toMatchObject({
      conciliado: false,
      conciliado_via: 'DIRECTO',
      conciliacion_estado: 'PARCIAL',
      ligado_banco: true,
      neto_banco: 3400,
      monto_vinculado: 1700,
      faltante: 1700,
      sobrante: 0,
      movimiento_bancario_id: MOV_IDA,
      abonos_banco: [
        {
          movimiento_id: MOV_IDA,
          fecha: '2026-09-15',
          monto_parte: 1700,
          monto_abono: 1700,
          cobros_n: 1,
          cuenta_bancaria_id: CTA,
          cuenta_alias: 'EJE SCOTIA',
          pasarela: false,
        },
      ],
    });
  });

  it('con el 2.º SPEI: CONCILIADO, dos abonos por antigüedad y movimiento_bancario_id = el MÁS ANTIGUO', async () => {
    const { svc } = armar(camionetas(true));
    const [c] = await svc.listCobros(V1);
    expect(c).toMatchObject({
      conciliado: true,
      conciliacion_estado: 'CONCILIADO',
      monto_vinculado: 3400,
      faltante: 0,
      movimiento_bancario_id: MOV_IDA,
    });
    expect(
      (c.abonos_banco as Array<{ movimiento_id: string }>).map(
        (a) => a.movimiento_id,
      ),
    ).toEqual([MOV_IDA, MOV_VUELTA]);
  });

  it('datos de hoy: 1↔1 exacto, lote, Paywise, sobre y anticipo ⇒ el MISMO `conciliado` del 0.0.77', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c-exacto', 1000),
        cobro('c-lote-a', 1000),
        cobro('c-lote-b', 2600, { comision_banco_monto: 100 }),
        cobro('c-paywise', 12495, {
          metodo_cobro: 'PAYWISE',
          comision_banco_monto: 624.76,
        }),
        cobro('c-sobre', 2060.16, { cobro_grupo_id: S1 }),
        cobro('c-anticipo', 600, { ingreso_anticipo_id: ANT }),
        cobro('c-libre', 500),
        cobro('c-efectivo', 200, { metodo_cobro: 'EFECTIVO' }),
        cobro('c-usd', 1000, { moneda: 'USD' }),
      ],
      movimiento_bancario: [
        abono('m-exacto', 1000, { cobro_id: 'c-exacto', cobros_n: 1 }),
        abono('m-lote', 3500, { cobros_n: 2 }),
        abono('m-pw', 11870.24, {
          cuenta_bancaria_id: CTA_PW,
          cobro_id: 'c-paywise',
          cobros_n: 1,
        }),
        abono('m-sobre', 10800.76, { cobro_grupo_id: S1 }),
        abono('m-ant', 50000, { ingreso_id: ANT }),
        abono('m-usd', 17000, {
          cuenta_bancaria_id: CTA,
          cobro_id: 'c-usd',
          cobros_n: 1,
        }),
      ],
      movimiento_bancario_cobro: [
        parte('m-exacto', 'c-exacto', 1000),
        parte('m-lote', 'c-lote-a', 1000),
        parte('m-lote', 'c-lote-b', 2500),
        parte('m-pw', 'c-paywise', 11870.24),
        parte('m-usd', 'c-usd', 17000),
      ],
      cobro_grupo: [{ id: S1, grupo_id: 'g1', monto: 10800.76, moneda: 'MXN' }],
      ingreso: [{ id: ANT, folio: 12 }],
    });
    const { svc } = armar(db);
    const lista = await svc.listCobros(V1);
    const de = (id: string) => lista.find((c) => c.id === id)!;
    const esperado: Array<[string, boolean, string, boolean]> = [
      ['c-exacto', true, 'CONCILIADO', true],
      ['c-lote-a', true, 'CONCILIADO', true],
      ['c-lote-b', true, 'CONCILIADO', true],
      ['c-paywise', true, 'CONCILIADO', true],
      ['c-sobre', true, 'CONCILIADO', true],
      ['c-anticipo', true, 'VIA_ANTICIPO', false],
      ['c-libre', false, 'SIN_CONCILIAR', false],
      ['c-efectivo', false, 'NO_BANCARIO', false],
      ['c-usd', true, 'CONCILIADO', true],
    ];
    for (const [id, conciliado, estado, ligado] of esperado) {
      expect([
        id,
        de(id).conciliado,
        de(id).conciliacion_estado,
        de(id).ligado_banco,
      ]).toEqual([id, conciliado, estado, ligado]);
    }
    // El lote: cada cobro con SU parte (neto) del abono de $3,500.
    expect(de('c-lote-b')).toMatchObject({
      neto_banco: 2500,
      monto_vinculado: 2500,
      faltante: 0,
      movimiento_bancario_id: 'm-lote',
      abonos_banco: [
        expect.objectContaining({
          movimiento_id: 'm-lote',
          monto_parte: 2500,
          monto_abono: 3500,
          cobros_n: 2,
        }),
      ],
    });
    // Paywise: la parte es de la PASARELA.
    expect(de('c-paywise').abonos_banco).toEqual([
      expect.objectContaining({ pasarela: true, cuenta_alias: 'Paywise' }),
    ]);
    // Cobro USD ligado a un abono en pesos: cruzado ⇒ cubierto, vinculado = neto.
    expect(de('c-usd')).toMatchObject({ monto_vinculado: 1000, faltante: 0 });
    // Sobre y anticipo: su liga, sin partes directas (ni cifras de cobertura).
    expect(de('c-sobre')).toMatchObject({
      conciliado_via: 'SOBRE',
      movimiento_bancario_id: 'm-sobre',
      monto_vinculado: null,
      faltante: null,
      abonos_banco: [],
    });
    expect(de('c-anticipo')).toMatchObject({
      conciliado_via: 'ANTICIPO',
      movimiento_bancario_id: 'm-ant',
      abonos_banco: [],
    });
    expect(de('c-libre')).toMatchObject({
      movimiento_bancario_id: null,
      neto_banco: 500,
      monto_vinculado: null,
      faltante: null,
      sobrante: null,
      abonos_banco: [],
    });
  });

  it('sin consultas nuevas: la puente se lee UNA vez (la del lector) y nada más', async () => {
    const { svc, consultas } = armar(camionetas(true));
    await svc.listCobros(V1);
    const tablas = consultas.map((c) => c.tabla);
    expect(
      tablas.filter((t) => t === 'movimiento_bancario_cobro'),
    ).toHaveLength(1);
    expect([...new Set(tablas)].sort()).toEqual(
      [
        'cobro_vuelo',
        'movimiento_bancario',
        'movimiento_bancario_cobro',
        'vuelo',
      ].sort(),
    );
  });

  it('PILOTO/MECANICO/VISITANTE: el estado viaja pero el detalle del banco (abonos_banco) se omite', async () => {
    const { svc } = armar(camionetas());
    const [c] = await svc.listCobros(V1, PILOTO);
    expect(c).toMatchObject({
      conciliado: false,
      conciliacion_estado: 'PARCIAL',
      faltante: 1700,
    });
    expect(c).not.toHaveProperty('abonos_banco');
    const [oficina] = await svc.listCobros(V1, {
      userId: 'u-a',
      rol: Rol.ADMIN,
    } as AuthenticatedUser);
    expect(oficina).toHaveProperty('abonos_banco');
  });

  it('sin la migración de ingresos: mismo estado, sin `conciliado_via` ni `anticipo`', async () => {
    const { svc } = armar(camionetas(), {
      ausentes: ['ingreso_id', 'ingreso_anticipo_id'],
    });
    const [c] = await svc.listCobros(V1);
    expect(c).toMatchObject({
      conciliado: false,
      conciliacion_estado: 'PARCIAL',
      movimiento_bancario_id: MOV_IDA,
    });
    expect(c).not.toHaveProperty('conciliado_via');
    expect(c).not.toHaveProperty('anticipo');
  });

  it('sin la puente (BD sin 20261012000002): el espejo es la parte (|abono|) y un abono menor también sale PARCIAL', async () => {
    const { svc, consultas } = armar(camionetas(), { ausentes: ['cobros_n'] });
    const [c] = await svc.listCobros(V1);
    expect(c).toMatchObject({
      conciliado: false,
      conciliacion_estado: 'PARCIAL',
      faltante: 1700,
      abonos_banco: [
        expect.objectContaining({
          movimiento_id: MOV_IDA,
          monto_parte: 1700,
          cobros_n: 1,
        }),
      ],
    });
    expect(consultas.some((q) => q.tabla === 'movimiento_bancario_cobro')).toBe(
      false,
    );
  });

  it('si el lector falla, se LANZA como siempre (jamás «sin conciliar» de oídas)', async () => {
    const { svc } = armar(camionetas(), { falla: 'movimiento_bancario_cobro' });
    await expect(svc.listCobros(V1)).rejects.toThrow(/timeout/);
  });
});
