// INICIO OFICIAL (16-oct-2026, invariante 86): Ingresos sube el `desde` (V)
// y su Excel es reporte (R). Anticipos «con saldo» sin periodo ni piso.
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import { HttpException } from '@nestjs/common';
import { IngresosService } from './ingresos.service';
import { ConciliacionService } from '../conciliacion/conciliacion.service';
import type { FlightsService } from '../flights/flights.service';
import type { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const conciliacion = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    g.supabase,
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  const svc = new IngresosService(
    g.supabase,
    {
      listCobros: jest.fn().mockResolvedValue([]),
    } as unknown as FlightsService,
    conciliacion,
    {} as TipoCambioService,
    { generateTablaXlsx: jest.fn() } as unknown as PyservicesService,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, ...g };
}

describe('IngresosService — inicio oficial', () => {
  it('resumen y entradas: el desde anterior sube y se devuelve subido', async () => {
    const g = armar(INICIO);
    const r = (await g.svc.resumen({
      desde: '2026-08-01',
      hasta: '2026-09-30',
    })) as unknown as { periodo?: { desde: string }; desde?: string };
    expect(r.periodo?.desde ?? r.desde).toBe(INICIO);
    const e = (await g.svc.entradas({
      desde: '2026-08-01',
      hasta: '2026-09-30',
      limit: 50,
      offset: 0,
    })) as unknown as { desde: string };
    expect(e.desde).toBe(INICIO);
    // Ninguna lectura de cobros/ingresos pidió agosto.
    const gtes = g.consultas.flatMap((c) =>
      c.ops.filter(
        (o) =>
          o.m === 'gte' &&
          (o.args[0] === 'fecha_cobro' || o.args[0] === 'fecha'),
      ),
    );
    expect(gtes.length).toBeGreaterThan(0);
    for (const o of gtes) expect(String(o.args[1]) >= INICIO).toBe(true);
  });

  it('con inicio null el periodo es el pedido (como 0.0.83)', async () => {
    const g = armar(null);
    const e = (await g.svc.entradas({
      desde: '2026-08-01',
      hasta: '2026-09-30',
      limit: 50,
      offset: 0,
    })) as unknown as { desde: string };
    expect(e.desde).toBe('2026-08-01');
  });

  it('anticipos con saldo: la lista de ingresos NO filtra por fecha', async () => {
    const g = armar(INICIO);
    await g.svc.lista({
      vista: 'anticipos',
      saldo: 'con_saldo',
      limit: 50,
      offset: 0,
    });
    const ing = g.de('ingreso');
    expect(ing.length).toBeGreaterThan(0);
    for (const c of ing) {
      expect(c.ops.some((o) => o.m === 'gte' && o.args[0] === 'fecha')).toBe(
        false,
      );
    }
  });

  it('Excel de un periodo anterior ⇒ 400 PERIODO_ANTES_DEL_INICIO', async () => {
    const g = armar(INICIO);
    try {
      await g.svc.exportXlsx({ desde: '2026-08-01', hasta: '2026-08-31' });
      throw new Error('no lanzó');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect(
        ((e as HttpException).getResponse() as { error: string }).error,
      ).toBe('PERIODO_ANTES_DEL_INICIO');
    }
  });
});
