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
import {
  DETALLE_PRECIERRE_LIGAS_USD_TC,
  DETALLE_PRECIERRE_LIGAS_USD_TC_FALLIDA,
} from './ligas-usd-tc-precierre.util';

/**
 * PRE-CIERRE · GASTOS EN DÓLARES CON UN T.C. FUERA DE LUGAR (13-oct-2026,
 * invariante 70). El renglón va JUSTO después de
 * `gastos_bancarios_sin_conciliar`, NO bloquea (`listo` no cambia) y una
 * lectura que falla —null, excepción o un stub viejo sin el método— sale
 * «sin verificar» (`lectura_fallida`). Fake: BD vacía (cualquier consulta
 * responde []).
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
const CLAVE = 'gastos_usd_tc_fuera_de_lugar';

interface Respuesta {
  listo: boolean;
  items: Fila[];
}

const LIGAS = [{ gasto_id: 'tubo' }, { gasto_id: 'bujias' }];

describe('ProfitSharingService.preCierre — ligas USD con T.C. fuera de lugar', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('va justo después de gastos_bancarios_sin_conciliar, con count 2, y `listo` no cambia', async () => {
    const ligasUsdTcFueraDeLugar = jest
      .fn()
      .mockResolvedValue({ ligas: LIGAS, sin_verificar: 0 });
    const svc = armar({ ligasUsdTcFueraDeLugar });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const claves = r.items.map((i) => i.clave);
    const i = claves.indexOf('gastos_bancarios_sin_conciliar');
    expect(claves[i + 1]).toBe(CLAVE);
    expect(claves[i + 2]).toBe('cobros_bancarios_sin_conciliar');
    expect(r.items[i + 1]).toMatchObject({
      count: 2,
      ligas: LIGAS,
      sin_verificar: 0,
      lectura_fallida: false,
      detalle: DETALLE_PRECIERRE_LIGAS_USD_TC,
    });
    expect(ligasUsdTcFueraDeLugar).toHaveBeenCalledWith(
      '2026-09-01',
      '2026-09-30',
    );
    // NO bloquea: con la BD vacía y 2 ligas el cierre sigue «listo».
    expect(r.listo).toBe(true);
  });

  it.each([
    ['null', jest.fn().mockResolvedValue(null)],
    ['excepción', jest.fn().mockRejectedValue(new Error('caída'))],
    ['método ausente (stub viejo)', undefined],
  ])('%s ⇒ lectura_fallida con su texto', async (_n, metodo) => {
    const svc = armar(metodo ? { ligasUsdTcFueraDeLugar: metodo } : {});
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(r.items.find((x) => x.clave === CLAVE)).toMatchObject({
      count: 0,
      lectura_fallida: true,
      detalle: DETALLE_PRECIERRE_LIGAS_USD_TC_FALLIDA,
    });
    expect(r.listo).toBe(true);
  });

  it('solo sin_verificar ⇒ lectura_fallida con el texto de los no revisados', async () => {
    const svc = armar({
      ligasUsdTcFueraDeLugar: jest
        .fn()
        .mockResolvedValue({ ligas: [], sin_verificar: 2 }),
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(r.items.find((x) => x.clave === CLAVE)).toMatchObject({
      count: 0,
      sin_verificar: 2,
      lectura_fallida: true,
      detalle:
        'No se pudo revisar el tipo de cambio de 2 gastos en dólares conciliados: no hay T.C. oficial del día de su cargo. Vuelve a abrir el pre-cierre más tarde.',
    });
  });
});
