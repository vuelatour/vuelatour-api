// Mismos stubs que expenses.service.afac.spec: notifications arrastra el
// gateway y `jose` (ESM puro), vision el SDK de IA y pyservices el cliente
// HTTP.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { HttpException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CategoriaGasto, MedioPago, Moneda } from './dto/expenses.dto';
import type { CreateGastoDto, UpdateGastoDto } from './dto/expenses.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';

/**
 * «ES EL PAGO AL OPERADOR EXTERNO» en Gastos (27-oct-2026, API 0.0.110,
 * invariante 110): marca de OFICINA, solo en un gasto CON vuelo cubierto por
 * externo y de una categoría que resta en las columnas del vuelo. Harness
 * COPIADO de `expenses.service.afac.spec` (builder que registra cada
 * consulta); las sondas de columnas opcionales responden «existe». El vuelo
 * #453 (externo, Simon Herrera) y el #450 (propio) viven en el resolver.
 * Caso real: el gasto de Ale «pago a simon del vuelo a holbox del 25 oct»
 * $18,182.00 MXN del 27-oct-2026.
 */
type Fila = Record<string, unknown>;
type Op = [string, unknown[]];
interface Consulta {
  tabla: string;
  ops: Op[];
}

const VUELO = 'ab9f4f85-331c-4235-b627-b775688ae2c5';
const PROPIO = '22222222-2222-4222-8222-222222222222';
const ID = '807fa413-2d57-4b29-bc41-8cb73cab0c1f';
const HOY = new Date('2026-10-27T18:00:00Z'); // martes, 13:00 Cancún

/** Gasto vigente (lo que lee `findById`): el de Ale, sin la marca. */
function gastoActual(extra: Fila = {}): Fila {
  return {
    id: ID,
    vuelo_id: VUELO,
    aeronave_id: null,
    escala_id: null,
    usuario_captura_id: 'u-ale',
    categoria: 'OPERACIONES',
    monto: '18182.00',
    propina: '0.00',
    moneda: 'MXN',
    medio_pago: 'TRANSFERENCIA',
    tarjeta_terminacion: null,
    fecha_gasto: '2026-10-27',
    notas: 'pago a simon del vuelo a holbox del 25 oct',
    valor_ia_extraido: null,
    tua_incluida: null,
    es_pago_afac: false,
    es_pago_operador_externo: false,
    created_at: '2026-10-27T17:19:53Z',
    updated_at: '2026-10-27T17:19:53Z',
    ...extra,
  };
}

