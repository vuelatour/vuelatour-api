import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import {
  ConfiguracionService,
  TOPE_LECTURA_MODELO_IA_MS,
} from '../configuracion/configuracion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from './pyservices.service';

/**
 * MODELO DE IA (2-oct-2026): TODA petición de `PyservicesService` (JSON,
 * binario POST y GET) lleva `X-IA-Modelo` SOLO cuando hay modelo
 * configurado; sin modelo, sin `ConfiguracionService` (specs viejos) o con
 * la lectura caída, la petición es byte-idéntica a la de antes.
 * `modeloIaServidor` (GET /ia/modelo) es best-effort: 404/caído ⇒ null.
 */
function svc(
  configuracion?: Pick<ConfiguracionService, 'headersModeloIa'>,
): PyservicesService {
  const config = {
    get: (k: string) => (k === 'PYSERVICES_BASE_URL' ? 'http://py/' : 'tok'),
  } as unknown as ConfigService<EnvVars, true>;
  return new PyservicesService(
    config,
    configuracion as unknown as ConfiguracionService | undefined,
  );
}

function conModelo(
  modelo: string | null,
): Pick<ConfiguracionService, 'headersModeloIa'> {
  return {
    headersModeloIa: jest
      .fn()
      .mockResolvedValue(modelo ? { 'X-IA-Modelo': modelo } : {}),
  };
}

function respuesta(
  status: number,
  cuerpo: string,
): Pick<Response, 'ok' | 'status' | 'arrayBuffer' | 'text' | 'json'> {
  const bytes = new TextEncoder().encode(cuerpo);
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(bytes.buffer),
    text: () => Promise.resolve(cuerpo),
    json: () => Promise.resolve(JSON.parse(cuerpo) as unknown),
  };
}

const headersDe = (spy: jest.SpyInstance, i = 0) =>
  (spy.mock.calls[i] as [string, RequestInit])[1].headers as Record<
    string,
    string
  >;

describe('PyservicesService — header X-IA-Modelo', () => {
  let fetchSpy: jest.SpyInstance;
  afterEach(() => fetchSpy?.mockRestore());

  const llamarLasTres = async (s: PyservicesService) => {
    // postForJson (la sugerencia IA gasto→vuelo), postForBuffer y getForBuffer.
    await s.sugerirGastoVuelo({} as never);
    await s.generateTablaXlsx({} as never);
    await s.getCotizacionHojaCss();
  };

  it('con modelo configurado: viaja en postForJson, postForBuffer y getForBuffer', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(respuesta(200, '{}') as unknown as Response),
      );
    await llamarLasTres(svc(conModelo('claude-sonnet-5')));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const h = headersDe(fetchSpy, i);
      expect(h['X-IA-Modelo']).toBe('claude-sonnet-5');
      expect(h['X-Internal-Token']).toBe('tok');
    }
    expect(headersDe(fetchSpy, 0)['Content-Type']).toBe('application/json');
    expect(headersDe(fetchSpy, 2)['Content-Type']).toBeUndefined();
  });

  it('sin modelo configurado: headers EXACTAMENTE los de antes (sin X-IA-Modelo)', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(respuesta(200, '{}') as unknown as Response),
      );
    await llamarLasTres(svc(conModelo(null)));
    expect(headersDe(fetchSpy, 0)).toEqual({
      'Content-Type': 'application/json',
      'X-Internal-Token': 'tok',
    });
    expect(headersDe(fetchSpy, 1)).toEqual({
      'Content-Type': 'application/json',
      'X-Internal-Token': 'tok',
    });
    expect(headersDe(fetchSpy, 2)).toEqual({ 'X-Internal-Token': 'tok' });
  });

  it('sin ConfiguracionService (constructor viejo) o con la lectura que lanza: sin header y la petición sale igual', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(respuesta(200, '{}') as unknown as Response),
      );
    await llamarLasTres(svc());
    const rota = {
      headersModeloIa: jest.fn().mockRejectedValue(new Error('BD caída')),
    };
    await llamarLasTres(svc(rota));
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    for (let i = 0; i < 6; i++) {
      expect(headersDe(fetchSpy, i)['X-IA-Modelo']).toBeUndefined();
    }
  });

  it('el modelo se lee en CADA petición (un cambio aplica a la siguiente)', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(respuesta(200, '{}') as unknown as Response),
      );
    const cfg = {
      headersModeloIa: jest
        .fn()
        .mockResolvedValueOnce({ 'X-IA-Modelo': 'claude-sonnet-5' })
        .mockResolvedValueOnce({}),
    };
    const s = svc(cfg);
    await s.generateTablaXlsx({} as never);
    await s.generateTablaXlsx({} as never);
    expect(headersDe(fetchSpy, 0)['X-IA-Modelo']).toBe('claude-sonnet-5');
    expect(headersDe(fetchSpy, 1)['X-IA-Modelo']).toBeUndefined();
  });
});

