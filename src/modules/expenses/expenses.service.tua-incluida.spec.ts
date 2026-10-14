// Mismos stubs que expenses.service.sin-vuelo.spec: notifications arrastra
// el gateway y `jose` (ESM puro), vision el SDK de IA y pyservices el
// cliente HTTP.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { HttpException, Logger } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CategoriaGasto, MedioPago, Moneda } from './dto/expenses.dto';
import type { CreateGastoDto, UpdateGastoDto } from './dto/expenses.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';

/**
 * «TUA incluida en este gasto» en Gastos (13-oct-2026, TUA sistémica,
 * invariante 66): campo de OFICINA con prioridad sobre la lectura de la IA,
 * detrás de la sonda ÚNICA de `gasto.tua_incluida` (migración
 * 20261013000008). Supabase se simula con un builder que REGISTRA cada
 * consulta (tabla + operaciones) y la resuelve por su forma; la sonda
 * (`select('tua_incluida').limit(1)`) responde 42703 con `sinMigracion`.
 */
type Fila = Record<string, unknown>;
type Op = [string, unknown[]];
interface Consulta {
  tabla: string;
  ops: Op[];
}

const VUELO = '11111111-1111-4111-8111-111111111111';
const AVION = '33333333-3333-4333-8333-333333333333';
const ID = 'g-1';
const HOY = new Date('2026-10-13T18:00:00Z'); // martes, 13:00 Cancún

const CONCEPTOS_383 = [
  { concepto: 'Operaciones', monto: 1365.64 },
  { concepto: 'Autobuses', monto: 559.63 },
];
const CONCEPTOS_ASUR_TUA = [
  { concepto: 'Operaciones', monto: 554.41 },
  { concepto: 'Tarifa TUA', monto: 1119.26 },
];

/** Gasto vigente (lo que lee `findById`). */
function gastoActual(extra: Fila = {}): Fila {
  return {
    id: ID,
    vuelo_id: VUELO,
    aeronave_id: AVION,
    escala_id: null,
    usuario_captura_id: 'u-piloto',
    categoria: 'OPERACIONES',
    monto: '1925.27',
    propina: '0.00',
    moneda: 'MXN',
    medio_pago: 'TRANSFERENCIA',
    tarjeta_terminacion: null,
    fecha_gasto: '2026-10-13',
    notas: 'ASUR CUN',
    valor_ia_extraido: { conceptos: CONCEPTOS_383 },
    tua_incluida: null,
    created_at: '2026-10-13T15:00:00Z',
    updated_at: '2026-10-13T15:00:00Z',
    ...extra,
  };
}

function armar(
  opts: {
    sinMigracion?: boolean;
    actual?: Fila;
    listado?: Fila[];
    /** Cargos del banco ligados (candado GASTO_CONCILIADO). */
    cargos?: number;
  } = {},
) {
  const consultas: Consulta[] = [];
  const resolver = (c: Consulta, single: boolean) => {
    const op = (m: string) => c.ops.find((o) => o[0] === m);
    const sel = op('select');
    if (c.tabla === 'gasto') {
      if (sel && sel[1][0] === 'tua_incluida') {
        return opts.sinMigracion
          ? {
              data: null,
              error: {
                code: '42703',
                message: 'column gasto.tua_incluida does not exist',
              },
            }
          : { data: [], error: null };
      }
      const ins = op('insert');
      if (ins) {
        return { data: { id: 'g-nuevo', ...(ins[1][0] as Fila) }, error: null };
      }
      const upd = op('update');
      if (upd) {
        return {
          data: { ...(opts.actual ?? {}), ...(upd[1][0] as Fila) },
          error: null,
        };
      }
      if (single) {
        const eqId = c.ops.find((o) => o[0] === 'eq' && o[1][0] === 'id');
        const fila =
          eqId && opts.actual && opts.actual.id === eqId[1][1]
            ? opts.actual
            : null;
        return { data: fila, error: null };
      }
      if (sel && String(sel[1][0]).includes('proveedor:proveedor')) {
        const filas = opts.listado ?? [];
        return { data: filas, error: null, count: filas.length };
      }
      return { data: [], error: null };
    }
    if (c.tabla === 'vuelo' && single) {
      return {
        data: { id: VUELO, folio: 383, aeronave_id: AVION, piloto_id: null },
        error: null,
      };
    }
    if (
      c.tabla === 'movimiento_bancario_gasto' ||
      c.tabla === 'movimiento_bancario'
    ) {
      return { data: [], error: null, count: opts.cargos ?? 0 };
    }
    return single ? { data: null, error: null } : { data: [], error: null };
  };
  const supabase = {
    service: {
      from: (tabla: string) => {
        const c: Consulta = { tabla, ops: [] };
        consultas.push(c);
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
          'delete',
          'ilike',
        ]) {
          q[m] = (...args: unknown[]) => {
            c.ops.push([m, args]);
            return q;
          };
        }
        q.maybeSingle = () => Promise.resolve(resolver(c, true));
        q.then = (
          res: (v: unknown) => unknown,
          rej?: (e: unknown) => unknown,
        ) => Promise.resolve(resolver(c, false)).then(res, rej);
        return q;
      },
    },
  } as unknown as SupabaseService;
  const notifications = {
    notifyRole: jest.fn().mockResolvedValue(undefined),
    notifyUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
  const pyservices = {
    generateTablaXlsx: jest.fn().mockResolvedValue(Buffer.from('xlsx')),
  };
  const configuracion = { numero: jest.fn().mockResolvedValue(1) };
  const nada = {} as never;
  const service = new ExpensesService(
    supabase,
    notifications,
    pyservices as never,
    nada,
    configuracion as never,
    nada,
    nada,
  );
  return { service, consultas, pyservices };
}