function armar(opts: { actual?: Fila; cargos?: number } = {}) {
  const consultas: Consulta[] = [];
  const resolver = (c: Consulta, single: boolean) => {
    const op = (m: string) => c.ops.find((o) => o[0] === m);
    const sel = op('select');
    if (c.tabla === 'gasto') {
      // Sondas de columnas opcionales: todas «existen».
      if (
        sel &&
        ['es_pago_afac', 'tua_incluida', 'por_pagar'].includes(
          String(sel[1][0]),
        )
      ) {
        return { data: [], error: null };
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
      return { data: [], error: null };
    }
    if (c.tabla === 'vuelo' && single) {
      const eqId = c.ops.find((o) => o[0] === 'eq' && o[1][0] === 'id');
      if (eqId?.[1][1] === PROPIO) {
        return {
          data: {
            id: PROPIO,
            folio: 450,
            aeronave_id: 'av-1',
            piloto_id: null,
            es_externo: false,
            operador_externo: null,
          },
          error: null,
        };
      }
      return {
        data: {
          id: VUELO,
          folio: 453,
          aeronave_id: null,
          piloto_id: null,
          es_externo: true,
          operador_externo: 'Simon Herrera',
        },
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
  return { service, consultas };
}

/** Las consultas a una tabla con una operación dada. */
const conOp = (consultas: Consulta[], m: string, tabla = 'gasto') =>
  consultas.filter((c) => c.tabla === tabla && c.ops.some((o) => o[0] === m));

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
    monto: 18182,
    moneda: Moneda.MXN,
    fecha_gasto: '2026-10-27',
    medio_pago: MedioPago.TRANSFERENCIA,
    vuelo_id: VUELO,
    notas: 'pago a simon del vuelo a holbox del 25 oct',
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
      body: e.getResponse() as { message?: string; error?: string },
    };
  }
}

describe('ExpensesService.create — es_pago_operador_externo (invariante 110)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('OFICINA en un vuelo EXTERNO con true ⇒ el insert la lleva y el select la devuelve', async () => {
    for (const rol of [Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR]) {
      const { service, consultas } = armar();
      await service.create(
        alta({ es_pago_operador_externo: true }),
        'u-ale',
        rol,
        { notificar: false },
      );
      expect(cuerpoDe(consultas, 'insert')).toMatchObject({
        es_pago_operador_externo: true,
        vuelo_id: VUELO,
      });
      expect(selectDe(consultas, 'insert')).toMatch(/es_pago_operador_externo/);
    }
  });

  it('false (o ausente) ⇒ el payload NO nombra la llave (default de la columna)', async () => {
    const { service, consultas } = armar();
    await service.create(
      alta({ es_pago_operador_externo: false }),
      'u-ale',
      Rol.ADMIN,
      { notificar: false },
    );
    expect(cuerpoDe(consultas, 'insert')).not.toHaveProperty(
      'es_pago_operador_externo',
    );
    const sin = armar();
    await sin.service.create(alta(), 'u-ale', Rol.ADMIN, { notificar: false });
    expect(cuerpoDe(sin.consultas, 'insert')).not.toHaveProperty(
      'es_pago_operador_externo',
    );
  });

  it('true en un vuelo PROPIO ⇒ 400 VUELO_NO_EXTERNO (cita el folio); sin vuelo ⇒ 400 SIN_VUELO; categoría fuera de las columnas ⇒ 400 CATEGORIA; rol de campo ⇒ 403; nada se inserta', async () => {
    const propio = armar();
    const r1 = await rebote(
      propio.service.create(
        alta({ vuelo_id: PROPIO, es_pago_operador_externo: true }),
        'u-ale',
        Rol.ADMIN,
      ),
    );
    expect([r1.status, r1.body.error]).toEqual([
      400,
      'PAGO_OPERADOR_VUELO_NO_EXTERNO',
    ]);
    expect(r1.body.message).toContain('El vuelo #450');
    expect(conOp(propio.consultas, 'insert')).toHaveLength(0);

    const sinVuelo = armar();
    const r2 = await rebote(
      sinVuelo.service.create(
        alta({ vuelo_id: undefined, es_pago_operador_externo: true }),
        'u-ale',
        Rol.ADMIN,
      ),
    );
    expect([r2.status, r2.body.error]).toEqual([
      400,
      'PAGO_OPERADOR_SIN_VUELO',
    ]);

    const otro = armar();
    const r3 = await rebote(
      otro.service.create(
        alta({
          categoria: CategoriaGasto.OTRO,
          es_pago_operador_externo: true,
        }),
        'u-ale',
        Rol.ADMIN,
      ),
    );
    expect([r3.status, r3.body.error]).toEqual([
      400,
      'PAGO_OPERADOR_CATEGORIA',
    ]);

    const piloto = armar();
    const r4 = await rebote(
      piloto.service.create(
        alta({ es_pago_operador_externo: true }),
        'u-piloto',
        Rol.PILOTO,
      ),
    );
    expect([r4.status, r4.body.error]).toEqual([
      403,
      'PAGO_OPERADOR_SOLO_OFICINA',
    ]);
    expect(conOp(piloto.consultas, 'insert')).toHaveLength(0);
  });
});

