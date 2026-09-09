import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import {
  PyservicesService,
  type MapaPuntoPdfPayload,
} from './pyservices.service';

/**
 * Cliente de pyservices — rutas de la HOJA de cotización (form-as-document,
 * 8-sep-2026): `GET /reportes/cotizacion/hoja.css` (texto estático) y
 * `POST /reportes/cotizacion/mapa-svg` (svg | 204). Ambas con
 * `X-Internal-Token`, timeout y la misma traducción de fallos (502/503).
 */
function svc(configurado = true): PyservicesService {
  const config = {
    get: (k: string) => {
      if (!configurado) return '';
      return k === 'PYSERVICES_BASE_URL' ? 'http://py/' : 'tok';
    },
  } as unknown as ConfigService<EnvVars, true>;
  return new PyservicesService(config);
}

function respuesta(
  status: number,
  cuerpo: string,
): Pick<Response, 'ok' | 'status' | 'arrayBuffer' | 'text'> {
  // TextEncoder devuelve un Uint8Array con buffer PROPIO (Buffer.from usa el
  // pool compartido de 8 KB y `.buffer` traería basura).
  const bytes = new TextEncoder().encode(cuerpo);
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(bytes.buffer),
    text: () => Promise.resolve(cuerpo),
  };
}

const PUNTOS: MapaPuntoPdfPayload[] = [
  {
    orden: 1,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    o_lat: 21.04,
    o_lon: -86.87,
    d_lat: 20.63,
    d_lon: -87.1,
    es_ferry: false,
  },
];

describe('PyservicesService — hoja de cotización (hoja.css / mapa-svg)', () => {
  let fetchSpy: jest.SpyInstance;
  afterEach(() => fetchSpy?.mockRestore());

  it('getCotizacionHojaCss: GET /reportes/cotizacion/hoja.css con X-Internal-Token, SIN body ni Content-Type; devuelve el CSS tal cual', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        respuesta(200, '.cot-hoja{font-family:Arimo}') as unknown as Response,
      );
    await expect(svc().getCotizacionHojaCss()).resolves.toBe(
      '.cot-hoja{font-family:Arimo}',
    );
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://py/reportes/cotizacion/hoja.css');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Internal-Token']).toBe('tok');
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('generateCotizacionMapaSvg: POST {mapa_puntos} y devuelve el <svg>; 204 (cuerpo vacío) → null', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        respuesta(200, '<svg viewBox="0 0 10 10"/>') as unknown as Response,
      )
      .mockResolvedValueOnce(respuesta(204, '') as unknown as Response);
    const s = svc();
    await expect(s.generateCotizacionMapaSvg(PUNTOS)).resolves.toBe(
      '<svg viewBox="0 0 10 10"/>',
    );
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://py/reportes/cotizacion/mapa-svg');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe(
      'tok',
    );
    expect(JSON.parse(init.body as string)).toEqual({ mapa_puntos: PUNTOS });

    await expect(s.generateCotizacionMapaSvg([])).resolves.toBeNull();
  });

  it('fallos: respuesta no-2xx → BadGateway con detalle; sin configuración → ServiceUnavailable (sin tocar la red)', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(respuesta(500, 'boom') as unknown as Response);
    await expect(svc().getCotizacionHojaCss()).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    await expect(svc().generateCotizacionMapaSvg(PUNTOS)).rejects.toThrow(
      /500: boom/,
    );
    fetchSpy.mockClear();
    await expect(svc(false).getCotizacionHojaCss()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('el POST heredado (preview-html) sigue mandando JSON con Content-Type por el mismo camino', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(respuesta(200, '<html/>') as unknown as Response);
    await expect(
      svc().generateCotizacionPreviewHtml({ folio: '1' }),
    ).resolves.toBe('<html/>');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://py/reportes/cotizacion/preview-html');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ folio: '1' });
  });
});
