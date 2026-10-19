// `permisos` en /me (26-sep-2026, ADITIVO): el panel decide con esto si el
// cotizador abre una cotización cobrada. Servicios stubbeados (sus módulos
// arrastran googleapis/jose).
jest.mock('../users/users.service', () => ({ UsersService: class {} }));
jest.mock('./me-capturas.service', () => ({ MeCapturasService: class {} }));
jest.mock('../pilots/pilots.service', () => ({ PilotsService: class {} }));
jest.mock('../calendar/calendar.service', () => ({
  CalendarService: class {},
}));
jest.mock('../realtime/push.service', () => ({ PushService: class {} }));
jest.mock('../caja-chica/caja-chica.service', () => ({
  CajaChicaService: class {},
}));

import { MeController } from './me.controller';
import { Rol, EstadoUsuario } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import type { UsersService } from '../users/users.service';
import type { MeCapturasService } from './me-capturas.service';
import type { PilotsService } from '../pilots/pilots.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { CalendarService } from '../calendar/calendar.service';
import type { PushService } from '../realtime/push.service';
import type { CajaChicaService } from '../caja-chica/caja-chica.service';
import type { SupabaseService } from '../supabase/supabase.service';

const ALE = 'c691cc8b-3034-4f04-a383-d0b25c1971ec';

function armar(
  permiso: boolean,
  inicio?: string | null,
  supabase?: SupabaseService,
) {
  const permisosDe = jest.fn().mockResolvedValue({
    editar_cotizacion_cobrada: permiso,
  });
  const configuracion = {
    isActiva: jest.fn().mockResolvedValue(true),
    numero: jest.fn().mockResolvedValue(1),
    permisosDe,
    // Sin `inicio` el mock NO trae el método (mock parcial de los specs
    // viejos): `inicioOficialDe` responde null.
    ...(inicio === undefined
      ? {}
      : { inicioOficial: jest.fn().mockResolvedValue(inicio) }),
  } as unknown as ConfiguracionService;
  const users = {
    findByAuthId: jest.fn().mockResolvedValue({
      id: ALE,
      nombre: 'Alejandro Canales',
      rol: 'ADMIN',
    }),
    updateSelf: jest.fn().mockResolvedValue({
      id: ALE,
      nombre: 'Alejandro Canales',
      rol: 'ADMIN',
    }),
    gastosSinLimiteHasta: jest.fn().mockResolvedValue(null),
  } as unknown as UsersService;
  const push = {
    contarDispositivosPorUsuario: jest
      .fn()
      .mockResolvedValue(new Map([[ALE, 1]])),
  } as unknown as PushService;
  const ctrl = new MeController(
    users,
    {} as MeCapturasService,
    {} as PilotsService,
    configuracion,
    {} as CalendarService,
    push,
    {} as CajaChicaService,
    supabase,
  );
  return { ctrl, permisosDe };
}

const yo: AuthenticatedUser = {
  authId: 'auth-ale',
  userId: ALE,
  email: 'ale@example.com',
  nombre: 'Alejandro Canales',
  rol: Rol.ADMIN,
  estado: EstadoUsuario.ACTIVO,
  jwt: 'x',
};

describe('MeController — permisos por persona', () => {
  it('GET /me trae permisos.editar_cotizacion_cobrada (sin mover `config`)', async () => {
    const { ctrl, permisosDe } = armar(true);
    const r = (await ctrl.me(yo)) as Record<string, unknown>;
    expect(r.permisos).toEqual({ editar_cotizacion_cobrada: true });
    expect(permisosDe).toHaveBeenCalledWith(ALE, Rol.ADMIN);
    expect(r.config).toEqual({
      captura_taco_foto_ia: true,
      dias_gracia_gastos_semana: 1,
      gastos_sin_limite_hasta: null,
      inicio_oficial: null,
      // AFAC por vuelo (invariante 90): sin Supabase inyectado ⇒ false.
      afac_real: false,
      // Gastos por pagar (invariante 93): sin la capacidad, la ÚNICA llave
      // nueva es `gastos_por_pagar: false` (sin `gasto_fecha_max`).
      gastos_por_pagar: false,
    });
    expect(r.push_dispositivos).toBe(1);
  });

  it('PATCH /me devuelve el MISMO shape (la app cachea las dos en la misma llave)', async () => {
    const { ctrl } = armar(false);
    const r = (await ctrl.update({}, yo)) as Record<string, unknown>;
    expect(r.permisos).toEqual({ editar_cotizacion_cobrada: false });
  });
});

