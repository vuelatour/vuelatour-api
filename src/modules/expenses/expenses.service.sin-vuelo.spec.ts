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

/**
 * COMISIÓN DEL VENDEDOR (28-sep-2026, invariante 31): la comisión SIEMPRE es
 * de un vuelo — el 400 `GASTO_REQUIERE_VUELO` aplica a TODOS los roles (la
 * oficina incluida, que es quien la captura), en el alta Y en la edición. El
 * CHECK `gasto_comision_vendedor_exige_vuelo` es solo el respaldo de BD.
 */
type FilaBd = Record<string, unknown>;
const VUELO_A = '11111111-1111-4111-8111-111111111111';
const VUELO_B = '44444444-4444-4444-8444-444444444444';
const ESCALA_A = '22222222-2222-4222-8222-222222222222';
const AVION_A = '33333333-3333-4333-8333-333333333333';
const AVION_B = '55555555-5555-4555-8555-555555555555';

/** PostgREST falso con tablas: `maybeSingle` resuelve por `eq('id')`. */
function armarConTablas(
  opts: {
    gastoActual?: FilaBd;
    errorInsert?: { code: string; message: string };
    errorUpdate?: { code: string; message: string };
  } = {},
) {
  const llamadas: Array<Llamada & { tabla: string }> = [];
  const tablas: Record<string, FilaBd[]> = {
    vuelo: [
      { id: VUELO_A, folio: 317, aeronave_id: AVION_A, piloto_id: null },
      { id: VUELO_B, folio: 318, aeronave_id: AVION_B, piloto_id: null },
    ],
    escala: [
      {
        id: ESCALA_A,
        vuelo_id: VUELO_A,
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'MID',
        aeronave_id: null,
        aeronave: null,
        vuelo: { aeronave_id: AVION_A, aeronave: { matricula: 'N4142R' } },
      },
    ],
    gasto: opts.gastoActual ? [opts.gastoActual] : [],
  };
  const supabase = {
    service: {
      from: (tabla: string) => {
        let op: 'select' | 'insert' | 'update' = 'select';
        let cuerpo: FilaBd | null = null;
        let id: unknown;
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
            llamadas.push({ metodo: m, args, tabla });
            if (m === 'eq' && args[0] === 'id') id = args[1];
            if (m === 'insert') {
              op = 'insert';
              cuerpo = args[0] as FilaBd;
            }
            if (m === 'update') {
              op = 'update';
              cuerpo = args[0] as FilaBd;
            }
            return q;
          };
        }
        q.maybeSingle = () => {
          if (op === 'insert') {
            return Promise.resolve(
              opts.errorInsert
                ? { data: null, error: opts.errorInsert }
                : { data: { id: 'g-nuevo', ...cuerpo }, error: null },
            );
          }
          if (op === 'update') {
            return Promise.resolve(
              opts.errorUpdate
                ? { data: null, error: opts.errorUpdate }
                : {
                    data: { ...(opts.gastoActual ?? {}), ...cuerpo },
                    error: null,
                  },
            );
          }
          const fila = (tablas[tabla] ?? []).find((f) => f.id === id) ?? null;
          return Promise.resolve({ data: fila, error: null });
        };
        q.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
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
  const insertado = () =>
    llamadas.find((l) => l.metodo === 'insert' && l.tabla === 'gasto')
      ?.args[0] as FilaBd | undefined;
  const actualizado = () =>
    llamadas.find((l) => l.metodo === 'update' && l.tabla === 'gasto')
      ?.args[0] as FilaBd | undefined;
  return { service, llamadas, insertado, actualizado };
}

const comision = (extra: Partial<CreateGastoDto> = {}) =>
  dto({ categoria: CategoriaGasto.COMISION_VENDEDOR, monto: 2030, ...extra });

const MSG_REQUIERE_VUELO =
  'Esta categoría es del vuelo: elige el vuelo. «Comisión del vendedor» siempre se registra con el vuelo al que pertenece.';

describe('ExpensesService — COMISION_VENDEDOR exige vuelo a TODOS los roles (28-sep-2026)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('ADMIN, COORDINADOR, FACTURACION y PILOTO sin vuelo ⇒ 400 GASTO_REQUIERE_VUELO con details, SIN tocar la BD', async () => {
    for (const rol of [
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
      Rol.PILOTO,
    ]) {
      const { service, llamadas } = armarConTablas();
      const r = await rebote(service.create(comision(), 'u-1', rol));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('GASTO_REQUIERE_VUELO');
      expect(r.body.message).toBe(MSG_REQUIERE_VUELO);
      expect(r.body.details).toEqual({
        categoria: 'COMISION_VENDEDOR',
        categoria_label: 'Comisión del vendedor',
        destino:
          'Pago al vendedor (otros movimientos VuelaTour; no es costo del avión)',
      });
      expect(llamadas).toHaveLength(0);
    }
  });

  it('con vuelo ⇒ se guarda y HEREDA el avión del vuelo (solo referencia)', async () => {
    const { service, insertado } = armarConTablas();
    await service.create(
      comision({ vuelo_id: VUELO_A }),
      'u-admin',
      Rol.ADMIN,
      {
        notificar: false,
      },
    );
    expect(insertado()).toMatchObject({
      categoria: 'COMISION_VENDEDOR',
      vuelo_id: VUELO_A,
      aeronave_id: AVION_A,
      monto: 2030,
    });
  });

  it('con TRAMO (implica vuelo) ⇒ se guarda con el vuelo y el avión del tramo', async () => {
    const { service, insertado } = armarConTablas();
    await service.create(
      comision({ escala_id: ESCALA_A }),
      'u-admin',
      Rol.ADMIN,
      { notificar: false },
    );
    expect(insertado()).toMatchObject({
      categoria: 'COMISION_VENDEDOR',
      vuelo_id: VUELO_A,
      escala_id: ESCALA_A,
      aeronave_id: AVION_A,
    });
  });

  it('control: la OFICINA sigue capturando «Otros gastos VuelaTour» SIN vuelo', async () => {
    const { service, insertado } = armarConTablas();
    await service.create(
      dto({ categoria: CategoriaGasto.OTRO }),
      'u-admin',
      Rol.ADMIN,
      { notificar: false },
    );
    expect(insertado()).toMatchObject({ categoria: 'OTRO' });
  });

  it('BD sin la migración 20260928000001 (22P02 del enum) ⇒ 400 legible, nunca 500', async () => {
    const { service } = armarConTablas({
      errorInsert: {
        code: '22P02',
        message:
          'invalid input value for enum categoria_gasto: "COMISION_VENDEDOR"',
      },
    });
    const r = await rebote(
      service.create(comision({ vuelo_id: VUELO_A }), 'u-admin', Rol.ADMIN, {
        notificar: false,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body.message).toBe(
      '«Comisión del vendedor» necesita la migración 20260928000001 en la base de datos; avisa a sistemas (el gasto no se guardó).',
    );
  });

  it('23514 del CHECK nuevo (respaldo de BD) ⇒ el mismo 400 GASTO_REQUIERE_VUELO, nunca 409 genérico', async () => {
    const { service } = armarConTablas({
      errorInsert: {
        code: '23514',
        message:
          'new row for relation "gasto" violates check constraint "gasto_comision_vendedor_exige_vuelo"',
      },
    });
    const r = await rebote(
      service.create(comision({ vuelo_id: VUELO_A }), 'u-admin', Rol.ADMIN, {
        notificar: false,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('GASTO_REQUIERE_VUELO');
    expect(r.body.message).toBe(MSG_REQUIERE_VUELO);
  });

  const comisionViva: FilaBd = {
    id: 'g-cv',
    categoria: 'COMISION_VENDEDOR',
    vuelo_id: VUELO_A,
    escala_id: null,
    aeronave_id: AVION_A,
    monto: 2030,
    propina: 0,
    moneda: 'MXN',
    medio_pago: 'TRANSFERENCIA',
    notas: null,
    tarjeta_terminacion: null,
    usuario_captura_id: 'u-admin',
    valor_ia_extraido: null,
  };

  it('update: DESLIGAR el vuelo de una comisión ⇒ 400 (sin escribir)', async () => {
    const { service, actualizado } = armarConTablas({
      gastoActual: comisionViva,
    });
    const r = await rebote(
      service.update(
        'g-cv',
        { vuelo_id: null } as unknown as Parameters<
          ExpensesService['update']
        >[1],
        'u-admin',
        Rol.ADMIN,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('GASTO_REQUIERE_VUELO');
    expect(actualizado()).toBeUndefined();
  });

  it('update: reclasificar un OTRO SIN vuelo a COMISION_VENDEDOR ⇒ 400', async () => {
    const { service, actualizado } = armarConTablas({
      gastoActual: {
        ...comisionViva,
        id: 'g-otro',
        categoria: 'OTRO',
        vuelo_id: null,
        aeronave_id: null,
      },
    });
    const r = await rebote(
      service.update(
        'g-otro',
        { categoria: CategoriaGasto.COMISION_VENDEDOR },
        'u-admin',
        Rol.ADMIN,
      ),
    );
    expect(r.body.error).toBe('GASTO_REQUIERE_VUELO');
    expect(actualizado()).toBeUndefined();
  });

  it('update: reclasificar un OTRO CON vuelo a COMISION_VENDEDOR ⇒ OK (el camino para arreglar capturas viejas)', async () => {
    const { service, actualizado } = armarConTablas({
      gastoActual: { ...comisionViva, id: 'g-otro', categoria: 'OTRO' },
    });
    await service.update(
      'g-otro',
      { categoria: CategoriaGasto.COMISION_VENDEDOR },
      'u-admin',
      Rol.ADMIN,
    );
    expect(actualizado()).toMatchObject({ categoria: 'COMISION_VENDEDOR' });
  });

  it('update: reclasificar CON el vuelo en el MISMO PATCH ⇒ OK (lo que manda el panel al verificar)', async () => {
    const { service, actualizado } = armarConTablas({
      gastoActual: {
        ...comisionViva,
        id: 'g-otro',
        categoria: 'OTRO',
        vuelo_id: null,
        aeronave_id: null,
      },
    });
    await service.update(
      'g-otro',
      { categoria: CategoriaGasto.COMISION_VENDEDOR, vuelo_id: VUELO_A },
      'u-admin',
      Rol.ADMIN,
    );
    expect(actualizado()).toMatchObject({
      categoria: 'COMISION_VENDEDOR',
      vuelo_id: VUELO_A,
    });
  });

  it('update: MOVER la comisión a OTRO vuelo ⇒ OK', async () => {
    const { service, actualizado } = armarConTablas({
      gastoActual: comisionViva,
    });
    await service.update('g-cv', { vuelo_id: VUELO_B }, 'u-admin', Rol.ADMIN);
    expect(actualizado()).toMatchObject({ vuelo_id: VUELO_B });
  });

  it('update: 23514 del CHECK nuevo ⇒ 400 GASTO_REQUIERE_VUELO', async () => {
    const { service } = armarConTablas({
      gastoActual: comisionViva,
      errorUpdate: {
        code: '23514',
        message:
          'new row for relation "gasto" violates check constraint "gasto_comision_vendedor_exige_vuelo"',
      },
    });
    const r = await rebote(
      service.update('g-cv', { vuelo_id: VUELO_B }, 'u-admin', Rol.ADMIN),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('GASTO_REQUIERE_VUELO');
  });

  it('update: otro 23514 (medio↔tarjeta) sigue siendo el 409 de siempre', async () => {
    const { service } = armarConTablas({
      gastoActual: comisionViva,
      errorUpdate: {
        code: '23514',
        message:
          'new row for relation "gasto" violates check constraint "gasto_check"',
      },
    });
    const r = await rebote(
      service.update('g-cv', { vuelo_id: VUELO_B }, 'u-admin', Rol.ADMIN),
    );
    expect(r.status).toBe(409);
  });
});
