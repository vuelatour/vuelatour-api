// NÓMINA FUERA DE GASTOS (16-oct-2026, API 0.0.90, invariante 91): el
// módulo Gastos manda `excluir_categoria=NOMINA`; «Otros gastos» ya no lee
// la NÓMINA.
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
import { CategoriaGasto, type ListGastosQuery } from './dto/expenses.dto';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

function armar() {
  const g = supabaseGrabador();
  const gen = jest.fn().mockResolvedValue(Buffer.from('x'));
  const svc = new ExpensesService(
    g.supabase,
    {} as NotificationsService,
    { generateTablaXlsx: gen } as unknown as PyservicesService,
    {} as VisionService,
    cfgInicio(null) as unknown as ConfiguracionService,
    {} as CajaChicaService,
    {} as IaUsoService,
  );
  /** Las consultas PRINCIPALES de la lista (las que paginan y cuentan). */
  const listas = () =>
    g.de('gasto').filter((c) => c.ops.some((o) => o.m === 'range'));
  return { svc, gen, listas, ...g };
}

const q = (over: Partial<ListGastosQuery> = {}): ListGastosQuery => ({
  limit: 50,
  offset: 0,
  ...over,
});
const NOMINA = CategoriaGasto.NOMINA;

describe('GET /v1/expenses — `excluir_categoria` (invariante 91)', () => {
  it.each([
    ['normal', {}],
    ['pendientes (bandeja sin avión)', { pendientes: true }],
    ['duplicados', { duplicados: true }],
    ['orden=captura', { orden: 'captura' }],
    [
      'con categoría y fechas',
      { categoria: CategoriaGasto.OTRO, desde: '2026-10-01' },
    ],
  ])(
    '%s ⇒ la consulta que pagina Y cuenta (count exact) lleva neq categoria NOMINA',
    async (_n, over) => {
      const { svc, listas, lleva } = armar();
      await svc.list(
        q({ ...(over as Partial<ListGastosQuery>), excluir_categoria: NOMINA }),
      );
      const [lista] = listas();
      const select = lista.ops.find((o) => o.m === 'select')!;
      expect(select.args[1]).toEqual({ count: 'exact' });
      expect(lleva(lista, 'neq', 'categoria', 'NOMINA')).toBe(true);
    },
  );

  it('sin el parámetro, la consulta de siempre (sin neq de categoría)', async () => {
    const { svc, listas } = armar();
    await svc.list(q());
    expect(
      listas()[0].ops.some((o) => o.m === 'neq' && o.args[0] === 'categoria'),
    ).toBe(false);
  });

  it('con `categoria` = `excluir_categoria` ⇒ eq + neq de lo mismo (lista vacía en PostgREST, no 400)', async () => {
    const { svc, listas, lleva } = armar();
    const r = await svc.list(
      q({ categoria: NOMINA, excluir_categoria: NOMINA }),
    );
    expect(lleva(listas()[0], 'eq', 'categoria', 'NOMINA')).toBe(true);
    expect(lleva(listas()[0], 'neq', 'categoria', 'NOMINA')).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('el Excel (`listParaXlsx`, paginado) lleva el filtro y el subtítulo dice «sin Nómina»', async () => {
    const { svc, gen, listas, lleva } = armar();
    await svc.listXlsx(q({ excluir_categoria: NOMINA, desde: '2026-10-01' }));
    expect(listas().length).toBeGreaterThan(0);
    for (const l of listas()) {
      expect(lleva(l, 'neq', 'categoria', 'NOMINA')).toBe(true);
    }
    const payload = (gen.mock.calls as unknown[][])[0][0] as {
      subtitulo: string;
    };
    expect(payload.subtitulo).toMatch(/ · 2026-10-01 a hoy · sin Nómina$/);
    // Sin el parámetro, el subtítulo de siempre.
    const b = armar();
    await b.svc.listXlsx(q({ desde: '2026-10-01' }));
    expect(
      ((b.gen.mock.calls as unknown[][])[0][0] as { subtitulo: string })
        .subtitulo,
    ).not.toContain('sin ');
  });
});

describe('Otros gastos — la NÓMINA ya no se lee aquí (invariante 91)', () => {
  it('el `in` de categorías es OTRO/FIJO/INDIRECTO/GASOLINA/VISITA', async () => {
    const { svc, de } = armar();
    await svc.listOtrosGastos('2026-10-01', '2026-10-31');
    const consulta = de('gasto').find((c) => c.ops.some((o) => o.m === 'in'))!;
    const filtro = consulta.ops.find(
      (o) => o.m === 'in' && o.args[0] === 'categoria',
    )!;
    expect(filtro.args[1]).toEqual([
      'OTRO',
      'FIJO',
      'INDIRECTO',
      'GASOLINA',
      'VISITA',
    ]);
  });
});
