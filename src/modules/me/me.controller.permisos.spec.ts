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

const ALE = 'c691cc8b-3034-4f04-a383-d0b25c1971ec';

function armar(permiso: boolean) {
  const permisosDe = jest.fn().mockResolvedValue({
    editar_cotizacion_cobrada: permiso,
  });
  const configuracion = {
    isActiva: jest.fn().mockResolvedValue(true),
    numero: jest.fn().mockResolvedValue(1),
    permisosDe,
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
    });
    expect(r.push_dispositivos).toBe(1);
  });

  it('PATCH /me devuelve el MISMO shape (la app cachea las dos en la misma llave)', async () => {
    const { ctrl } = armar(false);
    const r = (await ctrl.update({}, yo)) as Record<string, unknown>;
    expect(r.permisos).toEqual({ editar_cotizacion_cobrada: false });
  });
});
