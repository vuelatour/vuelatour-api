// Módulos pesados que expenses.service importa solo para inyección.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { ExpensesService } from './expenses.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CreateGastoDto } from './dto/expenses.dto';
import { Rol } from '../../common/types/auth.types';
import { fakeCierre, type Fila } from '../../common/cierre-mes.fixture-spec';

/**
 * GASTOS «POR PAGAR» (19-oct-2026, API 0.0.95, invariante 93) en el servicio
 * de gastos, con una BD EN MEMORIA (el mini-PostgREST del cierre de mes, SIN
 * la migración del cierre) envuelta para (a) emular la migración
 * 20261019000001 —default `por_pagar = false` al insertar— o su AUSENCIA
 * —42703 a todo select que nombre la columna— y (b) registrar TODA consulta
 * que la nombre (select, filtro, insert, update).
 *
 * Reloj: lunes 19-oct-2026 10:00 Cancún (salvo el caso del último día del
 * mes). La semana de captura de los gastos sembrados (5-oct) ya pasó.
 */

const PILOTO = 'u-piloto';
const OTRO = 'u-otro';
const ADMIN = 'u-admin';

const gasto = (id: string, extra: Fila = {}): Fila => ({
  id,
  categoria: 'OTRO',
  monto: 500,
  propina: 0,
  moneda: 'MXN',
  tc_gasto: null,
  fecha_gasto: '2026-10-15',
  medio_pago: 'EFECTIVO',
  tarjeta_terminacion: null,
  vuelo_id: null,
  escala_id: null,
  aeronave_id: null,
  conciliado: false,
  por_pagar: false,
  compra_id: null,
  notas: null,
  fecha_hora_carga: null,
  usuario_captura_id: PILOTO,
  created_at: '2026-10-05T15:00:00Z',
  updated_at: '2026-10-05T15:00:00Z',
  ...extra,
});

function mundo(): Record<string, Fila[]> {
  return {
    usuario: [
      { id: PILOTO, nombre: 'Luis Piloto', gastos_sin_limite_hasta: null },
      { id: OTRO, nombre: 'Otro Piloto', gastos_sin_limite_hasta: null },
      { id: ADMIN, nombre: 'Ale', gastos_sin_limite_hasta: null },
    ],
    gasto: [
      gasto('g-futuro', { por_pagar: true, fecha_gasto: '2026-10-25' }),
      gasto('g-vencido', { por_pagar: true, fecha_gasto: '2026-10-15' }),
      gasto('g-conc', {
        por_pagar: true,
        conciliado: true,
        medio_pago: 'TRANSFERENCIA',
        fecha_gasto: '2026-10-25',
      }),
      gasto('g-pagado', { fecha_gasto: '2026-10-14' }),
      gasto('g-gas', {
        categoria: 'GAS',
        aeronave_id: 'av-1',
        por_pagar: true,
        fecha_gasto: '2026-10-25',
        // 09:00 Cancún del 25-oct.
        fecha_hora_carga: '2026-10-25T14:00:00.000Z',
      }),
    ],
  };
}

type Registro = string[];

const ALTAS = new WeakMap<object, Fila[]>();

/** Cadena que responde 42703 en cualquier terminal (la columna no existe). */
function consultaSinColumna(): Record<string, unknown> {
  const r = {
    data: null,
    error: { code: '42703', message: 'column gasto.por_pagar does not exist' },
  };
  const q: Record<string, unknown> = {};
  for (const m of [
    'select',
    'eq',
    'neq',
    'in',
    'is',
    'or',
    'gte',
    'lte',
    'gt',
    'lt',
    'not',
    'order',
    'limit',
    'range',
  ]) {
    q[m] = () => q;
  }
  q.maybeSingle = () => Promise.resolve(r);
  q.single = () => Promise.resolve(r);
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(r).then(res, rej);
  return q;
}