describe('ExpensesService.update — es_pago_operador_externo (invariante 110)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  const patch = (
    a: ReturnType<typeof armar>,
    dto: UpdateGastoDto,
    rol: Rol = Rol.ADMIN,
  ) => a.service.update(ID, dto, 'u-1', rol);

  it('#453: OFICINA marca el gasto de Ale ⇒ UPDATE con la llave (también CONCILIADO y facturado: no toca dinero del banco)', async () => {
    const a = armar({
      actual: gastoActual({
        conciliado: true,
        estatus_facturacion: 'FACTURADA',
      }),
      cargos: 1,
    });
    await patch(a, { es_pago_operador_externo: true });
    expect(cuerpoDe(a.consultas, 'update')).toMatchObject({
      es_pago_operador_externo: true,
    });
    // Verificó que el vuelo vigente es externo.
    expect(conOp(a.consultas, 'select', 'vuelo').length).toBeGreaterThan(0);
  });

  it('desmarcar (true ⇒ false) solo pide rol de oficina', async () => {
    const a = armar({
      actual: gastoActual({ es_pago_operador_externo: true }),
    });
    await patch(a, { es_pago_operador_externo: false }, Rol.FACTURACION);
    expect(cuerpoDe(a.consultas, 'update')).toMatchObject({
      es_pago_operador_externo: false,
    });
    const p = armar({
      actual: gastoActual({ es_pago_operador_externo: true }),
    });
    const r = await rebote(
      patch(p, { es_pago_operador_externo: false }, Rol.PILOTO),
    );
    expect([r.status, r.body.error]).toEqual([
      403,
      'PAGO_OPERADOR_SOLO_OFICINA',
    ]);
  });

  it('ECO igual al vigente (el diálogo «Verificar» reenvía la fila) ⇒ se ignora: no escribe la llave; solo la marca ⇒ no escribe nada', async () => {
    const a = armar({
      actual: gastoActual({ es_pago_operador_externo: true }),
    });
    await patch(a, { es_pago_operador_externo: true });
    expect(conOp(a.consultas, 'update')).toHaveLength(0);
    // Un rol de campo con el eco igual NO rebota (403 solo si la CAMBIA).
    const p = armar({ actual: gastoActual() });
    await patch(
      p,
      { es_pago_operador_externo: false, notas: 'del piloto' },
      Rol.PILOTO,
    );
    expect(cuerpoDe(p.consultas, 'update')).not.toHaveProperty(
      'es_pago_operador_externo',
    );
    expect(cuerpoDe(p.consultas, 'update')).toMatchObject({
      notas: 'del piloto',
    });
    // Las DOS marcas con eco igual ⇒ tampoco escribe nada.
    const dos = armar({
      actual: gastoActual({ es_pago_operador_externo: true }),
    });
    await patch(dos, { es_pago_afac: false, es_pago_operador_externo: true });
    expect(conOp(dos.consultas, 'update')).toHaveLength(0);
  });

  it('`null` = no tocar (jamás un null sobre la columna NOT NULL)', async () => {
    const a = armar({
      actual: gastoActual({ es_pago_operador_externo: true }),
    });
    await patch(a, {
      es_pago_operador_externo: null as unknown as boolean,
      notas: 'nota nueva',
    });
    expect(cuerpoDe(a.consultas, 'update')).not.toHaveProperty(
      'es_pago_operador_externo',
    );
    expect(cuerpoDe(a.consultas, 'update')).toMatchObject({
      notas: 'nota nueva',
    });
  });

  it('marcar y mover al vuelo PROPIO en el MISMO PATCH ⇒ 400 VUELO_NO_EXTERNO; marcar un gasto cuyo vuelo vigente es propio ⇒ 400; reclasificar a OTRO y marcar ⇒ 400 CATEGORIA; quitar el vuelo y marcar ⇒ 400 SIN_VUELO', async () => {
    const mover = armar({ actual: gastoActual() });
    const r1 = await rebote(
      patch(mover, { vuelo_id: PROPIO, es_pago_operador_externo: true }),
    );
    expect([r1.status, r1.body.error]).toEqual([
      400,
      'PAGO_OPERADOR_VUELO_NO_EXTERNO',
    ]);
    expect(conOp(mover.consultas, 'update')).toHaveLength(0);

    const propio = armar({ actual: gastoActual({ vuelo_id: PROPIO }) });
    const r2 = await rebote(patch(propio, { es_pago_operador_externo: true }));
    expect(r2.body.error).toBe('PAGO_OPERADOR_VUELO_NO_EXTERNO');

    const otro = armar({ actual: gastoActual() });
    const r3 = await rebote(
      patch(otro, {
        categoria: CategoriaGasto.OTRO,
        es_pago_operador_externo: true,
      }),
    );
    expect([r3.status, r3.body.error]).toEqual([
      400,
      'PAGO_OPERADOR_CATEGORIA',
    ]);

    const sinVuelo = armar({ actual: gastoActual() });
    const r4 = await rebote(
      patch(sinVuelo, {
        vuelo_id: null as unknown as string,
        es_pago_operador_externo: true,
      }),
    );
    expect([r4.status, r4.body.error]).toEqual([
      400,
      'PAGO_OPERADOR_SIN_VUELO',
    ]);
  });
});
