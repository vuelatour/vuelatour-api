// Módulos pesados que expenses.service importa solo para inyección (mismo
// patrón que expenses.service.cas.spec): notifications arrastra el gateway y
// `jose` (ESM puro, jest no lo transforma).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { GASTO_CAMBIO_FECHA_COLS } from './cambio-fecha-gasto.util';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { CajaChicaService } from '../caja-chica/caja-chica.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';
import { Rol } from '../../common/types/auth.types';

/**
 * FECHA DEL PAGO desde Conciliación (14-oct-2026, invariante 74):
 * `ExpensesService.cambiarFechaGasto` con el PostgREST falso de
 * expenses.service.cas.spec (resultados por tabla EN ORDEN de await) y el
 * reloj fijo en 2026-10-14T17:00:00Z (12:00 en Cancún). Se prueba que lee lo
 * justo, escribe SOLO la fecha (y la hora de la carga) por `update()` con
 * CAS y que JAMÁS dispara el auto-cruce — y, de control, que el PATCH
 * general sí lo dispara como siempre.
 */
type Resultado = {
  data?: unknown;
  error?: null | { code?: string; message: string };
  /** Se ejecuta al resolver (p. ej. mover el reloj a mitad de la petición). */
  alResolver?: () => void;
  /** La consulta REVIENTA (red caída) en vez de devolver `error`. */
  lanza?: Error;
};
type Llamada = { tabla: string; metodo: string; args: unknown[] };