function armar(
  opts: {
    sinPorPagar?: boolean;
    ultimaReposicion?: string | null;
    /** Con el módulo de conciliación (auto-cruce con el banco). */
    conCruce?: boolean;
  } = {},
) {
  const m = mundo();
  // Sin la migración la columna no existe: las filas no la traen.
  if (opts.sinPorPagar) for (const g of m.gasto) delete g.por_pagar;
  const f = fakeCierre(m, { sinMigracion: true });
  const registro: Registro = [];
  const originales: Fila[] = [];
  ALTAS.set(f, originales);
  const nombra = (x: unknown) =>
    typeof x === 'string' && /\bpor_pagar\b/.test(x);
  const from = (tabla: string) => {
    const q = f.service.from(tabla) as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const sel = q.select;
    q.select = (cols?: unknown, ...resto: unknown[]) => {
      if (nombra(cols)) {
        registro.push(`${tabla}.select(${String(cols)})`);
        if (opts.sinPorPagar) return consultaSinColumna();
      }
      return sel(cols, ...resto);
    };
    for (const m of ['eq', 'neq', 'is', 'or', 'in']) {
      const orig = q[m];
      q[m] = (...a: unknown[]) => {
        if (nombra(a[0])) registro.push(`${tabla}.${m}(${String(a[0])})`);
        return orig(...a);
      };
    }
    const ins = q.insert;
    q.insert = (v: unknown) => {
      const filas = (Array.isArray(v) ? v : [v]) as Fila[];
      const conDefault = filas.map((fila) => {
        if ('por_pagar' in fila) registro.push(`${tabla}.insert(por_pagar)`);
        if (tabla === 'gasto') originales.push({ ...fila });
        // Default de la columna (con la migración).
        return tabla === 'gasto' && !opts.sinPorPagar && !('por_pagar' in fila)
          ? { ...fila, por_pagar: false }
          : fila;
      });
      return ins(Array.isArray(v) ? conDefault : conDefault[0]);
    };
    const upd = q.update;
    q.update = (v: unknown) => {
      if (v && typeof v === 'object' && 'por_pagar' in v)
        registro.push(`${tabla}.update(por_pagar)`);
      return upd(v);
    };
    return q;
  };
  const notifications = {
    notifyRole: jest.fn().mockResolvedValue(1),
    notifyUser: jest.fn().mockResolvedValue(true),
  };
  const cajaChica = {
    fechaUltimaReposicionDe: jest
      .fn()
      .mockResolvedValue(opts.ultimaReposicion ?? null),
  };
  const conciliacion = {
    intentarCruzarGasto: jest.fn().mockResolvedValue({ ligado: false }),
  };
  const nada = {} as never;
  const service = new ExpensesService(
    { service: { from } } as unknown as SupabaseService,
    notifications as never,
    nada,
    nada,
    { numero: jest.fn().mockResolvedValue(1) } as never,
    cajaChica as never,
    nada,
    opts.conCruce ? (conciliacion as never) : undefined,
  );
  return { service, f, registro, cajaChica, conciliacion };
}

const fila = (f: ReturnType<typeof fakeCierre>, id: string) =>
  (f.tablas.gasto ?? []).find((g) => g.id === id) as Fila;
const escrituras = (f: ReturnType<typeof fakeCierre>, id: string) =>
  f.escrituras.filter((e) => e.tabla === 'gasto' && e.valores.id === id);
/** Payloads de alta de `gasto` TAL CUAL los mandó el servicio. */
const altas = (f: ReturnType<typeof fakeCierre>) =>
  (ALTAS.get(f) ?? []).map((valores) => ({ valores }));

async function error(p: Promise<unknown>): Promise<{
  status: number | null;
  code: string | null;
  message: string | null;
}> {
  try {
    await p;
  } catch (e) {
    const ex = e as {
      getStatus?: () => number;
      getResponse?: () => unknown;
      message?: string;
    };
    const r = ex.getResponse?.();
    const cuerpo =
      r && typeof r === 'object'
        ? (r as { error?: string; message?: string })
        : null;
    return {
      status: ex.getStatus?.() ?? null,
      code: cuerpo?.error ?? null,
      message:
        (typeof cuerpo?.message === 'string' ? cuerpo.message : null) ??
        ex.message ??
        null,
    };
  }
  throw new Error('se esperaba un rechazo');
}

const alta = (extra: Partial<CreateGastoDto> = {}): CreateGastoDto =>
  ({
    categoria: 'OTRO',
    monto: 350,
    moneda: 'MXN',
    medio_pago: 'EFECTIVO',
    fecha_gasto: '2026-10-24',
    notas: 'Taxi del sábado',
    ...extra,
  }) as unknown as CreateGastoDto;

const reloj = (iso: string) =>
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate'],
    now: new Date(iso),
  });

beforeEach(() => reloj('2026-10-19T15:00:00Z')); // lunes 10:00 Cancún
afterEach(() => jest.useRealTimers());

