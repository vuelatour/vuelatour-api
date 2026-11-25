import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuthTokenService } from './auth-token.service';
import {
  USUARIO_AUTH_MAX,
  USUARIO_AUTH_TTL_MS,
  olvidarUsuariosAuth,
  usuarioAuthCacheado,
  usuariosAuthEnCache,
} from './usuario-auth-cache';
import { UsersService } from '../../modules/users/users.service';
import type { EmailService } from '../../modules/notifications/email.service';
import type { PushService } from '../../modules/realtime/push.service';
import type { SupabaseService } from '../../modules/supabase/supabase.service';
import type { EnvVars } from '../../config/env.schema';

// `jose` es ESM puro y jest no lo transforma. Aquí no se prueba la firma del
// JWT (`verify` va simulado más abajo), así que basta un doble.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  decodeProtectedHeader: jest.fn(),
  jwtVerify: jest.fn(),
}));

/**
 * Caché corto del usuario por petición (25-nov-2026, invariante 144).
 *
 * El 25-nov-2026 la base (Supabase Micro) se saturó dos veces en media hora.
 * En el minuto pico, 706 de las 3,746 peticiones a Supabase eran la MISMA
 * consulta: `usuario` por `supabase_auth_id`, una por cada petición del API.
 * Estas pruebas congelan que el caché quita esa lectura SIN abrir ninguna
 * puerta: quien no puede entrar no entra, y desactivar o cambiar el rol
 * desde el API aplica en la petición siguiente.
 */

beforeEach(() => olvidarUsuariosAuth());

