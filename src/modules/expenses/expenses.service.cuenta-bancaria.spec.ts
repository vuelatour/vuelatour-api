// Mismos stubs que expenses.service.spec.ts: notifications arrastra el
// gateway y `jose` (ESM puro), vision el SDK de IA y pyservices el cliente.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { HttpException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CategoriaGasto, MedioPago, Moneda } from './dto/expenses.dto';
import type { CreateGastoDto } from './dto/expenses.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';
import { Rol } from '../../common/types/auth.types';

type Fila = Record<string, unknown>;
type Llamada = { tabla: string; metodo: string; args: unknown[] };

const VUELO = '11111111-1111-4111-8111-111111111111';
const AVION = '33333333-3333-4333-8333-333333333333';
const HOY = new Date('2026-10-13T18:00:00Z'); // martes, 13:00 Cancún

function armar(
  opts: {
    vinculado?: Array<{ gasto_id: string; monto_vinculado: number }>;
    cuenta?: Fila | null;
  } = {},
) {
  const llamadas: Llamada[] = [];
  const supabase = {
    service: {
      from: (tabla: string) => {
        let op: 'select' | 'insert' | 'update' = 'select';
        let cuerpo: Fila | null = null;
        const q: Record<string, unknown> = {};
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
          'lt',
          'gt',
          'order',
          'range',
          'limit',
          'insert',
          'update',
        ]) {
          q[m] = (...args: unknown[]) => {
            llamadas.push({ tabla, metodo: m, args });
            if (m === 'insert') {
              op = 'insert';
              cuerpo = args[0] as Fila;
            }
            if (m === 'update') {
              op = 'update';
              cuerpo = args[0] as Fila;
            }
            return q;
          };
        }
        q.maybeSingle = () => {
          if (op === 'insert') {
            return Promise.resolve({
              data: { id: 'g-cta', conciliado: false, ...cuerpo },
              error: null,
            });
          }
          if (tabla === 'cuenta_bancaria') {
            return Promise.resolve({ data: opts.cuenta ?? null, error: null });
          }
          if (tabla === 'vuelo') {
            return Promise.resolve({
              data: { id: VUELO, folio: 412, aeronave_id: AVION },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        };
        q.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({
            data:
              tabla === 'v_gasto_conciliacion' ? (opts.vinculado ?? []) : [],
            error: null,
            count: 0,
          }).then(resolve);
        return q;
      },
    },
  } as unknown as SupabaseService;
  const notifications = {
    notifyRole: jest.fn().mockResolvedValue(undefined),
    notifyUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
  const intentarCruzarGasto = jest.fn().mockResolvedValue(undefined);
  const conciliacion = {
    intentarCruzarGasto,
  } as unknown as ConciliacionService;
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
    conciliacion,
  );
  const insertado = () =>
    llamadas.find((l) => l.metodo === 'insert' && l.tabla === 'gasto')
      ?.args[0] as Fila | undefined;
  return { service, llamadas, insertado, intentarCruzarGasto };
}

function dto(extra: Partial<CreateGastoDto> = {}): CreateGastoDto {
  return {
    categoria: CategoriaGasto.SERVICIOS,
    monto: 1499,
    moneda: Moneda.MXN,
    fecha_gasto: '2026-10-13',
    medio_pago: MedioPago.TRANSFERENCIA,
    aeronave_id: AVION,
    notas: 'Pago VIP SAESA fact 7360',
    ...extra,
  };
}

async function rebote(p: Promise<unknown>) {
  try {
    await p;
    throw new Error('no rebotó');
  } catch (e) {
    const err = e as HttpException;
    return {
      status: err.getStatus(),
      body: err.getResponse() as { message?: string; error?: string },
    };
  }
}

const CUENTA = '44444444-4444-4444-8444-444444444444';

describe('ExpensesService — cuenta de donde salió el pago (20-oct-2026, invariante 98)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('TRANSFERENCIA con cuenta activa: la guarda', async () => {
    const { service, insertado } = armar({
      cuenta: { id: CUENTA, alias: 'HSBC Pesos', activa: true },
    });
    await service.create(
      dto({ cuenta_bancaria_id: CUENTA }),
      'u-oficina',
      Rol.ADMIN,
      { notificar: false },
    );
    expect(insertado()).toMatchObject({
      medio_pago: 'TRANSFERENCIA',
      cuenta_bancaria_id: CUENTA,
    });
  });

  it('PAYWISE y DOMICILIADO también la guardan', async () => {
    for (const medio of [MedioPago.PAYWISE, MedioPago.DOMICILIADO]) {
      const { service, insertado } = armar({
        cuenta: { id: CUENTA, alias: 'Paywise', activa: true },
      });
      await service.create(
        dto({ medio_pago: medio, cuenta_bancaria_id: CUENTA }),
        'u-oficina',
        Rol.ADMIN,
        { notificar: false },
      );
      expect(insertado()).toMatchObject({ cuenta_bancaria_id: CUENTA });
    }
  });

  it('con un medio que no lleva cuenta (efectivo, tarjeta) la llave NO viaja ni se consulta la cuenta', async () => {
    for (const medio of [MedioPago.EFECTIVO, MedioPago.TARJETA_CORP]) {
      const { service, insertado, llamadas } = armar();
      await service.create(
        dto({ medio_pago: medio, cuenta_bancaria_id: CUENTA }),
        'u-oficina',
        Rol.ADMIN,
        { notificar: false },
      );
      expect(insertado()).not.toHaveProperty('cuenta_bancaria_id');
      expect(llamadas.some((l) => l.tabla === 'cuenta_bancaria')).toBe(false);
    }
  });

  it('sin cuenta: la llave no viaja (el alta de siempre)', async () => {
    const { service, insertado } = armar();
    await service.create(dto(), 'u-oficina', Rol.ADMIN, { notificar: false });
    expect(insertado()).not.toHaveProperty('cuenta_bancaria_id');
  });

  it('cuenta que no existe ⇒ 400 CUENTA_BANCARIA_NO_EXISTE sin insertar', async () => {
    const { service, insertado } = armar({ cuenta: null });
    const r = await rebote(
      service.create(dto({ cuenta_bancaria_id: CUENTA }), 'u', Rol.ADMIN, {
        notificar: false,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('CUENTA_BANCARIA_NO_EXISTE');
    expect(insertado()).toBeUndefined();
  });

  it('cuenta dada de baja ⇒ 400 CUENTA_BANCARIA_INACTIVA con su alias', async () => {
    const { service, insertado } = armar({
      cuenta: { id: CUENTA, alias: 'SCOTIA USD', activa: false },
    });
    const r = await rebote(
      service.create(dto({ cuenta_bancaria_id: CUENTA }), 'u', Rol.ADMIN, {
        notificar: false,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('CUENTA_BANCARIA_INACTIVA');
    expect(r.body.message).toBe(
      'La cuenta «SCOTIA USD» está dada de baja: elige otra.',
    );
    expect(insertado()).toBeUndefined();
  });
});
