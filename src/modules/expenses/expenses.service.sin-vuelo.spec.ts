// Mismos stubs que expenses.service.spec.ts: notifications arrastra el
// gateway y `jose` (ESM puro), vision el SDK de IA y pyservices el cliente.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { BadRequestException, HttpException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CategoriaGasto, MedioPago, Moneda } from './dto/expenses.dto';
import type { CreateGastoDto } from './dto/expenses.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';

/**
 * GASTO DE PILOTO SIN VUELO (11-sep-2026, backend del pedido de la app).
 * El piloto puede capturar sin elegir vuelo SOLO si la categoría no es del
 * vuelo; las del vuelo rebotan con 400 estructurado `GASTO_REQUIERE_VUELO`
 * ANTES de tocar la BD. La oficina y el mecánico no cambian.
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
        // maybeSingle = fila insertada; `then` (listas) = [] — así los
        // candados de duplicado/gemelo no encuentran nada y el alta fluye.
        q.maybeSingle = () =>
          Promise.resolve({ data: { id: 'g-nuevo' }, error: null });
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
  // `configuracion.numero` = días de gracia del candado semanal (config
  // viva del cliente, default 1).
  const configuracion = {
    numero: jest.fn().mockResolvedValue(1),
  } as never;
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

const HOY = new Date('2026-09-09T18:00:00Z'); // miércoles, hora Cancún 13:00

function dto(extra: Partial<CreateGastoDto> = {}): CreateGastoDto {
  return {
    categoria: CategoriaGasto.COMIDA,
    monto: 250,
    moneda: Moneda.MXN,
    fecha_gasto: '2026-09-09',
    medio_pago: MedioPago.EFECTIVO,
    ...extra,
  };
}

/** Captura el cuerpo estructurado del rechazo (code/details vía el filtro). */
async function rebote(p: Promise<unknown>) {
  try {
    await p;
    throw new Error('no rebotó');
  } catch (e) {
    const err = e as HttpException;
    const body = err.getResponse() as {
      message?: string;
      error?: string;
      details?: Record<string, unknown>;
    };
    return { status: err.getStatus(), body, instancia: err };
  }
}