/** Las consultas a `gasto` con una operación dada. */
const conOp = (consultas: Consulta[], m: string) =>
  consultas.filter((c) => c.tabla === 'gasto' && c.ops.some((o) => o[0] === m));

/** Cuerpo del insert / update a `gasto` (el primero). */
const cuerpoDe = (consultas: Consulta[], m: 'insert' | 'update'): Fila =>
  conOp(consultas, m)[0]?.ops.find((o) => o[0] === m)?.[1][0] as Fila;

/** Columnas del select de la misma consulta del insert/update. */
const selectDe = (consultas: Consulta[], m: 'insert' | 'update'): string => {
  const cols = conOp(consultas, m)[0]?.ops.find(
    (o) => o[0] === 'select',
  )?.[1][0];
  return typeof cols === 'string' ? cols : '';
};

function alta(extra: Partial<CreateGastoDto> = {}): CreateGastoDto {
  return {
    categoria: CategoriaGasto.OPERACIONES,
    monto: 1925.27,
    moneda: Moneda.MXN,
    fecha_gasto: '2026-10-13',
    medio_pago: MedioPago.EFECTIVO,
    vuelo_id: VUELO,
    ...extra,
  };
}

async function rebote(p: Promise<unknown>) {
  try {
    await p;
    throw new Error('no rebotó');
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    return {
      status: e.getStatus(),
      body: e.getResponse() as {
        message?: string;
        error?: string;
        details?: Record<string, unknown>;
      },
    };
  }
}