describe('ExpensesService — alta de un gasto «por pagar»', () => {
  it('PILOTO con fecha futura del mes ⇒ nace por pagar (sin mandar la llave)', async () => {
    const { service, f } = armar();
    const r = (await service.create(alta(), PILOTO, Rol.PILOTO)) as Fila;
    const [ins] = altas(f);
    expect(ins.valores.por_pagar).toBe(true);
    expect(r.por_pagar).toBe(true);
    expect(r.estado_pago).toBe('POR_PAGAR');
  });

  it('PILOTO con fecha DESPUÉS de fin de mes ⇒ 400 con el texto exacto y sin insertar', async () => {
    const { service, f } = armar();
    const e = await error(
      service.create(alta({ fecha_gasto: '2026-11-01' }), PILOTO, Rol.PILOTO),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe(
      'La fecha del gasto (01/11/2026) es después de fin de mes: los gastos por pagar se capturan a lo más hasta el último día del mes (31/10/2026).',
    );
    expect(altas(f)).toHaveLength(0);
  });

  it('el ÚLTIMO día del mes, el campo sigue aceptando mañana (y no pasado mañana)', async () => {
    reloj('2026-10-31T15:00:00Z');
    const { service, f } = armar();
    const r = (await service.create(
      alta({ fecha_gasto: '2026-11-01' }),
      PILOTO,
      Rol.PILOTO,
    )) as Fila;
    expect(r.estado_pago).toBe('POR_PAGAR');
    const e = await error(
      service.create(
        alta({ fecha_gasto: '2026-11-02', notas: 'otro' }),
        PILOTO,
        Rol.PILOTO,
      ),
    );
    expect(e.status).toBe(400);
    expect(e.message).toContain('es después de fin de mes');
    expect(altas(f)).toHaveLength(1);
  });

  it('OFICINA: +30 intacto (hoy + 30 pasa por pagar; + 31 ⇒ 400 de siempre)', async () => {
    const { service, f } = armar();
    const r = (await service.create(
      alta({ fecha_gasto: '2026-11-18' }),
      ADMIN,
      Rol.ADMIN,
    )) as Fila;
    expect(r.estado_pago).toBe('POR_PAGAR');
    const e = await error(
      service.create(
        alta({ fecha_gasto: '2026-11-19', notas: 'otro' }),
        ADMIN,
        Rol.ADMIN,
      ),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe(
      'La fecha del gasto (19/11/2026) está a más de 30 días en el futuro: revisa el AÑO/mes antes de guardar.',
    );
    expect(altas(f)).toHaveLength(1);
  });

  it('`por_pagar: false` con fecha futura ⇒ 400 POR_PAGAR_FECHA_FUTURA sin insertar', async () => {
    const { service, f } = armar();
    const e = await error(
      service.create(alta({ por_pagar: false }), ADMIN, Rol.ADMIN),
    );
    expect(e).toEqual({
      status: 400,
      code: 'POR_PAGAR_FECHA_FUTURA',
      message:
        'Un gasto con fecha futura queda por pagar: márcalo pagado el día que lo pagues (la fecha del gasto es la del pago).',
    });
    expect(altas(f)).toHaveLength(0);
  });

  it('fecha de hoy sin la llave ⇒ pagado (el insert no la nombra); con `true` ⇒ «lo pago al rato»', async () => {
    const { service, f } = armar();
    const r1 = (await service.create(
      alta({ fecha_gasto: '2026-10-19' }),
      ADMIN,
      Rol.ADMIN,
    )) as Fila;
    expect('por_pagar' in altas(f)[0].valores).toBe(false);
    expect(r1.estado_pago).toBe('PAGADO');
    const r2 = (await service.create(
      alta({ fecha_gasto: '2026-10-19', por_pagar: true, notas: 'luego' }),
      ADMIN,
      Rol.ADMIN,
    )) as Fila;
    expect(altas(f)[1].valores.por_pagar).toBe(true);
    expect(r2.estado_pago).toBe('POR_PAGAR');
  });

  it('`por_pagar: null` = ausente', async () => {
    const { service, f } = armar();
    await service.create(
      alta({ fecha_gasto: '2026-10-19', por_pagar: null }),
      ADMIN,
      Rol.ADMIN,
    );
    expect('por_pagar' in altas(f)[0].valores).toBe(false);
  });

  it('outbox TARDÍO: capturado el 17 con fecha del 18 y subido el 19 ⇒ sigue por pagar (VENCIDO)', async () => {
    const { service, f } = armar();
    const r = (await service.create(
      alta({
        fecha_gasto: '2026-10-18',
        capturado_en: '2026-10-17T10:00:00-05:00',
      }),
      PILOTO,
      Rol.PILOTO,
    )) as Fila;
    expect(altas(f)[0].valores.por_pagar).toBe(true);
    expect(r.estado_pago).toBe('VENCIDO');
  });
});

describe('ExpensesService — «marcar pagado» (PATCH por_pagar: false)', () => {
  it('fecha futura sin fecha enviada ⇒ el pago es HOY (escribe por_pagar false + fecha)', async () => {
    const { service, f } = armar();
    const r = (await service.update(
      'g-futuro',
      { por_pagar: false },
      ADMIN,
      Rol.ADMIN,
    )) as Fila;
    const [w] = escrituras(f, 'g-futuro');
    expect(w.valores.por_pagar).toBe(false);
    expect(w.valores.fecha_gasto).toBe('2026-10-19');
    expect(r.estado_pago).toBe('PAGADO');
    expect(fila(f, 'g-futuro').fecha_gasto).toBe('2026-10-19');
  });

  it('VENCIDO sin fecha enviada ⇒ conserva su fecha (solo baja la bandera)', async () => {
    const { service, f } = armar();
    await service.update('g-vencido', { por_pagar: false }, ADMIN, Rol.ADMIN);
    const [w] = escrituras(f, 'g-vencido');
    expect(w.valores.por_pagar).toBe(false);
    expect('fecha_gasto' in w.valores).toBe(false);
    expect(fila(f, 'g-vencido').fecha_gasto).toBe('2026-10-15');
  });

  it('con la fecha REAL del pago (≤ hoy) ⇒ esa fecha', async () => {
    const { service, f } = armar();
    await service.update(
      'g-futuro',
      { por_pagar: false, fecha_gasto: '2026-10-17' },
      ADMIN,
      Rol.ADMIN,
    );
    expect(escrituras(f, 'g-futuro')[0].valores).toMatchObject({
      por_pagar: false,
      fecha_gasto: '2026-10-17',
    });
  });

  it('fecha del pago FUTURA ⇒ 400 POR_PAGAR_FECHA_FUTURA sin escribir', async () => {
    const { service, f } = armar();
    const e = await error(
      service.update(
        'g-futuro',
        { por_pagar: false, fecha_gasto: '2026-10-20' },
        ADMIN,
        Rol.ADMIN,
      ),
    );
    expect(e.code).toBe('POR_PAGAR_FECHA_FUTURA');
    expect(e.status).toBe(400);
    expect(escrituras(f, 'g-futuro')).toHaveLength(0);
  });

  it('la hora de la carga se mueve a la MISMA hora de pared del día nuevo', async () => {
    const { service, f } = armar();
    await service.update('g-gas', { por_pagar: false }, ADMIN, Rol.ADMIN);
    expect(escrituras(f, 'g-gas')[0].valores).toMatchObject({
      por_pagar: false,
      fecha_gasto: '2026-10-19',
      fecha_hora_carga: '2026-10-19T14:00:00.000Z',
    });
  });

  it('re-programar (`true`) un pagado ⇒ escribe; uno CONCILIADO ⇒ 409 GASTO_CONCILIADO', async () => {
    const { service, f } = armar();
    await service.update('g-pagado', { por_pagar: true }, ADMIN, Rol.ADMIN);
    expect(escrituras(f, 'g-pagado')[0].valores.por_pagar).toBe(true);
    const e = await error(
      service.update('g-conc', { por_pagar: true }, ADMIN, Rol.ADMIN),
    );
    expect(e).toEqual({
      status: 409,
      code: 'GASTO_CONCILIADO',
      message:
        'Este gasto ya está conciliado con el banco: el cargo es su pago y no se pone «por pagar». Si ese cargo no es su pago, desvincúlalo primero en Conciliación.',
    });
    expect(escrituras(f, 'g-conc')).toHaveLength(0);
  });

  it('mover la fecha de un pagado a > hoy lo pone por pagar SOLO; reenviar la misma fecha no toca la bandera', async () => {
    const { service, f } = armar();
    await service.update(
      'g-pagado',
      { fecha_gasto: '2026-10-28' },
      ADMIN,
      Rol.ADMIN,
    );
    expect(escrituras(f, 'g-pagado')[0].valores).toMatchObject({
      fecha_gasto: '2026-10-28',
      por_pagar: true,
    });
    await service.update(
      'g-futuro',
      { fecha_gasto: '2026-10-25', notas: 'verificado' },
      ADMIN,
      Rol.ADMIN,
    );
    expect('por_pagar' in escrituras(f, 'g-futuro')[0].valores).toBe(false);
  });

  it('`false` sobre un pagado con fecha futura heredada ⇒ 400; sobre un pagado de ayer ⇒ nada que escribir', async () => {
    const { service, f } = armar();
    f.tablas.gasto.push(gasto('g-viejo', { fecha_gasto: '2026-10-21' }));
    const e = await error(
      service.update('g-viejo', { por_pagar: false }, ADMIN, Rol.ADMIN),
    );
    expect(e.code).toBe('POR_PAGAR_FECHA_FUTURA');
    await service.update('g-pagado', { por_pagar: false }, ADMIN, Rol.ADMIN);
    expect(escrituras(f, 'g-pagado')).toHaveLength(0);
  });
});

describe('ExpensesService.assertOwnEnVentana — excepción del dueño al marcar pagado', () => {
  it('fuera de su semana: SOLO marcar pagado pasa; cualquier otra corrección ⇒ 403', async () => {
    const { service } = armar();
    await expect(
      service.assertOwnEnVentana('g-futuro', PILOTO, undefined, {
        marcarPagado: true,
      }),
    ).resolves.toBeUndefined();
    const e = await error(service.assertOwnEnVentana('g-futuro', PILOTO));
    expect(e.code).toBe('GASTO_FUERA_DE_VENTANA');
    expect(e.status).toBe(403);
  });

  it('la excepción exige que el gasto VIGENTE esté por pagar (un pagado viejo con OTRA fecha ⇒ 403)', async () => {
    const { service } = armar();
    // Revisión P6: sin fecha (o con la misma) ya no es 403 sino réplica
    // idempotente (caso de abajo); con otra fecha el PATCH sí cambiaría el
    // gasto y la ventana manda.
    const e = await error(
      service.assertOwnEnVentana('g-pagado', PILOTO, undefined, {
        marcarPagado: true,
        fechaPago: '2026-10-18',
      }),
    );
    expect(e.code).toBe('GASTO_FUERA_DE_VENTANA');
  });

  it('réplica de un «marcar pagado» ya aplicado (sin fecha o con la misma) ⇒ pasa sin ventana y el PATCH no escribe', async () => {
    const { service, f } = armar();
    for (const fechaPago of [undefined, null, '2026-10-14']) {
      await expect(
        service.assertOwnEnVentana('g-pagado', PILOTO, undefined, {
          marcarPagado: true,
          fechaPago,
        }),
      ).resolves.toBeUndefined();
    }
    const r = (await service.update(
      'g-pagado',
      {
        por_pagar: false,
        fecha_gasto: '2026-10-14',
        if_updated_at: '2026-10-01T00:00:00.000Z',
        capturado_en: '2026-10-17T09:00:00-05:00',
      },
      PILOTO,
      Rol.PILOTO,
    )) as Fila;
    expect(r).toMatchObject({ id: 'g-pagado', estado_pago: 'PAGADO' });
    // Ni la línea del sello tardío ni el CAS con la versión vieja (409).
    expect(escrituras(f, 'g-pagado')).toHaveLength(0);
  });

  it('un CONCILIADO nunca es réplica (409 GASTO_CONCILIADO de siempre)', async () => {
    const { service } = armar();
    const e = await error(
      service.assertOwnEnVentana('g-conc', PILOTO, undefined, {
        marcarPagado: true,
      }),
    );
    expect(e).toMatchObject({ status: 409, code: 'GASTO_CONCILIADO' });
  });

  it('AJENO ⇒ 403 GASTO_AJENO aunque sea marcar pagado', async () => {
    const { service } = armar();
    const e = await error(
      service.assertOwnEnVentana('g-futuro', OTRO, undefined, {
        marcarPagado: true,
      }),
    );
    expect(e).toMatchObject({ status: 403, code: 'GASTO_AJENO' });
  });

  it('caja chica: la fecha REAL del pago decide la reposición (hoy ya repuesto ⇒ 409; ayer ⇒ pasa)', async () => {
    const primero = armar({ ultimaReposicion: '2026-10-19' });
    const { cajaChica } = primero;
    let { service } = primero;
    const e = await error(
      service.assertOwnEnVentana('g-futuro', PILOTO, undefined, {
        marcarPagado: true,
      }),
    );
    expect(e).toMatchObject({ status: 409, code: 'GASTO_EN_REPOSICION' });
    expect(cajaChica.fechaUltimaReposicionDe).toHaveBeenCalledWith(
      PILOTO,
      'MXN',
    );
    ({ service } = armar({ ultimaReposicion: '2026-10-18' }));
    await expect(
      service.assertOwnEnVentana('g-futuro', PILOTO, undefined, {
        marcarPagado: true,
        fechaPago: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('el PATCH del dueño fuera de su semana escribe por_pagar false con la fecha de hoy', async () => {
    const { service, f } = armar();
    await service.assertOwnEnVentana('g-futuro', PILOTO, undefined, {
      marcarPagado: true,
    });
    await service.update('g-futuro', { por_pagar: false }, PILOTO, Rol.PILOTO);
    expect(escrituras(f, 'g-futuro')[0].valores).toMatchObject({
      por_pagar: false,
      fecha_gasto: '2026-10-19',
    });
  });
});

describe('ExpensesService — gasto CONCILIADO y fecha futura (revisión P9)', () => {
  const MENSAJE =
    'Este gasto ya está conciliado con el banco: su fecha es la del cargo y no puede quedar en el futuro (quedaría «por pagar»). Si ese cargo no es su pago, desvincúlalo primero en Conciliación.';
  const conciliadoPagado = (extra: Fila = {}) =>
    gasto('g-conc-pagado', {
      conciliado: true,
      medio_pago: 'TRANSFERENCIA',
      fecha_gasto: '2026-10-14',
      ...extra,
    });

  it('mover a FUTURO la fecha de un conciliado (sin mandar `por_pagar`) ⇒ 409 GASTO_CONCILIADO y nada se escribe', async () => {
    const { service, f } = armar();
    f.tablas.gasto.push(conciliadoPagado());
    const e = await error(
      service.update(
        'g-conc-pagado',
        { fecha_gasto: '2026-10-25' },
        ADMIN,
        Rol.ADMIN,
      ),
    );
    expect(e).toEqual({
      status: 409,
      code: 'GASTO_CONCILIADO',
      message: MENSAJE,
    });
    expect(escrituras(f, 'g-conc-pagado')).toHaveLength(0);
  });

  it('con una fecha ≤ hoy pasa sin tocar `por_pagar`', async () => {
    const { service, f } = armar();
    f.tablas.gasto.push(conciliadoPagado());
    await service.update(
      'g-conc-pagado',
      { fecha_gasto: '2026-10-16' },
      ADMIN,
      Rol.ADMIN,
    );
    const [w] = escrituras(f, 'g-conc-pagado');
    expect(w.valores.fecha_gasto).toBe('2026-10-16');
    expect('por_pagar' in w.valores).toBe(false);
  });

  it('un conciliado con fecha futura de antes (dato viejo) que reenvía SU fecha no se vuelve «por pagar»', async () => {
    const { service, f } = armar();
    f.tablas.gasto.push(conciliadoPagado({ fecha_gasto: '2026-10-21' }));
    await service.update(
      'g-conc-pagado',
      { fecha_gasto: '2026-10-21', notas: 'factura recibida' },
      ADMIN,
      Rol.ADMIN,
    );
    const [w] = escrituras(f, 'g-conc-pagado');
    expect(w.valores.notas).toBe('factura recibida');
    expect('por_pagar' in w.valores).toBe(false);
    expect(fila(f, 'g-conc-pagado').por_pagar).toBe(false);
  });
});

describe('ExpensesService.generarPistas — pistas con aterrizaje FUTURO (revisión P11)', () => {
  const escala = (id: string, fechaSalidaPlan: string): Fila => ({
    id,
    vuelo_id: 'v-1',
    destino_iata: 'MID',
    hora_llegada: null,
    fecha_salida_plan: fechaSalidaPlan,
    aeronave_id: 'av-1',
    vuelo: { aeronave_id: 'av-1' },
  });
  const pistas = (...ids: string[]) =>
    ({
      items: ids.map((escala_id) => ({ escala_id, monto: 1200 })),
    }) as never;

  it('aterrizaje del 25-oct ⇒ la cuota nace POR PAGAR; la de ayer, pagada (sin nombrar la columna)', async () => {
    const { service, f } = armar();
    f.tablas.escala = [
      escala('e-futura', '2026-10-25T15:00:00Z'),
      escala('e-ayer', '2026-10-18T15:00:00Z'),
    ];
    const r = await service.generarPistas(pistas('e-futura', 'e-ayer'), ADMIN);
    expect(r.creados).toBe(2);
    const [futura, ayer] = altas(f).map((a) => a.valores);
    expect(futura).toMatchObject({
      fecha_gasto: '2026-10-25',
      por_pagar: true,
    });
    expect(ayer.fecha_gasto).toBe('2026-10-18');
    expect('por_pagar' in ayer).toBe(false);
  });

  it('SIN la migración: el insert de siempre (ninguna consulta nombra la columna salvo la sonda)', async () => {
    const { service, f, registro } = armar({ sinPorPagar: true });
    f.tablas.escala = [escala('e-futura', '2026-10-25T15:00:00Z')];
    const r = await service.generarPistas(pistas('e-futura'), ADMIN);
    expect(r.creados).toBe(1);
    expect('por_pagar' in altas(f)[0].valores).toBe(false);
    expect(registro.filter((x) => x !== 'gasto.select(por_pagar)')).toEqual([]);
  });
});

describe('ExpensesService — auto-cruce con el banco y por pagar VIGENTE (revisión P14a)', () => {
  const bancario = (id: string, extra: Fila = {}) =>
    gasto(id, { medio_pago: 'TRANSFERENCIA', ...extra });

  it('ALTA con fecha futura (nace por pagar) ⇒ NO busca cargo; con la de hoy sí', async () => {
    const { service, conciliacion } = armar({ conCruce: true });
    await service.create(
      alta({ medio_pago: 'TRANSFERENCIA' } as Partial<CreateGastoDto>),
      ADMIN,
      Rol.ADMIN,
    );
    expect(conciliacion.intentarCruzarGasto).not.toHaveBeenCalled();
    const hoy = (await service.create(
      alta({
        medio_pago: 'TRANSFERENCIA',
        fecha_gasto: '2026-10-19',
        notas: 'pagado hoy',
      } as Partial<CreateGastoDto>),
      ADMIN,
      Rol.ADMIN,
    )) as Fila;
    expect(conciliacion.intentarCruzarGasto).toHaveBeenCalledTimes(1);
    expect(conciliacion.intentarCruzarGasto).toHaveBeenCalledWith(
      hoy.id,
      ADMIN,
    );
  });

  it('ALTA «lo pago al rato» (`por_pagar: true` con fecha de hoy) ⇒ NO busca cargo', async () => {
    const { service, conciliacion } = armar({ conCruce: true });
    await service.create(
      alta({
        medio_pago: 'TRANSFERENCIA',
        fecha_gasto: '2026-10-19',
        por_pagar: true,
      } as Partial<CreateGastoDto>),
      ADMIN,
      Rol.ADMIN,
    );
    expect(conciliacion.intentarCruzarGasto).not.toHaveBeenCalled();
  });

  it('PATCH que mueve un pagado a FUTURO (queda por pagar) ⇒ NO busca cargo', async () => {
    const { service, f, conciliacion } = armar({ conCruce: true });
    f.tablas.gasto.push(bancario('g-banco', { fecha_gasto: '2026-10-14' }));
    await service.update(
      'g-banco',
      { fecha_gasto: '2026-10-28' },
      ADMIN,
      Rol.ADMIN,
    );
    expect(fila(f, 'g-banco').por_pagar).toBe(true);
    expect(conciliacion.intentarCruzarGasto).not.toHaveBeenCalled();
  });

  it('MARCAR PAGADO sí lo cruza: con la fecha real y también un VENCIDO que conserva su fecha', async () => {
    const { service, f, conciliacion } = armar({ conCruce: true });
    f.tablas.gasto.push(
      bancario('g-banco-futuro', {
        por_pagar: true,
        fecha_gasto: '2026-10-25',
      }),
      bancario('g-banco-vencido', {
        por_pagar: true,
        fecha_gasto: '2026-10-15',
      }),
    );
    await service.update(
      'g-banco-futuro',
      { por_pagar: false, fecha_gasto: '2026-10-18' },
      ADMIN,
      Rol.ADMIN,
    );
    expect(conciliacion.intentarCruzarGasto).toHaveBeenLastCalledWith(
      'g-banco-futuro',
      ADMIN,
    );
    await service.update(
      'g-banco-vencido',
      { por_pagar: false },
      ADMIN,
      Rol.ADMIN,
    );
    expect(escrituras(f, 'g-banco-vencido')[0].valores).toEqual({
      id: 'g-banco-vencido',
      por_pagar: false,
      updated_by: ADMIN,
    });
    expect(conciliacion.intentarCruzarGasto).toHaveBeenLastCalledWith(
      'g-banco-vencido',
      ADMIN,
    );
    expect(conciliacion.intentarCruzarGasto).toHaveBeenCalledTimes(2);
  });
});

describe('ExpensesService — lecturas con la migración', () => {
  it('CONCILIADO ⇒ PAGADO aunque la columna siga en true; cada fila con estado_pago', async () => {
    const { service } = armar();
    const g = (await service.findById('g-conc')) as Fila;
    expect(g.por_pagar).toBe(true);
    expect(g.estado_pago).toBe('PAGADO');
    const v = (await service.findById('g-vencido')) as Fila;
    expect(v.estado_pago).toBe('VENCIDO');
  });

  it('`?por_pagar=1` ⇒ estado ≠ PAGADO; `false` ⇒ los demás', async () => {
    const { service } = armar();
    const base = { limit: 50, offset: 0 } as never;
    const si = await service.list({
      ...(base as object),
      por_pagar: true,
    } as never);
    expect(si.data.map((g) => g.id).sort()).toEqual([
      'g-futuro',
      'g-gas',
      'g-vencido',
    ]);
    expect(si.data.every((g) => g.estado_pago !== 'PAGADO')).toBe(true);
    const no = await service.list({
      ...(base as object),
      por_pagar: false,
    } as never);
    expect(no.data.map((g) => g.id).sort()).toEqual(['g-conc', 'g-pagado']);
    expect(no.data.every((g) => g.estado_pago === 'PAGADO')).toBe(true);
  });
});

describe('ExpensesService — SIN la migración 20261019000001 (0.0.94 byte a byte)', () => {
  const soloSonda = (r: Registro) =>
    r.filter((x) => x !== 'gasto.select(por_pagar)');

  it('campo: mañana pasa con el insert de siempre; pasado mañana ⇒ 400 de siempre', async () => {
    const { service, f, registro } = armar({ sinPorPagar: true });
    const r = (await service.create(
      alta({ fecha_gasto: '2026-10-20' }),
      PILOTO,
      Rol.PILOTO,
    )) as Fila;
    expect('por_pagar' in altas(f)[0].valores).toBe(false);
    expect('estado_pago' in r).toBe(false);
    const e = await error(
      service.create(
        alta({ fecha_gasto: '2026-10-21', notas: 'otro' }),
        PILOTO,
        Rol.PILOTO,
      ),
    );
    expect(e.message).toBe(
      'La fecha del gasto (21/10/2026) está en el futuro: revísala antes de guardar.',
    );
    expect(soloSonda(registro)).toEqual([]);
  });

  it('`por_pagar: true` ⇒ 503 POR_PAGAR_NO_DISPONIBLE sin insertar; `false` se ignora', async () => {
    const { service, f, registro } = armar({ sinPorPagar: true });
    const e = await error(
      service.create(
        alta({ fecha_gasto: '2026-10-19', por_pagar: true }),
        ADMIN,
        Rol.ADMIN,
      ),
    );
    expect(e).toEqual({
      status: 503,
      code: 'POR_PAGAR_NO_DISPONIBLE',
      message:
        'Los gastos por pagar todavía no están activos: avisa a sistemas.',
    });
    expect(altas(f)).toHaveLength(0);
    await service.create(
      alta({ fecha_gasto: '2026-10-25', por_pagar: false }),
      ADMIN,
      Rol.ADMIN,
    );
    expect('por_pagar' in altas(f)[0].valores).toBe(false);
    const p = await error(
      service.update('g-pagado', { por_pagar: true }, ADMIN, Rol.ADMIN),
    );
    expect(p.code).toBe('POR_PAGAR_NO_DISPONIBLE');
    await service.update(
      'g-pagado',
      { por_pagar: false, notas: 'x' },
      ADMIN,
      Rol.ADMIN,
    );
    expect('por_pagar' in escrituras(f, 'g-pagado')[0].valores).toBe(false);
    expect(soloSonda(registro)).toEqual([]);
  });

  it('lista, detalle y `?por_pagar=1` (vacía SIN leer gastos): ninguna consulta nombra la columna', async () => {
    const { service, f, registro } = armar({ sinPorPagar: true });
    const base = { limit: 50, offset: 0 };
    const todo = await service.list(base);
    expect(todo.data).toHaveLength(5);
    expect(todo.data.every((g) => !('estado_pago' in g))).toBe(true);
    const g = (await service.findById('g-futuro')) as Fila;
    expect('estado_pago' in g).toBe(false);
    const antes = f.consultas.length;
    const vacia = await service.list({ ...base, por_pagar: true });
    expect(vacia).toEqual({ data: [], count: 0, limit: 50, offset: 0 });
    expect(f.consultas.length).toBe(antes);
    const todos = await service.list({ ...base, por_pagar: false });
    expect(todos.data).toHaveLength(5);
    expect(soloSonda(registro)).toEqual([]);
  });
});
