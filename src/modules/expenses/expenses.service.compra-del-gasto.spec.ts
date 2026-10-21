// Mismos stubs que expenses.service.inventario.spec.ts.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { ExpensesService } from './expenses.service';
import { CategoriaGasto, MedioPago, Moneda } from './dto/expenses.dto';
import type { CreateGastoDto } from './dto/expenses.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';

/**
 * `opts.compra` del alta (21-oct-2026, invariante 101): el gasto de una
 * compra nace ligado en el MISMO INSERT (`compra_id` + `compra_rol`); sin la
 * opción, el alta de siempre no nombra esas columnas.
 */
type Llamada = { metodo: string; args: unknown[] };

function armar() {
  const llamadas: Llamada[] = [];
  const supabase = {
    service: {
      from: (tabla: string) => {
        llamadas.push({ metodo: 'from', args: [tabla] });
        const q: Record<string, unknown> = {};
        const registra =
          (metodo: string) =>
          (...args: unknown[]) => {
            llamadas.push({ metodo, args });
            return q;
          };
        for (const m of [
          'select',
          'eq',
          'neq',
          'in',
          'is',
          'not',
          'or',
          'gte',
          'lte',
          'order',
          'range',
          'limit',
          'insert',
          'update',
        ]) {
          q[m] = registra(m);
        }
        q.maybeSingle = () =>
          Promise.resolve({
            data: {
              id: 'g-nuevo',
              monto: '722.90',
              moneda: 'USD',
              fecha_gasto: '2026-10-21',
              compra_id: 'c-1',
              compra_rol: 'MERCANCIA',
            },
            error: null,
          });
        q.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve);
        return q;
      },
    },
  } as unknown as SupabaseService;
  const notifications = {
    notifyRole: jest.fn().mockResolvedValue(undefined),
    notifyUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
  const nada = {} as never;
  const configuracion = { numero: jest.fn().mockResolvedValue(1) } as never;
  const service = new ExpensesService(
    supabase,
    notifications,
    nada,
    nada,
    configuracion,
    nada,
    nada,
  );
  return { service, llamadas };
}

const inserts = (llamadas: Llamada[]) =>
  llamadas
    .filter((l) => l.metodo === 'insert')
    .map((l) => l.args[0] as Record<string, unknown>);

function dto(extra: Partial<CreateGastoDto> = {}): CreateGastoDto {
  return {
    categoria: CategoriaGasto.REFACCION,
    monto: 722.9,
    moneda: Moneda.USD,
    tc_gasto: 18.25,
    fecha_gasto: '2026-10-21',
    medio_pago: MedioPago.TRANSFERENCIA,
    ...extra,
  };
}

describe('alta de gasto con `opts.compra` (invariante 101)', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-10-21T18:00:00Z')),
  );
  afterEach(() => jest.useRealTimers());

  it('el INSERT lleva compra_id + compra_rol juntos (CHECK gasto_compra_rol_chk) y sin avión', async () => {
    const { service, llamadas } = armar();
    const r = (await service.create(dto(), 'u-1', Rol.ADMIN, {
      compra: { id: 'c-1', rol: 'MERCANCIA' },
    })) as Record<string, unknown>;
    const fila = inserts(llamadas).find((i) => i.categoria === 'REFACCION');
    expect(fila).toMatchObject({
      compra_id: 'c-1',
      compra_rol: 'MERCANCIA',
      monto: 722.9,
      moneda: 'USD',
      tc_gasto: 18.25,
      medio_pago: 'TRANSFERENCIA',
    });
    expect(fila?.aeronave_id).toBeUndefined();
    expect(r.id).toBe('g-nuevo');
  });

  it('sin la opción, el alta de siempre NO nombra las columnas de la compra', async () => {
    const { service, llamadas } = armar();
    await service.create(dto(), 'u-1', Rol.ADMIN);
    const fila = inserts(llamadas).find((i) => i.categoria === 'REFACCION');
    expect(fila).toBeDefined();
    expect(fila).not.toHaveProperty('compra_id');
    expect(fila).not.toHaveProperty('compra_rol');
  });
});