describe('ExpensesService.create — tua_incluida (13-oct-2026)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('OFICINA en OPERACIONES con 100 ⇒ el insert la lleva y el select nombra la columna', async () => {
    const { service, consultas } = armar();
    await service.create(alta({ tua_incluida: 100 }), 'u-admin', Rol.ADMIN, {
      notificar: false,
    });
    expect(cuerpoDe(consultas, 'insert')).toMatchObject({ tua_incluida: 100 });
    expect(selectDe(consultas, 'insert')).toMatch(/, tua_incluida$/);
  });

  it('sin el campo ⇒ el payload NO nombra la llave (alta de siempre)', async () => {
    const { service, consultas } = armar();
    await service.create(alta(), 'u-admin', Rol.ADMIN, { notificar: false });
    expect(cuerpoDe(consultas, 'insert')).not.toHaveProperty('tua_incluida');
  });

  it('PILOTO con 100 ⇒ se IGNORA (sin 400): es campo de oficina', async () => {
    const { service, consultas } = armar();
    await service.create(alta({ tua_incluida: 100 }), 'u-piloto', Rol.PILOTO, {
      notificar: false,
    });
    expect(cuerpoDe(consultas, 'insert')).not.toHaveProperty('tua_incluida');
  });

  it('mayor que el ticket ⇒ 400 TUA_INCLUIDA_MAYOR_QUE_TICKET sin insertar', async () => {
    const { service, consultas } = armar();
    const r = await rebote(
      service.create(alta({ tua_incluida: 2000 }), 'u-admin', Rol.ADMIN),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('TUA_INCLUIDA_MAYOR_QUE_TICKET');
    expect(r.body.message).toBe(
      'La TUA incluida ($2,000 MXN) no puede ser mayor que el monto del ticket ($1,925.27 MXN, sin propina).',
    );
    expect(conOp(consultas, 'insert')).toHaveLength(0);
  });

  it('COMIDA con 10 ⇒ 400 TUA_INCLUIDA_NO_APLICA', async () => {
    const { service } = armar();
    const r = await rebote(
      service.create(
        alta({
          categoria: CategoriaGasto.COMIDA,
          monto: 250,
          tua_incluida: 10,
        }),
        'u-admin',
        Rol.ADMIN,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('TUA_INCLUIDA_NO_APLICA');
    expect(r.body.details).toEqual({ categoria: 'COMIDA' });
  });

  it('SIN la migración: un número ⇒ 409 NO_DISPONIBLE sin insertar; null ⇒ se omite', async () => {
    const a = armar({ sinMigracion: true });
    const r = await rebote(
      a.service.create(alta({ tua_incluida: 100 }), 'u-admin', Rol.ADMIN),
    );
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      message:
        'La TUA incluida todavía no se puede guardar: falta aplicar la migración 20261013000008. Mientras tanto la TUA se separa solo con la lectura de la IA.',
      error: 'TUA_INCLUIDA_NO_DISPONIBLE',
      details: { migracion: '20261013000008' },
    });
    expect(conOp(a.consultas, 'insert')).toHaveLength(0);

    const b = armar({ sinMigracion: true });
    await b.service.create(alta({ tua_incluida: null }), 'u-admin', Rol.ADMIN, {
      notificar: false,
    });
    expect(cuerpoDe(b.consultas, 'insert')).not.toHaveProperty('tua_incluida');
  });

  it('notas: un renglón que cuadra + tua_monto ⇒ bloque «Desglose:» con la TUA separada', async () => {
    const { service, consultas } = armar();
    await service.create(
      alta({
        valor_ia_extraido: {
          conceptos: [{ concepto: 'Operaciones', monto: 1925.27 }],
          tua_monto: 559.63,
        },
      }),
      'u-admin',
      Rol.ADMIN,
      { notificar: false },
    );
    expect(String(cuerpoDe(consultas, 'insert').notas)).toBe(
      'Desglose:\nOperación - $1365.64 MXN\nTUA (IVA incluido) - $559.63 MXN',
    );
  });

  it('notas: sin tua_monto y un solo renglón ⇒ sin bloque (como siempre)', async () => {
    const { service, consultas } = armar();
    await service.create(
      alta({
        notas: 'ASUR CUN',
        valor_ia_extraido: {
          conceptos: [{ concepto: 'Operaciones', monto: 1925.27 }],
        },
      }),
      'u-admin',
      Rol.ADMIN,
      { notificar: false },
    );
    expect(cuerpoDe(consultas, 'insert').notas).toBe('ASUR CUN');
  });
});