describe('MeController — inicio oficial (16-oct-2026, invariante 86)', () => {
  it.each([
    ['fecha', '2026-09-01'],
    ['null (sin piso)', null],
  ])('GET y PATCH traen config.inicio_oficial con %s', async (_n, inicio) => {
    const { ctrl } = armar(true, inicio);
    const g = (await ctrl.me(yo)) as { config: Record<string, unknown> };
    const p = (await ctrl.update({}, yo)) as {
      config: Record<string, unknown>;
    };
    expect(g.config.inicio_oficial).toBe(inicio);
    // MISMO shape en las dos (la app cachea ambas en la misma llave).
    expect(p.config).toEqual(g.config);
  });
});

describe('MeController — config.afac_real (16-oct-2026, invariante 90)', () => {
  /** Supabase cuyo sondeo de `gasto.es_pago_afac` responde `error`. */
  const sb = (error: { code: string; message: string } | null) =>
    ({
      service: {
        from: () => ({
          select: () => ({
            limit: () => Promise.resolve({ data: error ? null : [], error }),
          }),
        }),
      },
    }) as unknown as SupabaseService;

  it('con la migración ⇒ true en GET y PATCH (MISMO shape)', async () => {
    const { ctrl } = armar(true, null, sb(null));
    const g = (await ctrl.me(yo)) as { config: Record<string, unknown> };
    const p = (await ctrl.update({}, yo)) as {
      config: Record<string, unknown>;
    };
    expect(g.config.afac_real).toBe(true);
    expect(p.config).toEqual(g.config);
  });

  it('sin la migración (42703) ⇒ false: el panel no ofrece la casilla ni la celda editable', async () => {
    const { ctrl } = armar(
      true,
      null,
      sb({
        code: '42703',
        message: 'column gasto.es_pago_afac does not exist',
      }),
    );
    const g = (await ctrl.me(yo)) as { config: Record<string, unknown> };
    expect(g.config.afac_real).toBe(false);
  });
});

describe('MeController — config.gastos_por_pagar (19-oct-2026, invariante 93)', () => {
  afterEach(() => jest.useRealTimers());

  /** Supabase cuyo sondeo de CUALQUIER columna de `gasto` responde `error`. */
  const sb = (
    errores: Record<string, { code: string; message: string } | null>,
  ) =>
    ({
      service: {
        from: () => ({
          select: (col: string) => ({
            limit: () =>
              Promise.resolve({
                data: errores[col] ? null : [],
                error: errores[col] ?? null,
              }),
          }),
        }),
      },
    }) as unknown as SupabaseService;
  const NO_EXISTE = { code: '42703', message: 'column does not exist' };

  it('con la migración ⇒ true y `gasto_fecha_max` en GET y PATCH (MISMO shape); oficina +30', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T15:00:00Z'));
    const { ctrl } = armar(true, null, sb({}));
    const g = (await ctrl.me(yo)) as { config: Record<string, unknown> };
    const p = (await ctrl.update({}, yo)) as {
      config: Record<string, unknown>;
    };
    expect(g.config.gastos_por_pagar).toBe(true);
    expect(g.config.gasto_fecha_max).toBe('2026-11-18');
    expect(p.config).toEqual(g.config);
    // Las llaves nuevas van al FINAL de `config`.
    expect(Object.keys(g.config).slice(-2)).toEqual([
      'gastos_por_pagar',
      'gasto_fecha_max',
    ]);
  });

  it('PILOTO con la migración ⇒ fin de mes; el último día del mes ⇒ mañana', async () => {
    const piloto = { ...yo, rol: Rol.PILOTO };
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T15:00:00Z'));
    let { ctrl } = armar(true, null, sb({}));
    let g = (await ctrl.me(piloto)) as { config: Record<string, unknown> };
    expect(g.config.gasto_fecha_max).toBe('2026-10-31');
    jest.setSystemTime(new Date('2026-10-31T15:00:00Z'));
    ({ ctrl } = armar(true, null, sb({})));
    g = await ctrl.me(piloto);
    expect(g.config.gasto_fecha_max).toBe('2026-11-01');
  });

  it('sin la migración (42703 en `por_pagar`) ⇒ `gastos_por_pagar: false` y SIN `gasto_fecha_max`', async () => {
    const { ctrl } = armar(true, null, sb({ por_pagar: NO_EXISTE }));
    const g = (await ctrl.me(yo)) as { config: Record<string, unknown> };
    const p = (await ctrl.update({}, yo)) as {
      config: Record<string, unknown>;
    };
    expect(g.config.gastos_por_pagar).toBe(false);
    expect('gasto_fecha_max' in g.config).toBe(false);
    expect(p.config).toEqual(g.config);
    // La otra capacidad no se entera.
    expect(g.config.afac_real).toBe(true);
  });
});
