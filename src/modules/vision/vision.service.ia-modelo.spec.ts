// ComprasService importa InventoryService (⇒ realtime ⇒ `jose`, ESM que jest
// no transforma): para probar su llamada a pyservices basta un stub.
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));

import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { InventoryService } from '../inventory/inventory.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import { ComprasService } from '../inventory/compras.service';
import { ConciliacionService } from '../conciliacion/conciliacion.service';
import { ExpirationsClient } from '../expirations/expirations.client';
import { VisionService } from './vision.service';

/**
 * MODELO DE IA (2-oct-2026): las lecturas con IA NO pasan por
 * `PyservicesService` (visión de tickets/tacómetros, vencimientos, compras y
 * conciliación llaman a pyservices directo), así que cada cliente pone el
 * header `X-IA-Modelo` por su cuenta con `ConfiguracionService.headersModeloIa`.
 * Sin modelo configurado (o sin el service), la petición es la de siempre.
 */
const config = {
  get: (k: string) => {
    if (k === 'PYSERVICES_BASE_URL') return 'http://py/';
    if (k === 'INTERNAL_SHARED_TOKEN') return 'tok';
    return 30000;
  },
} as unknown as ConfigService<EnvVars, true>;

const iaUso = { registrar: jest.fn() } as unknown as IaUsoService;

function cfg(modelo: string | null): ConfiguracionService {
  return {
    headersModeloIa: jest
      .fn()
      .mockResolvedValue(modelo ? { 'X-IA-Modelo': modelo } : {}),
  } as unknown as ConfiguracionService;
}

function ok(cuerpo: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(cuerpo),
    text: () => Promise.resolve(JSON.stringify(cuerpo)),
  } as unknown as Response;
}

const headersDe = (spy: jest.SpyInstance, i = 0) =>
  (spy.mock.calls[i] as [string, RequestInit])[1].headers as Record<
    string,
    string
  >;

describe('Clientes directos de IA — header X-IA-Modelo', () => {
  let fetchSpy: jest.SpyInstance;
  afterEach(() => fetchSpy?.mockRestore());

  it('VisionService (tacómetro): con modelo configurado viaja el header junto al token', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ lectura: 1234.5, confianza: 0.9 }));
    const v = new VisionService(config, iaUso, cfg('claude-sonnet-5'));
    v.onModuleInit();
    await v.readTacometro({ imageBase64: 'AAAA', mediaType: 'image/png' });
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('http://py/vision/tacometro');
    expect(headersDe(fetchSpy)).toEqual({
      'Content-Type': 'application/json',
      'X-Internal-Token': 'tok',
      'X-IA-Modelo': 'claude-sonnet-5',
    });
  });

  it('VisionService: sin modelo o sin ConfiguracionService ⇒ headers de siempre', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ lectura: 1, confianza: 0.9 }));
    for (const v of [
      new VisionService(config, iaUso, cfg(null)),
      new VisionService(config, iaUso),
    ]) {
      v.onModuleInit();
      await v.readTacometro({ imageBase64: 'AAAA', mediaType: 'image/png' });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      expect(headersDe(fetchSpy, i)).toEqual({
        'Content-Type': 'application/json',
        'X-Internal-Token': 'tok',
      });
    }
  });

  it('ExpirationsClient (vencimientos): el header viaja solo con modelo configurado', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ confianza: 0.5, notas: '', modelo: 'x' }));
    const con = new ExpirationsClient(config, cfg('claude-haiku-4-5-20251001'));
    con.onModuleInit();
    await con.extraer({ pdfBase64: 'JVBERi0=' });
    const sin = new ExpirationsClient(config);
    sin.onModuleInit();
    await sin.extraer({ pdfBase64: 'JVBERi0=' });
    expect(headersDe(fetchSpy, 0)['X-IA-Modelo']).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(headersDe(fetchSpy, 1)['X-IA-Modelo']).toBeUndefined();
    expect(headersDe(fetchSpy, 1)['X-Internal-Token']).toBe('tok');
  });
});

/**
 * Compras y conciliación también llaman a pyservices DIRECTO (revisión del
 * 2-oct-2026: solo visión y vencimientos tenían prueba). Una regresión en
 * cualquiera de estas llamadas mandaría esa lectura al modelo del servidor
 * sin que nadie lo note.
 */
type ConciliacionPrivada = {
  candidatosCercanos: (...a: unknown[]) => Promise<unknown[]>;
  cargarCtxCruce: () => Promise<{ terminaciones: string[] }>;
  sugerirDeMovimiento: (
    m: Record<string, unknown>,
    userId?: string,
  ) => Promise<{ disponible: boolean }>;
  llamarSugerirAbonos: (
    baseUrl: string,
    token: string,
    lote: unknown[],
    porAbono: unknown[][],
    cand: Map<string, unknown>,
    userId: string,
  ) => Promise<{ ok: boolean }>;
};