describe('ExpensesService.update — tua_incluida (13-oct-2026)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  const patch = (
    a: ReturnType<typeof armar>,
    dto: UpdateGastoDto,
    rol: Rol = Rol.ADMIN,
  ) => a.service.update(ID, dto, 'u-1', rol);

  it('null ⇒ el UPDATE la pone en null (volver a la lectura de la IA)', async () => {
    const a = armar({ actual: gastoActual({ tua_incluida: '700.00' }) });
    await patch(a, { tua_incluida: null });
    expect(cuerpoDe(a.consultas, 'update')).toMatchObject({
      tua_incluida: null,
    });
    expect(selectDe(a.consultas, 'update')).toMatch(/, tua_incluida$/);
  });

  it('solo la TUA: lee el gasto vigente y valida contra SU monto', async () => {
    const chico = armar({ actual: gastoActual({ monto: '40.00' }) });
    const r = await rebote(patch(chico, { tua_incluida: 50 }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('TUA_INCLUIDA_MAYOR_QUE_TICKET');
    expect(r.body.details).toMatchObject({ base: 40, vigente: false });
    expect(conOp(chico.consultas, 'update')).toHaveLength(0);

    const ok = armar({ actual: gastoActual() });
    await patch(ok, { tua_incluida: 559.63 });
    expect(cuerpoDe(ok.consultas, 'update')).toMatchObject({
      tua_incluida: 559.63,
    });
  });

  it('reclasificar OPERACIONES → COMIDA con una TUA vigente ⇒ se LIMPIA con warn', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const a = armar({ actual: gastoActual({ tua_incluida: '100.00' }) });
    await patch(a, { categoria: CategoriaGasto.COMIDA });
    expect(cuerpoDe(a.consultas, 'update')).toMatchObject({
      categoria: 'COMIDA',
      tua_incluida: null,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('la categoría ya no la admite'),
    );
    warn.mockRestore();
  });

  it('cambiar la moneda MXN → USD con una TUA vigente ⇒ se LIMPIA (USD y MXN nunca se mezclan)', async () => {
    const a = armar({ actual: gastoActual({ tua_incluida: '100.00' }) });
    await patch(a, { moneda: Moneda.USD });
    expect(cuerpoDe(a.consultas, 'update')).toMatchObject({
      moneda: 'USD',
      tua_incluida: null,
    });
  });

  it('PILOTO baja el monto bajo la TUA vigente ⇒ se LIMPIA sin 400', async () => {
    const a = armar({ actual: gastoActual({ tua_incluida: '600.00' }) });
    await patch(a, { monto: 500 }, Rol.PILOTO);
    expect(cuerpoDe(a.consultas, 'update')).toMatchObject({
      monto: 500,
      tua_incluida: null,
    });
  });

  it('OFICINA baja el monto sin tocarla ⇒ 400 con el texto «vigente»', async () => {
    const a = armar({ actual: gastoActual({ tua_incluida: '600.00' }) });
    const r = await rebote(patch(a, { monto: 500 }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('TUA_INCLUIDA_MAYOR_QUE_TICKET');
    expect(r.body.message).toBe(
      'Este gasto tiene una TUA incluida de $600 MXN fijada por la oficina y el nuevo monto del ticket ($500 MXN, sin propina) es menor: corrige o vacía «TUA incluida en este gasto» en el mismo guardado.',
    );
    expect(r.body.details).toMatchObject({ vigente: true });
    expect(conOp(a.consultas, 'update')).toHaveLength(0);
  });

  it('COMIDA + 50 ⇒ 400 TUA_INCLUIDA_NO_APLICA', async () => {
    const a = armar({ actual: gastoActual({ categoria: 'COMIDA' }) });
    const r = await rebote(patch(a, { tua_incluida: 50 }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('TUA_INCLUIDA_NO_APLICA');
  });

  it('PILOTO que manda la TUA ⇒ se ignora (solo cambia lo suyo)', async () => {
    const a = armar({ actual: gastoActual() });
    await patch(
      a,
      { notas: 'ASUR CUN · corregido', tua_incluida: 100 },
      Rol.PILOTO,
    );
    expect(cuerpoDe(a.consultas, 'update')).not.toHaveProperty('tua_incluida');
  });

  it('NO es dinero del banco: con cargos ligados no consulta cargos ni responde 409 GASTO_CONCILIADO', async () => {
    const a = armar({ actual: gastoActual(), cargos: 2 });
    // El diálogo «Verificar» manda SIEMPRE monto/moneda/medio (mismos valores).
    await patch(a, {
      monto: 1925.27,
      moneda: Moneda.MXN,
      medio_pago: MedioPago.TRANSFERENCIA,
      tua_incluida: 559.63,
    });
    expect(
      a.consultas.some((c) => c.tabla === 'movimiento_bancario_gasto'),
    ).toBe(false);
    expect(cuerpoDe(a.consultas, 'update')).toMatchObject({
      tua_incluida: 559.63,
    });
  });

  it('un PATCH solo de notas no decide nada (no lee el gasto vigente)', async () => {
    const a = armar({ actual: gastoActual({ tua_incluida: '600.00' }) });
    await patch(a, { notas: 'ASUR CUN · ok' });
    const cuerpo = cuerpoDe(a.consultas, 'update');
    expect(cuerpo).toMatchObject({ notas: 'ASUR CUN · ok' });
    expect(cuerpo).not.toHaveProperty('tua_incluida');
  });

  it('SIN la migración: un número ⇒ 409 NO_DISPONIBLE; null ⇒ se omite', async () => {
    const a = armar({ sinMigracion: true, actual: gastoActual() });
    const r = await rebote(patch(a, { tua_incluida: 100 }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('TUA_INCLUIDA_NO_DISPONIBLE');
    expect(conOp(a.consultas, 'update')).toHaveLength(0);

    const b = armar({ sinMigracion: true, actual: gastoActual() });
    await patch(b, { notas: 'x', tua_incluida: null });
    expect(cuerpoDe(b.consultas, 'update')).not.toHaveProperty('tua_incluida');
  });
});

describe('ExpensesService — sonda en false: NINGUNA consulta nombra tua_incluida', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('alta, edición, lista y detalle sin la columna (salvo la sonda misma)', async () => {
    const a = armar({
      sinMigracion: true,
      actual: gastoActual(),
      listado: [gastoActual()],
    });
    await a.service.create(alta(), 'u-admin', Rol.ADMIN, { notificar: false });
    await a.service.update(ID, { notas: 'x' }, 'u-1', Rol.ADMIN);
    await a.service.list({ limit: 50, offset: 0 });
    await a.service.findById(ID);
    for (const c of a.consultas) {
      for (const [m, args] of c.ops) {
        if (m === 'select' && args[0] === 'tua_incluida') continue;
        if (m === 'select') {
          expect(String(args[0])).not.toMatch(/tua_incluida/);
        }
        if (m === 'insert' || m === 'update') {
          expect(args[0]).not.toHaveProperty('tua_incluida');
        }
      }
    }
  });
});

describe('ExpensesService — lecturas: tua_detectada_ia y Excel (13-oct-2026)', () => {
  it('list() y findById() devuelven tua_detectada_ia (la de la IA, ignorando el override)', async () => {
    const leidaConSenal = gastoActual({
      id: 'g-383',
      medio_pago: 'EFECTIVO',
      valor_ia_extraido: { conceptos: CONCEPTOS_383, tua_monto: 559.63 },
    });
    const a = armar({
      actual: gastoActual({
        valor_ia_extraido: { conceptos: CONCEPTOS_ASUR_TUA },
        monto: '1673.67',
        tua_incluida: '0.00',
      }),
      listado: [
        leidaConSenal,
        gastoActual({ id: 'g-sin', medio_pago: 'EFECTIVO' }),
      ],
    });
    const res = await a.service.list({ limit: 50, offset: 0 });
    expect(res.data.map((r) => r.tua_detectada_ia)).toEqual([559.63, null]);
    const g = await a.service.findById(ID);
    expect(g.tua_detectada_ia).toBe(1119.26);
  });

  it('Excel: «TUA incluida» (money) y «Origen TUA» justo después de «Monto»; «Capturado» se corre 2', async () => {
    const a = armar({
      listado: [
        gastoActual({
          id: 'g-ia',
          medio_pago: 'EFECTIVO',
          valor_ia_extraido: {
            conceptos: [
              { concepto: 'Operaciones', monto: 1365.64 },
              { concepto: 'Tarifa TUA', monto: 559.63 },
            ],
          },
        }),
        gastoActual({
          id: 'g-ofi',
          medio_pago: 'EFECTIVO',
          tua_incluida: '700.00',
        }),
        gastoActual({
          id: 'g-nada',
          medio_pago: 'EFECTIVO',
          valor_ia_extraido: null,
        }),
      ],
    });
    await a.service.listXlsx({ limit: 50, offset: 0 });
    const payload = (
      a.pyservices.generateTablaXlsx.mock.calls[0] as unknown[]
    )[0] as {
      columnas: Array<{ label: string; tipo?: string }>;
      filas: unknown[][];
    };
    const labels = payload.columnas.map((c) => c.label);
    const iMonto = labels.indexOf('Monto');
    expect(labels.slice(iMonto, iMonto + 4)).toEqual([
      'Monto',
      'TUA incluida',
      'Origen TUA',
      'Capturado',
    ]);
    expect(payload.columnas[iMonto + 1]).toEqual({
      label: 'TUA incluida',
      tipo: 'money',
    });
    expect(payload.filas.map((f) => f.slice(iMonto + 1, iMonto + 3))).toEqual([
      [559.63, 'IA'],
      [700, 'Oficina'],
      [null, ''],
    ]);
    expect(payload.filas.every((f) => f.length === labels.length)).toBe(true);
  });
});
