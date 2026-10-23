// «OTROS MOVIMIENTOS (VUELATOUR)» (23-oct-2026, API 0.0.106, invariante 107):
// un egreso de VuelaTour NUNCA es «pendiente de asignarle avión». La bandeja
// `?pendientes=1` y «Sugerir asignaciones» (como la alerta diaria y el
// pre-cierre) excluyen la categoría por la fuente única
// `CATEGORIAS_GASTO_SIN_AVION`, que viaja como literal `not.in(...)`.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));

import { ExpensesService } from './expenses.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { CajaChicaService } from '../caja-chica/caja-chica.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import type { ListGastosQuery } from './dto/expenses.dto';
import { CATEGORIAS_GASTO_SIN_AVION } from '../../common/categoria-gasto.util';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

function armar() {
  const g = supabaseGrabador();
  const svc = new ExpensesService(
    g.supabase,
    {} as NotificationsService,
    { generateTablaXlsx: jest.fn() } as unknown as PyservicesService,
    {} as VisionService,
    cfgInicio(null) as unknown as ConfiguracionService,
    {} as CajaChicaService,
    {} as IaUsoService,
  );
  return { svc, ...g };
}

type Consulta = ReturnType<ReturnType<typeof supabaseGrabador>['de']>[number];

/** El literal `(A,B,…)` del `not('categoria', 'in', …)` de una consulta. */
const notInCategoria = (c: Consulta): string | undefined =>
  c.ops.find(
    (o) => o.m === 'not' && o.args[0] === 'categoria' && o.args[1] === 'in',
  )?.args[2] as string | undefined;

const LITERAL = `(${CATEGORIAS_GASTO_SIN_AVION.join(',')})`;

describe('OTROS_MOVIMIENTOS nunca es «pendiente de avión» (invariante 107)', () => {
  it('la fuente única lo trae (y, a propósito, no a la «Comisión del vendedor (avión)»)', () => {
    expect(CATEGORIAS_GASTO_SIN_AVION).toContain('OTROS_MOVIMIENTOS');
    expect(CATEGORIAS_GASTO_SIN_AVION).not.toContain('COMISION_VENDEDOR_AVION');
  });

  it('GET /v1/expenses?pendientes=1: el not.in(...) de la bandeja es exactamente la lista (con OTROS_MOVIMIENTOS)', async () => {
    const { svc, de } = armar();
    const q: ListGastosQuery = { limit: 50, offset: 0, pendientes: true };
    await svc.list(q);
    const literales = de('gasto')
      .map(notInCategoria)
      .filter((x): x is string => !!x);
    expect(literales.length).toBeGreaterThan(0);
    for (const l of literales) {
      expect(l).toBe(LITERAL);
      expect(l).toContain('OTROS_MOVIMIENTOS');
    }
  });

  it('POST /v1/expenses/sugerir-asignaciones: el MISMO universo (no gasta IA en un egreso de VuelaTour)', async () => {
    const { svc, de } = armar();
    await svc.sugerirAsignaciones();
    const literales = de('gasto')
      .map(notInCategoria)
      .filter((x): x is string => !!x);
    expect(literales).toEqual([LITERAL]);
  });
});
