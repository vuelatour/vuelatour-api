// COMPRAS FUERA DE GASTOS (6-nov-2026, API 0.0.122, invariante 118): el
// módulo Gastos manda `sin_compras=true` (los pagos de una compra de
// refacciones viven en Inventario/Tienda → Compras); la lista «Gastos de
// compras» manda `solo_compras=true`. Misma consulta única que pagina y cuenta.
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

describe('GET /v1/expenses — `sin_compras` (invariante 118)', () => {
  it.each([
    ['normal', {}],
    ['pendientes (bandeja sin avión)', { pendientes: true }],
    ['duplicados', { duplicados: true }],
    ['orden=captura', { orden: 'captura' }],
    [
      'con nómina fuera, categoría y fechas',
      {
        excluir_categoria: CategoriaGasto.NOMINA,
        categoria: CategoriaGasto.REFACCION,
        desde: '2026-11-01',
      },
    ],
  ])(
    '%s ⇒ la consulta que pagina Y cuenta (count exact) lleva is compra_id null',
    async (_n, over) => {
      const { svc, listas, lleva } = armar();
      await svc.list(
        q({ ...(over as Partial<ListGastosQuery>), sin_compras: true }),
      );
      const [lista] = listas();
      const select = lista.ops.find((o) => o.m === 'select')!;
      expect(select.args[1]).toEqual({ count: 'exact' });
      expect(lleva(lista, 'is', 'compra_id', null)).toBe(true);
      expect(
        lista.ops.some((o) => o.m === 'not' && o.args[0] === 'compra_id'),
      ).toBe(false);
    },
  );

  it('sin el parámetro, la consulta de siempre (sin is ni not sobre compra_id)', async () => {
    const { svc, listas } = armar();
    await svc.list(q());
    const ops = listas()[0].ops;
    expect(ops.some((o) => o.m === 'is' && o.args[0] === 'compra_id')).toBe(
      false,
    );
    expect(ops.some((o) => o.m === 'not' && o.args[0] === 'compra_id')).toBe(
      false,
    );
  });

  it('`solo_compras` ⇒ not(compra_id, is, null); con `sin_compras` también ⇒ lista vacía (los dos filtros, no 400)', async () => {
    const { svc, listas, lleva } = armar();
    await svc.list(q({ solo_compras: true }));
    expect(lleva(listas()[0], 'not', 'compra_id', 'is', null)).toBe(true);
    const b = armar();
    const r = await b.svc.list(q({ solo_compras: true, sin_compras: true }));
    expect(b.lleva(b.listas()[0], 'is', 'compra_id', null)).toBe(true);
    expect(b.lleva(b.listas()[0], 'not', 'compra_id', 'is', null)).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('con `compra_id` y `sin_compras` ⇒ eq + is null de lo mismo (lista vacía, no 400)', async () => {
    const { svc, listas, lleva } = armar();
    const id = 'ec571eb5-68fc-40a8-8605-0fd797057cca';
    const r = await svc.list(q({ compra_id: id, sin_compras: true }));
    expect(lleva(listas()[0], 'eq', 'compra_id', id)).toBe(true);
    expect(lleva(listas()[0], 'is', 'compra_id', null)).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('el Excel (`listParaXlsx`, paginado) lleva el filtro y el subtítulo lo dice', async () => {
    const { svc, gen, listas, lleva } = armar();
    await svc.listXlsx(
      q({
        excluir_categoria: CategoriaGasto.NOMINA,
        sin_compras: true,
        desde: '2026-11-01',
      }),
    );
    expect(listas().length).toBeGreaterThan(0);
    for (const l of listas()) {
      expect(lleva(l, 'is', 'compra_id', null)).toBe(true);
    }
    const payload = (gen.mock.calls as unknown[][])[0][0] as {
      subtitulo: string;
    };
    expect(payload.subtitulo).toMatch(
      / · 2026-11-01 a hoy · sin Nómina · sin compras de refacciones$/,
    );
    const b = armar();
    await b.svc.listXlsx(q({ solo_compras: true, desde: '2026-11-01' }));
    expect(
      ((b.gen.mock.calls as unknown[][])[0][0] as { subtitulo: string })
        .subtitulo,
    ).toMatch(/ · 2026-11-01 a hoy · solo compras de refacciones$/);
  });
});
