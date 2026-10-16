// INICIO OFICIAL (auditoría 16-oct-2026, API 0.0.85, invariante 86): ficha
// del piloto (mes con piso, últimos vuelos/gastos/capturas, honorarios del
// externo) y descansos (/me/descansos y /pilots/descansos).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../calendar/calendar.service', () => ({
  CalendarService: class {},
}));
jest.mock('../users/users.service', () => ({ UsersService: class {} }));

import { PilotsService } from './pilots.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
  type Responder,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';
const CORTE = '2026-09-01T00:00:00-05:00';

function armar(inicio: string | null, externo = false) {
  const responder: Responder = (tabla, ops) => {
    if (tabla === 'usuario' && ops.some((o) => o.m === 'maybeSingle')) {
      return {
        data: [{ id: 'p1', nombre: 'Ana', es_piloto_externo: externo }],
        error: null,
      };
    }
    if (
      tabla === 'vuelo' &&
      ops.some((o) => o.m === 'limit' && o.args[0] === 1000)
    ) {
      return { data: [{ id: 'v1', folio: 7 }], error: null };
    }
    return undefined;
  };
  const g = supabaseGrabador(responder);
  const horasDelMes = jest
    .fn()
    .mockResolvedValue({ horas: 0, limite: 100, restantes: 100 });
  const svc = new PilotsService(
    g.supabase,
    {} as never,
    { eventosProximosDe: jest.fn().mockResolvedValue([]) } as never,
    { horasDelMes } as never,
    {} as never,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  Object.assign(svc as unknown as Record<string, unknown>, {
    orRolesPiloto: jest
      .fn()
      .mockResolvedValue({ or: 'piloto_id.eq.p1', ctx: {} }),
  });
  return { svc, horasDelMes, ...g };
}

describe('PilotsService.findById — inicio oficial', () => {
  it('?mes anterior al inicio ⇒ mes del inicio (eco en stats.mes y horas)', async () => {
    const a = armar(INICIO);
    const r = (await a.svc.findById('p1', '2026-08')) as {
      stats: { mes: string };
    };
    expect(r.stats.mes).toBe('2026-09');
    expect(a.horasDelMes).toHaveBeenCalledWith('p1', '2026-09');
  });

  it('últimos vuelos, gastos y capturas recientes con piso', async () => {
    const a = armar(INICIO);
    await a.svc.findById('p1', '2026-10');
    const completados = a.de('vuelo').find((c) => a.lleva(c, 'limit', 20));
    expect(a.lleva(completados!, 'gte', 'fecha_vuelo', CORTE)).toBe(true);
    const gastosRecientes = a.de('gasto').find((c) => a.lleva(c, 'limit', 10));
    expect(a.lleva(gastosRecientes!, 'gte', 'fecha_gasto', INICIO)).toBe(true);
    const capturas = a.de('escala').find((c) => a.lleva(c, 'limit', 10));
    expect(
      a.lleva(
        capturas!,
        'or',
        `sincronizado_at.is.null,sincronizado_at.gte.${CORTE}`,
      ),
    ).toBe(true);
  });

  it('honorarios del externo desde el inicio y aditivo desde', async () => {
    const a = armar(INICIO, true);
    const r = (await a.svc.findById('p1')) as {
      honorarios: { desde: string | null };
    };
    const pagos = a
      .de('gasto')
      .find((c) => a.lleva(c, 'eq', 'categoria', 'PILOTO_EXTERNO'));
    expect(a.lleva(pagos!, 'gte', 'fecha_gasto', INICIO)).toBe(true);
    expect(r.honorarios.desde).toBe(INICIO);
  });

  it('inicio null ⇒ el mes pedido y sin pisos (como 0.0.84)', async () => {
    const a = armar(null, true);
    const r = (await a.svc.findById('p1', '2026-08')) as {
      stats: { mes: string };
      honorarios: { desde: string | null };
    };
    expect(r.stats.mes).toBe('2026-08');
    expect(r.honorarios.desde).toBeNull();
    const completados = a.de('vuelo').find((c) => a.lleva(c, 'limit', 20));
    expect(completados!.ops.some((o) => o.m === 'gte')).toBe(false);
  });
});

describe('PilotsService.listDescansos — inicio oficial', () => {
  beforeEach(() => {
    jest
      .spyOn(
        PilotsService.prototype as unknown as {
          conClientRequestDescanso(): Promise<boolean>;
        },
        'conClientRequestDescanso',
      )
      .mockResolvedValue(false);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sin desde ⇒ fecha_fin ≥ inicio; desde anterior sube', async () => {
    const a = armar(INICIO);
    await a.svc.listDescansos({});
    await a.svc.listDescansos({ desde: '2026-08-01' });
    for (const c of a.de('piloto_descanso')) {
      expect(a.lleva(c, 'gte', 'fecha_fin', INICIO)).toBe(true);
    }
  });

  it('rango entero anterior ⇒ [] sin consultar', async () => {
    const a = armar(INICIO);
    const r = await a.svc.listDescansos({
      desde: '2026-08-01',
      hasta: '2026-08-31',
    });
    expect(r).toEqual([]);
    expect(a.de('piloto_descanso')).toHaveLength(0);
  });

  it('inicio null ⇒ como 0.0.84', async () => {
    const a = armar(null);
    await a.svc.listDescansos({});
    expect(a.de('piloto_descanso')[0].ops.some((o) => o.m === 'gte')).toBe(
      false,
    );
  });
});
