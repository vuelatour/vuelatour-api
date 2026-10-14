// Mismos stubs que flights.service.metodo-cobro.spec.ts: notifications
// arrastra el gateway y `jose` (ESM), calendar-sync googleapis, vision el SDK
// de IA y pilots calendar/users (push, firebase).
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

import { Logger } from '@nestjs/common';
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
import type {
  FacturaSolicitudService,
  SolicitudPorCobro,
} from './factura-solicitud.service';
import type { CreateCobroDto, CreateReembolsoDto } from './dto/cobros.dto';
import { Moneda } from '../bank-accounts/dto/bank-accounts.dto';
import { MetodoPago } from '../quotes/dto/calculate-quote.dto';
import { Rol } from '../../common/types/auth.types';

/**
 * FACTURA OBLIGATORIA POR CUENTA DE COBRO (13-oct-2026, invariante 60) —
 * los GANCHOS de `FlightsService`: `createCobro` sin sobre dispara la
 * solicitud automática FIRE-AND-FORGET (el POST del outbox del piloto no
 * espera), `updateCobro` la dispara con `await` cuando el PATCH trae
 * cuenta/método, y nada más la dispara (partes de sobre, replay
 * idempotente, reembolsos, patch de referencia/notas). La respuesta HTTP del
 * cobro es byte-idéntica a la de hoy y un fallo del gancho jamás la toca.
 * Supabase se simula con un builder encadenable: se prueba el CONTRATO.
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
const COBRO_EXISTENTE: Row = {
  id: 'c-1',
  vuelo_id: V1,
  monto: 1000,
  moneda: 'USD',
  metodo_cobro: 'TRANSFERENCIA',
  comision_banco_pct: null,
  comision_banco_monto: null,
  cobro_grupo_id: null,
  ingreso_anticipo_id: null,
  cuenta_destino: null,
  client_request_id: 'cccccccc-0000-4000-8000-000000000001',
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
    metodo_cobro: 'TRANSFERENCIA',
    iva_pct: 16,
    monto_total_usd: 1000,
    tc_usd_mxn: 17,
    calculo_snapshot: { iva: { porcentaje: 16 }, totales: { total_usd: 1000 } },
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    ...extra,
  };
}

interface Mundo {
  vuelo?: Row;
  /** Cobros YA registrados del vuelo (los que devuelve la relectura). */
  cobros?: Row[];
  /** Cobro que responde el pre-check por `client_request_id` (replay). */
  replay?: Row;
  /** Sin el 12.º argumento (specs posicionales con 9). */
  sinFacturaSolicitud?: boolean;
  /** `solicitarPorCobro` rechaza. */
  falla?: boolean;
}

function armar(m: Mundo = {}) {
  const inserts: Row[] = [];
  const { supabase } = fakeSupabase((tabla, ops, lista) => {
    const ins = ops.find((o) => o.m === 'insert');
    const upd = ops.find((o) => o.m === 'update');
    const eq = (col: string) =>
      ops.find((o) => o.m === 'eq' && o.args[0] === col);
    switch (tabla) {
      case 'vuelo': {
        const fila = m.vuelo ?? vueloRow();
        if (upd) return { data: { ...fila, ...(upd.args[0] as Row) } };
        return lista ? { data: [fila], count: 1 } : { data: fila };
      }
      case 'cobro_vuelo': {
        if (ins) {
          inserts.push(ins.args[0] as Row);
          return { data: { id: 'c-new', ...(ins.args[0] as Row) } };
        }
        if (upd) {
          return { data: { ...COBRO_EXISTENTE, ...(upd.args[0] as Row) } };
        }
        if (eq('client_request_id')) return { data: m.replay ?? null };
        // Ventana anti-gemelos (filtra por monto): sin gemelos.
        if (eq('monto')) return { data: [] };
        if (eq('id') && !lista) return { data: COBRO_EXISTENTE };
        return { data: m.cobros ?? [] };
      }
      default:
        return {};
    }
  });
  const solicitarPorCobro = jest
    .fn()
    .mockImplementation(() =>
      m.falla
        ? Promise.reject(new Error('BD caída'))
        : Promise.resolve({ solicitados: [254], notificados: ['Mary Cruz'] }),
    );
  const facturaSolicitud = {
    solicitarPorCobro,
  } as unknown as FacturaSolicitudService;
  const args = [
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
  ] as const;
  const service = m.sinFacturaSolicitud
    ? new FlightsService(...args)
    : new FlightsService(...args, undefined, undefined, facturaSolicitud);
  return { service, inserts, solicitarPorCobro };
}

const dto = (extra: Partial<CreateCobroDto> = {}): CreateCobroDto => ({
  monto: 1000,
  moneda: Moneda.USD,
  metodo_cobro: MetodoPago.TRANSFERENCIA,
  ...extra,
});

/** Vacía la cola de microtareas/macrotareas: el gancho es fire-and-forget. */
const vaciarCola = () => new Promise((r) => setImmediate(r));

