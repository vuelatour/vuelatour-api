// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { Logger } from '@nestjs/common';
import { ProfitSharingService } from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';

/**
 * PRE-CIERRE · MOVIMIENTOS DEL BANCO OMITIDOS DE LA CONCILIACIÓN
 * (14-oct-2026, API 0.0.77, invariante 75). Renglón INFORMATIVO justo
 * después de `sin_conciliar`: NO entra a `bloqueantes` (`listo` no cambia) y
 * una lectura que falla —null, excepción o un stub viejo sin el método— sale
 * con `lectura_fallida`. Fake: BD vacía (cualquier consulta responde []).
 */
type Fila = Record<string, unknown>;

function bdVacia(): SupabaseService {
  const consulta = (): unknown => {
    const q: Record<string | symbol, unknown> = {};
    const proxy: unknown = new Proxy(q, {
      get(_t, prop) {
        if (prop === 'then') {
          return (
            res: (v: unknown) => unknown,
            rej?: (e: unknown) => unknown,
          ) =>
            Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => Promise.resolve({ data: null, error: null });
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return { service: { from: () => consulta() } } as unknown as SupabaseService;
}

function armar(conciliacion: Partial<Record<string, unknown>>) {
  const conc = {
    cobrosSinBanco: jest
      .fn()
      .mockResolvedValue({ data: [], total: 0, por_moneda: [] }),
    ...conciliacion,
  } as unknown as ConciliacionService;
  const nada = {} as never;
  return new ProfitSharingService(bdVacia(), nada, nada, conc);
}

const PERIODO = { desde: '2026-09-01', hasta: '2026-09-30' };
const CLAVE = 'movimientos_omitidos';

interface Respuesta {
  listo: boolean;
  items: Fila[];
}

describe('ProfitSharingService.preCierre — movimientos omitidos', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('va justo después de sin_conciliar, informativo, con montos por moneda; `listo` no cambia', async () => {
    const omitidosDelPeriodo = jest
      .fn()
      .mockResolvedValue({ count: 3, monto_mxn: 1234.5, monto_usd: 10 });
    const svc = armar({ omitidosDelPeriodo });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const claves = r.items.map((i) => i.clave);
    const i = claves.indexOf('sin_conciliar');
    expect(claves[i + 1]).toBe(CLAVE);
    expect(r.items[i + 1]).toEqual({
      clave: CLAVE,
      titulo: 'Movimientos del banco omitidos de la conciliación',
      detalle:
        '3 movimientos del banco se marcaron como «no se concilian» con un motivo ($1,234.50 MXN + $10.00 USD): revisa en Conciliación → Omitidos que ninguno sea un gasto sin capturar.',
      count: 3,
      monto_mxn: 1234.5,
      monto_usd: 10,
      informativo: true,
    });
    expect(omitidosDelPeriodo).toHaveBeenCalledWith('2026-09-01', '2026-09-30');
    expect(r.listo).toBe(true);
  });

  it('sin omitidos: count 0, sin `lectura_fallida`', async () => {
    const svc = armar({
      omitidosDelPeriodo: jest
        .fn()
        .mockResolvedValue({ count: 0, monto_mxn: 0, monto_usd: 0 }),
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const item = r.items.find((x) => x.clave === CLAVE)!;
    expect(item).toMatchObject({ count: 0, informativo: true });
    expect(item).not.toHaveProperty('lectura_fallida');
  });

  it.each([
    ['null', jest.fn().mockResolvedValue(null)],
    ['excepción', jest.fn().mockRejectedValue(new Error('caída'))],
    ['método ausente (stub viejo)', undefined],
  ])('%s ⇒ lectura_fallida con su texto', async (_n, metodo) => {
    const svc = armar(metodo ? { omitidosDelPeriodo: metodo } : {});
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(r.items.find((x) => x.clave === CLAVE)).toEqual({
      clave: CLAVE,
      titulo: 'Movimientos del banco omitidos de la conciliación',
      detalle: 'No se pudo leer cuántos movimientos se omitieron.',
      count: 0,
      monto_mxn: 0,
      monto_usd: 0,
      informativo: true,
      lectura_fallida: true,
    });
    expect(r.listo).toBe(true);
  });
});
