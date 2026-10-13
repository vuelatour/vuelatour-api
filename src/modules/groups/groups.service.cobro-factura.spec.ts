// Dependencias que arrastran módulos pesados (push, googleapis, IA, HTTP):
// fuera del spec. GroupsService solo necesita `flights` como colaborador.
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
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));
jest.mock('../quotes/quotes.service', () => ({ QuotesService: class {} }));

import { Logger } from '@nestjs/common';
import { GroupsService } from './groups.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { FlightsService } from '../flights/flights.service';
import type { QuotesService } from '../quotes/quotes.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { CreateCobroGrupoDto } from './dto/cobro-grupo.dto';

/**
 * FACTURA OBLIGATORIA POR CUENTA DE COBRO (13-oct-2026, invariante 60) —
 * el SOBRE de grupo: `registrarCobro` pide la factura UNA vez por sobre
 * (los vuelos con parte > 0, con `cobroGrupoId`), DESPUÉS de escribir las
 * partes y ANTES del aviso `cobro_registrado`, por la puerta única
 * `FlightsService.solicitarFacturaPorCobros`; un sobre BillPocket no pide
 * nada; un fallo del gancho no revierte el sobre ni calla el aviso; y
 * `repartirCobro` vuelve a pedirla. Fake liviano: Supabase solo para el
 * sobre (`cobro_grupo`) y los pasos pesados (cabecera, partición, partes,
 * relectura) espiados sobre la instancia real.
 */
type Fila = Record<string, unknown>;
type Op = { m: string; args: unknown[] };

const G = 'grupo-1';
const SOBRE = 'sobre-1';
const USER = 'u-itzi';

function fakeSupabase(secuencia: string[]) {
  const from = (tabla: string) => {
    const ops: Op[] = [];
    const q: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'gte',
      'lte',
      'order',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = (...args: unknown[]) => {
        ops.push({ m, args });
        return q;
      };
    }
    const resolver = (lista: boolean) => {
      const ins = ops.find((o) => o.m === 'insert');
      if (tabla === 'cobro_grupo' && ins) {
        secuencia.push('sobre');
        return { data: { id: SOBRE, ...(ins.args[0] as Fila) }, error: null };
      }
      return { data: lista ? [] : null, error: null };
    };
    q.maybeSingle = () => Promise.resolve(resolver(false));
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolver(true)).then(res, rej);
    return q;
  };
  return { service: { from } } as unknown as SupabaseService;
}

type Privado = {
  cargarCabecera: unknown;
  aplicarComisionDefault: unknown;
  prepararSobre: unknown;
  escribirPartes: unknown;
  sobrePorId: unknown;
  cargarSobre: unknown;
  cargarPartes: unknown;
  cargarHijos: unknown;
  assertPartesFueraDeMesCerrado: unknown;
  borrarPartes: unknown;
  refrescarCobrado: unknown;
};

interface Mundo {
  /** La solicitud automática rechaza. */
  falla?: boolean;
  /** Partes de la partición (default: dos hijos con dinero y uno en 0). */
  partes?: Array<{ vuelo_id: string; monto: number }>;
}

function armar(m: Mundo = {}) {
  const secuencia: string[] = [];
  const solicitarFacturaPorCobros = jest.fn().mockImplementation(() => {
    secuencia.push('factura');
    return m.falla
      ? Promise.reject(new Error('BD caída'))
      : Promise.resolve({ solicitados: [341, 342], notificados: [] });
  });
  const notificarCobroRegistrado = jest.fn().mockImplementation(() => {
    secuencia.push('aviso');
  });
  const flights = {
    solicitarFacturaPorCobros,
    notificarCobroRegistrado,
    refreshCobradoFlag: jest.fn().mockResolvedValue(undefined),
  } as unknown as FlightsService;
  const svc = new GroupsService(
    fakeSupabase(secuencia),
    {} as QuotesService,
    flights,
    {} as CalendarSyncService,
  );
  const priv = svc as unknown as Privado;
  const cab = { id: G, folio: 12, cancelado_at: null };
  const partes = (
    m.partes ?? [
      { vuelo_id: 'v-341', monto: 500 },
      { vuelo_id: 'v-342', monto: 300 },
      { vuelo_id: 'v-343', monto: 0 },
    ]
  ).map((p, i) => ({
    ...p,
    folio: 341 + i,
    posicion: i + 1,
    matricula: null,
    monto_usd: p.monto,
    factor: 0.5,
    comision_banco_monto: null,
    saldo_antes_usd: 0,
    saldo_despues_usd: 0,
  }));
  const prep = {
    particion: {
      modo_particion: 'PROPORCIONAL',
      monto: 800,
      monto_usd: 800,
      moneda: 'USD',
      tc: null,
      partes,
      verificacion: {
        suma_partes: 800,
        monto: 800,
        cuadra: true,
        suma_comision: null,
        comision: null,
        cuadra_comision: true,
      },
      avisos: [],
    },
    comision: { pct: null, monto: null },
    avisos: [],
  };
  jest.spyOn(priv, 'cargarCabecera' as never).mockResolvedValue(cab as never);
  jest
    .spyOn(priv, 'aplicarComisionDefault' as never)
    .mockResolvedValue(undefined as never);
  jest.spyOn(priv, 'prepararSobre' as never).mockResolvedValue(prep as never);
  jest.spyOn(priv, 'escribirPartes' as never).mockImplementation((() => {
    secuencia.push('partes');
    return Promise.resolve();
  }) as never);
  jest
    .spyOn(priv, 'sobrePorId' as never)
    .mockResolvedValue({ id: SOBRE, partes: [] } as never);
  // repartirCobro
  jest.spyOn(priv, 'cargarSobre' as never).mockResolvedValue({
    id: SOBRE,
    grupo_id: G,
    monto: 800,
    moneda: 'USD',
    metodo_cobro: 'TRANSFERENCIA',
    tc_usd_mxn: null,
    comision_banco_pct: null,
    comision_banco_monto: null,
    cuenta_destino: 'HSBC Pesos',
    modo_particion: 'PROPORCIONAL',
    fecha_cobro: '2026-09-27T15:00:00Z',
  } as never);
  jest.spyOn(priv, 'cargarPartes' as never).mockResolvedValue([] as never);
  jest.spyOn(priv, 'cargarHijos' as never).mockResolvedValue([] as never);
  jest
    .spyOn(priv, 'assertPartesFueraDeMesCerrado' as never)
    .mockImplementation((() => undefined) as never);
  jest
    .spyOn(priv, 'borrarPartes' as never)
    .mockResolvedValue(['v-341', 'v-342'] as never);
  jest
    .spyOn(priv, 'refrescarCobrado' as never)
    .mockResolvedValue(undefined as never);
  return {
    svc,
    secuencia,
    solicitarFacturaPorCobros,
    notificarCobroRegistrado,
  };
}