describe('PyservicesService — la lectura del modelo tiene TOPE', () => {
  let fetchSpy: jest.SpyInstance;
  afterEach(() => {
    fetchSpy?.mockRestore();
    jest.useRealTimers();
  });

  it('BD colgada (ConfiguracionService REAL, caché frío): la petición sale a los 1.5 s, sin header', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-02T15:00:00Z') });
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(respuesta(200, '{}') as unknown as Response),
      );
    // PostgREST que nunca responde (supabase-js no trae timeout propio).
    const colgada: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'abortSignal']) {
      colgada[m] = () => colgada;
    }
    colgada.maybeSingle = () => new Promise(() => {});
    const cfgReal = new ConfiguracionService({
      service: { from: () => colgada },
    } as unknown as SupabaseService);
    const s = svc(cfgReal);

    let listo = false;
    const p = s.generateTablaXlsx({} as never).then(() => (listo = true));
    await jest.advanceTimersByTimeAsync(TOPE_LECTURA_MODELO_IA_MS - 1);
    expect(listo).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await p;
    expect(listo).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(headersDe(fetchSpy)).toEqual({
      'Content-Type': 'application/json',
      'X-Internal-Token': 'tok',
    });
  });
});

describe('PyservicesService — modeloIaServidor (GET /ia/modelo)', () => {
  let fetchSpy: jest.SpyInstance;
  afterEach(() => fetchSpy?.mockRestore());

  it('devuelve default_servidor de pyservices (GET con token y tope corto)', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        respuesta(
          200,
          '{"default_servidor":"claude-opus-4-8","efectivo":"claude-sonnet-5"}',
        ) as unknown as Response,
      );
    await expect(
      svc(conModelo('claude-sonnet-5')).modeloIaServidor(),
    ).resolves.toBe('claude-opus-4-8');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://py/ia/modelo');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe(
      'tok',
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('pyservices viejo (404), 500, red caída, JSON raro o vacío ⇒ null, nunca lanza', async () => {
    const casos: Array<() => Promise<Response>> = [
      () => Promise.resolve(respuesta(404, 'Not Found') as unknown as Response),
      () => Promise.resolve(respuesta(500, 'boom') as unknown as Response),
      () => Promise.reject(new Error('ECONNREFUSED')),
      () => Promise.resolve(respuesta(200, 'no-json') as unknown as Response),
      () => Promise.resolve(respuesta(200, 'null') as unknown as Response),
      () =>
        Promise.resolve(
          respuesta(200, '{"default_servidor":""}') as unknown as Response,
        ),
      () =>
        Promise.resolve(
          respuesta(200, '{"default_servidor":5}') as unknown as Response,
        ),
    ];
    for (const caso of casos) {
      fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(caso);
      await expect(svc().modeloIaServidor()).resolves.toBeNull();
      fetchSpy.mockRestore();
    }
  });

  it('sin pyservices configurado ⇒ null sin tocar la red', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    const s = new PyservicesService({
      get: () => '',
    } as unknown as ConfigService<EnvVars, true>);
    await expect(s.modeloIaServidor()).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
