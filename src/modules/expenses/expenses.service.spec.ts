// Módulos pesados que expenses.service importa solo para inyección: se
// sustituyen por clases vacías — notifications arrastra el gateway y `jose`
// (ESM puro, jest no lo transforma); mismo patrón que quotes.service.spec.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { BadRequestException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CategoriaGasto, MedioPago, Moneda } from './dto/expenses.dto';
import type { CreateGastoDto, ListGastosQuery } from './dto/expenses.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';

/**
 * `gasto.capturado_en` (7-sep-2026) en el service: el listado lo EXPONE (y
 * filtra/ordena por él), el alta lo sella con el valor de la app o con
 * "ahora". Supabase se simula con un builder encadenable que registra las
 * llamadas — aquí no se prueba la BD, sino el contrato del service.
 */
type Resultado = { data: unknown; error: null | { message: string } };
type Llamada = { metodo: string; args: unknown[] };

function consulta(resultado: Resultado, llamadas: Llamada[]) {
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
  q.maybeSingle = () => Promise.resolve(resultado);
  q.then = (
    resolve: (v: Resultado) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(resultado).then(resolve, reject);
  return q;
}

function armar(tablas: Record<string, Resultado>) {
  const llamadas: Llamada[] = [];
  const supabase = {
    service: {
      from: (tabla: string) => {
        llamadas.push({ metodo: 'from', args: [tabla] });
        return consulta(tablas[tabla] ?? { data: [], error: null }, llamadas);
      },
    },
  } as unknown as SupabaseService;
  const notifications = {
    notifyRole: jest.fn().mockResolvedValue(undefined),
    notifyUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
  const nada = {} as never;
  const service = new ExpensesService(
    supabase,
    notifications,
    nada,
    nada,
    nada,
    nada,
    nada,
  );
  return { service, llamadas };
}

const filtrosBase: ListGastosQuery = { limit: 50, offset: 0 };

describe('ExpensesService.list — capturado_en', () => {
  it('el select del listado incluye capturado_en (panel, otros gastos, personales, combustibles)', async () => {
    const fila = {
      id: 'g-1',
      capturado_en: '2026-09-05T19:32:00+00:00',
      created_at: '2026-09-05T23:05:00+00:00',
      origen: 'PILOTO',
      captura: { nombre: 'Luis' },
    };
    const { service, llamadas } = armar({
      gasto: { data: [fila], error: null },
    });
    const res = await service.list(filtrosBase);
    const select = llamadas.find((l) => l.metodo === 'select');
    expect(String(select?.args[0])).toMatch(/\bcapturado_en\b/);
    expect(res.data[0]).toMatchObject({
      capturado_en: '2026-09-05T19:32:00+00:00',
      created_at: '2026-09-05T23:05:00+00:00',
      origen: 'PILOTO',
      captura: { nombre: 'Luis' },
    });
  });

  it('capturado_desde/hasta filtran por capturado_en con cortes en día Cancún', async () => {
    const { service, llamadas } = armar({});
    await service.list({
      ...filtrosBase,
      capturado_desde: '2026-09-01',
      capturado_hasta: '2026-09-07',
    });
    expect(llamadas).toContainEqual({
      metodo: 'gte',
      args: ['capturado_en', '2026-09-01T00:00:00-05:00'],
    });
    expect(llamadas).toContainEqual({
      metodo: 'lte',
      args: ['capturado_en', '2026-09-07T23:59:59-05:00'],
    });
    expect(
      llamadas.some(
        (l) =>
          (l.metodo === 'gte' || l.metodo === 'lte') &&
          l.args[0] === 'created_at',
      ),
    ).toBe(false);
  });

  it('orden por default = fecha del consumo; orden=captura = capturado_en desc', async () => {
    const a = armar({});
    await a.service.list(filtrosBase);
    const ordenesA = a.llamadas
      .filter((l) => l.metodo === 'order')
      .map((l) => l.args[0]);
    expect(ordenesA).toEqual(['fecha_gasto', 'created_at']);

    const b = armar({});
    await b.service.list({ ...filtrosBase, orden: 'captura' });
    const ordenesB = b.llamadas
      .filter((l) => l.metodo === 'order')
      .map((l) => l.args[0]);
    expect(ordenesB).toEqual(['capturado_en', 'created_at']);
  });
});

describe('ExpensesService.create — sello de capturado_en', () => {
  const dto = (): CreateGastoDto => ({
    categoria: CategoriaGasto.COMIDA,
    monto: 250,
    moneda: Moneda.MXN,
    fecha_gasto: '2026-09-05',
    medio_pago: MedioPago.EFECTIVO,
    // Con llave de idempotencia el candado de ventana no consulta la BD.
    client_request_id: '11111111-1111-4111-8111-111111111111',
  });

  afterEach(() => jest.useRealTimers());

  function insertado(llamadas: Llamada[]): Record<string, unknown> {
    const ins = llamadas.find((l) => l.metodo === 'insert');
    expect(ins).toBeDefined();
    return ins!.args[0] as Record<string, unknown>;
  }

  it('la app manda capturado_en (ISO con zona) → se guarda ese instante en UTC', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-05T23:05:00Z'));
    const { service, llamadas } = armar({
      gasto: { data: { id: 'g-nuevo' }, error: null },
    });
    await service.create(
      { ...dto(), capturado_en: '2026-09-05T14:32:00-05:00' },
      'u-piloto',
      Rol.ADMIN,
      { notificar: false },
    );
    const payload = insertado(llamadas);
    expect(payload.capturado_en).toBe('2026-09-05T19:32:00.000Z');
    expect(payload.origen).toBe('OFICINA');
  });

  it('sin capturado_en (panel, carga masiva) → ahora del servidor', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-05T23:05:00Z'));
    const { service, llamadas } = armar({
      gasto: { data: { id: 'g-nuevo' }, error: null },
    });
    await service.create(dto(), 'u-admin', Rol.ADMIN, { notificar: false });
    expect(insertado(llamadas).capturado_en).toBe('2026-09-05T23:05:00.000Z');
  });

  it('capturado_en en el futuro (> 10 min) o sin zona → 400 antes de tocar la BD', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-05T23:05:00Z'));
    const { service, llamadas } = armar({});
    await expect(
      service.create(
        { ...dto(), capturado_en: '2026-09-06T00:00:00Z' },
        'u',
        Rol.ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(
        { ...dto(), capturado_en: '2026-09-05T14:32:00' },
        'u',
        Rol.ADMIN,
      ),
    ).rejects.toThrow(/zona horaria/);
    expect(llamadas.some((l) => l.metodo === 'insert')).toBe(false);
  });
});