function armarSupabase(tablas: Record<string, Resultado[]>) {
  const llamadas: Llamada[] = [];
  const cursor: Record<string, number> = {};
  const siguiente = (tabla: string): Resultado => {
    const lista = tablas[tabla] ?? [{ data: null, error: null }];
    const i = cursor[tabla] ?? 0;
    cursor[tabla] = i + 1;
    return lista[Math.min(i, lista.length - 1)];
  };
  const from = (tabla: string) => {
    llamadas.push({ tabla, metodo: 'from', args: [tabla] });
    const q: Record<string, unknown> = {};
    const registra =
      (metodo: string) =>
      (...args: unknown[]) => {
        llamadas.push({ tabla, metodo, args });
        return q;
      };
    for (const m of [
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
      'delete',
    ]) {
      q[m] = registra(m);
    }
    // La sonda de `gasto.tua_incluida` (invariante 66) NO es una lectura de
    // negocio: responde «la columna existe» sin consumir la cola.
    let esSonda = false;
    q.select = (...args: unknown[]) => {
      llamadas.push({ tabla, metodo: 'select', args });
      if (args[0] === 'tua_incluida') esSonda = true;
      return q;
    };
    const resolver = (): Promise<{ data: unknown; error: unknown }> => {
      const r: Resultado = esSonda
        ? { data: [], error: null }
        : siguiente(tabla);
      r.alResolver?.();
      if (r.lanza) return Promise.reject(r.lanza);
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    };
    q.maybeSingle = () => resolver();
    q.then = (
      resolve: (v: { data: unknown; error: unknown }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => resolver().then(resolve, reject);
    return q;
  };
  return { llamadas, service: { from } };
}

function armar(tablas: Record<string, Resultado[]>) {
  const sb = armarSupabase(tablas);
  const supabase = { service: sb.service } as unknown as SupabaseService;
  const notifications = {
    notifyRole: jest.fn().mockResolvedValue(undefined),
    notifyUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
  const configuracion = {
    numero: jest.fn().mockResolvedValue(1),
  } as unknown as ConfiguracionService;
  const cajaChica = {
    fechaUltimaReposicionDe: jest.fn().mockResolvedValue(null),
  } as unknown as CajaChicaService;
  const intentarCruzarGasto = jest.fn().mockResolvedValue({ ligado: false });
  const conciliacion = {
    intentarCruzarGasto,
  } as unknown as ConciliacionService;
  const nada = {} as never;
  const service = new ExpensesService(
    supabase,
    notifications,
    nada,
    nada,
    configuracion,
    cajaChica,
    nada,
    conciliacion,
  );
  return { service, llamadas: sb.llamadas, intentarCruzarGasto };
}

const de = (llamadas: Llamada[], tabla: string, metodo: string) =>
  llamadas.filter((l) => l.tabla === tabla && l.metodo === metodo);

/** Lecturas de negocio de `gasto` (sin la sonda de `tua_incluida`). */
const lecturasGasto = (llamadas: Llamada[]) =>
  de(llamadas, 'gasto', 'select').filter((l) => l.args[0] !== 'tua_incluida');

/** El HttpException con el que rechaza la promesa. */
async function rechazo(p: Promise<unknown>): Promise<HttpException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return e;
    throw e;
  }
  throw new Error('se esperaba un rechazo');
}

const G = '08c0632c-5711-4f0d-affd-591d756dd9fc';
const N41 = 'av-n4142r';
const PEV = 'av-xb-pev';
const SEP_TERMINO =
  'Septiembre 2026 ya terminó: si ya se entregaron sus libros o su reparto, hay que regenerarlos después de este cambio.';

/** Winjet tal como lo devuelve PostgREST (prod, 14-oct). */
const WINJET = {
  id: G,
  categoria: 'TAXI',
  medio_pago: 'TARJETA_CORP',
  moneda: 'MXN',
  tc_gasto: null,
  monto: '321.54',
  fecha_gasto: '2026-10-10',
  fecha_hora_carga: null,
  updated_at: '2026-10-12T19:53:54.941784+00:00',
  vuelo_id: 'v-436',
  aeronave_id: PEV,
  escala_id: null,
  inventario_movimiento_id: null,
  escala: null,
  vuelo: {
    folio: 436,
    fecha_vuelo: '2026-10-10T22:00:00+00:00',
    aeronave_id: PEV,
    es_externo: false,
  },
};

/** REFACCION sin vuelo de N4142R del 30-sep (en pesos, sin T.C.). */
const REFACCION = {
  ...WINJET,
  categoria: 'REFACCION',
  medio_pago: 'TRANSFERENCIA',
  monto: '1500.00',
  fecha_gasto: '2026-09-30',
  updated_at: '2026-10-01T15:00:00.000001+00:00',
  vuelo_id: null,
  vuelo: null,
  aeronave_id: N41,
};

/** La fila que devuelve el UPDATE (`select(cols())`). */
const filaActualizada = (extra: Record<string, unknown> = {}) => ({
  id: G,
  medio_pago: 'TARJETA_CORP',
  conciliado: false,
  fecha_hora_carga: null,
  updated_at: '2026-10-14T17:00:00.123456+00:00',
  ...extra,
});

beforeEach(() => {
  // Sin tocar nextTick ni setImmediate: las promesas de la cadena corren.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-10-14T17:00:00Z'));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('cambiarFechaGasto — el caso de la captura (Winjet)', () => {
  it('lee con GASTO_CAMBIO_FECHA_COLS, escribe SOLO la fecha con CAS ±1 ms sobre el updated_at leído y NO dispara el auto-cruce', async () => {
    const { service, llamadas, intentarCruzarGasto } = armar({
      gasto: [
        { data: WINJET },
        { data: filaActualizada({ fecha_gasto: '2026-10-12' }) },
      ],
    });
    const r = await service.cambiarFechaGasto(
      G,
      { fecha_gasto: '2026-10-12', fecha_anterior: '2026-10-10' },
      'u-1',
      Rol.ADMIN,
    );
    expect(r).toEqual({
      id: G,
      fecha_gasto: '2026-10-12',
      fecha_anterior: '2026-10-10',
      cambio: true,
      cambia_de_mes: false,
      fecha_hora_carga: null,
      updated_at: '2026-10-14T17:00:00.123456+00:00',
      aviso: null,
    });
    expect(lecturasGasto(llamadas)[0].args).toEqual([GASTO_CAMBIO_FECHA_COLS]);
    expect(de(llamadas, 'gasto', 'eq')[0].args).toEqual(['id', G]);
    const updates = de(llamadas, 'gasto', 'update');
    expect(updates).toHaveLength(1);
    // EXACTAMENTE la fecha y quién: sin fecha_hora_carga, sin verificado_*,
    // sin if_updated_at ni permitir_fecha_antigua (no son columnas).
    expect(updates[0].args[0]).toEqual({
      fecha_gasto: '2026-10-12',
      updated_by: 'u-1',
    });
    expect(de(llamadas, 'gasto', 'gte').map((l) => l.args)).toEqual([
      ['updated_at', '2026-10-12T19:53:54.940Z'],
    ]);
    expect(de(llamadas, 'gasto', 'lte').map((l) => l.args)).toEqual([
      ['updated_at', '2026-10-12T19:53:54.942Z'],
    ]);
    expect(intentarCruzarGasto).not.toHaveBeenCalled();
    // TAXI no es repartible y no cambia de mes: ni repartos ni matrículas.
    expect(
      llamadas.some(
        (l) => l.tabla === 'gasto_reparto' || l.tabla === 'aeronave',
      ),
    ).toBe(false);
  });

  it('CONTROL: el PATCH general de solo fecha SÍ dispara el auto-cruce (una vez), igual que siempre; con { autoCruce: false } no', async () => {
    for (const opciones of [undefined, {}] as const) {
      const { service, intentarCruzarGasto } = armar({
        gasto: [{ data: filaActualizada({ fecha_gasto: '2026-10-12' }) }],
      });
      await (opciones === undefined
        ? service.update(G, { fecha_gasto: '2026-10-12' }, 'u-1', Rol.ADMIN)
        : service.update(
            G,
            { fecha_gasto: '2026-10-12' },
            'u-1',
            Rol.ADMIN,
            opciones,
          ));
      expect(intentarCruzarGasto).toHaveBeenCalledTimes(1);
      expect(intentarCruzarGasto).toHaveBeenCalledWith(G, 'u-1');
    }
    const { service, intentarCruzarGasto } = armar({
      gasto: [{ data: filaActualizada({ fecha_gasto: '2026-10-12' }) }],
    });
    await service.update(G, { fecha_gasto: '2026-10-12' }, 'u-1', Rol.ADMIN, {
      autoCruce: false,
    });
    expect(intentarCruzarGasto).not.toHaveBeenCalled();
  });

  it('misma fecha ⇒ 200 con cambio false y SIN UPDATE (doble clic idempotente)', async () => {
    const { service, llamadas } = armar({ gasto: [{ data: WINJET }] });
    const r = await service.cambiarFechaGasto(
      G,
      { fecha_gasto: '2026-10-10', fecha_anterior: '2026-10-09' },
      'u-1',
      Rol.FACTURACION,
    );
    expect(r).toEqual({
      id: G,
      fecha_gasto: '2026-10-10',
      fecha_anterior: '2026-10-10',
      cambio: false,
      cambia_de_mes: false,
      fecha_hora_carga: null,
      updated_at: WINJET.updated_at,
      aviso: null,
    });
    expect(de(llamadas, 'gasto', 'update')).toHaveLength(0);
  });
});

describe('cambiarFechaGasto — rechazos', () => {
  it('fechas mal ⇒ 400 con CERO consultas (futura, de hace 366 días, día que no existe)', async () => {
    for (const [fecha_gasto, fecha_anterior, code] of [
      ['2026-10-15', '2026-10-10', 'FECHA_GASTO_FUTURA'],
      ['2025-10-13', '2026-10-10', 'FECHA_GASTO_MUY_ANTIGUA'],
      ['2026-02-30', '2026-10-10', 'FECHA_GASTO_INVALIDA'],
      ['2026-10-12', '2026-02-30', 'FECHA_GASTO_INVALIDA'],
    ]) {
      const { service, llamadas } = armar({ gasto: [{ data: WINJET }] });
      const e = await rechazo(
        service.cambiarFechaGasto(
          G,
          { fecha_gasto, fecha_anterior },
          'u-1',
          Rol.ADMIN,
        ),
      );
      expect(e.getStatus()).toBe(400);
      expect(e.getResponse()).toMatchObject({ error: code });
      expect(llamadas).toEqual([]);
    }
    const { service } = armar({});
    const futura = await rechazo(
      service.cambiarFechaGasto(
        G,
        { fecha_gasto: '2026-10-15', fecha_anterior: '2026-10-10' },
        'u-1',
        Rol.ADMIN,
      ),
    );
    expect(futura.getResponse()).toEqual({
      message:
        'La fecha del pago (15 oct 2026) es posterior a hoy (14 oct 2026): el banco no cobra en días que no han pasado.',
      error: 'FECHA_GASTO_FUTURA',
    });
  });

  it('gasto inexistente ⇒ 404 GASTO_NO_EXISTE; lectura fallida ⇒ error del servidor (no un 404 falso)', async () => {
    const { service } = armar({ gasto: [{ data: null }] });
    const e = await rechazo(
      service.cambiarFechaGasto(
        G,
        { fecha_gasto: '2026-10-12', fecha_anterior: '2026-10-10' },
        'u-1',
        Rol.ADMIN,
      ),
    );
    expect(e.getStatus()).toBe(404);
    expect(e.getResponse()).toEqual({
      message: 'Ese gasto ya no existe: recarga la página.',
      error: 'GASTO_NO_EXISTE',
    });
    const roto = armar({ gasto: [{ error: { message: 'timeout' } }] });
    await expect(
      roto.service.cambiarFechaGasto(
        G,
        { fecha_gasto: '2026-10-12', fecha_anterior: '2026-10-10' },
        'u-1',
        Rol.ADMIN,
      ),
    ).rejects.toThrow('timeout');
  });

  it('FECHA_GASTO_CAMBIO, SOLO_BANCARIOS (efectivo) y FUERA del mes del vuelo (aun con confirmar) ⇒ 409 con code y details, SIN UPDATE', async () => {
    const casos: Array<{
      fila: Record<string, unknown>;
      body: {
        fecha_gasto: string;
        fecha_anterior: string;
        confirmar?: boolean;
      };
      code: string;
      details: Record<string, unknown>;
    }> = [
      {
        fila: WINJET,
        body: { fecha_gasto: '2026-10-12', fecha_anterior: '2026-10-09' },
        code: 'FECHA_GASTO_CAMBIO',
        details: { fecha_actual: '2026-10-10' },
      },
      {
        fila: { ...WINJET, medio_pago: 'EFECTIVO' },
        body: { fecha_gasto: '2026-10-12', fecha_anterior: '2026-10-10' },
        code: 'FECHA_GASTO_SOLO_BANCARIOS',
        details: { medio_pago: 'EFECTIVO' },
      },
      {
        // 92bd5379 (prod): OPERACIONES del vuelo #201 de N4142R (27-ago).
        fila: {
          ...WINJET,
          categoria: 'OPERACIONES',
          medio_pago: 'TRANSFERENCIA',
          fecha_gasto: '2026-08-27',
          vuelo_id: 'v-201',
          aeronave_id: N41,
          vuelo: {
            folio: 201,
            fecha_vuelo: '2026-08-27T13:50:00+00:00',
            aeronave_id: N41,
            es_externo: false,
          },
        },
        body: {
          fecha_gasto: '2026-09-07',
          fecha_anterior: '2026-08-27',
          confirmar: true,
        },
        code: 'FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO',
        details: {
          vuelo_folio: 201,
          vuelo_dia: '2026-08-27',
          mes_vuelo: '2026-08',
          mes_nuevo: '2026-09',
        },
      },
    ];
    for (const c of casos) {
      const { service, llamadas, intentarCruzarGasto } = armar({
        gasto: [{ data: c.fila }],
      });
      const e = await rechazo(
        service.cambiarFechaGasto(G, c.body, 'u-1', Rol.ADMIN),
      );
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({
        error: c.code,
        details: c.details,
      });
      expect(de(llamadas, 'gasto', 'update')).toHaveLength(0);
      expect(intentarCruzarGasto).not.toHaveBeenCalled();
    }
  });

  it('UPDATE con 0 filas (alguien lo cambió entre la lectura y la escritura) ⇒ 409 CONFLICTO_VERSION', async () => {
    const vivo = { ...WINJET, updated_at: '2026-10-14T16:59:59+00:00' };
    const { service } = armar({
      gasto: [{ data: WINJET }, { data: null }, { data: vivo }],
    });
    const e = await rechazo(
      service.cambiarFechaGasto(
        G,
        { fecha_gasto: '2026-10-12', fecha_anterior: '2026-10-10' },
        'u-1',
        Rol.ADMIN,
      ),
    );
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({
      error: 'CONFLICTO_VERSION',
      details: {
        updated_at_enviado: WINJET.updated_at,
        updated_at_actual: '2026-10-14T16:59:59+00:00',
      },
    });
  });
});

describe('cambiarFechaGasto — confirmación, repartos y matrículas', () => {
  it('REFACCION 30-sep → 01-oct: sin confirmar ⇒ 409 FECHA_GASTO_CONFIRMAR (texto y details exactos), UNA lectura de matrículas y SIN UPDATE', async () => {
    const { service, llamadas } = armar({
      gasto: [{ data: REFACCION }],
      aeronave: [{ data: [{ id: N41, matricula: 'N4142R' }] }],
    });
    const e = await rechazo(
      service.cambiarFechaGasto(
        G,
        { fecha_gasto: '2026-10-01', fecha_anterior: '2026-09-30' },
        'u-1',
        Rol.ADMIN,
      ),
    );
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({
      message:
        'Pasa de septiembre 2026 a octubre 2026. En el balance de N4142R pasa a octubre 2026. En el reparto a socios de N4142R pasa a octubre 2026. En el Libro Dinero pasa a octubre 2026. El reparto convierte este gasto en pesos con el tipo de cambio oficial del día del gasto: con la fecha nueva cambia lo que vale en dólares. ' +
        SEP_TERMINO,
      error: 'FECHA_GASTO_CONFIRMAR',
      details: {
        cambia_de_mes: true,
        mes_antes: '2026-09',
        mes_despues: '2026-10',
        etiqueta_mes_despues: 'octubre 2026',
        meses_terminados: ['2026-09'],
      },
    });
    expect(de(llamadas, 'aeronave', 'select').map((l) => l.args)).toEqual([
      ['id, matricula'],
    ]);
    expect(de(llamadas, 'aeronave', 'in').map((l) => l.args)).toEqual([
      ['id', [N41]],
    ]);
    expect(de(llamadas, 'gasto', 'update')).toHaveLength(0);
    // REFACCION no es repartible: no se leen repartos.
    expect(llamadas.some((l) => l.tabla === 'gasto_reparto')).toBe(false);
  });

  it('REFACCION con confirmar ⇒ UPDATE de la fecha y aviso «Septiembre 2026 ya terminó: …»', async () => {
    const { service, llamadas, intentarCruzarGasto } = armar({
      gasto: [
        { data: REFACCION },
        {
          data: filaActualizada({
            medio_pago: 'TRANSFERENCIA',
            fecha_gasto: '2026-10-01',
          }),
        },
      ],
      aeronave: [{ data: [{ id: N41, matricula: 'N4142R' }] }],
    });
    const r = await service.cambiarFechaGasto(
      G,
      {
        fecha_gasto: '2026-10-01',
        fecha_anterior: '2026-09-30',
        confirmar: true,
      },
      'u-1',
      Rol.FACTURACION,
    );
    expect(r).toMatchObject({
      fecha_gasto: '2026-10-01',
      fecha_anterior: '2026-09-30',
      cambio: true,
      cambia_de_mes: true,
      aviso: SEP_TERMINO,
    });
    expect(de(llamadas, 'gasto', 'update')[0].args[0]).toEqual({
      fecha_gasto: '2026-10-01',
      updated_by: 'u-1',
    });
    expect(intentarCruzarGasto).not.toHaveBeenCalled();
  });

  it('GAS con hora de carga ⇒ el UPDATE lleva fecha_hora_carga a la misma hora Cancún del día nuevo', async () => {
    const gas = {
      ...REFACCION,
      categoria: 'GAS',
      fecha_hora_carga: '2026-09-30T12:40:00+00:00', // 07:40 Cancún
    };
    const { service, llamadas } = armar({
      gasto: [
        { data: gas },
        {
          data: filaActualizada({
            fecha_gasto: '2026-10-01',
            fecha_hora_carga: '2026-10-01T12:40:00+00:00',
          }),
        },
      ],
      aeronave: [{ data: [{ id: N41, matricula: 'N4142R' }] }],
    });
    const r = await service.cambiarFechaGasto(
      G,
      {
        fecha_gasto: '2026-10-01',
        fecha_anterior: '2026-09-30',
        confirmar: true,
      },
      'u-1',
      Rol.ADMIN,
    );
    expect(de(llamadas, 'gasto', 'update')[0].args[0]).toEqual({
      fecha_gasto: '2026-10-01',
      fecha_hora_carga: '2026-10-01T12:40:00.000Z',
      updated_by: 'u-1',
    });
    expect(r.fecha_hora_carga).toBe('2026-10-01T12:40:00+00:00');
  });

  it('gasto_reparto se lee SOLO con categorías repartibles (OTRO sí; TAXI no, ver el caso Winjet)', async () => {
    const otro = {
      ...REFACCION,
      categoria: 'OTRO',
      aeronave_id: null,
      fecha_gasto: '2026-10-03',
    };
    const { service, llamadas } = armar({
      gasto: [
        { data: otro },
        { data: filaActualizada({ fecha_gasto: '2026-10-12' }) },
      ],
      gasto_reparto: [
        { data: [{ gasto_id: G, aeronave_id: N41, monto: '600.00' }] },
      ],
    });
    const r = await service.cambiarFechaGasto(
      G,
      { fecha_gasto: '2026-10-12', fecha_anterior: '2026-10-03' },
      'u-1',
      Rol.ADMIN,
    );
    expect(r.cambio).toBe(true);
    expect(de(llamadas, 'gasto_reparto', 'in').map((l) => l.args)).toEqual([
      ['gasto_id', [G]],
    ]);
  });

  it('la lectura de matrículas falla (error o red caída) ⇒ warn y textos «del avión», nunca un 500', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    for (const aeronave of [
      { error: { message: 'timeout' } },
      { lanza: new Error('socket hang up') },
    ] as Resultado[]) {
      const { service } = armar({
        gasto: [{ data: REFACCION }],
        aeronave: [aeronave],
      });
      const e = await rechazo(
        service.cambiarFechaGasto(
          G,
          { fecha_gasto: '2026-10-01', fecha_anterior: '2026-09-30' },
          'u-1',
          Rol.ADMIN,
        ),
      );
      expect(e.getStatus()).toBe(409);
      const { message } = e.getResponse() as { message: string };
      expect(message).toContain('En el balance del avión pasa a octubre 2026.');
      expect(message).toContain(
        'En el reparto a socios del avión pasa a octubre 2026.',
      );
    }
    expect(warn).toHaveBeenCalledWith(
      'Cambio de fecha sin matrículas: timeout',
    );
    expect(warn).toHaveBeenCalledWith(
      'Cambio de fecha sin matrículas: socket hang up',
    );
  });
});