describe('ExpensesService.create — gasto de PILOTO sin vuelo', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('categoría DEL VUELO sin vuelo → 400 GASTO_REQUIERE_VUELO con mensaje claro y SIN tocar la BD', async () => {
    const { service, llamadas } = armar();
    const r = await rebote(
      service.create(
        dto({ categoria: CategoriaGasto.COMIDA }),
        'u-piloto',
        Rol.PILOTO,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.instancia).toBeInstanceOf(BadRequestException);
    expect(r.body.error).toBe('GASTO_REQUIERE_VUELO');
    expect(r.body.message).toMatch(
      /^Esta categoría es del vuelo: elige el vuelo\./,
    );
    expect(r.body.details).toMatchObject({
      categoria: 'COMIDA',
      categoria_label: 'Comida',
    });
    expect(llamadas).toHaveLength(0);
  });

  it('las 9 categorías del vuelo rebotan; las de empresa/indirectos/refacción SÍ se guardan sin vuelo', async () => {
    const delVuelo = [
      CategoriaGasto.ATERRIZAJE,
      CategoriaGasto.OPERACIONES,
      CategoriaGasto.TUAS,
      CategoriaGasto.FBO,
      CategoriaGasto.COMIDA,
      CategoriaGasto.HOTEL,
      CategoriaGasto.TAXI,
      CategoriaGasto.PERMISO,
      CategoriaGasto.PILOTO_EXTERNO,
    ];
    for (const categoria of delVuelo) {
      const { service } = armar();
      const r = await rebote(
        service.create(dto({ categoria }), 'u-piloto', Rol.PILOTO),
      );
      expect(r.body.error).toBe('GASTO_REQUIERE_VUELO');
    }
    const sinVuelo = [
      // GAS (11-sep-2026): salió del candado — el piloto carga combustible
      // en base igual que el mecánico ("Sin vuelo" en la app).
      CategoriaGasto.GAS,
      CategoriaGasto.REFACCION,
      CategoriaGasto.INDIRECTO,
      CategoriaGasto.SERVICIOS,
      CategoriaGasto.NOMINA,
      CategoriaGasto.GASOLINA,
      CategoriaGasto.OTRO,
    ];
    for (const categoria of sinVuelo) {
      const { service, llamadas } = armar();
      // GAS sin vuelo SÍ exige avión (candado propio, 26-ago: una carga sin
      // aeronave sería invisible para el balance y el reparto). Ese candado
      // no cambia — lo que cambió es que ya no exige VUELO.
      const extra =
        categoria === CategoriaGasto.GAS
          ? { aeronave_id: '33333333-3333-4333-8333-333333333333' }
          : {};
      await service.create(
        dto({ categoria, ...extra }),
        'u-piloto',
        Rol.PILOTO,
        {
          notificar: false,
        },
      );
      const insert = llamadas.find((l) => l.metodo === 'insert');
      expect(insert).toBeDefined();
      expect(
        (insert!.args[0] as Record<string, unknown>).vuelo_id,
      ).toBeUndefined();
      expect((insert!.args[0] as Record<string, unknown>).categoria).toBe(
        categoria,
      );
    }
  });

  it('con vuelo (o con tramo, que lo implica) la categoría del vuelo pasa como siempre', async () => {
    const conVuelo = armar();
    await conVuelo.service.create(
      dto({ vuelo_id: '11111111-1111-4111-8111-111111111111' }),
      'u-piloto',
      Rol.PILOTO,
      { notificar: false },
    );
    expect(conVuelo.llamadas.some((l) => l.metodo === 'insert')).toBe(true);

    // `escala_id` cuenta como vuelo: el candado NO dispara (el tramo lo
    // resuelve más abajo y valida que pertenezcan al mismo vuelo). Aquí el
    // alta puede fallar por el tramo simulado — lo que se prueba es que el
    // rechazo JAMÁS sea GASTO_REQUIERE_VUELO.
    const conTramo = armar();
    const code = await conTramo.service
      .create(
        dto({ escala_id: '22222222-2222-4222-8222-222222222222' }),
        'u-piloto',
        Rol.PILOTO,
        { notificar: false },
      )
      .then(
        () => null,
        (e: unknown) =>
          e instanceof HttpException
            ? (e.getResponse() as { error?: string }).error
            : null,
      );
    expect(code).not.toBe('GASTO_REQUIERE_VUELO');
  });

  it('la OFICINA no queda atrapada por el candado (carga suelta y liga después)', async () => {
    const { service, llamadas } = armar();
    await service.create(dto(), 'u-admin', Rol.ADMIN, { notificar: false });
    expect(llamadas.some((l) => l.metodo === 'insert')).toBe(true);
  });

  it('el MECÁNICO sigue cargando GAS sin vuelo (combustible en base)', async () => {
    const { service, llamadas } = armar();
    await service.create(
      dto({
        categoria: CategoriaGasto.GAS,
        aeronave_id: '33333333-3333-4333-8333-333333333333',
      }),
      'u-mec',
      Rol.MECANICO,
      { notificar: false },
    );
    expect(llamadas.some((l) => l.metodo === 'insert')).toBe(true);
  });

  it('el PILOTO también carga GAS sin vuelo (11-sep-2026): el combustible en base ya no exige vuelo', async () => {
    // Cambio del cliente: un piloto carga turbosina en base igual que el
    // mecánico y la pantalla de combustible de la app ofrece "Sin vuelo".
    // El dinero no se pierde: la hoja "combustible" del balance se arma por
    // AVIÓN (eje fecha_gasto) y el pre-cierre vigila el GAS sin avión.
    const { service, llamadas } = armar();
    await service.create(
      dto({
        categoria: CategoriaGasto.GAS,
        aeronave_id: '33333333-3333-4333-8333-333333333333',
      }),
      'u-piloto',
      Rol.PILOTO,
      { notificar: false },
    );
    const insert = llamadas.find((l) => l.metodo === 'insert');
    expect(insert).toBeDefined();
    expect(
      (insert!.args[0] as Record<string, unknown>).vuelo_id,
    ).toBeUndefined();
  });
});