/** Primer argumento de la primera llamada al mock (tipado). */
const primerArg = (fn: jest.Mock): SolicitudPorCobro =>
  (fn.mock.calls as unknown as Array<[SolicitudPorCobro]>)[0][0];

describe('createCobro — solicitud automática de factura (fire-and-forget)', () => {
  it('cobro en HSBC Pesos ⇒ UNA llamada con el cobro recién escrito, tras vaciar la cola; la respuesta es la de siempre', async () => {
    const { service, solicitarPorCobro } = armar();
    const res = (await service.createCobro(
      V1,
      dto({ cuenta_destino: 'HSBC Pesos' }),
      USER,
    )) as Row;
    // La respuesta es la fila insertada, sin llaves nuevas.
    expect(res).toMatchObject({
      id: 'c-new',
      vuelo_id: V1,
      monto: 1000,
      cuenta_destino: 'HSBC Pesos',
      metodo_cobro: 'TRANSFERENCIA',
    });
    expect(res).not.toHaveProperty('solicitud');
    expect(res).not.toHaveProperty('factura');
    await vaciarCola();
    expect(solicitarPorCobro).toHaveBeenCalledTimes(1);
    expect(solicitarPorCobro).toHaveBeenCalledWith({
      vueloIds: [V1],
      cobro: {
        monto: 1000,
        cuenta_destino: 'HSBC Pesos',
        metodo_cobro: 'TRANSFERENCIA',
      },
      actorId: USER,
      cobroId: 'c-new',
    });
  });

  it('TRANSFERENCIA sin cuenta ⇒ llama (respaldo por método)', async () => {
    const { service, solicitarPorCobro } = armar();
    await service.createCobro(V1, dto(), USER);
    await vaciarCola();
    expect(solicitarPorCobro).toHaveBeenCalledTimes(1);
    expect(primerArg(solicitarPorCobro)).toMatchObject({
      cobro: { cuenta_destino: null, metodo_cobro: 'TRANSFERENCIA' },
    });
  });

  it('el PILOTO con link de pago HSBC (con voucher) también la dispara: la regla es por método, no por rol', async () => {
    const { service, solicitarPorCobro } = armar({
      vuelo: vueloRow({ metodo_cobro: 'HSBC_LINK' }),
    });
    await service.createCobro(
      V1,
      dto({
        metodo_cobro: MetodoPago.HSBC_LINK,
        foto_voucher_url: 'cobro-vouchers/x.jpg',
      }),
      USER,
      Rol.PILOTO,
    );
    await vaciarCola();
    expect(solicitarPorCobro).toHaveBeenCalledTimes(1);
    expect(primerArg(solicitarPorCobro)).toMatchObject({
      cobro: { metodo_cobro: 'HSBC_LINK' },
    });
  });

  it('BillPocket, Paywise y efectivo NO la disparan', async () => {
    for (const extra of [
      { metodo_cobro: MetodoPago.BILLPOCKET },
      { metodo_cobro: MetodoPago.PAYWISE, cuenta_destino: 'Paywise' },
      { metodo_cobro: MetodoPago.EFECTIVO },
    ]) {
      const { service, solicitarPorCobro } = armar();
      await service.createCobro(V1, dto(extra), USER);
      await vaciarCola();
      expect([extra, solicitarPorCobro.mock.calls.length]).toEqual([extra, 0]);
    }
  });

  it('la opción INTERNA `omitirSolicitudFactura` («Es el pago de un vuelo» desde el banco) no la dispara: la dispara el llamador tras ligar el abono', async () => {
    const { service, solicitarPorCobro, inserts } = armar();
    const res = (await service.createCobro(
      V1,
      dto({ cuenta_destino: 'HSBC Pesos' }),
      USER,
      Rol.ADMIN,
      undefined,
      undefined,
      { omitirSolicitudFactura: true },
    )) as Row;
    await vaciarCola();
    expect(inserts).toHaveLength(1);
    expect(res).toMatchObject({ id: 'c-new', cuenta_destino: 'HSBC Pesos' });
    expect(solicitarPorCobro).not.toHaveBeenCalled();
  });

  it('una PARTE de sobre de grupo no la dispara (lo hace el grupo UNA vez por sobre)', async () => {
    const { service, solicitarPorCobro } = armar();
    await service.createCobro(
      V1,
      dto({ cuenta_destino: 'HSBC Pesos' }),
      USER,
      undefined,
      { cobro_grupo_id: 'sobre-1', grupo_factor: 1, silenciarPush: true },
    );
    await vaciarCola();
    expect(solicitarPorCobro).not.toHaveBeenCalled();
  });

  it('el replay idempotente (client_request_id) no la re-dispara', async () => {
    const { service, solicitarPorCobro, inserts } = armar({
      replay: { ...COBRO_EXISTENTE, cuenta_destino: 'HSBC Pesos' },
    });
    const res = (await service.createCobro(
      V1,
      dto({
        cuenta_destino: 'HSBC Pesos',
        client_request_id: COBRO_EXISTENTE.client_request_id as string,
      }),
      USER,
    )) as Row;
    expect(res.idempotente).toBe(true);
    expect(inserts).toHaveLength(0);
    await vaciarCola();
    expect(solicitarPorCobro).not.toHaveBeenCalled();
  });

  it('si la solicitud falla, el cobro responde igual y solo queda un warn (nunca error ni 5xx)', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const { service, solicitarPorCobro } = armar({ falla: true });
      const res = (await service.createCobro(
        V1,
        dto({ cuenta_destino: 'HSBC Pesos' }),
        USER,
      )) as Row;
      expect(res.id).toBe('c-new');
      await vaciarCola();
      expect(solicitarPorCobro).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Solicitud automática de factura falló'),
      );
      expect(error).not.toHaveBeenCalledWith(
        expect.stringContaining('Solicitud automática'),
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('createReembolso NUNCA la dispara (un reembolso no exige factura)', async () => {
    const { service, solicitarPorCobro } = armar({
      cobros: [{ ...COBRO_EXISTENTE, cuenta_destino: 'HSBC Pesos' }],
    });
    const reembolso: CreateReembolsoDto = {
      monto: 100,
      moneda: Moneda.USD,
      metodo_cobro: MetodoPago.TRANSFERENCIA,
      cuenta_destino: 'HSBC Pesos',
      motivo: 'Devolución parcial por cambio de ruta',
    };
    await service.createReembolso(V1, reembolso, USER);
    await vaciarCola();
    expect(solicitarPorCobro).not.toHaveBeenCalled();
  });
});

describe('updateCobro — solicitud automática al corregir cuenta/método (await best-effort)', () => {
  it('PATCH con cuenta_destino Scotiabank Dólares ⇒ llama con el cobro corregido, SIN vaciar la cola', async () => {
    const { service, solicitarPorCobro } = armar();
    const res = (await service.updateCobro(
      'c-1',
      { cuenta_destino: 'Scotiabank Dólares' },
      USER,
    )) as Row;
    expect(res.cuenta_destino).toBe('Scotiabank Dólares');
    expect(solicitarPorCobro).toHaveBeenCalledTimes(1);
    expect(solicitarPorCobro).toHaveBeenCalledWith({
      vueloIds: [V1],
      cobro: {
        monto: 1000,
        cuenta_destino: 'Scotiabank Dólares',
        metodo_cobro: 'TRANSFERENCIA',
      },
      actorId: USER,
      cobroId: 'c-1',
    });
  });

  it('PATCH solo de referencia/notas ⇒ no llama', async () => {
    const { service, solicitarPorCobro } = armar();
    await service.updateCobro(
      'c-1',
      { referencia: 'SPEI 123', notas: 'ok' },
      USER,
    );
    expect(solicitarPorCobro).not.toHaveBeenCalled();
  });

  it('corregir HACIA BillPocket no retira nada ni llama (retiro manual con confirmación)', async () => {
    const { service, solicitarPorCobro } = armar();
    await service.updateCobro(
      'c-1',
      { metodo_cobro: MetodoPago.BILLPOCKET },
      USER,
    );
    expect(solicitarPorCobro).not.toHaveBeenCalled();
  });
});

describe('solicitarFacturaPorCobros — puerta pública', () => {
  it('sin FacturaSolicitudService inyectado (9 argumentos) ⇒ null, sin reventar', async () => {
    const { service } = armar({ sinFacturaSolicitud: true });
    await expect(
      service.solicitarFacturaPorCobros({
        vueloIds: [V1],
        cobro: { monto: 1000, cuenta_destino: 'HSBC Pesos' },
        actorId: USER,
      }),
    ).resolves.toBeNull();
    // Y el cobro se registra como siempre.
    const res = (await service.createCobro(
      V1,
      dto({ cuenta_destino: 'HSBC Pesos' }),
      USER,
    )) as Row;
    await vaciarCola();
    expect(res.id).toBe('c-new');
  });

  it('cobro que no exige ⇒ null sin llamar al service', async () => {
    const { service, solicitarPorCobro } = armar();
    await expect(
      service.solicitarFacturaPorCobros({
        vueloIds: [V1],
        cobro: { monto: 1000, metodo_cobro: 'BILLPOCKET' },
        actorId: USER,
      }),
    ).resolves.toBeNull();
    expect(solicitarPorCobro).not.toHaveBeenCalled();
  });

  it('devuelve lo que responde el service y atrapa su rechazo con warn', async () => {
    const ok = armar();
    await expect(
      ok.service.solicitarFacturaPorCobros({
        vueloIds: [V1],
        cobro: { monto: 1000, cuenta_destino: 'HSBC Pesos' },
        actorId: USER,
        cobroId: 'c-1',
      }),
    ).resolves.toEqual({ solicitados: [254], notificados: ['Mary Cruz'] });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const mal = armar({ falla: true });
      await expect(
        mal.service.solicitarFacturaPorCobros({
          vueloIds: [V1],
          cobro: { monto: 1000, cuenta_destino: 'HSBC Pesos' },
          actorId: USER,
          cobroId: 'c-1',
        }),
      ).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('el cobro c-1 quedó registrado'),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