describe('borde de 365 días: la ruta y update() coinciden (y la ruta no revienta dentro de update())', () => {
  /** TAXI en dólares sin vuelo ni avión: ningún libro pide confirmar. */
  const VIEJO = {
    ...WINJET,
    moneda: 'USD',
    vuelo_id: null,
    vuelo: null,
    aeronave_id: null,
    fecha_gasto: '2025-10-20',
  };

  it('PATCH general (banda de oficina de update(), sin tocar): 365 días atrás pasa y 366 rebota — el MISMO borde de la ruta', async () => {
    const ok = armar({
      gasto: [{ data: filaActualizada({ fecha_gasto: '2025-10-14' }) }],
    });
    await expect(
      ok.service.update(G, { fecha_gasto: '2025-10-14' }, 'u-1', Rol.ADMIN),
    ).resolves.toBeDefined();
    const viejo = armar({});
    const e = await rechazo(
      viejo.service.update(G, { fecha_gasto: '2025-10-13' }, 'u-1', Rol.ADMIN),
    );
    expect(e).toBeInstanceOf(BadRequestException);
    expect(String(e.message)).toContain('es de hace más de un año');
  });

  it('la medianoche de Cancún cae ENTRE la validación y la escritura: la fecha de justo 365 días que la ruta aceptó se escribe (sin el 400 del PATCH general)', async () => {
    // 23:59:59.900 del 13-oct en Cancún: hoy = 2026-10-13 y 2025-10-13 está
    // a 365 días exactos.
    jest.setSystemTime(new Date('2026-10-14T04:59:59.900Z'));
    const { service, llamadas } = armar({
      gasto: [
        {
          data: VIEJO,
          // Mientras se lee el gasto el reloj cruza a las 00:00:00.100 del
          // 14-oct: para update() 2025-10-13 ya estaría a 366 días.
          alResolver: () =>
            jest.setSystemTime(new Date('2026-10-14T05:00:00.100Z')),
        },
        { data: filaActualizada({ fecha_gasto: '2025-10-13' }) },
      ],
    });
    const r = await service.cambiarFechaGasto(
      G,
      { fecha_gasto: '2025-10-13', fecha_anterior: '2025-10-20' },
      'u-1',
      Rol.ADMIN,
    );
    expect(r).toMatchObject({ cambio: true, fecha_gasto: '2025-10-13' });
    expect(de(llamadas, 'gasto', 'update')[0].args[0]).toEqual({
      fecha_gasto: '2025-10-13',
      updated_by: 'u-1',
    });
  });
});
