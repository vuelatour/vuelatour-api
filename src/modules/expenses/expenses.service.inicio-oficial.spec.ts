// INICIO OFICIAL (16-oct-2026, invariante 86): piso de la tabla de gastos
// (bandeja, captura, Excel), IA de la bandeja, Otros gastos/Nómina y pistas.
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
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const svc = new ExpensesService(
    g.supabase,
    {} as NotificationsService,
    {} as PyservicesService,
    {} as VisionService,
    cfgInicio(inicio) as unknown as ConfiguracionService,
    {} as CajaChicaService,
    {} as IaUsoService,
  );
  /** La consulta PRINCIPAL de la lista (la que pagina). */
  const lista = () =>
    g.de('gasto').find((c) => c.ops.some((o) => o.m === 'range'))!;
  return { svc, lista, ...g };
}

const q = (over: Partial<ListGastosQuery> = {}): ListGastosQuery => ({
  limit: 50,
  offset: 0,
  ...over,
});

describe('ExpensesService — inicio oficial', () => {
  it.each([
    ['normal', {}],
    ['pendientes (bandeja sin avión)', { pendientes: true }],
    ['orden=captura', { orden: 'captura' }],
    ['por fecha de captura', { capturado_desde: '2026-08-01' }],
    ['duplicados', { duplicados: true }],
  ])('list %s ⇒ gte fecha_gasto inicio', async (_n, over) => {
    const { svc, lista, lleva } = armar(INICIO);
    await svc.list(q(over as Partial<ListGastosQuery>));
    expect(lleva(lista(), 'gte', 'fecha_gasto', INICIO)).toBe(true);
  });

  it('desde anterior sube; desde ≥ inicio intacto', async () => {
    const a = armar(INICIO);
    await a.svc.list(q({ desde: '2026-08-10' }));
    expect(a.lleva(a.lista(), 'gte', 'fecha_gasto', INICIO)).toBe(true);
    const b = armar(INICIO);
    await b.svc.list(q({ desde: '2026-09-15' }));
    expect(b.lleva(b.lista(), 'gte', 'fecha_gasto', '2026-09-15')).toBe(true);
  });

  it.each([
    ['vuelo_id (detalle del vuelo)', { vuelo_id: 'v1' }],
    ['compra_id (pagos de una compra)', { compra_id: 'c1' }],
  ])('con %s NO hay piso (registro abierto por id)', async (_n, over) => {
    const { svc, lista } = armar(INICIO);
    await svc.list(q(over));
    expect(lista().ops.some((o) => o.m === 'gte')).toBe(false);
  });

  it('inicio null ⇒ sin gte (como 0.0.83)', async () => {
    const { svc, lista } = armar(null);
    await svc.list(q());
    expect(lista().ops.some((o) => o.m === 'gte')).toBe(false);
  });

  it('IA «sugerir asignación» de la bandeja: solo gastos ≥ inicio', async () => {
    const { svc, de, lleva } = armar(INICIO);
    await svc.sugerirAsignaciones();
    expect(lleva(de('gasto')[0], 'gte', 'fecha_gasto', INICIO)).toBe(true);
  });

  it('Otros gastos / Nómina de un mes anterior ⇒ vacío sin consultar', async () => {
    const { svc, de } = armar(INICIO);
    await expect(
      svc.listOtrosGastos('2026-08-01', '2026-08-31'),
    ).resolves.toEqual({
      periodo: { desde: INICIO, hasta: '2026-08-31' },
      data: [],
      resumen: [],
    });
    expect(de('gasto')).toHaveLength(0);
  });

  it('Otros gastos que cruza el inicio ⇒ periodo subido', async () => {
    const { svc, de, lleva } = armar(INICIO);
    const r = await svc.listOtrosGastos('2026-08-20', '2026-09-30');
    expect(r.periodo).toEqual({ desde: INICIO, hasta: '2026-09-30' });
    expect(
      lleva(
        de('gasto').find((c) => c.ops.some((o) => o.m === 'in'))!,
        'gte',
        'fecha_gasto',
        INICIO,
      ),
    ).toBe(true);
  });

  it('Revisión: el subtítulo del Excel dice el periodo SUBIDO (no el pedido)', async () => {
    const subtitulo = async (
      inicio: string | null,
      over: Partial<ListGastosQuery>,
    ): Promise<string> => {
      const g = supabaseGrabador();
      const gen = jest.fn().mockResolvedValue(Buffer.from('x'));
      const svc = new ExpensesService(
        g.supabase,
        {} as NotificationsService,
        { generateTablaXlsx: gen } as unknown as PyservicesService,
        {} as VisionService,
        cfgInicio(inicio) as unknown as ConfiguracionService,
        {} as CajaChicaService,
        {} as IaUsoService,
      );
      await svc.listXlsx(q(over));
      const llamada = gen.mock.calls[0] as unknown as [{ subtitulo: string }];
      return llamada[0].subtitulo;
    };
    expect(
      await subtitulo(INICIO, { desde: '2026-08-01', hasta: '2026-09-30' }),
    ).toContain(' · 2026-09-01 a 2026-09-30');
    expect(await subtitulo(INICIO, {})).toContain(' · 2026-09-01 a hoy');
    // Sin inicio y sin rango: el subtítulo de siempre (sin «·»).
    expect(await subtitulo(null, {})).not.toContain(' · ');
    // Con vuelo: sin piso, el pedido tal cual.
    expect(
      await subtitulo(INICIO, { vuelo_id: 'v1', desde: '2026-08-01' }),
    ).toContain(' · 2026-08-01 a hoy');
  });

  it('pistas pendientes de un periodo anterior ⇒ vacío', async () => {
    const { svc, consultas } = armar(INICIO);
    await expect(
      svc.pistasPendientes('2026-08-01', '2026-08-31'),
    ).resolves.toEqual({ data: [] });
    expect(consultas).toHaveLength(0);
  });
});
