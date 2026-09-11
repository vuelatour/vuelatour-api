// Mismos stubs que flights.service.ola-b.spec.ts: notifications arrastra el
// gateway y `jose` (ESM), calendar-sync googleapis, vision el SDK de IA y
// pilots calendar/users (push, firebase).
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
import type { CreateCobroDto } from './dto/cobros.dto';
import { Moneda } from '../bank-accounts/dto/bank-accounts.dto';
import { MetodoPago } from '../quotes/dto/calculate-quote.dto';
import {
  metodoCobroQueLiquido,
  type CobroParaMetodoFinal,
} from './metodo-cobro-final.util';

/**
 * MÉTODO DE COBRO: PREVISTO vs REAL (11-sep-2026, corregido en la revisión
 * adversaria del mismo día).
 * `vuelo.metodo_cobro` es lo PREVISTO al cotizar y un INSUMO DEL PRECIO (el
 * cotizador rehidrata su selector de ahí y `calculate()` deriva el IVA por
 * default y la comisión BillPocket): registrar un cobro NUNCA lo toca.
 * `cobro_vuelo.metodo_cobro` es lo que de verdad se recibió, y «cómo se cobró
 * al final» se DERIVA (`metodoCobroQueLiquido`) para el panel/app.
 * Supabase se simula con un builder encadenable: se prueba el CONTRATO (qué
 * se escribe y qué NO), no la BD.
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
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => {
        const r = resolver(tabla, ops, lista);
        return {
          data: r.data === undefined ? (lista ? [] : null) : r.data,
          error: r.error ?? null,
          count: r.count ?? null,
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
  return { supabase: { service } as unknown as SupabaseService };
}

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';
const SNAPSHOT_ORIGINAL = {
  iva: { porcentaje: 16 },
  totales: { total_usd: 1000 },
};

function vueloRow(extra: Row = {}): Row {
  return {
    id: V1,
    folio: 254,
    cliente_id: 'aaaaaaaa-0000-4000-8000-00000000000d',
    aeronave_id: 'aaaaaaaa-0000-4000-8000-00000000000a',
    estado: 'CONFIRMADO',
    es_externo: false,
    cobrado: false,
    facturado: false,
    // PREVISTO al cotizar: transferencia (IVA 16 % en el desglose).
    metodo_cobro: 'TRANSFERENCIA',
    iva_pct: 16,
    monto_total_usd: 1000,
    tc_usd_mxn: 17,
    calculo_snapshot: SNAPSHOT_ORIGINAL,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    ...extra,
  };
}

interface Mundo {
  vuelo?: Row;
  /** Cobros YA registrados del vuelo (los que devuelve la relectura). */
  cobros?: Row[];
}

function armar(m: Mundo = {}) {
  const updates: Row[] = [];
  const inserts: Row[] = [];
  const { supabase } = fakeSupabase((tabla, ops, lista) => {
    const ins = ops.find((o) => o.m === 'insert');
    const upd = ops.find((o) => o.m === 'update');
    switch (tabla) {
      case 'vuelo': {
        const fila = m.vuelo ?? vueloRow();
        if (upd) {
          updates.push(upd.args[0] as Row);
          return { data: { ...fila, ...(upd.args[0] as Row) } };
        }
        return lista ? { data: [fila], count: 1 } : { data: fila };
      }
      case 'cobro_vuelo': {
        if (ins) {
          inserts.push(ins.args[0] as Row);
          return { data: { id: 'c-new', ...(ins.args[0] as Row) } };
        }
        // Ventana anti-gemelos (filtra por monto): sin gemelos.
        if (ops.some((o) => o.m === 'eq' && o.args[0] === 'monto')) {
          return { data: [] };
        }
        return { data: m.cobros ?? [] };
      }
      default:
        return {};
    }
  });
  const notifyRole = jest.fn().mockResolvedValue(true);
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
      notifyRole,
      notifyUserDetallado: jest.fn().mockResolvedValue({ notificado: true }),
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
  return { service, updates, inserts };
}