describe('usuarioAuthCacheado', () => {
  it('dos peticiones seguidas del mismo usuario leen UNA vez', async () => {
    const leer = jest.fn().mockResolvedValue({ rol: 'ADMIN' });
    const a = await usuarioAuthCacheado('auth-1', leer, 1_000);
    const b = await usuarioAuthCacheado('auth-1', leer, 1_000 + 5_000);
    expect(leer).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ rol: 'ADMIN' });
    expect(b).toEqual({ rol: 'ADMIN' });
  });

  it('vencido el TTL se vuelve a leer (lo cambiado por SQL directo tarda como mucho eso)', async () => {
    const leer = jest
      .fn()
      .mockResolvedValueOnce({ rol: 'ADMIN' })
      .mockResolvedValueOnce({ rol: 'COORDINADOR' });
    await usuarioAuthCacheado('auth-1', leer, 1_000);
    const justoAntes = await usuarioAuthCacheado(
      'auth-1',
      leer,
      1_000 + USUARIO_AUTH_TTL_MS - 1,
    );
    const alVencer = await usuarioAuthCacheado(
      'auth-1',
      leer,
      1_000 + USUARIO_AUTH_TTL_MS,
    );
    expect(justoAntes).toEqual({ rol: 'ADMIN' });
    expect(alVencer).toEqual({ rol: 'COORDINADOR' });
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('una ráfaga simultánea (una pantalla = 12 llamadas al API) comparte UNA lectura', async () => {
    let soltar: (v: { rol: string }) => void = () => {};
    const leer = jest.fn(
      () => new Promise<{ rol: string }>((r) => (soltar = r)),
    );
    const rafaga = Array.from({ length: 12 }, () =>
      usuarioAuthCacheado('auth-1', leer, 1_000),
    );
    await Promise.resolve();
    soltar({ rol: 'ADMIN' });
    const todos = await Promise.all(rafaga);
    expect(leer).toHaveBeenCalledTimes(1);
    expect(todos).toHaveLength(12);
    expect(todos.every((u) => u.rol === 'ADMIN')).toBe(true);
  });

  it('un rechazo NUNCA se guarda: el siguiente intento vuelve a leer', async () => {
    const leer = jest
      .fn()
      .mockRejectedValueOnce(
        new UnauthorizedException('User account is INACTIVO'),
      )
      .mockResolvedValueOnce({ rol: 'PILOTO' });
    await expect(usuarioAuthCacheado('auth-1', leer, 1_000)).rejects.toThrow(
      'INACTIVO',
    );
    expect(usuariosAuthEnCache()).toBe(0);
    await expect(usuarioAuthCacheado('auth-1', leer, 1_001)).resolves.toEqual({
      rol: 'PILOTO',
    });
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('olvidarUsuariosAuth obliga a releer de inmediato', async () => {
    const leer = jest
      .fn()
      .mockResolvedValueOnce({ rol: 'ADMIN' })
      .mockResolvedValueOnce({ rol: 'ANALISTA' });
    await usuarioAuthCacheado('auth-1', leer, 1_000);
    olvidarUsuariosAuth();
    await expect(usuarioAuthCacheado('auth-1', leer, 1_001)).resolves.toEqual({
      rol: 'ANALISTA',
    });
  });

  it('una lectura que iba en curso al invalidar no vuelve a ocupar el caché', async () => {
    let soltar: (v: { rol: string }) => void = () => {};
    const lenta = jest.fn(
      () => new Promise<{ rol: string }>((r) => (soltar = r)),
    );
    const enCurso = usuarioAuthCacheado('auth-1', lenta, 1_000);
    await Promise.resolve();
    olvidarUsuariosAuth(); // la oficina le cambió el rol justo ahora
    const fresca = jest.fn().mockResolvedValue({ rol: 'ANALISTA' });
    const despues = usuarioAuthCacheado('auth-1', fresca, 1_001);
    soltar({ rol: 'ADMIN' }); // la lectura vieja termina DESPUÉS
    await enCurso;
    await expect(despues).resolves.toEqual({ rol: 'ANALISTA' });
    await expect(
      usuarioAuthCacheado('auth-1', jest.fn(), 1_002),
    ).resolves.toEqual({ rol: 'ANALISTA' });
  });

  it('cada usuario tiene su entrada', async () => {
    const uno = jest.fn().mockResolvedValue({ id: 'u-1' });
    const dos = jest.fn().mockResolvedValue({ id: 'u-2' });
    await usuarioAuthCacheado('auth-1', uno, 1_000);
    await expect(usuarioAuthCacheado('auth-2', dos, 1_000)).resolves.toEqual({
      id: 'u-2',
    });
    expect(usuariosAuthEnCache()).toBe(2);
  });

  it('no crece sin límite', async () => {
    for (let i = 0; i < USUARIO_AUTH_MAX + 50; i++) {
      await usuarioAuthCacheado(`auth-${i}`, () => Promise.resolve(i), 1_000);
    }
    expect(usuariosAuthEnCache()).toBeLessThanOrEqual(USUARIO_AUTH_MAX);
  });
});

// ---------------------------------------------------------------------------

type Fila = Record<string, unknown> | null;

/** Doble de Supabase: cuenta las consultas a `usuario` y responde `fila()`. */
function armarAuth(fila: () => Fila, error: null | { message: string } = null) {
  const consultas: string[] = [];
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (_col: string, valor: string) => {
      consultas.push(`${tabla}:${valor}`);
      return q;
    };
    q.maybeSingle = () => Promise.resolve({ data: fila(), error });
    return q;
  };
  const config = {
    get: (clave: string) =>
      clave === 'SUPABASE_URL' ? 'https://ejemplo.supabase.co' : undefined,
  } as unknown as ConfigService<EnvVars, true>;
  const service = new AuthTokenService(config, {
    service: { from },
  } as unknown as SupabaseService);
  // La firma del JWT no es lo que se prueba aquí: `verify` devuelve el `sub`
  // que va en el propio «token» de la prueba.
  jest
    .spyOn(service, 'verify')
    .mockImplementation((token: string) =>
      Promise.resolve({ sub: token.split('|')[0] }),
    );
  return { service, consultas };
}

const ALE = {
  id: 'u-ale',
  supabase_auth_id: 'auth-ale',
  email: 'ale@ejemplo.com',
  nombre: 'Ale',
  rol: 'DIRECCION',
  estado: 'ACTIVO',
  es_piloto_externo: false,
};

describe('AuthTokenService.resolveUser — con el caché', () => {
  afterEach(() => jest.restoreAllMocks());

  it('12 peticiones del mismo usuario = UNA consulta a la base', async () => {
    const { service, consultas } = armarAuth(() => ALE);
    const usuarios = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        service.resolveUser(`auth-ale|token-${i}`),
      ),
    );
    expect(consultas).toEqual(['usuario:auth-ale']);
    expect(usuarios[0]).toEqual({
      authId: 'auth-ale',
      userId: 'u-ale',
      email: 'ale@ejemplo.com',
      nombre: 'Ale',
      rol: 'DIRECCION',
      estado: 'ACTIVO',
      jwt: 'auth-ale|token-0',
    });
  });

  it('cada petición recibe SU token y un objeto propio (nada se comparte)', async () => {
    const { service } = armarAuth(() => ALE);
    const a = await service.resolveUser('auth-ale|uno');
    const b = await service.resolveUser('auth-ale|dos');
    expect(a.jwt).toBe('auth-ale|uno');
    expect(b.jwt).toBe('auth-ale|dos');
    expect(a).not.toBe(b);
    (a as { rol: string }).rol = 'ALTERADO';
    const c = await service.resolveUser('auth-ale|tres');
    expect(c.rol).toBe('DIRECCION');
  });

  it('el token se verifica en CADA petición aunque el usuario esté en caché', async () => {
    const { service } = armarAuth(() => ALE);
    await service.resolveUser('auth-ale|bueno');
    (service.verify as jest.Mock).mockRejectedValueOnce(
      new UnauthorizedException('Invalid or expired token'),
    );
    await expect(service.resolveUser('auth-ale|vencido')).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it('un usuario INACTIVO no entra y NO queda guardado: al activarlo entra', async () => {
    let estado = 'INACTIVO';
    const { service, consultas } = armarAuth(() => ({ ...ALE, estado }));
    await expect(service.resolveUser('auth-ale|a')).rejects.toThrow(
      'User account is INACTIVO',
    );
    await expect(service.resolveUser('auth-ale|b')).rejects.toThrow(
      'User account is INACTIVO',
    );
    expect(consultas).toHaveLength(2);
    estado = 'ACTIVO';
    await expect(service.resolveUser('auth-ale|c')).resolves.toMatchObject({
      estado: 'ACTIVO',
    });
  });

  it('piloto externo, usuario sin alta y base caída siguen rechazando (y no se guardan)', async () => {
    const externo = armarAuth(() => ({ ...ALE, es_piloto_externo: true }));
    await expect(externo.service.resolveUser('auth-ale|a')).rejects.toThrow(
      'Los pilotos externos no tienen acceso al sistema',
    );
    olvidarUsuariosAuth();
    const sinAlta = armarAuth(() => null);
    await expect(sinAlta.service.resolveUser('auth-ale|a')).rejects.toThrow(
      'User not provisioned in application',
    );
    olvidarUsuariosAuth();
    const caida = armarAuth(() => null, { message: 'timeout' });
    await expect(caida.service.resolveUser('auth-ale|a')).rejects.toThrow(
      'User lookup failed: timeout',
    );
    await expect(caida.service.resolveUser('auth-ale|b')).rejects.toThrow(
      'User lookup failed: timeout',
    );
    expect(caida.consultas).toHaveLength(2);
    expect(usuariosAuthEnCache()).toBe(0);
  });

  it('desactivar al usuario desde el API aplica en su SIGUIENTE petición', async () => {
    let estado = 'ACTIVO';
    const { service } = armarAuth(() => ({ ...ALE, estado }));
    await service.resolveUser('auth-ale|a');
    estado = 'INACTIVO';
    olvidarUsuariosAuth(); // lo que hace UsersService.update al guardar
    await expect(service.resolveUser('auth-ale|b')).rejects.toThrow(
      'User account is INACTIVO',
    );
  });
});

// ---------------------------------------------------------------------------

/** Doble mínimo para `UsersService`: toda consulta responde `fila`. */
function armarUsers(fila: Record<string, unknown>) {
  const from = () => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'update', 'insert', 'order', 'limit']) {
      q[m] = () => q;
    }
    q.maybeSingle = () => Promise.resolve({ data: fila, error: null });
    q.then = (
      resolve: (v: { data: unknown; error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve({ data: fila, error: null }).then(resolve, reject);
    return q;
  };
  return new UsersService(
    { service: { from } } as unknown as SupabaseService,
    {} as EmailService,
    {} as PushService,
  );
}

describe('UsersService — todo cambio de usuario vacía el caché', () => {
  const FILA = { ...ALE, es_piloto: false, tarjeta_terminacion: '' };

  it('update (rol, estado, desactivar)', async () => {
    await usuarioAuthCacheado('auth-ale', () => Promise.resolve(ALE));
    expect(usuariosAuthEnCache()).toBe(1);
    await armarUsers(FILA).update('u-ale', { rol: 'ANALISTA' } as never, 'u-x');
    expect(usuariosAuthEnCache()).toBe(0);
  });

  it('softDelete', async () => {
    await usuarioAuthCacheado('auth-ale', () => Promise.resolve(ALE));
    await armarUsers(FILA).softDelete('u-ale', 'u-x');
    expect(usuariosAuthEnCache()).toBe(0);
  });

  it('updateSelf (el propio usuario cambia su nombre)', async () => {
    await usuarioAuthCacheado('auth-ale', () => Promise.resolve(ALE));
    await armarUsers(FILA).updateSelf(
      'auth-ale',
      { nombre: 'Alejandro' },
      'u-ale',
    );
    expect(usuariosAuthEnCache()).toBe(0);
  });
});