const dto = (extra: Record<string, unknown> = {}): CreateCobroGrupoDto =>
  ({
    monto: 800,
    moneda: 'USD',
    metodo_cobro: 'TRANSFERENCIA',
    ...extra,
  }) as unknown as CreateCobroGrupoDto;

describe('GroupsService.registrarCobro — solicitud automática de factura por el sobre', () => {
  it('sobre en HSBC Pesos ⇒ UNA llamada con los vuelos con parte > 0 y `cobroGrupoId`, DESPUÉS de las partes y ANTES del aviso', async () => {
    const {
      svc,
      secuencia,
      solicitarFacturaPorCobros,
      notificarCobroRegistrado,
    } = armar();
    const r = await svc.registrarCobro(
      G,
      dto({ cuenta_destino: 'HSBC Pesos' }),
      USER,
    );
    expect(r.idempotente).toBe(false);
    expect(solicitarFacturaPorCobros).toHaveBeenCalledTimes(1);
    expect(solicitarFacturaPorCobros).toHaveBeenCalledWith({
      vueloIds: ['v-341', 'v-342'],
      cobro: {
        monto: 800,
        cuenta_destino: 'HSBC Pesos',
        metodo_cobro: 'TRANSFERENCIA',
      },
      actorId: USER,
      cobroGrupoId: SOBRE,
    });
    expect(notificarCobroRegistrado).toHaveBeenCalledTimes(1);
    expect(secuencia).toEqual(['sobre', 'partes', 'factura', 'aviso']);
  });

  it('sobre BillPocket ⇒ ninguna solicitud (y el aviso de cobro sale igual)', async () => {
    const { svc, solicitarFacturaPorCobros, notificarCobroRegistrado } =
      armar();
    await svc.registrarCobro(G, dto({ metodo_cobro: 'BILLPOCKET' }), USER);
    expect(solicitarFacturaPorCobros).not.toHaveBeenCalled();
    expect(notificarCobroRegistrado).toHaveBeenCalledTimes(1);
  });

  it('si la solicitud falla, el sobre queda registrado y `cobro_registrado` se avisa igual (warn)', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { svc, secuencia, notificarCobroRegistrado } = armar({
        falla: true,
      });
      const r = await svc.registrarCobro(
        G,
        dto({ cuenta_destino: 'HSBC Pesos' }),
        USER,
      );
      expect(r.sobre).toMatchObject({ id: SOBRE });
      expect(notificarCobroRegistrado).toHaveBeenCalledTimes(1);
      expect(secuencia).toEqual(['sobre', 'partes', 'factura', 'aviso']);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('la solicitud automática de factura falló'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('sin partes con dinero (solo partes en 0) ⇒ no llama', async () => {
    const { svc, solicitarFacturaPorCobros } = armar({
      partes: [{ vuelo_id: 'v-341', monto: 0 }],
    });
    await svc.registrarCobro(G, dto({ cuenta_destino: 'HSBC Pesos' }), USER);
    expect(solicitarFacturaPorCobros).not.toHaveBeenCalled();
  });
});

describe('GroupsService.repartirCobro — vuelve a pedir la factura', () => {
  it('tras re-escribir las partes llama UNA vez con los hijos con parte > 0', async () => {
    const { svc, solicitarFacturaPorCobros } = armar();
    await svc.repartirCobro(SOBRE, USER);
    expect(solicitarFacturaPorCobros).toHaveBeenCalledTimes(1);
    expect(solicitarFacturaPorCobros).toHaveBeenCalledWith({
      vueloIds: ['v-341', 'v-342'],
      cobro: {
        monto: 800,
        cuenta_destino: 'HSBC Pesos',
        metodo_cobro: 'TRANSFERENCIA',
      },
      actorId: USER,
      cobroGrupoId: SOBRE,
    });
  });
});