const dto = (extra: Partial<CreateCobroDto> = {}): CreateCobroDto => ({
  monto: 1000,
  moneda: Moneda.USD,
  metodo_cobro: MetodoPago.EFECTIVO,
  ...extra,
});

/** Patches que tocan la columna `metodo_cobro` de `vuelo`. */
const patchesMetodo = (updates: Row[]) =>
  updates.filter((u) => 'metodo_cobro' in u);

describe('createCobro — NUNCA sella el método en el vuelo (insumo del precio)', () => {
  it('un cobro que LIQUIDA con otro método no escribe metodo_cobro en el vuelo', async () => {
    const { service, updates } = armar();
    await service.createCobro(V1, dto(), USER);
    expect(patchesMetodo(updates)).toHaveLength(0);
  });

  it('ningún update del cobro toca precio, IVA, desglose ni versión', async () => {
    const { service, updates } = armar();
    await service.createCobro(V1, dto(), USER);
    for (const u of updates) {
      expect(u).not.toHaveProperty('metodo_cobro');
      expect(u).not.toHaveProperty('iva_pct');
      expect(u).not.toHaveProperty('iva_usd');
      expect(u).not.toHaveProperty('monto_total_usd');
      expect(u).not.toHaveProperty('calculo_snapshot');
      expect(u).not.toHaveProperty('cotizacion_version');
    }
  });

  it('tampoco lo toca un ANTICIPO, ni un vuelo en $0, ni un cobro MXN que liquida', async () => {
    for (const caso of [
      { mundo: {}, dto: dto({ monto: 400 }) },
      {
        mundo: { vuelo: vueloRow({ monto_total_usd: 0 }) },
        dto: dto({ monto: 500 }),
      },
      {
        mundo: {},
        dto: dto({
          monto: 17000,
          moneda: Moneda.MXN,
          metodo_cobro: MetodoPago.BILLPOCKET,
        }),
      },
    ]) {
      const { service, updates } = armar(caso.mundo);
      await service.createCobro(V1, caso.dto, USER);
      expect(patchesMetodo(updates)).toHaveLength(0);
    }
  });
});

describe('metodoCobroQueLiquido — «cómo se cobró al final» (derivado)', () => {
  const total = 1000;
  const c = (extra: Partial<CobroParaMetodoFinal> = {}) => ({
    monto: 1000,
    metodo_cobro: 'EFECTIVO',
    fecha_cobro: '2026-09-10T12:00:00-05:00',
    ...extra,
  });

  it('liquidado ⇒ el método del ÚLTIMO abono positivo', () => {
    const cobros = [
      c({
        monto: 400,
        metodo_cobro: 'BILLPOCKET',
        fecha_cobro: '2026-09-11T10:00:00-05:00',
      }),
      c({
        monto: 600,
        metodo_cobro: 'TRANSFERENCIA',
        fecha_cobro: '2026-09-01T10:00:00-05:00',
      }),
    ];
    expect(metodoCobroQueLiquido(cobros, 1000, total)).toBe('BILLPOCKET');
  });

  it('los REEMBOLSOS no cuentan como "el final"', () => {
    const cobros = [
      c({
        monto: -1000,
        metodo_cobro: 'TRANSFERENCIA',
        fecha_cobro: '2026-09-12T10:00:00-05:00',
      }),
      c({ monto: 1000, metodo_cobro: 'EFECTIVO' }),
    ];
    expect(metodoCobroQueLiquido(cobros, 1000, total)).toBe('EFECTIVO');
  });

  it('sin liquidar, sin precio o sin cobros ⇒ null', () => {
    expect(metodoCobroQueLiquido([c({ monto: 400 })], 400, total)).toBeNull();
    expect(metodoCobroQueLiquido([c()], 1000, 0)).toBeNull();
    expect(metodoCobroQueLiquido([], 1000, total)).toBeNull();
  });

  it('tolerancia de 1 USD (misma que refreshCobradoFlag)', () => {
    expect(metodoCobroQueLiquido([c({ monto: 999.5 })], 999.5, total)).toBe(
      'EFECTIVO',
    );
    expect(metodoCobroQueLiquido([c({ monto: 998 })], 998, total)).toBeNull();
  });
});