describe('Clientes directos de IA — compras y conciliación', () => {
  let fetchSpy: jest.SpyInstance;
  afterEach(() => fetchSpy?.mockRestore());

  const supabase = {} as unknown as SupabaseService;
  const conciliacion = (c?: ConfiguracionService) =>
    new ConciliacionService(
      config,
      supabase,
      {} as unknown as PyservicesService,
      iaUso,
      c,
    );

  it('ComprasService (/compras/extraer): con modelo viaja el header; sin modelo o sin el service, los headers de siempre', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(ok({ lineas: [] })));
    const inventory = {} as unknown as InventoryService;
    for (const c of [cfg('claude-sonnet-4-6'), cfg(null), undefined]) {
      await new ComprasService(config, supabase, inventory, iaUso, c).extraer({
        pdf_base64: 'JVBERi0=',
      });
    }
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('http://py/compras/extraer');
    expect(headersDe(fetchSpy, 0)).toEqual({
      'Content-Type': 'application/json',
      'X-Internal-Token': 'tok',
      'X-IA-Modelo': 'claude-sonnet-4-6',
    });
    for (const i of [1, 2]) {
      expect(headersDe(fetchSpy, i)).toEqual({
        'Content-Type': 'application/json',
        'X-Internal-Token': 'tok',
      });
    }
  });

  it('ConciliacionService.parse (/conciliacion/parse): el header viaja solo con modelo configurado', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(ok({ movimientos: [] })));
    const dto = { filename: 'edo.pdf', file_base64: 'JVBERi0=' };
    await conciliacion(cfg('claude-sonnet-4-6')).parse(dto);
    await conciliacion(cfg(null)).parse(dto);
    await conciliacion().parse(dto);
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('http://py/conciliacion/parse');
    expect(headersDe(fetchSpy, 0)['X-IA-Modelo']).toBe('claude-sonnet-4-6');
    for (const i of [1, 2]) {
      expect(headersDe(fetchSpy, i)).toEqual({
        'Content-Type': 'application/json',
        'X-Internal-Token': 'tok',
      });
    }
  });

  it('ConciliacionService sugerir (/conciliacion/sugerir): el header viaja solo con modelo configurado', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          ok({ gasto_id_sugerido: 'g1', confianza: 0.9, razon: 'monto' }),
        ),
      );
    const mov = {
      id: 'm1',
      fecha: '2026-10-01',
      monto: -825.13,
      tipo: 'CARGO',
      descripcion: 'ASUR CANCUN',
      referencia: null,
      cuenta: { alias: 'GASTOS GNRAL', banco: 'Scotiabank', moneda: 'MXN' },
    };
    for (const c of [cfg('claude-sonnet-4-6'), cfg(null), undefined]) {
      const svc = conciliacion(c) as unknown as ConciliacionPrivada;
      jest
        .spyOn(svc, 'candidatosCercanos')
        .mockResolvedValue([{ id: 'g1', monto: 825.13 }]);
      jest
        .spyOn(svc, 'cargarCtxCruce')
        .mockResolvedValue({ terminaciones: [] });
      const r = await svc.sugerirDeMovimiento(mov, 'u1');
      expect(r.disponible).toBe(true);
    }
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('http://py/conciliacion/sugerir');
    expect(headersDe(fetchSpy, 0)['X-IA-Modelo']).toBe('claude-sonnet-4-6');
    for (const i of [1, 2]) {
      expect(headersDe(fetchSpy, i)).toEqual({
        'Content-Type': 'application/json',
        'X-Internal-Token': 'tok',
      });
    }
  });

  it('ConciliacionService sugerir-abonos (/conciliacion/sugerir-abonos): el header viaja solo con modelo configurado', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(ok({ sugerencias: [] })));
    for (const c of [cfg('claude-sonnet-4-6'), cfg(null), undefined]) {
      const svc = conciliacion(c) as unknown as ConciliacionPrivada;
      const r = await svc.llamarSugerirAbonos(
        'http://py',
        'tok',
        [],
        [],
        new Map(),
        'u1',
      );
      expect(r.ok).toBe(true);
    }
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('http://py/conciliacion/sugerir-abonos');
    expect(headersDe(fetchSpy, 0)['X-IA-Modelo']).toBe('claude-sonnet-4-6');
    for (const i of [1, 2]) {
      expect(headersDe(fetchSpy, i)).toEqual({
        'Content-Type': 'application/json',
        'X-Internal-Token': 'tok',
      });
    }
  });
});
