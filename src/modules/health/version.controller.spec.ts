import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import { VersionController } from './version.controller';

/**
 * `GET /v1/version` — la COMPUERTA de cada deploy (9-nov-2026, API 0.0.129):
 * además de `name`/`version`/`env` dice el commit DESPLEGADO de pyservices
 * (`GET <PYSERVICES_BASE_URL>/version`), porque su URL en Railway es interna
 * y desde fuera no había cómo verificar que un push a pyservices ya corría.
 * Nunca tumba la ruta: sin URL, sin respuesta o con error ⇒ `null`.
 */
function controller(env: Partial<EnvVars>) {
  const config = {
    get: (k: keyof EnvVars) => env[k],
  } as unknown as ConfigService<EnvVars, true>;
  return new VersionController(config);
}

describe('VersionController — compuerta con el commit de pyservices', () => {
  const fetchOriginal = global.fetch;
  afterEach(() => {
    global.fetch = fetchOriginal;
  });

  it('sin PYSERVICES_BASE_URL: `pyservices` es null y no se llama a nadie', async () => {
    const llamadas: string[] = [];
    global.fetch = (url: string) => {
      llamadas.push(url);
      return Promise.resolve(new Response('{}'));
    };
    const r = await controller({
      NODE_ENV: 'test',
    }).get();
    expect(r).toMatchObject({ name: 'vuelatour-api', env: 'test' });
    expect(typeof r.version).toBe('string');
    expect(r.pyservices).toBeNull();
    expect(llamadas).toEqual([]);
  });

  it('con la URL: pide `<base>/version` (sin barra doble) y devuelve el commit', async () => {
    const llamadas: string[] = [];
    global.fetch = (url: string) => {
      llamadas.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            commit: 'bb3fe07abc',
            servicio: 'vuelatour-pyservices',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const r = await controller({
      NODE_ENV: 'production',
      PYSERVICES_BASE_URL: 'http://vuelatour-pyservices.railway.internal:8000/',
    }).get();
    expect(llamadas).toEqual([
      'http://vuelatour-pyservices.railway.internal:8000/version',
    ]);
    expect(r.pyservices).toEqual({ commit: 'bb3fe07abc' });
  });

  it('pyservices fuera de Railway (`commit: null`), respuesta no OK o error de red ⇒ null sin tumbar la ruta', async () => {
    const base = { PYSERVICES_BASE_URL: 'http://py.local' } as Partial<EnvVars>;
    global.fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ commit: null })));
    expect((await controller(base).get()).pyservices).toEqual({ commit: null });
    global.fetch = () => Promise.resolve(new Response('x', { status: 503 }));
    expect((await controller(base).get()).pyservices).toBeNull();
    global.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    expect((await controller(base).get()).pyservices).toBeNull();
  });
});
